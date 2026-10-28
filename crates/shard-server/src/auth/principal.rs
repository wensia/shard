//! 请求的调用者：浏览器会话（Cookie）或已配对的设备（Bearer 设备令牌）。
//!
//! CSRF：只有 Cookie 这种「浏览器自动携带」的凭据才有跨站伪造的问题。凡是用 Cookie 认证、或者
//! 还没登录的浏览器变更请求（登录、setup），都要求：
//! - 自定义头 `X-Shard-Request: 1`（跨站表单与简单请求带不上）；
//! - `Origin` 与配置的站点逐字相同；
//! - 有 `Sec-Fetch-Site` 时必须是 `same-origin`。
//!
//! 设备令牌由客户端显式附带，不受 CSRF 影响。

use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{header, request::Parts, Method},
};
use chrono::{DateTime, Utc};

use super::db::STEP_UP_WINDOW;
use crate::{config::Config, error::ApiError, state::AppState};

#[derive(Clone, Debug, Default)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Principal {
    Session { id_hash: Vec<u8>, step_up_at: Option<DateTime<Utc>> },
    Device { device_id: String, name: String, kind: String, scopes: String },
}

#[derive(Clone, Debug)]
pub struct Caller {
    pub principal: Principal,
    pub meta: ClientMeta,
}

impl Caller {
    /// 写进 txns / 审计的操作者。
    pub fn actor(&self) -> String {
        match &self.principal {
            Principal::Session { id_hash, .. } => format!("session:{}", &super::tokens::hex(id_hash)[..8]),
            Principal::Device { device_id, .. } => format!("device:{device_id}"),
        }
    }

    /// 修订合并按设备区分：每个浏览器会话、每台配对设备各算一个。
    pub fn device(&self) -> String {
        self.actor()
    }

    /// 新建内容写进 frontmatter 的 `source`：浏览器 web，配对的桌面 desktop，命令行 cli。
    pub fn source(&self) -> &'static str {
        match &self.principal {
            Principal::Session { .. } => "web",
            Principal::Device { kind, .. } if kind == "cli" => "cli",
            Principal::Device { .. } => "desktop",
        }
    }

    pub fn session_hash(&self) -> Option<&[u8]> {
        match &self.principal {
            Principal::Session { id_hash, .. } => Some(id_hash),
            Principal::Device { .. } => None,
        }
    }

    /// 敏感操作：只能由最近 10 分钟内验证过通行密钥的浏览器会话执行。
    pub fn require_step_up(&self) -> Result<&[u8], ApiError> {
        match &self.principal {
            Principal::Session { id_hash, step_up_at: Some(at) } if Utc::now() - *at <= STEP_UP_WINDOW => Ok(id_hash),
            Principal::Session { .. } => Err(ApiError::step_up_required()),
            Principal::Device { .. } => Err(ApiError::forbidden("SESSION_REQUIRED", "这个操作只能在浏览器里完成。")),
        }
    }

    pub fn require_session(&self) -> Result<&[u8], ApiError> {
        self.session_hash()
            .ok_or_else(|| ApiError::forbidden("SESSION_REQUIRED", "这个操作只能在浏览器里完成。"))
    }
}

fn header_text(parts: &Parts, name: &str) -> Option<String> {
    parts.headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_string)
}

pub fn client_meta(parts: &Parts, config: &Config) -> ClientMeta {
    let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip());
    let forwarded = || {
        header_text(parts, "x-forwarded-for")
            .and_then(|value| value.split(',').next().map(|ip| ip.trim().to_string()))
            .filter(|ip| ip.parse::<IpAddr>().is_ok())
    };
    let ip = match peer {
        Some(peer) if config.trusts_proxy(peer) => forwarded().or(Some(peer.to_string())),
        Some(peer) => Some(peer.to_string()),
        None if config.trust_proxy => forwarded(),
        None => None,
    };
    ClientMeta {
        ip,
        user_agent: header_text(parts, header::USER_AGENT.as_str()).map(|ua| ua.chars().take(200).collect()),
    }
}

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub fn csrf_check(parts: &Parts, config: &Config) -> Result<(), ApiError> {
    if is_safe_method(&parts.method) {
        return Ok(());
    }
    let reject = || ApiError::forbidden("CSRF", "请求来源校验失败。");
    if header_text(parts, "x-shard-request").as_deref() != Some("1") {
        return Err(reject());
    }
    if header_text(parts, header::ORIGIN.as_str()).as_deref() != Some(config.origin_text.as_str()) {
        return Err(reject());
    }
    if let Some(site) = header_text(parts, "sec-fetch-site") {
        if site != "same-origin" {
            return Err(reject());
        }
    }
    Ok(())
}

pub fn session_cookie(parts: &Parts, config: &Config) -> Option<String> {
    let name = config.cookie_name();
    parts
        .headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

fn bearer(parts: &Parts) -> Option<String> {
    header_text(parts, header::AUTHORIZATION.as_str())
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
}

async fn resolve(parts: &Parts, state: &AppState) -> Result<Option<Caller>, ApiError> {
    let meta = client_meta(parts, &state.config);
    if let Some(token) = bearer(parts) {
        let auth = state.clone();
        let ip = meta.ip.clone();
        let device = tokio::task::spawn_blocking(move || auth.auth.device_by_token(&token, ip.as_deref()))
            .await
            .map_err(ApiError::internal)??;
        return match device {
            Some(device) => Ok(Some(Caller {
                principal: Principal::Device {
                    device_id: device.device_id,
                    name: device.name,
                    kind: device.kind,
                    scopes: device.scopes,
                },
                meta,
            })),
            None => Err(ApiError::unauthorized()),
        };
    }
    let Some(token) = session_cookie(parts, &state.config) else {
        return Ok(None);
    };
    let auth = state.clone();
    let session = tokio::task::spawn_blocking(move || auth.auth.touch_session(&token))
        .await
        .map_err(ApiError::internal)??;
    Ok(session.map(|session| Caller {
        principal: Principal::Session { id_hash: session.id_hash, step_up_at: session.step_up_at },
        meta,
    }))
}

impl FromRequestParts<AppState> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let caller = resolve(parts, state).await?.ok_or_else(ApiError::unauthorized)?;
        if matches!(caller.principal, Principal::Session { .. }) {
            csrf_check(parts, &state.config)?;
        }
        Ok(caller)
    }
}

/// 可选登录（例如 `GET /api/auth/state`）。
pub struct MaybeCaller(pub Option<Caller>);

impl FromRequestParts<AppState> for MaybeCaller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match resolve(parts, state).await {
            Ok(caller) => Ok(MaybeCaller(caller)),
            Err(error) if error.status == axum::http::StatusCode::UNAUTHORIZED => Ok(MaybeCaller(None)),
            Err(error) => Err(error),
        }
    }
}

/// 未登录的浏览器变更请求（登录、setup）：同样要过 CSRF 校验，防止登录 CSRF。
pub struct BrowserRequest(pub ClientMeta);

impl FromRequestParts<AppState> for BrowserRequest {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        csrf_check(parts, &state.config)?;
        Ok(BrowserRequest(client_meta(parts, &state.config)))
    }
}

/// 非浏览器客户端的匿名请求（设备配对）：只取元信息。
pub struct Meta(pub ClientMeta);

impl FromRequestParts<AppState> for Meta {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(Meta(client_meta(parts, &state.config)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn meta(config: &Config, peer: &str, forwarded: Option<&str>) -> Option<String> {
        let mut request = Request::builder().uri("/api/auth/login/start");
        if let Some(forwarded) = forwarded {
            request = request.header("x-forwarded-for", forwarded);
        }
        let (mut parts, _) = request.body(()).unwrap().into_parts();
        parts.extensions.insert(ConnectInfo(SocketAddr::new(peer.parse().unwrap(), 50000)));
        client_meta(&parts, config).ip
    }

    #[test]
    fn the_client_ip_comes_from_the_proxy_only_when_the_peer_is_the_proxy() {
        let config = Config::new("/tmp".into(), "https://shard.example.com", None, true)
            .unwrap()
            .with_proxy_networks(vec!["172.18.0.0/16".parse().unwrap()]);
        // Caddy（docker 网络里）转发：限流和审计按真实客户端 IP 算，而不是所有人都算成 Caddy 一个 IP。
        assert_eq!(meta(&config, "172.18.0.4", Some("198.51.100.7")).as_deref(), Some("198.51.100.7"));
        assert_eq!(meta(&config, "127.0.0.1", Some("198.51.100.7")).as_deref(), Some("198.51.100.7"));
        // 直连的对端自己填的头不算数。
        assert_eq!(meta(&config, "203.0.113.5", Some("198.51.100.7")).as_deref(), Some("203.0.113.5"));
        // 头缺失或不是 IP 时退回对端地址。
        assert_eq!(meta(&config, "172.18.0.4", None).as_deref(), Some("172.18.0.4"));
        assert_eq!(meta(&config, "172.18.0.4", Some("unknown")).as_deref(), Some("172.18.0.4"));
    }
}
