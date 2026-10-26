//! blob 库：图片与大于 [`INLINE_MAX`] 的文件，按 sha256 内容寻址，只追加。
//!
//! 写入用独立连接、立即提交：顺序固定为「先提交 blob，再提交引用它的内容事务」
//! （WAL 下跨库事务不原子）。内容事务回滚留下的孤儿 blob 由 GC 在宽限期后清理。

use std::{path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use super::{schema, StoreError};

/// 不超过这个大小的文件内联存进 `nodes.inline`。
pub const INLINE_MAX: usize = 1024 * 1024;

pub(crate) struct BlobStore {
    conn: Mutex<Connection>,
}

impl BlobStore {
    pub(crate) fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        schema::configure(&conn)?;
        schema::migrate_blobs(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 已存在同 sha 的 blob 时什么也不做（内容寻址天然幂等）。
    pub(crate) fn put(&self, sha: &str, bytes: &[u8], now: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        conn.execute(
            "INSERT INTO blobs (sha, size, data, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(sha) DO UPDATE SET unreferenced_since = NULL",
            params![sha, bytes.len() as i64, bytes, now],
        )?;
        Ok(())
    }

    pub(crate) fn get(&self, sha: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        Ok(conn
            .query_row("SELECT data FROM blobs WHERE sha = ?1", params![sha], |row| row.get(0))
            .optional()?)
    }

    pub(crate) fn vacuum_into(&self, target: &Path) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
        Ok(())
    }

    pub(crate) fn contains(&self, sha: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        Ok(conn
            .query_row("SELECT 1 FROM blobs WHERE sha = ?1", params![sha], |_| Ok(()))
            .optional()?
            .is_some())
    }
}
