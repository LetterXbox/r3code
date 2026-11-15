//! Lazy hydration of imported V1 transcripts before thread reads.
use crate::event_bus::{BusError, EventBus};

/// Atomically import pending messages and publish their events before a read.
/// A failed transaction leaves the import pending for the next attempt.
pub fn ensure_transcript(bus: &EventBus, thread_id: &str) -> Result<(), BusError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        let events = crate::project_mutation::hydrate_legacy_transcript(tx, thread_id, &now)?;
        Ok(((), events))
    })
}

/// Counts successfully hydrated threads and newly imported messages.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportCounts {
    pub imported_thread_count: usize,
    pub imported_message_count: usize,
}

fn interrupted(error: &BusError) -> bool {
    matches!(error, BusError::Database(rusqlite::Error::SqliteFailure(code, _))
        if code.code == rusqlite::ErrorCode::OperationInterrupted)
}

/// Sweep pending shells in their original import order. Failed threads remain
/// pending and do not prevent later threads from being imported. Cancellation
/// of this future and SQLite interruption propagate to the caller.
pub async fn import_pending_transcripts(bus: &EventBus) -> Result<ImportCounts, BusError> {
    let pending = bus.commit(|tx| {
        let mut statement = tx.prepare("SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL ORDER BY shell_imported_at, thread_id")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((ids, vec![]))
    });
    let pending = match pending {
        Ok(ids) => ids,
        Err(error) if interrupted(&error) => return Err(error),
        Err(error) => {
            eprintln!("Legacy v1 transcript background import stopped: {error}");
            return Ok(ImportCounts::default());
        }
    };
    let mut counts = ImportCounts::default();
    for id in pending {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let result = bus.commit(|tx| {
            let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id=?1 AND transcript_imported_at IS NULL)", [&id], |r| r.get(0))?;
            let events = crate::project_mutation::hydrate_legacy_transcript(tx, &id, &now)?;
            let messages = events.iter().filter(|e| e.event.event_type == "message.updated").count();
            Ok(((pending, messages), events))
        });
        match result {
            Ok((true, messages)) => {
                counts.imported_thread_count += 1;
                counts.imported_message_count += messages;
            }
            Ok((false, _)) => {}
            Err(error) if interrupted(&error) => return Err(error),
            Err(error) => {
                eprintln!("Failed to hydrate migrated v1 thread transcript {id}: {error}");
                let marker = bus.commit(|tx| {
                    tx.execute("UPDATE orchestration_v2_legacy_imports SET last_error='Transcript hydration failed; retry on next open.' WHERE thread_id=?1 AND transcript_imported_at IS NULL", [&id])?;
                    Ok(((), vec![]))
                });
                if let Err(error) = marker {
                    if interrupted(&error) {
                        return Err(error);
                    }
                }
            }
        }
        tokio::task::yield_now().await;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[tokio::test]
    async fn sweep_isolates_failure_and_retries_pending_thread() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for id in ["first", "later"] {
            db.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at) VALUES (?1,'2026-01-01','2026-01-01')", [id]).unwrap();
            db.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES (?1,?1,'user','legacy',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [id]).unwrap();
        }
        db.execute_batch("CREATE TRIGGER fail_first BEFORE INSERT ON orchestration_events WHEN NEW.event_id='migration:v1:message:first' BEGIN SELECT RAISE(FAIL, 'injected'); END;").unwrap();
        let bus = EventBus::new(db, 16);
        assert_eq!(
            import_pending_transcripts(&bus).await.unwrap(),
            ImportCounts {
                imported_thread_count: 1,
                imported_message_count: 1
            }
        );
        bus.commit(|tx| {
            let (finished, error): (Option<String>, Option<String>) = tx.query_row("SELECT transcript_imported_at,last_error FROM orchestration_v2_legacy_imports WHERE thread_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert!(finished.is_none());
            assert_eq!(error.as_deref(), Some("Transcript hydration failed; retry on next open."));
            let finished: Option<String> = tx.query_row("SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id='later'", [], |r| r.get(0))?;
            assert!(finished.is_some());
            tx.execute_batch("DROP TRIGGER fail_first")?;
            Ok(((), vec![]))
        }).unwrap();
        assert_eq!(
            import_pending_transcripts(&bus).await.unwrap(),
            ImportCounts {
                imported_thread_count: 1,
                imported_message_count: 1
            }
        );
        assert_eq!(
            import_pending_transcripts(&bus).await.unwrap(),
            ImportCounts::default()
        );
        bus.commit(|tx| {
            let error: Option<String> = tx.query_row(
                "SELECT last_error FROM orchestration_v2_legacy_imports WHERE thread_id='first'",
                [],
                |r| r.get(0),
            )?;
            assert!(error.is_none());
            Ok(((), vec![]))
        })
        .unwrap();
    }

    #[test]
    fn snapshot_hydrates_once_and_failure_retries() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('t','p','T','codex','full-access','default','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?1)", [r#"{"id":"t","updatedAt":"2026-01-01T00:00:00Z"}"#]).unwrap();
        db.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('old','t','user','legacy text',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", []).unwrap();
        db.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at) VALUES ('t','2026-01-01','2026-01-01')", []).unwrap();
        db.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON orchestration_events BEGIN SELECT RAISE(FAIL, 'injected'); END;").unwrap();
        let bus = EventBus::new(db, 16);
        assert!(bus.thread_snapshot("t").is_err());
        bus.commit(|tx| {
            let imported: Option<String> = tx.query_row("SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id='t'", [], |r| r.get(0))?;
            assert!(imported.is_none());
            tx.execute_batch("DROP TRIGGER fail_import")?;
            Ok(((), vec![]))
        }).unwrap();
        let (_, snapshot) = bus.thread_snapshot("t").unwrap().unwrap();
        assert_eq!(snapshot["messages"][0]["text"], "legacy text");
        bus.thread_snapshot("t").unwrap();
        bus.commit(|tx| {
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE event_id='migration:v1:message:old'", [], |r| r.get(0))?;
            assert_eq!(count, 1);
            Ok(((), vec![]))
        }).unwrap();
    }
}
