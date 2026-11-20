//! Reusable Agent Client Protocol process and JSON-RPC session transport.
//!
//! Provider-specific launch configuration and policy remain the caller's job.
//! Server requests are never implicitly approved: callers must explicitly reply.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum AcpError {
    Io(io::Error),
    Json(serde_json::Error),
    Timeout,
    Closed,
    Protocol(&'static str),
    Remote {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}
impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for AcpError {}
impl From<io::Error> for AcpError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<serde_json::Error> for AcpError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

#[derive(Clone, Debug)]
pub struct AcpLaunch {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub env_remove: Vec<String>,
}

/// ACP messages that must be handled while a request is in flight.
#[derive(Debug)]
pub enum AcpEvent {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
        responder: AcpResponder,
    },
}
/// None defers a server response to the supplied responder, allowing the
/// reader to continue receiving concurrent requests and notifications.
pub type AcpReply = Result<Option<Value>, (i64, String)>;
#[derive(Debug)]
struct ResponderState {
    input: Arc<Mutex<ChildStdin>>,
    id: Value,
    answered: std::sync::atomic::AtomicBool,
    outstanding: Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for ResponderState {
    fn drop(&mut self) {
        self.outstanding
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
#[derive(Clone, Debug)]
pub struct AcpResponder {
    state: Arc<ResponderState>,
}
impl AcpResponder {
    pub fn respond(&self, result: Result<Value, (i64, String)>) -> Result<(), AcpError> {
        use std::sync::atomic::Ordering;
        if self.state.answered.swap(true, Ordering::AcqRel) {
            return Err(AcpError::Protocol("request already answered"));
        }
        let frame = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":self.state.id,"result":value}),
            Err((code, message)) => {
                json!({"jsonrpc":"2.0","id":self.state.id,"error":{"code":code,"message":message}})
            }
        };
        send_frame(&self.state.input, &frame)
    }
}

pub struct AcpSession {
    child: Child,
    input: Arc<Mutex<ChildStdin>>,
    incoming: Receiver<Result<Value, AcpError>>,
    next_id: u64,
    outstanding: Arc<std::sync::atomic::AtomicUsize>,
    initialized: Option<Value>,
    session_id: Option<String>,
    setup: Option<Value>,
    fx_mode: Option<String>,
    client_read: bool,
    client_write: bool,
    client_terminal: bool,
    auth_method: Option<String>,
    initialize_meta: Option<Value>,
    client_capabilities_meta: Option<Value>,
    cancel_meta: Option<Value>,
    cancel_requested: Arc<std::sync::atomic::AtomicBool>,
    additional_directories: Vec<String>,
}

impl AcpSession {
    pub fn spawn(launch: AcpLaunch) -> Result<Self, AcpError> {
        let mut cmd = Command::new(launch.binary);
        cmd.args(launch.args)
            .current_dir(launch.cwd)
            .envs(launch.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for key in launch.env_remove {
            cmd.env_remove(key);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or(AcpError::Protocol("missing stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(AcpError::Protocol("missing stdout"))?;
        let (tx, incoming) = mpsc::sync_channel(128);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let result = (&mut reader)
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut bytes);
                match result {
                    Ok(0) => break,
                    Ok(_) if bytes.len() > MAX_FRAME as usize => {
                        let _ = tx.send(Err(AcpError::Protocol("frame too large")));
                        break;
                    }
                    Ok(_) => {
                        let value = serde_json::from_slice(&bytes).map_err(AcpError::Json);
                        if tx.send(value).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error.into()));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input: Arc::new(Mutex::new(input)),
            incoming,
            next_id: 1,
            outstanding: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            initialized: None,
            session_id: None,
            setup: None,
            fx_mode: None,
            client_read: false,
            client_write: false,
            client_terminal: false,
            auth_method: None,
            initialize_meta: None,
            client_capabilities_meta: None,
            cancel_meta: None,
            cancel_requested: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            additional_directories: Vec::new(),
        })
    }

    /// A retained session is reusable only while its agent process is alive.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn send(&mut self, value: &Value) -> Result<(), AcpError> {
        send_frame(&self.input, value)
    }

    /// Obtain a separate writer so cancellation can be sent while a prompt is
    /// blocked waiting for the agent's response.
    pub fn cancel_handle(&self) -> Result<AcpCancelHandle, AcpError> {
        Ok(AcpCancelHandle {
            input: self.input.clone(),
            cancel_meta: self.cancel_meta.clone(),
            cancel_requested: self.cancel_requested.clone(),
            session_id: self
                .session_id
                .clone()
                .ok_or(AcpError::Protocol("session not opened"))?,
        })
    }

    /// Read one unsolicited frame while no client request is in flight.
    pub fn poll_idle<F>(&mut self, timeout: Duration, handler: &mut F) -> Result<bool, AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let message = match self.incoming.recv_timeout(timeout) {
            Ok(value) => value?,
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(false),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(AcpError::Closed),
        };
        let name = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or(AcpError::Protocol("unexpected idle response"))?;
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = message.get("id") {
            let id = id.clone();
            use std::sync::atomic::Ordering;
            if self.outstanding.load(Ordering::Acquire) >= 64 {
                self.send(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Too many outstanding client requests"}}))?;
                return Ok(true);
            }
            self.outstanding.fetch_add(1, Ordering::AcqRel);
            let responder = AcpResponder {
                state: Arc::new(ResponderState {
                    input: self.input.clone(),
                    id: id.clone(),
                    answered: std::sync::atomic::AtomicBool::new(false),
                    outstanding: self.outstanding.clone(),
                }),
            };
            match handler(AcpEvent::Request {
                id,
                method: name.to_owned(),
                params,
                responder: responder.clone(),
            }) {
                Ok(Some(result)) => responder.respond(Ok(result))?,
                Ok(None) => {}
                Err(error) => responder.respond(Err(error))?,
            }
        } else {
            let _ = handler(AcpEvent::Notification {
                method: name.to_owned(),
                params,
            });
        }
        Ok(true)
    }

    /// Requests are serialized per connection. Notifications and agent requests
    /// are dispatched in arrival order while the agent is processing the request.
    pub fn request<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<Value, AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(AcpError::Protocol("request id exhausted"))?;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + timeout;
        let mut cancel_at = None;
        loop {
            if method == "session/prompt"
                && self
                    .cancel_requested
                    .load(std::sync::atomic::Ordering::Acquire)
            {
                let since = cancel_at.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_secs(3) {
                    let _ = self.child.kill();
                    return Err(AcpError::Closed);
                }
            }
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or(AcpError::Timeout)?;
            let message = match self
                .incoming
                .recv_timeout(left.min(Duration::from_millis(100)))
            {
                Ok(message) => message?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(AcpError::Closed),
            };
            if let Some(name) = message.get("method").and_then(Value::as_str) {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if let Some(request_id) = message.get("id") {
                    let request_id = request_id.clone();
                    use std::sync::atomic::Ordering;
                    if self.outstanding.load(Ordering::Acquire) >= 64 {
                        self.send(&json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32603,"message":"Too many outstanding client requests"}}))?;
                        continue;
                    }
                    self.outstanding.fetch_add(1, Ordering::AcqRel);
                    let responder = AcpResponder {
                        state: Arc::new(ResponderState {
                            input: self.input.clone(),
                            id: request_id.clone(),
                            answered: std::sync::atomic::AtomicBool::new(false),
                            outstanding: self.outstanding.clone(),
                        }),
                    };
                    let reply = handler(AcpEvent::Request {
                        id: request_id,
                        method: name.to_owned(),
                        params,
                        responder: responder.clone(),
                    });
                    match reply {
                        Ok(Some(result)) => responder.respond(Ok(result))?,
                        Ok(None) => {}
                        Err(error) => responder.respond(Err(error))?,
                    }
                } else {
                    let _ = handler(AcpEvent::Notification {
                        method: name.to_owned(),
                        params,
                    });
                }
                continue;
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                return Err(AcpError::Protocol("unexpected response id"));
            }
            if let Some(error) = message.get("error") {
                return Err(AcpError::Remote {
                    code: error["code"].as_i64().unwrap_or(-32603),
                    message: error["message"]
                        .as_str()
                        .unwrap_or("ACP request failed")
                        .to_owned(),
                    data: error.get("data").cloned(),
                });
            }
            return message
                .get("result")
                .cloned()
                .ok_or(AcpError::Protocol("missing response result"));
        }
    }

    pub fn configure_flavor(
        &mut self,
        auth_method: Option<String>,
        initialize_meta: Option<Value>,
        cancel_meta: Option<Value>,
    ) -> Result<(), AcpError> {
        if self.initialized.is_some() {
            return Err(AcpError::Protocol("client capabilities already negotiated"));
        }
        self.auth_method = auth_method;
        self.initialize_meta = initialize_meta;
        self.cancel_meta = cancel_meta;
        Ok(())
    }

    pub fn set_client_capabilities_meta(&mut self, meta: Value) -> Result<(), AcpError> {
        if self.initialized.is_some() {
            return Err(AcpError::Protocol("client capabilities already negotiated"));
        }
        self.client_capabilities_meta = Some(meta);
        Ok(())
    }

    pub fn set_additional_directories(&mut self, dirs: Vec<String>) -> Result<(), AcpError> {
        if self.initialized.is_some() {
            return Err(AcpError::Protocol("session options already negotiated"));
        }
        self.additional_directories = dirs;
        Ok(())
    }

    pub fn configure_client_services(
        &mut self,
        read: bool,
        write: bool,
        terminal: bool,
    ) -> Result<(), AcpError> {
        if self.initialized.is_some() {
            return Err(AcpError::Protocol("client capabilities already negotiated"));
        }
        self.client_read = read;
        self.client_write = write;
        self.client_terminal = terminal;
        Ok(())
    }

    pub fn initialize<F>(&mut self, timeout: Duration, handler: &mut F) -> Result<Value, AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        if let Some(value) = &self.initialized {
            return Ok(value.clone());
        }
        let mut params = json!({"protocolVersion":2,"clientCapabilities":{"fs":{"readTextFile":self.client_read,"writeTextFile":self.client_write},"terminal":self.client_terminal,"session":{"notices":{},"compaction":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}});
        if let Some(meta) = &self.initialize_meta {
            params["_meta"] = meta.clone();
        }
        if let Some(meta) = &self.client_capabilities_meta {
            params["clientCapabilities"]["_meta"] = meta.clone();
        }
        let response = self.request("initialize", params, timeout, handler)?;
        if !response["protocolVersion"].is_u64() {
            return Err(AcpError::Protocol("missing protocol version"));
        }
        self.initialized = Some(response.clone());
        Ok(response)
    }

    /// Starts a fresh session or loads a strong native session reference. Loading
    /// is permitted only when advertised; falling back to a fresh session would
    /// silently lose the user's previous conversation.
    pub fn open<F>(
        &mut self,
        cwd: &str,
        native_id: Option<&str>,
        mcp_servers: &[Value],
        timeout: Duration,
        handler: &mut F,
    ) -> Result<String, AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let capabilities = self.initialize(timeout, handler)?;
        let (method, mut params) = if let Some(id) = native_id {
            if id.trim().is_empty() {
                return Err(AcpError::Protocol("empty native session"));
            }
            let caps = &capabilities["agentCapabilities"];
            let method = if caps["loadSession"] == true {
                "session/load"
            } else if caps["sessionCapabilities"]["resume"].is_object() {
                "session/resume"
            } else {
                return Err(AcpError::Protocol("agent cannot resume session"));
            };
            (
                method,
                json!({"sessionId":id,"cwd":cwd,"mcpServers":mcp_servers}),
            )
        } else {
            ("session/new", json!({"cwd":cwd,"mcpServers":mcp_servers}))
        };
        if !self.additional_directories.is_empty() {
            params["additionalDirectories"] = json!(self.additional_directories);
        }
        let result = match self.request(method, params.clone(), timeout, handler) {
            Err(AcpError::Remote { code: -32000, .. }) => {
                let advertised = capabilities["authMethods"].as_array();
                let configured = self
                    .auth_method
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let chosen = if let Some(id) = configured {
                    advertised.and_then(|a| a.iter().find(|m| m["id"] == id))
                } else {
                    advertised.and_then(|a| {
                        a.iter()
                            .find(|m| m["type"].is_null() || m["type"] == "agent")
                    })
                };
                if configured.is_some() && advertised.is_some() && chosen.is_none() {
                    return Err(AcpError::Protocol("configured auth method not advertised"));
                }
                if chosen.is_some_and(|m| !m["type"].is_null() && m["type"] != "agent") {
                    return Err(AcpError::Protocol(
                        "authentication requires user interaction",
                    ));
                }
                let id = chosen
                    .and_then(|m| m["id"].as_str())
                    .or(configured)
                    .ok_or(AcpError::Protocol("no ACP authentication method"))?
                    .to_owned();
                self.request("authenticate", json!({"methodId":id}), timeout, handler)?;
                self.request(method, params, timeout, handler)?
            }
            other => other?,
        };
        let id = if let Some(id) = native_id {
            id.to_owned()
        } else {
            result["sessionId"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or(AcpError::Protocol("missing session id"))?
                .to_owned()
        };
        self.session_id = Some(id.clone());
        self.setup = Some(result);
        Ok(id)
    }

    pub fn apply_antigravity_cli_mode<F>(
        &mut self,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<(), AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let session = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        let setup = self
            .setup
            .as_ref()
            .ok_or(AcpError::Protocol("session setup missing"))?;
        let option = setup["configOptions"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|o| o["category"] == "mode" && o["type"] == "select")
            })
            .cloned();
        let current = option
            .as_ref()
            .and_then(|o| o["currentValue"].as_str())
            .or_else(|| setup["modes"]["currentModeId"].as_str());
        if current == Some("default") {
            return Ok(());
        }
        if let Some(option) = option {
            let id = option["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(AcpError::Protocol("invalid mode selector"))?;
            self.request(
                "session/set_config_option",
                json!({"sessionId":session,"configId":id,"value":"default"}),
                timeout,
                handler,
            )?;
        } else if setup["modes"].is_object() {
            self.request(
                "session/set_mode",
                json!({"sessionId":session,"modeId":"default"}),
                timeout,
                handler,
            )?;
        }
        Ok(())
    }

    /// FX requires an explicit policy write even when its reported mode already
    /// matches: otherwise it can silently retain a more permissive saved mode.
    pub fn apply_fx_mode<F>(
        &mut self,
        runtime_mode: &str,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<(), AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let session = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        let setup = self
            .setup
            .as_ref()
            .ok_or(AcpError::Protocol("session setup missing"))?;
        let desired = if runtime_mode == "auto" {
            "auto"
        } else {
            "ask"
        };
        if self.fx_mode.as_deref() == Some(desired) {
            return Ok(());
        }
        let option = setup["configOptions"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|o| o["category"] == "mode" && o["type"] == "select")
            })
            .cloned();
        let modes = setup["modes"]["availableModes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let option_values = option
            .as_ref()
            .and_then(|o| o["options"].as_array())
            .cloned()
            .unwrap_or_default();
        let available = |id: &str| {
            modes.iter().any(|m| m["id"] == id) || option_values.iter().any(|m| m["value"] == id)
        };
        let target = if available(desired) {
            desired
        } else if desired == "auto" && available("code") {
            "code"
        } else {
            return Err(AcpError::Protocol(
                "fx does not advertise required permission mode",
            ));
        };
        let current = option
            .as_ref()
            .and_then(|o| o["currentValue"].as_str())
            .or_else(|| setup["modes"]["currentModeId"].as_str());
        if option.is_none() && current != Some(target) {
            self.request(
                "session/set_mode",
                json!({"sessionId":session,"modeId":target}),
                timeout,
                handler,
            )?;
        } else {
            let id = option
                .as_ref()
                .and_then(|o| o["id"].as_str())
                .unwrap_or("mode");
            self.request(
                "session/set_config_option",
                json!({"sessionId":session,"configId":id,"value":target}),
                timeout,
                handler,
            )?;
        }
        self.fx_mode = Some(desired.to_owned());
        Ok(())
    }

    /// FX uses the option named `model`, not the first option in the model
    /// category (which may be the provider selector), and "default" is a
    /// sentinel rather than an agent model ID.
    pub fn select_fx_model<F>(
        &mut self,
        model: &str,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<(), AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        if model.trim().is_empty() || model == "default" {
            return Ok(());
        }
        let session = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        let option = self
            .setup
            .as_ref()
            .and_then(|s| s["configOptions"].as_array())
            .and_then(|a| {
                a.iter()
                    .find(|o| o["id"] == "model" && o["type"] == "select")
            });
        if option.is_some_and(|o| o["currentValue"] == model) {
            return Ok(());
        }
        let response = self.request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"model","value":model}),
            timeout,
            handler,
        )?;
        if let Some(setup) = self.setup.as_mut() {
            if let Some(options) = response.get("configOptions") {
                setup["configOptions"] = options.clone();
            }
        }
        Ok(())
    }

    pub fn kiro_has_model_option(&self) -> bool {
        self.setup
            .as_ref()
            .and_then(|s| s["configOptions"].as_array())
            .is_some_and(|options| {
                options.iter().any(|o| {
                    (o["id"] == "model" || o["category"] == "model") && o["type"] == "select"
                })
            })
    }

    /// Kiro accepts model IDs through its model option even before advertising it.
    pub fn select_kiro_model<F>(
        &mut self,
        model: &str,
        default_model: &str,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<(), AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let session = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        let option = self
            .setup
            .as_ref()
            .and_then(|s| s["configOptions"].as_array())
            .and_then(|a| {
                a.iter()
                    .find(|o| o["id"] == "model" || o["category"] == "model")
            });
        let is_default = model.trim().is_empty() || model == "default";
        if is_default && !option.is_some_and(|o| o["type"] == "select") {
            return Ok(());
        }
        let model = if is_default {
            default_model
        } else {
            model.trim()
        };
        if option.is_some_and(|o| o["type"] == "select" && o["currentValue"] == model) {
            return Ok(());
        }
        let id = option
            .and_then(|o| o["id"].as_str())
            .unwrap_or("model")
            .to_owned();
        let response = self.request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":id,"value":model}),
            timeout,
            handler,
        )?;
        if let Some(setup) = self.setup.as_mut() {
            if let Some(options) = response.get("configOptions") {
                setup["configOptions"] = options.clone();
            }
        }
        Ok(())
    }

    /// Apply an advertised model selector; never guess an unsupported method.
    pub fn select_model<F>(
        &mut self,
        model: &str,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<(), AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let session_id = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        let Some(setup) = self.setup.as_ref() else {
            return Err(AcpError::Protocol("session setup missing"));
        };
        let config = setup["configOptions"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|v| v["category"] == "model" && v["type"] == "select")
            })
            .cloned();
        if let Some(option) = config {
            if option["currentValue"] == model {
                return Ok(());
            }
            let id = option["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(AcpError::Protocol("invalid model selector"))?;
            let response = self.request(
                "session/set_config_option",
                json!({"sessionId":session_id,"configId":id,"value":model}),
                timeout,
                handler,
            )?;
            if let Some(setup) = self.setup.as_mut() {
                if let Some(options) = response.get("configOptions") {
                    setup["configOptions"] = options.clone();
                }
            }
        } else if setup["models"].is_object() && setup["models"]["currentModelId"] != model {
            self.request(
                "session/set_model",
                json!({"sessionId":session_id,"modelId":model}),
                timeout,
                handler,
            )?;
            if let Some(setup) = self.setup.as_mut() {
                setup["models"]["currentModelId"] = json!(model);
            }
        }
        Ok(())
    }

    pub fn prompt<F>(
        &mut self,
        prompt: Vec<Value>,
        timeout: Duration,
        handler: &mut F,
    ) -> Result<Value, AcpError>
    where
        F: FnMut(AcpEvent) -> AcpReply,
    {
        let id = self
            .session_id
            .clone()
            .ok_or(AcpError::Protocol("session not opened"))?;
        self.cancel_requested
            .store(false, std::sync::atomic::Ordering::Release);
        let result = self.request(
            "session/prompt",
            json!({"sessionId":id,"prompt":prompt}),
            timeout,
            handler,
        )?;
        if result["stopReason"].as_str().is_none() {
            return Err(AcpError::Protocol("missing stop reason"));
        }
        Ok(result)
    }

    pub fn supports_images(&self) -> bool {
        self.initialized
            .as_ref()
            .is_some_and(|v| v["agentCapabilities"]["promptCapabilities"]["image"] == true)
    }

    pub fn native_session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn cancel(&mut self) -> Result<(), AcpError> {
        self.cancel_handle()?.cancel()
    }
}
fn send_frame(input: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), AcpError> {
    let mut input = input
        .lock()
        .map_err(|_| AcpError::Protocol("writer lock poisoned"))?;
    serde_json::to_writer(&mut *input, value)?;
    input.write_all(b"\n")?;
    input.flush()?;
    Ok(())
}

#[derive(Clone)]
pub struct AcpCancelHandle {
    input: Arc<Mutex<ChildStdin>>,
    session_id: String,
    cancel_meta: Option<Value>,
    cancel_requested: Arc<std::sync::atomic::AtomicBool>,
}
impl AcpCancelHandle {
    pub fn cancel(&self) -> Result<(), AcpError> {
        self.cancel_requested
            .store(true, std::sync::atomic::Ordering::Release);
        let mut params = json!({"sessionId":self.session_id});
        if let Some(meta) = &self.cancel_meta {
            params["_meta"] = meta.clone();
        }
        send_frame(
            &self.input,
            &json!({"jsonrpc":"2.0","method":"session/cancel","params":params}),
        )
    }
}
impl Drop for AcpSession {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (PathBuf, AcpSession) {
        let dir = std::env::temp_dir().join(format!("t3-acp-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let agent = dir.join("agent");
        std::fs::write(&agent,r##"#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 with open('calls','a') as f: f.write(json.dumps(m)+'\n')
 if method=='initialize': result={'protocolVersion':2,'agentCapabilities':{'loadSession':True},'authMethods':[{'id':'cached_token','type':'agent'}]}
 elif method=='session/new':
  import os
  if os.path.exists('needs-auth') and not os.path.exists('authenticated'):
   print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32000,'message':'authentication required'}}),flush=True); continue
  result={'sessionId':'fresh-id'}
 elif method=='authenticate':
  assert p['methodId']=='cached_token'; open('authenticated','w').close(); result={}
 elif method=='session/load': result={}
 elif method in ('session/set_mode','session/set_config_option'): result={}
 elif method=='session/prompt':
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'hello'}}}}),flush=True)
  print(json.dumps({'jsonrpc':'2.0','id':'permission-1','method':'session/request_permission','params':{'sessionId':p['sessionId'],'options':[{'kind':'allow_once','optionId':'allow'},{'kind':'reject_once','optionId':'reject'}]}}),flush=True)
  reply=json.loads(sys.stdin.readline())
  with open('calls','a') as f: f.write(json.dumps(reply)+'\n')
  assert reply['result']['outcome']['optionId']=='reject'
  result={'stopReason':'end_turn'}
 elif method=='session/cancel': continue
 else: raise Exception(method)
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launch = AcpLaunch {
            binary: agent,
            args: vec![],
            cwd: dir.clone(),
            env: HashMap::new(),
            env_remove: vec![],
        };
        (dir, AcpSession::spawn(launch).unwrap())
    }
    #[test]
    fn opens_resumes_streams_and_replies_to_permission() {
        let (dir, mut session) = fixture();
        let mut updates = Vec::new();
        let mut handler = |event: AcpEvent| -> AcpReply {
            match event {
                AcpEvent::Notification { method, params } => {
                    updates.push((method, params));
                    Ok(None)
                }
                AcpEvent::Request { method, params, .. } => {
                    assert_eq!(method, "session/request_permission");
                    assert_eq!(params["sessionId"], "existing-id");
                    Ok(Some(
                        json!({"outcome":{"outcome":"selected","optionId":"reject"}}),
                    ))
                }
            }
        };
        assert_eq!(
            session
                .open(
                    "/tmp",
                    Some("existing-id"),
                    &[],
                    Duration::from_secs(5),
                    &mut handler
                )
                .unwrap(),
            "existing-id"
        );
        assert_eq!(
            session
                .prompt(
                    vec![json!({"type":"text","text":"hello"})],
                    Duration::from_secs(5),
                    &mut handler
                )
                .unwrap()["stopReason"],
            "end_turn"
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].1["update"]["content"]["text"], "hello");
        session.cancel().unwrap();
        drop(session);
        let log = std::fs::read_to_string(dir.join("calls")).unwrap();
        let calls: Vec<Value> = log
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            calls.iter().filter(|v| v["method"] == "initialize").count(),
            1
        );
        assert_eq!(calls[1]["method"], "session/load");
        assert_eq!(calls[1]["params"]["sessionId"], "existing-id");
        assert_eq!(calls[2]["params"]["prompt"][0]["text"], "hello");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn concurrent_terminal_wait_does_not_block_kill() {
        let dir = std::env::temp_dir().join(format!("t3-acp-concurrent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let agent = dir.join("agent");
        std::fs::write(&agent,r##"#!/usr/bin/env python3
import json,sys
def send(m): print(json.dumps(m),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize':
  assert m['params']['clientCapabilities']['terminal'] is True
  result={'protocolVersion':2,'agentCapabilities':{}}
 elif method=='session/new': result={'sessionId':'native'}
 elif method=='session/prompt':
  send({'jsonrpc':'2.0','id':'create','method':'terminal/create','params':{'sessionId':'native','command':'sleep 30'}})
  created=json.loads(sys.stdin.readline()); term=created['result']['terminalId']
  send({'jsonrpc':'2.0','id':'wait','method':'terminal/wait_for_exit','params':{'sessionId':'native','terminalId':term}})
  send({'jsonrpc':'2.0','id':'permission','method':'session/request_permission','params':{'sessionId':'native','options':[{'kind':'allow_once','optionId':'yes'}]}})
  send({'jsonrpc':'2.0','id':'kill','method':'terminal/kill','params':{'sessionId':'native','terminalId':term}})
  answers=[json.loads(sys.stdin.readline()),json.loads(sys.stdin.readline()),json.loads(sys.stdin.readline())]
  assert set(v['id'] for v in answers)=={'wait','kill','permission'}
  result={'stopReason':'end_turn'}
 else: raise Exception(method)
 send({'jsonrpc':'2.0','id':m['id'],'result':result})
"##).unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut session = AcpSession::spawn(AcpLaunch {
            binary: agent,
            args: vec![],
            cwd: dir.clone(),
            env: HashMap::new(),
            env_remove: vec![],
        })
        .unwrap();
        session
            .configure_client_services(false, false, true)
            .unwrap();
        let services = Arc::new(Mutex::new(super::super::acp_client::ClientServices::new(
            "native".into(),
            dir.clone(),
            vec![dir.clone()],
            false,
            false,
            true,
            true,
        )));
        let mut handler = |event: AcpEvent| -> AcpReply {
            match event {
                AcpEvent::Request {
                    method,
                    params,
                    responder,
                    ..
                } if method == "terminal/wait_for_exit" => {
                    let (child, readers) = services.lock().unwrap().wait_handle(&params).unwrap();
                    std::thread::spawn(move || {
                        let result =
                            super::super::acp_client::wait(child, readers).map_err(|e| (-32603, e));
                        responder.respond(result).unwrap();
                    });
                    Ok(None)
                }
                AcpEvent::Request { method, .. } if method == "session/request_permission" => Ok(
                    Some(json!({"outcome":{"outcome":"selected","optionId":"yes"}})),
                ),
                AcpEvent::Request { method, params, .. } => services
                    .lock()
                    .unwrap()
                    .handle(&method, &params, true)
                    .map(Some)
                    .map_err(|e| (-32603, e)),
                AcpEvent::Notification { .. } => Ok(None),
            }
        };
        session
            .open("/tmp", None, &[], Duration::from_secs(5), &mut handler)
            .unwrap();
        assert_eq!(
            session
                .prompt(
                    vec![json!({"type":"text","text":"hello"})],
                    Duration::from_secs(5),
                    &mut handler
                )
                .unwrap()["stopReason"],
            "end_turn"
        );
        drop(session);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prompt_can_be_cancelled_while_waiting() {
        let dir = std::env::temp_dir().join(format!("t3-acp-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let agent = dir.join("agent");
        std::fs::write(
            &agent,
            r##"#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': result={'protocolVersion':2,'agentCapabilities':{}}
 elif method=='session/new': result={'sessionId':'native'}
 elif method=='session/prompt':
  open('waiting','w').close()
  cancelled=json.loads(sys.stdin.readline())
  assert cancelled['method']=='session/cancel' and cancelled['params']['sessionId']=='native'
  result={'stopReason':'cancelled'}
 else: raise Exception(method)
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut session = AcpSession::spawn(AcpLaunch {
            binary: agent,
            args: vec![],
            cwd: dir.clone(),
            env: HashMap::new(),
            env_remove: vec![],
        })
        .unwrap();
        let mut handler = |_: AcpEvent| -> AcpReply { Err((-32601, "unsupported".into())) };
        session
            .open("/tmp", None, &[], Duration::from_secs(5), &mut handler)
            .unwrap();
        let cancel = session.cancel_handle().unwrap();
        let worker = std::thread::spawn(move || {
            session.prompt(
                vec![json!({"type":"text","text":"hi"})],
                Duration::from_secs(5),
                &mut handler,
            )
        });
        for _ in 0..200 {
            if dir.join("waiting").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(dir.join("waiting").exists());
        cancel.cancel().unwrap();
        assert_eq!(worker.join().unwrap().unwrap()["stopReason"], "cancelled");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_modes_are_explicit_and_session_scoped() {
        let (dir, mut session) = fixture();
        let mut handler = |_: AcpEvent| -> AcpReply { Err((-32601, "unsupported".into())) };
        session
            .open("/tmp", None, &[], Duration::from_secs(5), &mut handler)
            .unwrap();
        session.setup = Some(
            json!({"modes":{"currentModeId":"ask","availableModes":[{"id":"ask"},{"id":"auto"}]}}),
        );
        session
            .apply_fx_mode("approval-required", Duration::from_secs(5), &mut handler)
            .unwrap();
        session
            .apply_fx_mode("approval-required", Duration::from_secs(5), &mut handler)
            .unwrap();
        session.setup = Some(
            json!({"modes":{"currentModeId":"yolo","availableModes":[{"id":"default"},{"id":"yolo"}]}}),
        );
        session
            .apply_antigravity_cli_mode(Duration::from_secs(5), &mut handler)
            .unwrap();
        drop(session);
        let calls: Vec<Value> = std::fs::read_to_string(dir.join("calls"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            calls
                .iter()
                .filter(|m| m["method"] == "session/set_config_option")
                .count(),
            1
        );
        let antigravity = calls
            .iter()
            .find(|m| m["method"] == "session/set_mode")
            .unwrap();
        assert_eq!(antigravity["params"]["modeId"], "default");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn authenticates_once_on_auth_required_and_retries_setup() {
        let (dir, mut session) = fixture();
        std::fs::write(dir.join("needs-auth"), "").unwrap();
        session
            .configure_flavor(Some("cached_token".into()), None, None)
            .unwrap();
        let mut handler = |_: AcpEvent| -> AcpReply { Err((-32601, "unsupported".into())) };
        assert_eq!(
            session
                .open("/tmp", None, &[], Duration::from_secs(5), &mut handler)
                .unwrap(),
            "fresh-id"
        );
        drop(session);
        let calls: Vec<Value> = std::fs::read_to_string(dir.join("calls"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            calls
                .iter()
                .filter(|m| m["method"] == "session/new")
                .count(),
            2
        );
        assert_eq!(
            calls
                .iter()
                .filter(|m| m["method"] == "authenticate")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn new_session_is_reused_and_rejects_unopened_prompt() {
        let (dir, mut session) = fixture();
        let mut handler = |_: AcpEvent| -> AcpReply { Err((-32601, "unsupported".into())) };
        assert!(matches!(
            session.prompt(vec![], Duration::from_secs(2), &mut handler),
            Err(AcpError::Protocol(_))
        ));
        assert_eq!(
            session
                .open("/tmp", None, &[], Duration::from_secs(5), &mut handler)
                .unwrap(),
            "fresh-id"
        );
        assert!(session
            .initialize(Duration::from_secs(5), &mut handler)
            .is_ok());
        drop(session);
        let log = std::fs::read_to_string(dir.join("calls")).unwrap();
        assert_eq!(log.lines().count(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
