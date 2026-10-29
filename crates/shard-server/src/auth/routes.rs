//! 认证相关端点：首次设置与重置、邮箱密码登录、再次输入密码（敏感操作）、退出、改邮箱密码、
//! 会话 / 设备管理、桌面与命令行登录。

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    db::{OwnerRow, SetupOutcome, SESSION_ABSOLUTE},
    password::{decoy_hash, hash_password, normalize_email, validate_password, verify_password},
    principal::{BrowserRequest, Caller, ClientMeta, MaybeCaller, Meta},
    tokens::{device_token, hex, random_id, random_token},
};
use crate::{error::ApiError, state::AppState};

/// 全站每小时最多这么多次密码错误（登录、再次输入、改密码、桌面命令行登录合计），用完就暂停，
/// 换 IP 分散猜测也绕不过去。代价是被人刷满时，新登录要等额度回来；已登录的会话与设备不受影响。
const PASSWORD_FAILURES_PER_HOUR: u32 = 50;

pub fn router() -> Router<AppState> {
    let router = Router::new()
        .route("/auth/state", get(auth_state))
        .route("/auth/setup/check", post(setup_check))
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/stepup", post(step_up))
        .route("/auth/logout", post(logout))
        .route("/auth/account", post(update_account))
        .route("/auth/sessions", get(list_sessions))
        .route("/auth/sessions/{id}", delete(revoke_session))
        .route("/auth/audit", get(audit_log))
        .route("/device/login", post(device_login))
        .route("/devices", get(list_devices))
        .route("/devices/{id}", delete(revoke_device));
    #[cfg(feature = "test-auth")]
    let router = router.route("/test/session", post(test_session)).route("/test/step-up", post(test_step_up));
    router
}

/// 同步的认证库调用放进阻塞线程池，别卡住异步执行器（argon2 每次几十毫秒也在这里算）。
async fn blocking<T, F>(state: &AppState, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, ApiError> + Send + 'static,
{
    let state = state.clone();
    tokio::task::spawn_blocking(move || f(&state)).await.map_err(ApiError::internal)?
}

fn limited(state: &AppState, scope: &str, meta: &ClientMeta, per_minute: u32) -> Result<(), ApiError> {
    let key = meta.ip.as_deref().unwrap_or("unknown");
    if state.limiter.check(scope, key, per_minute) {
        Ok(())
    } else {
        state.auth.audit("anonymous", &format!("{scope}.rate_limited"), meta.ip.as_deref(), meta.user_agent.as_deref(), None);
        Err(ApiError::too_many())
    }
}

fn audit(state: &AppState, actor: &str, event: &str, meta: &ClientMeta, detail: Option<&str>) {
    state.auth.audit(actor, event, meta.ip.as_deref(), meta.user_agent.as_deref(), detail);
}

fn with_cookie(body: Value, cookie: String) -> Response {
    let mut response = Json(body).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// 签发新会话并写 Cookie。
fn start_session(state: &AppState, meta: &ClientMeta, body: Value) -> Result<Response, ApiError> {
    let token = random_token();
    state.auth.create_session(&token, meta.ip.as_deref(), meta.user_agent.as_deref())?;
    Ok(with_cookie(body, state.config.session_cookie(&token, SESSION_ABSOLUTE.num_seconds())))
}

const FAILURE_WINDOW: Duration = Duration::from_secs(3600);

/// 核对密码。`email` 为 `None` 时只核对密码（已登录后的再次输入）；`actor` 是审计里记的操作者。
/// 全站失败额度用完时直接拒绝；核对失败记一次失败与审计。
fn check_password(
    state: &AppState,
    actor: &str,
    email: Option<&str>,
    password: &str,
    meta: &ClientMeta,
    failure_event: &str,
) -> Result<OwnerRow, ApiError> {
    if !state.limiter.available("password-failures", "all", PASSWORD_FAILURES_PER_HOUR, FAILURE_WINDOW) {
        audit(state, actor, &format!("{failure_event}.locked"), meta, None);
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "密码错误次数太多，已暂停登录，请过一会儿再试。",
        ));
    }
    let Some(owner) = state.auth.owner()? else {
        return Err(ApiError::new(StatusCode::CONFLICT, "SETUP_REQUIRED", "还没有设置账号。"));
    };
    let email_matches = email.is_none_or(|email| normalize_email(email).is_ok_and(|email| email == owner.email));
    // 邮箱不对也照样算一次哈希，响应时间不暴露邮箱对不对。
    let hash = if email_matches { owner.password_hash.as_str() } else { decoy_hash() };
    if verify_password(password, hash) && email_matches {
        return Ok(owner);
    }
    state.limiter.record("password-failures", "all", PASSWORD_FAILURES_PER_HOUR, FAILURE_WINDOW);
    audit(state, actor, failure_event, meta, None);
    Err(ApiError::invalid_credentials(if email.is_some() { "邮箱或密码不对。" } else { "密码不对。" }))
}

// ---------- 状态 ----------

async fn auth_state(State(state): State<AppState>, MaybeCaller(caller): MaybeCaller) -> Result<Json<Value>, ApiError> {
    let signed_in = caller.as_ref().is_some_and(|caller| caller.session_hash().is_some());
    let owner = blocking(&state, |state| Ok(state.auth.owner()?)).await?;
    let step_up_valid = caller.as_ref().map(|caller| caller.require_step_up().is_ok()).unwrap_or(false);
    Ok(Json(json!({
        "setupRequired": owner.is_none(),
        "authenticated": caller.is_some(),
        "stepUpValid": step_up_valid,
        "vaultId": state.vault_identity,
        "email": if signed_in { owner.map(|owner| owner.email) } else { None },
    })))
}

// ---------- 首次设置 / 重置密码 ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupCheck {
    token: String,
}

fn invalid_setup_token() -> ApiError {
    ApiError::forbidden("SETUP_TOKEN_INVALID", "链接无效、已过期或已经用过，请在服务器上重新生成。")
}

/// 打开链接时先看它能不能用、是设置还是重置（重置时预填当前邮箱）。不消耗令牌。
async fn setup_check(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<SetupCheck>,
) -> Result<Json<Value>, ApiError> {
    limited(&state, "setup", &meta, 10)?;
    blocking(&state, move |state| {
        let Some(purpose) = state.auth.peek_setup_token(&body.token)? else {
            audit(state, "anonymous", "setup.invalid_token", &meta, None);
            return Err(invalid_setup_token());
        };
        let owner = state.auth.owner()?;
        if purpose == "setup" && owner.is_some() {
            return Err(invalid_setup_token());
        }
        Ok(Json(json!({ "purpose": purpose, "email": owner.map(|owner| owner.email) })))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupBody {
    token: String,
    email: String,
    password: String,
}

async fn setup(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<SetupBody>,
) -> Result<Response, ApiError> {
    limited(&state, "setup", &meta, 10)?;
    let email = normalize_email(&body.email)?;
    validate_password(&body.password)?;
    blocking(&state, move |state| {
        let hash = hash_password(&body.password)?;
        match state.auth.complete_setup(&body.token, &email, &hash)? {
            SetupOutcome::Done(purpose) => {
                audit(state, "setup", &format!("{purpose}.completed"), &meta, None);
                start_session(state, &meta, json!({ "ok": true }))
            }
            SetupOutcome::InvalidToken => {
                audit(state, "anonymous", "setup.invalid_token", &meta, None);
                Err(invalid_setup_token())
            }
        }
    })
    .await
}

// ---------- 登录 ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<LoginBody>,
) -> Result<Response, ApiError> {
    limited(&state, "login", &meta, 10)?;
    blocking(&state, move |state| {
        check_password(state, "anonymous", Some(&body.email), &body.password, &meta, "login.failure")?;
        audit(state, "login", "login.success", &meta, None);
        start_session(state, &meta, json!({ "ok": true }))
    })
    .await
}

// ---------- 再次输入密码（敏感操作） ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepUpBody {
    password: String,
}

async fn step_up(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<StepUpBody>,
) -> Result<Json<Value>, ApiError> {
    let session = caller.require_session()?.to_vec();
    limited(&state, "stepup", &caller.meta, 10)?;
    blocking(&state, move |state| {
        check_password(state, &caller.actor(), None, &body.password, &caller.meta, "stepup.failure")?;
        state.auth.mark_step_up(&session)?;
        audit(state, &caller.actor(), "stepup.success", &caller.meta, None);
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

async fn logout(State(state): State<AppState>, caller: Caller) -> Result<Response, ApiError> {
    let session = caller.require_session()?.to_vec();
    blocking(&state, move |state| {
        state.auth.revoke_session(&session)?;
        audit(state, &caller.actor(), "session.logout", &caller.meta, None);
        Ok(with_cookie(json!({ "ok": true }), state.config.clear_cookie()))
    })
    .await
}

// ---------- 改邮箱与密码 ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountBody {
    current_password: String,
    email: String,
    #[serde(default)]
    new_password: Option<String>,
}

/// 凭当前密码改邮箱、密码。改了密码会让其他浏览器会话全部退出（当前会话保留）；设备令牌不受影响，
/// 怀疑泄露时到设备列表里逐个吊销。
async fn update_account(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<AccountBody>,
) -> Result<Json<Value>, ApiError> {
    let session = caller.require_session()?.to_vec();
    limited(&state, "stepup", &caller.meta, 10)?;
    let email = normalize_email(&body.email)?;
    let new_password = body.new_password.filter(|password| !password.is_empty());
    if let Some(password) = &new_password {
        validate_password(password)?;
    }
    blocking(&state, move |state| {
        let owner = check_password(state, &caller.actor(), None, &body.current_password, &caller.meta, "account.failure")?;
        let hash = match &new_password {
            Some(password) => hash_password(password)?,
            None => owner.password_hash,
        };
        state.auth.update_owner(&email, &hash)?;
        state.auth.mark_step_up(&session)?;
        if new_password.is_some() {
            let signed_out = state.auth.revoke_other_sessions(&session)?;
            audit(state, &caller.actor(), "password.changed", &caller.meta, Some(&format!("signed_out={signed_out}")));
        }
        if email != owner.email {
            audit(state, &caller.actor(), "email.changed", &caller.meta, None);
        }
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

// ---------- 会话管理 ----------

/// 会话对外的 id：哈希的前 16 位十六进制，足以区分且不泄露令牌。
fn session_public_id(id_hash: &[u8]) -> String {
    hex(id_hash)[..16].to_string()
}

async fn list_sessions(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    let current = caller.require_session()?.to_vec();
    blocking(&state, move |state| {
        let items = state
            .auth
            .active_sessions()?
            .into_iter()
            .map(|row| {
                json!({
                    "id": session_public_id(&row.id_hash),
                    "current": row.id_hash == current,
                    "createdAt": row.created_at.to_rfc3339(),
                    "lastSeenAt": row.last_seen_at.to_rfc3339(),
                    "userAgent": row.user_agent,
                    "ip": row.ip,
                })
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({ "sessions": items })))
    })
    .await
}

async fn revoke_session(State(state): State<AppState>, caller: Caller, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let current = caller.require_session()?.to_vec();
    let revoking_self = session_public_id(&current) == id;
    if !revoking_self {
        caller.require_step_up()?;
    }
    blocking(&state, move |state| {
        let target = state
            .auth
            .active_sessions()?
            .into_iter()
            .find(|row| session_public_id(&row.id_hash) == id)
            .ok_or_else(ApiError::not_found)?;
        state.auth.revoke_session(&target.id_hash)?;
        audit(state, &caller.actor(), "session.revoked", &caller.meta, Some(&id));
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

async fn audit_log(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    caller.require_session()?;
    blocking(&state, |state| {
        let items = state
            .auth
            .recent_audit(200)?
            .into_iter()
            .map(|(at, actor, event, ip, detail)| json!({ "at": at, "actor": actor, "event": event, "ip": ip, "detail": detail }))
            .collect::<Vec<_>>();
        Ok(Json(json!({ "events": items })))
    })
    .await
}

// ---------- 桌面与命令行登录 ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLogin {
    email: String,
    password: String,
    name: String,
    kind: String,
}

/// 桌面应用或命令行用邮箱密码换一枚设备令牌（`shd_dev_…`）。令牌只在那台机器上，服务器只存哈希，
/// 可在网页「设置 → 设备」里单独吊销。设备令牌不带 Cookie，不受 CSRF 影响。
async fn device_login(State(state): State<AppState>, Meta(meta): Meta, Json(body): Json<DeviceLogin>) -> Result<Json<Value>, ApiError> {
    limited(&state, "login", &meta, 10)?;
    if body.kind != "desktop" && body.kind != "cli" {
        return Err(ApiError::bad_request("kind 只能是 desktop 或 cli。"));
    }
    let name: String = body.name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Err(ApiError::bad_request("请给设备起个名字。"));
    }
    blocking(&state, move |state| {
        check_password(state, "anonymous", Some(&body.email), &body.password, &meta, "device.login_failure")?;
        let device_id = random_id("dev_");
        let token = device_token();
        state.auth.create_device(&device_id, &name, &body.kind, &token, "vault")?;
        audit(state, &format!("device:{device_id}"), "device.created", &meta, Some(&name));
        Ok(Json(json!({ "token": token, "deviceId": device_id, "name": name })))
    })
    .await
}

async fn list_devices(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    caller.require_session()?;
    blocking(&state, |state| {
        let items = state
            .auth
            .active_devices()?
            .into_iter()
            .map(|device| {
                json!({
                    "id": device.device_id,
                    "name": device.name,
                    "kind": device.kind,
                    "createdAt": device.created_at,
                    "lastSeenAt": device.last_seen_at,
                    "lastIp": device.last_ip,
                })
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({ "devices": items })))
    })
    .await
}

async fn revoke_device(State(state): State<AppState>, caller: Caller, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    caller.require_step_up()?;
    blocking(&state, move |state| {
        if !state.auth.revoke_device(&id)? {
            return Err(ApiError::not_found());
        }
        audit(state, &caller.actor(), "device.revoked", &caller.meta, Some(&id));
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

/// 仅端到端测试：不输密码直接签发会话。
#[cfg(feature = "test-auth")]
async fn test_session(State(state): State<AppState>, Meta(meta): Meta) -> Result<Response, ApiError> {
    blocking(&state, move |state| start_session(state, &meta, json!({ "ok": true }))).await
}

/// 仅端到端测试：把当前会话标记为刚输过密码；`?expire=1` 则让验证过期
/// （登录本身算一次验证，测「需要重新验证」时先让它过期）。
#[cfg(feature = "test-auth")]
async fn test_step_up(
    State(state): State<AppState>,
    caller: Caller,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let id_hash = caller.require_session()?.to_vec();
    let expire = query.contains_key("expire");
    blocking(&state, move |state| {
        if expire {
            state.auth.expire_step_up(&id_hash)?;
        } else {
            state.auth.mark_step_up(&id_hash)?;
        }
        Ok(Json(json!({ "ok": true })))
    })
    .await
}
