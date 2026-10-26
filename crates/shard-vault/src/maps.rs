//! 思维导图：列表、新建、读写（含 last-good 与冲突副本）、删除。

use crate::prelude::*;

pub fn list_mind_maps_in_vault(cx: &VaultCtx<'_>) -> Result<Vec<MindMapSummary>, String> {
    let mut files = Vec::new();
    collect_mind_map_files(cx.vfs, &cx.root().join("notes"), &mut files)?;

    let mut summaries = files
        .iter()
        .filter_map(|path| read_mind_map_summary(cx.vfs, path).ok())
        .collect::<Vec<_>>();

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// 在 `notes/` 根下新建导图（[`create_mind_map_at_in_vault`] 的缺省位置）。
pub fn create_mind_map_in_vault(
    cx: &VaultCtx<'_>,
    title: String,
    source_fragment_id: Option<String>,
) -> Result<MindMapReadResult, String> {
    create_mind_map_at_in_vault(cx, title, source_fragment_id, None)
}

pub fn create_mind_map_at_in_vault(
    cx: &VaultCtx<'_>,
    title: String,
    source_fragment_id: Option<String>,
    parent_path: Option<&str>,
) -> Result<MindMapReadResult, String> {
    let dir = canvas::public_directory(cx.vfs, parent_path.unwrap_or("notes"))?;
    let title = title.trim();
    if title.is_empty() {
        return Err("思维导图标题不能为空。".to_string());
    }
    validate_library_name_length(title, ".shardmap.json")?;

    let now = cx.now();
    let suffix = unique_suffix();
    let id = format!("map-{}-{}", now.format("%Y%m%d-%H%M%S"), suffix);
    let root_id = format!("node-{}-root", suffix);
    let first_branch_id = format!("node-{}-branch", suffix);
    let created_at = now.to_rfc3339();
    let mut links = Vec::new();

    if let Some(fragment_id) = source_fragment_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        ensure_public_fragment_id(cx.vfs, fragment_id)?;
        links.push(ShardDocumentLink::Fragment {
            id: format!("link-{}", unique_suffix()),
            target_id: fragment_id.to_string(),
        });
    }

    let root_node = ShardMapNode {
        id: root_id.clone(),
        parent_id: None,
        sort_key: "m".to_string(),
        text: title.to_string(),
        note: None,
        collapsed: false,
        width: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
        links,
        style: None,
    };
    let first_branch = ShardMapNode {
        id: first_branch_id.clone(),
        parent_id: Some(root_id.clone()),
        sort_key: "m".to_string(),
        text: String::new(),
        note: None,
        collapsed: false,
        width: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
        links: Vec::new(),
        style: None,
    };
    let mut nodes = BTreeMap::new();
    nodes.insert(root_id.clone(), root_node);
    nodes.insert(first_branch_id, first_branch);

    let file = ShardMapFile {
        kind: SHARD_MAP_KIND.to_string(),
        schema_version: SHARD_MAP_SCHEMA_VERSION,
        id,
        title: title.to_string(),
        created_at: created_at.clone(),
        updated_at: created_at,
        saved_with_app_version: env!("CARGO_PKG_VERSION").to_string(),
        revision: 1,
        root_id,
        has_protected_links: false,
        nodes,
        viewport: None,
    };

    let path = unique_mind_map_path(cx.vfs, &dir, title);

    validate_mind_map_file(cx.vfs, &file)?;
    let text = canonical_mind_map_text(&file)?;
    cx.vfs
        .write_atomic(&path, text.as_bytes())
        .map_err(|error| error.to_string())?;
    write_mind_map_last_good(cx.vfs, &file)?;
    mind_map_read_result(cx.root(), &path, file, text)
}

pub fn read_mind_map_in_vault(cx: &VaultCtx<'_>, id: &str) -> Result<MindMapReadResult, String> {
    let path = find_mind_map_path(cx.vfs, id)?.ok_or_else(|| format!("找不到思维导图 {id}"))?;
    let (file, text) = read_mind_map_file(cx.vfs, &path)?;
    validate_mind_map_file(cx.vfs, &file)?;
    mind_map_read_result(cx.root(), &path, file, text)
}

pub fn write_mind_map_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    mut file: ShardMapFile,
    expected_revision: u64,
    last_saved_hash: &str,
) -> Result<MindMapReadResult, String> {
    if file.id != id {
        return Err("导图 id 与写入目标不一致。".to_string());
    }

    let path = find_mind_map_path(cx.vfs, id)?.ok_or_else(|| format!("找不到思维导图 {id}"))?;
    let (current_file, current_text) = read_mind_map_file(cx.vfs, &path)?;
    let current_hash = hash_text(&current_text);

    if current_file.revision != expected_revision || current_hash != last_saved_hash {
        let conflict_path = write_mind_map_conflict(cx.vfs, &file)?;
        return Err(format!(
            "导图已被外部修改，已另存冲突副本：{}",
            relative_path(cx.root(), &conflict_path)?
        ));
    }

    file.kind = SHARD_MAP_KIND.to_string();
    file.schema_version = SHARD_MAP_SCHEMA_VERSION;
    file.saved_with_app_version = env!("CARGO_PKG_VERSION").to_string();
    file.revision = expected_revision + 1;
    file.updated_at = cx.now().to_rfc3339();
    validate_mind_map_file(cx.vfs, &file)?;

    let text = canonical_mind_map_text(&file)?;
    cx.vfs
        .write_atomic(&path, text.as_bytes())
        .map_err(|error| error.to_string())?;
    write_mind_map_last_good(cx.vfs, &file)?;
    mind_map_read_result(cx.root(), &path, file, text)
}

pub fn delete_mind_map_in_vault(
    cx: &VaultCtx<'_>,
    id: &str,
    expected_revision: u64,
) -> Result<(), String> {
    let path = find_mind_map_path(cx.vfs, id)?.ok_or_else(|| format!("找不到思维导图 {id}"))?;
    let (file, _) = read_mind_map_file(cx.vfs, &path)?;
    if file.revision != expected_revision {
        return Err("导图已被外部修改，请重新打开后再删除。".to_string());
    }
    cx.vfs.remove_file(&path).map_err(|error| error.to_string())?;
    let last_good = cx.root().join(mind_map_last_good_rel_path(&file));
    if cx.vfs.exists(&last_good) {
        cx.vfs.remove_file(&last_good).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn collect_mind_map_files(
    vfs: &dyn Vfs,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    canvas::scan_files(vfs, dir, ".shardmap.json", files, &mut 0)
}

pub fn is_mind_map_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.ends_with(".shardmap.json"))
        .unwrap_or(false)
}

pub fn read_mind_map_summary(vfs: &dyn Vfs, path: &Path) -> Result<MindMapSummary, String> {
    let (file, _) = read_mind_map_file(vfs, path)?;
    validate_mind_map_file(vfs, &file)?;
    Ok(MindMapSummary {
        id: file.id,
        title: file.title,
        created_at: file.created_at,
        updated_at: file.updated_at,
        node_count: file.nodes.len(),
        path: relative_path(vfs.root(), path)?,
    })
}

pub fn read_mind_map_file(vfs: &dyn Vfs, path: &Path) -> Result<(ShardMapFile, String), String> {
    let text = vfs.read_to_string(path).map_err(|error| error.to_string())?;
    let file = serde_json::from_str::<ShardMapFile>(&text).map_err(|error| error.to_string())?;
    Ok((file, text))
}

pub fn mind_map_read_result(
    vault: &Path,
    path: &Path,
    file: ShardMapFile,
    text: String,
) -> Result<MindMapReadResult, String> {
    Ok(MindMapReadResult {
        file,
        path: relative_path(vault, path)?,
        last_saved_hash: hash_text(&text),
    })
}

pub fn validate_mind_map_file(vfs: &dyn Vfs, file: &ShardMapFile) -> Result<(), String> {
    shard_core::graph_model::validate_mind_map_file(vfs, file)
}

pub fn find_mind_map_path(vfs: &dyn Vfs, id: &str) -> Result<Option<PathBuf>, String> {
    let vault = vfs.root();
    let mut files = Vec::new();
    collect_mind_map_files(vfs, &vault.join("notes"), &mut files)?;
    // 迁移期间兼容仍位于 maps/ 的旧文件；新建与正常枚举只走 notes/。
    collect_mind_map_files(vfs, &vault.join("maps"), &mut files)?;

    for path in files {
        if let Ok((file, _)) = read_mind_map_file(vfs, &path) {
            if file.id == id {
                return Ok(Some(path));
            }
        }
    }

    Ok(None)
}

pub fn canonical_mind_map_text(file: &ShardMapFile) -> Result<String, String> {
    shard_core::graph_model::canonical_mind_map_text(file)
}

pub fn write_mind_map_last_good(vfs: &dyn Vfs, file: &ShardMapFile) -> Result<(), String> {
    let text = canonical_mind_map_text(file)?;
    let path = vfs.root().join(mind_map_last_good_rel_path(file));
    vfs.write_atomic(&path, text.as_bytes())
        .map_err(|error| error.to_string())
}

pub fn mind_map_last_good_rel_path(file: &ShardMapFile) -> String {
    format!("maps/.last-good/{}.shardmap.json", file.id)
}

pub fn write_mind_map_conflict(vfs: &dyn Vfs, file: &ShardMapFile) -> Result<PathBuf, String> {
    let text = canonical_mind_map_text(file)?;
    // 只用作冲突副本文件名的后缀，时区无关紧要。
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let path = vfs
        .root()
        .join("maps")
        .join(".conflicts")
        .join(format!("{}.conflict-{}.shardmap.json", file.id, timestamp));
    vfs.write_atomic(&path, text.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(path)
}
