//! 编辑页只读绘制；视觉行与光标坐标由编辑器内核提供。

use std::time::Duration;

use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::Paragraph,
    Frame,
};
use unicode_segmentation::UnicodeSegmentation;

use super::app::App;
use crate::find;

#[derive(Clone, Copy, Debug)]
pub struct EditorLayout {
    pub header: Rect,
    pub body: Rect,
    pub error: Rect,
    pub footer: Rect,
}

pub fn layout(area: Rect) -> EditorLayout {
    EditorLayout {
        header: Rect::new(area.x, area.y, area.width, 1),
        body: Rect::new(
            area.x,
            area.y.saturating_add(1),
            area.width,
            area.height.saturating_sub(3),
        ),
        error: Rect::new(area.x, area.bottom().saturating_sub(2), area.width, 1),
        footer: Rect::new(area.x, area.bottom().saturating_sub(1), area.width, 1),
    }
}

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let (Some(editor), Some(index)) = (&app.editor, app.editing) else {
        return;
    };
    let Some(entry) = app.entries.get(index) else {
        return;
    };
    let regions = layout(area);
    let status = if editor.is_dirty() {
        "● 未保存"
    } else if app
        .saved_at
        .is_some_and(|time| time.elapsed() < Duration::from_secs(2))
    {
        "已保存"
    } else {
        ""
    };
    let title = format!(
        "编辑 {} · {}{}",
        find::short_id(&entry.id),
        entry.title,
        entry
            .tags
            .iter()
            .map(|tag| format!(" · #{tag}"))
            .collect::<String>()
    );
    let status_width = if status.is_empty() {
        0
    } else {
        10.min(area.width)
    };
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(Color::Cyan)),
        Rect::new(
            regions.header.x,
            regions.header.y,
            regions.header.width.saturating_sub(status_width),
            1,
        ),
    );
    if status_width > 0 {
        frame.render_widget(
            Paragraph::new(status).style(Style::default().fg(if editor.is_dirty() {
                Color::Yellow
            } else {
                Color::Green
            })),
            Rect::new(
                regions.header.right() - status_width,
                regions.header.y,
                status_width,
                1,
            ),
        );
    }

    let width = regions.body.width.max(1) as usize;
    let rows = editor.layout(width);
    let visible = rows
        .iter()
        .skip(app.editor_scroll)
        .take(regions.body.height as usize)
        .map(|row| {
            editor.lines()[row.line][row.start..row.end]
                .graphemes(true)
                .map(|part| if part == "\t" { "    " } else { part })
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(visible.join("\n")), regions.body);

    if app.pending.is_none() {
        let (row, column) = editor.cursor_visual(width);
        if row >= app.editor_scroll && row < app.editor_scroll + regions.body.height as usize {
            let x = regions
                .body
                .x
                .saturating_add(column as u16)
                .min(regions.body.right().saturating_sub(1));
            let y = regions.body.y + (row - app.editor_scroll) as u16;
            frame.set_cursor_position((x, y));
        }
    }
    if let Some(error) = &app.error {
        frame.render_widget(
            Paragraph::new(error.as_str()).style(Style::default().fg(Color::Red)),
            regions.error,
        );
    }
    frame.render_widget(
        Paragraph::new("Ctrl+S 保存  Esc 返回  Ctrl+Z 撤销  Ctrl+Y 重做  Ctrl+Q 退出")
            .style(Style::default().fg(Color::DarkGray)),
        regions.footer,
    );
}
