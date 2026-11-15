//! Recovery and currency checks for delegated-completion continuation offers.
//!
//! The cohort on the parent run is the durable reservation. Offers are merely
//! hints: consumers must check currency immediately before dispatch.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryKey {
    pub parent_run_id: String,
    pub generation: u64,
    pub message_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationRequest {
    pub thread_id: String,
    pub provider_thread_id: String,
    pub driver: String,
    pub detail: Option<String>,
    pub delivery: String,
    pub delegated_completion: DeliveryKey,
}
pub fn channel() -> (
    mpsc::UnboundedSender<ContinuationRequest>,
    mpsc::UnboundedReceiver<ContinuationRequest>,
) {
    mpsc::unbounded_channel()
}
fn record(db: &Connection, sql: &str, thread: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = db
        .query_row(sql, params![thread, id], |r| r.get(0))
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}
fn run(db: &Connection, thread: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    record(db, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", thread, id)
}
fn message(db: &Connection, thread: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    record(db, "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2", thread, id)
}
/// A steer may need redispatch if its recipient turn ended before acceptance.
pub fn undelivered_mailbox_steer(
    db: &Connection,
    thread: &str,
    msg: &Value,
) -> rusqlite::Result<bool> {
    if msg["delegatedCompletion"].is_null() {
        return Ok(false);
    }
    let Some(run_id) = msg["runId"].as_str() else {
        return Ok(false);
    };
    let Some(r) = run(db, thread, run_id)? else {
        return Ok(false);
    };
    if r["userMessageId"] == msg["id"] {
        return Ok(false);
    }
    if matches!(
        r["status"].as_str(),
        Some("completed" | "failed" | "interrupted" | "cancelled" | "rolled_back")
    ) {
        return Ok(true);
    }
    let Some(attempt) = r["activeAttemptId"].as_str() else {
        return Ok(false);
    };
    let status: Option<String> = db.query_row("SELECT status FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND run_attempt_id=?2 ORDER BY ordinal DESC LIMIT 1", params![thread, attempt], |r| r.get(0)).optional()?;
    Ok(status.as_deref() == Some("completed"))
}
/// Returns the authoritative delivery only if the request can still dispatch.
pub fn current_delivery(
    db: &Connection,
    thread: &str,
    key: &DeliveryKey,
) -> rusqlite::Result<Option<Value>> {
    let Some(parent) = run(db, thread, &key.parent_run_id)? else {
        return Ok(None);
    };
    let cohort = &parent["delegatedCompletion"];
    let delivery = &cohort["delivery"];
    if cohort["disposition"] != "open"
        || delivery["generation"].as_u64() != Some(key.generation)
        || delivery["messageId"] != key.message_id
        || delivery["taskIds"].as_array().is_none_or(|a| a.is_empty())
    {
        return Ok(None);
    }
    if let Some(msg) = message(db, thread, &key.message_id)? {
        if !undelivered_mailbox_steer(db, thread, &msg)? {
            return Ok(None);
        }
    }
    Ok(Some(delivery.clone()))
}
/// Construct an offer from the latest durable reservation, if it is eligible.
pub fn offer(
    db: &Connection,
    thread: &str,
    parent_id: &str,
) -> rusqlite::Result<Option<ContinuationRequest>> {
    let available: bool = db.query_row("SELECT archived_at IS NULL AND deleted_at IS NULL FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r| r.get(0)).optional()?.unwrap_or(false);
    if !available {
        return Ok(None);
    }
    let Some(parent) = run(db, thread, parent_id)? else {
        return Ok(None);
    };
    let d = &parent["delegatedCompletion"]["delivery"];
    let (Some(generation), Some(message_id), Some(provider_id)) = (
        d["generation"].as_u64(),
        d["messageId"].as_str(),
        parent["providerThreadId"].as_str(),
    ) else {
        return Ok(None);
    };
    let key = DeliveryKey {
        parent_run_id: parent_id.into(),
        generation,
        message_id: message_id.into(),
    };
    if current_delivery(db, thread, &key)?.is_none() {
        return Ok(None);
    }
    let provider = record(db, "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2", thread, provider_id)?;
    let Some(driver) = provider.as_ref().and_then(|p| p["driver"].as_str()) else {
        return Ok(None);
    };
    Ok(Some(ContinuationRequest {
        thread_id: thread.into(),
        provider_thread_id: provider_id.into(),
        driver: driver.into(),
        detail: None,
        delivery: "message_text".into(),
        delegated_completion: key,
    }))
}
/// Scan reservations after a restart. Repeated offers are safe and expected.
pub fn offers(db: &Connection, thread: &str) -> rusqlite::Result<Vec<ContinuationRequest>> {
    let mut stmt = db.prepare("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND json_type(payload_json,'$.delegatedCompletion.delivery')='object' ORDER BY ordinal")?;
    let ids = stmt
        .query_map([thread], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for id in ids {
        if let Some(request) = offer(db, thread, &id)? {
            result.push(request);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_reoffers_only_current_undelivered_reservations() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','default','default','now','now','{}')", []).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','now',?1)", [json!({"id":"pt","driver":"codex"}).to_string()]).unwrap();
        let parent = json!({"id":"p","providerThreadId":"pt","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"m","taskIds":["task"]}}});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('p','t',1,'codex','completed','now',?1)", [parent.to_string()]).unwrap();
        let first = offers(&db, "t").unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].delegated_completion.generation, 1);
        let mut stale = first[0].delegated_completion.clone();
        stale.generation = 2;
        assert!(current_delivery(&db, "t", &stale).unwrap().is_none());
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'now','now',?1)", [json!({"id":"m","runId":"wake","delegatedCompletion":{"parentRunId":"p"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('wake','t',2,'codex','queued','now',?1)", [json!({"id":"wake","status":"queued","userMessageId":"m"}).to_string()]).unwrap();
        assert!(offers(&db, "t").unwrap().is_empty());
        db.execute(
            "UPDATE orchestration_v2_projection_runs SET payload_json=?1 WHERE run_id='wake'",
            [json!({"id":"wake","status":"completed","userMessageId":"other"}).to_string()],
        )
        .unwrap();
        assert_eq!(offers(&db, "t").unwrap().len(), 1);
        db.execute(
            "UPDATE orchestration_v2_projection_threads SET archived_at='now' WHERE thread_id='t'",
            [],
        )
        .unwrap();
        assert!(offers(&db, "t").unwrap().is_empty());
    }
}
