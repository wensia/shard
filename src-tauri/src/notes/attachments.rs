//! 附件元数据的库内读写。
//!
//! # 二进制不进库
//!
//! 只存元数据与内容寻址的 hash，字节留在文件系统的缓存目录。把大 blob 放进
//! 库会让体积失控，而附件天然适合按需读取——这与「本地不再有只存在于文件里
//! 的数据」并不矛盾：附件文件是可以从服务端重新拉取的缓存，不是真相源。
//!
//! # MIME 在摄入时定死
//!
//! 写入时用魔数嗅探确定并入库，读取直接用这一列。**不信任扩展名**：内容是
//! SVG 而文件名是 `.png` 的附件按扩展名判定会被当成 `image/png`，而 SVG 能
//! 携带脚本，这是一个真实的执行面。
//!
//! 本模块的命令层接入（save_fragment_image 改造、shard-attachment:// 协议）
//! 是第 4 步的后半程，目前只有单测覆盖。
#![allow(dead_code)]

use libsql::{params, Connection};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttachmentRow {
    /// sha256(bytes)，内容寻址：同样的字节永远指向同一行，天然去重。
    pub hash: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub created_at: String,
}

/// 登记一个附件。同 hash 重复登记是空操作——内容相同就是同一个附件。
pub(crate) async fn put(conn: &Connection, row: &AttachmentRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO attachments (hash, mime_type, byte_size, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(hash) DO UPDATE SET deleted_at = NULL",
        params![
            row.hash.clone(),
            row.mime_type.clone(),
            row.byte_size,
            row.created_at.clone(),
        ],
    )
    .await
    .map_err(|error| format!("登记附件失败：{error}"))?;
    Ok(())
}

pub(crate) async fn get(conn: &Connection, hash: &str) -> Result<Option<AttachmentRow>, String> {
    let mut rows = conn
        .query(
            "SELECT hash, mime_type, byte_size, created_at
               FROM attachments WHERE hash = ?1 AND deleted_at IS NULL",
            params![hash],
        )
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => Ok(Some(AttachmentRow {
            hash: row.get(0).map_err(|e| e.to_string())?,
            mime_type: row.get(1).map_err(|e| e.to_string())?,
            byte_size: row.get(2).map_err(|e| e.to_string())?,
            created_at: row.get(3).map_err(|e| e.to_string())?,
        })),
        None => Ok(None),
    }
}

/// 建立笔记与附件的引用关系。同一张图被多条笔记引用是正常的。
pub(crate) async fn link(conn: &Connection, fragment_id: &str, hash: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO fragment_attachments (fragment_id, hash) VALUES (?1, ?2)",
        params![fragment_id, hash],
    )
    .await
    .map_err(|error| format!("关联附件失败：{error}"))?;
    Ok(())
}

/// 一条笔记引用的全部附件 hash。
pub(crate) async fn hashes_for(conn: &Connection, fragment_id: &str) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT hash FROM fragment_attachments WHERE fragment_id = ?1 ORDER BY hash",
            params![fragment_id],
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(row.get(0).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 未被任何笔记引用的附件。内容寻址意味着删一条笔记不能直接删它的附件——
/// 别的笔记可能还在用。回收前必须先查引用计数。
pub(crate) async fn orphans(conn: &Connection) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT a.hash FROM attachments a
              WHERE a.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM fragment_attachments f WHERE f.hash = a.hash)
              ORDER BY a.hash",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(row.get(0).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub(crate) async fn count(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query("SELECT count(*) FROM attachments WHERE deleted_at IS NULL", ())
        .await
        .map_err(|e| e.to_string())?;
    rows.next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "count 无结果".to_string())?
        .get(0)
        .map_err(|e| e.to_string())
}

/// 附件在缓存目录中的相对路径。按 hash 前两位分桶，避免单目录塞进上万个文件。
pub(crate) fn cache_rel_path(hash: &str) -> String {
    format!(".cache/attachments/{}/{}", &hash[..2.min(hash.len())], hash)
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

    fn row(hash: &str) -> AttachmentRow {
        AttachmentRow {
            hash: hash.into(),
            mime_type: "image/png".into(),
            byte_size: 1024,
            created_at: "2026-07-26T10:00:00+08:00".into(),
        }
    }

    async fn seed_fragment(c: &Connection, id: &str) {
        c.execute(
            "INSERT INTO fragments (id, content, content_hash, created_at, updated_at, updated_at_ms)
             VALUES (?1, 'x', 'h', 't', 't', 0)",
            params![id],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn put_and_get_round_trips() {
        let c = conn().await;
        put(&c, &row("abc123")).await.unwrap();
        let got = get(&c, "abc123").await.unwrap().unwrap();
        assert_eq!(got.mime_type, "image/png");
        assert_eq!(got.byte_size, 1024);
    }

    /// 内容寻址：同一份字节重复登记不该产生第二行。
    #[tokio::test]
    async fn put_is_idempotent_for_same_hash() {
        let c = conn().await;
        put(&c, &row("abc123")).await.unwrap();
        put(&c, &row("abc123")).await.unwrap();
        assert_eq!(count(&c).await.unwrap(), 1);
    }

    /// 同一张图可以被多条笔记引用——这正是不把 fragment_id 挂在 attachments
    /// 上的原因。
    #[tokio::test]
    async fn one_attachment_can_serve_many_fragments() {
        let c = conn().await;
        put(&c, &row("shared")).await.unwrap();
        seed_fragment(&c, "f1").await;
        seed_fragment(&c, "f2").await;
        link(&c, "f1", "shared").await.unwrap();
        link(&c, "f2", "shared").await.unwrap();

        assert_eq!(hashes_for(&c, "f1").await.unwrap(), vec!["shared".to_string()]);
        assert_eq!(hashes_for(&c, "f2").await.unwrap(), vec!["shared".to_string()]);
        assert_eq!(count(&c).await.unwrap(), 1, "仍然只有一个附件");
    }

    #[tokio::test]
    async fn link_is_idempotent() {
        let c = conn().await;
        put(&c, &row("h")).await.unwrap();
        seed_fragment(&c, "f1").await;
        link(&c, "f1", "h").await.unwrap();
        link(&c, "f1", "h").await.unwrap();
        assert_eq!(hashes_for(&c, "f1").await.unwrap().len(), 1);
    }

    /// 删一条笔记不能连带删掉别人还在用的附件。
    #[tokio::test]
    async fn orphan_detection_respects_remaining_references() {
        let c = conn().await;
        put(&c, &row("shared")).await.unwrap();
        put(&c, &row("lonely")).await.unwrap();
        seed_fragment(&c, "f1").await;
        seed_fragment(&c, "f2").await;
        link(&c, "f1", "shared").await.unwrap();
        link(&c, "f2", "shared").await.unwrap();

        assert_eq!(orphans(&c).await.unwrap(), vec!["lonely".to_string()]);

        // 删掉 f1，shared 仍被 f2 引用，不该变成孤儿。
        c.execute("DELETE FROM fragments WHERE id = 'f1'", ()).await.unwrap();
        let after = orphans(&c).await.unwrap();
        assert!(!after.contains(&"shared".to_string()), "仍被引用的附件不是孤儿");

        // 两条都删掉之后才成为孤儿。
        c.execute("DELETE FROM fragments WHERE id = 'f2'", ()).await.unwrap();
        assert!(orphans(&c).await.unwrap().contains(&"shared".to_string()));
    }

    /// 笔记被删除时关联应随之消失（ON DELETE CASCADE）。
    #[tokio::test]
    async fn links_cascade_with_fragment() {
        let c = conn().await;
        put(&c, &row("h")).await.unwrap();
        seed_fragment(&c, "f1").await;
        link(&c, "f1", "h").await.unwrap();

        c.execute("DELETE FROM fragments WHERE id = 'f1'", ()).await.unwrap();
        assert!(hashes_for(&c, "f1").await.unwrap().is_empty());
        assert!(get(&c, "h").await.unwrap().is_some(), "附件本身不该被连带删除");
    }

    #[tokio::test]
    async fn cache_path_buckets_by_hash_prefix() {
        assert_eq!(
            cache_rel_path("ab12cd34"),
            ".cache/attachments/ab/ab12cd34"
        );
    }
}
