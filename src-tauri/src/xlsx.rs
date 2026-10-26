//! XLSX 导入为数据集。解析（字节 → 第一个工作表的字符串矩阵）在 `shard_vault::xlsx`，
//! 桌面与服务端共用，单元测试也在那里；这里只剩桌面专用的「按路径读外部文件」。
pub use shard_vault::xlsx::{read_xlsx_records, XlsxLimits, XlsxRecords};
use shard_vault::xlsx::{XlsxError, XlsxResult};
use std::{fs::File, io::Read, path::Path};

pub fn read_xlsx_file(path: &Path, limits: &XlsxLimits) -> XlsxResult<Vec<u8>> {
    let file = File::open(path).map_err(|e| XlsxError::new("IO_ERROR", e.to_string()))?;
    let mut bytes = Vec::new();
    file.take(limits.max_import_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| XlsxError::new("IO_ERROR", e.to_string()))?;
    if bytes.len() > limits.max_import_bytes {
        return Err(XlsxError::new("LIMIT_EXCEEDED", "XLSX 文件超过导入字节上限"));
    }
    Ok(bytes)
}
