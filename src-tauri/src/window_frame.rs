use tauri::{LogicalSize, PhysicalSize};

const COMPACT_SCREEN_MAX_WIDTH: f64 = 1440.0;
const COMPACT_SCREEN_MAX_HEIGHT: f64 = 900.0;

fn is_compact_screen(size: PhysicalSize<u32>, scale_factor: f64) -> bool {
    let logical = size.to_logical::<f64>(scale_factor);
    logical.width <= COMPACT_SCREEN_MAX_WIDTH || logical.height <= COMPACT_SCREEN_MAX_HEIGHT
}

fn minimum_size(size: PhysicalSize<u32>, scale_factor: f64) -> PhysicalSize<u32> {
    let preferred = LogicalSize::new(720.0, 640.0).to_physical::<u32>(scale_factor);
    PhysicalSize::new(
        preferred.width.min(size.width),
        preferred.height.min(size.height),
    )
}

#[cfg(target_os = "macos")]
fn maximize_and_show(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};

    if window.is_maximized()? {
        return window.show();
    }
    // macOS zooms asynchronously. Keep the window hidden until the native
    // resize arrives, rather than showing its normal frame first.
    let pending_window = window.clone();
    let shown = AtomicBool::new(false);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_))
            && !shown.load(Ordering::Relaxed)
            && pending_window.is_maximized().unwrap_or(false)
        {
            shown.store(true, Ordering::Relaxed);
            let _ = pending_window.show();
        }
    });
    window.maximize()
}

#[cfg(not(target_os = "macos"))]
fn maximize_and_show(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.maximize()?;
    window.show()
}

pub fn configure_startup(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // Tauri's preventOverflow fits the initial window to the monitor's work
    // area before creation. Apply minimums afterwards so they cannot enlarge
    // that fitted size on small screens or at high display scaling.
    window.set_min_size(Some(minimum_size(
        window.inner_size()?,
        window.scale_factor()?,
    )))?;

    // A hidden window may not yet be assigned to a monitor. Prefer the one
    // containing it, then fall back to the primary display.
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    if monitor.is_some_and(|monitor| is_compact_screen(*monitor.size(), monitor.scale_factor())) {
        // Fill the current desktop without moving macOS users to a new Space.
        return maximize_and_show(window);
    }

    // Large displays keep the configured, overflow-fitted 1180×820 window and
    // its work-area centering. Reveal only after choosing the startup layout.
    window.show()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_screen_uses_logical_dimensions_and_includes_thresholds() {
        for (width, height, scale, compact) in [
            (1280, 800, 1.0, true),
            (1440, 900, 1.0, true),
            (1440, 1080, 1.0, true),
            (1920, 900, 1.0, true),
            (1441, 901, 1.0, false),
            (1512, 982, 1.0, false),
            (1920, 1080, 1.0, false),
            (2560, 1600, 2.0, true),
            (2880, 1800, 2.0, true),
            (3024, 1964, 2.0, false),
            (1920, 1080, 1.5, true),
            (2560, 1440, 1.5, false),
            (1080, 1920, 1.0, true),
            (3840, 1080, 1.0, false),
        ] {
            assert_eq!(
                is_compact_screen(PhysicalSize::new(width, height), scale),
                compact,
                "{width}×{height} at {scale}× scaling",
            );
        }
    }

    #[test]
    fn startup_minimum_never_enlarges_the_fitted_window() {
        for (width, height, scale, min_width, min_height) in [
            (1180, 820, 1.0, 720, 640),
            (992, 528, 1.0, 720, 528),
            (600, 480, 1.0, 600, 480),
            (1888, 1000, 1.5, 1080, 960),
            (1888, 1000, 2.0, 1440, 1000),
            (1500, 790, 1.25, 900, 790),
        ] {
            assert_eq!(
                minimum_size(PhysicalSize::new(width, height), scale),
                PhysicalSize::new(min_width, min_height),
            );
        }
    }
}
