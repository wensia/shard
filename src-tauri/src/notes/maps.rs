//! 思维导图的库内读写。
//!
//! # 整档存储
//!
//! 导图整份序列化成 `doc_json` 存一行，不拆节点表。现有
//! `SHARD_MAP_MAX_NODES = 400`，保存语义本就是「整档 + `expected_revision`
//! + `last_saved_hash`」——整档存储让既有的乐观锁 1:1 平移成一条 CAS UPDATE，
//! 不必重新设计并发模型。
//!
//! # 乐观锁语义与文件版完全一致
//!
//! 文件版 `write_mind_map_in_vault` 的判定是「当前 revision 与 hash 都匹配才写，
//! 否则另存冲突副本并报错」。这里的 CAS 是同一条规则的 SQL 表达：
//! `WHERE id = ? AND revision = ? AND doc_hash = ?`，`rows_affected == 0` 即冲突。
//!
//! 本模块在第 3 步（导图命令改走 DB）才被命令层调用，目前只有单测覆盖。
#![allow(dead_code)]

use libsql::{params, Connection};

use super::model::to_millis;

/// 库里的一份导图。
#[derive(Debug, Clone)]
pub(crate) struct MapRow {
    pub id: String,
    pub title: String,
    pub doc_json: String,
    pub doc_hash: String,
    pub revision: i64,
    pub node_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub export_path: Option<String>,
    pub export_dirty: bool,
    /// 这一版推到服务端时的 revision。与 `revision` 不等即有本地改动待推。
    pub synced_revision: Option<i64>,
}

const MAP_COLUMNS: &str = "
    id, title, doc_json, doc_hash, revision, node_count,
    created_at, updated_at, export_path, export_dirty, synced_revision
";

/// CAS 失败的原因。调用方据此决定是另存冲突副本还是报「找不到」。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Applied { revision: i64 },
    /// 行存在但 revision/hash 不匹配——有人在别处改过。
    Conflict,
    NotFound,
}

/// 新建一份导图。
pub(crate) async fn insert(conn: &Connection, row: &MapRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO shard_maps
         (id, title, doc_json, doc_hash, revision, node_count,
          created_at, updated_at, updated_at_ms, export_path, export_dirty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)",
        params![
            row.id.clone(),
            row.title.clone(),
            row.doc_json.clone(),
            row.doc_hash.clone(),
            row.revision,
            row.node_count,
            row.created_at.clone(),
            row.updated_at.clone(),
            to_millis(&row.updated_at),
            row.export_path.clone(),
        ],
    )
    .await
    .map_err(|error| format!("写入导图失败：{error}"))?;
    Ok(())
}

/// 带 CAS 的更新。**只有** revision 与 doc_hash 都匹配才会写入。
///
/// 两个条件都要查：单看 revision 挡不住「改了内容但 revision 没动」的情况，
/// 单看 hash 挡不住「改回原样又继续改」的 ABA。文件版同时校验这两项，
/// 这里保持一致。
pub(crate) async fn update_cas(
    conn: &Connection,
    id: &str,
    doc_json: &str,
    doc_hash: &str,
    title: &str,
    node_count: i64,
    updated_at: &str,
    expected_revision: i64,
    expected_hash: &str,
) -> Result<WriteOutcome, String> {
    let affected = conn
        .execute(
            "UPDATE shard_maps
                SET title = ?2, doc_json = ?3, doc_hash = ?4, node_count = ?5,
                    updated_at = ?6, updated_at_ms = ?7,
                    revision = revision + 1, export_dirty = 1
              WHERE id = ?1 AND revision = ?8 AND doc_hash = ?9 AND deleted_at IS NULL",
            params![
                id,
                title,
                doc_json,
                doc_hash,
                node_count,
                updated_at,
                to_millis(updated_at),
                expected_revision,
                expected_hash,
            ],
        )
        .await
        .map_err(|error| format!("更新导图失败：{error}"))?;

    if affected > 0 {
        return Ok(WriteOutcome::Applied {
            revision: expected_revision + 1,
        });
    }
    // 没写成：要么行不在，要么被别处改过。区分开才能给出准确的错误。
    Ok(if get(conn, id).await?.is_some() {
        WriteOutcome::Conflict
    } else {
        WriteOutcome::NotFound
    })
}

pub(crate) async fn get(conn: &Connection, id: &str) -> Result<Option<MapRow>, String> {
    let sql =
        format!("SELECT {MAP_COLUMNS} FROM shard_maps WHERE id = ?1 AND deleted_at IS NULL");
    let mut rows = conn
        .query(&sql, params![id])
        .await
        .map_err(|error| error.to_string())?;
    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => map_row(&row).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

/// 按更新时间倒序列出全部未删除的导图。
pub(crate) async fn list(conn: &Connection) -> Result<Vec<MapRow>, String> {
    let sql = format!(
        "SELECT {MAP_COLUMNS} FROM shard_maps
         WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC"
    );
    let mut rows = conn.query(&sql, ()).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(map_row(&row).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 软删除。与笔记一致：**永不硬删**，墓碑是多端同步的必需品。
pub(crate) async fn soft_delete(
    conn: &Connection,
    id: &str,
    deleted_at: &str,
) -> Result<bool, String> {
    let affected = conn
        .execute(
            "UPDATE shard_maps SET deleted_at = ?2, updated_at = ?2, updated_at_ms = ?3
              WHERE id = ?1 AND deleted_at IS NULL",
            params![id, deleted_at, to_millis(deleted_at)],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(affected > 0)
}

pub(crate) async fn mark_exported(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE shard_maps SET export_dirty = 0 WHERE id = ?1",
        params![id],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn map_row(row: &libsql::Row) -> libsql::Result<MapRow> {
    Ok(MapRow {
        id: row.get(0)?,
        title: row.get(1)?,
        doc_json: row.get(2)?,
        doc_hash: row.get(3)?,
        revision: row.get(4)?,
        node_count: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        export_path: row.get(8)?,
        export_dirty: row.get::<i64>(9)? != 0,
        synced_revision: row.get(10)?,
    })
}

/// 把当前这一版另存为冲突副本。
///
/// 与笔记同一套语义：副本是**独立的一份**（新 id，不参与后续 CAS），
/// 只是留给人比对的快照。同步把远端版本写进原件时，本地那版就靠它保住。
pub(crate) async fn insert_conflict_copy(
    conn: &Connection,
    local: &MapRow,
) -> Result<String, String> {
    let copy_id = format!("{}-conflict-{}", local.id, chrono::Local::now().timestamp());
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO shard_maps
         (id, title, doc_json, doc_hash, revision, node_count,
          created_at, updated_at, updated_at_ms, export_path, export_dirty, synced_revision)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, NULL, 1, NULL)",
        params![
            copy_id.clone(),
            format!("{}（冲突副本）", local.title),
            local.doc_json.clone(),
            local.doc_hash.clone(),
            local.node_count,
            local.created_at.clone(),
            now.clone(),
            to_millis(&now),
        ],
    )
    .await
    .map_err(|error| format!("另存导图冲突副本失败：{error}"))?;

    Ok(copy_id)
}

// ---------------------------------------------------------------------------
// 与 lib.rs 的导图类型互转。
//
// 库里存的是「整档 JSON + 派生的 hash/计数」，而 UI 要的是解析好的
// ShardMapFile。转换集中在这里，避免命令层各写一份。
// ---------------------------------------------------------------------------

/// 由一份导图文档构造待写入的行。`doc_json` 走 canonical 序列化，
/// `doc_hash` 与前端的 `lastSavedHash` 同源，两者口径必须一致。
pub(crate) fn row_from_file(
    file: &crate::ShardMapFile,
    export_path: Option<String>,
) -> Result<MapRow, String> {
    let doc_json = crate::canonical_mind_map_text(file)?;
    Ok(MapRow {
        id: file.id.clone(),
        title: file.title.clone(),
        doc_hash: crate::hash_text(&doc_json),
        doc_json,
        revision: file.revision as i64,
        node_count: file.nodes.len() as i64,
        created_at: file.created_at.clone(),
        updated_at: file.updated_at.clone(),
        export_path,
        export_dirty: true,
        synced_revision: None,
    })
}

pub(crate) fn to_summary(row: &MapRow) -> crate::MindMapSummary {
    crate::MindMapSummary {
        id: row.id.clone(),
        title: row.title.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        node_count: row.node_count as usize,
        path: row.export_path.clone().unwrap_or_default(),
    }
}

/// 还原成 UI 要的读取结果。`last_saved_hash` 直接取库里的 `doc_hash`——
/// 它就是下次 CAS 写入时要回传的那个值。
pub(crate) fn to_read_result(row: &MapRow) -> Result<crate::MindMapReadResult, String> {
    let file: crate::ShardMapFile =
        serde_json::from_str(&row.doc_json).map_err(|error| error.to_string())?;
    Ok(crate::MindMapReadResult {
        file,
        path: row.export_path.clone().unwrap_or_default(),
        last_saved_hash: row.doc_hash.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let c = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&c, super::super::schema::MIGRATIONS)
            .await
            .unwrap();
        c
    }

    fn sample(id: &str, doc: &str) -> MapRow {
        MapRow {
            id: id.into(),
            title: "测试导图".into(),
            doc_json: doc.into(),
            doc_hash: crate::hash_text(doc),
            revision: 1,
            node_count: 3,
            created_at: "2026-07-26T10:00:00+08:00".into(),
            updated_at: "2026-07-26T10:00:00+08:00".into(),
            export_path: Some("maps/m1.shardmap.json".into()),
            export_dirty: true,
            synced_revision: None,
        }
    }

    #[tokio::test]
    async fn insert_and_get_round_trips() {
        let c = conn().await;
        insert(&c, &sample("m1", "{\"a\":1}")).await.unwrap();
        let row = get(&c, "m1").await.unwrap().unwrap();
        assert_eq!(row.doc_json, "{\"a\":1}");
        assert_eq!(row.revision, 1);
        assert!(row.export_dirty);
    }

    /// revision 与 hash 都匹配才写得进去，且 revision 自增。
    #[tokio::test]
    async fn cas_applies_when_both_match() {
        let c = conn().await;
        let row = sample("m1", "{\"a\":1}");
        insert(&c, &row).await.unwrap();

        let next = "{\"a\":2}";
        let outcome = update_cas(
            &c, "m1", next, &crate::hash_text(next), "改过的标题", 4,
            "2026-07-26T11:00:00+08:00", 1, &row.doc_hash,
        )
        .await
        .unwrap();

        assert_eq!(outcome, WriteOutcome::Applied { revision: 2 });
        let after = get(&c, "m1").await.unwrap().unwrap();
        assert_eq!(after.doc_json, next);
        assert_eq!(after.revision, 2);
        assert_eq!(after.node_count, 4);
    }

    /// revision 对不上 —— 别处已经改过，必须判定为冲突而不是覆盖。
    #[tokio::test]
    async fn cas_rejects_stale_revision() {
        let c = conn().await;
        let row = sample("m1", "{\"a\":1}");
        insert(&c, &row).await.unwrap();

        let outcome = update_cas(
            &c, "m1", "{\"a\":9}", "h", "t", 1,
            "2026-07-26T11:00:00+08:00", 99, &row.doc_hash,
        )
        .await
        .unwrap();

        assert_eq!(outcome, WriteOutcome::Conflict);
        assert_eq!(get(&c, "m1").await.unwrap().unwrap().doc_json, "{\"a\":1}");
    }

    /// revision 恰好对上但内容 hash 不符 —— 同样必须挡住。
    /// 只校验 revision 会漏掉「改了内容却没推进 revision」的写入。
    #[tokio::test]
    async fn cas_rejects_mismatched_hash() {
        let c = conn().await;
        insert(&c, &sample("m1", "{\"a\":1}")).await.unwrap();

        let outcome = update_cas(
            &c, "m1", "{\"a\":9}", "h", "t", 1,
            "2026-07-26T11:00:00+08:00", 1, "错误的hash",
        )
        .await
        .unwrap();
        assert_eq!(outcome, WriteOutcome::Conflict);
    }

    #[tokio::test]
    async fn cas_reports_not_found_separately() {
        let c = conn().await;
        let outcome = update_cas(
            &c, "缺失", "{}", "h", "t", 0,
            "2026-07-26T11:00:00+08:00", 1, "h",
        )
        .await
        .unwrap();
        assert_eq!(outcome, WriteOutcome::NotFound);
    }

    #[tokio::test]
    async fn soft_delete_hides_but_keeps_tombstone() {
        let c = conn().await;
        insert(&c, &sample("m1", "{}")).await.unwrap();
        assert!(soft_delete(&c, "m1", "2026-07-26T12:00:00+08:00").await.unwrap());

        assert!(get(&c, "m1").await.unwrap().is_none());
        assert!(list(&c).await.unwrap().is_empty());

        let mut rows = c
            .query("SELECT count(*) FROM shard_maps WHERE deleted_at IS NOT NULL", ())
            .await
            .unwrap();
        let tombstones: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(tombstones, 1, "软删除必须留下墓碑");
    }

    /// 已删除的导图不能再被 CAS 写入（否则墓碑会被复活）。
    #[tokio::test]
    async fn cas_ignores_deleted_rows() {
        let c = conn().await;
        let row = sample("m1", "{}");
        insert(&c, &row).await.unwrap();
        soft_delete(&c, "m1", "2026-07-26T12:00:00+08:00").await.unwrap();

        let outcome = update_cas(
            &c, "m1", "{\"a\":1}", "h", "t", 1,
            "2026-07-26T13:00:00+08:00", 1, &row.doc_hash,
        )
        .await
        .unwrap();
        assert_eq!(outcome, WriteOutcome::NotFound);
    }

    #[tokio::test]
    async fn list_orders_by_updated_desc() {
        let c = conn().await;
        let mut a = sample("a", "{}");
        a.updated_at = "2026-07-26T10:00:00+08:00".into();
        let mut b = sample("b", "{}");
        b.updated_at = "2026-07-26T12:00:00+08:00".into();
        insert(&c, &a).await.unwrap();
        insert(&c, &b).await.unwrap();

        let ids: Vec<String> = list(&c).await.unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["b".to_string(), "a".to_string()]);
    }

    #[tokio::test]
    async fn mark_exported_clears_dirty_flag() {
        let c = conn().await;
        insert(&c, &sample("m1", "{}")).await.unwrap();
        mark_exported(&c, "m1").await.unwrap();
        assert!(!get(&c, "m1").await.unwrap().unwrap().export_dirty);
    }
}
