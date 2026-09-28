//! 资料库会话只在打开碎片时建立，保存期间复用同一份哈希基线。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use super::app::{SaveError, SaveReport, Store};
use crate::{
    edit::{self, Session},
    find::{self, FragmentEntry},
};

pub struct VaultStore {
    sessions: HashMap<String, Session>,
    lock_dir: PathBuf,
    timeout: Duration,
    vault: Option<PathBuf>,
}

impl VaultStore {
    pub fn new(lock_dir: &Path, timeout: Duration) -> Self {
        Self {
            sessions: HashMap::new(),
            lock_dir: lock_dir.to_path_buf(),
            timeout,
            vault: None,
        }
    }
}

impl Store for VaultStore {
    fn open(&mut self, entry: &FragmentEntry) -> Result<String, String> {
        let session = edit::open_session(entry)?;
        self.vault = Some(session.vault.clone());
        let body = session.body.clone();
        self.sessions.insert(entry.id.clone(), session);
        Ok(body)
    }

    fn save(&mut self, id: &str, body: &str) -> Result<SaveReport, SaveError> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| SaveError::Invalid("编辑会话已失效，请重新打开碎片".into()))?;
        edit::save_session(session, body, &self.lock_dir, self.timeout)
    }

    fn reload(&mut self) -> Result<Vec<FragmentEntry>, String> {
        let vault = self.vault.as_ref().ok_or("尚未打开资料库".to_string())?;
        find::load_fragments(vault)
    }
}
