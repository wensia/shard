use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::search_contract::{SearchContext, SearchRefresh, SearchScope};

pub(crate) const AUTO_RECONCILE_THROTTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ScopeKey {
    Public,
    Lockbox,
}

impl ScopeKey {
    pub(crate) fn from_scope(scope: &SearchScope) -> Self {
        match scope {
            SearchScope::Public => Self::Public,
            SearchScope::Lockbox => Self::Lockbox,
        }
    }

    pub(crate) fn into_scope(self) -> SearchScope {
        match self {
            Self::Public => SearchScope::Public,
            Self::Lockbox => SearchScope::Lockbox,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefreshKind {
    Auto,
    Reconcile,
    Rebuild,
}

impl RefreshKind {
    pub(crate) fn from_refresh(refresh: &SearchRefresh) -> Self {
        match refresh {
            SearchRefresh::Auto => Self::Auto,
            SearchRefresh::Reconcile => Self::Reconcile,
            SearchRefresh::Rebuild => Self::Rebuild,
        }
    }

    pub(crate) fn into_refresh(self) -> SearchRefresh {
        match self {
            Self::Auto => SearchRefresh::Auto,
            Self::Reconcile => SearchRefresh::Reconcile,
            Self::Rebuild => SearchRefresh::Rebuild,
        }
    }

    fn priority(self) -> u8 {
        match self {
            Self::Auto => 0,
            Self::Reconcile => 1,
            Self::Rebuild => 2,
        }
    }
}

fn strongest(left: RefreshKind, right: RefreshKind) -> RefreshKind {
    if left.priority() >= right.priority() {
        left
    } else {
        right
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ReconcileKey {
    vault_path: String,
    vault_epoch: String,
    privacy_epoch: String,
    scope: ScopeKey,
}

impl ReconcileKey {
    pub(crate) fn new(context: &SearchContext, scope: &SearchScope) -> Self {
        Self {
            vault_path: context.vault_path.clone(),
            vault_epoch: context.vault_epoch.clone(),
            privacy_epoch: context.privacy_epoch.clone(),
            scope: ScopeKey::from_scope(scope),
        }
    }

    pub(crate) fn context(&self) -> SearchContext {
        SearchContext {
            vault_path: self.vault_path.clone(),
            vault_epoch: self.vault_epoch.clone(),
            privacy_epoch: self.privacy_epoch.clone(),
        }
    }

    pub(crate) fn scope(&self) -> SearchScope {
        self.scope.into_scope()
    }
}

pub(crate) trait ReconcileClock: Send + Sync {
    fn now(&self) -> Duration;
}

struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl ReconcileClock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileAction {
    Start {
        token: u64,
        refresh: RefreshKind,
    },
    Schedule {
        token: u64,
        refresh: RefreshKind,
        due_at: Duration,
        delay: Duration,
    },
}

#[derive(Default)]
struct ReconcileSlot {
    running: Option<u64>,
    scheduled: Option<ScheduledReconcile>,
    pending: Option<RefreshKind>,
    last_completed_at: Option<Duration>,
}

#[derive(Clone, Copy)]
struct ScheduledReconcile {
    token: u64,
    refresh: RefreshKind,
    due_at: Duration,
}

#[derive(Default)]
struct ReconcileState {
    next_token: u64,
    slots: HashMap<ReconcileKey, ReconcileSlot>,
}

pub(crate) struct ReconcileCoordinator {
    clock: Arc<dyn ReconcileClock>,
    state: Mutex<ReconcileState>,
}

impl Default for ReconcileCoordinator {
    fn default() -> Self {
        Self::new(Arc::new(SystemClock::new()))
    }
}

impl ReconcileCoordinator {
    pub(crate) fn new(clock: Arc<dyn ReconcileClock>) -> Self {
        Self {
            clock,
            state: Mutex::new(ReconcileState::default()),
        }
    }

    pub(crate) fn request(
        &self,
        key: ReconcileKey,
        refresh: RefreshKind,
    ) -> Option<ReconcileAction> {
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(slot) = state.slots.get_mut(&key) {
            if slot.running.is_some() {
                if refresh != RefreshKind::Auto {
                    slot.pending = Some(
                        slot.pending
                            .map(|pending| strongest(pending, refresh))
                            .unwrap_or(refresh),
                    );
                }
                return None;
            }

            if slot.scheduled.is_some() {
                if refresh == RefreshKind::Auto {
                    return None;
                }
                slot.scheduled = None;
            }
        }

        if refresh == RefreshKind::Auto {
            let due_at = state
                .slots
                .get(&key)
                .and_then(|slot| slot.last_completed_at)
                .map(|completed| completed + AUTO_RECONCILE_THROTTLE);
            if let Some(due_at) = due_at.filter(|due| *due > now) {
                let token = next_token(&mut state);
                state.slots.entry(key).or_default().scheduled = Some(ScheduledReconcile {
                    token,
                    refresh,
                    due_at,
                });
                return Some(ReconcileAction::Schedule {
                    token,
                    refresh,
                    due_at,
                    delay: due_at.saturating_sub(now),
                });
            }
        }

        Some(start_now(&mut state, key, refresh))
    }

    pub(crate) fn fire_scheduled(&self, key: &ReconcileKey, token: u64) -> Option<ReconcileAction> {
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let scheduled = state.slots.get(key)?.scheduled?;
        if scheduled.token != token {
            return None;
        }
        if now < scheduled.due_at {
            return Some(ReconcileAction::Schedule {
                token,
                refresh: scheduled.refresh,
                due_at: scheduled.due_at,
                delay: scheduled.due_at.saturating_sub(now),
            });
        }

        state.slots.get_mut(key)?.scheduled = None;
        Some(start_now(&mut state, key.clone(), scheduled.refresh))
    }

    pub(crate) fn finish(
        &self,
        key: &ReconcileKey,
        token: u64,
        generation_changed: bool,
    ) -> Option<ReconcileAction> {
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slot = state.slots.get_mut(key)?;
        if slot.running != Some(token) {
            return None;
        }

        slot.running = None;
        slot.last_completed_at = Some(now);
        let mut next = slot.pending.take();
        if generation_changed {
            next = Some(
                next.map(|pending| strongest(pending, RefreshKind::Reconcile))
                    .unwrap_or(RefreshKind::Reconcile),
            );
        }
        next.map(|refresh| start_now(&mut state, key.clone(), refresh))
    }

    pub(crate) fn cancel(&self, key: &ReconcileKey) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .slots
            .remove(key);
    }

    pub(crate) fn is_active(&self, key: &ReconcileKey) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .slots
            .get(key)
            .is_some_and(|slot| slot.running.is_some() || slot.scheduled.is_some())
    }
}

fn next_token(state: &mut ReconcileState) -> u64 {
    state.next_token = state.next_token.wrapping_add(1);
    if state.next_token == 0 {
        state.next_token = 1;
    }
    state.next_token
}

fn start_now(
    state: &mut ReconcileState,
    key: ReconcileKey,
    refresh: RefreshKind,
) -> ReconcileAction {
    let token = next_token(state);
    let slot = state.slots.entry(key).or_default();
    slot.running = Some(token);
    slot.scheduled = None;
    ReconcileAction::Start { token, refresh }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    #[derive(Default)]
    struct ManualClock {
        millis: AtomicU64,
    }

    impl ManualClock {
        fn set(&self, value: Duration) {
            self.millis
                .store(u64::try_from(value.as_millis()).unwrap(), Ordering::SeqCst);
        }
    }

    impl ReconcileClock for ManualClock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.millis.load(Ordering::SeqCst))
        }
    }

    fn key() -> ReconcileKey {
        ReconcileKey::new(
            &SearchContext {
                vault_path: "/vault/A".into(),
                vault_epoch: "1".into(),
                privacy_epoch: "0".into(),
            },
            &SearchScope::Public,
        )
    }

    #[test]
    fn search_reconcile_is_single_flight() {
        let clock = Arc::new(ManualClock::default());
        let coordinator = ReconcileCoordinator::new(clock);
        let key = key();

        let Some(ReconcileAction::Start { token, .. }) =
            coordinator.request(key.clone(), RefreshKind::Auto)
        else {
            panic!("first request must start");
        };
        assert_eq!(coordinator.request(key.clone(), RefreshKind::Rebuild), None);

        assert_eq!(
            coordinator.finish(&key, token, false),
            Some(ReconcileAction::Start {
                token: token + 1,
                refresh: RefreshKind::Rebuild,
            })
        );
    }

    #[test]
    fn search_auto_reconcile_uses_two_second_throttle() {
        let clock = Arc::new(ManualClock::default());
        let coordinator = ReconcileCoordinator::new(clock.clone());
        let key = key();

        let Some(ReconcileAction::Start { token, .. }) =
            coordinator.request(key.clone(), RefreshKind::Auto)
        else {
            panic!("initial traversal must start");
        };
        clock.set(Duration::from_millis(100));
        assert_eq!(coordinator.finish(&key, token, false), None);

        clock.set(Duration::from_millis(1_100));
        let scheduled = coordinator
            .request(key.clone(), RefreshKind::Auto)
            .expect("auto request inside the window must be scheduled");
        let ReconcileAction::Schedule {
            token,
            due_at,
            delay,
            ..
        } = scheduled
        else {
            panic!("auto request must not run before the fixed deadline");
        };
        assert_eq!(due_at, Duration::from_millis(2_100));
        assert_eq!(delay, Duration::from_secs(1));

        clock.set(Duration::from_millis(1_900));
        assert_eq!(coordinator.request(key.clone(), RefreshKind::Auto), None);
        assert_eq!(
            coordinator.fire_scheduled(&key, token),
            Some(ReconcileAction::Schedule {
                token,
                refresh: RefreshKind::Auto,
                due_at,
                delay: Duration::from_millis(200),
            })
        );

        clock.set(due_at);
        assert!(matches!(
            coordinator.fire_scheduled(&key, token),
            Some(ReconcileAction::Start {
                refresh: RefreshKind::Auto,
                ..
            })
        ));
    }
}
