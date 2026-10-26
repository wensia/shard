//! 公开内容的来源枚举与「文件 → 可搜索文档」投影，经 [`Vfs`] 读，不碰 `std::fs`。
//!
//! 从 src-tauri 的 `search_sources.rs` 原样搬来，只把文件读写换成 `&dyn Vfs`，并把原来从资料库路径
//! 推出来的「vault 身份字符串」（进 `SearchTarget.vaultPath` 与 `key`）改成显式参数：桌面传
//! `vault.display().to_string()`，服务端传自己的资料库身份。
//!
//! 桌面专用的部分留在 src-tauri：文件戳与增量同步（需要 inode / ctime）、SQLite 派生索引、运行时快照与
//! 代次、密匣（解密后的投影复用这里的 [`markdown_document`]）。
//!
//! 服务端直接用 [`build_public_snapshot`]（全量枚举并投影，得到可反复查询的 [`SearchSnapshotData`]）与
//! [`read_public_search_target`]（`read_search_target` 的公开部分）。

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use shard_core::{
    derive_type,
    frontmatter::parse_fragment,
    graph_model::{CanvasFile, ShardMapFile},
    graph_region::{find_region, GraphRegionKind},
    search::{
        project_document, DocumentOnlyReason, ParsedQuery, ProjectedDocument, SearchProjection,
        SearchProjectionBlock, SourceDocument,
    },
    FragmentFrontmatter, Vfs, VfsMetadata,
};

use super::{
    contract::{
        SearchContext, SearchError, SearchKind, SearchRevealHint, SearchScope, SearchTarget,
    },
    scan::{scan_documents, SearchScanResult},
};
use crate::Fragment;

/// CSV 只读表头：表头（含引号里的换行）超过 1 MiB 视为不支持。
pub const CSV_HEADER_MAX_BYTES: u64 = 1024 * 1024;
/// 一次枚举最多访问的目录条目数，超过即报 `Io { retryable: false }`。
pub const SEARCH_SCAN_MAX_ENTRIES: usize = 100_000;
/// 读 CSV 表头的第一口：与迁移前 `BufReader` 的缓冲区一样大，常见表头一次读完。
const CSV_HEADER_FIRST_READ: u64 = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicSourceKind {
    Markdown,
    MindMap,
    Canvas,
    Csv,
}

/// 枚举到的一个公开来源。`stamp` 由调用方决定：桌面放自己的文件戳（mtime / inode / ctime，
/// 增量同步用），默认入口放 [`VfsMetadata`]。
#[derive(Debug, Clone)]
pub struct PublicSource<S> {
    pub path: PathBuf,
    pub relative: String,
    pub kind: PublicSourceKind,
    pub stamp: S,
}

#[derive(Debug, Clone)]
pub struct SearchDocumentMetadata {
    pub target: SearchTarget,
    pub updated_at: Option<String>,
    pub revision: String,
    pub reveal_hint: SearchRevealHint,
    pub read_only: bool,
}

#[derive(Debug, Clone)]
pub struct LoadedSearchDocument {
    pub projected: ProjectedDocument,
    pub metadata: SearchDocumentMetadata,
    /// Markdown 来源才有；结构化来源（导图、画布、CSV）为 `None`。
    pub fragment: Option<Fragment>,
}

/// 一份可反复查询的搜索快照：文档按 `stable_key`（= `target.key`）升序，元数据按同一个键索引。
#[derive(Debug, Clone)]
pub struct SearchSnapshotData {
    pub documents: Vec<ProjectedDocument>,
    pub metadata: HashMap<String, SearchDocumentMetadata>,
    pub skipped_files: u32,
    /// 全部 `key + revision` 与 skipped 数的哈希：内容不变它就不变。
    pub source_stamp: String,
}

impl SearchSnapshotData {
    /// 把投影好的文档排序、建元数据表、算 `source_stamp`。桌面的快照构建与 [`build_public_snapshot`] 共用。
    pub fn assemble(mut loaded: Vec<LoadedSearchDocument>, skipped_files: u32) -> Self {
        loaded.sort_by(|left, right| left.metadata.target.key.cmp(&right.metadata.target.key));

        let mut stamp_input = String::new();
        let mut documents = Vec::with_capacity(loaded.len());
        let mut metadata = HashMap::with_capacity(loaded.len());
        for document in loaded {
            stamp_input.push_str(&document.metadata.target.key);
            stamp_input.push('\0');
            stamp_input.push_str(&document.metadata.revision);
            stamp_input.push('\n');
            metadata.insert(document.projected.stable_key.clone(), document.metadata);
            documents.push(document.projected);
        }
        stamp_input.push_str(&format!("skipped:{skipped_files}"));
        Self {
            documents,
            metadata,
            skipped_files,
            source_stamp: crate::hash_text(&stamp_input),
        }
    }

    /// 在快照上跑一次精确扫描（见 [`scan_documents`]）。
    pub fn search(
        &self,
        query: &ParsedQuery,
        limit: usize,
        include_trash: bool,
    ) -> Result<SearchScanResult, SearchError> {
        scan_documents(&self.documents, &self.metadata, query, limit, include_trash)
    }
}

/// 快照 id：资料库身份、两个代次、范围与内容戳的哈希。
pub fn snapshot_id(context: &SearchContext, scope: &SearchScope, source_stamp: &str) -> String {
    crate::hash_text(&format!(
        "{}\0{}\0{}\0{}\0{}",
        context.vault_path,
        context.vault_epoch,
        context.privacy_epoch,
        scope_wire(scope),
        source_stamp
    ))
}

/// 服务端入口：全量枚举并投影全部公开文档。读失败或解析失败的来源计入 `skipped_files`，
/// 不让整次构建失败；只有枚举本身出错（目录读不了、条目超上限）才返回 `Err`。
pub fn build_public_snapshot(
    vfs: &dyn Vfs,
    vault_path: &str,
) -> Result<SearchSnapshotData, SearchError> {
    let (sources, mut skipped) = enumerate_public_sources(vfs)?;
    let mut loaded = Vec::with_capacity(sources.len());
    for source in &sources {
        match load_public_source(vfs, vault_path, source) {
            Ok(document) => loaded.push(document),
            Err(_) => skipped = skipped.saturating_add(1),
        }
    }
    Ok(SearchSnapshotData::assemble(loaded, skipped))
}

/// `read_search_target` 的公开部分：核对目标身份 → 只接受 Markdown 类目标 → 安全解析路径 → 读取并投影 →
/// 核对读出的对象仍是请求的那个（同一路径换了对象报 `TargetChanged`）。
///
/// 密匣目标返回 `UnsupportedTarget`：公开内容入口从不解密，桌面在 src-tauri 里自己处理密匣分支。
pub fn read_public_search_target(
    vfs: &dyn Vfs,
    vault_path: &str,
    target: &SearchTarget,
) -> Result<LoadedSearchDocument, SearchError> {
    validate_target_identity(vault_path, target)?;
    if !is_markdown_target(target) || target.scope != SearchScope::Public {
        return Err(SearchError::UnsupportedTarget);
    }
    let path = resolve_target_file(vfs, &target.path, &SearchScope::Public)?;
    let document = load_public_markdown(vfs, vault_path, &path)?;
    validate_loaded_identity(target, &document.metadata.target)?;
    Ok(document)
}

/// 目标属于这个资料库，且 `key` 与 `(vaultPath, scope, path)` 对得上。
pub fn validate_target_identity(
    vault_path: &str,
    target: &SearchTarget,
) -> Result<(), SearchError> {
    if vault_path != target.vault_path {
        return Err(SearchError::VaultChanged);
    }
    if target.key != target_key(&target.vault_path, &target.scope, &target.path) {
        return Err(SearchError::TargetChanged);
    }
    Ok(())
}

/// 只有 Markdown 对象能整篇读出来（结构化文档走各自的编辑器）。
pub fn is_markdown_target(target: &SearchTarget) -> bool {
    matches!(
        target.kind,
        SearchKind::Fragment | SearchKind::Note | SearchKind::Outline | SearchKind::Document
    ) || matches!(target.kind, SearchKind::Flowchart)
        && target.path.to_ascii_lowercase().ends_with(".md")
}

pub fn validate_loaded_identity(
    requested: &SearchTarget,
    actual: &SearchTarget,
) -> Result<(), SearchError> {
    if requested.key != actual.key
        || scope_wire(&requested.scope) != scope_wire(&actual.scope)
        || requested.path != actual.path
        || std::mem::discriminant(&requested.kind) != std::mem::discriminant(&actual.kind)
        || requested.object_id != actual.object_id
    {
        return Err(SearchError::TargetChanged);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/// 枚举全部公开来源，`stamp` 为条目的 [`VfsMetadata`]（不跟随符号链接）。
pub fn enumerate_public_sources(
    vfs: &dyn Vfs,
) -> Result<(Vec<PublicSource<VfsMetadata>>, u32), SearchError> {
    enumerate_public_sources_with(vfs, |path| match vfs.symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => Some(metadata),
        _ => None,
    })
}

/// 枚举全部公开来源：`fragments/`、`notes/` 及其回收站里的 Markdown，`notes/`（与旧 `maps/`）里的导图，
/// `notes/` 里的画布与流程图，资料库里（隐藏目录与 `lockbox/` 之外）的 CSV。
///
/// `stamp` 对每个候选文件调用一次：返回 `None` 表示它不是普通文件（符号链接、读不到等），计入 skipped。
/// 返回值的第二项是 skipped 数，另含不安全的根目录与回收站里无法打开的结构化文档。
pub fn enumerate_public_sources_with<S>(
    vfs: &dyn Vfs,
    mut stamp: impl FnMut(&Path) -> Option<S>,
) -> Result<(Vec<PublicSource<S>>, u32), SearchError> {
    let vault = vfs.root();
    let mut sources = Vec::new();
    let mut skipped = 0u32;

    for relative_root in ["fragments", "notes", ".trash/fragments", ".trash/notes"] {
        let (root, unsafe_root) = safe_scan_root(vfs, relative_root)?;
        if unsafe_root {
            skipped = skipped.saturating_add(1);
        }
        let Some(root) = root else {
            continue;
        };
        let mut files = Vec::new();
        crate::collect_markdown_files(vfs, &root, &mut files).map_err(io_error)?;
        for path in files {
            push_public_source(
                vault,
                path,
                PublicSourceKind::Markdown,
                &mut stamp,
                &mut sources,
                &mut skipped,
            )?;
        }
    }

    let mut visited = 0usize;
    let (notes_root, _) = safe_scan_root(vfs, "notes")?;
    let (maps_root, maps_unsafe) = safe_scan_root(vfs, "maps")?;
    if maps_unsafe {
        skipped = skipped.saturating_add(1);
    }
    let mut mind_maps = Vec::new();
    if let Some(notes_root) = &notes_root {
        crate::canvas::scan_files(
            vfs,
            notes_root,
            ".shardmap.json",
            &mut mind_maps,
            &mut visited,
        )
        .map_err(io_error)?;
    }
    // Legacy maps can exist before the existing migration runs. Hidden recovery folders
    // are already excluded by the shared typed scanner.
    if let Some(maps_root) = &maps_root {
        crate::canvas::scan_files(
            vfs,
            maps_root,
            ".shardmap.json",
            &mut mind_maps,
            &mut visited,
        )
        .map_err(io_error)?;
    }
    for path in mind_maps {
        push_public_source(
            vault,
            path,
            PublicSourceKind::MindMap,
            &mut stamp,
            &mut sources,
            &mut skipped,
        )?;
    }

    for suffix in [".shardcanvas.json", ".shardflow.json"] {
        let mut files = Vec::new();
        if let Some(notes_root) = &notes_root {
            crate::canvas::scan_files(vfs, notes_root, suffix, &mut files, &mut visited)
                .map_err(io_error)?;
        }
        for path in files {
            push_public_source(
                vault,
                path,
                PublicSourceKind::Canvas,
                &mut stamp,
                &mut sources,
                &mut skipped,
            )?;
        }
    }

    let mut csv_files = Vec::new();
    collect_public_csv_files(vfs, vault, &mut csv_files, &mut visited, &mut skipped)?;
    for path in csv_files {
        push_public_source(
            vault,
            path,
            PublicSourceKind::Csv,
            &mut stamp,
            &mut sources,
            &mut skipped,
        )?;
    }

    skipped = skipped.saturating_add(count_structured_trash(vfs)?);
    Ok((sources, skipped))
}

fn push_public_source<S>(
    vault: &Path,
    path: PathBuf,
    kind: PublicSourceKind,
    stamp: &mut impl FnMut(&Path) -> Option<S>,
    sources: &mut Vec<PublicSource<S>>,
    skipped: &mut u32,
) -> Result<(), SearchError> {
    let relative = crate::relative_path(vault, &path).map_err(io_error)?;
    match stamp(&path) {
        Some(stamp) => sources.push(PublicSource {
            path,
            relative,
            kind,
            stamp,
        }),
        None => *skipped = skipped.saturating_add(1),
    }
    Ok(())
}

/// Resolve a fixed source root without following any component symlink. Missing roots
/// are normal for partially initialized vaults; unsafe roots are reported to skipped_files.
pub fn safe_scan_root(
    vfs: &dyn Vfs,
    relative: &str,
) -> Result<(Option<PathBuf>, bool), SearchError> {
    let mut root = vfs.root().to_path_buf();
    for part in relative.split('/') {
        root.push(part);
        match vfs.symlink_metadata(&root) {
            Ok(metadata) if metadata.is_symlink() || !metadata.is_dir() => {
                return Ok((None, true));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((None, false));
            }
            Err(error) => return Err(fs_error(error)),
        }
    }
    Ok((Some(root), false))
}

fn collect_public_csv_files(
    vfs: &dyn Vfs,
    root: &Path,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
    skipped: &mut u32,
) -> Result<(), SearchError> {
    let vault = vfs.root();
    for entry in vfs.read_dir(root).map_err(fs_error)? {
        *visited += 1;
        if *visited > SEARCH_SCAN_MAX_ENTRIES {
            return Err(SearchError::Io { retryable: false });
        }
        let kind = entry.file_type().map_err(fs_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink() {
            if name.to_ascii_lowercase().ends_with(".csv") {
                *skipped = skipped.saturating_add(1);
            }
            continue;
        }
        if kind.is_dir() {
            if name.starts_with('.') || name.eq_ignore_ascii_case("lockbox") {
                continue;
            }
            collect_public_csv_files(vfs, &entry.path(), files, visited, skipped)?;
        } else if kind.is_file()
            && !name.starts_with('.')
            && name.to_ascii_lowercase().ends_with(".csv")
            && entry.path().starts_with(vault)
        {
            files.push(entry.path());
        }
    }
    Ok(())
}

/// 回收站里的结构化文档（导图、画布、流程图、CSV）没有搜索投影，只计数进 skipped。
fn count_structured_trash(vfs: &dyn Vfs) -> Result<u32, SearchError> {
    let (root, _unsafe_root) = safe_scan_root(vfs, ".trash/notes")?;
    // 不安全的根已在 Markdown 根校验时计过一次。
    let Some(root) = root else {
        return Ok(0);
    };
    let mut visited = 0usize;
    count_structured_files(vfs, &root, &mut visited)
}

fn count_structured_files(
    vfs: &dyn Vfs,
    root: &Path,
    visited: &mut usize,
) -> Result<u32, SearchError> {
    let entries = match vfs.read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(fs_error(error)),
    };
    let mut count = 0u32;
    for entry in entries {
        *visited += 1;
        if *visited > SEARCH_SCAN_MAX_ENTRIES {
            return Err(SearchError::Io { retryable: false });
        }
        let kind = entry.file_type().map_err(fs_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink() || name.starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            count = count.saturating_add(count_structured_files(vfs, &entry.path(), visited)?);
        } else if kind.is_file()
            && [
                ".shardmap.json",
                ".shardcanvas.json",
                ".shardflow.json",
                ".csv",
            ]
            .iter()
            .any(|suffix| name.to_ascii_lowercase().ends_with(suffix))
        {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

pub fn load_public_source<S>(
    vfs: &dyn Vfs,
    vault_path: &str,
    source: &PublicSource<S>,
) -> Result<LoadedSearchDocument, SearchError> {
    match source.kind {
        PublicSourceKind::Markdown => load_public_markdown(vfs, vault_path, &source.path),
        PublicSourceKind::MindMap => load_mind_map(vfs, vault_path, &source.path),
        PublicSourceKind::Canvas => load_canvas(vfs, vault_path, &source.relative),
        PublicSourceKind::Csv => load_csv(vfs, vault_path, &source.path),
    }
}

pub fn load_public_markdown(
    vfs: &dyn Vfs,
    vault_path: &str,
    path: &Path,
) -> Result<LoadedSearchDocument, SearchError> {
    let (text, revision) = read_public_markdown_text(vfs, path)?;
    load_public_markdown_text(vfs, vault_path, path, &text, revision)
}

/// 读一篇公开 Markdown 的原文与 revision（原文的 sha256）。
pub fn read_public_markdown_text(
    vfs: &dyn Vfs,
    path: &Path,
) -> Result<(String, String), SearchError> {
    let safe_path = resolve_public_markdown_path(vfs, path)?;
    read_text_with_revision(vfs, &safe_path)
}

/// 把枚举到的绝对路径换成经过安全校验的路径（不跟随符号链接、不出资料库、根与扩展名合法）。
pub fn resolve_public_markdown_path(vfs: &dyn Vfs, path: &Path) -> Result<PathBuf, SearchError> {
    let relative = crate::relative_path(vfs.root(), path).map_err(io_error)?;
    resolve_target_file(vfs, &relative, &SearchScope::Public)
}

/// 读已校验路径的原文，revision 为原文的 sha256。
pub fn read_text_with_revision(
    vfs: &dyn Vfs,
    safe_path: &Path,
) -> Result<(String, String), SearchError> {
    let text = vfs.read_to_string(safe_path).map_err(fs_error)?;
    let revision = crate::hash_text(&text);
    Ok((text, revision))
}

pub fn load_public_markdown_text(
    vfs: &dyn Vfs,
    vault_path: &str,
    path: &Path,
    text: &str,
    revision: String,
) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vfs.root(), path).map_err(io_error)?;
    let parsed = parse_fragment(text).map_err(|_| SearchError::UnsupportedTarget)?;
    let archived =
        relative.starts_with(".trash/fragments/") || relative.starts_with(".trash/notes/");
    Ok(markdown_document(
        vault_path,
        SearchScope::Public,
        relative,
        archived,
        parsed.frontmatter,
        Some(&parsed.raw),
        &parsed.body,
        revision.clone(),
        revision,
    ))
}

/// 一篇 Markdown（公开或已解密的密匣）→ 可搜索文档 + 读取用的 [`Fragment`]。
#[allow(clippy::too_many_arguments)]
pub fn markdown_document(
    vault_path: &str,
    scope: SearchScope,
    relative: String,
    archived: bool,
    frontmatter: FragmentFrontmatter,
    frontmatter_raw: Option<&str>,
    body: &str,
    revision: String,
    file_sha: String,
) -> LoadedSearchDocument {
    let content = body.trim_start_matches('\n').to_string();
    let kind = markdown_kind(&frontmatter.tags);
    let graph = markdown_graph_content(&kind, &content);
    let title = graph
        .as_ref()
        .map(|content| content.title.clone())
        .unwrap_or_else(|| markdown_title(&kind, &content));
    let tags = if frontmatter.tags.is_empty() {
        vec!["inbox".to_string()]
    } else {
        frontmatter.tags.clone()
    };
    let target = make_target(
        vault_path,
        scope.clone(),
        relative.clone(),
        kind,
        Some(frontmatter.id.clone()),
        archived,
    );
    let metadata = SearchDocumentMetadata {
        target: target.clone(),
        updated_at: Some(frontmatter.updated_at.clone()),
        revision,
        reveal_hint: SearchRevealHint::Text,
        read_only: true,
    };
    let source = SourceDocument {
        stable_key: target.key.clone(),
        title,
        tags: tags.clone(),
        body: content.clone(),
        modified_at: parse_modified_at(&frontmatter.updated_at),
    };
    let projected = if let Some(graph) = graph {
        ProjectedDocument::from_projection(
            &source,
            SearchProjection::from_blocks(vec![SearchProjectionBlock::DocumentOnly {
                reason: DocumentOnlyReason::CodeBlock,
                text: graph.text,
            }]),
        )
    } else {
        project_document(&source)
    };
    let fragment = Fragment {
        id: frontmatter.id,
        content,
        file_sha,
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at,
        tags,
        category: frontmatter.category,
        path: relative,
        git_status: "saved".to_string(),
        error: None,
        ai_status: frontmatter.ai_status.unwrap_or_else(|| "none".to_string()),
        archived,
        lockbox: matches!(scope, SearchScope::Lockbox),
        pinned: frontmatter.pinned,
        related: frontmatter.related,
        properties: frontmatter_raw
            .map(crate::fragment_properties)
            .unwrap_or_default(),
        conflict_of: frontmatter.conflict_of,
    };
    LoadedSearchDocument {
        projected,
        metadata,
        fragment: Some(fragment),
    }
}

pub fn load_mind_map(
    vfs: &dyn Vfs,
    vault_path: &str,
    path: &Path,
) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vfs.root(), path).map_err(io_error)?;
    let (file, text) = crate::read_mind_map_file(vfs, path).map_err(io_error)?;
    crate::validate_mind_map_file(vfs, &file).map_err(io_error)?;
    let body = shard_core::graph_model::mind_map_search_text(&file);
    Ok(structured_document(
        vault_path,
        relative,
        SearchKind::Mindmap,
        Some(file.id),
        file.title,
        file.updated_at,
        crate::hash_text(&text),
        body,
        SearchRevealHint::DocumentOnly,
    ))
}

pub fn load_canvas(
    vfs: &dyn Vfs,
    vault_path: &str,
    relative: &str,
) -> Result<LoadedSearchDocument, SearchError> {
    let document = crate::canvas::read_search_document(vfs, relative).map_err(io_error)?;
    let kind = if document.kind == "shard.flow" {
        SearchKind::Flowchart
    } else {
        SearchKind::Canvas
    };
    Ok(structured_document(
        vault_path,
        relative.to_string(),
        kind,
        Some(document.id),
        document.title,
        document.updated_at,
        document.revision,
        document.body,
        SearchRevealHint::DocumentOnly,
    ))
}

/// CSV 只投影表头。revision 取表头字节、文件大小与修改时间：不为了算 revision 读整个大表。
pub fn load_csv(
    vfs: &dyn Vfs,
    vault_path: &str,
    path: &Path,
) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vfs.root(), path).map_err(io_error)?;
    let safe_path = resolve_csv_file(vfs, &relative)?;
    let metadata = vfs.metadata(&safe_path).map_err(fs_error)?;
    let bytes = read_csv_header_bytes(vfs, &safe_path)?;
    let headers = parse_csv_header(&bytes)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(SearchError::UnsupportedTarget)?;
    let title = file_name
        .get(..file_name.len().saturating_sub(4))
        .filter(|_| file_name.to_ascii_lowercase().ends_with(".csv"))
        .ok_or(SearchError::UnsupportedTarget)?
        .to_string();
    let modified = metadata.modified().ok();
    let revision = crate::hash_text(&format!(
        "{}:{}:{}",
        crate::hash_bytes(&bytes),
        metadata.len(),
        system_time_nanos(modified)
    ));
    let updated_at = modified.map(system_time_rfc3339).unwrap_or_default();
    Ok(structured_document(
        vault_path,
        relative,
        SearchKind::Csv,
        None,
        title,
        updated_at,
        revision,
        headers.join("\n"),
        SearchRevealHint::External,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn structured_document(
    vault_path: &str,
    relative: String,
    kind: SearchKind,
    object_id: Option<String>,
    title: String,
    updated_at: String,
    revision: String,
    body: String,
    reveal_hint: SearchRevealHint,
) -> LoadedSearchDocument {
    let target = make_target(
        vault_path,
        SearchScope::Public,
        relative,
        kind,
        object_id,
        false,
    );
    let projected = project_document(&SourceDocument {
        stable_key: target.key.clone(),
        title,
        tags: Vec::new(),
        body,
        modified_at: parse_modified_at(&updated_at),
    });
    LoadedSearchDocument {
        projected,
        metadata: SearchDocumentMetadata {
            target,
            updated_at: (!updated_at.is_empty()).then_some(updated_at),
            revision,
            reveal_hint,
            read_only: true,
        },
        fragment: None,
    }
}

pub fn make_target(
    vault_path: &str,
    scope: SearchScope,
    path: String,
    kind: SearchKind,
    object_id: Option<String>,
    archived: bool,
) -> SearchTarget {
    SearchTarget {
        key: target_key(vault_path, &scope, &path),
        vault_path: vault_path.to_string(),
        scope,
        path,
        kind,
        object_id,
        archived,
    }
}

/// 搜索目标的稳定键：`["<vaultPath>","public|lockbox","<相对路径>"]` 的 JSON。
pub fn target_key(vault_path: &str, scope: &SearchScope, path: &str) -> String {
    serde_json::to_string(&(vault_path, scope_wire(scope), path))
        .expect("search target key is serializable")
}

pub fn scope_wire(scope: &SearchScope) -> &'static str {
    match scope {
        SearchScope::Public => "public",
        SearchScope::Lockbox => "lockbox",
    }
}

/// 类型标签 → 搜索类型，优先级与 `shard_core::derive_type` 一致。
pub fn markdown_kind(tags: &[String]) -> SearchKind {
    match derive_type(tags) {
        Some("note") => SearchKind::Note,
        Some("outline") => SearchKind::Outline,
        Some("flowchart") => SearchKind::Flowchart,
        Some("document") => SearchKind::Document,
        _ => SearchKind::Fragment,
    }
}

struct GraphSearchContent {
    title: String,
    text: String,
}

/// 大纲 / 流程图碎片里唯一的受管 JSON 区域：只取用户写的文字，id、坐标等内部字段不进投影。
/// 区域缺失或 JSON 损坏时返回 `None`，退回普通 Markdown 投影，结果不丢。
fn markdown_graph_content(kind: &SearchKind, body: &str) -> Option<GraphSearchContent> {
    match kind {
        SearchKind::Outline => {
            let region = find_region(body, GraphRegionKind::Outline).ok()?;
            let file = serde_json::from_str::<ShardMapFile>(&region.json_text).ok()?;
            if file.kind != "shard.map" {
                return None;
            }
            let title = file
                .nodes
                .get(&file.root_id)
                .map(|node| node.text.trim())
                .filter(|title| !title.is_empty())
                .unwrap_or("未命名大纲")
                .to_string();
            let mut lines = Vec::new();
            for node in file.nodes.values() {
                push_graph_search_line(&mut lines, &node.text);
                if let Some(note) = &node.note {
                    push_graph_search_line(&mut lines, note);
                }
            }
            Some(GraphSearchContent {
                title,
                text: lines.join("\n"),
            })
        }
        SearchKind::Flowchart => {
            let region = find_region(body, GraphRegionKind::Flowchart).ok()?;
            let file = serde_json::from_str::<CanvasFile>(&region.json_text).ok()?;
            if file.kind != "shard.flow" {
                return None;
            }
            let title = if file.title.trim().is_empty() {
                "未命名流程图".to_string()
            } else {
                file.title.trim().to_string()
            };
            Some(GraphSearchContent {
                title,
                text: crate::canvas::search_text(&file),
            })
        }
        _ => None,
    }
}

fn push_graph_search_line(lines: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        lines.push(value.to_string());
    }
}

/// 没有受管 JSON 区域时的标题规则，与前端列表标题一致。
pub fn markdown_title(kind: &SearchKind, body: &str) -> String {
    match kind {
        SearchKind::Document => body
            .lines()
            .find_map(markdown_heading)
            .or_else(|| first_nonempty_line(body))
            .map(|title| truncate_chars(title, 40))
            .unwrap_or_else(|| "未命名文档".to_string()),
        SearchKind::Outline => first_nonempty_line(body)
            .map(strip_outline_marker)
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| "未命名大纲".to_string()),
        SearchKind::Note => level_one_heading(body)
            .or_else(|| first_nonempty_line(body))
            .map(|title| truncate_chars(title, 48))
            .unwrap_or_else(|| "未命名笔记".to_string()),
        _ => first_nonempty_line(body).unwrap_or_else(|| "未命名碎片".to_string()),
    }
}

fn level_one_heading(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(trim_heading_suffix)
            .filter(|line| !line.is_empty())
    })
}

fn markdown_heading(line: &str) -> Option<String> {
    let line = line.trim_start();
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&hashes) || !line[hashes..].starts_with(' ') {
        return None;
    }
    let heading = trim_heading_suffix(&line[(hashes + 1)..]);
    (!heading.is_empty()).then_some(heading)
}

fn trim_heading_suffix(line: &str) -> String {
    line.trim().trim_end_matches('#').trim_end().to_string()
}

fn first_nonempty_line(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn strip_outline_marker(line: String) -> String {
    let trimmed = line.trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(value) = trimmed.strip_prefix(marker) {
            return value.trim().to_string();
        }
    }
    if let Some((number, value)) = trimmed.split_once(". ") {
        if number.chars().all(|character| character.is_ascii_digit()) {
            return value.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn truncate_chars(value: String, maximum: usize) -> String {
    if value.chars().count() <= maximum {
        return value;
    }
    let mut result = value.chars().take(maximum).collect::<String>();
    result = result.trim_end().to_string();
    result.push('…');
    result
}

pub fn parse_modified_at(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

fn system_time_rfc3339(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

pub fn system_time_nanos(value: Option<SystemTime>) -> u128 {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

/// 把搜索目标的相对路径解析成资料库里的普通文件：拒绝 `..`、绝对路径、反斜杠、隐藏目录（`.trash` 根除外）、
/// 范围外的根、错误扩展名与任何一级符号链接，最后再用 canonicalize 确认没逃出资料库。
pub fn resolve_target_file(
    vfs: &dyn Vfs,
    relative: &str,
    scope: &SearchScope,
) -> Result<PathBuf, SearchError> {
    let parts = validate_relative_parts(relative)?;
    let contains_hidden_component = parts
        .iter()
        .enumerate()
        .any(|(index, part)| part.starts_with('.') && !(index == 0 && *part == ".trash"));
    let valid_root = match scope {
        SearchScope::Public => match parts.as_slice() {
            [root, ..] if *root == "fragments" || *root == "notes" => true,
            [trash, root, ..]
                if *trash == ".trash" && (*root == "fragments" || *root == "notes") =>
            {
                true
            }
            _ => false,
        },
        SearchScope::Lockbox => matches!(
            parts.as_slice(),
            ["lockbox", root, ..] if matches!(*root, "fragments" | "archive" | "notes")
        ),
    };
    let extension_valid = match scope {
        SearchScope::Public => relative.ends_with(".md"),
        SearchScope::Lockbox => relative.ends_with(".shard"),
    };
    if contains_hidden_component || !valid_root || !extension_valid {
        return Err(SearchError::InvalidRequest {
            reason: "invalidTargetPath".to_string(),
        });
    }
    resolve_regular_file(vfs, &parts)
}

pub fn resolve_csv_file(vfs: &dyn Vfs, relative: &str) -> Result<PathBuf, SearchError> {
    let parts = validate_relative_parts(relative)?;
    if parts
        .iter()
        .any(|part| part.starts_with('.') || part.eq_ignore_ascii_case("lockbox"))
        || !relative.to_ascii_lowercase().ends_with(".csv")
    {
        return Err(SearchError::InvalidRequest {
            reason: "invalidTargetPath".to_string(),
        });
    }
    resolve_regular_file(vfs, &parts)
}

fn validate_relative_parts(relative: &str) -> Result<Vec<&str>, SearchError> {
    if relative.is_empty() || relative.contains('\\') || Path::new(relative).is_absolute() {
        return Err(SearchError::InvalidRequest {
            reason: "invalidTargetPath".to_string(),
        });
    }
    let parts = relative.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(SearchError::InvalidRequest {
            reason: "invalidTargetPath".to_string(),
        });
    }
    Ok(parts)
}

fn resolve_regular_file(vfs: &dyn Vfs, parts: &[&str]) -> Result<PathBuf, SearchError> {
    let vault = vfs.root();
    let mut target = vault.to_path_buf();
    for part in parts {
        target.push(part);
        let metadata = vfs.symlink_metadata(&target).map_err(fs_error)?;
        if metadata.is_symlink() {
            return Err(SearchError::InvalidRequest {
                reason: "symlinkTarget".to_string(),
            });
        }
    }
    if !vfs.is_file(&target) {
        return Err(SearchError::NotFound);
    }
    let canonical_vault = vfs.canonicalize(vault).map_err(fs_error)?;
    let canonical_target = vfs.canonicalize(&target).map_err(fs_error)?;
    if !canonical_target.starts_with(canonical_vault) {
        return Err(SearchError::InvalidRequest {
            reason: "pathEscape".to_string(),
        });
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// CSV 表头
// ---------------------------------------------------------------------------

/// 解析表头字节（[`read_csv_header_bytes`] 的结果）为字段列表；非 UTF-8 或引号没闭合报 `UnsupportedTarget`。
pub fn parse_csv_header(bytes: &[u8]) -> Result<Vec<String>, SearchError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SearchError::UnsupportedTarget)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut characters = text.chars().peekable();
    let mut quoted = false;
    let mut started = false;

    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }

        match character {
            '"' if !started && field.is_empty() => {
                quoted = true;
                started = true;
            }
            ',' => {
                fields.push(std::mem::take(&mut field));
                started = false;
            }
            '\r' | '\n' => {
                fields.push(field);
                return Ok(fields);
            }
            _ => {
                field.push(character);
                started = true;
            }
        }
    }
    if quoted {
        return Err(SearchError::UnsupportedTarget);
    }
    fields.push(field);
    Ok(fields)
}

/// 读到表头行结束（引号外的第一个换行，含换行符）为止的原始字节，BOM 原样保留。
/// 先读 8 KiB，表头更长再读到上限；超过 [`CSV_HEADER_MAX_BYTES`] 或引号没闭合报 `UnsupportedTarget`。
pub fn read_csv_header_bytes(vfs: &dyn Vfs, path: &Path) -> Result<Vec<u8>, SearchError> {
    let mut limit = CSV_HEADER_FIRST_READ;
    loop {
        let head = vfs.read_head(path, limit).map_err(fs_error)?;
        // 读到的比要的少，说明整个文件都在 head 里。
        let whole_file = (head.len() as u64) < limit;
        if let Some(bytes) = csv_header_prefix(&head, whole_file)? {
            return Ok(bytes);
        }
        if limit > CSV_HEADER_MAX_BYTES {
            // 上限 + 1 字节的窗口里一定能得出结论；走到这里只可能是实现被改坏了。
            return Err(SearchError::UnsupportedTarget);
        }
        limit = CSV_HEADER_MAX_BYTES + 1;
    }
}

/// 表头状态机，跑在文件开头 `head` 上（与迁移前逐字节读 `BufReader` 的判定完全相同）。
/// `whole_file` 为假且 `head` 不够下结论时返回 `Ok(None)`，由调用方读更长的开头再来。
fn csv_header_prefix(head: &[u8], whole_file: bool) -> Result<Option<Vec<u8>>, SearchError> {
    const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
    let mut bytes = Vec::new();
    let mut position = 0usize;
    let mut quoted = false;
    let mut field_start = true;

    if head.starts_with(&BOM) {
        bytes.extend_from_slice(&BOM);
        position = BOM.len();
    }

    loop {
        if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
            return Err(SearchError::UnsupportedTarget);
        }
        let Some(&byte) = head.get(position) else {
            if !whole_file {
                return Ok(None);
            }
            return if quoted {
                Err(SearchError::UnsupportedTarget)
            } else {
                Ok(Some(bytes))
            };
        };
        position += 1;
        bytes.push(byte);

        if quoted {
            if byte == b'"' {
                match head.get(position) {
                    Some(b'"') => {
                        if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
                            return Err(SearchError::UnsupportedTarget);
                        }
                        bytes.push(b'"');
                        position += 1;
                    }
                    Some(_) => quoted = false,
                    None if whole_file => quoted = false,
                    None => return Ok(None),
                }
            }
            continue;
        }

        match byte {
            b'"' if field_start => {
                quoted = true;
                field_start = false;
            }
            b',' => field_start = true,
            b'\r' | b'\n' => return Ok(Some(bytes)),
            _ => field_start = false,
        }
    }
}

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

/// 领域函数的字符串错误：一律当作不可重试的 IO 错误。
pub fn io_error(_: impl ToString) -> SearchError {
    SearchError::Io { retryable: false }
}

/// 文件系统错误：不存在报 `NotFound`，其他可重试。
pub fn fs_error(error: io::Error) -> SearchError {
    if error.kind() == io::ErrorKind::NotFound {
        SearchError::NotFound
    } else {
        SearchError::Io { retryable: true }
    }
}
