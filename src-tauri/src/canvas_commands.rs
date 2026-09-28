//! Public canvas documents. Commands do all validation, scanning and I/O off the UI thread.
pub(crate) use crate::{CanvasFile, CanvasNode};
#[cfg(test)]
pub(crate) use crate::CanvasEdge;
use crate::ShardMapFile;
#[cfg(test)]
use crate::ShardDocumentLink;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub(crate) mod split;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const LEGACY_SUFFIX: &str = ".shardcanvas.json";
const FLOW_SUFFIX: &str = ".shardflow.json";
type CanvasResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasReadResult {
    pub file: CanvasFile,
    pub path: String,
    pub last_saved_hash: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CanvasSearchDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub updated_at: String,
    pub revision: String,
    pub body: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationReceipt {
    id: String,
    parent_path: String,
    title: String,
    payload_hash: String,
    path: String,
}

fn io(error: impl ToString) -> String {
    error.to_string()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn identifier(value: &str) -> CanvasResult<()> {
    if value.trim().is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control)
    {
        return Err("画布对象 ID 必须非空且不超过 200 字。".into());
    }
    Ok(())
}
pub(crate) fn is_canvas(path: &Path) -> bool {
    has_suffix(path, LEGACY_SUFFIX) || is_flow(path)
}

pub(crate) fn is_flow(path: &Path) -> bool {
    has_suffix(path, FLOW_SUFFIX)
}

fn has_suffix(path: &Path, suffix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            !name.starts_with('.') && name.len() > suffix.len() && name.ends_with(suffix)
        })
}

fn validate_extension(path: &Path, kind: &str) -> CanvasResult<()> {
    if (kind == "shard.flow" && is_flow(path))
        || (kind == "shard.canvas" && has_suffix(path, LEGACY_SUFFIX))
    {
        Ok(())
    } else {
        Err("图形文档扩展名与内容类型不一致。".into())
    }
}

/// Check every existing component even for a missing reference; never follow symlinks.
fn safe_relative(
    vault: &Path,
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

fn public_path(vault: &Path, relative: &str, directory: bool) -> CanvasResult<PathBuf> {
    let path = safe_relative(vault, relative, &["notes"], false)?;
    if (directory && !path.is_dir()) || (!directory && (!path.is_file() || !is_canvas(&path))) {
        return Err("画布路径或文件类型无效。".into());
    }
    Ok(path)
}

pub(crate) fn public_directory(vault: &Path, relative: &str) -> CanvasResult<PathBuf> {
    public_path(vault, relative, true)
}

fn read_bytes(path: &Path) -> CanvasResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("画布目标必须是普通文件。".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > MAX_BYTES {
        return Err("画布文件不能超过 8 MiB。".into());
    }
    Ok(bytes)
}

pub(crate) fn canonical<T: Serialize>(value: &T) -> CanvasResult<Vec<u8>> {
    shard_core::graph_model::canonical_json_bytes(value)
}

/// Bounded metadata probe for the Library and identity checks, without resolving references.
pub(crate) fn probe_canvas(path: &Path) -> CanvasResult<(String, String)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Probe {
        kind: String,
        schema_version: u32,
        id: String,
        title: String,
    }
    let probe: Probe = serde_json::from_slice(&read_bytes(path)?).map_err(io)?;
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

pub(crate) fn scan_files(
    root: &Path,
    suffix: &str,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
) -> CanvasResult<()> {
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

/// Deleted public targets remain valid document links. Privacy and path boundaries
/// still apply, so a missing link never turns a migrated diagram into an unreadable file.
#[cfg(test)]
pub(crate) fn validate_public_link(vault: &Path, link: &ShardDocumentLink) -> CanvasResult<()> {
    shard_core::graph_model::validate_public_link(vault, link)
}

pub(crate) fn validate_file(vault: &Path, file: &CanvasFile) -> CanvasResult<()> {
    shard_core::graph_model::validate_canvas_file(vault, file)
}

fn read_file(vault: &Path, path: &Path) -> CanvasResult<CanvasReadResult> {
    let bytes = read_bytes(path)?;
    let file: CanvasFile = serde_json::from_slice(&bytes).map_err(io)?;
    validate_extension(path, &file.kind)?;
    validate_file(vault, &file)?;
    Ok(CanvasReadResult {
        file,
        path: crate::relative_path(vault, path)?,
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}

/// Search only receives explicitly user-authored text from the typed canvas model.
/// IDs, geometry, links, handles and recovery metadata never enter the projection.
pub(crate) fn read_search_document(
    vault: &Path,
    relative: &str,
) -> CanvasResult<CanvasSearchDocument> {
    let path = public_path(vault, relative, false)?;
    let read = read_file(vault, &path)?;
    Ok(CanvasSearchDocument {
        id: read.file.id.clone(),
        kind: read.file.kind.clone(),
        title: read.file.title.clone(),
        updated_at: read.file.updated_at.clone(),
        revision: read.last_saved_hash,
        body: search_text(&read.file),
    })
}

pub(crate) fn search_text(file: &CanvasFile) -> String {
    shard_core::graph_model::canvas_search_text(file)
}

fn identity_paths(vault: &Path, id: &str) -> CanvasResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut visited = 0;
    scan_files(
        &vault.join("notes"),
        LEGACY_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    scan_files(&vault.join("notes"), FLOW_SUFFIX, &mut files, &mut visited)?;
    let trash = vault.join(".trash");
    if fs::symlink_metadata(&trash).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("画布身份检查不允许符号链接回收站。".into());
    }
    scan_files(
        &trash.join("notes"),
        LEGACY_SUFFIX,
        &mut files,
        &mut visited,
    )?;
    scan_files(&trash.join("notes"), FLOW_SUFFIX, &mut files, &mut visited)?;
    let matches: Vec<_> = files
        .into_iter()
        .filter(|path| probe_canvas(path).is_ok_and(|(candidate, _)| candidate == id))
        .collect();
    if matches.len() > 1 {
        return Err("发现重复的画布 ID，请先处理重复文件。".into());
    }
    Ok(matches)
}

/// Internal recovery paths use a hashed ID, and every parent is checked before creation.
fn internal_path(vault: &Path, category: &str, name: &str) -> CanvasResult<PathBuf> {
    let mut parent = vault.to_path_buf();
    for part in [".shard", "canvas", category] {
        parent.push(part);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
            Ok(_) => return Err("画布恢复目录不能是符号链接或普通文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&parent).map_err(io)?
            }
            Err(error) => return Err(io(error)),
        }
    }
    let path = parent.join(name);
    if fs::symlink_metadata(&path)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("画布恢复文件不能是符号链接或目录。".into());
    }
    Ok(path)
}

fn nonce() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> CanvasResult<()> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("画布文件名无效。")?;
    let temp = TempFile(path.with_file_name(crate::temporary_filename(
        name,
        &format!(".canvas-tmp-{}", nonce()),
    )));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    file.sync_all().map_err(io)?;
    drop(file);
    if replace {
        fs::rename(&temp.0, path).map_err(io)?;
    } else {
        // Publishing with hard_link is atomic and refuses every existing target, including a dangling symlink.
        fs::hard_link(&temp.0, path).map_err(io)?;
    }
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn last_good(vault: &Path, file: &CanvasFile, bytes: &[u8]) -> CanvasResult<()> {
    let path = internal_path(
        vault,
        "last-good",
        &format!("{}.json", crate::hash_text(&file.id)),
    )?;
    atomic_write(&path, bytes, true)
}

pub(crate) fn create_in_vault(
    vault: &Path,
    parent_path: &str,
    title: &str,
    mut file: CanvasFile,
) -> CanvasResult<CanvasReadResult> {
    crate::ensure_no_unfinished_git_operation(vault)?;
    let directory = public_path(vault, parent_path, true)?;
    if file.kind != "shard.flow" {
        return Err("新文档必须是独立流程图；旧混合画布仅支持只读与拆分。".into());
    }
    let title = crate::validate_library_file_name(title, FLOW_SUFFIX)?;
    if file.title != title || file.revision > 1 {
        return Err("画布创建标题或初始版本不一致。".into());
    }
    validate_file(vault, &file)?;
    let payload_hash = crate::hash_bytes(&canonical(&file)?);
    let receipt_path = internal_path(
        vault,
        "creation",
        &format!("{}.json", crate::hash_text(&file.id)),
    )?;
    let receipt = if receipt_path.exists() {
        let receipt: CreationReceipt =
            serde_json::from_slice(&read_bytes(&receipt_path)?).map_err(io)?;
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
    if let Some(existing) = identity_paths(vault, &file.id)?.pop() {
        if receipt.is_none() {
            return Err("此画布 ID 已存在，不能认作本次创建请求。".into());
        }
        if existing.starts_with(vault.join(".trash")) {
            return Err("此创建请求的画布已在回收站。".into());
        }
        return read_file(vault, &existing);
    }
    // A receipt may survive a failed publication. Retry uses exactly its original path.
    let path = if let Some(receipt) = receipt {
        safe_relative(vault, &receipt.path, &["notes"], true)?
    } else {
        let path =
            crate::unique_titled_path(&directory, title.trim_end_matches(FLOW_SUFFIX), FLOW_SUFFIX);
        let receipt = CreationReceipt {
            id: file.id.clone(),
            parent_path: parent_path.into(),
            title: title.into(),
            payload_hash,
            path: crate::relative_path(vault, &path)?,
        };
        atomic_write(&receipt_path, &canonical(&receipt)?, false)?;
        path
    };
    file.revision = 1;
    file.updated_at = now();
    let bytes = canonical(&file)?;
    last_good(vault, &file, &bytes)?;
    atomic_write(&path, &bytes, false)?;
    Ok(CanvasReadResult {
        file,
        path: crate::relative_path(vault, &path)?,
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}

pub(crate) fn read_in_vault(vault: &Path, relative: &str) -> CanvasResult<CanvasReadResult> {
    let path = public_path(vault, relative, false)?;
    let read = read_file(vault, &path)?;
    identity_paths(vault, &read.file.id)?;
    Ok(read)
}

pub(crate) fn write_in_vault(
    vault: &Path,
    relative: &str,
    mut file: CanvasFile,
    expected_revision: u64,
    last_saved_hash: &str,
) -> CanvasResult<CanvasReadResult> {
    crate::ensure_no_unfinished_git_operation(vault)?;
    let path = public_path(vault, relative, false)?;
    validate_file(vault, &file)?;
    let current = read_file(vault, &path)?;
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
            vault,
            "conflicts",
            &format!("{}-{}.shardflow.json", crate::hash_text(&file.id), nonce()),
        )?;
        atomic_write(&conflict, &canonical(&file)?, false)?;
        return Err(format!(
            "画布已被外部修改，已保留冲突副本：{}",
            crate::relative_path(vault, &conflict)?
        ));
    }
    file.revision = expected_revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_REVISION)
        .ok_or("画布版本超过上限。")?;
    file.updated_at = now();
    let bytes = canonical(&file)?;
    // Prepare recovery before publishing, so a recovery-write failure cannot masquerade as a failed primary save.
    last_good(vault, &file, &bytes)?;
    atomic_write(&path, &bytes, true)?;
    Ok(CanvasReadResult {
        file,
        path: relative.into(),
        last_saved_hash: crate::hash_bytes(&bytes),
    })
}

fn request_bytes(request: &tauri::ipc::Request<'_>) -> CanvasResult<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_BYTES + 16 * 1024 => {
            Ok(bytes.clone())
        }
        tauri::ipc::InvokeBody::Raw(_) => Err("画布请求超过 8 MiB 内容上限。".into()),
        _ => Err("画布请求需要二进制 JSON。".into()),
    }
}

fn response(value: CanvasReadResult) -> CanvasResult<tauri::ipc::Response> {
    serde_json::to_vec(&value)
        .map(tauri::ipc::Response::new)
        .map_err(io)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    parent_path: String,
    title: String,
    file: CanvasFile,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    path: String,
    file: CanvasFile,
    expected_revision: u64,
    last_saved_hash: String,
}

#[tauri::command]
pub(crate) async fn create_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: CreateRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        response(create_in_vault(
            &vault,
            &request.parent_path,
            &request.title,
            request.file,
        )?)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn read_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: ReadRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::configured_vault_path(&app)?;
        response(read_in_vault(&vault, &request.path)?)
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn write_canvas(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CanvasResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request: WriteRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app)?;
        let _gate = crate::lock_vault_gate(&vault);
        response(write_in_vault(
            &vault,
            &request.path,
            request.file,
            request.expected_revision,
            &request.last_saved_hash,
        )?)
    })
    .await
    .map_err(io)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(super) fn vault() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        crate::ensure_vault_layout(directory.path()).unwrap();
        crate::run_git(directory.path(), &["init", "--initial-branch=main"]).unwrap();
        crate::run_git(directory.path(), &["config", "user.name", "Canvas fixture"]).unwrap();
        crate::run_git(
            directory.path(),
            &["config", "user.email", "canvas@example.invalid"],
        )
        .unwrap();
        crate::run_git(directory.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        crate::run_git(
            directory.path(),
            &["config", "core.hooksPath", ".disabled-test-hooks"],
        )
        .unwrap();
        directory
    }
    pub(super) fn fixture() -> CanvasFile {
        serde_json::from_value(json!({
            "kind":"shard.flow", "schemaVersion":1, "id":"canvas-fixture", "title":"中文画布",
            "createdAt":"2026-09-07T00:00:00.000Z", "updatedAt":"2026-09-07T00:00:00.000Z", "revision":0,
            "nodes":[{"id":"first","kind":"process","x":0,"y":0,"text":"准备"},{"id":"second","kind":"decision","x":300,"y":0,"text":"通过？"}],
            "edges":[{"id":"forward","source":"first","target":"second","label":"开始","sourceHandle":"right","targetHandle":"left"},{"id":"back","source":"second","target":"first","label":"重试"}]
        })).unwrap()
    }
    fn create(vault: &Path) -> CanvasReadResult {
        create_in_vault(vault, "notes", "中文画布", fixture()).unwrap()
    }
    fn commits(vault: &Path) -> String {
        crate::run_git(vault, &["rev-list", "--all", "--count"])
            .unwrap()
            .trim()
            .into()
    }

    #[test]
    fn library_filename_flow_create_and_existing_long_name_save() {
        let dir = vault();
        let vault = dir.path();
        for (title, expected) in [
            ("字".repeat(65), "名称最多 64 个字符（不含扩展名）。"),
            ("😀".repeat(61), "名称占用空间过长，请减少部分字符。"),
        ] {
            let mut file = fixture();
            file.title = title.clone();
            assert_eq!(create_in_vault(vault, "notes", &title, file).unwrap_err(), expected);
        }
        let title = "😀".repeat(60);
        let mut file = fixture();
        file.title = title.clone();
        let created = create_in_vault(vault, "notes", &title, file).unwrap();
        assert_eq!(Path::new(&created.path).file_name().unwrap().len(), 255);
        let legacy_path = format!("notes/{}{FLOW_SUFFIX}", "a".repeat(240));
        fs::rename(vault.join(created.path), vault.join(&legacy_path)).unwrap();
        let legacy = read_in_vault(vault, &legacy_path).unwrap();
        let mut file = legacy.file;
        file.title = "长标题".repeat(30);
        file.nodes[0].text = "已修改".into();
        let saved = write_in_vault(
            vault, &legacy_path, file.clone(), file.revision, &legacy.last_saved_hash,
        ).unwrap();
        assert_eq!(saved.file.title, file.title);
        let reread = read_in_vault(vault, &legacy_path).unwrap();
        assert_eq!(reread.path, legacy_path);
        assert_eq!(reread.file.nodes[0].text, "已修改");
    }

    #[test]
    fn canvas_protocol_document_links_accept_legacy_alias_and_emit_camel_case() {
        for target_type in ["fragment", "map", "flow"] {
            for key in ["targetId", "target_id"] {
                let input =
                    json!({"id":"link-fixture", "targetType":target_type, key:"document-fixture"});
                let link: ShardDocumentLink = serde_json::from_value(input).unwrap();
                let serialized = serde_json::to_value(&link).unwrap();
                assert_eq!(
                    serialized,
                    json!({"id":"link-fixture", "targetType":target_type, "targetId":"document-fixture"})
                );
                assert!(serialized.get("target_id").is_none());
            }
            let ambiguous = json!({"id":"link-fixture", "targetType":target_type, "targetId":"document-a", "target_id":"document-b"});
            assert!(
                serde_json::from_value::<ShardDocumentLink>(ambiguous).is_err(),
                "both spellings must not choose an arbitrary target"
            );
        }
    }

    #[test]
    fn canvas_protocol_coordinates_survive_exact_json_round_trip() {
        let native_x: f64 = serde_json::from_str("463.52000000000004").unwrap();
        assert_eq!(
            native_x.to_bits(),
            463.52000000000004_f64.to_bits(),
            "native x must preserve its original IEEE-754 value"
        );
        // Native WKWebView pan/zoom yields fractional positions around these actual
        // acceptance coordinates. Adjacent representable values must retain all bits.
        for center in [463.52_f64, 249.65999999999997_f64, 298.5_f64, 244.25_f64] {
            for offset in 0..512 {
                let coordinate = f64::from_bits(center.to_bits() - 256 + offset);
                let mut file = fixture();
                file.nodes[0].x = coordinate;
                file.nodes[0].y = -coordinate;
                file.nodes[0].width = Some(coordinate);
                file.nodes[0].height = Some(coordinate);
                let encoded = serde_json::to_vec(&file).unwrap();
                let decoded: CanvasFile = serde_json::from_slice(&encoded).unwrap();
                assert_eq!(
                    decoded.nodes[0].x.to_bits(),
                    coordinate.to_bits(),
                    "x drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].y.to_bits(),
                    (-coordinate).to_bits(),
                    "y drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].width.unwrap().to_bits(),
                    coordinate.to_bits(),
                    "width drifted for {coordinate:?}"
                );
                assert_eq!(
                    decoded.nodes[0].height.unwrap().to_bits(),
                    coordinate.to_bits(),
                    "height drifted for {coordinate:?}"
                );
            }
        }
    }

    #[test]
    fn canvas_protocol_mind_map_optional_width_survives_real_save_and_rejects_invalid_sizes() {
        let directory = vault();
        let vault = directory.path();
        let created = crate::create_mind_map_in_vault(vault, "宽度兼容".into(), None).unwrap();
        let legacy = serde_json::to_value(&created.file).unwrap();
        assert!(legacy["nodes"][&created.file.root_id]
            .get("width")
            .is_none());
        let mut map: ShardMapFile = serde_json::from_value(legacy).unwrap();
        assert!(map.nodes[&map.root_id].width.is_none());
        for width in [0.0, -1.0, 10_001.0, f64::INFINITY, f64::NAN] {
            map.nodes.get_mut(&map.root_id).unwrap().width = Some(width);
            assert!(
                crate::validate_mind_map_file(vault, &map).is_err(),
                "invalid width accepted: {width}"
            );
        }
        map.nodes.get_mut(&map.root_id).unwrap().width = Some(244.25);
        let saved = crate::write_mind_map_in_vault(
            vault,
            &created.file.id,
            map,
            created.file.revision,
            &created.last_saved_hash,
        )
        .unwrap();
        let read = crate::read_mind_map_in_vault(vault, &created.file.id).unwrap();
        assert_eq!(read.file.nodes[&read.file.root_id].width, Some(244.25));
        assert_eq!(read.last_saved_hash, saved.last_saved_hash);
        assert_eq!(
            serde_json::to_value(&read.file).unwrap()["nodes"][&read.file.root_id]["width"],
            json!(244.25)
        );
    }

    #[test]
    fn canvas_create_save_read_and_checkpoint_without_embedded_commit() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        assert_eq!(created.path, "notes/中文画布.shardflow.json");
        assert_eq!(created.file.revision, 1);
        assert_eq!(commits(vault), "0");
        let retried = create(vault);
        assert_eq!(retried.path, created.path);
        assert_eq!(retried.last_saved_hash, created.last_saved_hash);
        let mut edit = created.file.clone();
        edit.nodes[0].text = "第一步完成".into();
        let saved =
            write_in_vault(vault, &created.path, edit, 1, &created.last_saved_hash).unwrap();
        assert_eq!(saved.file.revision, 2);
        assert_eq!(
            read_in_vault(vault, &created.path).unwrap().file.nodes[0].text,
            "第一步完成"
        );
        assert_eq!(commits(vault), "0");
        let backup = internal_path(
            vault,
            "last-good",
            &format!("{}.json", crate::hash_text(&saved.file.id)),
        )
        .unwrap();
        assert_eq!(
            read_bytes(&backup).unwrap(),
            read_bytes(&vault.join(&created.path)).unwrap()
        );
        assert_eq!(
            crate::checkpoint_vault_locked(vault, Some("画布检查点"))
                .unwrap()
                .status,
            "committed"
        );
        assert_eq!(commits(vault), "1");
    }

    #[test]
    fn canvas_library_rename_move_recycle_restore_preserves_identity_and_suffix() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        crate::checkpoint_before_structural_locked(vault);
        crate::rename_library_entry_in_vault(vault, &created.path, "改名画布").unwrap();
        let renamed = "notes/改名画布.shardflow.json";
        assert_eq!(
            create(vault).path,
            renamed,
            "创建重试找到重命名后的同一文档"
        );
        assert_eq!(
            read_in_vault(vault, renamed).unwrap().file.id,
            created.file.id
        );
        fs::create_dir(vault.join("notes/分类")).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        crate::move_library_entry_in_vault(vault, renamed, Some("notes/分类")).unwrap();
        let moved = "notes/分类/改名画布.shardflow.json";
        assert_eq!(
            read_in_vault(vault, moved).unwrap().last_saved_hash,
            created.last_saved_hash
        );
        let entries = crate::collect_library_entries(vault, &vault.join("notes/分类")).unwrap();
        assert!(entries.iter().any(|entry| entry.kind == "flowchart"));
        crate::checkpoint_before_structural_locked(vault);
        let trash = crate::move_to_trash_in_vault(vault, moved).unwrap();
        assert!(create_in_vault(vault, "notes", "中文画布", fixture())
            .unwrap_err()
            .contains("回收站"));
        let trashed = crate::relative_path(vault, &trash).unwrap();
        assert!(read_in_vault(vault, &trashed).is_err());
        assert!(
            crate::collect_library_entries(vault, trash.parent().unwrap())
                .unwrap()
                .iter()
                .any(|entry| entry.kind == "flowchart")
        );
        // A new document occupies the original path. Restore must retain both.
        let mut occupying = fixture();
        occupying.id = "another-canvas".into();
        occupying.title = "改名画布".into();
        create_in_vault(vault, "notes/分类", "改名画布", occupying).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        let restored = crate::restore_from_trash_in_vault(vault, &trashed).unwrap();
        let restored_relative = crate::relative_path(vault, &restored).unwrap();
        assert_ne!(restored_relative, moved);
        assert!(is_canvas(&restored));
        let read = read_in_vault(vault, &restored_relative).unwrap();
        assert_eq!(read.file.id, created.file.id);
        assert_eq!(read.last_saved_hash, created.last_saved_hash);
        assert_eq!(
            read_in_vault(vault, moved).unwrap().file.id,
            "another-canvas"
        );
    }

    #[test]
    fn canvas_checkpoint_excludes_only_exact_atomic_leftovers() {
        let directory = vault();
        let vault = directory.path();
        create(vault);
        let token = "a".repeat(32);
        let ignored = [
            format!("notes/.canvas.shardflow.json.canvas-tmp-{token}"),
            format!(".shard/canvas/last-good/.backup.json.canvas-tmp-{token}"),
        ];
        let retained = [
            "notes/.canvas.shardflow.json.canvas-tmp-short",
            ".shard/canvas/last-good/.backup.json.canvas-tmp-short",
            "notes/normal.json.canvas-tmp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ];
        for path in ignored.iter().map(String::as_str).chain(retained) {
            fs::write(vault.join(path), b"fixture").unwrap();
        }
        let dirty = crate::managed_dirty_paths(vault).unwrap();
        for path in &ignored {
            assert!(!dirty.contains(path), "temporary file was included: {path}");
        }
        for path in retained {
            assert!(dirty.contains(path), "ordinary file was excluded: {path}");
        }
        crate::checkpoint_vault_locked(vault, Some("临时文件范围")).unwrap();
        let tracked = crate::run_git(vault, &["ls-files"]).unwrap();
        for path in &ignored {
            assert!(!tracked.lines().any(|line| line == path));
        }
        for path in retained {
            assert!(
                tracked.lines().any(|line| line == path),
                "ordinary file was not staged: {path}"
            );
        }
    }

    #[test]
    fn canvas_conflicts_preserve_disk_and_every_draft() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut draft = created.file.clone();
        draft.nodes[0].text = "磁盘修改".into();
        write_in_vault(vault, &created.path, draft, 1, &created.last_saved_hash).unwrap();
        let expected = read_bytes(&vault.join(&created.path)).unwrap();
        for text in ["离线草稿一", "离线草稿二"] {
            let mut draft = created.file.clone();
            draft.nodes[0].text = text.into();
            let error = write_in_vault(vault, &created.path, draft, 1, &created.last_saved_hash)
                .unwrap_err();
            let copy = error.split('：').next_back().unwrap();
            assert!(error.contains("冲突副本"));
            assert!(read_file(vault, &vault.join(copy)).unwrap().file.nodes[0].text == text);
            assert_eq!(read_bytes(&vault.join(&created.path)).unwrap(), expected);
        }
        assert_eq!(
            fs::read_dir(vault.join(".shard/canvas/conflicts"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn canvas_lost_save_response_retry_returns_existing_revision() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut draft = created.file.clone();
        draft.nodes[0].text = "已写入但没有收到响应".into();
        let saved = write_in_vault(
            vault,
            &created.path,
            draft.clone(),
            1,
            &created.last_saved_hash,
        )
        .unwrap();
        let retry =
            write_in_vault(vault, &created.path, draft, 1, &created.last_saved_hash).unwrap();
        assert_eq!(retry.file.revision, 2);
        assert_eq!(retry.last_saved_hash, saved.last_saved_hash);
        assert!(!vault.join(".shard/canvas/conflicts").exists());
    }

    #[test]
    fn canvas_hash_detects_external_edit_without_revision_bump() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut external = created.file.clone();
        external.nodes[0].text = "外部编辑未更新版本".into();
        let bytes = canonical(&external).unwrap();
        fs::write(vault.join(&created.path), &bytes).unwrap();
        assert!(write_in_vault(
            vault,
            &created.path,
            created.file,
            1,
            &created.last_saved_hash
        )
        .unwrap_err()
        .contains("冲突"));
        assert_eq!(read_bytes(&vault.join(&created.path)).unwrap(), bytes);
    }

    #[test]
    #[cfg(unix)]
    fn canvas_recovery_failure_does_not_publish_primary_or_follow_symlinks() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let expected = read_bytes(&vault.join(&created.path)).unwrap();
        let backup = internal_path(
            vault,
            "last-good",
            &format!("{}.json", crate::hash_text(&created.file.id)),
        )
        .unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(&backup).unwrap();
        std::os::unix::fs::symlink(outside.path(), &backup).unwrap();
        let mut draft = created.file;
        draft.nodes[0].text = "不能发布".into();
        assert!(
            write_in_vault(vault, &created.path, draft, 1, &created.last_saved_hash)
                .unwrap_err()
                .contains("符号链接")
        );
        assert_eq!(read_bytes(&vault.join(&created.path)).unwrap(), expected);
        assert_eq!(fs::metadata(outside.path()).unwrap().len(), 0);
    }

    #[test]
    fn canvas_rejects_identity_reuse_duplicate_and_changed_target() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        let mut different = fixture();
        different.nodes[0].text = "另一个请求".into();
        assert!(create_in_vault(vault, "notes", "中文画布", different)
            .unwrap_err()
            .contains("不同的创建请求"));
        let mut impostor = created.file.clone();
        impostor.id = "unrelated".into();
        assert!(
            write_in_vault(vault, &created.path, impostor, 1, &created.last_saved_hash)
                .unwrap_err()
                .contains("身份")
        );
        fs::copy(
            vault.join(&created.path),
            vault.join("notes/复制.shardflow.json"),
        )
        .unwrap();
        assert!(read_in_vault(vault, &created.path)
            .unwrap_err()
            .contains("重复"));
        assert!(create_in_vault(vault, "notes", "中文画布", fixture())
            .unwrap_err()
            .contains("重复"));
    }

    #[test]
    fn canvas_rejects_paths_symlinks_and_missing_target_writes() {
        let directory = vault();
        let vault = directory.path();
        let created = create(vault);
        for path in [
            "../notes/x.shardflow.json",
            "/notes/x.shardflow.json",
            "notes/./x.shardflow.json",
            "notes/../notes/x.shardflow.json",
            "notes\\x.shardflow.json",
            "lockbox/x.shardflow.json",
            ".trash/notes/x.shardflow.json",
            "notes/.hidden/x.shardflow.json",
        ] {
            assert!(read_in_vault(vault, path).is_err(), "accepted {path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                vault.join(&created.path),
                vault.join("notes/别名.shardflow.json"),
            )
            .unwrap();
            assert!(read_in_vault(vault, "notes/别名.shardflow.json")
                .unwrap_err()
                .contains("符号链接"));
            std::os::unix::fs::symlink(vault.join("notes"), vault.join("notes/目录别名")).unwrap();
            assert!(
                create_in_vault(vault, "notes/目录别名", "中文画布", fixture())
                    .unwrap_err()
                    .contains("符号链接")
            );
        }
        fs::remove_file(vault.join(&created.path)).unwrap();
        assert!(write_in_vault(
            vault,
            &created.path,
            created.file,
            1,
            &created.last_saved_hash
        )
        .is_err());
        assert!(!vault.join(&created.path).exists());
    }

    #[test]
    fn canvas_validation_rejects_unknown_fields_invalid_graph_and_oversized_files() {
        let directory = vault();
        let vault = directory.path();
        let base = fixture();
        let mut invalid = base.clone();
        invalid.edges[0].target = "missing".into();
        assert!(validate_file(vault, &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[1].id = "first".into();
        assert!(validate_file(vault, &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].kind = "reference".into();
        assert!(validate_file(vault, &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].x = f64::INFINITY;
        assert!(validate_file(vault, &invalid).is_err());
        invalid = base.clone();
        invalid.nodes[0].width = Some(-1.0);
        assert!(validate_file(vault, &invalid).is_err());
        invalid = base.clone();
        invalid.edges[0].source_handle = Some("arbitrary".into());
        assert!(validate_file(vault, &invalid).is_err());
        let mut value = serde_json::to_value(&base).unwrap();
        value["unknown"] = json!(true);
        assert!(serde_json::from_value::<CanvasFile>(value).is_err());
        let path = vault.join("notes/huge.shardflow.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(read_bytes(&path).unwrap_err().contains("8 MiB"));
    }

    #[test]
    fn canvas_node_edge_and_embedded_total_limits_are_enforced() {
        let directory = vault();
        let vault = directory.path();
        let mut file = fixture();
        file.nodes = (0..401)
            .map(|index| {
                let mut node = file.nodes[0].clone();
                node.id = format!("n{index}");
                node
            })
            .collect();
        file.edges.clear();
        assert!(validate_file(vault, &file).is_err());
        let mut file = fixture();
        file.edges = (0..1601)
            .map(|index| {
                let mut edge = file.edges[0].clone();
                edge.id = format!("e{index}");
                edge
            })
            .collect();
        assert!(validate_file(vault, &file).is_err());
        let mut file = fixture();
        file.kind = "shard.canvas".into();
        file.edges.clear();
        let mut map = crate::create_mind_map_in_vault(vault, "节点上限".into(), None)
            .unwrap()
            .file;
        let root = map.nodes[&map.root_id].clone();
        map.nodes.retain(|id, _| id == &map.root_id);
        for index in 0..399 {
            let mut child = root.clone();
            child.id = format!("child{index}");
            child.parent_id = Some(map.root_id.clone());
            child.sort_key = format!("a{index:04}");
            map.nodes.insert(child.id.clone(), child);
        }
        file.nodes = (0..5)
            .map(|index| {
                let mut node = file.nodes[0].clone();
                node.id = format!("map{index}");
                node.kind = "mindmap".into();
                node.mind_map = Some(map.clone());
                node
            })
            .collect();
        assert!(validate_file(vault, &file).unwrap_err().contains("2000"));
        file.nodes.pop();
        validate_file(vault, &file).unwrap();
    }

    #[test]
    fn canvas_embedded_tree_and_missing_public_references_are_validated() {
        let directory = vault();
        let vault = directory.path();
        let map = crate::create_mind_map_in_vault(vault, "树".into(), None)
            .unwrap()
            .file;
        let mut file = fixture();
        file.kind = "shard.canvas".into();
        file.nodes[0].kind = "mindmap".into();
        file.nodes[0].mind_map = Some(map);
        validate_file(vault, &file).unwrap();
        let mut invalid = file.clone();
        let map = invalid.nodes[0].mind_map.as_mut().unwrap();
        map.nodes.get_mut(&map.root_id).unwrap().parent_id = Some("missing".into());
        assert!(validate_file(vault, &invalid).is_err());
        file.nodes[1].kind = "reference".into();
        file.nodes[1].link = Some(ShardDocumentLink::MarkdownPath {
            id: "ref".into(),
            path: "notes/deleted.md".into(),
        });
        validate_file(vault, &file).unwrap();
        let legacy_path = "notes/中文画布.shardcanvas.json";
        fs::write(vault.join(legacy_path), canonical(&file).unwrap()).unwrap();
        let created = read_in_vault(vault, legacy_path).unwrap();
        assert_eq!(
            read_in_vault(vault, &created.path)
                .unwrap()
                .file
                .nodes
                .len(),
            2
        );
        for path in [
            "lockbox/private.md",
            "notes/../lockbox/private.md",
            "notes/.internal/private.md",
        ] {
            file.nodes[1].link = Some(ShardDocumentLink::MarkdownPath {
                id: "ref".into(),
                path: path.into(),
            });
            assert!(validate_file(vault, &file).is_err());
        }
        fs::create_dir_all(vault.join("lockbox/fragments")).unwrap();
        fs::write(
            vault.join("lockbox/fragments/private.shard"),
            br#"{"id":"secret-fragment"}"#,
        )
        .unwrap();
        file.nodes[1].link = Some(ShardDocumentLink::Fragment {
            id: "ref".into(),
            target_id: "secret-fragment".into(),
        });
        assert!(validate_file(vault, &file).unwrap_err().contains("密匣"));
        file.nodes[1].link = Some(ShardDocumentLink::Fragment {
            id: "ref".into(),
            target_id: "missing-public-fragment".into(),
        });
        validate_file(vault, &file).unwrap();
    }
}
