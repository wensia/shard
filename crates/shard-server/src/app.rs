//! 路由装配与全站安全响应头。

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue},
    middleware::{self, Next},
    response::Response,
    routing::get,
    Router,
};
use tower_http::services::{ServeDir, ServeFile};

use crate::{auth, error::ApiError, events, files, history, rpc, state::AppState};

/// RPC 请求体上限：CSV 原文、画布 JSON 都走 RPC。
const MAX_RPC_BODY: usize = 64 * 1024 * 1024;

/// 网页的内容安全策略。远程图片（笔记与表格里的 https 图片）允许加载；脚本只允许同源与 wasm（密匣的 argon2）。
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
img-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; \
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

pub fn build(state: AppState) -> Router {
    let api = Router::new()
        .merge(auth::routes::router())
        .merge(rpc::router())
        .merge(events::router())
        .merge(files::router())
        .merge(history::router())
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(MAX_RPC_BODY));
    let mut app = Router::new().route("/healthz", get(|| async { "ok" })).nest("/api", api);
    if let Some(dir) = state.config.static_dir.clone() {
        // 单页应用：找不到的路径回 index.html（/setup 等前端路由）。
        app = app.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    app.layer(middleware::from_fn_with_state(state.clone(), security_headers)).with_state(state)
}

async fn security_headers(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let is_hashed_asset = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let mut set = |name: &'static str, value: &'static str| {
        if !headers.contains_key(name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    };
    set("content-security-policy", CSP);
    set("x-content-type-options", "nosniff");
    set("referrer-policy", "no-referrer");
    set("cross-origin-opener-policy", "same-origin");
    set("cross-origin-resource-policy", "same-origin");
    set("x-frame-options", "DENY");
    set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if is_api {
        set("cache-control", "no-store");
    } else if is_hashed_asset {
        // Vite 产物文件名带内容哈希。
        set("cache-control", "public, max-age=31536000, immutable");
    } else {
        set("cache-control", "no-cache");
    }
    if state.config.secure() {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}
