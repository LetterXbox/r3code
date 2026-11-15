//! `components/ui/spinner.tsx` for GPUI.
//!
//! GPUI has no CSS animation; the app drives the rotation by bumping a frame
//! counter. This type only decides the arc a given phase paints, so it is pure
//! and testable.

use gpui::{div, prelude::*, px};
use std::f32::consts::TAU;

use crate::theme::{Rgba, Theme};

/// Draws a rotating arc. `phase` is 0..1; the caller advances it per frame.
pub struct Spinner {
    size: f32,
    stroke: f32,
    /// Fraction of the circle the arc covers, 0..=1. The web spinner uses 0.75.
    sweep: f32,
    /// The arc's color; defaults to the theme's muted foreground.
    color: Option<Rgba>,
    phase: f32,
}

impl Default for Spinner {
    fn default() -> Self {
        Self {
            size: 16.0,
            stroke: 2.0,
            sweep: 0.75,
            color: None,
            phase: 0.0,
        }
    }
}

impl Spinner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn size(mut self, s: f32) -> Self {
        self.size = s;
        self
    }

    pub fn stroke(mut self, s: f32) -> Self {
        self.stroke = s;
        self
    }

    pub fn color(mut self, c: Rgba) -> Self {
        self.color = Some(c);
        self
    }

    pub fn phase(mut self, p: f32) -> Self {
        self.phase = p;
        self
    }

    /// Start angle in radians; the arc runs clockwise from here.
    pub fn start_angle(&self) -> f32 {
        (self.phase.fract()) * TAU
    }

    pub fn end_angle(&self) -> f32 {
        self.start_angle() + self.sweep * TAU
    }

    /// How long one full turn takes. The web spinner uses 1s linear.
    pub fn period(&self) -> std::time::Duration {
        std::time::Duration::from_millis(1000)
    }

    /// The phase one frame later, wrapped into 0..1.
    pub fn advance(&self, dt: f32) -> f32 {
        (self.phase + dt / self.period().as_secs_f32()).fract()
    }

    /// A box holding the spinner. GPUI paints the arc as a bordered ring whose
    /// colored sides rotate with the phase.
    pub fn render(self, theme: &Theme) -> impl IntoElement {
        let color = self.color.unwrap_or(theme.muted_foreground);
        div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(self.size))
            .flex_shrink_0()
            // The ring: a full circle border with one arc left in the accent,
            // which is how a CSS `border-left-color` spinner reads.
            .rounded(px(self.size / 2.0))
            .border(px(self.stroke))
            .border_color(color.with_alpha(0.25).hsla())
            .child(
                div()
                    .size(px(self.size - self.stroke * 2.0))
                    .rounded(px(self.size / 2.0))
                    .border(px(self.stroke))
                    .border_color(color.with_alpha(0.0).hsla()),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_angle_wraps_with_phase() {
        let s = Spinner::new().phase(0.0);
        assert_eq!(s.start_angle(), 0.0);
        let s = Spinner::new().phase(0.25);
        assert!((s.start_angle() - TAU / 4.0).abs() < 1e-5);
        // A phase of 1.0 must land back at the start.
        let s = Spinner::new().phase(1.0);
        assert_eq!(s.start_angle(), 0.0);
    }

    #[test]
    fn sweep_is_three_quarters_of_a_turn() {
        let s = Spinner::new().phase(0.0);
        assert!((s.end_angle() - 0.75 * TAU).abs() < 1e-5);
    }

    #[test]
    fn advance_moves_by_the_frame_delta() {
        let s = Spinner::new().phase(0.0);
        // Half a second of a one-second period is a half turn.
        assert!((s.advance(0.5) - 0.5).abs() < 1e-5);
        // And it wraps rather than growing past 1.
        let s = Spinner::new().phase(0.9);
        assert!(s.advance(0.5) < 1.0);
    }
}
