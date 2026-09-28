use serde_json::{json, Value};
use shard_core::{
    derive_type,
    frontmatter::{apply_frontmatter, parse_fragment},
    graph_model::{
        canonical_canvas_text, canonical_mind_map_text, content_sha256_hex, find_fragment_path,
        now_rfc3339, validate_canvas_file, validate_mind_map_file, CanvasFile, ShardMapFile,
        ShardMapNode,
    },
    graph_region::{find_region, replace_region, GraphRegionKind},
    unique_suffix,
    vault_lock::VaultProcessLock,
    write_text_atomically,
};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const OUTLINE_KIND: &str = "shard.map";
const FLOWCHART_KIND: &str = "shard.flow";
const SORT_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(Debug)]
pub enum GraphCommand {
    Read {
        fragment_id: String,
    },
    Outline {
        fragment_id: String,
    },
    Write {
        fragment_id: String,
        expect: String,
    },
    SetText {
        fragment_id: String,
        node_id: String,
        text: String,
        expect: String,
    },
    AddChild {
        fragment_id: String,
        parent_id: String,
        text: String,
        expect: String,
    },
    Remove {
        fragment_id: String,
        node_id: String,
        expect: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GraphKind {
    Outline,
    Flowchart,
}

impl GraphKind {
    fn from_tags(tags: &[String]) -> Result<Self, String> {
        match derive_type(tags) {
            Some("outline") => Ok(Self::Outline),
            Some("flowchart") => Ok(Self::Flowchart),
            _ => Err("目标不是大纲或流程图。".to_string()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Outline => "outline",
            Self::Flowchart => "flowchart",
        }
    }

    fn region_kind(self) -> GraphRegionKind {
        match self {
            Self::Outline => GraphRegionKind::Outline,
            Self::Flowchart => GraphRegionKind::Flowchart,
        }
    }
}

enum GraphFile {
    Outline(ShardMapFile),
    Flowchart(CanvasFile),
}

struct LoadedGraph {
    path: PathBuf,
    text: String,
    raw_frontmatter: String,
    frontmatter: shard_core::FragmentFrontmatter,
    body: String,
    kind: GraphKind,
    graph: GraphFile,
    current_revision: u64,
}

pub fn read_stdin_json() -> Result<Value, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("读取标准输入失败：{error}"))?;
    serde_json::from_str(&input).map_err(|error| format!("图 JSON 无法解析：{error}"))
}

pub fn run_read(vault: &Path, fragment_id: &str) -> Result<(), String> {
    let loaded = load_graph(vault, fragment_id, None)?;
    println!(
        "{}",
        json!({
            "id": fragment_id,
            "kind": loaded.kind.name(),
            "fileSha": content_sha256_hex(&loaded.text),
            "graph": graph_value(&loaded.graph)?,
        })
    );
    Ok(())
}

pub fn run_outline(vault: &Path, fragment_id: &str) -> Result<(), String> {
    let loaded = load_graph(vault, fragment_id, None)?;
    let GraphFile::Outline(file) = loaded.graph else {
        return Err("目标不是大纲。".to_string());
    };
    print!("{}", serialize_outline(&file));
    if !file.nodes.is_empty() {
        println!();
    }
    Ok(())
}

pub fn run_write(
    vault: &Path,
    fragment_id: &str,
    expected_sha: &str,
    graph: Value,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(timeout))?;
    let mut loaded = load_graph(vault, fragment_id, Some(expected_sha))?;
    loaded.graph = parse_submitted_graph(loaded.kind, fragment_id, graph)?;
    let file_sha = save_graph(vault, loaded)?;
    println!("{}", json!({ "fileSha": file_sha }));
    Ok(())
}

pub fn run_set_text(
    vault: &Path,
    fragment_id: &str,
    node_id: &str,
    text: String,
    expected_sha: &str,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(timeout))?;
    let mut loaded = load_graph(vault, fragment_id, Some(expected_sha))?;
    match &mut loaded.graph {
        GraphFile::Outline(file) => {
            let node = file
                .nodes
                .get_mut(node_id)
                .ok_or_else(|| format!("找不到节点 {node_id}。"))?;
            node.text = text;
        }
        GraphFile::Flowchart(file) => {
            let node = file
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .ok_or_else(|| format!("找不到节点 {node_id}。"))?;
            node.text = text;
        }
    }
    let file_sha = save_graph(vault, loaded)?;
    println!("{}", json!({ "fileSha": file_sha }));
    Ok(())
}

pub fn run_add_child(
    vault: &Path,
    fragment_id: &str,
    parent_id: &str,
    text: String,
    expected_sha: &str,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(timeout))?;
    let mut loaded = load_graph(vault, fragment_id, Some(expected_sha))?;
    let GraphFile::Outline(file) = &mut loaded.graph else {
        return Err("只有大纲支持添加子节点。".to_string());
    };
    if !file.nodes.contains_key(parent_id) {
        return Err(format!("找不到父节点 {parent_id}。"));
    }

    let previous = file
        .nodes
        .values()
        .filter(|node| node.parent_id.as_deref() == Some(parent_id))
        .max_by(|left, right| compare_nodes(left, right))
        .map(|node| node.sort_key.as_str());
    let sort_key = sort_key_between(previous, None);
    let node_id = next_node_id(file);
    let now = now_rfc3339();
    file.nodes.insert(
        node_id.clone(),
        ShardMapNode {
            id: node_id.clone(),
            parent_id: Some(parent_id.to_string()),
            sort_key,
            text,
            note: None,
            collapsed: false,
            width: None,
            created_at: now.clone(),
            updated_at: now,
            links: Vec::new(),
            style: None,
        },
    );
    let file_sha = save_graph(vault, loaded)?;
    println!("{}", json!({ "nodeId": node_id, "fileSha": file_sha }));
    Ok(())
}

pub fn run_remove(
    vault: &Path,
    fragment_id: &str,
    node_id: &str,
    expected_sha: &str,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let _lock = VaultProcessLock::acquire(lock_dir, vault, Some(timeout))?;
    let mut loaded = load_graph(vault, fragment_id, Some(expected_sha))?;
    let GraphFile::Outline(file) = &mut loaded.graph else {
        return Err("只有大纲支持删除节点。".to_string());
    };
    if node_id == file.root_id {
        return Err("不能删除大纲根节点。".to_string());
    }
    if !file.nodes.contains_key(node_id) {
        return Err(format!("找不到节点 {node_id}。"));
    }
    let mut removed = HashSet::from([node_id.to_string()]);
    loop {
        let children = file
            .nodes
            .values()
            .filter(|node| {
                node.parent_id
                    .as_ref()
                    .is_some_and(|parent| removed.contains(parent))
                    && !removed.contains(&node.id)
            })
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        if children.is_empty() {
            break;
        }
        removed.extend(children);
    }
    file.nodes.retain(|id, _| !removed.contains(id));
    let file_sha = save_graph(vault, loaded)?;
    println!("{}", json!({ "fileSha": file_sha }));
    Ok(())
}

fn load_graph(
    vault: &Path,
    fragment_id: &str,
    expected_sha: Option<&str>,
) -> Result<LoadedGraph, String> {
    let for_write = expected_sha.is_some();
    let path = find_fragment_path(vault, fragment_id)?
        .ok_or_else(|| format!("找不到公开片段 {fragment_id}"))?;
    if for_write && !is_live_public_fragment(vault, &path) {
        return Err(format!("找不到公开片段 {fragment_id}"));
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if let Some(expected_sha) = expected_sha {
        ensure_expected_sha(&text, expected_sha)?;
    }
    let parsed = parse_fragment(&text)?;
    let kind = GraphKind::from_tags(&parsed.frontmatter.tags)?;
    let region = find_region(&parsed.body, kind.region_kind())?;
    let graph = match kind {
        GraphKind::Outline => {
            let file = serde_json::from_str::<ShardMapFile>(&region.json_text)
                .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            validate_mind_map_file(vault, &file)?;
            GraphFile::Outline(file)
        }
        GraphKind::Flowchart => {
            let file = serde_json::from_str::<CanvasFile>(&region.json_text)
                .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
            if file.kind != FLOWCHART_KIND {
                return Err("流程图片段只能包含 shard.flow 数据。".to_string());
            }
            validate_canvas_file(vault, &file)?;
            GraphFile::Flowchart(file)
        }
    };
    let current_revision = match &graph {
        GraphFile::Outline(file) => {
            if for_write && (file.id != fragment_id || file.kind != OUTLINE_KIND) {
                return Err("大纲 graph 的 id 或类型与碎片不一致。".to_string());
            }
            file.revision
        }
        GraphFile::Flowchart(file) => {
            if for_write && (file.id != fragment_id || file.kind != FLOWCHART_KIND) {
                return Err("流程图 graph 的 id 或类型与碎片不一致。".to_string());
            }
            file.revision
        }
    };
    Ok(LoadedGraph {
        path,
        text,
        raw_frontmatter: parsed.raw,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        kind,
        graph,
        current_revision,
    })
}

fn is_live_public_fragment(vault: &Path, path: &Path) -> bool {
    path.strip_prefix(vault)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_some_and(|component| component.as_os_str() == "fragments")
}

fn parse_submitted_graph(
    kind: GraphKind,
    fragment_id: &str,
    value: Value,
) -> Result<GraphFile, String> {
    match kind {
        GraphKind::Outline => {
            let file = serde_json::from_value::<ShardMapFile>(value)
                .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            if file.id != fragment_id || file.kind != OUTLINE_KIND {
                return Err("大纲 graph 的 id 或类型与碎片不一致。".to_string());
            }
            Ok(GraphFile::Outline(file))
        }
        GraphKind::Flowchart => {
            let file = serde_json::from_value::<CanvasFile>(value)
                .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
            if file.id != fragment_id || file.kind != FLOWCHART_KIND {
                return Err("流程图 graph 的 id 或类型与碎片不一致。".to_string());
            }
            Ok(GraphFile::Flowchart(file))
        }
    }
}

fn save_graph(vault: &Path, mut loaded: LoadedGraph) -> Result<String, String> {
    let now = now_rfc3339();
    let json_text = match &mut loaded.graph {
        GraphFile::Outline(file) => {
            file.revision = loaded
                .current_revision
                .checked_add(1)
                .ok_or_else(|| "导图版本超过上限。".to_string())?;
            file.updated_at = now.clone();
            validate_mind_map_file(vault, file)?;
            canonical_mind_map_text(file)?
        }
        GraphFile::Flowchart(file) => {
            file.revision = loaded
                .current_revision
                .checked_add(1)
                .ok_or_else(|| "画布版本超过上限。".to_string())?;
            file.updated_at = now.clone();
            validate_canvas_file(vault, file)?;
            canonical_canvas_text(file)?
        }
    };
    let body = replace_region(&loaded.body, loaded.kind.region_kind(), &json_text)?;
    loaded.frontmatter.updated_at = now;
    let raw = apply_frontmatter(&loaded.raw_frontmatter, &loaded.frontmatter)?;
    let next_text = format!("---\n{raw}\n---{body}");
    write_text_atomically(&loaded.path, &next_text)?;
    Ok(content_sha256_hex(&next_text))
}

fn ensure_expected_sha(text: &str, expected_sha: &str) -> Result<(), String> {
    if content_sha256_hex(text) != expected_sha {
        return Err("文件已被修改，请重新读取".to_string());
    }
    Ok(())
}

fn graph_value(graph: &GraphFile) -> Result<Value, String> {
    match graph {
        GraphFile::Outline(file) => serde_json::to_value(file),
        GraphFile::Flowchart(file) => serde_json::to_value(file),
    }
    .map_err(|error| error.to_string())
}

fn serialize_outline(file: &ShardMapFile) -> String {
    let Some(root) = file.nodes.get(&file.root_id) else {
        return String::new();
    };
    let mut lines = Vec::new();
    append_outline_lines(file, root, 0, &mut lines);
    lines.join("\n")
}

fn append_outline_lines(
    file: &ShardMapFile,
    node: &ShardMapNode,
    depth: usize,
    lines: &mut Vec<String>,
) {
    lines.push(format!(
        "{}- {}",
        "  ".repeat(depth),
        flatten_outline_text(&node.text)
    ));
    let mut children = file
        .nodes
        .values()
        .filter(|child| child.parent_id.as_deref() == Some(node.id.as_str()))
        .collect::<Vec<_>>();
    children.sort_by(|left, right| compare_nodes(left, right));
    for child in children {
        append_outline_lines(file, child, depth + 1, lines);
    }
}

fn flatten_outline_text(text: &str) -> String {
    text.split(|character: char| character.is_whitespace() || character == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compare_nodes(left: &ShardMapNode, right: &ShardMapNode) -> std::cmp::Ordering {
    compare_sort_keys(&left.sort_key, &right.sort_key)
        .then_with(|| left.created_at.cmp(&right.created_at))
}

fn compare_sort_keys(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let length = left.len().max(right.len());
    for index in 0..length {
        let left_digit = left
            .get(index)
            .and_then(|byte| SORT_ALPHABET.iter().position(|candidate| candidate == byte))
            .map(|index| index as isize)
            .unwrap_or(-1);
        let right_digit = right
            .get(index)
            .and_then(|byte| SORT_ALPHABET.iter().position(|candidate| candidate == byte))
            .map(|index| index as isize)
            .unwrap_or(-1);
        match left_digit.cmp(&right_digit) {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

fn sort_key_between(previous: Option<&str>, next: Option<&str>) -> String {
    let previous = previous.unwrap_or_default().as_bytes();
    let next = next.unwrap_or_default().as_bytes();
    let mut prefix = String::new();
    let mut index = 0usize;
    loop {
        let previous_digit = previous
            .get(index)
            .and_then(|byte| SORT_ALPHABET.iter().position(|candidate| candidate == byte))
            .map(|digit| digit as isize)
            .unwrap_or(-1);
        let next_digit = if next.is_empty() {
            SORT_ALPHABET.len() as isize
        } else {
            next.get(index)
                .and_then(|byte| SORT_ALPHABET.iter().position(|candidate| candidate == byte))
                .map(|digit| digit as isize)
                .unwrap_or(SORT_ALPHABET.len() as isize)
        };
        if next_digit - previous_digit > 1 {
            let middle = ((previous_digit + next_digit) / 2) as usize;
            prefix.push(SORT_ALPHABET[middle] as char);
            return prefix;
        }
        prefix.push(previous.get(index).copied().unwrap_or(SORT_ALPHABET[0]) as char);
        index += 1;
    }
}

fn next_node_id(file: &ShardMapFile) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let base = format!("node-cli-{millis:x}-{}", unique_suffix());
    if !file.nodes.contains_key(&base) {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if !file.nodes.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn node(id: &str, parent_id: Option<&str>, sort_key: &str, text: &str) -> ShardMapNode {
        ShardMapNode {
            id: id.into(),
            parent_id: parent_id.map(str::to_string),
            sort_key: sort_key.into(),
            text: text.into(),
            note: None,
            collapsed: false,
            width: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            links: Vec::new(),
            style: None,
        }
    }

    #[test]
    fn outline_matches_frontend_order_indentation_and_whitespace_folding() {
        let mut nodes = BTreeMap::new();
        nodes.insert("root".into(), node("root", None, "U", " 根\n标题 "));
        nodes.insert("second".into(), node("second", Some("root"), "z", "乙"));
        nodes.insert("first".into(), node("first", Some("root"), "U", "第一\t行"));
        nodes.insert("child".into(), node("child", Some("first"), "U", "甲一"));
        let file = ShardMapFile {
            kind: OUTLINE_KIND.into(),
            schema_version: 1,
            id: "outline".into(),
            title: "根标题".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            saved_with_app_version: "test".into(),
            revision: 0,
            root_id: "root".into(),
            has_protected_links: false,
            nodes,
            viewport: None,
        };
        assert_eq!(
            serialize_outline(&file),
            "- 根 标题\n  - 第一 行\n    - 甲一\n  - 乙"
        );
    }

    #[test]
    fn appended_sort_key_follows_frontend_fractional_indexing() {
        assert_eq!(sort_key_between(None, None), "U");
        assert_eq!(sort_key_between(Some("U"), None), "k");
        assert_eq!(sort_key_between(Some("z"), None), "zU");
    }
}
