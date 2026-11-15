//! Event-driven wait and wake-policy upgrade for delegated MCP tasks.
use crate::{
    delegated_ack,
    event_bus::{BusError, EventBus, Filter},
    event_store::{self, Event, Receipt},
    mcp_credentials::Scope,
    mcp_task_status,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Failure = (&'static str, String);
fn terminal(v: &Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted")
    )
}
fn ends_wait(v: &Value) -> bool {
    terminal(v) || v["hasPendingQuestion"] == true || !v["pendingApproval"].is_null()
}

// A dropped future must still make the child's eventual result wake its parent.
struct WakeOnDrop {
    bus: EventBus,
    thread: String,
    task: String,
    command: String,
    armed: bool,
}
impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        if self.armed {
            if let Err(e) = upgrade_wake(&self.bus, &self.thread, &self.task, &self.command) {
                eprintln!("orchestrator-mcp.delegate-task.wake-policy-failed: {e}");
            }
        }
    }
}
fn upgrade_wake(
    bus: &EventBus,
    thread: &str,
    task_id: &str,
    command: &str,
) -> Result<(), BusError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command, "thread")? {
            if receipt.aggregate_id != thread || receipt.status != "accepted" { return Err(rusqlite::Error::InvalidQuery); }
            return Ok(((), vec![]));
        }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned'", params![thread, task_id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { return Err(rusqlite::Error::InvalidQuery); };
        let mut task: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        task["completionWake"] = json!("always");
        task["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_subagents SET updated_at=?3,payload_json=?4 WHERE thread_id=?1 AND subagent_id=?2", params![thread, task_id, now, task.to_string()])?;
        let mut changed = vec![("subagent.updated", task.clone())];
        // A result may settle between the last read and this policy upgrade.
        delegated_ack::plan_unobserved(tx, thread, &mut task, &now, &mut changed)?;
        let events: Vec<Event> = changed.into_iter().map(|(kind, payload)| Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind: "thread".into(), stream_id: thread.into(), event_type: kind.into(), occurred_at: now.clone(), command_id: Some(command.into()), causation_event_id: None, correlation_id: Some(command.into()), actor_kind: "client".into(), payload, metadata: json!({}) }).collect();
        let stored = event_store::append(tx, &events)?;
        let receipt = Receipt { command_id: command.into(), aggregate_kind: "thread".into(), aggregate_id: thread.into(), command_type: "delegated_task.wake-policy".into(), accepted_at: now.clone(), result_sequence: stored.last().unwrap().sequence, status: "accepted".into(), error: None };
        event_store::insert_receipt_if_absent(tx, &receipt)?;
        Ok(((), stored))
    })
}

/// Wait for a task's terminal result, pending question, or approval. On timeout,
/// return the latest status with `waitTimedOut`; on every nonterminal exit the
/// wake policy is upgraded, including if this future is dropped.
pub async fn await_task(
    db: &Arc<Mutex<Connection>>,
    bus: &EventBus,
    scope: &Scope,
    task_id: &str,
    request_key: &str,
    timeout_ms: Option<u64>,
    environment_id: &str,
) -> Result<Value, Failure> {
    let mut guard = WakeOnDrop {
        bus: bus.clone(),
        thread: scope.thread_id.clone(),
        task: task_id.into(),
        command: format!("mcp:delegate-task-wake-policy:{request_key}"),
        armed: true,
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(240_000).clamp(1, 3_600_000));
    let cursor = {
        let conn = db.lock().map_err(|_| {
            (
                "orchestration_error",
                "The operation could not be completed.".into(),
            )
        })?;
        event_store::latest_thread_sequence(&conn, None)
            .map_err(|e| ("orchestration_error", e.to_string()))?
    };
    let mut sub = bus.subscribe(cursor, Filter::default()).map_err(|e| {
        (
            "orchestration_error",
            format!("Unable to watch delegated task {task_id}: {e}"),
        )
    })?;
    let initial = mcp_task_status::call(db, bus, scope, task_id, environment_id)?;
    if ends_wait(&initial) {
        if terminal(&initial) {
            guard.armed = false;
        }
        return Ok(initial);
    }
    let child = initial["childThreadId"].as_str().map(str::to_owned);
    let wait = async {
        loop {
            let ev = match sub.next().await {
                Ok(ev) => ev,
                Err(BusError::Lagged(_)) => {
                    sub = bus
                        .subscribe(sub.cursor(), Filter::default())
                        .map_err(|e| {
                            (
                                "orchestration_error",
                                format!("Unable to watch delegated task {task_id}: {e}"),
                            )
                        })?;
                    continue;
                }
                Err(e) => {
                    return Err((
                        "orchestration_error",
                        format!("Unable to watch delegated task {task_id}: {e}"),
                    ))
                }
            };
            let parent_event = ev.event.stream_id == scope.thread_id
                && ev.event.event_type == "subagent.updated"
                && ev.event.payload["id"] == task_id;
            let child_event = child.as_deref() == Some(ev.event.stream_id.as_str())
                && matches!(
                    ev.event.event_type.as_str(),
                    "run.updated"
                        | "subagent.updated"
                        | "provider-thread.updated"
                        | "runtime-request.updated"
                );
            if parent_event || child_event {
                let value = mcp_task_status::call(db, bus, scope, task_id, environment_id)?;
                if ends_wait(&value) {
                    return Ok(value);
                }
            }
        }
    };
    match tokio::time::timeout(timeout, wait).await {
        Ok(Ok(value)) if terminal(&value) => {
            guard.armed = false;
            Ok(value)
        }
        Ok(Ok(_)) => {
            drop(guard);
            mcp_task_status::call(db, bus, scope, task_id, environment_id)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            drop(guard);
            let mut value = mcp_task_status::call(db, bus, scope, task_id, environment_id)?;
            value["waitTimedOut"] = json!(true);
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wake_upgrade_is_durable_and_replayed() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let task = json!({"id":"task","threadId":"parent","origin":"app_owned","status":"running","completionWake":"settled_only"});
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('task','parent','n','codex','app_owned','running','now',?1)", [task.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        upgrade_wake(&bus, "parent", "task", "command").unwrap();
        upgrade_wake(&bus, "parent", "task", "command").unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='task'", [], |r| r.get(0))?;
            let task: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(task["completionWake"], "always");
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE command_id='command'", [], |r| r.get(0))?;
            assert_eq!(count, 1);
            Ok(((), vec![]))
        }).unwrap();
    }
}
