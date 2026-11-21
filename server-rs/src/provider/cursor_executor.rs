//! Cursor SDK orchestration adapter. The separately installed SDK runs in a child process.
use crate::{
    effect_worker::Execution,
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        codex_events::{
            AssistantArtifact, FailureClass, NormalizedEvent, ProviderFailure, ReasoningArtifact,
            RootTurn, ThreadDisposition, TurnStatus,
        },
        cursor_bridge::{CursorBridge, CursorCancel},
        cursor_tools, ingest, lifecycle,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock},
    time::Duration,
};

struct Active {
    bridge: Arc<Mutex<CursorBridge>>,
    cancel: CursorCancel,
    provider_session_id: String,
    thread_id: String,
    native_id: String,
    terminated: Arc<AtomicBool>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Active>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
// The active prompt is recorded before send so force-stop can preserve it even
// if the SDK process disappears before it returns a cancellation result.
fn recovery_schema(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS cursor_prompt_recovery (thread_id TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, native_id TEXT NOT NULL, prompt TEXT NOT NULL, PRIMARY KEY(thread_id, kind))")
}
pub(crate) fn preserve_interrupted_prompt(tx: &rusqlite::Transaction<'_>, thread: &str, run: &str) -> rusqlite::Result<()> {
    recovery_schema(tx)?;
    tx.execute("INSERT INTO cursor_prompt_recovery(thread_id,kind,run_id,native_id,prompt) SELECT thread_id,'interrupted',run_id,native_id,prompt FROM cursor_prompt_recovery WHERE thread_id=?1 AND kind='active' AND run_id=?2 ON CONFLICT(thread_id,kind) DO UPDATE SET run_id=excluded.run_id,native_id=excluded.native_id,prompt=excluded.prompt", params![thread,run])?;
    Ok(())
}
fn prepare_prompt(bus: &EventBus, thread: &str, run: &str, native: &str, text: &str) -> Result<(String, Option<String>), String> {
    bus.commit(|tx| {
        recovery_schema(tx)?;
        let prior: Option<(String,String,String)> = tx.query_row("SELECT run_id,native_id,prompt FROM cursor_prompt_recovery WHERE thread_id=?1 AND kind='interrupted'", [thread], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let prompt = match prior.as_ref().filter(|(_,agent,_)| agent == native) {
            Some((_,_,old)) => format!("Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\n{old}\n\nThe new message, which may continue or change that request:\n\n{text}"),
            None => text.to_owned(),
        };
        tx.execute("INSERT INTO cursor_prompt_recovery(thread_id,kind,run_id,native_id,prompt) SELECT ?1,'active',?2,?3,?4 WHERE EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status='starting') ON CONFLICT(thread_id,kind) DO UPDATE SET run_id=excluded.run_id,native_id=excluded.native_id,prompt=excluded.prompt", params![thread,run,native,prompt])?;
        Ok(((prompt,prior.map(|(run,_,_)|run)),vec![]))
    }).map_err(|e|e.to_string())
}
struct Starting {
    provider_session_id: String,
    cancelled: AtomicBool,
    done: AtomicBool,
    gate: Mutex<()>,
    child: Mutex<Option<CursorCancel>>,
}
static STARTING: OnceLock<Mutex<HashMap<String, Arc<Starting>>>> = OnceLock::new();
fn starting() -> &'static Mutex<HashMap<String, Arc<Starting>>> { STARTING.get_or_init(|| Mutex::new(HashMap::new())) }
struct StartGuard { thread_id: String, state: Arc<Starting> }
impl StartGuard {
    fn acquire(thread_id: &str, provider_session_id: &str) -> rusqlite::Result<Self> {
        let mut map = starting().lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        if map.contains_key(thread_id) { return Err(rusqlite::Error::InvalidQuery); }
        let state = Arc::new(Starting { provider_session_id: provider_session_id.into(), cancelled:AtomicBool::new(false), done:AtomicBool::new(false), gate:Mutex::new(()), child:Mutex::new(None) });
        map.insert(thread_id.into(), state.clone());
        Ok(Self { thread_id:thread_id.into(), state })
    }
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        self.state.done.store(true, Ordering::Release);
        if let Ok(mut map) = starting().lock() {
            if map.get(&self.thread_id).is_some_and(|state| Arc::ptr_eq(state,&self.state)) { map.remove(&self.thread_id); }
        }
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

struct CursorSegment {
    text: String,
    index: u64,
    ordinal: u64,
    started_at: String,
}
fn segment_events(turn: &RootTurn, segment: &CursorSegment, reasoning: bool, completed: bool, interrupted: bool) -> Vec<NormalizedEvent> {
    let item = format!("{}:{}:{}", if reasoning { "reasoning" } else { "assistant" }, turn.native_turn_id, segment.index);
    let artifact = AssistantArtifact {
        turn: turn.clone(), native_item_id: item.clone(), phase: None, text: segment.text.clone(),
        ordinal: segment.ordinal, started_at: segment.started_at.clone(), updated_at: now(), completed,
    };
    if reasoning {
        let value = ReasoningArtifact { native_reasoning_item_id:item, artifact, stream:"text".into(), index:0, interrupted };
        vec![NormalizedEvent::ReasoningNodeUpdated(value.clone()), NormalizedEvent::ReasoningTurnItemUpdated(value)]
    } else {
        vec![NormalizedEvent::NodeUpdated(artifact.clone()), NormalizedEvent::MessageUpdated(artifact.clone()), NormalizedEvent::TurnItemUpdated(artifact)]
    }
}
fn complete_segment(bus: &EventBus, turn: &RootTurn, segment: &mut Option<CursorSegment>, reasoning: bool) -> Result<(), String> {
    if let Some(value) = segment.take() {
        ingest::ingest(bus, &segment_events(turn, &value, reasoning, true, false)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn execute<'a>(
    bus: &'a EventBus,
    effect: &'a Effect,
    settings_path: Option<&'a Path>,
) -> Execution<'a> {
    Box::pin(async move {
        match effect.request["type"].as_str() {
            Some("provider-turn.interrupt") => {
                let key = required(&effect.request, "providerThreadId")?;
                let cancel = sessions()
                    .lock()
                    .map_err(|_| "Cursor session unavailable")?
                    .get(key)
                    .map(|v| v.cancel.clone())
                    .ok_or("Cursor session unavailable")?;
                cancel.cancel()
            }
            Some("provider-turn.start") => {
                if effect.attempt_count > 1 {
                    return Err("Cannot replay an uncertain Cursor turn".into());
                }
                let bus = bus.clone();
                let effect = effect.clone();
                let settings_path = settings_path.map(Path::to_owned);
                let (tx, rx) = tokio::sync::oneshot::channel();
                tokio::task::spawn_blocking(move || {
                    let mut ready = Some(tx);
                    let result = start(&bus, &effect, settings_path.as_deref(), None, &mut ready);
                    if let Some(tx) = ready {
                        let result = match result {
                            Ok(()) => Ok(()),
                            Err(_) => super::acp_executor::fail_provider_start(
                                &bus,
                                &effect,
                                "Cursor provider could not start the turn.",
                            ),
                        };
                        let _ = tx.send(result);
                    } else if let Err(error) = result {
                        eprintln!("Cursor turn failed: {error}");
                    }
                });
                rx.await
                    .map_err(|_| "Cursor supervisor stopped".to_owned())?
            }
            _ => Err("Cursor operation is not supported".into()),
        }
    })
}

pub(crate) fn is_active(provider_thread_id: &str) -> bool {
    sessions().lock().is_ok_and(|all| all.contains_key(provider_thread_id))
}

pub(crate) fn detach(provider_session_id: &str, thread_id: &str) -> Result<(), String> {
    let mut all = sessions()
        .lock()
        .map_err(|_| "Cursor session unavailable")?;
    let keys: Vec<_> = all.iter().filter(|(_, value)| value.provider_session_id == provider_session_id && value.thread_id == thread_id).map(|(key, _)| key.clone()).collect();
    let removed: Vec<_> = keys.iter().filter_map(|key| all.remove(key)).collect();
    drop(all);
    for value in removed { value.terminated.store(true, Ordering::Release); value.cancel.terminate(); }
    Ok(())
}

pub(crate) fn rewind_history(cwd: &str, native_id: &str, retained_run_id: &str) -> Result<Value, String> {
    let node = std::env::var("T3CODE_CURSOR_NODE").unwrap_or_else(|_| "node".into());
    let sdk = std::env::var("T3CODE_CURSOR_SDK_PATH").ok();
    let mut bridge = CursorBridge::spawn(&node, sdk.as_deref())?;
    bridge.request(
        "rewind",
        json!({
            "agentId":native_id,
            "afterRunId":retained_run_id,
            "options":{"local":{"cwd":cwd}}
        }),
        Duration::from_secs(90),
        |_| {},
    )
}

pub(crate) struct ForceStopSnapshot {
    key: Option<String>,
    bridge: Option<Arc<Mutex<CursorBridge>>>,
    start: Option<Arc<Starting>>,
    cancel: Option<CursorCancel>,
    session: String,
}
pub(crate) fn force_stop_snapshot(provider_session_id: &str, thread_id: &str) -> Option<ForceStopSnapshot> {
    let start = starting().lock().ok()?.get(thread_id).filter(|state| state.provider_session_id == provider_session_id).cloned();
    let active = sessions().lock().ok()?.iter().find(|(_, value)| value.provider_session_id == provider_session_id && value.thread_id == thread_id).map(|(key, value)| (key.clone(),value.bridge.clone(),value.cancel.clone()));
    if start.is_none() && active.is_none() { return None; }
    Some(ForceStopSnapshot { key:active.as_ref().map(|x|x.0.clone()), bridge:active.as_ref().map(|x|x.1.clone()), cancel:active.map(|x|x.2), start, session:provider_session_id.into() })
}
static VERIFIED_STOPS: OnceLock<Mutex<std::collections::HashSet<(String,String,i64)>>> = OnceLock::new();
fn verified_stops() -> &'static Mutex<std::collections::HashSet<(String,String,i64)>> { VERIFIED_STOPS.get_or_init(||Mutex::new(std::collections::HashSet::new())) }
pub(crate) fn has_verified_stop(session:&str, thread:&str, ordinal:i64) -> bool { verified_stops().lock().is_ok_and(|set|set.contains(&(session.into(),thread.into(),ordinal))) }
pub(crate) fn clear_verified_stop(session:&str, thread:&str, ordinal:i64) { if let Ok(mut set)=verified_stops().lock(){set.remove(&(session.into(),thread.into(),ordinal));} }
impl ForceStopSnapshot {
    pub(crate) fn process_group(&self) -> Option<i32> {
        self.cancel.as_ref().and_then(CursorCancel::process_group).or_else(||self.start.as_ref().and_then(|start|start.child.lock().ok().and_then(|child|child.as_ref().and_then(CursorCancel::process_group))))
    }
    pub(crate) fn stop(&self, thread:&str, ordinal:i64) -> bool {
        if let Some(start)=&self.start { start.cancelled.store(true,Ordering::Release); }
        let start=self.start.clone(); let key=self.key.clone(); let bridge=self.bridge.clone(); let cancel=self.cancel.clone(); let thread=thread.to_owned(); let session=self.session.clone();
        std::thread::spawn(move || {
            let mut stopped=true;
            let mut starting_child = None;
            if let Some(start)=start {
                if let Ok(_gate)=start.gate.lock() {
                    if let Some(child)=start.child.lock().ok().and_then(|slot|slot.clone()) { stopped &= child.terminate(); }
                } else { stopped=false; }
                while !start.done.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(20)); }
                starting_child = start.child.lock().ok().and_then(|slot|slot.clone());
                if let Some(child)=&starting_child { stopped &= child.terminate(); }
            }
            if let Some(cancel)=cancel { stopped &= cancel.terminate(); }
            if stopped {
                if let Ok(mut all)=sessions().lock() {
                    // The session may have been published after the snapshot captured
                    // only STARTING. Match the child generation before removing it.
                    let keys: Vec<_> = all.iter().filter(|(candidate, value)| {
                        value.thread_id == thread && value.provider_session_id == session &&
                            (key.as_ref().zip(bridge.as_ref()).is_some_and(|(key, bridge)| *candidate == key && Arc::ptr_eq(&value.bridge, bridge)) ||
                             starting_child.as_ref().is_some_and(|child| child.same_process(&value.cancel)))
                    }).map(|(key, _)| key.clone()).collect();
                    for key in keys { if let Some(value)=all.remove(&key) { value.terminated.store(true,Ordering::Release); } }
                } else { return; }
                if let Ok(mut set)=verified_stops().lock(){set.insert((session,thread,ordinal));}
            }
        });
        false
    }
}

fn start(
    bus: &EventBus,
    effect: &Effect,
    settings_path: Option<&Path>,
    sdk_override: Option<&Path>,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let run_id = required(&effect.request, "runId")?.to_owned();
    let data = bus.commit(|tx| {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'", params![run_id, effect.thread_id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { return Ok((None, vec![])); };
        let parse = |raw: String| serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery);
        let run = parse(raw)?;
        let pt = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [run["providerThreadId"].as_str()], |r| r.get(0))?)?;
        let message = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1", [run["userMessageId"].as_str()], |r| r.get(0))?)?;
        let thread = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&effect.thread_id], |r| r.get(0))?)?;
        let cwd: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'", [&run_id], |r| r.get(0)).optional()?.flatten();
        let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1", [run["providerThreadId"].as_str()], |r| r.get(0))?;
        let guard=StartGuard::acquire(&effect.thread_id, pt["providerSessionId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        Ok((Some((run, pt, message, thread, cwd, ordinal, guard)), vec![]))
    }).map_err(|e| e.to_string())?;
    let Some((run, pt, message, thread, cwd, ordinal, start_guard)) = data else {
        if let Some(tx) = ready.take() {
            let _ = tx.send(Ok(()));
        }
        return Ok(());
    };
    if message["attachments"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        return Err("Cursor attachments are not yet supported".into());
    }
    let instance = required(&pt, "providerInstanceId")?;
    let key = required(&pt, "id")?.to_owned();
    let cwd = cwd
        .or_else(|| thread["worktreePath"].as_str().map(str::to_owned))
        .ok_or("Cursor workspace is unavailable")?;
    let absolute = |path: &str| {
        let path = std::path::PathBuf::from(path);
        if path.is_absolute() { path } else { std::env::current_dir().unwrap_or_default().join(path) }
    };
    let _reservation = crate::workspace_safety::reserve(
        absolute(&cwd), crate::workspace_safety::ReservationKind::TurnStart,
    );
    let _lease = thread["worktreePath"].as_str().filter(|path| !path.is_empty())
        .map(|path| crate::workspace_safety::workspace_lease(absolute(path)));
    let still_starting = bus.commit(|tx| {
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')", params![run_id,effect.thread_id], |row| row.get(0))?;
        Ok((active, vec![]))
    }).map_err(|error| error.to_string())?;
    if !still_starting { return Ok(()); }
    if start_guard.state.cancelled.load(Ordering::Acquire) { return Ok(()); }
    let settings = super::session_registry::read_provider_settings(settings_path)?;
    let entry = &settings["providerInstances"][instance];
    let mut api_key = std::env::var("CURSOR_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if let Some(values) = entry["environment"].as_array() {
        for value in values {
            if value["name"] == "CURSOR_API_KEY" {
                api_key =
                    if let Some(secret) = value.get("secret").filter(|secret| !secret.is_null()) {
                        let runtime = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .map_err(|_| "Cursor credentials are unavailable")?;
                        runtime.block_on(crate::mcp_secret::resolve_reference(&settings, secret))
                    } else {
                        value["value"].as_str().map(str::to_owned)
                    };
            }
        }
    }
    if api_key.as_deref().is_none_or(|key| key.trim().is_empty()) {
        api_key = settings_path
            .map(|path| super::cursor_credentials::read(path, instance))
            .transpose()?
            .flatten()
            .and_then(|credentials| credentials["apiKey"].as_str().map(str::to_owned));
    }
    let api_key = api_key.ok_or("Cursor credentials are unavailable")?;
    let existing = sessions()
        .lock()
        .map_err(|_| "Cursor session unavailable")?
        .get(&key)
        .map(|v| (v.bridge.clone(), v.native_id.clone(), v.terminated.clone()));
    let (bridge, native_id, terminated) = if let Some(existing) = existing {
        existing
    } else {
        let node = std::env::var("T3CODE_CURSOR_NODE").unwrap_or_else(|_| "node".into());
        let sdk = sdk_override
            .map(|value| value.to_string_lossy().into_owned())
            .or_else(|| std::env::var("T3CODE_CURSOR_SDK_PATH").ok());
        let spawn_permit = start_guard.state.gate.lock().map_err(|_| "Cursor start unavailable")?;
        if start_guard.state.cancelled.load(Ordering::Acquire) { return Ok(()); }
        let mut bridge = CursorBridge::spawn(&node, sdk.as_deref())?;
        *start_guard.state.child.lock().map_err(|_| "Cursor start unavailable")? = Some(bridge.cancel_handle());
        drop(spawn_permit);
        let model = run["modelSelection"]["model"].as_str().unwrap_or("auto");
        let mode = thread["runtimeMode"]
            .as_str()
            .unwrap_or("approval-required");
        let options = json!({"apiKey":api_key,"model":{"id":if model=="auto" {"default"} else {model}},"name":format!("T3 Code {}",effect.thread_id),"mode":if thread["interactionMode"]=="plan" {"plan"} else {"agent"},"local":{"cwd":cwd,"autoReview":mode!="full-access","sandboxOptions":{"enabled":mode!="full-access"},"settingSources":["project","user","team","mdm","plugins"],"enableAgentRetries":true}});
        let opened = bridge.request(
            "open",
            json!({"agentId":pt["nativeThreadRef"]["nativeId"],"options":options}),
            Duration::from_secs(90),
            |_| {},
        )?;
        if start_guard.state.cancelled.load(Ordering::Acquire) { return Ok(()); }
        let native = required(&opened, "agentId")?.to_owned();
        let cancel = bridge.cancel_handle();
        let bridge = Arc::new(Mutex::new(bridge));
        let terminated = Arc::new(AtomicBool::new(false));
        sessions()
            .lock()
            .map_err(|_| "Cursor session unavailable")?
            .insert(
                key.clone(),
                Active {
                    bridge: bridge.clone(),
                    cancel,
                    provider_session_id: required(&pt, "providerSessionId")?.to_owned(),
                    thread_id: effect.thread_id.clone(),
                    native_id: native.clone(),
                    terminated: terminated.clone(),
                },
            );
        (bridge, native, terminated)
    };
    let mut client = bridge.lock().map_err(|_| "Cursor session unavailable")?;
    *start_guard.state.child.lock().map_err(|_| "Cursor start unavailable")? = Some(client.cancel_handle());
    if start_guard.state.cancelled.load(Ordering::Acquire) { return Ok(()); }
    let (side_text, mut side_chat) = if thread["lineage"]["sideChat"] == true {
        let handoffs = bus.commit(|tx| Ok((super::executor::pending_handoffs(tx, run["providerThreadId"].as_str(), &run_id)?, vec![]))).map_err(|e| e.to_string())?;
        super::executor::prepare_inline_handoffs(handoffs, &message, true)?
    } else { (message["text"].as_str().unwrap_or("").to_owned(), vec![]) };
    let side_text = super::executor::with_message_sender_note(&message, &side_text);
    let (prompt, prior_run) = prepare_prompt(bus, &effect.thread_id, &run_id, &native_id, &side_text)?;
    let mut turn: Option<RootTurn> = None;
    let mut projection_error: Option<String> = None;
    let mut text: Option<CursorSegment> = None;
    let mut reasoning: Option<CursorSegment> = None;
    let mut text_index = 0u64;
    let mut reasoning_index = 0u64;
    let mut next_ordinal = run["ordinal"].as_u64().unwrap_or(1) * 1_000_000 + 2;
    // Keep shell output until completion; the SDK can omit it from the final result.
    let mut tools: HashMap<String, (u64, String, String, bool, bool)> = HashMap::new();
    let started = now();
    let mut callback = |event: Value| {
        if projection_error.is_some() {
            return;
        }
        if event["method"] == "run.started" {
            let Some(native_turn) = event["params"]["runId"].as_str() else {
                projection_error = Some("Cursor run identifier missing".into());
                return;
            };
            let native_thread = native_id.clone();
            let value = RootTurn {
                driver: "cursor".into(),
                native_thread_id: native_thread,
                native_turn_id: native_turn.into(),
                provider_thread_id: key.clone(),
                provider_turn_id: format!(
                    "provider-turn:provider:cursor:native-turn:{}",
                    crate::message_commands::encode_id_part(native_turn)
                ),
                thread_id: effect.thread_id.clone(),
                run_id: Some(run_id.clone()),
                run_attempt_id: run["activeAttemptId"].as_str().unwrap_or("").into(),
                root_node_id: run["rootNodeId"].as_str().unwrap_or("").into(),
                provider_turn_ordinal: ordinal,
                run_ordinal: run["ordinal"].as_u64().unwrap_or(1),
                started_at: started.clone(),
            };
            let capabilities = json!({"sessions":{"supportsMultipleProviderThreadsPerSession":false},"turns":{"supportsInterrupt":true,"supportsQueuedMessages":true},"streaming":{"streamsAssistantText":true,"streamsReasoningText":true}});
            let mut provider_thread = pt.clone();
            if pt["nativeThreadRef"]["nativeId"] != native_id
                || pt["nativeMetadata"]["cursorStoreCwd"].is_null()
            {
                provider_thread["nativeMetadata"]["cursorStoreCwd"] = json!(&cwd);
            }
            if let Err(error) =
                lifecycle::start(bus, &value, provider_thread, &run, Some(&cwd), capabilities)
            {
                projection_error = Some(error.to_string());
                return;
            }
            for handoff in std::mem::take(&mut side_chat) {
                if let Err(error) = super::executor::record_side_chat_delivery(bus, &value, handoff) {
                    eprintln!("Warning: failed to record accepted Cursor side-chat context delivery: {error}");
                }
            }
            if let Some(prior) = &prior_run {
                if let Err(error) = bus.commit(|tx| {
                    recovery_schema(tx)?;
                    tx.execute("DELETE FROM cursor_prompt_recovery WHERE thread_id=?1 AND kind='interrupted' AND run_id=?2", params![effect.thread_id,prior])?;
                    Ok(((),vec![]))
                }) { projection_error = Some(error.to_string()); return; }
            }
            turn = Some(value);
            if let Some(tx) = ready.take() {
                let _ = tx.send(Ok(()));
            }
        } else if event["method"] == "update" {
            let Some(current) = &turn else {
                projection_error = Some("Cursor update arrived before its run".into());
                return;
            };
            let update = &event["params"];
            let kind = update["type"].as_str().unwrap_or("");
            if matches!(
                kind,
                "tool-call-started" | "partial-tool-call" | "tool-call-completed"
            ) {
                if let Err(error) = complete_segment(bus, current, &mut text, false).and_then(|_| complete_segment(bus, current, &mut reasoning, true)) { projection_error = Some(error); return; }
                let Some(id) = update["callId"].as_str().filter(|id| !id.is_empty()) else {
                    projection_error = Some("Cursor tool call is missing an ID".into());
                    return;
                };
                let (ordinal, first_seen, streamed, completed, is_shell) =
                    tools.entry(id.to_owned()).or_insert_with(|| {
                        let ordinal = next_ordinal;
                        next_ordinal += 1;
                        (ordinal, now(), String::new(), false, false)
                    });
                *is_shell = update["toolCall"]["type"] == "shell";
                if matches!(update["toolCall"]["type"].as_str(), Some("createPlan" | "updateTodos")) {
                    *completed = kind == "tool-call-completed";
                    if let Err(error) = cursor_tools::project_plan(bus, current, update, *ordinal, &now()) { projection_error = Some(error); }
                    return;
                }
                match cursor_tools::project(current, update, *ordinal, first_seen, &now()) {
                    Ok(mut artifact) => {
                        if artifact.kind == "command_execution" && artifact.fields.get("output").is_none() && !streamed.is_empty() {
                            artifact.fields["output"] = json!(streamed);
                        }
                        *completed = kind == "tool-call-completed";
                        let is_finished_shell = artifact.kind == "command_execution" && *completed;
                        if let Err(error) =
                            ingest::ingest(bus, &[NormalizedEvent::ToolUpdated(artifact)])
                        {
                            projection_error = Some(error.to_string());
                        } else if is_finished_shell {
                            let item = format!("turn-item:provider:cursor:native-item:{}", crate::message_commands::encode_id_part(id));
                            bus.command_output().finish(&current.thread_id, &item);
                        }
                    }
                    Err(error) => projection_error = Some(error),
                }
                return;
            }
            if kind == "shell-output-delta" {
                let event = &update["event"];
                let id = match event["toolCallId"].as_str() {
                    Some(id) => Some(id.to_owned()),
                    None => tools.iter().filter(|(_, (_, _, _, done, shell))| !done && *shell)
                        .max_by_key(|(_, (ordinal, _, _, _, _))| *ordinal).map(|(id, _)| id.clone()),
                };
                if let Some((_, _, output, false, true)) = id.as_deref().and_then(|id| tools.get_mut(id)) {
                    if matches!(event["case"].as_str(), Some("stdout" | "stderr")) {
                        if let Some(chunk) = event["value"]["data"].as_str() {
                            let item = format!("turn-item:provider:cursor:native-item:{}", crate::message_commands::encode_id_part(id.as_deref().unwrap()));
                            bus.command_output().append(&current.thread_id, &item, chunk);
                            output.push_str(chunk);
                            if output.len() > 256 * 1024 {
                                let mut start = output.len() - 256 * 1024;
                                while !output.is_char_boundary(start) { start += 1; }
                                output.drain(..start);
                            }
                        }
                    }
                }
                return;
            }
            if matches!(kind, "step-completed" | "turn-ended") {
                if let Err(error) = complete_segment(bus, current, &mut text, false).and_then(|_| complete_segment(bus, current, &mut reasoning, true)) { projection_error = Some(error); }
                return;
            }
            if kind == "thinking-completed" {
                if let Err(error) = complete_segment(bus, current, &mut reasoning, true) { projection_error = Some(error); }
                return;
            }
            if matches!(kind, "step-started" | "user-message-appended") { return; }
            let is_reasoning = match kind { "text-delta" => false, "thinking-delta" => true, _ => {
                projection_error = Some("Cursor emitted an unsupported event".into()); return;
            }};
            let completion = if is_reasoning { complete_segment(bus,current,&mut text,false) } else { complete_segment(bus,current,&mut reasoning,true) };
            if let Err(error) = completion { projection_error = Some(error); return; }
            let (target, index) = if is_reasoning { (&mut reasoning, &mut reasoning_index) } else { (&mut text, &mut text_index) };
            let segment = target.get_or_insert_with(|| {
                *index += 1;
                let ordinal = next_ordinal;
                next_ordinal += 1;
                CursorSegment { text:String::new(), index:*index, ordinal, started_at:now() }
            });
            segment.text.push_str(update["text"].as_str().unwrap_or(""));
            if let Err(error) = ingest::ingest(bus, &segment_events(current, segment, is_reasoning, false, false)) {
                projection_error = Some(error.to_string());
            }
        }
    };
    let result = client.request_admitted(
        "send",
        json!({"message":prompt}),
        Duration::from_secs(600),
        &start_guard.state.gate,
        &start_guard.state.cancelled,
        &mut callback,
    );
    if terminated.load(Ordering::Acquire) { return Ok(()); }
    let Some(turn) = turn else {
        // Even without a run.started event, send may have reached the SDK.
        // Do not reuse a bridge whose state after that request is uncertain.
        drop(client);
        if let Ok(mut active) = sessions().lock() {
            if active.get(&key).is_some_and(|session| Arc::ptr_eq(&session.bridge, &bridge)) {
                active.remove(&key);
            }
        }
        return result
            .map(|_| ())
            .and_then(|_| Err(projection_error.unwrap_or("Cursor did not start a run".into())));
    };
    let failed = result.is_err()
        || projection_error.is_some()
        || result
            .as_ref()
            .is_ok_and(|value| value["status"] == "error");
    // A transport or projection failure leaves the SDK process in an uncertain
    // state. Retire only this generation so a later turn can resume natively.
    if failed {
        drop(client);
        if let Ok(mut active) = sessions().lock() {
            if active.get(&key).is_some_and(|session| Arc::ptr_eq(&session.bridge, &bridge)) {
                active.remove(&key);
            }
        }
    }
    let status = if failed {
        TurnStatus::Failed
    } else if result
        .as_ref()
        .is_ok_and(|value| value["status"] == "cancelled")
    {
        TurnStatus::Interrupted
    } else {
        TurnStatus::Completed
    };
    bus.commit(|tx| {
        if status == TurnStatus::Interrupted { preserve_interrupted_prompt(tx, &effect.thread_id, &run_id)?; }
        tx.execute("DELETE FROM cursor_prompt_recovery WHERE thread_id=?1 AND kind='active' AND run_id=?2", params![effect.thread_id,run_id])?;
        Ok(((),vec![]))
    }).map_err(|e|e.to_string())?;
    let mut events = Vec::new();
    if let Some(segment) = text { events.extend(segment_events(&turn, &segment, false, true, false)); }
    if let Some(segment) = reasoning { events.extend(segment_events(&turn, &segment, true, true, status == TurnStatus::Interrupted)); }
    let failure = failed.then(|| ProviderFailure {
        class: FailureClass::ProviderError,
        message: "Cursor provider turn failed or emitted an unsupported event.".into(),
        code: None,
        retryable: Some(false),
        managed_usage_limit: false,
    });
    events.push(NormalizedEvent::ProviderTurnUpdated {
        turn: turn.clone(),
        status,
        completed_at: Some(now()),
    });
    let failure_item_ordinal = failed.then_some(turn.run_ordinal.saturating_mul(1_000_000).saturating_add(999_999));
    events.push(NormalizedEvent::TurnTerminal {
        turn,
        status,
        failure,
        failure_item_ordinal,
        thread_disposition: ThreadDisposition::Reusable,
    });
    ingest::ingest(bus, &events).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn side_chat_digest_reaches_cursor_and_is_marked_after_run_started() {
        if std::process::Command::new("node").arg("--version").stdout(std::process::Stdio::null()).status().is_err() { return; }
        let root=std::env::temp_dir().join(format!("cursor-side-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&root).unwrap(); let sdk=root.join("sdk.cjs");
        std::fs::write(&sdk,r#"const fs=require('node:fs'),path=require('node:path');const agent={agentId:'native-cursor',send:async message=>{fs.writeFileSync(path.join(__dirname,'received'),message);return {id:'run-1',wait:async()=>({status:'finished'}),cancel:async()=>{}}},close:async()=>{}};module.exports={Agent:{create:async()=>agent,resume:async()=>agent}};"#).unwrap();
        let settings=root.join("settings.json"); std::fs::write(&settings,json!({"providerInstances":{"cursor":{"driver":"cursor","enabled":true,"environment":[{"name":"CURSOR_API_KEY","value":"fixture-key"}]}}}).to_string()).unwrap();
        let mut db=rusqlite::Connection::open_in_memory().unwrap(); crate::migrations::run_ported_migrations(&mut db).unwrap(); let bus=EventBus::new(db,32); let selection=json!({"instanceId":"cursor","model":"auto"}); let source=json!("web");
        crate::thread_commands::create_thread_ordered(&bus,crate::thread_commands::CreateThread {command_id:"create",thread_id:"cursor-side",project_id:"p",title:"T",model_selection:&selection,runtime_mode:"full-access",interaction_mode:"default",branch:None,worktree_path:None,created_by:"user",creation_source:&source,link_origin:None,delegated_from:None},"event","2026-01-01T00:00:00Z").unwrap();
        crate::message_commands::dispatch_first_message(&bus,crate::message_commands::DispatchMessage {context:None,command_id:"send",thread_id:"cursor-side",message_id:"m",text:"hello",attachments:&[],creation_source:"web",cwd:root.to_str().unwrap(),driver:"cursor"},"2026-01-01T00:00:01Z").unwrap();
        let effect=bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='cursor-side'",[])?; let provider:String=tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id='cursor-side'",[],|r|r.get(0))?; let h=json!({"id":"side","threadId":"cursor-side","targetRunId":"run:thread:cursor-side:ordinal:1","toProviderThreadId":provider,"strategy":"manual_context","transferId":"fork","summaryText":"parent digest"}); tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side','cursor-side','run:thread:cursor-side:ordinal:1',?1,'manual_context','ready','now',?2)",params![provider,h.to_string()])?; Ok((crate::outbox::list_by_command_id(tx,"send")?.into_iter().find(|e|e.request["type"]=="provider-turn.start").unwrap(),vec![]))}).unwrap();
        start(&bus,&effect,Some(&settings),Some(&sdk),&mut None).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("received")).unwrap(),"parent digest\n\nUser message:\nhello");
        bus.commit(|tx| {let status:String=tx.query_row("SELECT json_extract(payload_json,'$.delivery.status') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side'",[],|r|r.get(0))?;assert_eq!(status,"inline");Ok(((),vec![]))}).unwrap();
        let _=std::fs::remove_dir_all(root);
    }

    #[test]
    fn force_stop_running_sdk_recovers_prompt_after_restart() {
        if std::process::Command::new("node").arg("--version").stdout(std::process::Stdio::null()).status().is_err() { return; }
        let root = std::env::temp_dir().join(format!("cursor-stop-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk, r#"const fs=require('node:fs'), path=require('node:path');
const marker=path.join(__dirname,'first'), received=path.join(__dirname,'received');
const agent={agentId:'native-cursor',send:async message=>{
 if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'1'); return {id:'run-1',wait:async()=>new Promise(()=>{setInterval(()=>{},1000)}),cancel:async()=>{}}; }
 fs.writeFileSync(received,message); return {id:'run-2',wait:async()=>({status:'finished'}),cancel:async()=>{}};
},close:async()=>{}};module.exports={Agent:{create:async()=>agent,resume:async()=>agent}};"#).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"cursor":{"driver":"cursor","enabled":true,"environment":[{"name":"CURSOR_API_KEY","value":"fixture-private-key"}]}}}).to_string()).unwrap();
        let db_path = root.join("state.sqlite");
        let mut db = rusqlite::Connection::open(&db_path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"cursor","model":"auto"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(&bus, crate::thread_commands::CreateThread {
            command_id:"create", thread_id:"cursor-stop-restart", project_id:"p", title:"T", model_selection:&selection,
            runtime_mode:"full-access", interaction_mode:"default", branch:None, worktree_path:None,
            created_by:"user", creation_source:&source, link_origin:None, delegated_from:None,
        }, "event", "2026-01-01T00:00:00.000Z").unwrap();
        let send = |command_id, message_id, text| crate::message_commands::DispatchMessage {
            context:None, command_id, thread_id:"cursor-stop-restart", message_id, text, attachments:&[],
            creation_source:"web", cwd:root.to_str().unwrap(), driver:"cursor",
        };
        crate::message_commands::dispatch_first_message(&bus,send("first","m1","original prompt"),"2026-01-01T00:00:01.000Z").unwrap();
        let effect = bus.commit(|tx| Ok((crate::outbox::list_by_command_id(tx,"first")?.into_iter().find(|e|e.request["type"]=="provider-turn.start").unwrap(),vec![]))).unwrap();
        let run_id = effect.request["runId"].as_str().unwrap().to_owned();
        let worker_bus=bus.clone(); let worker_settings=settings.clone(); let worker_sdk=sdk.clone();
        let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();
        let worker=std::thread::spawn(move || start(&worker_bus,&effect,Some(&worker_settings),Some(&worker_sdk),&mut Some(ready_tx)));
        ready_rx.blocking_recv().unwrap().unwrap();
        let result=crate::interrupt_commands::force_stop_thread(&bus,&crate::provider::session_registry::SessionRegistry::default(),"cursor-stop-restart",Some(&run_id),"2026-01-01T00:00:02.000Z").unwrap();
        assert_eq!(result["outcome"],"releasing");
        worker.join().unwrap().unwrap();
        let retry=bus.commit(|tx| {
            let id:String=tx.query_row("SELECT effect_id FROM orchestration_v2_effect_outbox WHERE json_extract(payload_json,'$.forceStopCursor')=1",[],|row|row.get(0))?;
            Ok((crate::outbox::get(tx,&id)?.unwrap(),vec![]))
        }).unwrap();
        let mut released = false;
        for _ in 0..100 {
            if crate::interrupt_commands::retry_cursor_force_stop(&bus,&retry,"2026-01-01T00:00:03.000Z").is_ok() { released = true; break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(released, "force-stop retry did not reach quiescence");
        drop(bus);
        let bus=EventBus::new(rusqlite::Connection::open(&db_path).unwrap(),32);
        crate::message_commands::dispatch_first_message(&bus,send("second","m2","follow up"),"2026-01-01T00:00:04.000Z").unwrap();
        let effect=bus.commit(|tx| Ok((crate::outbox::list_by_command_id(tx,"second")?.into_iter().find(|e|e.request["type"]=="provider-turn.start").unwrap(),vec![]))).unwrap();
        start(&bus,&effect,Some(&settings),Some(&sdk),&mut None).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("received")).unwrap(),"Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\noriginal prompt\n\nThe new message, which may continue or change that request:\n\nfollow up");
        let session: String = bus.commit(|tx| {
            let id = tx.query_row("SELECT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='cursor-stop-restart' ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0))?;
            Ok((id,vec![]))
        }).unwrap();
        detach(&session,"cursor-stop-restart").unwrap();
        drop(bus);
        let _=std::fs::remove_dir_all(root);
    }
    #[test]
    fn force_stop_preserves_active_prompt_across_database_reopen() {
        let path = std::env::temp_dir().join(format!("cursor-recovery-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = rusqlite::Connection::open(&path).unwrap();
        {
            let tx = db.transaction().unwrap();
            recovery_schema(&tx).unwrap();
            tx.execute("INSERT INTO cursor_prompt_recovery VALUES('thread','active','run','native','original prompt')", []).unwrap();
            preserve_interrupted_prompt(&tx, "thread", "run").unwrap();
            tx.commit().unwrap();
        }
        drop(db);
        let db = rusqlite::Connection::open(&path).unwrap();
        let prompt: String = db.query_row("SELECT prompt FROM cursor_prompt_recovery WHERE thread_id='thread' AND kind='interrupted'", [], |row| row.get(0)).unwrap();
        assert_eq!(prompt, "original prompt");
        drop(db);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn force_stop_retires_session_published_after_starting_snapshot() {
        if std::process::Command::new("node").arg("--version").stdout(std::process::Stdio::null()).status().is_err() { return; }
        let id = format!("cursor-publish-race-{}", uuid::Uuid::new_v4());
        let guard = StartGuard::acquire(&id, &id).unwrap();
        let bridge = CursorBridge::spawn("node", None).unwrap();
        let cancel = bridge.cancel_handle();
        *guard.state.child.lock().unwrap() = Some(cancel.clone());
        let snapshot = force_stop_snapshot(&id, &id).unwrap();
        sessions().lock().unwrap().insert(id.clone(), Active {
            bridge: Arc::new(Mutex::new(bridge)), cancel,
            provider_session_id: id.clone(), thread_id: id.clone(), native_id: "native".into(),
            terminated: Arc::new(AtomicBool::new(false)),
        });
        snapshot.stop(&id, 1);
        drop(guard);
        for _ in 0..100 {
            if has_verified_stop(&id, &id, 1) { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(has_verified_stop(&id, &id, 1));
        assert!(!is_active(&id), "published session must be retired after its child stops");
        clear_verified_stop(&id, &id, 1);
    }
    #[test]
    fn force_stop_only_terminates_captured_session_generation() {
        if std::process::Command::new("node").arg("--version").stdout(std::process::Stdio::null()).status().is_err() { return; }
        let key = format!("cursor-generation-{}", uuid::Uuid::new_v4());
        let make = || {
            let bridge = CursorBridge::spawn("node", None).unwrap();
            let cancel = bridge.cancel_handle();
            Active { bridge:Arc::new(Mutex::new(bridge)), cancel, provider_session_id:key.clone(), thread_id:key.clone(), native_id:"native".into(), terminated:Arc::new(AtomicBool::new(false)) }
        };
        sessions().lock().unwrap().insert(key.clone(), make());
        let old = force_stop_snapshot(&key, &key).unwrap();
        sessions().lock().unwrap().insert(key.clone(), make());
        old.stop(&key,1);
        assert!(is_active(&key));
        let current = force_stop_snapshot(&key, &key).unwrap();
        current.stop(&key,2);
        for _ in 0..100 { if !is_active(&key) { break; } std::thread::sleep(Duration::from_millis(20)); }
        assert!(!is_active(&key));
    }
    #[test]
    fn failed_send_before_run_started_retires_session() {
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-cursor-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk, r#"const agent={agentId:'native-cursor',send:async()=>{throw new Error('send failed')},close:async()=>{}};module.exports={Agent:{create:async()=>agent,resume:async()=>agent}};"#).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"cursor":{"driver":"cursor","enabled":true,"environment":[{"name":"CURSOR_API_KEY","value":"fixture-private-key"}]}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"cursor","model":"auto"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-cursor-failed",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
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
                thread_id: "t-cursor-failed",
                message_id: "m-cursor-failed",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver: "cursor",
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
        assert!(start(&bus, &effect, Some(&settings), Some(&sdk), &mut None).is_err());
        let key: String = bus.commit(|tx| {
            let key = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t-cursor-failed'", [], |row| row.get(0))?;
            Ok((key, vec![]))
        }).unwrap();
        assert!(!is_active(&key), "failed send must retire its SDK session");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn cancelled_run_recovers_prompt_only_for_same_agent() {
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-cursor-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk, r#"const agent={agentId:'native-cursor',send:async()=>({id:'native-run',wait:async()=>({status:'cancelled'}),cancel:async()=>{}}),close:async()=>{}};module.exports={Agent:{create:async()=>agent,resume:async()=>agent}};"#).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"cursor":{"driver":"cursor","enabled":true,"environment":[{"name":"CURSOR_API_KEY","value":"fixture-private-key"}]}}}).to_string()).unwrap();
        let db_path = root.join("state.sqlite");
        let mut db = rusqlite::Connection::open(&db_path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"cursor","model":"auto"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-cursor-interrupted",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
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
                thread_id: "t-cursor-interrupted",
                message_id: "m-cursor-interrupted",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver: "cursor",
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
        start(&bus, &effect, Some(&settings), Some(&sdk), &mut None).unwrap();
        drop(bus);
        let bus = EventBus::new(rusqlite::Connection::open(&db_path).unwrap(), 16);
        let recovered = prepare_prompt(&bus, "t-cursor-interrupted", "next-run", "native-cursor", "follow up").unwrap().0;
        assert_eq!(recovered, "Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\nhello\n\nThe new message, which may continue or change that request:\n\nfollow up");
        assert_eq!(prepare_prompt(&bus, "t-cursor-interrupted", "next-run", "other-agent", "follow up").unwrap().0, "follow up");
        let key: String = bus.commit(|tx| {
            let key = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t-cursor-interrupted'", [], |row| row.get(0))?;
            Ok((key, vec![]))
        }).unwrap();
        sessions().lock().unwrap().remove(&key);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn fake_sdk_projects_a_completed_cursor_turn() {
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-cursor-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk, r#"const agent={agentId:'native-cursor',send:async(message,options)=>{await options.onDelta({update:{type:'step-started'}});await options.onDelta({update:{type:'thinking-delta',text:'thinking'}});await options.onDelta({update:{type:'text-delta',text:'before tool'}});await options.onDelta({update:{type:'tool-call-started',callId:'plan-1',toolCall:{type:'createPlan',args:{plan:'First plan'}}}});await options.onDelta({update:{type:'tool-call-completed',callId:'plan-1',toolCall:{type:'createPlan',args:{plan:'Final plan'},result:{status:'success',value:{}}}}});await options.onDelta({update:{type:'tool-call-started',callId:'todo-1',toolCall:{type:'updateTodos',args:{todos:[{content:'Ship',status:'pending'}]}}}});await options.onDelta({update:{type:'tool-call-completed',callId:'todo-1',toolCall:{type:'updateTodos',args:{todos:[]},result:{status:'success',value:{todos:[{content:'Ship',status:'inProgress'},{content:'Done',status:'completed'},{content:'Skip',status:'cancelled'}]}}}}});await options.onDelta({update:{type:'tool-call-started',callId:'shell-1',toolCall:{type:'shell',args:{command:'pwd'}}}});await options.onDelta({update:{type:'shell-output-delta',event:{toolCallId:'shell-1',case:'stdout',value:{data:'/t'}}}});await options.onDelta({update:{type:'shell-output-delta',event:{case:'stdout',value:{data:'mp'}}}});await options.onDelta({update:{type:'tool-call-completed',callId:'shell-1',toolCall:{type:'shell',args:{command:'pwd'},result:{status:'success',value:{stdout:'',exitCode:0}}}}});await options.onDelta({update:{type:'text-delta',text:'hello from cursor'}});return {id:'native-run',wait:async()=>({status:'finished'}),cancel:async()=>{}}},close:async()=>{}};module.exports={Agent:{create:async()=>agent,resume:async()=>agent}};"#).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"cursor":{"driver":"cursor","enabled":true,"environment":[{"name":"CURSOR_API_KEY","value":"fixture-private-key"}]}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let selection = json!({"instanceId":"cursor","model":"auto"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t-cursor",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
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
                thread_id: "t-cursor",
                message_id: "m-cursor",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver: "cursor",
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
        start(&bus, &effect, Some(&settings), Some(&sdk), &mut None).unwrap();
        let tail = bus.command_output().get("t-cursor", "turn-item:provider:cursor:native-item:shell-1").unwrap();
        assert_eq!(tail.text, "/tmp"); assert!(tail.finished);
        let key=bus.commit(|tx| {
            let (key,raw):(String,String)=tx.query_row("SELECT provider_thread_id,payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='t-cursor'",[],|row|Ok((row.get(0)?,row.get(1)?)))?;
            let pt:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(pt["nativeThreadRef"]["nativeId"],"native-cursor");
            let mut stmt=tx.prepare("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_turn_items WHERE thread_id='t-cursor' AND type='assistant_message' ORDER BY ordinal")?;
            let messages=stmt.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(messages,vec!["before tool","hello from cursor"]);
            let reasoning:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_turn_items WHERE thread_id='t-cursor' AND type='reasoning'",[],|row|row.get(0))?; assert_eq!(reasoning,"thinking");
            let tool:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id='t-cursor' AND type='command_execution'",[],|row|row.get(0))?;
            let tool:Value=serde_json::from_str(&tool).unwrap(); assert_eq!(tool["output"],"/tmp"); assert_eq!(tool["status"],"completed"); assert_eq!(tool["nativeItemRef"]["strength"],"strong");
            let plan: String = tx.query_row("SELECT json_extract(payload_json,'$.markdown') FROM orchestration_v2_projection_plans WHERE thread_id='t-cursor' AND kind='proposed_plan'", [], |r|r.get(0))?; assert_eq!(plan,"Final plan");
            let todos: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id='t-cursor' AND kind='todo_list'", [], |r|r.get(0))?; let todos:Value=serde_json::from_str(&todos).unwrap(); assert_eq!(todos["steps"],json!([{"id":"todo-1","text":"Ship","status":"running"},{"id":"todo-2","text":"Done","status":"completed"}]));
            let drafts:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE stream_id='t-cursor' AND event_type='plan.updated' AND json_extract(payload_json,'$.status')='draft'",[],|r|r.get(0))?; assert_eq!(drafts,2);
            let strength:String=tx.query_row("SELECT json_extract(payload_json,'$.nativeTurnRef.strength') FROM orchestration_v2_projection_provider_turns WHERE thread_id='t-cursor'",[],|row|row.get(0))?; assert_eq!(strength,"strong");
            let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t-cursor'",[],|row|row.get(0))?; assert_eq!(status,"waiting"); Ok((key,vec![]))
        }).unwrap();
        let stale = RootTurn { driver:"cursor".into(), native_thread_id:"native-cursor".into(), native_turn_id:"native-run".into(), provider_thread_id:key.clone(), provider_turn_id:"stale".into(), thread_id:"t-cursor".into(), run_id:Some("missing-run".into()), run_attempt_id:"stale".into(), root_node_id:"stale".into(), provider_turn_ordinal:1, run_ordinal:1, started_at:now() };
        cursor_tools::project_plan(&bus, &stale, &json!({"type":"tool-call-completed","callId":"stale-plan","toolCall":{"type":"createPlan","args":{"plan":"stale"},"result":{"status":"success","value":{}}}}), 99, &now()).unwrap();
        ingest::ingest(&bus, &[NormalizedEvent::ProviderTurnUpdated { turn:stale, status:TurnStatus::Failed, completed_at:Some(now()) }]).unwrap();
        bus.commit(|tx| { let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id='stale'",[],|row|row.get(0))?; assert_eq!(count,0); let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_plans WHERE json_extract(payload_json,'$.markdown')='stale'",[],|row|row.get(0))?; assert_eq!(count,0); Ok(((),vec![])) }).unwrap();
        sessions().lock().unwrap().remove(&key);
        let _ = std::fs::remove_dir_all(root);
    }
}
