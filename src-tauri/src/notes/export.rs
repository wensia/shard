//! 把笔记库导出成 Markdown / 密匣文件，以及校验导出是否无损。
//!
//! # 这是 Phase 4 的前置门槛
//!
//! 写路径反转（库成为真相源、Markdown 降级为产物）之前，必须先证明「库里的
//! 内容能被完整还原成文件」。[`verify`] 就是那道闸：它把导出结果重新解析一遍
//! 与库比对，只有语义完全一致才允许继续。
//!
//! # 两类差异要分开看
//!
//! - **语义不一致**：导出的文件重新解析后与库内容不符。这是真正的缺陷，必须为零。
//! - **字节差异**：磁盘上的现有文件与导出结果不同。多数是 frontmatter 规范化
//!   （手工创建的文件缺 `category: null` 之类的字段，导出时补齐），无害但要如实
//!   报告——把它和真正的数据损坏混为一谈，就等于没有校验。
//!
//! # 密匣
//!
//! 导出的是**密文**，不需要解锁、也不做任何加解密——与导入完全对称。
//! 绝不能因为「导出成 Markdown」就把明文写进 vault。

use std::path::{Path, PathBuf};
use std::time::Instant;

use libsql::Connection;
use serde::Serialize;

use super::model::FragmentRow;
use super::repo;
use crate::{FragmentFrontmatter, LockboxEncryptedFragment};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportMode {
    /// 全量重写所有片段文件。
    Full,
    /// 只写 `export_dirty = 1` 的条目。
    Dirty,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportReport {
    pub exported: usize,
    pub skipped: usize,
    pub failed: Vec<ExportFailure>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportFailure {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyReport {
    pub checked: usize,
    /// 重新解析后与库内容不符——真正的缺陷，必须为空。
    pub mismatched: Vec<VerifyIssue>,
    /// 库里有记录但磁盘上没有对应文件。
    pub missing: Vec<String>,
    /// 磁盘内容与导出结果字节不同（通常是 frontmatter 规范化）。
    pub byte_differences: Vec<String>,
    /// 库里没有 `export_path`，无从校验。
    pub unmapped: Vec<String>,
    /// 是否达到「库可作为真相源」的门槛。前端直接读这个结论，
    /// 不必自己拼三个数组的判断。
    pub lossless: bool,
}

impl VerifyReport {
    /// 语义零差异、无缺失、无未映射。注意**不看** `byte_differences`：
    /// 磁盘被外部改动不代表库还原不出内容。
    pub(crate) fn is_lossless(&self) -> bool {
        self.mismatched.is_empty() && self.missing.is_empty() && self.unmapped.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyIssue {
    pub id: String,
    pub field: String,
    pub detail: String,
}

/// 把库里的片段写回文件。
pub(crate) async fn run(
    conn: &Connection,
    vault: &Path,
    mode: ExportMode,
) -> Result<ExportReport, String> {
    let started = Instant::now();
    let rows = repo::list_all(conn).await?;
    let mut report = ExportReport::default();

    let mut written: Vec<String> = Vec::new();
    for row in rows {
        if mode == ExportMode::Dirty && !row.export_dirty {
            report.skipped += 1;
            continue;
        }

        match render_and_write(vault, &row) {
            Ok(()) => {
                report.exported += 1;
                written.push(row.id.clone());
            }
            Err(reason) => report.failed.push(ExportFailure {
                id: row.id.clone(),
                reason,
            }),
        }
    }

    // 成功写盘的才清脏标记；失败的留着下次重试。
    for id in &written {
        repo::mark_exported(conn, id).await?;
    }

    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 校验磁盘上的产物能否无损还原库内容。
pub(crate) async fn verify(conn: &Connection, vault: &Path) -> Result<VerifyReport, String> {
    let rows = repo::list_all(conn).await?;
    let mut report = VerifyReport::default();

    for row in rows {
        report.checked += 1;

        let Some(rel) = row.export_path.clone().filter(|p| !p.is_empty()) else {
            report.unmapped.push(row.id.clone());
            continue;
        };
        let path = vault.join(&rel);
        if !path.exists() {
            report.missing.push(rel);
            continue;
        }

        let rendered = match render(&row) {
            Ok(text) => text,
            Err(reason) => {
                report.mismatched.push(VerifyIssue {
                    id: row.id.clone(),
                    field: "render".into(),
                    detail: reason,
                });
                continue;
            }
        };

        let on_disk = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if on_disk != rendered {
            report.byte_differences.push(rel.clone());
        }

        // 关键校验：把渲染结果重新解析一遍，看能否还原出库里的内容。
        // 只比字节是不够的——字节相同不代表语义正确，字节不同也未必是损坏。
        if let Err(issue) = round_trip(&row, &rendered) {
            report.mismatched.push(issue);
        }
    }

    report.lossless = report.is_lossless();
    Ok(report)
}

/// 渲染一条并原子写入。
fn render_and_write(vault: &Path, row: &FragmentRow) -> Result<(), String> {
    let rel = row
        .export_path
        .clone()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "缺少导出路径".to_string())?;
    let path: PathBuf = vault.join(rel);
    let text = render(row)?;
    // 用原子写：直接 fs::write 在写到一半掉电时会留下截断的文件，
    // 而这些文件在 Phase 4 之后就是用户唯一的人类可读备份。
    crate::write_text_atomically(&path, &text)
}

/// 渲染一条的完整文件文本。
fn render(row: &FragmentRow) -> Result<String, String> {
    if row.lockbox {
        render_lockbox(row)
    } else {
        crate::render_fragment_text(&frontmatter_of(row), row.content.as_deref().unwrap_or(""))
    }
}

fn render_lockbox(row: &FragmentRow) -> Result<String, String> {
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
    serde_json::to_string_pretty(&encrypted).map_err(|error| error.to_string())
}

fn frontmatter_of(row: &FragmentRow) -> FragmentFrontmatter {
    FragmentFrontmatter {
        id: row.id.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        tags: row.tags.clone(),
        category: row.category.clone(),
        ai_status: Some(row.ai_status.clone()),
        pinned: row.pinned,
        source: row.source.clone(),
    }
}

/// 把渲染结果重新解析，逐字段比对回库内容。
fn round_trip(row: &FragmentRow, rendered: &str) -> Result<(), VerifyIssue> {
    let issue = |field: &str, detail: String| VerifyIssue {
        id: row.id.clone(),
        field: field.to_string(),
        detail,
    };

    if row.lockbox {
        let parsed: LockboxEncryptedFragment =
            serde_json::from_str(rendered).map_err(|e| issue("lockbox", e.to_string()))?;
        let cipher = row
            .cipher
            .as_ref()
            .ok_or_else(|| issue("cipher", "缺少密文".into()))?;
        if parsed.ciphertext != cipher.text {
            return Err(issue("ciphertext", "密文不一致".into()));
        }
        if parsed.nonce != cipher.nonce {
            return Err(issue("nonce", "nonce 不一致".into()));
        }
        if parsed.id != row.id {
            return Err(issue("id", format!("{} != {}", parsed.id, row.id)));
        }
        return Ok(());
    }

    let (frontmatter, body) =
        crate::parse_fragment_text(rendered).map_err(|e| issue("frontmatter", e))?;

    let expected_body = row.content.as_deref().unwrap_or("");
    let actual_body = body.trim_start_matches('\n');
    // 渲染时会 trim_end 正文，比对也要用同样口径，否则末尾空白会造成假警报。
    if actual_body.trim_end() != expected_body.trim_end() {
        return Err(issue(
            "content",
            format!(
                "正文不一致（库 {} 字节，还原 {} 字节）",
                expected_body.trim_end().len(),
                actual_body.trim_end().len()
            ),
        ));
    }
    if frontmatter.id != row.id {
        return Err(issue("id", format!("{} != {}", frontmatter.id, row.id)));
    }
    if frontmatter.tags != row.tags {
        return Err(issue(
            "tags",
            format!("{:?} != {:?}", frontmatter.tags, row.tags),
        ));
    }
    if frontmatter.created_at != row.created_at {
        return Err(issue("created_at", frontmatter.created_at));
    }
    if frontmatter.updated_at != row.updated_at {
        return Err(issue("updated_at", frontmatter.updated_at));
    }
    if frontmatter.category != row.category {
        return Err(issue("category", format!("{:?}", frontmatter.category)));
    }
    if frontmatter.pinned != row.pinned {
        return Err(issue("pinned", format!("{}", frontmatter.pinned)));
    }
    if frontmatter.source != row.source {
        return Err(issue("source", frontmatter.source));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::{import, schema};
    use libsql::Connection;

    async fn open_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, schema::MIGRATIONS).await.unwrap();
        conn
    }

    /// 用 Shard 自己的写入函数造文件，保证格式与线上一致。
    fn seed(vault: &Path, rel: &str, id: &str, tags: &[&str], body: &str, pinned: bool) {
        let path = vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let frontmatter = crate::FragmentFrontmatter {
            id: id.to_string(),
            created_at: "2026-07-26T10:00:00.123456+08:00".to_string(),
            updated_at: "2026-07-26T11:00:00.654321+08:00".to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            category: None,
            ai_status: Some("none".to_string()),
            pinned,
            source: "desktop".to_string(),
        };
        crate::write_fragment_file(&path, &frontmatter, body).unwrap();
    }

    /// Phase 4 的门槛：导入再导出，必须与原文**逐字节相同**。
    ///
    /// 这直接决定了写路径能否反转——如果导出会改变文件内容，那么"库为真相源、
    /// Markdown 为产物"就意味着每次导出都在污染用户的 Git 历史。
    #[tokio::test]
    async fn export_reproduces_original_files_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/2026/07/a.md", "a", &["会议", "工作"], "今天开会议程\n第二行", false);
        seed(vault, "fragments/2026/07/b.md", "b", &["置顶"], "被置顶的一条", true);
        seed(vault, "archive/2026/06/c.md", "c", &["旧"], "归档的一条", false);

        let originals: Vec<(PathBuf, String)> = ["fragments/2026/07/a.md", "fragments/2026/07/b.md", "archive/2026/06/c.md"]
            .iter()
            .map(|rel| {
                let p = vault.join(rel);
                let text = std::fs::read_to_string(&p).unwrap();
                (p, text)
            })
            .collect();

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();

        // 先把文件删光，确保导出是真的从库里重建而不是"什么都没做"。
        for (path, _) in &originals {
            std::fs::remove_file(path).unwrap();
        }

        let report = run(&conn, vault, ExportMode::Full).await.unwrap();
        assert_eq!(report.exported, 3);
        assert!(report.failed.is_empty(), "{:?}", report.failed);

        for (path, original) in &originals {
            let rebuilt = std::fs::read_to_string(path)
                .unwrap_or_else(|_| panic!("{} 未被重建", path.display()));
            assert_eq!(&rebuilt, original, "{} 与原文不一致", path.display());
        }
    }

    /// verify 必须判定为无损。
    #[tokio::test]
    async fn verify_reports_lossless_after_export() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/a.md", "a", &["x"], "内容一", false);
        seed(vault, "fragments/b.md", "b", &[], "内容二", false);

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert_eq!(report.checked, 2);
        assert!(
            report.is_lossless(),
            "校验应无损：mismatched={:?} missing={:?} unmapped={:?}",
            report.mismatched, report.missing, report.unmapped
        );
        assert!(
            report.byte_differences.is_empty(),
            "Shard 自己写的文件不该有字节差异：{:?}",
            report.byte_differences
        );
    }

    /// 库内容被改动后，导出会把改动写回文件，且仍然无损。
    #[tokio::test]
    async fn edits_in_db_flow_back_to_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/a.md", "a", &["x"], "旧内容", false);

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();

        let mut row = repo::get(&conn, "a").await.unwrap().unwrap();
        row.content = Some("改过的内容\n".to_string());
        let note = crate::notes::model::NoteWrite {
            id: row.id.clone(),
            content: row.content.clone(),
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
            tags: vec!["y".to_string()],
            category: None,
            ai_status: row.ai_status.clone(),
            source: row.source.clone(),
            archived: false,
            pinned: true,
            cipher: None,
            export_path: row.export_path.clone(),
        };
        repo::upsert(&conn, &note).await.unwrap();

        run(&conn, vault, ExportMode::Full).await.unwrap();

        let text = std::fs::read_to_string(vault.join("fragments/a.md")).unwrap();
        assert!(text.contains("改过的内容"), "库里的改动应写回文件");
        assert!(text.contains("pinned: true"));
        assert!(text.contains("- y"));
        assert!(verify(&conn, vault).await.unwrap().is_lossless());
    }

    /// 密匣导出的是密文，不需要解锁，也绝不能写出明文。
    #[tokio::test]
    async fn lockbox_exports_ciphertext_without_unlocking() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let lockbox_dir = vault.join("lockbox/fragments");
        std::fs::create_dir_all(&lockbox_dir).unwrap();
        let original = r#"{
  "version": 1,
  "id": "s1",
  "nonce": "NONCE",
  "ciphertext": "CIPHERTEXT",
  "key_algorithm": "rsa-oaep-sha256",
  "key_ciphertext": "WRAPPED"
}"#;
        std::fs::write(lockbox_dir.join("s.shard"), original).unwrap();

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        std::fs::remove_file(lockbox_dir.join("s.shard")).unwrap();

        run(&conn, vault, ExportMode::Full).await.unwrap();

        let rebuilt = std::fs::read_to_string(lockbox_dir.join("s.shard")).unwrap();
        assert_eq!(rebuilt, original, "密匣文件应逐字节还原");
        assert!(verify(&conn, vault).await.unwrap().is_lossless());
    }

    /// Dirty 模式只写脏条目，避免每次都全量重写整个 vault。
    #[tokio::test]
    async fn dirty_mode_skips_clean_rows() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/a.md", "a", &["x"], "内容", false);

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();

        let first = run(&conn, vault, ExportMode::Dirty).await.unwrap();
        assert_eq!(first.exported, 1, "导入后应是脏的");

        let second = run(&conn, vault, ExportMode::Dirty).await.unwrap();
        assert_eq!(second.exported, 0, "已导出的不该重复写");
        assert_eq!(second.skipped, 1);
    }

    /// 磁盘文件被外部改动时，verify 要如实报告字节差异但不误判为损坏。
    #[tokio::test]
    async fn verify_flags_external_edits_as_byte_difference() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/a.md", "a", &["x"], "内容", false);

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();

        // 模拟用户用外部编辑器改了文件。
        let path = vault.join("fragments/a.md");
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("内容", "被外部改过")).unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert_eq!(report.byte_differences.len(), 1, "应报告磁盘与库不一致");
        assert!(report.is_lossless(), "但这不是数据损坏——库本身仍能无损还原");
    }

    #[tokio::test]
    async fn verify_reports_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        seed(vault, "fragments/a.md", "a", &["x"], "内容", false);

        let conn = open_conn().await;
        import::run(&conn, vault, &import::ImportOptions::default()).await.unwrap();
        std::fs::remove_file(vault.join("fragments/a.md")).unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert_eq!(report.missing.len(), 1);
        assert!(!report.is_lossless(), "文件缺失必须判定为未达门槛");
    }
}
