//! Transactional thread read watermarks and open statistics.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

fn picked_query(query: &str) -> String {
    let query = query
        .trim()
        .trim_matches(['"', '\'', '`', '“', '”', '‘', '’'])
        .trim();
    let mut folded = String::new();
    for c in query.nfc() {
        let candidate: String = c
            .to_string()
            .nfkd()
            .filter(|c| !is_combining_mark(*c))
            .flat_map(char::to_lowercase)
            .map(|c| match c {
                'ς' => 'σ',
                '‘' | '’' => '\'',
                other => other,
            })
            .collect();
        let chosen = if c.len_utf16() == 1 && candidate.encode_utf16().count() == 1 {
            candidate
        } else {
            c.to_lowercase().collect()
        };
        folded.push_str(&chosen);
    }
    let normalized = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut count = 0;
    normalized
        .chars()
        .take_while(|c| {
            let next = count + c.len_utf16();
            if next > 32 {
                false
            } else {
                count = next;
                true
            }
        })
        .collect::<String>()
        .trim()
        .into()
}
fn opens(previous: &Value, now: i64, query: Option<&str>) -> Value {
    let old = previous.as_object();
    let old_time = old.and_then(|v| v.get("openedAt")).and_then(Value::as_i64);
    let old_score = old
        .and_then(|v| v.get("score"))
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s >= 0.0);
    let previous = old_time.zip(old_score);
    let pick = picked_query(query.unwrap_or(""));
    let mut picks: Vec<Value> = old
        .and_then(|v| v.get("picks"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| {
            v["query"].as_str().is_some()
                && v["at"]
                    .as_i64()
                    .is_some_and(|t| now.saturating_sub(t) <= 21 * 86_400_000)
        })
        .cloned()
        .collect();
    if !pick.is_empty() {
        picks.retain(|v| v["query"] != pick);
        picks.insert(0, json!({"query":pick,"at":now}));
        picks.truncate(3);
    }
    let (at, score) = match previous {
        Some((at, score)) if now.saturating_sub(at) < 600_000 => (at, score),
        Some((at, score)) => (
            now,
            score * 2f64.powf(-(now.saturating_sub(at).max(0) as f64) / (14.0 * 86_400_000.0))
                + 1.0,
        ),
        None => (now, 1.0),
    };
    json!({"openedAt":at,"score":score,"picks":picks})
}
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    visited_at: &str,
    opened: bool,
    query: Option<&str>,
    now: &str,
) -> Result<CommitResult, BusError> {
    bus.commit(|tx| {
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let row:Option<(String,Option<String>)> = tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let mut error = match &row {None=>Some(format!("Thread {thread_id} does not exist.")),Some((_,Some(_)))=>Some(format!("Thread {thread_id} is deleted.")),_=>None};
        let visit = chrono::DateTime::parse_from_rfc3339(visited_at).ok();
        if error.is_none() && visit.is_none() { error=Some(format!("Thread {thread_id} visit time {visited_at} is not a valid timestamp.")); }
        let mut receipt = Receipt {command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"thread.visit".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if receipt.error.is_some() { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let mut thread:Value = serde_json::from_str(&row.unwrap().0).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let previous=thread["lastVisitedAt"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok());
        let moves=previous.is_none_or(|p|visit.unwrap()>p);
        if !moves && !opened { return Ok((CommitResult{receipt,committed:false},vec![])); }
        if moves { thread["lastVisitedAt"]=json!(visited_at); }
        let mut payload=json!({"lastVisitedAt":thread["lastVisitedAt"]});
        if opened {
            let time=chrono::DateTime::parse_from_rfc3339(now).map_err(|_|rusqlite::Error::InvalidQuery)?.timestamp_millis();
            thread["opens"]=opens(&thread["opens"],time,query); payload["opens"]=thread["opens"].clone();
        }
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2 WHERE thread_id=?1",params![thread_id,thread.to_string()])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"thread.visit-recorded".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})};
        let events=event_store::append(tx,&[event])?; receipt.result_sequence=events.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult{receipt,committed:true},events))
    })
}

/// Rewind the read watermark to just before the latest visible run completed.
pub fn mark_unread(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    now: &str,
) -> Result<CommitResult, BusError> {
    mark_unread_checked(bus, command_id, thread_id, now, |_| Ok(()))
}

pub fn mark_unread_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt) = event_store::get_receipt(tx,command_id,"thread")? { return Ok((CommitResult {receipt,committed:false},vec![])); }
        let row: Option<(String,Option<String>)> = tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let completed: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.completedAt') FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND NOT (status='queued' AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=1) ORDER BY ordinal DESC LIMIT 1",[thread_id],|r|r.get(0)).optional()?.flatten();
        let parsed = completed.as_deref().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok());
        let error = match &row { None => Some(format!("Thread {thread_id} does not exist.")), Some((_,Some(_))) => Some(format!("Thread {thread_id} is deleted.")), _ if parsed.is_none() => Some(format!("Thread {thread_id} has no completed run to mark unread.")), _ => None };
        let mut receipt=Receipt { command_id:command_id.into(), aggregate_kind:"thread".into(), aggregate_id:thread_id.into(), command_type:"thread.mark-unread".into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?, status:if error.is_some(){"rejected"}else{"accepted"}.into(), error };
        if !event_store::insert_receipt_if_absent(tx,&receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if receipt.error.is_some() { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let mut thread:Value=serde_json::from_str(&row.unwrap().0).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let watermark=parsed.unwrap().checked_sub_signed(chrono::Duration::milliseconds(1)).ok_or(rusqlite::Error::InvalidQuery)?;
        thread["lastVisitedAt"]=json!(watermark.to_rfc3339_opts(chrono::SecondsFormat::Millis,true));
        let current=chrono::DateTime::parse_from_rfc3339(now).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if thread["snoozedUntil"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|until|until <= current) {
            thread["lastSnoozeWakeAt"]=thread["snoozedUntil"].clone(); thread["snoozedUntil"]=Value::Null; thread["snoozedAt"]=Value::Null;
        }
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2 WHERE thread_id=?1",params![thread_id,thread.to_string()])?;
        let event=Event { id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"thread.marked-unread".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload:thread,metadata:json!({}) };
        let events=event_store::append(tx,&[event])?; receipt.result_sequence=events.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult{receipt,committed:true},events))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_counts_are_deduped_and_picks_are_folded() {
        let first = opens(&Value::Null, 1_000_000, Some("  ‘Café Search’  "));
        assert_eq!(first["score"], 1.0);
        assert_eq!(first["picks"][0]["query"], "cafe search");
        let next = opens(&first, 1_001_000, Some("Other"));
        assert_eq!(next["score"], 1.0);
        assert_eq!(next["openedAt"], 1_000_000);
        let score = opens(&next, 1_700_000, None)["score"].as_f64().unwrap();
        assert!(score > 1.0 && score < 2.0);
    }
    #[test]
    fn visit_watermark_is_monotonic_and_noops_replay() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","projectId":"p","title":"T","providerInstanceId":"codex","lastVisitedAt":null,"opens":null});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let first = dispatch(
            &bus,
            "v1",
            "t",
            "2026-01-02T00:00:00.000Z",
            true,
            Some("Search"),
            "2026-01-03T00:00:00.000Z",
        )
        .unwrap();
        assert!(first.committed);
        let replay = dispatch(
            &bus,
            "v1",
            "t",
            "2027-01-01T00:00:00.000Z",
            true,
            None,
            "2026-01-03T00:00:00.000Z",
        )
        .unwrap();
        assert!(!replay.committed);
        assert_eq!(
            replay.receipt.result_sequence,
            first.receipt.result_sequence
        );
        let older = dispatch(
            &bus,
            "v2",
            "t",
            "2026-01-01T00:00:00.000Z",
            false,
            None,
            "2026-01-03T00:00:00.000Z",
        )
        .unwrap();
        assert!(!older.committed);
        assert_eq!(older.receipt.result_sequence, first.receipt.result_sequence);
        bus.commit(|tx| {
            let s: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let thread: Value = serde_json::from_str(&s).unwrap();
            assert_eq!(thread["lastVisitedAt"], "2026-01-02T00:00:00.000Z");
            assert_eq!(thread["opens"]["picks"][0]["query"], "search");
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn mark_unread_rewinds_completed_run_and_retires_expired_snooze() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","lastVisitedAt":"2026-01-04T00:00:00.000Z","snoozedUntil":"2026-01-02T00:00:00.000Z","snoozedAt":"2026-01-01T00:00:00.000Z"});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES('r','t',1,'codex','completed','2026','2026-01-03T00:00:00.000Z',?1)",[json!({"id":"r","completedAt":"2026-01-03T00:00:00.000Z"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let first = mark_unread(&bus, "mark", "t", "2026-01-04T00:00:00.000Z").unwrap();
        assert!(first.committed);
        assert!(
            !mark_unread(&bus, "mark", "t", "2026-01-04T00:00:00.000Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let value: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["lastVisitedAt"], "2026-01-02T23:59:59.999Z");
            assert!(value["snoozedUntil"].is_null());
            assert_eq!(value["lastSnoozeWakeAt"], "2026-01-02T00:00:00.000Z");
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
