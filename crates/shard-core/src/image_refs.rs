//! 正文与表格里的图片引用：找出来、判断是否指向 vault 内的图片、改名时原位改写。
//!
//! 引用一律是 vault 相对路径（`assets/ab/…png`、`notes/证件/营业执照 1.jpg`），旧格式
//! `shard-attachment:<sha256>` 也认。Markdown 目标的编解码与编辑器
//! （`src/editor-rich/markdown/serialize.ts` 的 `destination()`、`parse.ts` 的
//! `decodeLinkDestination`）保持一致：含空白或尖括号时写成 `<…>`，否则转义圆括号。

use crate::image::is_image_extension;

/// 一处 Markdown 行内链接/图片目标：原文字节区间（含 `<>`）与解码后的值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkDestination {
    pub start: usize,
    pub end: usize,
    pub href: String,
}

/// 指向 vault 内图片的引用：有图片扩展名的相对路径、`assets/` 附件或旧的附件引用。
/// 远程地址、绝对路径、锚点都不算。
pub fn is_local_image_reference(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.contains('\\') {
        return false;
    }
    if let Some(hash) = value.strip_prefix("shard-attachment:") {
        return hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if has_scheme(value) || value.starts_with('/') || value.starts_with('#') {
        return false;
    }
    let value = value.strip_prefix("./").unwrap_or(value);
    if value.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return false;
    }
    // assets/ 是附件仓，里面全是图片；旧版附件还有丢了扩展名的。
    value.starts_with("assets/") || path_has_image_extension(value)
}

/// 远程图片地址：http(s) 且路径带图片扩展名。
pub fn is_remote_image_reference(value: &str) -> bool {
    let value = value.trim();
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    if rest.contains(char::is_whitespace) {
        return false;
    }
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    path.contains('/') && path_has_image_extension(path)
}

/// 表格单元格是不是「图片格」：每个非空行都是图片引用（本地或远程）。
/// 返回其中的本地引用（去掉 `./`），供索引与改名使用。
pub fn csv_cell_image_references(cell: &str) -> Option<Vec<String>> {
    let lines: Vec<&str> = cell
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty()
        || !lines
            .iter()
            .all(|line| is_local_image_reference(line) || is_remote_image_reference(line))
    {
        return None;
    }
    Some(
        lines
            .into_iter()
            .filter(|line| is_local_image_reference(line))
            .map(normalize_reference)
            .collect(),
    )
}

/// Markdown 正文里指向 vault 图片的引用（图片与普通链接都算，去重保序）。
pub fn markdown_image_references(text: &str) -> Vec<String> {
    let mut references = Vec::new();
    for destination in markdown_link_destinations(text) {
        if is_local_image_reference(&destination.href) {
            let reference = normalize_reference(&destination.href);
            if !references.contains(&reference) {
                references.push(reference);
            }
        }
    }
    references
}

/// CSV 全文里的图片格引用（按逗号分隔解析；解析失败的记录跳过）。
pub fn csv_image_references(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut references = Vec::new();
    for record in reader.records().map_while(Result::ok) {
        for field in record.iter() {
            for reference in csv_cell_image_references(field).unwrap_or_default() {
                if !references.contains(&reference) {
                    references.push(reference);
                }
            }
        }
    }
    references
}

pub fn normalize_reference(value: &str) -> String {
    let value = value.trim();
    value.strip_prefix("./").unwrap_or(value).to_string()
}

/// 按改名/移动表把引用映射到新路径：文件精确匹配，目录按路径组件前缀匹配。
pub fn remap_reference(reference: &str, moves: &[(String, String)]) -> Option<String> {
    let reference = normalize_reference(reference);
    for (old, new) in moves {
        if reference == *old {
            return Some(new.clone());
        }
        if let Some(rest) = reference.strip_prefix(old.as_str()) {
            if rest.starts_with('/') {
                return Some(format!("{new}{rest}"));
            }
        }
    }
    None
}

/// 改写正文里命中改名表的图片/链接目标，返回新正文与改动处数。其余字节原样保留。
pub fn rewrite_markdown_image_references(text: &str, moves: &[(String, String)]) -> (String, usize) {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut count = 0;
    for destination in markdown_link_destinations(text) {
        if !is_local_image_reference(&destination.href) {
            continue;
        }
        let Some(next) = remap_reference(&destination.href, moves) else {
            continue;
        };
        output.push_str(&text[cursor..destination.start]);
        output.push_str(&encode_markdown_destination(&next));
        cursor = destination.end;
        count += 1;
    }
    output.push_str(&text[cursor..]);
    (output, count)
}

/// 与编辑器 `destination()` 相同的写法。
pub fn encode_markdown_destination(href: &str) -> String {
    if href.is_empty() {
        return String::new();
    }
    if href.chars().any(|character| character.is_whitespace() || character == '<' || character == '>') {
        let mut escaped = String::with_capacity(href.len() + 2);
        escaped.push('<');
        for character in href.chars() {
            if character == '<' || character == '>' {
                escaped.push('\\');
            }
            escaped.push(character);
        }
        escaped.push('>');
        return escaped;
    }
    let mut escaped = String::with_capacity(href.len());
    for character in href.chars() {
        if character == '(' || character == ')' {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// 找出正文里所有行内链接/图片的目标。跳过围栏代码块与行内代码。
pub fn markdown_link_destinations(text: &str) -> Vec<LinkDestination> {
    let mut destinations = Vec::new();
    let mut offset = 0;
    let mut fence: Option<(u8, usize)> = None;
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() <= 3 {
            if let Some((marker, length)) = fence_marker(trimmed) {
                match fence {
                    None => {
                        fence = Some((marker, length));
                        continue;
                    }
                    Some((open, open_length)) if open == marker && length >= open_length && trimmed.trim_end()[length..].trim().is_empty() => {
                        fence = None;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        if fence.is_some() {
            continue;
        }
        scan_line(line, line_start, &mut destinations);
    }
    destinations
}

fn fence_marker(line: &str) -> Option<(u8, usize)> {
    let first = *line.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let length = line.bytes().take_while(|byte| *byte == first).count();
    (length >= 3).then_some((first, length))
}

fn scan_line(line: &str, line_start: usize, destinations: &mut Vec<LinkDestination>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'`' => index = skip_code_span(bytes, index),
            b'[' => {
                let Some(close) = matching_bracket(bytes, index) else {
                    index += 1;
                    continue;
                };
                if bytes.get(close + 1) == Some(&b'(') {
                    if let Some((destination, end)) = parse_destination(line, close + 2) {
                        destinations.push(LinkDestination {
                            start: line_start + destination.start,
                            end: line_start + destination.end,
                            href: destination.href,
                        });
                        index = end;
                        continue;
                    }
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
}

fn skip_code_span(bytes: &[u8], start: usize) -> usize {
    let run = bytes[start..].iter().take_while(|byte| **byte == b'`').count();
    let mut index = start + run;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let closing = bytes[index..].iter().take_while(|byte| **byte == b'`').count();
            if closing == run {
                return index + closing;
            }
            index += closing;
        } else {
            index += 1;
        }
    }
    // 没有闭合：反引号按字面处理。
    start + run
}

fn matching_bracket(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = open;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            b'`' => {
                index = skip_code_span(bytes, index);
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// 从 `(` 之后解析目标与可选标题，要求以 `)` 收尾；返回目标与 `)` 之后的位置。
fn parse_destination(line: &str, start: usize) -> Option<(LinkDestination, usize)> {
    let bytes = line.as_bytes();
    let mut index = start;
    while matches!(bytes.get(index), Some(b' ' | b'\t')) {
        index += 1;
    }
    let destination_start = index;
    let (raw_start, raw_end, destination_end) = if bytes.get(index) == Some(&b'<') {
        index += 1;
        let content_start = index;
        loop {
            match bytes.get(index)? {
                b'\\' => index += 2,
                b'>' => break,
                b'\n' | b'<' => return None,
                _ => index += 1,
            }
        }
        (content_start, index, index + 1)
    } else {
        let mut depth = 0usize;
        while let Some(&byte) = bytes.get(index) {
            match byte {
                b'\\' => {
                    index += 2;
                    continue;
                }
                b'(' => depth += 1,
                b')' if depth == 0 => break,
                b')' => depth -= 1,
                byte if byte.is_ascii_whitespace() || byte.is_ascii_control() => break,
                _ => {}
            }
            index += 1;
        }
        if index == destination_start || depth != 0 {
            return None;
        }
        (destination_start, index, index)
    };
    let raw_end = raw_end.min(bytes.len());
    let mut after = destination_end;
    while matches!(bytes.get(after), Some(b' ' | b'\t')) {
        after += 1;
    }
    if let Some(&quote) = bytes.get(after).filter(|byte| matches!(byte, b'"' | b'\'' | b'(')) {
        let closing = if quote == b'(' { b')' } else { quote };
        after += 1;
        loop {
            match bytes.get(after)? {
                b'\\' => after += 2,
                byte if *byte == closing => {
                    after += 1;
                    break;
                }
                _ => after += 1,
            }
        }
        while matches!(bytes.get(after), Some(b' ' | b'\t')) {
            after += 1;
        }
    }
    if bytes.get(after) != Some(&b')') {
        return None;
    }
    let href = unescape_destination(&line[raw_start..raw_end]);
    if href.is_empty() {
        return None;
    }
    Some((
        LinkDestination {
            start: destination_start,
            end: destination_end,
            href,
        },
        after + 1,
    ))
}

fn unescape_destination(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut characters = raw.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\' {
            if let Some(&next) = characters.peek() {
                if matches!(next, '\\' | '(' | ')' | '<' | '>' | '[' | ']') {
                    output.push(next);
                    characters.next();
                    continue;
                }
            }
        }
        output.push(character);
    }
    output
}

fn has_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

fn path_has_image_extension(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .is_some_and(|(stem, extension)| !stem.is_empty() && is_image_extension(extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_local_and_remote_image_references() {
        for local in [
            "notes/证件/营业执照 1.jpg",
            "./notes/a.PNG",
            "assets/ab/abc.png",
            "assets/2026/06/2026-06-13-195937-b858-png",
            "a.heic",
        ] {
            assert!(is_local_image_reference(local), "{local}");
        }
        let hash = "a".repeat(64);
        assert!(is_local_image_reference(&format!("shard-attachment:{hash}")));
        for not_local in [
            "",
            "https://e.com/a.png",
            "data:image/png;base64,AA",
            "/etc/a.png",
            "#a.png",
            "notes/a.md",
            "notes/../a.png",
            "notes\\a.png",
            ".png",
            "shard-attachment:abc",
        ] {
            assert!(!is_local_image_reference(not_local), "{not_local}");
        }
        assert!(is_remote_image_reference("https://cdn.example.com/p/1.webp?w=200"));
        assert!(!is_remote_image_reference("https://example.com/page"));
        assert!(!is_remote_image_reference("ftp://example.com/a.png"));
    }

    #[test]
    fn classifies_csv_cells() {
        assert_eq!(
            csv_cell_image_references("notes/a.png\n./assets/ab/c.jpg\n"),
            Some(vec!["notes/a.png".to_string(), "assets/ab/c.jpg".to_string()])
        );
        assert_eq!(
            csv_cell_image_references("https://e.com/a.png"),
            Some(Vec::new())
        );
        assert_eq!(csv_cell_image_references("notes/a.png\n说明文字"), None);
        assert_eq!(csv_cell_image_references("  "), None);
        assert_eq!(csv_cell_image_references("12.5"), None);
    }

    #[test]
    fn collects_csv_image_cells() {
        let text = "\u{feff}名称,照片\n执照,notes/证件/营业执照.jpg\n合影,\"notes/a.png\nnotes/b.png\"\n备注,说明 https://e.com\n";
        assert_eq!(
            csv_image_references(text),
            vec!["notes/证件/营业执照.jpg", "notes/a.png", "notes/b.png"]
        );
        // 文件名可以带空格，「见 notes/c.png」在格式上也是合法路径；是不是图片由文件是否存在决定。
        assert_eq!(csv_image_references("见 notes/c.png\n"), vec!["见 notes/c.png"]);
    }

    #[test]
    fn parses_destinations_like_the_editor() {
        let text = "![图](notes/截屏 1.png) 与 ![x](<notes/截屏 2.png> \"标题\")\n\
                    [链接](notes/a\\(1\\).jpg) 和 `![代码](notes/no.png)`\n\
                    ```\n![围栏](notes/fenced.png)\n```\n\
                    ![嵌套 [括号]](assets/ab/c.png 'title') ![空]() [网页](https://e.com/a.png)\n";
        let hrefs: Vec<_> = markdown_link_destinations(text)
            .into_iter()
            .map(|destination| destination.href)
            .collect();
        assert_eq!(
            hrefs,
            vec![
                "notes/截屏 2.png",
                "notes/a(1).jpg",
                "assets/ab/c.png",
                "https://e.com/a.png",
            ]
        );
        // `![图](notes/截屏 1.png)`：未包尖括号的空格不是合法目标。
        assert_eq!(
            markdown_image_references(text),
            vec!["notes/截屏 2.png", "notes/a(1).jpg", "assets/ab/c.png"]
        );
    }

    #[test]
    fn encodes_destinations_like_the_editor() {
        assert_eq!(encode_markdown_destination("notes/a.png"), "notes/a.png");
        assert_eq!(encode_markdown_destination("notes/a(1).png"), "notes/a\\(1\\).png");
        assert_eq!(encode_markdown_destination("notes/截屏 1.png"), "<notes/截屏 1.png>");
        assert_eq!(encode_markdown_destination("notes/a<b>.png"), "<notes/a\\<b\\>.png>");
        for href in ["notes/a(1).png", "notes/截屏 1.png", "notes/a<b> c.png"] {
            let text = format!("![x]({})", encode_markdown_destination(href));
            assert_eq!(markdown_link_destinations(&text)[0].href, href);
        }
    }

    #[test]
    fn rewrites_moved_files_and_directories_in_place() {
        let moves = vec![
            ("notes/旅行/a.jpg".to_string(), "notes/旅行/海边 日落.jpg".to_string()),
            ("notes/证件".to_string(), "notes/归档/证件".to_string()),
        ];
        let text = "前言 ![a](notes/旅行/a.jpg \"t\") 中\n\
                    ![执照](notes/证件/营业执照.png)\n\
                    ![别的](notes/证件夹/x.png) ![备份](notes/旅行/a.jpg.bak)\n\
                    `![代码](notes/旅行/a.jpg)`\n";
        let (next, count) = rewrite_markdown_image_references(text, &moves);
        assert_eq!(count, 2);
        assert_eq!(
            next,
            "前言 ![a](<notes/旅行/海边 日落.jpg> \"t\") 中\n\
             ![执照](notes/归档/证件/营业执照.png)\n\
             ![别的](notes/证件夹/x.png) ![备份](notes/旅行/a.jpg.bak)\n\
             `![代码](notes/旅行/a.jpg)`\n"
        );
        assert_eq!(rewrite_markdown_image_references("无引用", &moves), ("无引用".to_string(), 0));
    }
}
