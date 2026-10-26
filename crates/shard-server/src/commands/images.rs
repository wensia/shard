//! 图片：附件保存、资料库命名图片导入、引用查询、读成 data URL。
//! 桌面外壳：`src-tauri/src/lib.rs` 的同名命令。桌面走原始字节 IPC 或按磁盘路径读；网页端先把字节
//! PUT 到 `/api/blobs/<sha>`，命令里只带 sha，这里从 blob 库取。

use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    path::Path,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
use shard_vault::{
    build_library_tree, existing_vault_images_in, image_mime_type, image_references_in_vault,
    image_too_large_message, import_library_images_in_vault_with, resolve_vault_asset_path, sniff_image_mime_type,
    store_image_attachment, LibraryImportResult, MAX_IMAGE_BYTES,
};

use super::{blob_missing, library::PathArgs, parse, read, valid_blob_sha, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("save_fragment_image", Access::Write, save_fragment_image)
        .register("import_library_blobs", Access::Write, import_library_blobs)
        .register("image_references", Access::Read, image_references)
        .register("existing_vault_images", Access::Read, existing_vault_images)
        .register("read_fragment_image", Access::Read, read_fragment_image);
}

/// 网页端 `{ fileName, blobSha }`。`fileName` 与桌面一样只作参考，存储名按内容寻址。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageArgs {
    blob_sha: String,
}

/// 返回 vault 相对路径（`assets/<hh>/<sha256>.<ext>`），与桌面相同。大小上限、空内容、
/// 格式识别都由 `store_image_attachment` 判定（与桌面同一份）。
fn save_fragment_image(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: SaveImageArgs = parse(args)?;
    valid_blob_sha(&args.blob_sha)?;
    let bytes = env.store.get_blob(&args.blob_sha)?.ok_or_else(blob_missing)?;
    write(env, |cx| Ok(store_image_attachment(cx, &bytes)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedFile {
    name: String,
    blob_sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBlobsArgs {
    files: Vec<UploadedFile>,
    #[serde(default)]
    directory: Option<String>,
}

/// 桌面 `import_library_files` 的网页版：按原文件名放进资料库目录（缺省 `notes/` 根），重名加 `-2`。
/// 逐个导入，单个文件不是图片或超限只记入 `skipped`（`path` 是上传时的文件名），与桌面一致。
fn import_library_blobs(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ImportBlobsArgs = parse(args)?;
    // 先确认字节都传上来了：缺 blob 是客户端协议错误，整个请求拒绝。内容在事务里逐个取，
    // 一次只在内存里放一张图。
    for file in &args.files {
        valid_blob_sha(&file.blob_sha)?;
        if !env.store.has_blob(&file.blob_sha)? {
            return Err(blob_missing());
        }
    }
    let names: Vec<String> = args.files.iter().map(|file| file.name.clone()).collect();
    // 领域函数按名字回调取字节；同名文件按出现顺序各取各的。
    let mut queues: HashMap<String, VecDeque<String>> = HashMap::new();
    for file in args.files {
        queues.entry(file.name).or_default().push_back(file.blob_sha);
    }
    let queues = RefCell::new(queues);
    let read_source = |source: &Path| -> Result<Vec<u8>, String> {
        let name = source.to_string_lossy();
        let sha = queues
            .borrow_mut()
            .get_mut(name.as_ref())
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| "找不到已上传的图片内容".to_string())?;
        let bytes = env
            .store
            .get_blob(&sha)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "找不到已上传的图片内容".to_string())?;
        // 与桌面 `read_external_image` 同样的两道检查：大小上限，确实是图片。
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(image_too_large_message());
        }
        sniff_image_mime_type(&bytes)?;
        Ok(bytes)
    };
    write(env, |cx| {
        let (imported, skipped) =
            import_library_images_in_vault_with(cx, &names, args.directory.as_deref(), &read_source)?;
        Ok(LibraryImportResult { tree: build_library_tree(cx)?, imported, skipped })
    })
}

fn image_references(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    read(env, |cx| Ok(image_references_in_vault(cx, &args.path)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsArgs {
    paths: Vec<String>,
}

fn existing_vault_images(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathsArgs = parse(args)?;
    read(env, |cx| Ok(existing_vault_images_in(cx.vfs, args.paths)))
}

/// `data:<mime>;base64,…`，导出分享图时把正文里的图片内联进去。
fn read_fragment_image(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: PathArgs = parse(args)?;
    read(env, |cx| {
        let image_path = resolve_vault_asset_path(cx.vfs, &args.path)?;
        let bytes = cx.vfs.read(&image_path).map_err(|error| error.to_string())?;
        let mime_type = image_mime_type(&image_path, &bytes)?;
        Ok(format!("data:{mime_type};base64,{}", STANDARD.encode(bytes)))
    })
}
