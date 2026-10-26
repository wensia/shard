//! 字节相关端点：
//! - `GET /api/files/<路径>`：给网页 `<img>` 用的图片（Cookie 鉴权）。只供文件头确认是图片的内容，
//!   安全头与桌面 `shard-asset` 协议一致：nosniff、SVG 沙箱 CSP、内容寻址路径长期缓存。
//! - `HEAD/GET/PUT /api/blobs/<sha>`：大文件内容寻址上传下载，PUT 时服务端重算哈希。
//! - `/api/sync/*`：桌面副本的增量拉取与全量对账。

use std::path::Path as FsPath;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::Vfs;

use crate::{auth::principal::Caller, error::ApiError, state::AppState};

/// 单个文件最大可供下载的大小，与桌面协议一致。
const MAX_SERVED_BYTES: usize = 64 * 1024 * 1024;
/// 单次上传上限（与桌面保存图片的上限一致）。
const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/files/{*path}", get(file))
        .route(
            "/blobs/{sha}",
            get(get_blob).head(head_blob).put(put_blob).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/sync/changes", get(sync_changes))
        .route("/sync/manifest", get(sync_manifest))
        .route("/sync/fetch", post(sync_fetch))
}

/// `assets/<hh>/<sha256>.<ext>`：内容寻址，同一路径的内容永远不变。
fn is_content_addressed(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let [root, bucket, name] = parts.as_slice() else {
        return false;
    };
    let stem = name.split('.').next().unwrap_or_default();
    *root == "assets"
        && stem.len() == 64
        && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
        && stem[..2].eq_ignore_ascii_case(bucket)
}

fn clean_relative(path: &str) -> Result<String, ApiError> {
    let path = path.trim_start_matches("./");
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.split('/').any(|part| part == "..") {
        return Err(ApiError::not_found());
    }
    Ok(path.to_string())
}

async fn file(
    State(state): State<AppState>,
    _caller: Caller,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let rel = clean_relative(&path)?;
    let store = state.store.clone();
    let lookup = rel.clone();
    let found = tokio::task::spawn_blocking(move || {
        store.read(|vfs| {
            let abs = vfs.root().join(&lookup);
            let metadata = vfs.metadata(&abs).ok()?;
            if !metadata.is_file() || metadata.len() as usize > MAX_SERVED_BYTES {
                return None;
            }
            let sha = vfs.content_sha(&abs).ok()?;
            let bytes = vfs.read(&abs).ok()?;
            Some((sha, bytes))
        })
    })
    .await
    .map_err(ApiError::internal)??;
    // 一律 404：不区分「不存在」「不是图片」「太大」，不给探测路径的机会。
    let Some((sha, bytes)) = found else {
        return Err(ApiError::not_found());
    };
    let Some(mime) = shard_core::image::image_mime_type(FsPath::new(&rel), &bytes) else {
        return Err(ApiError::not_found());
    };
    let etag = format!("\"{sha}\"");
    let cache = if is_content_addressed(&rel) { "private, max-age=31536000, immutable" } else { "private, no-cache" };
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').any(|tag| tag.trim() == etag))
        .unwrap_or(false);
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (StatusCode::OK, bytes).into_response()
    };
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    out.insert(header::ETAG, HeaderValue::from_str(&etag).map_err(ApiError::internal)?);
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    if mime == "image/svg+xml" {
        out.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    Ok(response)
}

fn valid_sha(sha: &str) -> Result<(), ApiError> {
    if sha.len() == 64 && sha.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(ApiError::bad_request("sha 必须是 64 位小写十六进制。"))
    }
}

async fn head_blob(State(state): State<AppState>, _caller: Caller, Path(sha): Path<String>) -> Result<StatusCode, ApiError> {
    valid_sha(&sha)?;
    let store = state.store.clone();
    let exists = tokio::task::spawn_blocking(move || store.has_blob(&sha)).await.map_err(ApiError::internal)??;
    Ok(if exists { StatusCode::OK } else { StatusCode::NOT_FOUND })
}

async fn get_blob(State(state): State<AppState>, _caller: Caller, Path(sha): Path<String>) -> Result<Response, ApiError> {
    valid_sha(&sha)?;
    let store = state.store.clone();
    let bytes = tokio::task::spawn_blocking(move || store.get_blob(&sha))
        .await
        .map_err(ApiError::internal)??
        .ok_or_else(ApiError::not_found)?;
    let mut response = (StatusCode::OK, bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    Ok(response)
}

async fn put_blob(
    State(state): State<AppState>,
    _caller: Caller,
    Path(sha): Path<String>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    valid_sha(&sha)?;
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.put_blob(&sha, &body))
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "HASH_MISMATCH", error.to_string()))?;
    Ok(StatusCode::CREATED)
}

#[derive(Deserialize)]
struct ChangesQuery {
    since: Option<i64>,
    limit: Option<usize>,
}

async fn sync_changes(
    State(state): State<AppState>,
    _caller: Caller,
    Query(query): Query<ChangesQuery>,
) -> Result<Response, ApiError> {
    let since = query.since.unwrap_or(0);
    let limit = query.limit.unwrap_or(500).clamp(1, 2000);
    let store = state.store.clone();
    let page = tokio::task::spawn_blocking(move || store.changes_since(since, limit))
        .await
        .map_err(ApiError::internal)??;
    if since < page.floor_seq {
        return Err(ApiError::new(StatusCode::GONE, "RESYNC_REQUIRED", "游标已过保留期，请全量对账。"));
    }
    Ok(Json(json!({
        "vaultId": page.vault_id,
        "epoch": page.epoch,
        "floorSeq": page.floor_seq,
        "headSeq": page.head_seq,
        "more": page.more,
        "changes": page.changes.iter().map(|change| json!({
            "seq": change.seq, "path": change.path, "exists": change.exists, "sha": change.sha, "kind": change.kind,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn sync_manifest(State(state): State<AppState>, _caller: Caller) -> Result<Json<Value>, ApiError> {
    let store = state.store.clone();
    let (entries, epoch, head) = tokio::task::spawn_blocking(move || {
        Ok::<_, shard_store::StoreError>((store.manifest()?, store.meta("epoch")?.unwrap_or_default(), store.head_seq()?))
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(json!({ "epoch": epoch, "headSeq": head, "entries": entries })))
}

#[derive(Deserialize)]
struct FetchBody {
    paths: Vec<String>,
}

/// 批量取内容（内联文件）；大文件只给 sha，客户端再走 `/api/blobs`。
async fn sync_fetch(
    State(state): State<AppState>,
    _caller: Caller,
    Json(body): Json<FetchBody>,
) -> Result<Json<Value>, ApiError> {
    if body.paths.len() > 500 {
        return Err(ApiError::bad_request("一次最多取 500 个文件。"));
    }
    let store = state.store.clone();
    let items = tokio::task::spawn_blocking(move || {
        store.read(|vfs| {
            body.paths
                .iter()
                .map(|path| {
                    let abs = vfs.root().join(path.trim_start_matches('/'));
                    match (vfs.metadata(&abs), vfs.content_sha(&abs)) {
                        (Ok(metadata), Ok(sha)) if metadata.is_file() => {
                            if metadata.len() as usize > shard_store::INLINE_MAX {
                                json!({ "path": path, "sha": sha, "blob": true })
                            } else {
                                let data = vfs.read(&abs).map(|bytes| STANDARD.encode(bytes)).ok();
                                json!({ "path": path, "sha": sha, "data": data })
                            }
                        }
                        _ => json!({ "path": path, "missing": true }),
                    }
                })
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_content_addressed_asset_paths() {
        let sha = "ab".repeat(32);
        assert!(is_content_addressed(&format!("assets/ab/{sha}.png")));
        assert!(!is_content_addressed(&format!("assets/cd/{sha}.png")));
        assert!(!is_content_addressed("notes/证件/营业执照.jpg"));
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(clean_relative("../etc/passwd").is_err());
        assert!(clean_relative("notes/../../x").is_err());
        assert!(clean_relative("/etc/passwd").is_err());
        assert_eq!(clean_relative("./assets/a.png").unwrap(), "assets/a.png");
    }
}
