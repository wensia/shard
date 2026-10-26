//! 令牌与时间的小工具。所有令牌 32 字节随机，库里只存 sha256。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, Rng, RngCore};
use sha2::{Digest, Sha256};

/// 设备令牌前缀，便于在日志与密钥扫描里一眼认出（日志本身会脱敏）。
pub const DEVICE_TOKEN_PREFIX: &str = "shd_dev_";

/// 配对码字母表：去掉了容易看错的 0/O、1/I/L、U/V。
const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTWXYZ23456789";

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn device_token() -> String {
    format!("{DEVICE_TOKEN_PREFIX}{}", random_token())
}

pub fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// 8 位配对码，显示时写成 `ABCD-EFGH`。
pub fn user_code() -> String {
    let mut rng = OsRng;
    (0..8)
        .map(|_| USER_CODE_ALPHABET[rng.gen_range(0..USER_CODE_ALPHABET.len())] as char)
        .collect()
}

/// 用户输入的配对码：去掉分隔符与空白、转大写。
pub fn normalize_user_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn now_text() -> String {
    Utc::now().to_rfc3339()
}

pub fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_random_and_url_safe() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(device_token().starts_with(DEVICE_TOKEN_PREFIX));
    }

    #[test]
    fn user_codes_avoid_ambiguous_characters() {
        for _ in 0..200 {
            let code = user_code();
            assert_eq!(code.len(), 8);
            assert!(!code.contains(['0', 'O', '1', 'I', 'L', 'U', 'V']));
        }
        assert_eq!(normalize_user_code(" abcd-efgh "), "ABCDEFGH");
    }
}
