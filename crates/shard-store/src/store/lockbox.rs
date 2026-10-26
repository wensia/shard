//! 密匣条目与 manifest 的读写（服务器只见密文）。
//!
//! 这里不做 CAS：调用方在同一个写事务里先读当前 sha、比对、再写，读与写之间没有别的写者（单写者）。
//! 每次写入在提交时记一条 `lockbox` 范围的变化与一条密文修订；删除留墓碑（`deleted_at`），同一 id 可以重新写入。

use std::io;

use rusqlite::{params, OptionalExtension};
use shard_core::sha256_hex;

use super::sqlite_vfs::{LockboxTouch, SqliteVfs};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockboxItemEntry {
    pub id: String,
    /// 信封原文（`.shard` 文件内容）。
    pub envelope: String,
    pub sha: String,
    /// 导出时写回的路径（v1：`lockbox/fragments/…`、`lockbox/notes/…`）。
    pub path: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockboxManifestEntry {
    /// `.shard/lockbox.json` 原文。
    pub body: String,
    pub sha: String,
    pub revision: i64,
    pub updated_at: String,
}

fn db_error(error: rusqlite::Error) -> io::Error {
    io::Error::other(error.to_string())
}

const ITEM_COLUMNS: &str = "item_id, envelope, sha, legacy_path, revision, created_at, updated_at";

fn map_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LockboxItemEntry> {
    Ok(LockboxItemEntry {
        id: row.get(0)?,
        envelope: row.get(1)?,
        sha: row.get(2)?,
        path: row.get(3)?,
        revision: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

impl SqliteVfs<'_> {
    pub fn lockbox_manifest_entry(&self) -> io::Result<Option<LockboxManifestEntry>> {
        self.conn
            .query_row("SELECT body, sha, revision, updated_at FROM lockbox_manifest WHERE id = 1", [], |row| {
                Ok(LockboxManifestEntry { body: row.get(0)?, sha: row.get(1)?, revision: row.get(2)?, updated_at: row.get(3)? })
            })
            .optional()
            .map_err(db_error)
    }

    /// 在用的条目（不含已删除），按 id 排序。
    pub fn lockbox_item_entries(&self) -> io::Result<Vec<LockboxItemEntry>> {
        let mut statement = self
            .conn
            .prepare_cached(&format!("SELECT {ITEM_COLUMNS} FROM lockbox_items WHERE deleted_at IS NULL ORDER BY item_id"))
            .map_err(db_error)?;
        let rows = statement.query_map([], map_item).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        Ok(rows)
    }

    pub fn lockbox_item_entry(&self, id: &str) -> io::Result<Option<LockboxItemEntry>> {
        self.conn
            .query_row(
                &format!("SELECT {ITEM_COLUMNS} FROM lockbox_items WHERE item_id = ?1 AND deleted_at IS NULL"),
                params![id],
                map_item,
            )
            .optional()
            .map_err(db_error)
    }

    /// 写入（新建或覆盖）一条信封。`path` 为空时保留原有的导出路径。
    pub fn put_lockbox_item(&self, id: &str, envelope: &str, envelope_version: u32, path: Option<&str>) -> io::Result<()> {
        self.ensure_writable()?;
        let sha = sha256_hex(envelope.as_bytes());
        self.conn
            .execute(
                "INSERT INTO lockbox_items (item_id, envelope, envelope_version, legacy_path, sha, size, seq,
                                            created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)
                 ON CONFLICT(item_id) DO UPDATE SET envelope = excluded.envelope,
                   envelope_version = excluded.envelope_version,
                   legacy_path = COALESCE(excluded.legacy_path, legacy_path),
                   sha = excluded.sha, size = excluded.size, updated_at = excluded.updated_at,
                   revision = revision + 1, deleted_at = NULL",
                params![id, envelope, envelope_version, path, sha, envelope.len() as i64, self.now],
            )
            .map_err(db_error)?;
        self.lockbox_touched.borrow_mut().push(LockboxTouch { scope: "lockbox", key: id.to_string(), sha: Some(sha) });
        Ok(())
    }

    /// 删除一条信封：留墓碑，同步的客户端据此删掉本地副本。返回是否真的删了。
    pub fn delete_lockbox_item(&self, id: &str) -> io::Result<bool> {
        self.ensure_writable()?;
        let changed = self
            .conn
            .execute(
                "UPDATE lockbox_items SET envelope = NULL, sha = NULL, size = 0, deleted_at = ?2, updated_at = ?2,
                   revision = revision + 1
                 WHERE item_id = ?1 AND deleted_at IS NULL",
                params![id, self.now],
            )
            .map_err(db_error)?;
        if changed > 0 {
            self.lockbox_touched.borrow_mut().push(LockboxTouch { scope: "lockbox", key: id.to_string(), sha: None });
        }
        Ok(changed > 0)
    }

    /// 提交时抹掉这个文件的全部修订（连同幂等记录里带正文的响应）。用于公开内容移入密匣：
    /// 按路径找节点，所以要在删除公开文件**之前**登记。
    pub fn erase_history_on_commit(&self, path: &std::path::Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let node_id: Option<i64> = self
            .conn
            .query_row(
                "SELECT node_id FROM nodes WHERE path_key = ?1",
                params![crate::path_key::path_key(&rel)],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let node_id = node_id.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("不存在：{rel}")))?;
        self.erase_on_commit.borrow_mut().push(node_id);
        Ok(())
    }
}
