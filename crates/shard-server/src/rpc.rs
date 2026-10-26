//! `POST /api/rpc/{命令名}`：命令名与参数和现有 Tauri 命令一一对应，前端只换传输层。
//!
//! - 读命令在只读快照里执行。
//! - 写命令必须带 `Idempotency-Key`：同一个键只提交一次，重试时原样返回第一次的响应；
//!   同一个键配不同的请求体返回 422（客户端 bug，绝不能当成功）。
//! - 领域错误沿用现有的字符串约定：`STALE_BASE:` 前缀 → 409，前端照旧进入冲突流程。

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use chrono::FixedOffset;
use serde_json::Value;
use shard_store::{ChangeRecord, SqliteVfs, Store, StoreError, WriteCtx};

use crate::{auth::principal::Caller, error::ApiError, state::AppState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    /// 不可逆的写（立即抹除）：要求浏览器会话 10 分钟内验证过通行密钥，成功后记审计。
    Sensitive,
}

pub type Handler = fn(&RpcEnv<'_>, Value) -> Result<Value, RpcError>;

#[derive(Clone, Copy)]
pub struct RpcCommand {
    pub access: Access,
    pub handler: Handler,
}

#[derive(Default, Clone)]
pub struct Registry {
    commands: HashMap<&'static str, RpcCommand>,
}

impl Registry {
    pub fn register(&mut self, name: &'static str, access: Access, handler: Handler) -> &mut Self {
        assert!(self.commands.insert(name, RpcCommand { access, handler }).is_none(), "命令 {name} 重复注册");
        self
    }

    pub fn get(&self, name: &str) -> Option<RpcCommand> {
        self.commands.get(name).copied()
    }

    pub fn names(&self) -> Vec<&'static str> {
        let mut names: Vec<_> = self.commands.keys().copied().collect();
        names.sort_unstable();
        names
    }
}

#[derive(Debug)]
pub struct RpcError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    /// 结构化错误体（搜索契约的 SearchError），见 [`ApiError::detail`]。
    pub detail: Option<Value>,
}

impl RpcError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into(), detail: None }
    }

    /// 带结构化错误体：前端拿到的是这个对象本身（与 Tauri 命令 reject 结构化错误一致）。
    pub fn structured(status: StatusCode, code: &str, detail: Value) -> Self {
        Self { status, code: code.to_string(), message: code.to_string(), detail: Some(detail) }
    }

    pub fn invalid_args(error: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_ARGS", format!("参数无效：{error}"))
    }
}

/// 领域函数的字符串错误：保留原文（前端按前缀识别），按前缀定状态码。
impl From<String> for RpcError {
    fn from(message: String) -> Self {
        if message.starts_with("STALE_BASE") {
            Self::new(StatusCode::CONFLICT, "STALE_BASE", message)
        } else {
            Self::new(StatusCode::BAD_REQUEST, "COMMAND_FAILED", message)
        }
    }
}

impl From<StoreError> for RpcError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::DuplicateOp(op_id) => Self::new(StatusCode::CONFLICT, "DUPLICATE_OP", op_id),
            StoreError::Io(error) => Self::new(StatusCode::BAD_REQUEST, "COMMAND_FAILED", error.to_string()),
            StoreError::Invalid(message) => Self::new(StatusCode::BAD_REQUEST, "COMMAND_FAILED", message),
            other => {
                tracing::error!(error = %other, "内容库错误");
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "服务器出错了，请稍后再试。")
            }
        }
    }
}

impl From<RpcError> for ApiError {
    fn from(error: RpcError) -> Self {
        ApiError { status: error.status, code: error.code, message: error.message, detail: error.detail }
    }
}

/// 一次 RPC 调用的执行环境。
pub struct RpcEnv<'a> {
    pub store: &'a Store,
    pub command: &'a str,
    pub actor: String,
    pub device: String,
    pub op_id: Option<String>,
    pub request_sha: String,
    /// 客户端时区（`X-Shard-UTC-Offset`，分钟）。碎片 id 与 `fragments/YYYY/MM` 按它算。
    pub utc_offset: FixedOffset,
    pub vault_identity: &'a str,
    /// 新建内容的 `source`：web / desktop / cli。
    pub source: &'static str,
    committed: RefCell<Vec<ChangeRecord>>,
    /// 这次调用改了密匣（条目或 manifest）：提交后推 `lockbox-changed`。
    lockbox_changed: Cell<bool>,
}

/// 幂等记录里存的响应：成功的值，或当时返回的错误（重试时原样回放）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum RecordedResponse {
    Ok(Value),
    Err { status: u16, code: String, message: String },
}

fn encode_recorded(result: &Result<Value, RpcError>) -> Vec<u8> {
    let recorded = match result {
        Ok(value) => RecordedResponse::Ok(value.clone()),
        Err(error) => RecordedResponse::Err {
            status: error.status.as_u16(),
            code: error.code.clone(),
            message: error.message.clone(),
        },
    };
    serde_json::to_vec(&recorded).unwrap_or_default()
}

impl RpcEnv<'_> {
    /// 领域代码的上下文：内容库 + 无版本控制钩子 + 客户端时区 + 来源。
    pub fn vault<'v>(&'v self, vfs: &'v SqliteVfs<'v>) -> shard_vault::VaultCtx<'v> {
        shard_vault::VaultCtx::local(vfs, &shard_vault::NoHooks).with_clock(self.utc_offset, self.source)
    }

    pub fn read<R>(&self, f: impl FnOnce(&SqliteVfs<'_>) -> R) -> Result<R, RpcError> {
        self.store.read(f).map_err(RpcError::from)
    }

    /// 写命令，并指定修订原因（恢复旧版本记为 revert）。
    pub fn write_as(
        &self,
        reason: &'static str,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<Value, RpcError>,
    ) -> Result<Value, RpcError> {
        let mut ctx = self.write_ctx();
        ctx.revision_reason = Some(reason);
        let (value, committed) = self.store.write_recorded(&ctx, f, |value| encode_recorded(&Ok(value.clone())))?;
        self.record(committed);
        Ok(value)
    }

    fn record(&self, committed: shard_store::Committed) {
        self.lockbox_changed.set(self.lockbox_changed.get() || committed.lockbox_changed);
        self.committed.borrow_mut().extend(committed.changes);
    }

    fn write_ctx(&self) -> WriteCtx {
        let mut ctx = WriteCtx::new(self.command, self.actor.clone()).with_device(self.device.clone());
        ctx.op_id = self.op_id.clone();
        ctx.request_sha = Some(self.request_sha.clone());
        ctx
    }

    /// 写命令：整个闭包是一个事务，出错整体回滚；成功的响应随事务记录。
    pub fn write(&self, f: impl FnOnce(&SqliteVfs<'_>) -> Result<Value, RpcError>) -> Result<Value, RpcError> {
        let (value, committed) =
            self.store.write_recorded(&self.write_ctx(), f, |value| encode_recorded(&Ok(value.clone())))?;
        self.record(committed);
        Ok(value)
    }

    /// 出错也提交：「先写下冲突副本、再报告冲突」的命令（导图、画布保存）用它，
    /// 否则回滚会把冲突副本一起丢掉。错误也记进幂等记录，重试不会再写一份副本。
    pub fn write_keeping_partial(
        &self,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<Value, RpcError>,
    ) -> Result<Value, RpcError> {
        let (result, committed) = self.store.write_keeping_partial(&self.write_ctx(), f, encode_recorded)?;
        self.record(committed);
        result
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/rpc/{command}", post(dispatch))
}

fn parse_offset(headers: &HeaderMap) -> FixedOffset {
    headers
        .get("x-shard-utc-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i32>().ok())
        .filter(|minutes| minutes.abs() <= 14 * 60)
        .and_then(|minutes| FixedOffset::east_opt(minutes * 60))
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC 偏移"))
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|key| !key.is_empty() && key.len() <= 128)
        .map(str::to_string)
}

fn replayed_response(bytes: Vec<u8>) -> Result<Response, ApiError> {
    match serde_json::from_slice::<RecordedResponse>(&bytes).map_err(ApiError::internal)? {
        RecordedResponse::Ok(value) => {
            Ok(json_response(serde_json::to_vec(&value).map_err(ApiError::internal)?, true))
        }
        RecordedResponse::Err { status, code, message } => Err(ApiError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
            code,
            message,
            detail: None,
        }),
    }
}

fn json_response(bytes: Vec<u8>, replayed: bool) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(axum::http::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(axum::http::header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if replayed {
        headers.insert("idempotent-replayed", HeaderValue::from_static("true"));
    }
    response
}

/// 已经提交过的幂等键：同请求体原样返回，不同请求体拒绝。
fn replay(store: &Store, op_id: &str, request_sha: &str) -> Result<Option<Vec<u8>>, ApiError> {
    let Some(record) = store.find_txn(op_id)? else {
        return Ok(None);
    };
    if record.request_sha.as_deref() != Some(request_sha) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "IDEMPOTENCY_KEY_REUSED",
            "同一个幂等键用在了不同的请求上。",
        ));
    }
    Ok(Some(record.response.unwrap_or_else(|| encode_recorded(&Ok(Value::Null)))))
}

async fn dispatch(
    State(state): State<AppState>,
    caller: Caller,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let command = state
        .rpc
        .get(&name)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "UNKNOWN_COMMAND", format!("没有这个命令：{name}")))?;
    let args: Value = if body.is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&body).map_err(|error| ApiError::bad_request(format!("请求体不是有效的 JSON：{error}")))?
    };
    let mut hasher_input = Vec::with_capacity(name.len() + 1 + body.len());
    hasher_input.extend_from_slice(name.as_bytes());
    hasher_input.push(b'\n');
    hasher_input.extend_from_slice(&body);
    let request_sha = shard_store::sha256_hex(&hasher_input);

    if command.access == Access::Sensitive {
        caller.require_step_up()?;
    }
    let audit = (command.access == Access::Sensitive).then(|| (caller.actor(), caller.meta.clone()));
    let op_id = idempotency_key(&headers);
    if command.access != Access::Read {
        let Some(op_id) = op_id.as_deref() else {
            return Err(ApiError::bad_request("写操作必须带 Idempotency-Key。"));
        };
        let store = state.store.clone();
        let (key, sha) = (op_id.to_string(), request_sha.clone());
        if let Some(bytes) = tokio::task::spawn_blocking(move || replay(&store, &key, &sha))
            .await
            .map_err(ApiError::internal)??
        {
            return replayed_response(bytes);
        }
    }

    let utc_offset = parse_offset(&headers);
    let task_state = state.clone();
    let task_name = name.clone();
    let task_op = op_id.clone();
    let task_sha = request_sha.clone();
    let (result, changes, lockbox_changed) = tokio::task::spawn_blocking(move || {
        let env = RpcEnv {
            store: &task_state.store,
            command: &task_name,
            source: caller.source(),
            actor: caller.actor(),
            device: caller.device(),
            op_id: task_op,
            request_sha: task_sha,
            utc_offset,
            vault_identity: &task_state.vault_identity,
            committed: RefCell::new(Vec::new()),
            lockbox_changed: Cell::new(false),
        };
        let result = (command.handler)(&env, args);
        let lockbox_changed = env.lockbox_changed.get();
        (result, env.committed.into_inner(), lockbox_changed)
    })
    .await
    .map_err(ApiError::internal)?;

    state.publish(changes, lockbox_changed);
    if let (Some((actor, meta)), Ok(_)) = (&audit, &result) {
        state.auth.audit(actor, &format!("rpc.{name}"), meta.ip.as_deref(), meta.user_agent.as_deref(), None);
    }
    match result {
        Ok(value) => Ok(json_response(serde_json::to_vec(&value).map_err(ApiError::internal)?, false)),
        // 并发的同键请求抢先提交了：按重放处理。
        Err(error) if error.code == "DUPLICATE_OP" => {
            let op_id = op_id.unwrap_or_default();
            match replay(&state.store, &op_id, &request_sha)? {
                Some(bytes) => replayed_response(bytes),
                None => Err(ApiError::internal("幂等键冲突但找不到记录")),
            }
        }
        Err(error) => Err(error.into()),
    }
}

/// 不依赖领域代码的基础命令。
pub fn base_registry() -> Registry {
    let mut registry = Registry::default();
    registry.register("server_status", Access::Read, server_status);
    registry
}

fn server_status(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    let head_seq = env.store.head_seq()?;
    Ok(serde_json::json!({ "vault": env.vault_identity, "headSeq": head_seq }))
}
