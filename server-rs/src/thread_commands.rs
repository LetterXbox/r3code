//! Atomic creation of V2 threads. Inputs must already be schema-validated and
//! creation provenance must be supplied by the trusted caller.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
};
use rusqlite::params;
use serde_json::{json, Value};

pub struct CreateThread<'a> {
    pub command_id: &'a str,
    pub thread_id: &'a str,
    pub project_id: &'a str,
    pub title: &'a str,
    pub model_selection: &'a Value,
    pub runtime_mode: &'a str,
    pub interaction_mode: &'a str,
    pub branch: Option<&'a str>,
    pub worktree_path: Option<&'a str>,
    pub created_by: &'a str,
    pub creation_source: &'a Value,
    pub link_origin: Option<&'a Value>,
    pub delegated_from: Option<&'a Value>,
}

#[derive(Debug)]
pub enum ThreadCommitError {
    Database(rusqlite::Error),
    Bus(BusError),
    CommandIdUsedByProject,
    InvalidModelSelection,
}
impl From<rusqlite::Error> for ThreadCommitError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
impl From<BusError> for ThreadCommitError {
    fn from(e: BusError) -> Self {
        Self::Bus(e)
    }
}
impl std::fmt::Display for ThreadCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ThreadCommitError {}

#[derive(Debug, PartialEq)]
pub struct CommitResult {
    pub receipt: Receipt,
    pub committed: bool,
}

/// Uses the bus transaction for guards, event, projection and receipt, and
/// publishes only after commit. Tombstoned thread IDs remain reserved.
pub fn create_thread_ordered(
    bus: &EventBus,
    command: CreateThread<'_>,
    event_id: &str,
    now: &str,
) -> Result<CommitResult, ThreadCommitError> {
    create_thread_with_import(bus, command, event_id, now, None)
}

pub fn create_thread_with_import(
    bus: &EventBus,
    command: CreateThread<'_>,
    event_id: &str,
    now: &str,
    imported: Option<&Value>,
) -> Result<CommitResult, ThreadCommitError> {
    bus.commit_with(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command.command_id, "thread")? {
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1)", [command.thread_id], |r| r.get(0))?;
        let mut receipt = Receipt { command_id: command.command_id.into(), aggregate_kind: "thread".into(), aggregate_id: command.thread_id.into(), command_type: "thread.create".into(), accepted_at: now.into(), result_sequence: event_store::latest_application_sequence(tx)?, status: if exists { "rejected" } else { "accepted" }.into(), error: exists.then(|| format!("Thread {} already exists. Use a new thread id.", command.thread_id)) };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? {
            return Err(ThreadCommitError::CommandIdUsedByProject);
        }
        if exists { return Ok((CommitResult { receipt, committed: false }, vec![])); }
        let provider = command.model_selection.get("instanceId").and_then(Value::as_str).ok_or(ThreadCommitError::InvalidModelSelection)?;
        let mut payload = json!({"createdBy":command.created_by,"creationSource":command.creation_source,"id":command.thread_id,"projectId":command.project_id,"title":command.title,"providerInstanceId":provider,"modelSelection":command.model_selection,"runtimeMode":command.runtime_mode,"interactionMode":command.interaction_mode,"branch":command.branch,"worktreePath":command.worktree_path,"activeProviderThreadId":null,"pullRequests":[],"lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":command.thread_id},"forkedFrom":null,"createdAt":now,"updatedAt":now,"archivedAt":null,"settledOverride":null,"settledAt":null,"snoozedUntil":null,"snoozedAt":null,"lastVisitedAt":null,"deletedAt":null});
        if let Some(origin) = command.link_origin {
            payload["linkOrigin"] = origin.clone();
            if let Some(parent) = command.delegated_from { payload["delegatedFrom"] = parent.clone(); }
        }
        let event = Event { id:event_id.into(), aggregate_kind:"thread".into(), stream_id:command.thread_id.into(), event_type:"thread.created".into(), occurred_at:now.into(), command_id:Some(command.command_id.into()), causation_event_id:None, correlation_id:Some(command.command_id.into()), actor_kind: if command.command_id.starts_with("provider:") {"provider"} else if command.command_id.starts_with("server:") {"server"} else {"client"}.into(), payload, metadata:json!({}) };
        let mut events = vec![event.clone()];
        if let Some(imported) = imported {
            let reference = &imported["ref"];
            let driver = reference["driver"].as_str().ok_or(ThreadCommitError::InvalidModelSelection)?;
            let native = reference["nativeId"].as_str().ok_or(ThreadCommitError::InvalidModelSelection)?;
            let id = format!("provider-thread:provider:{}:provider-instance:{}:native-thread:{}", crate::message_commands::encode_id_part(driver), crate::message_commands::encode_id_part(provider), crate::message_commands::encode_id_part(native));
            let pt = json!({"id":id,"driver":driver,"providerInstanceId":provider,"providerSessionId":null,"appThreadId":command.thread_id,"ownerNodeId":null,"nativeThreadRef":reference,"nativeConversationHeadRef":null,"status":"not_loaded","firstRunOrdinal":null,"lastRunOrdinal":null,"handoffIds":[],"forkedFrom":null,"pendingBackgroundTasks":[],"contextUsage":null,"nativeMetadata":imported.get("metadata").cloned().unwrap_or(Value::Null),"goal":null,"createdAt":now,"updatedAt":now});
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES (?1,?2,NULL,?3,?4,NULL,'not_loaded',NULL,NULL,?5,?6)", params![id,command.thread_id,driver,provider,now,pt.to_string()])?;
            events.push(Event { id:uuid::Uuid::new_v4().to_string(), event_type:"provider-thread.updated".into(), payload:pt, ..event.clone() });
        }
        let stored = event_store::append(tx, &events)?;
        tx.execute("INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES (?1,?2,?3,?4,?4,?5,?6,NULL,?7,?7,NULL,NULL,?8)", params![command.thread_id,command.project_id,command.title,provider,command.runtime_mode,command.interaction_mode,now,event.payload.to_string()])?;
        receipt.result_sequence = stored.last().unwrap().sequence;
        event_store::upsert_receipt(tx, &receipt)?;
        Ok((CommitResult { receipt, committed: true }, stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_native_thread_is_created_atomically_and_replays() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let imported = json!({"ref":{"driver":"codex","nativeId":"native/1","strength":"strong"},"metadata":{"title":"Imported"}});
        let cmd = || CreateThread {
            command_id: "import",
            thread_id: "t",
            project_id: "p",
            title: "Title",
            model_selection: &selection,
            runtime_mode: "full-access",
            interaction_mode: "default",
            branch: None,
            worktree_path: None,
            created_by: "user",
            creation_source: &source,
            link_origin: None,
            delegated_from: None,
        };
        let first = create_thread_with_import(
            &bus,
            cmd(),
            "event",
            "2026-01-01T00:00:00.000Z",
            Some(&imported),
        )
        .unwrap();
        assert_eq!(first.receipt.result_sequence, 2);
        assert!(
            !create_thread_with_import(&bus, cmd(), "again", "later", Some(&imported))
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            let (id, raw): (String,String) = tx.query_row("SELECT provider_thread_id,payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(id,"provider-thread:provider:codex:provider-instance:codex:native-thread:native%2F1");
            let payload: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(payload["nativeThreadRef"],imported["ref"]);
            assert_eq!(payload["nativeMetadata"],imported["metadata"]);
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_events",[],|r|r.get::<_,i64>(0))?,2);
            Ok(((),vec![]))
        }).unwrap();
        let sent = crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert_eq!(sent.receipt.status, "accepted");
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|r.get(0))?;
            let pt: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(pt["nativeThreadRef"],imported["ref"]);
            assert_eq!(pt["firstRunOrdinal"],1);
            assert!(pt["providerSessionId"].is_string());
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|r.get::<_,i64>(0))?,1);
            Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn create_is_atomic_replayable_and_reserves_deleted_ids() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let cmd = |id| CreateThread {
            command_id: id,
            thread_id: "t",
            project_id: "p",
            title: "Title",
            model_selection: &selection,
            runtime_mode: "full-access",
            interaction_mode: "default",
            branch: None,
            worktree_path: None,
            created_by: "user",
            creation_source: &source,
            link_origin: None,
            delegated_from: None,
        };
        let first = create_thread_ordered(&bus, cmd("c"), "e", "2026-01-01T00:00:00.000Z").unwrap();
        assert!(first.committed);
        assert_eq!(first.receipt.result_sequence, 1);
        assert_eq!(
            create_thread_ordered(&bus, cmd("c"), "different", "later")
                .unwrap()
                .receipt,
            first.receipt
        );
        bus.commit(|tx| {
            tx.execute(
                "UPDATE orchestration_v2_projection_threads SET deleted_at='x' WHERE thread_id='t'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        let rejected = create_thread_ordered(&bus, cmd("other"), "e2", "later").unwrap();
        assert_eq!(
            rejected.receipt.error.as_deref(),
            Some("Thread t already exists. Use a new thread id.")
        );
        assert_eq!(rejected.receipt.result_sequence, 1);
        bus.commit(|tx| {
            let payload: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["lineage"]["rootThreadId"], "t");
            assert_eq!(payload["providerInstanceId"], "codex");
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM orchestration_events", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
