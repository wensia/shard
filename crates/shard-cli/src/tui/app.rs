//! 搜索与编辑的状态机。资料库 I/O 仅通过注入的 Store 发生。

use std::{path::PathBuf, time::Instant};

use ratatui::{
    crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind},
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};
use shard_core::search::SearchTextPart;
use unicode_segmentation::UnicodeSegmentation;

use super::{editor::Editor, editor_view, search_view, terminal::Event};
use crate::find::{self, FragmentEntry};

pub const SEARCH_LIMIT: usize = 200;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SaveReport;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveError {
    Conflict { draft_path: PathBuf },
    Locked,
    Invalid(String),
}

pub trait Store {
    fn open(&mut self, entry: &FragmentEntry) -> Result<String, String> {
        Ok(entry.body.clone())
    }
    fn save(&mut self, id: &str, body: &str) -> Result<SaveReport, SaveError>;
    fn reload(&mut self) -> Result<Vec<FragmentEntry>, String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    None,
    Quit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Page {
    Search,
    Edit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pending {
    Return,
    Quit,
}

pub struct App {
    pub query: String,
    pub query_cursor: usize,
    pub entries: Vec<FragmentEntry>,
    pub hits: Vec<usize>,
    pub previews: Vec<Vec<SearchTextPart>>,
    pub selected: usize,
    pub search_offset: usize,
    pub search_error: Option<String>,
    pub page: Page,
    pub editor: Option<Editor>,
    pub editing: Option<usize>,
    pub editor_scroll: usize,
    pub error: Option<String>,
    pub draft_paths: Vec<PathBuf>,
    pub saved_at: Option<Instant>,
    pub pending: Option<Pending>,
    pub size: (u16, u16),
    store: Box<dyn Store>,
}

impl App {
    pub fn new(entries: Vec<FragmentEntry>, store: Box<dyn Store>) -> Self {
        let mut app = Self {
            query: String::new(),
            query_cursor: 0,
            entries,
            hits: Vec::new(),
            previews: Vec::new(),
            selected: 0,
            search_offset: 0,
            search_error: None,
            page: Page::Search,
            editor: None,
            editing: None,
            editor_scroll: 0,
            error: None,
            draft_paths: Vec::new(),
            saved_at: None,
            pending: None,
            size: (80, 24),
            store,
        };
        app.refresh_search(None);
        app
    }

    pub fn render(&self, frame: &mut Frame) {
        let area = frame.area();
        if area.width < 40 || area.height < 10 {
            frame.render_widget(Paragraph::new("窗口太小"), area);
            return;
        }
        match self.page {
            Page::Search => search_view::render(frame, self, area),
            Page::Edit => editor_view::render(frame, self, area),
        }
        if self.pending.is_some() {
            let width = 38.min(area.width.saturating_sub(2));
            let dialog = Rect::new(
                area.x + (area.width - width) / 2,
                area.y + area.height / 2 - 2,
                width,
                4,
            );
            frame.render_widget(Clear, dialog);
            frame.render_widget(
                Paragraph::new("保存修改？\nEnter/S 保存  D 不保存  Esc 取消")
                    .style(Style::default().fg(Color::Yellow))
                    .block(Block::default().borders(Borders::ALL)),
                dialog,
            );
        }
    }

    pub fn handle(&mut self, event: Event) -> Action {
        match event {
            Event::Resize(width, height) => {
                self.size = (width, height);
                self.ensure_editor_visible();
                Action::None
            }
            Event::Paste(text) => {
                self.error = None;
                if self.pending.is_none() {
                    match self.page {
                        Page::Search => self.query_insert(&text),
                        Page::Edit => {
                            if let Some(editor) = &mut self.editor {
                                editor.paste(&text);
                            }
                            self.ensure_editor_visible();
                        }
                    }
                }
                Action::None
            }
            Event::Mouse(mouse) => self.handle_mouse(mouse),
            Event::Key(key) => {
                self.error = None;
                if self.pending.is_some() {
                    return self.handle_confirmation(key);
                }
                if ctrl(&key, 'c') || (self.page == Page::Edit && ctrl(&key, 'q')) {
                    return self.request_exit(Pending::Quit);
                }
                match self.page {
                    Page::Search => self.handle_search_key(key),
                    Page::Edit => self.handle_edit_key(key),
                }
            }
        }
    }

    fn refresh_search(&mut self, selected_id: Option<&str>) {
        match find::search(&self.entries, &self.query, SEARCH_LIMIT) {
            Ok(outcome) => {
                self.hits = outcome
                    .hits
                    .iter()
                    .filter_map(|hit| {
                        self.entries
                            .iter()
                            .position(|entry| entry.id == hit.entry.id)
                    })
                    .collect();
                self.previews = outcome.hits.iter().map(|hit| hit.preview.clone()).collect();
                self.search_error = None;
                self.selected = selected_id
                    .and_then(|id| {
                        self.hits
                            .iter()
                            .position(|&index| self.entries[index].id == id)
                    })
                    .unwrap_or(0);
                self.search_offset = 0;
            }
            Err(error) => {
                self.hits.clear();
                self.previews.clear();
                self.selected = 0;
                self.search_error = Some(error);
            }
        }
    }

    fn query_insert(&mut self, text: &str) {
        let text = text.replace("\r\n", " ").replace(['\r', '\n'], " ");
        self.query.insert_str(self.query_cursor, &text);
        self.query_cursor += text.len();
        self.refresh_search(None);
    }

    fn handle_search_key(&mut self, key: KeyEvent) -> Action {
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => {
                if self.query.is_empty() {
                    Action::Quit
                } else {
                    self.query.clear();
                    self.query_cursor = 0;
                    self.refresh_search(None);
                    Action::None
                }
            }
            KeyCode::Enter => {
                self.open_selected();
                Action::None
            }
            KeyCode::Up | KeyCode::Char('p') if key.code == KeyCode::Up || control => {
                self.select_relative(-1);
                Action::None
            }
            KeyCode::Down | KeyCode::Char('n') if key.code == KeyCode::Down || control => {
                self.select_relative(1);
                Action::None
            }
            KeyCode::PageUp => {
                self.select_relative(-(self.result_height() as isize));
                Action::None
            }
            KeyCode::PageDown => {
                self.select_relative(self.result_height() as isize);
                Action::None
            }
            KeyCode::Left => {
                self.query_cursor = previous(&self.query, self.query_cursor);
                Action::None
            }
            KeyCode::Right => {
                self.query_cursor = next(&self.query, self.query_cursor);
                Action::None
            }
            KeyCode::Backspace => {
                if self.query_cursor > 0 {
                    let start = previous(&self.query, self.query_cursor);
                    self.query.replace_range(start..self.query_cursor, "");
                    self.query_cursor = start;
                    self.refresh_search(None);
                }
                Action::None
            }
            KeyCode::Char('u') if control => {
                self.query.clear();
                self.query_cursor = 0;
                self.refresh_search(None);
                Action::None
            }
            KeyCode::Char(ch) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.query_insert(&ch.to_string());
                Action::None
            }
            _ => Action::None,
        }
    }

    fn select_relative(&mut self, delta: isize) {
        if self.hits.is_empty() {
            return;
        }
        self.selected = self
            .selected
            .saturating_add_signed(delta)
            .min(self.hits.len() - 1);
        let height = self.result_height().max(1);
        if self.selected < self.search_offset {
            self.search_offset = self.selected;
        }
        if self.selected >= self.search_offset + height {
            self.search_offset = self.selected + 1 - height;
        }
    }

    fn result_height(&self) -> usize {
        search_view::layout(Rect::new(0, 0, self.size.0, self.size.1))
            .results
            .height as usize
    }

    pub fn open_id(&mut self, id: &str) {
        if let Some(index) = self.entries.iter().position(|entry| entry.id == id) {
            self.open_index(index);
        }
    }

    fn open_selected(&mut self) {
        let Some(&index) = self.hits.get(self.selected) else {
            return;
        };
        self.open_index(index);
    }

    fn open_index(&mut self, index: usize) {
        let body = match self.store.open(&self.entries[index]) {
            Ok(body) => body,
            Err(error) => {
                self.search_error = Some(error);
                return;
            }
        };
        self.editor = Some(Editor::new(&body));
        self.editing = Some(index);
        self.editor_scroll = 0;
        self.saved_at = None;
        self.page = Page::Edit;
    }

    fn handle_edit_key(&mut self, key: KeyEvent) -> Action {
        let width = self.editor_width();
        let height = self.editor_height();
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        if ctrl(&key, 's') {
            self.save();
            return Action::None;
        }
        if ctrl(&key, 'z') && key.modifiers.contains(KeyModifiers::SHIFT) {
            if let Some(editor) = &mut self.editor {
                editor.redo();
            }
            self.ensure_editor_visible();
            return Action::None;
        }
        if key.code == KeyCode::Esc {
            return self.request_exit(Pending::Return);
        }
        let Some(editor) = &mut self.editor else {
            return Action::None;
        };
        match key.code {
            KeyCode::Left if alt => {
                editor.move_word_left();
            }
            KeyCode::Right if alt => {
                editor.move_word_right();
            }
            KeyCode::Backspace if alt => {
                editor.delete_word_back();
            }
            KeyCode::Char('b') if alt => {
                editor.move_word_left();
            }
            KeyCode::Char('f') if alt => {
                editor.move_word_right();
            }
            KeyCode::Left => {
                editor.move_left();
            }
            KeyCode::Right => {
                editor.move_right();
            }
            KeyCode::Up => {
                editor.move_up(width);
            }
            KeyCode::Down => {
                editor.move_down(width);
            }
            KeyCode::Home if control => {
                editor.move_document_start();
            }
            KeyCode::End if control => {
                editor.move_document_end();
            }
            KeyCode::Home => {
                editor.move_home(width);
            }
            KeyCode::End => {
                editor.move_end(width);
            }
            KeyCode::PageUp => {
                editor.page_up(width, height);
            }
            KeyCode::PageDown => {
                editor.page_down(width, height);
            }
            KeyCode::Backspace => {
                editor.backspace();
            }
            KeyCode::Delete => {
                editor.delete();
            }
            KeyCode::Enter => {
                editor.newline();
            }
            KeyCode::Tab => {
                editor.tab();
            }
            KeyCode::Char('a') if control => {
                editor.move_home(width);
            }
            KeyCode::Char('e') if control => {
                editor.move_end(width);
            }
            KeyCode::Char('u') if control => {
                editor.delete_to_visual_start(width);
            }
            KeyCode::Char('k') if control => {
                editor.delete_to_line_end();
            }
            KeyCode::Char(ch) if control && ch.eq_ignore_ascii_case(&'z') => {
                editor.undo();
            }
            KeyCode::Char('y') if control => {
                editor.redo();
            }
            KeyCode::Char(ch) if !control && !alt => {
                editor.insert(&ch.to_string());
            }
            _ => {}
        }
        self.saved_at = None;
        self.ensure_editor_visible();
        Action::None
    }

    fn save(&mut self) -> bool {
        let (Some(index), Some(editor)) = (self.editing, &mut self.editor) else {
            return false;
        };
        let id = self.entries[index].id.clone();
        let body = editor.text();
        match self.store.save(&id, &body) {
            Ok(_) => {
                editor.mark_saved();
                self.entries[index].body = body;
                self.saved_at = Some(Instant::now());
                let selected_id = id;
                match self.store.reload() {
                    Ok(entries) => {
                        self.entries = entries;
                        self.editing = self
                            .entries
                            .iter()
                            .position(|entry| entry.id == selected_id);
                        self.refresh_search(Some(&selected_id));
                    }
                    Err(error) => {
                        self.error = Some(error);
                    }
                }
                true
            }
            Err(SaveError::Conflict { draft_path }) => {
                self.error = Some(format!(
                    "这条碎片已被其他地方修改，没有覆盖；你的内容已另存到\n{}",
                    draft_path.display()
                ));
                self.draft_paths.push(draft_path);
                false
            }
            Err(SaveError::Locked) => {
                self.error = Some("资料库已锁定，请稍后重试".into());
                false
            }
            Err(SaveError::Invalid(message)) => {
                self.error = Some(message);
                false
            }
        }
    }

    fn request_exit(&mut self, pending: Pending) -> Action {
        if self.editor.as_ref().is_some_and(Editor::is_dirty) {
            self.pending = Some(pending);
            Action::None
        } else {
            self.finish_exit(pending)
        }
    }

    fn finish_exit(&mut self, pending: Pending) -> Action {
        self.pending = None;
        match pending {
            Pending::Quit => Action::Quit,
            Pending::Return => {
                self.editor = None;
                self.editing = None;
                self.page = Page::Search;
                Action::None
            }
        }
    }

    fn handle_confirmation(&mut self, key: KeyEvent) -> Action {
        let pending = self.pending.expect("确认框有退出目标");
        if ctrl(&key, 'c') {
            self.pending = Some(Pending::Quit);
            return Action::None;
        }
        match key.code {
            KeyCode::Esc => {
                self.pending = None;
                Action::None
            }
            KeyCode::Enter | KeyCode::Char('s' | 'S') => {
                if self.save() {
                    self.finish_exit(pending)
                } else {
                    self.pending = None;
                    Action::None
                }
            }
            KeyCode::Char('d' | 'D') => self.finish_exit(pending),
            _ => Action::None,
        }
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) -> Action {
        if self.pending.is_some() {
            return Action::None;
        }
        let area = Rect::new(0, 0, self.size.0, self.size.1);
        match mouse.kind {
            MouseEventKind::ScrollUp => match self.page {
                Page::Search => self.select_relative(-3),
                Page::Edit => self.editor_scroll = self.editor_scroll.saturating_sub(3),
            },
            MouseEventKind::ScrollDown => match self.page {
                Page::Search => self.select_relative(3),
                Page::Edit => {
                    let max = self
                        .editor
                        .as_ref()
                        .map(|editor| {
                            editor
                                .layout(self.editor_width())
                                .len()
                                .saturating_sub(self.editor_height())
                        })
                        .unwrap_or(0);
                    self.editor_scroll = (self.editor_scroll + 3).min(max);
                }
            },
            MouseEventKind::Down(MouseButton::Left) => match self.page {
                Page::Search => {
                    let layout = search_view::layout(area);
                    if contains(layout.results, mouse.column, mouse.row) {
                        let index = self.search_offset + (mouse.row - layout.results.y) as usize;
                        if index < self.hits.len() {
                            self.selected = index;
                        }
                    }
                }
                Page::Edit => {
                    let body = editor_view::layout(area, self.error.as_deref()).body;
                    if contains(body, mouse.column, mouse.row) {
                        if let Some(editor) = &mut self.editor {
                            let row = self.editor_scroll + (mouse.row - body.y) as usize;
                            let position = editor.position_at(
                                body.width as usize,
                                row,
                                (mouse.column - body.x) as usize,
                            );
                            editor.set_cursor(position);
                        }
                    }
                }
            },
            _ => {}
        }
        Action::None
    }

    fn editor_width(&self) -> usize {
        editor_view::layout(
            Rect::new(0, 0, self.size.0, self.size.1),
            self.error.as_deref(),
        )
        .body
        .width
        .max(1) as usize
    }
    fn editor_height(&self) -> usize {
        editor_view::layout(
            Rect::new(0, 0, self.size.0, self.size.1),
            self.error.as_deref(),
        )
        .body
        .height
        .max(1) as usize
    }

    fn ensure_editor_visible(&mut self) {
        let Some(editor) = &self.editor else {
            return;
        };
        let (row, _) = editor.cursor_visual(self.editor_width());
        let height = self.editor_height();
        if row < self.editor_scroll {
            self.editor_scroll = row;
        }
        if row >= self.editor_scroll + height {
            self.editor_scroll = row + 1 - height;
        }
    }
}

fn ctrl(key: &KeyEvent, ch: char) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char(value) if value.eq_ignore_ascii_case(&ch))
}

fn previous(text: &str, byte: usize) -> usize {
    text[..byte]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn next(text: &str, byte: usize) -> usize {
    text[byte..]
        .graphemes(true)
        .next()
        .map(|part| byte + part.len())
        .unwrap_or(byte)
}

fn contains(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && x < area.right() && y >= area.y && y < area.bottom()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use std::{cell::RefCell, rc::Rc};
    use unicode_width::UnicodeWidthStr;

    #[derive(Default)]
    struct FakeState {
        saves: Vec<(String, String)>,
        result: Option<SaveError>,
        entries: Vec<FragmentEntry>,
    }

    struct FakeStore(Rc<RefCell<FakeState>>);

    impl Store for FakeStore {
        fn save(&mut self, id: &str, body: &str) -> Result<SaveReport, SaveError> {
            let mut state = self.0.borrow_mut();
            state.saves.push((id.into(), body.into()));
            if let Some(error) = &state.result {
                return Err(error.clone());
            }
            if let Some(entry) = state.entries.iter_mut().find(|entry| entry.id == id) {
                entry.body = body.into();
            }
            Ok(SaveReport)
        }

        fn reload(&mut self) -> Result<Vec<FragmentEntry>, String> {
            Ok(self.0.borrow().entries.clone())
        }
    }

    fn entry(id: &str, body: &str) -> FragmentEntry {
        FragmentEntry {
            id: id.into(),
            title: body.lines().next().unwrap_or("").into(),
            created_at: "2026-09-29T00:00:00+08:00".into(),
            kind: None,
            tags: vec!["inbox".into()],
            modified_at: 1,
            body: body.into(),
            path: std::env::temp_dir().join(format!("{id}.md")),
        }
    }

    fn app(entries: Vec<FragmentEntry>) -> (App, Rc<RefCell<FakeState>>) {
        let state = Rc::new(RefCell::new(FakeState {
            entries: entries.clone(),
            ..Default::default()
        }));
        (App::new(entries, Box::new(FakeStore(state.clone()))), state)
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    fn press(app: &mut App, code: KeyCode) -> Action {
        app.handle(key(code, KeyModifiers::NONE))
    }

    fn ctrl_key(app: &mut App, ch: char) -> Action {
        app.handle(key(KeyCode::Char(ch), KeyModifiers::CONTROL))
    }

    fn screen(app: &App, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                let mut line = String::new();
                let mut x = 0;
                while x < width {
                    let symbol = buffer[(x, y)].symbol();
                    line.push_str(symbol);
                    x += UnicodeWidthStr::width(symbol).max(1) as u16;
                }
                line
            })
            .collect::<Vec<_>>()
    }

    #[test]
    fn search_filters_and_opens_selected_editor() {
        let (mut app, _) = app(vec![
            entry("20260929-000000-aaaabbbb-cccccc", "买咖啡"),
            entry("other", "明天跑步"),
        ]);
        app.handle(Event::Paste("咖啡".into()));
        assert_eq!(app.hits.len(), 1);
        assert!(screen(&app, 80, 20)[1].contains("aaaabbbb"));
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.page, Page::Edit);
        assert!(screen(&app, 80, 20)[0].contains("编辑 aaaabbbb · 买咖啡 · #inbox"));
    }

    #[test]
    fn search_preview_wraps_chinese_after_tag_on_first_row() {
        let body = format!("#生活 今天去咖啡店{}", "喝咖啡聊天".repeat(8));
        let (app, _) = app(vec![entry("one", &body)]);
        let rows = screen(&app, 40, 12);
        let preview_y = search_view::layout(Rect::new(0, 0, 40, 12)).preview.y as usize;
        assert!(rows[preview_y].starts_with("#生活 今天"));
        assert_eq!(rows[preview_y].trim_end().width(), 40);
    }

    #[test]
    fn save_marks_editor_clean_and_discard_returns_without_save() {
        let (mut app, state) = app(vec![entry("one", "原文")]);
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('新'));
        assert!(screen(&app, 80, 20)[0].contains("● 未保存"));
        ctrl_key(&mut app, 's');
        assert_eq!(state.borrow().saves.len(), 1);
        assert!(!app.editor.as_ref().unwrap().is_dirty());
        assert!(screen(&app, 80, 20)[0].contains("已保存"));
        press(&mut app, KeyCode::Char('又'));
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.pending, Some(Pending::Return));
        assert!(screen(&app, 80, 20).join("\n").contains("保存修改？"));
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(app.page, Page::Search);
        assert_eq!(state.borrow().saves.len(), 1);
    }

    #[test]
    fn conflict_and_lock_keep_unsaved_text() {
        let (mut app, state) = app(vec![entry("one", "原文")]);
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('新'));
        state.borrow_mut().result = Some(SaveError::Conflict {
            draft_path: std::env::temp_dir().join("draft.md"),
        });
        ctrl_key(&mut app, 's');
        assert!(app
            .error
            .as_ref()
            .unwrap()
            .contains("这条碎片已被其他地方修改，没有覆盖；你的内容已另存到"));
        assert!(app.editor.as_ref().unwrap().is_dirty());
        state.borrow_mut().result = Some(SaveError::Locked);
        ctrl_key(&mut app, 's');
        assert!(screen(&app, 80, 20).join("\n").contains("资料库已锁定"));
        assert!(app.editor.as_ref().unwrap().is_dirty());
    }

    #[test]
    fn conflict_path_is_visible_in_narrow_window_and_returned_on_quit() {
        let (mut app, state) = app(vec![entry("one", "原文")]);
        let path = std::env::temp_dir()
            .join("var/folders/long-session-path/T/shard-conflict-draft-1234567890.md");
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('新'));
        state.borrow_mut().result = Some(SaveError::Conflict {
            draft_path: path.clone(),
        });
        ctrl_key(&mut app, 's');
        let rows = screen(&app, 60, 16);
        let error_area = editor_view::layout(Rect::new(0, 0, 60, 16), app.error.as_deref()).error;
        let visible_path = rows[error_area.y as usize..error_area.bottom() as usize]
            .iter()
            .map(|row| row.trim_end())
            .collect::<String>();
        assert!(visible_path.contains(path.to_str().unwrap()));
        assert_eq!(ctrl_key(&mut app, 'q'), Action::None);
        assert_eq!(press(&mut app, KeyCode::Char('d')), Action::Quit);
        assert_eq!(app.draft_paths, vec![path]);
    }

    #[test]
    fn failed_confirmation_save_closes_dialog_and_shows_error() {
        for failure in [
            SaveError::Conflict {
                draft_path: std::env::temp_dir().join("draft.md"),
            },
            SaveError::Locked,
            SaveError::Invalid("内容为空，未保存".into()),
        ] {
            let (mut app, state) = app(vec![entry("one", "原文")]);
            press(&mut app, KeyCode::Enter);
            press(&mut app, KeyCode::Char('新'));
            let draft = app.editor.as_ref().unwrap().text();
            state.borrow_mut().result = Some(failure.clone());
            press(&mut app, KeyCode::Esc);
            press(&mut app, KeyCode::Enter);
            assert_eq!(app.pending, None);
            assert_eq!(app.page, Page::Edit);
            assert_eq!(app.editor.as_ref().unwrap().text(), draft);
            assert!(app.editor.as_ref().unwrap().is_dirty());
            let display = screen(&app, 80, 20).join("\n");
            assert!(!display.contains("保存修改？"));
            assert!(display.contains(match failure {
                SaveError::Conflict { .. } => "这条碎片已被其他地方修改",
                SaveError::Locked => "资料库已锁定",
                SaveError::Invalid(_) => "内容为空，未保存",
            }));
        }
    }

    #[test]
    fn small_window_and_chinese_wrap() {
        let (mut app, _) = app(vec![entry("one", "中文段落".repeat(12).as_str())]);
        assert!(screen(&app, 39, 9)[0].contains("窗口太小"));
        press(&mut app, KeyCode::Enter);
        let lines = screen(&app, 40, 12);
        assert!(lines[1].contains(&"中文段落".repeat(5)));
        assert!(lines[2].contains(&"中文段落".repeat(5)));
    }

    #[test]
    fn redo_shortcut_and_mouse_position_use_visual_rows() {
        let (mut app, _) = app(vec![entry("one", "中文第一行\n第二行")]);
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Char('新'));
        ctrl_key(&mut app, 'z');
        assert_eq!(app.editor.as_ref().unwrap().text(), "中文第一行\n第二行");
        app.handle(key(
            KeyCode::Char('Z'),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        ));
        assert_eq!(app.editor.as_ref().unwrap().text(), "新中文第一行\n第二行");
        app.handle(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 2,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(app.editor.as_ref().unwrap().cursor().line, 1);
        assert_eq!(app.editor.as_ref().unwrap().cursor().byte, 3);
    }
}
