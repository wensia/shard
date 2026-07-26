//! 服务端的同步读写。
//!
//! 两条路径：把 seq 之后的改动读出来（拉），把客户端的改动按 CAS 写进去（推）。
//!
//! # 冲突从不覆盖
//!
//! CAS 不匹配时服务端**原样保留**自己那一版，并把它回给客户端。客户端负责把
//! 本地那份另存为冲突副本。任何"以时间戳较新者为准"的自动合并都会在某个场景
//! 下悄悄吃掉用户写的东西，而用户永远不会知道。

use libsql::{params, Connection, Row};
use shard_core::sync::{
    AttachmentPayload, Change, CipherEnvelope, FragmentPayload, MapPayload, PushItem, PushOutcome,
    PushResult, ServerVersion,
};

use crate::db;

const FRAGMENT_COLUMNS: &str = "
    id, content, content_hash, created_at, updated_at, updated_at_ms,
    archived_at, deleted_at, pinned, lockbox, category, ai_status, source,
    revision, updated_by_device, conflict_of, seq,
    cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id
";

const MAP_COLUMNS: &str = "
    id, title, doc_json, doc_hash, revision, node_count,
    created_at, updated_at, updated_at_ms, deleted_at, seq
";

const ATTACHMENT_COLUMNS: &str = "hash, mime_type, byte_size, created_at, deleted_at, seq";

/// 读取 `seq > since` 的改动，按 seq 升序。
///
/// 三类实体共用一条序列，所以先各取一批再按 seq 归并截断——这样无论哪一类
/// 更活跃，客户端都不会因为某一类刷屏而饿死另一类。
pub async fn changes_since(
    conn: &Connection,
    since: i64,
    limit: i64,
) -> Result<Vec<Change>, String> {
    let mut changes = Vec::new();

    let sql = format!(
        "SELECT {FRAGMENT_COLUMNS} FROM fragments
          WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
    );
    let mut rows = conn
        .query(&sql, params![since, limit])
        .await
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let payload = fragment_from_row(&row)?;
        let seq = row.get::<i64>(16).map_err(|e| e.to_string())?;
        changes.push(Change::Fragment {
            seq,
            payload: Box::new(payload),
        });
    }

    let sql = format!(
        "SELECT {MAP_COLUMNS} FROM shard_maps WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
    );
    let mut rows = conn
        .query(&sql, params![since, limit])
        .await
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let seq = row.get::<i64>(10).map_err(|e| e.to_string())?;
        changes.push(Change::Map {
            seq,
            payload: Box::new(map_from_row(&row)?),
        });
    }

    let sql = format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
    );
    let mut rows = conn
        .query(&sql, params![since, limit])
        .await
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let seq = row.get::<i64>(5).map_err(|e| e.to_string())?;
        changes.push(Change::Attachment {
            seq,
            payload: attachment_from_row(&row)?,
        });
    }

    changes.sort_by_key(Change::seq);
    changes.truncate(limit as usize);

    // 标签要在归并截断之后再补，避免为被丢弃的那些行白查一遍。
    for change in &mut changes {
        if let Change::Fragment { payload, .. } = change {
            payload.tags = fetch_tags(conn, &payload.id).await?;
            payload.attachment_hashes = fetch_attachment_hashes(conn, &payload.id).await?;
        }
    }

    Ok(changes)
}

/// 逐条应用推送。**每条一个事务**：一条冲突不该连累同批其余条目。
pub async fn apply_push(
    conn: &Connection,
    device_id: &str,
    items: &[PushItem],
) -> Result<Vec<PushResult>, String> {
    let mut results = Vec::with_capacity(items.len());

    for item in items {
        let outcome = match item {
            PushItem::Fragment {
                base_revision,
                payload,
            } => apply_fragment(conn, device_id, *base_revision, payload).await?,
            PushItem::Map {
                base_revision,
                payload,
            } => apply_map(conn, device_id, *base_revision, payload).await?,
            PushItem::Attachment { payload } => apply_attachment(conn, payload).await?,
        };

        results.push(PushResult {
            kind: item.entity_kind(),
            id: item.entity_id().to_string(),
            outcome,
        });
    }

    Ok(results)
}

async fn apply_fragment(
    conn: &Connection,
    device_id: &str,
    base_revision: Option<i64>,
    payload: &FragmentPayload,
) -> Result<PushOutcome, String> {
    if payload.lockbox && payload.content.is_some() {
        // 表级 CHECK 也会拦，但在这里明确拒绝能给出有用的错误信息，
        // 而不是一句 SQLite 约束报错。
        return Ok(PushOutcome::Rejected {
            reason: "密匣条目不得携带明文".to_string(),
        });
    }

    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;
    let seq = db::next_seq(&tx).await?;
    let cipher = payload.cipher.as_ref();

    let changed = match base_revision {
        None => tx
            .execute(
                INSERT_FRAGMENT_SQL,
                params![
                    payload.id.clone(),
                    payload.content.clone(),
                    payload.content_hash.clone(),
                    payload.created_at.clone(),
                    payload.updated_at.clone(),
                    payload.updated_at_ms,
                    payload.archived_at.clone(),
                    payload.deleted_at.clone(),
                    i64::from(payload.pinned),
                    i64::from(payload.lockbox),
                    payload.category.clone(),
                    payload.ai_status.clone(),
                    payload.source.clone(),
                    payload.conflict_of.clone(),
                    cipher.map(|c| c.version),
                    cipher.map(|c| c.nonce.clone()),
                    cipher.map(|c| c.text.clone()),
                    cipher.and_then(|c| c.key_alg.clone()),
                    cipher.and_then(|c| c.key_text.clone()),
                    cipher.and_then(|c| c.key_id.clone()),
                    device_id,
                    seq,
                ],
            )
            .await
            .map_err(|error| format!("写入片段失败：{error}"))?,
        Some(revision) => tx
            .execute(
                UPDATE_FRAGMENT_SQL,
                params![
                    payload.id.clone(),
                    payload.content.clone(),
                    payload.content_hash.clone(),
                    payload.updated_at.clone(),
                    payload.updated_at_ms,
                    payload.archived_at.clone(),
                    payload.deleted_at.clone(),
                    i64::from(payload.pinned),
                    i64::from(payload.lockbox),
                    payload.category.clone(),
                    payload.ai_status.clone(),
                    payload.source.clone(),
                    payload.conflict_of.clone(),
                    cipher.map(|c| c.version),
                    cipher.map(|c| c.nonce.clone()),
                    cipher.map(|c| c.text.clone()),
                    cipher.and_then(|c| c.key_alg.clone()),
                    cipher.and_then(|c| c.key_text.clone()),
                    cipher.and_then(|c| c.key_id.clone()),
                    device_id,
                    seq,
                    revision,
                ],
            )
            .await
            .map_err(|error| format!("更新片段失败：{error}"))?,
    };

    if changed == 0 {
        tx.rollback().await.map_err(|error| error.to_string())?;
        return conflict_for_fragment(conn, &payload.id).await;
    }

    write_tags(&tx, &payload.id, &payload.tags).await?;
    write_attachment_links(&tx, &payload.id, &payload.attachment_hashes).await?;

    let revision = scalar_i64(&tx, "SELECT revision FROM fragments WHERE id = ?1", &payload.id)
        .await?;
    tx.commit().await.map_err(|error| error.to_string())?;

    Ok(PushOutcome::Applied { revision, seq })
}

const INSERT_FRAGMENT_SQL: &str = "
INSERT INTO fragments (
    id, content, content_hash, created_at, updated_at, updated_at_ms,
    archived_at, deleted_at, pinned, lockbox, category, ai_status, source, conflict_of,
    cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
    updated_by_device, seq, revision
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6,
    ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
    ?15, ?16, ?17, ?18, ?19, ?20,
    ?21, ?22, 1
)
ON CONFLICT(id) DO NOTHING
";

const UPDATE_FRAGMENT_SQL: &str = "
UPDATE fragments SET
    content = ?2, content_hash = ?3, updated_at = ?4, updated_at_ms = ?5,
    archived_at = ?6, deleted_at = ?7, pinned = ?8, lockbox = ?9,
    category = ?10, ai_status = ?11, source = ?12, conflict_of = ?13,
    cipher_version = ?14, cipher_nonce = ?15, cipher_text = ?16,
    cipher_key_alg = ?17, cipher_key_text = ?18, cipher_key_id = ?19,
    updated_by_device = ?20, seq = ?21, revision = revision + 1
WHERE id = ?1 AND revision = ?22
";

async fn apply_map(
    conn: &Connection,
    device_id: &str,
    base_revision: Option<i64>,
    payload: &MapPayload,
) -> Result<PushOutcome, String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;
    let seq = db::next_seq(&tx).await?;

    let changed = match base_revision {
        None => tx
            .execute(
                "INSERT INTO shard_maps (
                    id, title, doc_json, doc_hash, revision, node_count,
                    created_at, updated_at, updated_at_ms, deleted_at,
                    updated_by_device, seq, export_dirty
                 ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1)
                 ON CONFLICT(id) DO NOTHING",
                params![
                    payload.id.clone(),
                    payload.title.clone(),
                    payload.doc_json.clone(),
                    payload.doc_hash.clone(),
                    payload.node_count,
                    payload.created_at.clone(),
                    payload.updated_at.clone(),
                    payload.updated_at_ms,
                    payload.deleted_at.clone(),
                    device_id,
                    seq,
                ],
            )
            .await
            .map_err(|error| format!("写入导图失败：{error}"))?,
        Some(revision) => tx
            .execute(
                "UPDATE shard_maps SET
                    title = ?2, doc_json = ?3, doc_hash = ?4, node_count = ?5,
                    updated_at = ?6, updated_at_ms = ?7, deleted_at = ?8,
                    updated_by_device = ?9, seq = ?10, revision = revision + 1
                 WHERE id = ?1 AND revision = ?11",
                params![
                    payload.id.clone(),
                    payload.title.clone(),
                    payload.doc_json.clone(),
                    payload.doc_hash.clone(),
                    payload.node_count,
                    payload.updated_at.clone(),
                    payload.updated_at_ms,
                    payload.deleted_at.clone(),
                    device_id,
                    seq,
                    revision,
                ],
            )
            .await
            .map_err(|error| format!("更新导图失败：{error}"))?,
    };

    if changed == 0 {
        tx.rollback().await.map_err(|error| error.to_string())?;
        return conflict_for_map(conn, &payload.id).await;
    }

    let revision =
        scalar_i64(&tx, "SELECT revision FROM shard_maps WHERE id = ?1", &payload.id).await?;
    tx.commit().await.map_err(|error| error.to_string())?;

    Ok(PushOutcome::Applied { revision, seq })
}

/// 附件元数据是内容寻址的：同一个 hash 永远对应同一份字节，因此没有"更新"
/// 这回事，重复推送是幂等的空操作。
async fn apply_attachment(
    conn: &Connection,
    payload: &AttachmentPayload,
) -> Result<PushOutcome, String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;
    let seq = db::next_seq(&tx).await?;

    tx.execute(
        "INSERT INTO attachments (hash, mime_type, byte_size, created_at, deleted_at, seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(hash) DO UPDATE SET deleted_at = excluded.deleted_at, seq = excluded.seq",
        params![
            payload.hash.clone(),
            payload.mime_type.clone(),
            payload.byte_size,
            payload.created_at.clone(),
            payload.deleted_at.clone(),
            seq,
        ],
    )
    .await
    .map_err(|error| format!("写入附件元数据失败：{error}"))?;

    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(PushOutcome::Applied { revision: 1, seq })
}

async fn conflict_for_fragment(conn: &Connection, id: &str) -> Result<PushOutcome, String> {
    match load_fragment(conn, id).await? {
        Some(current) => Ok(PushOutcome::Conflict {
            current: Box::new(ServerVersion::Fragment(Box::new(current))),
        }),
        // 影响 0 行且该行根本不存在：客户端拿着一个 base_revision 来更新一条
        // 服务端没有的笔记。这不是并发冲突，是请求本身不成立。
        None => Ok(PushOutcome::Rejected {
            reason: "服务端没有这条记录，无法按指定版本更新".to_string(),
        }),
    }
}

async fn conflict_for_map(conn: &Connection, id: &str) -> Result<PushOutcome, String> {
    match load_map(conn, id).await? {
        Some(current) => Ok(PushOutcome::Conflict {
            current: Box::new(ServerVersion::Map(Box::new(current))),
        }),
        None => Ok(PushOutcome::Rejected {
            reason: "服务端没有这份导图，无法按指定版本更新".to_string(),
        }),
    }
}

pub async fn load_fragment(
    conn: &Connection,
    id: &str,
) -> Result<Option<FragmentPayload>, String> {
    let sql = format!("SELECT {FRAGMENT_COLUMNS} FROM fragments WHERE id = ?1");
    let mut rows = conn
        .query(&sql, params![id])
        .await
        .map_err(|error| error.to_string())?;

    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let mut payload = fragment_from_row(&row)?;
    payload.tags = fetch_tags(conn, id).await?;
    payload.attachment_hashes = fetch_attachment_hashes(conn, id).await?;
    Ok(Some(payload))
}

pub async fn load_map(conn: &Connection, id: &str) -> Result<Option<MapPayload>, String> {
    let sql = format!("SELECT {MAP_COLUMNS} FROM shard_maps WHERE id = ?1");
    let mut rows = conn
        .query(&sql, params![id])
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(map_from_row(&row)?)),
        None => Ok(None),
    }
}

/// 附件登记时定死的 MIME。下载端点直接用它，不在服务端二次嗅探——摄入时
/// 按魔数判定过一次就够了，服务端再猜一遍只会引入第二套口径。
pub async fn load_attachment_mime(
    conn: &Connection,
    hash: &str,
) -> Result<Option<String>, String> {
    let mut rows = conn
        .query(
            "SELECT mime_type FROM attachments WHERE hash = ?1 AND deleted_at IS NULL",
            params![hash],
        )
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => row.get(0).map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

async fn write_tags(conn: &Connection, id: &str, tags: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM fragment_tags WHERE fragment_id = ?1", params![id])
        .await
        .map_err(|error| error.to_string())?;
    for tag in tags {
        conn.execute(
            "INSERT OR IGNORE INTO fragment_tags (fragment_id, tag) VALUES (?1, ?2)",
            params![id, tag.clone()],
        )
        .await
        .map_err(|error| format!("写入标签失败：{error}"))?;
    }
    Ok(())
}

/// 关联表有外键指向 `attachments`。元数据还没推上来时**跳过**而不是报错：
/// 客户端可能先推笔记后推附件，这个顺序本身是合法的，等附件到了再补即可。
async fn write_attachment_links(
    conn: &Connection,
    id: &str,
    hashes: &[String],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM fragment_attachments WHERE fragment_id = ?1",
        params![id],
    )
    .await
    .map_err(|error| error.to_string())?;

    for hash in hashes {
        conn.execute(
            "INSERT OR IGNORE INTO fragment_attachments (fragment_id, hash)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM attachments WHERE hash = ?2)",
            params![id, hash.clone()],
        )
        .await
        .map_err(|error| format!("关联附件失败：{error}"))?;
    }
    Ok(())
}

async fn fetch_tags(conn: &Connection, id: &str) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT tag FROM fragment_tags WHERE fragment_id = ?1 ORDER BY tag",
            params![id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut tags = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        tags.push(row.get(0).map_err(|e| e.to_string())?);
    }
    Ok(tags)
}

async fn fetch_attachment_hashes(conn: &Connection, id: &str) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT hash FROM fragment_attachments WHERE fragment_id = ?1 ORDER BY hash",
            params![id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut hashes = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        hashes.push(row.get(0).map_err(|e| e.to_string())?);
    }
    Ok(hashes)
}

async fn scalar_i64(conn: &Connection, sql: &str, param: &str) -> Result<i64, String> {
    let mut rows = conn
        .query(sql, params![param])
        .await
        .map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "查询无结果".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}

fn fragment_from_row(row: &Row) -> Result<FragmentPayload, String> {
    let get_string = |index: i32| -> Result<String, String> {
        row.get(index).map_err(|error| error.to_string())
    };
    let get_opt = |index: i32| -> Result<Option<String>, String> {
        row.get(index).map_err(|error| error.to_string())
    };
    let get_i64 = |index: i32| -> Result<i64, String> {
        row.get(index).map_err(|error| error.to_string())
    };

    let cipher_text: Option<String> = get_opt(19)?;
    let cipher = cipher_text.map(|text| -> Result<CipherEnvelope, String> {
        Ok(CipherEnvelope {
            version: row.get::<Option<i64>>(17).map_err(|e| e.to_string())?.unwrap_or(1),
            nonce: get_opt(18)?.unwrap_or_default(),
            text,
            key_alg: get_opt(20)?,
            key_text: get_opt(21)?,
            key_id: get_opt(22)?,
        })
    });

    Ok(FragmentPayload {
        id: get_string(0)?,
        content: get_opt(1)?,
        content_hash: get_string(2)?,
        created_at: get_string(3)?,
        updated_at: get_string(4)?,
        updated_at_ms: get_i64(5)?,
        archived_at: get_opt(6)?,
        deleted_at: get_opt(7)?,
        pinned: get_i64(8)? != 0,
        lockbox: get_i64(9)? != 0,
        category: get_opt(10)?,
        ai_status: get_string(11)?,
        source: get_string(12)?,
        tags: Vec::new(),
        revision: get_i64(13)?,
        updated_by_device: get_string(14)?,
        conflict_of: get_opt(15)?,
        cipher: cipher.transpose()?,
        attachment_hashes: Vec::new(),
    })
}

fn map_from_row(row: &Row) -> Result<MapPayload, String> {
    Ok(MapPayload {
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
    })
}

fn attachment_from_row(row: &Row) -> Result<AttachmentPayload, String> {
    Ok(AttachmentPayload {
        hash: row.get(0).map_err(|e| e.to_string())?,
        mime_type: row.get(1).map_err(|e| e.to_string())?,
        byte_size: row.get(2).map_err(|e| e.to_string())?,
        created_at: row.get(3).map_err(|e| e.to_string())?,
        deleted_at: row.get(4).map_err(|e| e.to_string())?,
    })
}
