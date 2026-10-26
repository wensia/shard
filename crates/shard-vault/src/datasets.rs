//! CSV 数据集。写操作由调用方持写门。

use crate::prelude::*;

pub fn read_dataset_in_vault(cx: &VaultCtx<'_>, path: &str) -> Result<DatasetSnapshot, String> {
    dataset::read_dataset(cx.vfs, path, &DatasetLimits::default())
        .map_err(|error| error.to_string())
}

/// 调用方持写门（原来在函数里取门，搬迁后挪到命令层，持门范围不变：整个函数体）。
pub fn apply_dataset_ops_in_vault(
    cx: &VaultCtx<'_>,
    path: &str,
    expected_sha: &str,
    expected_schema_sha: Option<&str>,
    ops: &[DatasetOp],
) -> Result<DatasetSnapshot, String> {
    dataset::write_dataset_ops(
        cx.vfs,
        path,
        expected_sha,
        expected_schema_sha,
        ops,
        &DatasetLimits::default(),
    )
    .map_err(|error| error.to_string())
}

/// 调用方持写门（同 [`apply_dataset_ops_in_vault`]）。
pub fn create_dataset_in_vault(
    cx: &VaultCtx<'_>,
    title: &str,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    primary_key: Option<String>,
) -> Result<DatasetSnapshot, String> {
    dataset::create_dataset(
        cx.vfs,
        title,
        header,
        rows,
        primary_key,
        &DatasetLimits::default(),
    )
    .map_err(|error| error.to_string())
}

/// 用户确认后把 GBK/UTF-16 或列数不齐的 CSV 转换成可编辑的 UTF-8 文件。调用方持写门。
pub fn normalize_csv_file_in_vault(
    cx: &VaultCtx<'_>,
    path: &str,
    expected_sha: &str,
) -> Result<DatasetSnapshot, String> {
    let snapshot =
        dataset::normalize_csv_file(cx.vfs, path, expected_sha, &DatasetLimits::default())
            .map_err(|error| error.to_string())?;
    cx.hooks
        .commit_paths_best_effort(&[path.trim().to_string()], "convert csv to utf-8");
    Ok(snapshot)
}

/// 嵌入预览要的整份 CSV 原始字节；超过数据集上限的文件只给出提示，不拖垮界面。
pub fn read_csv_file_in_vault(cx: &VaultCtx<'_>, path: &str) -> Result<Vec<u8>, String> {
    let vfs = cx.vfs;
    let csv_path = ensure_public_csv_path(vfs, path)?;
    let limit = DatasetLimits::default().max_file_bytes as u64;
    if vfs.metadata(&csv_path).map_err(|error| error.to_string())?.len() > limit {
        return Err(format!("CSV 超过 {} MiB，请用「编辑」或默认程序打开", limit / 1024 / 1024));
    }
    vfs.read(&csv_path).map_err(|error| error.to_string())
}
