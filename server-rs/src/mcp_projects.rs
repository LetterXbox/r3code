//! Project operations exposed to authenticated MCP callers.
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};

pub fn definitions() -> Vec<Value> {
    vec![
        json!({"name":"t3_project_list","description":"List projects. Pages can shift.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false},"annotations":{"title":"List projects","readOnlyHint":true,"destructiveHint":false}}),
        json!({"name":"t3_project_read","description":"Read one project: workspace and saved scripts.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false},"annotations":{"title":"Read a project","readOnlyHint":true,"destructiveHint":false}}),
        json!({"name":"t3_project_update","description":"Update one project's settings. Omitted fields are unchanged.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"projectId":{"type":"string"},"title":{"type":"string"},"workspaceRoot":{"type":"string"},"defaultModelSelection":{"type":["object","null"]},"autoPull":{"type":"boolean"},"projectIcon":{"type":["object","null"]},"faviconPath":{"type":["string","null"]},"defaultThreadEnvMode":{"type":["string","null"]},"scripts":{"type":"array"},"pinned":{"type":"boolean"},"archived":{"type":"boolean"}},"required":["projectId"],"additionalProperties":false},"annotations":{"title":"Update a project","destructiveHint":true}}),
        json!({"name":"t3_project_create","description":"Create a project, either backed by an existing directory or a new managed folder.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"title":{"type":"string","minLength":1,"maxLength":200},"workspaceRoot":{"type":"string"},"createWorkspaceRootIfMissing":{"type":"boolean"},"defaultModelSelection":{"type":["object","null"]},"scripts":{"type":"array"}},"required":["title"],"additionalProperties":false},"annotations":{"title":"Create a project","destructiveHint":true}}),
        json!({"name":"t3_project_delete","description":"Delete a project (set force=true if it still has threads). The folder on disk is untouched.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"projectId":{"type":"string"},"force":{"type":"boolean"}},"required":["projectId"],"additionalProperties":false},"annotations":{"title":"Delete a project","destructiveHint":true}}),
        json!({"name":"t3_project_clone","description":"Clone a repository from a source-control provider or remote URL into destinationPath.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"provider":{"type":"string"},"repository":{"type":"string"},"remoteUrl":{"type":"string"},"destinationPath":{"type":"string"},"protocol":{"type":"string"}},"required":["destinationPath"],"additionalProperties":false},"annotations":{"title":"Clone a repository","destructiveHint":true,"openWorldHint":true}}),
    ]
}
fn project(row: &Row<'_>) -> rusqlite::Result<Value> {
    let selection: Option<String> = row.get(3)?;
    let scripts: String = row.get(6)?;
    let icon: Option<String> = row.get(8)?;
    Ok(
        json!({"id":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"workspaceRoot":row.get::<_,String>(2)?,"repositoryIdentity":null,"defaultModelSelection":selection.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"defaultThreadEnvMode":row.get::<_,Option<String>>(4)?,"autoPull":row.get::<_,bool>(5)?,"scripts":serde_json::from_str::<Value>(&scripts).unwrap_or(json!([])),"faviconPath":row.get::<_,Option<String>>(7)?,"projectIcon":icon.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"pinnedAt":row.get::<_,Option<String>>(9)?,"archivedAt":row.get::<_,Option<String>>(10)?,"createdAt":row.get::<_,String>(11)?,"updatedAt":row.get::<_,String>(12)?,"deletedAt":null}),
    )
}
/// Resolve optional metadata after releasing the database lock. Call on a blocking worker.
pub fn enrich_result(value: &mut Value) {
    fn enrich(project: &mut Value) {
        if let Some(root) = project["workspaceRoot"].as_str() {
            project["repositoryIdentity"] =
                crate::repository_identity::resolve(root).unwrap_or(Value::Null);
        }
    }
    if let Some(projects) = value.get_mut("projects").and_then(Value::as_array_mut) {
        for project in projects {
            enrich(project);
        }
    } else {
        enrich(value);
    }
}
const COLUMNS: &str = "project_id,title,workspace_root,default_model_selection_json,default_thread_env_mode,auto_pull,scripts_json,favicon_path,project_icon_json,pinned_at,archived_at,created_at,updated_at";
/// Read a committed project, including a tombstoned row for deletion responses.
pub fn read_including_deleted(db: &Connection, id: &str) -> Result<Value, String> {
    let sql = format!("SELECT {COLUMNS},deleted_at FROM projection_projects WHERE project_id=?1");
    let value = db
        .query_row(&sql, [id], |row| {
            let mut value = project(row)?;
            value["deletedAt"] = json!(row.get::<_, Option<String>>(13)?);
            Ok(value)
        })
        .optional()
        .map_err(|_| "The operation could not be completed.".to_owned())?
        .ok_or("The project was not found.".to_owned())?;
    Ok(value)
}
pub fn call(db: &Connection, name: &str, args: &Value) -> Result<Value, String> {
    let obj = args.as_object().ok_or("Arguments must be an object.")?;
    match name {
        "t3_project_list" => {
            if obj
                .keys()
                .any(|k| !["cursor", "limit"].contains(&k.as_str()))
            {
                return Err("Unknown project-list argument.".into());
            }
            let cursor = match obj.get("cursor") {
                None | Some(Value::Null) => 0,
                Some(v) => v
                    .as_u64()
                    .filter(|n| *n <= i64::MAX as u64)
                    .ok_or("Invalid cursor.")?,
            };
            let limit = match obj.get("limit") {
                None | Some(Value::Null) => 20,
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=100).contains(n))
                    .ok_or("Invalid limit.")?,
            };
            let sql=format!("SELECT {COLUMNS} FROM projection_projects WHERE deleted_at IS NULL ORDER BY created_at,project_id LIMIT ?1 OFFSET ?2");
            let mut stmt = db
                .prepare(&sql)
                .map_err(|_| "The operation could not be completed.")?;
            let mut projects = stmt
                .query_map(params![(limit + 1) as i64, cursor as i64], project)
                .map_err(|_| "The operation could not be completed.")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "The operation could not be completed.")?;
            let next = if projects.len() > limit as usize {
                projects.pop();
                Some(cursor + limit)
            } else {
                None
            };
            Ok(json!({"projects":projects,"nextCursor":next}))
        }
        "t3_project_read" => {
            if obj.keys().any(|k| k != "projectId") {
                return Err("Unknown project-read argument.".into());
            }
            let id = obj
                .get("projectId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Invalid projectId.")?;
            let sql=format!("SELECT {COLUMNS} FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL");
            let project = db
                .query_row(&sql, [id], project)
                .optional()
                .map_err(|_| "The operation could not be completed.".to_owned())?
                .ok_or("The project was not found.".to_owned())?;
            Ok(project)
        }
        _ => Err("Unknown tool.".into()),
    }
}
pub(crate) fn require_full_access_writer(
    tx: &rusqlite::Transaction<'_>,
    scope: &crate::mcp_credentials::Scope,
    what: &str,
    allow_linked: bool,
) -> Result<(), (&'static str, String)> {
    if let Some(client) = scope.client.as_ref() {
        if client.access == "read-only" {
            return Err(("capability_denied", "This tool changes the environment, and this MCP client was approved for read-only access.".into()));
        }
        if !allow_linked {
            crate::mcp_thread_organize::check_not_linked(tx, scope, what)?;
        }
        if client.runtime_mode != "full-access" || client.interaction_mode != "default" {
            return Err(("capability_denied", "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.".into()));
        }
    } else {
        crate::mcp_thread_organize::check(tx, scope, &scope.thread_id)?;
        if !allow_linked {
            crate::mcp_thread_organize::check_not_linked(tx, scope, what)?;
        }
        let modes: (String, String) = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&scope.thread_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| ("orchestration_error", e.to_string()))?;
        if modes.0 != "full-access" || modes.1 != "default" {
            return Err(("capability_denied", "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.".into()));
        }
    }
    Ok(())
}

/// Update project metadata only while the calling thread is active and authorized.
pub fn update(bus: &crate::event_bus::EventBus, scope: &crate::mcp_credentials::Scope, args: &Value, now: &str) -> Result<Value, (&'static str, String)> {
    if !scope.capabilities.contains("orchestration") {return Err(("capability_denied","This credential does not have the orchestration capability.".into()));}
    let invalid = || ("invalid_request", "Invalid project update arguments.".to_owned());
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| !["projectId","title","workspaceRoot","defaultModelSelection","autoPull","projectIcon","faviconPath","defaultThreadEnvMode","scripts","pinned","archived"].contains(&k.as_str())) || !crate::project_update::validate(args) { return Err(invalid()); }
    let project_id = o.get("projectId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
    let mut input = args.clone();
    if let Some(root) = args.get("workspaceRoot").and_then(Value::as_str) {
        let cwd = std::env::current_dir().map_err(|e| ("orchestration_error",e.to_string()))?;
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(||cwd.clone());
        let path = crate::runtime::resolve_base_dir(Some(root.trim()), &home, &cwd);
        if !path.is_dir() { return Err(("invalid_request","Project workspace must be an existing directory.".into())); }
        input["workspaceRoot"] = json!(path.to_string_lossy());
    }
    let denied = std::cell::RefCell::new(None);
    let receipt = crate::project_update::dispatch_checked(bus, &format!("mcp:{}",uuid::Uuid::new_v4()), project_id, &input, now, |tx| {
        require_full_access_writer(tx, scope, "change projects or environment settings", false)
            .map_err(|e| { *denied.borrow_mut()=Some(e); rusqlite::Error::InvalidQuery })
    }).map_err(|e| denied.into_inner().unwrap_or_else(|| ("orchestration_error",e.to_string())))?;
    if receipt.status != "accepted" {return Err(("orchestration_error",receipt.error.unwrap_or_else(||"Project update rejected.".into())));}
    let mut result = bus.commit(|tx| { let value = read_including_deleted(tx,project_id).map_err(|_|rusqlite::Error::InvalidQuery)?; Ok((value,vec![])) }).map_err(|e| ("orchestration_error",e.to_string()))?;
    enrich_result(&mut result);
    Ok(result)
}

pub fn create(
    bus: &crate::event_bus::EventBus,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
    named_projects_root: &std::path::Path,
    now: &str,
) -> Result<Value, (&'static str, String)> {
    if !scope.capabilities.contains("orchestration") {
        return Err(("capability_denied", "This credential does not have the orchestration capability.".into()));
    }
    let invalid = || ("invalid_request", "Invalid project create arguments.".to_owned());
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| !["title", "workspaceRoot", "createWorkspaceRootIfMissing", "defaultModelSelection", "scripts"].contains(&k.as_str())) {
        return Err(invalid());
    }
    let title = o.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200).ok_or_else(invalid)?;
    let create_missing = match o.get("createWorkspaceRootIfMissing") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(invalid()),
    };
    let denied = std::cell::RefCell::new(None);
    bus.commit(|tx| {
        require_full_access_writer(tx, scope, "change projects or environment settings", true)
            .map_err(|e| { *denied.borrow_mut() = Some(e); rusqlite::Error::InvalidQuery })?;
        Ok(((), vec![]))
    }).map_err(|e| denied.into_inner().unwrap_or_else(|| ("orchestration_error", e.to_string())))?;

    let (project_id, commit_error) = match o.get("workspaceRoot") {
        None | Some(Value::Null) => {
            let res = crate::managed_project_folders::create_new(bus, named_projects_root, title)
                .map_err(|e| ("orchestration_error", e.to_string()))?;
            (res.project_id, res.commit_error)
        }
        Some(Value::String(root)) => {
            let root = root.trim();
            if root.is_empty() { return Err(invalid()); }
            let cwd = std::env::current_dir().map_err(|e| ("orchestration_error", e.to_string()))?;
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| cwd.clone());
            let path = crate::runtime::resolve_base_dir(Some(root), &home, &cwd);
            if create_missing {
                std::fs::create_dir_all(&path).map_err(|e| ("orchestration_error", e.to_string()))?;
            }
            if !path.is_dir() {
                return Err(("invalid_request", "Project workspace must be an existing directory.".into()));
            }
            let pid = uuid::Uuid::new_v4().to_string();
            let command_id = format!("mcp:{}", uuid::Uuid::new_v4());
            let workspace = path.to_string_lossy();
            let res = crate::project_sink::create_project_ordered(
                bus,
                crate::project_commands::CreateProject {
                    command_id: &command_id,
                    project_id: &pid,
                    title,
                    workspace_root: &workspace,
                    scripts: o.get("scripts").and_then(Value::as_array).map(Vec::as_slice),
                },
                &uuid::Uuid::new_v4().to_string(),
                now,
            ).map_err(|e| ("orchestration_error", e.to_string()))?;
            if res.receipt.status != "accepted" {
                return Err(("orchestration_error", res.receipt.error.unwrap_or_else(|| "Project creation rejected.".into())));
            }
            (pid, None)
        }
        _ => return Err(invalid()),
    };

    if o.contains_key("defaultModelSelection") || (o.contains_key("scripts") && o.get("workspaceRoot").is_none_or(Value::is_null)) {
        let mut patch = serde_json::Map::new();
        patch.insert("projectId".into(), json!(project_id));
        if let Some(sel) = o.get("defaultModelSelection") { patch.insert("defaultModelSelection".into(), sel.clone()); }
        if o.get("workspaceRoot").is_none_or(Value::is_null) {
            if let Some(scripts) = o.get("scripts") { patch.insert("scripts".into(), scripts.clone()); }
        }
        let patch_val = Value::Object(patch);
        if !crate::project_update::validate(&patch_val) { return Err(invalid()); }
        let receipt = crate::project_update::dispatch_checked(bus, &format!("mcp:{}", uuid::Uuid::new_v4()), &project_id, &patch_val, now, |_| Ok(()))
            .map_err(|e| ("orchestration_error", e.to_string()))?;
        if receipt.status != "accepted" {
            return Err(("orchestration_error", receipt.error.unwrap_or_else(|| "Project update rejected.".into())));
        }
    }

    let mut result = bus.commit(|tx| {
        let value = read_including_deleted(tx, &project_id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok((value, vec![]))
    }).map_err(|e| ("orchestration_error", e.to_string()))?;
    enrich_result(&mut result);
    if let Some(err) = commit_error {
        result["commitError"] = json!(err);
    }
    Ok(result)
}

pub fn delete(
    bus: &crate::event_bus::EventBus,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
    settings: &crate::settings::Settings,
    now: &str,
) -> Result<Value, (&'static str, String)> {
    if !scope.capabilities.contains("orchestration") {
        return Err(("capability_denied", "This credential does not have the orchestration capability.".into()));
    }
    let invalid = || ("invalid_request", "Invalid project delete arguments.".to_owned());
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| !["projectId", "force"].contains(&k.as_str())) {
        return Err(invalid());
    }
    let project_id = o.get("projectId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
    let force = match o.get("force") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(invalid()),
    };
    let denied = std::cell::RefCell::new(None);
    bus.commit(|tx| {
        require_full_access_writer(tx, scope, "change projects or environment settings", false)
            .map_err(|e| { *denied.borrow_mut() = Some(e); rusqlite::Error::InvalidQuery })?;
        Ok(((), vec![]))
    }).map_err(|e| denied.into_inner().unwrap_or_else(|| ("orchestration_error", e.to_string())))?;

    let command_id = format!("mcp:{}", uuid::Uuid::new_v4());
    let outcome = crate::project_mutation::delete_with_outcome(bus, &command_id, project_id, force, now)
        .map_err(|e| ("invalid_request", e.to_string()))?;
    if outcome.deleted_workspace_root.is_some() {
        let _ = settings.update(&json!({"projectSettingsOverrides": {project_id: null}}));
    }
    let mut result = bus.commit(|tx| {
        let value = read_including_deleted(tx, project_id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok((value, vec![]))
    }).map_err(|e| ("orchestration_error", e.to_string()))?;
    enrich_result(&mut result);
    Ok(result)
}

pub fn clone_project(
    bus: &crate::event_bus::EventBus,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
    settings: &crate::settings::Settings,
) -> Result<Value, (&'static str, String)> {
    if !scope.capabilities.contains("orchestration") {
        return Err(("capability_denied", "This credential does not have the orchestration capability.".into()));
    }
    let denied = std::cell::RefCell::new(None);
    bus.commit(|tx| {
        require_full_access_writer(tx, scope, "change projects or environment settings", true)
            .map_err(|e| { *denied.borrow_mut() = Some(e); rusqlite::Error::InvalidQuery })?;
        Ok(((), vec![]))
    }).map_err(|e| denied.into_inner().unwrap_or_else(|| ("orchestration_error", e.to_string())))?;
    crate::source_control_clone::clone_repository(args, Some(settings)).map_err(|err| {
        let msg = err["message"].as_str().unwrap_or("Clone failed.").to_owned();
        ("invalid_request", msg)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    #[test]
    fn resolves_upstream_and_fork_for_project_reads_and_lists() {
        let dir = std::env::temp_dir().join(format!("mcp-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            &["init"][..],
            &["remote", "add", "origin", "git@github.com:Fork/Repo.git"],
            &[
                "remote",
                "add",
                "upstream",
                "https://github.com/Owner/Repo.git",
            ],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('a','A',?1,'[]','2026','2026')", [dir.to_str().unwrap()]).unwrap();
        let mut read = call(&db, "t3_project_read", &json!({"projectId":"a"})).unwrap();
        enrich_result(&mut read);
        let identity = &read["repositoryIdentity"];
        assert_eq!(identity["canonicalKey"], "github.com/owner/repo");
        assert_eq!(identity["locator"]["remoteName"], "upstream");
        assert_eq!(identity["origin"]["canonicalKey"], "github.com/fork/repo");
        let mut list = call(&db, "t3_project_list", &json!({})).unwrap();
        enrich_result(&mut list);
        assert_eq!(list["projects"][0]["repositoryIdentity"], *identity);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn update_requires_live_full_access_and_respects_link_fence() {
        let mut db=Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Old','/tmp','[]','now','now')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','codex','auto','default','now','now','{}')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','codex','running','now','{}')",[]).unwrap();
        let bus=crate::event_bus::EventBus::new(db,16);
        let scope=crate::mcp_credentials::Scope {thread_id:"t".into(),provider_session_id:"s".into(),provider_instance_id:"codex".into(),capabilities:std::collections::HashSet::from(["orchestration".into()]),subagent:false, client: None,};
        let args=json!({"projectId":"p","title":"New"});
        assert_eq!(update(&bus,&scope,&args,"now").unwrap_err().0,"capability_denied");
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='full-access',payload_json=json_set(payload_json,'$.linkOrigin',json(?1)) WHERE thread_id='t'",[json!({"sessionId":"l","label":"remote","access":"auto"}).to_string()])?;Ok(((),vec![]))}).unwrap();
        assert_eq!(update(&bus,&scope,&args,"now").unwrap_err().0,"capability_denied");
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin.access','full-access') WHERE thread_id='t'",[])?;Ok(((),vec![]))}).unwrap();
        assert_eq!(update(&bus,&scope,&args,"now").unwrap()["title"],"New");
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='r'",[])?;Ok(((),vec![]))}).unwrap();
        assert_eq!(update(&bus,&scope,&args,"now").unwrap_err().0,"parent_not_active");
    }
    #[test]
    fn project_paging_and_read_ignore_deleted_rows() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('a','A','/a','[]','2026','2026'),('b','B','/b','[]','2027','2027')",[]).unwrap();
        let first = call(&db, "t3_project_list", &json!({"limit":1})).unwrap();
        assert_eq!(first["projects"][0]["id"], "a");
        assert_eq!(first["nextCursor"], 1);
        let second = call(&db, "t3_project_list", &json!({"limit":1,"cursor":1})).unwrap();
        assert_eq!(second["projects"][0]["id"], "b");
        assert!(second["nextCursor"].is_null());
        assert_eq!(
            call(&db, "t3_project_read", &json!({"projectId":"a"})).unwrap()["workspaceRoot"],
            "/a"
        );
        db.execute(
            "UPDATE projection_projects SET deleted_at='2027' WHERE project_id='a'",
            [],
        )
        .unwrap();
        assert!(call(&db, "t3_project_read", &json!({"projectId":"a"})).is_err());
    }
}
