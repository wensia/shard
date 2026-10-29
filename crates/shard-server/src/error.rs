//! 统一的错误响应：`{code, message}`。内部错误只记日志，不把细节（路径、SQL）回给客户端。

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    /// 结构化错误（搜索命令的 `{code, …}` 契约），原样放进响应的 `error` 字段，前端按对象处理。
    pub detail: Option<serde_json::Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into(), detail: None }
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED", "需要登录。")
    }

    pub fn forbidden(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
    }

    /// 带具体错误码的 400（例如 `INVALID_EMAIL`、`WEAK_PASSWORD`），前端可按码处理。
    pub fn bad_request_code(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn invalid_credentials(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "INVALID_CREDENTIALS", message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "不存在。")
    }

    pub fn too_many() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED", "请求太频繁，请稍后再试。")
    }

    pub fn step_up_required() -> Self {
        Self::forbidden("STEP_UP_REQUIRED", "这个操作需要再输入一次密码。")
    }

    /// 内部错误：细节进日志，客户端只看到通用提示。
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "内部错误");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "服务器出错了，请稍后再试。")
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<shard_store::StoreError> for ApiError {
    fn from(error: shard_store::StoreError) -> Self {
        ApiError::internal(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = match self.detail {
            Some(detail) => json!({ "code": self.code, "message": self.message, "error": detail }),
            None => json!({ "code": self.code, "message": self.message }),
        };
        let mut response = (self.status, Json(body)).into_response();
        response
            .headers_mut()
            .insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
        response
    }
}
