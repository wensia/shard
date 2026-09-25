//! Explicit, resumable copying of legacy mixed canvases. The source is never rewritten.
use super::*;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagramDocument {
    pub id: String,
    pub title: String,
    pub path: String,
    pub kind: String,
    pub node_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SplitResult {
    documents: Vec<DiagramDocument>,
    index_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputReceipt {
    /// Embedded canvas object ID; None denotes the non-map flow graph.
    source_node_id: Option<String>,
    id: String,
    path: String,
    hash: String,
    published: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SplitReceipt {
    source_id: String,
    source_path: String,
    source_hash: String,
    source_revision: u64,
    created_at: String,
    outputs: Vec<OutputReceipt>,
    index_id: String,
    index_path: String,
    index_hash: String,
    index_published: bool,
}

fn summary_at(vault: &Path, path: &Path) -> CanvasResult<DiagramDocument> {
    let relative = crate::relative_path(vault, path)?;
    if is_flow(path) {
        let read = read_file(vault, path)?;
        Ok(DiagramDocument {
            id: read.file.id,
            title: read.file.title,
            path: relative,
            kind: "flowchart".into(),
            node_count: read.file.nodes.len(),
        })
    } else if has_suffix(path, ".shardmap.json") {
        let file: ShardMapFile = serde_json::from_slice(&read_bytes(path)?).map_err(io)?;
        crate::validate_mind_map_file(vault, &file)?;
        Ok(DiagramDocument {
            id: file.id,
            title: file.title,
            path: relative,
            kind: "mindmap".into(),
            node_count: file.nodes.len(),
        })
    } else {
        Err("不是独立的思维导图或流程图。".into())
    }
}

pub(super) fn list_in_vault(vault: &Path) -> CanvasResult<Vec<DiagramDocument>> {
    let mut files = Vec::new();
    scan_files(&vault.join("notes"), ".json", &mut files, &mut 0)?;
    let mut summaries = Vec::new();
    let mut ids = HashSet::new();
    for path in files {
        if !is_flow(&path) && !has_suffix(&path, ".shardmap.json") {
            continue;
        }
        // Damaged files remain visible in the Library, but are not offered as link targets.
        if let Ok(summary) = summary_at(vault, &path) {
            if !ids.insert(summary.id.clone()) {
                return Err("发现重复的图形文档 ID，请先处理重复文件。".into());
            }
            summaries.push(summary);
        }
    }
    summaries.sort_by(|a, b| a.title.cmp(&b.title).then(a.path.cmp(&b.path)));
    Ok(summaries)
}

fn uuid() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn reserve_path(
    directory: &Path,
    title: &str,
    suffix: &str,
    reserved: &mut HashSet<PathBuf>,
) -> CanvasResult<PathBuf> {
    let stem = crate::sanitized_note_stem(title);
    for counter in 1..=100_000 {
        let tail = if counter == 1 {
            String::new()
        } else {
            format!("-{counter}")
        };
        let path = directory.join(crate::bounded_library_filename(&stem, &tail, suffix));
        if reserved.contains(&path) {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                reserved.insert(path.clone());
                return Ok(path);
            }
            Err(error) => return Err(io(error)),
            Ok(_) => (),
        }
    }
    Err("无法为拆分副本分配不冲突的名称。".into())
}

fn output_bytes(
    source: &CanvasFile,
    receipt: &SplitReceipt,
    output: &OutputReceipt,
) -> CanvasResult<Vec<u8>> {
    if let Some(node_id) = &output.source_node_id {
        let mut map = source
            .nodes
            .iter()
            .find(|node| &node.id == node_id)
            .and_then(|node| node.mind_map.clone())
            .ok_or("拆分记录与原画布中的导图不一致。")?;
        map.id = output.id.clone();
        map.revision = 1;
        map.updated_at = receipt.created_at.clone();
        // Preserve all internal node IDs, text, notes, styles, widths and links.
        canonical(&map)
    } else {
        let nodes: Vec<_> = source
            .nodes
            .iter()
            .filter(|node| node.kind != "mindmap")
            .cloned()
            .collect();
        let ids: HashSet<_> = nodes.iter().map(|node| node.id.as_str()).collect();
        let edges = source
            .edges
            .iter()
            .filter(|edge| ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str()))
            .cloned()
            .collect();
        canonical(&CanvasFile {
            kind: "shard.flow".into(),
            schema_version: 1,
            id: output.id.clone(),
            title: format!(
                "{} · 流程图",
                source.title.chars().take(490).collect::<String>()
            ),
            created_at: source.created_at.clone(),
            updated_at: receipt.created_at.clone(),
            revision: 1,
            nodes,
            edges,
        })
    }
}

fn markdown_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\n', " ")
        .replace('\r', " ")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn readable_text(value: &str) -> String {
    let mut text: String = value.chars().take(160).collect();
    if value.chars().count() > 160 {
        text.push('…');
    }
    markdown_label(&text)
        .replace('`', "\\`")
        .replace('*', "\\*")
        .replace('_', "\\_")
}

fn document_link(title: &str, id: &str, is_map: bool) -> String {
    format!(
        "[{}](shard://{}/{id})",
        markdown_label(title),
        if is_map { "map" } else { "flow" }
    )
}

fn object_record(node: &CanvasNode) -> serde_json::Value {
    serde_json::json!({
        "id":node.id,"kind":node.kind,"x":node.x,"y":node.y,"text":node.text,
        "width":node.width,"height":node.height,"link":node.link,
        "embeddedMapId":node.mind_map.as_ref().map(|map| &map.id)
    })
}

fn index_bytes(source: &CanvasFile, receipt: &SplitReceipt) -> CanvasResult<Vec<u8>> {
    let mut text = format!(
        "# {} · 关联说明\n\n原混合画布已保留。各思维导图和流程图独立保存，通过本文档关联。\n\n",
        markdown_label(&source.title)
    );
    text.push_str("## 文档\n\n");
    let mut links = HashMap::new();
    for output in &receipt.outputs {
        let (title, is_map) = if let Some(node_id) = &output.source_node_id {
            let map = source
                .nodes
                .iter()
                .find(|node| &node.id == node_id)
                .and_then(|node| node.mind_map.as_ref())
                .ok_or("找不到原导图。")?;
            (map.title.clone(), true)
        } else {
            (
                format!(
                    "{} · 流程图",
                    source.title.chars().take(490).collect::<String>()
                ),
                false,
            )
        };
        let link = document_link(&title, &output.id, is_map);
        text.push_str(&format!("- {link}\n"));
        if let Some(node_id) = &output.source_node_id {
            links.insert(node_id.clone(), link);
        } else {
            for node in source.nodes.iter().filter(|node| node.kind != "mindmap") {
                links.insert(node.id.clone(), link.clone());
            }
        }
    }
    text.push_str("\n## 跨文档关联\n\n");
    let nodes: HashMap<_, _> = source
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut count = 0;
    let mut edge_records = Vec::new();
    for edge in &source.edges {
        let from = nodes[edge.source.as_str()];
        let to = nodes[edge.target.as_str()];
        if from.kind != "mindmap" && to.kind != "mindmap" {
            continue;
        }
        count += 1;
        text.push_str(&format!(
            "{}. {} → {}\n\n",
            count, links[&from.id], links[&to.id]
        ));
        if !edge.label.is_empty() {
            text.push_str(&format!("   关系：{}\n\n", readable_text(&edge.label)));
        }
        text.push_str(&format!(
            "   节点：{} → {}\n\n",
            readable_text(&from.text),
            readable_text(&to.text)
        ));
        edge_records.push(edge);
    }
    if count == 0 {
        text.push_str("原画布没有跨文档连线。\n\n");
    }
    text.push_str("## 原始关联记录\n\n");
    if count > 0 {
        text.push_str("### 连线\n\n");
        // Raw metadata stays in an appendix; the document body describes user-facing relationships.
        for line in serde_json::to_string_pretty(&edge_records)
            .map_err(io)?
            .lines()
        {
            text.push_str("    ");
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\n### 对象\n\n");
        let linked: HashSet<_> = source
            .edges
            .iter()
            .filter(|edge| {
                nodes[edge.source.as_str()].kind == "mindmap"
                    || nodes[edge.target.as_str()].kind == "mindmap"
            })
            .flat_map(|edge| [&edge.source, &edge.target])
            .collect();
        // Record endpoint text and geometry once instead of repeating a large label
        // for every edge in a dense graph.
        for node in source.nodes.iter().filter(|node| linked.contains(&node.id)) {
            for line in serde_json::to_string_pretty(&object_record(node))
                .map_err(io)?
                .lines()
            {
                text.push_str("    ");
                text.push_str(line);
                text.push('\n');
            }
            text.push('\n');
        }
    }
    text.push_str("### 原件\n\n");
    let metadata = serde_json::json!({
        "path":receipt.source_path,"id":receipt.source_id,
        "revision":receipt.source_revision,"hash":receipt.source_hash
    });
    for line in serde_json::to_string_pretty(&metadata).map_err(io)?.lines() {
        text.push_str("    ");
        text.push_str(line);
        text.push('\n');
    }
    let frontmatter = crate::FragmentFrontmatter {
        id: receipt.index_id.clone(),
        created_at: receipt.created_at.clone(),
        updated_at: receipt.created_at.clone(),
        tags: vec!["note".into()],
        category: None,
        ai_status: Some("none".into()),
        pinned: false,
        source: "desktop".into(),
        conflict_of: None,
        related: Vec::new(),
    };
    let yaml = serde_yaml::to_string(&frontmatter).map_err(io)?;
    let document = format!(
        "---\n{}---\n\n{}\n",
        yaml.strip_prefix("---\n").unwrap_or(&yaml),
        text.trim_end()
    );
    if document.len() > MAX_BYTES {
        return Err("关联说明超过 8 MiB，请先减少画布中的跨文档连线。".into());
    }
    Ok(document.into_bytes())
}

fn plan_split(vault: &Path, source: &CanvasReadResult) -> CanvasResult<SplitReceipt> {
    let source_path = public_path(vault, &source.path, false)?;
    let directory = source_path.parent().ok_or("原画布目录无效。")?;
    let mut reserved = HashSet::new();
    let mut receipt = SplitReceipt {
        source_id: source.file.id.clone(),
        source_path: source.path.clone(),
        source_hash: source.last_saved_hash.clone(),
        source_revision: source.file.revision,
        created_at: now(),
        outputs: Vec::new(),
        index_id: format!("note-{}", uuid()),
        index_path: String::new(),
        index_hash: String::new(),
        index_published: false,
    };
    for node in &source.file.nodes {
        if let Some(map) = &node.mind_map {
            receipt.outputs.push(OutputReceipt {
                source_node_id: Some(node.id.clone()),
                id: format!("map-{}", uuid()),
                path: crate::relative_path(
                    vault,
                    &reserve_path(directory, &map.title, ".shardmap.json", &mut reserved)?,
                )?,
                hash: String::new(),
                published: false,
            });
        }
    }
    if source.file.nodes.iter().any(|node| node.kind != "mindmap") {
        receipt.outputs.push(OutputReceipt {
            source_node_id: None,
            id: format!("flow-{}", uuid()),
            path: crate::relative_path(
                vault,
                &reserve_path(
                    directory,
                    &format!("{} · 流程图", source.file.title),
                    FLOW_SUFFIX,
                    &mut reserved,
                )?,
            )?,
            hash: String::new(),
            published: false,
        });
    }
    receipt.index_path = crate::relative_path(
        vault,
        &reserve_path(
            directory,
            &format!("{} · 关联说明", source.file.title),
            ".md",
            &mut reserved,
        )?,
    )?;
    for index in 0..receipt.outputs.len() {
        receipt.outputs[index].hash = crate::hash_bytes(&output_bytes(
            &source.file,
            &receipt,
            &receipt.outputs[index],
        )?);
    }
    receipt.index_hash = crate::hash_bytes(&index_bytes(&source.file, &receipt)?);
    Ok(receipt)
}

fn unchanged_source(vault: &Path, path: &str, hash: &str) -> CanvasResult<()> {
    if crate::hash_bytes(&read_bytes(&public_path(vault, path, false)?)?) != hash {
        return Err("原画布已被外部修改，请重新打开后拆分；已生成的副本会保留。".into());
    }
    Ok(())
}

fn find_index_path(vault: &Path, id: &str, in_trash: bool) -> CanvasResult<Option<PathBuf>> {
    let mut files = Vec::new();
    if in_trash
        && fs::symlink_metadata(vault.join(".trash"))
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("拆分恢复不允许符号链接回收站。".into());
    }
    let root = vault.join(if in_trash { ".trash/notes" } else { "notes" });
    scan_files(&root, ".md", &mut files, &mut 0)?;
    let mut found = None;
    for path in files {
        let Ok(bytes) = read_bytes(&path) else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if crate::parse_fragment_text(text).is_ok_and(|(metadata, _)| metadata.id == id) {
            if found.is_some() {
                return Err("关联说明的文档 ID 重复，请先处理重复文件。".into());
            }
            found = Some(path);
        }
    }
    Ok(found)
}

pub(super) fn split_in_vault(
    vault: &Path,
    path: &str,
    expected_revision: u64,
    hash: &str,
) -> CanvasResult<SplitResult> {
    crate::ensure_no_unfinished_git_operation(vault)?;
    let source = read_in_vault(vault, path)?;
    if source.file.kind != "shard.canvas" {
        return Err("只有旧混合画布需要拆分。".into());
    }
    if source.file.revision != expected_revision || source.last_saved_hash != hash {
        return Err("原画布已被外部修改，请重新打开后拆分。".into());
    }
    let receipt_path = internal_path(
        vault,
        "split",
        &format!("{}.json", crate::hash_text(&source.file.id)),
    )?;
    let mut receipt: SplitReceipt = if receipt_path.exists() {
        let existing: SplitReceipt =
            serde_json::from_slice(&read_bytes(&receipt_path)?).map_err(io)?;
        if existing.source_id != source.file.id
            || existing.source_hash != hash
            || existing.source_revision != expected_revision
        {
            return Err(
                "此画布已有另一版本的拆分记录；已生成副本保留，请先处理原件的外部变更。".into(),
            );
        }
        existing
    } else {
        let receipt = plan_split(vault, &source)?;
        atomic_write(&receipt_path, &canonical(&receipt)?, false)?;
        receipt
    };
    let mut documents = Vec::new();
    let existing_documents = list_in_vault(vault)?;
    for index in 0..receipt.outputs.len() {
        unchanged_source(vault, path, hash)?;
        let output = &receipt.outputs[index];
        let target = safe_relative(vault, &output.path, &["notes"], true)?;
        // A retry may follow an intentional rename or move. Resolve by stable ID.
        let existing = existing_documents
            .iter()
            .find(|summary| summary.id == output.id);
        if let Some(summary) = existing {
            if !output.published
                && crate::hash_bytes(&read_bytes(&vault.join(&summary.path))?) != output.hash
            {
                return Err(format!("拆分目标已变化，禁止覆盖：{}", summary.path));
            }
            documents.push(summary_at(vault, &vault.join(&summary.path))?);
        } else if output.published {
            return Err(format!(
                "已生成的拆分文档已移除或损坏，不会重复创建：{}",
                output.path
            ));
        } else {
            // Never resurrect a trashed copy if publication succeeded before receipt flush.
            let mut trash_files = Vec::new();
            scan_files(
                &vault.join(".trash/notes"),
                ".json",
                &mut trash_files,
                &mut 0,
            )?;
            if trash_files
                .iter()
                .any(|path| summary_at(vault, path).is_ok_and(|summary| summary.id == output.id))
            {
                return Err("已生成的拆分文档位于回收站，不会重复创建。".into());
            }
            let bytes = output_bytes(&source.file, &receipt, output)?;
            if crate::hash_bytes(&bytes) != output.hash {
                return Err("拆分记录校验失败。".into());
            }
            atomic_write(&target, &bytes, false)?;
            documents.push(summary_at(vault, &target)?);
        }
        if !receipt.outputs[index].published {
            receipt.outputs[index].published = true;
            atomic_write(&receipt_path, &canonical(&receipt)?, true)?;
        }
    }
    unchanged_source(vault, path, hash)?;
    let planned_index_path = safe_relative(vault, &receipt.index_path, &["notes"], true)?;
    let existing_index_path = find_index_path(vault, &receipt.index_id, false)?;
    let index_path = existing_index_path.as_ref().unwrap_or(&planned_index_path);
    if existing_index_path.is_some() {
        let bytes = read_bytes(index_path)?;
        if !receipt.index_published && crate::hash_bytes(&bytes) != receipt.index_hash {
            return Err(format!(
                "关联说明的目标已被占用，禁止覆盖：{}",
                receipt.index_path
            ));
        }
    } else if receipt.index_published {
        return Err("已生成的关联说明已移除，不会重复创建。".into());
    } else {
        if find_index_path(vault, &receipt.index_id, true)?.is_some() {
            return Err("已生成的关联说明位于回收站，不会重复创建。".into());
        }
        let bytes = index_bytes(&source.file, &receipt)?;
        if crate::hash_bytes(&bytes) != receipt.index_hash {
            return Err("关联说明记录校验失败。".into());
        }
        atomic_write(index_path, &bytes, false)?;
    }
    if !receipt.index_published {
        receipt.index_published = true;
        atomic_write(&receipt_path, &canonical(&receipt)?, true)?;
    }
    Ok(SplitResult {
        documents,
        index_path: crate::relative_path(vault, index_path)?,
    })
}

#[tauri::command]
pub(crate) async fn list_diagram_documents(
    app: tauri::AppHandle,
) -> CanvasResult<Vec<DiagramDocument>> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = crate::configured_vault_path(&app)?;
        list_in_vault(&vault)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn split_canvas(
    app: tauri::AppHandle,
    path: String,
    expected_revision: u64,
    last_saved_hash: String,
) -> CanvasResult<SplitResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        split_in_vault(&vault, &path, expected_revision, &last_saved_hash)
    })
    .await
    .map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, vault};
    use super::*;

    fn mixed(vault: &Path) -> CanvasReadResult {
        let mut map = crate::create_mind_map_in_vault(vault, "项目导图".into(), None)
            .unwrap()
            .file;
        let root = map.nodes.get_mut(&map.root_id).unwrap();
        root.note = Some("保留完整备注\n第二行".into());
        root.width = Some(242.5);
        root.style = Some(crate::ShardMapNodeStyle {
            tone: Some("accent".into()),
        });
        root.links.push(ShardDocumentLink::MarkdownPath {
            id: "missing-note".into(),
            path: "notes/已移除.md".into(),
        });
        root.links.push(ShardDocumentLink::Map {
            id: "self-map".into(),
            target_id: map.id.clone(),
        });
        let mut source = fixture();
        source.kind = "shard.canvas".into();
        source.revision = 7;
        for index in 0..2 {
            source.nodes.push(CanvasNode {
                id: format!("embedded-{index}"),
                kind: "mindmap".into(),
                x: 40.5 + index as f64 * 400.0,
                y: 180.25,
                text: format!("导图对象 {index}"),
                width: Some(550.5),
                height: Some(400.0),
                link: None,
                mind_map: Some(map.clone()),
            });
        }
        source.edges.push(CanvasEdge {
            id: "map-flow-edge".into(),
            source: "embedded-0".into(),
            target: "first".into(),
            label: "需求 → 实施\n包含 [括号] 与 ```".into(),
            source_handle: Some("right".into()),
            target_handle: Some("top".into()),
        });
        source.edges.push(CanvasEdge {
            id: "map-map-edge".into(),
            source: "embedded-0".into(),
            target: "embedded-1".into(),
            label: "两个导图关联".into(),
            source_handle: None,
            target_handle: None,
        });
        let path = "notes/旧混合画布.shardcanvas.json";
        fs::write(vault.join(path), canonical(&source).unwrap()).unwrap();
        read_in_vault(vault, path).unwrap()
    }

    fn receipt_path(vault: &Path, source: &CanvasReadResult) -> PathBuf {
        internal_path(
            vault,
            "split",
            &format!("{}.json", crate::hash_text(&source.file.id)),
        )
        .unwrap()
    }

    #[test]
    fn library_filename_split_reservations_fit_unicode_and_collision_limits() {
        let temp = tempfile::tempdir().unwrap();
        let mut reserved = HashSet::new();
        for title in ["字".repeat(80), "😀".repeat(80)] {
            for suffix in [".md", ".shardmap.json", ".shardflow.json"] {
                for index in 1..=11 {
                    let path = reserve_path(temp.path(), &title, suffix, &mut reserved).unwrap();
                    let name = path.file_name().unwrap().to_str().unwrap();
                    let stem = name.strip_suffix(suffix).unwrap();
                    assert!(name.len() <= 255, "{name}");
                    assert!(stem.chars().count() <= 64, "{name}");
                    if index > 1 {
                        assert!(stem.ends_with(&format!("-{index}")), "{name}");
                    }
                    atomic_write(&path, b"fixture", false).unwrap();
                }
            }
        }
    }

    #[test]
    fn split_mixed_preserves_source_nodes_links_and_cross_document_edges() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let original = read_bytes(&vault.join(&source.path)).unwrap();
        let result = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        assert_eq!(result.documents.len(), 3);
        assert_eq!(read_bytes(&vault.join(&source.path)).unwrap(), original);
        assert_eq!(
            crate::run_git(vault, &["rev-list", "--all", "--count"])
                .unwrap()
                .trim(),
            "0"
        );
        let old_map = source.file.nodes[2].mind_map.as_ref().unwrap();
        let maps: Vec<_> = result
            .documents
            .iter()
            .filter(|summary| summary.kind == "mindmap")
            .collect();
        assert_eq!(maps.len(), 2);
        assert_ne!(maps[0].id, maps[1].id);
        for summary in &maps {
            assert_ne!(
                summary.id, old_map.id,
                "an imported copy must get its own document identity"
            );
            let read = crate::read_mind_map_in_vault(vault, &summary.id).unwrap();
            assert_eq!(
                serde_json::to_value(&read.file.nodes).unwrap(),
                serde_json::to_value(&old_map.nodes).unwrap()
            );
            assert_eq!(read.file.root_id, old_map.root_id);
            assert_eq!(read.file.revision, 1);
            assert!(
                summary.path.starts_with("notes/项目导图-"),
                "existing original document is not overwritten"
            );
        }
        let flow = result
            .documents
            .iter()
            .find(|summary| summary.kind == "flowchart")
            .unwrap();
        let read = read_in_vault(vault, &flow.path).unwrap();
        assert_eq!(read.file.kind, "shard.flow");
        assert_eq!(read.file.nodes.len(), 2);
        assert_eq!(read.file.edges.len(), 2);
        assert_eq!(
            serde_json::to_value(&read.file.edges).unwrap(),
            serde_json::to_value(&source.file.edges[..2]).unwrap()
        );
        let index = fs::read_to_string(vault.join(&result.index_path)).unwrap();
        let (metadata, body) = crate::parse_fragment_text(&index).unwrap();
        assert_eq!(metadata.tags, vec!["note"]);
        assert!(body.trim_start().starts_with("# 中文画布 · 关联说明"));
        let runtime = crate::LockboxRuntime::default();
        let state = crate::list_fragments_in_vault(vault, &runtime).unwrap();
        let note = state
            .fragments
            .iter()
            .find(|fragment| fragment.path == result.index_path)
            .expect("关联说明必须由实际 list_fragments 扫描，并可按 path 打开");
        assert_eq!(note.id, metadata.id);
        assert!(note.content.contains("shard://map/"));
        assert!(note.tags.iter().any(|tag| tag == "note"));
        let read = crate::read_fragment(
            &vault.join(&result.index_path),
            vault,
            &crate::dirty_paths(vault),
            None,
        )
        .unwrap();
        assert_eq!(read.id, note.id);
        assert!(crate::collect_library_entries(vault, &vault.join("notes"))
            .unwrap()
            .iter()
            .any(|entry| entry.path == result.index_path && entry.kind == "markdown"));
        for summary in &result.documents {
            assert!(index.contains(&format!(
                "shard://{}/{}",
                if summary.kind == "mindmap" {
                    "map"
                } else {
                    "flow"
                },
                summary.id
            )));
        }
        for expected in [
            "map-flow-edge",
            "map-map-edge",
            "embedded-0",
            "embedded-1",
            "导图对象 0",
            "准备",
            "需求 → 实施",
            "两个导图关联",
            "sourceHandle",
            "right",
        ] {
            assert!(
                index.contains(expected),
                "lost association data: {expected}"
            );
        }
        let retry = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        assert_eq!(
            serde_json::to_value(&retry).unwrap(),
            serde_json::to_value(&result).unwrap()
        );
        crate::rename_library_entry_in_vault(vault, &result.index_path, "项目关联文档").unwrap();
        let moved = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        assert_eq!(moved.index_path, "notes/项目关联文档.md");
        assert!(
            !vault.join(&result.index_path).exists(),
            "rename-aware retries must not duplicate the index note"
        );
        let unrelated =
            crate::create_library_note_in_vault(vault, "中文画布 · 关联说明", Some("notes"))
                .unwrap();
        assert_eq!(unrelated.path, result.index_path);
        assert_ne!(unrelated.id, metadata.id);
        let retry = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        assert_eq!(
            retry.index_path, moved.index_path,
            "an unrelated note reusing the old path must not be opened as the index"
        );
        crate::move_to_trash_in_vault(vault, &moved.index_path).unwrap();
        assert!(
            split_in_vault(vault, &source.path, 7, &source.last_saved_hash)
                .unwrap_err()
                .contains("关联说明已移除")
        );
        assert!(!vault.join(&moved.index_path).exists());
        let retained = crate::read_fragment(
            &vault.join(&unrelated.path),
            vault,
            &crate::dirty_paths(vault),
            None,
        )
        .unwrap();
        assert_eq!(
            retained.id, unrelated.id,
            "retry must leave the unrelated note untouched"
        );
        assert_eq!(
            list_in_vault(vault).unwrap().len(),
            4,
            "retry did not duplicate the three outputs"
        );
    }

    #[test]
    fn split_retry_resumes_partial_publication_and_preserves_edited_or_moved_outputs() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let receipt = plan_split(vault, &source).unwrap();
        let receipt_path = receipt_path(vault, &source);
        atomic_write(&receipt_path, &canonical(&receipt).unwrap(), false).unwrap();
        // Simulate success of the first atomic publication followed by a lost receipt update.
        let first = &receipt.outputs[0];
        atomic_write(
            &vault.join(&first.path),
            &output_bytes(&source.file, &receipt, first).unwrap(),
            false,
        )
        .unwrap();
        // The second target is independently occupied after planning: never overwrite it.
        let obstruction = &receipt.outputs[1].path;
        fs::write(vault.join(obstruction), b"do not overwrite this file").unwrap();
        assert!(split_in_vault(vault, &source.path, 7, &source.last_saved_hash).is_err());
        assert_eq!(
            fs::read(vault.join(obstruction)).unwrap(),
            b"do not overwrite this file"
        );
        // A real edit to the already published document survives the retry.
        let read = crate::read_mind_map_in_vault(vault, &first.id).unwrap();
        let mut edited = read.file;
        edited.nodes.get_mut(&edited.root_id).unwrap().text = "拆分后人工编辑".into();
        crate::write_mind_map_in_vault(vault, &first.id, edited, 1, &read.last_saved_hash).unwrap();
        fs::create_dir(vault.join("notes/移动后")).unwrap();
        fs::rename(
            vault.join(&first.path),
            vault.join("notes/移动后/已改名.shardmap.json"),
        )
        .unwrap();
        fs::remove_file(vault.join(obstruction)).unwrap();
        let result = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        assert_eq!(result.documents.len(), 3);
        assert_eq!(
            result.documents[0].path,
            "notes/移动后/已改名.shardmap.json"
        );
        assert!(!vault.join(&first.path).exists());
        assert_eq!(
            crate::read_mind_map_in_vault(vault, &first.id)
                .unwrap()
                .file
                .nodes[&source.file.nodes[2].mind_map.as_ref().unwrap().root_id]
                .text,
            "拆分后人工编辑"
        );
        assert_eq!(list_in_vault(vault).unwrap().len(), 4);
        assert_eq!(
            read_in_vault(vault, &source.path).unwrap().last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn split_rejects_stale_source_and_never_resurrects_removed_outputs() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        assert!(split_in_vault(vault, &source.path, 6, &source.last_saved_hash).is_err());
        assert!(split_in_vault(vault, &source.path, 7, "stale").is_err());
        assert!(!receipt_path(vault, &source).exists());
        let result = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        let first = vault.join(&result.documents[0].path);
        fs::remove_file(&first).unwrap();
        assert!(
            split_in_vault(vault, &source.path, 7, &source.last_saved_hash)
                .unwrap_err()
                .contains("不会重复创建")
        );
        assert!(!first.exists());
        let mut changed = source.file.clone();
        changed.title = "外部新版本".into();
        fs::write(vault.join(&source.path), canonical(&changed).unwrap()).unwrap();
        let current = read_in_vault(vault, &source.path).unwrap();
        assert!(
            split_in_vault(vault, &source.path, 7, &current.last_saved_hash)
                .unwrap_err()
                .contains("另一版本")
        );
    }

    #[test]
    fn split_lost_index_receipt_does_not_resurrect_a_trashed_note() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let result = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
        let path = receipt_path(vault, &source);
        let mut receipt: SplitReceipt =
            serde_json::from_slice(&read_bytes(&path).unwrap()).unwrap();
        // Simulate index publication reaching disk but its receipt update being lost.
        receipt.index_published = false;
        atomic_write(&path, &canonical(&receipt).unwrap(), true).unwrap();
        let trashed = crate::move_to_trash_in_vault(vault, &result.index_path).unwrap();
        let before = fs::read(&trashed).unwrap();
        assert!(
            split_in_vault(vault, &source.path, 7, &source.last_saved_hash)
                .unwrap_err()
                .contains("关联说明位于回收站")
        );
        assert!(!vault.join(&result.index_path).exists());
        assert_eq!(fs::read(trashed).unwrap(), before);
        assert_eq!(list_in_vault(vault).unwrap().len(), 4);
        assert_eq!(
            read_in_vault(vault, &source.path).unwrap().last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn flow_documents_reject_embedded_maps_and_legacy_files_are_read_only() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        assert!(write_in_vault(
            vault,
            &source.path,
            source.file.clone(),
            7,
            &source.last_saved_hash
        )
        .unwrap_err()
        .contains("只读"));
        let mut mixed_flow = source.file.clone();
        mixed_flow.kind = "shard.flow".into();
        assert!(validate_file(vault, &mixed_flow)
            .unwrap_err()
            .contains("不能包含思维导图"));
        assert!(create_in_vault(vault, "notes", &source.file.title, source.file.clone()).is_err());
        let mut standalone_flow = fixture();
        standalone_flow.id = "standalone-flow".into();
        let flow = create_in_vault(vault, "notes", "中文画布", standalone_flow).unwrap();
        assert!(split_in_vault(vault, &flow.path, 1, &flow.last_saved_hash).is_err());
        let mut legacy = flow.file.clone();
        legacy.kind = "shard.canvas".into();
        assert!(write_in_vault(vault, &flow.path, legacy, 1, &flow.last_saved_hash).is_err());
        fs::copy(
            vault.join(&flow.path),
            vault.join("notes/伪装.shardcanvas.json"),
        )
        .unwrap();
        assert!(read_in_vault(vault, "notes/伪装.shardcanvas.json")
            .unwrap_err()
            .contains("扩展名"));
    }

    #[test]
    fn flow_links_resolve_after_rename_move_and_reject_unsafe_identifiers() {
        let temp = vault();
        let vault = temp.path();
        let flow = create_in_vault(vault, "notes", "中文画布", fixture()).unwrap();
        let mut map = crate::create_mind_map_in_vault(vault, "引用流程".into(), None)
            .unwrap()
            .file;
        map.nodes
            .get_mut(&map.root_id)
            .unwrap()
            .links
            .push(ShardDocumentLink::Flow {
                id: "flow-link".into(),
                target_id: flow.file.id.clone(),
            });
        crate::validate_mind_map_file(vault, &map).unwrap();
        crate::rename_library_entry_in_vault(vault, &flow.path, "新名称").unwrap();
        fs::create_dir(vault.join("notes/子目录")).unwrap();
        crate::move_library_entry_in_vault(
            vault,
            "notes/新名称.shardflow.json",
            Some("notes/子目录"),
        )
        .unwrap();
        let summary = list_in_vault(vault)
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == flow.file.id)
            .unwrap();
        assert_eq!(summary.path, "notes/子目录/新名称.shardflow.json");
        assert_eq!(summary.kind, "flowchart");
        crate::validate_mind_map_file(vault, &map).unwrap();
        for target_id in ["", "../secret", "notes/private", "notes\\private"] {
            let link = ShardDocumentLink::Flow {
                id: "safe".into(),
                target_id: target_id.into(),
            };
            assert!(validate_public_link(vault, &link).is_err());
        }
        crate::move_to_trash_in_vault(vault, &summary.path).unwrap();
        assert!(!list_in_vault(vault)
            .unwrap()
            .iter()
            .any(|entry| entry.id == flow.file.id));
        crate::validate_mind_map_file(vault, &map).unwrap(); // A broken public link remains editable.
    }

    #[test]
    #[cfg(unix)]
    fn split_and_document_listing_never_follow_symlinks_or_escape_public_notes() {
        let temp = vault();
        let vault = temp.path();
        let source = mixed(vault);
        let outside = tempfile::tempdir().unwrap();
        let mut flow = fixture();
        flow.id = "outside-flow".into();
        fs::write(
            outside.path().join("outside.shardflow.json"),
            canonical(&flow).unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.join("notes/外部目录")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.shardflow.json"),
            vault.join("notes/别名.shardflow.json"),
        )
        .unwrap();
        assert!(!list_in_vault(vault)
            .unwrap()
            .iter()
            .any(|entry| entry.id == "outside-flow"));
        for path in [
            "notes/../notes/旧混合画布.shardcanvas.json",
            "lockbox/旧混合画布.shardcanvas.json",
            "notes/外部目录/旧混合画布.shardcanvas.json",
        ] {
            assert!(split_in_vault(vault, path, 7, &source.last_saved_hash).is_err());
        }
        let receipt = plan_split(vault, &source).unwrap();
        atomic_write(
            &receipt_path(vault, &source),
            &canonical(&receipt).unwrap(),
            false,
        )
        .unwrap();
        let output = &receipt.outputs[0];
        std::os::unix::fs::symlink(outside.path().join("untouched"), vault.join(&output.path))
            .unwrap();
        assert!(
            split_in_vault(vault, &source.path, 7, &source.last_saved_hash)
                .unwrap_err()
                .contains("符号链接")
        );
        assert!(!outside.path().join("untouched").exists());
        assert_eq!(
            read_in_vault(vault, &source.path).unwrap().last_saved_hash,
            source.last_saved_hash
        );
    }

    #[test]
    fn split_map_only_flow_only_and_empty_legacy_files_have_exact_output_types() {
        for kind in ["mindmap", "flow", "empty"] {
            let temp = vault();
            let vault = temp.path();
            let source = mixed(vault);
            let mut file = source.file;
            file.nodes.retain(|node| match kind {
                "mindmap" => node.kind == "mindmap",
                "flow" => node.kind != "mindmap",
                _ => false,
            });
            let ids: HashSet<_> = file.nodes.iter().map(|node| node.id.as_str()).collect();
            file.edges.retain(|edge| {
                ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str())
            });
            fs::write(vault.join(&source.path), canonical(&file).unwrap()).unwrap();
            let source = read_in_vault(vault, &source.path).unwrap();
            let result = split_in_vault(vault, &source.path, 7, &source.last_saved_hash).unwrap();
            assert_eq!(
                result.documents.len(),
                match kind {
                    "mindmap" => 2,
                    "flow" => 1,
                    _ => 0,
                }
            );
            assert!(result.documents.iter().all(|document| document.kind
                == if kind == "mindmap" {
                    "mindmap"
                } else {
                    "flowchart"
                }));
            assert!(vault.join(result.index_path).is_file());
        }
    }

    #[test]
    fn mind_map_creation_accepts_a_safe_library_parent_directly() {
        let temp = vault();
        let vault = temp.path();
        fs::create_dir(vault.join("notes/项目")).unwrap();
        let map =
            crate::create_mind_map_at_in_vault(vault, "当前目录".into(), None, Some("notes/项目"))
                .unwrap();
        assert_eq!(map.path, "notes/项目/当前目录.shardmap.json");
        assert!(!vault.join("notes/当前目录.shardmap.json").exists());
        for parent in ["notes/../notes", "lockbox", "notes/不存在"] {
            assert!(
                crate::create_mind_map_at_in_vault(vault, "拒绝".into(), None, Some(parent))
                    .is_err()
            );
        }
        assert_eq!(
            crate::run_git(vault, &["rev-list", "--all", "--count"])
                .unwrap()
                .trim(),
            "0"
        );
    }
}
