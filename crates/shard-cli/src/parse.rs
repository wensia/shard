//! 把终端参数解析成一条碎片：前导 `#标签`、前导 `/块命令`、其余是正文。
//!
//! ```text
//! shard 今天心情很好
//! shard #备忘 /任务列表 买咖啡
//! ```

use shard_core::{contains_lockbox_tag, extract_tags, normalize_tag, normalize_tags};

/// CLI 能表达的行格式，对应编辑器 `/` 菜单里的同名命令。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineFormat {
    Task,
    Unordered,
    Ordered,
    Quote,
}

/// 斜杠关键词镜像自 `src/lib/slash-commands.ts`（真相源，改关键词两边一起改）。
/// 备忘卡片落盘就是任务项，终端里没有细节行，所以 `/备忘` 也写成任务项。
const SLASH_KEYWORDS: &[(LineFormat, &[&str])] = &[
    (
        LineFormat::Task,
        &[
            "任务列表", "任务", "待办", "rwlb", "rw", "db", "task", "todo", "checkbox",
            "备忘卡片", "备忘", "bwkp", "bw", "memo", "card",
        ],
    ),
    (
        LineFormat::Unordered,
        &["无序列表", "无序", "列表", "wxlb", "wx", "lb", "list", "bullet", "ul"],
    ),
    (
        LineFormat::Ordered,
        &["有序列表", "有序", "编号", "yxlb", "yx", "bh", "ordered", "number", "ol"],
    ),
    (LineFormat::Quote, &["引用", "yy", "quote", "blockquote"]),
];

#[derive(Debug, Default, PartialEq)]
pub struct Capture {
    /// 前导标签，保持输入顺序，已去掉 `#`。
    pub tags: Vec<String>,
    pub format: Option<LineFormat>,
    /// 前导标记之后的正文，原样保留（含正文中的 `#标签`）。
    pub text: String,
}

/// 扫描前导 token：`#xxx`/`＃xxx` 是标签，命中关键词的 `/xxx` 是格式；
/// 遇到第一个普通 token 起全部算正文。没命中的 `/xxx`（如 `/usr/bin`）就是正文。
pub fn parse_capture(input: &str) -> Capture {
    let mut capture = Capture::default();
    let mut rest = input.trim_start();

    while !rest.is_empty() {
        let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let token = &rest[..token_end];

        if let Some(tag) = leading_tag(token) {
            if !capture.tags.contains(&tag) {
                capture.tags.push(tag);
            }
        } else if let Some(format) = token.strip_prefix('/').and_then(slash_format) {
            capture.format = Some(format);
        } else {
            break;
        }
        rest = rest[token_end..].trim_start();
    }

    capture.text = rest.trim_end().replace('＃', "#");
    capture
}

fn leading_tag(token: &str) -> Option<String> {
    let name = token
        .strip_prefix('#')
        .or_else(|| token.strip_prefix('＃'))?;
    // `##标题` 之类不是标签；与编辑器一致，标签里不能再出现 `#`。
    if name.contains('#') || name.contains('＃') {
        return None;
    }
    normalize_tag(name)
}

fn slash_format(name: &str) -> Option<LineFormat> {
    let name = name.to_lowercase();
    SLASH_KEYWORDS
        .iter()
        .find(|(_, keywords)| keywords.contains(&name.as_str()))
        .map(|(format, _)| *format)
}

/// 组装成落盘正文与 frontmatter 标签（不含 `inbox`，由核心补）。
///
/// - 无格式：`#备忘 今天心情很好`，与在速记框里打字的结果一致
/// - 有格式：标签独占首段，空行后接列表，正文每个非空行各成一项
pub fn compose(capture: &Capture) -> Result<(String, Vec<String>), String> {
    if capture.text.trim().is_empty() {
        return Err("缺少内容。用法：shard [#标签] [/任务列表] 内容".to_string());
    }

    let tag_line = capture
        .tags
        .iter()
        .map(|tag| format!("#{tag}"))
        .collect::<Vec<_>>()
        .join(" ");

    let body = match capture.format {
        None if tag_line.is_empty() => capture.text.clone(),
        None => format!("{tag_line} {}", capture.text),
        Some(format) => {
            let list = capture
                .text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .enumerate()
                .map(|(index, line)| match format {
                    LineFormat::Task => format!("- [ ] {line}"),
                    LineFormat::Unordered => format!("- {line}"),
                    LineFormat::Ordered => format!("{}. {line}", index + 1),
                    LineFormat::Quote => format!("> {line}"),
                })
                .collect::<Vec<_>>()
                .join("\n");
            if tag_line.is_empty() {
                list
            } else {
                format!("{tag_line}\n\n{list}")
            }
        }
    };

    let mut tags = capture.tags.clone();
    tags.extend(extract_tags(&body));
    let tags = normalize_tags(tags, false);
    if contains_lockbox_tag(&tags) {
        return Err("终端不支持写入密匣，请在 Shard 中保存。".to_string());
    }

    Ok((body, tags))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Result<(String, Vec<String>), String> {
        compose(&parse_capture(input))
    }

    #[test]
    fn plain_text() {
        assert_eq!(run("今天心情很好").unwrap(), ("今天心情很好".into(), vec![]));
    }

    #[test]
    fn tag_and_task() {
        let (body, tags) = run("#备忘 /任务列表 买咖啡").unwrap();
        assert_eq!(body, "#备忘\n\n- [ ] 买咖啡");
        assert_eq!(tags, vec!["备忘"]);
    }

    #[test]
    fn leading_tag_stays_in_body() {
        let (body, tags) = run("#心情 今天很好").unwrap();
        assert_eq!(body, "#心情 今天很好");
        assert_eq!(tags, vec!["心情"]);
    }

    #[test]
    fn pinyin_alias_and_order_independent() {
        assert_eq!(run("/db 买咖啡").unwrap().0, "- [ ] 买咖啡");
        assert_eq!(run("/TODO #备忘 买咖啡").unwrap().0, "#备忘\n\n- [ ] 买咖啡");
    }

    #[test]
    fn multiline_list() {
        assert_eq!(run("/有序 一\n\n二\n").unwrap().0, "1. 一\n2. 二");
        assert_eq!(run("/引用 一句话").unwrap().0, "> 一句话");
    }

    #[test]
    fn unknown_slash_is_text() {
        let (body, _) = run("/usr/bin 是路径").unwrap();
        assert_eq!(body, "/usr/bin 是路径");
    }

    #[test]
    fn inline_tags_are_collected() {
        let (body, tags) = run("#读书 读完了#三体 很好 #科幻。").unwrap();
        assert_eq!(body, "#读书 读完了#三体 很好 #科幻。");
        assert_eq!(tags, vec!["三体", "科幻", "读书"]);
    }

    #[test]
    fn fullwidth_hash() {
        let (body, tags) = run("＃备忘 买咖啡 ＃生活").unwrap();
        assert_eq!(body, "#备忘 买咖啡 #生活");
        assert_eq!(tags, vec!["备忘", "生活"]);
    }

    #[test]
    fn rejects_lockbox_and_empty() {
        assert!(run("#密匣 秘密").is_err());
        assert!(run("随便 #密匣").is_err());
        assert!(run("#备忘 /任务列表").is_err());
        assert!(run("   ").is_err());
    }
}
