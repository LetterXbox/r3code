//! Core root-turn notification translation, before orchestration ingestion.
//!
//! This deliberately does not handle subagents, goals, retries, token accounting,
//! async questions, images, or tools. The caller must route unsupported messages
//! to those handlers and must only use terminal output when none are outstanding.
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
mod failure;
pub use failure::{FailureClass, ProviderFailure};

fn mcp_result_output(result: &Value) -> Value {
    let content = result.get("content").cloned().unwrap_or(Value::Null);
    let structured = result.get("structuredContent").filter(|v| {
        !v.is_null()
            && !matches!(v, Value::Object(m) if m.is_empty())
            && !matches!(v, Value::Array(a) if a.is_empty())
    });
    let has_image = content.as_array().is_some_and(|items| {
        items.iter().any(|v| {
            v["type"] == "image" && (v["mimeType"].is_string() || v["source"]["type"] == "base64")
        })
    });
    match structured {
        Some(v) if has_image => serde_json::json!({"content": content, "structuredContent": v}),
        Some(v) => v.clone(),
        None => content,
    }
}

fn dynamic_output(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return value.clone();
    };
    Value::Array(items.iter().map(|item| {
        if item["type"] == "inputImage" {
            if let Some(url) = item["imageUrl"].as_str() {
                if let Some((mime, data)) = url.strip_prefix("data:").and_then(|s| s.split_once(";base64,")) {
                    if mime.starts_with("image/") && !data.is_empty() { return serde_json::json!({"type":"image", "mimeType":mime.to_lowercase(), "data":data}); }
                }
            }
        }
        item.clone()
    }).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootTurn {
    pub driver: String,
    pub native_thread_id: String,
    pub native_turn_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: String,
    pub thread_id: String,
    pub run_id: Option<String>,
    pub run_attempt_id: String,
    pub root_node_id: String,
    pub provider_turn_ordinal: u64,
    pub run_ordinal: u64,
    pub started_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadDisposition {
    Reusable,
}

/// The shared data from which the node, message, and turn item are projected.
/// Each distinct native item has a stable position and a cumulative text value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantArtifact {
    pub turn: RootTurn,
    pub native_item_id: String,
    pub phase: Option<String>,
    pub text: String,
    pub ordinal: u64,
    pub started_at: String,
    pub updated_at: String,
    pub completed: bool,
}

/// A reasoning part has its own stable position, but references its native item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningArtifact {
    pub artifact: AssistantArtifact,
    pub native_reasoning_item_id: String,
    pub stream: String,
    pub index: usize,
    pub interrupted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandArtifact {
    pub turn: RootTurn,
    pub native_item_id: String,
    pub input: String,
    pub output: Option<String>,
    pub exit_code: Option<i64>,
    pub ordinal: u64,
    pub started_at: String,
    pub updated_at: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolArtifact {
    pub turn: RootTurn,
    pub native_item_id: String,
    pub ordinal: u64,
    pub started_at: String,
    pub updated_at: String,
    pub status: String,
    pub kind: String,
    pub fields: Value,
}

/// Typed normalized events; artifact ids are allocated by the ingestion layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedEvent {
    ProviderTurnUpdated {
        turn: RootTurn,
        status: TurnStatus,
        completed_at: Option<String>,
    },
    TokenUsageUpdated {
        turn: RootTurn,
        usage: Value,
        at: String,
    },
    NodeUpdated(AssistantArtifact),
    MessageUpdated(AssistantArtifact),
    TurnItemUpdated(AssistantArtifact),
    ReasoningNodeUpdated(ReasoningArtifact),
    ReasoningTurnItemUpdated(ReasoningArtifact),
    CommandUpdated(CommandArtifact),
    ToolUpdated(ToolArtifact),
    NativeSubagent {
        turn: RootTurn,
        item: Value,
        ordinal: u64,
        at: String,
    },
    TurnTerminal {
        turn: RootTurn,
        status: TurnStatus,
        failure: Option<ProviderFailure>,
        failure_item_ordinal: Option<u64>,
        thread_disposition: ThreadDisposition,
    },
}

/// Unknown methods and unsupported payload variants are never silently consumed.
#[derive(Debug, PartialEq, Eq)]
pub enum Translation {
    Events(Vec<NormalizedEvent>),
    Unsupported,
}
#[derive(Debug)]
pub enum TranslationError {
    InvalidPayload(serde_json::Error),
    WrongTurn,
}
impl From<serde_json::Error> for TranslationError {
    fn from(value: serde_json::Error) -> Self {
        Self::InvalidPayload(value)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTurnNotification {
    thread_id: String,
    turn: NativeTurn,
}
#[derive(Deserialize)]
struct NativeTurn {
    id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "completedAt")]
    completed_at: Option<f64>,
    #[serde(default)]
    error: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorNotification {
    thread_id: String,
    turn_id: String,
    will_retry: bool,
    error: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    thread_id: String,
    turn_id: String,
    item_id: String,
    delta: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemNotification {
    thread_id: String,
    turn_id: String,
    item: NativeItem,
    #[serde(default)]
    started_at_ms: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeItem {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    delivery: Option<String>,
    #[serde(default)]
    questions: Option<Vec<Value>>,
    #[serde(default)]
    summary: Option<Vec<String>>,
    #[serde(default)]
    content: Option<Vec<String>>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    aggregated_output: Option<String>,
    #[serde(default)]
    exit_code: Option<i64>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningDelta {
    thread_id: String,
    turn_id: String,
    item_id: String,
    delta: String,
    #[serde(default)]
    summary_index: Option<usize>,
    #[serde(default)]
    content_index: Option<usize>,
}
#[derive(Debug)]
struct ReasoningPart {
    key: String,
    native_id: String,
    stream: &'static str,
    index: usize,
    text: String,
    dirty: bool,
}
#[derive(Debug)]
struct ItemState {
    id: String,
    text: String,
    dirty: bool,
}

/// Translator for one known root turn. Call `start` once after the turn is
/// registered (by turn/start response or turn/started). `flush` should be
/// scheduled 50ms after the first dirty delta; completion also flushes buffers.
pub struct CodexRootTurnTranslator {
    turn: RootTurn,
    active: bool,
    positions: HashMap<String, (u64, String)>,
    phases: HashMap<String, String>,
    buffers: Vec<ItemState>,
    reasoning: Vec<ReasoningPart>,
    final_items: Vec<String>,
    completed_final_texts: HashSet<String>,
    interrupting: bool,
    latest_failure: Option<failure::PreviousFailure>,
    commands: HashMap<String, CommandArtifact>,
    tools: HashMap<String, ToolArtifact>,
    file_changes: HashMap<String, Value>,
    usage: std::sync::Arc<std::sync::Mutex<super::token_usage::TurnUsage>>,
}
impl CodexRootTurnTranslator {
    pub fn start(turn: RootTurn) -> (Self, NormalizedEvent) {
        Self::start_with_usage(turn, Default::default())
    }
    pub fn start_with_usage(
        turn: RootTurn,
        usage: std::sync::Arc<std::sync::Mutex<super::token_usage::TurnUsage>>,
    ) -> (Self, NormalizedEvent) {
        usage.lock().expect("usage lock poisoned").begin_turn();
        let event = NormalizedEvent::ProviderTurnUpdated {
            turn: turn.clone(),
            status: TurnStatus::Running,
            completed_at: None,
        };
        (
            Self {
                turn,
                active: true,
                positions: HashMap::new(),
                phases: HashMap::new(),
                buffers: Vec::new(),
                reasoning: Vec::new(),
                final_items: Vec::new(),
                completed_final_texts: HashSet::new(),
                interrupting: false,
                latest_failure: None,
                commands: HashMap::new(),
                tools: HashMap::new(),
                file_changes: HashMap::new(),
                usage,
            },
            event,
        )
    }
    pub fn turn(&self) -> &RootTurn {
        &self.turn
    }
    pub fn file_changes(&self, item: &str) -> Option<&Value> {
        self.file_changes.get(item)
    }
    /// Match the adapter's completed-to-interrupted mapping during Stop.
    pub fn mark_interrupting(&mut self) {
        self.interrupting = true;
    }
    fn check(&self, thread: &str, turn: &str) -> Result<(), TranslationError> {
        if self.turn.native_thread_id != thread || self.turn.native_turn_id != turn {
            return Err(TranslationError::WrongTurn);
        }
        Ok(())
    }
    fn position(&mut self, id: &str, at: &str) {
        let ordinal = self.turn.provider_turn_ordinal * 100 + self.positions.len() as u64 + 1;
        self.positions
            .entry(id.to_owned())
            .or_insert_with(|| (ordinal, at.to_owned()));
    }
    fn emit_text(
        &mut self,
        id: &str,
        text: String,
        completed: bool,
        now: &str,
        events: &mut Vec<NormalizedEvent>,
    ) {
        let is_final = self.final_items.iter().any(|item| item == id);
        if is_final {
            if completed
                && !self.completed_final_texts.is_empty()
                && (text.is_empty() || self.completed_final_texts.contains(&text))
            {
                return;
            }
            if !completed
                && (!self.completed_final_texts.is_empty()
                    || self.final_items.first().is_some_and(|first| first != id))
            {
                return;
            }
        }
        self.position(id, now);
        let (ordinal, started_at) = self.positions[id].clone();
        let artifact = AssistantArtifact {
            turn: self.turn.clone(),
            native_item_id: id.to_owned(),
            phase: self.phases.get(id).cloned(),
            text: text.clone(),
            ordinal,
            started_at,
            updated_at: now.to_owned(),
            completed,
        };
        events.push(NormalizedEvent::NodeUpdated(artifact.clone()));
        if completed {
            events.push(NormalizedEvent::MessageUpdated(artifact.clone()));
        }
        events.push(NormalizedEvent::TurnItemUpdated(artifact));
        if completed && is_final {
            self.completed_final_texts.insert(text);
        }
    }
    fn reasoning_key(&self, id: &str, stream: &str, index: usize) -> String {
        serde_json::to_string(&serde_json::json!([
            self.turn.native_turn_id,
            id,
            stream,
            index
        ]))
        .expect("reasoning key serializes")
    }
    fn register_reasoning(
        &mut self,
        id: &str,
        stream: &'static str,
        index: usize,
        now: &str,
    ) -> usize {
        let key = self.reasoning_key(id, stream, index);
        if let Some(position) = self.reasoning.iter().position(|p| p.key == key) {
            return position;
        }
        self.position(&key, now);
        self.reasoning.push(ReasoningPart {
            key,
            native_id: id.to_owned(),
            stream,
            index,
            text: String::new(),
            dirty: false,
        });
        self.reasoning.len() - 1
    }
    fn emit_reasoning(
        &mut self,
        part: &ReasoningPart,
        text: String,
        completed: bool,
        interrupted: bool,
        now: &str,
        events: &mut Vec<NormalizedEvent>,
    ) {
        if text.is_empty() {
            return;
        }
        let (ordinal, started_at) = self.positions[&part.key].clone();
        let artifact = ReasoningArtifact {
            artifact: AssistantArtifact {
                turn: self.turn.clone(),
                native_item_id: part.key.clone(),
                phase: None,
                text,
                ordinal,
                started_at,
                updated_at: now.to_owned(),
                completed,
            },
            native_reasoning_item_id: part.native_id.clone(),
            stream: part.stream.to_owned(),
            index: part.index,
            interrupted,
        };
        events.push(NormalizedEvent::ReasoningNodeUpdated(artifact.clone()));
        events.push(NormalizedEvent::ReasoningTurnItemUpdated(artifact));
    }
    pub fn flush(&mut self, now: &str) -> Vec<NormalizedEvent> {
        let updates: Vec<_> = self
            .buffers
            .iter_mut()
            .filter(|b| b.dirty)
            .map(|b| {
                b.dirty = false;
                (b.id.clone(), b.text.clone())
            })
            .collect();
        let mut events = Vec::new();
        if self.active {
            for (id, text) in updates {
                self.emit_text(&id, text, false, now, &mut events);
            }
        }
        if self.active {
            let mut parts = std::mem::take(&mut self.reasoning);
            for part in &mut parts {
                if part.dirty {
                    part.dirty = false;
                    self.emit_reasoning(part, part.text.clone(), false, false, now, &mut events);
                }
            }
            self.reasoning = parts;
        }
        events
    }
    /// `now` and converted timestamps are ISO timestamps from the caller's clock.
    /// `native_time` converts Codex epoch milliseconds, falling back to `now`.
    pub fn notification<F>(
        &mut self,
        method: &str,
        params: Value,
        now: &str,
        native_time: F,
    ) -> Result<Translation, TranslationError>
    where
        F: Fn(i64) -> String,
    {
        if !self.active {
            return Ok(match method {
                "error"
                | "turn/started"
                | "turn/completed"
                | "item/started"
                | "item/completed"
                | "item/agentMessage/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/textDelta" => Translation::Events(vec![]),
                _ => Translation::Unsupported,
            });
        }
        match method {
            "thread/tokenUsage/updated" => {
                let thread = params["threadId"].as_str().unwrap_or("");
                let turn = params["turnId"].as_str().unwrap_or("");
                if thread.is_empty() || turn.is_empty() {
                    return Ok(Translation::Unsupported);
                }
                if thread != self.turn.native_thread_id {
                    return Ok(Translation::Events(Vec::new()));
                }
                let mut usage = self.usage.lock().expect("usage lock poisoned");
                if turn != self.turn.native_turn_id {
                    return Ok(if usage.observe_baseline(&params["tokenUsage"]) {
                        Translation::Events(Vec::new())
                    } else {
                        Translation::Unsupported
                    });
                }
                if !usage.update(&params["tokenUsage"]) {
                    return Ok(Translation::Unsupported);
                }
                Ok(Translation::Events(Vec::new()))
            }
            "error" => {
                let n: ErrorNotification = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                if n.will_retry {
                    return Ok(Translation::Unsupported);
                }
                let Some(failure) = failure::from_notification(&n.error) else {
                    return Ok(Translation::Unsupported);
                };
                self.latest_failure = Some(failure);
                Ok(Translation::Events(vec![]))
            }
            "turn/started" => {
                let n: NativeTurnNotification = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn.id)?;
                Ok(Translation::Events(vec![]))
            }
            "item/agentMessage/delta" => {
                let n: Delta = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                if !n.delta.is_empty() {
                    if let Some(b) = self.buffers.iter_mut().find(|b| b.id == n.item_id) {
                        b.text.push_str(&n.delta);
                        b.dirty = true;
                    } else {
                        self.buffers.push(ItemState {
                            id: n.item_id,
                            text: n.delta,
                            dirty: true,
                        });
                    }
                }
                Ok(Translation::Events(vec![]))
            }
            "item/fileChange/outputDelta" => {
                let n: Delta = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                Ok(Translation::Events(vec![]))
            }
            "item/commandExecution/outputDelta" => {
                let n: Delta = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                if let Some(command) = self.commands.get_mut(&n.item_id) {
                    command
                        .output
                        .get_or_insert_with(String::new)
                        .push_str(&n.delta);
                    command.updated_at = now.to_owned();
                    return Ok(Translation::Events(vec![NormalizedEvent::CommandUpdated(
                        command.clone(),
                    )]));
                }
                Ok(Translation::Events(vec![]))
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let n: ReasoningDelta = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                let (stream, index) = if method == "item/reasoning/summaryTextDelta" {
                    ("summary", n.summary_index)
                } else {
                    ("content", n.content_index)
                };
                let Some(index) = index else {
                    return Ok(Translation::Unsupported);
                };
                if !n.delta.is_empty() {
                    let i = self.register_reasoning(&n.item_id, stream, index, now);
                    self.reasoning[i].text.push_str(&n.delta);
                    self.reasoning[i].dirty = true;
                }
                Ok(Translation::Events(vec![]))
            }
            "item/started" | "item/completed" => {
                let n: ItemNotification = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn_id)?;
                if n.item.kind == "subAgentActivity"
                    || (n.item.kind == "collabAgentToolCall"
                        && n.item.extra.get("tool").and_then(Value::as_str) == Some("spawnAgent"))
                {
                    self.usage
                        .lock()
                        .expect("usage lock poisoned")
                        .mark_subagent();
                }
                if n.item.kind == "subAgentActivity" || n.item.kind == "collabAgentToolCall" {
                    if n.item.kind == "collabAgentToolCall" && method != "item/completed" {
                        return Ok(Translation::Events(vec![]));
                    }
                    if n.item.kind == "subAgentActivity" {
                        if n.item
                            .extra
                            .get("agentThreadId")
                            .and_then(Value::as_str)
                            .is_none()
                            || !matches!(
                                n.item.extra.get("kind").and_then(Value::as_str),
                                Some("started" | "completed" | "interrupted")
                            )
                        {
                            return Ok(Translation::Unsupported);
                        }
                    } else if n.item.extra.get("tool").and_then(Value::as_str) != Some("spawnAgent")
                        && !n
                            .item
                            .extra
                            .get("agentsStates")
                            .is_some_and(Value::is_object)
                    {
                        return Ok(Translation::Unsupported);
                    }
                    let native_ids: Vec<String> = if n.item.kind == "subAgentActivity"
                        && n.item.extra.get("kind").and_then(Value::as_str) == Some("started")
                    {
                        vec![format!(
                            "{}:{}",
                            n.item.id,
                            n.item.extra["agentThreadId"].as_str().unwrap()
                        )]
                    } else if n.item.extra.get("tool").and_then(Value::as_str) == Some("spawnAgent")
                    {
                        n.item
                            .extra
                            .get("receiverThreadIds")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(|child| format!("{}:{}", n.item.id, child))
                            .collect()
                    } else {
                        Vec::new()
                    };
                    for id in &native_ids {
                        self.position(id, now);
                    }
                    let ordinal = native_ids.first().map(|id| self.positions[id].0).unwrap_or(
                        self.turn.provider_turn_ordinal * 100 + self.positions.len() as u64 + 1,
                    );
                    let mut item = Value::Object(n.item.extra.clone());
                    item["type"] = serde_json::json!(n.item.kind);
                    item["id"] = serde_json::json!(n.item.id);
                    return Ok(Translation::Events(vec![NormalizedEvent::NativeSubagent {
                        turn: self.turn.clone(),
                        item,
                        ordinal,
                        at: now.to_owned(),
                    }]));
                }
                if matches!(
                    n.item.kind.as_str(),
                    "fileChange" | "webSearch" | "mcpToolCall" | "dynamicToolCall"
                ) {
                    let at = n
                        .started_at_ms
                        .map(&native_time)
                        .unwrap_or_else(|| now.to_owned());
                    self.position(&n.item.id, &at);
                    let (ordinal, started_at) = self.positions[&n.item.id].clone();
                    let complete = method == "item/completed";
                    if n.item.kind == "fileChange" && !complete {
                        let mut changes = serde_json::Map::new();
                        for change in n
                            .item
                            .extra
                            .get("changes")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                        {
                            if let Some(path) = change["path"].as_str() {
                                changes.insert(path.to_owned(), change["kind"].clone());
                            }
                        }
                        self.file_changes
                            .insert(n.item.id.clone(), Value::Object(changes));
                        return Ok(Translation::Events(vec![]));
                    }
                    let e = &n.item.extra;
                    let mut fields = serde_json::Map::new();
                    let kind = match n.item.kind.as_str() {
                        "fileChange" => {
                            self.file_changes.remove(&n.item.id);
                            let changes = e
                                .get("changes")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            if changes.is_empty() {
                                return Ok(Translation::Events(vec![]));
                            }
                            fields.insert("fileName".into(), changes[0]["path"].clone());
                            fields.insert("diffStr".into(), changes[0]["diff"].clone());
                            fields.insert("changes".into(), Value::Array(changes.iter().map(|c| {
                                let op = c["kind"]["type"].clone();
                                if let Some(dest) = c["kind"]["move_path"].as_str().filter(|s| !s.is_empty()) {
                                    serde_json::json!({"operation":op,"path":dest,"oldPath":c["path"]})
                                } else { serde_json::json!({"operation":op,"path":c["path"]}) }
                            }).collect()));
                            "file_change"
                        }
                        "webSearch" => {
                            let action = e.get("action").unwrap_or(&Value::Null);
                            let mut values = Vec::new();
                            match action["type"].as_str() {
                                Some("search") => {
                                    if let Some(q) = action["queries"].as_array() {
                                        values.extend(q.iter());
                                    }
                                    values.push(&action["query"]);
                                }
                                Some("openPage") => values.push(&action["url"]),
                                Some("findInPage") => {
                                    values.push(&action["pattern"]);
                                    values.push(&action["url"]);
                                }
                                _ => {}
                            }
                            if let Some(q) = e.get("query") {
                                values.push(q);
                            }
                            let patterns: Vec<_> = values
                                .iter()
                                .filter_map(|v| v.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .collect();
                            if !patterns.is_empty() {
                                fields.insert("patterns".into(), serde_json::json!(patterns));
                            }
                            "web_search"
                        }
                        _ => {
                            let name = if n.item.kind == "mcpToolCall" {
                                format!(
                                    "{}.{}",
                                    e.get("server").and_then(Value::as_str).unwrap_or(""),
                                    e.get("tool").and_then(Value::as_str).unwrap_or("")
                                )
                            } else {
                                [e.get("namespace"), e.get("tool")]
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(".")
                            };
                            fields.insert("toolName".into(), name.into());
                            fields.insert(
                                "input".into(),
                                e.get("arguments").cloned().unwrap_or(Value::Null),
                            );
                            let output = if n.item.kind == "mcpToolCall" {
                                let result = e
                                    .get("result")
                                    .filter(|v| !v.is_null())
                                    .map(mcp_result_output);
                                if let Some(error) = e.get("error").filter(|v| !v.is_null()) {
                                    let mut out = serde_json::json!({"error":error["message"]});
                                    if let Some(result) = result {
                                        out["result"] = result;
                                    }
                                    Some(out)
                                } else {
                                    result
                                }
                            } else {
                                e.get("contentItems")
                                    .filter(|v| !v.is_null())
                                    .map(dynamic_output)
                                    .or_else(|| {
                                        (e.get("success") == Some(&Value::Bool(false)))
                                            .then(|| serde_json::json!({"success":false}))
                                    })
                            };
                            if let Some(mut output) = output {
                                if let Some(app) = e.get("_t3McpApp") {
                                    let mut result =
                                        e.get("result").cloned().unwrap_or(Value::Null);
                                    if n.item.status.as_deref() == Some("failed") {
                                        if let Some(object) = result.as_object_mut() {
                                            object
                                                .insert("isError".into(), serde_json::json!(true));
                                        }
                                    }
                                    output = serde_json::json!({"t3McpApp":app,"result":result});
                                }
                                fields.insert("output".into(), output);
                            }
                            "dynamic_tool"
                        }
                    };
                    let status = if n.item.kind == "webSearch" {
                        if complete {
                            "completed"
                        } else {
                            "running"
                        }
                    } else {
                        match n.item.status.as_deref() {
                            Some("failed") => "failed",
                            Some("declined" | "cancelled") => "cancelled",
                            Some("completed") => "completed",
                            _ if complete => "completed",
                            _ => "running",
                        }
                    };
                    let artifact = ToolArtifact {
                        turn: self.turn.clone(),
                        native_item_id: n.item.id.clone(),
                        ordinal,
                        started_at,
                        updated_at: now.into(),
                        status: status.into(),
                        kind: kind.into(),
                        fields: Value::Object(fields),
                    };
                    if complete {
                        self.tools.remove(&n.item.id);
                    } else if kind == "dynamic_tool" {
                        self.tools.insert(n.item.id, artifact.clone());
                    }
                    return Ok(Translation::Events(vec![NormalizedEvent::ToolUpdated(
                        artifact,
                    )]));
                }
                if n.item.kind == "commandExecution" {
                    let at = n
                        .started_at_ms
                        .map(&native_time)
                        .unwrap_or_else(|| now.to_owned());
                    self.position(&n.item.id, &at);
                    let (ordinal, started_at) = self.positions[&n.item.id].clone();
                    let prior = self.commands.get(&n.item.id);
                    if n.item.command.is_none() && prior.is_none() {
                        return Ok(Translation::Unsupported);
                    }
                    let complete = method == "item/completed";
                    let status = if !complete {
                        "running"
                    } else {
                        match n.item.status.as_deref() {
                            Some("failed") => "failed",
                            Some("declined" | "cancelled") => "cancelled",
                            _ => "completed",
                        }
                    };
                    let artifact = CommandArtifact {
                        turn: self.turn.clone(),
                        native_item_id: n.item.id.clone(),
                        input: n
                            .item
                            .command
                            .or_else(|| prior.map(|c| c.input.clone()))
                            .unwrap_or_default(),
                        output: n
                            .item
                            .aggregated_output
                            .or_else(|| prior.and_then(|c| c.output.clone())),
                        exit_code: n.item.exit_code,
                        ordinal,
                        started_at,
                        updated_at: now.into(),
                        status: status.into(),
                    };
                    if complete {
                        self.commands.remove(&n.item.id);
                    } else {
                        self.commands.insert(n.item.id, artifact.clone());
                    }
                    return Ok(Translation::Events(vec![NormalizedEvent::CommandUpdated(
                        artifact,
                    )]));
                }
                if n.item.kind == "reasoning" {
                    if method == "item/started" {
                        return Ok(Translation::Events(vec![]));
                    }
                    for (stream, values) in
                        [("summary", &n.item.summary), ("content", &n.item.content)]
                    {
                        for index in 0..values.as_ref().map_or(0, Vec::len) {
                            self.register_reasoning(&n.item.id, stream, index, now);
                        }
                    }
                    let mut events = Vec::new();
                    let mut retained = Vec::new();
                    for part in std::mem::take(&mut self.reasoning) {
                        if part.native_id != n.item.id {
                            retained.push(part);
                            continue;
                        }
                        let values = if part.stream == "summary" {
                            &n.item.summary
                        } else {
                            &n.item.content
                        };
                        let text = values
                            .as_ref()
                            .and_then(|v| v.get(part.index))
                            .filter(|s| !s.is_empty())
                            .cloned()
                            .unwrap_or_else(|| part.text.clone());
                        self.emit_reasoning(&part, text, true, false, now, &mut events);
                    }
                    self.reasoning = retained;
                    return Ok(Translation::Events(events));
                }
                if n.item.kind != "agentMessage"
                    || (n.item.delivery.as_deref() == Some("async")
                        && n.item.questions.as_ref().is_some_and(|q| !q.is_empty()))
                {
                    return Ok(Translation::Unsupported);
                }
                if method == "item/completed" && n.item.text.is_none() {
                    return Ok(Translation::Unsupported);
                }
                if let Some(phase) = n.item.phase.as_ref() {
                    self.phases.insert(n.item.id.clone(), phase.clone());
                }
                let final_answer = n
                    .item
                    .phase
                    .as_deref()
                    .is_none_or(|phase| phase == "final_answer");
                if final_answer && !self.final_items.contains(&n.item.id) {
                    self.final_items.push(n.item.id.clone());
                }
                if method == "item/started" {
                    let at = n
                        .started_at_ms
                        .map(native_time)
                        .unwrap_or_else(|| now.to_owned());
                    self.position(&n.item.id, &at);
                    return Ok(Translation::Events(vec![]));
                }
                let Some(text) = n.item.text else {
                    return Ok(Translation::Unsupported);
                };
                self.buffers.retain(|b| b.id != n.item.id);
                let mut events = Vec::new();
                self.emit_text(&n.item.id, text, true, now, &mut events);
                self.final_items.retain(|id| id != &n.item.id);
                Ok(Translation::Events(events))
            }
            "turn/completed" => {
                let n: NativeTurnNotification = serde_json::from_value(params)?;
                self.check(&n.thread_id, &n.turn.id)?;
                let status = match n.turn.status.as_deref() {
                    Some("completed") if self.interrupting => TurnStatus::Interrupted,
                    Some("completed") => TurnStatus::Completed,
                    Some("interrupted") => TurnStatus::Interrupted,
                    Some("failed") => {
                        // Capacity failures can restart the turn and require the retry handler.
                        let info = n.turn.error.as_ref().and_then(|e| e.get("codexErrorInfo"));
                        let code = failure::failure_code(info).or_else(|| {
                            self.latest_failure
                                .as_ref()
                                .and_then(|f| f.native_code.clone())
                        });
                        if code.as_deref() == Some("serverOverloaded") {
                            return Ok(Translation::Unsupported);
                        }
                        TurnStatus::Failed
                    }
                    _ => return Ok(Translation::Unsupported),
                };
                let pending = std::mem::take(&mut self.buffers);
                let mut events = Vec::new();
                if status != TurnStatus::Completed {
                    for (_, mut tool) in std::mem::take(&mut self.tools) {
                        tool.status = if status == TurnStatus::Interrupted {
                            "interrupted"
                        } else {
                            "failed"
                        }
                        .into();
                        tool.updated_at = now.into();
                        events.push(NormalizedEvent::ToolUpdated(tool));
                    }
                    for (_, mut command) in std::mem::take(&mut self.commands) {
                        command.status = if status == TurnStatus::Interrupted {
                            "interrupted"
                        } else {
                            "failed"
                        }
                        .into();
                        command.updated_at = now.into();
                        events.push(NormalizedEvent::CommandUpdated(command));
                    }
                }
                for b in pending {
                    self.emit_text(&b.id, b.text, true, now, &mut events);
                }
                for part in std::mem::take(&mut self.reasoning) {
                    self.emit_reasoning(
                        &part,
                        part.text.clone(),
                        true,
                        status != TurnStatus::Completed,
                        now,
                        &mut events,
                    );
                }
                let completed_at = n
                    .turn
                    .completed_at
                    .map(|seconds| native_time((seconds * 1000.0) as i64))
                    .unwrap_or_else(|| now.to_owned());
                events.push(NormalizedEvent::ProviderTurnUpdated {
                    turn: self.turn.clone(),
                    status,
                    completed_at: Some(completed_at),
                });
                let failure = (status == TurnStatus::Failed).then(|| {
                    failure::from_completion(n.turn.error.as_ref(), self.latest_failure.as_ref())
                });
                let failure_item_ordinal = if failure.is_some() {
                    let key = format!("terminal-failure:{}", self.turn.provider_turn_id);
                    self.position(&key, now);
                    Some(self.positions[&key].0)
                } else {
                    None
                };
                let usage = self.usage.lock().expect("usage lock poisoned");
                events.push(NormalizedEvent::TokenUsageUpdated {
                    turn: self.turn.clone(),
                    usage: usage.finish(status == TurnStatus::Completed),
                    at: now.to_owned(),
                });
                drop(usage);
                events.push(NormalizedEvent::TurnTerminal {
                    turn: self.turn.clone(),
                    status,
                    failure,
                    failure_item_ordinal,
                    thread_disposition: ThreadDisposition::Reusable,
                });
                self.active = false;
                Ok(Translation::Events(events))
            }
            _ => Ok(Translation::Unsupported),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interrupted_turn_without_usage_reports_unavailable() {
        let (mut translator, _) = CodexRootTurnTranslator::start(root());
        let events = notify(
            &mut translator,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"interrupted"}}),
        );
        assert!(events.iter().any(|event| matches!(event, NormalizedEvent::TokenUsageUpdated { usage, .. } if *usage == json!({"usageStatus":"unavailable","usageScope":"main_agent","hasSubagents":false}))));
    }

    #[test]
    fn late_usage_updates_baseline_and_subagent_marker_is_retained() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(
            super::super::token_usage::TurnUsage::default(),
        ));
        let (mut t, _) = CodexRootTurnTranslator::start_with_usage(root(), state);
        let count = |n| json!({"inputTokens":n,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0});
        assert!(notify(&mut t, "thread/tokenUsage/updated", json!({"threadId":"t","turnId":"old","tokenUsage":{"total":count(100),"last":count(100)}})).is_empty());
        assert!(notify(
            &mut t,
            "thread/tokenUsage/updated",
            json!({"threadId":"t","turnId":"u","tokenUsage":{"total":count(107),"last":count(90)}})
        )
        .is_empty());
        assert!(matches!(
            t.notification(
                "item/started",
                json!({"threadId":"t","turnId":"u","item":{"type":"subAgentActivity","id":"sub"}}),
                "now",
                |_| "now".into()
            )
            .unwrap(),
            Translation::Unsupported
        ));
        let events = notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"completed"}}),
        );
        assert!(events.iter().any(|event| matches!(event, NormalizedEvent::TokenUsageUpdated { usage, .. } if usage["inputTokens"] == 7 && usage["hasSubagents"] == true)));
    }

    #[test]
    fn normalizes_mcp_and_dynamic_image_outputs() {
        let result =
            json!({"content":[{"type":"text","text":"ok"}],"structuredContent":{"answer":1}});
        assert_eq!(mcp_result_output(&result), json!({"answer":1}));
        let result = json!({"content":[{"type":"image","mimeType":"image/png","data":"AAAA"}],"structuredContent":{"answer":1}});
        assert_eq!(mcp_result_output(&result), result);
        assert_eq!(
            dynamic_output(
                &json!([{"type":"inputImage","imageUrl":"data:image/PNG;base64,AAAA"},{"type":"inputImage","imageUrl":"https://x"}])
            ),
            json!([{"type":"image","mimeType":"image/png","data":"AAAA"},{"type":"inputImage","imageUrl":"https://x"}])
        );
    }

    #[test]
    fn tools_and_file_changes_project_real_notification_shapes() {
        let (mut t, _) = CodexRootTurnTranslator::start(root());
        let started = json!({"threadId":"t","turnId":"u","item":{"type":"fileChange","id":"f","status":"inProgress","changes":[{"path":"a","kind":{"type":"update","move_path":"b"},"diff":"patch"}]}});
        assert!(notify(&mut t, "item/started", started.clone()).is_empty());
        let done = notify(&mut t, "item/completed", started);
        assert!(
            matches!(&done[..], [NormalizedEvent::ToolUpdated(a)] if a.kind == "file_change" && a.fields["fileName"] == "a" && a.fields["changes"][0]["oldPath"] == "a" && a.fields["changes"][0]["path"] == "b")
        );
        let search = notify(
            &mut t,
            "item/started",
            json!({"threadId":"t","turnId":"u","item":{"type":"webSearch","id":"w","query":" q ","action":{"type":"search","queries":["one","two"],"query":"one"}}}),
        );
        assert!(
            matches!(&search[..], [NormalizedEvent::ToolUpdated(a)] if a.status == "running" && a.fields["patterns"] == json!(["one","two","one","q"]))
        );
        let tool = notify(
            &mut t,
            "item/started",
            json!({"threadId":"t","turnId":"u","item":{"type":"mcpToolCall","id":"m","server":"weather","tool":"get","status":"inProgress","arguments":{"city":"Oslo"}}}),
        );
        assert!(
            matches!(&tool[..], [NormalizedEvent::ToolUpdated(a)] if a.fields["toolName"] == "weather.get" && a.fields["input"]["city"] == "Oslo")
        );
        let interrupted = notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"interrupted"}}),
        );
        assert!(interrupted
            .iter()
            .any(|e| matches!(e, NormalizedEvent::ToolUpdated(a) if a.status == "interrupted")));
    }

    #[test]
    fn command_output_and_interruption_are_preserved() {
        let (mut translator, _) = CodexRootTurnTranslator::start(root());
        let start = notify(
            &mut translator,
            "item/started",
            json!({"threadId":"t","turnId":"u","item":{"type":"commandExecution","id":"cmd","command":"sleep 30","status":"inProgress"}}),
        );
        assert!(
            matches!(&start[..], [NormalizedEvent::CommandUpdated(a)] if a.status=="running" && a.input=="sleep 30")
        );
        let delta = notify(
            &mut translator,
            "item/commandExecution/outputDelta",
            json!({"threadId":"t","turnId":"u","itemId":"cmd","delta":"hello"}),
        );
        assert!(
            matches!(&delta[..], [NormalizedEvent::CommandUpdated(a)] if a.output.as_deref()==Some("hello"))
        );
        let done = notify(
            &mut translator,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"interrupted"}}),
        );
        assert!(done.iter().any(|e| matches!(e, NormalizedEvent::CommandUpdated(a) if a.status=="interrupted" && a.output.as_deref()==Some("hello"))));
    }

    fn root() -> RootTurn {
        RootTurn {
            driver: "codex".into(),
            native_thread_id: "t".into(),
            native_turn_id: "u".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "pu".into(),
            thread_id: "app".into(),
            run_id: Some("r".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "started".into(),
        }
    }
    fn notify(
        t: &mut CodexRootTurnTranslator,
        method: &str,
        params: Value,
    ) -> Vec<NormalizedEvent> {
        match t
            .notification(method, params, "now", |ms| format!("ms:{ms}"))
            .unwrap()
        {
            Translation::Events(events) => events,
            Translation::Unsupported => panic!("unexpected unsupported"),
        }
    }
    fn item(method: &str, id: &str, text: &str, phase: &str) -> (&'static str, Value) {
        (
            if method == "start" {
                "item/started"
            } else {
                "item/completed"
            },
            json!({"threadId":"t","turnId":"u","startedAtMs":100,"item":{"type":"agentMessage","id":id,"phase":phase,"text":text}}),
        )
    }
    #[test]
    fn text_coalesces_and_completes_before_terminal() {
        let (mut t, start) = CodexRootTurnTranslator::start(root());
        assert!(matches!(
            start,
            NormalizedEvent::ProviderTurnUpdated {
                status: TurnStatus::Running,
                ..
            }
        ));
        let (m, p) = item("start", "m1", "", "final_answer");
        assert!(notify(&mut t, m, p).is_empty());
        for delta in ["Hel", "lo"] {
            assert!(notify(
                &mut t,
                "item/agentMessage/delta",
                json!({"threadId":"t","turnId":"u","itemId":"m1","delta":delta})
            )
            .is_empty());
        }
        let stream = t.flush("flush");
        assert!(
            matches!(&stream[..], [NormalizedEvent::NodeUpdated(a), NormalizedEvent::TurnItemUpdated(b)] if a.text == "Hello" && !a.completed && a == b && a.started_at == "ms:100" && a.ordinal == 101)
        );
        assert!(t.flush("flush").is_empty());
        let (m, p) = item("done", "m1", "Hello!", "final_answer");
        let done = notify(&mut t, m, p);
        assert!(
            matches!(&done[..], [NormalizedEvent::NodeUpdated(a), NormalizedEvent::MessageUpdated(b), NormalizedEvent::TurnItemUpdated(c)] if a.text == "Hello!" && a.completed && a == b && b == c)
        );
        let terminal = notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"completed","completedAt":123}}),
        );
        assert!(
            matches!(&terminal[..], [NormalizedEvent::ProviderTurnUpdated { status: TurnStatus::Completed, completed_at: Some(at), .. }, NormalizedEvent::TokenUsageUpdated { usage, .. }, NormalizedEvent::TurnTerminal { status: TurnStatus::Completed, .. }] if at == "ms:123000" && usage == &json!({"usageStatus":"unavailable","usageScope":"main_agent","hasSubagents":false}))
        );
        assert!(notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"completed"}})
        )
        .is_empty());
    }
    #[test]
    fn final_deduplication_preserves_partial_and_flushes_interrupted_turn() {
        let (mut t, _) = CodexRootTurnTranslator::start(root());
        for (id, phase) in [
            ("partial", "partial_answer"),
            ("final", "final_answer"),
            ("duplicate", "final_answer"),
        ] {
            let (m, p) = item("done", id, "answer", phase);
            let events = notify(&mut t, m, p);
            assert_eq!(events.len(), if id == "duplicate" { 0 } else { 3 });
        }
        let (m, p) = item("start", "pending", "", "commentary");
        notify(&mut t, m, p);
        notify(
            &mut t,
            "item/agentMessage/delta",
            json!({"threadId":"t","turnId":"u","itemId":"pending","delta":"unfinished"}),
        );
        t.mark_interrupting();
        let events = notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"completed"}}),
        );
        assert!(
            matches!(&events[..], [NormalizedEvent::NodeUpdated(a), NormalizedEvent::MessageUpdated(_), NormalizedEvent::TurnItemUpdated(_), NormalizedEvent::ProviderTurnUpdated {status:TurnStatus::Interrupted,..}, NormalizedEvent::TokenUsageUpdated { usage, .. }, NormalizedEvent::TurnTerminal {status:TurnStatus::Interrupted,..}] if a.text == "unfinished" && a.completed && usage == &json!({"usageStatus":"unavailable","usageScope":"main_agent","hasSubagents":false}))
        );
    }
    #[test]
    fn reasoning_parts_stream_and_complete_without_messages() {
        let (mut t, _) = CodexRootTurnTranslator::start(root());
        for (method, index, delta) in [
            (
                "item/reasoning/summaryTextDelta",
                "summaryIndex",
                "Thinking",
            ),
            ("item/reasoning/textDelta", "contentIndex", "Raw"),
        ] {
            let mut params = json!({"threadId":"t","turnId":"u","itemId":"rs","delta":delta});
            params[index] = json!(0);
            assert!(notify(&mut t, method, params).is_empty());
        }
        let updates = t.flush("flush");
        assert!(
            matches!(&updates[..], [NormalizedEvent::ReasoningNodeUpdated(a), NormalizedEvent::ReasoningTurnItemUpdated(_), NormalizedEvent::ReasoningNodeUpdated(b), NormalizedEvent::ReasoningTurnItemUpdated(_)] if a.artifact.ordinal == 101 && a.stream == "summary" && b.artifact.ordinal == 102 && b.stream == "content")
        );
        let done = notify(
            &mut t,
            "item/completed",
            json!({"threadId":"t","turnId":"u","item":{"type":"reasoning","id":"rs","summary":["Thought"],"content":[""]}}),
        );
        assert!(
            matches!(&done[..], [NormalizedEvent::ReasoningNodeUpdated(a), NormalizedEvent::ReasoningTurnItemUpdated(_), NormalizedEvent::ReasoningNodeUpdated(b), NormalizedEvent::ReasoningTurnItemUpdated(_)] if a.artifact.text == "Thought" && b.artifact.text == "Raw" && a.artifact.completed && a.native_reasoning_item_id == "rs")
        );
    }

    #[test]
    fn unsupported_events_and_wrong_turn_are_explicit() {
        let (mut t, _) = CodexRootTurnTranslator::start(root());
        assert_eq!(
            t.notification(
                "item/completed",
                json!({"threadId":"t","turnId":"u","item":{"id":"tool","type":"commandExecution"}}),
                "now",
                |_| "now".into()
            )
            .unwrap(),
            Translation::Unsupported
        );
        assert_eq!(
            t.notification(
                "turn/completed",
                json!({"threadId":"t","turn":{"id":"u","status":"failed","error":{"message":"busy","codexErrorInfo":"serverOverloaded"}}}),
                "now",
                |_| "now".into()
            )
            .unwrap(),
            Translation::Unsupported
        );
        assert!(matches!(
            t.notification(
                "item/agentMessage/delta",
                json!({"threadId":"other","turnId":"u","itemId":"i","delta":"x"}),
                "now",
                |_| "now".into()
            ),
            Err(TranslationError::WrongTurn)
        ));
    }

    fn failed(notification: Option<Value>, error: Option<Value>) -> ProviderFailure {
        let (mut t, _) = CodexRootTurnTranslator::start(root());
        if let Some(error) = notification {
            assert!(notify(
                &mut t,
                "error",
                json!({"threadId":"t","turnId":"u","willRetry":false,"error":error})
            )
            .is_empty());
        }
        let events = notify(
            &mut t,
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"failed","error":error}}),
        );
        match &events[..] {
            [NormalizedEvent::ProviderTurnUpdated {
                status: TurnStatus::Failed,
                ..
            }, NormalizedEvent::TokenUsageUpdated { usage, .. }, NormalizedEvent::TurnTerminal {
                status: TurnStatus::Failed,
                failure: Some(f),
                failure_item_ordinal: Some(101),
                ..
            }] if usage
                == &json!({"usageStatus":"unavailable","usageScope":"main_agent","hasSubagents":false}) =>
            {
                f.clone()
            }
            _ => panic!("unexpected terminal: {events:?}"),
        }
    }

    #[test]
    fn failed_turn_classification_uses_completion_and_notification_evidence() {
        let notification = json!({"message":"Provider stopped this request.","additionalDetails":"Detailed notification evidence.","codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":429}}});
        let completion = |http_status: Value| json!({"message":"Provider stopped this request.","codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":http_status}}});
        let f = failed(Some(notification.clone()), Some(completion(Value::Null)));
        assert_eq!(f.class, FailureClass::UsageLimit);
        assert_eq!(f.message, "Detailed notification evidence.");
        assert_eq!(f.code.as_deref(), Some("responseTooManyFailedAttempts"));
        let f = failed(Some(notification), Some(completion(json!(500))));
        assert_eq!(f.class, FailureClass::ProviderError);
        assert_eq!(f.message, "Provider stopped this request.");
        let f = failed(None, Some(completion(json!(429))));
        assert_eq!(f.class, FailureClass::UsageLimit);
        let old = json!({"message":"Provider stopped this request.","additionalDetails":"Detailed notification evidence.","codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":500}}});
        let f = failed(Some(old), Some(completion(json!(429.0))));
        assert_eq!(f.class, FailureClass::UsageLimit);
        assert_eq!(f.message, "Provider stopped this request.");
        let f = failed(
            Some(json!({"message":"Old failure","codexErrorInfo":"usageLimitExceeded"})),
            Some(json!({"message":"New failure"})),
        );
        assert_eq!(f.class, FailureClass::ProviderError);
        assert_eq!(f.message, "New failure");
        let f = failed(
            None,
            Some(json!({"message":"Unlisted model","codexErrorInfo":"modelNotFound"})),
        );
        assert_eq!(f.code.as_deref(), Some("modelNotFound"));
        assert_eq!(failed(None, None).message, "Provider turn failed.");
    }
    #[test]
    fn managed_failures_are_curated_and_ordinary_secrets_redacted() {
        let f = failed(
            Some(
                json!({"message":"Provider stopped", "additionalDetails":"subscription_sharing_workplace_individual_usage_limit_exceeded", "codexErrorInfo":"other"}),
            ),
            Some(json!({"message":"Provider stopped"})),
        );
        assert_eq!(f.class, FailureClass::UsageLimit);
        assert!(f.managed_usage_limit);
        assert_eq!(
            f.code.as_deref(),
            Some("subscription_sharing_workplace_individual_usage_limit_exceeded")
        );
        assert!(f.message.contains("workspace admin"));
        let mention =
            "Transport unavailable; this is not subscription_sharing_usage_limit_exceeded.";
        let f = failed(None, Some(json!({"message":mention})));
        assert_eq!(f.class, FailureClass::ProviderError);
        assert_eq!(f.message, mention);
        let f = failed(
            None,
            Some(
                json!({"message":"Bearer super-secret https://u:p@example.com/a?token=secret#x password=hello"}),
            ),
        );
        assert_eq!(
            f.message,
            "Bearer [REDACTED] https://example.com/a password=[REDACTED]"
        );
        let f = failed(None, Some(json!({"message":"x".repeat(4100)})));
        assert_eq!(f.message.encode_utf16().count(), 4096);
        assert!(f.message.ends_with('…'));
    }
}
