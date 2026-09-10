//! Read/prepare exchange data. Creating a table still uses the frozen create_table request.
use crate::table::{model::{CellValue, TableError, TableResult}, xlsx};
use serde::Deserialize;
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectXlsxRequest { pub path: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewXlsxRequest { pub path: String, pub sheet_index: usize }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareXlsxRequest { pub columns: Vec<xlsx::XlsxExportColumn>, pub rows: Vec<Vec<CellValue>> }

async fn background<T: Send + 'static>(task: impl FnOnce() -> TableResult<T> + Send + 'static) -> TableResult<T> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|error| TableError::new("IO_ERROR", error.to_string(), ""))?
}
#[tauri::command]
pub async fn inspect_table_xlsx(request: InspectXlsxRequest) -> TableResult<xlsx::XlsxWorkbookInfo> {
    background(move || { let limits = xlsx::XlsxLimits::default(); let bytes = xlsx::read_xlsx_file(Path::new(&request.path), &limits)?; xlsx::inspect_xlsx(&bytes, &limits) }).await
}
#[tauri::command]
pub async fn preview_table_xlsx(request: PreviewXlsxRequest) -> TableResult<tauri::ipc::Response> {
    background(move || {
        let limits = xlsx::XlsxLimits::default();
        let bytes = xlsx::read_xlsx_file(Path::new(&request.path), &limits)?;
        // Includes a possible header. The UI previews a slice but confirms this frozen snapshot.
        let preview = xlsx::preview_xlsx(&bytes, request.sheet_index, limits.table.max_rows + 1, &limits)?;
        serde_json::to_vec(&preview).map(tauri::ipc::Response::new).map_err(io)
    }).await
}
#[tauri::command]
pub async fn prepare_table_xlsx_export(request: tauri::ipc::Request<'_>) -> TableResult<tauri::ipc::Response> {
    let bytes = raw_body(&request)?;
    background(move || {
        let request: PrepareXlsxRequest = serde_json::from_slice(&bytes).map_err(io)?;
        xlsx::export_xlsx(&request.columns, &request.rows, &xlsx::XlsxLimits::default()).map(tauri::ipc::Response::new)
    }).await
}

const MAX_EXCHANGE_BYTES: usize = 64 * 1024 * 1024;
fn io(error: impl ToString) -> TableError { TableError::new("IO_ERROR", error.to_string(), "") }
fn raw_body(request: &tauri::ipc::Request<'_>) -> TableResult<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_EXCHANGE_BYTES => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Raw(_) => Err(TableError::new("LIMIT_EXCEEDED", "导出内容超过 64 MiB", "")),
        _ => Err(TableError::new("INVALID_VALUE", "导出需要二进制内容", "")),
    }
}
#[tauri::command]
pub async fn read_table_exchange_file(request: InspectXlsxRequest) -> TableResult<tauri::ipc::Response> {
    background(move || {
        let path = Path::new(&request.path);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_lowercase();
        if !path.is_absolute() || !(name.ends_with(".csv") || name.ends_with(".shardtable.json")) {
            return Err(TableError::new("INVALID_PATH", "请选择 CSV 或原生数据表文件", ""));
        }
        let file = fs::File::open(path).map_err(io)?;
        let meta = file.metadata().map_err(io)?;
        if !meta.is_file() || meta.len() > MAX_EXCHANGE_BYTES as u64 { return Err(TableError::new("LIMIT_EXCEEDED", "文件无效或超过 64 MiB", "")); }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(MAX_EXCHANGE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(io)?;
        if bytes.len() > MAX_EXCHANGE_BYTES { return Err(TableError::new("LIMIT_EXCEEDED", "文件超过 64 MiB", "")); }
        Ok(tauri::ipc::Response::new(bytes))
    }).await
}
fn decode_export_path(encoded: &str) -> TableResult<PathBuf> {
    let mut bytes = Vec::with_capacity(encoded.len()); let raw = encoded.as_bytes(); let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let pair = raw.get(index + 1..index + 3).ok_or_else(|| io("导出路径编码无效"))?;
            let pair = std::str::from_utf8(pair).map_err(io)?;
            bytes.push(u8::from_str_radix(pair, 16).map_err(io)?); index += 3;
        } else { bytes.push(raw[index]); index += 1; }
    }
    Ok(PathBuf::from(String::from_utf8(bytes).map_err(io)?))
}
fn write_export(path: &Path, bytes: &[u8], vault: Option<&Path>) -> TableResult<()> {
    if !path.is_absolute() || path.file_name().is_none() { return Err(TableError::new("INVALID_PATH", "导出路径无效", "")); }
    let parent = path.parent().ok_or_else(|| io("导出目录不存在"))?.canonicalize().map_err(io)?;
    let target = parent.join(path.file_name().unwrap());
    if let Some(vault) = vault {
        if target.starts_with(vault.canonicalize().map_err(io)?) { return Err(TableError::new("INVALID_PATH", "请选择资料库以外的导出位置", "")); }
    }
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() { return Err(TableError::new("INVALID_PATH", "导出目标不能是目录或符号链接", "")); }
    }
    let suffix = rand::random::<u128>();
    let temporary = parent.join(format!(".shard-export-{suffix:032x}.tmp"));
    let result = (|| {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(io)?;
        output.write_all(bytes).map_err(io)?; output.sync_all().map_err(io)?; drop(output);
        fs::rename(&temporary, &target).map_err(io)?;
        // macOS SavePanel grants the selected file, not permission to read its
        // parent directory. Opening that directory can block on privacy access
        // after export has already succeeded. Keep the synced file + atomic rename.
        #[cfg(not(target_os = "macos"))]
        if let Ok(parent) = fs::File::open(&parent) { let _ = parent.sync_all(); }
        Ok(())
    })();
    let _ = fs::remove_file(temporary); result
}
#[tauri::command]
pub async fn write_table_exchange_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> TableResult<()> {
    let encoded = request.headers().get("x-shard-export-path").and_then(|value| value.to_str().ok()).ok_or_else(|| io("缺少导出路径"))?;
    let path = decode_export_path(encoded)?; let bytes = raw_body(&request)?;
    background(move || {
        let vault = crate::configured_vault_path(&app).ok();
        write_export(&path, &bytes, vault.as_deref())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_is_atomic_and_rejects_vault_and_symlink_targets() {
        let dir = tempfile::tempdir().unwrap(); let vault = dir.path().join("vault"); fs::create_dir(&vault).unwrap();
        let path = dir.path().join("中文.csv"); fs::write(&path, "old").unwrap();
        write_export(&path, b"new", Some(&vault)).unwrap(); assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(write_export(&vault.join("copy.shardtable.json"), b"{}", Some(&vault)).is_err());
        #[cfg(unix)] { let link = dir.path().join("link.csv"); std::os::unix::fs::symlink(&path, &link).unwrap(); assert!(write_export(&link, b"bad", Some(&vault)).is_err()); }
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".shard-export-")));
        assert_eq!(decode_export_path("%2Ftmp%2F%E4%B8%AD%E6%96%87.csv").unwrap(), PathBuf::from("/tmp/中文.csv"));
        assert!(decode_export_path("%FF").is_err());
    }
}
