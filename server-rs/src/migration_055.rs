//! Migration 055: Orchestration V2 schema and shared application event source.
use rusqlite::{params, Connection, Transaction};
use serde_json::Value;

#[derive(Debug)]
struct LegacyEvent {
    event_id: String,
    command_id: Option<String>,
    thread_id: String,
    run_id: Option<String>,
    node_id: Option<String>,
    driver: Option<String>,
    provider_instance_id: Option<String>,
    raw_event_id: Option<String>,
    event_type: String,
    occurred_at: String,
    payload_json: String,
}

#[derive(Debug)]
struct ProjectRow {
    project_id: String,
    title: String,
    workspace_root: String,
    default_model_selection_json: Option<String>,
    scripts_json: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

/// Apply migration 055 in source order. The caller owns the transaction and
/// must insert the migration ledger row only after this succeeds.
pub fn apply_migration_055(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    apply_055_schema_before_event_source(tx)?;
    apply_055_event_source(tx)?;
    apply_055_schema_after_event_source(tx)
}

fn apply_055_schema_before_event_source(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(include_str!("../migrations/055-base.sql"))?;
    tx.execute_batch(include_str!("../migrations/055-subagents.sql"))?;
    tx.execute_batch(include_str!("../migrations/055-foundation.sql"))?;
    tx.execute_batch(include_str!(
        "../migrations/055-provider-session-bindings.sql"
    ))?;
    tx.execute_batch(include_str!(
        "../migrations/055-thread-launch-workflows.sql"
    ))?;
    Ok(())
}

fn apply_055_event_source(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(include_str!(
        "../migrations/055-application-event-source.sql"
    ))?;
    copy_legacy_v2_events(tx)?;
    baseline_projects(tx)?;
    tx.execute_batch(include_str!(
        "../migrations/055-application-event-receipts.sql"
    ))?;
    Ok(())
}

fn apply_055_schema_after_event_source(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(include_str!("../migrations/055-effect-cancellation.sql"))?;
    tx.execute_batch(include_str!("../migrations/055-scheduled-tasks.sql"))?;
    tx.execute_batch(include_str!("../migrations/055-legacy-v1-import-state.sql"))?;
    tx.execute_batch(include_str!(
        "../migrations/055-application-event-sequence-indexes.sql"
    ))?;
    tx.execute_batch(include_str!("../migrations/055-recovery-indexes.sql"))?;
    tx.execute_batch(include_str!("../migrations/055-shell-indexes.sql"))?;
    Ok(())
}

fn copy_legacy_v2_events(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let events = {
        let mut statement = tx.prepare(
            "SELECT event_id, command_id, thread_id, run_id, node_id, driver, \
                    provider_instance_id, raw_event_id, event_type, occurred_at, payload_json \
             FROM orchestration_v2_events ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LegacyEvent {
                event_id: row.get(0)?,
                command_id: row.get(1)?,
                thread_id: row.get(2)?,
                run_id: row.get(3)?,
                node_id: row.get(4)?,
                driver: row.get(5)?,
                provider_instance_id: row.get(6)?,
                raw_event_id: row.get(7)?,
                event_type: row.get(8)?,
                occurred_at: row.get(9)?,
                payload_json: row.get(10)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for event in events {
        let metadata = event_metadata(&event)?;
        let stream_version = next_stream_version(tx, "thread", &event.thread_id)?;
        tx.execute(
            "INSERT INTO orchestration_events (\
               event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, \
               command_id, causation_event_id, correlation_id, actor_kind, payload_json, \
               metadata_json, application_event_version\
             ) SELECT ?1, 'thread', ?2, ?3, ?4, ?5, ?6, NULL, ?6, ?7, ?8, ?9, 2 \
             WHERE NOT EXISTS (SELECT 1 FROM orchestration_events WHERE event_id=?1)",
            params![
                event.event_id,
                event.thread_id,
                stream_version,
                event.event_type,
                event.occurred_at,
                event.command_id,
                if event.raw_event_id.is_some() {
                    "provider"
                } else {
                    "server"
                },
                event.payload_json,
                metadata,
            ],
        )?;
    }
    Ok(())
}

fn event_metadata(event: &LegacyEvent) -> rusqlite::Result<String> {
    let mut entries = vec![("applicationEventVersion", "2".to_owned())];
    for (key, value) in [
        ("runId", event.run_id.as_deref()),
        ("nodeId", event.node_id.as_deref()),
        ("driver", event.driver.as_deref()),
        ("providerInstanceId", event.provider_instance_id.as_deref()),
        ("rawEventId", event.raw_event_id.as_deref()),
    ] {
        if let Some(value) = value {
            entries.push((key, encode_string(value)?));
        }
    }
    Ok(encode_object(&entries))
}

fn baseline_projects(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let projects = {
        let mut statement = tx.prepare(
            "SELECT project_id, title, workspace_root, default_model_selection_json, \
                    scripts_json, created_at, updated_at, deleted_at \
             FROM projection_projects ORDER BY created_at ASC, project_id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ProjectRow {
                project_id: row.get(0)?,
                title: row.get(1)?,
                workspace_root: row.get(2)?,
                default_model_selection_json: row.get(3)?,
                scripts_json: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for project in projects {
        let default_model = match project.default_model_selection_json.as_deref() {
            Some(json) => encode_json_value(json)?,
            None => "null".to_owned(),
        };
        let scripts = encode_json_value(&project.scripts_json)?;
        let created_payload = encode_object(&[
            ("projectId", encode_string(&project.project_id)?),
            ("title", encode_string(&project.title)?),
            ("workspaceRoot", encode_string(&project.workspace_root)?),
            ("defaultModelSelection", default_model),
            ("scripts", scripts),
            ("createdAt", encode_string(&project.created_at)?),
            ("updatedAt", encode_string(&project.updated_at)?),
        ]);
        let created_event_id = format!("migration:39:project:{}:baseline", project.project_id);
        let metadata = r#"{"applicationEventVersion":2,"migration":39}"#;
        let stream_version = next_stream_version(tx, "project", &project.project_id)?;
        tx.execute(
            "INSERT INTO orchestration_events (\
               event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, \
               command_id, causation_event_id, correlation_id, actor_kind, payload_json, \
               metadata_json, application_event_version\
             ) VALUES (?1, 'project', ?2, ?3, 'project.created', ?4, NULL, NULL, NULL, \
                      'server', ?5, ?6, 2)",
            params![
                created_event_id,
                project.project_id,
                stream_version,
                project.updated_at,
                created_payload,
                metadata,
            ],
        )?;

        if let Some(deleted_at) = project.deleted_at {
            let deleted_payload = encode_object(&[
                ("projectId", encode_string(&project.project_id)?),
                ("deletedAt", encode_string(&deleted_at)?),
            ]);
            let deleted_event_id = format!("migration:39:project:{}:deleted", project.project_id);
            let stream_version = next_stream_version(tx, "project", &project.project_id)?;
            tx.execute(
                "INSERT INTO orchestration_events (\
                   event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, \
                   command_id, causation_event_id, correlation_id, actor_kind, payload_json, \
                   metadata_json, application_event_version\
                 ) VALUES (?1, 'project', ?2, ?3, 'project.deleted', ?4, NULL, ?5, NULL, \
                          'server', ?6, ?7, 2)",
                params![
                    deleted_event_id,
                    project.project_id,
                    stream_version,
                    deleted_at,
                    created_event_id,
                    deleted_payload,
                    metadata,
                ],
            )?;
        }
    }
    Ok(())
}

fn next_stream_version(
    connection: &Connection,
    aggregate_kind: &str,
    stream_id: &str,
) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COALESCE(MAX(stream_version) + 1, 0) FROM orchestration_events \
         WHERE aggregate_kind=?1 AND stream_id=?2",
        params![aggregate_kind, stream_id],
        |row| row.get(0),
    )
}

fn encode_json_value(raw: &str) -> rusqlite::Result<String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    serde_json::to_string(&value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn encode_string(value: &str) -> rusqlite::Result<String> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn encode_object(entries: &[(&str, String)]) -> String {
    let body = entries
        .iter()
        .map(|(key, value)| format!("{}:{value}", serde_json::to_string(key).unwrap()))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration_history::MANIFEST;
    use crate::migrations::{run_initial_migrations, run_migrations, run_ported_migrations};
    use rusqlite::Connection;

    fn migrate_through_55(db: &mut Connection) {
        run_ported_migrations(db).unwrap();
        run_migrations(db, MANIFEST, Some(55), |tx, id, _| {
            assert_eq!(id, 55);
            apply_migration_055(tx)
        })
        .unwrap();
    }

    #[test]
    fn fresh_database_installs_full_055_schema_and_indexes() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate_through_55(&mut db);
        for object in [
            "orchestration_v2_projection_threads",
            "orchestration_v2_projection_runs",
            "orchestration_v2_projection_turn_items",
            "orchestration_v2_effect_outbox",
            "scheduled_tasks",
            "orchestration_v2_legacy_imports",
            "idx_orchestration_events_application_high_water",
            "idx_orchestration_events_application_sequence",
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name=?1",
                    [object],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                1,
                "missing schema object {object}"
            );
        }
        assert_eq!(
            db.query_row(
                "SELECT application_event_version FROM orchestration_events LIMIT 1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap_err(),
            rusqlite::Error::QueryReturnedNoRows
        );
    }

    #[test]
    fn backfills_legacy_events_projects_and_receipts_in_shared_log_order() {
        let mut db = Connection::open_in_memory().unwrap();
        run_initial_migrations(&mut db).unwrap();
        run_migrations(&mut db, MANIFEST, Some(54), |tx, id, _| match id {
            16..=49 => crate::migration_steps::apply_migration_step(tx, id),
            50 => crate::migration_050::apply_migration_050(tx),
            51..=54 => crate::migration_051_054::apply_migration_051_054(tx, id),
            _ => Err(rusqlite::Error::InvalidQuery),
        })
        .unwrap();
        run_migrations(&mut db, MANIFEST, Some(55), |tx, id, _| {
            assert_eq!(id, 55);
            apply_055_schema_before_event_source(tx)?;
            // Seed the just-created legacy V2 tables before the event-source
            // reconciliation stage so the row-wise backfill has legacy inputs.
            tx.execute(
                "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, \
                 event_type, occurred_at, actor_kind, payload_json, metadata_json) \
                 VALUES ('legacy-thread-event','thread','thread-1',0,'thread.created','2026-01-01', \
                 'server','{}','{}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO orchestration_v2_events \
                 (event_id, command_id, thread_id, run_id, node_id, provider, raw_event_id, \
                  event_type, occurred_at, payload_json) \
                 VALUES ('old-v2-event','cmd-1','thread-1','run-1','node-1','codex','raw-1', \
                         'thread.created','2026-01-02T00:00:00.000Z','{\"title\":\"hello\"}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, default_model_selection_json) \
                 VALUES ('project-1','Project','/work','[{\"name\":\"test\"}]','2026-01-01T00:00:00.000Z', \
                         '2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z','{\"provider\":\"codex\",\"model\":\"gpt\"}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO orchestration_v2_command_receipts \
                 (command_id, thread_id, command_type, accepted_at, result_sequence, status, error) \
                 VALUES ('cmd-1','thread-1','thread.create','2026-01-02T00:00:00.000Z',0,'accepted',NULL)",
                [],
            )?;
            apply_055_event_source(tx)?;
            apply_055_schema_after_event_source(tx)
        })
        .unwrap();

        let event: (i64, String, String) = db
            .query_row(
                "SELECT stream_version, actor_kind, metadata_json FROM orchestration_events WHERE event_id='old-v2-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(event.0, 1);
        assert_eq!(event.1, "provider");
        let metadata: Value = serde_json::from_str(&event.2).unwrap();
        assert_eq!(metadata["applicationEventVersion"], 2);
        assert_eq!(metadata["runId"], "run-1");
        assert_eq!(metadata["rawEventId"], "raw-1");

        let project_events: Vec<(String, i64, Option<String>, String)> = db
            .prepare(
                "SELECT event_type, stream_version, causation_event_id, payload_json \
                 FROM orchestration_events WHERE aggregate_kind='project' AND stream_id='project-1' \
                 ORDER BY stream_version",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(project_events.len(), 2);
        assert_eq!(project_events[0].0, "project.created");
        assert_eq!(project_events[1].0, "project.deleted");
        assert_eq!(
            project_events[1].2.as_deref(),
            Some("migration:39:project:project-1:baseline")
        );
        let created: Value = serde_json::from_str(&project_events[0].3).unwrap();
        assert_eq!(created["scripts"][0]["name"], "test");
        assert_eq!(created["defaultModelSelection"]["model"], "gpt");

        let receipt: (String, i64) = db
            .query_row(
                "SELECT aggregate_kind, result_sequence FROM orchestration_command_receipts WHERE command_id='cmd-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(receipt.0, "thread");
        let event_sequence: i64 = db
            .query_row(
                "SELECT sequence FROM orchestration_events WHERE event_id='old-v2-event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipt.1, event_sequence);
    }
}
