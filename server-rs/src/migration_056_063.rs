//! Fixed SQL migrations 056–063, the final static block before dynamic migration 064.
use rusqlite::Transaction;

pub fn apply_migration_056_063(tx: &Transaction<'_>, migration_id: i64) -> rusqlite::Result<()> {
    let sql = match migration_id {
        56 => include_str!("../migrations/056.sql"),
        57 => include_str!("../migrations/057.sql"),
        58 => include_str!("../migrations/058.sql"),
        59 => include_str!("../migrations/059.sql"),
        60 => include_str!("../migrations/060.sql"),
        61 => include_str!("../migrations/061.sql"),
        62 => include_str!("../migrations/062.sql"),
        63 => include_str!("../migrations/063.sql"),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    tx.execute_batch(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::Connection;

    fn setup_through_55(db: &mut Connection) {
        run_ported_migrations_to(db, 55).unwrap();
    }

    #[test]
    fn applies_migrations_056_through_063_in_order() {
        let mut db = Connection::open_in_memory().unwrap();
        setup_through_55(&mut db);

        // 056 drops only the four historical duplicate indexes when present.
        for index in [
            "idx_projection_threads_project_id",
            "idx_projection_thread_messages_thread_created",
            "idx_projection_thread_activities_thread_sequence",
            "idx_projection_turns_thread_requested",
        ] {
            db.execute_batch(&format!(
                "CREATE INDEX IF NOT EXISTS {index} ON projection_threads(thread_id);"
            ))
            .unwrap();
        }
        apply(&mut db, 56);
        for index in [
            "idx_projection_threads_project_id",
            "idx_projection_thread_messages_thread_created",
            "idx_projection_thread_activities_thread_sequence",
            "idx_projection_turns_thread_requested",
        ] {
            assert!(!schema_object_exists(&db, index));
        }

        apply(&mut db, 57);
        assert!(column_exists(&db, "scheduled_tasks", "webhook_token"));
        assert!(column_exists(&db, "scheduled_tasks", "webhook_secret"));
        assert!(schema_object_exists(
            &db,
            "scheduled_task_webhook_deliveries"
        ));
        assert!(schema_object_exists(
            &db,
            "idx_scheduled_task_webhook_deliveries_task"
        ));

        apply(&mut db, 58);
        assert!(schema_object_exists(
            &db,
            "scheduled_task_webhook_relay_deliveries"
        ));
        assert!(schema_object_exists(
            &db,
            "idx_scheduled_task_webhook_relay_deliveries_seen"
        ));

        apply(&mut db, 59);
        assert!(schema_object_exists(&db, "mcp_app_model_context"));

        apply(&mut db, 60);
        assert!(schema_object_exists(
            &db,
            "orchestration_v2_projection_turn_items_user_message_idx"
        ));
        assert!(schema_object_exists(
            &db,
            "orchestration_v2_projection_nodes_live_idx"
        ));

        apply(&mut db, 61);
        assert!(schema_object_exists(&db, "pull_request_review_guides"));
        assert_eq!(
            table_is_without_rowid(&db, "pull_request_review_guides"),
            Some(1)
        );

        apply(&mut db, 62);
        assert!(schema_object_exists(
            &db,
            "orchestration_v2_projection_turn_items_failed_error_idx"
        ));

        apply(&mut db, 63);
        for table in [
            "projection_thread_activities",
            "projection_turns",
            "projection_thread_proposed_plans",
            "projection_pending_approvals",
            "projection_state",
            "checkpoint_diff_blobs",
        ] {
            assert!(!schema_object_exists(&db, table), "table {table} remains");
        }
    }

    fn apply(db: &mut Connection, id: i64) {
        let tx = db.transaction().unwrap();
        apply_migration_056_063(&tx, id)
            .unwrap_or_else(|error| panic!("migration {id} failed: {error}"));
        tx.commit().unwrap();
    }

    fn schema_object_exists(db: &Connection, name: &str) -> bool {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?1)",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            != 0
    }

    fn column_exists(db: &Connection, table: &str, column: &str) -> bool {
        let mut statement = db
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .unwrap();
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == column);
        found
    }

    fn table_is_without_rowid(db: &Connection, table: &str) -> Option<i64> {
        db.query_row(
            "SELECT wr FROM pragma_table_list WHERE name=?1",
            [table],
            |row| row.get(0),
        )
        .ok()
    }
}
