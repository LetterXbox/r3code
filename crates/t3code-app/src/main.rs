//! T3 Code, native: a GPUI port of the T3 Code control surface.

mod shell;

use gpui::{
    point, px, size, App, AppContext, Bounds, SharedString, TitlebarOptions, WindowBounds,
    WindowOptions,
};
use gpui_platform::application;

use shell::Shell;
use t3code_ui::theme::Theme;

fn main() {
    let app = application();
    app.with_assets(EmbeddedAssets)
        .run(|cx: &mut App| {
            let bounds = Bounds::centered(None, size(px(1280.0), px(820.0)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some(SharedString::from("T3 Code")),
                        appears_transparent: cfg!(target_os = "macos"),
                        traffic_light_position: Some(point(px(12.0), px(19.0))),
                    }),
                    ..Default::default()
                },
                |_window, cx| cx.new(Shell::demo),
            )
            .expect("open main window");
            cx.activate(true);
        });
}

/// Assets the shell renders. The wordmark is the only raster-free asset today.
struct EmbeddedAssets;

impl gpui::AssetSource for EmbeddedAssets {
    fn load(&self, path: &str) -> gpui::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        match path {
            "t3-wordmark.svg" => Ok(Some(std::borrow::Cow::Borrowed(
                include_bytes!("../../t3code-ui/assets/t3-wordmark.svg").as_slice(),
            ))),
            _ => Ok(None),
        }
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(vec![SharedString::from("t3-wordmark.svg")])
    }
}

// Keep the theme reachable for downstream screens.
#[allow(unused_imports)]
use Theme as _Theme;
