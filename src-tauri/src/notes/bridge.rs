//! 笔记库 → 前端 `Fragment` 的转换。
//!
//! Phase 3 的读路径：`list_fragments` 不再递归扫目录、逐文件解析 YAML，改成
//! 一条 SQL 取回全部行再组装。命令签名与返回结构完全不变，前端零改动。
//!
//! # 必须与文件读路径逐字段对齐
//!
//! 这里产出的 `Fragment` 要和 `read_fragment` / `lockbox_fragment_from_parts`
//! 完全一致，否则切换读路径会出现"同一条笔记在两种模式下长得不一样"。
//! 两处已知的、容易漏的差异：
//!
//! - 明文笔记的空标签回退成 `["inbox"]`，**密匣笔记不回退**（沿用既有行为）；
//! - 正文取 `trim_start_matches('\n')`，去掉 frontmatter 与正文之间的空行。
//!
//! # 密匣
//!
//! 锁定态下密匣条目直接跳过（与文件路径下"没有读密钥就不扫 lockbox 目录"
//! 等价）。解锁态下从 `cipher_*` 列还原信封并解密，元数据一律以**密文里的
//! frontmatter 为准**——库里那几列是未解锁导入时用文件 mtime 填的占位值。

use std::collections::HashMap;
use std::path::Path;

use libsql::Connection;

use super::model::FragmentRow;
use super::repo;
use crate::{Fragment, LockboxEncryptedFragment, LockboxReadKeys};

/// 从笔记库读出全部片段，组装成 `VaultState.fragments`。
///
/// `read_keys` 为 `None` 表示密匣未解锁，此时密匣条目不出现在结果里。
pub(crate) async fn list_fragments(
    conn: &Connection,
    _vault: &Path,
    read_keys: Option<&LockboxReadKeys>,
) -> Result<Vec<Fragment>, String> {
    let rows = repo::list_all(conn).await?;

    let mut fragments = Vec::with_capacity(rows.len());
    for row in rows {
        let fragment = if row.lockbox {
            // 未解锁：密匣内容不可见，跳过而不是报错。
            let Some(keys) = read_keys else { continue };
            match decrypt_row(&row, keys) {
                Ok(fragment) => fragment,
                // 单条解密失败不该让整个列表打不开——与文件路径的
                // `filter_map(..ok())` 行为一致，静默跳过。
                Err(_) => continue,
            }
        } else {
            plain_fragment(&row)
        };
        fragments.push(fragment);
    }

    // 与 `list_fragments_in_vault` 完全相同的排序规则。不能只依赖 SQL 的
    // ORDER BY：密匣条目的 pinned / created_at 要解密后才拿到真值，库里存的是占位。
    //
    // 这里是稳定排序，因此 `created_at` 相同的条目会保留 SQL 的 `id DESC` 次序，
    // 得到一个确定的全序。文件路径在这种情况下取决于目录遍历顺序，是不确定的
    // ——两条路径在同秒创建的笔记上可能排得不一样，这是 DB 路径的改进而非回归。
    fragments.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    Ok(fragments)
}

/// 单行 → 前端 `Fragment`。写命令写完之后从库里读回来时走这条路。
///
/// 刻意与 [`list_fragments`] 共用同两个转换函数：写完返回的那一条和列表里的
/// 同一条必须长得一模一样，否则「保存后卡片跳一下」这类问题会反复出现。
pub(crate) fn fragment_from_row(
    row: &FragmentRow,
    read_keys: Option<&LockboxReadKeys>,
) -> Result<Fragment, String> {
    if !row.lockbox {
        return Ok(plain_fragment(row));
    }

    let keys = read_keys.ok_or_else(|| "密匣未解锁，无法读取该片段。".to_string())?;
    decrypt_row(row, keys)
}

fn plain_fragment(row: &FragmentRow) -> Fragment {
    Fragment {
        id: row.id.clone(),
        content: row.content.clone().unwrap_or_default(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        // 明文笔记的空标签归入 inbox（对齐 `read_fragment`）。导入时已经做过
        // 一次，这里兜底防止其它写入路径漏掉。
        tags: if row.tags.is_empty() {
            vec!["inbox".to_string()]
        } else {
            row.tags.clone()
        },
        category: row.category.clone(),
        path: row.export_path.clone().unwrap_or_default(),
        ai_status: row.ai_status.clone(),
        archived: row.archived,
        lockbox: false,
        pinned: row.pinned,
    }
}

fn decrypt_row(row: &FragmentRow, keys: &LockboxReadKeys) -> Result<Fragment, String> {
    let cipher = row
        .cipher
        .as_ref()
        .ok_or_else(|| "密匣条目缺少密文".to_string())?;

    let encrypted = LockboxEncryptedFragment {
        version: cipher.version as u32,
        id: row.id.clone(),
        nonce: cipher.nonce.clone(),
        ciphertext: cipher.text.clone(),
        key_algorithm: cipher.key_alg.clone(),
        key_ciphertext: cipher.key_text.clone(),
    };
    let payload = crate::decrypt_lockbox_fragment(&encrypted, keys)?;
    let frontmatter = payload.frontmatter;

    Ok(Fragment {
        id: frontmatter.id,
        content: payload.body.trim_start_matches('\n').to_string(),
        // 元数据以密文内的 frontmatter 为准：库里那几列可能是未解锁导入时
        // 用文件 mtime 填的占位值。
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at,
        // 密匣**不做** inbox 回退，沿用 `lockbox_fragment_from_parts` 的行为。
        tags: frontmatter.tags,
        category: frontmatter.category,
        path: row.export_path.clone().unwrap_or_default(),
        ai_status: frontmatter.ai_status.unwrap_or_else(|| "none".to_string()),
        archived: row.archived,
        lockbox: true,
        pinned: frontmatter.pinned,
    })
}

/// 库里存在但磁盘上已消失的条目——用于诊断影子写是否漏掉了删除。
#[allow(dead_code)]
pub(crate) fn stale_paths(fragments: &[Fragment], vault: &Path) -> Vec<String> {
    let mut stale = Vec::new();
    let mut seen: HashMap<&str, ()> = HashMap::new();
    for fragment in fragments {
        if fragment.path.is_empty() || seen.insert(fragment.path.as_str(), ()).is_some() {
            continue;
        }
        if !vault.join(&fragment.path).exists() {
            stale.push(fragment.path.clone());
        }
    }
    stale
}

#[cfg(test)]
mod tests {
    use super::tests_support::*;
    use super::*;
    use crate::notes::import;
    use std::sync::{Arc, Mutex};

    /// Phase 3 的核心保证：切换读路径不改变任何一条笔记的内容。
    ///
    /// 逐字段比对文件路径与 DB 路径的产物——这两条路径将在一段时间内共存
    /// （DB 失败会自动回退），任何字段漂移都会表现为"同一条笔记时好时坏"。
    #[tokio::test]
    async fn db_path_matches_file_path_field_by_field() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        write_fragment_at(vault, "fragments/2026/07/a.md", "aa", &["会议", "工作"], "今天开会议程", false, &stamp(1));
        write_fragment_at(vault, "fragments/2026/07/b.md", "bbb", &[], "没有标签的一条", false, &stamp(2));
        write_fragment_at(vault, "fragments/2026/07/c.md", "cccc", &["置顶"], "被置顶的一条", true, &stamp(3));
        write_fragment_at(vault, "archive/2026/06/d.md", "ddddd", &["旧"], "归档的一条", false, &stamp(4));

        let runtime: crate::LockboxRuntime = Arc::new(Mutex::new(crate::LockboxSession::default()));
        let from_files = crate::list_fragments_in_vault(vault, &runtime).unwrap().fragments;

        let conn = open_test_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default())
            .await
            .unwrap();
        let from_db = list_fragments(&conn, vault, None)
            .await
            .unwrap();

        assert_eq!(
            from_files.len(),
            from_db.len(),
            "两条路径的条数必须一致：文件 {:?} vs DB {:?}",
            from_files.iter().map(|f| &f.id).collect::<Vec<_>>(),
            from_db.iter().map(|f| &f.id).collect::<Vec<_>>()
        );

        for (file, db) in from_files.iter().zip(from_db.iter()) {
            assert_eq!(file.id, db.id, "顺序或 id 不一致");
            assert_eq!(file.content, db.content, "[{}] 正文不一致", file.id);
            assert_eq!(file.tags, db.tags, "[{}] 标签不一致", file.id);
            assert_eq!(file.created_at, db.created_at, "[{}] 创建时间不一致", file.id);
            assert_eq!(file.updated_at, db.updated_at, "[{}] 更新时间不一致", file.id);
            assert_eq!(file.category, db.category, "[{}] 分类不一致", file.id);
            assert_eq!(file.path, db.path, "[{}] 路径不一致", file.id);
            assert_eq!(file.archived, db.archived, "[{}] 归档标记不一致", file.id);
            assert_eq!(file.pinned, db.pinned, "[{}] 置顶标记不一致", file.id);
            assert_eq!(file.lockbox, db.lockbox, "[{}] 密匣标记不一致", file.id);
            assert_eq!(file.ai_status, db.ai_status, "[{}] aiStatus 不一致", file.id);
        }
    }

    /// 置顶优先、其次按创建时间倒序——与文件路径的排序完全相同。
    #[tokio::test]
    async fn ordering_puts_pinned_first_then_newest() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment_at(vault, "fragments/old.md", "a", &["x"], "旧", false, &stamp(1));
        write_fragment_at(vault, "fragments/new.md", "bbbbbbb", &["x"], "新", false, &stamp(9));
        write_fragment_at(vault, "fragments/pin.md", "cc", &["x"], "置顶", true, &stamp(5));

        let conn = open_test_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        let fragments = list_fragments(&conn, vault, None).await.unwrap();

        assert!(fragments[0].pinned, "置顶的必须排在最前");
        let rest: Vec<&str> = fragments[1..].iter().map(|f| f.created_at.as_str()).collect();
        let mut sorted = rest.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(rest, sorted, "其余应按创建时间倒序");
    }

    /// 锁定态下密匣条目不能出现在列表里。
    #[tokio::test]
    async fn locked_lockbox_entries_are_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment_at(vault, "fragments/a.md", "a", &["x"], "明文", false, &stamp(1));
        let lockbox_dir = vault.join("lockbox/fragments");
        std::fs::create_dir_all(&lockbox_dir).unwrap();
        std::fs::write(
            lockbox_dir.join("s.shard"),
            r#"{"version":1,"id":"s","nonce":"N","ciphertext":"C"}"#,
        )
        .unwrap();

        let conn = open_test_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();

        // read_keys = None 即锁定态。
        let fragments = list_fragments(&conn, vault, None).await.unwrap();
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].id, "a");
        assert!(fragments.iter().all(|f| !f.lockbox));
    }

    /// 软删除的条目不出现在读路径里。
    #[tokio::test]
    async fn soft_deleted_entries_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment_at(vault, "fragments/a.md", "a", &["x"], "保留", false, &stamp(1));
        write_fragment_at(vault, "fragments/b.md", "b", &["x"], "删除", false, &stamp(2));

        let conn = open_test_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        repo::soft_delete(&conn, "b", "2026-07-26T12:00:00+08:00", "dev").await.unwrap();

        let fragments = list_fragments(&conn, vault, None).await.unwrap();
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].id, "a");
    }

}

/// 性能基准：对比"递归扫 Markdown"与"一条 SQL"两条读路径。
///
/// 默认不跑（会生成上千个文件，拖慢常规测试）。手动执行：
/// `cargo test --lib bench_read_paths -- --ignored --nocapture`
#[cfg(test)]
mod bench {
    use super::tests_support::*;
    use crate::notes::import;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const N: usize = 1000;

    #[tokio::test]
    #[ignore]
    async fn bench_read_paths() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        for i in 0..N {
            let body = format!(
                "第 {i} 条笔记。今天开会议程安排在下午，讨论 Rust 项目的日程规划。\
                 这里再写一些内容让正文长度接近真实笔记的量级，避免测出来的差距失真。"
            );
            write_fragment_at(
                vault,
                &format!("fragments/2026/07/n{i}.md"),
                &format!("id-{i:05}"),
                &["会议", "工作"],
                &body,
                false,
                &stamp(i as u32),
            );
        }

        let runtime: crate::LockboxRuntime = Arc::new(Mutex::new(crate::LockboxSession::default()));
        let started = Instant::now();
        let from_files = crate::list_fragments_in_vault(vault, &runtime).unwrap().fragments;
        let file_ms = started.elapsed().as_millis();

        let conn = open_test_conn().await;
        let started = Instant::now();
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        let import_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let from_db = super::list_fragments(&conn, vault, None)
            .await
            .unwrap();
        let db_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let hits = crate::notes::search::search(&conn, "会议", false, 50).await.unwrap();
        let search_ms = started.elapsed().as_millis();

        assert_eq!(from_files.len(), N);
        assert_eq!(from_db.len(), N);

        println!("\n=== {N} 条笔记的读路径对比 ===");
        println!("扫 Markdown（现状）: {file_ms:>5} ms");
        println!("一条 SQL（Phase 3）: {db_ms:>5} ms");
        println!("一次性导入        : {import_ms:>5} ms");
        println!("FTS5 中文搜索     : {search_ms:>5} ms（命中 {} 条）", hits.len());
    }
}

/// 测试与基准共用的构造工具。
#[cfg(test)]
mod tests_support {
    use libsql::Connection;
    use std::path::Path;

    pub(super) async fn open_test_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, crate::notes::schema::MIGRATIONS)
            .await
            .unwrap();
        conn
    }

    /// `created_at` 显式传入：相同时间戳下文件路径的顺序取决于目录遍历，
    /// 不确定，没法跟 DB 路径逐条比对。
    pub(super) fn write_fragment_at(
        vault: &Path,
        rel: &str,
        id: &str,
        tags: &[&str],
        body: &str,
        pinned: bool,
        created_at: &str,
    ) {
        let path = vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tags_yaml = if tags.is_empty() {
            "tags: []".to_string()
        } else {
            let items: Vec<String> = tags.iter().map(|t| format!("- {t}")).collect();
            format!("tags:\n{}", items.join("\n"))
        };
        let pinned_yaml = if pinned { "\npinned: true" } else { "" };
        let text = format!(
            "---\nid: {id}\ncreated_at: {created_at}\n\
             updated_at: {created_at}\n{tags_yaml}\ncategory: null\n\
             ai_status: none\nsource: desktop{pinned_yaml}\n---\n\n{body}\n"
        );
        std::fs::write(path, text).unwrap();
    }

    /// 按序号生成互不相同的时间戳。
    pub(super) fn stamp(nth: u32) -> String {
        format!("2026-07-26T10:{:02}:00+08:00", nth % 60)
    }
}
