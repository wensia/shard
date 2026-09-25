mod projection;
mod scan;

use std::{error::Error, fmt};

pub use projection::{project_document, project_markdown};
pub use scan::scan_exact;

pub const SEARCH_QUERY_MAX_CHARACTERS: usize = 256;
pub const SEARCH_QUERY_MAX_TERMS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchQueryErrorReason {
    QueryTooLong,
    TooManyTerms,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQueryError {
    pub reason: SearchQueryErrorReason,
}

impl fmt::Display for SearchQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.reason {
            SearchQueryErrorReason::QueryTooLong => "搜索内容不能超过 256 个字符。",
            SearchQueryErrorReason::TooManyTerms => "搜索关键词不能超过 8 个。",
        };
        formatter.write_str(message)
    }
}

impl Error for SearchQueryError {}

pub fn normalize_search_text(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                normalized.push('\n');
            }
            '\u{3000}' => normalized.push(' '),
            '\u{ff01}'..='\u{ff5e}' => {
                let folded = char::from_u32(character as u32 - 0xfee0).unwrap_or(character);
                normalized.push(fold_ascii_case(folded));
            }
            _ => normalized.push(fold_ascii_case(character)),
        }
    }

    normalized
}

fn fold_ascii_case(character: char) -> char {
    if character.is_ascii_uppercase() {
        character.to_ascii_lowercase()
    } else {
        character
    }
}

pub fn parse_search_terms(query: &str) -> Result<Vec<String>, SearchQueryError> {
    if query.chars().count() > SEARCH_QUERY_MAX_CHARACTERS {
        return Err(SearchQueryError {
            reason: SearchQueryErrorReason::QueryTooLong,
        });
    }

    let mut terms = Vec::new();
    for term in normalize_search_text(query).split_whitespace() {
        if !terms.iter().any(|existing| existing == term) {
            terms.push(term.to_string());
        }
    }
    if terms.len() > SEARCH_QUERY_MAX_TERMS {
        return Err(SearchQueryError {
            reason: SearchQueryErrorReason::TooManyTerms,
        });
    }
    Ok(terms)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuery {
    pub terms: Vec<String>,
}

impl ParsedQuery {
    pub fn parse(query: &str) -> Result<Self, SearchQueryError> {
        Ok(Self {
            terms: parse_search_terms(query)?,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDocument {
    pub stable_key: String,
    pub title: String,
    pub tags: Vec<String>,
    pub body: String,
    pub modified_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchProjectionBlock {
    Text {
        text: String,
    },
    DocumentOnly {
        reason: DocumentOnlyReason,
        text: String,
    },
}

impl SearchProjectionBlock {
    pub fn text(&self) -> &str {
        match self {
            Self::Text { text } | Self::DocumentOnly { text, .. } => text,
        }
    }

    fn is_revealable(&self) -> bool {
        matches!(self, Self::Text { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentOnlyReason {
    CodeBlock,
    Embed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProjection {
    pub blocks: Vec<SearchProjectionBlock>,
    pub document_only_text: String,
    pub revealable_text: String,
    pub searchable_text: String,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedDocument {
    pub stable_key: String,
    pub title: String,
    pub tags: Vec<String>,
    pub modified_at: i64,
    pub projection: SearchProjection,
    pub(crate) normalized_title: String,
    pub(crate) normalized_tags: Vec<String>,
    pub(crate) normalized_blocks: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedField {
    Title,
    Tags,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchLocation {
    Text,
    DocumentOnly,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchTextPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanMatch {
    pub stable_key: String,
    pub matched_fields: Vec<MatchedField>,
    pub title_parts: Vec<SearchTextPart>,
    pub preview: Vec<SearchTextPart>,
    pub location: MatchLocation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanResult {
    pub matches: Vec<ScanMatch>,
    pub total: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProjectionFixture {
        version: u32,
        cases: Vec<ProjectionCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ProjectionCase {
        id: String,
        markdown: String,
        expected: SearchProjection,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QueryFixture {
        version: u32,
        normalization_cases: Vec<NormalizationCase>,
        documents: Vec<QueryDocument>,
        queries: Vec<QueryCase>,
    }

    #[derive(Debug, Deserialize)]
    struct NormalizationCase {
        id: String,
        input: String,
        normalized: String,
        terms: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QueryDocument {
        key: String,
        title: String,
        tags: Vec<String>,
        body: String,
        modified_at: i64,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QueryCase {
        id: String,
        query: String,
        limit: usize,
        expected_keys: Vec<String>,
        total: usize,
    }

    fn query_fixture() -> QueryFixture {
        serde_yaml::from_str(include_str!(
            "../../../../tests/fixtures/search/query-v1.json"
        ))
        .expect("query fixture should be valid JSON/YAML")
    }

    fn projection_fixture() -> ProjectionFixture {
        serde_yaml::from_str(include_str!(
            "../../../../tests/fixtures/search/projection-v1.json"
        ))
        .expect("projection fixture should be valid JSON/YAML")
    }

    fn fixture_documents(fixture: &QueryFixture) -> Vec<ProjectedDocument> {
        fixture
            .documents
            .iter()
            .map(|document| {
                project_document(&SourceDocument {
                    stable_key: document.key.clone(),
                    title: document.title.clone(),
                    tags: document.tags.clone(),
                    body: document.body.clone(),
                    modified_at: document.modified_at,
                })
            })
            .collect()
    }

    #[test]
    fn search_ts_and_rust_golden_cases_agree() {
        let projection = projection_fixture();
        assert_eq!(projection.version, 1);
        for case in projection.cases {
            assert_eq!(
                project_markdown(&case.markdown),
                case.expected,
                "{}",
                case.id
            );
        }

        let query = query_fixture();
        assert_eq!(query.version, 1);
        for case in &query.normalization_cases {
            assert_eq!(
                normalize_search_text(&case.input),
                case.normalized,
                "{}",
                case.id
            );
            assert_eq!(
                parse_search_terms(&case.input).unwrap(),
                case.terms,
                "{}",
                case.id
            );
        }

        let documents = fixture_documents(&query);
        for case in query.queries {
            let result = scan_exact(
                &documents,
                &ParsedQuery::parse(&case.query).unwrap(),
                case.limit,
            );
            assert_eq!(result.total, case.total, "{}", case.id);
            assert_eq!(
                result
                    .matches
                    .iter()
                    .map(|hit| hit.stable_key.as_str())
                    .collect::<Vec<_>>(),
                case.expected_keys
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                "{}",
                case.id
            );
        }
    }

    #[test]
    fn search_query_limits_are_explicit() {
        assert_eq!(
            ParsedQuery::parse(&"😀".repeat(257)).unwrap_err().reason,
            SearchQueryErrorReason::QueryTooLong
        );
        assert_eq!(
            ParsedQuery::parse("一 二 三 四 五 六 七 八 九")
                .unwrap_err()
                .reason,
            SearchQueryErrorReason::TooManyTerms
        );
    }
}
