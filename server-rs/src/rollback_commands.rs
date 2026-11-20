//! Transactional checkpoint rollback admission.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event, Receipt},
    message_commands::DispatchError,
    outbox::{self, Effect},
    thread_commands::CommitResult,
    workspace_safety,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::path::Path;

fn load(tx: &Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx.query_row(sql, [id], |r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

pub struct RollbackCommand<'a> {
    pub command_id: &'a str,
    pub thread_id: &'a str,
    pub checkpoint_id: &'a str,
    pub scope_id: &'a str,
    pub restore_files: Option<bool>,
}

pub(crate) fn in_progress(tx: &rusqlite::Transaction<'_>, thread_id: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox
         WHERE thread_id=?1 AND effect_type='provider-thread.rollback' AND status IN ('pending','running'))",
        [thread_id],
        |row| row.get(0),
    )
}

pub fn admit(
    bus: &EventBus,
    cmd: RollbackCommand<'_>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, cmd.command_id, "thread")? {
            if receipt.aggregate_id != cmd.thread_id { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let mut thread = load(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", cmd.thread_id)?;
        let provider_id = thread.as_ref().and_then(|v| v["activeProviderThreadId"].as_str()).map(str::to_owned);
        let provider = match provider_id.as_deref() { Some(id) => load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",id)?, None => None };
        let checkpoint = load(tx,"SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id=?1",cmd.checkpoint_id)?;
        let scope = load(tx,"SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id=?1",cmd.scope_id)?;
        let mut error = None;
        if in_progress(tx, cmd.thread_id)? { error = Some("A rewind is already in progress for this thread.".into()); }
        else if provider_id.is_none() || provider.is_none() { error = Some("No active provider thread exists for rollback.".to_owned()); }
        else if provider.as_ref().is_some_and(|p| p["providerSessionId"].as_str().is_none()) { error = Some(format!("Provider thread {} has no provider session.", provider_id.as_deref().unwrap())); }
        else if provider.as_ref().is_some_and(|p| !matches!(p["driver"].as_str(),Some("codex"|"opencode"|"cursor"))) { error = Some("Provider does not support rollback.".to_owned()); }
        else if checkpoint.is_none() || checkpoint.as_ref().unwrap()["threadId"] != cmd.thread_id { error = Some(format!("Checkpoint {} was not found.",cmd.checkpoint_id)); }
        else {
            let checkpoint = checkpoint.as_ref().unwrap();
            let status = checkpoint["status"].as_str().unwrap_or("");
            if status != "ready" && !(cmd.restore_files == Some(false) && status == "missing") { error = Some(format!("Checkpoint {} is {} and cannot be restored.",cmd.checkpoint_id,status)); }
            else if scope.is_none() || scope.as_ref().unwrap()["threadId"] != cmd.thread_id { error = Some(format!("Checkpoint scope {} was not found.",cmd.scope_id)); }
            else if checkpoint["scopeId"] != cmd.scope_id { error = Some(format!("Checkpoint {} belongs to scope {}, not {}.", cmd.checkpoint_id,checkpoint["scopeId"].as_str().unwrap_or(""),cmd.scope_id)); }
            else if cmd.restore_files != Some(false) {
                let worktree = thread.as_ref().and_then(|v| v["worktreePath"].as_str()).map(Path::new);
                let cwd = scope.as_ref().and_then(|v| v["cwd"].as_str()).map(Path::new);
                if cwd.is_none() || !workspace_safety::restore_isolated_in_snapshot(tx,cmd.thread_id,worktree,cwd.unwrap())? { error = Some(workspace_safety::SHARED_WORKSPACE_RESTORE_MESSAGE.into()); }
            }
            if error.is_none() {
                let ordinal = checkpoint["appRunOrdinal"].as_i64().unwrap_or(0);
                if ordinal > 0 {
                    let run: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal=?2 AND status!='rolled_back'",params![cmd.thread_id,ordinal],|r|r.get(0)).optional()?;
                    let run: Option<Value> = run.map(|s|serde_json::from_str(&s).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()?;
                    let attempt = run.as_ref().and_then(|v|v["activeAttemptId"].as_str());
                    let turn: Option<(String,String)> = match attempt { Some(id) => tx.query_row("SELECT provider_turn_id,provider_thread_id FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 OR provider_turn_id=(SELECT provider_turn_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1) ORDER BY CASE WHEN run_attempt_id=?1 THEN 0 ELSE 1 END, ordinal DESC LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?, None => None };
                    match turn { None => error=Some(format!("Cannot roll back to checkpoint {}: its provider turn is unavailable.",cmd.checkpoint_id)), Some((turn, owner)) if Some(owner.as_str()) != provider_id.as_deref() => error=Some(format!("Cannot roll back provider thread {} to checkpoint {}: target provider turn {} belongs to provider thread {}.",provider_id.as_deref().unwrap(),cmd.checkpoint_id,turn,owner)), _ => {} }
                }
            }
        }
        let mut receipt=Receipt {command_id:cmd.command_id.into(),aggregate_kind:"thread".into(),aggregate_id:cmd.thread_id.into(),command_type:"checkpoint.rollback".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(cmd.thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? { return Err(DispatchError::CommandIdConflict); }
        if receipt.status=="rejected" { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let provider_id=provider_id.unwrap();
        let thread=thread.as_mut().unwrap(); thread["rollbackRequestId"]=json!(cmd.command_id); thread["rollbackFailure"]=Value::Null; thread["updatedAt"]=json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1",params![cmd.thread_id,now,thread.to_string()])?;
        let mut request=json!({"type":"provider-thread.rollback","providerThreadId":provider_id,"checkpointId":cmd.checkpoint_id,"scopeId":cmd.scope_id});
        if let Some(restore)=cmd.restore_files { request["restoreFiles"]=json!(restore); }
        outbox::enqueue(tx,&Effect{id:format!("effect:{}:provider-thread.rollback:{}:{}",cmd.command_id,provider_id,cmd.checkpoint_id),command_id:cmd.command_id.into(),thread_id:cmd.thread_id.into(),request,status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
        let events:Vec<Event> = [("thread.metadata-updated",thread.clone()),("checkpoint.rollback-requested",json!({"scopeId":cmd.scope_id,"checkpointId":cmd.checkpoint_id,"requestedAt":now}))].into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:cmd.thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(cmd.command_id.into()),causation_event_id:None,correlation_id:Some(cmd.command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let events=event_store::append(tx,&events)?; receipt.result_sequence=events.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult{receipt,committed:true},events))
    })
}

/// Record a terminal rollback failure only while the request is still current.
/// Replays use the same command receipt and never overwrite a newer request.
pub fn record_failure(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    message: &str,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            if receipt.aggregate_id != thread_id { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let mut thread = load(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", thread_id)?;
        let error = thread.as_ref().and_then(|thread| {
            (thread["rollbackRequestId"].as_str() != Some(request_id))
                .then(|| format!("Rollback {request_id} is no longer the thread's current rollback."))
        });
        let mut receipt = Receipt { command_id: command_id.into(), aggregate_kind: "thread".into(), aggregate_id: thread_id.into(), command_type: "checkpoint.rollback.fail".into(), accepted_at: now.into(), result_sequence: event_store::latest_thread_sequence(tx, Some(thread_id))?, status: if error.is_some() { "rejected" } else { "accepted" }.into(), error };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(DispatchError::CommandIdConflict); }
        if receipt.status == "rejected" || thread.is_none() { return Ok((CommitResult { receipt, committed: false }, vec![])); }
        let thread = thread.as_mut().unwrap();
        thread["rollbackFailure"] = json!({"requestId":request_id,"message":message});
        thread["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1", params![thread_id, now, thread.to_string()])?;
        let event = Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind: "thread".into(), stream_id: thread_id.into(), event_type: "thread.metadata-updated".into(), occurred_at: now.into(), command_id: Some(command_id.into()), causation_event_id: None, correlation_id: Some(command_id.into()), actor_kind: "system".into(), payload: thread.clone(), metadata: json!({}) };
        let events = event_store::append(tx, &[event])?;
        receipt.result_sequence = events.last().unwrap().sequence;
        event_store::upsert_receipt(tx, &receipt)?;
        Ok((CommitResult { receipt, committed: true }, events))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn admission_is_atomic_and_replayable_and_rejects_shared_restore() {
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
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let scope=bus.commit(|tx| {
            let scope:String=tx.query_row("SELECT scope_id FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id='t'",[],|r|r.get(0))?;
            let payload=json!({"id":"ck","threadId":"t","scopeId":scope,"status":"ready","appRunOrdinal":0});
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoints(checkpoint_id,thread_id,scope_id,node_id,ordinal_within_scope,app_run_ordinal,status,captured_at,payload_json) VALUES('ck','t',?1,'n',0,0,'ready','now',?2)",params![scope,payload.to_string()])?;
            Ok((scope,vec![]))
        }).unwrap();
        let command = |id, restore| RollbackCommand {
            command_id: id,
            thread_id: "t",
            checkpoint_id: "ck",
            scope_id: &scope,
            restore_files: restore,
        };
        let rejected = admit(&bus, command("unsafe", None), "now").unwrap();
        assert_eq!(
            rejected.receipt.error.as_deref(),
            Some(workspace_safety::SHARED_WORKSPACE_RESTORE_MESSAGE)
        );
        let accepted = admit(&bus, command("rewind", Some(false)), "now").unwrap();
        assert!(accepted.committed);
        let replay = admit(&bus, command("rewind", Some(false)), "later").unwrap();
        assert!(!replay.committed);
        assert_eq!(
            accepted.receipt.result_sequence,
            replay.receipt.result_sequence
        );
        let stale = record_failure(&bus, "stale-failure", "t", "old", "hidden", "later").unwrap();
        assert_eq!(stale.receipt.status, "rejected");
        let failure = record_failure(
            &bus,
            "rewind:rollback-failed",
            "t",
            "rewind",
            "failed",
            "later",
        )
        .unwrap();
        assert!(failure.committed);
        assert!(
            !record_failure(
                &bus,
                "rewind:rollback-failed",
                "t",
                "rewind",
                "different",
                "later"
            )
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let effects=outbox::list_by_command_id(tx,"rewind")?; assert_eq!(effects.len(),1); assert_eq!(effects[0].request["restoreFiles"],false);
            assert!(outbox::list_by_command_id(tx,"unsafe")?.is_empty());
            let request:String=tx.query_row("SELECT json_extract(payload_json,'$.rollbackRequestId') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?; assert_eq!(request,"rewind");
            let failure:String=tx.query_row("SELECT json_extract(payload_json,'$.rollbackFailure.message') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?; assert_eq!(failure,"failed");
            Ok(((),vec![]))
        }).unwrap();
    }
}
