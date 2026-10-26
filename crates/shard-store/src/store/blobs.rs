//! blob 库：图片与大于 [`INLINE_MAX`] 的文件，按 sha256 内容寻址，只追加。
//!
//! 写入用独立连接、立即提交：顺序固定为「先提交 blob，再提交引用它的内容事务」
//! （WAL 下跨库事务不原子）。内容事务回滚留下的孤儿 blob 由 GC 在宽限期后清理。

use std::{ffi::CStr, path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension, MAIN_DB};

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

    /// 只读开头至多 `limit` 字节（读图片头、限长读取）。
    pub(crate) fn get_prefix(&self, sha: &str, limit: usize) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        let Some(id) = conn
            .query_row("SELECT id FROM blobs WHERE sha = ?1", params![sha], |row| row.get(0))
            .optional()?
        else {
            return Ok(None);
        };
        Ok(Some(read_prefix(&conn, c"blobs", c"data", id, limit)?))
    }

    pub(crate) fn size(&self, sha: &str) -> Result<Option<i64>, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        Ok(conn
            .query_row("SELECT size FROM blobs WHERE sha = ?1", params![sha], |row| row.get(0))
            .optional()?)
    }

    /// 立即删除（抹除历史用；调用方确认已无引用）。返回是否真的删了一行。
    pub(crate) fn delete(&self, sha: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        Ok(conn.execute("DELETE FROM blobs WHERE sha = ?1", params![sha])? > 0)
    }

    pub(crate) fn truncate_wal(&self) -> Result<bool, StoreError> {
        let conn = self.conn.lock().expect("blob 连接锁中毒");
        super::history::truncate_wal(&conn)
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

/// 用增量 blob I/O 读某个值开头至多 `limit` 字节：只读用到的页（`SELECT` 会把整个值读进内存）。
/// 值为 NULL 时 SQLite 打不开，调用方要先确认非空。
pub(crate) fn read_prefix(
    conn: &Connection,
    table: &CStr,
    column: &CStr,
    row_id: i64,
    limit: usize,
) -> rusqlite::Result<Vec<u8>> {
    let blob = conn.blob_open(MAIN_DB, table, column, row_id, true)?;
    let mut bytes = vec![0; blob.len().min(limit)];
    blob.read_at_exact(&mut bytes, 0)?;
    Ok(bytes)
}
