//! Application state for the T3 Code GPUI port.
//!
//! The shell projection: what the sidebar, topbar and chat list read. This is
//! deliberately independent of gpui so it is testable without a window.

use serde::{Deserialize, Serialize};
use t3code_protocol::{
    DraftId, EnvironmentId, Project, ProjectId, ScopedThreadRef, ThreadId, ThreadStatus,
    ThreadSummary,
};

/// Which main surface the app is showing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Route {
    /// No thread selected yet (`_chat.index`).
    #[default]
    Index,
    /// A thread is open (`_chat.$environmentId.$threadId`).
    Thread(ScopedThreadRef),
    /// A brand-new unsent thread (`_chat.draft.$draftId`).
    Draft(DraftId),
    /// A settings page (`_chat.settings.*`).
    Settings(SettingsPage),
    /// The pull-request list (`_chat.pull-requests`).
    PullRequests,
    /// Usage dashboard (`_chat.usage`).
    Usage,
}
impl Route {
    /// True when `thread` is the open thread. The shell uses this for the
    /// selected row, and it is the only place route shape is inspected.
    pub fn is_thread(&self, thread: &ThreadId) -> bool {
        matches!(self, Route::Thread(r) if &r.thread_id == thread)
    }
}


/// The settings tabs, one variant per `_chat.settings.*` route in the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SettingsPage {
    General,
    Appearance,
    Chat,
    Projects,
    Worktrees,
    Providers,
    Connections,
    Devices,
    Access,
    SourceControl,
    Integrations,
    Secrets,
    Mcp,
    Keybindings,
    Browser,
    Diffs,
    Voice,
    Threads,
    Archived,
    ScheduledTasks,
    Usage,
    Storage,
    Maintenance,
    Diagnostics,
    Beta,
    Labs,
    About,
    OpenSourceLicenses,
}

impl SettingsPage {
    /// Every tab, in the order the settings sidebar lists them.
    pub const ALL: [SettingsPage; 28] = [
        SettingsPage::General,
        SettingsPage::Appearance,
        SettingsPage::Chat,
        SettingsPage::Projects,
        SettingsPage::Worktrees,
        SettingsPage::Providers,
        SettingsPage::Connections,
        SettingsPage::Devices,
        SettingsPage::Access,
        SettingsPage::SourceControl,
        SettingsPage::Integrations,
        SettingsPage::Secrets,
        SettingsPage::Mcp,
        SettingsPage::Keybindings,
        SettingsPage::Browser,
        SettingsPage::Diffs,
        SettingsPage::Voice,
        SettingsPage::Threads,
        SettingsPage::Archived,
        SettingsPage::ScheduledTasks,
        SettingsPage::Usage,
        SettingsPage::Storage,
        SettingsPage::Maintenance,
        SettingsPage::Diagnostics,
        SettingsPage::Beta,
        SettingsPage::Labs,
        SettingsPage::About,
        SettingsPage::OpenSourceLicenses,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SettingsPage::General => "General",
            SettingsPage::Appearance => "Appearance",
            SettingsPage::Chat => "Chat",
            SettingsPage::Projects => "Projects",
            SettingsPage::Worktrees => "Worktrees",
            SettingsPage::Providers => "Providers",
            SettingsPage::Connections => "Connections",
            SettingsPage::Devices => "Devices",
            SettingsPage::Access => "Access",
            SettingsPage::SourceControl => "Source control",
            SettingsPage::Integrations => "Integrations",
            SettingsPage::Secrets => "Secrets",
            SettingsPage::Mcp => "MCP",
            SettingsPage::Keybindings => "Keybindings",
            SettingsPage::Browser => "Browser",
            SettingsPage::Diffs => "Diffs",
            SettingsPage::Voice => "Voice",
            SettingsPage::Threads => "Threads",
            SettingsPage::Archived => "Archived",
            SettingsPage::ScheduledTasks => "Scheduled tasks",
            SettingsPage::Usage => "Usage",
            SettingsPage::Storage => "Storage",
            SettingsPage::Maintenance => "Maintenance",
            SettingsPage::Diagnostics => "Diagnostics",
            SettingsPage::Beta => "Beta",
            SettingsPage::Labs => "Labs",
            SettingsPage::About => "About",
            SettingsPage::OpenSourceLicenses => "Open source licenses",
        }
    }

    /// The URL slug, matching the route filename.
    pub fn slug(self) -> &'static str {
        match self {
            SettingsPage::General => "general",
            SettingsPage::Appearance => "appearance",
            SettingsPage::Chat => "chat",
            SettingsPage::Projects => "projects",
            SettingsPage::Worktrees => "worktrees",
            SettingsPage::Providers => "providers",
            SettingsPage::Connections => "connections",
            SettingsPage::Devices => "devices",
            SettingsPage::Access => "access",
            SettingsPage::SourceControl => "source-control",
            SettingsPage::Integrations => "integrations",
            SettingsPage::Secrets => "secrets",
            SettingsPage::Mcp => "mcp",
            SettingsPage::Keybindings => "keybindings",
            SettingsPage::Browser => "browser",
            SettingsPage::Diffs => "diffs",
            SettingsPage::Voice => "voice",
            SettingsPage::Threads => "threads",
            SettingsPage::Archived => "archived",
            SettingsPage::ScheduledTasks => "scheduled-tasks",
            SettingsPage::Usage => "usage",
            SettingsPage::Storage => "storage",
            SettingsPage::Maintenance => "maintenance",
            SettingsPage::Diagnostics => "diagnostics",
            SettingsPage::Beta => "beta",
            SettingsPage::Labs => "labs",
            SettingsPage::About => "about",
            SettingsPage::OpenSourceLicenses => "open-source-licenses",
        }
    }
}

/// Theme mode, matching the web app's `dark` class toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppearanceMode {
    Light,
    #[default]
    Dark,
    System,
}

/// Chat column width setting (`data-chat-width`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatWidth {
    #[default]
    Comfortable,
    Wide,
    Full,
}

/// Which sidebar groups are collapsed. The sidebar persists this per project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarState {
    pub collapsed_projects: Vec<ProjectId>,
    pub pinned_open: bool,
    pub archived_open: bool,
}

impl SidebarState {
    pub fn is_collapsed(&self, project: &ProjectId) -> bool {
        self.collapsed_projects.contains(project)
    }

    pub fn toggle_project(&mut self, project: ProjectId) {
        if let Some(i) = self.collapsed_projects.iter().position(|p| *p == project) {
            self.collapsed_projects.remove(i);
        } else {
            self.collapsed_projects.push(project);
        }
    }
}

/// The whole shell projection the UI reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellState {
    pub route: Route,
    pub projects: Vec<Project>,
    pub threads: Vec<ThreadSummary>,
    pub sidebar: SidebarState,
    pub active_environment: Option<EnvironmentId>,
    pub appearance: AppearanceMode,
    pub chat_width: ChatWidth,
    /// True while a sidebar row's inline rename input is open.
    pub renaming_thread: Option<ThreadId>,
}

impl ShellState {
    /// Threads of one project, pinned first then most-recently-updated first.
    /// Matches the ordering the sidebar relies on.
    pub fn threads_for_project(&self, project: &ProjectId) -> Vec<&ThreadSummary> {
        let mut rows: Vec<&ThreadSummary> = self
            .threads
            .iter()
            .filter(|t| t.project_id.as_ref() == Some(project))
            .collect();
        rows.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.updated_at_ms.cmp(&a.updated_at_ms))
        });
        rows
    }

    /// Pinned threads across all projects.
    pub fn pinned_threads(&self) -> Vec<&ThreadSummary> {
        let mut rows: Vec<&ThreadSummary> = self.threads.iter().filter(|t| t.pinned).collect();
        rows.sort_by_key(|t| std::cmp::Reverse(t.updated_at_ms));
        rows
    }

    pub fn thread(&self, id: &ThreadId) -> Option<&ThreadSummary> {
        self.threads.iter().find(|t| &t.id == id)
    }

    /// Total count of threads that are currently running, for the topbar badge.
    pub fn running_count(&self) -> usize {
        self.threads
            .iter()
            .filter(|t| t.status == ThreadStatus::Running)
            .count()
    }

    /// Opening a thread also records which environment now owns the view.
    pub fn open_thread(&mut self, thread: &ThreadId) {
        // Copy what we need out of the borrow before mutating `self`.
        let Some((environment_id, thread_id)) = self
            .thread(thread)
            .map(|t| (t.environment_id.clone(), t.id.clone()))
        else {
            return;
        };
        self.route = Route::Thread(ScopedThreadRef::new(environment_id.clone(), thread_id));
        self.active_environment = Some(environment_id);
    }

    pub fn open_settings(&mut self, page: SettingsPage) {
        self.route = Route::Settings(page);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, project: &str, pinned: bool, updated: i64) -> ThreadSummary {
        ThreadSummary {
            id: ThreadId::new(id),
            environment_id: EnvironmentId::new("env"),
            project_id: Some(ProjectId::new(project)),
            title: format!("thread {id}"),
            status: ThreadStatus::Idle,
            pinned,
            updated_at_ms: updated,
        }
    }

    fn shell() -> ShellState {
        ShellState {
            projects: vec![Project {
                id: ProjectId::new("p1"),
                name: "t3code".into(),
                path: "/tmp/t3code".into(),
            }],
            threads: vec![
                thread("a", "p1", false, 10),
                thread("b", "p1", false, 30),
                thread("c", "p1", true, 5),
                thread("d", "p2", false, 99),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn project_threads_sort_pinned_then_recent() {
        let s = shell();
        let got: Vec<_> = s
            .threads_for_project(&ProjectId::new("p1"))
            .iter()
            .map(|t| t.id.as_str().to_owned())
            .collect();
        assert_eq!(got, ["c", "b", "a"]);
    }

    #[test]
    fn pinned_threads_exclude_unpinned() {
        let s = shell();
        let got: Vec<_> = s
            .pinned_threads()
            .iter()
            .map(|t| t.id.as_str().to_owned())
            .collect();
        assert_eq!(got, ["c"]);
    }

    #[test]
    fn open_thread_sets_route_and_environment() {
        let mut s = shell();
        s.open_thread(&ThreadId::new("b"));
        assert_eq!(
            s.route,
            Route::Thread(ScopedThreadRef::new("env", "b"))
        );
        assert_eq!(s.active_environment, Some(EnvironmentId::new("env")));
    }

    #[test]
    fn settings_pages_cover_every_route_slug() {
        assert_eq!(SettingsPage::ALL.len(), 28);
        assert_eq!(SettingsPage::SourceControl.slug(), "source-control");
        assert_eq!(SettingsPage::OpenSourceLicenses.slug(), "open-source-licenses");
        // Labels and slugs must stay unique, or the settings nav collides.
        let mut labels: Vec<_> = SettingsPage::ALL.iter().map(|p| p.label()).collect();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), SettingsPage::ALL.len());
    }

    #[test]
    fn sidebar_toggle_is_idempotent_pair() {
        let mut st = SidebarState::default();
        let p = ProjectId::new("p1");
        assert!(!st.is_collapsed(&p));
        st.toggle_project(p.clone());
        assert!(st.is_collapsed(&p));
        st.toggle_project(p.clone());
        assert!(!st.is_collapsed(&p));
    }

    #[test]
    fn running_count_counts_only_running() {
        let mut s = shell();
        assert_eq!(s.running_count(), 0);
        s.threads[0].status = ThreadStatus::Running;
        s.threads[1].status = ThreadStatus::AwaitingInput;
        assert_eq!(s.running_count(), 1);
    }
}
