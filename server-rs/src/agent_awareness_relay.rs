//! Relay agent activity publishing and awareness projection.
use crate::{
    cloud_link_key,
    event_bus::EventBus,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

const RELAY_ACTIVITY_PUBLISH_TYP: &str = "t3-env-activity+jwt";
const RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH: usize = 160;
const REDACTED_RELAY_AGENT_FAILURE_DETAIL: &str = "The agent run failed.";
const RETRY_DELAYS_MS: &[u64] = &[1_000, 2_000, 4_000, 8_000, 16_000];
const CONFIRM_DELAY: Duration = Duration::from_secs(5);

fn read_secret_string(secrets_dir: &Path, name: &str) -> Option<String> {
    let raw = fs::read_to_string(secrets_dir.join(format!("{name}.bin"))).ok()?;
    Some(raw)
}

/// Mirrors the per-publish gate in `AgentAwarenessRelay`, so the descriptor
/// capability never advertises publishing that the publisher would skip.
pub fn read_agent_activity_publishing_active(secrets_dir: &Path) -> bool {
    let enabled = read_secret_string(secrets_dir, "cloud-publish-agent-activity");
    let url = read_secret_string(secrets_dir, "cloud-relay-url");
    let credential = read_secret_string(secrets_dir, "cloud-relay-environment-credential");
    enabled.as_deref() == Some("true")
        && url.as_deref().is_some_and(|s| !s.is_empty())
        && credential.as_deref().is_some_and(|s| !s.is_empty())
}

#[derive(Clone, Debug)]
struct RelayConfig {
    url: String,
    issuer: String,
    environment_credential: String,
}

fn read_relay_config(secrets_dir: &Path) -> Option<RelayConfig> {
    let url = read_secret_string(secrets_dir, "cloud-relay-url").filter(|s| !s.is_empty())?;
    let credential =
        read_secret_string(secrets_dir, "cloud-relay-environment-credential")
            .filter(|s| !s.is_empty())?;
    let issuer = read_secret_string(secrets_dir, "cloud-relay-issuer")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| url.clone());
    Some(RelayConfig {
        url,
        issuer,
        environment_credential: credential,
    })
}

fn is_listed_lineage(lineage: &Value) -> bool {
    let rel = lineage["relationshipToParent"].as_str();
    let side_chat = lineage["sideChat"] == true;
    rel != Some("subagent") && !side_chat
}

fn turn_item_can_change_user_wait(item_type: &str) -> bool {
    matches!(item_type, "secret_request" | "link_request" | "user_message")
}

fn is_work_active(status: &str) -> bool {
    matches!(status, "pending" | "starting" | "running" | "waiting")
}

fn turn_item_update_can_end_background_work(item_type: &str, status: &str) -> bool {
    matches!(item_type, "command_execution" | "dynamic_tool" | "subagent") && !is_work_active(status)
}

pub fn should_publish_agent_awareness_event(event_type: &str, payload: &Value) -> bool {
    if event_type == "thread.created" && payload["historyOrigin"].as_str() == Some("v1_import") {
        return false;
    }
    match event_type {
        "thread.created"
        | "thread.archived"
        | "thread.unarchived"
        | "thread.deleted"
        | "thread.metadata-updated"
        | "thread.pull-request-link-updated"
        | "thread.pull-request-synced"
        | "thread.issue-synced"
        | "thread.settled"
        | "thread.model-selection-updated"
        | "thread.provider-switched"
        | "run.created"
        | "run.updated"
        | "runtime-request.updated"
        | "subagent.updated"
        | "provider-thread.updated" => true,
        "turn-item.updated" => {
            let item_type = payload["type"].as_str();
            let status = payload["status"].as_str();
            match (item_type, status) {
                (Some(t), Some(s)) => {
                    turn_item_can_change_user_wait(t)
                        || turn_item_update_can_end_background_work(t, s)
                }
                _ => false,
            }
        }
        _ => false,
    }
}

fn background_work_holds_completion(tasks: &[Value]) -> bool {
    tasks.iter().any(|task| {
        task["awaited"] == true
            || matches!(task["kind"].as_str(), Some("subagent" | "background_task"))
    })
}

fn monitor_holds_wake_completion(thread: &Value) -> bool {
    if thread["latestRunBackgroundWake"] != true {
        return false;
    }
    thread["pendingBackgroundTasks"]
        .as_array()
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["kind"].as_str() == Some("monitor")
                    && !task["taskId"]
                        .as_str()
                        .is_some_and(|id| id.starts_with("pull-request-watch:"))
            })
        })
}

pub fn subagent_awaits_user(thread: &Value) -> bool {
    let req = &thread["pendingRuntimeRequest"];
    let Some(kind) = req["kind"].as_str() else {
        return false;
    };
    if kind == "auth_refresh" {
        return false;
    }
    if kind == "user_input" && req["userOnly"] != true {
        return false;
    }
    if thread["lineage"]["relationshipToParent"].as_str() != Some("subagent") {
        return false;
    }
    let is_provider_native = thread["lineage"]["subagentOrigin"].as_str() == Some("provider_native")
        || thread["creationSource"].as_str() == Some("provider");
    !is_provider_native && !thread["activityRunStatus"].is_null()
}

#[derive(Clone, Debug)]
pub struct SubagentRequestAwareness {
    pub request_id: String,
    pub updated_at: String,
    pub waits_for_input: bool,
}

fn resolve_phase(
    thread: &Value,
    subagent_request: Option<&SubagentRequestAwareness>,
) -> Option<&'static str> {
    let req = &thread["pendingRuntimeRequest"];
    if let Some(kind) = req["kind"].as_str() {
        if kind == "user_input" {
            return Some("waiting_for_input");
        }
        if kind != "auth_refresh" {
            return Some("waiting_for_approval");
        }
    }
    if let Some(sub) = subagent_request {
        return Some(if sub.waits_for_input {
            "waiting_for_input"
        } else {
            "waiting_for_approval"
        });
    }
    let status = thread["activityRunStatus"]
        .as_str()
        .or_else(|| thread["status"].as_str())?;
    match status {
        "preparing" | "starting" => Some("starting"),
        "running" | "waiting" => Some("running"),
        "completed" => {
            let tasks = thread["pendingBackgroundTasks"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if background_work_holds_completion(tasks) || monitor_holds_wake_completion(thread) {
                Some("running")
            } else {
                Some("completed")
            }
        }
        "failed" => Some("failed"),
        _ => None,
    }
}

fn headline_for_phase(phase: &str) -> &'static str {
    match phase {
        "starting" => "Starting agent",
        "running" => "Agent is working",
        "waiting_for_approval" => "Approval needed",
        "waiting_for_input" => "Input needed",
        "completed" => "Task completed",
        "failed" => "Task failed",
        _ => "Agent update",
    }
}

fn encode_uri_component(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn max_iso_timestamp(a: &str, b: &str) -> String {
    match (
        DateTime::parse_from_rfc3339(a),
        DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(ta), Ok(tb)) => {
            if tb > ta {
                b.to_owned()
            } else {
                a.to_owned()
            }
        }
        _ => a.to_owned(),
    }
}

pub fn project_thread_awareness_v2(
    environment_id: &str,
    project_title: &str,
    thread: &Value,
    pending_subagent_request: Option<&SubagentRequestAwareness>,
) -> Option<Value> {
    if !is_listed_lineage(&thread["lineage"]) {
        return None;
    }
    let phase = resolve_phase(thread, pending_subagent_request)?;
    if phase == "completed" && thread["latestRunStopRequested"] == true {
        return None;
    }
    let run_status = thread["activityRunStatus"]
        .as_str()
        .or_else(|| thread["status"].as_str());
    let tasks = thread["pendingBackgroundTasks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if thread["settledOverride"].as_str() == Some("settled")
        && (phase == "completed"
            || phase == "failed"
            || (phase == "running" && run_status == Some("completed")))
        && !background_work_holds_completion(tasks)
    {
        return None;
    }
    let detail = match phase {
        "completed" => Some("Review the completed task."),
        "failed" => Some("The agent run failed."),
        _ => None,
    };
    let thread_id = thread["id"].as_str()?;
    let thread_updated_at = thread["updatedAt"].as_str().unwrap_or("");
    let updated_at = match pending_subagent_request {
        Some(sub) => max_iso_timestamp(thread_updated_at, &sub.updated_at),
        None => thread_updated_at.to_owned(),
    };
    let mut state = json!({
        "environmentId": environment_id,
        "threadId": thread_id,
        "projectTitle": project_title,
        "threadTitle": thread["title"].as_str().unwrap_or(""),
        "phase": phase,
        "headline": headline_for_phase(phase),
        "modelTitle": thread["modelSelection"]["model"].as_str().unwrap_or(""),
        "updatedAt": updated_at,
        "deepLink": format!(
            "/threads/{}/{}",
            encode_uri_component(environment_id),
            encode_uri_component(thread_id)
        ),
    });
    if let Some(d) = detail {
        state["detail"] = json!(d);
    }
    Some(state)
}

pub fn sanitize_relay_agent_activity_state(state: Option<Value>) -> Option<Value> {
    let mut obj = match state? {
        Value::Object(map) => map,
        _ => return None,
    };
    let raw_detail = if obj.get("phase").and_then(Value::as_str) == Some("failed") {
        Some(REDACTED_RELAY_AGENT_FAILURE_DETAIL.to_owned())
    } else {
        obj.get("detail")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    obj.remove("detail");
    if let Some(detail) = raw_detail {
        let trimmed = detail.trim();
        let truncated: String = trimmed
            .chars()
            .take(RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH)
            .collect();
        let final_detail = truncated.trim();
        if !final_detail.is_empty() {
            obj.insert("detail".to_owned(), json!(final_detail));
        }
    }
    Some(Value::Object(obj))
}

fn terminal_work_since_start(thread: &Value, started_at_ms: i64) -> bool {
    thread["latestRunCompletedAt"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|dt| dt.timestamp_millis() > started_at_ms)
}

pub fn resolve_agent_awareness_relay_active_thread_ids(
    environment_id: &str,
    started_at_ms: i64,
    projects: &HashMap<String, String>,
    threads: &[Value],
) -> Vec<String> {
    threads
        .iter()
        .filter(|thread| {
            if subagent_awaits_user(thread) {
                return true;
            }
            let Some(project_title) = thread["projectId"]
                .as_str()
                .and_then(|pid| projects.get(pid))
            else {
                return false;
            };
            let Some(state) = project_thread_awareness_v2(environment_id, project_title, thread, None)
            else {
                return false;
            };
            let phase = state["phase"].as_str().unwrap_or("");
            if phase != "completed" && phase != "failed" {
                true
            } else {
                terminal_work_since_start(thread, started_at_ms)
            }
        })
        .filter_map(|t| t["id"].as_str().map(str::to_owned))
        .collect()
}

fn publish_identity(
    state: Option<&Value>,
    subagent_request: Option<&SubagentRequestAwareness>,
) -> String {
    let Some(Value::Object(map)) = state else {
        return "null".to_owned();
    };
    let mut meaningful = map.clone();
    meaningful.remove("updatedAt");
    let meaningful_val = Value::Object(meaningful);
    match subagent_request {
        None => meaningful_val.to_string(),
        Some(sub) => json!([meaningful_val, sub.request_id]).to_string(),
    }
}

pub fn make_publish_proof(
    secrets_dir: &Path,
    relay_issuer: &str,
    environment_id: &str,
    thread_id: &str,
    state: Option<&Value>,
    jti: &str,
) -> Result<String, String> {
    let key = cloud_link_key::load_or_create(secrets_dir).map_err(|e| e.to_string())?;
    let iat = Utc::now().timestamp();
    let exp = iat + 300;
    let aud = relay_issuer.trim().trim_end_matches('/');
    let payload = json!({
        "iss": format!("t3-env:{environment_id}"),
        "aud": aud,
        "sub": environment_id,
        "jti": jti,
        "iat": iat,
        "exp": exp,
        "environmentId": environment_id,
        "threadId": thread_id,
        "state": state.cloned().unwrap_or(Value::Null),
    });
    key.sign_typed(RELAY_ACTIVITY_PUBLISH_TYP, &payload)
        .map_err(|e| e.to_string())
}

fn read_awareness_thread(bus: &EventBus, thread_id: &str) -> Option<Value> {
    bus.with_autocommit(|db| {
        db.query_row(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
            [thread_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
    })
    .ok()?
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

fn read_project_title(bus: &EventBus, project_id: &str) -> Option<String> {
    bus.with_autocommit(|db| {
        db.query_row(
            "SELECT title FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",
            [project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
    })
    .ok()?
    .ok()
    .flatten()
}

struct SubagentEntry {
    top_level_thread_id: String,
    request_id: String,
}

struct RelayState {
    started_at_ms: i64,
    published_by_thread: HashMap<String, String>,
    confirm_deadlines: HashMap<String, i64>,
    held_completions: HashSet<String>,
    subagent_requests: HashMap<String, SubagentEntry>,
    child_alerts: HashMap<String, (String, String)>,
    retry_attempts: HashMap<String, usize>,
    last_config: Option<(String, String, String)>,
}

impl RelayState {
    fn new() -> Self {
        Self {
            started_at_ms: Utc::now().timestamp_millis(),
            published_by_thread: HashMap::new(),
            confirm_deadlines: HashMap::new(),
            held_completions: HashSet::new(),
            subagent_requests: HashMap::new(),
            child_alerts: HashMap::new(),
            retry_attempts: HashMap::new(),
            last_config: None,
        }
    }

    fn reset_connection(&mut self) {
        self.last_config = None;
        self.confirm_deadlines.clear();
        self.held_completions.clear();
        self.published_by_thread.clear();
    }

    fn has_live_published_state(&self, thread_id: &str) -> bool {
        self.published_by_thread
            .get(thread_id)
            .is_some_and(|id| id != "null")
    }
}

fn find_top_level_thread_id(bus: &EventBus, child: &Value) -> Option<String> {
    let mut seen = HashSet::new();
    let mut current = child.clone();
    if let Some(id) = current["id"].as_str() {
        seen.insert(id.to_owned());
    }
    loop {
        let rel = current["lineage"]["relationshipToParent"].as_str();
        let side_chat = current["lineage"]["sideChat"] == true;
        if rel != Some("subagent") && !side_chat {
            return current["id"].as_str().map(str::to_owned);
        }
        let parent_id = current["lineage"]["parentThreadId"].as_str()?;
        if !seen.insert(parent_id.to_owned()) {
            return None;
        }
        current = read_awareness_thread(bus, parent_id)?;
    }
}

async fn send_activity_to_relay(
    client: &reqwest::Client,
    config: &RelayConfig,
    secrets_dir: &Path,
    environment_id: &str,
    thread_id: &str,
    state: Option<&Value>,
) -> Result<(), String> {
    let jti = Uuid::new_v4().to_string();
    let proof = make_publish_proof(
        secrets_dir,
        &config.issuer,
        environment_id,
        thread_id,
        state,
        &jti,
    )?;
    let url = format!(
        "{}/v1/environments/{}/threads/{}/agent-activity",
        config.url.trim_end_matches('/'),
        encode_uri_component(environment_id),
        encode_uri_component(thread_id)
    );
    let body = json!({
        "state": state.cloned().unwrap_or(Value::Null),
        "proof": proof,
    })
    .to_string();
    let response = client
        .post(&url)
        .bearer_auth(&config.environment_credential)
        .header("content-type", "application/json")
        .body(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Relay publish returned HTTP {}", response.status()));
    }
    Ok(())
}

async fn process_thread_publish(
    bus: &EventBus,
    secrets_dir: &Path,
    environment_id: &str,
    thread_id: &str,
    state: &Arc<Mutex<RelayState>>,
    tx: &mpsc::UnboundedSender<String>,
    client: &reqwest::Client,
) {
    if !read_agent_activity_publishing_active(secrets_dir) {
        state.lock().await.reset_connection();
        return;
    }
    let Some(relay_config) = read_relay_config(secrets_dir) else {
        state.lock().await.reset_connection();
        return;
    };

    let thread_shell = read_awareness_thread(bus, thread_id);
    let mut guard = state.lock().await;
    let cfg_tuple = (
        relay_config.url.clone(),
        relay_config.issuer.clone(),
        relay_config.environment_credential.clone(),
    );
    if guard.last_config.as_ref() != Some(&cfg_tuple) {
        guard.reset_connection();
        guard.last_config = Some(cfg_tuple);
    }

    // Track subagent waiting requests
    if let Some(shell) = thread_shell.as_ref() {
        let req_id = if shell["archivedAt"].is_null() && subagent_awaits_user(shell) {
            shell["pendingRuntimeRequest"]["id"]
                .as_str()
                .map(str::to_owned)
        } else {
            None
        };
        if let Some(request_id) = req_id {
            let top = guard
                .subagent_requests
                .get(thread_id)
                .map(|e| e.top_level_thread_id.clone())
                .or_else(|| find_top_level_thread_id(bus, shell));
            if let Some(top_level_thread_id) = top {
                guard.subagent_requests.insert(
                    thread_id.to_owned(),
                    SubagentEntry {
                        top_level_thread_id: top_level_thread_id.clone(),
                        request_id,
                    },
                );
                let _ = tx.send(top_level_thread_id);
            }
        } else if let Some(prev) = guard.subagent_requests.remove(thread_id) {
            let _ = tx.send(prev.top_level_thread_id);
        }
    } else if let Some(prev) = guard.subagent_requests.remove(thread_id) {
        let _ = tx.send(prev.top_level_thread_id);
    }

    if let Some(shell) = thread_shell.as_ref() {
        if !is_listed_lineage(&shell["lineage"]) && !guard.has_live_published_state(thread_id) {
            return;
        }
    }

    // Resolve current subagent request for top-level thread
    let mut pending_subagent: Option<SubagentRequestAwareness> = None;
    let child_ids: Vec<(String, String)> = guard
        .subagent_requests
        .iter()
        .filter(|(_, e)| e.top_level_thread_id == thread_id)
        .map(|(cid, e)| (cid.clone(), e.request_id.clone()))
        .collect();
    for (child_id, prev_req_id) in child_ids {
        let child = read_awareness_thread(bus, &child_id);
        let req_id = child
            .as_ref()
            .filter(|c| c["archivedAt"].is_null() && subagent_awaits_user(c))
            .and_then(|c| c["pendingRuntimeRequest"]["id"].as_str().map(str::to_owned));
        let (Some(child_val), Some(request_id)) = (child, req_id) else {
            guard.subagent_requests.remove(&child_id);
            continue;
        };
        if request_id != prev_req_id {
            if let Some(entry) = guard.subagent_requests.get_mut(&child_id) {
                entry.request_id = request_id.clone();
            }
        }
        let child_updated_at = child_val["updatedAt"].as_str().unwrap_or("").to_owned();
        let waits_for_input =
            child_val["pendingRuntimeRequest"]["kind"].as_str() == Some("user_input");
        let is_newer = pending_subagent.as_ref().is_none_or(|p| {
            DateTime::parse_from_rfc3339(&child_updated_at).ok()
                > DateTime::parse_from_rfc3339(&p.updated_at).ok()
        });
        if is_newer {
            pending_subagent = Some(SubagentRequestAwareness {
                request_id,
                updated_at: child_updated_at,
                waits_for_input,
            });
        }
    }

    let active_thread = thread_shell.filter(|s| s["archivedAt"].is_null());
    let project_title = active_thread
        .as_ref()
        .and_then(|t| t["projectId"].as_str())
        .and_then(|pid| read_project_title(bus, pid));
    let raw_state = match (&active_thread, &project_title) {
        (Some(t), Some(title)) => {
            project_thread_awareness_v2(environment_id, title, t, pending_subagent.as_ref())
        }
        _ => None,
    };
    let child_drives_wait = pending_subagent.is_some()
        && raw_state.as_ref().and_then(|s| s["phase"].as_str())
            != active_thread
                .as_ref()
                .zip(project_title.as_ref())
                .and_then(|(t, title)| project_thread_awareness_v2(environment_id, title, t, None))
                .and_then(|s| s["phase"].as_str().map(str::to_owned))
                .as_deref();
    let subagent_wait = if child_drives_wait {
        pending_subagent.as_ref()
    } else {
        None
    };
    let mut snapshot_state = sanitize_relay_agent_activity_state(raw_state);
    let identity = publish_identity(snapshot_state.as_ref(), subagent_wait);

    let phase = snapshot_state
        .as_ref()
        .and_then(|s| s["phase"].as_str());
    if matches!(phase, Some("completed" | "failed"))
        && !guard.has_live_published_state(thread_id)
        && !active_thread
            .as_ref()
            .is_some_and(|t| terminal_work_since_start(t, guard.started_at_ms))
    {
        return;
    }

    if guard.published_by_thread.get(thread_id) == Some(&identity)
        && !(snapshot_state.is_none() && guard.held_completions.contains(thread_id))
    {
        guard.confirm_deadlines.remove(thread_id);
        guard.held_completions.remove(thread_id);
        return;
    }

    let requires_confirmation = snapshot_state.is_none() || phase == Some("completed");
    if requires_confirmation {
        if phase == Some("completed") {
            guard.held_completions.insert(thread_id.to_owned());
        }
        let now_ms = Utc::now().timestamp_millis();
        let deadline = guard.confirm_deadlines.get(thread_id).copied();
        let Some(deadline) = deadline else {
            guard
                .confirm_deadlines
                .insert(thread_id.to_owned(), now_ms + 5_000);
            let tx_confirm = tx.clone();
            let tid = thread_id.to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(CONFIRM_DELAY).await;
                let _ = tx_confirm.send(tid);
            });
            return;
        };
        if now_ms < deadline {
            return;
        }
        if snapshot_state.is_none() && guard.held_completions.contains(thread_id) {
            if let (Some(mut t), Some(title)) = (active_thread.clone(), project_title.clone()) {
                if t["settledOverride"].as_str() == Some("settled") {
                    t["settledOverride"] = Value::Null;
                    let unsettled = sanitize_relay_agent_activity_state(
                        project_thread_awareness_v2(environment_id, &title, &t, None),
                    );
                    if unsettled
                        .as_ref()
                        .and_then(|s| s["phase"].as_str())
                        == Some("completed")
                    {
                        let completion = unsettled.unwrap();
                        drop(guard);
                        if send_activity_to_relay(
                            client,
                            &relay_config,
                            secrets_dir,
                            environment_id,
                            thread_id,
                            Some(&completion),
                        )
                        .await
                        .is_ok()
                        {
                            let mut guard = state.lock().await;
                            guard.held_completions.remove(thread_id);
                            guard
                                .confirm_deadlines
                                .insert(thread_id.to_owned(), now_ms + 5_000);
                            guard.published_by_thread.insert(
                                thread_id.to_owned(),
                                publish_identity(Some(&completion), None),
                            );
                            let tx_confirm = tx.clone();
                            let tid = thread_id.to_owned();
                            tokio::spawn(async move {
                                tokio::time::sleep(CONFIRM_DELAY).await;
                                let _ = tx_confirm.send(tid);
                            });
                        }
                        return;
                    }
                }
            }
        }
    } else {
        guard.confirm_deadlines.remove(thread_id);
        guard.held_completions.remove(thread_id);
    }

    if let (Some(ref mut st), Some(sub)) = (&mut snapshot_state, subagent_wait) {
        if let Some((prev_req, prev_updated)) = guard.child_alerts.get(thread_id) {
            if prev_req == &sub.request_id {
                st["updatedAt"] = json!(prev_updated);
            }
        }
    }
    let child_req_id = subagent_wait.map(|s| s.request_id.clone());
    let state_updated_at = snapshot_state
        .as_ref()
        .and_then(|s| s["updatedAt"].as_str().map(str::to_owned));
    drop(guard);

    match send_activity_to_relay(
        client,
        &relay_config,
        secrets_dir,
        environment_id,
        thread_id,
        snapshot_state.as_ref(),
    )
    .await
    {
        Ok(()) => {
            let mut guard = state.lock().await;
            if let (Some(req_id), Some(updated_at)) = (child_req_id, state_updated_at) {
                guard
                    .child_alerts
                    .insert(thread_id.to_owned(), (req_id, updated_at));
            }
            guard.confirm_deadlines.remove(thread_id);
            guard.held_completions.remove(thread_id);
            guard.retry_attempts.remove(thread_id);
            guard
                .published_by_thread
                .insert(thread_id.to_owned(), identity);
        }
        Err(_) => {
            let mut guard = state.lock().await;
            let attempts = guard.retry_attempts.get(thread_id).copied().unwrap_or(0);
            if let Some(&delay_ms) = RETRY_DELAYS_MS.get(attempts) {
                guard
                    .retry_attempts
                    .insert(thread_id.to_owned(), attempts + 1);
                let tx_retry = tx.clone();
                let tid = thread_id.to_owned();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let _ = tx_retry.send(tid);
                });
            }
        }
    }
}

pub async fn run(bus: EventBus, secrets_dir: PathBuf, environment_id: String) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let state = Arc::new(Mutex::new(RelayState::new()));
    let client = reqwest::Client::new();

    // Subscribe to domain events
    let tx_events = tx.clone();
    let bus_events = bus.clone();
    tokio::spawn(async move {
        let Ok((_, mut live)) = bus_events.subscribe_application() else {
            return;
        };
        while let Ok(envelope) = live.recv().await {
            let event = &envelope.event;
            if !should_publish_agent_awareness_event(&event.event_type, &event.payload) {
                continue;
            }
            if !event.stream_id.is_empty() {
                let _ = tx_events.send(event.stream_id.clone());
            }
        }
    });

    // Initial active thread catch-up with backoff when unlinked/disabled
    let tx_catchup = tx.clone();
    let bus_catchup = bus.clone();
    let secrets_catchup = secrets_dir.clone();
    let env_catchup = environment_id.clone();
    let state_catchup = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut unlinked_delay_ms = 5_000u64;
        loop {
            if !read_agent_activity_publishing_active(&secrets_catchup) {
                tokio::time::sleep(Duration::from_millis(unlinked_delay_ms)).await;
                unlinked_delay_ms = (unlinked_delay_ms * 2).min(60_000);
                continue;
            }
            let started_at_ms = state_catchup.lock().await.started_at_ms;
            let snapshot = bus_catchup.with_autocommit(|db| {
                let mut projects = HashMap::new();
                if let Ok(mut stmt) = db.prepare(
                    "SELECT project_id, title FROM projection_projects WHERE deleted_at IS NULL",
                ) {
                    if let Ok(rows) = stmt.query_map([], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    }) {
                        for row in rows.flatten() {
                            projects.insert(row.0, row.1);
                        }
                    }
                }
                let mut threads = Vec::new();
                if let Ok(mut stmt) = db.prepare(
                    "SELECT payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL",
                ) {
                    if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                        for row in rows.flatten() {
                            if let Ok(val) = serde_json::from_str::<Value>(&row) {
                                threads.push(val);
                            }
                        }
                    }
                }
                (projects, threads)
            });
            if let Ok((projects, threads)) = snapshot {
                let ids = resolve_agent_awareness_relay_active_thread_ids(
                    &env_catchup,
                    started_at_ms,
                    &projects,
                    &threads,
                );
                for id in ids {
                    let _ = tx_catchup.send(id);
                }
            }
            break;
        }
    });

    while let Some(thread_id) = rx.recv().await {
        if bus.shutdown_flag().load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        process_thread_publish(
            &bus,
            &secrets_dir,
            &environment_id,
            &thread_id,
            &state,
            &tx,
            &client,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_agent_activity_publishing_active_matches_secret_gate() {
        let dir = std::env::temp_dir().join(format!("awareness-gate-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!read_agent_activity_publishing_active(&dir));

        fs::write(dir.join("cloud-publish-agent-activity.bin"), "true").unwrap();
        assert!(!read_agent_activity_publishing_active(&dir));

        fs::write(dir.join("cloud-relay-url.bin"), "").unwrap();
        fs::write(dir.join("cloud-relay-environment-credential.bin"), "cred").unwrap();
        assert!(!read_agent_activity_publishing_active(&dir));

        fs::write(dir.join("cloud-relay-url.bin"), "https://relay.example.com").unwrap();
        assert!(read_agent_activity_publishing_active(&dir));

        fs::write(dir.join("cloud-publish-agent-activity.bin"), "false").unwrap();
        assert!(!read_agent_activity_publishing_active(&dir));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn filters_and_projects_thread_awareness() {
        assert!(!should_publish_agent_awareness_event(
            "thread.created",
            &json!({"historyOrigin": "v1_import"})
        ));
        assert!(should_publish_agent_awareness_event(
            "thread.created",
            &json!({})
        ));
        assert!(!should_publish_agent_awareness_event(
            "message.updated",
            &json!({})
        ));
        assert!(should_publish_agent_awareness_event(
            "turn-item.updated",
            &json!({"type": "secret_request", "status": "running"})
        ));
        assert!(should_publish_agent_awareness_event(
            "turn-item.updated",
            &json!({"type": "command_execution", "status": "completed"})
        ));
        assert!(!should_publish_agent_awareness_event(
            "turn-item.updated",
            &json!({"type": "command_execution", "status": "running"})
        ));

        let thread = json!({
            "id": "t1",
            "projectId": "p1",
            "title": "Fix bug",
            "status": "failed",
            "activityRunStatus": "failed",
            "lineage": {"relationshipToParent": null, "sideChat": false},
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "pendingRuntimeRequest": null,
            "pendingBackgroundTasks": [],
            "updatedAt": "2026-01-01T00:00:00Z"
        });
        let projected = project_thread_awareness_v2("env1", "My Project", &thread, None).unwrap();
        assert_eq!(projected["phase"], "failed");
        assert_eq!(projected["deepLink"], "/threads/env1/t1");
        let sanitized = sanitize_relay_agent_activity_state(Some(projected)).unwrap();
        assert_eq!(sanitized["detail"], REDACTED_RELAY_AGENT_FAILURE_DETAIL);
    }
}
