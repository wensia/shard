//! Server-only Chat Completions adapter. Credentials never enter vault metadata or clients.

use std::time::Duration;

use reqwest::{header::HeaderValue, Client};
use serde_json::{json, Value};
use shard_core::auto_tagging::{
    build_input, parse_response, TagSuggestion, TaggingItem, SYSTEM_PROMPT,
};
use url::{Host, Url};

pub const PROMPT_VERSION: &str = "1";
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct ModelClient {
    client: Client,
    endpoint: Url,
    model: String,
    authorization: HeaderValue,
}

/// Deliberately contains no provider response, document text, URL, or credential.
#[derive(Debug)]
pub struct ModelError {
    pub retryable: bool,
    pub configuration: bool,
    pub message: String,
}

impl ModelError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            retryable: false,
            configuration: false,
            message: message.into(),
        }
    }

    fn network(error: reqwest::Error) -> Self {
        Self {
            retryable: true,
            configuration: false,
            message: if error.is_timeout() {
                "自动标签模型请求超时"
            } else {
                "自动标签模型连接失败"
            }
            .into(),
        }
    }
}

impl ModelClient {
    /// Enabled only by explicit server configuration; no implicit use of other API keys.
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_settings(|name| std::env::var(name).ok())
    }

    fn from_settings(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        match get("SHARD_AUTO_TAG_ENABLED").as_deref().unwrap_or("false") {
            "false" | "0" | "" => return Ok(None),
            "true" | "1" => {}
            _ => return Err("SHARD_AUTO_TAG_ENABLED 应为 true 或 false".into()),
        }
        let required = |name: &str| {
            get(name)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("启用自动标签需设置 {name}"))
        };
        let base = get("SHARD_AUTO_TAG_API_BASE")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://api.openai.com/v1".into());
        Self::new(
            &base,
            &required("SHARD_AUTO_TAG_MODEL")?,
            &required("SHARD_AUTO_TAG_API_KEY")?,
        )
        .map(Some)
    }

    pub fn new(api_base: &str, model: &str, api_key: &str) -> Result<Self, String> {
        let mut endpoint = Url::parse(api_base).map_err(|_| "自动标签 API 地址无效")?;
        let local = match endpoint.host() {
            Some(Host::Domain(name)) => name == "localhost",
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        if !(endpoint.scheme() == "https" || endpoint.scheme() == "http" && local)
            || endpoint.host().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(
                "自动标签 API 地址须为 HTTPS，且不能包含凭据、查询参数或片段；本机测试可用 HTTP"
                    .into(),
            );
        }
        if model.trim().is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
            return Err("自动标签模型名称无效".into());
        }
        if api_key.trim().is_empty() {
            return Err("自动标签 API 密钥不能为空".into());
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
            .map_err(|_| "自动标签 API 密钥格式无效")?;
        authorization.set_sensitive(true);
        endpoint.set_path(&format!(
            "{}/chat/completions",
            endpoint.path().trim_end_matches('/')
        ));
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化自动标签模型连接")?;
        Ok(Self {
            client,
            endpoint,
            model: model.trim().into(),
            authorization,
        })
    }

    pub async fn classify(
        &self,
        items: &[TaggingItem],
        existing_tags: &[String],
    ) -> Result<Vec<TagSuggestion>, ModelError> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let input = build_input(items, existing_tags).map_err(ModelError::invalid)?;
        let request = json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": input}
            ],
            "response_format": {"type": "json_object"},
            "max_completion_tokens": 2048,
            "store": false
        });
        let body = serde_json::to_vec(&request)
            .map_err(|_| ModelError::invalid("自动标签请求无法编码"))?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(ModelError::invalid("自动标签内容超过处理上限"));
        }
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(ModelError::network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ModelError {
                retryable: status.is_server_error() || matches!(status.as_u16(), 408 | 429),
                configuration: status.is_redirection()
                    || matches!(status.as_u16(), 400 | 401 | 403 | 404 | 422),
                message: format!("自动标签模型返回 HTTP {}", status.as_u16()),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ModelError::invalid("自动标签响应超过处理上限"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(ModelError::network)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(ModelError::invalid("自动标签响应超过处理上限"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let output: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ModelError::invalid("自动标签模型响应不是 JSON"))?;
        let choices = output["choices"]
            .as_array()
            .filter(|choices| choices.len() == 1)
            .ok_or_else(|| ModelError::invalid("自动标签模型未返回唯一结果"))?;
        let choice = &choices[0];
        if choice["finish_reason"].as_str() != Some("stop")
            || !choice["message"]["refusal"].is_null()
        {
            return Err(ModelError::invalid("自动标签模型未完成分类"));
        }
        let content = choice["message"]["content"]
            .as_str()
            .ok_or_else(|| ModelError::invalid("自动标签模型未返回分类文本"))?;
        // serde errors can quote unknown model-supplied field names; do not pass them to logs.
        parse_response(content, items, existing_tags)
            .map_err(|_| ModelError::invalid("自动标签模型返回的分类格式无效"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
    use std::sync::{Arc, Mutex};

    fn item() -> TaggingItem {
        TaggingItem {
            id: "one".into(),
            title: "记录".into(),
            body: "试装骑行车包。".into(),
            tags: vec!["inbox".into()],
        }
    }

    async fn mock(
        status: StatusCode,
        response: Value,
    ) -> (
        ModelClient,
        Arc<Mutex<Option<Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let captured = Arc::new(Mutex::new(None));
        let output = Arc::new(response);
        let app = Router::new()
            .route(
                "/v1/chat/completions",
                post({
                    let output = output.clone();
                    move |State(captured): State<Arc<Mutex<Option<Value>>>>,
                          Json(body): Json<Value>| {
                        let output = output.clone();
                        async move {
                            *captured.lock().unwrap() = Some(body);
                            (status, Json((*output).clone()))
                        }
                    }
                }),
            )
            .with_state(captured.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            ModelClient::new(&format!("http://{address}/v1"), "test-model", "test-key").unwrap(),
            captured,
            task,
        )
    }

    fn completion(content: &str) -> Value {
        json!({"choices": [{"finish_reason":"stop", "message":{"content":content}}]})
    }

    #[test]
    fn disabled_configuration_ignores_keys_and_enabled_requires_explicit_model() {
        assert!(ModelClient::from_settings(|_| None).unwrap().is_none());
        let missing = ModelClient::from_settings(|key| {
            (key == "SHARD_AUTO_TAG_ENABLED").then(|| "true".into())
        });
        assert!(missing.err().unwrap().contains("SHARD_AUTO_TAG_MODEL"));
    }

    #[test]
    fn configuration_rejects_unsafe_urls_and_never_echoes_credentials() {
        for endpoint in [
            "http://example.com/v1",
            "https://user:private-key@example.com/v1",
            "https://example.com/v1?key=private-key",
            "file:///tmp/private-key",
        ] {
            let error = ModelClient::new(endpoint, "model", "valid-key")
                .err()
                .unwrap();
            assert!(!error.contains("private-key"));
        }
        assert!(ModelClient::new("http://127.0.0.1:8788/v1/", "model", "key").is_ok());
        assert!(ModelClient::new("https://example.com/v1", "model", "key\r\nsecret").is_err());
    }

    #[tokio::test]
    async fn sends_separate_data_and_reuses_multiple_existing_tags() {
        let (client, captured, task) = mock(
            StatusCode::OK,
            completion(r#"{"items":[{"id":"one","tags":["骑行","装备"]}]}"#),
        )
        .await;
        let result = client
            .classify(&[item()], &["骑行".into(), "装备".into()])
            .await
            .unwrap();
        assert_eq!(result[0].tags, ["骑行", "装备"]);
        let request = captured.lock().unwrap().clone().unwrap();
        assert_eq!(request["messages"][0]["role"], "system");
        let data: Value =
            serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(data["items"][0]["body"], item().body);
        assert_eq!(request["store"], false);
        assert!(request.get("tools").is_none());
        task.abort();
    }

    #[tokio::test]
    async fn provider_errors_are_sanitized_and_classified_for_retry() {
        for (status, retryable, configuration) in [
            (StatusCode::UNAUTHORIZED, false, true),
            (StatusCode::TOO_MANY_REQUESTS, true, false),
            (StatusCode::SERVICE_UNAVAILABLE, true, false),
        ] {
            let (client, _, task) =
                mock(status, json!({"error":"secret-key and private document"})).await;
            let error = client.classify(&[item()], &[]).await.unwrap_err();
            assert_eq!(error.retryable, retryable);
            assert_eq!(error.configuration, configuration);
            assert!(!error.message.contains("secret"));
            assert!(!error.message.contains("document"));
            task.abort();
        }
    }

    #[tokio::test]
    async fn rejects_truncated_oversize_and_injected_output() {
        for response in [
            json!({"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}),
            completion(r#"{"items":[{"id":"other","tags":["骑行"]}]}"#),
            completion(r#"{"secret-document-as-field":"private text","items":[]}"#),
            completion(&" ".repeat(MAX_RESPONSE_BYTES + 1)),
        ] {
            let (client, _, task) = mock(StatusCode::OK, response).await;
            let error = client.classify(&[item()], &[]).await.unwrap_err();
            assert!(!error.retryable);
            assert!(!error.message.contains("secret-document"));
            task.abort();
        }
    }
}
