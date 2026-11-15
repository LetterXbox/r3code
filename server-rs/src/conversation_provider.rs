//! Select the provider conversation continued by an ordinary message.
use rusqlite::{params, OptionalExtension, Transaction};

/// A scheduled fresh run owns a side conversation. Continue the most recent
/// ordinary conversation on the same side of the last user fresh boundary.
pub(crate) fn select(tx: &Transaction<'_>, thread: &str) -> rusqlite::Result<Option<String>> {
    let active: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.activeProviderThreadId') FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r| r.get(0)).optional()?.flatten();
    let Some(active) = active else {
        return Ok(None);
    };
    let side: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_runs r ON r.thread_id=p.thread_id AND r.ordinal=p.first_run_ordinal JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE p.provider_thread_id=?1 AND json_extract(r.payload_json,'$.freshContext')=1 AND json_extract(m.payload_json,'$.scheduledTaskId') IS NOT NULL)", [&active], |r| r.get(0))?;
    if !side {
        return Ok(Some(active));
    }
    let boundary: i64 = tx.query_row("SELECT COALESCE(MAX(r.ordinal),0) FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND json_extract(r.payload_json,'$.freshContext')=1 AND r.status!='queued' AND NOT (r.status='cancelled' AND json_extract(r.payload_json,'$.startedAt') IS NULL) AND json_extract(m.payload_json,'$.scheduledTaskId') IS NULL", [thread], |r| r.get(0))?;
    let prior: Option<String> = tx.query_row("SELECT p.provider_thread_id FROM orchestration_v2_projection_provider_threads p WHERE p.thread_id=?1 AND p.owner_node_id IS NULL AND p.last_run_ordinal IS NOT NULL AND (?2=0 OR p.first_run_ordinal>=?2) AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=p.thread_id AND r.ordinal=p.first_run_ordinal AND json_extract(r.payload_json,'$.freshContext')=1 AND json_extract(m.payload_json,'$.scheduledTaskId') IS NOT NULL) ORDER BY p.last_run_ordinal DESC LIMIT 1", params![thread,boundary], |r| r.get(0)).optional()?;
    Ok(Some(prior.unwrap_or(active)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn scheduled_fresh_run_preserves_prior_conversation_and_user_boundary() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT, thread_id TEXT, owner_node_id TEXT, first_run_ordinal INTEGER, last_run_ordinal INTEGER); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT, ordinal INTEGER, status TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT, payload_json TEXT);").unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO orchestration_v2_projection_threads VALUES('t', '{\"activeProviderThreadId\":\"side\"}')", []).unwrap();
        tx.execute_batch("INSERT INTO orchestration_v2_projection_provider_threads VALUES('old','t',NULL,1,1),('main','t',NULL,2,2),('side','t',NULL,3,3); INSERT INTO orchestration_v2_projection_messages VALUES('a','{}'),('b','{}'),('c','{\"scheduledTaskId\":\"task\"}'); INSERT INTO orchestration_v2_projection_runs VALUES('t',1,'completed','{\"userMessageId\":\"a\"}'),('t',2,'completed','{\"userMessageId\":\"b\",\"freshContext\":true}'),('t',3,'completed','{\"userMessageId\":\"c\",\"freshContext\":true}');").unwrap();
        assert_eq!(select(&tx, "t").unwrap().as_deref(), Some("main"));
        tx.execute("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='main'", []).unwrap();
        assert_eq!(select(&tx, "t").unwrap().as_deref(), Some("side"));
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json='{\"activeProviderThreadId\":\"old\"}'", []).unwrap();
        assert_eq!(select(&tx, "t").unwrap().as_deref(), Some("old"));
    }
}
