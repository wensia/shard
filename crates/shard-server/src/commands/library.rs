//! 资料库树：列表、新建笔记 / 数据集 / 目录、改名、移动、删除（移入回收站）。
//! 桌面外壳：`src-tauri/src/lib.rs` 的同名命令。桌面在门外重建资料库树，这里在同一个事务里建，
//! 返回的树与这次写入一致。

use serde::Deserialize;
use serde_json::Value;
use shard_vault::{
    build_library_tree, create_library_dataset_in_vault, create_library_directory_in_vault,
    create_library_note_in_vault, library_mutation_result, list_csv_files_in_vault, list_mind_maps_in_vault,
    move_library_entry_in_vault, move_to_trash_in_vault, rename_library_entry_in_vault, LibraryDatasetResult,
};

use super::{cli::source_override, parse, read, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("list_library_tree", Access::Read, list_library_tree)
        .register("list_mind_maps", Access::Read, list_mind_maps)
        .register("list_csv_files", Access::Read, list_csv_files)
        .register("create_library_note", Access::Write, create_library_note)
        .register("create_library_dataset", Access::Write, create_library_dataset)
        .register("create_library_directory", Access::Write, create_library_directory)
        .register("rename_library_entry", Access::Write, rename_library_entry)
        .register("move_library_entry", Access::Write, move_library_entry)
        .register("delete_library_entry", Access::Write, delete_library_entry);
}

fn list_library_tree(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| Ok(build_library_tree(cx)?))
}

fn list_mind_maps(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| Ok(list_mind_maps_in_vault(cx)?))
}

fn list_csv_files(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| Ok(list_csv_files_in_vault(cx)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNoteArgs {
    title: String,
    #[serde(default)]
    parent_path: Option<String>,
}

fn create_library_note(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateNoteArgs = parse(args)?;
    write(env, |cx| {
        let fragment = create_library_note_in_vault(cx, &args.title, args.parent_path.as_deref())?;
        Ok(library_mutation_result(cx, Some(fragment), 0)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDatasetArgs {
    title: String,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    #[serde(default)]
    primary_key: Option<String>,
    #[serde(default)]
    parent_path: Option<String>,
    /// 覆盖说明笔记按调用方记的来源（命令行的 `--source`）。桌面没有这个参数。
    #[serde(default)]
    source: Option<String>,
}

fn create_library_dataset(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateDatasetArgs = parse(args)?;
    let source = source_override(args.source.as_deref())?;
    write(env, |cx| {
        let cx = match source.as_deref() {
            Some(source) => cx.with_clock(cx.offset, source),
            None => *cx,
        };
        let (dataset, fragment) = create_library_dataset_in_vault(
            &cx,
            &args.title,
            args.header,
            args.rows,
            args.primary_key,
            args.parent_path.as_deref(),
        )?;
        Ok(LibraryDatasetResult { dataset, library: library_mutation_result(&cx, Some(fragment), 0)? })
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirectoryArgs {
    name: String,
    #[serde(default)]
    parent_path: Option<String>,
}

fn create_library_directory(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateDirectoryArgs = parse(args)?;
    write(env, |cx| {
        create_library_directory_in_vault(cx, &args.name, args.parent_path.as_deref())?;
        Ok(library_mutation_result(cx, None, 0)?)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    path: String,
    new_name: String,
}

/// 改名同时改写 wikilink、Markdown 图片与 CSV 单元格里的引用（同一个事务）。
fn rename_library_entry(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: RenameArgs = parse(args)?;
    write(env, |cx| {
        let (fragment, updated_links, updated_image_refs) = rename_library_entry_in_vault(cx, &args.path, &args.new_name)?;
        let mut result = library_mutation_result(cx, fragment, updated_links)?;
        result.updated_image_refs = updated_image_refs;
        Ok(result)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    path: String,
    #[serde(default)]
    destination_directory: Option<String>,
}

fn move_library_entry(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: MoveArgs = parse(args)?;
    write(env, |cx| {
        let updated_image_refs = move_library_entry_in_vault(cx, &args.path, args.destination_directory.as_deref())?;
        let mut result = library_mutation_result(cx, None, 0)?;
        result.updated_image_refs = updated_image_refs;
        Ok(result)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PathArgs {
    pub(super) path: String,
}

fn delete_library_entry(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    write(env, |cx| {
        move_to_trash_in_vault(cx, &args.path)?;
        Ok(library_mutation_result(cx, None, 0)?)
    })
}
