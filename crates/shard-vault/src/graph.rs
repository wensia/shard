//! 碎片里的大纲 / 流程图受管区域：新建（按 operation_id 幂等）、读写、从图文件导入时间线。

use crate::prelude::*;

static GRAPH_CREATE_RECEIPTS: OnceLock<Mutex<GraphCreateReceiptCache>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphFragmentKind {
    Outline,
    Flowchart,
}

impl GraphFragmentKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "outline" => Ok(Self::Outline),
            "flowchart" => Ok(Self::Flowchart),
            _ => Err("图形内容类型只能是 outline 或 flowchart。".to_string()),
        }
    }

    fn type_tag(self) -> &'static str {
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

#[derive(Clone, Debug)]
pub struct GraphCreateReceipt {
    pub kind: GraphFragmentKind,
    pub fragment_id: String,
}

#[derive(Default)]
pub struct GraphCreateReceiptCache {
    pub entries: HashMap<String, GraphCreateReceipt>,
    pub order: VecDeque<String>,
}

pub fn graph_create_receipt_key(vault: &Path, operation_id: &str) -> String {
    format!("{}\0{operation_id}", vault.display())
}

pub fn graph_create_receipt(
    vault: &Path,
    operation_id: &str,
) -> Option<GraphCreateReceipt> {
    let key = graph_create_receipt_key(vault, operation_id);
    let cache = GRAPH_CREATE_RECEIPTS.get_or_init(|| Mutex::new(GraphCreateReceiptCache::default()));
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entries
        .get(&key)
        .cloned()
}

pub fn remember_graph_create(
    vault: &Path,
    operation_id: &str,
    receipt: GraphCreateReceipt,
) {
    const MAX_RECEIPTS: usize = 256;

    let key = graph_create_receipt_key(vault, operation_id);
    let cache = GRAPH_CREATE_RECEIPTS.get_or_init(|| Mutex::new(GraphCreateReceiptCache::default()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.entries.contains_key(&key) {
        return;
    }
    while cache.order.len() >= MAX_RECEIPTS {
        if let Some(expired) = cache.order.pop_front() {
            cache.entries.remove(&expired);
        }
    }
    cache.order.push_back(key.clone());
    cache.entries.insert(key, receipt);
}

pub fn graph_kind_from_frontmatter(
    frontmatter: &FragmentFrontmatter,
) -> Result<GraphFragmentKind, String> {
    match derive_type(&frontmatter.tags) {
        Some("outline") => Ok(GraphFragmentKind::Outline),
        Some("flowchart") => Ok(GraphFragmentKind::Flowchart),
        _ => Err("目标不是大纲或流程图。".to_string()),
    }
}

pub fn canonical_flow_text(file: &canvas::CanvasFile) -> Result<String, String> {
    let bytes = canvas::canonical(file)?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

pub fn validate_graph_value(
    vfs: &dyn Vfs,
    kind: GraphFragmentKind,
    graph: serde_json::Value,
) -> Result<(serde_json::Value, String), String> {
    match kind {
        GraphFragmentKind::Outline => {
            let file = serde_json::from_value::<ShardMapFile>(graph)
                .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            validate_mind_map_file(vfs, &file)?;
            let text = canonical_mind_map_text(&file)?;
            let value = serde_json::to_value(file).map_err(|error| error.to_string())?;
            Ok((value, text))
        }
        GraphFragmentKind::Flowchart => {
            let file = serde_json::from_value::<canvas::CanvasFile>(graph)
                .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
            if file.kind != "shard.flow" {
                return Err("流程图片段只能包含 shard.flow 数据。".to_string());
            }
            canvas::validate_file(vfs, &file)?;
            let text = canonical_flow_text(&file)?;
            let value = serde_json::to_value(file).map_err(|error| error.to_string())?;
            Ok((value, text))
        }
    }
}

pub fn graph_value_for_create(
    vfs: &dyn Vfs,
    kind: GraphFragmentKind,
    id: &str,
    graph: Option<serde_json::Value>,
    timestamp: &str,
) -> Result<(serde_json::Value, String), String> {
    match kind {
        GraphFragmentKind::Outline => {
            let mut file = serde_json::from_value::<ShardMapFile>(
                graph.ok_or_else(|| "创建大纲时必须提供 graph。".to_string())?,
            )
            .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            file.kind = SHARD_MAP_KIND.to_string();
            file.schema_version = SHARD_MAP_SCHEMA_VERSION;
            file.id = id.to_string();
            file.created_at = timestamp.to_string();
            file.updated_at = timestamp.to_string();
            file.saved_with_app_version = env!("CARGO_PKG_VERSION").to_string();
            file.revision = 1;
            validate_mind_map_file(vfs, &file)?;
            let text = canonical_mind_map_text(&file)?;
            let value = serde_json::to_value(file).map_err(|error| error.to_string())?;
            Ok((value, text))
        }
        GraphFragmentKind::Flowchart => {
            let mut file = match graph {
                Some(graph) => serde_json::from_value::<canvas::CanvasFile>(graph)
                    .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?,
                None => canvas::CanvasFile {
                    kind: "shard.flow".to_string(),
                    schema_version: 1,
                    id: id.to_string(),
                    title: "未命名流程图".to_string(),
                    created_at: timestamp.to_string(),
                    updated_at: timestamp.to_string(),
                    revision: 0,
                    nodes: Vec::new(),
                    edges: Vec::new(),
                },
            };
            file.id = id.to_string();
            if file.kind != "shard.flow" {
                return Err("流程图片段只能包含 shard.flow 数据。".to_string());
            }
            canvas::validate_file(vfs, &file)?;
            let text = canonical_flow_text(&file)?;
            let value = serde_json::to_value(file).map_err(|error| error.to_string())?;
            Ok((value, text))
        }
    }
}

pub fn create_graph_fragment_in_vault(
    cx: &VaultCtx<'_>,
    kind: &str,
    operation_id: &str,
    graph: Option<serde_json::Value>,
    tags: Vec<String>,
) -> Result<GraphFragmentResult, String> {
    let kind = GraphFragmentKind::parse(kind)?;
    let operation_id = operation_id.trim();
    if operation_id.is_empty() {
        return Err("operation_id 不能为空。".to_string());
    }
    if let Some(receipt) = graph_create_receipt(cx.root(), operation_id) {
        if receipt.kind != kind {
            return Err("同一 operation_id 不能用于不同的图形内容类型。".to_string());
        }
        return read_graph_fragment_in_vault(cx, &receipt.fragment_id);
    }

    let mut tags = normalize_tags(tags, true);
    if contains_lockbox_tag(&tags) {
        return Err(LOCKBOX_TYPE_ERROR.to_string());
    }
    tags.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
    tags.push(kind.type_tag().to_string());
    tags.sort();
    tags.dedup();

    let now = cx.now();
    let id = new_fragment_id(&now);
    let timestamp = now.to_rfc3339();
    let (graph, json_text) = graph_value_for_create(cx.vfs, kind, &id, graph, &timestamp)?;
    let body = render_region(kind.region_kind(), &json_text);
    let path = create_public_fragment_with_id_in_vault(
        cx.vfs, &body, tags, cx.source, &now, &id,
    )?;
    remember_graph_create(
        cx.root(),
        operation_id,
        GraphCreateReceipt {
            kind,
            fragment_id: id,
        },
    );
    Ok(GraphFragmentResult {
        fragment: read_fragment(cx, &path, &cx.hooks.dirty_paths(), None)?,
        graph,
    })
}

pub fn read_graph_fragment_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
) -> Result<GraphFragmentResult, String> {
    let path = find_fragment_path(cx.vfs, id)?
        .ok_or_else(|| format!("找不到公开片段 {id}"))?;
    let text = cx.vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = parse_fragment(&text)?;
    let kind = graph_kind_from_frontmatter(&parsed.frontmatter)?;
    let region = find_region(&parsed.body, kind.region_kind())?;
    let (graph, _) = validate_graph_value(
        cx.vfs,
        kind,
        serde_json::from_str(&region.json_text)
            .map_err(|error| format!("受管区域 JSON 无法解析：{error}"))?,
    )?;
    Ok(GraphFragmentResult {
        fragment: read_fragment(cx, &path, &cx.hooks.dirty_paths(), None)?,
        graph,
    })
}

pub fn import_graph_file_to_timeline_in_vault(
    cx: &VaultCtx<'_>,
    rel_path: &str,
) -> Result<Fragment, String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    let source = existing_library_path(vfs, rel_path)?;
    if !vfs.is_file(&source) {
        return Err("只能导入资料库中的图文件。".to_string());
    }

    let raw_json = vfs.read_to_string(&source).map_err(|error| error.to_string())?;
    let (kind, id, created_at) = if is_mind_map_file(&source) {
        let file = serde_json::from_str::<ShardMapFile>(&raw_json)
            .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
        validate_mind_map_file(vfs, &file)?;
        (GraphFragmentKind::Outline, file.id, file.created_at)
    } else if canvas::is_flow(&source) {
        let file = serde_json::from_str::<canvas::CanvasFile>(&raw_json)
            .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
        if file.kind != "shard.flow" {
            return Err("只能把 shard.flow 流程图加入时间线。".to_string());
        }
        canvas::validate_file(vfs, &file)?;
        (GraphFragmentKind::Flowchart, file.id, file.created_at)
    } else {
        return Err("只能导入 .shardmap.json 或 .shardflow.json 图文件。".to_string());
    };

    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("图文件 id 只能包含字母、数字、点、下划线和连字符。".to_string());
    }
    if is_lockbox_fragment_id(vfs, &id)? {
        return Err(format!("片段 id {id} 已存在。"));
    }

    let existing = find_fragment_path(vfs, &id)?;
    if let Some(existing_path) = existing.as_ref() {
        let existing_rel = relative_path(vault, existing_path)?;
        let text = vfs.read_to_string(existing_path).map_err(|error| error.to_string())?;
        let parsed = parse_fragment(&text)?;
        let existing_kind = graph_kind_from_frontmatter(&parsed.frontmatter)?;
        let region = find_region(&parsed.body, kind.region_kind())?;
        let graph_id = serde_json::from_str::<serde_json::Value>(&region.json_text)
            .map_err(|error| format!("受管区域 JSON 无法解析：{error}"))?
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        if existing_kind != kind || graph_id != id || !existing_rel.starts_with("fragments/") {
            return Err(format!("片段 id {id} 已存在。"));
        }
        validate_graph_value(
            vfs,
            kind,
            serde_json::from_str(&region.json_text)
                .map_err(|error| format!("受管区域 JSON 无法解析：{error}"))?,
        )?;

        cx.hooks.checkpoint_before_structural();
        let trashed = move_to_trash_without_commit_in_vault(cx, rel_path)?;
        cx.hooks.commit_paths_best_effort(
            &[rel_path.to_string(), relative_path(vault, &trashed)?],
            "import graph file to timeline",
        );
        return read_fragment(cx, existing_path, &cx.hooks.dirty_paths(), None);
    }

    let (fragment_created_at, year, month) = match DateTime::parse_from_rfc3339(&created_at) {
        Ok(timestamp) => (
            created_at,
            timestamp.format("%Y").to_string(),
            timestamp.format("%m").to_string(),
        ),
        Err(_) => {
            let now = cx.now();
            (
                now.to_rfc3339(),
                now.format("%Y").to_string(),
                now.format("%m").to_string(),
            )
        }
    };
    let directory = vault.join("fragments").join(year).join(month);
    vfs.create_dir_all(&directory).map_err(|error| error.to_string())?;
    let fragment_path = directory.join(format!("{id}.md"));
    if vfs.exists(&fragment_path) {
        return Err(format!("片段 {id} 已存在。"));
    }
    let frontmatter = FragmentFrontmatter {
        id: id.clone(),
        created_at: fragment_created_at.clone(),
        updated_at: fragment_created_at,
        tags: vec!["inbox".to_string(), kind.type_tag().to_string()],
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: cx.source.to_string(),
        conflict_of: None,
        related: Vec::new(),
    };
    let body = render_region(kind.region_kind(), &raw_json);

    cx.hooks.checkpoint_before_structural();
    write_fragment_file(vfs, &fragment_path, &frontmatter, &body)?;
    let trashed = match move_to_trash_without_commit_in_vault(cx, rel_path) {
        Ok(path) => path,
        Err(error) => {
            if let Err(rollback_error) = vfs.remove_file(&fragment_path) {
                return Err(format!("{error}；回滚新碎片失败：{rollback_error}"));
            }
            return Err(error);
        }
    };
    cx.hooks.commit_paths_best_effort(
        &[
            relative_path(vault, &fragment_path)?,
            rel_path.to_string(),
            relative_path(vault, &trashed)?,
        ],
        "import graph file to timeline",
    );
    read_fragment(cx, &fragment_path, &cx.hooks.dirty_paths(), None)
}

pub fn write_graph_fragment_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    graph: serde_json::Value,
    expected_file_sha: Option<&str>,
) -> Result<GraphFragmentResult, String> {
    let vfs = cx.vfs;
    let path = find_fragment_path(vfs, id)?
        .ok_or_else(|| format!("找不到公开片段 {id}"))?;
    let current_text = vfs.read_to_string(&path).map_err(|error| error.to_string())?;
    ensure_expected_file_sha(&current_text, expected_file_sha)?;
    let parsed = parse_fragment(&current_text)?;
    let kind = graph_kind_from_frontmatter(&parsed.frontmatter)?;
    let current_region = find_region(&parsed.body, kind.region_kind())?;
    let current_graph = serde_json::from_str::<serde_json::Value>(&current_region.json_text)
        .map_err(|error| format!("受管区域 JSON 无法解析：{error}"))?;

    let (graph, json_text) = match kind {
        GraphFragmentKind::Outline => {
            let current = serde_json::from_value::<ShardMapFile>(current_graph)
                .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            validate_mind_map_file(vfs, &current)?;
            let mut next = serde_json::from_value::<ShardMapFile>(graph)
                .map_err(|error| format!("大纲 JSON 无法解析：{error}"))?;
            if next.id != id || next.kind != SHARD_MAP_KIND {
                return Err("大纲 graph 的 id 或类型与碎片不一致。".to_string());
            }
            next.revision = current
                .revision
                .checked_add(1)
                .ok_or_else(|| "导图版本超过上限。".to_string())?;
            next.updated_at = cx.now().to_rfc3339();
            next.saved_with_app_version = env!("CARGO_PKG_VERSION").to_string();
            validate_mind_map_file(vfs, &next)?;
            let text = canonical_mind_map_text(&next)?;
            let value = serde_json::to_value(next).map_err(|error| error.to_string())?;
            (value, text)
        }
        GraphFragmentKind::Flowchart => {
            let current = serde_json::from_value::<canvas::CanvasFile>(current_graph)
                .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
            if current.kind != "shard.flow" {
                return Err("流程图片段只能包含 shard.flow 数据。".to_string());
            }
            canvas::validate_file(vfs, &current)?;
            let mut next = serde_json::from_value::<canvas::CanvasFile>(graph)
                .map_err(|error| format!("流程图 JSON 无法解析：{error}"))?;
            if next.id != id || next.kind != "shard.flow" {
                return Err("流程图 graph 的 id 或类型与碎片不一致。".to_string());
            }
            next.revision = current
                .revision
                .checked_add(1)
                .ok_or_else(|| "画布版本超过上限。".to_string())?;
            next.updated_at = cx.now().to_rfc3339();
            canvas::validate_file(vfs, &next)?;
            let text = canonical_flow_text(&next)?;
            let value = serde_json::to_value(next).map_err(|error| error.to_string())?;
            (value, text)
        }
    };

    let next_body = replace_region(&parsed.body, kind.region_kind(), &json_text)?;
    let mut frontmatter = parsed.frontmatter;
    frontmatter.updated_at = cx.now().to_rfc3339();
    let raw = apply_frontmatter(&parsed.raw, &frontmatter)?;
    let next_text = format!("---\n{raw}\n---{next_body}");
    vfs.write_atomic(&path, next_text.as_bytes())
        .map_err(|error| error.to_string())?;

    Ok(GraphFragmentResult {
        fragment: read_fragment(cx, &path, &cx.hooks.dirty_paths(), None)?,
        graph,
    })
}
