//! 交互编辑器的纯文本内核；终端事件和绘制由界面层处理。

use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const UNDO_LIMIT: usize = 200;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Cursor {
    pub line: usize,
    pub byte: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphemeColumn {
    pub byte: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualRow {
    pub line: usize,
    pub start: usize,
    pub end: usize,
    pub columns: Vec<GraphemeColumn>,
}

#[derive(Clone)]
struct Snapshot {
    lines: Vec<String>,
    cursor: Cursor,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Group {
    Insert,
    Backspace,
    Delete,
}

pub struct Editor {
    lines: Vec<String>,
    cursor: Cursor,
    saved: String,
    expected_column: Option<usize>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    group: Option<(Group, Instant)>,
}

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn width(grapheme: &str) -> usize {
    if grapheme == "\t" {
        4
    } else {
        UnicodeWidthStr::width(grapheme).max(1)
    }
}

fn previous_boundary(line: &str, byte: usize) -> usize {
    line[..byte]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn next_boundary(line: &str, byte: usize) -> usize {
    line[byte..]
        .graphemes(true)
        .next()
        .map(|grapheme| byte + grapheme.len())
        .unwrap_or(byte)
}

fn ascii_word(grapheme: &str) -> bool {
    grapheme.len() == 1 && grapheme.as_bytes()[0].is_ascii_alphanumeric()
}

fn word_start(line: &str, byte: usize) -> usize {
    let mut start = byte;
    let mut kind = None;
    for (index, grapheme) in line[..byte].grapheme_indices(true).rev() {
        let current = if grapheme.chars().all(char::is_whitespace) {
            0
        } else if ascii_word(grapheme) {
            1
        } else {
            2
        };
        if kind.is_some_and(|kind| kind != current || current == 2) {
            break;
        }
        kind = Some(current);
        start = index;
        if current == 2 {
            break;
        }
    }
    start
}

fn word_end(line: &str, byte: usize) -> usize {
    let mut end = byte;
    let mut kind = None;
    for grapheme in line[byte..].graphemes(true) {
        let current = if grapheme.chars().all(char::is_whitespace) {
            0
        } else if ascii_word(grapheme) {
            1
        } else {
            2
        };
        if kind.is_some_and(|kind| kind != current || current == 2) {
            break;
        }
        kind = Some(current);
        end += grapheme.len();
        if current == 2 {
            break;
        }
    }
    end
}

fn list_prefix(line: &str) -> Option<(usize, String)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    let rest = &line[indent..];
    for marker in ["- [ ] ", "- [x] ", "- [X] "] {
        if rest.starts_with(marker) {
            return Some((indent + marker.len(), format!("{}- [ ] ", &line[..indent])));
        }
    }
    for marker in ["- ", "* ", "+ ", "> "] {
        if rest.starts_with(marker) {
            return Some((
                indent + marker.len(),
                line[..indent + marker.len()].to_string(),
            ));
        }
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && rest[digits..].starts_with(". ") {
        if let Ok(number) = rest[..digits].parse::<u64>() {
            if let Some(next) = number.checked_add(1) {
                return Some((
                    indent + digits + 2,
                    format!("{}{}. ", &line[..indent], next),
                ));
            }
        }
    }
    None
}

impl Editor {
    pub fn new(text: &str) -> Self {
        let saved = normalize(text);
        Self {
            lines: saved.split('\n').map(str::to_string).collect(),
            cursor: Cursor::default(),
            saved,
            expected_column: None,
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
        }
    }

    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    pub fn set_cursor(&mut self, cursor: Cursor) -> bool {
        let line = cursor.line.min(self.lines.len() - 1);
        let text = &self.lines[line];
        let byte = cursor.byte.min(text.len());
        let byte = if text.is_char_boundary(byte) {
            text.grapheme_indices(true)
                .map(|(index, _)| index)
                .take_while(|index| *index <= byte)
                .last()
                .unwrap_or(0)
        } else {
            text.grapheme_indices(true)
                .map(|(index, _)| index)
                .take_while(|index| *index < byte)
                .last()
                .unwrap_or(0)
        };
        self.cursor = Cursor {
            line,
            byte: if cursor.byte >= text.len() {
                text.len()
            } else {
                byte
            },
        };
        self.reset_movement();
        false
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn is_dirty(&self) -> bool {
        self.text() != self.saved
    }

    pub fn mark_saved(&mut self) {
        self.saved = self.text();
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            lines: self.lines.clone(),
            cursor: self.cursor,
        }
    }

    fn record(&mut self, group: Option<Group>) {
        let now = Instant::now();
        let merge = group.is_some_and(|kind| {
            self.group.is_some_and(|(previous, time)| {
                previous == kind && now.duration_since(time) <= Duration::from_secs(1)
            })
        });
        if !merge {
            if self.undo.len() == UNDO_LIMIT {
                self.undo.remove(0);
            }
            self.undo.push(self.snapshot());
        }
        self.redo.clear();
        self.group = group.map(|kind| (kind, now));
        self.expected_column = None;
    }

    fn reset_movement(&mut self) {
        self.expected_column = None;
        self.group = None;
    }

    pub fn insert(&mut self, text: &str) -> bool {
        let text = normalize(text);
        if text.is_empty() {
            return false;
        }
        let single = text.graphemes(true).count() == 1 && !text.chars().any(char::is_whitespace);
        self.insert_normalized(&text, single.then_some(Group::Insert))
    }

    pub fn paste(&mut self, text: &str) -> bool {
        let text = normalize(text);
        if text.is_empty() {
            return false;
        }
        self.insert_normalized(&text, None)
    }

    fn insert_normalized(&mut self, text: &str, group: Option<Group>) -> bool {
        self.record(group);
        let line = self.cursor.line;
        let tail = self.lines[line].split_off(self.cursor.byte);
        let mut parts = text.split('\n');
        let first = parts.next().unwrap();
        self.lines[line].push_str(first);
        self.cursor.byte += first.len();
        for part in parts {
            self.cursor.line += 1;
            self.lines.insert(self.cursor.line, part.to_string());
            self.cursor.byte = part.len();
        }
        self.lines[self.cursor.line].push_str(&tail);
        true
    }

    pub fn tab(&mut self) -> bool {
        self.insert("  ")
    }

    pub fn newline(&mut self) -> bool {
        let line = self.cursor.line;
        let prefix = list_prefix(&self.lines[line]);
        if let Some((length, _)) = &prefix {
            if self.cursor.byte == self.lines[line].len()
                && self.lines[line][*length..].trim().is_empty()
            {
                self.record(None);
                self.lines[line].clear();
                self.cursor.byte = 0;
                return true;
            }
        }
        let continuation = prefix.map(|(_, marker)| marker).unwrap_or_default();
        self.record(None);
        let tail = self.lines[line].split_off(self.cursor.byte);
        self.cursor.line += 1;
        self.cursor.byte = continuation.len();
        self.lines
            .insert(self.cursor.line, format!("{continuation}{tail}"));
        true
    }

    pub fn backspace(&mut self) -> bool {
        if self.cursor.byte == 0 && self.cursor.line == 0 {
            return false;
        }
        self.record(Some(Group::Backspace));
        if self.cursor.byte == 0 {
            let tail = self.lines.remove(self.cursor.line);
            self.cursor.line -= 1;
            self.cursor.byte = self.lines[self.cursor.line].len();
            self.lines[self.cursor.line].push_str(&tail);
        } else {
            let start = previous_boundary(&self.lines[self.cursor.line], self.cursor.byte);
            self.lines[self.cursor.line].replace_range(start..self.cursor.byte, "");
            self.cursor.byte = start;
        }
        true
    }

    pub fn delete(&mut self) -> bool {
        if self.cursor.byte == self.lines[self.cursor.line].len()
            && self.cursor.line + 1 == self.lines.len()
        {
            return false;
        }
        self.record(Some(Group::Delete));
        let line = self.cursor.line;
        if self.cursor.byte == self.lines[line].len() {
            let tail = self.lines.remove(line + 1);
            self.lines[line].push_str(&tail);
        } else {
            let end = next_boundary(&self.lines[line], self.cursor.byte);
            self.lines[line].replace_range(self.cursor.byte..end, "");
        }
        true
    }

    pub fn delete_word_back(&mut self) -> bool {
        if self.cursor.byte == 0 && self.cursor.line == 0 {
            return false;
        }
        if self.cursor.byte == 0 {
            self.record(None);
            let tail = self.lines.remove(self.cursor.line);
            self.cursor.line -= 1;
            self.cursor.byte = self.lines[self.cursor.line].len();
            self.lines[self.cursor.line].push_str(&tail);
        } else {
            let start = word_start(&self.lines[self.cursor.line], self.cursor.byte);
            self.record(None);
            self.lines[self.cursor.line].replace_range(start..self.cursor.byte, "");
            self.cursor.byte = start;
        }
        true
    }

    pub fn delete_to_visual_start(&mut self, width: usize) -> bool {
        let (row, _) = self.cursor_visual(width);
        let start = self.layout(width)[row].start;
        if start == self.cursor.byte {
            return false;
        }
        self.record(None);
        self.lines[self.cursor.line].replace_range(start..self.cursor.byte, "");
        self.cursor.byte = start;
        true
    }

    pub fn delete_to_line_end(&mut self) -> bool {
        let line = self.cursor.line;
        if self.cursor.byte == self.lines[line].len() && line + 1 == self.lines.len() {
            return false;
        }
        self.record(None);
        if self.cursor.byte == self.lines[line].len() {
            let tail = self.lines.remove(line + 1);
            self.lines[line].push_str(&tail);
        } else {
            self.lines[line].truncate(self.cursor.byte);
        }
        true
    }

    pub fn move_left(&mut self) -> bool {
        if self.cursor.byte > 0 {
            self.cursor.byte = previous_boundary(&self.lines[self.cursor.line], self.cursor.byte);
        } else if self.cursor.line > 0 {
            self.cursor.line -= 1;
            self.cursor.byte = self.lines[self.cursor.line].len();
        }
        self.reset_movement();
        false
    }

    pub fn move_right(&mut self) -> bool {
        let line = &self.lines[self.cursor.line];
        if self.cursor.byte < line.len() {
            self.cursor.byte = next_boundary(line, self.cursor.byte);
        } else if self.cursor.line + 1 < self.lines.len() {
            self.cursor.line += 1;
            self.cursor.byte = 0;
        }
        self.reset_movement();
        false
    }

    pub fn move_word_left(&mut self) -> bool {
        if self.cursor.byte > 0 {
            self.cursor.byte = word_start(&self.lines[self.cursor.line], self.cursor.byte);
        } else if self.cursor.line > 0 {
            self.cursor.line -= 1;
            self.cursor.byte = self.lines[self.cursor.line].len();
        }
        self.reset_movement();
        false
    }

    pub fn move_word_right(&mut self) -> bool {
        let line = &self.lines[self.cursor.line];
        if self.cursor.byte < line.len() {
            self.cursor.byte = word_end(line, self.cursor.byte);
        } else if self.cursor.line + 1 < self.lines.len() {
            self.cursor.line += 1;
            self.cursor.byte = 0;
        }
        self.reset_movement();
        false
    }

    pub fn move_home(&mut self, width: usize) -> bool {
        let (row, _) = self.cursor_visual(width);
        self.cursor.byte = self.layout(width)[row].start;
        self.reset_movement();
        false
    }

    pub fn move_end(&mut self, width: usize) -> bool {
        let (row, _) = self.cursor_visual(width);
        self.cursor.byte = self.layout(width)[row].end;
        self.reset_movement();
        false
    }

    pub fn move_document_start(&mut self) -> bool {
        self.cursor = Cursor::default();
        self.reset_movement();
        false
    }

    pub fn move_document_end(&mut self) -> bool {
        self.cursor.line = self.lines.len() - 1;
        self.cursor.byte = self.lines[self.cursor.line].len();
        self.reset_movement();
        false
    }

    pub fn move_up(&mut self, width: usize) -> bool {
        self.move_vertical(width, -1)
    }

    pub fn move_down(&mut self, width: usize) -> bool {
        self.move_vertical(width, 1)
    }

    pub fn page_up(&mut self, width: usize, rows: usize) -> bool {
        self.move_vertical(width, -(rows.min(isize::MAX as usize) as isize))
    }

    pub fn page_down(&mut self, width: usize, rows: usize) -> bool {
        self.move_vertical(width, rows.min(isize::MAX as usize) as isize)
    }

    fn move_vertical(&mut self, width: usize, delta: isize) -> bool {
        let (row, column) = self.cursor_visual(width);
        let column = *self.expected_column.get_or_insert(column);
        let last = self.layout(width).len() - 1;
        let target = row.saturating_add_signed(delta).min(last);
        self.cursor = self.position_at(width, target, column);
        self.group = None;
        false
    }

    pub fn layout(&self, width: usize) -> Vec<VisualRow> {
        let width = width.max(1);
        let mut rows = Vec::new();
        for (line_index, line) in self.lines.iter().enumerate() {
            let graphemes: Vec<_> = line.grapheme_indices(true).collect();
            let mut start = 0;
            let mut column = 0;
            let mut columns = Vec::new();
            for (index, &(byte, grapheme)) in graphemes.iter().enumerate() {
                let size = width_for(grapheme);
                if ascii_word(grapheme)
                    && index > 0
                    && graphemes[index - 1].1.chars().all(char::is_whitespace)
                    && column > 0
                {
                    let word_width: usize = graphemes[index..]
                        .iter()
                        .take_while(|(_, part)| ascii_word(part))
                        .map(|(_, part)| width_for(part))
                        .sum();
                    if word_width <= width && column + word_width > width {
                        rows.push(VisualRow {
                            line: line_index,
                            start,
                            end: byte,
                            columns: std::mem::take(&mut columns),
                        });
                        start = byte;
                        column = 0;
                    }
                }
                if column > 0 && column + size > width {
                    rows.push(VisualRow {
                        line: line_index,
                        start,
                        end: byte,
                        columns: std::mem::take(&mut columns),
                    });
                    start = byte;
                    column = 0;
                }
                columns.push(GraphemeColumn { byte, column });
                column += size;
            }
            rows.push(VisualRow {
                line: line_index,
                start,
                end: line.len(),
                columns,
            });
        }
        rows
    }

    pub fn cursor_visual(&self, width: usize) -> (usize, usize) {
        let rows = self.layout(width);
        let row_index = rows
            .iter()
            .enumerate()
            .rev()
            .find(|(_, row)| {
                row.line == self.cursor.line
                    && row.start <= self.cursor.byte
                    && self.cursor.byte <= row.end
            })
            .map(|(index, _)| index)
            .unwrap_or(0);
        let row = &rows[row_index];
        let column = row
            .columns
            .iter()
            .find(|item| item.byte == self.cursor.byte)
            .map(|item| item.column)
            .unwrap_or_else(|| {
                row.columns
                    .iter()
                    .map(|item| {
                        width_for(
                            &self.lines[row.line]
                                [item.byte..next_boundary(&self.lines[row.line], item.byte)],
                        )
                    })
                    .sum()
            });
        (row_index, column)
    }

    pub fn position_at(&self, width: usize, visual_row: usize, column: usize) -> Cursor {
        let rows = self.layout(width);
        let row = &rows[visual_row.min(rows.len() - 1)];
        let byte = row
            .columns
            .iter()
            .rev()
            .find(|item| item.column <= column)
            .map(|item| item.byte)
            .unwrap_or(row.start);
        let end_column: usize = row
            .columns
            .iter()
            .map(|item| {
                width_for(
                    &self.lines[row.line]
                        [item.byte..next_boundary(&self.lines[row.line], item.byte)],
                )
            })
            .sum();
        Cursor {
            line: row.line,
            byte: if column >= end_column { row.end } else { byte },
        }
    }

    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        self.redo.push(self.snapshot());
        self.lines = previous.lines;
        self.cursor = previous.cursor;
        self.reset_movement();
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.undo.push(self.snapshot());
        self.lines = next.lines;
        self.cursor = next.cursor;
        self.reset_movement();
        true
    }
}

fn width_for(grapheme: &str) -> usize {
    width(grapheme)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text<'a>(editor: &'a Editor, row: &VisualRow) -> &'a str {
        &editor.lines[row.line][row.start..row.end]
    }

    #[test]
    fn wraps_mixed_graphemes_and_keeps_ascii_words() {
        let editor = Editor::new("中A😀e\u{301} 文\t字");
        let rows = editor.layout(5);
        assert_eq!(
            rows.iter()
                .map(|row| row_text(&editor, row))
                .collect::<Vec<_>>(),
            ["中A😀", "e\u{301} 文", "\t", "字"]
        );
        assert_eq!(
            rows[0]
                .columns
                .iter()
                .map(|item| item.column)
                .collect::<Vec<_>>(),
            [0, 2, 3]
        );

        let editor = Editor::new("hi world abcdefgh");
        let rows = editor.layout(6);
        assert_eq!(
            rows.iter()
                .map(|row| row_text(&editor, row))
                .collect::<Vec<_>>(),
            ["hi ", "world ", "abcdef", "gh"]
        );
        assert_eq!(Editor::new("\n").layout(4).len(), 2);
        assert_eq!(Editor::new("\u{301}").layout(1).len(), 1);
    }

    #[test]
    fn visual_motion_keeps_requested_column_and_clicks_left_of_wide_char() {
        let mut editor = Editor::new("abcdef\n中x\nabcdef");
        editor.set_cursor(Cursor { line: 0, byte: 5 });
        editor.move_down(6);
        assert_eq!(editor.cursor(), Cursor { line: 1, byte: 4 });
        editor.move_down(6);
        assert_eq!(editor.cursor(), Cursor { line: 2, byte: 5 });
        assert_eq!(editor.position_at(6, 1, 1), Cursor { line: 1, byte: 0 });
        editor.move_up(6);
        editor.move_left();
        editor.move_down(6);
        assert_eq!(editor.cursor(), Cursor { line: 2, byte: 2 });

        let mut wrapped = Editor::new("abcdefghij");
        wrapped.set_cursor(Cursor { line: 0, byte: 3 });
        wrapped.move_down(4);
        assert_eq!(wrapped.cursor(), Cursor { line: 0, byte: 7 });
        wrapped.move_down(4);
        assert_eq!(wrapped.cursor(), Cursor { line: 0, byte: 10 });
        wrapped.move_up(4);
        assert_eq!(wrapped.cursor(), Cursor { line: 0, byte: 7 });
    }

    #[test]
    fn edit_graphemes_lines_and_words() {
        let mut editor = Editor::new("a😀e\u{301}\n中ab  ");
        editor.set_cursor(Cursor {
            line: 0,
            byte: "a😀e\u{301}".len(),
        });
        assert!(editor.backspace());
        assert_eq!(editor.text(), "a😀\n中ab  ");
        assert!(editor.delete());
        assert_eq!(editor.text(), "a😀中ab  ");
        editor.move_document_end();
        assert!(editor.delete_word_back());
        assert_eq!(editor.text(), "a😀中ab");
        assert!(editor.delete_word_back());
        assert_eq!(editor.text(), "a😀中");
        assert!(editor.delete_word_back());
        assert_eq!(editor.text(), "a😀");
        editor.set_cursor(Cursor { line: 0, byte: 1 });
        assert!(editor.delete_to_line_end());
        assert_eq!(editor.text(), "a");

        let mut editor = Editor::new("abcd\nef");
        editor.set_cursor(Cursor { line: 0, byte: 3 });
        assert!(editor.delete_to_visual_start(2));
        assert_eq!(editor.text(), "abd\nef");
        editor.move_document_end();
        assert!(editor.backspace());
        assert!(editor.backspace());
        assert!(editor.backspace());
        assert_eq!(editor.text(), "abd");

        let mut editor = Editor::new("ab\ncd");
        editor.set_cursor(Cursor { line: 0, byte: 2 });
        assert!(editor.delete_to_line_end());
        assert_eq!(editor.text(), "abcd");
        editor.set_cursor(Cursor { line: 0, byte: 2 });
        editor.move_word_right();
        assert_eq!(editor.cursor().byte, 4);
        editor.move_word_left();
        assert_eq!(editor.cursor().byte, 0);
    }

    #[test]
    fn list_continuation_and_empty_item() {
        for (source, continuation) in [
            ("- item", "- "),
            ("* item", "* "),
            ("+ item", "+ "),
            ("- [ ] item", "- [ ] "),
            ("- [x] item", "- [ ] "),
            ("- [X] item", "- [ ] "),
            ("9. item", "10. "),
            ("> item", "> "),
            ("  - item", "  - "),
        ] {
            let mut editor = Editor::new(source);
            editor.move_document_end();
            assert!(editor.newline(), "{source}");
            assert_eq!(editor.lines()[1], continuation, "{source}");
        }
        for source in ["- ", "* ", "+ ", "- [x] ", "2. ", "> ", "  - "] {
            let mut editor = Editor::new(source);
            editor.move_document_end();
            assert!(editor.newline(), "{source}");
            assert_eq!(editor.text(), "", "{source}");
        }
    }

    #[test]
    fn undo_groups_typing_and_deletion_but_not_whitespace_or_paste() {
        let mut editor = Editor::new("");
        for letter in ["a", "b", "c"] {
            editor.insert(letter);
        }
        assert!(editor.undo());
        assert_eq!(editor.text(), "");
        assert!(editor.redo());
        assert_eq!(editor.text(), "abc");
        editor.insert(" ");
        editor.insert("d");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc ");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc");

        editor.paste("Z");
        editor.insert("q");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abcZ");
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc");
        editor.insert("XY");
        assert_eq!(editor.text(), "abcXY");
        assert!(!editor.redo());
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc");
        editor.backspace();
        editor.backspace();
        assert!(editor.undo());
        assert_eq!(editor.text(), "abc");
    }

    #[test]
    fn normalizes_line_endings_and_tracks_saved_text() {
        let mut editor = Editor::new("a\r\nb\rc\n");
        assert_eq!(editor.text(), "a\nb\nc\n");
        assert!(!editor.is_dirty());
        editor.move_document_end();
        editor.insert("z\r\nq\r");
        assert_eq!(editor.text(), "a\nb\nc\nz\nq\n");
        assert!(editor.is_dirty());
        editor.mark_saved();
        assert!(!editor.is_dirty());
    }
}
