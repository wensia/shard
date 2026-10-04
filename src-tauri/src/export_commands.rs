//! Writes user-chosen export files outside the vault (atomic replace, no symlinks).
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

fn io(error: impl ToString) -> String {
    error.to_string()
}
fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_EXPORT_BYTES => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Raw(_) => Err("导出内容超过 64 MiB".into()),
        _ => Err("导出需要二进制内容".into()),
    }
}
fn decode_export_path(encoded: &str) -> Result<PathBuf, String> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let raw = encoded.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let pair = raw
                .get(index + 1..index + 3)
                .ok_or_else(|| io("导出路径编码无效"))?;
            let pair = std::str::from_utf8(pair).map_err(io)?;
            bytes.push(u8::from_str_radix(pair, 16).map_err(io)?);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    Ok(PathBuf::from(String::from_utf8(bytes).map_err(io)?))
}
fn write_export(path: &Path, bytes: &[u8], vault: Option<&Path>) -> Result<(), String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("导出路径无效".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| io("导出目录不存在"))?
        .canonicalize()
        .map_err(io)?;
    let target = parent.join(path.file_name().unwrap());
    if let Some(vault) = vault {
        if target.starts_with(vault.canonicalize().map_err(io)?) {
            return Err("请选择资料库以外的导出位置".into());
        }
    }
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("导出目标不能是目录或符号链接".into());
        }
    }
    let suffix = rand::random::<u128>();
    let temporary = parent.join(format!(".shard-export-{suffix:032x}.tmp"));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(io)?;
        output.write_all(bytes).map_err(io)?;
        output.sync_all().map_err(io)?;
        drop(output);
        fs::rename(&temporary, &target).map_err(io)?;
        // macOS SavePanel grants the selected file, not permission to read its
        // parent directory. Opening that directory can block on privacy access
        // after export has already succeeded. Keep the synced file + atomic rename.
        #[cfg(not(target_os = "macos"))]
        if let Ok(parent) = fs::File::open(&parent) {
            let _ = parent.sync_all();
        }
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
#[tauri::command]
pub async fn write_export_file(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-shard-export-path")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| io("缺少导出路径"))?;
    let path = decode_export_path(encoded)?;
    let bytes = raw_body(&request)?;
    crate::run_blocking(move || {
        let vault = match crate::configured_vault_path(&app) {
            Ok(vault) => Some(vault),
            Err(error) if error == "vault_not_configured" => None,
            Err(error) => return Err(error),
        };
        write_export(&path, &bytes, vault.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_is_atomic_and_rejects_vault_and_symlink_targets() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let path = dir.path().join("中文.csv");
        fs::write(&path, "old").unwrap();
        write_export(&path, b"new", Some(&vault)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(write_export(&vault.join("copy.csv"), b"{}", Some(&vault)).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link.csv");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(write_export(&link, b"bad", Some(&vault)).is_err());
        }
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".shard-export-")));
        assert_eq!(
            decode_export_path("%2Ftmp%2F%E4%B8%AD%E6%96%87.csv").unwrap(),
            PathBuf::from("/tmp/中文.csv")
        );
        assert!(decode_export_path("%FF").is_err());
    }
}
