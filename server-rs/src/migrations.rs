//! Transactional migration runner primitives.
//!
//! This module owns the migration ledger and per-migration transaction boundary.
//! Callers provide schema/data changes; this is not the production 89-migration
//! DDL manifest and must not be treated as one.
use rusqlite::{Connection, Transaction};

use crate::migration_history::{self, MANIFEST};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationWarning {
    pub id: i64,
    pub recorded_name: String,
    pub manifest_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub applied: Vec<(i64, String)>,
    pub warnings: Vec<MigrationWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationError {
    Sql(String),
    SkippedV2(Vec<String>),
    PreviewReconciliationRequired,
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(message) => write!(f, "migration database error: {message}"),
            Self::SkippedV2(entries) => write!(
                f,
                "This database's migration history would skip required schema migrations: {}. The migrator skips every id up to the highest recorded id, so this database was probably written by a different build.",
                entries.join(", ")
            ),
            Self::PreviewReconciliationRequired => write!(
                f,
                "This database contains an OrchestrationV2 preview migration at id 53 or 54; preview reconciliation must run before the generic migration runner."
            ),
        }
    }
}

impl std::error::Error for MigrationError {}

impl From<rusqlite::Error> for MigrationError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value.to_string())
    }
}

/// Run manifest entries newer than the highest ledger id, in id order.
///
/// Each callback and its ledger insert commit atomically. If a callback fails,
/// that migration is rolled back and the next invocation resumes at its id.
/// `to_inclusive` limits the selected manifest entries. This low-level runner
/// deliberately does not implement preview-schema reconciliation or production
/// migration DDL.
pub fn run_migrations<F>(
    db: &mut Connection,
    manifest: &[(i64, &str)],
    to_inclusive: Option<i64>,
    mut apply: F,
) -> Result<MigrationReport, MigrationError>
where
    F: FnMut(&Transaction<'_>, i64, &str) -> rusqlite::Result<()>,
{
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS effect_sql_migrations (\
             migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL\
         );",
    )?;
    let recorded = read_history(db)?;
    if to_inclusive.is_none_or(|target| target >= 55)
        && recorded
            .iter()
            .any(|(id, name)| (*id == 53 || *id == 54) && name == "OrchestrationV2")
    {
        return Err(MigrationError::PreviewReconciliationRequired);
    }

    let latest = recorded.iter().map(|(id, _)| *id).max().unwrap_or(0);
    if to_inclusive.is_none_or(|target| target >= 55) {
        let skipped = migration_history::skipped_v2(&recorded, to_inclusive);
        if !skipped.is_empty() {
            return Err(MigrationError::SkippedV2(skipped));
        }
    }

    let mut pending: Vec<_> = manifest
        .iter()
        .filter(|(id, _)| *id > latest && to_inclusive.is_none_or(|target| *id <= target))
        .copied()
        .collect();
    pending.sort_by_key(|(id, _)| *id);
    let mut applied = Vec::with_capacity(pending.len());
    for (id, name) in pending {
        let tx = db.transaction()?;
        apply(&tx, id, name)?;
        tx.execute(
            "INSERT INTO effect_sql_migrations (migration_id, created_at, name) \
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?2)",
            (id, name),
        )?;
        tx.commit()?;
        applied.push((id, name.to_owned()));
    }

    let all_recorded = read_history(db)?;
    let names: std::collections::HashMap<_, _> = manifest.iter().copied().collect();
    let warnings = all_recorded
        .into_iter()
        .filter_map(|(id, recorded_name)| {
            let expected = names.get(&id).copied();
            (expected != Some(recorded_name.as_str())).then(|| MigrationWarning {
                id,
                recorded_name,
                manifest_name: expected.map(str::to_owned),
            })
        })
        .collect();
    Ok(MigrationReport { applied, warnings })
}

/// Run the checked-in historical id/name manifest using caller-supplied DDL.
pub fn run_known_migrations<F>(
    db: &mut Connection,
    to_inclusive: Option<i64>,
    apply: F,
) -> Result<MigrationReport, MigrationError>
where
    F: FnMut(&Transaction<'_>, i64, &str) -> rusqlite::Result<()>,
{
    run_migrations(db, MANIFEST, to_inclusive, apply)
}

/// Apply the first fifteen historical migrations. Later schema migrations must be
/// implemented before this database can back the server.
pub fn run_initial_migrations(db: &mut Connection) -> Result<MigrationReport, MigrationError> {
    run_known_migrations(db, Some(15), |tx, id, _| {
        let sql = match id {
            1 => include_str!("../migrations/001.sql"),
            2 => include_str!("../migrations/002.sql"),
            3 => include_str!("../migrations/003.sql"),
            4 => include_str!("../migrations/004.sql"),
            5 => include_str!("../migrations/005.sql"),
            6 => include_str!("../migrations/006.sql"),
            7 => include_str!("../migrations/007.sql"),
            8 => include_str!("../migrations/008.sql"),
            9 => include_str!("../migrations/009.sql"),
            10 => include_str!("../migrations/010.sql"),
            11 => include_str!("../migrations/011.sql"),
            12 => include_str!("../migrations/012.sql"),
            13 => include_str!("../migrations/013.sql"),
            14 => include_str!("../migrations/014.sql"),
            15 => include_str!("../migrations/015.sql"),
            _ => return Err(rusqlite::Error::InvalidQuery),
        };
        tx.execute_batch(sql)
    })
}

/// Apply the currently ported contiguous history through migration 89.
pub fn run_ported_migrations(db: &mut Connection) -> Result<MigrationReport, MigrationError> {
    run_ported_migrations_to(db, 89)
}

pub fn run_ported_migrations_to(
    db: &mut Connection,
    target: i64,
) -> Result<MigrationReport, MigrationError> {
    if !(55..=89).contains(&target) {
        return Err(MigrationError::Sql("unsupported migration target".into()));
    }
    let first = run_initial_migrations(db)?;
    // Preview releases placed V2 at id 53 or 54. Repair their ledger and
    // conditional 53/54 schema before applying the V2 history guard.
    crate::preview_migration::reconcile_preview_migration(db, |tx, id, _| {
        crate::migration_051_054::apply_migration_051_054(tx, id)
    })
    .map_err(|error| MigrationError::Sql(error.to_string()))?;
    let later = run_known_migrations(db, Some(target), |tx, id, _| {
        if id == 50 {
            crate::migration_050::apply_migration_050(tx)
        } else if (51..=54).contains(&id) {
            crate::migration_051_054::apply_migration_051_054(tx, id)
        } else if id == 55 {
            crate::migration_055::apply_migration_055(tx)
        } else if (56..=63).contains(&id) {
            crate::migration_056_063::apply_migration_056_063(tx, id)
        } else if (64..=65).contains(&id) {
            crate::migration_064_065::apply_migration_064_065(tx, id)
        } else if id == 66 {
            crate::migration_066::apply_migration_066(tx)
        } else if (67..=68).contains(&id) {
            crate::migration_067_068::apply_migration_067_068(tx, id)
        } else if (69..=73).contains(&id) {
            crate::migration_069_073::apply_migration_069_073(tx, id)
        } else if (74..=78).contains(&id) {
            crate::migration_074_078::apply_migration_074_078(tx, id)
        } else if (79..=83).contains(&id) {
            crate::migration_079_083::apply_migration_079_083(tx, id)
        } else if (84..=89).contains(&id) {
            crate::migration_084_089::apply_migration_084_089(tx, id)
        } else {
            crate::migration_steps::apply_migration_step(tx, id)
        }
    })?;
    let mut applied = first.applied;
    applied.extend(later.applied);
    Ok(MigrationReport {
        applied,
        warnings: later.warnings,
    })
}

fn read_history(db: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut statement =
        db.prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MANIFEST: &[(i64, &str)] = &[(1, "First"), (2, "Second"), (55, "OrchestrationV2")];

    #[test]
    fn applies_real_initial_schema_idempotently() {
        let mut db = Connection::open_in_memory().unwrap();
        let report = run_initial_migrations(&mut db).unwrap();
        assert_eq!(report.applied.len(), 15);
        assert!(run_initial_migrations(&mut db).unwrap().applied.is_empty());
        for name in [
            "orchestration_events",
            "orchestration_command_receipts",
            "idx_orch_events_stream_version",
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name=?1",
                    [name],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
    }
    #[test]
    fn ported_history_runs_through_89_and_resumes() {
        let mut db = Connection::open_in_memory().unwrap();
        let report = run_ported_migrations(&mut db).unwrap();
        assert_eq!(report.applied.len(), 89);
        assert!(run_ported_migrations(&mut db).unwrap().applied.is_empty());
        assert_eq!(
            db.query_row(
                "SELECT max(migration_id) FROM effect_sql_migrations",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            89
        );
    }
    #[test]
    fn ported_runner_reconciles_preview_before_v2_guard() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 55).unwrap();
        db.execute_batch("DELETE FROM effect_sql_migrations WHERE migration_id IN (53,54); UPDATE effect_sql_migrations SET migration_id=53 WHERE migration_id=55;").unwrap();
        run_ported_migrations(&mut db).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT name FROM effect_sql_migrations WHERE migration_id=55",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "OrchestrationV2"
        );
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pragma_table_info('projection_threads') WHERE name='auto_settle_disabled_at'", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
    }
    #[test]
    fn migration_eleven_backfills_only_missing_runtime_mode() {
        let mut db = Connection::open_in_memory().unwrap();
        run_initial_migrations(&mut db).unwrap();
        let insert = "INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (?1,'thread',?1,0,'thread.created','2026-01-01','server',?2,'{}')";
        db.execute(insert, ("missing", r#"{}"#)).unwrap();
        db.execute(
            insert,
            ("existing", r#"{"runtimeMode":"approval-required"}"#),
        )
        .unwrap();
        db.execute_batch(include_str!("../migrations/011.sql"))
            .unwrap();
        let mode = |id| {
            db.query_row("SELECT json_extract(payload_json,'$.runtimeMode') FROM orchestration_events WHERE event_id=?1", [id], |r| r.get::<_,String>(0)).unwrap()
        };
        assert_eq!(mode("missing"), "full-access");
        assert_eq!(mode("existing"), "approval-required");
    }
    #[test]
    fn unbounded_run_checks_v2_history_and_preview() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL); INSERT INTO effect_sql_migrations VALUES(56,'now','Other');").unwrap();
        assert!(matches!(
            run_known_migrations(&mut db, None, |_, _, _| Ok(())),
            Err(MigrationError::SkippedV2(_))
        ));
        db.execute_batch("DELETE FROM effect_sql_migrations; INSERT INTO effect_sql_migrations VALUES(53,'now','OrchestrationV2');").unwrap();
        assert!(matches!(
            run_known_migrations(&mut db, None, |_, _, _| Ok(())),
            Err(MigrationError::PreviewReconciliationRequired)
        ));
    }
    #[test]
    fn failed_migration_rolls_back_and_retry_resumes_from_that_id() {
        let mut db = Connection::open_in_memory().unwrap();
        let failed = run_migrations(&mut db, TEST_MANIFEST, Some(2), |tx, id, _| {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS sample(value INTEGER);")?;
            if id == 2 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(())
        });
        assert!(failed.is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM effect_sql_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='sample'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let report = run_migrations(&mut db, TEST_MANIFEST, Some(2), |_, _, _| Ok(())).unwrap();
        assert_eq!(report.applied, vec![(2, "Second".into())]);
    }

    #[test]
    fn target_limit_and_v2_skip_guard_are_applied() {
        let mut db = Connection::open_in_memory().unwrap();
        let first = run_migrations(&mut db, TEST_MANIFEST, Some(2), |_, _, _| Ok(())).unwrap();
        assert_eq!(first.applied.len(), 2);

        db.execute(
            "INSERT INTO effect_sql_migrations(migration_id, created_at, name) VALUES(56, 'now', 'Future')",
            [],
        )
        .unwrap();
        let error = run_migrations(&mut db, MANIFEST, Some(89), |_, _, _| Ok(())).unwrap_err();
        assert!(matches!(error, MigrationError::SkippedV2(_)));
    }
}
