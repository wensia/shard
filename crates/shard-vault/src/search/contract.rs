//! 搜索命令（`search_vault` / `read_search_target`）的线上契约，与前端 `src/lib/search-api.ts` 对应。
//!
//! 契约已冻结：serde 属性从 src-tauri 的 `search_contract.rs` 原样搬来，JSON 形状一字不改。
//! 只补了 `PartialEq` / `Eq`（不影响 JSON），方便双实现测试直接比对命中结果。

use serde::{Deserialize, Serialize};

use crate::Fragment;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    Public,
    Lockbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    Fragment,
    Note,
    Outline,
    Document,
    Mindmap,
    Flowchart,
    Canvas,
    Csv,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    Title,
    Tags,
    Body,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRevealHint {
    Text,
    DocumentOnly,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTarget {
    pub key: String,
    pub vault_path: String,
    pub scope: SearchScope,
    pub path: String,
    pub kind: SearchKind,
    pub object_id: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContext {
    pub vault_path: String,
    pub vault_epoch: String,
    pub privacy_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub target: SearchTarget,
    pub title: String,
    pub title_parts: Vec<SearchTextPart>,
    pub tags: Vec<String>,
    pub updated_at: Option<String>,
    pub revision: Option<String>,
    pub matched_fields: Vec<SearchField>,
    pub preview: Vec<SearchTextPart>,
    pub reveal_hint: SearchRevealHint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRefresh {
    Auto,
    Reconcile,
    Rebuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchIndexState {
    Indexing,
    Ready,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchVaultRequest {
    pub client_request_id: String,
    pub expected_vault_path: String,
    pub context: Option<SearchContext>,
    pub scope: SearchScope,
    pub include_trash: bool,
    pub query_version: u32,
    pub projection_version: u32,
    pub query: String,
    pub limit: u32,
    pub refresh: SearchRefresh,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchVaultResponse {
    pub client_request_id: String,
    pub context: SearchContext,
    pub snapshot_id: Option<String>,
    pub index_state: SearchIndexState,
    pub expires_at: Option<String>,
    pub hits: Vec<SearchHit>,
    pub total: Option<u32>,
    pub skipped_files: u32,
    pub warning: Option<SearchError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSearchTargetRequest {
    pub client_request_id: String,
    pub expected_vault_path: String,
    pub context: Option<SearchContext>,
    pub target: SearchTarget,
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSearchTargetResponse {
    pub client_request_id: String,
    pub context: SearchContext,
    pub expires_at: Option<String>,
    pub target: SearchTarget,
    pub revision: String,
    pub read_only: bool,
    pub fragment: Fragment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchError {
    InvalidRequest { reason: String },
    VaultChanged,
    ContextExpired,
    Locked,
    NotFound,
    TargetChanged,
    UnsupportedTarget,
    Io { retryable: bool },
    Internal { retryable: bool },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request_json() -> serde_json::Value {
        json!({
            "clientRequestId": "request-1",
            "expectedVaultPath": "/vault/A",
            "context": null,
            "scope": "public",
            "includeTrash": false,
            "queryVersion": 1,
            "projectionVersion": 1,
            "query": "季度计划",
            "limit": 50,
            "refresh": "auto"
        })
    }

    #[test]
    fn request_uses_camel_case_and_rejects_unknown_fields() {
        let request: SearchVaultRequest = serde_json::from_value(request_json()).unwrap();
        assert_eq!(request.client_request_id, "request-1");
        assert!(matches!(request.scope, SearchScope::Public));

        let mut unknown = request_json();
        unknown["extra"] = json!(true);
        assert!(serde_json::from_value::<SearchVaultRequest>(unknown).is_err());
    }

    #[test]
    fn response_and_error_serialization_match_the_frozen_contract() {
        let response = SearchVaultResponse {
            client_request_id: "request-1".into(),
            context: SearchContext {
                vault_path: "/vault/A".into(),
                vault_epoch: "12".into(),
                privacy_epoch: "4".into(),
            },
            snapshot_id: Some("snapshot-1".into()),
            index_state: SearchIndexState::Ready,
            expires_at: None,
            hits: vec![],
            total: Some(0),
            skipped_files: 0,
            warning: Some(SearchError::Io { retryable: true }),
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["clientRequestId"], "request-1");
        assert_eq!(value["indexState"], "ready");
        assert_eq!(value["warning"], json!({ "code": "io", "retryable": true }));

        assert_eq!(
            serde_json::to_value(SearchError::InvalidRequest {
                reason: "queryTooLong".into()
            })
            .unwrap(),
            json!({ "code": "invalidRequest", "reason": "queryTooLong" })
        );
    }

    /// 搬迁后整条命中、读取响应与全部错误码的 JSON 逐字段钉住，防止以后改类型时悄悄改了线上形状。
    #[test]
    fn hit_read_response_and_every_error_code_keep_their_wire_shape() {
        let target = SearchTarget {
            key: "[\"vault-A\",\"public\",\"notes/计划.md\"]".into(),
            vault_path: "vault-A".into(),
            scope: SearchScope::Public,
            path: "notes/计划.md".into(),
            kind: SearchKind::Mindmap,
            object_id: None,
            archived: true,
        };
        let hit = SearchHit {
            target: target.clone(),
            title: "计划".into(),
            title_parts: vec![SearchTextPart {
                text: "计划".into(),
                hit: true,
            }],
            tags: vec!["note".into()],
            updated_at: None,
            revision: Some("r1".into()),
            matched_fields: vec![
                SearchField::Title,
                SearchField::Tags,
                SearchField::Body,
                SearchField::Path,
            ],
            preview: vec![],
            reveal_hint: SearchRevealHint::DocumentOnly,
        };
        assert_eq!(
            serde_json::to_value(&hit).unwrap(),
            json!({
                "target": {
                    "key": "[\"vault-A\",\"public\",\"notes/计划.md\"]",
                    "vaultPath": "vault-A",
                    "scope": "public",
                    "path": "notes/计划.md",
                    "kind": "mindmap",
                    "objectId": null,
                    "archived": true
                },
                "title": "计划",
                "titleParts": [{ "text": "计划", "hit": true }],
                "tags": ["note"],
                "updatedAt": null,
                "revision": "r1",
                "matchedFields": ["title", "tags", "body", "path"],
                "preview": [],
                "revealHint": "documentOnly"
            })
        );
        for (kind, wire) in [
            (SearchKind::Fragment, "fragment"),
            (SearchKind::Note, "note"),
            (SearchKind::Outline, "outline"),
            (SearchKind::Document, "document"),
            (SearchKind::Mindmap, "mindmap"),
            (SearchKind::Flowchart, "flowchart"),
            (SearchKind::Canvas, "canvas"),
            (SearchKind::Csv, "csv"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(wire));
        }
        assert_eq!(
            serde_json::to_value(SearchRevealHint::External).unwrap(),
            json!("external")
        );
        assert_eq!(
            serde_json::to_value(SearchScope::Lockbox).unwrap(),
            json!("lockbox")
        );
        assert_eq!(
            serde_json::to_value(SearchIndexState::Stale).unwrap(),
            json!("stale")
        );
        assert_eq!(
            serde_json::to_value(SearchRefresh::Reconcile).unwrap(),
            json!("reconcile")
        );

        for (error, wire) in [
            (SearchError::VaultChanged, json!({ "code": "vaultChanged" })),
            (
                SearchError::ContextExpired,
                json!({ "code": "contextExpired" }),
            ),
            (SearchError::Locked, json!({ "code": "locked" })),
            (SearchError::NotFound, json!({ "code": "notFound" })),
            (
                SearchError::TargetChanged,
                json!({ "code": "targetChanged" }),
            ),
            (
                SearchError::UnsupportedTarget,
                json!({ "code": "unsupportedTarget" }),
            ),
            (
                SearchError::Internal { retryable: false },
                json!({ "code": "internal", "retryable": false }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&error).unwrap(), wire);
            assert_eq!(serde_json::from_value::<SearchError>(wire).unwrap(), error);
        }

        let response = ReadSearchTargetResponse {
            client_request_id: "request-2".into(),
            context: SearchContext {
                vault_path: "vault-A".into(),
                vault_epoch: "1".into(),
                privacy_epoch: "0".into(),
            },
            expires_at: None,
            target,
            revision: "r1".into(),
            read_only: true,
            fragment: Fragment {
                id: "f1".into(),
                content: "正文".into(),
                file_sha: "sha".into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                tags: vec!["inbox".into()],
                category: None,
                path: "notes/计划.md".into(),
                git_status: "saved".into(),
                error: None,
                ai_status: "none".into(),
                archived: false,
                lockbox: false,
                pinned: false,
                related: Vec::new(),
                properties: Vec::new(),
                conflict_of: None,
            },
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["clientRequestId"], "request-2");
        assert_eq!(value["readOnly"], true);
        assert_eq!(value["expiresAt"], json!(null));
        assert_eq!(value["fragment"]["fileSha"], "sha");
        assert!(value["fragment"].get("conflictOf").is_none());
    }
}
