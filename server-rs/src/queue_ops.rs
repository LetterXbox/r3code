//! Guarded edits and cancellation of queued runs.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub enum QueueOp<'a> {
    Cancel,
    Edit {
        text: &'a str,
        attachments: Option<&'a Value>,
        context: Option<&'a Value>,
    },
}

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    run_id: &str,
    op: QueueOp<'_>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, run_id, op, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    run_id: &str,
    op: QueueOp<'_>,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {if receipt.aggregate_id != thread_id { return Err(rusqlite::Error::InvalidQuery); } return Ok((CommitResult{receipt,committed:false},vec![]));}
        let kind=match op {QueueOp::Cancel=>"queued-run.cancel",QueueOp::Edit{..}=>"queued-run.edit"};
        let raw: Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status='queued'",params![thread_id,run_id],|r|r.get(0)).optional()?;
        let mut run: Value=raw.as_deref().map(serde_json::from_str).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?.unwrap_or(Value::Null);
        let msg_raw: Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2 AND role='user'",params![thread_id,run["userMessageId"].as_str()],|r|r.get(0)).optional()?;
        let mut message: Value=msg_raw.as_deref().map(serde_json::from_str).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?.unwrap_or(Value::Null);
        let goal_error = if let QueueOp::Edit { text, attachments, .. } = &op {
            goal_guard(tx, thread_id, &run, &message, text, *attachments)?
        } else { None };
        let error = match &op {
            QueueOp::Edit{text,..} if text.trim().is_empty()=>Some(format!("Queued run {run_id} cannot be edited to an empty message.")),
            _ if raw.is_none()=>Some(format!("Run {run_id} is not queued.")),
            QueueOp::Edit{..} if msg_raw.is_none()=>Some(format!("Queued run {run_id} has no user message.")),
            QueueOp::Edit{..} if !message["delegatedCompletion"].is_null() || !message["notification"].is_null()=>Some("Automatic completion deliveries cannot be edited.".into()),
            QueueOp::Edit{..} if !message["context"]["guest"].is_null()=>Some("A guest's message cannot be edited. Cancel it instead.".into()),
            _=>goal_error,
        };
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:kind.into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery)}
        if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]))}
        let mut planned:Vec<(&str,Value)>=vec![];
        match op {
            QueueOp::Cancel=>{
                if let Some(parent)=message["delegatedCompletion"]["parentRunId"].as_str() { dispose_wake(tx,thread_id,parent,&message["delegatedCompletion"]["taskIds"],now,&mut planned)?; }
                run["status"]=json!("cancelled");run["queuePosition"]=Value::Null;run["completedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',payload_json=?2 WHERE run_id=?1",params![run_id,run.to_string()])?;
                let node=run["rootNodeId"].as_str().unwrap_or("").to_owned();let attempt=run["activeAttemptId"].as_str().unwrap_or("").to_owned();planned.push(("run.updated",run));
                let node_raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND node_id=?2",params![thread_id,node],|r|r.get(0)).optional()?;
                if node_raw.is_some(){cancel_related(tx,"orchestration_v2_projection_run_attempts","attempt_id",&attempt,"run-attempt.updated",now,&mut planned)?;cancel_related(tx,"orchestration_v2_projection_nodes","node_id",&node,"node.updated",now,&mut planned)?;}
                if let (Some(share),Some(guest))=(message["context"]["guest"]["shareId"].as_str(),message["context"]["guest"]["guestMessageId"].as_str()) {
                    let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|r.get(0)).optional()?;
                    if let Some(raw)=raw {let mut thread:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;let mut changed=false;if thread["guestShare"]["id"]==share {if let Some(messages)=thread["guestShare"]["messages"].as_array_mut(){for m in messages {if m["id"]==guest && m["status"]=="sent" {m["status"]=json!("dismissed");changed=true;}}}}
                        if changed {thread["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1",params![thread_id,now,thread.to_string()])?;planned.push(("thread.guest-share-updated",thread));}}
                }
            },
            QueueOp::Edit{text,attachments,context}=>{
                update_message(&mut message,text,attachments,context,now);let id=message["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                tx.execute("UPDATE orchestration_v2_projection_messages SET updated_at=?2,payload_json=?3 WHERE message_id=?1",params![id,now,message.to_string()])?;planned.push(("message.updated",message));
                let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_message' AND json_extract(payload_json,'$.messageId')=?2 ORDER BY ordinal LIMIT 1",params![thread_id,id],|r|r.get(0)).optional()?;
                if let Some(raw)=raw {let mut item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;update_message(&mut item,text,attachments,context,now);tx.execute("UPDATE orchestration_v2_projection_turn_items SET updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![item["id"].as_str(),now,item.to_string()])?;planned.push(("turn-item.updated",item));}
            }
        }
        let events:Vec<Event>=planned.into_iter().map(|(event_type,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:event_type.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;receipt.result_sequence=stored.last().ok_or(rusqlite::Error::InvalidQuery)?.sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},stored))
    })
}
fn update_message(
    v: &mut Value,
    text: &str,
    attachments: Option<&Value>,
    context: Option<&Value>,
    now: &str,
) {
    v["text"] = json!(text);
    if let Some(a) = attachments {
        v["attachments"] = a.clone();
    }
    if let Some(c) = context.filter(|c| !c.is_null()) {
        v["context"] = c.clone();
    }
    if let Some(c) = v.get_mut("context").and_then(Value::as_object_mut) {
        c.remove("guest");
    }
    v["updatedAt"] = json!(now);
}
fn cancel_related(
    tx: &Transaction<'_>,
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
        let mut v: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        v["status"] = json!("cancelled");
        v["completedAt"] = json!(now);
        tx.execute(
            &format!("UPDATE {table} SET status='cancelled',payload_json=?2 WHERE {key}=?1"),
            params![id, v.to_string()],
        )?;
        events.push((event, v));
    }
    Ok(())
}
fn dispose_wake(
    tx: &Transaction<'_>,
    thread: &str,
    parent: &str,
    wake: &Value,
    now: &str,
    events: &mut Vec<(&'static str, Value)>,
) -> rusqlite::Result<()> {
    let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![thread,parent],|r|r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let mut run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND run_id=?2 AND origin='app_owned' ORDER BY started_at,subagent_id")?;
    let tasks = stmt
        .query_map(params![thread, parent], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if run.get("delegatedCompletion").is_none() && tasks.is_empty() {
        return Ok(());
    }
    let tasks: Vec<Value> = tasks
        .iter()
        .map(|s| serde_json::from_str(s).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<Result<_, _>>()?;
    let is_final = |t: &Value| {
        matches!(
            t["completionDelivery"]["state"].as_str(),
            Some("acknowledged" | "delivered" | "disposed")
        )
    };
    let kept = |t: &Value| {
        run["delegatedCompletion"]["disposition"] == "open"
            && !is_final(t)
            && !wake.as_array().is_some_and(|a| a.contains(&t["id"]))
    };
    let has_kept = tasks.iter().any(kept);
    if !has_kept {
        let generation = run["delegatedCompletion"]["nextGeneration"]
            .as_i64()
            .unwrap_or(1);
        run["delegatedCompletion"] =
            json!({"disposition":"disposed","nextGeneration":generation,"delivery":null});
    }
    tx.execute(
        "UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",
        params![parent, run.to_string()],
    )?;
    events.push(("run.updated", run.clone()));
    for mut task in tasks {
        if is_final(&task)
            || (has_kept && !wake.as_array().is_some_and(|a| a.contains(&task["id"])))
        {
            continue;
        }
        task["completionDelivery"] = json!({"state":"disposed","observedByRunId":null});
        task["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_subagents SET completion_delivery_state='disposed',updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![task["id"].as_str(),now,task.to_string()])?;
        events.push(("subagent.updated", task));
    }
    Ok(())
}

pub(crate) fn goal_guard(
    tx: &Transaction<'_>,
    thread: &str,
    run: &Value,
    message: &Value,
    text: &str,
    attachments: Option<&Value>,
) -> rusqlite::Result<Option<String>> {
    let attachments = attachments.unwrap_or(&message["attachments"]);
    if attachments.as_array().is_some_and(|a| !a.is_empty()) {
        return Ok(None);
    }
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("/goal") else {
        return Ok(None);
    };
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return Ok(None);
    }
    let arg = rest.trim().to_ascii_lowercase();
    if !matches!(arg.as_str(), "" | "edit" | "clear" | "pause" | "resume") {
        return Ok(None);
    }
    let follows = message["followsThreadSelection"] == true;
    let selected: Option<String> = if follows {
        tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.instanceId') FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread],|r|r.get(0)).optional()?.flatten()
    } else {
        run["modelSelection"]["instanceId"]
            .as_str()
            .or_else(|| run["providerInstanceId"].as_str())
            .map(str::to_owned)
    };
    let driver:Option<String>=tx.query_row("SELECT provider FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_instance_id=?2 ORDER BY updated_at DESC LIMIT 1",params![thread,selected],|r|r.get(0)).optional()?;
    Ok(match driver.as_deref(){Some("claudeAgent") if arg=="pause" || arg=="resume"=>Some("Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.".into()),Some("antigravity")=>Some("Antigravity accepts /goal followed by an objective. Interrupt the running turn, then ask Antigravity to stop the current goal.".into()),_=>None})
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> EventBus {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let message = json!({"id":"m","role":"user","text":"old","attachments":[{"id":"a"}],"context":{"x":1}});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'now','now',?1)",[message.to_string()]).unwrap();
        let run = json!({"id":"r","status":"queued","userMessageId":"m","queuePosition":1});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','queued','now',?1)",[run.to_string()]).unwrap();
        EventBus::new(db, 16)
    }
    #[test]
    fn edit_preserves_attachments_strips_guest_and_replays_rejection() {
        let bus = fixture();
        let now = "2026-01-01T00:00:00Z";
        let bad = dispatch(
            &bus,
            "bad",
            "t",
            "r",
            QueueOp::Edit {
                text: "  ",
                attachments: None,
                context: None,
            },
            now,
        )
        .unwrap();
        assert_eq!(
            bad.receipt.error.as_deref(),
            Some("Queued run r cannot be edited to an empty message.")
        );
        let context = json!({"guest":{"shareId":"fake"},"x":2});
        let result = dispatch(
            &bus,
            "edit",
            "t",
            "r",
            QueueOp::Edit {
                text: "new",
                attachments: None,
                context: Some(&context),
            },
            now,
        )
        .unwrap();
        assert!(result.committed);
        assert!(
            !dispatch(&bus, "edit", "t", "r", QueueOp::Cancel, now)
                .unwrap()
                .committed
        );
        bus.commit(|tx|{let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='m'",[],|r|r.get(0))?;let m:Value=serde_json::from_str(&raw).unwrap();assert_eq!(m["text"],"new");assert_eq!(m["attachments"][0]["id"],"a");assert!(m["context"].get("guest").is_none());Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn cancel_rejects_subsequent_edit_and_clears_queue_position() {
        let bus = fixture();
        let now = "2026-01-01T00:00:00Z";
        assert!(
            dispatch(&bus, "cancel", "t", "r", QueueOp::Cancel, now)
                .unwrap()
                .committed
        );
        let edit = dispatch(
            &bus,
            "edit",
            "t",
            "r",
            QueueOp::Edit {
                text: "new",
                attachments: None,
                context: None,
            },
            now,
        )
        .unwrap();
        assert_eq!(edit.receipt.error.as_deref(), Some("Run r is not queued."));
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='r'",
                [],
                |r| r.get(0),
            )?;
            let r: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(r["status"], "cancelled");
            assert!(r["queuePosition"].is_null());
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
