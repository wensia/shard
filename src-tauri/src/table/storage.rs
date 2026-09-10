use super::{model::*, mutations::prepare_parsed_mutations, validation::*};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn canonical_bytes<T: Serialize>(value: &T) -> TableResult<Vec<u8>> {
    // Value maps use sorted keys even when typed structs declare fields in a different order.
    let mut value = serde_json::to_value(value)
        .map_err(|err| TableError::new("INVALID_MODEL", err.to_string(), ""))?;
    sort_object_keys(&mut value);
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|err| TableError::new("INVALID_MODEL", err.to_string(), ""))?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn sort_object_keys(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            let ordered = std::mem::take(object)
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>();
            for (key, mut value) in ordered {
                sort_object_keys(&mut value);
                object.insert(key, value);
            }
        }
        serde_json::Value::Array(values) => values.iter_mut().for_each(sort_object_keys),
        _ => {}
    }
}
pub fn create_payload_hash<T: Serialize>(request: &T) -> TableResult<String> {
    Ok(sha256(&canonical_bytes(request)?))
}
pub fn mutation_payload_hash(request: &ApplyTableMutationsRequest) -> TableResult<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        table_id: &'a str,
        expected_revision: u64,
        expected_hash: &'a str,
        operations: &'a [TableMutation],
    }
    create_payload_hash(&Payload {
        table_id: &request.table_id,
        expected_revision: request.expected_revision,
        expected_hash: &request.expected_hash,
        operations: &request.operations,
    })
}
fn io_error(err: std::io::Error) -> TableError {
    let code = if err.kind() == std::io::ErrorKind::NotFound {
        "NOT_FOUND"
    } else {
        "IO_ERROR"
    };
    TableError::new(code, err.to_string(), "")
}
fn read_bytes(path: &Path, limits: &TableLimits) -> TableResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(TableError::new("INVALID_PATH", "目标必须是普通表文件", ""));
    }
    if metadata.len() > limits.max_file_bytes as u64 {
        return Err(TableError::new("LIMIT_EXCEEDED", "文件超过字节上限", ""));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io_error)?
        .take(limits.max_file_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > limits.max_file_bytes {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "读取期间文件超过字节上限",
            "",
        ));
    }
    Ok(bytes)
}
fn table_title(path: &Path) -> TableResult<&str> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".shardtable.json"))
        .filter(|title| !title.is_empty())
        .ok_or_else(|| TableError::new("INVALID_PATH", "文件名必须使用完整表后缀", ""))
}
fn read_result(path: &Path, file: TableFile, bytes: &[u8]) -> TableResult<TableReadResult> {
    let title = table_title(path)?;
    Ok(TableReadResult {
        revision: file.revision,
        content_hash: sha256(bytes),
        path: path.to_string_lossy().into_owned(),
        title: title.into(),
        file,
    })
}
/// The wrapper supplies a validated public path; this function never scans a vault.
pub fn read_table_file(
    path: &Path,
    expected_id: Option<&str>,
    limits: &TableLimits,
) -> TableResult<TableReadResult> {
    let (file, bytes) = read_parsed_file(path, expected_id, limits)?;
    read_result(path, file.into_file(), &bytes)
}
fn read_parsed_file(
    path: &Path,
    expected_id: Option<&str>,
    limits: &TableLimits,
) -> TableResult<(ParsedTableFile, Vec<u8>)> {
    let bytes = read_bytes(path, limits)?;
    let file = parse_validated_table_bytes(&bytes, limits)?;
    if expected_id.is_some_and(|id| id != file.file().id) {
        return Err(TableError::new(
            "IDENTITY_MISMATCH",
            "目标表身份已变化",
            "/id",
        ));
    }
    table_title(path)?;
    Ok((file, bytes))
}

pub fn probe_table_file_identity(path: &Path, limits: &TableLimits) -> TableResult<TableIdentity> {
    probe_table_identity(&read_bytes(path, limits)?, limits)
}

struct TempGuard(PathBuf);
impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn write_atomically(path: &Path, bytes: &[u8], create: bool) -> TableResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| TableError::new("INVALID_PATH", "文件缺少父目录", ""))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| TableError::new("INVALID_PATH", "文件名无效", ""))?;
    if !name.ends_with(".shardtable.json") {
        return Err(TableError::new(
            "INVALID_PATH",
            "文件名必须使用完整表后缀",
            "",
        ));
    }
    // Do not create directories: only the already-authorized library wrapper may do so.
    let mut nonce = [0u8; 16];
    OsRng.fill_bytes(&mut nonce);
    let suffix = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temp = TempGuard(parent.join(crate::temporary_filename(
        name,
        &format!(".table-tmp-{suffix}"),
    )));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    if create {
        // Atomic no-clobber installation; an external race cannot overwrite an existing target.
        fs::hard_link(&temp.0, path).map_err(io_error)?;
    } else {
        fs::rename(&temp.0, path).map_err(io_error)?;
    }
    drop(temp);
    if let Ok(parent) = File::open(parent) {
        let _ = parent.sync_all();
    }
    Ok(())
}

pub fn apply_to_file(
    path: &Path,
    request: &ApplyTableMutationsRequest,
    now: &str,
    limits: &TableLimits,
) -> TableResult<ApplyTableMutationsResult> {
    let (current, original_bytes) = read_parsed_file(path, Some(&request.table_id), limits)?;
    let prepared = prepare_parsed_mutations(&current, &sha256(&original_bytes), request, now)?;
    write_atomically(path, &prepared.bytes, false)?;
    let mut result = prepared.result;
    result.path = request.path.clone();
    Ok(result)
}

pub fn create_at_path(
    path: &Path,
    request: &CreateTableRequest,
    now: &str,
    limits: &TableLimits,
) -> TableResult<TableReadResult> {
    let payload_hash = create_payload_hash(request)?;
    create_core(
        path,
        &request.request_id,
        &request.table_id,
        &request.content,
        None,
        &payload_hash,
        now,
        limits,
    )
}
pub fn create_copy_at_path(
    path: &Path,
    request: &SaveTableCopyRequest,
    now: &str,
    limits: &TableLimits,
) -> TableResult<TableReadResult> {
    let payload_hash = create_payload_hash(request)?;
    create_core(
        path,
        &request.request_id,
        &request.table_id,
        &request.content,
        Some(request.source.clone()),
        &payload_hash,
        now,
        limits,
    )
}
#[allow(clippy::too_many_arguments)]
fn create_core(
    path: &Path,
    request_id: &str,
    table_id: &str,
    content: &TableContent,
    source: Option<CopySource>,
    payload_hash: &str,
    now: &str,
    limits: &TableLimits,
) -> TableResult<TableReadResult> {
    // Cross-path request/table discovery is owned by the wrapper under its vault gate.
    if path.try_exists().map_err(io_error)? {
        let existing = read_table_file(path, None, limits)?;
        if existing.file.id == table_id
            && existing.file.creation.request_id == request_id
            && existing.file.creation.payload_hash == payload_hash
        {
            return Ok(existing);
        }
        return Err(TableError::new(
            "IDEMPOTENCY_CONFLICT",
            "目标路径已有不同创建请求的文件",
            "/creation",
        ));
    }
    let mut file = TableFile {
        kind: "shard.table".into(),
        schema_version: 1,
        id: table_id.into(),
        revision: 1,
        creation: CreationIdentity {
            request_id: request_id.into(),
            payload_hash: payload_hash.into(),
        },
        last_mutation_id: None,
        last_mutation_hash: None,
        created_at: now.into(),
        updated_at: now.into(),
        copied_from: source,
        primary_field_id: content.primary_field_id.clone(),
        fields: content.fields.clone(),
        field_order: content.field_order.clone(),
        records: content.records.clone(),
        record_order: content.record_order.clone(),
        views: content.views.clone(),
        view_order: content.view_order.clone(),
    };
    validate_table(&file, limits)?;
    normalize_values(&mut file);
    let bytes = canonical_bytes(&file)?;
    if bytes.len() > limits.max_file_bytes {
        return Err(TableError::new(
            "LIMIT_EXCEEDED",
            "创建的文件超过字节上限",
            "",
        ));
    }
    // Validate the result filename before writing, so success cannot return an avoidable error.
    let result = read_result(path, file, &bytes)?;
    write_atomically(path, &bytes, true)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> PathBuf {
        option_env!("SHARD_TABLE_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/tables")
            })
    }
    fn create_request() -> CreateTableRequest {
        let bytes = fs::read(fixtures().join("valid/six-types.json")).unwrap();
        let file = parse_table_bytes(&bytes, &TableLimits::default()).unwrap();
        CreateTableRequest {
            request_id: format!("req_{:032x}", 9),
            table_id: format!("tbl_{:032x}", 9),
            parent_path: "notes".into(),
            suggested_name: "测试".into(),
            content: file.content(),
        }
    }
    fn edit_request(read: &TableReadResult) -> ApplyTableMutationsRequest {
        ApplyTableMutationsRequest {
            path: "notes/测试.shardtable.json".into(),
            table_id: read.file.id.clone(),
            expected_revision: read.revision,
            expected_hash: read.content_hash.clone(),
            mutation_id: format!("mut_{:032x}", 9),
            operations: vec![TableMutation::SetCells {
                cells: vec![CellEdit {
                    record_id: format!("rec_{:032x}", 1),
                    field_id: format!("fld_{:032x}", 2),
                    value: CellValue::Number(9.0),
                }],
            }],
        }
    }
    #[test]
    fn create_retry_reopen_and_mutation_retry_preserve_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("测试.shardtable.json");
        let limits = TableLimits::default();
        let mut request = create_request();
        let created = create_at_path(&path, &request, "2026-09-07T01:00:00.000Z", &limits).unwrap();
        let retry = create_at_path(&path, &request, "2026-09-07T02:00:00.000Z", &limits).unwrap();
        assert_eq!(retry, created);
        assert_eq!(created.content_hash, sha256(&fs::read(&path).unwrap()));
        assert_eq!(created.title, "测试");
        request.suggested_name = "不同请求".into();
        assert_eq!(
            create_at_path(&path, &request, "2026-09-07T02:00:00.000Z", &limits)
                .unwrap_err()
                .code,
            "IDEMPOTENCY_CONFLICT"
        );
        let edit = edit_request(&created);
        let saved = apply_to_file(&path, &edit, "2026-09-07T02:00:00.000Z", &limits).unwrap();
        let reopened = read_table_file(&path, Some(&created.file.id), &limits).unwrap();
        assert_eq!(reopened.revision, 2);
        assert_eq!(reopened.content_hash, saved.content_hash);
        assert_eq!(
            apply_to_file(&path, &edit, "2026-09-07T02:00:00.000Z", &limits)
                .unwrap_err()
                .code,
            "ALREADY_APPLIED"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn failed_batch_stale_bytes_and_deleted_target_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("测试.shardtable.json");
        let limits = TableLimits::default();
        let read = create_at_path(
            &path,
            &create_request(),
            "2026-09-07T01:00:00.000Z",
            &limits,
        )
        .unwrap();
        let original = fs::read(&path).unwrap();
        let mut edit = edit_request(&read);
        edit.operations.push(TableMutation::SetCells {
            cells: vec![CellEdit {
                record_id: format!("rec_{:032x}", 1),
                field_id: format!("fld_{:032x}", 6),
                value: CellValue::Text("false".into()),
            }],
        });
        assert_eq!(
            apply_to_file(&path, &edit, "2026-09-07T02:00:00.000Z", &limits)
                .unwrap_err()
                .code,
            "INVALID_VALUE"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        let edit = edit_request(&read);
        let mut external = original.clone();
        external.push(b' ');
        fs::write(&path, &external).unwrap();
        assert_eq!(
            apply_to_file(&path, &edit, "2026-09-07T02:00:00.000Z", &limits)
                .unwrap_err()
                .code,
            "STALE_BASE"
        );
        assert_eq!(fs::read(&path).unwrap(), external);
        fs::remove_file(&path).unwrap();
        assert_eq!(
            apply_to_file(&path, &edit, "2026-09-07T02:00:00.000Z", &limits)
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        assert!(!path.exists());
    }
    #[test]
    fn failed_install_cleans_temp_and_preserves_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("测试.shardtable.json");
        fs::write(&path, b"original").unwrap();
        assert!(write_atomically(&path, b"new", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(write_atomically(&path, b"new", false).is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn parsed_save_uses_exact_public_mutation_bytes_and_preserves_strict_input_checks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("测试.shardtable.json");
        let limits = TableLimits::default();
        let now = "2026-09-07T02:00:00.000Z";
        let read = create_at_path(&path, &create_request(), now, &limits).unwrap();
        let request = edit_request(&read);
        let (expected, expected_ack) = super::super::mutations::apply_mutations(
            &read.file,
            &read.content_hash,
            &request,
            now,
            &limits,
        )
        .unwrap();
        let bytes = canonical_bytes(&expected).unwrap();
        let result = apply_to_file(&path, &request, now, &limits).unwrap();
        assert_eq!(result, expected_ack);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(result.content_hash, sha256(&bytes));

        // The optimized storage entry must still detect a duplicate nested cell key.
        let field = format!("fld_{:032x}", 2);
        let duplicate = String::from_utf8(bytes).unwrap().replacen(
            &format!("\"{field}\":"),
            &format!("\"{field}\":null,\"{field}\":"),
            1,
        );
        fs::write(&path, duplicate.as_bytes()).unwrap();
        let mut next_request = request.clone();
        next_request.expected_revision = result.revision;
        next_request.expected_hash = sha256(duplicate.as_bytes());
        next_request.mutation_id = format!("mut_{:032x}", 10);
        assert_eq!(
            apply_to_file(&path, &next_request, now, &limits)
                .unwrap_err()
                .code,
            "DUPLICATE_KEY"
        );
        assert_eq!(fs::read(&path).unwrap(), duplicate.as_bytes());

        // The public evaluator still treats an ordinary mutable file as untrusted.
        let mut dirty = expected;
        let untouched = dirty.record_order[1].clone();
        dirty
            .records
            .get_mut(&untouched)
            .unwrap()
            .values
            .insert(field, CellValue::Text("不是数字".into()));
        assert_eq!(
            super::super::mutations::apply_mutations(
                &dirty,
                &result.content_hash,
                &next_request,
                now,
                &limits
            )
            .unwrap_err()
            .code,
            "INVALID_VALUE"
        );
    }
    #[test]
    fn copy_has_new_identity_and_source_without_reusing_creation_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let limits = TableLimits::default();
        let source = create_at_path(
            &dir.path().join("原表.shardtable.json"),
            &create_request(),
            "2026-09-07T01:00:00.000Z",
            &limits,
        )
        .unwrap();
        let request = SaveTableCopyRequest {
            request_id: format!("req_{:032x}", 10),
            table_id: format!("tbl_{:032x}", 10),
            parent_path: "notes".into(),
            suggested_name: "副本".into(),
            source: CopySource {
                table_id: source.file.id.clone(),
                revision: source.revision,
                content_hash: source.content_hash,
            },
            content: source.file.content(),
        };
        let copy = create_copy_at_path(
            &dir.path().join("副本.shardtable.json"),
            &request,
            "2026-09-07T02:00:00.000Z",
            &limits,
        )
        .unwrap();
        assert_ne!(source.file.id, copy.file.id);
        assert_eq!(source.file.records, copy.file.records);
        assert_eq!(copy.file.copied_from.unwrap().table_id, source.file.id);
        assert!(copy.file.last_mutation_id.is_none());
    }
}
