//! `components/ui/badge.tsx` for GPUI.
//!
//! Badges are the dense-UI label: they use t3code's `--text-2xs` (11px) step
//! and a 3px vertical pad, which is what the web app renders for counters,
//! provider pills and metadata rows.

use gpui::{div, prelude::*, px, SharedString};

use crate::theme::{type_scale, Rgba, Theme};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BadgeVariant {
    #[default]
    Default,
    Secondary,
    Outline,
    Destructive,
    /// Success tone, for "running"/"connected" states.
    Success,
    /// Warning tone, for "needs attention".
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BadgeSize {
    /// `h-4 px-1.5 text-2xs`
    Sm,
    /// `h-5 px-2 text-2xs`
    #[default]
    Default,
}

/// A badge. Returns `impl IntoElement`; badges never own state.
pub fn badge(
    label: impl Into<SharedString>,
    variant: BadgeVariant,
    size: BadgeSize,
    theme: &Theme,
) -> impl IntoElement {
    Badge::new(label)
        .variant(variant)
        .size(size)
        .theme(*theme)
        .render()
}

pub struct Badge {
    label: SharedString,
    variant: BadgeVariant,
    size: BadgeSize,
    theme: Theme,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            variant: BadgeVariant::default(),
            size: BadgeSize::default(),
            theme: Theme::DARK,
        }
    }

    pub fn variant(mut self, v: BadgeVariant) -> Self {
        self.variant = v;
        self
    }

    pub fn size(mut self, s: BadgeSize) -> Self {
        self.size = s;
        self
    }

    pub fn theme(mut self, t: Theme) -> Self {
        self.theme = t;
        self
    }

    fn colors(&self) -> (Rgba, Rgba, Option<Rgba>) {
        let t = &self.theme;
        match self.variant {
            BadgeVariant::Default => (t.primary, t.primary_foreground, None),
            BadgeVariant::Secondary => (t.secondary, t.secondary_foreground, None),
            BadgeVariant::Outline => (
                t.background.with_alpha(0.0),
                t.foreground,
                Some(t.border),
            ),
            BadgeVariant::Destructive => (t.error, t.primary_foreground, None),
            // Tinted surfaces: 10% of the tone over the card, matching the
            // `bg-primary/10` treatment the sidebar update pill uses.
            BadgeVariant::Success => (
                t.success.with_alpha(0.10),
                t.success_foreground,
                Some(t.success.with_alpha(0.30)),
            ),
            BadgeVariant::Warning => (
                t.warning.with_alpha(0.10),
                t.warning_foreground,
                Some(t.warning.with_alpha(0.30)),
            ),
        }
    }

    pub fn render(self) -> impl IntoElement {
        let (bg, fg, border) = self.colors();
        let (height, pad_x) = match self.size {
            BadgeSize::Sm => (16.0, 6.0),
            BadgeSize::Default => (20.0, 8.0),
        };
        div()
            .flex()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .h(px(height))
            .px(px(pad_x))
            // Badges use `rounded-md`.
            .rounded(px(6.0))
            .bg(bg.hsla())
            .text_size(px(type_scale::TEXT_2XS))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(fg.hsla())
            .whitespace_nowrap()
            .when_some(border, |d, c| d.border_1().border_color(c.hsla()))
            .child(self.label)
    }
}
