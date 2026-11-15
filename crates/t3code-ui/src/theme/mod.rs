//! Design tokens for the T3 Code GPUI port.
//!
//! Values are generated from `../t3code/apps/web/src/index.css` by
//! `tools/emit_theme.py`, so the port reads the same palette and geometry the
//! web app does. `Theme` is the semantic layer the widgets use; [`tokens`] is
//! the resolved raw layer.

pub mod tokens;

use gpui::{px, Hsla, Rgba as GpuiRgba};

/// sRGB + alpha, matching one CSS token's resolved color.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

impl Rgba {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    pub const fn with_alpha(self, a: f32) -> Self {
        Self { a, ..self }
    }

    /// `0xAARRGGBB`, the form `gpui::rgba` takes.
    pub fn argb(self) -> u32 {
        let a = (self.a.clamp(0.0, 1.0) * 255.0).round() as u32;
        (a << 24) | ((self.r as u32) << 16) | ((self.g as u32) << 8) | (self.b as u32)
    }

    /// `0xRRGGBB`, ignoring alpha.
    pub fn hex(self) -> u32 {
        ((self.r as u32) << 16) | ((self.g as u32) << 8) | (self.b as u32)
    }

    /// Convert to a gpui color. Alpha is preserved.
    pub fn hsla(self) -> Hsla {
        GpuiRgba {
            r: self.r as f32 / 255.0,
            g: self.g as f32 / 255.0,
            b: self.b as f32 / 255.0,
            a: self.a,
        }
        .into()
    }

    /// Blend toward `other` by `t` in 0..=1, compositing over an opaque base.
    pub fn mix(self, other: Rgba, t: f32) -> Rgba {
        let t = t.clamp(0.0, 1.0);
        let lerp = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
        Rgba {
            r: lerp(self.r, other.r),
            g: lerp(self.g, other.g),
            b: lerp(self.b, other.b),
            a: self.a + (other.a - self.a) * t,
        }
    }
}

/// Semantic palette. One `Theme` value describes every color a widget paints.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub background: Rgba,
    pub foreground: Rgba,
    pub card: Rgba,
    pub card_foreground: Rgba,
    pub popover: Rgba,
    pub popover_foreground: Rgba,
    pub primary: Rgba,
    pub primary_foreground: Rgba,
    pub secondary: Rgba,
    pub secondary_foreground: Rgba,
    pub muted: Rgba,
    pub muted_foreground: Rgba,
    pub placeholder: Rgba,
    pub accent: Rgba,
    pub accent_foreground: Rgba,
    pub border: Rgba,
    pub input: Rgba,
    pub ring: Rgba,
    pub error: Rgba,
    pub error_foreground: Rgba,
    pub error_surface: Rgba,
    pub info: Rgba,
    pub info_foreground: Rgba,
    pub success: Rgba,
    pub success_foreground: Rgba,
    pub warning: Rgba,
    pub warning_foreground: Rgba,
    pub warning_surface: Rgba,
    pub sidebar: Rgba,
    pub sidebar_foreground: Rgba,
    pub sidebar_muted_foreground: Rgba,
    pub sidebar_control_surface: Rgba,
    pub sidebar_row_hover: Rgba,
    pub sidebar_row_active: Rgba,
    pub sidebar_row_selected: Rgba,
    pub sidebar_border: Rgba,
    pub code_background: Rgba,
    pub code_foreground: Rgba,
    pub terminal_background: Rgba,
    pub terminal_foreground: Rgba,
    pub message_surface: Rgba,
    pub message_foreground: Rgba,
    pub surface_raised: Rgba,
    pub guest: Rgba,
    pub guest_foreground: Rgba,
    pub is_dark: bool,
}

macro_rules! theme_from_tokens {
    ($mod:ident, $dark:expr) => {
        Theme {
            background: tokens::$mod::BACKGROUND,
            foreground: tokens::$mod::FOREGROUND,
            card: tokens::$mod::CARD,
            card_foreground: tokens::$mod::CARD_FOREGROUND,
            popover: tokens::$mod::POPOVER,
            popover_foreground: tokens::$mod::POPOVER_FOREGROUND,
            primary: tokens::$mod::PRIMARY,
            primary_foreground: tokens::$mod::PRIMARY_FOREGROUND,
            secondary: tokens::$mod::SECONDARY,
            secondary_foreground: tokens::$mod::SECONDARY_FOREGROUND,
            muted: tokens::$mod::MUTED,
            muted_foreground: tokens::$mod::MUTED_FOREGROUND,
            placeholder: tokens::$mod::PLACEHOLDER,
            accent: tokens::$mod::ACCENT,
            accent_foreground: tokens::$mod::ACCENT_FOREGROUND,
            border: tokens::$mod::BORDER,
            input: tokens::$mod::INPUT,
            ring: tokens::$mod::RING,
            error: tokens::$mod::ERROR,
            error_foreground: tokens::$mod::ERROR_FOREGROUND,
            error_surface: tokens::$mod::ERROR_SURFACE,
            info: tokens::$mod::INFO,
            info_foreground: tokens::$mod::INFO_FOREGROUND,
            success: tokens::$mod::SUCCESS,
            success_foreground: tokens::$mod::SUCCESS_FOREGROUND,
            warning: tokens::$mod::WARNING,
            warning_foreground: tokens::$mod::WARNING_FOREGROUND,
            warning_surface: tokens::$mod::WARNING_SURFACE,
            sidebar: tokens::$mod::SIDEBAR,
            sidebar_foreground: tokens::$mod::SIDEBAR_FOREGROUND,
            sidebar_muted_foreground: tokens::$mod::SIDEBAR_MUTED_FOREGROUND,
            sidebar_control_surface: tokens::$mod::SIDEBAR_CONTROL_SURFACE,
            sidebar_row_hover: tokens::$mod::SIDEBAR_ROW_HOVER,
            sidebar_row_active: tokens::$mod::SIDEBAR_ROW_ACTIVE,
            sidebar_row_selected: tokens::$mod::SIDEBAR_ROW_SELECTED,
            sidebar_border: tokens::$mod::SIDEBAR_BORDER,
            code_background: tokens::$mod::CODE_BACKGROUND,
            code_foreground: tokens::$mod::CODE_FOREGROUND,
            terminal_background: tokens::$mod::TERMINAL_BACKGROUND,
            terminal_foreground: tokens::$mod::TERMINAL_FOREGROUND,
            message_surface: tokens::$mod::MESSAGE_SURFACE,
            message_foreground: tokens::$mod::MESSAGE_FOREGROUND,
            surface_raised: tokens::$mod::SURFACE_RAISED,
            guest: tokens::$mod::GUEST,
            guest_foreground: tokens::$mod::GUEST_FOREGROUND,
            is_dark: $dark,
        }
    };
}

impl Theme {
    pub const LIGHT: Theme = theme_from_tokens!(light, false);
    pub const DARK: Theme = theme_from_tokens!(dark, true);

    pub fn for_mode(dark: bool) -> Theme {
        if dark { Theme::DARK } else { Theme::LIGHT }
    }

    /// Sidebar icon tint: `color-mix(in srgb, muted-foreground 85%, sidebar)`.
    pub fn sidebar_icon(&self) -> Rgba {
        self.sidebar_muted_foreground.mix(self.sidebar, 0.85)
    }
}

/// Layout geometry, in CSS pixels, from `index.css` custom properties and the
/// classes that consume them. Values are unscaled; multiply by the session
/// scale factor at paint time.
pub mod metrics {
    /// `--sidebar-width: 16rem` at a 16px root.
    pub const SIDEBAR_WIDTH: f32 = 256.0;
    /// Collapsed sidebar rail: `--sidebar-width-icon: 3rem`.
    pub const SIDEBAR_WIDTH_ICON: f32 = 48.0;
    /// `--workspace-topbar-height: 52px`.
    pub const TOPBAR_HEIGHT: f32 = 52.0;
    /// `--chat-content-max-width: 46rem`.
    pub const CHAT_MAX_WIDTH: f32 = 46.0 * 16.0;
    /// `--thread-details-panel-width: 17.5rem`.
    pub const DETAILS_PANEL_WIDTH: f32 = 17.5 * 16.0;
    /// `--workspace-gutter: 0.75rem` (1.25rem at the wide breakpoint).
    pub const GUTTER: f32 = 12.0;
    pub const GUTTER_WIDE: f32 = 20.0;
    /// `--control-radius: 0.5rem`.
    pub const CONTROL_RADIUS: f32 = 8.0;
    /// `--workspace-gutter` under the name the shell uses.
    pub const WORKSPACE_GUTTER: f32 = 12.0;
    /// `--floating-content-inset: 0.75rem`; gap below the docked composer.
    pub const FLOATING_CONTENT_INSET: f32 = 12.0;
    /// `--sidebar-content-inset: 0.5rem`.
    pub const SIDEBAR_CONTENT_INSET: f32 = 8.0;
    /// `--sidebar-control-gap: 0.5rem`.
    pub const SIDEBAR_CONTROL_GAP: f32 = 8.0;
    /// `--sidebar-row-content-inset: 0.625rem`.
    pub const SIDEBAR_ROW_CONTENT_INSET: f32 = 10.0;
    /// Sidebar row `h-8`.
    pub const SIDEBAR_ROW_HEIGHT: f32 = 32.0;
    /// Sidebar row `h-7` (sm variant).
    pub const SIDEBAR_ROW_HEIGHT_SM: f32 = 28.0;
    /// Sidebar row `h-9` (v2 rows).
    pub const SIDEBAR_ROW_HEIGHT_LG: f32 = 36.0;
    /// `--workspace-titlebar-control-size: 1.75rem`.
    pub const TITLEBAR_CONTROL_SIZE: f32 = 28.0;
    /// `--glass-blur: 12px` light, 16px dark.
    pub const GLASS_BLUR: f32 = 12.0;
    pub const GLASS_BLUR_DARK: f32 = 16.0;
    /// `--app-scrollbar-width: 6px`.
    pub const SCROLLBAR_WIDTH: f32 = 6.0;
    /// Composer elevation: `--shadow-composer`, blurred radius in px.
    pub const COMPOSER_SHADOW_BLUR: f32 = 2.0;
}

/// Type scale. `--text-2xs` through `--text-5xs` are t3code's own dense-UI
/// steps; the rest are Tailwind's defaults as the app uses them.
pub mod type_scale {
    pub const TEXT_2XS: f32 = 11.0; // 0.6875rem
    pub const TEXT_3XS: f32 = 10.0; // 0.625rem
    pub const TEXT_4XS: f32 = 8.0; // 0.5rem
    pub const TEXT_5XS: f32 = 7.0; // 0.4375rem
    pub const TEXT_XS: f32 = 12.0;
    pub const TEXT_SM: f32 = 14.0;
    pub const TEXT_BASE: f32 = 16.0;
    pub const TEXT_LG: f32 = 18.0;
    pub const TEXT_XL: f32 = 20.0;

    /// `DEFAULT_INTERFACE_FONT_SIZE` in packages/contracts/src/settings.ts.
    pub const INTERFACE: f32 = 16.0;
    /// `DEFAULT_PROMPT_FONT_SIZE`.
    pub const PROMPT: f32 = 14.0;
    /// `DEFAULT_CODE_FONT_SIZE`.
    pub const CODE: f32 = 13.0;
}

/// Root font size the `rem` geometry above assumes.
pub const ROOT_FONT_SIZE: f32 = 16.0;

/// Build a gpui color from a token.
pub fn color(c: Rgba) -> gpui::Rgba {
    gpui::rgba(c.argb())
}

/// Shorthand: token color straight to a length-free gpui color value.
pub fn c(c: Rgba) -> Hsla {
    c.hsla()
}

/// Round a CSS pixel value to a gpui length.
pub fn length(v: f32) -> gpui::Pixels {
    px(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The generator must produce a distinct light and dark palette: if these
    /// ever match, the dark block stopped resolving.
    #[test]
    fn light_and_dark_differ() {
        assert_ne!(Theme::LIGHT.background, Theme::DARK.background);
        assert_eq!(Theme::LIGHT.background, Rgba::rgb(252, 252, 252));
        assert_eq!(Theme::DARK.background, Rgba::rgb(0, 0, 0));
    }

    /// Spot-check resolved values against the CSS the generator read.
    #[test]
    fn tokens_match_css() {
        // --primary: oklch(0.488 0.217 264) resolves to this sRGB triple.
        assert_eq!(Theme::LIGHT.primary, Rgba::rgb(27, 78, 216));
        // @variant dark: --card is neutral-950 at 97%, mixed with white.
        assert_eq!(Theme::DARK.card, Rgba::rgb(17, 17, 17));
        // Dark borders are white at 8%.
        assert_eq!(Theme::DARK.border.a, 0.08);
        assert_eq!(Theme::DARK.border, Rgba::rgb(255, 255, 255).with_alpha(0.08));
    }

    #[test]
    fn alpha_survives_argb_roundtrip() {
        let c = Rgba::rgb(255, 255, 255).with_alpha(0.08);
        assert_eq!(c.argb() >> 24, 20); // 0.08 * 255 = 20.4 -> 20
    }

    #[test]
    fn geometry_matches_css_custom_properties() {
        assert_eq!(metrics::SIDEBAR_WIDTH, 16.0 * ROOT_FONT_SIZE);
        assert_eq!(metrics::TOPBAR_HEIGHT, 52.0);
        assert_eq!(metrics::CHAT_MAX_WIDTH, 736.0);
        assert_eq!(type_scale::TEXT_2XS, 11.0);
    }
}
