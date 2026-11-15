//! Promote a scratch folder, moving its idle threads to a project rooted there.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    project_commands::CreateProject,
    project_sink,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
fn failure(reason: &str) -> Value {
    json!({"_tag":"OrchestrationDispatchCommandError","message":reason,"cause":{"name":"ScratchThreadPromotionError","message":reason}})
}
fn project_owner(bus: &EventBus, root: &str) -> Result<Option<String>, String> {
    bus.with_autocommit(|db|db.query_row("SELECT project_id FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL",[root],|r|r.get(0)).optional()).map_err(|e|e.to_string())?.map_err(|e|e.to_string())
}
fn busy(tx: &rusqlite::Transaction<'_>, id: &str) -> rusqlite::Result<bool> {
    tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status NOT IN ('completed','failed','cancelled','interrupted','rolled_back')) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending')",[id],|r|r.get(0))
}
pub(crate) fn promote(bus: &EventBus, base: &Path, thread: &str) -> Result<Value, Value> {
    let probe = std::process::Command::new("git")
        .args([
            "-C",
            &base.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output();
    if probe.as_ref().is_ok_and(|o| o.status.success()) {
        return Err(failure(
            "Only a No project thread with its own folder can become a project.",
        ));
    }
    let data=bus.with_autocommit(|db|db.query_row("SELECT t.payload_json,p.workspace_root FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL WHERE t.thread_id=?1 AND t.deleted_at IS NULL",[thread],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()).map_err(|_|failure("Could not read the thread."))?.map_err(|_|failure("Could not read the thread."))?.ok_or_else(||failure("Thread not found."))?;
    let payload: Value =
        serde_json::from_str(&data.0).map_err(|_| failure("Could not read the thread."))?;
    let project_root = data
        .1
        .ok_or_else(|| failure("Could not read the thread's project."))?;
    let folder = payload["worktreePath"].as_str().unwrap_or(&project_root);
    let folder_path = Path::new(folder);
    let scratch = base.join("scratch");
    let parent = folder_path
        .parent()
        .and_then(|p| std::fs::canonicalize(p).ok());
    let scratch_real = std::fs::canonicalize(&scratch).ok();
    let scratch_project =
        std::fs::canonicalize(&project_root).ok() == scratch_real && scratch_real.is_some();
    let already = project_root == folder && !scratch_project;
    if parent.is_none() || parent != scratch_real || !(scratch_project || already) {
        return Err(failure(
            "Only a No project thread with its own folder can become a project.",
        ));
    }
    let before=bus.commit(|tx|{let mut stmt=tx.prepare("SELECT thread_id,payload_json FROM orchestration_v2_projection_threads WHERE project_id IN (SELECT project_id FROM projection_projects WHERE workspace_root IN (?1,?3) AND deleted_at IS NULL) AND json_extract(payload_json,'$.worktreePath')=?2 AND deleted_at IS NULL")?;let rows=stmt.query_map(params![scratch.to_string_lossy(),folder,scratch_real.as_ref().map(|v|v.to_string_lossy().into_owned())],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;for(id,raw) in &rows {if busy(tx,id)?{let v:Value=serde_json::from_str(raw).unwrap_or(Value::Null);return Ok((Err(format!("\"{}\" is still working. Finish or stop it first.",v["title"].as_str().unwrap_or("Thread"))),vec![]))}}Ok((Ok(rows),vec![]))}).map_err(|_|failure("Could not read the threads in this folder."))?.map_err(|e|failure(&e))?;
    let id = if let Some(id) =
        project_owner(bus, folder).map_err(|_| failure("Could not create the project."))?
    {
        id
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let cmd = format!("scratch-promotion-project:{id}");
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let created = project_sink::create_project_ordered(
            bus,
            CreateProject {
                command_id: &cmd,
                project_id: &id,
                title: payload["title"].as_str().unwrap_or("Untitled thread"),
                workspace_root: folder,
                scripts: None,
            },
            &uuid::Uuid::new_v4().to_string(),
            &now,
        )
        .map_err(|_| failure("Could not create the project."))?;
        if created.receipt.status == "accepted" {
            id
        } else {
            project_owner(bus, folder)
                .ok()
                .flatten()
                .ok_or_else(|| failure("Could not create the project."))?
        }
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        let mut events=Vec::new();
        for (thread_id,_) in &before {
            let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[thread_id],|r|r.get(0)).optional()?;
            let Some(raw)=raw else{return Err(rusqlite::Error::InvalidQuery)};
            let mut v:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
            if busy(tx,thread_id)? || v["worktreePath"]!=folder {return Err(rusqlite::Error::InvalidQuery)}
            v["projectId"]=json!(id);v["worktreePath"]=Value::Null;v["updatedAt"]=json!(now);
            let command=format!("scratch-promotion:{}",uuid::Uuid::new_v4());
            let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.clone(),event_type:"thread.metadata-updated".into(),occurred_at:now.clone(),command_id:Some(command),causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:v.clone(),metadata:json!({})};
            tx.execute("UPDATE orchestration_v2_projection_threads SET project_id=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1",params![thread_id,id,now,v.to_string()])?;
            tx.execute("UPDATE scheduled_tasks SET project_id=?2 WHERE thread_id=?1 AND project_id!=?2",params![thread_id,id])?;
            events.push(event);
        }
        let stored=event_store::append(tx,&events)?;
        for event in &stored {event_store::upsert_receipt(tx,&event_store::Receipt{command_id:event.event.command_id.clone().unwrap_or_default(),aggregate_kind:"thread".into(),aggregate_id:event.event.stream_id.clone(),command_type:"thread.project.adopt-folder".into(),accepted_at:now.clone(),result_sequence:event.sequence,status:"accepted".into(),error:None})?;}
        Ok(((),stored))
    }).map_err(|_|failure(&format!("Could not move \"{}\". Try again.",payload["title"].as_str().unwrap_or("Untitled thread"))))?;
    Ok(json!({"projectId":id}))
}
