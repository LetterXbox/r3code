//! Persist a timeline notice when a runtime-request response cannot be delivered.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn record(
    bus: &EventBus,
    command: &str,
    thread: &str,
    request: &str,
    now: &str,
) -> Result<(), BusError> {
    bus.commit(|tx| {
  if event_store::get_receipt(tx,command,"thread")?.is_some(){return Ok(((),vec![]));}
  let row:Option<(String,Option<String>)>=tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
  let node:Option<String>=tx.query_row("SELECT n.payload_json FROM orchestration_v2_projection_runtime_requests r JOIN orchestration_v2_projection_nodes n ON n.thread_id=r.thread_id AND n.node_id=r.node_id WHERE r.thread_id=?1 AND r.runtime_request_id=?2",params![thread,request],|r|r.get(0)).optional()?;
  let mut events=Vec::new();
  if let (Some((raw,None)),Some(node))=(row,node) {
   let t:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
   let n:Value=serde_json::from_str(&node).map_err(|_|rusqlite::Error::InvalidQuery)?;
   let id=format!("turn-item:runtime-request-delivery-failure:{request}");
   let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0))?;
   let item=json!({"id":id,"threadId":thread,"runId":n["runId"],"nodeId":n["id"],"providerThreadId":n["providerThreadId"],"providerTurnId":n["providerTurnId"],"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"failed","title":"Answer delivery not confirmed","startedAt":now,"completedAt":now,"updatedAt":now,"type":"error","failure":{"class":"transport_error","message":"T3 Code could not confirm that your answer reached the agent. If the run stays stuck, stop it and try again.","code":null,"retryable":null}});
   tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'error','failed',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET ordinal=excluded.ordinal,status='failed',updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![id,thread,n["runId"].as_str(),n["id"].as_str(),n["providerThreadId"].as_str(),n["providerTurnId"].as_str(),ordinal,now,item.to_string()])?;
   events.push(Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:"turn-item.updated".into(),occurred_at:now.into(),command_id:Some(command.into()),causation_event_id:None,correlation_id:Some(command.into()),actor_kind:"system".into(),payload:item,metadata:json!({"providerInstanceId":t["providerInstanceId"]})});
  }
  let stored=event_store::append(tx,&events)?;
  let receipt=Receipt{command_id:command.into(),aggregate_kind:"thread".into(),aggregate_id:thread.into(),command_type:"runtime-request.delivery.fail".into(),accepted_at:now.into(),result_sequence:stored.last().map_or(event_store::latest_thread_sequence(tx,Some(thread))?,|e|e.sequence),status:if stored.is_empty(){"rejected"}else{"accepted"}.into(),error:if stored.is_empty(){Some("Command produced no domain events.".into())}else{None}};
  event_store::insert_receipt_if_absent(tx,&receipt)?;Ok(((),stored))
 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_delivery_failure_records_once_without_reopening_request() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)",[json!({"id":"t","providerInstanceId":"codex"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('n','t','r','n','request','completed',?1)",[json!({"id":"n","runId":"r","providerThreadId":"pt","providerTurnId":"pv"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES('q','t','n','user_input','resolved','now',?1)",[json!({"id":"q","status":"resolved"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        record(&bus, "c", "t", "q", "now").unwrap();
        record(&bus, "c", "t", "q", "later").unwrap();
        bus.commit(|tx| {let (raw,count):(String,i64)=tx.query_row("SELECT payload_json,(SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id='t') FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:runtime-request-delivery-failure:q'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;let item:Value=serde_json::from_str(&raw).unwrap();assert_eq!(count,1);assert_eq!(item["status"],"failed");assert_eq!(item["runId"],"r");assert_eq!(item["failure"]["class"],"transport_error");let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'",[],|r|r.get(0))?;assert_eq!(status,"resolved");Ok(((),vec![]))}).unwrap();
    }
}
