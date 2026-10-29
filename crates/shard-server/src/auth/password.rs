//! 邮箱与密码：格式校验、argon2id 哈希与校验。
//!
//! 哈希存 PHC 字符串（自带算法、参数与盐），以后调参不影响校验旧哈希。参数取 OWASP 建议的
//! m=19 MiB、t=2、p=1：单次约几十毫秒，在线猜测本来就被限流，离线爆破被拖走的 auth.db 时每次猜测都很贵。

use std::sync::OnceLock;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use rand::rngs::OsRng;

use crate::error::ApiError;

pub const MIN_PASSWORD_CHARS: usize = 8;
/// 上限防的是拿超长输入拖慢哈希。
pub const MAX_PASSWORD_CHARS: usize = 256;
const MAX_EMAIL_CHARS: usize = 254;

fn argon2() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("argon2 参数有效");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// 邮箱只当登录名：去首尾空白、转小写后保存与比较。
pub fn normalize_email(input: &str) -> Result<String, ApiError> {
    let email = input.trim().to_lowercase();
    let valid = email.chars().count() <= MAX_EMAIL_CHARS
        && !email.chars().any(char::is_whitespace)
        && email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty() && !domain.contains('@'));
    if valid {
        Ok(email)
    } else {
        Err(ApiError::bad_request_code("INVALID_EMAIL", "邮箱格式不对。"))
    }
}

pub fn validate_password(password: &str) -> Result<(), ApiError> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(ApiError::bad_request_code(
            "WEAK_PASSWORD",
            format!("密码至少 {MIN_PASSWORD_CHARS} 个字符。"),
        ));
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(ApiError::bad_request_code(
            "WEAK_PASSWORD",
            format!("密码最多 {MAX_PASSWORD_CHARS} 个字符。"),
        ));
    }
    Ok(())
}

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(ApiError::internal)
}

/// 哈希损坏也只当作不匹配。超长输入直接不匹配，不去算哈希。
pub fn verify_password(password: &str, hash: &str) -> bool {
    if password.chars().count() > MAX_PASSWORD_CHARS {
        return false;
    }
    PasswordHash::new(hash)
        .map(|parsed| argon2().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// 邮箱不对时拿它陪算一次：响应时间不随邮箱对错变化，免得据此试出邮箱。
pub fn decoy_hash() -> &'static str {
    static DECOY: OnceLock<String> = OnceLock::new();
    DECOY.get_or_init(|| hash_password("shard-decoy-password").expect("argon2 可用"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_lowercased_and_need_one_at_sign() {
        assert_eq!(normalize_email("  Me@Example.COM ").unwrap(), "me@example.com");
        for bad in ["", "me", "@example.com", "me@", "me@@example.com", "me@exa mple.com", "a@b@c"] {
            assert_eq!(normalize_email(bad).unwrap_err().code, "INVALID_EMAIL", "{bad}");
        }
        assert!(normalize_email(&format!("{}@example.com", "a".repeat(250))).is_err());
    }

    #[test]
    fn passwords_need_eight_to_256_characters() {
        assert_eq!(validate_password("seven77").unwrap_err().code, "WEAK_PASSWORD");
        assert!(validate_password("eight888").is_ok());
        // 按字符而不是字节计：3 个汉字是 9 个字节，仍然太短；8 个汉字够长。
        assert!(validate_password("三个字").is_err());
        assert!(validate_password("八个汉字组成密码").is_ok());
        assert!(validate_password(&"x".repeat(257)).is_err());
    }

    #[test]
    fn hashes_are_salted_argon2id_and_verify_only_the_right_password() {
        let first = hash_password("correct horse battery").unwrap();
        let second = hash_password("correct horse battery").unwrap();
        assert!(first.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{first}");
        assert_ne!(first, second, "每次加盐不同");
        assert!(verify_password("correct horse battery", &first));
        assert!(!verify_password("correct horse battery!", &first));
        assert!(!verify_password("correct horse battery", "not a hash"));
        assert!(!verify_password(&"x".repeat(300), &first));
        assert!(!verify_password("anything", decoy_hash()));
    }
}
