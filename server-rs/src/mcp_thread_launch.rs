use crate::{
    event_bus::EventBus,
    mcp_credentials::Scope,
    message_commands::{self, DispatchError, DispatchMessage},
    settings::Settings,
    thread_commands::{self, CreateThread},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;

type Failure = (&'static str, String);

pub fn launch_definition() -> Value {
    json!({
        "name": "t3_thread_launch",
        "description": "Create one new top-level thread, bound to its workspace before the agent starts. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. After an error or lost reply, retry with the same `clientRequestId`. Follow it with `t3_thread_read` or `t3_thread_wait`. Mention it with its `link`.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "environmentId": { "type": "string", "minLength": 1 },
                "projectId": { "type": "string", "minLength": 1 },
                "scratch": { "type": "boolean" },
                "title": { "type": "string", "minLength": 1 },
                "modelSelection": { "type": "object" },
                "runtimeMode": { "type": "string", "enum": ["approval-required", "full-access"] },
                "interactionMode": { "type": "string", "enum": ["default", "plan"] },
                "workspaceStrategy": { "type": "object" },
                "message": { "type": "string", "maxLength": 120000 },
                "attachments": { "type": "array", "maxItems": 8 },
                "clientRequestId": { "type": "string", "minLength": 1, "maxLength": 256 },
                "delegatedFrom": { "type": "object" }
            },
            "required": ["title"],
            "additionalProperties": false
        },
        "annotations": {
            "destructiveHint": true,
            "openWorldHint": true
        }
    })
}

pub fn create_threads_definition() -> Value {
    json!({
        "name": "create_threads",
        "description": "Create new top-level threads in this checkout. Not delegation. One thread or its own worktree: `t3_thread_launch`. Project, branch, and worktree inherit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "threads": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": { "type": "string", "minLength": 1, "maxLength": 120000 },
                            "title": { "type": "string", "minLength": 1, "maxLength": 512 },
                            "target": { "type": "object" },
                            "runtimeMode": { "type": "string", "enum": ["approval-required", "full-access"] },
                            "interactionMode": { "type": "string", "enum": ["default", "plan"] }
                        },
                        "additionalProperties": false
                    }
                },
                "clientRequestId": { "type": "string", "minLength": 1, "maxLength": 256 }
            },
            "required": ["threads"],
            "additionalProperties": false
        },
        "annotations": {
            "title": "Create T3 threads",
            "destructiveHint": true,
            "openWorldHint": true
        }
    })
}

fn runtime_rank(mode: &str) -> Option<u8> {
    match mode {
        "approval-required" => Some(0),
        "full-access" => Some(1),
        _ => None,
    }
}

fn interaction_rank(mode: &str) -> Option<u8> {
    match mode {
        "plan" => Some(0),
        "default" => Some(1),
        _ => None,
    }
}

fn cap_runtime_mode(requested: Option<&str>, ceiling: &str) -> Result<String, Failure> {
    let ceiling_rank = runtime_rank(ceiling)
        .ok_or_else(|| ("invalid_request", format!("Unsupported runtimeMode: {ceiling}")))?;
    match requested {
        None => Ok(ceiling.to_owned()),
        Some(mode) => {
            let req_rank = runtime_rank(mode)
                .ok_or_else(|| ("invalid_request", format!("Unsupported runtimeMode: {mode}")))?;
            if req_rank > ceiling_rank {
                return Err((
                    "runtime_mode_escalation_denied",
                    "Requested runtimeMode exceeds caller's runtimeMode.".into(),
                ));
            }
            Ok(mode.to_owned())
        }
    }
}

fn cap_interaction_mode(requested: Option<&str>, ceiling: &str) -> Result<String, Failure> {
    let ceiling_rank = interaction_rank(ceiling)
        .ok_or_else(|| ("invalid_request", format!("Unsupported interactionMode: {ceiling}")))?;
    match requested {
        None => Ok(ceiling.to_owned()),
        Some(mode) => {
            let req_rank = interaction_rank(mode)
                .ok_or_else(|| ("invalid_request", format!("Unsupported interactionMode: {mode}")))?;
            if req_rank > ceiling_rank {
                return Err((
                    "interaction_mode_escalation_denied",
                    "Requested interactionMode exceeds caller's interactionMode.".into(),
                ));
            }
            Ok(mode.to_owned())
        }
    }
}

fn deterministic_id(prefix: &str, namespace: &str, key: &str) -> String {
    use std::fmt::Write;
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&(namespace, key)).unwrap_or_default());
    let mut digest = String::with_capacity(32);
    for b in &hasher.finalize()[..16] {
        let _ = write!(digest, "{b:02x}");
    }
    format!("{prefix}{digest}")
}

fn reject_read_only_client(scope: &Scope) -> Result<(), Failure> {
    if let Some(client) = scope.client.as_ref() {
        if client.access == "read-only" {
            return Err((
                "capability_denied",
                "This MCP client is read-only and cannot launch threads.".into(),
            ));
        }
    }
    Ok(())
}

pub async fn launch(
    bus: &EventBus,
    settings: &Settings,
    scope: &Scope,
    environment_id: &str,
    args: &Value,
) -> Result<Value, Failure> {
    reject_read_only_client(scope)?;
    let Some(obj) = args.as_object() else {
        return Err(("invalid_request", "Arguments must be a JSON object.".into()));
    };
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("invalid_request", "title is required.".into()))?
        .to_owned();

    let scratch = match obj.get("scratch") {
        None => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(("invalid_request", "scratch must be a boolean.".into())),
    };
    if scratch && (obj.contains_key("projectId") || obj.contains_key("workspaceStrategy")) {
        return Err((
            "invalid_request",
            "scratch cannot be combined with projectId or workspaceStrategy.".into(),
        ));
    }

    let client_request_id = match obj.get("clientRequestId") {
        None => None,
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.encode_utf16().count() > 256 {
                return Err(("invalid_request", "Invalid clientRequestId.".into()));
            }
            Some(trimmed.to_owned())
        }
        _ => return Err(("invalid_request", "clientRequestId must be a string.".into())),
    };

    let message = match obj.get("message") {
        None => None,
        Some(Value::String(s)) => {
            if s.encode_utf16().count() > 120_000 {
                return Err(("invalid_request", "message exceeds 120000 characters.".into()));
            }
            Some(s.clone())
        }
        _ => return Err(("invalid_request", "message must be a string.".into())),
    };

    let namespace = if !scope.thread_id.is_empty() {
        scope.thread_id.as_str()
    } else if !scope.provider_session_id.is_empty() {
        scope.provider_session_id.as_str()
    } else {
        "client"
    };
    let (command_id, thread_id) = match client_request_id.as_deref() {
        Some(key) => {
            let id = deterministic_id("mcp:launch:", namespace, key);
            (id.clone(), id)
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            (id.clone(), id)
        }
    };

    let has_explicit_strategy = obj.contains_key("workspaceStrategy");
    let strategy_arg = obj
        .get("workspaceStrategy")
        .filter(|v| !v.is_null())
        .cloned();
    if let Some(ref strategy) = strategy_arg {
        let strategy_type = strategy
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ("invalid_request", "workspaceStrategy.type is required.".into()))?;
        if !matches!(strategy_type, "root" | "existing_worktree" | "worktree") {
            return Err(("invalid_request", "Invalid workspaceStrategy.type.".into()));
        }
        if strategy_type == "worktree"
            && strategy
                .get("baseRef")
                .and_then(Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(("invalid_request", "workspaceStrategy.baseRef is required.".into()));
        }
    }
    let strategy = strategy_arg.unwrap_or_else(|| json!({ "type": "root" }));

    let snapshot = settings.snapshot();
    let requested_runtime = obj.get("runtimeMode").and_then(Value::as_str);
    let requested_interaction = obj.get("interactionMode").and_then(Value::as_str);
    let requested_project = obj
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let denied = RefCell::new(None::<Failure>);

    // Phase 1: check replay / resolve caller limits & project & workspace metadata.
    let preflight = bus
        .with_autocommit(|db| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            let existing: Option<(String, String, String)> = db
                .query_row(
                    "SELECT project_id, title, payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                    [&thread_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((pid, existing_title, payload_raw)) = existing {
                let payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({}));
                let latest_run: Option<(String, String)> = db
                    .query_row(
                        "SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal DESC LIMIT 1",
                        [&thread_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                return Ok((
                    true,
                    pid,
                    String::new(),
                    payload["runtimeMode"].as_str().unwrap_or("full-access").to_owned(),
                    payload["interactionMode"].as_str().unwrap_or("default").to_owned(),
                    payload["modelSelection"].clone(),
                    None::<Value>,
                    existing_title,
                    latest_run,
                ));
            }

            let mut max_runtime = scope
                .client
                .as_ref()
                .map(|c| c.runtime_mode.as_str().to_owned())
                .unwrap_or_else(|| "full-access".to_owned());
            let mut max_interaction = scope
                .client
                .as_ref()
                .map(|c| c.interaction_mode.as_str().to_owned())
                .unwrap_or_else(|| "default".to_owned());
            let mut caller_project: Option<String> = None;
            let mut caller_model: Option<Value> = None;
            let mut link_origin: Option<Value> = None;

            if !scope.thread_id.is_empty() {
                let caller: Option<(String, String, String, String)> = db
                    .query_row(
                        "SELECT project_id, runtime_mode, interaction_mode, payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                        [&scope.thread_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )
                    .optional()?;
                let (cpid, crt, cit, craw) = caller.ok_or_else(|| {
                    reject(("thread_not_found", "The calling thread was not found.".into()))
                })?;
                if runtime_rank(&crt) < runtime_rank(&max_runtime) {
                    max_runtime = crt;
                }
                if interaction_rank(&cit) < interaction_rank(&max_interaction) {
                    max_interaction = cit;
                }
                caller_project = Some(cpid);
                let cjson: Value = serde_json::from_str(&craw).unwrap_or_else(|_| json!({}));
                if cjson.get("modelSelection").is_some_and(Value::is_object) {
                    caller_model = Some(cjson["modelSelection"].clone());
                }
                if !cjson["linkOrigin"].is_null() {
                    link_origin = Some(cjson["linkOrigin"].clone());
                }
            }

            let runtime_mode = cap_runtime_mode(requested_runtime, &max_runtime).map_err(reject)?;
            let interaction_mode =
                cap_interaction_mode(requested_interaction, &max_interaction).map_err(reject)?;

            let project_id = if let Some(pid) = requested_project.clone() {
                pid
            } else if scratch {
                let existing_scratch: Option<String> = db
                    .query_row(
                        "SELECT project_id FROM projection_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .optional()?;
                existing_scratch.ok_or_else(|| {
                    reject((
                        "project_not_found",
                        "No project available for scratch thread; pass projectId.".into(),
                    ))
                })?
            } else if let Some(cpid) = caller_project {
                cpid
            } else {
                return Err(reject((
                    "invalid_request",
                    "projectId is required when launching outside a thread.".into(),
                )));
            };

            let workspace_root: Option<String> = db
                .query_row(
                    "SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",
                    [&project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let workspace_root = workspace_root.ok_or_else(|| {
                reject(("project_not_found", format!("Project {project_id} was not found.")))
            })?;

            let model_selection = obj
                .get("modelSelection")
                .filter(|v| v.is_object())
                .cloned()
                .or(caller_model)
                .or_else(|| {
                    snapshot["projectSettingsOverrides"][&project_id]["defaultModelSelection"]
                        .is_object()
                        .then(|| {
                            snapshot["projectSettingsOverrides"][&project_id]
                                ["defaultModelSelection"]
                                .clone()
                        })
                })
                .or_else(|| {
                    snapshot["defaultModelSelection"]
                        .is_object()
                        .then(|| snapshot["defaultModelSelection"].clone())
                })
                .unwrap_or_else(|| json!({ "instanceId": "codex", "model": "gpt-5.4" }));

            Ok((
                false,
                project_id,
                workspace_root,
                runtime_mode,
                interaction_mode,
                model_selection,
                link_origin,
                title.clone(),
                None,
            ))
        })
        .map_err(|e| ("orchestration_error", format!("Database error: {e}")))?
        .map_err(|_| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("orchestration_error", "Failed to prepare thread launch.".into()))
        })?;

    let (
        replaying,
        project_id,
        workspace_root,
        runtime_mode,
        interaction_mode,
        model_selection,
        link_origin,
        resolved_title,
        existing_run,
    ) = preflight;

    if replaying {
        let (run_id, status) = match existing_run {
            Some((r, s)) => (json!(r), json!(s)),
            None => (Value::Null, Value::Null),
        };
        return Ok(json!({
            "threadId": thread_id,
            "link": crate::mcp_http::thread_link(environment_id, &thread_id, Some(&resolved_title)),
            "projectId": project_id,
            "modelSelection": model_selection,
            "runId": run_id,
            "status": status,
        }));
    }

    let strategy = if !has_explicit_strategy && !scratch && link_origin.is_none() && scope.thread_id.is_empty() {
        let project_mode = snapshot["projectSettingsOverrides"][&project_id]["defaultThreadEnvMode"]
            .as_str()
            .or_else(|| snapshot["defaultThreadEnvMode"].as_str())
            .map(str::to_owned)
            .or_else(|| {
                std::fs::read_to_string(std::path::Path::new(&workspace_root).join("t3.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v["defaultThreadEnvMode"].as_str().map(str::to_owned))
            });
        if project_mode.as_deref() == Some("worktree") {
            let root = workspace_root.clone();
            let start_from_origin = snapshot["projectSettingsOverrides"][&project_id]["newWorktreesStartFromOrigin"]
                .as_bool()
                .or_else(|| snapshot["newWorktreesStartFromOrigin"].as_bool())
                .unwrap_or(false);
            let default_res = tokio::task::spawn_blocking(move || -> Result<Option<Value>, String> {
                let commit = std::process::Command::new("git")
                    .current_dir(&root)
                    .args(["rev-parse", "--verify", "--quiet", "HEAD"])
                    .output()
                    .map_err(|_| "Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.".to_owned())?;
                if !commit.status.success() {
                    let stderr = String::from_utf8_lossy(&commit.stderr);
                    let non_repo = stderr.to_ascii_lowercase().contains("fatal: not a git repository")
                        || stderr.to_ascii_lowercase().contains("gitfile does not point to a valid repository");
                    if commit.status.code() == Some(1) || non_repo {
                        return Ok(None);
                    }
                    return Err("Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.".to_owned());
                }
                let head = std::process::Command::new("git")
                    .current_dir(&root)
                    .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
                    .output()
                    .map_err(|_| "Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.".to_owned())?;
                if head.status.code() == Some(1) {
                    return Ok(None);
                }
                let branch = if head.status.success() {
                    String::from_utf8_lossy(&head.stdout).trim().to_owned()
                } else {
                    String::new()
                };
                if branch.is_empty() {
                    return Err("Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.".to_owned());
                }
                Ok(Some(json!({
                    "type": "worktree",
                    "baseRef": branch,
                    "startFromOrigin": start_from_origin,
                })))
            })
            .await
            .map_err(|_| ("orchestration_error", "Worktree check worker failed.".into()))?
            .map_err(|e| ("orchestration_error", e))?;
            default_res.unwrap_or(strategy)
        } else {
            strategy
        }
    } else {
        strategy
    };
    let strategy_type = strategy.get("type").and_then(Value::as_str).unwrap_or("root");

    let mut branch = strategy
        .get("branch")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut worktree_path = if strategy_type == "existing_worktree" {
        let path = strategy
            .get("worktreePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ("invalid_request", "workspaceStrategy.worktreePath is required.".into()))?;
        if !std::path::Path::new(path).is_dir() {
            return Err(("invalid_request", "workspaceStrategy.worktreePath does not exist.".into()));
        }
        Some(path.to_owned())
    } else {
        None
    };

    let mut preparation = None;
    if strategy_type == "worktree" {
        let owned_bus = bus.clone();
        let snap = snapshot.clone();
        let cmd = command_id.clone();
        let tid = thread_id.clone();
        let pid = project_id.clone();
        let root = workspace_root.clone();
        let base_ref = strategy["baseRef"].as_str().unwrap().to_owned();
        let b = branch.clone();
        let origin = strategy
            .get("startFromOrigin")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                snapshot["projectSettingsOverrides"][&project_id]["newWorktreesStartFromOrigin"]
                    .as_bool()
                    .or_else(|| snapshot["newWorktreesStartFromOrigin"].as_bool())
                    .unwrap_or(false)
            });
        let now_copy = now.clone();
        let p = tokio::task::spawn_blocking(move || {
            crate::thread_launch::prepare_worktree(
                &owned_bus, &snap, &cmd, &tid, &pid, &root, &base_ref, b.as_deref(), origin, &now_copy,
            )
        })
        .await
        .map_err(|_| ("orchestration_error", "Worktree preparation worker failed.".into()))?
        .map_err(|e| ("orchestration_error", e))?;
        worktree_path = Some(p.worktree_path.clone());
        branch = Some(p.branch.clone());
        preparation = Some(p);
    }

    let creation_source = json!("mcp");
    let delegated_from = obj.get("delegatedFrom").filter(|v| v.is_object());
    let create_res = thread_commands::create_thread_ordered(
        bus,
        CreateThread {
            command_id: &command_id,
            thread_id: &thread_id,
            project_id: &project_id,
            title: &title,
            model_selection: &model_selection,
            runtime_mode: &runtime_mode,
            interaction_mode: &interaction_mode,
            branch: branch.as_deref(),
            worktree_path: worktree_path.as_deref(),
            created_by: "agent",
            creation_source: &creation_source,
            link_origin: link_origin.as_ref(),
            delegated_from,
        },
        &uuid::Uuid::new_v4().to_string(),
        &now,
    );

    if let Err(err) = create_res {
        if let Some(p) = preparation.as_ref() {
            crate::thread_launch::cleanup(bus, p);
        }
        return Err(("orchestration_error", format!("Could not create thread: {err}")));
    }

    if let Some(p) = preparation.as_ref() {
        crate::thread_launch::mark_attached(bus, p)
            .map_err(|e| ("orchestration_error", e))?;
        let owned_bus = bus.clone();
        let pid = project_id.clone();
        let root = workspace_root.clone();
        let tid = thread_id.clone();
        let path = worktree_path.clone().unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            crate::thread_launch::setup(&owned_bus, &pid, &root, &tid, &path)
        })
        .await
        .map_err(|_| ("orchestration_error", "Worktree setup worker failed.".into()))?
        .map_err(|e| ("orchestration_error", e))?;
    }

    let mut run_id = Value::Null;
    let mut status = Value::Null;

    if let Some(msg_text) = message.as_deref().filter(|s| !s.is_empty()) {
        let cwd = worktree_path.as_deref().unwrap_or(workspace_root.as_str());
        let msg_cmd_id = format!("{command_id}:initial-message");
        let msg_id = command_id.clone();
        let driver = model_selection
            .get("instanceId")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        let sender = (!scope.thread_id.is_empty()).then_some(scope.thread_id.as_str());
        let dispatch_res = bus
            .commit_with(|tx| {
                let cmd = DispatchMessage {
                    context: None,
                    command_id: &msg_cmd_id,
                    thread_id: &thread_id,
                    message_id: &msg_id,
                    text: msg_text,
                    attachments: &[],
                    creation_source: "mcp",
                    cwd,
                    driver,
                };
                message_commands::dispatch_message_tx_with_sender(
                    tx, cmd, &now, true, None, None, sender,
                )
            })
            .map_err(|e| ("orchestration_error", format!("Could not dispatch initial message: {e}")))?;

        if dispatch_res.receipt.status != "accepted" {
            return Err((
                "orchestration_error",
                dispatch_res
                    .receipt
                    .error
                    .unwrap_or_else(|| "Initial message dispatch rejected.".into()),
            ));
        }

        let run_info = bus
            .with_autocommit(|db| {
                db.query_row(
                    "SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal DESC LIMIT 1",
                    [&thread_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
            })
            .map_err(|e| ("orchestration_error", e.to_string()))?
            .map_err(|e| ("orchestration_error", e.to_string()))?;
        if let Some((r, s)) = run_info {
            run_id = json!(r);
            status = json!(s);
        }
    }

    Ok(json!({
        "threadId": thread_id,
        "link": crate::mcp_http::thread_link(environment_id, &thread_id, Some(&title)),
        "projectId": project_id,
        "modelSelection": model_selection,
        "runId": run_id,
        "status": status,
    }))
}

pub async fn create_threads(
    bus: &EventBus,
    scope: &Scope,
    environment_id: &str,
    args: &Value,
) -> Result<Value, Failure> {
    reject_read_only_client(scope)?;
    if scope.thread_id.is_empty() {
        return Err((
            "invalid_request",
            "create_threads requires a thread-scoped MCP session.".into(),
        ));
    }
    let Some(obj) = args.as_object() else {
        return Err(("invalid_request", "Arguments must be a JSON object.".into()));
    };
    let items = obj
        .get("threads")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.len() <= 20)
        .ok_or_else(|| ("invalid_request", "threads must contain 1 to 20 items.".into()))?;

    let client_request_id = match obj.get("clientRequestId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.encode_utf16().count() > 256 {
                return Err(("invalid_request", "Invalid clientRequestId.".into()));
            }
            trimmed.to_owned()
        }
        _ => return Err(("invalid_request", "clientRequestId must be a string.".into())),
    };

    let denied = RefCell::new(None::<Failure>);
    let parent = bus
        .with_autocommit(|db| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            let row: Option<(String, String, String, String, Option<String>)> = db
                .query_row(
                    "SELECT t.project_id, t.runtime_mode, t.interaction_mode, t.payload_json, p.workspace_root FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL",
                    [&scope.thread_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()?;
            let (project_id, runtime_mode, interaction_mode, raw, workspace_root) = row.ok_or_else(|| {
                reject(("thread_not_found", "The calling thread was not found.".into()))
            })?;
            let active: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=?1 AND r.status IN ('preparing','starting','running','waiting') AND r.provider_instance_id=?2)",
                params![scope.thread_id, scope.provider_instance_id],
                |r| r.get(0),
            )?;
            if !active {
                return Err(reject((
                    "parent_not_active",
                    "The calling provider no longer owns an active thread run.".into(),
                )));
            }
            let payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
            Ok((
                project_id,
                runtime_mode,
                interaction_mode,
                payload,
                workspace_root.unwrap_or_default(),
            ))
        })
        .map_err(|e| ("orchestration_error", e.to_string()))?
        .map_err(|_| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("orchestration_error", "Failed to load calling thread.".into()))
        })?;

    let (project_id, parent_rt, parent_it, parent_payload, workspace_root) = parent;
    let parent_branch = parent_payload["branch"].as_str().map(str::to_owned);
    let parent_worktree = parent_payload["worktreePath"].as_str().map(str::to_owned);
    let link_origin = (!parent_payload["linkOrigin"].is_null()).then(|| parent_payload["linkOrigin"].clone());
    let base_model = if parent_payload["modelSelection"].is_object() {
        parent_payload["modelSelection"].clone()
    } else {
        json!({ "instanceId": scope.provider_instance_id, "model": "gpt-5.4" })
    };

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let creation_source = json!("mcp");
    let mut created = Vec::with_capacity(items.len());

    for (idx, item) in items.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            return Err(("invalid_request", "Each thread entry must be an object.".into()));
        };
        let title = item_obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("New thread")
            .to_owned();
        if title.encode_utf16().count() > 512 {
            return Err(("invalid_request", "Thread title exceeds 512 characters.".into()));
        }
        let prompt = match item_obj.get("prompt") {
            None => None,
            Some(Value::String(s)) => {
                let t = s.trim();
                if t.is_empty() || s.encode_utf16().count() > 120_000 {
                    return Err(("invalid_request", "Invalid thread prompt.".into()));
                }
                Some(s.clone())
            }
            _ => return Err(("invalid_request", "prompt must be a string.".into())),
        };
        let runtime_mode = cap_runtime_mode(
            item_obj.get("runtimeMode").and_then(Value::as_str),
            &parent_rt,
        )?;
        let interaction_mode = cap_interaction_mode(
            item_obj.get("interactionMode").and_then(Value::as_str),
            &parent_it,
        )?;

        let mut model_selection = base_model.clone();
        if let Some(target) = item_obj.get("target").and_then(Value::as_object) {
            if let Some(inst) = target.get("providerInstanceId").and_then(Value::as_str) {
                model_selection["instanceId"] = json!(inst);
            }
            if let Some(model) = target.get("model").and_then(Value::as_str) {
                model_selection["model"] = json!(model);
            }
        }

        let key = format!("{client_request_id}:create-thread:{idx}");
        let command_id = deterministic_id("mcp:create:", &scope.thread_id, &key);
        let thread_id = command_id.clone();

        thread_commands::create_thread_ordered(
            bus,
            CreateThread {
                command_id: &command_id,
                thread_id: &thread_id,
                project_id: &project_id,
                title: &title,
                model_selection: &model_selection,
                runtime_mode: &runtime_mode,
                interaction_mode: &interaction_mode,
                branch: parent_branch.as_deref(),
                worktree_path: parent_worktree.as_deref(),
                created_by: "agent",
                creation_source: &creation_source,
                link_origin: link_origin.as_ref(),
                delegated_from: None,
            },
            &uuid::Uuid::new_v4().to_string(),
            &now,
        )
        .map_err(|e| ("orchestration_error", format!("Could not create thread: {e}")))?;

        let mut run_id = Value::Null;
        let mut status = json!("idle");

        if let Some(prompt_text) = prompt.as_deref() {
            let cwd = parent_worktree.as_deref().unwrap_or(workspace_root.as_str());
            let msg_cmd_id = format!("{command_id}:dispatch-thread");
            let msg_id = format!("{command_id}:message");
            let driver = model_selection
                .get("instanceId")
                .and_then(Value::as_str)
                .unwrap_or("codex");
            let dispatch_res = bus
                .commit_with(|tx| {
                    let cmd = DispatchMessage {
                        context: None,
                        command_id: &msg_cmd_id,
                        thread_id: &thread_id,
                        message_id: &msg_id,
                        text: prompt_text,
                        attachments: &[],
                        creation_source: "mcp",
                        cwd,
                        driver,
                    };
                    message_commands::dispatch_message_tx_with_sender(
                        tx,
                        cmd,
                        &now,
                        true,
                        None,
                        None,
                        Some(&scope.thread_id),
                    )
                })
                .map_err(|e: DispatchError| ("orchestration_error", format!("Dispatch failed: {e}")))?;
            if dispatch_res.receipt.status != "accepted" {
                return Err((
                    "orchestration_error",
                    dispatch_res
                        .receipt
                        .error
                        .unwrap_or_else(|| "Message dispatch rejected.".into()),
                ));
            }
            let run_info = bus
                .with_autocommit(|db| {
                    db.query_row(
                        "SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal DESC LIMIT 1",
                        [&thread_id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()
                })
                .map_err(|e| ("orchestration_error", e.to_string()))?
                .map_err(|e| ("orchestration_error", e.to_string()))?;
            if let Some((r, s)) = run_info {
                run_id = json!(r);
                status = json!(s);
            }
        }

        created.push(json!({
            "threadId": thread_id,
            "link": crate::mcp_http::thread_link(environment_id, &thread_id, Some(&title)),
            "runId": run_id,
            "status": status,
            "title": title,
            "createdBy": "agent",
            "creationSource": "mcp",
            "providerInstanceId": model_selection["instanceId"],
            "model": model_selection["model"],
        }));
    }

    Ok(json!({ "threads": created }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn launch_and_create_threads_enforce_modes_and_idempotency() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = "2026-11-15T00:00:00.000Z";
        let workspace = std::env::temp_dir().join(format!("t3-launch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        db.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES ('proj-1', 'Repo', ?1, '{\"instanceId\":\"codex\",\"model\":\"gpt-5.4\"}', '[]', ?2, ?2, NULL)",
            params![workspace.to_string_lossy().to_string(), now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json) VALUES ('parent-1', 'proj-1', 'Parent', 'codex', 'codex', 'approval-required', 'default', NULL, ?1, ?1, NULL, NULL, '{\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"gpt-5.4\"}}')",
            [now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json) VALUES ('run-1', 'parent-1', 1, 'codex', 'codex', 'running', ?1, '{\"id\":\"run-1\",\"status\":\"running\",\"ordinal\":1,\"providerInstanceId\":\"codex\"}')",
            [now],
        )
        .unwrap();

        let bus = EventBus::new(db, 64);
        let settings = Settings::new(workspace.join("settings.json"));
        let scope = Scope {
            thread_id: "parent-1".into(),
            provider_instance_id: "codex".into(),
            provider_session_id: "sess-1".into(),
            ..Default::default()
        };

        // Mode escalation must be denied.
        let err = launch(
            &bus,
            &settings,
            &scope,
            "env-1",
            &json!({ "title": "Escalated", "runtimeMode": "full-access" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, "runtime_mode_escalation_denied");

        // Idempotent launch with message.
        let args = json!({
            "title": "Child launch",
            "message": "hello child",
            "clientRequestId": "req-launch-1"
        });
        let first = launch(&bus, &settings, &scope, "env-1", &args).await.unwrap();
        let second = launch(&bus, &settings, &scope, "env-1", &args).await.unwrap();
        assert_eq!(first["threadId"], second["threadId"]);
        assert!(first["runId"].is_string());

        // create_threads creates batch sequentially.
        let batch = create_threads(
            &bus,
            &scope,
            "env-1",
            &json!({
                "clientRequestId": "batch-1",
                "threads": [
                    { "title": "T1", "prompt": "do 1" },
                    { "title": "T2" }
                ]
            }),
        )
        .await
        .unwrap();
        let arr = batch["threads"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["title"], "T1");
        assert!(arr[0]["runId"].is_string());
        assert_eq!(arr[1]["title"], "T2");
        assert!(arr[1]["runId"].is_null());
    }
}
