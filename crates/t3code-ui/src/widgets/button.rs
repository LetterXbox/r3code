//! `components/ui/button.tsx` for GPUI.
//!
//! Variants and sizes mirror the cva table in the web app so a control looks
//! the same in both clients.

use gpui::{
    div, prelude::*, px, AnyElement, ElementId, IntoElement, SharedString,
    StatefulInteractiveElement,
};

use crate::theme::{metrics, type_scale, Theme};

/// What a control runs when clicked. Named so the struct stays readable.
pub type ClickHandler =
    Box<dyn Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ButtonVariant {
    /// `bg-primary text-primary-foreground`
    #[default]
    Primary,
    /// `bg-secondary text-secondary-foreground`
    Secondary,
    /// `bg-destructive text-white`
    Destructive,
    /// `border bg-background`; hover fills with accent
    Outline,
    /// Transparent, hover fills with accent
    Ghost,
    /// `text-primary underline-offset-4 hover:underline`
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ButtonSize {
    /// `h-8 px-3 text-sm`
    Sm,
    /// `h-9 px-4 py-2 text-sm`
    #[default]
    Default,
    /// `h-10 px-6 text-base`
    Lg,
    /// `size-9` square, icon only
    Icon,
    /// `size-8` square, icon only
    IconSm,
}

impl ButtonSize {
    pub fn height(self) -> f32 {
        match self {
            ButtonSize::Sm => 32.0,
            ButtonSize::Default => 36.0,
            ButtonSize::Lg => 40.0,
            ButtonSize::Icon => 36.0,
            ButtonSize::IconSm => 32.0,
        }
    }

    pub fn padding_x(self) -> f32 {
        match self {
            ButtonSize::Sm => 12.0,
            ButtonSize::Default => 16.0,
            ButtonSize::Lg => 24.0,
            ButtonSize::Icon | ButtonSize::IconSm => 0.0,
        }
    }

    pub fn font_size(self) -> f32 {
        match self {
            ButtonSize::Lg => type_scale::TEXT_BASE,
            _ => type_scale::TEXT_SM,
        }
    }

    pub fn is_square(self) -> bool {
        matches!(self, ButtonSize::Icon | ButtonSize::IconSm)
    }
}

/// A button. `id` must be unique in the window: GPUI keys hover state on it.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    variant: ButtonVariant,
    size: ButtonSize,
    theme: &Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> impl IntoElement {
    Button::new(id, label)
        .variant(variant)
        .size(size)
        .theme(*theme)
        .on_click(on_click)
        .render()
}

/// Builder form of [`button`], for when the label is an element.
pub struct Button {
    id: ElementId,
    label: AnyElement,
    variant: ButtonVariant,
    size: ButtonSize,
    theme: Theme,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into().into_any_element(),
            variant: ButtonVariant::default(),
            size: ButtonSize::default(),
            theme: Theme::DARK,
            disabled: false,
            on_click: None,
        }
    }

    /// Icon-only button: the element replaces the text label.
    pub fn icon(id: impl Into<ElementId>, icon: AnyElement) -> Self {
        let mut b = Self::new(id, "");
        b.label = icon;
        b.size = ButtonSize::Icon;
        b
    }

    pub fn variant(mut self, v: ButtonVariant) -> Self {
        self.variant = v;
        self
    }

    pub fn size(mut self, s: ButtonSize) -> Self {
        self.size = s;
        self
    }

    pub fn theme(mut self, t: Theme) -> Self {
        self.theme = t;
        self
    }

    pub fn disabled(mut self, d: bool) -> Self {
        self.disabled = d;
        self
    }

    pub fn on_click(
        mut self,
        f: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(f));
        self
    }

    /// Foreground color for the variant, used by the label and by icons.
    fn foreground(&self) -> crate::theme::Rgba {
        let t = &self.theme;
        match self.variant {
            ButtonVariant::Primary => t.primary_foreground,
            ButtonVariant::Secondary => t.secondary_foreground,
            ButtonVariant::Destructive => t.primary_foreground,
            ButtonVariant::Outline | ButtonVariant::Ghost => t.foreground,
            ButtonVariant::Link => t.primary,
        }
    }

    fn background(&self) -> crate::theme::Rgba {
        let t = &self.theme;
        match self.variant {
            ButtonVariant::Primary => t.primary,
            ButtonVariant::Secondary => t.secondary,
            ButtonVariant::Destructive => t.error,
            ButtonVariant::Outline | ButtonVariant::Ghost | ButtonVariant::Link => {
                // Transparent: the parent surface shows through.
                t.background.with_alpha(0.0)
            }
        }
    }

    /// Hover fill. Ghost and outline buttons fill with `accent`.
    fn hover_background(&self) -> crate::theme::Rgba {
        let t = &self.theme;
        match self.variant {
            ButtonVariant::Primary => t.primary.mix(t.foreground, 0.10),
            ButtonVariant::Secondary => t.secondary.mix(t.foreground, 0.08),
            ButtonVariant::Destructive => t.error.mix(t.foreground, 0.10),
            ButtonVariant::Outline | ButtonVariant::Ghost => t.accent,
            ButtonVariant::Link => t.background.with_alpha(0.0),
        }
    }

    pub fn render(self) -> impl IntoElement {
        let theme = self.theme;
        let size = self.size;
        let variant = self.variant;
        let disabled = self.disabled;
        let fg = self.foreground();
        let bg = self.background();
        let hover_bg = self.hover_background();
        let on_click = self.on_click;

        let mut el = div()
            .id(self.id)
            .flex()
            .items_center()
            .justify_center()
            .gap_2()
            .h(px(size.height()))
            .map(|d| {
                if size.is_square() {
                    d.w(px(size.height()))
                } else {
                    d.px(px(size.padding_x()))
                }
            })
            // `rounded-md` on buttons: 6px, one step tighter than --control-radius.
            .rounded(px(6.0))
            .bg(bg.hsla())
            .text_size(px(size.font_size()))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(fg.hsla())
            .when(disabled, |d| d.opacity(0.5))
            .when(!disabled, |d| d.cursor_pointer())
            .when(variant == ButtonVariant::Outline, |d| {
                d.border_1().border_color(theme.border.hsla())
            })
            .when(variant == ButtonVariant::Link, |d| d.underline())
            .child(self.label);

        if !disabled {
            el = el
                .hover(move |s| s.bg(hover_bg.hsla()))
                .active(move |s| s.bg(hover_bg.mix(theme.foreground, 0.06).hsla()));
            if let Some(handler) = on_click {
                el = el.on_click(handler);
            }
        }

        el
    }
}

/// Selection radius used by the sidebar and menus.
pub fn control_radius() -> f32 {
    metrics::CONTROL_RADIUS
}
