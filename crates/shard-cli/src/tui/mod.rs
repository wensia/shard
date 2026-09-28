pub mod app;
pub mod editor;
pub mod editor_view;
pub mod search_view;
mod store;
pub mod terminal;

use app::{Action, App};
use std::{path::Path, time::Duration};
use terminal::{Event, TerminalGuard};

pub fn run(
    vault: &Path,
    initial_query: Option<&str>,
    edit_id: Option<&str>,
    lock_dir: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let entries = crate::find::load_fragments(vault)?;
    let store = store::VaultStore::new(lock_dir, timeout);
    let mut app = App::new(entries, Box::new(store));
    if let Some(query) = initial_query {
        app.handle(Event::Paste(query.to_string()));
    }
    if let Some(id) = edit_id {
        app.open_id(id);
    }
    let mut terminal =
        TerminalGuard::enter().map_err(|error| format!("进入交互界面失败：{error}"))?;
    let size = terminal
        .terminal_mut()
        .size()
        .map_err(|error| error.to_string())?;
    app.handle(Event::Resize(size.width, size.height));
    loop {
        terminal
            .terminal_mut()
            .draw(|frame| app.render(frame))
            .map_err(|error| format!("绘制交互界面失败：{error}"))?;
        let event = terminal
            .next_event()
            .map_err(|error| format!("读取终端输入失败：{error}"))?;
        if app.handle(event) == Action::Quit {
            return Ok(());
        }
    }
}
