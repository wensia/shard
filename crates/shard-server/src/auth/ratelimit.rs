//! 进程内令牌桶限流，按（场景, IP）计。单进程单用户，不需要外部存储。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Bucket {
    tokens: f64,
    updated: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, String), Bucket>>,
}

impl RateLimiter {
    /// 每分钟最多 `per_minute` 次（允许一次性用满）。返回 false 表示应当拒绝。
    pub fn check(&self, scope: &str, key: &str, per_minute: u32) -> bool {
        self.check_at(scope, key, per_minute, Instant::now())
    }

    fn check_at(&self, scope: &str, key: &str, per_minute: u32, now: Instant) -> bool {
        let capacity = f64::from(per_minute.max(1));
        let mut buckets = self.buckets.lock().expect("限流锁中毒");
        if buckets.len() > 10_000 {
            buckets.retain(|_, bucket| now.duration_since(bucket.updated) < Duration::from_secs(600));
        }
        let bucket = buckets
            .entry((scope.to_string(), key.to_string()))
            .or_insert(Bucket { tokens: capacity, updated: now });
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * capacity / 60.0).min(capacity);
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_a_burst_then_refills_over_time() {
        let limiter = RateLimiter::default();
        let start = Instant::now();
        for _ in 0..10 {
            assert!(limiter.check_at("login", "1.2.3.4", 10, start));
        }
        assert!(!limiter.check_at("login", "1.2.3.4", 10, start));
        // 另一个 IP、另一个场景互不影响。
        assert!(limiter.check_at("login", "5.6.7.8", 10, start));
        assert!(limiter.check_at("pair", "1.2.3.4", 10, start));
        // 6 秒回一个令牌。
        assert!(limiter.check_at("login", "1.2.3.4", 10, start + Duration::from_secs(6)));
        assert!(!limiter.check_at("login", "1.2.3.4", 10, start + Duration::from_secs(6)));
    }
}
