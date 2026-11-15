//! Migrations 074–078: search triggers and historical projection repairs.
use crate::migration_069_073::create_message_search_triggers;
use rusqlite::Transaction;

pub fn apply_migration_074_078(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        74 => {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search')", [], |row| row.get(0))?;
            if exists {
                tx.execute_batch("DROP TRIGGER orchestration_v2_message_search_insert; DROP TRIGGER orchestration_v2_message_search_update; DROP TRIGGER orchestration_v2_message_search_delete;")?;
                create_message_search_triggers(tx)?;
            }
            Ok(())
        }
        75 => tx.execute_batch(include_str!("../migrations/075.sql")),
        76 => tx.execute_batch(include_str!("../migrations/076.sql")),
        77 => tx.execute_batch(include_str!("../migrations/077.sql")),
        78 => tx.execute_batch(include_str!("../migrations/078.sql")),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::{params, Connection};
    use serde_json::json;

    #[test]
    fn upgrades_search_triggers_without_rebuilding_existing_index() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 73).unwrap();
        let available:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search')",[],|r|r.get(0)).unwrap();
        if !available {
            // Missing FTS is a supported path and 074 must not create it.
            let tx = db.transaction().unwrap();
            apply_migration_074_078(&tx, 74).unwrap();
            tx.commit().unwrap();
            assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name='orchestration_v2_message_search'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            return;
        }
        db.execute_batch("DROP TRIGGER orchestration_v2_message_search_insert; CREATE TRIGGER orchestration_v2_message_search_insert AFTER INSERT ON orchestration_v2_projection_messages BEGIN INSERT INTO orchestration_v2_message_search(rowid,text) VALUES(new.rowid,json_extract(new.payload_json,'$.text')); END;").unwrap();
        let placeholder="[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
        let insert="INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,'t','user',0,'x','x',?2)";
        db.execute(
            insert,
            params!["old", json!({"text":placeholder}).to_string()],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_074_078(&tx, 74).unwrap();
        tx.commit().unwrap();
        db.execute(
            insert,
            params![
                "new",
                json!({"text":format!("Ultrathink:\n{placeholder}")}).to_string()
            ],
        )
        .unwrap();
        db.execute(
            insert,
            params!["normal", json!({"text":"A normal message"}).to_string()],
        )
        .unwrap();
        let indexed:Vec<String>=db.prepare("SELECT m.message_id FROM orchestration_v2_message_search s JOIN orchestration_v2_projection_messages m ON m.rowid=s.rowid ORDER BY m.message_id").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(indexed, vec!["normal", "old"]);
    }

    #[test]
    fn repairs_projection_booleans_and_backfills_subagent_delivery() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 73).unwrap();
        for (id, payload) in [
            ("yes", r#"{"settledOverride":true,"settledAt":"x"}"#),
            ("no", r#"{"settledOverride":false}"#),
            ("active", r#"{"settledOverride":"active"}"#),
            ("missing", r#"{}"#),
            ("damaged", ""),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (?1,'p','t','codex','full-access','default','x','x',?2)",params![id,payload]).unwrap();
        }
        let event_payload = r#"{"settledOverride":true,"settledAt":"x"}"#;
        db.execute("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('v2','thread','yes',0,'thread.created','x','user',?1,'{}',2)",[event_payload]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES ('s','yes','n','codex','provider','completed','x',?1)",[r#"{"completionDelivery":{"state":"delivered"}}"#]).unwrap();
        let tx = db.transaction().unwrap();
        for id in 75..=78 {
            apply_migration_074_078(&tx, id).unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(db.query_row("SELECT json_extract(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id='yes'",[],|r|r.get::<_,String>(0)).unwrap(),"settled");
        assert_eq!(db.query_row("SELECT json_type(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id='no'",[],|r|r.get::<_,String>(0)).unwrap(),"null");
        for (id, payload) in [
            ("active", r#"{"settledOverride":"active"}"#),
            ("missing", r#"{}"#),
            ("damaged", ""),
        ] {
            assert_eq!(db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[id],|r|r.get::<_,String>(0)).unwrap(),payload);
        }
        assert_eq!(
            db.query_row(
                "SELECT payload_json FROM orchestration_events WHERE event_id='v2'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            event_payload
        );
        assert_eq!(db.query_row("SELECT completion_delivery_state FROM orchestration_v2_projection_subagents WHERE subagent_id='s'",[],|r|r.get::<_,String>(0)).unwrap(),"delivered");
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_table_info('projection_projects') WHERE name IN ('pinned_at','archived_at')",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='idx_orch_events_correlation_id'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
