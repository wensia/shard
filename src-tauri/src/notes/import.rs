//! 一次性把 vault 里的 Markdown / 密匣文件导入笔记库。
//!
//! # 幂等
//!
//! 重复导入是安全操作。判定顺序是：
//! 1. `import_ledger` 里同路径同 hash → 跳过（未改动）；
//! 2. 否则按 **frontmatter 里的 id**（不是路径）upsert。
//!
//! 用 id 而不是路径做主键判定，是因为归档会把文件挪目录（`archive_fragment`），
//! 重命名也会改路径——按路径判定会把同一条笔记导成两条。
//!
//! # 失败隔离
//!
//! 一个 frontmatter 损坏的文件不该让整批导入失败。每条独立处理，坏文件计入
//! `failed` 后继续。`parse_fragment_text` 对缺失或未闭合的 frontmatter 会直接
//! 报错，而 frontmatter 是用户可手工编辑的，损坏并不罕见。
//!
//! # 密匣
//!
//! **不解密、原样搬密文**，因此导入无需输入密匣密码，安全模型完全不变。
//! 代价是未解锁时读不到密文里的元数据（创建时间、标签），这些列先用文件
//! mtime 占位，条目计入 `lockbox_metadata_pending`，待解锁后补齐。

use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{DateTime, Local};
use libsql::Connection;
use serde::Serialize;

use super::model::{CipherEnvelope, NoteWrite};
use super::repo;

/// 每批读取并解析的文件数。分批是为了让大 vault 的内存占用可控——
/// 一次性把几千条笔记的正文全读进内存没有必要。
const BATCH_SIZE: usize = 200;

#[derive(Debug, Clone)]
pub(crate) struct ImportOptions {
    /// 只扫描与解析，不写库。UI 应当先跑一次 dry run 让用户确认。
    pub dry_run: bool,
    pub include_lockbox: bool,
    /// 关掉可以只增量扫密匣目录。明文转入密匣后要把新密文同步进来，
    /// 为此重读整个 vault 算 hash 是不必要的开销。
    pub include_plaintext: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            dry_run: false,
            include_lockbox: true,
            include_plaintext: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportReport {
    pub scanned: usize,
    pub imported: usize,
    pub skipped_unchanged: usize,
    pub failed: Vec<ImportFailure>,
    pub warnings: Vec<String>,
    /// 密匣条目中元数据仍待补齐的数量（未解锁导入的必然结果）。
    pub lockbox_metadata_pending: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportFailure {
    pub path: String,
    pub reason: String,
}

/// 解析完成、待写库的一条。
struct Parsed {
    /// 非 None 时这是一份思维导图，走 shard_maps 表而不是 fragments。
    map: Option<super::maps::MapRow>,
    note: NoteWrite,
    source_kind: &'static str,
    source_path: String,
    source_hash: String,
    metadata_pending: bool,
}

/// 执行导入。`conn` 已就绪（含 PRAGMA 与 schema）。
pub(crate) async fn run(
    conn: &Connection,
    vault: &Path,
    options: &ImportOptions,
) -> Result<ImportReport, String> {
    let started = Instant::now();
    let mut report = ImportReport::default();

    let files = scan(vault, options.include_lockbox, options.include_plaintext).await?;
    report.scanned = files.len();

    for chunk in files.chunks(BATCH_SIZE) {
        let vault = vault.to_path_buf();
        let chunk: Vec<SourceFile> = chunk.to_vec();

        // 文件读取与 YAML/JSON 解析都是阻塞操作，必须离开 async executor。
        let parsed = tauri::async_runtime::spawn_blocking(move || parse_batch(&vault, &chunk))
            .await
            .map_err(|error| format!("解析任务失败：{error}"))?;

        for outcome in parsed {
            match outcome {
                Ok(item) => {
                    if item.metadata_pending {
                        report.lockbox_metadata_pending += 1;
                    }

                    if is_unchanged(conn, &item).await? {
                        report.skipped_unchanged += 1;
                        continue;
                    }

                    if options.dry_run {
                        report.imported += 1;
                        continue;
                    }

                    let written = match &item.map {
                        // 导图：已存在就跳过（重复导入不该重置 revision）。
                        Some(row) => match super::maps::get(conn, &row.id).await {
                            Ok(Some(_)) => Ok(()),
                            Ok(None) => super::maps::insert(conn, row).await,
                            Err(reason) => Err(reason),
                        },
                        None => repo::upsert(conn, &item.note).await,
                    };

                    match written {
                        Ok(()) => {
                            record_ledger(conn, &item).await?;
                            report.imported += 1;
                        }
                        Err(reason) => report.failed.push(ImportFailure {
                            path: item.source_path.clone(),
                            reason,
                        }),
                    }
                }
                Err(failure) => report.failed.push(failure),
            }
        }
    }

    if !options.dry_run {
        repo::set_meta(conn, "markdown_import_state", "done").await?;
        repo::set_meta(conn, "markdown_import_at", &Local::now().to_rfc3339()).await?;
        // 让查询计划器拿到新鲜的统计信息。
        let _ = conn.execute("ANALYZE", ()).await;
    }

    if report.lockbox_metadata_pending > 0 {
        report.warnings.push(format!(
            "{} 条密匣笔记的创建时间与标签仍在密文中，已用文件时间占位，解锁后需补齐",
            report.lockbox_metadata_pending
        ));
    }

    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 同步单个已落盘的文件（影子写用）。
///
/// 刻意复用批量导入的 [`parse_one`]：内存里的 `Fragment` 是面向 UI 的视图，
/// 缺 `source` 字段，且密匣态下 `content` 是**解密后的明文**——从它构造写入
/// 参数迟早会与导入口径漂移。只留一条解析路径就不会。
pub(crate) async fn sync_one(
    conn: &Connection,
    vault: &Path,
    rel_path: &str,
) -> Result<(), String> {
    let file = SourceFile {
        path: vault.join(rel_path),
        kind: if rel_path.starts_with("lockbox/") {
            "lockbox_shard"
        } else {
            "fragment_md"
        },
        archived: rel_path.starts_with("archive/") || rel_path.starts_with("lockbox/archive/"),
    };

    let vault_owned = vault.to_path_buf();
    let parsed = tauri::async_runtime::spawn_blocking(move || parse_one(&vault_owned, &file))
        .await
        .map_err(|error| format!("解析任务失败：{error}"))??;

    repo::upsert(conn, &parsed.note).await?;
    record_ledger(conn, &parsed).await
}

#[derive(Clone)]
struct SourceFile {
    path: PathBuf,
    kind: &'static str,
    archived: bool,
}

async fn scan(
    vault: &Path,
    include_lockbox: bool,
    include_plaintext: bool,
) -> Result<Vec<SourceFile>, String> {
    let vault = vault.to_path_buf();

    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();

        if include_plaintext {
            for (dir, archived) in [
                (vault.join("fragments"), false),
                (vault.join("archive"), true),
            ] {
                let mut found = Vec::new();
                crate::collect_markdown_files(&dir, &mut found)?;
                files.extend(found.into_iter().map(|path| SourceFile {
                    path,
                    kind: "fragment_md",
                    archived,
                }));
            }
        }

        // 思维导图：整档入库，revision/doc_hash 沿用文件内的值，
        // 保证乐观并发语义在迁移前后连续。
        {
            let mut found = Vec::new();
            crate::collect_mind_map_files(&vault.join("maps"), &mut found)?;
            files.extend(found.into_iter().map(|path| SourceFile {
                path,
                kind: "shardmap",
                archived: false,
            }));
        }

        if include_lockbox {
            for (dir, archived) in [
                (vault.join("lockbox").join("fragments"), false),
                (vault.join("lockbox").join("archive"), true),
            ] {
                let mut found = Vec::new();
                crate::collect_lockbox_files(&dir, &mut found)?;
                files.extend(found.into_iter().map(|path| SourceFile {
                    path,
                    kind: "lockbox_shard",
                    archived,
                }));
            }
        }

        Ok::<_, String>(files)
    })
    .await
    .map_err(|error| format!("扫描任务失败：{error}"))?
}

fn parse_batch(vault: &Path, files: &[SourceFile]) -> Vec<Result<Parsed, ImportFailure>> {
    files
        .iter()
        .map(|file| {
            let rel = relative_path(vault, &file.path);
            parse_one(vault, file).map_err(|reason| ImportFailure {
                path: rel,
                reason,
            })
        })
        .collect()
}

fn parse_one(vault: &Path, file: &SourceFile) -> Result<Parsed, String> {
    let raw = std::fs::read_to_string(&file.path).map_err(|error| error.to_string())?;
    let source_hash = crate::hash_text(&raw);
    let source_path = relative_path(vault, &file.path);

    match file.kind {
        "fragment_md" => {
            let (frontmatter, body) = crate::parse_fragment_text(&raw)?;
            Ok(Parsed {
                map: None,
                note: NoteWrite {
                    id: frontmatter.id.clone(),
                    // 必须与 `read_fragment` 的口径完全一致：去掉 frontmatter 与正文
                    // 之间的空行，但保留尾部。口径不一致会让 content_hash 对不上，
                    // 进而在导出时产生假 diff。
                    content: Some(body.trim_start_matches('\n').to_string()),
                    created_at: frontmatter.created_at.clone(),
                    updated_at: frontmatter.updated_at.clone(),
                    // 同样对齐 `read_fragment`：无标签的笔记归入 inbox。
                    // 直接存空数组会让这些笔记在切到 DB 读路径后从收件箱消失。
                    tags: if frontmatter.tags.is_empty() {
                        vec!["inbox".to_string()]
                    } else {
                        frontmatter.tags.clone()
                    },
                    category: frontmatter.category.clone(),
                    ai_status: frontmatter
                        .ai_status
                        .clone()
                        .unwrap_or_else(|| "none".to_string()),
                    source: frontmatter.source.clone(),
                    archived: file.archived,
                    pinned: frontmatter.pinned,
                    cipher: None,
                    export_path: Some(source_path.clone()),
                },
                source_kind: file.kind,
                source_path,
                source_hash,
                metadata_pending: false,
            })
        }
        "lockbox_shard" => {
            let encrypted: crate::LockboxEncryptedFragment =
                serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            // 未解锁时元数据在密文里，用文件 mtime 占位。
            let stamp = file_timestamp(&file.path);
            Ok(Parsed {
                map: None,
                note: NoteWrite {
                    id: encrypted.id.clone(),
                    content: None,
                    created_at: stamp.clone(),
                    updated_at: stamp,
                    tags: Vec::new(),
                    category: None,
                    ai_status: "none".to_string(),
                    source: "desktop-lockbox".to_string(),
                    archived: file.archived,
                    pinned: false,
                    cipher: Some(CipherEnvelope {
                        version: i64::from(encrypted.version),
                        nonce: encrypted.nonce.clone(),
                        text: encrypted.ciphertext.clone(),
                        key_alg: encrypted.key_algorithm.clone(),
                        key_text: encrypted.key_ciphertext.clone(),
                        key_id: None,
                    }),
                    export_path: Some(source_path.clone()),
                },
                source_kind: file.kind,
                source_path,
                source_hash,
                metadata_pending: true,
            })
        }
        "shardmap" => {
            // 变量名避开外层的 `file`（SourceFile），别遮蔽它。
            let doc: crate::ShardMapFile =
                serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            Ok(Parsed {
                map: Some(super::maps::row_from_file(&doc, Some(source_path.clone()))?),
                note: NoteWrite {
                    // 导图不落 fragments 表，这里的占位不会被写入。
                    id: doc.id.clone(),
                    content: Some(String::new()),
                    created_at: doc.created_at.clone(),
                    updated_at: doc.updated_at.clone(),
                    tags: Vec::new(),
                    category: None,
                    ai_status: "none".to_string(),
                    source: "shardmap".to_string(),
                    archived: false,
                    pinned: false,
                    cipher: None,
                    export_path: Some(source_path.clone()),
                },
                source_kind: file.kind,
                source_path,
                source_hash,
                metadata_pending: false,
            })
        }
        other => Err(format!("未知的源类型：{other}")),
    }
}

/// 台账里同路径同 hash 即视为未改动。
async fn is_unchanged(conn: &Connection, item: &Parsed) -> Result<bool, String> {
    let mut rows = conn
        .query(
            "SELECT source_hash FROM import_ledger WHERE source_kind = ?1 AND source_path = ?2",
            libsql::params![item.source_kind, item.source_path.clone()],
        )
        .await
        .map_err(|error| error.to_string())?;

    match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => {
            let recorded: String = row.get(0).map_err(|error| error.to_string())?;
            Ok(recorded == item.source_hash)
        }
        None => Ok(false),
    }
}

async fn record_ledger(conn: &Connection, item: &Parsed) -> Result<(), String> {
    conn.execute(
        "INSERT INTO import_ledger (source_kind, source_path, source_hash, target_id, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_kind, source_path) DO UPDATE SET
             source_hash = excluded.source_hash,
             target_id   = excluded.target_id,
             imported_at = excluded.imported_at",
        libsql::params![
            item.source_kind,
            item.source_path.clone(),
            item.source_hash.clone(),
            item.note.id.clone(),
            Local::now().to_rfc3339(),
        ],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn relative_path(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn file_timestamp(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(|time| DateTime::<Local>::from(time).to_rfc3339())
        .unwrap_or_else(|_| Local::now().to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsql::Connection;

    async fn open_conn() -> Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = crate::db::connect_with_pragmas(&db).await.unwrap();
        crate::db::migrate::apply(&conn, super::super::schema::MIGRATIONS)
            .await
            .unwrap();
        conn
    }

    /// 按真实落盘格式写一个片段文件（frontmatter 是 snake_case，
    /// 正文与 frontmatter 之间有一个空行）。
    fn write_fragment(vault: &Path, rel: &str, id: &str, tags: &[&str], body: &str) {
        let path = vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tags_yaml = if tags.is_empty() {
            "tags: []".to_string()
        } else {
            let items: Vec<String> = tags.iter().map(|t| format!("- {t}")).collect();
            format!("tags:\n{}", items.join("\n"))
        };
        let text = format!(
            "---\nid: {id}\ncreated_at: 2026-07-26T10:00:00+08:00\n\
             updated_at: 2026-07-26T10:00:00+08:00\n{tags_yaml}\ncategory: null\n\
             ai_status: none\nsource: desktop\n---\n\n{body}\n"
        );
        std::fs::write(path, text).unwrap();
    }

    fn opts() -> ImportOptions {
        ImportOptions::default()
    }

    #[tokio::test]
    async fn imports_every_markdown_file_once() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/2026/07/a.md", "a", &["会议"], "今天开会议程");
        write_fragment(vault, "fragments/2026/07/b.md", "b", &["工作"], "另一条");
        write_fragment(vault, "archive/2026/06/c.md", "c", &[], "归档的一条");

        let conn = open_conn().await;
        let report = run(&conn, vault, &opts()).await.unwrap();

        assert_eq!(report.scanned, 3);
        assert_eq!(report.imported, 3);
        assert!(report.failed.is_empty(), "不该有失败：{:?}", report.failed);
        assert_eq!(repo::count(&conn, true).await.unwrap(), 3, "总数应等于文件数");
        assert_eq!(repo::count(&conn, false).await.unwrap(), 2, "归档的不算活跃");
    }

    /// 正文口径必须与 read_fragment 一致：去前导空行、保留尾部。
    #[tokio::test]
    async fn body_matches_read_fragment_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "第一行\n第二行");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();

        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("第一行\n第二行\n"));
        assert!(!row.content.unwrap().starts_with('\n'), "不该残留前导空行");
    }

    /// 无标签的笔记要归入 inbox，否则切到 DB 读路径后会从收件箱消失。
    #[tokio::test]
    async fn untagged_notes_fall_back_to_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &[], "没有标签");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();

        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        assert_eq!(row.tags, vec!["inbox".to_string()]);
    }

    /// 重复导入必须幂等：第二次全部跳过，不产生重复行。
    #[tokio::test]
    async fn rerun_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "内容");

        let conn = open_conn().await;
        let first = run(&conn, vault, &opts()).await.unwrap();
        assert_eq!(first.imported, 1);

        let second = run(&conn, vault, &opts()).await.unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped_unchanged, 1);
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1);
    }

    /// 文件内容变了就要重新导入，并且仍然只有一行。
    #[tokio::test]
    async fn changed_file_is_reimported_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "旧内容");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "新内容");
        let report = run(&conn, vault, &opts()).await.unwrap();

        assert_eq!(report.imported, 1);
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1);
        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        assert!(row.content.unwrap().contains("新内容"));
    }

    /// 同一条笔记被移动到 archive/ 后，按 id 认领同一行而不是导成两条。
    #[tokio::test]
    async fn moving_file_does_not_duplicate_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "内容");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();

        std::fs::remove_file(vault.join("fragments/a.md")).unwrap();
        write_fragment(vault, "archive/a.md", "a", &["x"], "内容");
        run(&conn, vault, &opts()).await.unwrap();

        assert_eq!(repo::count(&conn, true).await.unwrap(), 1, "路径变了也只能有一行");
        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        assert!(row.archived, "移动到 archive/ 后应标记为已归档");
    }

    /// 一个坏文件不能毁掉整批导入。
    #[tokio::test]
    async fn malformed_file_is_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/good.md", "good", &["x"], "正常");
        std::fs::write(vault.join("fragments/bad.md"), "没有 frontmatter 的内容").unwrap();

        let conn = open_conn().await;
        let report = run(&conn, vault, &opts()).await.unwrap();

        assert_eq!(report.imported, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].path.contains("bad.md"));
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1, "好文件仍要入库");
    }

    #[tokio::test]
    async fn dry_run_reports_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "内容");

        let conn = open_conn().await;
        let report = run(
            &conn,
            vault,
            &ImportOptions {
                dry_run: true,
                include_lockbox: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(report.scanned, 1);
        assert_eq!(report.imported, 1, "dry run 仍要报告将导入的条数");
        assert_eq!(repo::count(&conn, true).await.unwrap(), 0, "但一行都不能写");
    }

    /// 密匣必须原样搬密文、不解密，且明文列为空。
    #[tokio::test]
    async fn lockbox_ciphertext_is_moved_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let lockbox_dir = vault.join("lockbox/fragments");
        std::fs::create_dir_all(&lockbox_dir).unwrap();
        std::fs::write(
            lockbox_dir.join("s1.shard"),
            r#"{"version":1,"id":"s1","nonce":"N","ciphertext":"CIPHER",
                "key_algorithm":"rsa-oaep-sha256","key_ciphertext":"WRAPPED"}"#,
        )
        .unwrap();

        let conn = open_conn().await;
        let report = run(&conn, vault, &opts()).await.unwrap();

        assert_eq!(report.imported, 1);
        assert_eq!(report.lockbox_metadata_pending, 1, "未解锁导入应如实标记待补齐");
        assert!(!report.warnings.is_empty());

        let row = repo::get(&conn, "s1").await.unwrap().unwrap();
        assert!(row.lockbox);
        assert!(row.content.is_none(), "密匣的明文列必须为空");
        let cipher = row.cipher.unwrap();
        assert_eq!(cipher.text, "CIPHER");
        assert_eq!(cipher.key_text.as_deref(), Some("WRAPPED"));
    }

    #[tokio::test]
    async fn lockbox_can_be_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let lockbox_dir = vault.join("lockbox/fragments");
        std::fs::create_dir_all(&lockbox_dir).unwrap();
        std::fs::write(
            lockbox_dir.join("s1.shard"),
            r#"{"version":1,"id":"s1","nonce":"N","ciphertext":"C"}"#,
        )
        .unwrap();

        let conn = open_conn().await;
        let report = run(
            &conn,
            vault,
            &ImportOptions {
                include_lockbox: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(report.scanned, 0);
    }

    /// 导入后中文搜索必须立即可用——索引是 upsert 的一部分，不需要额外重建。
    #[tokio::test]
    async fn imported_notes_are_searchable_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &[], "今天开会议程安排");
        write_fragment(vault, "fragments/b.md", "b", &[], "无关内容");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();

        let hits = super::super::search::search(&conn, "会议", false, 20).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[tokio::test]
    async fn import_state_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_conn().await;
        run(&conn, dir.path(), &opts()).await.unwrap();
        assert_eq!(
            repo::get_meta(&conn, "markdown_import_state").await.unwrap().as_deref(),
            Some("done")
        );
    }

    /// 单文件同步（影子写的核心）走的必须是与批量导入相同的解析路径。
    #[tokio::test]
    async fn sync_one_matches_batch_import() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["会议"], "今天开会议程");

        let conn = open_conn().await;
        sync_one(&conn, vault, "fragments/a.md").await.unwrap();

        let row = repo::get(&conn, "a").await.unwrap().unwrap();
        assert_eq!(row.content.as_deref(), Some("今天开会议程\n"));
        assert_eq!(row.tags, vec!["会议".to_string()]);
        // 索引也要就绪，否则刚写的笔记搜不到。
        let hits = super::super::search::search(&conn, "会议", false, 20).await.unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn sync_one_detects_archived_from_path() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "archive/a.md", "a", &["x"], "归档内容");

        let conn = open_conn().await;
        sync_one(&conn, vault, "archive/a.md").await.unwrap();
        assert!(repo::get(&conn, "a").await.unwrap().unwrap().archived);
    }

    /// 安全关键：明文被移入密匣后，库里绝不能残留明文——
    /// 明文文件此时已从磁盘删除，库里留着就是泄漏。
    #[tokio::test]
    async fn plaintext_does_not_survive_move_to_lockbox() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "会议室密码是 1234");

        let conn = open_conn().await;
        sync_one(&conn, vault, "fragments/a.md").await.unwrap();
        assert_eq!(
            super::super::search::search(&conn, "会议", false, 20).await.unwrap().len(),
            1,
            "前置条件：明文此时应可搜到"
        );

        // 模拟 move_public_fragment_to_lockbox_in_vault 的效果：
        // 明文文件消失，密匣文件出现（id 不变）。
        std::fs::remove_file(vault.join("fragments/a.md")).unwrap();
        let lockbox_dir = vault.join("lockbox/fragments");
        std::fs::create_dir_all(&lockbox_dir).unwrap();
        std::fs::write(
            lockbox_dir.join("2026-07-26-100000-ab12.shard"),
            r#"{"version":1,"id":"a","nonce":"N","ciphertext":"ENCRYPTED"}"#,
        )
        .unwrap();

        // 这正是 shadow::sync_lockbox_transfer 做的两步。
        repo::purge(&conn, "a").await.unwrap();
        run(
            &conn,
            vault,
            &ImportOptions { include_plaintext: false, ..Default::default() },
        )
        .await
        .unwrap();

        let row = repo::get(&conn, "a").await.unwrap().expect("密匣条目应已入库");
        assert!(row.lockbox);
        assert!(row.content.is_none(), "明文列必须为空");
        assert_eq!(row.cipher.unwrap().text, "ENCRYPTED");

        let hits = super::super::search::search(&conn, "会议", false, 20).await.unwrap();
        assert!(hits.is_empty(), "旧明文必须已从索引中消失");

        let mut rows = conn
            .query("SELECT count(*) FROM fragments_fts", ())
            .await
            .unwrap();
        let indexed: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(indexed, 0, "FTS 表里不该留下任何行");
    }

    /// purge 之后重新导入同一文件应当照常工作（台账也要一并清掉）。
    #[tokio::test]
    async fn purge_allows_clean_reimport() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        write_fragment(vault, "fragments/a.md", "a", &["x"], "内容");

        let conn = open_conn().await;
        run(&conn, vault, &opts()).await.unwrap();
        repo::purge(&conn, "a").await.unwrap();
        assert_eq!(repo::count(&conn, true).await.unwrap(), 0);

        let report = run(&conn, vault, &opts()).await.unwrap();
        assert_eq!(report.imported, 1, "台账已清，应能重新导入");
        assert_eq!(repo::count(&conn, true).await.unwrap(), 1);
    }
}
