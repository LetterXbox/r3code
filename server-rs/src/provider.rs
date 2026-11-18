//! Codex app-server transport foundation. This is not the orchestration adapter.
pub mod acp;
pub(crate) mod acp_client;
pub mod acp_executor;
mod acp_instructions;
pub mod claude_executor;
mod claude_discovery;
pub(crate) mod claude_capabilities;
pub mod claude_requests;
pub mod claude_subagents;
pub mod codex_events;
pub mod codex_requests;
#[allow(dead_code)] // Cursor sign-in routing is in progress.
pub(crate) mod cursor_auth;
#[allow(dead_code)] // Cursor bridge integration is in progress.
pub(crate) mod cursor_bridge;
#[allow(dead_code)] // Cursor credential flow integration is in progress.
pub(crate) mod cursor_credentials;
#[allow(dead_code)] // Cursor orchestration wiring is in progress.
pub(crate) mod cursor_executor;
#[allow(dead_code)] // Cursor tool projection integration is in progress.
pub(crate) mod cursor_tools;
pub mod discovery;
pub mod executor;
mod fx_subagents;
mod grok_background;
mod grok_subagents;
pub mod ingest;
pub mod instance;
pub mod lifecycle;
pub mod mcp_app;
#[allow(dead_code)]
mod muse_events;
#[allow(dead_code)]
pub(crate) mod muse_executor;
#[allow(dead_code)]
mod muse_msp;
#[allow(dead_code)]
mod muse_projection;
#[allow(dead_code)]
pub(crate) mod muse_requests;
#[allow(dead_code)]
mod muse_runtime;
#[allow(dead_code)]
mod muse_session;
pub(crate) mod opencode_attachments;
#[allow(dead_code)] // Event projection is being integrated with the OpenCode lifecycle.
pub(crate) mod opencode_events;
pub mod opencode_executor;
pub(crate) mod opencode_fork;
#[allow(dead_code)] // Transport is being integrated with the OpenCode lifecycle.
pub(crate) mod opencode_http;
pub(crate) mod opencode_owner;
#[allow(dead_code)] // Projection is being integrated with the OpenCode lifecycle.
pub(crate) mod opencode_projection;
pub(crate) mod opencode_questions;
pub(crate) mod opencode_reconnect;
pub(crate) mod opencode_rollback;
#[allow(dead_code)] // Session lifecycle is being integrated with OpenCode execution.
pub(crate) mod opencode_session;
pub(crate) mod opencode_subagents;
pub(crate) mod opencode_tree;
#[allow(dead_code)] // Pi event decoding is being connected to provider lifecycle.
pub(crate) mod pi_events;
#[allow(dead_code)] // Pi turn supervision is being integrated.
pub(crate) mod pi_executor;
#[allow(dead_code)] // Pi launch is being connected to provider lifecycle.
pub(crate) mod pi_launch;
#[allow(dead_code)] // Pi projection is being connected to provider lifecycle.
pub(crate) mod pi_projection;
#[allow(dead_code)] // Pi questions are being connected to provider lifecycle.
pub(crate) mod pi_questions;
#[allow(dead_code)] // Pi transport is being connected to provider lifecycle.
pub(crate) mod pi_rpc;
#[allow(dead_code)] // Pi session operations are being connected to provider lifecycle.
pub(crate) mod pi_session;
pub mod plan_projection;
pub mod rollback;
pub mod root_turn;
pub mod secret_store;
pub mod session_registry;
pub mod session_task;
pub mod token_usage;
pub(crate) mod wake;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_LINE: u64 = 128 * 1024 * 1024;
const EVENT_LIMIT: usize = 32;
#[derive(Debug)]
pub enum ProviderError {
    Io(io::Error),
    Json(serde_json::Error),
    Timeout,
    /// The provider explicitly refused a steer without accepting the input.
    SteerDeclined,
    Closed,
    Protocol(&'static str),
    Remote {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}
impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProviderError {}
impl From<io::Error> for ProviderError {
    fn from(v: io::Error) -> Self {
        Self::Io(v)
    }
}
impl From<serde_json::Error> for ProviderError {
    fn from(v: serde_json::Error) -> Self {
        Self::Json(v)
    }
}
#[derive(Debug)]
pub enum ProviderEvent {
    Notification {
        method: String,
        params: Option<Value>,
    },
    Request {
        id: Value,
        method: String,
        params: Option<Value>,
    },
}
/// Generic low-level provider transport: events and native protocol remain untranslated.
pub trait ProviderClient {
    fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, ProviderError>;
    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), ProviderError>;
    fn next_event(&mut self, timeout: Duration) -> Result<ProviderEvent, ProviderError>;
    fn respond(
        &mut self,
        id: Value,
        result: Result<Value, (i64, String)>,
    ) -> Result<(), ProviderError>;
}
#[derive(Debug, Default)]
pub struct CodexLaunch {
    pub binary: Option<PathBuf>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    /// Variables removed from the inherited process environment before overrides.
    pub env_remove: Vec<String>,
    pub home: Option<PathBuf>,
    /// Keeps the private token broker alive for the lifetime of the child.
    #[cfg(unix)]
    pub managed_runtime: Option<Arc<crate::codex_managed_runtime::ManagedRuntime>>,
    /// Prevents managed release replacement while the child runs.
    #[cfg(unix)]
    pub managed_install: Option<crate::codex_release::InstalledLease>,
}

/// Per-thread settings sent on `thread/start`, `thread/resume`, and `thread/fork`.
pub fn codex_thread_runtime_params(
    app_thread_id: Option<&str>,
    cwd: Option<&str>,
    model: Option<&str>,
    mcp_session: Option<(&str, &str)>,
) -> Value {
    let mut config = json!({
        "tools.update_plan.enabled": true,
        "mcp_optional_startup_grace_ms": 10000,
        "features.concurrent_reasoning_summaries": true
    });
    if let Some(id) = app_thread_id {
        config["shell_environment_policy.set.T3CODE_THREAD_ID"] = json!(id);
    }
    if let Some((endpoint, authorization)) = mcp_session {
        config["mcp_servers.t3-code"] = json!({
            "url": endpoint, "tool_timeout_sec": 3900,
            "http_headers": {"Authorization": authorization},
            "disabled_tools": ["t3_thread_wait"]
        });
        config["mcp_servers.t3-code-direct"] = json!({
            "url": endpoint, "tool_timeout_sec": 3900,
            "http_headers": {"Authorization": authorization},
            "enabled_tools": ["t3_thread_wait"], "omit_tools_from": ["code_mode", "deferred"]
        });
    }
    let mut params = json!({"config": config});
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    if let Some(model) = model {
        params["model"] = json!(model);
    }
    params
}

#[derive(Debug, Clone, Copy)]
pub enum CodexRuntimeMode {
    ApprovalRequired,
    AutoAcceptEdits,
    Auto,
    FullAccess,
}

#[derive(Debug, Clone, Copy)]
pub enum CodexInteractionMode {
    Default,
    Plan,
}

/// Native input and policy overrides must already be decoded against the Codex
/// schemas. T3 context must be assembled by the caller from the real prompts.
pub struct CodexTurnParams<'a> {
    pub thread_id: &'a str,
    pub input: Vec<Value>,
    pub cwd: Option<&'a str>,
    pub model: &'a str,
    pub runtime_mode: CodexRuntimeMode,
    pub interaction_mode: CodexInteractionMode,
    /// None selects the mode default; Some(null) explicitly clears the policy.
    pub approval_policy: Option<Value>,
    /// None selects the mode default; Some(null) explicitly clears the policy.
    pub sandbox_policy: Option<Value>,
    pub reasoning_effort: Option<&'a str>,
    pub service_tier: Option<&'a str>,
    pub fast_mode: bool,
    pub omit_service_tier: bool,
    pub reasoning_summary: Option<&'a str>,
    /// None means the model has no cyber access descriptor; Some(None) means
    /// it has one but has no valid default.
    pub cyber_access_default: Option<Option<&'a str>>,
    pub cyber_access_selection: Option<&'a str>,
    pub additional_context: Option<serde_json::Map<String, Value>>,
    pub app_context: Vec<(&'a str, &'a str)>,
}

pub fn codex_turn_start_params(input: CodexTurnParams<'_>) -> Result<Value, ProviderError> {
    let (approval, reviewer, sandbox) = match input.runtime_mode {
        CodexRuntimeMode::ApprovalRequired => ("untrusted", "user", "readOnly"),
        CodexRuntimeMode::AutoAcceptEdits => ("on-request", "user", "workspaceWrite"),
        CodexRuntimeMode::Auto => ("on-request", "auto_review", "workspaceWrite"),
        CodexRuntimeMode::FullAccess => ("never", "user", "dangerFullAccess"),
    };
    let summary = input.reasoning_summary.unwrap_or("auto");
    if !matches!(summary, "auto" | "concise" | "detailed" | "none") {
        return Err(ProviderError::Protocol("invalid reasoning summary"));
    }
    let family = input
        .model
        .strip_prefix("openai.")
        .filter(|_| input.model.starts_with("openai.gpt-"))
        .unwrap_or(input.model);
    let effort = input.reasoning_effort.or(if family == "gpt-6-astra" {
        Some("medium")
    } else {
        None
    });
    let mode = match input.interaction_mode {
        CodexInteractionMode::Default => "default",
        CodexInteractionMode::Plan => "plan",
    };
    let mut params = json!({
        "threadId": input.thread_id, "input": input.input, "cwd": input.cwd,
        "model": input.model, "summary": summary,
        "approvalPolicy": input.approval_policy.unwrap_or_else(|| json!(approval)), "approvalsReviewer": reviewer,
        "sandboxPolicy": input.sandbox_policy.unwrap_or_else(|| json!({"type": sandbox})),
        "collaborationMode": {"mode": mode, "settings": {"model": input.model}}
    });
    if let Some(effort) = effort {
        params["effort"] = json!(effort);
        params["collaborationMode"]["settings"]["reasoning_effort"] = json!(effort);
    }
    if !input.omit_service_tier {
        if let Some(tier) = input
            .service_tier
            .or(if input.fast_mode { Some("fast") } else { None })
        {
            params["serviceTier"] = json!(tier);
        }
    }
    if let Some(default) = input.cyber_access_default {
        if let Some(program) = [input.cyber_access_selection, default]
            .into_iter()
            .flatten()
            .find(|s| matches!(*s, "standard" | "daybreakBlue" | "daybreakRed"))
        {
            params["cyberAccessProgram"] = json!(program);
        }
    }
    let context_present = input.additional_context.is_some();
    let mut context = input.additional_context.unwrap_or_default();
    for (key, value) in input.app_context {
        context.insert(key.to_owned(), json!({"kind": "untrusted", "value": value}));
    }
    if context_present || !context.is_empty() {
        params["additionalContext"] = Value::Object(context);
    }
    Ok(params)
}
pub type ServerRequestHandler =
    dyn Fn(Value, String, Option<Value>) -> Result<Value, (i64, String)> + Send + Sync + 'static;

/// A session shutdown handle. Cancelling a session terminates the shared
/// app-server; it is not an individual turn interruption.
#[derive(Clone)]
pub struct CodexShutdown {
    state: Arc<Mutex<CodexProcessState>>,
}
struct CodexProcessState {
    child: Child,
    stopped: bool,
}
impl CodexShutdown {
    pub fn shutdown(&self) -> Result<(), ProviderError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProviderError::Protocol("child lock poisoned"))?;
        if state.stopped {
            return Ok(());
        }
        let child = &mut state.child;
        #[cfg(unix)]
        {
            let pgid = child.id() as libc::pid_t;
            // This child was spawned in its own process group.
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            let until = Instant::now() + Duration::from_secs(2);
            while Instant::now() < until {
                if child.try_wait()?.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            // Descendants may outlive the group leader, even after it exits.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            if child.try_wait()?.is_none() {
                child.kill()?;
            }
        }
        child.wait()?;
        state.stopped = true;
        Ok(())
    }
}

pub struct CodexClient {
    shutdown: CodexShutdown,
    stdin: Arc<Mutex<ChildStdin>>,
    handler: Option<Arc<ServerRequestHandler>>,
    active: Arc<AtomicUsize>,
    incoming: Receiver<Result<Value, ProviderError>>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    next_id: u64,
    events: VecDeque<ProviderEvent>,
    initialized: bool,
    #[cfg(unix)]
    _managed_runtime: Option<Arc<crate::codex_managed_runtime::ManagedRuntime>>,
    #[cfg(unix)]
    _managed_install: Option<crate::codex_release::InstalledLease>,
}
impl CodexClient {
    pub fn spawn(options: CodexLaunch) -> Result<Self, ProviderError> {
        let mut cmd = Command::new(options.binary.unwrap_or_else(|| PathBuf::from("codex")));
        cmd.arg("app-server")
            .arg("-c")
            .arg("thread_unload_delay_secs=0")
            .args(options.args)
            .env("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "T3 Code")
            .envs(options.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in &options.env_remove {
            cmd.env_remove(name);
        }
        if let Some(cwd) = options.cwd {
            cmd.current_dir(cwd);
        }
        if let Some(home) = options.home {
            cmd.env("CODEX_HOME", home);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        // A freshly replaced executable can briefly be busy on some filesystems.
        // Retry only that transient error; all other launch failures are immediate.
        #[cfg(unix)]
        let mut retries = 0;
        let mut child = loop {
            match cmd.spawn() {
                Ok(child) => break child,
                #[cfg(unix)]
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && retries < 5 => {
                    retries += 1;
                    thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => return Err(error.into()),
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or(ProviderError::Protocol("missing stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(ProviderError::Protocol("missing stdout"))?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or(ProviderError::Protocol("missing stderr"))?;
        let (tx, incoming) = mpsc::sync_channel(EVENT_LIMIT);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader)
                    .take(MAX_LINE + 1)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => {
                        let _ = tx.send(Err(ProviderError::Closed));
                        break;
                    }
                    Ok(_) if bytes.len() as u64 > MAX_LINE => {
                        let _ = tx.send(Err(ProviderError::Protocol(
                            "incoming message exceeds 128 MiB",
                        )));
                        break;
                    }
                    Ok(_) => {
                        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                            bytes.pop();
                        }
                        if bytes.is_empty() {
                            continue;
                        }
                        let parsed = serde_json::from_slice(&bytes).map_err(ProviderError::Json);
                        let failed = parsed.is_err();
                        if tx.send(parsed).is_err() || failed {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(ProviderError::Io(e)));
                        break;
                    }
                }
            }
        });
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let tail = stderr.clone();
        thread::spawn(move || {
            let mut stream = stderr_pipe;
            let mut buf = [0; 1024];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut tail) = tail.lock() {
                    for b in &buf[..n] {
                        if tail.len() == 8192 {
                            tail.pop_front();
                        }
                        tail.push_back(*b);
                    }
                }
            }
        });
        Ok(Self {
            shutdown: CodexShutdown {
                state: Arc::new(Mutex::new(CodexProcessState {
                    child,
                    stopped: false,
                })),
            },
            stdin: Arc::new(Mutex::new(stdin)),
            handler: None,
            active: Arc::new(AtomicUsize::new(0)),
            incoming,
            stderr,
            next_id: 1,
            events: VecDeque::new(),
            initialized: false,
            #[cfg(unix)]
            _managed_runtime: options.managed_runtime,
            #[cfg(unix)]
            _managed_install: options.managed_install,
        })
    }
    pub fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .map(|b| String::from_utf8_lossy(&b.iter().copied().collect::<Vec<_>>()).into_owned())
            .unwrap_or_default()
    }
    /// Allows the session owner to stop a request waiting on the subprocess.
    pub fn shutdown_handle(&self) -> CodexShutdown {
        self.shutdown.clone()
    }
    /// Install a handler which may wait for user approval. It runs off the reader
    /// thread; up to 32 requests can be active. Unknown methods should return -32601.
    pub fn set_request_handler(&mut self, handler: Arc<ServerRequestHandler>) {
        self.handler = Some(handler);
    }
    fn send_shared(stdin: &Arc<Mutex<ChildStdin>>, frame: Value) -> Result<(), ProviderError> {
        let mut stdin = stdin
            .lock()
            .map_err(|_| ProviderError::Protocol("stdin lock poisoned"))?;
        serde_json::to_writer(&mut *stdin, &frame)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }
    fn send(&mut self, frame: Value) -> Result<(), ProviderError> {
        Self::send_shared(&self.stdin, frame)
    }
    pub(super) fn receive(&self, timeout: Duration) -> Result<Value, ProviderError> {
        self.incoming.recv_timeout(timeout).map_err(|e| match e {
            RecvTimeoutError::Timeout => ProviderError::Timeout,
            RecvTimeoutError::Disconnected => ProviderError::Closed,
        })?
    }
    pub(super) fn event(frame: &Value) -> Result<Option<ProviderEvent>, ProviderError> {
        let obj = frame
            .as_object()
            .ok_or(ProviderError::Protocol("frame is not an object"))?;
        let Some(method) = obj.get("method") else {
            return Ok(None);
        };
        let method = method
            .as_str()
            .ok_or(ProviderError::Protocol("invalid method"))?
            .to_owned();
        let params = obj.get("params").cloned();
        match obj.get("id") {
            None => Ok(Some(ProviderEvent::Notification { method, params })),
            Some(id) if id.is_string() || id.is_i64() || id.is_u64() => {
                Ok(Some(ProviderEvent::Request {
                    id: id.clone(),
                    method,
                    params,
                }))
            }
            _ => Err(ProviderError::Protocol("invalid request id")),
        }
    }
    fn enqueue(&mut self, event: ProviderEvent) -> Result<(), ProviderError> {
        if let ProviderEvent::Request { id, method, params } = event {
            let Some(handler) = self.handler.clone() else {
                return self.respond(id, Err((-32601, "Method not found".into())));
            };
            if self
                .active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < EVENT_LIMIT).then_some(n + 1)
                })
                .is_err()
            {
                return self.respond(
                    id,
                    Err((-32001, "Too many Codex requests are already active.".into())),
                );
            }
            let stdin = self.stdin.clone();
            let active = self.active.clone();
            thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handler(id.clone(), method, params)
                }))
                .unwrap_or_else(|_| Err((-32603, "Request handler failed".into())));
                let frame = match result {
                    Ok(result) => json!({"id":id,"result":result}),
                    Err((code, message)) => {
                        json!({"id":id,"error":{"code":code,"message":message}})
                    }
                };
                let _ = CodexClient::send_shared(&stdin, frame);
                active.fetch_sub(1, Ordering::AcqRel);
            });
            return Ok(());
        }
        // Notifications may precede the response to a request. Preserve all of
        // them in order: dropping deltas here corrupts the assistant's output.
        self.events.push_back(event);
        Ok(())
    }
    pub(super) fn start_request(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<u64, ProviderError> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(ProviderError::Protocol("request ids exhausted"))?;
        let mut frame = json!({"id": id, "method": method});
        if let Some(params) = params {
            frame["params"] = params;
        }
        self.send(frame)?;
        Ok(id)
    }
    pub(super) fn response(frame: &Value) -> Result<Value, ProviderError> {
        let obj = frame
            .as_object()
            .ok_or(ProviderError::Protocol("invalid response"))?;
        if let Some(error) = obj.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .ok_or(ProviderError::Protocol("invalid error"))?;
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .ok_or(ProviderError::Protocol("invalid error"))?
                .to_owned();
            return Err(ProviderError::Remote {
                code,
                message,
                data: error.get("data").cloned(),
            });
        }
        obj.get("result")
            .cloned()
            .ok_or(ProviderError::Protocol("missing result"))
    }
    /// Initialize once; callers should provide the session-specific capabilities when needed.
    pub fn initialize(
        &mut self,
        version: &str,
        capabilities: Value,
        timeout: Duration,
    ) -> Result<Value, ProviderError> {
        if self.initialized {
            return Err(ProviderError::Protocol("already initialized locally"));
        }
        let result = self.request("initialize",Some(json!({"clientInfo":{"name":"T3 Code","title":"T3 Code","version":version},"capabilities":capabilities})),timeout);
        let result = match result {
            Ok(v) => v,
            Err(ProviderError::Remote {
                code: -32600,
                ref message,
                ..
            }) if message == "Already initialized" => Value::Null,
            Err(e) => return Err(e),
        };
        self.notify("initialized", None)?;
        self.initialized = true;
        Ok(result)
    }
}
impl ProviderClient for CodexClient {
    fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, ProviderError> {
        let id = self.start_request(method, params)?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(ProviderError::Timeout)?;
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or(ProviderError::Timeout)?;
            let frame = self.receive(left)?;
            if let Some(event) = Self::event(&frame)? {
                self.enqueue(event)?;
                continue;
            }
            let obj = frame
                .as_object()
                .ok_or(ProviderError::Protocol("invalid response"))?;
            let response_id = obj
                .get("id")
                .ok_or(ProviderError::Protocol("missing response id"))?;
            if response_id.as_u64() != Some(id) {
                continue;
            }
            return Self::response(&frame);
        }
    }
    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), ProviderError> {
        let mut frame = json!({"method":method});
        if let Some(params) = params {
            frame["params"] = params;
        }
        self.send(frame)
    }
    fn next_event(&mut self, timeout: Duration) -> Result<ProviderEvent, ProviderError> {
        if let Some(event) = self.events.pop_front() {
            return Ok(event);
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(ProviderError::Timeout)?;
        loop {
            let frame = self.receive(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(ProviderError::Timeout)?,
            )?;
            if let Some(event) = Self::event(&frame)? {
                if self.handler.is_some() && matches!(event, ProviderEvent::Request { .. }) {
                    self.enqueue(event)?;
                    continue;
                }
                return Ok(event);
            }
        }
    }
    fn respond(
        &mut self,
        id: Value,
        result: Result<Value, (i64, String)>,
    ) -> Result<(), ProviderError> {
        if !(id.is_string() || id.is_i64() || id.is_u64()) {
            return Err(ProviderError::Protocol("invalid response id"));
        }
        self.send(match result {
            Ok(result) => json!({"id":id,"result":result}),
            Err((code, message)) => json!({"id":id,"error":{"code":code,"message":message}}),
        })
    }
}
impl Drop for CodexClient {
    fn drop(&mut self) {
        let _ = self.shutdown.shutdown();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::ExitStatusExt;
    #[test]
    fn session_shutdown_interrupts_pending_request_and_reaps_process() {
        let path = std::env::temp_dir().join(format!("t3-codex-shutdown-{}", uuid::Uuid::new_v4()));
        let script = r##"#!/usr/bin/env python3
import sys,json,signal,subprocess
signal.signal(signal.SIGTERM, signal.SIG_IGN)
for line in sys.stdin:
 m=json.loads(line)
 subprocess.Popen([sys.executable, '-c', 'import signal; signal.pause()'])
 print(json.dumps({'id':'ready','method':'ready'}),flush=True)
 while True: signal.pause()
"##;
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut client = CodexClient::spawn(CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        })
        .unwrap();
        let shutdown = client.shutdown_handle();
        let (ready_tx, ready_rx) = mpsc::channel();
        client.set_request_handler(Arc::new(move |_, _, _| {
            ready_tx.send(()).unwrap();
            Ok(json!({}))
        }));
        let request = thread::spawn(move || {
            client.request("turn/start", Some(json!({})), Duration::from_secs(10))
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        shutdown.shutdown().unwrap();
        assert!(matches!(
            request.join().unwrap(),
            Err(ProviderError::Closed)
        ));
        let mut state = shutdown.state.lock().unwrap();
        assert!(state.stopped);
        assert_eq!(
            state.child.try_wait().unwrap().unwrap().signal(),
            Some(libc::SIGKILL)
        );
        drop(state);
        shutdown.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn turn_and_thread_parameters_follow_native_policy() {
        let params = codex_turn_start_params(CodexTurnParams {
            thread_id: "native",
            input: vec![json!({"type":"text","text":"hi"})],
            cwd: Some("/workspace"),
            model: "openai.gpt-6-astra",
            runtime_mode: CodexRuntimeMode::Auto,
            interaction_mode: CodexInteractionMode::Plan,
            approval_policy: None,
            sandbox_policy: None,
            reasoning_effort: None,
            service_tier: None,
            fast_mode: true,
            omit_service_tier: false,
            reasoning_summary: None,
            cyber_access_default: Some(Some("daybreakBlue")),
            cyber_access_selection: Some("standard"),
            additional_context: None,
            app_context: vec![("notes", "untrusted content")],
        })
        .unwrap();
        assert_eq!(
            params,
            json!({
                "threadId":"native", "input":[{"type":"text","text":"hi"}],
                "cwd":"/workspace", "model":"openai.gpt-6-astra", "summary":"auto",
                "approvalPolicy":"on-request", "approvalsReviewer":"auto_review",
                "sandboxPolicy":{"type":"workspaceWrite"}, "effort":"medium",
                "serviceTier":"fast", "cyberAccessProgram":"standard",
                "collaborationMode":{"mode":"plan","settings":{"model":"openai.gpt-6-astra","reasoning_effort":"medium"}},
                "additionalContext":{"notes":{"kind":"untrusted","value":"untrusted content"}}
            })
        );
        let params = codex_thread_runtime_params(
            Some("app"),
            Some("/workspace"),
            None,
            Some(("http://localhost/mcp", "Bearer secret")),
        );
        assert_eq!(
            params["config"]["shell_environment_policy.set.T3CODE_THREAD_ID"],
            "app"
        );
        assert_eq!(
            params["config"]["mcp_servers.t3-code"]["disabled_tools"],
            json!(["t3_thread_wait"])
        );
        assert_eq!(
            params["config"]["mcp_servers.t3-code-direct"]["omit_tools_from"],
            json!(["code_mode", "deferred"])
        );
        assert_eq!(
            params["config"]["mcp_servers.t3-code-direct"]["http_headers"]["Authorization"],
            "Bearer secret"
        );
        assert!(params.get("model").is_none());
    }

    #[test]
    fn turn_parameters_preserve_explicit_null_and_omit_managed_tier() {
        let params = codex_turn_start_params(CodexTurnParams {
            thread_id: "native",
            input: vec![],
            cwd: None,
            model: "gpt-5.4",
            runtime_mode: CodexRuntimeMode::FullAccess,
            interaction_mode: CodexInteractionMode::Default,
            approval_policy: Some(Value::Null),
            sandbox_policy: Some(Value::Null),
            reasoning_effort: Some("high"),
            service_tier: Some("priority"),
            fast_mode: true,
            omit_service_tier: true,
            reasoning_summary: Some("concise"),
            cyber_access_default: Some(Some("daybreakBlue")),
            cyber_access_selection: Some("invalid"),
            additional_context: Some(serde_json::Map::from_iter([(
                "notes".into(),
                json!({"kind":"developer","value":"old"}),
            )])),
            app_context: vec![("notes", "new")],
        })
        .unwrap();
        assert_eq!(params["approvalPolicy"], Value::Null);
        assert_eq!(params["sandboxPolicy"], Value::Null);
        assert!(params.get("serviceTier").is_none());
        assert_eq!(params["cyberAccessProgram"], "daybreakBlue");
        assert_eq!(
            params["additionalContext"]["notes"],
            json!({"kind":"untrusted","value":"new"})
        );
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
    }

    #[test]
    fn notifications_are_not_lost_while_waiting_for_response() {
        let path = std::env::temp_dir().join(format!("t3-codex-stream-{}", uuid::Uuid::new_v4()));
        let script = r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 for i in range(80):
  print(json.dumps({'method':'item/agentMessage/delta','params':{'index':i}}),flush=True)
 print(json.dumps({'id':m['id'],'result':{}}),flush=True)
"##;
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut client = CodexClient::spawn(CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        })
        .unwrap();
        client
            .request("turn/start", Some(json!({})), Duration::from_secs(2))
            .unwrap();
        for i in 0..80 {
            match client.next_event(Duration::from_secs(1)).unwrap() {
                ProviderEvent::Notification { method, params } => {
                    assert_eq!(method, "item/agentMessage/delta");
                    assert_eq!(params.unwrap()["index"], i);
                }
                _ => panic!("expected notification"),
            }
        }
        drop(client);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn fixture_exercises_handshake_notifications_and_errors() {
        let path = std::env::temp_dir().join(format!("t3-codex-fixture-{}", uuid::Uuid::new_v4()));
        let script = r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  print(json.dumps({'method':'warning','params':{'message':'hello'}}), flush=True)
  print(json.dumps({'id':m['id'],'result':{'userAgent':'codex/1.2.3'}}), flush=True)
 elif m.get('method')=='initialized': pass
 elif m.get('method')=='fail': print(json.dumps({'id':m['id'],'error':{'code':-32601,'message':'no method'}}), flush=True)
 elif m.get('method')=='echo': print(json.dumps({'id':m['id'],'result':m['params']}), flush=True)
"##;
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut client = CodexClient::spawn(CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            client
                .initialize("1", json!({"experimentalApi":true}), Duration::from_secs(2))
                .unwrap()["userAgent"],
            "codex/1.2.3"
        );
        assert!(
            matches!(client.next_event(Duration::from_secs(1)).unwrap(),ProviderEvent::Notification {method,..} if method == "warning")
        );
        assert_eq!(
            client
                .request("echo", Some(json!({"x":4})), Duration::from_secs(2))
                .unwrap(),
            json!({"x":4})
        );
        assert!(matches!(
            client.request("fail", None, Duration::from_secs(2)),
            Err(ProviderError::Remote { code: -32601, .. })
        ));
        drop(client);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn pending_call_handles_server_approval() {
        let path = std::env::temp_dir().join(format!("t3-codex-approval-{}", uuid::Uuid::new_v4()));
        let script = r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='turn/start':
  print(json.dumps({'id':'approval-1','method':'item/commandExecution/requestApproval','params':{'command':'echo ok'}}),flush=True)
  reply=json.loads(sys.stdin.readline())
  print(json.dumps({'id':m['id'],'result':reply.get('result',{})}),flush=True)
"##;
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut client = CodexClient::spawn(CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        })
        .unwrap();
        client.set_request_handler(Arc::new(|id, method, params| {
            assert_eq!(id, "approval-1");
            assert_eq!(method, "item/commandExecution/requestApproval");
            assert_eq!(params.unwrap()["command"], "echo ok");
            Ok(json!({"decision":"accept"}))
        }));
        assert_eq!(
            client
                .request("turn/start", Some(json!({})), Duration::from_secs(2))
                .unwrap(),
            json!({"decision":"accept"})
        );
        drop(client);
        std::fs::remove_file(path).unwrap();
    }
}
