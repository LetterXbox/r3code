//! The shared, non-Git scratch project used for conversations without a project.
use crate::{event_bus::EventBus, project_commands::CreateProject, project_sink};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn folder_for_thread(
    base: &Path,
    project: &str,
    id: &str,
    text: &str,
) -> Result<Option<PathBuf>, String> {
    let scratch = base.join("scratch");
    let expected = std::fs::canonicalize(&scratch).unwrap_or_else(|_| scratch.clone());
    let actual = std::fs::canonicalize(project).unwrap_or_else(|_| PathBuf::from(project));
    if actual != expected {
        return Ok(None);
    }
    match std::process::Command::new("git")
        .args([
            "-C",
            &base.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
    {
        Ok(o) if o.status.success() => return Ok(None),
        Ok(o) if !String::from_utf8_lossy(&o.stderr).contains("not a git repository") => {
            return Ok(None)
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Ok(None),
        _ => (),
    }
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let words = text
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(48)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned();
    let id: String = id
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let suffix = &id[id.len().saturating_sub(8)..];
    for attempt in 0..3 {
        let part = match attempt {
            0 => suffix.to_owned(),
            1 => id.clone(),
            _ => format!("{}-{}", id, &uuid::Uuid::new_v4().to_string()[..8]),
        };
        let name = [date.as_str(), words.as_str(), part.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let folder = scratch.join(name);
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(Some(folder)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Unable to claim scratch folder".into())
}
fn owner(bus: &EventBus, path: &Path) -> Result<Option<String>, String> {
    bus.with_autocommit(|db|db.query_row("SELECT project_id FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL LIMIT 1",[path.to_string_lossy().as_ref()],|r|r.get(0)).optional()).map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
pub(crate) fn ensure(bus: &EventBus, base: &Path) -> Result<Value, Value> {
    let _guard=LOCK.get_or_init(||Mutex::new(())).lock().map_err(|_|json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the project for threads without a project."}))?;
    let probe = std::process::Command::new("git")
        .args([
            "-C",
            &base.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output();
    match probe {
        Ok(o) if o.status.success() => {
            let root = String::from_utf8_lossy(&o.stdout).trim().to_owned();
            let message=format!("Threads without a project are off because the T3 home {} is inside the Git repository {}. If that repository was created by mistake, move {}/.git out of the way; otherwise point T3CODE_HOME (or --base-dir) at a folder outside it. Then restart T3 Code.",base.display(),root,root);
            return Err(
                json!({"_tag":"OrchestrationDispatchCommandError","message":message,"cause":{"name":"ScratchUnavailableError","message":message}}),
            );
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(
                json!({"_tag":"OrchestrationDispatchCommandError","message":"Threads without a project are not available on this environment."}),
            )
        }
        Ok(o) if !String::from_utf8_lossy(&o.stderr).contains("not a git repository") => {
            let message = "Threads without a project are not available on this environment.";
            return Err(
                json!({"_tag":"OrchestrationDispatchCommandError","message":message,"cause":{"name":"ScratchUnavailableError","message":message}}),
            );
        }
        _ => (),
    }
    let scratch = base.join("scratch");
    std::fs::create_dir_all(&scratch).map_err(|_|json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the folder for threads without a project."}))?;
    let resolved = std::fs::canonicalize(&scratch).unwrap_or_else(|_| scratch.clone());
    let workspace: PathBuf =
        if resolved != scratch && owner(bus, &resolved).ok().flatten().is_some() {
            resolved
        } else {
            scratch
        };
    if let Some(id)=owner(bus,&workspace).map_err(|_|json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the project for threads without a project."}))?{return Ok(json!({"projectId":id}));}
    let id = uuid::Uuid::new_v4().to_string();
    let cmd = format!("scratch-project:{id}");
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let created=project_sink::create_project_ordered(bus,CreateProject{command_id:&cmd,project_id:&id,title:"No project",workspace_root:&workspace.to_string_lossy(),scripts:None},&uuid::Uuid::new_v4().to_string(),&now).map_err(|_|json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the project for threads without a project."}))?;
    if created.receipt.status != "accepted" {
        if let Some(winner) = owner(bus, &workspace).ok().flatten() {
            return Ok(json!({"projectId":winner}));
        }
        return Err(
            json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the project for threads without a project."}),
        );
    }
    let icon =
        json!({"projectIcon":{"kind":"lucide","name":"message-square-dashed","color":"gray"}});
    crate::project_update::dispatch(bus,&format!("scratch-project-icon:{id}"),&id,&icon,&now).map_err(|_|json!({"_tag":"OrchestrationDispatchCommandError","message":"Failed to create the project for threads without a project."}))?;
    Ok(json!({"projectId":id}))
}
