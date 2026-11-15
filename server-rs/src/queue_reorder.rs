//! Reorder queued user runs while keeping automatic completions first.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::params;
use serde_json::{json, Value};

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    run_id: &str,
    before: Option<&str>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, run_id, before, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    run_id: &str,
    before: Option<&str>,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {if receipt.aggregate_id != thread_id { return Err(rusqlite::Error::InvalidQuery); } return Ok((CommitResult{receipt,committed:false},vec![]));}
        let mut stmt=tx.prepare("SELECT r.payload_json,m.payload_json FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') AND m.thread_id=r.thread_id WHERE r.thread_id=?1 AND r.status='queued' ORDER BY r.ordinal")?;
        let rows=stmt.query_map([thread_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;drop(stmt);
        let mut runs=Vec::new();
        for (run,message) in rows {let run:Value=serde_json::from_str(&run).map_err(|_|rusqlite::Error::InvalidQuery)?; let message:Value=message.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null); let automatic=message.get("delegatedCompletion").is_some_and(|v|!v.is_null());let notification=message.get("notification").is_some_and(|v|!v.is_null());runs.push((run,automatic,notification));}
        runs.sort_by_key(|(run,automatic,_)|(!*automatic,run["queuePosition"].as_i64().or_else(||run["ordinal"].as_i64()).unwrap_or(i64::MAX),run["ordinal"].as_i64().unwrap_or(i64::MAX)));
        let moving=runs.iter().position(|(r,_,_)|r["id"]==run_id);
        let mut error=if moving.is_none(){Some(format!("Run {run_id} is not queued."))}else if moving.is_some_and(|i|runs[i].1||runs[i].2){Some("Automatic completion deliveries cannot be reordered.".into())}else if before.is_some_and(|id|runs.iter().any(|(r,auto,_)|*auto && r["id"]==id)){Some("Queued messages cannot be reordered ahead of automatic completion delivery.".into())}else{None};
        if error.is_none(){let moving=runs.remove(moving.unwrap()); let position=before.map(|id|runs.iter().position(|(r,auto,_)| !auto && r["id"]==id)).unwrap_or(Some(runs.len()));if let Some(position)=position{runs.insert(position,moving);}else{error=Some(format!("Queue target {} is not queued.",before.unwrap()));}}
        if error.is_none() && runs.iter().enumerate().all(|(i,(r,_,_))|r["queuePosition"].as_i64()==Some((i+1) as i64)){error=Some("Command produced no domain events.".into());}
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"queued-run.reorder".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery);}
        if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]));}
        let mut planned=Vec::new();for (index,(mut run,_,_)) in runs.into_iter().enumerate(){let position=(index+1) as i64;if run["queuePosition"].as_i64()==Some(position){continue;}run["queuePosition"]=json!(position);let id=run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![id,run.to_string()])?;planned.push(Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"run.updated".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload:run,metadata:json!({})});}
        let events=event_store::append(tx,&planned)?;receipt.result_sequence=events.last().ok_or(rusqlite::Error::InvalidQuery)?.sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},events))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reorders_users_after_automatic_completions_and_replays() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (n, id, automatic) in [(1, "auto", true), (2, "a", false), (3, "b", false)] {
            let mid = format!("m-{id}");
            let mut msg = json!({"id":mid,"role":"user"});
            if automatic {
                msg["delegatedCompletion"] = json!({"parentRunId":"parent"});
            }
            db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,'t','user',0,'now','now',?2)",params![mid,msg.to_string()]).unwrap();
            let run = json!({"id":id,"ordinal":n,"status":"queued","userMessageId":mid,"queuePosition":n});
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex','queued','now',?3)",params![id,n,run.to_string()]).unwrap();
        }
        let bus = EventBus::new(db, 16);
        let now = "2026-01-01T00:00:00.000Z";
        let blocked = dispatch(&bus, "bad", "t", "b", Some("auto"), now).unwrap();
        assert_eq!(
            blocked.receipt.error.as_deref(),
            Some("Queued messages cannot be reordered ahead of automatic completion delivery.")
        );
        let first = dispatch(&bus, "move", "t", "b", Some("a"), now).unwrap();
        assert!(first.committed);
        assert!(
            !dispatch(&bus, "move", "t", "b", None, now)
                .unwrap()
                .committed
        );
        bus.commit(|tx|{let values:Vec<String>={let mut stmt=tx.prepare("SELECT run_id FROM orchestration_v2_projection_runs ORDER BY json_extract(payload_json,'$.queuePosition')")?;let rows=stmt.query_map([],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()?;rows};assert_eq!(values,vec!["auto","b","a"]);Ok(((),vec![]))}).unwrap();
        let noop = dispatch(&bus, "noop", "t", "b", Some("a"), now).unwrap();
        assert_eq!(noop.receipt.status, "rejected");
    }
}
