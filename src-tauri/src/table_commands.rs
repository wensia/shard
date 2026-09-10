//! Tauri boundary for public native tables. All filesystem/Git work runs off the UI thread.
use crate::table::{self, *};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

fn error(code: &str, message: impl Into<String>) -> TableError {
    TableError::new(code, message, "")
}
fn io(error: impl ToString) -> TableError {
    self::error("IO_ERROR", error.to_string())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
async fn background<T: Send + 'static>(
    task: impl FnOnce() -> TableResult<T> + Send + 'static,
) -> TableResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(io)?
}

pub(crate) fn is_table(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !name.starts_with('.') && name.ends_with(".shardtable.json"))
}

/// Reject symlink components, including aliases that still point inside notes.
fn public_path(vault: &Path, relative: &str, directory: bool) -> TableResult<PathBuf> {
    if relative.contains('\\') || relative.split('/').any(|part| part == "." || part == "..") {
        return Err(error("INVALID_PATH", "数据表路径必须使用 / 分隔"));
    }
    let path = Path::new(relative);
    if !matches!(path.components().next(), Some(Component::Normal(root)) if root == "notes") {
        return Err(error("INVALID_PATH", "数据表只能位于公开资料库 notes 目录"));
    }
    let mut target = vault.to_path_buf();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(error("INVALID_PATH", "数据表路径无效"));
        };
        target.push(part);
        let meta = fs::symlink_metadata(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                error("NOT_FOUND", "数据表或目录已不存在")
            } else {
                io(e)
            }
        })?;
        if meta.file_type().is_symlink() {
            return Err(error("INVALID_PATH", "数据表路径不能包含符号链接"));
        }
    }
    let root = vault.join("notes").canonicalize().map_err(io)?;
    let canonical = target.canonicalize().map_err(io)?;
    if !canonical.starts_with(root)
        || (directory && !target.is_dir())
        || (!directory && (!target.is_file() || !is_table(&target)))
    {
        return Err(error("INVALID_PATH", "数据表路径或文件类型无效"));
    }
    Ok(target)
}

fn relative_result(
    vault: &Path,
    path: &Path,
    mut result: TableReadResult,
) -> TableResult<TableReadResult> {
    result.path = crate::relative_path(vault, path).map_err(io)?;
    Ok(result)
}

fn scan_tables(root: &Path, output: &mut Vec<PathBuf>, visited: &mut usize) -> TableResult<()> {
    if !root.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(root)
        .map_err(io)?
        .file_type()
        .is_symlink()
    {
        return Err(error("INVALID_PATH", "表格身份检查遇到符号链接目录"));
    }
    for entry in fs::read_dir(root).map_err(io)? {
        let entry = entry.map_err(io)?;
        *visited += 1;
        if *visited > 100_000 {
            return Err(error("LIMIT_EXCEEDED", "资料库条目超过本次身份检查上限"));
        }
        let kind = entry.file_type().map_err(io)?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scan_tables(&entry.path(), output, visited)?;
        } else if kind.is_file() && is_table(&entry.path()) {
            output.push(entry.path());
        }
    }
    Ok(())
}

/// Low-frequency creation/open check. Never used to locate a target by row position.
fn identity_matches(
    vault: &Path,
    id: &str,
    request_id: Option<&str>,
    already_read: Option<&Path>,
) -> TableResult<Vec<(PathBuf, TableReadResult)>> {
    let mut paths = Vec::new();
    let mut visited = 0;
    scan_tables(&vault.join("notes"), &mut paths, &mut visited)?;
    let trash = vault.join(".trash");
    if trash.exists()
        && fs::symlink_metadata(&trash)
            .map_err(io)?
            .file_type()
            .is_symlink()
    {
        return Err(error("INVALID_PATH", "表格身份检查不允许符号链接回收站"));
    }
    scan_tables(&trash.join("notes"), &mut paths, &mut visited)?;
    let mut matches = Vec::new();
    for path in paths {
        // The caller already strictly parsed this exact path and checked its identity.
        // Keep checking all other paths for duplicates without parsing the target twice.
        if already_read == Some(path.as_path()) {
            continue;
        }
        // A malformed unrelated file remains visible as its own read error. Its unknown
        // identity cannot prove a duplicate; it must not disable every healthy table.
        let Ok(identity) =
            table::storage::probe_table_file_identity(&path, &TableLimits::default())
        else {
            continue;
        };
        if identity.table_id == id
            || request_id.is_some_and(|request| identity.request_id.as_deref() == Some(request))
        {
            let result =
                read_table_file(&path, None, &TableLimits::default()).map_err(|mut e| {
                    e.message = format!(
                        "{}：{}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        e.message
                    );
                    e
                })?;
            matches.push((path, result));
        }
    }
    if matches.len() + usize::from(already_read.is_some()) > 1 {
        return Err(error(
            "DUPLICATE_TABLE_ID",
            "发现重复的表格或创建请求 ID，请先处理重复文件",
        ));
    }
    Ok(matches)
}

fn existing_creation(
    vault: &Path,
    table_id: &str,
    request_id: &str,
    payload_hash: &str,
) -> TableResult<Option<TableReadResult>> {
    let Some((path, result)) = identity_matches(vault, table_id, Some(request_id), None)?.pop()
    else {
        return Ok(None);
    };
    if result.file.id != table_id
        || result.file.creation.request_id != request_id
        || result.file.creation.payload_hash != payload_hash
    {
        return Err(error(
            "IDEMPOTENCY_CONFLICT",
            "同一个创建请求对应不同的数据，请保留原请求后重试",
        ));
    }
    if path.starts_with(vault.join(".trash")) {
        return Err(error("TARGET_IN_TRASH", "此创建请求的表格已在回收站中"));
    }
    relative_result(vault, &path, result).map(Some)
}

pub(crate) fn create_in_vault(
    vault: &Path,
    request: &CreateTableRequest,
) -> TableResult<TableReadResult> {
    crate::ensure_no_unfinished_git_operation(vault).map_err(|e| error("GIT_BUSY", e))?;
    let payload = table::storage::create_payload_hash(request)?;
    if let Some(result) =
        existing_creation(vault, &request.table_id, &request.request_id, &payload)?
    {
        return Ok(result);
    }
    let directory = public_path(vault, &request.parent_path, true)?;
    let title = crate::validate_library_file_name(&request.suggested_name, ".shardtable.json")
        .map_err(|e| error("INVALID_PATH", e))?;
    let path = crate::unique_titled_path(
        &directory,
        title.trim_end_matches(".shardtable.json"),
        ".shardtable.json",
    );
    relative_result(
        vault,
        &path,
        create_at_path(&path, request, &now(), &TableLimits::default())?,
    )
}

pub(crate) fn read_in_vault(
    vault: &Path,
    request: &ReadTableRequest,
) -> TableResult<TableReadResult> {
    let path = public_path(vault, &request.path, false)?;
    let result = read_table_file(
        &path,
        request.expected_table_id.as_deref(),
        &TableLimits::default(),
    )?;
    identity_matches(vault, &result.file.id, None, Some(&path))?;
    relative_result(vault, &path, result)
}

pub(crate) fn apply_in_vault(
    vault: &Path,
    request: &ApplyTableMutationsRequest,
) -> TableResult<ApplyTableMutationsResult> {
    crate::ensure_no_unfinished_git_operation(vault).map_err(|e| error("GIT_BUSY", e))?;
    let path = public_path(vault, &request.path, false)?;
    apply_to_file(&path, request, &now(), &TableLimits::default())
}

fn request_bytes(request: &tauri::ipc::Request<'_>) -> TableResult<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= 64 * 1024 * 1024 => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Raw(_) => Err(error("LIMIT_EXCEEDED", "数据表请求超过 64 MiB")),
        _ => Err(error("INVALID_VALUE", "数据表请求需要二进制 JSON")),
    }
}
fn response(value: impl serde::Serialize) -> TableResult<tauri::ipc::Response> {
    serde_json::to_vec(&value)
        .map(tauri::ipc::Response::new)
        .map_err(io)
}

#[tauri::command]
pub async fn create_table(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> TableResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    background(move || {
        let request: CreateTableRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app).map_err(io)?;
        let _gate = crate::lock_vault_gate(&vault);
        response(create_in_vault(&vault, &request)?)
    })
    .await
}
#[tauri::command]
pub async fn read_table(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> TableResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    background(move || {
        let request: ReadTableRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::configured_vault_path(&app).map_err(io)?;
        response(read_in_vault(&vault, &request)?)
    })
    .await
}
#[tauri::command]
pub async fn apply_table_mutations(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> TableResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    background(move || {
        let request: ApplyTableMutationsRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app).map_err(io)?;
        let _gate = crate::lock_vault_gate(&vault);
        response(apply_in_vault(&vault, &request)?)
    })
    .await
}
#[tauri::command]
pub async fn save_table_copy(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> TableResult<tauri::ipc::Response> {
    let bytes = request_bytes(&request)?;
    background(move || {
        let request: SaveTableCopyRequest = serde_json::from_slice(&bytes).map_err(io)?;
        let vault = crate::ensure_vault_dirs(&app).map_err(io)?;
        let _gate = crate::lock_vault_gate(&vault);
        crate::ensure_no_unfinished_git_operation(&vault).map_err(|e| error("GIT_BUSY", e))?;
        let payload = table::storage::create_payload_hash(&request)?;
        if let Some(result) =
            existing_creation(&vault, &request.table_id, &request.request_id, &payload)?
        {
            return response(result);
        }
        let directory = public_path(&vault, &request.parent_path, true)?;
        let title = crate::validate_library_file_name(&request.suggested_name, ".shardtable.json")
            .map_err(|e| error("INVALID_PATH", e))?;
        let path = crate::unique_titled_path(
            &directory,
            title.trim_end_matches(".shardtable.json"),
            ".shardtable.json",
        );
        response(relative_result(
            &vault,
            &path,
            table::storage::create_copy_at_path(&path, &request, &now(), &TableLimits::default())?,
        )?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::ensure_vault_layout(dir.path()).unwrap();
        crate::run_git(dir.path(), &["init", "--initial-branch=main"]).unwrap();
        crate::run_git(dir.path(), &["config", "user.name", "Table fixture"]).unwrap();
        crate::run_git(
            dir.path(),
            &["config", "user.email", "table-fixture@example.invalid"],
        )
        .unwrap();
        crate::run_git(dir.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        crate::run_git(
            dir.path(),
            &["config", "core.hooksPath", ".disabled-test-hooks"],
        )
        .unwrap();
        dir
    }
    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/tables")
            .join(name)
    }
    fn create_request(seed: u32, title: &str, directory: &str) -> CreateTableRequest {
        let bytes = fs::read(fixture_path("valid/six-types.json")).unwrap();
        let file = table::validation::parse_table_bytes(&bytes, &TableLimits::default()).unwrap();
        CreateTableRequest {
            request_id: format!("req_{seed:032x}"),
            table_id: format!("tbl_{seed:032x}"),
            parent_path: directory.into(),
            suggested_name: title.into(),
            content: file.content(),
        }
    }
    fn read_request(path: &str, id: &str) -> ReadTableRequest {
        ReadTableRequest {
            path: path.into(),
            expected_table_id: Some(id.into()),
        }
    }
    fn edit_request(read: &TableReadResult, seed: u32, value: f64) -> ApplyTableMutationsRequest {
        ApplyTableMutationsRequest {
            path: read.path.clone(),
            table_id: read.file.id.clone(),
            expected_revision: read.revision,
            expected_hash: read.content_hash.clone(),
            mutation_id: format!("mut_{seed:032x}"),
            operations: vec![TableMutation::SetCells {
                cells: vec![CellEdit {
                    record_id: format!("rec_{:032x}", 1),
                    field_id: format!("fld_{:032x}", 2),
                    value: CellValue::Number(value),
                }],
            }],
        }
    }
    fn commits(vault: &Path) -> u32 {
        crate::run_git(vault, &["rev-list", "--all", "--count"])
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[test]
    fn library_filename_table_create_and_existing_long_name_save() {
        let dir = vault();
        let vault = dir.path();
        let oversized = create_request(901, &"字".repeat(65), "notes");
        assert_eq!(
            create_in_vault(vault, &oversized).unwrap_err().message,
            "名称最多 64 个字符（不含扩展名）。"
        );
        let oversized_bytes = create_request(902, &"😀".repeat(60), "notes");
        assert_eq!(
            create_in_vault(vault, &oversized_bytes).unwrap_err().message,
            "名称占用空间过长，请减少部分字符。"
        );
        let title = format!("{}abc.shardtable.json", "😀".repeat(59));
        let created = create_in_vault(vault, &create_request(903, &title, "notes")).unwrap();
        assert_eq!(Path::new(&created.path).file_name().unwrap().len(), 255);
        apply_in_vault(vault, &edit_request(&created, 903, 42.0)).unwrap();
        let legacy_path = format!("notes/{}.shardtable.json", "a".repeat(239));
        fs::rename(vault.join(&created.path), vault.join(&legacy_path)).unwrap();
        let legacy = read_in_vault(vault, &read_request(&legacy_path, &created.file.id)).unwrap();
        let saved = apply_in_vault(vault, &edit_request(&legacy, 904, 43.0)).unwrap();
        let reread = read_in_vault(vault, &read_request(&legacy_path, &created.file.id)).unwrap();
        assert_eq!(reread.path, legacy_path);
        assert_eq!(reread.revision, saved.revision);
        assert_eq!(reread.content_hash, saved.content_hash);
    }

    #[test]
    fn native_table_complete_vault_git_and_recycle_lifecycle() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let request = create_request(101, "中文任务表", "notes");
        let created = create_in_vault(vault, &request).unwrap();
        assert_eq!(created.path, "notes/中文任务表.shardtable.json");
        assert_eq!(commits(vault), 0, "创建不应内嵌 commit");
        let saved = apply_in_vault(vault, &edit_request(&created, 101, 25.0)).unwrap();
        assert_eq!(commits(vault), 0, "单元格保存不应内嵌 commit");
        assert!(crate::managed_dirty_paths(vault)
            .unwrap()
            .contains(&created.path));
        let checked = crate::checkpoint_vault_locked(vault, Some("表格测试")).unwrap();
        assert_eq!(checked.status, "committed");
        assert_eq!(commits(vault), 1);
        assert!(crate::managed_dirty_paths(vault).unwrap().is_empty());

        crate::checkpoint_before_structural_locked(vault);
        crate::rename_library_entry_in_vault(vault, &created.path, "重命名任务").unwrap();
        let renamed = "notes/重命名任务.shardtable.json";
        let after_rename = read_in_vault(vault, &read_request(renamed, &created.file.id)).unwrap();
        assert_eq!(after_rename.title, "重命名任务");
        assert_eq!(after_rename.content_hash, saved.content_hash);
        assert_eq!(commits(vault), 2);

        fs::create_dir(vault.join("notes/分类")).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        crate::move_library_entry_in_vault(vault, renamed, Some("notes/分类")).unwrap();
        let moved = "notes/分类/重命名任务.shardtable.json";
        let after_move = read_in_vault(vault, &read_request(moved, &created.file.id)).unwrap();
        assert_eq!(after_move.file.id, created.file.id);
        assert_eq!(commits(vault), 3);

        crate::checkpoint_before_structural_locked(vault);
        let trashed = crate::move_to_trash_in_vault(vault, moved).unwrap();
        let trash_relative = crate::relative_path(vault, &trashed).unwrap();
        assert!(!vault.join(moved).exists());
        assert_eq!(commits(vault), 4);
        assert_eq!(
            create_in_vault(vault, &request).unwrap_err().code,
            "TARGET_IN_TRASH"
        );
        assert_eq!(
            read_in_vault(vault, &read_request(&trash_relative, &created.file.id))
                .unwrap_err()
                .code,
            "INVALID_PATH"
        );
        let trash_entries =
            crate::collect_library_entries(vault, trashed.parent().unwrap()).unwrap();
        assert!(trash_entries.iter().any(|entry| entry.kind == "table"));

        // An unrelated new table may occupy the old path. Restore must preserve both.
        let occupying =
            create_in_vault(vault, &create_request(102, "重命名任务", "notes/分类")).unwrap();
        assert_eq!(occupying.path, moved);
        crate::checkpoint_before_structural_locked(vault);
        let restored_path = crate::restore_from_trash_in_vault(vault, &trash_relative).unwrap();
        let restored_relative = crate::relative_path(vault, &restored_path).unwrap();
        assert!(is_table(&restored_path));
        assert_ne!(restored_relative, moved);
        let restored =
            read_in_vault(vault, &read_request(&restored_relative, &created.file.id)).unwrap();
        assert_eq!(restored.file.id, created.file.id);
        assert_eq!(restored.content_hash, saved.content_hash);
        assert_eq!(
            read_in_vault(vault, &read_request(moved, &occupying.file.id))
                .unwrap()
                .file
                .id,
            occupying.file.id
        );
        assert!(crate::managed_dirty_paths(vault).unwrap().is_empty());
        let entries = crate::collect_library_entries(vault, &vault.join("notes/分类")).unwrap();
        assert_eq!(
            entries.iter().filter(|entry| entry.kind == "table").count(),
            2
        );
    }

    #[test]
    fn native_table_stale_missing_and_invalid_writes_preserve_disk() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let created = create_in_vault(vault, &create_request(201, "保存保护", "notes")).unwrap();
        let old = edit_request(&created, 201, 7.0);
        apply_in_vault(vault, &old).unwrap();
        let current = fs::read(vault.join(&created.path)).unwrap();
        let mut stale = old;
        stale.mutation_id = format!("mut_{:032x}", 202);
        assert_eq!(
            apply_in_vault(vault, &stale).unwrap_err().code,
            "STALE_BASE"
        );
        assert_eq!(fs::read(vault.join(&created.path)).unwrap(), current);
        let read = read_in_vault(vault, &read_request(&created.path, &created.file.id)).unwrap();
        let mut invalid = edit_request(&read, 203, 8.0);
        invalid.operations.push(TableMutation::SetCells {
            cells: vec![CellEdit {
                record_id: format!("rec_{:032x}", 1),
                field_id: format!("fld_{:032x}", 6),
                value: CellValue::Text("false".into()),
            }],
        });
        assert_eq!(
            apply_in_vault(vault, &invalid).unwrap_err().code,
            "INVALID_VALUE"
        );
        assert_eq!(fs::read(vault.join(&created.path)).unwrap(), current);
        fs::remove_file(vault.join(&created.path)).unwrap();
        assert_eq!(
            apply_in_vault(vault, &invalid).unwrap_err().code,
            "NOT_FOUND"
        );
        assert!(!vault.join(&created.path).exists());
        assert_eq!(commits(vault), 0);
    }

    #[test]
    fn native_table_bad_neighbor_does_not_block_healthy_table_and_duplicates_are_detected() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let created = create_in_vault(vault, &create_request(301, "健康表", "notes")).unwrap();
        fs::write(vault.join("notes/坏文件.shardtable.json"), b"{bad-json").unwrap();
        fs::copy(
            fixture_path("invalid/unsupported-schema.json"),
            vault.join("notes/未来表.shardtable.json"),
        )
        .unwrap();
        assert_eq!(
            read_in_vault(vault, &read_request(&created.path, &created.file.id))
                .unwrap()
                .file
                .id,
            created.file.id
        );
        let second = create_in_vault(vault, &create_request(302, "另一张健康表", "notes")).unwrap();
        assert_ne!(second.file.id, created.file.id);
        assert_eq!(
            read_in_vault(
                vault,
                &ReadTableRequest {
                    path: "notes/坏文件.shardtable.json".into(),
                    expected_table_id: None
                }
            )
            .unwrap_err()
            .code,
            "INVALID_JSON"
        );
        assert_eq!(
            read_in_vault(
                vault,
                &ReadTableRequest {
                    path: "notes/未来表.shardtable.json".into(),
                    expected_table_id: None
                }
            )
            .unwrap_err()
            .code,
            "UNSUPPORTED_VERSION"
        );
        fs::copy(
            vault.join(&created.path),
            vault.join("notes/外部同身份副本.shardtable.json"),
        )
        .unwrap();
        let before = fs::read(vault.join(&created.path)).unwrap();
        assert_eq!(
            read_in_vault(vault, &read_request(&created.path, &created.file.id))
                .unwrap_err()
                .code,
            "DUPLICATE_TABLE_ID"
        );
        assert_eq!(
            create_in_vault(vault, &create_request(301, "健康表", "notes"))
                .unwrap_err()
                .code,
            "DUPLICATE_TABLE_ID"
        );
        assert_eq!(fs::read(vault.join(&created.path)).unwrap(), before);
    }

    #[test]
    fn native_table_create_retry_finds_actual_path_after_rename() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let request = create_request(401, "原名", "notes");
        let created = create_in_vault(vault, &request).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        crate::rename_library_entry_in_vault(vault, &created.path, "新名").unwrap();
        let retry = create_in_vault(vault, &request).unwrap();
        assert_eq!(retry.file.id, created.file.id);
        assert_eq!(retry.path, "notes/新名.shardtable.json");
        let mut changed = request;
        changed.suggested_name = "另一个逻辑请求".into();
        assert_eq!(
            create_in_vault(vault, &changed).unwrap_err().code,
            "IDEMPOTENCY_CONFLICT"
        );
        assert_eq!(
            crate::collect_library_entries(vault, &vault.join("notes"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn native_table_rejects_non_public_and_ambiguous_paths() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let created = create_in_vault(vault, &create_request(501, "路径保护", "notes")).unwrap();
        for path in [
            "../notes/路径保护.shardtable.json",
            "/notes/路径保护.shardtable.json",
            "lockbox/路径保护.shardtable.json",
            ".trash/notes/路径保护.shardtable.json",
            "notes\\路径保护.shardtable.json",
            "notes/./路径保护.shardtable.json",
        ] {
            assert_eq!(
                read_in_vault(vault, &read_request(path, &created.file.id))
                    .unwrap_err()
                    .code,
                "INVALID_PATH",
                "{path}"
            );
        }
        assert_eq!(
            read_in_vault(
                vault,
                &read_request(&created.path, &format!("tbl_{:032x}", 999))
            )
            .unwrap_err()
            .code,
            "IDENTITY_MISMATCH"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_table_rejects_symlink_file_and_directory_even_inside_notes() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let created =
            create_in_vault(vault, &create_request(601, "符号链接保护", "notes")).unwrap();
        std::os::unix::fs::symlink(
            vault.join(&created.path),
            vault.join("notes/别名.shardtable.json"),
        )
        .unwrap();
        assert_eq!(
            read_in_vault(
                vault,
                &read_request("notes/别名.shardtable.json", &created.file.id)
            )
            .unwrap_err()
            .code,
            "INVALID_PATH"
        );
        std::os::unix::fs::symlink(vault.join("notes"), vault.join("notes/内部别名")).unwrap();
        assert_eq!(
            read_in_vault(
                vault,
                &read_request(
                    "notes/内部别名/符号链接保护.shardtable.json",
                    &created.file.id
                )
            )
            .unwrap_err()
            .code,
            "INVALID_PATH"
        );
        assert_eq!(
            create_in_vault(vault, &create_request(602, "不应创建", "notes/内部别名"))
                .unwrap_err()
                .code,
            "INVALID_PATH"
        );
    }

    #[test]
    fn native_table_syncs_two_checkouts_and_preserves_both_sides_on_conflict() {
        let remote_dir = tempfile::tempdir().unwrap();
        let remote = remote_dir.path().join("remote.git");
        let second = remote_dir.path().join("second");
        crate::run_command(
            std::process::Command::new("git")
                .args(["init", "--bare", "--initial-branch=main"])
                .arg(&remote),
        )
        .unwrap();
        let first_dir = vault();
        let first = first_dir.path();
        let created = {
            let _gate = crate::lock_vault_gate(first);
            create_in_vault(first, &create_request(701, "同步验收", "notes")).unwrap()
        };
        crate::run_git(
            first,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .unwrap();
        crate::push_vault(first).unwrap();
        assert_eq!(
            commits(first),
            1,
            "sync checkpoints previously uncommitted table"
        );
        crate::run_command(
            std::process::Command::new("git")
                .arg("clone")
                .arg(&remote)
                .arg(&second),
        )
        .unwrap();
        crate::ensure_vault_layout(&second).unwrap();
        crate::ensure_git_identity(&second).unwrap();
        crate::run_git(&second, &["config", "commit.gpgsign", "false"]).unwrap();
        crate::run_git(
            &second,
            &["config", "core.hooksPath", ".disabled-test-hooks"],
        )
        .unwrap();
        let target = read_request(&created.path, &created.file.id);
        let first_bytes = fs::read(first.join(&created.path)).unwrap();
        assert_eq!(fs::read(second.join(&created.path)).unwrap(), first_bytes);

        {
            let _gate = crate::lock_vault_gate(&second);
            let read = read_in_vault(&second, &target).unwrap();
            apply_in_vault(&second, &edit_request(&read, 702, 25.0)).unwrap();
        }
        crate::push_vault(&second).unwrap();
        crate::push_vault(first).unwrap();
        let shared = read_in_vault(first, &target).unwrap();
        assert_eq!(shared.revision, 2);
        assert_eq!(
            fs::read(first.join(&created.path)).unwrap(),
            fs::read(second.join(&created.path)).unwrap()
        );
        assert_eq!(shared.file.id, created.file.id);

        // Both checkouts change the same cell from the same confirmed revision.
        {
            let _gate = crate::lock_vault_gate(first);
            apply_in_vault(first, &edit_request(&shared, 703, 37.0)).unwrap();
        }
        let local_bytes = fs::read(first.join(&created.path)).unwrap();
        {
            let _gate = crate::lock_vault_gate(&second);
            let read = read_in_vault(&second, &target).unwrap();
            apply_in_vault(&second, &edit_request(&read, 704, 91.0)).unwrap();
        }
        crate::push_vault(&second).unwrap();
        let remote_bytes = fs::read(second.join(&created.path)).unwrap();
        let remote_head = crate::run_git(&second, &["rev-parse", "HEAD"]).unwrap();
        let error = crate::push_vault(first).unwrap_err();
        assert!(error.contains("Git 冲突"), "{error}");
        assert_eq!(fs::read(first.join(&created.path)).unwrap(), local_bytes);
        assert_eq!(fs::read(second.join(&created.path)).unwrap(), remote_bytes);
        assert_ne!(local_bytes, remote_bytes);
        assert!(
            !crate::has_rebase_in_progress(first),
            "failed rebase restores local checkout"
        );
        assert!(
            crate::managed_dirty_paths(first).unwrap().is_empty(),
            "local edit remains committed"
        );
        let local_committed =
            crate::run_git(first, &["show", &format!("HEAD:{}", created.path)]).unwrap();
        assert_eq!(local_committed.as_bytes(), local_bytes);
        assert_eq!(
            crate::run_git(first, &["rev-parse", "origin/main"]).unwrap(),
            remote_head
        );
        assert_eq!(
            crate::run_git(&second, &["rev-parse", "HEAD"]).unwrap(),
            remote_head
        );
        assert_eq!(read_in_vault(first, &target).unwrap().revision, 3);
        assert_eq!(read_in_vault(&second, &target).unwrap().revision, 3);
    }

    #[test]
    fn native_table_purge_commits_only_trash_path_and_keeps_unrelated_index() {
        let dir = vault();
        let vault = dir.path();
        let _gate = crate::lock_vault_gate(vault);
        let created = create_in_vault(vault, &create_request(801, "purge-check", "notes")).unwrap();
        crate::checkpoint_before_structural_locked(vault);
        let trashed = crate::move_to_trash_in_vault(vault, &created.path).unwrap();
        let trash_path = crate::relative_path(vault, &trashed).unwrap();
        fs::write(vault.join("personal.txt"), "unrelated staged work\n").unwrap();
        crate::run_git(vault, &["add", "personal.txt"]).unwrap();
        let before = commits(vault);
        crate::checkpoint_before_structural_locked(vault);
        crate::purge_from_trash_in_vault(vault, &trash_path).unwrap();
        assert!(!trashed.exists());
        assert!(!vault.join(&created.path).exists());
        assert_eq!(commits(vault), before + 1);
        let committed =
            crate::run_git(vault, &["show", "--format=", "--name-only", "HEAD"]).unwrap();
        assert_eq!(committed.trim(), trash_path);
        assert_eq!(
            crate::run_git(vault, &["diff", "--cached", "--name-only"])
                .unwrap()
                .trim(),
            "personal.txt"
        );
        assert!(crate::managed_dirty_paths(vault).unwrap().is_empty());
        assert_eq!(
            read_in_vault(vault, &read_request(&created.path, &created.file.id))
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
    }
}
