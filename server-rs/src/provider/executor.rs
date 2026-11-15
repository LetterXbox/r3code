//! Execution of a Codex root turn from a durable start effect.
#[path = "executor_children.rs"]
mod children;
use super::{
    codex_events::{CodexRootTurnTranslator, NormalizedEvent, RootTurn, Translation},
    codex_requests, codex_thread_runtime_params, codex_turn_start_params, ingest,
    session_registry::SessionRegistry,
    CodexInteractionMode, CodexLaunch, CodexRuntimeMode, CodexTurnParams, ProviderEvent,
};
use crate::{
    effect_worker::{EffectExecutor, Execution},
    event_bus::EventBus,
    event_store::{self, Event},
    outbox::Effect,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}

fn configured_reasoning_summary(response: &Value) -> Option<&str> {
    response
        .pointer("/config/model_reasoning_summary")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "auto" | "concise" | "detailed" | "none"))
}

fn codex_runtime_mode(thread: &Value) -> Result<CodexRuntimeMode, String> {
    match thread.get("runtimeMode").and_then(Value::as_str) {
        Some("full-access") => Ok(CodexRuntimeMode::FullAccess),
        Some("auto") => Ok(CodexRuntimeMode::Auto),
        Some("auto-accept-edits") => Ok(CodexRuntimeMode::AutoAcceptEdits),
        Some("approval-required") => Ok(CodexRuntimeMode::ApprovalRequired),
        _ => Err("Invalid or missing thread runtimeMode".into()),
    }
}

pub(crate) fn codex_input(message: &Value, directory: &Path) -> Result<Vec<Value>, String> {
    let mut text = crate::composer_context::project(
        message["text"].as_str().unwrap_or(""),
        message.get("context"),
    );
    let attachments: Vec<crate::attachment_store::Attachment> = serde_json::from_value(
        message
            .get("attachments")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| e.to_string())?;
    let mut images = Vec::new();
    for attachment in attachments {
        crate::attachment_paths::parse_id(&attachment.id)
            .ok_or_else(|| format!("Invalid attachment id '{}'", attachment.id))?;
        let ext = match attachment.kind.as_str() {
            "image" => crate::attachment_paths::image_extension(
                &attachment.mime_type,
                Some(&attachment.name),
            ),
            "file" => crate::attachment_paths::file_extension(&attachment.name),
            _ => return Err(format!("Invalid attachment id '{}'", attachment.id)),
        };
        let path = directory.join(format!("{}{ext}", attachment.id));
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(path)
        };
        let native = attachment.kind == "image"
            && ["image/gif", "image/jpeg", "image/png", "image/webp"]
                .contains(&attachment.mime_type.to_ascii_lowercase().as_str());
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        let extracted = if let Some(sidecar) = crate::document_text::ensure(&path) {
            format!(" (text extracted to: {})", sidecar.display())
        } else {
            String::new()
        };
        text.push_str(&format!(
            "[Attached {} \"{}\" is saved at: {}{}]",
            attachment.kind,
            attachment.name,
            path.display(),
            extracted
        ));
        if native {
            let bytes = std::fs::read(&path)
                .map_err(|_| format!("Failed to read attachment '{}'.", attachment.id))?;
            images.push(json!({"type":"image", "url":format!("data:{};base64,{}", attachment.mime_type, STANDARD.encode(bytes))}));
        }
    }
    let mut input = Vec::new();
    if !text.is_empty() {
        input.push(json!({"type":"text", "text":text, "text_elements":[]}));
    }
    input.extend(images);
    if input.is_empty() {
        return Err("Turn requires non-empty text or attachments.".into());
    }
    Ok(input)
}

// A slash command can leave a handoff pending even if its run completes. Carry
// it forward until it is actually included in a provider request.
pub(crate) fn pending_handoffs(
    tx: &rusqlite::Transaction<'_>,
    provider: Option<&str>,
    run: &str,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = tx.prepare("SELECT h.payload_json,h.to_provider_thread_id,h.target_run_id,r.status,r.ordinal,current.ordinal,COALESCE(json_extract(t.payload_json,'$.lineage.sideChat'),0),m.payload_json FROM orchestration_v2_projection_context_handoffs h JOIN orchestration_v2_projection_runs r ON r.run_id=h.target_run_id JOIN orchestration_v2_projection_runs current ON current.run_id=?1 AND current.thread_id=r.thread_id LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE h.status='ready' ORDER BY h.rowid")?;
    let rows = stmt.query_map([run], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,bool>(6)?,r.get::<_,Option<String>>(7)?)))?;
    let mut values = Vec::new();
    for row in rows {
        let (raw, target_provider, target_run, status, ordinal, current_ordinal, side_chat, message) = row?;
        let handoff: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let is_side = side_chat && handoff["strategy"] == "manual_context" && handoff["transferId"].is_string();
        let eligible = if is_side {
            let deferred = message.as_deref().map(serde_json::from_str::<Value>).transpose().map_err(|_| rusqlite::Error::InvalidQuery)?.is_some_and(|m| crate::context_handoff::defers_handoff_context(&m));
            handoff.get("delivery").is_none() && (target_run == run || matches!(status.as_str(), "failed" | "interrupted" | "cancelled") || (status == "completed" && deferred))
        } else {
            provider.is_some() && target_provider.as_deref() == provider && (target_run == run || (ordinal < current_ordinal && (handoff["delivery"]["status"].is_null() || handoff["delivery"]["status"] == "pending")))
        };
        if eligible { values.push(handoff); }
    }
    Ok(values)
}

/// Build budgeted portable history and a separate side-chat digest for a
/// provider prompt. The returned records are marked delivered only on native
/// prompt acknowledgement.
pub(crate) fn prepare_inline_handoffs(handoffs: Vec<Value>, message: &Value) -> Result<(String, Vec<Value>), String> {
    let text = message["text"].as_str().unwrap_or("");
    if crate::context_handoff::defers_handoff_context(message) { return Ok((text.to_owned(), vec![])); }
    let (handoffs, side) = crate::context_handoff::split_side_chat_handoff(handoffs, true);
    let budget = crate::context_handoff::handoff_budget(crate::context_handoff::token_cap(std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").ok().as_deref()), text, message["attachments"].as_array().map(Vec::as_slice).unwrap_or(&[]), None, 0, None);
    let coverage = handoffs.iter().map(|h| h["history"]["coverage"].as_str().unwrap_or("Recover history with t3_thread_read.")).collect::<Vec<_>>().join("\n");
    let mut seen = std::collections::HashSet::new();
    let messages = handoffs.iter().flat_map(|h| h["history"]["messages"].as_array().into_iter().flatten()).filter(|m| m["itemId"].as_str().is_some_and(|id| seen.insert(id.to_owned()))).cloned().collect::<Vec<_>>();
    let omitted = handoffs.iter().map(|h| h["history"]["omittedItems"].as_u64().unwrap_or(0) as usize).sum();
    let ids = handoffs.iter().flat_map(|h| h["history"]["omittedItemIds"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned)).collect::<Vec<_>>();
    let selected = crate::context_handoff::select_history(&messages, &coverage, omitted, &ids, budget);
    if !handoffs.is_empty() && crate::context_handoff::history_cost(&selected.messages, &selected.context) > budget { return Err("The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.".into()); }
    let history = if handoffs.is_empty() { String::new() } else { crate::context_handoff::render_history(&selected.messages, &selected.context) };
    let prompt = crate::context_handoff::with_side_chat_context(&history, side.as_ref(), text);
    let mut delivered = Vec::new();
    for mut handoff in handoffs {
        let item_ids = selected.messages.iter().filter_map(|m| m["itemId"].as_str()).filter(|id| handoff["history"]["messages"].as_array().is_some_and(|items| items.iter().any(|m| m["itemId"] == *id))).collect::<Vec<_>>();
        handoff["delivery"] = json!({"itemIds":item_ids});
        delivered.push(handoff);
    }
    if let Some(handoff) = side { delivered.push(handoff); }
    Ok((prompt, delivered))
}

pub(crate) fn record_side_chat_delivery(bus: &EventBus, turn: &RootTurn, mut handoff: Value) -> Result<(), crate::event_bus::BusError> {
    handoff["toProviderThreadId"] = json!(turn.provider_thread_id);
    let item_ids = handoff["delivery"]["itemIds"].as_array().cloned().unwrap_or_default();
    handoff["delivery"] = json!({"nativeThreadId":turn.native_thread_id,"status":"inline","itemIds":item_ids});
    bus.commit(|tx| {
        let at = now(); handoff["updatedAt"] = json!(at);
        tx.execute("UPDATE orchestration_v2_projection_context_handoffs SET to_provider_thread_id=?2,updated_at=?3,payload_json=?4 WHERE context_handoff_id=?1", params![handoff["id"].as_str(),turn.provider_thread_id,at,handoff.to_string()])?;
        let event = crate::event_store::Event { id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"context-handoff.updated".into(),occurred_at:at,command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:handoff,metadata:json!({}) };
        Ok(((),crate::event_store::append(tx,&[event])?))
    })
}

#[allow(clippy::too_many_arguments)]
// A cancelled executor future is dropped by the effect worker. Once a process
// has been opened, retain ownership until the native turn has settled; otherwise
// its notifications could be consumed by a later turn on the same session.
struct TurnGuard {
    bus: EventBus,
    sessions: Arc<SessionRegistry>,
    session_id: String,
    preparation_thread: Option<String>,
    lease: Option<super::session_registry::TurnLease>,
    translator: Option<CodexRootTurnTranslator>,
    turn: Option<RootTurn>,
    settled: bool,
    requests: Vec<String>,
}
impl TurnGuard {
    fn mark_settled(&mut self) {
        self.settled = true;
    }
}
impl Drop for TurnGuard {
    fn drop(&mut self) {
        for id in &self.requests {
            codex_requests::forget(id);
        }
        if self.settled {
            return;
        }
        if self
            .session_id
            .starts_with("provider-session:provider-instance:")
            && self.session_id.ends_with(":shared")
        {
            if self.turn.is_none() {
                if let (Some(thread), Ok(Some(session))) = (
                    &self.preparation_thread,
                    self.sessions.get(&self.session_id),
                ) {
                    session.quarantine_thread(thread);
                }
            }
            if let Some(turn) = &self.turn {
                if let Ok(Some(session)) = self.sessions.get(&self.session_id) {
                    let native_thread = turn.native_thread_id.clone();
                    let native_turn = turn.native_turn_id.clone();
                    session.quarantine_thread(&native_thread);
                    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                        runtime.spawn(async move {
                            let _ = session
                                .interrupt(&native_thread, &native_turn, Duration::from_secs(30))
                                .await;
                        });
                    }
                }
            }
            // If the provider never reports the terminal event, retire only after
            // every sibling turn has released its lease, then reopen on demand.
            let native = self
                .turn
                .as_ref()
                .map(|turn| turn.native_thread_id.clone())
                .or_else(|| self.preparation_thread.clone());
            if let (Some(native), Ok(Some(session)), Ok(runtime)) = (
                native,
                self.sessions.get(&self.session_id),
                tokio::runtime::Handle::try_current(),
            ) {
                let registry = self.sessions.clone();
                let id = self.session_id.clone();
                runtime.spawn(async move {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    loop {
                        if !session.is_quarantined(&native) {
                            break;
                        }
                        if !registry
                            .get(&id)
                            .ok()
                            .flatten()
                            .is_some_and(|current| current.same_process(&session))
                        {
                            break;
                        }
                        if registry.retire_if_idle(&id, &session).unwrap_or(false) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                });
            }
        } else {
            let _ = self.sessions.remove(&self.session_id);
        }
        if let (Some(translator), Some(turn)) = (&mut self.translator, &self.turn) {
            let at = now();
            // The process is no longer trustworthy. Preserve buffered output and
            // settle the projection even when the executing future was cancelled.
            let params = json!({"threadId":turn.native_thread_id,"turn":{"id":turn.native_turn_id,"status":"failed","error":{"message":"Provider execution ended unexpectedly."}}});
            if let Ok(Translation::Events(events)) =
                translator.notification("turn/completed", params, &at, |_| at.clone())
            {
                let _ = ingest::ingest(&self.bus, &events);
            }
        }
    }
}

#[derive(Default)]
struct Supervisors(std::sync::Mutex<Vec<tokio::task::AbortHandle>>);
impl Drop for Supervisors {
    fn drop(&mut self) {
        for task in self.0.get_mut().unwrap().drain(..) {
            task.abort();
        }
    }
}
pub struct CodexTurnExecutor {
    pub bus: EventBus,
    pub sessions: Arc<SessionRegistry>,
    pub launch: Arc<dyn Fn() -> CodexLaunch + Send + Sync>,
    pub attachments_dir: PathBuf,
    pub settings_path: Option<PathBuf>,
    pub mcp_endpoint: Option<String>,
    #[cfg(unix)]
    pub managed: Option<Arc<crate::codex_managed_runtime::RuntimeManager>>,
    supervisors: Supervisors,
}
impl CodexTurnExecutor {
    pub fn new(bus: EventBus, sessions: Arc<SessionRegistry>) -> Self {
        Self {
            bus,
            sessions,
            launch: Arc::new(CodexLaunch::default),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            #[cfg(unix)]
            managed: None,
            supervisors: Supervisors::default(),
        }
    }
    async fn interrupt(&self, effect: &Effect) -> Result<(), String> {
        let session_id = required(&effect.request, "providerSessionId")?;
        let thread_id = required(&effect.request, "providerThreadId")?;
        let turn_id = required(&effect.request, "providerTurnId")?;
        if effect.request.get("subagent").is_some() {
            return Err("Codex does not support interrupting an individual subagent".into());
        }
        let session = self
            .sessions
            .get(session_id)
            .map_err(|e| e.to_string())?
            .ok_or("Provider session is not active")?;
        let (thread, turn) = self.bus.commit(|tx| {
            let thread: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2", params![thread_id, effect.thread_id], |r| r.get(0))?;
            let turn: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1 AND provider_thread_id=?2", params![turn_id, thread_id], |r| r.get(0))?;
            let thread: Value = serde_json::from_str(&thread).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let turn: Value = serde_json::from_str(&turn).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(((thread, turn), vec![]))
        }).map_err(|e| e.to_string())?;
        if thread["providerSessionId"] != session_id || thread["driver"] != "codex" {
            return Err("Provider session does not own this thread".into());
        }
        let native_thread = required(&thread["nativeThreadRef"], "nativeId")?;
        let native_turn = required(&turn["nativeTurnRef"], "nativeId")?;
        session
            .interrupt(native_thread, native_turn, Duration::from_secs(30))
            .await
            .map_err(|e| match e {
                crate::provider::ProviderError::Timeout => {
                    "provider interrupt unresponsive".to_owned()
                }
                other => other.to_string(),
            })?;
        Ok(())
    }
    /// Restart only after the old provider turn is durably terminal. A lost
    /// acknowledgement is deliberately not replayed: starting twice can submit
    /// the user's input twice to the native provider.
    async fn restart(&self, effect: &Effect) -> Result<(), String> {
        if effect.attempt_count > 1 {
            return Err(
                "Cannot safely replay a provider turn restart after an uncertain failure".into(),
            );
        }
        if !effect.request["sessionTransition"].is_null() {
            return Err("Provider session transitions during restart are not supported".into());
        }
        let turn_id = required(&effect.request, "providerTurnId")?;
        let attempt_id = required(&effect.request, "interruptedAttemptId")?;
        let run_id = required(&effect.request, "runId")?;
        let state = || {
            self.bus.commit(|tx| {
            let row: Option<(String,String,String)> = tx.query_row("SELECT t.status,COALESCE(t.run_attempt_id,''),r.status FROM orchestration_v2_projection_provider_turns t JOIN orchestration_v2_projection_runs r ON r.run_id=?1 AND r.thread_id=t.thread_id WHERE t.provider_turn_id=?2 AND t.thread_id=?3",params![run_id,turn_id,effect.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            Ok((row,vec![]))
        }).map_err(|e|e.to_string())
        };
        let (turn_status, attempt, run_status) = state()?.ok_or("Restart target was not found")?;
        if attempt != attempt_id {
            return Err("Restart target attempt does not match".into());
        }
        if run_status != "starting" {
            return Ok(());
        }
        if matches!(turn_status.as_str(), "pending" | "running") {
            self.interrupt(effect).await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
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
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        self.start(effect).await
    }
    async fn steer(&self, effect: &Effect) -> Result<(), String> {
        if effect.attempt_count > 1 {
            return Err(
                "Cannot safely replay a provider turn steer after an uncertain failure".into(),
            );
        }
        let session_id = required(&effect.request, "providerSessionId")?;
        let thread_id = required(&effect.request, "providerThreadId")?;
        let turn_id = required(&effect.request, "providerTurnId")?;
        let message_id = required(&effect.request, "messageId")?;
        let (thread, turn, message) = self.bus.commit(|tx| {
            let thread: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2", params![thread_id,effect.thread_id], |r| r.get(0))?;
            let turn: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1 AND provider_thread_id=?2 ", params![turn_id,thread_id], |r| r.get(0))?;
            let message: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1 AND thread_id=?2", params![message_id,effect.thread_id], |r| r.get(0))?;
            let parse = |s: &str| serde_json::from_str::<Value>(s).map_err(|_| rusqlite::Error::InvalidQuery);
            Ok(((parse(&thread)?,parse(&turn)?,parse(&message)?),vec![]))
        }).map_err(|e| e.to_string())?;
        if thread["providerSessionId"] != session_id || thread["driver"] != "codex" {
            return Err("Provider session does not own this thread".into());
        }
        if turn["status"] == "completed" {
            return self.steer_follow_up(effect, &message, false);
        }
        let session = self
            .sessions
            .get(session_id)
            .map_err(|e| e.to_string())?
            .ok_or("Provider session is not active")?;
        let input = codex_input(&message, &self.attachments_dir)?;
        let result = session
            .steer(
                required(&thread["nativeThreadRef"], "nativeId")?,
                required(&turn["nativeTurnRef"], "nativeId")?,
                input,
                Duration::from_secs(30),
            )
            .await;
        match result {
            Ok(_) => {
                if !message["delegatedCompletion"].is_null() {
                    crate::delegated_settlement::settle(
                        &self.bus,
                        &effect.thread_id,
                        message_id,
                        false,
                        &format!("command:mailbox-accepted:{}", effect.id),
                        &now(),
                    )
                    .map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            Err(e) => {
                let completed = self.bus.commit(|tx| {
                    let completed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1 AND status='completed')", [turn_id], |r|r.get(0))?;
                    Ok((completed,vec![]))
                }).map_err(|e|e.to_string())?;
                if completed {
                    self.steer_follow_up(effect, &message, false)
                } else {
                    Err(e.to_string())
                }
            }
        }
    }
    fn steer_follow_up(
        &self,
        effect: &Effect,
        message: &Value,
        declined: bool,
    ) -> Result<(), String> {
        let source = required(message, "runId")?;
        let cwd = self.bus.commit(|tx| {
            let cwd: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'", [source], |r|r.get(0)).optional()?.flatten();
            Ok((cwd,vec![]))
        }).map_err(|e|e.to_string())?;
        let command = format!("command:steer-follow-up:{}", effect.id);
        let attachments = message["attachments"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let cmd = crate::message_commands::DispatchMessage {
            context: None,
            command_id: &command,
            thread_id: &effect.thread_id,
            message_id: required(message, "id")?,
            text: message["text"].as_str().unwrap_or(""),
            attachments: &attachments,
            creation_source: message["creationSource"].as_str().unwrap_or("client"),
            cwd: cwd.as_deref().unwrap_or(""),
            driver: "codex",
        };
        let result = crate::message_commands::dispatch_steer_follow_up_with_delegated(
            &self.bus,
            cmd,
            source,
            effect.request["steerFollowUpAfterRunOrdinal"].as_i64(),
            declined,
            effect.request.get("modelSelection"),
            message.get("delegatedCompletion").filter(|v| v.is_object()),
            &now(),
        )
        .map_err(|e| e.to_string())?;
        if let Some(error) = result.receipt.error {
            return Err(error);
        }
        Ok(())
    }
    async fn start(&self, effect: &Effect) -> Result<(), String> {
        if effect.attempt_count > 1 {
            return Err(
                "Cannot safely replay a provider turn start after an uncertain failure".into(),
            );
        }
        let run_id = required(&effect.request, "runId")?.to_owned();
        let thread_id = effect.thread_id.clone();
        let data = self.bus.commit(|tx| {
            let run: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'", params![run_id, thread_id], |r| r.get(0)).optional()?;
            let Some(run) = run else { return Ok((None, vec![])); };
            let run: Value = serde_json::from_str(&run).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let read = |sql: &str, id: &str| -> rusqlite::Result<Value> { let s: String = tx.query_row(sql, [id], |r| r.get(0))?; serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery) };
            let pt = read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", required(&run,"providerThreadId").map_err(|_| rusqlite::Error::InvalidQuery)?)?;
            let msg = read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1", required(&run,"userMessageId").map_err(|_| rusqlite::Error::InvalidQuery)?)?;
            let thread = read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", &thread_id)?;
            let cwd: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'", [&run_id], |r| r.get(0)).optional()?.flatten();
            let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1", [required(&run,"providerThreadId").map_err(|_| rusqlite::Error::InvalidQuery)?], |r| r.get(0))?;
            Ok((Some((run,pt,msg,thread,cwd,ordinal)),vec![]))
        }).map_err(|e| e.to_string())?;
        let Some((run, mut pt, msg, thread, cwd, ordinal)) = data else {
            return Ok(());
        };
        // Restore reservations cover the complete native start and its durable
        // projection. Acquire them off the async executor: the coordinator uses
        // condition variables, and a cancelled waiter drops its guards on return.
        let worktree = thread["worktreePath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let reservation_path = if let Some(ref path) = worktree {
            Some(path.clone())
        } else {
            self.bus.commit(|tx| {
                let path: Option<String> = tx.query_row("SELECT p.workspace_root FROM projection_projects p JOIN orchestration_v2_projection_threads t ON t.project_id=p.project_id WHERE t.thread_id=?1", [&thread_id], |r| r.get(0)).optional()?;
                Ok((path, vec![]))
            }).map_err(|e| e.to_string())?
        };
        let _workspace_guards = if let Some(path) = reservation_path {
            let worktree = worktree.clone();
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
                        absolute(path),
                        crate::workspace_safety::ReservationKind::TurnStart,
                    );
                    let lease = worktree
                        .map(|path| crate::workspace_safety::workspace_lease(absolute(path)));
                    (reservation, lease)
                })
                .await
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        // The run may have been stopped while waiting for an overlapping restore.
        let still_starting = self.bus.commit(|tx| {
            let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')", params![run_id,thread_id], |r| r.get(0))?;
            Ok((active, vec![]))
        }).map_err(|e| e.to_string())?;
        if !still_starting {
            return Ok(());
        }
        let runtime = codex_runtime_mode(&thread)?;
        if pt["driver"] != "codex" {
            return Err("Unsupported provider driver".into());
        }
        let session_id = required(&pt, "providerSessionId")?.to_owned();
        let instance_id = required(&pt, "providerInstanceId")?.to_owned();
        let (session, lease) = loop {
            let _refresh = self.sessions.secret_refresh.lock().await;
            let settings =
                super::session_registry::read_provider_settings(self.settings_path.as_deref())?;
            let entry = &settings["providerInstances"][&instance_id];
            let managed = entry["driver"] == "codex" && entry["config"]["setupMode"] == "managed";
            let (launch, references) = if managed {
                if entry["enabled"] == false || entry["config"]["enabled"] == false {
                    return Err(format!("Provider instance {instance_id} is disabled."));
                }
                #[cfg(unix)]
                {
                    let manager = self
                        .managed
                        .as_ref()
                        .ok_or("Managed Codex provider sessions are not available.")?;
                    let identity = super::instance::resolve_codex_identity(
                        self.settings_path.as_deref(),
                        &instance_id,
                        CodexLaunch::default(),
                    )?;
                    (
                        manager
                            .launch_with_home(
                                &instance_id,
                                identity.home.as_deref(),
                                super::instance::configured_shadow_home(&entry["config"])?
                                    .as_deref(),
                            )
                            .await?,
                        Vec::new(),
                    )
                }
                #[cfg(not(unix))]
                {
                    return Err(
                        "Managed Codex provider sessions are not available on this platform."
                            .into(),
                    );
                }
            } else {
                self.sessions
                    .hydrate_secrets(&settings, Some(&instance_id))
                    .await?;
                super::instance::resolve_codex_launch_tracked(
                    self.settings_path.as_deref(),
                    &instance_id,
                    (self.launch)(),
                    Some(&self.sessions.secrets),
                )?
            };
            if super::session_registry::read_provider_settings(self.settings_path.as_deref())?
                != settings
            {
                continue;
            }
            self.sessions
                .invalidate_mismatched_launch(&session_id, &launch, &references)
                .map_err(|e| e.to_string())?;
            let session = match self.sessions.open_for_instance(
                &session_id,
                launch,
                references,
                Some(&instance_id),
            ) {
                Ok(session) => session,
                Err(super::ProviderError::Protocol("provider session is refreshing")) => {
                    drop(_refresh);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if let Some(lease) = self
                .sessions
                .claim_turn(&session_id, &session)
                .map_err(|e| e.to_string())?
            {
                break (session, lease);
            }
            drop(_refresh);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        let mut guard = TurnGuard {
            bus: self.bus.clone(),
            sessions: self.sessions.clone(),
            session_id: session_id.clone(),
            preparation_thread: None,
            lease: Some(lease),
            translator: None,
            turn: None,
            settled: false,
            requests: Vec::new(),
        };
        let timeout = Duration::from_secs(30);
        session
            .initialize(timeout)
            .await
            .map_err(|e| e.to_string())?;
        let model = required(&run["modelSelection"], "model")?;
        let authorization = self
            .mcp_endpoint
            .as_ref()
            .map(|_| {
                self.sessions.prepare_mcp(
                    &thread_id,
                    &instance_id,
                    thread["lineage"]["relationshipToParent"] == "subagent",
                )
            })
            .transpose()?;
        let mcp = self.mcp_endpoint.as_deref().zip(authorization.as_deref());
        let mut thread_params =
            codex_thread_runtime_params(Some(&thread_id), cwd.as_deref(), Some(model), mcp);
        let candidate = self
            .bus
            .commit(|tx| {
                Ok((
                    crate::message_commands::native_fork_candidate(tx, &thread_id, &instance_id)?,
                    vec![],
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut native_transfer = None;
        let mut fork_result = None;
        let mut fork_failure = None;
        if pt["nativeThreadRef"].is_null() {
            if let Some(transfer) = candidate {
                let mut params = thread_params.clone();
                params["threadId"] =
                    transfer["sourcePoint"]["providerThreadRef"]["nativeId"].clone();
                let native_turn = transfer["sourcePoint"]["providerTurnRef"]["nativeId"]
                    .as_str()
                    .filter(|id| !id.is_empty());
                let rollback_count: usize = if native_turn.is_none() {
                    self.bus.commit(|tx| {
                        let count: i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_turns later JOIN orchestration_v2_projection_runs base ON base.run_id=?1 JOIN orchestration_v2_projection_provider_turns boundary ON boundary.run_attempt_id=json_extract(base.payload_json,'$.activeAttemptId') AND boundary.provider_thread_id=base.provider_thread_id AND boundary.ordinal=(SELECT MAX(b.ordinal) FROM orchestration_v2_projection_provider_turns b WHERE b.run_attempt_id=json_extract(base.payload_json,'$.activeAttemptId') AND b.provider_thread_id=base.provider_thread_id) WHERE later.provider_thread_id=boundary.provider_thread_id AND later.ordinal>boundary.ordinal AND later.status IN ('completed','failed','cancelled','interrupted')", [transfer["sourcePoint"]["runId"].as_str()], |r| r.get(0))?;
                        Ok((count as usize, vec![]))
                    }).map_err(|e| e.to_string())?
                } else {
                    0
                };
                if let Some(id) = native_turn {
                    params["lastTurnId"] = json!(id);
                }
                params["excludeTurns"] = json!(true);
                let mut fork = session
                    .request("thread/fork", Some(params.clone()), timeout)
                    .await;
                if matches!(&fork, Err(super::ProviderError::Remote { message, .. }) if is_archived_codex_session(message))
                {
                    let source_id = params["threadId"].clone();
                    fork = match session
                        .request(
                            "thread/unarchive",
                            Some(json!({"threadId": source_id})),
                            timeout,
                        )
                        .await
                    {
                        Ok(_) => session.request("thread/fork", Some(params), timeout).await,
                        Err(error) => Err(error),
                    };
                }
                if let Err(ref error) = fork {
                    fork_failure = Some(match error {
                        super::ProviderError::Remote { message, .. } => message.clone(),
                        other => other.to_string(),
                    });
                }
                if let Ok(result) = fork {
                    if let Some(id) = result
                        .pointer("/thread/id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        let id = id.to_owned();
                        let bounded = if rollback_count > 0 {
                            match super::rollback::prepare_boundary(
                                &session,
                                &id,
                                rollback_count,
                                thread_params.clone(),
                            )
                            .await
                            {
                                Ok(boundary) => super::rollback::apply_boundary(
                                    &session,
                                    &id,
                                    boundary.as_deref(),
                                )
                                .await
                                .map(|_| ()),
                                Err(error) => Err(error),
                            }
                        } else {
                            Ok(())
                        };
                        match bounded {
                            Ok(()) => {
                                fork_result = Some(id);
                                native_transfer = Some(transfer);
                            }
                            Err(error) => fork_failure = Some(error),
                        }
                    } else {
                        fork_failure = Some("Codex returned no forked thread ID".into());
                    }
                }
            }
            // A failed or newly ineligible native fork falls back to bounded history.
            if fork_result.is_none() {
                self.bus
                    .commit(|tx| {
                        let handoff = crate::message_commands::prepare_fork_handoff_impl(
                            tx,
                            &thread_id,
                            &run_id,
                            required(&run, "providerThreadId")
                                .map_err(|_| rusqlite::Error::InvalidQuery)?,
                            &instance_id,
                            "codex",
                            &now(),
                            true,
                        )?;
                        let events = if let Some((h, t, _)) = handoff {
                            let mut payloads = vec![
                                ("context-handoff.updated", h),
                                ("context-transfer.updated", t),
                            ];
                            if let Some(ref failure) = fork_failure {
                                let at = now();
                                let id = format!("turn-item:run:{run_id}:signal:native-fork-fallback");
                                let node = required(&run, "rootNodeId").map_err(|_| rusqlite::Error::InvalidQuery)?;
                                let provider_thread = required(&run, "providerThreadId").map_err(|_| rusqlite::Error::InvalidQuery)?;
                                let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [&thread_id], |r| r.get(0))?;
                                let notice = json!({"id":id,"threadId":thread_id,"runId":run_id,"nodeId":node,"providerThreadId":provider_thread,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Native fork failed","startedAt":at,"completedAt":at,"updatedAt":at,"type":"system_notice","message":format!("Could not fork the source conversation natively ({failure}). Started a fresh session with its history.")});
                                tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,'system_notice','completed',?7,?8) ON CONFLICT(turn_item_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json", rusqlite::params![id, thread_id, run_id, node, provider_thread, ordinal, at, notice.to_string()])?;
                                payloads.push(("turn-item.updated", notice));
                            }
                            payloads.into_iter()
                            .map(|(kind, payload)| Event {
                                id: uuid::Uuid::new_v4().to_string(),
                                aggregate_kind: "thread".into(),
                                stream_id: thread_id.clone(),
                                event_type: kind.into(),
                                occurred_at: now(),
                                command_id: None,
                                causation_event_id: None,
                                correlation_id: None,
                                actor_kind: "system".into(),
                                payload,
                                metadata: json!({}),
                            })
                            .collect::<Vec<_>>()
                        } else {
                            vec![]
                        };
                        Ok(((), event_store::append(tx, &events)?))
                    })
                    .map_err(|e| e.to_string())?;
            }
        }
        let native_thread = if let Some(id) = fork_result {
            id
        } else if let Some(id) = pt
            .pointer("/nativeThreadRef/nativeId")
            .and_then(Value::as_str)
        {
            thread_params["threadId"] = json!(id);
            thread_params["excludeTurns"] = json!(true);
            session
                .request("thread/resume", Some(thread_params), timeout)
                .await
                .map_err(|e| e.to_string())?;
            id.to_owned()
        } else {
            let result = session
                .request("thread/start", Some(thread_params), timeout)
                .await
                .map_err(|e| e.to_string())?;
            result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("Invalid thread/start response")?
                .to_owned()
        };
        let interaction = if thread["interactionMode"] == "plan" {
            CodexInteractionMode::Plan
        } else {
            CodexInteractionMode::Default
        };
        let handoffs = self
            .bus
            .commit(|tx| {
                Ok((
                    pending_handoffs(tx, run["providerThreadId"].as_str(), &run_id)?,
                    vec![],
                ))
            })
            .map_err(|e| e.to_string())?;
        let (handoffs, side_chat) = crate::context_handoff::split_side_chat_handoff(handoffs, thread["lineage"]["sideChat"] == true);
        let mut prompt = msg.clone();
        let mut delivered = Vec::new();
        if (!handoffs.is_empty() || side_chat.is_some())
            && !crate::context_handoff::defers_handoff_context(&msg)
        {
            let budget = crate::context_handoff::handoff_budget(
                crate::context_handoff::token_cap(
                    std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                        .ok()
                        .as_deref(),
                ),
                msg["text"].as_str().unwrap_or(""),
                msg["attachments"]
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
                            messages.push(m.clone())
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
            if !handoffs.is_empty() && crate::context_handoff::history_cost(&selected.messages, &selected.context) > budget
            {
                return Err("The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.".into());
            }
            let history = if handoffs.is_empty() { String::new() } else { crate::context_handoff::render_history(&selected.messages, &selected.context) };
            prompt["text"] = json!(crate::context_handoff::with_side_chat_context(&history, side_chat.as_ref(), msg["text"].as_str().unwrap_or("")));
            if let Some(mut h) = side_chat { h["toProviderThreadId"] = run["providerThreadId"].clone(); h["delivery"] = json!({"nativeThreadId":native_thread,"status":"inline","itemIds":[]}); delivered.push(h); }
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
                h["delivery"] =
                    json!({"nativeThreadId":native_thread,"status":"inline","itemIds":item_ids});
                delivered.push(h);
            }
        }
        let configured_summary = session
            .request(
                "config/read",
                Some(json!({"cwd": cwd, "includeLayers": false})),
                timeout,
            )
            .await
            .ok()
            .and_then(|response| configured_reasoning_summary(&response).map(str::to_owned));
        let input = codex_input(&prompt, &self.attachments_dir)?;
        let params = codex_turn_start_params(CodexTurnParams {
            thread_id: &native_thread,
            input,
            cwd: cwd.as_deref(),
            model,
            runtime_mode: runtime,
            interaction_mode: interaction,
            approval_policy: None,
            sandbox_policy: None,
            reasoning_effort: run
                .pointer("/modelSelection/reasoningEffort")
                .and_then(Value::as_str),
            service_tier: None,
            fast_mode: false,
            omit_service_tier: false,
            reasoning_summary: configured_summary.as_deref(),
            cyber_access_default: None,
            cyber_access_selection: None,
            additional_context: None,
            app_context: vec![],
        })
        .map_err(|e| e.to_string())?;
        let mut turn_events = session
            .subscribe_thread(&native_thread)
            .map_err(|e| e.to_string())?;
        children::restore(&self.bus, &thread_id, &mut turn_events)?;
        let result = session
            .request("turn/start", Some(params), timeout)
            .await
            .map_err(|e| e.to_string())?;
        if !delivered.is_empty() {
            let _ = self.bus.commit(|tx| {
                let at=now(); let mut events=Vec::new();
                for mut h in delivered {h["updatedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_context_handoffs SET updated_at=?2,payload_json=?3,to_provider_thread_id=json_extract(?3,'$.toProviderThreadId') WHERE context_handoff_id=?1",params![h["id"].as_str(),at,h.to_string()])?;events.push(Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.clone(),event_type:"context-handoff.updated".into(),occurred_at:at.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:h,metadata:json!({})});}
                Ok(((),event_store::append(tx,&events)?))
            });
        }
        let native_turn = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("Invalid turn/start response")?
            .to_owned();
        let timestamp = now();
        let turn = RootTurn {
            driver: "codex".into(),
            native_thread_id: native_thread.clone(),
            native_turn_id: native_turn.clone(),
            provider_thread_id: required(&run, "providerThreadId")?.into(),
            provider_turn_id: format!(
                "provider-turn:provider:codex:native-turn:{}",
                crate::message_commands::encode_id_part(&native_turn)
            ),
            thread_id: thread_id.clone(),
            run_id: Some(run_id.clone()),
            run_attempt_id: required(&run, "activeAttemptId")?.into(),
            root_node_id: required(&run, "rootNodeId")?.into(),
            provider_turn_ordinal: ordinal,
            run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
            started_at: timestamp.clone(),
        };
        let (translator, started) = CodexRootTurnTranslator::start_with_usage(
            turn.clone(),
            session.turn_usage(&native_thread),
        );
        guard.turn = Some(turn.clone());
        guard.translator = Some(translator);
        if let Some(ref transfer) = native_transfer {
            let source = self.bus.commit(|tx| {
                let row: Option<(String, Option<String>)> = tx.query_row("SELECT r.provider_thread_id, t.provider_turn_id FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_provider_turns t ON t.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.run_id=?1 ORDER BY t.rowid DESC LIMIT 1", [transfer["sourcePoint"]["runId"].as_str()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
                Ok((row,vec![]))
            }).map_err(|e| e.to_string())?;
            if let Some((source_thread, source_turn)) = source {
                pt["forkedFrom"] =
                    json!({"providerThreadId":source_thread,"providerTurnId":source_turn});
            }
        }
        pt["nativeThreadRef"] =
            json!({"driver":"codex","nativeId":native_thread,"strength":"strong"});
        pt["status"] = json!("active");
        pt["updatedAt"] = json!(timestamp);
        self.bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='active',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![turn.provider_thread_id,timestamp,pt.to_string()])?;
            let capabilities=json!({
                "sessions":{"supportsMultipleProviderThreadsPerSession":true,"supportsModelSwitchInSession":true,"supportsProviderSwitchingViaHandoff":true,"supportsRuntimeModeSwitchInSession":true,"pendingRequestsSurviveRestart":false},
                "threads":{"canCreateEmptyThread":true,"canReadThreadSnapshot":true,"canRollbackThread":true,"canForkThread":true,"canForkFromTurn":true,"canForkFromSubagentThread":true,"exposesNativeThreadId":true},
                "turns":{"exposesNativeTurnId":true,"emitsTurnStarted":true,"emitsTurnCompleted":true,"supportsInterrupt":true,"supportsActiveSteering":true,"activeSteeringDuringCompaction":true,"supportsSteeringByInterruptRestart":true,"supportsQueuedMessages":true,"terminalStatusQuality":"strong"},
                "streaming":{"streamsAssistantText":true,"streamsReasoning":true,"streamsToolOutput":true,"streamsPlanText":true,"emitsMessageCompleted":true},
                "tools":{"exposesToolItemIds":true,"emitsToolStarted":true,"emitsToolCompleted":true,"emitsToolOutput":true,"supportsMcpTools":true,"supportsDynamicToolCallbacks":true},
                "approvals":{"supportsCommandApproval":true,"supportsFileReadApproval":true,"supportsFileChangeApproval":true,"supportsApplyPatchApproval":true,"approvalsHaveNativeRequestIds":true,"approvalCallbacksAreLiveOnly":true,"approvalsCanOriginateFromSubagents":true},
                "planning":{"emitsPlanUpdated":true,"emitsTodoList":true,"emitsProposedPlan":true,"supportsStructuredQuestions":true,"planDeltasHaveItemIds":true},
                "subagents":{"supportsSubagents":true,"exposesSubagentThreadIds":true,"emitsSubagentLifecycle":true,"canWaitForSubagents":true,"canCloseSubagents":true,"canForkSubagentThread":true},
                "context":{"acceptsSystemContext":true,"acceptsDeveloperContext":true,"acceptsSyntheticUserContext":true,"canGenerateSummaries":true,"canConsumeHandoffSummaries":true,"supportsDeltaHandoff":true,"supportsFullThreadHandoff":true,"maxRecommendedHandoffChars":null},
                "checkpointing":{"appCanCheckpointFilesystem":true,"supportsNestedCheckpointScopes":true,"providerCanRollbackConversation":true,"providerRollbackReturnsSnapshot":true,"providerCanReadConversationSnapshot":true},
                "identity":{"nativeThreadIds":"strong","nativeTurnIds":"strong","nativeItemIds":"strong","nativeRequestIds":"strong"},"runtimePolicy":{"enforcement":"native"}
            });
            let session_payload=json!({"id":session_id,"providerInstanceId":instance_id,"driver":"codex","status":"ready","model":run["modelSelection"]["model"],"cwd":cwd,"capabilities":capabilities,"extensionStatuses":[],"lastError":null,"createdAt":timestamp,"updatedAt":timestamp});
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,model,updated_at,payload_json) VALUES(?1,?2,'codex','ready',?3,?4,?5) ON CONFLICT(provider_session_id) DO NOTHING",params![session_id,thread_id,run["modelSelection"]["model"].as_str(),timestamp,session_payload.to_string()])?;
            // A shared session is attached once to each thread, but is reported on
            // every turn start. Preserve the existing session identity and model.
            let raw_session:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?1",[&session_id],|r|r.get(0))?;
            let session_payload:Value=serde_json::from_str(&raw_session).map_err(|_|rusqlite::Error::InvalidQuery)?;
            let attached=tx.execute("INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES(?1,?2)",params![session_id,thread_id])?;
            let mut payloads=Vec::new();
            if attached==1 {payloads.push(("provider-session.attached",session_payload.clone()));}
            payloads.push(("provider-session.updated",session_payload));
            payloads.push(("provider-thread.updated",pt));
            if let Some(mut transfer) = native_transfer {
                transfer["targetProviderInstanceId"] = json!(instance_id);
                transfer["targetRunId"] = json!(run_id);
                transfer["status"] = json!("consumed");
                transfer["resolution"] = json!({"strategy":"native_fork","providerThreadRef":{"driver":"codex","nativeId":native_thread,"strength":"strong"}});
                transfer["error"] = Value::Null;
                transfer["updatedAt"] = json!(timestamp);
                transfer["consumedAt"] = json!(timestamp);
                tx.execute("UPDATE orchestration_v2_projection_context_transfers SET target_run_id=?2,target_provider=?3,target_provider_instance_id=?3,status='consumed',updated_at=?4,payload_json=?5 WHERE context_transfer_id=?1", params![transfer["id"].as_str(),run_id,instance_id,timestamp,transfer.to_string()])?;
                payloads.push(("context-transfer.updated",transfer));
            }
            for (select, update, id, kind) in [
                ("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1", "UPDATE orchestration_v2_projection_runs SET status='running',payload_json=?3 WHERE run_id=?1 AND status='starting'", run_id.as_str(), "run.updated"),
                ("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1", "UPDATE orchestration_v2_projection_run_attempts SET status='running',payload_json=?3 WHERE attempt_id=?1", turn.run_attempt_id.as_str(), "run-attempt.updated"),
                ("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", "UPDATE orchestration_v2_projection_nodes SET status='running',started_at=?2,payload_json=?3 WHERE node_id=?1", turn.root_node_id.as_str(), "node.updated"),
            ] {
                let raw:String=tx.query_row(select,[id],|r|r.get(0))?;
                let mut payload:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                payload["status"]=json!("running"); payload["startedAt"]=json!(timestamp);
                if kind == "run-attempt.updated" { payload["nativeThreadId"]=json!(native_thread); }
                if tx.execute(update,params![id,timestamp,payload.to_string()])? != 1 { return Err(rusqlite::Error::InvalidQuery); }
                payloads.push((kind,payload));
            }
            let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)| Event { id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.clone(),event_type:kind.into(),occurred_at:timestamp.clone(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({}) }).collect();
            let events=event_store::append(tx,&events)?; Ok(((),events))
        }).map_err(|e| e.to_string())?;
        ingest::ingest(&self.bus, &[started]).map_err(|e| e.to_string())?;
        crate::message_commands::deliver_deferred(
            &self.bus,
            &thread_id,
            &turn.run_attempt_id,
            &timestamp,
        )
        .map_err(|e| e.to_string())?;
        let bus = self.bus.clone();
        let attachments_dir = self.attachments_dir.clone();
        let task = tokio::spawn(async move {
            let (capture_tx, mut capture_rx) =
                tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
            let mut captures =
                std::collections::HashMap::<String, (Value, tokio::task::JoinHandle<()>)>::new();
            let mut ready = std::collections::VecDeque::<Value>::new();
            let mut deferred_terminal: Option<Value> = None;
            let mut children = children::Children::default();
            let mut parent_settled = false;
            let result: Result<(), String> = async move {
        loop {
            if session.take_interrupting(&turn.native_thread_id, &turn.native_turn_id) {
                guard.translator.as_mut().unwrap().mark_interrupting();
            }
            while let Ok((id, params)) = capture_rx.try_recv() {
                if captures.remove(&id).is_some() { ready.push_back(params); }
                else if let Some(id) = params.pointer("/item/_t3McpApp/attachmentId").and_then(Value::as_str) { let _ = std::fs::remove_file(attachments_dir.join(format!("{id}.html"))); }
            }
            let event = if let Some(params) = ready.pop_front() {
                Ok(Ok(ProviderEvent::Notification { method: "item/completed".into(), params: Some(params) }))
            } else if captures.is_empty() && deferred_terminal.is_some() {
                Ok(Ok(ProviderEvent::Notification { method: "turn/completed".into(), params: deferred_terminal.take() }))
            } else if parent_settled && !turn_events.has_active_children() {
                // Terminal processing flushed both translators. Stay asleep until
                // new child traffic arrives instead of polling an idle session.
                Ok(turn_events.next_event().await)
            } else {
                tokio::time::timeout(Duration::from_millis(50), turn_events.next_event()).await
            };
            let timestamp = now();
            match event {
                Err(_) => {
                    children.flush(&bus, &timestamp)?;
                    let events = guard.translator.as_mut().unwrap().flush(&timestamp);
                    if !events.is_empty() {
                        ingest::ingest(&bus, &events).map_err(|e| e.to_string())?;
                    }
                }
                Ok(Err(super::ProviderError::Closed)) if parent_settled => return Ok(()),
                Ok(Err(e)) => return Err(e.to_string()),
                Ok(Ok(ProviderEvent::Request { id, method, params })) => {
                    if params.as_ref().and_then(|p| p["threadId"].as_str().or_else(|| p["conversationId"].as_str())).is_some_and(|id| id != turn.native_thread_id) {
                        if guard.lease.is_none() {
                            guard.lease = Some(guard.sessions.claim_turn(&session_id, &session).map_err(|e| e.to_string())?.ok_or("Provider session retired")?);
                        }
                        let (artifacts, child_turn) = children.request(&bus, &session, &session_id, &method, params.unwrap_or(Value::Null), &timestamp)?;
                        let request_id = artifacts.request["id"].as_str().unwrap().to_owned();
                        codex_requests::register(session.clone(), id, artifacts.clone());
                        guard.requests.push(request_id);
                        codex_requests::ingest(&bus, &child_turn, &artifacts, &timestamp).map_err(|e| e.to_string())?;
                        continue;
                    }
                    let ordinal = bus.commit(|tx| {
                        let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE provider_turn_id=?1", [&turn.provider_turn_id], |r| r.get(0))?;
                        Ok((ordinal,vec![]))
                    }).map_err(|e| e.to_string())?;
                    let mut request_params = params.unwrap_or(Value::Null);
                    if method == "item/fileChange/requestApproval" {
                        if let Some(id) = request_params["itemId"].as_str() {
                            if let Some(changes) = guard.translator.as_ref().unwrap().file_changes(id) {
                                request_params["fileChanges"] = changes.clone();
                            }
                        }
                    }
                    let artifacts = codex_requests::translate(
                        &turn,
                        &session_id,
                        &method,
                        request_params,
                        &timestamp,
                        ordinal,
                    )?;
                    let request_id = artifacts.request["id"].as_str().unwrap().to_owned();
                    codex_requests::register(session.clone(), id, artifacts.clone());
                    guard.requests.push(request_id);
                    codex_requests::ingest(&bus, &turn, &artifacts, &timestamp)
                        .map_err(|e| e.to_string())?;
                }
                Ok(Ok(ProviderEvent::Notification { method, params })) => {
                    if session.take_interrupting(&turn.native_thread_id, &turn.native_turn_id) {
                        guard.translator.as_mut().unwrap().mark_interrupting();
                    }
                    if params.as_ref().and_then(|p| p["threadId"].as_str()).is_some_and(|id| id != turn.native_thread_id) {
                        let child = params.as_ref().and_then(|p| p["threadId"].as_str()).unwrap().to_owned();
                        if guard.lease.is_none() && method != "thread/status/changed" && method != "thread/settings/updated" && method != "thread/started" {
                            guard.lease = Some(guard.sessions.claim_turn(&session_id, &session).map_err(|e| e.to_string())?.ok_or("Provider session retired")?);
                        }
                        if method != "turn/completed" && params.as_ref().is_some_and(|p| p["turnId"].is_string() || p.pointer("/turn/id").is_some_and(Value::is_string)) { turn_events.child_started(&child); }
                        children.notification(&bus, &session, &mut turn_events, &method, params.unwrap_or(Value::Null), &timestamp)?;
                        if method == "turn/completed" {
                            turn_events.child_settled(&child);
                            if parent_settled && !turn_events.has_active_children() {
                                children.flush(&bus, &timestamp)?;
                                guard.lease.take();
                            }
                        }
                        continue;
                    }
                    if parent_settled { continue; }
                    // The dispatched user message is already projected locally.
                    if matches!(method.as_str(), "item/started" | "item/completed")
                        && params
                            .as_ref()
                            .and_then(|p| p.pointer("/item/type"))
                            .and_then(Value::as_str)
                            == Some("userMessage")
                    {
                        continue;
                    }
                    let params = params.unwrap_or(Value::Null);
                    if method == "turn/completed" && !captures.is_empty() {
                        if matches!(params.pointer("/turn/status").and_then(Value::as_str), Some("failed" | "interrupted")) || session.take_interrupting(&turn.native_thread_id, &turn.native_turn_id) {
                            for (_, (mut item, task)) in captures.drain() {
                                task.abort();
                                item["item"]["_t3CaptureDone"] = json!(true);
                                ready.push_back(item);
                            }
                        }
                        deferred_terminal = Some(params);
                        continue;
                    }
                    if method == "item/completed" && params.pointer("/item/type").and_then(Value::as_str) == Some("mcpToolCall") && params.pointer("/item/_t3CaptureDone").is_none() {
                        let item = &params["item"];
                        if let (Some(uri), Some(server), Some(tool)) = (super::mcp_app::resource_uri(item), item["server"].as_str(), item["tool"].as_str()) {
                            if !item["result"].is_null() && item["error"].is_null() {
                                let (uri, server, tool) = (uri.to_owned(), server.to_owned(), tool.to_owned());
                                let session = session.clone();
                                let tx = capture_tx.clone();
                                let dir = attachments_dir.clone();
                                let native = turn.native_thread_id.clone();
                                let projection = turn.thread_id.clone();
                                let capture_id = uuid::Uuid::new_v4().to_string();
                                let task_id = capture_id.clone();
                                let original = params.clone();
                                let task = tokio::spawn(async move {
                                    let mut params = params;
                                    if let Ok(response) = session.request("mcpServer/resource/read", Some(json!({"threadId":native,"server":server,"uri":uri})), Duration::from_secs(20)).await {
                                        if let Some(reference) = super::mcp_app::snapshot(&dir, &projection, &server, &tool, &uri, &response["contents"]) {
                                            params["item"]["_t3McpApp"] = reference;
                                        }
                                    }
                                    params["item"]["_t3CaptureDone"] = json!(true);
                                    if let Err(error) = tx.send((task_id, params)) {
                                        if let Some(id) = error.0.1.pointer("/item/_t3McpApp/attachmentId").and_then(Value::as_str) { let _ = std::fs::remove_file(dir.join(format!("{id}.html"))); }
                                    }
                                });
                                captures.insert(capture_id, (original, task));
                                continue;
                            }
                        }
                    }
                    let output_delta = if method == "item/commandExecution/outputDelta" {
                        params["delta"].as_str().map(str::to_owned)
                    } else { None };
                    match guard
                        .translator
                        .as_mut()
                        .unwrap()
                        .notification(&method, params, &timestamp, |ms| {
                            chrono::DateTime::from_timestamp_millis(ms)
                                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                                .unwrap_or_else(now)
                        })
                        .map_err(|e| format!("{e:?}"))?
                    {
                        Translation::Events(events) => {
                            if let Some(chunk) = &output_delta {
                                for event in &events {
                                    if let NormalizedEvent::CommandUpdated(command) = event {
                                        let item = format!("turn-item:provider:codex:native-item:{}", crate::message_commands::encode_id_part(&command.native_item_id));
                                        bus.command_output().append(&command.turn.thread_id, &item, chunk);
                                    }
                                }
                                // Output deltas are transient; completion persists the accumulated result.
                                continue;
                            }
                            let finished_commands: Vec<_> = events.iter().filter_map(|event| match event {
                                NormalizedEvent::CommandUpdated(command) if command.status != "running" => Some((command.turn.thread_id.clone(), format!("turn-item:provider:codex:native-item:{}", crate::message_commands::encode_id_part(&command.native_item_id)))),
                                _ => None,
                            }).collect();
                            let terminal = events
                                .iter()
                                .any(|e| matches!(e, NormalizedEvent::TurnTerminal { .. }));
                            if !events.is_empty() {
                                ingest::ingest(&bus, &events).map_err(|e| e.to_string())?;
                                children::register(&events, &mut turn_events)?;
                            }
                            for (thread,item) in finished_commands { bus.command_output().finish(&thread,&item); }
                            if terminal {
                                children.flush(&bus, &timestamp)?;
                                guard.mark_settled();
                                parent_settled = true;
                                turn_events.detach_parent();
                                if !turn_events.has_children() { return Ok(()); }
                                if !turn_events.has_active_children() { guard.lease.take(); }
                            }
                        }
                        Translation::Unsupported
                            if matches!(
                                method.as_str(),
                                "thread/started"
                                    | "thread/status/changed"
                                    | "thread/settings/updated"
                                    | "account/updated"
                                    | "account/rateLimits/updated"
                                    | "mcpServer/startupStatus/updated"
                                    | "configWarning"
                                    | "remoteControl/status/changed"
                                    | "turn/started"
                            ) => {}
                        Translation::Unsupported => {
                            return Err(format!("Unsupported Codex notification: {method}"))
                        }
                    }
                }
            }
        }
            }.await;
            if let Err(error) = result {
                eprintln!("Provider turn supervision failed: {error}");
            }
        });
        let mut tasks = self.supervisors.0.lock().map_err(|e| e.to_string())?;
        tasks.retain(|task| !task.is_finished());
        tasks.push(task.abort_handle());
        Ok(())
    }
}
impl EffectExecutor for CodexTurnExecutor {
    fn execute<'a>(&'a self, effect: &'a Effect, _will_retry: bool) -> Execution<'a> {
        Box::pin(async move {
            match effect.request["type"].as_str() {
                Some("provider-turn.start") => self.start(effect).await,
                Some("provider-turn.interrupt") => self.interrupt(effect).await,
                Some("provider-turn.steer") => self.steer(effect).await,
                Some("provider-turn.restart") => self.restart(effect).await,
                _ => Err("Unsupported effect".into()),
            }
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn reasoning_summary_accepts_only_provider_schema_values() {
        for value in ["auto", "concise", "detailed", "none"] {
            let response = serde_json::json!({"config":{"model_reasoning_summary":value}});
            assert_eq!(super::configured_reasoning_summary(&response), Some(value));
        }
        for value in [
            serde_json::json!("invalid"),
            serde_json::json!(42),
            serde_json::Value::Null,
        ] {
            let response = serde_json::json!({"config":{"model_reasoning_summary":value}});
            assert_eq!(super::configured_reasoning_summary(&response), None);
        }
    }
    #[test]
    fn runtime_mode_rejects_missing_and_unrecognized_values() {
        use super::*;
        for mode in [
            json!({}),
            json!({"runtimeMode": null}),
            json!({"runtimeMode": "unknown"}),
        ] {
            assert!(codex_runtime_mode(&mode).is_err());
        }
        for mode in [
            "full-access",
            "auto",
            "auto-accept-edits",
            "approval-required",
        ] {
            assert!(codex_runtime_mode(&json!({"runtimeMode": mode})).is_ok());
        }
    }

    #[test]
    fn attachment_input_embeds_images_and_references_files() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("codex-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let image_id = crate::attachment_paths::attachment_id("thread", None).unwrap();
        let file_id = crate::attachment_paths::attachment_id("thread", Some("pdf")).unwrap();
        std::fs::write(dir.join(format!("{image_id}.png")), b"abc").unwrap();
        std::fs::write(dir.join(format!("{file_id}.pdf")), b"pdf").unwrap();
        let message = json!({"text":"look", "attachments":[
            {"type":"image", "id":image_id, "name":"shot.png", "mimeType":"image/png", "sizeBytes":3},
            {"type":"file", "id":file_id, "name":"report.pdf", "mimeType":"application/pdf", "sizeBytes":3}
        ]});
        let input = codex_input(&message, &dir).unwrap();
        assert!(input[0]["text"]
            .as_str()
            .unwrap()
            .contains("Attached file \"report.pdf\" is saved at:"));
        assert_eq!(
            input[1],
            json!({"type":"image", "url":"data:image/png;base64,YWJj"})
        );
        std::fs::remove_file(dir.join(format!("{image_id}.png"))).unwrap();
        assert!(codex_input(&message, &dir)
            .unwrap_err()
            .contains("Failed to read attachment"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    use std::os::unix::fs::PermissionsExt;
    async fn wait_for_status(bus: &EventBus, expected: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = bus
                    .commit(|tx| {
                        let status: Option<String> = tx
                            .query_row(
                                "SELECT status FROM orchestration_v2_projection_provider_turns",
                                [],
                                |r| r.get(0),
                            )
                            .optional()?;
                        Ok((status, vec![]))
                    })
                    .unwrap();
                if status.as_deref() == Some(expected) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn managed_executor_runs_a_mock_turn_and_rejects_tampering() {
        use crate::codex_credential_store::{CredentialStore, Credentials};
        use crate::codex_managed_runtime::RuntimeManager;
        let root = std::env::temp_dir().join(format!("managed-executor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let helper = root.join("helper");
        std::fs::write(&helper, r##"#!/usr/bin/env python3
import sys,socket,json
endpoint, instance, environment, profile = sys.argv[2:]
s=socket.socket(socket.AF_UNIX); s.connect(endpoint)
s.sendall((json.dumps({'version':1,'instanceId':instance,'environmentId':environment,'profileKey':profile})+'\n').encode())
b=b''
while not b.endswith(b'\n'):
 p=s.recv(65536)
 if not p: sys.exit(1)
 b+=p
sys.stdout.write(json.loads(b)['token'])
"##).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let provider = r##"#!/usr/bin/env python3
import sys,json,subprocess
config=next(x for x in sys.argv if x.startswith('model_providers.openai_token_sharing='))
f=config.split('auth={command=',1)[1]; cmd,end=json.JSONDecoder().raw_decode(f); f=f[end:]
args,_=json.JSONDecoder().raw_decode(f[len(',args='):])
r=subprocess.run([cmd,*args],capture_output=True)
assert r.returncode == 0 and r.stdout == b'mock-token'
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['summary']=='concise'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start': print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
"##;
        let install = root.join("install");
        let asset = crate::codex_release::install_fixture(&install, provider.as_bytes()).await;
        let secrets = root.join("secrets");
        let store = CredentialStore::new(&secrets, "managed").unwrap();
        store
            .save(Credentials {
                client_id: "client".into(),
                access_token: "mock-token".into(),
                refresh_token: None,
                expires_at: chrono::Utc::now().timestamp_millis() + 300_000,
                earliest_refresh_at: None,
                scopes: vec!["chatgpt.tokens.use.direct".into()],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        let manager = Arc::new(
            RuntimeManager::new(
                secrets,
                "environment".into(),
                helper,
                root.join("homes"),
                install.clone(),
            )
            .with_fixture(crate::codex_oauth::Discovery::test_discovery(), asset),
        );
        let active = install.join("active.json");
        let pointer = std::fs::read(&active).unwrap();
        std::fs::remove_file(&active).unwrap();
        assert!(manager.launch("managed").await.is_err());
        std::fs::write(&active, pointer).unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&active, std::fs::Permissions::from_mode(0o600)).unwrap();
        let binary = install.join(asset.version).join("bin/codex");
        std::fs::write(&binary, b"tampered").unwrap();
        assert!(manager.launch("managed").await.is_err());
        std::fs::write(&binary, provider).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, r#"{"providerInstances":{"managed":{"driver":"codex","config":{"setupMode":"managed","binaryPath":"/untrusted","homePath":"/untrusted"}}}}"#).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"managed","model":"gpt"});
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "thread",
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
            "e",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "thread",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let mut executor =
            CodexTurnExecutor::new(bus.clone(), Arc::new(SessionRegistry::default()));
        executor.managed = Some(manager.clone());
        executor.settings_path = Some(settings);
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:thread:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        executor.execute(&effect, false).await.unwrap();
        wait_for_status(&bus, "completed").await;
        drop(executor);
        drop(manager);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fork_uses_native_rpc_or_falls_back_to_history() {
        for mode in ["success", "failure", "archived", "missing_cursor"] {
            let fail_fork = mode == "failure";
            let path = std::env::temp_dir().join(format!("codex-fork-{}", uuid::Uuid::new_v4()));
            let script = r##"#!/usr/bin/env python3
import sys,json
unarchived=False
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params') or {}
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'fresh-thread'}}
 elif method=='thread/unarchive':
  assert ARCHIVED and p['threadId']=='fresh-thread' and not unarchived
  unarchived=True; result={}
 elif method=='thread/fork':
  assert p['threadId']=='fresh-thread' and p.get('lastTurnId')==(None if MISSING else 'source-turn') and p['excludeTurns'] is True
  if ARCHIVED and not unarchived:
   print(json.dumps({'id':m['id'],'error':{'code':-32603,'message':'session fresh-thread is archived'}}),flush=True); continue
  if FAIL_FORK:
   print(json.dumps({'id':m['id'],'error':{'code':-32603,'message':'fork failed'}}),flush=True); continue
  result={'thread':{'id':'forked-thread'}}
 elif method=='thread/read': result={'thread':{'id':'forked-thread','historyMode':'paginated','status':{'type':'idle'}}}
 elif method=='thread/turns/list': result={'data':[{'id':'later-turn'}],'nextCursor':None}
 elif method=='thread/revert':
  assert p['beforeTurnId']=='later-turn'; result={'thread':{'id':'forked-thread'}}
 elif method=='turn/start':
  thread=p['threadId']; text=p['input'][0]['text']
  if text=='source marker': assert thread=='fresh-thread'
  else:
   assert thread==('fresh-thread' if FAIL_FORK else 'forked-thread')
   if FAIL_FORK: assert 'source marker' in text
  turn='source-turn' if text=='source marker' else 'child-turn'
  result={'turn':{'id':turn}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start': print(json.dumps({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}}),flush=True)
"##.replace("FAIL_FORK", if fail_fork { "True" } else { "False" }).replace("ARCHIVED", if mode == "archived" { "True" } else { "False" }).replace("MISSING", if mode == "missing_cursor" { "True" } else { "False" });
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            crate::migrations::run_ported_migrations(&mut db).unwrap();
            let bus = EventBus::new(db, 32);
            let selection = json!({"instanceId":"codex","model":"gpt"});
            let origin = json!("web");
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: "create",
                    thread_id: "parent",
                    project_id: "p",
                    title: "Parent",
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &origin,
                    link_origin: None,
                    delegated_from: None,
                },
                "e",
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            let send = |command_id, thread_id, message_id, text| DispatchMessage {
                context: None,
                command_id,
                thread_id,
                message_id,
                text,
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            };
            dispatch_first_message(
                &bus,
                send("source", "parent", "m1", "source marker"),
                "2026-01-01T00:00:01Z",
            )
            .unwrap();
            let binary = path.clone();
            let executor = CodexTurnExecutor {
                #[cfg(unix)]
                managed: None,
                bus: bus.clone(),
                sessions: Arc::new(SessionRegistry::default()),
                supervisors: Supervisors::default(),
                attachments_dir: PathBuf::new(),
                settings_path: None,
                mcp_endpoint: None,
                launch: Arc::new(move || CodexLaunch {
                    binary: Some(binary.clone()),
                    ..Default::default()
                }),
            };
            let effect = bus
                .commit(|tx| {
                    Ok((
                        crate::outbox::get(
                            tx,
                            "effect:source:provider-turn.start:run:thread:parent:ordinal:1",
                        )?
                        .unwrap(),
                        vec![],
                    ))
                })
                .unwrap();
            executor.execute(&effect, false).await.unwrap();
            wait_for_status(&bus, "completed").await;
            if mode == "missing_cursor" {
                bus.commit(|tx| {
                    tx.execute("UPDATE orchestration_v2_projection_provider_turns SET payload_json=json_set(payload_json,'$.nativeTurnRef',NULL)", [])?;
                    tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json) SELECT 'later',thread_id,provider_thread_id,node_id,ordinal+1,'completed','{}' FROM orchestration_v2_projection_provider_turns LIMIT 1", [])?;
                    Ok(((), vec![]))
                }).unwrap();
            }
            let point = json!({"type":"run","runId":"run:thread:parent:ordinal:1"});
            crate::fork_commands::fork_thread_ordered(
                &bus,
                crate::fork_commands::ForkThread {
                    command_id: "fork",
                    source_thread_id: "parent",
                    target_thread_id: "child",
                    source_point: &point,
                    title: None,
                    side_chat: false,
                    created_by: "user",
                    creation_source: &origin,
                },
                ["f1", "f2"],
                "transfer",
                "2026-01-01T00:00:02Z",
            )
            .unwrap();
            dispatch_first_message(
                &bus,
                send("child-send", "child", "m2", "continue"),
                "2026-01-01T00:00:03Z",
            )
            .unwrap();
            bus.commit(|tx| { let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='transfer'",[],|r|r.get(0))?; assert_eq!(status,"pending"); Ok(((),vec![])) }).unwrap();
            let effect = bus
                .commit(|tx| {
                    Ok((
                        crate::outbox::get(
                            tx,
                            "effect:child-send:provider-turn.start:run:thread:child:ordinal:1",
                        )?
                        .unwrap(),
                        vec![],
                    ))
                })
                .unwrap();
            executor.execute(&effect, false).await.unwrap();
            bus.commit(|tx| { let (status,strategy):(String,String)=tx.query_row("SELECT status,json_extract(payload_json,'$.resolution.strategy') FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='transfer'",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert_eq!(status,"consumed"); assert_eq!(strategy,if fail_fork {"portable_context"} else {"native_fork"}); let native:String=tx.query_row("SELECT json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM orchestration_v2_projection_provider_threads WHERE thread_id='child'",[],|r|r.get(0))?; assert_eq!(native,if fail_fork {"fresh-thread"} else {"forked-thread"}); Ok(((),vec![])) }).unwrap();
            bus.commit(|tx| {
                let notices: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id='child' AND type='system_notice' AND json_extract(payload_json,'$.message') LIKE '%fork failed%'", [], |r| r.get(0))?;
                assert_eq!(notices, i64::from(fail_fork));
                Ok(((), vec![]))
            }).unwrap();
            drop(executor);
            std::fs::remove_file(path).unwrap();
        }
    }
    #[tokio::test]
    async fn concurrent_threads_share_process_without_crossing_events() {
        let path = std::env::temp_dir().join(format!("codex-concurrent-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path,r##"#!/usr/bin/env python3
import sys,json
n=0
started=[]
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params') or {}
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start':
  n+=1; result={'thread':{'id':'native-'+str(n)}}
 elif method=='turn/start':
  t=p['threadId']; started.append(t); result={'turn':{'id':'turn-'+t}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start' and len(started)==2:
  for t in reversed(started):
   print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':t,'turnId':'turn-'+t,'itemId':'item-'+t,'delta':'answer-'+t}}),flush=True)
   print(json.dumps({'method':'turn/completed','params':{'threadId':t,'turn':{'id':'turn-'+t,'status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        for id in ["a", "b"] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: &format!("create-{id}"),
                    thread_id: id,
                    project_id: "p",
                    title: id,
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
                &format!("event-{id}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: &format!("send-{id}"),
                    thread_id: id,
                    message_id: &format!("m-{id}"),
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:01Z",
            )
            .unwrap();
        }
        let effects = bus
            .commit(|tx| {
                let mut effects = Vec::new();
                for id in ["a", "b"] {
                    effects.push(
                        crate::outbox::get(
                            tx,
                            &format!(
                                "effect:send-{id}:provider-turn.start:run:thread:{id}:ordinal:1"
                            ),
                        )?
                        .unwrap(),
                    );
                }
                Ok((effects, vec![]))
            })
            .unwrap();
        let binary = path.clone();
        let sessions = Arc::new(SessionRegistry::default());
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: sessions.clone(),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        let (a, b) = tokio::join!(
            executor.execute(&effects[0], false),
            executor.execute(&effects[1], false)
        );
        a.unwrap();
        b.unwrap();
        tokio::time::timeout(Duration::from_secs(5),async { loop { let count=bus.commit(|tx|Ok((tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_turns WHERE status='completed'",[],|r|r.get::<_,i64>(0))?,vec![]))).unwrap(); if count==2 {break} tokio::time::sleep(Duration::from_millis(10)).await; } }).await.unwrap_or_else(|e| { let state=bus.commit(|tx| {let mut stmt=tx.prepare("SELECT thread_id,status,payload_json FROM orchestration_v2_projection_runs")?; let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok((rows,vec![]))}).unwrap(); panic!("{e:?}: {state:?}") });
        bus.commit(|tx| { let count:i64=tx.query_row("SELECT count(DISTINCT provider_session_id) FROM orchestration_v2_projection_provider_threads",[],|r|r.get(0))?; assert_eq!(count,1); let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?; assert_eq!(count,2); let mismatched:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_provider_threads p ON p.thread_id=m.thread_id WHERE m.role='assistant' AND json_extract(m.payload_json,'$.text') != 'answer-' || json_extract(p.payload_json,'$.nativeThreadRef.nativeId')",[],|r|r.get(0))?; assert_eq!(mismatched,0); Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| {
            for thread in ["a", "b"] {
                for kind in ["provider-session.attached", "provider-session.updated"] {
                    let count: i64 = tx.query_row("SELECT count(*) FROM orchestration_events WHERE stream_id=?1 AND event_type=?2", params![thread, kind], |r| r.get(0))?;
                    assert_eq!(count, 1, "{kind} for {thread}");
                }
            }
            Ok(((), vec![]))
        }).unwrap();
        drop(executor);
        sessions
            .remove("provider-session:provider-instance:codex:shared")
            .unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn executes_a_real_subprocess_turn() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['input'][0]['text']=='hello'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'world'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let worktree =
            std::env::temp_dir().join(format!("codex-reservation-{}", uuid::Uuid::new_v4()));
        let worktree_text = worktree.to_str().unwrap();
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: Some(worktree_text),
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
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        let restore = crate::workspace_safety::reserve(
            &worktree,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let mut start = executor.execute(&effect, false);
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut start)
            .await
            .is_err());
        drop(restore);
        tokio::time::timeout(Duration::from_secs(5), start)
            .await
            .unwrap()
            .unwrap();
        wait_for_status(&bus, "completed").await;
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?; assert_eq!(text,"world"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns",[],|r|r.get(0))?; assert_eq!(status,"completed"); Ok(((),vec![])) }).unwrap();
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn native_child_events_are_replayed_and_do_not_settle_parent() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json,time
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method is None:
  assert m['id']=='child-request' and m['result']=={'answers':{'scope':{'answers':['All']}}}
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'response received'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
  continue
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['input'][0]['text']=='hello'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'child-native','turnId':'child-turn','itemId':'child-answer','delta':'child result'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'child-native','turn':{'id':'child-turn','status':'completed'}}}),flush=True)
  print(json.dumps({'id':'child-request','method':'item/tool/requestUserInput','params':{'threadId':'child-native','turnId':'child-turn','itemId':'ask','questions':[{'id':'scope','question':'Which?'}]}}),flush=True)
  print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':'native-turn','item':{'type':'collabAgentToolCall','id':'spawn','tool':'spawnAgent','receiverThreadIds':['child-native'],'prompt':'inspect','agentsStates':{}}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let worktree =
            std::env::temp_dir().join(format!("codex-reservation-{}", uuid::Uuid::new_v4()));
        let worktree_text = worktree.to_str().unwrap();
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: Some(worktree_text),
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
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        let restore = crate::workspace_safety::reserve(
            &worktree,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let mut start = executor.execute(&effect, false);
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut start)
            .await
            .is_err());
        drop(restore);
        tokio::time::timeout(Duration::from_secs(5), start)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async { loop {
            let done = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='child-turn' AND status='completed')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if done { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant' AND thread_id != 't'",[],|r|r.get(0))?; assert_eq!(text,"child result"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|r.get(0))?; assert_eq!(status,"running"); Ok(((),vec![])) }).unwrap();
        let (request_id, child_thread) = tokio::time::timeout(Duration::from_secs(3), async { loop {
            let request = bus.commit(|tx| {
                let mut stmt = tx.prepare("SELECT runtime_request_id, thread_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending'")?;
                let mut rows = stmt.query([])?;
                let row = rows.next()?.map(|r| Ok::<_, rusqlite::Error>((r.get::<_,String>(0)?, r.get::<_,String>(1)?))).transpose()?;
                Ok((row, vec![]))
            }).unwrap();
            if let Some(request) = request { break request; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        assert_ne!(child_thread, "t");
        assert!(
            codex_requests::respond_command(
                &bus,
                "child-answer",
                &child_thread,
                &request_id,
                None,
                Some(&json!({"scope":"All"})),
                "later"
            )
            .unwrap()
            .committed
        );
        let response_effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        &format!("effect:child-answer:runtime-request.respond:{request_id}"),
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        assert_eq!(response_effect.thread_id, child_thread);
        codex_requests::deliver(
            response_effect.request["requestId"].as_str().unwrap(),
            response_effect.request["decision"].as_str(),
            response_effect.request.get("answers"),
        )
        .await
        .unwrap();
        wait_for_status(&bus, "completed").await;
        bus.commit(|tx| { let text: String = tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant' AND thread_id='t'", [], |r| r.get(0))?; assert_eq!(text, "response received"); Ok(((), vec![])) }).unwrap();
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn native_child_route_restored_after_provider_restart() {
        let path =
            std::env::temp_dir().join(format!("codex-child-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json
resumed=False
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='thread/resume': resumed=True; result={'thread':{'id':'native-thread'}}
 elif method=='turn/start': result={'turn':{'id':'second-turn' if resumed else 'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  t='second-turn' if resumed else 'native-turn'
  if not resumed: print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':t,'item':{'type':'collabAgentToolCall','id':'spawn','tool':'spawnAgent','receiverThreadIds':['child-native'],'prompt':'inspect','agentsStates':{}}}}),flush=True)
  if not resumed:
   print(json.dumps({'method':'turn/completed','params':{'threadId':'child-native','turn':{'id':'child-first','status':'completed'}}}),flush=True)
   print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':t,'item':{'type':'collabAgentToolCall','id':'spawn','tool':'spawnAgent','receiverThreadIds':['child-native'],'agentsStates':{'child-native':{'status':'completed'}}}}}),flush=True)
  if resumed:
   print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'child-native','turnId':'child-follow','itemId':'answer','delta':'restored child'}}),flush=True)
   print(json.dumps({'method':'turn/completed','params':{'threadId':'child-native','turn':{'id':'child-follow','status':'completed'}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':t,'status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let worktree =
            std::env::temp_dir().join(format!("codex-reservation-{}", uuid::Uuid::new_v4()));
        let worktree_text = worktree.to_str().unwrap();
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: Some(worktree_text),
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
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        executor.execute(&effect, false).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async { loop {
            let ready = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id='effect:checkpoint.capture:run:thread:t:ordinal:1')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if ready { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        let capture = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(tx, "effect:checkpoint.capture:run:thread:t:ordinal:1")?
                        .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        crate::checkpoint::execute(
            &bus,
            "t",
            capture.request["runId"].as_str().unwrap(),
            capture.request["scopeId"].as_str().unwrap(),
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        wait_for_status(&bus, "completed").await;
        drop(executor);
        let receipt = crate::message_commands::dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send2",
                thread_id: "t",
                message_id: "m2",
                text: "again",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        assert_eq!(
            receipt.receipt.status, "accepted",
            "{:?}",
            receipt.receipt.error
        );
        let effect = bus
            .commit(|tx| {
                Ok((
                    { let id: String = tx.query_row("SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id='send2' AND effect_type='provider-turn.start'", [], |r| r.get(0))?; crate::outbox::get(tx, &id)?.unwrap() },
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        executor.execute(&effect, false).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async { loop {
            let ready = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE json_extract(payload_json,'$.text')='restored child') AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='child-follow' AND status='completed')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if ready { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn native_child_events_continue_after_parent_settles() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json,time,os
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['input'][0]['text']=='hello'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':'native-turn','item':{'type':'collabAgentToolCall','id':'spawn','tool':'spawnAgent','receiverThreadIds':['child-native'],'prompt':'inspect','agentsStates':{}}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
  time.sleep(1)
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'child-native','turnId':'child-turn','itemId':'child-answer','delta':'child result'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'child-native','turn':{'id':'child-turn','status':'completed'}}}),flush=True)
  time.sleep(0.5)
  print(json.dumps({'method':'turn/started','params':{'threadId':'child-native','turn':{'id':'follow-on','status':'inProgress'}}}),flush=True)
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'child-native','turnId':'follow-on','itemId':'follow-answer','delta':'follow-on result'}}),flush=True)
  while not os.path.exists(sys.argv[0]+'.continue'): time.sleep(0.01)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'child-native','turn':{'id':'follow-on','status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let worktree =
            std::env::temp_dir().join(format!("codex-reservation-{}", uuid::Uuid::new_v4()));
        let worktree_text = worktree.to_str().unwrap();
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: Some(worktree_text),
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
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        let restore = crate::workspace_safety::reserve(
            &worktree,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let mut start = executor.execute(&effect, false);
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut start)
            .await
            .is_err());
        drop(restore);
        tokio::time::timeout(Duration::from_secs(5), start)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async { loop {
            let done = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='child-turn' AND status='completed')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if done { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant' AND thread_id != 't'",[],|r|r.get(0))?; assert_eq!(text,"child result"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='native-turn'",[],|r|r.get(0))?; assert_eq!(status,"completed"); Ok(((),vec![])) }).unwrap();
        // A follow-on delta must flush while its turn is still active, after
        // the listener has spent time asleep with no active children.
        tokio::time::timeout(Duration::from_secs(3), async { loop {
            let visible = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json,'$.text')='follow-on result') AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='follow-on' AND status='running')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if visible { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        let continuation_marker = format!("{}.continue", path.display());
        std::fs::write(&continuation_marker, "").unwrap();
        tokio::time::timeout(Duration::from_secs(3), async { loop {
            let done = bus.commit(|tx| Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json,'$.nativeTurnRef.nativeId')='follow-on' AND status='completed')", [], |r| r.get::<_,bool>(0))?, vec![]))).unwrap();
            if done { break; } tokio::time::sleep(Duration::from_millis(10)).await;
        }}).await.unwrap();
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant' AND json_extract(payload_json,'$.text')='follow-on result'",[],|r|r.get(0))?; assert_eq!(text,"follow-on result"); Ok(((),vec![])) }).unwrap();
        std::fs::remove_file(continuation_marker).unwrap();
        let capture = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(tx, "effect:checkpoint.capture:run:thread:t:ordinal:1")?
                        .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        crate::checkpoint::execute(
            &bus,
            "t",
            capture.request["runId"].as_str().unwrap(),
            capture.request["scopeId"].as_str().unwrap(),
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        wait_for_status(&bus, "completed").await;
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn restart_interrupts_old_native_turn_then_starts_replacement() {
        let path = std::env::temp_dir().join(format!("codex-restart-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path,r##"#!/usr/bin/env python3
import sys,json
count=0
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method in ('thread/start','thread/resume'): result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  count+=1
  result={'turn':{'id':'turn-'+str(count)}}
 elif method=='turn/interrupt': result={}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/interrupt': print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'turn-1','status':'interrupted'}}}),flush=True)
 if method=='turn/start' and count==2: print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'turn-2','status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
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
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let send = |command_id, message_id, text| DispatchMessage {
            context: None,
            command_id,
            thread_id: "t",
            message_id,
            text,
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("first", "m1", "first"), "2026-01-01T00:00:01Z").unwrap();
        let start = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:first:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let sessions = Arc::new(SessionRegistry::default());
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: sessions.clone(),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        executor.execute(&start, false).await.unwrap();
        wait_for_status(&bus, "running").await;
        bus.commit(|tx| {let cap:bool=tx.query_row("SELECT json_extract(payload_json,'$.capabilities.turns.supportsActiveSteering') FROM orchestration_v2_projection_provider_sessions",[],|r|r.get(0))?;assert!(cap);Ok(((),vec![]))}).unwrap();
        let direct = crate::message_commands::restart_message(
            &bus,
            send("restart", "m2", "second"),
            "run:thread:t:ordinal:1",
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        assert_eq!(
            direct.receipt.status, "accepted",
            "{:?}",
            direct.receipt.error
        );
        let effect=bus.commit(|tx|{let id:String=tx.query_row("SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id='restart' AND effect_type='provider-turn.restart'",[],|r|r.get(0))?;Ok((crate::outbox::get(tx,&id)?.unwrap(),vec![]))}).unwrap();
        tokio::time::timeout(Duration::from_secs(5), executor.execute(&effect, false))
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {loop {let status:String=bus.commit(|tx|Ok((tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|r.get(0))?,vec![]))).unwrap();if status=="waiting"{break;}tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();
        bus.commit(|tx|{let n:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_turns WHERE status IN ('interrupted','completed')",[],|r|r.get(0))?;assert_eq!(n,2);let current:String=tx.query_row("SELECT json_extract(payload_json,'$.userMessageId') FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|r.get(0))?;assert_eq!(current,"m2");Ok(((),vec![]))}).unwrap();
        bus.commit(|tx| {
            let terminal_events: i64 = tx.query_row("SELECT count(*) FROM orchestration_events WHERE event_type='provider-turn.updated' AND json_extract(payload_json,'$.status') IN ('interrupted','completed')", [], |r| r.get(0))?;
            assert_eq!(terminal_events, 2);
            let ordered: bool = tx.query_row("SELECT (SELECT min(sequence) FROM orchestration_events WHERE event_type='provider-session.attached') < (SELECT min(sequence) FROM orchestration_events WHERE event_type='provider-turn.updated')", [], |r| r.get(0))?;
            assert!(ordered);
            Ok(((), vec![]))
        }).unwrap();
        drop(executor);
        drop(sessions);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn pending_handoff_survives_completed_run_and_is_not_redelivered() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        for (id, ordinal) in [("r1", 1), ("r2", 2)] {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex','codex','p','completed','now','{}')", params![id, ordinal]).unwrap();
        }
        tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('h','t','r1','p','manual_context','ready','now',?1)", [json!({"id":"h"}).to_string()]).unwrap();
        assert_eq!(pending_handoffs(&tx, Some("p"), "r2").unwrap().len(), 1);
        tx.execute("UPDATE orchestration_v2_projection_context_handoffs SET payload_json=json_set(payload_json,'$.delivery.status','inline')", []).unwrap();
        assert!(pending_handoffs(&tx, Some("p"), "r2").unwrap().is_empty());
    }
    #[test]
    fn side_chat_digest_survives_provider_switch_after_interruption() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)", [json!({"lineage":{"sideChat":true}}).to_string()]).unwrap();
        for (id, ordinal, status) in [("r1",1,"interrupted"),("r2",2,"starting")] {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex','codex','old',?3,'now','{}')", params![id,ordinal,status]).unwrap();
        }
        let handoff = json!({"id":"side","strategy":"manual_context","transferId":"fork","summaryText":"parent digest"});
        tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side','t','r1','old','manual_context','ready','now',?1)", [handoff.to_string()]).unwrap();
        let pending = pending_handoffs(&tx, Some("new"), "r2").unwrap();
        assert_eq!(pending, vec![handoff.clone()]);
        tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.userMessageId','m') WHERE run_id='r1'", []).unwrap();
        tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'now','now',?1)", [json!({"text":"/goal\npause","attachments":[]}).to_string()]).unwrap();
        assert_eq!(pending_handoffs(&tx, Some("new"), "r2").unwrap(), vec![handoff.clone()]);
        tx.execute("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.attachments',json('[{}]')) WHERE message_id='m'", []).unwrap();
        assert!(pending_handoffs(&tx, Some("new"), "r2").unwrap().is_empty());
        tx.execute("UPDATE orchestration_v2_projection_context_handoffs SET payload_json=json_set(payload_json,'$.delivery',json(?1)) WHERE context_handoff_id='side'", [json!({"status":"inline","nativeThreadId":"old-native"}).to_string()]).unwrap();
        assert!(pending_handoffs(&tx, Some("new"), "r2").unwrap().is_empty());
    }

    #[tokio::test]
    async fn imported_history_reaches_the_provider_request() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  text=m['params']['input'][0]['text']
  assert 'legacy decision marker' in text and 'side chat marker' in text and text.endswith('User message:\nhello')
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'world'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let worktree =
            std::env::temp_dir().join(format!("codex-reservation-{}", uuid::Uuid::new_v4()));
        let worktree_text = worktree.to_str().unwrap();
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: Some(worktree_text),
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.historyOrigin','v1_import') WHERE thread_id='t'", [])?;
            let item = json!({"id":"legacy-item","threadId":"t","runId":null,"providerThreadId":null,"ordinal":1,"status":"completed","type":"user_message","text":"legacy decision marker"});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES('legacy-item','t',NULL,NULL,NULL,1,'user_message','completed','now',?1)", [item.to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='t'", [])?;
            let provider: String = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE run_id='run:thread:t:ordinal:1'", [], |r| r.get(0))?;
            let handoff = json!({"id":"side-context","threadId":"t","targetRunId":"run:thread:t:ordinal:1","toProviderThreadId":provider,"strategy":"manual_context","transferId":"fork","status":"ready","summaryText":"side chat marker"});
            tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side-context','t','run:thread:t:ordinal:1',?1,'manual_context','ready','now',?2)", params![provider,handoff.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        let restore = crate::workspace_safety::reserve(
            &worktree,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let mut start = executor.execute(&effect, false);
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut start)
            .await
            .is_err());
        drop(restore);
        tokio::time::timeout(Duration::from_secs(5), start)
            .await
            .unwrap()
            .unwrap();
        wait_for_status(&bus, "completed").await;
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?; assert_eq!(text,"world"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns",[],|r|r.get(0))?; assert_eq!(status,"completed"); Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| {
            let delivery: String = tx.query_row("SELECT json_extract(payload_json,'$.delivery.status') FROM orchestration_v2_projection_context_handoffs WHERE thread_id='t'", [], |r| r.get(0))?;
            assert_eq!(delivery, "inline");
            let (status, items): (String,String) = tx.query_row("SELECT json_extract(payload_json,'$.delivery.status'),json_extract(payload_json,'$.delivery.itemIds') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side-context'", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status, "inline"); assert_eq!(items, "[]");
            Ok(((), vec![]))
        }).unwrap();
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn process_exit_settles_native_turn_as_failed() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['input'][0]['text']=='hello'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'world'}}),flush=True)
  sys.exit(0)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
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
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        tokio::time::timeout(Duration::from_secs(5), executor.execute(&effect, false))
            .await
            .unwrap()
            .unwrap();
        wait_for_status(&bus, "failed").await;
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?; assert_eq!(text,"world"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns",[],|r|r.get(0))?; assert_eq!(status,"failed"); let run:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs",[],|r|r.get(0))?; assert_eq!(run,"failed"); let errors:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE type='error'",[],|r|r.get(0))?; assert_eq!(errors,1); Ok(((),vec![])) }).unwrap();
        drop(executor);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn cancelled_execution_settles_native_turn_and_removes_session() {
        let path = std::env::temp_dir().join(format!("codex-executor-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import sys,json,time
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialized': continue
 if method=='config/read':
  print(json.dumps({'id':m['id'],'result':{'config':{'model_reasoning_summary':'concise'}}}),flush=True); continue
 if method=='initialize': result={}
 elif method=='thread/start': result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  assert m['params']['input'][0]['text']=='hello'
  result={'turn':{'id':'native-turn'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'world'}}),flush=True)
  time.sleep(5)
"##).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
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
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:t:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        let binary = path.clone();
        let executor = CodexTurnExecutor {
            #[cfg(unix)]
            managed: None,
            bus: bus.clone(),
            sessions: Arc::new(SessionRegistry::default()),
            supervisors: Supervisors::default(),
            attachments_dir: PathBuf::new(),
            settings_path: None,
            mcp_endpoint: None,
            launch: Arc::new(move || CodexLaunch {
                binary: Some(binary.clone()),
                ..Default::default()
            }),
        };
        tokio::time::timeout(Duration::from_secs(2), executor.execute(&effect, false))
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        drop(executor);
        wait_for_status(&bus, "failed").await;
        bus.commit(|tx| { let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE role='assistant'",[],|r|r.get(0))?; assert_eq!(text,"world"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_provider_turns",[],|r|r.get(0))?; assert_eq!(status,"failed"); let run:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs",[],|r|r.get(0))?; assert_eq!(run,"failed"); let errors:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE type='error'",[],|r|r.get(0))?; assert_eq!(errors,1); Ok(((),vec![])) }).unwrap();
        std::fs::remove_file(path).unwrap();
    }
}

// Codex reports archived sessions in either its direct error or its recovery hint.
fn is_archived_codex_session(message: &str) -> bool {
    static ARCHIVED: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    ARCHIVED
        .get_or_init(|| {
            regex::Regex::new(r"(?i)\bsession \S+ is archived\b|\bcodex unarchive\b").unwrap()
        })
        .is_match(message)
}
