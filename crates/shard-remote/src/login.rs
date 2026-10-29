//! 桌面与命令行登录，与界面无关：`POST /api/device/login {email, password, name, kind}` 用邮箱密码换一枚
//! 设备令牌（`shd_dev_…`）。令牌只在这台机器上，服务器只存哈希，可在网页「设置 → 设备」里单独吊销。
//!
//! 只发一次、不自动重试：重试可能在服务器上多登记一台设备，密码也不该被自动重放；网络失败交给用户重来。
//! 「只能在终端里运行」「切换服务器要确认」这些交互策略由调用方决定；令牌拿到后怎么存也由调用方决定
//! （一般是 [`crate::CredentialStore::save_token`] 再 `save_config`）。

use crate::{
    client::{agent, post_json},
    server::{normalize_server, ServerAddressError},
};
use serde_json::{json, Value};
use std::fmt;

/// 登录参数。
#[derive(Clone, Copy)]
pub struct LoginRequest<'a> {
    pub email: &'a str,
    pub password: &'a str,
    /// 网页「设置 → 设备」里显示的名字。
    pub name: &'a str,
    /// 设备种类：`cli` 或 `desktop`（服务器只认这两种）。
    pub kind: &'a str,
}

impl fmt::Debug for LoginRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginRequest")
            .field("email", &self.email)
            .field("password", &"<redacted>")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .finish()
    }
}

/// 登录失败。`Display` 是给人看的一句话（通用文案，不提具体命令）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginError {
    /// 服务器地址不可用。
    InvalidServer(ServerAddressError),
    /// 连不上服务器（附原因）。
    Unreachable(String),
    /// 200 但响应不是 JSON 对象：地址可能不是 Shard 服务器。
    NotJson,
    /// 401：邮箱或密码不对（附服务器的说明）。
    WrongCredentials(String),
    /// 409：服务器还没设置账号。
    SetupRequired(String),
    /// 429：尝试太频繁，或全站密码错误太多暂停了登录。
    RateLimited(String),
    /// 其他拒绝（附服务器给的说明，没有时是「服务器返回 HTTP <状态码>」）。
    Rejected(String),
    /// 200 但没有返回令牌。
    MissingToken,
}

impl fmt::Display for LoginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidServer(error) => error.fmt(f),
            Self::Unreachable(reason) => write!(f, "连不上服务器（{reason}）"),
            Self::NotJson => f.write_str("服务器的响应不是 JSON，它可能不是 Shard 服务器"),
            Self::WrongCredentials(message)
            | Self::SetupRequired(message)
            | Self::RateLimited(message)
            | Self::Rejected(message) => f.write_str(message),
            Self::MissingToken => f.write_str("服务器没有返回设备令牌"),
        }
    }
}

impl std::error::Error for LoginError {}

/// 登录拿到的设备凭据。
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceCredentials {
    /// 规范化的站点地址。
    pub server: String,
    /// 设备令牌（`shd_dev_…`），只存本机，服务器只存哈希。
    pub token: String,
    /// 服务器分配的设备 id（服务器没给时为空）。
    pub device_id: String,
    /// 服务器记下的设备名（服务器没给时是请求里的名字）。
    pub name: String,
}

impl fmt::Debug for DeviceCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceCredentials")
            .field("server", &self.server)
            .field("token", &"<redacted>")
            .field("device_id", &self.device_id)
            .field("name", &self.name)
            .finish()
    }
}

/// 用邮箱密码登录。`server` 按 [`normalize_server`] 核对；`user_agent` 是请求头 `User-Agent`。
pub fn login_device(server: &str, request: LoginRequest<'_>, user_agent: &str) -> Result<DeviceCredentials, LoginError> {
    let server = normalize_server(server).map_err(LoginError::InvalidServer)?;
    let body = json!({ "email": request.email, "password": request.password, "name": request.name, "kind": request.kind });
    let (status, text) =
        post_json(&agent(user_agent), &format!("{server}/api/device/login"), &[], &body).map_err(LoginError::Unreachable)?;
    if status != 200 {
        return Err(rejection(status, &text));
    }
    let issued = match serde_json::from_str::<Value>(&text) {
        Ok(body) if body.is_object() => body,
        _ => return Err(LoginError::NotJson),
    };
    let token = issued["token"].as_str().filter(|token| !token.is_empty()).ok_or(LoginError::MissingToken)?;
    Ok(DeviceCredentials {
        server,
        token: token.to_string(),
        device_id: issued["deviceId"].as_str().unwrap_or_default().to_string(),
        name: issued["name"].as_str().unwrap_or(request.name).to_string(),
    })
}

/// 错误响应：按状态码分类，说明取服务器给的 `message`。
fn rejection(status: u16, text: &str) -> LoginError {
    let body = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let message = body["message"].as_str().map(str::to_string);
    match status {
        401 => LoginError::WrongCredentials(message.unwrap_or_else(|| "邮箱或密码不对。".to_string())),
        409 => LoginError::SetupRequired(message.unwrap_or_else(|| "服务器还没有设置账号。".to_string())),
        429 => LoginError::RateLimited(message.unwrap_or_else(|| "尝试太频繁，请稍后再试。".to_string())),
        _ => LoginError::Rejected(message.unwrap_or_else(|| format!("服务器返回 HTTP {status}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{fake_server, Reply};

    fn request<'a>(password: &'a str) -> LoginRequest<'a> {
        LoginRequest { email: "me@example.com", password, name: "我的电脑", kind: "desktop" }
    }

    #[test]
    fn logs_in_with_email_and_password_and_returns_the_device_token() {
        let server = fake_server(|request| {
            assert_eq!(request.path, "/api/device/login");
            assert_eq!(
                request.json(),
                json!({ "email": "me@example.com", "password": "correct horse battery", "name": "我的电脑", "kind": "desktop" })
            );
            assert_eq!(request.header("user-agent"), Some("shard-desktop/9"));
            Reply::json(200, &json!({ "token": "shd_dev_fake", "deviceId": "dev_fake", "name": "服务器记的名字" }))
        });
        let credentials = login_device(&format!("{server}/"), request("correct horse battery"), "shard-desktop/9").unwrap();
        assert_eq!(
            credentials,
            DeviceCredentials {
                server: server.clone(),
                token: "shd_dev_fake".into(),
                device_id: "dev_fake".into(),
                name: "服务器记的名字".into(),
            }
        );
        assert!(!format!("{credentials:?}").contains("shd_dev_fake"), "Debug 不打印令牌");
        assert!(!format!("{:?}", request("correct horse battery")).contains("correct horse"), "Debug 不打印密码");

        let unnamed = fake_server(|_| Reply::json(200, &json!({ "token": "shd_dev_t" })));
        let fallback = login_device(&unnamed, request("p"), "t").unwrap();
        assert_eq!((fallback.device_id.as_str(), fallback.name.as_str()), ("", "我的电脑"));
    }

    #[test]
    fn failures_are_typed_and_carry_the_server_message() {
        let reply = |status: u16, body: Value| {
            let server = fake_server(move |_| Reply::json(status, &body));
            login_device(&server, request("p"), "t").unwrap_err()
        };
        assert_eq!(
            reply(401, json!({ "code": "INVALID_CREDENTIALS", "message": "邮箱或密码不对。" })),
            LoginError::WrongCredentials("邮箱或密码不对。".into())
        );
        assert_eq!(
            reply(409, json!({ "code": "SETUP_REQUIRED", "message": "还没有设置账号。" })),
            LoginError::SetupRequired("还没有设置账号。".into())
        );
        assert_eq!(reply(429, json!({ "message": "太频繁了" })), LoginError::RateLimited("太频繁了".into()));
        assert_eq!(reply(400, json!({ "message": "kind 只能是 desktop 或 cli。" })), LoginError::Rejected("kind 只能是 desktop 或 cli。".into()));
        assert_eq!(reply(200, json!({ "deviceId": "x" })), LoginError::MissingToken);
        assert_eq!(reply(200, json!({ "token": "" })), LoginError::MissingToken);

        let html = fake_server(|_| Reply::status(200, "<html></html>"));
        assert_eq!(login_device(&html, request("p"), "t").unwrap_err(), LoginError::NotJson);
        let bare = fake_server(|_| Reply::status(500, "oops"));
        assert_eq!(login_device(&bare, request("p"), "t").unwrap_err(), LoginError::Rejected("服务器返回 HTTP 500".into()));
        assert_eq!(
            login_device("http://shard.example.com", request("p"), "t").unwrap_err(),
            LoginError::InvalidServer(ServerAddressError::InsecureHttp)
        );
        assert!(matches!(login_device("http://127.0.0.1:9", request("p"), "t").unwrap_err(), LoginError::Unreachable(_)));
    }

    #[test]
    fn network_failures_are_not_retried() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = std::sync::Arc::clone(&calls);
        let server = fake_server(move |_| {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Reply::Drop
        });
        assert!(matches!(login_device(&server, request("p"), "t").unwrap_err(), LoginError::Unreachable(_)));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
