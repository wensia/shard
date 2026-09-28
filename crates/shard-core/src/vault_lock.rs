use crate::normalized_vault_key;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::{File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

pub const APP_IDENTIFIER: &str = "dev.shard.desktop";
pub const LOCKS_DIR_NAME: &str = "locks";

pub fn app_config_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        home_dir()?.join("Library").join("Application Support")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(env::var_os("APPDATA")?)
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".config")))?
    };
    Some(base.join(APP_IDENTIFIER))
}

pub fn app_settings_path() -> Option<PathBuf> {
    Some(app_config_dir()?.join("settings.json"))
}

pub fn cli_lock_dir() -> Option<PathBuf> {
    Some(app_config_dir()?.join(LOCKS_DIR_NAME))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn vault_lock_path(lock_dir: &Path, vault: &Path) -> PathBuf {
    let key = normalized_vault_key(vault);
    let digest = Sha256::digest(key.to_string_lossy().as_bytes());
    let name = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    lock_dir.join(format!("{name}.lock"))
}

#[derive(Debug)]
pub struct VaultProcessLock {
    file: File,
}

impl VaultProcessLock {
    pub fn acquire(
        lock_dir: &Path,
        vault: &Path,
        timeout: Option<Duration>,
    ) -> Result<Self, String> {
        fs::create_dir_all(lock_dir).map_err(|error| format!("创建资料库锁目录失败：{error}"))?;
        let path = vault_lock_path(lock_dir, vault);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| format!("打开资料库锁失败：{error}"))?;
        match timeout {
            None => file
                .lock()
                .map_err(|error| format!("获取资料库锁失败：{error}"))?,
            Some(timeout) => {
                let start = Instant::now();
                loop {
                    match file.try_lock() {
                        Ok(()) => break,
                        Err(TryLockError::WouldBlock) => {
                            if start.elapsed() >= timeout {
                                return Err("Shard 正在写入资料库，请稍后重试".to_string());
                            }
                            thread::sleep(
                                Duration::from_millis(50)
                                    .min(timeout.saturating_sub(start.elapsed())),
                            );
                        }
                        Err(error) => return Err(format!("获取资料库锁失败：{error}")),
                    }
                }
            }
        }
        Ok(Self { file })
    }
}

impl Drop for VaultProcessLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_lock_times_out_and_can_be_reacquired() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().join("vault");
        let lock_dir = directory.path().join("locks");
        let first = VaultProcessLock::acquire(&lock_dir, &vault, None).unwrap();
        let error = VaultProcessLock::acquire(&lock_dir, &vault, Some(Duration::from_millis(100)))
            .err()
            .unwrap();
        assert_eq!(error, "Shard 正在写入资料库，请稍后重试");
        assert!(vault_lock_path(&lock_dir, &vault).exists());
        drop(first);
        VaultProcessLock::acquire(&lock_dir, &vault, Some(Duration::from_millis(100))).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lock_path_normalizes_symlink_and_parent_components() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        symlink(&real, directory.path().join("link")).unwrap();
        let locks = directory.path().join("locks");
        assert_eq!(
            vault_lock_path(&locks, &directory.path().join("link/child/vault")),
            vault_lock_path(&locks, &directory.path().join("real/child/../child/vault")),
        );
    }
}
