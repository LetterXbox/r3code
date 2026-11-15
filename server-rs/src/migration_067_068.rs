//! Fixed SQL migrations for webhook deduplication and stop request lookup.
use rusqlite::Transaction;

pub fn apply_migration_067_068(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    let sql = match id {
        67 => include_str!("../migrations/067.sql"),
        68 => include_str!("../migrations/068.sql"),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    tx.execute_batch(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::Connection;

    #[test]
    fn adds_webhook_dedupe_and_stop_request_index() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 63).unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_067_068(&tx, 67).unwrap();
        apply_migration_067_068(&tx, 68).unwrap();
        tx.commit().unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_table_info('scheduled_tasks') WHERE name='last_run_webhook_delivery_id'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='orchestration_v2_projection_turn_items_stop_request_idx'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        db.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        let insert="INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,state,task_json,request_json,delivery_ids_json) VALUES (?1,'task','key',0,?2,'{}','{}','[]')";
        db.execute(insert, ("a", "pending")).unwrap();
        assert!(db.execute(insert, ("b", "pending")).is_err());
        db.execute(insert, ("c", "delivered")).unwrap();
    }
}
