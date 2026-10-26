//! 服务端端点的集成测试：直接对 Router 发请求，不起网络端口。
//! 需要 `test-auth` 特性（直接签发会话），运行：`cargo test -p shard-server --features test-auth`。
#![cfg(feature = "test-auth")]

use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_core::Vfs;
use shard_server::{
    app,
    config::Config,
    rpc::{base_registry, Access, RpcEnv, RpcError},
    state::AppState,
};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18787";
/// 1×1 PNG。
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// 测试专用的写命令：把 base64 内容写到某个路径（父目录自动建）。
fn put_file(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let path = args["path"].as_str().ok_or_else(|| RpcError::invalid_args("缺 path"))?.to_string();
    let bytes = STANDARD.decode(args["base64"].as_str().unwrap_or_default()).map_err(RpcError::invalid_args)?;
    env.write(|vfs| {
        vfs.write_atomic(&vfs.root().join(&path), &bytes).map_err(|error| RpcError::from(error.to_string()))?;
        Ok(json!({ "path": path }))
    })
}

fn stale(_env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    Err(RpcError::from("STALE_BASE:文件已被修改".to_string()))
}

struct Harness {
    _dir: tempfile::TempDir,
    app: Router,
    cookie: String,
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::new(dir.path().to_path_buf(), ORIGIN, None, false).unwrap();
        let mut registry = base_registry();
        registry.register("put_file", Access::Write, put_file);
        registry.register("stale", Access::Read, stale);
        let state = AppState::open(config, registry).unwrap();
        let app = app::build(state);
        let response = app
            .clone()
            .oneshot(Request::post("/api/test/session").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
        Self { _dir: dir, app, cookie }
    }

    fn browser(&self, method: Method, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, &self.cookie)
            .header("x-shard-request", "1")
            .header(header::ORIGIN, ORIGIN)
            .header("sec-fetch-site", "same-origin")
    }

    async fn send(&self, request: Request<Body>) -> axum::response::Response {
        self.app.clone().oneshot(request).await.unwrap()
    }

    async fn rpc(&self, command: &str, key: Option<&str>, body: Value) -> axum::response::Response {
        let mut request = self.browser(Method::POST, &format!("/api/rpc/{command}")).header(header::CONTENT_TYPE, "application/json");
        if let Some(key) = key {
            request = request.header("idempotency-key", key);
        }
        self.send(request.body(Body::from(body.to_string())).unwrap()).await
    }
}

#[tokio::test]
async fn writes_need_an_idempotency_key_and_replay_exactly_once() {
    let h = Harness::new().await;
    let args = json!({ "path": "notes/a.md", "base64": STANDARD.encode("一") });
    assert_eq!(h.rpc("put_file", None, args.clone()).await.status(), StatusCode::BAD_REQUEST);

    let first = h.rpc("put_file", Some("op-1"), args.clone()).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert!(first.headers().get("idempotent-replayed").is_none());
    assert_eq!(body_json(first).await, json!({ "path": "notes/a.md" }));

    let again = h.rpc("put_file", Some("op-1"), args).await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(again.headers()["idempotent-replayed"], "true");

    let reused = h.rpc("put_file", Some("op-1"), json!({ "path": "notes/b.md", "base64": "" })).await;
    assert_eq!(reused.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // 领域错误的 STALE_BASE 约定原样带回。
    let conflict = h.rpc("stale", None, json!({})).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let body = body_json(conflict).await;
    assert_eq!(body["code"], "STALE_BASE");
    assert!(body["message"].as_str().unwrap().starts_with("STALE_BASE:"));

    let unknown = h.rpc("no_such_command", None, json!({})).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cookie_requests_without_csrf_headers_are_rejected() {
    let h = Harness::new().await;
    let request = Request::post("/api/rpc/server_status")
        .header(header::COOKIE, &h.cookie)
        .body(Body::empty())
        .unwrap();
    let response = h.send(request).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(response).await["code"], "CSRF");
    // GET 不需要（没有副作用）。
    let state = h.send(h.browser(Method::GET, "/api/auth/state").body(Body::empty()).unwrap()).await;
    assert_eq!(body_json(state).await["authenticated"], true);
}

#[tokio::test]
async fn images_are_served_with_etags_and_non_images_are_hidden() {
    let h = Harness::new().await;
    h.rpc("put_file", Some("img"), json!({ "path": "notes/证件/图.png", "base64": STANDARD.encode(PNG) })).await;
    h.rpc("put_file", Some("txt"), json!({ "path": "notes/秘密.md", "base64": STANDARD.encode("x") })).await;

    let image = h
        .send(h.browser(Method::GET, "/api/files/notes/%E8%AF%81%E4%BB%B6/%E5%9B%BE.png").body(Body::empty()).unwrap())
        .await;
    assert_eq!(image.status(), StatusCode::OK);
    assert_eq!(image.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(image.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    let etag = image.headers()[header::ETAG].to_str().unwrap().to_string();

    let cached = h
        .send(
            h.browser(Method::GET, "/api/files/notes/%E8%AF%81%E4%BB%B6/%E5%9B%BE.png")
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);

    for hidden in ["/api/files/notes/%E7%A7%98%E5%AF%86.md", "/api/files/../etc/passwd", "/api/files/notes/none.png"] {
        let response = h.send(h.browser(Method::GET, hidden).body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{hidden}");
    }
    // 未登录拿不到图。
    let anonymous = h
        .send(Request::get("/api/files/notes/%E8%AF%81%E4%BB%B6/%E5%9B%BE.png").body(Body::empty()).unwrap())
        .await;
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn blobs_are_content_addressed_and_verified() {
    let h = Harness::new().await;
    let data = vec![3u8; 2048];
    let sha = shard_core::sha256_hex(&data);
    let wrong = "0".repeat(64);
    let put = |sha: String| h.browser(Method::PUT, &format!("/api/blobs/{sha}")).body(Body::from(data.clone())).unwrap();
    assert_eq!(h.send(put(wrong)).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(h.send(h.browser(Method::HEAD, &format!("/api/blobs/{sha}")).body(Body::empty()).unwrap()).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(h.send(put(sha.clone())).await.status(), StatusCode::CREATED);
    assert_eq!(h.send(h.browser(Method::HEAD, &format!("/api/blobs/{sha}")).body(Body::empty()).unwrap()).await.status(), StatusCode::OK);
    let got = h.send(h.browser(Method::GET, &format!("/api/blobs/{sha}")).body(Body::empty()).unwrap()).await;
    assert_eq!(got.into_body().collect().await.unwrap().to_bytes(), Bytes::from(data));
}

#[tokio::test]
async fn sync_endpoints_page_changes_and_list_the_manifest() {
    let h = Harness::new().await;
    for (index, path) in ["fragments/a.md", "fragments/b.md", "notes/c.md"].iter().enumerate() {
        h.rpc("put_file", Some(&format!("op-{index}")), json!({ "path": path, "base64": STANDARD.encode(*path) })).await;
    }
    let page = body_json(h.send(h.browser(Method::GET, "/api/sync/changes?since=0&limit=2").body(Body::empty()).unwrap()).await).await;
    assert_eq!(page["changes"].as_array().unwrap().len(), 2);
    assert_eq!(page["more"], true);
    let manifest = body_json(h.send(h.browser(Method::GET, "/api/sync/manifest").body(Body::empty()).unwrap()).await).await;
    let paths: Vec<&str> = manifest["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["fragments", "fragments/a.md", "fragments/b.md", "notes", "notes/c.md"]);
    let fetched = body_json(
        h.send(
            h.browser(Method::POST, "/api/sync/fetch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "paths": ["notes/c.md", "notes/none.md"] }).to_string()))
                .unwrap(),
        )
        .await,
    )
    .await;
    assert_eq!(fetched["items"][0]["data"], STANDARD.encode("notes/c.md"));
    assert_eq!(fetched["items"][1]["missing"], true);
}

/// 读 SSE 流直到出现 `needle`。
async fn read_until(needle: &str, body: &mut Body, text: &mut String) {
    while !text.contains(needle) {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame()).await.expect("SSE 超时").unwrap().unwrap();
        if let Some(data) = frame.data_ref() {
            text.push_str(&String::from_utf8_lossy(data));
        }
    }
}

#[tokio::test]
async fn events_replay_from_the_cursor_and_then_stream_live_changes() {
    let h = Harness::new().await;
    h.rpc("put_file", Some("before"), json!({ "path": "notes/old.md", "base64": STANDARD.encode("x") })).await;

    let response = h.send(h.browser(Method::GET, "/api/events?since=0").body(Body::empty()).unwrap()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let mut text = String::new();
    // 第一块就是注释：代理立即转发响应头，客户端马上知道已连上。
    read_until(": connected", &mut body, &mut text).await;
    assert!(text.starts_with(": connected"), "{text}");
    read_until("notes/old.md", &mut body, &mut text).await;
    assert!(text.contains("event: vault-changed"));

    h.rpc("put_file", Some("after"), json!({ "path": "notes/new.md", "base64": STANDARD.encode("y") })).await;
    read_until("notes/new.md", &mut body, &mut text).await;
}

#[tokio::test]
async fn device_pairing_issues_a_revocable_token() {
    let h = Harness::new().await;
    let start = h
        .send(
            Request::post("/api/device/start")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "name": "我的 Mac", "kind": "desktop" }).to_string()))
                .unwrap(),
        )
        .await;
    let start = body_json(start).await;
    let device_code = start["deviceCode"].as_str().unwrap().to_string();
    let poll = || {
        Request::post("/api/device/token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "deviceCode": device_code }).to_string()))
            .unwrap()
    };
    assert_eq!(h.send(poll()).await.status(), StatusCode::PRECONDITION_REQUIRED);

    let wrong = h
        .send(
            h.browser(Method::POST, "/api/device/approve")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "userCode": "AAAA-AAAA" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
    let approve = h
        .send(
            h.browser(Method::POST, "/api/device/approve")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "userCode": start["userCode"].as_str().unwrap().to_lowercase() }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(approve.status(), StatusCode::OK);

    let issued = body_json(h.send(poll()).await).await;
    let token = issued["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("shd_dev_"));
    // 只能换一次。
    assert_eq!(h.send(poll()).await.status(), StatusCode::GONE);

    let with_token = |token: &str| {
        Request::post("/api/rpc/server_status")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    // 设备令牌不需要 CSRF 头。
    assert_eq!(h.send(with_token(&token)).await.status(), StatusCode::OK);
    // 设备不能做敏感操作。
    let device_id = issued["deviceId"].as_str().unwrap().to_string();
    let as_device = h
        .send(
            Request::delete(format!("/api/devices/{device_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(as_device.status(), StatusCode::FORBIDDEN);

    let revoke = h.send(h.browser(Method::DELETE, &format!("/api/devices/{device_id}")).body(Body::empty()).unwrap()).await;
    assert_eq!(revoke.status(), StatusCode::OK);
    assert_eq!(h.send(with_token(&token)).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_revokes_the_session() {
    let h = Harness::new().await;
    let out = h.send(h.browser(Method::POST, "/api/auth/logout").body(Body::empty()).unwrap()).await;
    assert_eq!(out.status(), StatusCode::OK);
    assert!(out.headers()[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));
    let after = h.send(h.browser(Method::POST, "/api/rpc/server_status").body(Body::empty()).unwrap()).await;
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
}
