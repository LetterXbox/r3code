//! Transactional effect outbox operations. Signal latches and worker scheduling
//! are supplied by the runtime; callers notify only after committing writes.
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

/// Effects tied to an in-process provider request cannot be resumed after a
/// server restart. Keep this list aligned with `02j-EffectOutbox-a-full.md`.
const PROCESS_BOUND: &[&str] = &[
    "provider-session.apply-model-selection",
    "provider-turn.start",
    "provider-turn.interrupt",
    "provider-turn.steer",
    "provider-turn.restart",
    "runtime-request.respond",
];
const REPLAY_SAFE: &[&str] = &[
    "provider-runtime.continue",
    "provider-session.detach",
    "provider-thread.rollback",
    "checkpoint.capture",
    "scheduled-tasks.cleanup",
    "terminal.cleanup",
    "preview.cleanup",
    "attachment.cleanup",
    "thread-title.generate",
    "delegated-tasks.stop",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub cancelled: Vec<String>,
    pub requeued: Vec<String>,
}

/// Recover effects after the previous server process ended. Running replay-safe
/// work is made pending; process-bound work in either state is cancelled. A
/// pending replay-safe row is deliberately left untouched. Callers signal the
/// returned IDs only after these statements have committed.
pub fn reconcile_after_process_loss(db: &Connection, now: &str) -> rusqlite::Result<Reconciled> {
    let mut result = Reconciled::default();
    for effect_type in PROCESS_BOUND {
        let mut stmt = db.prepare(
            "UPDATE orchestration_v2_effect_outbox SET status='cancelled',lease_owner=NULL,completed_at=?2,updated_at=?2,last_error='Cancelled because the server process ended before the effect completed.' WHERE effect_type=?1 AND status IN ('pending','running') RETURNING effect_id",
        )?;
        let rows = stmt.query_map(params![effect_type, now], |row| row.get(0))?;
        result
            .cancelled
            .extend(rows.collect::<rusqlite::Result<Vec<String>>>()?);
    }
    for effect_type in REPLAY_SAFE {
        let mut stmt = db.prepare(
            "UPDATE orchestration_v2_effect_outbox SET status='pending',available_at=?2,lease_owner=NULL,updated_at=?2,last_error='Requeued after the previous server process ended.' WHERE effect_type=?1 AND status='running' RETURNING effect_id",
        )?;
        let rows = stmt.query_map(params![effect_type, now], |row| row.get(0))?;
        result
            .requeued
            .extend(rows.collect::<rusqlite::Result<Vec<String>>>()?);
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Effect {
    pub id: String,
    pub command_id: String,
    pub thread_id: String,
    pub request: Value,
    pub status: String,
    pub attempt_count: i64,
    pub available_at: String,
    pub lease_owner: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub last_error: Option<String>,
}
/// Caller owns the write transaction and sends availability signals after commit.
pub fn enqueue(tx: &Transaction<'_>, effect: &Effect) -> rusqlite::Result<bool> {
    let kind = effect
        .request
        .get("type")
        .and_then(Value::as_str)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    Ok(tx.execute("INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'pending',0,?6,?7,?7) ON CONFLICT(effect_id) DO NOTHING",params![effect.id,effect.command_id,effect.thread_id,kind,effect.request.to_string(),effect.available_at,effect.created_at])? == 1)
}
fn decode(row: &rusqlite::Row<'_>) -> rusqlite::Result<Effect> {
    let text: String = row.get(3)?;
    let request = serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Effect {
        id: row.get(0)?,
        command_id: row.get(1)?,
        thread_id: row.get(2)?,
        request,
        status: row.get(4)?,
        attempt_count: row.get(5)?,
        available_at: row.get(6)?,
        lease_owner: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        completed_at: row.get(10)?,
        last_error: row.get(11)?,
    })
}
const FIELDS:&str="effect_id,command_id,thread_id,payload_json,status,attempt_count,available_at,lease_owner,created_at,updated_at,completed_at,last_error";
pub fn get(db: &Connection, id: &str) -> rusqlite::Result<Option<Effect>> {
    db.query_row(
        &format!("SELECT {FIELDS} FROM orchestration_v2_effect_outbox WHERE effect_id=?1"),
        [id],
        decode,
    )
    .optional()
}
pub fn list_by_command_id(db: &Connection, command_id: &str) -> rusqlite::Result<Vec<Effect>> {
    let mut stmt = db.prepare(&format!("SELECT {FIELDS} FROM orchestration_v2_effect_outbox WHERE command_id=?1 ORDER BY created_at, effect_id"))?;
    let rows = stmt.query_map([command_id], decode)?;
    rows.collect()
}

/// Cancel within the caller's transaction; notify cancellation waiters only
/// after that transaction commits.
pub fn cancel_unsettled(
    tx: &Transaction<'_>,
    thread_id: &str,
    effect_types: &[String],
    reason: &str,
    now: &str,
) -> rusqlite::Result<Vec<String>> {
    if effect_types.is_empty() {
        return Ok(Vec::new());
    }
    let types = serde_json::to_string(effect_types).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = tx.prepare("UPDATE orchestration_v2_effect_outbox SET status='cancelled',lease_owner=NULL,completed_at=?3,updated_at=?3,last_error=?4 WHERE thread_id=?1 AND status IN ('pending','running') AND effect_type IN (SELECT value FROM json_each(?2)) RETURNING effect_id")?;
    let rows = stmt.query_map(params![thread_id, types, now, reason], |row| row.get(0))?;
    rows.collect()
}

/// Delete at most one batch; callers can yield between batches and repeat
/// until fewer than 500 rows were removed.
pub fn prune_settled_batch(db: &Connection, cutoff: &str) -> rusqlite::Result<usize> {
    db.execute("DELETE FROM orchestration_v2_effect_outbox WHERE rowid IN (SELECT rowid FROM orchestration_v2_effect_outbox WHERE status IN ('succeeded','cancelled') AND completed_at < ?1 LIMIT 500)", [cutoff])
}
/// Atomically claim the oldest eligible due effect, respecting per-thread lane
/// insertion order and the optional global title-generation concurrency cap.
pub fn claim_next(
    db: &Connection,
    worker: &str,
    now: &str,
    exclude_continuations: bool,
    max_titles: Option<i64>,
) -> rusqlite::Result<Option<Effect>> {
    claim_next_supported(db, worker, now, exclude_continuations, max_titles, None)
}

pub fn claim_next_supported(
    db: &Connection,
    worker: &str,
    now: &str,
    exclude_continuations: bool,
    max_titles: Option<i64>,
    supported: Option<&str>,
) -> rusqlite::Result<Option<Effect>> {
    let sql=format!("UPDATE orchestration_v2_effect_outbox SET status='running',attempt_count=attempt_count+1,lease_owner=?1,updated_at=?2,last_error=NULL WHERE effect_id=(SELECT c.effect_id FROM orchestration_v2_effect_outbox c WHERE c.status='pending' AND c.available_at<=?2 AND (?5 IS NULL OR c.effect_type IN (SELECT value FROM json_each(?5))) AND (?3=0 OR c.effect_type!='provider-runtime.continue') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox a WHERE a.thread_id=c.thread_id AND (a.status='running' OR (a.status='pending' AND a.rowid<c.rowid AND (?3=0 OR a.effect_type!='provider-runtime.continue'))) AND ((c.effect_type='thread-title.generate' AND a.effect_type='thread-title.generate') OR (c.effect_type!='thread-title.generate' AND a.effect_type!='thread-title.generate'))) AND (?4 IS NULL OR c.effect_type!='thread-title.generate' OR (SELECT COUNT(*) FROM orchestration_v2_effect_outbox r WHERE r.status='running' AND r.effect_type='thread-title.generate')<?4) ORDER BY c.available_at,c.created_at,c.effect_id LIMIT 1) RETURNING {FIELDS}");
    db.query_row(
        &sql,
        params![worker, now, exclude_continuations, max_titles, supported],
        decode,
    )
    .optional()
}
/// Earliest eligible time, including future retries. Earlier pending rows in
/// the same lane block later rows even when their retry time has not arrived.
pub fn next_claimable_at(
    db: &Connection,
    max_titles: Option<i64>,
) -> rusqlite::Result<Option<String>> {
    let value: Option<String> = db.query_row("SELECT MIN(c.available_at) FROM orchestration_v2_effect_outbox c WHERE c.status='pending' AND NOT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox a WHERE a.thread_id=c.thread_id AND (a.status='running' OR (a.status='pending' AND a.rowid<c.rowid)) AND ((c.effect_type='thread-title.generate' AND a.effect_type='thread-title.generate') OR (c.effect_type!='thread-title.generate' AND a.effect_type!='thread-title.generate'))) AND (?1 IS NULL OR c.effect_type!='thread-title.generate' OR (SELECT COUNT(*) FROM orchestration_v2_effect_outbox r WHERE r.status='running' AND r.effect_type='thread-title.generate')<?1)", [max_titles], |row| row.get(0))?;
    if let Some(timestamp) = &value {
        chrono::DateTime::parse_from_rfc3339(timestamp).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    }
    Ok(value)
}
/// A worker may settle only the row it still owns; cancellation fences it out.
pub fn settle(
    db: &Connection,
    id: &str,
    worker: &str,
    now: &str,
    error: Option<&str>,
) -> rusqlite::Result<bool> {
    let status = if error.is_some() {
        "failed"
    } else {
        "succeeded"
    };
    Ok(db.execute("UPDATE orchestration_v2_effect_outbox SET status=?3,lease_owner=NULL,completed_at=?4,updated_at=?4,last_error=?5 WHERE effect_id=?1 AND status='running' AND lease_owner=?2",params![id,worker,status,now,error])?==1)
}
pub fn retry(
    db: &Connection,
    id: &str,
    worker: &str,
    now: &str,
    available_at: &str,
    error: &str,
) -> rusqlite::Result<bool> {
    Ok(db.execute("UPDATE orchestration_v2_effect_outbox SET status='pending',available_at=?4,lease_owner=NULL,updated_at=?3,last_error=?5 WHERE effect_id=?1 AND status='running' AND lease_owner=?2",params![id,worker,now,available_at,error])?==1)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn effect(id: &str, thread: &str, kind: &str, available: &str) -> Effect {
        Effect {
            id: id.into(),
            command_id: "cmd".into(),
            thread_id: thread.into(),
            request: serde_json::json!({"type":kind}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: available.into(),
            lease_owner: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "".into(),
            completed_at: None,
            last_error: None,
        }
    }
    #[test]
    fn cancellation_rolls_back_and_pruning_retains_failed_work() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = "2026-01-01T00:00:00.000Z";
        let tx = db.transaction().unwrap();
        enqueue(&tx, &effect("a", "t", "checkpoint.capture", now)).unwrap();
        enqueue(&tx, &effect("b", "t", "terminal.cleanup", now)).unwrap();
        tx.commit().unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(
            cancel_unsettled(&tx, "t", &["checkpoint.capture".into()], "stopped", now).unwrap(),
            vec!["a"]
        );
        tx.rollback().unwrap();
        assert_eq!(get(&db, "a").unwrap().unwrap().status, "pending");
        let tx = db.transaction().unwrap();
        cancel_unsettled(&tx, "t", &["checkpoint.capture".into()], "stopped", now).unwrap();
        tx.commit().unwrap();
        db.execute("UPDATE orchestration_v2_effect_outbox SET status='failed',completed_at=?1 WHERE effect_id='b'", [now]).unwrap();
        assert_eq!(list_by_command_id(&db, "cmd").unwrap().len(), 2);
        assert_eq!(
            prune_settled_batch(&db, "2026-01-09T00:00:00.000Z").unwrap(),
            1
        );
        assert_eq!(get(&db, "b").unwrap().unwrap().status, "failed");
    }
    #[test]
    fn claim_respects_lanes_retry_order_and_owner_fence() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = "2026-01-01T00:00:00.000Z";
        let future = "2026-01-02T00:00:00.000Z";
        let tx = db.transaction().unwrap();
        for e in [
            effect("a", "t", "checkpoint.capture", now),
            effect("b", "t", "terminal.cleanup", now),
            effect("title", "t", "thread-title.generate", now),
            effect("other-title", "u", "thread-title.generate", now),
        ] {
            assert!(enqueue(&tx, &e).unwrap());
        }
        tx.commit().unwrap();
        assert_eq!(
            claim_next(&db, "w", now, false, Some(1))
                .unwrap()
                .unwrap()
                .id,
            "a"
        );
        assert_eq!(
            claim_next(&db, "w", now, false, Some(1))
                .unwrap()
                .unwrap()
                .id,
            "other-title"
        );
        assert!(claim_next(&db, "w", now, false, Some(1)).unwrap().is_none());
        assert!(!settle(&db, "a", "other", now, None).unwrap());
        assert!(retry(&db, "a", "w", now, future, "retry").unwrap());
        assert!(settle(&db, "other-title", "w", now, None).unwrap());
        assert_eq!(
            claim_next(&db, "w", now, false, Some(1))
                .unwrap()
                .unwrap()
                .id,
            "title"
        );
        assert!(claim_next(&db, "w", now, false, Some(1)).unwrap().is_none());
        assert_eq!(
            next_claimable_at(&db, Some(1)).unwrap().as_deref(),
            Some(future)
        );
        assert_eq!(get(&db, "a").unwrap().unwrap().attempt_count, 1);
    }

    #[test]
    fn process_loss_cancels_bound_effects_and_requeues_only_running_safe_effects() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = "2026-01-02T00:00:00.000Z";
        let tx = db.transaction().unwrap();
        for e in [
            effect("running-start", "t", "provider-turn.start", now),
            effect("pending-start", "t2", "provider-turn.start", now),
            effect("running-capture", "t3", "checkpoint.capture", now),
            effect("pending-capture", "t4", "checkpoint.capture", "later"),
        ] {
            enqueue(&tx, &e).unwrap();
        }
        tx.execute("UPDATE orchestration_v2_effect_outbox SET status='running',lease_owner='dead-worker',attempt_count=2 WHERE effect_id IN ('running-start','running-capture')", []).unwrap();
        tx.commit().unwrap();

        let recovered = reconcile_after_process_loss(&db, now).unwrap();
        assert_eq!(recovered.cancelled.len(), 2);
        assert!(recovered.cancelled.contains(&"running-start".to_string()));
        assert!(recovered.cancelled.contains(&"pending-start".to_string()));
        assert_eq!(recovered.requeued, vec!["running-capture"]);

        let cancelled = get(&db, "running-start").unwrap().unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.lease_owner, None);
        assert_eq!(cancelled.completed_at.as_deref(), Some(now));
        assert_eq!(
            cancelled.last_error.as_deref(),
            Some("Cancelled because the server process ended before the effect completed.")
        );
        let requeued = get(&db, "running-capture").unwrap().unwrap();
        assert_eq!(requeued.status, "pending");
        assert_eq!(requeued.available_at, now);
        assert_eq!(requeued.attempt_count, 2);
        assert_eq!(requeued.completed_at, None);
        assert_eq!(
            requeued.last_error.as_deref(),
            Some("Requeued after the previous server process ended.")
        );
        // Pending replay-safe work must retain its original schedule and state.
        let pending = get(&db, "pending-capture").unwrap().unwrap();
        assert_eq!(pending.status, "pending");
        assert_eq!(pending.available_at, "later");
        assert_eq!(pending.last_error, None);
    }
}
