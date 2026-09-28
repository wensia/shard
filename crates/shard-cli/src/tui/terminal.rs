//! 终端输入与生命周期管理；界面状态和绘制不依赖这里的 I/O。

use std::io::{self, Stdout};
use std::panic::{self, PanicHookInfo};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::Show;
use ratatui::crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::Terminal;

type PreviousHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

#[derive(Debug)]
pub enum Event {
    Key(KeyEvent),
    Paste(String),
    Mouse(MouseEvent),
    Resize(u16, u16),
}

/// 持有备用屏幕；释放时恢复终端，即使绘制或事件处理提前返回。
pub struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    previous_hook: Arc<Mutex<Option<PreviousHook>>>,
    active: Arc<AtomicBool>,
    pending: Option<Event>,
}

fn restore_terminal() {
    let _ = execute!(
        io::stdout(),
        Show,
        DisableMouseCapture,
        DisableBracketedPaste,
        LeaveAlternateScreen
    );
    let _ = disable_raw_mode();
}

fn supported_event(event: event::Event) -> Option<Event> {
    match event {
        event::Event::Key(key)
            if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
        {
            Some(Event::Key(key))
        }
        event::Event::Paste(text) => Some(Event::Paste(text)),
        event::Event::Mouse(mouse)
            if matches!(
                mouse.kind,
                MouseEventKind::Down(MouseButton::Left)
                    | MouseEventKind::ScrollUp
                    | MouseEventKind::ScrollDown
            ) =>
        {
            Some(Event::Mouse(mouse))
        }
        event::Event::Resize(width, height) => Some(Event::Resize(width, height)),
        _ => None,
    }
}

fn alt_prefix_target(key: &KeyEvent) -> bool {
    matches!(
        key.code,
        KeyCode::Left | KeyCode::Right | KeyCode::Backspace | KeyCode::Char('b' | 'f')
    )
}

impl TerminalGuard {
    pub fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableMouseCapture
        ) {
            restore_terminal();
            return Err(error);
        }

        let terminal = match Terminal::new(CrosstermBackend::new(io::stdout())) {
            Ok(terminal) => terminal,
            Err(error) => {
                restore_terminal();
                return Err(error);
            }
        };

        let previous_hook = Arc::new(Mutex::new(Some(panic::take_hook())));
        let hook_state = Arc::clone(&previous_hook);
        let active = Arc::new(AtomicBool::new(true));
        let hook_active = Arc::clone(&active);
        panic::set_hook(Box::new(move |info| {
            if hook_active.swap(false, Ordering::SeqCst) {
                restore_terminal();
            }
            if let Ok(hook) = hook_state.lock() {
                if let Some(previous) = hook.as_ref() {
                    previous(info);
                }
            }
        }));

        Ok(Self {
            terminal,
            previous_hook,
            active,
            pending: None,
        })
    }

    pub fn terminal_mut(&mut self) -> &mut Terminal<CrosstermBackend<Stdout>> {
        &mut self.terminal
    }

    pub fn next_event(&mut self) -> io::Result<Event> {
        loop {
            let current = if let Some(pending) = self.pending.take() {
                pending
            } else if let Some(event) = supported_event(event::read()?) {
                event
            } else {
                continue;
            };

            if let Event::Key(key) = &current {
                if key.code == KeyCode::Esc && event::poll(Duration::from_millis(30))? {
                    if let Some(next) = supported_event(event::read()?) {
                        if let Event::Key(mut prefixed) = next {
                            if alt_prefix_target(&prefixed) {
                                prefixed.modifiers.insert(KeyModifiers::ALT);
                                return Ok(Event::Key(prefixed));
                            }
                            self.pending = Some(Event::Key(prefixed));
                        } else {
                            self.pending = Some(next);
                        }
                    }
                }
            }
            return Ok(current);
        }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        restore_terminal();
        // set_hook 在正在展开 panic 的线程中不可调用；hook 已先恢复终端。
        if !std::thread::panicking() {
            let _ = panic::take_hook();
            if let Ok(mut hook) = self.previous_hook.lock() {
                if let Some(previous) = hook.take() {
                    panic::set_hook(previous);
                }
            }
        }
    }
}
