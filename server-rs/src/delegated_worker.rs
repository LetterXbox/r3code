//! Recover and dispatch durable delegated-completion wake reservations.
use crate::{
    delegated_ack, delegated_continuation,
    event_bus::{BusError, EventBus},
    message_commands,
    settings::Settings,
};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::sync::Arc;

/// Scan durable cohorts and attempt currently valid wake messages once.
pub fn drain(bus: &EventBus) -> Result<usize, BusError> {
    drain_with_settings(bus, &serde_json::json!({}))
}

/// Scan using the latest settings snapshot to dispose wakes for disabled providers.
pub fn drain_with_settings(bus: &EventBus, settings: &Value) -> Result<usize, BusError> {
    drain_with_sessions(bus, settings, |_| false)
}

pub fn drain_with_sessions(
    bus: &EventBus,
    settings: &Value,
    can_steer: impl Fn(&str) -> bool,
) -> Result<usize, BusError> {
    // Child task rows are durable, so recovery can also finish results that
    // arrived while the process was stopped.
    let pending_children = bus.commit(|tx| {
        let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents s JOIN orchestration_v2_projection_runs r ON r.thread_id=s.child_thread_id WHERE s.origin='app_owned' AND (json_extract(s.payload_json,'$.result') IS NULL OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers x WHERE x.source_thread_id=s.child_thread_id AND x.target_thread_id=s.thread_id AND x.type='subagent_result')) AND r.status IN ('completed','failed','cancelled','interrupted','rolled_back'))",[],|r|r.get(0))?;
        Ok((pending,vec![]))
    })?;
    if pending_children {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        crate::delegated_result::recover(bus, &now)?;
    }
    // Cleanup can be interrupted after result publication, so retry it on
    // restart and whenever child sessions or message questions remain.
    let needs_cleanup = bus.commit(|tx| {
        let pending:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads c WHERE json_extract(c.payload_json,'$.lineage.relationshipToParent')='subagent' AND c.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b WHERE b.thread_id=c.thread_id) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=c.thread_id AND r.status='pending' AND r.kind='user_input' AND json_extract(r.payload_json,'$.responseCapability.type')='message'))) ", [], |r|r.get(0))?;
        Ok((pending,vec![]))
    })?;
    if needs_cleanup {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        crate::delegated_cleanup::cleanup_pending(bus, &now)?;
    }
    // Recover terminal wake runs before offering any successor reservations.
    let finished = bus.commit(|tx| {
        let mut stmt = tx.prepare("SELECT r.thread_id, r.run_id, r.status, json_extract(r.payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_runs p ON p.thread_id = r.thread_id AND json_extract(p.payload_json, '$.delegatedCompletion.delivery.messageId') = json_extract(r.payload_json, '$.userMessageId') WHERE r.status IN ('completed','failed','cancelled','interrupted','rolled_back')")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, vec![]))
    })?;
    for (thread, run, status, message) in finished {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        crate::delegated_settlement::finalize(
            bus,
            &thread,
            &message,
            status == "cancelled",
            &format!("command:system:delegated-completion-recovery:{run}"),
            &now,
        )?;
    }
    let offers = bus.commit(|tx| {
        let mut stmt=tx.prepare("SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE json_type(payload_json,'$.delegatedCompletion.delivery')='object' ORDER BY thread_id")?;
        let ids=stmt.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut offers=Vec::new();
        for id in ids {
            let cwd:Option<String>=tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[&id],|r|r.get(0)).optional()?;
            if let Some(cwd)=cwd { for offer in delegated_continuation::offers(tx,&id)? { offers.push((offer,cwd.clone())); } }
        }
        Ok((offers,vec![]))
    })?;
    let mut dispatched = 0;
    for (offer, cwd) in offers {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let disabled = bus.commit(|tx| {
            let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&offer.thread_id], |r| r.get(0)).optional()?;
            let Some(thread) = raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()) else { return Ok((None, vec![])); };
            let project = thread["projectId"].as_str().unwrap_or("");
            let instance = thread["modelSelection"]["instanceId"].as_str().or_else(|| thread["providerInstanceId"].as_str()).unwrap_or(&offer.driver);
            let enabled = settings["projectSettingsOverrides"][project]["providerInstances"][instance]["enabled"].as_bool()
                .or_else(|| settings["providerInstances"][instance]["enabled"].as_bool()).unwrap_or(true);
            let delivery = if enabled { None } else { delegated_continuation::current_delivery(tx, &offer.thread_id, &offer.delegated_completion)? };
            Ok((delivery, vec![]))
        })?;
        if let Some(delivery) = disabled {
            for task in delivery["taskIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let command = format!(
                    "command:fixture:delegated-completion:dispose-disabled:{}",
                    uuid::Uuid::new_v4()
                );
                let result = delegated_ack::dispose(bus, &command, &offer.thread_id, task, &now)?;
                if result.receipt.status != "accepted" {
                    eprintln!(
                        "Unable to dispose delegated completion for {}: {}",
                        offer.thread_id,
                        result
                            .receipt
                            .error
                            .unwrap_or_else(|| "command rejected".into())
                    );
                    break;
                }
            }
            continue;
        }
        match message_commands::dispatch_delegated_completion_with_session(
            bus, &offer, &cwd, &now, &can_steer,
        ) {
            Ok(Some(result)) if result.receipt.status == "accepted" => dispatched += 1,
            Ok(Some(result)) => eprintln!(
                "Unable to dispatch delegated completion for {}: {}",
                offer.thread_id,
                result
                    .receipt
                    .error
                    .unwrap_or_else(|| "command rejected".into())
            ),
            Ok(None) => {}
            Err(error) => eprintln!(
                "Unable to dispatch delegated completion for {}: {error}",
                offer.thread_id
            ),
        }
    }
    Ok(dispatched)
}

/// Reservations remain durable, so a failed or interrupted pass can be retried.
pub async fn run(
    bus: EventBus,
    settings: Arc<Settings>,
    sessions: Arc<crate::provider::session_registry::SessionRegistry>,
) {
    // Subscribe before the first recovery pass so a completion committed during
    // startup cannot be missed. The timer also retries transient failures.
    let mut events = match bus.subscribe_application() {
        Ok((_, events)) => events,
        Err(error) => {
            eprintln!("Delegated completion subscription failed: {error}");
            return;
        }
    };
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = interval.tick() => {},
            event = events.recv() => match event {
                Ok(event) if matches!(event.event.event_type.as_str(), "run.updated" | "run.created" | "subagent.updated" | "provider-thread.updated" | "context-transfer.created" | "context-transfer.updated") => {},
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        if let Err(error) = drain_with_sessions(&bus, &settings.snapshot(), |session| {
            sessions.get(session).ok().flatten().is_some()
        }) {
            eprintln!("Delegated completion recovery failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn recovery_dispatches_reservation_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let thread = json!({"id":"t","projectId":"p","title":"T","providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","createdAt":"now","updatedAt":"now"});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)",[thread.to_string()]).unwrap();
        let parent = json!({"id":"parent","status":"completed","providerThreadId":"pt","delegatedCompletion":{"disposition":"open","delivery":{"generation":1,"messageId":"wake","taskIds":["task"]}}});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex','completed','now',?1)",[parent.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','now',?1)",[json!({"id":"pt","driver":"codex"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        assert_eq!(drain(&bus).unwrap(), 1);
        assert_eq!(drain(&bus).unwrap(), 0);
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed', payload_json=json_set(payload_json,'$.status','completed') WHERE json_extract(payload_json,'$.userMessageId')='wake'", [])?;
            Ok(((), vec![]))
        }).unwrap();
        assert_eq!(drain(&bus).unwrap(), 0);
        bus.commit(|tx| {
            let parent: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='parent'",
                [],
                |r| r.get(0),
            )?;
            assert!(
                serde_json::from_str::<Value>(&parent).unwrap()["delegatedCompletion"]["delivery"]
                    .is_null()
            );
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE message_id='wake'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn disabled_provider_disposes_each_reserved_task_without_dispatch() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let thread = json!({"id":"t","projectId":"p","providerInstanceId":"codex","modelSelection":{"instanceId":"codex"}});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)", [thread.to_string()]).unwrap();
        let parent = json!({"id":"parent","status":"completed","providerThreadId":"pt","delegatedCompletion":{"disposition":"open","delivery":{"generation":1,"messageId":"wake","taskIds":["a","b"]}}});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex','completed','now',?1)", [parent.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','now',?1)", [json!({"id":"pt","driver":"codex"}).to_string()]).unwrap();
        for id in ["a", "b"] {
            let task = json!({"id":id,"runId":"parent","origin":"app_owned","status":"completed","completionDelivery":{"state":"claimed"}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json,completion_delivery_state) VALUES(?1,'t','parent','n','codex','app_owned','completed','old',?2,'claimed')", rusqlite::params![id,task.to_string()]).unwrap();
        }
        let bus = EventBus::new(db, 16);
        let settings = json!({"providerInstances":{"codex":{"enabled":true}},"projectSettingsOverrides":{"p":{"providerInstances":{"codex":{"enabled":false}}}}});
        assert_eq!(drain_with_settings(&bus, &settings).unwrap(), 0);
        assert_eq!(drain_with_settings(&bus, &settings).unwrap(), 0);
        bus.commit(|tx| {
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE completion_delivery_state='disposed'", [], |r| r.get(0))?;
            assert_eq!(count, 2);
            let parent: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='parent'", [], |r| r.get(0))?;
            assert!(serde_json::from_str::<Value>(&parent).unwrap()["delegatedCompletion"]["delivery"].is_null());
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_messages", [], |r| r.get(0))?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        }).unwrap();
    }
}
