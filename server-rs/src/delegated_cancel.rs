//! Atomic local cancellation of a delegated task's runs.
//!
//! Local descendant cancellation is atomic. Unsupported native/background work is
//! rejected before any stop is committed. Result delivery is disposed after commit.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    provider::session_registry::SessionRegistry,
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

fn load(tx: &Transaction<'_>, sql: &str, args: &[&str]) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row(sql, rusqlite::params_from_iter(args), |r| r.get(0))
        .optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

/// Cancel the named local task, provided it belongs to `parent` and its child
/// thread is still the expected child. Replays return the original receipt.
/// Stops reachable local descendant runs atomically. Native subagents and background
/// work require provider stop support and are rejected while active.
#[allow(clippy::too_many_arguments)]
pub fn cancel_local(
    bus: &EventBus,
    sessions: &SessionRegistry,
    command: &str,
    parent: &str,
    task_id: &str,
    child: &str,
    reason: &str,
    now: &str,
) -> Result<CommitResult, BusError> {
    let result = bus.commit(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command, "thread")? {
            if receipt.aggregate_id != parent || receipt.command_type != "delegated-task.cancel-local" { return Err(rusqlite::Error::InvalidQuery); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let mut task = load(tx, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned'", &[parent, task_id])?;
        let valid = task.as_ref().is_some_and(|t| t["id"] == task_id && t["threadId"] == parent && t["childThreadId"] == child)
            && load(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", &[child])?.is_some_and(|t| t["lineage"]["parentThreadId"] == parent && t["lineage"]["relationshipToParent"] == "subagent");
        let mut receipt = Receipt {command_id:command.into(), aggregate_kind:"thread".into(), aggregate_id:parent.into(), command_type:"delegated-task.cancel-local".into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(parent))?, status:if valid {"accepted"} else {"rejected"}.into(), error:(!valid).then(||format!("Delegated task {task_id} does not belong to thread {parent}."))};
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if !valid { return Ok((CommitResult {receipt, committed:false},vec![])); }
        // A concurrent settlement must not let cancellation rewrite a finished result.
        if task.as_ref().and_then(|t| t["status"].as_str()).is_some_and(|s| matches!(s, "completed" | "failed" | "cancelled" | "interrupted")) {
            receipt.status = "rejected".into();
            receipt.error = Some("Stopping later work on a terminal task is not supported.".into());
            event_store::upsert_receipt(tx, &receipt)?;
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        // Hold the SQLite write lock while checking every reachable local child,
        // so a mode change cannot race the cancellation transaction.
        let modes: Option<(String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [parent], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (parent_runtime,parent_interaction) = modes.ok_or(rusqlite::Error::InvalidQuery)?;
        let runtime_rank = |mode: &str| match mode { "approval-required"=>Some(0), "auto-accept-edits"=>Some(1), "auto"=>Some(2), "full-access"=>Some(3), _=>None };
        let interaction_rank = |mode: &str| match mode { "plan"=>Some(0), "default"=>Some(1), _=>None };
        let pr = runtime_rank(&parent_runtime).ok_or(rusqlite::Error::InvalidQuery)?;
        let pi = interaction_rank(&parent_interaction).ok_or(rusqlite::Error::InvalidQuery)?;
        let mut stmt = tx.prepare("WITH RECURSIVE descendants(id) AS (SELECT ?1 UNION SELECT s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.id WHERE s.origin='app_owned' AND s.child_thread_id IS NOT NULL) SELECT t.runtime_mode,t.interaction_mode FROM descendants d JOIN orchestration_v2_projection_threads t ON t.thread_id=d.id WHERE t.deleted_at IS NULL")?;
        let modes = stmt.query_map([child], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (runtime,interaction) in modes {
            let error = if runtime_rank(&runtime).ok_or(rusqlite::Error::InvalidQuery)? > pr { Some(format!("Child runtime mode {runtime} is broader than parent mode {parent_runtime}.")) }
                else if interaction_rank(&interaction).ok_or(rusqlite::Error::InvalidQuery)? > pi { Some(format!("Child interaction mode {interaction} is broader than parent mode {parent_interaction}.")) } else {None};
            if let Some(error)=error {receipt.status="rejected".into();receipt.error=Some(error);event_store::upsert_receipt(tx,&receipt)?;return Ok((CommitResult{receipt,committed:false},vec![]));}
        }
        // Refuse unsupported work before changing any projection or scheduling effects.
        // A successful receipt must never imply that live native work was stopped.
        let unsupported: bool = tx.query_row("WITH RECURSIVE descendants(id) AS (SELECT ?1 UNION SELECT s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.id WHERE s.origin='app_owned' AND s.child_thread_id IS NOT NULL) SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.id WHERE s.origin != 'app_owned' AND s.status IN ('running','pending','waiting')) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p JOIN descendants d ON p.thread_id=d.id WHERE json_array_length(COALESCE(json_extract(p.payload_json,'$.pendingBackgroundTasks'),'[]')) > 0)", [child], |r| r.get(0))?;
        // Some provider events have not yet reached (or cannot be represented in)
        // the projections. Consult the live session tracker as well; otherwise an
        // accepted cancellation could leave an observed native child running.
        let mut stmt = tx.prepare("WITH RECURSIVE descendants(id) AS (SELECT ?1 UNION SELECT s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.id WHERE s.origin='app_owned' AND s.child_thread_id IS NOT NULL) SELECT DISTINCT json_extract(p.payload_json,'$.providerSessionId') FROM orchestration_v2_projection_provider_threads p JOIN descendants d ON p.thread_id=d.id WHERE json_type(p.payload_json,'$.providerSessionId')='text'")?;
        let session_ids = stmt.query_map([child], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut tracked_work = false;
        for id in session_ids {
            if sessions.has_pending_background_work(&id).map_err(|_| rusqlite::Error::InvalidQuery)? {
                tracked_work = true;
                break;
            }
        }
        if unsupported || tracked_work {
            receipt.status="rejected".into();
            receipt.error=Some("Stopping native subagents or background work is not supported by this provider.".into());
            event_store::upsert_receipt(tx,&receipt)?;
            return Ok((CommitResult{receipt,committed:false},vec![]));
        }
        let mut stmt = tx.prepare("WITH RECURSIVE descendants(parent,task,child) AS (SELECT ?1,?2,?3 UNION SELECT s.thread_id,s.subagent_id,s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.child WHERE s.origin='app_owned' AND s.child_thread_id IS NOT NULL AND s.status IN ('running','pending')) SELECT parent,task,child FROM descendants")?;
        let descendants = stmt.query_map(params![parent,task_id,child], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (owner, id, thread) in &descendants {
            let interruptible: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND (status IN ('preparing','starting','running') OR (status='queued' AND (json_extract(payload_json,'$.delegatedTaskId')=?2 OR run_id=json_extract((SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?3 AND subagent_id=?2),'$.childRunId')))))", params![thread,id,owner], |r| r.get(0))?;
            if !interruptible {
                receipt.status="rejected".into();
                receipt.error=Some(format!("Delegated task {id} has no interruptible child run."));
                event_store::upsert_receipt(tx,&receipt)?;
                return Ok((CommitResult{receipt,committed:false},vec![]));
            }
        }
        let mut planned: Vec<(String,&str,Value)> = Vec::new();
        for (index,(parent,task_id,child)) in descendants.iter().enumerate() {
        let (parent,task_id,child) = (parent.as_str(),task_id.as_str(),child.as_str());
        let mut task = if index == 0 { task.take().unwrap() } else { load(tx, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned'", &[parent,task_id])?.ok_or(rusqlite::Error::InvalidQuery)? };
        let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running') ORDER BY ordinal")?;
        let raws = stmt.query_map([child], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let runs: Vec<Value> = raws.iter().map(|s| serde_json::from_str(s).map_err(|_|rusqlite::Error::InvalidQuery)).collect::<rusqlite::Result<_>>()?;
        let selected = runs.iter().rev().find(|r| r["status"] != "queued").or_else(|| runs.iter().rev().find(|r| r["delegatedTaskId"] == task_id || r["id"] == task["childRunId"]));
        if selected.is_none() { receipt.status="rejected".into(); receipt.error=Some(format!("Delegated task {task_id} has no interruptible child run.")); event_store::upsert_receipt(tx,&receipt)?; return Ok((CommitResult{receipt,committed:false},vec![])); }
        task["cancelledRunId"] = selected.unwrap()["id"].clone(); task["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_subagents SET updated_at=?3,payload_json=?4 WHERE thread_id=?1 AND subagent_id=?2",params![parent,task_id,now,task.to_string()])?;
        planned.push((parent.to_owned(),"subagent.updated",task.clone()));
        for mut run in runs {
            let id = run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
            if run["status"] == "queued" {
                if run["delegatedTaskId"] != task_id && run["id"] != task["childRunId"] { continue; }
                run["status"]=json!("cancelled"); run["queuePosition"]=Value::Null; run["completedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![id,now,run.to_string()])?;
                for (table,key,field,kind) in [("orchestration_v2_projection_run_attempts","attempt_id","activeAttemptId","run-attempt.updated"),("orchestration_v2_projection_nodes","node_id","rootNodeId","node.updated")] {
                    if let Some(value) = run[field].as_str() { if let Some(mut v) = load(tx,&format!("SELECT payload_json FROM {table} WHERE {key}=?1 AND thread_id=?2"), &[value,child])? {v["status"]=json!("cancelled"); v["completedAt"]=json!(now); tx.execute(&format!("UPDATE {table} SET status='cancelled',payload_json=?2 WHERE {key}=?1"),params![value,v.to_string()])?; planned.push((child.to_owned(),kind,v));} }
                }
                planned.push((child.to_owned(),"run.updated",run)); continue;
            }
            let provider_id = run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let attempt_id = run["activeAttemptId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let provider = load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",&[provider_id,child])?.ok_or(rusqlite::Error::InvalidQuery)?;
            let turn = load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY ordinal DESC LIMIT 1",&[attempt_id])?;
            let sid = provider["providerSessionId"].as_str();
            let live = sid.map(|s|sessions.get(s).map(|v|v.is_some()).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()?.unwrap_or(false);
            if live && turn.is_some() {
                let tid=turn.as_ref().and_then(|t|t["id"].as_str()).ok_or(rusqlite::Error::InvalidQuery)?;
                outbox::enqueue(tx,&Effect{id:format!("effect:{command}:provider-turn.interrupt:{tid}"),command_id:command.into(),thread_id:child.into(),request:json!({"type":"provider-turn.interrupt","providerSessionId":sid,"providerThreadId":provider_id,"providerTurnId":tid,"reason":reason}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
            } else {
                if let Some(mut turn)=turn { let tid=turn["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned(); turn["status"]=json!("interrupted");turn["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_provider_turns SET status='interrupted',completed_at=?2,payload_json=?3 WHERE provider_turn_id=?1",params![tid,now,turn.to_string()])?;planned.push((child.to_owned(),"provider-turn.updated",turn)); }
                for (table,key,field,kind) in [("orchestration_v2_projection_run_attempts","attempt_id","activeAttemptId","run-attempt.updated"),("orchestration_v2_projection_nodes","node_id","rootNodeId","node.updated")] {let value=run[field].as_str().ok_or(rusqlite::Error::InvalidQuery)?;let mut v=load(tx,&format!("SELECT payload_json FROM {table} WHERE {key}=?1 AND thread_id=?2"),&[value,child])?.ok_or(rusqlite::Error::InvalidQuery)?;v["status"]=json!("interrupted");v["completedAt"]=json!(now);tx.execute(&format!("UPDATE {table} SET status='interrupted',payload_json=?2 WHERE {key}=?1"),params![value,v.to_string()])?;planned.push((child.to_owned(),kind,v));}
                run["status"]=json!("interrupted");run["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![id,now,run.to_string()])?;planned.push((child.to_owned(),"run.updated",run));
                outbox::cancel_unsettled(tx,child,&["provider-turn.start".into(),"provider-turn.restart".into()],"The delegated task was cancelled.",now)?;
            }
        }
        }
        let events: Vec<Event>=planned.into_iter().map(|(thread,kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread,event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.into()),causation_event_id:None,correlation_id:Some(command.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let events=event_store::append(tx,&events)?; receipt.result_sequence=events.iter().rfind(|e|e.event.stream_id==parent).map(|e|e.sequence).unwrap_or(receipt.result_sequence);event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},events))
    })?;
    if result.receipt.status == "accepted" {
        // This is idempotent and is retried even if the stop receipt already exists.
        crate::delegated_ack::dispose(bus, &format!("{command}:dispose"), parent, task_id, now)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_cancel_is_atomic_scoped_and_replayable() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('parent','p','Parent','codex','full-access','default','now','now','{}')", []).unwrap();
        let thread = json!({"id":"child","lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"}});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('child','p','Child','codex','full-access','default','now','now',?1)",[thread.to_string()]).unwrap();
        let task = json!({"id":"task","threadId":"parent","origin":"app_owned","childThreadId":"child","childRunId":"run","status":"running"});
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('task','parent','node','codex','child','app_owned','running','now',?1)",[task.to_string()]).unwrap();
        let run = json!({"id":"run","threadId":"child","status":"queued","delegatedTaskId":"task","queuePosition":1});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('run','child',1,'codex','queued','now',?1)",[run.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let sessions = SessionRegistry::default();
        let unauthorized = cancel_local(
            &bus, &sessions, "bad", "other", "task", "child", "stop", "now",
        )
        .unwrap();
        assert_eq!(unauthorized.receipt.status, "rejected");
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='approval-required' WHERE thread_id='parent'", [])?; Ok(((),vec![])) }).unwrap();
        let denied = cancel_local(
            &bus,
            &sessions,
            "mode-denied",
            "parent",
            "task",
            "child",
            "stop",
            "now",
        )
        .unwrap();
        assert_eq!(denied.receipt.status, "rejected");
        assert!(denied
            .receipt
            .error
            .unwrap()
            .contains("broader than parent"));
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='full-access' WHERE thread_id='parent'", [])?; Ok(((),vec![])) }).unwrap();
        // Failure after marking the task and touching queued work rolls back the entire transaction.
        bus.commit(|tx| {
            let broken = json!({"id":"broken","threadId":"child","status":"running"});
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('broken','child',2,'codex','running','now',?1)", [broken.to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        assert!(cancel_local(
            &bus, &sessions, "rollback", "parent", "task", "child", "stop", "now"
        )
        .is_err());
        bus.commit(|tx| {
            let status: String = tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run'", [], |r| r.get(0))?;
            assert_eq!(status, "queued");
            let marker: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.cancelledRunId') FROM orchestration_v2_projection_subagents WHERE subagent_id='task'", [], |r| r.get(0))?;
            assert!(marker.is_none());
            tx.execute("DELETE FROM orchestration_v2_projection_runs WHERE run_id='broken'", [])?;
            Ok(((), vec![]))
        }).unwrap();
        bus.commit(|tx| {
            let thread = json!({"id":"grandchild","lineage":{"parentThreadId":"child","relationshipToParent":"subagent"}});
            tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('grandchild','p','Grandchild','codex','full-access','default','now','now',?1)", [thread.to_string()])?;
            let task = json!({"id":"nested","threadId":"child","origin":"app_owned","childThreadId":"grandchild","childRunId":"nested-run","status":"running"});
            tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('nested','child','node','codex','grandchild','app_owned','running','now',?1)", [task.to_string()])?;
            let run = json!({"id":"nested-run","threadId":"grandchild","status":"queued","delegatedTaskId":"nested","queuePosition":1});
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('nested-run','grandchild',1,'codex','queued','now',?1)", [run.to_string()])?;
            let native = json!({"id":"native","threadId":"grandchild","origin":"provider_native","status":"running"});
            tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('native','grandchild','node','codex','provider_native','running','now',?1)", [native.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let unsupported = cancel_local(
            &bus,
            &sessions,
            "unsupported",
            "parent",
            "task",
            "child",
            "stop",
            "now",
        )
        .unwrap();
        assert_eq!(unsupported.receipt.status, "rejected");
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_subagents SET status='waiting' WHERE subagent_id='native'", [])?; Ok(((), vec![])) }).unwrap();
        let waiting = cancel_local(
            &bus,
            &sessions,
            "waiting-native",
            "parent",
            "task",
            "child",
            "stop",
            "now",
        )
        .unwrap();
        assert_eq!(waiting.receipt.status, "rejected");
        bus.commit(|tx| {
            let status: String = tx.query_row(
                "SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "queued");
            tx.execute(
                "DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id='native'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        let result = cancel_local(
            &bus, &sessions, "cancel", "parent", "task", "child", "stop", "now",
        )
        .unwrap();
        assert!(result.committed);
        bus.commit(|tx| {
            let state: String = tx.query_row("SELECT completion_delivery_state FROM orchestration_v2_projection_subagents WHERE subagent_id='task'", [], |r| r.get(0))?;
            assert_eq!(state, "disposed");
            let nested: String = tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='nested-run'", [], |r| r.get(0))?;
            assert_eq!(nested, "cancelled");
            Ok(((),vec![]))
        }).unwrap();
        let replay = cancel_local(
            &bus, &sessions, "cancel", "parent", "task", "child", "stop", "now",
        )
        .unwrap();
        assert!(!replay.committed);
        bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run'",[],|r|r.get(0))?;assert_eq!(status,"cancelled");let marked:String=tx.query_row("SELECT json_extract(payload_json,'$.cancelledRunId') FROM orchestration_v2_projection_subagents WHERE subagent_id='task'",[],|r|r.get(0))?;assert_eq!(marked,"run");Ok(((),vec![]))}).unwrap();
    }
}
