//! Completion of title regeneration requests through the public command path.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn valid(input: &Value) -> bool {
    if input
        .get("requestId")
        .and_then(Value::as_str)
        .is_none_or(|s| s.trim().is_empty())
    {
        return false;
    }
    if input
        .get("title")
        .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return false;
    }
    if let Some(outcome) = input.get("outcome") {
        if !outcome.is_object()
            || !outcome
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|s| ["renamed", "unchanged", "failed"].contains(&s))
            || outcome.get("message").is_some_and(|v| !v.is_string())
        {
            return false;
        }
    }
    true
}
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    input: &Value,
    now: &str,
) -> Result<CommitResult, BusError> {
    bus.commit(|tx|{
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {return Ok((CommitResult{receipt,committed:false},vec![]));}
        let row:Option<(String,Option<String>)>=tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let error=match &row {None=>Some(format!("Thread {thread_id} does not exist.")),Some((_,Some(_)))=>Some(format!("Thread {thread_id} is deleted.")),_=>None};
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"thread.title.regeneration.complete".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery);}
        if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]));}
        let mut thread:Value=serde_json::from_str(&row.unwrap().0).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if thread["titleRegeneration"]["requestId"]==input["requestId"] {
            if let Some(title)=input["title"].as_str() {thread["title"]=json!(title.trim());}
            if let Some(outcome)=input.get("outcome") { let mut result=json!({"status":outcome["status"],"requestId":input["requestId"],"completedAt":now});if let Some(message)=outcome.get("message"){result["message"]=message.clone();}thread["lastTitleRegeneration"]=result; }
            thread["titleRegeneration"]=Value::Null;thread["updatedAt"]=json!(now);
            tx.execute("UPDATE orchestration_v2_projection_threads SET title=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1",params![thread_id,thread["title"].as_str(),now,thread.to_string()])?;
        }
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"thread.metadata-updated".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload:thread,metadata:json!({})};
        let stored=event_store::append(tx,&[event])?;receipt.result_sequence=stored.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},stored))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_completion_emits_unchanged_and_current_completion_applies_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","title":"Original","updatedAt":"2026","titleRegeneration":{"requestId":"current","startedAt":"2026"}});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','Original','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let now = "2026-01-01T00:00:00.000Z";
        let stale = json!({"requestId":"old","title":"Wrong"});
        assert!(valid(&stale));
        assert!(dispatch(&bus, "c1", "t", &stale, now).unwrap().committed);
        let current = json!({"requestId":"current","title":" New ","outcome":{"status":"renamed"}});
        assert!(valid(&current));
        let first = dispatch(&bus, "c2", "t", &current, now).unwrap();
        assert!(first.committed);
        assert!(!dispatch(&bus, "c2", "t", &current, now).unwrap().committed);
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(thread["title"], "New");
            assert!(thread["titleRegeneration"].is_null());
            assert_eq!(thread["lastTitleRegeneration"]["requestId"], "current");
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
