//! Shared process ownership for Codex sessions. Individual callers may be
//! cancelled without taking down the process or other turns in the session.
use super::{
    CodexClient, CodexLaunch, CodexShutdown, ProviderClient, ProviderError, ProviderEvent,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc as async_mpsc, oneshot, Mutex as AsyncMutex};

type UsageStates = Arc<Mutex<HashMap<String, Arc<Mutex<super::token_usage::TurnUsage>>>>>;

type EventSender = async_mpsc::UnboundedSender<Result<ProviderEvent, ProviderError>>;
type EventRoutes = Arc<Mutex<HashMap<String, EventSender>>>;
type PendingEvents = Arc<Mutex<VecDeque<(String, ProviderEvent)>>>;
const MAX_PENDING_CHILD_EVENTS: usize = 1024;
type RpcResponse = (Value, Result<Value, (i64, String)>);
struct Call {
    method: String,
    params: Option<Value>,
    timeout: Duration,
    notification: bool,
    response: Option<RpcResponse>,
    reply: oneshot::Sender<Result<Value, ProviderError>>,
}
#[derive(Default)]
struct BackgroundWork {
    items: HashSet<(String, String)>,
    agents: HashSet<String>,
    uncertain: bool,
}
impl BackgroundWork {
    fn observe(&mut self, event: &ProviderEvent) {
        let ProviderEvent::Notification {
            method,
            params: Some(params),
        } = event
        else {
            return;
        };
        if method != "item/started" && method != "item/completed" {
            return;
        }
        let item = &params["item"];
        match item["type"].as_str() {
            Some("commandExecution" | "dynamicToolCall" | "mcpToolCall" | "imageGeneration") => {
                let (Some(turn), Some(id)) = (params["turnId"].as_str(), item["id"].as_str())
                else {
                    self.uncertain = true;
                    return;
                };
                let key = (turn.to_owned(), id.to_owned());
                if method == "item/started" {
                    self.items.insert(key);
                } else {
                    self.items.remove(&key);
                }
            }
            Some("subAgentActivity") => {
                let (Some(id), Some(kind)) =
                    (item["agentThreadId"].as_str(), item["kind"].as_str())
                else {
                    self.uncertain = true;
                    return;
                };
                match kind {
                    "started" => {
                        self.agents.insert(id.to_owned());
                    }
                    "completed" | "interrupted" => {
                        self.agents.remove(id);
                    }
                    _ => {}
                }
            }
            Some("collabAgentToolCall") => {
                if let Some(states) = item["agentsStates"].as_object() {
                    for (id, state) in states {
                        match state["status"].as_str() {
                            Some("running" | "pendingInit") => {
                                self.agents.insert(id.clone());
                            }
                            Some(
                                "interrupted" | "completed" | "errored" | "shutdown" | "notFound",
                            ) => {
                                self.agents.remove(id);
                            }
                            _ => self.uncertain = true,
                        }
                    }
                } else {
                    self.uncertain = true;
                }
            }
            _ => {}
        }
    }
    fn pending(&self) -> bool {
        self.uncertain || !self.items.is_empty() || !self.agents.is_empty()
    }
}
fn launch_fingerprint(options: &CodexLaunch, references: &[(String, String)]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut env: Vec<_> = options.env.iter().collect();
    env.sort_by(|a, b| a.0.cmp(b.0));
    let encoded = serde_json::to_vec(&(
        options
            .binary
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        &options.args,
        options
            .cwd
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        options
            .home
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        env,
        &options.env_remove,
        references,
    ))
    .expect("launch fingerprint serializes");
    Sha256::digest(encoded).into()
}

struct Session {
    instance_id: Option<String>,
    stale: AtomicBool,
    initialized: AsyncMutex<bool>,
    launch_fingerprint: [u8; 32],
    secret_references: Vec<(String, String)>,
    operations: Mutex<(usize, bool)>,
    leases: AtomicUsize,
    closed: Arc<AtomicBool>,
    background: Arc<Mutex<BackgroundWork>>,
    calls: mpsc::Sender<Call>,
    events: AsyncMutex<async_mpsc::UnboundedReceiver<Result<ProviderEvent, ProviderError>>>,
    shutdown: CodexShutdown,
    interrupting: Mutex<HashSet<(String, String)>>,
    quarantined: Arc<Mutex<HashSet<String>>>,
    routes: EventRoutes,
    pending_events: PendingEvents,
    usage: UsageStates,
}
/// A handle to a session owned by the registry. Dropping a handle or an
/// in-flight request does not shut down the shared process.
#[derive(Clone)]
pub struct SessionHandle(Arc<Session>);

struct OperationGuard(Arc<Session>);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.operations.lock() {
            state.0 -= 1;
        }
    }
}
impl SessionHandle {
    /// Initialize each process once, serializing concurrent users of the shared session.
    pub async fn initialize(&self, timeout: Duration) -> Result<(), ProviderError> {
        let mut initialized = self.0.initialized.lock().await;
        if *initialized {
            return Ok(());
        }
        match self.request("initialize", Some(serde_json::json!({"clientInfo":{"name":"T3 Code","title":"T3 Code","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"optOutNotificationMethods":["turn/diff/updated"],"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}}})), timeout).await {
            Ok(_) => self.notify("initialized", None).await?,
            Err(ProviderError::Remote { message, .. }) if message == "Already initialized" => {},
            Err(error) => return Err(error),
        }
        *initialized = true;
        Ok(())
    }
    pub fn turn_usage(&self, thread: &str) -> Arc<Mutex<super::token_usage::TurnUsage>> {
        self.0
            .usage
            .lock()
            .expect("usage lock poisoned")
            .entry(thread.to_owned())
            .or_default()
            .clone()
    }
    fn begin_operation(&self) -> Result<OperationGuard, ProviderError> {
        let mut state = self
            .0
            .operations
            .lock()
            .map_err(|_| ProviderError::Protocol("session operation lock poisoned"))?;
        if state.1 {
            return Err(ProviderError::Closed);
        }
        state.0 += 1;
        Ok(OperationGuard(self.0.clone()))
    }
    /// Requests share one reader and are matched by ID. Cancelling a caller
    /// discards its reply without terminating the shared process.
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, ProviderError> {
        let _operation = self.begin_operation()?;
        let (reply, receiver) = oneshot::channel();
        self.0
            .calls
            .send(Call {
                method: method.into(),
                params,
                timeout,
                notification: false,
                response: None,
                reply,
            })
            .map_err(|_| ProviderError::Closed)?;
        receiver.await.map_err(|_| ProviderError::Closed)?
    }
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), ProviderError> {
        let _operation = self.begin_operation()?;
        let (reply, receiver) = oneshot::channel();
        self.0
            .calls
            .send(Call {
                method: method.into(),
                params,
                timeout: Duration::ZERO,
                notification: true,
                response: None,
                reply,
            })
            .map_err(|_| ProviderError::Closed)?;
        receiver.await.map_err(|_| ProviderError::Closed)??;
        Ok(())
    }
    /// Reply to a server-initiated request delivered by `next_event`.
    pub async fn respond(
        &self,
        id: Value,
        result: Result<Value, (i64, String)>,
    ) -> Result<(), ProviderError> {
        let _operation = self.begin_operation()?;
        let (reply, receiver) = oneshot::channel();
        self.0
            .calls
            .send(Call {
                method: String::new(),
                params: None,
                timeout: Duration::ZERO,
                notification: false,
                response: Some((id, result)),
                reply,
            })
            .map_err(|_| ProviderError::Closed)?;
        receiver.await.map_err(|_| ProviderError::Closed)??;
        Ok(())
    }
    /// Exactly one consumer receives each event, in arrival order.
    pub async fn next_event(&self) -> Result<ProviderEvent, ProviderError> {
        self.0
            .events
            .lock()
            .await
            .recv()
            .await
            .unwrap_or(Err(ProviderError::Closed))
    }
    pub fn take_interrupting(&self, thread: &str, turn: &str) -> bool {
        self.0
            .interrupting
            .lock()
            .map(|mut set| set.remove(&(thread.to_owned(), turn.to_owned())))
            .unwrap_or(false)
    }
    /// Claim the native thread before starting its turn, so early events cannot be lost.
    pub fn subscribe_thread(&self, thread: &str) -> Result<TurnEvents, ProviderError> {
        if self
            .0
            .quarantined
            .lock()
            .map_err(|_| ProviderError::Protocol("session quarantine lock poisoned"))?
            .contains(thread)
        {
            return Err(ProviderError::Protocol("previous turn has not settled"));
        }
        let (sender, receiver) = async_mpsc::unbounded_channel();
        let mut routes = self
            .0
            .routes
            .lock()
            .map_err(|_| ProviderError::Protocol("session route lock poisoned"))?;
        if routes.contains_key(thread) {
            return Err(ProviderError::Protocol(
                "native thread already has a consumer",
            ));
        }
        routes.insert(thread.to_owned(), sender);
        Ok(TurnEvents {
            thread: thread.into(),
            routes: self.0.routes.clone(),
            pending_events: self.0.pending_events.clone(),
            sender: routes.get(thread).unwrap().clone(),
            children: Vec::new(),
            active_children: HashSet::new(),
            usage: self.0.usage.clone(),
            calls: self.0.calls.clone(),
            receiver,
        })
    }
    pub fn is_quarantined(&self, thread: &str) -> bool {
        self.0
            .quarantined
            .lock()
            .map(|pending| pending.contains(thread))
            .unwrap_or(true)
    }
    pub fn same_process(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    /// Block a replacement turn until a cancelled native turn reports completion.
    pub fn quarantine_thread(&self, thread: &str) {
        if let Ok(mut pending) = self.0.quarantined.lock() {
            pending.insert(thread.into());
        }
    }
    pub async fn interrupt(
        &self,
        thread_id: &str,
        turn_id: &str,
        timeout: Duration,
    ) -> Result<Value, ProviderError> {
        self.0
            .interrupting
            .lock()
            .map_err(|_| ProviderError::Protocol("interrupt lock poisoned"))?
            .insert((thread_id.into(), turn_id.into()));
        self.request(
            "turn/interrupt",
            Some(json!({"threadId": thread_id, "turnId": turn_id})),
            timeout,
        )
        .await
    }
    pub async fn steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        input: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, ProviderError> {
        self.request(
            "turn/steer",
            Some(json!({"threadId": thread_id, "expectedTurnId": turn_id, "input": input})),
            timeout,
        )
        .await
        .map_err(|error| match error {
            ProviderError::Remote { ref data, .. }
                if data
                    .as_ref()
                    .and_then(|v| v.get("kind"))
                    .and_then(Value::as_str)
                    == Some("steer_declined") =>
            {
                ProviderError::SteerDeclined
            }
            other => other,
        })
    }
}

/// A thread-specific event stream; dropping it unregisters only this turn.
pub struct TurnEvents {
    thread: String,
    routes: EventRoutes,
    pending_events: PendingEvents,
    sender: EventSender,
    children: Vec<String>,
    active_children: HashSet<String>,
    usage: UsageStates,
    calls: mpsc::Sender<Call>,
    receiver: async_mpsc::UnboundedReceiver<Result<ProviderEvent, ProviderError>>,
}
impl TurnEvents {
    /// Route a discovered native child to this stream, replaying notifications
    /// that arrived before its parent announced it, in their original order.
    pub fn register_child(&mut self, thread: &str) -> Result<(), ProviderError> {
        self.register_child_route(thread, true, false).map(|_| ())
    }
    /// Restore an idle child route if no live supervisor already owns it.
    pub fn restore_child(&mut self, thread: &str) -> Result<bool, ProviderError> {
        self.register_child_route(thread, false, true)
    }
    fn register_child_route(
        &mut self,
        thread: &str,
        active: bool,
        allow_owned: bool,
    ) -> Result<bool, ProviderError> {
        let mut routes = self
            .routes
            .lock()
            .map_err(|_| ProviderError::Protocol("session route lock poisoned"))?;
        if let Some(existing) = routes.get(thread) {
            if existing.same_channel(&self.sender) {
                if active {
                    self.active_children.insert(thread.to_owned());
                }
                return Ok(false);
            }
            if allow_owned {
                return Ok(false);
            }
            return Err(ProviderError::Protocol(
                "native child already has a consumer",
            ));
        }
        let mut pending = self
            .pending_events
            .lock()
            .map_err(|_| ProviderError::Protocol("session pending event lock poisoned"))?;
        routes.insert(thread.to_owned(), self.sender.clone());
        self.children.push(thread.to_owned());
        if active {
            self.active_children.insert(thread.to_owned());
        }
        let mut retained = VecDeque::new();
        while let Some((id, event)) = pending.pop_front() {
            if id == thread {
                let _ = self.sender.send(Ok(event));
            } else {
                retained.push_back((id, event));
            }
        }
        *pending = retained;
        Ok(true)
    }
    /// Release the root route after its turn settles while retaining child routes.
    pub fn detach_parent(&mut self) {
        if let Ok(mut routes) = self.routes.lock() {
            if routes
                .get(&self.thread)
                .is_some_and(|route| route.same_channel(&self.sender))
            {
                routes.remove(&self.thread);
            }
        }
    }
    pub fn child_settled(&mut self, thread: &str) {
        self.active_children.remove(thread);
    }
    pub fn child_started(&mut self, thread: &str) {
        if self.children.iter().any(|child| child == thread) {
            self.active_children.insert(thread.to_owned());
        }
    }
    pub fn has_children(&self) -> bool {
        !self.children.is_empty()
    }
    pub fn has_active_children(&self) -> bool {
        !self.active_children.is_empty()
    }
    pub async fn next_event(&mut self) -> Result<ProviderEvent, ProviderError> {
        self.receiver
            .recv()
            .await
            .unwrap_or(Err(ProviderError::Closed))
    }
}
impl Drop for TurnEvents {
    fn drop(&mut self) {
        if let Ok(mut routes) = self.routes.lock() {
            if routes
                .get(&self.thread)
                .is_some_and(|route| route.same_channel(&self.sender))
            {
                routes.remove(&self.thread);
            }
            for child in &self.children {
                if routes
                    .get(child)
                    .is_some_and(|route| route.same_channel(&self.sender))
                {
                    routes.remove(child);
                }
            }
            let reject = |id| {
                let (reply, _) = oneshot::channel();
                let _ = self.calls.send(Call {
                    method: String::new(),
                    params: None,
                    timeout: Duration::ZERO,
                    notification: false,
                    response: Some((id, Err((-32603, "Unable to route provider request".into())))),
                    reply,
                });
            };
            if routes.is_empty() {
                if let Ok(mut pending) = self.pending_events.lock() {
                    for (_, event) in pending.drain(..) {
                        if let ProviderEvent::Request { id, .. } = event {
                            reject(id);
                        }
                    }
                }
            }
            // Preserve queued usage and reject requests that no supervisor will process.
            while let Ok(event) = self.receiver.try_recv() {
                match event {
                    Ok(ProviderEvent::Request { id, .. }) => reject(id),
                    Ok(ProviderEvent::Notification {
                        method,
                        params: Some(params),
                    }) if method == "thread/tokenUsage/updated" => {
                        if let Ok(mut states) = self.usage.lock() {
                            let thread = params["threadId"].as_str().unwrap_or(&self.thread);
                            if let Ok(mut usage) =
                                states.entry(thread.to_owned()).or_default().lock()
                            {
                                usage.observe_baseline(&params["tokenUsage"]);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Prevents a shared process from being retired while a turn is starting or active.
pub struct TurnLease(Arc<Session>);
impl Drop for TurnLease {
    fn drop(&mut self) {
        self.0.leases.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Outcome of an atomic idle-only session removal.
pub enum IdleRemoval {
    Absent,
    Busy,
    Removed(mpsc::Receiver<Result<(), ProviderError>>),
}

/// Owns one process per caller-defined provider session key. Opening an existing
/// key returns the existing process. Removing a key terminates its process group.
#[derive(Default)]
pub struct SessionRegistry {
    pub secrets: super::secret_store::SecretStore,
    /// Serializes vault reads, cache updates, and process creation.
    pub secret_refresh: Arc<tokio::sync::Mutex<()>>,
    secret_provider_configs: Mutex<Option<Value>>,
    pub discovery_settings: Mutex<Option<Value>>,
    pub(crate) last_provider_refresh: Mutex<HashMap<String, std::time::Instant>>,
    pub(crate) kiro_defaults: Mutex<HashMap<String, String>>,
    pub(crate) desktop_shell_env: Mutex<HashMap<String, Option<String>>>,
    pub(crate) desktop_instance_shell_env: Mutex<HashMap<String, HashMap<String, Option<String>>>>,
    pub(crate) kiro_ready: Mutex<HashSet<String>>,
    pub(crate) kiro_deferred: Mutex<HashSet<String>>,
    pub mcp_credentials: crate::mcp_credentials::Registry,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    mcp_configs: Mutex<HashMap<String, (String, String, bool)>>,
}
pub fn read_provider_settings(path: Option<&std::path::Path>) -> Result<Value, String> {
    let mut settings = match path.map(std::fs::read) {
        None => Ok::<Value, String>(Value::Null),
        Some(Ok(bytes)) => {
            crate::lenient_json::parse(&bytes).map_err(|_| "Invalid provider settings".into())
        }
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Some(Err(_)) => Err("Could not read provider settings".into()),
    }?;
    crate::managed_policy::apply_provider_ceiling(&mut settings)?;
    Ok(settings)
}

/// Only provider kind and configuration affect resolved secret values.
pub(crate) fn secret_provider_changed(old: Option<&Value>, new: Option<&Value>) -> bool {
    let config = |entry: Option<&Value>| {
        entry.map(|entry| (entry.get("kind").cloned(), entry.get("config").cloned()))
    };
    config(old) != config(new)
}

impl SessionRegistry {
    pub(crate) fn capture_changed_desktop_instance_environments(&self, old: &Value, new: &Value) {
        let Ok(current) = self.desktop_shell_env.lock() else {
            return;
        };
        let Ok(mut captured) = self.desktop_instance_shell_env.lock() else {
            return;
        };
        captured.retain(|id, _| new.get(id).is_some());
        if let Some(instances) = new.as_object() {
            for (id, entry) in instances {
                if old.get(id) == Some(entry) {
                    continue;
                }
                if entry["environment"]
                    .as_array()
                    .is_some_and(|values| !values.is_empty())
                {
                    captured.insert(id.clone(), current.clone());
                } else {
                    captured.remove(id);
                }
            }
        }
    }
    /// Caller holds secret_refresh. Reconcile even when the settings file changed externally.
    pub fn reconcile_secret_providers(self: &Arc<Self>, settings: &Value) -> Result<(), String> {
        let current = settings
            .get("secretProviders")
            .cloned()
            .unwrap_or(Value::Null);
        let mut previous = self
            .secret_provider_configs
            .lock()
            .map_err(|_| "Secret configuration lock poisoned")?;
        if let Some(old) = previous.as_ref() {
            let mut ids = std::collections::HashSet::new();
            if let Some(map) = old.as_object() {
                ids.extend(map.keys().cloned());
            }
            if let Some(map) = current.as_object() {
                ids.extend(map.keys().cloned());
            }
            for id in ids {
                if secret_provider_changed(old.get(&id), current.get(&id)) {
                    self.secrets.remove_provider(&id)?;
                    self.invalidate_provider(&id).map_err(|e| e.to_string())?;
                }
            }
        }
        *previous = Some(current);
        Ok(())
    }

    /// Caller holds secret_refresh across hydration and process creation or probing.
    pub async fn hydrate_secrets(
        self: &Arc<Self>,
        settings: &Value,
        instance: Option<&str>,
    ) -> Result<(), String> {
        self.reconcile_secret_providers(settings)?;
        let Some(instances) = settings.get("providerInstances").and_then(Value::as_object) else {
            return Ok(());
        };
        let mut missing = std::collections::HashSet::new();
        for (id, entry) in instances {
            if instance.is_some_and(|wanted| wanted != id)
                || entry["enabled"] == false
                || entry["driver"] != "codex"
            {
                continue;
            }
            if let Some(vars) = entry["environment"].as_array() {
                for reference in vars.iter().filter_map(|v| v.get("secret")) {
                    let provider = reference["provider"]
                        .as_str()
                        .ok_or("Invalid secret reference")?;
                    let path = reference["reference"]
                        .as_str()
                        .ok_or("Invalid secret reference")?;
                    if self.secrets.get(provider, path)?.is_none() {
                        missing.insert((provider.to_owned(), path.to_owned()));
                    }
                }
            }
        }
        // Limit subprocess concurrency and the whole batch to one read timeout. Dropping
        // unfinished futures kills their child processes via resolve_reference's kill_on_drop.
        use futures_util::{stream, StreamExt};
        let reads = stream::iter(missing.into_iter().map(|(provider, path)| async move {
            let reference = serde_json::json!({"provider":provider, "reference":path});
            let value = crate::mcp_secret::resolve_reference(settings, &reference).await;
            (provider, path, value)
        }))
        .buffer_unordered(8);
        futures_util::pin_mut!(reads);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(45);
        while let Ok(Some((provider, path, value))) =
            tokio::time::timeout_at(deadline, reads.next()).await
        {
            if let Some(value) = value {
                self.secrets.apply(&provider, &path, value)?;
            }
        }
        Ok(())
    }
    /// Retain the provider's configuration while the registry stores only a token hash.
    /// A revoked or changed credential is replaced before the next turn.
    pub fn prepare_mcp(
        &self,
        thread_id: &str,
        instance_id: &str,
        subagent: bool,
    ) -> Result<String, String> {
        let mut configs = self
            .mcp_configs
            .lock()
            .map_err(|_| "MCP configuration lock poisoned")?;
        if let Some((token, instance, child)) = configs.get(thread_id) {
            if instance == instance_id
                && *child == subagent
                && self.mcp_credentials.resolve(token).is_some()
            {
                self.mcp_credentials.touch(thread_id);
                return Ok(format!("Bearer {token}"));
            }
        }
        self.mcp_credentials.revoke_thread(thread_id);
        let capabilities = ["orchestration", "worktree", "pull-requests"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let issued = self
            .mcp_credentials
            .issue(thread_id, instance_id, capabilities, subagent)
            .map_err(|e| e.to_string())?;
        let authorization = format!("Bearer {}", issued.token);
        configs.insert(
            thread_id.into(),
            (issued.token, instance_id.into(), subagent),
        );
        Ok(authorization)
    }
    pub fn open(&self, key: &str, options: CodexLaunch) -> Result<SessionHandle, ProviderError> {
        self.open_with_references(key, options, Vec::new())
    }
    pub fn open_with_references(
        &self,
        key: &str,
        options: CodexLaunch,
        references: Vec<(String, String)>,
    ) -> Result<SessionHandle, ProviderError> {
        self.open_for_instance(key, options, references, None)
    }
    pub fn open_for_instance(
        &self,
        key: &str,
        options: CodexLaunch,
        references: Vec<(String, String)>,
        instance_id: Option<&str>,
    ) -> Result<SessionHandle, ProviderError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        if let Some(session) = sessions.get(key) {
            if !session.closed.load(Ordering::Acquire) {
                if instance_id.is_some() && session.instance_id.as_deref() != instance_id {
                    return Err(ProviderError::Protocol(
                        "provider session instance mismatch",
                    ));
                }
                if session.stale.load(Ordering::Acquire) {
                    return Err(ProviderError::Protocol("provider session is refreshing"));
                }
                return Ok(SessionHandle(session.clone()));
            }
        }
        sessions.remove(key);
        let launch_fingerprint = launch_fingerprint(&options, &references);
        let mut client = CodexClient::spawn(options)?;
        let shutdown = client.shutdown_handle();
        let (calls, incoming) = mpsc::channel::<Call>();
        let (outgoing, events) = async_mpsc::unbounded_channel();
        let routes = Arc::new(Mutex::new(HashMap::<
            String,
            async_mpsc::UnboundedSender<Result<ProviderEvent, ProviderError>>,
        >::new()));
        let event_routes = routes.clone();
        let pending_events: PendingEvents = Arc::new(Mutex::new(VecDeque::new()));
        let observed_pending = pending_events.clone();
        let usage: UsageStates = Arc::new(Mutex::new(HashMap::new()));
        let observed_usage = usage.clone();
        let quarantined = Arc::new(Mutex::new(HashSet::<String>::new()));
        let event_quarantined = quarantined.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = closed.clone();
        let background = Arc::new(Mutex::new(BackgroundWork::default()));
        let observed_background = background.clone();
        std::thread::spawn(move || {
            let mut pending: HashMap<
                u64,
                (Instant, oneshot::Sender<Result<Value, ProviderError>>),
            > = HashMap::new();
            loop {
                while let Ok(call) = incoming.try_recv() {
                    // A cancelled queued call must not perform a surprise mutation.
                    if call.reply.is_closed() && call.response.is_none() {
                        continue;
                    }
                    if let Some((id, response)) = call.response {
                        let result = client.respond(id, response).map(|_| Value::Null);
                        let _ = call.reply.send(result);
                    } else if call.notification {
                        let result = client
                            .notify(&call.method, call.params)
                            .map(|_| Value::Null);
                        let _ = call.reply.send(result);
                    } else if let Some(deadline) = Instant::now().checked_add(call.timeout) {
                        match client.start_request(&call.method, call.params) {
                            Ok(id) => {
                                pending.insert(id, (deadline, call.reply));
                            }
                            Err(error) => {
                                let _ = call.reply.send(Err(error));
                            }
                        }
                    } else {
                        let _ = call.reply.send(Err(ProviderError::Timeout));
                    }
                }
                let now = Instant::now();
                let expired: Vec<_> = pending
                    .iter()
                    .filter_map(|(id, (deadline, reply))| {
                        (reply.is_closed() || *deadline <= now).then_some(*id)
                    })
                    .collect();
                for id in expired {
                    if let Some((_, reply)) = pending.remove(&id) {
                        let _ = reply.send(Err(ProviderError::Timeout));
                    }
                }
                match client.receive(Duration::from_millis(10)) {
                    Ok(frame) => match CodexClient::event(&frame) {
                        Ok(Some(event)) => {
                            if let Ok(mut work) = observed_background.lock() {
                                work.observe(&event);
                            }
                            let thread_id = match &event {
                                ProviderEvent::Notification { params, .. }
                                | ProviderEvent::Request { params, .. } => params
                                    .as_ref()
                                    .and_then(|p| {
                                        p.get("threadId").or_else(|| p.get("conversationId"))
                                    })
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            };
                            if let Some(thread) = &thread_id {
                                if let Ok(mut pending) = event_quarantined.lock() {
                                    if pending.contains(thread) {
                                        if let ProviderEvent::Request { id, .. } = &event {
                                            let _ = client.respond(
                                                id.clone(),
                                                Err((-32603, "Turn has been cancelled".into())),
                                            );
                                        }
                                        if matches!(&event, ProviderEvent::Notification { method, .. } if method == "turn/completed")
                                        {
                                            pending.remove(thread);
                                        }
                                        continue;
                                    }
                                }
                            }
                            let routes = match event_routes.lock() {
                                Ok(routes) => routes,
                                Err(_) => break,
                            };
                            if let Some(route) = thread_id.as_ref().and_then(|id| routes.get(id)) {
                                let _ = route.send(Ok(event));
                            } else if thread_id.is_none()
                                && matches!(event, ProviderEvent::Request { .. })
                                && routes.len() == 1
                            {
                                let _ = routes.values().next().unwrap().send(Ok(event));
                            } else if let Some(thread) =
                                thread_id.as_ref().filter(|_| !routes.is_empty())
                            {
                                if let Ok(mut pending) = observed_pending.lock() {
                                    if pending.len() == MAX_PENDING_CHILD_EVENTS {
                                        if let Some((_, ProviderEvent::Request { id, .. })) =
                                            pending.pop_front()
                                        {
                                            let _ = client.respond(
                                                id,
                                                Err((
                                                    -32603,
                                                    "Provider request buffer is full".into(),
                                                )),
                                            );
                                        }
                                    }
                                    pending.push_back((thread.clone(), event));
                                }
                            } else if matches!(event, ProviderEvent::Request { .. })
                                && !routes.is_empty()
                            {
                                if let ProviderEvent::Request { id, .. } = &event {
                                    let _ = client.respond(
                                        id.clone(),
                                        Err((-32603, "Unable to route provider request".into())),
                                    );
                                }
                            } else {
                                if let ProviderEvent::Notification {
                                    method,
                                    params: Some(params),
                                } = &event
                                {
                                    if method == "thread/tokenUsage/updated" {
                                        if let Some(thread) = params["threadId"].as_str() {
                                            if let Ok(mut states) = observed_usage.lock() {
                                                if let Ok(mut usage) = states
                                                    .entry(thread.to_owned())
                                                    .or_default()
                                                    .lock()
                                                {
                                                    usage.observe_baseline(&params["tokenUsage"]);
                                                }
                                            }
                                        }
                                    }
                                }
                                let _ = outgoing.send(Ok(event));
                            }
                        }
                        Ok(None) => {
                            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                                if let Some((_, reply)) = pending.remove(&id) {
                                    let _ = reply.send(CodexClient::response(&frame));
                                }
                            }
                        }
                        Err(error) => {
                            reader_closed.store(true, Ordering::Release);
                            if let Ok(routes) = event_routes.lock() {
                                for route in routes.values() {
                                    let _ = route.send(Err(ProviderError::Closed));
                                }
                            }
                            let _ = outgoing.send(Err(error));
                            break;
                        }
                    },
                    Err(ProviderError::Timeout) => {}
                    Err(error) => {
                        reader_closed.store(true, Ordering::Release);
                        if let Ok(routes) = event_routes.lock() {
                            for route in routes.values() {
                                let _ = route.send(Err(ProviderError::Closed));
                            }
                        }
                        let _ = outgoing.send(Err(error));
                        break;
                    }
                }
            }
            reader_closed.store(true, Ordering::Release);
        });
        let session = Arc::new(Session {
            instance_id: instance_id.map(str::to_owned),
            stale: AtomicBool::new(false),
            initialized: AsyncMutex::new(false),
            launch_fingerprint,
            secret_references: references,
            operations: Mutex::new((0, false)),
            leases: AtomicUsize::new(0),
            closed,
            background,
            calls,
            events: AsyncMutex::new(events),
            shutdown,
            interrupting: Mutex::new(HashSet::new()),
            routes,
            pending_events,
            usage,
            quarantined,
        });
        sessions.insert(key.into(), session.clone());
        Ok(SessionHandle(session))
    }
    pub fn get(&self, key: &str) -> Result<Option<SessionHandle>, ProviderError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        Ok(sessions
            .get(key)
            .filter(|session| !session.closed.load(Ordering::Acquire))
            .cloned()
            .map(SessionHandle))
    }
    /// Atomically claim the currently registered process against idle retirement.
    pub fn claim_turn(
        &self,
        key: &str,
        handle: &SessionHandle,
    ) -> Result<Option<TurnLease>, ProviderError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        if !sessions.get(key).is_some_and(|s| {
            Arc::ptr_eq(s, &handle.0)
                && !s.closed.load(Ordering::Acquire)
                && !s.stale.load(Ordering::Acquire)
        }) {
            return Ok(None);
        }
        handle.0.leases.fetch_add(1, Ordering::AcqRel);
        Ok(Some(TurnLease(handle.0.clone())))
    }
    /// Retire an existing process when its effective launch configuration changed.
    pub fn invalidate_mismatched_launch(
        self: &Arc<Self>,
        key: &str,
        launch: &CodexLaunch,
        references: &[(String, String)],
    ) -> Result<(), ProviderError> {
        let mismatch = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
            sessions.get(key).is_some_and(|s| {
                !s.closed.load(Ordering::Acquire)
                    && s.launch_fingerprint != launch_fingerprint(launch, references)
            })
        };
        if mismatch {
            self.invalidate_when_idle(key)?;
        }
        Ok(())
    }
    /// Prevent new turns on this exact process and retire it after existing work ends.
    /// The caller must identify affected session keys; values never enter this registry.
    pub fn invalidate_when_idle(self: &Arc<Self>, key: &str) -> Result<bool, ProviderError> {
        let session = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
            let Some(session) = sessions.get(key).cloned() else {
                return Ok(false);
            };
            if session.stale.swap(true, Ordering::AcqRel) {
                return Ok(true);
            }
            session
        };
        self.retire_marked(key.to_owned(), session);
        Ok(true)
    }
    pub fn invalidate_provider(self: &Arc<Self>, provider: &str) -> Result<(), ProviderError> {
        let references = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
            sessions
                .values()
                .flat_map(|s| s.secret_references.iter())
                .filter(|(p, _)| p == provider)
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        };
        for (provider, reference) in references {
            self.invalidate_reference(&provider, &reference)?;
        }
        Ok(())
    }
    /// Mark every process using a reference while holding the registry lock.
    pub fn invalidate_reference(
        self: &Arc<Self>,
        provider: &str,
        reference: &str,
    ) -> Result<usize, ProviderError> {
        let marked = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
            sessions
                .iter()
                .filter_map(|(key, session)| {
                    if session
                        .secret_references
                        .iter()
                        .any(|(p, r)| p == provider && r == reference)
                        && !session.stale.swap(true, Ordering::AcqRel)
                    {
                        Some((key.clone(), session.clone()))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        };
        let count = marked.len();
        for (key, session) in marked {
            self.retire_marked(key, session);
        }
        Ok(count)
    }
    fn retire_marked(self: &Arc<Self>, key: String, session: Arc<Session>) {
        let registry = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let current = match registry.get(&key) {
                Ok(Some(handle)) => handle,
                _ => break,
            };
            if !Arc::ptr_eq(&current.0, &session) {
                break;
            }
            match registry.begin_remove_exact_if_idle(&key, Some(&session)) {
                Ok(IdleRemoval::Removed(_)) | Ok(IdleRemoval::Absent) | Err(_) => break,
                Ok(IdleRemoval::Busy) => {}
            }
            drop(registry);
            std::thread::sleep(Duration::from_millis(100));
        });
    }
    /// Remove this exact process only when no turn is starting or active.
    pub fn retire_if_idle(&self, key: &str, handle: &SessionHandle) -> Result<bool, ProviderError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        if !sessions
            .get(key)
            .is_some_and(|s| Arc::ptr_eq(s, &handle.0) && s.leases.load(Ordering::Acquire) == 0)
        {
            return Ok(false);
        }
        let session = sessions.get(key).unwrap();
        let mut operations = session
            .operations
            .lock()
            .map_err(|_| ProviderError::Protocol("session operation lock poisoned"))?;
        if operations.0 != 0 {
            return Ok(false);
        }
        operations.1 = true;
        drop(operations);
        let session = sessions.remove(key).unwrap();
        std::thread::spawn(move || {
            let _ = session.shutdown.shutdown();
        });
        Ok(true)
    }
    /// Missing sessions have no process to detach. A poisoned tracker is an error,
    /// so callers can conservatively refuse to detach when state is uncertain.
    pub fn has_pending_background_work(&self, key: &str) -> Result<bool, ProviderError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        let Some(session) = sessions.get(key) else {
            return Ok(false);
        };
        let work = session
            .background
            .lock()
            .map_err(|_| ProviderError::Protocol("background work lock poisoned"))?;
        Ok(work.pending())
    }
    /// Begin shutdown only when no known background work, turn or RPC is active.
    /// The registry, background tracker and operation state are checked together;
    /// a poisoned lock fails closed rather than removing the process.
    pub fn begin_remove_if_idle(&self, key: &str) -> Result<IdleRemoval, ProviderError> {
        self.begin_remove_exact_if_idle(key, None)
    }

    fn begin_remove_exact_if_idle(
        &self,
        key: &str,
        expected: Option<&Arc<Session>>,
    ) -> Result<IdleRemoval, ProviderError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        let Some(session) = sessions.get(key).cloned() else {
            return Ok(IdleRemoval::Absent);
        };
        if expected.is_some_and(|expected| !Arc::ptr_eq(expected, &session)) {
            return Ok(IdleRemoval::Absent);
        }
        let background = session
            .background
            .lock()
            .map_err(|_| ProviderError::Protocol("background work lock poisoned"))?;
        let mut operations = session
            .operations
            .lock()
            .map_err(|_| ProviderError::Protocol("session operation lock poisoned"))?;
        if background.pending() || operations.0 != 0 || session.leases.load(Ordering::Acquire) != 0
        {
            return Ok(IdleRemoval::Busy);
        }
        operations.1 = true;
        sessions.remove(key);
        let (send, receive) = mpsc::channel();
        let closing = session.clone();
        std::thread::spawn(move || {
            let _ = send.send(closing.shutdown.shutdown());
        });
        drop(operations);
        drop(background);
        Ok(IdleRemoval::Removed(receive))
    }

    /// Remove the entry while holding the caller's lock and begin shutdown immediately.
    pub fn begin_remove(
        &self,
        key: &str,
    ) -> Result<Option<mpsc::Receiver<Result<(), ProviderError>>>, ProviderError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?
            .remove(key);
        Ok(session.map(|session| {
            let (send, receive) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = send.send(session.shutdown.shutdown());
            });
            receive
        }))
    }
    /// Remove the registry entry immediately and wait at most `timeout` for shutdown.
    /// On timeout the detached shutdown task continues to reap the process.
    pub async fn remove_wait(&self, key: &str, timeout: Duration) -> Result<bool, ProviderError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?
            .remove(key);
        let Some(session) = session else {
            return Ok(false);
        };
        let task = tokio::task::spawn_blocking(move || session.shutdown.shutdown());
        tokio::time::timeout(timeout, task)
            .await
            .map_err(|_| ProviderError::Timeout)?
            .map_err(|_| ProviderError::Protocol("session shutdown task failed"))??;
        Ok(true)
    }
    /// Caller holds secret_refresh to prevent a matching process from opening.
    pub async fn remove_instance_wait(&self, instance: &str) -> Result<(), ProviderError> {
        let keys = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?
            .iter()
            .filter(|(_, session)| session.instance_id.as_deref() == Some(instance))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            self.remove_for_auth(&key).await?;
        }
        Ok(())
    }
    pub async fn remove_for_auth(&self, key: &str) -> Result<(), ProviderError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?
            .get(key)
            .cloned();
        let Some(session) = session else {
            return Ok(());
        };
        session.stale.store(true, Ordering::Release);
        let shutdown = session.clone();
        tokio::task::spawn_blocking(move || shutdown.shutdown.shutdown())
            .await
            .map_err(|_| ProviderError::Protocol("session shutdown task failed"))??;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?;
        if sessions
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            sessions.remove(key);
        }
        Ok(())
    }
    pub fn remove(&self, key: &str) -> Result<bool, ProviderError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| ProviderError::Protocol("session registry lock poisoned"))?
            .remove(key);
        if let Some(session) = session {
            std::thread::spawn(move || {
                let _ = session.shutdown.shutdown();
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
impl Drop for SessionRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, session) in sessions.drain() {
                std::thread::spawn(move || {
                    let _ = session.shutdown.shutdown();
                });
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn child_registration_replays_early_events_and_isolates_routes() {
        let (sender, receiver) = async_mpsc::unbounded_channel();
        let (other, _other_receiver) = async_mpsc::unbounded_channel();
        let routes = Arc::new(Mutex::new(HashMap::from([
            ("parent".to_owned(), sender.clone()),
            ("other".to_owned(), other.clone()),
        ])));
        let notification = |number| ProviderEvent::Notification {
            method: "item/started".into(),
            params: Some(json!({"threadId":"child", "number":number})),
        };
        let pending = Arc::new(Mutex::new(VecDeque::from([
            ("child".to_owned(), notification(1)),
            ("unrelated".to_owned(), notification(9)),
            ("child".to_owned(), notification(2)),
        ])));
        let mut stream = TurnEvents {
            thread: "parent".into(),
            routes: routes.clone(),
            pending_events: pending.clone(),
            sender,
            children: Vec::new(),
            active_children: HashSet::new(),
            usage: Arc::new(Mutex::new(HashMap::new())),
            calls: mpsc::channel().0,
            receiver,
        };
        assert!(stream.register_child("other").is_err());
        assert!(!stream.restore_child("other").unwrap());
        assert!(routes.lock().unwrap()["other"].same_channel(&other));
        stream.register_child("child").unwrap();
        stream.register_child("child").unwrap();
        for number in [1, 2] {
            assert!(
                matches!(stream.next_event().await.unwrap(), ProviderEvent::Notification { params: Some(p), .. } if p["number"] == number)
            );
        }
        assert_eq!(pending.lock().unwrap().len(), 1);
        assert!(routes.lock().unwrap().contains_key("child"));
        assert!(stream.has_active_children());
        stream.detach_parent();
        let (replacement, _receiver) = async_mpsc::unbounded_channel();
        routes.lock().unwrap().insert("parent".into(), replacement);
        stream.child_settled("child");
        assert!(!stream.has_active_children());
        drop(stream);
        let routes = routes.lock().unwrap();
        assert!(routes.contains_key("parent"));
        assert!(!routes.contains_key("child"));
        assert!(routes.contains_key("other"));
    }
    #[test]
    fn background_work_tracks_late_items_and_subagents() {
        let mut work = BackgroundWork::default();
        let event = |method: &str, item: Value| ProviderEvent::Notification {
            method: method.into(),
            params: Some(json!({"turnId":"turn", "item":item})),
        };
        work.observe(&event(
            "item/started",
            json!({"type":"commandExecution","id":"cmd"}),
        ));
        work.observe(&event(
            "item/started",
            json!({"type":"mcpToolCall","id":"tool"}),
        ));
        work.observe(&event(
            "item/completed",
            json!({"type":"commandExecution","id":"cmd"}),
        ));
        assert!(work.pending());
        work.observe(&event(
            "item/completed",
            json!({"type":"mcpToolCall","id":"tool"}),
        ));
        assert!(!work.pending());
        work.observe(&event(
            "item/completed",
            json!({"type":"collabAgentToolCall","agentsStates":{"child":{"status":"running"}}}),
        ));
        assert!(work.pending());
        work.observe(&event(
            "item/completed",
            json!({"type":"subAgentActivity","agentThreadId":"child","kind":"completed"}),
        ));
        assert!(!work.pending());
        work.observe(&event("item/started", json!({"type":"commandExecution"})));
        assert!(
            work.pending(),
            "malformed lifecycle events must fail closed"
        );
        assert!(!SessionRegistry::default()
            .has_pending_background_work("missing")
            .unwrap());
    }
    #[test]
    fn mcp_configuration_reuses_and_rotates_credentials() {
        let registry = SessionRegistry::default();
        let first = registry.prepare_mcp("t", "codex", false).unwrap();
        let token = first.strip_prefix("Bearer ").unwrap();
        let scope = registry.mcp_credentials.resolve(token).unwrap();
        assert_eq!(scope.thread_id, "t");
        assert!(scope.capabilities.contains("orchestration"));
        assert_eq!(registry.prepare_mcp("t", "codex", false).unwrap(), first);
        registry.mcp_credentials.revoke_thread("t");
        let next = registry.prepare_mcp("t", "codex", false).unwrap();
        assert_ne!(next, first);
        assert!(registry.mcp_credentials.resolve(token).is_none());
        let child = registry.prepare_mcp("t", "codex", true).unwrap();
        assert_ne!(child, next);
        assert!(
            registry
                .mcp_credentials
                .resolve(child.strip_prefix("Bearer ").unwrap())
                .unwrap()
                .subagent
        );
    }
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn idle_only_removal_checks_background_turns_and_requests_atomically() {
        let path = std::env::temp_dir().join(format!("codex-idle-remove-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path,r##"#!/usr/bin/env python3
import sys,json
slow=None
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='slow': slow=m['id']; continue
 if method in ('background/start','background/end'):
  state='started' if method.endswith('start') else 'completed'
  print(json.dumps({'method':'item/'+state,'params':{'threadId':'native','turnId':'turn','item':{'id':'tool','type':'commandExecution'}}}),flush=True)
 if method=='release' and slow is not None:
  print(json.dumps({'id':slow,'result':{}}),flush=True)
 print(json.dumps({'id':m['id'],'result':{}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        assert!(matches!(
            registry.begin_remove_if_idle("missing").unwrap(),
            IdleRemoval::Absent
        ));
        let session = registry
            .open(
                "shared",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let lease = registry.claim_turn("shared", &session).unwrap().unwrap();
        assert!(matches!(
            registry.begin_remove_if_idle("shared").unwrap(),
            IdleRemoval::Busy
        ));
        drop(lease);
        session
            .request("background/start", None, Duration::from_secs(2))
            .await
            .unwrap();
        assert!(matches!(
            registry.begin_remove_if_idle("shared").unwrap(),
            IdleRemoval::Busy
        ));
        session
            .request("background/end", None, Duration::from_secs(2))
            .await
            .unwrap();
        let slow = tokio::spawn({
            let s = session.clone();
            async move { s.request("slow", None, Duration::from_secs(2)).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while session.0.operations.lock().unwrap().0 == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            registry.begin_remove_if_idle("shared").unwrap(),
            IdleRemoval::Busy
        ));
        session
            .request("release", None, Duration::from_secs(2))
            .await
            .unwrap();
        slow.await.unwrap().unwrap();
        let receiver = match registry.begin_remove_if_idle("shared").unwrap() {
            IdleRemoval::Removed(receiver) => receiver,
            _ => panic!("idle session was not removed"),
        };
        assert!(registry.get("shared").unwrap().is_none());
        assert!(matches!(
            session.request("late", None, Duration::from_secs(1)).await,
            Err(ProviderError::Closed)
        ));
        tokio::task::spawn_blocking(move || {
            receiver
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap()
        })
        .await
        .unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn shared_session_initializes_only_once_under_concurrency() {
        let path = std::env::temp_dir().join(format!("codex-init-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r##"#!/usr/bin/env python3
import sys,json
count=0
for line in sys.stdin:
 m=json.loads(line)
 if m['method']=='initialized': continue
 if m['method']=='initialize': count+=1
 print(json.dumps({'id':m['id'],'result':count}),flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let session = registry
            .open(
                "shared",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let (a, b) = tokio::join!(
            session.initialize(Duration::from_secs(2)),
            session.initialize(Duration::from_secs(2))
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(
            session
                .request("count", None, Duration::from_secs(2))
                .await
                .unwrap(),
            json!(1)
        );
        registry.begin_remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn idle_retirement_preserves_sibling_lease_and_allows_reopen() {
        let path = std::env::temp_dir().join(format!("codex-retire-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 print(json.dumps({'id':m['id'],'result':'alive'}),flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let launch = || CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        };
        let session = registry.open("shared", launch()).unwrap();
        let cancelled = registry.claim_turn("shared", &session).unwrap().unwrap();
        let sibling = registry.claim_turn("shared", &session).unwrap().unwrap();
        session.quarantine_thread("native-a");
        drop(cancelled);
        assert!(!registry.retire_if_idle("shared", &session).unwrap());
        assert_eq!(
            session
                .request("ping", None, Duration::from_secs(2))
                .await
                .unwrap(),
            json!("alive")
        );
        drop(sibling);
        assert!(registry.retire_if_idle("shared", &session).unwrap());
        assert!(registry.claim_turn("shared", &session).unwrap().is_none());
        let fresh = registry.open("shared", launch()).unwrap();
        assert!(fresh.subscribe_thread("native-a").is_ok());
        let done = registry.begin_remove("shared").unwrap().unwrap();
        tokio::task::spawn_blocking(move || {
            done.recv_timeout(Duration::from_secs(3)).unwrap().unwrap()
        })
        .await
        .unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn invalidation_waits_for_active_lease_and_rejects_new_turns() {
        let path = std::env::temp_dir().join(format!("codex-invalidate-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = Arc::new(SessionRegistry::default());
        let launch = || CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        };
        let session = registry.open("shared", launch()).unwrap();
        let lease = registry.claim_turn("shared", &session).unwrap().unwrap();
        assert!(registry.invalidate_when_idle("shared").unwrap());
        assert!(registry.claim_turn("shared", &session).unwrap().is_none());
        assert!(registry.open("shared", launch()).is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(registry.get("shared").unwrap().is_some());
        drop(lease);
        tokio::time::timeout(Duration::from_secs(3), async {
            while registry.get("shared").unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let replacement = registry.open("shared", launch()).unwrap();
        assert!(registry
            .claim_turn("shared", &replacement)
            .unwrap()
            .is_some());
        registry.remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn changed_launch_retires_session_after_active_lease() {
        let registry = Arc::new(SessionRegistry::default());
        let path =
            std::env::temp_dir().join(format!("codex-launch-change-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launch = |value: &str| CodexLaunch {
            binary: Some(path.clone()),
            env: [("TOKEN".to_owned(), value.to_owned())].into(),
            ..Default::default()
        };
        let refs = vec![("vault".into(), "op://v/i/f".into())];
        let session = registry
            .open_with_references("session", launch("old"), refs.clone())
            .unwrap();
        let lease = registry.claim_turn("session", &session).unwrap().unwrap();
        registry
            .invalidate_mismatched_launch("session", &launch("old"), &refs)
            .unwrap();
        assert!(registry.claim_turn("session", &session).unwrap().is_some());
        registry
            .invalidate_mismatched_launch("session", &launch("new"), &refs)
            .unwrap();
        assert!(registry.claim_turn("session", &session).unwrap().is_none());
        drop(lease);
        registry.remove("session").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn provider_label_change_keeps_cached_secret_and_session() {
        let registry = Arc::new(SessionRegistry::default());
        let old = json!({"secretProviders":{"vault":{"kind":"one_password","label":"Old","config":{"account":"my"}}}});
        let renamed = json!({"secretProviders":{"vault":{"kind":"one_password","label":"New","config":{"account":"my"}}}});
        let _refresh = registry.secret_refresh.lock().await;
        registry.reconcile_secret_providers(&old).unwrap();
        registry
            .secrets
            .apply("vault", "op://v/i/f", "value".into())
            .unwrap();
        let path = std::env::temp_dir().join(format!("codex-rename-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let session = registry
            .open_with_references(
                "session",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
                vec![("vault".into(), "op://v/i/f".into())],
            )
            .unwrap();
        registry.reconcile_secret_providers(&renamed).unwrap();
        assert_eq!(
            registry
                .secrets
                .get("vault", "op://v/i/f")
                .unwrap()
                .as_deref(),
            Some("value")
        );
        assert!(registry.claim_turn("session", &session).unwrap().is_some());
        registry.remove("session").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn external_provider_changes_clear_cache_and_retire_dependent_sessions() {
        let registry = Arc::new(SessionRegistry::default());
        let old =
            json!({"secretProviders":{"vault":{"kind":"one_password","config":{"account":"old"}}}});
        let new =
            json!({"secretProviders":{"vault":{"kind":"one_password","config":{"account":"new"}}}});
        let _refresh = registry.secret_refresh.lock().await;
        registry.reconcile_secret_providers(&old).unwrap();
        registry
            .secrets
            .apply("vault", "op://v/i/f", "old-value".into())
            .unwrap();
        let path = std::env::temp_dir().join(format!("codex-reconcile-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let session = registry
            .open_with_references(
                "affected",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
                vec![("vault".into(), "op://v/i/f".into())],
            )
            .unwrap();
        let lease = registry.claim_turn("affected", &session).unwrap().unwrap();
        registry.reconcile_secret_providers(&new).unwrap();
        assert_eq!(registry.secrets.get("vault", "op://v/i/f").unwrap(), None);
        assert!(registry.claim_turn("affected", &session).unwrap().is_none());
        drop(lease);
        registry.remove("affected").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn invalidation_targets_only_sessions_with_matching_reference() {
        let registry = Arc::new(SessionRegistry::default());
        let path = std::env::temp_dir().join(format!("codex-reference-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launch = || CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        };
        let affected = registry
            .open_with_references("affected", launch(), vec![("vault".into(), "item".into())])
            .unwrap();
        let unaffected = registry
            .open_with_references(
                "other",
                launch(),
                vec![("vault".into(), "different".into())],
            )
            .unwrap();
        let lease = registry.claim_turn("affected", &affected).unwrap().unwrap();
        assert_eq!(registry.invalidate_reference("vault", "item").unwrap(), 1);
        assert!(registry
            .claim_turn("affected", &affected)
            .unwrap()
            .is_none());
        assert!(registry.claim_turn("other", &unaffected).unwrap().is_some());
        drop(lease);
        tokio::time::timeout(Duration::from_secs(3), async {
            while registry.get("affected").unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(registry.get("other").unwrap().is_some());
        registry.remove("other").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn exited_shared_process_is_replaced_on_next_open() {
        let path = std::env::temp_dir().join(format!("codex-reopen-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='die': break
 print(json.dumps({'id':m['id'],'result':'alive'}),flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let launch = || CodexLaunch {
            binary: Some(path.clone()),
            ..Default::default()
        };
        let old = registry.open("shared", launch()).unwrap();
        assert_eq!(
            old.request("ping", None, Duration::from_secs(2))
                .await
                .unwrap(),
            json!("alive")
        );
        let _ = old.request("die", None, Duration::from_secs(2)).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while registry.get("shared").unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let fresh = registry.open("shared", launch()).unwrap();
        assert_eq!(
            fresh
                .request("ping", None, Duration::from_secs(2))
                .await
                .unwrap(),
            json!("alive")
        );
        registry.remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn simultaneous_turns_receive_only_their_own_events_and_requests() {
        let path = std::env::temp_dir().join(format!("codex-route-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path,r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='emit':
  for t in ('b','a'):
   print(json.dumps({'method':'item/started','params':{'threadId':t,'turnId':'turn-'+t,'item':{'id':'item-'+t}}}),flush=True)
   print(json.dumps({'id':'approval-'+t,'method':'item/commandExecution/requestApproval','params':{'threadId':t,'turnId':'turn-'+t}}),flush=True)
  print(json.dumps({'id':m['id'],'result':{}}),flush=True)
 elif m.get('method')=='complete':
  print(json.dumps({'method':'turn/completed','params':{'threadId':'a','turn':{'id':'turn-a','status':'interrupted'}}}),flush=True)
  print(json.dumps({'id':m['id'],'result':{}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let handle = registry
            .open(
                "shared",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut a = handle.subscribe_thread("a").unwrap();
        let mut b = handle.subscribe_thread("b").unwrap();
        handle
            .request("emit", None, Duration::from_secs(2))
            .await
            .unwrap();
        for (stream, expected) in [(&mut a, "a"), (&mut b, "b")] {
            let event = tokio::time::timeout(Duration::from_secs(2), stream.next_event())
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(event,ProviderEvent::Notification { params:Some(p), .. } if p["threadId"]==expected)
            );
            let event = tokio::time::timeout(Duration::from_secs(2), stream.next_event())
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(event,ProviderEvent::Request { params:Some(p), .. } if p["threadId"]==expected)
            );
        }
        handle.quarantine_thread("a");
        drop(a);
        assert!(handle.subscribe_thread("a").is_err());
        handle
            .request("complete", None, Duration::from_secs(2))
            .await
            .unwrap();
        assert!(handle.subscribe_thread("a").is_ok());
        registry.remove("shared").unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn requests_are_multiplexed_and_server_requests_can_be_answered() {
        let path = std::env::temp_dir().join(format!("codex-multiplex-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r##"#!/usr/bin/env python3
import sys,json
slow=None
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='slow':
  slow=m['id']
  print(json.dumps({'method':'delta','params':{'text':'hello'}}),flush=True)
  print(json.dumps({'id':'approval','method':'approval/request'}),flush=True)
 elif m.get('id')=='approval':
  print(json.dumps({'method':'approved','params':m.get('result')}),flush=True)
 elif m.get('method')=='turn/interrupt':
  print(json.dumps({'id':m['id'],'result':'interrupted'}),flush=True)
  print(json.dumps({'id':slow,'result':'finished'}),flush=True)
"##,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let handle = registry
            .open(
                "shared",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let slow = tokio::spawn({
            let handle = handle.clone();
            async move { handle.request("slow", None, Duration::from_secs(2)).await }
        });
        assert!(
            matches!(handle.next_event().await.unwrap(), ProviderEvent::Notification { method, .. } if method == "delta")
        );
        assert!(
            matches!(handle.next_event().await.unwrap(), ProviderEvent::Request { id, method, .. } if id == "approval" && method == "approval/request")
        );
        assert!(
            !registry.retire_if_idle("shared", &handle).unwrap(),
            "in-flight RPC must keep the process alive"
        );
        handle
            .respond(json!("approval"), Ok(json!({"decision":"accept"})))
            .await
            .unwrap();
        assert!(
            matches!(handle.next_event().await.unwrap(), ProviderEvent::Notification { method, params } if method == "approved" && params.as_ref().unwrap()["decision"] == "accept")
        );
        let interrupted = tokio::time::timeout(
            Duration::from_secs(1),
            handle.interrupt("thread", "turn", Duration::from_secs(1)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(interrupted, "interrupted");
        assert_eq!(slow.await.unwrap().unwrap(), "finished");
        registry.remove("shared").unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn cancellation_does_not_kill_shared_process_and_controls_use_native_ids() {
        let path = std::env::temp_dir().join(format!("codex-registry-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json,time
for line in sys.stdin:
 m=json.loads(line)
 if m['method']=='slow': time.sleep(.2)
 print(json.dumps({'id':m['id'],'result':{'method':m['method'],'params':m.get('params')}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = SessionRegistry::default();
        let first = registry
            .open(
                "shared",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let second = registry.open("shared", CodexLaunch::default()).unwrap();
        let pending = tokio::spawn({
            let first = first.clone();
            async move { first.request("slow", None, Duration::from_secs(2)).await }
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        pending.abort();
        let reply = second
            .interrupt("thread", "turn", Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            reply,
            json!({"method":"turn/interrupt","params":{"threadId":"thread","turnId":"turn"}})
        );
        let reply = first
            .steer(
                "thread",
                "turn",
                vec![json!({"type":"text","text":"change"})],
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(reply["params"]["expectedTurnId"], "turn");
        assert!(registry.remove("shared").unwrap());
        std::fs::remove_file(path).unwrap();
    }
}
