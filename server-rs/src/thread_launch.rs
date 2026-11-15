//! Durable checkout preparation for public thread launches.
use crate::{
    event_bus::EventBus,
    scheduled_worktree_journal::{self as journal, Preparation},
};
use serde_json::Value;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
pub fn prepare_worktree(
    bus: &EventBus,
    settings: &Value,
    command_id: &str,
    thread_id: &str,
    project_id: &str,
    project_root: &str,
    base_ref: &str,
    branch: Option<&str>,
    start_from_origin: bool,
    now: &str,
) -> Result<Preparation, String> {
    let _guard = bus.lock_worktree_preparation().map_err(|e| e.to_string())?;
    let existing = bus
        .with_autocommit(|db| {
            journal::initialize(db)?;
            Ok::<_, rusqlite::Error>(
                journal::pending(db)?
                    .into_iter()
                    .find(|p| p.task_id == command_id && p.thread_id == thread_id),
            )
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if let Some(existing) = existing {
        if existing.phase == "created" && Path::new(&existing.worktree_path).is_dir() {
            return Ok(existing);
        }
        return Err("A prior worktree preparation needs recovery.".into());
    }
    let default = bus
        .worktrees_dir()
        .ok_or("Worktree directory is unavailable.")?;
    let configured = settings["worktreesDirectory"].as_str().unwrap_or("");
    let root = if configured.trim().is_empty() {
        default
    } else {
        let p = std::path::PathBuf::from(configured);
        if !p.is_absolute() || p.parent().is_none() {
            return Err("Invalid worktree directory.".into());
        }
        p
    };
    let fetched = if start_from_origin {
        journal::fetch_base(Path::new(project_root), base_ref)?
    } else {
        None
    };
    let p = bus
        .with_autocommit(|db| {
            journal::prepare_checkout(
                db,
                command_id,
                thread_id,
                Path::new(project_root),
                &root,
                fetched.as_deref().unwrap_or(base_ref),
                branch,
                now,
            )
        })
        .map_err(|e| e.to_string())??;
    let submodules = settings["projectSettingsOverrides"][project_id]["worktreeSubmodules"]
        .as_str()
        .or_else(|| settings["worktreeSubmodules"].as_str());
    if let Err(error) = journal::initialize_submodules(Path::new(&p.worktree_path), submodules) {
        eprintln!("Warning: worktree submodule initialization failed: {error}");
    }
    Ok(p)
}
pub fn mark_attached(bus: &EventBus, p: &Preparation) -> Result<(), String> {
    let changed = bus
        .with_autocommit(|db| journal::advance(db, &p.run_key, "created", "attached"))
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if changed {
        Ok(())
    } else {
        Err("Worktree preparation was concurrently recovered.".into())
    }
}
pub fn cleanup(bus: &EventBus, p: &Preparation) {
    if journal::remove_orphan_checkout(p).unwrap_or(false) {
        let _ = bus.with_autocommit(|db| journal::forget(db, &p.run_key, "created"));
    }
}
pub fn setup(
    bus: &EventBus,
    project_id: &str,
    project_root: &str,
    thread_id: &str,
    path: &str,
) -> Result<(), String> {
    let done=bus.with_autocommit(|db| {journal::initialize(db)?;db.query_row("SELECT EXISTS(SELECT 1 FROM scheduled_worktree_setup_completed WHERE thread_id=?1)",[thread_id],|r|r.get::<_,bool>(0))}).map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
    if done {
        return Ok(());
    }
    let scripts: String = bus
        .with_autocommit(|db| {
            db.query_row(
                "SELECT scripts_json FROM projection_projects WHERE project_id=?1",
                [project_id],
                |r| r.get(0),
            )
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let scripts: Value = serde_json::from_str(&scripts).map_err(|e| e.to_string())?;
    if let Some((terminals, settings)) = bus.setup_context() {
        crate::scheduled_setup::run(
            &terminals,
            &settings,
            project_id,
            project_root,
            &scripts,
            thread_id,
            path,
            &bus.shutdown_flag(),
        )?;
    } else if crate::project_setup::setup_script(&serde_json::json!({}), project_id, &scripts)
        .is_some()
    {
        return Err("Worktree setup is unavailable.".into());
    }
    bus.with_autocommit(|db| {
        db.execute(
            "INSERT OR IGNORE INTO scheduled_worktree_setup_completed(thread_id) VALUES(?1)",
            [thread_id],
        )
    })
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Schedule initial title generation once the first message is durable.
pub fn request_initial_title(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    message_id: &str,
    now: &str,
) -> Result<(), String> {
    use crate::{
        event_store::{self, Event},
        outbox::{self, Effect},
    };
    use rusqlite::OptionalExtension;
    use serde_json::json;
    bus.commit(|tx| {
        let effect_id=format!("effect:{command_id}:thread-title.generate");
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1)",[&effect_id],|r|r.get(0))?;
        if exists {return Ok(((),vec![]));}
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[thread_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok(((),vec![]))};let mut thread:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        thread["titleRegeneration"]=json!({"requestId":command_id,"startedAt":now});thread["updatedAt"]=json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?2,payload_json=?3 WHERE thread_id=?1",rusqlite::params![thread_id,now,thread.to_string()])?;
        outbox::enqueue(tx,&Effect{id:effect_id,command_id:command_id.into(),thread_id:thread_id.into(),request:json!({"type":"thread-title.generate","kind":{"type":"initial","messageId":message_id}}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"thread.metadata-updated".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload:thread,metadata:json!({})};
        let events=event_store::append(tx,&[event])?;Ok(((),events))
    }).map_err(|e|e.to_string())
}
