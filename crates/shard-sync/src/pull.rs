//! 拉取：`/api/sync/changes?since=` 按路径合并 → `/api/sync/fetch` 批量取内容 → 本地事务写进副本 →
//! 提交后才推进游标。epoch 变了或游标早于保留下限（410）→ `/api/sync/manifest` 全量对账。
//!
//! 全量对账时，只有 epoch 真的变了（服务器从备份恢复）才找回数据：副本里「服务器没有（或内容不同）、
//! 且服务器 seq 大于新 head」的条目是恢复点之后写下的，原文另存一份，碎片与图片排进 outbox 推回。
//! 同一 epoch 下的 410（例如移入密匣、立即抹除后服务器推进了保留下限）只按清单删改副本，不推回任何东西；
//! 副本里被删掉的条目若还有没补交的本地修改，补交时按「服务器已删除」另存冲突副本。

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    time::SystemTime,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use shard_core::{sha256_hex, Vfs};
use shard_store::{path_key::path_key, WriteCtx};

use crate::{
    db,
    engine::{SyncEngine, SyncError, SyncEvent, VaultChange},
    ids,
};

const PAGE: usize = 500;
const FETCH_BATCH: usize = 500;

/// 服务器上的一条变化（同一路径只留最后一条）。
#[derive(Clone, Debug)]
pub(crate) struct Change {
    pub seq: i64,
    pub path: String,
    pub exists: bool,
    pub sha: Option<String>,
    pub kind: String,
}

#[derive(Debug, Default)]
pub(crate) struct PullOutcome {
    pub changes: Vec<VaultChange>,
    pub reconciled: bool,
    pub recovered: usize,
}

enum Content {
    File { bytes: Vec<u8>, created: Option<String>, modified: Option<String> },
    Dir { created: Option<String>, modified: Option<String> },
    Missing,
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_time(value: &Option<String>) -> Option<SystemTime> {
    value
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(SystemTime::from)
}

fn depth(path: &str) -> usize {
    path.matches('/').count()
}

fn bad_response(path: &str, message: impl Into<String>) -> SyncError {
    SyncError::Remote(shard_remote::RemoteError {
        server: String::new(),
        command: path.to_string(),
        status: Some(200),
        code: "BAD_RESPONSE".to_string(),
        message: message.into(),
        detail: None,
    })
}

/// 同一路径只留 seq 最大的一条；抹除留下的占位路径（`[erased]/…`）跳过。
pub(crate) fn merge_changes(changes: Vec<Change>) -> Vec<Change> {
    let mut merged: BTreeMap<String, Change> = BTreeMap::new();
    for change in changes {
        if change.path.starts_with("[erased]/") {
            continue;
        }
        match merged.get(&change.path) {
            Some(existing) if existing.seq > change.seq => {}
            _ => {
                merged.insert(change.path.clone(), change);
            }
        }
    }
    merged.into_values().collect()
}

fn parse_changes(page: &Value) -> Vec<Change> {
    page.get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .map(|change| Change {
                    seq: change.get("seq").and_then(Value::as_i64).unwrap_or(0),
                    path: text(change, "path"),
                    exists: change.get("exists").and_then(Value::as_bool).unwrap_or(false),
                    sha: change.get("sha").and_then(Value::as_str).map(str::to_string),
                    kind: text(change, "kind"),
                })
                .collect()
        })
        .unwrap_or_default()
}

impl SyncEngine {
    pub(crate) fn pull(&self) -> Result<PullOutcome, SyncError> {
        let state = self.state()?;
        let mut cursor = state.cursor_seq;
        let mut epoch = state.epoch.clone();
        let mut vault_id = state.vault_id.clone();
        let mut outcome = PullOutcome::default();
        loop {
            let page = match self.client.get_json(&format!("api/sync/changes?since={cursor}&limit={PAGE}")) {
                Ok(page) => page,
                Err(error) if error.status == Some(410) => return self.reconcile(&state, None, outcome),
                Err(error) => return Err(error.into()),
            };
            let page_epoch = text(&page, "epoch");
            let page_vault = text(&page, "vaultId");
            if !epoch.is_empty() && (page_epoch != epoch || page_vault != vault_id) {
                return self.reconcile(&state, Some(page_vault), outcome);
            }
            if epoch.is_empty() {
                epoch = page_epoch;
                vault_id = page_vault;
                db_execute(
                    self,
                    "UPDATE sync_state SET epoch = ?1, vault_id = ?2 WHERE id = 1",
                    params![epoch, vault_id],
                )?;
            }
            let changes = parse_changes(&page);
            let next_cursor = changes.iter().map(|change| change.seq).max().unwrap_or(cursor).max(cursor);
            let merged = merge_changes(changes);
            let applied = self.apply_changes(&merged)?;
            {
                let mut conn = self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                for change in &merged {
                    record_confirmed(&tx, change)?;
                }
                tx.execute("UPDATE sync_state SET cursor_seq = ?1 WHERE id = 1", params![next_cursor])?;
                tx.commit()?;
            }
            cursor = next_cursor;
            outcome.changes.extend(self.effective(applied));
            if !page.get("more").and_then(Value::as_bool).unwrap_or(false) {
                break;
            }
        }
        db_execute(self, "UPDATE sync_state SET last_pull_at = ?1 WHERE id = 1", params![ids::stamp(Utc::now())])?;
        Ok(outcome)
    }

    /// 取内容（副本里同一路径已有同样 sha 的直接用本地字节）并写进副本。返回应用了的路径。
    fn apply_changes(&self, changes: &[Change]) -> Result<Vec<String>, SyncError> {
        if changes.is_empty() {
            return Ok(Vec::new());
        }
        let mut contents: HashMap<String, Content> = HashMap::new();
        let mut to_fetch: Vec<String> = Vec::new();
        let files: Vec<&Change> = changes.iter().filter(|change| change.exists && change.kind != "dir").collect();
        self.replica.read(|vfs| {
            for change in &files {
                let abs = vfs.root().join(&change.path);
                let local = vfs.content_sha(&abs).ok();
                if local.is_some() && local == change.sha {
                    if let Ok(bytes) = vfs.read(&abs) {
                        contents.insert(change.path.clone(), Content::File { bytes, created: None, modified: None });
                        continue;
                    }
                }
                to_fetch.push(change.path.clone());
            }
        })?;
        to_fetch.extend(changes.iter().filter(|change| change.exists && change.kind == "dir").map(|change| change.path.clone()));
        for batch in to_fetch.chunks(FETCH_BATCH) {
            let response = self.client.post_json("api/sync/fetch", &json!({ "paths": batch }))?;
            let items = response.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            for item in items {
                let path = text(&item, "path");
                let created = item.get("createdAt").and_then(Value::as_str).map(str::to_string);
                let modified = item.get("modifiedAt").and_then(Value::as_str).map(str::to_string);
                let content = if item.get("missing").and_then(Value::as_bool).unwrap_or(false) {
                    Content::Missing
                } else if item.get("kind").and_then(Value::as_str) == Some("dir") {
                    Content::Dir { created, modified }
                } else {
                    let sha = text(&item, "sha");
                    let bytes = if item.get("blob").and_then(Value::as_bool).unwrap_or(false) {
                        let fetched = self.client.get_bytes(&format!("api/blobs/{sha}"))?;
                        if !fetched.is_ok() {
                            return Err(bad_response(&path, format!("取不到 {path} 的内容（HTTP {}）。", fetched.status)));
                        }
                        fetched.bytes
                    } else {
                        STANDARD
                            .decode(text(&item, "data"))
                            .map_err(|error| bad_response(&path, format!("{path} 的内容无法解码：{error}")))?
                    };
                    if sha256_hex(&bytes) != sha {
                        return Err(bad_response(&path, format!("{path} 的内容与 sha 不符，稍后重试。")));
                    }
                    Content::File { bytes, created, modified }
                };
                contents.insert(path, content);
            }
        }

        let mut deletes: Vec<&Change> = changes.iter().filter(|change| !change.exists).collect();
        deletes.sort_by_key(|change| std::cmp::Reverse(depth(&change.path)));
        let mut dirs: Vec<&Change> = changes.iter().filter(|change| change.exists && change.kind == "dir").collect();
        dirs.sort_by_key(|change| depth(&change.path));
        let mut applied = Vec::new();
        let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.replica.write(&WriteCtx::new("sync_pull", "sync").for_replica(), |vfs| -> Result<(), SyncError> {
            for change in &deletes {
                let abs = vfs.root().join(&change.path);
                match vfs.metadata(&abs) {
                    Ok(metadata) if metadata.is_dir() => vfs.remove_dir_all(&abs)?,
                    Ok(_) => vfs.remove_file(&abs)?,
                    Err(_) => {}
                }
                applied.push(change.path.clone());
            }
            for change in &dirs {
                let Some(Content::Dir { created, modified }) = contents.get(&change.path) else {
                    continue;
                };
                let abs = vfs.root().join(&change.path);
                if matches!(vfs.metadata(&abs), Ok(metadata) if metadata.is_file()) {
                    vfs.remove_file(&abs)?;
                }
                vfs.create_dir_all(&abs)?;
                if let (Some(created), Some(modified)) = (parse_time(created), parse_time(modified)) {
                    vfs.set_times(&abs, created, modified)?;
                }
                applied.push(change.path.clone());
            }
            for change in &files {
                let Some(Content::File { bytes, created, modified }) = contents.get(&change.path) else {
                    continue;
                };
                let abs = vfs.root().join(&change.path);
                if matches!(vfs.metadata(&abs), Ok(metadata) if metadata.is_dir()) {
                    vfs.remove_dir_all(&abs)?;
                }
                vfs.write_atomic(&abs, bytes)?;
                if let (Some(created), Some(modified)) = (parse_time(created), parse_time(modified)) {
                    vfs.set_times(&abs, created, modified)?;
                }
                applied.push(change.path.clone());
            }
            Ok(())
        })?;
        Ok(applied)
    }

    /// 全量对账：清单 → 副本与之一致；epoch 变了（恢复备份）先找回恢复点之后写下的条目。
    fn reconcile(
        &self,
        previous: &db::SyncState,
        page_vault: Option<String>,
        mut outcome: PullOutcome,
    ) -> Result<PullOutcome, SyncError> {
        let manifest = self.client.get_json("api/sync/manifest")?;
        let epoch = text(&manifest, "epoch");
        let head = manifest.get("headSeq").and_then(Value::as_i64).unwrap_or(0);
        let vault_id = manifest
            .get("vaultId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(page_vault)
            .unwrap_or_else(|| previous.vault_id.clone());
        let entries: Vec<Change> = manifest
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| Change {
                        seq: entry.get("seq").and_then(Value::as_i64).unwrap_or(0),
                        path: text(entry, "path"),
                        exists: true,
                        sha: entry.get("sha").and_then(Value::as_str).map(str::to_string),
                        kind: text(entry, "kind"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let server: HashMap<String, &Change> = entries.iter().map(|entry| (path_key(&entry.path), entry)).collect();
        let local_entries = self.replica.manifest()?;

        // 恢复备份：同一个资料库换了 epoch。换了资料库（vault_id 不同）不是恢复，不推回任何东西。
        let restored = !previous.epoch.is_empty() && previous.epoch != epoch && previous.vault_id == vault_id;
        let (mut pushed, mut saved) = (0, 0);
        if restored {
            (pushed, saved) = self.recover(&local_entries, &server, head, &epoch)?;
        }

        let local_by_key: HashMap<String, &shard_store::ManifestEntry> =
            local_entries.iter().map(|entry| (path_key(&entry.path), entry)).collect();
        let mut changes = Vec::new();
        for entry in &local_entries {
            let gone = match server.get(&path_key(&entry.path)) {
                None => true,
                Some(remote) => remote.path != entry.path || remote.kind != entry.kind,
            };
            if gone {
                changes.push(Change { seq: 0, path: entry.path.clone(), exists: false, sha: None, kind: entry.kind.clone() });
            }
        }
        for entry in &entries {
            let same = local_by_key
                .get(&path_key(&entry.path))
                .is_some_and(|local| local.path == entry.path && local.kind == entry.kind && local.sha == entry.sha);
            if !same {
                changes.push(entry.clone());
            }
        }
        let applied = self.apply_changes(&changes)?;
        {
            let mut conn = self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute("DELETE FROM confirmed", [])?;
            for entry in &entries {
                record_confirmed(&tx, entry)?;
            }
            tx.execute(
                "UPDATE sync_state SET epoch = ?1, vault_id = ?2, cursor_seq = ?3, last_pull_at = ?4 WHERE id = 1",
                params![epoch, vault_id, head, ids::stamp(Utc::now())],
            )?;
            tx.commit()?;
        }
        outcome.changes.extend(self.effective(applied));
        outcome.reconciled = true;
        outcome.recovered = pushed;
        if pushed > 0 || saved > 0 {
            self.emit(SyncEvent::Recovered { pushed, saved, dir: self.recovery_dir(&epoch) });
        }
        Ok(outcome)
    }

    fn recovery_dir(&self, epoch: &str) -> Option<std::path::PathBuf> {
        self.options.recovered_dir.as_ref().map(|dir| dir.join(format!("restore-{epoch}")))
    }

    /// 恢复备份后找回：返回 (排进 outbox 推回的, 只另存原文的)。
    fn recover(
        &self,
        local_entries: &[shard_store::ManifestEntry],
        server: &HashMap<String, &Change>,
        head: i64,
        epoch: &str,
    ) -> Result<(usize, usize), SyncError> {
        let confirmed: HashMap<String, i64> = {
            let conn = self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut statement = conn.prepare("SELECT path_key, server_seq FROM confirmed")?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
                .collect::<Result<HashMap<_, _>, _>>()?;
            rows
        };
        // 恢复点之后写下的：服务器 seq 大于新 head，且服务器没有或内容不同。
        let candidates: Vec<(&shard_store::ManifestEntry, bool)> = local_entries
            .iter()
            .filter(|entry| entry.kind == "file")
            .filter_map(|entry| {
                let key = path_key(&entry.path);
                let seq = *confirmed.get(&key)?;
                if seq <= head {
                    return None;
                }
                match server.get(&key) {
                    None => Some((entry, true)),
                    Some(remote) if remote.sha != entry.sha => Some((entry, false)),
                    _ => None,
                }
            })
            .collect();
        if candidates.is_empty() {
            return Ok((0, 0));
        }
        type Recovered = (String, Vec<u8>, Option<SystemTime>, Option<SystemTime>, bool);
        let files: Vec<Recovered> = self.replica.read(|vfs| {
            candidates
                .iter()
                .filter_map(|(entry, missing)| {
                    let abs = vfs.root().join(&entry.path);
                    let bytes = vfs.read(&abs).ok()?;
                    let metadata = vfs.metadata(&abs).ok();
                    let created = metadata.as_ref().and_then(|metadata| metadata.created().ok());
                    let modified = metadata.as_ref().and_then(|metadata| metadata.modified().ok());
                    Some((entry.path.clone(), bytes, created, modified, *missing))
                })
                .collect()
        })?;
        // 先把原文落盘，再排补交：之后任何一步失败，数据都还在。
        if let Some(dir) = self.recovery_dir(epoch) {
            for (path, bytes, ..) in &files {
                let target = dir.join(path);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&target, bytes)?;
            }
        }
        let (mut pushed, mut saved) = (0, 0);
        let _local = self.local.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut conn = self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let utc_offset = shard_remote::utc_offset_minutes();
        let now = ids::now_at(utc_offset);
        for (path, bytes, created, modified, missing) in &files {
            let key = path_key(path);
            let op_id = format!("recover-{epoch}-{}", &sha256_hex(key.as_bytes())[..16]);
            if db::op_by_id(&tx, &op_id)?.is_some() {
                pushed += 1;
                continue;
            }
            let plan = recovery_op(path, bytes, *missing, &op_id, &now);
            let Some((command, args, target, blob)) = plan else {
                saved += 1;
                continue;
            };
            if let Some(sha) = &blob {
                db::put_pending_blob(&tx, sha, bytes, false, &ids::stamp(Utc::now()))?;
            }
            tx.execute(
                "INSERT INTO outbox (op_id, command, args_json, target, target_path, base_sha, chained, blob_deps,
                                     utc_offset, state, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, ?6, ?7, 'pending', ?8)",
                params![op_id, command, args.to_string(), target, path, blob, utc_offset, now.to_rfc3339()],
            )?;
            let op_seq = tx.last_insert_rowid();
            // 服务器上没有的：原文留在 overlay 里，补交完成前本机照样看得到。
            if *missing {
                put_overlay_file(&tx, path, bytes, created, modified, op_seq)?;
            }
            pushed += 1;
        }
        tx.commit()?;
        Ok((pushed, saved))
    }
}

/// 找回一条：(命令, 参数, 目标, blob)。不能自动推回（笔记、数据集、导图等）时返回 `None`，只留原文。
fn recovery_op(
    path: &str,
    bytes: &[u8],
    missing: bool,
    op_id: &str,
    now: &chrono::DateTime<chrono::FixedOffset>,
) -> Option<(&'static str, Value, String, Option<String>)> {
    let key = path_key(path);
    if key.starts_with("fragments/") && key.ends_with(".md") {
        let text = std::str::from_utf8(bytes).ok()?;
        let parsed = shard_core::frontmatter::parse_fragment(text).ok()?;
        let content = parsed.body.trim().to_string();
        if content.is_empty() {
            return None;
        }
        let original = parsed.frontmatter.id.clone();
        let valid = shard_core::is_valid_fragment_id(&original);
        let created = chrono::DateTime::parse_from_rfc3339(&parsed.frontmatter.created_at).ok();
        let mut args = json!({ "content": content, "tags": parsed.frontmatter.tags });
        let id = match (missing, valid, created) {
            // 服务器上没有：用原来的 id 与创建时间重建。
            (true, true, Some(created)) => {
                args["createdAt"] = json!(created.to_rfc3339());
                original.clone()
            }
            // 服务器上有更早的版本（或旧 id 形状不合规）：另存为冲突副本，不覆盖。
            _ => {
                if valid {
                    args["conflictOf"] = json!(original);
                }
                args["createdAt"] = json!(now.to_rfc3339());
                ids::conflict_fragment_id(op_id, now)
            }
        };
        args["id"] = json!(id);
        return Some(("create_fragment", args, format!("fragment:{id}"), None));
    }
    if missing && key.starts_with("assets/") && shard_core::image::sniff_image_mime_type(bytes).is_some() {
        let sha = sha256_hex(bytes);
        return Some(("save_fragment_image", json!({ "blobSha": sha }), format!("asset:{sha}"), Some(sha)));
    }
    None
}

fn put_overlay_file(
    tx: &Connection,
    path: &str,
    bytes: &[u8],
    created: &Option<SystemTime>,
    modified: &Option<SystemTime>,
    op_seq: i64,
) -> rusqlite::Result<()> {
    let now = ids::stamp(Utc::now());
    let stamp = |time: &Option<SystemTime>| {
        time.map(|time| ids::stamp(chrono::DateTime::<Utc>::from(time))).unwrap_or_else(|| now.clone())
    };
    // 祖先目录也放进 overlay：副本对账后可能没有它们了，读目录时才列得出这个文件。
    let parts: Vec<&str> = path.split('/').collect();
    for end in 1..parts.len() {
        let dir = parts[..end].join("/");
        let key = path_key(&dir);
        tx.execute(
            "INSERT INTO overlay (key, parent_key, path, kind, data, sha, size, created_at, modified_at, op_seq_max)
             VALUES (?1, ?2, ?3, 'dir', NULL, NULL, 0, ?4, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET op_seq_max = MAX(op_seq_max, excluded.op_seq_max)",
            params![key, shard_store::path_key::parent_key(&key), dir, now, op_seq],
        )?;
    }
    let key = path_key(path);
    tx.execute(
        "INSERT INTO overlay (key, parent_key, path, kind, data, sha, size, created_at, modified_at, op_seq_max)
         VALUES (?1, ?2, ?3, 'file', ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(key) DO UPDATE SET op_seq_max = MAX(op_seq_max, excluded.op_seq_max)",
        params![
            key,
            shard_store::path_key::parent_key(&key),
            path,
            bytes,
            sha256_hex(bytes),
            bytes.len() as i64,
            stamp(created),
            stamp(modified),
            op_seq
        ],
    )?;
    Ok(())
}

fn record_confirmed(tx: &Connection, change: &Change) -> rusqlite::Result<()> {
    let key = path_key(&change.path);
    if change.exists {
        tx.execute(
            "INSERT INTO confirmed (path_key, path, server_seq) VALUES (?1, ?2, ?3)
             ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, server_seq = excluded.server_seq",
            params![key, change.path, change.seq],
        )?;
    } else {
        tx.execute("DELETE FROM confirmed WHERE path_key = ?1 AND path = ?2", params![key, change.path])?;
    }
    Ok(())
}

fn db_execute(engine: &SyncEngine, sql: &str, params: impl rusqlite::Params) -> Result<(), SyncError> {
    engine.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).execute(sql, params)?;
    Ok(())
}
