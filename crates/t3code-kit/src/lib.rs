//! Bridges t3code's design tokens onto GPUI Kit's component theme.
//!
//! GPUI Kit paints its 75+ components from a global `component::Theme`, whose
//! `ThemeColor` names are its own. This crate owns the one mapping from
//! t3code's semantic palette to those names, so a `Button` or `DataTable` from
//! the kit renders in T3 Code's colors without per-call styling.

use gpui::Hsla;
use gpui_kit::component::{Theme as KitTheme, ThemeColor, ThemeMode};

use t3code_ui::theme::{Rgba, Theme};

/// Convert a t3code token to the `Hsla` the component theme stores.
pub fn hsla(c: Rgba) -> Hsla {
    c.hsla()
}

/// Project t3code's palette onto GPUI Kit's `ThemeColor`.
///
/// Every name the kit renders with is set; nothing is left at the kit's
/// default so the two palettes never mix.
pub fn theme_color(t: &Theme) -> ThemeColor {
    let mut c = ThemeColor::default();

    // Surfaces
    c.background = hsla(t.background);
    c.foreground = hsla(t.foreground);
    c.border = hsla(t.border);
    c.input = hsla(t.input);
    c.ring = hsla(t.ring);
    c.overlay = hsla(t.background.with_alpha(0.6));
    c.popover = hsla(t.popover);
    c.popover_foreground = hsla(t.popover_foreground);
    c.muted = hsla(t.muted);
    c.muted_foreground = hsla(t.muted_foreground);
    c.accent = hsla(t.accent);
    c.accent_foreground = hsla(t.accent_foreground);

    // Brand
    c.primary = hsla(t.primary);
    c.primary_foreground = hsla(t.primary_foreground);
    c.primary_hover = hsla(t.primary.mix(t.foreground, 0.9));
    c.primary_active = hsla(t.primary.mix(t.background, 0.9));
    c.secondary = hsla(t.secondary);
    c.secondary_foreground = hsla(t.secondary_foreground);
    c.secondary_hover = hsla(t.accent);
    c.secondary_active = hsla(t.secondary);
    c.link = hsla(t.primary);
    c.link_hover = hsla(t.primary.mix(t.foreground, 0.85));
    c.link_active = hsla(t.primary.mix(t.background, 0.85));

    // Status
    c.danger = hsla(t.error);
    c.danger_foreground = hsla(t.error_foreground);
    c.danger_hover = hsla(t.error.mix(t.foreground, 0.9));
    c.danger_active = hsla(t.error.mix(t.background, 0.9));
    c.success = hsla(t.success);
    c.success_foreground = hsla(t.success_foreground);
    c.success_hover = hsla(t.success.mix(t.foreground, 0.9));
    c.success_active = hsla(t.success.mix(t.background, 0.9));
    c.warning = hsla(t.warning);
    c.warning_foreground = hsla(t.warning_foreground);
    c.warning_hover = hsla(t.warning.mix(t.foreground, 0.9));
    c.warning_active = hsla(t.warning.mix(t.background, 0.9));
    c.info = hsla(t.info);
    c.info_foreground = hsla(t.info_foreground);
    c.info_hover = hsla(t.info.mix(t.foreground, 0.9));
    c.info_active = hsla(t.info.mix(t.background, 0.9));

    // Sidebar: t3code raises the rail on its own token set.
    c.sidebar = hsla(t.sidebar);
    c.sidebar_foreground = hsla(t.sidebar_foreground);
    c.sidebar_border = hsla(t.sidebar_border);
    c.sidebar_accent = hsla(t.sidebar_row_hover);
    c.sidebar_accent_foreground = hsla(t.sidebar_foreground);
    c.sidebar_primary = hsla(t.primary);
    c.sidebar_primary_foreground = hsla(t.primary_foreground);

    // Lists and tables share the raised-surface rhythm.
    c.list = hsla(t.card);
    c.list_hover = hsla(t.accent);
    c.list_active = hsla(t.sidebar_row_selected);
    c.list_active_border = hsla(t.border);
    c.list_even = hsla(t.muted);
    c.list_head = hsla(t.card);
    c.table = hsla(t.card);
    c.table_hover = hsla(t.accent);
    c.table_active = hsla(t.sidebar_row_selected);
    c.table_active_border = hsla(t.border);
    c.table_even = hsla(t.muted);
    c.table_head = hsla(t.card);
    c.table_head_foreground = hsla(t.muted_foreground);
    c.table_foot = hsla(t.card);
    c.table_foot_foreground = hsla(t.muted_foreground);
    c.table_row_border = hsla(t.border);

    // Tabs and bars
    c.tab = hsla(t.muted);
    c.tab_active = hsla(t.card);
    c.tab_active_foreground = hsla(t.foreground);
    c.tab_foreground = hsla(t.muted_foreground);
    c.tab_bar = hsla(t.background);
    c.tab_bar_segmented = hsla(t.muted);
    c.title_bar = hsla(t.sidebar);
    c.title_bar_border = hsla(t.sidebar_border);
    c.status_bar = hsla(t.sidebar);
    c.status_bar_border = hsla(t.border);
    c.window_border = hsla(t.border);

    // Controls
    c.button = hsla(t.secondary);
    c.button_foreground = hsla(t.secondary_foreground);
    c.button_hover = hsla(t.accent);
    c.button_active = hsla(t.secondary);
    c.button_primary = hsla(t.primary);
    c.button_primary_foreground = hsla(t.primary_foreground);
    c.button_primary_hover = hsla(t.primary.mix(t.foreground, 0.9));
    c.button_primary_active = hsla(t.primary.mix(t.background, 0.9));
    c.button_secondary = hsla(t.secondary);
    c.button_secondary_foreground = hsla(t.secondary_foreground);
    c.button_secondary_hover = hsla(t.accent);
    c.button_secondary_active = hsla(t.secondary);
    c.button_danger = hsla(t.error);
    c.button_danger_foreground = hsla(t.error_foreground);
    c.button_danger_hover = hsla(t.error.mix(t.foreground, 0.9));
    c.button_danger_active = hsla(t.error.mix(t.background, 0.9));
    c.button_success = hsla(t.success);
    c.button_success_foreground = hsla(t.success_foreground);
    c.button_success_hover = hsla(t.success.mix(t.foreground, 0.9));
    c.button_success_active = hsla(t.success.mix(t.background, 0.9));
    c.button_warning = hsla(t.warning);
    c.button_warning_foreground = hsla(t.warning_foreground);
    c.button_warning_hover = hsla(t.warning.mix(t.foreground, 0.9));
    c.button_warning_active = hsla(t.warning.mix(t.background, 0.9));
    c.button_info = hsla(t.info);
    c.button_info_foreground = hsla(t.info_foreground);
    c.button_info_hover = hsla(t.info.mix(t.foreground, 0.9));
    c.button_info_active = hsla(t.info.mix(t.background, 0.9));

    c.switch = hsla(t.input);
    c.switch_thumb = hsla(t.background);
    c.slider_bar = hsla(t.secondary);
    c.slider_thumb = hsla(t.primary);
    c.caret = hsla(t.primary);
    c.selection = hsla(t.accent);
    c.scrollbar = hsla(t.background);
    c.scrollbar_thumb = hsla(t.border);
    c.scrollbar_thumb_hover = hsla(t.muted_foreground);
    c.skeleton = hsla(t.muted);
    c.progress_bar = hsla(t.primary);
    c.drag_border = hsla(t.primary);
    c.drop_target = hsla(t.accent);
    c.group_box = hsla(t.card);
    c.group_box_foreground = hsla(t.card_foreground);
    c.accordion = hsla(t.card);
    c.description_list_label = hsla(t.card);
    c.description_list_label_foreground = hsla(t.muted_foreground);

    // Charts
    c.chart_bullish = hsla(t.success);
    c.chart_bearish = hsla(t.error);
    c.chart_grid = hsla(t.border);

    c
}

/// Install t3code's palette as the kit's global theme for `mode`.
pub fn install(cx: &mut gpui::App, t: &Theme, mode: ThemeMode) {
    let colors = theme_color(t);
    KitTheme::update(cx, |theme| {
        theme.colors = colors;
        theme.mode = mode;
    });
}
