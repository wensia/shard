//! 思维导图：新建、读、写、删除。桌面外壳：`src-tauri/src/lib.rs` 的同名命令。

use serde::Deserialize;
use serde_json::Value;
use shard_core::graph_model::ShardMapFile;
use shard_vault::{
    create_mind_map_at_in_vault, delete_mind_map_in_vault, list_mind_maps_in_vault, read_mind_map_in_vault,
    write_mind_map_in_vault,
};

use super::{parse, read, write, write_keeping_partial};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("create_mind_map", Access::Write, create_mind_map)
        .register("read_mind_map", Access::Read, read_mind_map)
        .register("write_mind_map", Access::Write, write_mind_map)
        .register("delete_mind_map", Access::Write, delete_mind_map);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    title: String,
    #[serde(default)]
    source_fragment_id: Option<String>,
    #[serde(default)]
    parent_path: Option<String>,
}

fn create_mind_map(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateArgs = parse(args)?;
    write(env, |cx| {
        Ok(create_mind_map_at_in_vault(cx, args.title, args.source_fragment_id, args.parent_path.as_deref())?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

fn read_mind_map(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: IdArgs = parse(args)?;
    read(env, |cx| Ok(read_mind_map_in_vault(cx, &args.id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteArgs {
    id: String,
    file: ShardMapFile,
    expected_revision: u64,
    last_saved_hash: String,
}

/// 保存基线对不上时领域代码先在 `maps/.conflicts/` 写冲突副本再报错：出错也要提交，副本才留得下。
fn write_mind_map(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: WriteArgs = parse(args)?;
    write_keeping_partial(env, |cx| {
        Ok(write_mind_map_in_vault(cx, &args.id, args.file, args.expected_revision, &args.last_saved_hash)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArgs {
    id: String,
    expected_revision: u64,
}

/// 返回删除后的导图列表，与桌面一致。
fn delete_mind_map(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: DeleteArgs = parse(args)?;
    write(env, |cx| {
        delete_mind_map_in_vault(cx, &args.id, args.expected_revision)?;
        Ok(list_mind_maps_in_vault(cx)?)
    })
}
