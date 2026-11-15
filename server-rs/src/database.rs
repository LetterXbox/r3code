//! SQLite connection configuration shared by persistence services.
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::path::Path;

/// Open the writer and configure the pragmas prescribed by the server spec.
/// Schema migrations must run after this function and before serving requests.
pub fn open_writer(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    configure_writer(&db)?;
    Ok(db)
}

/// Readers are opened read-only and wait for a busy writer for up to five seconds.
pub fn open_reader(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.execute_batch("PRAGMA busy_timeout=5000;")?;
    Ok(db)
}

pub fn configure_writer(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;
    let table_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='table'",
        [],
        |row| row.get(0),
    )?;
    if table_count == 0 {
        db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL;")?;
    }
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA checkpoint_fullfsync=ON; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=134217728;")?;
    Ok(())
}

/// Prevent SQLITE_BUSY_SNAPSHOT during a read-then-write command.
pub fn begin_write(db: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    db.transaction_with_behavior(TransactionBehavior::Immediate)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configures_fresh_database_and_write_transaction() {
        let mut db = Connection::open_in_memory().unwrap();
        configure_writer(&db).unwrap();
        assert_eq!(
            db.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5000
        );
        assert_eq!(
            db.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let tx = begin_write(&mut db).unwrap();
        tx.execute_batch(
            "CREATE TABLE example (id INTEGER PRIMARY KEY); INSERT INTO example VALUES (1)",
        )
        .unwrap();
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='example'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
