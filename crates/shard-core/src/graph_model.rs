use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

use crate::frontmatter::parse_fragment;

pub const SHARD_MAP_KIND: &str = "shard.map";
pub const SHARD_MAP_SCHEMA_VERSION: u32 = 1;
pub const SHARD_MAP_MAX_NODES: usize = 400;
pub const SHARD_MAP_MAX_NODE_TEXT_CHARS: usize = 2_000;

const MAX_CANVAS_BYTES: usize = 8 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShardMapFile {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub saved_with_app_version: String,
    pub revision: u64,
    pub root_id: String,
    pub has_protected_links: bool,
    pub nodes: BTreeMap<String, ShardMapNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<ShardMapViewport>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShardMapViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShardMapNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub sort_key: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub collapsed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<ShardDocumentLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<ShardMapNodeStyle>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShardMapNodeStyle {
    pub tone: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(
    tag = "targetType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ShardDocumentLink {
    Fragment {
        id: String,
        #[serde(alias = "target_id")]
        target_id: String,
    },
    MarkdownPath {
        id: String,
        path: String,
    },
    Map {
        id: String,
        #[serde(alias = "target_id")]
        target_id: String,
    },
    Flow {
        id: String,
        #[serde(alias = "target_id")]
        target_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFile {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNode {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<ShardDocumentLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mind_map: Option<ShardMapFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_handle: Option<String>,
}

fn io(error: impl ToString) -> String {
    error.to_string()
}

fn identifier(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control)
    {
        return Err("画布对象 ID 必须非空且不超过 200 字。".into());
    }
    Ok(())
}

fn timestamp(value: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| "画布时间必须是有效的 RFC3339 日期。".into())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("画布目标必须是普通文件。".into());
    }
    if metadata.len() > MAX_CANVAS_BYTES as u64 {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io)?
        .take(MAX_CANVAS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > MAX_CANVAS_BYTES {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    Ok(bytes)
}

fn scan_files(
    root: &Path,
    suffix: &str,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io(error)),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("画布身份检查不允许符号链接目录。".into())
        }
        Ok(_) => (),
    }
    for entry in fs::read_dir(root).map_err(io)? {
        let entry = entry.map_err(io)?;
        *visited += 1;
        if *visited > 100_000 {
            return Err("资料库条目超过本次画布身份检查上限。".into());
        }
        let kind = entry.file_type().map_err(io)?;
        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            scan_files(&entry.path(), suffix, files, visited)?;
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn safe_relative(
    vault: &Path,
    relative: &str,
    roots: &[&str],
    missing: bool,
) -> Result<PathBuf, String> {
    if relative.contains('\\')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("画布路径不能包含空组件、反斜杠、. 或 ..。".into());
    }
    let path = Path::new(relative);
    if !matches!(path.components().next(), Some(Component::Normal(root)) if roots.iter().any(|allowed| root == *allowed))
    {
        return Err("画布只能使用公开资料库路径。".into());
    }
    let mut target = vault.to_path_buf();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err("画布路径必须是 vault 内的相对路径。".into());
        };
        if part.to_string_lossy().starts_with('.') {
            return Err("画布不能引用隐藏或内部路径。".into());
        }
        target.push(part);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("画布路径不能包含符号链接。".into())
            }
            Ok(_) => (),
            Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io(error)),
        }
    }
    Ok(target)
}

fn protected_fragment_ids(vault: &Path) -> Result<HashSet<String>, String> {
    let mut files = Vec::new();
    scan_files(&vault.join("lockbox"), ".shard", &mut files, &mut 0)?;
    let mut ids = HashSet::new();
    #[derive(Deserialize)]
    struct Identity {
        id: String,
    }
    for file in files {
        if let Ok(identity) = serde_json::from_slice::<Identity>(&read_bounded(&file)?) {
            ids.insert(identity.id);
        }
    }
    Ok(ids)
}

fn validate_link(
    vault: &Path,
    link: &ShardDocumentLink,
    protected: &HashSet<String>,
) -> Result<(), String> {
    match link {
        ShardDocumentLink::Fragment { id, target_id }
        | ShardDocumentLink::Map { id, target_id }
        | ShardDocumentLink::Flow { id, target_id } => {
            identifier(id)?;
            identifier(target_id)?;
            if target_id.contains(['/', '\\']) {
                return Err("画布引用目标 ID 不能包含路径分隔符。".into());
            }
            if matches!(link, ShardDocumentLink::Fragment { .. }) && protected.contains(target_id) {
                return Err("公开画布不能引用密匣片段。".into());
            }
        }
        ShardDocumentLink::MarkdownPath { id, path } => {
            identifier(id)?;
            let full = safe_relative(vault, path, &["notes", "fragments"], true)?;
            if path.len() > 4096
                || !full
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                || (full.exists() && !full.is_file())
            {
                return Err("画布资料卡片只能引用公开 Markdown 文件。".into());
            }
        }
    }
    Ok(())
}

/// Deleted public targets remain valid links. Privacy and path boundaries still apply.
pub fn validate_public_link(vault: &Path, link: &ShardDocumentLink) -> Result<(), String> {
    let protected = if matches!(link, ShardDocumentLink::Fragment { .. }) {
        protected_fragment_ids(vault)?
    } else {
        HashSet::new()
    };
    validate_link(vault, link, &protected)
}

pub fn validate_mind_map_file(vault: &Path, file: &ShardMapFile) -> Result<(), String> {
    if file.kind != SHARD_MAP_KIND {
        return Err("不支持的导图文件类型。".to_string());
    }
    if file.schema_version != SHARD_MAP_SCHEMA_VERSION {
        return Err("不支持的导图 schema 版本。".to_string());
    }
    if file.id.trim().is_empty() {
        return Err("导图 id 不能为空。".to_string());
    }
    if file.title.trim().is_empty() {
        return Err("导图标题不能为空。".to_string());
    }
    if file.has_protected_links {
        return Err("当前版本不支持带密匣链接的明文导图。".to_string());
    }
    if !file.nodes.contains_key(&file.root_id) {
        return Err("导图缺少 root 节点。".to_string());
    }
    if file.nodes.len() > SHARD_MAP_MAX_NODES {
        return Err(format!("导图节点数量不能超过 {}。", SHARD_MAP_MAX_NODES));
    }
    if file
        .nodes
        .get(&file.root_id)
        .and_then(|node| node.parent_id.as_ref())
        .is_some()
    {
        return Err("root 节点的 parentId 必须为空。".to_string());
    }

    for (node_id, node) in &file.nodes {
        if node
            .width
            .is_some_and(|width| !width.is_finite() || width <= 0.0 || width > 10_000.0)
        {
            return Err("导图节点宽度无效。".to_string());
        }
        validate_mind_map_node(vault, file, node_id, node)?;
    }
    validate_mind_map_tree_shape(file)
}

fn validate_mind_map_tree_shape(file: &ShardMapFile) -> Result<(), String> {
    let mut sibling_sort_keys = HashSet::new();
    for node in file.nodes.values() {
        let parent_key = node.parent_id.as_deref().unwrap_or("__root__");
        let sibling_key = format!("{}\0{}", parent_key, node.sort_key);
        if !sibling_sort_keys.insert(sibling_key) {
            return Err(format!("同级节点存在重复 sortKey：{}。", node.sort_key));
        }
    }

    let mut visited = HashSet::new();
    let mut visiting = HashSet::new();
    visit_mind_map_node(file, &file.root_id, &mut visiting, &mut visited)?;
    if visited.len() != file.nodes.len() {
        return Err("导图包含无法从 root 到达的节点。".to_string());
    }
    Ok(())
}

fn visit_mind_map_node(
    file: &ShardMapFile,
    node_id: &str,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
) -> Result<(), String> {
    if visited.contains(node_id) {
        return Ok(());
    }
    if !visiting.insert(node_id.to_string()) {
        return Err("导图包含循环父子关系。".to_string());
    }
    for child in file
        .nodes
        .values()
        .filter(|node| node.parent_id.as_deref() == Some(node_id))
    {
        visit_mind_map_node(file, &child.id, visiting, visited)?;
    }
    visiting.remove(node_id);
    visited.insert(node_id.to_string());
    Ok(())
}

fn validate_mind_map_node(
    vault: &Path,
    file: &ShardMapFile,
    node_id: &str,
    node: &ShardMapNode,
) -> Result<(), String> {
    if node.id != node_id {
        return Err(format!("节点 {} 的 id 与索引不一致。", node_id));
    }
    if node.id.trim().is_empty() {
        return Err("节点 id 不能为空。".to_string());
    }
    if node.sort_key.trim().is_empty() {
        return Err(format!("节点 {} 缺少 sortKey。", node.id));
    }
    if node.text.chars().count() > SHARD_MAP_MAX_NODE_TEXT_CHARS {
        return Err(format!("节点 {} 文本过长。", node.id));
    }
    if node.parent_id.is_none() && node.id != file.root_id {
        return Err(format!("非 root 节点 {} 缺少 parentId。", node.id));
    }
    if let Some(parent_id) = node.parent_id.as_deref() {
        if parent_id == node.id {
            return Err(format!("节点 {} 不能把自己作为父节点。", node.id));
        }
        if !file.nodes.contains_key(parent_id) {
            return Err(format!("节点 {} 指向不存在的父节点。", node.id));
        }
    }
    for link in &node.links {
        validate_public_link(vault, link)?;
    }
    Ok(())
}

pub fn validate_canvas_file(vault: &Path, file: &CanvasFile) -> Result<(), String> {
    if !matches!(file.kind.as_str(), "shard.canvas" | "shard.flow") || file.schema_version != 1 {
        return Err("不支持的画布格式或版本。".into());
    }
    identifier(&file.id)?;
    if file.title.trim().is_empty() || file.title.chars().count() > 500 {
        return Err("画布标题必须非空且不超过 500 字。".into());
    }
    timestamp(&file.created_at)?;
    timestamp(&file.updated_at)?;
    if file.revision > MAX_REVISION || file.nodes.len() > 400 || file.edges.len() > 1600 {
        return Err("画布版本或节点、连线数量超过限制。".into());
    }
    let has_fragment_links = file.nodes.iter().any(|node| {
        matches!(node.link, Some(ShardDocumentLink::Fragment { .. }))
            || node.mind_map.as_ref().is_some_and(|map| {
                map.nodes.values().any(|node| {
                    node.links
                        .iter()
                        .any(|link| matches!(link, ShardDocumentLink::Fragment { .. }))
                })
            })
    });
    let protected = if has_fragment_links {
        protected_fragment_ids(vault)?
    } else {
        HashSet::new()
    };
    let mut node_ids = HashSet::new();
    let mut total = file.nodes.len();
    for node in &file.nodes {
        identifier(&node.id)?;
        if !node_ids.insert(node.id.as_str()) {
            return Err("画布存在重复节点 ID。".into());
        }
        if !node.x.is_finite()
            || !node.y.is_finite()
            || node.x.abs() > 1_000_000.0
            || node.y.abs() > 1_000_000.0
            || node
                .width
                .is_some_and(|size| !size.is_finite() || size <= 0.0 || size > 10_000.0)
            || node
                .height
                .is_some_and(|size| !size.is_finite() || size <= 0.0 || size > 10_000.0)
            || node.text.chars().count() > 20_000
        {
            return Err("画布节点坐标、尺寸或文字超过限制。".into());
        }
        if !matches!(
            node.kind.as_str(),
            "process" | "decision" | "terminal" | "text" | "reference" | "mindmap"
        ) {
            return Err("不支持的画布节点类型。".into());
        }
        if file.kind == "shard.flow" && node.kind == "mindmap" {
            return Err("流程图不能包含思维导图，请通过文档链接关联。".into());
        }
        if (node.kind == "reference") != node.link.is_some()
            || (node.kind == "mindmap") != node.mind_map.is_some()
        {
            return Err(
                "资料卡片必须包含链接，导图对象必须包含导图，其他对象不能混入该数据。".into(),
            );
        }
        if let Some(link) = &node.link {
            validate_link(vault, link, &protected)?;
        }
        if let Some(map) = &node.mind_map {
            total += map.nodes.len();
            identifier(&map.id)?;
            if map.title.trim().is_empty() || map.title.chars().count() > 2000 {
                return Err("内嵌导图标题无效。".into());
            }
            timestamp(&map.created_at)?;
            timestamp(&map.updated_at)?;
            if map.revision > MAX_REVISION {
                return Err("内嵌导图版本无效。".into());
            }
            if map.viewport.as_ref().is_some_and(|view| {
                !view.x.is_finite()
                    || !view.y.is_finite()
                    || !view.zoom.is_finite()
                    || view.zoom <= 0.0
            }) {
                return Err("内嵌导图视口无效。".into());
            }
            let mut tree = map.clone();
            for node in tree.nodes.values_mut() {
                node.links.clear();
            }
            validate_mind_map_file(vault, &tree)?;
            for node in map.nodes.values() {
                identifier(&node.id)?;
                timestamp(&node.created_at)?;
                timestamp(&node.updated_at)?;
                if !node
                    .sort_key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
                    || node.sort_key.len() > 1000
                    || node
                        .note
                        .as_ref()
                        .is_some_and(|note| note.chars().count() > 20_000)
                {
                    return Err("内嵌导图排序键或备注无效。".into());
                }
                if node
                    .width
                    .is_some_and(|width| !width.is_finite() || width <= 0.0 || width > 10_000.0)
                    || node
                        .style
                        .as_ref()
                        .and_then(|style| style.tone.as_deref())
                        .is_some_and(|tone| {
                            !matches!(tone, "default" | "accent" | "success" | "warning")
                        })
                {
                    return Err("内嵌导图尺寸或样式无效。".into());
                }
                for link in &node.links {
                    validate_link(vault, link, &protected)?;
                }
            }
        }
    }
    if total > 2000 {
        return Err("画布包含导图在内最多 2000 个节点。".into());
    }
    let mut edge_ids = HashSet::new();
    for edge in &file.edges {
        identifier(&edge.id)?;
        if !edge_ids.insert(edge.id.as_str())
            || !node_ids.contains(edge.source.as_str())
            || !node_ids.contains(edge.target.as_str())
        {
            return Err("画布连线 ID 重复或端点不存在。".into());
        }
        if edge.label.chars().count() > 2000
            || [&edge.source_handle, &edge.target_handle]
                .iter()
                .any(|handle| {
                    handle
                        .as_deref()
                        .is_some_and(|value| !matches!(value, "top" | "right" | "bottom" | "left"))
                })
        {
            return Err("画布连线标签或连接点无效。".into());
        }
    }
    canonical_canvas_text(file)?;
    Ok(())
}

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(io)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_CANVAS_BYTES {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    Ok(bytes)
}

pub fn canonical_mind_map_text(file: &ShardMapFile) -> Result<String, String> {
    let text = serde_json::to_string_pretty(file).map_err(io)?;
    Ok(format!("{text}\n"))
}

pub fn canonical_canvas_text(file: &CanvasFile) -> Result<String, String> {
    String::from_utf8(canonical_json_bytes(file)?).map_err(io)
}

pub fn mind_map_search_text(file: &ShardMapFile) -> String {
    file.nodes
        .values()
        .map(|node| node.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn canvas_search_text(file: &CanvasFile) -> String {
    let mut lines = Vec::new();
    for node in &file.nodes {
        push_search_line(&mut lines, &node.text);
        if let Some(map) = &node.mind_map {
            push_search_line(&mut lines, &map.title);
            for map_node in map.nodes.values() {
                push_search_line(&mut lines, &map_node.text);
            }
        }
    }
    for edge in &file.edges {
        push_search_line(&mut lines, &edge.label);
    }
    lines.join("\n")
}

fn push_search_line(lines: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        lines.push(value.to_string());
    }
}

fn collect_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        let file_type = entry.file_type().map_err(io)?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_markdown_files(&path, files)?;
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("md")
        {
            files.push(path);
        }
    }
    Ok(())
}

pub fn find_fragment_path(vault: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    let mut files = Vec::new();
    collect_markdown_files(&vault.join("fragments"), &mut files)?;
    collect_markdown_files(&vault.join(".trash").join("fragments"), &mut files)?;
    collect_markdown_files(&vault.join("notes"), &mut files)?;
    for path in files {
        let text = fs::read_to_string(&path).map_err(io)?;
        if parse_fragment(&text).is_ok_and(|parsed| parsed.frontmatter.id == id) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

pub fn content_sha256_hex(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map_node(id: &str, parent_id: Option<&str>, sort_key: &str) -> ShardMapNode {
        ShardMapNode {
            id: id.into(),
            parent_id: parent_id.map(str::to_string),
            sort_key: sort_key.into(),
            text: id.into(),
            note: None,
            collapsed: false,
            width: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            links: Vec::new(),
            style: None,
        }
    }

    fn map_fixture() -> ShardMapFile {
        ShardMapFile {
            kind: SHARD_MAP_KIND.into(),
            schema_version: SHARD_MAP_SCHEMA_VERSION,
            id: "map-1".into(),
            title: "导图".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            saved_with_app_version: "0.1.3".into(),
            revision: 1,
            root_id: "root".into(),
            has_protected_links: false,
            nodes: BTreeMap::from([
                ("root".into(), map_node("root", None, "a0")),
                ("child".into(), map_node("child", Some("root"), "a1")),
            ]),
            viewport: None,
        }
    }

    fn flow_fixture(x: f64) -> CanvasFile {
        CanvasFile {
            kind: "shard.flow".into(),
            schema_version: 1,
            id: "flow-1".into(),
            title: "流程".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            revision: 1,
            nodes: vec![CanvasNode {
                id: "node-1".into(),
                kind: "process".into(),
                x,
                y: -x,
                text: "步骤".into(),
                width: None,
                height: None,
                link: None,
                mind_map: None,
            }],
            edges: Vec::new(),
        }
    }

    #[test]
    fn canvas_float_roundtrip_preserves_bits() {
        let x = 0.1_f64 + 0.2_f64;
        let original = flow_fixture(x);
        let vault = tempfile::tempdir().unwrap();
        validate_canvas_file(vault.path(), &original).unwrap();
        let text = canonical_canvas_text(&original).unwrap();
        let decoded: CanvasFile = serde_json::from_str(&text).unwrap();
        assert_eq!(decoded.nodes[0].x.to_bits(), x.to_bits());
        assert_eq!(decoded.nodes[0].y.to_bits(), (-x).to_bits());
    }

    #[test]
    fn mind_map_validation_accepts_tree_and_rejects_unreachable_node() {
        let vault = tempfile::tempdir().unwrap();
        let valid = map_fixture();
        validate_mind_map_file(vault.path(), &valid).unwrap();

        let mut invalid = valid;
        invalid
            .nodes
            .insert("orphan".into(), map_node("orphan", Some("missing"), "a2"));
        assert_eq!(
            validate_mind_map_file(vault.path(), &invalid).unwrap_err(),
            "节点 orphan 指向不存在的父节点。"
        );
    }

    #[test]
    fn canvas_validation_rejects_duplicate_node_ids() {
        let vault = tempfile::tempdir().unwrap();
        let mut invalid = flow_fixture(1.0);
        invalid.nodes.push(invalid.nodes[0].clone());
        assert_eq!(
            validate_canvas_file(vault.path(), &invalid).unwrap_err(),
            "画布存在重复节点 ID。"
        );
    }

    #[test]
    fn public_graph_rejects_lockbox_fragment_link() {
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join("lockbox/fragments")).unwrap();
        fs::write(
            vault.path().join("lockbox/fragments/private.shard"),
            r#"{"id":"private-fragment"}"#,
        )
        .unwrap();
        let link = ShardDocumentLink::Fragment {
            id: "link-1".into(),
            target_id: "private-fragment".into(),
        };
        assert_eq!(
            validate_public_link(vault.path(), &link).unwrap_err(),
            "公开画布不能引用密匣片段。"
        );
    }

    #[test]
    fn canvas_model_rejects_unknown_fields() {
        let mut value = serde_json::to_value(flow_fixture(1.0)).unwrap();
        value["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<CanvasFile>(value).is_err());
    }

    #[test]
    fn finds_public_fragment_by_frontmatter_id() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("fragments/2026/01");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("name.md");
        fs::write(
            &path,
            "---\nid: wanted\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\ntags: [inbox]\ncategory: null\nai_status: none\nsource: test\n---\nbody",
        )
        .unwrap();
        assert_eq!(
            find_fragment_path(temp.path(), "wanted").unwrap(),
            Some(path)
        );
    }
}
