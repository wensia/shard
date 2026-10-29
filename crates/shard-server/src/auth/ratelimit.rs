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
        self.take(scope, key, per_minute, Duration::from_secs(60), Instant::now())
    }

    /// 每个 `window` 最多 `capacity` 次，记一次。返回 false 表示额度已用完。
    pub fn record(&self, scope: &str, key: &str, capacity: u32, window: Duration) -> bool {
        self.take(scope, key, capacity, window, Instant::now())
    }

    /// 只看还有没有额度，不记次数（先看失败额度，失败了再 [`Self::record`]）。
    pub fn available(&self, scope: &str, key: &str, capacity: u32, window: Duration) -> bool {
        self.refill(scope, key, capacity, window, Instant::now(), false)
    }

    fn take(&self, scope: &str, key: &str, capacity: u32, window: Duration, now: Instant) -> bool {
        self.refill(scope, key, capacity, window, now, true)
    }

    fn refill(&self, scope: &str, key: &str, capacity: u32, window: Duration, now: Instant, consume: bool) -> bool {
        let capacity = f64::from(capacity.max(1));
        let mut buckets = self.buckets.lock().expect("限流锁中毒");
        if buckets.len() > 10_000 {
            buckets.retain(|_, bucket| now.duration_since(bucket.updated) < Duration::from_secs(600));
        }
        let bucket = buckets
            .entry((scope.to_string(), key.to_string()))
            .or_insert(Bucket { tokens: capacity, updated: now });
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * capacity / window.as_secs_f64()).min(capacity);
        bucket.updated = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        if consume {
            bucket.tokens -= 1.0;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_a_burst_then_refills_over_time() {
        let limiter = RateLimiter::default();
        let start = Instant::now();
        let minute = Duration::from_secs(60);
        for _ in 0..10 {
            assert!(limiter.take("login", "1.2.3.4", 10, minute, start));
        }
        assert!(!limiter.take("login", "1.2.3.4", 10, minute, start));
        // 另一个 IP、另一个场景互不影响。
        assert!(limiter.take("login", "5.6.7.8", 10, minute, start));
        assert!(limiter.take("stepup", "1.2.3.4", 10, minute, start));
        // 6 秒回一个令牌。
        assert!(limiter.take("login", "1.2.3.4", 10, minute, start + Duration::from_secs(6)));
        assert!(!limiter.take("login", "1.2.3.4", 10, minute, start + Duration::from_secs(6)));
    }

    #[test]
    fn peeking_does_not_spend_and_long_windows_refill_slowly() {
        let limiter = RateLimiter::default();
        let start = Instant::now();
        let hour = Duration::from_secs(3600);
        for _ in 0..5 {
            assert!(limiter.refill("failures", "all", 2, hour, start, false));
        }
        assert!(limiter.take("failures", "all", 2, hour, start));
        assert!(limiter.take("failures", "all", 2, hour, start));
        assert!(!limiter.refill("failures", "all", 2, hour, start, false));
        // 每小时 2 次：半小时回一次。
        assert!(!limiter.refill("failures", "all", 2, hour, start + Duration::from_secs(1700), false));
        assert!(limiter.refill("failures", "all", 2, hour, start + Duration::from_secs(1800), false));
    }
}
