//! 例行维护（服务端定时调用）：修订保留策略与 blob 回收。
//!
//! - 修订：90 天内全部保留；更早的每个条目每天只留当天最后一条。密匣的密文修订同样处理。
//!   每个条目最新的那条总是留着（它就是 last-good）。
//! - blob：内容寻址、只追加。先把不再被条目或修订引用的标记为「未引用」，再被引用就取消标记；
//!   标记满 [`BLOB_GRACE_DAYS`] 天才删。宽限期照顾「已上传、还没提交引用」的 blob，以及离线很久的客户端
//!   按 sha 引用旧 blob（它们上传前先 HEAD，缺了会重传）。备份把 shard.db 与 blobs.db 一起打包，
//!   从备份恢复不依赖宽限期。

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;

use super::{now_string, Store, StoreError};

/// 修订全部保留的天数，之后每天留一条。
pub const REVISION_FULL_DAYS: i64 = 90;
/// 未引用的 blob 再留的天数。
pub const BLOB_GRACE_DAYS: i64 = 35;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    pub revisions_dropped: usize,
    pub lockbox_revisions_dropped: usize,
    pub blobs_marked: usize,
    pub blobs_deleted: usize,
}

impl Store {
    /// 90 天前的修订按「条目 + 自然日（UTC）」只留最后一条。
    pub fn compact_revisions(&self, now: DateTime<Utc>) -> Result<MaintenanceReport, StoreError> {
        let cutoff = now_string(now - Duration::days(REVISION_FULL_DAYS));
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        // created_at 是 RFC 3339 UTC（`…Z`），前 10 个字符就是日期。
        let revisions_dropped = tx.execute(
            "DELETE FROM revisions
             WHERE created_at < ?1
               AND rev_id NOT IN (SELECT MAX(rev_id) FROM revisions GROUP BY node_id, substr(created_at, 1, 10))
               AND rev_id NOT IN (SELECT MAX(rev_id) FROM revisions GROUP BY node_id)",
            params![cutoff],
        )?;
        let lockbox_revisions_dropped = tx.execute(
            "DELETE FROM lockbox_revisions
             WHERE created_at < ?1
               AND rev_id NOT IN (SELECT MAX(rev_id) FROM lockbox_revisions GROUP BY item_id, substr(created_at, 1, 10))
               AND rev_id NOT IN (SELECT MAX(rev_id) FROM lockbox_revisions GROUP BY item_id)",
            params![cutoff],
        )?;
        tx.commit()?;
        Ok(MaintenanceReport { revisions_dropped, lockbox_revisions_dropped, ..MaintenanceReport::default() })
    }

    /// **只给桌面副本用**：清掉副本自己的变化日志与没被修订引用的事务记录。副本只在拉取时写入、只供本机读，
    /// 它的 `changes` / `txns` 没有读者，不清会随每次拉取一直长。服务器绝不能调用——增量拉取、SSE 补发与
    /// 幂等重试都靠这两张表。
    pub fn prune_replica_log(&self) -> Result<(), StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM changes", [])?;
        tx.execute(
            "DELETE FROM txns WHERE txn_id NOT IN (SELECT txn_id FROM revisions)
                                AND txn_id NOT IN (SELECT txn_id FROM lockbox_revisions)",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 标记、取消标记并删除到期的未引用 blob。删除时持着内容库的写锁：这期间没有事务能提交新引用。
    pub fn collect_blobs(&self, now: DateTime<Utc>) -> Result<MaintenanceReport, StoreError> {
        let conn = self.writer.lock().expect("写连接锁中毒");
        let mut statement = conn.prepare(
            "SELECT blob_sha FROM nodes WHERE blob_sha IS NOT NULL
             UNION SELECT blob_sha FROM revisions WHERE blob_sha IS NOT NULL",
        )?;
        let referenced: HashSet<String> =
            statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<_, _>>()?;
        drop(statement);
        let (blobs_marked, blobs_deleted) = self.blobs.collect(
            &referenced,
            &now_string(now),
            &now_string(now - Duration::days(BLOB_GRACE_DAYS)),
        )?;
        Ok(MaintenanceReport { blobs_marked, blobs_deleted, ..MaintenanceReport::default() })
    }
}
