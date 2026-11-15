//! Read scheduled tasks through the MCP orchestration scope.
use crate::{event_bus::EventBus, mcp_credentials::Scope};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

type Failure = (&'static str, String);
pub fn list_definition() -> Value {
    json!({"name":"list_scheduled_tasks","description":"List scheduled tasks, defaulting to this thread's project.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"projectId":{"type":"string"}},"additionalProperties":false},"annotations":{"title":"List scheduled tasks","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}})
}
pub fn delete_definition() -> Value {
    json!({"name":"delete_scheduled_task","description":"Delete one scheduled task by scheduledTaskId.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"scheduledTaskId":{"type":"string","minLength":1}},"required":["scheduledTaskId"],"additionalProperties":false},"annotations":{"title":"Delete a scheduled task","destructiveHint":true}})
}
pub fn delete(bus: &EventBus, scope: &Scope, args: &Value) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let invalid = || {
        (
            "invalid_request",
            "Invalid scheduled task delete arguments.".to_owned(),
        )
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|k| !["environmentId", "scheduledTaskId"].contains(&k.as_str()))
    {
        return Err(invalid());
    }
    let id = object
        .get("scheduledTaskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let rank = |mode: &str| match mode {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    };
    bus.commit(|tx| {
        if let Err(error) = crate::mcp_thread_organize::check(tx, scope, &scope.thread_id) { return Ok((Err(error),vec![])); }
        if let Err(error) = crate::mcp_thread_organize::check_not_linked(tx,scope,"change scheduled tasks") { return Ok((Err(error),vec![])); }
        let parent: (String,String) = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&scope.thread_id], |r|Ok((r.get(0)?,r.get(1)?)))?;
        let task = crate::scheduled_tasks::get(tx,id).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let Some(task) = task else { return Ok((Err(("task_not_found",format!("Scheduled task {id} was not found."))),vec![])); };
        let check_modes = |runtime: &str, interaction: &str| -> Result<(), Failure> {
            if rank(&parent.0).is_none() || rank(runtime).is_none() || rank(runtime)>rank(&parent.0) { return Err(("runtime_mode_escalation_denied","The scheduled task exceeds the caller's runtime mode.".into())); }
            if !matches!(parent.1.as_str(),"plan"|"default") || !matches!(interaction,"plan"|"default") || (parent.1=="plan" && interaction!="plan") { return Err(("interaction_mode_escalation_denied","The scheduled task exceeds the caller's interaction mode.".into())); }
            Ok(())
        };
        if let Err(error)=check_modes(task["runtimeMode"].as_str().unwrap_or(""),task["interactionMode"].as_str().unwrap_or("")) { return Ok((Err(error),vec![])); }
        if let Some(thread)=task["threadId"].as_str() {
            if let Err(error)=crate::mcp_thread_organize::check(tx,scope,thread) { return Ok((Err(error),vec![])); }
        }
        tx.execute("DELETE FROM scheduled_task_webhook_deliveries WHERE task_id=?1",[id])?;
        tx.execute("DELETE FROM scheduled_tasks WHERE task_id=?1",[id])?;
        Ok((Ok(json!({"scheduledTaskId":id,"deleted":true})),vec![]))
    }).map_err(|e|("orchestration_error",format!("Could not delete scheduled task: {e}")))?
}
pub fn list(bus: &EventBus, scope: &Scope, args: &Value) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let invalid = || {
        (
            "invalid_request",
            "Invalid scheduled task list arguments.".to_owned(),
        )
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|k| !["environmentId", "projectId"].contains(&k.as_str()))
    {
        return Err(invalid());
    }
    let requested = match object.get("projectId") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim()),
        _ => return Err(invalid()),
    };
    bus.commit(|tx| {
        let parent: Option<String> = tx.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&scope.thread_id], |r|r.get(0)).optional()?;
        let Some(parent) = parent else { return Ok((Err(("thread_not_found","The calling thread was not found.".to_owned())),vec![])); };
        let project = requested.unwrap_or(&parent);
        let tasks = crate::scheduled_tasks::list(tx).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let tasks: Vec<Value> = tasks.into_iter().filter(|t|t["projectId"]==project).map(|t|summary(&t)).collect();
        Ok((Ok(json!({"tasks":tasks})),vec![]))
    }).map_err(|e|("orchestration_error",format!("Could not list scheduled tasks: {e}")))?
}

pub fn save_definition() -> Value {
    json!({"name":"schedule_task","description":"Create or update a scheduled task. New tasks require prompt and schedule.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"scheduledTaskId":{"type":"string"},"projectId":{"type":"string"},"prompt":{"type":"string","minLength":1,"maxLength":120000},"title":{"type":"string","minLength":1,"maxLength":512},"schedule":{"oneOf":[{"type":"object"},{"type":"string"}]},"enabled":{"type":"boolean"},"bindToCurrentThread":{"type":"boolean"},"freshSession":{"type":"boolean"},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"additionalProperties":false},"annotations":{"title":"Schedule a task","destructiveHint":true,"openWorldHint":true}})
}
fn summary(t: &Value) -> Value {
    let mut result = json!({"scheduledTaskId":t["id"],"title":t["title"],"prompt":t["prompt"],"enabled":t["enabled"],"projectId":t["projectId"],"boundThreadId":t["threadId"],"freshSession":t["threadMode"]=="fresh_session","schedule":t["schedule"],"nextRunAt":t["nextRunAt"],"lastRunStatus":t["lastRunStatus"]});
    if let Some(webhook) = t.get("webhook").and_then(Value::as_object) {
        result["webhookSignature"] =
            json!(if webhook.get("hasSecret") == Some(&Value::Bool(true)) {
                "set"
            } else {
                "none"
            });
    }
    result
}
pub fn save(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Value, Failure> {
    let policy = crate::managed_policy::webhook_denial().map_err(|e| ("orchestration_error", e))?;
    save_with_policy(
        bus,
        scope,
        args,
        now,
        policy.as_deref(),
        cfg!(any(unix, windows)),
    )
}

fn save_with_policy(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    now: chrono::DateTime<chrono::Utc>,
    policy: Option<&str>,
    webhook_available: bool,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let invalid = || {
        (
            "invalid_request",
            "Invalid scheduled task arguments.".to_owned(),
        )
    };
    let obj = args.as_object().ok_or_else(invalid)?;
    if obj.keys().any(|k| {
        ![
            "environmentId",
            "scheduledTaskId",
            "projectId",
            "prompt",
            "title",
            "schedule",
            "enabled",
            "bindToCurrentThread",
            "freshSession",
            "clientRequestId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    for (k, max) in [
        ("scheduledTaskId", 256),
        ("projectId", 256),
        ("prompt", 120000),
        ("title", 512),
        ("clientRequestId", 256),
    ] {
        if let Some(v) = obj.get(k) {
            if v.as_str()
                .is_none_or(|s| s.trim().is_empty() || s.trim().encode_utf16().count() > max)
            {
                return Err(invalid());
            }
        }
    }
    for k in ["enabled", "bindToCurrentThread", "freshSession"] {
        if obj.get(k).is_some_and(|v| !v.is_boolean()) {
            return Err(invalid());
        }
    }
    let schedule = match obj.get("schedule") {
        None => None,
        Some(Value::Object(_)) => obj.get("schedule").cloned(),
        Some(Value::String(s)) => Some(serde_json::from_str(s).map_err(|_| invalid())?),
        _ => return Err(invalid()),
    };
    let existing_id = obj
        .get("scheduledTaskId")
        .and_then(Value::as_str)
        .map(str::trim);
    if existing_id.is_none() && (schedule.is_none() || obj.get("prompt").is_none()) {
        return Err((
            "invalid_request",
            "A new scheduled task needs `prompt` and `schedule`.".into(),
        ));
    }
    let failure = |e: String| ("orchestration_error", e);
    let result = bus.commit(|tx| {
        if let Err(e)=crate::mcp_thread_organize::check(tx,scope,&scope.thread_id) {return Ok((Err(e),vec![]));}
        let row:Option<(String,String,String,String)>=tx.query_row("SELECT project_id,runtime_mode,interaction_mode,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((parent_project,runtime,interaction,raw))=row else {return Ok((Err(("thread_not_found","The calling thread was not found.".into())),vec![]));};
        let parent:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if let Err(error)=crate::mcp_thread_organize::check_not_linked(tx,scope,"change scheduled tasks") { return Ok((Err(error),vec![])); }
        let old=if let Some(id)=existing_id {crate::scheduled_tasks::get(tx,id).map_err(|_|rusqlite::Error::InvalidQuery)?}else{None};
        if existing_id.is_some() && old.is_none(){return Ok((Err(("task_not_found",format!("Scheduled task {} was not found.",existing_id.unwrap_or_default()))),vec![]));}
        let rank=|s:&str|match s {"approval-required"=>Some(0),"auto-accept-edits"=>Some(1),"auto"=>Some(2),"full-access"=>Some(3),_=>None};
        if let Some(ref t)=old {
            let tm=t["runtimeMode"].as_str().unwrap_or("");
            let ti=t["interactionMode"].as_str().unwrap_or("");
            if rank(&runtime).is_none() || rank(tm).is_none() || rank(tm)>rank(&runtime) {return Ok((Err(("runtime_mode_escalation_denied","The scheduled task exceeds the caller's runtime mode.".into())),vec![]));}
            if !matches!(interaction.as_str(),"plan"|"default") || !matches!(ti,"plan"|"default") || (interaction=="plan"&&ti!="plan") {return Ok((Err(("interaction_mode_escalation_denied","The scheduled task exceeds the caller's interaction mode.".into())),vec![]));}
            if let Some(bound)=t["threadId"].as_str(){if let Err(e)=crate::mcp_thread_organize::check(tx,scope,bound){return Ok((Err(e),vec![]));}}
        }
        let project=old.as_ref().and_then(|t|t["projectId"].as_str()).or_else(||obj.get("projectId").and_then(Value::as_str).map(str::trim)).unwrap_or(&parent_project);
        let root:Option<String>=tx.query_row("SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[project],|r|r.get(0)).optional()?;
        let Some(root)=root else {return Ok((Err(("invalid_request","The project was not found.".into())),vec![]));};
        let bind=obj.get("bindToCurrentThread").and_then(Value::as_bool);
        if bind==Some(true)&&project!=parent_project {return Ok((Err(("invalid_request","bindToCurrentThread binds to this thread, which belongs to a different project.".into())),vec![]));}
        if bind==Some(false)&&obj.get("freshSession")==Some(&json!(true))&&old.as_ref().is_some_and(|t|t["threadId"].is_string()) {return Ok((Err(("invalid_request","To move this task to a new thread with fresh sessions, first unbind it with bindToCurrentThread: false, then set freshSession: true in a second call.".into())),vec![]));}
        let thread=match bind {Some(true)=>Some(scope.thread_id.as_str()),Some(false)=>None,None=>old.as_ref().and_then(|t|t["threadId"].as_str()).or_else(||if old.is_none()&&project==parent_project {Some(scope.thread_id.as_str())}else{None})};
        let fresh=obj.get("freshSession").and_then(Value::as_bool).unwrap_or_else(||bind!=Some(false)&&old.as_ref().is_some_and(|t|t["threadMode"]=="fresh_session"));
        let mode=if fresh {"fresh_session"}else if thread.is_some(){"continue"}else{"new_thread"};
        let oldbound=old.as_ref().is_some_and(|t|t["threadId"].is_string());
        let workspace=if let Some(previous) = old.as_ref().filter(|_| oldbound == thread.is_some()) {previous["workspaceStrategy"].clone()}else if thread.is_some(){json!({"type":"root"})}else{
            let exists=|r:&str|std::process::Command::new("git").args(["-C",&root,"show-ref","--verify","--quiet",r]).status().is_ok_and(|s|s.success());
            let base=if exists("refs/remotes/origin/main"){"origin/main"}else if exists("refs/remotes/origin/master"){"origin/master"}else if exists("refs/heads/main"){"main"}else if exists("refs/heads/master"){"master"}else{"main"};json!({"type":"worktree","baseRef":base,"startFromOrigin":true})};
        let prompt=obj.get("prompt").and_then(Value::as_str).map(str::trim).or_else(||old.as_ref().and_then(|t|t["prompt"].as_str())).unwrap_or("");
        let title=obj.get("title").and_then(Value::as_str).map(str::trim).map(str::to_owned).or_else(||old.as_ref().and_then(|t|t["title"].as_str()).map(str::to_owned)).unwrap_or_else(||prompt.lines().next().unwrap_or("").trim().chars().take(80).collect());
        let id=if let Some(id)=existing_id {id.to_owned()}else if let Some(key)=obj.get("clientRequestId").and_then(Value::as_str) {format!("scheduled-task:command:mcp:{}:schedule-task:{}",crate::message_commands::encode_id_part(&scope.provider_session_id),crate::message_commands::encode_id_part(key.trim()))}else{format!("scheduled-task:{}",uuid::Uuid::new_v4())};
        let mut input=json!({"id":id,"requireExisting":old.is_some(),"title":if title.is_empty(){"Scheduled task"}else{&title},"prompt":prompt,"enabled":obj.get("enabled").and_then(Value::as_bool).unwrap_or_else(||old.as_ref().and_then(|t|t["enabled"].as_bool()).unwrap_or(true)),"schedule":schedule.clone().or_else(||old.as_ref().map(|t|t["schedule"].clone())),"projectId":project,"threadId":thread,"threadMode":mode,"workspaceStrategy":workspace,"modelSelection":old.as_ref().map(|t|t["modelSelection"].clone()).unwrap_or_else(||parent["modelSelection"].clone()),"runtimeMode":old.as_ref().and_then(|t|t["runtimeMode"].as_str()).unwrap_or(&runtime),"interactionMode":old.as_ref().and_then(|t|t["interactionMode"].as_str()).unwrap_or(&interaction),"createdBy":old.as_ref().and_then(|t|t["createdBy"].as_str()).unwrap_or("agent"),"creationSource":old.as_ref().and_then(|t|t["creationSource"].as_str()).unwrap_or("mcp")});
        if input["enabled"] == true && input["schedule"]["type"] == "webhook" {
            if let Some(message) = policy { return Ok((Err(failure(message.to_owned())),vec![])); }
            if !webhook_available { return Ok((Err(failure("Webhook tasks are unavailable on this platform.".into())),vec![])); }
        }
        if let Some(key) = obj.get("clientRequestId").and_then(Value::as_str) { input["commandId"] = json!(format!("mcp:{}:schedule-task:{}", crate::message_commands::encode_id_part(&scope.provider_session_id), crate::message_commands::encode_id_part(key.trim()))); }
        let result=if let Some(dir) = bus.secrets_dir() { crate::scheduled_tasks::upsert_with_secret_dir(tx,&input,now,&dir) } else { crate::scheduled_tasks::upsert(tx,&input,now) }.map(|t|summary(&t)).map_err(|e|failure(format!("Could not save scheduled task: {e}")));
        Ok((result,vec![]))
    }).map_err(|e|failure(e.to_string()))?;
    if let Some(dir) = bus.secrets_dir() {
        let _ = bus.with_autocommit(|db| crate::secret_requests::cleanup_claimed(db, &dir));
    }
    result
}

pub fn run_definition() -> Value {
    json!({"name":"run_scheduled_task_now","description":"Run one scheduled task now. Success means started, not finished.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"taskId":{"type":"string","minLength":1}},"required":["taskId"],"additionalProperties":false},"annotations":{"title":"Run scheduled task","destructiveHint":true,"openWorldHint":true}})
}
pub fn run_now(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    environment: &str,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let invalid = || {
        (
            "invalid_request",
            "Invalid scheduled task arguments.".to_owned(),
        )
    };
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys()
        .any(|k| !["environmentId", "taskId"].contains(&k.as_str()))
    {
        return Err(invalid());
    }
    let id = o
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let denial = std::cell::RefCell::new(None::<Failure>);
    let result=crate::scheduled_tasks::run_manual_background_checked(bus,id,sessions,|tx| {
        let fail=|f:Failure|{*denial.borrow_mut()=Some(f);"Authorization failed".to_owned()};
        crate::mcp_thread_organize::check(tx,scope,&scope.thread_id).map_err(&fail)?;
        let row:Option<(String,String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        let (runtime,interaction,raw)=row.ok_or_else(||fail(("thread_not_found","The calling thread was not found.".into())))?;
        let _caller:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        crate::mcp_thread_organize::check_not_linked(tx,scope,"change scheduled tasks").map_err(&fail)?;
        if runtime!="full-access" || interaction!="default" {return Err(fail(("capability_denied","Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.".into())));}
        let task=crate::scheduled_tasks::get(tx,id)?;
        if task.is_none(){return Err(fail(("invalid_request","The scheduled task was not found.".into())));}
        Ok(())
    }).map_err(|e|denial.into_inner().unwrap_or(("orchestration_error",e)))?;
    let task = result.ok_or_else(|| {
        (
            "orchestration_error",
            "The scheduled task could not be started.".to_owned(),
        )
    })?;
    let thread=bus.commit(|tx| {
        let thread:Option<(String,Option<String>)>=tx.query_row("SELECT m.thread_id,t.title FROM orchestration_v2_projection_messages m LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=m.thread_id WHERE json_extract(m.payload_json,'$.scheduledTaskId')=?1 AND m.created_at=?2 ORDER BY m.rowid DESC LIMIT 1",rusqlite::params![id,task["lastRunAt"].as_str()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        Ok((thread,vec![]))
    }).map_err(|e|("orchestration_error",e.to_string()))?;
    let mut value = json!({"taskId":id,"threadId":thread.as_ref().map(|v|&v.0),"lastRunStatus":task["lastRunStatus"],"runCount":task["runCount"],"nextRunAt":task["nextRunAt"]});
    if let Some((thread, title)) = thread {
        value["link"] = json!(crate::mcp_http::thread_link(
            environment,
            &thread,
            title.as_deref()
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn save_creates_bound_task_and_updates_without_changing_modes() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let payload = json!({"id":"t","projectId":"p","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"auto","interactionMode":"default"});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','codex','auto','default','now','now',?1)",[payload.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','codex','running','now','{}')",[]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let now = chrono::Utc::now();
        let args = json!({"prompt":"Review daily","schedule":{"type":"interval","everyMs":60000},"clientRequestId":"key"});
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin',json(?1)) WHERE thread_id='t'", [json!({"sessionId":"link","label":"Laptop","access":"auto"}).to_string()])?; Ok(((),vec![])) }).unwrap();
        assert_eq!(save(&bus, &scope, &args, now).unwrap_err().0, "capability_denied");
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin.access','full-access') WHERE thread_id='t'", [])?; Ok(((),vec![])) }).unwrap();
        let created = save(&bus, &scope, &args, now).unwrap();
        assert_eq!(created["boundThreadId"], "t");
        assert_eq!(created["title"], "Review daily");
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin.access','auto') WHERE thread_id='t'", [])?; Ok(((),vec![])) }).unwrap();
        assert_eq!(delete(&bus, &scope, &json!({"scheduledTaskId":created["scheduledTaskId"]})).unwrap_err().0, "capability_denied");
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_remove(payload_json,'$.linkOrigin') WHERE thread_id='t'", [])?; Ok(((),vec![])) }).unwrap();

        assert_eq!(
            save(&bus, &scope, &args, now).unwrap()["scheduledTaskId"],
            created["scheduledTaskId"]
        );
        let dir = std::env::temp_dir().join(format!("t3-mcp-ref-{}", uuid::Uuid::new_v4()));
        bus.set_secrets_dir(dir.clone());
        let reference = crate::secret_requests::reference(&[5; 32], "t", "item");
        crate::secret_requests::create(&dir, &reference, "p", "private", now.timestamp_millis())
            .unwrap();
        let hook = json!({"prompt":"Webhook", "enabled":false, "schedule":{"type":"webhook","signature":{"header":"x-sig","encoding":"hex","prefix":"","secretRef":reference}},"clientRequestId":"hook-key"});
        let first = save(&bus, &scope, &hook, now).unwrap();
        let replay = save(&bus, &scope, &hook, now).unwrap();
        assert_eq!(first["scheduledTaskId"], replay["scheduledTaskId"]);
        assert!(!replay.to_string().contains("private"));
        let enable = json!({"scheduledTaskId":first["scheduledTaskId"],"enabled":true});
        assert!(
            save_with_policy(&bus, &scope, &enable, now, Some("policy denied"), true)
                .unwrap_err()
                .1
                .contains("policy denied")
        );
        assert!(save_with_policy(&bus, &scope, &enable, now, None, false)
            .unwrap_err()
            .1
            .contains("unavailable"));
        let new_hook = json!({"prompt":"new hook","schedule":{"type":"webhook"}});
        assert!(
            save_with_policy(&bus, &scope, &new_hook, now, Some("policy denied"), true)
                .unwrap_err()
                .1
                .contains("policy denied")
        );
        bus.commit(|tx| {
            let enabled: i64 = tx.query_row(
                "SELECT enabled FROM scheduled_tasks WHERE task_id=?1",
                [first["scheduledTaskId"].as_str()],
                |r| r.get(0),
            )?;
            assert_eq!(enabled, 0);
            Ok(((), vec![]))
        })
        .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        let updated=save(&bus,&scope,&json!({"scheduledTaskId":created["scheduledTaskId"],"enabled":false,"freshSession":true}),now).unwrap();
        assert_eq!(updated["enabled"], false);
        assert_eq!(updated["freshSession"], true);
        assert_eq!(updated["boundThreadId"], "t");
        assert_eq!(
            save(&bus, &scope, &json!({"prompt":"missing schedule"}), now)
                .unwrap_err()
                .0,
            "invalid_request"
        );
    }
    #[test]
    fn list_defaults_to_caller_project_and_requires_capability() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','auto','default','now','now','{}')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','codex','running','now','{}')",[]).unwrap();
        let task = |project: &str| json!({"id":format!("task-{project}"),"title":"T","prompt":"P","enabled":false,"schedule":{"type":"interval","everyMs":60000},"projectId":project,"workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"auto","interactionMode":"default"});
        for project in ["p", "other"] {
            crate::scheduled_tasks::upsert(&db, &task(project), chrono::Utc::now()).unwrap();
        }
        let bus = EventBus::new(db, 16);
        let mut scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::new(),
            subagent: false, client: None,
        };
        assert_eq!(
            list(&bus, &scope, &json!({})).unwrap_err().0,
            "capability_denied"
        );
        scope.capabilities.insert("orchestration".into());
        let result = list(&bus, &scope, &json!({})).unwrap();
        assert_eq!(result["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(result["tasks"][0]["scheduledTaskId"], "task-p");
        assert_eq!(
            list(&bus, &scope, &json!({"projectId":"other"})).unwrap()["tasks"][0]
                ["scheduledTaskId"],
            "task-other"
        );
        bus.commit(|tx| {
            tx.execute(
                "UPDATE scheduled_tasks SET runtime_mode='full-access' WHERE task_id='task-p'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert_eq!(
            delete(&bus, &scope, &json!({"scheduledTaskId":"task-p"}))
                .unwrap_err()
                .0,
            "runtime_mode_escalation_denied"
        );
        bus.commit(|tx| {
            tx.execute(
                "UPDATE scheduled_tasks SET runtime_mode='auto' WHERE task_id='task-p'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert_eq!(
            delete(&bus, &scope, &json!({"scheduledTaskId":"task-p"})).unwrap()["deleted"],
            true
        );
        assert!(list(&bus, &scope, &json!({})).unwrap()["tasks"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
