//! 同步表：与副本内容（shard-store 的表）在同一个 `replica.db` 文件里，由引擎自己的连接读写。
//!
//! 与方案 §5 的 DDL 相比的调整（理由写在各表上）：
//! - `confirmed`：方案里没有。记每个路径在服务器上的 seq——副本内容表的 `nodes.seq` 是副本自己分配的，
//!   恢复备份后的对账要比的是服务器 seq（「seq 大于服务器 head 的是恢复点之后写的」）。
//! - `overlay` 去掉 `scope`：本版密匣离线只读（缓存的密文快照），overlay 里只有公开内容。按 `path_key`
//!   （NFC + 小写）做键，与内容库同一套大小写规则；另记显示用的路径、父目录键与时间，读目录、列树用。
//! - `outbox` 加 `chained`、`target_path`、`utc_offset`、`dismissed`、`fail_count`、`first_failed_at`：见各列注释。
//! - `pending_blobs` 存字节本身（离线粘贴的图片在补交前只在这里）。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// 未结算的操作：还要发给服务器。
pub(crate) const UNSETTLED: &str = "('pending','inflight')";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_url TEXT NOT NULL,
  vault_id TEXT NOT NULL DEFAULT '',
  epoch TEXT NOT NULL DEFAULT '',
  cursor_seq INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL DEFAULT '',
  -- 服务器给的 `vaultPath`（shard://<域名>/<vault_id>），离线时列表与搜索照样返回它。
  vault_identity TEXT,
  -- 最近一次在线 list_fragments 看到的「密匣已设置」。
  lockbox_configured INTEGER NOT NULL DEFAULT 0,
  -- 最近一次在线取到的密匣快照（只有密文）；离线时密匣客户端照样能列出、解锁只读。
  lockbox_snapshot TEXT,
  last_pull_at TEXT,
  last_push_at TEXT
);

-- 每个路径在服务器上最后一次变化的 seq（已确认层的元数据）。
CREATE TABLE IF NOT EXISTS confirmed (
  path_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  server_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS outbox (
  op_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,                 -- UUIDv7 = 幂等键；请求体改了（合并）就换新的
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,                    -- 原样的 RPC 参数，已含客户端 id / createdAt / 基线 sha
  target TEXT NOT NULL,                       -- fragment:<id> | asset:<sha>
  target_path TEXT,                           -- 操作时目标文件的路径（判断「被移进回收站」）
  base_sha TEXT,                              -- 操作前目标文件的 sha（本地看到的）
  chained INTEGER NOT NULL DEFAULT 0,         -- 1 = 基线是前一条本地操作的结果，补交时换成那条的服务器结果
  blob_deps TEXT,                             -- 先传完这个 blob 才能发
  utc_offset INTEGER NOT NULL,                -- 操作时的时区（X-Shard-UTC-Offset）
  state TEXT NOT NULL CHECK (state IN ('pending','inflight','acked','conflicted','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,                   -- RFC 3339，带操作时的时区
  result_json TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,       -- 冲突 / 失败的提示已被用户看过
  fail_count INTEGER NOT NULL DEFAULT 0,      -- 服务器连续出错（5xx）的次数；网络不通不算
  first_failed_at TEXT                        -- 这一串服务器出错里第一次的时间
);
CREATE INDEX IF NOT EXISTS outbox_target ON outbox(target, op_seq);
CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state, op_seq);

CREATE TABLE IF NOT EXISTS overlay (
  key TEXT PRIMARY KEY,                       -- path_key
  parent_key TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file','dir')),
  data BLOB,
  sha TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  op_seq_max INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS overlay_parent ON overlay(parent_key);

CREATE TABLE IF NOT EXISTS pending_blobs (
  sha TEXT PRIMARY KEY,
  mime TEXT,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
"#;

pub(crate) fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA busy_timeout = 10000;",
    )?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 已有的同步表补上后来加的列（`CREATE TABLE IF NOT EXISTS` 不会给旧表加列）。
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('outbox')")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for (name, ddl) in [
        ("fail_count", "ALTER TABLE outbox ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0"),
        ("first_failed_at", "ALTER TABLE outbox ADD COLUMN first_failed_at TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            conn.execute_batch(ddl)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SyncState {
    pub server_url: String,
    pub vault_id: String,
    pub epoch: String,
    pub cursor_seq: i64,
    pub vault_identity: Option<String>,
    pub lockbox_configured: bool,
    pub last_pull_at: Option<String>,
}

pub(crate) fn load_state(conn: &Connection) -> rusqlite::Result<Option<SyncState>> {
    conn.query_row(
        "SELECT server_url, vault_id, epoch, cursor_seq, vault_identity, lockbox_configured, last_pull_at
         FROM sync_state WHERE id = 1",
        [],
        |row| {
            Ok(SyncState {
                server_url: row.get(0)?,
                vault_id: row.get(1)?,
                epoch: row.get(2)?,
                cursor_seq: row.get(3)?,
                vault_identity: row.get(4)?,
                lockbox_configured: row.get::<_, i64>(5)? != 0,
                last_pull_at: row.get(6)?,
            })
        },
    )
    .optional()
}

pub(crate) fn init_state(conn: &Connection, server_url: &str, device_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_state (id, server_url, device_id) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id",
        params![server_url, device_id],
    )?;
    Ok(())
}

pub(crate) fn lockbox_snapshot(conn: &Connection) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row("SELECT lockbox_snapshot FROM sync_state WHERE id = 1", [], |row| row.get(0))
        .optional()?
        .flatten())
}

/// 一条 outbox 记录。
#[derive(Clone, Debug)]
pub(crate) struct OutboxRow {
    pub op_seq: i64,
    pub op_id: String,
    pub command: String,
    pub args: Value,
    pub target: String,
    pub target_path: Option<String>,
    pub base_sha: Option<String>,
    pub chained: bool,
    pub blob_deps: Option<String>,
    pub utc_offset: i32,
    pub state: String,
    pub attempts: i64,
    pub next_try_at: Option<String>,
    pub created_at: String,
    pub result: Option<Value>,
    pub last_error: Option<String>,
    /// 服务器连续出错的次数与第一次的时间（超过上限就不再重试）。
    pub fail_count: i64,
    pub first_failed_at: Option<String>,
}

const OUTBOX_COLUMNS: &str = "op_seq, op_id, command, args_json, target, target_path, base_sha, chained, blob_deps, \
                              utc_offset, state, attempts, next_try_at, created_at, result_json, last_error, \
                              fail_count, first_failed_at";

fn map_outbox(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxRow> {
    let args: String = row.get(3)?;
    let result: Option<String> = row.get(14)?;
    Ok(OutboxRow {
        op_seq: row.get(0)?,
        op_id: row.get(1)?,
        command: row.get(2)?,
        args: serde_json::from_str(&args).unwrap_or(Value::Null),
        target: row.get(4)?,
        target_path: row.get(5)?,
        base_sha: row.get(6)?,
        chained: row.get::<_, i64>(7)? != 0,
        blob_deps: row.get(8)?,
        utc_offset: row.get(9)?,
        state: row.get(10)?,
        attempts: row.get(11)?,
        next_try_at: row.get(12)?,
        created_at: row.get(13)?,
        result: result.and_then(|text| serde_json::from_str(&text).ok()),
        last_error: row.get(15)?,
        fail_count: row.get(16)?,
        first_failed_at: row.get(17)?,
    })
}

/// 全部还要发的操作，按 op_seq。补交时同一目标被挡住（退避中）就跳过它，其他目标照常发。
pub(crate) fn unsettled_ops(conn: &Connection) -> rusqlite::Result<Vec<OutboxRow>> {
    let mut statement =
        conn.prepare(&format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE state IN {UNSETTLED} ORDER BY op_seq"))?;
    let rows = statement.query_map([], map_outbox)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 同一目标上排在 `op_seq` 前面的最近一条。
pub(crate) fn predecessor(conn: &Connection, target: &str, op_seq: i64) -> rusqlite::Result<Option<OutboxRow>> {
    conn.query_row(
        &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE target = ?1 AND op_seq < ?2 ORDER BY op_seq DESC LIMIT 1"),
        params![target, op_seq],
        map_outbox,
    )
    .optional()
}

/// 同一目标上最新的一条（合并时看它）。
pub(crate) fn last_for_target(conn: &Connection, target: &str) -> rusqlite::Result<Option<OutboxRow>> {
    conn.query_row(
        &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE target = ?1 ORDER BY op_seq DESC LIMIT 1"),
        params![target],
        map_outbox,
    )
    .optional()
}

pub(crate) fn op_by_id(conn: &Connection, op_id: &str) -> rusqlite::Result<Option<OutboxRow>> {
    conn.query_row(&format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE op_id = ?1"), params![op_id], map_outbox)
        .optional()
}

pub(crate) fn unsettled_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM outbox WHERE state IN {UNSETTLED}"), [], |row| row.get(0))
}

pub(crate) fn has_unsettled_for(conn: &Connection, target: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            &format!("SELECT 1 FROM outbox WHERE target = ?1 AND state IN {UNSETTLED} LIMIT 1"),
            params![target],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub(crate) fn set_state(conn: &Connection, op_seq: i64, state: &str, error: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbox SET state = ?2, last_error = COALESCE(?3, last_error), next_try_at = NULL WHERE op_seq = ?1",
        params![op_seq, state, error],
    )?;
    Ok(())
}

/// 同一目标上还没结算的操作一并改成 `state`（冲突副本已经收下了它们的内容，或前面一条失败了）。
pub(crate) fn settle_target(conn: &Connection, target: &str, state: &str, error: &str) -> rusqlite::Result<usize> {
    conn.execute(
        &format!(
            "UPDATE outbox SET state = ?2, last_error = ?3, next_try_at = NULL
             WHERE target = ?1 AND state IN {UNSETTLED}"
        ),
        params![target, state, error],
    )
}

pub(crate) fn mark_inflight(conn: &Connection, op_seq: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbox SET state = 'inflight', attempts = attempts + 1 WHERE op_seq = ?1",
        params![op_seq],
    )?;
    Ok(())
}

pub(crate) fn mark_acked(conn: &Connection, op_seq: i64, result: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbox SET state = 'acked', result_json = ?2, last_error = NULL, next_try_at = NULL WHERE op_seq = ?1",
        params![op_seq, result.to_string()],
    )?;
    Ok(())
}

/// 服务器出错（5xx）：记一次连续出错并退避。
pub(crate) fn server_failure(conn: &Connection, op_seq: i64, next_try_at: &str, error: &str, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbox SET state = 'pending', next_try_at = ?2, last_error = ?3, fail_count = fail_count + 1,
                           first_failed_at = COALESCE(first_failed_at, ?4)
         WHERE op_seq = ?1",
        params![op_seq, next_try_at, error, now],
    )?;
    Ok(())
}

pub(crate) fn backoff(conn: &Connection, op_seq: i64, next_try_at: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbox SET state = 'pending', next_try_at = ?2, last_error = ?3 WHERE op_seq = ?1",
        params![op_seq, next_try_at, error],
    )?;
    Ok(())
}

pub(crate) fn rewrite_args(conn: &Connection, op_seq: i64, args: &Value) -> rusqlite::Result<()> {
    conn.execute("UPDATE outbox SET args_json = ?2 WHERE op_seq = ?1", params![op_seq, args.to_string()])?;
    Ok(())
}

/// 崩溃或退出时在途的请求：服务器可能已经提交，用同一个 op_id 重发（服务器按幂等键回放）。
pub(crate) fn reset_inflight(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("UPDATE outbox SET state = 'pending' WHERE state = 'inflight'", [])?;
    Ok(())
}

/// 给状态栏的计数：(待上传, 冲突（按目标数）, 失败)。
pub(crate) fn counts(conn: &Connection) -> rusqlite::Result<(i64, i64, i64)> {
    let pending = unsettled_count(conn)?;
    let conflicts: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT target) FROM outbox WHERE state = 'conflicted' AND dismissed = 0",
        [],
        |row| row.get(0),
    )?;
    let failed: i64 =
        conn.query_row("SELECT COUNT(*) FROM outbox WHERE state = 'failed' AND dismissed = 0", [], |row| row.get(0))?;
    Ok((pending, conflicts, failed))
}

pub(crate) fn pending_blob(conn: &Connection, sha: &str) -> rusqlite::Result<Option<(Vec<u8>, bool)>> {
    conn.query_row("SELECT data, uploaded FROM pending_blobs WHERE sha = ?1", params![sha], |row| {
        Ok((row.get(0)?, row.get::<_, i64>(1)? != 0))
    })
    .optional()
}

pub(crate) fn put_pending_blob(conn: &Connection, sha: &str, bytes: &[u8], uploaded: bool, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO pending_blobs (sha, size, data, uploaded, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(sha) DO UPDATE SET uploaded = MAX(uploaded, excluded.uploaded)",
        params![sha, bytes.len() as i64, bytes, uploaded as i64, now],
    )?;
    Ok(())
}

pub(crate) fn mark_blob_uploaded(conn: &Connection, sha: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE pending_blobs SET uploaded = 1 WHERE sha = ?1", params![sha])?;
    Ok(())
}
