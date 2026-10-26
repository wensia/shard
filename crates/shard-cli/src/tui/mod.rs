pub mod app;
pub mod editor;
pub mod editor_view;
pub mod search_view;
pub mod store;
pub mod terminal;

use crate::find::FragmentEntry;
use app::{Action, App, Store};
use terminal::{Event, TerminalGuard};

/// 交互搜索与编辑界面。条目与读写都由调用方给：本地模式是 vault 目录与 [`store::VaultStore`]，
/// 远程模式是服务器的 `list_documents` 与远程 Store（读 → 本地编辑 → 带 sha 写回）。
pub fn run(
    entries: Vec<FragmentEntry>,
    store: Box<dyn Store>,
    initial_query: Option<&str>,
    edit_id: Option<&str>,
) -> Result<(), String> {
    let mut app = App::new(entries, store);
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
    let result = (|| loop {
        terminal
            .terminal_mut()
            .draw(|frame| app.render(frame))
            .map_err(|error| format!("绘制交互界面失败：{error}"))?;
        let event = terminal
            .next_event()
            .map_err(|error| format!("读取终端输入失败：{error}"))?;
        if app.handle(event) == Action::Quit {
            break Ok(());
        }
    })();
    drop(terminal);
    for path in &app.draft_paths {
        eprintln!("未保存的草稿：{}", path.display());
    }
    result
}
