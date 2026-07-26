//! Bearer 令牌认证。单用户自用，所以没有会话、没有刷新，就一个长期令牌。

use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use crate::AppState;

/// 校验 `Authorization: Bearer <token>`。
///
/// 比较走**常量时间**：普通的 `==` 在第一个不同的字节就返回，攻击者能靠计时
/// 差异一个字节一个字节地把令牌试出来。这条路径每次请求都走，值得用对的写法。
pub async fn require_token(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();

    if !token_matches(presented, &state.config.auth_token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}

fn token_matches(presented: &str, expected: &str) -> bool {
    // 长度不同时仍然做一次比较再返回，避免用长度短路。长度本身会泄漏，
    // 但那远不如逐字节短路那么好利用。
    presented.len() == expected.len()
        && presented.as_bytes().ct_eq(expected.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_token() {
        let expected = "x".repeat(32);
        assert!(token_matches(&expected, &expected));
        assert!(!token_matches("", &expected));
        assert!(!token_matches(&"x".repeat(31), &expected));
        assert!(!token_matches(&format!("{expected}y"), &expected));
        // 前缀正确也不行——逐字节试探必须无从下手。
        assert!(!token_matches(&format!("{}z", "x".repeat(31)), &expected));
    }
}
