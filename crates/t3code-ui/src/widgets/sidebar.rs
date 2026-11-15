//! `components/ui/sidebar.tsx` for GPUI.
//!
//! The geometry here is the web app's: a 16rem rail, an 8px content inset, and
//! 32px rows at the 8px control radius. Rows are stateful because GPUI keys
//! hover and selection off an element id.

use gpui::{
    div, prelude::*, px, AnyElement, ElementId, IntoElement, Pixels, SharedString, Window,
};

use crate::theme::{metrics, type_scale, Rgba, Theme};

/// What a row runs when clicked.
pub type ClickHandler = Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static>;

/// Width of the sidebar for a given collapsed state.
pub fn width(collapsed: bool) -> Pixels {
    px(if collapsed {
        metrics::SIDEBAR_WIDTH_ICON
    } else {
        metrics::SIDEBAR_WIDTH
    })
}

/// Row density, mirroring the cva `size` variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowSize {
    /// `h-7 text-xs`
    Sm,
    /// `h-8 text-sm`
    #[default]
    Default,
    /// `h-9`, the v2 thread row
    Lg,
}

impl RowSize {
    pub fn height(self) -> f32 {
        match self {
            RowSize::Sm => metrics::SIDEBAR_ROW_HEIGHT_SM,
            RowSize::Default => metrics::SIDEBAR_ROW_HEIGHT,
            RowSize::Lg => metrics::SIDEBAR_ROW_HEIGHT_LG,
        }
    }

    pub fn font_size(self) -> f32 {
        match self {
            RowSize::Sm => type_scale::TEXT_XS,
            _ => type_scale::TEXT_SM,
        }
    }
}

/// How a row is decorated. `Active` is a selected thread; `Hover` is only
/// reachable through interaction, so it exists for previews and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowState {
    #[default]
    Idle,
    Hover,
    Active,
}

impl RowState {
    fn background(self, theme: &Theme) -> Option<Rgba> {
        match self {
            RowState::Idle => None,
            RowState::Hover => Some(theme.sidebar_row_hover),
            RowState::Active => Some(theme.sidebar_row_selected),
        }
    }
}

/// A sidebar row: optional leading icon, a title that truncates, optional
/// trailing accessory.
pub struct SidebarRow {
    id: ElementId,
    title: SharedString,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    size: RowSize,
    state: RowState,
    collapsed: bool,
    theme: Theme,
    on_click: Option<ClickHandler>,
}

impl SidebarRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, theme: Theme) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            leading: None,
            trailing: None,
            size: RowSize::default(),
            state: RowState::Idle,
            collapsed: false,
            theme,
            on_click: None,
        }
    }

    pub fn size(mut self, s: RowSize) -> Self {
        self.size = s;
        self
    }

    pub fn state(mut self, s: RowState) -> Self {
        self.state = s;
        self
    }

    /// Render only the leading glyph, as the collapsed rail does.
    pub fn collapsed(mut self, c: bool) -> Self {
        self.collapsed = c;
        self
    }

    pub fn leading(mut self, el: impl IntoElement) -> Self {
        self.leading = Some(el.into_any_element());
        self
    }

    pub fn trailing(mut self, el: impl IntoElement) -> Self {
        self.trailing = Some(el.into_any_element());
        self
    }

    pub fn on_click(
        mut self,
        f: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(f));
        self
    }

    pub fn render(self) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.state == RowState::Active;
        let bg = self.state.background(&theme);
        let hover_bg = theme.sidebar_row_hover;
        let active_bg = theme.sidebar_row_selected;
        let on_click = self.on_click;
        let collapsed = self.collapsed;
        let size = self.size;

        // Collapsed rows are `size-8` squares with no horizontal padding; the
        // expanded variant pads by --sidebar-row-content-inset (10px).
        let (w, px_pad) = if collapsed {
            (Some(size.height()), 0.0)
        } else {
            (None, metrics::SIDEBAR_ROW_CONTENT_INSET)
        };

        let mut el = div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(metrics::SIDEBAR_CONTROL_GAP))
            .h(px(size.height()))
            .map(|d| match w {
                Some(w) => d.w(px(w)).justify_center(),
                None => d.w_full().px(px(px_pad)),
            })
            .flex_shrink_0()
            .rounded(px(metrics::CONTROL_RADIUS))
            .overflow_hidden()
            .cursor_pointer()
            .text_size(px(size.font_size()))
            .text_color(theme.sidebar_muted_foreground.hsla())
            .when(selected, |d| {
                d.bg(active_bg.hsla())
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.sidebar_foreground.hsla())
            })
            .when_some(bg.filter(|_| !selected), |d, c| d.bg(c.hsla()));

        if let Some(icon) = self.leading {
            el = el.child(div().flex_shrink_0().size(px(16.0)).child(icon));
        }

        if !collapsed {
            // `[&>span:last-child]:truncate`: the title never wraps.
            el = el.child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(if selected {
                        theme.sidebar_foreground.hsla()
                    } else {
                        theme.sidebar_muted_foreground.hsla()
                    })
                    .child(self.title),
            );
        }

        if let Some(acc) = self.trailing {
            el = el.child(div().flex_shrink_0().child(acc));
        }

        el = el
            .hover(move |s| {
                s.bg(hover_bg.hsla())
                    .text_color(theme.sidebar_foreground.hsla())
            })
            // `active:bg-sidebar-row-active`.
            .active(move |s| s.bg(active_bg.hsla()));

        if let Some(handler) = on_click {
            el = el.on_click(handler);
        }
        el
    }
}

/// A collapsible project group header: caret, project name, add-thread button.
pub struct ProjectHeader {
    id: ElementId,
    name: SharedString,
    expanded: bool,
    theme: Theme,
    on_toggle: Option<ClickHandler>,
}

impl ProjectHeader {
    pub fn new(id: impl Into<ElementId>, name: impl Into<SharedString>, theme: Theme) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            expanded: true,
            theme,
            on_toggle: None,
        }
    }

    pub fn expanded(mut self, e: bool) -> Self {
        self.expanded = e;
        self
    }

    pub fn on_toggle(
        mut self,
        f: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> Self {
        self.on_toggle = Some(Box::new(f));
        self
    }

    pub fn render(self) -> impl IntoElement {
        let theme = self.theme;
        let hover = theme.sidebar_row_hover;
        let on_toggle = self.on_toggle;
        let caret = if self.expanded { "▾" } else { "▸" };
        let mut el = div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(6.0))
            .h(px(metrics::SIDEBAR_ROW_HEIGHT))
            .w_full()
            .px(px(metrics::SIDEBAR_ROW_CONTENT_INSET))
            .flex_shrink_0()
            .rounded(px(metrics::CONTROL_RADIUS))
            .cursor_pointer()
            .hover(move |s| s.bg(hover.hsla()))
            .child(
                div()
                    .flex_shrink_0()
                    .w(px(10.0))
                    .text_size(px(type_scale::TEXT_3XS))
                    .text_color(theme.sidebar_muted_foreground.hsla())
                    .child(caret),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(px(type_scale::TEXT_2XS))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.sidebar_muted_foreground.hsla())
                    .child(self.name),
            );
        if let Some(f) = on_toggle {
            el = el.on_click(f);
        }
        el
    }
}

/// The sidebar frame: fixed width, sidebar surface, hairline right border.
pub fn sidebar_frame(collapsed: bool, theme: &Theme) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .h_full()
        .w(width(collapsed))
        .flex_shrink_0()
        .bg(theme.sidebar.hsla())
        .border_r_1()
        .border_color(theme.sidebar_border.hsla())
        .overflow_hidden()
}

/// The scrollable list inside the frame, inset by 8px as the web app does.
/// The scrolling list of projects and threads.
///
/// Returns a stateful element because `overflow_y_scroll` only exists on
/// `StatefulInteractiveElement`; callers append rows with `child`.
pub fn sidebar_list(id: impl Into<ElementId>) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id.into())
        .flex()
        .flex_col()
        .flex_1()
        .min_h(px(0.0))
        .px(px(metrics::SIDEBAR_CONTENT_INSET))
        .gap(px(2.0))
        .overflow_y_scroll()
}
