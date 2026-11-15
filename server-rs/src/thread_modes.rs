//! Transactional thread mode changes and safe provider-session detachment.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const BACKGROUND_WORK_ERROR: &str = "The current session is still running background agents or commands, and this change would end them. Wait for them to finish, or press Stop, then try again.";

#[derive(Clone, Copy)]
pub enum Mode<'a> {
    Runtime(&'a str),
    Interaction(&'a str),
}

pub fn valid(mode: Mode<'_>) -> bool {
    match mode {
        Mode::Runtime(v) => matches!(
            v,
            "approval-required" | "auto-accept-edits" | "auto" | "full-access"
        ),
        Mode::Interaction(v) => matches!(v, "default" | "plan"),
    }
}

/// `background_work` returns whether a live session has work; an error is
/// conservatively treated as work. Missing runtime sessions may return Ok(false).
/// The caller must validate the mode and enforce any runtime-mode ceiling.
pub fn dispatch<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    mode: Mode<'_>,
    now: &str,
    background_work: F,
) -> Result<CommitResult, BusError>
where
    F: Fn(&str, &Value) -> Result<bool, ()>,
{
    let (kind, event_type, field, column, value) = match mode {
        Mode::Runtime(v) => (
            "thread.runtime-mode.set",
            "thread.runtime-mode-updated",
            "runtimeMode",
            "runtime_mode",
            v,
        ),
        Mode::Interaction(v) => (
            "thread.interaction-mode.set",
            "thread.interaction-mode-updated",
            "interactionMode",
            "interaction_mode",
            v,
        ),
    };
    bus.commit(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? { return Ok((CommitResult {receipt, committed:false}, vec![])); }
        let row: Option<(String,Option<String>)> = tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let mut error = match &row { None => Some(format!("Thread {thread_id} does not exist.")), Some((_,Some(_))) => Some(format!("Thread {thread_id} is deleted.")), _ => None };
        let mut sessions = Vec::new();
        if error.is_none() && matches!(mode, Mode::Runtime(_)) {
            let mut stmt = tx.prepare("SELECT s.provider_session_id,s.payload_json FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.status NOT IN ('stopped','error') ORDER BY s.updated_at,s.provider_session_id")?;
            let rows = stmt.query_map([thread_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            for (id, raw) in rows {
                let session: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                if session["capabilities"]["sessions"]["supportsRuntimeModeSwitchInSession"] != true {
                    if background_work(&id, &session).unwrap_or(true) { error = Some(BACKGROUND_WORK_ERROR.into()); break; }
                    sessions.push(id);
                }
            }
        }
        let mut receipt = Receipt { command_id:command_id.into(), aggregate_kind:"thread".into(), aggregate_id:thread_id.into(), command_type:kind.into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?, status:if error.is_some(){"rejected"}else{"accepted"}.into(), error };
        if !event_store::insert_receipt_if_absent(tx,&receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if receipt.error.is_some() { return Ok((CommitResult {receipt,committed:false},vec![])); }
        let mut thread: Value = serde_json::from_str(&row.unwrap().0).map_err(|_| rusqlite::Error::InvalidQuery)?;
        thread[field] = json!(value); thread["updatedAt"] = json!(now);
        tx.execute(&format!("UPDATE orchestration_v2_projection_threads SET {column}=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1"), params![thread_id,value,now,thread.to_string()])?;
        let mut planned = vec![(event_type,thread)];
        for id in sessions {
            tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![thread_id,id])?;
            let reason = "Runtime mode changed.";
            planned.push(("provider-session.detached",json!({"providerSessionId":id,"detachedAt":now,"reason":reason})));
            outbox::enqueue(tx,&Effect{id:format!("effect:{command_id}:provider-session.detach:{id}"),command_id:command_id.into(),thread_id:thread_id.into(),request:json!({"type":"provider-session.detach","providerSessionId":id,"detail":reason}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
        }
        let events:Vec<Event> = planned.into_iter().map(|(event_type,payload)| Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:event_type.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let stored = event_store::append(tx,&events)?; receipt.result_sequence = stored.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult {receipt,committed:true},stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> EventBus {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','a','a',?1)", [json!({"id":"t","runtimeMode":"full-access","interactionMode":"default"}).to_string()]).unwrap();
        for (id, switch) in [("detach", false), ("keep", true)] {
            db.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES(?1,'t','codex','ready','a',?2)",params![id,json!({"capabilities":{"sessions":{"supportsRuntimeModeSwitchInSession":switch}}}).to_string()]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings(thread_id,provider_session_id) VALUES('t',?1)",[id]).unwrap();
        }
        EventBus::new(db, 16)
    }
    #[test]
    fn modes_detach_only_unsupported_sessions_and_retry_is_idempotent() {
        let bus = setup();
        let now = "2026-01-01T00:00:00Z";
        assert!(
            dispatch(
                &bus,
                "i",
                "t",
                Mode::Interaction("plan"),
                now,
                |_, _| panic!("interaction must not probe")
            )
            .unwrap()
            .committed
        );
        assert!(
            dispatch(&bus, "r", "t", Mode::Runtime("auto"), now, |_, _| Ok(false))
                .unwrap()
                .committed
        );
        assert!(
            !dispatch(&bus, "r", "t", Mode::Runtime("auto"), now, |_, _| panic!(
                "receipt must be reused"
            ))
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let (runtime,interaction): (String,String)=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!((runtime.as_str(),interaction.as_str()),("auto","plan"));
            let ids:Vec<String>=tx.prepare("SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings ORDER BY provider_session_id")?.query_map([],|r|r.get(0))?.collect::<Result<_,_>>()?;
            assert_eq!(ids,vec!["keep"]);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn background_work_or_failed_probe_blocks_detach_atomically() {
        for probe in [Ok(true), Err(())] {
            let bus = setup();
            let result = dispatch(
                &bus,
                "r",
                "t",
                Mode::Runtime("auto"),
                "2026-01-01T00:00:00Z",
                |_, _| probe,
            )
            .unwrap();
            assert_eq!(result.receipt.error.as_deref(), Some(BACKGROUND_WORK_ERROR));
            bus.commit(|tx| {
                let mode:String=tx.query_row("SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?;
                let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_session_bindings",[],|r|r.get(0))?;
                assert_eq!(mode,"full-access"); assert_eq!(count,2); Ok(((),vec![]))
            }).unwrap();
        }
    }
}
