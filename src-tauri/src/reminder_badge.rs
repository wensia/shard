//! 备忘提醒的 Dock 角标调度。
//!
//! 前端把所有「未勾选任务项」的提醒时间（毫秒时间戳）整表推过来，这里用一个
//! 常驻后台线程计算「已到点」的数量，变化时通过 `WebviewWindow::set_badge_count`
//! 写到 macOS Dock 图标上。放在 Rust 线程里而不是前端 `setInterval`，是为了窗口
//! 在后台或最小化时不受 WebView 定时器节流影响。

use std::{
    sync::{Condvar, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, Runtime, State};

/// 主窗口标签（tauri.conf.json 里未显式命名的第一个窗口即 `main`）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 单次等待上限。`Condvar::wait_timeout` 走单调时钟，macOS 睡眠期间单调时钟不前进，
/// 等得太久会让唤醒后的到点判断滞后；封顶一分钟，睡眠唤醒后最多晚一分钟补上。
const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct ScheduleState {
    due_at: Vec<i64>,
    /// 前端推送了新列表但后台线程还没处理。
    changed: bool,
}

#[derive(Default)]
pub struct ReminderSchedule {
    state: Mutex<ScheduleState>,
    wake: Condvar,
}

impl ReminderSchedule {
    fn replace(&self, due_at: Vec<i64>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.due_at = due_at;
        state.changed = true;
        self.wake.notify_all();
    }
}

/// 某一时刻的角标计划：已到点的数量，以及下一个未到点的时间。
#[derive(Debug, PartialEq, Eq)]
struct BadgePlan {
    due_count: usize,
    next_due_at: Option<i64>,
}

fn badge_plan(due_at: &[i64], now: i64) -> BadgePlan {
    BadgePlan {
        due_count: due_at.iter().filter(|&&at| at <= now).count(),
        next_due_at: due_at.iter().copied().filter(|&at| at > now).min(),
    }
}

fn wait_duration(next_due_at: Option<i64>, now: i64) -> Duration {
    match next_due_at {
        // 多等 1ms 越过边界，醒来时这一项一定已经 `<= now`。
        Some(at) => Duration::from_millis(u64::try_from(at - now).unwrap_or(0) + 1).min(MAX_WAIT),
        None => MAX_WAIT,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn apply_badge<R: Runtime>(app: &AppHandle<R>, count: usize) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let badge = if count > 0 {
        Some(i64::try_from(count).unwrap_or(i64::MAX))
    } else {
        None
    };
    // 非 macOS 平台可能不支持角标，失败只记日志，不影响应用。
    if let Err(error) = window.set_badge_count(badge) {
        eprintln!("[shard] 设置 Dock 角标失败：{error}");
    }
}

/// 启动常驻后台线程。`set_badge_count` 只是向事件循环投递消息，不阻塞 UI 线程。
pub fn spawn_badge_worker<R: Runtime>(app: AppHandle<R>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("shard-reminder-badge".into())
        .spawn(move || {
            let schedule = app.state::<ReminderSchedule>();
            let mut shown: Option<usize> = None;
            let mut state = schedule
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            loop {
                state.changed = false;
                let now = now_millis();
                let plan = badge_plan(&state.due_at, now);
                if shown != Some(plan.due_count) {
                    apply_badge(&app, plan.due_count);
                    shown = Some(plan.due_count);
                }
                let timeout = wait_duration(plan.next_due_at, now);
                // 被新列表唤醒（changed）或等到下一个到点时间都重新计算；伪唤醒也只是多算一次。
                state = schedule
                    .wake
                    .wait_timeout_while(state, timeout, |state| !state.changed)
                    .map(|(guard, _)| guard)
                    .unwrap_or_else(|error| error.into_inner().0);
            }
        })
        .map(|_| ())
}

/// 前端推送全部未勾选提醒的到点时间（毫秒时间戳，本地时区已折算）。
#[tauri::command]
pub async fn set_reminder_schedule(
    schedule: State<'_, ReminderSchedule>,
    due_at: Vec<i64>,
) -> Result<(), String> {
    schedule.replace(due_at);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_due_reminders_and_finds_next() {
        assert_eq!(
            badge_plan(&[100, 300, 200, 50], 200),
            BadgePlan {
                due_count: 3,
                next_due_at: Some(300)
            }
        );
        assert_eq!(
            badge_plan(&[], 200),
            BadgePlan {
                due_count: 0,
                next_due_at: None
            }
        );
        assert_eq!(
            badge_plan(&[500, 400], 200),
            BadgePlan {
                due_count: 0,
                next_due_at: Some(400)
            }
        );
    }

    #[test]
    fn waits_until_next_due_but_never_longer_than_cap() {
        assert_eq!(wait_duration(Some(1_500), 1_000), Duration::from_millis(501));
        assert_eq!(wait_duration(None, 1_000), MAX_WAIT);
        assert_eq!(
            wait_duration(Some(1_000 + 3_600_000), 1_000),
            MAX_WAIT
        );
    }

    #[test]
    fn replacing_schedule_marks_it_changed() {
        let schedule = ReminderSchedule::default();
        schedule.replace(vec![1, 2, 3]);
        let state = schedule.state.lock().unwrap();
        assert!(state.changed);
        assert_eq!(state.due_at, vec![1, 2, 3]);
    }
}
