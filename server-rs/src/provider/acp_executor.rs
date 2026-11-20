//! Shared ACP-backed provider turn execution for explicit local agent commands.
use crate::{
    effect_worker::Execution,
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        acp::{AcpCancelHandle, AcpEvent, AcpLaunch, AcpReply, AcpResponder, AcpSession},
        codex_events::{
            AssistantArtifact, FailureClass, NormalizedEvent, ProviderFailure, ReasoningArtifact,
            RootTurn, ThreadDisposition, ToolArtifact, TurnStatus,
        },
        ingest, lifecycle,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

#[derive(Clone)]
struct PersistentGrokCommand {
    turn: RootTurn,
    instance: String,
    tool_id: String,
    input: String,
    ordinal: u64,
    started: String,
}
type PersistentGrokCommands = Arc<Mutex<HashMap<String, PersistentGrokCommand>>>;

struct Active {
    session: Arc<Mutex<AcpSession>>,
    cancel: AcpCancelHandle,
    services: Arc<Mutex<super::acp_client::ClientServices>>,
    provider_session_id: String,
    has_mcp: bool,
    instruction_mode: Option<String>,
    runtime_instructions: Option<String>,
    thread_id: String,
    cancelled: Arc<AtomicBool>,
    idle_stop: Arc<AtomicBool>,
    idle_started: Arc<AtomicBool>,
    idle_source: Arc<Mutex<Option<(RootTurn, Value)>>>,
    persistent_commands: PersistentGrokCommands,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
struct Approval {
    thread: String,
    options: Vec<Value>,
    reply: std::sync::mpsc::Sender<Value>,
}
static APPROVALS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
fn approvals() -> &'static Mutex<HashMap<String, Approval>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deliver an explicitly chosen application approval to the waiting ACP request.
pub fn deliver_approval(id: &str, decision: Option<&str>) -> Result<(), String> {
    let decision = decision.ok_or("Missing approval decision")?;
    if !matches!(
        decision,
        "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
    ) {
        return Err("Invalid approval decision".into());
    }
    let mut pending = approvals()
        .lock()
        .map_err(|_| "ACP approval registry unavailable")?;
    let request = pending.get(id).ok_or("Unknown or expired ACP request")?;
    let preferred: &[&str] = match decision {
        "accept" => &["allow_once", "allow_always"],
        "acceptForSession" | "acceptAlways" => &["allow_always", "allow_once"],
        "decline" => &["reject_once", "reject_always"],
        _ => &[],
    };
    let selected = preferred.iter().find_map(|kind| {
        request
            .options
            .iter()
            .find(|o| o["kind"] == *kind)
            .and_then(|o| o["optionId"].as_str())
            .filter(|s| !s.is_empty())
    });
    let answer = if let Some(option_id) = selected {
        json!({"outcome":{"outcome":"selected","optionId":option_id}})
    } else if decision == "cancel" {
        json!({"outcome":{"outcome":"cancelled"}})
    } else {
        return Err("The ACP agent did not offer that approval choice".into());
    };
    pending
        .remove(id)
        .ok_or("Unknown or expired ACP request")?
        .reply
        .send(answer)
        .map_err(|_| "ACP approval is no longer active".into())
}
pub(crate) fn cancel_approvals(thread: &str) {
    if let Ok(mut pending) = approvals().lock() {
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, a)| a.thread == thread)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(a) = pending.remove(&id) {
                let _ = a.reply.send(json!({"outcome":{"outcome":"cancelled"}}));
            }
        }
    }
}
pub(crate) fn request_approval(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    id: &Value,
    params: &Value,
    ordinal: u64,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    request_approval_with_parent(bus, turn, session, id, params, ordinal, cancelled, None)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn request_approval_with_parent(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    id: &Value,
    params: &Value,
    ordinal: u64,
    cancelled: &AtomicBool,
    parent_node: Option<&str>,
) -> Result<Value, String> {
    let native = match id {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err("Invalid ACP request id".into()),
    };
    let options = params["options"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("Missing ACP approval options")?
        .clone();
    let tool = &params["toolCall"];
    let native_item = tool["toolCallId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&native);
    let kind = match tool["kind"].as_str() {
        Some("read" | "search") => "file-read",
        Some("edit" | "delete" | "move") => "file-change",
        _ => "command",
    };
    let id = format!(
        "runtime-request:provider:{}:{}:{}",
        turn.driver,
        turn.provider_turn_id,
        uuid::Uuid::new_v4()
    );
    let node = format!("node:runtime-request:{id}");
    let item = format!("turn-item:runtime-request:{id}");
    let at = timestamp();
    let reference = json!({"driver":turn.driver,"nativeId":native_item,"strength":if turn.driver=="pi" {"strong"} else {"weak"}});
    let node_value = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":parent_node.unwrap_or(&turn.root_node_id),"rootNodeId":turn.root_node_id,"kind":"approval_request","status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let request = json!({"id":id,"nodeId":node,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":{"driver":turn.driver,"nativeId":native_item,"strength":if turn.driver=="pi" {"strong"} else {"weak"}},"kind":kind,"status":"pending","responseCapability":{"type":"live","providerSessionId":session},"createdAt":at,"resolvedAt":null});
    let item_value = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"approval_request","requestId":id,"requestKind":kind,"prompt":tool["title"].as_str().unwrap_or("Approval requested")});
    let artifact = super::codex_requests::RequestArtifacts {
        request,
        node: node_value,
        item: item_value,
        method: "acp:approval".into(),
        params: params.clone(),
    };
    let (tx, rx) = std::sync::mpsc::channel();
    {
        // Admission and projection are serialized with cancellation, so a late
        // agent request cannot appear after the turn was already settled.
        let mut pending = approvals()
            .lock()
            .map_err(|_| "ACP approval registry unavailable")?;
        if cancelled.load(Ordering::Acquire) {
            return Ok(json!({"outcome":{"outcome":"cancelled"}}));
        }
        pending.insert(
            id.clone(),
            Approval {
                thread: turn.thread_id.clone(),
                options,
                reply: tx,
            },
        );
        if let Err(e) = super::codex_requests::ingest(bus, turn, &artifact, &at) {
            pending.remove(&id);
            return Err(e.to_string());
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(1800);
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            break Ok(json!({"outcome":{"outcome":"cancelled"}}));
        }
        if std::time::Instant::now() >= deadline {
            break Err("ACP approval expired".to_owned());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => break Ok(value),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break Err("ACP approval closed".to_owned())
            }
        }
    };
    if let Ok(mut pending) = approvals().lock() {
        pending.remove(&id);
    }
    result
}

fn sessions() -> &'static Mutex<HashMap<String, Active>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn is_active(provider_thread_id: &str) -> bool {
    sessions().lock().is_ok_and(|map| {
        map.get(provider_thread_id)
            .is_some_and(|entry| !entry.cancelled.load(Ordering::Acquire))
    })
}
pub(crate) fn has_provider_thread(provider_thread_id: &str, thread_id: &str) -> bool {
    sessions().lock().is_ok_and(|registry| {
        registry
            .get(provider_thread_id)
            .is_some_and(|active| active.thread_id == thread_id)
    })
}
pub(crate) fn has_session(provider_session_id: &str, thread_id: &str) -> bool {
    sessions().lock().is_ok_and(|registry| {
        registry.values().any(|active| {
            active.provider_session_id == provider_session_id && active.thread_id == thread_id
        })
    })
}
/// Release the process attached to a detached provider session.
pub fn detach(provider_session_id: &str, thread_id: &str) -> Result<(), String> {
    cancel_approvals(thread_id);
    let mut registry = sessions()
        .lock()
        .map_err(|_| "ACP session registry unavailable")?;
    let keys: Vec<_> = registry
        .iter()
        .filter(|(_, a)| a.provider_session_id == provider_session_id && a.thread_id == thread_id)
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        if let Some(active) = registry.remove(&key) {
            active.cancelled.store(true, Ordering::Release);
            active.idle_stop.store(true, Ordering::Release);
            if let Ok(mut svc) = active.services.lock() {
                svc.cancel_terminals();
            }
            let _ = active.cancel.cancel();
        }
    }
    Ok(())
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

enum CopilotToolIdentity {
    Search,
    Mcp { server: String, tool: String },
}

impl CopilotToolIdentity {
    fn from_event(data: &Value) -> Option<Self> {
        let server = data["mcpServerName"].as_str().unwrap_or_default().trim();
        let tool = data["mcpToolName"].as_str().unwrap_or_default().trim();
        if !server.is_empty() && !tool.is_empty() {
            return Some(Self::Mcp { server: server.into(), tool: tool.into() });
        }
        matches!(data["toolName"].as_str(), Some("glob" | "grep")).then_some(Self::Search)
    }
}

fn acp_tool_projection(state: &Value, identity: Option<&CopilotToolIdentity>) -> (&'static str, Value) {
    let input = &state["rawInput"];
    let output = &state["content"];
    match identity {
        Some(CopilotToolIdentity::Search) => {
            let mut fields = json!({});
            if let Some(pattern) = ["pattern", "query", "path"]
                .iter()
                .find_map(|key| input[*key].as_str())
            {
                fields["pattern"] = json!(pattern);
            }
            ("file_search", fields)
        }
        Some(CopilotToolIdentity::Mcp { server, tool }) => (
            "dynamic_tool",
            json!({"toolName":format!("{server}.{tool}"),"input":input,"output":output}),
        ),
        None => (
            "dynamic_tool",
            json!({"toolName":state["title"].as_str().unwrap_or("ACP tool"),"input":input,"output":output}),
        ),
    }
}

/// Called by the shared effect dispatcher after resolving the configured driver.
pub fn execute<'a>(
    bus: &'a EventBus,
    effect: &'a Effect,
    settings_path: Option<&'a Path>,
    attachments_dir: &'a Path,
    registry: &'a Arc<super::session_registry::SessionRegistry>,
    mcp: Option<(&'a str, &'a Arc<super::session_registry::SessionRegistry>)>,
) -> Execution<'a> {
    Box::pin(async move {
        match effect.request["type"].as_str() {
            Some("provider-turn.interrupt") => {
                let id = required(&effect.request, "providerThreadId")?;
                let (handle, cancelled, services) = sessions()
                    .lock()
                    .map_err(|_| "ACP session registry unavailable")?
                    .get(id)
                    .map(|s| (s.cancel.clone(), s.cancelled.clone(), s.services.clone()))
                    .ok_or("ACP session is not active")?;
                cancelled.store(true, Ordering::Release);
                cancel_approvals(&effect.thread_id);
                if let Ok(mut svc) = services.lock() {
                    svc.cancel_terminals();
                }
                handle.cancel().map_err(|e| e.to_string())
            }
            Some("provider-turn.start") => {
                if effect.attempt_count > 1 {
                    return Err(
                        "Cannot safely replay a provider turn start after an uncertain failure"
                            .into(),
                    );
                }
                let bus = bus.clone();
                let effect = effect.clone();
                let settings = settings_path.map(Path::to_owned);
                let attachments_dir = attachments_dir.to_owned();
                let registry = registry.clone();
                let mcp = mcp.map(|(endpoint, sessions)| (endpoint.to_owned(), sessions.clone()));
                let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
                tokio::task::spawn_blocking(move || {
                    let mut ready = Some(ready_tx);
                    let result = start(
                        &bus,
                        &effect,
                        settings.as_deref(),
                        &attachments_dir,
                        &registry,
                        mcp.as_ref()
                            .map(|(endpoint, sessions)| (endpoint.as_str(), sessions.as_ref())),
                        &mut ready,
                    );
                    if let Some(ready) = ready {
                        let result = match result {
                            Err(error) if error == "ACP provider contains an unresolved environment credential" => fail_provider_start(&bus, &effect, &error),
                            other => other,
                        };
                        let _ = ready.send(result);
                    } else if let Err(error) = result {
                        eprintln!("ACP turn supervisor failed: {error}");
                    }
                });
                ready_rx
                    .await
                    .map_err(|_| "ACP turn supervisor ended before startup".to_owned())?
            }
            _ => Err("ACP does not support this operation".into()),
        }
    })
}

pub(crate) fn fail_provider_start(
    bus: &EventBus,
    effect: &Effect,
    error: &str,
) -> Result<(), String> {
    let run_id = required(&effect.request, "runId")?;
    let at = timestamp();
    let changed = bus.commit(|tx| {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'", params![run_id, effect.thread_id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { return Ok((false, vec![])); };
        let mut run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let attempt_id = run["activeAttemptId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let node_id = run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut payloads = Vec::new();
        for (select, update, id, event) in [
            ("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1", "UPDATE orchestration_v2_projection_run_attempts SET status='failed',payload_json=?2 WHERE attempt_id=?1", attempt_id, "run-attempt.updated"),
            ("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", "UPDATE orchestration_v2_projection_nodes SET status='failed',completed_at=?3,payload_json=?2 WHERE node_id=?1", node_id, "node.updated"),
        ] {
            let raw: String = tx.query_row(select, [id], |r| r.get(0))?;
            let mut value: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            value["status"] = json!("failed"); value["completedAt"] = json!(at);
            if event == "node.updated" { tx.execute(update, params![id, value.to_string(), at])?; } else { tx.execute(update, params![id, value.to_string()])?; }
            payloads.push((event, value));
        }
        let ordinal:i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [&effect.thread_id], |r| r.get(0))?;
        let item_id = format!("turn-item:provider-start-failure:{}", crate::message_commands::encode_id_part(run_id));
        let item = json!({"id":item_id,"threadId":effect.thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"failed","title":"Provider error","startedAt":at,"completedAt":at,"updatedAt":at,"type":"error","failure":{"class":"provider_error","message":error,"code":null,"retryable":false,"managedUsageLimit":false}});
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'error','failed',?7,?8)", params![item_id,effect.thread_id,run_id,node_id,run["providerThreadId"].as_str(),ordinal,at,item.to_string()])?;
        payloads.push(("turn-item.updated", item));
        run["status"] = json!("failed"); run["completedAt"] = json!(at);
        tx.execute("UPDATE orchestration_v2_projection_runs SET status='failed',completed_at=?2,payload_json=?3 WHERE run_id=?1", params![run_id,at,run.to_string()])?;
        payloads.push(("run.updated",run));
        let events: Vec<crate::event_store::Event> = payloads.into_iter().map(|(kind,payload)| crate::event_store::Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:effect.thread_id.clone(), event_type:kind.into(), occurred_at:at.clone(), command_id:None, causation_event_id:None, correlation_id:None, actor_kind:"system".into(), payload, metadata:json!({}) }).collect();
        Ok((true, crate::event_store::append(tx,&events)?))
    }).map_err(|e| e.to_string())?;
    if changed {
        crate::queue_promotion::hold_after_failure(bus, &effect.thread_id, run_id, &at)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn launch(
    settings: &Value,
    instance: &str,
    driver: &str,
    cwd: &str,
    mode: &str,
    settings_path: Option<&Path>,
    registry: &super::session_registry::SessionRegistry,
) -> Result<AcpLaunch, String> {
    let entry = &settings["providerInstances"][instance];
    if entry["enabled"] == false || entry["config"]["enabled"] == false {
        return Err("Provider instance is disabled".into());
    }
    let config = &entry["config"];
    // A registry-sourced acpRegistry instance only ever stores
    // {agentId, distribution:"auto"} (the Add Provider wizard never
    // persists a resolved command), so its command/args/env are resolved
    // here from the launch receipt server.prepareAcpRegistryAgent wrote to
    // <base dir>/tools/acp-registry/<agentId>/launch.json (see acp_registry.rs).
    let registry_launch: Option<super::acp_registry::LaunchReceipt> = if driver == "acpRegistry"
        && config["source"] != "local"
        && !config["commandPath"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        config["agentId"].as_str().filter(|s| !s.trim().is_empty()).and_then(|agent_id| {
            let base_dir = settings_path.and_then(Path::parent).and_then(Path::parent)?;
            super::acp_registry::installed_launch(&base_dir.join("tools/acp-registry"), agent_id)
        })
    } else {
        None
    };
    let (default, mut args): (&str, Vec<String>) = match driver {
        "fx" => ("fx", vec!["acp".into()]),
        "kiro" => (
            "kiro-cli",
            vec![
                "acp".into(),
                "--agent-engine=v3".into(),
                "--auth-method=cli".into(),
            ],
        ),
        "grok" => (
            "grok",
            match mode {
                "full-access" => vec!["agent".into(), "--always-approve".into(), "stdio".into()],
                "auto" => vec![
                    "--permission-mode".into(),
                    "auto".into(),
                    "agent".into(),
                    "stdio".into(),
                ],
                _ => vec![
                    "--permission-mode".into(),
                    "default".into(),
                    "agent".into(),
                    "stdio".into(),
                ],
            },
        ),
        "antigravity" => ("agy", vec!["acp".into()]),
        "acpRegistry"
            if config["source"] == "local"
                || config["commandPath"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty()) =>
        {
            (
                "",
                config["commandArgs"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        }
        "acpRegistry" if registry_launch.is_some() => {
            ("", registry_launch.as_ref().unwrap().args.clone())
        }
        "acpRegistry" if config["source"] != "local" => {
            return Err(
                "This ACP Registry agent has not been prepared yet. Add it again from the ACP Registry search."
                    .into(),
            );
        }
        _ => return Err("Unsupported ACP provider configuration".into()),
    };
    let binary = if driver == "acpRegistry" {
        if let Some(launch) = &registry_launch {
            launch.command.as_str()
        } else {
            config["commandPath"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(default)
        }
    } else {
        config["binaryPath"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(default)
    };
    if binary.is_empty() {
        return Err("ACP provider command is not configured".into());
    }
    let mut env = HashMap::new();
    let mut shell_remove = Vec::new();
    let captured_instance_environment = matches!(
        driver,
        "kiro" | "fx" | "grok" | "acpRegistry" | "antigravity"
    ) && entry["environment"]
        .as_array()
        .is_some_and(|values| !values.is_empty());
    let shell = if captured_instance_environment {
        registry
            .desktop_instance_shell_env
            .lock()
            .ok()
            .and_then(|all| all.get(instance).cloned())
            .unwrap_or_default()
    } else {
        registry
            .desktop_shell_env
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default()
    };
    for (key, value) in shell {
        if let Some(value) = value {
            env.insert(key, value);
        } else {
            shell_remove.push(key);
        }
    }
    if let Some(launch) = &registry_launch {
        // The registry's own defaults for this package/binary; an explicit
        // instance environment entry (applied below) still overrides these.
        for (key, value) in &launch.env {
            env.insert(key.clone(), value.clone());
        }
    }
    if driver == "antigravity" {
        // Custom Antigravity executables are supported with an isolated per-instance profile.
        // Managed installation and non-personal credential setup are resolved elsewhere.
        if config["authMethod"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s != "oauth-personal")
        {
            return Err("Antigravity non-personal authentication is not configured".into());
        }
    }

    if driver == "antigravity" {
        use sha2::{Digest, Sha256};
        let state = settings_path
            .and_then(Path::parent)
            .ok_or("Antigravity state directory is unavailable")?;
        let digest = Sha256::digest(instance.as_bytes());
        let key = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let profile = state.join("providers").join("antigravity").join(key);
        std::fs::create_dir_all(&profile).map_err(|_| "Could not prepare Antigravity profile")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&profile, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Could not secure Antigravity profile")?;
        }
        args = vec![
            "acp".into(),
            "--gemini-dir".into(),
            profile.to_string_lossy().into_owned(),
            "--app-data-dir".into(),
            "antigravity-acp".into(),
        ];
        env.insert("GEMINI_HOME".into(), profile.to_string_lossy().into_owned());
        env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
        env.insert("PYTHONUNBUFFERED".into(), "1".into());
        env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    }
    if let Some(values) = entry["environment"].as_array() {
        let mut resolver = None;
        for value in values {
            let name = value["name"]
                .as_str()
                .ok_or("Invalid provider environment")?;
            if name.is_empty()
                || !name.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                return Err("Invalid provider environment".into());
            }
            let resolved = if let Some(reference) = value.get("secret").filter(|v| !v.is_null()) {
                if resolver.is_none() {
                    resolver = Some(
                        tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .map_err(|_| "Could not initialize provider secret resolver")?,
                    );
                }
                resolver
                    .as_ref()
                    .unwrap()
                    .block_on(crate::mcp_secret::resolve_reference(settings, reference))
                    .ok_or("ACP provider contains an unresolved environment credential")?
            } else {
                value["value"]
                    .as_str()
                    .ok_or("Invalid provider environment")?
                    .to_owned()
            };
            shell_remove.retain(|key| key != name);
            env.insert(name.to_owned(), resolved);
        }
    }
    let mut env_remove = if driver == "antigravity" {
        [
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_CLOUD_QUOTA_PROJECT",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GCLOUD_PROJECT",
            "CLOUDSDK_CORE_PROJECT",
            "AGY_ACP_CCPA_PROJECT",
            "AGY_ACP_ENABLE_OAUTH",
            "ANTIGRAVITY_HARNESS_PATH",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    } else {
        vec![]
    };
    env_remove.extend(shell_remove);
    // Let Command resolve bare names using the child's configured PATH.
    let binary_path = if binary.starts_with("~/") {
        super::instance::home_path(binary)?
    } else if registry_launch.is_some()
        || env.contains_key("PATH")
        || env_remove.iter().any(|name| name == "PATH")
    {
        PathBuf::from(binary)
    } else {
        let home = std::env::var("HOME").ok().filter(|h| !h.trim().is_empty());
        super::path_resolve::resolve_binary(Some(binary), default, home.as_deref())
            .unwrap_or_else(|| PathBuf::from(binary))
    };
    Ok(AcpLaunch {
        binary: binary_path,
        args,
        cwd: PathBuf::from(cwd),
        env,
        env_remove,
    })
}

enum KiroProbe {
    Ready(String),
    Warning,
    Error,
}
fn kiro_default_model(config: AcpLaunch) -> KiroProbe {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return KiroProbe::Error,
    };
    runtime.block_on(async move {
        async fn probe(config: &AcpLaunch, args: &[&str]) -> Option<std::process::Output> {
            use tokio::io::AsyncReadExt;
            let mut command = tokio::process::Command::new(&config.binary);
            command
                .args(args)
                .current_dir(&config.cwd)
                .envs(&config.env)
                .env_remove("T3_ACP_MCP_AUTHORIZATION")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            for name in &config.env_remove {
                command.env_remove(name);
            }
            let mut child = command.spawn().ok()?;
            let stdout = child.stdout.take()?;
            tokio::time::timeout(Duration::from_secs(3), async move {
                let mut bytes = Vec::new();
                stdout.take(1_048_577).read_to_end(&mut bytes).await.ok()?;
                if bytes.len() > 1_048_576 {
                    return None;
                }
                let status = child.wait().await.ok()?;
                Some(std::process::Output {
                    status,
                    stdout: bytes,
                    stderr: Vec::new(),
                })
            })
            .await
            .ok()?
        }
        let Some(version) = probe(&config, &["--version"]).await else {
            return KiroProbe::Error;
        };
        if !version.status.success() {
            return KiroProbe::Error;
        }
        let Some(auth) = probe(&config, &["whoami", "--format", "json"]).await else {
            return KiroProbe::Warning;
        };
        if !auth.status.success() {
            return KiroProbe::Warning;
        }
        let Some(output) = probe(&config, &["chat", "--list-models", "--format", "json"]).await
        else {
            return KiroProbe::Ready("auto".into());
        };
        if !output.status.success() {
            return KiroProbe::Ready("auto".into());
        }
        let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
            return KiroProbe::Ready("auto".into());
        };
        if value["models"]
            .as_array()
            .is_none_or(|models| models.is_empty())
        {
            return KiroProbe::Ready("auto".into());
        }
        KiroProbe::Ready(
            value["default_model"]
                .as_str()
                .filter(|id| !id.is_empty())
                .unwrap_or("auto")
                .to_owned(),
        )
    })
}

pub(crate) fn refresh_kiro_defaults(
    settings: &Value,
    settings_path: &Path,
    cwd: &Path,
    registry: &super::session_registry::SessionRegistry,
    selected: Option<&[String]>,
    periodic: bool,
) {
    let Some(instances) = settings["providerInstances"].as_object() else {
        return;
    };
    for (id, entry) in instances {
        if selected.is_some_and(|ids| !ids.contains(id)) {
            continue;
        }
        if entry["driver"] != "kiro" || entry["enabled"] == false {
            continue;
        }
        let Ok(config) = launch(
            settings,
            id,
            "kiro",
            &cwd.to_string_lossy(),
            "full-access",
            Some(settings_path),
            registry,
        ) else {
            continue;
        };
        match kiro_default_model(config) {
            KiroProbe::Ready(value) => {
                if let Ok(mut defaults) = registry.kiro_defaults.lock() {
                    defaults.insert(id.clone(), value);
                }
                if let Ok(mut ready) = registry.kiro_ready.lock() {
                    ready.insert(id.clone());
                }
                if let Ok(mut deferred) = registry.kiro_deferred.lock() {
                    deferred.remove(id);
                }
            }
            probe @ (KiroProbe::Warning | KiroProbe::Error) => {
                let error = matches!(probe, KiroProbe::Error);
                let ready = registry.kiro_ready.lock().is_ok_and(|v| v.contains(id));
                let already_deferred = registry.kiro_deferred.lock().is_ok_and(|v| v.contains(id));
                if periodic && error && ready && !already_deferred {
                    if let Ok(mut deferred) = registry.kiro_deferred.lock() {
                        deferred.insert(id.clone());
                    }
                } else {
                    if let Ok(mut defaults) = registry.kiro_defaults.lock() {
                        defaults.insert(id.clone(), "auto".into());
                    }
                    if let Ok(mut ready) = registry.kiro_ready.lock() {
                        ready.remove(id);
                    }
                    if let Ok(mut deferred) = registry.kiro_deferred.lock() {
                        deferred.remove(id);
                    }
                }
            }
        }
    }
}

fn attachment_prompt(
    message: &Value,
    attachments_dir: &Path,
) -> Result<(Vec<Value>, bool), String> {
    let input = super::executor::codex_input(message, attachments_dir)?;
    let mut prompt = Vec::new();
    let mut has_images = false;
    for part in input {
        match part["type"].as_str() {
            Some("text") => prompt.push(json!({"type":"text","text":part["text"]})),
            Some("image") => {
                let (mime, data) = part["url"]
                    .as_str()
                    .and_then(|url| url.strip_prefix("data:"))
                    .and_then(|url| url.split_once(";base64,"))
                    .ok_or("Invalid attachment image")?;
                prompt.push(json!({"type":"image","data":data,"mimeType":mime}));
                has_images = true;
            }
            _ => return Err("Unsupported ACP attachment".into()),
        }
    }
    Ok((prompt, has_images))
}

fn start(
    bus: &EventBus,
    effect: &Effect,
    settings_path: Option<&Path>,
    attachments_dir: &Path,
    registry: &super::session_registry::SessionRegistry,
    mcp: Option<(&str, &super::session_registry::SessionRegistry)>,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let run_id = required(&effect.request, "runId")?.to_owned();
    let data=bus.commit(|tx| {
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'",params![run_id,effect.thread_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else { return Ok((None,vec![])); };
        let parse=|s:String|serde_json::from_str::<Value>(&s).map_err(|_|rusqlite::Error::InvalidQuery);
        let run=parse(raw)?;
        let read=|sql:&str,id:&str| -> rusqlite::Result<Value> { parse(tx.query_row(sql,[id],|r|r.get(0))?) };
        let pt=read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let message=read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",run["userMessageId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let thread=read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&effect.thread_id)?;
        let cwd:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'",[&run_id],|r|r.get(0)).optional()?.flatten();
        let ordinal:u64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0))?;
        Ok((Some((run,pt,message,thread,cwd,ordinal)),vec![]))
    }).map_err(|e|e.to_string())?;
    let Some((run, pt, message, thread, cwd, ordinal)) = data else {
        return Ok(());
    };
    let (side_text, side_chat) = if thread["lineage"]["sideChat"] == true {
        let handoffs = bus.commit(|tx| Ok((super::executor::pending_handoffs(tx, run["providerThreadId"].as_str(), &run_id)?, vec![]))).map_err(|e| e.to_string())?;
        super::executor::prepare_inline_handoffs(handoffs, &message, true)?
    } else { (message["text"].as_str().unwrap_or("").to_owned(), vec![]) };
    let mut prompt_message = message.clone();
    prompt_message["text"] = json!(side_text);
    let (mut prompt, has_images) = attachment_prompt(&prompt_message, attachments_dir)?;
    let cwd = cwd
        .or_else(|| thread["worktreePath"].as_str().map(str::to_owned))
        .ok_or("Missing ACP workspace")?;
    let absolute = |path: &str| {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    };
    let reservation = crate::workspace_safety::reserve(
        absolute(&cwd),
        crate::workspace_safety::ReservationKind::TurnStart,
    );
    let lease = thread["worktreePath"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|path| crate::workspace_safety::workspace_lease(absolute(path)));
    let still_starting = bus.commit(|tx| {
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')", params![run_id,effect.thread_id], |row|row.get(0))?;
        Ok((active,vec![]))
    }).map_err(|e|e.to_string())?;
    if !still_starting {
        return Ok(());
    }
    let instance = required(&pt, "providerInstanceId")?;
    let driver = required(&pt, "driver")?;
    let key = required(&pt, "id")?.to_owned();
    let cancelled = Arc::new(AtomicBool::new(false));
    let settings = super::session_registry::read_provider_settings(settings_path)?;
    let entry = &settings["providerInstances"][instance];
    let copilot = driver == "acpRegistry"
        && (entry["config"]["agentId"] == "github-copilot-cli"
            || entry["config"]["commandPath"].as_str().is_some_and(|path| {
                let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
                ["copilot", "copilot.exe", "copilot.cmd"]
                    .iter().any(|candidate| name.eq_ignore_ascii_case(candidate))
            }));
    let allow_read = driver == "antigravity";
    let allow_terminal = driver == "acpRegistry"
        && entry["config"]["source"] == "registry"
        && entry["config"]["agentId"] == "devin";
    let session = {
        let mut registry = sessions()
            .lock()
            .map_err(|_| "ACP session registry unavailable")?;
        registry.get_mut(&key).map(|a| {
            a.cancelled = cancelled.clone();
            (a.session.clone(), a.services.clone())
        })
    };
    let session = if let Some((session, services)) = session {
        let alive = session
            .lock()
            .map_err(|_| "ACP session unavailable")?
            .is_alive();
        if alive {
            Some((session, services))
        } else {
            if let Ok(mut registry) = sessions().lock() {
                if registry
                    .get(&key)
                    .is_some_and(|active| Arc::ptr_eq(&active.session, &session))
                {
                    if let Some(active) = registry.remove(&key) {
                        active.idle_stop.store(true, Ordering::Release);
                    }
                }
            }
            None
        }
    } else {
        None
    };
    let (session, services) = if let Some(session) = session {
        session
    } else {
        let config = launch(
            &settings,
            instance,
            driver,
            &cwd,
            thread["runtimeMode"]
                .as_str()
                .unwrap_or("approval-required"),
            settings_path,
            registry,
        )?;
        let _kiro_default = if driver == "kiro" {
            let cached = registry
                .kiro_defaults
                .lock()
                .ok()
                .and_then(|values| values.get(instance).cloned());
            cached.unwrap_or_else(|| {
                let probe = kiro_default_model(config.clone());
                let value = match probe {
                    KiroProbe::Ready(value) => {
                        if let Ok(mut ready) = registry.kiro_ready.lock() {
                            ready.insert(instance.to_owned());
                        }
                        value
                    }
                    _ => "auto".into(),
                };
                if let Ok(mut values) = registry.kiro_defaults.lock() {
                    values.insert(instance.to_owned(), value.clone());
                }
                value
            })
        } else {
            "auto".into()
        };
        let mut config = config;
        if let Some((endpoint, registry)) = mcp {
            let authorization = registry.prepare_mcp(
                &effect.thread_id,
                instance,
                thread["lineage"]["relationshipToParent"] == "subagent",
            )?;
            let executable =
                std::env::current_exe().map_err(|_| "ACP MCP executable is unavailable")?;
            config
                .env
                .insert("T3CODE_THREAD_ID".into(), effect.thread_id.clone());
            config
                .env
                .insert("T3_ACP_MCP_ENDPOINT".into(), endpoint.into());
            config
                .env
                .insert("T3_ACP_MCP_AUTHORIZATION".into(), authorization);
            config.env.insert(
                "T3_ACP_MCP_NODE".into(),
                executable.to_string_lossy().into_owned(),
            );
        }
        let mut session = AcpSession::spawn(config).map_err(|e| e.to_string())?;
        if allow_read {
            session
                .set_additional_directories(vec![attachments_dir.to_string_lossy().into_owned()])
                .map_err(|e| e.to_string())?;
        }
        session
            .configure_client_services(allow_read, false, allow_terminal)
            .map_err(|e| e.to_string())?;
        let auth_method = if driver == "grok" {
            Some(
                if std::env::var("XAI_API_KEY").is_ok_and(|s| !s.trim().is_empty())
                    || entry["environment"].as_array().is_some_and(|a| {
                        a.iter().any(|v| {
                            v["name"] == "XAI_API_KEY"
                                && v["value"].as_str().is_some_and(|s| !s.trim().is_empty())
                        })
                    })
                {
                    "xai.api_key"
                } else {
                    "cached_token"
                }
                .to_owned(),
            )
        } else {
            entry["config"]["authMethodId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        session
            .configure_flavor(
                auth_method,
                if driver == "grok" {
                    Some(json!({"clientType":"extension"}))
                } else {
                    None
                },
                if driver == "grok" {
                    Some(json!({"cancelTrigger":"ctrl_c"}))
                } else {
                    None
                },
            )
            .map_err(|e| e.to_string())?;

        if copilot {
            session.set_client_capabilities_meta(json!({
                "github.com/copilot": {"events":["tool.execution_start"]}
            })).map_err(|e| e.to_string())?;
        }

        let native = pt["nativeThreadRef"]["nativeId"].as_str();
        let services = Arc::new(Mutex::new(super::acp_client::ClientServices::new(
            native.unwrap_or("").to_owned(),
            PathBuf::from(&cwd),
            vec![PathBuf::from(&cwd), attachments_dir.to_owned()],
            allow_read,
            false,
            allow_terminal,
            allow_terminal,
        )));
        let mut reject = |event: AcpEvent| -> AcpReply {
            match event {
                AcpEvent::Request { method, params, .. } => services
                    .lock()
                    .map_err(|_| (-32603, "ACP client services unavailable".into()))
                    .and_then(|mut svc| {
                        svc.handle(&method, &params, false)
                            .map(Some)
                            .map_err(|e| (-32603, e))
                    }),
                AcpEvent::Notification { .. } => Ok(None),
            }
        };
        if driver == "antigravity" {
            session
                .initialize(Duration::from_secs(30), &mut reject)
                .map_err(|e| e.to_string())?;
            session
                .request(
                    "authenticate",
                    json!({"methodId":"oauth-personal"}),
                    Duration::from_secs(30),
                    &mut reject,
                )
                .map_err(|e| e.to_string())?;
        }
        let init = session
            .initialize(Duration::from_secs(30), &mut reject)
            .map_err(|e| e.to_string())?;
        let mut mcp_servers = Vec::new();
        if let Some((endpoint, registry)) = mcp {
            let authorization = registry.prepare_mcp(
                &effect.thread_id,
                instance,
                thread["lineage"]["relationshipToParent"] == "subagent",
            )?;
            if init["agentCapabilities"]["mcpCapabilities"]["http"] == true {
                mcp_servers.push(json!({"type":"http","name":"t3-code","url":endpoint,"headers":[{"name":"Authorization","value":authorization},{"name":"t3-tool-exposure","value":"deferred"}]}));
            } else {
                let executable = std::env::current_exe()
                    .map_err(|_| "ACP MCP bridge executable is unavailable")?;
                mcp_servers.push(json!({"name":"t3-code","command":executable.to_string_lossy(),"args":["acp-mcp-bridge"],"env":[{"name":"T3_ACP_MCP_ENDPOINT","value":endpoint},{"name":"T3_ACP_MCP_AUTHORIZATION","value":authorization}]}));
            }
        }
        let has_mcp = !mcp_servers.is_empty();
        if native.is_some() {
            session
                .open(
                    &cwd,
                    None,
                    &mcp_servers,
                    Duration::from_secs(90),
                    &mut reject,
                )
                .map_err(|e| e.to_string())?;
        }
        session
            .open(
                &cwd,
                native,
                &mcp_servers,
                Duration::from_secs(90),
                &mut reject,
            )
            .map_err(|e| e.to_string())?;
        let cancel = session.cancel_handle().map_err(|e| e.to_string())?;
        let native_id = session
            .native_session_id()
            .ok_or("Missing ACP native session")?
            .to_owned();
        services
            .lock()
            .map_err(|_| "ACP client services unavailable")?
            .bind_session(&native_id)?;
        let session = Arc::new(Mutex::new(session));
        let mut registry = sessions()
            .lock()
            .map_err(|_| "ACP session registry unavailable")?;
        if registry.contains_key(&key) {
            return Err("ACP session is already active".into());
        }
        registry.insert(
            key.clone(),
            Active {
                session: session.clone(),
                cancel,
                services: services.clone(),
                provider_session_id: required(&pt, "providerSessionId")?.to_owned(),
                has_mcp,
                instruction_mode: None,
                runtime_instructions: None,
                thread_id: effect.thread_id.clone(),
                cancelled: cancelled.clone(),
                idle_stop: Arc::new(AtomicBool::new(false)),
                idle_started: Arc::new(AtomicBool::new(false)),
                idle_source: Arc::new(Mutex::new(None)),
                persistent_commands: Arc::new(Mutex::new(HashMap::new())),
            },
        );
        (session, services)
    };
    let persistent_commands = sessions()
        .lock()
        .map_err(|_| "ACP session registry unavailable")?
        .get(&key)
        .ok_or("ACP session is not active")?
        .persistent_commands
        .clone();
    services
        .lock()
        .map_err(|_| "ACP client services unavailable")?
        .begin_turn();
    let mut client = session.lock().map_err(|_| "ACP session unavailable")?;
    if has_images && driver != "antigravity" && !client.supports_images() {
        return Err("ACP driver did not negotiate image prompt support".into());
    }
    let requested_model = required(&run["modelSelection"], "model")?;
    {
        let mut registry = sessions()
            .lock()
            .map_err(|_| "ACP session registry unavailable")?;
        let entry = registry.get_mut(&key).ok_or("ACP session is not active")?;
        let (mode, runtime) = super::acp_instructions::apply(
            &mut prompt,
            thread["interactionMode"].as_str().unwrap_or("default"),
            driver,
            requested_model,
            entry.has_mcp,
            entry.instruction_mode.as_deref(),
            entry.runtime_instructions.as_deref(),
        );
        if let Some(mode) = mode {
            entry.instruction_mode = Some(mode)
        }
        if let Some(runtime) = runtime {
            entry.runtime_instructions = Some(runtime)
        }
    }
    let mut setup_handler = |event: AcpEvent| -> AcpReply {
        match event {
            AcpEvent::Request { method, params, .. } => services
                .lock()
                .map_err(|_| (-32603, "ACP client services unavailable".into()))
                .and_then(|mut svc| {
                    svc.handle(&method, &params, false)
                        .map(Some)
                        .map_err(|e| (-32603, e))
                }),
            AcpEvent::Notification { .. } => Ok(None),
        }
    };
    if driver == "antigravity" {
        client
            .apply_antigravity_cli_mode(Duration::from_secs(30), &mut setup_handler)
            .map_err(|e| e.to_string())?;
    }
    if driver == "fx" {
        client
            .apply_fx_mode(
                thread["runtimeMode"]
                    .as_str()
                    .unwrap_or("approval-required"),
                Duration::from_secs(30),
                &mut setup_handler,
            )
            .map_err(|e| e.to_string())?;
    }
    if driver == "fx" {
        client
            .select_fx_model(requested_model, Duration::from_secs(30), &mut setup_handler)
            .map_err(|e| e.to_string())?;
    } else if driver == "kiro" {
        let default_model = registry
            .kiro_defaults
            .lock()
            .ok()
            .and_then(|values| values.get(instance).cloned())
            .unwrap_or_else(|| "auto".into());
        client
            .select_kiro_model(
                requested_model,
                &default_model,
                Duration::from_secs(30),
                &mut setup_handler,
            )
            .map_err(|e| e.to_string())?;
    } else if !((driver == "antigravity" && requested_model == "antigravity-default")
        || (driver == "grok" && requested_model == "grok-build"))
    {
        client
            .select_model(requested_model, Duration::from_secs(30), &mut setup_handler)
            .map_err(|e| e.to_string())?;
    }
    let native = client
        .native_session_id()
        .ok_or("Missing ACP native session")?
        .to_owned();
    let turn_native = format!("{native}:turn:{ordinal}");
    let at = timestamp();
    let turn = RootTurn {
        driver: driver.into(),
        native_thread_id: native.clone(),
        native_turn_id: turn_native.clone(),
        provider_thread_id: key.clone(),
        provider_turn_id: format!(
            "provider-turn:provider:{}:native-turn:{}",
            crate::message_commands::encode_id_part(driver),
            crate::message_commands::encode_id_part(&format!(
                "provider-instance:{}:{turn_native}",
                crate::message_commands::encode_id_part(instance)
            ))
        ),
        thread_id: effect.thread_id.clone(),
        run_id: Some(run_id.clone()),
        run_attempt_id: required(&run, "activeAttemptId")?.into(),
        root_node_id: required(&run, "rootNodeId")?.into(),
        provider_turn_ordinal: ordinal,
        run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
        started_at: at.clone(),
    };
    let caps = json!({
        "sessions":{"supportsMultipleProviderThreadsPerSession":false,"supportsModelSwitchInSession":driver!="acpRegistry","supportsProviderSwitchingViaHandoff":false,"supportsRuntimeModeSwitchInSession":false,"pendingRequestsSurviveRestart":false},
        "threads":{"canCreateEmptyThread":true,"canReadThreadSnapshot":false,"canRollbackThread":false,"canForkThread":false,"canForkFromTurn":false,"canForkFromSubagentThread":false,"exposesNativeThreadId":true},
        "turns":{"exposesNativeTurnId":false,"emitsTurnStarted":true,"emitsTurnCompleted":true,"supportsInterrupt":true,"supportsActiveSteering":false,"supportsSteeringByInterruptRestart":false,"supportsQueuedMessages":true,"terminalStatusQuality":"strong"},
        "streaming":{"streamsAssistantText":true,"streamsReasoning":true,"streamsToolOutput":true,"streamsPlanText":false,"emitsMessageCompleted":true},
        "tools":{"exposesToolItemIds":true,"emitsToolStarted":true,"emitsToolCompleted":true,"emitsToolOutput":true,"supportsMcpTools":false,"supportsDynamicToolCallbacks":false},
        "approvals":{"supportsCommandApproval":true,"supportsFileReadApproval":true,"supportsFileChangeApproval":true,"supportsApplyPatchApproval":false,"approvalsHaveNativeRequestIds":false,"approvalCallbacksAreLiveOnly":true,"approvalsCanOriginateFromSubagents":false},
        "planning":{"emitsPlanUpdated":false,"emitsTodoList":false,"emitsProposedPlan":false,"supportsStructuredQuestions":false,"planDeltasHaveItemIds":false},
        "subagents":{"supportsSubagents":driver=="fx","exposesSubagentThreadIds":false,"emitsSubagentLifecycle":driver=="fx","canWaitForSubagents":false,"canCloseSubagents":false,"canForkSubagentThread":false},
        "context":{"acceptsSystemContext":false,"acceptsDeveloperContext":false,"acceptsSyntheticUserContext":false,"canGenerateSummaries":false,"canConsumeHandoffSummaries":false,"supportsDeltaHandoff":false,"supportsFullThreadHandoff":false,"maxRecommendedHandoffChars":null},
        "checkpointing":{"appCanCheckpointFilesystem":true,"supportsNestedCheckpointScopes":false,"providerCanRollbackConversation":false,"providerRollbackReturnsSnapshot":false,"providerCanReadConversationSnapshot":false},
        "identity":{"nativeThreadIds":"strong","nativeTurnIds":"weak","nativeItemIds":"weak","nativeRequestIds":"weak"},"runtimePolicy":{"enforcement":"client-boundary"}
    });
    let pt_session_id = required(&pt, "providerSessionId")?.to_owned();
    lifecycle::start(bus, &turn, pt.clone(), &run, Some(&cwd), caps.clone())?;
    crate::message_commands::deliver_deferred(bus, &effect.thread_id, &turn.run_attempt_id, &at)
        .map_err(|e| e.to_string())?;
    drop(lease);
    drop(reservation);
    if let Some(ready) = ready.take() {
        ready
            .send(Ok(()))
            .map_err(|_| "ACP turn start was cancelled".to_owned())?;
    }
    let mut text = String::new();
    let after_prompt = std::cell::Cell::new(false);
    let assistant_segment = std::cell::Cell::new(0u64);
    let mut reasoning = String::new();
    let mut copilot_tools = HashMap::new();
    let mut tool_states: HashMap<String, (Value, u64, String)> = HashMap::new();
    let mut fx_subagents = std::collections::HashSet::<String>::new();
    let grok_tasks = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let grok_background = Arc::new(Mutex::new(
        HashMap::<String, (String, String, u64, String)>::new(),
    ));
    let mut next_ordinal = turn.run_ordinal * 1_000_000 + 3;
    let mut reasoning_ordinal = None;
    let mut unsupported = false;
    let callback_failed = Arc::new(AtomicBool::new(false));
    let mut projection_error = None;
    let mut handler = |event: AcpEvent| -> AcpReply {
        match event {
            AcpEvent::Request {
                id,
                method,
                params,
                responder,
            } if method == "session/request_permission"
                && (params["sessionId"] == native
                    || (driver == "grok"
                        && params["sessionId"].as_str().is_some_and(|child| {
                            grok_tasks
                                .lock()
                                .is_ok_and(|tasks| tasks.values().any(|session| session == child))
                        }))) =>
            {
                let mut params = params;
                if let Some(id) = params["toolCall"]["toolCallId"].as_str() {
                    if let Some((state, _, _)) = tool_states.get(id) {
                        for field in ["kind", "title", "locations", "rawInput"] {
                            if params["toolCall"].get(field).is_none() && state.get(field).is_some()
                            {
                                params["toolCall"][field] = state[field].clone();
                            }
                        }
                    }
                }
                // ACP read operations do not require approval. FX and Grok in
                // automatic mode surface classifier refusals to the user.
                let mode = thread["runtimeMode"]
                    .as_str()
                    .unwrap_or("approval-required");
                let kind = params["toolCall"]["kind"].as_str().unwrap_or("other");
                let read = matches!(kind, "read" | "search" | "think");
                let mutation = matches!(kind, "edit" | "delete" | "move");
                let allow = if driver == "fx" {
                    mode != "auto" && read
                } else if driver == "grok" && mode == "auto" {
                    false
                } else {
                    read || matches!(mode, "auto" | "full-access")
                        || (mode == "auto-accept-edits" && mutation)
                };
                if allow {
                    let options = params["options"].as_array();
                    let option = options.and_then(|options| {
                        options
                            .iter()
                            .find(|option| {
                                option["kind"] == "allow_once"
                                    && option["optionId"]
                                        .as_str()
                                        .is_some_and(|id| !id.trim().is_empty())
                            })
                            .or_else(|| {
                                if driver == "kiro" {
                                    None
                                } else {
                                    options.iter().find(|option| {
                                        option["kind"] == "allow_always"
                                            && option["optionId"]
                                                .as_str()
                                                .is_some_and(|id| !id.trim().is_empty())
                                    })
                                }
                            })
                    });
                    if let Some(option) = option {
                        return Ok(Some(
                            json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
                        ));
                    }
                    if driver != "kiro" {
                        return Ok(Some(json!({"outcome":{"outcome":"cancelled"}})));
                    }
                }
                let ordinal = next_ordinal;
                next_ordinal += 1;
                let bus = bus.clone();
                let turn = turn.clone();
                let session = pt_session_id.clone();
                let services = services.clone();
                let cancelled = cancelled.clone();
                let callback_failed = callback_failed.clone();
                std::thread::spawn(move || {
                    let answer =
                        request_approval(&bus, &turn, &session, &id, &params, ordinal, &cancelled);
                    match answer {
                        Ok(answer) => {
                            if params["toolCall"]["kind"] == "execute" {
                                let selected = answer["outcome"]["optionId"].as_str();
                                if let Some(kind) = params["options"]
                                    .as_array()
                                    .and_then(|a| {
                                        a.iter().find(|o| o["optionId"].as_str() == selected)
                                    })
                                    .and_then(|o| o["kind"].as_str())
                                {
                                    if matches!(kind, "allow_once" | "allow_always") {
                                        if let Ok(mut svc) = services.lock() {
                                            if !cancelled.load(Ordering::Acquire) {
                                                svc.grant_execute(kind == "allow_always");
                                            }
                                        }
                                    }
                                }
                            }
                            let _ = responder.respond(Ok(answer));
                        }
                        Err(_) => {
                            callback_failed.store(true, Ordering::Release);
                            let _ = responder
                                .respond(Err((-32603, "Unable to handle ACP approval".into())));
                        }
                    }
                });
                Ok(None)
            }
            AcpEvent::Request {
                method,
                params,
                responder,
                ..
            } if method == "terminal/wait_for_exit" => {
                let handle = services
                    .lock()
                    .map_err(|_| (-32603, "ACP client services unavailable".to_owned()))
                    .and_then(|svc| svc.wait_handle(&params).map_err(|e| (-32603, e)));
                match handle {
                    Ok((child, readers)) => {
                        std::thread::spawn(move || {
                            let result =
                                super::acp_client::wait(child, readers).map_err(|e| (-32603, e));
                            let _ = responder.respond(result);
                        });
                        Ok(None)
                    }
                    Err(error) => Err(error),
                }
            }
            AcpEvent::Request { method, params, .. } => {
                let allow_by_mode =
                    matches!(thread["runtimeMode"].as_str(), Some("auto" | "full-access"));
                match services
                    .lock()
                    .map_err(|_| (-32603, "ACP client services unavailable".to_owned()))
                    .and_then(|mut svc| {
                        let allowed = allow_by_mode || svc.has_execute_grant();
                        svc.handle(&method, &params, allowed)
                            .map_err(|message| (-32603, message))
                    }) {
                    Ok(value) => Ok(Some(value)),
                    Err(error) => Err(error),
                }
            }
            AcpEvent::Notification { method, params }
                if copilot
                    && matches!(method.as_str(), "github.com/copilot/sessionEvent" | "_github.com/copilot/sessionEvent")
                    && params["sessionId"] == native
                    && params["type"] == "tool.execution_start" =>
            {
                let data = &params["data"];
                if let Some((id, identity)) = data["toolCallId"].as_str()
                    .filter(|id| !id.is_empty())
                    .zip(CopilotToolIdentity::from_event(data))
                {
                    if copilot_tools.len() < 256 || copilot_tools.contains_key(id) {
                        copilot_tools.insert(id.to_owned(), identity);
                    }
                }
                Ok(None)
            }
            AcpEvent::Notification { method, params } if method == "session/update" => {
                if params["sessionId"] != native {
                    if driver == "grok" {
                        let child = params["sessionId"].as_str().unwrap_or("");
                        let task = grok_tasks.lock().ok().and_then(|tasks| {
                            tasks
                                .iter()
                                .find_map(|(id, session)| (session == child).then(|| id.clone()))
                        });
                        if let Some(task) = task {
                            let update = &params["update"];
                            let result = match update["sessionUpdate"].as_str() {
                                Some("agent_message_chunk")
                                    if update["content"]["type"] == "text" =>
                                {
                                    update["content"]["text"].as_str().map(|delta| {
                                        super::grok_subagents::stream(
                                            bus,
                                            &turn,
                                            instance,
                                            &task,
                                            child,
                                            delta,
                                            &timestamp(),
                                        )
                                    })
                                }
                                Some("tool_call" | "tool_call_update")
                                    if update["title"] == "spawn_subagent" =>
                                {
                                    None
                                }
                                Some("tool_call" | "tool_call_update") => {
                                    Some(super::grok_subagents::tool(
                                        bus,
                                        &turn,
                                        instance,
                                        &task,
                                        child,
                                        update,
                                        &timestamp(),
                                    ))
                                }
                                _ => None,
                            };
                            if let Some(Err(error)) = result {
                                projection_error = Some(error);
                            }
                        }
                        return Ok(None);
                    }
                    unsupported = true;
                    return Ok(None);
                }
                let update = &params["update"];
                if update["sessionUpdate"] == "agent_message_chunk"
                    && update["content"]["type"] == "text"
                {
                    if let Some(delta) = update["content"]["text"].as_str() {
                        if after_prompt.get() && assistant_segment.get() == 0 && !text.is_empty() {
                            let previous = AssistantArtifact {
                                turn: turn.clone(),
                                native_item_id: format!("{turn_native}:assistant:0"),
                                phase: None,
                                text: text.clone(),
                                ordinal: turn.run_ordinal * 1_000_000 + 2,
                                started_at: at.clone(),
                                updated_at: timestamp(),
                                completed: true,
                            };
                            if let Err(error) = ingest::ingest(
                                bus,
                                &[
                                    NormalizedEvent::NodeUpdated(previous.clone()),
                                    NormalizedEvent::MessageUpdated(previous.clone()),
                                    NormalizedEvent::TurnItemUpdated(previous),
                                ],
                            ) {
                                projection_error = Some(error.to_string());
                            }
                            text.clear();
                            assistant_segment.set(1);
                        }
                        if text.len().saturating_add(delta.len()) > 16 * 1024 * 1024 {
                            unsupported = true;
                            return Ok(None);
                        }
                        text.push_str(delta);
                        let artifact = AssistantArtifact {
                            turn: turn.clone(),
                            native_item_id: format!(
                                "{turn_native}:assistant:{}",
                                assistant_segment.get()
                            ),
                            phase: None,
                            text: text.clone(),
                            ordinal: turn.run_ordinal * 1_000_000
                                + if assistant_segment.get() == 0 { 2 } else { 999 },
                            started_at: at.clone(),
                            updated_at: timestamp(),
                            completed: false,
                        };
                        if let Err(e) = ingest::ingest(
                            bus,
                            &[
                                NormalizedEvent::NodeUpdated(artifact.clone()),
                                NormalizedEvent::MessageUpdated(artifact.clone()),
                                NormalizedEvent::TurnItemUpdated(artifact),
                            ],
                        ) {
                            projection_error = Some(e.to_string());
                        }
                    }
                } else if update["sessionUpdate"] == "agent_thought_chunk"
                    && update["content"]["type"] == "text"
                {
                    if let Some(delta) = update["content"]["text"].as_str() {
                        if reasoning.len().saturating_add(delta.len()) > 16 * 1024 * 1024 {
                            unsupported = true;
                            return Ok(None);
                        }
                        reasoning.push_str(delta);
                        let ordinal = *reasoning_ordinal.get_or_insert_with(|| {
                            let n = next_ordinal;
                            next_ordinal += 1;
                            n
                        });
                        let item_id = format!("{turn_native}:thought:0");
                        let artifact = ReasoningArtifact {
                            artifact: AssistantArtifact {
                                turn: turn.clone(),
                                native_item_id: item_id.clone(),
                                phase: None,
                                text: reasoning.clone(),
                                ordinal,
                                started_at: at.clone(),
                                updated_at: timestamp(),
                                completed: false,
                            },
                            native_reasoning_item_id: item_id,
                            stream: "text".into(),
                            index: 0,
                            interrupted: false,
                        };
                        if let Err(e) = ingest::ingest(
                            bus,
                            &[
                                NormalizedEvent::ReasoningNodeUpdated(artifact.clone()),
                                NormalizedEvent::ReasoningTurnItemUpdated(artifact),
                            ],
                        ) {
                            projection_error = Some(e.to_string());
                        }
                    }
                } else if matches!(
                    update["sessionUpdate"].as_str(),
                    Some("tool_call" | "tool_call_update")
                ) {
                    if let Some(id) = update["toolCallId"].as_str().filter(|s| !s.is_empty()) {
                        if !tool_states.contains_key(id) && tool_states.len() >= 256 {
                            unsupported = true;
                            return Ok(None);
                        }
                        let state = tool_states.entry(id.to_owned()).or_insert_with(|| {
                            let ordinal = next_ordinal;
                            next_ordinal += 1;
                            (json!({}), ordinal, timestamp())
                        });
                        if let (Some(dst), Some(src)) =
                            (state.0.as_object_mut(), update.as_object())
                        {
                            for (key, value) in src {
                                if !value.is_null() {
                                    dst.insert(key.clone(), value.clone());
                                }
                            }
                        }
                        let background_id =
                            if state.0["rawOutput"]["type"] == "BackgroundTaskStarted" {
                                state.0["rawOutput"]["task_id"].as_str()
                            } else if state.0["rawOutput"]["type"]
                                .as_str()
                                .is_some_and(|kind| kind.eq_ignore_ascii_case("monitor"))
                            {
                                state.0["rawOutput"]["taskId"]
                                    .as_str()
                                    .or_else(|| state.0["rawOutput"]["task_id"].as_str())
                            } else {
                                None
                            };
                        if driver == "grok" {
                            if let Some(task_id) = background_id {
                                let input = state.0["rawInput"]["command"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_owned();
                                let persistent = state.0["rawOutput"]["persistent"] == true
                                    || state.0["rawInput"]["persistent"] == true;
                                if persistent {
                                    if let Ok(mut tasks) = persistent_commands.lock() {
                                        if !tasks.contains_key(task_id) {
                                            if let Err(error) = super::grok_background::command(
                                                bus,
                                                &turn,
                                                instance,
                                                id,
                                                &input,
                                                None,
                                                "running",
                                                state.1,
                                                &state.2,
                                                &timestamp(),
                                            ) {
                                                projection_error = Some(error);
                                            }
                                            tasks.insert(
                                                task_id.to_owned(),
                                                PersistentGrokCommand {
                                                    turn: turn.clone(),
                                                    instance: instance.into(),
                                                    tool_id: id.into(),
                                                    input,
                                                    ordinal: state.1,
                                                    started: state.2.clone(),
                                                },
                                            );
                                        }
                                    }
                                    return Ok(None);
                                }
                                if let Ok(mut tasks) = grok_background.lock() {
                                    if !tasks.contains_key(task_id) {
                                        if let Err(error) = super::grok_background::command(
                                            bus,
                                            &turn,
                                            instance,
                                            id,
                                            &input,
                                            None,
                                            "running",
                                            state.1,
                                            &state.2,
                                            &timestamp(),
                                        ) {
                                            projection_error = Some(error);
                                        }
                                        tasks.insert(
                                            task_id.to_owned(),
                                            (id.to_owned(), input, state.1, state.2.clone()),
                                        );
                                    }
                                }
                                return Ok(None);
                            }
                        }
                        if driver == "grok"
                            && matches!(state.0["title"].as_str(), Some("Task" | "spawn_subagent"))
                            && state.0["rawInput"]["prompt"].is_string()
                        {
                            let task_prompt = state.0["rawInput"]["prompt"].as_str().unwrap_or("");
                            if let Ok(mut tasks) = grok_tasks.lock() {
                                if !tasks.contains_key(id) {
                                    if let Err(error) = super::grok_subagents::start(
                                        bus,
                                        &turn,
                                        instance,
                                        id,
                                        state.0["rawInput"]["description"].as_str().unwrap_or(""),
                                        task_prompt,
                                        state.0["rawInput"]["model"].as_str(),
                                        state.1,
                                        &state.2,
                                    ) {
                                        projection_error = Some(error);
                                        return Ok(None);
                                    }
                                    tasks.insert(id.to_owned(), String::new());
                                }
                                let is_spawn = state.0["title"] == "spawn_subagent";
                                if is_spawn {
                                    if let Some(output) = state.0["rawOutput"]["text"].as_str() {
                                        if let Some(child) =
                                            regex::Regex::new(r"(?i)subagent_id:\s*([0-9a-f-]{8,})")
                                                .unwrap()
                                                .captures(output)
                                                .and_then(|c| c.get(1))
                                                .map(|m| m.as_str())
                                        {
                                            if tasks
                                                .get(id)
                                                .is_none_or(|existing| existing != child)
                                            {
                                                if let Err(error) =
                                                    super::grok_subagents::bind_child(
                                                        bus,
                                                        &turn,
                                                        instance,
                                                        id,
                                                        child,
                                                        &timestamp(),
                                                    )
                                                {
                                                    projection_error = Some(error);
                                                }
                                            }
                                            tasks.insert(id.to_owned(), child.to_owned());
                                        }
                                    }
                                }
                                if (!is_spawn || state.0["status"] == "failed")
                                    && matches!(
                                        state.0["status"].as_str(),
                                        Some("completed" | "failed")
                                    )
                                {
                                    let result = state.0["rawOutput"]["text"].as_str();
                                    if let Err(error) = super::grok_subagents::finish(
                                        bus,
                                        &turn,
                                        instance,
                                        id,
                                        state.0["status"].as_str().unwrap_or("completed"),
                                        result,
                                        &timestamp(),
                                    ) {
                                        projection_error = Some(error);
                                    }
                                    tasks.remove(id);
                                }
                            }
                            return Ok(None);
                        }
                        if driver == "fx" && state.0["name"] == "subagent" {
                            let raw = &state.0["rawInput"];
                            let request = raw.get("request").unwrap_or(raw);
                            let input = match request["action"].as_str() {
                                Some("run") => request["task"].as_str().map(|text| (text, None)),
                                Some("message") => request["message"]
                                    .as_str()
                                    .zip(request["agent"].as_str())
                                    .map(|(text, name)| (text, Some(name))),
                                _ => None,
                            };
                            if let Some((task, title)) = input {
                                if !fx_subagents.contains(id) {
                                    if let Err(error) = super::fx_subagents::start(
                                        bus,
                                        &turn,
                                        instance,
                                        id,
                                        title.unwrap_or(""),
                                        task,
                                        request["model"].as_str(),
                                        state.1,
                                        &state.2,
                                    ) {
                                        projection_error = Some(error);
                                        return Ok(None);
                                    }
                                    fx_subagents.insert(id.to_owned());
                                }
                                if matches!(
                                    state.0["status"].as_str(),
                                    Some("completed" | "failed")
                                ) {
                                    let output = state.0["content"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .find_map(|part| part["content"]["text"].as_str());
                                    let decoded = output.and_then(super::fx_subagents::outcome);
                                    let failed = state.0["status"] == "failed"
                                        || decoded.as_ref().is_some_and(|(ok, _)| !*ok);
                                    let result = match decoded {
                                        Some((_, result)) => result,
                                        None => output.map(str::to_owned),
                                    };
                                    if let Err(error) = super::fx_subagents::finish(
                                        bus,
                                        &turn,
                                        instance,
                                        id,
                                        if failed { "failed" } else { "completed" },
                                        result.as_deref(),
                                        &timestamp(),
                                    ) {
                                        projection_error = Some(error);
                                    }
                                }
                                return Ok(None);
                            }
                        }
                        let status = match state.0["status"].as_str() {
                            Some("completed") => "completed",
                            Some("failed") => "failed",
                            _ => "running",
                        };
                        let (kind, fields) = acp_tool_projection(&state.0, copilot_tools.get(id));
                        let artifact = ToolArtifact {
                            turn: turn.clone(),
                            native_item_id: format!("{native}:tool:{id}"),
                            ordinal: state.1,
                            started_at: state.2.clone(),
                            updated_at: timestamp(),
                            status: status.into(),
                            kind: kind.into(),
                            fields,
                        };
                        if let Err(e) =
                            ingest::ingest(bus, &[NormalizedEvent::ToolUpdated(artifact)])
                        {
                            projection_error = Some(e.to_string());
                        }
                    } else {
                        unsupported = true;
                    }
                }
                Ok(None)
            }
            AcpEvent::Notification { method, params }
                if driver == "grok"
                    && matches!(
                        method.as_str(),
                        "x.ai/task_completed" | "_x.ai/task_completed"
                    )
                    && params["sessionId"] == native =>
            {
                let update = &params["update"];
                let task_id = update["task_snapshot"]["task_id"]
                    .as_str()
                    .or_else(|| update["task_id"].as_str())
                    .or_else(|| update["tool_call_id"].as_str());
                if let Some(task_id) = task_id {
                    if let Ok(mut tasks) = grok_background.lock() {
                        if let Some((tool_id, input, ordinal, started)) = tasks.remove(task_id) {
                            let snapshot = &update["task_snapshot"];
                            let status =
                                if snapshot["exit_code"].as_i64().is_some_and(|code| code != 0) {
                                    "failed"
                                } else {
                                    "completed"
                                };
                            if let Err(error) = super::grok_background::command(
                                bus,
                                &turn,
                                instance,
                                &tool_id,
                                &input,
                                snapshot["output"].as_str(),
                                status,
                                ordinal,
                                &started,
                                &timestamp(),
                            ) {
                                projection_error = Some(error);
                            }
                        }
                    }
                }
                if let Err(error) = finish_persistent_grok(
                    bus,
                    &persistent_commands,
                    &params,
                    Some(&turn.provider_turn_id),
                ) {
                    projection_error = Some(error);
                }
                Ok(None)
            }
            AcpEvent::Notification { method, params }
                if driver == "grok"
                    && matches!(
                        method.as_str(),
                        "x.ai/session_notification" | "_x.ai/session_notification"
                    )
                    && params["sessionId"] == native
                    && params["update"]["sessionUpdate"] == "subagent_finished" =>
            {
                let update = &params["update"];
                if let (Some(child), Some(status @ ("completed" | "failed" | "cancelled"))) = (
                    update["child_session_id"].as_str(),
                    update["status"].as_str(),
                ) {
                    if let Ok(mut tasks) = grok_tasks.lock() {
                        let task = tasks
                            .iter()
                            .find_map(|(id, session)| (session == child).then(|| id.clone()));
                        if let Some(id) = task {
                            let result = if status == "completed" {
                                update["output"].as_str()
                            } else {
                                update["error"].as_str()
                            };
                            if let Err(error) = super::grok_subagents::finish(
                                bus,
                                &turn,
                                instance,
                                &id,
                                if status == "cancelled" {
                                    "stopped"
                                } else {
                                    status
                                },
                                result,
                                &timestamp(),
                            ) {
                                projection_error = Some(error);
                            }
                            tasks.remove(&id);
                        }
                    }
                }
                Ok(None)
            }
            AcpEvent::Notification { .. } => Ok(None),
        }
    };
    let mut outcome = client.prompt(prompt, Duration::from_secs(600), &mut handler);
    if outcome.is_ok() {
        for handoff in side_chat {
            if let Err(error) = super::executor::record_side_chat_delivery(bus, &turn, handoff) {
                eprintln!("Warning: failed to record accepted ACP side-chat context delivery: {error}");
            }
        }
    }
    after_prompt.set(true);
    if driver == "grok"
        && outcome.is_ok()
        && (grok_tasks.lock().is_ok_and(|tasks| !tasks.is_empty())
            || grok_background.lock().is_ok_and(|tasks| !tasks.is_empty()))
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        let mut quiet_since = None;
        while std::time::Instant::now() < deadline && !cancelled.load(Ordering::Acquire) {
            match client.poll_idle(Duration::from_millis(100), &mut handler) {
                Ok(true) => quiet_since = None,
                Ok(false) => {}
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
            let pending = grok_tasks.lock().is_ok_and(|tasks| !tasks.is_empty())
                || grok_background.lock().is_ok_and(|tasks| !tasks.is_empty());
            if !pending {
                let since = quiet_since.get_or_insert_with(std::time::Instant::now);
                if since.elapsed() >= Duration::from_secs(3) {
                    break;
                }
            }
        }
    }
    let interrupted = cancelled.swap(true, Ordering::AcqRel);
    cancel_approvals(&effect.thread_id);
    let terminal = if interrupted
        || outcome
            .as_ref()
            .is_ok_and(|v| v["stopReason"] == "cancelled")
    {
        TurnStatus::Interrupted
    } else if outcome.is_err()
        || unsupported
        || callback_failed.load(Ordering::Acquire)
        || projection_error.is_some()
        || outcome.as_ref().is_ok_and(|v| v["stopReason"] == "error")
    {
        TurnStatus::Failed
    } else {
        TurnStatus::Completed
    };
    if driver == "grok" && matches!(terminal, TurnStatus::Failed | TurnStatus::Interrupted) {
        let pending: Vec<String> = grok_tasks
            .lock()
            .map(|tasks| tasks.keys().cloned().collect())
            .unwrap_or_default();
        let status = if terminal == TurnStatus::Failed {
            "failed"
        } else {
            "interrupted"
        };
        for task in pending {
            super::grok_subagents::finish(bus, &turn, instance, &task, status, None, &timestamp())?;
        }
    }
    let mut events = Vec::new();
    if !text.is_empty() {
        let artifact = AssistantArtifact {
            turn: turn.clone(),
            native_item_id: format!("{turn_native}:assistant:{}", assistant_segment.get()),
            phase: None,
            text,
            ordinal: turn.run_ordinal * 1_000_000
                + if assistant_segment.get() == 0 { 2 } else { 999 },
            started_at: at,
            updated_at: timestamp(),
            completed: true,
        };
        events.extend([
            NormalizedEvent::NodeUpdated(artifact.clone()),
            NormalizedEvent::MessageUpdated(artifact.clone()),
            NormalizedEvent::TurnItemUpdated(artifact),
        ]);
    }
    if !reasoning.is_empty() {
        let item_id = format!("{turn_native}:thought:0");
        let artifact = ReasoningArtifact {
            artifact: AssistantArtifact {
                turn: turn.clone(),
                native_item_id: item_id.clone(),
                phase: None,
                text: reasoning,
                ordinal: reasoning_ordinal.unwrap_or(turn.run_ordinal * 1_000_000 + 3),
                started_at: turn.started_at.clone(),
                updated_at: timestamp(),
                completed: true,
            },
            native_reasoning_item_id: item_id,
            stream: "text".into(),
            index: 0,
            interrupted: terminal == TurnStatus::Interrupted,
        };
        events.extend([
            NormalizedEvent::ReasoningNodeUpdated(artifact.clone()),
            NormalizedEvent::ReasoningTurnItemUpdated(artifact),
        ]);
    }
    for (id, (state, ordinal, started_at)) in tool_states {
        if fx_subagents.contains(&id) {
            continue;
        }
        if !matches!(state["status"].as_str(), Some("completed" | "failed")) {
            let status = match terminal {
                TurnStatus::Completed => "completed",
                TurnStatus::Interrupted => "interrupted",
                _ => "failed",
            };
            let (kind, fields) = acp_tool_projection(&state, copilot_tools.get(&id));
            events.push(NormalizedEvent::ToolUpdated(ToolArtifact {
                turn: turn.clone(),
                native_item_id: format!("{native}:tool:{id}"),
                ordinal,
                started_at,
                updated_at: timestamp(),
                status: status.into(),
                kind: kind.into(),
                fields,
            }));
        }
    }
    let failure = (terminal == TurnStatus::Failed).then(|| ProviderFailure {
        class: FailureClass::ProviderError,
        message: "ACP provider turn failed or used an unsupported feature.".into(),
        code: None,
        retryable: Some(false),
        managed_usage_limit: false,
    });
    let completed_at = timestamp();
    events.push(NormalizedEvent::ProviderTurnUpdated {
        turn: turn.clone(),
        status: terminal,
        completed_at: Some(completed_at),
    });
    events.push(NormalizedEvent::TurnTerminal {
        failure_item_ordinal: (terminal == TurnStatus::Failed).then_some(next_ordinal),
        turn: turn.clone(),
        status: terminal,
        failure,
        thread_disposition: ThreadDisposition::Reusable,
    });
    ingest::ingest(bus, &events).map_err(|e| e.to_string())?;
    if driver == "grok" && outcome.is_ok() {
        let watcher = sessions().lock().ok().and_then(|registry| {
            registry.get(&key).map(|active| {
                if let Ok(mut source) = active.idle_source.lock() {
                    *source = Some((turn.clone(), caps.clone()));
                }
                (
                    active.idle_started.clone(),
                    active.idle_stop.clone(),
                    active.idle_source.clone(),
                    active.persistent_commands.clone(),
                )
            })
        });
        if let Some((started, stop, source, persistent)) = watcher {
            if !started.swap(true, Ordering::AcqRel) {
                let (bus, session, services) = (bus.clone(), session.clone(), services.clone());
                std::thread::spawn(move || {
                    idle_grok(bus, session, services, stop, source, persistent)
                });
            }
        }
    }
    if outcome.is_err() {
        drop(client);
        let _ = sessions().lock().map(|mut map| map.remove(&key));
    }
    Ok(())
}

struct PendingGrokWake {
    source: RootTurn,
    caps: Value,
    id: String,
    text: String,
    reasoning: String,
    tools: Vec<(String, Value)>,
    approvals: Vec<(Value, Value, AcpResponder)>,
    ready: bool,
    seen: std::time::Instant,
}

fn merge_grok_tool(tools: &mut Vec<(String, Value)>, id: &str, update: &Value) {
    let index = tools
        .iter()
        .position(|(existing, _)| existing == id)
        .unwrap_or_else(|| {
            tools.push((id.to_owned(), json!({})));
            tools.len() - 1
        });
    if let (Some(target), Some(changes)) = (tools[index].1.as_object_mut(), update.as_object()) {
        for (key, value) in changes {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn finish_persistent_grok(
    bus: &EventBus,
    tasks: &PersistentGrokCommands,
    params: &Value,
    active_turn: Option<&str>,
) -> Result<(), String> {
    let update = &params["update"];
    let task_id = update["task_snapshot"]["task_id"]
        .as_str()
        .or_else(|| update["task_id"].as_str())
        .or_else(|| update["tool_call_id"].as_str());
    let Some(task_id) = task_id else {
        return Ok(());
    };
    let task = tasks
        .lock()
        .map_err(|_| "ACP persistent task registry unavailable")?
        .remove(task_id);
    if let Some(task) = task {
        if active_turn != Some(task.turn.provider_turn_id.as_str()) {
            return Ok(());
        }
        let snapshot = &update["task_snapshot"];
        let status = if snapshot["exit_code"].as_i64().is_some_and(|code| code != 0) {
            "failed"
        } else {
            "completed"
        };
        super::grok_background::command(
            bus,
            &task.turn,
            &task.instance,
            &task.tool_id,
            &task.input,
            snapshot["output"].as_str(),
            status,
            task.ordinal,
            &task.started,
            &timestamp(),
        )?;
    }
    Ok(())
}

fn grok_monitor_chatter(text: &str) -> bool {
    static MONITOR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    text.trim().is_empty()
        || MONITOR
            .get_or_init(|| {
                regex::Regex::new(
                    r#"(?i)<monitor-event\b|Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended"#,
                )
                .unwrap()
            })
            .is_match(text)
}

// Grok can emit root-session output after its prompt response. Keep reading the
// same process and materialize a durable provider-origin run for that output.
fn idle_grok(
    bus: EventBus,
    session: Arc<Mutex<AcpSession>>,
    services: Arc<Mutex<super::acp_client::ClientServices>>,
    stop: Arc<AtomicBool>,
    source: Arc<Mutex<Option<(RootTurn, Value)>>>,
    persistent: PersistentGrokCommands,
) {
    let mut pending: Option<PendingGrokWake> = None;
    let mut serial = 0u64;
    while !stop.load(Ordering::Acquire) {
        let mut frame = None;
        let mut pending_approval = None;
        if let Ok(mut client) = session.try_lock() {
            let mut handler = |event| -> AcpReply {
                match event {
                    AcpEvent::Notification { method, params } => {
                        frame = Some((method, params));
                        Ok(None)
                    }
                    AcpEvent::Request {
                        id,
                        method,
                        params,
                        responder,
                    } if method == "session/request_permission" => {
                        frame = Some((method, json!({"requestId":id,"requestParams":params})));
                        pending_approval = Some(responder);
                        Ok(None)
                    }
                    AcpEvent::Request { method, params, .. } => services
                        .lock()
                        .map_err(|_| (-32603, "ACP client services unavailable".into()))
                        .and_then(|mut svc| {
                            svc.handle(&method, &params, false)
                                .map(Some)
                                .map_err(|e| (-32603, e))
                        }),
                }
            };
            if client
                .poll_idle(Duration::from_millis(50), &mut handler)
                .is_err()
            {
                break;
            }
        } else {
            std::thread::sleep(Duration::from_millis(25));
        }
        // Give a newly queued foreground prompt a chance to acquire the session.
        std::thread::sleep(Duration::from_millis(10));
        if let (Some(responder), Some((method, params))) = (pending_approval, frame.as_ref()) {
            if method == "session/request_permission" {
                if let Some((turn, caps)) = source.lock().ok().and_then(|s| s.clone()) {
                    if params["requestParams"]["sessionId"] == turn.native_thread_id {
                        if pending.is_none() {
                            serial += 1;
                            pending = Some(PendingGrokWake {
                                source: turn,
                                caps,
                                id: format!("acp-wake:{}:{}", timestamp(), serial),
                                text: String::new(),
                                reasoning: String::new(),
                                tools: Vec::new(),
                                approvals: Vec::new(),
                                ready: false,
                                seen: std::time::Instant::now(),
                            });
                        }
                        if let Some(pending) = pending.as_mut() {
                            pending.ready = true;
                            pending.approvals.push((
                                params["requestId"].clone(),
                                params["requestParams"].clone(),
                                responder,
                            ));
                            pending.seen = std::time::Instant::now();
                        }
                    } else {
                        let _ = responder.respond(Err((-32602, "Unknown ACP session".into())));
                    }
                } else {
                    let _ = responder.respond(Err((-32603, "ACP session unavailable".into())));
                }
            }
        }
        if let Some((method, params)) = frame {
            if matches!(
                method.as_str(),
                "x.ai/task_completed" | "_x.ai/task_completed"
            ) {
                if let Err(error) = finish_persistent_grok(&bus, &persistent, &params, None) {
                    eprintln!("ACP background task update failed: {error}");
                }
            }
            let update = &params["update"];
            let kind = update["sessionUpdate"].as_str().unwrap_or("");
            let is_text = matches!(kind, "agent_message_chunk" | "agent_thought_chunk")
                && update["content"]["type"] == "text"
                && !(kind == "agent_message_chunk"
                    && grok_monitor_chatter(update["content"]["text"].as_str().unwrap_or("")));
            let is_tool = matches!(kind, "tool_call" | "tool_call_update")
                && update["toolCallId"].as_str().is_some();
            if method == "session/update" && (is_text || is_tool) {
                if let Some((turn, caps)) = source.lock().ok().and_then(|s| s.clone()) {
                    if params["sessionId"] == turn.native_thread_id {
                        if pending.is_none() {
                            serial += 1;
                            pending = Some(PendingGrokWake {
                                source: turn,
                                caps,
                                id: format!("acp-wake:{}:{}", timestamp(), serial),
                                text: String::new(),
                                reasoning: String::new(),
                                tools: Vec::new(),
                                approvals: Vec::new(),
                                ready: false,
                                seen: std::time::Instant::now(),
                            });
                        }
                        if let Some(PendingGrokWake {
                            text,
                            reasoning,
                            tools,
                            ready,
                            seen,
                            ..
                        }) = pending.as_mut()
                        {
                            if is_text {
                                *ready = true;
                                let delta = update["content"]["text"].as_str().unwrap_or("");
                                let target = if kind == "agent_thought_chunk" {
                                    reasoning
                                } else {
                                    text
                                };
                                if target.len().saturating_add(delta.len()) <= 16 * 1024 * 1024 {
                                    target.push_str(delta);
                                }
                            } else if let Some(id) = update["toolCallId"].as_str() {
                                if matches!(update["status"].as_str(), Some("completed" | "failed"))
                                {
                                    *ready = true;
                                }
                                merge_grok_tool(tools, id, update);
                            }
                            *seen = std::time::Instant::now();
                        }
                    }
                }
            }
        }
        if pending.as_ref().is_some_and(|pending| pending.ready) {
            let PendingGrokWake {
                source: old,
                caps,
                id: wake_id,
                text,
                reasoning,
                tools,
                approvals,
                ..
            } = pending.as_ref().unwrap();
            let at = timestamp();
            match super::wake::create(&bus, old, wake_id, None, None, &at) {
                Ok(Some((turn, run, pt, cwd))) => {
                    let wake_cancelled = Arc::new(AtomicBool::new(false));
                    if let Ok(mut registry) = sessions().lock() {
                        if let Some(active) = registry.get_mut(&turn.provider_thread_id) {
                            active.cancelled = wake_cancelled.clone();
                        }
                    }
                    let instance = pt["providerInstanceId"].as_str().unwrap_or("").to_owned();
                    let provider_session =
                        pt["providerSessionId"].as_str().unwrap_or("").to_owned();
                    let result =
                        lifecycle::start(&bus, &turn, pt, &run, cwd.as_deref(), caps.clone())
                            .and_then(|_| {
                                let mut followup = String::new();
                                let mut live_text = text.clone();
                                let mut live_reasoning = reasoning.clone();
                                let mut live_tools = tools.clone();
                                let mut live_approvals = approvals.clone();
                                let mut quiet_since = std::time::Instant::now();
                                while quiet_since.elapsed() < Duration::from_secs(3) && live_approvals.is_empty() && !stop.load(Ordering::Acquire) {
                                    if let Ok(mut client) = session.try_lock() {
                                        let mut handler = |event| -> AcpReply {
                                            match event {
                                                AcpEvent::Notification { method, params } if method == "session/update" && params["sessionId"] == turn.native_thread_id => {
                                                    let update = &params["update"];
                                                    match update["sessionUpdate"].as_str() {
                                                        Some("agent_message_chunk") => if let Some(delta) = update["content"]["text"].as_str().filter(|text| !grok_monitor_chatter(text)) { live_text.push_str(delta); },
                                                        Some("agent_thought_chunk") => if let Some(delta) = update["content"]["text"].as_str() { live_reasoning.push_str(delta); },
                                                        Some("tool_call" | "tool_call_update") => if let Some(id) = update["toolCallId"].as_str() { merge_grok_tool(&mut live_tools, id, update); },
                                                        _ => {},
                                                    }
                                                    Ok(None)
                                                }
                                                AcpEvent::Request { id, method, params, responder } if method == "session/request_permission" && params["sessionId"] == turn.native_thread_id => { live_approvals.push((id,params,responder)); Ok(None) }
                                                AcpEvent::Request { .. } => Err((-32601, "Unsupported background request".into())),
                                                _ => Ok(None),
                                            }
                                        };
                                        match client.poll_idle(Duration::from_millis(50), &mut handler) { Ok(true) => quiet_since = std::time::Instant::now(), Ok(false) => {}, Err(_) => break }
                                    } else { std::thread::sleep(Duration::from_millis(25)); }
                                }
                                if !live_approvals.is_empty() {
                                    let (done_tx, done_rx) = std::sync::mpsc::channel();
                                    let remaining = std::cell::Cell::new(0usize);
                                    let next_approval = std::cell::Cell::new(10u64);
                                    let launch = |id: Value, params: Value, responder: AcpResponder| {
                                        let ordinal = turn.run_ordinal * 1_000_000 + next_approval.get();
                                        next_approval.set(next_approval.get() + 1);
                                        remaining.set(remaining.get() + 1);
                                        let (worker_bus, worker_turn, worker_session, worker_stop, done_tx) = (bus.clone(), turn.clone(), provider_session.clone(), wake_cancelled.clone(), done_tx.clone());
                                        std::thread::spawn(move || {
                                            let result = request_approval(&worker_bus, &worker_turn, &worker_session, &id, &params, ordinal, &worker_stop).map_err(|e| (-32603, e));
                                            let _ = responder.respond(result);
                                            let _ = done_tx.send(());
                                        });
                                    };
                                    for (id, params, responder) in live_approvals { launch(id, params, responder); }
                                    let deadline = std::time::Instant::now() + Duration::from_secs(600);
                                    let mut done_at = None;
                                    while std::time::Instant::now() < deadline && !stop.load(Ordering::Acquire) {
                                        while done_rx.try_recv().is_ok() { remaining.set(remaining.get().saturating_sub(1)); }
                                        if remaining.get() == 0 { let at = done_at.get_or_insert_with(std::time::Instant::now); if at.elapsed() >= Duration::from_secs(3) { break; } } else { done_at = None; }
                                        if let Ok(mut client) = session.try_lock() {
                                            let mut handler = |event| -> AcpReply {
                                                match event {
                                                    AcpEvent::Notification { method, params } if method == "session/update" && params["sessionId"] == turn.native_thread_id && params["update"]["sessionUpdate"] == "agent_message_chunk" => { if let Some(delta) = params["update"]["content"]["text"].as_str() { followup.push_str(delta); } Ok(None) }
                                                    AcpEvent::Request { id, method, params, responder } if method == "session/request_permission" && params["sessionId"] == turn.native_thread_id => { launch(id, params, responder); Ok(None) }
                                                    AcpEvent::Request { .. } => Err((-32601, "Unsupported background request".into())),
                                                    _ => Ok(None),
                                                }
                                            };
                                            match client.poll_idle(Duration::from_millis(50), &mut handler) {
                                                Ok(true) if remaining.get() == 0 => done_at = Some(std::time::Instant::now()),
                                                Ok(_) => {},
                                                Err(_) => break,
                                            }
                                        } else { std::thread::sleep(Duration::from_millis(25)); }
                                    }
                                }
                                let artifact = AssistantArtifact {
                                    turn: turn.clone(),
                                    native_item_id: format!("{}:assistant:0", turn.native_turn_id),
                                    phase: None,
                                    text: live_text.clone(),
                                    ordinal: turn.run_ordinal * 1_000_000 + 2,
                                    started_at: at.clone(),
                                    updated_at: timestamp(),
                                    completed: true,
                                };
                                let mut events = Vec::new();
                                if !live_text.is_empty() {
                                    events.extend([
                                        NormalizedEvent::NodeUpdated(artifact.clone()),
                                        NormalizedEvent::MessageUpdated(artifact.clone()),
                                        NormalizedEvent::TurnItemUpdated(artifact),
                                    ]);
                                }
                                if !followup.is_empty() {
                                    let follow = AssistantArtifact { turn: turn.clone(), native_item_id: format!("{}:assistant:1", turn.native_turn_id), phase: None, text: followup, ordinal: turn.run_ordinal * 1_000_000 + 11, started_at: at.clone(), updated_at: timestamp(), completed: true };
                                    events.extend([NormalizedEvent::NodeUpdated(follow.clone()), NormalizedEvent::MessageUpdated(follow.clone()), NormalizedEvent::TurnItemUpdated(follow)]);
                                }
                                if !live_reasoning.is_empty() {
                                    let id = format!("{}:thought:0", turn.native_turn_id);
                                    let thought = ReasoningArtifact {
                                        artifact: AssistantArtifact {
                                            turn: turn.clone(),
                                            native_item_id: id.clone(),
                                            phase: None,
                                            text: live_reasoning.clone(),
                                            ordinal: turn.run_ordinal * 1_000_000 + 3,
                                            started_at: at.clone(),
                                            updated_at: timestamp(),
                                            completed: true,
                                        },
                                        native_reasoning_item_id: id,
                                        stream: "text".into(),
                                        index: 0,
                                        interrupted: false,
                                    };
                                    events.extend([
                                        NormalizedEvent::ReasoningNodeUpdated(thought.clone()),
                                        NormalizedEvent::ReasoningTurnItemUpdated(thought),
                                    ]);
                                }
                                for (index, (id, state)) in live_tools.iter().enumerate() {
                                    if state["title"] == "Task" && state["rawInput"]["prompt"].is_string() {
                                        super::grok_subagents::start(&bus, &turn, &instance, id, state["rawInput"]["description"].as_str().unwrap_or(""), state["rawInput"]["prompt"].as_str().unwrap_or(""), state["rawInput"]["model"].as_str(), turn.run_ordinal * 1_000_000 + 4 + index as u64, &at)?;
                                        if let Some(status @ ("completed" | "failed")) = state["status"].as_str() {
                                            super::grok_subagents::finish(&bus, &turn, &instance, id, status, state["rawOutput"]["text"].as_str(), &timestamp())?;
                                        }
                                        continue;
                                    }
                                    let status = match state["status"].as_str() { Some("completed") => "completed", Some("failed") => "failed", _ => "running" };
                                    events.push(NormalizedEvent::ToolUpdated(ToolArtifact { turn: turn.clone(), native_item_id: format!("{}:tool:{id}", turn.native_thread_id), ordinal: turn.run_ordinal * 1_000_000 + 4 + index as u64, started_at: at.clone(), updated_at: timestamp(), status: status.into(), kind: "dynamic_tool".into(), fields: json!({"title":state["title"],"toolName":state["title"].as_str().unwrap_or("ACP tool"),"input":state["rawInput"],"output":state["content"]}) }));
                                }
                                let terminal = if wake_cancelled.load(Ordering::Acquire) { TurnStatus::Interrupted } else { TurnStatus::Completed };
                                events.extend([
                                    NormalizedEvent::ProviderTurnUpdated {
                                        turn: turn.clone(),
                                        status: terminal,
                                        completed_at: Some(timestamp()),
                                    },
                                    NormalizedEvent::TurnTerminal {
                                        turn,
                                        status: terminal,
                                        failure: None,
                                        failure_item_ordinal: None,
                                        thread_disposition: ThreadDisposition::Reusable,
                                    },
                                ]);
                                ingest::ingest(&bus, &events).map_err(|e| e.to_string())
                            });
                    wake_cancelled.store(true, Ordering::Release);
                    if let Err(error) = result {
                        eprintln!("ACP background projection failed: {error}");
                    }
                    pending = None;
                }
                Ok(None) => {
                    let busy = bus.commit(|tx| { let busy = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))", [&old.thread_id], |r| r.get::<_, bool>(0))?; Ok((busy, vec![])) }).unwrap_or(false);
                    if !busy {
                        pending = None;
                    }
                }
                Err(error) => {
                    eprintln!("ACP background wake failed: {error}");
                    pending = None;
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn copilot_tool_identity_overrides_flattened_acp_title() {
        let state = json!({"title":"read","rawInput":{"pattern":"*.rs"}});
        let search = CopilotToolIdentity::from_event(&json!({"toolName":"glob"})).unwrap();
        let (kind, fields) = acp_tool_projection(&state, Some(&search));
        assert_eq!(kind, "file_search");
        assert_eq!(fields["pattern"], "*.rs");

        let mcp = CopilotToolIdentity::from_event(&json!({
            "toolName":"grep","mcpServerName":" docs ","mcpToolName":" lookup "
        })).unwrap();
        let (kind, fields) = acp_tool_projection(&state, Some(&mcp));
        assert_eq!(kind, "dynamic_tool");
        assert_eq!(fields["toolName"], "docs.lookup");
        assert_eq!(acp_tool_projection(&state, None).1["toolName"], "read");
        assert!(CopilotToolIdentity::from_event(&json!({"mcpToolName":"lookup"})).is_none());
    }

    #[test]
    fn acp_launch_uses_the_provider_path() {
        let root = std::env::temp_dir().join(format!("t3-acp-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("grok");
        std::fs::write(&executable, "#!/bin/sh\nprintf provider-path\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let settings = json!({"providerInstances":{"test":{"driver":"grok","environment":[{"name":"PATH","value":root}]}}});
        let launch = launch(
            &settings, "test", "grok", root.to_str().unwrap(), "auto", None,
            &super::super::session_registry::SessionRegistry::default(),
        ).unwrap();
        assert_eq!(launch.binary, PathBuf::from("grok"));
        let output = std::process::Command::new(launch.binary)
            .current_dir(launch.cwd)
            .envs(launch.env)
            .output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"provider-path");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_prompt_encodes_image_and_rejects_bad_ids() {
        let root = std::env::temp_dir().join(format!("t3-acp-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = crate::attachment_paths::attachment_id("t", None).unwrap();
        std::fs::write(root.join(format!("{id}.png")), b"fake-image").unwrap();
        let message = json!({"text":"hello","attachments":[{"type":"image","id":id,"name":"a.png","mimeType":"image/png","sizeBytes":10}]});
        let (prompt, has_images) = attachment_prompt(&message, &root).unwrap();
        assert!(has_images);
        assert_eq!(prompt[1]["type"], "image");
        assert_eq!(prompt[1]["data"], "ZmFrZS1pbWFnZQ==");
        assert_eq!(prompt[1]["mimeType"], "image/png");
        let bad = json!({"text":"hello","attachments":[{"type":"image","id":"../bad","name":"a.png","mimeType":"image/png","sizeBytes":10}]});
        assert!(attachment_prompt(&bad, &root).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn late_tool_updates_preserve_first_seen_order() {
        let mut tools = Vec::new();
        merge_grok_tool(&mut tools, "first", &json!({"status":"in_progress"}));
        merge_grok_tool(&mut tools, "second", &json!({"status":"completed"}));
        merge_grok_tool(&mut tools, "first", &json!({"status":"completed"}));
        assert_eq!(
            tools.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(tools[0].1["status"], "completed");
    }

    #[test]
    fn unreadable_secret_after_dispatch_fails_starting_run() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"fx","model":"test"});
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "secret-thread",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "secret-thread",
                message_id: "secret-message",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "fx",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                let effect = crate::outbox::list_by_command_id(tx, "send")?
                    .into_iter()
                    .find(|e| e.request["type"] == "provider-turn.start")
                    .unwrap();
                Ok((effect, vec![]))
            })
            .unwrap();
        fail_provider_start(
            &bus,
            &effect,
            "ACP provider contains an unresolved environment credential",
        )
        .unwrap();
        bus.commit(|tx| {
            let (run,attempt,node):(String,String,String) = tx.query_row("SELECT r.status,a.status,n.status FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=json_extract(r.payload_json,'$.activeAttemptId') JOIN orchestration_v2_projection_nodes n ON n.node_id=json_extract(r.payload_json,'$.rootNodeId') WHERE r.thread_id='secret-thread'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            assert_eq!((run.as_str(),attempt.as_str(),node.as_str()),("failed","failed","failed"));
            let count:i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id='secret-thread' AND type='error' AND status='failed'", [], |r|r.get(0))?;
            assert_eq!(count,1); Ok(((),vec![]))
        }).unwrap();
        fail_provider_start(
            &bus,
            &effect,
            "ACP provider contains an unresolved environment credential",
        )
        .unwrap();
    }

    #[test]
    fn acp_turn_projects_streamed_tools_from_fake_agents() {
        assert_fake_acp_turn(false);
        assert_fake_acp_turn(true);
    }

    fn assert_fake_acp_turn(copilot: bool) {
        let root = std::env::temp_dir().join(format!("t3-acp-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let driver = if copilot { "acpRegistry" } else { "fx" };
        let agent = root.join(if copilot { "copilot" } else { "fx" });
        std::fs::write(&agent,r##"#!/usr/bin/env python3
import json,os,sys
copilot=os.path.basename(sys.argv[0])=='copilot'
def notify(method, **params):
 print(json.dumps({'jsonrpc':'2.0','method':method,'params':params}),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize':
  if copilot:
   assert m['params']['clientCapabilities']['_meta']['github.com/copilot']['events']==['tool.execution_start']
  result={'protocolVersion':2,'agentCapabilities':{'loadSession':True}}
 elif method=='session/new': result={'sessionId':'fx-native','modes':{'currentModeId':'auto','availableModes':[{'id':'auto','name':'Auto'},{'id':'ask','name':'Ask'}]}}
 elif method=='session/set_config_option': result={}
 elif method=='session/prompt':
  assert m['params']['sessionId']=='fx-native' and 'parent digest' in m['params']['prompt'][0]['text'] and 'User message:\nhello' in m['params']['prompt'][0]['text'] and '<runtime_info>' in m['params']['prompt'][1]['text']
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fx-native','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'hello from fx'}}}}),flush=True)
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fx-native','update':{'sessionUpdate':'agent_thought_chunk','content':{'type':'text','text':'thinking'}}}}),flush=True)
  if copilot:
   ext='github.com/copilot/sessionEvent'
   notify(ext,sessionId='fx-native',type='tool.execution_start',data={'toolCallId':'tool-1','mcpServerName':'docs','mcpToolName':'lookup'})
   notify(ext,sessionId='other',type='tool.execution_start',data={'toolCallId':'tool-1','toolName':'grep'})
   notify(ext,sessionId='fx-native',type='tool.execution_start',data={'toolCallId':'tool-2','toolName':'glob'})
   notify('session/update',sessionId='fx-native',update={'sessionUpdate':'tool_call','toolCallId':'tool-2','title':'Read files','kind':'read','rawInput':{'pattern':'*.rs'}})
   notify('session/update',sessionId='fx-native',update={'sessionUpdate':'tool_call_update','toolCallId':'tool-2','status':'completed'})
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fx-native','update':{'sessionUpdate':'tool_call','toolCallId':'tool-1','title':'Read file','kind':'read','status':'in_progress','rawInput':{'path':'x'}}}}),flush=True)
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fx-native','update':{'sessionUpdate':'tool_call_update','toolCallId':'tool-1','status':'completed','content':[{'type':'content','content':{'type':'text','text':'file body'}}]}}}),flush=True)
  print(json.dumps({'jsonrpc':'2.0','id':'permission','method':'session/request_permission','params':{'sessionId':'fx-native','toolCall':{'toolCallId':'cmd','title':'echo hello','kind':'execute'},'options':[{'kind':'allow_once','optionId':'yes'},{'kind':'reject_once','optionId':'no'}]}}),flush=True)
  reply=json.loads(sys.stdin.readline()); assert reply['result']['outcome']['optionId']=='yes'
  result={'stopReason':'end_turn'}
 else: raise Exception(method)
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = root.join("settings.json");
        let config = if copilot {
            json!({"source":"local","commandPath":agent})
        } else {
            json!({"binaryPath":agent})
        };
        std::fs::write(&settings, json!({
            "providerInstances":{"fx":{"driver":driver,"enabled":true,"config":config}}
        }).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"fx","model":"test"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-acp",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: if copilot { "approval-required" } else { "auto" },
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t-acp",
                message_id: "m-acp",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver,
            },
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='t-acp'", [])?;
                let provider: String = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id='t-acp'", [], |r| r.get(0))?;
                let handoff = json!({"id":"side-digest","threadId":"t-acp","targetRunId":"run:thread:t-acp:ordinal:1","toProviderThreadId":provider,"strategy":"manual_context","transferId":"fork","summaryText":"parent digest"});
                tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side-digest','t-acp','run:thread:t-acp:ordinal:1',?1,'manual_context','ready','now',?2)", params![provider,handoff.to_string()])?;
                let row = crate::outbox::list_by_command_id(tx, "send")?
                    .into_iter()
                    .find(|e| e.request["type"] == "provider-turn.start")
                    .unwrap();
                Ok((row, vec![]))
            })
            .unwrap();
        let restore = crate::workspace_safety::reserve(
            &root,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let running_bus = bus.clone();
        let running_settings = settings.clone();
        let worker = std::thread::spawn(move || {
            start(
                &running_bus,
                &effect,
                Some(&running_settings),
                running_settings.parent().unwrap(),
                &super::super::session_registry::SessionRegistry::default(),
                None,
                &mut None,
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        let started = bus.commit(|tx| { let started:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE thread_id='t-acp')", [], |r|r.get(0))?; Ok((started,vec![])) }).unwrap();
        assert!(!started, "ACP startup must wait for an overlapping restore");
        drop(restore);
        let mut request = None;
        for _ in 0..200 {
            request=bus.commit(|tx| { let id:Option<String>=tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id='t-acp' AND status='pending'",[],|r|r.get(0)).optional()?; Ok((id,vec![])) }).unwrap();
            if request.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let request = request.expect("ACP approval projected");
        deliver_approval(&request, Some("accept")).unwrap();
        worker.join().unwrap().unwrap();
        let key=bus.commit(|tx| {
            let delivered: String = tx.query_row("SELECT json_extract(payload_json,'$.delivery.status') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side-digest'", [], |r| r.get(0))?;
            assert_eq!(delivered, "inline");
            let (key,raw):(String,String)=tx.query_row("SELECT provider_thread_id,payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='t-acp'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let pt:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(pt["nativeThreadRef"]["nativeId"],"fx-native"); assert_eq!(pt["driver"],driver);
            let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id='t-acp' AND role='assistant'",[],|r|r.get(0))?;
            assert_eq!(text,"hello from fx");
            let thought:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_turn_items WHERE thread_id='t-acp' AND type='reasoning'",[],|r|r.get(0))?;
            assert_eq!(thought,"thinking");
            let (status,name):(String,String)=tx.query_row("SELECT status,json_extract(payload_json,'$.toolName') FROM orchestration_v2_projection_turn_items WHERE thread_id='t-acp' AND type='dynamic_tool'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"completed"); assert_eq!(name, if copilot { "docs.lookup" } else { "Read file" });
            if copilot {
                let pattern: String = tx.query_row("SELECT json_extract(payload_json,'$.pattern') FROM orchestration_v2_projection_turn_items WHERE thread_id='t-acp' AND type='file_search' AND status='completed'", [], |r| r.get(0))?;
                assert_eq!(pattern, "*.rs");
            }
            let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t-acp'",[],|r|r.get(0))?;
            assert_eq!(status,"waiting");
            Ok((key,vec![]))
        }).unwrap();
        sessions().lock().unwrap().remove(&key);
        let _ = std::fs::remove_dir_all(root);
    }
}
