//! FTS5 索引的维护与查询。
//!
//! 分词一律走 [`shard_core::fts`]：索引侧用 `to_fts_text`，查询侧用
//! `build_match_query`，**两者必须同源**。改动任何一侧都要跟一次
//! [`rebuild`]，否则旧索引配新查询会静默搜不到东西（不报错，只是没结果）。
//!
//! # 密匣绝不进索引
//!
//! 加密笔记的明文既不入 `fragments.content` 也不入 FTS。索引维护函数遇到
//! 密匣条目会主动把它从索引里移除，查询 SQL 也硬带 `AND f.lockbox = 0`——
//! 两道防线，任一条单独成立都能挡住明文泄漏。
//! 解锁后的密匣内搜索走前端内存扫描，是有意的降级。

use libsql::{params, Connection};
use shard_core::fts::{build_match_query, to_fts_text};

/// 一条搜索命中。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    pub id: String,
    /// 带 `<<` `>>` 标记的上下文片段，供前端高亮。
    pub snippet: String,
}

/// 写入或更新一条笔记的索引。
///
/// `content` 为 `None`（密匣条目）时改为从索引中移除——这样即使一条笔记从
/// 明文转成密匣，它的旧明文也不会残留在索引里。
pub(crate) async fn index_fragment(
    conn: &Connection,
    id: &str,
    content: Option<&str>,
    tags: &[String],
) -> Result<(), String> {
    let Some(content) = content else {
        return remove_fragment(conn, id).await;
    };

    let body = to_fts_text(content);
    let tags_text = to_fts_text(&tags.join(" "));

    match fts_rowid(conn, id).await? {
        Some(rowid) => {
            conn.execute(
                "UPDATE fragments_fts SET body = ?1, tags = ?2 WHERE rowid = ?3",
                params![body, tags_text, rowid],
            )
            .await
            .map_err(|error| format!("更新全文索引失败：{error}"))?;
        }
        None => {
            conn.execute(
                "INSERT INTO fragments_fts (body, tags) VALUES (?1, ?2)",
                params![body, tags_text],
            )
            .await
            .map_err(|error| format!("写入全文索引失败：{error}"))?;

            let rowid = last_insert_rowid(conn).await?;
            conn.execute(
                "INSERT INTO fragment_fts_ref (fragment_id, fts_rowid) VALUES (?1, ?2)",
                params![id, rowid],
            )
            .await
            .map_err(|error| format!("写入索引映射失败：{error}"))?;
        }
    }

    Ok(())
}

/// 从索引中移除一条笔记。不存在时是空操作。
pub(crate) async fn remove_fragment(conn: &Connection, id: &str) -> Result<(), String> {
    let Some(rowid) = fts_rowid(conn, id).await? else {
        return Ok(());
    };

    conn.execute("DELETE FROM fragments_fts WHERE rowid = ?1", params![rowid])
        .await
        .map_err(|error| format!("删除全文索引失败：{error}"))?;
    conn.execute(
        "DELETE FROM fragment_fts_ref WHERE fragment_id = ?1",
        params![id],
    )
    .await
    .map_err(|error| format!("删除索引映射失败：{error}"))?;

    Ok(())
}

/// 全文搜索。
///
/// `include_archived` 为 false 时只搜活跃笔记。密匣条目**永远**不在结果里。
/// 查询串没有可检索内容时返回空集，而不是把空表达式丢给 FTS5（那会报语法错）。
pub(crate) async fn search(
    conn: &Connection,
    query: &str,
    include_archived: bool,
    limit: i64,
) -> Result<Vec<SearchHit>, String> {
    let Some(match_expr) = build_match_query(query) else {
        return Ok(Vec::new());
    };

    // bm25 的列权重：body 比 tags 重。负号是因为 bm25() 返回值越小越相关，
    // 而我们要按相关度升序排（rank 越小越靠前）。
    let sql = "
        SELECT f.id,
               snippet(fragments_fts, 0, '<<', '>>', '…', 12) AS snip
        FROM fragments_fts
        JOIN fragment_fts_ref r ON r.fts_rowid = fragments_fts.rowid
        JOIN fragments f ON f.id = r.fragment_id
        WHERE fragments_fts MATCH ?1
          AND f.deleted_at IS NULL
          AND f.lockbox = 0
          AND (?2 = 1 OR f.archived_at IS NULL)
        ORDER BY f.pinned DESC, bm25(fragments_fts, 10.0, 4.0), f.created_at DESC
        LIMIT ?3
    ";

    let mut rows = conn
        .query(
            sql,
            params![match_expr, i64::from(include_archived), limit],
        )
        .await
        .map_err(|error| format!("全文搜索失败：{error}"))?;

    let mut hits = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        hits.push(SearchHit {
            id: row.get(0).map_err(|error| error.to_string())?,
            snippet: row.get(1).map_err(|error| error.to_string())?,
        });
    }
    Ok(hits)
}

/// 全量重建索引。分词逻辑变更后必须调用，否则旧索引与新查询不匹配。
pub(crate) async fn rebuild(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM fragments_fts", ())
        .await
        .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM fragment_fts_ref", ())
        .await
        .map_err(|error| error.to_string())?;

    // 只取明文条目：密匣不进索引。
    let mut rows = conn
        .query(
            "SELECT id, content FROM fragments
             WHERE deleted_at IS NULL AND lockbox = 0 AND content IS NOT NULL",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut pending: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        pending.push((
            row.get(0).map_err(|error| error.to_string())?,
            row.get(1).map_err(|error| error.to_string())?,
        ));
    }

    let count = pending.len();
    for (id, content) in pending {
        let tags = super::repo::fetch_tags(conn, &id).await?;
        index_fragment(conn, &id, Some(&content), &tags).await?;
    }
    Ok(count)
}

async fn fts_rowid(conn: &Connection, id: &str) -> Result<Option<i64>, String> {
    let mut rows = conn
        .query(
            "SELECT fts_rowid FROM fragment_fts_ref WHERE fragment_id = ?1",
            params![id],
        )
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => row.get(0).map(Some).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

async fn last_insert_rowid(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query("SELECT last_insert_rowid()", ())
        .await
        .map_err(|error| error.to_string())?;
    rows.next()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "无法读取 last_insert_rowid".to_string())?
        .get(0)
        .map_err(|error| error.to_string())
}
