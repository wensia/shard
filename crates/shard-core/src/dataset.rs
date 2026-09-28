//! CSV 数据集的格式、校验与文件操作。调用写入函数前必须持有 vault 写锁。
use crate::{ensure_public_csv_path, write_bytes_atomically, LIBRARY_FILENAME_MAX_BYTES};
use csv::{QuoteStyle, ReaderBuilder, Terminator, WriterBuilder};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt, fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvTable {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetSchema {
    pub schema_version: u32,
    pub dataset_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSnapshot {
    pub path: String,
    pub table: CsvTable,
    pub sha: String,
    pub schema: Option<DatasetSchema>,
    pub schema_sha: Option<String>,
    pub editable: bool,
    pub read_only_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DatasetOp {
    SetCells { cells: Vec<CellEdit> },
    InsertRows { at: usize, rows: Vec<Vec<String>> },
    DeleteRows { rows: Vec<usize> },
    InsertColumn { at: usize, name: String },
    RenameColumn { column: usize, name: String },
    DeleteColumn { column: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    pub row: usize,
    pub column: usize,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetLimits {
    pub max_rows: usize,
    pub max_columns: usize,
    pub max_cells: usize,
    pub max_file_bytes: usize,
    pub max_cell_chars: usize,
    pub max_ops: usize,
    pub max_explicit_cells: usize,
}

impl Default for DatasetLimits {
    fn default() -> Self {
        Self {
            max_rows: 10_000,
            max_columns: 128,
            max_cells: 300_000,
            max_file_bytes: 64 * 1024 * 1024,
            max_cell_chars: 16_384,
            max_ops: 64,
            max_explicit_cells: 50_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetError {
    pub code: String,
    pub message: String,
}

impl DatasetError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}
impl fmt::Display for DatasetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.code, self.message)
    }
}
impl std::error::Error for DatasetError {}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn io_error(error: std::io::Error) -> DatasetError {
    DatasetError::new("IO_ERROR", format!("文件读写失败：{error}"))
}
fn invalid_path(message: String) -> DatasetError {
    if message.starts_with("找不到 CSV 文件") {
        DatasetError::new("NOT_FOUND", message)
    } else {
        DatasetError::new("INVALID_PATH", message)
    }
}
fn stale() -> DatasetError {
    DatasetError::new("STALE_BASE", "数据文件已在别处被修改")
}

fn parse_unlimited(bytes: &[u8]) -> Result<CsvTable, DatasetError> {
    let content = std::str::from_utf8(bytes)
        .map_err(|_| DatasetError::new("CSV_NOT_UTF8", "CSV 不是 UTF-8 编码"))?;
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(b',')
        .quote(b'"')
        .double_quote(true)
        .from_reader(content.as_bytes());
    let mut records = reader.records();
    let header = records
        .next()
        .transpose()
        .map_err(|error| DatasetError::new("CSV_PARSE", format!("CSV 格式解析失败：{error}")))?
        .ok_or_else(|| DatasetError::new("HEADER_INVALID", "CSV 文件缺少表头"))?
        .iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for record in records {
        let record = record.map_err(|error| {
            DatasetError::new("CSV_PARSE", format!("CSV 格式解析失败：{error}"))
        })?;
        if record.len() != header.len() {
            return Err(DatasetError::new(
                "CSV_RAGGED",
                "CSV 记录的字段数与表头不一致",
            ));
        }
        rows.push(record.iter().map(str::to_string).collect());
    }
    Ok(CsvTable { header, rows })
}

fn validate_header(table: &CsvTable) -> Result<(), DatasetError> {
    let mut names = HashSet::new();
    if table.header.is_empty()
        || table
            .header
            .iter()
            .any(|name| name.is_empty() || !names.insert(name))
    {
        return Err(DatasetError::new(
            "HEADER_INVALID",
            "表头名称不能为空且不能重复",
        ));
    }
    Ok(())
}

fn validate_key(table: &CsvTable, schema: Option<&DatasetSchema>) -> Result<(), DatasetError> {
    let Some(key) = schema.and_then(|schema| schema.primary_key.as_ref()) else {
        return Ok(());
    };
    let Some(column) = table.header.iter().position(|name| name == key) else {
        return Err(DatasetError::new("PRIMARY_KEY_INVALID", "主键列不存在"));
    };
    let mut values = HashSet::new();
    if table.rows.iter().any(|row| {
        row.get(column)
            .is_none_or(|value| value.is_empty() || !values.insert(value))
    }) {
        return Err(DatasetError::new(
            "PRIMARY_KEY_INVALID",
            "主键值不能为空且不能重复",
        ));
    }
    Ok(())
}

fn validate_limits(table: &CsvTable, limits: &DatasetLimits) -> Result<(), DatasetError> {
    if table.rows.len() > limits.max_rows
        || table.header.len() > limits.max_columns
        || table.rows.len().saturating_mul(table.header.len()) > limits.max_cells
        || table
            .header
            .iter()
            .chain(table.rows.iter().flatten())
            .any(|value| value.chars().count() > limits.max_cell_chars)
        || serialize_csv(table).len() > limits.max_file_bytes
    {
        return Err(DatasetError::new("LIMIT_EXCEEDED", "数据集超过可编辑上限"));
    }
    Ok(())
}

pub fn parse_csv_bytes(bytes: &[u8], limits: &DatasetLimits) -> Result<CsvTable, DatasetError> {
    if bytes.len() > limits.max_file_bytes {
        return Err(DatasetError::new("LIMIT_EXCEEDED", "CSV 文件超过大小上限"));
    }
    let table = parse_unlimited(bytes)?;
    validate_limits(&table, limits)?;
    Ok(table)
}

pub fn serialize_csv(table: &CsvTable) -> Vec<u8> {
    let mut writer = WriterBuilder::new()
        .has_headers(false)
        .quote_style(QuoteStyle::Necessary)
        .terminator(Terminator::Any(b'\n'))
        .from_writer(Vec::new());
    writer
        .write_record(&table.header)
        .expect("写入内存 CSV 不应失败");
    for row in &table.rows {
        writer.write_record(row).expect("写入内存 CSV 不应失败");
    }
    writer.into_inner().expect("写入内存 CSV 不应失败")
}

fn validate_schema(schema: &DatasetSchema) -> Result<(), DatasetError> {
    let id = schema.dataset_id.as_bytes();
    if schema.schema_version != 1
        || id.len() != 35
        || !id.starts_with(b"ds_")
        || !id[3..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(DatasetError::new(
            "SCHEMA_INVALID",
            "数据集 schema 版本或 ID 无效",
        ));
    }
    Ok(())
}

pub fn parse_schema(bytes: &[u8]) -> Result<DatasetSchema, DatasetError> {
    let schema: DatasetSchema = serde_json::from_slice(bytes)
        .map_err(|_| DatasetError::new("SCHEMA_INVALID", "数据集 schema 格式无效"))?;
    validate_schema(&schema)?;
    Ok(schema)
}

pub fn serialize_schema(schema: &DatasetSchema) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(schema).expect("schema 序列化不应失败");
    bytes.push(b'\n');
    bytes
}

pub fn apply_ops(
    table: &CsvTable,
    schema: Option<&DatasetSchema>,
    ops: &[DatasetOp],
    limits: &DatasetLimits,
) -> Result<CsvTable, DatasetError> {
    if ops.len() > limits.max_ops {
        return Err(DatasetError::new("LIMIT_EXCEEDED", "操作数量超过上限"));
    }
    validate_header(table)?;
    validate_key(table, schema)?;
    let mut next = table.clone();
    let mut explicit = 0usize;
    let key = schema.and_then(|schema| schema.primary_key.as_deref());
    for op in ops {
        match op {
            DatasetOp::SetCells { cells } => {
                explicit = explicit.saturating_add(cells.len());
                for cell in cells {
                    if cell.row >= next.rows.len() || cell.column >= next.header.len() {
                        return Err(DatasetError::new("OP_INVALID", "单元格下标越界"));
                    }
                    if key == Some(next.header[cell.column].as_str())
                        && next.rows[cell.row][cell.column] != cell.value
                    {
                        return Err(DatasetError::new(
                            "PRIMARY_KEY_INVALID",
                            "不能修改已有主键值",
                        ));
                    }
                    next.rows[cell.row][cell.column] = cell.value.clone();
                }
            }
            DatasetOp::InsertRows { at, rows } => {
                if *at > next.rows.len() || rows.iter().any(|row| row.len() != next.header.len()) {
                    return Err(DatasetError::new("OP_INVALID", "插入行的位置或列数无效"));
                }
                explicit = explicit.saturating_add(rows.len().saturating_mul(next.header.len()));
                next.rows.splice(*at..*at, rows.clone());
            }
            DatasetOp::DeleteRows { rows } => {
                let mut indices = rows.clone();
                indices.sort_unstable();
                indices.dedup();
                if indices.iter().any(|index| *index >= next.rows.len()) {
                    return Err(DatasetError::new("OP_INVALID", "删除行下标越界"));
                }
                for index in indices.into_iter().rev() {
                    next.rows.remove(index);
                }
            }
            DatasetOp::InsertColumn { at, name } => {
                if *at > next.header.len() {
                    return Err(DatasetError::new("OP_INVALID", "插入列下标越界"));
                }
                next.header.insert(*at, name.clone());
                for row in &mut next.rows {
                    row.insert(*at, String::new());
                }
            }
            DatasetOp::RenameColumn { column, name } => {
                if *column >= next.header.len() {
                    return Err(DatasetError::new("OP_INVALID", "重命名列下标越界"));
                }
                if key == Some(next.header[*column].as_str()) {
                    return Err(DatasetError::new("PRIMARY_KEY_INVALID", "不能重命名主键列"));
                }
                next.header[*column] = name.clone();
            }
            DatasetOp::DeleteColumn { column } => {
                if *column >= next.header.len() || next.header.len() == 1 {
                    return Err(DatasetError::new("OP_INVALID", "不能删除该列"));
                }
                if key == Some(next.header[*column].as_str()) {
                    return Err(DatasetError::new("PRIMARY_KEY_INVALID", "不能删除主键列"));
                }
                next.header.remove(*column);
                for row in &mut next.rows {
                    row.remove(*column);
                }
            }
        }
        validate_header(&next)?;
        validate_key(&next, schema)?;
        validate_limits(&next, limits)?;
    }
    if explicit > limits.max_explicit_cells {
        return Err(DatasetError::new(
            "LIMIT_EXCEEDED",
            "显式单元格数量超过上限",
        ));
    }
    validate_limits(&next, limits)?;
    Ok(next)
}

fn schema_path(path: &Path, rel: &str) -> Option<PathBuf> {
    if !rel.starts_with("datasets/") {
        return None;
    }
    Some(path.with_file_name(format!("{}.schema.json", path.file_name()?.to_str()?)))
}

fn read_schema(
    vault: &Path,
    path: &Path,
    rel: &str,
) -> Result<(Option<Vec<u8>>, Option<DatasetError>), DatasetError> {
    let canonical_vault = vault.canonicalize().map_err(io_error)?;
    if !path.starts_with(canonical_vault.join("datasets")) {
        return Ok((None, None));
    }
    let Some(sidecar) = schema_path(path, rel) else {
        return Ok((None, None));
    };
    if !sidecar.exists() {
        return Ok((None, None));
    }
    let canonical = sidecar.canonicalize().map_err(io_error)?;
    if !canonical.starts_with(&canonical_vault) {
        return Ok((
            None,
            Some(DatasetError::new("SCHEMA_INVALID", "schema 路径越出 vault")),
        ));
    }
    Ok((Some(fs::read(canonical).map_err(io_error)?), None))
}

fn snapshot(
    vault: &Path,
    rel: &str,
    limits: &DatasetLimits,
) -> Result<DatasetSnapshot, DatasetError> {
    let rel = rel.trim();
    let path = ensure_public_csv_path(vault, rel).map_err(invalid_path)?;
    let bytes = fs::read(&path).map_err(io_error)?;
    let table = parse_unlimited(&bytes)?;
    let (schema_bytes, schema_path_error) = read_schema(vault, &path, rel)?;
    let schema_sha = schema_bytes.as_deref().map(sha);
    let parsed = schema_bytes.as_deref().map(parse_schema).transpose();
    let (schema, schema_error) = match parsed {
        Ok(schema) => (schema, schema_path_error),
        Err(error) => (None, Some(error)),
    };
    let read_only = schema_error
        .or_else(|| validate_header(&table).err())
        .or_else(|| validate_key(&table, schema.as_ref()).err())
        .or_else(|| {
            if bytes.len() > limits.max_file_bytes {
                Some(DatasetError::new("LIMIT_EXCEEDED", "CSV 文件超过大小上限"))
            } else {
                validate_limits(&table, limits).err()
            }
        });
    Ok(DatasetSnapshot {
        path: rel.to_string(),
        table,
        sha: sha(&bytes),
        schema,
        schema_sha,
        editable: read_only.is_none(),
        read_only_reason: read_only.map(|error| error.to_string()),
    })
}

pub fn read_dataset(
    vault: &Path,
    rel: &str,
    limits: &DatasetLimits,
) -> Result<DatasetSnapshot, DatasetError> {
    snapshot(vault, rel, limits)
}

/// 必须在持 vault 写锁时调用；本函数不自行取锁。
pub fn write_dataset_ops(
    vault: &Path,
    rel: &str,
    expected_sha: &str,
    expected_schema_sha: Option<&str>,
    ops: &[DatasetOp],
    limits: &DatasetLimits,
) -> Result<DatasetSnapshot, DatasetError> {
    let current = snapshot(vault, rel, limits)?;
    if current.sha != expected_sha || current.schema_sha.as_deref() != expected_schema_sha {
        return Err(stale());
    }
    if !current.editable {
        let reason = current.read_only_reason.unwrap_or_default();
        let (code, message) = reason
            .split_once(':')
            .unwrap_or(("OP_INVALID", reason.as_str()));
        return Err(DatasetError::new(code, message));
    }
    let next = apply_ops(&current.table, current.schema.as_ref(), ops, limits)?;
    let path = ensure_public_csv_path(vault, rel).map_err(invalid_path)?;
    let latest = snapshot(vault, rel, limits)?;
    if latest.sha != expected_sha || latest.schema_sha.as_deref() != expected_schema_sha {
        return Err(stale());
    }
    write_bytes_atomically(&path, &serialize_csv(&next))
        .map_err(|error| DatasetError::new("IO_ERROR", format!("文件写入失败：{error}")))?;
    snapshot(vault, rel, limits)
}

pub fn new_dataset_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!(
        "ds_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn filename_stem(title: &str, suffix: &str) -> String {
    let clean = title
        .chars()
        .filter(|ch| !ch.is_control() && !"/\\:*?\"<>|".contains(*ch))
        .collect::<String>();
    let clean = clean.trim();
    let clean = if clean.is_empty() { "数据集" } else { clean };
    // 旁路 schema 的文件名比 CSV 多出 `.schema.json`，以较长者为准。
    let available = LIBRARY_FILENAME_MAX_BYTES - ".csv.schema.json".len() - suffix.len();
    let mut stem = String::new();
    for ch in clean.chars() {
        if stem.len() + ch.len_utf8() > available {
            break;
        }
        stem.push(ch);
    }
    format!("{stem}{suffix}")
}

/// 必须在持 vault 写锁时调用；本函数不自行取锁。
pub fn create_dataset(
    vault: &Path,
    title: &str,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    primary_key: Option<String>,
    limits: &DatasetLimits,
) -> Result<DatasetSnapshot, DatasetError> {
    let table = CsvTable { header, rows };
    let schema = DatasetSchema {
        schema_version: 1,
        dataset_id: new_dataset_id(),
        title: title.to_string(),
        primary_key,
    };
    validate_header(&table)?;
    validate_key(&table, Some(&schema))?;
    if table.rows.iter().any(|row| row.len() != table.header.len()) {
        return Err(DatasetError::new(
            "CSV_RAGGED",
            "CSV 记录的字段数与表头不一致",
        ));
    }
    validate_limits(&table, limits)?;
    let dir = vault.join("datasets");
    fs::create_dir_all(&dir).map_err(io_error)?;
    if fs::symlink_metadata(&dir)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        return Err(DatasetError::new(
            "INVALID_PATH",
            "数据集目录不能是符号链接",
        ));
    }
    if !dir
        .canonicalize()
        .map_err(io_error)?
        .starts_with(vault.canonicalize().map_err(io_error)?)
    {
        return Err(DatasetError::new(
            "INVALID_PATH",
            "数据集目录不能越出 vault",
        ));
    }
    let mut number = 1usize;
    let (path, rel) = loop {
        let suffix = if number == 1 {
            String::new()
        } else {
            format!(" {number}")
        };
        let name = format!("{}.csv", filename_stem(title, &suffix));
        let path = dir.join(&name);
        if !path.exists() && !path.with_file_name(format!("{name}.schema.json")).exists() {
            break (path, format!("datasets/{name}"));
        }
        number += 1;
    };
    write_bytes_atomically(&path, &serialize_csv(&table))
        .map_err(|error| DatasetError::new("IO_ERROR", format!("文件写入失败：{error}")))?;
    let sidecar = schema_path(&path, &rel).expect("新数据集在 datasets 目录中");
    write_bytes_atomically(&sidecar, &serialize_schema(&schema))
        .map_err(|error| DatasetError::new("IO_ERROR", format!("文件写入失败：{error}")))?;
    snapshot(vault, &rel, limits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_match_shared_frontend_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/datasets/ops-cases.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let table: CsvTable = serde_json::from_value(case["table"].clone()).unwrap();
            let schema: Option<DatasetSchema> =
                serde_json::from_value(case["schema"].clone()).unwrap();
            let ops: Vec<DatasetOp> = serde_json::from_value(case["ops"].clone()).unwrap();
            let result = apply_ops(&table, schema.as_ref(), &ops, &DatasetLimits::default());
            if let Some(expected) = case.get("expected") {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    *expected,
                    "{}",
                    case["id"]
                );
            } else {
                assert_eq!(
                    result.unwrap_err().code,
                    case["error"].as_str().unwrap(),
                    "{}",
                    case["id"]
                );
            }
        }
    }

    fn table() -> CsvTable {
        CsvTable {
            header: vec!["id".into(), "内容".into()],
            rows: vec![
                vec!["r_000000000001".into(), "原文".into()],
                vec!["r_000000000002".into(), "第二行".into()],
            ],
        }
    }
    fn schema() -> DatasetSchema {
        DatasetSchema {
            schema_version: 1,
            dataset_id: new_dataset_id(),
            title: "示例".into(),
            primary_key: Some("id".into()),
        }
    }
    fn code<T>(result: Result<T, DatasetError>) -> String {
        result.err().unwrap().code
    }

    #[test]
    fn csv_roundtrip_and_record_diff() {
        let limits = DatasetLimits::default();
        let data = CsvTable {
            header: vec!["多行".into(), "空".into()],
            rows: vec![
                vec!["前导 空格,\n\"引号\"\r\n".into(), String::new()],
                vec!["00123".into(), "=SUM(A1)".into()],
            ],
        };
        let bytes = serialize_csv(&data);
        assert_eq!(parse_csv_bytes(&bytes, &limits).unwrap(), data);
        assert_eq!(
            serialize_csv(&parse_csv_bytes(&bytes, &limits).unwrap()),
            bytes
        );
        assert!(String::from_utf8(bytes.clone())
            .unwrap()
            .contains("00123,=SUM(A1)\n"));
        let mut changed = data.clone();
        changed.rows[0][0] = "前导 空格,\n\"改后\"\r\n".into();
        let before = String::from_utf8(bytes).unwrap();
        let after = String::from_utf8(serialize_csv(&changed)).unwrap();
        let records = |content: &str| {
            ReaderBuilder::new()
                .has_headers(false)
                .from_reader(content.as_bytes())
                .records()
                .map(|record| record.unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            records(&before)
                .iter()
                .zip(records(&after))
                .filter(|(a, b)| *a != b)
                .count(),
            1
        );
        assert!(after.starts_with("多行,空\n\"前导 空格,\n\""));
    }

    #[test]
    fn csv_errors_and_read_only_header() {
        let limits = DatasetLimits::default();
        assert_eq!(code(parse_csv_bytes(&[0xff], &limits)), "CSV_NOT_UTF8");
        assert_eq!(code(parse_csv_bytes(b"", &limits)), "HEADER_INVALID");
        assert_eq!(code(parse_csv_bytes(b"a,b\n1\n", &limits)), "CSV_RAGGED");
        assert_eq!(
            parse_csv_bytes(b"\xef\xbb\xbfa\n\xef\xbb\xbfvalue\n", &limits)
                .unwrap()
                .rows[0][0],
            "\u{feff}value"
        );
        let vault = tempfile::tempdir().unwrap();
        fs::write(vault.path().join("bad.csv"), "a,a\n1,2\n").unwrap();
        let snapshot = read_dataset(vault.path(), "bad.csv", &limits).unwrap();
        assert!(!snapshot.editable);
        assert!(snapshot
            .read_only_reason
            .unwrap()
            .starts_with("HEADER_INVALID:"));
        let small = DatasetLimits {
            max_rows: 0,
            ..limits
        };
        let snapshot = read_dataset(vault.path(), "bad.csv", &small).unwrap();
        assert_eq!(snapshot.table.rows.len(), 1);
    }

    #[test]
    fn schema_strict_format() {
        let valid = schema();
        let bytes = serialize_schema(&valid);
        assert_eq!(parse_schema(&bytes).unwrap(), valid);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("{\n  \"schemaVersion\": 1,\n  \"datasetId\":"));
        assert!(text.find("\"title\"").unwrap() < text.find("\"primaryKey\"").unwrap());
        for invalid in [
            text.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2"),
            text.replace("ds_", "DS_"),
            text.replace("\"title\":", "\"unknown\": 1, \"title\":"),
        ] {
            assert_eq!(code(parse_schema(invalid.as_bytes())), "SCHEMA_INVALID");
        }
    }

    #[test]
    fn ops_protect_key_and_follow_current_indices() {
        let limits = DatasetLimits::default();
        let source = table();
        let key = schema();
        assert_eq!(
            code(apply_ops(
                &source,
                Some(&key),
                &[DatasetOp::SetCells {
                    cells: vec![CellEdit {
                        row: 0,
                        column: 0,
                        value: "other".into()
                    }]
                }],
                &limits
            )),
            "PRIMARY_KEY_INVALID"
        );
        assert_eq!(
            code(apply_ops(
                &source,
                Some(&key),
                &[DatasetOp::InsertRows {
                    at: 0,
                    rows: vec![source.rows[0].clone()]
                }],
                &limits
            )),
            "PRIMARY_KEY_INVALID"
        );
        assert_eq!(
            code(apply_ops(
                &source,
                Some(&key),
                &[DatasetOp::DeleteColumn { column: 0 }],
                &limits
            )),
            "PRIMARY_KEY_INVALID"
        );
        assert_eq!(
            code(apply_ops(
                &source,
                Some(&key),
                &[DatasetOp::RenameColumn {
                    column: 0,
                    name: "new".into()
                }],
                &limits
            )),
            "PRIMARY_KEY_INVALID"
        );
        let result = apply_ops(
            &source,
            Some(&key),
            &[
                DatasetOp::InsertRows {
                    at: 1,
                    rows: vec![vec!["r_000000000003".into(), "中间".into()]],
                },
                DatasetOp::DeleteRows {
                    rows: vec![2, 0, 2],
                },
                DatasetOp::SetCells {
                    cells: vec![CellEdit {
                        row: 0,
                        column: 1,
                        value: "改后".into(),
                    }],
                },
            ],
            &limits,
        )
        .unwrap();
        assert_eq!(result.rows, vec![vec!["r_000000000003", "改后"]]);
        assert_eq!(source.rows.len(), 2);
    }

    #[test]
    fn create_read_write_and_conflicts() {
        let vault = tempfile::tempdir().unwrap();
        let limits = DatasetLimits::default();
        let first = create_dataset(
            vault.path(),
            "阅读/记录",
            table().header,
            table().rows,
            Some("id".into()),
            &limits,
        )
        .unwrap();
        assert_eq!(first.path, "datasets/阅读记录.csv");
        assert!(first.editable);
        assert_eq!(first.schema.as_ref().unwrap().dataset_id.len(), 35);
        let second = create_dataset(
            vault.path(),
            "阅读/记录",
            table().header,
            table().rows,
            None,
            &limits,
        )
        .unwrap();
        assert_eq!(second.path, "datasets/阅读记录 2.csv");
        let csv_path = vault.path().join(&first.path);
        let original = fs::read(&csv_path).unwrap();
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                &first.path,
                "wrong",
                first.schema_sha.as_deref(),
                &[],
                &limits
            )),
            "STALE_BASE"
        );
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                &first.path,
                &first.sha,
                None,
                &[],
                &limits
            )),
            "STALE_BASE"
        );
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                &first.path,
                &first.sha,
                first.schema_sha.as_deref(),
                &[
                    DatasetOp::SetCells {
                        cells: vec![CellEdit {
                            row: 0,
                            column: 1,
                            value: "暂存".into()
                        }]
                    },
                    DatasetOp::DeleteColumn { column: 0 }
                ],
                &limits
            )),
            "PRIMARY_KEY_INVALID"
        );
        assert_eq!(fs::read(&csv_path).unwrap(), original);
        let updated = write_dataset_ops(
            vault.path(),
            &first.path,
            &first.sha,
            first.schema_sha.as_deref(),
            &[DatasetOp::SetCells {
                cells: vec![CellEdit {
                    row: 0,
                    column: 1,
                    value: "更新".into(),
                }],
            }],
            &limits,
        )
        .unwrap();
        assert_eq!(updated.table.rows[0][1], "更新");
        assert_ne!(updated.sha, first.sha);
        let plain = vault.path().join("plain.csv");
        fs::write(&plain, "a\n1\n").unwrap();
        let before = read_dataset(vault.path(), "plain.csv", &limits).unwrap();
        fs::write(vault.path().join("plain.csv.schema.json"), "invalid").unwrap();
        let after = read_dataset(vault.path(), "plain.csv", &limits).unwrap();
        assert_eq!(before.schema_sha, after.schema_sha);
        let managed = vault.path().join("datasets/other.csv");
        fs::write(&managed, "a\n1\n").unwrap();
        let before = read_dataset(vault.path(), "datasets/other.csv", &limits).unwrap();
        fs::write(
            vault.path().join("datasets/other.csv.schema.json"),
            serialize_schema(&schema()),
        )
        .unwrap();
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                "datasets/other.csv",
                &before.sha,
                None,
                &[],
                &limits
            )),
            "STALE_BASE"
        );
    }

    #[test]
    fn over_limit_op_keeps_file_and_long_name_fits_sidecar() {
        let vault = tempfile::tempdir().unwrap();
        let limits = DatasetLimits::default();
        let title = "中".repeat(100);
        let data = create_dataset(
            vault.path(),
            &title,
            vec!["x".into()],
            vec![],
            None,
            &limits,
        )
        .unwrap();
        let file = vault.path().join(&data.path);
        assert!(
            file.file_name().unwrap().len() + ".schema.json".len() <= LIBRARY_FILENAME_MAX_BYTES
        );
        let original = fs::read(&file).unwrap();
        let tight = DatasetLimits {
            max_cell_chars: 1,
            ..limits
        };
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                &data.path,
                &data.sha,
                data.schema_sha.as_deref(),
                &[DatasetOp::InsertRows {
                    at: 0,
                    rows: vec![vec!["too long".into()]]
                }],
                &tight
            )),
            "LIMIT_EXCEEDED"
        );
        assert_eq!(fs::read(&file).unwrap(), original);
    }

    #[test]
    fn invalid_schema_and_primary_key_open_read_only() {
        let vault = tempfile::tempdir().unwrap();
        let limits = DatasetLimits::default();
        fs::create_dir(vault.path().join("datasets")).unwrap();
        let csv = vault.path().join("datasets/sample.csv");
        let sidecar = vault.path().join("datasets/sample.csv.schema.json");
        fs::write(&csv, "id,value\n1,a\n1,b\n").unwrap();
        fs::write(&sidecar, b"{invalid}").unwrap();
        let invalid = read_dataset(vault.path(), "datasets/sample.csv", &limits).unwrap();
        assert!(!invalid.editable);
        assert_eq!(invalid.table.rows.len(), 2);
        assert!(invalid
            .read_only_reason
            .unwrap()
            .starts_with("SCHEMA_INVALID:"));
        assert_eq!(
            code(write_dataset_ops(
                vault.path(),
                "datasets/sample.csv",
                &invalid.sha,
                invalid.schema_sha.as_deref(),
                &[],
                &limits
            )),
            "SCHEMA_INVALID"
        );
        fs::write(&sidecar, serialize_schema(&schema())).unwrap();
        let duplicate = read_dataset(vault.path(), "datasets/sample.csv", &limits).unwrap();
        assert!(!duplicate.editable);
        assert!(duplicate
            .read_only_reason
            .unwrap()
            .starts_with("PRIMARY_KEY_INVALID:"));
        fs::write(&csv, "id,value\n1,a\n2,b\n").unwrap();
        let small = DatasetLimits {
            max_rows: 1,
            ..limits
        };
        let over = read_dataset(vault.path(), "datasets/sample.csv", &small).unwrap();
        assert_eq!(over.table.rows.len(), 2);
        assert!(over
            .read_only_reason
            .unwrap()
            .starts_with("LIMIT_EXCEEDED:"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_paths_into_lockbox_and_symlinked_dataset_directory() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join("lockbox")).unwrap();
        fs::write(vault.path().join("lockbox/private.csv"), "x\n1\n").unwrap();
        symlink(
            vault.path().join("lockbox/private.csv"),
            vault.path().join("alias.csv"),
        )
        .unwrap();
        assert_eq!(
            code(read_dataset(
                vault.path(),
                "alias.csv",
                &DatasetLimits::default()
            )),
            "INVALID_PATH"
        );
        symlink(vault.path().join("lockbox"), vault.path().join("datasets")).unwrap();
        assert_eq!(
            code(create_dataset(
                vault.path(),
                "a",
                vec!["x".into()],
                vec![],
                None,
                &DatasetLimits::default()
            )),
            "INVALID_PATH"
        );
    }
}
