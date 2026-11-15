//! The workspace shell: sidebar rail plus the chat surface.
//!
//! Layout follows `apps/web/src/components/` — a fixed 16rem sidebar, a 52px
//! topbar, and a chat column capped at 46rem (`--chat-content-max-width`).

use gpui::{
    div, prelude::*, px, Context, ElementId, FontWeight, IntoElement, SharedString, Window,
};

use t3code_core::{ShellState, SidebarState};
use t3code_protocol::{ProjectId, ThreadStatus};
use t3code_ui::theme::{metrics, type_scale, Theme};
use t3code_ui::widgets::{
    badge, BadgeVariant, sidebar_frame, sidebar_list, ProjectHeader, RowState, SidebarRow,
};

/// Root view owned by the window.
pub struct Shell {
    pub state: ShellState,
    pub theme: Theme,
    pub sidebar_collapsed: bool,
}

impl Shell {
    pub fn new(state: ShellState, theme: Theme, cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self {
            state,
            theme,
            sidebar_collapsed: false,
        }
    }

    /// Build the demo projection the first launch shows: two projects with a
    /// mix of idle/running/awaiting threads.
    pub fn demo(cx: &mut Context<Self>) -> Self {
        Self::new(demo_state(), Theme::for_mode(true), cx)
    }

    fn toggle_project(&mut self, project: ProjectId, cx: &mut Context<Self>) {
        self.state.sidebar.toggle_project(project);
        cx.notify();
    }

    fn open_thread(&mut self, id: &t3code_protocol::ThreadId, cx: &mut Context<Self>) {
        self.state.open_thread(id);
        cx.notify();
    }

    fn sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let collapsed = self.sidebar_collapsed;
        let mut list = sidebar_list("sidebar-list");

        // Pinned group renders above the project groups, as on the web.
        for project in self.state.projects.clone() {
            let is_collapsed = self.state.sidebar.is_collapsed(&project.id);
            let pid = project.id.clone();
            list = list.child(
                ProjectHeader::new(
                    ElementId::Name(SharedString::from(format!("proj-{}", project.id.as_str()))),
                    project.name.clone(),
                    theme,
                )
                .expanded(!is_collapsed)
                .on_toggle(cx.listener(move |this, _, _, cx| {
                    this.toggle_project(pid.clone(), cx)
                }))
                .render(),
            );

            if is_collapsed {
                continue;
            }
            for thread in self.state.threads_for_project(&project.id) {
                let active = self.state.route.is_thread(&thread.id);
                let tid = thread.id.clone();
                let state = if active {
                    RowState::Active
                } else {
                    RowState::Idle
                };
                list = list.child(
                    SidebarRow::new(
                        ElementId::Name(SharedString::from(format!(
                            "thread-{}",
                            thread.id.as_str()
                        ))),
                        thread.title.clone(),
                        theme,
                    )
                    .state(state)
                    .collapsed(collapsed)
                    .leading(status_dot(thread.status, &theme))
                    .trailing(thread_badges(thread.pinned, thread.status, &theme))
                    .on_click(cx.listener(move |this, _, _, cx| this.open_thread(&tid, cx)))
                    .render(),
                );
            }
        }

        sidebar_frame(collapsed, &theme)
            .child(sidebar_header(&theme, self.state.running_count()))
            .child(list)
    }

    fn chat(&self) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w(px(0.0))
            .h_full()
            .bg(theme.background.hsla())
            .child(topbar(&theme))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h(px(0.0))
                    .justify_center()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w(px(metrics::CHAT_MAX_WIDTH))
                            .max_w_full()
                            .px(px(metrics::WORKSPACE_GUTTER))
                            .py(px(16.0))
                            .gap(px(12.0))
                            .child(empty_state(&theme)),
                    ),
            )
            .child(composer(&theme))
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .size_full()
            .bg(theme.background.hsla())
            .text_color(theme.foreground.hsla())
            .text_size(px(type_scale::TEXT_SM))
            .child(self.sidebar(cx))
            .child(self.chat())
    }
}

fn demo_state() -> ShellState {
    use t3code_protocol::{EnvironmentId, Project, ThreadId, ThreadSummary};

    let env = EnvironmentId::new("env_local");
    let p1 = ProjectId::new("p_t3");
    let p2 = ProjectId::new("p_gpui");
    let mk = |pid: &ProjectId, n: &str| Project {
        id: pid.clone(),
        name: n.to_string(),
        path: format!("/Users/dev/{n}"),
    };
    let thread = |id: &str, pid: &ProjectId, title: &str, status, pinned, ts| ThreadSummary {
        id: ThreadId::new(id),
        environment_id: env.clone(),
        project_id: Some(pid.clone()),
        title: title.to_string(),
        status,
        pinned,
        updated_at_ms: ts,
    };
    ShellState {
        projects: vec![mk(&p1, "t3code"), mk(&p2, "t3codegpui")],
        threads: vec![
            thread("t1", &p1, "Port the sidebar rail", ThreadStatus::Running, true, 5),
            thread("t2", &p1, "Fix composer focus redirect", ThreadStatus::Idle, false, 4),
            thread("t3", &p1, "Checkpoint diff view", ThreadStatus::AwaitingInput, false, 3),
            thread("t4", &p2, "Wire the theme generator", ThreadStatus::Idle, false, 2),
            thread("t5", &p2, "Failing: window boot", ThreadStatus::Failed, false, 1),
        ],
        sidebar: SidebarState::default(),
        active_environment: Some(env),
        ..Default::default()
    }
}

fn sidebar_header(theme: &Theme, running: usize) -> impl IntoElement {
    let t = *theme;
    div()
        .flex()
        .items_center()
        .justify_between()
        .h(px(metrics::TOPBAR_HEIGHT))
        .px(px(metrics::SIDEBAR_CONTENT_INSET + 2.0))
        .flex_shrink_0()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .text_size(px(type_scale::TEXT_XS))
                        .font_weight(FontWeight::BOLD)
                        .text_color(t.foreground.hsla())
                        .child("T3"),
                )
                .child(
                    div()
                        .text_size(px(type_scale::TEXT_2XS))
                        .text_color(t.muted_foreground.hsla())
                        .child("Code"),
                ),
        )
        .child(if running > 0 {
            badge(
                SharedString::from(running.to_string()),
                BadgeVariant::Secondary,
                Default::default(),
                &t,
            )
            .into_any_element()
        } else {
            div().into_any_element()
        })
}

fn status_dot(status: ThreadStatus, theme: &Theme) -> impl IntoElement {
    let color = match status {
        ThreadStatus::Running => theme.success,
        ThreadStatus::AwaitingInput => theme.warning,
        ThreadStatus::Failed => theme.error,
        ThreadStatus::Idle => theme.muted_foreground,
    };
    div()
        .size(px(6.0))
        .rounded_full()
        .flex_shrink_0()
        .bg(color.hsla())
}

fn thread_badges(pinned: bool, status: ThreadStatus, theme: &Theme) -> impl IntoElement {
    let t = *theme;
    let mut row = div().flex().items_center().gap(px(4.0));
    if pinned {
        row = row.child(
            div()
                .text_size(px(type_scale::TEXT_4XS))
                .text_color(t.muted_foreground.hsla())
                .child("PIN"),
        );
    }
    if status == ThreadStatus::AwaitingInput {
        row = row.child(
            badge(
                SharedString::from("needs you"),
                BadgeVariant::Warning,
                Default::default(),
                &t,
            )
            .into_any_element(),
        );
    }
    row
}

fn topbar(theme: &Theme) -> impl IntoElement {
    let t = *theme;
    div()
        .flex()
        .items_center()
        .h(px(metrics::TOPBAR_HEIGHT))
        .px(px(metrics::WORKSPACE_GUTTER))
        .flex_shrink_0()
        .border_b_1()
        .border_color(t.border.hsla())
        .child(
            div()
                .text_size(px(type_scale::TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .text_color(t.foreground.hsla())
                .child("Port the sidebar rail"),
        )
}

fn empty_state(theme: &Theme) -> impl IntoElement {
    let t = *theme;
    div()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .flex_1()
        .gap(px(6.0))
        .child(
            div()
                .text_size(px(type_scale::TEXT_LG))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(t.foreground.hsla())
                .child("What should we build?"),
        )
        .child(
            div()
                .text_size(px(type_scale::TEXT_SM))
                .text_color(t.muted_foreground.hsla())
                .child("Pick a thread on the left, or start a new one."),
        )
}

fn composer(theme: &Theme) -> impl IntoElement {
    let t = *theme;
    div()
        .flex()
        .justify_center()
        .px(px(metrics::WORKSPACE_GUTTER))
        .pb(px(metrics::FLOATING_CONTENT_INSET))
        .child(
            div()
                .w(px(metrics::CHAT_MAX_WIDTH))
                .max_w_full()
                .min_h(px(64.0))
                .rounded(px(metrics::CONTROL_RADIUS))
                .border_1()
                .border_color(t.input.hsla())
                .bg(t.card.hsla())
                .px(px(12.0))
                .py(px(10.0))
                .child(
                    div()
                        .text_size(px(type_scale::TEXT_SM))
                        .text_color(t.muted_foreground.hsla())
                        .child("Ask T3 to change something…"),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{size, Bounds, TestAppContext, VisualTestContext, WindowBounds, WindowOptions};

    fn open_shell(cx: &mut TestAppContext) -> (gpui::WindowHandle<Shell>, VisualTestContext) {
        let window = cx.update(|cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        gpui::point(px(0.0), px(0.0)),
                        size(px(1280.0), px(820.0)),
                    ))),
                    ..Default::default()
                },
                |_, cx| cx.new(Shell::demo),
            )
            .unwrap()
        });
        let visual = VisualTestContext::from_window(window.into(), cx);
        (window, visual)
    }

    #[gpui::test]
    fn shell_renders_at_window_size(cx: &mut TestAppContext) {
        let (window, mut visual) = open_shell(cx);
        let shell = window.root(&mut visual).unwrap();
        let state = shell.read_with(&visual, |s, _| s.state.clone());
        // The demo projection is the first paint: two projects, five threads.
        assert_eq!(state.projects.len(), 2);
        assert_eq!(state.threads.len(), 5);
        assert_eq!(state.running_count(), 1);
    }

    #[gpui::test]
    fn opening_a_thread_selects_only_that_row(cx: &mut TestAppContext) {
        let (window, mut visual) = open_shell(cx);
        let shell = window.root(&mut visual).unwrap();
        let tid = t3code_protocol::ThreadId::new("t3");
        shell.update(&mut visual, |s, cx| {
            s.state.open_thread(&tid);
            cx.notify();
        });
        let route = shell.read_with(&visual, |s, _| s.state.route.clone());
        assert!(route.is_thread(&tid));
        assert!(!route.is_thread(&t3code_protocol::ThreadId::new("t1")));
    }

    #[gpui::test]
    fn collapsing_a_project_hides_its_rows(cx: &mut TestAppContext) {
        let (window, mut visual) = open_shell(cx);
        let shell = window.root(&mut visual).unwrap();
        let pid = t3code_protocol::ProjectId::new("p_t3");
        shell.update(&mut visual, |s, cx| {
            s.toggle_project(pid.clone(), cx);
        });
        let collapsed = shell.read_with(&visual, |s, _| s.state.sidebar.is_collapsed(&pid));
        assert!(collapsed);
        // The other project stays expanded.
        assert!(!shell.read_with(&visual, |s, _| {
            s.state.sidebar.is_collapsed(&t3code_protocol::ProjectId::new("p_gpui"))
        }));
    }
}
