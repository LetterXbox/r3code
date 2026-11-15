//! Provider-neutral root-turn start projection.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    provider::{
        codex_events::{NormalizedEvent, RootTurn, TurnStatus},
        ingest,
    },
};
use rusqlite::params;
use serde_json::{json, Value};

pub(crate) fn start(
    bus: &EventBus,
    turn: &RootTurn,
    provider_thread: Value,
    run: &Value,
    cwd: Option<&str>,
    capabilities: Value,
) -> Result<(), String> {
    start_inner(bus, turn, provider_thread, run, cwd, capabilities, None)
}

pub(crate) fn start_with_fork(
    bus: &EventBus,
    turn: &RootTurn,
    provider_thread: Value,
    run: &Value,
    cwd: Option<&str>,
    capabilities: Value,
    transfer: &Value,
) -> Result<(), String> {
    start_inner(
        bus,
        turn,
        provider_thread,
        run,
        cwd,
        capabilities,
        Some(transfer),
    )
}

fn start_inner(
    bus: &EventBus,
    turn: &RootTurn,
    mut provider_thread: Value,
    run: &Value,
    cwd: Option<&str>,
    capabilities: Value,
    transfer: Option<&Value>,
) -> Result<(), String> {
    let id = provider_thread["providerSessionId"]
        .as_str()
        .ok_or("Missing provider session")?
        .to_owned();
    let instance = provider_thread["providerInstanceId"]
        .as_str()
        .ok_or("Missing provider instance")?
        .to_owned();
    let run_id = turn.run_id.as_ref().ok_or("Missing run")?;
    let at = &turn.started_at;
    provider_thread["nativeThreadRef"] =
        json!({"driver":turn.driver,"nativeId":turn.native_thread_id,"strength":"strong"});
    provider_thread["status"] = json!("active");
    provider_thread["updatedAt"] = json!(at);
    bus.commit(|tx| {
        tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='active',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![turn.provider_thread_id,at,provider_thread.to_string()])?;
        let session=json!({"id":id,"providerInstanceId":instance,"driver":turn.driver,"status":"ready","model":run["modelSelection"]["model"],"cwd":cwd,"capabilities":capabilities,"extensionStatuses":[],"lastError":null,"createdAt":at,"updatedAt":at});
        tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,model,updated_at,payload_json) VALUES(?1,?2,?3,'ready',?4,?5,?6) ON CONFLICT(provider_session_id) DO NOTHING",params![id,turn.thread_id,turn.driver,run["modelSelection"]["model"].as_str(),at,session.to_string()])?;
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?1",[&id],|r|r.get(0))?;
        let mut session:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        // OpenCode has already established a new event stream before this turn
        // is admitted. Recover the existing session after a transport failure.
        if turn.driver=="opencode" && session["status"]=="error" {
            session["status"]=json!("ready");session["lastError"]=Value::Null;session["updatedAt"]=json!(at);
            tx.execute("UPDATE orchestration_v2_projection_provider_sessions SET status='ready',updated_at=?2,payload_json=?3 WHERE provider_session_id=?1 AND status='error'",params![id,at,session.to_string()])?;
        }
        let attached=tx.execute("INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES(?1,?2)",params![id,turn.thread_id])?;
        let mut payloads=Vec::new();
        if let Some(transfer)=transfer {
            let transfer_id=transfer["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id=?1 AND target_thread_id=?2 AND status='pending'",params![transfer_id,turn.thread_id],|row|row.get(0))?;
            let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
            if value["sourceThreadId"]!=transfer["sourceThreadId"] || value["sourceProviderInstanceId"]!=transfer["sourceProviderInstanceId"] || value["sourcePoint"]!=transfer["sourcePoint"] {return Err(rusqlite::Error::InvalidQuery);}
            let source=value["sourceThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let source_pt=provider_thread["forkedFrom"]["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let raw_pt:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",params![source_pt,source],|row|row.get(0))?;
            let actual:Value=serde_json::from_str(&raw_pt).map_err(|_|rusqlite::Error::InvalidQuery)?;
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))",[source],|row|row.get(0))?;
            if active || actual["driver"]!=turn.driver || actual["providerInstanceId"]!=instance || actual["nativeThreadRef"]!=value["sourcePoint"]["providerThreadRef"] {return Err(rusqlite::Error::InvalidQuery);}
            value["targetRunId"]=json!(run_id);value["targetProviderInstanceId"]=json!(instance);value["status"]=json!("consumed");value["resolution"]=json!({"strategy":"native_fork","providerThreadRef":{"driver":turn.driver,"nativeId":turn.native_thread_id,"strength":"strong"}});value["error"]=Value::Null;value["updatedAt"]=json!(at);value["consumedAt"]=json!(at);
            tx.execute("UPDATE orchestration_v2_projection_context_transfers SET target_run_id=?2,target_provider=?3,target_provider_instance_id=?3,status='consumed',updated_at=?4,payload_json=?5 WHERE context_transfer_id=?1",params![transfer_id,run_id,instance,at,value.to_string()])?;
            payloads.push(("context-transfer.updated",value));
        }
        if attached==1 {payloads.push(("provider-session.attached",session.clone()));} payloads.push(("provider-session.updated",session)); payloads.push(("provider-thread.updated",provider_thread));
        for (select, update, id, kind) in [
            ("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1", "UPDATE orchestration_v2_projection_runs SET status='running',payload_json=?3 WHERE run_id=?1 AND status='starting'", run_id.as_str(), "run.updated"),
            ("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1", "UPDATE orchestration_v2_projection_run_attempts SET status='running',payload_json=?3 WHERE attempt_id=?1", turn.run_attempt_id.as_str(), "run-attempt.updated"),
            ("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", "UPDATE orchestration_v2_projection_nodes SET status='running',started_at=?2,payload_json=?3 WHERE node_id=?1", turn.root_node_id.as_str(), "node.updated"),
        ] { let raw:String=tx.query_row(select,[id],|r|r.get(0))?; let mut payload:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; payload["status"]=json!("running"); payload["startedAt"]=json!(at); if kind=="run-attempt.updated" {payload["nativeThreadId"]=json!(turn.native_thread_id);}
            if tx.execute(update,params![id,at,payload.to_string()])? != 1 {return Err(rusqlite::Error::InvalidQuery)} payloads.push((kind,payload)); }
        let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({})}).collect();
        Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())?;
    ingest::ingest(
        bus,
        &[NormalizedEvent::ProviderTurnUpdated {
            turn: turn.clone(),
            status: TurnStatus::Running,
            completed_at: None,
        }],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn superseded_prestart_rolls_back_provider_binding() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let selection = json!({"instanceId":"opencode","model":"fixture/model"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-lifecycle",
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
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t-lifecycle",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "opencode",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let (run,pt)=bus.commit(|tx| {
            let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id='t-lifecycle'",[],|row|row.get(0))?;let run:Value=serde_json::from_str(&raw).unwrap();
            let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|row|row.get(0))?;let pt:Value=serde_json::from_str(&raw).unwrap();
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',payload_json=json_set(payload_json,'$.status','cancelled') WHERE thread_id='t-lifecycle'",[])?;
            Ok(((run,pt),vec![]))
        }).unwrap();
        let turn = RootTurn {
            driver: "opencode".into(),
            native_thread_id: "native".into(),
            native_turn_id: "message".into(),
            provider_thread_id: run["providerThreadId"].as_str().unwrap().into(),
            provider_turn_id: "turn".into(),
            thread_id: "t-lifecycle".into(),
            run_id: Some(run["id"].as_str().unwrap().into()),
            run_attempt_id: run["activeAttemptId"].as_str().unwrap().into(),
            root_node_id: run["rootNodeId"].as_str().unwrap().into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:02Z".into(),
        };
        assert!(pt["providerSessionId"].as_str().is_some());
        assert!(start(&bus, &turn, pt, &run, Some("/tmp"), json!({})).is_err());
        bus.commit(|tx| {let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_provider_sessions WHERE thread_id='t-lifecycle'",[],|row|row.get(0))?;assert_eq!(count,0);let native:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[&turn.provider_thread_id],|row|row.get(0))?;assert!(native.is_none());Ok(((),vec![]))}).unwrap();
    }
}
