//! 公开内容的 RPC 命令：名字、参数、返回值与桌面 Tauri 命令一一对应（桌面外壳在
//! `src-tauri/src/lib.rs`、`canvas_commands.rs`），网页端只是把 IPC 换成了 HTTP。
//!
//! - 参数：Tauri 2 把 Rust 参数名转成驼峰作为 JSON 键，这里的参数结构体一律 `camelCase`；
//!   桌面是 `Option` 的参数在这里 `#[serde(default)]`，缺省与 `null` 都当作没有。多余的键忽略（与 Tauri 一致）。
//! - 返回值：直接序列化 shard-vault 的 DTO，与桌面同形。
//! - 写命令一个事务，出错整体回滚；导图、画布保存先写冲突副本再报错，用 `write_keeping_partial`。
//! - 写门：内容库单写者事务天然串行，不需要桌面的 vault 门。
//! - 密匣：服务器永不解密。桌面会走密匣分支的情况一律返回 409 `LOCKBOX_UNAVAILABLE`。

mod canvas;
mod cli;
mod datasets;
mod fragments;
mod graph;
mod images;
mod library;
mod maps;
mod trash;

use axum::http::StatusCode;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use shard_core::Vfs;
use shard_store::{SqliteVfs, Store, WriteCtx};
use shard_vault::VaultCtx;

use crate::rpc::{Registry, RpcEnv, RpcError};

/// 注册全部公开内容命令（搜索另行注册）。
pub fn register(registry: &mut Registry) {
    fragments::register(registry);
    graph::register(registry);
    library::register(registry);
    trash::register(registry);
    images::register(registry);
    maps::register(registry);
    canvas::register(registry);
    datasets::register(registry);
    cli::register(registry);
}

/// 资料库骨架目录齐全（与桌面 `vault_layout_is_complete` 同一份清单）。
fn layout_complete(vfs: &dyn Vfs) -> bool {
    let vault = vfs.root();
    ["fragments", "notes", "assets", "maps", "datasets", ".shard"]
        .iter()
        .all(|directory| vfs.is_dir(&vault.join(directory)))
        && vfs.is_file(&vault.join("datasets/.gitattributes"))
}

/// 桌面 `ensure_vault_dirs` 的等价物，在写事务里调用：骨架不全就补齐。
fn ensure_layout_in(vfs: &dyn Vfs) -> Result<(), String> {
    if layout_complete(vfs) {
        return Ok(());
    }
    shard_core::ensure_vault_layout(vfs)
}

/// 启动时补齐资料库骨架：桌面每个命令进门先 `ensure_vault_dirs`，服务端的读命令跑在只读快照里
/// 建不了目录，所以全新的内容库要在开服时建好（否则资料库树读 `notes/` 就失败）。已齐全时不写。
pub fn ensure_layout(store: &Store) -> Result<(), String> {
    if store.read(|vfs| layout_complete(vfs)).map_err(|error| error.to_string())? {
        return Ok(());
    }
    store
        .write(&WriteCtx::new("ensure_layout", "server"), |vfs| shard_core::ensure_vault_layout(vfs))
        .map(|_| ())
}

/// 解析命令参数（JSON 对象 → 参数结构体）。
fn parse<T: DeserializeOwned>(args: Value) -> Result<T, RpcError> {
    serde_json::from_value(args).map_err(RpcError::invalid_args)
}

fn to_json<T: Serialize>(value: &T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|error| {
        tracing::error!(%error, "命令结果序列化失败");
        RpcError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "服务器出错了，请稍后再试。")
    })
}

/// 密匣分支：服务器拿不到明文，端到端加密前统一拒绝。
fn lockbox_unavailable() -> RpcError {
    RpcError::new(StatusCode::CONFLICT, "LOCKBOX_UNAVAILABLE", "密匣内容暂时只能在桌面端处理。")
}

/// 上传的 blob 取不到：客户端没传上来（或传错了 sha）。
fn blob_missing() -> RpcError {
    RpcError::new(StatusCode::BAD_REQUEST, "BLOB_MISSING", "找不到已上传的文件内容，请重新上传。")
}

fn valid_blob_sha(sha: &str) -> Result<(), RpcError> {
    if sha.len() == 64 && sha.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(RpcError::invalid_args("blobSha 必须是 64 位小写十六进制。"))
    }
}

/// 读命令：只读快照上的领域调用。
fn read<T: Serialize>(
    env: &RpcEnv<'_>,
    f: impl FnOnce(&VaultCtx<'_>) -> Result<T, RpcError>,
) -> Result<Value, RpcError> {
    env.read(|vfs| {
        let cx = env.vault(vfs);
        f(&cx).and_then(|value| to_json(&value))
    })?
}

/// 读命令，需要直接用到内容库（密匣 manifest 等不在 Vfs 接口上的东西）。
fn read_store<T: Serialize>(
    env: &RpcEnv<'_>,
    f: impl FnOnce(&SqliteVfs<'_>, &VaultCtx<'_>) -> Result<T, RpcError>,
) -> Result<Value, RpcError> {
    env.read(|vfs| {
        let cx = env.vault(vfs);
        f(vfs, &cx).and_then(|value| to_json(&value))
    })?
}

/// 写命令：一个事务，出错整体回滚。
fn write<T: Serialize>(
    env: &RpcEnv<'_>,
    f: impl FnOnce(&VaultCtx<'_>) -> Result<T, RpcError>,
) -> Result<Value, RpcError> {
    env.write(|vfs| {
        ensure_layout_in(vfs)?;
        let cx = env.vault(vfs);
        to_json(&f(&cx)?)
    })
}

/// 写命令，出错也提交：领域代码先写下冲突副本再返回错误（导图、画布保存）。
fn write_keeping_partial<T: Serialize>(
    env: &RpcEnv<'_>,
    f: impl FnOnce(&VaultCtx<'_>) -> Result<T, RpcError>,
) -> Result<Value, RpcError> {
    env.write_keeping_partial(|vfs| {
        ensure_layout_in(vfs)?;
        let cx = env.vault(vfs);
        to_json(&f(&cx)?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_public_command_is_registered_once() {
        let mut registry = Registry::default();
        register(&mut registry);
        let expected = [
            "append_dataset_records",
            "append_document",
            "apply_dataset_ops",
            "convert_fragment_to_note",
            "convert_note_to_fragment",
            "create_canvas",
            "create_dataset",
            "create_fragment",
            "create_graph_fragment",
            "create_library_dataset",
            "create_library_directory",
            "create_library_note",
            "create_mind_map",
            "create_note",
            "delete_library_entry",
            "delete_mind_map",
            "empty_trash",
            "ensure_library_folder",
            "existing_vault_images",
            "image_references",
            "import_graph_file_to_timeline",
            "import_library_blobs",
            "link_fragments",
            "list_csv_files",
            "list_diagram_documents",
            "list_documents",
            "list_fragments",
            "list_library",
            "list_library_tree",
            "list_markdown_dialect_migration",
            "list_mind_maps",
            "list_tags",
            "move_fragment_to_lockbox",
            "move_library_entry",
            "normalize_csv_file",
            "purge_from_trash",
            "read_canvas",
            "read_csv_file",
            "read_dataset",
            "read_document",
            "read_fragment_image",
            "read_graph_fragment",
            "read_import_xlsx_blob",
            "read_mind_map",
            "read_property_registry",
            "register_property_type",
            "remove_fragment_property",
            "rename_library_entry",
            "resolve_target",
            "restore_from_trash",
            "rewrite_document",
            "save_fragment_image",
            "set_fragment_archived",
            "set_fragment_pinned",
            "set_fragment_property",
            "split_canvas",
            "unlink_fragments",
            "update_fragment",
            "update_fragment_tags",
            "write_canvas",
            "write_graph_fragment",
            "write_mind_map",
        ];
        assert_eq!(registry.names(), expected);
    }
}
