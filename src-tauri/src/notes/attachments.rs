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
//! # 正文只引用 hash
//!
//! 笔记正文里的图片写成 `![alt](shard-attachment:<hash>)`。协议只接受 hash，
//! 客户端永不解析用户提供的路径，路径穿越在结构上不可能发生。旧的
//! `assets/...` 相对引用在导入时一次性重写过来。
#![allow(dead_code)]

use std::collections::HashMap;

use libsql::{params, Connection};

/// 正文里引用附件的协议前缀。
pub(crate) const ATTACHMENT_SCHEME: &str = "shard-attachment:";

/// sha256 十六进制摘要的长度。用来把正文里的引用与随便一段文字区分开。
const HASH_HEX_LEN: usize = 64;

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

/// hash 必须是纯十六进制的定长摘要。协议入口用它挡住一切非内容寻址的输入。
pub(crate) fn is_valid_hash(hash: &str) -> bool {
    hash.len() == HASH_HEX_LEN && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 把正文里指向 `assets/` 的图片引用改写成内容寻址协议。
///
/// `assets` 的键是相对 vault 的路径（`assets/2026/07/x.png`）。查不到的引用
/// **原样保留**——迁移不该因为一张丢失的图片就改坏正文。
pub(crate) fn rewrite_asset_links(content: &str, assets: &HashMap<String, String>) -> String {
    map_image_targets(content, |target| {
        let (link, title) = split_target(target);
        let hash = assets.get(&normalize_asset_key(link)?)?;
        Some(format!("{ATTACHMENT_SCHEME}{hash}{title}"))
    })
}

/// 正文引用到的全部附件 hash，去重且保序。
pub(crate) fn referenced_hashes(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = content;

    while let Some(index) = rest.find(ATTACHMENT_SCHEME) {
        let after = &rest[index + ATTACHMENT_SCHEME.len()..];
        let end = after
            .find(|ch: char| !ch.is_ascii_hexdigit())
            .unwrap_or(after.len());
        let hash = &after[..end];

        if is_valid_hash(hash) && !out.iter().any(|seen| seen == hash) {
            out.push(hash.to_string());
        }
        rest = &after[end..];
    }

    out
}

/// 遍历正文里的 Markdown 图片，把链接目标交给 `map` 改写。
///
/// 手写扫描而不是正则：只需要认 `![…](…)` 这一种形状，为它引一个正则依赖
/// 不划算，而且这里的输入是用户正文，行为必须可预测——认不出的形状一律
/// 原样透传。
fn map_image_targets(content: &str, mut map: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;

    while let Some(start) = rest.find("![") {
        let (head, tail) = rest.split_at(start);
        out.push_str(head);

        let Some(mid) = tail.find("](") else {
            out.push_str(tail);
            return out;
        };

        out.push_str(&tail[..mid + 2]);
        let after = &tail[mid + 2..];

        let Some(end) = after.find(')') else {
            rest = after;
            continue;
        };

        let target = &after[..end];
        match map(target) {
            Some(replacement) => out.push_str(&replacement),
            None => out.push_str(target),
        }
        out.push(')');
        rest = &after[end + 1..];
    }

    out.push_str(rest);
    out
}

/// 拆出链接本体与其后的可选标题（`![a](path "title")`）。
fn split_target(target: &str) -> (&str, &str) {
    match target.find(char::is_whitespace) {
        Some(index) => (&target[..index], &target[index..]),
        None => (target, ""),
    }
}

/// 把正文里的链接归一成 `assets/…` 形式的查表键。
fn normalize_asset_key(link: &str) -> Option<String> {
    let trimmed = link.trim().trim_start_matches('<').trim_end_matches('>');
    if trimmed.is_empty() || trimmed.contains("://") {
        return None;
    }

    let decoded = percent_decode(trimmed).replace('\\', "/");
    // 绝对路径也能命中：迁移前的正文里两种写法都出现过。
    let index = decoded.rfind("assets/")?;
    Some(decoded[index..].to_string())
}

/// 只解码 `%XX`。正文里的中文文件名常被编辑器写成百分号转义，不解码就查不到表。
fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }

    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
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

    fn assets() -> HashMap<String, String> {
        HashMap::from([(
            "assets/2026/07/photo.png".to_string(),
            "a".repeat(HASH_HEX_LEN),
        )])
    }

    #[test]
    fn rewrites_relative_asset_reference() {
        let out = rewrite_asset_links("看这个 ![截图](assets/2026/07/photo.png) 结束", &assets());
        assert_eq!(
            out,
            format!("看这个 ![截图](shard-attachment:{}) 结束", "a".repeat(64))
        );
    }

    /// `./` 前缀、百分号转义、绝对路径三种写法在真实 vault 里都出现过。
    #[test]
    fn rewrites_alternate_path_spellings() {
        let map = HashMap::from([("assets/我的图.png".to_string(), "b".repeat(HASH_HEX_LEN))]);
        for link in [
            "./assets/我的图.png",
            "assets/%E6%88%91%E7%9A%84%E5%9B%BE.png",
            "/Users/x/vault/assets/我的图.png",
        ] {
            let out = rewrite_asset_links(&format!("![x]({link})"), &map);
            assert_eq!(
                out,
                format!("![x](shard-attachment:{})", "b".repeat(64)),
                "未能重写 {link}"
            );
        }
    }

    /// 带标题的图片语法不该被吃掉标题。
    #[test]
    fn preserves_image_title() {
        let out = rewrite_asset_links("![x](assets/2026/07/photo.png \"标题\")", &assets());
        assert!(out.contains("\"标题\""), "标题丢失：{out}");
        assert!(out.contains(ATTACHMENT_SCHEME));
    }

    /// 查不到的引用原样保留：迁移不该因为一张丢图就改坏正文。
    #[test]
    fn leaves_unknown_and_external_references_untouched() {
        let text = "![a](assets/missing.png) ![b](https://example.com/x.png) [链接](assets/2026/07/photo.png)";
        assert_eq!(rewrite_asset_links(text, &assets()), text);
    }

    /// 未闭合的图片语法不该让扫描丢内容或死循环。
    #[test]
    fn malformed_syntax_round_trips() {
        for text in ["![未闭合](assets/2026", "![a", "![](", "普通文字"] {
            assert_eq!(rewrite_asset_links(text, &assets()), text, "{text}");
        }
    }

    #[test]
    fn collects_referenced_hashes_deduplicated() {
        let hash = "c".repeat(HASH_HEX_LEN);
        let text = format!("![a]({ATTACHMENT_SCHEME}{hash}) ![b]({ATTACHMENT_SCHEME}{hash})");
        assert_eq!(referenced_hashes(&text), vec![hash]);
    }

    /// 长度不对的一段十六进制不是附件引用。
    #[test]
    fn ignores_malformed_hash_references() {
        assert!(referenced_hashes("![a](shard-attachment:abc)").is_empty());
        assert!(referenced_hashes("shard-attachment:").is_empty());
    }
}
