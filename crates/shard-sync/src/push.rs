//! 补交：按 op_seq 重放 outbox，同一个 op_id 重试。
//!
//! - 有 blob 依赖先上传（内容寻址，已有就跳过）。
//! - 409 `STALE_BASE`（服务器上被改过）、服务器已删除（找不到、或被移进回收站）、409 `FRAGMENT_EXISTS`：
//!   用本地内容 `create_fragment{conflictOf, id: 由 op_id 派生}` 另存冲突副本，这个目标上没补交完的操作
//!   都由副本收下——绝不复活、绝不覆盖。
//! - 其他 4xx：标失败并上报（同一目标后面的操作一并失败，不再拿过期的基线去试）。
//! - 5xx 与网络错误：1–60 秒指数退避加抖动，op_id 不变；网络错误时转为离线。
//! - 401：停下，等重新配对。
//!
//! 基线：每条更新带操作前本地看到的 sha。前一条也是本地操作（`chained`）时，那个 sha 只是本地结果，
//! 服务器上的对应版本要等前一条补交成功才知道——发送前换成前一条的服务器响应里的 `fileSha`。

use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use shard_remote::RemoteError;

use crate::{
    db::{self, OutboxRow, UNSETTLED},
    engine::{in_trash, offset_of, PreparedOp, SyncEngine, SyncError, SyncEvent, VaultChange},
    ids,
    overlay::OverlayVfs,
};

#[derive(Debug, Default)]
pub(crate) struct PushOutcome {
    pub acked: usize,
    pub conflicts: usize,
    pub failed: usize,
    pub retry_at: Option<DateTime<Utc>>,
    pub changes: Vec<VaultChange>,
    /// 网络断了、令牌失效、本地出错：这一轮到此为止。
    pub error: Option<SyncError>,
}

enum Prepared {
    Send(Value),
    /// 发送前就已结算（冲突或失败）。
    Settled,
}

/// 冲突原因：服务器返回的错误里能认出的几种。
fn conflict_reason(error: &RemoteError) -> Option<&'static str> {
    match (error.status, error.code.as_str()) {
        (Some(409), "STALE_BASE") => Some("stale"),
        (Some(409), "FRAGMENT_EXISTS") => Some("exists"),
        // 这期间被另一台设备移进了密匣：公开区里已经没有它，与「服务器已删除」同样处理。
        (Some(409), "LOCKBOX_UNAVAILABLE") => Some("deleted"),
        (Some(404), _) => Some("deleted"),
        (Some(400), "COMMAND_FAILED") if error.message.starts_with("找不到片段") => Some("deleted"),
        _ => None,
    }
}

fn reason_text(reason: &str) -> &'static str {
    match reason {
        "stale" => "服务器上这条在离线期间被改过，本地版本另存为冲突副本。",
        "deleted" => "服务器上这条已被删除，本地版本另存为冲突副本。",
        "exists" => "服务器上已有同 id 的条目，本地版本另存为冲突副本。",
        _ => "前一条操作已另存冲突副本。",
    }
}

/// 第 n 次失败后的等待：1、2、4 … 60 秒，乘以 [0.5, 1) 的抖动。
fn backoff_delay(attempts: i64) -> Duration {
    let base = 2f64.powi((attempts.max(1) - 1).min(6) as i32).min(60.0);
    let factor = rand::thread_rng().gen_range(0.5..1.0);
    Duration::milliseconds(((base * factor).max(1.0) * 1000.0) as i64)
}

impl SyncEngine {
    fn lock_db(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn push(&self) -> PushOutcome {
        let mut outcome = PushOutcome::default();
        let mut last_seen = None;
        loop {
            let op = match db::next_unsettled(&self.lock_db()) {
                Ok(Some(op)) => op,
                Ok(None) => break,
                Err(error) => {
                    outcome.error = Some(error.into());
                    break;
                }
            };
            // 每条处理完都会结算或退避；同一条又排到最前说明本地记录没写进去，这一轮到此为止，免得空转。
            if last_seen == Some(op.op_seq) {
                break;
            }
            last_seen = Some(op.op_seq);
            if let Some(next) = op.next_try_at.as_deref().and_then(|value| DateTime::parse_from_rfc3339(value).ok()) {
                let next = next.with_timezone(&Utc);
                if next > Utc::now() {
                    outcome.retry_at = Some(next);
                    break;
                }
            }
            let args = match self.prepare_send(&op, &mut outcome) {
                Ok(Prepared::Send(args)) => args,
                Ok(Prepared::Settled) => continue,
                Err(error) => {
                    outcome.error = Some(error);
                    break;
                }
            };
            if let Err(error) = self.upload_dependency(&op) {
                match error {
                    SyncError::Remote(remote) if !remote.is_retryable() && !remote.is_unauthenticated() => {
                        self.fail(&op, &remote.message, &mut outcome);
                        continue;
                    }
                    SyncError::Remote(remote) => {
                        self.on_transport_error(&op, remote, &mut outcome);
                        break;
                    }
                    other => {
                        outcome.error = Some(other);
                        break;
                    }
                }
            }
            if let Err(error) = db::mark_inflight(&self.lock_db(), op.op_seq) {
                outcome.error = Some(error.into());
                break;
            }
            match self.client.write_with_key_at(&op.command, &args, &op.op_id, op.utc_offset) {
                Ok(value) => {
                    let trashed = op.target.starts_with("fragment:")
                        && value.get("archived").and_then(Value::as_bool) == Some(true)
                        && !op.target_path.as_deref().is_some_and(in_trash);
                    if let Err(error) = db::mark_acked(&self.lock_db(), op.op_seq, &value) {
                        outcome.error = Some(error.into());
                        break;
                    }
                    outcome.acked += 1;
                    // 服务器在这期间把它移进了回收站，更新落在了回收站里的那份：本地版本再另存一份看得见的副本。
                    if trashed {
                        if let Err(error) = self.conflict(&op, "deleted", &mut outcome) {
                            outcome.error = Some(error);
                            break;
                        }
                    }
                }
                Err(error) if error.is_unauthenticated() || error.is_retryable() || error.status.is_some_and(|status| status >= 500) => {
                    self.on_transport_error(&op, error, &mut outcome);
                    break;
                }
                Err(error) => match conflict_reason(&error) {
                    Some(reason) => {
                        if let Err(error) = self.conflict(&op, reason, &mut outcome) {
                            outcome.error = Some(error);
                            break;
                        }
                    }
                    None => self.fail(&op, &error.message, &mut outcome),
                },
            }
        }
        outcome
    }

    /// 发送前：处理前一条的结果、换基线、看服务器上这条还在不在。
    fn prepare_send(&self, op: &OutboxRow, outcome: &mut PushOutcome) -> Result<Prepared, SyncError> {
        let mut args = op.args.clone();
        let Some(id) = op.target.strip_prefix("fragment:") else {
            return Ok(Prepared::Send(args));
        };
        if op.command == "create_fragment" {
            return Ok(Prepared::Send(args));
        }
        if op.chained {
            let predecessor = db::predecessor(&self.lock_db(), &op.target, op.op_seq)?;
            match predecessor.as_ref().map(|row| row.state.as_str()) {
                Some("conflicted") => {
                    // 前一条已另存冲突副本；这一条是在那之后、本地层收敛之前写的，也另存一份，不丢。
                    self.conflict(op, "superseded", outcome)?;
                    return Ok(Prepared::Settled);
                }
                Some("failed") => {
                    self.fail(op, "前一条操作被服务器拒绝，这条基于它的修改也无法补交。", outcome);
                    return Ok(Prepared::Settled);
                }
                Some("acked") => {
                    let server_sha = predecessor
                        .as_ref()
                        .and_then(|row| row.result.as_ref())
                        .and_then(|result| result.get("fileSha"))
                        .cloned();
                    if op.command == "update_fragment" && op.attempts == 0 {
                        if let Some(sha) = server_sha {
                            args["expectedFileSha"] = sha;
                            db::rewrite_args(&self.lock_db(), op.op_seq, &args)?;
                        }
                    }
                }
                _ => {}
            }
            return Ok(Prepared::Send(args));
        }
        // 基线是已确认层：本轮开头刚拉过，副本就是服务器现在的样子。
        let path = self.replica.find_doc_path("fragment", id)?;
        let deleted = match path.as_deref() {
            None => true,
            Some(path) => in_trash(path) && !op.target_path.as_deref().is_some_and(in_trash),
        };
        if deleted {
            self.conflict(op, "deleted", outcome)?;
            return Ok(Prepared::Settled);
        }
        Ok(Prepared::Send(args))
    }

    fn upload_dependency(&self, op: &OutboxRow) -> Result<(), SyncError> {
        let Some(sha) = op.blob_deps.as_deref() else {
            return Ok(());
        };
        let pending = db::pending_blob(&self.lock_db(), sha)?;
        if let Some((bytes, false)) = pending {
            self.client.upload_blob(&bytes)?;
            db::mark_blob_uploaded(&self.lock_db(), sha)?;
        }
        Ok(())
    }

    /// 网络、5xx、401：op_id 不变，退避后再试。
    fn on_transport_error(&self, op: &OutboxRow, error: RemoteError, outcome: &mut PushOutcome) {
        let attempts = op.attempts + 1;
        let next = Utc::now() + backoff_delay(attempts);
        let _ = db::backoff(&self.lock_db(), op.op_seq, &ids::stamp(next), &error.message);
        outcome.retry_at = Some(next);
        outcome.error = Some(SyncError::Remote(error));
    }

    fn fail(&self, op: &OutboxRow, message: &str, outcome: &mut PushOutcome) {
        let conn = self.lock_db();
        let _ = db::set_state(&conn, op.op_seq, "failed", Some(message));
        let _ = db::settle_target(&conn, &op.target, "failed", "前一条操作被服务器拒绝，这条也无法补交。");
        drop(conn);
        outcome.failed += 1;
        self.emit(SyncEvent::Failed { command: op.command.clone(), target: op.target.clone(), message: message.to_string() });
    }

    /// 另存冲突副本：用本机当前看到的版本（overlay 优先）新建一条 `conflictOf` 指向原条目的碎片，
    /// 这个目标上没补交完的操作全部标为 conflicted。副本 id 与 op_id 都由原操作确定性派生，重试不重复。
    pub(crate) fn conflict(&self, op: &OutboxRow, reason: &str, outcome: &mut PushOutcome) -> Result<(), SyncError> {
        let Some(id) = op.target.strip_prefix("fragment:").map(str::to_string) else {
            self.fail(op, reason_text(reason), outcome);
            return Ok(());
        };
        let copy_op_id = ids::conflict_op_id(&op.op_id);
        let mut copy: Option<(String, Option<VaultChange>)> = None;
        {
            let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut conn = self.lock_db();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if db::op_by_id(&tx, &copy_op_id)?.is_none() {
                let source = self.options.source.clone();
                let local = self.replica.read(|base| -> Result<Option<(String, Vec<String>)>, String> {
                    let vfs = OverlayVfs::new(base, &tx, false);
                    let cx = shard_vault::VaultCtx::local(&vfs, &shard_vault::NoHooks)
                        .with_clock(offset_of(op.utc_offset), &source);
                    let Some(path) = shard_vault::find_fragment_path(&vfs, &id)? else {
                        return Ok(None);
                    };
                    let fragment = shard_vault::read_fragment(&cx, &path, &Default::default(), None)?;
                    Ok(Some((fragment.content, fragment.tags)))
                })??;
                let local = local.or_else(|| {
                    // 本机已经找不到它（不应发生）：至少用这条操作自己带的正文。
                    let content = op.args.get("content").and_then(Value::as_str)?.to_string();
                    let tags = op.args.get("tags").and_then(Value::as_array).map(|tags| {
                        tags.iter().filter_map(|tag| tag.as_str().map(str::to_string)).collect::<Vec<_>>()
                    });
                    Some((content, tags.unwrap_or_default()))
                });
                if let Some((content, tags)) = local.filter(|(content, _)| !content.trim().is_empty()) {
                    let created_at = DateTime::parse_from_rfc3339(&op.created_at)
                        .unwrap_or_else(|_| ids::now_at(op.utc_offset));
                    let copy_id = ids::conflict_fragment_id(&op.op_id, &created_at);
                    let mut args = json!({
                        "content": content,
                        "tags": tags,
                        "id": copy_id,
                        "createdAt": created_at.to_rfc3339(),
                    });
                    if shard_core::is_valid_fragment_id(&id) {
                        args["conflictOf"] = json!(id);
                    }
                    let prepared = PreparedOp {
                        op_id: copy_op_id.clone(),
                        command: "create_fragment".to_string(),
                        args,
                        utc_offset: op.utc_offset,
                        created_at,
                    };
                    match self.apply_local(&tx, &prepared, false) {
                        Ok((value, _)) => {
                            let change = value.get("path").and_then(Value::as_str).map(|path| VaultChange {
                                path: path.to_string(),
                                exists: true,
                                sha: value.get("fileSha").and_then(Value::as_str).map(str::to_string),
                            });
                            copy = Some((copy_id, change));
                        }
                        Err(error) => {
                            // 副本建不出来（本不该发生）：原操作标失败，内容还在 outbox 的参数里。
                            drop(tx);
                            drop(conn);
                            self.fail(op, &format!("另存冲突副本失败：{}", error.message), outcome);
                            return Ok(());
                        }
                    }
                }
            }
            db::settle_target(&tx, &op.target, "conflicted", reason_text(reason))?;
            // 服务器已确认、但写进了回收站里的那份：这条也算冲突（计数与提示），后面基于它的修改同样另存。
            tx.execute(
                "UPDATE outbox SET state = 'conflicted', last_error = ?2 WHERE op_seq = ?1 AND state = 'acked'",
                rusqlite::params![op.op_seq, reason_text(reason)],
            )?;
            tx.commit()?;
        }
        outcome.conflicts += 1;
        let (copy_id, change) = match copy {
            Some((copy_id, change)) => (Some(copy_id), change),
            None => (None, None),
        };
        if let Some(change) = change {
            outcome.changes.push(change);
        }
        self.emit(SyncEvent::Conflict { id, copy_id, reason: reason.to_string() });
        Ok(())
    }

    /// 收敛本地层（最后一次拉取成功后）：操作都已结算的 overlay 条目丢掉，本机改看副本；
    /// 清掉已确认、且同一目标上没有待补交操作的记录，以及传完、不再被引用的附件字节。
    /// 返回本机可见内容因此变了的路径。
    pub(crate) fn settle(&self) -> Result<Vec<VaultChange>, SyncError> {
        let dropped: Vec<String> = {
            let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut conn = self.lock_db();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let condition = format!(
                "NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.state IN {UNSETTLED} AND outbox.op_seq <= overlay.op_seq_max)"
            );
            let dropped = {
                let mut statement = tx.prepare(&format!("SELECT path FROM overlay WHERE {condition}"))?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
                rows
            };
            tx.execute(&format!("DELETE FROM overlay WHERE {condition}"), [])?;
            tx.execute(
                &format!(
                    "DELETE FROM outbox WHERE (state = 'acked' OR (state IN ('conflicted','failed') AND dismissed = 1))
                       AND target NOT IN (SELECT target FROM outbox WHERE state IN {UNSETTLED})"
                ),
                [],
            )?;
            let cutoff = ids::stamp(Utc::now() - Duration::minutes(10));
            tx.execute(
                &format!(
                    "DELETE FROM pending_blobs WHERE uploaded = 1 AND created_at < ?1
                       AND sha NOT IN (SELECT blob_deps FROM outbox WHERE state IN {UNSETTLED} AND blob_deps IS NOT NULL)"
                ),
                [cutoff],
            )?;
            tx.commit()?;
            dropped
        };
        Ok(self.effective(dropped))
    }
}
