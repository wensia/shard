//! 笔记库的读写。
//!
//! 全部函数签名都是 `async fn(conn: &Connection, ...)`，不依赖 Tauri——
//! 与 `debt.rs` 的 `fetch_debt` / `list_all_debts` 同构，因此可以照抄那边
//! `Builder::new_local(":memory:")` + `#[tokio::test]` 的单测模式，
//! 不需要起 Tauri runtime。
//!
//! `Transaction` Deref 到 `Connection`，所以这里的函数对二者都能直接调用。

use libsql::{params, Connection, Row};

use super::model::{to_millis, CipherEnvelope, FragmentRow, NoteWrite};
use super::search;

/// 读取整行时的列顺序。与 [`map_row`] 严格对应，改一处必须改另一处。
#[allow(dead_code)]
const FRAGMENT_COLUMNS: &str = "
    id, content, content_hash, created_at, updated_at,
    archived_at, pinned, lockbox, category, ai_status, source, revision,
    cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
    export_path, export_dirty
";

/// 写入一条笔记（新建或整体覆盖），连同标签与全文索引。
///
/// 整个操作在一个事务里：要么三者都成功，要么都不留痕迹。中途失败留下
/// 「笔记在库里但索引没建」这种半截状态，表现出来就是搜索莫名其妙搜不到。
///
/// 这里**不做 CAS**：Phase 2 的影子写阶段 Markdown 仍是真相源，DB 只是旁路。
/// 写路径反转（Phase 4）时才引入 `expected_revision` 参数。
pub(crate) async fn upsert(conn: &Connection, note: &NoteWrite) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| format!("开启事务失败：{error}"))?;

    let cipher = note.cipher.as_ref();
    let archived_at = note.archived.then(|| note.updated_at.clone());

    tx.execute(
        UPSERT_SQL,
        params![
            note.id.clone(),
            note.content.clone(),
            note.content_hash(),
            note.created_at.clone(),
            note.updated_at.clone(),
            to_millis(&note.updated_at),
            archived_at,
            i64::from(note.pinned),
            i64::from(note.is_lockbox()),
            note.category.clone(),
            note.ai_status.clone(),
            note.source.clone(),
            cipher.map(|c| c.version),
            cipher.map(|c| c.nonce.clone()),
            cipher.map(|c| c.text.clone()),
            cipher.and_then(|c| c.key_alg.clone()),
            cipher.and_then(|c| c.key_text.clone()),
            cipher.and_then(|c| c.key_id.clone()),
            note.export_path.clone(),
        ],
    )
    .await
    .map_err(|error| format!("写入笔记失败：{error}"))?;

    tx.execute(
        "DELETE FROM fragment_tags WHERE fragment_id = ?1",
        params![note.id.clone()],
    )
    .await
    .map_err(|error| error.to_string())?;

    for tag in &note.tags {
        tx.execute(
            "INSERT OR IGNORE INTO fragment_tags (fragment_id, tag) VALUES (?1, ?2)",
            params![note.id.clone(), tag.clone()],
        )
        .await
        .map_err(|error| format!("写入标签失败：{error}"))?;
    }

    search::index_fragment(&tx, &note.id, note.content.as_deref(), &note.tags).await?;

    tx.commit()
        .await
        .map_err(|error| format!("提交事务失败：{error}"))?;
    Ok(())
}

const UPSERT_SQL: &str = "
INSERT INTO fragments (
    id, content, content_hash, created_at, updated_at, updated_at_ms,
    archived_at, pinned, lockbox, category, ai_status, source,
    cipher_version, cipher_nonce, cipher_text, cipher_key_alg, cipher_key_text, cipher_key_id,
    export_path, revision, export_dirty
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6,
    ?7, ?8, ?9, ?10, ?11, ?12,
    ?13, ?14, ?15, ?16, ?17, ?18,
    ?19, 1, 1
)
ON CONFLICT(id) DO UPDATE SET
    content         = excluded.content,
    content_hash    = excluded.content_hash,
    updated_at      = excluded.updated_at,
    updated_at_ms   = excluded.updated_at_ms,
    archived_at     = excluded.archived_at,
    pinned          = excluded.pinned,
    lockbox         = excluded.lockbox,
    category        = excluded.category,
    ai_status       = excluded.ai_status,
    source          = excluded.source,
    cipher_version  = excluded.cipher_version,
    cipher_nonce    = excluded.cipher_nonce,
    cipher_text     = excluded.cipher_text,
    cipher_key_alg  = excluded.cipher_key_alg,
    cipher_key_text = excluded.cipher_key_text,
    cipher_key_id   = excluded.cipher_key_id,
    export_path     = excluded.export_path,
    export_dirty    = 1,
    revision        = fragments.revision + 1
";

/// 按 id 取一条（含标签）。已软删除的返回 `None`。
///
/// Phase 2 仅测试使用；读路径在 Phase 3 切换。
#[allow(dead_code)]
pub(crate) async fn get(conn: &Connection, id: &str) -> Result<Option<FragmentRow>, String> {
    let sql =
        format!("SELECT {FRAGMENT_COLUMNS} FROM fragments WHERE id = ?1 AND deleted_at IS NULL");
    let mut rows = conn
        .query(&sql, params![id])
        .await
        .map_err(|error| error.to_string())?;

    let Some(row) = rows.next().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };

    let mut fragment = map_row(&row).map_err(|error| error.to_string())?;
    fragment.tags = fetch_tags(conn, id).await?;
    Ok(Some(fragment))
}

/// 列出全部未删除的片段（含归档与密匣），供读路径一次性取回。
///
/// 标签用**一条**查询批量取回后在内存里分组，绝不逐条查——按 id 逐条查标签
/// 是 N+1，1000 条笔记就是 1001 次往返，那样切到 DB 读路径就没有任何性能收益了。
pub(crate) async fn list_all(conn: &Connection) -> Result<Vec<FragmentRow>, String> {
    let sql = format!(
        "SELECT {FRAGMENT_COLUMNS} FROM fragments
         WHERE deleted_at IS NULL
         ORDER BY pinned DESC, created_at DESC, id DESC"
    );
    let mut rows = conn
        .query(&sql, ())
        .await
        .map_err(|error| error.to_string())?;

    let mut fragments = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        fragments.push(map_row(&row).map_err(|error| error.to_string())?);
    }

    let mut tags = fetch_all_tags(conn).await?;
    for fragment in &mut fragments {
        fragment.tags = tags.remove(&fragment.id).unwrap_or_default();
    }
    Ok(fragments)
}

/// 一次取回所有标签，按 fragment_id 分组。
async fn fetch_all_tags(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let mut rows = conn
        .query(
            "SELECT fragment_id, tag FROM fragment_tags ORDER BY fragment_id, tag",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut grouped: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        let id: String = row.get(0).map_err(|error| error.to_string())?;
        let tag: String = row.get(1).map_err(|error| error.to_string())?;
        grouped.entry(id).or_default().push(tag);
    }
    Ok(grouped)
}

/// 未删除的笔记总数。`include_archived` 为 false 时只数活跃的。
pub(crate) async fn count(conn: &Connection, include_archived: bool) -> Result<i64, String> {
    let sql = if include_archived {
        "SELECT count(*) FROM fragments WHERE deleted_at IS NULL"
    } else {
        "SELECT count(*) FROM fragments WHERE deleted_at IS NULL AND archived_at IS NULL"
    };
    let mut rows = conn.query(sql, ()).await.map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "count 查询无结果".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}

/// 软删除。**永不硬删**——墓碑是多端同步的必需品，见 `schema.rs` 的说明。
/// 同时把它移出全文索引，避免已删除的内容还能被搜到。
///
/// Phase 2 仅测试使用；删除路径在 Phase 4 接入。
#[allow(dead_code)]
pub(crate) async fn soft_delete(
    conn: &Connection,
    id: &str,
    deleted_at: &str,
    device: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;

    tx.execute(
        "UPDATE fragments
            SET deleted_at = ?2, updated_at = ?2, updated_at_ms = ?3,
                updated_by_device = ?4, revision = revision + 1
          WHERE id = ?1 AND deleted_at IS NULL",
        params![id, deleted_at, to_millis(deleted_at), device],
    )
    .await
    .map_err(|error| format!("软删除失败：{error}"))?;

    search::remove_fragment(&tx, id).await?;

    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

/// 标记一条已经成功导出到磁盘，清掉脏标记。
pub(crate) async fn mark_exported(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE fragments SET export_dirty = 0, exported_at = ?2 WHERE id = ?1",
        params![id, chrono::Local::now().to_rfc3339()],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 把一条从库里彻底移除（含标签与索引）。
///
/// 与 [`soft_delete`] 不同，这里是**硬删**，只用于「这条内容不该再以当前形态
/// 存在于库中」的场景——典型是明文被移入密匣：明文文件已从磁盘删除，库里
/// 残留的那一行就是明文泄漏，留个墓碑没有意义反而危险。
///
/// 用户发起的删除请走 `soft_delete`，那里需要墓碑来阻止其它设备把它推回来。
pub(crate) async fn purge(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|error| error.to_string())?;

    search::remove_fragment(&tx, id).await?;
    // fragment_tags 与 fragment_fts_ref 都是 ON DELETE CASCADE，随主行一起走。
    tx.execute("DELETE FROM fragments WHERE id = ?1", params![id])
        .await
        .map_err(|error| format!("清除笔记失败：{error}"))?;
    tx.execute(
        "DELETE FROM import_ledger WHERE target_id = ?1",
        params![id],
    )
    .await
    .map_err(|error| error.to_string())?;

    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) async fn fetch_tags(conn: &Connection, id: &str) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT tag FROM fragment_tags WHERE fragment_id = ?1 ORDER BY tag",
            params![id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut tags = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        tags.push(row.get(0).map_err(|error| error.to_string())?);
    }
    Ok(tags)
}

/// 读写 `db_meta` 的小工具，用于记录导入状态、schema owner 之类的库级事实。
pub(crate) async fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) async fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut rows = conn
        .query("SELECT value FROM db_meta WHERE key = ?1", params![key])
        .await
        .map_err(|error| error.to_string())?;
    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => row.get(0).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

#[allow(dead_code)]
fn map_row(row: &Row) -> libsql::Result<FragmentRow> {
    let archived_at: Option<String> = row.get(5)?;
    let lockbox: i64 = row.get(7)?;
    let pinned: i64 = row.get(6)?;

    let cipher_text: Option<String> = row.get(14)?;
    let cipher = match cipher_text {
        Some(text) => Some(CipherEnvelope {
            version: row.get::<Option<i64>>(12)?.unwrap_or(1),
            nonce: row.get::<Option<String>>(13)?.unwrap_or_default(),
            text,
            key_alg: row.get(15)?,
            key_text: row.get(16)?,
            key_id: row.get(17)?,
        }),
        None => None,
    };

    Ok(FragmentRow {
        id: row.get(0)?,
        content: row.get(1)?,
        content_hash: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        tags: Vec::new(),
        archived: archived_at.is_some(),
        pinned: pinned != 0,
        lockbox: lockbox != 0,
        category: row.get(8)?,
        ai_status: row.get(9)?,
        source: row.get(10)?,
        revision: row.get(11)?,
        cipher,
        export_path: row.get(18)?,
        export_dirty: row.get::<i64>(19)? != 0,
    })
}
