//! Explicit, resumable copying of legacy mixed canvases. The source is never rewritten.
use super::*;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramDocument {
    pub id: String,
    pub title: String,
    pub path: String,
    pub kind: String,
    pub node_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub documents: Vec<DiagramDocument>,
    pub index_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputReceipt {
    /// Embedded canvas object ID; None denotes the non-map flow graph.
    pub source_node_id: Option<String>,
    pub id: String,
    pub path: String,
    pub hash: String,
    pub published: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitReceipt {
    pub source_id: String,
    pub source_path: String,
    pub source_hash: String,
    pub source_revision: u64,
    pub created_at: String,
    pub outputs: Vec<OutputReceipt>,
    pub index_id: String,
    pub index_path: String,
    pub index_hash: String,
    pub index_published: bool,
}

pub fn summary_at(vfs: &dyn Vfs, path: &Path) -> CanvasResult<DiagramDocument> {
    let relative = crate::relative_path(vfs.root(), path)?;
    if is_flow(path) {
        let read = read_file(vfs, path)?;
        Ok(DiagramDocument {
            id: read.file.id,
            title: read.file.title,
            path: relative,
            kind: "flowchart".into(),
            node_count: read.file.nodes.len(),
        })
    } else if has_suffix(path, ".shardmap.json") {
        let file: ShardMapFile = serde_json::from_slice(&read_bytes(vfs, path)?).map_err(io)?;
        crate::validate_mind_map_file(vfs, &file)?;
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

pub fn list_in_vault(cx: &VaultCtx<'_>) -> CanvasResult<Vec<DiagramDocument>> {
    let vfs = cx.vfs;
    let mut files = Vec::new();
    scan_files(vfs, &cx.root().join("notes"), ".json", &mut files, &mut 0)?;
    let mut summaries = Vec::new();
    let mut ids = HashSet::new();
    for path in files {
        if !is_flow(&path) && !has_suffix(&path, ".shardmap.json") {
            continue;
        }
        // Damaged files remain visible in the Library, but are not offered as link targets.
        if let Ok(summary) = summary_at(vfs, &path) {
            if !ids.insert(summary.id.clone()) {
                return Err("发现重复的图形文档 ID，请先处理重复文件。".into());
            }
            summaries.push(summary);
        }
    }
    summaries.sort_by(|a, b| a.title.cmp(&b.title).then(a.path.cmp(&b.path)));
    Ok(summaries)
}

pub fn uuid() -> String {
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

pub fn reserve_path(
    vfs: &dyn Vfs,
    directory: &Path,
    title: &str,
    suffix: &str,
    reserved: &mut HashSet<PathBuf>,
) -> CanvasResult<PathBuf> {
    let stem = shard_core::library::sanitized_note_stem(title);
    for counter in 1..=100_000 {
        let tail = if counter == 1 {
            String::new()
        } else {
            format!("-{counter}")
        };
        let path = directory.join(shard_core::library::bounded_library_filename(&stem, &tail, suffix));
        if reserved.contains(&path) {
            continue;
        }
        match vfs.symlink_metadata(&path) {
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

pub fn output_bytes(
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

pub fn markdown_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\n', " ")
        .replace('\r', " ")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn readable_text(value: &str) -> String {
    let mut text: String = value.chars().take(160).collect();
    if value.chars().count() > 160 {
        text.push('…');
    }
    markdown_label(&text)
        .replace('`', "\\`")
        .replace('*', "\\*")
        .replace('_', "\\_")
}

pub fn document_link(title: &str, id: &str, is_map: bool) -> String {
    format!(
        "[{}](shard://{}/{id})",
        markdown_label(title),
        if is_map { "map" } else { "flow" }
    )
}

pub fn object_record(node: &CanvasNode) -> serde_json::Value {
    serde_json::json!({
        "id":node.id,"kind":node.kind,"x":node.x,"y":node.y,"text":node.text,
        "width":node.width,"height":node.height,"link":node.link,
        "embeddedMapId":node.mind_map.as_ref().map(|map| &map.id)
    })
}

pub fn index_bytes(source: &CanvasFile, receipt: &SplitReceipt) -> CanvasResult<Vec<u8>> {
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
    let frontmatter = shard_core::FragmentFrontmatter {
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

pub fn plan_split(vfs: &dyn Vfs, source: &CanvasReadResult) -> CanvasResult<SplitReceipt> {
    let vault = vfs.root();
    let source_path = public_path(vfs, &source.path, false)?;
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
                    &reserve_path(vfs, directory, &map.title, ".shardmap.json", &mut reserved)?,
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
                    vfs,
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
            vfs,
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

pub fn unchanged_source(vfs: &dyn Vfs, path: &str, hash: &str) -> CanvasResult<()> {
    if crate::hash_bytes(&read_bytes(vfs, &public_path(vfs, path, false)?)?) != hash {
        return Err("原画布已被外部修改，请重新打开后拆分；已生成的副本会保留。".into());
    }
    Ok(())
}

pub fn find_index_path(vfs: &dyn Vfs, id: &str, in_trash: bool) -> CanvasResult<Option<PathBuf>> {
    let vault = vfs.root();
    let mut files = Vec::new();
    if in_trash
        && vfs
            .symlink_metadata(&vault.join(".trash"))
            .is_ok_and(|metadata| metadata.is_symlink())
    {
        return Err("拆分恢复不允许符号链接回收站。".into());
    }
    let root = vault.join(if in_trash { ".trash/notes" } else { "notes" });
    scan_files(vfs, &root, ".md", &mut files, &mut 0)?;
    let mut found = None;
    for path in files {
        let Ok(bytes) = read_bytes(vfs, &path) else {
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

pub fn split_in_vault(
    cx: &VaultCtx<'_>,
    path: &str,
    expected_revision: u64,
    hash: &str,
) -> CanvasResult<SplitResult> {
    let vfs = cx.vfs;
    let vault = cx.root();
    cx.hooks.ensure_no_unfinished_operation()?;
    let source = read_in_vault(cx, path)?;
    if source.file.kind != "shard.canvas" {
        return Err("只有旧混合画布需要拆分。".into());
    }
    if source.file.revision != expected_revision || source.last_saved_hash != hash {
        return Err("原画布已被外部修改，请重新打开后拆分。".into());
    }
    let receipt_path = internal_path(
        vfs,
        "split",
        &format!("{}.json", crate::hash_text(&source.file.id)),
    )?;
    let mut receipt: SplitReceipt = if vfs.exists(&receipt_path) {
        let existing: SplitReceipt =
            serde_json::from_slice(&read_bytes(vfs, &receipt_path)?).map_err(io)?;
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
        let receipt = plan_split(vfs, &source)?;
        atomic_write(vfs, &receipt_path, &canonical(&receipt)?, false)?;
        receipt
    };
    let mut documents = Vec::new();
    let existing_documents = list_in_vault(cx)?;
    for index in 0..receipt.outputs.len() {
        unchanged_source(vfs, path, hash)?;
        let output = &receipt.outputs[index];
        let target = safe_relative(vfs, &output.path, &["notes"], true)?;
        // A retry may follow an intentional rename or move. Resolve by stable ID.
        let existing = existing_documents
            .iter()
            .find(|summary| summary.id == output.id);
        if let Some(summary) = existing {
            if !output.published
                && crate::hash_bytes(&read_bytes(vfs, &vault.join(&summary.path))?) != output.hash
            {
                return Err(format!("拆分目标已变化，禁止覆盖：{}", summary.path));
            }
            documents.push(summary_at(vfs, &vault.join(&summary.path))?);
        } else if output.published {
            return Err(format!(
                "已生成的拆分文档已移除或损坏，不会重复创建：{}",
                output.path
            ));
        } else {
            // Never resurrect a trashed copy if publication succeeded before receipt flush.
            let mut trash_files = Vec::new();
            scan_files(
                vfs,
                &vault.join(".trash/notes"),
                ".json",
                &mut trash_files,
                &mut 0,
            )?;
            if trash_files
                .iter()
                .any(|path| summary_at(vfs, path).is_ok_and(|summary| summary.id == output.id))
            {
                return Err("已生成的拆分文档位于回收站，不会重复创建。".into());
            }
            let bytes = output_bytes(&source.file, &receipt, output)?;
            if crate::hash_bytes(&bytes) != output.hash {
                return Err("拆分记录校验失败。".into());
            }
            atomic_write(vfs, &target, &bytes, false)?;
            documents.push(summary_at(vfs, &target)?);
        }
        if !receipt.outputs[index].published {
            receipt.outputs[index].published = true;
            atomic_write(vfs, &receipt_path, &canonical(&receipt)?, true)?;
        }
    }
    unchanged_source(vfs, path, hash)?;
    let planned_index_path = safe_relative(vfs, &receipt.index_path, &["notes"], true)?;
    let existing_index_path = find_index_path(vfs, &receipt.index_id, false)?;
    let index_path = existing_index_path.as_ref().unwrap_or(&planned_index_path);
    if existing_index_path.is_some() {
        let bytes = read_bytes(vfs, index_path)?;
        if !receipt.index_published && crate::hash_bytes(&bytes) != receipt.index_hash {
            return Err(format!(
                "关联说明的目标已被占用，禁止覆盖：{}",
                receipt.index_path
            ));
        }
    } else if receipt.index_published {
        return Err("已生成的关联说明已移除，不会重复创建。".into());
    } else {
        if find_index_path(vfs, &receipt.index_id, true)?.is_some() {
            return Err("已生成的关联说明位于回收站，不会重复创建。".into());
        }
        let bytes = index_bytes(&source.file, &receipt)?;
        if crate::hash_bytes(&bytes) != receipt.index_hash {
            return Err("关联说明记录校验失败。".into());
        }
        atomic_write(vfs, index_path, &bytes, false)?;
    }
    if !receipt.index_published {
        receipt.index_published = true;
        atomic_write(vfs, &receipt_path, &canonical(&receipt)?, true)?;
    }
    Ok(SplitResult {
        documents,
        index_path: crate::relative_path(vault, index_path)?,
    })
}
