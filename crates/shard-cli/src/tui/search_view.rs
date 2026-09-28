//! 搜索页的只读布局与绘制。输入、选择和滚动由 `App` 管理。

use chrono::{DateTime, Datelike, Local};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use shard_core::search::SearchTextPart;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::{
    find,
    tui::{app::App, editor_view},
};

#[derive(Debug, Clone, Copy)]
pub struct SearchLayout {
    pub query: Rect,
    pub results: Rect,
    pub preview: Rect,
    pub footer: Rect,
}

pub fn layout(area: Rect) -> SearchLayout {
    let preview_height = (area.height * 2 / 5).min(area.height.saturating_sub(3));
    let results_height = area.height.saturating_sub(preview_height + 2);
    SearchLayout {
        query: Rect::new(area.x, area.y, area.width, 1),
        results: Rect::new(area.x, area.y.saturating_add(1), area.width, results_height),
        preview: Rect::new(
            area.x,
            area.y.saturating_add(1 + results_height),
            area.width,
            preview_height,
        ),
        footer: Rect::new(
            area.x,
            area.y.saturating_add(area.height.saturating_sub(1)),
            area.width,
            1,
        ),
    }
}

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    if area.width < 40 || area.height < 10 {
        frame.render_widget(Paragraph::new("窗口太小"), area);
        return;
    }

    let regions = layout(area);
    let (query, cursor_column) = visible_query(&app.query, app.query_cursor, area.width - 8);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("搜索：", Style::default().fg(Color::Cyan)),
            Span::raw(query),
        ])),
        regions.query,
    );
    frame.set_cursor_position((regions.query.x + 6 + cursor_column, regions.query.y));

    if let Some(error) = &app.search_error {
        frame.render_widget(
            Paragraph::new(error.as_str()).style(Style::default().fg(Color::Red)),
            regions.results,
        );
    } else if app.hits.is_empty() {
        let message = if app.query.is_empty() {
            "还没有碎片".to_string()
        } else {
            format!("没有找到包含「{}」的碎片", app.query)
        };
        frame.render_widget(Paragraph::new(message), regions.results);
    } else {
        render_results(frame, app, regions.results);
    }

    if let Some(entry) = app
        .hits
        .get(app.selected)
        .and_then(|index| app.entries.get(*index))
    {
        let lines = editor_view::visual_lines(&entry.body, regions.preview.width as usize);
        frame.render_widget(
            Paragraph::new(lines.join("\n")).style(Style::default().fg(Color::Gray)),
            regions.preview,
        );
    }
    frame.render_widget(
        Paragraph::new("↑↓ 选择  Enter 编辑  Esc 清空/退出  Ctrl+C 退出")
            .style(Style::default().fg(Color::DarkGray)),
        regions.footer,
    );
}

fn render_results(frame: &mut Frame, app: &App, area: Rect) {
    let visible = area.height as usize;
    let start = app.search_offset;
    let lines = app
        .hits
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .filter_map(|(row, index)| {
            let entry = app.entries.get(*index)?;
            let date = display_date(&entry.created_at);
            let id = find::short_id(&entry.id);
            let mut spans = vec![
                Span::raw(format!("{:>3}  ", row + 1)),
                Span::styled(
                    format!("{date}  {id:<8}  "),
                    Style::default().fg(Color::DarkGray),
                ),
            ];
            if entry.kind == Some("document") {
                spans.push(Span::raw("[文档] "));
            }
            let used = spans.iter().map(|span| span.content.width()).sum::<usize>();
            spans.extend(preview_spans(
                app.previews.get(row).map(Vec::as_slice).unwrap_or(&[]),
                (area.width as usize).saturating_sub(used),
            ));
            let mut line = Line::from(spans);
            if row == app.selected {
                line.style = Style::default().add_modifier(Modifier::REVERSED);
            }
            Some(line)
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

fn preview_spans(parts: &[SearchTextPart], columns: usize) -> Vec<Span<'static>> {
    let mut characters = Vec::new();
    let mut previous_space = true;
    for part in parts {
        for character in part.text.chars() {
            let character = if character.is_whitespace() {
                ' '
            } else {
                character
            };
            if character == ' ' && previous_space {
                continue;
            }
            previous_space = character == ' ';
            characters.push((character, part.hit));
        }
    }
    let total = characters
        .iter()
        .map(|(character, _)| char_width(*character))
        .sum::<usize>();
    let truncated = total > columns;
    let available = columns.saturating_sub(usize::from(truncated));
    let mut spans = Vec::new();
    let mut chunk = String::new();
    let mut chunk_hit = false;
    let mut used = 0;
    for (character, hit) in characters {
        let width = char_width(character);
        if used + width > available {
            break;
        }
        if !chunk.is_empty() && hit != chunk_hit {
            spans.push(styled_preview_chunk(std::mem::take(&mut chunk), chunk_hit));
        }
        used += width;
        chunk_hit = hit;
        chunk.push(character);
    }
    if !chunk.is_empty() {
        spans.push(styled_preview_chunk(chunk, chunk_hit));
    }
    if truncated {
        spans.push(Span::raw("…"));
    }
    spans
}

fn char_width(character: char) -> usize {
    UnicodeWidthChar::width(character).unwrap_or(0).max(1)
}

fn styled_preview_chunk(chunk: String, hit: bool) -> Span<'static> {
    Span::styled(
        chunk,
        if hit {
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        },
    )
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

fn visible_query(query: &str, cursor: usize, width: u16) -> (String, u16) {
    let cursor = cursor.min(query.len());
    let mut start = 0;
    let mut before = query[..cursor]
        .graphemes(true)
        .map(UnicodeWidthStr::width)
        .sum::<usize>();
    let width = width as usize;
    for grapheme in query[..cursor].graphemes(true) {
        if before < width {
            break;
        }
        start += grapheme.len();
        before = before.saturating_sub(grapheme.width());
    }
    (
        query[start..].to_string(),
        before.min(width.saturating_sub(1)) as u16,
    )
}
