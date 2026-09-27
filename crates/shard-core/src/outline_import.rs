use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fmt};

const SORT_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_NODES: usize = 400;
const MAX_NODE_TEXT_CHARS: usize = 2_000;
const MAX_ISSUE_SAMPLES: usize = 3;
const MAX_SAMPLE_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineImportNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub sort_key: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineImportTree {
    pub root_id: String,
    pub title: String,
    pub nodes: Vec<OutlineImportNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutlineLossKind {
    DiscardedNonListLine,
    ContinuationLine,
    CodeFence,
    TruncatedNodeText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineLossIssue {
    pub kind: OutlineLossKind,
    pub count: usize,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineLossReport {
    pub issues: Vec<OutlineLossIssue>,
}

impl OutlineLossReport {
    pub fn is_lossless(&self) -> bool {
        self.issues.is_empty()
    }

    pub fn issue(&self, kind: OutlineLossKind) -> Option<&OutlineLossIssue> {
        self.issues.iter().find(|issue| issue.kind == kind)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineImport {
    pub tree: OutlineImportTree,
    pub loss_report: OutlineLossReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutlineImportErrorKind {
    NoValidLines,
    EmptyRoot,
    TooManyNodes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineImportError {
    pub kind: OutlineImportErrorKind,
    pub node_count: usize,
    pub loss_report: OutlineLossReport,
}

impl fmt::Display for OutlineImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            OutlineImportErrorKind::NoValidLines => formatter.write_str("没有任何有效行。"),
            OutlineImportErrorKind::EmptyRoot => formatter.write_str("根节点文字不能为空。"),
            OutlineImportErrorKind::TooManyNodes => write!(
                formatter,
                "大纲节点数量不能超过 {MAX_NODES}（实际 {}）。",
                self.node_count
            ),
        }
    }
}

impl std::error::Error for OutlineImportError {}

#[derive(Default)]
struct LossAccumulator {
    discarded_non_list_lines: IssueAccumulator,
    continuation_lines: IssueAccumulator,
    code_fences: IssueAccumulator,
    truncated_node_texts: IssueAccumulator,
}

#[derive(Default)]
struct IssueAccumulator {
    count: usize,
    samples: Vec<String>,
}

impl IssueAccumulator {
    fn record(&mut self, sample: &str) {
        self.count += 1;
        if self.samples.len() < MAX_ISSUE_SAMPLES {
            self.samples.push(sample_text(sample));
        }
    }
}

impl LossAccumulator {
    fn finish(self) -> OutlineLossReport {
        let mut issues = Vec::new();
        push_issue(
            &mut issues,
            OutlineLossKind::DiscardedNonListLine,
            self.discarded_non_list_lines,
        );
        push_issue(
            &mut issues,
            OutlineLossKind::ContinuationLine,
            self.continuation_lines,
        );
        push_issue(&mut issues, OutlineLossKind::CodeFence, self.code_fences);
        push_issue(
            &mut issues,
            OutlineLossKind::TruncatedNodeText,
            self.truncated_node_texts,
        );
        OutlineLossReport { issues }
    }
}

fn push_issue(issues: &mut Vec<OutlineLossIssue>, kind: OutlineLossKind, issue: IssueAccumulator) {
    if issue.count > 0 {
        issues.push(OutlineLossIssue {
            kind,
            count: issue.count,
            samples: issue.samples,
        });
    }
}

/// 把旧式缩进列表大纲转换为不依赖 Tauri 的树，并报告转换中的所有损失。
///
/// 树结构与前端 `parseMindMapOutline` 保持一致，但不会在 200 个节点处截断。
/// 超过 2000 个 Unicode 字符的节点文字会截断并进入损失报告，以保证输出可由
/// 大纲文件校验器接受。
pub fn import_outline(source: &str) -> Result<OutlineImport, OutlineImportError> {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut nodes = Vec::<OutlineImportNode>::new();
    let mut child_counts = HashMap::<String, usize>::new();
    let mut stack = Vec::<(usize, String)>::new();
    let mut root_id = None::<String>;
    let mut root_text = String::new();
    let mut losses = LossAccumulator::default();

    for line in normalized.split('\n') {
        if trim_javascript_whitespace(line).is_empty() {
            continue;
        }

        let Some((indent, text)) = list_item(line) else {
            if root_id.is_none() {
                let text = trim_javascript_whitespace(line);
                let text = bounded_node_text(text, &mut losses);
                let id = push_node(&mut nodes, &mut child_counts, None, text.clone());
                root_text = text;
                root_id = Some(id);
            } else if is_code_fence(line) {
                losses.code_fences.record(line);
            } else if line.starts_with([' ', '\t']) {
                losses.continuation_lines.record(line);
            } else {
                losses.discarded_non_list_lines.record(line);
            }
            continue;
        };

        let width = indentation_width(indent);
        let text = trim_javascript_whitespace(text);
        let text = bounded_node_text(text, &mut losses);
        if root_id.is_none() {
            let id = push_node(&mut nodes, &mut child_counts, None, text.clone());
            root_text = text;
            root_id = Some(id.clone());
            stack.push((width, id));
            continue;
        }

        while stack
            .last()
            .is_some_and(|(ancestor_width, _)| *ancestor_width >= width)
        {
            stack.pop();
        }
        let parent_id = stack
            .last()
            .map(|(_, id)| id.clone())
            .or_else(|| root_id.clone());
        let id = push_node(&mut nodes, &mut child_counts, parent_id, text);
        stack.push((width, id));
    }

    let loss_report = losses.finish();
    let Some(root_id) = root_id else {
        return Err(OutlineImportError {
            kind: OutlineImportErrorKind::NoValidLines,
            node_count: 0,
            loss_report,
        });
    };
    if root_text.is_empty() {
        return Err(OutlineImportError {
            kind: OutlineImportErrorKind::EmptyRoot,
            node_count: nodes.len(),
            loss_report,
        });
    }
    if nodes.len() > MAX_NODES {
        return Err(OutlineImportError {
            kind: OutlineImportErrorKind::TooManyNodes,
            node_count: nodes.len(),
            loss_report,
        });
    }

    Ok(OutlineImport {
        tree: OutlineImportTree {
            root_id,
            title: root_text,
            nodes,
        },
        loss_report,
    })
}

fn push_node(
    nodes: &mut Vec<OutlineImportNode>,
    child_counts: &mut HashMap<String, usize>,
    parent_id: Option<String>,
    text: String,
) -> String {
    let id = format!("n{}", nodes.len());
    let sibling_index = parent_id
        .as_ref()
        .map(|parent_id| {
            let count = child_counts.entry(parent_id.clone()).or_default();
            let index = *count;
            *count += 1;
            index
        })
        .unwrap_or(0);
    nodes.push(OutlineImportNode {
        id: id.clone(),
        parent_id,
        sort_key: sort_key(sibling_index),
        text,
    });
    id
}

fn list_item(line: &str) -> Option<(&str, &str)> {
    let marker_start = line
        .char_indices()
        .find_map(|(index, character)| (!matches!(character, ' ' | '\t')).then_some(index))
        .unwrap_or(line.len());
    let indent = &line[..marker_start];
    let bytes = line.as_bytes();
    let mut cursor = marker_start;
    let marker = *bytes.get(cursor)?;

    if matches!(marker, b'-' | b'*' | b'+') {
        cursor += 1;
    } else if marker.is_ascii_digit() {
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if !matches!(bytes.get(cursor), Some(b'.' | b')')) {
            return None;
        }
        cursor += 1;
    } else {
        return None;
    }

    if !matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        return None;
    }
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    Some((indent, &line[cursor..]))
}

fn indentation_width(indent: &str) -> usize {
    indent.chars().fold(0, |width, character| {
        width
            + if character == '\t' {
                4 - (width % 4)
            } else {
                1
            }
    })
}

fn sort_key(index: usize) -> String {
    let base = SORT_ALPHABET.len();
    let high = SORT_ALPHABET[(index / base) % base] as char;
    let low = SORT_ALPHABET[index % base] as char;
    format!("{high}{low}")
}

fn bounded_node_text(text: &str, losses: &mut LossAccumulator) -> String {
    let mut characters = text.chars();
    let bounded = characters
        .by_ref()
        .take(MAX_NODE_TEXT_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        losses.truncated_node_texts.record(text);
    }
    bounded
}

fn is_code_fence(line: &str) -> bool {
    let trimmed = trim_javascript_whitespace_start(line);
    let Some(marker) = trimmed.chars().next() else {
        return false;
    };
    matches!(marker, '`' | '~')
        && trimmed
            .chars()
            .take_while(|character| *character == marker)
            .count()
            >= 3
}

fn sample_text(value: &str) -> String {
    let value = trim_javascript_whitespace(value);
    let mut characters = value.chars();
    let sample = characters
        .by_ref()
        .take(MAX_SAMPLE_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{sample}…")
    } else {
        sample
    }
}

fn trim_javascript_whitespace(value: &str) -> &str {
    trim_javascript_whitespace_end(trim_javascript_whitespace_start(value))
}

fn trim_javascript_whitespace_start(value: &str) -> &str {
    value.trim_start_matches(is_javascript_whitespace)
}

fn trim_javascript_whitespace_end(value: &str) -> &str {
    value.trim_end_matches(is_javascript_whitespace)
}

// Keep this aligned with ECMAScript String.prototype.trim, which the TypeScript importer uses.
fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn imported(source: &str) -> OutlineImport {
        import_outline(source).expect("大纲应成功导入")
    }

    fn child_texts<'a>(tree: &'a OutlineImportTree, parent_id: &str) -> Vec<&'a str> {
        tree.nodes
            .iter()
            .filter(|node| node.parent_id.as_deref() == Some(parent_id))
            .map(|node| node.text.as_str())
            .collect()
    }

    #[test]
    fn first_list_item_is_root_and_indentation_builds_tree() {
        let result = imported("- 中心主题\n  - 分支一\n    - 叶子\n  - 分支二");

        assert!(result.loss_report.is_lossless());
        assert_eq!(result.tree.root_id, "n0");
        assert_eq!(result.tree.title, "中心主题");
        assert_eq!(result.tree.nodes.len(), 4);
        assert_eq!(child_texts(&result.tree, "n0"), vec!["分支一", "分支二"]);
        assert_eq!(child_texts(&result.tree, "n1"), vec!["叶子"]);
    }

    #[test]
    fn supports_all_frontend_markers() {
        let result = imported("* 中心\n  + 甲\n  1. 乙\n  2) 丙");

        assert_eq!(child_texts(&result.tree, "n0"), vec!["甲", "乙", "丙"]);
    }

    #[test]
    fn tabs_use_four_column_stops() {
        let result = imported("- 根\n\t- 制表\n    - 四空格\n\t\t- 更深");

        assert_eq!(child_texts(&result.tree, "n0"), vec!["制表", "四空格"]);
        assert_eq!(child_texts(&result.tree, "n2"), vec!["更深"]);
    }

    #[test]
    fn skipped_levels_and_later_top_level_items_attach_to_root() {
        let result = imported("- 甲\n        - 跳级\n- 乙\n- 丙");

        assert_eq!(child_texts(&result.tree, "n0"), vec!["跳级", "乙", "丙"]);
        assert_eq!(result.tree.nodes[1].parent_id.as_deref(), Some("n0"));
    }

    #[test]
    fn first_non_list_line_is_root_and_later_lines_are_reported() {
        let result = imported("中心主题\n- 甲\n  - 甲一\n段落\n  续行");

        assert_eq!(result.tree.title, "中心主题");
        assert_eq!(child_texts(&result.tree, "n0"), vec!["甲"]);
        assert_eq!(child_texts(&result.tree, "n1"), vec!["甲一"]);
        assert_eq!(
            result
                .loss_report
                .issue(OutlineLossKind::DiscardedNonListLine)
                .unwrap()
                .count,
            1
        );
        assert_eq!(
            result
                .loss_report
                .issue(OutlineLossKind::ContinuationLine)
                .unwrap()
                .count,
            1
        );
    }

    #[test]
    fn crlf_and_cr_match_lf() {
        let expected = imported("- 根\n  - 甲\n  - 乙");

        assert_eq!(imported("- 根\r\n  - 甲\r\n  - 乙"), expected);
        assert_eq!(imported("- 根\r  - 甲\r  - 乙"), expected);
    }

    #[test]
    fn sort_keys_are_fixed_width_base62_in_source_order() {
        let source = std::iter::once("- 根".to_string())
            .chain((0..70).map(|index| format!("  - 第 {index}")))
            .collect::<Vec<_>>()
            .join("\n");
        let result = imported(&source);

        assert_eq!(result.tree.nodes[1].sort_key, "00");
        assert_eq!(result.tree.nodes[62].sort_key, "0z");
        assert_eq!(result.tree.nodes[63].sort_key, "10");
        assert!(result.tree.nodes.iter().all(|node| node.sort_key.len() == 2
            && node.sort_key.chars().all(|c| c.is_ascii_alphanumeric())));
    }

    #[test]
    fn does_not_apply_the_frontend_preview_limit() {
        let source = std::iter::once("- 根".to_string())
            .chain((0..299).map(|index| format!("  - 子 {index}")))
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(imported(&source).tree.nodes.len(), 300);
    }

    #[test]
    fn reports_fences_without_tracking_code_block_state() {
        let result = imported("- 根\n```md\n  - 围栏内仍按列表解析\n```\n普通段落\n  续行");

        assert_eq!(child_texts(&result.tree, "n0"), vec!["围栏内仍按列表解析"]);
        assert_eq!(
            result
                .loss_report
                .issue(OutlineLossKind::CodeFence)
                .unwrap()
                .count,
            2
        );
        assert_eq!(
            result
                .loss_report
                .issue(OutlineLossKind::DiscardedNonListLine)
                .unwrap()
                .count,
            1
        );
        assert_eq!(
            result
                .loss_report
                .issue(OutlineLossKind::ContinuationLine)
                .unwrap()
                .count,
            1
        );
    }

    #[test]
    fn truncates_overlong_unicode_text_and_reports_loss() {
        let long = "😀".repeat(MAX_NODE_TEXT_CHARS + 1);
        let result = imported(&format!("- 根\n  - {long}"));
        let node = &result.tree.nodes[1];

        assert_eq!(node.text.chars().count(), MAX_NODE_TEXT_CHARS);
        let issue = result
            .loss_report
            .issue(OutlineLossKind::TruncatedNodeText)
            .unwrap();
        assert_eq!(issue.count, 1);
        assert_eq!(issue.samples.len(), 1);
        assert!(issue.samples[0].ends_with('…'));
    }

    #[test]
    fn loss_samples_are_bounded() {
        let result = imported("- 根\n段落一\n段落二\n段落三\n段落四");
        let issue = result
            .loss_report
            .issue(OutlineLossKind::DiscardedNonListLine)
            .unwrap();

        assert_eq!(issue.count, 4);
        assert_eq!(issue.samples, vec!["段落一", "段落二", "段落三"]);
    }

    #[test]
    fn rejects_sources_without_valid_lines() {
        for source in ["", "   ", "\n\r\n  \n", "\u{feff}\n"] {
            let error = import_outline(source).unwrap_err();
            assert_eq!(error.kind, OutlineImportErrorKind::NoValidLines);
            assert_eq!(error.node_count, 0);
        }
    }

    #[test]
    fn rejects_empty_root_text() {
        let error = import_outline("- \n  - 子节点").unwrap_err();

        assert_eq!(error.kind, OutlineImportErrorKind::EmptyRoot);
        assert_eq!(error.node_count, 2);
    }

    #[test]
    fn accepts_400_nodes_and_rejects_401_without_truncating_count() {
        let source = |child_count: usize| {
            std::iter::once("- 根".to_string())
                .chain((0..child_count).map(|index| format!("  - 子 {index}")))
                .collect::<Vec<_>>()
                .join("\n")
        };

        assert_eq!(imported(&source(399)).tree.nodes.len(), 400);
        let error = import_outline(&source(400)).unwrap_err();
        assert_eq!(error.kind, OutlineImportErrorKind::TooManyNodes);
        assert_eq!(error.node_count, 401);
    }
}
