//! Transactional, durable webhook queue admission.
use crate::{
    webhook_dedupe,
    webhook_template::{find_failed_webhook_filter, render_webhook_prompt, WebhookRequest},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Queued,
    Coalesced,
    Duplicate,
    Filtered(String),
    RateLimited,
    QueueFull,
}
fn key(template: Option<&str>, request: &WebhookRequest) -> Option<String> {
    let rendered = render_webhook_prompt(template?, request, "", true);
    webhook_dedupe::replay_key(&rendered.prompt, !rendered.missing.is_empty())
}
/// Call in an IMMEDIATE transaction along with credential validation and delivery logging.
/// All accepted work is written to the pending table before returning.
pub fn admit(
    db: &Connection,
    task: &Value,
    request: &WebhookRequest,
    delivery_id: &str,
    now_ms: i64,
) -> Result<Admission, String> {
    let task_id = task["id"].as_str().ok_or("Task has no id")?;
    let schedule = &task["schedule"];
    if let Some(filters) = schedule["filters"].as_array() {
        if let Some(failed) = find_failed_webhook_filter(filters, request) {
            return Ok(Admission::Filtered(failed.description()));
        }
    }
    let dedupe = &schedule["dedupe"];
    let replay = key(dedupe["replayKey"].as_str(), request);
    if let Some(replay) = replay.as_deref() {
        if webhook_dedupe::owner(db, task_id, replay, now_ms)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(Admission::Duplicate);
        }
    }
    // Persist the sliding rate window so restarts do not reset the public endpoint limit.
    db.execute_batch("CREATE TABLE IF NOT EXISTS scheduled_task_webhook_rate_slots (task_id TEXT NOT NULL, admitted_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_webhook_rate_slots ON scheduled_task_webhook_rate_slots(task_id, admitted_at);").map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM scheduled_task_webhook_rate_slots WHERE admitted_at<=?1",
        [now_ms.saturating_sub(60_000)],
    )
    .map_err(|e| e.to_string())?;
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM scheduled_task_webhook_rate_slots WHERE task_id=?1",
            [task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 60 {
        return Ok(Admission::RateLimited);
    }
    let coalesce = key(dedupe["coalesceKey"].as_str(), request);
    let pending: Option<String> = if let Some(k) = coalesce.as_deref() {
        db.query_row("SELECT delivery_id FROM scheduled_task_webhook_pending WHERE task_id=?1 AND coalesce_key=?2 AND state='pending' AND due_at>?3", params![task_id,k,now_ms], |r|r.get(0)).optional().map_err(|e|e.to_string())?
    } else {
        None
    };
    if pending.is_none() {
        let count: i64 = db.query_row("SELECT count(*) FROM scheduled_task_webhook_pending WHERE task_id=?1 AND state IN ('pending','ready','dispatching','running')", [task_id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if count >= 20 {
            return Ok(Admission::QueueFull);
        }
    }
    let owner = pending.as_deref().unwrap_or(delivery_id);
    if !webhook_dedupe::claim(db, task_id, replay.as_deref(), owner, now_ms)
        .map_err(|e| e.to_string())?
    {
        return Ok(Admission::Duplicate);
    }
    let request_json = json!({"method":request.method,"path":request.path,"query":request.query,"headers":request.headers,"bodyText":request.body_text}).to_string();
    db.execute(
        "INSERT INTO scheduled_task_webhook_rate_slots(task_id,admitted_at) VALUES(?1,?2)",
        params![task_id, now_ms],
    )
    .map_err(|e| e.to_string())?;
    if let Some(owner) = pending {
        db.execute("UPDATE scheduled_task_webhook_pending SET request_json=?2,delivery_ids_json=json_insert(delivery_ids_json,'$[#]',?3) WHERE delivery_id=?1",params![owner,request_json,delivery_id]).map_err(|e|e.to_string())?;
        return Ok(Admission::Coalesced);
    }
    let coalesce_key = coalesce
        .clone()
        .unwrap_or_else(|| format!("delivery:{delivery_id}"));
    if coalesce.is_some() {
        db.execute("UPDATE scheduled_task_webhook_pending SET state='ready' WHERE task_id=?1 AND coalesce_key=?2 AND state='pending' AND due_at<=?3",params![task_id,coalesce_key,now_ms]).map_err(|e|e.to_string())?;
    }
    let due = if coalesce.is_some() {
        now_ms.saturating_add(
            dedupe["coalesceWindowSeconds"]
                .as_i64()
                .unwrap_or(120)
                .clamp(0, 86400)
                .saturating_mul(1000),
        )
    } else {
        now_ms
    };
    db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![delivery_id,task_id,coalesce_key,due,task.to_string(),request_json,json!([delivery_id]).to_string()]).map_err(|e|e.to_string())?;
    Ok(Admission::Queued)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalescing_and_replay_are_durable() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE scheduled_task_webhook_replay_keys(task_id TEXT,replay_key TEXT,delivery_id TEXT,expires_at INTEGER,PRIMARY KEY(task_id,replay_key)); CREATE TABLE scheduled_task_webhook_pending(delivery_id TEXT PRIMARY KEY,task_id TEXT,coalesce_key TEXT,due_at INTEGER,state TEXT DEFAULT 'pending',task_json TEXT,request_json TEXT,delivery_ids_json TEXT); CREATE UNIQUE INDEX pending_key ON scheduled_task_webhook_pending(task_id,coalesce_key) WHERE state='pending';").unwrap();
        let task = json!({"id":"task", "schedule":{"filters":[{"path":"body.action","op":"equals","value":"open"}],"dedupe":{"replayKey":"{{body.id}}","coalesceKey":"{{body.group}}","coalesceWindowSeconds":10}}});
        let mut request = WebhookRequest {
            body_text: json!({"action":"open","id":1,"group":"g"}).to_string(),
            ..Default::default()
        };
        assert_eq!(
            admit(&db, &task, &request, "one", 100).unwrap(),
            Admission::Queued
        );
        assert_eq!(
            admit(&db, &task, &request, "duplicate", 101).unwrap(),
            Admission::Duplicate
        );
        request.body_text = json!({"action":"open","id":2,"group":"g"}).to_string();
        assert_eq!(
            admit(&db, &task, &request, "two", 102).unwrap(),
            Admission::Coalesced
        );
        let (payload, ids): (String, String) = db
            .query_row(
                "SELECT request_json,delivery_ids_json FROM scheduled_task_webhook_pending",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(payload.contains("\\\"id\\\":2"));
        assert_eq!(
            serde_json::from_str::<Value>(&ids).unwrap(),
            json!(["one", "two"])
        );
        request.body_text = json!({"action":"closed","id":3,"group":"g"}).to_string();
        assert!(matches!(
            admit(&db, &task, &request, "three", 103).unwrap(),
            Admission::Filtered(_)
        ));
    }
}
