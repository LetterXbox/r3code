//! Claude Code stream-json root-turn execution.
use crate::{
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        codex_events::{
            AssistantArtifact, CommandArtifact, FailureClass, NormalizedEvent, ProviderFailure,
            ReasoningArtifact, RootTurn, ThreadDisposition, ToolArtifact, TurnStatus,
        },
        ingest, lifecycle,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

fn terminal_result(event: &Value) -> (TurnStatus, String) {
    let reason = event["terminal_reason"].as_str().unwrap_or("");
    if matches!(reason, "aborted_tools" | "aborted_streaming") {
        return (TurnStatus::Interrupted, "Claude was interrupted.".into());
    }
    let errors = event["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if event["subtype"] != "success" && (errors.contains("interrupt") || errors.contains("cancel"))
    {
        return (TurnStatus::Interrupted, "Claude was interrupted.".into());
    }
    let detail=match reason {"api_error"=>Some("Claude gave up after repeated API errors."),"malformed_tool_use_exhausted"=>Some("Claude gave up after repeated malformed tool calls."),"budget_exhausted"=>Some("Claude stopped: the turn's token budget was exhausted."),"structured_output_retry_exhausted"=>Some("Claude could not produce the requested structured output."),"tool_deferred_unavailable"=>Some("Claude could not resume a deferred tool call: the tool is no longer available."),"turn_setup_failed"=>Some("Claude could not start the turn."),"blocking_limit"|"prompt_too_long"=>Some("Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread."),"rapid_refill_breaker"=>Some("Claude stopped: the context refilled too quickly after compaction."),"image_error"=>Some("Claude stopped: an image in the conversation could not be processed."),"model_error"=>Some("Claude stopped: the model returned an error."),_=>None};
    if let Some(detail) = detail {
        return (TurnStatus::Failed, detail.into());
    }
    if matches!(event["api_error_status"].as_u64(), Some(429 | 529))
        || event["subtype"] != "success"
        || event["is_error"] == true
    {
        return (TurnStatus::Failed, "Claude reported a turn failure.".into());
    }
    (TurnStatus::Completed, String::new())
}
fn turn_usage(
    result: Option<&Value>,
    completed: bool,
    models: &[String],
    has_subagents: bool,
) -> Value {
    let usage = result.map(|r| &r["usage"]).unwrap_or(&Value::Null);
    let read = |key: &str| usage[key].as_u64();
    let uncached = read("input_tokens");
    let cached = read("cache_read_input_tokens");
    let creation = read("cache_creation_input_tokens");
    let output = read("output_tokens");
    let known = uncached.is_some() || cached.is_some() || creation.is_some() || output.is_some();
    let positive = [uncached, cached, creation, output]
        .into_iter()
        .flatten()
        .any(|n| n > 0);
    let status = if !known || (!completed && !positive) {
        "unavailable"
    } else if completed && uncached.is_some() && output.is_some() {
        "complete"
    } else {
        "partial"
    };
    let mut value =
        json!({"usageStatus":status,"usageScope":"main_agent","hasSubagents":has_subagents});
    if !models.is_empty() {
        value["models"] = json!(models);
    }
    if status != "unavailable" {
        if let Some(n) = uncached {
            value["inputTokens"] = json!(n
                .saturating_add(cached.unwrap_or(0))
                .saturating_add(creation.unwrap_or(0)));
        }
        if let Some(n) = cached {
            value["cachedInputTokens"] = json!(n);
        }
        if let Some(n) = creation {
            value["cacheCreationTokens"] = json!(n);
        }
        if let Some(n) = output {
            value["outputTokens"] = json!(n);
            if let Some(thinking) = usage["output_tokens_details"]["thinking_tokens"].as_u64() {
                value["reasoningTokens"] = json!(thinking.min(n));
            }
        }
    }
    value
}
enum ClaudeTool {
    Command(CommandArtifact),
    Other(ToolArtifact),
}
fn start_tool(
    bus: &EventBus,
    turn: &RootTurn,
    id: &str,
    name: &str,
    input: &Value,
    ordinal: u64,
) -> Result<ClaudeTool, String> {
    let at = now();
    if name.eq_ignore_ascii_case("Bash") {
        let artifact = CommandArtifact {
            turn: turn.clone(),
            native_item_id: id.into(),
            input: input["command"].as_str().unwrap_or("").into(),
            output: None,
            exit_code: None,
            ordinal,
            started_at: at.clone(),
            updated_at: at,
            status: "running".into(),
        };
        ingest::ingest(bus, &[NormalizedEvent::CommandUpdated(artifact.clone())])
            .map_err(|e| e.to_string())?;
        Ok(ClaudeTool::Command(artifact))
    } else {
        let filename = input["file_path"].as_str().filter(|s| !s.trim().is_empty());
        let file_change = matches!(
            name.to_ascii_lowercase().as_str(),
            "edit" | "write" | "multiedit" | "notebookedit"
        ) && filename.is_some();
        let fields = if file_change {
            json!({"fileName":filename})
        } else {
            json!({"toolName":name,"input":input})
        };
        let artifact = ToolArtifact {
            turn: turn.clone(),
            native_item_id: id.into(),
            ordinal,
            started_at: at.clone(),
            updated_at: at,
            status: "running".into(),
            kind: if file_change {
                "file_change"
            } else {
                "dynamic_tool"
            }
            .into(),
            fields,
        };
        ingest::ingest(bus, &[NormalizedEvent::ToolUpdated(artifact.clone())])
            .map_err(|e| e.to_string())?;
        Ok(ClaudeTool::Other(artifact))
    }
}
fn finish_tool(bus: &EventBus, tool: ClaudeTool, block: &Value) -> Result<(), String> {
    let state = if block["is_error"] == true {
        "failed"
    } else {
        "completed"
    };
    match tool {
        ClaudeTool::Command(mut a) => {
            a.updated_at = now();
            a.status = state.into();
            a.output = Some(match &block["content"] {
                Value::String(s) => s.clone(),
                v => v.to_string(),
            });
            ingest::ingest(bus, &[NormalizedEvent::CommandUpdated(a)])
        }
        ClaudeTool::Other(mut a) => {
            a.updated_at = now();
            a.status = state.into();
            if a.kind == "dynamic_tool" {
                a.fields["output"] = block["content"].clone();
            }
            ingest::ingest(bus, &[NormalizedEvent::ToolUpdated(a)])
        }
    }
    .map_err(|e| e.to_string())
}
fn interrupt_tool(bus: &EventBus, tool: ClaudeTool) -> Result<(), String> {
    match tool {
        ClaudeTool::Command(mut a) => {
            a.updated_at = now();
            a.status = "interrupted".into();
            ingest::ingest(bus, &[NormalizedEvent::CommandUpdated(a)])
        }
        ClaudeTool::Other(mut a) => {
            a.updated_at = now();
            a.status = "interrupted".into();
            ingest::ingest(bus, &[NormalizedEvent::ToolUpdated(a)])
        }
    }
    .map_err(|e| e.to_string())
}
type ControlWaiters = Arc<Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>>;
struct ProcessGroup(Option<u32>);
impl ProcessGroup {
    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.take() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            self.0 = None;
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}
#[derive(Default)]
struct BackgroundRoster {
    tasks: HashMap<String, Value>,
    awaited: std::collections::HashSet<String>,
}

struct Active {
    provider_thread_id: String,
    interrupt_requested: Arc<std::sync::atomic::AtomicBool>,
    interrupt_request_id: Arc<Mutex<Option<String>>>,
    model: String,
    options: Value,
    signature: String,
    generation: String,
    background_count: Arc<std::sync::atomic::AtomicUsize>,
    background_roster: Arc<Mutex<BackgroundRoster>>,
    current_prompt: Arc<Mutex<String>>,
    control_waiters: ControlWaiters,
    turn: String,
    session: String,
    cancel: oneshot::Sender<()>,
    writer: mpsc::UnboundedSender<crate::provider::claude_requests::ProcessWrite>,
}
fn active() -> &'static Mutex<HashMap<String, Active>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn is_active(provider_thread_id: &str) -> bool {
    active().lock().is_ok_and(|sessions| {
        sessions.values().any(|session| {
            session.provider_thread_id == provider_thread_id
                && !session.turn.is_empty()
                && !session.writer.is_closed()
        })
    })
}
pub(crate) fn has_provider_thread(thread_id: &str, provider_thread_id: &str) -> bool {
    active().lock().is_ok_and(|sessions| {
        sessions.get(thread_id).is_some_and(|session| {
            session.provider_thread_id == provider_thread_id && !session.writer.is_closed()
        })
    })
}
fn sync_pending_background_tasks(
    bus: &EventBus,
    provider_thread_id: &str,
    roster: &BackgroundRoster,
    now: &str,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let pending: Vec<Value> = roster
        .tasks
        .iter()
        .map(|(id, item)| {
            let mut next = item.clone();
            if roster.awaited.contains(id) {
                next["awaited"] = json!(true);
            } else if let Some(obj) = next.as_object_mut() {
                obj.remove("awaited");
            }
            next
        })
        .collect();
    bus.commit(|tx| {
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT thread_id, payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",
                [provider_thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((thread_id, raw)) = row else {
            return Ok(((), vec![]));
        };
        let mut payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        payload["pendingBackgroundTasks"] = json!(pending);
        payload["updatedAt"] = json!(now);
        tx.execute(
            "UPDATE orchestration_v2_projection_provider_threads SET updated_at=?2, payload_json=?3 WHERE provider_thread_id=?1",
            rusqlite::params![provider_thread_id, now, payload.to_string()],
        )?;
        let event = crate::event_store::Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id,
            event_type: "provider-thread.updated".into(),
            occurred_at: now.to_owned(),
            command_id: None,
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "provider".into(),
            payload,
            metadata: json!({}),
        };
        let stored = crate::event_store::append(tx, &[event])?;
        Ok(((), stored))
    })
    .map_err(|e| e.to_string())
}
pub(crate) async fn stop_task(thread_id: &str, task_id: &str) -> Result<(), String> {
    let (writer, waiters) = {
        let map = active().lock().map_err(|e| e.to_string())?;
        let entry = map
            .get(thread_id)
            .filter(|e| !e.writer.is_closed())
            .ok_or_else(|| "Claude session is not active.".to_owned())?;
        (entry.writer.clone(), entry.control_waiters.clone())
    };
    let request_id = format!("stop-task-{}", uuid::Uuid::new_v4());
    let (ack_tx, ack_rx) = oneshot::channel();
    let (ctrl_tx, ctrl_rx) = oneshot::channel();
    {
        let mut map = waiters.lock().map_err(|e| e.to_string())?;
        map.insert(request_id.clone(), ctrl_tx);
    }
    let send_res = writer.send(crate::provider::claude_requests::ProcessWrite {
        value: json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "stop_task",
                "task_id": task_id,
            }
        }),
        ack: Some(ack_tx),
        begin: None,
    });
    if send_res.is_err() {
        if let Ok(mut map) = waiters.lock() {
            map.remove(&request_id);
        }
        return Err("Claude session closed before stop_task.".into());
    }
    let res = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        ack_rx
            .await
            .map_err(|_| "Claude stdin write aborted.".to_owned())??;
        ctrl_rx
            .await
            .map_err(|_| "Claude stop_task response aborted.".to_owned())?
    })
    .await;
    if let Ok(mut map) = waiters.lock() {
        map.remove(&request_id);
    }
    match res {
        Ok(inner) => inner,
        Err(_) => Err("Timed out waiting for Claude stop_task response.".into()),
    }
}
pub(crate) fn await_background_tasks(
    bus: &EventBus,
    thread_id: &str,
    provider_thread_id: &str,
    task_ids: &[String],
    awaited: bool,
    now: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let roster_arc = {
        let map = active().lock().map_err(|e| e.to_string())?;
        let entry = map
            .get(thread_id)
            .filter(|e| e.provider_thread_id == provider_thread_id && !e.writer.is_closed())
            .ok_or_else(|| "Claude session is not active.".to_owned())?;
        entry.background_roster.clone()
    };
    let mut seen = std::collections::HashSet::new();
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut roster = roster_arc.lock().map_err(|e| e.to_string())?;
    for id in task_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        if roster.tasks.contains_key(id) {
            if awaited {
                roster.awaited.insert(id.clone());
            } else {
                roster.awaited.remove(id);
            }
            matched.push(id.clone());
        } else {
            unmatched.push(id.clone());
        }
    }
    if !matched.is_empty() {
        sync_pending_background_tasks(bus, provider_thread_id, &roster, now)?;
    }
    Ok((matched, unmatched))
}
pub(crate) fn detach_provider_thread(thread_id: &str, provider_thread_id: &str) {
    if let Ok(mut entries) = active().lock() {
        if entries
            .get(thread_id)
            .is_some_and(|entry| entry.provider_thread_id == provider_thread_id)
        {
            crate::provider::claude_requests::clear_session(thread_id);
            if let Some(entry) = entries.remove(thread_id) {
                let _ = entry.cancel.send(());
            }
        }
    }
}
fn starting() -> &'static Mutex<std::collections::HashSet<String>> {
    static STARTING: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    STARTING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
struct StartGuard(String);
impl StartGuard {
    fn acquire(thread: &str) -> Result<Self, String> {
        let mut starting = starting()
            .lock()
            .map_err(|_| "Claude start registry unavailable")?;
        if starting.contains(thread)
            || active()
                .lock()
                .map_err(|_| "Claude turn registry unavailable")?
                .get(thread)
                .is_some_and(|entry| !entry.turn.is_empty())
        {
            return Err("Claude turn already active".into());
        }
        starting.insert(thread.to_owned());
        Ok(Self(thread.to_owned()))
    }
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Ok(mut starting) = starting().lock() {
            starting.remove(&self.0);
        }
    }
}
fn missing_resume_result(frame: &Value, session: &str) -> bool {
    frame["type"] == "result"
        && frame["subtype"] == "error_during_execution"
        && frame["errors"].as_array().is_some_and(|errors| {
            errors.len() == 1
                && errors[0] == format!("No conversation found with session ID: {session}")
        })
}

fn fresh_resume_prompt(
    bus: &EventBus,
    thread_id: &str,
    run: &Value,
    message: &Value,
    attachments_dir: &Path,
) -> Result<Value, String> {
    let messages = bus.commit(|tx| {
        let mut stmt = tx.prepare(
            "SELECT payload_json FROM orchestration_v2_projection_messages
             WHERE thread_id=?1 AND role IN ('user','assistant') AND streaming=0
               AND (run_id IS NULL OR run_id IN (
                 SELECT run_id FROM orchestration_v2_projection_runs
                 WHERE thread_id=?1 AND ordinal<?2 AND status!='rolled_back'
               ))
               AND message_id!=?3
             ORDER BY created_at DESC, message_id DESC LIMIT 200"
        )?;
        let rows = stmt.query_map(
            params![thread_id, run["ordinal"].as_i64(), run["userMessageId"].as_str()],
            |row| row.get::<_, String>(0)
        )?;
        let mut history = Vec::new();
        for raw in rows {
            let entry: Value = serde_json::from_str(&raw?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if let Some(text) = entry["text"].as_str().filter(|text| !text.trim().is_empty()) {
                history.push(json!({
                    "role":entry["role"],"text":text,"threadId":thread_id,
                    "runId":entry["runId"],"itemId":entry["id"],"kind":"message"
                }));
            }
        }
        history.reverse();
        Ok((history, vec![]))
    }).map_err(|error| error.to_string())?;
    let mut recovered = message.clone();
    if !messages.is_empty() {
        let text = message["text"].as_str().unwrap_or("");
        let budget = crate::context_handoff::handoff_budget(
            crate::context_handoff::token_cap(std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").ok().as_deref()),
            text, message["attachments"].as_array().map(Vec::as_slice).unwrap_or(&[]), None, 0, None,
        );
        let coverage = "Claude's previous native conversation was unavailable. This is recovered history before the current request.";
        let selected = crate::context_handoff::select_history(&messages, coverage, 0, &[], budget);
        if crate::context_handoff::history_cost(&selected.messages, &selected.context) > budget {
            return Err("The request leaves too little context to recover the missing Claude conversation.".into());
        }
        recovered["text"] = json!(format!("{}\n\n[Current input]\n{text}",
            crate::context_handoff::render_history(&selected.messages, &selected.context)));
    }
    input_content(&recovered, attachments_dir)
}

fn missed_start_images(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    run: &Value,
) -> rusqlite::Result<Vec<Value>> {
    let mut statement = tx.prepare(
        "SELECT m.payload_json
         FROM orchestration_v2_projection_runs r
         JOIN orchestration_v2_projection_messages m
           ON m.message_id=json_extract(r.payload_json,'$.userMessageId') AND m.thread_id=r.thread_id
         WHERE r.thread_id=?1 AND r.provider_instance_id=?2 AND r.ordinal<?3
           AND r.status IN ('failed','interrupted') AND json_extract(r.payload_json,'$.startedAt') IS NULL
           AND json_array_length(json_extract(m.payload_json,'$.attachments')) > 0
           AND NOT EXISTS (
             SELECT 1 FROM orchestration_v2_projection_runs newer
             WHERE newer.thread_id=r.thread_id AND newer.provider_instance_id=r.provider_instance_id
               AND newer.ordinal>r.ordinal AND newer.ordinal<?3
               AND json_extract(newer.payload_json,'$.startedAt') IS NOT NULL
           )
         ORDER BY r.ordinal DESC LIMIT 16"
    )?;
    let rows = statement.query_map(
        params![thread_id, run["providerInstanceId"].as_str(), run["ordinal"].as_i64()],
        |row| row.get::<_, String>(0)
    )?;
    let mut images = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for raw in rows {
        let message: Value = serde_json::from_str(&raw?).map_err(|_| rusqlite::Error::InvalidQuery)?;
        for attachment in message["attachments"].as_array().into_iter().flatten().rev() {
            if attachment["type"] == "image" && attachment["id"].as_str().is_some_and(|id| ids.insert(id.to_owned())) {
                images.push(attachment.clone());
                if images.len() == 8 {
                    images.reverse();
                    return Ok(images);
                }
            }
        }
    }
    images.reverse();
    Ok(images)
}

fn input_content(message: &Value, attachments_dir: &Path) -> Result<Value, String> {
    let native_input = crate::provider::executor::codex_input(message, attachments_dir)?;
    let mut blocks = Vec::new();
    for part in native_input {
        match part["type"].as_str() {
            Some("text") => blocks.push(json!({"type":"text","text":part["text"]})),
            Some("image") => {
                let url = part["url"].as_str().ok_or("Invalid image attachment")?;
                let (mime, data) = url
                    .strip_prefix("data:")
                    .and_then(|v| v.split_once(";base64,"))
                    .ok_or("Invalid image attachment")?;
                blocks.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}));
            }
            _ => return Err("Unsupported Claude attachment".into()),
        }
    }
    let prompt = if blocks.len() == 1
        && blocks[0]["type"] == "text"
        && message["attachments"].as_array().is_none_or(Vec::is_empty)
    {
        blocks[0]["text"].clone()
    } else {
        json!(blocks)
    };
    Ok(prompt)
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn str_field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {k}"))
}
pub(crate) fn interrupt(thread_id: &str, expected_turn: &str) -> Result<(), String> {
    let active = active().lock().map_err(|e| e.to_string())?;
    let entry = active
        .get(thread_id)
        .filter(|entry| entry.turn == expected_turn)
        .ok_or("Claude turn is not active")?;
    entry
        .interrupt_requested
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let id = uuid::Uuid::new_v4().to_string();
    *entry
        .interrupt_request_id
        .lock()
        .map_err(|_| "Claude interrupt registry unavailable")? = Some(id.clone());
    entry.writer.send(crate::provider::claude_requests::ProcessWrite { value: json!({"type":"control_request","request_id":id,"request":{"subtype":"interrupt"}}), ack: None, begin: None }).map_err(|_| "Claude session is no longer active".to_owned())
}

pub(crate) fn detach(thread_id: &str) {
    crate::provider::claude_requests::clear_session(thread_id);
    if let Ok(mut entries) = active().lock() {
        if let Some(entry) = entries.remove(thread_id) {
            let _ = entry.cancel.send(());
        }
    }
}

pub(crate) async fn steer(
    bus: &EventBus,
    effect: &Effect,
    attachments_dir: &Path,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay a provider turn steer after an uncertain failure".into());
    }
    let turn_id = str_field(&effect.request, "providerTurnId")?;
    let message_id = str_field(&effect.request, "messageId")?;
    let message=bus.commit(|tx| {
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1 AND thread_id=?2",params![message_id,effect.thread_id],|r|r.get(0))?;
        let value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        Ok((value,vec![]))
    }).map_err(|e|e.to_string())?;
    let content = input_content(&message, attachments_dir)?;
    let (writer, session, active_model, active_options, control_waiters, current_prompt) = {
        let entries = active().lock().map_err(|e| e.to_string())?;
        let entry = entries
            .get(&effect.thread_id)
            .filter(|entry| entry.turn == turn_id)
            .ok_or("Claude turn is not active")?;
        (
            entry.writer.clone(),
            entry.session.clone(),
            entry.model.clone(),
            entry.options.clone(),
            entry.control_waiters.clone(),
            entry.current_prompt.clone(),
        )
    };
    if effect.request["modelSelection"].is_object()
        && effect.request["modelSelection"]
            .get("options")
            .unwrap_or(&Value::Null)
            != &active_options
    {
        return Err(
            "Changing Claude model options during an active turn is not supported yet".into(),
        );
    }
    if let Some(model) = effect
        .request
        .pointer("/modelSelection/model")
        .and_then(Value::as_str)
        .filter(|model| *model != active_model)
    {
        let control_id = uuid::Uuid::new_v4().to_string();
        let (control_tx, control_rx) = oneshot::channel();
        control_waiters
            .lock()
            .map_err(|_| "Claude control registry unavailable")?
            .insert(control_id.clone(), control_tx);
        let (write_tx, write_rx) = oneshot::channel();
        writer.send(crate::provider::claude_requests::ProcessWrite{value:json!({"type":"control_request","request_id":control_id,"request":{"subtype":"set_model","model":model}}),ack:Some(write_tx),begin:None}).map_err(|_|"Claude turn is not active")?;
        tokio::time::timeout(std::time::Duration::from_secs(30), write_rx)
            .await
            .map_err(|_| "Claude model change timed out")?
            .map_err(|_| "Claude turn is not active")??;
        tokio::time::timeout(std::time::Duration::from_secs(30), control_rx)
            .await
            .map_err(|_| "Claude model change timed out")?
            .map_err(|_| "Claude turn is not active")??;
        if let Ok(mut entries) = active().lock() {
            if let Some(entry) = entries
                .get_mut(&effect.thread_id)
                .filter(|entry| entry.turn == turn_id)
            {
                entry.model = model.into();
            }
        }
    }
    let prompt_id = uuid::Uuid::new_v4().to_string();
    *current_prompt
        .lock()
        .map_err(|_| "Claude prompt registry unavailable")? = prompt_id.clone();
    let (ack_tx, ack_rx) = oneshot::channel();
    writer.send(crate::provider::claude_requests::ProcessWrite{value:json!({"type":"user","message":{"role":"user","content":content},"parent_tool_use_id":null,"session_id":session,"uuid":prompt_id}),ack:Some(ack_tx),begin:None}).map_err(|_|"Claude turn is not active")?;
    tokio::time::timeout(std::time::Duration::from_secs(30), ack_rx)
        .await
        .map_err(|_| "Claude steering timed out")?
        .map_err(|_| "Claude turn is not active")??;
    Ok(())
}

pub(crate) async fn restart(
    bus: EventBus,
    effect: &Effect,
    settings_path: &Path,
    attachments_dir: &Path,
    mcp: Option<(&str, &crate::provider::session_registry::SessionRegistry)>,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err(
            "Cannot safely replay a provider turn restart after an uncertain failure".into(),
        );
    }
    if !effect.request["sessionTransition"].is_null() {
        return Err("Claude session transitions during restart are not supported".into());
    }
    let turn_id = str_field(&effect.request, "providerTurnId")?;
    let attempt_id = str_field(&effect.request, "interruptedAttemptId")?;
    let run_id = str_field(&effect.request, "runId")?;
    let state = || {
        bus.commit(|tx| {
        let row:Option<(String,String,String)>=tx.query_row("SELECT t.status,COALESCE(t.run_attempt_id,''),r.status FROM orchestration_v2_projection_provider_turns t JOIN orchestration_v2_projection_runs r ON r.run_id=?1 AND r.thread_id=t.thread_id WHERE t.provider_turn_id=?2 AND t.thread_id=?3",params![run_id,turn_id,effect.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        Ok((row,vec![]))
    }).map_err(|e|e.to_string())
    };
    let (status, attempt, run_status) = state()?.ok_or("Restart target was not found")?;
    if attempt != attempt_id {
        return Err("Restart target attempt does not match".into());
    }
    if run_status != "starting" {
        return Ok(());
    }
    if matches!(status.as_str(), "pending" | "running") {
        interrupt(&effect.thread_id, turn_id)?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let (status, _, run_status) = state()?.ok_or("Restart target was not found")?;
            if run_status != "starting" {
                return Ok(());
            }
            if !matches!(status.as_str(), "pending" | "running") {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("provider interrupt unresponsive".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    start(bus, effect, settings_path, attachments_dir, mcp).await
}

fn capabilities(has_mcp: bool) -> Value {
    json!({
        "sessions":{"supportsMultipleProviderThreadsPerSession":false,"supportsModelSwitchInSession":true,"supportsProviderSwitchingViaHandoff":false,"supportsRuntimeModeSwitchInSession":false,"pendingRequestsSurviveRestart":false},
        "threads":{"canCreateEmptyThread":true,"canReadThreadSnapshot":false,"canRollbackThread":false,"canForkThread":false,"canForkFromTurn":false,"canForkFromSubagentThread":false,"exposesNativeThreadId":true},
        "turns":{"exposesNativeTurnId":false,"emitsTurnStarted":true,"emitsTurnCompleted":true,"supportsInterrupt":true,"supportsActiveSteering":true,"activeSteeringInterruptsTools":false,"supportsSteeringByInterruptRestart":false,"supportsQueuedMessages":true,"terminalStatusQuality":"strong"},
        "streaming":{"streamsAssistantText":true,"streamsReasoning":true,"streamsToolOutput":false,"streamsPlanText":false,"emitsMessageCompleted":true},
        "tools":{"exposesToolItemIds":true,"emitsToolStarted":true,"emitsToolCompleted":true,"emitsToolOutput":true,"supportsMcpTools":has_mcp,"supportsDynamicToolCallbacks":false},
        "approvals":{"supportsCommandApproval":true,"supportsFileReadApproval":true,"supportsFileChangeApproval":true,"supportsApplyPatchApproval":false,"approvalsHaveNativeRequestIds":true,"approvalCallbacksAreLiveOnly":true,"approvalsCanOriginateFromSubagents":false},
        "planning":{"emitsPlanUpdated":false,"emitsTodoList":false,"emitsProposedPlan":true,"supportsStructuredQuestions":true,"planDeltasHaveItemIds":false},
        "subagents":{"supportsSubagents":false,"exposesSubagentThreadIds":false,"emitsSubagentLifecycle":false,"canWaitForSubagents":false,"canCloseSubagents":false,"canForkSubagentThread":false},
        "context":{"acceptsSystemContext":false,"acceptsDeveloperContext":false,"acceptsSyntheticUserContext":false,"canGenerateSummaries":false,"canConsumeHandoffSummaries":false,"supportsDeltaHandoff":false,"supportsFullThreadHandoff":false,"maxRecommendedHandoffChars":null},
        "checkpointing":{"appCanCheckpointFilesystem":true,"supportsNestedCheckpointScopes":false,"providerCanRollbackConversation":false,"providerRollbackReturnsSnapshot":false,"providerCanReadConversationSnapshot":false},
        "identity":{"nativeThreadIds":"strong","nativeTurnIds":"weak","nativeItemIds":"strong","nativeRequestIds":"strong"},"runtimePolicy":{"enforcement":"native"}
    })
}
fn mark_handoffs(
    bus: &EventBus,
    thread_id: &str,
    native_thread: &str,
    delivered: Vec<Value>,
) -> Result<(), String> {
    if delivered.is_empty() {
        return Ok(());
    }
    bus.commit(|tx| {let at=now();let mut events=Vec::new();for mut handoff in delivered {handoff["delivery"]["nativeThreadId"]=json!(native_thread);handoff["updatedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_context_handoffs SET updated_at=?2,payload_json=?3,to_provider_thread_id=json_extract(?3,'$.toProviderThreadId') WHERE context_handoff_id=?1",params![handoff["id"].as_str(),at,handoff.to_string()])?;events.push(crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.to_owned(),event_type:"context-handoff.updated".into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:handoff,metadata:json!({})});}Ok(((),crate::event_store::append(tx,&events)?))}).map_err(|e|e.to_string())
}
#[allow(clippy::too_many_arguments)]
fn settle_turn(
    bus: &EventBus,
    turn: &RootTurn,
    status: TurnStatus,
    reason: &str,
    result: Option<&Value>,
    models: &[String],
    has_subagents: bool,
    ordinal: u64,
) -> Result<(), String> {
    let at = now();
    let failure = (status == TurnStatus::Failed).then(|| ProviderFailure {
        class: FailureClass::ProviderError,
        message: reason.to_owned(),
        code: None,
        retryable: None,
        managed_usage_limit: false,
    });
    ingest::ingest(
        bus,
        &[
            NormalizedEvent::ProviderTurnUpdated {
                turn: turn.clone(),
                status,
                completed_at: Some(at.clone()),
            },
            NormalizedEvent::TokenUsageUpdated {
                turn: turn.clone(),
                usage: turn_usage(
                    result,
                    status == TurnStatus::Completed,
                    models,
                    has_subagents,
                ),
                at,
            },
            NormalizedEvent::TurnTerminal {
                turn: turn.clone(),
                status,
                failure,
                failure_item_ordinal: (status == TurnStatus::Failed).then_some(ordinal),
                thread_disposition: ThreadDisposition::Reusable,
            },
        ],
    )
    .map_err(|e| e.to_string())
}
pub(crate) async fn start(
    bus: EventBus,
    effect: &Effect,
    settings_path: &Path,
    attachments_dir: &Path,
    mcp: Option<(&str, &crate::provider::session_registry::SessionRegistry)>,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay a provider turn start after an uncertain failure".into());
    }
    let run_id = str_field(&effect.request, "runId")?.to_owned();
    let thread_id = effect.thread_id.clone();
    let data=bus.commit(|tx| {
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'",params![run_id,thread_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok((None,vec![]))};
        let run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let read=|sql:&str,id:&str| -> rusqlite::Result<Value> {let raw:String=tx.query_row(sql,[id],|r|r.get(0))?;serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)};
        let pt=read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let message=read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",run["userMessageId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
        let thread=read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&thread_id)?;
        let cwd:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'",[&run_id],|r|r.get(0)).optional()?.flatten();
        let cwd = match cwd { Some(cwd) => Some(cwd), None => tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[&thread_id],|r|r.get(0)).optional()? };
        let ordinal:u64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0))?;
        let missed_images = missed_start_images(tx, &thread_id, &run)?;
        Ok((Some((run,pt,message,thread,cwd,ordinal,missed_images)),vec![]))
    }).map_err(|e|e.to_string())?;
    let Some((run, pt, message, thread, cwd, ordinal, missed_images)) = data else {
        return Ok(());
    };
    if pt["driver"] != "claudeAgent" {
        return Err("Unsupported provider driver".into());
    }
    // Hold the same start reservation as Codex so a restore cannot overlap the
    // native launch or the durable transition to a running turn.
    let workspace = thread["worktreePath"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(cwd.as_deref())
        .map(str::to_owned);
    let worktree = thread["worktreePath"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
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
            .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let still_starting=bus.commit(|tx| {let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')",params![run_id,thread_id],|r|r.get(0))?;Ok((active,vec![]))}).map_err(|e|e.to_string())?;
    if !still_starting {
        return Ok(());
    }
    let _start_guard = StartGuard::acquire(&thread_id)?;
    let handoffs = bus
        .commit(|tx| {
            Ok((
                crate::provider::executor::pending_handoffs(
                    tx,
                    run["providerThreadId"].as_str(),
                    &run_id,
                )?,
                vec![],
            ))
        })
        .map_err(|e| e.to_string())?;
    let (handoffs, side_chat) = crate::context_handoff::split_side_chat_handoff(handoffs, thread["lineage"]["sideChat"] == true);
    let mut prompt_message = message.clone();
    if !missed_images.is_empty() {
        let mut attachments = prompt_message["attachments"].as_array().cloned().unwrap_or_default();
        for image in missed_images {
            let Some(id) = image["id"].as_str() else { continue };
            let Some(parsed) = crate::attachment_paths::parse_id(id) else { continue };
            if crate::attachment_paths::safe_thread_segment(&thread_id).as_deref() != Some(parsed.thread_segment.as_str()) {
                continue;
            }
            let Some(mime) = image["mimeType"].as_str() else { continue };
            let extension = crate::attachment_paths::image_extension(mime, image["name"].as_str());
            let path = attachments_dir.join(format!("{id}{extension}"));
            if path.symlink_metadata().is_ok_and(|metadata| metadata.is_file())
                && !attachments.iter().any(|attachment| attachment["id"] == id)
            {
                attachments.push(image);
            }
        }
        prompt_message["attachments"] = json!(attachments);
    }
    let mut delivered = Vec::new();
    if (!handoffs.is_empty() || side_chat.is_some())
        && !crate::context_handoff::defers_handoff_context(&message)
    {
        let budget = crate::context_handoff::handoff_budget(
            crate::context_handoff::token_cap(
                std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                    .ok()
                    .as_deref(),
            ),
            message["text"].as_str().unwrap_or(""),
            prompt_message["attachments"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            None,
            0,
            None,
        );
        let coverage = handoffs
            .iter()
            .map(|h| {
                h["history"]["coverage"]
                    .as_str()
                    .unwrap_or("Recover history with t3_thread_read.")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut messages = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for h in &handoffs {
            for m in h["history"]["messages"].as_array().into_iter().flatten() {
                if let Some(id) = m["itemId"].as_str() {
                    if seen.insert(id.to_owned()) {
                        messages.push(m.clone());
                    }
                }
            }
        }
        let omitted = handoffs
            .iter()
            .map(|h| h["history"]["omittedItems"].as_u64().unwrap_or(0) as usize)
            .sum();
        let ids = handoffs
            .iter()
            .flat_map(|h| {
                h["history"]["omittedItemIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        let selected =
            crate::context_handoff::select_history(&messages, &coverage, omitted, &ids, budget);
        if !handoffs.is_empty() && crate::context_handoff::history_cost(&selected.messages, &selected.context) > budget {
            return Err("The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.".into());
        }
        let history = if handoffs.is_empty() { String::new() } else { crate::context_handoff::render_history(&selected.messages, &selected.context) };
        prompt_message["text"] = json!(crate::context_handoff::with_side_chat_context(&history, side_chat.as_ref(), message["text"].as_str().unwrap_or("")));
        if let Some(mut h) = side_chat { h["toProviderThreadId"] = run["providerThreadId"].clone(); h["delivery"] = json!({"nativeThreadId":pt["nativeThreadRef"]["nativeId"].clone(),"status":"inline","itemIds":[]}); delivered.push(h); }
        for mut h in handoffs {
            let item_ids = selected
                .messages
                .iter()
                .filter_map(|m| m["itemId"].as_str())
                .filter(|id| {
                    h["history"]["messages"]
                        .as_array()
                        .is_some_and(|ms| ms.iter().any(|m| m["itemId"] == *id))
                })
                .collect::<Vec<_>>();
            h["delivery"] = json!({"nativeThreadId":pt["nativeThreadRef"]["nativeId"],"status":"inline","itemIds":item_ids});
            delivered.push(h);
        }
    }
    let mut prompt = input_content(&prompt_message, attachments_dir)?;
    let instance = str_field(&pt, "providerInstanceId")?;
    let settings = crate::provider::session_registry::read_provider_settings(Some(settings_path))?;
    let entry = &settings["providerInstances"][instance];
    if entry["enabled"] == false || entry["config"]["enabled"] == false {
        return Err("Claude provider instance is disabled".into());
    }
    let binary = entry["config"]["binaryPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("claude");
    let mut native_thread = pt["nativeThreadRef"]["nativeId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let resume = pt["nativeThreadRef"]["nativeId"]
        .as_str()
        .is_some_and(|id| !id.is_empty());
    let model = str_field(&run["modelSelection"], "model")?;
    let binary = if binary == "~" || binary.starts_with("~/") {
        crate::provider::instance::home_path(binary)?
    } else {
        binary.into()
    };
    let mut command = Command::new(binary);
    if let Some(home) = entry["config"]["homePath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        command.env(
            "CLAUDE_CONFIG_DIR",
            crate::provider::instance::home_path(home)?,
        );
    }
    if let Some(vars) = entry["environment"].as_array() {
        for var in vars {
            let name = var["name"].as_str().ok_or("Invalid provider environment")?;
            if name.is_empty()
                || !name.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                return Err("Invalid provider environment".into());
            }
            let value = if let Some(reference) = var.get("secret").filter(|v| !v.is_null()) {
                crate::mcp_secret::resolve_reference(&settings, reference)
                    .await
                    .ok_or("Claude provider contains an unresolved environment credential")?
            } else {
                var["value"]
                    .as_str()
                    .ok_or("Invalid provider environment")?
                    .to_owned()
            };
            command.env(name, value);
        }
    }
    let mut launch_settings = serde_json::Map::new();
    let mut launch_mode: Option<String> = None;
    let mut append_inline = String::new();
    let mut append_file = String::new();
    let mut has_thinking_display = false;
    let mut has_thinking = false;
    if let Some(args) = entry["config"]["launchArgs"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        let args = shlex::split(args).ok_or("Invalid Claude launch arguments")?;
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            let (flag, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(a, b)| (a, Some(b)));
            if [
                "--output-format",
                "--input-format",
                "--permission-prompt-tool",
                "--session-id",
                "--resume",
                "--model",
            ]
            .contains(&flag)
            {
                return Err("Claude launch arguments conflict with server-managed options".into());
            }
            if [
                "--settings",
                "--permission-mode",
                "--append-system-prompt",
                "--append-system-prompt-file",
            ]
            .contains(&flag)
            {
                let value = if let Some(value) = inline {
                    value.to_owned()
                } else {
                    index += 1;
                    args.get(index)
                        .filter(|s| !s.starts_with("--"))
                        .ok_or("Claude launch argument requires a value")?
                        .clone()
                };
                if value.trim().is_empty() {
                    return Err("Claude launch argument requires a value".into());
                }
                match flag {
                    "--permission-mode" => {
                        if ![
                            "default",
                            "plan",
                            "acceptEdits",
                            "dontAsk",
                            "bypassPermissions",
                            "auto",
                        ]
                        .contains(&value.as_str())
                        {
                            return Err("Invalid Claude permission mode".into());
                        }
                        launch_mode = Some(value);
                    }
                    "--append-system-prompt" => append_inline = value,
                    "--append-system-prompt-file" => {
                        let path = crate::provider::instance::home_path(&value)?;
                        let path = if path.is_absolute() {
                            path
                        } else {
                            std::path::Path::new(cwd.as_deref().unwrap_or(".")).join(path)
                        };
                        append_file = std::fs::read_to_string(path)
                            .map_err(|_| "Could not read Claude append system prompt file")?
                            .trim_end_matches('\n')
                            .trim_end_matches('\r')
                            .to_owned();
                    }
                    "--settings" => {
                        let source = if value.trim_start().starts_with('{') {
                            value
                        } else {
                            let path = crate::provider::instance::home_path(&value)?;
                            let path = if path.is_absolute() {
                                path
                            } else {
                                std::path::Path::new(cwd.as_deref().unwrap_or(".")).join(path)
                            };
                            std::fs::read_to_string(path)
                                .map_err(|_| "Could not read Claude settings file")?
                        };
                        launch_settings = serde_json::from_str::<Value>(&source)
                            .ok()
                            .and_then(|v| v.as_object().cloned())
                            .ok_or("Invalid Claude launch settings")?;
                    }
                    _ => unreachable!(),
                }
            } else if flag == "--dangerously-skip-permissions" {
                if inline != Some("false") {
                    launch_mode = Some("bypassPermissions".into());
                }
            } else {
                if flag == "--thinking-display" {
                    has_thinking_display = true;
                }
                if flag == "--thinking" {
                    has_thinking = true;
                }
                command.arg(arg);
            }
            index += 1;
        }
    }
    let options = run["modelSelection"]["options"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let option = |name: &str| {
        options
            .iter()
            .find(|v| v["id"] == name)
            .map(|v| &v["value"])
    };
    let thinking = option("thinking").and_then(Value::as_bool);
    let mut sdk_settings = launch_settings;
    if let Some(value) = thinking {
        sdk_settings.insert("alwaysThinkingEnabled".into(), json!(value));
    }
    for name in ["fastMode", "ultracode"] {
        if let Some(value) = option(name).and_then(Value::as_bool) {
            sdk_settings.insert(name.into(), json!(value));
        }
    }
    if thinking != Some(false) && !has_thinking_display {
        if !has_thinking {
            command.arg("--thinking=adaptive");
        }
        command.arg("--thinking-display=summarized");
        sdk_settings.insert("showThinkingSummaries".into(), json!(true));
    }
    if let Some(effort) = option("effort")
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "low" | "medium" | "high" | "max"))
    {
        command.arg("--effort").arg(effort);
    }
    if !sdk_settings.is_empty() {
        command
            .arg("--settings")
            .arg(Value::Object(sdk_settings).to_string());
    }
    command.args([
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool=stdio",
        "--model",
        model,
    ]);
    if mcp.is_some() {
        command.arg("--allowedTools=mcp__t3-code__*");
    }
    if attachments_dir.is_dir() {
        command.arg("--add-dir").arg(attachments_dir);
    }
    command.current_dir(
        cwd.as_deref()
            .filter(|cwd| !cwd.is_empty())
            .ok_or("Claude workspace is unavailable")?,
    );
    let mode = if let Some(mode) = launch_mode.as_deref() {
        mode
    } else if thread["interactionMode"] == "plan" {
        "plan"
    } else {
        match thread["runtimeMode"].as_str() {
            Some("full-access") => "bypassPermissions",
            Some("auto-accept-edits") => "acceptEdits",
            Some("auto") => "auto",
            _ => "default",
        }
    };
    command.args(["--permission-mode", mode]);
    if mode == "bypassPermissions" {
        command.arg("--allow-dangerously-skip-permissions");
    }
    use sha2::{Digest, Sha256};
    let signature=format!("{:x}",Sha256::digest(json!({"entry":entry,"cwd":cwd,"mode":mode,"options":run["modelSelection"]["options"],"model":model,"mcp":mcp.is_some()}).to_string().as_bytes()));
    let existing = {
        let entries = active()
            .lock()
            .map_err(|_| "Claude session registry unavailable")?;
        entries.get(&thread_id).map(|entry| {
            (
                entry.turn.clone(),
                entry.session.clone(),
                entry.signature.clone(),
                entry
                    .background_count
                    .load(std::sync::atomic::Ordering::SeqCst),
                entry.writer.clone(),
                entry.current_prompt.clone(),
            )
        })
    };
    if let Some((state, session, old_signature, background, writer, current_prompt)) = existing {
        if !state.is_empty() {
            return Err("Claude turn already active".into());
        }
        if session == native_thread && signature == old_signature && !writer.is_closed() {
            let at = now();
            let synthetic = uuid::Uuid::new_v4().to_string();
            let turn = RootTurn {
                driver: "claudeAgent".into(),
                native_thread_id: native_thread.clone(),
                native_turn_id: synthetic.clone(),
                provider_thread_id: str_field(&run, "providerThreadId")?.into(),
                provider_turn_id: format!(
                    "provider-turn:provider:claudeAgent:synthetic:{synthetic}"
                ),
                thread_id: thread_id.clone(),
                run_id: Some(run_id.clone()),
                run_attempt_id: str_field(&run, "activeAttemptId")?.into(),
                root_node_id: str_field(&run, "rootNodeId")?.into(),
                provider_turn_ordinal: ordinal,
                run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
                started_at: at,
            };
            lifecycle::start(
                &bus,
                &turn,
                pt,
                &run,
                cwd.as_deref(),
                capabilities(mcp.is_some()),
            )?;
            {
                let mut entries = active()
                    .lock()
                    .map_err(|_| "Claude session registry unavailable")?;
                let entry = entries
                    .get_mut(&thread_id)
                    .filter(|entry| entry.turn.is_empty())
                    .ok_or("Claude session changed while starting")?;
                entry.turn = turn.provider_turn_id.clone();
            }
            let prompt_id = uuid::Uuid::new_v4().to_string();
            *current_prompt
                .lock()
                .map_err(|_| "Claude prompt registry unavailable")? = prompt_id.clone();
            let (ack, received) = oneshot::channel();
            writer.send(crate::provider::claude_requests::ProcessWrite{value:json!({"type":"user","message":{"role":"user","content":prompt},"parent_tool_use_id":null,"session_id":native_thread,"uuid":prompt_id}),ack:Some(ack),begin:Some(turn)}).map_err(|_|"Claude session is no longer active")?;
            tokio::time::timeout(std::time::Duration::from_secs(30), received)
                .await
                .map_err(|_| "Claude prompt delivery timed out")?
                .map_err(|_| "Claude session is no longer active")??;
            mark_handoffs(&bus, &thread_id, &native_thread, delivered)?;
            return Ok(());
        }
        if background > 0 {
            return Err(
                "Claude cannot replace its live session while background tasks are running".into(),
            );
        }
        detach(&thread_id);
    }
    let system_prompt = if mcp.is_some() {
        format!(
            "{}{}",
            include_str!("claude_system_prompt.txt"),
            include_str!("claude_mcp_prompt.txt")
        )
    } else {
        include_str!("claude_system_prompt.txt").to_owned()
    };
    let system_prompt = [system_prompt, append_file, append_inline]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let init = json!({"type":"control_request","request_id":"initialize","request":{"subtype":"initialize","appendSystemPrompt":system_prompt}});
    let mut resuming = resume;
    let (mut child, mut process_group, mut stdin, mut lines) = loop {
        let template = command.as_std();
        let mut launch = Command::new(template.get_program());
        launch.args(template.get_args());
        for (key, value) in template.get_envs() {
            if let Some(value) = value {
                launch.env(key, value);
            } else {
                launch.env_remove(key);
            }
        }
        if let Some(cwd) = template.get_current_dir() {
            launch.current_dir(cwd);
        }
        launch.args([if resuming { "--resume" } else { "--session-id" }, &native_thread]);
        launch.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            launch.as_std_mut().process_group(0);
        }
        let mut child = launch.spawn().map_err(|e| format!("Could not launch Claude: {e}"))?;
        let process_group = ProcessGroup(child.id());
        let mut stdin = child.stdin.take().ok_or("Claude stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Claude stdout unavailable")?;
        stdin.write_all(format!("{init}\n").as_bytes()).await.map_err(|e| e.to_string())?;
        let mut lines = BufReader::new(stdout).lines();
        let initialized = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let line = lines.next_line().await.map_err(|e| e.to_string())?
                    .ok_or("Claude exited before initialization")?;
                let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if resuming && missing_resume_result(&value, &native_thread) {
                    return Ok::<_, String>(false);
                }
                if value["type"] == "result" {
                    return Err("Claude returned an error before initialization".into());
                }
                if value["type"] == "control_response" && value["response"]["request_id"] == "initialize" {
                    if value["response"]["subtype"] != "success" {
                        return Err("Claude initialization failed".into());
                    }
                    return Ok(true);
                }
            }
        }).await.map_err(|_| "Claude initialization timed out".to_owned())??;
        if initialized {
            break (child, process_group, stdin, lines);
        }
        drop(process_group);
        drop(stdin);
        let _ = child.start_kill();
        let _ = child.wait().await;
        let still_starting = bus.with_autocommit(|db| {
            db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND status='starting')", [&run_id], |row| row.get::<_, bool>(0))
        }).map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
        if !still_starting {
            return Ok(());
        }
        prompt = fresh_resume_prompt(&bus, &thread_id, &run, &prompt_message, attachments_dir)?;
        native_thread = uuid::Uuid::new_v4().to_string();
        resuming = false;
    };
    if let Some((endpoint, sessions)) = mcp {
        let authorization = sessions.prepare_mcp(
            &thread_id,
            instance,
            thread["lineage"]["relationshipToParent"] == "subagent",
        )?;
        let register = json!({"type":"control_request","request_id":"mcp-register","request":{"subtype":"mcp_set_servers","servers":{"t3-code":{"type":"http","url":endpoint,"headers":{"Authorization":authorization},"timeout":3900000}}}});
        stdin
            .write_all(format!("{register}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("Claude exited while registering MCP")?;
                let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if value["type"] == "control_response"
                    && value["response"]["request_id"] == "mcp-register"
                {
                    if value["response"]["subtype"] != "success"
                        || value["response"]["response"]["errors"]
                            .as_object()
                            .is_some_and(|e| !e.is_empty())
                    {
                        return Err("Claude MCP registration failed".to_owned());
                    }
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| "Claude MCP registration timed out".to_owned())??;
    }
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let current_prompt = Arc::new(Mutex::new(prompt_id.clone()));
    let request = json!({"type":"user","message":{"role":"user","content":prompt},"parent_tool_use_id":null,"session_id":native_thread,"uuid":prompt_id});
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    mark_handoffs(&bus, &thread_id, &native_thread, delivered)?;
    let at = now();
    let synthetic = uuid::Uuid::new_v4().to_string();
    let turn = RootTurn {
        driver: "claudeAgent".into(),
        native_thread_id: native_thread,
        native_turn_id: synthetic.clone(),
        provider_thread_id: str_field(&run, "providerThreadId")?.into(),
        provider_turn_id: format!("provider-turn:provider:claudeAgent:synthetic:{synthetic}"),
        thread_id: thread_id.clone(),
        run_id: Some(run_id),
        run_attempt_id: str_field(&run, "activeAttemptId")?.into(),
        root_node_id: str_field(&run, "rootNodeId")?.into(),
        provider_turn_ordinal: ordinal,
        run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
        started_at: at.clone(),
    };
    let capabilities = capabilities(mcp.is_some());
    let session_id = str_field(&pt, "providerSessionId")?.to_owned();
    let instance_id = str_field(&pt, "providerInstanceId")?.to_owned();
    lifecycle::start(&bus, &turn, pt, &run, cwd.as_deref(), capabilities.clone())?;
    let (reply_tx, mut reply_rx) =
        mpsc::unbounded_channel::<crate::provider::claude_requests::ProcessWrite>();
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let background_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let background_roster = Arc::new(Mutex::new(BackgroundRoster::default()));
    let interrupt_requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let interrupt_request_id = Arc::new(Mutex::new(None::<String>));
    let control_waiters: ControlWaiters = Arc::new(Mutex::new(HashMap::new()));
    let generation = uuid::Uuid::new_v4().to_string();
    {
        let mut map = active().lock().map_err(|e| e.to_string())?;
        if map.contains_key(&thread_id) {
            return Err("Claude turn already active".into());
        }
        map.insert(
            thread_id.clone(),
            Active {
                provider_thread_id: turn.provider_thread_id.clone(),
                interrupt_requested: interrupt_requested.clone(),
                interrupt_request_id: interrupt_request_id.clone(),
                model: model.to_owned(),
                options: run["modelSelection"]["options"].clone(),
                signature,
                generation: generation.clone(),
                background_count: background_count.clone(),
                background_roster: background_roster.clone(),
                current_prompt: current_prompt.clone(),
                control_waiters: control_waiters.clone(),
                turn: turn.provider_turn_id.clone(),
                session: turn.native_thread_id.clone(),
                cancel: cancel_tx,
                writer: reply_tx.clone(),
            },
        );
    }
    tokio::spawn(async move {
        let mut turn = turn;
        let mut prompt_id = prompt_id;
        let mut in_turn = true;
        let mut tools = HashMap::<String, ClaudeTool>::new();
        let mut subagents = std::collections::HashMap::<String, RootTurn>::new();
        let mut subagents_by_tool = HashMap::<String, String>::new();
        let mut child_messages = HashMap::<String, String>::new();
        let mut child_streamed = HashMap::<String, (u64, String)>::new();
        let mut has_subagents = false;
        let mut background = std::collections::HashSet::<String>::new();
        let mut streamed = HashMap::<String, (u64, String)>::new();
        let mut current_message = String::new();
        let mut next_ordinal = turn.run_ordinal.saturating_mul(1_000_000).saturating_add(2);
        let mut terminal = TurnStatus::Failed;
        let mut reason = "Claude event stream ended unexpectedly.".to_owned();
        let mut seen_result = false;
        let mut result_event: Option<Value> = None;
        let mut models = Vec::<String>::new();
        let mut deferred_wake = std::collections::VecDeque::<String>::new();
        let mut pending_mid_turn_wake: Option<(String, Option<String>)> = None;
        let mut wake_ready = false;
        let mut replaying_wake = false;
        'stream: loop {
            tokio::select! {
                _=&mut cancel_rx => {terminal=TurnStatus::Interrupted;break 'stream;}
                _=tokio::time::sleep(std::time::Duration::from_secs(10)), if interrupt_requested.load(std::sync::atomic::Ordering::SeqCst) => {terminal=TurnStatus::Interrupted;reason="Stopped by user".into();break 'stream;}
            Some(response)=reply_rx.recv() => {if let Some(next)=response.begin {turn=next;in_turn=true;pending_mid_turn_wake=None;interrupt_requested.store(false,std::sync::atomic::Ordering::SeqCst);prompt_id=response.value["uuid"].as_str().unwrap_or("").to_owned();current_message.clear();streamed.clear();models.clear();next_ordinal=turn.run_ordinal.saturating_mul(1_000_000).saturating_add(2);terminal=TurnStatus::Failed;reason="Claude event stream ended unexpectedly.".into();result_event=None;has_subagents=false;seen_result=false;} let outcome=stdin.write_all(format!("{}\n",response.value).as_bytes()).await.map_err(|e|e.to_string());let failed=outcome.is_err();if let Some(ack)=response.ack {let _=ack.send(outcome);}
                if failed {break 'stream;}}
                line=async { if wake_ready && (!in_turn || replaying_wake) { if let Some(line)=deferred_wake.pop_front() { replaying_wake=true; return Ok(Some(line)); } wake_ready=false; replaying_wake=false; } lines.next_line().await }=> {let Ok(Some(line))=line else{break};let Ok(event)=serde_json::from_str::<Value>(&line) else{reason="Claude returned an unreadable event.".into();break};
                    if in_turn && event["type"]=="system" && event["subtype"]=="task_notification" && event["task_id"].as_str().is_some_and(|id| background.contains(id)) {
                        let wake_id=event["uuid"].as_str().or_else(||event["task_id"].as_str()).unwrap_or("background-task").to_owned();
                        pending_mid_turn_wake=Some((wake_id,event["summary"].as_str().map(str::to_owned)));
                    }
                    if event["type"]=="control_response" {
                        if event["response"]["request_id"].as_str().is_some_and(|id|interrupt_request_id.lock().ok().and_then(|request|request.clone()).as_deref()==Some(id)) {terminal=TurnStatus::Interrupted;reason="Stopped by user".into();break 'stream;}
                        if let Some(id)=event["response"]["request_id"].as_str() {if let Ok(mut waiters)=control_waiters.lock() {if let Some(waiter)=waiters.remove(id) {let result=if event["response"]["subtype"]=="success" {Ok(())}else{Err("Claude rejected the control request".to_owned())};let _=waiter.send(result);}}}
                        continue;
                    }
                    if event["type"]=="control_cancel_request" {if let Some(id)=event["request_id"].as_str(){if let Err(e)=crate::provider::claude_requests::cancel_native(&bus,&turn,id){reason=e;break 'stream;}}continue;}
                    if event["type"]=="control_request" {
                        if event["request"]["subtype"]=="can_use_tool" {
                            if event["request"]["tool_name"]=="ExitPlanMode" {
                                let req=&event["request"];let id=req["tool_use_id"].as_str().or_else(||event["request_id"].as_str()).unwrap_or("plan");
                                if let Some(plan)=req["input"]["plan"].as_str().map(str::trim).filter(|s|!s.is_empty()) {if let Err(e)=crate::provider::plan_projection::proposed(&bus,&turn,id,plan,next_ordinal,&now()){reason=e;break 'stream;}next_ordinal+=1;}
                                let response=json!({"type":"control_response","response":{"subtype":"success","request_id":event["request_id"],"response":{"behavior":"deny","message":"The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.","toolUseID":id}}});
                                if stdin.write_all(format!("{response}\n").as_bytes()).await.is_err(){break 'stream;}continue;
                            }
                            let req=&event["request"]; let id=req["tool_use_id"].as_str().or_else(||event["request_id"].as_str()).unwrap_or("");
                            if !id.is_empty() && !tools.contains_key(id) {match start_tool(&bus,&turn,id,req["tool_name"].as_str().unwrap_or("tool"),&req["input"],next_ordinal){Ok(tool)=>{tools.insert(id.to_owned(),tool);next_ordinal+=1;},Err(e)=>{reason=e;break 'stream;}}}
                            if let Err(e)=crate::provider::claude_requests::register(&bus,&turn,&session_id,&event,next_ordinal,reply_tx.clone()) {reason=e;break 'stream;}
                            next_ordinal+=1;
                        } else if event["request"]["subtype"]=="elicitation" {
                            match crate::provider::claude_requests::register_elicitation(&bus,&turn,&session_id,&event,next_ordinal,reply_tx.clone()) {
                                Ok(true)=>next_ordinal+=1,
                                Ok(false)=>{let response=json!({"type":"control_response","response":{"subtype":"success","request_id":event["request_id"],"response":{"action":"decline"}}});if stdin.write_all(format!("{response}\n").as_bytes()).await.is_err(){break 'stream;}},
                                Err(e)=>{reason=e;break 'stream;}
                            }
                        } else { reason="Claude requested an unsupported control operation.".into();break 'stream; }
                        continue;
                    }
                    if event["type"]=="system" && event["subtype"]=="background_tasks_changed" {
                        if let Some(tasks) = event["tasks"].as_array() {
                            if let Ok(mut roster) = background_roster.lock() {
                                roster.tasks.clear();
                                background.clear();
                                for task in tasks {
                                    if let Some(id) = task["taskId"].as_str().or_else(|| task["task_id"].as_str()) {
                                        let mut item = task.clone();
                                        item["taskId"] = json!(id);
                                        roster.tasks.insert(id.to_owned(), item);
                                        background.insert(id.to_owned());
                                    }
                                }
                                let active_ids: std::collections::HashSet<String> = roster.tasks.keys().cloned().collect();
                                roster.awaited.retain(|id| active_ids.contains(id));
                                background_count.store(background.len(), std::sync::atomic::Ordering::SeqCst);
                                let _ = sync_pending_background_tasks(&bus, &turn.provider_thread_id, &roster, &now());
                            }
                        }
                    }
                    if event["type"]=="system" && (event["subtype"]=="task_started" && event["is_backgrounded"]==true || event["subtype"]=="task_updated" && event["task"]["is_backgrounded"]==true) {
                        if let Some(id)=event["task_id"].as_str(){
                            background.insert(id.to_owned());
                            background_count.store(background.len(),std::sync::atomic::Ordering::SeqCst);
                            if let Ok(mut roster) = background_roster.lock() {
                                let src = if event["task"].is_object() { &event["task"] } else { &event };
                                let kind = src["task_type"].as_str().or_else(|| src["kind"].as_str()).unwrap_or("shell");
                                let mut item = json!({
                                    "taskId": id,
                                    "kind": kind,
                                    "description": src["description"].as_str().unwrap_or("")
                                });
                                if let Some(parent) = src["parent_task_id"].as_str() {
                                    item["parentTaskId"] = json!(parent);
                                }
                                roster.tasks.insert(id.to_owned(), item);
                                let _ = sync_pending_background_tasks(&bus, &turn.provider_thread_id, &roster, &now());
                            }
                        }
                    }
                    if event["type"]=="system" && event["subtype"]=="task_notification" {
                        if let Some(id)=event["task_id"].as_str(){
                            background.remove(id);
                            background_count.store(background.len(),std::sync::atomic::Ordering::SeqCst);
                            if let Ok(mut roster) = background_roster.lock() {
                                roster.tasks.remove(id);
                                roster.awaited.remove(id);
                                let _ = sync_pending_background_tasks(&bus, &turn.provider_thread_id, &roster, &now());
                            }
                        }
                    }
                    if event["type"]=="system" && event["subtype"]=="task_started" && (event["task_type"]=="local_agent" || event["subagent_type"].is_string()) {
                        if let (Some(id),Some(tool))=(event["task_id"].as_str(),event["tool_use_id"].as_str()){subagents_by_tool.insert(tool.to_owned(),id.to_owned());}
                        if let Some(id)=event["task_id"].as_str() {if !subagents.contains_key(id) {let source=turn.clone();if let Err(e)=crate::provider::claude_subagents::start(&bus,&source,&instance_id,id,event["description"].as_str().unwrap_or("Subagent"),event["prompt"].as_str().unwrap_or(""),next_ordinal,&now()){reason=e;break 'stream;}subagents.insert(id.into(),source);has_subagents=true;next_ordinal+=1;}}
                    }
                    if event["type"]=="system" && event["subtype"]=="task_notification" {
                        if let Some(id)=event["task_id"].as_str(){if let Some(source_turn)=subagents.remove(id){if let Err(e)=crate::provider::claude_subagents::finish(&bus,&source_turn,id,event["status"].as_str().unwrap_or("failed"),event["summary"].as_str(),&now()){reason=e;break 'stream;}}}
                    }
                    if !in_turn && event["type"]=="system" && event["subtype"]=="task_notification" {
                        pending_mid_turn_wake=None;
                        let wake_id=event["uuid"].as_str().or_else(||event["task_id"].as_str()).unwrap_or("background-task");
                        match crate::provider::wake::create(&bus,&turn,wake_id,event["summary"].as_str(),None,&now()) {
                            Ok(Some((next,run,provider,cwd)))=>{
                                if let Err(e)=crate::provider::lifecycle::start(&bus,&next,provider,&run,cwd.as_deref(),capabilities.clone()){reason=e;break 'stream;}
                                turn=next;in_turn=true;prompt_id.clear();current_message.clear();streamed.clear();models.clear();next_ordinal=turn.run_ordinal.saturating_mul(1_000_000).saturating_add(2);terminal=TurnStatus::Failed;reason="Claude background stream ended unexpectedly.".into();result_event=None;has_subagents=false;seen_result=false;
                                if let Ok(mut entries)=active().lock(){if let Some(entry)=entries.get_mut(&thread_id){entry.turn=turn.provider_turn_id.clone();}}
                            },
                            Ok(None)=>{
                                let busy=bus.with_autocommit(|db|db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))",[&turn.thread_id],|r|r.get::<_,bool>(0))).ok().and_then(Result::ok).unwrap_or(false);
                                if busy {deferred_wake.push_front(line);wake_ready=true;replaying_wake=true;tokio::time::sleep(std::time::Duration::from_millis(50)).await;}
                            }, Err(e)=>{reason=e;break 'stream;}
                        }
                    } else if !in_turn && matches!(event["type"].as_str(), Some("stream_event" | "assistant") | Some("result") if event["type"]!="result" || event["origin"]["kind"]=="task-notification") {
                        if let Some((wake_id,summary))=pending_mid_turn_wake.take() {
                            match crate::provider::wake::create(&bus,&turn,&wake_id,summary.as_deref(),None,&now()) {
                                Ok(Some((next,run,provider,cwd)))=>{
                                    if let Err(e)=crate::provider::lifecycle::start(&bus,&next,provider,&run,cwd.as_deref(),capabilities.clone()){reason=e;break 'stream;}
                                    turn=next;in_turn=true;prompt_id.clear();current_message.clear();streamed.clear();models.clear();next_ordinal=turn.run_ordinal.saturating_mul(1_000_000).saturating_add(2);terminal=TurnStatus::Failed;reason="Claude background stream ended unexpectedly.".into();result_event=None;has_subagents=false;seen_result=false;
                                    if let Ok(mut entries)=active().lock(){if let Some(entry)=entries.get_mut(&thread_id){entry.turn=turn.provider_turn_id.clone();}}
                                },
                                Ok(None)=>{
                                    let busy=bus.with_autocommit(|db|db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))",[&turn.thread_id],|r|r.get::<_,bool>(0))).ok().and_then(Result::ok).unwrap_or(false);
                                    if busy {pending_mid_turn_wake=Some((wake_id,summary));deferred_wake.push_front(line);wake_ready=true;replaying_wake=true;tokio::time::sleep(std::time::Duration::from_millis(50)).await;continue;}
                                }, Err(e)=>{reason=e;break 'stream;}
                            }
                        }
                    }
                    if !in_turn {continue;}
                    if let Some(parent)=event["parent_tool_use_id"].as_str() {
                        if let Some((id,source))=subagents_by_tool.get(parent).and_then(|id|subagents.get(id).map(|source|(id,source))) {
                            let child=crate::provider::claude_subagents::child_turn(source,id);
                            if event["type"]=="stream_event" {
                                let native=&event["event"];
                                if native["type"]=="message_start" {child_messages.insert(parent.to_owned(),native["message"]["id"].as_str().unwrap_or("assistant").to_owned());}
                                if native["type"]=="content_block_delta" && native["delta"]["type"]=="text_delta" {
                                    let message=child_messages.get(parent).cloned().unwrap_or_else(||"assistant".into());
                                    let state=child_streamed.entry(message.clone()).or_insert_with(||{let ordinal=next_ordinal;next_ordinal+=1;(ordinal,String::new())});
                                    state.1.push_str(native["delta"]["text"].as_str().unwrap_or(""));
                                    let artifact=AssistantArtifact{turn:child.clone(),native_item_id:message,phase:None,text:state.1.clone(),ordinal:state.0,started_at:source.started_at.clone(),updated_at:now(),completed:false};
                                    if ingest::ingest(&bus,&[NormalizedEvent::NodeUpdated(artifact.clone()),NormalizedEvent::MessageUpdated(artifact.clone()),NormalizedEvent::TurnItemUpdated(artifact)]).is_err(){reason="Could not persist Claude subagent stream.".into();break 'stream;}
                                }
                            }
                            if event["type"]=="assistant" {
                                for block in event["message"]["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="tool_use") {
                                    if let Some(tool_id)=block["id"].as_str(){if !tools.contains_key(tool_id){match start_tool(&bus,&child,tool_id,block["name"].as_str().unwrap_or("tool"),&block["input"],next_ordinal){Ok(tool)=>{tools.insert(tool_id.into(),tool);next_ordinal+=1;},Err(e)=>{reason=e;break 'stream;}}}}
                                }
                            }
                            if event["type"]=="user" {
                                for block in event["message"]["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="tool_result") {if let Some(tool_id)=block["tool_use_id"].as_str(){if let Some(tool)=tools.remove(tool_id){if let Err(e)=finish_tool(&bus,tool,block){reason=e;break 'stream;}}}}
                            }
                            if event["type"]=="assistant" {
                                let text=event["message"]["content"].as_array().into_iter().flatten().filter(|c|c["type"]=="text").filter_map(|c|c["text"].as_str()).collect::<String>();
                                if !text.is_empty() {
                                    let artifact=AssistantArtifact{turn:child,native_item_id:event["message"]["id"].as_str().unwrap_or("assistant").into(),phase:None,text,ordinal:child_streamed.get(event["message"]["id"].as_str().unwrap_or("assistant")).map(|state|state.0).unwrap_or(next_ordinal),started_at:source.started_at.clone(),updated_at:now(),completed:true};
                                    if ingest::ingest(&bus,&[NormalizedEvent::NodeUpdated(artifact.clone()),NormalizedEvent::MessageUpdated(artifact.clone()),NormalizedEvent::TurnItemUpdated(artifact)]).is_err(){reason="Could not persist Claude subagent message.".into();break 'stream;}
                                    next_ordinal+=1;
                                }
                            }
                        }
                        continue;
                    }
                    if event["type"]=="stream_event" {
                        let native=&event["event"];
                        if native["type"]=="message_start" {current_message=native["message"]["id"].as_str().unwrap_or("assistant").to_owned();}
                        if native["type"]=="content_block_delta" && native["delta"]["type"]=="thinking_delta" {
                            let delta=native["delta"]["thinking"].as_str().unwrap_or("");
                            if !delta.is_empty() {
                                let id=format!("{}:thinking:{}",current_message,native["index"].as_u64().unwrap_or(0));
                                let state=streamed.entry(id.clone()).or_insert_with(||{let ordinal=next_ordinal;next_ordinal+=1;(ordinal,String::new())});state.1.push_str(delta);
                                let artifact=AssistantArtifact{turn:turn.clone(),native_item_id:id.clone(),phase:None,text:state.1.clone(),ordinal:state.0,started_at:turn.started_at.clone(),updated_at:now(),completed:false};
                                let reasoning=ReasoningArtifact{artifact,native_reasoning_item_id:current_message.clone(),stream:"summary".into(),index:native["index"].as_u64().unwrap_or(0) as usize,interrupted:false};
                                if ingest::ingest(&bus,&[NormalizedEvent::ReasoningNodeUpdated(reasoning.clone()),NormalizedEvent::ReasoningTurnItemUpdated(reasoning)]).is_err(){reason="Could not persist Claude reasoning stream.".into();break 'stream;}
                            }
                        }
                        if native["type"]=="content_block_delta" && native["delta"]["type"]=="text_delta" {
                            let delta=native["delta"]["text"].as_str().unwrap_or("");
                            if !delta.is_empty() {
                                let state=streamed.entry(current_message.clone()).or_insert_with(||{let ordinal=next_ordinal;next_ordinal+=1;(ordinal,String::new())});state.1.push_str(delta);
                                let artifact=AssistantArtifact{turn:turn.clone(),native_item_id:current_message.clone(),phase:None,text:state.1.clone(),ordinal:state.0,started_at:turn.started_at.clone(),updated_at:now(),completed:false};
                                if ingest::ingest(&bus,&[NormalizedEvent::NodeUpdated(artifact.clone()),NormalizedEvent::MessageUpdated(artifact.clone()),NormalizedEvent::TurnItemUpdated(artifact)]).is_err(){reason="Could not persist Claude text stream.".into();break 'stream;}
                            }
                        }
                    }
                    if event["type"]=="assistant" {if let Some(model)=event["message"]["model"].as_str().filter(|s|!s.is_empty()){if !models.iter().any(|m|m==model){models.push(model.to_owned());}}}
                    if event["type"]=="assistant" {
                        let id=event["message"]["id"].as_str().unwrap_or("assistant");
                        let text=event["message"]["content"].as_array().into_iter().flatten().filter(|c|c["type"]=="text").filter_map(|c|c["text"].as_str()).collect::<String>();
                        if !text.is_empty(){
                            let state=streamed.entry(id.to_owned()).or_insert_with(||{let value=next_ordinal;next_ordinal+=1;(value,String::new())});
                            if text.starts_with(&state.1) {state.1=text;} else if !state.1.ends_with(&text) {state.1.push_str(&text);}
                            let artifact=AssistantArtifact{turn:turn.clone(),native_item_id:id.into(),phase:None,text:state.1.clone(),ordinal:state.0,started_at:turn.started_at.clone(),updated_at:now(),completed:true};
                            if ingest::ingest(&bus,&[NormalizedEvent::NodeUpdated(artifact.clone()),NormalizedEvent::MessageUpdated(artifact.clone()),NormalizedEvent::TurnItemUpdated(artifact)]).is_err(){reason="Could not persist Claude assistant message.".into();break 'stream;}
                        }
                    }
                    if event["type"]=="assistant" {
                        let message_id=event["message"]["id"].as_str().unwrap_or("assistant");
                        for (index,block) in event["message"]["content"].as_array().into_iter().flatten().enumerate().filter(|(_,b)|b["type"]=="thinking") {
                            let id=format!("{}:thinking:{}",message_id,index);
                            let state=streamed.entry(id.clone()).or_insert_with(||{let ordinal=next_ordinal;next_ordinal+=1;(ordinal,String::new())});
                            if let Some(text)=block["thinking"].as_str(){state.1=text.to_owned();}
                            let artifact=AssistantArtifact{turn:turn.clone(),native_item_id:id,phase:None,text:state.1.clone(),ordinal:state.0,started_at:turn.started_at.clone(),updated_at:now(),completed:true};
                            let reasoning=ReasoningArtifact{artifact,native_reasoning_item_id:message_id.into(),stream:"summary".into(),index,interrupted:false};
                            if ingest::ingest(&bus,&[NormalizedEvent::ReasoningNodeUpdated(reasoning.clone()),NormalizedEvent::ReasoningTurnItemUpdated(reasoning)]).is_err(){reason="Could not persist Claude reasoning.".into();break 'stream;}
                        }
                    }
                    if event["type"]=="assistant" {
                        for block in event["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"]=="tool_use") {
                            let Some(id)=block["id"].as_str() else {continue};
                            if !tools.contains_key(id) {match start_tool(&bus,&turn,id,block["name"].as_str().unwrap_or("tool"),&block["input"],next_ordinal){Ok(tool)=>{tools.insert(id.into(),tool);next_ordinal+=1;},Err(e)=>{reason=e;break 'stream;}}}
                        }
                    }
                    if event["type"]=="user" {
                        for block in event["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"]=="tool_result") {
                            let Some(id)=block["tool_use_id"].as_str() else {continue};
                            if let Some(tool)=tools.remove(id) {if let Err(e)=finish_tool(&bus,tool,block){reason=e;break 'stream;}}
                        }
                    }
                    if event["type"]=="result" {
                        let current=current_prompt.lock().ok().map(|p|p.clone()).unwrap_or_default(); let echoes=event["user_message_uuids"].as_array().map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).or_else(||event["user_message_uuid"].as_str().map(|v|vec![v])); if echoes.as_ref().is_some_and(|ids|!ids.is_empty()&&!ids.iter().any(|id|*id==current)){continue;}
                        if current!=prompt_id && matches!(event["terminal_reason"].as_str(),Some("aborted_streaming"|"aborted_tools")) && echoes.is_none(){continue;}seen_result=true;result_event=Some(event.clone());(terminal,reason)=terminal_result(&event);if interrupt_requested.swap(false,std::sync::atomic::Ordering::SeqCst){terminal=TurnStatus::Interrupted;reason="Stopped by user".into();}
                        if let Err(e)=settle_turn(&bus,&turn,terminal,&reason,result_event.as_ref(),&models,has_subagents,next_ordinal){eprintln!("Claude turn settlement failed: {e}");break 'stream;}
                        crate::provider::claude_requests::forget_turn(&turn.provider_turn_id);
                        if let Ok(mut entries)=active().lock(){if let Some(entry)=entries.get_mut(&thread_id).filter(|entry|entry.turn==turn.provider_turn_id){entry.turn.clear();}}
                        in_turn=false;continue;}
                }
            }
        }
        if !seen_result
            || tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
                .await
                .is_err()
        {
            process_group.terminate();
            let _ = child.kill().await;
        } else {
            process_group.terminate();
        }
        crate::provider::claude_requests::forget_turn(&turn.provider_turn_id);
        if let Ok(mut m) = active().lock() {
            if m.get(&thread_id)
                .is_some_and(|entry| entry.generation == generation)
            {
                m.remove(&thread_id);
            }
        }
        for (_, tool) in tools {
            if let Err(error) = interrupt_tool(&bus, tool) {
                eprintln!("Claude tool cleanup failed: {error}");
            }
        }
        if in_turn {
            if let Err(error) = settle_turn(
                &bus,
                &turn,
                terminal,
                &reason,
                result_event.as_ref(),
                &models,
                has_subagents,
                next_ordinal,
            ) {
                eprintln!("Claude turn settlement failed: {error}");
            }
        }
    });
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn missing_resume_is_specific_to_the_requested_session() {
        let refusal = json!({
            "type":"result","subtype":"error_during_execution",
            "errors":["No conversation found with session ID: saved-session"]
        });
        assert!(missing_resume_result(&refusal, "saved-session"));
        assert!(!missing_resume_result(&refusal, "different-session"));
        assert!(!missing_resume_result(
            &json!({"type":"result","subtype":"error_during_execution",
                "errors":["Session ID saved-session is already in use."]}),
            "saved-session",
        ));
    }

    #[test]
    fn fresh_resume_prompt_keeps_history_and_composed_input() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
             VALUES('prior','t','assistant',0,'then','then',?1),('current','t','user',0,'now','now',?2)",
            [
                json!({"id":"prior","role":"assistant","text":"Previous answer"}).to_string(),
                json!({"id":"current","role":"user","text":"Current request"}).to_string(),
            ],
        ).unwrap();
        let bus = EventBus::new(db, 32);
        let prompt = fresh_resume_prompt(
            &bus, "t", &json!({"ordinal":2,"userMessageId":"current"}),
            &json!({"text":"Side chat context\n\nCurrent request"}), Path::new("."),
        ).unwrap();
        let text = prompt.as_str().unwrap();
        assert!(text.contains("Previous answer"));
        assert!(text.contains("Side chat context"));
        assert_eq!(text.matches("Current request").count(), 1);
    }

    #[test]
    fn refused_start_images_stop_replaying_after_an_accepted_start() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        for (ordinal, status, started_at, instance, attachments) in [
            (1, "failed", Value::Null, "claude", json!([{"type":"image","id":"old"}])),
            (2, "completed", json!("accepted"), "claude", json!([])),
            (3, "failed", Value::Null, "claude", json!([{"type":"image","id":"recovered"},{"type":"file","id":"file"}])),
            (4, "failed", Value::Null, "other", json!([{"type":"image","id":"foreign"}])),
            (5, "interrupted", Value::Null, "claude", json!([{"type":"image","id":"recovered"}])),
            (6, "completed", json!("accepted"), "claude", json!([])),
        ] {
            let message = format!("m{ordinal}");
            tx.execute(
                "INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
                 VALUES(?1,'t','user',0,'now','now',?2)",
                params![message, json!({"attachments":attachments}).to_string()],
            ).unwrap();
            tx.execute(
                "INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json)
                 VALUES(?1,'t',?2,'claudeAgent',?3,?4,'now',?5)",
                params![format!("run{ordinal}"), ordinal, instance, status,
                    json!({"userMessageId":message,"startedAt":started_at}).to_string()],
            ).unwrap();
        }
        let current = json!({"providerInstanceId":"claude","ordinal":6});
        assert_eq!(missed_start_images(&tx, "t", &current).unwrap(), vec![json!({"type":"image","id":"recovered"})]);
        let later = json!({"providerInstanceId":"claude","ordinal":7});
        assert!(missed_start_images(&tx, "t", &later).unwrap().is_empty());
    }

    #[test]
    fn image_input_and_usage_match_claude_shapes() {
        let dir = std::env::temp_dir().join(format!("claude-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", None).unwrap();
        std::fs::write(dir.join(format!("{id}.png")), b"abc").unwrap();
        let message = json!({"text":"look","attachments":[{"type":"image","id":id,"name":"shot.png","mimeType":"image/png","sizeBytes":3}]});
        let input = input_content(&message, &dir).unwrap();
        assert_eq!(
            input[1],
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"YWJj"}})
        );
        let usage = turn_usage(
            Some(
                &json!({"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"output_tokens":4}}),
            ),
            true,
            &["model".into()],
            false,
        );
        assert_eq!(usage["inputTokens"], 15);
        assert_eq!(usage["usageStatus"], "complete");
        assert_eq!(usage["models"], json!(["model"]));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn claude_terminal_reason_overrides_success() {
        assert_eq!(
            terminal_result(
                &json!({"subtype":"success","is_error":false,"terminal_reason":"aborted_tools"})
            )
            .0,
            TurnStatus::Interrupted
        );
        assert_eq!(
            terminal_result(
                &json!({"subtype":"success","is_error":false,"terminal_reason":"prompt_too_long"})
            )
            .0,
            TurnStatus::Failed
        );
        assert_eq!(
            terminal_result(&json!({"subtype":"success","is_error":false,"api_error_status":429}))
                .0,
            TurnStatus::Failed
        );
        assert_eq!(
            terminal_result(&json!({"subtype":"success","is_error":false})).0,
            TurnStatus::Completed
        );
    }
    #[test]
    fn only_one_claude_launch_can_start_per_thread() {
        let thread = format!("claude-start-{}", uuid::Uuid::new_v4());
        let guard = StartGuard::acquire(&thread).unwrap();
        assert!(StartGuard::acquire(&thread).is_err());
        drop(guard);
        assert!(StartGuard::acquire(&thread).is_ok());
    }
    #[tokio::test]
    async fn streams_a_turn_and_delivers_live_approval() {
        verify_streamed_turn("claude-live-approval", false).await;
    }

    #[tokio::test]
    async fn retries_a_missing_native_session_before_sending_input() {
        verify_streamed_turn("claude-missing-session", true).await;
    }

    #[tokio::test]
    async fn mid_turn_background_task_notification_keeps_streaming_and_subsequent_turn() {
        let thread_id = format!("claude-midturn-bg-{}", uuid::Uuid::new_v4());
        let dir = std::env::temp_dir().join(format!("claude-midturn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("claude");
        std::fs::write(&binary, r##"#!/usr/bin/env python3
import json, sys
init = json.loads(sys.stdin.readline())
print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':init['request_id'],'response':{}}}), flush=True)

# Turn 1: background task starts, foreground poll tool runs, background task finishes mid-turn,
# then foreground poll tool completes and assistant replies.
turn1 = json.loads(sys.stdin.readline())
assert turn1['message']['content'] == 'fix sign-in'
print(json.dumps({'type':'system','subtype':'task_started','task_id':'bg-1','is_backgrounded':True,'task_type':'shell','description':'cargo test'}), flush=True)
print(json.dumps({'type':'assistant','message':{'id':'msg-poll','content':[{'type':'tool_use','id':'tool-poll','name':'Bash','input':{'command':'until grep -q ok out; do sleep 1; done'}}]}}), flush=True)
print(json.dumps({'type':'system','subtype':'task_notification','task_id':'bg-1','status':'completed','summary':'cargo test finished'}), flush=True)
print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'tool-poll','content':'test result: ok. 4 passed'}]}}), flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'message_start','message':{'id':'msg-1'}}}), flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'First turn fixed.'}}}), flush=True)
print(json.dumps({'type':'assistant','message':{'id':'msg-1','content':[{'type':'text','text':'First turn fixed.'}]}}), flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False,'user_message_uuid':turn1['uuid']}), flush=True)

# Turn 2 on the same live process must also stream normally.
turn2 = json.loads(sys.stdin.readline())
assert turn2['message']['content'] == 'what is happening'
print(json.dumps({'type':'stream_event','event':{'type':'message_start','message':{'id':'msg-2'}}}), flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Second turn reply.'}}}), flush=True)
print(json.dumps({'type':'assistant','message':{'id':'msg-2','content':[{'type':'text','text':'Second turn reply.'}]}}), flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False,'user_message_uuid':turn2['uuid']}), flush=True)
"##).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"claudeAgent":{"driver":"claudeAgent","config":{"binaryPath":binary}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"claudeAgent","model":"claude-test","options":[]});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: &thread_id,
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
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send-1",
                thread_id: &thread_id,
                message_id: "m1",
                text: "fix sign-in",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "claudeAgent",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect1 = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        &format!("effect:send-1:provider-turn.start:run:thread:{thread_id}:ordinal:1"),
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        start(bus.clone(), &effect1, &settings, &dir, None)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let done = bus
                    .commit(|tx| {
                        Ok((
                            tx.query_row(
                                "SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND status='completed'",
                                [&thread_id],
                                |r| r.get::<_, i64>(0),
                            )? >= 1,
                            vec![],
                        ))
                    })
                    .unwrap();
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        bus.commit(|tx| {
            let (status, output): (String, String) = tx.query_row(
                "SELECT status, json_extract(payload_json,'$.output') FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='command_execution'",
                [&thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(status, "completed");
            assert_eq!(output, "test result: ok. 4 passed");
            let text: String = tx.query_row(
                "SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant'",
                [&thread_id],
                |r| r.get(0),
            )?;
            assert_eq!(text, "First turn fixed.");
            Ok(((), vec![]))
        })
        .unwrap();

        // Dispatch Turn 2 on the same live Claude process.
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send-2",
                thread_id: &thread_id,
                message_id: "m2",
                text: "what is happening",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "claudeAgent",
            },
            "2026-01-01T00:01:00.000Z",
        )
        .unwrap();
        let effect2 = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        &format!("effect:send-2:provider-turn.start:run:thread:{thread_id}:ordinal:2"),
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        start(bus.clone(), &effect2, &settings, &dir, None)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let done = bus
                    .commit(|tx| {
                        Ok((
                            tx.query_row(
                                "SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND status='completed'",
                                [&thread_id],
                                |r| r.get::<_, i64>(0),
                            )? >= 2,
                            vec![],
                        ))
                    })
                    .unwrap();
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        bus.commit(|tx| {
            let mut stmt = tx.prepare(
                "SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant' ORDER BY rowid ASC",
            )?;
            let texts: Vec<String> = stmt
                .query_map([&thread_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            assert_eq!(texts, vec!["First turn fixed.", "Second turn reply."]);
            Ok(((), vec![]))
        })
        .unwrap();
        detach(&thread_id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn verify_streamed_turn(thread_id: &str, stale_session: bool) {
        let dir = std::env::temp_dir().join(format!("claude-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("claude");
        std::fs::write(&binary,r##"#!/usr/bin/env python3
import json,pathlib,sys
settings=json.loads(sys.argv[sys.argv.index('--settings')+1])
assert settings['fixture'] is True and settings['fastMode'] is True
init=json.loads(sys.stdin.readline())
assert init['request']['subtype']=='initialize' and 'Custom guidance' in init['request']['appendSystemPrompt']
if '--resume' in sys.argv:
    session=sys.argv[sys.argv.index('--resume')+1]
    assert session=='00000000-0000-4000-8000-000000000001'
    pathlib.Path(__file__).with_name('resume-refused').touch()
    print(json.dumps({'type':'result','subtype':'error_during_execution','errors':[f'No conversation found with session ID: {session}']}),flush=True)
    sys.exit(1)
print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':init['request_id'],'response':{}}}),flush=True)
prompt=json.loads(sys.stdin.readline())
assert prompt['session_id']==sys.argv[sys.argv.index('--session-id')+1]
content=prompt['message']['content']
if pathlib.Path(__file__).with_name('resume-refused').exists():
    assert 'Earlier context' in content[0]['text']
    assert '[Current input]\nhello\n\n[Attached image' in content[0]['text']
    assert content[1]['source']['data']=='YWJj'
else:
    assert content=='hello'
print(json.dumps({'type':'assistant','message':{'id':'tool-msg','content':[{'type':'tool_use','id':'tool-1','name':'Bash','input':{'command':'pwd'}}]}}),flush=True)
print(json.dumps({'type':'control_request','request_id':'withdrawn','request':{'subtype':'can_use_tool','tool_name':'Read','tool_use_id':'tool-cancel','input':{'file_path':'/tmp/file'}}}),flush=True)
print(json.dumps({'type':'control_cancel_request','request_id':'withdrawn'}),flush=True)
print(json.dumps({'type':'control_request','request_id':'native-approval','request':{'subtype':'can_use_tool','tool_name':'Bash','tool_use_id':'tool-1','input':{'command':'pwd'}}}),flush=True)
response=json.loads(sys.stdin.readline())
assert response['response']['response']['behavior']=='allow'
print(json.dumps({'type':'control_request','request_id':'question','request':{'subtype':'can_use_tool','tool_name':'AskUserQuestion','tool_use_id':'tool-2','input':{'questions':[{'question':'Choose?','header':'Choice','options':[{'label':'Yes','description':'Yes'}]}]}}}),flush=True)
response=json.loads(sys.stdin.readline())
assert response['response']['response']['updatedInput']['answers']['Choose?']=='Yes'
model_change=json.loads(sys.stdin.readline())
assert model_change['request']['subtype']=='set_model' and model_change['request']['model']=='claude-next'
print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':model_change['request_id'],'response':{}}}),flush=True)
steer=json.loads(sys.stdin.readline())
assert steer['type']=='user' and steer['message']['content']=='steered'
print(json.dumps({'type':'control_request','request_id':'plan-request','request':{'subtype':'can_use_tool','tool_name':'ExitPlanMode','tool_use_id':'plan-1','input':{'plan':'Implement carefully'}}}),flush=True)
response=json.loads(sys.stdin.readline())
assert response['response']['response']['behavior']=='deny'
print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'tool-1','content':'/tmp'}]}}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'message_start','message':{'id':'msg-1'}}}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'wo'}}}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'rld'}}}),flush=True)
print(json.dumps({'type':'assistant','message':{'id':'msg-1','content':[{'type':'text','text':'world'}]}}),flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings,json!({"providerInstances":{"claudeAgent":{"driver":"claudeAgent","config":{"binaryPath":binary,"launchArgs":"--settings '{\"fixture\":true}' --append-system-prompt 'Custom guidance' --permission-mode default"}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"claudeAgent","model":"claude-test","options":[{"id":"fastMode","value":true}]});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id,
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
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id,
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "claudeAgent",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        if stale_session {
            let image = crate::attachment_paths::attachment_id(thread_id, None).unwrap();
            std::fs::write(dir.join(format!("{image}.png")), b"abc").unwrap();
            bus.commit(|tx| {
                tx.execute(
                    "UPDATE orchestration_v2_projection_provider_threads
                     SET payload_json=json_set(payload_json,'$.nativeThreadRef',json(?2))
                     WHERE thread_id=?1",
                    params![thread_id, json!({"driver":"claudeAgent","nativeId":"00000000-0000-4000-8000-000000000001","strength":"strong"}).to_string()],
                )?;
                tx.execute(
                    "INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
                     VALUES('prior',?1,'user',0,'2025-12-31','2025-12-31',?2)",
                    params![thread_id, json!({"id":"prior","role":"user","text":"Earlier context"}).to_string()],
                )?;
                tx.execute(
                    "UPDATE orchestration_v2_projection_messages
                     SET payload_json=json_set(payload_json,'$.attachments',json(?1)) WHERE message_id='m'",
                    [json!([{"type":"image","id":image,"name":"shot.png","mimeType":"image/png","sizeBytes":3}]).to_string()],
                )?;
                Ok(((), vec![]))
            }).unwrap();
        }
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        &format!("effect:send:provider-turn.start:run:thread:{thread_id}:ordinal:1"),
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        start(bus.clone(), &effect, &settings, &dir, None)
            .await
            .unwrap();
        assert_eq!(dir.join("resume-refused").exists(), stale_session);
        let request=tokio::time::timeout(std::time::Duration::from_secs(5),async {loop {let id=bus.commit(|tx|Ok((tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending' AND kind='command'",[],|r|r.get::<_,String>(0)).optional()?,vec![]))).unwrap();if let Some(id)=id {break id}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap();
        crate::provider::claude_requests::deliver(&request, Some("accept"), None).unwrap();
        let question=tokio::time::timeout(std::time::Duration::from_secs(5),async {loop {let id=bus.commit(|tx|Ok((tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending' AND kind='user_input'",[],|r|r.get::<_,String>(0)).optional()?,vec![]))).unwrap();if let Some(id)=id {break id}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap();
        crate::provider::claude_requests::deliver(&question, None, Some(&json!({"Choose?":"Yes"})))
            .unwrap();
        bus.commit(|tx| {tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('steer',?1,'user',0,'now','now',?2)",params![thread_id,json!({"id":"steer","text":"steered","attachments":[]}).to_string()])?;Ok(((),vec![]))}).unwrap();
        let turn_id=bus.commit(|tx|Ok((tx.query_row("SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns WHERE status='running'",[],|r|r.get::<_,String>(0))?,vec![]))).unwrap();
        let mut steering = effect.clone();
        steering.request = json!({"type":"provider-turn.steer","providerTurnId":turn_id,"messageId":"steer","modelSelection":{"model":"claude-next","options":[{"id":"fastMode","value":true}]}});
        steer(&bus, &steering, &dir).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5),async {loop {let done=bus.commit(|tx|Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE status='completed')",[],|r|r.get::<_,bool>(0))?,vec![]))).unwrap();if done {break}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}}).await.unwrap();
        bus.commit(|tx| {let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?;assert_eq!(text,"world");let cancelled:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE json_extract(payload_json,'$.nativeRequestRef.nativeId')='withdrawn' AND status='cancelled')",[],|r|r.get(0))?;assert!(cancelled); let output:String=tx.query_row("SELECT json_extract(payload_json,'$.output') FROM orchestration_v2_projection_turn_items WHERE type='command_execution'",[],|r|r.get(0))?;assert_eq!(output,"/tmp");let plan:String=tx.query_row("SELECT json_extract(payload_json,'$.markdown') FROM orchestration_v2_projection_plans WHERE kind='proposed_plan'",[],|r|r.get(0))?;assert_eq!(plan,"Implement carefully");Ok(((),vec![]))}).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
