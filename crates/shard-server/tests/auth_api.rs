//! 邮箱密码登录的 HTTP 测试：首次设置与重置链接、登录、再次输入密码、改邮箱密码、桌面与命令行登录、限流。
//! 走真实端点，不需要 `test-auth` 特性。

use axum::{
    body::Body,
    http::{header, HeaderMap, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shard_server::{app, config::Config, rpc::base_registry, state::AppState};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:18790";
const EMAIL: &str = "me@example.com";
const PASSWORD: &str = "correct horse battery";

struct Harness {
    _dir: tempfile::TempDir,
    state: AppState,
    app: Router,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Reply {
    /// `Set-Cookie` 里的 `name=value`。
    fn cookie(&self) -> String {
        self.headers[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string()
    }
}

impl Harness {
    /// 信任 `X-Forwarded-For`（测试里没有真实对端地址），限流按测试给的 IP 算。
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::new(dir.path().to_path_buf(), ORIGIN, None, true).unwrap();
        let state = AppState::open(config, base_registry()).unwrap();
        let app = app::build(state.clone());
        Self { _dir: dir, state, app }
    }

    /// 已设置好账号（邮箱 EMAIL、密码 PASSWORD）。
    async fn with_account() -> Self {
        let h = Self::new();
        let token = h.link("setup");
        let reply = h.setup(&token, EMAIL, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        h
    }

    fn link(&self, purpose: &str) -> String {
        let token = format!("token-{purpose}-{}", rand_suffix());
        self.state.auth.create_setup_token(&token, purpose).unwrap();
        token
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    /// 浏览器请求：带 CSRF 头；`cookie` 为空表示未登录。
    async fn browser(&self, method: Method, uri: &str, cookie: &str, ip: &str, body: Option<Value>) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-shard-request", "1")
            .header(header::ORIGIN, ORIGIN)
            .header("sec-fetch-site", "same-origin")
            .header("x-forwarded-for", ip);
        if !cookie.is_empty() {
            request = request.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        self.send(request.body(body).unwrap()).await
    }

    async fn state_of(&self, cookie: &str) -> Value {
        self.browser(Method::GET, "/api/auth/state", cookie, "198.51.100.1", None).await.body
    }

    async fn setup(&self, token: &str, email: &str, password: &str) -> Reply {
        let body = json!({ "token": token, "email": email, "password": password });
        self.browser(Method::POST, "/api/auth/setup", "", "198.51.100.1", Some(body)).await
    }

    async fn login_from(&self, ip: &str, email: &str, password: &str) -> Reply {
        let body = json!({ "email": email, "password": password });
        self.browser(Method::POST, "/api/auth/login", "", ip, Some(body)).await
    }

    async fn login(&self, email: &str, password: &str) -> Reply {
        self.login_from("198.51.100.1", email, password).await
    }

    async fn signed_in(&self) -> String {
        let reply = self.login(EMAIL, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.cookie()
    }

    async fn status_with(&self, cookie: &str) -> StatusCode {
        self.browser(Method::POST, "/api/rpc/server_status", cookie, "198.51.100.1", None).await.status
    }

    async fn device_login(&self, email: &str, password: &str, kind: &str) -> Reply {
        let body = json!({ "email": email, "password": password, "name": "我的 Mac", "kind": kind });
        let request = Request::post("/api/device/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "198.51.100.9")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn with_device(&self, method: Method, uri: &str, token: &str) -> StatusCode {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        self.send(request).await.status
    }
}

fn rand_suffix() -> String {
    shard_server::auth::tokens::random_token()
}

#[tokio::test]
async fn the_setup_link_creates_the_account_and_signs_in_once() {
    let h = Harness::new();
    assert_eq!(h.state_of("").await["setupRequired"], true);
    // 还没有账号时登录：提示先设置。
    assert_eq!(h.login(EMAIL, PASSWORD).await.status, StatusCode::CONFLICT);

    let check = |token: &str| {
        let body = json!({ "token": token });
        h.browser(Method::POST, "/api/auth/setup/check", "", "198.51.100.1", Some(body))
    };
    assert_eq!(check("nope").await.status, StatusCode::FORBIDDEN);
    let token = h.link("setup");
    let checked = check(&token).await;
    assert_eq!(checked.body, json!({ "purpose": "setup", "email": null }));

    assert_eq!(h.setup(&token, "not-an-email", PASSWORD).await.body["code"], "INVALID_EMAIL");
    assert_eq!(h.setup(&token, EMAIL, "too-short").await.body["code"], "WEAK_PASSWORD");
    // 校验没过不消耗链接。
    let done = h.setup(&token, "  Me@Example.COM ", PASSWORD).await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    let cookie = done.cookie();
    let state = h.state_of(&cookie).await;
    assert_eq!((state["authenticated"].clone(), state["setupRequired"].clone()), (json!(true), json!(false)));
    assert_eq!(state["email"], EMAIL, "邮箱去空白、转小写保存");
    assert_eq!(h.state_of("").await["email"], Value::Null, "没登录不显示邮箱");

    // 只能用一次；有了账号之后，新的首次设置链接也不能用（忘记密码走重置链接）。
    assert_eq!(h.setup(&token, EMAIL, "another long password").await.status, StatusCode::FORBIDDEN);
    let late = h.link("setup");
    assert_eq!(check(&late).await.status, StatusCode::FORBIDDEN);
    assert_eq!(h.setup(&late, "evil@example.com", "another long password").await.status, StatusCode::FORBIDDEN);
    assert_eq!(h.login(EMAIL, PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn login_needs_the_right_email_and_password() {
    let h = Harness::with_account().await;
    let wrong_password = h.login(EMAIL, "correct horse battery!").await;
    assert_eq!(wrong_password.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_password.body["code"], "INVALID_CREDENTIALS");
    let wrong_email = h.login("you@example.com", PASSWORD).await;
    assert_eq!(wrong_email.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_email.body["message"], wrong_password.body["message"], "不提示是邮箱还是密码不对");

    let ok = h.login(" ME@example.com", PASSWORD).await;
    assert_eq!(ok.status, StatusCode::OK);
    let cookie = ok.cookie();
    assert!(cookie.starts_with("shard_session="));
    assert_eq!(h.status_with(&cookie).await, StatusCode::OK);
    // 登录本身算一次输入密码。
    assert_eq!(h.state_of(&cookie).await["stepUpValid"], true);

    // 登录也要过 CSRF 校验（防登录 CSRF）。
    let forged = h
        .send(
            Request::post("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "email": EMAIL, "password": PASSWORD }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(forged.status, StatusCode::FORBIDDEN);

    let events: Vec<String> = h.state.auth.recent_audit(20).unwrap().into_iter().map(|row| row.2).collect();
    assert_eq!(events.iter().filter(|event| *event == "login.failure").count(), 2, "{events:?}");
    assert!(events.contains(&"login.success".to_string()));
}

#[tokio::test]
async fn step_up_takes_the_password_again() {
    let h = Harness::with_account().await;
    let cookie = h.signed_in().await;
    let wrong = h.browser(Method::POST, "/api/auth/stepup", &cookie, "198.51.100.1", Some(json!({ "password": "nope" }))).await;
    assert_eq!((wrong.status, wrong.body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("INVALID_CREDENTIALS")));
    let right = h.browser(Method::POST, "/api/auth/stepup", &cookie, "198.51.100.1", Some(json!({ "password": PASSWORD }))).await;
    assert_eq!(right.status, StatusCode::OK);
    // 没登录不能用。
    let anonymous = h.browser(Method::POST, "/api/auth/stepup", "", "198.51.100.1", Some(json!({ "password": PASSWORD }))).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn changing_the_password_signs_out_the_other_browsers() {
    let h = Harness::with_account().await;
    let here = h.signed_in().await;
    let elsewhere = h.signed_in().await;
    let change = |body: Value| h.browser(Method::POST, "/api/auth/account", &here, "198.51.100.1", Some(body));

    let wrong = change(json!({ "currentPassword": "nope", "email": EMAIL, "newPassword": "a brand new password" })).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let weak = change(json!({ "currentPassword": PASSWORD, "email": EMAIL, "newPassword": "short" })).await;
    assert_eq!(weak.body["code"], "WEAK_PASSWORD");

    // 只改邮箱：其他会话不受影响。
    let email_only = change(json!({ "currentPassword": PASSWORD, "email": "New@Example.com" })).await;
    assert_eq!(email_only.status, StatusCode::OK, "{}", email_only.body);
    assert_eq!(h.status_with(&elsewhere).await, StatusCode::OK);
    assert_eq!(h.login(EMAIL, PASSWORD).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.login("new@example.com", PASSWORD).await.status, StatusCode::OK);

    let changed = change(json!({ "currentPassword": PASSWORD, "email": "new@example.com", "newPassword": "a brand new password" })).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);
    assert_eq!(h.status_with(&here).await, StatusCode::OK, "当前会话保留");
    assert_eq!(h.status_with(&elsewhere).await, StatusCode::UNAUTHORIZED, "其他浏览器退出登录");
    assert_eq!(h.login("new@example.com", PASSWORD).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.login("new@example.com", "a brand new password").await.status, StatusCode::OK);
}

#[tokio::test]
async fn the_reset_link_replaces_the_password_and_signs_out_every_browser() {
    let h = Harness::with_account().await;
    let before = h.signed_in().await;
    let device = h.device_login(EMAIL, PASSWORD, "cli").await.body["token"].as_str().unwrap().to_string();

    let token = h.link("reset");
    let checked = h.browser(Method::POST, "/api/auth/setup/check", "", "198.51.100.1", Some(json!({ "token": token }))).await;
    assert_eq!(checked.body, json!({ "purpose": "reset", "email": EMAIL }), "重置时预填当前邮箱");
    let reset = h.setup(&token, EMAIL, "remembered this one").await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.body);
    assert_eq!(h.status_with(&reset.cookie()).await, StatusCode::OK);
    assert_eq!(h.status_with(&before).await, StatusCode::UNAUTHORIZED);
    // 设备令牌不受影响（要一并吊销时在服务器上加 --revoke-all）。
    assert_eq!(h.with_device(Method::POST, "/api/rpc/server_status", &device).await, StatusCode::OK);
    assert_eq!(h.login(EMAIL, PASSWORD).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.login(EMAIL, "remembered this one").await.status, StatusCode::OK);
}

#[tokio::test]
async fn desktop_and_cli_trade_the_password_for_a_revocable_device_token() {
    let h = Harness::with_account().await;
    assert_eq!(h.device_login(EMAIL, "nope", "desktop").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.device_login(EMAIL, PASSWORD, "phone").await.status, StatusCode::BAD_REQUEST);

    let issued = h.device_login(EMAIL, PASSWORD, "desktop").await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
    assert_eq!(issued.body["name"], "我的 Mac");
    let token = issued.body["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("shd_dev_"));
    let device_id = issued.body["deviceId"].as_str().unwrap().to_string();

    // 设备令牌不需要 CSRF 头，但不能做敏感操作。
    assert_eq!(h.with_device(Method::POST, "/api/rpc/server_status", &token).await, StatusCode::OK);
    assert_eq!(h.with_device(Method::DELETE, &format!("/api/devices/{device_id}"), &token).await, StatusCode::FORBIDDEN);

    let cookie = h.signed_in().await;
    let devices = h.browser(Method::GET, "/api/devices", &cookie, "198.51.100.1", None).await;
    assert_eq!(devices.body["devices"][0]["kind"], "desktop");
    let revoked = h.browser(Method::DELETE, &format!("/api/devices/{device_id}"), &cookie, "198.51.100.1", None).await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(h.with_device(Method::POST, "/api/rpc/server_status", &token).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn guessing_is_limited_per_ip_and_across_the_whole_site() {
    let h = Harness::with_account().await;
    // 每个 IP 每分钟 10 次。
    for _ in 0..10 {
        assert_eq!(h.login_from("203.0.113.1", EMAIL, "wrong password").await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(h.login_from("203.0.113.1", EMAIL, PASSWORD).await.status, StatusCode::TOO_MANY_REQUESTS);

    // 换 IP 也绕不过全站每小时 50 次密码错误：用完后连正确密码也暂停。
    for index in 0..40 {
        let ip = format!("203.0.113.{}", 10 + index / 8);
        assert_eq!(h.login_from(&ip, EMAIL, "wrong password").await.status, StatusCode::UNAUTHORIZED);
    }
    let locked = h.login_from("203.0.113.200", EMAIL, PASSWORD).await;
    assert_eq!(locked.status, StatusCode::TOO_MANY_REQUESTS, "{}", locked.body);
    assert_eq!(h.device_login(EMAIL, PASSWORD, "cli").await.status, StatusCode::TOO_MANY_REQUESTS);
}
