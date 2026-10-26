//! 画布：独立流程图的新建、读、写，旧混合画布拆分，图文档列表。
//! 桌面外壳：`src-tauri/src/canvas_commands.rs` 与 `canvas_commands/split.rs`。桌面的 create/read/write
//! 走二进制 IPC（Worker 把参数对象 JSON 编码成字节、返回字节再解码）；网页端直接发同一个对象的 JSON，
//! 返回同一个对象。请求体上限与「不认识的字段一律拒绝」照桌面。

use std::io;

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use shard_core::graph_model::CanvasFile;
use shard_vault::canvas::{self, split};

use super::{parse, read, write, write_keeping_partial};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("create_canvas", Access::Write, create_canvas)
        .register("read_canvas", Access::Read, read_canvas)
        .register("write_canvas", Access::Write, write_canvas)
        .register("split_canvas", Access::Write, split_canvas)
        .register("list_diagram_documents", Access::Read, list_diagram_documents);
}

/// 只数字节的 writer：量请求的 JSON 大小，不再分配一份。
struct ByteCounter(usize);

impl io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 桌面 `request_bytes`：请求超过 8 MiB 内容上限（另留 16 KiB 给参数外壳）就拒绝。
fn canvas_args<T: DeserializeOwned>(args: Value) -> Result<T, RpcError> {
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, &args).map_err(RpcError::invalid_args)?;
    if counter.0 > canvas::MAX_BYTES + 16 * 1024 {
        return Err("画布请求超过 8 MiB 内容上限。".to_string().into());
    }
    parse(args)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    parent_path: String,
    title: String,
    file: CanvasFile,
}

fn create_canvas(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let request: CreateRequest = canvas_args(args)?;
    write(env, |cx| Ok(canvas::create_in_vault(cx, &request.parent_path, &request.title, request.file)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    path: String,
}

fn read_canvas(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let request: ReadRequest = canvas_args(args)?;
    read(env, |cx| Ok(canvas::read_in_vault(cx, &request.path)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    path: String,
    file: CanvasFile,
    expected_revision: u64,
    last_saved_hash: String,
}

/// 保存基线对不上时领域代码先在 `.shard/canvas/conflicts/` 写冲突副本再报错：出错也要提交。
fn write_canvas(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let request: WriteRequest = canvas_args(args)?;
    write_keeping_partial(env, |cx| {
        Ok(canvas::write_in_vault(cx, &request.path, request.file, request.expected_revision, &request.last_saved_hash)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitArgs {
    path: String,
    expected_revision: u64,
    last_saved_hash: String,
}

/// 拆分在桌面上是可续做的多步写入（回执先落盘）；这里整个拆分是一个事务，失败不留半成品，
/// 所以用普通的 `write`。
fn split_canvas(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SplitArgs = parse(args)?;
    write(env, |cx| Ok(split::split_in_vault(cx, &args.path, args.expected_revision, &args.last_saved_hash)?))
}

fn list_diagram_documents(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| Ok(split::list_in_vault(cx)?))
}
