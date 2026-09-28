use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use chrono::{DateTime, Utc};
use shard_core::{
    derive_type,
    graph_region::{find_region, GraphRegionKind},
    search::{
        project_document, DocumentOnlyReason, ProjectedDocument, SearchProjection,
        SearchProjectionBlock, SourceDocument,
    },
    FragmentFrontmatter,
};

use crate::{
    canvas_commands,
    search_contract::{
        SearchContext, SearchError, SearchKind, SearchRefresh, SearchRevealHint, SearchScope,
        SearchTarget,
    },
    search_index::{CachedDoc, CachedFile, IndexEntry, IndexRegistry, IndexStore},
    search_lockbox::{peek_lockbox_read_lease, LockboxReadLease},
    search_runtime::{SearchBuildRequest, SearchRuntime, SearchSnapshotDraft},
    table_commands, Fragment, LockboxRuntime, ShardMapFile,
};

const CSV_HEADER_MAX_BYTES: u64 = 1024 * 1024;
const SEARCH_SCAN_MAX_ENTRIES: usize = 100_000;
const RACY_WINDOW_NS: i128 = 2_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicSourceKind {
    Markdown,
    MindMap,
    Canvas,
    Table,
    Csv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileStamp {
    mtime_ns: i128,
    size: u64,
    ino: u64,
    ctime_ns: i128,
}

impl FileStamp {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            Self {
                mtime_ns: i128::from(metadata.mtime()) * 1_000_000_000
                    + i128::from(metadata.mtime_nsec()),
                size: metadata.len(),
                ino: metadata.ino(),
                ctime_ns: i128::from(metadata.ctime()) * 1_000_000_000
                    + i128::from(metadata.ctime_nsec()),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                mtime_ns: system_time_nanos(metadata.modified().ok()) as i128,
                size: metadata.len(),
                ino: 0,
                ctime_ns: 0,
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SourceRecord {
    kind: PublicSourceKind,
    stamp: FileStamp,
    indexed_at_ns: i128,
    revision: String,
    parse_error: bool,
}

struct PublicSource {
    path: PathBuf,
    relative: String,
    kind: PublicSourceKind,
    stamp: FileStamp,
}

#[derive(Debug, Clone)]
pub(crate) struct SearchDocumentMetadata {
    pub(crate) target: SearchTarget,
    pub(crate) updated_at: Option<String>,
    pub(crate) revision: String,
    pub(crate) reveal_hint: SearchRevealHint,
    pub(crate) read_only: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedSearchDocument {
    pub(crate) projected: ProjectedDocument,
    pub(crate) metadata: SearchDocumentMetadata,
    pub(crate) fragment: Option<Fragment>,
}

pub(crate) struct PublicIndexBatch(Vec<IndexEntry>);

impl PublicIndexBatch {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn push(&mut self, entry: IndexEntry) {
        self.0.push(entry);
    }

    pub(crate) fn entries(&self) -> &[IndexEntry] {
        &self.0
    }
}

pub(crate) fn install_snapshot_builder(
    runtime: &SearchRuntime,
    lockbox_runtime: &LockboxRuntime,
    index_registry: Arc<IndexRegistry>,
) {
    let lockbox_runtime = lockbox_runtime.clone();
    runtime.install_snapshot_builder(move |request| {
        build_snapshot_with_index(request, &lockbox_runtime, Some(&index_registry))
    });
}

#[allow(dead_code)] // Existing direct-builder tests keep the no-index entry point.
fn build_snapshot(
    request: SearchBuildRequest,
    lockbox_runtime: &LockboxRuntime,
) -> Result<SearchSnapshotDraft, SearchError> {
    build_snapshot_with_index(request, lockbox_runtime, None)
}

pub(crate) fn build_snapshot_with_index(
    request: SearchBuildRequest,
    lockbox_runtime: &LockboxRuntime,
    index_registry: Option<&IndexRegistry>,
) -> Result<SearchSnapshotDraft, SearchError> {
    let vault = PathBuf::from(&request.context.vault_path);
    if !vault.is_dir() {
        return Err(SearchError::Io { retryable: false });
    }
    let (mut loaded, skipped_files, authorization, sources) = match request.scope {
        SearchScope::Public => {
            let index = index_registry.and_then(|registry| registry.open(&vault));
            let (loaded, skipped, sources) =
                load_public_documents(&vault, &request, index.as_deref(), false)?;
            (loaded, skipped, None, sources)
        }
        SearchScope::Lockbox => {
            let lease = peek_lockbox_read_lease(&vault, lockbox_runtime)?;
            lease.validate(&request.context)?;
            let (loaded, skipped) = load_lockbox_documents(&vault, &lease)?;
            lease.validate(&request.context)?;
            (loaded, skipped, Some(lease.authorization()), HashMap::new())
        }
    };
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
    let source_stamp = crate::hash_text(&stamp_input);
    let scope = scope_wire(&request.scope);
    let snapshot_id = crate::hash_text(&format!(
        "{}\0{}\0{}\0{}\0{}",
        request.context.vault_path,
        request.context.vault_epoch,
        request.context.privacy_epoch,
        scope,
        source_stamp
    ));

    Ok(SearchSnapshotDraft {
        snapshot_id,
        source_stamp,
        documents,
        metadata,
        sources,
        skipped_files,
        authorization,
    })
}

fn load_public_documents(
    vault: &Path,
    request: &SearchBuildRequest,
    index: Option<&IndexStore>,
    strict_index: bool,
) -> Result<
    (
        Vec<LoadedSearchDocument>,
        u32,
        HashMap<String, SourceRecord>,
    ),
    SearchError,
> {
    let (enumerated, mut skipped) = enumerate_public_sources(vault)?;
    let mut documents = Vec::with_capacity(enumerated.len());
    let mut sources = HashMap::with_capacity(enumerated.len());
    let previous = request.previous.as_deref();
    let cached = index.and_then(|store| match store.load_files() {
        Ok(files) => Some(files),
        Err(error) => {
            store.discard_if_corrupt(&error);
            None
        }
    });
    if strict_index && cached.is_none() {
        return Err(SearchError::Io { retryable: true });
    }
    let force_read_all = matches!(request.refresh, SearchRefresh::Rebuild)
        || (request.force_read_all && cached.is_none());
    let mut index_batch = PublicIndexBatch::new();
    let mut current_paths = std::collections::HashSet::with_capacity(enumerated.len());
    let previous_documents: HashMap<&str, &ProjectedDocument> = previous
        .map(|snapshot| {
            snapshot
                .documents
                .iter()
                .map(|document| (document.stable_key.as_str(), document))
                .collect()
        })
        .unwrap_or_default();

    for source in enumerated {
        let library_source = crate::is_library_reference_source(Path::new(&source.relative));
        current_paths.insert(source.relative.clone());
        let cached_file = cached
            .as_ref()
            .and_then(|files| files.get(&source.relative));
        let cached_record = cached_file.and_then(cached_source_record);
        let old = previous
            .and_then(|snapshot| snapshot.sources.get(&source.relative))
            .or(cached_record.as_ref());
        let cached_current = cached_record
            .as_ref()
            .is_some_and(|record| record.kind == source.kind && record.stamp == source.stamp);
        let same_source =
            old.is_some_and(|record| record.kind == source.kind && record.stamp == source.stamp);
        let trusted = !force_read_all
            && same_source
            && old.is_some_and(|record| {
                source.stamp.mtime_ns.saturating_add(RACY_WINDOW_NS) < record.indexed_at_ns
            });
        let old_document = || {
            let key = target_key(
                &request.context.vault_path,
                &SearchScope::Public,
                &source.relative,
            );
            if let (Some(metadata), Some(projected)) = (
                previous.and_then(|snapshot| snapshot.metadata.get(&key)),
                previous_documents.get(key.as_str()),
            ) {
                if old?.revision == metadata.revision {
                    return Some(LoadedSearchDocument {
                        projected: (*projected).clone(),
                        metadata: metadata.clone(),
                        fragment: None,
                    });
                }
            }
            cached_file
                .filter(|_| cached_current)
                .and_then(|row| decode_cached_document(vault, row))
        };
        if trusted {
            if old.is_some_and(|record| record.parse_error) {
                skipped = skipped.saturating_add(1);
                if index.is_some() && !cached_current {
                    let references = read_asset_references(&source.path, library_source);
                    if strict_index && references.is_err() {
                        return Err(SearchError::Io { retryable: true });
                    }
                    if let Ok(references) = references {
                        index_batch.push(index_entry(
                            &source.relative,
                            old.unwrap(),
                            None,
                            references,
                        ));
                    }
                }
                sources.insert(source.relative, old.unwrap().clone());
                continue;
            }
            if let Some(document) = old_document() {
                if index.is_some()
                    && (!cached_current || cached_file.is_some_and(|row| row.doc.is_none()))
                {
                    let references = read_asset_references(&source.path, library_source);
                    if strict_index && references.is_err() {
                        return Err(SearchError::Io { retryable: true });
                    }
                    if let Ok(references) = references {
                        index_batch.push(index_entry(
                            &source.relative,
                            old.unwrap(),
                            Some(encode_cached_document(&document)),
                            references,
                        ));
                    }
                }
                documents.push(document);
                sources.insert(source.relative, old.unwrap().clone());
                continue;
            }
        }

        let mut references_from_text = None;
        let loaded = if source.kind == PublicSourceKind::Markdown {
            // Reuse the same Markdown read for projection and asset extraction.
            read_public_markdown_text(vault, &source.path).and_then(|(text, revision)| {
                references_from_text = Some(if library_source {
                    crate::extract_asset_references(&text)
                } else {
                    Vec::new()
                });
                if !force_read_all
                    && old.is_some_and(|record| !record.parse_error && record.revision == revision)
                {
                    if let Some(document) = old_document() {
                        return Ok(document);
                    }
                }
                load_public_markdown_text(vault, &source.path, &text, revision)
            })
        } else {
            load_public_source(vault, &source)
        };
        let indexed_at_ns = now_ns();
        let (revision, parse_error, cached_doc) = match loaded {
            Ok(document) => {
                let revision = document.metadata.revision.clone();
                let cached_doc = encode_cached_document(&document);
                documents.push(document);
                (revision, false, Some(cached_doc))
            }
            Err(_) => {
                skipped = skipped.saturating_add(1);
                (String::new(), true, None)
            }
        };
        let record = SourceRecord {
            kind: source.kind,
            stamp: source.stamp,
            indexed_at_ns,
            revision,
            parse_error,
        };
        if index.is_some() {
            let references = references_from_text
                .map(Ok)
                .unwrap_or_else(|| read_asset_references(&source.path, library_source));
            if strict_index && references.is_err() {
                return Err(SearchError::Io { retryable: true });
            }
            if let Ok(references) = references {
                index_batch.push(index_entry(
                    &source.relative,
                    &record,
                    cached_doc,
                    references,
                ));
            }
        }
        sources.insert(source.relative, record);
    }
    if let Some(index) = index {
        let stale = cached
            .as_ref()
            .map(|files| {
                files
                    .keys()
                    .filter(|path| !current_paths.contains(*path))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Err(error) = index.apply(&index_batch, &stale) {
            index.discard_if_corrupt(&error);
            if strict_index {
                return Err(SearchError::Io { retryable: true });
            }
        }
    }
    Ok((documents, skipped, sources))
}

fn source_kind_name(kind: PublicSourceKind) -> &'static str {
    match kind {
        PublicSourceKind::Markdown => "markdown",
        PublicSourceKind::MindMap => "mindMap",
        PublicSourceKind::Canvas => "canvas",
        PublicSourceKind::Table => "table",
        PublicSourceKind::Csv => "csv",
    }
}

fn cached_source_record(file: &CachedFile) -> Option<SourceRecord> {
    let kind = match file.source_kind.as_str() {
        "markdown" => PublicSourceKind::Markdown,
        "mindMap" => PublicSourceKind::MindMap,
        "canvas" => PublicSourceKind::Canvas,
        "table" => PublicSourceKind::Table,
        "csv" => PublicSourceKind::Csv,
        _ => return None,
    };
    Some(SourceRecord {
        kind,
        stamp: FileStamp {
            mtime_ns: file.mtime_ns,
            size: file.size,
            ino: file.ino,
            ctime_ns: file.ctime_ns,
        },
        indexed_at_ns: file.indexed_at_ns,
        revision: file.content_hash.clone(),
        parse_error: file.parse_error,
    })
}

fn encode_cached_document(document: &LoadedSearchDocument) -> CachedDoc {
    let kind = serde_json::to_value(&document.metadata.target.kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    CachedDoc {
        search_kind: kind,
        object_id: document.metadata.target.object_id.clone(),
        archived: document.metadata.target.archived,
        title: document.projected.title.clone(),
        tags: document.projected.tags.clone(),
        updated_at: document.metadata.updated_at.clone(),
        revision: document.metadata.revision.clone(),
        projection_version: document.projected.projection.version,
        blocks: document.projected.projection.blocks.clone(),
    }
}

fn decode_cached_document(vault: &Path, file: &CachedFile) -> Option<LoadedSearchDocument> {
    if file.parse_error {
        return None;
    }
    let doc = file.doc.as_ref()?;
    if doc.projection_version != 1 || doc.revision != file.content_hash {
        return None;
    }
    let kind: SearchKind =
        serde_json::from_value(serde_json::Value::String(doc.search_kind.clone())).ok()?;
    let archived =
        file.path.starts_with(".trash/fragments/") || file.path.starts_with(".trash/notes/");
    let target = make_target(
        vault,
        SearchScope::Public,
        file.path.clone(),
        kind,
        doc.object_id.clone(),
        archived,
    );
    let reveal_hint = match target.kind {
        SearchKind::Fragment | SearchKind::Note | SearchKind::Outline | SearchKind::Document => {
            SearchRevealHint::Text
        }
        SearchKind::Csv => SearchRevealHint::External,
        _ => SearchRevealHint::DocumentOnly,
    };
    let projected = ProjectedDocument::from_projection(
        &SourceDocument {
            stable_key: target.key.clone(),
            title: doc.title.clone(),
            tags: doc.tags.clone(),
            body: String::new(),
            modified_at: doc
                .updated_at
                .as_deref()
                .map(parse_modified_at)
                .unwrap_or(0),
        },
        SearchProjection::from_blocks(doc.blocks.clone()),
    );
    Some(LoadedSearchDocument {
        projected,
        metadata: SearchDocumentMetadata {
            target,
            updated_at: doc.updated_at.clone(),
            revision: doc.revision.clone(),
            reveal_hint,
            read_only: true,
        },
        fragment: None,
    })
}

fn index_entry(
    relative: &str,
    record: &SourceRecord,
    doc: Option<CachedDoc>,
    asset_references: Vec<String>,
) -> IndexEntry {
    IndexEntry {
        path: relative.to_string(),
        source_kind: source_kind_name(record.kind).to_string(),
        mtime_ns: record.stamp.mtime_ns,
        size: record.stamp.size,
        ino: record.stamp.ino,
        ctime_ns: record.stamp.ctime_ns,
        indexed_at_ns: record.indexed_at_ns,
        content_hash: record.revision.clone(),
        parse_error: record.parse_error,
        doc,
        asset_references,
    }
}

fn read_asset_references(path: &Path, library_source: bool) -> std::io::Result<Vec<String>> {
    if !library_source {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let mut references = std::collections::HashSet::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        references.extend(crate::extract_asset_references(&line));
    }
    Ok(references.into_iter().collect())
}

pub(crate) fn sync_public(vault: &Path, index: &IndexStore) -> Result<(), SearchError> {
    let request = SearchBuildRequest {
        context: SearchContext {
            vault_path: vault.to_string_lossy().into_owned(),
            vault_epoch: String::new(),
            privacy_epoch: String::new(),
        },
        scope: SearchScope::Public,
        refresh: SearchRefresh::Reconcile,
        start_generation: 0,
        force_read_all: false,
        previous: None,
    };
    load_public_documents(vault, &request, Some(index), true).map(|_| ())
}

fn now_ns() -> i128 {
    system_time_nanos(Some(SystemTime::now())) as i128
}

fn load_public_source(
    vault: &Path,
    source: &PublicSource,
) -> Result<LoadedSearchDocument, SearchError> {
    match source.kind {
        PublicSourceKind::Markdown => load_public_markdown(vault, &source.path),
        PublicSourceKind::MindMap => {
            note_source_read();
            load_mind_map(vault, &source.path)
        }
        PublicSourceKind::Canvas => {
            note_source_read();
            load_canvas(vault, &source.relative)
        }
        PublicSourceKind::Table => {
            note_source_read();
            load_table(vault, &source.relative)
        }
        PublicSourceKind::Csv => {
            note_source_read();
            load_csv(vault, &source.path)
        }
    }
}

#[cfg(test)]
thread_local! { static SOURCE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

#[cfg(test)]
fn note_source_read() {
    SOURCE_READS.with(|reads| reads.set(reads.get() + 1));
}

#[cfg(not(test))]
fn note_source_read() {}

fn enumerate_public_sources(vault: &Path) -> Result<(Vec<PublicSource>, u32), SearchError> {
    let mut sources = Vec::new();
    let mut skipped = 0u32;

    for relative_root in ["fragments", "notes", ".trash/fragments", ".trash/notes"] {
        let (root, unsafe_root) = safe_scan_root(vault, relative_root)?;
        if unsafe_root {
            skipped = skipped.saturating_add(1);
        }
        let Some(root) = root else {
            continue;
        };
        let mut files = Vec::new();
        crate::collect_markdown_files(&root, &mut files).map_err(io_error)?;
        for path in files {
            push_public_source(
                vault,
                path,
                PublicSourceKind::Markdown,
                &mut sources,
                &mut skipped,
            )?;
        }
    }

    let mut visited = 0usize;
    let (notes_root, _) = safe_scan_root(vault, "notes")?;
    let (maps_root, maps_unsafe) = safe_scan_root(vault, "maps")?;
    if maps_unsafe {
        skipped = skipped.saturating_add(1);
    }
    let mut mind_maps = Vec::new();
    if let Some(notes_root) = &notes_root {
        canvas_commands::scan_files(notes_root, ".shardmap.json", &mut mind_maps, &mut visited)
            .map_err(io_error)?;
    }
    // Legacy maps can exist before the existing migration runs. Hidden recovery folders
    // are already excluded by the shared typed scanner.
    if let Some(maps_root) = &maps_root {
        canvas_commands::scan_files(maps_root, ".shardmap.json", &mut mind_maps, &mut visited)
            .map_err(io_error)?;
    }
    for path in mind_maps {
        push_public_source(
            vault,
            path,
            PublicSourceKind::MindMap,
            &mut sources,
            &mut skipped,
        )?;
    }

    for suffix in [".shardcanvas.json", ".shardflow.json"] {
        let mut files = Vec::new();
        if let Some(notes_root) = &notes_root {
            canvas_commands::scan_files(notes_root, suffix, &mut files, &mut visited)
                .map_err(io_error)?;
        }
        for path in files {
            push_public_source(
                vault,
                path,
                PublicSourceKind::Canvas,
                &mut sources,
                &mut skipped,
            )?;
        }
    }

    let mut tables = Vec::new();
    if let Some(notes_root) = &notes_root {
        canvas_commands::scan_files(notes_root, ".shardtable.json", &mut tables, &mut visited)
            .map_err(io_error)?;
    }
    for path in tables {
        push_public_source(
            vault,
            path,
            PublicSourceKind::Table,
            &mut sources,
            &mut skipped,
        )?;
    }

    let mut csv_files = Vec::new();
    collect_public_csv_files(vault, vault, &mut csv_files, &mut visited, &mut skipped)?;
    for path in csv_files {
        push_public_source(
            vault,
            path,
            PublicSourceKind::Csv,
            &mut sources,
            &mut skipped,
        )?;
    }

    skipped = skipped.saturating_add(count_structured_trash(vault)?);
    Ok((sources, skipped))
}

fn push_public_source(
    vault: &Path,
    path: PathBuf,
    kind: PublicSourceKind,
    sources: &mut Vec<PublicSource>,
    skipped: &mut u32,
) -> Result<(), SearchError> {
    let relative = crate::relative_path(vault, &path).map_err(io_error)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            sources.push(PublicSource {
                path,
                relative,
                kind,
                stamp: FileStamp::from_metadata(&metadata),
            });
        }
        _ => *skipped = skipped.saturating_add(1),
    }
    Ok(())
}

fn load_lockbox_documents(
    vault: &Path,
    lease: &LockboxReadLease,
) -> Result<(Vec<LoadedSearchDocument>, u32), SearchError> {
    let mut files = Vec::new();
    let mut skipped = 0u32;
    let mut visited = 0usize;
    for relative_root in ["lockbox/fragments", "lockbox/archive", "lockbox/notes"] {
        let (root, unsafe_root) = safe_scan_root(vault, relative_root)?;
        if unsafe_root {
            skipped = skipped.saturating_add(1);
        }
        let Some(root) = root else {
            continue;
        };
        collect_lockbox_files(&root, &mut files, &mut visited, &mut skipped)?;
    }

    let mut documents = Vec::new();
    for path in files {
        match load_lockbox_markdown(vault, &path, lease) {
            Ok(document) => documents.push(document),
            Err(_) => skipped = skipped.saturating_add(1),
        }
    }
    lease.validate_session()?;
    Ok((documents, skipped))
}

/// Read exactly one saved Markdown object. Callers use a renewed lease only for an
/// explicit result selection; background indexing passes a non-renewing lease instead.
pub(crate) fn read_search_document(
    context: &SearchContext,
    target: &SearchTarget,
    lease: Option<&LockboxReadLease>,
) -> Result<LoadedSearchDocument, SearchError> {
    validate_target_context(context, target)?;
    crate::search_runtime::validate_context(context)?;
    let document = read_search_document_from_disk(context, target, lease)?;
    if let Some(lease) = lease {
        lease.validate(context)?;
    }
    crate::search_runtime::validate_context(context)?;
    Ok(document)
}

fn read_search_document_from_disk(
    context: &SearchContext,
    target: &SearchTarget,
    lease: Option<&LockboxReadLease>,
) -> Result<LoadedSearchDocument, SearchError> {
    let vault = Path::new(&context.vault_path);
    let markdown_kind = matches!(
        target.kind,
        SearchKind::Fragment | SearchKind::Note | SearchKind::Outline | SearchKind::Document
    ) || matches!(target.kind, SearchKind::Flowchart)
        && target.path.to_ascii_lowercase().ends_with(".md");
    if !markdown_kind {
        return Err(SearchError::UnsupportedTarget);
    }

    let path = resolve_target_file(vault, &target.path, &target.scope)?;
    let document = match target.scope {
        SearchScope::Public => load_public_markdown(vault, &path)?,
        SearchScope::Lockbox => {
            let lease = lease.ok_or(SearchError::Locked)?;
            lease.validate(context)?;
            load_lockbox_markdown(vault, &path, lease)?
        }
    };
    validate_loaded_identity(target, &document.metadata.target)?;
    Ok(document)
}

fn validate_target_context(
    context: &SearchContext,
    target: &SearchTarget,
) -> Result<(), SearchError> {
    if context.vault_path != target.vault_path {
        return Err(SearchError::VaultChanged);
    }
    if target.key != target_key(&target.vault_path, &target.scope, &target.path) {
        return Err(SearchError::TargetChanged);
    }
    Ok(())
}

fn validate_loaded_identity(
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

fn load_public_markdown(vault: &Path, path: &Path) -> Result<LoadedSearchDocument, SearchError> {
    let (text, revision) = read_public_markdown_text(vault, path)?;
    load_public_markdown_text(vault, path, &text, revision)
}

fn read_public_markdown_text(vault: &Path, path: &Path) -> Result<(String, String), SearchError> {
    let relative = crate::relative_path(vault, path).map_err(io_error)?;
    let safe_path = resolve_target_file(vault, &relative, &SearchScope::Public)?;
    note_source_read();
    let text = fs::read_to_string(safe_path).map_err(fs_error)?;
    let revision = crate::hash_text(&text);
    Ok((text, revision))
}

fn load_public_markdown_text(
    vault: &Path,
    path: &Path,
    text: &str,
    revision: String,
) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vault, path).map_err(io_error)?;
    let (frontmatter, body) =
        crate::parse_fragment_text(text).map_err(|_| SearchError::UnsupportedTarget)?;
    let archived =
        relative.starts_with(".trash/fragments/") || relative.starts_with(".trash/notes/");
    Ok(markdown_document(
        vault,
        SearchScope::Public,
        relative,
        archived,
        frontmatter,
        body,
        revision.clone(),
        revision,
    ))
}

fn load_lockbox_markdown(
    vault: &Path,
    path: &Path,
    lease: &LockboxReadLease,
) -> Result<LoadedSearchDocument, SearchError> {
    lease.validate_session()?;
    let relative = crate::relative_path(vault, path).map_err(io_error)?;
    let safe_path = resolve_target_file(vault, &relative, &SearchScope::Lockbox)?;
    note_source_read();
    let encrypted_text = fs::read_to_string(&safe_path).map_err(fs_error)?;
    let file_sha = crate::content_sha256_hex(&encrypted_text);
    let payload = crate::read_lockbox_payload(&safe_path, lease.read_keys())
        .map_err(|_| SearchError::Io { retryable: false })?;
    let revision = serde_json::to_vec(&payload)
        .map(|bytes| crate::hash_bytes(&bytes))
        .map_err(|_| SearchError::Internal { retryable: false })?;
    lease.validate_session()?;
    Ok(markdown_document(
        vault,
        SearchScope::Lockbox,
        relative.clone(),
        relative.starts_with("lockbox/archive/"),
        payload.frontmatter,
        &payload.body,
        revision,
        file_sha,
    ))
}

#[allow(clippy::too_many_arguments)]
fn markdown_document(
    vault: &Path,
    scope: SearchScope,
    relative: String,
    archived: bool,
    frontmatter: FragmentFrontmatter,
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
        vault,
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
        conflict_of: frontmatter.conflict_of,
    };
    LoadedSearchDocument {
        projected,
        metadata,
        fragment: Some(fragment),
    }
}

fn load_mind_map(vault: &Path, path: &Path) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vault, path).map_err(io_error)?;
    let (file, text) = crate::read_mind_map_file(path).map_err(io_error)?;
    crate::validate_mind_map_file(vault, &file).map_err(io_error)?;
    let body = shard_core::graph_model::mind_map_search_text(&file);
    Ok(structured_document(
        vault,
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

fn load_canvas(vault: &Path, relative: &str) -> Result<LoadedSearchDocument, SearchError> {
    let document = canvas_commands::read_search_document(vault, relative).map_err(io_error)?;
    let kind = if document.kind == "shard.flow" {
        SearchKind::Flowchart
    } else {
        SearchKind::Canvas
    };
    Ok(structured_document(
        vault,
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

fn load_table(vault: &Path, relative: &str) -> Result<LoadedSearchDocument, SearchError> {
    let document = table_commands::read_search_document(vault, relative)
        .map_err(|_| SearchError::Io { retryable: false })?;
    Ok(structured_document(
        vault,
        relative.to_string(),
        SearchKind::Table,
        Some(document.id),
        document.title,
        document.updated_at,
        document.revision,
        document.body,
        SearchRevealHint::DocumentOnly,
    ))
}

fn load_csv(vault: &Path, path: &Path) -> Result<LoadedSearchDocument, SearchError> {
    let relative = crate::relative_path(vault, path).map_err(io_error)?;
    let safe_path = resolve_csv_file(vault, &relative)?;
    let metadata = fs::metadata(&safe_path).map_err(fs_error)?;
    let bytes = read_csv_header_bytes(&safe_path)?;
    let headers = parse_csv_header(&bytes).map_err(|_| SearchError::UnsupportedTarget)?;
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
        vault,
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
fn structured_document(
    vault: &Path,
    relative: String,
    kind: SearchKind,
    object_id: Option<String>,
    title: String,
    updated_at: String,
    revision: String,
    body: String,
    reveal_hint: SearchRevealHint,
) -> LoadedSearchDocument {
    let target = make_target(vault, SearchScope::Public, relative, kind, object_id, false);
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

fn make_target(
    vault: &Path,
    scope: SearchScope,
    path: String,
    kind: SearchKind,
    object_id: Option<String>,
    archived: bool,
) -> SearchTarget {
    let vault_path = vault.display().to_string();
    SearchTarget {
        key: target_key(&vault_path, &scope, &path),
        vault_path,
        scope,
        path,
        kind,
        object_id,
        archived,
    }
}

fn target_key(vault_path: &str, scope: &SearchScope, path: &str) -> String {
    serde_json::to_string(&(vault_path, scope_wire(scope), path))
        .expect("search target key is serializable")
}

fn scope_wire(scope: &SearchScope) -> &'static str {
    match scope {
        SearchScope::Public => "public",
        SearchScope::Lockbox => "lockbox",
    }
}

fn markdown_kind(tags: &[String]) -> SearchKind {
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
            let file =
                serde_json::from_str::<canvas_commands::CanvasFile>(&region.json_text).ok()?;
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
                text: canvas_commands::search_text(&file),
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

fn markdown_title(kind: &SearchKind, body: &str) -> String {
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

fn parse_modified_at(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

fn system_time_rfc3339(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn system_time_nanos(value: Option<SystemTime>) -> u128 {
    value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn resolve_target_file(
    vault: &Path,
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
    resolve_regular_file(vault, &parts)
}

fn resolve_csv_file(vault: &Path, relative: &str) -> Result<PathBuf, SearchError> {
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
    resolve_regular_file(vault, &parts)
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

fn resolve_regular_file(vault: &Path, parts: &[&str]) -> Result<PathBuf, SearchError> {
    let mut target = vault.to_path_buf();
    for part in parts {
        target.push(part);
        let metadata = fs::symlink_metadata(&target).map_err(fs_error)?;
        if metadata.file_type().is_symlink() {
            return Err(SearchError::InvalidRequest {
                reason: "symlinkTarget".to_string(),
            });
        }
    }
    if !target.is_file() {
        return Err(SearchError::NotFound);
    }
    let canonical_vault = vault.canonicalize().map_err(fs_error)?;
    let canonical_target = target.canonicalize().map_err(fs_error)?;
    if !canonical_target.starts_with(canonical_vault) {
        return Err(SearchError::InvalidRequest {
            reason: "pathEscape".to_string(),
        });
    }
    Ok(target)
}

/// Resolve a fixed source root without following any component symlink. Missing roots
/// are normal for partially initialized vaults; unsafe roots are reported to skipped_files.
fn safe_scan_root(vault: &Path, relative: &str) -> Result<(Option<PathBuf>, bool), SearchError> {
    let mut root = vault.to_path_buf();
    for part in relative.split('/') {
        root.push(part);
        match fs::symlink_metadata(&root) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Ok((None, true));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((None, false));
            }
            Err(error) => return Err(fs_error(error)),
        }
    }
    Ok((Some(root), false))
}

fn collect_lockbox_files(
    root: &Path,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
    skipped: &mut u32,
) -> Result<(), SearchError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(fs_error(error)),
    };
    if metadata.file_type().is_symlink() {
        *skipped = skipped.saturating_add(1);
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(fs_error)? {
        let entry = entry.map_err(fs_error)?;
        *visited += 1;
        if *visited > SEARCH_SCAN_MAX_ENTRIES {
            return Err(SearchError::Io { retryable: false });
        }
        let kind = entry.file_type().map_err(fs_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink() || name.starts_with('.') {
            if name.ends_with(".shard") {
                *skipped = skipped.saturating_add(1);
            }
            continue;
        }
        if kind.is_dir() {
            collect_lockbox_files(&entry.path(), files, visited, skipped)?;
        } else if kind.is_file() && name.ends_with(".shard") {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn collect_public_csv_files(
    vault: &Path,
    root: &Path,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
    skipped: &mut u32,
) -> Result<(), SearchError> {
    for entry in fs::read_dir(root).map_err(fs_error)? {
        let entry = entry.map_err(fs_error)?;
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
            collect_public_csv_files(vault, &entry.path(), files, visited, skipped)?;
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

fn count_structured_trash(vault: &Path) -> Result<u32, SearchError> {
    let (root, unsafe_root) = safe_scan_root(vault, ".trash/notes")?;
    let Some(root) = root else {
        let _ = unsafe_root; // Markdown root validation already accounted for this path.
        return Ok(0);
    };
    let mut visited = 0usize;
    count_structured_files(&root, &mut visited)
}

fn count_structured_files(root: &Path, visited: &mut usize) -> Result<u32, SearchError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(fs_error(error)),
    };
    let mut count = 0u32;
    for entry in entries {
        let entry = entry.map_err(fs_error)?;
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
            count = count.saturating_add(count_structured_files(&entry.path(), visited)?);
        } else if kind.is_file()
            && [
                ".shardmap.json",
                ".shardcanvas.json",
                ".shardflow.json",
                ".shardtable.json",
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

fn parse_csv_header(bytes: &[u8]) -> Result<Vec<String>, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
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
        return Err(());
    }
    fields.push(field);
    Ok(fields)
}

fn read_csv_header_bytes(path: &Path) -> Result<Vec<u8>, SearchError> {
    let mut reader = BufReader::new(File::open(path).map_err(fs_error)?);
    let mut bytes = Vec::new();
    let mut quoted = false;
    let mut field_start = true;

    if reader
        .fill_buf()
        .map_err(fs_error)?
        .starts_with(&[0xef, 0xbb, 0xbf])
    {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        reader.consume(3);
    }

    loop {
        if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
            return Err(SearchError::UnsupportedTarget);
        }
        let mut byte = [0u8; 1];
        if reader.read(&mut byte).map_err(fs_error)? == 0 {
            return if quoted {
                Err(SearchError::UnsupportedTarget)
            } else {
                Ok(bytes)
            };
        }
        bytes.push(byte[0]);

        if quoted {
            if byte[0] == b'"' {
                let next = reader.fill_buf().map_err(fs_error)?;
                if next.first() == Some(&b'"') {
                    if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
                        return Err(SearchError::UnsupportedTarget);
                    }
                    bytes.push(b'"');
                    reader.consume(1);
                } else {
                    quoted = false;
                }
            }
            continue;
        }

        match byte[0] {
            b'"' if field_start => {
                quoted = true;
                field_start = false;
            }
            b',' => field_start = true,
            b'\r' | b'\n' => return Ok(bytes),
            _ => field_start = false,
        }
    }
}

fn io_error(_: impl ToString) -> SearchError {
    SearchError::Io { retryable: false }
}

fn fs_error(error: std::io::Error) -> SearchError {
    if error.kind() == std::io::ErrorKind::NotFound {
        SearchError::NotFound
    } else {
        SearchError::Io { retryable: true }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, time::Instant};

    use serde_json::json;
    use shard_core::search::{scan_exact, MatchLocation, ParsedQuery};

    use super::*;

    fn write_markdown(path: &Path, id: &str, tags: &[&str], body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let frontmatter = FragmentFrontmatter {
            id: id.to_string(),
            created_at: "2026-09-25T00:00:00Z".to_string(),
            updated_at: "2026-09-25T01:00:00Z".to_string(),
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            category: None,
            ai_status: Some("none".to_string()),
            pinned: false,
            source: "test".to_string(),
            conflict_of: None,
            related: Vec::new(),
        };
        shard_core::write_fragment_file(path, &frontmatter, body).unwrap();
    }

    fn search_document(
        document: &LoadedSearchDocument,
        query: &str,
    ) -> shard_core::search::ScanResult {
        scan_exact(
            std::slice::from_ref(&document.projected),
            &ParsedQuery::parse(query).unwrap(),
            10,
        )
    }

    fn context(vault: &Path) -> SearchContext {
        SearchContext {
            vault_path: vault.display().to_string(),
            vault_epoch: "1".to_string(),
            privacy_epoch: "0".to_string(),
        }
    }

    fn public_draft(
        vault: &Path,
        previous: Option<crate::search_runtime::SearchSnapshot>,
        rebuild: bool,
    ) -> SearchSnapshotDraft {
        build_snapshot(
            SearchBuildRequest {
                context: context(vault),
                scope: SearchScope::Public,
                refresh: if rebuild {
                    crate::search_contract::SearchRefresh::Rebuild
                } else {
                    crate::search_contract::SearchRefresh::Auto
                },
                start_generation: 0,
                force_read_all: rebuild,
                previous: previous.map(std::sync::Arc::new),
            },
            &LockboxRuntime::default(),
        )
        .unwrap()
    }

    fn indexed_draft(
        vault: &Path,
        registry: &IndexRegistry,
        previous: Option<crate::search_runtime::SearchSnapshot>,
        rebuild: bool,
    ) -> SearchSnapshotDraft {
        build_snapshot_with_index(
            SearchBuildRequest {
                context: context(vault),
                scope: SearchScope::Public,
                refresh: if rebuild {
                    SearchRefresh::Rebuild
                } else {
                    SearchRefresh::Auto
                },
                start_generation: 0,
                force_read_all: rebuild || previous.is_none(),
                previous: previous.map(Arc::new),
            },
            &LockboxRuntime::default(),
            Some(registry),
        )
        .unwrap()
    }

    fn index_registry(root: &Path) -> IndexRegistry {
        let registry = IndexRegistry::default();
        registry.set_root(root.to_path_buf());
        registry
    }

    fn trust_cached_rows(registry: &IndexRegistry, vault: &Path) {
        let index = registry.open(vault).unwrap();
        let connection = rusqlite::Connection::open(index.path()).unwrap();
        connection
            .execute(
                "UPDATE files SET indexed_at_ns = mtime_ns + ?1",
                [i64::try_from(RACY_WINDOW_NS + 1).unwrap()],
            )
            .unwrap();
    }

    fn previous(
        mut draft: SearchSnapshotDraft,
        trusted: bool,
    ) -> crate::search_runtime::SearchSnapshot {
        if trusted {
            for source in draft.sources.values_mut() {
                source.indexed_at_ns = source.stamp.mtime_ns + RACY_WINDOW_NS + 1;
            }
        }
        crate::search_runtime::SearchSnapshot::from_draft(draft, SearchScope::Public, 0)
    }

    fn read_count() -> usize {
        SOURCE_READS.with(|reads| reads.get())
    }

    fn reset_reads() {
        SOURCE_READS.with(|reads| reads.set(0));
    }

    #[test]
    fn search_index_warm_start_decodes_without_reading_files() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        write_markdown(
            &vault.join("notes/one.md"),
            "one",
            &["note"],
            "# Warm document",
        );
        let registry = index_registry(root);
        let first = indexed_draft(vault, &registry, None, true);
        trust_cached_rows(&registry, vault);
        drop(registry);

        reset_reads();
        let warm = indexed_draft(vault, &index_registry(root), None, false);
        assert_eq!(read_count(), 0);
        assert_same_draft(&first, &warm);
    }

    #[test]
    fn search_index_warm_build_equals_full_read() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        write_markdown(&vault.join("fragments/one.md"), "one", &[], "中文正文");
        write_markdown(
            &vault.join("notes/two.md"),
            "two",
            &["document"],
            "# 文档标题",
        );
        let registry = index_registry(root);
        let full = indexed_draft(vault, &registry, None, true);
        trust_cached_rows(&registry, vault);
        let warm = indexed_draft(vault, &index_registry(root), None, false);
        assert_same_draft(&full, &warm);
    }

    #[test]
    fn search_index_corrupt_file_is_discarded_and_search_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        write_markdown(&vault.join("notes/one.md"), "one", &["note"], "# Durable");
        let registry = index_registry(root);
        let expected = indexed_draft(vault, &registry, None, true);
        let path = registry.open(vault).unwrap().path().to_path_buf();
        drop(registry);
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
        fs::write(&path, b"not a sqlite database").unwrap();
        reset_reads();
        let actual = indexed_draft(vault, &index_registry(root), None, false);
        assert!(read_count() > 0);
        assert_same_draft(&expected, &actual);
    }

    #[test]
    fn search_index_unavailable_root_falls_back_to_full_read() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        write_markdown(&vault.join("notes/one.md"), "one", &["note"], "# Fallback");
        let root = directory.path().join("not-a-directory");
        fs::write(&root, "file").unwrap();
        reset_reads();
        let draft = indexed_draft(vault, &index_registry(&root), None, false);
        assert_eq!(draft.documents.len(), 1);
        assert!(read_count() > 0);
    }

    #[test]
    fn search_index_never_stores_lockbox() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        write_markdown(&vault.join("notes/one.md"), "one", &["note"], "# Public");
        fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
        fs::write(
            vault.join("lockbox/fragments/secret.shard"),
            "PRIVATE_MARKER_7b18",
        )
        .unwrap();
        let registry = index_registry(root);
        indexed_draft(vault, &registry, None, true);
        let path = registry.open(vault).unwrap().path().to_path_buf();
        for candidate in [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
        ] {
            if let Ok(bytes) = fs::read(candidate) {
                assert!(!bytes
                    .windows(b"PRIVATE_MARKER_7b18".len())
                    .any(|window| window == b"PRIVATE_MARKER_7b18"));
                assert!(!bytes
                    .windows(b"lockbox/".len())
                    .any(|window| window == b"lockbox/"));
            }
        }
    }

    #[test]
    fn search_index_forgets_public_doc_moved_to_lockbox() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        let public_path = vault.join("notes/one.md");
        write_markdown(&public_path, "one", &["note"], "# SENSITIVE_BEFORE_MOVE");
        let registry = index_registry(root);
        indexed_draft(vault, &registry, None, true);
        let index = registry.open(vault).unwrap();
        fs::remove_file(&public_path).unwrap();
        index.forget(&["notes/one.md".to_string()]).unwrap();
        assert!(index.load_files().unwrap().is_empty());
        for candidate in [
            index.path().to_path_buf(),
            PathBuf::from(format!("{}-wal", index.path().display())),
        ] {
            if let Ok(bytes) = fs::read(candidate) {
                assert!(!bytes
                    .windows(b"SENSITIVE_BEFORE_MOVE".len())
                    .any(|window| window == b"SENSITIVE_BEFORE_MOVE"));
            }
        }
    }

    #[test]
    #[ignore = "release-only 5k cold versus warm start benchmark"]
    fn search_5k_warm_start() {
        let directory = tempfile::tempdir().unwrap();
        let vault = &directory.path().join("vault");
        let root = &directory.path().join("cache");
        for index in 0..5_000 {
            write_markdown(
                &vault.join(format!("notes/{index:05}.md")),
                &format!("id-{index}"),
                &["note"],
                &format!("# Search item {index}"),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(2_100));
        let registry = index_registry(root);
        let full_started = Instant::now();
        let full = indexed_draft(vault, &registry, None, true);
        let full_elapsed = full_started.elapsed();
        reset_reads();
        let warm_started = Instant::now();
        let warm = indexed_draft(vault, &index_registry(root), None, false);
        eprintln!(
            "search_5k_warm_start full={full_elapsed:?} warm={:?} source_reads={}",
            warm_started.elapsed(),
            read_count()
        );
        assert_eq!(read_count(), 0);
        assert_same_draft(&full, &warm);
    }

    fn assert_same_draft(left: &SearchSnapshotDraft, right: &SearchSnapshotDraft) {
        assert_eq!(left.documents, right.documents);
        assert_eq!(left.skipped_files, right.skipped_files);
        assert_eq!(left.source_stamp, right.source_stamp);
        let metadata = |draft: &SearchSnapshotDraft| {
            let mut entries = draft
                .metadata
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        serde_json::to_value(&value.target).unwrap(),
                        value.updated_at.clone(),
                        value.revision.clone(),
                        format!("{:?}", value.reveal_hint),
                        value.read_only,
                    )
                })
                .collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        };
        assert_eq!(metadata(left), metadata(right));
    }

    #[test]
    fn search_incremental_unchanged_vault_reads_no_files() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        write_markdown(&vault.join("notes/a.md"), "a", &["note"], "# Alpha");
        fs::write(vault.join("headers.csv"), "Name,Value\n1,2").unwrap();
        let first = public_draft(vault, None, true);
        reset_reads();
        let next = public_draft(vault, Some(previous(first, true)), false);
        assert_eq!(read_count(), 0);
        assert_eq!(next.documents.len(), 2);
    }

    #[test]
    fn search_incremental_build_equals_full_read() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let mut seed = 0x5a17_u64;
        for index in 0..24 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let root = if index % 5 == 0 {
                ".trash/notes"
            } else {
                "notes"
            };
            write_markdown(
                &vault.join(format!("{root}/{index}.md")),
                &format!("id-{index}"),
                &["note"],
                &format!("# Topic {seed:x}"),
            );
        }
        fs::write(vault.join("notes/broken.md"), "ordinary markdown").unwrap();
        fs::write(vault.join("notes/data.csv"), "first,second\nA,B\n").unwrap();
        fs::write(vault.join(".trash/notes/archived.shardtable.json"), "{}").unwrap();
        fs::write(vault.join("notes/map.shardmap.json"), json!({
            "kind":"shard.map", "schemaVersion":1, "id":"map-1", "title":"Map",
            "createdAt":"2026-09-25T00:00:00Z", "updatedAt":"2026-09-25T00:00:00Z",
            "savedWithAppVersion":"test", "revision":1, "rootId":"root", "hasProtectedLinks":false,
            "nodes":{"root":{"id":"root","parentId":null,"sortKey":"a","text":"Visible",
                "createdAt":"2026-09-25T00:00:00Z","updatedAt":"2026-09-25T00:00:00Z"}}
        }).to_string()).unwrap();
        fs::write(
            vault.join("notes/canvas.shardcanvas.json"),
            json!({
                "kind":"shard.canvas", "schemaVersion":1, "id":"canvas-1", "title":"Canvas",
                "createdAt":"2026-09-25T00:00:00Z", "updatedAt":"2026-09-25T00:00:00Z",
                "revision":1, "nodes":[], "edges":[]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            vault.join("notes/table.shardtable.json"),
            include_str!("../../tests/fixtures/tables/valid/empty.json"),
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(vault.join("notes"), vault.join("maps")).unwrap();
        let first = public_draft(vault, None, true);
        write_markdown(&vault.join("notes/1.md"), "id-1", &["note"], "# Revised");
        fs::remove_file(vault.join("notes/2.md")).unwrap();
        fs::write(vault.join("notes/data.csv"), "first,third\nA,B\n").unwrap();
        write_markdown(
            &vault.join("notes/broken.md"),
            "recovered",
            &["note"],
            "# Recovered",
        );
        let incremental = public_draft(vault, Some(previous(first, true)), false);
        let full = public_draft(vault, None, true);
        assert_same_draft(&incremental, &full);
        assert!(full.skipped_files >= 2);
        assert!(full
            .documents
            .iter()
            .any(|doc| doc.stable_key.contains("map.shardmap.json")));
        assert!(full
            .documents
            .iter()
            .any(|doc| doc.stable_key.contains("canvas.shardcanvas.json")));
        assert!(full
            .documents
            .iter()
            .any(|doc| doc.stable_key.contains("table.shardtable.json")));
    }

    #[test]
    fn search_incremental_detects_same_size_edit() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("notes/a.md");
        write_markdown(&path, "a", &["note"], "# Alpha");
        let size = fs::metadata(&path).unwrap().len();
        let first = public_draft(vault, None, true);
        write_markdown(&path, "a", &["note"], "# Bravo");
        assert_eq!(fs::metadata(&path).unwrap().len(), size);
        let next = public_draft(vault, Some(previous(first, true)), false);
        assert!(next.documents[0]
            .projection
            .searchable_text
            .contains("Bravo"));
    }

    #[cfg(unix)]
    #[test]
    fn search_incremental_detects_restored_mtime_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("notes/a.md");
        write_markdown(&path, "a", &["note"], "# Alpha");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let first = public_draft(vault, None, true);
        let original_ino = first.sources["notes/a.md"].stamp.ino;
        let replacement = vault.join("notes/replacement.tmp");
        write_markdown(&replacement, "a", &["note"], "# Bravo");
        fs::File::open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_ne!(fs::metadata(&path).unwrap().ino(), original_ino);
        let next = public_draft(vault, Some(previous(first, true)), false);
        assert!(next.documents[0]
            .projection
            .searchable_text
            .contains("Bravo"));
    }

    #[test]
    fn search_incremental_racy_recent_file_is_reread() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        write_markdown(&vault.join("notes/a.md"), "a", &["note"], "# Alpha");
        let first = public_draft(vault, None, true);
        reset_reads();
        let next = public_draft(vault, Some(previous(first, false)), false);
        assert_eq!(read_count(), 1);
        assert_eq!(next.documents.len(), 1);
    }

    #[test]
    fn search_incremental_deleted_file_disappears() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("notes/a.md");
        write_markdown(&path, "a", &["note"], "# Alpha");
        let first = public_draft(vault, None, true);
        fs::remove_file(path).unwrap();
        let next = public_draft(vault, Some(previous(first, true)), false);
        assert!(next.documents.is_empty());
        assert!(next.sources.is_empty());
    }

    #[test]
    fn search_rebuild_reads_all_files() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        write_markdown(&vault.join("notes/a.md"), "a", &["note"], "# Alpha");
        let first = public_draft(vault, None, true);
        reset_reads();
        let next = public_draft(vault, Some(previous(first, true)), true);
        assert_eq!(read_count(), 1);
        assert_eq!(next.documents.len(), 1);
    }

    #[test]
    fn search_set_vault_path_uses_reconcile() {
        let source = include_str!("lib.rs");
        let function = source
            .split("async fn set_vault_path(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(function.contains("search_contract::SearchRefresh::Reconcile"));
        assert!(!function.contains("search_contract::SearchRefresh::Rebuild"));
    }

    #[test]
    #[ignore = "release-only 5k Auto reconcile benchmark"]
    fn search_5k_auto_reconcile_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        for index in 0..5_000 {
            write_markdown(
                &vault.join(format!("notes/{index:05}.md")),
                &format!("id-{index}"),
                &["note"],
                &format!("# Search item {index}"),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(2_100));
        let first = public_draft(vault, None, true);
        let previous = previous(first, false);
        reset_reads();
        let started = Instant::now();
        let next = public_draft(vault, Some(previous), false);
        eprintln!(
            "search_5k_auto_reconcile_unchanged elapsed={:?} source_reads={}",
            started.elapsed(),
            read_count()
        );
        assert_eq!(next.documents.len(), 5_000);
        assert_eq!(read_count(), 0);
    }

    #[test]
    fn search_real_snapshot_builder_reads_saved_sources() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::create_dir_all(vault.join(".trash/notes")).unwrap();
        write_markdown(
            &vault.join("notes/计划.md"),
            "saved-note",
            &["note"],
            "# 已保存计划\n\n正文",
        );
        fs::write(vault.join("数据.csv"), "姓名,进度\n小夏,完成\n").unwrap();
        fs::write(vault.join(".trash/notes/不可打开.shardmap.json"), "{}").unwrap();

        let draft = build_snapshot(
            SearchBuildRequest {
                context: context(vault),
                scope: SearchScope::Public,
                refresh: crate::search_contract::SearchRefresh::Rebuild,
                start_generation: 0,
                force_read_all: true,
                previous: None,
            },
            &LockboxRuntime::default(),
        )
        .unwrap();

        assert_eq!(draft.documents.len(), 2);
        assert_eq!(draft.metadata.len(), 2);
        assert_eq!(draft.skipped_files, 1);
        assert!(draft
            .metadata
            .values()
            .any(|metadata| metadata.target.path == "notes/计划.md"));
        assert!(draft
            .metadata
            .values()
            .any(|metadata| metadata.target.path == "数据.csv"));
    }

    #[test]
    fn search_markdown_trash_note_is_archived_and_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".trash/notes/旧笔记.md");
        write_markdown(&path, "trash-note", &["note"], "# 已归档\n\n正文");

        let loaded = load_public_markdown(directory.path(), &path).unwrap();
        assert!(loaded.metadata.target.archived);
        assert!(loaded.metadata.read_only);
        let fragment = loaded.fragment.unwrap();
        assert!(fragment.archived);
        assert_eq!(fragment.path, ".trash/notes/旧笔记.md");
    }

    #[cfg(unix)]
    #[test]
    fn search_read_rejects_path_escape_and_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().join("vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        let outside = directory.path().join("outside.md");
        write_markdown(&outside, "outside", &["note"], "# 外部");

        let escaped = make_target(
            &vault,
            SearchScope::Public,
            "../outside.md".to_string(),
            SearchKind::Note,
            Some("outside".to_string()),
            false,
        );
        assert!(matches!(
            read_search_document_from_disk(&context(&vault), &escaped, None),
            Err(SearchError::InvalidRequest { .. })
        ));

        symlink(&outside, vault.join("notes/alias.md")).unwrap();
        let alias = make_target(
            &vault,
            SearchScope::Public,
            "notes/alias.md".to_string(),
            SearchKind::Note,
            Some("outside".to_string()),
            false,
        );
        assert!(matches!(
            read_search_document_from_disk(&context(&vault), &alias, None),
            Err(SearchError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn search_read_detects_replaced_object_at_same_path() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("notes/替换.md");
        write_markdown(&path, "original", &["note"], "# 原对象");
        let original = load_public_markdown(vault, &path).unwrap();

        write_markdown(&path, "replacement", &["note"], "# 新对象");
        assert!(matches!(
            read_search_document_from_disk(&context(vault), &original.metadata.target, None),
            Err(SearchError::TargetChanged)
        ));
    }

    #[test]
    fn search_structured_extractors_ignore_internal_metadata() {
        let mind_map: ShardMapFile = serde_json::from_value(json!({
            "kind": "shard.map",
            "schemaVersion": 1,
            "id": "secret-map-id",
            "title": "路线图",
            "createdAt": "2026-09-25T00:00:00Z",
            "updatedAt": "2026-09-25T00:00:00Z",
            "savedWithAppVersion": "internal-version",
            "revision": 1,
            "rootId": "secret-root-id",
            "hasProtectedLinks": false,
            "nodes": {
                "secret-root-id": {
                    "id": "secret-root-id",
                    "parentId": null,
                    "sortKey": "secret-sort-key",
                    "text": "用户节点文本",
                    "createdAt": "2026-09-25T00:00:00Z",
                    "updatedAt": "2026-09-25T00:00:00Z"
                }
            }
        }))
        .unwrap();
        let map_text = shard_core::graph_model::mind_map_search_text(&mind_map);
        assert!(map_text.contains("用户节点文本"));
        assert!(!map_text.contains("secret-root-id"));
        assert!(!map_text.contains("secret-sort-key"));

        let canvas: canvas_commands::CanvasFile = serde_json::from_value(json!({
            "kind": "shard.flow",
            "schemaVersion": 1,
            "id": "secret-canvas-id",
            "title": "流程",
            "createdAt": "2026-09-25T00:00:00Z",
            "updatedAt": "2026-09-25T00:00:00Z",
            "revision": 1,
            "nodes": [{
                "id": "secret-node-id",
                "kind": "text",
                "x": 987654,
                "y": 123456,
                "text": "用户画布文本"
            }],
            "edges": [{
                "id": "secret-edge-id",
                "source": "secret-node-id",
                "target": "secret-node-id",
                "label": "用户边标签"
            }]
        }))
        .unwrap();
        let canvas_text = canvas_commands::search_text(&canvas);
        assert!(canvas_text.contains("用户画布文本"));
        assert!(canvas_text.contains("用户边标签"));
        assert!(!canvas_text.contains("secret-node-id"));
        assert!(!canvas_text.contains("987654"));

        let table: crate::table::TableFile = serde_json::from_value(json!({
            "kind": "shard.table",
            "schemaVersion": 1,
            "id": "secret-table-id",
            "revision": 1,
            "creation": {"requestId": "secret-request", "payloadHash": "secret-hash"},
            "lastMutationId": null,
            "lastMutationHash": null,
            "createdAt": "2026-09-25T00:00:00Z",
            "updatedAt": "2026-09-25T00:00:00Z",
            "primaryFieldId": "secret-title-field",
            "fields": {
                "secret-title-field": {"id": "secret-title-field", "name": "任务", "type": "text"},
                "secret-status-field": {
                    "id": "secret-status-field",
                    "name": "状态",
                    "type": "select",
                    "options": [{"id": "secret-option-id", "label": "进行中", "color": "blue"}]
                }
            },
            "fieldOrder": ["secret-title-field", "secret-status-field"],
            "records": {
                "secret-record-id": {
                    "id": "secret-record-id",
                    "createdAt": "2026-09-25T00:00:00Z",
                    "updatedAt": "2026-09-25T00:00:00Z",
                    "values": {"secret-title-field": "用户表格文本", "secret-status-field": "secret-option-id"}
                }
            },
            "recordOrder": ["secret-record-id"],
            "views": {},
            "viewOrder": []
        }))
        .unwrap();
        let table_text = table.search_text();
        assert!(table_text.contains("用户表格文本"));
        assert!(table_text.contains("进行中"));
        assert!(!table_text.contains("secret-option-id"));
        assert!(!table_text.contains("secret-record-id"));
        assert!(!table_text.contains("secret-request"));
    }

    #[test]
    fn search_markdown_json_outline_uses_root_title_and_user_text_only() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("fragments/outline.md");
        let body = format!(
            "```shardmap\n{}\n```",
            json!({
                "kind": "shard.map",
                "schemaVersion": 1,
                "id": "secret-map-id",
                "title": "不作为 md 标题",
                "createdAt": "2026-09-25T00:00:00Z",
                "updatedAt": "2026-09-25T00:00:00Z",
                "savedWithAppVersion": "internal-version",
                "revision": 1,
                "rootId": "secret-root-id",
                "hasProtectedLinks": false,
                "nodes": {
                    "secret-root-id": {
                        "id": "secret-root-id",
                        "parentId": null,
                        "sortKey": "secret-sort-key",
                        "text": "路线规划",
                        "note": "根节点备注",
                        "createdAt": "2026-09-25T00:00:00Z",
                        "updatedAt": "2026-09-25T00:00:00Z"
                    },
                    "secret-child-id": {
                        "id": "secret-child-id",
                        "parentId": "secret-root-id",
                        "sortKey": "another-secret-sort-key",
                        "text": "预订车票",
                        "note": "确认乘车时间",
                        "createdAt": "2026-09-25T00:00:00Z",
                        "updatedAt": "2026-09-25T00:00:00Z"
                    }
                }
            })
        );
        write_markdown(&path, "outline", &["outline"], &body);

        let document = load_public_markdown(vault, &path).unwrap();
        assert!(matches!(document.metadata.target.kind, SearchKind::Outline));
        assert_eq!(document.projected.title, "路线规划");
        assert!(matches!(
            document.projected.projection.blocks.as_slice(),
            [SearchProjectionBlock::DocumentOnly { .. }]
        ));
        let searchable = &document.projected.projection.searchable_text;
        for text in ["路线规划", "根节点备注", "预订车票", "确认乘车时间"] {
            assert!(searchable.contains(text), "missing user text: {text}");
            let result = search_document(&document, text);
            assert_eq!(result.total, 1);
            assert_eq!(result.matches[0].location, MatchLocation::DocumentOnly);
        }
        for internal in ["schemaVersion", "secret-root-id", "secret-sort-key"] {
            assert!(
                !searchable.contains(internal),
                "indexed internal text: {internal}"
            );
            assert_eq!(search_document(&document, internal).total, 0);
        }
    }

    #[test]
    fn search_markdown_json_flowchart_uses_json_title_and_canvas_text_only() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("fragments/flowchart.md");
        let body = format!(
            "```shardflow\n{}\n```",
            json!({
                "kind": "shard.flow",
                "schemaVersion": 1,
                "id": "secret-flow-id",
                "title": "发布流程",
                "createdAt": "2026-09-25T00:00:00Z",
                "updatedAt": "2026-09-25T00:00:00Z",
                "revision": 1,
                "nodes": [
                    {"id": "secret-start-id", "kind": "terminal", "x": 987654, "y": 123456, "text": "开始发布"},
                    {"id": "secret-review-id", "kind": "process", "x": 10, "y": 20, "text": "审核内容"}
                ],
                "edges": [{
                    "id": "secret-edge-id",
                    "source": "secret-start-id",
                    "target": "secret-review-id",
                    "label": "审核通过"
                }]
            })
        );
        write_markdown(&path, "flowchart", &["flowchart"], &body);

        let document = load_public_markdown(vault, &path).unwrap();
        assert!(matches!(
            document.metadata.target.kind,
            SearchKind::Flowchart
        ));
        assert_eq!(document.projected.title, "发布流程");
        assert!(matches!(
            document.projected.projection.blocks.as_slice(),
            [SearchProjectionBlock::DocumentOnly { .. }]
        ));
        let searchable = &document.projected.projection.searchable_text;
        for text in ["开始发布", "审核内容", "审核通过"] {
            assert!(searchable.contains(text), "missing user text: {text}");
            let result = search_document(&document, text);
            assert_eq!(result.total, 1);
            assert_eq!(result.matches[0].location, MatchLocation::DocumentOnly);
        }
        for internal in ["schemaVersion", "secret-review-id", "987654"] {
            assert!(
                !searchable.contains(internal),
                "indexed internal text: {internal}"
            );
            assert_eq!(search_document(&document, internal).total, 0);
        }

        let reread =
            read_search_document_from_disk(&context(vault), &document.metadata.target, None)
                .unwrap();
        assert!(matches!(reread.metadata.target.kind, SearchKind::Flowchart));
    }

    #[test]
    fn search_markdown_legacy_outline_keeps_existing_title_and_projection() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("fragments/legacy-outline.md");
        let body = "- 旧式根节点\n  - 子节点\n\n补充说明";
        write_markdown(&path, "legacy-outline", &["outline"], body);

        let document = load_public_markdown(vault, &path).unwrap();
        let expected = project_document(&SourceDocument {
            stable_key: document.projected.stable_key.clone(),
            title: "旧式根节点".to_string(),
            tags: document.projected.tags.clone(),
            body: body.to_string(),
            modified_at: parse_modified_at("2026-09-25T01:00:00Z"),
        });
        assert!(matches!(document.metadata.target.kind, SearchKind::Outline));
        assert_eq!(document.projected.title, "旧式根节点");
        assert_eq!(document.projected.projection, expected.projection);
    }

    #[test]
    fn search_markdown_type_priority_matches_core_contract() {
        let tags = vec![
            "document".to_string(),
            "flowchart".to_string(),
            "outline".to_string(),
            "note".to_string(),
        ];
        assert!(matches!(markdown_kind(&tags), SearchKind::Note));
        assert!(matches!(
            markdown_kind(&["document".into(), "flowchart".into()]),
            SearchKind::Flowchart
        ));
    }

    #[test]
    fn search_markdown_broken_graph_region_falls_back_without_dropping_result() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path();
        let path = vault.join("fragments/broken-outline.md");
        let body = "仍可搜索的前文\n\n```shardmap\n{not json}\n```\n\n仍可搜索的后文";
        write_markdown(&path, "broken-outline", &["outline"], body);

        let document = load_public_markdown(vault, &path).unwrap();
        assert_eq!(document.projected.title, "仍可搜索的前文");
        assert!(document
            .projected
            .projection
            .searchable_text
            .contains("仍可搜索的后文"));
        assert!(document
            .projected
            .projection
            .searchable_text
            .contains("{not json}"));
    }

    #[test]
    fn search_csv_header_supports_quotes_bom_and_newlines() {
        let header = parse_csv_header(
            "\u{feff}姓名,\"说明\n续行\",\"他说 \"\"你好\"\"\"\r\n张三,ignored,ignored".as_bytes(),
        )
        .unwrap();
        assert_eq!(header, vec!["姓名", "说明\n续行", "他说 \"你好\""]);

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("quoted.csv");
        fs::write(
            &path,
            "\u{feff}\"首列\n续行\",第二列\r\n正文不应读取到表头".as_bytes(),
        )
        .unwrap();
        let header = parse_csv_header(&read_csv_header_bytes(&path).unwrap()).unwrap();
        assert_eq!(header, vec!["首列\n续行", "第二列"]);
    }
}
