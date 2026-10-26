//! 碎片里的大纲 / 流程图受管区域。桌面外壳：`src-tauri/src/lib.rs` 的同名命令。

use serde::Deserialize;
use serde_json::Value;
use shard_vault::{
    create_graph_fragment_in_vault, import_graph_file_to_timeline_in_vault, read_graph_fragment_in_vault,
    write_graph_fragment_in_vault,
};

use super::{parse, read, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("create_graph_fragment", Access::Write, create_graph_fragment)
        .register("read_graph_fragment", Access::Read, read_graph_fragment)
        .register("write_graph_fragment", Access::Write, write_graph_fragment)
        .register("import_graph_file_to_timeline", Access::Write, import_graph_file_to_timeline);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    kind: String,
    operation_id: String,
    #[serde(default)]
    graph: Option<Value>,
    tags: Vec<String>,
}

/// 新标签含密匣时领域代码返回「大纲与流程图不能放入密匣」，与桌面一致（不是密匣分支）。
fn create_graph_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateArgs = parse(args)?;
    write(env, |cx| Ok(create_graph_fragment_in_vault(cx, &args.kind, &args.operation_id, args.graph, args.tags)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

fn read_graph_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: IdArgs = parse(args)?;
    read(env, |cx| Ok(read_graph_fragment_in_vault(cx, &args.id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteArgs {
    id: String,
    graph: Value,
    #[serde(default)]
    expected_file_sha: Option<String>,
}

fn write_graph_fragment(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: WriteArgs = parse(args)?;
    write(env, |cx| Ok(write_graph_fragment_in_vault(cx, &args.id, args.graph, args.expected_file_sha.as_deref())?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

fn import_graph_file_to_timeline(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    write(env, |cx| Ok(import_graph_file_to_timeline_in_vault(cx, &args.path)?))
}
