//! 认证相关端点：首次设置、登录、二次验证、退出、通行密钥 / 会话 / 设备管理、设备配对。

use axum::{
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use webauthn_rs::prelude::{CredentialID, Passkey, PublicKeyCredential, RegisterPublicKeyCredential, Uuid};

use super::{
    ceremony::Ceremony,
    db::{PairingPoll, SESSION_ABSOLUTE},
    principal::{BrowserRequest, Caller, ClientMeta, MaybeCaller, Meta},
    tokens::{device_token, hex, normalize_user_code, random_id, random_token, user_code},
};
use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    let router = Router::new()
        .route("/auth/state", get(auth_state))
        .route("/auth/setup/start", post(setup_start))
        .route("/auth/setup/finish", post(setup_finish))
        .route("/auth/login/start", post(login_start))
        .route("/auth/login/finish", post(login_finish))
        .route("/auth/stepup/start", post(step_up_start))
        .route("/auth/stepup/finish", post(step_up_finish))
        .route("/auth/logout", post(logout))
        .route("/auth/passkeys", get(list_passkeys))
        .route("/auth/passkeys/start", post(add_passkey_start))
        .route("/auth/passkeys/finish", post(add_passkey_finish))
        .route("/auth/passkeys/{id}", delete(revoke_passkey))
        .route("/auth/sessions", get(list_sessions))
        .route("/auth/sessions/{id}", delete(revoke_session))
        .route("/auth/audit", get(audit_log))
        .route("/device/start", post(device_start))
        .route("/device/approve", post(device_approve))
        .route("/device/token", post(device_token_poll))
        .route("/devices", get(list_devices))
        .route("/devices/{id}", delete(revoke_device));
    #[cfg(feature = "test-auth")]
    let router = router.route("/test/session", post(test_session));
    router
}

/// 同步的认证库调用放进阻塞线程池，别卡住异步执行器。
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

fn stored_passkeys(state: &AppState) -> Result<Vec<Passkey>, ApiError> {
    state
        .auth
        .active_passkeys()?
        .into_iter()
        .map(|row| serde_json::from_str::<Passkey>(&row.passkey_json).map_err(ApiError::internal))
        .collect()
}

fn credential_id_bytes(id: &CredentialID) -> Vec<u8> {
    id.as_ref().to_vec()
}

fn owner_uuid(state: &AppState) -> Result<Uuid, ApiError> {
    let fresh = Uuid::new_v4();
    let handle = state.auth.ensure_owner(fresh.as_bytes(), &random_token())?;
    Uuid::from_slice(&handle).map_err(ApiError::internal)
}

fn begin_registration(state: &AppState, setup_token: Option<String>) -> Result<Value, ApiError> {
    let uuid = owner_uuid(state)?;
    let exclude = stored_passkeys(state)?
        .iter()
        .map(|passkey| passkey.cred_id().clone())
        .collect::<Vec<_>>();
    let (options, registration) = state
        .webauthn
        .start_passkey_registration(uuid, "owner", "Shard", Some(exclude))
        .map_err(ApiError::internal)?;
    let ceremony_id = state.ceremonies.begin(Ceremony::Register { state: registration, setup_token });
    Ok(json!({ "ceremonyId": ceremony_id, "options": options }))
}

// ---------- 状态 ----------

async fn auth_state(State(state): State<AppState>, MaybeCaller(caller): MaybeCaller) -> Result<Json<Value>, ApiError> {
    let setup_required = blocking(&state, |state| Ok(!state.auth.has_active_passkey()?)).await?;
    let step_up_valid = caller.as_ref().map(|caller| caller.require_step_up().is_ok()).unwrap_or(false);
    Ok(Json(json!({
        "setupRequired": setup_required,
        "authenticated": caller.is_some(),
        "stepUpValid": step_up_valid,
        "vaultId": state.vault_identity,
    })))
}

// ---------- 首次设置 / 恢复 ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupStart {
    token: String,
}

async fn setup_start(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<SetupStart>,
) -> Result<Json<Value>, ApiError> {
    limited(&state, "setup", &meta, 10)?;
    blocking(&state, move |state| {
        if state.auth.peek_setup_token(&body.token)?.is_none() {
            audit(state, "anonymous", "setup.invalid_token", &meta, None);
            return Err(ApiError::forbidden("SETUP_TOKEN_INVALID", "设置链接无效或已过期，请在服务器上重新生成。"));
        }
        begin_registration(state, Some(body.token)).map(Json)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterFinish {
    ceremony_id: String,
    credential: RegisterPublicKeyCredential,
    #[serde(default)]
    label: Option<String>,
}

fn finish_registration(state: &AppState, body: RegisterFinish, expect_setup: bool) -> Result<Passkey, ApiError> {
    let Some(Ceremony::Register { state: registration, setup_token }) = state.ceremonies.take(&body.ceremony_id) else {
        return Err(ApiError::bad_request("注册已过期，请重新开始。"));
    };
    if setup_token.is_some() != expect_setup {
        return Err(ApiError::bad_request("注册流程不匹配。"));
    }
    if let Some(token) = &setup_token {
        if !state.auth.consume_setup_token(token)? {
            return Err(ApiError::forbidden("SETUP_TOKEN_INVALID", "设置链接无效或已过期，请在服务器上重新生成。"));
        }
    }
    let passkey = state
        .webauthn
        .finish_passkey_registration(&body.credential, &registration)
        .map_err(|error| ApiError::bad_request(format!("通行密钥注册失败：{error}")))?;
    let label = body.label.map(|label| label.chars().take(60).collect::<String>());
    state.auth.insert_passkey(
        &credential_id_bytes(passkey.cred_id()),
        &serde_json::to_string(&passkey).map_err(ApiError::internal)?,
        label.as_deref(),
    )?;
    Ok(passkey)
}

async fn setup_finish(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<RegisterFinish>,
) -> Result<Response, ApiError> {
    limited(&state, "setup", &meta, 10)?;
    blocking(&state, move |state| {
        let passkey = finish_registration(state, body, true)?;
        audit(state, "setup", "passkey.registered", &meta, Some(&hex(&credential_id_bytes(passkey.cred_id()))));
        start_session(state, &meta, json!({ "ok": true }))
    })
    .await
}

// ---------- 登录 ----------

async fn login_start(State(state): State<AppState>, BrowserRequest(meta): BrowserRequest) -> Result<Json<Value>, ApiError> {
    limited(&state, "login", &meta, 10)?;
    blocking(&state, |state| {
        let passkeys = stored_passkeys(state)?;
        if passkeys.is_empty() {
            return Err(ApiError::new(StatusCode::CONFLICT, "SETUP_REQUIRED", "还没有设置通行密钥。"));
        }
        let (options, authentication) =
            state.webauthn.start_passkey_authentication(&passkeys).map_err(ApiError::internal)?;
        let ceremony_id = state.ceremonies.begin(Ceremony::Login { state: authentication });
        Ok(Json(json!({ "ceremonyId": ceremony_id, "options": options })))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFinish {
    ceremony_id: String,
    credential: PublicKeyCredential,
}

/// 校验断言并更新这把通行密钥的计数器。
fn verify_assertion(
    state: &AppState,
    credential: &PublicKeyCredential,
    authentication: &webauthn_rs::prelude::PasskeyAuthentication,
) -> Result<Vec<u8>, ApiError> {
    let result = state
        .webauthn
        .finish_passkey_authentication(credential, authentication)
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "PASSKEY_REJECTED", "通行密钥验证没有通过。"))?;
    let used = credential_id_bytes(result.cred_id());
    for mut passkey in stored_passkeys(state)? {
        if credential_id_bytes(passkey.cred_id()) == used {
            passkey.update_credential(&result);
            state
                .auth
                .update_passkey_after_use(&used, &serde_json::to_string(&passkey).map_err(ApiError::internal)?)?;
            return Ok(used);
        }
    }
    Err(ApiError::new(StatusCode::UNAUTHORIZED, "PASSKEY_REJECTED", "这把通行密钥已被吊销。"))
}

async fn login_finish(
    State(state): State<AppState>,
    BrowserRequest(meta): BrowserRequest,
    Json(body): Json<AuthFinish>,
) -> Result<Response, ApiError> {
    limited(&state, "login", &meta, 10)?;
    blocking(&state, move |state| {
        let Some(Ceremony::Login { state: authentication }) = state.ceremonies.take(&body.ceremony_id) else {
            return Err(ApiError::bad_request("登录已过期，请重新开始。"));
        };
        match verify_assertion(state, &body.credential, &authentication) {
            Ok(cred) => {
                audit(state, "login", "login.success", &meta, Some(&hex(&cred)));
                start_session(state, &meta, json!({ "ok": true }))
            }
            Err(error) => {
                audit(state, "anonymous", "login.failure", &meta, None);
                Err(error)
            }
        }
    })
    .await
}

// ---------- 二次验证 ----------

async fn step_up_start(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    let session = caller.require_session()?.to_vec();
    limited(&state, "stepup", &caller.meta, 10)?;
    blocking(&state, move |state| {
        let passkeys = stored_passkeys(state)?;
        let (options, authentication) =
            state.webauthn.start_passkey_authentication(&passkeys).map_err(ApiError::internal)?;
        let ceremony_id = state.ceremonies.begin(Ceremony::StepUp { state: authentication, session });
        Ok(Json(json!({ "ceremonyId": ceremony_id, "options": options })))
    })
    .await
}

async fn step_up_finish(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<AuthFinish>,
) -> Result<Json<Value>, ApiError> {
    let session = caller.require_session()?.to_vec();
    blocking(&state, move |state| {
        let Some(Ceremony::StepUp { state: authentication, session: expected }) = state.ceremonies.take(&body.ceremony_id)
        else {
            return Err(ApiError::bad_request("验证已过期，请重新开始。"));
        };
        if expected != session {
            return Err(ApiError::bad_request("验证不属于当前会话。"));
        }
        verify_assertion(state, &body.credential, &authentication)?;
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

// ---------- 通行密钥管理 ----------

async fn list_passkeys(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    caller.require_session()?;
    blocking(&state, |state| {
        let items = state
            .auth
            .active_passkeys()?
            .into_iter()
            .map(|row| {
                json!({
                    "id": hex(&row.cred_id),
                    "label": row.label,
                    "createdAt": row.created_at,
                    "lastUsedAt": row.last_used_at,
                })
            })
            .collect::<Vec<_>>();
        Ok(Json(json!({ "passkeys": items })))
    })
    .await
}

async fn add_passkey_start(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, ApiError> {
    caller.require_step_up()?;
    blocking(&state, |state| begin_registration(state, None).map(Json)).await
}

async fn add_passkey_finish(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<RegisterFinish>,
) -> Result<Json<Value>, ApiError> {
    caller.require_step_up()?;
    blocking(&state, move |state| {
        let passkey = finish_registration(state, body, false)?;
        audit(state, &caller.actor(), "passkey.registered", &caller.meta, Some(&hex(&credential_id_bytes(passkey.cred_id()))));
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

fn parse_hex(value: &str) -> Result<Vec<u8>, ApiError> {
    if !value.len().is_multiple_of(2) || !value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("id 无效。"));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| ApiError::bad_request("id 无效。")))
        .collect()
}

async fn revoke_passkey(State(state): State<AppState>, caller: Caller, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    caller.require_step_up()?;
    let cred = parse_hex(&id)?;
    blocking(&state, move |state| {
        if !state.auth.revoke_passkey(&cred)? {
            return Err(ApiError::new(StatusCode::CONFLICT, "LAST_PASSKEY", "不能吊销最后一把通行密钥，先添加一把新的。"));
        }
        audit(state, &caller.actor(), "passkey.revoked", &caller.meta, Some(&id));
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

// ---------- 设备配对（RFC 8628 式） ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStart {
    name: String,
    kind: String,
}

async fn device_start(State(state): State<AppState>, Meta(meta): Meta, Json(body): Json<DeviceStart>) -> Result<Json<Value>, ApiError> {
    limited(&state, "pairing", &meta, 10)?;
    if body.kind != "desktop" && body.kind != "cli" {
        return Err(ApiError::bad_request("kind 只能是 desktop 或 cli。"));
    }
    let name: String = body.name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Err(ApiError::bad_request("请给设备起个名字。"));
    }
    blocking(&state, move |state| {
        let device_code = random_token();
        let code = user_code();
        state.auth.create_pairing(&device_code, &code, &name, &body.kind)?;
        audit(state, "anonymous", "pairing.started", &meta, Some(&name));
        Ok(Json(json!({
            "deviceCode": device_code,
            "userCode": format!("{}-{}", &code[..4], &code[4..]),
            "verificationUri": format!("{}/pair", state.config.origin_text),
            "expiresIn": super::db::PAIRING_TTL.num_seconds(),
            "interval": 3,
        })))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceApprove {
    user_code: String,
}

async fn device_approve(State(state): State<AppState>, caller: Caller, Json(body): Json<DeviceApprove>) -> Result<Json<Value>, ApiError> {
    caller.require_step_up()?;
    limited(&state, "pairing-approve", &caller.meta, 5)?;
    blocking(&state, move |state| {
        let code = normalize_user_code(&body.user_code);
        match state.auth.approve_pairing(&code)? {
            Some(name) => {
                audit(state, &caller.actor(), "pairing.approved", &caller.meta, Some(&name));
                Ok(Json(json!({ "ok": true, "name": name })))
            }
            None => Err(ApiError::new(StatusCode::NOT_FOUND, "PAIRING_NOT_FOUND", "配对码不对或已过期。")),
        }
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceTokenPoll {
    device_code: String,
}

async fn device_token_poll(State(state): State<AppState>, Meta(meta): Meta, Json(body): Json<DeviceTokenPoll>) -> Result<Json<Value>, ApiError> {
    limited(&state, "pairing-poll", &meta, 40)?;
    blocking(&state, move |state| match state.auth.poll_pairing(&body.device_code)? {
        None | Some(PairingPoll::Expired) => {
            Err(ApiError::new(StatusCode::GONE, "PAIRING_EXPIRED", "配对已过期，请重新开始。"))
        }
        Some(PairingPoll::Pending) => Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "AUTHORIZATION_PENDING",
            "等待在浏览器里批准。",
        )),
        Some(PairingPoll::Approved { client_name, kind }) => {
            let device_id = random_id("dev_");
            let token = device_token();
            state.auth.create_device(&device_id, &client_name, &kind, &token, "vault")?;
            audit(state, &format!("device:{device_id}"), "device.created", &meta, Some(&client_name));
            Ok(Json(json!({ "token": token, "deviceId": device_id, "name": client_name })))
        }
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

/// 仅端到端测试：不走通行密钥直接签发会话（WebKit 没有虚拟验证器）。
#[cfg(feature = "test-auth")]
async fn test_session(State(state): State<AppState>, Meta(meta): Meta) -> Result<Response, ApiError> {
    blocking(&state, move |state| start_session(state, &meta, json!({ "ok": true }))).await
}
