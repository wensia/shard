//! 补交：按 op_seq 重放 outbox，同一个 op_id 重试。
//!
//! - 有 blob 依赖先上传（内容寻址，已有就跳过）。
//! - 409 `STALE_BASE`（服务器上被改过）、服务器已删除（404，或补交前副本里已没有 / 被移进回收站）、
//!   409 `FRAGMENT_EXISTS`：用本地内容 `create_fragment{conflictOf, id: 由 op_id 派生}` 另存冲突副本，
//!   这个目标上没补交完的操作都由副本收下——绝不复活、绝不覆盖。
//! - **移入了密匣**（409 `LOCKBOX_UNAVAILABLE`，或「服务器已没有」时这个 id 出现在刚取的密匣快照里）：
//!   绝不发任何公开写（另存公开副本等于把用户藏进密匣的内容以明文放回公开区）。操作标失败，本地内容另存到
//!   本机 `recovered_dir`。取不到快照、拿不准时先不处理，留在队列里下轮再判——宁可延迟也不外泄。
//! - 其他 4xx：标失败并上报，本地内容另存本机（同一目标后面的操作一并失败，不再拿过期的基线去试）。
//! - 5xx：只挡住同一目标后面的操作，其他目标照常补交；1–60 秒指数退避加抖动，op_id 不变。同一条连续出错
//!   超过上限（次数与时长都超过，见 [`crate::EngineOptions::max_server_failures`]）标失败，内容另存本机。
//! - 网络不通：整轮停下转为离线（其他目标也发不出去），不计入出错次数。401：停下，等重新登录。
//!
//! 基线：每条更新带操作前本地看到的 sha。前一条也是本地操作（`chained`）时，那个 sha 只是本地结果，
//! 服务器上的对应版本要等前一条补交成功才知道——发送前换成前一条的服务器响应里的 `fileSha`。

use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
};

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

/// 「已移入密匣」类失败的说明文字前缀（同一目标后面的操作据此照样处理）。
const SEALED_PREFIX: &str = "这条已移入密匣";

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

impl PushOutcome {
    fn retry_at(&mut self, at: DateTime<Utc>) {
        self.retry_at = Some(self.retry_at.map_or(at, |current| current.min(at)));
    }
}

enum Prepared {
    Send(Value),
    /// 发送前就已结算（冲突或失败）。
    Settled,
    /// 还判断不了（取不到密匣快照）：留在队列里下轮再判。
    Defer(SyncError),
}

/// 服务器拒绝一条补交的几种情形。
#[derive(Debug, PartialEq, Eq)]
enum Rejection {
    /// 另存冲突副本（`stale` / `exists`）。
    Conflict(&'static str),
    /// 服务器上已经没有：先看是不是移进了密匣，不是再另存冲突副本。
    Deleted,
    /// 服务器明确说是密匣条目。
    Sealed,
    Failed,
}

fn classify_rejection(error: &RemoteError) -> Rejection {
    match (error.status, error.code.as_str()) {
        (Some(409), "STALE_BASE") => Rejection::Conflict("stale"),
        (Some(409), "FRAGMENT_EXISTS") => Rejection::Conflict("exists"),
        (Some(409), "LOCKBOX_UNAVAILABLE") => Rejection::Sealed,
        // 领域的「找不到…」：服务器返回 404（错误码仍是 COMMAND_FAILED）。
        (Some(404), _) => Rejection::Deleted,
        // 旧服务器对「找不到片段」返回 400：只作兜底。
        (Some(400), "COMMAND_FAILED") if error.message.starts_with("找不到片段") => Rejection::Deleted,
        _ => Rejection::Failed,
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

/// 另存文件名里用的 id：只留字母、数字、`-`、`_`。
fn file_stem(id: &str) -> String {
    id.chars().map(|char| if char.is_ascii_alphanumeric() || char == '-' || char == '_' { char } else { '_' }).collect()
}

impl SyncEngine {
    fn lock_db(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn push(&self) -> PushOutcome {
        let mut outcome = PushOutcome::default();
        // 这一轮里被挡住的目标（在退避、或刚出错）：它后面的操作先不发，其他目标照常。
        let mut blocked: HashSet<String> = HashSet::new();
        let mut seen: HashSet<i64> = HashSet::new();
        // 这一轮取过的密匣条目 id（判断「服务器已没有」是不是移进了密匣）。
        let mut lockbox_ids: Option<HashSet<String>> = None;
        loop {
            let ops = match db::unsettled_ops(&self.lock_db()) {
                Ok(ops) => ops,
                Err(error) => {
                    outcome.error = Some(error.into());
                    break;
                }
            };
            let Some(op) = ops.into_iter().find(|op| !seen.contains(&op.op_seq) && !blocked.contains(&op.target)) else {
                break;
            };
            seen.insert(op.op_seq);
            if let Some(next) = op.next_try_at.as_deref().and_then(|value| DateTime::parse_from_rfc3339(value).ok()) {
                let next = next.with_timezone(&Utc);
                if next > Utc::now() {
                    blocked.insert(op.target.clone());
                    outcome.retry_at(next);
                    continue;
                }
            }
            let args = match self.prepare_send(&op, &mut outcome, &mut lockbox_ids) {
                Ok(Prepared::Send(args)) => args,
                Ok(Prepared::Settled) => continue,
                Ok(Prepared::Defer(error)) => {
                    if self.defer(&op, error, &mut outcome, &mut blocked) {
                        break;
                    }
                    continue;
                }
                Err(error) => {
                    outcome.error = Some(error);
                    break;
                }
            };
            if let Err(error) = self.upload_dependency(&op) {
                let stop = match error {
                    SyncError::Remote(remote) => self.rejected(&op, remote, &mut outcome, &mut blocked, &mut lockbox_ids),
                    other => {
                        outcome.error = Some(other);
                        true
                    }
                };
                if stop {
                    break;
                }
                continue;
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
                Err(error) => {
                    if self.rejected(&op, error, &mut outcome, &mut blocked, &mut lockbox_ids) {
                        break;
                    }
                }
            }
        }
        outcome
    }

    /// 处理一次失败的请求（补交或附件上传）。返回 true 表示这一轮到此为止（网络断了、令牌失效、本地出错）。
    fn rejected(
        &self,
        op: &OutboxRow,
        error: RemoteError,
        outcome: &mut PushOutcome,
        blocked: &mut HashSet<String>,
        lockbox_ids: &mut Option<HashSet<String>>,
    ) -> bool {
        if error.status.is_none() || error.is_unauthenticated() {
            let next = Utc::now() + backoff_delay(op.attempts + 1);
            let _ = db::backoff(&self.lock_db(), op.op_seq, &ids::stamp(next), &error.message);
            outcome.retry_at(next);
            outcome.error = Some(SyncError::Remote(error));
            return true;
        }
        if error.status.is_some_and(|status| status >= 500) {
            self.server_error(op, &error, outcome);
            blocked.insert(op.target.clone());
            return false;
        }
        let handled = match classify_rejection(&error) {
            Rejection::Conflict(reason) => self.conflict(op, reason, outcome).map(|_| None),
            Rejection::Deleted => self.deleted(op, outcome, lockbox_ids),
            Rejection::Sealed => {
                self.sealed(op, outcome);
                Ok(None)
            }
            Rejection::Failed => {
                self.fail(op, &error.message, outcome);
                Ok(None)
            }
        };
        match handled {
            Ok(None) => false,
            Ok(Some(defer)) => self.defer(op, defer, outcome, blocked),
            Err(error) => {
                outcome.error = Some(error);
                true
            }
        }
    }

    /// 服务器出错（5xx）：记一次、退避；连续出错次数与时长都超过上限就标失败。
    fn server_error(&self, op: &OutboxRow, error: &RemoteError, outcome: &mut PushOutcome) {
        let now = Utc::now();
        let count = op.fail_count + 1;
        let first = op
            .first_failed_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
            .unwrap_or(now);
        let window = Duration::from_std(self.options.server_failure_window).unwrap_or(Duration::hours(1));
        if count >= self.options.max_server_failures && now - first >= window {
            self.fail(op, &format!("服务器连续出错 {count} 次（{}），已停止重试。", error.message), outcome);
            return;
        }
        let next = now + backoff_delay(count);
        let _ = db::server_failure(&self.lock_db(), op.op_seq, &ids::stamp(next), &error.message, &ids::stamp(now));
        outcome.retry_at(next);
    }

    /// 还判断不了：退避后下轮再判（不计入出错次数），只挡住这个目标。网络不通（没有任何响应）时整轮停下。
    fn defer(&self, op: &OutboxRow, error: SyncError, outcome: &mut PushOutcome, blocked: &mut HashSet<String>) -> bool {
        let next = Utc::now() + backoff_delay(op.attempts + 1);
        let _ = db::backoff(&self.lock_db(), op.op_seq, &ids::stamp(next), &format!("暂时判断不了，下轮再试：{error}"));
        outcome.retry_at(next);
        blocked.insert(op.target.clone());
        if error.is_unreachable() {
            outcome.error = Some(error);
            return true;
        }
        false
    }

    /// 发送前：处理前一条的结果、换基线、看服务器上这条还在不在。
    fn prepare_send(
        &self,
        op: &OutboxRow,
        outcome: &mut PushOutcome,
        lockbox_ids: &mut Option<HashSet<String>>,
    ) -> Result<Prepared, SyncError> {
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
                    let sealed = predecessor
                        .as_ref()
                        .and_then(|row| row.last_error.as_deref())
                        .is_some_and(|error| error.starts_with(SEALED_PREFIX));
                    if sealed {
                        self.sealed(op, outcome);
                    } else {
                        self.fail(op, "前一条操作被服务器拒绝，这条基于它的修改也无法补交。", outcome);
                    }
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
        match self.replica.find_doc_path("fragment", id)? {
            None => match self.deleted(op, outcome, lockbox_ids)? {
                None => Ok(Prepared::Settled),
                Some(defer) => Ok(Prepared::Defer(defer)),
            },
            Some(path) if in_trash(&path) && !op.target_path.as_deref().is_some_and(in_trash) => {
                self.conflict(op, "deleted", outcome)?;
                Ok(Prepared::Settled)
            }
            Some(_) => Ok(Prepared::Send(args)),
        }
    }

    /// 服务器上已经没有这条：移进了密匣 → 标失败、只另存本机；否则另存冲突副本。
    /// 取不到密匣快照时返回 `Some(错误)`：先不处理，下轮再判。
    fn deleted(
        &self,
        op: &OutboxRow,
        outcome: &mut PushOutcome,
        lockbox_ids: &mut Option<HashSet<String>>,
    ) -> Result<Option<SyncError>, SyncError> {
        let Some(id) = op.target.strip_prefix("fragment:") else {
            self.fail(op, "服务器上已经没有这条。", outcome);
            return Ok(None);
        };
        match self.in_lockbox(id, lockbox_ids) {
            Ok(true) => {
                self.sealed(op, outcome);
                Ok(None)
            }
            Ok(false) => self.conflict(op, "deleted", outcome).map(|_| None),
            Err(error) => Ok(Some(error)),
        }
    }

    /// 这个 id 现在是不是密匣条目：每轮至多取一次快照（只有密文与 id），顺带更新离线用的缓存。
    fn in_lockbox(&self, id: &str, cache: &mut Option<HashSet<String>>) -> Result<bool, SyncError> {
        if cache.is_none() {
            let snapshot = self.client.read("lockbox_snapshot", json!({}))?;
            if snapshot.get("itemsWithheld").and_then(Value::as_bool) == Some(true) {
                return Err(SyncError::Store("服务器没有给出密匣条目，无法判断这条是否已移入密匣。".to_string()));
            }
            self.observe("lockbox_snapshot", &snapshot);
            let found = snapshot
                .get("items")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).map(str::to_string).collect())
                .unwrap_or_default();
            *cache = Some(found);
        }
        Ok(cache.as_ref().is_some_and(|ids| ids.contains(id)))
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

    /// 移进了密匣：不发任何公开写，标失败，本地内容另存本机。
    fn sealed(&self, op: &OutboxRow, outcome: &mut PushOutcome) {
        let message = match self.save_local_copy(op) {
            Some(path) => format!("{SEALED_PREFIX}，离线时的修改没有上传，已另存在本机：{}", path.display()),
            None => format!("{SEALED_PREFIX}，离线时的修改没有上传，内容仍保存在本机的待上传记录里。"),
        };
        self.settle_failed(op, &message, outcome);
    }

    /// 标失败（不再重试），本地内容另存本机。调用方不能持着本机层的锁。
    fn fail(&self, op: &OutboxRow, reason: &str, outcome: &mut PushOutcome) {
        let message = match self.save_local_copy(op) {
            Some(path) => format!("{reason}内容已另存在本机：{}", path.display()),
            None => reason.to_string(),
        };
        self.settle_failed(op, &message, outcome);
    }

    fn settle_failed(&self, op: &OutboxRow, message: &str, outcome: &mut PushOutcome) {
        let conn = self.lock_db();
        let _ = db::set_state(&conn, op.op_seq, "failed", Some(message));
        let _ = db::settle_target(&conn, &op.target, "failed", message);
        drop(conn);
        outcome.failed += 1;
        self.emit(SyncEvent::Failed { command: op.command.clone(), target: op.target.clone(), message: message.to_string() });
    }

    /// 把这条操作在本机看到的内容（overlay 优先）另存到 `recovered_dir/unsent-<id>-<时间>.<扩展名>`。
    /// 没配置目录或本机已找不到内容时返回 `None`（内容仍在 outbox 的参数里）。
    fn save_local_copy(&self, op: &OutboxRow) -> Option<PathBuf> {
        let dir = self.options.recovered_dir.as_ref()?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S");
        let (stem, extension, bytes) = if let Some(id) = op.target.strip_prefix("fragment:") {
            let bytes = self.local_fragment_bytes(id).or_else(|| {
                op.args.get("content").and_then(Value::as_str).map(|content| content.as_bytes().to_vec())
            })?;
            (file_stem(id), "md".to_string(), bytes)
        } else if let Some(sha) = op.target.strip_prefix("asset:") {
            let (bytes, _) = db::pending_blob(&self.lock_db(), sha).ok().flatten()?;
            let extension = shard_core::image::sniff_image_mime_type(&bytes)
                .and_then(shard_core::image::image_extension_for_mime_type)
                .unwrap_or("bin")
                .to_string();
            (file_stem(sha), extension, bytes)
        } else {
            return None;
        };
        fs::create_dir_all(dir).ok()?;
        let mut path = dir.join(format!("unsent-{stem}-{stamp}.{extension}"));
        let mut suffix = 2;
        while path.exists() {
            path = dir.join(format!("unsent-{stem}-{stamp}-{suffix}.{extension}"));
            suffix += 1;
        }
        fs::write(&path, bytes).ok()?;
        Some(path)
    }

    /// 本机看到的这条碎片的原文（overlay 优先）。
    fn local_fragment_bytes(&self, id: &str) -> Option<Vec<u8>> {
        let _local = self.local.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut reader = self.reader.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let tx = reader.transaction().ok()?;
        let bytes = self
            .replica
            .read(|base| {
                let vfs = OverlayVfs::new(base, &tx, false);
                let path = shard_vault::find_fragment_path(&vfs, id).ok()??;
                shard_core::Vfs::read(&vfs, &path).ok()
            })
            .ok()
            .flatten();
        drop(tx);
        bytes
    }

    /// 另存冲突副本：用本机当前看到的版本（overlay 优先）新建一条 `conflictOf` 指向原条目的碎片，
    /// 这个目标上没补交完的操作全部标为 conflicted。副本 id 与 op_id 都由原操作确定性派生，重试不重复。
    pub(crate) fn conflict(&self, op: &OutboxRow, reason: &str, outcome: &mut PushOutcome) -> Result<(), SyncError> {
        let Some(id) = op.target.strip_prefix("fragment:").map(str::to_string) else {
            self.fail(op, reason_text(reason), outcome);
            return Ok(());
        };
        let copy_op_id = ids::conflict_op_id(&op.op_id);
        // Ok(副本) 或 Err(建副本失败的原因)：失败时要先放掉本机层的锁再标失败（标失败会读本机内容另存）。
        let copied: Result<Option<(String, Option<VaultChange>)>, String> = {
            let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut conn = self.lock_db();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut copy = Ok(None);
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
                    copy = match self.apply_local(&tx, &prepared, false) {
                        Ok((value, _)) => {
                            let change = value.get("path").and_then(Value::as_str).map(|path| VaultChange {
                                path: path.to_string(),
                                exists: true,
                                sha: value.get("fileSha").and_then(Value::as_str).map(str::to_string),
                            });
                            Ok(Some((copy_id, change)))
                        }
                        Err(error) => Err(error.message),
                    };
                }
            }
            if copy.is_ok() {
                db::settle_target(&tx, &op.target, "conflicted", reason_text(reason))?;
                // 服务器已确认、但写进了回收站里的那份：这条也算冲突（计数与提示），后面基于它的修改同样另存。
                tx.execute(
                    "UPDATE outbox SET state = 'conflicted', last_error = ?2 WHERE op_seq = ?1 AND state = 'acked'",
                    rusqlite::params![op.op_seq, reason_text(reason)],
                )?;
                tx.commit()?;
            }
            copy
        };
        let copy = match copied {
            Ok(copy) => copy,
            Err(message) => {
                // 副本建不出来（本不该发生）：原操作标失败，本地内容另存本机。
                self.fail(op, &format!("另存冲突副本失败：{message}。"), outcome);
                return Ok(());
            }
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn error(status: Option<u16>, code: &str, message: &str) -> RemoteError {
        RemoteError {
            server: String::new(),
            command: "update_fragment".to_string(),
            status,
            code: code.to_string(),
            message: message.to_string(),
            detail: None,
        }
    }

    #[test]
    fn rejections_are_read_from_the_status_first() {
        assert_eq!(classify_rejection(&error(Some(409), "STALE_BASE", "STALE_BASE: x")), Rejection::Conflict("stale"));
        assert_eq!(classify_rejection(&error(Some(409), "FRAGMENT_EXISTS", "x")), Rejection::Conflict("exists"));
        assert_eq!(classify_rejection(&error(Some(409), "LOCKBOX_UNAVAILABLE", "x")), Rejection::Sealed);
        // 现在的服务器：领域的「找不到…」是 404。
        assert_eq!(classify_rejection(&error(Some(404), "COMMAND_FAILED", "找不到片段 x")), Rejection::Deleted);
        assert_eq!(classify_rejection(&error(Some(404), "COMMAND_FAILED", "任何说明")), Rejection::Deleted);
        // 旧服务器回 400：按文字兜底；别的 400 是普通失败。
        assert_eq!(classify_rejection(&error(Some(400), "COMMAND_FAILED", "找不到片段 x")), Rejection::Deleted);
        assert_eq!(classify_rejection(&error(Some(400), "COMMAND_FAILED", "片段内容不能为空")), Rejection::Failed);
        assert_eq!(classify_rejection(&error(Some(422), "IDEMPOTENCY_KEY_REUSED", "x")), Rejection::Failed);
    }

    #[test]
    fn saved_copies_get_safe_file_names() {
        assert_eq!(file_stem("20261026-073012-a1b2c3d4-0a0b0c"), "20261026-073012-a1b2c3d4-0a0b0c");
        assert_eq!(file_stem("../a b/c"), "___a_b_c");
    }
}
