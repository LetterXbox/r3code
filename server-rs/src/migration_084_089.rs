//! Migrations 084–089: shell lookup indexes, turn counts and title repair.
use rusqlite::Transaction;

pub fn apply_migration_084_089(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        84 => tx.execute_batch(include_str!("../migrations/084.sql")),
        85 => tx.execute_batch(include_str!("../migrations/085.sql")),
        86 => tx.execute_batch(include_str!("../migrations/086.sql")),
        87 => {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('projection_projects') WHERE name='has_custom_title')",[],|row|row.get(0))?;
            if !exists {
                tx.execute_batch("ALTER TABLE projection_projects ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0")?;
            }
            tx.execute_batch("UPDATE projection_projects SET has_custom_title = 1 WHERE project_id IN (SELECT stream_id FROM orchestration_events WHERE aggregate_kind='project' AND event_type='project.meta-updated' AND json_type(payload_json, '$.title') = 'text')")
        }
        88 => tx.execute_batch(include_str!("../migrations/088.sql")),
        89 => tx.execute_batch(include_str!("../migrations/089.sql")),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::{params, Connection};

    #[test]
    fn counts_backfill_follow_upserts_moves_and_deletes() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 83).unwrap();
        let upsert="INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,1,'assistant_message','completed','x','{}') ON CONFLICT(turn_item_id) DO UPDATE SET thread_id=excluded.thread_id,run_id=excluded.run_id,status=excluded.status";
        for (id, thread, run) in [
            ("runless-1", "thread-1", None),
            ("runless-2", "thread-1", None),
            ("run-1", "thread-1", Some("run-1")),
        ] {
            db.execute(upsert, params![id, thread, run]).unwrap();
        }
        let tx = db.transaction().unwrap();
        for id in 84..=89 {
            apply_migration_084_089(&tx, id).unwrap();
        }
        tx.commit().unwrap();
        fn counts(db: &Connection) -> Vec<(String, String, i64)> {
            db.prepare("SELECT thread_id,run_key,item_count FROM orchestration_v2_projection_turn_item_counts ORDER BY thread_id,run_key").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap()
        }
        assert_eq!(
            counts(&db),
            vec![
                ("thread-1".into(), "".into(), 2),
                ("thread-1".into(), "run-1".into(), 1)
            ]
        );
        for (id, thread, run) in [
            ("run-1", "thread-1", Some("run-1")),
            ("run-2", "thread-2", Some("run-2")),
            ("runless-2", "thread-1", Some("run-1")),
        ] {
            db.execute(upsert, params![id, thread, run]).unwrap();
        }
        assert_eq!(
            counts(&db),
            vec![
                ("thread-1".into(), "".into(), 1),
                ("thread-1".into(), "run-1".into(), 2),
                ("thread-2".into(), "run-2".into(), 1)
            ]
        );
        db.execute(
            "DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id='thread-1'",
            [],
        )
        .unwrap();
        assert_eq!(counts(&db), vec![("thread-2".into(), "run-2".into(), 1)]);
        for index in [
            "orchestration_v2_projection_runs_last_executed_idx",
            "orchestration_v2_projection_turn_items_queued_input_idx",
            "orchestration_v2_projection_turn_items_thread_type_idx",
            "orchestration_v2_projection_threads_worktree_path_idx",
            "orchestration_v2_projection_threads_root_thread_idx",
            "orchestration_v2_projection_runs_run_status_idx",
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                    [index],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
    }
    #[test]
    fn repairs_title_history_with_or_without_existing_column() {
        for preexisting in [false, true] {
            let mut db = Connection::open_in_memory().unwrap();
            run_ported_migrations_to(&mut db, 83).unwrap();
            for id in ["renamed", "untouched", "wrong-kind", "numeric"] {
                db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?1,'repo','/tmp','[]','x','x')",[id]).unwrap();
            }
            for (id, kind, payload) in [
                ("renamed", "project", r#"{"title":"repo"}"#),
                ("untouched", "project", r#"{"autoPull":true}"#),
                ("wrong-kind", "thread", r#"{"title":"x"}"#),
                ("numeric", "project", r#"{"title":1}"#),
            ] {
                db.execute("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?1,?2,?1,0,'project.meta-updated','x','client',?3,'{}',2)",params![id,kind,payload]).unwrap();
            }
            if preexisting {
                db.execute_batch("ALTER TABLE projection_projects ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0").unwrap();
            }
            let tx = db.transaction().unwrap();
            apply_migration_084_089(&tx, 87).unwrap();
            tx.commit().unwrap();
            for (id, expected) in [
                ("renamed", 1),
                ("untouched", 0),
                ("wrong-kind", 0),
                ("numeric", 0),
            ] {
                assert_eq!(
                    db.query_row(
                        "SELECT has_custom_title FROM projection_projects WHERE project_id=?1",
                        [id],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                    expected
                );
            }
        }
    }
}
