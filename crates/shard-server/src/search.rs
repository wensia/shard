//! 服务端搜索：`search_vault` 与 `read_search_target`，契约与桌面完全一致（`shard_vault::search`）。
//!
//! 快照是全部公开文档的投影，按「内容库最新 seq + epoch」缓存：内容没变就反复用同一份，
//! 有写入后的第一次搜索重建。全量重建对几千篇文档也只是一次只读事务里的读取与投影；
//! 将来需要时再按 changes 做增量。密匣只在客户端解密，服务端的密匣范围搜索一律返回 `locked`。

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use shard_vault::search::{
    build_public_snapshot, parse_search_query, read_public_search_target, snapshot_id,
    validate_search_request, ReadSearchTargetRequest, ReadSearchTargetResponse, SearchContext,
    SearchError, SearchIndexState, SearchScope, SearchSnapshotData, SearchVaultRequest,
    SearchVaultResponse,
};

use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub fn register(registry: &mut Registry) {
    registry.register("search_vault", Access::Read, search_vault);
    registry.register("read_search_target", Access::Read, read_search_target);
}

struct CachedSnapshot {
    head_seq: i64,
    epoch: String,
    snapshot: Arc<SearchSnapshotData>,
}

/// 按资料库身份（含随机 vault_id）分开缓存：同一进程里的多个内容库（测试）互不串用。
fn cache() -> &'static Mutex<HashMap<String, CachedSnapshot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSnapshot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn search_error(error: SearchError) -> RpcError {
    let status = match &error {
        SearchError::InvalidRequest { .. } => StatusCode::BAD_REQUEST,
        SearchError::NotFound => StatusCode::NOT_FOUND,
        SearchError::Io { .. } | SearchError::Internal { .. } => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::CONFLICT,
    };
    let detail = serde_json::to_value(&error).unwrap_or(Value::Null);
    let code = detail.get("code").and_then(Value::as_str).unwrap_or("search").to_string();
    RpcError::structured(status, &code, detail)
}

fn context(env: &RpcEnv<'_>) -> Result<SearchContext, RpcError> {
    let epoch = env.store.meta("epoch")?.unwrap_or_default();
    Ok(SearchContext {
        vault_path: env.vault_identity.to_string(),
        vault_epoch: epoch,
        // 服务端没有「解锁」状态，隐私代次恒定。
        privacy_epoch: "0".to_string(),
    })
}

/// 请求里带的上下文必须是当前资料库、当前 epoch（从备份恢复后 epoch 会变，客户端须重开搜索）。
fn check_context(
    current: &SearchContext,
    expected_vault_path: &str,
    requested: Option<&SearchContext>,
) -> Result<(), RpcError> {
    if expected_vault_path != current.vault_path {
        return Err(search_error(SearchError::VaultChanged));
    }
    if let Some(requested) = requested {
        if requested.vault_path != current.vault_path {
            return Err(search_error(SearchError::VaultChanged));
        }
        if requested.vault_epoch != current.vault_epoch {
            return Err(search_error(SearchError::ContextExpired));
        }
    }
    Ok(())
}

fn snapshot(env: &RpcEnv<'_>, context: &SearchContext) -> Result<Arc<SearchSnapshotData>, RpcError> {
    let head_seq = env.store.head_seq()?;
    let mut cache = cache().lock().expect("搜索缓存锁中毒");
    if let Some(cached) = cache.get(&context.vault_path) {
        if cached.head_seq == head_seq && cached.epoch == context.vault_epoch {
            return Ok(Arc::clone(&cached.snapshot));
        }
    }
    let built = env
        .read(|vfs| build_public_snapshot(vfs, &context.vault_path))?
        .map_err(search_error)?;
    let built = Arc::new(built);
    cache.insert(
        context.vault_path.clone(),
        CachedSnapshot { head_seq, epoch: context.vault_epoch.clone(), snapshot: Arc::clone(&built) },
    );
    Ok(built)
}

#[derive(Deserialize)]
struct SearchArgs {
    request: SearchVaultRequest,
}

fn search_vault(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let SearchArgs { request } = serde_json::from_value(args).map_err(RpcError::invalid_args)?;
    validate_search_request(&request).map_err(search_error)?;
    let current = context(env)?;
    check_context(&current, &request.expected_vault_path, request.context.as_ref())?;
    if matches!(request.scope, SearchScope::Lockbox) {
        return Err(search_error(SearchError::Locked));
    }
    let query = parse_search_query(&request.query).map_err(search_error)?;
    let snapshot = snapshot(env, &current)?;
    let scanned = snapshot
        .search(&query, request.limit as usize, request.include_trash)
        .map_err(search_error)?;
    let response = SearchVaultResponse {
        client_request_id: request.client_request_id,
        snapshot_id: Some(snapshot_id(&current, &request.scope, &snapshot.source_stamp)),
        context: current,
        index_state: SearchIndexState::Ready,
        expires_at: None,
        hits: scanned.hits,
        total: Some(scanned.total),
        skipped_files: snapshot.skipped_files,
        warning: None,
    };
    serde_json::to_value(response).map_err(|error| RpcError::from(error.to_string()))
}

#[derive(Deserialize)]
struct ReadArgs {
    request: ReadSearchTargetRequest,
}

fn read_search_target(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let ReadArgs { request } = serde_json::from_value(args).map_err(RpcError::invalid_args)?;
    if request.client_request_id.trim().is_empty() {
        return Err(search_error(SearchError::InvalidRequest { reason: "missingClientRequestId".to_string() }));
    }
    let current = context(env)?;
    check_context(&current, &request.expected_vault_path, request.context.as_ref())?;
    if request.target.vault_path != current.vault_path {
        return Err(search_error(SearchError::VaultChanged));
    }
    if matches!(request.target.scope, SearchScope::Lockbox) {
        return Err(search_error(SearchError::Locked));
    }
    let loaded = env
        .read(|vfs| read_public_search_target(vfs, &current.vault_path, &request.target))?
        .map_err(search_error)?;
    let fragment = loaded.fragment.ok_or_else(|| search_error(SearchError::UnsupportedTarget))?;
    let response = ReadSearchTargetResponse {
        client_request_id: request.client_request_id,
        context: current,
        expires_at: None,
        target: loaded.metadata.target,
        revision: loaded.metadata.revision,
        read_only: loaded.metadata.read_only,
        fragment,
    };
    serde_json::to_value(response).map_err(|error| RpcError::from(error.to_string()))
}
