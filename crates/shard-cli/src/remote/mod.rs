//! 远程模式：用 `shard login` 配对过服务器、且没有显式指定 `--vault` / `SHARD_VAULT` 时，所有读写都调
//! 服务器的 RPC（`POST <服务器>/api/rpc/{命令}`，`Authorization: Bearer shd_dev_…`），本机不再碰 vault 文件。
//!
//! - 写请求每次带新的 `Idempotency-Key`；网络失败或网关临时不可用（502/503/504）时用同一个键重试，
//!   服务器保证同一个键只提交一次。
//! - 都带 `X-Shard-UTC-Offset`（本机时区，分钟）：碎片 id、月份目录与时间按本机时区算，与本地模式一致。
//! - 新建内容的 `source` 由服务器按设备种类记为 `cli`；支持 `source` 参数的命令（新建笔记）
//!   在给了 `--source` / `SHARD_SOURCE` 时把它传过去。
//! - 错误映射保持本地模式的约定（见 [`RemoteError::into_cli`]）。

pub mod login;
pub mod ops;
pub mod store;

use crate::CliError;
use rand::RngCore;
use serde_json::Value;
use std::{env, thread, time::Duration};
pub use store::RemoteConfig;

/// 响应体上限：`list_documents` 带正文时是整个资料库的文本。
const MAX_RESPONSE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone)]
pub struct Remote {
    pub config: RemoteConfig,
    token: String,
    agent: ureq::Agent,
}

/// 一次 RPC 失败：`status` 为 `None` 表示没拿到 HTTP 响应（网络不可达、超时、TLS 失败）。
#[derive(Debug)]
pub struct RemoteError {
    pub server: String,
    pub command: String,
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl RemoteError {
    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    /// 映射到本地模式的错误码与退出码：
    /// - 409 `STALE_BASE` → `CONFLICT`（退出码 2）；`HEADER_CHANGED` → 2；`KEY_CONFLICT` → 3；
    /// - `NOT_FOUND`、`AMBIGUOUS` 原样；401 → `UNAUTHENTICATED`，提示重新 `shard login`；
    /// - 网络不可达 → `NETWORK`；其余 `ERROR`，消息用服务器给的原文。
    pub fn into_cli(self) -> CliError {
        if self.status.is_none() {
            return CliError::new(
                "NETWORK",
                format!(
                    "连不上 Shard 服务器 {}（{}）。请检查网络；用 shard --whoami 查看当前配置。",
                    self.server, self.message
                ),
            );
        }
        if self.status == Some(401) {
            return CliError::new(
                "UNAUTHENTICATED",
                format!(
                    "服务器不认这台设备的登录令牌（可能已在网页里吊销）。请重新运行 shard login {}",
                    self.server
                ),
            );
        }
        match self.code.as_str() {
            "STALE_BASE" => CliError::new(
                "CONFLICT",
                "内容已被修改（sha 与 --expect 不符），没有覆盖。请重新读取后基于最新内容再改。",
            ),
            "HEADER_CHANGED" => CliError::new("HEADER_CHANGED", self.message),
            "KEY_CONFLICT" => CliError::new("KEY_CONFLICT", self.message),
            "NOT_FOUND" => CliError::new("NOT_FOUND", self.message),
            "AMBIGUOUS" => CliError::new("AMBIGUOUS", self.message),
            "BAD_RESPONSE" => CliError::new("BAD_RESPONSE", self.message),
            "UNKNOWN_COMMAND" => CliError::new(
                "ERROR",
                format!("服务器不支持命令 {}，请升级 Shard 服务器。", self.command),
            ),
            _ => CliError::new("ERROR", self.message),
        }
    }
}

impl From<RemoteError> for CliError {
    fn from(error: RemoteError) -> Self {
        error.into_cli()
    }
}

/// 服务器响应 → 有类型的结构体；缺字段或类型不对时报 `BAD_RESPONSE`，不当成功处理。
pub fn decode<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T, CliError> {
    serde_json::from_value(value)
        .map_err(|error| CliError::new("BAD_RESPONSE", format!("服务器返回的{what}不完整或无法解析：{error}")))
}

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent(format!("shard-cli/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// 本机时区相对 UTC 的分钟数（`X-Shard-UTC-Offset`）。
pub fn utc_offset_minutes() -> i32 {
    chrono::Local::now().offset().local_minus_utc() / 60
}

pub fn idempotency_key() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("cli-{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// 网络失败与网关临时不可用时的重试间隔（`SHARD_RETRY_DELAY_MS` 只给测试缩短等待）。
fn retry_delays() -> Vec<Duration> {
    let base = env::var("SHARD_RETRY_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(400);
    vec![Duration::from_millis(base), Duration::from_millis(base * 3)]
}

/// ureq 的传输错误 → 给人看的一句话。
pub fn describe_transport(error: &ureq::Error) -> String {
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
pub fn post_json(
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

impl Remote {
    /// 读本机的远程配置；没有配置返回 `None`（本地模式）。配置在但令牌不在时报错，提示重新登录。
    pub fn load() -> Result<Option<Self>, CliError> {
        let Some(mut config) = store::load_config()? else {
            return Ok(None);
        };
        // 配置文件可能被改过：公网地址只许 https，与登录时同一条规则。
        config.server = normalize_server(&config.server).map_err(|message| {
            CliError::new(
                "ERROR",
                format!("remote.json 里的服务器地址不可用（{message}）。请运行 shard logout 后重新 shard login。"),
            )
        })?;
        let token = store::load_token(&config.server)?.ok_or_else(|| {
            CliError::new(
                "UNAUTHENTICATED",
                format!(
                    "已配置服务器 {0}，但本机没有它的登录令牌。请运行 shard login {0}",
                    config.server
                ),
            )
        })?;
        Ok(Some(Self { config, token, agent: agent() }))
    }

    pub fn server(&self) -> &str {
        &self.config.server
    }

    /// 读命令：没有幂等键。
    pub fn read(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        self.call(command, &args, None)
    }

    /// 写命令：新的幂等键，重试时复用。
    pub fn write(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        let key = idempotency_key();
        self.call(command, &args, Some(&key))
    }

    fn call(&self, command: &str, args: &Value, key: Option<&str>) -> Result<Value, RemoteError> {
        let url = format!("{}/api/rpc/{command}", self.config.server);
        let mut headers = vec![
            ("Authorization", format!("Bearer {}", self.token)),
            ("X-Shard-UTC-Offset", utc_offset_minutes().to_string()),
        ];
        if let Some(key) = key {
            headers.push(("Idempotency-Key", key.to_string()));
        }
        let mut delays = retry_delays().into_iter();
        loop {
            let error = match post_json(&self.agent, &url, &headers, args) {
                Ok((200, text)) => {
                    return serde_json::from_str(&text).map_err(|error| {
                        self.error(command, Some(200), "BAD_RESPONSE", format!("服务器响应无法解析：{error}"))
                    });
                }
                Ok((status, text)) => {
                    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                    let code = body["code"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP_{status}"));
                    // 搜索契约的结构化错误没有 message，只有 code 与 reason。
                    let message = body["message"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| body["reason"].as_str().map(|reason| format!("{code}：{reason}")))
                        .unwrap_or_else(|| format!("服务器返回 HTTP {status}"));
                    self.error(command, Some(status), &code, message)
                }
                Err(message) => self.error(command, None, "NETWORK", message),
            };
            let retryable = matches!(error.status, None | Some(502..=504));
            match delays.next() {
                Some(delay) if retryable => thread::sleep(delay),
                _ => return Err(error),
            }
        }
    }

    fn error(&self, command: &str, status: Option<u16>, code: &str, message: String) -> RemoteError {
        RemoteError {
            server: self.config.server.clone(),
            command: command.to_string(),
            status,
            code: code.to_string(),
            message,
        }
    }
}

/// 规范化用户输入的服务器地址：缺协议时补 `https://`，去掉结尾斜杠；只允许站点根（不带路径）。
/// 明文 http 只允许本机回环地址（开发与测试），公网地址必须 https，令牌不能明文传输。
pub fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err("缺少服务器地址，例如 shard login https://shard.example.com".to_string());
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let uri: ureq::http::Uri = with_scheme.parse().map_err(|_| format!("服务器地址无效：{input}"))?;
    let scheme = uri.scheme_str().unwrap_or_default().to_ascii_lowercase();
    let authority = uri.authority().ok_or_else(|| format!("服务器地址无效：{input}"))?;
    if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
        return Err("服务器地址只写站点，不要带路径，例如 https://shard.example.com".to_string());
    }
    if authority.as_str().contains('@') {
        return Err("服务器地址不能带用户名或密码".to_string());
    }
    let host = authority.host().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    match scheme.as_str() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("公网服务器必须用 https，设备令牌不能明文传输".to_string()),
        _ => return Err(format!("不支持的协议：{scheme}")),
    }
    Ok(format!("{scheme}://{}", authority.as_str().to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_normalized_and_https_only() {
        assert_eq!(normalize_server("shard.example.com").unwrap(), "https://shard.example.com");
        assert_eq!(normalize_server("https://Shard.Example.com/").unwrap(), "https://shard.example.com");
        assert_eq!(normalize_server("http://localhost:8787").unwrap(), "http://localhost:8787");
        assert_eq!(normalize_server("http://127.0.0.1:9000/").unwrap(), "http://127.0.0.1:9000");
        assert!(normalize_server("http://shard.example.com").is_err());
        assert!(normalize_server("https://shard.example.com/api").is_err());
        assert!(normalize_server("https://user:pass@shard.example.com").is_err());
        assert!(normalize_server("ftp://shard.example.com").is_err());
        assert!(normalize_server("  ").is_err());
    }

    #[test]
    fn idempotency_keys_are_unique() {
        let first = idempotency_key();
        assert!(first.starts_with("cli-") && first.len() == 36);
        assert_ne!(first, idempotency_key());
    }
}
