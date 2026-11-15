//! Migrations 051 through 054, preserving the original conditional column adds.
use rusqlite::Transaction;

/// Apply one of migrations 051–054 inside the caller's migration transaction.
pub fn apply_migration_051_054(tx: &Transaction<'_>, migration_id: i64) -> rusqlite::Result<()> {
    match migration_id {
        51 => add_column_if_missing(
            tx,
            "projection_thread_messages",
            "context_json",
            include_str!("../migrations/051.sql"),
        ),
        52 => tx.execute_batch(include_str!("../migrations/052.sql")),
        53 => tx.execute_batch(include_str!("../migrations/053.sql")),
        54 => add_column_if_missing(
            tx,
            "projection_threads",
            "auto_settle_disabled_at",
            include_str!("../migrations/054.sql"),
        ),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn add_column_if_missing(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    sql: &str,
) -> rusqlite::Result<()> {
    let mut statement = tx.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    drop(statement);
    tx.execute_batch(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migration_051_adds_context_column_and_skips_an_existing_one() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY);")
            .unwrap();
        {
            let tx = db.transaction().unwrap();
            apply_migration_051_054(&tx, 51).unwrap();
            tx.commit().unwrap();
        }
        db.execute("INSERT INTO projection_thread_messages(message_id, context_json) VALUES('m1', '{\"x\":1}')", []).unwrap();
        {
            let tx = db.transaction().unwrap();
            apply_migration_051_054(&tx, 51).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            db.query_row(
                "SELECT context_json FROM projection_thread_messages WHERE message_id='m1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "{\"x\":1}"
        );
    }

    #[test]
    fn migration_052_adds_title_state_column() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);")
            .unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_051_054(&tx, 52).unwrap();
        tx.commit().unwrap();
        assert!(column_exists(&db, "projection_threads", "title_state_json"));
    }

    #[test]
    fn migration_053_creates_without_rowid_table_with_composite_key() {
        let mut db = Connection::open_in_memory().unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_051_054(&tx, 53).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT wr FROM pragma_table_list WHERE name='pull_request_files_viewed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        db.execute("INSERT INTO pull_request_files_viewed VALUES('codex','github.com','a/b',1,'viewer','src/lib.rs',NULL,'now')", []).unwrap();
        assert!(db.execute("INSERT INTO pull_request_files_viewed VALUES('codex','github.com','a/b',1,'viewer','src/lib.rs',NULL,'later')", []).is_err());
        let tx = db.transaction().unwrap();
        apply_migration_051_054(&tx, 53).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn migration_054_adds_auto_settle_disabled_column_conditionally() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, auto_settle_disabled_at TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO projection_threads VALUES('thread-1','2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        {
            let tx = db.transaction().unwrap();
            apply_migration_051_054(&tx, 54).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            db.query_row(
                "SELECT auto_settle_disabled_at FROM projection_threads WHERE thread_id='thread-1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "2026-01-01T00:00:00.000Z"
        );
    }

    fn column_exists(db: &Connection, table: &str, column: &str) -> bool {
        let mut statement = db
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .unwrap();
        let matches = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == column);
        matches
    }
}
