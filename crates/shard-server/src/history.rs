//! 版本历史与导出：
//! - RPC `list_revisions` / `list_deleted_entries` / `restore_revision` / `erase_deleted_entries`；
//! - `GET /api/history/{revId}`：一条修订的原始字节（预览旧版本、下载）；
//! - `GET /api/export.zip`：整个资料库按原目录结构打包，解压后能直接用旧版桌面 App 打开。
//!
//! 彻底删除的内容再留 30 天（`shard_store::PURGED_HISTORY_DAYS`），期间可以找回，所以彻底删除、
//! 清空回收站不要求重新验证通行密钥；不可逆的「立即抹除」与「导出全部」才要求。

use std::{io, path::Path as FsPath};

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use chrono::FixedOffset;
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::Vfs;
use shard_store::PURGED_HISTORY_DAYS;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    auth::principal::Caller,
    error::ApiError,
    rpc::{Access, Registry, RpcEnv, RpcError},
    state::AppState,
};

pub fn register(registry: &mut Registry) {
    registry
        .register("list_revisions", Access::Read, list_revisions)
        .register("list_deleted_entries", Access::Read, list_deleted_entries)
        .register("restore_revision", Access::Write, restore_revision)
        .register("erase_deleted_entries", Access::Sensitive, erase_deleted_entries);
}

pub fn router() -> Router<AppState> {
    Router::new().route("/history/{rev_id}", get(raw_revision)).route("/export.zip", get(export_zip))
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, RpcError> {
    serde_json::from_value(args).map_err(RpcError::invalid_args)
}

fn not_found(message: &str) -> RpcError {
    RpcError::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
}

fn store_error(error: shard_store::StoreError) -> RpcError {
    RpcError::from(error)
}

fn io_error(error: io::Error) -> RpcError {
    store_error(error.into())
}

/// 网页端的路径是资料库相对路径；容忍开头的 `./` 与 `/`。
fn clean_path(path: &str) -> String {
    path.trim().trim_start_matches("./").trim_start_matches('/').to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    #[serde(default)]
    path: Option<String>,
    /// 碎片 id：碎片卡片上没有路径时用它找。
    #[serde(default)]
    id: Option<String>,
    /// 已彻底删除的条目没有路径，按「最近删除」里的节点找。
    #[serde(default)]
    node_id: Option<i64>,
}

fn list_revisions(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ListArgs = parse(args)?;
    if let Some(node_id) = args.node_id {
        let revisions = env.store.list_node_revisions(node_id).map_err(store_error)?;
        if revisions.is_empty() {
            return Err(not_found("找不到这个条目的历史。"));
        }
        return Ok(json!({ "nodeId": node_id, "path": Value::Null, "revisions": revisions }));
    }
    let path = match (args.path, args.id) {
        (Some(path), _) => clean_path(&path),
        (None, Some(id)) => env
            .read(|vfs| {
                shard_vault::find_fragment_path(vfs, &id)
                    .map(|found| found.and_then(|path| path.strip_prefix(vfs.root()).ok().map(|rel| rel.to_string_lossy().replace('\\', "/"))))
            })?
            .map_err(RpcError::from)?
            .ok_or_else(|| not_found("找不到这条碎片。"))?,
        (None, None) => return Err(RpcError::invalid_args("需要 path、id 或 nodeId。")),
    };
    let (node_id, revisions) = env.store.list_revisions(&path).map_err(store_error)?.ok_or_else(|| not_found("找不到这个文件。"))?;
    Ok(json!({ "nodeId": node_id, "path": path, "revisions": revisions }))
}

fn list_deleted_entries(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    let entries = env.store.list_deleted().map_err(store_error)?;
    Ok(json!({ "entries": entries, "retentionDays": PURGED_HISTORY_DAYS }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreArgs {
    rev_id: i64,
    /// 条目当前内容的 sha：恢复在用条目时防止盖掉别处刚做的修改（与保存相同的 STALE_BASE 约定）。
    #[serde(default)]
    expected_sha: Option<String>,
}

/// 回收站里的路径恢复到原位置。
fn outside_trash(path: &str) -> &str {
    path.strip_prefix(".trash/").unwrap_or(path)
}

/// 恢复一条修订：
/// - 条目还在：把这条修订的内容写回当前路径（路径以当前为准，改过名也不动）；
/// - 条目已彻底删除：沿用原节点放回原位置（回收站里的放回回收站外），位置被占用就加时间后缀。
fn restore_revision(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: RestoreArgs = parse(args)?;
    env.write_as("revert", |vfs| {
        let (info, bytes) = vfs.revision(args.rev_id).map_err(io_error)?.ok_or_else(|| not_found("找不到这条修订。"))?;
        let Some(sha) = info.sha.clone() else {
            return Err(RpcError::invalid_args("这条记录是删除时刻，没有内容可以恢复。"));
        };
        let root = vfs.root().to_path_buf();
        let (path, revived) = match vfs.node_path(info.node_id).map_err(io_error)? {
            Some(current) => {
                let abs = root.join(&current);
                let current_sha = vfs.content_sha(&abs).map_err(io_error)?;
                if let Some(expected) = &args.expected_sha {
                    if expected != &current_sha {
                        return Err(RpcError::new(
                            StatusCode::CONFLICT,
                            "STALE_BASE",
                            "STALE_BASE: 这个文件刚在别处改过，刷新后再恢复。",
                        ));
                    }
                }
                if current_sha != sha {
                    vfs.write(&abs, &bytes).map_err(io_error)?;
                }
                (current, false)
            }
            None => {
                let wanted = root.join(outside_trash(&info.path));
                if let Some(parent) = wanted.parent() {
                    vfs.create_dir_all(parent).map_err(io_error)?;
                }
                let target = shard_vault::timestamped_collision_path(vfs, &wanted).map_err(RpcError::from)?;
                vfs.revive(info.node_id, &target, &bytes).map_err(io_error)?;
                let rel = target.strip_prefix(&root).unwrap_or(&target).to_string_lossy().replace('\\', "/");
                (rel, true)
            }
        };
        Ok(json!({ "path": path, "sha": sha, "revived": revived }))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EraseArgs {
    node_ids: Vec<i64>,
}

fn erase_deleted_entries(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: EraseArgs = parse(args)?;
    let report = env.store.erase_purged(&args.node_ids).map_err(|error| match error {
        shard_store::StoreError::Invalid(message) => RpcError::invalid_args(message),
        other => store_error(other),
    })?;
    Ok(json!({ "nodes": report.nodes, "revisions": report.revisions, "blobs": report.blobs }))
}

/// 预览用的类型：图片按文件头认，文本类按扩展名，其余一律下载。
fn preview_type(path: &str, bytes: &[u8]) -> Option<&'static str> {
    if let Some(mime) = shard_core::image::image_mime_type(FsPath::new(path), bytes) {
        return Some(mime);
    }
    let extension = path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    matches!(extension.as_str(), "md" | "csv" | "json" | "txt").then_some("text/plain; charset=utf-8")
}

/// RFC 5987：`filename*=UTF-8''…`，中文文件名也能正确下载。
fn content_disposition(kind: &str, path: &str) -> HeaderValue {
    let name = path.rsplit('/').next().unwrap_or("download");
    let encoded: String = name
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect();
    HeaderValue::from_str(&format!("{kind}; filename*=UTF-8''{encoded}")).unwrap_or(HeaderValue::from_static("attachment"))
}

#[derive(Deserialize)]
struct RawQuery {
    #[serde(default)]
    download: Option<String>,
}

async fn raw_revision(
    State(state): State<AppState>,
    _caller: Caller,
    Path(rev_id): Path<i64>,
    Query(query): Query<RawQuery>,
) -> Result<Response, ApiError> {
    let store = state.store.clone();
    let found = tokio::task::spawn_blocking(move || store.read_revision(rev_id)).await.map_err(ApiError::internal)??;
    let Some((info, bytes)) = found else {
        return Err(ApiError::not_found());
    };
    if info.sha.is_none() {
        return Err(ApiError::not_found());
    }
    let preview = preview_type(&info.path, &bytes).filter(|_| query.download.is_none());
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(preview.unwrap_or("application/octet-stream")));
    headers.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(if preview.is_some() { "inline" } else { "attachment" }, &info.path),
    );
    // 修订内容永远不变。
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if preview == Some("image/svg+xml") {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    Ok(response)
}

/// 把阻塞线程里写出的 zip 分块送进响应流；浏览器断开时写入失败，导出随之停止。
struct ChannelWriter {
    sender: mpsc::Sender<Result<Bytes, io::Error>>,
    buffer: Vec<u8>,
}

const CHUNK: usize = 256 * 1024;

impl ChannelWriter {
    fn send(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(&mut self.buffer, Vec::with_capacity(CHUNK)));
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "下载已取消"))
    }
}

impl io::Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportQuery {
    /// 导出者的时区（分钟），zip 里的时间按它记。
    #[serde(default)]
    utc_offset: Option<i32>,
}

async fn export_zip(State(state): State<AppState>, caller: Caller, Query(query): Query<ExportQuery>) -> Result<Response, ApiError> {
    caller.require_step_up()?;
    let offset = query
        .utc_offset
        .filter(|minutes| minutes.abs() <= 14 * 60)
        .and_then(|minutes| FixedOffset::east_opt(minutes * 60))
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC 偏移"));
    state.auth.audit(&caller.actor(), "export.zip", caller.meta.ip.as_deref(), caller.meta.user_agent.as_deref(), None);

    let (sender, receiver) = mpsc::channel(4);
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let failure = sender.clone();
        let writer = ChannelWriter { sender, buffer: Vec::with_capacity(CHUNK) };
        let result = shard_store::transfer::export_zip(&store, writer, offset)
            .and_then(|(_, mut writer)| io::Write::flush(&mut writer).map_err(shard_store::StoreError::from));
        if let Err(error) = result {
            tracing::warn!(%error, "导出 zip 中断");
            // 让浏览器看到下载失败，而不是一个被截断却显示成功的 zip。
            let _ = failure.blocking_send(Err(io::Error::other(error.to_string())));
        }
    });

    let now = chrono::Utc::now().with_timezone(&offset);
    let name = format!("shard-export-{}.zip", now.format("%Y%m%d-%H%M"));
    let mut response = Body::from_stream(ReceiverStream::new(receiver)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    headers.insert(header::CONTENT_DISPOSITION, content_disposition("attachment", &name));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
