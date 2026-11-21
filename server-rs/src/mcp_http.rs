//! Authenticated MCP Streamable HTTP transport and orchestration tools.
use crate::provider::session_registry::SessionRegistry;
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const LEGACY: &str = "2025-06-18";
const MODERN: &str = "2026-07-28";
const MAX_BODY: usize = 1024 * 1024;

#[derive(Clone)]
struct Session {
    owner: String,
    version: String,
}
struct McpState {
    credentials: Arc<SessionRegistry>,
    environment_id: String,
    sessions: Mutex<HashMap<String, Session>>,
    db: Arc<Mutex<rusqlite::Connection>>,
    bus: crate::event_bus::EventBus,
    settings: Arc<crate::settings::Settings>,
    provider_cache: Arc<Mutex<Option<Vec<Value>>>>,
    worktrees_dir: std::path::PathBuf,
    signing_key: [u8; 32],
    oauth_enabled: bool,
    secrets_dir: std::path::PathBuf,
    auth: Option<Arc<crate::auth_http::AuthHttpState>>,
    review_guide_runs: Arc<crate::pull_request_review_guide::Runs>,
    review_guide_worktrees: std::path::PathBuf,
}

#[allow(clippy::too_many_arguments)]
pub fn router(
    credentials: Arc<SessionRegistry>,
    db: Arc<Mutex<rusqlite::Connection>>,
    environment_id: String,
    bus: crate::event_bus::EventBus,
    settings: Arc<crate::settings::Settings>,
    provider_cache: Arc<Mutex<Option<Vec<Value>>>>,
    worktrees_dir: std::path::PathBuf,
    signing_key: [u8; 32],
    oauth_enabled: bool,
    secrets_dir: std::path::PathBuf,
) -> Router {
    let review_guide_worktrees = worktrees_dir.join("review-guides");
    router_with_guides(
        credentials,
        db,
        environment_id,
        bus,
        settings,
        provider_cache,
        worktrees_dir,
        signing_key,
        oauth_enabled,
        secrets_dir,
        None,
        Arc::new(crate::pull_request_review_guide::Runs::default()),
        review_guide_worktrees,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn router_with_guides(
    credentials: Arc<SessionRegistry>,
    db: Arc<Mutex<rusqlite::Connection>>,
    environment_id: String,
    bus: crate::event_bus::EventBus,
    settings: Arc<crate::settings::Settings>,
    provider_cache: Arc<Mutex<Option<Vec<Value>>>>,
    worktrees_dir: std::path::PathBuf,
    signing_key: [u8; 32],
    oauth_enabled: bool,
    secrets_dir: std::path::PathBuf,
    auth: Option<Arc<crate::auth_http::AuthHttpState>>,
    review_guide_runs: Arc<crate::pull_request_review_guide::Runs>,
    review_guide_worktrees: std::path::PathBuf,
) -> Router {
    Router::new()
        .route("/mcp", any(handle))
        .with_state(Arc::new(McpState {
            credentials,
            environment_id,
            db,
            bus,
            settings,
            provider_cache,
            worktrees_dir,
            signing_key,
            oauth_enabled,
            secrets_dir,
            auth,
            review_guide_runs,
            review_guide_worktrees,
            sessions: Mutex::new(HashMap::new()),
        }))
}
async fn capabilities(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
) -> Result<Value, (&'static str, String)> {
    use rusqlite::OptionalExtension;
    let invalid = || {
        (
            "invalid_request",
            "Invalid capabilities arguments.".to_owned(),
        )
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object.keys().any(|k| k != "search") {
        return Err(invalid());
    }
    let search = match object.get("search") {
        None | Some(Value::Null) => None,
        Some(Value::String(s))
            if !s.trim().is_empty() && s.trim().encode_utf16().count() <= 200 =>
        {
            Some(s.trim().to_owned())
        }
        _ => return Err(invalid()),
    };
    let (thread, cwd) = if let Some(client) = scope.client.as_ref() {
        (
            json!({
                "id": "",
                "runtimeMode": client.runtime_mode,
                "interactionMode": client.interaction_mode,
            }),
            "/".to_owned(),
        )
    } else {
        let db = state
            .db
            .lock()
            .map_err(|_| ("orchestration_error", "Database unavailable.".to_owned()))?;
        let row:Option<(String,String,String,Option<String>)>=db.query_row("SELECT t.payload_json,t.runtime_mode,t.interaction_mode,COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|("orchestration_error","Database unavailable.".to_owned()))?;
        let (raw, runtime, interaction, cwd) = row.ok_or_else(|| {
            (
                "thread_not_found",
                format!("Thread {} is no longer available.", scope.thread_id),
            )
        })?;
        let mut thread: Value = serde_json::from_str(&raw)
            .map_err(|_| ("orchestration_error", "Database unavailable.".to_owned()))?;
        thread["id"] = json!(scope.thread_id);
        thread["runtimeMode"] = json!(runtime);
        thread["interactionMode"] = json!(interaction);
        (thread, cwd.unwrap_or_else(|| "/".to_owned()))
    };
    let cache = state.provider_cache.clone();
    let settings_path = state.settings.path().to_owned();
    let providers = tokio::task::spawn_blocking(move || {
        let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());
        cached
            .get_or_insert_with(|| {
                crate::provider::discovery::discover_all(
                    std::path::Path::new(&cwd),
                    Some(&settings_path),
                )
            })
            .clone()
    })
    .await
    .map_err(|_| {
        (
            "orchestration_error",
            "Provider discovery failed.".to_owned(),
        )
    })?;
    Ok(crate::mcp_capabilities::build(
        &thread,
        &state.settings.snapshot(),
        &providers,
        search.as_deref(),
    ))
}
fn require_active_caller(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
) -> Result<(), (&'static str, String)> {
    if scope.client.is_some() {
        return Ok(());
    }
    let db = state
        .db
        .lock()
        .map_err(|_| ("orchestration_error", "Database unavailable.".to_owned()))?;
    let valid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t LEFT JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id AND r.run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=t.thread_id AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND r.provider_instance_id=?2 WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND (r.run_id IS NOT NULL OR EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents s WHERE s.thread_id=t.thread_id AND s.origin='provider_native' AND s.status IN ('preparing','starting','running','waiting') AND json_extract(s.payload_json,'$.providerInstanceId')=?2)))",rusqlite::params![scope.thread_id,scope.provider_instance_id],|r|r.get(0)).map_err(|_|("orchestration_error","Database unavailable.".to_owned()))?;
    if valid {
        Ok(())
    } else {
        Err((
            "parent_not_active",
            "The calling provider no longer owns an active thread run.".into(),
        ))
    }
}
async fn delegate_task(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
) -> Result<Value, (&'static str, String)> {
    let bus = state.bus.clone();
    let scope_owned = scope.clone();
    let args_owned = args.clone();
    let settings = state.settings.snapshot();
    let cache = state.provider_cache.clone();
    let environment = state.environment_id.clone();
    let worktrees = state.worktrees_dir.clone();
    let settings_path = state.settings.path().to_owned();
    let started = tokio::task::spawn_blocking(move || {
        let providers = {
            let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
            cache
                .get_or_insert_with(|| {
                    crate::provider::discovery::discover_all(
                        std::path::Path::new("/"),
                        Some(&settings_path),
                    )
                })
                .clone()
        };
        crate::mcp_delegate::start(
            &bus,
            &scope_owned,
            &args_owned,
            &settings,
            &providers,
            &environment,
            &worktrees,
        )
    })
    .await
    .map_err(|_| {
        (
            "orchestration_error",
            "Delegated task admission failed.".to_owned(),
        )
    })??;
    if started.wait {
        crate::mcp_delegate_wait::await_task(
            &state.db,
            &state.bus,
            scope,
            &started.task_id,
            &started.request_key,
            started.timeout_ms,
            &state.environment_id,
        )
        .await
    } else {
        crate::mcp_task_status::call(
            &state.db,
            &state.bus,
            scope,
            &started.task_id,
            &state.environment_id,
        )
    }
}
fn search_threads(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
) -> Result<Value, (&'static str, String)> {
    use rusqlite::OptionalExtension;
    let db = state
        .db
        .lock()
        .map_err(|_| ("orchestration_error", "Database unavailable.".to_owned()))?;
    let project: Option<String> = db.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&scope.thread_id], |r| r.get(0)).optional().map_err(|_| ("orchestration_error", "Database unavailable.".to_owned()))?;
    let project = project.ok_or_else(|| {
        (
            "thread_not_found",
            "The calling thread was not found.".to_owned(),
        )
    })?;
    crate::mcp_thread_search::search(
        &db,
        args,
        Some(&project),
        Some(&scope.thread_id),
        &state.environment_id,
    )
    .map_err(|e| ("invalid_request", e))
}
fn read_thread(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
) -> Result<Value, (&'static str, String)> {
    use rusqlite::OptionalExtension;
    // Validate the read before hydrating, then release the read connection before
    // the event bus takes its writer lock.
    let target = args["threadId"].as_str().unwrap_or("");
    let (initial_page, pending) = {
        let db = state.db.lock().map_err(|_| {
            (
                "orchestration_error",
                "The operation could not be completed.".to_owned(),
            )
        })?;
        let page = crate::mcp_thread_read::call(&db, args, &state.environment_id, true).map_err(
            |message| {
                (
                    if (message.starts_with("Thread ")
                        && message.ends_with(" is no longer available."))
                        || message.contains("is a thread link, not a thread id.")
                    {
                        "thread_not_found"
                    } else {
                        "invalid_request"
                    },
                    message,
                )
            },
        )?;
        let pending = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id=?1 AND transcript_imported_at IS NULL)",[target], |r| r.get::<_,bool>(0)).map_err(|_| ("orchestration_error", "The operation could not be completed.".to_owned()))?;
        (page, pending)
    };
    if pending {
        crate::legacy_transcript::ensure_transcript(&state.bus, target).map_err(|_| {
            (
                "orchestration_error",
                "Unable to hydrate migrated thread transcript.".to_owned(),
            )
        })?;
    }
    let (page, tasks, observing_run) = {
        let db = state.db.lock().map_err(|_| {
            (
                "orchestration_error",
                "The operation could not be completed.".to_owned(),
            )
        })?;
        let mut page = if pending {
            crate::mcp_thread_read::call(&db, args, &state.environment_id, true).map_err(
                |message| {
                    (
                        if message.starts_with("Thread ")
                            && message.ends_with(" is no longer available.")
                        {
                            "thread_not_found"
                        } else {
                            "invalid_request"
                        },
                        message,
                    )
                },
            )?
        } else {
            initial_page
        };
        let target = args["threadId"].as_str().unwrap_or("");
        let raw: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [target], |r| r.get(0)).map_err(|_| ("thread_not_found", "The thread was not found.".to_owned()))?;
        let mut shell: Value = serde_json::from_str(&raw).map_err(|_| {
            (
                "orchestration_error",
                "Invalid thread projection.".to_owned(),
            )
        })?;
        crate::event_bus::enrich_shell(&db, &mut shell).map_err(|_| {
            (
                "orchestration_error",
                "The operation could not be completed.".to_owned(),
            )
        })?;
        page["thread"]["blockedOnThreadWait"] = json!(shell["blockedOnThreadWait"] == true);
        page["thread"]["pendingBackgroundTasks"] = json!(shell["pendingBackgroundTasks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|task| {
                let mut o = serde_json::Map::new();
                for key in ["taskId", "kind", "description", "awaited"] {
                    if let Some(v) = task.get(key) {
                        o.insert(key.into(), v.clone());
                    }
                }
                if task["kind"] == "subagent" {
                    if let Some(v) = task.get("childThreadId") {
                        o.insert("childThreadId".into(), v.clone());
                    }
                }
                Value::Object(o)
            })
            .collect::<Vec<_>>());
        let newest = args.get("beforePosition").is_some_and(|v| !v.is_null())
            || args.get("afterPosition").is_none_or(Value::is_null);
        while page.to_string().len() > 30_000
            && page["items"].as_array().is_some_and(|v| !v.is_empty())
        {
            let items = page["items"].as_array_mut().unwrap();
            if newest {
                items.remove(0);
            } else {
                items.pop();
            }
            let first = items.first().map(|v| v["position"].clone());
            let last = items.last().map(|v| v["position"].clone());
            page["earlierPosition"] = first.unwrap_or(Value::Null);
            page["nextPosition"] = last.unwrap_or(Value::Null);
            if !newest {
                page["hasMore"] = json!(true);
            }
        }
        let tasks = crate::mcp_thread_read_ack::acknowledged_tasks(
            &db,
            &scope.thread_id,
            target,
            args,
            &page,
        )
        .map_err(|_| {
            (
                "orchestration_error",
                "The operation could not be completed.".to_owned(),
            )
        })?;
        let run: Option<String> = db.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND provider_instance_id=?2 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1", rusqlite::params![scope.thread_id,scope.provider_instance_id], |r| r.get(0)).optional().map_err(|_| ("orchestration_error", "The operation could not be completed.".to_owned()))?;
        (page, tasks, run)
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for task in tasks {
        let command_id = format!("mcp:thread-read-acknowledge:{}", uuid::Uuid::new_v4());
        let result = crate::delegated_ack::dispatch(
            &state.bus,
            &command_id,
            &scope.thread_id,
            &task,
            observing_run.as_deref(),
            &now,
        )
        .map_err(|e| {
            (
                "orchestration_error",
                format!("Unable to acknowledge delegated task {task}: {e}"),
            )
        })?;
        if let Some(error) = result.receipt.error {
            return Err((
                "orchestration_error",
                format!("Unable to acknowledge delegated task {task}: {error}"),
            ));
        }
    }
    Ok(page)
}
fn h<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}
fn error(status: StatusCode, id: Value, code: i32, message: &str) -> Response {
    (
        status,
        Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})),
    )
        .into_response()
}
fn looks_like_provider_token(token: &str) -> bool {
    !token.is_empty() && !token.contains('.')
}

fn resource_metadata_url(headers: &HeaderMap) -> Option<String> {
    let host = headers.get("host")?.to_str().ok()?;
    let protocol = if headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        == Some("https")
    {
        "https"
    } else {
        "http"
    };
    let parsed = url::Url::parse(&format!("{protocol}://{host}")).ok()?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(format!(
        "{}/.well-known/oauth-protected-resource/mcp",
        parsed.origin().ascii_serialization()
    ))
}

fn parse_sender_thread(value: &str) -> Option<crate::mcp_credentials::LinkedSender> {
    let mut parts = value.trim().split('/');
    let env = parts.next()?;
    let thread = parts.next()?;
    let title = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let decode = |s: &str| {
        percent_encoding::percent_decode_str(s)
            .decode_utf8()
            .ok()
            .map(|v| v.into_owned())
    };
    let environment_id = decode(env)?;
    let thread_id = decode(thread)?;
    let title = decode(title)?;
    if environment_id.is_empty() || thread_id.is_empty() {
        return None;
    }
    Some(crate::mcp_credentials::LinkedSender {
        environment_id,
        thread_id,
        title,
    })
}

fn unauthorized(headers: &HeaderMap, presented: bool, offer_oauth: bool) -> Response {
    let mut parts = Vec::new();
    if offer_oauth {
        if let Some(url) = resource_metadata_url(headers) {
            parts.push(format!("resource_metadata=\"{url}\""));
        }
    }
    if presented {
        parts.push("error=\"invalid_token\"".to_owned());
    }
    let challenge = if parts.is_empty() {
        "Bearer".to_owned()
    } else {
        format!("Bearer {}", parts.join(", "))
    };
    (StatusCode::UNAUTHORIZED, [(header::CACHE_CONTROL, "no-store"), (header::WWW_AUTHENTICATE, challenge.as_str())], Json(json!({"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}))).into_response()
}

async fn handle(State(state): State<Arc<McpState>>, request: Request) -> Response {
    let headers = request.headers();
    let authorization = h(headers, "authorization").unwrap_or("");
    let token = authorization
        .split_once(' ')
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
        .unwrap_or("");
    let offer_oauth = state.oauth_enabled && !looks_like_provider_token(token);
    let mut link_expires_at: Option<String> = None;
    let scope = if let Some(scope) = state.credentials.mcp_credentials.resolve(token) {
        scope
    } else if state.oauth_enabled && !token.is_empty() {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let client = {
            let Ok(db) = state.db.lock() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            crate::mcp_client_auth::authenticate(&db, &state.signing_key, authorization, now_ms)
        };
        let Some(client) = client else {
            return unauthorized(headers, true, offer_oauth);
        };
        let asked = match h(headers, "t3-mode-limit") {
            Some(raw) => match crate::mcp_client_auth::parse_mode_limit(raw) {
                Some(modes) => Some(modes),
                None => {
                    return (
                        StatusCode::BAD_REQUEST,
                        [(header::CACHE_CONTROL, "no-store")],
                        Json(json!({"error":"invalid_mode_limit","message":"T3-Mode-Limit must be <runtimeMode>/<interactionMode>, e.g. auto/default."})),
                    )
                        .into_response();
                }
            },
            None => None,
        };
        let settings = state.settings.snapshot();
        let policy_max = settings
            .pointer("/managedPolicy/limits/maxRuntimeMode")
            .and_then(Value::as_str)
            .and_then(crate::mcp_client_auth::RuntimeMode::parse);
        let Some(modes) =
            crate::mcp_client_auth::mode_ceiling(&client.access, asked, policy_max)
        else {
            return unauthorized(headers, true, offer_oauth);
        };
        if client.linked && settings["linkedEnvironmentsEnabled"] != true {
            return (
                StatusCode::FORBIDDEN,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"error":"linked_environments_off","message":"Linked environments is off on this machine. Turn it on in its Settings → Labs."})),
            )
                .into_response();
        }
        let sender_thread = if client.linked {
            h(headers, "t3-sender-thread").and_then(parse_sender_thread)
        } else {
            None
        };
        link_expires_at = client.link_expires_at;
        crate::mcp_credentials::Scope {
            thread_id: String::new(),
            provider_session_id: format!("client:{}", client.session_id),
            provider_instance_id: String::new(),
            capabilities: std::collections::HashSet::from([
                "orchestration".into(),
                "worktree".into(),
                "pull-requests".into(),
                "issues".into(),
            ]),
            subagent: false,
            client: Some(crate::mcp_credentials::ClientScope {
                session_id: client.session_id,
                label: client.label,
                access: client.access,
                linked: client.linked,
                runtime_mode: modes.runtime.as_str().into(),
                interaction_mode: modes.interaction.as_str().into(),
                sender_thread,
            }),
        }
    } else {
        return unauthorized(headers, !token.is_empty(), offer_oauth);
    };
    let mut response = handle_authenticated(state, request, scope).await;
    if let Some(expires_at) = link_expires_at {
        if let Ok(value) = axum::http::HeaderValue::from_str(&expires_at) {
            response.headers_mut().insert(
                axum::http::HeaderName::from_static("t3-link-expires-at"),
                value,
            );
        }
    }
    response
}

async fn handle_authenticated(
    state: Arc<McpState>,
    request: Request,
    scope: crate::mcp_credentials::Scope,
) -> Response {
    let headers = request.headers();
    let method = request.method().clone();
    let session_id = h(headers, "mcp-session-id").map(str::to_owned);
    let version = h(headers, "mcp-protocol-version").map(str::to_owned);
    let method_header = h(headers, "mcp-method").map(str::to_owned);
    if method == axum::http::Method::DELETE {
        let Some(id) = session_id else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let mut sessions = state.sessions.lock().unwrap();
        if sessions
            .get(&id)
            .is_some_and(|s| s.owner == scope.provider_session_id)
        {
            sessions.remove(&id);
            return StatusCode::NO_CONTENT.into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    }
    if method != axum::http::Method::POST {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "POST, DELETE")],
        )
            .into_response();
    }
    let bytes = match to_bytes(request.into_body(), MAX_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, Value::Null, -32700, "Parse error"),
    };
    let id = value.get("id").cloned();
    let Some(rpc_method) = value.get("method").and_then(Value::as_str) else {
        return error(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "Invalid Request",
        );
    };
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || id
            .as_ref()
            .is_some_and(|v| !v.is_string() && !v.is_number() && !v.is_null())
        || value.get("params").is_some_and(|v| !v.is_object())
    {
        return error(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "Invalid Request",
        );
    }
    let modern = version.as_deref() == Some(MODERN);
    if modern {
        if session_id.is_some() || method_header.as_deref() != Some(rpc_method) {
            return error(
                StatusCode::BAD_REQUEST,
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid session or method header",
            );
        }
        let meta = value.pointer("/params/_meta");
        if meta
            .and_then(|m| m.get("io.modelcontextprotocol/protocolVersion"))
            .and_then(Value::as_str)
            != Some(MODERN)
            || !meta
                .and_then(|m| m.get("io.modelcontextprotocol/clientCapabilities"))
                .is_some_and(Value::is_object)
            || !meta
                .and_then(|m| m.get("io.modelcontextprotocol/clientInfo"))
                .is_some_and(Value::is_object)
        {
            return error(
                StatusCode::BAD_REQUEST,
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid client metadata",
            );
        }
    } else if rpc_method != "initialize" {
        let Some(ref sid) = session_id else {
            return error(
                StatusCode::BAD_REQUEST,
                id.unwrap_or(Value::Null),
                -32600,
                "Missing session ID",
            );
        };
        let sessions = state.sessions.lock().unwrap();
        let Some(session) = sessions
            .get(sid)
            .filter(|s| s.owner == scope.provider_session_id)
        else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if version.as_deref().is_some_and(|v| v != session.version) {
            return error(
                StatusCode::BAD_REQUEST,
                id.unwrap_or(Value::Null),
                -32600,
                "Protocol version mismatch",
            );
        }
    } else if session_id.is_some() || version.as_deref().is_some_and(|v| v != LEGACY) {
        return error(
            StatusCode::BAD_REQUEST,
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid initialize request",
        );
    }
    if id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = id.unwrap();
    let result = match rpc_method {
        "initialize" if !modern => {
            let sid = uuid::Uuid::new_v4().to_string();
            state.sessions.lock().unwrap().insert(
                sid.clone(),
                Session {
                    owner: scope.provider_session_id,
                    version: LEGACY.into(),
                },
            );
            let result = json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":LEGACY,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"T3 Code","version":env!("CARGO_PKG_VERSION")}}});
            return (
                [
                    ("mcp-session-id", sid),
                    ("mcp-protocol-version", LEGACY.into()),
                ],
                Json(result),
            )
                .into_response();
        }
        "server/discover" if modern => json!({"supportedVersions":[MODERN, LEGACY]}),
        "ping" => json!({}),
        "tools/list" => {
            let mut tools = Vec::new();
            if scope.capabilities.contains("orchestration") {
                tools.push(thread_list_definition());
                tools.push(json!({"name":"delegate_task","description":"Start one child agent with only the task. Keep taskId to check its status.","inputSchema":{"type":"object","properties":{"task":{"type":"string","minLength":1,"maxLength":120000},"target":{"type":"object"},"title":{"type":"string"},"role":{"enum":["implementation","research","review","design","test","general"]},"isolation":{"enum":["shared","worktree"]},"mode":{"enum":["async","wait"]},"timeoutMs":{"type":"number"},"clientRequestId":{"type":"string"},"runtimeMode":{"type":"string"},"interactionMode":{"type":"string"}},"required":["task"],"additionalProperties":false},"annotations":{"title":"Delegate a child task","readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}}));
                tools.push(json!({"name":"orchestrator_capabilities","description":"List providers, models, options, and runtime modes for delegation.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"search":{"type":"string","minLength":1,"maxLength":200}},"additionalProperties":false},"annotations":{"title":"Get orchestration capabilities","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}}));
                tools.extend(crate::mcp_projects::definitions());
                tools.extend(crate::mcp_thread_read::definitions());
                tools.extend(crate::mcp_thread_search::definitions());
                tools.push(crate::mcp_pending_request::definition());
                tools.push(crate::mcp_thread_configure::definition());
                tools.push(crate::mcp_queue::definition());
                tools.push(crate::mcp_secret::definition());
                tools.push(crate::mcp_scheduled::list_definition());
                tools.push(crate::mcp_scheduled::save_definition());
                tools.push(crate::mcp_scheduled::run_definition());
                tools.push(crate::mcp_scheduled::delete_definition());
                tools.push(crate::mcp_thread_transfer::definition());
                tools.push(crate::mcp_thread_organize::definition());
                tools.push(crate::mcp_thread_update::definition());
                tools.push(crate::mcp_thread_wait::definition());
                tools.push(crate::mcp_thread_send::definition());
                tools.push(crate::mcp_thread_interrupt::definition());
                tools.push(crate::mcp_thread_launch::launch_definition());
                tools.push(crate::mcp_thread_launch::create_threads_definition());
                tools.push(crate::mcp_workflow::workflow_stop_definition());
                tools.push(crate::mcp_workflow::background_wait_definition());
                if !scope.subagent && scope.client.is_none() {
                    tools.extend(crate::pull_request_refresh::watch_tools());
                }
                if scope.capabilities.contains("pull-requests") {
                    let has_forge = crate::mcp_pull_requests::caller_has_forge(&state.db, &scope);
                    tools.extend(crate::mcp_pull_requests::definitions(has_forge));
                }
                tools.push(json!({"name":"t3_environment_read","description":"Read this environment's identity, platform, and user preferences.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"}},"additionalProperties":false},"annotations":{"title":"Read environment","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}}));
                tools.push(json!({"name":"t3_environment_preferences_update","description":"Update environment preferences such as defaultThreadEnvMode, newWorktreesStartFromOrigin, enableProviderUpdateChecks, backgroundActivity, or sourceControlWritingStyle.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"defaultThreadEnvMode":{"type":"string"},"newWorktreesStartFromOrigin":{"type":"boolean"},"enableProviderUpdateChecks":{"type":"boolean"},"backgroundActivity":{"type":"object"},"sourceControlWritingStyle":{"type":"object"}},"additionalProperties":false},"annotations":{"title":"Update environment preferences","destructiveHint":true}}));
                tools.push(json!({"name":"t3_environment_links","description":"List environments linked to this one and their access levels.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"title":"List linked environments","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}}));
                tools.push(crate::peer_link_requests::definition());
                tools.extend(crate::mcp_issues::definitions());
                tools.push(json!({"name":"t3_environment_unlink","description":"Remove a linked environment and revoke its credential.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"}},"required":["environmentId"],"additionalProperties":false},"annotations":{"title":"Unlink environment","destructiveHint":true}}));
                tools.push(json!({"name":"tool_search","description":"Search available T3 Code MCP tools by name or description.","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":500}},"required":["query"],"additionalProperties":false},"annotations":{"title":"Search tools","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}}));
                tools.push(json!({"name":"task_cancel","description":"Stop a delegated task and its local descendants. Native background work may require the user to stop it.","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","minLength":1},"reason":{"type":"string","maxLength":2000},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"required":["taskId"],"additionalProperties":false},"annotations":{"title":"Cancel delegated task","readOnlyHint":false,"destructiveHint":true}}));
                tools.push(json!({"name":"task_status","description":"Read one delegated task you started. Reading a terminal result acknowledges its delivery.","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","minLength":1}},"required":["taskId"],"additionalProperties":false},"annotations":{"title":"Get delegated task status","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true}}));
            }
            json!({"tools":tools})
        }
        "tools/call" => {
            let params = &value["params"];
            let name = params["name"].as_str().unwrap_or("");
            if ![
                "watch_pull_request",
                "unwatch_pull_request",
                "t3_thread_list",
                "t3_project_list",
                "t3_project_read",
                "t3_project_update",
                "t3_project_create",
                "t3_project_delete",
                "t3_project_clone",
                "t3_environment_read",
                "t3_environment_preferences_update",
                "t3_environment_links",
                "t3_environment_link",
                "t3_environment_unlink",
                "tool_search",
                "t3_thread_read",
                "t3_thread_search",
                "t3_pending_request",
                "t3_thread_configure",
                "t3_queue",
                "t3_thread_transfer",
                "t3_thread_organize",
                "t3_thread_update",
                "t3_thread_wait",
                "t3_thread_send",
                "t3_thread_interrupt",
                "t3_thread_launch",
                "create_threads",
                "t3_workflow_stop",
                "t3_background_wait",
                "task_status",
                "task_cancel",
                "orchestrator_capabilities",
                "delegate_task",
                "request_secret",
                "schedule_task",
                "run_scheduled_task_now",
                "list_scheduled_tasks",
                "delete_scheduled_task",
            ]
            .contains(&name)
                && !crate::mcp_issues::handles(name)
                && !crate::mcp_pull_requests::handles(name)
            {
                return error(StatusCode::OK, id, -32602, "Unknown tool");
            }
            let required_capability = if crate::mcp_issues::handles(name) {
                "issues"
            } else if crate::mcp_pull_requests::handles(name) {
                "pull-requests"
            } else {
                "orchestration"
            };
            if !scope.capabilities.contains(required_capability) {
                tool_failure(
                    "capability_denied",
                    &format!("This credential does not have the {required_capability} capability."),
                )
            } else {
                let mut args = params.get("arguments").unwrap_or(&json!({})).clone();
                let target = args.as_object_mut().and_then(|o| o.remove("environmentId"));
                enum TargetKind {
                    Local,
                    Remote(String),
                }
                let target_route = match target {
                    Some(Value::Null) | None => Ok(TargetKind::Local),
                    _ if name == "t3_environment_link" => Ok(TargetKind::Local),
                    Some(_) if matches!(name, "task_status" | "task_cancel") => Err(("invalid_request", "This action acts as the calling thread, which is here. Omit environmentId.".to_owned())),
                    Some(Value::String(ref id))
                        if !id.is_empty() && id.trim() == id && id == &state.environment_id =>
                    {
                        Ok(TargetKind::Local)
                    }
                    Some(Value::String(id)) if !id.is_empty() && id.trim() == id => {
                        if scope.client.is_some() {
                            Err((
                                "capability_denied",
                                "Only a local thread can forward calls to a linked environment.".to_owned(),
                            ))
                        } else {
                            Ok(TargetKind::Remote(id))
                        }
                    }
                    _ => Err(("invalid_request", "Invalid environmentId.".to_owned())),
                };
                let result = match target_route {
                    Err(error) => Err(error),
                    Ok(TargetKind::Remote(target_id)) => {
                        let settings = state.settings.clone();
                        crate::peer_mcp::forward(
                            &state.db,
                            &state.secrets_dir,
                            &scope,
                            &state.environment_id,
                            &target_id,
                            name,
                            args,
                            &move || settings.snapshot()["linkedEnvironmentsEnabled"] == true,
                        )
                        .await
                        .map_err(|f| (f.code, f.message))
                    }
                    Ok(TargetKind::Local) => {
                        if name == "request_secret" {
                    crate::mcp_secret::request(&state.bus, &scope, &args).await
                } else if name == "orchestrator_capabilities" {
                    capabilities(&state, &scope, &args).await
                } else if name == "delegate_task" {
                    delegate_task(&state, &scope, &args).await
                } else if name == "t3_thread_list" {
                    list_threads(&state, &scope, &args)
                } else if name == "t3_thread_read" {
                    read_thread(&state, &scope, &args)
                } else if name == "t3_thread_search" {
                    search_threads(&state, &scope, &args)
                } else if name == "t3_project_update" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    let settings = state.settings.snapshot();
                    tokio::task::spawn_blocking(move || {
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        crate::mcp_projects::update_with_settings(&bus,&scope,&args,Some(&settings),&now)
                    }).await.unwrap_or_else(|_| Err(("orchestration_error","Project worker failed.".into())))
                } else if name == "t3_project_create" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    let settings = state.settings.snapshot();
                    let projects_root = state.worktrees_dir.parent().unwrap_or(&state.worktrees_dir).join("projects");
                    tokio::task::spawn_blocking(move || {
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        crate::mcp_projects::create_with_settings(&bus, &scope, &args, &projects_root, Some(&settings), &now)
                    }).await.unwrap_or_else(|_| Err(("orchestration_error", "Project worker failed.".into())))
                } else if name == "t3_project_delete" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    let settings = state.settings.clone();
                    tokio::task::spawn_blocking(move || {
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        crate::mcp_projects::delete(&bus, &scope, &args, &settings, &now)
                    }).await.unwrap_or_else(|_| Err(("orchestration_error", "Project worker failed.".into())))
                } else if name == "t3_project_clone" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    let settings = state.settings.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::mcp_projects::clone_project(&bus, &scope, &args, &settings)
                    }).await.unwrap_or_else(|_| Err(("orchestration_error", "Project worker failed.".into())))
                } else if name == "t3_environment_read" {
                    let snap = state.settings.snapshot();
                    Ok(json!({
                        "environmentId": state.environment_id,
                        "label": "T3 Code",
                        "serverVersion": env!("CARGO_PKG_VERSION"),
                        "platform": std::env::consts::OS,
                        "preferences": {
                            "defaultThreadEnvMode": snap["defaultThreadEnvMode"],
                            "newWorktreesStartFromOrigin": snap["newWorktreesStartFromOrigin"],
                            "enableProviderUpdateChecks": snap["enableProviderUpdateChecks"],
                            "backgroundActivity": snap["backgroundActivity"],
                            "sourceControlWritingStyle": snap["sourceControlWritingStyle"],
                        }
                    }))
                } else if name == "t3_environment_preferences_update" {
                    let denied = std::cell::RefCell::new(None);
                    let auth_res = state.bus.commit(|tx| {
                        crate::mcp_projects::require_full_access_writer(tx, &scope, "change projects or environment settings", false)
                            .map_err(|e| { *denied.borrow_mut() = Some(e); rusqlite::Error::InvalidQuery })?;
                        Ok(((), vec![]))
                    });
                    if let Err(e) = auth_res {
                        Err(denied.into_inner().unwrap_or_else(|| ("orchestration_error", e.to_string())))
                    } else {
                        match state.settings.update_typed(&args) {
                            Ok(snap) => Ok(json!({
                                "defaultThreadEnvMode": snap["defaultThreadEnvMode"],
                                "newWorktreesStartFromOrigin": snap["newWorktreesStartFromOrigin"],
                                "enableProviderUpdateChecks": snap["enableProviderUpdateChecks"],
                                "backgroundActivity": snap["backgroundActivity"],
                                "sourceControlWritingStyle": snap["sourceControlWritingStyle"],
                            })),
                            Err(err) => Err(("invalid_request", format!("Could not update preferences: {err:?}"))),
                        }
                    }
                } else if name == "t3_environment_link" {
                    crate::peer_link_requests::request(
                        &state.bus,
                        &state.db,
                        &state.settings,
                        &scope,
                        &args,
                    )
                    .await
                } else if name == "t3_environment_links" {
                    match crate::peer_links::list(&state.db).await {
                        Ok(links) => Ok(json!({
                            "environmentId": state.environment_id,
                            "links": links,
                            "notListed": "Peer links are listed from this environment's pairing store."
                        })),
                        Err(_) => Err(("orchestration_error", "Could not list linked environments.".into())),
                    }
                } else if name == "t3_environment_unlink" {
                    let id = args.get("environmentId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
                    if let Some(id) = id {
                        let denied = std::cell::RefCell::new(None);
                        let auth_res = state.bus.commit(|tx| {
                            crate::mcp_projects::require_full_access_writer(tx, &scope, "change projects or environment settings", false)
                                .map_err(|e| { *denied.borrow_mut() = Some(e); rusqlite::Error::InvalidQuery })?;
                            Ok(((), vec![]))
                        });
                        if let Err(e) = auth_res {
                            Err(denied.into_inner().unwrap_or_else(|| ("orchestration_error", e.to_string())))
                        } else {
                            match crate::peer_links::unlink(&state.db, &state.secrets_dir, id).await {
                                Ok(removed) => Ok(json!({"environmentId": id, "removed": removed})),
                                Err(_) => Err(("orchestration_error", "Could not unlink environment.".into())),
                            }
                        }
                    } else {
                        Err(("invalid_request", "environmentId is required.".into()))
                    }
                } else if name == "tool_search" {
                    let query = args.get("query").and_then(Value::as_str).map(str::trim).unwrap_or("").to_lowercase();
                    let all_tools = {
                        let mut tools = Vec::new();
                        tools.push(thread_list_definition());
                        tools.extend(crate::mcp_projects::definitions());
                        tools.extend(crate::mcp_thread_read::definitions());
                        tools.extend(crate::mcp_thread_search::definitions());
                        tools.push(crate::mcp_pending_request::definition());
                        tools.push(crate::mcp_thread_configure::definition());
                        tools.push(crate::mcp_queue::definition());
                        tools.push(crate::mcp_secret::definition());
                        tools.push(crate::mcp_scheduled::list_definition());
                        tools.push(crate::mcp_scheduled::save_definition());
                        tools.push(crate::mcp_scheduled::run_definition());
                        tools.push(crate::mcp_scheduled::delete_definition());
                        tools.push(crate::mcp_thread_transfer::definition());
                        tools.push(crate::mcp_thread_organize::definition());
                        tools.push(crate::mcp_thread_update::definition());
                        tools.push(crate::mcp_thread_wait::definition());
                        tools.push(crate::mcp_thread_send::definition());
                        tools.push(crate::mcp_thread_interrupt::definition());
                        tools.push(crate::mcp_thread_launch::launch_definition());
                        tools.push(crate::mcp_thread_launch::create_threads_definition());
                        tools.push(crate::mcp_workflow::workflow_stop_definition());
                        tools.push(crate::mcp_workflow::background_wait_definition());
                        if !scope.subagent && scope.client.is_none() {
                            tools.extend(crate::pull_request_refresh::watch_tools());
                        }
                        if scope.capabilities.contains("pull-requests") {
                            let has_forge = crate::mcp_pull_requests::caller_has_forge(&state.db, &scope);
                            tools.extend(crate::mcp_pull_requests::definitions(has_forge));
                        }
                        tools.push(crate::peer_link_requests::definition());
                        tools.extend(crate::mcp_issues::definitions());
                        tools
                    };
                    let matched: Vec<Value> = all_tools.into_iter().filter(|t| {
                        let n = t["name"].as_str().unwrap_or("").to_lowercase();
                        let d = t["description"].as_str().unwrap_or("").to_lowercase();
                        query.is_empty() || n.contains(&query) || d.contains(&query)
                    }).map(|t| json!({"name": t["name"], "description": t["description"]})).collect();
                    Ok(json!({"tools": matched}))
                } else if name == "t3_thread_launch" {
                    crate::mcp_thread_launch::launch(
                        &state.bus,
                        &state.settings,
                        &scope,
                        &state.environment_id,
                        &args,
                    )
                    .await
                } else if name == "create_threads" {
                    crate::mcp_thread_launch::create_threads(
                        &state.bus,
                        &scope,
                        &state.environment_id,
                        &args,
                    )
                    .await
                } else if matches!(name, "watch_pull_request" | "unwatch_pull_request") {
                    require_active_caller(&state, &scope).and_then(|()| {
                        crate::pull_request_refresh::set_watch(&state.bus, &scope, &args, name == "watch_pull_request")
                    })
                } else if name == "t3_workflow_stop" {
                    crate::mcp_workflow::stop_workflow(&state.bus, Some(&scope), &args).await
                } else if name == "t3_background_wait" {
                    crate::mcp_workflow::await_background_tasks(&state.bus, &scope, &args)
                } else if name == "t3_pending_request" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_pending_request::call_with_settings(
                        &state.bus,
                        &scope,
                        &args,
                        &now,
                        Some(&state.settings),
                    )
                } else if name == "t3_thread_configure" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_thread_configure::call(
                        &state.bus,
                        &scope,
                        &args,
                        &now,
                        state.settings.path(),
                        &state.credentials,
                    )
                } else if name == "run_scheduled_task_now" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    let credentials = state.credentials.clone();
                    let environment = state.environment_id.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::mcp_scheduled::run_now(
                            &bus,
                            &scope,
                            &args,
                            credentials,
                            &environment,
                        )
                    })
                    .await
                    .unwrap_or_else(|_| {
                        Err((
                            "orchestration_error",
                            "Scheduled task worker failed.".into(),
                        ))
                    })
                } else if name == "schedule_task" {
                    let bus = state.bus.clone();
                    let scope = scope.clone();
                    let args = args.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::mcp_scheduled::save(&bus, &scope, &args, chrono::Utc::now())
                    })
                    .await
                    .unwrap_or_else(|_| {
                        Err((
                            "orchestration_error",
                            "Scheduled task worker failed.".into(),
                        ))
                    })
                } else if name == "delete_scheduled_task" {
                    crate::mcp_scheduled::delete(&state.bus, &scope, &args)
                } else if name == "list_scheduled_tasks" {
                    crate::mcp_scheduled::list(&state.bus, &scope, &args)
                } else if name == "t3_queue" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_queue::call(&state.bus, &scope, &args, &now)
                } else if name == "t3_thread_transfer" || name == "t3_thread_organize" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    if name == "t3_thread_transfer" {
                        crate::mcp_thread_transfer::call(&state.bus, &scope, &args, &now)
                    } else {
                        crate::mcp_thread_organize::call(&state.bus, &scope, &args, &now)
                    }
                } else if name == "t3_thread_update" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_thread_update::call(&state.bus, &scope, &args, &now)
                } else if name == "t3_thread_interrupt" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_thread_interrupt::call(
                        &state.bus,
                        &state.credentials,
                        &scope,
                        &args,
                        &now,
                    )
                } else if name == "t3_thread_send" {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_thread_send::call(
                        &state.bus,
                        &scope,
                        &args,
                        &state.settings,
                        &state.credentials,
                        &state.environment_id,
                        &now,
                    )
                } else if name == "t3_thread_wait" {
                    crate::mcp_thread_wait::call(&state.bus, &scope, &args).await
                } else if name == "task_cancel" {
                    match require_active_caller(&state, &scope) {
                        Err(error) => Err(error),
                        Ok(()) => match args.as_object() {
                            Some(obj)
                                if obj.keys().all(|key| {
                                    ["taskId", "reason", "clientRequestId"].contains(&key.as_str())
                                }) =>
                            {
                                let id = obj
                                    .get("taskId")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|v| !v.is_empty());
                                let reason = match obj.get("reason") {
                                    None | Some(Value::Null) => Some(None),
                                    Some(Value::String(v)) if v.encode_utf16().count() <= 2000 => {
                                        Some(Some(v.as_str()))
                                    }
                                    _ => None,
                                };
                                let key = match obj.get("clientRequestId") {
                                    None | Some(Value::Null) => Some(None),
                                    Some(Value::String(v))
                                        if !v.trim().is_empty()
                                            && v.trim().encode_utf16().count() <= 256 =>
                                    {
                                        Some(Some(v.trim()))
                                    }
                                    _ => None,
                                };
                                match (id, reason, key) {
                                    (Some(id), Some(reason), Some(key)) => {
                                        crate::mcp_task_cancel::call(
                                            &state.bus,
                                            &state.credentials,
                                            &scope,
                                            id,
                                            reason,
                                            key,
                                            &chrono::Utc::now().to_rfc3339_opts(
                                                chrono::SecondsFormat::Millis,
                                                true,
                                            ),
                                        )
                                    }
                                    _ => Err((
                                        "invalid_request",
                                        "Invalid cancellation arguments.".to_owned(),
                                    )),
                                }
                            }
                            _ => Err((
                                "invalid_request",
                                "Invalid cancellation arguments.".to_owned(),
                            )),
                        },
                    }
                } else if name == "task_status" {
                    require_active_caller(&state, &scope).and_then(|_| match args.as_object() {
                        Some(obj) if obj.len() == 1 => match obj
                            .get("taskId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            Some(id) => crate::mcp_task_status::call(
                                &state.db,
                                &state.bus,
                                &scope,
                                id,
                                &state.environment_id,
                            ),
                            None => Err(("invalid_request", "taskId is required.".to_owned())),
                        },
                        _ => Err((
                            "invalid_request",
                            "Invalid task status arguments.".to_owned(),
                        )),
                    })
                } else if crate::mcp_issues::handles(name) {
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    crate::mcp_issues::call(
                        &state.bus,
                        &state.db,
                        &state.secrets_dir,
                        &scope,
                        name,
                        &args,
                        &now,
                    )
                    .await
                } else if crate::mcp_pull_requests::handles(name) {
                    crate::mcp_pull_requests::call(
                        crate::mcp_pull_requests::PullRequestMcpContext {
                            db: &state.db,
                            bus: &state.bus,
                            settings: &state.settings,
                            auth: state.auth.as_ref(),
                            sessions: &state.credentials,
                            provider_cache: &state.provider_cache,
                            review_guide_runs: &state.review_guide_runs,
                            review_guide_worktrees: &state.review_guide_worktrees,
                        },
                        &scope,
                        name,
                        args,
                    )
                    .await
                } else {
                    let db = state.db.clone();
                    let name = name.to_owned();
                    let args = args.clone();
                    let settings = state.settings.snapshot();
                    tokio::task::spawn_blocking(move || {
                        let mut result = {
                            let db = db.lock().map_err(|_| {
                                (
                                    "orchestration_error",
                                    "The operation could not be completed.".to_owned(),
                                )
                            })?;
                            crate::mcp_projects::call_with_settings(&db, Some(&settings), &name, &args)
                                .map_err(|message| ("invalid_request", message))?
                        };
                        crate::mcp_projects::enrich_result(&mut result);
                        Ok(result)
                    })
                    .await
                    .unwrap_or_else(|_| {
                        Err((
                            "orchestration_error",
                            "The operation could not be completed.".to_owned(),
                        ))
                    })
                        }
                }
                };
                match result {
                    Ok(result) => {
                        json!({"content":[{"type":"text","text":result.to_string()}],"structuredContent":result})
                    }
                    Err((code, message)) => tool_failure(code, &message),
                }
            }
        }
        _ => {
            return error(
                if modern {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::OK
                },
                id,
                -32601,
                "Method not found",
            )
        }
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}

fn thread_list_definition() -> Value {
    json!({"name":"t3_thread_list","description":"List threads newest first, in one project or with `allProjects`. Page with `cursor`.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"projectId":{"type":"string"},"allProjects":{"type":"boolean"},"includeSubagents":{"type":"boolean"},"statuses":{"type":"array","maxItems":10,"items":{"type":"string","enum":["idle","preparing","queued","starting","running","waiting","completed","interrupted","failed","cancelled","rolled_back"]}},"settled":{"type":"boolean"},"snoozed":{"type":"boolean"},"titleContains":{"type":"string","minLength":1,"maxLength":256},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false},"annotations":{"title":"List T3 threads","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}})
}
fn tool_failure(code: &str, message: &str) -> Value {
    let failure = json!({"_tag":"OrchestratorMcpFailure","code":code,"message":message});
    json!({"content":[{"type":"text","text":failure.to_string()}],"structuredContent":failure,"isError":true})
}
fn list_threads(
    state: &McpState,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
) -> Result<Value, (&'static str, String)> {
    fn invalid(message: impl Into<String>) -> (&'static str, String) {
        ("invalid_request", message.into())
    }
    let object = args
        .as_object()
        .ok_or_else(|| invalid("Arguments must be an object."))?;
    let accepted = [
        "projectId",
        "allProjects",
        "includeSubagents",
        "statuses",
        "settled",
        "snoozed",
        "titleContains",
        "cursor",
        "limit",
    ];
    for key in object.keys() {
        if !accepted.contains(&key.as_str()) {
            return Err(invalid(format!("Unknown argument \"{key}\".")));
        }
    }
    let boolean = |key: &str| -> Result<Option<bool>, (&'static str, String)> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::Bool(v)) => Ok(Some(*v)),
            _ => Err(invalid(format!("Invalid {key}."))),
        }
    };
    let project = match object.get("projectId") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() && s.trim() == s => Some(s.clone()),
        _ => return Err(invalid("Invalid projectId.")),
    };
    let all = boolean("allProjects")?.unwrap_or(false);
    let include_subagents = boolean("includeSubagents")?.unwrap_or(true);
    let settled_filter = boolean("settled")?;
    let snoozed_filter = boolean("snoozed")?;
    let title_filter = match object.get("titleContains") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() && s.trim() == s && s.chars().count() <= 256 => {
            Some(s.to_lowercase())
        }
        _ => return Err(invalid("Invalid titleContains.")),
    };
    let statuses = match object.get("statuses") {
        None => None,
        Some(Value::Array(items))
            if items.len() <= 10
                && items.iter().all(|v| {
                    matches!(
                        v.as_str(),
                        Some(
                            "idle"
                                | "preparing"
                                | "queued"
                                | "starting"
                                | "running"
                                | "waiting"
                                | "completed"
                                | "interrupted"
                                | "failed"
                                | "cancelled"
                                | "rolled_back"
                        )
                    )
                }) =>
        {
            Some(items)
        }
        _ => return Err(invalid("Invalid statuses.")),
    };
    let cursor = match object.get("cursor") {
        None => 0,
        Some(v) => v.as_u64().ok_or_else(|| invalid("Invalid cursor."))?,
    };
    let limit = match object.get("limit") {
        None => 10,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=100).contains(n))
            .ok_or_else(|| invalid("Invalid limit."))?,
    };
    let db = state
        .db
        .lock()
        .map_err(|_| invalid("Database unavailable."))?;
    use rusqlite::OptionalExtension;
    let caller: Option<String> = db.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&scope.thread_id], |r| r.get(0)).optional().map_err(|_| invalid("Database unavailable."))?;
    if !all {
        if let Some(ref id) = project {
            let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL)", [id], |r| r.get(0)).map_err(|_| invalid("Database unavailable."))?;
            if !exists {
                return Err(invalid(format!("Project {id} was not found.")));
            }
        }
    }
    let project = if all {
        None
    } else {
        Some(project.or_else(|| caller.clone()).ok_or_else(|| ("target_required", "Pass projectId, or allProjects: true for every project. This MCP client is not running inside a T3 thread.".into()))?)
    };
    let mut stmt = db.prepare("SELECT t.payload_json FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND (?1 IS NULL OR t.project_id=?1) ORDER BY t.updated_at DESC,t.thread_id DESC").map_err(|_| invalid("Database unavailable."))?;
    let rows = stmt
        .query_map([&project], |r| r.get::<_, String>(0))
        .map_err(|_| invalid("Database unavailable."))?;
    let mut threads = Vec::new();
    let now = chrono::Utc::now().timestamp_millis();
    for row in rows {
        let raw = row.map_err(|_| invalid("Database unavailable."))?;
        let mut t: Value =
            serde_json::from_str(&raw).map_err(|_| invalid("Invalid thread projection."))?;
        if t["lineage"]["sideChat"] == true
            || (!include_subagents && t["lineage"]["relationshipToParent"] == "subagent")
        {
            continue;
        }
        crate::event_bus::enrich_shell(&db, &mut t)
            .map_err(|_| invalid("Database unavailable."))?;
        let background = t["pendingBackgroundTasks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let holds = background.iter().any(|task| {
            matches!(task["kind"].as_str(), Some("subagent" | "background_task"))
                || (matches!(task["kind"].as_str(), Some("command" | "monitor"))
                    && task["awaited"] == true)
        });
        let status = t["activityRunStatus"]
            .as_str()
            .or_else(|| {
                if holds {
                    Some("waiting")
                } else {
                    t["status"].as_str()
                }
            })
            .unwrap_or("idle");
        let settled = t["settledOverride"] == "settled";
        let millis = |v: &Value| {
            v.as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
        };
        let at = millis(&t["snoozedAt"]);
        let request = &t["pendingRuntimeRequest"];
        let request_wakes = !request.is_null()
            && (request["kind"] != "user_input"
                || at.is_none()
                || millis(&request["createdAt"])
                    .zip(at)
                    .is_some_and(|(a, b)| a > b));
        let error_wakes = t["status"] == "failed"
            && (at.is_none()
                || millis(&t["latestRunCompletedAt"])
                    .zip(at)
                    .is_some_and(|(a, b)| a > b));
        let snoozed = millis(&t["snoozedUntil"]).is_some_and(|until| until > now)
            && t["pendingGuestMessageCount"].as_u64().unwrap_or(0) == 0
            && !request_wakes
            && !error_wakes;
        if statuses.is_some_and(|v| !v.is_empty() && !v.iter().any(|v| v.as_str() == Some(status)))
            || settled_filter.is_some_and(|v| v != settled)
            || snoozed_filter.is_some_and(|v| v != snoozed)
            || title_filter
                .as_ref()
                .is_some_and(|v| !t["title"].as_str().unwrap_or("").to_lowercase().contains(v))
        {
            continue;
        }
        let tasks: Vec<Value> = background
            .iter()
            .map(|task| {
                let mut o = serde_json::Map::new();
                for key in ["taskId", "kind", "description", "awaited"] {
                    if let Some(v) = task.get(key) {
                        o.insert(key.into(), v.clone());
                    }
                }
                if task["kind"] == "subagent" {
                    if let Some(v) = task.get("childThreadId") {
                        o.insert("childThreadId".into(), v.clone());
                    }
                }
                Value::Object(o)
            })
            .collect();
        let link = thread_link(
            &state.environment_id,
            t["id"].as_str().unwrap_or(""),
            t["title"].as_str(),
        );
        threads.push(json!({"link":link,"threadId":t["id"],"projectId":t["projectId"],"title":t["title"],"createdBy":t["createdBy"],"creationSource":t["creationSource"],"status":status,"latestRunId":t["latestRunId"],"providerInstanceId":t["modelSelection"]["instanceId"],"model":t["modelSelection"]["model"],"runtimeMode":t["runtimeMode"],"interactionMode":t["interactionMode"],"linkedPullRequest":t["linkedPullRequest"],"settled":settled,"settledAt":if settled {t["settledAt"].clone()} else {Value::Null},"snoozed":snoozed,"snoozedUntil":if snoozed {t["snoozedUntil"].clone()} else {Value::Null},"blockedOnThreadWait":t["blockedOnThreadWait"] == true,"pendingBackgroundTasks":tasks,"parentThreadId":t["lineage"]["parentThreadId"],"relationshipToParent":t["lineage"]["relationshipToParent"],"itemCount":t["visibleItemCount"],"createdAt":t["createdAt"],"updatedAt":t["updatedAt"]}));
    }
    let total = threads.len();
    let start = usize::try_from(cursor).unwrap_or(usize::MAX).min(total);
    let end = start.saturating_add(limit as usize).min(total);
    Ok(
        json!({"projectId":project,"currentThreadId":if caller.is_some() {Some(&scope.thread_id)} else {None},"threads":&threads[start..end],"nextCursor":if end<total {Some(end)} else {None},"total":total}),
    )
}

pub(crate) fn thread_link(environment_id: &str, thread_id: &str, title: Option<&str>) -> String {
    let href = format!("t3-thread://v2/{environment_id}/{thread_id}");
    let cleaned = title
        .unwrap_or("")
        .chars()
        .map(|c| {
            if matches!(c, '[' | ']' | '\\' | '\r' | '\n') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let label = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let destination = if href.contains(['(', ')']) {
        format!("<{href}>")
    } else {
        href.clone()
    };
    if label.is_empty() {
        format!("<{href}>")
    } else {
        format!("[{label}]({destination})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use std::collections::HashSet;

    async fn send(
        state: Arc<McpState>,
        token: &str,
        session: Option<&str>,
        method: &str,
        body: Value,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri("/mcp")
            .header("authorization", format!("Bearer {token}"));
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        handle(
            State(state),
            request.body(Body::from(body.to_string())).unwrap(),
        )
        .await
    }
    async fn body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), MAX_BODY).await.unwrap()).unwrap()
    }
    #[tokio::test]
    async fn task_status_tool_reports_and_acknowledges_owned_task() {
        let path =
            std::env::temp_dir().join(format!("t3-mcp-task-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, payload) in [
            (
                "parent",
                json!({"id":"parent","projectId":"p","modelSelection":{"instanceId":"codex","model":"gpt"}}),
            ),
            (
                "child",
                json!({"id":"child","title":"Child","lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"},"forkedFrom":{"type":"node","nodeId":"task"}}),
            ),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','full-access','default','now','now',?2)",rusqlite::params![id,payload.to_string()]).unwrap();
        }
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('observer','parent',1,'codex','codex','running','now',?1)",[json!({"id":"observer","status":"running","rootNodeId":"root","providerInstanceId":"codex","providerThreadId":"pt"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('root','parent','observer','root','root_turn','running',?1)",[json!({"id":"root","runId":"observer","status":"running"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('child-run','child',1,'codex','completed','now',?1)",[json!({"id":"child-run","status":"completed","delegatedTaskId":"task"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('task','parent','n','codex','child','app_owned','completed','now',?1)",[json!({"id":"task","threadId":"parent","childThreadId":"child","origin":"app_owned","status":"completed","result":"done","completionDelivery":{"state":"pending"}}).to_string()]).unwrap();
        let registry = Arc::new(SessionRegistry::default());
        let issued = registry
            .mcp_credentials
            .issue(
                "parent",
                "codex",
                HashSet::from(["orchestration".into()]),
                false,
            )
            .unwrap();
        let state = Arc::new(McpState {
            credentials: registry,
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
            db: Arc::new(Mutex::new(db)),
            bus: crate::event_bus::EventBus::new(crate::database::open_writer(&path).unwrap(), 16),
        });
        let init=send(state.clone(),&issued.token,None,"POST",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":LEGACY}})).await;
        let session = h(init.headers(), "mcp-session-id").unwrap().to_owned();
        *state.provider_cache.lock().unwrap() = Some(vec![
            json!({"instanceId":"codex","driver":"codex","displayName":"Codex","installed":true,"status":"ready","models":[{"slug":"gpt","name":"GPT"}]}),
        ]);
        let catalog=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"orchestrator_capabilities","arguments":{}}})).await).await;
        assert_eq!(
            catalog["result"]["structuredContent"]["inheritedModel"],
            "gpt"
        );
        assert_eq!(
            catalog["result"]["structuredContent"]["providers"][0]["models"][0]["id"],
            "gpt"
        );
        state.db.lock().unwrap().execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='approval-required' WHERE thread_id='parent'",[]).unwrap();
        let denied=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"inspect","runtimeMode":"full-access"}}})).await).await;
        assert_eq!(
            denied["result"]["structuredContent"]["code"],
            "runtime_mode_escalation_denied"
        );
        state.db.lock().unwrap().execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='full-access' WHERE thread_id='parent'",[]).unwrap();
        let create = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"inspect","clientRequestId":"same"}}});
        let first = body(
            send(
                state.clone(),
                &issued.token,
                Some(&session),
                "POST",
                create.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(first["result"]["structuredContent"]["status"], "running");
        let second =
            body(send(state.clone(), &issued.token, Some(&session), "POST", create).await).await;
        assert_eq!(
            first["result"]["structuredContent"]["taskId"],
            second["result"]["structuredContent"]["taskId"]
        );
        let count:i64=state.db.lock().unwrap().query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE thread_id='parent'",[],|r|r.get(0)).unwrap();
        assert_eq!(count, 2);
        let waiting=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"inspect later","clientRequestId":"wait","mode":"wait","timeoutMs":1}}})).await).await;
        assert_eq!(waiting["result"]["structuredContent"]["waitTimedOut"], true);
        let wait_task = waiting["result"]["structuredContent"]["taskId"]
            .as_str()
            .unwrap();
        let wake:String=state.db.lock().unwrap().query_row("SELECT json_extract(payload_json,'$.completionWake') FROM orchestration_v2_projection_subagents WHERE subagent_id=?1",[wait_task],|r|r.get(0)).unwrap();
        assert_eq!(wake, "always");
        let cancelled=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"task_cancel","arguments":{"taskId":wait_task,"clientRequestId":"cancel"}}})).await).await;
        assert_eq!(
            cancelled["result"]["structuredContent"]["status"],
            "cancel_requested"
        );
        state.settings.update_with_provider_mutation(&json!({}),&json!({"operation":"create","instanceId":"work","instance":{"driver":"codex","config":{"homePath":"/tmp/work"}}})).unwrap();
        state.provider_cache.lock().unwrap().as_mut().unwrap().push(json!({"instanceId":"work","driver":"codex","installed":true,"status":"ready","models":[{"slug":"work-model"}]}));
        let alternate=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"delegate_task","arguments":{"task":"use work account","clientRequestId":"work","target":{"providerInstanceId":"work","model":"work-model"}}}})).await).await;
        assert_eq!(
            alternate["result"]["structuredContent"]["providerInstanceId"],
            "work"
        );
        assert_eq!(
            alternate["result"]["structuredContent"]["model"],
            "work-model"
        );
        let result=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_status","arguments":{"taskId":"task"}}})).await).await;
        assert_eq!(result["result"]["structuredContent"]["summary"], "done");
        assert_eq!(result["result"]["structuredContent"]["status"], "completed");
        let db = state.db.lock().unwrap();
        let payload:String=db.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='task'",[],|r|r.get(0)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap()["completionDelivery"]["state"],
            "acknowledged"
        );
        drop(db);
        drop(state);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn mcp_read_hydrates_pending_legacy_transcript() {
        let path =
            std::env::temp_dir().join(format!("t3-mcp-legacy-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[json!({"id":"t"}).to_string()]).unwrap();
        db.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES('old','t','user','legacy',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at) VALUES('t','2026','2026')",[]).unwrap();
        let state = McpState {
            credentials: Arc::new(SessionRegistry::default()),
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
            db: Arc::new(Mutex::new(db)),
            bus: crate::event_bus::EventBus::new(crate::database::open_writer(&path).unwrap(), 16),
        };
        let scope = crate::mcp_credentials::Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: Default::default(),
            subagent: false, client: None,
        };
        let result = read_thread(&state, &scope, &json!({"threadId":"t"})).unwrap();
        assert_eq!(result["items"][0]["text"], "legacy");
        let db = state.db.lock().unwrap();
        let imported:Option<String>=db.query_row("SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id='t'",[],|r|r.get(0)).unwrap();
        assert!(imported.is_some());
        drop(db);
        drop(state);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn reading_full_child_result_acknowledges_observing_run() {
        let path = std::env::temp_dir().join(format!("t3-mcp-ack-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, payload) in [
            ("parent", json!({"id":"parent"})),
            (
                "child",
                json!({"id":"child","lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"},"forkedFrom":{"type":"node","nodeId":"task"}}),
            ),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','full-access','default','now','now',?2)",rusqlite::params![id,payload.to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('observe','parent',1,'codex','codex','waiting','now',?1)",[json!({"id":"observe","status":"waiting"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('child-run','child',1,'codex','completed','now',?1)",[json!({"id":"child-run","ordinal":1,"status":"completed","delegatedTaskId":"task"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('task','parent','n','codex','child','app_owned','completed','now',?1)",[json!({"id":"task","threadId":"parent","childThreadId":"child","origin":"app_owned","status":"completed","completionDelivery":{"state":"pending"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('x','child','parent','subagent_result','completed','now',?1)",[json!({"type":"subagent_result","sourceThreadId":"child","targetThreadId":"parent","sourcePoint":{"runId":"child-run"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES('item','child','child-run',1,'assistant_message','completed','now',?1)",[json!({"id":"item","runId":"child-run","type":"assistant_message","text":"done"}).to_string()]).unwrap();
        let state = McpState {
            credentials: Arc::new(SessionRegistry::default()),
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
            db: Arc::new(Mutex::new(db)),
            bus: crate::event_bus::EventBus::new(crate::database::open_writer(&path).unwrap(), 16),
        };
        let scope = crate::mcp_credentials::Scope {
            thread_id: "parent".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: Default::default(),
            subagent: false, client: None,
        };
        let partial = read_thread(
            &state,
            &scope,
            &json!({"threadId":"child","itemId":"item","textOffset":1}),
        )
        .unwrap();
        assert_eq!(partial["items"][0]["text"], "one");
        {
            let db = state.db.lock().unwrap();
            let raw:String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='task'", [], |r|r.get(0)).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&raw).unwrap()["completionDelivery"]["state"],
                "pending"
            );
        }
        let page = read_thread(&state, &scope, &json!({"threadId":"child"})).unwrap();
        assert_eq!(page["items"][0]["text"], "done");
        let db = state.db.lock().unwrap();
        let raw:String=db.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='task'",[],|r|r.get(0)).unwrap();
        let task: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(task["completionDelivery"]["state"], "acknowledged");
        assert_eq!(task["completionDelivery"]["observedByRunId"], "observe");
        drop(db);
        drop(state);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn thread_listing_obeys_scope_project_and_pagination() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, project, updated) in [
            ("one", "p", "2025-01-01"),
            ("two", "p", "2025-01-02"),
            ("three", "q", "2025-01-03"),
        ] {
            let payload = json!({"id":id,"projectId":project,"title":id,"providerInstanceId":"codex","modelSelection":{"model":"m"},"runtimeMode":"auto","interactionMode":"default","createdAt":updated,"updatedAt":updated});
            db.execute("INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (?1,?2,?1,'codex','codex','auto','default',?3,?3,?4)", rusqlite::params![id,project,updated,payload.to_string()]).unwrap();
        }
        let state = McpState {
            credentials: Arc::new(SessionRegistry::default()),
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            bus: crate::event_bus::EventBus::new(
                rusqlite::Connection::open_in_memory().unwrap(),
                16,
            ),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
            db: Arc::new(Mutex::new(db)),
        };
        let scope = crate::mcp_credentials::Scope {
            thread_id: "one".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: Default::default(),
            subagent: false, client: None,
        };
        let first = list_threads(&state, &scope, &json!({"limit":1})).unwrap();
        assert_eq!(first["total"], 2);
        assert_eq!(first["threads"][0]["threadId"], "two");
        assert_eq!(
            first["threads"][0]["link"],
            "[two](t3-thread://v2/local/two)"
        );
        assert_eq!(first["nextCursor"], 1);
        let second = list_threads(&state, &scope, &json!({"limit":1,"cursor":1})).unwrap();
        assert_eq!(second["threads"][0]["threadId"], "one");
        assert!(list_threads(&state, &scope, &json!({"unexpected":true})).is_err());
        {
            let db = state.db.lock().unwrap();
            db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.relationshipToParent','subagent','$.settledOverride','settled','$.settledAt','2025-01-01T00:00:00Z','$.pendingBackgroundTasks',json('[{\"taskId\":\"x\",\"kind\":\"background_task\"}]'),'$.snoozedUntil','2999-01-01T00:00:00Z') WHERE thread_id='two'", []).unwrap();
        }
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r2','two',1,'codex','completed','2025',?1)",[json!({"id":"r2","status":"completed"}).to_string()]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt2','two','codex','ready','2025',?1)",[json!({"id":"pt2","providerInstanceId":"codex","pendingBackgroundTasks":[{"taskId":"x","kind":"background_task"}]}).to_string()]).unwrap();
        }
        let filtered = list_threads(
            &state,
            &scope,
            &json!({"statuses":["waiting"],"settled":true,"snoozed":true,"titleContains":"TW"}),
        )
        .unwrap();
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["threads"][0]["status"], "waiting");
        assert_eq!(
            list_threads(&state, &scope, &json!({"includeSubagents":false})).unwrap()["total"],
            1
        );
        assert_eq!(
            list_threads(&state, &scope, &json!({"statuses":[],"settled":false})).unwrap()["total"],
            1
        );
        assert_eq!(
            list_threads(&state, &scope, &json!({"snoozed":false})).unwrap()["total"],
            1
        );
        assert!(list_threads(&state, &scope, &json!({"statuses":["bogus"]})).is_err());
        assert_eq!(
            list_threads(&state, &scope, &json!({"projectId":"missing"}))
                .unwrap_err()
                .0,
            "invalid_request"
        );
    }
    #[tokio::test]
    async fn scheduled_tools_create_list_and_delete_over_transport() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let payload = json!({"id":"t","projectId":"p","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"auto","interactionMode":"default"});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','codex','auto','default','now','now',?1)",[payload.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','codex','running','now','{}')",[]).unwrap();
        let registry = Arc::new(SessionRegistry::default());
        let issued = registry
            .mcp_credentials
            .issue("t", "codex", HashSet::from(["orchestration".into()]), false)
            .unwrap();
        let state = Arc::new(McpState {
            credentials: registry,
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir(),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("mcp-settings-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            bus: crate::event_bus::EventBus::new(db, 16),
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
        });
        let init=send(state.clone(),&issued.token,None,"POST",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":LEGACY}})).await;
        let session = h(init.headers(), "mcp-session-id").unwrap().to_owned();
        let created=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"schedule_task","arguments":{"prompt":"Review changes","schedule":{"type":"interval","everyMs":60000},"clientRequestId":"key"}}})).await).await;
        let id = created["result"]["structuredContent"]["scheduledTaskId"]
            .as_str()
            .expect("task id");
        let listed=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_scheduled_tasks","arguments":{}}})).await).await;
        assert_eq!(
            listed["result"]["structuredContent"]["tasks"][0]["scheduledTaskId"],
            id
        );
        let run = json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"run_scheduled_task_now","arguments":{"taskId":id}}});
        let denied = body(
            send(
                state.clone(),
                &issued.token,
                Some(&session),
                "POST",
                run.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(
            denied["result"]["structuredContent"]["code"],
            "capability_denied"
        );
        state.bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='full-access',payload_json=json_set(payload_json,'$.runtimeMode','full-access') WHERE thread_id='t'",[])?; Ok(((),vec![])) }).unwrap();
        let started =
            body(send(state.clone(), &issued.token, Some(&session), "POST", run).await).await;
        assert_eq!(
            started["result"]["structuredContent"]["threadId"], "t",
            "{started}"
        );
        assert_eq!(
            started["result"]["structuredContent"]["lastRunStatus"],
            "succeeded"
        );
        let deleted=body(send(state,&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_scheduled_task","arguments":{"scheduledTaskId":id}}})).await).await;
        assert_eq!(deleted["result"]["structuredContent"]["deleted"], true);
    }
    #[tokio::test]
    async fn project_tools_are_scoped_and_callable_over_mcp() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Project','/tmp','[]','2026','2026')",[]).unwrap();
        let registry = Arc::new(SessionRegistry::default());
        let issued = registry
            .mcp_credentials
            .issue(
                "thread",
                "codex",
                HashSet::from(["orchestration".into()]),
                false,
            )
            .unwrap();
        let state = Arc::new(McpState {
            credentials: registry,
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            bus: crate::event_bus::EventBus::new(
                rusqlite::Connection::open_in_memory().unwrap(),
                16,
            ),
            db: Arc::new(Mutex::new(db)),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
        });
        let init=send(state.clone(),&issued.token,None,"POST",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":LEGACY}})).await;
        let session = h(init.headers(), "mcp-session-id").unwrap().to_owned();
        let list = body(
            send(
                state.clone(),
                &issued.token,
                Some(&session),
                "POST",
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            )
            .await,
        )
        .await;
        assert!(list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "t3_project_read"));
        for name in [
            "t3_thread_update",
            "schedule_task",
            "list_scheduled_tasks",
            "delete_scheduled_task",
        ] {
            assert!(list["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name));
            let response = body(send(state.clone(), &issued.token, Some(&session), "POST", json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":name,"arguments":[]}})).await).await;
            assert_eq!(
                response["result"]["structuredContent"]["code"], "invalid_request",
                "{name}: {response}"
            );
        }
        let result=body(send(state.clone(),&issued.token,Some(&session),"POST",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"t3_project_read","arguments":{"projectId":"p"}}})).await).await;
        assert_eq!(result["result"]["structuredContent"]["id"], "p");
        for (environment, is_error) in [("local", false), ("remote", true)] {
            let response = body(send(state.clone(), &issued.token, Some(&session), "POST", json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"t3_project_read","arguments":{"projectId":"p","environmentId":environment}}})).await).await;
            assert_eq!(response["result"]["isError"] == true, is_error);
            if is_error {
                assert_eq!(
                    response["result"]["structuredContent"]["code"],
                    "capability_denied"
                );
            }
        }
    }
    #[tokio::test]
    async fn authenticates_and_isolates_session_lifecycle() {
        let registry = Arc::new(SessionRegistry::default());
        let first = registry
            .mcp_credentials
            .issue("a", "provider", HashSet::new(), false)
            .unwrap();
        let second = registry
            .mcp_credentials
            .issue("b", "provider", HashSet::new(), false)
            .unwrap();
        let state = Arc::new(McpState {
            credentials: registry.clone(),
            environment_id: "local".into(),
            worktrees_dir: std::env::temp_dir().join("t3-mcp-test-worktrees"),
            settings: Arc::new(crate::settings::Settings::new(
                std::env::temp_dir().join(format!("t3-mcp-test-{}.json", uuid::Uuid::new_v4())),
            )),
            provider_cache: Arc::new(Mutex::new(None)),
            bus: crate::event_bus::EventBus::new(
                rusqlite::Connection::open_in_memory().unwrap(),
                16,
            ),
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            signing_key: [0; 32],
            oauth_enabled: false,
            secrets_dir: std::env::temp_dir(),
            auth: None,
            review_guide_runs: Default::default(),
            review_guide_worktrees: std::env::temp_dir(),
            sessions: Mutex::new(HashMap::new()),
        });
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}});
        assert_eq!(
            send(state.clone(), "wrong", None, "POST", init.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = send(state.clone(), &first.token, None, "POST", init).await;
        assert_eq!(response.status(), StatusCode::OK);
        let session = h(response.headers(), "mcp-session-id").unwrap().to_owned();
        assert_eq!(body(response).await["result"]["protocolVersion"], LEGACY);
        let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        assert_eq!(
            send(
                state.clone(),
                &second.token,
                Some(&session),
                "POST",
                list.clone()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            body(
                send(
                    state.clone(),
                    &first.token,
                    Some(&session),
                    "POST",
                    list.clone()
                )
                .await
            )
            .await["result"]["tools"],
            json!([])
        );
        assert_eq!(
            send(
                state.clone(),
                &first.token,
                Some(&session),
                "DELETE",
                json!({})
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            send(
                state.clone(),
                &first.token,
                Some(&session),
                "POST",
                list.clone()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        registry.mcp_credentials.revoke_thread("a");
        assert_eq!(
            send(state, &first.token, None, "POST", list).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn oauth_client_auth_mode_limit_and_project_update_over_http() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let path = std::env::temp_dir().join(format!("t3-mcp-oauth-test-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Old','/tmp','[]','now','now')",[]).unwrap();
        let db_arc = Arc::new(Mutex::new(db));
        let bus = crate::event_bus::EventBus::new(crate::database::open_writer(&path).unwrap(), 16);
        let signing_key = [9; 32];
        let now = chrono::Utc::now().timestamp_millis();
        let full_token = crate::mcp_oauth::issue_session(
            &db_arc,
            &signing_key,
            crate::mcp_oauth::GrantedCode {
                access: "full-access".into(),
                peer_link: false,
                label: "Test OAuth Client".into(),
            },
            now,
        )
        .unwrap()["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let linked_token = crate::mcp_oauth::issue_session(
            &db_arc,
            &signing_key,
            crate::mcp_oauth::GrantedCode {
                access: "auto".into(),
                peer_link: true,
                label: "Linked Peer".into(),
            },
            now,
        )
        .unwrap()["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let settings = Arc::new(crate::settings::Settings::new(
            std::env::temp_dir().join(format!("t3-mcp-oauth-settings-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = router(
            Arc::new(SessionRegistry::default()),
            db_arc,
            "local".into(),
            bus,
            settings,
            Arc::new(Mutex::new(None)),
            std::env::temp_dir(),
            signing_key,
            true,
            std::env::temp_dir(),
        );

        let unauth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("host", "localhost:3773")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            unauth.headers().get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap(),
            "Bearer resource_metadata=\"http://localhost:3773/.well-known/oauth-protected-resource/mcp\""
        );

        let bad_limit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("host", "localhost:3773")
                    .header("authorization", format!("Bearer {full_token}"))
                    .header("t3-mode-limit", "bogus")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_limit.status(), StatusCode::BAD_REQUEST);

        let linked_off = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("host", "localhost:3773")
                    .header("authorization", format!("Bearer {linked_token}"))
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(linked_off.status(), StatusCode::FORBIDDEN);

        let init = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("host", "localhost:3773")
                    .header("authorization", format!("Bearer {full_token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(init.status(), StatusCode::OK);
        let sid = init.headers().get("mcp-session-id").unwrap().to_str().unwrap().to_owned();

        let narrowed = body(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/mcp")
                        .header("host", "localhost:3773")
                        .header("authorization", format!("Bearer {full_token}"))
                        .header("mcp-session-id", &sid)
                        .header("t3-mode-limit", "auto/default")
                        .header("content-type", "application/json")
                        .body(Body::from(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"t3_project_update","arguments":{"projectId":"p","title":"Blocked"}}}).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(narrowed["result"]["isError"], true);
        assert_eq!(narrowed["result"]["structuredContent"]["code"], "capability_denied");

        let allowed = body(
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("host", "localhost:3773")
                    .header("authorization", format!("Bearer {full_token}"))
                    .header("mcp-session-id", &sid)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"t3_project_update","arguments":{"projectId":"p","title":"Updated"}}}).to_string()))
                    .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_ne!(allowed["result"]["isError"], true);
        assert_eq!(allowed["result"]["structuredContent"]["title"], "Updated");
    }
}
