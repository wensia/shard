use std::{
    collections::HashMap,
    marker::PhantomData,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Component, Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock, Weak,
    },
    thread,
};

use shard_core::search::ProjectedDocument;

use crate::{
    search_contract::{SearchContext, SearchError, SearchRefresh, SearchScope},
    search_lockbox::LockboxLeaseAuthorization,
    search_reconcile::{
        ReconcileAction, ReconcileCoordinator, ReconcileKey, RefreshKind, ScopeKey,
    },
    search_sources::{SearchDocumentMetadata, SourceRecord},
};

#[derive(Debug)]
pub(crate) struct SearchSnapshot {
    pub(crate) snapshot_id: String,
    pub(crate) scope: SearchScope,
    pub(crate) generation: u64,
    pub(crate) source_stamp: String,
    pub(crate) documents: Vec<ProjectedDocument>,
    pub(crate) metadata: HashMap<String, SearchDocumentMetadata>,
    pub(crate) sources: HashMap<String, SourceRecord>,
    pub(crate) skipped_files: u32,
    authorization: Option<LockboxLeaseAuthorization>,
}

impl SearchSnapshot {
    pub(crate) fn from_draft(
        draft: SearchSnapshotDraft,
        scope: SearchScope,
        generation: u64,
    ) -> Self {
        let SearchSnapshotDraft {
            snapshot_id,
            source_stamp,
            documents,
            metadata,
            sources,
            skipped_files,
            authorization,
        } = draft;
        Self {
            snapshot_id,
            scope: scope.clone(),
            generation,
            source_stamp,
            documents,
            metadata,
            sources,
            skipped_files,
            authorization: if matches!(scope, SearchScope::Lockbox) {
                authorization
            } else {
                None
            },
        }
    }

    pub(crate) fn validate_authorization(
        &self,
        context: &SearchContext,
    ) -> Result<(), SearchError> {
        match (&self.scope, &self.authorization) {
            (SearchScope::Public, _) => Ok(()),
            (SearchScope::Lockbox, Some(authorization)) => authorization.validate(context),
            (SearchScope::Lockbox, None) => Err(SearchError::ContextExpired),
        }
    }
}

pub(crate) struct SearchSnapshotDraft {
    pub(crate) snapshot_id: String,
    pub(crate) source_stamp: String,
    pub(crate) documents: Vec<ProjectedDocument>,
    pub(crate) metadata: HashMap<String, SearchDocumentMetadata>,
    pub(crate) sources: HashMap<String, SourceRecord>,
    pub(crate) skipped_files: u32,
    pub(crate) authorization: Option<LockboxLeaseAuthorization>,
}

pub(crate) struct SearchBuildRequest {
    pub(crate) context: SearchContext,
    pub(crate) scope: SearchScope,
    pub(crate) refresh: SearchRefresh,
    pub(crate) start_generation: u64,
    pub(crate) force_read_all: bool,
    pub(crate) previous: Option<Arc<SearchSnapshot>>,
}

type SnapshotBuilder =
    dyn Fn(SearchBuildRequest) -> Result<SearchSnapshotDraft, SearchError> + Send + Sync + 'static;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SnapshotFreshness {
    Missing,
    Fresh,
    Stale,
}

pub(crate) struct SearchSnapshotView {
    pub(crate) snapshot: Option<Arc<SearchSnapshot>>,
    pub(crate) freshness: SnapshotFreshness,
    pub(crate) indexing: bool,
    pub(crate) warning: Option<SearchError>,
}

#[derive(Default)]
struct ExclusiveGate {
    held: Mutex<bool>,
    available: Condvar,
}

impl ExclusiveGate {
    fn acquire(&self) {
        self.acquire_with_wait_hook(|| {});
    }

    fn acquire_with_wait_hook<F>(&self, on_wait: F)
    where
        F: FnOnce(),
    {
        let mut on_wait = Some(on_wait);
        let mut held = self
            .held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *held {
            if let Some(on_wait) = on_wait.take() {
                on_wait();
            }
            held = self
                .available
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *held = true;
    }

    fn release(&self) {
        let mut held = self
            .held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *held = false;
        self.available.notify_one();
    }

    fn lock(&self) -> ExclusiveGateGuard<'_> {
        self.acquire();
        ExclusiveGateGuard { gate: self }
    }
}

struct ExclusiveGateGuard<'a> {
    gate: &'a ExclusiveGate,
}

impl Drop for ExclusiveGateGuard<'_> {
    fn drop(&mut self) {
        self.gate.release();
    }
}

#[derive(Default)]
struct PublicationState {
    generation: u64,
    context: Option<SearchContext>,
    snapshots: [Option<Arc<SearchSnapshot>>; 2],
    refreshing: [bool; 2],
    warnings: [Option<SearchError>; 2],
}

struct VaultEntry {
    gate: ExclusiveGate,
    scan_gates: [ExclusiveGate; 2],
    publication: Mutex<PublicationState>,
}

impl Default for VaultEntry {
    fn default() -> Self {
        Self {
            gate: ExclusiveGate::default(),
            scan_gates: [ExclusiveGate::default(), ExclusiveGate::default()],
            publication: Mutex::new(PublicationState::default()),
        }
    }
}

#[derive(Clone)]
struct ActiveVault {
    key: PathBuf,
    context: SearchContext,
}

struct SearchRuntimeInner {
    entries: Mutex<HashMap<PathBuf, Arc<VaultEntry>>>,
    active: Mutex<Option<ActiveVault>>,
    next_vault_epoch: AtomicU64,
    next_privacy_epoch: AtomicU64,
    builder: Mutex<Option<Arc<SnapshotBuilder>>>,
    reconciler: ReconcileCoordinator,
}

impl Default for SearchRuntimeInner {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            next_vault_epoch: AtomicU64::new(0),
            next_privacy_epoch: AtomicU64::new(0),
            builder: Mutex::new(None),
            reconciler: ReconcileCoordinator::default(),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct SearchRuntime {
    inner: Arc<SearchRuntimeInner>,
}

pub(crate) struct VaultWriteGuard {
    runtime: Weak<SearchRuntimeInner>,
    entry: Arc<VaultEntry>,
    active: bool,
    // std mutex guards are intentionally not carried across await. Keep the replacement
    // guard !Send as well, so a command cannot accidentally hold the vault gate over await.
    _not_send: PhantomData<Rc<()>>,
}

impl VaultWriteGuard {
    /// A public document that is about to cross the privacy boundary must disappear
    /// immediately. The caller already owns this entry's physical write gate, so no
    /// second gate acquisition is allowed here.
    pub(crate) fn invalidate_public_snapshot(&self) {
        let (context, retired) = {
            let mut publication = self
                .entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            debug_assert_eq!(publication.generation % 2, 1);
            let index = scope_index(&SearchScope::Public);
            publication.refreshing[index] = false;
            publication.warnings[index] = None;
            (
                publication.context.clone(),
                publication.snapshots[index].take(),
            )
        };
        drop(retired);
        if let (Some(inner), Some(context)) = (self.runtime.upgrade(), context) {
            inner
                .reconciler
                .cancel(&ReconcileKey::new(&context, &SearchScope::Public));
        }
    }
}

impl Drop for VaultWriteGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }

        let context = {
            let mut publication = self
                .entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            publication.generation = publication.generation.wrapping_add(1);
            debug_assert_eq!(publication.generation % 2, 0);
            publication.context.clone()
        };
        self.entry.gate.release();
        self.active = false;

        if let (Some(inner), Some(context)) = (self.runtime.upgrade(), context) {
            SearchRuntime { inner }.request_reconcile(
                context,
                SearchScope::Public,
                SearchRefresh::Auto,
            );
        }
    }
}

struct CapturedBuild {
    start_generation: u64,
    previous: Option<Arc<SearchSnapshot>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublishOutcome {
    Published,
    Reused,
    RejectedGeneration,
    RejectedContext,
    RejectedAuthorization,
}

impl SearchRuntime {
    fn entry(&self, vault: &Path) -> Arc<VaultEntry> {
        let key = normalized_vault_key(vault);
        let mut entries = self
            .inner
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries
            .entry(key)
            .or_insert_with(|| Arc::new(VaultEntry::default()))
            .clone()
    }

    pub(crate) fn acquire_write_guard(&self, vault: &Path) -> Result<VaultWriteGuard, SearchError> {
        self.acquire_write_guard_with_hook(vault, || {})
    }

    fn acquire_write_guard_with_hook<F>(
        &self,
        vault: &Path,
        after_physical_gate: F,
    ) -> Result<VaultWriteGuard, SearchError>
    where
        F: FnOnce(),
    {
        self.acquire_write_guard_with_hooks(vault, || {}, after_physical_gate)
    }

    fn acquire_write_guard_with_hooks<W, A>(
        &self,
        vault: &Path,
        on_wait: W,
        after_physical_gate: A,
    ) -> Result<VaultWriteGuard, SearchError>
    where
        W: FnOnce(),
        A: FnOnce(),
    {
        let entry = self.entry(vault);
        entry.gate.acquire_with_wait_hook(on_wait);
        after_physical_gate();
        {
            let mut publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if publication.generation % 2 != 0 {
                entry.gate.release();
                return Err(SearchError::Internal { retryable: true });
            }
            publication.generation = publication.generation.wrapping_add(1);
            debug_assert_eq!(publication.generation % 2, 1);
        }

        Ok(VaultWriteGuard {
            runtime: Arc::downgrade(&self.inner),
            entry,
            active: true,
            _not_send: PhantomData,
        })
    }

    pub(crate) fn activate_vault(&self, vault: &Path) -> SearchContext {
        let key = normalized_vault_key(vault);
        let context = SearchContext {
            vault_path: vault.display().to_string(),
            vault_epoch: self.next_vault_epoch().to_string(),
            privacy_epoch: "0".to_string(),
        };

        let (previous, retired_snapshots) = {
            let mut active = self
                .inner
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut retired_snapshots = Vec::new();
            let previous = active.replace(ActiveVault {
                key: key.clone(),
                context: context.clone(),
            });

            if let Some(previous) = &previous {
                let entry = self.entry(&previous.key);
                let mut publication = entry
                    .publication
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                publication.context = None;
                retired_snapshots.extend(publication.snapshots.iter_mut().filter_map(Option::take));
                publication.refreshing = [false, false];
                publication.warnings = [None, None];
            }

            let entry = self.entry(&key);
            let mut publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            publication.context = Some(context.clone());
            retired_snapshots.extend(publication.snapshots.iter_mut().filter_map(Option::take));
            publication.refreshing = [false, false];
            publication.warnings = [None, None];
            (previous, retired_snapshots)
        };
        drop(retired_snapshots);

        if let Some(previous) = previous {
            self.cancel_context(&previous.context);
        }
        context
    }

    pub(crate) fn active_context(&self, vault: &Path) -> Option<SearchContext> {
        let key = normalized_vault_key(vault);
        let mut active = self
            .inner
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(active) = active.as_ref() {
            return (active.key == key).then(|| active.context.clone());
        }

        let context = SearchContext {
            vault_path: vault.display().to_string(),
            vault_epoch: self.next_vault_epoch().to_string(),
            privacy_epoch: "0".to_string(),
        };
        let entry = self.entry(&key);
        let mut publication = entry
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let retired_snapshots = publication
            .snapshots
            .iter_mut()
            .filter_map(Option::take)
            .collect::<Vec<_>>();
        publication.context = Some(context.clone());
        publication.refreshing = [false, false];
        publication.warnings = [None, None];
        *active = Some(ActiveVault {
            key,
            context: context.clone(),
        });
        drop(publication);
        drop(active);
        drop(retired_snapshots);
        Some(context)
    }

    pub(crate) fn revoke_lockbox(&self, vault: &Path) -> Option<SearchContext> {
        let key = normalized_vault_key(vault);
        let (previous, next, retired) = {
            let mut active = self
                .inner
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let active = active.as_mut()?;
            if active.key != key {
                return None;
            }

            let previous = active.context.clone();
            let entry = self.entry(&key);
            let mut publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !publication
                .context
                .as_ref()
                .is_some_and(|current| contexts_equal(current, &previous))
            {
                return None;
            }

            let mut next = previous.clone();
            next.privacy_epoch = self.next_privacy_epoch().to_string();
            active.context = next.clone();
            publication.context = Some(next.clone());
            let index = scope_index(&SearchScope::Lockbox);
            let retired = publication.snapshots[index].take();
            // The context identity includes privacy_epoch, so every in-flight build for
            // the previous context is cancelled even though the public snapshot is kept.
            publication.refreshing = [false, false];
            publication.warnings[index] = None;
            (previous, next, retired)
        };
        drop(retired);
        self.cancel_context(&previous);
        Some(next)
    }

    pub(crate) fn validate_context(&self, context: &SearchContext) -> Result<(), SearchError> {
        if self.context_is_current(context) {
            Ok(())
        } else {
            Err(SearchError::ContextExpired)
        }
    }

    pub(crate) fn clone_snapshot(
        &self,
        context: &SearchContext,
        scope: SearchScope,
    ) -> Result<Option<Arc<SearchSnapshot>>, SearchError> {
        let entry = self.entry(Path::new(&context.vault_path));
        let snapshot = {
            let publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !publication
                .context
                .as_ref()
                .is_some_and(|current| contexts_equal(current, context))
            {
                return Err(SearchError::ContextExpired);
            }
            publication.snapshots[scope_index(&scope)].clone()
        };
        if let Some(snapshot) = &snapshot {
            snapshot.validate_authorization(context)?;
        }
        Ok(snapshot)
    }

    pub(crate) fn snapshot_freshness(
        &self,
        context: &SearchContext,
        scope: SearchScope,
    ) -> Result<SnapshotFreshness, SearchError> {
        let entry = self.entry(Path::new(&context.vault_path));
        let (snapshot, freshness) = {
            let publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !publication
                .context
                .as_ref()
                .is_some_and(|current| contexts_equal(current, context))
            {
                return Err(SearchError::ContextExpired);
            }
            let Some(snapshot) = publication.snapshots[scope_index(&scope)].clone() else {
                return Ok(SnapshotFreshness::Missing);
            };
            let freshness = if publication.generation % 2 == 0
                && snapshot.generation == publication.generation
                && !publication.refreshing[scope_index(&scope)]
                && publication.warnings[scope_index(&scope)].is_none()
            {
                SnapshotFreshness::Fresh
            } else {
                SnapshotFreshness::Stale
            };
            (snapshot, freshness)
        };
        snapshot.validate_authorization(context)?;
        Ok(freshness)
    }

    pub(crate) fn snapshot_view(
        &self,
        context: &SearchContext,
        scope: SearchScope,
    ) -> Result<SearchSnapshotView, SearchError> {
        let entry = self.entry(Path::new(&context.vault_path));
        let view = {
            let publication = entry
                .publication
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !publication
                .context
                .as_ref()
                .is_some_and(|current| contexts_equal(current, context))
            {
                return Err(SearchError::ContextExpired);
            }
            let index = scope_index(&scope);
            let snapshot = publication.snapshots[index].clone();
            let freshness = match snapshot.as_ref() {
                None => SnapshotFreshness::Missing,
                Some(snapshot)
                    if publication.generation % 2 == 0
                        && snapshot.generation == publication.generation
                        && !publication.refreshing[index]
                        && publication.warnings[index].is_none() =>
                {
                    SnapshotFreshness::Fresh
                }
                Some(_) => SnapshotFreshness::Stale,
            };
            SearchSnapshotView {
                snapshot,
                freshness,
                indexing: publication.refreshing[index],
                warning: publication.warnings[index].clone(),
            }
        };
        if let Some(snapshot) = &view.snapshot {
            snapshot.validate_authorization(context)?;
        }
        Ok(view)
    }

    pub(crate) fn generation(&self, vault: &Path) -> u64 {
        self.entry(vault)
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
    }

    pub(crate) fn install_snapshot_builder<F>(&self, builder: F)
    where
        F: Fn(SearchBuildRequest) -> Result<SearchSnapshotDraft, SearchError>
            + Send
            + Sync
            + 'static,
    {
        *self
            .inner
            .builder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(builder));
    }

    pub(crate) fn request_reconcile(
        &self,
        context: SearchContext,
        scope: SearchScope,
        refresh: SearchRefresh,
    ) {
        if self
            .inner
            .builder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none()
            || !self.context_is_current(&context)
        {
            return;
        }

        let key = ReconcileKey::new(&context, &scope);
        if let Some(action) = self
            .inner
            .reconciler
            .request(key.clone(), RefreshKind::from_refresh(&refresh))
        {
            self.dispatch(key, action);
        }
    }

    pub(crate) fn is_reconciling(&self, context: &SearchContext, scope: &SearchScope) -> bool {
        self.inner
            .reconciler
            .is_active(&ReconcileKey::new(context, scope))
    }

    fn dispatch(&self, key: ReconcileKey, action: ReconcileAction) {
        match action {
            ReconcileAction::Start { token, refresh } => {
                if !self.mark_refresh_started(&key) {
                    self.inner.reconciler.cancel(&key);
                    return;
                }
                let runtime = self.clone();
                let worker_key = key.clone();
                if let Err(error) = thread::Builder::new()
                    .name("shard-search-reconcile".into())
                    .spawn(move || runtime.run_build(worker_key, token, refresh))
                {
                    eprintln!("[shard] 无法启动搜索对账线程：{error}");
                    if let Some(next) = self.finish_build_state(
                        &key,
                        token,
                        self.generation(Path::new(&key.context().vault_path)),
                        None,
                        Some(SearchError::Internal { retryable: true }),
                    ) {
                        self.dispatch(key, next);
                    }
                }
            }
            ReconcileAction::Schedule { token, delay, .. } => {
                let runtime = self.clone();
                let scheduled_key = key.clone();
                if let Err(error) = thread::Builder::new()
                    .name("shard-search-throttle".into())
                    .spawn(move || {
                        thread::sleep(delay);
                        if let Some(next) = runtime
                            .inner
                            .reconciler
                            .fire_scheduled(&scheduled_key, token)
                        {
                            runtime.dispatch(scheduled_key, next);
                        }
                    })
                {
                    eprintln!("[shard] 无法启动搜索节流线程：{error}");
                    self.inner.reconciler.cancel(&key);
                }
            }
        }
    }

    fn run_build(&self, key: ReconcileKey, token: u64, refresh: RefreshKind) {
        self.run_build_with_scan_wait_hook(key, token, refresh, || {});
    }

    fn run_build_with_scan_wait_hook<F>(
        &self,
        key: ReconcileKey,
        token: u64,
        refresh: RefreshKind,
        on_scan_wait: F,
    ) where
        F: FnOnce(),
    {
        let context = key.context();
        let scope = key.scope();
        let entry = self.entry(Path::new(&context.vault_path));
        entry.scan_gates[scope_index(&scope)].acquire_with_wait_hook(on_scan_wait);
        let scan_guard = ExclusiveGateGuard {
            gate: &entry.scan_gates[scope_index(&scope)],
        };
        let Some(captured) = self.capture_build(&context, &scope) else {
            drop(scan_guard);
            self.inner.reconciler.cancel(&key);
            return;
        };
        let builder = self
            .inner
            .builder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(builder) = builder else {
            let next = self.finish_build_state(
                &key,
                token,
                captured.start_generation,
                None,
                Some(SearchError::Internal { retryable: true }),
            );
            drop(scan_guard);
            if let Some(next) = next {
                self.dispatch(key, next);
            }
            return;
        };
        let force_read_all = should_force_read_all(
            refresh,
            captured.previous.as_deref(),
            captured.start_generation,
        );
        let result = catch_unwind(AssertUnwindSafe(|| {
            builder(SearchBuildRequest {
                context: context.clone(),
                scope,
                refresh: refresh.into_refresh(),
                start_generation: captured.start_generation,
                force_read_all,
                previous: captured.previous,
            })
        }))
        .unwrap_or(Err(SearchError::Internal { retryable: true }));

        let (outcome, error) = match result {
            Ok(draft) => {
                let outcome = self.publish_draft(
                    &context,
                    key.scope(),
                    captured.start_generation,
                    refresh,
                    draft,
                );
                let error = matches!(outcome, PublishOutcome::RejectedAuthorization)
                    .then_some(SearchError::ContextExpired);
                (Some(outcome), error)
            }
            Err(error) => (None, Some(error)),
        };
        let next = self.finish_build_state(&key, token, captured.start_generation, outcome, error);
        drop(scan_guard);
        if let Some(next) = next {
            self.dispatch(key, next);
        }
    }

    fn mark_refresh_started(&self, key: &ReconcileKey) -> bool {
        let context = key.context();
        let scope = key.scope();
        let entry = self.entry(Path::new(&context.vault_path));
        let mut publication = entry
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !publication
            .context
            .as_ref()
            .is_some_and(|current| contexts_equal(current, &context))
        {
            return false;
        }
        publication.refreshing[scope_index(&scope)] = true;
        true
    }

    fn finish_build_state(
        &self,
        key: &ReconcileKey,
        token: u64,
        start_generation: u64,
        outcome: Option<PublishOutcome>,
        error: Option<SearchError>,
    ) -> Option<ReconcileAction> {
        let context = key.context();
        let scope = key.scope();
        let entry = self.entry(Path::new(&context.vault_path));
        let mut publication = entry
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let context_is_current = publication
            .context
            .as_ref()
            .is_some_and(|current| contexts_equal(current, &context));
        let generation_changed = context_is_current && publication.generation != start_generation;
        let next = self.inner.reconciler.finish(key, token, generation_changed);

        if context_is_current {
            let index = scope_index(&scope);
            publication.refreshing[index] = next.is_some();
            if let Some(error) = error {
                publication.warnings[index] = Some(error);
            } else if matches!(
                outcome,
                Some(PublishOutcome::Published | PublishOutcome::Reused)
            ) {
                publication.warnings[index] = None;
            }
        }
        next
    }

    fn capture_build(&self, context: &SearchContext, scope: &SearchScope) -> Option<CapturedBuild> {
        let entry = self.entry(Path::new(&context.vault_path));
        // Capture takes the raw physical gate only for the generation/snapshot clone.
        // It does not advance generation and releases the gate before any scan or parse.
        let _capture_gate = entry.gate.lock();
        let publication = entry
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert_eq!(publication.generation % 2, 0);
        if !publication
            .context
            .as_ref()
            .is_some_and(|current| contexts_equal(current, context))
        {
            return None;
        }
        Some(CapturedBuild {
            start_generation: publication.generation,
            previous: publication.snapshots[scope_index(scope)].clone(),
        })
    }

    fn publish_draft(
        &self,
        context: &SearchContext,
        scope: SearchScope,
        start_generation: u64,
        refresh: RefreshKind,
        draft: SearchSnapshotDraft,
    ) -> PublishOutcome {
        self.publish_draft_with_hook(context, scope, start_generation, refresh, draft, || {})
    }

    fn publish_draft_with_hook<F>(
        &self,
        context: &SearchContext,
        scope: SearchScope,
        start_generation: u64,
        refresh: RefreshKind,
        draft: SearchSnapshotDraft,
        before_swap: F,
    ) -> PublishOutcome
    where
        F: FnOnce(),
    {
        if matches!(scope, SearchScope::Lockbox)
            && draft
                .authorization
                .as_ref()
                .is_none_or(|authorization| authorization.validate(context).is_err())
        {
            drop(draft);
            return PublishOutcome::RejectedAuthorization;
        }

        let entry = self.entry(Path::new(&context.vault_path));
        // Publication takes the physical gate without changing generation. This makes the
        // snapshot swap and a writer's odd transition one ordered gate -> state sequence.
        let _publication_gate = entry.gate.lock();
        let mut publication = entry
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !publication
            .context
            .as_ref()
            .is_some_and(|current| contexts_equal(current, context))
        {
            drop(publication);
            drop(_publication_gate);
            drop(draft);
            return PublishOutcome::RejectedContext;
        }
        if publication.generation != start_generation || publication.generation % 2 != 0 {
            drop(publication);
            drop(_publication_gate);
            drop(draft);
            return PublishOutcome::RejectedGeneration;
        }
        before_swap();
        if matches!(scope, SearchScope::Lockbox)
            && draft
                .authorization
                .as_ref()
                .is_none_or(|authorization| authorization.validate_session().is_err())
        {
            drop(publication);
            drop(_publication_gate);
            drop(draft);
            return PublishOutcome::RejectedAuthorization;
        }

        let slot = &mut publication.snapshots[scope_index(&scope)];
        let reuse = refresh != RefreshKind::Rebuild
            && slot.as_ref().is_some_and(|previous| {
                previous.generation == start_generation
                    && previous.source_stamp == draft.source_stamp
            });
        if reuse {
            // The public documents are unchanged, but a read inside the two-second
            // racy window must advance its indexed time. Otherwise Auto would
            // reread that file forever while keeping the old immutable snapshot.
            let retired = if matches!(scope, SearchScope::Public) {
                let mut draft = draft;
                draft.snapshot_id = slot.as_ref().unwrap().snapshot_id.clone();
                slot.replace(Arc::new(SearchSnapshot::from_draft(
                    draft,
                    scope,
                    start_generation,
                )))
            } else {
                drop(draft);
                None
            };
            drop(publication);
            drop(_publication_gate);
            drop(retired);
            return PublishOutcome::Reused;
        }

        let previous = slot.replace(Arc::new(SearchSnapshot::from_draft(
            draft,
            scope,
            start_generation,
        )));
        drop(publication);
        drop(_publication_gate);
        drop(previous);
        PublishOutcome::Published
    }

    fn context_is_current(&self, context: &SearchContext) -> bool {
        self.entry(Path::new(&context.vault_path))
            .publication
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .context
            .as_ref()
            .is_some_and(|current| contexts_equal(current, context))
    }

    fn cancel_context(&self, context: &SearchContext) {
        for scope in [SearchScope::Public, SearchScope::Lockbox] {
            self.inner
                .reconciler
                .cancel(&ReconcileKey::new(context, &scope));
        }
    }

    fn next_vault_epoch(&self) -> u64 {
        let epoch = self
            .inner
            .next_vault_epoch
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        if epoch == 0 {
            self.inner.next_vault_epoch.store(1, Ordering::SeqCst);
            1
        } else {
            epoch
        }
    }

    fn next_privacy_epoch(&self) -> u64 {
        let epoch = self
            .inner
            .next_privacy_epoch
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        if epoch == 0 {
            self.inner.next_privacy_epoch.store(1, Ordering::SeqCst);
            1
        } else {
            epoch
        }
    }
}

fn app_runtime() -> &'static SearchRuntime {
    static RUNTIME: OnceLock<SearchRuntime> = OnceLock::new();
    RUNTIME.get_or_init(SearchRuntime::default)
}

pub(crate) fn managed_runtime() -> SearchRuntime {
    app_runtime().clone()
}

pub(crate) fn acquire_write_guard(vault: &Path) -> Result<VaultWriteGuard, SearchError> {
    app_runtime().acquire_write_guard(vault)
}

pub(crate) fn clone_snapshot(
    context: &SearchContext,
    scope: SearchScope,
) -> Result<Option<Arc<SearchSnapshot>>, SearchError> {
    app_runtime().clone_snapshot(context, scope)
}

pub(crate) fn request_reconcile(
    context: SearchContext,
    scope: SearchScope,
    refresh: SearchRefresh,
) {
    app_runtime().request_reconcile(context, scope, refresh);
}

pub(crate) fn activate_vault(vault: &Path) -> SearchContext {
    app_runtime().activate_vault(vault)
}

pub(crate) fn active_context(vault: &Path) -> Option<SearchContext> {
    app_runtime().active_context(vault)
}

pub(crate) fn write_generation(vault: &Path) -> u64 {
    app_runtime().generation(vault)
}

pub(crate) fn validate_context(context: &SearchContext) -> Result<(), SearchError> {
    app_runtime().validate_context(context)
}

fn scope_index(scope: &SearchScope) -> usize {
    match ScopeKey::from_scope(scope) {
        ScopeKey::Public => 0,
        ScopeKey::Lockbox => 1,
    }
}

fn contexts_equal(left: &SearchContext, right: &SearchContext) -> bool {
    left.vault_path == right.vault_path
        && left.vault_epoch == right.vault_epoch
        && left.privacy_epoch == right.privacy_epoch
}

fn should_force_read_all(
    refresh: RefreshKind,
    previous: Option<&SearchSnapshot>,
    start_generation: u64,
) -> bool {
    refresh == RefreshKind::Rebuild
        || previous.is_none_or(|snapshot| snapshot.generation != start_generation)
}

pub(crate) fn normalized_vault_key(vault: &Path) -> PathBuf {
    if let Ok(canonical) = vault.canonicalize() {
        return canonical;
    }

    let absolute = if vault.is_absolute() {
        vault.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current| current.join(vault))
            .unwrap_or_else(|_| vault.to_path_buf())
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }

    // A newly selected vault may not exist yet. Resolve the nearest existing ancestor
    // so a symlinked parent cannot produce one gate before creation and another after it.
    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    loop {
        if let Ok(mut canonical) = ancestor.canonicalize() {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(name) = ancestor.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Barrier, Condvar,
        },
        time::{Duration, Instant, SystemTime},
    };

    use super::*;

    fn draft(id: &str, stamp: &str) -> SearchSnapshotDraft {
        SearchSnapshotDraft {
            snapshot_id: id.into(),
            source_stamp: stamp.into(),
            documents: Vec::new(),
            metadata: HashMap::new(),
            sources: HashMap::new(),
            skipped_files: 0,
            authorization: None,
        }
    }

    fn lockbox_draft(id: &str, authorization: LockboxLeaseAuthorization) -> SearchSnapshotDraft {
        let mut draft = draft(id, id);
        draft.authorization = Some(authorization);
        draft
    }

    #[test]
    fn search_expiry_revokes_idle_snapshot() {
        let runtime = SearchRuntime::default();
        let lockbox = crate::LockboxRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        runtime.activate_vault(directory.path());
        crate::search_lockbox::bind_search_runtime(&lockbox, runtime.clone());
        crate::search_lockbox::unlock_runtime(&lockbox, directory.path(), &[7; 32]);
        let context = runtime.active_context(directory.path()).unwrap();
        let authorization =
            crate::search_lockbox::authorization_for_test(&lockbox, directory.path());
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Lockbox,
                runtime.generation(directory.path()),
                RefreshKind::Rebuild,
                lockbox_draft("private", authorization),
            ),
            PublishOutcome::Published
        );

        crate::search_lockbox::set_expiry_for_test(
            &lockbox,
            SystemTime::now() + Duration::from_millis(30),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while runtime
            .active_context(directory.path())
            .is_some_and(|current| contexts_equal(&current, &context))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }

        let next = runtime.active_context(directory.path()).unwrap();
        assert_ne!(next.privacy_epoch, context.privacy_epoch);
        assert!(matches!(
            runtime.clone_snapshot(&context, SearchScope::Lockbox),
            Err(SearchError::ContextExpired)
        ));
        assert!(runtime
            .clone_snapshot(&next, SearchScope::Lockbox)
            .unwrap()
            .is_none());
    }

    #[test]
    fn search_old_lease_cannot_publish_after_reunlock() {
        let runtime = SearchRuntime::default();
        let lockbox = crate::LockboxRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        runtime.activate_vault(directory.path());
        crate::search_lockbox::bind_search_runtime(&lockbox, runtime.clone());
        crate::search_lockbox::unlock_runtime(&lockbox, directory.path(), &[3; 32]);
        let old_authorization =
            crate::search_lockbox::authorization_for_test(&lockbox, directory.path());

        crate::search_lockbox::unlock_runtime(&lockbox, directory.path(), &[4; 32]);
        let current = runtime.active_context(directory.path()).unwrap();
        assert_eq!(
            runtime.publish_draft(
                &current,
                SearchScope::Lockbox,
                runtime.generation(directory.path()),
                RefreshKind::Rebuild,
                lockbox_draft("stale-private", old_authorization),
            ),
            PublishOutcome::RejectedAuthorization
        );
        assert!(runtime
            .clone_snapshot(&current, SearchScope::Lockbox)
            .unwrap()
            .is_none());
        crate::search_lockbox::lock_runtime(&lockbox);
    }

    #[test]
    fn search_public_to_lockbox_revokes_old_public_snapshot() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                0,
                RefreshKind::Rebuild,
                draft("public-before-move", "public-before-move"),
            ),
            PublishOutcome::Published
        );

        let gate = runtime.acquire_write_guard(directory.path()).unwrap();
        gate.invalidate_public_snapshot();
        assert!(runtime
            .clone_snapshot(&context, SearchScope::Public)
            .unwrap()
            .is_none());
        drop(gate);
    }

    #[test]
    fn search_write_error_returns_generation_to_even() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();

        let result: Result<(), &str> = (|| {
            let _guard = runtime.acquire_write_guard(directory.path()).unwrap();
            Err("injected write failure")
        })();

        assert!(result.is_err());
        assert_eq!(runtime.generation(directory.path()), 2);
    }

    #[cfg(unix)]
    #[test]
    fn search_nonexistent_vault_under_symlink_uses_stable_gate_key() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let real_parent = directory.path().join("real");
        let linked_parent = directory.path().join("linked");
        fs::create_dir(&real_parent).unwrap();
        symlink(&real_parent, &linked_parent).unwrap();

        assert_eq!(
            normalized_vault_key(&linked_parent.join("new-vault")),
            normalized_vault_key(&real_parent.join("new-vault"))
        );
    }

    #[test]
    fn search_publish_rejects_generation_changed_during_scan() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let captured = runtime
            .capture_build(&context, &SearchScope::Public)
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let worker_barrier = barrier.clone();
        let worker_runtime = runtime.clone();
        let worker_context = context.clone();

        let worker = thread::spawn(move || {
            worker_barrier.wait();
            worker_barrier.wait();
            worker_runtime.publish_draft(
                &worker_context,
                SearchScope::Public,
                captured.start_generation,
                RefreshKind::Auto,
                draft("late", "same"),
            )
        });

        barrier.wait();
        drop(runtime.acquire_write_guard(directory.path()).unwrap());
        barrier.wait();

        assert_eq!(worker.join().unwrap(), PublishOutcome::RejectedGeneration);
        assert_eq!(
            runtime
                .snapshot_freshness(&context, SearchScope::Public)
                .unwrap(),
            SnapshotFreshness::Missing
        );
    }

    #[test]
    fn search_index_rows_survive_rejected_publish() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().join("vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        let frontmatter = shard_core::FragmentFrontmatter {
            id: "indexed-note".into(),
            created_at: "2026-09-25T00:00:00Z".into(),
            updated_at: "2026-09-25T01:00:00Z".into(),
            tags: vec!["note".into()],
            category: None,
            ai_status: None,
            pinned: false,
            source: "test".into(),
            conflict_of: None,
            related: Vec::new(),
        };
        shard_core::write_fragment_file(&vault.join("notes/one.md"), &frontmatter, "# One")
            .unwrap();
        let registry = crate::search_index::IndexRegistry::default();
        registry.set_root(directory.path().join("cache"));
        let runtime = SearchRuntime::default();
        let context = runtime.activate_vault(&vault);
        let captured = runtime
            .capture_build(&context, &SearchScope::Public)
            .unwrap();
        let draft = crate::search_sources::build_snapshot_with_index(
            SearchBuildRequest {
                context: context.clone(),
                scope: SearchScope::Public,
                refresh: SearchRefresh::Rebuild,
                start_generation: captured.start_generation,
                force_read_all: true,
                previous: None,
            },
            &crate::LockboxRuntime::default(),
            Some(&registry),
        )
        .unwrap();
        assert_eq!(
            registry.open(&vault).unwrap().load_files().unwrap().len(),
            1
        );
        drop(runtime.acquire_write_guard(&vault).unwrap());
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                captured.start_generation,
                RefreshKind::Rebuild,
                draft,
            ),
            PublishOutcome::RejectedGeneration
        );
        assert_eq!(
            registry.open(&vault).unwrap().load_files().unwrap().len(),
            1
        );
    }

    #[test]
    fn search_publish_and_writer_start_are_serialized() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let generation = runtime.generation(directory.path());
        let (publish_entered_tx, publish_entered_rx) = mpsc::channel();
        let (publish_release_tx, publish_release_rx) = mpsc::channel();
        let publisher_runtime = runtime.clone();
        let publisher_context = context.clone();
        let publisher = thread::spawn(move || {
            publisher_runtime.publish_draft_with_hook(
                &publisher_context,
                SearchScope::Public,
                generation,
                RefreshKind::Rebuild,
                draft("published-first", "stamp"),
                || {
                    publish_entered_tx.send(()).unwrap();
                    publish_release_rx.recv().unwrap();
                },
            )
        });

        publish_entered_rx.recv().unwrap();
        let (writer_waiting_tx, writer_waiting_rx) = mpsc::channel();
        let (physical_tx, physical_rx) = mpsc::channel();
        let (writer_tx, writer_rx) = mpsc::channel();
        let worker_runtime = runtime.clone();
        let path = directory.path().to_path_buf();

        let writer = thread::spawn(move || {
            let guard = worker_runtime
                .acquire_write_guard_with_hooks(
                    &path,
                    || writer_waiting_tx.send(()).unwrap(),
                    || physical_tx.send(()).unwrap(),
                )
                .unwrap();
            writer_tx.send(()).unwrap();
            drop(guard);
        });

        writer_waiting_rx.recv().unwrap();
        assert!(physical_rx.try_recv().is_err());
        assert!(writer_rx.try_recv().is_err());
        publish_release_tx.send(()).unwrap();
        assert_eq!(publisher.join().unwrap(), PublishOutcome::Published);

        physical_rx.recv().unwrap();
        writer_rx.recv().unwrap();
        writer.join().unwrap();
        assert_eq!(runtime.generation(directory.path()), 2);
        assert_eq!(
            runtime
                .clone_snapshot(&context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "published-first"
        );
        assert_eq!(
            runtime
                .snapshot_freshness(&context, SearchScope::Public)
                .unwrap(),
            SnapshotFreshness::Stale
        );
    }

    #[test]
    fn search_force_rebuild_ignores_equal_stamp() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let generation = runtime.generation(directory.path());

        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                generation,
                RefreshKind::Rebuild,
                draft("first", "equal-stamp"),
            ),
            PublishOutcome::Published
        );
        let first = runtime
            .clone_snapshot(&context, SearchScope::Public)
            .unwrap()
            .unwrap();
        assert!(!should_force_read_all(
            RefreshKind::Auto,
            Some(&first),
            generation,
        ));
        assert!(should_force_read_all(
            RefreshKind::Rebuild,
            Some(&first),
            generation,
        ));
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                generation,
                RefreshKind::Auto,
                draft("auto", "equal-stamp"),
            ),
            PublishOutcome::Reused
        );
        assert_eq!(
            runtime
                .clone_snapshot(&context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "first"
        );

        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                generation,
                RefreshKind::Rebuild,
                draft("rebuilt", "equal-stamp"),
            ),
            PublishOutcome::Published
        );
        assert_eq!(
            runtime
                .clone_snapshot(&context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "rebuilt"
        );

        drop(runtime.acquire_write_guard(directory.path()).unwrap());
        assert!(should_force_read_all(
            RefreshKind::Auto,
            Some(&first),
            runtime.generation(directory.path()),
        ));

        let observed_force_read_all = Arc::new(Mutex::new(None));
        let observed = observed_force_read_all.clone();
        runtime.install_snapshot_builder(move |request| {
            *observed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some((request.refresh, request.force_read_all));
            Ok(draft("builder-rebuild", "equal-stamp"))
        });
        let key = ReconcileKey::new(&context, &SearchScope::Public);
        let Some(ReconcileAction::Start { token, refresh }) = runtime
            .inner
            .reconciler
            .request(key.clone(), RefreshKind::Rebuild)
        else {
            panic!("manual rebuild must start");
        };
        assert!(runtime.mark_refresh_started(&key));
        runtime.run_build(key, token, refresh);

        let observed = observed_force_read_all
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(matches!(
            observed.as_ref(),
            Some((SearchRefresh::Rebuild, true))
        ));
        assert_eq!(
            runtime
                .clone_snapshot(&context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "builder-rebuild"
        );
    }

    #[test]
    fn search_write_during_build_schedules_follow_up() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let release_first = Arc::new((Mutex::new(false), Condvar::new()));
        let builder_calls = Arc::new(AtomicUsize::new(0));
        let (seen_tx, seen_rx) = mpsc::channel();

        let builder_release = release_first.clone();
        let calls = builder_calls.clone();
        runtime.install_snapshot_builder(move |request| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            seen_tx
                .send((call, request.start_generation, request.force_read_all))
                .unwrap();
            if call == 0 {
                let (released, available) = &*builder_release;
                let mut released = released
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while !*released {
                    released = available
                        .wait(released)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
            Ok(draft(&format!("build-{call}"), &format!("stamp-{call}")))
        });

        runtime.request_reconcile(
            context.clone(),
            SearchScope::Public,
            SearchRefresh::Reconcile,
        );
        assert_eq!(
            seen_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            (0, 0, true)
        );

        drop(runtime.acquire_write_guard(directory.path()).unwrap());
        let (released, available) = &*release_first;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        available.notify_one();

        assert_eq!(
            seen_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            (1, 2, true)
        );
        let entry = runtime.entry(directory.path());
        let _scan_finished = entry.scan_gates[scope_index(&SearchScope::Public)].lock();

        assert_eq!(builder_calls.load(Ordering::SeqCst), 2);
        assert!(!runtime.is_reconciling(&context, &SearchScope::Public));
        let view = runtime
            .snapshot_view(&context, SearchScope::Public)
            .unwrap();
        assert_eq!(view.freshness, SnapshotFreshness::Fresh);
        assert_eq!(view.snapshot.unwrap().snapshot_id, "build-1");
    }

    #[test]
    fn search_write_after_publish_before_finish_schedules_follow_up() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let key = ReconcileKey::new(&context, &SearchScope::Public);
        let Some(ReconcileAction::Start { token, .. }) = runtime
            .inner
            .reconciler
            .request(key.clone(), RefreshKind::Rebuild)
        else {
            panic!("initial build must start");
        };
        assert!(runtime.mark_refresh_started(&key));
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                0,
                RefreshKind::Rebuild,
                draft("published", "stamp"),
            ),
            PublishOutcome::Published
        );

        drop(runtime.acquire_write_guard(directory.path()).unwrap());
        assert_eq!(
            runtime.finish_build_state(&key, token, 0, Some(PublishOutcome::Published), None,),
            Some(ReconcileAction::Start {
                token: token + 1,
                refresh: RefreshKind::Reconcile,
            })
        );
    }

    #[test]
    fn search_refresh_error_keeps_old_snapshot_stale() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                0,
                RefreshKind::Rebuild,
                draft("old", "old-stamp"),
            ),
            PublishOutcome::Published
        );
        runtime.install_snapshot_builder(|_| Err(SearchError::Io { retryable: true }));

        let key = ReconcileKey::new(&context, &SearchScope::Public);
        let Some(ReconcileAction::Start { token, refresh }) = runtime
            .inner
            .reconciler
            .request(key.clone(), RefreshKind::Reconcile)
        else {
            panic!("reconcile must start");
        };
        assert!(runtime.mark_refresh_started(&key));
        assert!(
            runtime
                .snapshot_view(&context, SearchScope::Public)
                .unwrap()
                .indexing
        );
        runtime.run_build(key, token, refresh);

        let view = runtime
            .snapshot_view(&context, SearchScope::Public)
            .unwrap();
        assert!(!view.indexing);
        assert_eq!(view.freshness, SnapshotFreshness::Stale);
        assert_eq!(view.snapshot.unwrap().snapshot_id, "old");
        assert!(matches!(
            view.warning,
            Some(SearchError::Io { retryable: true })
        ));
    }

    #[test]
    fn search_context_switch_keeps_scan_single_flight() {
        let runtime = SearchRuntime::default();
        let directory = tempfile::tempdir().unwrap();
        let first_context = runtime.activate_vault(directory.path());
        let release_first = Arc::new((Mutex::new(false), Condvar::new()));
        let active_builders = Arc::new(AtomicUsize::new(0));
        let max_active_builders = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let (seen_tx, seen_rx) = mpsc::channel();

        let builder_release = release_first.clone();
        let active = active_builders.clone();
        let maximum = max_active_builders.clone();
        let observed_calls = calls.clone();
        runtime.install_snapshot_builder(move |_| {
            let call = observed_calls.fetch_add(1, Ordering::SeqCst);
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(current, Ordering::SeqCst);
            seen_tx.send(call).unwrap();
            if call == 0 {
                let (released, available) = &*builder_release;
                let mut released = released
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while !*released {
                    released = available
                        .wait(released)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(draft(&format!("context-{call}"), &format!("stamp-{call}")))
        });

        let first_key = ReconcileKey::new(&first_context, &SearchScope::Public);
        let Some(ReconcileAction::Start {
            token: first_token,
            refresh: first_refresh,
        }) = runtime
            .inner
            .reconciler
            .request(first_key.clone(), RefreshKind::Reconcile)
        else {
            panic!("first context build must start");
        };
        assert!(runtime.mark_refresh_started(&first_key));
        let first_runtime = runtime.clone();
        let first_worker = thread::spawn(move || {
            first_runtime.run_build(first_key, first_token, first_refresh);
        });
        assert_eq!(seen_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 0);

        let second_context = runtime.activate_vault(directory.path());
        let second_key = ReconcileKey::new(&second_context, &SearchScope::Public);
        let Some(ReconcileAction::Start {
            token: second_token,
            refresh: second_refresh,
        }) = runtime
            .inner
            .reconciler
            .request(second_key.clone(), RefreshKind::Reconcile)
        else {
            panic!("second context build must start");
        };
        assert!(runtime.mark_refresh_started(&second_key));
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let second_runtime = runtime.clone();
        let second_worker = thread::spawn(move || {
            second_runtime.run_build_with_scan_wait_hook(
                second_key,
                second_token,
                second_refresh,
                || waiting_tx.send(()).unwrap(),
            );
        });

        waiting_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(active_builders.load(Ordering::SeqCst), 1);
        assert_eq!(max_active_builders.load(Ordering::SeqCst), 1);
        let (released, available) = &*release_first;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        available.notify_one();

        first_worker.join().unwrap();
        second_worker.join().unwrap();
        assert_eq!(seen_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(active_builders.load(Ordering::SeqCst), 0);
        assert_eq!(max_active_builders.load(Ordering::SeqCst), 1);
        assert_eq!(
            runtime
                .clone_snapshot(&second_context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "context-1"
        );
    }

    #[test]
    fn search_sync_failure_after_mutation_invalidates_snapshot() {
        let runtime = app_runtime().clone();
        let directory = tempfile::tempdir().unwrap();
        let context = runtime.activate_vault(directory.path());
        let generation = runtime.generation(directory.path());
        assert_eq!(
            runtime.publish_draft(
                &context,
                SearchScope::Public,
                generation,
                RefreshKind::Rebuild,
                draft("before-sync", "before-sync-stamp"),
            ),
            PublishOutcome::Published
        );

        let reconcile_count = Arc::new(AtomicUsize::new(0));
        let observed_count = reconcile_count.clone();
        let result: Result<(), String> = crate::run_sync_with_reconcile(
            directory.path(),
            Some(context.clone()),
            || {
                let _guard = crate::lock_vault_gate(directory.path());
                fs::write(directory.path().join("changed.md"), "changed")
                    .map_err(|error| error.to_string())?;
                Err("injected sync failure".into())
            },
            move |_| {
                observed_count.fetch_add(1, Ordering::SeqCst);
            },
        );

        assert_eq!(result.unwrap_err(), "injected sync failure");
        assert_eq!(reconcile_count.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.generation(directory.path()), generation + 2);
        assert_eq!(
            runtime
                .snapshot_freshness(&context, SearchScope::Public)
                .unwrap(),
            SnapshotFreshness::Stale
        );
        assert_eq!(
            runtime
                .clone_snapshot(&context, SearchScope::Public)
                .unwrap()
                .unwrap()
                .snapshot_id,
            "before-sync"
        );
    }
}
