//! OpenCode external-server turn execution.
use crate::{
    effect_worker::Execution,
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        codex_events::RootTurn,
        ingest, lifecycle,
        opencode_events::{Decoder, Update},
        opencode_http::{OpenCodeHttp, OpenCodeVersion},
        opencode_projection::Projector,
        opencode_session::OpenCodeSession,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

struct Child {
    turn: RootTurn,
    parent: RootTurn,
    decoder: Decoder,
    projector: Projector,
    call: String,
    finished: bool,
    call_finished: bool,
    background: bool,
    result: String,
    boundary: Option<String>,
}
struct ImageJob {
    turn: RootTurn,
    id: String,
    input: Value,
    ordinal: u64,
    path: String,
    cwd: String,
    session_id: String,
}
struct ShellJob {
    turn: RootTurn,
    id: String,
    ordinal: u64,
    command: String,
    cwd: String,
    cursor: u64,
    output: String,
}
async fn read_shell(
    session: &OpenCodeSession,
    id: &str,
    job: &mut ShellJob,
    settled: bool,
) -> Result<(), String> {
    for _ in 0..if settled { 5 } else { 4 } {
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            session.shell_output(id, &job.cwd, job.cursor),
        )
        .await
        .map_err(|_| "OpenCode shell output timed out")??;
        let data = &page["data"];
        let chunk = data["output"]
            .as_str()
            .ok_or("Invalid OpenCode shell output")?;
        job.output.push_str(chunk);
        if job.output.len() > 262_144 {
            let mut start = job.output.len() - 262_144;
            while !job.output.is_char_boundary(start) {
                start += 1;
            }
            job.output.drain(..start);
        }
        let next = data["cursor"]
            .as_u64()
            .ok_or("Invalid OpenCode shell cursor")?;
        let size = data["size"].as_u64().ok_or("Invalid OpenCode shell size")?;
        if next <= job.cursor || next >= size {
            job.cursor = next;
            break;
        }
        job.cursor = next;
        if settled && size.saturating_sub(next) > 262_144 {
            job.cursor = size - 262_144;
            job.output.clear();
        }
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn track_shell(
    update: &mut Update,
    turn: &RootTurn,
    projector: &mut Projector,
    jobs: &mut HashMap<String, ShellJob>,
    early: &mut HashMap<String, Value>,
    replay: &mut std::collections::VecDeque<Value>,
    session: &OpenCodeSession,
    cwd: &str,
    cancel: &tokio::sync::Notify,
) -> Result<(), String> {
    if let Update::Tool {
        id,
        name,
        input,
        metadata,
        status,
        output,
        ..
    } = update
    {
        if name == "shell"
            && *status == "completed"
            && metadata["exit"].is_null()
            && metadata["signal"].is_null()
            && metadata["timeout"] != true
        {
            if let Some(shell_id) = metadata["shellID"].as_str() {
                if jobs.len() >= 1024 && !jobs.contains_key(shell_id) {
                    return Err("OpenCode shell job limit exceeded".into());
                }
                let ordinal = projector.ordinal(id)?;
                let mut job = ShellJob {
                    turn: turn.clone(),
                    id: id.clone(),
                    ordinal,
                    command: input["command"]
                        .as_str()
                        .unwrap_or("Shell command")
                        .to_owned(),
                    cwd: cwd.to_owned(),
                    cursor: 0,
                    output: String::new(),
                };
                tokio::select! {_=cancel.notified()=>{},_=read_shell(session,shell_id,&mut job,false)=>{}}
                *output = json!([{"type":"text","text":job.output}]);
                *status = "running";
                jobs.insert(shell_id.to_owned(), job);
                if let Some(event) = early.remove(shell_id) {
                    replay.push_front(event);
                }
            }
        }
    }
    Ok(())
}
fn track_image(
    update: &mut Update,
    turn: &RootTurn,
    projector: &mut Projector,
    jobs: &mut HashMap<String, ImageJob>,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    if let Update::Tool {
        id,
        name,
        input,
        metadata,
        status,
        ..
    } = update
    {
        if name == "experimental_image_generate" && *status == "completed" {
            if let (Some(job_id), Some(path), Some(_)) = (
                metadata["jobID"].as_str(),
                metadata["path"].as_str(),
                metadata["model"].as_str(),
            ) {
                let key = format!("{session_id}:{job_id}");
                if jobs.len() >= 1024 && !jobs.contains_key(&key) {
                    return Err("OpenCode image job limit exceeded".into());
                }
                let ordinal = projector.ordinal(id)?;
                jobs.entry(key).or_insert_with(|| ImageJob {
                    turn: turn.clone(),
                    id: id.clone(),
                    input: input.clone(),
                    ordinal,
                    path: path.to_owned(),
                    cwd: cwd.to_owned(),
                    session_id: session_id.to_owned(),
                });
                *status = "running";
            }
        }
    }
    Ok(())
}
fn image_location(job: &ImageJob, text: &str) -> Option<(String, String, &'static str)> {
    let saved = text.split("Saved image: ").nth(1)?.split(" (").next()?;
    let suffix = saved.strip_prefix(&job.path)?;
    if !matches!(
        suffix.to_ascii_lowercase().as_str(),
        ".png" | ".jpg" | ".jpeg" | ".webp" | ".gif"
    ) {
        return None;
    }
    let path = Path::new(saved);
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return None;
    }
    let cwd = Path::new(&job.cwd);
    let (directory, file) = match path.strip_prefix(cwd) {
        Ok(relative) if !relative.as_os_str().is_empty() => (cwd, relative),
        _ => (path.parent()?, Path::new(path.file_name()?)),
    };
    Some((
        directory.to_str()?.to_owned(),
        file.to_str()?.to_owned(),
        mime,
    ))
}
async fn image_preview(session: &OpenCodeSession, job: &ImageJob, text: &str) -> Option<Value> {
    use base64::Engine;
    let (directory, file, mime) = image_location(job, text)?;
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        session.read_image(&directory, &file),
    )
    .await
    .ok()?
    .ok()?;
    Some(
        json!({"type":"image","mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}
fn handle_child(
    bus: &EventBus,
    child: &mut Child,
    event: &Value,
    version: OpenCodeVersion,
) -> Result<Vec<Update>, String> {
    let mut nested = Vec::new();
    if event["type"] == "session.inbox.enqueued" && event["data"]["item"]["type"] == "user" {
        child.boundary = event["data"]["inboxID"].as_str().map(str::to_owned);
    }
    let update = if version == OpenCodeVersion::V1 {
        child.decoder.event_v1(event)?
    } else {
        child.decoder.event(event)?
    };
    for update in update.into_iter().chain(child.decoder.drain_ready()) {
        match update {
            Update::Started => {}
            Update::Terminal(status) => {
                super::opencode_subagents::finish_child(bus, &child.turn, status, &now())?;
                child.finished = true;
            }
            Update::Permission(_) | Update::Question(_) => {
                return Err("Unexpected child request routing".into())
            }
            update if matches!(&update, Update::Tool {name,..} if name=="subagent" || name=="task" || ((name=="experimental_image_generate" || name=="shell") && version==OpenCodeVersion::V2)) => {
                nested.push(update)
            }
            update => {
                if let Update::Text {
                    reasoning: false,
                    text,
                    ..
                } = &update
                {
                    child.result = text.clone();
                }
                let values = child.projector.project(update, &now())?;
                ingest::ingest(bus, &values).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(nested)
}

struct Active {
    thread: String,
    provider_session: String,
    identity: Option<String>,
    session: Option<OpenCodeSession>,
    cancelled: Arc<AtomicBool>,
    interrupt_ready: Arc<tokio::sync::Notify>,
    cancel_notify: Arc<tokio::sync::Notify>,
}
#[derive(Default)]
struct SteerState {
    pending: std::collections::HashSet<String>,
    accepted: std::collections::HashSet<String>,
    observed: std::collections::HashSet<String>,
    terminal: bool,
    preserve_background: bool,
    notify: Arc<tokio::sync::Notify>,
}
static STEERING: OnceLock<Mutex<HashMap<String, Arc<Mutex<SteerState>>>>> = OnceLock::new();
fn steering() -> &'static Mutex<HashMap<String, Arc<Mutex<SteerState>>>> {
    STEERING.get_or_init(|| Mutex::new(HashMap::new()))
}
struct ChildActive {
    thread: String,
    provider_session: String,
    generation: Arc<AtomicBool>,
    session: OpenCodeSession,
}
struct Watcher {
    thread: String,
    provider_session: String,
    identity: Option<String>,
    cancelled: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    steer_state: Option<Arc<Mutex<SteerState>>>,
}
static WATCHERS: OnceLock<Mutex<Vec<Watcher>>> = OnceLock::new();
fn watchers() -> &'static Mutex<Vec<Watcher>> {
    WATCHERS.get_or_init(|| Mutex::new(Vec::new()))
}
static ACTIVE_CHILDREN: OnceLock<Mutex<HashMap<String, ChildActive>>> = OnceLock::new();
fn active_children() -> &'static Mutex<HashMap<String, ChildActive>> {
    ACTIVE_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}
static ACTIVE: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
fn active() -> &'static Mutex<HashMap<String, Active>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
struct McpEntry {
    session: OpenCodeSession,
    name: String,
    directory: String,
    identity: [u8; 32],
}
static MCP: OnceLock<Mutex<HashMap<String, McpEntry>>> = OnceLock::new();
// The upstream settings service materializes persisted secrets once per settings
// revision. Direct edits to a secret file take effect when settings are reloaded.
type CachedPassword = (String, String);
static LAUNCH_PASSWORDS: OnceLock<Mutex<HashMap<(std::path::PathBuf, String), CachedPassword>>> =
    OnceLock::new();
fn launch_password(
    path: Option<&Path>,
    instance: &str,
    entry: &Value,
) -> Result<Option<String>, String> {
    let resolved = effective_password(entry)?;
    let Some(path) = path else { return Ok(None) };
    let raw = super::session_registry::read_provider_settings(Some(path))?;
    let source = &raw["providerInstances"][instance];
    if source["config"]["serverPassword"] != "••••••" {
        return Ok(None);
    }
    let Some(password) = resolved else {
        return Ok(None);
    };
    let revision = source.to_string();
    let mut cache = LAUNCH_PASSWORDS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "OpenCode credential cache unavailable")?;
    let value = cache
        .entry((path.to_owned(), instance.to_owned()))
        .or_insert_with(|| (revision.clone(), password.clone()));
    if value.0 != revision {
        *value = (revision, password);
    }
    Ok(Some(value.1.clone()))
}
fn mcp_entries() -> &'static Mutex<HashMap<String, McpEntry>> {
    MCP.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn resolved_settings(path: Option<&std::path::Path>) -> Result<Value, String> {
    let mut settings = super::session_registry::read_provider_settings(path)?;
    let masked = settings["providerInstances"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entry)| {
            entry["driver"] == "opencode" && entry["config"]["serverPassword"] == "••••••"
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let masked_env = settings["providerInstances"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entry)| entry["driver"] == "opencode")
        .flat_map(|(id, entry)| {
            entry["environment"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter(|(_, value)| {
                    value["value"] == "••••••"
                        || (value["sensitive"] == true
                            && value["valueRedacted"] == true
                            && value["value"] == "")
                })
                .map(move |(index, _)| (id.clone(), index))
        })
        .collect::<Vec<_>>();
    if let Some(path) = path {
        crate::settings::materialize_secrets(path, &mut settings)?;
    } else if !masked.is_empty() || !masked_env.is_empty() {
        return Err("OpenCode stored credential is unavailable".into());
    }
    for id in masked {
        if settings["providerInstances"][&id]["config"]["serverPassword"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            return Err("OpenCode stored password is unavailable".into());
        }
    }
    for (id, index) in masked_env {
        if settings["providerInstances"][&id]["environment"][index]["value"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            return Err("OpenCode stored environment credential is unavailable".into());
        }
    }
    for (_, entry) in settings["providerInstances"]
        .as_object()
        .into_iter()
        .flatten()
    {
        if entry["driver"] == "opencode"
            && !entry["config"]["serverPassword"].is_null()
            && !entry["config"]["serverPassword"].is_string()
        {
            return Err("Unresolved OpenCode server password".into());
        }
    }
    Ok(settings)
}
pub(crate) fn effective_password(entry: &Value) -> Result<Option<String>, String> {
    fn has_ref(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                (map.contains_key("provider") && map.contains_key("reference"))
                    || map.values().any(has_ref)
            }
            Value::Array(items) => items.iter().any(has_ref),
            _ => false,
        }
    }
    if has_ref(&entry["config"]) || has_ref(&entry["environment"]) {
        return Err("Unresolved OpenCode secret reference".into());
    }
    let config = &entry["config"];
    let mut password = config["serverPassword"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if config["serverUrl"]
        .as_str()
        .is_none_or(|value| value.trim().is_empty())
        && password.is_none()
    {
        password = entry["environment"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["name"] == "OPENCODE_SERVER_PASSWORD")
            })
            .and_then(|item| item["value"].as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                std::env::var("OPENCODE_SERVER_PASSWORD")
                    .ok()
                    .filter(|value| !value.is_empty())
            });
    }
    Ok(password)
}
pub(crate) fn connection_identity(
    entry: &Value,
    settings_path: &std::path::Path,
) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let dir = settings_path
        .parent()
        .ok_or("Missing OpenCode settings directory")?
        .join("secrets");
    let key = crate::signing_key::load_or_create_key(&dir, "opencode-force-stop-key.bin")
        .map_err(|_| "OpenCode retry signing key unavailable")?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "OpenCode retry signing key invalid")?;
    let password = effective_password(entry)?;
    mac.update(json!({"config":entry["config"],"environment":entry["environment"],"effectivePassword":password}).to_string().as_bytes());
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

/// Reconcile an external session when an outbox retry survived a server restart.
pub(crate) fn reconcile_external_force_stop(
    settings_path: &std::path::Path,
    instance: &str,
    native: &str,
    cwd: Option<&str>,
    expected_identity: &str,
    thread: &str,
) -> Result<bool, String> {
    if crate::managed_policy::has_provider_restrictions()? {
        return Err("OpenCode provider restrictions cannot be safely enforced".into());
    }
    let settings = resolved_settings(Some(settings_path))?;
    let entry = &settings["providerInstances"][instance];
    if entry["enabled"] == false
        || (!entry.is_null() && entry["driver"].as_str() != Some("opencode"))
    {
        return Err("OpenCode provider instance is unavailable".into());
    }
    if expected_identity.is_empty()
        || connection_identity(entry, settings_path)? != expected_identity
    {
        return Err("OpenCode provider configuration changed during force-stop retry".into());
    }
    let config = &entry["config"];
    let external = config["serverUrl"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let owned = if external.is_none() {
        super::opencode_owner::force_endpoint(instance, thread)?
    } else {
        None
    };
    let url = if let Some(url) = external {
        url
    } else if let Some((url, _)) = owned {
        url
    } else {
        #[cfg(target_os = "linux")]
        {
            return Ok(true);
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err("Cannot verify managed OpenCode process termination after restart".into());
        }
    };
    if native.is_empty() {
        return Err("Missing native OpenCode session for force-stop retry".into());
    }
    let native = native.to_owned();
    let cwd = cwd.map(str::to_owned);
    let password = effective_password(entry)?;
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "OpenCode retry runtime unavailable".to_owned())?;
        runtime.block_on(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async move {
                let mut http = OpenCodeHttp::new(&url, password)?;
                let version = http.probe().await?;
                if version == OpenCodeVersion::V1 {
                    if let Some(cwd) = &cwd {
                        http.scope_directory(cwd);
                    }
                }
                for attempt in 0..3 {
                    let status = if version == OpenCodeVersion::V2 {
                        http.request(reqwest::Method::GET, &["api", "session", "active"], None)
                            .await?
                    } else {
                        http.request(reqwest::Method::GET, &["session", "status"], None)
                            .await?
                    };
                    let active = if version == OpenCodeVersion::V2 {
                        status["data"]
                            .as_object()
                            .ok_or("Invalid OpenCode active session response")?
                            .contains_key(&native)
                    } else {
                        status
                            .as_object()
                            .ok_or("Invalid OpenCode status response")?
                            .get(&native)
                            .is_some_and(|value| value["type"] != "idle")
                    };
                    if !active {
                        OpenCodeSession::existing(http.clone(), version, native.clone())
                            .stop_owned_shells(cwd.as_deref())
                            .await?;
                        return Ok(true);
                    }
                    if attempt == 0 {
                        http.interrupt(version, &native).await?;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Ok(false)
            })
            .await
            .map_err(|_| "OpenCode force-stop retry timed out".to_owned())?
        })
    })
    .join()
    .map_err(|_| "OpenCode retry thread failed".to_owned())?
}

pub(crate) struct ForceStopSnapshot {
    flags: Vec<(Arc<AtomicBool>, Arc<tokio::sync::Notify>)>,
    sessions: Vec<OpenCodeSession>,
    identity: Option<String>,
    prestart: bool,
    steer_states: Vec<Arc<Mutex<SteerState>>>,
}
pub(crate) fn force_stop_snapshot(
    provider_session: &str,
    thread: &str,
) -> Option<ForceStopSnapshot> {
    let watchers = watchers().lock().ok()?;
    let mut identity = watchers
        .iter()
        .find(|entry| entry.thread == thread && entry.provider_session == provider_session)
        .and_then(|entry| entry.identity.clone());
    let mut flags = watchers
        .iter()
        .filter(|entry| entry.thread == thread && entry.provider_session == provider_session)
        .map(|entry| (entry.cancelled.clone(), entry.notify.clone()))
        .collect::<Vec<_>>();
    let steer_states = watchers
        .iter()
        .filter(|entry| entry.thread == thread && entry.provider_session == provider_session)
        .filter_map(|entry| entry.steer_state.clone())
        .collect();
    let had_watchers = !flags.is_empty();
    drop(watchers);
    let active = active().lock().ok()?;
    let mut prestart = !had_watchers;
    for entry in active
        .values()
        .filter(|entry| entry.thread == thread && entry.provider_session == provider_session)
    {
        if entry.session.is_some() {
            prestart = false;
        }
        if identity.is_none() {
            identity = entry.identity.clone();
        }
        if !flags
            .iter()
            .any(|(flag, _)| Arc::ptr_eq(flag, &entry.cancelled))
        {
            flags.push((entry.cancelled.clone(), entry.cancel_notify.clone()));
        }
    }
    if flags.is_empty() {
        return None;
    }
    let mut sessions = active
        .values()
        .filter(|entry| {
            entry.thread == thread
                && flags
                    .iter()
                    .any(|(flag, _)| Arc::ptr_eq(flag, &entry.cancelled))
        })
        .filter_map(|entry| entry.session.clone())
        .collect::<Vec<_>>();
    drop(active);
    sessions.extend(
        active_children()
            .lock()
            .ok()?
            .values()
            .filter(|entry| {
                entry.thread == thread
                    && entry.provider_session == provider_session
                    && flags
                        .iter()
                        .any(|(flag, _)| Arc::ptr_eq(flag, &entry.generation))
            })
            .map(|entry| entry.session.clone()),
    );
    Some(ForceStopSnapshot {
        flags,
        sessions,
        identity,
        prestart,
        steer_states,
    })
}
impl ForceStopSnapshot {
    pub(crate) fn identity(&self) -> Option<&str> {
        self.identity.as_deref()
    }
    pub(crate) fn prestart(&self) -> bool {
        self.prestart
    }
    /// Called while the serialized thread state prevents a newer run from starting.
    pub(crate) fn stop(&self, thread: &str, cwd: Option<&str>) -> bool {
        for state in &self.steer_states {
            if let Ok(mut state) = state.lock() {
                state.preserve_background = false;
            }
        }
        if self.prestart {
            for (flag, notify) in &self.flags {
                flag.store(true, Ordering::Release);
                notify.notify_one();
            }
        }
        let sessions = self.sessions.clone();
        let cwd = cwd.map(str::to_owned);
        let finished = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return false;
            };
            runtime.block_on(async {
                let requests = sessions.iter().map(|session| async {
                    session.interrupt().await?;
                    for _ in 0..3 {
                        if !session.is_active().await? {
                            session.stop_owned_shells(cwd.as_deref()).await?;
                            return Ok(());
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    Err("OpenCode session is still active".to_owned())
                });
                tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    futures_util::future::join_all(requests),
                )
                .await
                .is_ok_and(|results| results.iter().all(Result::is_ok))
            })
        })
        .join()
        .unwrap_or(false);
        let owner_released = super::opencode_owner::force_detach_thread(thread);
        if finished && owner_released {
            for (flag, notify) in &self.flags {
                flag.store(true, Ordering::Release);
                notify.notify_one();
            }
            true
        } else {
            false
        }
    }
}
pub(crate) fn has_background(thread: &str) -> bool {
    watchers()
        .lock()
        .map(|entries| entries.iter().any(|entry| entry.thread == thread))
        .unwrap_or(true)
}
pub async fn detach(thread: &str) -> Result<(), String> {
    super::opencode_questions::cancel_thread(thread);
    if let Ok(mut entries) = watchers().lock() {
        for entry in entries.iter().filter(|entry| entry.thread == thread) {
            if let Some(state) = &entry.steer_state {
                if let Ok(mut state) = state.lock() {
                    state.preserve_background = false;
                }
            }
            entry.cancelled.store(true, Ordering::Release);
            entry.notify.notify_one();
        }
        entries.retain(|entry| entry.thread != thread);
    }
    let current = {
        let mut map = active()
            .lock()
            .map_err(|_| "OpenCode session lock failed")?;
        let key = map
            .iter()
            .find(|(_, entry)| entry.thread == thread)
            .map(|(key, _)| key.clone());
        key.and_then(|key| map.remove(&key))
    };
    if let Some(current) = current {
        current.cancelled.store(true, Ordering::Release);
        current.cancel_notify.notify_one();
        if let Some(session) = current.session {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(1), session.interrupt()).await;
        }
    }
    let entry = mcp_entries()
        .lock()
        .map_err(|_| "OpenCode MCP lock failed")?
        .remove(thread);
    if let Some(entry) = entry {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            entry.session.remove_mcp(&entry.name, &entry.directory),
        )
        .await;
    }
    let child_sessions = {
        let mut map = active_children()
            .lock()
            .map_err(|_| "OpenCode child registry unavailable")?;
        let keys: Vec<_> = map
            .iter()
            .filter(|(_, entry)| entry.thread == thread)
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| map.remove(&key).map(|entry| entry.session))
            .collect::<Vec<_>>()
    };
    for session in child_sessions {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), session.interrupt()).await;
    }
    super::opencode_owner::detach_thread(thread).await;
    Ok(())
}
struct Admission {
    key: String,
    cancelled: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(mut map) = active().lock() {
                if map
                    .get(&self.key)
                    .is_some_and(|v| Arc::ptr_eq(&v.cancelled, &self.cancelled))
                {
                    map.remove(&self.key);
                }
            }
        }
    }
}
pub(crate) fn is_active(provider_thread_id: &str) -> bool {
    active()
        .lock()
        .is_ok_and(|map| map.contains_key(provider_thread_id))
        || active_children()
            .lock()
            .is_ok_and(|map| map.contains_key(provider_thread_id))
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn permission_decision(answer: Option<&Value>, version: OpenCodeVersion) -> &'static str {
    match answer.and_then(|answer| answer["outcome"]["optionId"].as_str()) {
        Some("always") if version == OpenCodeVersion::V1 => "always",
        Some("always" | "once") => "once",
        _ => "reject",
    }
}
fn mcp_server_name(thread: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("t3-code-{:x}", Sha256::digest(thread.as_bytes()))[..24].to_owned()
}
fn v1_message_id() -> String {
    static CLOCK: AtomicU64 = AtomicU64::new(0);
    let base = (chrono::Utc::now().timestamp_millis().max(0) as u64).saturating_mul(4096);
    let previous = CLOCK
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_add(1).max(base))
        })
        .unwrap_or(0);
    let clock = previous.saturating_add(1).max(base) & 0x0000_ffff_ffff_ffff;
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("msg_{clock:012x}{}", &random[..28])
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn cancellation_terminal(update: Update, cancelled: bool) -> Update {
    match update {
        Update::Terminal(_) if cancelled => Update::Terminal("interrupted"),
        value => value,
    }
}
fn capabilities(version: OpenCodeVersion) -> Value {
    json!({
        "sessions":{"supportsMultipleProviderThreadsPerSession":false,"supportsModelSwitchInSession":true,"supportsProviderSwitchingViaHandoff":false,"supportsRuntimeModeSwitchInSession":true,"pendingRequestsSurviveRestart":false},
        "threads":{"canCreateEmptyThread":true,"canReadThreadSnapshot":false,"canRollbackThread":true,"canForkThread":true,"canForkFromTurn":true,"canForkFromSubagentThread":false,"exposesNativeThreadId":true},
        "turns":{"exposesNativeTurnId":false,"emitsTurnStarted":true,"emitsTurnCompleted":true,"supportsInterrupt":true,"supportsActiveSteering":true,"supportsSteeringByInterruptRestart":true,"supportsQueuedMessages":true,"terminalStatusQuality":"strong"},
        "streaming":{"streamsAssistantText":true,"streamsReasoning":true,"streamsToolOutput":version==OpenCodeVersion::V1,"streamsPlanText":false,"emitsMessageCompleted":true},
        "tools":{"exposesToolItemIds":true,"emitsToolStarted":true,"emitsToolCompleted":true,"emitsToolOutput":true,"supportsMcpTools":false,"supportsDynamicToolCallbacks":false},
        "approvals":{"supportsCommandApproval":true,"supportsFileReadApproval":true,"supportsFileChangeApproval":true,"supportsApplyPatchApproval":false,"approvalsHaveNativeRequestIds":false,"approvalCallbacksAreLiveOnly":true,"approvalsCanOriginateFromSubagents":true},
        "planning":{"emitsPlanUpdated":true,"emitsTodoList":true,"emitsProposedPlan":false,"supportsStructuredQuestions":true,"planDeltasHaveItemIds":false},
        "subagents":{"supportsSubagents":true,"exposesSubagentThreadIds":true,"emitsSubagentLifecycle":true,"canWaitForSubagents":false,"canCloseSubagents":false,"canForkSubagentThread":false},
        "context":{"acceptsSystemContext":false,"acceptsDeveloperContext":false,"acceptsSyntheticUserContext":false,"canGenerateSummaries":false,"canConsumeHandoffSummaries":false,"supportsDeltaHandoff":false,"supportsFullThreadHandoff":false,"maxRecommendedHandoffChars":null},
        "checkpointing":{"appCanCheckpointFilesystem":true,"supportsNestedCheckpointScopes":false,"providerCanRollbackConversation":true,"providerRollbackReturnsSnapshot":false,"providerCanReadConversationSnapshot":false},
        "identity":{"nativeThreadIds":"strong","nativeTurnIds":"weak","nativeItemIds":"weak","nativeRequestIds":"weak"},"runtimePolicy":{"enforcement":"client-boundary"}
    })
}

pub fn execute<'a>(
    bus: &'a EventBus,
    effect: &'a Effect,
    settings: Option<&'a Path>,
    attachments: &'a Path,
    mcp: Option<(&'a str, &'a super::session_registry::SessionRegistry)>,
) -> Execution<'a> {
    Box::pin(async move {
        match effect.request["type"].as_str() {
            Some("provider-turn.start") => {
                match start(bus, effect, settings, attachments, mcp).await {
                    Err(error)
                        if error == "OpenCode HTTP status 401"
                            || error == "OpenCode event HTTP status 401" =>
                    {
                        super::acp_executor::fail_provider_start(bus, effect, &error)
                    }
                    result => result,
                }
            }
            Some("provider-turn.steer") => steer(bus, effect, settings, attachments).await,
            Some("provider-turn.restart") => restart(bus, effect, settings, attachments, mcp).await,
            Some("provider-turn.interrupt") => {
                let id = field(&effect.request, "providerThreadId")?;
                let root = active()
                    .lock()
                    .map_err(|_| "OpenCode session lock failed")?
                    .get(id)
                    .filter(|entry| {
                        entry.thread == effect.thread_id
                            && effect.request["providerSessionId"]
                                .as_str()
                                .is_none_or(|session| session == entry.provider_session)
                    })
                    .map(|v| {
                        (
                            v.session.clone(),
                            v.cancelled.clone(),
                            v.interrupt_ready.clone(),
                            v.cancel_notify.clone(),
                        )
                    });
                let Some((session, cancelled, interrupt_ready, cancel_notify)) = root else {
                    let child = active_children()
                        .lock()
                        .map_err(|_| "OpenCode child registry unavailable")?
                        .get(id)
                        .filter(|entry| {
                            entry.thread == effect.thread_id
                                && effect.request["providerSessionId"]
                                    .as_str()
                                    .is_none_or(|session| session == entry.provider_session)
                        })
                        .map(|entry| entry.session.clone())
                        .ok_or("OpenCode turn is not active")?;
                    return child.interrupt().await.map(|_| ());
                };
                cancelled.store(true, Ordering::Release);
                cancel_notify.notify_one();
                super::acp_executor::cancel_approvals(&effect.thread_id);
                super::opencode_questions::cancel_thread(&effect.thread_id);
                match session {
                    Some(session) => {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            interrupt_ready.notified(),
                        )
                        .await;
                        session.interrupt().await.map(|_| ())
                    }
                    None => Ok(()),
                }
            }
            _ => Err("OpenCode operation is not yet implemented".into()),
        }
    })
}
async fn restart(
    bus: &EventBus,
    effect: &Effect,
    settings: Option<&Path>,
    attachments: &Path,
    mcp: Option<(&str, &super::session_registry::SessionRegistry)>,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay an uncertain OpenCode restart".into());
    }
    if !effect.request["sessionTransition"].is_null() {
        return Err("OpenCode session transitions during restart are not supported".into());
    }
    let turn_id = field(&effect.request, "providerTurnId")?;
    let attempt_id = field(&effect.request, "interruptedAttemptId")?;
    let run_id = field(&effect.request, "runId")?;
    let provider = field(&effect.request, "providerThreadId")?;
    let provider_session = field(&effect.request, "providerSessionId")?;
    let state = || {
        bus.commit(|tx|{let row:Option<(String,String,String)>=tx.query_row("SELECT t.status,COALESCE(t.run_attempt_id,''),r.status FROM orchestration_v2_projection_provider_turns t JOIN orchestration_v2_projection_runs r ON r.run_id=?1 AND r.thread_id=t.thread_id JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=t.provider_thread_id WHERE t.provider_turn_id=?2 AND t.thread_id=?3 AND t.provider_thread_id=?4 AND p.provider_session_id=?5 AND json_extract(p.payload_json,'$.driver')='opencode'",params![run_id,turn_id,effect.thread_id,provider,provider_session],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;Ok((row,vec![]))}).map_err(|error|error.to_string())
    };
    let (turn_status, attempt, run_status) = state()?.ok_or("Restart target was not found")?;
    if attempt != attempt_id {
        return Err("Restart target attempt does not match".into());
    }
    if run_status != "starting" {
        return Ok(());
    }
    if matches!(turn_status.as_str(), "pending" | "running" | "waiting") {
        let steer = steering()
            .lock()
            .map_err(|_| "OpenCode steering lock failed")?
            .get(provider)
            .cloned()
            .ok_or("OpenCode restart supervisor is unavailable")?;
        steer
            .lock()
            .map_err(|_| "OpenCode steering lock failed")?
            .preserve_background = true;
        let mut interrupt = effect.clone();
        interrupt.request["type"] = json!("provider-turn.interrupt");
        if let Err(error) = execute(bus, &interrupt, settings, attachments, mcp).await {
            if let Ok(mut state) = steer.lock() {
                state.preserve_background = false;
            }
            return Err(error);
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let (status, _, run_status) = state()?.ok_or("Restart target was not found")?;
            if run_status != "starting" {
                return Ok(());
            }
            let still_active = active()
                .lock()
                .map_err(|_| "OpenCode session lock failed")?
                .contains_key(provider);
            if !matches!(status.as_str(), "pending" | "running" | "waiting") && !still_active {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("OpenCode interrupt unresponsive".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    start(bus, effect, settings, attachments, mcp).await
}

async fn steer(
    bus: &EventBus,
    effect: &Effect,
    settings_path: Option<&Path>,
    attachments: &Path,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay an uncertain OpenCode steer".into());
    }
    let provider = field(&effect.request, "providerThreadId")?;
    let provider_session = field(&effect.request, "providerSessionId")?;
    let turn_id = field(&effect.request, "providerTurnId")?;
    let message_id = field(&effect.request, "messageId")?;
    let (thread,turn,message,app_thread)=bus.commit(|tx| {
        let read=|sql:&str,id:&str|->rusqlite::Result<Value>{let raw:String=tx.query_row(sql,params![id,effect.thread_id],|row|row.get(0))?;serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)};
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&effect.thread_id],|row|row.get(0))?;
        let app_thread:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        Ok(((read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",provider)?,read("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1 AND thread_id=?2",turn_id)?,read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1 AND thread_id=?2",message_id)?,app_thread),vec![]))
    }).map_err(|error|error.to_string())?;
    if thread["providerSessionId"] != provider_session
        || thread["driver"] != "opencode"
        || turn["providerThreadId"] != provider
        || !matches!(turn["status"].as_str(), Some("running" | "waiting"))
    {
        return Err("OpenCode steer target is not active".into());
    }
    let (session, cancelled) = active()
        .lock()
        .map_err(|_| "OpenCode session lock failed")?
        .get(provider)
        .filter(|entry| {
            entry.thread == effect.thread_id && entry.provider_session == provider_session
        })
        .and_then(|entry| {
            entry
                .session
                .clone()
                .map(|session| (session, entry.cancelled.clone()))
        })
        .ok_or("OpenCode turn is not active")?;
    let version = session.version();
    let state = steering()
        .lock()
        .map_err(|_| "OpenCode steering lock failed")?
        .get(provider)
        .cloned()
        .ok_or("OpenCode turn is not active")?;
    let settings = super::session_registry::read_provider_settings(settings_path)?;
    let instance = thread["providerInstanceId"]
        .as_str()
        .ok_or("Missing provider instance")?;
    let external = settings["providerInstances"][instance]["config"]["serverUrl"]
        .as_str()
        .is_some_and(|value| !value.trim().is_empty());
    let (text, files) =
        super::opencode_attachments::build(&message, attachments, version, external)?;
    if text.trim().is_empty() && files.is_empty() {
        return Err("OpenCode steering requires text or an attachment".into());
    }
    let v1_model = if version == OpenCodeVersion::V1 {
        let model = effect.request["modelSelection"]["model"]
            .as_str()
            .ok_or("Missing OpenCode model")?;
        let (provider, model) = model.split_once('/').ok_or("Invalid OpenCode model")?;
        Some((provider.to_owned(), model.to_owned()))
    } else {
        None
    };
    let inbox = if version == OpenCodeVersion::V1 {
        v1_message_id()
    } else {
        format!("msg_t3_steer_{}:{message_id}", session.native_id())
    };
    {
        let mut state = state.lock().map_err(|_| "OpenCode steering lock failed")?;
        if state.terminal || cancelled.load(Ordering::Acquire) {
            return Err("OpenCode turn is not active".into());
        }
        if !state.pending.insert(inbox.clone()) {
            return Err("OpenCode steer already pending".into());
        }
    }
    let body = if version == OpenCodeVersion::V1 {
        let (provider, model) = v1_model.expect("1.x model validated");
        let mut parts = Vec::new();
        if !text.trim().is_empty() {
            parts.push(json!({"type":"text","text":text.trim()}));
        }
        parts.extend(files);
        json!({"messageID":inbox,"model":{"providerID":provider,"modelID":model},"agent":if app_thread["interactionMode"]=="plan"{"plan"}else{"build"},"parts":parts})
    } else {
        let mut body = json!({"id":inbox,"text":text.trim(),"delivery":"steer"});
        if !files.is_empty() {
            body["files"] = json!(files);
        }
        body
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), session.prompt(body))
        .await
        .map_err(|_| "OpenCode steer timed out".to_owned())
        .and_then(|result| result.map(|_| ()));
    if version == OpenCodeVersion::V1 && result.is_ok() {
        if let Ok(mut state) = state.lock() {
            state.accepted.insert(inbox.clone());
            if state.observed.remove(&inbox) {
                state.accepted.remove(&inbox);
                state.pending.remove(&inbox);
                state.notify.notify_one();
            }
        }
    }
    if result.as_ref().is_err_and(|error| {
        matches!(
            error.as_str(),
            "OpenCode HTTP status 400"
                | "OpenCode HTTP status 401"
                | "OpenCode HTTP status 403"
                | "OpenCode HTTP status 404"
                | "OpenCode HTTP status 409"
                | "OpenCode HTTP status 422"
        )
    }) {
        if let Ok(mut state) = state.lock() {
            state.pending.remove(&inbox);
            state.accepted.remove(&inbox);
            state.observed.remove(&inbox);
            state.notify.notify_one();
        }
    }
    result
}

fn side_chat_prompt(bus: &EventBus, run: &Value, thread: &Value, message: &Value) -> Result<(Value, Vec<Value>), String> {
    let (text, side_chat) = if thread["lineage"]["sideChat"] == true {
        let run_id = run["id"].as_str().ok_or("Missing run id")?;
        let handoffs = bus.commit(|tx| Ok((super::executor::pending_handoffs(tx, run["providerThreadId"].as_str(), run_id)?, vec![]))).map_err(|e| e.to_string())?;
        super::executor::prepare_inline_handoffs(handoffs, message)?
    } else {
        (message["text"].as_str().unwrap_or("").to_owned(), vec![])
    };
    let mut prompt_message = message.clone();
    prompt_message["text"] = json!(text);
    Ok((prompt_message, side_chat))
}

async fn start(
    bus: &EventBus,
    effect: &Effect,
    settings_path: Option<&Path>,
    attachments: &Path,
    mcp: Option<(&str, &super::session_registry::SessionRegistry)>,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot replay an uncertain OpenCode turn".into());
    }
    if crate::managed_policy::has_provider_restrictions()? {
        return Err("OpenCode execution is unavailable while a managed policy is active because its launch environment and credentials are not yet policy-isolated".into());
    }
    let run_id = field(&effect.request, "runId")?.to_owned();
    let data=bus.commit(|tx| {
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'",params![run_id,effect.thread_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok((None,vec![]));};
        let parse=|s:String|serde_json::from_str::<Value>(&s).map_err(|_|rusqlite::Error::InvalidQuery);
        let run=parse(raw)?;
        let read=|sql:&str,id:&str| -> rusqlite::Result<Value> {parse(tx.query_row(sql,[id],|r|r.get(0))?)};
        let pt=read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let message=read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",run["userMessageId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let thread=read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&effect.thread_id)?;
        let cwd:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'",[&run_id],|r|r.get(0)).optional()?.flatten();
        let ordinal:u64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0))?;
        Ok((Some((run,pt,message,thread,cwd,ordinal)),vec![]))
    }).map_err(|e|e.to_string())?;
    let Some((run, mut pt, message, thread, cwd, ordinal)) = data else {
        return Ok(());
    };
    let worktree = thread["worktreePath"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let workspace = worktree.clone().or_else(|| cwd.clone());
    let _workspace_guards = if let Some(workspace) = workspace {
        Some(
            tokio::task::spawn_blocking(move || {
                let absolute = |path: String| {
                    let path = std::path::PathBuf::from(path);
                    if path.is_absolute() {
                        path
                    } else {
                        std::env::current_dir().unwrap_or_default().join(path)
                    }
                };
                let reservation = crate::workspace_safety::reserve(
                    absolute(workspace),
                    crate::workspace_safety::ReservationKind::TurnStart,
                );
                let lease =
                    worktree.map(|path| crate::workspace_safety::workspace_lease(absolute(path)));
                (reservation, lease)
            })
            .await
            .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let still_starting=bus.commit(|tx|{let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')",params![run_id,effect.thread_id],|row|row.get(0))?;Ok((active,vec![]))}).map_err(|error|error.to_string())?;
    if !still_starting {
        return Ok(());
    }
    let key = field(&pt, "id")?.to_owned();
    let cancelled = Arc::new(AtomicBool::new(false));
    let interrupt_ready = Arc::new(tokio::sync::Notify::new());
    let cancel_notify = Arc::new(tokio::sync::Notify::new());
    {
        let mut map = active()
            .lock()
            .map_err(|_| "OpenCode session lock failed")?;
        if map.contains_key(&key) {
            return Err("OpenCode turn already active".into());
        }
        map.insert(
            key.clone(),
            Active {
                thread: effect.thread_id.clone(),
                provider_session: pt["providerSessionId"].as_str().unwrap_or("").to_owned(),
                identity: None,
                session: None,
                cancelled: cancelled.clone(),
                interrupt_ready: interrupt_ready.clone(),
                cancel_notify: cancel_notify.clone(),
            },
        );
    }
    let mut admission = Admission {
        key: key.clone(),
        cancelled: cancelled.clone(),
        armed: true,
    };
    let cwd = cwd
        .or_else(|| thread["worktreePath"].as_str().map(str::to_owned))
        .ok_or("Missing OpenCode workspace")?;
    let instance_id = field(&pt, "providerInstanceId")?.to_owned();
    let instance = instance_id.as_str();
    let mut settings = resolved_settings(settings_path)?;
    if let Some(password) = launch_password(
        settings_path,
        instance,
        &settings["providerInstances"][instance],
    )? {
        settings["providerInstances"][instance]["config"]["serverPassword"] = json!(password);
    }
    let entry = &settings["providerInstances"][instance];
    let password = effective_password(entry)?;
    let identity = match settings_path {
        Some(path) => Some(connection_identity(entry, path)?),
        None => None,
    };
    if let Ok(mut entries) = active().lock() {
        if let Some(entry) = entries.get_mut(&key) {
            entry.identity = identity.clone();
        }
    }
    let config = &entry["config"];
    let configured_url = config["serverUrl"]
        .as_str()
        .filter(|v| !v.trim().is_empty());
    let (url, version) = if let Some(url) = configured_url {
        let client = OpenCodeHttp::new(url, password.clone())?;
        (url.to_owned(), client.probe().await?)
    } else {
        super::opencode_owner::connect(
            instance,
            &effect.thread_id,
            config,
            &settings["providerInstances"][instance]["environment"],
            &cwd,
            password.as_deref(),
        )
        .await?
    };
    let mut http = OpenCodeHttp::new(&url, password)?;
    if version == OpenCodeVersion::V1 {
        http.scope_directory(&cwd);
    }
    let model = field(&run["modelSelection"], "model")?;
    let (provider, model_id) = model
        .split_once('/')
        .filter(|(a, b)| !a.is_empty() && !b.is_empty())
        .ok_or("Invalid OpenCode model")?;
    let mode = thread["runtimeMode"]
        .as_str()
        .unwrap_or("approval-required");
    let managed = configured_url.is_none();
    let mut rules = match version {
        OpenCodeVersion::V1 if mode == "full-access" => {
            json!([{"permission":"*","pattern":"*","action":"allow"}])
        }
        OpenCodeVersion::V1 => {
            let mut values = vec![json!({"permission":"*","pattern":"*","action":"ask"})];
            for permission in [
                "question",
                "read",
                "glob",
                "grep",
                "lsp",
                "todowrite",
                "task",
                "skill",
            ] {
                values.push(json!({"permission":permission,"pattern":"*","action":"allow"}));
            }
            values.push(json!({"permission":"read","pattern":"*.env","action":"ask"}));
            values.push(json!({"permission":"read","pattern":"*.env.*","action":"ask"}));
            values.push(json!({"permission":"read","pattern":"*.env.example","action":"allow"}));
            if mode == "auto-accept-edits" {
                values.push(json!({"permission":"edit","pattern":"*","action":"allow"}));
            }
            Value::Array(values)
        }
        OpenCodeVersion::V2 if mode == "full-access" => {
            json!([{"action":"*","resource":"*","effect":"allow"}])
        }
        OpenCodeVersion::V2 => {
            json!([{"action":"shell","resource":"*","effect":"ask"},{"action":"edit","resource":"*","effect":if mode=="auto-accept-edits" {"allow"} else {"ask"}},{"action":"external_directory","resource":"*","effect":"ask"}])
        }
    };
    // Hash every thread ID: sanitizing punctuation alone aliases e.g. a:b and a_b.
    let mcp_name = mcp_server_name(&effect.thread_id);
    if managed && version == OpenCodeVersion::V2 {
        if let Some(entries) = rules.as_array_mut() {
            if thread["interactionMode"] == "plan" {
                entries.push(json!({"action":"edit","resource":"*","effect":"deny"}));
            }
            entries.push(json!({"action":"t3-code-*","resource":"*","effect":"deny"}));
            entries.push(json!({"action":format!("{mcp_name}_*"),"resource":"*","effect":"allow"}));
        }
    }
    let mut fork_transfer = None;
    let mut fork_native = None;
    let mut fallback_summary = None;
    if pt["nativeThreadRef"].is_null() {
        let candidate = bus
            .commit(|tx| {
                Ok((
                    crate::message_commands::native_fork_candidate_for(
                        tx,
                        &effect.thread_id,
                        instance,
                        "opencode",
                    )?,
                    vec![],
                ))
            })
            .map_err(|e| e.to_string())?;
        if let Some(transfer) = candidate {
            let result = super::opencode_fork::fork(
                bus,
                settings_path.ok_or("Missing provider settings")?,
                &effect.thread_id,
                instance,
                &transfer,
                &cwd,
            )
            .await;
            match result {
                Ok((native, source_thread, source_turn)) => {
                    pt["forkedFrom"] =
                        json!({"providerThreadId":source_thread,"providerTurnId":source_turn});
                    fork_native = Some(native);
                    fork_transfer = Some(transfer);
                }
                Err(_) => {
                    fallback_summary = super::opencode_fork::fallback(
                        bus,
                        &effect.thread_id,
                        &run_id,
                        &key,
                        instance,
                        &now(),
                    )?
                }
            }
        }
    }
    let existing = fork_native
        .as_deref()
        .or_else(|| pt["nativeThreadRef"]["nativeId"].as_str());
    let create = match version {
        OpenCodeVersion::V1 => json!({"title":thread["title"],"permission":rules}),
        OpenCodeVersion::V2 => {
            json!({"location":{"directory":cwd},"model":{"providerID":provider,"id":model_id},"permissions":rules})
        }
    };
    let (session, events) = OpenCodeSession::connect(http, version, existing, create).await?;
    let mut variant = run["modelSelection"]["options"]
        .as_array()
        .and_then(|options| options.iter().find(|entry| entry["id"] == "variant"))
        .and_then(|entry| entry["value"].as_str())
        .map(str::to_owned);
    if variant.is_some() {
        if let Ok(Ok(catalog)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            session.model_catalog(&cwd),
        )
        .await
        {
            let known = match version {
                OpenCodeVersion::V2 => catalog["data"]
                    .as_array()
                    .and_then(|models| {
                        models.iter().find(|entry| {
                            entry["providerID"] == provider && entry["id"] == model_id
                        })
                    })
                    .map(|entry| {
                        entry["variants"].as_array().is_some_and(|variants| {
                            variants
                                .iter()
                                .any(|item| item["id"].as_str() == variant.as_deref())
                        })
                    }),
                OpenCodeVersion::V1 => catalog["all"]
                    .as_array()
                    .or_else(|| catalog["data"]["all"].as_array())
                    .and_then(|providers| providers.iter().find(|entry| entry["id"] == provider))
                    .and_then(|entry| entry["models"].get(model_id))
                    .map(|entry| {
                        entry["variants"].as_object().is_some_and(|variants| {
                            variant
                                .as_ref()
                                .is_some_and(|value| variants.contains_key(value))
                        })
                    }),
            };
            if known == Some(false) {
                variant = None;
            }
        }
    }
    if version == OpenCodeVersion::V2 {
        session
            .switch_agent(if thread["interactionMode"] == "plan" {
                "plan"
            } else {
                "build"
            })
            .await?;
    }
    session.update_permissions(rules.clone()).await?;
    if version == OpenCodeVersion::V2 {
        let mut selected = json!({"providerID":provider,"id":model_id});
        if let Some(variant) = &variant {
            selected["variant"] = json!(variant);
        }
        session.switch_model(selected).await?;
    }
    let mut mcp_available = false;
    if !managed || mcp.is_none() {
        let old = mcp_entries()
            .lock()
            .map_err(|_| "OpenCode MCP lock failed")?
            .remove(&effect.thread_id);
        if let Some(old) = old {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                old.session.remove_mcp(&old.name, &old.directory),
            )
            .await;
        }
    }
    if managed {
        if let Some((endpoint, sessions)) = mcp {
            use sha2::{Digest, Sha256};
            let authorization = sessions.prepare_mcp(
                &effect.thread_id,
                instance,
                thread["lineage"]["relationshipToParent"] == "subagent",
            )?;
            let identity: [u8; 32] =
                Sha256::digest(format!("{endpoint}\0{authorization}\0{cwd}").as_bytes()).into();
            let old = mcp_entries()
                .lock()
                .map_err(|_| "OpenCode MCP lock failed")?
                .remove(&effect.thread_id);
            let fresh = old.as_ref().is_none_or(|entry| entry.identity != identity);
            if let Some(old) = old {
                if fresh {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        old.session.remove_mcp(&old.name, &old.directory),
                    )
                    .await;
                }
            }
            mcp_available = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                session.add_mcp(&mcp_name, &cwd, endpoint, &authorization),
            )
            .await
            .is_ok_and(|result| result.is_ok());
            if mcp_available {
                mcp_entries()
                    .lock()
                    .map_err(|_| "OpenCode MCP lock failed")?
                    .insert(
                        effect.thread_id.clone(),
                        McpEntry {
                            session: session.clone(),
                            name: mcp_name.clone(),
                            directory: cwd.clone(),
                            identity,
                        },
                    );
                if fresh && version == OpenCodeVersion::V2 {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }
    let model_single = model.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut instructions = include_str!("claude_system_prompt.txt").replace(
        "Claude Code harness",
        &format!("OpenCode harness, as {model_single}"),
    );
    if mcp_available {
        instructions.push('\n');
        instructions.push_str(include_str!("opencode_mcp_prompt.txt"));
    }
    if let Some(summary) = fallback_summary {
        instructions.push_str("\n\nPrior conversation context:\n");
        instructions.push_str(&summary);
    }
    if version == OpenCodeVersion::V2 {
        session.set_instructions(&instructions).await?;
    }
    let native = session.native_id().to_owned();
    if cancelled.load(Ordering::Acquire) {
        return Err("OpenCode turn cancelled during startup".into());
    }
    let (prompt_message, side_chat) = side_chat_prompt(bus, &run, &thread, &message)?;
    let (text, files) =
        super::opencode_attachments::build(&prompt_message, attachments, version, !managed)?;
    if text.is_empty() && files.is_empty() {
        return Err("OpenCode turns require text or at least one valid attachment".into());
    }
    let attempt = field(&run, "activeAttemptId")?.to_owned();
    let prompt_id = if version == OpenCodeVersion::V1 {
        v1_message_id()
    } else {
        format!("msg_t3_turn_{native}:{attempt}")
    };
    let mut prompt_body = match version {
        OpenCodeVersion::V1 => {
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(json!({"type":"text","text":text}));
            }
            parts.extend(files);
            let mut body = json!({"model":{"providerID":provider,"modelID":model_id},"agent":if thread["interactionMode"]=="plan" {"plan"} else {"build"},"parts":parts,"system":instructions});
            body["messageID"] = json!(prompt_id);
            if let Some(variant) = &variant {
                body["variant"] = json!(variant);
            }
            body
        }
        OpenCodeVersion::V2 => {
            let mut body = json!({"id":prompt_id,"text":text});
            if !files.is_empty() {
                body["files"] = json!(files);
            }
            body
        }
    };
    if side_chat.is_empty() && (version == OpenCodeVersion::V1
        || message["attachments"]
            .as_array()
            .is_none_or(|items| items.is_empty()))
    {
        let text = message["text"].as_str().unwrap_or("").trim();
        if version == OpenCodeVersion::V2 && text == "/compact" {
            prompt_body = json!({"_t3_submit":"compact","id":prompt_id});
        } else if let Some(command) = text.strip_prefix('/').filter(|value| !value.is_empty()) {
            let (name, args) = command
                .split_once(char::is_whitespace)
                .unwrap_or((command, ""));
            if session.known_command(&cwd, name).await {
                if version == OpenCodeVersion::V2 {
                    let history = session.history(None).await?;
                    let items = history["data"]
                        .as_array()
                        .ok_or("Invalid OpenCode message history")?;
                    let before = items.first().and_then(|item| item["id"].as_str());
                    prompt_body = json!({"_t3_submit":"command","name":name,"text":args.trim_start(),"_t3_before":before});
                } else {
                    let parts = prompt_body["parts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|part| part["type"] == "file")
                        .cloned()
                        .collect::<Vec<_>>();
                    let mut native = json!({"messageID":prompt_id,"command":name,"arguments":args.trim_start(),"model":model,"agent":prompt_body["agent"],"parts":parts});
                    if let Some(variant) = &variant {
                        native["variant"] = json!(variant);
                    }
                    prompt_body = json!({"_t3_submit":"command","_t3_native":native});
                }
            }
        }
    }
    if version == OpenCodeVersion::V2 && prompt_body["_t3_submit"].is_null() {
        let mentions =
            super::opencode_session::skill_mentions(message["text"].as_str().unwrap_or(""));
        let skills = session.known_skills(&cwd, &mentions).await;
        if !skills.is_empty() {
            prompt_body["skills"] = json!(skills
                .into_iter()
                .map(|id| json!({"id":id}))
                .collect::<Vec<_>>());
        }
    }
    let at = now();
    let native_turn = if version == OpenCodeVersion::V2 {
        prompt_id.clone()
    } else {
        format!("{native}:attempt:{attempt}")
    };
    let native_turn_id = format!("{native}:attempt:{attempt}");
    let turn = RootTurn {
        driver: "opencode".into(),
        native_thread_id: native.clone(),
        native_turn_id: native_turn.clone(),
        provider_thread_id: key.clone(),
        provider_turn_id: format!(
            "provider-turn:provider:opencode:native-turn:{}",
            crate::message_commands::encode_id_part(&native_turn_id)
        ),
        thread_id: effect.thread_id.clone(),
        run_id: Some(run_id),
        run_attempt_id: field(&run, "activeAttemptId")?.into(),
        root_node_id: field(&run, "rootNodeId")?.into(),
        provider_turn_ordinal: ordinal,
        run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
        started_at: at.clone(),
    };
    let caps = capabilities(version);
    let provider_session = field(&pt, "providerSessionId")?.to_owned();
    if cancelled.load(Ordering::Acquire) {
        return Err("OpenCode turn cancelled during startup".into());
    }
    if let Some(transfer) = fork_transfer.as_ref() {
        lifecycle::start_with_fork(bus, &turn, pt, &run, Some(&cwd), caps.clone(), transfer)?;
    } else {
        lifecycle::start(bus, &turn, pt, &run, Some(&cwd), caps.clone())?;
    }
    crate::message_commands::deliver_deferred(bus, &effect.thread_id, &turn.run_attempt_id, &at)
        .map_err(|e| e.to_string())?;
    let steer_state = Arc::new(Mutex::new(SteerState::default()));
    steering()
        .lock()
        .map_err(|_| "OpenCode steering lock failed")?
        .insert(key.clone(), steer_state.clone());
    {
        let mut map = active()
            .lock()
            .map_err(|_| "OpenCode session lock failed")?;
        let value = map.get_mut(&key).ok_or("OpenCode turn no longer active")?;
        value.session = Some(session.clone());
    }
    admission.armed = false;
    let bus = bus.clone();
    let done_cancelled = cancelled.clone();
    watchers()
        .lock()
        .map_err(|_| "OpenCode watcher registry unavailable")?
        .push(Watcher {
            thread: turn.thread_id.clone(),
            provider_session: provider_session.clone(),
            identity: identity.clone(),
            cancelled: cancelled.clone(),
            notify: cancel_notify.clone(),
            steer_state: Some(steer_state.clone()),
        });
    tokio::spawn(async move {
        supervise(
            bus,
            turn,
            session,
            events,
            prompt_body,
            provider_session,
            instance_id,
            cancelled,
            interrupt_ready,
            cancel_notify,
            caps,
            identity,
            if version == OpenCodeVersion::V1 {
                Some(prompt_id)
            } else {
                None
            },
            cwd,
            steer_state.clone(),
            side_chat,
        )
        .await;
        if let Ok(mut entries) = watchers().lock() {
            entries.retain(|entry| !Arc::ptr_eq(&entry.cancelled, &done_cancelled));
        }
        if let Ok(mut map) = active().lock() {
            if map
                .get(&key)
                .is_some_and(|value| Arc::ptr_eq(&value.cancelled, &done_cancelled))
            {
                map.remove(&key);
            }
        }
        if let Ok(mut map) = steering().lock() {
            if map
                .get(&key)
                .is_some_and(|value| Arc::ptr_eq(value, &steer_state))
            {
                map.remove(&key);
            }
        }
    });
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn supervise(
    bus: EventBus,
    mut turn: RootTurn,
    session: OpenCodeSession,
    mut events: super::opencode_http::OpenCodeEvents,
    prompt_body: Value,
    provider_session: String,
    instance_id: String,
    cancelled: Arc<AtomicBool>,
    interrupt_ready: Arc<tokio::sync::Notify>,
    cancel_notify: Arc<tokio::sync::Notify>,
    capabilities: Value,
    identity: Option<String>,
    v1_expected: Option<String>,
    cwd: String,
    steer_state: Arc<Mutex<SteerState>>,
    mut side_chat: Vec<Value>,
) {
    let mut decoder = Decoder::new(session.native_id().to_owned());
    let mut projector = Projector::new(turn.clone());
    let prompt_session = session.clone();
    if cancelled.load(Ordering::Acquire) {
        interrupt_ready.notify_one();
        let mut projector = Projector::new(turn.clone());
        if let Ok(values) = projector.project(Update::Terminal("interrupted"), &now()) {
            let _ = ingest::ingest(&bus, &values);
        }
        return;
    }
    let version = session.version();
    let command_before = if prompt_body["_t3_submit"] == "command" {
        Some(prompt_body["_t3_before"].as_str().map(str::to_owned))
    } else {
        None
    };
    let prompt = tokio::spawn(async move { prompt_session.prompt(prompt_body).await });
    tokio::pin!(prompt);
    let mut prompt_done = false;
    let mut prompt_id: Option<String> = None;
    let mut replay = std::collections::VecDeque::<Value>::new();
    let mut seen_requests = std::collections::HashSet::<String>::new();
    let mut children = HashMap::<String, Child>::new();
    let mut tree = super::opencode_tree::Tree::new(session.native_id().to_owned());
    let mut observed_children = std::collections::HashSet::<String>::new();
    let mut child_backlog = HashMap::<String, Vec<Value>>::new();
    let mut request_targets = HashMap::<String, (String, String)>::new();
    let mut terminal = false;
    let mut stream_failed = false;
    let mut missing_native = false;
    let mut held_terminal = None::<&'static str>;
    let steer_notify = match steer_state.lock() {
        Ok(state) => state.notify.clone(),
        Err(_) => return,
    };
    let mut pending_wake: Option<(String, String, std::time::Instant)> = None;
    let mut wake_buffer = std::collections::VecDeque::<Value>::new();
    let mut wake_buffer_bytes = 0usize;
    let mut request_ordinal = turn
        .run_ordinal
        .saturating_mul(1_000_000)
        .saturating_add(500_000);
    let mut todo_ordinal = None;
    let mut image_jobs = HashMap::<String, ImageJob>::new();
    let mut shell_jobs = HashMap::<String, ShellJob>::new();
    let mut owned_shells = std::collections::HashSet::<String>::new();
    let mut early_shell_exits = HashMap::<String, Value>::new();
    let (callback_errors, mut callback_failure) = tokio::sync::mpsc::unbounded_channel::<()>();
    'supervisor: while !terminal
        || children
            .values()
            .any(|child| child.background && !child.call_finished)
        || pending_wake.is_some()
        || !image_jobs.is_empty()
        || !shell_jobs.is_empty()
    {
        tokio::select! {
            _=steer_notify.notified(), if held_terminal.is_some() => {
                if steer_state.lock().is_ok_and(|state|state.pending.is_empty()) {
                    if version==OpenCodeVersion::V1 {
                        let status=tokio::select! {_=cancel_notify.notified()=>None,result=tokio::time::timeout(std::time::Duration::from_secs(5),session.is_active())=>result.ok().and_then(Result::ok)};
                        if let Some(active)=status {
                            if active {held_terminal=None;}else if let Some(status)=held_terminal.take(){replay.push_front(json!({"type":if status=="completed" {"session.status"}else{"session.error"},"properties":{"sessionID":session.native_id(),"status":{"type":"idle"}}}));}
                        }
                    } else if let Some(status)=held_terminal.take(){let kind=if status=="completed" {"succeeded"}else if status=="interrupted" {"interrupted"}else{"failed"};replay.push_front(json!({"type":format!("session.execution.{kind}"),"data":{"sessionID":session.native_id()}}));}
                }
            }
            _=cancel_notify.notified(), if terminal && !steer_state.lock().is_ok_and(|state|state.preserve_background) => { if cancelled.load(Ordering::Acquire) { break 'supervisor; } }
            _=tokio::time::sleep(std::time::Duration::from_millis(100)), if pending_wake.is_some() => {
                let (id,detail,since)=pending_wake.as_ref().expect("wake checked");
                if since.elapsed()>std::time::Duration::from_secs(30) {break 'supervisor;}
                match super::wake::create(&bus,&turn,id,Some(detail),None,&now()) {
                    Ok(Some((next,run,provider,cwd)))=>{
                        if lifecycle::start(&bus,&next,provider,&run,cwd.as_deref(),capabilities.clone()).is_err(){break 'supervisor;}
                        if let Ok(mut active)=active().lock(){active.insert(next.provider_thread_id.clone(),Active{thread:next.thread_id.clone(),provider_session:provider_session.clone(),identity:identity.clone(),session:Some(session.clone()),cancelled:cancelled.clone(),interrupt_ready:interrupt_ready.clone(),cancel_notify:cancel_notify.clone()});}
                        turn=next;projector=Projector::new(turn.clone());terminal=false;pending_wake=None;
                        request_ordinal=turn.run_ordinal.saturating_mul(1_000_000).saturating_add(500_000);
                        todo_ordinal=None;
                        if let Ok(mut state)=steer_state.lock(){state.pending.clear();state.accepted.clear();state.observed.clear();state.terminal=false;}
                        while let Some(value)=wake_buffer.pop_back(){replay.push_front(value);}
                        wake_buffer_bytes=0;
                    }
                    Ok(None)=>{
                        let other=bus.commit(|tx| {let id:Option<String>=tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[&turn.thread_id],|row|row.get(0)).optional()?;Ok((id,vec![]))}).ok().flatten();
                        if other.as_deref().is_some_and(|id|Some(id)!=turn.run_id.as_deref()){break 'supervisor;}
                    }
                    Err(_)=>break 'supervisor,
                }
            }
            Some(())=callback_failure.recv() => {break 'supervisor;}
            result=&mut prompt, if !prompt_done => {
                prompt_done=true;
                match result {Ok(Ok(value))=>{prompt_id=value["data"]["id"].as_str().or_else(||value["id"].as_str()).map(str::to_owned); for handoff in std::mem::take(&mut side_chat) { if let Err(error)=super::executor::record_side_chat_delivery(&bus,&turn,handoff) {eprintln!("Warning: failed to record accepted OpenCode side-chat context delivery: {error}");} }},_=>break 'supervisor}
            }
            event=async {if let Some(event)=replay.pop_front(){Ok(event)}else{events.next().await}} => {
                let event=match event {
                    Ok(event)=>event,
                    Err(_)=>{
                        if version!=OpenCodeVersion::V2 {
                            stream_failed = !cancelled.load(Ordering::Acquire);
                            break 'supervisor;
                        }
                        if cancelled.load(Ordering::Acquire) {break 'supervisor;}
                        if !prompt_done {
                            prompt_done=true;
                            match tokio::time::timeout(std::time::Duration::from_secs(3),&mut prompt).await {
                                Ok(Ok(Ok(value)))=>{prompt_id=value["data"]["id"].as_str().or_else(||value["id"].as_str()).map(str::to_owned); for handoff in std::mem::take(&mut side_chat) { if let Err(error)=super::executor::record_side_chat_delivery(&bus,&turn,handoff) {eprintln!("Warning: failed to record accepted OpenCode side-chat context delivery: {error}");} }},
                                _=>break 'supervisor,
                            }
                        }
                        if prompt_id.is_none() && command_before.is_none() {break 'supervisor;}
                        let mut recovered=None;
                        for _ in 0..5 {
                            if cancelled.load(Ordering::Acquire){break;}
                            tokio::select! { _=cancel_notify.notified()=>break, _=tokio::time::sleep(std::time::Duration::from_secs(2))=>{} }
                            if cancelled.load(Ordering::Acquire) {break;}
                            let recovery = async {
                                let (events, mut updates) = if terminal {
                                    let events=session.reconnect().await?;
                                    let sessions=image_jobs.values().map(|job|job.session_id.clone()).collect::<std::collections::HashSet<_>>();
                                    let mut reports=Vec::new();for native in sessions {reports.extend(super::opencode_reconnect::recover_image_reports(&session.for_native(&native)).await?);}
                                    (events, reports)
                                } else {
                                    if let Some(before)=&command_before {
                                        super::opencode_reconnect::recover_before(&session,before.as_deref()).await?
                                    } else {
                                        super::opencode_reconnect::recover(&session,prompt_id.as_deref().ok_or("Missing OpenCode prompt boundary")?).await?
                                    }
                                };
                                for (id,job) in &shell_jobs {
                                    if let Ok(Ok(info))=tokio::time::timeout(std::time::Duration::from_secs(3),session.shell_info(id,&job.cwd)).await {
                                        if matches!(info["data"]["status"].as_str(),Some("exited"|"timeout"|"killed")) {
                                            updates.push(json!({"type":"shell.exited","data":{"id":id,"status":info["data"]["status"],"exit":info["data"]["exit"]}}));
                                        }
                                    }
                                }
                                let requests=children.iter().filter_map(|(child_id,child)| {
                                    if child.finished {return None;}
                                    let boundary=child.boundary.clone()?;
                                    let child_id=child_id.clone();
                                    let background=child.background;
                                    let child_session=session.for_native(&child_id);
                                    Some(async move {
                                        let result=tokio::time::timeout(std::time::Duration::from_secs(5),super::opencode_reconnect::recover_history(&child_session,&boundary)).await;
                                        (child_id,background,result)
                                    })
                                });
                                for (child_id,background,result) in futures_util::future::join_all(requests).await {
                                    let Ok(Ok(recovered))=result else {continue;};
                                    let ended=recovered.iter().any(|event|matches!(event["type"].as_str(),Some("session.execution.succeeded"|"session.execution.failed"|"session.execution.interrupted"|"t3.reconnect.failed"|"t3.reconnect.missing")));
                                    if ended && background {
                                        updates.extend(recovered.into_iter().filter(|event| !matches!(event["type"].as_str(),Some("session.execution.succeeded"|"session.execution.failed"|"session.execution.interrupted"|"t3.reconnect.failed"|"t3.reconnect.missing"))));
                                        updates.push(json!({"type":"t3.background.recovered","data":{"sessionID":child_id}}));
                                    } else {
                                        updates.extend(recovered);
                                    }
                                }
                                Ok::<_,String>((events,updates))
                            };
                            let result=tokio::select! { _=cancel_notify.notified()=>break, result=tokio::time::timeout(std::time::Duration::from_secs(15),recovery)=>result };
                            if cancelled.load(Ordering::Acquire) {break;}
                            if let Ok(Ok(value))=result {recovered=Some(value);break;}
                        }
                        if cancelled.load(Ordering::Acquire) {break 'supervisor;}
                        if let Some((next,updates))=recovered {events=next;replay.extend(updates);continue;} else {break 'supervisor;}
                    }
                };
                if event["type"]=="t3.reconnect.missing" {missing_native=true;}
                if version==OpenCodeVersion::V1 && event["type"]=="message.updated" && event["properties"]["sessionID"].as_str()==Some(session.native_id()) && event["properties"]["info"]["role"]=="user" && event["properties"]["info"]["id"].as_str()==v1_expected.as_deref() && turn.native_turn_id!=event["properties"]["info"]["id"].as_str().unwrap_or("") {
                    turn.native_turn_id=v1_expected.clone().expect("matching expected message");
                    projector.set_native_turn_id(&turn.native_turn_id);
                    if ingest::ingest(&bus,&[crate::provider::codex_events::NormalizedEvent::ProviderTurnUpdated{turn:turn.clone(),status:crate::provider::codex_events::TurnStatus::Running,completed_at:None}]).is_err(){break 'supervisor;}
                }
                if version==OpenCodeVersion::V1 && event["type"]=="message.updated" && event["properties"]["sessionID"].as_str()==Some(session.native_id()) && event["properties"]["info"]["role"]=="user" {
                    if let Some(id)=event["properties"]["info"]["id"].as_str(){if let Ok(mut state)=steer_state.lock(){if state.pending.contains(id){state.observed.insert(id.to_owned());if state.accepted.remove(id){state.observed.remove(id);state.pending.remove(id);state.notify.notify_one();}}}}
                }
                if version==OpenCodeVersion::V2 {
                    let data=&event["data"];
                    if matches!(event["type"].as_str(),Some("session.inbox.delivered"|"session.inbox.cancelled")) && data["sessionID"].as_str()==Some(session.native_id()) {
                        if let Some(id)=data["inboxID"].as_str(){if let Ok(mut state)=steer_state.lock(){if state.pending.remove(id) && event["type"]=="session.inbox.cancelled" {state.notify.notify_one();}}}
                    }
                    if event["type"]=="shell.created" {
                        let owner=data["info"]["metadata"]["sessionID"].as_str();
                        if terminal && steer_state.lock().is_ok_and(|state|state.preserve_background)
                            && !owner.is_some_and(|id|children.contains_key(id)) { continue; }
                        if owner==Some(session.native_id()) || owner.is_some_and(|owner|children.contains_key(owner)) {
                            if let Some(id)=data["info"]["id"].as_str() {if owned_shells.len()<1024 {owned_shells.insert(id.to_owned());}}
                        }
                        continue;
                    }
                    if matches!(event["type"].as_str(),Some("shell.exited"|"shell.deleted")) {
                        if let Some(id)=data["id"].as_str() {
                            if let Some(mut job)=shell_jobs.remove(id) {
                                owned_shells.remove(id);
                                tokio::select! {_=cancel_notify.notified(), if !steer_state.lock().is_ok_and(|state|state.preserve_background)=>{},_=read_shell(&session,id,&mut job,true)=>{}}
                                let exit=data["exit"].as_i64();let status=if event["type"]=="shell.deleted" || data["status"]=="killed" {"interrupted"}else if exit.is_some_and(|code|code==0){"completed"}else{"failed"};
                                let mut fields=json!({"input":job.command,"output":job.output,"nativeItemRef":{"driver":"opencode","nativeId":id,"strength":"strong"}});if let Some(code)=exit {fields["exitCode"]=json!(code);}
                                let started_at=job.turn.started_at.clone();let artifact=crate::provider::codex_events::ToolArtifact{turn:job.turn,native_item_id:job.id,ordinal:job.ordinal,started_at,updated_at:now(),status:status.into(),kind:"command_execution".into(),fields};
                                if ingest::ingest(&bus,&[crate::provider::codex_events::NormalizedEvent::ToolUpdated(artifact)]).is_err(){break 'supervisor;}
                            } else if owned_shells.contains(id) && early_shell_exits.len()<1024 {
                                early_shell_exits.insert(id.to_owned(),event.clone());
                            }
                        }
                        continue;
                    }
                    if event["type"]=="session.inbox.enqueued" && data["item"]["type"]=="synthetic" && data["item"]["payload"]["metadata"]["source"]=="experimental_image_generate" {
                        let payload=&data["item"]["payload"];
                        let state=payload["metadata"]["state"].as_str();
                        if let (Some(job_id),Some(status))=(payload["metadata"]["jobID"].as_str(),state.and_then(|value|match value {"completed"=>Some("completed"),"error"=>Some("failed"),"cancelled"=>Some("interrupted"),_=>None})) {
                            let key=format!("{}:{job_id}",data["sessionID"].as_str().unwrap_or(""));
                            if let Some(job)=image_jobs.remove(&key) {
                                let text=payload["text"].as_str().unwrap_or("");
                                let preview=if status=="completed" {tokio::select! {_=cancel_notify.notified(), if !steer_state.lock().is_ok_and(|state|state.preserve_background)=>None,value=image_preview(&session,&job,text)=>value}} else {None};
                                let output=if let Some(image)=preview {json!({"content":[{"type":"text","text":text},image]})} else {json!(text)};
                                let started_at=job.turn.started_at.clone();
                                let artifact=crate::provider::codex_events::ToolArtifact{turn:job.turn,native_item_id:job.id,ordinal:job.ordinal,started_at,updated_at:now(),status:status.into(),kind:"dynamic_tool".into(),fields:json!({"toolName":"experimental_image_generate","input":job.input,"output":output})};
                                if ingest::ingest(&bus,&[crate::provider::codex_events::NormalizedEvent::ToolUpdated(artifact)]).is_err(){break 'supervisor;}
                            }
                        }
                        continue;
                    }
                    if event["type"]=="t3.background.recovered" {
                        if let Some(child_id)=data["sessionID"].as_str() {
                            if let Some(child)=children.get_mut(child_id) {
                                if !child.finished {
                                    if super::opencode_subagents::finish_child(&bus,&child.turn,"interrupted",&now()).is_err(){break 'supervisor;}
                                    child.finished=true;tree.finish(child_id);
                                    if let Ok(mut active)=active_children().lock(){active.remove(&child.turn.provider_thread_id);}
                                }
                                if !child.call_finished {
                                    let lost="T3 Code lost its connection to OpenCode while this subagent ran, so its result is not shown.";
                                    if super::opencode_subagents::finish_call(&bus,&child.parent,&instance_id,child_id,&child.call,"interrupted",Some(lost),&now()).is_err(){break 'supervisor;}
                                    child.call_finished=true;
                                }
                            }
                        }
                        continue;
                    }
                    if pending_wake.is_some() && data["sessionID"].as_str()==Some(session.native_id()) {
                        let size=event.to_string().len();
                        if wake_buffer.len()>=4096 || wake_buffer_bytes.saturating_add(size)>16*1024*1024 {break 'supervisor;}
                        wake_buffer_bytes+=size;wake_buffer.push_back(event);continue;
                    }
                    if event["type"]=="session.inbox.enqueued" && data["item"]["type"]=="synthetic" && data["item"]["payload"]["metadata"]["source"]=="subagent" {
                        let child_id=data["item"]["payload"]["metadata"]["childID"].as_str().unwrap_or("");
                        if let Some(child)=children.get_mut(child_id) {
                            let outcome=match data["item"]["payload"]["metadata"]["state"].as_str(){Some("completed")=>"completed",Some("cancelled")=>"interrupted",_=>"failed"};
                            if !child.finished {let _=super::opencode_subagents::finish_child(&bus,&child.turn,outcome,&now());child.finished=true;tree.finish(child_id);}
                            if !child.call_finished {let result=data["item"]["payload"]["text"].as_str().or(Some(child.result.as_str()));if super::opencode_subagents::finish_call(&bus,&child.parent,&instance_id,child_id,&child.call,outcome,result,&now()).is_err(){break 'supervisor;}child.call_finished=true;}
                            if terminal && data["sessionID"].as_str()==Some(session.native_id()) {
                                let id=data["inboxID"].as_str().unwrap_or(child_id).to_owned();let detail=data["item"]["payload"]["description"].as_str().unwrap_or("Background subagent completed").to_owned();
                                pending_wake=Some((id,detail,std::time::Instant::now()));
                            }
                        }
                    }
                    // A restarted turn has a new supervisor on the same native session.
                    // This watcher retains only its existing background work, so root
                    // events from the replacement turn must not reach its projector.
                    if terminal && steer_state.lock().is_ok_and(|state|state.preserve_background)
                        && data["sessionID"].as_str().or_else(||data["form"]["sessionID"].as_str()).is_none_or(|id|id==session.native_id()) {
                        continue;
                    }
                    if event["type"]=="session.created" && data["parentID"].as_str().is_some_and(|parent|tree.contains(parent)||observed_children.contains(parent)) {
                        if let Some(id)=data["sessionID"].as_str(){observed_children.insert(id.to_owned());}
                    }
                    let source=data["sessionID"].as_str().or_else(||data["form"]["sessionID"].as_str()).filter(|source|*source!=session.native_id()).map(str::to_owned);
                    if let Some(source)=source {
                        if let Some(child)=children.get_mut(&source) {
                            let is_permission=event["type"]=="permission.asked";
                            let is_form=event["type"]=="form.created";
                            if is_permission || is_form {
                                let native=if is_form {data["form"]["id"].as_str()} else {data["id"].as_str()};
                                let Some(native)=native else {break 'supervisor};
                                request_targets.insert(native.to_owned(),(source.clone(),super::opencode_subagents::call_node(&child.call)));
                                let mut translated=event;
                                if is_form {translated["data"]["form"]["sessionID"]=json!(session.native_id());}else{translated["data"]["sessionID"]=json!(session.native_id());}
                                replay.push_front(translated);
                            } else {
                                let parent_turn=child.turn.clone();
                                let nested=match handle_child(&bus,child,&event,version){Ok(value)=>value,Err(_)=>break 'supervisor};
                                if child.finished {tree.finish(&source);if let Ok(mut active)=active_children().lock(){active.remove(&child.turn.provider_thread_id);}}
                                for update in nested {
                                    // The original keeps the background child alive across restart,
                                    // but does not project shell calls started by that child after
                                    // its parent attempt was interrupted.
                                    if terminal && steer_state.lock().is_ok_and(|state|state.preserve_background)
                                        && matches!(&update,Update::Tool{name,..} if name=="shell") {continue;}
                                    if matches!(&update,Update::Tool{name,..} if name=="shell") {
                                        let mut update=update;
                                        if let Some(child)=children.get_mut(&source) {
                                            if track_shell(&mut update,&child.turn,&mut child.projector,&mut shell_jobs,&mut early_shell_exits,&mut replay,&session,&cwd,&cancel_notify).await.is_err(){break 'supervisor;}
                                            match child.projector.project(update,&now()){Ok(values)=>if ingest::ingest(&bus,&values).is_err(){break 'supervisor},Err(_)=>break 'supervisor}
                                        }
                                        continue;
                                    }
                                    if matches!(&update,Update::Tool{name,..} if name=="experimental_image_generate") {
                                        let mut update=update;
                                        if let Some(child)=children.get_mut(&source) {
                                            if track_image(&mut update,&child.turn,&mut child.projector,&mut image_jobs,&source,&cwd).is_err(){break 'supervisor;}
                                            match child.projector.project(update,&now()){Ok(values)=>if ingest::ingest(&bus,&values).is_err(){break 'supervisor},Err(_)=>break 'supervisor}
                                        }
                                        continue;
                                    }
                                    if let Update::Tool{id,name:_,input,output,status,child_session:Some(child_id),..}=update {
                                        let is_new=match tree.link(&source,&child_id,&id,input["background"]==true){Ok(value)=>value,Err(_)=>break 'supervisor};
                                        if is_new {
                                            let ordinal=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);
                                            let child_turn=match super::opencode_subagents::attach(&bus,&parent_turn,&instance_id,&provider_session,&id,&child_id,&input,ordinal,&now()){Ok(value)=>value,Err(_)=>break 'supervisor};
                                            let child=Child {decoder:Decoder::with_scope(child_id.clone()),projector:Projector::child(child_turn.clone(),input["prompt"].as_str().is_some_and(|value|!value.is_empty())),turn:child_turn,parent:parent_turn.clone(),call:id.clone(),finished:false,call_finished:false,background:input["background"]==true,result:String::new(),boundary:None};
                                            if let Some(events)=child_backlog.remove(&child_id){for event in events.into_iter().rev(){replay.push_front(event);}}
                                            if let Ok(mut active)=active_children().lock(){active.insert(child.turn.provider_thread_id.clone(),ChildActive{thread:turn.thread_id.clone(),provider_session:provider_session.clone(),generation:cancelled.clone(),session:session.for_native(&child_id)});}
                                children.insert(child_id.clone(),child);
                                        }
                                        if matches!(status,"completed"|"failed") && !(status=="completed" && children.get(&child_id).is_some_and(|child|child.background)) {
                                            let result=output.as_array().map(|parts|parts.iter().filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("\n"));
                                            if super::opencode_subagents::finish_call(&bus,&parent_turn,&instance_id,&child_id,&id,status,result.as_deref(),&now()).is_err(){break 'supervisor;}
                                            if let Some(child)=children.get_mut(&child_id){child.call_finished=true;}
                                        }
                                    }
                                }
                            }
                        } else if observed_children.contains(&source) {
                            let backlog=child_backlog.entry(source).or_default();
                            if backlog.len()>=1024 {break 'supervisor;}
                            backlog.push(event);
                        }
                        continue;
                    }
                }
                if version==OpenCodeVersion::V1 {
                    if let Some(source)=event["properties"]["sessionID"].as_str().filter(|source|*source!=session.native_id()) {
                        if let Some(child)=children.get_mut(source) {
                            if event["type"]=="permission.asked" || event["type"]=="question.asked" {
                                if let Some(id)=event["properties"]["id"].as_str() {
                                    request_targets.insert(id.to_owned(),(source.to_owned(),child.turn.root_node_id.clone()));
                                    let mut translated=event.clone();translated["properties"]["sessionID"]=json!(session.native_id());replay.push_front(translated);
                                }
                            } else {
                                let parent_turn=child.turn.clone();
                                let nested=match handle_child(&bus,child,&event,version){Ok(value)=>value,Err(_)=>break 'supervisor};
                                if child.finished {tree.finish(source);if let Ok(mut active)=active_children().lock(){active.remove(&child.turn.provider_thread_id);}}
                                for update in nested {
                                    if let Update::Tool{id,input,output,status,child_session:Some(child_id),..}=update {
                                        let is_new=match tree.link(source,&child_id,&id,false){Ok(value)=>value,Err(_)=>break 'supervisor};
                                        if is_new {
                                            let ordinal=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);
                                            let child_turn=match super::opencode_subagents::attach(&bus,&parent_turn,&instance_id,&provider_session,&id,&child_id,&input,ordinal,&now()){Ok(value)=>value,Err(_)=>break 'supervisor};
                                            let nested_child=Child{decoder:Decoder::with_scope(child_id.clone()),projector:Projector::child(child_turn.clone(),input["prompt"].as_str().is_some_and(|value|!value.is_empty())),turn:child_turn,parent:parent_turn.clone(),call:id.clone(),finished:false,call_finished:false,background:false,result:String::new(),boundary:None};
                                            if let Ok(mut active)=active_children().lock(){active.insert(nested_child.turn.provider_thread_id.clone(),ChildActive{thread:turn.thread_id.clone(),provider_session:provider_session.clone(),generation:cancelled.clone(),session:session.for_native(&child_id)});}
                                            children.insert(child_id.clone(),nested_child);
                                        }
                                        if matches!(status,"completed"|"failed") {
                                            if super::opencode_subagents::finish_call(&bus,&parent_turn,&instance_id,&child_id,&id,status,output.as_str(),&now()).is_err(){break 'supervisor;}
                                            if let Some(nested_child)=children.get_mut(&child_id){nested_child.call_finished=true;}
                                        }
                                    }
                                }
                            }
                        } else if event["type"]=="permission.asked" || event["type"]=="question.asked" {
                            let source=source.to_owned();
                            let mut cursor=source.clone();let mut owned=false;
                            for _ in 0..5 {
                                let parent=tokio::select! {_=cancel_notify.notified()=>None,result=tokio::time::timeout(std::time::Duration::from_secs(5),session.v1_parent(&cursor))=>result.ok().and_then(Result::ok).flatten()};
                                let Some(parent)=parent else {break};
                                if parent==session.native_id() {owned=true;break;}
                                if children.contains_key(&parent) {owned=true;break;}
                                cursor=parent;
                            }
                            if owned && !cancelled.load(Ordering::Acquire) {
                                if let Some(id)=event["properties"]["id"].as_str() {
                                    request_targets.insert(id.to_owned(),(source,turn.root_node_id.clone()));
                                    let mut translated=event.clone();translated["properties"]["sessionID"]=json!(session.native_id());replay.push_front(translated);
                                }
                            }
                        }
                        continue;
                    }
                }
                if version==OpenCodeVersion::V1 && event["type"]=="todo.updated" && event["properties"]["sessionID"].as_str()==Some(session.native_id()) {
                    if let Some(todos)=event["properties"]["todos"].as_array() {
                        let ordinal=*todo_ordinal.get_or_insert_with(||{let value=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);value});
                        let native=format!("{}:todo:{}",session.native_id(),turn.provider_turn_id);
                        if super::plan_projection::todo(&bus,&turn,&native,todos,ordinal,&now(),false).is_err(){break 'supervisor;}
                    }
                    continue;
                }
                let decoded=match version {OpenCodeVersion::V1=>decoder.event_v1(&event),OpenCodeVersion::V2=>decoder.event(&event)};
                let Ok(update)=decoded else {break 'supervisor};
                let updates=update.into_iter().chain(decoder.drain_ready());
                for update in updates {
                let mut update=cancellation_terminal(update,cancelled.load(Ordering::Acquire));
                if let Update::Terminal(status)=&update {
                    let Ok(mut state)=steer_state.lock() else {break 'supervisor};
                    if !state.pending.is_empty() && !cancelled.load(Ordering::Acquire) {held_terminal=Some(*status);continue;}
                    held_terminal=None;
                    state.terminal=true;
                    if state.preserve_background {if let Ok(mut active)=active().lock(){if active.get(&turn.provider_thread_id).is_some_and(|entry|Arc::ptr_eq(&entry.cancelled,&cancelled)){active.remove(&turn.provider_thread_id);}}}
                }
                if version==OpenCodeVersion::V2 && track_shell(&mut update,&turn,&mut projector,&mut shell_jobs,&mut early_shell_exits,&mut replay,&session,&cwd,&cancel_notify).await.is_err(){break 'supervisor;}
                if version==OpenCodeVersion::V2 && track_image(&mut update,&turn,&mut projector,&mut image_jobs,session.native_id(),&cwd).is_err(){break 'supervisor;}
                if let Update::Tool{name,status,..}=&update {
                    if version==OpenCodeVersion::V2 && name=="todowrite" {
                        if *status=="running" {continue;}
                        if *status=="completed" {
                            if let Some(todos)=event["data"]["metadata"]["todos"].as_array().filter(|items|items.iter().all(|item|item["content"].is_string() && matches!(item["status"].as_str(),Some("pending"|"in_progress"|"completed"|"cancelled")))) {
                                let ordinal=*todo_ordinal.get_or_insert_with(||{let value=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);value});
                                let native=format!("{}:todo:{}",session.native_id(),turn.provider_turn_id);
                                if super::plan_projection::todo(&bus,&turn,&native,todos,ordinal,&now(),true).is_err(){break 'supervisor;}
                                continue;
                            }
                        }
                    }
                }
                match update {
                    Update::Started => { interrupt_ready.notify_one(); }
                    Update::Tool { ref id, ref name, ref input, ref output, status, ref child_session, .. } if (version==OpenCodeVersion::V2 && name=="subagent") || (version==OpenCodeVersion::V1 && name=="task") => {
                        if let Some(child_id)=child_session {
                            if !children.contains_key(child_id) {
                                if tree.link(session.native_id(),child_id,id,input["background"]==true).is_err(){break 'supervisor;}
                                let ordinal=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);
                                let child_turn=match super::opencode_subagents::attach(&bus,&turn,&instance_id,&provider_session,id,child_id,input,ordinal,&now()) {Ok(value)=>value,Err(_)=>break 'supervisor};
                                let child=Child {decoder:Decoder::with_scope(child_id.clone()),projector:Projector::child(child_turn.clone(),input["prompt"].as_str().is_some_and(|value|!value.is_empty())),turn:child_turn,parent:turn.clone(),call:id.clone(),finished:false,call_finished:false,background:input["background"]==true,result:String::new(),boundary:None};
                                if let Some(events)=child_backlog.remove(child_id) {for event in events.into_iter().rev(){replay.push_front(event);}}
                                if let Ok(mut active)=active_children().lock(){active.insert(child.turn.provider_thread_id.clone(),ChildActive{thread:turn.thread_id.clone(),provider_session:provider_session.clone(),generation:cancelled.clone(),session:session.for_native(child_id)});}
                                children.insert(child_id.clone(),child);
                            }
                            if matches!(status,"completed"|"failed") && !(status=="completed" && children.get(child_id).is_some_and(|child|child.background)) {
                                let result=output.as_array().map(|parts|parts.iter().filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("\n")).or_else(||output.as_str().map(str::to_owned));
                                if super::opencode_subagents::finish_call(&bus,&turn,&instance_id,child_id,id,status,result.as_deref(),&now()).is_err(){break 'supervisor;}
                                if let Some(child)=children.get_mut(child_id){child.call_finished=true;}
                            }
                        }
                    }
                    Update::Permission(data) => {
                        let request=data["id"].as_str().unwrap_or("").to_owned();
                        if request.is_empty() {break 'supervisor;}
                        if !seen_requests.insert(request.clone()) {continue;}
                        let ordinal=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);
                        let target=request_targets.remove(&request);
                        let target_session=target.as_ref().map(|(child,_)|session.for_native(child)).unwrap_or_else(||session.clone());
                        let parent_node=target.map(|(_,node)|node);
                        let bus=bus.clone();let turn=turn.clone();let provider_session=provider_session.clone();let cancelled=cancelled.clone();let session=target_session;let callback_errors=callback_errors.clone();
                        tokio::spawn(async move {
                            let decision={
                                let request_copy=request.clone();let flag=cancelled.clone();
                                let tool_kind=match data["action"].as_str().or_else(||data["permission"].as_str()) {Some("read"|"search")=>"read",Some("edit")=>"edit",_=>"execute"};
                                let params=json!({"toolCall":{"toolCallId":request,"kind":tool_kind,"title":data["action"]},"options":[{"kind":"allow_once","optionId":"once"},{"kind":"allow_always","optionId":"always"},{"kind":"reject_once","optionId":"reject"}]});
                                let answer=tokio::task::spawn_blocking(move || super::acp_executor::request_approval_with_parent(&bus,&turn,&provider_session,&json!(request_copy),&params,ordinal,&flag,parent_node.as_deref())).await.ok().and_then(Result::ok);
                                permission_decision(answer.as_ref(),version).to_owned()
                            };
                            if !cancelled.load(Ordering::Acquire) && session.reply_permission(&request,&decision).await.is_err() {let _=callback_errors.send(());}
                        });
                    }
                    Update::Terminal(status) if !children.is_empty() => {
                        if tree.has_live_foreground_child(session.native_id()) {break 'supervisor;}
                        for (child_id,child) in &mut children {
                            if !child.call_finished && !child.background {
                                if super::opencode_subagents::finish_call(&bus,&child.parent,&instance_id,child_id,&child.call,status,None,&now()).is_err(){break 'supervisor;}
                                child.call_finished=true;
                            }
                        }
                        terminal=true;
                        match projector.project(Update::Terminal(status),&now()){Ok(values)=>if ingest::ingest(&bus,&values).is_err(){break 'supervisor},Err(_)=>break 'supervisor}
                        if let Ok(mut active)=active().lock(){if active.get(&turn.provider_thread_id).is_some_and(|entry|Arc::ptr_eq(&entry.cancelled,&cancelled)){active.remove(&turn.provider_thread_id);}}
                    }
                    Update::Question(data) => {
                        let native=data["id"].as_str().unwrap_or("").to_owned();
                        if native.is_empty() {break 'supervisor;}
                        if !seen_requests.insert(native.clone()) {continue;}
                        let questions=match super::opencode_questions::parse(&data,version==OpenCodeVersion::V2) {
                            Ok(questions)=>questions,
                            Err(_)=>{let session=session.clone();tokio::spawn(async move {let _=session.reply_question(&native,None).await;});break 'supervisor;}
                        };
                        let ordinal=request_ordinal;request_ordinal=request_ordinal.saturating_add(1);
                        let target=request_targets.remove(&native);
                        let target_session=target.as_ref().map(|(child,_)|session.for_native(child)).unwrap_or_else(||session.clone());
                        let parent_node=target.map(|(_,node)|node);
                        let receiver=match super::opencode_questions::project(&bus,&turn,&provider_session,&native,&questions,ordinal,&cancelled,parent_node.as_deref()) {Ok(receiver)=>receiver,Err(_)=>break 'supervisor};
                        let session=target_session;let cancelled=cancelled.clone();let callback_errors=callback_errors.clone();
                        tokio::spawn(async move {
                            let answers=receiver.await.ok().flatten();
                            if !cancelled.load(Ordering::Acquire) {
                                let answer=answers.as_ref().map(|answers|super::opencode_questions::native_answer(&questions,answers,version==OpenCodeVersion::V2));
                                if session.reply_question(&native,answer).await.is_err() {let _=callback_errors.send(());}
                            }
                        });
                    }
                    value => {terminal=matches!(value,Update::Terminal(_));match projector.project(value,&now()) {Ok(values)=>if ingest::ingest(&bus,&values).is_err(){break 'supervisor},Err(_)=>break 'supervisor}}
                }
                }
            }
        }
    }
    if missing_native {
        mark_missing_thread_error(&bus, &turn, &provider_session);
    }
    if let Ok(mut state) = steer_state.lock() {
        state.terminal = true;
        state.pending.clear();
        state.accepted.clear();
        state.observed.clear();
        state.notify.notify_waiters();
    }
    prompt.abort();
    for (native, job) in shell_jobs {
        let fields = json!({"input":job.command,"output":job.output,"nativeItemRef":{"driver":"opencode","nativeId":native,"strength":"strong"}});
        let started_at = job.turn.started_at.clone();
        let artifact = crate::provider::codex_events::ToolArtifact {
            turn: job.turn,
            native_item_id: job.id,
            ordinal: job.ordinal,
            started_at,
            updated_at: now(),
            status: "interrupted".into(),
            kind: "command_execution".into(),
            fields,
        };
        let _ = ingest::ingest(
            &bus,
            &[crate::provider::codex_events::NormalizedEvent::ToolUpdated(
                artifact,
            )],
        );
    }
    for (_, job) in image_jobs {
        let started_at = job.turn.started_at.clone();
        let artifact = crate::provider::codex_events::ToolArtifact {
            turn: job.turn,
            native_item_id: job.id,
            ordinal: job.ordinal,
            started_at,
            updated_at: now(),
            status: "interrupted".into(),
            kind: "dynamic_tool".into(),
            fields: json!({"toolName":"experimental_image_generate","input":job.input,"output":"Image generation was interrupted."}),
        };
        let _ = ingest::ingest(
            &bus,
            &[crate::provider::codex_events::NormalizedEvent::ToolUpdated(
                artifact,
            )],
        );
    }
    for (id, child) in &children {
        if let Ok(mut active) = active_children().lock() {
            active.remove(&child.turn.provider_thread_id);
        }
        if !child.finished {
            let _ =
                super::opencode_subagents::finish_child(&bus, &child.turn, "interrupted", &now());
        }
        if !child.call_finished {
            let _ = super::opencode_subagents::finish_call(
                &bus,
                &child.parent,
                &instance_id,
                id,
                &child.call,
                "interrupted",
                None,
                &now(),
            );
        }
    }
    interrupt_ready.notify_one();
    if stream_failed && !cancelled.load(Ordering::Acquire) {
        let at = now();
        let _=bus.commit(|tx| {
            if cancelled.load(Ordering::Acquire) {return Ok(((),vec![]));}
            let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id AND r.run_id=?4 WHERE t.provider_turn_id=?1 AND t.run_attempt_id=?2 AND t.provider_thread_id=?3 AND t.status IN ('pending','running','waiting') AND r.status IN ('running','waiting') AND json_extract(r.payload_json,'$.activeAttemptId')=?2)",params![turn.provider_turn_id,turn.run_attempt_id,turn.provider_thread_id,turn.run_id],|row|row.get(0))?;
            if !current {return Ok(((),vec![]));}
            let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?1 AND status='ready'",[&provider_session],|row|row.get(0)).optional()?;
            let Some(raw)=raw else {return Ok(((),vec![]));};
            let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
            value["status"]=json!("error");
            value["lastError"]=json!("The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.");
            value["updatedAt"]=json!(at);
            tx.execute("UPDATE orchestration_v2_projection_provider_sessions SET status='error',updated_at=?2,payload_json=?3 WHERE provider_session_id=?1 AND status='ready'",params![provider_session,at,value.to_string()])?;
            let event=crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"provider-session.updated".into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:value,metadata:json!({})};
            Ok(((),crate::event_store::append(tx,&[event])?))
        });
    }
    let was_cancelled = cancelled.swap(true, Ordering::AcqRel);
    if !terminal {
        super::acp_executor::cancel_approvals(&turn.thread_id);
        super::opencode_questions::cancel_thread(&turn.thread_id);
        let _ = session.interrupt().await;
        if let Ok(values) = projector.project(
            Update::Terminal(if was_cancelled {
                "interrupted"
            } else {
                "failed"
            }),
            &now(),
        ) {
            let _ = ingest::ingest(&bus, &values);
        }
        if stream_failed && !was_cancelled {
            let at = now();
            let _=bus.commit(|tx| {
                let raw:Option<String>=tx.query_row("SELECT p.payload_json FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id JOIN orchestration_v2_projection_runs r ON r.thread_id=p.thread_id AND r.run_id=?3 WHERE p.provider_thread_id=?1 AND s.provider_session_id=?2 AND s.status='error' AND r.status='failed' AND json_extract(r.payload_json,'$.activeAttemptId')=?4 AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs newer WHERE newer.thread_id=p.thread_id AND newer.run_id<>r.run_id AND newer.status IN ('preparing','starting','running','waiting')) AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns newer WHERE newer.provider_thread_id=p.provider_thread_id AND newer.ordinal>?5)",params![turn.provider_thread_id,provider_session,turn.run_id,turn.run_attempt_id,turn.provider_turn_ordinal],|row|row.get(0)).optional()?;
                let Some(raw)=raw else {return Ok(((),vec![]));};
                let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                value["status"]=json!("error");value["updatedAt"]=json!(at);
                tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='error',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![turn.provider_thread_id,at,value.to_string()])?;
                let event=crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"provider-thread.updated".into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:value,metadata:json!({})};
                Ok(((),crate::event_store::append(tx,&[event])?))
            });
        }
    }
}

fn mark_missing_thread_error(bus: &EventBus, turn: &RootTurn, provider_session: &str) {
    let at = now();
    let _=bus.commit(|tx| {
        let raw:Option<String>=tx.query_row("SELECT p.payload_json FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id JOIN orchestration_v2_projection_runs r ON r.thread_id=p.thread_id AND r.run_id=?3 WHERE p.provider_thread_id=?1 AND s.provider_session_id=?2 AND r.status='interrupted' AND json_extract(r.payload_json,'$.activeAttemptId')=?4 AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs newer WHERE newer.thread_id=p.thread_id AND newer.run_id<>r.run_id AND newer.status IN ('preparing','starting','running','waiting')) AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns newer WHERE newer.provider_thread_id=p.provider_thread_id AND newer.ordinal>?5)",params![turn.provider_thread_id,provider_session,turn.run_id,turn.run_attempt_id,turn.provider_turn_ordinal],|row|row.get(0)).optional()?;
        let Some(raw)=raw else {return Ok(((),vec![]));};
        let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        value["status"]=json!("error");value["updatedAt"]=json!(at);
        tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='error',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![turn.provider_thread_id,at,value.to_string()])?;
        let event=crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"provider-thread.updated".into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:value,metadata:json!({})};
        Ok(((),crate::event_store::append(tx,&[event])?))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body, extract::Request, http::StatusCode, response::Response, routing::any, Router,
    };
    #[test]
    fn side_chat_digest_is_included_in_opencode_prompt_and_deferred_for_compaction() {
        let mut db=rusqlite::Connection::open_in_memory().unwrap(); crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES('r','t',1,'opencode','opencode','pt','starting','now','{}')",[]).unwrap();
        let handoff=json!({"id":"side","threadId":"t","targetRunId":"r","toProviderThreadId":"pt","strategy":"manual_context","transferId":"fork","summaryText":"parent digest"});
        db.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side','t','r','pt','manual_context','ready','now',?1)",[handoff.to_string()]).unwrap();
        let bus=EventBus::new(db,16); let run=json!({"id":"r","providerThreadId":"pt"}); let thread=json!({"lineage":{"sideChat":true}});
        let (message, selected)=side_chat_prompt(&bus,&run,&thread,&json!({"text":"hello","attachments":[]})).unwrap();
        let (text, _)=crate::provider::opencode_attachments::build(&message,Path::new("/tmp"),OpenCodeVersion::V2,true).unwrap();
        assert_eq!(text,"parent digest\n\nUser message:\nhello"); assert_eq!(selected,vec![handoff]);
        let (message, selected)=side_chat_prompt(&bus,&run,&thread,&json!({"text":"/compact","attachments":[]})).unwrap(); assert_eq!(message["text"],"/compact"); assert!(selected.is_empty());
    }

    #[test]
    fn image_preview_rejects_suffix_traversal_before_reading() {
        let turn = RootTurn {
            driver: "opencode".into(),
            native_thread_id: "ses".into(),
            native_turn_id: "turn".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "turn-id".into(),
            thread_id: "thread".into(),
            run_id: Some("run".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:00Z".into(),
        };
        let job = ImageJob {
            turn,
            id: "tool".into(),
            input: json!({}),
            ordinal: 1,
            path: "/tmp/image".into(),
            cwd: "/tmp".into(),
            session_id: "ses".into(),
        };
        assert_eq!(
            image_location(&job, "Saved image: /tmp/image.png (test/model)."),
            Some(("/tmp".into(), "image.png".into(), "image/png"))
        );
        assert!(image_location(
            &job,
            "Saved image: /tmp/image.png/../../other.png (test/model)."
        )
        .is_none());
        assert!(image_location(&job, "Saved image: /tmp/image.other.png (test/model).").is_none());
    }
    #[test]
    fn cancelled_idle_is_interrupted() {
        assert!(matches!(
            cancellation_terminal(Update::Terminal("completed"), true),
            Update::Terminal("interrupted")
        ));
        assert!(matches!(
            cancellation_terminal(Update::Terminal("completed"), false),
            Update::Terminal("completed")
        ));
    }
    #[test]
    fn launch_password_tracks_settings_revision_but_not_direct_secret_file_edits() {
        let dir =
            std::env::temp_dir().join(format!("t3-open-password-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("secrets")).unwrap();
        let path = dir.join("settings.json");
        let mut raw = json!({"providerInstances":{"opencode":{"driver":"opencode","config":{"serverUrl":"http://localhost","serverPassword":"••••••"}}}});
        std::fs::write(&path, raw.to_string()).unwrap();
        let secret =
            dir.join("secrets/provider-config-b3BlbmNvZGU-b3BlbmNvZGU-c2VydmVyUGFzc3dvcmQ.bin");
        std::fs::write(&secret, "first").unwrap();
        let first = resolved_settings(Some(&path)).unwrap();
        assert_eq!(
            launch_password(
                Some(&path),
                "opencode",
                &first["providerInstances"]["opencode"]
            )
            .unwrap()
            .as_deref(),
            Some("first")
        );
        std::fs::write(&secret, "second").unwrap();
        let second = resolved_settings(Some(&path)).unwrap();
        assert_eq!(
            launch_password(
                Some(&path),
                "opencode",
                &second["providerInstances"]["opencode"]
            )
            .unwrap()
            .as_deref(),
            Some("first")
        );
        raw["providerInstances"]["opencode"]["config"]["serverUrl"] = json!("http://other");
        std::fs::write(&path, raw.to_string()).unwrap();
        let updated = resolved_settings(Some(&path)).unwrap();
        assert_eq!(
            launch_password(
                Some(&path),
                "opencode",
                &updated["providerInstances"]["opencode"]
            )
            .unwrap()
            .as_deref(),
            Some("second")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn missing_masked_environment_secret_fails_closed() {
        let dir = std::env::temp_dir().join(format!("t3-open-env-secret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings,json!({"providerInstances":{"opencode":{"driver":"opencode","environment":[{"name":"OPENCODE_SERVER_PASSWORD","value":"","sensitive":true,"valueRedacted":true}]}}}).to_string()).unwrap();
        assert!(resolved_settings(Some(&settings)).is_err());
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let secret_dir = dir.join("secrets");
        std::fs::create_dir_all(&secret_dir).unwrap();
        let secret = secret_dir.join(format!(
            "provider-env-{}-{}.bin",
            URL_SAFE_NO_PAD.encode("opencode"),
            URL_SAFE_NO_PAD.encode("OPENCODE_SERVER_PASSWORD")
        ));
        std::fs::write(&secret, b"first-secret").unwrap();
        let first = resolved_settings(Some(&settings)).unwrap();
        let entry = &first["providerInstances"]["opencode"];
        assert_eq!(
            effective_password(entry).unwrap().as_deref(),
            Some("first-secret")
        );
        let first_identity = connection_identity(entry, &settings).unwrap();
        std::fs::write(&secret, b"rotated-secret").unwrap();
        let second = resolved_settings(Some(&settings)).unwrap();
        assert_ne!(
            first_identity,
            connection_identity(&second["providerInstances"]["opencode"], &settings).unwrap()
        );
        assert!(effective_password(&json!({"environment":[{"name":"OPENCODE_SERVER_PASSWORD","secret":{"provider":"vault","reference":"op://item"}}]})).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn v1_message_ids_are_unique_and_ordered() {
        let first = v1_message_id();
        let second = v1_message_id();
        assert!(first.starts_with("msg_") && second.starts_with("msg_"));
        assert_eq!(first.len(), 44);
        assert!(first < second);
    }
    #[test]
    fn permission_scope_matches_native_version() {
        let always = json!({"outcome":{"optionId":"always"}});
        let once = json!({"outcome":{"optionId":"once"}});
        assert_eq!(
            permission_decision(Some(&always), OpenCodeVersion::V1),
            "always"
        );
        assert_eq!(
            permission_decision(Some(&always), OpenCodeVersion::V2),
            "once"
        );
        assert_eq!(
            permission_decision(Some(&once), OpenCodeVersion::V1),
            "once"
        );
        assert_eq!(permission_decision(None, OpenCodeVersion::V1), "reject");
    }
    #[test]
    fn force_stop_targets_only_captured_watcher_generation() {
        let thread = format!("force-snapshot-{}", uuid::Uuid::new_v4());
        let old = Arc::new(AtomicBool::new(false));
        let newer = Arc::new(AtomicBool::new(false));
        watchers().lock().unwrap().push(Watcher {
            thread: thread.clone(),
            provider_session: "session".into(),
            identity: Some("test-identity".into()),
            cancelled: old.clone(),
            notify: Arc::new(tokio::sync::Notify::new()),
            steer_state: None,
        });
        let snapshot = force_stop_snapshot("session", &thread).unwrap();
        watchers().lock().unwrap().push(Watcher {
            thread: thread.clone(),
            provider_session: "session".into(),
            identity: Some("test-identity".into()),
            cancelled: newer.clone(),
            notify: Arc::new(tokio::sync::Notify::new()),
            steer_state: None,
        });
        let mut stopped = false;
        for _ in 0..300 {
            if snapshot.stop(&thread, None) {
                stopped = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(stopped);
        assert!(old.load(Ordering::Acquire));
        assert!(!newer.load(Ordering::Acquire));
        watchers()
            .lock()
            .unwrap()
            .retain(|entry| entry.thread != thread);
    }
    #[test]
    fn force_stop_captures_prestart_without_provider_identity() {
        let thread = format!("force-prestart-{}", uuid::Uuid::new_v4());
        let key = format!("pt-{thread}");
        let cancelled = Arc::new(AtomicBool::new(false));
        active().lock().unwrap().insert(
            key.clone(),
            Active {
                thread: thread.clone(),
                provider_session: "prestart-session".into(),
                identity: None,
                session: None,
                cancelled: cancelled.clone(),
                interrupt_ready: Arc::new(tokio::sync::Notify::new()),
                cancel_notify: Arc::new(tokio::sync::Notify::new()),
            },
        );
        let snapshot = force_stop_snapshot("prestart-session", &thread).unwrap();
        assert!(snapshot.prestart());
        assert!(snapshot.identity().is_none());
        let mut stopped = false;
        for _ in 0..300 {
            if snapshot.stop(&thread, None) {
                stopped = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(stopped);
        assert!(cancelled.load(Ordering::Acquire));
        active().lock().unwrap().remove(&key);
    }
    #[tokio::test]
    async fn detach_cancels_completed_parent_background_watcher() {
        let thread = format!("detached-background-{}", uuid::Uuid::new_v4());
        let cancelled = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(tokio::sync::Notify::new());
        watchers().lock().unwrap().push(Watcher {
            thread: thread.clone(),
            provider_session: "test-session".into(),
            identity: Some("test-identity".into()),
            cancelled: cancelled.clone(),
            notify: notify.clone(),
            steer_state: None,
        });
        detach(&thread).await.unwrap();
        assert!(cancelled.load(Ordering::Acquire));
        tokio::time::timeout(std::time::Duration::from_secs(1), notify.notified())
            .await
            .unwrap();
        assert!(!watchers()
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry.thread == thread));
    }
    #[test]
    fn capabilities_expose_only_implemented_version_specific_features() {
        let v1 = capabilities(OpenCodeVersion::V1);
        let v2 = capabilities(OpenCodeVersion::V2);
        assert_eq!(v1["sessions"]["supportsModelSwitchInSession"], true);
        assert_eq!(v2["sessions"]["supportsRuntimeModeSwitchInSession"], true);
        assert_eq!(v1["planning"]["supportsStructuredQuestions"], true);
        assert_eq!(v1["subagents"]["supportsSubagents"], true);
        assert_eq!(v2["planning"]["supportsStructuredQuestions"], true);
        for field in [
            "supportsSubagents",
            "exposesSubagentThreadIds",
            "emitsSubagentLifecycle",
        ] {
            assert_eq!(v2["subagents"][field], true);
        }
        assert_eq!(v2["approvals"]["approvalsCanOriginateFromSubagents"], true);
        assert_eq!(v1["threads"]["canRollbackThread"], true);
        assert_eq!(v2["threads"]["canRollbackThread"], true);
        assert_eq!(v1["threads"]["canForkThread"], true);
        assert_eq!(v2["threads"]["canForkThread"], true);
    }
    #[test]
    fn mcp_names_isolate_threads_with_colliding_sanitized_names() {
        assert_ne!(mcp_server_name("a:b"), mcp_server_name("a_b"));
        assert_eq!(mcp_server_name("a:b").len(), 24);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn external_turn_streams_text_and_answers_approval() {
        let sender = Arc::new(tokio::sync::Mutex::new(
            None::<tokio::sync::mpsc::Sender<Result<String, std::convert::Infallible>>>,
        ));
        let state = sender.clone();
        let app=Router::new().fallback(any(move |request:Request| {let state=state.clone(); async move {
            let path=request.uri().path().to_owned();
            if path=="/api/info" {return Response::new(Body::from(r#"{"version":"2.0.18"}"#));}
            if path=="/api/event" {
                let (tx,rx)=tokio::sync::mpsc::channel::<Result<String,std::convert::Infallible>>(32);
                tx.send(Ok("data: {\"type\":\"server.connected\",\"data\":{}}\n\n".into())).await.unwrap();
                *state.lock().await=Some(tx);
                let stream=futures_util::stream::unfold(rx,|mut rx|async move {rx.recv().await.map(|item|(item,rx))});
                return Response::builder().header("content-type","text/event-stream").body(Body::from_stream(stream)).unwrap();
            }
            if path=="/api/session" {return Response::new(Body::from(r#"{"data":{"id":"native-open"}}"#));}
            if path=="/api/session/native-open" || path.ends_with("/agent") || path.ends_with("/model") || path.ends_with("/instructions/entries/t3-code") {return Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap();}
            let tx=state.lock().await.clone().unwrap();
            if path.ends_with("/prompt") {
                for event in [json!({"type":"session.execution.started","data":{"sessionID":"native-open"}}),json!({"type":"session.text.delta","data":{"sessionID":"native-open","assistantMessageID":"msg","ordinal":0,"delta":"hello from opencode"}}),json!({"type":"permission.asked","data":{"sessionID":"native-open","id":"per","action":"shell"}})] {tx.send(Ok(format!("data: {event}\n\n"))).await.unwrap();}
                return Response::new(Body::from("{}"));
            }
            if path.contains("/child-open/permission/") && path.ends_with("/reply") {
                for event in [
                    json!({"type":"session.tool.input.started","data":{"sessionID":"child-open","id":"call-grand","name":"subagent"}}),
                    json!({"type":"session.tool.called","data":{"sessionID":"child-open","id":"call-grand","input":{"description":"Nested","prompt":"Inspect deeper"}}}),
                    json!({"type":"session.created","data":{"sessionID":"grand-open","parentID":"child-open"}}),
                    json!({"type":"session.tool.progress","data":{"sessionID":"child-open","id":"call-grand","metadata":{"sessionID":"grand-open"}}}),
                    json!({"type":"session.execution.started","data":{"sessionID":"grand-open"}}),
                    json!({"type":"session.text.ended","data":{"sessionID":"grand-open","assistantMessageID":"grand-msg","ordinal":0,"text":"grandchild says hello"}}),
                    json!({"type":"session.execution.succeeded","data":{"sessionID":"grand-open"}}),
                    json!({"type":"session.tool.success","data":{"sessionID":"child-open","id":"call-grand","metadata":{"sessionID":"grand-open"},"content":[{"type":"text","text":"nested done"}]}}),
                    json!({"type":"session.text.ended","data":{"sessionID":"child-open","assistantMessageID":"child-msg","ordinal":0,"text":"child says hello"}}),
                    json!({"type":"session.execution.succeeded","data":{"sessionID":"child-open"}}),
                    json!({"type":"session.tool.success","data":{"sessionID":"native-open","id":"call-child","metadata":{"sessionID":"child-open"},"content":[{"type":"text","text":"done"}]}}),
                    json!({"type":"session.execution.succeeded","data":{"sessionID":"native-open"}})
                ] {tx.send(Ok(format!("data: {event}\n\n"))).await.unwrap();}
                return Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap();
            }
            if path.contains("/permission/") && path.ends_with("/reply") {
                tx.send(Ok(format!("data: {}\n\n",json!({"type":"form.created","data":{"form":{"id":"frm-test","sessionID":"native-open","fields":[{"key":"q0","title":"Color","description":"Choose a color","type":"string","options":[{"label":"Blue","value":"blue"}]}]}}})))).await.unwrap();
                return Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap();
            }
            if path.contains("/form/") && path.ends_with("/reply") {
                let bytes=axum::body::to_bytes(request.into_body(),4096).await.unwrap();
                let answer:Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(answer["answer"]["q0"],"blue");
                for event in [
                    json!({"type":"session.tool.input.started","data":{"sessionID":"native-open","id":"call-child","name":"subagent"}}),
                    json!({"type":"session.tool.called","data":{"sessionID":"native-open","id":"call-child","input":{"description":"Review","prompt":"Inspect this"}}}),
                    json!({"type":"session.created","data":{"sessionID":"child-open","parentID":"native-open"}}),
                    json!({"type":"session.tool.progress","data":{"sessionID":"native-open","id":"call-child","metadata":{"sessionID":"child-open"}}}),
                    json!({"type":"session.execution.started","data":{"sessionID":"child-open"}}),
                    json!({"type":"permission.asked","data":{"sessionID":"child-open","id":"child-per","action":"shell"}})
                ] {tx.send(Ok(format!("data: {event}\n\n"))).await.unwrap();}
                return Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap();
            }
            Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = std::env::temp_dir().join(format!("t3-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings,json!({"providerInstances":{"opencode":{"driver":"opencode","enabled":true,"config":{"serverUrl":format!("http://{address}")}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"opencode","model":"test/model"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-open",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "approval-required",
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
                thread_id: "t-open",
                message_id: "m-open",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver: "opencode",
            },
            "2026-01-01T00:00:01.000Z",
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
        let mut provider = crate::provider::executor::CodexTurnExecutor::new(
            bus.clone(),
            Arc::new(crate::provider::session_registry::SessionRegistry::default()),
        );
        provider.attachments_dir = root.clone();
        let executor = crate::effect_worker::RuntimeExecutor {
            bus: bus.clone(),
            provider,
            worktrees_dir: root.clone(),
            settings_path: settings.clone(),
            terminals: Arc::new(crate::terminal::TerminalManager::default()),
        };
        use crate::effect_worker::EffectExecutor;
        let restore = crate::workspace_safety::reserve(
            root.clone(),
            crate::workspace_safety::ReservationKind::Restore,
        );
        let start = tokio::spawn(async move {
            let result = executor.execute(&effect, false).await;
            (executor, result)
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            sender.lock().await.is_none(),
            "provider started while workspace restore held its reservation"
        );
        drop(restore);
        let (executor, result) = start.await.unwrap();
        result.unwrap();
        let mut approval = None;
        for _ in 0..200 {
            approval=bus.commit(|tx| {let id:Option<String>=tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id='t-open' AND status='pending'",[],|r|r.get(0)).optional()?;Ok((id,vec![]))}).unwrap();
            if approval.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let approval = approval.expect("approval");
        super::super::codex_requests::respond_command(
            &bus,
            "answer",
            "t-open",
            &approval,
            Some("accept"),
            None,
            "2026-01-01T00:00:02.000Z",
        )
        .unwrap();
        let response_effect = bus
            .commit(|tx| {
                let effect = crate::outbox::list_by_command_id(tx, "answer")?
                    .into_iter()
                    .find(|e| e.request["type"] == "runtime-request.respond")
                    .unwrap();
                Ok((effect, vec![]))
            })
            .unwrap();
        executor.execute(&response_effect, false).await.unwrap();
        let mut question = None;
        for _ in 0..200 {
            question=bus.commit(|tx| {let id:Option<String>=tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id='t-open' AND kind='user_input' AND status='pending'",[],|r|r.get(0)).optional()?;Ok((id,vec![]))}).unwrap();
            if question.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let question = question.expect("question");
        super::super::codex_requests::respond_command(
            &bus,
            "answer-question",
            "t-open",
            &question,
            None,
            Some(&json!({"q0":"blue"})),
            "2026-01-01T00:00:03.000Z",
        )
        .unwrap();
        let question_effect = bus
            .commit(|tx| {
                let effect = crate::outbox::list_by_command_id(tx, "answer-question")?
                    .into_iter()
                    .find(|e| e.request["type"] == "runtime-request.respond")
                    .unwrap();
                Ok((effect, vec![]))
            })
            .unwrap();
        executor.execute(&question_effect, false).await.unwrap();
        let mut child_approval = None;
        for _ in 0..200 {
            child_approval=bus.commit(|tx| {let id:Option<String>=tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id='t-open' AND kind='command' AND status='pending'",[],|r|r.get(0)).optional()?;Ok((id,vec![]))}).unwrap();
            if child_approval.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let child_approval = child_approval.expect("child approval");
        bus.commit(|tx| {let parent:String=tx.query_row("SELECT json_extract(n.payload_json,'$.parentNodeId') FROM orchestration_v2_projection_runtime_requests r JOIN orchestration_v2_projection_nodes n ON n.node_id=r.node_id WHERE r.runtime_request_id=?1",[&child_approval],|r|r.get(0))?;assert_eq!(parent,super::super::opencode_subagents::call_node("call-child"));Ok(((),vec![]))}).unwrap();
        super::super::codex_requests::respond_command(
            &bus,
            "answer-child",
            "t-open",
            &child_approval,
            Some("accept"),
            None,
            "2026-01-01T00:00:04.000Z",
        )
        .unwrap();
        let child_effect = bus
            .commit(|tx| {
                let effect = crate::outbox::list_by_command_id(tx, "answer-child")?
                    .into_iter()
                    .find(|e| e.request["type"] == "runtime-request.respond")
                    .unwrap();
                Ok((effect, vec![]))
            })
            .unwrap();
        executor.execute(&child_effect, false).await.unwrap();
        let mut result = None;
        for _ in 0..200 {
            result=bus.commit(|tx| {let value:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id='t-open' AND role='assistant'",[],|r|r.get(0)).optional()?;Ok((value,vec![]))}).unwrap();
            if result.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(result.as_deref(), Some("hello from opencode"));
        let mut status = String::new();
        for _ in 0..200 {
            status = bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns WHERE thread_id='t-open'",[],|r|r.get(0))?;Ok((status,vec![]))}).unwrap();
            if status == "completed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(status, "completed");
        bus.commit(|tx| {
            let (child,status):(String,String)=tx.query_row("SELECT child_thread_id,status FROM orchestration_v2_projection_subagents WHERE thread_id='t-open'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"completed");
            let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant'",[&child],|r|r.get(0))?;assert_eq!(text,"child says hello");
            let (grand,status):(String,String)=tx.query_row("SELECT child_thread_id,status FROM orchestration_v2_projection_subagents WHERE thread_id=?1",[&child],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"completed");
            let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant'",[&grand],|r|r.get(0))?;assert_eq!(text,"grandchild says hello");
            Ok(((),vec![]))
        }).unwrap();
        let capture = bus.commit(|tx| {let id:String=tx.query_row("SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture' AND thread_id='t-open'",[],|r|r.get(0))?;Ok((crate::outbox::get(tx,&id)?.unwrap(),vec![]))}).unwrap();
        executor.execute(&capture, false).await.unwrap();
        let run_status = bus
            .commit(|tx| {
                let status: String = tx.query_row(
                    "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t-open'",
                    [],
                    |r| r.get(0),
                )?;
                Ok((status, vec![]))
            })
            .unwrap();
        assert_eq!(run_status, "completed");
        server.abort();
        let _ = std::fs::remove_dir_all(root);
    }
}
