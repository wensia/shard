//! 命令行（`shard`）的领域逻辑：本地模式（`FsVfs` + 资料库进程锁）与服务端的命令行 RPC
//! （`SqliteVfs` + 一个写事务）共用这一份实现，两边对同一个输入给出同样的结果与报错。
//!
//! - 文本条目：`fragments/` 下的公开碎片与 `notes/` 下的资料库笔记，能按文本读写的那些
//!   （大纲、流程图的正文是受管 JSON，走图命令，不在这里）。回收站与密匣不在。
//! - 目标解析：完整 id、vault 相对路径、id 中至少 4 个字符且唯一的片段。
//!   「上次搜索的序号」是客户端本地状态，由调用方换算成 id 后传入。
//! - 正文改写：正文里的 `#标签` 重新收进 frontmatter，type 标签保留，`updated_at` 刷新，
//!   frontmatter 其余内容逐字节不动；带基线 sha 时核对，不一致不写。
//! - 追加规则、资料库笔记、标签统计、资料库目录列表、数据集按主键幂等追加。
//!
//! 写函数都不取锁、不开事务：本地调用方持进程锁，服务端在写事务里调用。

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use shard_core::{
    contains_lockbox_tag,
    dataset::{read_dataset, write_dataset_ops, DatasetLimits, DatasetOp},
    derive_type, extract_tags,
    frontmatter::{parse_fragment, write_fragment_update},
    library::{create_library_note_file_at, ensure_library_directory, existing_library_directory},
    normalize_tags, normalize_type_tags, EntryKind, FsVfs, Vfs, INBOX_TAG, PROTECTED_TYPE_TAGS, TYPE_TAGS,
};

use crate::util::content_sha256_hex;

pub const PROTECTED_MESSAGE: &str = "大纲与流程图请在 Shard 中编辑，或使用 --graph-* 命令。";
pub const LOCKBOX_MESSAGE: &str = "终端不支持写入密匣，请在 Shard 中保存。";
pub const EMPTY_BODY_MESSAGE: &str = "内容为空，未保存。删除请在 Shard 中操作。";
pub const FRONTMATTER_MESSAGE: &str =
    "正文不要带 YAML frontmatter：id、时间和标签由 shard 生成，标签直接在正文里写 #标签。";

// ---------------------------------------------------------------------------
// 文本条目
// ---------------------------------------------------------------------------

/// 能按文本处理的一条内容：`fragments/` 下的碎片或 `notes/` 下的资料库笔记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEntry {
    pub id: String,
    /// vault 相对路径（`/` 分隔）。
    pub path: String,
    pub title: String,
    pub created_at: String,
    /// frontmatter 里的原文。
    pub updated_at: String,
    /// `note`、`document`，普通碎片为 `None`。
    pub kind: Option<&'static str>,
    /// frontmatter 标签；为空时按 App 的约定当作 `[inbox]`。
    pub tags: Vec<String>,
    /// `updated_at` 换算的毫秒时间戳，解析失败为 0。
    pub modified_at: i64,
    /// 正文，去掉开头空行与结尾空白。
    pub body: String,
}

impl TextEntry {
    pub fn kind_name(&self) -> &'static str {
        self.kind.unwrap_or("fragment")
    }
}

// ---------------------------------------------------------------------------
// 目录遍历：服务端经 Vfs；CLI 本地模式直接读目录，单个条目出错（权限、竞态删除）时跳过，
// 与迁移前 `fs::read_dir().flatten()` 一致——FsVfs::read_dir 遇到坏条目会让整个目录失败。
// ---------------------------------------------------------------------------

/// 目录里的一项。`kind` 不跟随符号链接；`is_dir` 跟随（与 `Path::is_dir` / `Vfs::is_dir` 一致）。
struct DirItem {
    path: PathBuf,
    name: String,
    kind: EntryKind,
    is_dir: bool,
}

trait Lister {
    fn root(&self) -> &Path;
    fn is_dir(&self, path: &Path) -> bool;
    fn list(&self, dir: &Path) -> Result<Vec<DirItem>, String>;
}

struct VfsLister<'a>(&'a dyn Vfs);

impl Lister for VfsLister<'_> {
    fn root(&self) -> &Path {
        self.0.root()
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.0.is_dir(path)
    }

    fn list(&self, dir: &Path) -> Result<Vec<DirItem>, String> {
        let entries = self.0.read_dir(dir).map_err(|error| format!("读取 {} 失败：{error}", dir.display()))?;
        Ok(entries
            .into_iter()
            .filter_map(|entry| {
                let path = entry.path();
                let kind = entry.file_type().ok()?;
                Some(DirItem {
                    name: entry.file_name().to_string_lossy().to_string(),
                    is_dir: self.0.is_dir(&path),
                    kind,
                    path,
                })
            })
            .collect())
    }
}

struct LocalLister<'a>(&'a Path);

impl Lister for LocalLister<'_> {
    fn root(&self) -> &Path {
        self.0
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn list(&self, dir: &Path) -> Result<Vec<DirItem>, String> {
        let entries = fs::read_dir(dir).map_err(|error| format!("读取 {} 失败：{error}", dir.display()))?;
        Ok(entries
            .flatten()
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                let kind = if file_type.is_symlink() {
                    EntryKind::Symlink
                } else if file_type.is_dir() {
                    EntryKind::Dir
                } else if file_type.is_file() {
                    EntryKind::File
                } else {
                    EntryKind::Other
                };
                let path = entry.path();
                Some(DirItem {
                    name: entry.file_name().to_string_lossy().to_string(),
                    is_dir: path.is_dir(),
                    kind,
                    path,
                })
            })
            .collect())
    }
}

/// 读取 `fragments/` 下的公开碎片与 `notes/` 下的资料库笔记。以 `.` 开头的文件与目录
/// （原子写的临时文件、系统文件）跳过；解析失败的文件跳过：一篇坏文件不该让整个命令失败。
pub fn load_text_entries(vfs: &dyn Vfs) -> Result<Vec<TextEntry>, String> {
    load_entries_with(&VfsLister(vfs), vfs)
}

/// 同 [`load_text_entries`]，CLI 本地模式用：直接读 vault 目录，单个坏条目跳过。
pub fn load_local_text_entries(vault: &Path) -> Result<Vec<TextEntry>, String> {
    load_entries_with(&LocalLister(vault), &FsVfs::new(vault))
}

fn load_entries_with(lister: &dyn Lister, vfs: &dyn Vfs) -> Result<Vec<TextEntry>, String> {
    let vault = lister.root();
    let mut files = Vec::new();
    collect_markdown(lister, &vault.join("fragments"), &mut files)?;
    collect_markdown(lister, &vault.join("notes"), &mut files)?;
    Ok(files.into_iter().filter_map(|path| text_entry(vfs, vault, &path)).collect())
}

/// 一个文件 → 文本条目；读不出、解析不了或是大纲 / 流程图时为 `None`。
fn text_entry(vfs: &dyn Vfs, vault: &Path, path: &Path) -> Option<TextEntry> {
    let text = vfs.read_to_string(path).ok()?;
    let parsed = parse_fragment(&text).ok()?;
    let kind = derive_type(&parsed.frontmatter.tags);
    if kind.is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind)) {
        return None;
    }
    let body = parsed.body.trim_start_matches('\n').trim_end().to_string();
    let tags = if parsed.frontmatter.tags.is_empty() {
        vec![INBOX_TAG.to_string()]
    } else {
        parsed.frontmatter.tags.clone()
    };
    Some(TextEntry {
        id: parsed.frontmatter.id,
        path: vault_relative(vault, path),
        title: text_title(kind, &body),
        created_at: parsed.frontmatter.created_at,
        modified_at: parse_millis(&parsed.frontmatter.updated_at),
        updated_at: parsed.frontmatter.updated_at,
        kind,
        tags,
        body,
    })
}

/// 解析出的条目在写事务里是否还在原处：文件还在、仍是同一个 id、仍是文本条目。
/// 服务端先在只读快照里解析目标，写事务里只核对这一个文件（期间被移走、移进回收站就不写）。
pub fn entry_still_at(vfs: &dyn Vfs, path: &str, id: &str) -> bool {
    text_entry(vfs, vfs.root(), &vfs.root().join(path)).is_some_and(|entry| entry.id == id)
}

fn collect_markdown(lister: &dyn Lister, dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !lister.is_dir(dir) {
        return Ok(());
    }
    for item in lister.list(dir)? {
        if item.name.starts_with('.') {
            continue;
        }
        if item.is_dir {
            collect_markdown(lister, &item.path, files)?;
        } else if item.path.extension().is_some_and(|extension| extension == "md") {
            files.push(item.path);
        }
    }
    Ok(())
}

fn vault_relative(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault).unwrap_or(path).display().to_string()
}

/// 与 App 搜索的标题规则一致（`search_sources.rs` 的 `markdown_title`）。
pub fn text_title(kind: Option<&str>, body: &str) -> String {
    let first_line = || {
        body.lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(ToString::to_string)
    };
    match kind {
        Some("document") => body
            .lines()
            .find_map(markdown_heading)
            .or_else(first_line)
            .map(|title| truncate_chars(title, 40))
            .unwrap_or_else(|| "未命名文档".to_string()),
        Some("note") => body
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("# ")
                    .map(|title| title.trim().trim_end_matches('#').trim_end().to_string())
                    .filter(|title| !title.is_empty())
            })
            .or_else(first_line)
            .map(|title| truncate_chars(title, 48))
            .unwrap_or_else(|| "未命名笔记".to_string()),
        _ => first_line().unwrap_or_else(|| "未命名碎片".to_string()),
    }
}

fn markdown_heading(line: &str) -> Option<String> {
    let line = line.trim_start();
    let hashes = line.chars().take_while(|character| *character == '#').count();
    if !(1..=6).contains(&hashes) || !line[hashes..].starts_with(' ') {
        return None;
    }
    let heading = line[(hashes + 1)..].trim().trim_end_matches('#').trim_end();
    (!heading.is_empty()).then(|| heading.to_string())
}

fn truncate_chars(value: String, maximum: usize) -> String {
    if value.chars().count() <= maximum {
        return value;
    }
    let mut result = value.chars().take(maximum).collect::<String>().trim_end().to_string();
    result.push('…');
    result
}

pub fn parse_millis(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

/// 文本条目的线上形状（命令行 RPC `list_documents`）。`body` 只在请求时带上。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub id: String,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

impl TextDocument {
    pub fn from_entry(entry: &TextEntry, with_body: bool) -> Self {
        Self {
            id: entry.id.clone(),
            path: entry.path.clone(),
            title: entry.title.clone(),
            kind: entry.kind_name().to_string(),
            tags: entry.tags.clone(),
            created_at: entry.created_at.clone(),
            updated_at: entry.updated_at.clone(),
            body: with_body.then(|| entry.body.clone()),
        }
    }

    pub fn into_entry(self) -> TextEntry {
        let kind = match self.kind.as_str() {
            "note" => Some("note"),
            "document" => Some("document"),
            _ => None,
        };
        TextEntry {
            id: self.id,
            path: self.path,
            title: self.title,
            created_at: self.created_at,
            modified_at: parse_millis(&self.updated_at),
            updated_at: self.updated_at,
            kind,
            tags: self.tags,
            body: self.body.unwrap_or_default(),
        }
    }
}

/// 最近修改在前（同一时间保持原顺序），与终端不带关键词的 `-s` 一致。
pub fn sort_recent(entries: &mut [TextEntry]) {
    entries.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
}

// ---------------------------------------------------------------------------
// 目标解析
// ---------------------------------------------------------------------------

pub enum Resolved<'a> {
    Found(&'a TextEntry),
    NotFound,
    Ambiguous(Vec<&'a TextEntry>),
}

/// 非交互命令（读取、改写、追加）的目标：完整 id、vault 相对路径、上次搜索的序号
/// （`recalled` 是上次搜索结果的 id 列表，服务端不传），或 id 中至少 4 个字符且只命中一条的片段。
/// 不做关键词搜索：写入目标必须确定。
pub fn resolve_target<'a>(entries: &'a [TextEntry], target: &str, recalled: Option<&[String]>) -> Resolved<'a> {
    let target = target.trim();
    if target.is_empty() {
        return Resolved::NotFound;
    }
    if let Some(entry) = entries.iter().find(|entry| entry.id == target) {
        return Resolved::Found(entry);
    }
    if target.contains('/') || target.ends_with(".md") {
        let relative = target.trim_start_matches("./");
        return entries
            .iter()
            .find(|entry| entry.path == relative)
            .map_or(Resolved::NotFound, Resolved::Found);
    }
    if let Ok(index) = target.parse::<usize>() {
        if let Some(ids) = recalled.filter(|ids| (1..=ids.len()).contains(&index)) {
            let id = &ids[index - 1];
            return entries
                .iter()
                .find(|entry| &entry.id == id)
                .map_or(Resolved::NotFound, Resolved::Found);
        }
    }
    let needle = target.to_lowercase();
    if needle.chars().count() < 4 {
        return Resolved::NotFound;
    }
    let matched = entries
        .iter()
        .filter(|entry| entry.id.to_lowercase().contains(&needle))
        .collect::<Vec<_>>();
    match matched.as_slice() {
        [] => Resolved::NotFound,
        [entry] => Resolved::Found(entry),
        _ => Resolved::Ambiguous(matched),
    }
}

pub fn not_found_message(target: &str) -> String {
    format!(
        "找不到「{target}」。目标是 id、vault 相对路径或上次搜索的序号；\
         关键词请先用 shard -s 查出 id。大纲与流程图用 --graph-read。"
    )
}

pub fn ambiguous_message(target: &str, matched: &[&TextEntry]) -> String {
    format!(
        "「{target}」匹配到多条，请用完整 id：{}",
        matched.iter().take(5).map(|entry| entry.id.as_str()).collect::<Vec<_>>().join("、")
    )
}

/// 解析目标得到的条目摘要（命令行 RPC `resolve_target`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTarget {
    pub id: String,
    pub path: String,
    pub kind: String,
}

impl ResolvedTarget {
    pub fn from_entry(entry: &TextEntry) -> Self {
        Self { id: entry.id.clone(), path: entry.path.clone(), kind: entry.kind_name().to_string() }
    }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/// `shard --read --json` 的输出形状。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentView {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub source: String,
    pub sha: String,
    pub body: String,
}

/// 读一条文本条目的全文与元数据。`tags` 是 frontmatter 原样（不补 inbox）。
pub fn read_document(vfs: &dyn Vfs, entry: &TextEntry) -> Result<DocumentView, String> {
    let path = vfs.root().join(&entry.path);
    let raw = vfs
        .read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let parsed = parse_fragment(&raw)?;
    Ok(DocumentView {
        id: parsed.frontmatter.id,
        path: entry.path.clone(),
        kind: entry.kind_name().to_string(),
        title: entry.title.clone(),
        tags: parsed.frontmatter.tags,
        created_at: parsed.frontmatter.created_at,
        updated_at: parsed.frontmatter.updated_at,
        source: parsed.frontmatter.source,
        sha: content_sha256_hex(&raw),
        body: parsed.body.trim_start_matches('\n').trim_end().to_string(),
    })
}

// ---------------------------------------------------------------------------
// 改写与追加
// ---------------------------------------------------------------------------

/// 正文开头像 YAML frontmatter 时拒绝：id、时间与标签由 shard 生成，手写的会被当成正文。
pub fn ensure_plain_markdown(body: &str) -> Result<(), String> {
    let mut lines = body.trim_start().lines();
    if lines.next().map(str::trim_end) == Some("---") && lines.any(|line| line.trim_end() == "---") {
        return Err(FRONTMATTER_MESSAGE.to_string());
    }
    Ok(())
}

/// 末尾是列表项、追加的也以列表项开头时接成同一个列表，否则空一行另起段落。
pub fn join_appended(current: &str, addition: &str) -> String {
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

pub fn is_list_item(line: &str) -> bool {
    let line = line.trim_start();
    if ["- ", "* ", "+ "].iter().any(|marker| line.starts_with(marker)) {
        return true;
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && (line[digits..].starts_with(". ") || line[digits..].starts_with(") "))
}

/// 标签规则 = 碎片编辑器提交（`fragment-editor.tsx`：`inbox` + 正文标签，非碎片类型
/// 换回原 type）再过一遍后端 `normalize_updated_type_tags`（受保护类型不可增删）。
pub fn edited_tags(current: &[String], body: &str) -> Vec<String> {
    let mut tags = vec![INBOX_TAG.to_string()];
    tags.extend(extract_tags(body));
    let mut tags = normalize_tags(tags, false);
    let current_kind = derive_type(current);
    if let Some(kind) = current_kind {
        tags.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
        tags.push(kind.to_string());
    }

    let mut next = normalize_type_tags(normalize_tags(tags, false));
    match current_kind.filter(|kind| PROTECTED_TYPE_TAGS.contains(kind)) {
        Some(kind) => {
            next.retain(|tag| !TYPE_TAGS.contains(&tag.as_str()));
            next.push(kind.to_string());
            next.sort();
            next.dedup();
        }
        None => next.retain(|tag| !PROTECTED_TYPE_TAGS.contains(&tag.as_str())),
    }
    if next.is_empty() {
        vec![INBOX_TAG.to_string()]
    } else {
        next
    }
}

/// 一次正文改写的计划。`current_body` 与 `next_body` 都应已去掉开头空行与结尾空白。
/// 返回 `None` 表示正文没变（不落盘、`updated_at` 不动）；否则是写入后的 frontmatter 标签。
pub fn plan_rewrite(current_tags: &[String], current_body: &str, next_body: &str) -> Result<Option<Vec<String>>, String> {
    if derive_type(current_tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind)) {
        return Err(PROTECTED_MESSAGE.to_string());
    }
    if next_body.trim().is_empty() {
        return Err(EMPTY_BODY_MESSAGE.to_string());
    }
    if next_body == current_body {
        return Ok(None);
    }
    let tags = edited_tags(current_tags, next_body);
    if contains_lockbox_tag(&tags) {
        return Err(LOCKBOX_MESSAGE.to_string());
    }
    Ok(Some(tags))
}

/// frontmatter 的 `source`（写入方名称）：不超过 40 个字符的单行。
pub fn valid_source(source: &str) -> bool {
    source.chars().count() <= 40 && !source.chars().any(char::is_control)
}

/// 去掉开头空行与结尾空白：正文在 frontmatter 之后的规范形态。
pub fn normalize_body(body: &str) -> &str {
    body.trim_start_matches('\n').trim_end()
}

#[derive(Debug, PartialEq, Eq)]
pub enum RewriteError {
    /// 文件哈希与调用方的基线不一致：期间被 App、同步或其他进程改过。
    Stale,
    Invalid(String),
}

#[derive(Debug, Clone)]
pub struct Rewritten {
    pub raw: String,
    pub sha: String,
    /// 新正文与原正文相同时不落盘，`updated_at` 也不动。
    pub changed: bool,
}

impl Rewritten {
    /// 写入后 frontmatter 里的标签（解析失败时为空）。
    pub fn tags(&self) -> Vec<String> {
        parse_fragment(&self.raw).map(|parsed| parsed.frontmatter.tags).unwrap_or_default()
    }
}

/// 改写一篇碎片或笔记的正文，语义与 App 编辑保存一致（见模块说明）。
///
/// `expected_sha` 是调用方读到的整文件哈希；给了就核对，不一致返回 `Stale` 且不写。
/// `next` 拿到当前正文、返回新正文，追加之类的读改写因此在调用方的同一把锁 / 同一个事务里完成。
/// `updated_at` 由调用方给（本地是本机时区，服务端是客户端时区）。
pub fn rewrite_document(
    vfs: &dyn Vfs,
    path: &Path,
    expected_sha: Option<&str>,
    next: impl FnOnce(&str) -> String,
    updated_at: String,
) -> Result<Rewritten, RewriteError> {
    let raw = vfs
        .read_to_string(path)
        .map_err(|error| RewriteError::Invalid(format!("读取 {} 失败：{error}", path.display())))?;
    let sha = content_sha256_hex(&raw);
    if expected_sha.is_some_and(|expected| expected != sha) {
        return Err(RewriteError::Stale);
    }
    let parsed = parse_fragment(&raw).map_err(RewriteError::Invalid)?;
    if derive_type(&parsed.frontmatter.tags).is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind)) {
        return Err(RewriteError::Invalid(PROTECTED_MESSAGE.to_string()));
    }
    let current_body = normalize_body(&parsed.body);
    let next_body = next(current_body);
    let next_body = normalize_body(&next_body);
    let Some(tags) = plan_rewrite(&parsed.frontmatter.tags, current_body, next_body).map_err(RewriteError::Invalid)?
    else {
        return Ok(Rewritten { raw, sha, changed: false });
    };
    let mut frontmatter = parsed.frontmatter;
    frontmatter.tags = tags;
    frontmatter.updated_at = updated_at;
    write_fragment_update(vfs, path, &parsed.raw, &frontmatter, next_body)
        .map_err(|error| RewriteError::Invalid(format!("保存失败：{error}")))?;
    let raw = vfs
        .read_to_string(path)
        .map_err(|error| RewriteError::Invalid(format!("读取保存结果失败：{error}")))?;
    Ok(Rewritten { sha: content_sha256_hex(&raw), raw, changed: true })
}

/// 改写与追加的结果（`--update` / `--append --json` 的输出形状）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteReport {
    pub id: String,
    pub path: String,
    pub sha: String,
    pub changed: bool,
    pub tags: Vec<String>,
}

// ---------------------------------------------------------------------------
// 资料库笔记
// ---------------------------------------------------------------------------

/// 资料库笔记约定以一级标题开头（App 新建笔记的默认正文就是 `# 标题`）。
pub fn with_title_heading(title: &str, body: &str) -> String {
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

/// `--folder 项目/周报` 与 `--folder notes/项目/周报` 等价；空、`notes` 表示资料库根。
pub fn library_folder(folder: Option<&str>) -> Option<String> {
    let folder = folder?.trim().trim_matches('/');
    if folder.is_empty() || folder == "notes" {
        return None;
    }
    Some(if folder.starts_with("notes/") { folder.to_string() } else { format!("notes/{folder}") })
}

/// 新建笔记前的纯校验与整理：拒绝手写 frontmatter，补一级标题，标签 = `extra` + inbox +
/// 正文里的 `#标签`（与 App 保存笔记一致），拒绝密匣。返回 (落盘正文, 标签)。
pub fn prepare_note(title: &str, body: &str, extra_tags: Vec<String>) -> Result<(String, Vec<String>), String> {
    ensure_plain_markdown(body)?;
    let body = with_title_heading(title, body);
    let mut tags = extra_tags;
    tags.push(INBOX_TAG.to_string());
    tags.extend(extract_tags(&body));
    if contains_lockbox_tag(&tags) {
        return Err(LOCKBOX_MESSAGE.to_string());
    }
    Ok((body, tags))
}

/// 新建资料库笔记的结果（`--note --json` 的输出形状）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNote {
    pub id: String,
    pub path: String,
    pub sha: String,
    pub tags: Vec<String>,
}

/// 写入一篇已由 [`prepare_note`] 整理好的笔记：文件夹（`--folder` 写法）不存在时按资料库命名规则
/// 逐级创建，文件名取自标题、重名加 `-2`。
pub fn write_note(
    vfs: &dyn Vfs,
    title: &str,
    folder: Option<&str>,
    body: &str,
    tags: Vec<String>,
    source: &str,
    now: &DateTime<FixedOffset>,
) -> Result<CreatedNote, String> {
    let folder = library_folder(folder);
    if let Some(folder) = folder.as_deref() {
        ensure_library_directory(vfs, folder)?;
    }
    let path = create_library_note_file_at(vfs, title, folder.as_deref(), body, tags, source, now)?;
    let written = vfs
        .read_to_string(&path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let parsed = parse_fragment(&written)?;
    Ok(CreatedNote {
        id: parsed.frontmatter.id,
        path: vault_relative(vfs.root(), &path),
        sha: content_sha256_hex(&written),
        tags: parsed.frontmatter.tags,
    })
}

/// 确保资料库文件夹存在（`--folder` 写法），返回 vault 相对路径；资料库根返回 `None`。
pub fn ensure_folder(vfs: &dyn Vfs, folder: Option<&str>) -> Result<Option<String>, String> {
    let folder = library_folder(folder);
    if let Some(folder) = folder.as_deref() {
        ensure_library_directory(vfs, folder)?;
    }
    Ok(folder)
}

// ---------------------------------------------------------------------------
// 标签与目录
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// 标签使用次数（不含 inbox 与 type 标签），按次数降序、同次数按标签名。
pub fn tag_counts<'a>(tag_lists: impl IntoIterator<Item = &'a [String]>) -> Vec<TagCount> {
    let mut counts = BTreeMap::<&str, usize>::new();
    for tags in tag_lists {
        for tag in tags {
            if tag != INBOX_TAG && !TYPE_TAGS.contains(&tag.as_str()) {
                *counts.entry(tag).or_default() += 1;
            }
        }
    }
    let mut counts = counts.into_iter().collect::<Vec<_>>();
    counts.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    counts.into_iter().map(|(tag, count)| TagCount { tag: tag.to_string(), count }).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub path: String,
    /// folder / note / dataset / mindmap / flowchart / canvas
    pub kind: String,
}

/// 资料库目录（`--ls`）：给了文件夹只列它下面；没给时列 `notes/` 全部再加 `datasets/`。
/// 与资料库树认的文件类型一致；隐藏文件、符号链接与其他扩展名不列。按文件名排序、深度优先。
pub fn list_library_items(vfs: &dyn Vfs, folder: Option<&str>) -> Result<Vec<LibraryItem>, String> {
    list_library_with(&VfsLister(vfs), vfs, folder)
}

/// 同 [`list_library_items`]，CLI 本地模式用：直接读 vault 目录，单个坏条目跳过。
pub fn list_local_library_items(vault: &Path, folder: Option<&str>) -> Result<Vec<LibraryItem>, String> {
    list_library_with(&LocalLister(vault), &FsVfs::new(vault), folder)
}

fn list_library_with(lister: &dyn Lister, vfs: &dyn Vfs, folder: Option<&str>) -> Result<Vec<LibraryItem>, String> {
    let folder = library_folder(folder);
    let root = existing_library_directory(vfs, folder.as_deref())?;
    let mut items = Vec::new();
    collect_library(lister, &root, &mut items)?;
    if folder.is_none() {
        let datasets = lister.root().join("datasets");
        if lister.is_dir(&datasets) {
            collect_library(lister, &datasets, &mut items)?;
        }
    }
    Ok(items)
}

fn collect_library(lister: &dyn Lister, dir: &Path, items: &mut Vec<LibraryItem>) -> Result<(), String> {
    let mut entries = lister.list(dir)?;
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    for entry in entries {
        let name = entry.name;
        if name.starts_with('.') || entry.kind.is_symlink() {
            continue;
        }
        let path = entry.path;
        let relative = vault_relative(lister.root(), &path);
        if entry.kind.is_dir() {
            items.push(LibraryItem { path: relative, kind: "folder".to_string() });
            collect_library(lister, &path, items)?;
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
        items.push(LibraryItem { path: relative, kind: kind.to_string() });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 数据集：按主键幂等追加
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum DatasetAppendError {
    /// 表头与调用方的 `expectedHeader` 不一致（退出码 2）。
    HeaderChanged,
    /// 同主键不同内容（退出码 3），整批不写。
    KeyConflict,
    Invalid(String),
}

impl DatasetAppendError {
    pub fn message(&self) -> String {
        match self {
            Self::HeaderChanged => "表头已变化".to_string(),
            Self::KeyConflict => "主键冲突".to_string(),
            Self::Invalid(message) => message.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatasetAppended {
    pub appended: usize,
    pub skipped: usize,
    pub sha: String,
}

/// 按主键幂等追加记录：同主键同内容跳过，同主键不同内容整批拒绝（`KeyConflict`），
/// 缺的列补空字符串，表头之外的列与空主键拒绝。没有新行时不写，返回当前 sha。
pub fn append_dataset_records(
    vfs: &dyn Vfs,
    path: &str,
    expected_header: &[String],
    records: Vec<HashMap<String, String>>,
) -> Result<DatasetAppended, DatasetAppendError> {
    let invalid = |message: &str| DatasetAppendError::Invalid(message.to_string());
    let limits = DatasetLimits::default();
    let current = read_dataset(vfs, path, &limits).map_err(|error| DatasetAppendError::Invalid(error.to_string()))?;
    if current.table.header != expected_header {
        return Err(DatasetAppendError::HeaderChanged);
    }
    if !current.editable {
        return Err(DatasetAppendError::Invalid(
            current.read_only_reason.unwrap_or_else(|| "数据集不可编辑".into()),
        ));
    }
    let key = current
        .schema
        .as_ref()
        .and_then(|schema| schema.primary_key.as_ref())
        .ok_or_else(|| invalid("数据集必须有主键"))?;
    let key_column =
        current.table.header.iter().position(|column| column == key).ok_or_else(|| invalid("数据集主键列不存在"))?;
    let mut known: HashMap<String, Vec<String>> =
        current.table.rows.iter().map(|row| (row[key_column].clone(), row.clone())).collect();
    let mut new_rows = Vec::new();
    let mut skipped = 0usize;
    for record in records {
        if record.keys().any(|column| !current.table.header.contains(column)) {
            return Err(invalid("记录含有表头之外的列"));
        }
        let row: Vec<String> =
            current.table.header.iter().map(|column| record.get(column).cloned().unwrap_or_default()).collect();
        let id = &row[key_column];
        if id.is_empty() {
            return Err(invalid("每条记录必须提供非空主键"));
        }
        if let Some(existing) = known.get(id) {
            if existing != &row {
                return Err(DatasetAppendError::KeyConflict);
            }
            skipped += 1;
        } else {
            known.insert(id.clone(), row.clone());
            new_rows.push(row);
        }
    }
    let appended = new_rows.len();
    let sha = if appended == 0 {
        current.sha
    } else {
        write_dataset_ops(
            vfs,
            path,
            &current.sha,
            current.schema_sha.as_deref(),
            &[DatasetOp::InsertRows { at: current.table.rows.len(), rows: new_rows }],
            &limits,
        )
        .map_err(|error| DatasetAppendError::Invalid(error.to_string()))?
        .sha
    };
    Ok(DatasetAppended { appended, skipped, sha })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shard_core::FsVfs;

    fn entry(id: &str, path: &str) -> TextEntry {
        TextEntry {
            id: id.into(),
            path: path.into(),
            title: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            kind: None,
            tags: vec!["inbox".into()],
            modified_at: 0,
            body: String::new(),
        }
    }

    #[test]
    fn appended_list_items_continue_the_list() {
        assert_eq!(join_appended("- [ ] 一\n", "- [ ] 二"), "- [ ] 一\n- [ ] 二");
        assert_eq!(join_appended("1. 一", "2. 二"), "1. 一\n2. 二");
        assert_eq!(join_appended("段落", "- 列表"), "段落\n\n- 列表");
        assert_eq!(join_appended("- 列表", "段落"), "- 列表\n\n段落");
        assert_eq!(join_appended("", "  新的 "), "新的");
    }

    #[test]
    fn note_body_gets_title_heading_once() {
        assert_eq!(with_title_heading("周报", "内容"), "# 周报\n\n内容");
        assert_eq!(with_title_heading("周报", "# 自定\n\n内容"), "# 自定\n\n内容");
        assert_eq!(with_title_heading("周报", ""), "# 周报");
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

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn edited_tags_follow_body_and_keep_type() {
        assert_eq!(edited_tags(&tags(&["inbox", "旧标签"]), "买咖啡 #生活"), tags(&["inbox", "生活"]));
        assert_eq!(
            edited_tags(&tags(&["document", "inbox"]), "# 标题\n\n正文 #读书"),
            tags(&["document", "inbox", "读书"])
        );
        assert_eq!(edited_tags(&tags(&["inbox"]), "随手记 #outline"), tags(&["inbox"]));
        assert_eq!(edited_tags(&tags(&["document", "inbox"]), "改成笔记 #note"), tags(&["document", "inbox"]));
    }

    #[test]
    fn plan_rejects_protected_empty_and_lockbox_and_skips_unchanged() {
        assert_eq!(plan_rewrite(&tags(&["inbox", "outline"]), "a", "b").unwrap_err(), PROTECTED_MESSAGE);
        assert_eq!(plan_rewrite(&tags(&["inbox"]), "a", "  ").unwrap_err(), EMPTY_BODY_MESSAGE);
        assert_eq!(plan_rewrite(&tags(&["inbox"]), "a", "a").unwrap(), None);
        assert_eq!(plan_rewrite(&tags(&["inbox"]), "a", "b #密匣").unwrap_err(), LOCKBOX_MESSAGE);
        assert_eq!(plan_rewrite(&tags(&["inbox"]), "a", "b #新").unwrap(), Some(tags(&["inbox", "新"])));
    }

    #[test]
    fn resolve_by_id_path_index_and_unique_fragment() {
        let entries = vec![
            entry("20260926-061830-81b8ea9d-a2237f", "fragments/2026/09/a.md"),
            entry("20260926-071830-81b8ffff-b3348e", "notes/项目/计划.md"),
        ];
        let id = |resolved: Resolved<'_>| match resolved {
            Resolved::Found(entry) => entry.id.clone(),
            Resolved::NotFound => "NOT_FOUND".into(),
            Resolved::Ambiguous(matched) => format!("AMBIGUOUS:{}", matched.len()),
        };
        assert_eq!(id(resolve_target(&entries, "notes/项目/计划.md", None)), entries[1].id);
        assert_eq!(id(resolve_target(&entries, "./notes/项目/计划.md", None)), entries[1].id);
        assert_eq!(id(resolve_target(&entries, "notes/不存在.md", None)), "NOT_FOUND");
        assert_eq!(id(resolve_target(&entries, "81b8ea9d", None)), entries[0].id);
        assert_eq!(id(resolve_target(&entries, "81B8", None)), "AMBIGUOUS:2");
        assert_eq!(id(resolve_target(&entries, "81b", None)), "NOT_FOUND");
        let recalled = vec![entries[1].id.clone()];
        assert_eq!(id(resolve_target(&entries, "1", Some(&recalled))), entries[1].id);
        assert_eq!(id(resolve_target(&entries, "2", Some(&recalled))), "NOT_FOUND");
    }

    #[test]
    fn tag_counts_skip_system_tags_and_sort_by_count() {
        let lists = [tags(&["inbox", "读书"]), tags(&["inbox", "note", "读书", "摘录"])];
        assert_eq!(
            tag_counts(lists.iter().map(Vec::as_slice)),
            vec![TagCount { tag: "读书".into(), count: 2 }, TagCount { tag: "摘录".into(), count: 1 }]
        );
    }

    fn vault() -> (tempfile::TempDir, FsVfs) {
        let directory = tempfile::tempdir().unwrap();
        let vfs = FsVfs::new(directory.path());
        shard_core::ensure_vault_layout(&vfs).unwrap();
        (directory, vfs)
    }

    #[test]
    fn rewrite_checks_base_and_keeps_other_frontmatter() {
        let (directory, vfs) = vault();
        let path = directory.path().join("fragments/2026/09/one.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = "---\nid: one\ncreated_at: 2026-09-29T00:00:00Z\nupdated_at: 2026-09-29T00:00:00Z\ntags: [inbox]\ncategory: null\nai_status: none\nsource: test\n---\n\n- 一\n";
        std::fs::write(&path, original).unwrap();
        assert_eq!(
            rewrite_document(&vfs, &path, Some("stale"), |_| "x".into(), "t".into()).unwrap_err(),
            RewriteError::Stale
        );
        let sha = content_sha256_hex(original);
        let written = rewrite_document(
            &vfs,
            &path,
            Some(&sha),
            |current| join_appended(current, "- 二 #新"),
            "2026-10-01T00:00:00+08:00".into(),
        )
        .unwrap();
        assert!(written.changed);
        assert_eq!(written.tags(), tags(&["inbox", "新"]));
        let parsed = parse_fragment(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.body.trim(), "- 一\n- 二 #新");
        assert_eq!(parsed.frontmatter.source, "test");
        assert_eq!(parsed.frontmatter.updated_at, "2026-10-01T00:00:00+08:00");
        let same = rewrite_document(&vfs, &path, None, |current| current.to_string(), "later".into()).unwrap();
        assert!(!same.changed);
        assert_eq!(same.sha, written.sha);
    }

    #[cfg(unix)]
    #[test]
    fn local_listing_matches_vfs_listing_and_skips_unusable_entries() {
        let (directory, vfs) = vault();
        let root = directory.path();
        let write = |rel: &str, body: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("---\nid: {rel}\ncreated_at: 2026-09-29T00:00:00Z\nupdated_at: 2026-09-29T00:00:00Z\ntags: [inbox]\ncategory: null\nai_status: none\nsource: test\n---\n\n{body}\n")).unwrap();
        };
        write("fragments/2026/09/a.md", "一");
        write("notes/项目/b.md", "二");
        std::fs::write(root.join("notes/坏的.md"), "没有 frontmatter").unwrap();
        std::os::unix::fs::symlink(root.join("不存在.md"), root.join("notes/悬空.md")).unwrap();
        let mut local = load_local_text_entries(root).unwrap();
        let mut shared = load_text_entries(&vfs).unwrap();
        local.sort_by(|left, right| left.path.cmp(&right.path));
        shared.sort_by(|left, right| left.path.cmp(&right.path));
        assert_eq!(local, shared);
        assert_eq!(local.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(), ["fragments/2026/09/a.md", "notes/项目/b.md"]);
        assert_eq!(list_local_library_items(root, None).unwrap(), list_library_items(&vfs, None).unwrap());
        assert!(list_local_library_items(root, None).unwrap().iter().all(|item| !item.path.contains("悬空")));
        assert!(entry_still_at(&vfs, "notes/项目/b.md", "notes/项目/b.md"));
        assert!(!entry_still_at(&vfs, "notes/项目/b.md", "别的 id"));
        assert!(!entry_still_at(&vfs, "notes/不存在.md", "notes/不存在.md"));
    }

    #[test]
    fn dataset_append_is_idempotent_by_primary_key() {
        let (_directory, vfs) = vault();
        let header = tags(&["id", "书名"]);
        shard_core::dataset::create_dataset(
            &vfs,
            "阅读记录",
            header.clone(),
            vec![tags(&["1", "置身事内"])],
            Some("id".into()),
            &DatasetLimits::default(),
        )
        .unwrap();
        let record = |id: &str, name: &str| HashMap::from([("id".to_string(), id.to_string()), ("书名".to_string(), name.to_string())]);
        let path = "datasets/阅读记录.csv";
        let first = append_dataset_records(&vfs, path, &header, vec![record("2", "人类简史"), record("1", "置身事内")]).unwrap();
        assert_eq!((first.appended, first.skipped), (1, 1));
        let again = append_dataset_records(&vfs, path, &header, vec![record("2", "人类简史")]).unwrap();
        assert_eq!((again.appended, again.skipped, again.sha.clone()), (0, 1, first.sha.clone()));
        assert_eq!(
            append_dataset_records(&vfs, path, &header, vec![record("2", "别的书")]).unwrap_err(),
            DatasetAppendError::KeyConflict
        );
        assert_eq!(
            append_dataset_records(&vfs, path, &tags(&["id"]), vec![]).unwrap_err(),
            DatasetAppendError::HeaderChanged
        );
    }
}
