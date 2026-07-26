//! 客户端同步引擎：把本地改动推上去，把别处的改动拉下来。
//!
//! # 先拉后推
//!
//! 拉完再推，`base_revision` 是最新的，能把冲突压缩到只剩「两端真的同时改了
//! 同一条」这一种。反过来先推的话，每一条在别处改过的笔记都会白撞一次冲突。
//!
//! # 冲突从不覆盖
//!
//! 无论哪个方向发现冲突，本地那一版都会被**另存为冲突副本**（新 id，
//! `conflict_of` 指向原件），然后接受对方的版本。用户可能会看到两条内容相近的
//! 笔记，但绝不会有哪一次编辑凭空消失。
//!
//! # 离线是常态
//!
//! 没配服务器、连不上、超时——全都不是错误状态，只是"这次没同步成"。本地读写
//! 完全不受影响，`synced_revision` 会留在原地，下次自动重试。

use libsql::{params, Connection};
use serde::Serialize;
use shard_core::sync::{
    AttachmentPayload, Change, ChangesResponse, CipherEnvelope, FragmentPayload, MapPayload,
    PushItem, PushOutcome, PushRequest, PushResponse, PushResult, ServerVersion, PROTOCOL_VERSION,
};

use super::model::to_millis;
use super::repo;

/// 一次同步的结果，回给前端展示。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    pub pulled: usize,
    pub pushed: usize,
    /// 因冲突而另存的副本数量。非零时前端应当提示用户去看一眼。
    pub conflicts: usize,
    /// 服务端拒收的条目，通常意味着数据本身有问题。
    pub rejected: Vec<String>,
    pub uploaded_attachments: usize,
    pub duration_ms: u64,
}

/// 服务端连接参数。缺任何一项都表示"没配同步"。
#[derive(Debug, Clone)]
pub(crate) struct ServerConfig {
    pub base_url: String,
    pub token: String,
}

impl ServerConfig {
    pub(crate) fn from_parts(url: Option<String>, token: Option<String>) -> Option<Self> {
        let base_url = url?.trim().trim_end_matches('/').to_string();
        let token = token?.trim().to_string();
        if base_url.is_empty() || token.is_empty() {
            return None;
        }
        Some(Self { base_url, token })
    }
}

/// 单次拉取的批量大小。
const PULL_LIMIT: i64 = 200;
/// 单次推送的批量大小。太大会让一次失败重传的代价过高。
const PUSH_BATCH: usize = 100;

pub(crate) struct Client {
    http: reqwest::Client,
    config: ServerConfig,
}

impl Client {
    pub(crate) fn new(config: ServerConfig) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;
        Ok(Self { http, config })
    }

    async fn changes(&self, since: i64) -> Result<ChangesResponse, String> {
        let url = format!(
            "{}/v1/sync/changes?since={since}&limit={PULL_LIMIT}",
            self.config.base_url
        );
        let response = self
            .http
            .get(&url)
            .bearer_auth(&self.config.token)
            .send()
            .await
            .map_err(|error| format!("拉取失败：{error}"))?;

        Self::json(response).await
    }

    async fn push(&self, request: &PushRequest) -> Result<PushResponse, String> {
        let url = format!("{}/v1/sync/push", self.config.base_url);
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.config.token)
            .json(request)
            .send()
            .await
            .map_err(|error| format!("推送失败：{error}"))?;

        Self::json(response).await
    }

    /// 附件是否已在服务端。上传前先问一句，省掉重复传输。
    async fn has_attachment(&self, hash: &str) -> Result<bool, String> {
        let url = format!("{}/v1/attachments/{hash}", self.config.base_url);
        let response = self
            .http
            .head(&url)
            .bearer_auth(&self.config.token)
            .send()
            .await
            .map_err(|error| format!("探测附件失败：{error}"))?;
        Ok(response.status().is_success())
    }

    async fn upload_attachment(&self, hash: &str, bytes: Vec<u8>) -> Result<(), String> {
        let url = format!("{}/v1/attachments/{hash}", self.config.base_url);
        let response = self
            .http
            .put(&url)
            .bearer_auth(&self.config.token)
            .body(bytes)
            .send()
            .await
            .map_err(|error| format!("上传附件失败：{error}"))?;

        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("上传附件失败：HTTP {}", response.status()))
        }
    }

    pub(crate) async fn download_attachment(&self, hash: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/v1/attachments/{hash}", self.config.base_url);
        let response = self
            .http
            .get(&url)
            .bearer_auth(&self.config.token)
            .send()
            .await
            .map_err(|error| format!("下载附件失败：{error}"))?;

        if !response.status().is_success() {
            return Err(format!("下载附件失败：HTTP {}", response.status()));
        }

        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("读取附件失败：{error}"))
    }

    async fn json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
        let status = response.status();
        if !status.is_success() {
            // 401 单独说明：这几乎总是令牌配错，而不是网络问题。
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err("服务器拒绝了访问令牌，请检查同步设置。".to_string());
            }
            let body = response.text().await.unwrap_or_default();
            return Err(format!("服务器返回 HTTP {status}：{body}"));
        }

        response
            .json()
            .await
            .map_err(|error| format!("解析服务器响应失败：{error}"))
    }
}

/// 跑一轮完整同步。
pub(crate) async fn run(
    conn: &Connection,
    vault: &std::path::Path,
    client: &Client,
    device_id: &str,
) -> Result<SyncReport, String> {
    let started = std::time::Instant::now();
    let mut report = SyncReport::default();

    pull(conn, client, &mut report).await?;
    push_attachments(conn, vault, client, &mut report).await?;
    push_changes(conn, client, device_id, &mut report).await?;

    set_sync_state(conn, None).await?;
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 拉取并应用远端改动，直到追平。
async fn pull(
    conn: &Connection,
    client: &Client,
    report: &mut SyncReport,
) -> Result<(), String> {
    loop {
        let cursor = last_pulled_seq(conn).await?;
        let response = client.changes(cursor).await?;

        if response.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "协议版本不匹配：服务端 {}，客户端 {PROTOCOL_VERSION}。请升级其中一端。",
                response.protocol_version
            ));
        }
        if response.changes.is_empty() {
            return Ok(());
        }

        for change in &response.changes {
            apply_change(conn, change, report).await?;
        }
        report.pulled += response.changes.len();

        // 游标在每批应用完之后才推进。中途失败时下次会重拉这一批——
        // 应用是幂等的（按 revision 判断），重复不会有副作用，而漏掉会。
        set_last_pulled_seq(conn, response.next_seq).await?;

        if !response.has_more {
            return Ok(());
        }
    }
}

async fn apply_change(
    conn: &Connection,
    change: &Change,
    report: &mut SyncReport,
) -> Result<(), String> {
    match change {
        Change::Fragment { payload, .. } => apply_fragment(conn, payload, report).await,
        Change::Map { payload, .. } => apply_map(conn, payload, report).await,
        Change::Attachment { payload, .. } => apply_attachment(conn, payload).await,
    }
}

async fn apply_fragment(
    conn: &Connection,
    remote: &FragmentPayload,
    report: &mut SyncReport,
) -> Result<(), String> {
    let local = load_local_fragment(conn, &remote.id).await?;

    if let Some(local) = &local {
        // 本地有未推送的改动，而远端也变了：这才是真冲突。
        let dirty = local.synced_revision != Some(local.revision);
        if dirty && local.content_hash != remote.content_hash {
            save_conflict_copy(conn, local).await?;
            report.conflicts += 1;
        }
    }

    write_remote_fragment(conn, remote).await
}

/// 把远端版本写进本地库，并标记为"已与服务端一致"。
async fn write_remote_fragment(conn: &Connection, remote: &FragmentPayload) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;
    let cipher = remote.cipher.as_ref();

    tx.execute(
        UPSERT_REMOTE_FRAGMENT_SQL,
        params![
            remote.id.clone(),
            remote.content.clone(),
            remote.content_hash.clone(),
            remote.created_at.clone(),
            remote.updated_at.clone(),
            remote.updated_at_ms,
            remote.archived_at.clone(),
            remote.deleted_at.clone(),
            i64::from(remote.pinned),
            i64::from(remote.lockbox),
            remote.category.clone(),
            remote.ai_status.clone(),
            remote.source.clone(),
            remote.conflict_of.clone(),
            cipher.map(|c| c.version),
            cipher.map(|c| c.nonce.clone()),
            cipher.map(|c| c.text.clone()),
            cipher.and_then(|c| c.key_alg.clone()),
            cipher.and_then(|c| c.key_text.clone()),
            cipher.and_then(|c| c.key_id.clone()),
            remote.updated_by_device.clone(),
            remote.revision,
        ],
    )
    .await
    .map_err(|error| format!("应用远端片段失败：{error}"))?;

    tx.execute(
        "DELETE FROM fragment_tags WHERE fragment_id = ?1",
        params![remote.id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;
    for tag in &remote.tags {
        tx.execute(
            "INSERT OR IGNORE INTO fragment_tags (fragment_id, tag) VALUES (?1, ?2)",
            params![remote.id.clone(), tag.clone()],
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    // 删除的条目要退出索引；否则搜得到一条打不开的笔记。
    if remote.deleted_at.is_some() {
        super::search::remove_fragment(&tx, &remote.id).await?;
    } else {
        super::search::index_fragment(&tx, &remote.id, remote.content.as_deref(), &remote.tags)
            .await?;
    }

    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

/// 远端版本整行覆盖，并把 `synced_revision` 对齐到远端 revision——
/// 刚拿下来的这一版当然是已同步的，不该在下一轮又被当成本地改动推回去。
const UPSERT_REMOTE_FRAGMENT_SQL: &str = "
INSERT INTO fragments (
    id, content, content_hash, created_at, updated_at, updated_at_ms,
    archived_at, deleted_at, pinned, lockbox, category, ai_status, source, conflict_of,
    cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
    updated_by_device, revision, synced_revision, export_dirty
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6,
    ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
    ?15, ?16, ?17, ?18, ?19, ?20,
    ?21, ?22, ?22, 1
)
ON CONFLICT(id) DO UPDATE SET
    content = excluded.content,
    content_hash = excluded.content_hash,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    updated_at_ms = excluded.updated_at_ms,
    archived_at = excluded.archived_at,
    deleted_at = excluded.deleted_at,
    pinned = excluded.pinned,
    lockbox = excluded.lockbox,
    category = excluded.category,
    ai_status = excluded.ai_status,
    source = excluded.source,
    conflict_of = excluded.conflict_of,
    cipher_version = excluded.cipher_version,
    cipher_nonce = excluded.cipher_nonce,
    cipher_text = excluded.cipher_text,
    cipher_key_alg = excluded.cipher_key_alg,
    cipher_key_text = excluded.cipher_key_text,
    cipher_key_id = excluded.cipher_key_id,
    updated_by_device = excluded.updated_by_device,
    revision = excluded.revision,
    synced_revision = excluded.revision,
    export_dirty = 1
";

async fn apply_map(
    conn: &Connection,
    remote: &MapPayload,
    report: &mut SyncReport,
) -> Result<(), String> {
    if let Some(local) = super::maps::get(conn, &remote.id).await? {
        let dirty = local.synced_revision != Some(local.revision);
        if dirty && local.doc_hash != remote.doc_hash {
            // 导图的冲突副本沿用既有语义：另存一份给人比对。
            super::maps::insert_conflict_copy(conn, &local).await?;
            report.conflicts += 1;
        }
    }

    conn.execute(
        "INSERT INTO shard_maps (
            id, title, doc_json, doc_hash, revision, node_count,
            created_at, updated_at, updated_at_ms, deleted_at, synced_revision, export_dirty
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?5, 1)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            doc_json = excluded.doc_json,
            doc_hash = excluded.doc_hash,
            revision = excluded.revision,
            node_count = excluded.node_count,
            updated_at = excluded.updated_at,
            updated_at_ms = excluded.updated_at_ms,
            deleted_at = excluded.deleted_at,
            synced_revision = excluded.revision,
            export_dirty = 1",
        params![
            remote.id.clone(),
            remote.title.clone(),
            remote.doc_json.clone(),
            remote.doc_hash.clone(),
            remote.revision,
            remote.node_count,
            remote.created_at.clone(),
            remote.updated_at.clone(),
            remote.updated_at_ms,
            remote.deleted_at.clone(),
        ],
    )
    .await
    .map_err(|error| format!("应用远端导图失败：{error}"))?;
    Ok(())
}

async fn apply_attachment(conn: &Connection, remote: &AttachmentPayload) -> Result<(), String> {
    conn.execute(
        "INSERT INTO attachments (hash, mime_type, byte_size, created_at, deleted_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(hash) DO UPDATE SET
            deleted_at = excluded.deleted_at,
            synced_at = excluded.synced_at",
        params![
            remote.hash.clone(),
            remote.mime_type.clone(),
            remote.byte_size,
            remote.created_at.clone(),
            remote.deleted_at.clone(),
            chrono::Local::now().to_rfc3339(),
        ],
    )
    .await
    .map_err(|error| format!("应用远端附件失败：{error}"))?;
    Ok(())
}

/// 把本地那一版另存为冲突副本。
///
/// 副本是一条**新笔记**（新 id，`conflict_of` 指向原件），因此不会参与后续的
/// CAS——它就是一份留给人看的快照。
async fn save_conflict_copy(conn: &Connection, local: &LocalFragment) -> Result<(), String> {
    let copy_id = format!("{}-conflict-{}", local.id, chrono::Local::now().timestamp());
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO fragments (
            id, content, content_hash, created_at, updated_at, updated_at_ms,
            archived_at, pinned, lockbox, category, ai_status, source,
            cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
            conflict_of, revision, synced_revision, export_dirty
         )
         SELECT ?1, content, content_hash, created_at, ?2, ?3,
                archived_at, pinned, lockbox, category, ai_status, source,
                cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
                id, 1, NULL, 1
           FROM fragments WHERE id = ?4",
        params![copy_id.clone(), now.clone(), to_millis(&now), local.id.clone()],
    )
    .await
    .map_err(|error| format!("另存冲突副本失败：{error}"))?;

    // 标签也要跟着复制，否则副本会从收件箱里消失、更难被发现。
    conn.execute(
        "INSERT OR IGNORE INTO fragment_tags (fragment_id, tag)
         SELECT ?1, tag FROM fragment_tags WHERE fragment_id = ?2",
        params![copy_id.clone(), local.id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;

    let tags = repo::fetch_tags(conn, &copy_id).await?;
    let content = load_content(conn, &copy_id).await?;
    super::search::index_fragment(conn, &copy_id, content.as_deref(), &tags).await?;
    Ok(())
}

/// 推送本地改动。分批发送，逐条处理结果。
async fn push_changes(
    conn: &Connection,
    client: &Client,
    device_id: &str,
    report: &mut SyncReport,
) -> Result<(), String> {
    let pending = pending_fragments(conn).await?;
    let pending_maps = pending_maps(conn).await?;

    let mut items: Vec<PushItem> = Vec::new();
    for (payload, base_revision) in pending {
        items.push(PushItem::Fragment {
            base_revision,
            payload: Box::new(payload),
        });
    }
    for (payload, base_revision) in pending_maps {
        items.push(PushItem::Map {
            base_revision,
            payload: Box::new(payload),
        });
    }

    for batch in items.chunks(PUSH_BATCH) {
        let request = PushRequest {
            protocol_version: PROTOCOL_VERSION,
            device_id: device_id.to_string(),
            items: batch.to_vec(),
        };
        let response = client.push(&request).await?;

        for result in &response.results {
            handle_push_result(conn, result, report).await?;
        }
    }

    Ok(())
}

async fn handle_push_result(
    conn: &Connection,
    result: &PushResult,
    report: &mut SyncReport,
) -> Result<(), String> {
    match &result.outcome {
        PushOutcome::Applied { revision, seq } => {
            let table = match result.kind {
                shard_core::sync::EntityKind::Fragment => "fragments",
                shard_core::sync::EntityKind::Map => "shard_maps",
                shard_core::sync::EntityKind::Attachment => return Ok(()),
            };
            // 服务端接受的是我们推上去的那一版；把本地的同步水位对齐到它。
            conn.execute(
                &format!(
                    "UPDATE {table} SET synced_revision = revision, seq = ?2 WHERE id = ?1"
                ),
                params![result.id.clone(), *seq],
            )
            .await
            .map_err(|error| error.to_string())?;
            let _ = revision;
            report.pushed += 1;
        }
        PushOutcome::Conflict { current } => {
            // 服务端在我们推送期间又变了。本地那份另存副本，然后接受服务端版本。
            match current.as_ref() {
                ServerVersion::Fragment(remote) => {
                    if let Some(local) = load_local_fragment(conn, &remote.id).await? {
                        save_conflict_copy(conn, &local).await?;
                    }
                    write_remote_fragment(conn, remote).await?;
                }
                ServerVersion::Map(remote) => {
                    apply_map(conn, remote, report).await?;
                }
            }
            report.conflicts += 1;
        }
        PushOutcome::Rejected { reason } => {
            report
                .rejected
                .push(format!("{}：{reason}", result.id));
        }
    }
    Ok(())
}

/// 上传本地有、服务端还没有的附件字节。
///
/// 元数据随普通推送走，字节走独立端点。先 HEAD 探测：内容寻址让去重变成一次
/// 状态码判断，不必把几 MB 的图片白传一遍。
async fn push_attachments(
    conn: &Connection,
    vault: &std::path::Path,
    client: &Client,
    report: &mut SyncReport,
) -> Result<(), String> {
    let mut rows = conn
        .query(
            "SELECT hash, mime_type, byte_size, created_at, deleted_at
               FROM attachments WHERE synced_at IS NULL",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut pending = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        pending.push(AttachmentPayload {
            hash: row.get(0).map_err(|e| e.to_string())?,
            mime_type: row.get(1).map_err(|e| e.to_string())?,
            byte_size: row.get(2).map_err(|e| e.to_string())?,
            created_at: row.get(3).map_err(|e| e.to_string())?,
            deleted_at: row.get(4).map_err(|e| e.to_string())?,
        });
    }

    for payload in pending {
        let path = vault.join(super::attachments::cache_rel_path(&payload.hash));
        if !path.exists() {
            // 这台设备只有元数据、没有字节（从别处同步下来的图还没下载）。
            continue;
        }

        if !client.has_attachment(&payload.hash).await? {
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            client.upload_attachment(&payload.hash, bytes).await?;
            report.uploaded_attachments += 1;
        }

        conn.execute(
            "UPDATE attachments SET synced_at = ?2 WHERE hash = ?1",
            params![payload.hash.clone(), chrono::Local::now().to_rfc3339()],
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// 本地待推送的片段。`base_revision` 为 `None` 表示服务端还没见过它。
async fn pending_fragments(
    conn: &Connection,
) -> Result<Vec<(FragmentPayload, Option<i64>)>, String> {
    let mut rows = conn
        .query(
            "SELECT id, content, content_hash, created_at, updated_at, updated_at_ms,
                    archived_at, deleted_at, pinned, lockbox, category, ai_status, source,
                    revision, updated_by_device, conflict_of, synced_revision,
                    cipher_version, cipher_nonce, cipher_text,
                    cipher_key_alg, cipher_key_text, cipher_key_id
               FROM fragments
              WHERE synced_revision IS NULL OR synced_revision <> revision
              ORDER BY updated_at_ms ASC",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let cipher_text: Option<String> = row.get(19).map_err(|e| e.to_string())?;
        let cipher = match cipher_text {
            Some(text) => Some(CipherEnvelope {
                version: row.get::<Option<i64>>(17).map_err(|e| e.to_string())?.unwrap_or(1),
                nonce: row
                    .get::<Option<String>>(18)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
                text,
                key_alg: row.get(20).map_err(|e| e.to_string())?,
                key_text: row.get(21).map_err(|e| e.to_string())?,
                key_id: row.get(22).map_err(|e| e.to_string())?,
            }),
            None => None,
        };

        let synced_revision: Option<i64> = row.get(16).map_err(|e| e.to_string())?;
        let payload = FragmentPayload {
            id: id.clone(),
            content: row.get(1).map_err(|e| e.to_string())?,
            content_hash: row.get(2).map_err(|e| e.to_string())?,
            created_at: row.get(3).map_err(|e| e.to_string())?,
            updated_at: row.get(4).map_err(|e| e.to_string())?,
            updated_at_ms: row.get(5).map_err(|e| e.to_string())?,
            archived_at: row.get(6).map_err(|e| e.to_string())?,
            deleted_at: row.get(7).map_err(|e| e.to_string())?,
            pinned: row.get::<i64>(8).map_err(|e| e.to_string())? != 0,
            lockbox: row.get::<i64>(9).map_err(|e| e.to_string())? != 0,
            category: row.get(10).map_err(|e| e.to_string())?,
            ai_status: row.get(11).map_err(|e| e.to_string())?,
            source: row.get(12).map_err(|e| e.to_string())?,
            tags: repo::fetch_tags(conn, &id).await?,
            revision: row.get(13).map_err(|e| e.to_string())?,
            updated_by_device: row.get(14).map_err(|e| e.to_string())?,
            conflict_of: row.get(15).map_err(|e| e.to_string())?,
            cipher,
            attachment_hashes: super::attachments::hashes_for(conn, &id).await?,
        };

        out.push((payload, synced_revision));
    }
    Ok(out)
}

async fn pending_maps(conn: &Connection) -> Result<Vec<(MapPayload, Option<i64>)>, String> {
    let mut rows = conn
        .query(
            "SELECT id, title, doc_json, doc_hash, revision, node_count,
                    created_at, updated_at, updated_at_ms, deleted_at, synced_revision
               FROM shard_maps
              WHERE synced_revision IS NULL OR synced_revision <> revision
              ORDER BY updated_at_ms ASC",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let payload = MapPayload {
            id: row.get(0).map_err(|e| e.to_string())?,
            title: row.get(1).map_err(|e| e.to_string())?,
            doc_json: row.get(2).map_err(|e| e.to_string())?,
            doc_hash: row.get(3).map_err(|e| e.to_string())?,
            revision: row.get(4).map_err(|e| e.to_string())?,
            node_count: row.get(5).map_err(|e| e.to_string())?,
            created_at: row.get(6).map_err(|e| e.to_string())?,
            updated_at: row.get(7).map_err(|e| e.to_string())?,
            updated_at_ms: row.get(8).map_err(|e| e.to_string())?,
            deleted_at: row.get(9).map_err(|e| e.to_string())?,
        };
        let synced_revision: Option<i64> = row.get(10).map_err(|e| e.to_string())?;
        out.push((payload, synced_revision));
    }
    Ok(out)
}

/// 本地行里同步逻辑关心的那几个字段。
struct LocalFragment {
    id: String,
    revision: i64,
    synced_revision: Option<i64>,
    content_hash: String,
}

async fn load_local_fragment(
    conn: &Connection,
    id: &str,
) -> Result<Option<LocalFragment>, String> {
    let mut rows = conn
        .query(
            "SELECT id, revision, synced_revision, content_hash FROM fragments WHERE id = ?1",
            params![id],
        )
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(LocalFragment {
            id: row.get(0).map_err(|e| e.to_string())?,
            revision: row.get(1).map_err(|e| e.to_string())?,
            synced_revision: row.get(2).map_err(|e| e.to_string())?,
            content_hash: row.get(3).map_err(|e| e.to_string())?,
        })),
        None => Ok(None),
    }
}

async fn load_content(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let mut rows = conn
        .query("SELECT content FROM fragments WHERE id = ?1", params![id])
        .await
        .map_err(|error| error.to_string())?;
    match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => row.get(0).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

pub(crate) async fn last_pulled_seq(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query("SELECT last_pulled_seq FROM sync_state WHERE id = 1", ())
        .await
        .map_err(|error| error.to_string())?;
    match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => row.get(0).map_err(|e| e.to_string()),
        None => Ok(0),
    }
}

async fn set_last_pulled_seq(conn: &Connection, seq: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_state SET last_pulled_seq = ?1 WHERE id = 1",
        params![seq],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) async fn set_sync_state(
    conn: &Connection,
    error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_state SET last_synced_at = ?1, last_error = ?2 WHERE id = 1",
        params![chrono::Local::now().to_rfc3339(), error],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 前端展示用的同步状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub configured: bool,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    /// 还有多少条本地改动没推上去。
    pub pending: i64,
    pub last_pulled_seq: i64,
}

/// 应用一条远端片段。测试从这里进——网络层不参与，只验证合并语义。
#[cfg(test)]
pub(crate) async fn apply_remote_fragment_for_test(
    conn: &Connection,
    remote: &FragmentPayload,
    report: &mut SyncReport,
) -> Result<(), String> {
    apply_fragment(conn, remote, report).await
}

pub(crate) async fn status(conn: &Connection, configured: bool) -> Result<SyncStatus, String> {
    let mut rows = conn
        .query(
            "SELECT last_synced_at, last_error, last_pulled_seq FROM sync_state WHERE id = 1",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let (last_synced_at, last_error, last_pulled_seq) =
        match rows.next().await.map_err(|e| e.to_string())? {
            Some(row) => (
                row.get(0).map_err(|e| e.to_string())?,
                row.get(1).map_err(|e| e.to_string())?,
                row.get(2).map_err(|e| e.to_string())?,
            ),
            None => (None, None, 0),
        };

    let mut rows = conn
        .query(
            "SELECT
                (SELECT count(*) FROM fragments
                  WHERE synced_revision IS NULL OR synced_revision <> revision)
              + (SELECT count(*) FROM shard_maps
                  WHERE synced_revision IS NULL OR synced_revision <> revision)",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
    let pending: i64 = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "统计待同步数量失败".to_string())?
        .get(0)
        .map_err(|e| e.to_string())?;

    Ok(SyncStatus {
        configured,
        last_synced_at,
        last_error,
        pending,
        last_pulled_seq,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::model::NoteWrite;

    async fn open_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, crate::notes::schema::MIGRATIONS)
            .await
            .unwrap();
        conn
    }

    fn local_note(id: &str, content: &str) -> NoteWrite {
        NoteWrite {
            id: id.into(),
            content: Some(content.into()),
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-26T10:00:00+08:00".into(),
            tags: vec!["x".into()],
            category: None,
            ai_status: "none".into(),
            source: "desktop".into(),
            archived: false,
            pinned: false,
            cipher: None,
            export_path: None,
        }
    }

    fn remote_note(id: &str, content: &str, revision: i64) -> FragmentPayload {
        FragmentPayload {
            id: id.into(),
            content: Some(content.into()),
            content_hash: shard_core::hash_text(content),
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-27T10:00:00+08:00".into(),
            updated_at_ms: 1_784_100_000_000,
            archived_at: None,
            deleted_at: None,
            pinned: false,
            lockbox: false,
            category: None,
            ai_status: "none".into(),
            source: "desktop".into(),
            tags: vec!["y".into()],
            revision,
            updated_by_device: "dev-b".into(),
            conflict_of: None,
            cipher: None,
            attachment_hashes: vec![],
        }
    }

    async fn count_fragments(conn: &Connection) -> i64 {
        let mut rows = conn
            .query("SELECT count(*) FROM fragments", ())
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    /// 本地没碰过的笔记，远端版本直接覆盖，不该产生冲突副本。
    #[tokio::test]
    async fn clean_local_row_accepts_remote_without_conflict() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "原始"), None, "dev-a")
            .await
            .unwrap();
        // 模拟这一版已经推上去过。
        conn.execute(
            "UPDATE fragments SET synced_revision = revision WHERE id = 'f1'",
            (),
        )
        .await
        .unwrap();

        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &remote_note("f1", "远端改的", 2), &mut report)
            .await
            .unwrap();

        assert_eq!(report.conflicts, 0);
        assert_eq!(count_fragments(&conn).await, 1, "不该多出副本");
        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("远端改的"));
    }

    /// 核心保证：两端都改过同一条时，本地那版另存副本，**一个字都不丢**。
    #[tokio::test]
    async fn diverged_row_keeps_the_local_version_as_a_conflict_copy() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "本地写的"), None, "dev-a")
            .await
            .unwrap();
        // synced_revision 保持 NULL：这一版还没推上去。

        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &remote_note("f1", "远端写的", 5), &mut report)
            .await
            .unwrap();

        assert_eq!(report.conflicts, 1);
        assert_eq!(count_fragments(&conn).await, 2, "本地那版应另存为副本");

        let row = repo::get(&conn, "f1").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("远端写的"));

        let mut rows = conn
            .query(
                "SELECT content, conflict_of FROM fragments WHERE conflict_of IS NOT NULL",
                (),
            )
            .await
            .unwrap();
        let copy = rows.next().await.unwrap().expect("应有一份冲突副本");
        assert_eq!(copy.get::<String>(0).unwrap(), "本地写的");
        assert_eq!(copy.get::<String>(1).unwrap(), "f1");
    }

    /// 两端改成了同样的内容不算冲突——content_hash 相同就没有分歧可言。
    #[tokio::test]
    async fn identical_content_is_not_a_conflict() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "一样的内容"), None, "dev-a")
            .await
            .unwrap();

        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &remote_note("f1", "一样的内容", 3), &mut report)
            .await
            .unwrap();

        assert_eq!(report.conflicts, 0);
        assert_eq!(count_fragments(&conn).await, 1);
    }

    /// 应用远端版本后，这一行不该再被当成"待推送"——否则会无限来回推。
    #[tokio::test]
    async fn applied_remote_rows_are_not_pending_again() {
        let conn = open_conn().await;
        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &remote_note("f1", "远端的", 7), &mut report)
            .await
            .unwrap();

        let pending = pending_fragments(&conn).await.unwrap();
        assert!(
            pending.iter().all(|(payload, _)| payload.id != "f1"),
            "刚拉下来的版本不该立刻又排队推回去"
        );
    }

    /// 本地新建的笔记从未推送过，base_revision 必须是 None。
    #[tokio::test]
    async fn locally_created_rows_push_as_creates() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "新建"), None, "dev-a")
            .await
            .unwrap();

        let pending = pending_fragments(&conn).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, None, "服务端还没见过它");
        assert_eq!(pending[0].0.tags, vec!["x".to_string()]);
    }

    /// 本地改过的已同步行，base_revision 要是**上次推上去的那一版**。
    #[tokio::test]
    async fn locally_edited_rows_push_with_their_synced_revision() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "第一版"), None, "dev-a")
            .await
            .unwrap();
        conn.execute(
            "UPDATE fragments SET synced_revision = revision WHERE id = 'f1'",
            (),
        )
        .await
        .unwrap();
        repo::write(&conn, &local_note("f1", "第二版"), Some(1), "dev-a")
            .await
            .unwrap();

        let pending = pending_fragments(&conn).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, Some(1), "CAS 基准是上次同步成功的那一版");
        assert_eq!(pending[0].0.revision, 2);
    }

    /// 远端墓碑要让本地这条退出搜索索引，不能留下一条搜得到却打不开的笔记。
    #[tokio::test]
    async fn remote_tombstone_removes_the_row_from_search() {
        let conn = open_conn().await;
        repo::write(&conn, &local_note("f1", "会议纪要"), None, "dev-a")
            .await
            .unwrap();
        conn.execute(
            "UPDATE fragments SET synced_revision = revision WHERE id = 'f1'",
            (),
        )
        .await
        .unwrap();
        assert_eq!(
            super::super::search::search(&conn, "会议", false, 20).await.unwrap().len(),
            1
        );

        let mut deleted = remote_note("f1", "会议纪要", 2);
        deleted.deleted_at = Some("2026-07-27T11:00:00+08:00".into());
        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &deleted, &mut report)
            .await
            .unwrap();

        assert!(repo::get(&conn, "f1").await.unwrap().is_none(), "墓碑行不该出现在读路径");
        assert!(
            super::super::search::search(&conn, "会议", false, 20).await.unwrap().is_empty(),
            "已删除的内容必须退出索引"
        );
    }

    /// 密匣条目同步下来时，明文列必须为空、密文完整。
    #[tokio::test]
    async fn remote_lockbox_rows_stay_encrypted() {
        let conn = open_conn().await;
        let mut remote = remote_note("secret", "", 1);
        remote.content = None;
        remote.lockbox = true;
        remote.tags = vec![];
        remote.cipher = Some(CipherEnvelope {
            version: 1,
            nonce: "N".into(),
            text: "CIPHERTEXT".into(),
            key_alg: Some("rsa-oaep-sha256".into()),
            key_text: Some("WRAPPED".into()),
            key_id: None,
        });

        let mut report = SyncReport::default();
        apply_remote_fragment_for_test(&conn, &remote, &mut report)
            .await
            .unwrap();

        let row = repo::get(&conn, "secret").await.unwrap().unwrap();
        assert!(row.lockbox);
        assert!(row.content.is_none());
        assert_eq!(row.cipher.unwrap().text, "CIPHERTEXT");

        let mut rows = conn
            .query("SELECT count(*) FROM fragments_fts", ())
            .await
            .unwrap();
        let indexed: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(indexed, 0, "密文绝不能进全文索引");
    }

    /// 同步状态要如实反映待推送数量。
    #[tokio::test]
    async fn status_counts_pending_local_changes() {
        let conn = open_conn().await;
        assert_eq!(status(&conn, false).await.unwrap().pending, 0);

        repo::write(&conn, &local_note("f1", "一"), None, "dev-a")
            .await
            .unwrap();
        repo::write(&conn, &local_note("f2", "二"), None, "dev-a")
            .await
            .unwrap();

        let state = status(&conn, true).await.unwrap();
        assert_eq!(state.pending, 2);
        assert!(state.configured);
    }

    /// 没配 URL 或没配令牌都等于没配同步。
    #[test]
    fn server_config_needs_both_parts() {
        assert!(ServerConfig::from_parts(None, Some("token".into())).is_none());
        assert!(ServerConfig::from_parts(Some("https://x".into()), None).is_none());
        assert!(ServerConfig::from_parts(Some("  ".into()), Some("t".into())).is_none());
        assert!(ServerConfig::from_parts(Some("https://x".into()), Some(" ".into())).is_none());

        let config =
            ServerConfig::from_parts(Some("https://x/".into()), Some("token".into())).unwrap();
        assert_eq!(config.base_url, "https://x", "末尾斜杠要去掉");
    }
}
