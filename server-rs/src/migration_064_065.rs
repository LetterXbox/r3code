//! Migrations 064 and 065: normalize legacy thread links and index Codex turns.
use rusqlite::{params, Transaction};
use serde_json::{json, Value};

use crate::migration_050::{legacy_pull_request_key, parse_legacy_link};

/// Apply one migration inside the caller's migration-ledger transaction.
pub fn apply_migration_064_065(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        64 => canonicalize_thread_links(tx),
        65 => tx.execute_batch(include_str!("../migrations/065.sql")),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn links_json(linked: &str, updated_at: &str) -> rusqlite::Result<String> {
    let value: Value = serde_json::from_str(linked).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if value
        .get("projectId")
        .and_then(Value::as_str)
        .is_none_or(|v| v.trim().is_empty())
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let (repository, number, url) =
        parse_legacy_link(linked).ok_or(rusqlite::Error::InvalidQuery)?;
    let url = url.trim();
    let key = legacy_pull_request_key(repository.trim(), number, url);
    Ok(json!([{
        "host": key.host,
        "repository": key.repository,
        "number": key.number,
        "url": url,
        "source": "manual",
        "linkedAt": updated_at,
        "snapshot": null,
        "stack": null,
    }])
    .to_string())
}

fn canonicalize_thread_links(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let mut after_thread_id = String::new();
    loop {
        let rows = {
            let mut statement = tx.prepare(
                "SELECT thread_id, json_extract(payload_json, '$.linkedPullRequest'), updated_at \
                 FROM orchestration_v2_projection_threads WHERE thread_id > ?1 \
                 AND json_valid(payload_json) AND json_type(payload_json, '$.pullRequests') IS NULL \
                 AND json_type(payload_json, '$.linkedPullRequest') = 'object' \
                 ORDER BY thread_id LIMIT 500",
            )?;
            let rows = statement
                .query_map([&after_thread_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (id, linked, updated_at) in &rows {
            let links = links_json(linked, updated_at)?;
            tx.execute(
                "UPDATE orchestration_v2_projection_threads SET payload_json = \
                json_set(payload_json, '$.pullRequests', json(?1)) WHERE thread_id = ?2",
                params![links, id],
            )?;
        }
        if rows.len() < 500 {
            break;
        }
        after_thread_id = rows.last().expect("nonempty page").0.clone();
    }
    let mut after_sequence = 0_i64;
    loop {
        let rows = {
            let mut statement = tx.prepare(
                "SELECT sequence, json_extract(payload_json, '$.linkedPullRequest'), \
                 json_extract(payload_json, '$.updatedAt') FROM orchestration_events \
                 WHERE sequence > ?1 AND application_event_version = 2 AND aggregate_kind = 'thread' \
                 AND event_type LIKE 'thread.%' AND json_valid(payload_json) \
                 AND json_type(payload_json, '$.pullRequests') IS NULL \
                 AND json_type(payload_json, '$.linkedPullRequest') = 'object' ORDER BY sequence LIMIT 500",
            )?;
            let rows = statement
                .query_map([after_sequence], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (sequence, linked, updated_at) in &rows {
            let links = links_json(linked, updated_at)?;
            tx.execute(
                "UPDATE orchestration_events SET payload_json = \
                json_set(payload_json, '$.pullRequests', json(?1)) WHERE sequence = ?2",
                params![links, sequence],
            )?;
        }
        if rows.len() < 500 {
            break;
        }
        after_sequence = rows.last().expect("nonempty page").0;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::Connection;

    #[test]
    fn migrates_projection_and_v2_source_events_across_page_boundary() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 63).unwrap();
        let linked = json!({"projectId":" p ","repository":" ACME/Widget ","number":42,
                            "url":" http://forge.example:3000/acme/widget/pulls/42 "});
        for n in 0..501 {
            let id = format!("thread-{n:03}");
            let payload =
                json!({"linkedPullRequest":linked, "updatedAt":"2026-09-01T00:00:00.000Z"})
                    .to_string();
            db.execute("INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (?1,'p','title','codex','full-access','default','x','2026-09-01T00:00:00.000Z',?2)", params![id,payload]).unwrap();
            db.execute("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?1,'thread',?1,0,'thread.created','x','user',?2,'{}',2)", params![id,payload]).unwrap();
        }
        let preserved =
            json!({"linkedPullRequest":linked,"pullRequests":[],"updatedAt":"x"}).to_string();
        db.execute("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('existing','thread','existing',0,'thread.created','x','user',?1,'{}',2),('v1','thread','v1',0,'thread.created','x','user',?1,'{}',1)", [&preserved]).unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_064_065(&tx, 64).unwrap();
        apply_migration_064_065(&tx, 65).unwrap();
        tx.commit().unwrap();
        let projection: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='thread-500'", [], |r| r.get(0)).unwrap();
        let event: String = db
            .query_row(
                "SELECT payload_json FROM orchestration_events WHERE event_id='thread-500'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let expected = json!({"host":"forge.example:3000","repository":"acme/widget","number":42,"url":"http://forge.example:3000/acme/widget/pulls/42","source":"manual","linkedAt":"2026-09-01T00:00:00.000Z","snapshot":null,"stack":null});
        assert_eq!(
            serde_json::from_str::<Value>(&projection).unwrap()["pullRequests"][0],
            expected
        );
        assert_eq!(
            serde_json::from_str::<Value>(&projection).unwrap(),
            serde_json::from_str::<Value>(&event).unwrap()
        );
        for id in ["existing", "v1"] {
            let actual: String = db
                .query_row(
                    "SELECT payload_json FROM orchestration_events WHERE event_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(actual, preserved);
        }
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='orchestration_v2_provider_turns_codex_native_id_idx'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
    }

    #[test]
    fn invalid_link_fails_and_caller_can_roll_back() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 63).unwrap();
        let payload = r#"{"linkedPullRequest":{"repository":"repo","number":1,"url":"https://example.com"},"updatedAt":"x"}"#;
        db.execute("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('invalid','thread','invalid',0,'thread.created','x','user',?1,'{}',2)", [payload]).unwrap();
        let tx = db.transaction().unwrap();
        assert!(apply_migration_064_065(&tx, 64).is_err());
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT payload_json FROM orchestration_events WHERE event_id='invalid'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            payload
        );
    }
}
