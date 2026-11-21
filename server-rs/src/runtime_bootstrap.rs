//! Persistent resources needed before an authenticated HTTP application can be built.
use crate::{
    database, migrations,
    runtime::{load_or_create_environment_id, EnvironmentIdError, ServerPaths},
    signing_key::{load_or_create_server_signing_key, SigningKeyError},
};
use rusqlite::Connection;
use std::fmt;

#[derive(Debug)]
pub enum RuntimeBootstrapError {
    Database(rusqlite::Error),
    LegacySnapshot(crate::legacy_database_snapshot::V2DatabaseImportError),
    Migration(migrations::MigrationError),
    EnvironmentId(EnvironmentIdError),
    SigningKey(SigningKeyError),
}

impl fmt::Display for RuntimeBootstrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(f, "opening the server database failed: {error}"),
            Self::LegacySnapshot(error) => write!(f, "legacy database snapshot failed: {error}"),
            Self::Migration(error) => write!(f, "server database migration failed: {error}"),
            Self::EnvironmentId(error) => {
                write!(f, "loading the server environment id failed: {error}")
            }
            Self::SigningKey(error) => write!(f, "loading the server signing key failed: {error}"),
        }
    }
}

impl std::error::Error for RuntimeBootstrapError {}

/// Initialized database and stable identity. Startup ordering is deliberate:
/// migrations finish before auth state is exposed to HTTP handlers.
pub struct RuntimePersistence {
    pub db: Connection,
    pub environment_id: String,
    pub signing_key: [u8; 32],
    pub migrations: migrations::MigrationReport,
}

pub fn initialize_persistence(
    paths: &ServerPaths,
) -> Result<RuntimePersistence, RuntimeBootstrapError> {
    crate::legacy_database_snapshot::initialize_v2_database(&paths.db_path)
        .map_err(RuntimeBootstrapError::LegacySnapshot)?;
    let mut db = database::open_writer(&paths.db_path).map_err(RuntimeBootstrapError::Database)?;
    let migrations =
        migrations::run_ported_migrations(&mut db).map_err(RuntimeBootstrapError::Migration)?;
    {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(RuntimeBootstrapError::Database)?;
        crate::event_store::repair_turn_item_positions(&tx)
            .map_err(RuntimeBootstrapError::Database)?;
        tx.commit().map_err(RuntimeBootstrapError::Database)?;
    }
    let environment_id = load_or_create_environment_id(&paths.state_dir)
        .map_err(RuntimeBootstrapError::EnvironmentId)?;
    let signing_key = load_or_create_server_signing_key(&paths.secrets_dir)
        .map_err(RuntimeBootstrapError::SigningKey)?;
    Ok(RuntimePersistence {
        db,
        environment_id,
        signing_key,
        migrations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn snapshots_v1_before_migrating_and_preserves_source() {
        let root = std::env::temp_dir().join(format!("t3-legacy-bootstrap-{}", Uuid::new_v4()));
        let paths = ServerPaths::new(root.clone(), false, false, None);
        paths.ensure_directories(&root).unwrap();
        let source = paths.state_dir.join("state.sqlite");
        let mut old = Connection::open(&source).unwrap();
        migrations::run_initial_migrations(&mut old).unwrap();
        migrations::run_known_migrations(&mut old, Some(54), |tx, id, _| match id {
            16..=49 => crate::migration_steps::apply_migration_step(tx, id),
            50 => crate::migration_050::apply_migration_050(tx),
            51..=54 => crate::migration_051_054::apply_migration_051_054(tx, id),
            _ => Err(rusqlite::Error::InvalidQuery),
        })
        .unwrap();
        old.execute("INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES('v1','p','Legacy',NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[]).unwrap();
        old.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES('old','v1','user','legacy message',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[]).unwrap();
        drop(old);
        let bytes = std::fs::read(&source).unwrap();
        let runtime = initialize_persistence(&paths).unwrap();
        let title: String = runtime
            .db
            .query_row(
                "SELECT title FROM projection_threads WHERE thread_id='v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "Legacy");
        assert_eq!(runtime.migrations.applied.last().unwrap().0, 102);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        let bus = crate::event_bus::EventBus::new(
            crate::database::open_writer(&paths.db_path).unwrap(),
            16,
        );
        let counts = crate::legacy_shells::reconcile_shells(&bus).unwrap();
        assert_eq!(counts.imported_thread_count, 1);
        let (_, projection) = bus.thread_snapshot("v1").unwrap().unwrap();
        assert_eq!(projection["thread"]["historyOrigin"], "v1_import");
        assert_eq!(projection["messages"][0]["text"], "legacy message");
        let command = crate::message_commands::DispatchMessage {
            context: None,
            command_id: "new-message",
            thread_id: "v1",
            message_id: "new",
            text: "continue",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        let result = crate::message_commands::dispatch_message_with_mode(
            &bus,
            command,
            "2026-01-02T00:00:00Z",
            false,
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx| { let handoff:String=tx.query_row("SELECT json_extract(payload_json,'$.summaryText') FROM orchestration_v2_projection_context_handoffs WHERE thread_id='v1'",[],|r|r.get(0))?; assert!(handoff.contains("legacy message")); Ok(((),vec![])) }).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        drop(bus);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn initializes_full_schema_and_reuses_stable_auth_identity() {
        let root = std::env::temp_dir().join(format!("t3-runtime-bootstrap-{}", Uuid::new_v4()));
        let paths = ServerPaths::new(root.clone(), false, false, None);
        paths.ensure_directories(&root).unwrap();
        let first = initialize_persistence(&paths).unwrap();
        assert_eq!(first.migrations.applied.last().unwrap().0, 102);
        assert_eq!(
            first
                .db
                .query_row(
                    "SELECT max(migration_id) FROM effect_sql_migrations",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            102
        );
        let environment_id = first.environment_id.clone();
        let signing_key = first.signing_key;
        drop(first);

        let second = initialize_persistence(&paths).unwrap();
        assert!(second.migrations.applied.is_empty());
        assert_eq!(second.environment_id, environment_id);
        assert_eq!(second.signing_key, signing_key);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
}
