//! 终端搜索碎片。查询解析、Markdown 投影与排序直接复用 App 搜索的
//! `shard_core::search`，同一个关键词在终端和 ⌘K 里命中同一批碎片、排序一致。
//! 结果按序号列出并记下，`shard -e <序号>` 可以直接引用。

use chrono::{DateTime, Datelike, Local};
use serde::{Deserialize, Serialize};
use serde_json::json;
use shard_core::{
    derive_type,
    frontmatter::parse_fragment,
    search::{project_document, scan_exact, ParsedQuery, SearchTextPart, SourceDocument},
    vault_lock::app_config_dir,
    PROTECTED_TYPE_TAGS,
};
use std::{
    env, fs,
    io::{self, BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
};

pub const DEFAULT_LIMIT: usize = 20;
/// 预览列的显示宽度（中日韩字符按 2 列计）。
const PREVIEW_COLUMNS: usize = 64;

/// 碎片流里能按文本处理的一条碎片。大纲与流程图的正文是受管 JSON，
/// App 也不允许按文本保存，这里不收录，改走 `--graph-*` 命令。
#[derive(Debug, Clone)]
pub struct FragmentEntry {
    pub id: String,
    pub path: PathBuf,
    pub title: String,
    pub created_at: String,
    pub kind: Option<&'static str>,
    pub tags: Vec<String>,
    pub modified_at: i64,
    pub body: String,
}

impl FragmentEntry {
    pub fn relative_path(&self, vault: &Path) -> String {
        self.path
            .strip_prefix(vault)
            .unwrap_or(&self.path)
            .display()
            .to_string()
    }
}

pub struct Hit<'a> {
    pub entry: &'a FragmentEntry,
    pub preview: Vec<SearchTextPart>,
}

pub struct SearchOutcome<'a> {
    pub hits: Vec<Hit<'a>>,
    pub total: usize,
}

/// 读取 `fragments/` 下的公开碎片（回收站在 `.trash/`，密匣另存加密文件，都不在这里）。
/// 解析失败的文件跳过：终端搜索不该因为一篇坏文件整体失败。
pub fn load_fragments(vault: &Path) -> Result<Vec<FragmentEntry>, String> {
    let mut files = Vec::new();
    collect_markdown(&vault.join("fragments"), &mut files)?;
    let mut entries = Vec::new();
    for path in files {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = parse_fragment(&text) else {
            continue;
        };
        let kind = derive_type(&parsed.frontmatter.tags);
        if kind.is_some_and(|kind| PROTECTED_TYPE_TAGS.contains(&kind)) {
            continue;
        }
        let body = parsed.body.trim_start_matches('\n').trim_end().to_string();
        let tags = if parsed.frontmatter.tags.is_empty() {
            vec!["inbox".to_string()]
        } else {
            parsed.frontmatter.tags.clone()
        };
        entries.push(FragmentEntry {
            id: parsed.frontmatter.id,
            title: fragment_title(kind, &body),
            created_at: parsed.frontmatter.created_at,
            kind,
            tags,
            modified_at: parse_millis(&parsed.frontmatter.updated_at),
            body,
            path,
        });
    }
    Ok(entries)
}

fn collect_markdown(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|error| format!("读取 {} 失败：{error}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // 原子写的临时文件与系统文件都以 `.` 开头。
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_markdown(&path, files)?;
        } else if path.extension().is_some_and(|extension| extension == "md") {
            files.push(path);
        }
    }
    Ok(())
}

/// 与 App 搜索的标题规则一致（`src-tauri/src/search_sources.rs` 的 `markdown_title`）。
fn fragment_title(kind: Option<&str>, body: &str) -> String {
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
        _ => first_line().unwrap_or_else(|| "未命名碎片".to_string()),
    }
}

fn markdown_heading(line: &str) -> Option<String> {
    let line = line.trim_start();
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
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
    let mut result = value
        .chars()
        .take(maximum)
        .collect::<String>()
        .trim_end()
        .to_string();
    result.push('…');
    result
}

fn parse_millis(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

/// 有关键词时按 App 的排序取前 `limit` 条；没有关键词时按最近修改列出。
pub fn search<'a>(
    entries: &'a [FragmentEntry],
    query: &str,
    limit: usize,
) -> Result<SearchOutcome<'a>, String> {
    let parsed = ParsedQuery::parse(query).map_err(|error| error.to_string())?;
    if parsed.is_empty() {
        let mut recent = entries.iter().collect::<Vec<_>>();
        recent.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
        let total = recent.len();
        let hits = recent
            .into_iter()
            .take(limit)
            .map(|entry| Hit {
                entry,
                preview: vec![SearchTextPart {
                    text: entry.title.clone(),
                    hit: false,
                }],
            })
            .collect();
        return Ok(SearchOutcome { hits, total });
    }

    let documents = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            project_document(&SourceDocument {
                stable_key: index.to_string(),
                title: entry.title.clone(),
                tags: entry.tags.clone(),
                body: entry.body.clone(),
                modified_at: entry.modified_at,
            })
        })
        .collect::<Vec<_>>();
    let result = scan_exact(&documents, &parsed, limit);
    let hits = result
        .matches
        .into_iter()
        .filter_map(|matched| {
            let entry = entries.get(matched.stable_key.parse::<usize>().ok()?)?;
            // 只命中标签时没有正文片段，用带高亮的标题代替。
            let preview = if matched.preview.is_empty() {
                matched.title_parts
            } else {
                matched.preview
            };
            Some(Hit { entry, preview })
        })
        .collect();
    Ok(SearchOutcome {
        hits,
        total: result.total,
    })
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

pub struct Style {
    color: bool,
}

impl Style {
    pub fn for_stream(is_terminal: bool) -> Self {
        Self {
            color: is_terminal && env::var_os("NO_COLOR").is_none(),
        }
    }

    fn dim(&self, text: &str) -> String {
        if self.color {
            format!("\x1b[2m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    fn hit(&self, text: &str) -> String {
        if self.color {
            format!("\x1b[1;33m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }
}

/// ` 1  09-26 06:18  81b8ea9d  去银行办理房贷最低还款`
pub fn format_hits(hits: &[Hit<'_>], style: &Style) -> String {
    let width = hits.len().to_string().len();
    hits.iter()
        .enumerate()
        .map(|(index, hit)| {
            let kind = match hit.entry.kind {
                Some("document") => "[文档] ",
                _ => "",
            };
            format!(
                "{:>width$}  {}  {}{}",
                index + 1,
                style.dim(&format!(
                    "{}  {:<8}",
                    display_date(&hit.entry.created_at),
                    short_id(&hit.entry.id)
                )),
                kind,
                render_preview(&hit.preview, PREVIEW_COLUMNS, style),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn hits_json(hits: &[Hit<'_>], vault: &Path) -> String {
    let items = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            json!({
                "index": index + 1,
                "id": hit.entry.id,
                "path": hit.entry.relative_path(vault),
                "title": hit.entry.title,
                "kind": hit.entry.kind.unwrap_or("fragment"),
                "tags": hit.entry.tags,
                "createdAt": hit.entry.created_at,
                "preview": hit.preview.iter().map(|part| part.text.as_str()).collect::<String>(),
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".to_string())
}

/// 标准 id `20260926-061830-81b8ea9d-a2237f` 取第三段；其他 id 原样返回。
pub fn short_id(id: &str) -> &str {
    let parts = id.split('-').collect::<Vec<_>>();
    match parts.as_slice() {
        [date, time, random, _]
            if date.len() == 8
                && time.len() == 6
                && random.len() == 8
                && random
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()) =>
        {
            random
        }
        _ => id,
    }
}

fn display_date(value: &str) -> String {
    match DateTime::parse_from_rfc3339(value) {
        Ok(date) => {
            let date = date.with_timezone(&Local);
            if date.year() == Local::now().year() {
                date.format("%m-%d %H:%M").to_string()
            } else {
                date.format("%Y-%m-%d").to_string()
            }
        }
        Err(_) => "--".to_string(),
    }
}

fn render_preview(parts: &[SearchTextPart], columns: usize, style: &Style) -> String {
    let mut characters = Vec::new();
    for part in parts {
        for character in part.text.chars() {
            let character = if character.is_whitespace() {
                ' '
            } else {
                character
            };
            if character == ' '
                && (characters.is_empty()
                    || characters.last().is_some_and(|(last, _)| *last == ' '))
            {
                continue;
            }
            characters.push((character, part.hit));
        }
    }
    let truncated = characters
        .iter()
        .map(|(character, _)| char_columns(*character))
        .sum::<usize>()
        > columns;
    let available = columns.saturating_sub(usize::from(truncated));
    let mut output = String::new();
    let mut used = 0;
    let mut chunk = String::new();
    let mut chunk_hit = false;
    for (character, hit) in characters {
        let width = char_columns(character);
        if used + width > available {
            break;
        }
        if !chunk.is_empty() && hit != chunk_hit {
            push_chunk(&mut output, &chunk, chunk_hit, style);
            chunk.clear();
        }
        chunk_hit = hit;
        used += width;
        chunk.push(character);
    }
    push_chunk(&mut output, &chunk, chunk_hit, style);
    if truncated {
        output.push('…');
    }
    output
}

fn push_chunk(output: &mut String, chunk: &str, hit: bool, style: &Style) {
    if chunk.is_empty() {
        return;
    }
    if hit {
        output.push_str(&style.hit(chunk));
    } else {
        output.push_str(chunk);
    }
}

/// 终端显示宽度的近似：中日韩、全角与常见 emoji 占 2 列。
fn char_columns(character: char) -> usize {
    match character as u32 {
        0x1100..=0x115F
        | 0x2E80..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

// ---------------------------------------------------------------------------
// 上次搜索：`shard -e <序号>` 引用它
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastSearch {
    vault: String,
    query: String,
    ids: Vec<String>,
}

fn last_search_path() -> Option<PathBuf> {
    let dir = env::var_os("SHARD_CLI_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| app_config_dir().map(|dir| dir.join("cli")))?;
    Some(dir.join("last-search.json"))
}

/// 记不下来不影响本次搜索，只是之后不能按序号引用。
pub fn remember_search(vault: &Path, query: &str, hits: &[Hit<'_>]) {
    let Some(path) = last_search_path() else {
        return;
    };
    let state = LastSearch {
        vault: vault.display().to_string(),
        query: query.to_string(),
        ids: hits.iter().map(|hit| hit.entry.id.clone()).collect(),
    };
    if let (Some(parent), Ok(text)) = (path.parent(), serde_json::to_string(&state)) {
        let _ = fs::create_dir_all(parent).and_then(|_| fs::write(&path, text));
    }
}

fn recall_search(vault: &Path) -> Option<Vec<String>> {
    let text = fs::read_to_string(last_search_path()?).ok()?;
    let state = serde_json::from_str::<LastSearch>(&text).ok()?;
    (state.vault == vault.display().to_string()).then_some(state.ids)
}

// ---------------------------------------------------------------------------
// 编辑目标：序号 / 短 id / 关键词
// ---------------------------------------------------------------------------

pub enum Selection<'a> {
    Found(&'a FragmentEntry),
    /// 多条命中：已列出并记为「上次搜索」，调用方提示用序号再选。
    Ambiguous(usize),
}

/// 解析 `shard -e` 的参数：
/// - 无参数：最近修改的一条
/// - 纯数字且上次搜索有这个序号：上次搜索的第 N 条
/// - 与 id 相同，或是 id 的一段（至少 4 个字符）且只命中一条：这条碎片
/// - 其余按关键词搜索：唯一命中直接编辑；多条时在终端里让用户选序号
pub fn select<'a>(
    entries: &'a [FragmentEntry],
    vault: &Path,
    args: &[String],
) -> Result<Selection<'a>, String> {
    if entries.is_empty() {
        return Err("资料库里还没有可编辑的碎片".to_string());
    }
    if args.is_empty() {
        let latest = entries
            .iter()
            .max_by_key(|entry| entry.modified_at)
            .expect("entries is not empty");
        return Ok(Selection::Found(latest));
    }

    let query = args.join(" ");
    if let [token] = args {
        if let Ok(index) = token.parse::<usize>() {
            if let Some(ids) = recall_search(vault).filter(|ids| (1..=ids.len()).contains(&index)) {
                let id = &ids[index - 1];
                return entries
                    .iter()
                    .find(|entry| &entry.id == id)
                    .map(Selection::Found)
                    .ok_or_else(|| {
                        format!("上次搜索的第 {index} 条已不存在（可能被删除或移入密匣）")
                    });
            }
        }
        if let Some(entry) = entries.iter().find(|entry| entry.id == *token) {
            return Ok(Selection::Found(entry));
        }
        let needle = token.to_lowercase();
        if needle.chars().count() >= 4 {
            let by_id = entries
                .iter()
                .filter(|entry| entry.id.to_lowercase().contains(&needle))
                .collect::<Vec<_>>();
            if let [entry] = by_id.as_slice() {
                return Ok(Selection::Found(entry));
            }
        }
    }

    let outcome = search(entries, &query, DEFAULT_LIMIT)?;
    match outcome.hits.as_slice() {
        [] => Err(format!("没有找到包含「{query}」的碎片")),
        [hit] => Ok(Selection::Found(hit.entry)),
        hits => {
            remember_search(vault, &query, hits);
            let style = Style::for_stream(io::stderr().is_terminal());
            eprintln!("{}", format_hits(hits, &style));
            if outcome.total > hits.len() {
                eprintln!("…共 {} 条，只列出前 {} 条", outcome.total, hits.len());
            }
            if !(io::stdin().is_terminal() && io::stderr().is_terminal()) {
                return Ok(Selection::Ambiguous(outcome.total));
            }
            eprint!("输入序号编辑（直接回车取消）：");
            io::stderr().flush().ok();
            let mut answer = String::new();
            io::stdin()
                .lock()
                .read_line(&mut answer)
                .map_err(|error| format!("读取输入失败：{error}"))?;
            let answer = answer.trim();
            if answer.is_empty() {
                return Err("已取消".to_string());
            }
            answer
                .parse::<usize>()
                .ok()
                .and_then(|index| hits.get(index.checked_sub(1)?))
                .map(|hit| Selection::Found(hit.entry))
                .ok_or_else(|| format!("没有第 {answer} 条"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_id_takes_random_segment() {
        assert_eq!(short_id("20260926-061830-81b8ea9d-a2237f"), "81b8ea9d");
        assert_eq!(short_id("20260928-graph"), "20260928-graph");
    }

    #[test]
    fn preview_truncates_by_display_columns() {
        let style = Style { color: false };
        let parts = vec![SearchTextPart {
            text: "中".repeat(40),
            hit: false,
        }];
        let rendered = render_preview(&parts, 20, &style);
        assert_eq!(rendered, format!("{}…", "中".repeat(9)));
    }

    #[test]
    fn preview_folds_newlines_and_marks_hits() {
        let style = Style { color: false };
        let parts = vec![
            SearchTextPart {
                text: "买\n\n".into(),
                hit: false,
            },
            SearchTextPart {
                text: "咖啡".into(),
                hit: true,
            },
        ];
        assert_eq!(render_preview(&parts, 64, &style), "买 咖啡");
    }

    #[test]
    fn preview_folds_whitespace_across_colored_parts_and_adds_one_ellipsis() {
        let style = Style { color: true };
        let parts = vec![
            SearchTextPart {
                text: "".into(),
                hit: false,
            },
            SearchTextPart {
                text: " \n买 ".into(),
                hit: true,
            },
            SearchTextPart {
                text: "  咖啡 很长很长".into(),
                hit: false,
            },
        ];
        assert_eq!(
            render_preview(&parts, 8, &style),
            "\x1b[1;33m买 \x1b[0m咖啡…"
        );
        assert_eq!(render_preview(&parts, 4, &Style { color: false }), "买 …");
        assert_eq!(
            render_preview(
                &[SearchTextPart {
                    text: "买 咖".into(),
                    hit: false
                }],
                5,
                &Style { color: false }
            ),
            "买 咖"
        );
    }

    #[test]
    fn document_title_prefers_heading() {
        assert_eq!(fragment_title(Some("document"), "引言\n\n# 标题 #"), "标题");
        assert_eq!(fragment_title(None, "\n\n  第一行  \n第二行"), "第一行");
        assert_eq!(fragment_title(None, ""), "未命名碎片");
    }
}
