//! Server-only Chat Completions adapter. Credentials never enter vault metadata or clients.

use std::time::Duration;

use reqwest::{header::HeaderValue, Client};
use serde_json::{json, Value};
use shard_core::auto_tagging::{
    build_input, parse_response, TagSuggestion, TaggingItem, SYSTEM_PROMPT,
};
use std::net::IpAddr;

use url::{Host, Url};

pub const PROMPT_VERSION: &str = "1";
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct ModelClient {
    client: Client,
    endpoint: Url,
    /// 设置页回显用：规范化后的基础地址（不含 `/chat/completions`）。
    api_base: String,
    model: String,
    authorization: HeaderValue,
}

/// Deliberately contains no provider response, document text, URL, or credential.
#[derive(Debug)]
pub struct ModelError {
    pub retryable: bool,
    pub configuration: bool,
    /// 服务商返回的 HTTP 状态码（网络错误、格式错误时没有）。
    pub status: Option<u16>,
    pub message: String,
}

impl ModelError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            retryable: false,
            configuration: false,
            status: None,
            message: message.into(),
        }
    }

    /// 400/422 可能只是这一篇的问题（超出上下文、触发内容过滤），也可能是配置不被接受；调用方要再探一次才能区分。
    pub fn maybe_item_specific(&self) -> bool {
        self.configuration && matches!(self.status, Some(400 | 422))
    }

    fn http(status: u16, redirect: bool) -> Self {
        let message = match status {
            401 => "API Key 无效或已过期（HTTP 401）".to_string(),
            403 => "没有权限使用该模型（HTTP 403）".to_string(),
            404 => "接口地址或模型名称不存在（HTTP 404）".to_string(),
            408 => "模型服务响应超时（HTTP 408）".to_string(),
            429 => "请求过于频繁或额度不足（HTTP 429）".to_string(),
            400 | 422 => format!("模型服务拒绝了请求（HTTP {status}），请确认模型支持 JSON 输出"),
            _ if redirect => format!("接口地址发生了跳转（HTTP {status}），请填写最终地址"),
            _ => format!("模型服务返回 HTTP {status}"),
        };
        Self {
            retryable: status >= 500 || matches!(status, 408 | 429),
            configuration: redirect || matches!(status, 400 | 401 | 403 | 404 | 422),
            status: Some(status),
            message,
        }
    }

    fn network(error: reqwest::Error) -> Self {
        Self {
            retryable: true,
            configuration: false,
            status: None,
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

    /// App 设置里保存的配置：只接受公网 HTTPS 域名。本机或内网地址只能由运维经环境变量配置，
    /// 免得一个登录会话就能让服务器向内网服务发请求（SSRF）。
    pub fn new_public(api_base: &str, model: &str, api_key: &str) -> Result<Self, String> {
        let url = Url::parse(api_base.trim()).map_err(|_| "自动标签 API 地址无效")?;
        let private = match url.host() {
            Some(Host::Domain(name)) => {
                let name = name.trim_end_matches('.').to_ascii_lowercase();
                name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") || name.ends_with(".internal")
            }
            Some(Host::Ipv4(ip)) => !is_public_ip(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => !is_public_ip(IpAddr::V6(ip)),
            None => true,
        };
        if url.scheme() != "https" || private {
            return Err("自动标签 API 地址须为公网 HTTPS 地址；本机或内网服务请由服务器环境变量配置".into());
        }
        Self::new(api_base, model, api_key)
    }

    pub fn api_base(&self) -> &str {
        &self.api_base
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// 设置页「测试连接」：用一条固定的示例文字走一遍完整的分类契约（JSON 模式、结果校验），
    /// 返回模型给出的标签。不读资料库，不写任何东西。
    pub async fn test(&self) -> Result<Vec<String>, ModelError> {
        let item = TaggingItem {
            id: "connection-test".into(),
            title: "连接测试".into(),
            body: "周末骑车去湖边，拍了几张日落，回来整理了这次骑行的路线和装备清单。".into(),
            tags: vec!["inbox".into()],
        };
        let mut suggestions = self.classify(&[item], &[]).await?;
        Ok(suggestions.pop().map(|suggestion| suggestion.tags).unwrap_or_default())
    }

    pub fn new(api_base: &str, model: &str, api_key: &str) -> Result<Self, String> {
        let api_base = api_base.trim();
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
        let display_base = endpoint.as_str().trim_end_matches('/').to_string();
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
            api_base: display_base,
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
            return Err(ModelError::http(status.as_u16(), status.is_redirection()));
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

/// 公网可路由的地址。私有、回环、链路本地、CGNAT、文档/保留段一律不算。
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
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

    #[test]
    fn app_settings_accept_only_public_https() {
        for endpoint in [
            "http://api.example.com/v1",
            "https://localhost/v1",
            "https://shard.localhost/v1",
            "https://127.0.0.1/v1",
            "https://10.0.0.8/v1",
            "https://192.168.1.2/v1",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/v1",
            "https://[::1]/v1",
            "https://[fd00::1]/v1",
            "https://[::ffff:127.0.0.1]/v1",
        ] {
            assert!(ModelClient::new_public(endpoint, "model", "key").is_err(), "{endpoint}");
        }
        let client = ModelClient::new_public(" https://api.xiaomimimo.com/v1/ ", " mimo ", "key").unwrap();
        assert_eq!(client.api_base(), "https://api.xiaomimimo.com/v1");
        assert_eq!(client.model(), "mimo");
        assert!(ModelClient::new_public("https://8.8.8.8/v1", "model", "key").is_ok());
    }

    #[tokio::test]
    async fn connection_test_runs_the_full_contract_and_returns_tags() {
        let (client, captured, task) = mock(
            StatusCode::OK,
            completion(r#"{"items":[{"id":"connection-test","tags":["骑行","摄影"]}]}"#),
        )
        .await;
        assert_eq!(client.test().await.unwrap(), ["骑行", "摄影"]);
        let request = captured.lock().unwrap().clone().unwrap();
        assert_eq!(request["model"], "test-model");
        task.abort();
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
