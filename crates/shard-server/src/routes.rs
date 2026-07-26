//! HTTP 端点。

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use shard_core::sync::{ChangesResponse, PushRequest, PushResponse, PROTOCOL_VERSION};

use crate::{db, repo, AppState};

/// 一次拉取最多返回多少条。够大以免来回太多，又不至于让单个响应大到离谱。
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

pub async fn healthz() -> &'static str {
    "ok"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesQuery {
    #[serde(default)]
    since: i64,
    limit: Option<i64>,
}

pub async fn changes(
    State(state): State<AppState>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let conn = state.store.conn().await?;

    let changes = repo::changes_since(&conn, query.since, limit).await?;
    let server_seq = db::current_seq(&conn).await?;

    // 游标取这一批的最大 seq；空批次说明已经追平，原样退回请求里的 since。
    let next_seq = changes.last().map(|c| c.seq()).unwrap_or(query.since);

    Ok(Json(ChangesResponse {
        protocol_version: PROTOCOL_VERSION,
        has_more: next_seq < server_seq,
        changes,
        next_seq,
    }))
}

pub async fn push(
    State(state): State<AppState>,
    Json(request): Json<PushRequest>,
) -> Result<Json<PushResponse>, ApiError> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "协议版本不匹配：客户端 {}，服务端 {PROTOCOL_VERSION}",
                request.protocol_version
            ),
        ));
    }
    if request.device_id.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "缺少 deviceId：冲突诊断时它是唯一线索".to_string(),
        ));
    }

    let conn = state.store.conn().await?;
    let results = repo::apply_push(&conn, &request.device_id, &request.items).await?;
    let max_seq = db::current_seq(&conn).await?;

    Ok(Json(PushResponse { results, max_seq }))
}

/// 去重探测。客户端上传前先问一句，已有就不必再传一遍字节。
pub async fn head_attachment(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<StatusCode, ApiError> {
    let hash = validate_hash(&hash)?;
    if state.attachment_path(&hash).is_file() {
        Ok(StatusCode::OK)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}

pub async fn get_attachment(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let hash = validate_hash(&hash)?;
    let path = state.attachment_path(&hash);

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "附件不存在".to_string()))?;

    let conn = state.store.conn().await?;
    let mime = repo::load_attachment_mime(&conn, &hash)
        .await?
        .unwrap_or_else(|| "application/octet-stream".to_string());

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            // 内容寻址的 URL 永远指向同一份字节。
            (
                header::CACHE_CONTROL,
                "max-age=31536000, immutable".to_string(),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn put_attachment(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    body: axum::body::Bytes,
) -> Result<StatusCode, ApiError> {
    let hash = validate_hash(&hash)?;

    if body.len() > state.config.max_attachment_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("附件超过上限（{} 字节）", state.config.max_attachment_bytes),
        ));
    }

    // 内容寻址的**根基**：服务端必须自己算一遍。不校验的话，任何人都能往
    // 一个 hash 底下塞任意内容，之后所有按 hash 取图的客户端都会拿到它。
    let actual = shard_core::hash_bytes(&body);
    if actual != hash {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "内容摘要与 URL 中的 hash 不符".to_string(),
        ));
    }

    let path = state.attachment_path(&hash);
    if path.is_file() {
        // 文件名就是内容摘要，已存在即已是正确内容。
        return Ok(StatusCode::OK);
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }

    // 先写临时文件再 rename：直接写目标路径时，一次中断的上传会在内容寻址的
    // 位置上留下半截文件，而那个位置的语义是"这就是该 hash 的内容"。
    let temporary = path.with_extension("partial");
    tokio::fs::write(&temporary, &body)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;

    Ok(StatusCode::CREATED)
}

/// 只接受定长十六进制。路径参数直接参与文件名，这里是唯一的把关点。
fn validate_hash(hash: &str) -> Result<String, ApiError> {
    let valid = hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "附件 hash 无效".to_string(),
        ));
    }
    Ok(hash.to_ascii_lowercase())
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: String) -> Self {
        Self { status, message }
    }

    fn internal(message: String) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message,
        }
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        ApiError::internal(message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            tracing::error!(status = %self.status, message = %self.message, "请求失败");
        }
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_validation_rejects_path_tricks() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        for bad in [
            "../../etc/passwd",
            "",
            &"a".repeat(63),
            &"a".repeat(65),
            &format!("{}/x", "a".repeat(62)),
        ] {
            assert!(validate_hash(bad).is_err(), "不该接受 {bad:?}");
        }
    }

    /// 大小写不同的同一个摘要要归一，否则会在磁盘上存成两份。
    #[test]
    fn hash_validation_normalises_case() {
        assert_eq!(validate_hash(&"AB".repeat(32)).unwrap(), "ab".repeat(32));
    }
}
