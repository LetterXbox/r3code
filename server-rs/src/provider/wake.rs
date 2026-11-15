//! Durable app-side runs for autonomous activity in an existing provider session.
use crate::{
    event_bus::EventBus,
    event_store,
    message_commands::{self, DispatchError, DispatchMessage},
    provider::codex_events::RootTurn,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type WakeProjection = (RootTurn, Value, Value, Option<String>);
type ThreadRow = (String, Option<String>, Option<String>, Option<String>);

pub(crate) fn create(
    bus: &EventBus,
    source: &RootTurn,
    wake_id: &str,
    detail: Option<&str>,
    notification: Option<Value>,
    at: &str,
) -> Result<Option<WakeProjection>, String> {
    let hash = Sha256::digest(format!("{}\0{}", source.provider_thread_id, wake_id).as_bytes());
    let key: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    let command_id = format!("provider-continuation:{key}");
    let message_id = format!("provider-message:{key}");
    let notice = notification.unwrap_or_else(|| json!({"source":{"kind":"background_task"},"outcome":"updated","summary":"Background activity updated"}));
    bus.commit_with(|tx| -> Result<_, DispatchError> {
        if event_store::get_receipt(tx, &command_id, "thread")?.is_some() { return Ok((None, vec![])); }
        let row: Option<ThreadRow> = tx.query_row("SELECT t.payload_json,t.archived_at,t.deleted_at,p.workspace_root FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL WHERE t.thread_id=?1", [&source.thread_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((raw, archived, deleted, project_root)) = row else { return Ok((None, vec![])); };
        let thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))", [&source.thread_id], |r|r.get(0))?;
        if archived.is_some() || deleted.is_some() || active || message_commands::encode_id_part(wake_id).is_empty() || crate::conversation_provider::select(tx, &source.thread_id)?.as_deref() != Some(&source.provider_thread_id) { return Ok((None, vec![])); }
        let provider_raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2", params![source.provider_thread_id,source.thread_id], |r|r.get(0)).optional()?;
        let Some(provider_raw) = provider_raw else {return Ok((None,vec![]));};
        let provider: Value = serde_json::from_str(&provider_raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if provider["providerInstanceId"] != thread["modelSelection"]["instanceId"] { return Ok((None,vec![])); }
        let cwd = thread["worktreePath"].as_str().map(str::to_owned).or(project_root);
        let cmd = DispatchMessage { context: None, command_id: &command_id, thread_id: &source.thread_id, message_id: &message_id, text: detail.unwrap_or("Background task completed."), attachments: &[], creation_source: "provider", cwd: cwd.as_deref().unwrap_or(""), driver: &source.driver };
        let (result, events) = message_commands::dispatch_provider_wake_tx(tx, cmd, at, &notice)?;
        if !result.committed || result.receipt.status != "accepted" { return Err(rusqlite::Error::InvalidQuery.into()); }
        let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND json_extract(payload_json,'$.userMessageId')=?2", params![source.thread_id,message_id], |r|r.get(0))?;
        let run: Value = serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if run["providerThreadId"] != source.provider_thread_id { return Err(rusqlite::Error::InvalidQuery.into()); }
        let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1", [&source.provider_thread_id], |r|r.get(0))?;
        let turn = RootTurn { driver: source.driver.clone(), native_thread_id: source.native_thread_id.clone(), native_turn_id: key.clone(), provider_thread_id: source.provider_thread_id.clone(), provider_turn_id: format!("provider-turn:provider:{}:synthetic:{key}", message_commands::encode_id_part(&source.driver)), thread_id: source.thread_id.clone(), run_id: run["id"].as_str().map(str::to_owned), run_attempt_id: run["activeAttemptId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.into(), root_node_id: run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.into(), provider_turn_ordinal: ordinal, run_ordinal: run["ordinal"].as_u64().ok_or(rusqlite::Error::InvalidQuery)?, started_at: at.into() };
        Ok((Some((turn,run,provider,cwd)),events))
    }).map_err(|e|format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread_commands::{create_thread_ordered, CreateThread};

    #[test]
    fn wake_waits_for_idle_then_commits_once_without_start_effect() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"claude","model":"test"});
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
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        message_commands::dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "first",
                thread_id: "t",
                message_id: "m",
                text: "hi",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "claudeAgent",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let (pt, run) = bus.commit(|tx| { let pt: String = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|r.get(0))?; let raw:String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|r.get(0))?; tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.activeProviderThreadId',?1) WHERE thread_id='t'",[&pt])?; Ok(((pt,serde_json::from_str::<Value>(&raw).unwrap()),vec![])) }).unwrap();
        let source = RootTurn {
            driver: "claudeAgent".into(),
            native_thread_id: "native".into(),
            native_turn_id: "old".into(),
            provider_thread_id: pt,
            provider_turn_id: "old".into(),
            thread_id: "t".into(),
            run_id: run["id"].as_str().map(str::to_owned),
            run_attempt_id: run["activeAttemptId"].as_str().unwrap().into(),
            root_node_id: run["rootNodeId"].as_str().unwrap().into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:01Z".into(),
        };
        assert!(
            create(&bus, &source, "wake", None, None, "2026-01-01T00:00:02Z")
                .unwrap()
                .is_none()
        );
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE thread_id='t'",[])?;Ok(((),vec![]))}).unwrap();
        let (_, wake_run, _, _) = create(&bus, &source, "wake", None, None, "2026-01-01T00:00:03Z")
            .unwrap()
            .unwrap();
        assert!(
            create(&bus, &source, "wake", None, None, "2026-01-01T00:00:04Z")
                .unwrap()
                .is_none()
        );
        bus.commit(|tx| {let (actor,source,kind):(String,String,String)=tx.query_row("SELECT json_extract(m.payload_json,'$.createdBy'),json_extract(m.payload_json,'$.creationSource'),i.type FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_turn_items i ON i.run_id=m.run_id WHERE m.run_id=?1",[wake_run["id"].as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?; assert_eq!((actor.as_str(),source.as_str(),kind.as_str()),("agent","provider","notification")); let n:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE command_id LIKE 'provider-continuation:%'",[],|r|r.get(0))?;assert_eq!(n,0);Ok(((),vec![]))}).unwrap();
    }
}
