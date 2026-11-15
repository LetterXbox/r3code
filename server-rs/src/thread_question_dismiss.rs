//! Dismiss asynchronous questions without sending a provider response.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    now: &str,
) -> Result<CommitResult, BusError> {
    bus.commit(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            if receipt.aggregate_id != thread_id || receipt.command_type != "thread.user-input.dismiss" { return Err(rusqlite::Error::InvalidQuery); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1 AND thread_id=?2", params![request_id,thread_id], |r| r.get(0)).optional()?;
        let mut request: Option<Value> = raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?;
        let error = match request.as_ref() {
            None => Some("This question has already been answered."),
            Some(r) if r["status"] != "pending" => Some("This question has already been answered."),
            Some(r) if r["kind"] != "user_input" || r.pointer("/responseCapability/type").and_then(Value::as_str) != Some("message") => Some("This question needs an answer. Answer it or stop the turn."),
            _ => None,
        };
        let mut receipt = Receipt { command_id: command_id.into(), aggregate_kind: "thread".into(), aggregate_id: thread_id.into(), command_type: "thread.user-input.dismiss".into(), accepted_at: now.into(), result_sequence: event_store::latest_thread_sequence(tx, Some(thread_id))?, status: if error.is_some() {"rejected"} else {"accepted"}.into(), error: error.map(str::to_owned) };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if error.is_some() { return Ok((CommitResult { receipt, committed: false }, vec![])); }
        let request = request.as_mut().unwrap();
        request["status"] = json!("resolved"); request["resolvedAt"] = json!(now); request["decision"] = json!("cancel");
        let node_id = request["nodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='resolved',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1", params![request_id,now,request.to_string()])?;
        let mut changes = vec![("runtime-request.updated", request.clone())];
        let node: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1 AND thread_id=?2",params![node_id,thread_id],|r|r.get(0)).optional()?;
        if let Some(raw) = node { let mut value: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?; value["status"]=json!("cancelled"); value["completedAt"]=json!(now); tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,now,value.to_string()])?; changes.push(("node.updated",value)); }
        let item: Option<(String,String)> = tx.query_row("SELECT turn_item_id,payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND node_id=?2 AND type IN ('approval_request','user_input_request') AND json_extract(payload_json,'$.requestId')=?3 ORDER BY ordinal LIMIT 1",params![thread_id,node_id,request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((id,raw))=item { let mut value: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?; value["status"]=json!("cancelled"); value["completedAt"]=json!(now); value["updatedAt"]=json!(now); tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![id,now,value.to_string()])?; changes.push(("turn-item.updated",value)); }
        let events: Vec<Event> = changes.into_iter().map(|(kind,payload)| Event { id:uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:thread_id.into(), event_type:kind.into(), occurred_at:now.into(), command_id:Some(command_id.into()), causation_event_id:None, correlation_id:Some(command_id.into()), actor_kind:"user".into(), payload, metadata:json!({}) }).collect();
        let events=event_store::append(tx,&events)?; receipt.result_sequence=events.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult { receipt, committed:true },events))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dismiss_resolves_message_question_and_replays_without_effects() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let request = json!({"id":"q","threadId":"t","nodeId":"n","kind":"user_input","status":"pending","responseCapability":{"type":"message"}});
        db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES('q','t','n','user_input','pending','now',?1)",[request.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,root_node_id,kind,status,payload_json) VALUES('n','t','n','request','running',?1)",[json!({"id":"n","status":"running"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES('i','t','n',1,'user_input_request','running','now',?1)",[json!({"id":"i","requestId":"q","status":"running"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES('unrelated','t','n',0,'user_input_request','running','now',?1)", [json!({"id":"unrelated","requestId":"another","status":"running"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let result = dispatch(&bus, "c", "t", "q", "later").unwrap();
        assert!(result.committed);
        assert!(!dispatch(&bus, "c", "t", "q", "later").unwrap().committed);
        bus.commit(|tx| { let status:String = tx.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id='unrelated'", [], |r|r.get(0))?; assert_eq!(status, "running"); Ok(((),vec![])) }).unwrap();
        let rejected = dispatch(&bus, "other", "t", "q", "later").unwrap();
        assert_eq!(
            rejected.receipt.error.as_deref(),
            Some("This question has already been answered.")
        );
        bus.commit(|tx| { let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'",[],|r|r.get(0))?; let value:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(value["decision"],"cancel"); let statuses:(String,String)=tx.query_row("SELECT (SELECT status FROM orchestration_v2_projection_nodes WHERE node_id='n'),(SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id='i')",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert_eq!(statuses,("cancelled".into(),"cancelled".into())); Ok(((),vec![])) }).unwrap();
    }
    #[test]
    fn live_question_cannot_be_dismissed() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let value = json!({"nodeId":"n","kind":"user_input","status":"pending","responseCapability":{"type":"live"}});
        db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES('q','t','n','user_input','pending','now',?1)",[value.to_string()]).unwrap();
        let result = dispatch(&EventBus::new(db, 16), "c", "t", "q", "later").unwrap();
        assert_eq!(
            result.receipt.error.as_deref(),
            Some("This question needs an answer. Answer it or stop the turn.")
        );
    }
}
