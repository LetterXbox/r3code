//! Transactional lifecycle commands for existing V2 threads.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub enum Lifecycle<'a> {
    Archive,
    Unarchive,
    Settle {
        expected_latest_run_id: Option<&'a str>,
        settled_at: Option<&'a str>,
    },
    Unsettle,
}

/// Schema validation (including timestamps and the unsettle reason) belongs to the caller.
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: Lifecycle<'_>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, command, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: Lifecycle<'_>,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    let (kind, event_type) = match command {
        Lifecycle::Archive => ("thread.archive", "thread.archived"),
        Lifecycle::Unarchive => ("thread.unarchive", "thread.unarchived"),
        Lifecycle::Settle { .. } => ("thread.settle", "thread.settled"),
        Lifecycle::Unsettle => ("thread.unsettle", "thread.unsettled"),
    };
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [thread_id], |r| r.get(0)).optional()?;
        let mut error = raw.is_none().then(|| format!("Thread {thread_id} does not exist."));
        if error.is_none() {
            if let Lifecycle::Settle { expected_latest_run_id, .. } = command {
                let latest: Option<String> = tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal DESC LIMIT 1", [thread_id], |r| r.get(0)).optional()?;
                if expected_latest_run_id.is_some_and(|id| latest.as_deref() != Some(id)) {
                    error = Some("The thread received another run before settlement.".into());
                } else {
                    let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' AND NOT (kind='user_input' AND COALESCE(json_extract(payload_json,'$.responseCapability.type'),'')='message'))", [thread_id], |r| r.get(0))?;
                    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))", [thread_id], |r| r.get(0))?;
                    let queued: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status='queued' AND NOT (COALESCE(m.role,'')='user' AND (COALESCE(json_type(m.payload_json,'$.notification'),'null') != 'null' OR COALESCE(json_type(m.payload_json,'$.delegatedCompletion'),'null') != 'null')))", [thread_id], |r| r.get(0))?;
                    error = if pending { Some(format!("Thread {thread_id} is waiting on an approval or question. Answer it before settling.")) } else if active { Some(format!("Thread {thread_id} is still running. Stop it before settling.")) } else if queued { Some(format!("Thread {thread_id} has a queued message. Send it or remove it from the queue before settling.")) } else { None };
                }
            }
        }
        let mut receipt = Receipt { command_id:command_id.into(), aggregate_kind:"thread".into(), aggregate_id:thread_id.into(), command_type:kind.into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?, status:if error.is_some(){"rejected"}else{"accepted"}.into(), error };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if receipt.error.is_some() { return Ok((CommitResult { receipt, committed:false }, vec![])); }
        let mut events = Vec::new();
        if matches!(command, Lifecycle::Settle { .. }) {
            // Resolve dismissible questions and cancel automatic queued sends in this same
            // transaction, after all blockers have been checked.
            let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' ORDER BY created_at,runtime_request_id")?;
            let requests = stmt.query_map([thread_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for raw in requests {
                let mut request: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                let id = request["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                let node_id = request["nodeId"].as_str().unwrap_or("").to_owned();
                request["status"] = json!("resolved"); request["resolvedAt"] = json!(now); request["decision"] = json!("cancel");
                tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='resolved',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1", params![id,now,request.to_string()])?;
                events.push(("runtime-request.updated", request));
                cancel_related(tx, "orchestration_v2_projection_nodes", "node_id", &node_id, "node.updated", now, &mut events)?;
                let mut items = tx.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND (json_extract(payload_json,'$.requestId')=?2 OR json_extract(payload_json,'$.question.requestId')=?2) ORDER BY ordinal")?;
                let ids = items.query_map(params![thread_id,id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?; drop(items);
                for item in ids { cancel_related(tx, "orchestration_v2_projection_turn_items", "turn_item_id", &item, "turn-item.updated", now, &mut events)?; }
            }
            let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' ORDER BY ordinal")?;
            let runs = stmt.query_map([thread_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
            for raw in runs {
                let mut run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                let id = run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                let message: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1", [run["userMessageId"].as_str().unwrap_or("")], |r| r.get(0)).optional()?;
                if let Some(parent) = message.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()).and_then(|m| m["delegatedCompletion"]["parentRunId"].as_str().map(str::to_owned)) {
                    dispose_cohort(tx, thread_id, &parent, now, &mut events)?;
                }
                run["status"]=json!("cancelled"); run["queuePosition"]=Value::Null; run["completedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',payload_json=?2 WHERE run_id=?1",params![id,run.to_string()])?;
                let attempt = run["activeAttemptId"].as_str().unwrap_or("").to_owned();
                let node = run["rootNodeId"].as_str().unwrap_or("").to_owned();
                events.push(("run.updated", run));
                cancel_related(tx, "orchestration_v2_projection_run_attempts", "attempt_id", &attempt, "run-attempt.updated", now, &mut events)?;
                cancel_related(tx, "orchestration_v2_projection_nodes", "node_id", &node, "node.updated", now, &mut events)?;
                let mut stmt = tx.prepare("SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND type='user_message' ORDER BY ordinal")?;
                let ids = stmt.query_map([&id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
                for item in ids { cancel_related(tx, "orchestration_v2_projection_turn_items", "turn_item_id", &item, "turn-item.updated", now, &mut events)?; }
            }
        }
        let mut thread: Value = serde_json::from_str(&raw.unwrap()).map_err(|_| rusqlite::Error::InvalidQuery)?;
        match command {
            Lifecycle::Archive => { thread["archivedAt"]=json!(now); thread["titleRegeneration"]=Value::Null; thread["guestShare"]=Value::Null; thread["updatedAt"]=json!(now); }
            Lifecycle::Unarchive => { thread["archivedAt"]=Value::Null; thread["updatedAt"]=json!(now); }
            Lifecycle::Settle { settled_at, .. } => {
                let already = thread["settledOverride"] == "settled" && !thread["settledAt"].is_null() && thread["pinnedAt"].is_null();
                if !already { thread["settledAt"]=json!(settled_at.unwrap_or(now)); }
                if !already || !thread["snoozedUntil"].is_null() || !thread["snoozedAt"].is_null() { thread["updatedAt"]=json!(now); }
                thread["settledOverride"]=json!("settled");
                for field in ["unsettledAt", "pinnedAt", "pinOrderKey", "activeOrderKey", "snoozedUntil", "snoozedAt"] { thread[field]=Value::Null; }
            }
            Lifecycle::Unsettle => { let already = thread["settledOverride"] == "active"; thread["settledOverride"]=json!("active"); thread["settledAt"]=Value::Null; if !already { thread["unsettledAt"]=json!(now); thread["updatedAt"]=json!(now); } }
        }
        if matches!(command, Lifecycle::Archive | Lifecycle::Settle { .. }) { if let Some(links)=thread["pullRequests"].as_array_mut() { for link in links { if let Some(object)=link.as_object_mut() { if let Some(watch)=object.remove("watch") { object.insert("endedWatch".into(), watch); } } } } }
        tx.execute("UPDATE orchestration_v2_projection_threads SET archived_at=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1", params![thread_id,thread["archivedAt"].as_str(),thread["updatedAt"].as_str(),thread.to_string()])?;
        events.push((event_type, thread));
        if matches!(command, Lifecycle::Archive | Lifecycle::Settle { .. }) {
            let reason = if matches!(command, Lifecycle::Archive) { "Thread archived." } else { "Thread settled." };
            let mut stmt = tx.prepare("SELECT s.provider_session_id FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.status NOT IN ('stopped','error') ORDER BY s.updated_at,s.provider_session_id")?;
            let ids = stmt.query_map([thread_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
            for id in ids {
                tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2", params![thread_id,id])?;
                events.push(("provider-session.detached", json!({"providerSessionId":id,"detachedAt":now,"reason":reason})));
                let mut request = json!({"type":"provider-session.detach","providerSessionId":id,"detail":reason});
                if matches!(command, Lifecycle::Archive) { request["revokeMcpCredential"] = json!(true); }
                outbox::enqueue(tx, &Effect { id:format!("effect:{command_id}:provider-session.detach:{id}"), command_id:command_id.into(), thread_id:thread_id.into(), request, status:"pending".into(), attempt_count:0, available_at:now.into(), lease_owner:None, created_at:now.into(), updated_at:now.into(), completed_at:None, last_error:None })?;
            }
        }
        let events: Vec<Event> = events.into_iter().map(|(event_type, payload)| Event { id:uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:thread_id.into(), event_type:event_type.into(), occurred_at:now.into(), command_id:Some(command_id.into()), causation_event_id:None, correlation_id:Some(command_id.into()), actor_kind:"client".into(), payload, metadata:json!({}) }).collect();
        let stored = event_store::append(tx, &events)?;
        receipt.result_sequence=stored.last().ok_or(rusqlite::Error::InvalidQuery)?.sequence;
        event_store::upsert_receipt(tx, &receipt)?;
        Ok((CommitResult { receipt, committed:true }, stored))
    })
}

fn dispose_cohort(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    parent: &str,
    now: &str,
    events: &mut Vec<(&'static str, Value)>,
) -> rusqlite::Result<()> {
    let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", params![thread_id,parent], |r| r.get(0)).optional()?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let mut run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND run_id=?2 AND origin='app_owned' ORDER BY started_at,subagent_id")?;
    let tasks = stmt
        .query_map(params![thread_id, parent], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if run.get("delegatedCompletion").is_none() && tasks.is_empty() {
        return Ok(());
    }
    let generation = run["delegatedCompletion"]["nextGeneration"]
        .as_i64()
        .unwrap_or(1);
    run["delegatedCompletion"] =
        json!({"disposition":"disposed","nextGeneration":generation,"delivery":null});
    tx.execute(
        "UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",
        params![parent, run.to_string()],
    )?;
    events.push(("run.updated", run));
    for raw in tasks {
        let mut task: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if matches!(
            task["completionDelivery"]["state"].as_str(),
            Some("acknowledged" | "delivered" | "disposed")
        ) {
            continue;
        }
        let id = task["id"]
            .as_str()
            .ok_or(rusqlite::Error::InvalidQuery)?
            .to_owned();
        task["completionDelivery"] = json!({"state":"disposed","observedByRunId":null});
        task["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_subagents SET completion_delivery_state='disposed',updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![id,now,task.to_string()])?;
        events.push(("subagent.updated", task));
    }
    Ok(())
}

fn cancel_related(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    key: &str,
    id: &str,
    event: &'static str,
    now: &str,
    events: &mut Vec<(&'static str, Value)>,
) -> rusqlite::Result<()> {
    let raw: Option<String> = tx
        .query_row(
            &format!("SELECT payload_json FROM {table} WHERE {key}=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        let mut value: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        value["status"] = json!("cancelled");
        value["completedAt"] = json!(now);
        if table.ends_with("turn_items") {
            value["updatedAt"] = json!(now);
        }
        tx.execute(
            &format!("UPDATE {table} SET status='cancelled',payload_json=?2 WHERE {key}=?1"),
            params![id, value.to_string()],
        )?;
        events.push((event, value));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread_commands::{create_thread_ordered, CreateThread};
    #[test]
    fn lifecycle_is_atomic_replayable_and_guards_settlement() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let model = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &model,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let stale = dispatch(
            &bus,
            "stale",
            "t",
            Lifecycle::Settle {
                expected_latest_run_id: Some("missing"),
                settled_at: None,
            },
            "2026-01-02T00:00:00Z",
        )
        .unwrap();
        assert_eq!(stale.receipt.status, "rejected");
        let first = dispatch(
            &bus,
            "archive",
            "t",
            Lifecycle::Archive,
            "2026-01-02T00:00:00Z",
        )
        .unwrap();
        let replay = dispatch(
            &bus,
            "archive",
            "t",
            Lifecycle::Unarchive,
            "2026-01-03T00:00:00Z",
        )
        .unwrap();
        assert!(first.committed);
        assert!(!replay.committed);
        assert_eq!(
            first.receipt.result_sequence,
            replay.receipt.result_sequence
        );
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES('q','t','missing','user_input','pending','a',?1)", [json!({"id":"q","nodeId":"missing","kind":"user_input","status":"pending","responseCapability":{"type":"message"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'a','a',?1)", [json!({"id":"m","role":"user","notification":{"source":"test"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','queued','a',?1)", [json!({"id":"r","userMessageId":"m","status":"queued","queuePosition":1}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',0,'codex','completed','a',?1)", [json!({"id":"parent","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{}}}).to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_messages SET payload_json=?1 WHERE message_id='m'", [json!({"id":"m","role":"user","delegatedCompletion":{"parentRunId":"parent","taskIds":["s"]}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json,completion_delivery_state) VALUES('s','t','parent','n','codex','app_owned','completed','a',?1,'pending')", [json!({"id":"s","completionDelivery":{"state":"pending"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('session','t','codex','ready','a','{}')", [])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES('session','t')", [])?;
            Ok(((),vec![]))
        }).unwrap();
        let settled = dispatch(
            &bus,
            "settle",
            "t",
            Lifecycle::Settle {
                expected_latest_run_id: None,
                settled_at: None,
            },
            "2026-01-03T00:00:00Z",
        )
        .unwrap();
        assert_eq!(settled.receipt.status, "accepted");
        bus.commit(|tx| {
            let request: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'", [], |r| r.get(0))?;
            let run: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='r'", [], |r| r.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&request).unwrap()["decision"], "cancel");
            assert_eq!(serde_json::from_str::<Value>(&run).unwrap()["status"], "cancelled");
            let types: Vec<String> = { let mut stmt=tx.prepare("SELECT event_type FROM orchestration_events WHERE command_id='settle' ORDER BY sequence")?; let rows=stmt.query_map([], |r| r.get(0))?.collect::<Result<_,_>>()?; rows };
            assert_eq!(types, vec!["runtime-request.updated", "run.updated", "subagent.updated", "run.updated", "thread.settled", "provider-session.detached"]);
            let cohort: String = tx.query_row("SELECT json_extract(payload_json,'$.delegatedCompletion.disposition') FROM orchestration_v2_projection_runs WHERE run_id='parent'", [], |r| r.get(0))?;
            assert_eq!(cohort,"disposed");
            let delivery: String = tx.query_row("SELECT completion_delivery_state FROM orchestration_v2_projection_subagents WHERE subagent_id='s'", [], |r| r.get(0))?;
            assert_eq!(delivery,"disposed");
            let bindings: i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id='t'", [], |r| r.get(0))?;
            assert_eq!(bindings,0);
            let detail: String = tx.query_row("SELECT json_extract(payload_json,'$.detail') FROM orchestration_v2_effect_outbox WHERE effect_type='provider-session.detach'", [], |r| r.get(0))?;
            assert_eq!(detail,"Thread settled.");
            Ok(((),vec![]))
        }).unwrap();
        bus.commit(|tx| { let (archived, state): (Option<String>,String)=tx.query_row("SELECT archived_at,json_extract(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert_eq!(archived.as_deref(),Some("2026-01-02T00:00:00Z")); assert_eq!(state,"settled"); Ok(((),vec![])) }).unwrap();
        dispatch(
            &bus,
            "unsettle",
            "t",
            Lifecycle::Unsettle,
            "2026-01-04T00:00:00Z",
        )
        .unwrap();
        dispatch(
            &bus,
            "unarchive",
            "t",
            Lifecycle::Unarchive,
            "2026-01-04T00:00:00Z",
        )
        .unwrap();
        bus.commit(|tx| { let (archived, state): (Option<String>,String)=tx.query_row("SELECT archived_at,json_extract(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert_eq!(archived,None); assert_eq!(state,"active"); Ok(((),vec![])) }).unwrap();
    }
}
