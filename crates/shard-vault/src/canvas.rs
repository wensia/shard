//! 公开画布文档：独立流程图（`.shardflow.json`）与旧混合画布（`.shardcanvas.json`，只读与拆分）。
//! 校验、扫描与读写都在这里；桌面命令层只负责取写门与二进制 IPC。
use crate::VaultCtx;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
pub use shard_core::graph_model::{CanvasFile, CanvasNode};
use shard_core::graph_model::ShardMapFile;
use shard_core::Vfs;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

pub mod split;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;
pub const LEGACY_SUFFIX: &str = ".shardcanvas.json";
pub const FLOW_SUFFIX: &str = ".shardflow.json";
pub type CanvasResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasReadResult {
    pub file: CanvasFile,
    pub path: String,
    pub last_saved_hash: String,
}

#[derive(Debug, Clone)]
pub struct CanvasSearchDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub updated_at: String,
    pub revision: String,
    pub body: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreationReceipt {
    pub id: String,
    pub parent_path: String,
    pub title: String,
    pub payload_hash: String,
    pub path: String,
}

pub fn io(error: impl ToString) -> String {
    error.to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn identifier(value: &str) -> CanvasResult<()> {
    if value.trim().is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control)
    {
        return Err("画布对象 ID 必须非空且不超过 200 字。".into());
    }
    Ok(())
}
pub fn is_canvas(path: &Path) -> bool {
    has_suffix(path, LEGACY_SUFFIX) || is_flow(path)
}

pub fn is_flow(path: &Path) -> bool {
    has_suffix(path, FLOW_SUFFIX)
}

pub fn has_suffix(path: &Path, suffix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            !name.starts_with('.') && name.len() > suffix.len() && name.ends_with(suffix)
        })
}

pub fn validate_extension(path: &Path, kind: &str) -> CanvasResult<()> {
    if (kind == "shard.flow" && is_flow(path))
        || (kind == "shard.canvas" && has_suffix(path, LEGACY_SUFFIX))
    {
        Ok(())
    } else {
        Err("图形文档扩展名与内容类型不一致。".into())
    }
}

/// Check every existing component even for a missing reference; never follow symlinks.
pub fn safe_relative(
    vfs: &dyn Vfs,
    relative: &str,
    roots: &[&str],
    missing: bool,
) -> CanvasResult<PathBuf> {
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
    let mut target = vfs.root().to_path_buf();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err("画布路径必须是 vault 内的相对路径。".into());
        };
        if part.to_string_lossy().starts_with('.') {
            return Err("画布不能引用隐藏或内部路径。".into());
        }
        target.push(part);
        match vfs.symlink_metadata(&target) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err("画布路径不能包含符号链接。".into())
            }
            Ok(_) => (),
            Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io(error)),
        }
    }
    Ok(target)
}

pub fn public_path(vfs: &dyn Vfs, relative: &str, directory: bool) -> CanvasResult<PathBuf> {
    let path = safe_relative(vfs, relative, &["notes"], false)?;
    if (directory && !vfs.is_dir(&path))
        || (!directory && (!vfs.is_file(&path) || !is_canvas(&path)))
    {
        return Err("画布路径或文件类型无效。".into());
    }
    Ok(path)
}

pub fn public_directory(vfs: &dyn Vfs, relative: &str) -> CanvasResult<PathBuf> {
    public_path(vfs, relative, true)
}

pub fn read_bytes(vfs: &dyn Vfs, path: &Path) -> CanvasResult<Vec<u8>> {
    let metadata = vfs.symlink_metadata(path).map_err(io)?;
    if !metadata.is_file() || metadata.is_symlink() {
        return Err("画布目标必须是普通文件。".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    let bytes = vfs.read_head(path, MAX_BYTES as u64 + 1).map_err(io)?;
    if bytes.len() > MAX_BYTES {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    Ok(bytes)
}

pub fn canonical<T: Serialize>(value: &T) -> CanvasResult<Vec<u8>> {
    shard_core::graph_model::canonical_json_bytes(value)
}

/// Bounded metadata probe for the Library and identity checks, without resolving references.
pub fn probe_canvas(vfs: &dyn Vfs, path: &Path) -> CanvasResult<(String, String)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Probe {
        kind: String,
        schema_version: u32,
        id: String,
        title: String,
    }
    let probe: Probe = serde_json::from_slice(&read_bytes(vfs, path)?).map_err(io)?;
    if !matches!(probe.kind.as_str(), "shard.canvas" | "shard.flow") || probe.schema_version != 1 {
        return Err("不支持的画布格式或版本。".into());
    }
    validate_extension(path, &probe.kind)?;
    identifier(&probe.id)?;
    if probe.title.trim().is_empty() || probe.title.chars().count() > 500 {
        return Err("画布标题必须非空且不超过 500 字。".into());
    }
    Ok((probe.id, probe.title))
}

pub fn scan_files(
    vfs: &dyn Vfs,
    root: &Path,
    suffix: &str,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
) -> CanvasResult<()> {
    match vfs.symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io(error)),
        Ok(metadata) if metadata.is_symlink() => {
            return Err("画布身份检查不允许符号链接目录。".into())
        }
        Ok(_) => (),
    }
    for entry in vfs.read_dir(root).map_err(io)? {
        *visited += 1;
        if *visited > 100_000 {
            return Err("资料库条目超过本次画布身份检查上限。".into());
        }
        let kind = entry.file_type().map_err(io)?;
        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            scan_files(vfs, &entry.path(), suffix, files, visited)?;
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
            files.push(entry.path());
        }
    }
    Ok(())
}

pub fn validate_file(vfs: &dyn Vfs, file: &CanvasFile) -> CanvasResult<()> {
    shard_core::graph_model::validate_canvas_file(vfs, file)
}

pub fn read_file(vfs: &dyn Vfs, path: &Path) -> CanvasResult<CanvasReadResult> {
    let bytes = read_bytes(vfs, path)?;
    let file: CanvasFile = serde_json::from_slice(&bytes).map_err(io)?;
    validate_extension(path, &file.kind)?;
    validate_file(vfs, &file)?;
    Ok(CanvasReadResult {
        file,
        path: crate::relative_path(vfs.root(), path)?,
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}

/// Search only receives explicitly user-authored text from the typed canvas model.
/// IDs, geometry, links, handles and recovery metadata never enter the projection.
pub fn read_search_document(
    vfs: &dyn Vfs,
    relative: &str,
) -> CanvasResult<CanvasSearchDocument> {
    let path = public_path(vfs, relative, false)?;
    let read = read_file(vfs, &path)?;
    Ok(CanvasSearchDocument {
        id: read.file.id.clone(),
        kind: read.file.kind.clone(),
        title: read.file.title.clone(),
        updated_at: read.file.updated_at.clone(),
        revision: read.last_saved_hash,
        body: search_text(&read.file),
    })
}

pub fn search_text(file: &CanvasFile) -> String {
    shard_core::graph_model::canvas_search_text(file)
}

pub fn identity_paths(vfs: &dyn Vfs, id: &str) -> CanvasResult<Vec<PathBuf>> {
    let vault = vfs.root();
    let mut files = Vec::new();
    let mut visited = 0;
    scan_files(
        vfs,
        &vault.join("notes"),
        LEGACY_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    scan_files(
        vfs,
        &vault.join("notes"),
        FLOW_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    let trash = vault.join(".trash");
    if vfs
        .symlink_metadata(&trash)
        .is_ok_and(|metadata| metadata.is_symlink())
    {
        return Err("画布身份检查不允许符号链接回收站。".into());
    }
    scan_files(
        vfs,
        &trash.join("notes"),
        LEGACY_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    scan_files(
        vfs,
        &trash.join("notes"),
        FLOW_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    let matches: Vec<_> = files
        .into_iter()
        .filter(|path| probe_canvas(vfs, path).is_ok_and(|(candidate, _)| candidate == id))
        .collect();
    if matches.len() > 1 {
        return Err("发现重复的画布 ID，请先处理重复文件。".into());
    }
    Ok(matches)
}

/// Internal recovery paths use a hashed ID, and every parent is checked before creation.
pub fn internal_path(vfs: &dyn Vfs, category: &str, name: &str) -> CanvasResult<PathBuf> {
    let mut parent = vfs.root().to_path_buf();
    for part in [".shard", "canvas", category] {
        parent.push(part);
        match vfs.symlink_metadata(&parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.is_symlink() => (),
            Ok(_) => return Err("画布恢复目录不能是符号链接或普通文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                vfs.create_dir(&parent).map_err(io)?
            }
            Err(error) => return Err(io(error)),
        }
    }
    let path = parent.join(name);
    if vfs
        .symlink_metadata(&path)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.is_symlink())
    {
        return Err("画布恢复文件不能是符号链接或目录。".into());
    }
    Ok(path)
}

pub fn nonce() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 发布写：`replace` 为真时原子替换；为假时只创建新文件，目标已存在（含悬空符号链接）即失败。
/// 本地模式的实现（临时文件名、fsync、hard_link）在 `FsVfs::publish`，与迁移前逐字节一致。
pub fn atomic_write(vfs: &dyn Vfs, path: &Path, bytes: &[u8], replace: bool) -> CanvasResult<()> {
    vfs.publish(path, bytes, replace).map_err(io)
}

pub fn last_good(vfs: &dyn Vfs, file: &CanvasFile, bytes: &[u8]) -> CanvasResult<()> {
    let path = internal_path(
        vfs,
        "last-good",
        &format!("{}.json", crate::hash_text(&file.id)),
    )?;
    atomic_write(vfs, &path, bytes, true)
}

pub fn create_in_vault(
    cx: &VaultCtx<'_>,
    parent_path: &str,
    title: &str,
    mut file: CanvasFile,
) -> CanvasResult<CanvasReadResult> {
    let vfs = cx.vfs;
    let vault = cx.root();
    cx.hooks.ensure_no_unfinished_operation()?;
    let directory = public_path(vfs, parent_path, true)?;
    if file.kind != "shard.flow" {
        return Err("新文档必须是独立流程图；旧混合画布仅支持只读与拆分。".into());
    }
    let title = shard_core::library::validate_library_file_name(title, FLOW_SUFFIX)?;
    if file.title != title || file.revision > 1 {
        return Err("画布创建标题或初始版本不一致。".into());
    }
    validate_file(vfs, &file)?;
    let payload_hash = crate::hash_bytes(&canonical(&file)?);
    let receipt_path = internal_path(
        vfs,
        "creation",
        &format!("{}.json", crate::hash_text(&file.id)),
    )?;
    let receipt = if vfs.exists(&receipt_path) {
        let receipt: CreationReceipt =
            serde_json::from_slice(&read_bytes(vfs, &receipt_path)?).map_err(io)?;
        if receipt.id != file.id
            || receipt.parent_path != parent_path
            || receipt.title != title
            || receipt.payload_hash != payload_hash
        {
            return Err("此画布 ID 已用于不同的创建请求。".into());
        }
        Some(receipt)
    } else {
        None
    };
    if let Some(existing) = identity_paths(vfs, &file.id)?.pop() {
        if receipt.is_none() {
            return Err("此画布 ID 已存在，不能认作本次创建请求。".into());
        }
        if existing.starts_with(vault.join(".trash")) {
            return Err("此创建请求的画布已在回收站。".into());
        }
        return read_file(vfs, &existing);
    }
    // A receipt may survive a failed publication. Retry uses exactly its original path.
    let path = if let Some(receipt) = receipt {
        safe_relative(vfs, &receipt.path, &["notes"], true)?
    } else {
        let path = shard_core::library::unique_titled_path(
            vfs,
            &directory,
            title.trim_end_matches(FLOW_SUFFIX),
            FLOW_SUFFIX,
        );
        let receipt = CreationReceipt {
            id: file.id.clone(),
            parent_path: parent_path.into(),
            title: title.into(),
            payload_hash,
            path: crate::relative_path(vault, &path)?,
        };
        atomic_write(vfs, &receipt_path, &canonical(&receipt)?, false)?;
        path
    };
    file.revision = 1;
    file.updated_at = now();
    let bytes = canonical(&file)?;
    last_good(vfs, &file, &bytes)?;
    atomic_write(vfs, &path, &bytes, false)?;
    Ok(CanvasReadResult {
        file,
        path: crate::relative_path(vault, &path)?,
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}

pub fn read_in_vault(cx: &VaultCtx<'_>, relative: &str) -> CanvasResult<CanvasReadResult> {
    let path = public_path(cx.vfs, relative, false)?;
    let read = read_file(cx.vfs, &path)?;
    identity_paths(cx.vfs, &read.file.id)?;
    Ok(read)
}

pub fn write_in_vault(
    cx: &VaultCtx<'_>,
    relative: &str,
    mut file: CanvasFile,
    expected_revision: u64,
    last_saved_hash: &str,
) -> CanvasResult<CanvasReadResult> {
    let vfs = cx.vfs;
    cx.hooks.ensure_no_unfinished_operation()?;
    let path = public_path(vfs, relative, false)?;
    validate_file(vfs, &file)?;
    let current = read_file(vfs, &path)?;
    if current.file.kind != "shard.flow" || file.kind != current.file.kind {
        return Err("旧混合画布仅支持只读与拆分，不能保存或改变文档类型。".into());
    }
    if current.file.id != file.id || current.file.created_at != file.created_at {
        return Err("画布身份已变化，禁止覆盖另一个文档。".into());
    }
    if file.revision != expected_revision {
        return Err("画布草稿版本与保存基线不一致。".into());
    }
    if current.file.revision != expected_revision || current.last_saved_hash != last_saved_hash {
        if expected_revision.checked_add(1) == Some(current.file.revision) {
            let mut retry = file.clone();
            retry.revision = current.file.revision;
            retry.updated_at = current.file.updated_at.clone();
            if canonical(&retry)? == canonical(&current.file)? {
                return Ok(current);
            }
        }
        let conflict = internal_path(
            vfs,
            "conflicts",
            &format!("{}-{}.shardflow.json", crate::hash_text(&file.id), nonce()),
        )?;
        atomic_write(vfs, &conflict, &canonical(&file)?, false)?;
        return Err(format!(
            "画布已被外部修改，已保留冲突副本：{}",
            crate::relative_path(cx.root(), &conflict)?
        ));
    }
    file.revision = expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_REVISION)
        .ok_or("画布版本超过上限。")?;
    file.updated_at = now();
    let bytes = canonical(&file)?;
    // Prepare recovery before publishing, so a recovery-write failure cannot masquerade as a failed primary save.
    last_good(vfs, &file, &bytes)?;
    atomic_write(vfs, &path, &bytes, true)?;
    Ok(CanvasReadResult {
        file,
        path: relative.into(),
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}
