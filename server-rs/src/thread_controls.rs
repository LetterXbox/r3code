//! Transactional sidebar controls for existing threads.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub enum Control<'a> {
    Snooze { until: &'a str },
    Unsnooze,
    AutoSettle { enabled: bool },
    Pin { order_key: Option<&'a str> },
    Unpin,
    PinReorder { order_key: &'a str },
    ActiveReorder { order_key: &'a str },
    Tag { tag: &'a str, tagged: bool },
}

/// The caller validates command schema and trims order keys and tags.
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: Control<'_>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, command, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: Control<'_>,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    let (kind, event_type) = match command {
        Control::Snooze { .. } => ("thread.snooze", "thread.snoozed"),
        Control::Unsnooze => ("thread.unsnooze", "thread.unsnoozed"),
        Control::AutoSettle { .. } => ("thread.auto-settle.set", "thread.auto-settle-set"),
        Control::Pin { .. } => ("thread.pin", "thread.pinned"),
        Control::Unpin => ("thread.unpin", "thread.unpinned"),
        Control::PinReorder { .. } => ("thread.pin.reorder", "thread.pin-reordered"),
        Control::ActiveReorder { .. } => ("thread.active.reorder", "thread.active-reordered"),
        Control::Tag { .. } => ("thread.tag.set", "thread.tags-updated"),
    };
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let row: Option<(String,Option<String>)> = tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let mut error=match &row { None=>Some(format!("Thread {thread_id} does not exist.")), Some((_,Some(_)))=>Some(format!("Thread {thread_id} is deleted.")), _=>None };
        let mut thread:Value=match &row {Some((raw,_))=>serde_json::from_str(raw).map_err(|_|rusqlite::Error::InvalidQuery)?,None=>Value::Null};
        if error.is_none() && !matches!(command,Control::Tag {..}) && !thread["archivedAt"].is_null() { error=Some(format!("Thread {thread_id} is archived.")); }
        if error.is_none() && matches!(command,Control::PinReorder {..}) && thread["pinnedAt"].is_null() { error=Some(format!("Thread {thread_id} is not pinned and cannot be reordered.")); }
        if error.is_none() && matches!(command,Control::ActiveReorder {..}) && (!thread["pinnedAt"].is_null() || thread["settledOverride"]=="settled") { error=Some(format!("Thread {thread_id} is not active and cannot be reordered.")); }
        if let Control::Snooze {until}=command { if error.is_none() {
            let future=chrono::DateTime::parse_from_rfc3339(until).ok().zip(chrono::DateTime::parse_from_rfc3339(now).ok()).is_some_and(|(a,b)|a>b);
            if !future { error=Some(format!("Thread {thread_id} snooze wake time {until} is not in the future.")); }
            else {
                let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' AND kind!='user_input')",[thread_id],|r|r.get(0))?;
                if pending { error=Some(format!("Thread {thread_id} has a pending approval and cannot be snoozed.")); }
                else {
                    let blocked:bool=tx.query_row("WITH latest AS (
                        SELECT * FROM orchestration_v2_projection_runs
                        WHERE thread_id=?1 AND status!='queued'
                          AND NOT (status='cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL)
                        ORDER BY (completed_at IS NULL) DESC, julianday(completed_at) DESC, ordinal DESC LIMIT 1
                    ), failure AS (
                        SELECT i.payload_json FROM orchestration_v2_projection_turn_items i JOIN latest r ON i.run_id=r.run_id
                        WHERE i.type='error' AND i.status='failed' AND i.node_id=json_extract(r.payload_json,'$.rootNodeId')
                        ORDER BY julianday(i.updated_at) DESC, i.ordinal DESC, i.turn_item_id DESC LIMIT 1
                    )
                    SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs q
                        LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(q.payload_json,'$.userMessageId')
                        WHERE q.thread_id=?1 AND q.status='queued'
                          AND json_type(m.payload_json,'$.notification') IS NULL
                          AND json_type(m.payload_json,'$.delegatedCompletion') IS NULL
                          AND NOT EXISTS (SELECT 1 FROM latest r, failure f
                            WHERE r.status='failed'
                              AND json_extract(r.payload_json,'$.providerInstanceId')=json_extract(q.payload_json,'$.providerInstanceId')
                              AND json_extract(f.payload_json,'$.failure.class')='usage_limit'
                              AND COALESCE((SELECT json_extract(s.payload_json,'$.lastError') FROM orchestration_v2_projection_provider_sessions s
                                WHERE s.thread_id=?1 AND json_extract(s.payload_json,'$.providerInstanceId')=json_extract(r.payload_json,'$.providerInstanceId')
                                ORDER BY julianday(s.updated_at) DESC LIMIT 1), json_extract(f.payload_json,'$.failure.message')) IS json_extract(f.payload_json,'$.failure.message')))", [thread_id],|r|r.get(0))?;
                    if blocked { error=Some(format!("Thread {thread_id} has a queued run and cannot be snoozed.")); }
                }
            }
        }}
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:kind.into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery)}
        if receipt.error.is_some() {return Ok((CommitResult{receipt,committed:false},vec![]))}
        match command {
            Control::Snooze {until}=>{thread["snoozedUntil"]=json!(until); thread["snoozedAt"]=json!(now); thread["updatedAt"]=json!(now); if let Some(recovery)=thread["limitRecovery"].as_object_mut(){recovery.insert("snooze".into(),json!(false));} else {thread["limitRecovery"]=Value::Null;}},
            Control::Unsnooze=>{if !thread["snoozedUntil"].is_null(){thread["lastSnoozeWakeAt"]=json!(now);thread["updatedAt"]=json!(now);} thread["snoozedUntil"]=Value::Null;thread["snoozedAt"]=Value::Null;},
            Control::AutoSettle {enabled}=>{
                let disabled=!thread["autoSettleDisabledAt"].is_null();
                if enabled == disabled {thread["updatedAt"]=json!(now);}
                if enabled {thread["autoSettleDisabledAt"]=Value::Null;} else if !disabled {thread["autoSettleDisabledAt"]=json!(now);}
            },
            Control::Pin {order_key}=>{
                let pinned=!thread["pinnedAt"].is_null(); let settled=thread["settledOverride"]=="settled"; let snoozed=!thread["snoozedUntil"].is_null();
                if !pinned {thread["pinnedAt"]=json!(now);if let Some(key)=order_key {thread["pinOrderKey"]=json!(key);}}
                if settled {thread["settledOverride"]=json!("active");thread["settledAt"]=Value::Null;thread["unsettledAt"]=json!(now);}
                if snoozed {thread["lastSnoozeWakeAt"]=json!(now);}
                thread["snoozedUntil"]=Value::Null;thread["snoozedAt"]=Value::Null; if !pinned || settled || snoozed {thread["updatedAt"]=json!(now);}
            },
            Control::Unpin=>{if !thread["pinnedAt"].is_null(){thread["updatedAt"]=json!(now);} thread["pinnedAt"]=Value::Null;thread["pinOrderKey"]=Value::Null;},
            Control::PinReorder {order_key}=>{if thread["pinOrderKey"]!=order_key {thread["updatedAt"]=json!(now);} thread["pinOrderKey"]=json!(order_key);},
            Control::ActiveReorder {order_key}=>thread["activeOrderKey"]=json!(order_key),
            Control::Tag {tag,tagged}=>{let mut tags=thread["tags"].as_array().cloned().unwrap_or_default();if tagged {if !tags.iter().any(|v|v==tag){tags.push(json!(tag));}}else{tags.retain(|v|v!=tag);} thread["tags"]=json!(tags);},
        }
        tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1",params![thread_id,thread["updatedAt"].as_str(),thread.to_string()])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:event_type.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload:thread,metadata:json!({})};
        let events=event_store::append(tx,&[event])?;receipt.result_sequence=events.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},events))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_update_and_replay_transactionally() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","updatedAt":"2026-01-01T00:00:00Z","settledOverride":"settled","settledAt":"2026-01-01T00:00:00Z","snoozedUntil":"2026-03-01T00:00:00Z","snoozedAt":"2026-01-01T00:00:00Z","tags":[]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
        let bus = EventBus::new(db, 8);
        let now = "2026-02-01T00:00:00Z";
        assert_eq!(
            dispatch(
                &bus,
                "bad",
                "t",
                Control::PinReorder { order_key: "x" },
                now
            )
            .unwrap()
            .receipt
            .status,
            "rejected"
        );
        let first = dispatch(
            &bus,
            "pin",
            "t",
            Control::Pin {
                order_key: Some("a"),
            },
            now,
        )
        .unwrap();
        assert!(first.committed);
        assert!(
            !dispatch(&bus, "pin", "t", Control::Unpin, now)
                .unwrap()
                .committed
        );
        dispatch(
            &bus,
            "tag",
            "t",
            Control::Tag {
                tag: "work",
                tagged: true,
            },
            now,
        )
        .unwrap();
        dispatch(
            &bus,
            "tag2",
            "t",
            Control::Tag {
                tag: "work",
                tagged: true,
            },
            now,
        )
        .unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let t: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(t["pinnedAt"], now);
            assert_eq!(t["settledOverride"], "active");
            assert!(t["snoozedUntil"].is_null());
            assert_eq!(t["lastSnoozeWakeAt"], now);
            assert_eq!(t["tags"], json!(["work"]));
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn auto_settle_preserves_disable_time_when_unchanged() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","updatedAt":"old","autoSettleDisabledAt":null});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','old',?1)",[thread.to_string()]).unwrap();
        let bus = EventBus::new(db, 8);
        for (id, enabled, now) in [("disable", false, "first"), ("again", false, "second")] {
            dispatch(&bus, id, "t", Control::AutoSettle { enabled }, now).unwrap();
        }
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(thread["autoSettleDisabledAt"], "first");
            assert_eq!(thread["updatedAt"], "first");
            Ok(((), vec![]))
        })
        .unwrap();
        dispatch(
            &bus,
            "enable",
            "t",
            Control::AutoSettle { enabled: true },
            "third",
        )
        .unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert!(thread["autoSettleDisabledAt"].is_null());
            assert_eq!(thread["updatedAt"], "third");
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn snooze_checks_latest_root_failure_and_current_session_error() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[json!({"id":"t","updatedAt":"2026"}).to_string()]).unwrap();
        let failed = json!({"providerInstanceId":"codex","rootNodeId":"root","startedAt":"2026-01-01T00:00:00Z"});
        let queued = json!({"providerInstanceId":"codex","userMessageId":"m"});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json) VALUES('r','t',1,'codex',NULL,'failed','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',?1)",[failed.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json) VALUES('q','t',2,'codex',NULL,'queued','2026-01-03T00:00:00Z',NULL,?1)",[queued.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES('e','t','r','root',1,'error','failed','2026-01-02T00:00:00Z',?1)",[json!({"failure":{"class":"usage_limit","message":"limit"}}).to_string()]).unwrap();
        let bus = EventBus::new(db, 8);
        let now = "2026-02-01T00:00:00Z";
        assert_eq!(
            dispatch(
                &bus,
                "s1",
                "t",
                Control::Snooze {
                    until: "2026-03-01T00:00:00Z"
                },
                now
            )
            .unwrap()
            .receipt
            .status,
            "accepted"
        );
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('s','t','codex','error','2026-02-01T00:00:00Z',?1)",[json!({"providerInstanceId":"codex","lastError":"different error"}).to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        assert_eq!(
            dispatch(
                &bus,
                "s2",
                "t",
                Control::Snooze {
                    until: "2026-03-01T00:00:00Z"
                },
                now
            )
            .unwrap()
            .receipt
            .error
            .as_deref(),
            Some("Thread t has a queued run and cannot be snoozed.")
        );
    }
}
