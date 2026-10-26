//! 命令行（`shard` CLI）专用的命令。桌面没有对应的 Tauri 命令：这些是 CLI 本地模式里直接读写
//! vault 文件的那几步，挪到服务端在一个只读快照或一个写事务里完成。领域逻辑在
//! [`shard_vault::cli`]，CLI 本地模式调用同一份实现，两边对同一个输入给出同样的结果与报错。
//!
//! - 目标（`target`）：完整 id、vault 相对路径、id 中至少 4 个字符且唯一的片段。「上次搜索的序号」
//!   是客户端本地状态，CLI 换算成 id 后再发来。找不到 404 `NOT_FOUND`，多条命中 409 `AMBIGUOUS`。
//! - 只处理 `fragments/`、`notes/` 下能按文本读写的碎片与笔记；大纲、流程图走图命令，密匣不在这里。
//! - 写命令的基线不符返回 409 `STALE_BASE`；数据集表头变化 409 `HEADER_CHANGED`、主键冲突 409 `KEY_CONFLICT`。
//! - 改写与追加：先在只读快照里解析出目标的 id 与路径，写事务里只核对这一个文件（还在原处、仍是同一个 id），
//!   再按 `shard_vault::cli::rewrite_document` 读改写；期间被移走或移进回收站返回 404，不会改到别的文件。

use std::collections::HashMap;

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use shard_vault::{
    cli::{
        ambiguous_message, append_dataset_records, ensure_folder, ensure_plain_markdown, entry_still_at,
        join_appended, list_library_items, load_text_entries, not_found_message, prepare_note,
        read_document as read_text_document, resolve_target as resolve_text_target, rewrite_document, sort_recent,
        tag_counts, valid_source, write_note, DatasetAppendError, Resolved, ResolvedTarget, RewriteError,
        RewriteReport, TextDocument, TextEntry,
    },
    VaultCtx, STALE_BASE_ERROR,
};

use super::{parse, read, write};
use crate::rpc::{Access, Registry, RpcEnv, RpcError};

pub(super) fn register(registry: &mut Registry) {
    registry
        .register("resolve_target", Access::Read, resolve_target)
        .register("read_document", Access::Read, read_document)
        .register("append_document", Access::Write, append_document)
        .register("rewrite_document", Access::Write, rewrite_whole_document)
        .register("create_note", Access::Write, create_note)
        .register("list_tags", Access::Read, list_tags)
        .register("list_documents", Access::Read, list_documents)
        .register("list_library", Access::Read, list_library)
        .register("ensure_library_folder", Access::Write, ensure_library_folder)
        .register("append_dataset_records", Access::Write, append_records);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetArgs {
    target: String,
}

/// 在文本条目里解析目标；出错时的状态码与报错原文见模块说明。
fn find<'a>(entries: &'a [TextEntry], target: &str) -> Result<&'a TextEntry, RpcError> {
    match resolve_text_target(entries, target, None) {
        Resolved::Found(entry) => Ok(entry),
        Resolved::NotFound => Err(RpcError::new(StatusCode::NOT_FOUND, "NOT_FOUND", not_found_message(target))),
        Resolved::Ambiguous(matched) => {
            Err(RpcError::new(StatusCode::CONFLICT, "AMBIGUOUS", ambiguous_message(target, &matched)))
        }
    }
}

fn entries(cx: &VaultCtx<'_>) -> Result<Vec<TextEntry>, RpcError> {
    Ok(load_text_entries(cx.vfs)?)
}

/// `{target}` → `{id, path, kind}`。
fn resolve_target(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: TargetArgs = parse(args)?;
    read(env, |cx| Ok(ResolvedTarget::from_entry(find(&entries(cx)?, &args.target)?)))
}

/// `{target}` → `{id, path, kind, title, tags, createdAt, updatedAt, source, sha, body}`（同 `shard --read --json`）。
fn read_document(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: TargetArgs = parse(args)?;
    read(env, |cx| {
        let entries = entries(cx)?;
        Ok(read_text_document(cx.vfs, find(&entries, &args.target)?)?)
    })
}

/// 在只读快照里解析目标，得到 (id, vault 相对路径)。
fn resolve_in_snapshot(env: &RpcEnv<'_>, target: &str) -> Result<(String, String), RpcError> {
    env.read(|vfs| {
        let cx = env.vault(vfs);
        let entries = entries(&cx)?;
        let entry = find(&entries, target)?;
        Ok((entry.id.clone(), entry.path.clone()))
    })?
}

/// 改写一个已解析的条目：写事务里先核对它还在原处，再读改写（见模块说明）。
fn rewrite_resolved(
    env: &RpcEnv<'_>,
    target: &str,
    expected_sha: Option<&str>,
    next: impl FnOnce(&str) -> String,
) -> Result<Value, RpcError> {
    let (id, path) = resolve_in_snapshot(env, target)?;
    write(env, |cx| {
        if !entry_still_at(cx.vfs, &path, &id) {
            return Err(RpcError::new(StatusCode::NOT_FOUND, "NOT_FOUND", not_found_message(target)));
        }
        let written =
            rewrite_document(cx.vfs, &cx.root().join(&path), expected_sha, next, cx.now().to_rfc3339()).map_err(
                |error| match error {
                    RewriteError::Stale => RpcError::from(STALE_BASE_ERROR.to_string()),
                    RewriteError::Invalid(message) => RpcError::from(message),
                },
            )?;
        Ok(RewriteReport { id, path, tags: written.tags(), sha: written.sha, changed: written.changed })
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendArgs {
    target: String,
    /// 已按速记规则整理好的 Markdown（`#标签`、`/复选框` 由客户端展开）。
    text: String,
    #[serde(default)]
    expected_sha: Option<String>,
}

/// 追加到末尾：读、拼接、写在同一个事务里。末尾是列表、追加内容也以列表项开头时接成同一个列表，
/// 否则另起一段；正文里的 `#标签` 重新收进 frontmatter。返回 `{id, path, sha, changed, tags}`。
fn append_document(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: AppendArgs = parse(args)?;
    if args.text.trim().is_empty() {
        return Err("追加内容不能为空。".to_string().into());
    }
    ensure_plain_markdown(&args.text)?;
    let text = args.text;
    rewrite_resolved(env, &args.target, args.expected_sha.as_deref(), |current| join_appended(current, &text))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteArgs {
    target: String,
    /// 新的完整正文（不含 frontmatter）。
    body: String,
    /// 读取时拿到的整文件 sha，必填：不符返回 409，不覆盖。
    expected_sha: String,
}

/// 改写全文（CLI 的 `--update` 与交互编辑的保存）：语义同 App 编辑保存——正文里的 `#标签` 重新收进
/// frontmatter，type 标签保留，`updated_at` 刷新，其余 frontmatter 逐字节不动；正文没变不写（`changed:false`）。
/// 返回 `{id, path, sha, changed, tags}`。
fn rewrite_whole_document(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: RewriteArgs = parse(args)?;
    let body = args.body;
    rewrite_resolved(env, &args.target, Some(&args.expected_sha), |_| body)
}

/// 调用方给的 `source`（覆盖按设备种类记的来源）：去首尾空白，空当作没给；不合规返回 400。
pub(super) fn source_override(source: Option<&str>) -> Result<Option<String>, RpcError> {
    match source.map(str::trim).filter(|source| !source.is_empty()) {
        Some(source) if !valid_source(source) => {
            Err(RpcError::invalid_args("source 必须是不超过 40 个字符的单行名称"))
        }
        source => Ok(source.map(str::to_string)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNoteArgs {
    title: String,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    body: String,
    /// 速记里的前导 `#标签`（正文里已有，这里与本地模式一样再并进去一次）。
    #[serde(default)]
    tags: Vec<String>,
    /// 覆盖按设备种类记的来源（`--source`）。
    #[serde(default)]
    source: Option<String>,
}

/// 新建资料库笔记：文件夹（`项目/周会` 或 `notes/项目/周会`）不存在时自动创建，重名加 `-2`。
/// 返回 `{id, path, sha, tags}`。
fn create_note(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: CreateNoteArgs = parse(args)?;
    let source = source_override(args.source.as_deref())?.unwrap_or_else(|| env.source.to_string());
    let (body, tags) = prepare_note(&args.title, &args.body, args.tags)?;
    write(env, |cx| Ok(write_note(cx.vfs, &args.title, args.folder.as_deref(), &body, tags, &source, &cx.now())?))
}

/// `[{tag, count}]`：碎片与笔记的标签使用次数（不含 inbox 与 type 标签），按次数降序。
fn list_tags(env: &RpcEnv<'_>, _args: Value) -> Result<Value, RpcError> {
    read(env, |cx| {
        let entries = entries(cx)?;
        Ok(tag_counts(entries.iter().map(|entry| entry.tags.as_slice())))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDocumentsArgs {
    #[serde(default)]
    with_body: bool,
    #[serde(default)]
    limit: Option<usize>,
}

/// 全部文本条目，最近修改在前：`{total, documents: [{id, path, title, kind, tags, createdAt, updatedAt, body?}]}`。
/// CLI 不带关键词的 `-s` 用它列最近修改的；交互界面 `-i` / `-e` 带正文取全量，在本地搜索与编辑。
fn list_documents(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: ListDocumentsArgs = parse(args)?;
    read(env, |cx| {
        let mut entries = entries(cx)?;
        sort_recent(&mut entries);
        let total = entries.len();
        let documents = entries
            .iter()
            .take(args.limit.unwrap_or(usize::MAX))
            .map(|entry| TextDocument::from_entry(entry, args.with_body))
            .collect::<Vec<_>>();
        Ok(json!({ "total": total, "documents": documents }))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderArgs {
    #[serde(default)]
    folder: Option<String>,
}

/// 资料库目录（同 `shard --ls --json`）：`[{path, kind}]`，kind 为 folder / note / dataset / mindmap /
/// flowchart / canvas。给了文件夹只列它下面，没给时列 `notes/` 全部再加 `datasets/`。
fn list_library(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: FolderArgs = parse(args)?;
    read(env, |cx| Ok(list_library_items(cx.vfs, args.folder.as_deref())?))
}

/// 确保资料库文件夹存在（逐级创建），返回 `{path}`（资料库根为 `notes`）。
/// CLI 的 `--create-dataset --folder` 先调它，再调 `create_library_dataset`。
fn ensure_library_folder(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: FolderArgs = parse(args)?;
    write(env, |cx| {
        let folder = ensure_folder(cx.vfs, args.folder.as_deref())?;
        Ok(json!({ "path": folder.unwrap_or_else(|| "notes".to_string()) }))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRecordsArgs {
    path: String,
    expected_header: Vec<String>,
    records: Vec<HashMap<String, String>>,
}

/// 按主键幂等追加数据集记录（同 `shard --append-dataset`）：同主键同内容跳过，同主键不同内容整批拒绝。
/// 返回 `{appended, skipped, sha}`。
fn append_records(env: &RpcEnv<'_>, args: Value) -> Result<Value, RpcError> {
    let args: AppendRecordsArgs = parse(args)?;
    write(env, |cx| {
        append_dataset_records(cx.vfs, &args.path, &args.expected_header, args.records).map_err(|error| {
            let message = error.message();
            match error {
                DatasetAppendError::HeaderChanged => RpcError::new(StatusCode::CONFLICT, "HEADER_CHANGED", message),
                DatasetAppendError::KeyConflict => RpcError::new(StatusCode::CONFLICT, "KEY_CONFLICT", message),
                DatasetAppendError::Invalid(message) => RpcError::from(message),
            }
        })
    })
}
