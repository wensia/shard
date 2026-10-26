//! 服务端内容库：`shard.db`（内容）+ `blobs.db`（大文件）。
//!
//! 一个写命令 = 一个 `BEGIN IMMEDIATE` 事务。领域逻辑在 [`SqliteVfs`] 上按 `std::fs` 语义读写，
//! 提交时由 [`Store::write`] 统一：
//! 1. 记一条 `txns`；
//! 2. 按条目比较事务前后的路径与 sha，写 `changes`（在事务内分配 seq）；
//! 3. 写 `revisions`（同设备 5 分钟内的编辑合并成一条）；
//! 4. 重算派生投影。
//!
//! 单写者（进程内一把锁 + IMMEDIATE）保证提交顺序就是 seq 顺序，增量拉取不会漏数据。

mod blobs;
mod history;
mod lockbox;
mod maintenance;
mod schema;
mod sqlite_vfs;

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Mutex,
};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};

pub use blobs::INLINE_MAX;
pub use history::{DeletedEntry, EraseReport, RevisionInfo, PURGED_HISTORY_DAYS};
pub use lockbox::{LockboxItemEntry, LockboxManifestEntry};
pub use maintenance::{MaintenanceReport, BLOB_GRACE_DAYS, REVISION_FULL_DAYS};
pub use sqlite_vfs::{LockboxItemRaw, SqliteVfs};

use crate::projection::{project, Projection};
use sqlite_vfs::{Initial, NodeKind};

/// 修订合并窗口：同设备、同条目在这段时间内的编辑合并成一条。
const REVISION_MERGE_WINDOW_MINUTES: i64 = 5;

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// 同一个 op_id 已经提交过（幂等键冲突），由调用方查 [`Store::find_txn`] 决定怎么回应。
    DuplicateOp(String),
    Invalid(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(error) => write!(f, "内容库错误：{error}"),
            StoreError::Io(error) => write!(f, "{error}"),
            StoreError::DuplicateOp(op_id) => write!(f, "操作 {op_id} 已经提交过。"),
            StoreError::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError::Io(error)
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}

/// 一次写操作的上下文。
#[derive(Clone, Debug)]
pub struct WriteCtx {
    /// 命令名（与 RPC / Tauri 命令同名），进审计。
    pub command: String,
    /// 幂等键；同一个键只会提交一次。
    pub op_id: Option<String>,
    /// session:<…> | device:<id> | admin | import …
    pub actor: String,
    /// 修订合并按设备区分。
    pub device: Option<String>,
    /// 请求体的 sha，用来识别「同 op_id 不同载荷」。
    pub request_sha: Option<String>,
    /// 测试用：固定当前时间。
    pub now: Option<DateTime<Utc>>,
    /// 覆盖修订原因（导入时记为 import，而不是 create）。
    pub revision_reason: Option<&'static str>,
}

impl WriteCtx {
    pub fn new(command: impl Into<String>, actor: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            op_id: None,
            actor: actor.into(),
            device: None,
            request_sha: None,
            now: None,
            revision_reason: None,
        }
    }

    pub fn with_op_id(mut self, op_id: impl Into<String>) -> Self {
        self.op_id = Some(op_id.into());
        self
    }

    pub fn with_device(mut self, device: impl Into<String>) -> Self {
        self.device = Some(device.into());
        self
    }

    pub fn with_now(mut self, now: DateTime<Utc>) -> Self {
        self.now = Some(now);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeRecord {
    pub seq: i64,
    pub path: String,
    pub exists: bool,
    pub sha: Option<String>,
    /// dir | file
    pub kind: String,
}

#[derive(Clone, Debug, Default)]
pub struct Committed {
    pub txn_id: i64,
    pub changes: Vec<ChangeRecord>,
    /// 密匣（条目或 manifest）这次有没有变：服务端据此推 `lockbox-changed`，客户端重取快照。
    pub lockbox_changed: bool,
    /// 本事务分配的最大 seq（含密匣范围）。
    pub last_seq: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct TxnRecord {
    pub txn_id: i64,
    pub command: String,
    pub request_sha: Option<String>,
    pub response: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct VerifyReport {
    /// `PRAGMA integrity_check` 的结果，正常是 "ok"。
    pub integrity: String,
    pub foreign_key_errors: i64,
    pub files: i64,
    /// 被引用却取不到的 blob。
    pub missing_blobs: Vec<String>,
}

impl VerifyReport {
    pub fn is_ok(&self) -> bool {
        self.integrity == "ok" && self.foreign_key_errors == 0 && self.missing_blobs.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    /// dir | file
    pub kind: String,
    pub sha: Option<String>,
    pub size: i64,
    pub seq: i64,
}

#[derive(Clone, Debug)]
pub struct ChangesPage {
    pub vault_id: String,
    pub epoch: String,
    pub floor_seq: i64,
    pub head_seq: i64,
    pub changes: Vec<ChangeRecord>,
    pub more: bool,
}

pub struct Store {
    root: PathBuf,
    content_path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    blobs: blobs::BlobStore,
}

/// 内容库默认的虚拟根。领域逻辑拿它拼绝对路径，SqliteVfs 再剥掉；从不触盘。
pub const DEFAULT_VIRTUAL_ROOT: &str = "/shard-vault";

fn now_string(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Micros, true)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Store {
    /// 打开（必要时创建）数据目录下的 `shard.db` 与 `blobs.db`。
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        Self::open_with_root(data_dir, Path::new(DEFAULT_VIRTUAL_ROOT))
    }

    pub fn open_with_root(data_dir: &Path, virtual_root: &Path) -> Result<Self, StoreError> {
        if !virtual_root.is_absolute() {
            return Err(StoreError::Invalid("虚拟根必须是绝对路径。".to_string()));
        }
        std::fs::create_dir_all(data_dir)?;
        let content_path = data_dir.join("shard.db");
        let writer = Connection::open(&content_path)?;
        schema::configure(&writer)?;
        schema::migrate_content(&writer)?;
        let blobs = blobs::BlobStore::open(&data_dir.join("blobs.db"))?;
        let store = Self {
            root: virtual_root.to_path_buf(),
            content_path,
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
            blobs,
        };
        store.ensure_meta()?;
        Ok(store)
    }

    fn ensure_meta(&self) -> Result<(), StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = conn.unchecked_transaction()?;
        for (key, value) in [
            ("vault_id", random_hex(16)),
            ("epoch", random_hex(8)),
            ("markdown_dialect", "2".to_string()),
            ("changes_floor_seq", "0".to_string()),
        ] {
            tx.execute("INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        Ok(conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?)
    }

    /// 服务端设置（如「允许网页解锁密匣」）。随内容库备份与恢复。
    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 抹掉明文之后调用：检查点并把 WAL 截成 0 字节。有读者占着旧快照时返回 false（下次再截）。
    pub fn truncate_wal(&self) -> Result<bool, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        history::truncate_wal(&conn)
    }

    /// 从备份恢复后调用：换一个 epoch，客户端发现后走全量对账。
    pub fn rotate_epoch(&self) -> Result<String, StoreError> {
        let epoch = random_hex(8);
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute("UPDATE meta SET value = ?1 WHERE key = 'epoch'", params![epoch])?;
        Ok(epoch)
    }

    /// 从读连接池借一条连接（没有就新开）。
    fn with_reader<R>(&self, f: impl FnOnce(&Connection) -> Result<R, StoreError>) -> Result<R, StoreError> {
        let conn = match self.readers.lock().expect("读连接池锁中毒").pop() {
            Some(conn) => conn,
            None => {
                let conn = Connection::open(&self.content_path)?;
                schema::configure(&conn)?;
                conn
            }
        };
        let result = f(&conn);
        self.readers.lock().expect("读连接池锁中毒").push(conn);
        result
    }

    /// 只读快照：闭包里的写操作一律失败。
    pub fn read<R>(&self, f: impl FnOnce(&SqliteVfs<'_>) -> R) -> Result<R, StoreError> {
        let conn = match self.readers.lock().expect("读连接池锁中毒").pop() {
            Some(conn) => conn,
            None => {
                let conn = Connection::open(&self.content_path)?;
                schema::configure(&conn)?;
                conn
            }
        };
        conn.execute_batch("BEGIN DEFERRED")?;
        let result = {
            let vfs = SqliteVfs::new(&conn, &self.blobs, &self.root, false, now_string(Utc::now()));
            f(&vfs)
        };
        conn.execute_batch("COMMIT")?;
        self.readers.lock().expect("读连接池锁中毒").push(conn);
        Ok(result)
    }

    /// 执行一个写命令。闭包返回错误时整个事务回滚，不留下任何变化。
    pub fn write<R, E>(
        &self,
        ctx: &WriteCtx,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<R, E>,
    ) -> Result<(R, Committed), E>
    where
        E: From<StoreError>,
    {
        self.write_inner(ctx, f, None::<fn(&R) -> Vec<u8>>)
    }

    /// 同 [`Store::write`]，并把编码后的响应与事务一起提交，供幂等重试原样返回。
    pub fn write_recorded<R, E>(
        &self,
        ctx: &WriteCtx,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<R, E>,
        encode: impl FnOnce(&R) -> Vec<u8>,
    ) -> Result<(R, Committed), E>
    where
        E: From<StoreError>,
    {
        self.write_inner(ctx, f, Some(encode))
    }

    fn write_inner<R, E, F>(
        &self,
        ctx: &WriteCtx,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<R, E>,
        encode: Option<F>,
    ) -> Result<(R, Committed), E>
    where
        E: From<StoreError>,
        F: FnOnce(&R) -> Vec<u8>,
    {
        let now = ctx.now.unwrap_or_else(Utc::now);
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute_batch("BEGIN IMMEDIATE").map_err(|error| E::from(error.into()))?;
        let outcome = (|| {
            let vfs = SqliteVfs::new(&conn, &self.blobs, &self.root, true, now_string(now));
            let value = f(&vfs)?;
            let response = encode.map(|encode| encode(&value));
            let committed = finalize(&conn, &vfs, ctx, now, response).map_err(E::from)?;
            Ok::<_, E>((value, committed))
        })();
        match outcome {
            Ok(result) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(result),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(E::from(error.into()))
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// 不论闭包成功与否都提交：用于「先写下冲突副本、再报告冲突」的命令（导图、画布保存）。
    /// 编码函数拿到成败两种结果，由调用方决定怎么存进幂等记录，重试时才能原样回放同一个错误。
    /// 只有提交本身失败时才回滚。
    pub fn write_keeping_partial<R, E>(
        &self,
        ctx: &WriteCtx,
        f: impl FnOnce(&SqliteVfs<'_>) -> Result<R, E>,
        encode: impl FnOnce(&Result<R, E>) -> Vec<u8>,
    ) -> Result<(Result<R, E>, Committed), StoreError> {
        let now = ctx.now.unwrap_or_else(Utc::now);
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            let vfs = SqliteVfs::new(&conn, &self.blobs, &self.root, true, now_string(now));
            let result = f(&vfs);
            let response = encode(&result);
            let committed = finalize(&conn, &vfs, ctx, now, Some(response))?;
            Ok::<_, StoreError>((result, committed))
        })();
        match outcome.and_then(|result| conn.execute_batch("COMMIT").map(|_| result).map_err(StoreError::from)) {
            Ok(result) => Ok(result),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// 一致快照：`VACUUM INTO` 把 shard.db 与 blobs.db 写进一个空目录。运行中的服务照常读写，
    /// 不能用 cp 复制 WAL 模式的库文件（会拿到不一致的副本）。
    pub fn snapshot_into(&self, out_dir: &Path) -> Result<(), StoreError> {
        std::fs::create_dir_all(out_dir)?;
        for name in ["shard.db", "blobs.db"] {
            if out_dir.join(name).exists() {
                return Err(StoreError::Invalid(format!("快照目录里已有 {name}，请换一个空目录。")));
            }
        }
        // 先 blob 后内容：内容库引用的 blob 一定已在 blob 快照里（blob 只追加）。
        self.blobs.vacuum_into(&out_dir.join("blobs.db"))?;
        let conn = self.writer.lock().expect("写连接锁中毒");
        conn.execute("VACUUM INTO ?1", params![out_dir.join("shard.db").to_string_lossy()])?;
        Ok(())
    }

    /// 恢复演练与例行检查：完整性检查、外键检查，以及每个文件条目的内容都取得到。
    pub fn verify(&self) -> Result<VerifyReport, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let foreign_key_errors: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))?;
        let files: i64 = conn.query_row(
            "SELECT COUNT(*) FROM nodes WHERE path_key IS NOT NULL AND kind = 'file'",
            [],
            |row| row.get(0),
        )?;
        let mut statement = conn.prepare(
            "SELECT DISTINCT blob_sha FROM nodes WHERE blob_sha IS NOT NULL
             UNION SELECT DISTINCT blob_sha FROM revisions WHERE blob_sha IS NOT NULL",
        )?;
        let shas = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(conn);
        let mut missing_blobs = Vec::new();
        for sha in shas {
            if !self.blobs.contains(&sha)? {
                missing_blobs.push(sha);
            }
        }
        Ok(VerifyReport { integrity, foreign_key_errors, files, missing_blobs })
    }

    /// 服务端 `HEAD /api/blobs/<sha>`：客户端上传前探测，已有就跳过。
    pub fn has_blob(&self, sha: &str) -> Result<bool, StoreError> {
        self.blobs.contains(sha)
    }

    /// 服务端 `PUT /api/blobs/<sha>`：重算 sha256，不一致拒收（内容寻址的前提）。
    pub fn put_blob(&self, expected_sha: &str, bytes: &[u8]) -> Result<(), StoreError> {
        let actual = crate::sha256_hex(bytes);
        if actual != expected_sha {
            return Err(StoreError::Invalid(format!("内容哈希不符：期望 {expected_sha}，实际 {actual}。")));
        }
        self.blobs.put(&actual, bytes, &now_string(Utc::now()))
    }

    pub fn get_blob(&self, sha: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.blobs.get(sha)
    }

    pub fn find_txn(&self, op_id: &str) -> Result<Option<TxnRecord>, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        Ok(conn
            .query_row(
                "SELECT txn_id, command, request_sha, response FROM txns WHERE op_id = ?1",
                params![op_id],
                |row| {
                    Ok(TxnRecord {
                        txn_id: row.get(0)?,
                        command: row.get(1)?,
                        request_sha: row.get(2)?,
                        response: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// 全部在用条目（不含墓碑），按路径排序。客户端发现 epoch 变化或游标过旧时用它全量对账。
    pub fn manifest(&self) -> Result<Vec<ManifestEntry>, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let mut statement = conn.prepare(
            "SELECT path, kind, sha, size, seq FROM nodes WHERE path_key IS NOT NULL ORDER BY path",
        )?;
        let entries = statement
            .query_map([], |row| {
                Ok(ManifestEntry {
                    path: row.get(0)?,
                    kind: row.get(1)?,
                    sha: row.get(2)?,
                    size: row.get(3)?,
                    seq: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn head_seq(&self) -> Result<i64, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM changes", [], |row| row.get(0))?)
    }

    /// 增量拉取：`seq > since` 的变化，按 seq 升序。
    pub fn changes_since(&self, since: i64, limit: usize) -> Result<ChangesPage, StoreError> {
        let vault_id = self.meta("vault_id")?.unwrap_or_default();
        let epoch = self.meta("epoch")?.unwrap_or_default();
        let floor_seq = self
            .meta("changes_floor_seq")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        self.with_reader(|conn| {
            let head_seq: i64 =
                conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM changes", [], |row| row.get(0))?;
            let mut statement = conn.prepare_cached(
                "SELECT seq, key, exists_, sha, kind FROM changes
                 WHERE scope = 'public' AND seq > ?1 ORDER BY seq LIMIT ?2",
            )?;
            let mut changes = statement
                .query_map(params![since, limit as i64 + 1], |row| {
                    Ok(ChangeRecord {
                        seq: row.get(0)?,
                        path: row.get(1)?,
                        exists: row.get::<_, i64>(2)? == 1,
                        sha: row.get(3)?,
                        kind: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let more = changes.len() > limit;
            changes.truncate(limit);
            Ok(ChangesPage { vault_id, epoch, floor_seq, head_seq, changes, more })
        })
    }
}

struct FinalRow {
    path: Option<String>,
    kind: NodeKind,
    sha: Option<String>,
}

fn load_final(conn: &Connection, node_id: i64) -> rusqlite::Result<FinalRow> {
    conn.query_row(
        "SELECT path, kind, sha FROM nodes WHERE node_id = ?1",
        params![node_id],
        |row| {
            let kind: String = row.get(1)?;
            Ok(FinalRow {
                path: row.get(0)?,
                kind: if kind == "dir" { NodeKind::Dir } else { NodeKind::File },
                sha: row.get(2)?,
            })
        },
    )
}

fn in_trash(path: &str) -> bool {
    let key = path.to_lowercase();
    key == ".trash" || key.starts_with(".trash/")
}

fn parent_dir(path: &str) -> &str {
    path.rfind('/').map(|index| &path[..index]).unwrap_or("")
}

fn revision_reason(initial: &Initial, final_path: Option<&str>, content_changed: bool) -> &'static str {
    match (initial.path.as_deref(), final_path) {
        (None, _) => "create",
        (Some(_), None) => "purge",
        (Some(before), Some(after)) if before != after => {
            if in_trash(after) && !in_trash(before) {
                "trash"
            } else if in_trash(before) && !in_trash(after) {
                "restore"
            } else if parent_dir(before).to_lowercase() == parent_dir(after).to_lowercase() {
                "rename"
            } else {
                "move"
            }
        }
        _ if content_changed => "edit",
        _ => "edit",
    }
}

fn finalize(
    conn: &Connection,
    vfs: &SqliteVfs<'_>,
    ctx: &WriteCtx,
    now: DateTime<Utc>,
    response: Option<Vec<u8>>,
) -> Result<Committed, StoreError> {
    let now_text = now_string(now);
    let inserted = conn.execute(
        "INSERT INTO txns (op_id, command, actor, device, request_sha, response, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![ctx.op_id, ctx.command, ctx.actor, ctx.device, ctx.request_sha, response, now_text],
    );
    if let Err(rusqlite::Error::SqliteFailure(error, _)) = &inserted {
        if error.code == rusqlite::ErrorCode::ConstraintViolation {
            return Err(StoreError::DuplicateOp(ctx.op_id.clone().unwrap_or_default()));
        }
    }
    inserted?;
    let txn_id = conn.last_insert_rowid();

    let mut changes = Vec::new();
    for (node_id, initial) in vfs.take_touched() {
        let final_row = load_final(conn, node_id)?;
        let existed = initial.path.is_some();
        let exists = final_row.path.is_some();
        if !existed && !exists {
            // 本事务里建了又删：不留痕迹。
            conn.execute("DELETE FROM nodes WHERE node_id = ?1", params![node_id])?;
            continue;
        }
        let path_changed = initial.path.as_deref() != final_row.path.as_deref();
        let content_changed = initial.sha != final_row.sha;
        if existed && exists && !path_changed && !content_changed {
            continue;
        }

        let kind = final_row.kind.as_str().to_string();
        let mut last_seq = None;
        let mut emit = |path: &str, exists: bool, sha: Option<String>| -> Result<(), StoreError> {
            conn.execute(
                "INSERT INTO changes (txn_id, scope, key, node_id, exists_, sha, kind)
                 VALUES (?1, 'public', ?2, ?3, ?4, ?5, ?6)",
                params![txn_id, path, node_id, exists as i64, sha, kind],
            )?;
            let seq = conn.last_insert_rowid();
            last_seq = Some(seq);
            changes.push(ChangeRecord { seq, path: path.to_string(), exists, sha, kind: kind.clone() });
            Ok(())
        };
        if let Some(before) = initial.path.as_deref() {
            if path_changed || !exists {
                emit(before, false, None)?;
            }
        }
        if let Some(after) = final_row.path.as_deref() {
            if path_changed || content_changed || !existed {
                emit(after, true, final_row.sha.clone())?;
            }
        }
        if let Some(seq) = last_seq {
            conn.execute(
                "UPDATE nodes SET seq = ?1, revision = revision + ?2 WHERE node_id = ?3",
                params![seq, existed as i64, node_id],
            )?;
        }

        if final_row.kind == NodeKind::File {
            let reason = ctx
                .revision_reason
                .unwrap_or_else(|| revision_reason(&initial, final_row.path.as_deref(), content_changed));
            record_revision(conn, ctx, txn_id, node_id, &initial, final_row.path.as_deref(), reason, now)?;
            match final_row.path.as_deref() {
                Some(path) => {
                    let projection = match vfs.node_bytes(node_id)? {
                        Some(bytes) if bytes.len() <= INLINE_MAX => project(path, &bytes),
                        _ => Projection::default(),
                    };
                    write_projection(conn, node_id, &projection)?;
                }
                None => write_projection(conn, node_id, &Projection::default())?,
            }
        }
    }

    let lockbox_touched = vfs.take_lockbox_touched();
    let lockbox_changed = !lockbox_touched.is_empty();
    for touch in lockbox_touched {
        conn.execute(
            "INSERT INTO changes (txn_id, scope, key, node_id, exists_, sha, kind) VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'file')",
            params![txn_id, touch.scope, touch.key, touch.sha.is_some() as i64, touch.sha],
        )?;
        let seq = conn.last_insert_rowid();
        match touch.scope {
            "lockbox" => {
                conn.execute("UPDATE lockbox_items SET seq = ?1 WHERE item_id = ?2", params![seq, touch.key])?;
                // 密文的版本历史（只有密文，服务器读不出内容）。
                if touch.sha.is_some() {
                    conn.execute(
                        "INSERT INTO lockbox_revisions (item_id, envelope, sha, txn_id, created_at)
                         SELECT item_id, envelope, sha, ?1, ?2 FROM lockbox_items WHERE item_id = ?3 AND envelope IS NOT NULL",
                        params![txn_id, now_string(now), touch.key],
                    )?;
                }
            }
            _ => {
                conn.execute("UPDATE lockbox_manifest SET seq = ?1 WHERE id = 1", params![seq])?;
            }
        };
    }

    // 移入密匣的公开内容：连同全部明文修订、幂等记录里带正文的响应一起抹掉（本事务自己的响应不含正文）。
    let erased = vfs.take_erase_on_commit();
    for &node_id in &erased {
        conn.execute(
            "UPDATE txns SET response = NULL
             WHERE txn_id <> ?2 AND txn_id IN (SELECT txn_id FROM revisions WHERE node_id = ?1
                                                UNION SELECT txn_id FROM changes WHERE node_id = ?1)",
            params![node_id, txn_id],
        )?;
        conn.execute("DELETE FROM revisions WHERE node_id = ?1", params![node_id])?;
    }

    let (first_seq, last_seq): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT MIN(seq), MAX(seq) FROM changes WHERE txn_id = ?1",
        params![txn_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    conn.execute(
        "UPDATE txns SET first_seq = ?1, last_seq = ?2 WHERE txn_id = ?3",
        params![first_seq, last_seq, txn_id],
    )?;
    // 变化日志里的旧路径（常含标题）也抹掉；保留下限推进到本事务。
    if !erased.is_empty() {
        history::scrub_change_paths(conn, &erased, last_seq.unwrap_or(0))?;
    }
    Ok(Committed { txn_id, changes, lockbox_changed, last_seq })
}

#[allow(clippy::too_many_arguments)]
fn record_revision(
    conn: &Connection,
    ctx: &WriteCtx,
    txn_id: i64,
    node_id: i64,
    initial: &Initial,
    final_path: Option<&str>,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let path_at = final_path.or(initial.path.as_deref()).unwrap_or_default().to_string();
    let (sha, inline, blob_sha): (Option<String>, Option<Vec<u8>>, Option<String>) = if final_path.is_some() {
        conn.query_row(
            "SELECT sha, inline, blob_sha FROM nodes WHERE node_id = ?1",
            params![node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
    } else {
        (None, None, None)
    };
    let now_text = now_string(now);

    if reason == "edit" {
        let window_start = now_string(now - Duration::minutes(REVISION_MERGE_WINDOW_MINUTES));
        let mergeable: Option<i64> = conn
            .query_row(
                "SELECT rev_id FROM revisions
                 WHERE node_id = ?1 AND sealed = 0 AND reason = 'edit' AND path_at = ?2
                   AND device IS ?3 AND created_at >= ?4
                 ORDER BY rev_id DESC LIMIT 1",
                params![node_id, path_at, ctx.device, window_start],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(rev_id) = mergeable {
            let latest: i64 = conn.query_row(
                "SELECT MAX(rev_id) FROM revisions WHERE node_id = ?1",
                params![node_id],
                |row| row.get(0),
            )?;
            if latest == rev_id {
                conn.execute(
                    "UPDATE revisions SET sha = ?1, inline = ?2, blob_sha = ?3, txn_id = ?4 WHERE rev_id = ?5",
                    params![sha, inline, blob_sha, txn_id, rev_id],
                )?;
                return Ok(());
            }
        }
    }

    conn.execute("UPDATE revisions SET sealed = 1 WHERE node_id = ?1 AND sealed = 0", params![node_id])?;
    conn.execute(
        "INSERT INTO revisions (node_id, path_at, sha, inline, blob_sha, reason, txn_id, device, created_at, sealed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            node_id,
            path_at,
            sha,
            inline,
            blob_sha,
            reason,
            txn_id,
            ctx.device,
            now_text,
            (reason != "edit") as i64
        ],
    )?;
    Ok(())
}

fn write_projection(conn: &Connection, node_id: i64, projection: &Projection) -> Result<(), StoreError> {
    conn.execute("DELETE FROM doc_index WHERE node_id = ?1", params![node_id])?;
    conn.execute("DELETE FROM doc_tags WHERE node_id = ?1", params![node_id])?;
    conn.execute("DELETE FROM doc_links WHERE node_id = ?1", params![node_id])?;
    if let Some(doc) = &projection.doc {
        conn.execute(
            "INSERT INTO doc_index (node_id, doc_ns, doc_id, lookup_scope, type_tag, title, pinned,
                                    created_at, updated_at, conflict_of)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                node_id,
                doc.ns,
                doc.doc_id,
                doc.lookup_scope as i64,
                doc.type_tag,
                doc.title,
                doc.pinned as i64,
                doc.created_at,
                doc.updated_at,
                doc.conflict_of
            ],
        )?;
    }
    for tag in &projection.tags {
        conn.execute(
            "INSERT OR IGNORE INTO doc_tags (node_id, tag) VALUES (?1, ?2)",
            params![node_id, tag],
        )?;
    }
    for (kind, target) in &projection.links {
        conn.execute(
            "INSERT OR IGNORE INTO doc_links (node_id, link_kind, target) VALUES (?1, ?2, ?3)",
            params![node_id, kind, target],
        )?;
    }
    Ok(())
}
