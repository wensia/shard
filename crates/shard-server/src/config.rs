//! 服务端配置。全部来自环境变量——没有配置文件要读，也就没有「配置文件在
//! 容器里没挂上」这类部署事故。

use std::path::PathBuf;

/// 单用户自用，所以认证退化成一个长期令牌。
///
/// 令牌**只从环境变量读**，不落配置文件、不写日志。启动时缺失直接拒绝启动：
/// 一个没有认证的同步端点等于把整个笔记库公开在互联网上，宁可起不来。
pub struct Config {
    /// 监听地址。默认只绑 127.0.0.1——公网暴露交给前面的反向代理，
    /// 由它终止 TLS。服务本体不该直接面向互联网。
    pub bind: String,
    /// 数据目录：SQLite 库与附件都放这里。
    pub data_dir: PathBuf,
    pub auth_token: String,
    /// 单次上传的附件大小上限，字节。
    pub max_attachment_bytes: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let auth_token = std::env::var("SHARD_AUTH_TOKEN")
            .map_err(|_| "缺少 SHARD_AUTH_TOKEN：没有令牌就等于不设防，拒绝启动。".to_string())?;

        if auth_token.len() < MIN_TOKEN_LEN {
            return Err(format!(
                "SHARD_AUTH_TOKEN 太短（至少 {MIN_TOKEN_LEN} 字符）。它是唯一的一道门。"
            ));
        }

        Ok(Self {
            bind: std::env::var("SHARD_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string()),
            data_dir: std::env::var("SHARD_DATA_DIR")
                .unwrap_or_else(|_| "/var/lib/shard".to_string())
                .into(),
            auth_token,
            max_attachment_bytes: std::env::var("SHARD_MAX_ATTACHMENT_BYTES")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_MAX_ATTACHMENT_BYTES),
        })
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("notes.sqlite3")
    }

    pub fn attachments_dir(&self) -> PathBuf {
        self.data_dir.join("attachments")
    }
}

/// 32 字符大致对应 128 bit 的随机令牌。比这更短的多半是人手打的口令。
const MIN_TOKEN_LEN: usize = 32;

/// 25 MiB。图片附件的合理上限，同时挡住「一次 PUT 塞满磁盘」。
const DEFAULT_MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_paths_hang_off_the_data_dir() {
        let config = Config {
            bind: "127.0.0.1:8787".into(),
            data_dir: PathBuf::from("/var/lib/shard"),
            auth_token: "x".repeat(MIN_TOKEN_LEN),
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        };

        assert_eq!(
            config.database_path(),
            PathBuf::from("/var/lib/shard/notes.sqlite3")
        );
        assert_eq!(
            config.attachments_dir(),
            PathBuf::from("/var/lib/shard/attachments")
        );
    }
}
