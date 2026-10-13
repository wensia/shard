//! 给 AI 助手与脚本用的非交互命令：按 id 读写碎片与资料库笔记、追加、建笔记、
//! 列标签与目录、读写数据集。
//!
//! 输出默认是人能读的文本；带 `--json` 时 stdout 只有一个 JSON 值，失败时由 `main`
//! 把错误以 `{"error":{"code","message"}}` 写到 stderr。写入一律持资料库进程锁，
//! 改写已有内容要带读取时拿到的 `sha`，期间被改过就拒绝（退出码 2），不会覆盖。

use crate::{
    edit::{self, RewriteError},
    find::{self, FragmentEntry, Resolved},
    parse, CliError,
};
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::{
    contains_lockbox_tag,
    dataset::{read_dataset, serialize_csv, DatasetLimits},
    extract_tags,
    frontmatter::parse_fragment,
    graph_model::content_sha256_hex,
    library::{
        create_library_dataset_files, create_library_note_file, ensure_library_directory,
        existing_library_directory,
    },
    vault_lock::VaultProcessLock,
    INBOX_TAG, TYPE_TAGS,
};
use std::{
    collections::BTreeMap,
    fs,
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
    let raw = fs::read_to_string(&entry.path)
        .map_err(|error| format!("读取 {} 失败：{error}", entry.path.display()))?;
    let parsed = parse_fragment(&raw)?;
    let body = parsed.body.trim_start_matches('\n').trim_end();
    if context.json {
        print_json(&json!({
            "id": parsed.frontmatter.id,
            "path": context.relative(&entry.path),
            "kind": entry.kind.unwrap_or("fragment"),
            "title": entry.title,
            "tags": parsed.frontmatter.tags,
            "createdAt": parsed.frontmatter.created_at,
            "updatedAt": parsed.frontmatter.updated_at,
            "source": parsed.frontmatter.source,
            "sha": content_sha256_hex(&raw),
            "body": body,
        }));
    } else {
        println!("{body}");
    }
    Ok(())
}

fn update(context: &Context, target: &str, expect: &str) -> Result<(), CliError> {
    let body = read_stdin("--update 从标准输入读取新正文")?;
    ensure_plain_markdown(&body)?;
    let entries = find::load_entries(&context.vault)?;
    let entry = resolve(&entries, &context.vault, target)?;
    let written = edit::rewrite_body(
        &context.vault,
        &entry.path,
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
    let (addition, _) = parse::compose(&capture(content)?)?;
    ensure_plain_markdown(&addition)?;
    let entries = find::load_entries(&context.vault)?;
    let entry = resolve(&entries, &context.vault, target)?;
    let written = edit::rewrite_body(
        &context.vault,
        &entry.path,
        expect,
        |current| join_appended(current, &addition),
        &context.lock_dir,
        context.timeout,
    )
    .map_err(rewrite_error)?;
    report_rewrite(context, entry, written)
}

/// 末尾是列表项、追加的也以列表项开头时接成同一个列表，否则空一行另起段落。
fn join_appended(current: &str, addition: &str) -> String {
    let current = current.trim_end();
    let addition = addition.trim();
    if current.is_empty() {
        return addition.to_string();
    }
    let continues_list = current.lines().last().is_some_and(is_list_item)
        && addition.lines().next().is_some_and(is_list_item);
    let separator = if continues_list { "\n" } else { "\n\n" };
    format!("{current}{separator}{addition}")
}

fn is_list_item(line: &str) -> bool {
    let line = line.trim_start();
    if ["- ", "* ", "+ "].iter().any(|marker| line.starts_with(marker)) {
        return true;
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && (line[digits..].starts_with(". ") || line[digits..].starts_with(") "))
}

fn report_rewrite(
    context: &Context,
    entry: &FragmentEntry,
    written: edit::Rewritten,
) -> Result<(), CliError> {
    let path = context.relative(&entry.path);
    if context.json {
        let tags = parse_fragment(&written.raw)
            .map(|parsed| parsed.frontmatter.tags)
            .unwrap_or_default();
        print_json(&json!({
            "id": entry.id,
            "path": path,
            "sha": written.sha,
            "changed": written.changed,
            "tags": tags,
        }));
    } else if written.changed {
        println!("已保存：{path}");
    } else {
        println!("没有改动：{path}");
    }
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
    let capture = capture(content)?;
    let (body, mut tags) = if capture.text.trim().is_empty() && capture.tags.is_empty() {
        (String::new(), Vec::new())
    } else {
        parse::compose(&capture)?
    };
    ensure_plain_markdown(&body)?;
    let body = with_title_heading(title, &body);
    // 与 App 保存笔记一致：inbox + note + 正文里的 #标签。
    tags.push(INBOX_TAG.to_string());
    tags.extend(extract_tags(&body));
    if contains_lockbox_tag(&tags) {
        return Err("终端不支持写入密匣，请在 Shard 中保存。".into());
    }

    let _lock = context.lock()?;
    let folder = library_folder(folder);
    if let Some(folder) = folder.as_deref() {
        ensure_library_directory(&context.vault, folder)?;
    }
    let path = create_library_note_file(
        &context.vault,
        title,
        folder.as_deref(),
        &body,
        tags,
        &context.source,
    )?;
    let written = fs::read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let relative = context.relative(&path);
    if context.json {
        let parsed = parse_fragment(&written)?;
        print_json(&json!({
            "id": parsed.frontmatter.id,
            "path": relative,
            "sha": content_sha256_hex(&written),
            "tags": parsed.frontmatter.tags,
        }));
    } else {
        println!("{relative}");
    }
    Ok(())
}

/// 资料库笔记约定以一级标题开头（App 新建笔记的默认正文就是 `# 标题`）。
fn with_title_heading(title: &str, body: &str) -> String {
    let starts_with_heading = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .is_some_and(|line| line.starts_with("# "));
    if starts_with_heading {
        body.to_string()
    } else {
        format!("# {}\n\n{}", title.trim(), body.trim()).trim_end().to_string()
    }
}

/// `--folder 项目/周报` 与 `--folder notes/项目/周报` 等价。
fn library_folder(folder: Option<&str>) -> Option<String> {
    let folder = folder?.trim().trim_matches('/');
    if folder.is_empty() || folder == "notes" {
        return None;
    }
    Some(if folder.starts_with("notes/") {
        folder.to_string()
    } else {
        format!("notes/{folder}")
    })
}

fn tags(context: &Context) -> Result<(), CliError> {
    let entries = find::load_entries(&context.vault)?;
    let mut counts = BTreeMap::<&str, usize>::new();
    for entry in &entries {
        for tag in &entry.tags {
            if tag != INBOX_TAG && !TYPE_TAGS.contains(&tag.as_str()) {
                *counts.entry(tag).or_default() += 1;
            }
        }
    }
    let mut counts = counts.into_iter().collect::<Vec<_>>();
    counts.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    if context.json {
        print_json(&Value::Array(
            counts
                .iter()
                .map(|(tag, count)| json!({ "tag": tag, "count": count }))
                .collect(),
        ));
    } else {
        for (tag, count) in counts {
            println!("#{tag}\t{count}");
        }
    }
    Ok(())
}

fn list(context: &Context, folder: Option<&str>) -> Result<(), CliError> {
    let folder = library_folder(folder);
    let root = existing_library_directory(&context.vault, folder.as_deref())?;
    let mut items = Vec::new();
    collect_library(&root, &context.vault, &mut items)?;
    if folder.is_none() {
        let datasets = context.vault.join("datasets");
        if datasets.is_dir() {
            collect_library(&datasets, &context.vault, &mut items)?;
        }
    }
    if context.json {
        print_json(&Value::Array(
            items
                .iter()
                .map(|(path, kind)| json!({ "path": path, "kind": kind }))
                .collect(),
        ));
    } else {
        for (path, kind) in items {
            if kind == "folder" {
                println!("{path}/");
            } else {
                println!("{path}");
            }
        }
    }
    Ok(())
}

/// 与资料库树认的文件类型一致；隐藏文件、符号链接与其他扩展名不列。
fn collect_library(
    dir: &Path,
    vault: &Path,
    items: &mut Vec<(String, &'static str)>,
) -> Result<(), CliError> {
    let mut entries = fs::read_dir(dir)
        .map_err(|error| format!("读取 {} 失败：{error}", dir.display()))?
        .flatten()
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if name.starts_with('.') || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(vault).unwrap_or(&path).display().to_string();
        if file_type.is_dir() {
            items.push((relative, "folder"));
            collect_library(&path, vault, items)?;
            continue;
        }
        let kind = if name.ends_with(".shardmap.json") {
            "mindmap"
        } else if name.ends_with(".shardflow.json") {
            "flowchart"
        } else if name.ends_with(".shardcanvas.json") {
            "canvas"
        } else if name.ends_with(".md") {
            "note"
        } else if name.ends_with(".csv") {
            "dataset"
        } else {
            continue;
        };
        items.push((relative, kind));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 数据集
// ---------------------------------------------------------------------------

fn read_dataset_command(context: &Context, path: &str) -> Result<(), CliError> {
    let snapshot = read_dataset(&context.vault, path, &DatasetLimits::default())
        .map_err(|error| error.to_string())?;
    if context.json {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDatasetInput {
    header: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
    primary_key: Option<String>,
}

fn create_dataset(context: &Context, title: &str, folder: Option<&str>) -> Result<(), CliError> {
    let input = read_stdin("--create-dataset 从标准输入读取 JSON")?;
    let input: CreateDatasetInput = serde_json::from_str(&input)
        .map_err(|error| format!("数据集 JSON 无效：{error}"))?;
    let _lock = context.lock()?;
    let folder = library_folder(folder);
    if let Some(folder) = folder.as_deref() {
        ensure_library_directory(&context.vault, folder)?;
    }
    let (dataset, note) = create_library_dataset_files(
        &context.vault,
        title,
        input.header,
        input.rows,
        input.primary_key,
        folder.as_deref(),
        &context.source,
    )?;
    if context.json {
        print_json(&json!({
            "path": dataset.path,
            "sha": dataset.sha,
            "notePath": context.relative(&note),
        }));
    } else {
        println!("{}", dataset.path);
    }
    Ok(())
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
        Resolved::NotFound => Err(CliError::new(
            "NOT_FOUND",
            format!(
                "找不到「{target}」。目标是 id、vault 相对路径或上次搜索的序号；\
                 关键词请先用 shard -s 查出 id。大纲与流程图用 --graph-read。"
            ),
        )),
        Resolved::Ambiguous(matched) => Err(CliError::new(
            "AMBIGUOUS",
            format!(
                "「{target}」匹配到多条，请用完整 id：{}",
                matched
                    .iter()
                    .take(5)
                    .map(|entry| entry.id.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        )),
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

fn read_stdin(purpose: &str) -> Result<String, CliError> {
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
    let mut lines = body.trim_start().lines();
    if lines.next().map(str::trim_end) == Some("---")
        && lines.any(|line| line.trim_end() == "---")
    {
        return Err("正文不要带 YAML frontmatter：id、时间和标签由 shard 生成，标签直接在正文里写 #标签。".into());
    }
    Ok(())
}

pub fn lock_error(error: String) -> CliError {
    if error == "Shard 正在写入资料库，请稍后重试" {
        CliError::new("LOCKED", error)
    } else {
        error.into()
    }
}

fn rewrite_error(error: RewriteError) -> CliError {
    match error {
        RewriteError::Stale => CliError::new(
            "CONFLICT",
            "文件已被修改（sha 与 --expect 不符），没有覆盖。请重新 --read 后基于最新内容再改。",
        ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appended_list_items_continue_the_list() {
        assert_eq!(join_appended("- [ ] 一\n", "- [ ] 二"), "- [ ] 一\n- [ ] 二");
        assert_eq!(join_appended("1. 一", "2. 二"), "1. 一\n2. 二");
        assert_eq!(join_appended("段落", "- 列表"), "段落\n\n- 列表");
        assert_eq!(join_appended("- 列表", "段落"), "- 列表\n\n段落");
    }

    #[test]
    fn note_body_gets_title_heading_once() {
        assert_eq!(with_title_heading("周报", "内容"), "# 周报\n\n内容");
        assert_eq!(with_title_heading("周报", "# 自定\n\n内容"), "# 自定\n\n内容");
    }

    #[test]
    fn folder_accepts_with_or_without_notes_prefix() {
        assert_eq!(library_folder(Some("项目/周报")).as_deref(), Some("notes/项目/周报"));
        assert_eq!(library_folder(Some("notes/项目/")).as_deref(), Some("notes/项目"));
        assert_eq!(library_folder(Some("notes")), None);
        assert_eq!(library_folder(None), None);
    }

    #[test]
    fn frontmatter_in_body_is_rejected() {
        assert!(ensure_plain_markdown("---\ntitle: x\n---\n正文").is_err());
        assert!(ensure_plain_markdown("正文\n\n---\n\n分隔线之后").is_ok());
        assert!(ensure_plain_markdown("---\n只有一条分隔线").is_ok());
    }
}
