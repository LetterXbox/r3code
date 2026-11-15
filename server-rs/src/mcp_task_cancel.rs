//! Scoped MCP cancellation of local delegated tasks.
use crate::{
    delegated_cancel, event_bus::EventBus, mcp_credentials::Scope,
    provider::session_registry::SessionRegistry,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

type Failure = (&'static str, String);
fn failure(message: impl Into<String>) -> Failure {
    ("orchestration_error", message.into())
}
fn part(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Cancel a local task owned by the calling thread. `client_request_id` makes
/// retries stable; omit it for a fresh cancellation attempt.
pub fn call(
    bus: &EventBus,
    sessions: &SessionRegistry,
    scope: &Scope,
    task_id: &str,
    reason: Option<&str>,
    client_request_id: Option<&str>,
    now: &str,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    if task_id.trim().is_empty() {
        return Err(("invalid_request", "taskId is required.".into()));
    }
    if client_request_id.is_some_and(|s| s.trim().is_empty()) {
        return Err(("invalid_request", "Invalid clientRequestId.".into()));
    }
    let not_found = || {
        (
            "task_not_found",
            format!(
                "Delegated task {task_id} does not belong to thread {}.",
                scope.thread_id
            ),
        )
    };
    let (task, active) = bus.commit(|tx| {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned'", [&scope.thread_id, task_id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { return Ok((None, vec![])); };
        let task: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let active = if let Some(child) = task["childThreadId"].as_str() {
            tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND (status IN ('preparing','starting','running','waiting') OR (status='queued' AND (json_extract(payload_json,'$.delegatedTaskId')=?2 OR run_id=?3))))", rusqlite::params![child, task_id, task["childRunId"].as_str().unwrap_or("")], |r| r.get(0))?
        } else { false };
        Ok((Some((task, active)), vec![]))
    }).map_err(|e| failure(e.to_string()))?.ok_or_else(not_found)?;
    if task["id"] != task_id || task["threadId"] != scope.thread_id {
        return Err(not_found());
    }
    let Some(child) = task["childThreadId"].as_str() else {
        return if task["remoteChild"].is_object() {
            Err((
                "task_not_cancellable",
                "Remote task cancellation is not supported.".into(),
            ))
        } else {
            Err(not_found())
        };
    };
    let key = client_request_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let command = format!(
        "mcp:cancel-task:{}:{}:{}",
        part(&scope.thread_id),
        part(task_id),
        part(&key)
    );
    let terminal = task["status"]
        .as_str()
        .filter(|s| matches!(*s, "completed" | "failed" | "cancelled" | "interrupted"));
    // The local primitive marks the task's selected run as cancelled; applying it
    // to a completed task with later work would corrupt the completed result.
    if let Some(status) = terminal {
        if active {
            return Err(("task_not_cancellable", format!("Unable to stop delegated task {task_id}: stopping later work on a terminal task is not supported.")));
        }
        // Validate lineage even when there is no work to stop.
        let valid = bus.commit(|tx| {
            let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND json_extract(payload_json,'$.lineage.parentThreadId')=?2 AND json_extract(payload_json,'$.lineage.relationshipToParent')='subagent')", [child, &scope.thread_id], |r| r.get(0))?;
            Ok((valid, vec![]))
        }).map_err(|e| failure(e.to_string()))?;
        if !valid {
            return Err(not_found());
        }
        crate::delegated_ack::dispose(
            bus,
            &format!("{command}:dispose"),
            &scope.thread_id,
            task_id,
            now,
        )
        .map_err(|e| {
            failure(format!(
                "Unable to dispose delegated task {task_id} completion delivery: {e}"
            ))
        })?;
        return Ok(json!({"taskId":task_id,"status":status}));
    }
    let stop_reason = match reason.map(str::trim).filter(|s| !s.is_empty()) {
        Some(reason) => format!("Stopped by an agent: {reason}"),
        None => "Stopped by an agent".into(),
    };
    let result = delegated_cancel::cancel_local(
        bus,
        sessions,
        &command,
        &scope.thread_id,
        task_id,
        child,
        &stop_reason,
        now,
    )
    .map_err(|e| {
        (
            "task_not_cancellable",
            format!("Unable to stop delegated task {task_id}: {e}"),
        )
    })?;
    if result.receipt.status != "accepted" {
        let message = result
            .receipt
            .error
            .unwrap_or_else(|| "Cancellation was rejected.".into());
        if message.contains("does not belong to thread") {
            return Err(not_found());
        }
        if message.starts_with("Child runtime mode") {
            return Err(("runtime_mode_escalation_denied", message));
        }
        if message.starts_with("Child interaction mode") {
            return Err(("interaction_mode_escalation_denied", message));
        }
        if message.contains("has no interruptible child run") {
            return Err(("task_not_cancellable", message));
        }
        return Err((
            "task_not_cancellable",
            format!("Unable to stop delegated task {task_id}: {message}"),
        ));
    }
    Ok(json!({"taskId":task_id,"status":"cancel_requested"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    fn setup() -> (EventBus, Scope) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('parent','p','Parent','codex','full-access','default','now','now','{}')", []).unwrap();
        let child = json!({"id":"child","lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"}});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('child','p','Child','codex','full-access','default','now','now',?1)", [child.to_string()]).unwrap();
        let task = json!({"id":"task","threadId":"parent","childThreadId":"child","childRunId":"run","status":"running"});
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('task','parent','node','codex','child','app_owned','running','now',?1)", [task.to_string()]).unwrap();
        let run = json!({"id":"run","threadId":"child","status":"queued","delegatedTaskId":"task"});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('run','child',1,'codex','queued','now',?1)", [run.to_string()]).unwrap();
        (
            EventBus::new(db, 16),
            Scope {
                thread_id: "parent".into(),
                provider_session_id: "s".into(),
                provider_instance_id: "p".into(),
                capabilities: HashSet::from(["orchestration".into()]),
                subagent: false, client: None,
            },
        )
    }
    #[test]
    fn cancellation_is_scoped_and_replayed() {
        let (bus, mut scope) = setup();
        let sessions = SessionRegistry::default();
        scope.thread_id = "other".into();
        assert_eq!(
            call(&bus, &sessions, &scope, "task", None, Some("key"), "now")
                .unwrap_err()
                .0,
            "task_not_found"
        );
        scope.thread_id = "parent".into();
        let expected = json!({"taskId":"task","status":"cancel_requested"});
        assert_eq!(
            call(
                &bus,
                &sessions,
                &scope,
                "task",
                Some("done"),
                Some("key"),
                "now"
            )
            .unwrap(),
            expected
        );
        assert_eq!(
            call(
                &bus,
                &sessions,
                &scope,
                "task",
                Some("done"),
                Some("key"),
                "now"
            )
            .unwrap(),
            expected
        );
    }
    #[test]
    fn terminal_result_is_preserved_and_active_later_work_is_rejected() {
        let (bus, scope) = setup();
        let sessions = SessionRegistry::default();
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_subagents SET status='completed', payload_json=json_set(payload_json,'$.status','completed','$.result','answer') WHERE subagent_id='task'",[])?; Ok(((),vec![]))}).unwrap();
        assert_eq!(
            call(&bus, &sessions, &scope, "task", None, None, "now")
                .unwrap_err()
                .0,
            "task_not_cancellable"
        );
        bus.commit(|tx| {
            tx.execute(
                "UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='run'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert_eq!(
            call(&bus, &sessions, &scope, "task", None, None, "now").unwrap()["status"],
            "completed"
        );
        bus.commit(|tx| {let result:String=tx.query_row("SELECT json_extract(payload_json,'$.result') FROM orchestration_v2_projection_subagents WHERE subagent_id='task'",[],|r|r.get(0))?; assert_eq!(result,"answer"); Ok(((),vec![]))}).unwrap();
    }
}
