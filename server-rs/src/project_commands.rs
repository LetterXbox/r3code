//! Pure planning for project creation and deletion.
//! Callers must decode command schemas and serialize the resulting event/receipt
//! in a single write transaction before exposing these operations over RPC.
use crate::event_store::Event;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectRejection {
    AlreadyExists {
        project_id: String,
    },
    WorkspaceConflict {
        workspace_root: String,
        conflicting_project_id: String,
    },
    MissingProject {
        project_id: String,
        command_type: &'static str,
    },
}
impl std::fmt::Display for ProjectRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyExists { project_id } => write!(f, "Project '{project_id}' already exists and cannot be created twice."),
            Self::WorkspaceConflict { workspace_root, conflicting_project_id } => write!(f, "Active project '{conflicting_project_id}' already exists for workspace root '{workspace_root}'."),
            Self::MissingProject { project_id, command_type } => write!(f, "Project '{project_id}' does not exist for command '{command_type}'."),
        }
    }
}
impl std::error::Error for ProjectRejection {}

pub struct CreateProject<'a> {
    pub command_id: &'a str,
    pub project_id: &'a str,
    pub title: &'a str,
    pub workspace_root: &'a str,
    pub scripts: Option<&'a [Value]>,
}

/// Both `project_exists` and `workspace_owner` must be read under the same
/// serialized write transaction as the commit, including deleted project IDs.
pub fn plan_create(
    command: CreateProject<'_>,
    event_id: &str,
    now: &str,
    project_exists: bool,
    workspace_owner: Option<&str>,
) -> Result<Event, ProjectRejection> {
    if project_exists {
        return Err(ProjectRejection::AlreadyExists {
            project_id: command.project_id.into(),
        });
    }
    if let Some(owner) = workspace_owner.filter(|owner| *owner != command.project_id) {
        return Err(ProjectRejection::WorkspaceConflict {
            workspace_root: command.workspace_root.into(),
            conflicting_project_id: owner.into(),
        });
    }
    Ok(Event {
        id: event_id.into(),
        aggregate_kind: "project".into(),
        stream_id: command.project_id.into(),
        event_type: "project.created".into(),
        occurred_at: now.into(),
        command_id: Some(command.command_id.into()),
        causation_event_id: None,
        correlation_id: Some(command.command_id.into()),
        actor_kind: actor_kind(command.command_id).into(),
        payload: json!({"projectId":command.project_id,"title":command.title,"workspaceRoot":command.workspace_root,"defaultModelSelection":null,"faviconPath":null,"projectIcon":null,"scripts":command.scripts.unwrap_or(&[]),"createdAt":now,"updatedAt":now}),
        metadata: json!({}),
    })
}

pub fn plan_delete(
    project_id: &str,
    command_id: &str,
    event_id: &str,
    now: &str,
    active_project: bool,
) -> Result<Event, ProjectRejection> {
    if !active_project {
        return Err(ProjectRejection::MissingProject {
            project_id: project_id.into(),
            command_type: "project.delete",
        });
    }
    Ok(Event {
        id: event_id.into(),
        aggregate_kind: "project".into(),
        stream_id: project_id.into(),
        event_type: "project.deleted".into(),
        occurred_at: now.into(),
        command_id: Some(command_id.into()),
        causation_event_id: None,
        correlation_id: Some(command_id.into()),
        actor_kind: actor_kind(command_id).into(),
        payload: json!({"projectId":project_id,"deletedAt":now}),
        metadata: json!({}),
    })
}
fn actor_kind(command_id: &str) -> &'static str {
    if command_id.starts_with("provider:") {
        "provider"
    } else if command_id.starts_with("server:") {
        "server"
    } else {
        "client"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command() -> CreateProject<'static> {
        CreateProject {
            command_id: "cmd",
            project_id: "p",
            title: "Project",
            workspace_root: "/work",
            scripts: None,
        }
    }
    #[test]
    fn create_enforces_guard_order_and_builds_exact_payload() {
        let failure = plan_create(
            command(),
            "event",
            "2026-01-01T00:00:00.000Z",
            true,
            Some("other"),
        )
        .unwrap_err();
        assert_eq!(
            failure.to_string(),
            "Project 'p' already exists and cannot be created twice."
        );
        let failure = plan_create(
            command(),
            "event",
            "2026-01-01T00:00:00.000Z",
            false,
            Some("other"),
        )
        .unwrap_err();
        assert_eq!(
            failure.to_string(),
            "Active project 'other' already exists for workspace root '/work'."
        );
        let event =
            plan_create(command(), "event", "2026-01-01T00:00:00.000Z", false, None).unwrap();
        assert_eq!(
            event.payload,
            json!({"projectId":"p","title":"Project","workspaceRoot":"/work","defaultModelSelection":null,"faviconPath":null,"projectIcon":null,"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"})
        );
        assert_eq!(event.correlation_id.as_deref(), Some("cmd"));
    }
    #[test]
    fn delete_requires_active_project() {
        assert_eq!(
            plan_delete("p", "server:c", "e", "now", false)
                .unwrap_err()
                .to_string(),
            "Project 'p' does not exist for command 'project.delete'."
        );
        let event = plan_delete("p", "server:c", "e", "now", true).unwrap();
        assert_eq!(event.actor_kind, "server");
        assert_eq!(event.payload, json!({"projectId":"p","deletedAt":"now"}));
    }
}
