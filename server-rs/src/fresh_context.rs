//! Fresh-context session selection and durable detachment helpers.
use crate::{
    outbox::{self, Effect},
    provider::session_registry::SessionRegistry,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub const TRANSFER_ERROR: &str =
    "A fresh session can't start while a fork or merge is still being applied.";
pub const BACKGROUND_ERROR: &str = "The current session is still running background agents or commands, and a fresh session would end them. Wait for them to finish, or press Stop, then send the message again.";

/// Decide detachment before any dispatch writes. `queued` leaves a busy session
/// alive, as a queued fresh run starts in a separate provider thread.
pub fn plan(
    tx: &Transaction<'_>,
    thread_id: &str,
    sessions: Option<&SessionRegistry>,
    queued: bool,
) -> rusqlite::Result<Result<Vec<String>, &'static str>> {
    if !queued {
        let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type IN ('fork','merge_back') AND status='pending')",[thread_id],|r|r.get(0))?;
        if pending {
            return Ok(Err(TRANSFER_ERROR));
        }
    }
    let raw:Option<String>=tx.query_row("SELECT s.payload_json FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=json_extract(t.payload_json,'$.activeProviderThreadId') JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id WHERE t.thread_id=?1 AND s.status NOT IN ('stopped','error')",[thread_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else {
        return Ok(Ok(vec![]));
    };
    let session: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if session["capabilities"]["sessions"]["supportsMultipleProviderThreadsPerSession"] == true {
        return Ok(Ok(vec![]));
    }
    let Some(id) = session["id"].as_str() else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    let Some(registry) = sessions else {
        if !queued {
            return Ok(Err(BACKGROUND_ERROR));
        }
        let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0)",[id],|r|r.get(0))?;
        return if busy {
            Ok(Ok(vec![]))
        } else {
            Ok(Ok(vec![id.to_owned()]))
        };
    };
    let live = registry
        .get(id)
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .is_some();
    let busy = if live {
        registry.has_pending_background_work(id).unwrap_or(true) || tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0)",[id],|r|r.get::<_,bool>(0))?
    } else {
        false
    };
    if busy {
        return if queued {
            Ok(Ok(vec![]))
        } else {
            Ok(Err(BACKGROUND_ERROR))
        };
    }
    Ok(Ok(vec![id.to_owned()]))
}

/// Append detachment before the new start effect. Caller appends returned events.
pub fn detach(
    tx: &Transaction<'_>,
    thread_id: &str,
    command_id: &str,
    ids: &[String],
    replacement_session: Option<&str>,
    now: &str,
) -> rusqlite::Result<Vec<Value>> {
    let mut events = Vec::new();
    for id in ids {
        if Some(id.as_str()) == replacement_session {
            continue;
        }
        tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![thread_id,id])?;
        events.push(
            json!({"providerSessionId":id,"detachedAt":now,"reason":"Started a fresh session."}),
        );
        outbox::enqueue(
            tx,
            &Effect {
                id: format!("effect:{command_id}:provider-session.detach:{id}"),
                command_id: command_id.into(),
                thread_id: thread_id.into(),
                request: json!({"type":"provider-session.detach","providerSessionId":id,"detail":"Started a fresh session."}),
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
    Ok(events)
}

/// Queue a conditional cleanup; the executor checks live work and emits the
/// detach event only if the old session is safe to release.
pub fn defer_detach(
    tx: &Transaction<'_>,
    thread_id: &str,
    command_id: &str,
    ids: &[String],
    replacement: Option<&str>,
    now: &str,
) -> rusqlite::Result<()> {
    for id in ids {
        if Some(id.as_str()) == replacement {
            continue;
        }
        outbox::enqueue(
            tx,
            &Effect {
                id: format!("effect:{command_id}:provider-session.detach:{id}"),
                command_id: command_id.into(),
                thread_id: thread_id.into(),
                request: json!({"type":"provider-session.detach","providerSessionId":id,"detail":"Started a fresh session.","onlyIfIdle":true}),
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

/// A single-native-thread provider cannot reuse its old process for fresh work.
pub fn needs_new_session(
    tx: &Transaction<'_>,
    thread_id: &str,
    candidate: &str,
) -> rusqlite::Result<bool> {
    tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=json_extract(t.payload_json,'$.activeProviderThreadId') JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id WHERE t.thread_id=?1 AND s.provider_session_id=?2 AND s.status NOT IN ('stopped','error') AND COALESCE(json_extract(s.payload_json,'$.capabilities.sessions.supportsMultipleProviderThreadsPerSession'),0)=0)",params![thread_id,candidate],|r|r.get(0))
}

/// Execute the queued cleanup only when the old process is provably idle. A
/// busy process is retained and the fresh run may start in its own session.
pub fn execute_idle_detach(
    bus: &crate::event_bus::EventBus,
    registry: &SessionRegistry,
    effect: &Effect,
    now: &str,
) -> Result<(), String> {
    use crate::{
        event_store::{self, Event},
        provider::session_registry::IdleRemoval,
    };
    let id = effect.request["providerSessionId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("Missing providerSessionId")?;
    bus.commit(|tx| {
        let in_use:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_runs r ON r.provider_thread_id=p.provider_thread_id WHERE p.provider_session_id=?1 AND r.status IN ('preparing','starting','running','waiting')) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_session_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1 AND thread_id!=?2)",params![id,effect.thread_id],|r|r.get(0))?;
        if in_use {return Ok(((),vec![]));}
        match registry.begin_remove_if_idle(id).map_err(|_|rusqlite::Error::InvalidQuery)? { IdleRemoval::Busy => return Ok(((),vec![])), IdleRemoval::Absent|IdleRemoval::Removed(_) => {} }
        tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![effect.thread_id,id])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:effect.thread_id.clone(),event_type:"provider-session.detached".into(),occurred_at:now.into(),command_id:Some(effect.command_id.clone()),causation_event_id:None,correlation_id:Some(effect.command_id.clone()),actor_kind:"system".into(),payload:json!({"providerSessionId":id,"detachedAt":now,"reason":"Started a fresh session."}),metadata:json!({})};
        Ok(((),event_store::append(tx,&[event])?))
    }).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        event_bus::EventBus,
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn queued_cleanup_preserves_active_session_and_detaches_when_idle() {
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
            "event",
            "old",
        )
        .unwrap();
        bus.commit(|tx| {tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES('pt','t','codex','old-session','active','old',?1)",[json!({"id":"pt","threadId":"t","providerSessionId":"old-session","status":"active","pendingBackgroundTasks":[]}).to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES('old-session','t')",[])?;tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','pt','running','old',?1)",[json!({"id":"r","threadId":"t","status":"running"}).to_string()])?;Ok(((),vec![]))}).unwrap();
        let effect = Effect {
            id: "detach".into(),
            command_id: "cmd".into(),
            thread_id: "t".into(),
            request: json!({"type":"provider-session.detach","providerSessionId":"old-session","onlyIfIdle":true}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: "old".into(),
            lease_owner: None,
            created_at: "old".into(),
            updated_at: "old".into(),
            completed_at: None,
            last_error: None,
        };
        let registry = SessionRegistry::default();
        execute_idle_detach(&bus, &registry, &effect, "now").unwrap();
        bus.commit(|tx| {let bound:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='old-session')",[],|r|r.get(0))?;assert!(bound);tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='r'",[])?;Ok(((),vec![]))}).unwrap();
        execute_idle_detach(&bus, &registry, &effect, "later").unwrap();
        bus.commit(|tx| {let bound:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='old-session')",[],|r|r.get(0))?;assert!(!bound);Ok(((),vec![]))}).unwrap();
    }
}
