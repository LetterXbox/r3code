//! Transactional thread tombstoning and durable cleanup planning.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    only_if_unused: bool,
    now: &str,
) -> Result<CommitResult, BusError> {
    bus.commit(|tx| {
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|r.get(0)).optional()?;
        let error=raw.is_none().then(||format!("Thread {thread_id} does not exist."));
        let mut hydrated = if raw.is_some() { crate::project_mutation::hydrate_legacy_transcript(tx,thread_id,now)? } else { vec![] };
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"thread.delete".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        event_store::insert_receipt_if_absent(tx,&receipt)?;
        if receipt.error.is_some() {return Ok((CommitResult{receipt,committed:false},vec![]));}
        let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 UNION ALL SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id=?1)",[thread_id],|r|r.get(0))?;
        if only_if_unused && used {return Ok((CommitResult{receipt,committed:true},hydrated));}
        let mut ids=vec![thread_id.to_owned()];
        let mut stmt=tx.prepare("SELECT DISTINCT t.target_thread_id FROM orchestration_v2_projection_context_transfers t JOIN orchestration_v2_projection_threads c ON c.thread_id=t.target_thread_id WHERE t.source_thread_id=?1 AND t.type='fork' AND c.deleted_at IS NULL AND json_extract(c.payload_json,'$.lineage.sideChat')=1 ORDER BY t.rowid")?;
        ids.extend(stmt.query_map([thread_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?); drop(stmt);
        let mut events=Vec::new();
        for (index,id) in ids.iter().enumerate() { let cmd=if index==0 {command_id.to_owned()} else {format!("{command_id}:side-chat:{id}")}; if index > 0 { hydrated.extend(crate::project_mutation::hydrate_legacy_transcript(tx,id,now)?); } delete_one(tx,id,&cmd,now,&mut events)?; }
        let stored=event_store::append(tx,&events)?;
        if let Some(last)=stored.last() {receipt.result_sequence=last.sequence; event_store::upsert_receipt(tx,&receipt)?;}
        hydrated.extend(stored);
        Ok((CommitResult{receipt,committed:true},hydrated))
    })
}
fn rows(tx: &Transaction<'_>, sql: &str, tid: &str) -> rusqlite::Result<Vec<Value>> {
    let mut s = tx.prepare(sql)?;
    let raws = s
        .query_map([tid], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    raws.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect()
}
fn emit(events: &mut Vec<Event>, tid: &str, cmd: &str, now: &str, kind: &str, payload: Value) {
    events.push(Event {
        id: uuid::Uuid::new_v4().to_string(),
        aggregate_kind: "thread".into(),
        stream_id: tid.into(),
        event_type: kind.into(),
        occurred_at: now.into(),
        command_id: Some(cmd.into()),
        causation_event_id: None,
        correlation_id: Some(cmd.into()),
        actor_kind: "client".into(),
        payload,
        metadata: json!({}),
    });
}
fn effect(
    tx: &Transaction<'_>,
    tid: &str,
    cmd: &str,
    now: &str,
    suffix: &str,
    request: Value,
) -> rusqlite::Result<()> {
    outbox::enqueue(
        tx,
        &Effect {
            id: format!("effect:{cmd}:{suffix}"),
            command_id: cmd.into(),
            thread_id: tid.into(),
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
    Ok(())
}
pub(crate) fn delete_one(
    tx: &Transaction<'_>,
    tid: &str,
    cmd: &str,
    now: &str,
    events: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let raw: String = tx.query_row(
        "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",
        [tid],
        |r| r.get(0),
    )?;
    let mut thread: Value =
        serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if thread["deletedAt"].is_null() {
        thread["deletedAt"] = json!(now);
    }
    thread["updatedAt"] = json!(now);
    thread["titleRegeneration"] = Value::Null;
    tx.execute("UPDATE orchestration_v2_projection_threads SET deleted_at=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1",params![tid,thread["deletedAt"].as_str(),now,thread.to_string()])?;
    emit(events, tid, cmd, now, "thread.deleted", thread.clone());
    let mut runs=rows(tx,"SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal",tid)?;
    let mut active = HashSet::new();
    for run in &mut runs {
        if matches!(
            run["status"].as_str(),
            Some("preparing" | "queued" | "starting" | "running" | "waiting")
        ) {
            let id = run["id"]
                .as_str()
                .ok_or(rusqlite::Error::InvalidQuery)?
                .to_owned();
            active.insert(id.clone());
            run["status"] = json!("cancelled");
            run["queuePosition"] = Value::Null;
            run["completedAt"] = json!(now);
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![id,now,run.to_string()])?;
            emit(events, tid, cmd, now, "run.updated", run.clone());
        }
    }
    for (table,key,kind,sql) in [("orchestration_v2_projection_run_attempts","attempt_id","run-attempt.updated","SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 ORDER BY run_id,attempt_ordinal"),("orchestration_v2_projection_nodes","node_id","node.updated","SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 ORDER BY rowid")] {for mut row in rows(tx,sql,tid)? { if active.contains(row["runId"].as_str().unwrap_or("")) && matches!(row["status"].as_str(),Some("pending"|"running"|"waiting")) {let id=row["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();row["status"]=json!("cancelled");row["completedAt"]=json!(now);tx.execute(&format!("UPDATE {table} SET status='cancelled',payload_json=?2 WHERE {key}=?1"),params![id,row.to_string()])?;emit(events,tid,cmd,now,kind,row);}}}
    for mut req in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' ORDER BY rowid",tid)? {let id=req["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();req["status"]=json!("cancelled");req["resolvedAt"]=json!(now);req["responseCapability"]=json!({"type":"not_resumable","reason":"The thread was deleted."});tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='cancelled',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1",params![id,now,req.to_string()])?;emit(events,tid,cmd,now,"runtime-request.updated",req);}
    let tasks=rows(tx,"SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' ORDER BY started_at,subagent_id",tid)?;
    for run in &mut runs {
        let id = run["id"].as_str().unwrap_or("").to_owned();
        if run.get("delegatedCompletion").is_none() && !tasks.iter().any(|t| t["runId"] == id) {
            continue;
        }
        let generation = run["delegatedCompletion"]["nextGeneration"]
            .as_i64()
            .unwrap_or(1);
        run["delegatedCompletion"] =
            json!({"disposition":"disposed","nextGeneration":generation,"delivery":null});
        tx.execute(
            "UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",
            params![id, run.to_string()],
        )?;
        emit(events, tid, cmd, now, "run.updated", run.clone());
        for mut task in tasks.iter().filter(|t| t["runId"] == id).cloned() {
            if matches!(
                task["completionDelivery"]["state"].as_str(),
                Some("acknowledged" | "delivered" | "disposed")
            ) {
                continue;
            }
            let task_id = task["id"]
                .as_str()
                .ok_or(rusqlite::Error::InvalidQuery)?
                .to_owned();
            task["completionDelivery"] = json!({"state":"disposed","observedByRunId":null});
            task["updatedAt"] = json!(now);
            tx.execute("UPDATE orchestration_v2_projection_subagents SET updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![task_id,now,task.to_string()])?;
            emit(events, tid, cmd, now, "subagent.updated", task);
        }
    }
    let mut stmt=tx.prepare("SELECT s.provider_session_id FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.status!='stopped' ORDER BY s.updated_at,s.provider_session_id")?;
    let sessions = stmt
        .query_map([tid], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for id in sessions {
        tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![tid,id])?;
        emit(
            events,
            tid,
            cmd,
            now,
            "provider-session.detached",
            json!({"providerSessionId":id,"detachedAt":now,"reason":"Thread deleted."}),
        );
        effect(
            tx,
            tid,
            cmd,
            now,
            &format!("provider-session.detach:{id}"),
            json!({"type":"provider-session.detach","providerSessionId":id,"detail":"Thread deleted.","revokeMcpCredential":true}),
        )?;
    }
    for kind in [
        "scheduled-tasks.cleanup",
        "terminal.cleanup",
        "preview.cleanup",
    ] {
        effect(tx, tid, cmd, now, kind, json!({"type":kind}))?;
    }
    let messages=rows(tx,"SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 ORDER BY created_at,message_id",tid)?;
    let question_items=rows(tx,"SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_input_request'",tid)?;
    let mut attachments = Vec::new();
    let mut seen = HashSet::new();
    for value in messages.iter().chain(question_items.iter()).chain(std::iter::once(&thread)) {
        collect_attachments(value, &mut seen, &mut attachments);
    }
    if !attachments.is_empty() {
        effect(
            tx,
            tid,
            cmd,
            now,
            "attachment.cleanup",
            json!({"type":"attachment.cleanup","attachmentIds":attachments}),
        )?;
    }
    Ok(())
}
fn collect_attachments(value: &Value, seen: &mut HashSet<String>, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get("attachments") {
                for item in items {
                    if let Some(id) = item["id"].as_str() {
                        if seen.insert(id.to_owned()) {
                            out.push(id.to_owned());
                        }
                    }
                }
            }
            if let Some(Value::Object(by_question)) = map.get("attachmentsByQuestionId") {
                for items in by_question.values() {
                    if let Some(items) = items.as_array() {
                        for item in items {
                            if let Some(id) = item["id"].as_str() {
                                if seen.insert(id.to_owned()) {
                                    out.push(id.to_owned());
                                }
                            }
                        }
                    }
                }
            }
            for v in map.values() {
                collect_attachments(v, seen, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_attachments(item, seen, out)
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread_commands::{create_thread_ordered, CreateThread};
    #[test]
    fn deletion_cancels_work_and_persists_cleanup_once() {
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
        bus.commit(|tx| { let run=json!({"id":"r","status":"running","delegatedCompletion":{"nextGeneration":3}}); tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','running','now',?1)",[run.to_string()])?; Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| {
            tx.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES('legacy','t','user','old text',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])?;
            tx.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at) VALUES('t','2026-01-01','2026-01-01')", [])?;
            Ok(((),vec![]))
        }).unwrap();
        let unused = dispatch(&bus, "unused", "t", true, "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(unused.receipt.status, "accepted");
        bus.commit(|tx| { let text:String = tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE message_id='legacy'", [], |r|r.get(0))?; assert_eq!(text,"old text"); Ok(((),vec![])) }).unwrap();
        let first = dispatch(&bus, "delete", "t", false, "2026-01-02T00:00:00Z").unwrap();
        let replay = dispatch(&bus, "delete", "t", false, "2026-01-03T00:00:00Z").unwrap();
        assert_eq!(
            first.receipt.result_sequence,
            replay.receipt.result_sequence
        );
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='r'",
                [],
                |r| r.get(0),
            )?;
            let run: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(run["status"], "cancelled");
            assert_eq!(run["delegatedCompletion"]["disposition"], "disposed");
            assert_eq!(run["delegatedCompletion"]["nextGeneration"], 3);
            let n: i64 = tx.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE command_id='delete'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 3);
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
