//! Wikilink 解析、目标解析与 wikilink 关系派生。
//!
//! 规则逐条移植自前端，前端仍是真相源。两边共用同一份用例
//! `crates/shard-core/tests/fixtures/wikilink-cases.json`（Rust：`tests/wikilink_fixtures.rs`，
//! TS：`src/lib/wikilink.fixtures.test.ts`），改任何一边的规则都要连同 fixture 一起改。
//!
//! # 解析：`parse_wikilinks`（`src/lib/wikilink.ts` 36-67 行 `parseWikilinks`）
//!
//! - 从游标起找 `[[`，再从 `[[` 之后找最近的 `]]`；找不到 `]]` 就整体停止（未闭合不再往后扫）。
//! - 不处理嵌套：`[[a [[b]] c]]` 的目标是 `a [[b`，下一轮从这个 `]]` 之后继续。
//! - 第一个 `|` 分开目标与别名，两侧按 JS `String.prototype.trim` 去空白；目标为空、或写了
//!   `|` 但别名为空的都丢弃（游标照样前移）。
//! - `!` 紧挨 `[[` 且目标归一化后以 `.csv` 结尾才算嵌入（`embed`），嵌入的区间从 `!` 开始；
//!   非 CSV 的 `![[x]]` 是普通链接，区间不含 `!`。
//! - 区间单位不同：TS 是 UTF-16 下标，这里是 UTF-8 字节下标；两边按「区间对应的原文子串」对齐。
//!
//! # 归一化：`normalize_wikilink_target`（196-198 行）
//!
//! `trim()` → NFKC → 小写。JS 的 `trim` 与 Rust 的 `str::trim` 空白集合不同（JS 含 U+FEFF、
//! 不含 U+0085），这里按 JS 的集合实现。`toLocaleLowerCase("zh-CN")` 在 zh 区域没有特殊规则，
//! 等同完整 Unicode 小写映射（含词尾 Σ→ς），与 `str::to_lowercase` 一致。
//!
//! # 笔记标题：`derive_note_title`（`src/lib/content-kind.ts` 74-90 行 `deriveNoteTitle`）
//!
//! - 先按 `stripMarkdownHardBreaks(content, 32_000)` 去掉 Lezer 认定的硬换行反斜杠（见
//!   [`strip_markdown_hard_breaks`]），再按 `/\r?\n/` 切行。
//! - 全文第一个 `^ {0,3}#\s+(.+?)\s*$` 的一级标题（不限位置、不排除代码块）即标题，去掉
//!   结尾的 ` ###` 再 trim。
//! - 没有一级标题就取第一个非空行 trim；超过 48 个 UTF-16 code unit 截到 48、去尾部空白后加 `…`。
//!
//! # 候选与目标解析
//!
//! - 碎片候选（`buildWikilinkCandidates` 97-149 行）：密匣碎片不参与；回收站里的碎片照样参与。
//!   只有笔记（`kind == note`）有标题；首选目标是笔记标题，否则是去掉 `.md`（不分大小写）的文件名
//!   主干。首选目标归一化后在全部非密匣候选（含正在保存的文档自身）里重复时，退回
//!   `文件名主干 || 文件名 || id`。匹配键是 `[目标, 标题, 文件名主干, 文件名]` 归一化、去空、去重。
//! - CSV 候选（69-81 行）：目标是相对路径，匹配键 `[路径, 文件名]`。
//! - 导图候选（83-95 行）：目标是导图标题，匹配键 `[路径, 标题]`。
//! - `resolve_wikilink_target`（151-162 行）：归一化后为空返回 `None`；恰好一个候选的匹配键
//!   包含它才返回，零个或多个都是 `None`。
//! - 候选的 `label`（只用于补全菜单展示，碎片摘要依赖 `markdownToSearchText`）没有移植。
//!
//! # 关系派生：`derive_wikilink_relations` / `plan_wikilink_relation_sync`
//!
//! 依据 `src/workspace/workbench-shell.tsx`：新建碎片 937-963 行，更新碎片 1170-1217 行。
//!
//! - 只用**碎片候选**（`buildWikilinkCandidates`），不含 CSV 与导图候选，所以 `[[x.csv]]`、
//!   `![[x.csv]]` 只有恰好命中某篇碎片/笔记（例如标题就是 `x.csv` 的笔记）时才会建关系，
//!   嵌入链接与普通链接同等对待。
//! - 候选集合 = 全部已知文档（含回收站、含密匣但会被过滤）里，把正在保存的文档替换成保存后的
//!   版本（更新：1172-1176 行）或追加到末尾（新建：941 行）。它自己的标题参与重名计数。
//! - 逐个链接解析，取命中候选的碎片 id，去掉空 id 与自身 id，按首次出现顺序去重
//!   （1177-1186 行 / 942-953 行的 `Set`）。
//! - 文档在密匣里（新建走密匣分支提前返回，更新时 `movesToLockbox || editsLockbox` 跳过同步，
//!   1170 行）就完全不做 wikilink 同步，这里返回 `None`，调用方不要动现有关系。
//! - 增删（1187-1217 行）：删除 = 现有关系里 `origin == "wikilink"` 且不在新目标集合里的；
//!   新增 = 新目标里在现有关系中（**任意来源**）都没有的。所以手动/标签关系从不被删，已有手动关系
//!   的目标也不会再叠一条 wikilink 关系。后端 `unlink_fragments_in_vault` 删除该目标的所有关系，
//!   `link_fragments_in_vault` 对已存在的目标不重复追加（`src-tauri/src/lib.rs` 6486-6501、
//!   6532-6534 行），[`apply_wikilink_relation_sync`] 照此执行。

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::FragmentRelation;

/// wikilink 派生关系的来源标记。
pub const WIKILINK_RELATION_ORIGIN: &str = "wikilink";
/// `deriveNoteTitle` 首行截断长度，按 UTF-16 code unit 计（JS `length`）。
pub const NOTE_TITLE_MAX_LENGTH: usize = 48;
/// `deriveNoteTitle` 识别硬换行的范围，按 UTF-16 code unit 计。
pub const NOTE_TITLE_HARD_BREAK_PARSE_LIMIT: usize = 32_000;

/// 一处 wikilink。`from..to` 是 `content` 里的 UTF-8 字节区间（嵌入时含开头的 `!`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkMatch {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub embed: bool,
    pub from: usize,
    pub to: usize,
}

/// 文档类型，对应 TS `ContentKind`（`src/lib/content-kind.ts`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentKind {
    Fragment,
    Note,
    Outline,
    Flowchart,
    Document,
}

impl ContentKind {
    /// `deriveKind`：按 `TYPE_TAGS` 顺序取第一个类型标签，缺省是碎片。
    pub fn from_tags(tags: &[String]) -> Self {
        match crate::derive_type(tags) {
            Some("note") => Self::Note,
            Some("outline") => Self::Outline,
            Some("flowchart") => Self::Flowchart,
            Some("document") => Self::Document,
            _ => Self::Fragment,
        }
    }
}

/// 候选类别，对应 TS `WikilinkCandidate["kind"]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WikilinkCandidateKind {
    Fragment,
    Note,
    Outline,
    Flowchart,
    Document,
    Csv,
    Mindmap,
}

impl From<ContentKind> for WikilinkCandidateKind {
    fn from(kind: ContentKind) -> Self {
        match kind {
            ContentKind::Fragment => Self::Fragment,
            ContentKind::Note => Self::Note,
            ContentKind::Outline => Self::Outline,
            ContentKind::Flowchart => Self::Flowchart,
            ContentKind::Document => Self::Document,
        }
    }
}

/// 参与 wikilink 解析的一篇碎片/笔记（TS `Fragment` 里用得到的字段）。
/// `path` 是 vault 相对路径，回收站里的碎片照常传入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkDocument {
    pub id: String,
    pub path: String,
    pub kind: ContentKind,
    pub content: String,
    #[serde(default)]
    pub lockbox: bool,
}

/// CSV 文件（TS `CsvFileSummary` 的 `name`、`path`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkCsvFile {
    pub name: String,
    pub path: String,
}

/// 思维导图（TS `MindMapSummary` 的 `path`、`title`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkMindMap {
    pub path: String,
    pub title: String,
}

/// 解析候选。碎片候选有 `fragment_id`、没有 `path`；CSV 与导图候选相反。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkCandidate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_id: Option<String>,
    pub kind: WikilinkCandidateKind,
    pub match_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub target: String,
}

/// 一次保存要对 `origin == "wikilink"` 关系做的增删，均为目标 id。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkRelationSync {
    pub removed: Vec<String>,
    pub added: Vec<String>,
}

pub fn parse_wikilinks(content: &str) -> Vec<WikilinkMatch> {
    let bytes = content.as_bytes();
    let mut links = Vec::new();
    let mut cursor = 0;

    while cursor + 1 < content.len() {
        let Some(from) = find_from(content, "[[", cursor) else {
            break;
        };
        let Some(to_start) = find_from(content, "]]", from + 2) else {
            break;
        };

        let raw = &content[from + 2..to_start];
        let (target, alias) = match raw.find('|') {
            Some(separator) => (
                js_trim(&raw[..separator]),
                Some(js_trim(&raw[separator + 1..])),
            ),
            None => (js_trim(raw), None),
        };

        if !target.is_empty() && alias.is_none_or(|alias| !alias.is_empty()) {
            let embed = from > 0 && bytes[from - 1] == b'!' && is_csv_wikilink_target(target);
            links.push(WikilinkMatch {
                target: target.to_string(),
                alias: alias.map(str::to_string),
                embed,
                from: if embed { from - 1 } else { from },
                to: to_start + 2,
            });
        }

        cursor = to_start + 2;
    }

    links
}

pub fn normalize_wikilink_target(value: &str) -> String {
    js_trim(value).nfkc().collect::<String>().to_lowercase()
}

pub fn is_csv_wikilink_target(value: &str) -> bool {
    normalize_wikilink_target(value).ends_with(".csv")
}

pub fn derive_note_title(content: &str) -> String {
    let visible = strip_markdown_hard_breaks(content, NOTE_TITLE_HARD_BREAK_PARSE_LIMIT);
    let lines = split_lines(&visible);

    if let Some(heading) = lines.iter().find_map(|line| match_note_heading(line)) {
        return js_trim(strip_closing_hashes(heading)).to_string();
    }

    let first_line = lines
        .iter()
        .map(|line| js_trim(line))
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if utf16_len(first_line) <= NOTE_TITLE_MAX_LENGTH {
        return first_line.to_string();
    }

    let mut title = js_trim_end(utf16_prefix(first_line, NOTE_TITLE_MAX_LENGTH)).to_string();
    title.push('…');
    title
}

/// 移植 `@shard/markdown/core` 的 `stripMarkdownHardBreaks`
/// （`packages/markdown/src/core/syntax.ts` 106-121 行）：只删除 Lezer 解析出的 `HardBreak`
/// 节点里「反斜杠 + 换行」的反斜杠，代码、HTML、链接引用定义、表格行里的不动。
///
/// `max_parse_len` 按 UTF-16 code unit 计：超长时只解析到这之前最后一个换行为止的完整行。
pub fn strip_markdown_hard_breaks(content: &str, max_parse_len: usize) -> Cow<'_, str> {
    let end = hard_break_parse_end(content, max_parse_len);
    let prefix = &content[..end];
    if !prefix.contains("\\\n") {
        return Cow::Borrowed(content);
    }
    let offsets = lezer::hard_break_marker_offsets(prefix);
    if offsets.is_empty() {
        return Cow::Borrowed(content);
    }

    let mut visible = String::with_capacity(content.len());
    let mut from = 0;
    for offset in offsets {
        visible.push_str(&content[from..offset]);
        from = offset + 1;
    }
    visible.push_str(&content[from..]);
    Cow::Owned(visible)
}

pub fn build_wikilink_candidates(fragments: &[WikilinkDocument]) -> Vec<WikilinkCandidate> {
    build_fragment_candidates(fragments.iter())
}

pub fn build_csv_wikilink_candidates(files: &[WikilinkCsvFile]) -> Vec<WikilinkCandidate> {
    files
        .iter()
        .map(|file| WikilinkCandidate {
            fragment_id: None,
            kind: WikilinkCandidateKind::Csv,
            match_keys: unique_normalized_keys([file.path.as_str(), file.name.as_str()]),
            path: Some(file.path.clone()),
            target: file.path.clone(),
        })
        .collect()
}

pub fn build_mind_map_wikilink_candidates(maps: &[WikilinkMindMap]) -> Vec<WikilinkCandidate> {
    maps.iter()
        .map(|map| WikilinkCandidate {
            fragment_id: None,
            kind: WikilinkCandidateKind::Mindmap,
            match_keys: unique_normalized_keys([map.path.as_str(), map.title.as_str()]),
            path: Some(map.path.clone()),
            target: map.title.clone(),
        })
        .collect()
}

pub fn resolve_wikilink_target<'a>(
    target: &str,
    candidates: &'a [WikilinkCandidate],
) -> Option<&'a WikilinkCandidate> {
    let normalized = normalize_wikilink_target(target);
    if normalized.is_empty() {
        return None;
    }

    let mut matches = candidates
        .iter()
        .filter(|candidate| candidate.match_keys.contains(&normalized));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

/// 一篇文档保存后应有的 `origin == "wikilink"` 关系目标 id（按链接首次出现顺序）。
///
/// `source` 是保存后的版本；`corpus` 是全部已知碎片/笔记（可以含 `source` 的旧版本，会被替换；
/// 不含时追加）。返回 `None` 表示 `source` 在密匣里，前端此时不做 wikilink 同步。
pub fn derive_wikilink_relations(
    source: &WikilinkDocument,
    corpus: &[WikilinkDocument],
) -> Option<Vec<String>> {
    if source.lockbox {
        return None;
    }

    let links = parse_wikilinks(&source.content);
    if links.is_empty() {
        return Some(Vec::new());
    }

    let mut documents = corpus
        .iter()
        .map(|document| {
            if document.id == source.id {
                source
            } else {
                document
            }
        })
        .collect::<Vec<_>>();
    if !corpus.iter().any(|document| document.id == source.id) {
        documents.push(source);
    }
    let candidates = build_fragment_candidates(documents);

    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for link in &links {
        let Some(target_id) = resolve_wikilink_target(&link.target, &candidates)
            .and_then(|candidate| candidate.fragment_id.as_deref())
        else {
            continue;
        };
        if !target_id.is_empty() && target_id != source.id && seen.insert(target_id) {
            targets.push(target_id.to_string());
        }
    }
    Some(targets)
}

/// 由现有关系与新目标集合算出要删、要加的目标（`workbench-shell.tsx` 1187-1200 行）。
pub fn plan_wikilink_relation_sync(
    current: &[FragmentRelation],
    next_targets: &[String],
) -> WikilinkRelationSync {
    let next = next_targets
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let removed = current
        .iter()
        .filter(|relation| {
            relation.origin == WIKILINK_RELATION_ORIGIN
                && !next.contains(relation.target_id.as_str())
        })
        .map(|relation| relation.target_id.clone())
        .collect();

    let existing = current
        .iter()
        .map(|relation| relation.target_id.as_str())
        .collect::<HashSet<_>>();
    let mut added_seen = HashSet::new();
    let added = next_targets
        .iter()
        .filter(|target| !existing.contains(target.as_str()) && added_seen.insert(target.as_str()))
        .cloned()
        .collect();

    WikilinkRelationSync { removed, added }
}

/// 按后端 link/unlink 的语义把增删落到关系列表上：先删（删掉该目标的全部关系），
/// 再按顺序追加 `origin = "wikilink"` 的新关系（目标已存在则跳过）。
pub fn apply_wikilink_relation_sync(
    current: &[FragmentRelation],
    sync: &WikilinkRelationSync,
    created_at: &str,
) -> Vec<FragmentRelation> {
    let mut related = current.to_vec();
    for target in &sync.removed {
        related.retain(|relation| relation.target_id != *target);
    }
    for target in &sync.added {
        if related.iter().any(|relation| relation.target_id == *target) {
            continue;
        }
        related.push(FragmentRelation {
            target_id: target.clone(),
            origin: WIKILINK_RELATION_ORIGIN.to_string(),
            created_at: created_at.to_string(),
            note: None,
        });
    }
    related
}

fn build_fragment_candidates<'a>(
    fragments: impl IntoIterator<Item = &'a WikilinkDocument>,
) -> Vec<WikilinkCandidate> {
    struct Prepared<'a> {
        fragment: &'a WikilinkDocument,
        file_name: &'a str,
        file_stem: &'a str,
        title: String,
        preferred: String,
    }

    let prepared = fragments
        .into_iter()
        .filter(|fragment| !fragment.lockbox)
        .map(|fragment| {
            let file_name = file_name_of(&fragment.path);
            let file_stem = strip_markdown_extension(file_name);
            let title = if fragment.kind == ContentKind::Note {
                derive_note_title(&fragment.content)
            } else {
                String::new()
            };
            let preferred = if fragment.kind == ContentKind::Note && !title.is_empty() {
                title.clone()
            } else {
                file_stem.to_string()
            };
            Prepared {
                fragment,
                file_name,
                file_stem,
                title,
                preferred,
            }
        })
        .collect::<Vec<_>>();

    let mut preferred_counts = HashMap::<String, usize>::new();
    for item in &prepared {
        *preferred_counts
            .entry(normalize_wikilink_target(&item.preferred))
            .or_default() += 1;
    }

    prepared
        .into_iter()
        .map(|item| {
            let unique =
                preferred_counts.get(&normalize_wikilink_target(&item.preferred)) == Some(&1);
            let target = if unique {
                item.preferred
            } else {
                [item.file_stem, item.file_name, item.fragment.id.as_str()]
                    .into_iter()
                    .find(|value| !value.is_empty())
                    .unwrap_or("")
                    .to_string()
            };
            let match_keys = unique_normalized_keys([
                target.as_str(),
                item.title.as_str(),
                item.file_stem,
                item.file_name,
            ]);
            WikilinkCandidate {
                fragment_id: Some(item.fragment.id.clone()),
                kind: item.fragment.kind.into(),
                match_keys,
                path: None,
                target,
            }
        })
        .collect()
}

fn unique_normalized_keys<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut keys = Vec::new();
    for key in values.into_iter().map(normalize_wikilink_target) {
        if !key.is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// `getFileName`：按 `/` 或 `\` 切开、去空段后的最后一段。
fn file_name_of(path: &str) -> &str {
    path.split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .unwrap_or("")
}

/// `stripMarkdownExtension`：去掉结尾的 `.md`（不分大小写）。
fn strip_markdown_extension(file_name: &str) -> &str {
    let bytes = file_name.as_bytes();
    if bytes.len() >= 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md") {
        &file_name[..file_name.len() - 3]
    } else {
        file_name
    }
}

fn find_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack.get(from..)?.find(needle).map(|index| index + from)
}

/// JS `\s` / `trim()` 的空白集合：Unicode White_Space 去掉 U+0085，加上 U+FEFF。
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

/// JS 正则 `.`（无 `s` 标志）匹配不到的行终止符。
fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

fn js_trim_end(value: &str) -> &str {
    value.trim_end_matches(is_js_whitespace)
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// 前 `units` 个 UTF-16 code unit。JS `slice` 可能切开代理对留下孤立代理，Rust 字符串表示不了，
/// 这里把被切开的那个字符整个丢掉。
fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in value.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return &value[..index];
        }
    }
    value
}

/// `split(/\r?\n/u)`：只有紧跟 `\n` 的那个 `\r` 才算分隔符的一部分。
fn split_lines(value: &str) -> Vec<&str> {
    let mut lines = value.split('\n').collect::<Vec<_>>();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// `/^ {0,3}#\s+(.+?)\s*$/u` 的捕获组；捕获为空白（之后会被跳过）时也返回 `None`。
fn match_note_heading(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line[spaces..].strip_prefix('#')?;
    if !rest.chars().next().is_some_and(is_js_whitespace) {
        return None;
    }
    let body = js_trim(rest);
    if body.is_empty() || body.chars().any(is_js_line_terminator) {
        return None;
    }
    Some(body)
}

/// `.replace(/\s+#+\s*$/u, "")`：去掉结尾「空白 + 一串 #」。
fn strip_closing_hashes(heading: &str) -> &str {
    let trimmed = js_trim_end(heading);
    let without_hashes = trimmed.trim_end_matches('#');
    if without_hashes.len() == trimmed.len() {
        return heading;
    }
    let before = js_trim_end(without_hashes);
    if before.len() == without_hashes.len() {
        return heading;
    }
    before
}

/// `content.lastIndexOf("\n", max - 1) + 1`（UTF-16 下标），换算成字节下标。
fn hard_break_parse_end(content: &str, max_parse_len: usize) -> usize {
    if utf16_len(content) <= max_parse_len {
        return content.len();
    }
    let last_index = max_parse_len.saturating_sub(1);
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in content.char_indices() {
        if units > last_index {
            break;
        }
        if ch == '\n' {
            end = index + 1;
        }
        units += ch.len_utf16();
    }
    end
}

/// `@lezer/markdown`（`CommonMark + GFM + ==荧光==`，即 `packages/markdown/src/core/syntax.ts`
/// 的 `markdownParser`）里决定 `HardBreak` 的那一部分，按其块级/行内解析器的结构移植：
///
/// - 块级：容器（引用、列表）与懒续行、缩进代码、围栏代码、ATX 标题、分隔线、HTML 块、
///   Setext 标题、链接引用定义、GFM 表格（含打断段落的表头检测），以及段落的打断规则。
/// - 行内：转义、实体、行内代码、HTML 标签/注释/处理指令/声明/CDATA、尖括号自动链接、
///   强调定界符、链接/图片（目的地、标题、引用标签）、GFM 裸链接自动识别。
///
/// 只需要判断「段落/Setext 标题里的哪个 `\` + `\n` 是硬换行」，不建语法树。位置一律用 UTF-8
/// 字节；Lezer 用 UTF-16，但所有判定都发生在 ASCII 字符上，两者等价。
mod lezer {
    use super::is_js_whitespace;

    pub(super) fn hard_break_marker_offsets(doc: &str) -> Vec<usize> {
        let mut parser = BlockParser::new(doc);
        while parser.advance() {}
        parser.breaks
    }

    // ---------------------------------------------------------------- 字符工具

    /// Lezer 的 `space()`：空格、制表、换行、回车。
    fn space(ch: i32) -> bool {
        matches!(ch, 9 | 10 | 13 | 32)
    }

    fn byte_at(text: &[u8], index: usize) -> i32 {
        text.get(index).map_or(-1, |byte| i32::from(*byte))
    }

    fn skip_space(text: &[u8], mut from: usize) -> usize {
        while from < text.len() && space(i32::from(text[from])) {
            from += 1;
        }
        from
    }

    /// JS 正则 `\w`（无 `u` 标志）。
    fn is_word(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || byte == b'_'
    }

    fn utf8_len(lead: u8) -> usize {
        match lead {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            _ => 4,
        }
    }

    /// `index` 处若是 JS `\s` 空白，返回它的字节长度，否则 0。
    fn js_space_at(text: &str, index: usize) -> usize {
        text.get(index..)
            .and_then(|rest| rest.chars().next())
            .filter(|ch| is_js_whitespace(*ch))
            .map_or(0, char::len_utf8)
    }

    fn skip_js_space(text: &str, mut index: usize) -> usize {
        loop {
            let len = js_space_at(text, index);
            if len == 0 {
                return index;
            }
            index += len;
        }
    }

    // ---------------------------------------------------------------- 行与容器

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Kind {
        Document,
        Blockquote,
        BulletList,
        OrderedList,
        ListItem,
    }

    /// `value`：列表项是内容缩进，列表是标记字符（`-`/`+`/`*` 或 `.`/`)`）。
    #[derive(Clone, Copy)]
    struct Context {
        kind: Kind,
        value: usize,
    }

    fn in_list(stack: &[Context], kind: Kind) -> bool {
        stack.iter().any(|context| context.kind == kind)
    }

    #[derive(Clone, Copy)]
    struct Line<'a> {
        text: &'a str,
        base_indent: usize,
        base_pos: usize,
        pos: usize,
        indent: usize,
        next: i32,
        depth: usize,
    }

    impl<'a> Line<'a> {
        fn new(text: &'a str) -> Self {
            let mut line = Self {
                text,
                base_indent: 0,
                base_pos: 0,
                pos: 0,
                indent: 0,
                next: -1,
                depth: 1,
            };
            line.forward_inner();
            line
        }

        fn bytes(&self) -> &'a [u8] {
            self.text.as_bytes()
        }

        fn forward(&mut self) {
            if self.base_pos > self.pos {
                self.forward_inner();
            }
        }

        fn forward_inner(&mut self) {
            let new_pos = skip_space(self.bytes(), self.base_pos);
            self.indent = self.count_indent(new_pos, self.pos, self.indent);
            self.pos = new_pos;
            self.next = byte_at(self.bytes(), new_pos);
        }

        fn count_indent(&self, to: usize, from: usize, mut indent: usize) -> usize {
            let bytes = self.bytes();
            for byte in bytes.get(from..to.min(bytes.len())).unwrap_or_default() {
                indent += if *byte == b'\t' { 4 - indent % 4 } else { 1 };
            }
            indent
        }

        fn find_column(&self, goal: usize) -> usize {
            let bytes = self.bytes();
            let mut index = 0;
            let mut indent = 0;
            while index < bytes.len() && indent < goal {
                indent += if bytes[index] == b'\t' {
                    4 - indent % 4
                } else {
                    1
                };
                index += 1;
            }
            index
        }

        fn move_base(&mut self, to: usize) {
            self.base_pos = to;
            self.base_indent = self.count_indent(to, self.pos, self.indent);
        }

        fn move_base_column(&mut self, indent: usize) {
            self.base_indent = indent;
            self.base_pos = self.find_column(indent);
        }

        /// 续行进入段落内容时，容器标记换成等长空格（`baseIndent == 0` 时保留整行）。
        fn scrub(&self) -> String {
            if self.base_indent == 0 {
                return self.text.to_string();
            }
            let base_pos = self.base_pos.min(self.text.len());
            let mut scrubbed = " ".repeat(base_pos);
            scrubbed.push_str(&self.text[base_pos..]);
            scrubbed
        }
    }

    // ---------------------------------------------------------------- 块级判定

    fn is_blockquote(line: &Line) -> i32 {
        if line.next != i32::from(b'>') {
            return -1;
        }
        if byte_at(line.bytes(), line.pos + 1) == i32::from(b' ') {
            2
        } else {
            1
        }
    }

    fn is_fenced_code(line: &Line) -> i32 {
        if line.next != i32::from(b'`') && line.next != i32::from(b'~') {
            return -1;
        }
        let bytes = line.bytes();
        let mut pos = line.pos + 1;
        while pos < bytes.len() && i32::from(bytes[pos]) == line.next {
            pos += 1;
        }
        if pos < line.pos + 3 {
            return -1;
        }
        if line.next == i32::from(b'`') && bytes[pos..].contains(&b'`') {
            return -1;
        }
        pos as i32
    }

    fn is_atx_heading(line: &Line) -> i32 {
        if line.next != i32::from(b'#') {
            return -1;
        }
        let bytes = line.bytes();
        let mut pos = line.pos + 1;
        while pos < bytes.len() && bytes[pos] == b'#' {
            pos += 1;
        }
        if pos < bytes.len() && bytes[pos] != b' ' {
            return -1;
        }
        let size = pos - line.pos;
        if size > 6 {
            -1
        } else {
            size as i32
        }
    }

    fn is_setext_underline(line: &Line) -> i32 {
        if (line.next != i32::from(b'=') && line.next != i32::from(b'-'))
            || line.indent >= line.base_indent + 4
        {
            return -1;
        }
        let bytes = line.bytes();
        let mut pos = line.pos + 1;
        while pos < bytes.len() && i32::from(bytes[pos]) == line.next {
            pos += 1;
        }
        let end = pos;
        while pos < bytes.len() && space(i32::from(bytes[pos])) {
            pos += 1;
        }
        if pos == bytes.len() {
            end as i32
        } else {
            -1
        }
    }

    fn is_horizontal_rule(line: &Line, stack: &[Context], breaking: bool) -> i32 {
        if line.next != i32::from(b'_')
            && line.next != i32::from(b'-')
            && line.next != i32::from(b'*')
        {
            return -1;
        }
        let bytes = line.bytes();
        let mut count = 1;
        for &byte in &bytes[line.pos + 1..] {
            if i32::from(byte) == line.next {
                count += 1;
            } else if !space(i32::from(byte)) {
                return -1;
            }
        }
        // Setext 标题优先。
        if breaking
            && line.next == i32::from(b'-')
            && is_setext_underline(line) > -1
            && line.depth == stack.len()
        {
            return -1;
        }
        if count < 3 {
            -1
        } else {
            1
        }
    }

    fn is_bullet_list(line: &Line, stack: &[Context], breaking: bool) -> i32 {
        let bytes = line.bytes();
        let marker = line.next == i32::from(b'-')
            || line.next == i32::from(b'+')
            || line.next == i32::from(b'*');
        if marker
            && (line.pos + 1 == bytes.len() || space(byte_at(bytes, line.pos + 1)))
            && (!breaking
                || in_list(stack, Kind::BulletList)
                || skip_space(bytes, line.pos + 2) < bytes.len())
        {
            1
        } else {
            -1
        }
    }

    fn is_ordered_list(line: &Line, stack: &[Context], breaking: bool) -> i32 {
        let bytes = line.bytes();
        let mut pos = line.pos;
        let mut next = line.next;
        loop {
            if (i32::from(b'0')..=i32::from(b'9')).contains(&next) {
                pos += 1;
            } else {
                break;
            }
            if pos == bytes.len() {
                return -1;
            }
            next = i32::from(bytes[pos]);
        }
        if pos == line.pos
            || pos > line.pos + 9
            || (next != i32::from(b'.') && next != i32::from(b')'))
            || (pos + 1 < bytes.len() && !space(i32::from(bytes[pos + 1])))
            || (breaking
                && !in_list(stack, Kind::OrderedList)
                && (skip_space(bytes, pos + 1) == bytes.len()
                    || pos > line.pos + 1
                    || line.next != i32::from(b'1')))
        {
            return -1;
        }
        (pos + 1 - line.pos) as i32
    }

    fn get_list_indent(line: &Line, pos: usize) -> usize {
        let indent_after = line.count_indent(pos, line.pos, line.indent);
        let indented = line.count_indent(skip_space(line.bytes(), pos), pos, indent_after);
        if indented >= indent_after + 5 {
            indent_after + 1
        } else {
            indented
        }
    }

    const HTML_BLOCK_TAGS: [&str; 62] = [
        "address",
        "article",
        "aside",
        "base",
        "basefont",
        "blockquote",
        "body",
        "caption",
        "center",
        "col",
        "colgroup",
        "dd",
        "details",
        "dialog",
        "dir",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "frame",
        "frameset",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "head",
        "header",
        "hr",
        "html",
        "iframe",
        "legend",
        "li",
        "link",
        "main",
        "menu",
        "menuitem",
        "nav",
        "noframes",
        "ol",
        "optgroup",
        "option",
        "p",
        "param",
        "section",
        "source",
        "summary",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "title",
        "tr",
        "track",
        "ul",
    ];

    fn starts_with_ignore_case(text: &[u8], prefix: &str) -> bool {
        text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
    }

    /// HTML 块起始（Lezer `HTMLBlockStyle`）；`breaking` 时不含最后一种（完整单标签行）。
    fn html_block_kind(line: &Line, breaking: bool) -> Option<usize> {
        if line.next != i32::from(b'<') {
            return None;
        }
        let rest = &line.text[line.pos..];
        let kinds = if breaking { 6 } else { 7 };
        (0..kinds).find(|kind| html_block_starts(*kind, rest))
    }

    fn html_block_starts(kind: usize, rest: &str) -> bool {
        let bytes = rest.as_bytes();
        let ends_name = |index: usize| {
            index == bytes.len() || bytes[index] == b'>' || js_space_at(rest, index) > 0
        };
        match kind {
            0 => ["script", "pre", "style"].iter().any(|name| {
                starts_with_ignore_case(&bytes[1..], name) && ends_name(1 + name.len())
            }),
            1 => bytes.starts_with(b"<!--"),
            2 => bytes.starts_with(b"<?"),
            3 => bytes.starts_with(b"<!") && bytes.get(2).is_some_and(u8::is_ascii_uppercase),
            4 => bytes.starts_with(b"<![CDATA["),
            5 => {
                let start = if bytes.get(1) == Some(&b'/') { 2 } else { 1 };
                HTML_BLOCK_TAGS.iter().any(|name| {
                    let end = start + name.len();
                    starts_with_ignore_case(&bytes[start..], name)
                        && (end == bytes.len()
                            || bytes[end] == b'>'
                            || (bytes[end] == b'/' && bytes.get(end + 1) == Some(&b'>'))
                            || js_space_at(rest, end) > 0)
                })
            }
            _ => complete_tag_line(rest),
        }
    }

    /// `^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:…))?)*\s*>)\s*$`（不分大小写）。
    fn complete_tag_line(rest: &str) -> bool {
        let bytes = rest.as_bytes();
        let mut index = 1;
        let end = if bytes.get(1) == Some(&b'/') {
            index = 2;
            if !bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
                return false;
            }
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| is_word(*byte) || *byte == b'-')
            {
                index += 1;
            }
            index = skip_js_space(rest, index);
            if bytes.get(index) != Some(&b'>') {
                return false;
            }
            index + 1
        } else {
            if !bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
                return false;
            }
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| is_word(*byte) || *byte == b'-')
            {
                index += 1;
            }
            index = skip_attributes(rest, index, false);
            index = skip_js_space(rest, index);
            if bytes.get(index) != Some(&b'>') {
                return false;
            }
            index + 1
        };
        skip_js_space(rest, end) == bytes.len()
    }

    /// 标签属性串 `(\s+name(\s*=\s*value)?)*`，返回结束位置。
    /// 属性名字符：`[\w-.:]`（行内）或 `[\w-.]`（HTML 块）。
    fn skip_attributes(text: &str, mut index: usize, allow_colon: bool) -> usize {
        let bytes = text.as_bytes();
        loop {
            let name = skip_js_space(text, index);
            if name == index
                || !bytes
                    .get(name)
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b':' | b'_'))
            {
                return index;
            }
            let mut end = name + 1;
            while bytes.get(end).is_some_and(|byte| {
                is_word(*byte) || matches!(byte, b'-' | b'.') || (allow_colon && *byte == b':')
            }) {
                end += 1;
            }
            let equals = skip_js_space(text, end);
            if bytes.get(equals) == Some(&b'=') {
                let value = skip_js_space(text, equals + 1);
                match bytes.get(value) {
                    Some(quote @ (b'\'' | b'"')) => {
                        if let Some(close) =
                            bytes[value + 1..].iter().position(|byte| byte == quote)
                        {
                            end = value + 1 + close + 1;
                        }
                    }
                    Some(_) => {
                        let mut cursor = value;
                        while cursor < bytes.len()
                            && js_space_at(text, cursor) == 0
                            && !matches!(bytes[cursor], b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
                        {
                            cursor += utf8_len(bytes[cursor]);
                        }
                        if cursor > value {
                            end = cursor;
                        }
                    }
                    None => {}
                }
            }
            index = end;
        }
    }

    fn html_block_ends(kind: usize, text: &str) -> bool {
        let bytes = text.as_bytes();
        match kind {
            0 => bytes.windows(2).enumerate().any(|(index, pair)| {
                pair == b"</"
                    && ["script>", "pre>", "style>"]
                        .iter()
                        .any(|name| starts_with_ignore_case(&bytes[index + 2..], name))
            }),
            1 => text.contains("-->"),
            2 => text.contains("?>"),
            3 => text.contains('>'),
            4 => text.contains("]]>"),
            _ => bytes.iter().all(|byte| matches!(byte, b' ' | b'\t')),
        }
    }

    // ---------------------------------------------------------------- GFM 表格

    fn has_pipe(text: &[u8], start: usize) -> bool {
        let mut index = start;
        while index < text.len() {
            match text[index] {
                b'|' => return true,
                b'\\' => index += 1,
                _ => {}
            }
            index += 1;
        }
        false
    }

    fn parse_row(line: &[u8], start: usize) -> usize {
        let mut count = 0;
        let mut first = true;
        let mut has_cell = false;
        let mut escaped = false;
        for &byte in &line[start.min(line.len())..] {
            if byte == b'|' && !escaped {
                if !first || has_cell {
                    count += 1;
                }
                first = false;
                has_cell = false;
            } else if escaped || (byte != b' ' && byte != b'\t') {
                has_cell = true;
            }
            escaped = !escaped && byte == b'\\';
        }
        if has_cell {
            count += 1;
        }
        count
    }

    /// `/^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/`
    fn is_delimiter_line(text: &str) -> bool {
        let bytes = text.as_bytes();
        let cell = |from: usize| -> Option<usize> {
            let mut index = skip_js_space(text, from);
            if bytes.get(index) == Some(&b':') {
                index += 1;
            }
            let dashes = bytes[index.min(bytes.len())..]
                .iter()
                .take_while(|byte| **byte == b'-')
                .count();
            if dashes == 0 {
                return None;
            }
            index += dashes;
            if bytes.get(index) == Some(&b':') {
                index += 1;
            }
            Some(skip_js_space(text, index))
        };

        let mut index = usize::from(bytes.first() == Some(&b'|'));
        let mut cells = 0;
        while let Some(end) = cell(index) {
            if bytes.get(end) != Some(&b'|') {
                break;
            }
            index = end + 1;
            cells += 1;
        }
        cells > 0 && (index == bytes.len() || cell(index) == Some(bytes.len()))
    }

    /// `TableParser.rows`：`null`（等第二行）→ `false`（不是表格）或行数组（是表格）。
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Table {
        AwaitingDelimiter,
        Rejected,
        Rows,
    }

    // ---------------------------------------------------------------- 链接语法片段

    enum Scan {
        Found(usize),
        Pending,
        Failed,
    }

    /// `parseLinkLabel`：`[` 之后最多 999 个 UTF-16 code unit 内找 `]`。
    fn parse_link_label(text: &[u8], start: usize, mut require_non_space: bool) -> Scan {
        let mut escaped = false;
        let mut units = 0;
        let mut index = start + 1;
        while index < text.len() && units < 999 {
            let byte = text[index];
            if escaped {
                escaped = false;
            } else if byte == b']' {
                return if require_non_space {
                    Scan::Pending
                } else {
                    Scan::Found(index + 1)
                };
            } else {
                if require_non_space && !space(i32::from(byte)) {
                    require_non_space = false;
                }
                if byte == b'[' {
                    return Scan::Failed;
                } else if byte == b'\\' {
                    escaped = true;
                }
            }
            // UTF-8 首字节计 1 个 code unit，四字节字符计 2 个。
            if byte & 0xc0 != 0x80 {
                units += if byte >= 0xf0 { 2 } else { 1 };
            }
            index += 1;
        }
        Scan::Pending
    }

    fn parse_url(text: &[u8], start: usize) -> Scan {
        if byte_at(text, start) == i32::from(b'<') {
            for (index, byte) in text.iter().enumerate().skip(start + 1) {
                match byte {
                    b'>' => return Scan::Found(index + 1),
                    b'<' | b'\n' => return Scan::Failed,
                    _ => {}
                }
            }
            return Scan::Pending;
        }
        let mut depth = 0;
        let mut index = start;
        let mut escaped = false;
        while index < text.len() {
            let byte = text[index];
            if space(i32::from(byte)) {
                break;
            } else if escaped {
                escaped = false;
            } else if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            } else if byte == b'\\' {
                escaped = true;
            }
            index += 1;
        }
        if index > start {
            Scan::Found(index)
        } else if index == text.len() {
            Scan::Pending
        } else {
            Scan::Failed
        }
    }

    fn parse_link_title(text: &[u8], start: usize) -> Option<usize> {
        let open = text.get(start)?;
        let close = match open {
            b'\'' | b'"' => *open,
            b'(' => b')',
            _ => return None,
        };
        let mut escaped = false;
        for (index, &byte) in text.iter().enumerate().skip(start + 1) {
            if escaped {
                escaped = false;
            } else if byte == close {
                return Some(index + 1);
            } else if byte == b'\\' {
                escaped = true;
            }
        }
        None
    }

    /// `lineEnd`：从 `pos` 到行尾只有空白则返回行尾（`\n` 位置或文本长度），否则 -1。
    fn line_end(text: &[u8], mut pos: usize) -> i64 {
        while pos < text.len() {
            let byte = text[pos];
            if byte == b'\n' {
                break;
            }
            if !space(i32::from(byte)) {
                return -1;
            }
            pos += 1;
        }
        pos as i64
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum RefStage {
        Failed,
        Start,
        Label,
        Link,
        Title,
    }

    /// `LinkReferenceParser`：以 `[` 开头的段落先尝试解析成链接引用定义。
    #[derive(Clone, Copy)]
    struct LinkReference {
        stage: RefStage,
        pos: usize,
    }

    impl LinkReference {
        fn new(content: &str) -> Self {
            let mut reference = Self {
                stage: RefStage::Start,
                pos: 0,
            };
            reference.advance(content.as_bytes());
            reference
        }

        /// 定义在上一行结束、本行另起一块时返回 true。
        fn next_line(&mut self, content: &str) -> bool {
            if self.stage == RefStage::Failed {
                return false;
            }
            let finish = self.advance(content.as_bytes());
            finish > -1 && (finish as usize) < content.len()
        }

        fn finish(&self, content: &str) -> bool {
            matches!(self.stage, RefStage::Link | RefStage::Title)
                && skip_space(content.as_bytes(), self.pos) == content.len()
        }

        fn advance(&mut self, content: &[u8]) -> i64 {
            loop {
                match self.stage {
                    RefStage::Failed => return -1,
                    RefStage::Start => {
                        match parse_link_label(content, self.pos, true) {
                            Scan::Found(to) => {
                                self.pos = to;
                                self.stage = RefStage::Label;
                            }
                            Scan::Pending => return -1,
                            Scan::Failed => {
                                self.stage = RefStage::Failed;
                                return -1;
                            }
                        }
                        if byte_at(content, self.pos) != i32::from(b':') {
                            self.stage = RefStage::Failed;
                            return -1;
                        }
                        self.pos += 1;
                    }
                    RefStage::Label => match parse_url(content, skip_space(content, self.pos)) {
                        Scan::Found(to) => {
                            self.pos = to;
                            self.stage = RefStage::Link;
                        }
                        Scan::Pending => return -1,
                        Scan::Failed => {
                            self.stage = RefStage::Failed;
                            return -1;
                        }
                    },
                    RefStage::Link => {
                        let skip = skip_space(content, self.pos);
                        let mut end = 0;
                        if skip > self.pos {
                            if let Some(title_to) = parse_link_title(content, skip) {
                                let title_end = line_end(content, title_to);
                                if title_end > 0 {
                                    self.pos = title_to;
                                    self.stage = RefStage::Title;
                                    end = title_end;
                                }
                            }
                        }
                        if end == 0 {
                            end = line_end(content, self.pos);
                        }
                        return if end > 0 && (end as usize) < content.len() {
                            end
                        } else {
                            -1
                        };
                    }
                    RefStage::Title => return line_end(content, self.pos),
                }
            }
        }
    }

    // ---------------------------------------------------------------- 块级解析

    enum Block {
        No,
        Done,
        Container,
    }

    struct BlockParser<'a> {
        lines: Vec<(usize, &'a str)>,
        index: usize,
        line: Line<'a>,
        stack: Vec<Context>,
        breaks: Vec<usize>,
    }

    impl<'a> BlockParser<'a> {
        fn new(doc: &'a str) -> Self {
            let mut lines = Vec::new();
            let mut start = 0;
            for text in doc.split('\n') {
                lines.push((start, text));
                start += text.len() + 1;
            }
            let mut parser = Self {
                lines,
                index: 0,
                line: Line::new(""),
                stack: vec![Context {
                    kind: Kind::Document,
                    value: 0,
                }],
                breaks: Vec::new(),
            };
            parser.read_line();
            parser
        }

        fn line_start(&self) -> usize {
            self.lines.get(self.index).map_or(0, |line| line.0)
        }

        fn peek_line(&self) -> &'a str {
            self.lines.get(self.index + 1).map_or("", |line| line.1)
        }

        fn next_line(&mut self) -> bool {
            if self.index + 1 >= self.lines.len() {
                self.index = self.lines.len();
                self.line = Line::new("");
                return false;
            }
            self.index += 1;
            self.read_line();
            true
        }

        /// 读一行并逐层匹配已打开的容器，`line.depth` 停在第一个没接上的容器。
        fn read_line(&mut self) {
            self.line = Line::new(self.lines[self.index].1);
            while self.line.depth < self.stack.len() {
                let depth = self.line.depth;
                let context = self.stack[depth];
                let matched = match context.kind {
                    Kind::Document => true,
                    Kind::Blockquote => {
                        if self.line.next != i32::from(b'>') {
                            false
                        } else {
                            let size = if space(byte_at(self.line.bytes(), self.line.pos + 1)) {
                                2
                            } else {
                                1
                            };
                            let to = self.line.pos + size;
                            self.line.move_base(to);
                            true
                        }
                    }
                    Kind::ListItem => {
                        if self.line.indent < self.line.base_indent + context.value
                            && self.line.next > -1
                        {
                            false
                        } else {
                            let column = self.line.base_indent + context.value;
                            self.line.move_base_column(column);
                            true
                        }
                    }
                    Kind::BulletList | Kind::OrderedList => self.continues_list(context, depth),
                };
                if !matched {
                    break;
                }
                self.line.forward();
                self.line.depth += 1;
            }
        }

        fn continues_list(&self, list: Context, depth: usize) -> bool {
            let line = &self.line;
            if line.pos == line.text.len()
                || (depth + 1 < self.stack.len()
                    && line.indent >= self.stack[depth + 1].value + line.base_indent)
            {
                return true;
            }
            if line.indent >= line.base_indent + 4 {
                return false;
            }
            let size = if list.kind == Kind::OrderedList {
                is_ordered_list(line, &self.stack, false)
            } else {
                is_bullet_list(line, &self.stack, false)
            };
            size > 0
                && (list.kind != Kind::BulletList
                    || is_horizontal_rule(line, &self.stack, false) < 0)
                && byte_at(line.bytes(), line.pos + size as usize - 1) == list.value as i32
        }

        fn advance(&mut self) -> bool {
            loop {
                while self.line.depth < self.stack.len() {
                    self.stack.pop();
                }
                if self.line.pos < self.line.text.len() {
                    break;
                }
                if !self.next_line() {
                    return false;
                }
            }

            'start: loop {
                for block in 0..8 {
                    let result = match block {
                        0 => self.indented_code(),
                        1 => self.fenced_code(),
                        2 => self.blockquote(),
                        3 => self.horizontal_rule(),
                        4 => self.bullet_list(),
                        5 => self.ordered_list(),
                        6 => self.atx_heading(),
                        _ => self.html_block(),
                    };
                    match result {
                        Block::No => {}
                        Block::Done => return true,
                        Block::Container => {
                            self.line.forward();
                            continue 'start;
                        }
                    }
                }
                break;
            }

            self.leaf();
            true
        }

        fn indented_code(&mut self) -> Block {
            let base = self.line.base_indent + 4;
            if self.line.indent < base {
                return Block::No;
            }
            while self.next_line() && self.line.depth >= self.stack.len() {
                if self.line.pos != self.line.text.len() && self.line.indent < base {
                    break;
                }
            }
            Block::Done
        }

        fn fenced_code(&mut self) -> Block {
            let fence_end = is_fenced_code(&self.line);
            if fence_end < 0 {
                return Block::No;
            }
            let fence = self.line.next;
            let len = fence_end as usize - self.line.pos;
            while self.next_line() && self.line.depth >= self.stack.len() {
                let line = self.line;
                let bytes = line.bytes();
                let mut index = line.pos;
                if line.indent.saturating_sub(line.base_indent) < 4 {
                    while index < bytes.len() && i32::from(bytes[index]) == fence {
                        index += 1;
                    }
                }
                if index - line.pos >= len && skip_space(bytes, index) == bytes.len() {
                    self.next_line();
                    break;
                }
            }
            Block::Done
        }

        fn blockquote(&mut self) -> Block {
            let size = is_blockquote(&self.line);
            if size < 0 {
                return Block::No;
            }
            self.stack.push(Context {
                kind: Kind::Blockquote,
                value: 0,
            });
            let to = self.line.pos + size as usize;
            self.line.move_base(to);
            Block::Container
        }

        fn horizontal_rule(&mut self) -> Block {
            if is_horizontal_rule(&self.line, &self.stack, false) < 0 {
                return Block::No;
            }
            self.next_line();
            Block::Done
        }

        fn bullet_list(&mut self) -> Block {
            if is_bullet_list(&self.line, &self.stack, false) < 0 {
                return Block::No;
            }
            if self.stack.last().map(|context| context.kind) != Some(Kind::BulletList) {
                self.stack.push(Context {
                    kind: Kind::BulletList,
                    value: self.line.next as usize,
                });
            }
            let new_base = get_list_indent(&self.line, self.line.pos + 1);
            self.stack.push(Context {
                kind: Kind::ListItem,
                value: new_base.saturating_sub(self.line.base_indent),
            });
            self.line.move_base_column(new_base);
            Block::Container
        }

        fn ordered_list(&mut self) -> Block {
            let size = is_ordered_list(&self.line, &self.stack, false);
            if size < 0 {
                return Block::No;
            }
            let size = size as usize;
            if self.stack.last().map(|context| context.kind) != Some(Kind::OrderedList) {
                self.stack.push(Context {
                    kind: Kind::OrderedList,
                    value: self.line.bytes()[self.line.pos + size - 1] as usize,
                });
            }
            let new_base = get_list_indent(&self.line, self.line.pos + size);
            self.stack.push(Context {
                kind: Kind::ListItem,
                value: new_base.saturating_sub(self.line.base_indent),
            });
            self.line.move_base_column(new_base);
            Block::Container
        }

        fn atx_heading(&mut self) -> Block {
            if is_atx_heading(&self.line) < 0 {
                return Block::No;
            }
            self.next_line();
            Block::Done
        }

        fn html_block(&mut self) -> Block {
            let Some(kind) = html_block_kind(&self.line, false) else {
                return Block::No;
            };
            let mut trailing = kind < 5;
            while !html_block_ends(kind, self.line.text) && self.next_line() {
                if self.line.depth < self.stack.len() {
                    trailing = false;
                    break;
                }
            }
            if trailing {
                self.next_line();
            }
            Block::Done
        }

        fn ends_leaf(&self, leaf_has_table: bool) -> bool {
            let line = &self.line;
            if is_atx_heading(line) >= 0
                || is_fenced_code(line) >= 0
                || is_blockquote(line) >= 0
                || is_bullet_list(line, &self.stack, true) >= 0
                || is_ordered_list(line, &self.stack, true) >= 0
                || is_horizontal_rule(line, &self.stack, true) >= 0
                || html_block_kind(line, true).is_some()
            {
                return true;
            }
            if leaf_has_table || !has_pipe(line.bytes(), line.base_pos) {
                return false;
            }
            let next = self.peek_line();
            is_delimiter_line(next)
                && parse_row(line.bytes(), line.base_pos)
                    == parse_row(next.as_bytes(), line.base_pos)
        }

        /// 段落（可能变成 Setext 标题、表格或链接引用定义）。
        fn leaf(&mut self) {
            let leaf_start = self.line_start() + self.line.pos;
            let mut content = self.line.text[self.line.pos..].to_string();
            let mut reference = content
                .starts_with('[')
                .then(|| LinkReference::new(&content));
            let mut table = has_pipe(content.as_bytes(), 0).then_some(Table::AwaitingDelimiter);

            while self.next_line() {
                if self.line.pos == self.line.text.len() {
                    break;
                }
                if self.line.indent < self.line.base_indent + 4 && self.ends_leaf(table.is_some()) {
                    break;
                }
                let scrubbed = self.line.scrub();
                if let Some(reference) = reference.as_mut() {
                    if reference.stage != RefStage::Failed
                        && reference.next_line(&format!("{content}\n{scrubbed}"))
                    {
                        return;
                    }
                }
                if table == Some(Table::AwaitingDelimiter) {
                    table = Some(Table::Rejected);
                    let line = &self.line;
                    if matches!(line.next, 45 | 58 | 124)
                        && is_delimiter_line(&line.text[line.pos..])
                        && parse_row(content.as_bytes(), 0) == parse_row(line.bytes(), line.pos)
                    {
                        table = Some(Table::Rows);
                    }
                }
                if self.line.depth >= self.stack.len() && is_setext_underline(&self.line) >= 0 {
                    self.next_line();
                    parse_inline(&content, leaf_start, &mut self.breaks);
                    return;
                }
                content.push('\n');
                content.push_str(&scrubbed);
            }

            if reference.is_some_and(|reference| reference.finish(&content))
                || table == Some(Table::Rows)
            {
                return;
            }
            parse_inline(&content, leaf_start, &mut self.breaks);
        }
    }

    // ---------------------------------------------------------------- 行内解析

    #[derive(Clone, Copy)]
    struct LinkStart {
        image: bool,
        to: usize,
        valid: bool,
    }

    /// 段落内容里的 HardBreak（`\` + `\n`）位置，加上 `offset` 记入 `breaks`。
    fn parse_inline(text: &str, offset: usize, breaks: &mut Vec<usize>) {
        let bytes = text.as_bytes();
        let end = bytes.len();
        let mut links: Vec<LinkStart> = Vec::new();
        let mut pos = 0;

        while pos < end {
            let next = bytes[pos];
            let consumed = match next {
                b'\\' if pos + 1 < end && bytes[pos + 1].is_ascii_punctuation() => Some(pos + 2),
                b'\\' if pos + 1 < end && bytes[pos + 1] == b'\n' => {
                    breaks.push(offset + pos);
                    Some(pos + 2)
                }
                b'&' => entity_len(&bytes[pos + 1..]).map(|len| pos + 1 + len),
                b'`' if pos == 0 || bytes[pos - 1] != b'`' => inline_code_end(bytes, pos),
                b'<' if pos + 1 < end => html_tag_len(&text[pos + 1..]).map(|len| pos + 1 + len),
                b'_' | b'*' => {
                    let mut run = pos + 1;
                    while run < end && bytes[run] == next {
                        run += 1;
                    }
                    Some(run)
                }
                b' ' => {
                    let mut run = pos + 1;
                    while run < end && bytes[run] == b' ' {
                        run += 1;
                    }
                    (run < end && bytes[run] == b'\n' && run >= pos + 2).then_some(run + 1)
                }
                b'[' => {
                    links.push(LinkStart {
                        image: false,
                        to: pos + 1,
                        valid: true,
                    });
                    Some(pos + 1)
                }
                b'!' if pos + 1 < end && bytes[pos + 1] == b'[' => {
                    links.push(LinkStart {
                        image: true,
                        to: pos + 2,
                        valid: true,
                    });
                    Some(pos + 2)
                }
                b']' => link_end(bytes, pos, &mut links),
                _ => None,
            };
            let consumed = consumed.or_else(|| {
                if is_word(next) || matches!(next, b'.' | b'+' | b'-') {
                    gfm_autolink_end(text, pos, !links.is_empty())
                } else {
                    None
                }
            });
            pos = consumed.unwrap_or(pos + utf8_len(next));
        }
    }

    /// `/^(?:#\d+|#x[a-f\d]+|\w+);/i`，只看 `&` 之后 30 个字符。
    fn entity_len(rest: &[u8]) -> Option<usize> {
        let rest = &rest[..rest.len().min(30)];
        let body = if rest.first() == Some(&b'#') {
            let digits = rest[1..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits > 0 {
                1 + digits
            } else if matches!(rest.get(1), Some(b'x' | b'X')) {
                let hex = rest[2..]
                    .iter()
                    .take_while(|byte| byte.is_ascii_hexdigit())
                    .count();
                if hex == 0 {
                    return None;
                }
                2 + hex
            } else {
                return None;
            }
        } else {
            let word = rest.iter().take_while(|byte| is_word(**byte)).count();
            if word == 0 {
                return None;
            }
            word
        };
        (rest.get(body) == Some(&b';')).then_some(body + 1)
    }

    fn inline_code_end(bytes: &[u8], start: usize) -> Option<usize> {
        let mut pos = start + 1;
        while pos < bytes.len() && bytes[pos] == b'`' {
            pos += 1;
        }
        let size = pos - start;
        let mut current = 0;
        while pos < bytes.len() {
            if bytes[pos] == b'`' {
                current += 1;
                if current == size && byte_at(bytes, pos + 1) != i32::from(b'`') {
                    return Some(pos + 1);
                }
            } else {
                current = 0;
            }
            pos += 1;
        }
        None
    }

    /// `<` 之后：尖括号自动链接、注释、处理指令、声明、CDATA、闭标签、开标签。
    fn html_tag_len(after: &str) -> Option<usize> {
        let bytes = after.as_bytes();
        if let Some(len) = angle_autolink_len(after) {
            return Some(len);
        }
        if bytes.starts_with(b"!--") {
            if let Some(close) = after[3..].find("-->") {
                return Some(3 + close + 3);
            }
        }
        if bytes.first() == Some(&b'?') {
            if let Some(close) = after[1..].find("?>") {
                return Some(1 + close + 2);
            }
        }
        if bytes.first() == Some(&b'!') && bytes.get(1).is_some_and(u8::is_ascii_uppercase) {
            return after[2..].find('>').map(|close| 2 + close + 1);
        }
        if bytes.starts_with(b"![CDATA[") {
            return after[8..].find("]]>").map(|close| 8 + close + 3);
        }
        if bytes.first() == Some(&b'/') {
            let mut index = skip_js_space(after, 1);
            if !bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
                return None;
            }
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| is_word(*byte) || *byte == b'-')
            {
                index += 1;
            }
            index = skip_js_space(after, index);
            return (bytes.get(index) == Some(&b'>')).then_some(index + 1);
        }

        let mut index = skip_js_space(after, 0);
        if !bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
            return None;
        }
        index += 1;
        while bytes
            .get(index)
            .is_some_and(|byte| is_word(*byte) || *byte == b'-')
        {
            index += 1;
        }
        index = skip_attributes(after, index, true);
        index = skip_js_space(after, index);
        if bytes.get(index) == Some(&b'/') {
            index = skip_js_space(after, index + 1);
        }
        (bytes.get(index) == Some(&b'>')).then_some(index + 1)
    }

    /// `/^(?:[a-z][-\w+.]+:[^\s>]+|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@域名)>/i`
    fn angle_autolink_len(after: &str) -> Option<usize> {
        let bytes = after.as_bytes();
        if bytes.first().is_some_and(u8::is_ascii_alphabetic) {
            let mut index = 1;
            while bytes
                .get(index)
                .is_some_and(|byte| is_word(*byte) || matches!(byte, b'-' | b'+' | b'.'))
            {
                index += 1;
            }
            if index >= 2 && bytes.get(index) == Some(&b':') {
                let start = index + 1;
                let mut cursor = start;
                while cursor < bytes.len()
                    && bytes[cursor] != b'>'
                    && js_space_at(after, cursor) == 0
                {
                    cursor += utf8_len(bytes[cursor]);
                }
                if cursor > start && bytes.get(cursor) == Some(&b'>') {
                    return Some(cursor + 1);
                }
            }
        }

        let local = bytes
            .iter()
            .take_while(|byte| {
                byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(byte)
            })
            .count();
        if local == 0 || bytes.get(local) != Some(&b'@') {
            return None;
        }
        let start = local + 1;
        let domain_len = bytes[start..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
            .count();
        let end = start + domain_len;
        if bytes.get(end) != Some(&b'>') {
            return None;
        }
        let valid = after[start..end].split('.').all(|label| {
            let label = label.as_bytes();
            !label.is_empty()
                && label.len() <= 63
                && label[0].is_ascii_alphanumeric()
                && label[label.len() - 1].is_ascii_alphanumeric()
        });
        valid.then_some(end + 1)
    }

    fn link_end(bytes: &[u8], start: usize, links: &mut Vec<LinkStart>) -> Option<usize> {
        let index = links.len().checked_sub(1)?;
        let part = links[index];
        let next = byte_at(bytes, start + 1);
        if !part.valid
            || (skip_space(bytes, part.to) == start
                && next != i32::from(b'(')
                && next != i32::from(b'['))
        {
            links.remove(index);
            return None;
        }
        links.truncate(index);
        if !part.image {
            for link in links.iter_mut().filter(|link| !link.image) {
                link.valid = false;
            }
        }
        Some(finish_link(bytes, start + 1))
    }

    fn finish_link(bytes: &[u8], start: usize) -> usize {
        match byte_at(bytes, start) {
            40 => {
                let mut pos = skip_space(bytes, start + 1);
                if let Scan::Found(dest_to) = parse_url(bytes, pos) {
                    pos = skip_space(bytes, dest_to);
                    if pos != dest_to {
                        if let Some(title_to) = parse_link_title(bytes, pos) {
                            pos = skip_space(bytes, title_to);
                        }
                    }
                }
                if byte_at(bytes, pos) == i32::from(b')') {
                    pos + 1
                } else {
                    start
                }
            }
            91 => match parse_link_label(bytes, start, false) {
                Scan::Found(to) => to,
                _ => start,
            },
            _ => start,
        }
    }

    /// GFM 裸链接：`www.`、`http(s)://`、邮箱、`mailto:`/`xmpp:`。
    fn gfm_autolink_end(text: &str, pos: usize, has_open_link: bool) -> Option<usize> {
        let bytes = text.as_bytes();
        if pos > 0 && is_word(bytes[pos - 1]) {
            return None;
        }
        let rest = &bytes[pos..];
        let scheme = if rest.starts_with(b"www.") {
            Some(4)
        } else if rest.starts_with(b"http://") {
            Some(7)
        } else if rest.starts_with(b"https://") {
            Some(8)
        } else {
            None
        };
        if let Some(scheme) = scheme {
            let mut end = autolink_url_end(text, pos + scheme)?;
            if has_open_link {
                end = pos + no_bracket_len(&bytes[pos..end]);
            }
            return Some(end);
        }

        let local = rest
            .iter()
            .take_while(|byte| is_word(**byte) || matches!(byte, b'.' | b'+' | b'-'))
            .count();
        if (1..=100).contains(&local) && rest.get(local) == Some(&b'@') {
            return autolink_email_end(bytes, pos);
        }

        let prefix = if rest.starts_with(b"mailto:") {
            7
        } else if rest.starts_with(b"xmpp:") {
            5
        } else {
            return None;
        };
        let mut end = autolink_email_end(bytes, pos + prefix)?;
        if prefix == 5 && bytes.get(end) == Some(&b'/') {
            let resource = bytes[end + 1..]
                .iter()
                .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.'))
                .count();
            if resource > 0 {
                end += 1 + resource;
            }
        }
        Some(end)
    }

    fn label_len(bytes: &[u8], from: usize) -> usize {
        bytes[from.min(bytes.len())..]
            .iter()
            .take_while(|byte| is_word(**byte) || **byte == b'-')
            .count()
    }

    /// `autolinkURLEnd`：域名 `[\w-]+(\.[\w-]+)+`、可选路径 `/[^\s<]*`，再修掉结尾标点。
    fn autolink_url_end(text: &str, from: usize) -> Option<usize> {
        let bytes = text.as_bytes();
        let first = label_len(bytes, from);
        if first == 0 {
            return None;
        }
        let mut index = from + first;
        let mut dots = 0;
        while bytes.get(index) == Some(&b'.') {
            let label = label_len(bytes, index + 1);
            if label == 0 {
                break;
            }
            index += 1 + label;
            dots += 1;
        }
        if dots == 0 {
            return None;
        }
        if bytes.get(index) == Some(&b'/') {
            index += 1;
            while index < bytes.len() && bytes[index] != b'<' && js_space_at(text, index) == 0 {
                index += utf8_len(bytes[index]);
            }
        }
        if last_two_domain_words(&bytes[from..index]).contains(&b'_') {
            return None;
        }

        let count = |end: usize, target: u8| {
            bytes[from..end]
                .iter()
                .filter(|byte| **byte == target)
                .count()
        };
        let mut end = index;
        while end > from {
            let last = bytes[end - 1];
            if matches!(last, b'?' | b'!' | b'.' | b',' | b':' | b'*' | b'_' | b'~')
                || (last == b')' && count(end, b')') > count(end, b'('))
            {
                end -= 1;
            } else if last == b';' {
                match entity_suffix_start(&bytes[from..end]) {
                    Some(start) => end = from + start,
                    None => break,
                }
            } else {
                break;
            }
        }
        Some(end)
    }

    /// `/[\w-]+\.[\w-]+($|\/)/` 在 `matched` 里最左的匹配。
    fn last_two_domain_words(matched: &[u8]) -> &[u8] {
        for start in 0..matched.len() {
            let first = label_len(matched, start);
            if first == 0 || matched.get(start + first) != Some(&b'.') {
                continue;
            }
            let second = label_len(matched, start + first + 1);
            if second == 0 {
                continue;
            }
            let end = start + first + 1 + second;
            if end == matched.len() {
                return &matched[start..end];
            }
            if matched[end] == b'/' {
                return &matched[start..=end];
            }
        }
        &[]
    }

    /// `/&(?:#\d+|#x[a-f\d]+|\w+);$/` 的起点（`&` 的位置）。
    fn entity_suffix_start(text: &[u8]) -> Option<usize> {
        let amp = text.iter().rposition(|byte| *byte == b'&')?;
        let body = &text[amp + 1..text.len() - 1];
        let valid = match body.strip_prefix(b"#") {
            Some(number) => {
                (!number.is_empty() && number.iter().all(u8::is_ascii_digit))
                    || number.strip_prefix(b"x").is_some_and(|hex| {
                        !hex.is_empty()
                            && hex
                                .iter()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
                    })
            }
            None => !body.is_empty() && body.iter().all(|byte| is_word(*byte)),
        };
        valid.then_some(amp)
    }

    /// `autolinkEmailEnd`：`[\w.+-]+@[\w-]+(\.[\w.-]+)+`，结尾是 `_`/`-` 不算，结尾 `.` 去掉。
    fn autolink_email_end(bytes: &[u8], from: usize) -> Option<usize> {
        let local = bytes[from.min(bytes.len())..]
            .iter()
            .take_while(|byte| is_word(**byte) || matches!(byte, b'.' | b'+' | b'-'))
            .count();
        if local == 0 || bytes.get(from + local) != Some(&b'@') {
            return None;
        }
        let domain = from + local + 1;
        let label = label_len(bytes, domain);
        if label == 0 {
            return None;
        }
        let mut end = domain + label;
        if bytes.get(end) != Some(&b'.') {
            return None;
        }
        let tail = bytes[end + 1..]
            .iter()
            .take_while(|byte| is_word(**byte) || matches!(byte, b'.' | b'-'))
            .count();
        if tail == 0 {
            return None;
        }
        end += 1 + tail;
        match bytes[end - 1] {
            b'_' | b'-' => None,
            b'.' => Some(end - 1),
            _ => Some(end),
        }
    }

    /// `/([^\[\]]|\[[^\]]*\])*/` 的匹配长度。
    fn no_bracket_len(text: &[u8]) -> usize {
        let mut index = 0;
        while index < text.len() {
            match text[index] {
                b'[' => match text[index + 1..].iter().position(|byte| *byte == b']') {
                    Some(close) => index += close + 2,
                    None => break,
                },
                b']' => break,
                _ => index += 1,
            }
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_whitespace_matches_ecmascript_trim() {
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn parse_end_counts_utf16_units() {
        // "😀" 占 2 个 UTF-16 code unit：上限 3 时只能停在它后面的换行之前一行。
        assert_eq!(hard_break_parse_end("😀\nab\ncd", 4), "😀\n".len());
        assert_eq!(hard_break_parse_end("ab", 2), 2);
        assert_eq!(hard_break_parse_end("abc", 2), 0);
    }

    #[test]
    fn relation_sync_keeps_non_wikilink_relations() {
        let relation = |target: &str, origin: &str| FragmentRelation {
            target_id: target.to_string(),
            origin: origin.to_string(),
            created_at: "t0".to_string(),
            note: None,
        };
        let current = vec![relation("a", "manual"), relation("b", "wikilink")];
        let sync = plan_wikilink_relation_sync(&current, &["a".to_string(), "c".to_string()]);
        assert_eq!(sync.removed, vec!["b"]);
        assert_eq!(sync.added, vec!["c"]);
        let next = apply_wikilink_relation_sync(&current, &sync, "t1");
        assert_eq!(
            next.iter()
                .map(|r| (r.target_id.as_str(), r.origin.as_str()))
                .collect::<Vec<_>>(),
            vec![("a", "manual"), ("c", "wikilink")]
        );
    }
}
