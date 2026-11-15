//! Widget kit: the primitives `apps/web/src/components/ui/*` provides, ported
//! to GPUI.
//!
//! Each widget is a function returning `impl IntoElement` rather than a
//! component object, because none of them own state. Interactive ones take
//! handlers; stateful surfaces live in the app crate.

pub mod badge;
pub mod button;
pub mod kbd;
pub mod sidebar;
pub mod spinner;

pub use badge::{badge, Badge, BadgeSize, BadgeVariant};
pub use button::{button, Button, ButtonSize, ButtonVariant};
pub use kbd::{chord, kbd};
pub use sidebar::{sidebar_frame, sidebar_list, width as sidebar_width, ProjectHeader, RowSize, RowState, SidebarRow};
pub use spinner::Spinner;
