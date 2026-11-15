//! Interrupt or stop a thread on behalf of a scoped MCP caller.
use crate::{
    event_bus::EventBus, mcp_credentials::Scope, provider::session_registry::SessionRegistry,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::cell::RefCell;
type Failure = (&'static str, String);
fn rank(v: &str) -> Option<u8> {
    match v {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    }
}
fn authorize(tx: &Transaction<'_>, scope: &Scope, target: &str) -> Result<(), Failure> {
    let caller:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|("orchestration_error",e.to_string()))?;
    let (pr, pi) = caller.ok_or_else(|| {
        (
            "thread_not_found",
            "The calling thread was not found.".into(),
        )
    })?;
    if target != scope.thread_id {
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND r.run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=t.thread_id AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND r.provider_instance_id=?2)",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0)).map_err(|e|("orchestration_error",e.to_string()))?;
        if !valid {
            return Err((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            ));
        }
    }
    let row:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|("orchestration_error",e.to_string()))?;
    let (rt, it) = row.ok_or_else(|| ("thread_not_found", "The thread was not found.".into()))?;
    if rank(&pr).is_none() || rank(&rt).is_none() || rank(&rt) > rank(&pr) {
        return Err((
            "runtime_mode_escalation_denied",
            "The target thread exceeds the caller's runtime mode.".into(),
        ));
    }
    if !matches!(pi.as_str(), "plan" | "default")
        || !matches!(it.as_str(), "plan" | "default")
        || (pi == "plan" && it != "plan")
    {
        return Err((
            "interaction_mode_escalation_denied",
            "The target thread exceeds the caller's interaction mode.".into(),
        ));
    }
    crate::mcp_thread_organize::check_link(tx, scope, target)?;
    Ok(())
}
pub fn definition() -> Value {
    json!({"name":"t3_thread_interrupt","description":"Interrupt a top-level thread's running turn. No runId: newest running turn. No effect when idle. For a delegate, use task_cancel.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"runId":{"type":"string"},"reason":{"type":"string","maxLength":2000},"stop":{"type":"boolean"},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"required":["threadId"],"additionalProperties":false},"annotations":{"title":"Interrupt a T3 thread","readOnlyHint":false,"destructiveHint":true}})
}
pub fn call(
    bus: &EventBus,
    sessions: &SessionRegistry,
    scope: &Scope,
    args: &Value,
    now: &str,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    let invalid = || ("invalid_request", "Invalid interrupt arguments.".to_owned());
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| {
        ![
            "environmentId",
            "threadId",
            "runId",
            "reason",
            "stop",
            "clientRequestId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    let thread = args["threadId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let explicit = match o.get("runId") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.as_str()),
        _ => return Err(invalid()),
    };
    let stop = match o.get("stop") {
        None => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(invalid()),
    };
    let reason = match o.get("reason") {
        None => "Stopped by an agent".to_owned(),
        Some(Value::String(s)) if s.encode_utf16().count() <= 2000 => {
            format!("Stopped by an agent: {s}")
        }
        _ => return Err(invalid()),
    };
    let key = match o.get("clientRequestId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(s))
            if !s.trim().is_empty() && s.trim().encode_utf16().count() <= 256 =>
        {
            s.trim().to_owned()
        }
        _ => return Err(invalid()),
    };
    let operation = if stop {
        "thread-stop"
    } else {
        "thread-interrupt"
    };
    let command = format!(
        "command:mcp:{}:{operation}:{}",
        crate::message_commands::encode_id_part(&scope.provider_session_id),
        crate::message_commands::encode_id_part(&key)
    );
    let initial=bus.commit(|tx|{if let Err(error)=authorize(tx,scope,thread){return Ok((Err(error),vec![]));}let replay=crate::event_store::get_receipt(tx,&command,"thread")?;let requested=if let Some(id)=explicit.filter(|_| !stop) {let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![thread,id],|r|r.get(0)).optional()?;match raw {Some(raw)=>Some(serde_json::from_str::<Value>(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?),None=>return Ok((Err(("run_not_found",format!("Run {id} was not found on thread {thread}."))),vec![]))}}else{None};let active:Option<String>=tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[thread],|r|r.get(0)).optional()?;Ok((Ok((replay,requested,active)),vec![]))}).map_err(|e|("orchestration_error",e.to_string()))??;
    if let Some(receipt) = &initial.0 {
        if receipt.aggregate_id != thread {
            return Err((
                "orchestration_error",
                "The request ID was already used for another thread.".into(),
            ));
        }
        if receipt.status != "accepted" {
            return Err((
                "orchestration_error",
                receipt
                    .error
                    .clone()
                    .unwrap_or_else(|| "Interruption failed.".into()),
            ));
        }
        let run=bus.commit(|tx|{let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_events WHERE command_id=?1 AND stream_id=?2 AND ((event_type='run.updated' AND json_extract(payload_json,'$.status')='interrupted') OR (event_type='turn-item.updated' AND json_extract(payload_json,'$.type')='run_interrupt_request' AND (?3=0 OR json_extract(payload_json,'$.providerTurnId') IS NOT NULL))) ORDER BY sequence LIMIT 1",params![command,thread,stop],|r|r.get(0)).optional()?;let id=raw.and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v["runId"].as_str().or_else(||v["id"].as_str()).map(str::to_owned));Ok((id,vec![]))}).map_err(|e|("orchestration_error",e.to_string()))?;
        return Ok(
            json!({"threadId":thread,"runId":run,"status":if run.is_some(){"interrupt_requested"}else{"no_active_run"}}),
        );
    }
    if !stop && initial.0.is_none() {
        if let Some(run) = initial.1.as_ref() {
            if matches!(
                run["status"].as_str(),
                Some("completed" | "failed" | "cancelled" | "interrupted" | "rolled_back")
            ) {
                return Ok(json!({"threadId":thread,"runId":run["id"],"status":run["status"]}));
            }
        }
        if initial.2.is_none() && explicit.is_none() {
            return Ok(json!({"threadId":thread,"runId":null,"status":"no_active_run"}));
        }
        if explicit.is_some() && explicit != initial.2.as_deref() {
            return Err((
                "thread_not_interruptible",
                format!("Thread {thread} has no matching active run."),
            ));
        }
    }
    let selected = if stop {
        None
    } else {
        initial.2.as_deref().or(explicit)
    };
    let denied = RefCell::new(None::<Failure>);
    let guard = |tx: &Transaction<'_>| {
        if let Err(f) = authorize(tx, scope, thread) {
            *denied.borrow_mut() = Some(f);
            return Err(rusqlite::Error::InvalidQuery);
        }
        if !stop && initial.0.is_none() {
            let latest:Option<String>=tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[thread],|r|r.get(0)).optional()?;
            if latest.as_deref() != selected {
                *denied.borrow_mut() = Some((
                    "thread_not_interruptible",
                    "The active run changed before interruption.".into(),
                ));
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        Ok(())
    };
    let result = crate::interrupt_commands::interrupt_checked(
        bus,
        sessions,
        &command,
        thread,
        selected,
        Some(&reason),
        stop,
        now,
        guard,
    )
    .map_err(|e| {
        denied.into_inner().unwrap_or_else(|| {
            (
                "orchestration_error",
                format!("Unable to interrupt thread {thread}: {e}"),
            )
        })
    })?;
    if result.receipt.status != "accepted" {
        return Err((
            "orchestration_error",
            if stop {
                format!("Unable to stop thread {thread}.")
            } else {
                result
                    .receipt
                    .error
                    .unwrap_or_else(|| "Interruption failed.".into())
            },
        ));
    }
    if !stop {
        return Ok(json!({"threadId":thread,"runId":selected,"status":"interrupt_requested"}));
    }
    let interrupted=bus.commit(|tx| {let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_events WHERE command_id=?1 AND stream_id=?2 AND ((event_type='run.updated' AND json_extract(payload_json,'$.status')='interrupted') OR (event_type='turn-item.updated' AND json_extract(payload_json,'$.type')='run_interrupt_request' AND json_extract(payload_json,'$.providerTurnId') IS NOT NULL)) ORDER BY sequence LIMIT 1",params![command,thread],|r|r.get(0)).optional()?;let run=raw.and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v["runId"].as_str().or_else(||v["id"].as_str()).map(str::to_owned));Ok((run,vec![]))}).map_err(|e|("orchestration_error",e.to_string()))?;
    Ok(
        json!({"threadId":thread,"runId":interrupted,"status":if interrupted.is_some(){"interrupt_requested"}else{"no_active_run"}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn stop_is_idempotent_and_checks_caller_modes() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        for (id, mode) in [
            ("caller", "auto"),
            ("target", "auto"),
            ("high", "full-access"),
        ] {
            let selection = json!({"instanceId":"codex","model":"m"});
            let source = json!("web");
            crate::thread_commands::create_thread_ordered(
                &bus,
                crate::thread_commands::CreateThread {
                    command_id: &format!("create-{id}"),
                    thread_id: id,
                    project_id: "p",
                    title: id,
                    model_selection: &selection,
                    runtime_mode: mode,
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &source,
                    link_origin: None,
                    delegated_from: None,
                },
                &format!("event-{id}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        for id in ["caller", "target"] {
            crate::message_commands::dispatch_first_message(
                &bus,
                crate::message_commands::DispatchMessage {
                    context: None,
                    command_id: &format!("send-{id}"),
                    thread_id: id,
                    message_id: &format!("message-{id}"),
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:01Z",
            )
            .unwrap();
        }
        let scope = Scope {
            thread_id: "caller".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let sessions = SessionRegistry::default();
        let args =
            json!({"threadId":"target","stop":true,"runId":"ignored","clientRequestId":"key"});
        let first = call(&bus, &sessions, &scope, &args, "2026-01-01T00:00:02Z").unwrap();
        assert_eq!(first["status"], "interrupt_requested");
        assert!(first["runId"].is_string());
        assert_eq!(
            call(&bus, &sessions, &scope, &args, "2026-01-01T00:00:03Z").unwrap(),
            first
        );
        assert_eq!(
            call(&bus, &sessions, &scope, &json!({"threadId":"high"}), "now")
                .unwrap_err()
                .0,
            "runtime_mode_escalation_denied"
        );
    }
}
