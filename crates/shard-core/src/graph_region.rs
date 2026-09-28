use std::ops::Range;

pub const MISSING_REGION_ERROR: &str = "正文中没有受管 JSON 区域。";
pub const MULTIPLE_REGIONS_ERROR: &str = "正文中有多个同类型的受管 JSON 区域。";
pub const UNCLOSED_REGION_ERROR: &str = "正文中的受管 JSON 区域未闭合。";
pub const MIXED_REGIONS_ERROR: &str = "正文中不能同时包含大纲与流程图区域。";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphRegionKind {
    Outline,
    Flowchart,
}

impl GraphRegionKind {
    fn opening_fence(self) -> &'static str {
        match self {
            Self::Outline => "```shardmap",
            Self::Flowchart => "```shardflow",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRegion {
    /// The complete managed region, including its opening and closing fences.
    pub range: Range<usize>,
    /// JSON between the fences, excluding the single newline that introduces
    /// the closing fence.
    pub json_text: String,
}

#[derive(Debug, Clone, Copy)]
struct Line<'a> {
    start: usize,
    content_end: usize,
    end: usize,
    text: &'a str,
}

/// Find the only managed JSON region of `kind` in `body`.
///
/// Fence lines must start in column zero. Opening fences may contain trailing
/// whitespace; closing fences may not.
pub fn find_region(body: &str, kind: GraphRegionKind) -> Result<GraphRegion, String> {
    let lines = lines(body);
    let outline = find_openings(&lines, GraphRegionKind::Outline);
    let flowchart = find_openings(&lines, GraphRegionKind::Flowchart);

    if !outline.is_empty() && !flowchart.is_empty() {
        return Err(MIXED_REGIONS_ERROR.to_string());
    }

    let openings = match kind {
        GraphRegionKind::Outline => outline,
        GraphRegionKind::Flowchart => flowchart,
    };
    if openings.is_empty() {
        return Err(MISSING_REGION_ERROR.to_string());
    }
    if openings.len() > 1 {
        return Err(MULTIPLE_REGIONS_ERROR.to_string());
    }

    let opening_index = openings[0];
    let opening = lines[opening_index];
    let closing = lines[(opening_index + 1)..]
        .iter()
        .copied()
        .find(|line| line.text == "```")
        .ok_or_else(|| UNCLOSED_REGION_ERROR.to_string())?;
    let json_end = strip_one_line_ending(body, opening.end, closing.start);

    Ok(GraphRegion {
        range: opening.start..closing.content_end,
        json_text: body[opening.end..json_end].to_string(),
    })
}

pub fn render_region(kind: GraphRegionKind, json_text: &str) -> String {
    let json_text = json_text.trim_end_matches(['\r', '\n']);
    format!("{}\n{json_text}\n```", kind.opening_fence())
}

pub fn replace_region(
    body: &str,
    kind: GraphRegionKind,
    json_text: &str,
) -> Result<String, String> {
    let region = find_region(body, kind)?;
    let mut replaced = String::with_capacity(
        body.len() - region.range.len() + render_region(kind, json_text).len(),
    );
    replaced.push_str(&body[..region.range.start]);
    replaced.push_str(&render_region(kind, json_text));
    replaced.push_str(&body[region.range.end..]);
    Ok(replaced)
}

fn find_openings(lines: &[Line<'_>], kind: GraphRegionKind) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            (line.text.trim_end_matches(is_javascript_whitespace) == kind.opening_fence())
                .then_some(index)
        })
        .collect()
}

// Keep this set aligned with ECMAScript String.prototype.trimEnd, which the
// TypeScript codec uses. Rust's char::is_whitespace differs for U+0085/FEFF.
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

fn lines(body: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < body.len() {
        let newline = body[start..].find('\n').map(|offset| start + offset);
        let end = newline.map_or(body.len(), |index| index + 1);
        let mut content_end = newline.unwrap_or(body.len());
        if content_end > start && body.as_bytes()[content_end - 1] == b'\r' {
            content_end -= 1;
        }
        lines.push(Line {
            start,
            content_end,
            end,
            text: &body[start..content_end],
        });
        start = end;
    }
    lines
}

fn strip_one_line_ending(body: &str, minimum: usize, end: usize) -> usize {
    if end >= minimum + 2 && &body[(end - 2)..end] == "\r\n" {
        end - 2
    } else if end > minimum && body.as_bytes()[end - 1] == b'\n' {
        end - 1
    } else {
        end
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_both_fence_kinds() {
        let outline_body = "```shardmap   \n{\"kind\":\"shard.map\"}\n```";
        let outline = find_region(outline_body, GraphRegionKind::Outline).unwrap();
        assert_eq!(outline.range, 0..outline_body.len());
        assert_eq!(outline.json_text, r#"{"kind":"shard.map"}"#);

        let flowchart_body = "```shardflow\n{\"kind\":\"shard.flow\"}\n```";
        let flowchart = find_region(flowchart_body, GraphRegionKind::Flowchart).unwrap();
        assert_eq!(flowchart.range, 0..flowchart_body.len());
        assert_eq!(flowchart.json_text, r#"{"kind":"shard.flow"}"#);
    }

    #[test]
    fn renders_without_repeating_json_trailing_newlines() {
        assert_eq!(
            render_region(GraphRegionKind::Outline, "{\"nodes\":[]}\n\n"),
            "```shardmap\n{\"nodes\":[]}\n```"
        );
    }

    #[test]
    fn replaces_only_the_region_and_preserves_surrounding_bytes() {
        let body = "前文\r\n\r\n```shardmap\r\n{\"old\":true}\r\n```\r\n\r\n后文\n";
        let replaced = replace_region(body, GraphRegionKind::Outline, "{\"新\":1}\n").unwrap();

        assert_eq!(
            replaced,
            "前文\r\n\r\n```shardmap\n{\"新\":1}\n```\r\n\r\n后文\n"
        );
    }

    #[test]
    fn reports_missing_region() {
        assert_eq!(
            find_region("普通正文", GraphRegionKind::Outline).unwrap_err(),
            MISSING_REGION_ERROR
        );
    }

    #[test]
    fn reports_multiple_regions() {
        let body = "```shardmap\n{}\n```\n```shardmap\n{}\n```";
        assert_eq!(
            find_region(body, GraphRegionKind::Outline).unwrap_err(),
            MULTIPLE_REGIONS_ERROR
        );
    }

    #[test]
    fn reports_mixed_region_kinds() {
        let body = "```shardmap\n{}\n```\n```shardflow\n{}\n```";
        assert_eq!(
            find_region(body, GraphRegionKind::Outline).unwrap_err(),
            MIXED_REGIONS_ERROR
        );
        assert_eq!(
            find_region(body, GraphRegionKind::Flowchart).unwrap_err(),
            MIXED_REGIONS_ERROR
        );
    }

    #[test]
    fn reports_unclosed_region() {
        assert_eq!(
            find_region("```shardflow\n{}", GraphRegionKind::Flowchart).unwrap_err(),
            UNCLOSED_REGION_ERROR
        );
    }

    #[test]
    fn closing_fence_must_start_in_column_zero() {
        let body = "```shardmap\n{}\n ```";
        assert_eq!(
            find_region(body, GraphRegionKind::Outline).unwrap_err(),
            UNCLOSED_REGION_ERROR
        );

        let body = "```shardmap\n{}\n``` ";
        assert_eq!(
            find_region(body, GraphRegionKind::Outline).unwrap_err(),
            UNCLOSED_REGION_ERROR
        );
    }

    #[test]
    fn opening_fence_must_start_in_column_zero() {
        let body = " ```shardmap\n{}\n```";
        assert_eq!(
            find_region(body, GraphRegionKind::Outline).unwrap_err(),
            MISSING_REGION_ERROR
        );
    }

    #[test]
    fn opening_whitespace_matches_javascript_trim_end() {
        assert!(find_region("```shardmap\u{feff}\n{}\n```", GraphRegionKind::Outline).is_ok());
        assert_eq!(
            find_region("```shardmap\u{0085}\n{}\n```", GraphRegionKind::Outline).unwrap_err(),
            MISSING_REGION_ERROR
        );
    }
}
