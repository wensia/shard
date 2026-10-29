//! RPC 客户端：`POST <服务器>/api/rpc/{命令}`，`Authorization: Bearer shd_dev_…`。
//!
//! - 写请求每次带新的 `Idempotency-Key`（也可以由调用方指定，例如离线队列的 op_id）；网络失败或网关临时不可用
//!   （502/503/504）时用同一个键重试，服务器保证同一个键只提交一次。读请求同样重试，但不带键。
//! - 都带 `X-Shard-UTC-Offset`（本机时区，分钟）：碎片 id、月份目录与时间按本机时区算。
//! - User-Agent 与自动生成的幂等键前缀由调用方给（命令行是 `shard-cli/<版本>` 与 `cli`）。

use crate::server::{normalize_server, ServerAddressError};
use rand::RngCore;
use serde_json::Value;
use std::{fmt, sync::Arc, thread, time::Duration};

/// 响应体上限：`list_documents` 带正文时是整个资料库的文本。
pub(crate) const MAX_RESPONSE_BYTES: u64 = 512 * 1024 * 1024;

/// 默认的重试基准间隔：第一次重试等 400 毫秒，第二次等 1.2 秒，之后放弃。
const DEFAULT_RETRY_BASE: Duration = Duration::from_millis(400);

/// 客户端的调用方参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientOptions {
    /// 请求头 `User-Agent`，例如 `shard-cli/0.1.3`。
    pub user_agent: String,
    /// 自动生成的幂等键前缀，键形如 `<前缀>-<32 位十六进制>`。
    pub key_prefix: String,
    /// 网络失败与 502/503/504 时依次等待的间隔；用完就把最后一次的错误返回给调用方。
    pub retry_delays: Vec<Duration>,
}

impl ClientOptions {
    pub fn new(user_agent: impl Into<String>, key_prefix: impl Into<String>) -> Self {
        Self {
            user_agent: user_agent.into(),
            key_prefix: key_prefix.into(),
            retry_delays: retry_delays(DEFAULT_RETRY_BASE),
        }
    }

    /// 改重试的基准间隔：依次等 `base`、`base × 3`（测试用来缩短等待）。
    pub fn retry_base(mut self, base: Duration) -> Self {
        self.retry_delays = retry_delays(base);
        self
    }
}

fn retry_delays(base: Duration) -> Vec<Duration> {
    vec![base, base * 3]
}

/// 一次远程调用失败。
///
/// `status` 为 `None` 表示没拿到 HTTP 响应（网络不可达、超时、TLS 失败），此时 `code` 是 `NETWORK`。
/// 拿到了错误响应时 `code` 是服务器给的错误码（没有就是 `HTTP_<状态码>`），`message` 是服务器给的说明，
/// `detail` 是结构化错误体（响应里的 `error` 字段，例如搜索契约的 SearchError；装箱是为了让 `Result` 小一些）。
/// 200 但响应体无法解析时 `code` 是 `BAD_RESPONSE`。
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteError {
    /// 服务器地址（[`decode`] 产生的错误里为空）。
    pub server: String,
    /// RPC 命令名（[`decode`] 产生的错误里为空；SSE 为 `events`）。
    pub command: String,
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub detail: Option<Box<Value>>,
}

impl RemoteError {
    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    /// 没拿到 HTTP 响应。
    pub fn is_network(&self) -> bool {
        self.status.is_none()
    }

    /// 401：令牌无效或已吊销，需要重新登录。
    pub fn is_unauthenticated(&self) -> bool {
        self.status == Some(401)
    }

    /// 网络失败或网关临时不可用：写请求可以用同一个幂等键再试。
    pub fn is_retryable(&self) -> bool {
        matches!(self.status, None | Some(502..=504))
    }
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RemoteError {}

/// 服务器响应 → 有类型的结构体；缺字段或类型不对时报 `BAD_RESPONSE`，不当成功处理。
/// `what` 是给人看的对象名（「文档」「搜索结果」……）。
pub fn decode<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T, RemoteError> {
    serde_json::from_value(value).map_err(|error| RemoteError {
        server: String::new(),
        command: String::new(),
        status: Some(200),
        code: "BAD_RESPONSE".to_string(),
        message: format!("服务器返回的{what}不完整或无法解析：{error}"),
        detail: None,
    })
}

/// 本机时区相对 UTC 的分钟数（`X-Shard-UTC-Offset`）。
pub fn utc_offset_minutes() -> i32 {
    chrono::Local::now().offset().local_minus_utc() / 60
}

/// 新的幂等键：`<前缀>-<16 字节随机数的十六进制>`。
pub fn idempotency_key(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}-{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// 不把 HTTP 错误状态当成 `Err`（要读错误体），连接 10 秒、整个请求 300 秒超时。
pub(crate) fn agent(user_agent: &str) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent(user_agent)
        .build()
        .into()
}

/// ureq 的传输错误 → 给人看的一句话。
pub(crate) fn describe_transport(error: &ureq::Error) -> String {
    match error {
        ureq::Error::HostNotFound => "找不到这个主机".to_string(),
        ureq::Error::ConnectionFailed => "无法建立连接".to_string(),
        ureq::Error::Timeout(_) => "连接超时".to_string(),
        ureq::Error::Io(error) => format!("网络错误：{error}"),
        ureq::Error::Tls(message) => format!("TLS 握手失败：{message}"),
        ureq::Error::Rustls(error) => format!("TLS 握手失败：{error}"),
        ureq::Error::BodyExceedsLimit(limit) => format!("响应超过 {limit} 字节上限"),
        other => other.to_string(),
    }
}

/// 发一个 JSON POST，返回 (状态码, 响应体文本)。没拿到响应时返回传输错误的说明。
pub(crate) fn post_json(
    agent: &ureq::Agent,
    url: &str,
    headers: &[(&str, String)],
    body: &Value,
) -> Result<(u16, String), String> {
    let mut request = agent.post(url).header("Content-Type", "application/json");
    for (name, value) in headers {
        request = request.header(*name, value.as_str());
    }
    let mut response = request.send(body.to_string()).map_err(|error| describe_transport(&error))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(|error| describe_transport(&error))?;
    Ok((status, text))
}

/// 错误响应体 → (错误码, 说明, 结构化错误)。
pub(crate) fn error_body(status: u16, text: &str) -> (String, String, Option<Box<Value>>) {
    let body = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let code = body["code"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP_{status}"));
    // 搜索契约的结构化错误没有 message 时退回 code 与 reason。
    let message = body["message"]
        .as_str()
        .map(str::to_string)
        .or_else(|| body["reason"].as_str().map(|reason| format!("{code}：{reason}")))
        .unwrap_or_else(|| format!("服务器返回 HTTP {status}"));
    let detail = body.get("error").filter(|detail| !detail.is_null()).cloned().map(Box::new);
    (code, message, detail)
}

/// 连到一台服务器的 RPC 客户端。克隆很便宜（共享同一份配置与连接池），可以在线程间传递。
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    server: String,
    token: String,
    agent: ureq::Agent,
    options: ClientOptions,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("server", &self.inner.server)
            .field("token", &"<redacted>")
            .field("options", &self.inner.options)
            .finish()
    }
}

impl Client {
    /// `server` 按 [`normalize_server`] 的规则核对并规范化：公网地址只许 https，令牌绝不明文发出。
    pub fn new(server: &str, token: impl Into<String>, options: ClientOptions) -> Result<Self, ServerAddressError> {
        let server = normalize_server(server)?;
        let agent = agent(&options.user_agent);
        Ok(Self { inner: Arc::new(Inner { server, token: token.into(), agent, options }) })
    }

    /// 规范化的站点地址（`https://shard.example.com`，无结尾斜杠）。
    pub fn server(&self) -> &str {
        &self.inner.server
    }

    pub fn options(&self) -> &ClientOptions {
        &self.inner.options
    }

    /// 读命令：没有幂等键。
    pub fn read(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        self.call(command, &args, None)
    }

    /// 写命令：新的幂等键，重试时复用。
    pub fn write(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        let key = idempotency_key(&self.inner.options.key_prefix);
        self.call(command, &args, Some(&key))
    }

    /// 写命令，幂等键由调用方给（离线队列重放时用记下的 op_id，跨进程重试也只提交一次）。
    pub fn write_with_key(&self, command: &str, args: Value, key: &str) -> Result<Value, RemoteError> {
        self.call(command, &args, Some(key))
    }

    /// 同 [`Client::write_with_key`]，时区偏移也由调用方给：离线时记下的操作按当时的时区补交
    /// （碎片 id、月份目录与时间都按它算），不随补交时本机时区变化。
    pub fn write_with_key_at(&self, command: &str, args: &Value, key: &str, utc_offset: i32) -> Result<Value, RemoteError> {
        self.call_at(command, args, Some(key), utc_offset)
    }

    /// 读命令并反序列化成 `T`；缺字段报 `BAD_RESPONSE`。
    pub fn read_as<T: serde::de::DeserializeOwned>(&self, command: &str, args: Value, what: &str) -> Result<T, RemoteError> {
        let value = self.read(command, args)?;
        decode(value, what).map_err(|error| self.with_context(command, error))
    }

    /// 写命令并反序列化成 `T`；缺字段报 `BAD_RESPONSE`。
    pub fn write_as<T: serde::de::DeserializeOwned>(&self, command: &str, args: Value, what: &str) -> Result<T, RemoteError> {
        let value = self.write(command, args)?;
        decode(value, what).map_err(|error| self.with_context(command, error))
    }

    /// 发一次 RPC：`key` 为 `None` 时不带幂等键（读命令）。网络失败与 502/503/504 按
    /// [`ClientOptions::retry_delays`] 重试，每次都用同一个键。
    pub fn call(&self, command: &str, args: &Value, key: Option<&str>) -> Result<Value, RemoteError> {
        self.call_at(command, args, key, utc_offset_minutes())
    }

    fn call_at(&self, command: &str, args: &Value, key: Option<&str>, utc_offset: i32) -> Result<Value, RemoteError> {
        let url = format!("{}/api/rpc/{command}", self.inner.server);
        let mut headers = vec![
            ("Authorization", format!("Bearer {}", self.inner.token)),
            ("X-Shard-UTC-Offset", utc_offset.to_string()),
        ];
        if let Some(key) = key {
            headers.push(("Idempotency-Key", key.to_string()));
        }
        let mut delays = self.inner.options.retry_delays.iter();
        loop {
            let error = match post_json(&self.inner.agent, &url, &headers, args) {
                Ok((200, text)) => {
                    return serde_json::from_str(&text).map_err(|error| {
                        self.error(command, Some(200), "BAD_RESPONSE", format!("服务器响应无法解析：{error}"), None)
                    });
                }
                Ok((status, text)) => {
                    let (code, message, detail) = error_body(status, &text);
                    self.error(command, Some(status), &code, message, detail)
                }
                Err(message) => self.error(command, None, "NETWORK", message, None),
            };
            match delays.next() {
                Some(delay) if error.is_retryable() => thread::sleep(*delay),
                _ => return Err(error),
            }
        }
    }

    pub(crate) fn token(&self) -> &str {
        &self.inner.token
    }

    pub(crate) fn agent(&self) -> &ureq::Agent {
        &self.inner.agent
    }

    pub(crate) fn error(
        &self,
        command: &str,
        status: Option<u16>,
        code: &str,
        message: String,
        detail: Option<Box<Value>>,
    ) -> RemoteError {
        RemoteError {
            server: self.inner.server.clone(),
            command: command.to_string(),
            status,
            code: code.to_string(),
            message,
            detail,
        }
    }

    fn with_context(&self, command: &str, error: RemoteError) -> RemoteError {
        RemoteError { server: self.inner.server.clone(), command: command.to_string(), ..error }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{fake_server, Reply};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn options() -> ClientOptions {
        ClientOptions::new("shard-test/1", "t").retry_base(Duration::from_millis(5))
    }

    #[test]
    fn idempotency_keys_are_prefixed_and_unique() {
        let first = idempotency_key("cli");
        assert!(first.starts_with("cli-") && first.len() == 36, "{first}");
        assert!(first[4..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(first, idempotency_key("cli"));
        assert!(idempotency_key("desktop").starts_with("desktop-"));
    }

    #[test]
    fn default_retries_wait_400_then_1200_milliseconds() {
        let options = ClientOptions::new("ua", "cli");
        assert_eq!(options.retry_delays, [Duration::from_millis(400), Duration::from_millis(1200)]);
        assert_eq!(options.retry_base(Duration::from_millis(10)).retry_delays, [Duration::from_millis(10), Duration::from_millis(30)]);
    }

    #[test]
    fn clients_refuse_plain_http_to_public_servers() {
        assert_eq!(
            Client::new("http://shard.example.com", "shd_dev_x", options()).unwrap_err(),
            ServerAddressError::InsecureHttp
        );
        let client = Client::new("Shard.Example.com/", "shd_dev_x", options()).unwrap();
        assert_eq!(client.server(), "https://shard.example.com");
        assert!(!format!("{client:?}").contains("shd_dev_x"), "Debug 不打印令牌");
    }

    #[test]
    fn writes_retry_gateway_and_network_failures_with_the_same_key() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let server = fake_server(move |request| {
            let mut log = log.lock().unwrap();
            log.push(request.clone());
            match log.len() {
                1 => Reply::status(503, ""),
                2 => Reply::Drop,
                _ => Reply::json(200, &json!({ "ok": true, "echo": request.json() })),
            }
        });
        let client = Client::new(&server, "shd_dev_secret", options()).unwrap();
        let value = client.write("create_fragment", json!({ "content": "x" })).unwrap();
        assert_eq!(value, json!({ "ok": true, "echo": { "content": "x" } }));

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "503 与断连各重试一次");
        let keys = seen.iter().map(|request| request.header("idempotency-key").unwrap().to_string()).collect::<Vec<_>>();
        assert!(keys[0].starts_with("t-") && keys[0].len() == 34, "{keys:?}");
        assert!(keys.iter().all(|key| key == &keys[0]), "重试复用同一个幂等键：{keys:?}");
        for request in seen.iter() {
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/api/rpc/create_fragment");
            assert_eq!(request.header("authorization"), Some("Bearer shd_dev_secret"));
            assert_eq!(request.header("user-agent"), Some("shard-test/1"));
            assert_eq!(request.header("content-type"), Some("application/json"));
            assert_eq!(request.header("x-shard-utc-offset"), Some(utc_offset_minutes().to_string().as_str()));
        }
    }

    #[test]
    fn caller_keys_and_reads_without_keys() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let server = fake_server(move |request| {
            let mut log = log.lock().unwrap();
            log.push(request.clone());
            if log.len() == 1 {
                Reply::status(502, "")
            } else {
                Reply::json(200, &json!([1, 2]))
            }
        });
        let client = Client::new(&server, "shd_dev_x", options()).unwrap();
        assert_eq!(client.read("list_tags", json!({})).unwrap(), json!([1, 2]));
        assert_eq!(client.write_with_key("update_fragment", json!({}), "op-123").unwrap(), json!([1, 2]));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "读请求遇到 502 也重试");
        assert!(seen[0].header("idempotency-key").is_none() && seen[1].header("idempotency-key").is_none());
        assert_eq!(seen[2].header("idempotency-key"), Some("op-123"));
    }

    #[test]
    fn retries_stop_after_the_configured_delays() {
        let count = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&count);
        let server = fake_server(move |_| {
            *counter.lock().unwrap() += 1;
            Reply::status(504, "")
        });
        let error = Client::new(&server, "shd_dev_x", options()).unwrap().write("x", json!({})).unwrap_err();
        assert_eq!(*count.lock().unwrap(), 3, "第一次加两次重试");
        assert_eq!((error.status, error.code.as_str()), (Some(504), "HTTP_504"));
        assert_eq!(error.message, "服务器返回 HTTP 504");
        assert!(error.is_retryable());

        // 连不上：重试后给出 NETWORK，status 为空。
        let unreachable = Client::new("http://127.0.0.1:9", "shd_dev_x", options()).unwrap().read("x", json!({})).unwrap_err();
        assert!(unreachable.is_network() && unreachable.is("NETWORK"), "{unreachable:?}");
        assert_eq!(unreachable.server, "http://127.0.0.1:9");
        assert_eq!(unreachable.command, "x");
    }

    #[test]
    fn error_responses_keep_code_message_and_structured_detail() {
        let count = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&count);
        let server = fake_server(move |request| {
            *counter.lock().unwrap() += 1;
            match request.path.as_str() {
                "/api/rpc/stale" => Reply::json(409, &json!({ "code": "STALE_BASE", "message": "内容已被修改" })),
                "/api/rpc/search" => Reply::json(
                    400,
                    &json!({ "code": "invalidRequest", "message": "invalidRequest", "error": { "code": "invalidRequest", "reason": "x" } }),
                ),
                "/api/rpc/reason" => Reply::json(400, &json!({ "code": "io", "reason": "disk" })),
                "/api/rpc/garbage" => Reply::status(200, "不是 JSON"),
                _ => Reply::json(401, &json!({ "code": "UNAUTHENTICATED", "message": "请登录" })),
            }
        });
        let client = Client::new(&server, "shd_dev_x", options()).unwrap();
        let stale = client.write("stale", json!({})).unwrap_err();
        assert_eq!((stale.status, stale.code.as_str(), stale.message.as_str()), (Some(409), "STALE_BASE", "内容已被修改"));
        assert!(stale.is("STALE_BASE") && !stale.is_retryable() && stale.detail.is_none());
        let search = client.read("search", json!({})).unwrap_err();
        assert_eq!(search.detail.as_deref(), Some(&json!({ "code": "invalidRequest", "reason": "x" })));
        assert_eq!(client.read("reason", json!({})).unwrap_err().message, "io：disk");
        let garbage = client.read("garbage", json!({})).unwrap_err();
        assert_eq!((garbage.status, garbage.code.as_str()), (Some(200), "BAD_RESPONSE"));
        assert!(garbage.message.starts_with("服务器响应无法解析："), "{}", garbage.message);
        assert!(client.read("other", json!({})).unwrap_err().is_unauthenticated());
        assert_eq!(*count.lock().unwrap(), 5, "4xx 与 200 解析失败都不重试");
    }

    #[test]
    fn typed_responses_report_missing_fields_as_bad_response() {
        #[derive(serde::Deserialize, Debug)]
        #[allow(dead_code)]
        struct Created {
            id: String,
            sha: String,
        }
        let error = decode::<Created>(json!({ "id": "x" }), "碎片").unwrap_err();
        assert_eq!((error.status, error.code.as_str()), (Some(200), "BAD_RESPONSE"));
        assert!(error.message.starts_with("服务器返回的碎片不完整或无法解析："), "{}", error.message);
        assert!(error.message.contains("sha"), "{}", error.message);

        let server = fake_server(|_| Reply::json(200, &json!({ "id": "x" })));
        let client = Client::new(&server, "shd_dev_x", options()).unwrap();
        let error = client.write_as::<Created>("create_fragment", json!({}), "碎片").unwrap_err();
        assert_eq!((error.server.as_str(), error.command.as_str()), (client.server(), "create_fragment"));
        assert!(error.is("BAD_RESPONSE"));
        let server = fake_server(|_| Reply::json(200, &json!({ "id": "x", "sha": "s" })));
        let client = Client::new(&server, "shd_dev_x", options()).unwrap();
        assert_eq!(client.read_as::<Created>("read", json!({}), "碎片").unwrap().sha, "s");
    }
}
