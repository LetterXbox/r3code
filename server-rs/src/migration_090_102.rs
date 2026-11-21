//! Migrations 090–102: auth connect devices, turn/shell/recovery indexes, inline work output, issue tracker bindings, and thread item counts.
use rusqlite::Transaction;

fn column_exists(tx: &Transaction<'_>, table: &str, column: &str) -> rusqlite::Result<bool> {
    let query = format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)");
    tx.query_row(&query, [column], |row| row.get(0))
}

fn apply_090(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    if !column_exists(tx, "auth_pairing_links", "requires_connect_approval")? {
        tx.execute_batch(
            "ALTER TABLE auth_pairing_links ADD COLUMN requires_connect_approval INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !column_exists(tx, "auth_pairing_links", "requested_client_json")? {
        tx.execute_batch(
            "ALTER TABLE auth_pairing_links ADD COLUMN requested_client_json TEXT;",
        )?;
    }
    if !column_exists(tx, "auth_sessions", "proof_key_thumbprint")? {
        tx.execute_batch(
            "ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint TEXT;",
        )?;
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS auth_connect_devices (
            proof_key_thumbprint TEXT PRIMARY KEY,
            client_json TEXT,
            approved_at TEXT NOT NULL
        );",
    )
}

fn apply_091(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    if !column_exists(tx, "auth_pairing_links", "connect_denied")? {
        tx.execute_batch(
            "ALTER TABLE auth_pairing_links ADD COLUMN connect_denied INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

fn apply_095(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    if !column_exists(tx, "orchestration_v2_projection_turn_items", "inline_work_output")? {
        tx.execute_batch(
            "ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN inline_work_output INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    tx.execute_batch(
        "UPDATE orchestration_v2_projection_turn_items
         SET inline_work_output = 1
         WHERE type = 'dynamic_tool' AND (
           payload_json LIKE '%htmlRender%' OR payload_json LIKE '%t3McpApp%'
           OR payload_json LIKE '%\"viewedImagePath\"%'
           OR payload_json LIKE '%\"toolName\":\"%delegate_task\"%'
           OR payload_json LIKE '%\"toolName\":\"%send_to_user\"%'
           OR payload_json LIKE '%sentMessage%'
         );",
    )
}

pub fn apply_migration_090_102(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        90 => apply_090(tx),
        91 => apply_091(tx),
        92 => tx.execute_batch(
            "DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_queued_input_idx;
             CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
             ON orchestration_v2_projection_turn_items(run_id)
             WHERE type = 'user_message'
               AND json_valid(payload_json)
               AND json_extract(payload_json, '$.inputIntent') = 'queued_turn';",
        ),
        93 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_attempt_idx
             ON orchestration_v2_projection_provider_turns(run_attempt_id);",
        ),
        94 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_message_ordinal_idx
             ON orchestration_v2_projection_turn_items(
               thread_id, json_extract(payload_json, '$.messageId'), ordinal
             )
             WHERE type IN ('user_message', 'assistant_message') AND json_valid(payload_json);",
        ),
        95 => apply_095(tx),
        96 => tx.execute_batch(
            "UPDATE orchestration_v2_projection_threads
             SET payload_json = json_set(payload_json, '$.titleRegeneration', json('null'))
             WHERE json_valid(payload_json)
               AND json_type(payload_json, '$.titleRegeneration') = 'object'
               AND NOT EXISTS (
                 SELECT 1 FROM orchestration_v2_effect_outbox AS job
                 WHERE job.effect_type = 'thread-title.generate'
                   AND job.thread_id = orchestration_v2_projection_threads.thread_id
                   AND job.command_id =
                     json_extract(orchestration_v2_projection_threads.payload_json, '$.titleRegeneration.requestId')
                   AND job.status IN ('pending', 'running')
               );",
        ),
        97 => tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS issue_tracker_bindings (
               project_id TEXT PRIMARY KEY,
               tracker TEXT NOT NULL,
               scope TEXT NOT NULL,
               updated_at TEXT NOT NULL
             ) WITHOUT ROWID;",
        ),
        98 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_active_shell_idx
             ON orchestration_v2_projection_threads(
               updated_at,
               thread_id,
               project_id,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.sideChat') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinOrderKey') END,
               CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END,
               CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.pullRequests[0]') END
             )
             WHERE deleted_at IS NULL AND archived_at IS NULL;
             CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_threads_pending_tasks_idx
             ON orchestration_v2_projection_provider_threads(thread_id)
             WHERE CASE WHEN json_valid(payload_json)
               THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
               ELSE 0 END;",
        ),
        99 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_usage_limit_idx
             ON orchestration_v2_projection_turn_items(thread_id)
             WHERE type = 'error' AND status = 'failed'
               AND CASE WHEN json_valid(payload_json) THEN
                 json_extract(payload_json, '$.failure.class') = 'usage_limit'
                 ELSE 0 END;",
        ),
        100 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_deferred_command_idx
             ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
             WHERE role = 'user' AND (
               lower(trim(json_extract(payload_json, '$.text'), ' \t\n\r\x0b\x0c\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}')) = '/compact'
               OR trim(json_extract(payload_json, '$.text'), ' \t\n\r\x0b\x0c\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}') GLOB '/goal*'
             );
             CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_routable_idx
             ON orchestration_v2_projection_subagents(thread_id, subagent_id)
             WHERE origin = 'provider_native' AND status = 'completed';
             CREATE INDEX IF NOT EXISTS orchestration_v2_projection_context_transfers_fork_idx
             ON orchestration_v2_projection_context_transfers(target_thread_id)
             WHERE type = 'fork';",
        ),
        101 => tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_delegated_task_idx
             ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.delegatedTaskId'))
             WHERE json_valid(payload_json) AND json_extract(payload_json, '$.delegatedTaskId') IS NOT NULL;
             CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_delegated_task_idx
             ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
             WHERE role = 'user' AND json_valid(payload_json) AND (
               json_extract(payload_json, '$.notification.source.kind') = 'monitor'
               OR json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL
             );",
        ),
        102 => tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS orchestration_v2_projection_thread_item_counts (
               thread_id TEXT PRIMARY KEY,
               item_count INTEGER NOT NULL
             ) WITHOUT ROWID;
             INSERT OR REPLACE INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
             SELECT counts.thread_id, SUM(counts.item_count)
             FROM orchestration_v2_projection_turn_item_counts counts
             WHERE counts.run_key = ''
               OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = counts.run_key)
             GROUP BY counts.thread_id;
             CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_hidden_items_idx
             ON orchestration_v2_projection_runs(thread_id, status, run_id)
             WHERE status IN ('rolled_back', 'queued', 'cancelled');
             CREATE TRIGGER IF NOT EXISTS orchestration_v2_thread_item_counts_count_insert
             AFTER INSERT ON orchestration_v2_projection_turn_item_counts
             WHEN new.run_key = ''
               OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key)
             BEGIN
               INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
               VALUES (new.thread_id, new.item_count)
               ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
             END;
             CREATE TRIGGER IF NOT EXISTS orchestration_v2_thread_item_counts_count_update
             AFTER UPDATE ON orchestration_v2_projection_turn_item_counts
             BEGIN
               UPDATE orchestration_v2_projection_thread_item_counts
               SET item_count = item_count - old.item_count
               WHERE thread_id = old.thread_id
                 AND (old.run_key = ''
                   OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key));
               INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
               SELECT new.thread_id, new.item_count
               WHERE new.run_key = ''
                 OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key)
               ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
               DELETE FROM orchestration_v2_projection_thread_item_counts
               WHERE thread_id = old.thread_id AND item_count <= 0;
             END;
             CREATE TRIGGER IF NOT EXISTS orchestration_v2_thread_item_counts_count_delete
             AFTER DELETE ON orchestration_v2_projection_turn_item_counts
             WHEN old.run_key = ''
               OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key)
             BEGIN
               UPDATE orchestration_v2_projection_thread_item_counts
               SET item_count = item_count - old.item_count
               WHERE thread_id = old.thread_id;
               DELETE FROM orchestration_v2_projection_thread_item_counts
               WHERE thread_id = old.thread_id AND item_count <= 0;
             END;
             CREATE TRIGGER IF NOT EXISTS orchestration_v2_thread_item_counts_run_insert
             AFTER INSERT ON orchestration_v2_projection_runs
             BEGIN
               INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
               SELECT thread_id, COUNT(*)
               FROM orchestration_v2_projection_turn_items
               WHERE run_id = new.run_id
               GROUP BY thread_id
               ON CONFLICT (thread_id) DO UPDATE SET item_count = item_count + excluded.item_count;
             END;
             CREATE TRIGGER IF NOT EXISTS orchestration_v2_thread_item_counts_run_delete
             AFTER DELETE ON orchestration_v2_projection_runs
             BEGIN
               UPDATE orchestration_v2_projection_thread_item_counts
               SET item_count = item_count - (
                 SELECT COUNT(*)
                 FROM orchestration_v2_projection_turn_items item
                 WHERE item.run_id = old.run_id
                   AND item.thread_id = orchestration_v2_projection_thread_item_counts.thread_id
               )
               WHERE thread_id IN (
                 SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
               );
               DELETE FROM orchestration_v2_projection_thread_item_counts
               WHERE item_count <= 0 AND thread_id IN (
                 SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
               );
             END;",
        ),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

#[cfg(test)]
mod tests {
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::{params, Connection};

    #[test]
    fn inline_work_output_backfills_only_inline_dynamic_tools() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 94).unwrap();
        for (id, kind, payload) in [
            ("delegate", "dynamic_tool", r#"{"toolName":"mcp__t3_code__delegate_task"}"#),
            ("html", "dynamic_tool", r#"{"toolName":"x","output":{"htmlRender":{}}}"#),
            ("plain", "dynamic_tool", r#"{"toolName":"mcp__docs__search","output":"ok"}"#),
            ("cmd", "command_execution", r#"{"output":"htmlRender"}"#),
        ] {
            db.execute(
                "INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t1',0,?2,'completed','2026-11-01',?3)",
                params![id, kind, payload],
            )
            .unwrap();
        }
        run_ported_migrations_to(&mut db, 95).unwrap();
        let read = |id: &str| -> i64 {
            db.query_row(
                "SELECT inline_work_output FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read("delegate"), 1);
        assert_eq!(read("html"), 1);
        assert_eq!(read("plain"), 0);
        assert_eq!(read("cmd"), 0);
    }

    #[test]
    fn migrations_096_through_102_apply_and_track_counts() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 96).unwrap();
        run_ported_migrations_to(&mut db, 102).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='issue_tracker_bindings'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        db.execute(
            "INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES('item-1','t-1',NULL,1,'assistant_message','completed','2026-11-01','{}')",
            [],
        )
        .unwrap();
        let count: i64 = db
            .query_row(
                "SELECT item_count FROM orchestration_v2_projection_thread_item_counts WHERE thread_id='t-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
