//! 与运行时无关的搜索组装：请求校验、查询解析、在已投影的文档集合上精确扫描并组装命中。
//!
//! 从 src-tauri 的 `search_commands.rs`（`search_vault_in_vault` 与 `map_hit`）搬来。桌面的运行时快照、
//! 上下文 / 代次校验、密匣租约留在 src-tauri；服务端按自己的内容库 seq 管快照，同样调这里。

use std::collections::HashMap;

use shard_core::search::{
    scan_exact_filtered, MatchLocation, MatchedField, ParsedQuery, ProjectedDocument, ScanMatch,
    SearchQueryErrorReason,
};

use super::{
    contract::{
        SearchError, SearchField, SearchHit, SearchRevealHint, SearchTextPart, SearchVaultRequest,
    },
    documents::SearchDocumentMetadata,
};

/// `queryVersion` / `projectionVersion` 目前唯一支持的版本。
pub const SEARCH_WIRE_VERSION: u32 = 1;
/// 一次最多返回的命中数。
pub const SEARCH_LIMIT_MAX: u32 = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchScanResult {
    /// 按相关度排好、最多 `limit` 条。
    pub hits: Vec<SearchHit>,
    /// 全部命中数（不受 `limit` 截断）。
    pub total: u32,
}

/// 与运行时无关的请求校验，原因码固定（前端按码显示）。
pub fn validate_search_request(request: &SearchVaultRequest) -> Result<(), SearchError> {
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

/// 解析查询；过长或关键词过多报 `invalidRequest`（`queryTooLong` / `tooManyTerms`）。
pub fn parse_search_query(query: &str) -> Result<ParsedQuery, SearchError> {
    ParsedQuery::parse(query).map_err(|error| {
        invalid_request(match error.reason {
            SearchQueryErrorReason::QueryTooLong => "queryTooLong",
            SearchQueryErrorReason::TooManyTerms => "tooManyTerms",
        })
    })
}

pub fn invalid_request(reason: &str) -> SearchError {
    SearchError::InvalidRequest {
        reason: reason.to_string(),
    }
}

/// 在一组已投影的文档上精确扫描。`documents` 必须按 `stable_key` 升序（命中回查用二分），
/// `metadata` 以 `stable_key` 为键；`include_trash` 为假时跳过回收站条目（`target.archived`）。
pub fn scan_documents(
    documents: &[ProjectedDocument],
    metadata: &HashMap<String, SearchDocumentMetadata>,
    query: &ParsedQuery,
    limit: usize,
    include_trash: bool,
) -> Result<SearchScanResult, SearchError> {
    let scanned = scan_exact_filtered(documents, query, limit, |document| {
        include_trash
            || metadata
                .get(&document.stable_key)
                .is_some_and(|metadata| !metadata.target.archived)
    });
    let hits = scanned
        .matches
        .into_iter()
        .map(|matched| {
            let metadata = metadata
                .get(&matched.stable_key)
                .ok_or(SearchError::Internal { retryable: false })?;
            let document = documents
                .binary_search_by(|document| document.stable_key.cmp(&matched.stable_key))
                .ok()
                .and_then(|index| documents.get(index))
                .ok_or(SearchError::Internal { retryable: false })?;
            map_hit(document, metadata, matched)
        })
        .collect::<Result<Vec<_>, SearchError>>()?;
    Ok(SearchScanResult {
        hits,
        total: u32::try_from(scanned.total).unwrap_or(u32::MAX),
    })
}

/// 一条扫描命中 → 线上的 [`SearchHit`]。标题分段拼回来必须等于标题，否则视为内部错误。
pub fn map_hit(
    document: &ProjectedDocument,
    metadata: &SearchDocumentMetadata,
    matched: ScanMatch,
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
