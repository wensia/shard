//! 改名、移动，以及随之改写的引用（wikilink、Markdown 图片、CSV 单元格图片）。

use crate::prelude::*;

/// 返回（重命名后的碎片、改写的双链处数、改写的图片引用处数）。
pub fn rename_library_entry_in_vault(
    cx: &VaultCtx<'_>,
    rel_path: &str,
    new_name: &str,
) -> Result<(Option<Fragment>, usize, usize), String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    let relative = safe_vault_relative_path(rel_path)?;
    let is_fragment = relative.starts_with("fragments");
    let source = if is_fragment {
        let source = vault.join(relative);
        let metadata = vfs.symlink_metadata(&source).map_err(|error| error.to_string())?;
        if !metadata.is_file()
            || !source
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            return Err("碎片分类只允许重命名单个 Markdown 文件。".to_string());
        }
        let root = vfs
            .canonicalize(&vault.join("fragments"))
            .map_err(|error| error.to_string())?;
        let canonical = vfs.canonicalize(&source).map_err(|error| error.to_string())?;
        let canonical_vault = vfs.canonicalize(vault).map_err(|error| error.to_string())?;
        if !root.starts_with(&canonical_vault) || !canonical.starts_with(&root) {
            return Err("不能操作碎片目录外路径。".to_string());
        }
        source
    } else {
        existing_library_path(vfs, rel_path)?
    };
    let fragment = if is_fragment {
        Some(read_fragment(cx, &source, &HashSet::new(), None)?)
    } else {
        None
    };
    let new_name = validate_library_name_characters(new_name)?;
    let file_type = vfs.metadata(&source).map_err(|error| error.to_string())?;
    let old_stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let final_name = if file_type.is_file() {
        if canvas::is_canvas(&source) {
            let suffix = if canvas::is_flow(&source) { ".shardflow.json" } else { ".shardcanvas.json" };
            if new_name.ends_with(suffix) {
                new_name.to_string()
            } else if Path::new(new_name).extension().is_some() {
                return Err("重命名不能改变文件类型。".to_string());
            } else {
                format!("{new_name}{suffix}")
            }
        } else if is_mind_map_file(&source) {
            if new_name.ends_with(".shardmap.json") {
                new_name.to_string()
            } else if Path::new(new_name).extension().is_some() {
                return Err("重命名不能改变文件类型。".to_string());
            } else {
                format!("{new_name}.shardmap.json")
            }
        } else {
            let extension = source
                .extension()
                .and_then(|extension| extension.to_str())
                .ok_or_else(|| "只允许重命名 Markdown、CSV、图片或思维导图文件。".to_string())?;
            if !matches!(extension.to_ascii_lowercase().as_str(), "md" | "csv")
                && !shard_core::image::is_image_extension(extension)
            {
                return Err("只允许重命名 Markdown、CSV、图片或思维导图文件。".to_string());
            }
            let requested = Path::new(new_name);
            match requested.extension().and_then(|value| value.to_str()) {
                Some(requested_extension) if requested_extension.eq_ignore_ascii_case(extension) => {
                    new_name.to_string()
                }
                Some(_) => return Err("重命名不能改变文件类型。".to_string()),
                None => format!("{new_name}.{extension}"),
            }
        }
    } else {
        new_name.to_string()
    };
    let extension = if !file_type.is_file() {
        String::new()
    } else if canvas::is_canvas(&source) {
        if canvas::is_flow(&source) {
            ".shardflow.json"
        } else {
            ".shardcanvas.json"
        }
        .to_string()
    } else if is_mind_map_file(&source) {
        ".shardmap.json".to_string()
    } else {
        format!(
            ".{}",
            Path::new(&final_name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        )
    };
    validate_library_file_name(&final_name, &extension)?;
    let destination = source
        .parent()
        .ok_or_else(|| "资料库条目缺少父目录。".to_string())?
        .join(final_name);
    if vfs.exists(&destination) {
        return Err("目标名称已存在。".to_string());
    }
    let new_stem = destination
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let link_updates = if file_type.is_file()
        && destination
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("md")
        && !fragment.as_ref().is_some_and(|fragment| fragment.id == old_stem)
    {
        plan_vault_wikilink_updates(vfs, &old_stem, new_stem)?
    } else {
        Vec::new()
    };
    let old_rel = rel_path.to_string();
    let new_rel = relative_path(vault, &destination)?;
    let image_updates = if !file_type.is_file() || shard_core::image::is_image_path(&source) {
        plan_image_reference_updates(vfs, &[(old_rel.clone(), new_rel.clone())])?
    } else {
        Vec::new()
    };
    let link_count = link_updates.len();
    let updates: Vec<_> = link_updates.into_iter().chain(image_updates).collect();
    let written = apply_reference_updates(
        vfs,
        &source,
        &destination,
        updates
            .iter()
            .map(|(path, text, next, _)| (path, text, next)),
    )?;
    let updated_links: usize = updates[..link_count].iter().map(|update| update.3).sum();
    let mut updated_image_refs: usize = updates[link_count..].iter().map(|update| update.3).sum();
    let csv_changes = if !file_type.is_file() || shard_core::image::is_image_path(&destination) {
        rewrite_csv_image_references(vfs, &[(old_rel.clone(), new_rel.clone())])
    } else {
        (0, Vec::new())
    };
    updated_image_refs += csv_changes.0;
    let mut changed_paths = vec![old_rel, new_rel];
    append_unique_paths(&mut changed_paths, csv_changes.1);
    for (path, _) in &written {
        let rel_path = relative_path(vault, path)?;
        if !changed_paths.contains(&rel_path) {
            changed_paths.push(rel_path);
        }
    }
    cx.hooks.commit_paths_best_effort(
        &changed_paths,
        &format!("rename library entry {old_stem}"),
    );
    let fragment = if is_fragment {
        Some(read_fragment(cx, &destination, &cx.hooks.dirty_paths(), None)?)
    } else {
        None
    };
    Ok((fragment, updated_links, updated_image_refs))
}

/// 改名/移动前算好要改写的公开 Markdown：命中 `moves` 的图片引用换成新路径。
pub fn plan_image_reference_updates(
    vfs: &dyn Vfs,
    moves: &[(String, String)],
) -> Result<Vec<(PathBuf, String, String, usize)>, String> {
    let mut files = Vec::new();
    collect_public_vault_markdown(vfs, vfs.root(), &mut files)?;
    let mut updates = Vec::new();
    for path in files {
        let Ok(text) = vfs.read_to_string(&path) else {
            continue;
        };
        if !text.contains("](") {
            continue;
        }
        let (next, count) = shard_core::image_refs::rewrite_markdown_image_references(&text, moves);
        if count > 0 {
            updates.push((path, text, next, count));
        }
    }
    Ok(updates)
}

/// `source` 已改名/移动到 `destination` 后写回正文改动；位于被移动目录里的文档按新位置写。
/// 任何一处失败就把已写的恢复原文并把条目挪回原处。返回实际写过的（新路径、原文）。
pub fn apply_reference_updates<'a>(
    vfs: &dyn Vfs,
    source: &Path,
    destination: &Path,
    updates: impl Iterator<Item = (&'a PathBuf, &'a String, &'a String)>,
) -> Result<Vec<(PathBuf, String)>, String> {
    let updates: Vec<_> = updates.collect();
    vfs.rename(source, destination).map_err(|error| error.to_string())?;
    let mut written = Vec::<(PathBuf, String)>::new();
    for (original_path, original_text, next_text) in updates {
        let path = if original_path == source {
            destination.to_path_buf()
        } else if let Ok(rest) = original_path.strip_prefix(source) {
            destination.join(rest)
        } else {
            original_path.clone()
        };
        if let Err(error) = vfs.write_atomic(&path, next_text.as_bytes()) {
            for (written_path, previous_text) in written.into_iter().rev() {
                let _ = vfs.write_atomic(&written_path, previous_text.as_bytes());
            }
            let _ = vfs.rename(destination, source);
            return Err(format!("移动后的引用更新失败，已回滚：{error}"));
        }
        written.push((path, original_text.clone()));
    }
    Ok(written)
}

/// 返回改写的图片引用处数。
pub fn move_library_entry_in_vault(
    cx: &VaultCtx<'_>,
    rel_path: &str,
    target_directory: Option<&str>,
) -> Result<usize, String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    let source = existing_library_path(vfs, rel_path)?;
    let target_directory = existing_library_directory(vfs, target_directory)?;
    if vfs.is_dir(&source) && target_directory.starts_with(&source) {
        return Err("目录不能移动到自身内部。".to_string());
    }
    let destination = target_directory.join(
        source
            .file_name()
            .ok_or_else(|| "资料库条目名称无效。".to_string())?,
    );
    if destination == source {
        return Ok(0);
    }
    if vfs.exists(&destination) {
        return Err("目标目录中已有同名条目。".to_string());
    }
    let new_rel = relative_path(vault, &destination)?;
    // 目录里可能有图片，图片本身被移动也要改；文档移动不影响图片引用（引用是 vault 相对路径）。
    let updates = if vfs.is_dir(&source) || shard_core::image::is_image_path(&source) {
        plan_image_reference_updates(vfs, &[(rel_path.trim().to_string(), new_rel.clone())])?
    } else {
        Vec::new()
    };
    let written = apply_reference_updates(
        vfs,
        &source,
        &destination,
        updates.iter().map(|(path, text, next, _)| (path, text, next)),
    )?;
    let csv_changes = if vfs.is_dir(&destination) || shard_core::image::is_image_path(&destination) {
        rewrite_csv_image_references(vfs, &[(rel_path.trim().to_string(), new_rel.clone())])
    } else {
        (0, Vec::new())
    };
    let mut changed_paths = vec![rel_path.to_string(), new_rel];
    for (path, _) in &written {
        let rel_path = relative_path(vault, path)?;
        if !changed_paths.contains(&rel_path) {
            changed_paths.push(rel_path);
        }
    }
    append_unique_paths(&mut changed_paths, csv_changes.1);
    cx.hooks
        .commit_paths_best_effort(&changed_paths, "move library entry");
    Ok(updates.iter().map(|update| update.3).sum::<usize>() + csv_changes.0)
}

/// 图片或目录改名、移动之后，改写公开 CSV 单元格里指向它们的路径。经数据集核心写回
/// （校验 sha、保留文件原写法）。尽力而为：只读或写入失败的表格跳过并记日志，不回滚
/// 已完成的移动——那一格只是退回显示路径文字。返回（改写的格数、改过的表格）。
pub fn rewrite_csv_image_references(vfs: &dyn Vfs, moves: &[(String, String)]) -> (usize, Vec<String>) {
    let vault = vfs.root();
    let mut files = Vec::new();
    if collect_csv_files(vfs, vault, &mut files).is_err() {
        return (0, Vec::new());
    }
    let limits = DatasetLimits::default();
    let mut count = 0;
    let mut changed = Vec::new();
    for path in files {
        let Ok(rel) = relative_path(vault, &path) else {
            continue;
        };
        if rel.starts_with(".trash/") {
            continue;
        }
        let Ok(bytes) = vfs.read(&path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        if !moves.iter().any(|(old, _)| text.contains(old.as_str())) {
            continue;
        }
        let snapshot = match dataset::read_dataset(vfs, &rel, &limits) {
            Ok(snapshot) if snapshot.editable => snapshot,
            Ok(_) | Err(_) => {
                eprintln!("[shard] {rel} 不可编辑，未改写其中的图片引用");
                continue;
            }
        };
        let mut cells = Vec::new();
        for (row, values) in snapshot.table.rows.iter().enumerate() {
            for (column, value) in values.iter().enumerate() {
                if shard_core::image_refs::csv_cell_image_references(value).is_none() {
                    continue;
                }
                let mut hit = false;
                let next = value
                    .lines()
                    .map(|line| {
                        let reference = line.trim();
                        match shard_core::image_refs::remap_reference(reference, moves) {
                            Some(next) if shard_core::image_refs::is_local_image_reference(reference) => {
                                hit = true;
                                next
                            }
                            _ => line.to_string(),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if hit {
                    cells.push(dataset::CellEdit { row, column, value: next });
                }
            }
        }
        if cells.is_empty() {
            continue;
        }
        let edited = cells.len();
        match dataset::write_dataset_ops(
            vfs,
            &rel,
            &snapshot.sha,
            snapshot.schema_sha.as_deref(),
            &[DatasetOp::SetCells { cells }],
            &limits,
        ) {
            Ok(_) => {
                count += edited;
                changed.push(rel);
            }
            Err(error) => eprintln!("[shard] 改写 {rel} 里的图片引用失败：{error}"),
        }
    }
    (count, changed)
}

pub fn plan_vault_wikilink_updates(
    vfs: &dyn Vfs,
    old_target: &str,
    new_target: &str,
) -> Result<Vec<(PathBuf, String, String, usize)>, String> {
    if old_target == new_target {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_public_vault_markdown(vfs, vfs.root(), &mut files)?;
    let mut updates = Vec::new();
    for path in files {
        let text = vfs.read_to_string(&path).map_err(|error| error.to_string())?;
        let (next, count) = replace_wikilink_targets(&text, old_target, new_target);
        if count > 0 {
            updates.push((path, text, next, count));
        }
    }
    Ok(updates)
}

pub fn append_unique_paths(paths: &mut Vec<String>, additions: Vec<String>) {
    for path in additions {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
}

pub fn replace_wikilink_targets(text: &str, old_target: &str, new_target: &str) -> (String, usize) {
    let mut output = String::with_capacity(text.len());
    let mut remaining = text;
    let mut count = 0;
    while let Some(open_index) = remaining.find("[[") {
        output.push_str(&remaining[..open_index + 2]);
        remaining = &remaining[(open_index + 2)..];
        let Some(close_index) = remaining.find("]]") else {
            output.push_str(remaining);
            return (output, count);
        };
        let inner = &remaining[..close_index];
        let (target, suffix) = inner
            .find('|')
            .map(|index| (&inner[..index], &inner[index..]))
            .unwrap_or((inner, ""));
        if target == old_target {
            output.push_str(new_target);
            output.push_str(suffix);
            count += 1;
        } else {
            output.push_str(inner);
        }
        output.push_str("]]");
        remaining = &remaining[(close_index + 2)..];
    }
    output.push_str(remaining);
    (output, count)
}
