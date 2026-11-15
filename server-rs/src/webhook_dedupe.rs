//! Durable webhook replay claims. Call within the same transaction as admission.
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Hash an already-rendered replay key. Missing or empty keys do not deduplicate.
pub fn replay_key(rendered: &str, missing: bool) -> Option<String> {
    if missing || rendered.is_empty() {
        return None;
    }
    Some(format!("{:x}", Sha256::digest(rendered.as_bytes())))
}

/// Atomically reserve a key; `false` means a live reservation already exists.
/// The caller must include this operation and delivery admission in one transaction.
pub fn claim(
    db: &Connection,
    task: &str,
    key: Option<&str>,
    delivery: &str,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return Ok(true);
    };
    db.execute("DELETE FROM scheduled_task_webhook_replay_keys WHERE task_id=?1 AND replay_key=?2 AND expires_at<=?3", params![task,key,now_ms])?;
    Ok(db.execute("INSERT OR IGNORE INTO scheduled_task_webhook_replay_keys(task_id,replay_key,delivery_id,expires_at) VALUES(?1,?2,?3,?4)", params![task,key,delivery,now_ms.saturating_add(RETENTION_MS)])? == 1)
}

pub fn release(db: &Connection, delivery: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM scheduled_task_webhook_replay_keys WHERE delivery_id=?1",
        [delivery],
    )?;
    Ok(())
}

pub fn owner(
    db: &Connection,
    task: &str,
    key: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT delivery_id FROM scheduled_task_webhook_replay_keys WHERE task_id=?1 AND replay_key=?2 AND expires_at>?3", params![task,key,now_ms], |r| r.get(0)).optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_claims_survive_reopen_and_expire() {
        let path =
            std::env::temp_dir().join(format!("t3-webhook-dedupe-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE scheduled_task_webhook_replay_keys(task_id TEXT NOT NULL, replay_key TEXT NOT NULL, delivery_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(task_id,replay_key));").unwrap();
        let key = replay_key("event-1", false).unwrap();
        assert!(claim(&db, "task", Some(&key), "one", 100).unwrap());
        drop(db);
        let db = Connection::open(&path).unwrap();
        assert!(!claim(&db, "task", Some(&key), "two", 101).unwrap());
        assert_eq!(
            owner(&db, "task", &key, 101).unwrap().as_deref(),
            Some("one")
        );
        assert!(claim(&db, "task", Some(&key), "two", 100 + RETENTION_MS).unwrap());
        release(&db, "two").unwrap();
        assert!(claim(&db, "task", Some(&key), "three", 100 + RETENTION_MS).unwrap());
        assert!(replay_key("", false).is_none());
        assert!(replay_key("value", true).is_none());
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
