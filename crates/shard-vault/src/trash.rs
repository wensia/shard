//! 回收站：移入、恢复、彻底删除、清空。只操作公开内容。

use crate::prelude::*;

pub fn safe_vault_relative_path(rel_path: &str) -> Result<&Path, String> {
    let rel_path = rel_path.trim();
    let path = Path::new(rel_path);
    if rel_path.is_empty() || rel_path.contains('\\') || path.is_absolute() {
        return Err("Vault 路径必须是相对路径。".to_string());
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Vault 路径不能包含 . 或 ..。".to_string());
    }
    Ok(path)
}

pub fn trashable_vault_path(vfs: &dyn Vfs, rel_path: &str) -> Result<PathBuf, String> {
    let vault = vfs.root();
    let rel_path = safe_vault_relative_path(rel_path)?;
    let first = rel_path.components().next();
    if !matches!(first, Some(Component::Normal(root)) if matches!(root.to_str(), Some("fragments" | "notes" | "assets" | "maps" | "datasets")))
    {
        return Err("只能把公开内容移入回收站。".to_string());
    }
    let candidate = vault.join(rel_path);
    let canonical_vault = vfs.canonicalize(vault).map_err(|error| error.to_string())?;
    let canonical_candidate = vfs.canonicalize(&candidate).map_err(|error| error.to_string())?;
    if !canonical_candidate.starts_with(&canonical_vault) || canonical_candidate == canonical_vault {
        return Err("目标不在 Vault 内。".to_string());
    }
    Ok(candidate)
}

pub fn timestamped_collision_path(vfs: &dyn Vfs, path: &Path) -> Result<PathBuf, String> {
    if !vfs.exists(path) {
        return Ok(path.to_path_buf());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "条目名称无效。".to_string())?;
    // `.shardtable.json` is a retired multidimensional-table (旧多维表格) suffix; keep it so
    // restoring a legacy file from trash still preserves its double extension.
    let (stem, extension) = [
        ".shardflow.json", ".shardcanvas.json", ".shardtable.json", ".shardmap.json",
    ]
    .into_iter()
    .find_map(|extension| file_name.strip_suffix(extension).map(|stem| (stem, extension)))
    .unwrap_or_else(|| match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => (stem, &file_name[stem.len()..]),
        _ => (file_name, ""),
    });
    // 只用作撞名后缀，时区无关紧要。
    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    for counter in 0..=u16::MAX {
        let suffix = if counter == 0 {
            timestamp.to_string()
        } else {
            format!("{timestamp}-{counter}")
        };
        let suffixed = bounded_library_filename(stem, &format!("-{suffix}"), extension);
        let candidate = path.with_file_name(suffixed);
        if !vfs.exists(&candidate) {
            return Ok(candidate);
        }
    }
    Err("无法生成不冲突的条目名称。".to_string())
}

pub fn ensure_canonical_trash_root(vfs: &dyn Vfs) -> Result<PathBuf, String> {
    let vault = vfs.root();
    let trash = vault.join(".trash");
    if !vfs.exists(&trash) {
        vfs.create_dir_all(&trash).map_err(|error| error.to_string())?;
    }
    if vfs
        .symlink_metadata(&trash)
        .map_err(|error| error.to_string())?
        .is_symlink()
    {
        return Err("回收站目录不能是符号链接。".to_string());
    }
    let canonical_vault = vfs.canonicalize(vault).map_err(|error| error.to_string())?;
    let canonical_trash = vfs.canonicalize(&trash).map_err(|error| error.to_string())?;
    if canonical_trash.parent() != Some(canonical_vault.as_path()) {
        return Err("回收站目录不在 Vault 内。".to_string());
    }
    Ok(canonical_trash)
}

pub fn move_to_trash_without_commit_in_vault(
    cx: &VaultCtx<'_>,
    rel_path: &str,
) -> Result<PathBuf, String> {
    let vfs = cx.vfs;
    let source = trashable_vault_path(vfs, rel_path)?;
    let trash_root = ensure_canonical_trash_root(vfs)?;
    let destination = timestamped_collision_path(vfs, &cx.root().join(".trash").join(rel_path))?;
    if let Some(parent) = destination.parent() {
        vfs.create_dir_all(parent).map_err(|error| error.to_string())?;
        let canonical_parent = vfs.canonicalize(parent).map_err(|error| error.to_string())?;
        if !canonical_parent.starts_with(&trash_root) {
            return Err("回收站目标不在 .trash 内。".to_string());
        }
    }
    vfs.rename(&source, &destination).map_err(|error| error.to_string())?;
    Ok(destination)
}

pub fn move_to_trash_in_vault(cx: &VaultCtx<'_>, rel_path: &str) -> Result<PathBuf, String> {
    let destination = move_to_trash_without_commit_in_vault(cx, rel_path)?;
    let destination_rel = relative_path(cx.root(), &destination)?;
    cx.hooks.commit_paths_best_effort(
        &[rel_path.to_string(), destination_rel],
        "move entry to trash",
    );
    Ok(destination)
}

pub fn canonical_trash_path(vfs: &dyn Vfs, trash_rel_path: &str) -> Result<PathBuf, String> {
    let rel_path = safe_vault_relative_path(trash_rel_path)?;
    if !matches!(rel_path.components().next(), Some(Component::Normal(root)) if root == ".trash") {
        return Err("只能操作回收站内的条目。".to_string());
    }
    let trash_root = ensure_canonical_trash_root(vfs)?;
    let candidate = vfs.root().join(rel_path);
    if vfs
        .symlink_metadata(&candidate)
        .map_err(|error| error.to_string())?
        .is_symlink()
    {
        return Err("回收站条目不能是符号链接。".to_string());
    }
    let target = vfs
        .canonicalize(&candidate)
        .map_err(|error| error.to_string())?;
    if target == trash_root || !target.starts_with(&trash_root) {
        return Err("只能操作回收站内的条目。".to_string());
    }
    Ok(candidate)
}

pub fn restore_from_trash_in_vault(cx: &VaultCtx<'_>, trash_rel_path: &str) -> Result<PathBuf, String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    let source = canonical_trash_path(vfs, trash_rel_path)?;
    let source_rel = relative_path(vault, &source)?;
    let original_rel = source_rel
        .strip_prefix(".trash/")
        .ok_or_else(|| "只能恢复回收站内的条目。".to_string())?;
    let original_path = safe_vault_relative_path(original_rel)?;
    if !matches!(original_path.components().next(), Some(Component::Normal(root)) if matches!(root.to_str(), Some("fragments" | "notes" | "assets" | "maps" | "datasets")))
    {
        return Err("回收站条目没有可恢复的公开原位置。".to_string());
    }
    let destination = timestamped_collision_path(vfs, &vault.join(original_rel))?;
    if let Some(parent) = destination.parent() {
        vfs.create_dir_all(parent).map_err(|error| error.to_string())?;
        let canonical_vault = vfs.canonicalize(vault).map_err(|error| error.to_string())?;
        let canonical_parent = vfs.canonicalize(parent).map_err(|error| error.to_string())?;
        if !canonical_parent.starts_with(&canonical_vault) {
            return Err("恢复目标不在 Vault 内。".to_string());
        }
    }
    vfs.rename(&source, &destination).map_err(|error| error.to_string())?;
    let destination_rel = relative_path(vault, &destination)?;
    cx.hooks.commit_paths_best_effort(
        &[source_rel, destination_rel],
        "restore entry from trash",
    );
    Ok(destination)
}

pub fn purge_from_trash_in_vault(cx: &VaultCtx<'_>, trash_rel_path: &str) -> Result<(), String> {
    let target = canonical_trash_path(cx.vfs, trash_rel_path)?;
    let target_rel = relative_path(cx.root(), &target)?;
    if cx.vfs.is_dir(&target) {
        cx.vfs.remove_dir_all(&target).map_err(|error| error.to_string())?;
    } else {
        cx.vfs.remove_file(&target).map_err(|error| error.to_string())?;
    }
    cx.hooks
        .commit_paths_best_effort(&[target_rel], "purge entry from trash");
    Ok(())
}

pub fn empty_trash_in_vault(cx: &VaultCtx<'_>, scope: ContentScope) -> Result<(), String> {
    let vfs = cx.vfs;
    let vault = cx.root();
    let trash = vault.join(".trash");
    if !vfs.exists(&trash) {
        return Ok(());
    }
    let trash_root = ensure_canonical_trash_root(vfs)?;
    let mut targets = Vec::new();
    for entry in vfs.read_dir(&trash).map_err(|error| error.to_string())? {
        let candidate = entry.path();
        let is_fragment_trash = entry.file_name() == "fragments";
        if scope != ContentScope::All && is_fragment_trash != (scope == ContentScope::Fragments) {
            continue;
        }
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_symlink()
        {
            return Err("回收站包含符号链接，已拒绝清空。".to_string());
        }
        let canonical_target = vfs
            .canonicalize(&candidate)
            .map_err(|error| error.to_string())?;
        if canonical_target == trash_root || !canonical_target.starts_with(&trash_root) {
            return Err("回收站包含越界路径，已拒绝清空。".to_string());
        }
        targets.push(candidate);
    }
    let mut removed_paths = Vec::new();
    for target in targets {
        removed_paths.push(relative_path(vault, &target)?);
        if vfs.is_dir(&target) {
            vfs.remove_dir_all(&target).map_err(|error| error.to_string())?;
        } else {
            vfs.remove_file(&target).map_err(|error| error.to_string())?;
        }
    }
    if !removed_paths.is_empty() {
        cx.hooks.commit_paths_best_effort(&removed_paths, "empty trash");
    }
    Ok(())
}
