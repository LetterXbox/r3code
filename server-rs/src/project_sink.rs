//! Atomic project event, projection and receipt commits.
//! The ordered entry points publish committed events through the shared EventBus.
use crate::project_commands::{plan_create, CreateProject};
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt, StoredEvent},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

#[derive(Debug)]
pub enum ProjectCommitError {
    Database(rusqlite::Error),
    CommandIdUsedByThread,
    CommandIdConflict {
        command_id: String,
        command_type: String,
        project_id: String,
    },
    InvalidEvent,
    Bus(BusError),
}
impl From<BusError> for ProjectCommitError {
    fn from(e: BusError) -> Self {
        Self::Bus(e)
    }
}
impl From<rusqlite::Error> for ProjectCommitError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
impl std::fmt::Display for ProjectCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CommandIdConflict {
                command_id,
                command_type,
                project_id,
            } => write!(
                f,
                "Command {command_id} was already used by {command_type} for {project_id}."
            ),
            _ => write!(f, "{self:?}"),
        }
    }
}
impl std::error::Error for ProjectCommitError {}

#[derive(Debug, PartialEq)]
pub struct CommitResult {
    pub receipt: Receipt,
    pub committed: bool,
}

/// Run project-create guards and commit its event, projection and receipt in
/// one serialized write transaction. Rejections are persisted as receipts so
/// retries return the original deterministic result.
pub fn create_project_ordered(
    bus: &EventBus,
    command: CreateProject<'_>,
    event_id: &str,
    now: &str,
) -> Result<CommitResult, ProjectCommitError> {
    bus.commit_with(|tx| {
        let command_id = command.command_id;
        let project_id = command.project_id;
        if let Some(receipt) = event_store::get_receipt(tx, command.command_id, "project")? {
            if receipt.aggregate_id != project_id || receipt.command_type != "project.create" {
                return Err(ProjectCommitError::CommandIdConflict { command_id: command_id.into(), command_type: receipt.command_type, project_id: receipt.aggregate_id });
            }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let exists = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM projection_projects WHERE project_id=?1)",
            [command.project_id],
            |row| row.get::<_, bool>(0),
        )?;
        let workspace_owner: Option<String> = tx
            .query_row(
                "SELECT project_id FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL LIMIT 1",
                [command.workspace_root],
                |row| row.get(0),
            )
            .optional()?;
        let event = match plan_create(
            command,
            event_id,
            now,
            exists,
            workspace_owner.as_deref(),
        ) {
            Ok(event) => event,
            Err(rejection) => {
                let receipt = commit_rejected_tx(
                    tx,
                    command_id,
                    project_id,
                    "project.create",
                    now,
                    &rejection.to_string(),
                )?;
                return Ok((CommitResult { receipt, committed: false }, vec![]));
            }
        };
        commit_project_event_tx(tx, &event, "project.create", now)
    })
}

/// Commit a previously planned project event. Project locks/guards must be held
/// through planning and this transaction; publication happens only after commit.
pub fn commit_project_event(
    db: &mut Connection,
    event: &Event,
    command_type: &str,
    accepted_at: &str,
) -> Result<CommitResult, ProjectCommitError> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (result, _) = commit_project_event_tx(&tx, event, command_type, accepted_at)?;
    tx.commit()?;
    Ok(result)
}

/// Commit through the shared bus so projection, receipt, and event are atomic
/// and the event is published in commit order. All writers must use this bus.
pub fn commit_project_event_ordered(
    bus: &EventBus,
    event: &Event,
    command_type: &str,
    accepted_at: &str,
) -> Result<CommitResult, ProjectCommitError> {
    bus.commit_with(|tx| commit_project_event_tx(tx, event, command_type, accepted_at))
}

pub fn commit_project_event_tx(
    tx: &Transaction<'_>,
    event: &Event,
    command_type: &str,
    accepted_at: &str,
) -> Result<(CommitResult, Vec<StoredEvent>), ProjectCommitError> {
    if event.aggregate_kind != "project"
        || event.command_id.is_none()
        || !matches!(
            event.event_type.as_str(),
            "project.created" | "project.deleted"
        )
    {
        return Err(ProjectCommitError::InvalidEvent);
    }
    let command_id = event
        .command_id
        .as_deref()
        .ok_or(ProjectCommitError::InvalidEvent)?;
    let payload = event
        .payload
        .as_object()
        .ok_or(ProjectCommitError::InvalidEvent)?;
    if payload.get("projectId").and_then(|v| v.as_str()) != Some(event.stream_id.as_str()) {
        return Err(ProjectCommitError::InvalidEvent);
    }
    let mut receipt = Receipt {
        command_id: command_id.into(),
        aggregate_kind: "project".into(),
        aggregate_id: event.stream_id.clone(),
        command_type: command_type.into(),
        accepted_at: accepted_at.into(),
        result_sequence: 0,
        status: "accepted".into(),
        error: None,
    };
    if !event_store::insert_receipt_if_absent(tx, &receipt)? {
        let existing = event_store::get_receipt(tx, command_id, "project")?;
        return match existing {
            Some(receipt) => Ok((
                CommitResult {
                    receipt,
                    committed: false,
                },
                vec![],
            )),
            None => Err(ProjectCommitError::CommandIdUsedByThread),
        };
    }
    let stored = event_store::append(tx, std::slice::from_ref(event))?;
    match event.event_type.as_str() {
        "project.created" => {
            let text = |key| {
                payload
                    .get(key)
                    .and_then(|v| v.as_str())
                    .ok_or(ProjectCommitError::InvalidEvent)
            };
            let scripts = payload
                .get("scripts")
                .filter(|v| v.is_array())
                .ok_or(ProjectCommitError::InvalidEvent)?
                .to_string();
            let selection = payload
                .get("defaultModelSelection")
                .filter(|v| !v.is_null())
                .map(|v| v.to_string());
            tx.execute("INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at,default_model_selection_json,favicon_path,project_icon_json,auto_pull) VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,NULL,NULL,0)",params![event.stream_id,text("title")?,text("workspaceRoot")?,scripts,text("createdAt")?,text("updatedAt")?,selection])?;
        }
        "project.deleted" => {
            let deleted_at = payload
                .get("deletedAt")
                .and_then(|v| v.as_str())
                .ok_or(ProjectCommitError::InvalidEvent)?;
            let exists: Option<String> = tx
                .query_row(
                    "SELECT project_id FROM projection_projects WHERE project_id=?1",
                    [&event.stream_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                tx.execute("UPDATE projection_projects SET deleted_at=?2,updated_at=?2 WHERE project_id=?1",params![event.stream_id,deleted_at])?;
            }
        }
        _ => unreachable!(),
    }
    receipt.result_sequence = stored[0].sequence;
    event_store::upsert_receipt(tx, &receipt)?;
    Ok((
        CommitResult {
            receipt,
            committed: true,
        },
        stored,
    ))
}

/// Record a deterministic rejection at the current application cursor. A retry
/// returns the original receipt without replacing its error or sequence.
pub fn commit_rejected_project_command(
    db: &mut Connection,
    command_id: &str,
    project_id: &str,
    command_type: &str,
    rejected_at: &str,
    error: &str,
) -> Result<Receipt, ProjectCommitError> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let receipt = commit_rejected_tx(
        &tx,
        command_id,
        project_id,
        command_type,
        rejected_at,
        error,
    )?;
    tx.commit()?;
    Ok(receipt)
}

pub fn commit_rejected_project_command_ordered(
    bus: &EventBus,
    command_id: &str,
    project_id: &str,
    command_type: &str,
    rejected_at: &str,
    error: &str,
) -> Result<Receipt, ProjectCommitError> {
    bus.commit_with(|tx| {
        Ok((
            commit_rejected_tx(tx, command_id, project_id, command_type, rejected_at, error)?,
            vec![],
        ))
    })
}
fn commit_rejected_tx(
    tx: &Transaction<'_>,
    command_id: &str,
    project_id: &str,
    command_type: &str,
    rejected_at: &str,
    error: &str,
) -> Result<Receipt, ProjectCommitError> {
    let receipt = Receipt {
        command_id: command_id.into(),
        aggregate_kind: "project".into(),
        aggregate_id: project_id.into(),
        command_type: command_type.into(),
        accepted_at: rejected_at.into(),
        result_sequence: event_store::latest_application_sequence(tx)?,
        status: "rejected".into(),
        error: Some(error.into()),
    };
    if event_store::insert_receipt_if_absent(tx, &receipt)? {
        Ok(receipt)
    } else {
        event_store::get_receipt(tx, command_id, "project")?
            .ok_or(ProjectCommitError::CommandIdUsedByThread)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_commands::{plan_create, CreateProject};

    #[test]
    fn guarded_create_commits_or_persists_the_first_rejection() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let create = |command_id, project_id| CreateProject {
            command_id,
            project_id,
            title: "Project",
            workspace_root: "/work",
            scripts: None,
        };
        let accepted = create_project_ordered(
            &bus,
            create("create", "p1"),
            "event-1",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert!(accepted.committed);
        assert_eq!(accepted.receipt.status, "accepted");
        assert_eq!(accepted.receipt.result_sequence, 1);

        let replay =
            create_project_ordered(&bus, create("create", "p1"), "unused-event", "later").unwrap();
        assert!(!replay.committed);
        assert_eq!(replay.receipt, accepted.receipt);

        let collision =
            create_project_ordered(&bus, create("create", "other"), "unused", "later").unwrap_err();
        assert_eq!(
            collision.to_string(),
            "Command create was already used by project.create for p1."
        );

        let rejected = create_project_ordered(
            &bus,
            create("conflict", "p2"),
            "unused-event-2",
            "2026-01-02T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(rejected.receipt.status, "rejected");
        assert_eq!(rejected.receipt.result_sequence, 1);
        assert_eq!(
            rejected.receipt.error.as_deref(),
            Some("Active project 'p1' already exists for workspace root '/work'.")
        );
        let rejected_replay = create_project_ordered(
            &bus,
            CreateProject {
                command_id: "conflict",
                project_id: "p2",
                title: "Changed",
                workspace_root: "/different",
                scripts: None,
            },
            "unused-event-3",
            "later",
        )
        .unwrap();
        assert_eq!(rejected_replay.receipt, rejected.receipt);
        let totals = bus
            .commit(|tx| {
                let events =
                    tx.query_row("SELECT COUNT(*) FROM orchestration_events", [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                let receipts = tx.query_row(
                    "SELECT COUNT(*) FROM orchestration_command_receipts",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(((events, receipts), vec![]))
            })
            .unwrap();
        assert_eq!(totals, (1, 2));
    }

    #[test]
    fn project_commit_is_atomic_and_replays_receipt() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let event = plan_create(
            CreateProject {
                command_id: "cmd",
                project_id: "p",
                title: "Project",
                workspace_root: "/work",
                scripts: None,
            },
            "event",
            "2026-01-01T00:00:00.000Z",
            false,
            None,
        )
        .unwrap();
        let result =
            commit_project_event(&mut db, &event, "project.create", &event.occurred_at).unwrap();
        assert!(result.committed);
        assert_eq!(result.receipt.result_sequence, 1);
        let rejected = commit_rejected_project_command(
            &mut db,
            "rejected",
            "p",
            "project.delete",
            "now",
            "reason",
        )
        .unwrap();
        assert_eq!(rejected.result_sequence, 1);
        assert_eq!(rejected.status, "rejected");
        assert_eq!(
            commit_rejected_project_command(
                &mut db,
                "rejected",
                "p",
                "project.delete",
                "later",
                "different"
            )
            .unwrap(),
            rejected
        );
        assert!(
            !commit_project_event(&mut db, &event, "project.create", &event.occurred_at)
                .unwrap()
                .committed
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM orchestration_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let mut bad = event.clone();
        bad.id = "second".into();
        bad.command_id = Some("second".into());
        assert!(commit_project_event(&mut db, &bad, "project.create", &event.occurred_at).is_err());
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM orchestration_command_receipts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM orchestration_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[tokio::test]
    async fn ordered_project_commits_publish_after_atomic_commit_and_only_once() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 64);
        let (cursor, mut receiver) = bus.subscribe_application().unwrap();
        assert_eq!(cursor, 0);
        let mut workers = Vec::new();
        for n in 0..16 {
            let bus = bus.clone();
            workers.push(std::thread::spawn(move || {
                let id = format!("p{n}");
                let command = format!("c{n}");
                let event_id = format!("e{n}");
                let event = plan_create(
                    CreateProject {
                        command_id: &command,
                        project_id: &id,
                        title: "P",
                        workspace_root: "/work",
                        scripts: None,
                    },
                    &event_id,
                    "2026-01-01T00:00:00.000Z",
                    false,
                    None,
                )
                .unwrap();
                assert!(
                    commit_project_event_ordered(
                        &bus,
                        &event,
                        "project.create",
                        &event.occurred_at
                    )
                    .unwrap()
                    .committed
                );
                assert!(
                    !commit_project_event_ordered(
                        &bus,
                        &event,
                        "project.create",
                        &event.occurred_at
                    )
                    .unwrap()
                    .committed
                );
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        for sequence in 1..=16 {
            let event = receiver.recv().await.unwrap();
            assert_eq!(event.sequence, sequence);
            assert_eq!(event.event.aggregate_kind, "project");
            let (projection, receipt): (i64, i64) = bus
                .commit(|tx| {
                    let p = tx.query_row(
                        "SELECT count(*) FROM projection_projects WHERE project_id=?1",
                        [&event.event.stream_id],
                        |r| r.get(0),
                    )?;
                    let r = tx.query_row(
                        "SELECT count(*) FROM orchestration_command_receipts WHERE command_id=?1",
                        [&event.event.command_id],
                        |r| r.get(0),
                    )?;
                    Ok(((p, r), vec![]))
                })
                .unwrap();
            assert_eq!((projection, receipt), (1, 1));
        }
        assert!(receiver.try_recv().is_err());
        let rejected = commit_rejected_project_command_ordered(
            &bus,
            "bad",
            "p",
            "project.delete",
            "now",
            "bad",
        )
        .unwrap();
        assert_eq!(rejected.result_sequence, 16);
        assert!(receiver.try_recv().is_err());
    }
}
