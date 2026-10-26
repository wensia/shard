//! 回收站：恢复、彻底删除、清空。桌面外壳：`src-tauri/src/lib.rs` 的同名命令。

use serde::Deserialize;
use serde_json::Value;
use shard_vault::{
    empty_trash_in_vault, library_mutation_result, purge_from_trash_in_vault, restore_from_trash_in_vault,
    ContentScope,
};

use super::{library::PathArgs, parse, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("restore_from_trash", Access::Write, restore_from_trash)
        .register("purge_from_trash", Access::Write, purge_from_trash)
        .register("empty_trash", Access::Write, empty_trash);
}

fn restore_from_trash(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    write(env, |cx| {
        restore_from_trash_in_vault(cx, &args.path)?;
        Ok(library_mutation_result(cx, None, 0)?)
    })
}

fn purge_from_trash(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    write(env, |cx| {
        purge_from_trash_in_vault(cx, &args.path)?;
        Ok(library_mutation_result(cx, None, 0)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmptyTrashArgs {
    #[serde(default)]
    scope: Option<ContentScope>,
}

fn empty_trash(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: EmptyTrashArgs = parse(args)?;
    write(env, |cx| {
        empty_trash_in_vault(cx, args.scope.unwrap_or_default())?;
        Ok(library_mutation_result(cx, None, 0)?)
    })
}
