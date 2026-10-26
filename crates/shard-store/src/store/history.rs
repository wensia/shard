//! 版本历史：列出与读取修订、最近彻底删除、立即抹除、到期清理。
//!
//! 修订记的是写后状态（见 `record_revision`）。彻底删除的条目节点留作墓碑（`path` 为空），
//! 它的修订再留 [`PURGED_HISTORY_DAYS`] 天供找回；到期或用户「立即抹除」时连同内容一起删掉：
//! 修订行、只被它们引用的 blob、幂等记录里带内容的响应。连接开着 `secure_delete`，删掉的内容
//! 被零覆盖；抹除后再把 WAL 检查点截断，库文件与 WAL 里都不再有旧内容（已有的备份不受影响）。

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{blobs::BlobStore, now_string, Store, StoreError};
use crate::path_key::path_key;

/// 彻底删除后，历史再留这么多天。
pub const PURGED_HISTORY_DAYS: i64 = 30;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionInfo {
    pub rev_id: i64,
    pub node_id: i64,
    /// 这条修订时条目的路径（资料库相对路径）。
    pub path: String,
    /// 内容 sha；删除时刻的记录为空。
    pub sha: Option<String>,
    pub size: Option<i64>,
    /// import / create / edit / rename / move / trash / restore / purge / conflict / revert / migrate
    pub reason: String,
    pub device: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedEntry {
    pub node_id: i64,
    /// 删除前最后一条有内容的修订：「找回」默认恢复它。
    pub rev_id: i64,
    /// 删除前最后的路径（多半在 `.trash/` 下）。
    pub path: String,
    pub sha: Option<String>,
    pub purged_at: String,
    /// 到这个时间历史会被清理。
    pub expires_at: String,
    pub revisions: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EraseReport {
    pub nodes: usize,
    pub revisions: usize,
    pub blobs: usize,
    /// WAL 检查点是否完整截断（有读者占着时会留到下一次）。
    pub wal_truncated: bool,
}

const REVISION_SELECT: &str = "SELECT rev_id, node_id, path_at, sha, length(inline), blob_sha, reason, device, created_at
                               FROM revisions";

/// 一行修订 + 它的 blob（大小要去 blob 库查）。
fn map_revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<(RevisionInfo, Option<String>)> {
    Ok((
        RevisionInfo {
            rev_id: row.get(0)?,
            node_id: row.get(1)?,
            path: row.get(2)?,
            sha: row.get(3)?,
            size: row.get(4)?,
            reason: row.get(6)?,
            device: row.get(7)?,
            created_at: row.get(8)?,
        },
        row.get(5)?,
    ))
}

fn with_blob_size(blobs: &BlobStore, (mut info, blob_sha): (RevisionInfo, Option<String>)) -> Result<RevisionInfo, StoreError> {
    if let Some(sha) = blob_sha {
        info.size = blobs.size(&sha)?;
    }
    Ok(info)
}

/// 某个条目的全部修订，新的在前。
pub(crate) fn node_revisions(conn: &Connection, blobs: &BlobStore, node_id: i64) -> Result<Vec<RevisionInfo>, StoreError> {
    let mut statement = conn.prepare_cached(&format!("{REVISION_SELECT} WHERE node_id = ?1 ORDER BY rev_id DESC"))?;
    let rows = statement.query_map(params![node_id], map_revision)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|row| with_blob_size(blobs, row)).collect()
}

/// 一条修订与它的字节；删除时刻的记录字节为空。blob 丢了报错，不当成空内容。
pub(crate) fn load_revision(
    conn: &Connection,
    blobs: &BlobStore,
    rev_id: i64,
) -> Result<Option<(RevisionInfo, Vec<u8>)>, StoreError> {
    let Some(row) = conn
        .query_row(&format!("{REVISION_SELECT} WHERE rev_id = ?1"), params![rev_id], map_revision)
        .optional()?
    else {
        return Ok(None);
    };
    let blob_sha = row.1.clone();
    let info = with_blob_size(blobs, row)?;
    let bytes = match (&info.sha, blob_sha) {
        (None, _) => Vec::new(),
        (Some(_), Some(sha)) => blobs
            .get(&sha)?
            .ok_or_else(|| StoreError::Invalid(format!("修订 {rev_id} 的内容丢失（blob {sha}）。")))?,
        (Some(_), None) => conn.query_row("SELECT inline FROM revisions WHERE rev_id = ?1", params![rev_id], |row| {
            row.get::<_, Option<Vec<u8>>>(0)
        })?
        .unwrap_or_default(),
    };
    Ok(Some((info, bytes)))
}

fn expires_at(purged_at: &str) -> String {
    DateTime::parse_from_rfc3339(purged_at)
        .map(|time| now_string(time.with_timezone(&Utc) + Duration::days(PURGED_HISTORY_DAYS)))
        .unwrap_or_default()
}

impl Store {
    /// 某个文件当前路径下的修订，新的在前；路径不存在返回 `None`。
    pub fn list_revisions(&self, path: &str) -> Result<Option<(i64, Vec<RevisionInfo>)>, StoreError> {
        self.with_reader(|conn| {
            let node: Option<i64> = conn
                .query_row(
                    "SELECT node_id FROM nodes WHERE path_key = ?1 AND kind = 'file'",
                    params![path_key(path)],
                    |row| row.get(0),
                )
                .optional()?;
            match node {
                Some(node_id) => Ok(Some((node_id, node_revisions(conn, &self.blobs, node_id)?))),
                None => Ok(None),
            }
        })
    }

    /// 按节点列修订（已彻底删除的条目没有路径，用节点找）。
    pub fn list_node_revisions(&self, node_id: i64) -> Result<Vec<RevisionInfo>, StoreError> {
        self.with_reader(|conn| node_revisions(conn, &self.blobs, node_id))
    }

    pub fn read_revision(&self, rev_id: i64) -> Result<Option<(RevisionInfo, Vec<u8>)>, StoreError> {
        self.with_reader(|conn| load_revision(conn, &self.blobs, rev_id))
    }

    /// 最近彻底删除、历史还在的文件，最近删的在前。
    pub fn list_deleted(&self) -> Result<Vec<DeletedEntry>, StoreError> {
        self.with_reader(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT n.node_id, n.purged_at, last.path_at, last.sha,
                        (SELECT COUNT(*) FROM revisions WHERE node_id = n.node_id), last.rev_id
                 FROM nodes n
                 JOIN revisions last ON last.rev_id = (
                   SELECT rev_id FROM revisions WHERE node_id = n.node_id AND sha IS NOT NULL
                   ORDER BY rev_id DESC LIMIT 1)
                 WHERE n.path_key IS NULL AND n.purged_at IS NOT NULL AND n.kind = 'file'
                 ORDER BY n.purged_at DESC, n.node_id DESC",
            )?;
            let entries = statement
                .query_map([], |row| {
                    let purged_at: String = row.get(1)?;
                    Ok(DeletedEntry {
                        node_id: row.get(0)?,
                        expires_at: expires_at(&purged_at),
                        purged_at,
                        path: row.get(2)?,
                        sha: row.get(3)?,
                        revisions: row.get(4)?,
                        rev_id: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(entries)
        })
    }

    /// 立即抹除已彻底删除条目的历史。还在用的条目（有路径）一律拒绝，避免误删在用内容的历史。
    pub fn erase_purged(&self, node_ids: &[i64]) -> Result<EraseReport, StoreError> {
        let mut report = EraseReport::default();
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = rusqlite::Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)?;
        let mut blob_shas = Vec::new();
        let mut erased = Vec::new();
        for &node_id in node_ids {
            let purged: Option<bool> = tx
                .query_row(
                    "SELECT path_key IS NULL AND purged_at IS NOT NULL FROM nodes WHERE node_id = ?1",
                    params![node_id],
                    |row| row.get(0),
                )
                .optional()?;
            match purged {
                Some(true) => {}
                Some(false) => return Err(StoreError::Invalid(format!("条目 {node_id} 还在使用，不能抹除历史。"))),
                None => continue,
            }
            let mut statement =
                tx.prepare_cached("SELECT DISTINCT blob_sha FROM revisions WHERE node_id = ?1 AND blob_sha IS NOT NULL")?;
            blob_shas.extend(statement.query_map(params![node_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?);
            drop(statement);
            // 幂等记录里成功的响应可能带着正文（例如新建碎片返回整条内容）。
            tx.execute(
                "UPDATE txns SET response = NULL
                 WHERE txn_id IN (SELECT txn_id FROM revisions WHERE node_id = ?1
                                  UNION SELECT txn_id FROM changes WHERE node_id = ?1)",
                params![node_id],
            )?;
            report.revisions += tx.execute("DELETE FROM revisions WHERE node_id = ?1", params![node_id])?;
            erased.push(node_id);
            report.nodes += 1;
        }
        if !erased.is_empty() {
            let head: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) FROM changes", [], |row| row.get(0))?;
            scrub_change_paths(&tx, &erased, head)?;
        }
        blob_shas.sort();
        blob_shas.dedup();
        let mut orphaned = Vec::new();
        for sha in blob_shas {
            let referenced: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM nodes WHERE blob_sha = ?1)
                     OR EXISTS (SELECT 1 FROM revisions WHERE blob_sha = ?1)",
                params![sha],
                |row| row.get(0),
            )?;
            if !referenced {
                orphaned.push(sha);
            }
        }
        tx.commit()?;
        // 仍持着写锁：这期间没有内容事务能提交新引用。
        for sha in &orphaned {
            if self.blobs.delete(sha)? {
                report.blobs += 1;
            }
        }
        report.wal_truncated = truncate_wal(&conn)? && self.blobs.truncate_wal()?;
        Ok(report)
    }

    /// 彻底删除满 [`PURGED_HISTORY_DAYS`] 天的条目：抹除历史。服务端定时调用。
    pub fn expire_purged_history(&self, now: DateTime<Utc>) -> Result<EraseReport, StoreError> {
        let cutoff = now_string(now - Duration::days(PURGED_HISTORY_DAYS));
        let node_ids = self.with_reader(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT node_id FROM nodes
                 WHERE path_key IS NULL AND purged_at IS NOT NULL AND purged_at < ?1
                   AND EXISTS (SELECT 1 FROM revisions WHERE revisions.node_id = nodes.node_id)",
            )?;
            let ids = statement.query_map(params![cutoff], |row| row.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
            Ok(ids)
        })?;
        if node_ids.is_empty() {
            return Ok(EraseReport { wal_truncated: true, ..EraseReport::default() });
        }
        self.erase_purged(&node_ids)
    }
}

/// 抹掉这些条目在变化日志里的路径（路径常含标题）：换成不含信息的占位，并把保留下限推进到 `up_to_seq`——
/// 游标更早的客户端会收到 resync、改走全量对账（对账结果本来就没有这个路径），同步依然正确。
/// 在线的客户端已经实时收到过这次变化，不受影响。
pub(crate) fn scrub_change_paths(conn: &Connection, node_ids: &[i64], up_to_seq: i64) -> rusqlite::Result<()> {
    for node_id in node_ids {
        conn.execute(
            "UPDATE changes SET key = '[erased]/' || node_id WHERE node_id = ?1 AND scope = 'public'",
            params![node_id],
        )?;
    }
    conn.execute(
        "UPDATE meta SET value = CAST(?1 AS TEXT) WHERE key = 'changes_floor_seq' AND CAST(value AS INTEGER) < ?1",
        params![up_to_seq],
    )?;
    Ok(())
}

/// 检查点并把 WAL 截成 0 字节；有读者占着旧快照时返回 false（下次再截）。
pub(crate) fn truncate_wal(conn: &Connection) -> Result<bool, StoreError> {
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    Ok(busy == 0)
}
