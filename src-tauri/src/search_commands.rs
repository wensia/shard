use std::{path::PathBuf, time::SystemTime};

use chrono::{DateTime, Utc};
use shard_core::search::{
    scan_exact_filtered, MatchLocation, MatchedField, ParsedQuery, ProjectedDocument,
    SearchQueryErrorReason,
};

use crate::{
    configured_vault_path,
    search_contract::{
        ReadSearchTargetRequest, ReadSearchTargetResponse, SearchContext, SearchError, SearchField,
        SearchHit, SearchIndexState, SearchRevealHint, SearchScope, SearchTextPart,
        SearchVaultRequest, SearchVaultResponse,
    },
    search_lockbox::{peek_lockbox_read_lease, renew_lockbox_read_lease},
    search_runtime::{SearchRuntime, SnapshotFreshness},
    search_sources::{read_search_document, SearchDocumentMetadata},
    LockboxRuntime,
};

const SEARCH_WIRE_VERSION: u32 = 1;
const SEARCH_LIMIT_MAX: u32 = 200;

#[tauri::command]
pub(crate) async fn search_vault(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SearchRuntime>,
    lockbox_runtime: tauri::State<'_, LockboxRuntime>,
    request: SearchVaultRequest,
) -> Result<SearchVaultResponse, SearchError> {
    let runtime = runtime.inner().clone();
    let lockbox_runtime = lockbox_runtime.inner().clone();
    spawn_search_blocking(move || {
        let vault = current_vault(&app, &request.expected_vault_path)?;
        search_vault_in_vault(vault, &runtime, &lockbox_runtime, request)
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_search_target(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SearchRuntime>,
    lockbox_runtime: tauri::State<'_, LockboxRuntime>,
    request: ReadSearchTargetRequest,
) -> Result<ReadSearchTargetResponse, SearchError> {
    let runtime = runtime.inner().clone();
    let lockbox_runtime = lockbox_runtime.inner().clone();
    spawn_search_blocking(move || {
        let vault = current_vault(&app, &request.expected_vault_path)?;
        read_search_target_in_vault(vault, &runtime, &lockbox_runtime, request)
    })
    .await
}

async fn spawn_search_blocking<T, F>(operation: F) -> Result<T, SearchError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, SearchError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| SearchError::Internal { retryable: true })?
}

fn current_vault(
    app: &tauri::AppHandle,
    expected_vault_path: &str,
) -> Result<PathBuf, SearchError> {
    let vault = configured_vault_path(app).map_err(|error| {
        if error == "vault_not_configured" {
            SearchError::VaultChanged
        } else {
            SearchError::Io { retryable: true }
        }
    })?;
    if expected_vault_path.is_empty() || PathBuf::from(expected_vault_path) != vault {
        return Err(SearchError::VaultChanged);
    }
    Ok(vault)
}

fn search_vault_in_vault(
    vault: PathBuf,
    runtime: &SearchRuntime,
    lockbox_runtime: &LockboxRuntime,
    request: SearchVaultRequest,
) -> Result<SearchVaultResponse, SearchError> {
    validate_search_request(&request)?;
    let context = resolve_context(
        &vault,
        runtime,
        &request.expected_vault_path,
        request.context.as_ref(),
    )?;
    let lease = match request.scope {
        SearchScope::Public => None,
        SearchScope::Lockbox => {
            let lease = peek_lockbox_read_lease(&vault, lockbox_runtime)?;
            lease.validate(&context)?;
            Some(lease)
        }
    };
    let parsed = ParsedQuery::parse(&request.query).map_err(|error| {
        invalid_request(match error.reason {
            SearchQueryErrorReason::QueryTooLong => "queryTooLong",
            SearchQueryErrorReason::TooManyTerms => "tooManyTerms",
        })
    })?;

    runtime.request_reconcile(
        context.clone(),
        request.scope.clone(),
        request.refresh.clone(),
    );
    let view = runtime.snapshot_view(&context, request.scope.clone())?;
    let index_state = match view.freshness {
        SnapshotFreshness::Missing => SearchIndexState::Indexing,
        SnapshotFreshness::Fresh => SearchIndexState::Ready,
        SnapshotFreshness::Stale => SearchIndexState::Stale,
    };

    let (snapshot_id, hits, total, skipped_files) = if let Some(snapshot) = view.snapshot {
        let scanned = scan_exact_filtered(
            &snapshot.documents,
            &parsed,
            request.limit as usize,
            |document| {
                request.include_trash
                    || snapshot
                        .metadata
                        .get(&document.stable_key)
                        .is_some_and(|metadata| !metadata.target.archived)
            },
        );
        let hits = scanned
            .matches
            .into_iter()
            .map(|matched| {
                let metadata = snapshot
                    .metadata
                    .get(&matched.stable_key)
                    .ok_or(SearchError::Internal { retryable: false })?;
                let document = snapshot
                    .documents
                    .binary_search_by(|document| document.stable_key.cmp(&matched.stable_key))
                    .ok()
                    .and_then(|index| snapshot.documents.get(index))
                    .ok_or(SearchError::Internal { retryable: false })?;
                map_hit(document, metadata, matched)
            })
            .collect::<Result<Vec<_>, SearchError>>()?;
        (
            Some(snapshot.snapshot_id.clone()),
            hits,
            Some(u32::try_from(scanned.total).unwrap_or(u32::MAX)),
            snapshot.skipped_files,
        )
    } else {
        (None, Vec::new(), None, 0)
    };

    runtime.validate_context(&context)?;
    if let Some(lease) = &lease {
        lease.validate(&context)?;
    }

    Ok(SearchVaultResponse {
        client_request_id: request.client_request_id,
        context,
        snapshot_id,
        index_state,
        expires_at: lease.as_ref().map(|lease| format_time(lease.expires_at())),
        hits,
        total,
        skipped_files,
        warning: view.warning,
    })
}

fn read_search_target_in_vault(
    vault: PathBuf,
    runtime: &SearchRuntime,
    lockbox_runtime: &LockboxRuntime,
    request: ReadSearchTargetRequest,
) -> Result<ReadSearchTargetResponse, SearchError> {
    if request.client_request_id.trim().is_empty() {
        return Err(invalid_request("missingClientRequestId"));
    }
    let context = resolve_context(
        &vault,
        runtime,
        &request.expected_vault_path,
        request.context.as_ref(),
    )?;
    if request.target.vault_path != context.vault_path {
        return Err(SearchError::VaultChanged);
    }
    let lease = match request.target.scope {
        SearchScope::Public => None,
        SearchScope::Lockbox => {
            let lease = renew_lockbox_read_lease(&vault, lockbox_runtime)?;
            lease.validate(&context)?;
            Some(lease)
        }
    };
    let loaded = read_search_document(&context, &request.target, lease.as_ref())?;
    let fragment = loaded.fragment.ok_or(SearchError::UnsupportedTarget)?;

    runtime.validate_context(&context)?;
    if let Some(lease) = &lease {
        lease.validate(&context)?;
    }

    Ok(ReadSearchTargetResponse {
        client_request_id: request.client_request_id,
        context,
        expires_at: lease.as_ref().map(|lease| format_time(lease.expires_at())),
        target: loaded.metadata.target,
        revision: loaded.metadata.revision,
        read_only: loaded.metadata.read_only,
        fragment,
    })
}

fn validate_search_request(request: &SearchVaultRequest) -> Result<(), SearchError> {
    if request.client_request_id.trim().is_empty() {
        return Err(invalid_request("missingClientRequestId"));
    }
    if request.query_version != SEARCH_WIRE_VERSION {
        return Err(invalid_request("unsupportedQueryVersion"));
    }
    if request.projection_version != SEARCH_WIRE_VERSION {
        return Err(invalid_request("unsupportedProjectionVersion"));
    }
    if request.limit == 0 || request.limit > SEARCH_LIMIT_MAX {
        return Err(invalid_request("invalidLimit"));
    }
    Ok(())
}

fn resolve_context(
    vault: &PathBuf,
    runtime: &SearchRuntime,
    expected_vault_path: &str,
    requested: Option<&SearchContext>,
) -> Result<SearchContext, SearchError> {
    if let Some(context) = requested {
        if context.vault_path != expected_vault_path || PathBuf::from(&context.vault_path) != *vault
        {
            return Err(SearchError::VaultChanged);
        }
        runtime.validate_context(context)?;
        return Ok(context.clone());
    }
    runtime
        .active_context(vault)
        .ok_or(SearchError::Internal { retryable: true })
}

fn map_hit(
    document: &ProjectedDocument,
    metadata: &SearchDocumentMetadata,
    matched: shard_core::search::ScanMatch,
) -> Result<SearchHit, SearchError> {
    let title_parts = matched
        .title_parts
        .into_iter()
        .map(map_text_part)
        .collect::<Vec<_>>();
    if title_parts
        .iter()
        .map(|part| part.text.as_str())
        .collect::<String>()
        != document.title
    {
        return Err(SearchError::Internal { retryable: false });
    }
    let reveal_hint = match metadata.reveal_hint.clone() {
        SearchRevealHint::External => SearchRevealHint::External,
        SearchRevealHint::DocumentOnly => SearchRevealHint::DocumentOnly,
        SearchRevealHint::Text if matched.location == MatchLocation::DocumentOnly => {
            SearchRevealHint::DocumentOnly
        }
        SearchRevealHint::Text => SearchRevealHint::Text,
    };

    Ok(SearchHit {
        target: metadata.target.clone(),
        title: document.title.clone(),
        title_parts,
        tags: document.tags.clone(),
        updated_at: metadata.updated_at.clone(),
        revision: Some(metadata.revision.clone()),
        matched_fields: matched
            .matched_fields
            .into_iter()
            .map(|field| match field {
                MatchedField::Title => SearchField::Title,
                MatchedField::Tags => SearchField::Tags,
                MatchedField::Body => SearchField::Body,
            })
            .collect(),
        preview: matched.preview.into_iter().map(map_text_part).collect(),
        reveal_hint,
    })
}

fn map_text_part(part: shard_core::search::SearchTextPart) -> SearchTextPart {
    SearchTextPart {
        text: part.text,
        hit: part.hit,
    }
}

fn invalid_request(reason: &str) -> SearchError {
    SearchError::InvalidRequest {
        reason: reason.to_string(),
    }
}

fn format_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs, thread,
        time::{Duration, Instant},
    };

    use serde_json::json;
    use shard_core::search::{project_document, SourceDocument};
    use shard_core::FragmentFrontmatter;

    use super::*;
    use crate::{
        search_contract::{SearchKind, SearchRefresh, SearchTarget},
        search_runtime::{SearchBuildRequest, SearchSnapshotDraft},
    };

    #[test]
    fn search_wire_contract_is_camel_case() {
        let response = SearchVaultResponse {
            client_request_id: "request-1".into(),
            context: SearchContext {
                vault_path: "/vault/A".into(),
                vault_epoch: "2".into(),
                privacy_epoch: "3".into(),
            },
            snapshot_id: None,
            index_state: SearchIndexState::Indexing,
            expires_at: None,
            hits: Vec::new(),
            total: None,
            skipped_files: 0,
            warning: Some(SearchError::Io { retryable: true }),
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["clientRequestId"], "request-1");
        assert_eq!(value["context"]["vaultEpoch"], "2");
        assert_eq!(value["indexState"], "indexing");
        assert_eq!(value["skippedFiles"], 0);
        assert_eq!(value["warning"], json!({ "code": "io", "retryable": true }));
        assert!(value.get("client_request_id").is_none());
    }

    #[test]
    fn request_validation_uses_fixed_reason_codes() {
        let request = SearchVaultRequest {
            client_request_id: "request-1".into(),
            expected_vault_path: "/vault/A".into(),
            context: None,
            scope: SearchScope::Public,
            include_trash: false,
            query_version: 2,
            projection_version: 1,
            query: String::new(),
            limit: 50,
            refresh: crate::search_contract::SearchRefresh::Auto,
        };
        assert!(matches!(
            validate_search_request(&request),
            Err(SearchError::InvalidRequest { reason }) if reason == "unsupportedQueryVersion"
        ));
    }

    #[test]
    fn search_command_queries_typed_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().to_path_buf();
        let vault_path = vault.display().to_string();
        let runtime = SearchRuntime::default();
        let context = runtime.activate_vault(&vault);
        let target = SearchTarget {
            key: serde_json::to_string(&(vault_path.as_str(), "public", "notes/计划.md")).unwrap(),
            vault_path: vault_path.clone(),
            scope: SearchScope::Public,
            path: "notes/计划.md".into(),
            kind: SearchKind::Note,
            object_id: Some("note-1".into()),
            archived: false,
        };
        let document = project_document(&SourceDocument {
            stable_key: target.key.clone(),
            title: "季度计划".into(),
            tags: vec!["工作".into()],
            body: "已经保存的搜索正文".into(),
            modified_at: 1,
        });
        let metadata = SearchDocumentMetadata {
            target: target.clone(),
            updated_at: Some("2026-09-25T08:00:00Z".into()),
            revision: "revision-1".into(),
            reveal_hint: SearchRevealHint::Text,
            read_only: true,
        };
        runtime.install_snapshot_builder({
            let document = document.clone();
            let metadata = metadata.clone();
            move |request: SearchBuildRequest| {
                let mut by_key = HashMap::new();
                by_key.insert(document.stable_key.clone(), metadata.clone());
                Ok(SearchSnapshotDraft {
                    snapshot_id: format!("snapshot-{}", request.start_generation),
                    source_stamp: "source-1".into(),
                    documents: vec![document.clone()],
                    metadata: by_key,
                    sources: HashMap::new(),
                    skipped_files: 0,
                    authorization: None,
                })
            }
        });
        let lockbox_runtime = LockboxRuntime::default();
        let request = SearchVaultRequest {
            client_request_id: "request-1".into(),
            expected_vault_path: vault_path.clone(),
            context: Some(context.clone()),
            scope: SearchScope::Public,
            include_trash: false,
            query_version: 1,
            projection_version: 1,
            query: "计划 搜索".into(),
            limit: 50,
            refresh: SearchRefresh::Rebuild,
        };

        let first =
            search_vault_in_vault(vault.clone(), &runtime, &lockbox_runtime, request.clone())
                .unwrap();
        assert!(matches!(first.index_state, SearchIndexState::Indexing));

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while runtime.is_reconciling(&context, &SearchScope::Public) {
            assert!(
                std::time::Instant::now() < deadline,
                "search build timed out"
            );
            thread::yield_now();
        }

        let response = search_vault_in_vault(
            vault,
            &runtime,
            &lockbox_runtime,
            SearchVaultRequest {
                refresh: SearchRefresh::Auto,
                ..request
            },
        )
        .unwrap();
        assert_eq!(response.total, Some(1));
        assert_eq!(response.hits[0].target.key, target.key);
        assert_eq!(response.hits[0].revision.as_deref(), Some("revision-1"));
        assert!(matches!(
            response.hits[0].matched_fields.as_slice(),
            [SearchField::Title, SearchField::Body]
        ));
    }

    #[test]
    #[ignore = "release-only 5k vault benchmark"]
    fn search_5k_hot_query_p95() {
        const DOCUMENTS: usize = 5_000;
        const QUERIES: [&str; 6] = [
            "检索",
            "检索 work",
            "arch",
            "计划 work",
            "绝无此关键词",
            "常见词",
        ];

        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().to_path_buf();
        fs::create_dir_all(vault.join("fragments")).unwrap();
        fs::create_dir_all(vault.join("notes")).unwrap();
        let mut seed = 20_260_925_u64;
        let mut file_bytes = 0_u64;
        let mut largest_file = 0_u64;
        for index in 0..DOCUMENTS {
            // Fixed seed also determines the content mix, not just file names.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let topic = ["研究", "设计", "工程", "阅读"][(seed as usize) % 4];
            let kind = index % 4;
            let path = vault
                .join(if kind == 0 { "fragments" } else { "notes" })
                .join(format!("search-{index:05}.md"));
            let body = format!(
                "# {topic}计划 {index:05}\n\n检索 archive 文档常见词，记录 searchable pipeline 与中文资料。\n\n| 字段 | 内容 |\n| --- | --- |\n| 项目 | {topic} work {index:05} |\n\n行内 `search_key_{index:05}` 保留原字符。\n\n```text\ncode token {index:05}\n```"
            );
            let frontmatter = FragmentFrontmatter {
                id: format!("search-fixture-{index:05}"),
                created_at: "2026-09-25T00:00:00Z".into(),
                updated_at: "2026-09-25T01:00:00Z".into(),
                tags: match kind {
                    1 => vec!["note".into(), "work".into()],
                    2 => vec!["outline".into(), "work".into()],
                    3 => vec!["document".into(), "work".into()],
                    _ => vec!["work".into()],
                },
                category: None,
                ai_status: Some("none".into()),
                pinned: false,
                source: "search-benchmark".into(),
                conflict_of: None,
                related: Vec::new(),
            };
            shard_core::write_fragment_file(&path, &frontmatter, &body).unwrap();
            let bytes = fs::metadata(&path).unwrap().len();
            file_bytes += bytes;
            largest_file = largest_file.max(bytes);
        }

        let runtime = SearchRuntime::default();
        let lockbox_runtime = LockboxRuntime::default();
        crate::search_sources::install_snapshot_builder(
            &runtime,
            &lockbox_runtime,
            std::sync::Arc::new(crate::search_index::IndexRegistry::default()),
        );
        let context = runtime.activate_vault(&vault);
        let vault_path = vault.display().to_string();
        let make_request = |query: &str, refresh| SearchVaultRequest {
            client_request_id: "search-5k".into(),
            expected_vault_path: vault_path.clone(),
            context: Some(context.clone()),
            scope: SearchScope::Public,
            include_trash: false,
            query_version: 1,
            projection_version: 1,
            query: query.into(),
            limit: 50,
            refresh,
        };

        let build_start = Instant::now();
        let first = search_vault_in_vault(
            vault.clone(),
            &runtime,
            &lockbox_runtime,
            make_request("检索", SearchRefresh::Rebuild),
        )
        .unwrap();
        assert!(matches!(first.index_state, SearchIndexState::Indexing));
        let deadline = Instant::now() + Duration::from_secs(120);
        while runtime.is_reconciling(&context, &SearchScope::Public) {
            assert!(Instant::now() < deadline, "5k search build timed out");
            thread::sleep(Duration::from_millis(5));
        }
        let initial_build = build_start.elapsed();
        let snapshot = runtime
            .clone_snapshot(&context, SearchScope::Public)
            .unwrap()
            .expect("5k snapshot was not published");
        assert_eq!(snapshot.documents.len(), DOCUMENTS);
        assert_eq!(snapshot.skipped_files, 0);
        let projection_bytes: usize = snapshot
            .documents
            .iter()
            .map(|document| document.projection.searchable_text.len())
            .sum();
        let mut kind_counts = [0_usize; 4];
        for metadata in snapshot.metadata.values() {
            let slot = match metadata.target.kind {
                SearchKind::Fragment => 0,
                SearchKind::Note => 1,
                SearchKind::Outline => 2,
                SearchKind::Document => 3,
                _ => panic!("unexpected 5k fixture kind"),
            };
            kind_counts[slot] += 1;
        }
        assert_eq!(kind_counts, [1_250; 4]);
        eprintln!(
            "search_5k initial_build={initial_build:?} files={DOCUMENTS} file_bytes={file_bytes} projection_bytes={projection_bytes} largest_file_bytes={largest_file} kinds={kind_counts:?}"
        );

        let mut samples = Vec::with_capacity(200);
        for index in 0..200 {
            let query = QUERIES[index % QUERIES.len()];
            let start = Instant::now();
            let response = search_vault_in_vault(
                vault.clone(),
                &runtime,
                &lockbox_runtime,
                make_request(query, SearchRefresh::Auto),
            )
            .unwrap();
            samples.push(start.elapsed());
            assert_eq!(
                response.snapshot_id.as_deref(),
                Some(snapshot.snapshot_id.as_str())
            );
            assert_eq!(response.total == Some(0), query == "绝无此关键词");
        }
        samples.sort_unstable();
        let p95 = samples[189];
        eprintln!(
            "search_5k hot_queries=200 p50={:?} p95={p95:?} max={:?}",
            samples[99], samples[199]
        );
        assert!(
            p95 <= Duration::from_millis(30),
            "hot query p95={p95:?} exceeds 30ms"
        );
    }
}
