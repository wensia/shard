//! 笔记库的 Tauri command 薄壳。
//!
//! 这一层只做参数转换与错误映射，业务逻辑全在 `repo` / `search` / `import`——
//! 那些函数不依赖 Tauri，可以在 `:memory:` 库里直接单测。
//!
//! # Phase 2 的定位
//!
//! 现阶段这些命令是**旁路验证工具**，不参与正常读写路径：Markdown 文件仍是
//! 真相源。它们的作用是让「DB 里的数据是否与文件一致」这件事可被实际测量，
//! 而不是靠推断。读路径切换在 Phase 3。

use serde::Serialize;

use super::export::{self, ExportMode, ExportReport, VerifyReport};
use super::import::{self, ImportOptions, ImportReport};
use super::search::{self, SearchHit};
use super::{repo, NotesDb};

/// 库的当前状态，用于人工核对导入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesDbStats {
    /// 未删除的总数（含归档）。
    pub total: i64,
    /// 未删除且未归档。
    pub active: i64,
    /// 墓碑数量。
    pub deleted: i64,
    pub lockbox: i64,
    /// FTS 索引里的行数。应当等于「未删除的明文条目数」。
    pub indexed: i64,
    pub import_state: Option<String>,
    pub import_at: Option<String>,
}

/// 把 vault 里的 Markdown 与密匣文件导入笔记库。
///
/// `dryRun` 为 true 时只扫描解析、不写库——UI 应当先跑一次让用户确认规模，
/// 再执行真正的导入。重复执行是安全的（按内容 hash 与 frontmatter id 幂等）。
#[tauri::command]
pub(crate) async fn import_vault_markdown(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
    dry_run: bool,
    include_lockbox: bool,
) -> Result<ImportReport, String> {
    let vault = crate::ensure_vault_dirs(&app)?;
    let conn = notes.conn(&app, false).await?;
    import::run(
        &conn,
        &vault,
        &ImportOptions {
            dry_run,
            include_lockbox,
            include_plaintext: true,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn notes_db_stats(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
) -> Result<NotesDbStats, String> {
    let conn = notes.conn(&app, false).await?;

    Ok(NotesDbStats {
        total: repo::count(&conn, true).await?,
        active: repo::count(&conn, false).await?,
        deleted: scalar(&conn, "SELECT count(*) FROM fragments WHERE deleted_at IS NOT NULL")
            .await?,
        lockbox: scalar(
            &conn,
            "SELECT count(*) FROM fragments WHERE deleted_at IS NULL AND lockbox = 1",
        )
        .await?,
        indexed: scalar(&conn, "SELECT count(*) FROM fragments_fts").await?,
        import_state: repo::get_meta(&conn, "markdown_import_state").await?,
        import_at: repo::get_meta(&conn, "markdown_import_at").await?,
    })
}

/// 走 FTS5 的全文搜索。密匣条目永远不在结果里。
#[tauri::command]
pub(crate) async fn search_fragments_db(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
    query: String,
    include_archived: bool,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, String> {
    let conn = notes.conn(&app, false).await?;
    search::search(&conn, &query, include_archived, limit.unwrap_or(50)).await
}

/// 全量重建全文索引。分词逻辑变更后必须执行。
#[tauri::command]
pub(crate) async fn rebuild_search_index(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
) -> Result<usize, String> {
    let conn = notes.conn(&app, false).await?;
    search::rebuild(&conn).await
}

async fn scalar(conn: &libsql::Connection, sql: &str) -> Result<i64, String> {
    let mut rows = conn.query(sql, ()).await.map_err(|e| e.to_string())?;
    rows.next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "查询无结果".to_string())?
        .get(0)
        .map_err(|e| e.to_string())
}

/// 把笔记库导出成 Markdown / 密匣文件。
///
/// `full` 为 true 时全量重写，否则只写有改动的条目。密匣导出的是**密文**，
/// 不需要解锁。
#[tauri::command]
pub(crate) async fn export_vault_markdown(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
    full: bool,
) -> Result<ExportReport, String> {
    let vault = crate::ensure_vault_dirs(&app)?;
    let conn = notes.conn(&app, false).await?;
    let mode = if full { ExportMode::Full } else { ExportMode::Dirty };
    export::run(&conn, &vault, mode).await
}

/// 校验磁盘上的产物能否无损还原库内容。
///
/// 这是写路径反转（库成为真相源）的前置门槛：`mismatched` / `missing` /
/// `unmapped` 必须全空。`byteDifferences` 单独列出，通常是 frontmatter 规范化
/// 或外部编辑，不代表数据损坏。
#[tauri::command]
pub(crate) async fn verify_export(
    app: tauri::AppHandle,
    notes: tauri::State<'_, NotesDb>,
) -> Result<VerifyReport, String> {
    let vault = crate::ensure_vault_dirs(&app)?;
    let conn = notes.conn(&app, false).await?;
    export::verify(&conn, &vault).await
}
