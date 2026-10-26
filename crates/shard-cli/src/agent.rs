//! 给 AI 助手与脚本用的非交互命令：按 id 读写碎片与资料库笔记、追加、建笔记、
//! 列标签与目录、读写数据集。
//!
//! 输出默认是人能读的文本；带 `--json` 时 stdout 只有一个 JSON 值，失败时由 `main`
//! 把错误以 `{"error":{"code","message"}}` 写到 stderr。写入一律持资料库进程锁，
//! 改写已有内容要带读取时拿到的 `sha`，期间被改过就拒绝（退出码 2），不会覆盖。
//!
//! 这里是本地模式（直接读写 vault 目录）；远程模式在 `remote::ops`，两边共用领域逻辑
//! （`shard_vault::cli`）与这里的输出函数，同一条命令输出同样的文本与 JSON。

use crate::{
    edit::{self, RewriteError},
    find::{self, FragmentEntry},
    parse, CliError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shard_core::{
    dataset::{read_dataset, serialize_csv, DatasetLimits, DatasetSnapshot},
    library::create_library_dataset_files,
    vault_lock::VaultProcessLock,
    FsVfs,
};
use shard_vault::cli::{
    ambiguous_message, ensure_folder, join_appended, list_local_library_items, not_found_message, prepare_note,
    read_document, tag_counts, write_note, DocumentView, LibraryItem, Resolved, RewriteReport, TagCount,
};
use std::{
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub enum Command {
    Read { target: String },
    Update { target: String, expect: String },
    Append { target: String, expect: Option<String>, content: Vec<String> },
    Note { title: String, folder: Option<String>, content: Vec<String> },
    Tags,
    List { folder: Option<String> },
    ReadDataset { path: String },
    CreateDataset { title: String, folder: Option<String> },
}

pub struct Context {
    pub vault: PathBuf,
    pub lock_dir: PathBuf,
    pub timeout: Duration,
    pub json: bool,
    pub source: String,
}

impl Context {
    fn lock(&self) -> Result<VaultProcessLock, CliError> {
        VaultProcessLock::acquire(&self.lock_dir, &self.vault, Some(self.timeout))
            .map_err(lock_error)
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.vault)
            .unwrap_or(path)
            .display()
            .to_string()
    }

    fn vfs(&self) -> FsVfs {
        FsVfs::new(&self.vault)
    }
}

pub fn run(command: Command, context: &Context) -> Result<(), CliError> {
    match command {
        Command::Read { target } => read(context, &target),
        Command::Update { target, expect } => update(context, &target, &expect),
        Command::Append {
            target,
            expect,
            content,
        } => append(context, &target, expect.as_deref(), &content),
        Command::Note {
            title,
            folder,
            content,
        } => note(context, &title, folder.as_deref(), &content),
        Command::Tags => tags(context),
        Command::List { folder } => list(context, folder.as_deref()),
        Command::ReadDataset { path } => read_dataset_command(context, &path),
        Command::CreateDataset { title, folder } => {
            create_dataset(context, &title, folder.as_deref())
        }
    }
}

// ---------------------------------------------------------------------------
// 读取与改写
// ---------------------------------------------------------------------------

fn read(context: &Context, target: &str) -> Result<(), CliError> {
    let entries = find::load_entries(&context.vault)?;
    let entry = resolve(&entries, &context.vault, target)?;
    let document = read_document(&context.vfs(), entry)?;
    print_document(context.json, &document);
    Ok(())
}

fn update(context: &Context, target: &str, expect: &str) -> Result<(), CliError> {
    let body = read_update_body()?;
    let entries = find::load_entries(&context.vault)?;
    let entry = resolve(&entries, &context.vault, target)?;
    let written = edit::rewrite_body(
        &context.vault,
        &context.vault.join(&entry.path),
        Some(expect),
        |_| body.clone(),
        &context.lock_dir,
        context.timeout,
    )
    .map_err(rewrite_error)?;
    report_rewrite(context, entry, written)
}

fn append(
    context: &Context,
    target: &str,
    expect: Option<&str>,
    content: &[String],
) -> Result<(), CliError> {
    let addition = read_addition(content)?;
    let entries = find::load_entries(&context.vault)?;
    let entry = resolve(&entries, &context.vault, target)?;
    let written = edit::rewrite_body(
        &context.vault,
        &context.vault.join(&entry.path),
        expect,
        |current| join_appended(current, &addition),
        &context.lock_dir,
        context.timeout,
    )
    .map_err(rewrite_error)?;
    report_rewrite(context, entry, written)
}

/// `--update` 的新正文：标准输入，不能带 frontmatter。
pub fn read_update_body() -> Result<String, CliError> {
    let body = read_stdin("--update 从标准输入读取新正文")?;
    ensure_plain_markdown(&body)?;
    Ok(body)
}

/// `--append` 的追加内容：参数按速记规则展开（`#标签`、`/复选框`），没有参数时读标准输入。
pub fn read_addition(content: &[String]) -> Result<String, CliError> {
    let (addition, _) = parse::compose(&capture(content)?)?;
    ensure_plain_markdown(&addition)?;
    Ok(addition)
}

fn report_rewrite(
    context: &Context,
    entry: &FragmentEntry,
    written: edit::Rewritten,
) -> Result<(), CliError> {
    print_rewrite(
        context.json,
        &RewriteReport {
            id: entry.id.clone(),
            path: entry.path.clone(),
            tags: written.tags(),
            sha: written.sha,
            changed: written.changed,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 资料库笔记
// ---------------------------------------------------------------------------

fn note(
    context: &Context,
    title: &str,
    folder: Option<&str>,
    content: &[String],
) -> Result<(), CliError> {
    let (body, tags) = note_input(title, content)?;
    let _lock = context.lock()?;
    let created = write_note(
        &context.vfs(),
        title,
        folder,
        &body,
        tags,
        &context.source,
        &chrono::Local::now().fixed_offset(),
    )?;
    print_created(context.json, &created.id, &created.path, &created.sha, &created.tags);
    Ok(())
}

/// `--note` 的正文与标签：速记规则展开后补一级标题，标签 = 前导标签 + inbox + 正文标签（与 App 一致）。
/// 返回 (落盘正文, 标签)，也用来在远程模式下发请求前就拒绝密匣与手写 frontmatter。
pub fn note_input(title: &str, content: &[String]) -> Result<(String, Vec<String>), CliError> {
    let (body, tags) = note_parts(content)?;
    Ok(prepare_note(title, &body, tags)?)
}

/// 速记展开后的笔记正文与前导标签（内容为空时都为空）。
pub fn note_parts(content: &[String]) -> Result<(String, Vec<String>), CliError> {
    let capture = capture(content)?;
    if capture.text.trim().is_empty() && capture.tags.is_empty() {
        Ok((String::new(), Vec::new()))
    } else {
        Ok(parse::compose(&capture)?)
    }
}

fn tags(context: &Context) -> Result<(), CliError> {
    let entries = find::load_entries(&context.vault)?;
    print_tags(context.json, &tag_counts(entries.iter().map(|entry| entry.tags.as_slice())));
    Ok(())
}

fn list(context: &Context, folder: Option<&str>) -> Result<(), CliError> {
    let items = list_local_library_items(&context.vault, folder)?;
    print_library(context.json, &items);
    Ok(())
}

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

fn read_dataset_command(context: &Context, path: &str) -> Result<(), CliError> {
    let snapshot = read_dataset(&context.vfs(), path, &DatasetLimits::default())
        .map_err(|error| error.to_string())?;
    print_dataset(context.json, &snapshot)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDatasetInput {
    pub header: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
    pub primary_key: Option<String>,
}

/// `--create-dataset` 从标准输入读的 JSON：`{header, rows?, primaryKey?}`。
pub fn read_create_dataset_input() -> Result<CreateDatasetInput, CliError> {
    let input = read_stdin("--create-dataset 从标准输入读取 JSON")?;
    serde_json::from_str(&input)
        .map_err(|error| format!("数据集 JSON 无效：{error}").into())
}

fn create_dataset(context: &Context, title: &str, folder: Option<&str>) -> Result<(), CliError> {
    let input = read_create_dataset_input()?;
    let _lock = context.lock()?;
    let folder = ensure_folder(&context.vfs(), folder)?;
    let (dataset, note) = create_library_dataset_files(
        &context.vfs(),
        title,
        input.header,
        input.rows,
        input.primary_key,
        folder.as_deref(),
        &context.source,
    )?;
    print_created_dataset(context.json, &dataset.path, &dataset.sha, &context.relative(&note));
    Ok(())
}

// ---------------------------------------------------------------------------
// 输出：本地与远程模式共用
// ---------------------------------------------------------------------------

pub fn print_document(json: bool, document: &DocumentView) {
    if json {
        print_json(&to_value(document));
    } else {
        println!("{}", document.body);
    }
}

pub fn print_rewrite(json: bool, report: &RewriteReport) {
    if json {
        print_json(&to_value(report));
    } else if report.changed {
        println!("已保存：{}", report.path);
    } else {
        println!("没有改动：{}", report.path);
    }
}

/// 新建碎片与笔记的结果：`--json` 时 `{id, path, sha, tags}`，否则只打印路径。
pub fn print_created(json: bool, id: &str, path: &str, sha: &str, tags: &[String]) {
    if json {
        print_json(&json!({ "id": id, "path": path, "sha": sha, "tags": tags }));
    } else {
        println!("{path}");
    }
}

pub fn print_tags(json: bool, counts: &[TagCount]) {
    if json {
        print_json(&to_value(counts));
    } else {
        for count in counts {
            println!("#{}\t{}", count.tag, count.count);
        }
    }
}

pub fn print_library(json: bool, items: &[LibraryItem]) {
    if json {
        print_json(&to_value(items));
    } else {
        for item in items {
            if item.kind == "folder" {
                println!("{}/", item.path);
            } else {
                println!("{}", item.path);
            }
        }
    }
}

pub fn print_dataset(json: bool, snapshot: &DatasetSnapshot) -> Result<(), CliError> {
    if json {
        print_json(&json!({
            "path": snapshot.path,
            "header": snapshot.table.header,
            "rows": snapshot.table.rows,
            "primaryKey": snapshot.schema.as_ref().and_then(|schema| schema.primary_key.clone()),
            "sha": snapshot.sha,
            "editable": snapshot.editable,
            "readOnlyReason": snapshot.read_only_reason,
        }));
    } else {
        io::stdout()
            .write_all(&serialize_csv(&snapshot.table))
            .map_err(|error| format!("输出失败：{error}"))?;
    }
    Ok(())
}

pub fn print_created_dataset(json: bool, path: &str, sha: &str, note_path: &str) {
    if json {
        print_json(&json!({ "path": path, "sha": sha, "notePath": note_path }));
    } else {
        println!("{path}");
    }
}

fn to_value<T: Serialize + ?Sized>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// 公共
// ---------------------------------------------------------------------------

fn resolve<'a>(
    entries: &'a [FragmentEntry],
    vault: &Path,
    target: &str,
) -> Result<&'a FragmentEntry, CliError> {
    match find::resolve_target(entries, vault, target) {
        Resolved::Found(entry) => Ok(entry),
        Resolved::NotFound => Err(CliError::new("NOT_FOUND", not_found_message(target))),
        Resolved::Ambiguous(matched) => {
            Err(CliError::new("AMBIGUOUS", ambiguous_message(target, &matched)))
        }
    }
}

/// 参数里的内容按速记规则解析（前导 `#标签`、`/复选框` 等）；没有参数时读标准输入。
fn capture(content: &[String]) -> Result<parse::Capture, CliError> {
    let mut capture = parse::parse_capture(&content.join(" "));
    if capture.text.is_empty() && !io::stdin().is_terminal() {
        capture.text = read_stdin("读取内容")?.trim().replace('＃', "#");
    }
    Ok(capture)
}

pub fn read_stdin(purpose: &str) -> Result<String, CliError> {
    if io::stdin().is_terminal() {
        return Err(format!("{purpose}：请用管道或 heredoc 提供内容").into());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("读取标准输入失败：{error}"))?;
    Ok(input)
}

/// 正文开头像 YAML frontmatter 时拒绝：id、时间与标签由 shard 生成，手写的会被当成正文。
pub fn ensure_plain_markdown(body: &str) -> Result<(), CliError> {
    Ok(shard_vault::cli::ensure_plain_markdown(body)?)
}

pub fn lock_error(error: String) -> CliError {
    if error == "Shard 正在写入资料库，请稍后重试" {
        CliError::new("LOCKED", error)
    } else {
        error.into()
    }
}

/// 改写时 sha 与 `--expect` 不符（本地与远程同一句）。
pub const STALE_REWRITE_MESSAGE: &str =
    "文件已被修改（sha 与 --expect 不符），没有覆盖。请重新 --read 后基于最新内容再改。";

fn rewrite_error(error: RewriteError) -> CliError {
    match error {
        RewriteError::Stale => CliError::new("CONFLICT", STALE_REWRITE_MESSAGE),
        RewriteError::Locked => lock_error("Shard 正在写入资料库，请稍后重试".to_string()),
        RewriteError::Invalid(message) => message.into(),
    }
}

pub fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
    );
}
