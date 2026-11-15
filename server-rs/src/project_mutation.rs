//! Project deletion with durable child-thread cleanup.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Receipt},
    project_commands::plan_delete,
    project_sink::{self, ProjectCommitError},
};
use rusqlite::OptionalExtension;

#[derive(Debug)]
pub enum DeleteError {
    Commit(ProjectCommitError),
    NotFound(String),
    NotEmpty(String),
    ChildCommandConflict,
    ProjectCommandConflict,
}
impl From<ProjectCommitError> for DeleteError {
    fn from(e: ProjectCommitError) -> Self {
        Self::Commit(e)
    }
}
impl From<BusError> for DeleteError {
    fn from(e: BusError) -> Self {
        Self::Commit(e.into())
    }
}
impl From<rusqlite::Error> for DeleteError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Commit(e.into())
    }
}
impl std::fmt::Display for DeleteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "Project {id} was not found."),
            Self::NotEmpty(id) => write!(f, "Project {id} is not empty."),
            Self::ProjectCommandConflict => write!(
                f,
                "The project deletion command ID belongs to a different command."
            ),
            Self::ChildCommandConflict => write!(
                f,
                "The thread deletion command ID belongs to a different command."
            ),
            Self::Commit(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for DeleteError {}

/// Information needed for best-effort service cleanup after a successful deletion.
#[derive(Debug)]
pub struct DeleteOutcome {
    pub receipt: Receipt,
    /// Present only for the first successful deletion, not a receipt replay.
    pub deleted_workspace_root: Option<String>,
}

/// Delete active child threads, enqueue their cleanup and tombstone the project.
/// A single transaction makes the cascade and its receipts replay-safe.
pub fn delete(
    bus: &EventBus,
    command_id: &str,
    project_id: &str,
    force: bool,
    now: &str,
) -> Result<Receipt, DeleteError> {
    Ok(delete_with_outcome(bus, command_id, project_id, force, now)?.receipt)
}

/// Delete a project and return its workspace root when this call performed the deletion.
/// Callers can use the root to invalidate enrichment and clear settings overrides after commit.
pub fn delete_with_outcome(
    bus: &EventBus,
    command_id: &str,
    project_id: &str,
    force: bool,
    now: &str,
) -> Result<DeleteOutcome, DeleteError> {
    bus.commit_with(|tx| {
  if let Some(receipt) = event_store::get_receipt(tx, command_id, "project")? {
   if receipt.aggregate_id != project_id || receipt.command_type != "project.delete" { return Err(DeleteError::ProjectCommandConflict); }
   return Ok((DeleteOutcome { receipt, deleted_workspace_root: None }, vec![]));
  }
  let row: Option<(Option<String>, String)> = tx.query_row("SELECT deleted_at, workspace_root FROM projection_projects WHERE project_id=?1", [project_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
  let Some((deleted, workspace_root)) = row else { return Err(DeleteError::NotFound(project_id.into())); };
  if deleted.is_some() { return Err(DeleteError::NotFound(project_id.into())); }
  let mut stmt = tx.prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id=?1 AND deleted_at IS NULL ORDER BY created_at DESC, thread_id")?;
  let children = stmt.query_map([project_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
  drop(stmt);
  if !children.is_empty() && !force { return Err(DeleteError::NotEmpty(project_id.into())); }
  let mut events = Vec::new();
  for id in children {
   let cmd = format!("{command_id}:delete-thread:{id}");
   if let Some(existing) = event_store::get_receipt(tx, &cmd, "thread")? {
    if existing.aggregate_id != id || existing.command_type != "thread.delete" || existing.status != "accepted" { return Err(DeleteError::ChildCommandConflict); }
    continue;
   }
   let receipt = Receipt { command_id: cmd.clone(), aggregate_kind: "thread".into(), aggregate_id: id.clone(), command_type: "thread.delete".into(), accepted_at: now.into(), result_sequence: 0, status: "accepted".into(), error: None };
   if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(DeleteError::ChildCommandConflict); }
   events.extend(hydrate_legacy_transcript(tx, &id, now)?);
   let mut planned = Vec::new();
   crate::thread_deletion::delete_one(tx, &id, &cmd, now, &mut planned)?;
   let stored = event_store::append(tx, &planned)?;
   let mut receipt = receipt;
   if let Some(last) = stored.last() { receipt.result_sequence = last.sequence; }
   event_store::upsert_receipt(tx, &receipt)?;
   events.extend(stored);
  }
  let event = plan_delete(project_id, command_id, &uuid::Uuid::new_v4().to_string(), now, true).expect("active project");
  let (result, stored) = project_sink::commit_project_event_tx(tx, &event, "project.delete", now)?;
  events.extend(stored);
  Ok((DeleteOutcome { receipt: result.receipt, deleted_workspace_root: Some(workspace_root) }, events))
 })
}

fn valid_legacy_attachment(value: &serde_json::Value) -> bool {
    let text = |key: &str, limit: usize| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= limit)
    };
    let Some(kind) = text("type", 50) else {
        return false;
    };
    let Some(id) = text("id", 128) else {
        return false;
    };
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || text("name", 255).is_none()
    {
        return false;
    }
    let Some(mime) = text("mimeType", 100) else {
        return false;
    };
    let Some(size) = value.get("sizeBytes").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    match kind {
        "image" => mime.to_ascii_lowercase().starts_with("image/") && size <= 10 * 1024 * 1024,
        "file" => {
            (1..=50 * 1024 * 1024).contains(&size)
                && value
                    .get("source")
                    .is_none_or(|source| source["_tag"] == "pasted-text")
        }
        _ => true,
    }
}

/// Hydrate a pending V1 transcript within the caller's write transaction.
/// The bus serializes writers, so the lookup, projection writes and events are atomic.
pub(crate) fn hydrate_legacy_transcript(
    tx: &rusqlite::Transaction<'_>,
    tid: &str,
    now: &str,
) -> rusqlite::Result<Vec<event_store::StoredEvent>> {
    use rusqlite::params;
    use serde_json::{json, Value};
    let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id=?1 AND transcript_imported_at IS NULL)", [tid], |r| r.get(0))?;
    if !pending {
        return Ok(vec![]);
    }
    let mut stmt = tx.prepare("SELECT message_id,role,text,attachments_json,context_json,is_streaming,created_at,updated_at,ROW_NUMBER() OVER (ORDER BY created_at,message_id) FROM projection_thread_messages WHERE thread_id=?1 AND role IN ('user','assistant') ORDER BY created_at,message_id")?;
    let rows = stmt
        .query_map([tid], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let total = rows.len();
    let mut events = Vec::new();
    for (id, role, text, attachments, context, streaming, created, updated, ordinal) in rows {
        let event_id = format!("migration:v1:message:{id}");
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM orchestration_events WHERE event_id=?1)",
            [&event_id],
            |r| r.get(0),
        )?;
        if exists {
            continue;
        }
        let valid_date = |s: &str| chrono::DateTime::parse_from_rfc3339(s).is_ok();
        let created = if valid_date(&created) {
            created
        } else if valid_date(&updated) {
            updated.clone()
        } else {
            now.to_owned()
        };
        let updated = if valid_date(&updated) {
            updated
        } else {
            created.clone()
        };
        let attachments: Value = attachments
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| {
                v.as_array()
                    .is_some_and(|items| items.iter().all(valid_legacy_attachment))
            })
            .unwrap_or_else(|| json!([]));
        let context: Option<Value> = context
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v["version"] == 1 && v["records"].is_array());
        let item_id = format!("migration:v1:turn-item:{id}");
        let mut message = json!({"createdBy":if role=="user" {"user"} else {"agent"},"creationSource":"server","id":id,"threadId":tid,"runId":null,"nodeId":null,"role":role,"text":text,"attachments":attachments,"streaming":false,"createdAt":created,"updatedAt":updated});
        let mut item = json!({"id":item_id,"threadId":tid,"runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":if streaming==1 {"interrupted"} else {"completed"},"title":null,"startedAt":created,"completedAt":updated,"updatedAt":updated,"type":if role=="user" {"user_message"} else {"assistant_message"},"messageId":id,"text":text});
        if role == "user" {
            item["createdBy"] = json!("user");
            item["creationSource"] = json!("server");
            item["inputIntent"] = json!("turn_start");
            item["attachments"] = attachments;
        } else {
            item["streaming"] = json!(false);
        }
        if let Some(context) = context {
            message["context"] = context.clone();
            item["context"] = context;
        }
        tx.execute("INSERT INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) VALUES(?1,?2,?3) ON CONFLICT(thread_id,turn_item_id) DO NOTHING",params![tid,item_id,ordinal])?;
        tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,?3,0,?4,?5,?6)",params![id,tid,role,created,updated,message.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,NULL,NULL,NULL,?3,?4,?5,?6,?7)",params![item_id,tid,ordinal,item["type"].as_str(),item["status"].as_str(),updated,item.to_string()])?;
        for (event_id, kind, payload) in [
            (event_id, "message.updated", message),
            (item_id, "turn-item.updated", item),
        ] {
            events.push(event_store::Event {
                id: event_id,
                aggregate_kind: "thread".into(),
                stream_id: tid.into(),
                event_type: kind.into(),
                occurred_at: updated.clone(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                actor_kind: "system".into(),
                payload,
                metadata: json!({}),
            });
        }
    }
    let stored = event_store::append(tx, &events)?;
    tx.execute("UPDATE orchestration_v2_legacy_imports SET transcript_imported_at=?2,imported_message_count=?3,last_error=NULL WHERE thread_id=?1",params![tid,now,total as i64])?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        project_commands::CreateProject,
        project_sink::create_project_ordered,
        thread_commands::{create_thread_ordered, CreateThread},
    };
    use serde_json::json;
    #[test]
    fn legacy_attachment_validation_rejects_malformed_known_types() {
        assert!(valid_legacy_attachment(
            &json!({"type":"image","id":"img_1","name":"photo.png","mimeType":"image/png","sizeBytes":123})
        ));
        assert!(!valid_legacy_attachment(
            &json!({"type":"image","id":"img_1","name":"photo.png","mimeType":"text/plain","sizeBytes":123})
        ));
        assert!(!valid_legacy_attachment(
            &json!({"type":"file","id":"../bad","name":"x","mimeType":"text/plain","sizeBytes":1})
        ));
        assert!(valid_legacy_attachment(
            &json!({"type":"future","id":"ok","name":"x","mimeType":"text/plain","sizeBytes":0})
        ));
    }
    #[test]
    fn force_delete_cleans_children_and_replays_without_duplicate_events() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        create_project_ordered(
            &bus,
            CreateProject {
                command_id: "create",
                project_id: "p",
                title: "P",
                workspace_root: "/tmp",
                scripts: None,
            },
            "e",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let model = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "thread",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &model,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "te",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        assert!(matches!(
            delete(&bus, "del", "p", false, "2026-01-02T00:00:00Z"),
            Err(DeleteError::NotEmpty(_))
        ));
        bus.commit(|tx| {
            tx.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('old','t','user','legacy text',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])?;
            tx.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at) VALUES ('t','2026-01-01','2026-01-01')", [])?;
            Ok(((), vec![]))
        }).unwrap();
        let outcome = delete_with_outcome(&bus, "del", "p", true, "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(outcome.deleted_workspace_root.as_deref(), Some("/tmp"));
        bus.commit(|tx| {
            let text: String = tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE message_id='old'", [], |r| r.get(0))?;
            assert_eq!(text, "legacy text");
            let imported: Option<String> = tx.query_row("SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id='t'", [], |r| r.get(0))?;
            assert!(imported.is_some());
            Ok(((), vec![]))
        }).unwrap();
        assert!(matches!(
            delete(&bus, "del", "other", true, "2026-01-02T00:00:00Z"),
            Err(DeleteError::ProjectCommandConflict)
        ));

        let first = outcome.receipt;
        assert!(
            delete_with_outcome(&bus, "del", "p", true, "2026-01-03T00:00:00Z")
                .unwrap()
                .deleted_workspace_root
                .is_none()
        );
        assert_eq!(
            first,
            delete(&bus, "del", "p", true, "2026-01-03T00:00:00Z").unwrap()
        );
        assert!(matches!(
            delete(&bus, "other", "p", true, "2026-01-03T00:00:00Z"),
            Err(DeleteError::NotFound(_))
        ));
        bus.commit(|tx| {
   let tombstone:Option<String>=tx.query_row("SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?;
   assert!(tombstone.is_some());
   let n:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE command_id='del:delete-thread:t'",[],|r|r.get(0))?; assert_eq!(n,3);
   let n:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE event_type='project.deleted'",[],|r|r.get(0))?; assert_eq!(n,1);
   Ok(((),vec![]))
  }).unwrap();
    }
}
