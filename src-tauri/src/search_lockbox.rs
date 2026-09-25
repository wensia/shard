use std::{
    fmt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime},
};

use crate::{
    search_contract::{SearchContext, SearchError, SearchRefresh, SearchScope},
    search_runtime::SearchRuntime,
    LockboxReadKeys, LockboxRuntime, LockboxSession, LOCKBOX_TTL,
};

static NEXT_LEASE_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub(crate) struct LockboxLeaseAuthorization {
    runtime: LockboxRuntime,
    vault: PathBuf,
    lease_epoch: u64,
}

impl fmt::Debug for LockboxLeaseAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LockboxLeaseAuthorization")
            .field("vault", &self.vault)
            .field("lease_epoch", &self.lease_epoch)
            .finish_non_exhaustive()
    }
}

impl LockboxLeaseAuthorization {
    pub(crate) fn validate_session(&self) -> Result<(), SearchError> {
        let now = SystemTime::now();
        let valid = {
            let session = self
                .runtime
                .lock()
                .map_err(|_| SearchError::Internal { retryable: true })?;
            session.vault_path.as_deref() == Some(self.vault.as_path())
                && session.lease_epoch == self.lease_epoch
                && session.master_key.is_some()
                && session
                    .expires_at
                    .is_some_and(|expires_at| now < expires_at)
        };
        if valid {
            Ok(())
        } else {
            expire_session_if_needed(&self.runtime);
            Err(SearchError::ContextExpired)
        }
    }

    pub(crate) fn validate(&self, context: &SearchContext) -> Result<(), SearchError> {
        if context.vault_path != self.vault.display().to_string() {
            return Err(SearchError::VaultChanged);
        }
        self.validate_session()?;
        if let Some(runtime) = self.runtime.bound_search_runtime() {
            runtime.validate_context(context)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct LockboxReadLease {
    authorization: LockboxLeaseAuthorization,
    expires_at: SystemTime,
    read_keys: LockboxReadKeys,
}

impl LockboxReadLease {
    pub(crate) fn read_keys(&self) -> &LockboxReadKeys {
        &self.read_keys
    }

    pub(crate) fn expires_at(&self) -> SystemTime {
        self.expires_at
    }

    pub(crate) fn authorization(&self) -> LockboxLeaseAuthorization {
        self.authorization.clone()
    }

    pub(crate) fn validate_session(&self) -> Result<(), SearchError> {
        self.authorization.validate_session()
    }

    pub(crate) fn validate(&self, context: &SearchContext) -> Result<(), SearchError> {
        self.authorization.validate(context)
    }
}

pub(crate) fn bind_search_runtime(runtime: &LockboxRuntime, search_runtime: SearchRuntime) {
    *runtime
        .0
        .search_runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(search_runtime);
    if runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .expires_at
        .is_some()
    {
        ensure_expiry_worker(runtime);
    }
}

pub(crate) fn peek_lockbox_read_lease(
    vault: &Path,
    runtime: &LockboxRuntime,
) -> Result<LockboxReadLease, SearchError> {
    lease(runtime, vault, false)
}

pub(crate) fn renew_lockbox_read_lease(
    vault: &Path,
    runtime: &LockboxRuntime,
) -> Result<LockboxReadLease, SearchError> {
    lease(runtime, vault, true)
}

fn lease(
    runtime: &LockboxRuntime,
    vault: &Path,
    renew: bool,
) -> Result<LockboxReadLease, SearchError> {
    expire_session_if_needed(runtime);
    let (master_key, lease_epoch, expires_at) = {
        let mut session = runtime
            .lock()
            .map_err(|_| SearchError::Internal { retryable: true })?;
        if session.vault_path.as_deref() != Some(vault) {
            return Err(SearchError::Locked);
        }
        let master_key = session.master_key.clone().ok_or(SearchError::Locked)?;
        let current_expiry = session.expires_at.ok_or(SearchError::Locked)?;
        if SystemTime::now() >= current_expiry {
            return Err(SearchError::Locked);
        }
        if renew {
            session.expires_at = Some(SystemTime::now() + LOCKBOX_TTL);
        }
        (
            master_key,
            session.lease_epoch,
            session.expires_at.expect("validated lockbox expiry"),
        )
    };
    if renew {
        runtime.notify_deadline_changed();
        if runtime.bound_search_runtime().is_some() {
            ensure_expiry_worker(runtime);
        }
    }

    let manifest =
        crate::read_lockbox_manifest(vault).map_err(|_| SearchError::Io { retryable: true })?;
    let write_private_key = crate::decrypt_lockbox_write_private_key(&manifest, &master_key)
        .map_err(|_| SearchError::Internal { retryable: false })?;
    Ok(LockboxReadLease {
        authorization: LockboxLeaseAuthorization {
            runtime: runtime.clone(),
            vault: vault.to_path_buf(),
            lease_epoch,
        },
        expires_at,
        read_keys: LockboxReadKeys {
            master_key,
            write_private_key,
        },
    })
}

pub(crate) fn renew_lockbox_read_keys(
    vault: &Path,
    runtime: &LockboxRuntime,
) -> Option<LockboxReadKeys> {
    renew_lockbox_read_lease(vault, runtime)
        .ok()
        .map(|lease| lease.read_keys)
}

pub(crate) fn current_expires_at(vault: &Path, runtime: &LockboxRuntime) -> Option<SystemTime> {
    expire_session_if_needed(runtime);
    let session = runtime.lock().ok()?;
    (session.vault_path.as_deref() == Some(vault))
        .then_some(session.expires_at)
        .flatten()
}

pub(crate) fn unlock_runtime(runtime: &LockboxRuntime, vault: &Path, master_key: &[u8]) {
    let lease_epoch = next_lease_epoch();
    {
        let mut session = runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.vault_path = Some(vault.to_path_buf());
        session.master_key = Some(master_key.to_vec());
        session.expires_at = Some(SystemTime::now() + LOCKBOX_TTL);
        session.lease_epoch = lease_epoch;
    }
    runtime.notify_deadline_changed();
    if runtime.bound_search_runtime().is_some() {
        ensure_expiry_worker(runtime);
    }

    if let Some(search_runtime) = runtime.bound_search_runtime() {
        // Establish the vault context before rotating privacy so the first unlock is
        // distinguishable from the locked epoch as well.
        if search_runtime.active_context(vault).is_some() {
            if let Some(context) = search_runtime.revoke_lockbox(vault) {
                search_runtime.request_reconcile(
                    context,
                    SearchScope::Lockbox,
                    SearchRefresh::Rebuild,
                );
            }
        }
    }
}

pub(crate) fn lock_runtime(runtime: &LockboxRuntime) {
    let vault = {
        let mut session = runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let vault = session.vault_path.clone();
        *session = LockboxSession::default();
        vault
    };
    runtime.notify_deadline_changed();
    if let (Some(vault), Some(search_runtime)) = (vault, runtime.bound_search_runtime()) {
        search_runtime.revoke_lockbox(&vault);
    }
}

fn next_lease_epoch() -> u64 {
    let epoch = NEXT_LEASE_EPOCH
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    if epoch == 0 {
        NEXT_LEASE_EPOCH.store(1, Ordering::SeqCst);
        1
    } else {
        epoch
    }
}

fn expire_session_if_needed(runtime: &LockboxRuntime) {
    let expired_vault = {
        let mut session = runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !session
            .expires_at
            .is_some_and(|expires_at| SystemTime::now() >= expires_at)
        {
            return;
        }
        let vault = session.vault_path.clone();
        *session = LockboxSession::default();
        vault
    };
    runtime.notify_deadline_changed();
    if let (Some(vault), Some(search_runtime)) = (expired_vault, runtime.bound_search_runtime()) {
        search_runtime.revoke_lockbox(&vault);
    }
}

fn ensure_expiry_worker(runtime: &LockboxRuntime) {
    if runtime
        .0
        .expiry_worker_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let worker_runtime = runtime.clone();
    if let Err(error) = thread::Builder::new()
        .name("shard-lockbox-expiry".into())
        .spawn(move || expiry_worker(worker_runtime))
    {
        runtime
            .0
            .expiry_worker_started
            .store(false, Ordering::SeqCst);
        eprintln!("[shard] 无法启动密匣过期任务：{error}");
    }
}

fn expiry_worker(runtime: LockboxRuntime) {
    loop {
        let mut session = runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(expires_at) = session.expires_at else {
            // Store while holding the session lock. A concurrent unlock can only set a
            // new deadline after this point and will then start a replacement worker.
            runtime
                .0
                .expiry_worker_started
                .store(false, Ordering::SeqCst);
            return;
        };

        let wait = expires_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO);
        if !wait.is_zero() {
            let (next_session, _) = runtime
                .0
                .deadline_changed
                .wait_timeout(session, wait)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(next_session);
            continue;
        }

        let vault = session.vault_path.clone();
        *session = LockboxSession::default();
        drop(session);
        if let (Some(vault), Some(search_runtime)) = (vault, runtime.bound_search_runtime()) {
            search_runtime.revoke_lockbox(&vault);
        }
    }
}

#[cfg(test)]
pub(crate) fn set_expiry_for_test(runtime: &LockboxRuntime, expires_at: SystemTime) {
    let mut session = runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    session.expires_at = Some(expires_at);
    drop(session);
    runtime.notify_deadline_changed();
    ensure_expiry_worker(runtime);
}

#[cfg(test)]
pub(crate) fn authorization_for_test(
    runtime: &LockboxRuntime,
    vault: &Path,
) -> LockboxLeaseAuthorization {
    let session = runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    LockboxLeaseAuthorization {
        runtime: runtime.clone(),
        vault: vault.to_path_buf(),
        lease_epoch: session.lease_epoch,
    }
}
