//! Transactional run interruption and durable provider stop effects.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event, Receipt},
    message_commands::DispatchError,
    outbox::{self, Effect},
    provider::session_registry::SessionRegistry,
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

fn provider_is_live(provider: &Value, sessions: &SessionRegistry) -> rusqlite::Result<bool> {
    let id = provider["id"].as_str().unwrap_or("");
    match provider["driver"].as_str() {
        Some("opencode") => Ok(crate::provider::opencode_executor::is_active(id)),
        Some("pi") => Ok(crate::provider::pi_executor::is_active(id)),
        Some("claudeAgent") => Ok(crate::provider::claude_executor::is_active(id)),
        Some("cursor") => Ok(crate::provider::cursor_executor::is_active(id)),
        Some("fx" | "grok" | "kiro" | "acpRegistry" | "antigravity") => {
            Ok(crate::provider::acp_executor::is_active(id))
        }
        _ => match provider["providerSessionId"].as_str() {
            Some(id) => sessions
                .get(id)
                .map(|v| v.is_some())
                .map_err(|_| rusqlite::Error::InvalidQuery),
            None => Ok(false),
        },
    }
}

pub(crate) fn signal(run: &str, suffix: &str) -> String {
    let encode = |s: &str| {
        let mut out = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    };
    format!("turn-item:run:{}:signal:{}", encode(run), encode(suffix))
}
fn read(tx: &Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx.query_row(sql, [id], |r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}
fn field<'a>(v: &'a Value, key: &str) -> rusqlite::Result<&'a str> {
    v[key].as_str().ok_or(rusqlite::Error::InvalidQuery)
}

#[allow(clippy::too_many_arguments)]
pub fn interrupt_run(
    bus: &EventBus,
    sessions: &SessionRegistry,
    command_id: &str,
    thread_id: &str,
    run_id: &str,
    reason: Option<&str>,
    hold_queue: bool,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    interrupt_or_stop(
        bus,
        sessions,
        command_id,
        thread_id,
        Some(run_id),
        reason,
        hold_queue,
        false,
        now,
        |_| Ok(()),
    )
}

/// Stop the current live run and hold queued runs in the same transaction.
#[allow(clippy::too_many_arguments)]
pub fn stop_thread(
    bus: &EventBus,
    sessions: &SessionRegistry,
    command_id: &str,
    thread_id: &str,
    reason: Option<&str>,
    stop_delegated_tasks: bool,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    interrupt_or_stop(
        bus,
        sessions,
        command_id,
        thread_id,
        None,
        reason,
        true,
        stop_delegated_tasks,
        now,
        |_| Ok(()),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn interrupt_checked<F>(
    bus: &EventBus,
    sessions: &SessionRegistry,
    command_id: &str,
    thread_id: &str,
    run_id: Option<&str>,
    reason: Option<&str>,
    stop: bool,
    now: &str,
    check: F,
) -> Result<CommitResult, DispatchError>
where
    F: FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
{
    interrupt_or_stop(
        bus, sessions, command_id, thread_id, run_id, reason, stop, stop, now, check,
    )
}

#[allow(clippy::too_many_arguments)]
fn interrupt_or_stop<F>(
    bus: &EventBus,
    sessions: &SessionRegistry,
    command_id: &str,
    thread_id: &str,
    requested_run_id: Option<&str>,
    reason: Option<&str>,
    hold_queue: bool,
    stop_delegated_tasks: bool,
    now: &str,
    check: F,
) -> Result<CommitResult, DispatchError>
where
    F: FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
{
    let result = bus.commit_with(|tx| {
        check(tx)?;
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            if receipt.aggregate_id != thread_id { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let is_stop = requested_run_id.is_none();
        let thread = read(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", thread_id)?;
        let selected: Option<String> = if is_stop && thread.as_ref().is_some_and(|t| t["deletedAt"].is_null()) {
            tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running') ORDER BY ordinal DESC LIMIT 1", [thread_id], |r| r.get(0)).optional()?
        } else { requested_run_id.map(str::to_owned) };
        let run_id = selected.as_deref().unwrap_or("");
        let run = read(tx, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1", run_id)?;
        let valid = if is_stop { thread.is_some() } else { run.as_ref().is_some_and(|r| r["threadId"] == thread_id && matches!(r["status"].as_str(), Some("preparing" | "starting" | "running"))) };
        let mut receipt = Receipt { command_id: command_id.into(), aggregate_kind: "thread".into(), aggregate_id: thread_id.into(), command_type: if is_stop {"thread.stop"} else {"run.interrupt"}.into(), accepted_at: now.into(), result_sequence: event_store::latest_thread_sequence(tx, Some(thread_id))?, status: if valid {"accepted"} else {"rejected"}.into(), error: (!valid).then(|| if is_stop { format!("Thread {thread_id} was not found.") } else { format!("Run {run_id} is not interruptible.") }) };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(DispatchError::CommandIdConflict); }
        if !valid { return Ok((CommitResult { receipt, committed: false }, vec![])); }
        if is_stop && thread.as_ref().is_some_and(|t| !t["deletedAt"].is_null()) {
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        if is_stop && run.is_none() {
            let mut payloads: Vec<(&str, Value)> = Vec::new();
            let latest: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status NOT IN ('queued','rolled_back') ORDER BY ordinal DESC LIMIT 1", [thread_id], |r| r.get(0)).optional()?;
            if let Some(raw) = latest {
                let latest: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                if let (Some(id), Some(node), Some(provider)) = (latest["id"].as_str(), latest["rootNodeId"].as_str(), latest["providerThreadId"].as_str()) {
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND type='run_interrupt_request')", [id], |r| r.get(0))?;
                    if !exists {
                        let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [thread_id], |r| r.get(0))?;
                        let item = json!({"id":signal(id,"interrupt-request"),"threadId":thread_id,"runId":id,"nodeId":node,"providerThreadId":provider,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Interrupt requested","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_request","message":reason.unwrap_or("Stopped by user")});
                        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,NULL,?6,'run_interrupt_request','completed',?7,?8)", params![item["id"].as_str(),thread_id,id,node,provider,ordinal,now,item.to_string()])?;
                        payloads.push(("turn-item.updated", item));
                    }
                }
            }
            let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' ORDER BY ordinal")?;
            let rows = stmt.query_map([thread_id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for raw in rows {
                let mut queued: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                if queued["queueHeld"] != true {
                    queued["queueHeld"] = json!(true);
                    tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1", params![queued["id"].as_str(), queued.to_string()])?;
                    payloads.push(("run.updated", queued));
                }
            }
            stop_background_work(tx, sessions, command_id, thread_id, None, None, None, &mut payloads, now)?;
            if let Some(updated) = end_pull_request_watches(tx, thread.as_ref().unwrap(), thread_id, now)? { payloads.push(("thread.pull-request-synced", updated)); }
            enqueue_delegated_stop(tx, command_id, thread_id, reason, stop_delegated_tasks, now)?;
            let events: Vec<Event> = payloads.into_iter().map(|(kind,payload)| Event {id:uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:payload["threadId"].as_str().unwrap_or(thread_id).into(), event_type:kind.into(), occurred_at:now.into(), command_id:Some(command_id.into()), causation_event_id:None, correlation_id:Some(command_id.into()), actor_kind:"client".into(), payload, metadata:json!({})}).collect();
            let events = event_store::append(tx, &events)?;
            if let Some(last) = events.last() { receipt.result_sequence = last.sequence; event_store::upsert_receipt(tx, &receipt)?; }
            return Ok((CommitResult {receipt, committed: !events.is_empty()}, events));
        }
        let mut run = run.unwrap();
        let run_ordinal = run["ordinal"].as_i64();
        let node_id = field(&run, "rootNodeId")?.to_owned(); let provider_id = field(&run, "providerThreadId")?.to_owned(); let attempt_id = field(&run, "activeAttemptId")?.to_owned();
        let mut node = read(tx,"SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", &node_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let mut attempt = read(tx,"SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1", &attempt_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let provider = read(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", &provider_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let turn_raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY ordinal DESC LIMIT 1", [&attempt_id], |r| r.get(0)).optional()?;
        let mut turn: Option<Value> = turn_raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?;
        let session_id = provider["providerSessionId"].as_str();
        let live = provider_is_live(&provider, sessions)?;
        let turn_id = turn.as_ref().and_then(|t| t["id"].as_str());
        let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [thread_id], |r| r.get(0))?;
        let req_id = signal(run_id, "interrupt-request");
        let request = json!({"id":req_id,"threadId":thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":turn_id,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Interrupt requested","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_request","message":reason.unwrap_or("Stopped by user")});
        let mut payloads = vec![("turn-item.updated",request.clone())];
        let write_item = |p: &Value| -> rusqlite::Result<()> { tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![p["id"].as_str(),thread_id,run_id,node_id,provider_id,p["providerTurnId"].as_str(),p["ordinal"].as_i64(),p["type"].as_str(),p["status"].as_str(),now,p.to_string()])?; Ok(()) };
        write_item(&request)?;
        if hold_queue {
            let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' ORDER BY ordinal")?;
            let rows = stmt.query_map([thread_id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for raw in rows { let mut queued: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?; if queued["queueHeld"] != true { queued["queueHeld"] = json!(true); tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![queued["id"].as_str(),queued.to_string()])?; payloads.push(("run.updated",queued)); } }
        }
        if turn.is_none() || !live {
            let result = json!({"id":signal(run_id,"interrupt-result"),"threadId":thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":turn_id,"nativeItemRef":null,"parentItemId":req_id,"ordinal":ordinal+1,"status":"interrupted","title":"Interrupted","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_result","message":if turn.is_none() {"Run interrupted before provider start"} else {reason.unwrap_or("Stopped by user")}});
            write_item(&result)?; payloads.push(("turn-item.updated",result));
            if let Some(ref mut t) = turn { t["status"] = json!("interrupted"); t["completedAt"] = json!(now); tx.execute("UPDATE orchestration_v2_projection_provider_turns SET status='interrupted',completed_at=?2,payload_json=?3 WHERE provider_turn_id=?1",params![t["id"].as_str(),now,t.to_string()])?; payloads.push(("provider-turn.updated",t.clone())); }
            for p in [&mut attempt,&mut node,&mut run] { p["status"] = json!("interrupted"); p["completedAt"] = json!(now); }
            tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='interrupted',payload_json=?2 WHERE attempt_id=?1",params![attempt_id,attempt.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,now,node.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![run_id,now,run.to_string()])?;
            payloads.extend([("run-attempt.updated",attempt),("node.updated",node),("run.updated",run)]);
            if turn.is_none() { outbox::cancel_unsettled(tx,thread_id,&["provider-turn.start".into(),"provider-turn.restart".into()],&format!("Run {run_id} was interrupted before its provider turn started."),now)?; }
        } else {
            let id = turn_id.unwrap();
            outbox::enqueue(tx,&Effect { id:format!("effect:{command_id}:provider-turn.interrupt:{id}"),command_id:command_id.into(),thread_id:thread_id.into(),request:json!({"type":"provider-turn.interrupt","providerSessionId":session_id,"providerThreadId":provider_id,"providerTurnId":id}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None })?;
        }
        if is_stop {
            stop_background_work(tx, sessions, command_id, thread_id, Some(&provider_id), None, run_ordinal, &mut payloads, now)?;
            if let Some(updated) = end_pull_request_watches(tx, thread.as_ref().unwrap(), thread_id, now)? { payloads.push(("thread.pull-request-synced", updated)); }
            enqueue_delegated_stop(tx, command_id, thread_id, reason, stop_delegated_tasks, now)?;
        }
        let events: Vec<Event> = payloads.into_iter().map(|(kind,payload)| Event {id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:payload["threadId"].as_str().unwrap_or(thread_id).into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let events = event_store::append(tx,&events)?; receipt.result_sequence=events.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult {receipt,committed:true},events))
    })?;
    if result.committed {
        crate::queue_promotion::promote(bus, thread_id, now)?;
    }
    Ok(result)
}

/// Interrupt live owners and reconcile work whose provider process is gone.
#[allow(clippy::too_many_arguments)]
fn stop_background_work(
    tx: &Transaction<'_>,
    sessions: &SessionRegistry,
    command_id: &str,
    thread_id: &str,
    foreground_provider: Option<&str>,
    settled_provider: Option<&str>,
    through_ordinal: Option<i64>,
    payloads: &mut Vec<(&'static str, Value)>,
    now: &str,
) -> rusqlite::Result<()> {
    use std::collections::{HashMap, HashSet};
    let mut owners: HashMap<String, (Value, bool)> = HashMap::new();
    let mut stmt = tx.prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1",
    )?;
    for raw in stmt
        .query_map([thread_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
    {
        let p: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let live = provider_is_live(&p, sessions)?;
        if let Some(id) = p["id"].as_str() {
            owners.insert(id.to_owned(), (p.clone(), live));
        }
    }
    drop(stmt);
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type IN ('command_execution','dynamic_tool','subagent') AND status IN ('pending','running','waiting') ORDER BY ordinal")?;
    let items = stmt
        .query_map([thread_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut interrupted_turns = HashSet::new();
    let mut native_children = HashSet::new();
    for raw in items {
        let mut item: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if item["type"] == "dynamic_tool" && item["input"]["persistent"] == true {
            continue;
        }
        if let Some(run) = item["runId"].as_str() {
            let rolled_back: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND status='rolled_back')", [run], |r| r.get(0))?;
            if rolled_back {
                continue;
            }
            let ordinal: Option<i64> = tx
                .query_row(
                    "SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id=?1",
                    [run],
                    |r| r.get(0),
                )
                .optional()?;
            if ordinal
                .zip(through_ordinal)
                .is_some_and(|(item, through)| item > through)
            {
                continue;
            }
        }
        let owner = item["providerThreadId"]
            .as_str()
            .and_then(|id| owners.get(id));
        let parent_live = if let Some(turn_id) = item["providerTurnId"].as_str() {
            read(tx, "SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1", turn_id)?.and_then(|turn| turn["providerThreadId"].as_str().and_then(|id| owners.get(id)).map(|(_,live)| *live && turn["providerThreadId"].as_str() != settled_provider)).unwrap_or(false)
        } else {
            false
        };
        let stopped =
            item["providerThreadId"].as_str() == settled_provider && settled_provider.is_some();
        let live = !stopped
            && (owner.is_some_and(|(_, live)| *live)
                || parent_live
                || (owner.is_none()
                    && foreground_provider != settled_provider
                    && foreground_provider
                        .and_then(|id| owners.get(id))
                        .is_some_and(|(_, live)| *live)));
        if live {
            if settled_provider.is_some() {
                continue;
            }
            // Native subagent items can name a child provider thread while their
            // provider turn belongs to the parent. Prefer that explicit binding.
            let turn_id = if let Some(id) = item["providerTurnId"].as_str() {
                Some(id.to_owned())
            } else if let Some(id) = item["providerThreadId"].as_str().or(foreground_provider) {
                tx.query_row("SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1 ORDER BY ordinal DESC LIMIT 1", [id], |r|r.get(0)).optional()?
            } else {
                None
            };
            let turn_id = turn_id.ok_or(rusqlite::Error::InvalidQuery)?;
            let turn = read(tx, "SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1", &turn_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
            let turn_owner = turn["providerThreadId"]
                .as_str()
                .and_then(|id| owners.get(id))
                .ok_or(rusqlite::Error::InvalidQuery)?;
            let (provider, owner_live) = turn_owner;
            if !owner_live {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let provider_id = provider["id"]
                .as_str()
                .ok_or(rusqlite::Error::InvalidQuery)?;
            if Some(provider_id) != foreground_provider && interrupted_turns.insert(turn_id.clone())
            {
                outbox::enqueue(
                    tx,
                    &Effect {
                        id: format!("effect:{command_id}:provider-turn.interrupt:{turn_id}"),
                        command_id: command_id.into(),
                        thread_id: thread_id.into(),
                        request: json!({"type":"provider-turn.interrupt","providerSessionId":provider["providerSessionId"],"providerThreadId":provider_id,"providerTurnId":turn_id}),
                        status: "pending".into(),
                        attempt_count: 0,
                        available_at: now.into(),
                        lease_owner: None,
                        created_at: now.into(),
                        updated_at: now.into(),
                        completed_at: None,
                        last_error: None,
                    },
                )?;
            }
            continue;
        }
        item["status"] = json!("interrupted");
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='interrupted',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1", params![item["id"].as_str(),now,item.to_string()])?;
        if let Some(node_id) = item["nodeId"].as_str() {
            if let Some(mut node) = read(
                tx,
                "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
                node_id,
            )? {
                if matches!(
                    node["status"].as_str(),
                    Some("pending" | "idle" | "running" | "waiting")
                ) {
                    node["status"] = json!("interrupted");
                    node["completedAt"] = json!(now);
                    tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1", params![node_id, now, node.to_string()])?;
                    payloads.push(("node.updated", node));
                }
            }
        }
        if item["type"] == "subagent" {
            if let Some(id) = item["subagentId"].as_str() {
                end_native(tx, thread_id, id, payloads, &mut native_children, now)?;
            }
        }
        payloads.push(("turn-item.updated", item));
    }
    if foreground_provider.is_none() {
        let mut stmt = tx.prepare("SELECT subagent_id FROM orchestration_v2_projection_subagents s WHERE thread_id=?1 AND origin='provider_native' AND run_id IS NOT NULL AND status IN ('pending','idle','running','waiting') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=s.thread_id AND i.type='subagent' AND i.status IN ('pending','running','waiting') AND json_extract(i.payload_json,'$.subagentId')=s.subagent_id)")?;
        let stale = stmt
            .query_map([thread_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for id in stale {
            end_native(tx, thread_id, &id, payloads, &mut native_children, now)?;
        }
    }
    for (id, (mut provider, live)) in owners {
        if provider["pendingBackgroundTasks"]
            .as_array()
            .is_none_or(|a| a.is_empty())
        {
            continue;
        }
        if live && Some(id.as_str()) != settled_provider {
            if settled_provider.is_some() {
                continue;
            }
            if Some(id.as_str()) != foreground_provider {
                let turn: Option<String> = tx.query_row("SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1 ORDER BY ordinal DESC LIMIT 1", [&id], |r| r.get(0)).optional()?;
                let turn_id = turn.ok_or(rusqlite::Error::InvalidQuery)?;
                {
                    if interrupted_turns.insert(turn_id.clone()) {
                        outbox::enqueue(
                            tx,
                            &Effect {
                                id: format!(
                                    "effect:{command_id}:provider-turn.interrupt:{turn_id}"
                                ),
                                command_id: command_id.into(),
                                thread_id: thread_id.into(),
                                request: json!({"type":"provider-turn.interrupt","providerSessionId":provider["providerSessionId"],"providerThreadId":id,"providerTurnId":turn_id}),
                                status: "pending".into(),
                                attempt_count: 0,
                                available_at: now.into(),
                                lease_owner: None,
                                created_at: now.into(),
                                updated_at: now.into(),
                                completed_at: None,
                                last_error: None,
                            },
                        )?;
                    }
                }
            }
            continue;
        }
        provider["pendingBackgroundTasks"] = json!([]);
        provider["updatedAt"] = json!(now);
        if provider["status"] == "active"
            && provider["lastRunOrdinal"]
                .as_i64()
                .zip(through_ordinal)
                .is_some_and(|(last, through)| last <= through)
        {
            provider["status"] = json!("idle");
        }
        tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status=?2,updated_at=?3,payload_json=?4 WHERE provider_thread_id=?1", params![id,provider["status"].as_str(),now,provider.to_string()])?;
        payloads.push(("provider-thread.updated", provider));
    }
    Ok(())
}
fn end_native(
    tx: &Transaction<'_>,
    thread_id: &str,
    id: &str,
    payloads: &mut Vec<(&'static str, Value)>,
    visited: &mut std::collections::HashSet<String>,
    now: &str,
) -> rusqlite::Result<()> {
    let task = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id=?1",
        id,
    )?;
    if let Some(mut task) = task {
        if task["threadId"] != thread_id
            || task["origin"] != "provider_native"
            || !matches!(
                task["status"].as_str(),
                Some("pending" | "idle" | "running" | "waiting")
            )
        {
            return Ok(());
        }
        task["status"] = json!("interrupted");
        task["completedAt"] = json!(now);
        task["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_subagents SET status='interrupted',completed_at=?2,updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![id,now,task.to_string()])?;
        let child = task["childThreadId"].as_str().map(str::to_owned);
        payloads.push(("subagent.updated", task));
        if let Some(mut node) = read(
            tx,
            "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
            id,
        )? {
            if matches!(
                node["status"].as_str(),
                Some("pending" | "idle" | "running" | "waiting")
            ) {
                node["status"] = json!("interrupted");
                node["completedAt"] = json!(now);
                tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1", params![id,now,node.to_string()])?;
                payloads.push(("node.updated", node));
            }
        }
        if let Some(child) = child {
            if visited.insert(child.clone()) {
                end_native_child(tx, &child, payloads, visited, now)?;
            }
        }
    }
    Ok(())
}

fn end_native_child(
    tx: &Transaction<'_>,
    child: &str,
    payloads: &mut Vec<(&'static str, Value)>,
    visited: &mut std::collections::HashSet<String>,
    now: &str,
) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND run_id IS NULL AND kind='root_turn' AND status IN ('pending','idle','running','waiting')")?;
    let nodes = stmt
        .query_map([child], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in nodes {
        let mut node: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let id = node["id"].as_str().unwrap_or("").to_owned();
        node["status"] = json!("interrupted");
        node["completedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![id,now,node.to_string()])?;
        payloads.push(("node.updated", node));
        let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND node_id=?2 AND run_id IS NULL AND status IN ('pending','running','waiting')")?;
        let items = stmt
            .query_map(params![child, id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for raw in items {
            let mut item: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            item["status"] = json!("interrupted");
            item["completedAt"] = json!(now);
            item["updatedAt"] = json!(now);
            if matches!(
                item["type"].as_str(),
                Some("assistant_message" | "reasoning")
            ) {
                item["streaming"] = json!(false);
            }
            tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='interrupted',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![item["id"].as_str(),now,item.to_string()])?;
            payloads.push(("turn-item.updated", item));
        }
        let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND node_id=?2 AND run_attempt_id IS NULL AND status IN ('pending','running','waiting')")?;
        let turns = stmt
            .query_map(params![child, id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for raw in turns {
            let mut turn: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            turn["status"] = json!("interrupted");
            turn["completedAt"] = json!(now);
            tx.execute("UPDATE orchestration_v2_projection_provider_turns SET status='interrupted',completed_at=?2,payload_json=?3 WHERE provider_turn_id=?1",params![turn["id"].as_str(),now,turn.to_string()])?;
            payloads.push(("provider-turn.updated", turn));
        }
    }
    let mut stmt=tx.prepare("SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='provider_native' AND run_id IS NULL AND status IN ('pending','idle','running','waiting')")?;
    let nested = stmt
        .query_map([child], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for id in nested {
        end_native(tx, child, &id, payloads, visited, now)?;
    }
    Ok(())
}

fn force_stop_prestart(
    tx: &Transaction<'_>,
    thread_id: &str,
    run: &Value,
    now: &str,
) -> rusqlite::Result<Vec<(&'static str, Value)>> {
    let run_id = field(run, "id")?;
    let node_id = field(run, "rootNodeId")?;
    let provider_id = field(run, "providerThreadId")?;
    let attempt_id = field(run, "activeAttemptId")?;
    let mut node = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
        node_id,
    )?
    .ok_or(rusqlite::Error::InvalidQuery)?;
    let mut attempt = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1",
        attempt_id,
    )?
    .ok_or(rusqlite::Error::InvalidQuery)?;
    let mut run = run.clone();
    let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread_id],|r|r.get(0))?;
    let request_id = signal(run_id, "interrupt-request");
    let request = json!({"id":request_id,"threadId":thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Interrupt requested","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_request","message":"Force stopped by user"});
    let result = json!({"id":signal(run_id,"interrupt-result"),"threadId":thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":null,"nativeItemRef":null,"parentItemId":request_id,"ordinal":ordinal+1,"status":"interrupted","title":"Interrupted","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_result","message":"Run interrupted before provider start"});
    for item in [&request, &result] {
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item["id"].as_str(),thread_id,run_id,node_id,provider_id,item["parentItemId"].as_str(),item["ordinal"].as_i64(),item["type"].as_str(),item["status"].as_str(),now,item.to_string()])?;
    }
    for item in [&mut attempt, &mut node, &mut run] {
        item["status"] = json!("interrupted");
        item["completedAt"] = json!(now);
    }
    tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='interrupted',payload_json=?2 WHERE attempt_id=?1",params![attempt_id,attempt.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,now,node.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![run_id,now,run.to_string()])?;
    outbox::cancel_unsettled(
        tx,
        thread_id,
        &["provider-turn.start".into(), "provider-turn.restart".into()],
        &format!("Run {run_id} was interrupted before its provider turn started."),
        now,
    )?;
    Ok(vec![
        ("turn-item.updated", request),
        ("turn-item.updated", result),
        ("run-attempt.updated", attempt),
        ("node.updated", node),
        ("run.updated", run),
    ])
}

/// Force stop a thread, refusing stale run IDs and retaining sessions shared with
/// any other thread. The target is settled while the event bus lock is held.
pub fn force_stop_thread(
    bus: &EventBus,
    sessions: &SessionRegistry,
    thread_id: &str,
    expected_run: Option<&str>,
    now: &str,
) -> Result<Value, Value> {
    let error = |cause: String| json!({"_tag":"OrchestrationV2ForceStopThreadError","threadId":thread_id,"cause":cause});
    let outcome=bus.commit(|tx| {
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",[thread_id],|r|r.get(0))?;
        if !exists{return Err(rusqlite::Error::QueryReturnedNoRows);}
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[thread_id],|r|r.get(0)).optional()?;
        let raw=match raw {Some(v)=>Some(v),None=>tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status!='queued' ORDER BY ordinal DESC LIMIT 1",[thread_id],|r|r.get(0)).optional()?};
        let target:Option<Value>=raw.map(|v|serde_json::from_str(&v).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()?;
        if expected_run.is_some_and(|id|target.as_ref().and_then(|v|v["id"].as_str())!=Some(id)){return Ok(((false,vec![],true,0_i64),vec![]));}
        let mut stmt=tx.prepare("SELECT DISTINCT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_session_id IS NOT NULL")?;
        let ids=stmt.query_map([thread_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
        let mut events=Vec::new();let mut promote=false;
        if let Some(run)=target.as_ref(){
            let id=run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;let active=matches!(run["status"].as_str(),Some("preparing"|"starting"|"running"|"waiting"));
            if active { crate::provider::cursor_executor::preserve_interrupted_prompt(tx, thread_id, id)?; }
            let turn:Option<(String,String)>=tx.query_row("SELECT provider_turn_id,provider_thread_id FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 AND (?2=0 OR status='running') ORDER BY ordinal DESC LIMIT 1",params![run["activeAttemptId"].as_str(),active],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((turn,provider))=turn {
                let command=format!("server:force-stop:{id}:{}",uuid::Uuid::new_v4());
                let effect=Effect{id:command.clone(),command_id:command.clone(),thread_id:thread_id.into(),request:json!({"type":"provider-turn.interrupt","providerThreadId":provider,"providerTurnId":turn,"reason":"Force stopped by user"}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None};
                let mut payloads=Vec::new();terminalize_confirmed_interrupt(tx,&effect,id,&provider,&turn,&mut payloads,now)?;
                stop_background_work(tx,sessions,&command,thread_id,Some(&provider),Some(&provider),run["ordinal"].as_i64(),&mut payloads,now)?;
                let planned:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:payload["threadId"].as_str().unwrap_or(thread_id).into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.clone()),causation_event_id:None,correlation_id:Some(command.clone()),actor_kind:"system".into(),payload,metadata:json!({})}).collect();events=event_store::append(tx,&planned)?;
            } else if active {
                if run["status"]=="waiting" {return Err(rusqlite::Error::InvalidQuery);}
                let command=format!("server:force-stop:{id}:{}",uuid::Uuid::new_v4());
                let payloads=force_stop_prestart(tx,thread_id,run,now)?;
                let planned:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.clone()),causation_event_id:None,correlation_id:Some(command.clone()),actor_kind:"system".into(),payload,metadata:json!({})}).collect();
                events=event_store::append(tx,&planned)?;promote=true;
            }
        }
        Ok(((promote,ids,false,target.as_ref().and_then(|r|r["ordinal"].as_i64()).unwrap_or(0)),events))
    }).map_err(|e|error(e.to_string()))?;
    let (promote, ids, superseded, through_ordinal) = outcome;
    if superseded {
        return Err(
            json!({"_tag":"OrchestrationV2ForceStopThreadError","threadId":thread_id,"reason":"superseded"}),
        );
    }
    let mut shared = std::collections::BTreeSet::new();
    let mut releases = Vec::new();
    let mut native_releasing = false;
    for id in ids {
        let opencode = crate::provider::opencode_executor::force_stop_snapshot(&id, thread_id);
        let pi = crate::provider::pi_executor::force_stop_snapshot(&id, thread_id);
        let cursor = crate::provider::cursor_executor::force_stop_snapshot(&id, thread_id);
        let acp_session = crate::provider::acp_executor::has_session(&id, thread_id);
        let claude_thread = bus.commit(|tx| {
            let provider_thread: Option<String> = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=?1 AND thread_id=?2 AND provider='claudeAgent' LIMIT 1", params![id, thread_id], |row| row.get(0)).optional()?;
            Ok((provider_thread, vec![]))
        }).map_err(|e| error(e.to_string()))?;
        let claude_session = claude_thread.as_deref().is_some_and(|provider_thread| {
            crate::provider::claude_executor::has_provider_thread(thread_id, provider_thread)
        });
        if sessions
            .get(&id)
            .map_err(|e| error(e.to_string()))?
            .is_none()
            && !acp_session
            && !claude_session
            && opencode.is_none()
            && pi.is_none()
            && cursor.is_none()
        {
            continue;
        }
        let (others, shutdown, detach_acp, detach_claude, opencode_finished,pi_finished,cursor_finished)=bus.commit(|tx|{
            let mut stmt=tx.prepare("SELECT c.thread_id FROM (SELECT b.thread_id FROM orchestration_v2_projection_provider_session_bindings b WHERE b.provider_session_id=?1 AND b.thread_id!=?2 UNION SELECT p.thread_id FROM orchestration_v2_projection_provider_threads p WHERE p.provider_session_id=?1 AND p.thread_id!=?2 AND p.thread_id IS NOT NULL) c LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=c.thread_id WHERE t.thread_id IS NULL OR (t.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=c.thread_id AND r.status IN ('preparing','starting','running','waiting')) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p WHERE p.thread_id=c.thread_id AND json_array_length(COALESCE(json_extract(p.payload_json,'$.pendingBackgroundTasks'),'[]'))>0) OR json_array_length(COALESCE(json_extract(t.payload_json,'$.pendingBackgroundTasks'),'[]'))>0))")?;
            let others=stmt.query_map(params![id,thread_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
            // The registry removes the process only while the serialized DB view
            // still shows no sibling bindings or live turn on this session.
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=json_extract(r.payload_json,'$.providerThreadId') WHERE r.thread_id=?1 AND p.provider_session_id=?2 AND r.ordinal>?3 AND r.status IN ('preparing','starting','running','waiting'))",params![thread_id,id,through_ordinal],|r|r.get(0))?;
            if !active {
                let mut stmt=tx.prepare(if others.is_empty() {"DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1 AND ?2 IS NOT NULL RETURNING thread_id"} else {"DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1 AND thread_id=?2 RETURNING thread_id"})?;
                let detached=stmt.query_map(params![id,thread_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
                let events:Vec<Event>=detached.into_iter().map(|detached_thread|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:detached_thread,event_type:"provider-session.detached".into(),occurred_at:now.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:json!({"providerSessionId":id,"detachedAt":now,"reason":"Force stopped by user"}),metadata:json!({})}).collect();
                let mut events=event_store::append(tx,&events)?;
                let shutdown = if others.is_empty() {sessions.begin_remove(&id).map_err(|_|rusqlite::Error::InvalidQuery)?} else {None};
                let detach_acp = acp_session && others.is_empty();
                let detach_claude = claude_session && others.is_empty();
                let cwd:Option<String>=tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[thread_id],|row|row.get(0)).optional()?.flatten();
                let opencode_finished=opencode.as_ref().is_none_or(|snapshot|snapshot.stop(thread_id,cwd.as_deref()));
                let cursor_finished=!others.is_empty() || cursor.as_ref().is_none_or(|snapshot|snapshot.stop(thread_id,through_ordinal));
                if !cursor_finished && cursor.is_some() {
                    let retry_id=format!("effect:force-stop-retry:{}",uuid::Uuid::new_v4());
                    let retry=Effect{id:retry_id.clone(),command_id:retry_id,thread_id:thread_id.into(),request:json!({"type":"provider-session.detach","providerSessionId":id,"forceStopRetryThroughOrdinal":through_ordinal,"forceStopCursor":true,"promoteAfter":promote,"processGroup":cursor.as_ref().and_then(|snapshot|snapshot.process_group())}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None};
                    crate::outbox::enqueue(tx,&retry)?;
                    events.extend(event_store::append(tx,&force_stop_retry_notice(tx,&retry,now,false)?)?);
                }
                let pi_finished=pi.as_ref().is_none_or(|snapshot|snapshot.stop(thread_id,through_ordinal));
                if !pi_finished {
                    let retry_id=format!("effect:force-stop-retry:{}",uuid::Uuid::new_v4());
                    let retry=Effect{id:retry_id.clone(),command_id:retry_id,thread_id:thread_id.into(),request:json!({"type":"provider-session.detach","providerSessionId":id,"forceStopRetryThroughOrdinal":through_ordinal,"forceStopPi":true,"promoteAfter":promote,"processGroup":pi.as_ref().and_then(|snapshot|snapshot.process_group())}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None};
                    crate::outbox::enqueue(tx,&retry)?;
                    events.extend(event_store::append(tx,&force_stop_retry_notice(tx,&retry,now,false)?)?);
                }
                if !opencode_finished {
                    let retry_id=format!("effect:force-stop-retry:{}",uuid::Uuid::new_v4());
                    let pt:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=?1 AND thread_id=?2 AND provider='opencode' LIMIT 1",params![id,thread_id],|row|row.get(0)).optional()?;
                    let pt:Value=serde_json::from_str(&pt.ok_or(rusqlite::Error::InvalidQuery)?).map_err(|_|rusqlite::Error::InvalidQuery)?;
                    let retry=Effect{id:retry_id.clone(),command_id:retry_id,thread_id:thread_id.into(),request:json!({"type":"provider-session.detach","providerSessionId":id,"forceStopRetryThroughOrdinal":through_ordinal,"promoteAfter":promote,"nativeThreadId":pt["nativeThreadRef"]["nativeId"],"providerInstanceId":pt["providerInstanceId"],"connectionIdentity":opencode.as_ref().and_then(|snapshot|snapshot.identity()),"prestart":opencode.as_ref().is_some_and(|snapshot|snapshot.prestart()),"cwd":cwd}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None};
                    crate::outbox::enqueue(tx,&retry)?;
                    events.extend(event_store::append(tx,&force_stop_retry_notice(tx,&retry,now,false)?)?);
                }
                events.extend(crate::peer_link_requests::cancel_pending_for_thread(tx,thread_id,now)?);
                return Ok(((others,shutdown,detach_acp,detach_claude,opencode_finished,pi_finished,cursor_finished || cursor.is_none()),events));
            }
            Ok(((others,None,false,false,true,true,true),vec![]))
        }).map_err(|e|error(e.to_string()))?;
        if detach_acp {
            crate::provider::acp_executor::detach(&id, thread_id).map_err(&error)?;
        }
        if detach_claude {
            if let Some(provider_thread) = claude_thread.as_deref() {
                crate::provider::claude_executor::detach_provider_thread(
                    thread_id,
                    provider_thread,
                );
            }
        }
        native_releasing |= !opencode_finished || !pi_finished || !cursor_finished;
        shared.extend(others);
        if let Some(shutdown) = shutdown {
            releases.push(shutdown);
        }
    }
    let mut releasing = native_releasing;
    for shutdown in releases {
        match shutdown.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(error(e.to_string())),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => releasing = true,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(error("Provider shutdown task stopped unexpectedly".into()))
            }
        }
    }
    if promote && !native_releasing {
        crate::queue_promotion::promote(bus, thread_id, now)
            .map_err(|e| error(format!("{e:?}")))?;
    }
    Ok(
        json!({"outcome":if !shared.is_empty(){"shared"}else if releasing {"releasing"} else {"released"},"sharedWithThreadIds":shared.into_iter().collect::<Vec<_>>() }),
    )
}

fn force_stop_retry_notice(
    tx: &rusqlite::Transaction<'_>,
    effect: &Effect,
    now: &str,
    resolved: bool,
) -> rusqlite::Result<Vec<Event>> {
    let through = effect.request["forceStopRetryThroughOrdinal"]
        .as_i64()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let id = format!(
        "turn-item:force-stop-retry:{}:{}",
        crate::message_commands::encode_id_part(&effect.thread_id),
        through
    );
    let raw: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",
            [&id],
            |row| row.get(0),
        )
        .optional()?;
    if resolved && raw.is_none() {
        return Ok(Vec::new());
    }
    let mut item = if let Some(raw) = raw {
        serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?
    } else {
        let run:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal=?2",params![effect.thread_id,through],|row|row.get(0)).optional()?;
        let Some(run) = run else {
            return Ok(Vec::new());
        };
        let run: Value = serde_json::from_str(&run).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[&effect.thread_id],|row|row.get(0))?;
        json!({"id":id,"threadId":effect.thread_id,"runId":run["id"],"nodeId":run["rootNodeId"],"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Provider shutdown","startedAt":now,"completedAt":now,"updatedAt":now,"type":"system_notice"})
    };
    item["message"] = json!(if resolved {
        "The provider has stopped; queued work can resume."
    } else {
        "The provider is still stopping. Queued work will resume when it is safe."
    });
    item["updatedAt"] = json!(now);
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'system_notice','completed',?7,?8) ON CONFLICT(turn_item_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![id,effect.thread_id,item["runId"].as_str(),item["nodeId"].as_str(),item["providerThreadId"].as_str(),item["ordinal"].as_i64(),now,item.to_string()])?;
    Ok(vec![Event {
        id: uuid::Uuid::new_v4().to_string(),
        aggregate_kind: "thread".into(),
        stream_id: effect.thread_id.clone(),
        event_type: "turn-item.updated".into(),
        occurred_at: now.into(),
        command_id: None,
        causation_event_id: None,
        correlation_id: None,
        actor_kind: "system".into(),
        payload: item,
        metadata: json!({}),
    }])
}

/// Retry a force-stop before promoting a queued run. This is invoked by a durable outbox effect.
pub fn retry_opencode_force_stop(
    bus: &EventBus,
    effect: &Effect,
    settings_path: &std::path::Path,
    now: &str,
) -> Result<(), String> {
    let id = effect.request["providerSessionId"]
        .as_str()
        .ok_or("Missing provider session")?;
    let through = effect.request["forceStopRetryThroughOrdinal"]
        .as_i64()
        .ok_or("Missing stopped run ordinal")?;
    let snapshot = crate::provider::opencode_executor::force_stop_snapshot(id, &effect.thread_id);
    let outcome=bus.commit(|tx| {
        let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status IN ('preparing','starting','running','waiting'))",params![effect.thread_id,through],|row|row.get(0))?;
        if newer {return Ok((None,vec![]));}
        let done=match snapshot.as_ref() {
            Some(value)=>value.stop(&effect.thread_id,effect.request["cwd"].as_str()),
            None=>{
                let instance=effect.request["providerInstanceId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
                let native=effect.request["nativeThreadId"].as_str().unwrap_or("");
                let identity=effect.request["connectionIdentity"].as_str().unwrap_or("");
                let prestart=effect.request["prestart"]==true && native.is_empty();
                let reconciled=if prestart {
                    cfg!(target_os="linux")
                } else {
                    crate::provider::opencode_executor::reconcile_external_force_stop(settings_path,instance,native,effect.request["cwd"].as_str(),identity,&effect.thread_id).unwrap_or(false)
                };
                reconciled && crate::provider::opencode_owner::force_detach_thread(&effect.thread_id)
            }
        };
        Ok((Some(done),vec![]))
    }).map_err(|error|error.to_string())?;
    match outcome {
        None => Ok(()),
        Some(false) => Err("OpenCode force-stop is still releasing".into()),
        Some(true) => {
            bus.commit(|tx| {
                let events = force_stop_retry_notice(tx, effect, now, true)?;
                Ok(((), event_store::append(tx, &events)?))
            })
            .map_err(|error| error.to_string())?;
            if effect.request["promoteAfter"] == true {
                crate::queue_promotion::promote(bus, &effect.thread_id, now)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
    }
}

/// Retry Pi shutdown without allowing a newer run to be stopped or promoted early.
pub fn retry_pi_force_stop(bus: &EventBus, effect: &Effect, now: &str) -> Result<(), String> {
    let id = effect.request["providerSessionId"]
        .as_str()
        .ok_or("Missing provider session")?;
    let through = effect.request["forceStopRetryThroughOrdinal"]
        .as_i64()
        .ok_or("Missing stopped run ordinal")?;
    let snapshot = crate::provider::pi_executor::force_stop_snapshot(id, &effect.thread_id);
    let outcome=bus.commit(|tx|{
        let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status IN ('preparing','starting','running','waiting'))",params![effect.thread_id,through],|row|row.get(0))?;
        if newer{return Ok((None,vec![]));}
        let done=if let Some(snapshot)=snapshot.as_ref(){
            if let Some(group)=snapshot.process_group(){tx.execute("UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json,'$.processGroup',?2) WHERE effect_id=?1",params![effect.id,group])?;}
            snapshot.stop(&effect.thread_id,through)
        } else {
            let group=effect.request["processGroup"].as_i64().and_then(|value|i32::try_from(value).ok());
            crate::provider::pi_executor::has_verified_stop(id,&effect.thread_id,through) || crate::provider::pi_rpc::group_quiescent(group)
        };
        Ok((Some(done),vec![]))
    }).map_err(|error|error.to_string())?;
    match outcome {
        None => {
            crate::provider::pi_executor::clear_verified_stop(id, &effect.thread_id, through);
            Ok(())
        }
        Some(false) => Err("Pi force-stop is still releasing".into()),
        Some(true) => {
            bus.commit(|tx| {
                let events = force_stop_retry_notice(tx, effect, now, true)?;
                Ok(((), event_store::append(tx, &events)?))
            })
            .map_err(|error| error.to_string())?;
            if effect.request["promoteAfter"] == true {
                crate::queue_promotion::promote(bus, &effect.thread_id, now)
                    .map_err(|error| error.to_string())?;
            }
            crate::provider::pi_executor::clear_verified_stop(id, &effect.thread_id, through);
            Ok(())
        }
    }
}

pub fn retry_cursor_force_stop(bus: &EventBus, effect: &Effect, now: &str) -> Result<(), String> {
    let id = effect.request["providerSessionId"]
        .as_str()
        .ok_or("Missing provider session")?;
    let through = effect.request["forceStopRetryThroughOrdinal"]
        .as_i64()
        .ok_or("Missing stopped run ordinal")?;
    let snapshot = crate::provider::cursor_executor::force_stop_snapshot(id, &effect.thread_id);
    let outcome=bus.commit(|tx|{
        let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status IN ('preparing','starting','running','waiting'))",params![effect.thread_id,through],|row|row.get(0))?;
        if newer{return Ok((None,vec![]));}
        let done=if let Some(snapshot)=snapshot.as_ref(){
            if let Some(group)=snapshot.process_group(){tx.execute("UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json,'$.processGroup',?2) WHERE effect_id=?1",params![effect.id,group])?;}
            snapshot.stop(&effect.thread_id,through)
        } else {
            let group=effect.request["processGroup"].as_i64().and_then(|value|i32::try_from(value).ok());
            crate::provider::cursor_executor::has_verified_stop(id,&effect.thread_id,through) || crate::provider::cursor_bridge::group_quiescent(group)
        };
        Ok((Some(done),vec![]))
    }).map_err(|error|error.to_string())?;
    match outcome {
        None => {
            crate::provider::cursor_executor::clear_verified_stop(id, &effect.thread_id, through);
            Ok(())
        }
        Some(false) => Err("Cursor force-stop is still releasing".into()),
        Some(true) => {
            bus.commit(|tx| {
                let events = force_stop_retry_notice(tx, effect, now, true)?;
                Ok(((), event_store::append(tx, &events)?))
            })
            .map_err(|error| error.to_string())?;
            if effect.request["promoteAfter"] == true {
                crate::queue_promotion::promote(bus, &effect.thread_id, now)
                    .map_err(|error| error.to_string())?;
            }
            crate::provider::cursor_executor::clear_verified_stop(id, &effect.thread_id, through);
            Ok(())
        }
    }
}

/// Keep a failed force-stop retry durable after the worker's ordinary retry limit.
pub fn renew_opencode_force_stop(bus: &EventBus, effect: &Effect, now: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let id = format!(
        "effect:force-stop-retry:{:x}",
        Sha256::digest(effect.id.as_bytes())
    );
    let available = (chrono::Utc::now() + chrono::Duration::seconds(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        crate::outbox::enqueue(
            tx,
            &Effect {
                id: id.clone(),
                command_id: id,
                thread_id: effect.thread_id.clone(),
                request: crate::outbox::get(tx, &effect.id)?
                    .map(|current| current.request)
                    .unwrap_or_else(|| effect.request.clone()),
                status: "pending".into(),
                attempt_count: 0,
                available_at: available,
                lease_owner: None,
                created_at: now.into(),
                updated_at: now.into(),
                completed_at: None,
                last_error: None,
            },
        )?;
        let events = force_stop_retry_notice(tx, effect, now, false)?;
        Ok(((), event_store::append(tx, &events)?))
    })
    .map_err(|error| error.to_string())
}

/// Mark a timed-out interrupt without claiming that the provider stopped.
pub fn mark_interrupt_unresponsive(
    bus: &EventBus,
    effect: &Effect,
    now: &str,
) -> Result<(), crate::event_bus::BusError> {
    bus.commit(|tx| {
        let turn = effect.request["providerTurnId"].as_str().unwrap_or("");
        let provider = effect.request["providerThreadId"].as_str().unwrap_or("");
        let run: Option<String> = tx.query_row("SELECT r.run_id FROM orchestration_v2_projection_provider_turns p JOIN orchestration_v2_projection_runs r ON json_extract(r.payload_json,'$.activeAttemptId')=p.run_attempt_id WHERE p.provider_turn_id=?1 AND p.provider_thread_id=?2 AND p.thread_id=?3",params![turn,provider,effect.thread_id],|r|r.get(0)).optional()?;
        let Some(run) = run else { return Ok(((),vec![])); };
        let has_result:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='run_interrupt_result')",params![effect.thread_id,run],|r|r.get(0))?;
        if has_result {return Ok(((),vec![]));}
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='run_interrupt_request' ORDER BY ordinal LIMIT 1",params![effect.thread_id,run],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok(((),vec![]));};
        let mut item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if !item["unresponsiveAt"].is_null() {return Ok(((),vec![]));}
        item["unresponsiveAt"]=json!(now);item["updatedAt"]=json!(now);
        tx.execute("UPDATE orchestration_v2_projection_turn_items SET updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![item["id"].as_str(),now,item.to_string()])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:effect.thread_id.clone(),event_type:"turn-item.updated".into(),occurred_at:now.into(),command_id:Some(format!("{}:unresponsive",effect.id)),causation_event_id:None,correlation_id:Some(effect.command_id.clone()),actor_kind:"system".into(),payload:item,metadata:json!({})};
        Ok(((),event_store::append(tx,&[event])?))
    })
}

fn terminalize_confirmed_interrupt(
    tx: &Transaction<'_>,
    effect: &Effect,
    run_id: &str,
    provider_id: &str,
    turn_id: &str,
    events: &mut Vec<(&'static str, Value)>,
    now: &str,
) -> rusqlite::Result<()> {
    let Some(mut run) = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1",
        run_id,
    )?
    else {
        return Ok(());
    };
    if run["status"] != "running" {
        return Ok(());
    }
    let Some(attempt_id) = run["activeAttemptId"].as_str().map(str::to_owned) else {
        return Ok(());
    };
    let Some(mut attempt) = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1",
        &attempt_id,
    )?
    else {
        return Ok(());
    };
    if attempt["status"] == "pending" {
        return Ok(());
    }
    let Some(node_id) = run["rootNodeId"].as_str().map(str::to_owned) else {
        return Ok(());
    };
    let Some(root) = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
        &node_id,
    )?
    else {
        return Ok(());
    };
    let Some(mut turn)=read(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1",turn_id)? else {return Ok(());};
    if turn["runAttemptId"] != attempt_id {
        return Ok(());
    }
    if turn["status"] == "running" {
        turn["status"] = json!("interrupted");
        turn["completedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_provider_turns SET status='interrupted',completed_at=?2,payload_json=?3 WHERE provider_turn_id=?1",params![turn_id,now,turn.to_string()])?;
        events.push(("provider-turn.updated", turn.clone()));
    }
    if attempt["status"] == "running" {
        attempt["status"] = json!("interrupted");
        attempt["completedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='interrupted',payload_json=?2 WHERE attempt_id=?1",params![attempt_id,attempt.to_string()])?;
        events.push(("run-attempt.updated", attempt));
    }
    if let Some(mut provider)=read(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",provider_id)? {if provider["status"]=="active" && provider["lastRunOrdinal"]==run["ordinal"] {provider["status"]=json!("idle");provider["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='idle',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![provider_id,now,provider.to_string()])?;events.push(("provider-thread.updated",provider));}}
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE run_id=?1 AND streaming=1")?;
    let raws = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in raws {
        let mut m: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        m["streaming"] = json!(false);
        m["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_messages SET streaming=0,updated_at=?2,payload_json=?3 WHERE message_id=?1",params![m["id"].as_str(),now,m.to_string()])?;
        events.push(("message.updated", m));
    }
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE run_id=?1 AND status IN ('pending','running','waiting') AND node_id NOT IN (SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE origin='app_owned')")?;
    let raws = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in raws {
        let mut n: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        n["status"] = json!("interrupted");
        n["completedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![n["id"].as_str(),now,n.to_string()])?;
        events.push(("node.updated", n));
    }
    let mut stmt=tx.prepare("SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE run_id=?1 AND origin='provider_native' AND status IN ('pending','idle','running','waiting')")?;
    let native = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut visited = std::collections::HashSet::new();
    for id in native {
        end_native(tx, &effect.thread_id, &id, events, &mut visited, now)?;
    }
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND type IN ('assistant_message','reasoning') AND status IN ('pending','running','waiting')")?;
    let items = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in items {
        let mut item: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        item["status"] = json!("interrupted");
        item["streaming"] = json!(false);
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='interrupted',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![item["id"].as_str(),now,item.to_string()])?;
        events.push(("turn-item.updated", item));
    }
    let mut stmt=tx.prepare("SELECT q.payload_json FROM orchestration_v2_projection_runtime_requests q JOIN orchestration_v2_projection_nodes n ON n.node_id=q.node_id WHERE n.run_id=?1 AND q.status='pending'")?;
    let raws = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in raws {
        let mut q: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        q["status"] = json!("cancelled");
        q["resolvedAt"] = json!(now);
        q["responseCapability"] =
            json!({"type":"not_resumable","reason":"The run was interrupted."});
        tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='cancelled',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1",params![q["id"].as_str(),now,q.to_string()])?;
        events.push(("runtime-request.updated", q));
    }
    let request_id = signal(run_id, "interrupt-request");
    let request = read(
        tx,
        "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",
        &request_id,
    )?;
    let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[&effect.thread_id],|r|r.get(0))?;
    let item = json!({"id":signal(run_id,"interrupt-result"),"threadId":effect.thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":turn_id,"nativeItemRef":null,"parentItemId":request_id,"ordinal":ordinal,"status":"interrupted","title":"Interrupted","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_result","message":effect.request["reason"].as_str().or_else(||request.as_ref().and_then(|v|v["message"].as_str())).unwrap_or("Stopped by the provider")});
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'run_interrupt_result','interrupted',?9,?10) ON CONFLICT(turn_item_id) DO NOTHING",params![item["id"].as_str(),effect.thread_id,run_id,node_id,provider_id,turn_id,request_id,ordinal,now,item.to_string()])?;
    events.push(("turn-item.updated", item));
    run.as_object_mut().map(|r| r.remove("delegatedCompletion"));
    run["status"] = json!("interrupted");
    run["completedAt"] = json!(now);
    tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![run_id,now,run.to_string()])?;
    events.push(("run.updated", run));
    if let Some(scope) = root["checkpointScopeId"].as_str() {
        let command = format!("command:effect:checkpoint.capture:{run_id}");
        outbox::enqueue(
            tx,
            &Effect {
                id: format!("effect:checkpoint.capture:{run_id}"),
                command_id: command,
                thread_id: effect.thread_id.clone(),
                request: json!({"type":"checkpoint.capture","runId":run_id,"scopeId":scope}),
                status: "pending".into(),
                attempt_count: 0,
                available_at: now.into(),
                lease_owner: None,
                created_at: now.into(),
                updated_at: now.into(),
                completed_at: None,
                last_error: None,
            },
        )?;
    }
    Ok(())
}

/// Reconcile a successfully interrupted turn, guarded against newer active runs.
pub fn settle_background_after_interrupt(
    bus: &EventBus,
    sessions: &SessionRegistry,
    effect: &Effect,
    now: &str,
) -> Result<(), crate::event_bus::BusError> {
    let provider = effect.request["providerThreadId"].as_str().unwrap_or("");
    let turn = effect.request["providerTurnId"].as_str().unwrap_or("");
    bus.commit(|tx| {
        let context: Option<(String,i64,String)> = tx.query_row("SELECT r.run_id,r.ordinal,r.status FROM orchestration_v2_projection_provider_turns p JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=p.run_attempt_id JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id WHERE p.provider_turn_id=?1 AND p.provider_thread_id=?2 AND p.thread_id=?3 AND (r.status NOT IN ('preparing','starting','running') OR json_extract(r.payload_json,'$.activeAttemptId')=p.run_attempt_id)", params![turn,provider,effect.thread_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((run,ordinal,_)) = context else { return Ok(((),vec![])); };
        let newer: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id!=?2 AND status IN ('preparing','starting','running'))",params![effect.thread_id,run],|r|r.get(0))?;
        if newer { return Ok(((),vec![])); }
        let mut payloads = Vec::new();
        terminalize_confirmed_interrupt(tx, effect, &run, provider, turn, &mut payloads, now)?;
        stop_background_work(tx,sessions,&effect.command_id,&effect.thread_id,Some(provider),Some(provider),Some(ordinal),&mut payloads,now)?;
        let events: Vec<Event> = payloads.into_iter().map(|(kind,payload)| Event { id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:payload["threadId"].as_str().unwrap_or(&effect.thread_id).into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(format!("{}:background-work-settled",effect.id)),causation_event_id:None,correlation_id:Some(effect.command_id.clone()),actor_kind:"system".into(),payload,metadata:json!({}) }).collect();
        Ok(((),event_store::append(tx,&events)?))
    })
}

fn end_pull_request_watches(
    tx: &Transaction<'_>,
    thread: &Value,
    thread_id: &str,
    now: &str,
) -> rusqlite::Result<Option<Value>> {
    let mut updated = thread.clone();
    let mut changed = false;
    if let Some(links) = updated["pullRequests"].as_array_mut() {
        for link in links {
            if let Some(obj) = link.as_object_mut() {
                if let Some(watch) = obj.remove("watch") {
                    if !watch.is_null() {
                        obj.insert("endedWatch".into(), watch);
                        changed = true;
                    }
                }
            }
        }
    }
    if !changed {
        return Ok(None);
    }
    updated["updatedAt"] = json!(now);
    tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1", params![thread_id,now,updated.to_string()])?;
    Ok(Some(updated))
}

fn enqueue_delegated_stop(
    tx: &Transaction<'_>,
    command_id: &str,
    thread_id: &str,
    reason: Option<&str>,
    enabled: bool,
    now: &str,
) -> rusqlite::Result<()> {
    if !enabled {
        return Ok(());
    }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' AND json_extract(payload_json,'$.childThreadId') IS NOT NULL)", [thread_id], |r| r.get(0))?;
    if exists {
        let mut request = json!({"type":"delegated-tasks.stop"});
        if let Some(reason) = reason {
            request["reason"] = json!(reason);
        }
        outbox::enqueue(
            tx,
            &Effect {
                id: format!("effect:{command_id}:delegated-tasks.stop"),
                command_id: command_id.into(),
                thread_id: thread_id.into(),
                request,
                status: "pending".into(),
                attempt_count: 0,
                available_at: now.into(),
                lease_owner: None,
                created_at: now.into(),
                updated_at: now.into(),
                completed_at: None,
                last_error: None,
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[cfg(target_os = "linux")]
    #[test]
    fn pi_force_stop_retry_survives_restart_and_fails_closed_without_identity() {
        let path =
            std::env::temp_dir().join(format!("pi-stop-retry-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = rusqlite::Connection::open(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let effect = Effect {
            id: "pi-retry".into(),
            command_id: "pi-retry".into(),
            thread_id: "pi-retry-thread".into(),
            request: json!({"type":"provider-session.detach","providerSessionId":"pi-session","forceStopRetryThroughOrdinal":1,"forceStopPi":true,"promoteAfter":false,"processGroup":null}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: "now".into(),
            lease_owner: None,
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            last_error: None,
        };
        {
            let tx = db.transaction().unwrap();
            crate::outbox::enqueue(&tx, &effect).unwrap();
            tx.commit().unwrap();
        }
        drop(db);
        let db = rusqlite::Connection::open(&path).unwrap();
        let bus = EventBus::new(db, 16);
        let recovered = bus
            .commit(|tx| Ok((crate::outbox::get(tx, "pi-retry")?.unwrap(), vec![])))
            .unwrap();
        assert!(retry_pi_force_stop(&bus, &recovered, "now").is_err());
        let mut identified = recovered;
        identified.request["processGroup"] = json!(i32::MAX);
        assert!(retry_pi_force_stop(&bus, &identified, "now").is_ok());
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn opencode_force_stop_retry_survives_restart_and_promotes_after_remote_idle() {
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        };
        let dir = std::env::temp_dir().join(format!("t3-force-retry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let shell_active = Arc::new(AtomicBool::new(true));
        let malformed = Arc::new(AtomicBool::new(true));
        let delete_failure = Arc::new(AtomicBool::new(true));
        let requests = Arc::new(AtomicUsize::new(0));
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let active_server = active.clone();
        let shell_server = shell_active.clone();
        let malformed_server = malformed.clone();
        let failure_server = delete_failure.clone();
        let requests_server = requests.clone();
        let server = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                use axum::{body::Body,extract::Request,response::Response,routing::any,Router};
                let app=Router::new().fallback(any(move |request:Request| {let active=active_server.clone();let shell=shell_server.clone();let malformed=malformed_server.clone();let failure=failure_server.clone();let requests=requests_server.clone();async move {
                    let path=request.uri().path();
                    if path.starts_with("/api/") || path.starts_with("/session/") {requests.fetch_add(1,Ordering::Relaxed);}
                    if path=="/api/info" {return Response::new(Body::from(r#"{"version":"2.0.18"}"#));}
                    if path=="/api/session/active" {return Response::new(Body::from(if active.load(Ordering::Acquire){r#"{"data":{"native":{}}}"#}else{r#"{"data":{}}"#}));}
                    if path=="/api/session/native/interrupt" {active.store(false,Ordering::Release);return Response::new(Body::from("{}"));}
                    if path=="/api/experimental/job" {return Response::new(Body::from(if malformed.load(Ordering::Acquire){r#"{"data":[{"kind":"shell","shellID":"shell-1","sessionID":"native"}]}"#}else if shell.load(Ordering::Acquire){r#"{"data":[{"kind":"shell","shellID":"shell-1","sessionID":"native","status":"running"}]}"#}else{r#"{"data":[]}"#}));}
                    if path=="/api/shell/shell-1" && request.method()==axum::http::Method::DELETE {if failure.swap(false,Ordering::AcqRel){return Response::builder().status(503).body(Body::empty()).unwrap();}shell.store(false,Ordering::Release);return Response::new(Body::from("{}"));}
                    Response::builder().status(404).body(Body::empty()).unwrap()
                }}));
                axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(),app).with_graceful_shutdown(async {let _=shutdown_rx.await;}).await.unwrap();
            });
        });
        let settings = dir.join("settings.json");
        let entry = json!({"driver":"opencode","config":{"serverUrl":format!("http://{addr}"),"serverPassword":"first-password"}});
        crate::settings::Settings::new(settings.clone())
            .update(&json!({"providerInstances":{"opencode":entry}}))
            .unwrap();
        let saved = std::fs::read(&settings).unwrap();
        let resolved =
            crate::provider::opencode_executor::resolved_settings(Some(&settings)).unwrap();
        assert_eq!(
            resolved["providerInstances"]["opencode"]["config"]["serverPassword"],
            "first-password"
        );
        let identity = crate::provider::opencode_executor::connection_identity(
            &resolved["providerInstances"]["opencode"],
            &settings,
        )
        .unwrap();
        let dbpath = dir.join("state.sqlite");
        let mut db = rusqlite::Connection::open(&dbpath).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"opencode","model":"fixture/model"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "retry-thread",
                project_id: "p",
                title: "T",
                model_selection: &selection,
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
        let send = |command_id, message_id| DispatchMessage {
            context: None,
            command_id,
            thread_id: "retry-thread",
            message_id,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "opencode",
        };
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01Z").unwrap();
        dispatch_first_message(&bus, send("next", "m2"), "2026-01-01T00:00:02Z").unwrap();
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE thread_id='retry-thread' AND ordinal=1",[])?;Ok(((),vec![]))}).unwrap();
        let effect = Effect {
            id: "retry-original".into(),
            command_id: "retry-original".into(),
            thread_id: "retry-thread".into(),
            request: json!({"type":"provider-session.detach","providerSessionId":"session","forceStopRetryThroughOrdinal":1,"promoteAfter":true,"providerInstanceId":"opencode","nativeThreadId":"native","connectionIdentity":identity}),
            status: "running".into(),
            attempt_count: 5,
            available_at: "now".into(),
            lease_owner: None,
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            last_error: None,
        };
        renew_opencode_force_stop(&bus, &effect, "2026-01-01T00:00:03Z").unwrap();
        renew_opencode_force_stop(&bus, &effect, "2026-01-01T00:00:03Z").unwrap();
        drop(bus);
        let bus = EventBus::new(rusqlite::Connection::open(&dbpath).unwrap(), 16);
        use sha2::{Digest, Sha256};
        let retry_id = format!(
            "effect:force-stop-retry:{:x}",
            Sha256::digest(effect.id.as_bytes())
        );
        let retry=bus.commit(|tx| {
            let notice:String=tx.query_row("SELECT json_extract(payload_json,'$.message') FROM orchestration_v2_projection_turn_items WHERE thread_id='retry-thread' AND type='system_notice'",[],|row|row.get(0))?;
            assert!(notice.contains("still stopping"));
            Ok((crate::outbox::get(tx,&retry_id)?.unwrap(),vec![]))
        }).unwrap();
        let mut changed: Value = serde_json::from_slice(&saved).unwrap();
        changed["providerInstances"]["opencode"]["config"]["serverUrl"] =
            json!("http://127.0.0.1:1");
        std::fs::write(&settings, changed.to_string()).unwrap();
        assert!(
            retry_opencode_force_stop(&bus, &retry, &settings, "2026-01-01T00:00:04Z").is_err()
        );
        assert_eq!(requests.load(Ordering::Acquire), 0);
        std::fs::write(&settings, &saved).unwrap();
        let secret = std::fs::read_dir(dir.join("secrets"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|item| item.path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("provider-config-")
            })
            .unwrap();
        std::fs::write(&secret, b"rotated-password").unwrap();
        assert!(
            retry_opencode_force_stop(&bus, &retry, &settings, "2026-01-01T00:00:04Z").is_err()
        );
        assert_eq!(requests.load(Ordering::Acquire), 0);
        std::fs::write(&secret, b"first-password").unwrap();
        let mut prestart = retry.clone();
        prestart.thread_id = "prestart-test".into();
        prestart.request["prestart"] = json!(true);
        prestart.request["nativeThreadId"] = Value::Null;
        prestart.request["connectionIdentity"] = Value::Null;
        prestart.request["promoteAfter"] = json!(false);
        if cfg!(target_os = "linux") {
            retry_opencode_force_stop(&bus, &prestart, &settings, "2026-01-01T00:00:04Z").unwrap();
        } else {
            assert!(
                retry_opencode_force_stop(&bus, &prestart, &settings, "2026-01-01T00:00:04Z")
                    .is_err()
            );
        }
        assert!(
            retry_opencode_force_stop(&bus, &retry, &settings, "2026-01-01T00:00:05Z").is_err()
        );
        assert!(shell_active.load(Ordering::Acquire));
        malformed.store(false, Ordering::Release);
        assert!(
            retry_opencode_force_stop(&bus, &retry, &settings, "2026-01-01T00:00:05Z").is_err()
        );
        assert!(shell_active.load(Ordering::Acquire));
        bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='retry-thread' AND ordinal=2",[],|row|row.get(0))?;assert_eq!(status,"queued");Ok(((),vec![]))}).unwrap();
        retry_opencode_force_stop(&bus, &retry, &settings, "2026-01-01T00:00:06Z").unwrap();
        bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='retry-thread' AND ordinal=2",[],|row|row.get(0))?;assert_eq!(status,"starting");let notice:String=tx.query_row("SELECT json_extract(payload_json,'$.message') FROM orchestration_v2_projection_turn_items WHERE thread_id='retry-thread' AND type='system_notice'",[],|row|row.get(0))?;assert!(notice.contains("has stopped"));Ok(((),vec![]))}).unwrap();
        assert!(!active.load(Ordering::Acquire));
        assert!(!shell_active.load(Ordering::Acquire));
        let _ = shutdown.send(());
        server.join().unwrap();
        drop(bus);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn timeout_marks_request_and_confirmed_interrupt_settles_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "old",
        )
        .unwrap();
        bus.commit(|tx|{
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','running','old',?1)",[json!({"id":"r","threadId":"t","ordinal":1,"status":"running","activeAttemptId":"a","rootNodeId":"root","providerThreadId":"pt"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('a','t','r',1,'root','codex','pt','running',?1)",[json!({"id":"a","threadId":"t","runId":"r","status":"running"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('root','t','r','root','root_turn','running',?1)",[json!({"id":"root","threadId":"t","runId":"r","status":"running","checkpointScopeId":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','old',?1)",[json!({"id":"pt","threadId":"t","status":"active","lastRunOrdinal":1}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','t','pt','root','a',1,'running',?1)",[json!({"id":"turn","threadId":"t","providerThreadId":"pt","runAttemptId":"a","status":"running"}).to_string()])?;
            let request=json!({"id":signal("r","interrupt-request"),"threadId":"t","runId":"r","nodeId":"root","providerThreadId":"pt","providerTurnId":"turn","ordinal":1,"type":"run_interrupt_request","status":"completed","message":"Stopped by user"});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t','r','root','pt','turn',1,'run_interrupt_request','completed','old',?2)",params![request["id"].as_str(),request.to_string()])?;Ok(((),vec![]))
        }).unwrap();
        let effect = Effect {
            id: "interrupt".into(),
            command_id: "stop".into(),
            thread_id: "t".into(),
            request: json!({"type":"provider-turn.interrupt","providerThreadId":"pt","providerTurnId":"turn"}),
            status: "pending".into(),
            attempt_count: 1,
            available_at: "old".into(),
            lease_owner: None,
            created_at: "old".into(),
            updated_at: "old".into(),
            completed_at: None,
            last_error: None,
        };
        mark_interrupt_unresponsive(&bus, &effect, "timeout").unwrap();
        bus.commit(|tx|{let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(status,"running");let when:String=tx.query_row("SELECT json_extract(payload_json,'$.unresponsiveAt') FROM orchestration_v2_projection_turn_items WHERE type='run_interrupt_request'",[],|r|r.get(0))?;assert_eq!(when,"timeout");Ok(((),vec![]))}).unwrap();
        settle_background_after_interrupt(&bus, &SessionRegistry::default(), &effect, "end")
            .unwrap();
        settle_background_after_interrupt(&bus, &SessionRegistry::default(), &effect, "again")
            .unwrap();
        mark_interrupt_unresponsive(&bus, &effect, "late").unwrap();
        bus.commit(|tx|{let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(status,"interrupted");let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type='run_interrupt_result'",[],|r|r.get(0))?;assert_eq!(count,1);let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_id='effect:checkpoint.capture:r'",[],|r|r.get(0))?;assert_eq!(count,1);Ok(((),vec![]))}).unwrap();
    }

    #[test]
    fn force_stop_refuses_superseded_and_settles_running_run() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "old",
        )
        .unwrap();
        bus.commit(|tx|{
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','running','old',?1)",[json!({"id":"r","threadId":"t","ordinal":1,"status":"running","activeAttemptId":"a","rootNodeId":"root","providerThreadId":"pt"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('a','t','r',1,'root','codex','pt','running',?1)",[json!({"id":"a","threadId":"t","runId":"r","status":"running"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('root','t','r','root','root_turn','running',?1)",[json!({"id":"root","threadId":"t","runId":"r","status":"running","checkpointScopeId":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','old',?1)",[json!({"id":"pt","threadId":"t","status":"active","lastRunOrdinal":1}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','t','pt','root','a',1,'running',?1)",[json!({"id":"turn","threadId":"t","providerThreadId":"pt","runAttemptId":"a","status":"running"}).to_string()])?;
            let request=json!({"id":signal("r","interrupt-request"),"threadId":"t","runId":"r","nodeId":"root","providerThreadId":"pt","providerTurnId":"turn","ordinal":1,"type":"run_interrupt_request","status":"completed","message":"Stopped by user"});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t','r','root','pt','turn',1,'run_interrupt_request','completed','old',?2)",params![request["id"].as_str(),request.to_string()])?;Ok(((),vec![]))
        }).unwrap();
        let sessions = SessionRegistry::default();
        let error = force_stop_thread(&bus, &sessions, "t", Some("older"), "now").unwrap_err();
        assert_eq!(error["reason"], "superseded");
        bus.commit(|tx| {
            let state: String = tx.query_row(
                "SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(state, "running");
            Ok(((), vec![]))
        })
        .unwrap();
        let result = force_stop_thread(&bus, &sessions, "t", Some("r"), "now").unwrap();
        assert_eq!(result["outcome"], "released");
        bus.commit(|tx|{let state:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(state,"interrupted");let message:String=tx.query_row("SELECT json_extract(payload_json,'$.message') FROM orchestration_v2_projection_turn_items WHERE type='run_interrupt_result'",[],|r|r.get(0))?;assert_eq!(message,"Force stopped by user");Ok(((),vec![]))}).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn force_stop_preserves_shared_provider_session() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("force-shared-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sessions = SessionRegistry::default();
        sessions
            .open(
                "shared",
                crate::provider::CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        for id in ["t", "sibling"] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: &format!("create:{id}"),
                    thread_id: id,
                    project_id: "p",
                    title: "T",
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &source,
                    link_origin: None,
                    delegated_from: None,
                },
                &format!("event:{id}"),
                "old",
            )
            .unwrap();
        }
        bus.commit(|tx|{tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES('pt','t','codex','shared','idle','old',?1)",[json!({"id":"pt","threadId":"t","providerSessionId":"shared","status":"idle"}).to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('shared','t')",[])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('shared','sibling')",[])?;tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('sibling-run','sibling',1,'codex','running','old',?1)",[json!({"id":"sibling-run","threadId":"sibling","status":"running"}).to_string()])?;Ok(((),vec![]))}).unwrap();
        let result = force_stop_thread(&bus, &sessions, "t", None, "now").unwrap();
        assert_eq!(result["outcome"], "shared");
        assert_eq!(result["sharedWithThreadIds"], json!(["sibling"]));
        assert!(sessions.get("shared").unwrap().is_some());
        bus.commit(|tx|{let own:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='shared' AND thread_id='t')",[],|r|r.get(0))?;assert!(!own);Ok(((),vec![]))}).unwrap();
        sessions.remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn force_stop_releases_session_when_sibling_is_idle() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("force-shared-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sessions = SessionRegistry::default();
        sessions
            .open(
                "shared",
                crate::provider::CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        for id in ["t", "sibling"] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: &format!("create:{id}"),
                    thread_id: id,
                    project_id: "p",
                    title: "T",
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &source,
                    link_origin: None,
                    delegated_from: None,
                },
                &format!("event:{id}"),
                "old",
            )
            .unwrap();
        }
        bus.commit(|tx|{tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES('pt','t','codex','shared','idle','old',?1)",[json!({"id":"pt","threadId":"t","providerSessionId":"shared","status":"idle"}).to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('shared','t')",[])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('shared','sibling')",[])?;Ok(((),vec![]))}).unwrap();
        let result = force_stop_thread(&bus, &sessions, "t", None, "now").unwrap();
        assert_eq!(result["outcome"], "released");
        assert_eq!(result["sharedWithThreadIds"], json!([]));
        assert!(sessions.get("shared").unwrap().is_none());
        bus.commit(|tx|{let own:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='shared' AND thread_id='t')",[],|r|r.get(0))?;assert!(!own);Ok(((),vec![]))}).unwrap();
        sessions.remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn live_background_without_turn_is_an_error_not_a_false_stop() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("stop-owner-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sessions = SessionRegistry::default();
        sessions
            .open(
                "live",
                crate::provider::CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        let provider = json!({"id":"pt","status":"active","providerSessionId":"live","pendingBackgroundTasks":[]});
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','old',?1)",[provider.to_string()]).unwrap();
        let item = json!({"id":"work","threadId":"t","providerThreadId":"pt","providerTurnId":null,"type":"command_execution","status":"running"});
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES('work','t','pt',1,'command_execution','running','old',?1)",[item.to_string()]).unwrap();
        assert!(stop_background_work(
            &tx,
            &sessions,
            "stop",
            "t",
            None,
            None,
            None,
            &mut Vec::new(),
            "now"
        )
        .is_err());
        let state:String=tx.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id='work'",[],|r|r.get(0)).unwrap();
        assert_eq!(state, "running");
        sessions.remove("live").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_stop_ends_child_runless_tree_but_preserves_user_run() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        let task = json!({"id":"agent","threadId":"parent","origin":"provider_native","status":"running","childThreadId":"child"});
        tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('agent','parent','root','codex','provider_native','running','old',?1)",[task.to_string()]).unwrap();
        for (id, run) in [("native", None), ("user", Some("run"))] {
            let node = json!({"id":id,"threadId":"child","runId":run,"kind":"root_turn","status":"running"});
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES(?1,'child',?2,?1,'root_turn','running',?3)",params![id,run,node.to_string()]).unwrap();
            let item = json!({"id":format!("item:{id}"),"threadId":"child","nodeId":id,"runId":run,"type":"assistant_message","status":"running","streaming":true});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'child',?2,?3,1,'assistant_message','running','old',?4)",params![format!("item:{id}"),run,id,item.to_string()]).unwrap();
        }
        let mut events = Vec::new();
        end_native(
            &tx,
            "parent",
            "agent",
            &mut events,
            &mut std::collections::HashSet::new(),
            "now",
        )
        .unwrap();
        let state: String = tx
            .query_row(
                "SELECT status FROM orchestration_v2_projection_nodes WHERE node_id='native'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "interrupted");
        let user: String = tx
            .query_row(
                "SELECT status FROM orchestration_v2_projection_nodes WHERE node_id='user'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(user, "running");
        assert!(events.iter().any(|(kind, p)| *kind == "turn-item.updated"
            && p["threadId"] == "child"
            && p["streaming"] == false));
    }

    #[test]
    fn dead_background_owner_is_reconciled_without_erasing_persistent_tools() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        let provider = json!({"id":"pt","status":"active","providerSessionId":"missing","pendingBackgroundTasks":[{"id":"bg"}]});
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES ('pt','t','codex','active','old',?1)", [provider.to_string()]).unwrap();
        for (id, kind, input) in [
            ("work", "command_execution", json!({})),
            ("persistent", "dynamic_tool", json!({"persistent":true})),
        ] {
            let item = json!({"id":id,"threadId":"t","runId":null,"nodeId":null,"providerThreadId":"pt","providerTurnId":null,"ordinal":1,"type":kind,"status":"running","input":input});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,'t','pt',1,?2,'running','old',?3)", params![id,kind,item.to_string()]).unwrap();
        }
        let mut events = Vec::new();
        stop_background_work(
            &tx,
            &SessionRegistry::default(),
            "stop",
            "t",
            None,
            None,
            None,
            &mut events,
            "now",
        )
        .unwrap();
        let work: String = tx.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id='work'", [], |r| r.get(0)).unwrap();
        let persistent: String = tx.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id='persistent'", [], |r| r.get(0)).unwrap();
        let count: i64 = tx.query_row("SELECT json_array_length(json_extract(payload_json,'$.pendingBackgroundTasks')) FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='pt'", [], |r| r.get(0)).unwrap();
        assert_eq!(work, "interrupted");
        assert_eq!(persistent, "running");
        assert_eq!(count, 0);
        assert_eq!(
            events.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
            vec!["turn-item.updated", "provider-thread.updated"]
        );
    }

    #[test]
    fn interrupt_before_start_is_atomic_and_holds_queue() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        for (cmd, id) in [("send", "m"), ("queue", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: cmd,
                    thread_id: "t",
                    message_id: id,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:00.000Z",
            )
            .unwrap();
        }
        let result = interrupt_run(
            &bus,
            &SessionRegistry::default(),
            "stop",
            "t",
            "run:thread:t:ordinal:1",
            None,
            true,
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx| {
            let state: String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0))?; assert_eq!(state,"interrupted");
            let held: bool=tx.query_row("SELECT json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?; assert!(held);
            let status: String=tx.query_row("SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start'",[],|r|r.get(0))?; assert_eq!(status,"cancelled");
            let count: i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type IN ('run_interrupt_request','run_interrupt_result')",[],|r|r.get(0))?; assert_eq!(count,2);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn thread_stop_interrupts_and_holds_queue() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        for (cmd, id) in [("send", "m"), ("queue", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: cmd,
                    thread_id: "t",
                    message_id: id,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:00.000Z",
            )
            .unwrap();
        }
        bus.commit(|tx| {
            tx.execute(r#"UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.pullRequests',json('[{"watch":{"id":"w"}}]')) WHERE thread_id='t'"#, [])?;
            Ok(((), vec![]))
        }).unwrap();
        let result = stop_thread(
            &bus,
            &SessionRegistry::default(),
            "stop",
            "t",
            None,
            true,
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx| {
            let watch: String = tx.query_row("SELECT json_extract(payload_json,'$.pullRequests[0].endedWatch.id') FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0))?;
            assert_eq!(watch, "w");
            let state: String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0))?; assert_eq!(state,"interrupted");
            let held: bool=tx.query_row("SELECT json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?; assert!(held);
            let status: String=tx.query_row("SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start'",[],|r|r.get(0))?; assert_eq!(status,"cancelled");
            let count: i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type IN ('run_interrupt_request','run_interrupt_result')",[],|r|r.get(0))?; assert_eq!(count,2);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn force_stop_prestart_checks_target_and_cancels_start() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        for (cmd, id) in [("send", "m"), ("queue", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: cmd,
                    thread_id: "t",
                    message_id: id,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:00.000Z",
            )
            .unwrap();
        }
        let sessions = SessionRegistry::default();
        let error = force_stop_thread(
            &bus,
            &sessions,
            "t",
            Some("other"),
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap_err();
        assert_eq!(error["reason"], "superseded");
        let result = force_stop_thread(
            &bus,
            &sessions,
            "t",
            Some("run:thread:t:ordinal:1"),
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert_eq!(result["outcome"], "released");
        bus.commit(|tx| {
            let state:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0))?;assert_eq!(state,"interrupted");
            let status:String=tx.query_row("SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start' ORDER BY created_at LIMIT 1",[],|r|r.get(0))?;assert_eq!(status,"cancelled");
            let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type IN ('run_interrupt_request','run_interrupt_result')",[],|r|r.get(0))?;assert_eq!(count,2);
            Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn interrupt_before_start_promotes_unheld_queue() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        for (cmd, id) in [("send", "m"), ("queue", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: cmd,
                    thread_id: "t",
                    message_id: id,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:00.000Z",
            )
            .unwrap();
        }
        let result = interrupt_run(
            &bus,
            &SessionRegistry::default(),
            "stop",
            "t",
            "run:thread:t:ordinal:1",
            None,
            false,
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx| {
            let state: String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0))?; assert_eq!(state,"interrupted");
            let state: String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?; assert_eq!(state,"starting");
            let effects: i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start' AND status='pending'",[],|r|r.get(0))?; assert_eq!(effects,1);
            let count: i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type IN ('run_interrupt_request','run_interrupt_result')",[],|r|r.get(0))?; assert_eq!(count,2);
            Ok(((),vec![]))
        }).unwrap();
    }
}
