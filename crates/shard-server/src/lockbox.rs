//! 密匣：服务器只存密文，加解密全在客户端（桌面 Rust、浏览器 wasm，同一份 `shard-lockbox`）。
//!
//! - `lockbox_snapshot`：manifest 原文与全部信封。客户端解锁后在内存里跑领域逻辑。
//! - `lockbox_apply`：一批写入 / 删除，每条带 `expectedSha`（null = 必须不存在），整批一个事务，任何一条对不上整批不写。
//! - `seal_fragment_into_lockbox`：公开碎片移入密匣。同一事务里彻底删除公开文件、抹掉它的全部明文修订，
//!   并写入客户端加密好的信封；提交后截断 WAL。
//! - `set_lockbox_web_unlock`：「允许在网页解锁密匣」。关掉后不向浏览器会话下发信封（manifest 照给：锁着时
//!   用公钥写入不需要口令）。它防被盗的浏览器会话，防不了被篡改的网页。
//!
//! 服务端只校验结构：manifest 与信封能解析、信封 id 与条目 id 一致、导出路径在 `lockbox/` 下。

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::Vfs;
use shard_lockbox::{Envelope, Manifest};

use crate::rpc::{Access, Registry, RpcEnv, RpcError};

const WEB_UNLOCK_KEY: &str = "lockbox_web_unlock";

pub fn register(registry: &mut Registry) {
    registry
        .register("lockbox_snapshot", Access::Read, lockbox_snapshot)
        .register("lockbox_apply", Access::Write, lockbox_apply)
        .register("seal_fragment_into_lockbox", Access::Write, seal_fragment_into_lockbox)
        .register("set_lockbox_web_unlock", Access::Sensitive, set_lockbox_web_unlock);
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, RpcError> {
    serde_json::from_value(args).map_err(RpcError::invalid_args)
}

fn io_error(error: std::io::Error) -> RpcError {
    RpcError::from(shard_store::StoreError::from(error))
}

fn stale(what: &str) -> RpcError {
    RpcError::new(StatusCode::CONFLICT, "STALE_BASE", format!("STALE_BASE: {what}已在别处改过，刷新后再试。"))
}

fn web_unlock_allowed(env: &RpcEnv<'_>) -> Result<bool, RpcError> {
    Ok(env.store.meta(WEB_UNLOCK_KEY)?.as_deref() != Some("0"))
}

fn lockbox_snapshot(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    let web_unlock = web_unlock_allowed(env)?;
    let withhold = env.source == "web" && !web_unlock;
    let (manifest, items) = env.read(|vfs| -> std::io::Result<_> {
        let manifest = vfs.lockbox_manifest_entry()?;
        let items = if withhold { Vec::new() } else { vfs.lockbox_item_entries()? };
        Ok((manifest, items))
    })?
    .map_err(io_error)?;
    Ok(json!({
        "configured": manifest.is_some(),
        "manifest": manifest,
        "items": items,
        "itemsWithheld": withhold,
        "webUnlock": web_unlock,
    }))
}

/// 导出时写回的路径：`lockbox/…/x.shard`，不许跳出。
fn valid_path(path: &str) -> Result<(), RpcError> {
    let ok = path.starts_with("lockbox/")
        && path.ends_with(".shard")
        && !path.contains('\\')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if ok {
        Ok(())
    } else {
        Err(RpcError::invalid_args(format!("密匣条目路径无效：{path}")))
    }
}

/// 信封能解析且 id 与条目一致，返回信封版本。
fn checked_envelope(id: &str, envelope: &str) -> Result<u32, RpcError> {
    let parsed = Envelope::parse(envelope).map_err(|error| RpcError::invalid_args(format!("信封无效：{error}")))?;
    if parsed.id != id {
        return Err(RpcError::invalid_args(format!("信封 id（{}）与条目 id（{id}）不一致。", parsed.id)));
    }
    Ok(parsed.version)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestWrite {
    body: String,
    expected_sha: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ItemWrite {
    Put { id: String, envelope: String, #[serde(default)] path: Option<String>, expected_sha: Option<String> },
    Delete { id: String, expected_sha: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyArgs {
    #[serde(default)]
    manifest: Option<ManifestWrite>,
    #[serde(default)]
    items: Vec<ItemWrite>,
}

fn lockbox_apply(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ApplyArgs = parse(args)?;
    if args.manifest.is_none() && args.items.is_empty() {
        return Err(RpcError::invalid_args("没有要写入的内容。"));
    }
    // 先做不依赖库状态的校验，省得开写事务。
    if let Some(manifest) = &args.manifest {
        Manifest::parse(&manifest.body).map_err(|error| RpcError::invalid_args(format!("密匣 manifest 无效：{error}")))?;
    }
    let mut versions = Vec::with_capacity(args.items.len());
    for item in &args.items {
        versions.push(match item {
            ItemWrite::Put { id, envelope, path, .. } => {
                if let Some(path) = path {
                    valid_path(path)?;
                }
                Some(checked_envelope(id, envelope)?)
            }
            ItemWrite::Delete { .. } => None,
        });
    }
    env.write(|vfs| {
        let mut out_manifest = Value::Null;
        if let Some(manifest) = &args.manifest {
            let current = vfs.lockbox_manifest_entry().map_err(io_error)?;
            if current.as_ref().map(|entry| entry.sha.as_str()) != manifest.expected_sha.as_deref() {
                return Err(stale("密匣设置"));
            }
            vfs.put_lockbox_manifest_raw(&manifest.body, None).map_err(io_error)?;
            let written = vfs.lockbox_manifest_entry().map_err(io_error)?.expect("刚写入");
            out_manifest = json!({ "sha": written.sha, "revision": written.revision });
        }
        let mut out_items = Vec::with_capacity(args.items.len());
        for (item, version) in args.items.iter().zip(&versions) {
            match item {
                ItemWrite::Put { id, envelope, path, expected_sha } => {
                    let current = vfs.lockbox_item_entry(id).map_err(io_error)?;
                    if current.as_ref().map(|entry| entry.sha.as_str()) != expected_sha.as_deref() {
                        return Err(stale(&format!("密匣条目 {id} ")));
                    }
                    vfs.put_lockbox_item(id, envelope, version.unwrap_or(1), path.as_deref()).map_err(io_error)?;
                    let written = vfs.lockbox_item_entry(id).map_err(io_error)?.expect("刚写入");
                    out_items.push(json!({ "id": id, "sha": written.sha, "revision": written.revision, "path": written.path }));
                }
                ItemWrite::Delete { id, expected_sha } => {
                    let current = vfs.lockbox_item_entry(id).map_err(io_error)?;
                    if current.as_ref().map(|entry| entry.sha.as_str()) != Some(expected_sha.as_str()) {
                        return Err(stale(&format!("密匣条目 {id} ")));
                    }
                    vfs.delete_lockbox_item(id).map_err(io_error)?;
                    out_items.push(json!({ "id": id, "sha": Value::Null }));
                }
            }
        }
        Ok(json!({ "manifest": out_manifest, "items": out_items }))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealItem {
    id: String,
    envelope: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealArgs {
    fragment_id: String,
    expected_file_sha: String,
    item: SealItem,
}

fn seal_fragment_into_lockbox(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SealArgs = parse(args)?;
    if args.item.id != args.fragment_id {
        return Err(RpcError::invalid_args("移入密匣后条目 id 应与原碎片相同。"));
    }
    valid_path(&args.item.path)?;
    let version = checked_envelope(&args.item.id, &args.item.envelope)?;
    let result = env.write(|vfs| {
        let root = vfs.root().to_path_buf();
        let public = shard_vault::find_fragment_path(vfs, &args.fragment_id)
            .map_err(RpcError::from)?
            .ok_or_else(|| RpcError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "找不到这条碎片。"))?;
        let rel = public.strip_prefix(&root).unwrap_or(&public).to_string_lossy().replace('\\', "/");
        if !(rel.starts_with("fragments/") || rel.starts_with("notes/")) {
            return Err(RpcError::invalid_args("只有 fragments/、notes/ 中的文档可以移入密匣。"));
        }
        if vfs.content_sha(&public).map_err(io_error)? != args.expected_file_sha {
            return Err(stale("这条碎片"));
        }
        if vfs.lockbox_item_entry(&args.item.id).map_err(io_error)?.is_some() {
            return Err(RpcError::new(StatusCode::CONFLICT, "LOCKBOX_ID_TAKEN", "密匣里已有同 id 的条目。"));
        }
        vfs.erase_history_on_commit(&public).map_err(io_error)?;
        vfs.remove_file(&public).map_err(io_error)?;
        vfs.put_lockbox_item(&args.item.id, &args.item.envelope, version, Some(&args.item.path)).map_err(io_error)?;
        let written = vfs.lockbox_item_entry(&args.item.id).map_err(io_error)?.expect("刚写入");
        Ok(json!({ "removedPath": rel, "item": { "id": written.id, "sha": written.sha, "revision": written.revision, "path": written.path } }))
    })?;
    // 明文刚被删掉：把 WAL 里的旧页也清掉（有读者占着时留到下次检查点）。
    if let Err(error) = env.store.truncate_wal() {
        tracing::warn!(%error, "移入密匣后截断 WAL 失败");
    }
    Ok(result)
}

#[derive(Deserialize)]
struct WebUnlockArgs {
    allowed: bool,
}

fn set_lockbox_web_unlock(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: WebUnlockArgs = parse(args)?;
    env.store.set_meta(WEB_UNLOCK_KEY, if args.allowed { "1" } else { "0" })?;
    Ok(json!({ "webUnlock": args.allowed }))
}
