//! Settle a delivered wake and reserve any waiting successor cohort.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// A successful steer is accepted immediately. A completed queued wake is
/// finalized by its terminal listener; cancellation returns its claims to pending.
pub fn settle(
    bus: &EventBus,
    thread: &str,
    message_id: &str,
    cancelled: bool,
    command: &str,
    now: &str,
) -> Result<(), BusError> {
    settle_inner(bus, thread, message_id, cancelled, command, now, false)
}

/// Finalize a terminal wake, including cohorts that were disposed while it ran.
pub fn finalize(
    bus: &EventBus,
    thread: &str,
    message_id: &str,
    cancelled: bool,
    command: &str,
    now: &str,
) -> Result<(), BusError> {
    settle_inner(bus, thread, message_id, cancelled, command, now, true)
}

#[allow(clippy::too_many_arguments)]
fn settle_inner(
    bus: &EventBus,
    thread: &str,
    message_id: &str,
    cancelled: bool,
    command: &str,
    now: &str,
    terminal: bool,
) -> Result<(), BusError> {
    bus.commit(|tx| {
  if event_store::get_receipt(tx,command,"thread")?.is_some(){return Ok(((),vec![]));}
  let message:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2",params![thread,message_id],|r|r.get(0)).optional()?;
  let message:Value=message.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
  let ownership=&message["delegatedCompletion"]; let parent_id=ownership["parentRunId"].as_str().unwrap_or("");
  let parent:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![thread,parent_id],|r|r.get(0)).optional()?;
  let mut parent:Value=parent.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
  let delivery=parent["delegatedCompletion"]["delivery"].clone();
  let current=(terminal || parent["delegatedCompletion"]["disposition"]=="open") && delivery["messageId"]==message_id && delivery["generation"]==ownership["generation"] && ownership["generation"].is_u64();
  let mut changed:Vec<(&str,Value)>=Vec::new();
  if current {
   let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND run_id=?2 AND origin='app_owned' ORDER BY started_at,subagent_id")?;
   let raws=stmt.query_map(params![thread,parent_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?; drop(stmt);
   let mut tasks:Vec<Value>=raws.into_iter().map(|s|serde_json::from_str(&s).map_err(|_|rusqlite::Error::InvalidQuery)).collect::<Result<_,_>>()?;
   let delivered=delivery["taskIds"].as_array().cloned().unwrap_or_default();
   let live=matches!(parent["status"].as_str(),Some("preparing"|"starting"|"running"));
   let active:bool=tx.query_row("SELECT archived_at IS NULL AND deleted_at IS NULL FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread],|r|r.get(0)).optional()?.unwrap_or(false);
   let mut next_ids=Vec::new(); let terminal_mode=terminal;
   for task in &tasks {let id=&task["id"];let claimed=task["completionDelivery"]["state"]=="claimed" && delivered.contains(id); let pending=task["completionDelivery"]["state"]=="pending" || (claimed && cancelled);let terminal=matches!(task["status"].as_str(),Some("completed"|"failed"|"cancelled"|"interrupted"));if active && parent["delegatedCompletion"]["disposition"]=="open" && pending && terminal && (terminal_mode || !live || task["completionWake"]=="always") {next_ids.push(id.clone());}}
   let next=if next_ids.is_empty(){Value::Null}else{let generation=parent["delegatedCompletion"]["nextGeneration"].as_u64().unwrap_or(1);parent["delegatedCompletion"]["nextGeneration"]=json!(generation+1);json!({"generation":generation,"messageId":format!("message:{}",uuid::Uuid::new_v4()),"taskIds":next_ids})};
   for task in &mut tasks {let id=task["id"].as_str().unwrap_or("").to_owned();let state=if next_ids.contains(&json!(id)){Some("claimed")} else if delivered.contains(&json!(id)) && task["completionDelivery"]["state"]=="claimed" {Some(if cancelled {"pending"} else {"delivered"})} else {None};if let Some(state)=state {task["completionDelivery"]=json!({"state":state,"observedByRunId":null});task["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_subagents SET completion_delivery_state=?3,updated_at=?4,payload_json=?5 WHERE thread_id=?1 AND subagent_id=?2",params![thread,id,state,now,task.to_string()])?;changed.push(("subagent.updated",task.clone()));}}
   parent["delegatedCompletion"]["delivery"]=next;
   tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?3 WHERE thread_id=?1 AND run_id=?2",params![thread,parent_id,parent.to_string()])?;changed.push(("run.updated",parent));
  } else if let Some(raw)=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread],|r|r.get::<_,String>(0)).optional()? {changed.push(("thread.metadata-updated",serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?));}
  let events:Vec<Event>=changed.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.into()),causation_event_id:None,correlation_id:Some(command.into()),actor_kind:"system".into(),payload,metadata:json!({})}).collect();
  let stored=event_store::append(tx,&events)?;
  let receipt=Receipt{command_id:command.into(),aggregate_kind:"thread".into(),aggregate_id:thread.into(),command_type:"notification.delivery.accept".into(),accepted_at:now.into(),result_sequence:stored.last().map_or(event_store::latest_thread_sequence(tx,Some(thread))?,|e|e.sequence),status:"accepted".into(),error:None};
  event_store::insert_receipt_if_absent(tx,&receipt)?;Ok(((),stored))
 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_delivers_current_claims_and_reserves_pending_siblings() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')",[]).unwrap();
        let parent = json!({"id":"parent","status":"completed","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"wake","taskIds":["a"]}}});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex','completed','now',?1)",[parent.to_string()]).unwrap();
        let message = json!({"id":"wake","delegatedCompletion":{"parentRunId":"parent","generation":1,"taskIds":["a"]}});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('wake','t','user',0,'now','now',?1)",[message.to_string()]).unwrap();
        for (id, state) in [("a", "claimed"), ("b", "pending"), ("c", "acknowledged")] {
            let value = json!({"id":id,"threadId":"t","runId":"parent","origin":"app_owned","status":"completed","completionDelivery":{"state":state}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,completion_delivery_state,payload_json) VALUES(?1,'t','parent','n','codex','app_owned','completed','now',?2,?3)",params![id,state,value.to_string()]).unwrap();
        }
        let bus = EventBus::new(db, 16);
        settle(&bus, "t", "wake", false, "accept", "later").unwrap();
        settle(&bus, "t", "wake", false, "accept", "later").unwrap();
        bus.commit(|tx| {let states:Vec<String>={let mut s=tx.prepare("SELECT completion_delivery_state FROM orchestration_v2_projection_subagents ORDER BY subagent_id")?;let rows=s.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};assert_eq!(states,["delivered","claimed","acknowledged"]);let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='parent'",[],|r|r.get(0))?;let parent:Value=serde_json::from_str(&raw).unwrap();assert_eq!(parent["delegatedCompletion"]["delivery"]["generation"],2);assert_eq!(parent["delegatedCompletion"]["delivery"]["taskIds"],json!(["b"]));Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn cancelled_wake_reclaims_its_tasks_and_pending_siblings() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')", []).unwrap();
        let parent = json!({"id":"parent","status":"running","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"wake","taskIds":["a"]}}});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex','running','now',?1)", [parent.to_string()]).unwrap();
        let message = json!({"id":"wake","delegatedCompletion":{"parentRunId":"parent","generation":1,"taskIds":["a"]}});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('wake','t','user',0,'now','now',?1)", [message.to_string()]).unwrap();
        for (id, state) in [("a", "claimed"), ("b", "pending")] {
            let task = json!({"id":id,"runId":"parent","origin":"app_owned","status":"completed","completionWake":"settled_only","completionDelivery":{"state":state}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,completion_delivery_state,payload_json) VALUES(?1,'t','parent','n','codex','app_owned','completed','now',?2,?3)", params![id,state,task.to_string()]).unwrap();
        }
        let bus = EventBus::new(db, 16);
        finalize(&bus, "t", "wake", true, "finish", "later").unwrap();
        finalize(&bus, "t", "wake", true, "finish-again", "later").unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='parent'", [], |r| r.get(0))?;
            let parent: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(parent["delegatedCompletion"]["delivery"]["generation"], 2);
            assert_eq!(parent["delegatedCompletion"]["delivery"]["taskIds"], json!(["a", "b"]));
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE completion_delivery_state='claimed'", [], |r| r.get(0))?;
            assert_eq!(count, 2);
            Ok(((), vec![]))
        }).unwrap();
    }
}
