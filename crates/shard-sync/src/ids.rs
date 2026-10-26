//! 标识：outbox 的 op_id（UUIDv7 = 幂等键）与冲突副本的确定性 id。

use chrono::{DateTime, FixedOffset, SecondsFormat, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// UUIDv7：前 48 位是毫秒时间戳（按创建先后大致有序，排查时一眼看出先后），其余随机。
pub(crate) fn uuid_v7() -> String {
    let millis = Utc::now().timestamp_millis().max(0) as u64;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// 冲突副本的 op_id：由原操作确定性派生，重试、重启后再处理同一个冲突也只会有这一个键。
pub(crate) fn conflict_op_id(op_id: &str) -> String {
    format!("{op_id}:conflict")
}

/// 冲突副本的碎片 id：时间取原操作发生的时刻（按当时的时区），随机部分取 op_id 的哈希。
/// 形状与 `shard_core::new_fragment_id` 一致（服务器按 `is_valid_fragment_id` 校验）。
pub(crate) fn conflict_fragment_id(op_id: &str, at: &DateTime<FixedOffset>) -> String {
    let digest = Sha256::digest(conflict_op_id(op_id).as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}", at.format("%Y%m%d-%H%M%S"), &hex[..8], &hex[8..14])
}

/// 按分钟偏移取当前时间（离线新建的 createdAt、冲突副本的时间）。
pub(crate) fn now_at(utc_offset_minutes: i32) -> DateTime<FixedOffset> {
    let offset = FixedOffset::east_opt(utc_offset_minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"));
    Utc::now().with_timezone(&offset)
}

/// 库里记时间的写法（与 shard-store 一致：UTC、微秒）。
pub(crate) fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Micros, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v7_has_version_and_variant_bits() {
        let id = uuid_v7();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
        assert_ne!(id, uuid_v7());
    }

    #[test]
    fn conflict_ids_are_deterministic_and_valid() {
        let at = DateTime::parse_from_rfc3339("2026-10-27T08:30:05+08:00").unwrap();
        let first = conflict_fragment_id("0192-op", &at);
        assert_eq!(first, conflict_fragment_id("0192-op", &at));
        assert_ne!(first, conflict_fragment_id("0192-other", &at));
        assert!(first.starts_with("20261027-083005-"), "{first}");
        assert!(shard_core::is_valid_fragment_id(&first), "{first}");
    }
}
