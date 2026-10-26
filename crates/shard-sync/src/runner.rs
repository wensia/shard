//! 后台同步线程：同一时刻只跑一轮；SSE 的 vault-changed / resync、联网恢复、本地写、唤醒都触发一轮，
//! 期间的多次触发合并成一次。离线时按 1–60 秒退避（加抖动）探测；有操作在退避就等到它的时刻。
//! 唤醒检测：墙上时间比单调时钟多走了很多（睡眠期间单调时钟不走），说明刚从睡眠中醒来，马上同步一轮。

use std::{
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant, SystemTime},
};

use rand::Rng;

use crate::engine::SyncEngine;

pub(crate) enum RunnerMsg {
    Trigger,
    Stop,
}

/// 检查唤醒的间隔。
const TICK: Duration = Duration::from_secs(15);
/// 在线、没有待补交时的例行同步间隔（SSE 断了也能跟上）。
const IDLE: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// 墙上时间比单调时钟多走这么多，就当作刚睡醒。
const WAKE_DRIFT: Duration = Duration::from_secs(30);

pub struct SyncRunner {
    sender: mpsc::Sender<RunnerMsg>,
}

fn jitter(base: Duration) -> Duration {
    base.mul_f64(rand::thread_rng().gen_range(0.5..1.0)).max(Duration::from_millis(500))
}

impl SyncRunner {
    /// 起后台线程并立即同步一轮（启动时先用副本秒开，这一轮在后台跟上服务器）。
    pub fn start(engine: Arc<SyncEngine>) -> Self {
        let (sender, receiver) = mpsc::channel();
        engine.set_trigger(sender.clone());
        let _ = sender.send(RunnerMsg::Trigger);
        thread::Builder::new()
            .name("shard-sync".to_string())
            .spawn(move || run(engine, receiver))
            .expect("起不了同步线程");
        Self { sender }
    }

    pub fn trigger(&self) {
        let _ = self.sender.send(RunnerMsg::Trigger);
    }

    /// 停止（不等当前这一轮结束）。
    pub fn stop(&self) {
        let _ = self.sender.send(RunnerMsg::Stop);
    }
}

impl Drop for SyncRunner {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(engine: Arc<SyncEngine>, receiver: mpsc::Receiver<RunnerMsg>) {
    let mut deadline = Instant::now() + IDLE;
    let mut offline_backoff = Duration::from_secs(1);
    let mut wall = SystemTime::now();
    let mut mono = Instant::now();
    loop {
        let wait = deadline.saturating_duration_since(Instant::now()).min(TICK);
        let mut due = match receiver.recv_timeout(wait) {
            Ok(RunnerMsg::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Ok(RunnerMsg::Trigger) => true,
            Err(mpsc::RecvTimeoutError::Timeout) => Instant::now() >= deadline,
        };
        // 合并排队的触发。
        while let Ok(message) = receiver.try_recv() {
            match message {
                RunnerMsg::Stop => return,
                RunnerMsg::Trigger => due = true,
            }
        }
        let wall_elapsed = SystemTime::now().duration_since(wall).unwrap_or_default();
        let mono_elapsed = mono.elapsed();
        if wall_elapsed > mono_elapsed + WAKE_DRIFT {
            due = true;
        }
        wall = SystemTime::now();
        mono = Instant::now();
        if !due {
            continue;
        }
        let report = engine.sync_round();
        let next = if report.auth_required {
            IDLE
        } else if report.offline {
            let wait = jitter(offline_backoff);
            offline_backoff = (offline_backoff * 2).min(MAX_BACKOFF);
            wait
        } else {
            offline_backoff = Duration::from_secs(1);
            match report.retry_at {
                Some(at) => (at - chrono::Utc::now()).to_std().unwrap_or_default().max(Duration::from_millis(200)),
                None => IDLE,
            }
        };
        deadline = Instant::now() + next;
    }
}
