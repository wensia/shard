use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    Public,
    Lockbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    Fragment,
    Note,
    Outline,
    Document,
    Mindmap,
    Flowchart,
    Canvas,
    Table,
    Csv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    Title,
    Tags,
    Body,
    Path,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRevealHint {
    Text,
    DocumentOnly,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContext {
    pub vault_path: String,
    pub vault_epoch: String,
    pub privacy_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRefresh {
    Auto,
    Reconcile,
    Rebuild,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub fragment: crate::Fragment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}
