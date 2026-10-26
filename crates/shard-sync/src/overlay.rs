//! 「已确认层 ∪ overlay」上的 Vfs：离线时领域函数（与服务器同一套 shard-vault 代码）就跑在它上面。
//!
//! - 读：overlay 里有这个路径（按 `path_key`，与内容库同样不区分大小写与规范化）就用 overlay 的，
//!   否则读副本（只读快照）。读目录 = 副本的子项 ∪ overlay 的子项（同键 overlay 覆盖）。
//! - 写：只写 overlay 表（本地事务里），副本只在拉取时写入。新建条目的存储路径 = 父目录的存储路径 + 名字，
//!   与 SqliteVfs 的规则一致。
//! - 离线允许的命令只新建与改写文件、新建目录；删除、改名、移动一律报错（这些命令离线时本来就被拒绝，
//!   万一领域代码走到这里，宁可失败也不在 overlay 里留下服务器无法重放的状态）。
//!
//! 记下本次操作里每个条目第一次被写之前的状态（[`Initial`]）：outbox 用它得到操作前的基线 sha，
//! 以及基线是不是前一条本地操作的结果（`chained`）。

use std::{
    cell::RefCell,
    collections::BTreeMap,
    io,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use rusqlite::{params, Connection, OptionalExtension};
use shard_core::{sha256_hex, EntryKind, Vfs, VfsDirEntry, VfsMetadata};
use shard_store::path_key::{parent_key, path_key};

/// 一个条目在本次操作第一次写入之前的状态。
#[derive(Clone, Debug)]
pub(crate) struct Initial {
    /// 写之前 overlay 里已经有它（前面还有没补交完的本地操作）。
    pub in_overlay: bool,
    /// 写之前的 sha（新建为空）。
    pub sha: Option<String>,
}

/// 本次操作写过的条目：键 → (存储路径, 写之前的状态)。
pub(crate) type Touched = BTreeMap<String, (String, Initial)>;

#[derive(Clone, Debug)]
struct Row {
    path: String,
    kind: String,
    sha: Option<String>,
    size: i64,
    created_at: String,
    modified_at: String,
}

enum Found {
    Overlay(Row),
    Base(VfsMetadata),
    Missing,
}

fn db_error(error: rusqlite::Error) -> io::Error {
    io::Error::other(format!("本地副本错误：{error}"))
}

fn not_found(rel: &str) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, format!("不存在：{rel}"))
}

fn offline_unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "离线时不能删除、改名或移动，需要联网。")
}

fn parse_time(value: &str) -> SystemTime {
    chrono::DateTime::parse_from_rfc3339(value).map(SystemTime::from).unwrap_or(SystemTime::UNIX_EPOCH)
}

fn time_text(time: SystemTime) -> String {
    crate::ids::stamp(chrono::DateTime::<chrono::Utc>::from(time))
}

fn name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map(|index| &rel[..index]).unwrap_or("")
}

fn joined(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

pub(crate) struct OverlayVfs<'a> {
    base: &'a dyn Vfs,
    conn: &'a Connection,
    writable: bool,
    now: String,
    initial: RefCell<Touched>,
}

impl<'a> OverlayVfs<'a> {
    /// `base` 是副本的只读快照；`writable` 时 `conn` 必须在一个写事务里。
    pub(crate) fn new(base: &'a dyn Vfs, conn: &'a Connection, writable: bool) -> Self {
        Self {
            base,
            conn,
            writable,
            now: crate::ids::stamp(chrono::Utc::now()),
            initial: RefCell::new(BTreeMap::new()),
        }
    }

    pub(crate) fn touched(&self) -> Touched {
        self.initial.borrow().clone()
    }

    fn rel(&self, path: &Path) -> io::Result<String> {
        let stripped = path.strip_prefix(self.base.root()).map_err(|_| {
            io::Error::new(io::ErrorKind::PermissionDenied, format!("路径不在资料库内：{}", path.display()))
        })?;
        let mut parts = Vec::new();
        for component in stripped.components() {
            match component {
                Component::Normal(part) => {
                    let part = part
                        .to_str()
                        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "路径不是有效的 UTF-8。"))?;
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
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "密匣内容不以明文存放在内容库里。"));
        }
        Ok(rel)
    }

    fn abs(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.base.root().to_path_buf()
        } else {
            self.base.root().join(rel)
        }
    }

    fn row(&self, key: &str) -> io::Result<Option<Row>> {
        self.conn
            .query_row(
                "SELECT path, kind, sha, size, created_at, modified_at FROM overlay WHERE key = ?1",
                params![key],
                |row| {
                    Ok(Row {
                        path: row.get(0)?,
                        kind: row.get(1)?,
                        sha: row.get(2)?,
                        size: row.get(3)?,
                        created_at: row.get(4)?,
                        modified_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(db_error)
    }

    fn find(&self, rel: &str) -> io::Result<Found> {
        if !rel.is_empty() {
            if let Some(row) = self.row(&path_key(rel))? {
                return Ok(Found::Overlay(row));
            }
        }
        match self.base.metadata(&self.abs(rel)) {
            Ok(metadata) => Ok(Found::Base(metadata)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Found::Missing),
            Err(error) => Err(error),
        }
    }

    /// 已存在条目的存储路径（显示用的大小写）。
    fn stored(&self, rel: &str, found: &Found) -> io::Result<String> {
        match found {
            Found::Overlay(row) => Ok(row.path.clone()),
            Found::Base(_) if rel.is_empty() => Ok(String::new()),
            Found::Base(_) => {
                let canonical = self.base.canonicalize(&self.abs(rel))?;
                Ok(canonical
                    .strip_prefix(self.base.root())
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| rel.to_string()))
            }
            Found::Missing => Err(not_found(rel)),
        }
    }

    fn metadata_of(row: &Row) -> VfsMetadata {
        let kind = if row.kind == "dir" { EntryKind::Dir } else { EntryKind::File };
        VfsMetadata::new(kind, row.size.max(0) as u64, parse_time(&row.modified_at), parse_time(&row.created_at))
    }

    fn ensure_writable(&self) -> io::Result<()> {
        if self.writable {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "只读视图不能写入。"))
        }
    }

    fn remember(&self, key: &str, stored: &str, initial: Initial) {
        self.initial.borrow_mut().entry(key.to_string()).or_insert_with(|| (stored.to_string(), initial));
    }

    /// 父目录必须存在且是目录；返回父目录的存储路径。
    fn require_parent(&self, rel: &str) -> io::Result<String> {
        let parent = parent_of(rel);
        if parent.is_empty() {
            return Ok(String::new());
        }
        let found = self.find(parent)?;
        match &found {
            Found::Overlay(row) if row.kind == "dir" => Ok(row.path.clone()),
            Found::Base(metadata) if metadata.is_dir() => self.stored(parent, &found),
            Found::Missing => Err(not_found(parent)),
            _ => Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{parent}"))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert(
        &self,
        stored: &str,
        kind: &str,
        data: Option<&[u8]>,
        sha: Option<&str>,
        size: i64,
        created_at: &str,
    ) -> io::Result<()> {
        let key = path_key(stored);
        self.conn
            .execute(
                "INSERT INTO overlay (key, parent_key, path, kind, data, sha, size, created_at, modified_at, op_seq_max)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
                 ON CONFLICT(key) DO UPDATE SET path = excluded.path, kind = excluded.kind, data = excluded.data,
                   sha = excluded.sha, size = excluded.size, modified_at = excluded.modified_at",
                params![key, parent_key(&key), stored, kind, data, sha, size, created_at, self.now],
            )
            .map_err(db_error)?;
        Ok(())
    }

    fn insert_dir(&self, stored: &str) -> io::Result<()> {
        self.remember(&path_key(stored), stored, Initial { in_overlay: false, sha: None });
        self.upsert(stored, "dir", None, None, 0, &self.now.clone())
    }

    fn write_file(&self, path: &Path, bytes: &[u8], create_parents: bool) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        if rel.is_empty() {
            return Err(io::Error::new(io::ErrorKind::IsADirectory, "不能写入资料库根目录。"));
        }
        let sha = sha256_hex(bytes);
        let found = self.find(&rel)?;
        let (stored, created_at, initial) = match &found {
            Found::Overlay(row) if row.kind == "dir" => {
                return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")))
            }
            Found::Overlay(row) => {
                if row.sha.as_deref() == Some(sha.as_str()) {
                    return Ok(());
                }
                (row.path.clone(), row.created_at.clone(), Initial { in_overlay: true, sha: row.sha.clone() })
            }
            Found::Base(metadata) if metadata.is_dir() => {
                return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")))
            }
            Found::Base(metadata) => {
                let current = self.base.content_sha(path)?;
                if current == sha {
                    return Ok(());
                }
                let created = metadata.created().map(time_text).unwrap_or_else(|_| self.now.clone());
                (self.stored(&rel, &found)?, created, Initial { in_overlay: false, sha: Some(current) })
            }
            Found::Missing => {
                if create_parents {
                    let parent = parent_of(&rel);
                    if !parent.is_empty() {
                        self.create_dir_all(&self.abs(parent))?;
                    }
                }
                let parent = self.require_parent(&rel)?;
                (joined(&parent, name_of(&rel)), self.now.clone(), Initial { in_overlay: false, sha: None })
            }
        };
        self.remember(&path_key(&stored), &stored, initial);
        self.upsert(&stored, "file", Some(bytes), Some(&sha), bytes.len() as i64, &created_at)
    }
}

impl Vfs for OverlayVfs<'_> {
    fn root(&self) -> &Path {
        self.base.root()
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let rel = self.rel(path)?;
        if !rel.is_empty() {
            let key = path_key(&rel);
            let row: Option<(String, Option<Vec<u8>>)> = self
                .conn
                .query_row("SELECT kind, data FROM overlay WHERE key = ?1", params![key], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()
                .map_err(db_error)?;
            match row {
                Some((kind, _)) if kind == "dir" => {
                    return Err(io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")))
                }
                Some((_, data)) => return Ok(data.unwrap_or_default()),
                None => {}
            }
        }
        self.base.read(path)
    }

    fn metadata(&self, path: &Path) -> io::Result<VfsMetadata> {
        let rel = self.rel(path)?;
        match self.find(&rel)? {
            Found::Overlay(row) => Ok(Self::metadata_of(&row)),
            Found::Base(metadata) => Ok(metadata),
            Found::Missing => Err(not_found(&rel)),
        }
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<VfsDirEntry>> {
        let rel = self.rel(path)?;
        let found = self.find(&rel)?;
        let base_has_dir = match &found {
            Found::Overlay(row) if row.kind != "dir" => {
                return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{rel}")))
            }
            Found::Overlay(_) => matches!(self.base.metadata(path), Ok(metadata) if metadata.is_dir()),
            Found::Base(metadata) if !metadata.is_dir() => {
                return Err(io::Error::new(io::ErrorKind::NotADirectory, format!("不是目录：{rel}")))
            }
            Found::Base(_) => true,
            Found::Missing => return Err(not_found(&rel)),
        };
        let mut entries: BTreeMap<String, (String, VfsDirEntry)> = BTreeMap::new();
        if base_has_dir {
            for entry in self.base.read_dir(path)? {
                let stored = entry
                    .path()
                    .strip_prefix(self.base.root())
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                entries.insert(path_key(&stored), (stored, entry));
            }
        }
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT path, kind, sha, size, created_at, modified_at FROM overlay WHERE parent_key = ?1",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![path_key(&rel)], |row| {
                Ok(Row {
                    path: row.get(0)?,
                    kind: row.get(1)?,
                    sha: row.get(2)?,
                    size: row.get(3)?,
                    created_at: row.get(4)?,
                    modified_at: row.get(5)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for row in rows {
            let metadata = Self::metadata_of(&row);
            let entry = VfsDirEntry::new(self.abs(&row.path), metadata.file_type(), Some(metadata));
            entries.insert(path_key(&row.path), (row.path, entry));
        }
        // 与 SqliteVfs 一样按存储路径排序。
        let mut entries: Vec<(String, VfsDirEntry)> = entries.into_values().collect();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(entries.into_iter().map(|(_, entry)| entry).collect())
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
        if rel.is_empty() || !matches!(self.find(&rel)?, Found::Missing) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("已存在：{rel}")));
        }
        let parent = self.require_parent(&rel)?;
        self.insert_dir(&joined(&parent, name_of(&rel)))
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.ensure_writable()?;
        let rel = self.rel(path)?;
        let mut parent = String::new();
        let mut prefix = String::new();
        for part in rel.split('/').filter(|part| !part.is_empty()) {
            prefix = joined(&prefix, part);
            let found = self.find(&prefix)?;
            match &found {
                Found::Overlay(row) if row.kind == "dir" => parent = row.path.clone(),
                Found::Base(metadata) if metadata.is_dir() => parent = self.stored(&prefix, &found)?,
                Found::Missing => {
                    let stored = joined(&parent, part);
                    self.insert_dir(&stored)?;
                    parent = stored;
                }
                _ => {
                    return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("同名文件已存在：{prefix}")))
                }
            }
        }
        Ok(())
    }

    fn remove_file(&self, _path: &Path) -> io::Result<()> {
        Err(offline_unsupported())
    }

    fn remove_dir(&self, _path: &Path) -> io::Result<()> {
        Err(offline_unsupported())
    }

    fn remove_dir_all(&self, _path: &Path) -> io::Result<()> {
        Err(offline_unsupported())
    }

    fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
        Err(offline_unsupported())
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
        let bytes = self.read(from)?;
        self.write_file(to, &bytes, false)?;
        Ok(bytes.len() as u64)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        let rel = self.rel(path)?;
        if rel.is_empty() {
            return Ok(self.base.root().to_path_buf());
        }
        match self.find(&rel)? {
            Found::Overlay(row) => Ok(self.abs(&row.path)),
            Found::Base(_) => self.base.canonicalize(path),
            Found::Missing => Err(not_found(&rel)),
        }
    }

    fn content_sha(&self, path: &Path) -> io::Result<String> {
        let rel = self.rel(path)?;
        match self.find(&rel)? {
            Found::Overlay(row) => {
                row.sha.ok_or_else(|| io::Error::new(io::ErrorKind::IsADirectory, format!("是目录：{rel}")))
            }
            Found::Base(_) => self.base.content_sha(path),
            Found::Missing => Err(not_found(&rel)),
        }
    }

    fn lockbox_item_ids(&self) -> io::Result<Option<Vec<String>>> {
        self.base.lockbox_item_ids()
    }
}
