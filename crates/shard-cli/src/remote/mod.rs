//! 远程模式：用 `shard login` 配对过服务器、且没有显式指定 `--vault` / `SHARD_VAULT` 时，所有读写都调
//! 服务器的 RPC（`POST <服务器>/api/rpc/{命令}`，`Authorization: Bearer shd_dev_…`），本机不再碰 vault 文件。
//!
//! RPC 客户端、服务器地址规则、令牌存储与配对协议在 `shard-remote`（与桌面共用）：
//! - 写请求每次带新的 `Idempotency-Key`（前缀 `cli-`）；网络失败或网关临时不可用（502/503/504）时用同一个键重试，
//!   服务器保证同一个键只提交一次。
//! - 都带 `X-Shard-UTC-Offset`（本机时区，分钟）：碎片 id、月份目录与时间按本机时区算，与本地模式一致。
//! - 新建内容的 `source` 由服务器按设备种类记为 `cli`；支持 `source` 参数的命令（新建笔记）
//!   在给了 `--source` / `SHARD_SOURCE` 时把它传过去。
//!
//! 这里只留命令行自己的部分：User-Agent 与测试用的环境变量、错误映射到本地模式的错误码与退出码
//! （见 [`IntoCli::into_cli`]）、提示文案里的命令名。

pub mod login;
pub mod ops;
pub mod store;

use crate::CliError;
use serde_json::Value;
use shard_remote::{Client, ClientOptions, ServerAddressError};
use std::{env, time::Duration};
pub use shard_remote::{RemoteConfig, RemoteError};

/// 自动生成的幂等键前缀：`cli-<32 位十六进制>`。
const KEY_PREFIX: &str = "cli";

/// 请求头 `User-Agent`。
pub fn user_agent() -> String {
    format!("shard-cli/{}", env!("CARGO_PKG_VERSION"))
}

/// 新的幂等键（也用作搜索的 clientRequestId）：`cli-<32 位十六进制>`。
pub fn idempotency_key() -> String {
    shard_remote::idempotency_key(KEY_PREFIX)
}

/// RPC 客户端参数。`SHARD_RETRY_DELAY_MS` 只给测试缩短重试等待。
pub fn client_options() -> ClientOptions {
    let options = ClientOptions::new(user_agent(), KEY_PREFIX);
    match env::var("SHARD_RETRY_DELAY_MS").ok().and_then(|value| value.parse::<u64>().ok()) {
        Some(base) => options.retry_base(Duration::from_millis(base)),
        None => options,
    }
}

#[derive(Clone)]
pub struct Remote {
    pub config: RemoteConfig,
    client: Client,
}

/// 把远程错误映射到本地模式的错误码与退出码。
pub trait IntoCli {
    fn into_cli(self) -> CliError;
}

impl IntoCli for RemoteError {
    /// - 409 `STALE_BASE` → `CONFLICT`（退出码 2）；`HEADER_CHANGED` → 2；`KEY_CONFLICT` → 3；
    /// - `NOT_FOUND`、`AMBIGUOUS` 原样；401 → `UNAUTHENTICATED`，提示重新 `shard login`；
    /// - 网络不可达 → `NETWORK`；其余 `ERROR`，消息用服务器给的原文。
    fn into_cli(self) -> CliError {
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
    shard_remote::decode(value, what).map_err(CliError::from)
}

/// 规范化用户输入的服务器地址（规则见 [`shard_remote::normalize_server`]）。
pub fn normalize_server(input: &str) -> Result<String, String> {
    shard_remote::normalize_server(input).map_err(server_address_message)
}

/// 地址不可用的提示；缺地址时给出命令行的写法。
pub fn server_address_message(error: ServerAddressError) -> String {
    match error {
        ServerAddressError::Missing => "缺少服务器地址，例如 shard login https://shard.example.com".to_string(),
        other => other.to_string(),
    }
}

impl Remote {
    /// 用已保存的配置与令牌连服务器（地址按同一条规则再核对一次）。
    fn connect(config: RemoteConfig, token: String) -> Result<Self, String> {
        let client = Client::new(&config.server, token, client_options()).map_err(|error| error.to_string())?;
        Ok(Self { config, client })
    }

    /// 读本机的远程配置；没有配置返回 `None`（本地模式）。配置在但令牌不在时报错，提示重新登录。
    pub fn load() -> Result<Option<Self>, CliError> {
        let Some(mut config) = store::load_config()? else {
            return Ok(None);
        };
        // 配置文件可能被改过：公网地址只许 https，与登录时同一条规则。
        let unusable = |message: String| {
            CliError::new(
                "ERROR",
                format!("remote.json 里的服务器地址不可用（{message}）。请运行 shard logout 后重新 shard login。"),
            )
        };
        config.server = normalize_server(&config.server).map_err(unusable)?;
        let token = store::load_token(&config.server)?.ok_or_else(|| {
            CliError::new(
                "UNAUTHENTICATED",
                format!(
                    "已配置服务器 {0}，但本机没有它的登录令牌。请运行 shard login {0}",
                    config.server
                ),
            )
        })?;
        Ok(Some(Self::connect(config, token).map_err(unusable)?))
    }

    pub fn server(&self) -> &str {
        &self.config.server
    }

    /// 读命令：没有幂等键。
    pub fn read(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        self.client.read(command, args)
    }

    /// 写命令：新的幂等键，重试时复用。
    pub fn write(&self, command: &str, args: Value) -> Result<Value, RemoteError> {
        self.client.write(command, args)
    }
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
        assert_eq!(
            normalize_server("  ").unwrap_err(),
            "缺少服务器地址，例如 shard login https://shard.example.com"
        );
    }

    #[test]
    fn idempotency_keys_are_unique() {
        let first = idempotency_key();
        assert!(first.starts_with("cli-") && first.len() == 36);
        assert_ne!(first, idempotency_key());
        // 写请求自动生成的键用同一个前缀；User-Agent 仍是 shard-cli/<版本>。
        let options = client_options();
        assert_eq!(options.key_prefix, KEY_PREFIX);
        assert_eq!(options.user_agent, format!("shard-cli/{}", env!("CARGO_PKG_VERSION")));
    }
}
