//! 命令返回给前端的 DTO。serde 属性就是 JSON 合同，搬迁时原样保留。

use crate::prelude::*;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fragment {
    pub id: String,
    pub content: String,
    pub file_sha: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub path: String,
    pub git_status: String,
    pub error: Option<String>,
    pub ai_status: String,
    pub archived: bool,
    pub lockbox: bool,
    pub pinned: bool,
    pub related: Vec<FragmentRelation>,
    pub properties: Vec<FragmentProperty>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_of: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FragmentProperty {
    pub key: String,
    pub value: PropertyValue,
    pub editable: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PropertyValue {
    Text { text: String },
    Number { text: String },
    Bool { value: bool },
    Null,
    List { items: Vec<String> },
    Other { raw: String },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum PropertyInputValue {
    Text(Option<String>),
    Number(Option<String>),
    Date(Option<String>),
    Datetime(Option<String>),
    Checkbox(Option<bool>),
    List(Option<Vec<String>>),
    Link(Option<String>),
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PropertyType {
    Text,
    Number,
    Date,
    Datetime,
    Checkbox,
    List,
    Link,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PropertyRegistry {
    pub version: u32,
    pub properties: BTreeMap<String, PropertyRegistryEntry>,
}

impl Default for PropertyRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            properties: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PropertyRegistryEntry {
    #[serde(rename = "type")]
    pub property_type: PropertyType,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRegistryReadResult {
    pub registry: PropertyRegistry,
    pub sha: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFragmentResult {
    pub fragment: Fragment,
    pub graph: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvFileSummary {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mind_map_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LibraryTreeEntry>>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FragmentMonthSummary {
    pub month: String,
    pub count: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FragmentYearSummary {
    pub year: String,
    pub total_count: usize,
    pub months: Vec<FragmentMonthSummary>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FragmentStreamSummary {
    pub total_count: usize,
    pub years: Vec<FragmentYearSummary>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetEntry {
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    pub mime_type: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTreeSnapshot {
    pub entries: Vec<LibraryTreeEntry>,
    pub fragment_entries: Vec<LibraryTreeEntry>,
    pub trash_entries: Vec<LibraryTreeEntry>,
    pub fragment_trash_entries: Vec<LibraryTreeEntry>,
    pub fragment_stream: FragmentStreamSummary,
    pub assets: Vec<LibraryAssetEntry>,
}

#[derive(Debug, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentScope {
    #[default]
    Library,
    Fragments,
    All,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMutationResult {
    pub tree: LibraryTreeSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<Fragment>,
    pub updated_links: usize,
    /// 改名、移动图片或目录时，正文里随之改写的图片引用处数。
    pub updated_image_refs: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub short_commit: String,
    pub has_remote: bool,
    pub status: String,
    pub error: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MindMapSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub node_count: usize,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MindMapReadResult {
    pub file: ShardMapFile,
    pub path: String,
    pub last_saved_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDatasetResult {
    pub dataset: DatasetSnapshot,
    pub library: LibraryMutationResult,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportResult {
    pub tree: LibraryTreeSnapshot,
    pub imported: Vec<String>,
    pub skipped: Vec<LibraryImportSkip>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    /// "not_git" | "blocked" | "no_changes" | "committed"
    pub status: String,
    /// committed 时提交中的变更路径数（rename 计 1）
    pub changes: usize,
    /// blocked 时的原因说明
    pub reason: Option<String>,
    /// 超过单文件上限、没有提交的路径
    pub skipped_large: Vec<String>,
    pub git: GitInfo,
}
