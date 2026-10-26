//! 设备配对（RFC 8628 式），与界面无关：
//!
//! 1. [`start_pairing`]：`POST /api/device/start {name, kind}`，拿到配对码与验证地址；调用方把它们显示给用户，
//!    用户在浏览器 `<服务器>/pair` 输入配对码并用通行密钥批准。
//! 2. 轮询 `POST /api/device/token` 换设备令牌：[`Pairing::wait`] 阻塞到拿到令牌或失败；要自己控制节奏
//!    （可取消、显示进度）时，按 [`Pairing::interval`] 等待后调 [`Pairing::poll_once`]，并用 [`Pairing::is_expired`] 判断过期。
//!
//! 轮询规则：428 继续等；429 间隔加 2 秒；网络失败或 502/503/504（服务重启）间隔翻倍（最多 30 秒），
//! 连续 10 次就放弃；410 表示过期或被拒绝；其余错误原样报出。
//!
//! 「只能在终端里运行」「切换服务器要确认」这些交互策略由调用方决定；令牌拿到后怎么存也由调用方决定
//! （一般是 [`crate::CredentialStore::save_token`] 再 `save_config`）。

use crate::{
    client::{agent, post_json},
    server::{normalize_server, ServerAddressError},
};
use serde_json::{json, Value};
use std::{
    fmt, thread,
    time::{Duration, Instant},
};

/// 连续这么多次网络失败或网关不可用就放弃。
const MAX_FAILURES: u32 = 10;
/// 退避的间隔上限。
const MAX_INTERVAL: Duration = Duration::from_secs(30);
/// 429 时每次加的间隔。
const SLOW_DOWN: Duration = Duration::from_secs(2);
/// 本地的有效期比服务器给的多留几秒，免得最后一次轮询被本地提前截断。
const DEADLINE_GRACE_SECS: u64 = 5;

/// 发起配对的参数。
#[derive(Debug, Clone, Copy)]
pub struct PairingRequest<'a> {
    /// 网页「设置 → 设备」里显示的名字。
    pub name: &'a str,
    /// 设备种类：`cli` 或 `desktop`（服务器只认这两种）。
    pub kind: &'a str,
}

/// 配对失败。`Display` 是给人看的一句话（通用文案，不提具体命令）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    /// 服务器地址不可用。
    InvalidServer(ServerAddressError),
    /// 连不上服务器：发起时网络失败，或轮询时连续 10 次网络失败 / 网关不可用（附最后一次的原因）。
    Unreachable(String),
    /// 200 但响应不是 JSON 对象：地址可能不是 Shard 服务器。
    NotJson,
    /// 发起配对的响应缺这个字段：地址可能不是 Shard 服务器。
    MissingField(&'static str),
    /// 服务器拒绝（附服务器给的说明，没有时是「服务器返回 HTTP <状态码>」）。
    Rejected(String),
    /// 410：配对已过期或被拒绝。
    Gone,
    /// 本地等到有效期结束仍未批准。
    Expired,
    /// 200 但没有返回令牌。
    MissingToken,
}

impl fmt::Display for PairingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidServer(error) => error.fmt(f),
            Self::Unreachable(reason) => write!(f, "连不上服务器（{reason}）"),
            Self::NotJson => f.write_str("服务器的响应不是 JSON，它可能不是 Shard 服务器"),
            Self::MissingField(key) => write!(f, "配对响应缺少 {key}，它可能不是 Shard 服务器"),
            Self::Rejected(message) => write!(f, "配对失败：{message}"),
            Self::Gone => f.write_str("配对已过期或被拒绝"),
            Self::Expired => f.write_str("配对已过期"),
            Self::MissingToken => f.write_str("服务器没有返回设备令牌"),
        }
    }
}

impl std::error::Error for PairingError {}

/// 配对成功拿到的设备凭据。
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceCredentials {
    /// 规范化的站点地址。
    pub server: String,
    /// 设备令牌（`shd_dev_…`），只存本机，服务器只存哈希。
    pub token: String,
    /// 服务器分配的设备 id（服务器没给时为空）。
    pub device_id: String,
    /// 服务器记下的设备名（服务器没给时是发起时的名字）。
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

/// 一次轮询的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollStatus {
    /// 还没批准（或暂时连不上、被限速）：按 [`Pairing::interval`] 等待后再轮询。
    Pending,
    Issued(DeviceCredentials),
}

/// 进行中的配对。
pub struct Pairing {
    server: String,
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    name: String,
    interval: Duration,
    deadline: Instant,
    failures: u32,
    agent: ureq::Agent,
}

impl fmt::Debug for Pairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pairing")
            .field("server", &self.server)
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .field("failures", &self.failures)
            .finish_non_exhaustive()
    }
}

/// 发起配对。`server` 按 [`normalize_server`] 核对；`user_agent` 是请求头 `User-Agent`。
pub fn start_pairing(server: &str, request: PairingRequest<'_>, user_agent: &str) -> Result<Pairing, PairingError> {
    let server = normalize_server(server).map_err(PairingError::InvalidServer)?;
    let agent = agent(user_agent);
    let (status, text) = post_json(
        &agent,
        &format!("{server}/api/device/start"),
        &[],
        &json!({ "name": request.name, "kind": request.kind }),
    )
    .map_err(PairingError::Unreachable)?;
    let start = response_json(status, &text)?;
    let field = |key: &'static str| start[key].as_str().map(str::to_string).ok_or(PairingError::MissingField(key));
    let device_code = field("deviceCode")?;
    let user_code = field("userCode")?;
    let verification_uri = field("verificationUri")?;
    let expires_in = start["expiresIn"].as_u64().unwrap_or(600);
    let interval = Duration::from_secs(start["interval"].as_u64().unwrap_or(3).clamp(1, 30));
    Ok(Pairing {
        server,
        device_code,
        user_code,
        verification_uri,
        expires_in,
        name: request.name.to_string(),
        interval,
        deadline: deadline(expires_in),
        failures: 0,
        agent,
    })
}

fn deadline(expires_in: u64) -> Instant {
    let now = Instant::now();
    now.checked_add(Duration::from_secs(expires_in.saturating_add(DEADLINE_GRACE_SECS)))
        .unwrap_or(now + Duration::from_secs(86_400))
}

impl Pairing {
    /// 规范化的站点地址。
    pub fn server(&self) -> &str {
        &self.server
    }

    /// 给用户看的配对码（形如 `ABCD-EFGH`）。
    pub fn user_code(&self) -> &str {
        &self.user_code
    }

    /// 用户输入配对码的网页地址（`<服务器>/pair`）。
    pub fn verification_uri(&self) -> &str {
        &self.verification_uri
    }

    /// 服务器给的有效期（秒）。
    pub fn expires_in(&self) -> u64 {
        self.expires_in
    }

    /// 下一次轮询前应等待的时间（服务器建议值 1–30 秒，随退避变化）。
    pub fn interval(&self) -> Duration {
        self.interval
    }

    /// 改轮询间隔（测试用来缩短等待；之后的退避在它的基础上算）。
    pub fn set_interval(&mut self, interval: Duration) {
        self.interval = interval;
    }

    /// 已过本地有效期（服务器有效期 + 5 秒）。
    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// 立即轮询一次（不等待），并按结果调整之后的间隔。
    pub fn poll_once(&mut self) -> Result<PollStatus, PairingError> {
        let polled = post_json(
            &self.agent,
            &format!("{}/api/device/token", self.server),
            &[],
            &json!({ "deviceCode": self.device_code }),
        );
        self.handle(polled)
    }

    /// 阻塞轮询，直到拿到令牌、被拒绝、过期或一直连不上。
    pub fn wait(&mut self) -> Result<DeviceCredentials, PairingError> {
        loop {
            if self.is_expired() {
                return Err(PairingError::Expired);
            }
            thread::sleep(self.interval);
            if let PollStatus::Issued(credentials) = self.poll_once()? {
                return Ok(credentials);
            }
        }
    }

    /// 一次轮询的响应 → 结果与新的间隔。
    fn handle(&mut self, polled: Result<(u16, String), String>) -> Result<PollStatus, PairingError> {
        // 网络抖动或网关临时不可用（服务重启）：配对码还有效，退避后再试；一直不行就放弃。
        let (status, text) = match polled {
            Ok((status @ 502..=504, _)) => return self.failed(format!("服务器暂时不可用（HTTP {status}）")),
            Err(reason) => return self.failed(reason),
            Ok(response) => response,
        };
        self.failures = 0;
        match status {
            200 => {
                let issued = response_json(status, &text)?;
                let token = issued["token"]
                    .as_str()
                    .filter(|token| !token.is_empty())
                    .ok_or(PairingError::MissingToken)?;
                Ok(PollStatus::Issued(DeviceCredentials {
                    server: self.server.clone(),
                    token: token.to_string(),
                    device_id: issued["deviceId"].as_str().unwrap_or_default().to_string(),
                    name: issued["name"].as_str().unwrap_or(&self.name).to_string(),
                }))
            }
            428 => Ok(PollStatus::Pending),
            429 => {
                self.interval += SLOW_DOWN;
                Ok(PollStatus::Pending)
            }
            410 => Err(PairingError::Gone),
            _ => Err(rejection(status, &text)),
        }
    }

    fn failed(&mut self, reason: String) -> Result<PollStatus, PairingError> {
        self.failures += 1;
        if self.failures >= MAX_FAILURES {
            return Err(PairingError::Unreachable(reason));
        }
        self.interval = (self.interval * 2).min(MAX_INTERVAL);
        Ok(PollStatus::Pending)
    }
}

/// 200 时要求 JSON 对象；其余状态码一律是错误。
fn response_json(status: u16, text: &str) -> Result<Value, PairingError> {
    if status != 200 {
        return Err(rejection(status, text));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(body) if body.is_object() => Ok(body),
        _ => Err(PairingError::NotJson),
    }
}

/// 错误响应：说明取服务器给的 `message`。
fn rejection(status: u16, text: &str) -> PairingError {
    let body = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let message = body["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("服务器返回 HTTP {status}"));
    PairingError::Rejected(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{fake_server, Reply};
    use std::sync::{Arc, Mutex};

    fn pairing(interval: Duration) -> Pairing {
        Pairing {
            server: "https://shard.example.com".into(),
            device_code: "dc".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://shard.example.com/pair".into(),
            expires_in: 600,
            name: "请求的名字".into(),
            interval,
            deadline: deadline(600),
            failures: 0,
            agent: agent("test"),
        }
    }

    fn ok(status: u16, body: Value) -> Result<(u16, String), String> {
        Ok((status, body.to_string()))
    }

    #[test]
    fn gateway_and_network_failures_back_off_up_to_thirty_seconds() {
        let mut p = pairing(Duration::from_secs(3));
        let mut seen = Vec::new();
        for round in 0..9 {
            let polled = if round % 2 == 0 { Ok((503, String::new())) } else { Err("网络错误：断开".to_string()) };
            assert_eq!(p.handle(polled), Ok(PollStatus::Pending));
            seen.push(p.interval().as_secs());
        }
        assert_eq!(seen, [6, 12, 24, 30, 30, 30, 30, 30, 30]);
        // 第 10 次连续失败：放弃，带上最后一次的原因。
        assert_eq!(
            p.handle(Ok((502, String::new()))),
            Err(PairingError::Unreachable("服务器暂时不可用（HTTP 502）".into()))
        );

        // 中间有一次正常响应就重新计数（间隔不回落）。
        let mut p = pairing(Duration::from_millis(1));
        for _ in 0..9 {
            p.handle(Err("x".into())).unwrap();
        }
        assert_eq!(p.handle(ok(428, json!({ "code": "AUTHORIZATION_PENDING" }))), Ok(PollStatus::Pending));
        assert_eq!(p.interval(), Duration::from_millis(512));
        for _ in 0..9 {
            p.handle(Err("x".into())).unwrap();
        }
        assert_eq!(p.handle(Err("最后一次".into())), Err(PairingError::Unreachable("最后一次".into())));
    }

    #[test]
    fn pending_slow_down_gone_and_rejections() {
        let mut p = pairing(Duration::from_secs(3));
        assert_eq!(p.handle(ok(428, json!({}))), Ok(PollStatus::Pending));
        assert_eq!(p.interval(), Duration::from_secs(3), "428 不改间隔");
        assert_eq!(p.handle(ok(429, json!({}))), Ok(PollStatus::Pending));
        assert_eq!(p.handle(ok(429, json!({}))), Ok(PollStatus::Pending));
        assert_eq!(p.interval(), Duration::from_secs(7), "429 每次加 2 秒");
        assert_eq!(p.handle(ok(410, json!({ "message": "配对已过期，请重新开始。" }))), Err(PairingError::Gone));
        assert_eq!(
            p.handle(ok(400, json!({ "message": "kind 只能是 desktop 或 cli。" }))),
            Err(PairingError::Rejected("kind 只能是 desktop 或 cli。".into()))
        );
        assert_eq!(p.handle(Ok((500, "oops".into()))), Err(PairingError::Rejected("服务器返回 HTTP 500".into())));
    }

    #[test]
    fn issued_tokens_fall_back_to_the_requested_name() {
        let mut p = pairing(Duration::from_secs(3));
        let issued = p.handle(ok(200, json!({ "token": "shd_dev_t", "deviceId": "dev_1", "name": "服务器记的名字" })));
        assert_eq!(
            issued,
            Ok(PollStatus::Issued(DeviceCredentials {
                server: "https://shard.example.com".into(),
                token: "shd_dev_t".into(),
                device_id: "dev_1".into(),
                name: "服务器记的名字".into(),
            }))
        );
        let Ok(PollStatus::Issued(fallback)) = p.handle(ok(200, json!({ "token": "shd_dev_t" }))) else {
            panic!("应拿到令牌");
        };
        assert_eq!((fallback.device_id.as_str(), fallback.name.as_str()), ("", "请求的名字"));
        assert!(!format!("{fallback:?}").contains("shd_dev_t"), "Debug 不打印令牌");
        assert_eq!(p.handle(ok(200, json!({ "token": "" }))), Err(PairingError::MissingToken));
        assert_eq!(p.handle(ok(200, json!({ "deviceId": "x" }))), Err(PairingError::MissingToken));
        assert_eq!(p.handle(Ok((200, "<html>".into()))), Err(PairingError::NotJson));
    }

    #[test]
    fn expired_pairings_stop_without_polling() {
        let mut p = pairing(Duration::from_millis(1));
        p.deadline = Instant::now();
        assert!(p.is_expired());
        assert_eq!(p.wait(), Err(PairingError::Expired));
    }

    #[test]
    fn start_then_wait_through_gateway_errors() {
        let polls = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&polls);
        let server = fake_server(move |request| match request.path.as_str() {
            "/api/device/start" => {
                assert_eq!(request.json(), json!({ "name": "我的电脑", "kind": "desktop" }));
                assert_eq!(request.header("user-agent"), Some("shard-desktop/9"));
                Reply::json(
                    200,
                    &json!({ "deviceCode": "dc-1", "userCode": "ABCD-EFGH", "verificationUri": "http://127.0.0.1/pair", "expiresIn": 60, "interval": 1 }),
                )
            }
            "/api/device/token" => {
                let mut log = log.lock().unwrap();
                log.push(request.json());
                match log.len() {
                    1 => Reply::status(503, ""),
                    2 => Reply::Drop,
                    3 => Reply::json(428, &json!({ "code": "AUTHORIZATION_PENDING", "message": "等待" })),
                    _ => Reply::json(200, &json!({ "token": "shd_dev_fake", "deviceId": "dev_fake", "name": "我的电脑" })),
                }
            }
            _ => Reply::status(404, ""),
        });
        let mut pairing =
            start_pairing(&format!("{server}/"), PairingRequest { name: "我的电脑", kind: "desktop" }, "shard-desktop/9").unwrap();
        assert_eq!(pairing.server(), server);
        assert_eq!((pairing.user_code(), pairing.verification_uri()), ("ABCD-EFGH", "http://127.0.0.1/pair"));
        assert_eq!((pairing.expires_in(), pairing.interval()), (60, Duration::from_secs(1)));
        pairing.set_interval(Duration::from_millis(5));
        let credentials = pairing.wait().unwrap();
        assert_eq!(credentials.token, "shd_dev_fake");
        assert_eq!(credentials.device_id, "dev_fake");
        assert_eq!(credentials.server, server);
        let polls = polls.lock().unwrap();
        assert_eq!(polls.len(), 4);
        assert!(polls.iter().all(|body| body == &json!({ "deviceCode": "dc-1" })));
        assert_eq!(pairing.interval(), Duration::from_millis(20), "两次失败各翻倍一次");
    }

    #[test]
    fn start_errors_are_typed() {
        assert_eq!(
            start_pairing("http://shard.example.com", PairingRequest { name: "x", kind: "cli" }, "t").unwrap_err(),
            PairingError::InvalidServer(ServerAddressError::InsecureHttp)
        );
        let missing = fake_server(|_| Reply::json(200, &json!({ "deviceCode": "dc", "userCode": "U" })));
        assert_eq!(
            start_pairing(&missing, PairingRequest { name: "x", kind: "cli" }, "t").unwrap_err(),
            PairingError::MissingField("verificationUri")
        );
        let html = fake_server(|_| Reply::status(200, "<html></html>"));
        assert_eq!(start_pairing(&html, PairingRequest { name: "x", kind: "cli" }, "t").unwrap_err(), PairingError::NotJson);
        let limited = fake_server(|_| Reply::json(429, &json!({ "code": "RATE_LIMITED", "message": "太频繁了" })));
        assert_eq!(
            start_pairing(&limited, PairingRequest { name: "x", kind: "cli" }, "t").unwrap_err(),
            PairingError::Rejected("太频繁了".into())
        );
        assert!(matches!(
            start_pairing("http://127.0.0.1:9", PairingRequest { name: "x", kind: "cli" }, "t").unwrap_err(),
            PairingError::Unreachable(_)
        ));
        // 服务器建议的间隔夹在 1–30 秒。
        let slow = fake_server(|_| {
            Reply::json(200, &json!({ "deviceCode": "d", "userCode": "U", "verificationUri": "v", "interval": 99 }))
        });
        let pairing = start_pairing(&slow, PairingRequest { name: "x", kind: "cli" }, "t").unwrap();
        assert_eq!((pairing.interval(), pairing.expires_in()), (Duration::from_secs(30), 600));
    }
}
