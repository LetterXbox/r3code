//! Offline inspection and compaction of an existing database.
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};

#[derive(Debug)]
pub struct Status {
    pub database_bytes: u64,
    pub reclaimable_bytes: u64,
    pub incremental_vacuum_enabled: bool,
    pub legacy_database_bytes: Option<u64>,
}

pub fn inspect(path: &Path) -> Result<Status, String> {
    if !path.is_file() {
        return Err("No existing T3 Code database was found in this data directory.".into());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let page_size: u64 = db
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let pages: u64 = db
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let free: u64 = db
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mode: u32 = db
        .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(Status {
        database_bytes: pages.saturating_mul(page_size),
        reclaimable_bytes: free.saturating_mul(page_size),
        incremental_vacuum_enabled: mode == 2,
        legacy_database_bytes: path
            .parent()
            .and_then(|p| std::fs::metadata(p.join("state.sqlite")).ok())
            .map(|m| m.len()),
    })
}

/// Caller must hold the server ownership lock for the entire operation.
pub fn compact(path: &Path) -> Result<(u64, u64), String> {
    if !path.is_file() {
        return Err("No existing T3 Code database was found in this data directory.".into());
    }
    let before = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::ZERO).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
        .map_err(|_| {
            "Stop the T3 Code server and desktop app before repairing the database.".to_string()
        })?;
    println!("  Rewriting the database file");
    db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM;")
        .map_err(|e| e.to_string())?;
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if exists {
        println!("  Rebuilding the search index");
        let search_text: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('orchestration_v2_projection_messages') WHERE name='search_text')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("INSERT INTO orchestration_v2_message_search(orchestration_v2_message_search) VALUES('delete-all')").map_err(|e| e.to_string())?;
        tx.execute_batch(&format!("INSERT INTO orchestration_v2_message_search(rowid,text) SELECT messages.rowid, {} FROM orchestration_v2_projection_messages AS messages WHERE {} AND json_extract(messages.payload_json,'$.text') IS NOT NULL", crate::migration_069_073::text("messages", search_text), crate::migration_069_073::indexed_message_condition("messages"))).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    println!("  Flushing the write-ahead log");
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())?;
    drop(db);
    Ok((
        before,
        std::fs::metadata(path).map_err(|e| e.to_string())?.len(),
    ))
}

/// Remove the pre-0.1.0 database only after obtaining its SQLite exclusive lock.
/// The main database is removed before its sidecars, preserving WAL commits if
/// unlinking the database fails. Callers must request this repair explicitly.
pub fn remove_legacy(path: &Path) -> Result<(), String> {
    let legacy = path
        .parent()
        .ok_or("Invalid database path")?
        .join("state.sqlite");
    if !legacy.exists() {
        return Ok(());
    }
    let db = Connection::open_with_flags(&legacy, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::ZERO).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
        .map_err(|_| {
            "Stop the T3 Code server and desktop app before deleting the old database.".to_string()
        })?;
    // Windows cannot unlink an open file; SQLite's exclusive lock must be
    // released immediately before deletion on that platform.
    #[cfg(windows)]
    drop(db);
    for suffix in ["", "-wal", "-shm"] {
        let mut name = legacy.as_os_str().to_os_string();
        name.push(suffix);
        match std::fs::remove_file(name) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    #[cfg(not(windows))]
    drop(db);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_removal_requires_exclusive_access_and_preserves_current_database() {
        let root = std::env::temp_dir().join(format!("doctor-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let legacy = root.join("state.sqlite");
        let current = root.join("statev2.sqlite");
        std::fs::write(&current, b"current").unwrap();
        let db = Connection::open(&legacy).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1);")
            .unwrap();
        assert!(remove_legacy(&current).is_err());
        assert!(legacy.exists());
        drop(db);
        remove_legacy(&current).unwrap();
        assert!(!legacy.exists());
        assert_eq!(std::fs::read(current).unwrap(), b"current");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inspection_and_compaction() {
        let root = std::env::temp_dir().join(format!("doctor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let p = root.join("statev2.sqlite");
        let db = Connection::open(&p).unwrap();
        db.execute_batch(
            "CREATE TABLE t(x); INSERT INTO t VALUES(zeroblob(100000)); DELETE FROM t;",
        )
        .unwrap();
        drop(db);
        let status = inspect(&p).unwrap();
        assert!(status.reclaimable_bytes > 0);
        assert!(!status.incremental_vacuum_enabled);
        let (before, after) = compact(&p).unwrap();
        assert!(after < before);
        assert!(inspect(&p).unwrap().incremental_vacuum_enabled);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compaction_rebuilds_contentless_search_after_rowids_change() {
        let root = std::env::temp_dir().join(format!("doctor-fts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("statev2.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(r#"
            CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_messages(thread_id TEXT, role TEXT, streaming INTEGER, payload_json TEXT, search_text TEXT);
            CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, content='', contentless_delete=1, tokenize='trigram');
            INSERT INTO orchestration_v2_projection_messages(rowid, thread_id, role, streaming, payload_json) VALUES
              (3, 't', 'assistant', 0, '{"text":"first beacon"}'),
              (9, 't', 'assistant', 0, '{"text":"second beacon"}');
            INSERT INTO orchestration_v2_message_search(rowid,text) SELECT rowid,json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages;
        "#).unwrap();
        drop(db);
        compact(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        let found: i64 = db.query_row("SELECT count(*) FROM orchestration_v2_message_search s JOIN orchestration_v2_projection_messages m ON s.rowid=m.rowid WHERE orchestration_v2_message_search MATCH 'beacon'", [], |r| r.get(0)).unwrap();
        assert_eq!(found, 2);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compaction_refuses_an_open_wal_database() {
        let root = std::env::temp_dir().join(format!("doctor-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("statev2.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1);")
            .unwrap();
        assert!(compact(&path).is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_database_is_not_created() {
        let p = std::env::temp_dir().join(format!("missing-{}", uuid::Uuid::new_v4()));
        assert!(inspect(&p).is_err());
        assert!(compact(&p).is_err());
        assert!(!p.exists());
    }
}
