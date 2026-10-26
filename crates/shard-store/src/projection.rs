//! 派生投影：从一个文件的原文算出 `doc_index` / `doc_tags` / `doc_links` 的行。
//!
//! 投影永远可以从 `nodes` 的原文整表重建，所以这里宁可宽松：解析失败只是少几行投影，
//! 绝不让写入失败。

use serde_json::Value;
use shard_core::{derive_type, frontmatter::parse_fragment, image_refs};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DocProjection {
    /// fragment | map | flow | canvas | dataset | legacy
    pub ns: &'static str,
    pub doc_id: String,
    /// 是否落在现有「按 id 查找」的扫描范围内（见 [`in_lookup_scope`]）。
    pub lookup_scope: bool,
    pub type_tag: Option<String>,
    pub title: Option<String>,
    pub pinned: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub conflict_of: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Projection {
    pub doc: Option<DocProjection>,
    pub tags: Vec<String>,
    /// (link_kind, target)；link_kind ∈ wikilink | image | csv | related | map_fragment | map_path | map_map | map_flow
    pub links: Vec<(&'static str, String)>,
}

fn lower(path: &str) -> String {
    path.to_lowercase()
}

fn has_hidden_component(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with('.'))
}

/// 与现有按 id 查找的扫描范围一致：
/// - 碎片 / 笔记（`find_fragment_path`）：`fragments/`、`.trash/fragments/`、`notes/` 下的 `.md`；
/// - 导图（`read_mind_map` 的查找）：`notes/`、`maps/` 下、路径里没有隐藏目录的 `.shardmap.json`；
/// - 流程图、画布、数据集：`notes/` 或 `datasets/` 下、不在回收站与隐藏目录里。
pub fn in_lookup_scope(ns: &str, path: &str) -> bool {
    let key = lower(path);
    match ns {
        "fragment" => {
            key.starts_with("fragments/") || key.starts_with(".trash/fragments/") || key.starts_with("notes/")
        }
        "map" => (key.starts_with("notes/") || key.starts_with("maps/")) && !has_hidden_component(&key),
        "flow" | "canvas" | "dataset" => {
            (key.starts_with("notes/") || key.starts_with("datasets/")) && !has_hidden_component(&key)
        }
        _ => false,
    }
}

pub fn project(path: &str, bytes: &[u8]) -> Projection {
    let key = lower(path);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Projection::default();
    };
    if key.ends_with(".md") {
        project_markdown(path, text)
    } else if key.ends_with(".shardmap.json") {
        project_graph(path, text, "map")
    } else if key.ends_with(".shardflow.json") {
        project_graph(path, text, "flow")
    } else if key.ends_with(".shardcanvas.json") {
        project_graph(path, text, "canvas")
    } else if key.ends_with(".csv.schema.json") {
        project_dataset_schema(path, text)
    } else if key.ends_with(".csv") {
        let mut projection = Projection::default();
        for image in image_refs::csv_image_references(text) {
            push_link(&mut projection.links, "image", image);
        }
        projection
    } else {
        Projection::default()
    }
}

fn push_link(links: &mut Vec<(&'static str, String)>, kind: &'static str, target: String) {
    let target = target.trim().to_string();
    if !target.is_empty() && !links.iter().any(|(k, t)| *k == kind && *t == target) {
        links.push((kind, target));
    }
}

fn first_heading(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            return None;
        }
        let rest = trimmed.strip_prefix("# ")?;
        let title = rest.trim().trim_end_matches('#').trim();
        (!title.is_empty()).then(|| title.to_string())
    })
}

/// ```datatable 围栏里 `"src": "datasets/x.csv"` 的引用。
fn datatable_sources(body: &str) -> Vec<String> {
    let mut sources = Vec::new();
    let mut in_fence = false;
    let mut fence = String::new();
    for line in body.lines() {
        let trimmed = line.trim_start().trim_start_matches('>').trim_start();
        if !in_fence {
            if trimmed.starts_with("```datatable") {
                in_fence = true;
                fence.clear();
            }
        } else if trimmed.starts_with("```") {
            in_fence = false;
            if let Ok(value) = serde_json::from_str::<Value>(&fence) {
                if let Some(src) = value.get("src").and_then(Value::as_str) {
                    sources.push(src.to_string());
                }
            }
        } else {
            fence.push_str(line);
            fence.push('\n');
        }
    }
    sources
}

fn project_markdown(path: &str, text: &str) -> Projection {
    let mut projection = Projection::default();
    let body = match parse_fragment(text) {
        Ok(parsed) => {
            let frontmatter = parsed.frontmatter;
            projection.doc = Some(DocProjection {
                ns: "fragment",
                doc_id: frontmatter.id.clone(),
                lookup_scope: in_lookup_scope("fragment", path),
                type_tag: derive_type(&frontmatter.tags).map(str::to_string),
                title: first_heading(&parsed.body),
                pinned: frontmatter.pinned,
                created_at: Some(frontmatter.created_at.clone()),
                updated_at: Some(frontmatter.updated_at.clone()),
                conflict_of: frontmatter.conflict_of.clone(),
            });
            projection.tags = frontmatter.tags.clone();
            for relation in &frontmatter.related {
                push_link(&mut projection.links, "related", relation.target_id.clone());
            }
            parsed.body
        }
        Err(_) => text.to_string(),
    };
    for image in image_refs::markdown_image_references(&body) {
        push_link(&mut projection.links, "image", image);
    }
    for source in datatable_sources(&body) {
        push_link(&mut projection.links, "csv", source);
    }
    projection
}

fn graph_link(links: &mut Vec<(&'static str, String)>, link: &Value) {
    let target_type = link.get("targetType").and_then(Value::as_str).unwrap_or_default();
    let target_id = link
        .get("targetId")
        .or_else(|| link.get("target_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    match (target_type, target_id) {
        ("fragment", Some(id)) => push_link(links, "map_fragment", id),
        ("map", Some(id)) => push_link(links, "map_map", id),
        ("flow", Some(id)) => push_link(links, "map_flow", id),
        ("markdownPath", _) => {
            if let Some(path) = link.get("path").and_then(Value::as_str) {
                push_link(links, "map_path", path.to_string());
            }
        }
        _ => {}
    }
}

fn collect_map_links(file: &Value, links: &mut Vec<(&'static str, String)>) {
    if let Some(nodes) = file.get("nodes") {
        let nodes: Vec<&Value> = match nodes {
            Value::Object(map) => map.values().collect(),
            Value::Array(items) => items.iter().collect(),
            _ => Vec::new(),
        };
        for node in nodes {
            if let Some(items) = node.get("links").and_then(Value::as_array) {
                for link in items {
                    graph_link(links, link);
                }
            }
            if let Some(link) = node.get("link") {
                graph_link(links, link);
            }
            if let Some(embedded) = node.get("mindMap") {
                collect_map_links(embedded, links);
            }
        }
    }
}

fn project_graph(path: &str, text: &str, ns: &'static str) -> Projection {
    let mut projection = Projection::default();
    let Ok(file) = serde_json::from_str::<Value>(text) else {
        return projection;
    };
    if let Some(id) = file.get("id").and_then(Value::as_str) {
        projection.doc = Some(DocProjection {
            ns,
            doc_id: id.to_string(),
            lookup_scope: in_lookup_scope(ns, path),
            title: file.get("title").and_then(Value::as_str).map(str::to_string),
            created_at: file.get("createdAt").and_then(Value::as_str).map(str::to_string),
            updated_at: file.get("updatedAt").and_then(Value::as_str).map(str::to_string),
            ..DocProjection::default()
        });
    }
    collect_map_links(&file, &mut projection.links);
    projection
}

fn project_dataset_schema(path: &str, text: &str) -> Projection {
    let mut projection = Projection::default();
    let Ok(schema) = serde_json::from_str::<Value>(text) else {
        return projection;
    };
    if let Some(id) = schema.get("datasetId").and_then(Value::as_str) {
        projection.doc = Some(DocProjection {
            ns: "dataset",
            doc_id: id.to_string(),
            lookup_scope: in_lookup_scope("dataset", path),
            title: schema.get("title").and_then(Value::as_str).map(str::to_string),
            ..DocProjection::default()
        });
    }
    projection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_projection_reads_frontmatter_and_links() {
        let text = "---\nid: 20261026-1-a\ncreated_at: 2026-10-26T10:00:00+08:00\nupdated_at: 2026-10-26T10:00:00+08:00\ntags:\n- inbox\n- note\n- 读书\ncategory: null\nai_status: none\npinned: true\nsource: desktop\nrelated:\n- targetId: x1\n  origin: manual\n  createdAt: 2026-10-26T10:00:00+08:00\n---\n\n# 标题\n\n![图](assets/ab/abc.png)\n\n```datatable\n{\"title\":\"t\",\"src\":\"datasets/书.csv\"}\n```\n";
        let projection = project("notes/读书/标题.md", text.as_bytes());
        let doc = projection.doc.expect("有 frontmatter 就有 doc");
        assert_eq!(doc.ns, "fragment");
        assert_eq!(doc.doc_id, "20261026-1-a");
        assert!(doc.lookup_scope);
        assert_eq!(doc.type_tag.as_deref(), Some("note"));
        assert_eq!(doc.title.as_deref(), Some("标题"));
        assert!(doc.pinned);
        assert_eq!(projection.tags, vec!["inbox", "note", "读书"]);
        assert!(projection.links.contains(&("related", "x1".to_string())));
        assert!(projection.links.contains(&("image", "assets/ab/abc.png".to_string())));
        assert!(projection.links.contains(&("csv", "datasets/书.csv".to_string())));
    }

    #[test]
    fn map_scope_excludes_trash_and_hidden_backups() {
        assert!(in_lookup_scope("map", "notes/a.shardmap.json"));
        assert!(in_lookup_scope("map", "maps/a.shardmap.json"));
        assert!(!in_lookup_scope("map", "maps/.last-good/a.shardmap.json"));
        assert!(!in_lookup_scope("map", ".trash/notes/a.shardmap.json"));
        assert!(in_lookup_scope("fragment", ".trash/fragments/2026/10/a.md"));
        assert!(!in_lookup_scope("fragment", ".trash/notes/a.md"));
    }

    #[test]
    fn broken_input_projects_nothing_instead_of_failing() {
        assert_eq!(project("notes/x.shardmap.json", b"{not json"), Projection::default());
        assert_eq!(project("notes/x.md", &[0xff, 0xfe]), Projection::default());
    }
}
