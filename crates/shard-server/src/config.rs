//! 服务端配置。`origin` 是浏览器地址栏里的站点（`https://shard.example.com`），
//! 通行密钥的 RP ID、CSRF 的 Origin 校验、Cookie 是否加 `Secure` 都由它决定。

use std::path::PathBuf;

use webauthn_rs::prelude::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub origin: Url,
    /// `origin` 的规范写法（无结尾斜杠），与请求头 `Origin` 逐字比较。
    pub origin_text: String,
    pub rp_id: String,
    pub static_dir: Option<PathBuf>,
    /// 只有这时才信任 `X-Forwarded-For`，并且只信任来自本机回环地址（Caddy）的连接。
    pub trust_proxy: bool,
}

impl Config {
    pub fn new(
        data_dir: PathBuf,
        origin: &str,
        static_dir: Option<PathBuf>,
        trust_proxy: bool,
    ) -> Result<Self, String> {
        let origin = Url::parse(origin).map_err(|error| format!("origin 无效：{error}"))?;
        let rp_id = origin
            .domain()
            .ok_or_else(|| "origin 必须是域名（本地开发用 http://localhost:端口，不能用 IP）。".to_string())?
            .to_string();
        let secure = origin.scheme() == "https";
        if !secure && rp_id != "localhost" {
            return Err("公网部署必须用 https。".to_string());
        }
        let origin_text = origin.origin().ascii_serialization();
        Ok(Self { data_dir, origin, origin_text, rp_id, static_dir, trust_proxy })
    }

    pub fn secure(&self) -> bool {
        self.origin.scheme() == "https"
    }

    /// `__Host-` 前缀要求 Secure 且不带 Domain，只能在 https 下用；本地开发退回普通名字。
    pub fn cookie_name(&self) -> &'static str {
        if self.secure() {
            "__Host-shard"
        } else {
            "shard_session"
        }
    }

    pub fn session_cookie(&self, token: &str, max_age_seconds: i64) -> String {
        let secure = if self.secure() { "; Secure" } else { "" };
        format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_seconds}{secure}",
            self.cookie_name()
        )
    }

    pub fn clear_cookie(&self) -> String {
        self.session_cookie("", 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_origins_must_be_https_domains() {
        assert!(Config::new("/tmp".into(), "http://shard.example.com", None, false).is_err());
        assert!(Config::new("/tmp".into(), "https://203.0.113.5", None, false).is_err());
        let config = Config::new("/tmp".into(), "https://shard.example.com/", None, true).unwrap();
        assert_eq!(config.origin_text, "https://shard.example.com");
        assert_eq!(config.rp_id, "shard.example.com");
        assert!(config.session_cookie("t", 60).starts_with("__Host-shard=t; Path=/; HttpOnly; SameSite=Strict"));
        assert!(config.session_cookie("t", 60).ends_with("; Secure"));
    }

    #[test]
    fn localhost_works_without_tls_for_development() {
        let config = Config::new("/tmp".into(), "http://localhost:8787", None, false).unwrap();
        assert_eq!(config.origin_text, "http://localhost:8787");
        assert_eq!(config.cookie_name(), "shard_session");
        assert!(!config.session_cookie("t", 60).contains("Secure"));
    }
}
