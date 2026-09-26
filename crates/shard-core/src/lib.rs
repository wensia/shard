//! Vault 文件格式核心。
//!
//! 碎片的 frontmatter 结构、id 规则、标签规范化与原子写只在这里定义一份，
//! 桌面 App（`src-tauri`）与终端 CLI（`crates/shard-cli`）共用，避免两边落盘格式漂移。
//! 本 crate 不依赖 Tauri，也不碰 git：提交由 App 的检查点聚合接管。

pub mod search;
pub mod vault_lock;

use chrono::{DateTime, Local};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// 密匣标签：带它的碎片走加密分支，只能在 App 解锁态下写入。
pub const LOCKBOX_TAG: &str = "密匣";
/// 未整理碎片的默认标签，创建时总会带上。
pub const INBOX_TAG: &str = "inbox";
pub const LIBRARY_FILENAME_MAX_BYTES: usize = 255;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub vault_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FragmentRelation {
    pub target_id: String,
    /// manual | walk | insight | tag | wikilink
    pub origin: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FragmentFrontmatter {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub ai_status: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_of: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<FragmentRelation>,
}

pub fn is_false(value: &bool) -> bool {
    !*value
}

pub fn default_vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法找到用户 home 目录".to_string())?;
    Ok(PathBuf::from(home).join("Documents").join("ShardVault"))
}

pub fn normalized_vault_key(vault: &Path) -> PathBuf {
    if let Ok(canonical) = vault.canonicalize() {
        return canonical;
    }

    let absolute = if vault.is_absolute() {
        vault.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current| current.join(vault))
            .unwrap_or_else(|_| vault.to_path_buf())
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }

    // A newly selected vault may not exist yet. Resolve the nearest existing ancestor
    // so a symlinked parent cannot produce one gate before creation and another after it.
    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    loop {
        if let Ok(mut canonical) = ancestor.canonicalize() {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(name) = ancestor.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }
    normalized
}

pub fn ensure_vault_layout(vault: &Path) -> Result<(), String> {
    fs::create_dir_all(vault.join("fragments")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join("notes")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join("assets")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join("maps")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault.join(".shard")).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn new_fragment_id(now: &DateTime<Local>) -> String {
    let mut bytes = [0u8; 7];
    OsRng.fill_bytes(&mut bytes);
    let random: String = bytes[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let device: String = bytes[4..]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    format!("{}-{random}-{device}", now.format("%Y%m%d-%H%M%S"))
}

pub fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:04x}", nanos & 0xffff)
}

pub fn temporary_filename(name: &str, suffix: &str) -> String {
    // Retain the real extension and recognizable temporary-file suffix. Long existing
    // filenames must remain writable even when adding the atomic-write suffix.
    let available = LIBRARY_FILENAME_MAX_BYTES.saturating_sub(1 + suffix.len());
    let mut start = name.len().saturating_sub(available);
    while !name.is_char_boundary(start) {
        start += 1;
    }
    format!(".{}{suffix}", &name[start..])
}

pub fn write_text_atomically(path: &Path, text: &str) -> Result<(), String> {
    write_bytes_atomically(path, text.as_bytes())
}

pub fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "文件名无效。".to_string())?;
    let temp_path = path.with_file_name(temporary_filename(
        file_name,
        &format!(".tmp-{}", unique_suffix()),
    ));
    {
        let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })?;
    // rename 的断电持久性依赖父目录元数据落盘；尽力而为，内容本身已 fsync。
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

pub fn write_fragment_file(
    path: &Path,
    frontmatter: &FragmentFrontmatter,
    body: &str,
) -> Result<(), String> {
    let yaml = serde_yaml::to_string(frontmatter).map_err(|error| error.to_string())?;
    let yaml = yaml.strip_prefix("---\n").unwrap_or(&yaml);
    let text = format!("---\n{}---\n\n{}\n", yaml, body.trim_end());
    write_text_atomically(path, &text)
}

/// 新建一条公开碎片：`fragments/YYYY/MM/{id}.md`。
///
/// 只落盘不提交（docs/design/commit-coalescing-plan.md §7 A2）。调用方负责
/// 拦截密匣标签并持有 vault 门；`tags` 会再规范化一次并补上 `inbox`。
pub fn create_public_fragment_in_vault(
    vault: &Path,
    content: &str,
    tags: Vec<String>,
    source: &str,
) -> Result<PathBuf, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("片段内容不能为空".to_string());
    }

    let now = Local::now();
    let id = new_fragment_id(&now);
    let created_at = now.to_rfc3339();
    let dir = vault
        .join("fragments")
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string());
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let path = dir.join(format!("{id}.md"));
    let frontmatter = FragmentFrontmatter {
        id,
        created_at: created_at.clone(),
        updated_at: created_at,
        tags: normalize_tags(tags, true),
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: source.to_string(),
        conflict_of: None,
        related: Vec::new(),
    };

    write_fragment_file(&path, &frontmatter, content)?;
    Ok(path)
}

pub fn contains_lockbox_tag(tags: &[String]) -> bool {
    tags.iter().any(|tag| tag == LOCKBOX_TAG)
}

pub fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag
        .trim()
        .trim_start_matches('#')
        .trim_matches(is_tag_edge_punctuation);
    let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

pub fn normalize_tags(tags: Vec<String>, include_inbox: bool) -> Vec<String> {
    let mut next_tags = tags
        .iter()
        .filter_map(|tag| normalize_tag(tag))
        .collect::<Vec<_>>();
    if include_inbox {
        next_tags.push(INBOX_TAG.to_string());
    }
    next_tags.sort();
    next_tags.dedup();
    next_tags
}

fn is_tag_edge_punctuation(char: char) -> bool {
    matches!(
        char,
        ',' | '.'
            | '?'
            | '!'
            | ';'
            | ':'
            | '，'
            | '。'
            | '？'
            | '！'
            | '；'
            | '：'
            | '、'
            | ')'
            | ']'
            | '}'
            | '"'
            | '\''
            | '”'
            | '’'
    )
}

/// 从正文里提取 `#标签`，规则移植自 `packages/markdown/src/core/text.ts` 的
/// `getTagRanges` / `isTagBoundary`（那边是真相源，改规则两边一起改）：
/// `#` 前须是开头、空白、标点或 CJK 字符；标签延伸到空白或下一个 `#`。
pub fn extract_tags(value: &str) -> Vec<String> {
    let chars = value.chars().collect::<Vec<_>>();
    let mut tags = Vec::new();

    for (index, &char) in chars.iter().enumerate() {
        if char != '#' {
            continue;
        }
        if index > 0 && !is_tag_boundary(chars[index - 1]) {
            continue;
        }

        let content = chars[index + 1..]
            .iter()
            .take_while(|&&next| !next.is_whitespace() && next != '#')
            .collect::<String>();
        let content = content.trim_end_matches(is_trailing_tag_punctuation);
        if let Some(tag) = normalize_tag(content) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }

    tags
}

fn is_trailing_tag_punctuation(char: char) -> bool {
    matches!(
        char,
        ')' | ','
            | '.'
            | '?'
            | '!'
            | ';'
            | ':'
            | '，'
            | '。'
            | '！'
            | '？'
            | '；'
            | '：'
            | '、'
            | ']'
            | '}'
            | '>'
            | '"'
            | '\''
            | '”'
            | '’'
    )
}

fn is_tag_boundary(char: char) -> bool {
    char.is_whitespace()
        || matches!(
            char,
            '(' | '['
                | '{'
                | '<'
                | '"'
                | '\''
                | '“'
                | '‘'
                | '，'
                | '。'
                | '！'
                | '？'
                | '；'
                | '：'
                | '、'
                | ','
                | '.'
                | '!'
                | '?'
                | ';'
                | ':'
        )
        || is_cjk_script(char)
}

/// 近似 `\p{Script=Han|Hiragana|Katakana|Hangul}`，用区段判断以免引入 Unicode 依赖。
fn is_cjk_script(char: char) -> bool {
    matches!(
        char as u32,
        0x2E80..=0x2FDF      // CJK 部首
            | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B
            | 0x3040..=0x309F // 平假名
            | 0x30A0..=0x30FF // 片假名
            | 0x31F0..=0x31FF
            | 0x3400..=0x4DBF // 扩展 A
            | 0x4E00..=0x9FFF // 基本区
            | 0xF900..=0xFAFF // 兼容表意
            | 0x1100..=0x11FF // 谚文字母
            | 0x3130..=0x318F
            | 0xAC00..=0xD7AF // 谚文音节
            | 0xFF66..=0xFF9F // 半角片假名
            | 0x20000..=0x3134F
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_tags_like_the_editor() {
        assert_eq!(extract_tags("#备忘 今天心情很好"), vec!["备忘"]);
        assert_eq!(extract_tags("读完了#书 很好"), vec!["书"]);
        // 与 getTagRanges 一致：标签延伸到空白，句中逗号不截断，只修剪末尾标点。
        assert_eq!(extract_tags("#书，很好。"), vec!["书，很好"]);
        assert_eq!(extract_tags("a#b 不是标签"), Vec::<String>::new());
        assert_eq!(extract_tags("# 标题"), Vec::<String>::new());
        assert_eq!(extract_tags("#甲#乙 #甲。"), vec!["甲", "乙"]);
    }

    #[test]
    fn normalizes_tags_with_inbox() {
        let tags = normalize_tags(vec!["#备忘".into(), "备忘，".into()], true);
        assert_eq!(tags, vec!["inbox", "备忘"]);
    }

    #[test]
    fn creates_public_fragment_file() {
        let vault = tempfile::tempdir().unwrap();
        let path = create_public_fragment_in_vault(
            vault.path(),
            "  #备忘\n\n- [ ] 买咖啡  ",
            vec!["备忘".into()],
            "cli",
        )
        .unwrap();

        assert!(path.starts_with(vault.path().join("fragments")));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("---\nid: "));
        assert!(text.contains("tags:\n- inbox\n- 备忘\n"));
        assert!(text.contains("source: cli\n"));
        assert!(text.ends_with("---\n\n#备忘\n\n- [ ] 买咖啡\n"));
    }

    #[test]
    fn rejects_empty_fragment() {
        let vault = tempfile::tempdir().unwrap();
        assert!(create_public_fragment_in_vault(vault.path(), "  \n", vec![], "cli").is_err());
    }
}
