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
    /// 写出的思维导图数量。
    pub maps: usize,
    /// 从缓存复制回 `assets/` 的附件数量。
    pub attachments: usize,
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

/// 把库里的全部数据写回文件：笔记、密匣、思维导图、图片附件。
pub(crate) async fn run(
    conn: &Connection,
    vault: &Path,
    mode: ExportMode,
) -> Result<ExportReport, String> {
    let started = Instant::now();
    let mut report = ExportReport::default();

    // 附件先导出：正文里的 `shard-attachment:` 引用要靠这份映射才能还原成
    // 相对路径。顺序反了就会写出一堆指向不存在文件的图片引用。
    let attachments = export_attachments(conn, vault, &mut report).await?;

    let mut written: Vec<(String, String)> = Vec::new();
    for row in repo::list_all(conn).await? {
        if mode == ExportMode::Dirty && !row.export_dirty {
            report.skipped += 1;
            continue;
        }

        let rel = export_path_for(&row);
        match render_and_write(vault, &row, &rel, &attachments) {
            Ok(()) => {
                // 归档会改变产物该落的目录。旧位置那一份必须清掉，否则同一条
                // 笔记会在 fragments/ 和 archive/ 各留一份，下次导入变两条。
                if let Some(previous) = row.export_path.as_deref() {
                    if previous != rel && !previous.is_empty() {
                        let _ = std::fs::remove_file(vault.join(previous));
                    }
                }
                report.exported += 1;
                written.push((row.id.clone(), rel));
            }
            Err(reason) => report.failed.push(ExportFailure {
                id: row.id.clone(),
                reason,
            }),
        }
    }

    // 成功写盘的才清脏标记；失败的留着下次重试。
    for (id, rel) in &written {
        repo::mark_exported_at(conn, id, rel).await?;
    }

    export_maps(conn, vault, mode, &mut report).await?;

    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 把附件字节从缓存目录复制回 `assets/`，返回 hash → 相对路径的映射。
async fn export_attachments(
    conn: &Connection,
    vault: &Path,
    report: &mut ExportReport,
) -> Result<AttachmentPaths, String> {
    let mut paths = AttachmentPaths::new();

    for attachment in super::attachments::list_all(conn).await? {
        let rel = super::attachments::export_rel_path(&attachment.hash, &attachment.mime_type);
        let source = vault.join(super::attachments::cache_rel_path(&attachment.hash));
        let target = vault.join(&rel);

        // 缓存里没有字节说明这台设备还没拉过这张图。记为失败但不阻断——
        // 其余内容仍然应该导出成功。
        if !source.exists() {
            report.failed.push(ExportFailure {
                id: attachment.hash.clone(),
                reason: "附件字节不在本地缓存中".to_string(),
            });
            continue;
        }
        // 文件名就是内容摘要，已存在即已是正确内容。
        if !target.exists() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            if let Err(error) = std::fs::copy(&source, &target) {
                report.failed.push(ExportFailure {
                    id: attachment.hash.clone(),
                    reason: error.to_string(),
                });
                continue;
            }
        }

        paths.insert(attachment.hash, rel);
        report.attachments += 1;
    }

    Ok(paths)
}

async fn export_maps(
    conn: &Connection,
    vault: &Path,
    mode: ExportMode,
    report: &mut ExportReport,
) -> Result<(), String> {
    for row in super::maps::list(conn).await? {
        if mode == ExportMode::Dirty && !row.export_dirty {
            report.skipped += 1;
            continue;
        }

        let Some(rel) = row.export_path.clone().filter(|path| !path.is_empty()) else {
            report.failed.push(ExportFailure {
                id: row.id.clone(),
                reason: "缺少导出路径".to_string(),
            });
            continue;
        };

        // doc_json 已经是 canonical 形式，原样写出即可——重新序列化一遍
        // 反而可能因为字段顺序或缩进变化产生假 diff。
        match crate::write_text_atomically(&vault.join(&rel), &row.doc_json) {
            Ok(()) => {
                super::maps::mark_exported(conn, &row.id).await?;
                report.maps += 1;
            }
            Err(reason) => report.failed.push(ExportFailure {
                id: row.id.clone(),
                reason,
            }),
        }
    }
    Ok(())
}

type AttachmentPaths = std::collections::HashMap<String, String>;

/// 一条笔记的产物该写到哪。
///
/// 沿用库里已有的 `export_path`，**除非**它与当前的归档状态不符——归档现在是
/// 库里的一个标记，产物落在哪个目录要由它决定，而不是反过来。没有记录过路径
/// 的（写路径反转后新建的笔记）按 id 与创建时间算一个。
fn export_path_for(row: &FragmentRow) -> String {
    let root = match (row.lockbox, row.archived) {
        (false, false) => "fragments",
        (false, true) => "archive",
        (true, false) => "lockbox/fragments",
        (true, true) => "lockbox/archive",
    };

    if let Some(existing) = row.export_path.as_deref().filter(|path| !path.is_empty()) {
        if existing.starts_with(&format!("{root}/")) {
            return existing.to_string();
        }
    }

    let stamp = chrono::DateTime::parse_from_rfc3339(&row.created_at)
        .map(|value| value.with_timezone(&chrono::Local))
        .unwrap_or_else(|_| chrono::Local::now());
    let extension = if row.lockbox { "shard" } else { "md" };

    format!(
        "{root}/{}/{}/{}.{extension}",
        stamp.format("%Y"),
        stamp.format("%m"),
        row.id
    )
}

/// 校验磁盘上的产物能否无损还原库内容。
///
/// 覆盖全部四类数据。只查笔记是不够的——一份漏掉导图和附件的校验报告说
/// 「无损」，会让人以为可以放心地只留着导出产物。
pub(crate) async fn verify(conn: &Connection, vault: &Path) -> Result<VerifyReport, String> {
    let mut report = VerifyReport::default();
    let attachments = verify_attachments(conn, vault, &mut report).await?;

    for row in repo::list_all(conn).await? {
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

        let rendered = match render(&row, &attachments) {
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
        if let Err(issue) = round_trip(&row, &rendered, &attachments) {
            report.mismatched.push(issue);
        }
    }

    verify_maps(conn, vault, &mut report).await?;

    report.lossless = report.is_lossless();
    Ok(report)
}

/// 校验 `assets/` 下的附件，返回 hash → 相对路径映射供正文比对使用。
///
/// **重算 sha256** 而不是只看文件在不在：附件是内容寻址的，文件名就是它应有
/// 的摘要，比对不上就说明这份产物已经不是库里那张图了。附件数量有限且校验是
/// 手动触发的，这点开销换一个确定的答案很划算。
async fn verify_attachments(
    conn: &Connection,
    vault: &Path,
    report: &mut VerifyReport,
) -> Result<AttachmentPaths, String> {
    let mut paths = AttachmentPaths::new();

    for attachment in super::attachments::list_all(conn).await? {
        report.checked += 1;
        let rel = super::attachments::export_rel_path(&attachment.hash, &attachment.mime_type);
        let path = vault.join(&rel);

        if !path.exists() {
            report.missing.push(rel);
            continue;
        }

        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        if crate::hash_bytes(&bytes) != attachment.hash {
            report.mismatched.push(VerifyIssue {
                id: attachment.hash.clone(),
                field: "attachment".into(),
                detail: format!("{rel} 的内容与其摘要不符"),
            });
            continue;
        }

        paths.insert(attachment.hash, rel);
    }

    Ok(paths)
}

async fn verify_maps(
    conn: &Connection,
    vault: &Path,
    report: &mut VerifyReport,
) -> Result<(), String> {
    for row in super::maps::list(conn).await? {
        report.checked += 1;

        let Some(rel) = row.export_path.clone().filter(|path| !path.is_empty()) else {
            report.unmapped.push(row.id.clone());
            continue;
        };
        let path = vault.join(&rel);
        if !path.exists() {
            report.missing.push(rel);
            continue;
        }

        let on_disk = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if on_disk != row.doc_json {
            report.byte_differences.push(rel.clone());
        }

        // 导图的语义校验就是比对 doc_hash：整档存储、canonical 序列化，
        // 内容摘要一致就等于文档一致。
        if crate::hash_text(&on_disk) != row.doc_hash {
            report.mismatched.push(VerifyIssue {
                id: row.id.clone(),
                field: "doc_hash".into(),
                detail: format!("{rel} 的内容与库中摘要不符"),
            });
        }
    }
    Ok(())
}

/// 渲染一条并原子写入。
fn render_and_write(
    vault: &Path,
    row: &FragmentRow,
    rel: &str,
    attachments: &AttachmentPaths,
) -> Result<(), String> {
    let path: PathBuf = vault.join(rel);
    let text = render(row, attachments)?;
    // 用原子写：直接 fs::write 在写到一半掉电时会留下截断的文件，
    // 而这些文件现在就是用户唯一的人类可读备份。
    crate::write_text_atomically(&path, &text)
}

/// 渲染一条的完整文件文本。
fn render(row: &FragmentRow, attachments: &AttachmentPaths) -> Result<String, String> {
    if row.lockbox {
        return render_lockbox(row);
    }

    crate::render_fragment_text(&frontmatter_of(row), &export_body(row, attachments))
}

/// 导出用的正文：附件引用从 hash 还原成 `assets/` 相对路径。
///
/// 校验侧必须调用同一个函数，否则重新解析出来的正文与库里的 hash 引用永远
/// 对不上，每条带图的笔记都会被误判成损坏。
fn export_body(row: &FragmentRow, attachments: &AttachmentPaths) -> String {
    let content = row.content.as_deref().unwrap_or("");
    super::attachments::restore_asset_links(content, attachments)
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
fn round_trip(
    row: &FragmentRow,
    rendered: &str,
    attachments: &AttachmentPaths,
) -> Result<(), VerifyIssue> {
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

    // 用导出口径的正文比对：库里存的是 hash 引用，写出去的是相对路径，
    // 拿原始 content 比会让每条带图的笔记都误判成损坏。
    let expected = export_body(row, attachments);
    let expected_body = expected.as_str();
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

    /// 在库里登记一个附件，并把字节放进内容寻址的缓存目录。
    async fn seed_attachment(conn: &Connection, vault: &Path, bytes: &[u8]) -> String {
        let hash = crate::hash_bytes(bytes);
        let cached = vault.join(super::super::attachments::cache_rel_path(&hash));
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, bytes).unwrap();

        super::super::attachments::put(
            conn,
            &super::super::attachments::AttachmentRow {
                hash: hash.clone(),
                mime_type: "image/png".into(),
                byte_size: bytes.len() as i64,
                created_at: "2026-07-26T10:00:00+08:00".into(),
            },
        )
        .await
        .unwrap();
        hash
    }

    fn db_note(id: &str, content: &str) -> crate::notes::model::NoteWrite {
        crate::notes::model::NoteWrite {
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

    /// 写路径反转后新建的笔记没有 export_path，导出必须能自己算出落点——
    /// 否则它们会全部堆进 `unmapped`，`lossless` 永远为 false。
    #[tokio::test]
    async fn exports_notes_that_never_had_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;
        repo::write(&conn, &db_note("fresh", "刚写的"), None, "dev-a")
            .await
            .unwrap();

        let report = run(&conn, vault, ExportMode::Full).await.unwrap();
        assert_eq!(report.exported, 1);
        assert!(
            vault.join("fragments/2026/07/fresh.md").exists(),
            "应按 id 与创建时间算出路径"
        );
        assert!(verify(&conn, vault).await.unwrap().is_lossless());
    }

    /// 归档后产物要换到 archive/，且**旧位置那一份必须消失**——留着的话
    /// 下次导入会把同一条笔记读成两条。
    #[tokio::test]
    async fn archiving_moves_the_artifact_and_removes_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;
        repo::write(&conn, &db_note("a", "内容"), None, "dev-a")
            .await
            .unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();
        assert!(vault.join("fragments/2026/07/a.md").exists());

        // 与真实写命令一样从当前行重建写入参数：export_path 要带着走，
        // 否则库就忘了产物原先在哪，旧文件永远删不掉。
        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        let archived = crate::notes::model::NoteWrite {
            archived: true,
            ..crate::notes::model::NoteWrite::from_row(&row)
        };
        repo::write(&conn, &archived, Some(row.revision), "dev-a")
            .await
            .unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();

        assert!(vault.join("archive/2026/07/a.md").exists(), "应写到归档目录");
        assert!(
            !vault.join("fragments/2026/07/a.md").exists(),
            "旧位置的产物必须被清掉"
        );
        assert!(verify(&conn, vault).await.unwrap().is_lossless());
    }

    /// 附件往返：库里存 hash 引用，导出的 Markdown 里必须是能双击打开的
    /// 相对路径，而校验仍要判定无损。
    #[tokio::test]
    async fn attachments_round_trip_through_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        let bytes = b"\x89PNG\r\n\x1a\nphoto".to_vec();
        let hash = seed_attachment(&conn, vault, &bytes).await;
        repo::write(
            &conn,
            &db_note("a", &format!("看图 ![截图](shard-attachment:{hash})")),
            None,
            "dev-a",
        )
        .await
        .unwrap();

        let report = run(&conn, vault, ExportMode::Full).await.unwrap();
        assert_eq!(report.attachments, 1);

        let exported_image = vault.join(format!("assets/{}/{hash}.png", &hash[..2]));
        assert_eq!(std::fs::read(&exported_image).unwrap(), bytes, "字节应还原");

        let text = std::fs::read_to_string(vault.join("fragments/2026/07/a.md")).unwrap();
        assert!(
            text.contains(&format!("assets/{}/{hash}.png", &hash[..2])),
            "正文引用应还原成相对路径：{text}"
        );
        assert!(
            !text.contains("shard-attachment:"),
            "导出的文件里不该留下只有 Shard 认识的协议"
        );

        let verified = verify(&conn, vault).await.unwrap();
        assert!(
            verified.is_lossless(),
            "带图的笔记不该被误判：mismatched={:?} missing={:?}",
            verified.mismatched, verified.missing
        );
    }

    /// 附件是内容寻址的：产物被换成别的图片，校验必须发现。
    #[tokio::test]
    async fn verify_detects_tampered_attachment_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        let hash = seed_attachment(&conn, vault, b"\x89PNG\r\n\x1a\noriginal").await;
        repo::write(&conn, &db_note("a", "只有文字"), None, "dev-a")
            .await
            .unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();

        std::fs::write(
            vault.join(format!("assets/{}/{hash}.png", &hash[..2])),
            b"\x89PNG\r\n\x1a\nsomething else",
        )
        .unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert!(!report.is_lossless(), "内容与摘要不符必须判定为损坏");
        assert_eq!(report.mismatched[0].field, "attachment");
    }

    /// 缓存里没有字节时如实报告，但不该拖垮其余内容的导出。
    #[tokio::test]
    async fn missing_attachment_bytes_do_not_block_other_exports() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        super::super::attachments::put(
            &conn,
            &super::super::attachments::AttachmentRow {
                hash: "f".repeat(64),
                mime_type: "image/png".into(),
                byte_size: 10,
                created_at: "2026-07-26T10:00:00+08:00".into(),
            },
        )
        .await
        .unwrap();
        repo::write(&conn, &db_note("a", "文字"), None, "dev-a")
            .await
            .unwrap();

        let report = run(&conn, vault, ExportMode::Full).await.unwrap();
        assert_eq!(report.exported, 1, "笔记仍应导出");
        assert_eq!(report.failed.len(), 1, "但要如实报告缺失的附件");
    }

    /// 导图整档写出，校验按 doc_hash 比对。
    #[tokio::test]
    async fn maps_export_and_verify() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        let doc_json = "{\n  \"id\": \"m1\",\n  \"title\": \"计划\"\n}\n";
        super::super::maps::insert(
            &conn,
            &super::super::maps::MapRow {
                id: "m1".into(),
                title: "计划".into(),
                doc_json: doc_json.into(),
                doc_hash: crate::hash_text(doc_json),
                revision: 1,
                node_count: 1,
                created_at: "2026-07-26T10:00:00+08:00".into(),
                updated_at: "2026-07-26T10:00:00+08:00".into(),
                export_path: Some("maps/2026/07/m1.shardmap.json".into()),
                export_dirty: true,
                synced_revision: None,
            },
        )
        .await
        .unwrap();

        let report = run(&conn, vault, ExportMode::Full).await.unwrap();
        assert_eq!(report.maps, 1);
        assert_eq!(
            std::fs::read_to_string(vault.join("maps/2026/07/m1.shardmap.json")).unwrap(),
            doc_json,
            "canonical JSON 应原样写出"
        );
        assert!(verify(&conn, vault).await.unwrap().is_lossless());
    }

    /// 导图产物被改动后必须判定为损坏——它不像 Markdown 那样有"规范化差异"
    /// 这种无害情况，内容变了就是变了。
    #[tokio::test]
    async fn verify_detects_edited_map_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        let doc_json = "{\n  \"id\": \"m1\"\n}\n";
        super::super::maps::insert(
            &conn,
            &super::super::maps::MapRow {
                id: "m1".into(),
                title: "计划".into(),
                doc_json: doc_json.into(),
                doc_hash: crate::hash_text(doc_json),
                revision: 1,
                node_count: 1,
                created_at: "2026-07-26T10:00:00+08:00".into(),
                updated_at: "2026-07-26T10:00:00+08:00".into(),
                export_path: Some("maps/m1.shardmap.json".into()),
                export_dirty: true,
                synced_revision: None,
            },
        )
        .await
        .unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();

        std::fs::write(vault.join("maps/m1.shardmap.json"), "{\n  \"id\": \"tampered\"\n}\n")
            .unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert!(!report.is_lossless());
        assert_eq!(report.mismatched[0].field, "doc_hash");
    }

    /// 导图产物缺失也要算进 missing——校验说无损时，四类数据都得真的在盘上。
    #[tokio::test]
    async fn verify_reports_missing_map_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let conn = open_conn().await;

        let doc_json = "{}\n";
        super::super::maps::insert(
            &conn,
            &super::super::maps::MapRow {
                id: "m1".into(),
                title: "计划".into(),
                doc_json: doc_json.into(),
                doc_hash: crate::hash_text(doc_json),
                revision: 1,
                node_count: 1,
                created_at: "2026-07-26T10:00:00+08:00".into(),
                updated_at: "2026-07-26T10:00:00+08:00".into(),
                export_path: Some("maps/m1.shardmap.json".into()),
                export_dirty: true,
                synced_revision: None,
            },
        )
        .await
        .unwrap();
        run(&conn, vault, ExportMode::Full).await.unwrap();
        std::fs::remove_file(vault.join("maps/m1.shardmap.json")).unwrap();

        let report = verify(&conn, vault).await.unwrap();
        assert_eq!(report.missing.len(), 1);
        assert!(!report.is_lossless());
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
