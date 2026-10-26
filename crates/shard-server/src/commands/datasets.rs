//! CSV 数据集与 XLSX 导入。桌面外壳：`src-tauri/src/lib.rs` 的同名命令。

use serde::Deserialize;
use serde_json::Value;
use shard_core::dataset::DatasetOp;
use shard_vault::{
    apply_dataset_ops_in_vault, create_dataset_in_vault, normalize_csv_file_in_vault, read_csv_file_in_vault,
    read_dataset_in_vault,
    xlsx::{read_xlsx_records, XlsxLimits},
};

use super::{blob_missing, library::PathArgs, parse, read, to_json, valid_blob_sha, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("read_dataset", Access::Read, read_dataset)
        .register("apply_dataset_ops", Access::Write, apply_dataset_ops)
        .register("normalize_csv_file", Access::Write, normalize_csv_file)
        .register("create_dataset", Access::Write, create_dataset)
        .register("read_csv_file", Access::Read, read_csv_file)
        .register("read_import_xlsx_blob", Access::Read, read_import_xlsx_blob);
}

fn read_dataset(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    read(env, |cx| Ok(read_dataset_in_vault(cx, &args.path)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyOpsArgs {
    path: String,
    expected_sha: String,
    #[serde(default)]
    expected_schema_sha: Option<String>,
    ops: Vec<DatasetOp>,
}

/// 基线过期时领域错误是 `STALE_BASE:…`，映射成 409。
fn apply_dataset_ops(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ApplyOpsArgs = parse(args)?;
    write(env, |cx| {
        Ok(apply_dataset_ops_in_vault(
            cx,
            &args.path,
            &args.expected_sha,
            args.expected_schema_sha.as_deref(),
            &args.ops,
        )?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizeArgs {
    path: String,
    expected_sha: String,
}

fn normalize_csv_file(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: NormalizeArgs = parse(args)?;
    write(env, |cx| Ok(normalize_csv_file_in_vault(cx, &args.path, &args.expected_sha)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    title: String,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    #[serde(default)]
    primary_key: Option<String>,
}

fn create_dataset(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateArgs = parse(args)?;
    write(env, |cx| Ok(create_dataset_in_vault(cx, &args.title, args.header, args.rows, args.primary_key)?))
}

/// 整份 CSV 原始字节，JSON 里是 `number[]`，与桌面一致。
fn read_csv_file(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    read(env, |cx| Ok(read_csv_file_in_vault(cx, &args.path)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct XlsxBlobArgs {
    blob_sha: String,
}

/// 桌面 `read_import_xlsx_file` 的网页版：字节先上传到 blob 库，这里读第一个工作表成字符串矩阵。
/// 不碰资料库；大小与结构上限同桌面（`XlsxLimits::default()`），报错原文同桌面。
fn read_import_xlsx_blob(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: XlsxBlobArgs = parse(args)?;
    valid_blob_sha(&args.blob_sha)?;
    let bytes = env.store.get_blob(&args.blob_sha)?.ok_or_else(blob_missing)?;
    let records = read_xlsx_records(&bytes, &XlsxLimits::default()).map_err(|error| error.to_string())?;
    to_json(&records)
}
