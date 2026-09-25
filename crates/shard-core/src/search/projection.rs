use super::{
    normalize_search_text, DocumentOnlyReason, ProjectedDocument, SearchProjection,
    SearchProjectionBlock, SourceDocument,
};

#[derive(Debug, Clone, Copy)]
struct Fence {
    marker: char,
    length: usize,
}

#[derive(Debug, Default)]
struct InlineProjection {
    text: String,
    embeds: Vec<String>,
}

pub fn project_document(input: &SourceDocument) -> ProjectedDocument {
    let projection = project_markdown(&input.body);
    let normalized_blocks = projection
        .blocks
        .iter()
        .map(|block| normalize_search_text(block.text()))
        .collect();
    ProjectedDocument {
        stable_key: input.stable_key.clone(),
        title: input.title.clone(),
        tags: input.tags.clone(),
        modified_at: input.modified_at,
        normalized_title: normalize_search_text(&input.title),
        normalized_tags: input
            .tags
            .iter()
            .map(|tag| normalize_search_text(tag))
            .collect(),
        normalized_blocks,
        projection,
    }
}

pub fn project_markdown(markdown: &str) -> SearchProjection {
    let source = normalize_newlines(markdown);
    let lines = source.split('\n').collect::<Vec<_>>();
    let mut table_rows = vec![false; lines.len()];
    for (index, line) in lines.iter().enumerate() {
        if !is_table_delimiter(line) {
            continue;
        }
        if index > 0 && lines[index - 1].contains('|') {
            table_rows[index - 1] = true;
        }
        for cursor in index + 1..lines.len() {
            if lines[cursor].trim().is_empty() || !lines[cursor].contains('|') {
                break;
            }
            table_rows[cursor] = true;
        }
    }

    let mut blocks = Vec::new();
    let mut fence = None;
    let mut fence_lines = Vec::new();
    let mut may_merge = false;

    for (index, line) in lines.iter().enumerate() {
        if let Some(active_fence) = fence {
            if closes_fence(line, active_fence) {
                append_block(
                    &mut blocks,
                    SearchProjectionBlock::DocumentOnly {
                        reason: DocumentOnlyReason::CodeBlock,
                        text: trim_blank_lines(&fence_lines.join("\n")),
                    },
                    may_merge,
                );
                fence = None;
                fence_lines.clear();
                may_merge = false;
            } else {
                fence_lines.push((*line).to_string());
            }
            continue;
        }

        if let Some(opening) = fence_at(line) {
            fence = Some(opening);
            fence_lines.clear();
            may_merge = false;
            continue;
        }

        if is_table_delimiter(line) {
            may_merge = false;
            continue;
        }

        let inline = if table_rows[index] {
            split_table_cells(line)
                .iter()
                .map(|cell| project_inline(cell))
                .collect::<Vec<_>>()
        } else {
            vec![project_inline(&strip_block_prefix(line))]
        };
        let text = inline
            .iter()
            .map(|part| part.text.as_str())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\t");
        let embeds = inline
            .into_iter()
            .flat_map(|part| part.embeds)
            .collect::<Vec<_>>();

        if !text.is_empty() {
            append_block(&mut blocks, SearchProjectionBlock::Text { text }, may_merge);
            may_merge = true;
        }
        for embed in &embeds {
            append_block(
                &mut blocks,
                SearchProjectionBlock::DocumentOnly {
                    reason: DocumentOnlyReason::Embed,
                    text: embed.clone(),
                },
                may_merge,
            );
            may_merge = true;
        }
        if blocks.last().is_none() || (embeds.is_empty() && strip_block_prefix(line).is_empty()) {
            may_merge = false;
        }
    }

    if fence.is_some() && !fence_lines.is_empty() {
        append_block(
            &mut blocks,
            SearchProjectionBlock::DocumentOnly {
                reason: DocumentOnlyReason::CodeBlock,
                text: trim_blank_lines(&fence_lines.join("\n")),
            },
            may_merge,
        );
    }

    let revealable_text = blocks
        .iter()
        .filter(|block| block.is_revealable())
        .map(SearchProjectionBlock::text)
        .collect::<Vec<_>>()
        .join("\n");
    let document_only_text = blocks
        .iter()
        .filter(|block| !block.is_revealable())
        .map(SearchProjectionBlock::text)
        .collect::<Vec<_>>()
        .join("\n");
    let searchable_text = blocks
        .iter()
        .map(SearchProjectionBlock::text)
        .collect::<Vec<_>>()
        .join("\n");

    SearchProjection {
        blocks,
        document_only_text,
        revealable_text,
        searchable_text,
        version: 1,
    }
}

fn normalize_newlines(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push('\n');
        } else {
            normalized.push(character);
        }
    }
    normalized
}

fn fence_at(line: &str) -> Option<Fence> {
    let trimmed = trim_leading_spaces(line, 3);
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = trimmed
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (length >= 3).then_some(Fence { marker, length })
}

fn closes_fence(line: &str, fence: Fence) -> bool {
    let trimmed = trim_leading_spaces(line, 3);
    let length = trimmed
        .chars()
        .take_while(|character| *character == fence.marker)
        .count();
    length >= fence.length && trimmed.chars().skip(length).all(char::is_whitespace)
}

fn trim_leading_spaces(mut text: &str, maximum: usize) -> &str {
    let count = text
        .chars()
        .take(maximum)
        .take_while(|char| *char == ' ')
        .count();
    text = &text[count..];
    text
}

fn is_table_delimiter(line: &str) -> bool {
    let trimmed = line.trim().trim_start_matches('|').trim_end_matches('|');
    let cells = trimmed.split('|').collect::<Vec<_>>();
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let marker = cell.trim().trim_start_matches(':').trim_end_matches(':');
            marker.len() >= 2 && marker.chars().all(|character| character == '-')
        })
}

fn split_table_cells(line: &str) -> Vec<String> {
    let chars = line.chars().collect::<Vec<_>>();
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut code_run = 0;
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '\\' && chars.get(index + 1) == Some(&'|') {
            cell.push('|');
            index += 2;
            continue;
        }
        if chars[index] == '`' {
            let run = marker_run(&chars, index, '`');
            code_run = if code_run == run {
                0
            } else if code_run == 0 {
                run
            } else {
                code_run
            };
            cell.extend(std::iter::repeat_n('`', run));
            index += run;
            continue;
        }
        if chars[index] == '|' && code_run == 0 {
            cells.push(cell.trim().to_string());
            cell.clear();
            index += 1;
            continue;
        }
        cell.push(chars[index]);
        index += 1;
    }
    cells.push(cell.trim().to_string());
    if cells.first().is_some_and(String::is_empty) {
        cells.remove(0);
    }
    if cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    cells
}

fn strip_block_prefix(line: &str) -> String {
    let mut text = line.trim_end().to_string();
    loop {
        let trimmed = trim_leading_spaces(&text, 3);
        if let Some(rest) = trimmed.strip_prefix('>') {
            text = rest.strip_prefix([' ', '\t']).unwrap_or(rest).to_string();
        } else {
            break;
        }
    }

    let trimmed = trim_leading_spaces(&text, 3);
    let heading_length = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if (1..=6).contains(&heading_length) {
        let rest = &trimmed[heading_length..];
        if rest.is_empty() || rest.starts_with([' ', '\t']) {
            text = rest.trim_start().to_string();
        }
    }

    text = strip_list_marker(&text);
    if text.starts_with("[ ]") || text.starts_with("[x]") || text.starts_with("[X]") {
        text = text[3..].trim_start().to_string();
    }

    let without_closing = text.trim_end();
    let closing_hashes = without_closing
        .chars()
        .rev()
        .take_while(|character| *character == '#')
        .count();
    if closing_hashes > 0 {
        let prefix = &without_closing[..without_closing.len() - closing_hashes];
        if prefix.ends_with(char::is_whitespace) {
            text = prefix.trim_end().to_string();
        }
    }

    let trimmed = text.trim_end();
    if trimmed.ends_with("  ") {
        text = trimmed.trim_end_matches(' ').to_string();
    } else if let Some(without_slash) = trimmed.strip_suffix('\\') {
        text = without_slash.to_string();
    }
    text.trim().to_string()
}

fn strip_list_marker(text: &str) -> String {
    let trimmed = trim_leading_spaces(text, 3);
    let chars = trimmed.chars().collect::<Vec<_>>();
    if chars.len() >= 2 && matches!(chars[0], '-' | '+' | '*') && chars[1].is_whitespace() {
        return chars[2..]
            .iter()
            .collect::<String>()
            .trim_start()
            .to_string();
    }
    let digits = chars
        .iter()
        .take_while(|char| char.is_ascii_digit())
        .count();
    if digits > 0
        && matches!(chars.get(digits), Some('.') | Some(')'))
        && chars
            .get(digits + 1)
            .is_some_and(|char| char.is_whitespace())
    {
        return chars[digits + 2..]
            .iter()
            .collect::<String>()
            .trim_start()
            .to_string();
    }
    text.to_string()
}

fn project_inline(input: &str) -> InlineProjection {
    let chars = input.chars().collect::<Vec<_>>();
    let mut result = InlineProjection::default();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '\\' && index + 1 < chars.len() {
            result.text.push(chars[index + 1]);
            index += 2;
            continue;
        }

        if chars[index] == '`' {
            let run = marker_run(&chars, index, '`');
            if let Some(close) = find_exact_run(&chars, index + run, '`', run) {
                result.text.extend(&chars[index + run..close]);
                index = close + run;
                continue;
            }
        }

        if starts_with_chars(&chars, index, "![[") {
            if let Some(close) = find_chars(&chars, index + 3, "]]") {
                let value = chars[index + 3..close].iter().collect::<String>();
                let visible = value
                    .split_once('|')
                    .map_or(value.as_str(), |(_, label)| label)
                    .trim();
                if !visible.is_empty() {
                    result.embeds.push(visible.to_string());
                }
                index = close + 2;
                continue;
            }
        }

        if starts_with_chars(&chars, index, "[[") {
            if let Some(close) = find_chars(&chars, index + 2, "]]") {
                let value = chars[index + 2..close].iter().collect::<String>();
                let visible = value
                    .split_once('|')
                    .map_or(value.as_str(), |(_, label)| label)
                    .trim();
                result.text.push_str(visible);
                index = close + 2;
                continue;
            }
        }

        if let Some(link) = markdown_link_at(&chars, index) {
            let visible = project_inline(&link.label).text.trim().to_string();
            if link.image {
                if !visible.is_empty() {
                    result.embeds.push(visible);
                }
            } else {
                result.text.push_str(&visible);
            }
            index = link.end;
            continue;
        }

        if chars[index] == '<' {
            if let Some(relative_close) = chars[index + 1..].iter().position(|char| *char == '>') {
                let close = index + 1 + relative_close;
                let content = chars[index + 1..close].iter().collect::<String>();
                if let Some(mail) = content
                    .strip_prefix("mailto:")
                    .or_else(|| content.strip_prefix("MAILTO:"))
                {
                    result.text.push_str(mail);
                } else if content.starts_with("http://") || content.starts_with("https://") {
                    result.text.push_str(&content);
                } else if !looks_like_html_tag(&content) {
                    result.text.extend(&chars[index..=close]);
                }
                index = close + 1;
                continue;
            }
        }

        if matches!(chars[index], '*' | '_' | '~') {
            let marker = chars[index];
            let run = marker_run(&chars, index, marker);
            let supported = marker != '~' || run >= 2;
            let delimiter = supported
                && ((delimiter_can_open(&chars, index, run)
                    && has_matching_delimiter(&chars, index, marker, run, 1))
                    || (delimiter_can_close(&chars, index, run)
                        && has_matching_delimiter(&chars, index, marker, run, -1)));
            if delimiter {
                index += run;
                continue;
            }
        }

        result.text.push(chars[index]);
        index += 1;
    }

    result.text = result.text.trim().to_string();
    result
}

struct MarkdownLink {
    image: bool,
    label: String,
    end: usize,
}

fn markdown_link_at(chars: &[char], index: usize) -> Option<MarkdownLink> {
    let image = chars.get(index) == Some(&'!');
    let open = index + usize::from(image);
    if chars.get(open) != Some(&'[') {
        return None;
    }
    let label_close = chars[open + 1..].iter().position(|char| *char == ']')? + open + 1;
    if chars.get(label_close + 1) != Some(&'(') {
        return None;
    }
    let destination_close = chars[label_close + 2..]
        .iter()
        .position(|char| *char == ')')?
        + label_close
        + 2;
    Some(MarkdownLink {
        image,
        label: chars[open + 1..label_close].iter().collect(),
        end: destination_close + 1,
    })
}

fn looks_like_html_tag(content: &str) -> bool {
    let value = content.strip_prefix('/').unwrap_or(content);
    value
        .chars()
        .next()
        .is_some_and(|char| char.is_ascii_alphabetic())
}

fn starts_with_chars(chars: &[char], index: usize, value: &str) -> bool {
    chars[index..]
        .iter()
        .copied()
        .zip(value.chars())
        .all(|(left, right)| left == right)
        && chars.len().saturating_sub(index) >= value.chars().count()
}

fn find_chars(chars: &[char], start: usize, value: &str) -> Option<usize> {
    (start..chars.len()).find(|index| starts_with_chars(chars, *index, value))
}

fn marker_run(chars: &[char], index: usize, marker: char) -> usize {
    chars[index..]
        .iter()
        .take_while(|character| **character == marker)
        .count()
}

fn find_exact_run(chars: &[char], start: usize, marker: char, run: usize) -> Option<usize> {
    (start..chars.len()).find(|index| {
        chars[*index] == marker
            && marker_run(chars, *index, marker) == run
            && chars.get(*index + run) != Some(&marker)
    })
}

fn delimiter_can_open(chars: &[char], index: usize, run: usize) -> bool {
    let before = index
        .checked_sub(1)
        .and_then(|position| chars.get(position));
    let after = chars.get(index + run);
    if after.is_none_or(|character| character.is_whitespace()) {
        return false;
    }
    !(chars[index] == '_'
        && before.is_some_and(|character| character.is_alphanumeric())
        && after.is_some_and(|character| character.is_alphanumeric()))
}

fn delimiter_can_close(chars: &[char], index: usize, run: usize) -> bool {
    let before = index
        .checked_sub(1)
        .and_then(|position| chars.get(position));
    let after = chars.get(index + run);
    if before.is_none_or(|character| character.is_whitespace()) {
        return false;
    }
    !(chars[index] == '_'
        && before.is_some_and(|character| character.is_alphanumeric())
        && after.is_some_and(|character| character.is_alphanumeric()))
}

fn has_matching_delimiter(
    chars: &[char],
    index: usize,
    marker: char,
    run: usize,
    direction: i32,
) -> bool {
    let mut cursor = index as i32 + direction;
    while cursor >= 0 && (cursor as usize) < chars.len() {
        let position = cursor as usize;
        if chars[position] == marker && marker_run(chars, position, marker) == run {
            if (direction > 0 && delimiter_can_close(chars, position, run))
                || (direction < 0 && delimiter_can_open(chars, position, run))
            {
                return true;
            }
        }
        cursor += direction;
    }
    false
}

fn append_block(
    blocks: &mut Vec<SearchProjectionBlock>,
    block: SearchProjectionBlock,
    may_merge: bool,
) {
    if block.text().is_empty() {
        return;
    }
    if may_merge {
        if let Some(previous) = blocks.last_mut() {
            match (previous, &block) {
                (
                    SearchProjectionBlock::Text { text: previous },
                    SearchProjectionBlock::Text { text },
                ) => {
                    previous.push('\n');
                    previous.push_str(text);
                    return;
                }
                (
                    SearchProjectionBlock::DocumentOnly {
                        reason: previous_reason,
                        text: previous,
                    },
                    SearchProjectionBlock::DocumentOnly { reason, text },
                ) if previous_reason == reason => {
                    previous.push('\n');
                    previous.push_str(text);
                    return;
                }
                _ => {}
            }
        }
    }
    blocks.push(block);
}

fn trim_blank_lines(text: &str) -> String {
    text.trim_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_projection_preserves_inline_code_underscores() {
        assert_eq!(
            project_markdown("`snake_case` and `__init__`").revealable_text,
            "snake_case and __init__"
        );
    }

    #[test]
    fn search_projection_separates_fence_text_from_revealable_text() {
        let projection = project_markdown("可定位正文\n```ts\nconst hidden_value = 1\n```");
        assert_eq!(projection.revealable_text, "可定位正文");
        assert_eq!(projection.document_only_text, "const hidden_value = 1");
        assert!(normalize_search_text(&projection.searchable_text).contains("hidden_value"));
    }
}
