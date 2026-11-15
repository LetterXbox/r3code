//! Reconciliation for databases written by the V2 preview migration layout.
//!
//! The migration DDL is supplied by the caller. Reconciliation changes only the
//! migration ledger and runs those DDL callbacks in the same transaction.
use rusqlite::{Connection, Transaction};

const PREVIEW_NAME: &str = "OrchestrationV2";
const PR_FILES: &str = "PullRequestFilesViewed";
const AUTO_SETTLE: &str = "ProjectionThreadsAutoSettleDisabledAt";
const REDUNDANT_INDEXES: &str = "RemoveRedundantProjectionIndexes";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewMigrationError {
    Sql(String),
    UnexpectedHistory,
}

impl std::fmt::Display for PreviewMigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(message) => write!(f, "preview migration reconciliation failed: {message}"),
            Self::UnexpectedHistory => {
                write!(
                    f,
                    "Cannot upgrade V2 preview with unexpected later migrations."
                )
            }
        }
    }
}

impl std::error::Error for PreviewMigrationError {}

impl From<rusqlite::Error> for PreviewMigrationError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value.to_string())
    }
}

/// Reconcile a preview ledger in one transaction.
///
/// For preview id 53 the callback applies migration 53 before migration 54;
/// for preview id 54 it applies migration 54 only. The callback, ledger
/// renumbering, and inserted standard ledger rows all roll back together.
/// Returns `false` when there is no preview row and `true` after reconciliation.
pub fn reconcile_preview_migration<F>(
    db: &mut Connection,
    mut apply: F,
) -> Result<bool, PreviewMigrationError>
where
    F: FnMut(&Transaction<'_>, i64, &str) -> rusqlite::Result<()>,
{
    if !ledger_exists(db)? {
        return Ok(false);
    }
    let tx = db.transaction()?;
    let history = read_history(&tx)?;
    let Some((preview_id, _)) = history
        .iter()
        .find(|(id, name)| (*id == 53 || *id == 54) && name == PREVIEW_NAME)
        .cloned()
    else {
        tx.rollback()?;
        return Ok(false);
    };

    let later: Vec<_> = history.iter().filter(|(id, _)| *id >= 53).collect();
    if !valid_history(&later, preview_id) {
        return Err(PreviewMigrationError::UnexpectedHistory);
    }

    if preview_id == 53 {
        apply(&tx, 53, PR_FILES)?;
    }
    apply(&tx, 54, AUTO_SETTLE)?;

    // Free id 55 before moving the preview's OrchestrationV2 row into it.
    tx.execute(
        "UPDATE effect_sql_migrations SET migration_id=56 \
         WHERE migration_id=55 AND name=?1",
        [REDUNDANT_INDEXES],
    )?;
    tx.execute(
        "UPDATE effect_sql_migrations SET migration_id=55 \
         WHERE migration_id=?1 AND name=?2",
        (preview_id, PREVIEW_NAME),
    )?;

    if preview_id == 53 {
        insert_if_missing(&tx, 53, PR_FILES)?;
    }
    insert_if_missing(&tx, 54, AUTO_SETTLE)?;
    tx.commit()?;
    Ok(true)
}

fn valid_history(later: &[&(i64, String)], preview_id: i64) -> bool {
    later.iter().all(|(id, name)| {
        if *id == preview_id && name == PREVIEW_NAME {
            return true;
        }
        match preview_id {
            53 => false,
            54 => (*id == 53 && name == PR_FILES) || (*id == 55 && name == REDUNDANT_INDEXES),
            _ => false,
        }
    })
}

fn ledger_exists(db: &Connection) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='effect_sql_migrations')",
        [],
        |row| row.get(0),
    )
}

fn read_history(db: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut statement =
        db.prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

fn insert_if_missing(tx: &Transaction<'_>, id: i64, name: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO effect_sql_migrations (migration_id, created_at, name) \
         SELECT ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?2 \
         WHERE NOT EXISTS (SELECT 1 FROM effect_sql_migrations WHERE migration_id=?1)",
        (id, name),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with_rows(rows: &[(i64, &str)]) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL);",
        )
        .unwrap();
        for (id, name) in rows {
            db.execute(
                "INSERT INTO effect_sql_migrations VALUES (?1, 'old', ?2)",
                (*id, *name),
            )
            .unwrap();
        }
        db
    }

    fn rows(db: &Connection) -> Vec<(i64, String)> {
        read_history(db).unwrap()
    }

    #[test]
    fn reconciles_preview_at_53_and_preserves_import_progress_tables() {
        let mut db = db_with_rows(&[(52, "Prior"), (53, PREVIEW_NAME)]);
        db.execute_batch("CREATE TABLE orchestration_v2_legacy_imports(thread_id TEXT);")
            .unwrap();
        let called = std::cell::RefCell::new(Vec::new());
        assert!(reconcile_preview_migration(&mut db, |tx, id, name| {
            called.borrow_mut().push((id, name.to_owned()));
            tx.execute_batch("CREATE TABLE IF NOT EXISTS preview_ddl(id INTEGER);")
        })
        .unwrap());
        assert_eq!(
            *called.borrow(),
            vec![(53, PR_FILES.into()), (54, AUTO_SETTLE.into())]
        );
        assert_eq!(
            rows(&db),
            vec![
                (52, "Prior".into()),
                (53, PR_FILES.into()),
                (54, AUTO_SETTLE.into()),
                (55, PREVIEW_NAME.into())
            ]
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_legacy_imports",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn renumbers_valid_preview_54_and_optional_55_row() {
        let mut db = db_with_rows(&[(53, PR_FILES), (54, PREVIEW_NAME), (55, REDUNDANT_INDEXES)]);
        let called = std::cell::RefCell::new(Vec::new());
        reconcile_preview_migration(&mut db, |_, id, name| {
            called.borrow_mut().push((id, name.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(*called.borrow(), vec![(54, AUTO_SETTLE.into())]);
        assert_eq!(
            rows(&db),
            vec![
                (53, PR_FILES.into()),
                (54, AUTO_SETTLE.into()),
                (55, PREVIEW_NAME.into()),
                (56, REDUNDANT_INDEXES.into())
            ]
        );
    }

    #[test]
    fn unexpected_history_and_ddl_failure_leave_database_unchanged() {
        let mut unexpected = db_with_rows(&[(53, PREVIEW_NAME), (57, "TooNew")]);
        assert_eq!(
            reconcile_preview_migration(&mut unexpected, |_, _, _| Ok(())).unwrap_err(),
            PreviewMigrationError::UnexpectedHistory
        );
        assert_eq!(
            rows(&unexpected),
            vec![(53, PREVIEW_NAME.into()), (57, "TooNew".into())]
        );

        let mut failed = db_with_rows(&[(53, PREVIEW_NAME), (55, REDUNDANT_INDEXES)]);
        let result = reconcile_preview_migration(&mut failed, |tx, _, _| {
            tx.execute_batch("CREATE TABLE partial_preview_ddl(id INTEGER);")?;
            Err(rusqlite::Error::InvalidQuery)
        });
        assert!(result.is_err());
        assert_eq!(
            rows(&failed),
            vec![(53, PREVIEW_NAME.into()), (55, REDUNDANT_INDEXES.into())]
        );
        assert_eq!(
            failed
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name='partial_preview_ddl'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
