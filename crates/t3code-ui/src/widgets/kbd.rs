//! `components/ui/kbd.tsx` for GPUI: a keycap hint, e.g. `⌘K`.
//!
//! Renders the platform glyphs the web app shows, so a shortcut reads the same
//! in both clients.

use gpui::{div, prelude::*, px, SharedString};

use crate::theme::{type_scale, Theme};

/// A keycap. `theme` supplies the surface; the cap itself is `bg-muted` with a
/// hairline border, matching the web component.
pub fn kbd(label: impl Into<SharedString>, theme: &Theme) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .h(px(20.0))
        .min_w(px(20.0))
        .px(px(5.0))
        .rounded(px(4.0))
        .bg(theme.muted.hsla())
        .border_1()
        .border_color(theme.border.hsla())
        .text_size(px(type_scale::TEXT_2XS))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(theme.muted_foreground.hsla())
        .child(label.into())
}

/// Render a chord from key names, folding the command key on macOS.
///
/// `chord("cmd", "shift", "k")` renders `⌘⇧K` on macOS and `Ctrl+Shift+K`
/// elsewhere, matching how the web app formats keybindings.
pub fn chord(keys: &[&str], macos: bool) -> String {
    if macos {
        keys.iter()
            .map(|k| match *k {
                "cmd" | "meta" => "⌘".to_string(),
                "shift" => "⇧".to_string(),
                "alt" | "option" => "⌥".to_string(),
                "ctrl" | "control" => "⌃".to_string(),
                "enter" | "return" => "↩".to_string(),
                "escape" | "esc" => "⎋".to_string(),
                "tab" => "⇥".to_string(),
                "backspace" => "⌫".to_string(),
                "delete" => "⌦".to_string(),
                "up" => "↑".to_string(),
                "down" => "↓".to_string(),
                "left" => "←".to_string(),
                "right" => "→".to_string(),
                other => other.to_uppercase(),
            })
            .collect()
    } else {
        keys.iter()
            .map(|k| match *k {
                "cmd" | "meta" | "ctrl" | "control" => "Ctrl".to_string(),
                "shift" => "Shift".to_string(),
                "alt" | "option" => "Alt".to_string(),
                "enter" | "return" => "Enter".to_string(),
                "escape" | "esc" => "Esc".to_string(),
                "tab" => "Tab".to_string(),
                "backspace" => "Backspace".to_string(),
                "delete" => "Delete".to_string(),
                "up" => "Up".to_string(),
                "down" => "Down".to_string(),
                "left" => "Left".to_string(),
                "right" => "Right".to_string(),
                other => other.to_uppercase(),
            })
            .collect::<Vec<_>>()
            .join("+")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_chords_use_glyphs() {
        assert_eq!(chord(&["cmd", "k"], true), "⌘K");
        assert_eq!(chord(&["cmd", "shift", "p"], true), "⌘⇧P");
        assert_eq!(chord(&["cmd", "enter"], true), "⌘↩");
    }

    #[test]
    fn other_platforms_join_with_plus() {
        assert_eq!(chord(&["cmd", "k"], false), "Ctrl+K");
        assert_eq!(chord(&["cmd", "shift", "p"], false), "Ctrl+Shift+P");
    }
}
