//! Streamable MCP client for calls to verified linked environments.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex, time::Duration};

const VERSION: &str = "2025-06-18";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
type SessionKey = (String, String, [u8; 32]);

pub(crate) struct Caller {
    pub runtime: String,
    pub interaction: String,
    pub sender: String,
}

#[derive(Debug)]
pub(crate) struct Failure {
    pub code: &'static str,
    pub message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

fn safe_remote_message(message: &str, token: &str) -> String {
    message
        .replace(token, "[redacted]")
        .chars()
        .take(4096)
        .collect()
}

fn remote_code(value: &Value) -> &'static str {
    match value.as_str() {
        Some("capability_denied") => "capability_denied",
        Some("parent_not_active") => "parent_not_active",
        Some("provider_unavailable") => "provider_unavailable",
        Some("model_unavailable") => "model_unavailable",
        Some("runtime_mode_escalation_denied") => "runtime_mode_escalation_denied",
        Some("interaction_mode_escalation_denied") => "interaction_mode_escalation_denied",
        Some("task_not_found") => "task_not_found",
        Some("task_not_cancellable") => "task_not_cancellable",
        Some("thread_not_found") => "thread_not_found",
        Some("run_not_found") => "run_not_found",
        Some("thread_not_sendable") => "thread_not_sendable",
        Some("thread_not_interruptible") => "thread_not_interruptible",
        Some("invalid_request") => "invalid_request",
        Some("thread_credential_required") => "thread_credential_required",
        Some("target_required") => "target_required",
        _ => "orchestration_error",
    }
}

fn is_write(tool: &str, args: &Value) -> bool {
    match tool {
        "t3_thread_list"
        | "t3_thread_read"
        | "t3_thread_search"
        | "t3_thread_wait"
        | "t3_project_list"
        | "t3_project_read"
        | "orchestrator_capabilities"
        | "list_scheduled_tasks" => false,
        "t3_thread_configure" => args.get("modelSelection").is_some_and(|v| !v.is_null()),
        "t3_queue" => !matches!(args["action"].as_str(), Some("list" | "read")),
        "t3_pending_request" => args["action"] == "respond",
        "t3_thread_transfer" => args["action"] != "status",
        _ => true,
    }
}

fn require_live_writer(
    db: &Mutex<rusqlite::Connection>,
    scope: &crate::mcp_credentials::Scope,
) -> Result<(), Failure> {
    use rusqlite::OptionalExtension;
    let db = db.lock().map_err(|_| {
        fail(
            "orchestration_error",
            "The operation could not be completed.",
        )
    })?;
    let row: Option<(Option<String>, Option<String>, String)> = db.query_row(
        "SELECT archived_at,provider_instance_id,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&scope.thread_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional().map_err(|_| fail("orchestration_error", "The operation could not be completed."))?;
    let (archived, owner, raw) = row.ok_or_else(|| {
        fail(
            "parent_not_active",
            "The calling provider no longer owns an active thread run.",
        )
    })?;
    let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND provider_instance_id=?2)", rusqlite::params![scope.thread_id,scope.provider_instance_id], |row| row.get(0)).map_err(|_| fail("orchestration_error", "The operation could not be completed."))?;
    let payload: Value = serde_json::from_str(&raw).map_err(|_| {
        fail(
            "orchestration_error",
            "The operation could not be completed.",
        )
    })?;
    let background = payload["pendingBackgroundTasks"]
        .as_array()
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["kind"] == "subagent"
                    && task["providerInstanceId"] == scope.provider_instance_id
            })
        });
    if archived.is_some()
        || owner.as_deref() != Some(scope.provider_instance_id.as_str())
        || !(active || background)
    {
        return Err(fail(
            "parent_not_active",
            "The calling provider no longer owns an active thread run.",
        ));
    }
    Ok(())
}

/// Derive mode limits from the caller's live projection rather than from
/// tool arguments. Fenced work must not use another environment's link.
pub(crate) fn caller(
    db: &std::sync::Mutex<rusqlite::Connection>,
    scope: &crate::mcp_credentials::Scope,
    environment_id: &str,
) -> Result<Caller, Failure> {
    use rusqlite::OptionalExtension;
    if !scope.capabilities.contains("orchestration") {
        return Err(fail(
            "capability_denied",
            "This credential cannot control threads.",
        ));
    }
    let db = db.lock().map_err(|_| {
        fail(
            "orchestration_error",
            "The operation could not be completed.",
        )
    })?;
    let row: Option<(String,String,String,String)> = db.query_row(
        "SELECT runtime_mode,interaction_mode,title,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
        [&scope.thread_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(|_| fail("orchestration_error", "The operation could not be completed."))?;
    let (runtime, interaction, title, raw) =
        row.ok_or_else(|| fail("thread_not_found", "The calling thread was not found."))?;
    let payload: Value = serde_json::from_str(&raw).map_err(|_| {
        fail(
            "orchestration_error",
            "The operation could not be completed.",
        )
    })?;
    let origin = &payload["linkOrigin"];
    if origin.is_object() && origin["access"] != "full-access" {
        let label = origin["label"].as_str().unwrap_or("a linked environment");
        return Err(fail("capability_denied", format!("This work was started from {label} through a linked environment, so it cannot use this environment's links. A link paired with full access is not limited this way.")));
    }
    if !matches!(
        runtime.as_str(),
        "approval-required" | "auto-accept-edits" | "auto" | "full-access"
    ) || !matches!(interaction.as_str(), "plan" | "default")
    {
        return Err(fail(
            "capability_denied",
            "The caller's mode could not be verified.",
        ));
    }
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    let title: String = title.chars().take(200).collect();
    Ok(Caller {
        runtime,
        interaction,
        sender: format!(
            "{}/{}/{}",
            encode(environment_id),
            encode(&scope.thread_id),
            encode(&title)
        ),
    })
}

/// Prepare and forward a call only after enforcing local caller limits and
/// resolving a peer by identity. Attachments remain local to their uploader.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn forward(
    db: &Mutex<rusqlite::Connection>,
    secret_dir: &std::path::Path,
    scope: &crate::mcp_credentials::Scope,
    local_environment: &str,
    target: &str,
    tool: &str,
    mut args: Value,
    enabled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Value, Failure> {
    if !enabled() {
        return Err(fail("capability_denied", "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs."));
    }
    let initial_caller = caller(db, scope, local_environment)?;
    let write = is_write(tool, &args);
    if write {
        require_live_writer(db, scope)?;
    }
    let object = args
        .as_object_mut()
        .ok_or_else(|| fail("invalid_request", "Invalid arguments."))?;
    object.remove("environmentId");
    if object
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        return Err(fail(
            "invalid_request",
            "A launch in a linked environment cannot carry attachments yet.",
        ));
    }
    if let Some(key) = object.get("clientRequestId").and_then(Value::as_str) {
        let digest = Sha256::digest(format!("{}\n{key}", scope.provider_session_id).as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        object.insert("clientRequestId".into(), json!(format!("fwd:{hex}")));
    }
    let peer = crate::peer_links::resolve(db, secret_dir, target).await.map_err(|error| match error {
        crate::peer_links::PeerError::UnknownPeer => fail("invalid_request", format!("This environment is not linked to {target}. t3_environment_links lists the linked ones.")),
        crate::peer_links::PeerError::Rejected | crate::peer_links::PeerError::Incompatible => fail("capability_denied", "This link is expired or incompatible. Link the environment again."),
        _ => fail("orchestration_error", "The linked environment could not be reached."),
    })?;
    static CLIENT: std::sync::OnceLock<PeerMcpClient> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(PeerMcpClient::default);
    let recheck = || -> Result<(), Failure> {
        if !enabled() {
            return Err(fail("capability_denied", "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs."));
        }
        let current = caller(db, scope, local_environment)?;
        if current.runtime != initial_caller.runtime
            || current.interaction != initial_caller.interaction
        {
            return Err(fail(
                "capability_denied",
                "The caller's permission mode changed while connecting. Retry the request.",
            ));
        }
        if write {
            require_live_writer(db, scope)?;
        }
        crate::peer_links::recheck(db, secret_dir, target, &peer).map_err(|_| {
            fail(
                "capability_denied",
                "The link changed or expired while connecting. Retry the request.",
            )
        })?;
        Ok(())
    };
    if tool != "t3_thread_wait" {
        recheck()?;
        return client
            .call(
                db,
                target,
                &peer,
                tool,
                &args,
                &initial_caller.runtime,
                &initial_caller.interaction,
                Some(&initial_caller.sender),
                &recheck,
            )
            .await;
    }
    let mut remaining = match args.get("timeoutMs") {
        None | Some(Value::Null) => 600_000,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| fail("invalid_request", "Invalid wait timeout."))?
            .clamp(1, 3_600_000),
    };
    loop {
        recheck()?;
        let chunk = remaining.min(50_000);
        args["timeoutMs"] = json!(chunk);
        let result = client
            .call(
                db,
                target,
                &peer,
                tool,
                &args,
                &initial_caller.runtime,
                &initial_caller.interaction,
                Some(&initial_caller.sender),
                &recheck,
            )
            .await?;
        remaining -= chunk;
        if result["timedOut"] != true || remaining == 0 {
            return Ok(result);
        }
        if let Some(run) = result.get("runId").filter(|run| !run.is_null()) {
            args["runId"] = run.clone();
        }
    }
}

#[derive(Default)]
pub(crate) struct PeerMcpClient {
    // Include a credential hash so relinking never reuses the old session.
    sessions: Mutex<HashMap<SessionKey, String>>,
}

async fn response_body(mut response: reqwest::Response) -> Result<Value, Failure> {
    let event_stream = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        fail(
            "orchestration_error",
            "The linked environment stopped answering.",
        )
    })? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(fail(
                "orchestration_error",
                "The linked environment answered in an unexpected shape.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        fail(
            "orchestration_error",
            "The linked environment answered in an unexpected shape.",
        )
    })?;
    let text = if event_stream {
        text.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<String>()
    } else {
        text.to_owned()
    };
    serde_json::from_str(&text).map_err(|_| {
        fail(
            "orchestration_error",
            "The linked environment answered in an unexpected shape.",
        )
    })
}

impl PeerMcpClient {
    fn remember(&self, key: SessionKey, session: String) -> Result<(), Failure> {
        let mut sessions = self.sessions.lock().map_err(|_| {
            fail(
                "orchestration_error",
                "The linked environment stopped answering.",
            )
        })?;
        if sessions.len() >= 1024 && !sessions.contains_key(&key) {
            sessions.clear();
        }
        sessions.insert(key, session);
        Ok(())
    }

    async fn post(
        client: &reqwest::Client,
        peer: &crate::peer_links::ResolvedPeer,
        body: &Value,
        mode: &str,
        session: Option<&str>,
        sender: Option<&str>,
    ) -> Result<reqwest::Response, Failure> {
        let mut request = client
            .post(format!("{}/mcp", peer.origin))
            .bearer_auth(&peer.token)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("t3-mode-limit", mode)
            .body(body.to_string());
        if let Some(session) = session {
            request = request
                .header("mcp-session-id", session)
                .header("mcp-protocol-version", VERSION);
        }
        if let Some(sender) = sender {
            request = request.header("t3-sender-thread", sender);
        }
        request.send().await.map_err(|_| {
            fail(
                "orchestration_error",
                "The linked environment stopped answering.",
            )
        })
    }

    async fn open(
        db: &Mutex<rusqlite::Connection>,
        id: &str,
        client: &reqwest::Client,
        peer: &crate::peer_links::ResolvedPeer,
        mode: &str,
        recheck: &(dyn Fn() -> Result<(), Failure> + Send + Sync),
    ) -> Result<String, Failure> {
        let handshake = async {
            recheck()?;
            let response = Self::post(client, peer, &json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":VERSION,"capabilities":{},"clientInfo":{"name":"t3code-peer","version":"1"}}}), mode, None, None).await?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(fail("capability_denied", "The linked environment no longer accepts this link. It may have been revoked there; link it again."));
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(fail("orchestration_error", "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs."));
            }
            if status != reqwest::StatusCode::OK {
                return Err(fail(
                    "orchestration_error",
                    format!(
                        "The linked environment refused to start an MCP session (HTTP {}).",
                        status.as_u16()
                    ),
                ));
            }
            if let Some(expires_at) = response
                .headers()
                .get("t3-link-expires-at")
                .and_then(|v| v.to_str().ok())
            {
                crate::peer_links::record_expiry(db, id, expires_at);
            }
            let session = response
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty() && s.len() <= 1024)
                .ok_or_else(|| {
                    fail(
                        "orchestration_error",
                        "The linked environment refused to start an MCP session.",
                    )
                })?
                .to_owned();
            let _ = response_body(response).await?;
            recheck()?;
            let _ = Self::post(
                client,
                peer,
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                mode,
                Some(&session),
                None,
            )
            .await?;
            Ok(session)
        };
        tokio::time::timeout(Duration::from_secs(10), handshake)
            .await
            .map_err(|_| {
                fail(
                    "orchestration_error",
                    "The linked environment stopped answering.",
                )
            })?
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call(
        &self,
        db: &Mutex<rusqlite::Connection>,
        id: &str,
        peer: &crate::peer_links::ResolvedPeer,
        tool: &str,
        args: &Value,
        runtime: &str,
        interaction: &str,
        sender: Option<&str>,
        recheck: &(dyn Fn() -> Result<(), Failure> + Send + Sync),
    ) -> Result<Value, Failure> {
        if !matches!(
            runtime,
            "approval-required" | "auto-accept-edits" | "auto" | "full-access"
        ) || !matches!(interaction, "plan" | "default")
        {
            return Err(fail(
                "capability_denied",
                "The caller's mode could not be verified.",
            ));
        }
        if crate::peer_links::peer_origin(&peer.origin).ok().as_deref() != Some(&peer.origin) {
            return Err(fail(
                "orchestration_error",
                "The linked environment address is invalid.",
            ));
        }
        let client =
            crate::peer_links::pinned_client(&peer.origin, peer.address, None).map_err(|_| {
                fail(
                    "orchestration_error",
                    "The linked environment stopped answering.",
                )
            })?;
        let mode = format!("{runtime}/{interaction}");
        let key = (
            id.to_owned(),
            peer.origin.clone(),
            Sha256::digest(peer.token.as_bytes()).into(),
        );
        let existing = self
            .sessions
            .lock()
            .map_err(|_| {
                fail(
                    "orchestration_error",
                    "The linked environment stopped answering.",
                )
            })?
            .get(&key)
            .cloned();
        recheck()?;
        let session = match existing {
            Some(id) => id,
            None => {
                let session = Self::open(db, id, &client, peer, &mode, recheck).await?;
                self.remember(key.clone(), session.clone())?;
                session
            }
        };
        let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
        recheck()?;
        let mut response = Self::post(&client, peer, &body, &mode, Some(&session), sender).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            recheck()?;
            let renewed = Self::open(db, id, &client, peer, &mode, recheck).await?;
            self.remember(key, renewed.clone())?;
            recheck()?;
            response = Self::post(&client, peer, &body, &mode, Some(&renewed), sender).await?;
        }
        match response.status().as_u16() {
            200 => {},
            401 => return Err(fail("capability_denied", "The linked environment no longer accepts this link. It may have been revoked there; link it again.")),
            403 => return Err(fail("orchestration_error", "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.")),
            status => return Err(fail("orchestration_error", format!("The linked environment answered HTTP {status}."))),
        }
        if let Some(expires_at) = response
            .headers()
            .get("t3-link-expires-at")
            .and_then(|v| v.to_str().ok())
        {
            crate::peer_links::record_expiry(db, id, expires_at);
        }
        let body = response_body(response).await?;
        if let Some(message) = body["error"]["message"].as_str() {
            return Err(fail(
                "invalid_request",
                safe_remote_message(message, &peer.token),
            ));
        }
        let result = body.get("result").ok_or_else(|| {
            fail(
                "invalid_request",
                "The linked environment returned no result.",
            )
        })?;
        let content = result["content"].as_array().ok_or_else(|| {
            fail(
                "orchestration_error",
                "The linked environment answered in an unexpected shape.",
            )
        })?;
        let text = content
            .iter()
            .filter_map(|v| v["text"].as_str())
            .collect::<String>();
        if result["isError"] == true {
            let failure: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            return Err(fail(
                remote_code(&failure["code"]),
                safe_remote_message(failure["message"].as_str().unwrap_or(&text), &peer.token),
            ));
        }
        serde_json::from_str(&text).map_err(|_| fail("orchestration_error", "The linked environment's answer did not match this version. Update both environments."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn carries_caller_limits_and_renews_expired_session() {
        let opens = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route("/mcp", post(|State(opens): State<Arc<AtomicUsize>>, headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers["authorization"], "Bearer fixture-token");
            assert_eq!(headers["t3-mode-limit"], "approval-required/plan");
            match body["method"].as_str().unwrap() {
                "initialize" => {
                    let n = opens.fetch_add(1, Ordering::SeqCst) + 1;
                    (StatusCode::OK, [("mcp-session-id", format!("session-{n}"))], Json(json!({"jsonrpc":"2.0","id":0,"result":{}})))
                }
                "notifications/initialized" => (StatusCode::ACCEPTED, [("mcp-session-id", "".into())], Json(json!({}))),
                "tools/call" if headers["mcp-session-id"] == "session-1" => (StatusCode::NOT_FOUND, [("mcp-session-id", "".into())], Json(json!({}))),
                "tools/call" => {
                    assert_eq!(headers["mcp-session-id"], "session-2");
                    assert_eq!(headers["t3-sender-thread"], "env/thread/title");
                    assert_eq!(body["params"]["name"], "t3_thread_read");
                    (StatusCode::OK, [("mcp-session-id", "".into())], Json(json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"ok\":true}"}]}})))
                }
                _ => panic!("unexpected method"),
            }
        })).with_state(opens.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let peer = crate::peer_links::ResolvedPeer {
            origin,
            token: "fixture-token".into(),
            address,
        };
        let test_db = Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        let client = PeerMcpClient::default();
        let response = client
            .call(
                &test_db,
                "peer",
                &peer,
                "t3_thread_read",
                &json!({"threadId":"t"}),
                "approval-required",
                "plan",
                Some("env/thread/title"),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(response, json!({"ok":true}));
        assert_eq!(opens.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn authorization_is_rechecked_after_session_renewal() {
        use std::sync::atomic::AtomicBool;
        let opens = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let allowed = Arc::new(AtomicBool::new(true));
        let shared = (opens.clone(), calls.clone(), allowed.clone());
        let app = Router::new().route("/mcp", post(|State((opens,calls,allowed)): State<(Arc<AtomicUsize>,Arc<AtomicUsize>,Arc<AtomicBool>)>, Json(body): Json<Value>| async move {
            match body["method"].as_str().unwrap() {
                "initialize" => {
                    let n=opens.fetch_add(1,Ordering::SeqCst)+1;
                    if n==2 { allowed.store(false,Ordering::SeqCst); }
                    (StatusCode::OK, [("mcp-session-id", format!("renewal-{n}"))], Json(json!({"jsonrpc":"2.0","id":0,"result":{}})))
                },
                "notifications/initialized" => (StatusCode::ACCEPTED, [("mcp-session-id", "".into())], Json(json!({}))),
                "tools/call" => {
                    let n=calls.fetch_add(1,Ordering::SeqCst);
                    if n==0 { (StatusCode::OK, [("mcp-session-id", "".into())], Json(json!({"result":{"content":[{"text":"{\"ok\":true}"}]}}))) }
                    else { (StatusCode::NOT_FOUND, [("mcp-session-id", "".into())], Json(json!({}))) }
                },
                _ => panic!("unexpected method"),
            }
        })).with_state(shared);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let peer = crate::peer_links::ResolvedPeer {
            origin: format!("http://{address}"),
            token: "fixture-token".into(),
            address,
        };
        let guard = || {
            if allowed.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(fail("capability_denied", "link revoked"))
            }
        };
        let test_db = Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        let client = PeerMcpClient::default();
        assert!(client
            .call(
                &test_db,
                "peer-renewal",
                &peer,
                "t3_thread_read",
                &json!({}),
                "approval-required",
                "plan",
                None,
                &guard
            )
            .await
            .is_ok());
        let result = client
            .call(
                &test_db,
                "peer-renewal",
                &peer,
                "t3_thread_read",
                &json!({}),
                "approval-required",
                "plan",
                None,
                &guard,
            )
            .await;
        assert_eq!(result.err().unwrap().code, "capability_denied");
        assert_eq!(opens.load(Ordering::SeqCst), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[test]
    fn caller_limits_come_from_thread_and_fenced_links_cannot_chain() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,runtime_mode TEXT,interaction_mode TEXT,title TEXT,payload_json TEXT,deleted_at TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('thread','approval-required','plan','a/b','{}',NULL)").unwrap();
        let db = Mutex::new(conn);
        let scope = crate::mcp_credentials::Scope {
            thread_id: "thread".into(),
            provider_session_id: "session".into(),
            provider_instance_id: "provider".into(),
            capabilities: ["orchestration".to_owned()].into_iter().collect(),
            subagent: false, client: None,
        };
        let context = caller(&db, &scope, "env").unwrap();
        assert_eq!(context.runtime, "approval-required");
        assert_eq!(context.interaction, "plan");
        assert_eq!(context.sender, "env/thread/a%2Fb");
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_projection_threads SET payload_json=?1",
                [json!({"linkOrigin":{"label":"remote","access":"auto"}}).to_string()],
            )
            .unwrap();
        assert_eq!(
            caller(&db, &scope, "env").err().unwrap().code,
            "capability_denied"
        );
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_projection_threads SET payload_json=?1",
                [json!({"linkOrigin":{"label":"remote","access":"full-access"}}).to_string()],
            )
            .unwrap();
        assert!(caller(&db, &scope, "env").is_ok());
        assert_eq!(
            safe_remote_message("error: bearer secret-token", "secret-token"),
            "error: bearer [redacted]"
        );
    }

    #[tokio::test]
    async fn forwarding_checks_identity_limits_and_scopes_request_ids() {
        use axum::routing::get;
        let app = Router::new()
            .route("/.well-known/t3/environment", get(|| async { Json(json!({"environmentId":"peer","label":"Peer","platform":{"os":"linux","arch":"x64"},"serverVersion":"1","capabilities":{"mcpModeLimitHeader":true,"linkFence":true}})) }))
            .route("/mcp", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer fixture-token");
                assert_eq!(headers["t3-mode-limit"], "approval-required/plan");
                match body["method"].as_str().unwrap() {
                    "initialize" => (StatusCode::OK, [("mcp-session-id", "fixture-session")], Json(json!({"jsonrpc":"2.0","id":0,"result":{}}))),
                    "notifications/initialized" => (StatusCode::ACCEPTED, [("mcp-session-id", "")], Json(json!({}))),
                    "tools/call" => {
                        assert_eq!(headers["t3-sender-thread"], "local/thread/a%2Fb");
                        let expected: String = Sha256::digest(b"provider-session\nrequest").iter().map(|v| format!("{v:02x}")).collect();
                        assert_eq!(body["params"]["arguments"]["clientRequestId"], format!("fwd:{expected}"));
                        assert!(body["params"]["arguments"].get("environmentId").is_none());
                        (StatusCode::OK, [("mcp-session-id", "")], Json(json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"ok\":true}"}]}})))
                    }
                    _ => panic!("unexpected method"),
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,runtime_mode TEXT,interaction_mode TEXT,title TEXT,payload_json TEXT,deleted_at TEXT,archived_at TEXT,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('thread','approval-required','plan','a/b','{}',NULL,NULL,'provider'); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,run_id TEXT,status TEXT,ordinal INTEGER,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('thread','run','running',1,'provider'); CREATE TABLE peer_environment_links(environment_id TEXT PRIMARY KEY,secret_name TEXT,urls_json TEXT,expires_at TEXT,fenced INTEGER)").unwrap();
        conn.execute("INSERT INTO peer_environment_links VALUES('peer','peer-link-fixture',?1,'2999-01-01T00:00:00Z',1)", [json!([origin]).to_string()]).unwrap();
        let db = Mutex::new(conn);
        let dir = std::env::temp_dir().join(format!("peer-forward-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("peer-link-fixture.bin"), "fixture-token").unwrap();
        let scope = crate::mcp_credentials::Scope {
            thread_id: "thread".into(),
            provider_session_id: "provider-session".into(),
            provider_instance_id: "provider".into(),
            capabilities: ["orchestration".to_owned()].into_iter().collect(),
            subagent: false, client: None,
        };
        let result = forward(
            &db,
            &dir,
            &scope,
            "local",
            "peer",
            "t3_thread_read",
            json!({"environmentId":"peer","threadId":"target","clientRequestId":"request"}),
            &|| true,
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"ok":true}));
        let refused = forward(
            &db,
            &dir,
            &scope,
            "local",
            "peer",
            "t3_thread_send",
            json!({"attachments":[{}]}),
            &|| true,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(refused.code, "invalid_request");
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_projection_runs SET status='completed'",
                [],
            )
            .unwrap();
        let stale = forward(
            &db,
            &dir,
            &scope,
            "local",
            "peer",
            "t3_thread_send",
            json!({}),
            &|| true,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(stale.code, "parent_not_active");
        std::fs::remove_dir_all(dir).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn narrowing_caller_during_probe_blocks_forwarded_write() {
        use axum::routing::get;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let state = (entered.clone(), release.clone(), calls.clone());
        let app = Router::new()
            .route("/.well-known/t3/environment", get(|State((entered, release, _)): State<(Arc<tokio::sync::Notify>,Arc<tokio::sync::Notify>,Arc<AtomicUsize>)>| async move {
                entered.notify_one(); release.notified().await;
                Json(json!({"environmentId":"peer","label":"Peer","platform":{"os":"linux","arch":"x64"},"serverVersion":"1","capabilities":{"mcpModeLimitHeader":true,"linkFence":true}}))
            }))
            .route("/mcp", post(|State((_,_,calls)): State<(Arc<tokio::sync::Notify>,Arc<tokio::sync::Notify>,Arc<AtomicUsize>)>| async move { calls.fetch_add(1,Ordering::SeqCst); StatusCode::OK }))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,runtime_mode TEXT,interaction_mode TEXT,title TEXT,payload_json TEXT,deleted_at TEXT,archived_at TEXT,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('thread','full-access','default','Title','{}',NULL,NULL,'provider'); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,run_id TEXT,status TEXT,ordinal INTEGER,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('thread','run','running',1,'provider'); CREATE TABLE peer_environment_links(environment_id TEXT PRIMARY KEY,secret_name TEXT,urls_json TEXT,expires_at TEXT,fenced INTEGER)").unwrap();
        conn.execute("INSERT INTO peer_environment_links VALUES('peer','peer-link-fixture',?1,'2999-01-01T00:00:00Z',1)", [json!([origin]).to_string()]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let dir = std::env::temp_dir().join(format!("peer-mode-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("peer-link-fixture.bin"), "fixture-token").unwrap();
        let scope = crate::mcp_credentials::Scope {
            thread_id: "thread".into(),
            provider_session_id: "session".into(),
            provider_instance_id: "provider".into(),
            capabilities: ["orchestration".to_owned()].into_iter().collect(),
            subagent: false, client: None,
        };
        let task = {
            let db = db.clone();
            let dir = dir.clone();
            tokio::spawn(async move {
                forward(
                    &db,
                    &dir,
                    &scope,
                    "local",
                    "peer",
                    "t3_thread_send",
                    json!({"threadId":"target"}),
                    &|| true,
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_projection_threads SET runtime_mode='approval-required'",
                [],
            )
            .unwrap();
        release.notify_one();
        let error = task.await.unwrap().err().unwrap();
        assert_eq!(error.code, "capability_denied");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn narrowing_caller_during_handshake_blocks_tool_post() {
        use axum::routing::get;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let state = (entered.clone(), release.clone(), calls.clone());
        let app = Router::new()
            .route("/.well-known/t3/environment", get(|| async { Json(json!({"environmentId":"peer-handshake","label":"Peer","platform":{"os":"linux","arch":"x64"},"serverVersion":"1","capabilities":{"mcpModeLimitHeader":true,"linkFence":true}})) }))
            .route("/mcp", post(|State((entered,release,calls)): State<(Arc<tokio::sync::Notify>,Arc<tokio::sync::Notify>,Arc<AtomicUsize>)>, Json(body): Json<Value>| async move {
                match body["method"].as_str().unwrap() {
                    "initialize" => { entered.notify_one(); release.notified().await; (StatusCode::OK, [("mcp-session-id", "handshake-session")], Json(json!({"jsonrpc":"2.0","id":0,"result":{}}))) },
                    "notifications/initialized" => (StatusCode::ACCEPTED, [("mcp-session-id", "")], Json(json!({}))),
                    "tools/call" => { calls.fetch_add(1,Ordering::SeqCst); (StatusCode::OK, [("mcp-session-id", "")], Json(json!({"result":{"content":[]}}))) },
                    _ => panic!("unexpected method"),
                }
            })).with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,runtime_mode TEXT,interaction_mode TEXT,title TEXT,payload_json TEXT,deleted_at TEXT,archived_at TEXT,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('thread','full-access','default','Title','{}',NULL,NULL,'provider'); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,run_id TEXT,status TEXT,ordinal INTEGER,provider_instance_id TEXT); INSERT INTO orchestration_v2_projection_runs VALUES('thread','run','running',1,'provider'); CREATE TABLE peer_environment_links(environment_id TEXT PRIMARY KEY,secret_name TEXT,urls_json TEXT,expires_at TEXT,fenced INTEGER)").unwrap();
        conn.execute("INSERT INTO peer_environment_links VALUES('peer-handshake','peer-link-fixture',?1,'2999-01-01T00:00:00Z',1)", [json!([origin]).to_string()]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let dir =
            std::env::temp_dir().join(format!("peer-handshake-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("peer-link-fixture.bin"), "fixture-token").unwrap();
        let scope = crate::mcp_credentials::Scope {
            thread_id: "thread".into(),
            provider_session_id: "session".into(),
            provider_instance_id: "provider".into(),
            capabilities: ["orchestration".to_owned()].into_iter().collect(),
            subagent: false, client: None,
        };
        let task = {
            let db = db.clone();
            let dir = dir.clone();
            tokio::spawn(async move {
                forward(
                    &db,
                    &dir,
                    &scope,
                    "local",
                    "peer-handshake",
                    "t3_thread_send",
                    json!({"threadId":"target"}),
                    &|| true,
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_projection_threads SET runtime_mode='approval-required'",
                [],
            )
            .unwrap();
        release.notify_one();
        let error = task.await.unwrap().err().unwrap();
        assert_eq!(error.code, "capability_denied");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
        server.abort();
    }
}
