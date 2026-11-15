//! Transactional creation of a merge-back context transfer.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event, Receipt},
    thread_commands::{CommitResult, ThreadCommitError},
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub struct Merge<'a> {
    pub command_id: &'a str,
    pub source: &'a str,
    pub target: &'a str,
    pub source_point: &'a Value,
    pub created_by: &'a str,
}
fn load(tx: &Transaction<'_>, sql: &str, values: &[&str]) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row(sql, rusqlite::params_from_iter(values), |r| r.get(0))
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}
pub fn dispatch(
    bus: &EventBus,
    cmd: Merge<'_>,
    now: &str,
) -> Result<CommitResult, ThreadCommitError> {
    dispatch_checked(bus, cmd, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    cmd: Merge<'_>,
    now: &str,
    check: F,
) -> Result<CommitResult, ThreadCommitError>
where
    F: FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit_with(|tx| {
  check(tx)?;
  if let Some(receipt)=event_store::get_receipt(tx,cmd.command_id,"thread")? {if receipt.aggregate_id!=cmd.target{return Err(ThreadCommitError::CommandIdUsedByProject);}return Ok((CommitResult{receipt,committed:false},vec![]));}
  let src=load(tx,"SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&[cmd.source])?;
  let tgt=load(tx,"SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&[cmd.target])?;
  let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))",[cmd.target],|r|r.get(0))?;
  let other:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND source_thread_id!=?2 AND type='merge_back' AND status='pending')",params![cmd.target,cmd.source],|r|r.get(0))?;
  let point=cmd.source_point["type"].as_str().unwrap_or("");
  let run_id:Option<String>=match point {"run"=>cmd.source_point["runId"].as_str().map(str::to_owned),"checkpoint"=>match cmd.source_point["checkpointId"].as_str(){Some(id)=>tx.query_row("SELECT run_id FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id=?1 AND thread_id=?2",params![id,cmd.source],|r|r.get::<_,Option<String>>(0)).optional()?.flatten(),None=>None},"latest_stable"=>tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='completed' AND json_extract(payload_json,'$.checkpointId') IS NOT NULL ORDER BY ordinal DESC LIMIT 1",[cmd.source],|r|r.get(0)).optional()?,_=>None};
  let run=match run_id {Some(ref id)=>load(tx,"SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",&[cmd.source,id])?,None=>None};
  let fork=load(tx,"SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE type='fork' AND source_thread_id=?1 AND target_thread_id=?2 ORDER BY rowid DESC LIMIT 1",&[cmd.target,cmd.source])?;
  let error=if src.is_none(){Some(format!("Thread {} was not found.",cmd.source))}else if tgt.is_none(){Some(format!("Thread {} was not found.",cmd.target))}else if src.as_ref().is_some_and(|s|s["lineage"]["relationshipToParent"]!="fork" || s["lineage"]["parentThreadId"]!=cmd.target){Some(format!("Thread {} is not a fork of {}.",cmd.source,cmd.target))}else if busy{Some("Finish or stop the target thread's active work and clear its queue before merging back.".into())}else if other{Some(format!("Thread {} already has pending context from another side chat or fork. Send a message there first.",cmd.target))}else if run.is_none(){Some(format!("No stable source run was found for merge-back source {point}."))}else if !matches!(run.as_ref().unwrap()["status"].as_str(),Some("completed"|"waiting")){Some(format!("Merge-back source run {} is {}; only provider-finished runs are supported.",run.as_ref().unwrap()["id"].as_str().unwrap_or(""),run.as_ref().unwrap()["status"].as_str().unwrap_or("")))}else if fork.is_none(){Some(format!("No fork transfer exists between {} and {}.",cmd.target,cmd.source))}else{None};
  let mut receipt=Receipt{command_id:cmd.command_id.into(),aggregate_kind:"thread".into(),aggregate_id:cmd.target.into(),command_type:"thread.merge_back".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(cmd.target))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
  if !event_store::insert_receipt_if_absent(tx,&receipt)?{return Err(ThreadCommitError::CommandIdUsedByProject);}
  if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]));}
  let run=run.unwrap();let tgt=tgt.unwrap();let fork=fork.unwrap();
  let provider=match run["providerThreadId"].as_str(){Some(id)=>load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2",&[cmd.source,id])?,None=>None};
  let turn=match run["activeAttemptId"].as_str(){Some(id)=>load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND run_attempt_id=?2 ORDER BY ordinal DESC LIMIT 1",&[cmd.source,id])?,None=>None};
  let mut point=json!({"threadId":cmd.source,"runId":run["id"]});if !run["checkpointId"].is_null(){point["checkpointId"]=run["checkpointId"].clone();}
  if let Some(p)=&provider {if !p["nativeThreadRef"].is_null(){point["providerThreadRef"]=p["nativeThreadRef"].clone();}}
  if let Some(t)=turn {if !t["nativeTurnRef"].is_null(){point["providerTurnRef"]=t["nativeTurnRef"].clone();}}
  let id=format!("context-transfer:merge-back:{}",uuid::Uuid::new_v4());let instance=run["providerInstanceId"].clone();let transfer=json!({"id":id,"type":"merge_back","sourceThreadId":cmd.source,"targetThreadId":cmd.target,"sourcePoint":point,"basePoint":fork["sourcePoint"],"sourceProviderInstanceId":instance,"targetProviderInstanceId":tgt["modelSelection"]["instanceId"],"targetRunId":null,"status":"pending","resolution":null,"createdBy":cmd.created_by,"error":if provider.is_none(){Some("Source merge-back run has no provider thread.")}else{None},"createdAt":now,"updatedAt":now,"consumedAt":null});
  let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND source_thread_id=?2 AND type='merge_back' AND status='pending' ORDER BY rowid")?;let stale=stmt.query_map(params![cmd.target,cmd.source],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);let mut planned=Vec::new();
  for raw in stale {let mut v:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;v["status"]=json!("superseded");v["error"]=json!(format!("Superseded by merge-back transfer {id}."));v["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_context_transfers SET status='superseded',updated_at=?2,payload_json=?3 WHERE context_transfer_id=?1",params![v["id"].as_str(),now,v.to_string()])?;planned.push(("context-transfer.updated",v));}
  tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,source_provider_instance_id,target_provider,target_provider_instance_id,updated_at,payload_json) VALUES(?1,?2,?3,NULL,'merge_back','pending',?4,?4,?5,?5,?6,?7)",params![id,cmd.source,cmd.target,instance.as_str(),tgt["modelSelection"]["instanceId"].as_str(),now,transfer.to_string()])?;planned.push(("context-transfer.created",transfer));
  let events:Vec<Event>=planned.into_iter().map(|(event_type,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:cmd.target.into(),event_type:event_type.into(),occurred_at:now.into(),command_id:Some(cmd.command_id.into()),causation_event_id:None,correlation_id:Some(cmd.command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();let stored=event_store::append(tx,&events)?;receipt.result_sequence=stored.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},stored))
 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_supersedes_prior_transfer_and_blocks_busy_parent() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, thread) in [
            (
                "parent",
                json!({"id":"parent","modelSelection":{"instanceId":"codex"}}),
            ),
            (
                "child",
                json!({"id":"child","lineage":{"parentThreadId":"parent","relationshipToParent":"fork"}}),
            ),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','auto','default','now','now',?2)",params![id,thread.to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('run','child',1,'codex','codex','completed','now',?1)",[json!({"id":"run","ordinal":1,"status":"completed","providerInstanceId":"codex","providerThreadId":"source-provider","checkpointId":"checkpoint"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('fork','parent','child','fork','consumed','now',?1)",[json!({"id":"fork","sourcePoint":{"threadId":"parent","runId":"base"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('source-provider','child','codex','ready','now',?1)",[json!({"id":"source-provider","providerInstanceId":"codex"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let point = json!({"type":"run","runId":"run"});
        let run = |id| {
            dispatch(
                &bus,
                Merge {
                    command_id: id,
                    source: "child",
                    target: "parent",
                    source_point: &point,
                    created_by: "agent",
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap()
        };
        assert!(run("a").committed);
        assert!(run("b").committed);
        assert!(!run("b").committed);
        bus.commit(|tx|{let statuses:Vec<String>=tx.prepare("SELECT status FROM orchestration_v2_projection_context_transfers WHERE type='merge_back' ORDER BY rowid")?.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;assert_eq!(statuses,["superseded","pending"]);tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('busy','parent',1,'codex','queued','now','{}')",[])?;Ok(((),vec![]))}).unwrap();
        assert_eq!(run("c").receipt.error.as_deref(),Some("Finish or stop the target thread's active work and clear its queue before merging back."));
        bus.commit(|tx| {
            tx.execute(
                "DELETE FROM orchestration_v2_projection_runs WHERE run_id='busy'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        let sent = crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "parent",
                message_id: "msg",
                text: "continue",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        assert_eq!(sent.receipt.status, "accepted");
        bus.commit(|tx|{let (status,handoff):(String,String)=tx.query_row("SELECT status,json_extract(payload_json,'$.resolution.strategy') FROM orchestration_v2_projection_context_transfers WHERE type='merge_back' AND status='consumed'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"consumed");assert_eq!(handoff,"fork_delta_context");let effect:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start'",[],|r|r.get(0))?;assert_eq!(effect,1);Ok(((),vec![]))}).unwrap();
    }
}
