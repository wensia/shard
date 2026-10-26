//! 内容库里的一个事务，按 `std::fs` 的语义操作 `nodes` 表。
//!
//! 路径规则：
//! - 传入的是绝对路径，必须落在虚拟根之下；`..` 与根外路径一律拒绝。
//! - 比较用 `path_key`（NFC + 小写），与 APFS 一样不区分大小写和规范化方式。
//! - 新建条目时，存储路径 = 父目录的存储路径 + 自己的名字，所以后代路径总以祖先的存储路径开头
//!   （APFS 上对已有目录换大小写写入子项，子项也挂在原目录名下）。
//!
//! 与 FsVfs 的已知差异（`tests/vfs_conformance.rs` 不比较这些）：
//! - 错误的 `ErrorKind` 只保证「成功 / 失败」与 NotFound、AlreadyExists 一致。
//! - 写入与原内容相同的字节时不更新 `modified_at`（本地文件会更新 mtime）。
//! - 没有符号链接；`canonicalize` 只做词法规整。
//! - `lockbox/` 下的路径永远拒绝：密匣只以密文存在 `lockbox_items` 里；公开校验要的密匣 id 集合
//!   经 `lockbox_item_ids` 直接从表里取。
//! - `copy(a, a)`：本地 macOS 会把文件截断清空，这里内容不变。

use std::{
    cell::RefCell,
    collections::BTreeMap,
    io,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use rusqlite::{params, Connection, OptionalExtension};

use super::blobs::{read_prefix, BlobStore, INLINE_MAX};
use super::history::{load_revision, RevisionInfo};
use crate::path_key::{parent_key, path_key};
use shard_core::{sha256_hex, EntryKind, Vfs, VfsDirEntry, VfsMetadata};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeKind {
    Dir,
    File,
}

impl NodeKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            NodeKind::Dir => "dir",
            NodeKind::File => "file",
        }
    }

    fn parse(value: &str) -> NodeKind {
        if value == "dir" {
            NodeKind::Dir
        } else {
            NodeKind::File
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NodeRow {
    pub node_id: i64,
    pub path: String,
    pub path_key: String,
    pub kind: NodeKind,
    pub blob_sha: Option<String>,
    pub size: i64,
    pub sha: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

/// 事务开始前一个条目的状态：提交时据此算出变化、修订与投影。
#[derive(Clone, Debug)]
pub(crate) struct Initial {
    /// 事务开始时的存储路径；`None` 表示条目是本事务新建的。
    pub path: Option<String>,
    pub sha: Option<String>,
}

pub struct SqliteVfs<'a> {
    pub(super) conn: &'a Connection,
    blobs: &'a BlobStore,
    root: &'a Path,
    writable: bool,
    pub(super) now: String,
    touched: RefCell<BTreeMap<i64, Initial>>,
    pub(super) lockbox_touched: RefCell<Vec<LockboxTouch>>,
    /// 提交时连同全部修订一起抹掉历史的条目（公开内容移入密匣：明文不能留在修订里）。
    pub(super) erase_on_commit: RefCell<Vec<i64>>,
}

/// 本事务里写过的密匣条目或 manifest：提交时各记一条变化（scope = lockbox / lockbox_manifest）。
#[derive(Clone, Debug)]
pub(crate) struct LockboxTouch {
    pub scope: &'static str,
    pub key: String,
    /// 删除时为空。
    pub sha: Option<String>,
}

/// 原样存进库的一条密匣信封（服务器只见密文）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockboxItemRaw {
    pub item_id: String,
    pub envelope: String,
    /// 从旧 vault 导入时的路径（lockbox/notes 下的路径含明文标题），导出时原样写回。
    pub legacy_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const NODE_COLUMNS: &str =
    "node_id, path, path_key, kind, blob_sha, size, sha, created_at, modified_at";

fn map_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodeRow> {
    let kind: String = row.get(3)?;
    Ok(NodeRow {
        node_id: row.get(0)?,
        path: row.get(1)?,
        path_key: row.get(2)?,
        kind: NodeKind::parse(&kind),
        blob_sha: row.get(4)?,
        size: row.get(5)?,
        sha: row.get(6)?,
        created_at: row.get(7)?,
        modified_at: row.get(8)?,
    })
}

fn db_error(error: rusqlite::Error) -> io::Error {
    io::Error::other(format!("内容库错误：{error}"))
}

fn not_found(rel: &str) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, format!("不存在：{rel}"))
}

fn parse_time(value: &str) -> SystemTime {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(SystemTime::from)
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn name_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(index) => &rel[index + 1..],
        None => rel,
    }
}

fn parent_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(index) => &rel[..index],
        None => "",
    }
}

impl<'a> SqliteVfs<'a> {
    pub(crate) fn new(
        conn: &'a Connection,
        blobs: &'a BlobStore,
        root: &'a Path,
        writable: bool,
        now: String,
    ) -> Self {
        Self {
            conn,
            blobs,
            root,
            writable,
            now,
            touched: RefCell::new(BTreeMap::new()),
            lockbox_touched: RefCell::new(Vec::new()),
            erase_on_commit: RefCell::new(Vec::new()),
        }
    }

    pub(crate) fn take_touched(&self) -> BTreeMap<i64, Initial> {
        std::mem::take(&mut self.touched.borrow_mut())
    }

    pub(crate) fn take_lockbox_touched(&self) -> Vec<LockboxTouch> {
        std::mem::take(&mut self.lockbox_touched.borrow_mut())
    }

    pub(crate) fn take_erase_on_commit(&self) -> Vec<i64> {
        std::mem::take(&mut self.erase_on_commit.borrow_mut())
    }

    /// 导入用：把条目的创建、修改时间设成源文件的时间（树与碎片按修改时间排序）。不算内容变化。
    pub fn set_times(&self, path: &Path, created: SystemTime, modified: SystemTime) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        let text = |time: SystemTime| {
            chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
        };
        self.conn
            .execute(
                "UPDATE nodes SET created_at = ?1, modified_at = ?2 WHERE node_id = ?3",
                params![text(created), text(modified), node.node_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// 版本历史：一条修订与它的字节（删除时刻的记录字节为空）。
    pub fn revision(&self, rev_id: i64) -> io::Result<Option<(RevisionInfo, Vec<u8>)>> {
        load_revision(self.conn, self.blobs, rev_id).map_err(|error| io::Error::other(error.to_string()))
    }

    /// 条目当前的存储路径；已彻底删除返回 `None`。
    pub fn node_path(&self, node_id: i64) -> io::Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT path FROM nodes WHERE node_id = ?1", params![node_id], |row| row.get(0))
            .optional()
            .map_err(db_error)?
            .flatten())
    }

    /// 把已彻底删除的文件放回 `path`：沿用原节点，恢复后历史连着以前的修订。
    /// 目标必须空着、父目录必须存在（与新建文件相同）。
    pub fn revive(&self, node_id: i64, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        if rel.is_empty() || self.find(&rel)?.is_some() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("已存在：{rel}")));
        }
        let tombstone: Option<String> = self
            .conn
            .query_row(
                "SELECT kind FROM nodes WHERE node_id = ?1 AND path_key IS NULL AND purged_at IS NOT NULL",
                params![node_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if tombstone.as_deref() != Some("file") {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("条目 {node_id} 不是已彻底删除的文件。")));
        }
        let stored = Self::joined(&self.require_parent(&rel)?, name_of(&rel));
        let key = path_key(&stored);
        let (inline, blob_sha, sha) = self.store_content(bytes)?;
        self.touched.borrow_mut().entry(node_id).or_insert(Initial { path: None, sha: None });
        self.conn
            .execute(
                "UPDATE nodes SET path = ?1, path_key = ?2, parent_key = ?3, inline = ?4, blob_sha = ?5, size = ?6,
                                  sha = ?7, purged_at = NULL, modified_at = ?8
                 WHERE node_id = ?9",
                params![stored, key, parent_key(&key), inline, blob_sha, bytes.len() as i64, sha, self.now, node_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// 原样写入一条密匣信封；同 id 已存在且内容相同时什么也不做。
    pub fn put_lockbox_item_raw(&self, item: &LockboxItemRaw) -> io::Result<()> {
        self.ensure_writable()?;
        let sha = sha256_hex(item.envelope.as_bytes());
        let existing: Option<String> = self
            .conn
            .query_row("SELECT sha FROM lockbox_items WHERE item_id = ?1", params![item.item_id], |row| row.get(0))
            .optional()
            .map_err(db_error)?
            .flatten();
        if existing.as_deref() == Some(sha.as_str()) {
            return Ok(());
        }
        self.conn
            .execute(
                "INSERT INTO lockbox_items (item_id, envelope, envelope_version, legacy_path, sha, size, seq,
                                            created_at, updated_at)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, 0, ?6, ?7)
                 ON CONFLICT(item_id) DO UPDATE SET envelope = excluded.envelope, legacy_path = excluded.legacy_path,
                   sha = excluded.sha, size = excluded.size, updated_at = excluded.updated_at,
                   revision = revision + 1, deleted_at = NULL",
                params![
                    item.item_id,
                    item.envelope,
                    item.legacy_path,
                    sha,
                    item.envelope.len() as i64,
                    item.created_at,
                    item.updated_at
                ],
            )
            .map_err(db_error)?;
        self.lockbox_touched.borrow_mut().push(LockboxTouch { scope: "lockbox", key: item.item_id.clone(), sha: Some(sha) });
        Ok(())
    }

    /// 原样写入密匣 manifest（现 `.shard/lockbox.json` 的原文）。`updated_at` 为空时记当前时间；
    /// 导入时传源文件的修改时间，导出才能原样写回。
    pub fn put_lockbox_manifest_raw(&self, body: &str, updated_at: Option<&str>) -> io::Result<()> {
        self.ensure_writable()?;
        let sha = sha256_hex(body.as_bytes());
        let existing: Option<String> = self
            .conn
            .query_row("SELECT sha FROM lockbox_manifest WHERE id = 1", [], |row| row.get(0))
            .optional()
            .map_err(db_error)?;
        if existing.as_deref() == Some(sha.as_str()) {
            return Ok(());
        }
        self.conn
            .execute(
                "INSERT INTO lockbox_manifest (id, body, sha, revision, seq, updated_at) VALUES (1, ?1, ?2, 1, 0, ?3)
                 ON CONFLICT(id) DO UPDATE SET body = excluded.body, sha = excluded.sha,
                   revision = revision + 1, updated_at = excluded.updated_at",
                params![body, sha, updated_at.unwrap_or(&self.now)],
            )
            .map_err(db_error)?;
        self.lockbox_touched
            .borrow_mut()
            .push(LockboxTouch { scope: "lockbox_manifest", key: "manifest".to_string(), sha: Some(sha) });
        Ok(())
    }

    pub fn lockbox_items_raw(&self) -> io::Result<Vec<LockboxItemRaw>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT item_id, envelope, legacy_path, created_at, updated_at FROM lockbox_items
                 WHERE deleted_at IS NULL ORDER BY item_id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(LockboxItemRaw {
                    item_id: row.get(0)?,
                    envelope: row.get(1)?,
                    legacy_path: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    /// (原文, 更新时间)
    pub fn lockbox_manifest_raw(&self) -> io::Result<Option<(String, String)>> {
        self.conn
            .query_row("SELECT body, updated_at FROM lockbox_manifest WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(db_error)
    }

    /// 绝对路径 → 存储用的相对路径（`a/b/c`，根是空串）。
    pub(crate) fn rel(&self, path: &Path) -> io::Result<String> {
        let stripped = path.strip_prefix(self.root).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("路径不在资料库内：{}", path.display()),
            )
        })?;
        let mut parts = Vec::new();
        for component in stripped.components() {
            match component {
                Component::Normal(part) => {
                    let part = part.to_str().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "路径不是有效的 UTF-8。")
                    })?;
                    if part.contains('\\') {
                        return Err(io::Error::new(io::ErrorKind::InvalidInput, "路径不能含反斜杠。"));
                    }
                    parts.push(part);
                }
                Component::CurDir => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("路径不能含 `..`：{}", path.display()),
                    ))
                }
            }
        }
        let rel = parts.join("/");
        let key = path_key(&rel);
        if key == "lockbox" || key.starts_with("lockbox/") {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "密匣内容不以明文存放在内容库里。",
            ));
        }
        Ok(rel)
    }

    fn abs(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.to_path_buf()
        } else {
            self.root.join(rel)
        }
    }

    pub(super) fn ensure_writable(&self) -> io::Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "只读事务不能写入。"))
        }
    }

    pub(crate) fn find(&self, rel: &str) -> io::Result<Option<NodeRow>> {
        if rel.is_empty() {
            return Ok(None);
        }
        self.conn
            .query_row(
                &format!("SELECT {NODE_COLUMNS} FROM nodes WHERE path_key = ?1"),
                params![path_key(rel)],
                map_node,
            )
            .optional()
            .map_err(db_error)
    }

    fn children(&self, parent: &str) -> io::Result<Vec<NodeRow>> {
        let key = path_key(parent);
        let mut statement = self
            .conn
            .prepare_cached(&format!(
                "SELECT {NODE_COLUMNS} FROM nodes WHERE parent_key = ?1 AND path_key IS NOT NULL ORDER BY path"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![key], map_node)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    fn descendants(&self, node: &NodeRow) -> io::Result<Vec<NodeRow>> {
        let low = format!("{}/", node.path_key);
        let high = format!("{}0", node.path_key);
        let mut statement = self
            .conn
            .prepare_cached(&format!(
                "SELECT {NODE_COLUMNS} FROM nodes WHERE path_key >= ?1 AND path_key < ?2 ORDER BY path_key"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![low, high], map_node)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }

    /// 第一次改动某个条目前记下它的原状态。
    fn remember(&self, node: &NodeRow) {
        self.touched
            .borrow_mut()
            .entry(node.node_id)
            .or_insert_with(|| Initial { path: Some(node.path.clone()), sha: node.sha.clone() });
    }

    /// 父目录必须存在且是目录；返回父目录的存储路径（根为空串）。
    fn require_parent(&self, rel: &str) -> io::Result<String> {
        let parent = parent_of(rel);
        if parent.is_empty() {
            return Ok(String::new());
        }
        match self.find(parent)? {
            Some(node) if node.kind == NodeKind::Dir => Ok(node.path),
            Some(_) => Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{parent}"))),
            None => Err(not_found(parent)),
        }
    }

    fn joined(parent: &str, name: &str) -> String {
        if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        }
    }

    fn insert_node(&self, path: &str, kind: NodeKind, content: Option<&[u8]>) -> io::Result<i64> {
        let key = path_key(path);
        let (inline, blob_sha, size, sha) = match content {
            Some(bytes) => {
                let (inline, blob_sha, sha) = self.store_content(bytes)?;
                (inline, blob_sha, bytes.len() as i64, Some(sha))
            }
            None => (None, None, 0, None),
        };
        self.conn
            .execute(
                "INSERT INTO nodes (path, path_key, parent_key, kind, inline, blob_sha, size, sha,
                                    created_at, modified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![path, key, parent_key(&key), kind.as_str(), inline, blob_sha, size, sha, self.now],
            )
            .map_err(db_error)?;
        let node_id = self.conn.last_insert_rowid();
        self.touched
            .borrow_mut()
            .entry(node_id)
            .or_insert(Initial { path: None, sha: None });
        Ok(node_id)
    }

    /// 返回 (inline, blob_sha, sha)。大于阈值的先提交进 blob 库。
    fn store_content(&self, bytes: &[u8]) -> io::Result<(Option<Vec<u8>>, Option<String>, String)> {
        let sha = sha256_hex(bytes);
        if bytes.len() > INLINE_MAX {
            self.blobs
                .put(&sha, bytes, &self.now)
                .map_err(|error| io::Error::other(error.to_string()))?;
            Ok((None, Some(sha.clone()), sha))
        } else {
            Ok((Some(bytes.to_vec()), None, sha))
        }
    }

    fn write_file(&self, path: &Path, bytes: &[u8], create_parents: bool) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        if rel.is_empty() {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, "不能写入资料库根目录。"));
        }
        if let Some(existing) = self.find(&rel)? {
            if existing.kind == NodeKind::Dir {
                return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")));
            }
            let sha = sha256_hex(bytes);
            if existing.sha.as_deref() == Some(sha.as_str()) {
                return Ok(());
            }
            self.remember(&existing);
            let (inline, blob_sha, sha) = self.store_content(bytes)?;
            self.conn
                .execute(
                    "UPDATE nodes SET inline = ?1, blob_sha = ?2, size = ?3, sha = ?4, modified_at = ?5
                     WHERE node_id = ?6",
                    params![inline, blob_sha, bytes.len() as i64, sha, self.now, existing.node_id],
                )
                .map_err(db_error)?;
            return Ok(());
        }
        let parent_path = if create_parents {
            let parent = parent_of(&rel);
            if !parent.is_empty() {
                self.create_dir_all(&self.abs(parent))?;
            }
            self.require_parent(&rel)?
        } else {
            self.require_parent(&rel)?
        };
        let stored = Self::joined(&parent_path, name_of(&rel));
        self.insert_node(&stored, NodeKind::File, Some(bytes))?;
        Ok(())
    }

    fn purge(&self, node: &NodeRow) -> io::Result<()> {
        self.remember(node);
        self.conn
            .execute(
                "UPDATE nodes SET path = NULL, path_key = NULL, parent_key = NULL, inline = NULL,
                                  blob_sha = NULL, purged_at = ?1, modified_at = ?1
                 WHERE node_id = ?2",
                params![self.now, node.node_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    fn set_path(&self, node: &NodeRow, new_path: &str) -> io::Result<()> {
        self.remember(node);
        let key = path_key(new_path);
        self.conn
            .execute(
                "UPDATE nodes SET path = ?1, path_key = ?2, parent_key = ?3, modified_at = ?4
                 WHERE node_id = ?5",
                params![new_path, key, parent_key(&key), self.now, node.node_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// 把 `node`（及其后代）挪到 `new_path`。
    fn move_subtree(&self, node: &NodeRow, new_path: &str) -> io::Result<()> {
        let descendants = if node.kind == NodeKind::Dir { self.descendants(node)? } else { Vec::new() };
        // 先把自己与后代挪到临时键，避免改名途中撞上唯一索引（例如只改大小写）。
        let mut planned = vec![(node.clone(), new_path.to_string())];
        for descendant in descendants {
            let suffix = &descendant.path[node.path.len()..];
            planned.push((descendant.clone(), format!("{new_path}{suffix}")));
        }
        for (row, _) in &planned {
            self.remember(row);
            self.conn
                .execute(
                    "UPDATE nodes SET path_key = ?1 WHERE node_id = ?2",
                    params![format!("\u{0}moving/{}", row.node_id), row.node_id],
                )
                .map_err(db_error)?;
        }
        for (row, path) in &planned {
            self.set_path(row, path)?;
        }
        Ok(())
    }

    fn metadata_of(node: &NodeRow) -> VfsMetadata {
        let kind = match node.kind {
            NodeKind::Dir => EntryKind::Dir,
            NodeKind::File => EntryKind::File,
        };
        VfsMetadata::new(kind, node.size.max(0) as u64, parse_time(&node.modified_at), parse_time(&node.created_at))
    }

    fn root_metadata() -> VfsMetadata {
        VfsMetadata::new(EntryKind::Dir, 0, SystemTime::UNIX_EPOCH, SystemTime::UNIX_EPOCH)
    }

    /// 读出某个条目的原始字节（内联或 blob）。
    pub(crate) fn node_bytes(&self, node_id: i64) -> io::Result<Option<Vec<u8>>> {
        let row: Option<(Option<Vec<u8>>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT inline, blob_sha FROM nodes WHERE node_id = ?1",
                params![node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        match row {
            Some((Some(inline), _)) => Ok(Some(inline)),
            Some((None, Some(blob_sha))) => self
                .blobs
                .get(&blob_sha)
                .map_err(|error| io::Error::other(error.to_string())),
            _ => Ok(None),
        }
    }

    /// 条目开头至多 `limit` 字节，内联与 blob 都只读前缀。
    fn node_head(&self, node_id: i64, limit: usize) -> io::Result<Option<Vec<u8>>> {
        let row: Option<(bool, Option<String>)> = self
            .conn
            .query_row(
                "SELECT inline IS NOT NULL, blob_sha FROM nodes WHERE node_id = ?1",
                params![node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        match row {
            Some((true, _)) => read_prefix(self.conn, c"nodes", c"inline", node_id, limit).map(Some).map_err(db_error),
            Some((false, Some(blob_sha))) => self
                .blobs
                .get_prefix(&blob_sha, limit)
                .map_err(|error| io::Error::other(error.to_string())),
            _ => Ok(None),
        }
    }

    /// 按路径找文件条目；目录报 IsADirectory。
    fn file_node(&self, path: &Path) -> io::Result<(String, NodeRow)> {
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        if node.kind == NodeKind::Dir {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")));
        }
        Ok((rel, node))
    }
}

fn content_missing(rel: &str, node: NodeRow) -> io::Error {
    io::Error::other(format!("内容丢失：{rel}（blob {}）", node.blob_sha.unwrap_or_default()))
}

impl Vfs for SqliteVfs<'_> {
    fn root(&self) -> &Path {
        self.root
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let (rel, node) = self.file_node(path)?;
        self.node_bytes(node.node_id)?.ok_or_else(|| content_missing(&rel, node))
    }

    fn read_head(&self, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
        let (rel, node) = self.file_node(path)?;
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        self.node_head(node.node_id, limit)?.ok_or_else(|| content_missing(&rel, node))
    }

    fn metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        let rel = self.rel(path)?;
        if rel.is_empty() {
            return Ok(Self::root_metadata());
        }
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        Ok(Self::metadata_of(&node))
    }

    fn exists(&self, path: &Path) -> bool {
        self.metadata(path).is_ok()
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<VfsDirEntry>> {
        let rel = self.rel(path)?;
        let parent = if rel.is_empty() {
            String::new()
        } else {
            let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
            if node.kind != NodeKind::Dir {
                return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{rel}")));
            }
            node.path
        };
        Ok(self
            .children(&parent)?
            .into_iter()
            .map(|child| {
                let metadata = Self::metadata_of(&child);
                VfsDirEntry::new(self.abs(&child.path), metadata.file_type(), Some(metadata))
            })
            .collect())
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.write_file(path, bytes, false)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.write_file(path, bytes, true)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        if rel.is_empty() || self.find(&rel)?.is_some() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("已存在：{rel}")));
        }
        let parent = self.require_parent(&rel)?;
        self.insert_node(&Self::joined(&parent, name_of(&rel)), NodeKind::Dir, None)?;
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let mut parent = String::new();
        let mut prefix = String::new();
        for part in rel.split('/').filter(|part| !part.is_empty()) {
            prefix = Self::joined(&prefix, part);
            match self.find(&prefix)? {
                Some(node) if node.kind == NodeKind::Dir => parent = node.path,
                Some(_) => {
                    return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("同名文件已存在：{prefix}")))
                }
                None => {
                    let stored = Self::joined(&parent, part);
                    self.insert_node(&stored, NodeKind::Dir, None)?;
                    parent = stored;
                }
            }
        }
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        if node.kind == NodeKind::Dir {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")));
        }
        self.purge(&node)
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        if node.kind != NodeKind::Dir {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{rel}")));
        }
        if !self.children(&node.path)?.is_empty() {
            return Err(io::Error::new(io::ErrorKind::DirectoryNotEmpty, format!("目录不为空：{rel}")));
        }
        self.purge(&node)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        if node.kind != NodeKind::Dir {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{rel}")));
        }
        for descendant in self.descendants(&node)? {
            self.purge(&descendant)?;
        }
        self.purge(&node)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let from_rel = self.rel(from)?;
        let to_rel = self.rel(to)?;
        if from_rel.is_empty() || to_rel.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "不能改名资料库根目录。"));
        }
        let source = self.find(&from_rel)?.ok_or_else(|| not_found(&from_rel))?;
        let to_key = path_key(&to_rel);
        if to_key == source.path_key {
            // 只改大小写或规范化方式：同一个条目换个写法。
            let parent = parent_of(&source.path).to_string();
            let renamed = Self::joined(&parent, name_of(&to_rel));
            if renamed != source.path {
                self.move_subtree(&source, &renamed)?;
            }
            return Ok(());
        }
        if source.kind == NodeKind::Dir && to_key.starts_with(&format!("{}/", source.path_key)) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "不能把目录挪进它自己里面。"));
        }
        let parent = self.require_parent(&to_rel)?;
        if let Some(target) = self.find(&to_rel)? {
            match (source.kind, target.kind) {
                (NodeKind::File, NodeKind::File) => self.purge(&target)?,
                (NodeKind::Dir, NodeKind::Dir) => {
                    if !self.children(&target.path)?.is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::DirectoryNotEmpty,
                            format!("目标目录不为空：{to_rel}"),
                        ));
                    }
                    self.purge(&target)?;
                }
                (NodeKind::File, NodeKind::Dir) => {
                    return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("目标是目录：{to_rel}")))
                }
                (NodeKind::Dir, NodeKind::File) => {
                    return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("目标是文件：{to_rel}")))
                }
            }
        }
        self.move_subtree(&source, &Self::joined(&parent, name_of(&to_rel)))
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
        self.ensure_writable()?;
        let bytes = self.read(from)?;
        self.write_file(to, &bytes, false)?;
        Ok(bytes.len() as u64)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        let rel = self.rel(path)?;
        if rel.is_empty() {
            return Ok(self.root.to_path_buf());
        }
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        Ok(self.abs(&node.path))
    }

    fn content_sha(&self, path: &Path) -> io::Result<String> {
        let rel = self.rel(path)?;
        let node = self.find(&rel)?.ok_or_else(|| not_found(&rel))?;
        node.sha.ok_or_else(|| io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")))
    }

    /// 密匣信封只存在 `lockbox_items` 里（`lockbox/` 路径一律拒绝），id 直接从表里取，不读信封。
    fn lockbox_item_ids(&self) -> io::Result<Option<Vec<String>>> {
        let mut statement = self
            .conn
            .prepare("SELECT item_id FROM lockbox_items WHERE deleted_at IS NULL ORDER BY item_id")
            .map_err(db_error)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(Some(ids))
    }
}
