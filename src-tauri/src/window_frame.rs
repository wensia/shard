use tauri::{LogicalSize, PhysicalSize};

fn minimum_size(size: PhysicalSize<u32>, scale_factor: f64) -> PhysicalSize<u32> {
    let preferred = LogicalSize::new(720.0, 640.0).to_physical::<u32>(scale_factor);
    PhysicalSize::new(
        preferred.width.min(size.width),
        preferred.height.min(size.height),
    )
}

pub fn set_startup_minimum(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // Tauri's preventOverflow fits the initial window to the monitor's work
    // area before creation. Apply minimums afterwards so they cannot enlarge
    // that fitted size on small screens or at high display scaling.
    window.set_min_size(Some(minimum_size(
        window.inner_size()?,
        window.scale_factor()?,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

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
