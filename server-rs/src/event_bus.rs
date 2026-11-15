//! Ordered transactional publication with paged replay for V2 thread events.
//!
//! All writes for an event log must go through the same `EventBus`. The write
//! closure may update projections and outbox rows inside the same transaction;
//! only events returned from a successfully committed closure are published.
use crate::event_store::{self, EventFilter, StoredEvent};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::{
    fmt,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

const PAGE_SIZE: i64 = 256;
struct Inner {
    db: Mutex<Connection>,
    command_output: crate::command_output::CommandOutput,
    worktrees_dir: Mutex<Option<std::path::PathBuf>>,
    worktree_preparation: Mutex<()>,
    secrets_dir: Mutex<Option<std::path::PathBuf>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    setup_context: Mutex<
        Option<(
            Arc<crate::terminal::TerminalManager>,
            Arc<crate::settings::Settings>,
        )>,
    >,
    events: broadcast::Sender<StoredEvent>,
    application_events: broadcast::Sender<StoredEvent>,
    signals: Mutex<Option<Arc<crate::effect_worker::Signals>>>,
}
#[derive(Clone)]
pub struct EventBus {
    inner: Arc<Inner>,
}

#[derive(Debug)]
pub enum BusError {
    Database(rusqlite::Error),
    Poisoned,
    Lagged(u64),
    Closed,
    InvalidSequence,
}
impl fmt::Display for BusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(e) => write!(f, "{e}"),
            Self::Poisoned => write!(f, "event bus lock poisoned"),
            Self::Lagged(n) => write!(f, "subscriber lagged by {n} events"),
            Self::Closed => write!(f, "event bus closed"),
            Self::InvalidSequence => write!(f, "publication has invalid sequence order"),
        }
    }
}
impl std::error::Error for BusError {}
impl From<rusqlite::Error> for BusError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Filter {
    pub thread_id: Option<String>,
    pub event_type: Option<String>,
}
impl Filter {
    fn matches(&self, event: &StoredEvent) -> bool {
        event.event.aggregate_kind == "thread"
            && self
                .thread_id
                .as_ref()
                .is_none_or(|id| id == &event.event.stream_id)
            && self
                .event_type
                .as_ref()
                .is_none_or(|kind| kind == &event.event.event_type)
    }
}
fn hydrate_thread_shell(db: &Connection, payload_json: &str) -> rusqlite::Result<serde_json::Value> {
    use serde_json::{json, Value};
    let mut thread: Value = serde_json::from_str(payload_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    if let Some(o) = thread.as_object_mut() {
        let defaults = json!({"latestRunId":null,"latestRunRequestedAt":null,"latestRunStartedAt":null,"latestRunCompletedAt":null,"latestRunStopRequested":false,"latestRunBackgroundWake":false,"activeRunId":null,"activityRunStartedAt":null,"activityRunStatus":null,"blockedOnThreadWait":false,"status":"idle","lastError":null,"lastErrorClass":null,"lastErrorCode":null,"usageLimitResetAt":null,"pendingRuntimeRequest":null,"pendingGuestMessageCount":0,"latestVisibleMessage":null,"latestUserMessageAt":null,"latestUserAuthoredMessageAt":null,"hasActionableProposedPlan":false,"pendingBackgroundTasks":[],"providerInstanceHistory":[],"goal":null,"itemCount":0,"visibleItemCount":0,"unsettledAt":null,"pinnedAt":null,"autoSettleDisabledAt":null,"pinOrderKey":null,"opens":null,"titleRegeneration":null,"lastTitleRegeneration":null,"limitRecovery":null});
        for (k, v) in defaults.as_object().unwrap() {
            o.entry(k.clone()).or_insert(v.clone());
        }
    }
    enrich_shell(db, &mut thread)?;
    Ok(thread)
}

fn is_listed_thread_lineage(thread: &serde_json::Value) -> bool {
    thread["lineage"]["relationshipToParent"].as_str() != Some("subagent")
        && thread["lineage"]["sideChat"].as_bool() != Some(true)
}

fn is_live_subagent_shell(thread: &serde_json::Value) -> bool {
    !thread["activityRunStatus"].is_null()
        || matches!(
            thread["status"].as_str(),
            Some("queued" | "preparing" | "starting" | "running" | "waiting")
        )
        || !thread["pendingRuntimeRequest"].is_null()
        || thread["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| !tasks.is_empty())
}

fn parse_iso_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn is_older_settled_thread_shell(thread: &serde_json::Value, before_ms: i64) -> bool {
    is_listed_thread_lineage(thread)
        && thread["settledOverride"].as_str() == Some("settled")
        && thread["settledAt"]
            .as_str()
            .and_then(parse_iso_millis)
            .is_some_and(|ms| ms < before_ms)
}

pub fn trim_shell_snapshot(
    snapshot: &mut serde_json::Value,
    omit_idle_subagents: bool,
    omit_older_settled: bool,
) {
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, HashSet};
    const NEWEST_SETTLED_KEPT: usize = 25;

    let Some(threads) = snapshot
        .get_mut("threads")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
    else {
        return;
    };
    let mut subagent_parent_ids = HashSet::<String>::new();
    let mut settled_times = Vec::<i64>::new();
    for thread in &threads {
        if thread["lineage"]["relationshipToParent"].as_str() == Some("subagent") {
            if let Some(parent_id) = thread["lineage"]["parentThreadId"].as_str() {
                subagent_parent_ids.insert(parent_id.to_owned());
            }
        } else if is_listed_thread_lineage(thread)
            && thread["settledOverride"].as_str() == Some("settled")
        {
            if let Some(ms) = thread["settledAt"].as_str().and_then(parse_iso_millis) {
                settled_times.push(ms);
            }
        }
    }
    settled_times.sort_by(|left, right| right.cmp(left));
    let older_settled_before_ms = settled_times
        .get(NEWEST_SETTLED_KEPT - 1)
        .or_else(|| settled_times.last())
        .copied();
    let mut counts = BTreeMap::<String, usize>::new();
    if let Some(before_ms) = older_settled_before_ms {
        for thread in &threads {
            if is_older_settled_thread_shell(thread, before_ms) {
                if let Some(project_id) = thread["projectId"].as_str() {
                    *counts.entry(project_id.to_owned()).or_insert(0) += 1;
                }
            }
        }
    }

    let mut filtered = if omit_idle_subagents {
        threads
            .into_iter()
            .filter(|thread| {
                let id = thread["id"].as_str().unwrap_or_default();
                thread["lineage"]["relationshipToParent"].as_str() != Some("subagent")
                    || is_live_subagent_shell(thread)
                    || subagent_parent_ids.contains(id)
            })
            .collect::<Vec<_>>()
    } else {
        threads
    };

    if omit_older_settled {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let before_ms = older_settled_before_ms.unwrap_or(now_ms);
        let mut ancestor_ids = HashSet::<String>::new();
        for thread in &filtered {
            if is_listed_thread_lineage(thread) {
                continue;
            }
            if let Some(parent_id) = thread["lineage"]["parentThreadId"].as_str() {
                ancestor_ids.insert(parent_id.to_owned());
            }
            if let Some(root_id) = thread["lineage"]["rootThreadId"].as_str() {
                ancestor_ids.insert(root_id.to_owned());
            }
        }
        filtered.retain(|thread| {
            let id = thread["id"].as_str().unwrap_or_default();
            !is_older_settled_thread_shell(thread, before_ms)
                || !thread["pinnedAt"].is_null()
                || thread["snoozedUntil"]
                    .as_str()
                    .and_then(parse_iso_millis)
                    .is_some_and(|ms| ms > now_ms)
                || is_live_subagent_shell(thread)
                || ancestor_ids.contains(id)
        });
        let before_iso = chrono::DateTime::from_timestamp_millis(before_ms)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let counts_json = counts
            .into_iter()
            .map(|(project_id, count)| json!({ "projectId": project_id, "count": count }))
            .collect::<Vec<_>>();
        snapshot["olderSettled"] = json!({
            "before": before_iso,
            "asOfSequence": snapshot["snapshotSequence"],
            "counts": counts_json,
        });
    }
    snapshot["threads"] = Value::Array(filtered);
}

pub fn project_identities_digest(projects: &[serde_json::Value]) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for project in projects {
        let pair = serde_json::json!([
            project.get("id").cloned().unwrap_or(serde_json::Value::Null),
            project
                .get("repositoryIdentity")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ]);
        hasher.update(pair.to_string().as_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

pub(crate) fn enrich_shell(
    db: &Connection,
    thread: &mut serde_json::Value,
) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;
    use serde_json::{json, Value};
    let id = thread["id"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let read_values = |sql: &str| -> rusqlite::Result<Vec<Value>> {
        let mut stmt = db.prepare(sql)?;
        let rows = stmt.query_map([&id], |r| r.get::<_, String>(0))?;
        rows.map(|r| {
            serde_json::from_str(&r?).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .collect()
    };
    let runs = read_values("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal")?;
    let items = read_values("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 ORDER BY ordinal,turn_item_id")?;
    let messages = read_values("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 ORDER BY updated_at DESC,message_id DESC")?;
    let providers = read_values("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 ORDER BY json_extract(payload_json,'$.createdAt'),provider_thread_id")?;
    thread["pendingBackgroundTasks"] = serde_json::json!(crate::background_work::derive(
        thread, &runs, &providers, &items
    ));
    let latest = runs
        .iter()
        .rev()
        .find(|r| !(r["status"] == "queued" && r["queueHeld"] == true));
    let active = runs.iter().rev().find(|r| {
        matches!(
            r["status"].as_str(),
            Some("preparing" | "starting" | "running")
        )
    });
    let blocked_on_wait = active.is_some_and(|run| {
        if run["status"] != "running" {
            return false;
        }
        let mut found = false;
        for item in &items {
            if item["runId"] != run["id"]
                || !matches!(item["status"].as_str(), Some("running" | "waiting"))
                || !matches!(
                    item["type"].as_str(),
                    Some(
                        "command_execution"
                            | "dynamic_tool"
                            | "subagent"
                            | "file_change"
                            | "file_search"
                            | "web_search"
                            | "compaction"
                    )
                )
                || (item["type"] == "subagent" && item["origin"] == "app_owned")
            {
                continue;
            }
            if item["type"] != "dynamic_tool" {
                return false;
            }
            let name = item["toolName"].as_str().unwrap_or("");
            let known = |tool: &str| {
                name == tool
                    || ["mcp__t3_code__", "mcp_t3_code_", "t3-code-", "t3_code__"]
                        .iter()
                        .any(|prefix| name.strip_prefix(prefix) == Some(tool))
                    || (name.starts_with("t3-code-") && name.ends_with(&format!("_{tool}")))
            };
            if !(known("t3_thread_wait")
                || known("delegate_task") && item["input"]["mode"] == "wait")
            {
                return false;
            }
            found = true;
        }
        found
    });
    thread["blockedOnThreadWait"] = json!(blocked_on_wait);
    let activity = runs.iter().rev().find(|r| {
        matches!(
            r["status"].as_str(),
            Some("preparing" | "starting" | "running" | "waiting")
        )
    });
    if let Some(run) = latest {
        for (target, source) in [
            ("latestRunId", "id"),
            ("latestRunRequestedAt", "requestedAt"),
            ("latestRunStartedAt", "startedAt"),
            ("latestRunCompletedAt", "completedAt"),
            ("status", "status"),
        ] {
            thread[target] = run.get(source).cloned().unwrap_or(Value::Null);
        }
        thread["latestRunStopRequested"] = json!(items
            .iter()
            .any(|i| i["runId"] == run["id"] && i["type"] == "run_interrupt_request"));
    }
    if let Some(run) = active {
        thread["activeRunId"] = run["id"].clone();
    }
    if let Some(run) = activity {
        thread["activityRunStatus"] = run["status"].clone();
        thread["activityRunStartedAt"] = ["workStartedAt", "startedAt", "requestedAt"]
            .iter()
            .find_map(|k| run.get(*k).filter(|v| !v.is_null()).cloned())
            .unwrap_or(Value::Null);
    }
    let mut user = messages.iter().filter(|m| {
        m["role"] == "user"
            && (m["idleCompaction"].is_null()
                || !m["text"]
                    .as_str()
                    .is_some_and(|s| s.trim().eq_ignore_ascii_case("/compact")))
    });
    thread["latestUserMessageAt"] = user
        .clone()
        .next()
        .map_or(Value::Null, |m| m["updatedAt"].clone());
    thread["latestUserAuthoredMessageAt"] = user
        .find(|m| m["createdBy"] == "user")
        .map_or(Value::Null, |m| m["updatedAt"].clone());
    let mut history = Vec::<String>::new();
    for p in &providers {
        if p["ownerNodeId"].is_null() {
            if let Some(instance) = p["providerInstanceId"].as_str() {
                if !history.iter().any(|s| s == instance) {
                    history.push(instance.to_owned());
                }
            }
        }
    }
    thread["providerInstanceHistory"] = json!(history);
    if let Some(p) = providers.iter().find(|p| {
        !thread["activeProviderThreadId"].is_null() && p["id"] == thread["activeProviderThreadId"]
    }) {
        thread["goal"] = p.get("goal").cloned().unwrap_or(Value::Null);
    }
    let count = items
        .iter()
        .filter(|item| {
            let run = runs
                .iter()
                .find(|r| !item["runId"].is_null() && r["id"] == item["runId"]);
            !run.is_some_and(|r| {
                r["status"] == "rolled_back"
                    || (item["type"] == "user_message"
                        && item["inputIntent"] == "queued_turn"
                        && matches!(r["status"].as_str(), Some("queued" | "cancelled")))
            })
        })
        .count();
    thread["itemCount"] = json!(count);
    thread["visibleItemCount"] = json!(count);
    let request: Option<String> = db.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' ORDER BY (json_extract(payload_json,'$.kind')='user_input'),created_at DESC LIMIT 1", [&id], |r| r.get(0)).optional()?;
    if let Some(request) = request {
        let request: Value = serde_json::from_str(&request).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
        thread["pendingRuntimeRequest"] = json!({"id":request["id"],"kind":request["kind"],"createdAt":request["createdAt"],"blocking":request["responseCapability"]["type"] != "message"});
    }
    Ok(())
}
/// Collapse replaceable streaming updates while preserving barriers and sequence order.
pub(crate) fn coalesce_thread_events(events: Vec<StoredEvent>) -> Vec<StoredEvent> {
    use std::collections::HashMap;
    let mut latest = HashMap::<String, usize>::new();
    let mut families = HashMap::<String, String>::new();
    let mut superseded = vec![false; events.len()];
    for (index, stored) in events.iter().enumerate() {
        let event = &stored.event;
        let p = &event.payload;
        let kind = event.event_type.as_str();
        let replaceable = match kind {
            "message.updated" => p["role"] == "assistant" && p["streaming"] == true,
            "turn-item.updated" if p["status"] == "running" => match p["type"].as_str() {
                Some("assistant_message" | "reasoning") => p["streaming"] == true,
                Some(
                    "command_execution" | "file_change" | "file_search" | "web_search"
                    | "dynamic_tool",
                ) => true,
                _ => false,
            },
            _ => false,
        };
        let Some(id) = p["id"].as_str().filter(|_| replaceable) else {
            latest.clear();
            families.clear();
            continue;
        };
        let key = format!(
            "{}\0{}\0{}\0{}\0{}",
            event.stream_id,
            p["runId"].as_str().unwrap_or(""),
            kind,
            if kind == "turn-item.updated" {
                p["type"].as_str().unwrap_or("")
            } else {
                ""
            },
            id
        );
        if families.get(kind).is_some_and(|previous| previous != &key) {
            latest.clear();
        }
        families.insert(kind.to_owned(), key.clone());
        if let Some(previous) = latest.insert(key, index) {
            superseded[previous] = true;
        }
    }
    events
        .into_iter()
        .zip(superseded)
        .filter_map(|(event, removed)| (!removed).then_some(event))
        .collect()
}

pub(crate) fn thread_event_coalescible(event: &StoredEvent) -> bool {
    // Two identical updates collapse exactly when the event is coalescible.
    coalesce_thread_events(vec![event.clone(), event.clone()]).len() == 1
}

impl EventBus {
    pub fn new(db: Connection, capacity: usize) -> Self {
        let (events, _) = broadcast::channel(capacity.max(1));
        let (application_events, _) = broadcast::channel(capacity.max(1));
        Self {
            inner: Arc::new(Inner {
                db: Mutex::new(db),
                command_output: crate::command_output::CommandOutput::default(),
                worktrees_dir: Mutex::new(None),
                worktree_preparation: Mutex::new(()),
                secrets_dir: Mutex::new(None),
                shutdown: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                setup_context: Mutex::new(None),
                events,
                application_events,
                signals: Mutex::new(None),
            }),
        }
    }
    pub(crate) fn command_output(&self) -> &crate::command_output::CommandOutput { &self.inner.command_output }
    pub fn set_secrets_dir(&self, path: std::path::PathBuf) {
        *self.inner.secrets_dir.lock().unwrap() = Some(path);
    }
    pub fn secrets_dir(&self) -> Option<std::path::PathBuf> {
        self.inner.secrets_dir.lock().ok()?.clone()
    }
    pub fn lock_worktree_preparation(&self) -> Result<std::sync::MutexGuard<'_, ()>, BusError> {
        self.inner
            .worktree_preparation
            .lock()
            .map_err(|_| BusError::Poisoned)
    }
    pub fn set_worktrees_dir(&self, path: std::path::PathBuf) {
        *self.inner.worktrees_dir.lock().unwrap() = Some(path);
    }
    pub fn worktrees_dir(&self) -> Option<std::path::PathBuf> {
        self.inner.worktrees_dir.lock().ok()?.clone()
    }
    pub fn shutdown_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.inner.shutdown.clone()
    }
    pub fn set_setup_context(
        &self,
        terminals: Arc<crate::terminal::TerminalManager>,
        settings: Arc<crate::settings::Settings>,
    ) {
        *self.inner.setup_context.lock().unwrap() = Some((terminals, settings));
    }
    pub fn setup_context(
        &self,
    ) -> Option<(Arc<crate::terminal::TerminalManager>, serde_json::Value)> {
        let context = self.inner.setup_context.lock().ok()?;
        let (terminals, settings) = context.as_ref()?;
        Some((terminals.clone(), settings.snapshot()))
    }
    /// Execute journal operations on the serialized connection in autocommit mode.
    pub fn with_autocommit<T>(&self, f: impl FnOnce(&Connection) -> T) -> Result<T, BusError> {
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        Ok(f(&db))
    }
    pub fn set_effect_signals(&self, signals: Arc<crate::effect_worker::Signals>) {
        *self.inner.signals.lock().unwrap() = Some(signals);
    }
    /// Serialize transaction, commit, and publication. The closure must return
    /// precisely its newly inserted events, in ascending sequence order. Do not
    /// call bus methods from inside it; the lane remains locked until published.
    pub fn commit<T>(
        &self,
        write: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<(T, Vec<StoredEvent>)>,
    ) -> Result<T, BusError> {
        self.commit_with(|tx| write(tx).map_err(BusError::from))
    }
    /// Like `commit`, preserving the domain error returned by the write closure.
    pub fn commit_with<T, E>(
        &self,
        write: impl FnOnce(&Transaction<'_>) -> Result<(T, Vec<StoredEvent>), E>,
    ) -> Result<T, E>
    where
        E: From<BusError> + From<rusqlite::Error>,
    {
        let mut db = self
            .inner
            .db
            .lock()
            .map_err(|_| E::from(BusError::Poisoned))?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(E::from)?;
        let (result, events) = write(&tx)?;
        if events.iter().any(|event| event.sequence <= 0)
            || events.windows(2).any(|w| w[0].sequence >= w[1].sequence)
        {
            return Err(E::from(BusError::InvalidSequence));
        }
        tx.commit().map_err(E::from)?;
        if let Some(signals) = self.inner.signals.lock().unwrap().as_ref() {
            let cancelled: Vec<String> = signals.active_ids().into_iter().filter(|id| {
                matches!(crate::outbox::get(&db, id), Ok(Some(effect)) if effect.status == "cancelled")
            }).collect();
            signals.cancelled(&cancelled);
            signals.available();
        }
        for event in events {
            if event.event.aggregate_kind == "thread" || event.event.aggregate_kind == "project" {
                let _ = self.inner.application_events.send(event.clone());
            }
            if event.event.aggregate_kind == "thread" {
                let _ = self.inner.events.send(event);
            }
        }
        Ok(result)
    }
    /// Atomically subscribe to application-level live events and capture the
    /// database cursor. Callers replay through the cursor before consuming
    /// events above it and must recover explicitly on receiver lag.
    pub fn subscribe_application(
        &self,
    ) -> Result<(i64, broadcast::Receiver<StoredEvent>), BusError> {
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let receiver = self.inner.application_events.subscribe();
        let through = event_store::latest_application_sequence(&db)?;
        Ok((through, receiver))
    }
    /// Read the shell and its cursor under the same serialization lock as writes.
    pub fn shell_snapshot(&self) -> Result<serde_json::Value, BusError> {
        self.shell_snapshot_for(false)
    }
    pub fn shell_snapshot_with_options(
        &self,
        omit_idle_subagents: bool,
        omit_older_settled: bool,
    ) -> Result<serde_json::Value, BusError> {
        let mut snapshot = self.shell_snapshot()?;
        if omit_idle_subagents || omit_older_settled {
            trim_shell_snapshot(&mut snapshot, omit_idle_subagents, omit_older_settled);
        }
        Ok(snapshot)
    }
    pub fn archived_shell_snapshot(&self) -> Result<serde_json::Value, BusError> {
        self.shell_snapshot_for(true)
    }
    pub fn can_resume_shell_from(&self, after: i64) -> Result<bool, BusError> {
        use rusqlite::OptionalExtension;
        const SHELL_REPLAY_PAYLOAD_BUDGET_BYTES: i64 = 8 * 1024 * 1024;
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let head = event_store::latest_application_sequence(&db)?;
        if after == head {
            return Ok(true);
        }
        if after < 0 || after > head || head - after > 1000 {
            return Ok(false);
        }
        let pruned: i64 = db
            .query_row(
                "SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if after < pruned {
            return Ok(false);
        }
        let payload_bytes: i64 = db.query_row(
            "SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM orchestration_events WHERE (aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')) AND sequence > ?1 AND sequence <= ?2",
            rusqlite::params![after, head],
            |r| r.get(0),
        )?;
        Ok(payload_bytes <= SHELL_REPLAY_PAYLOAD_BUDGET_BYTES)
    }
    pub fn get_older_settled_threads(
        &self,
        before_settled_at: &str,
        before_thread_id: Option<&str>,
        project_ids: Option<&[String]>,
        limit: usize,
    ) -> Result<serde_json::Value, BusError> {
        use serde_json::{json, Value};
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let sequence = event_store::latest_application_sequence(&db)?;
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        let mut where_sql = String::from(
            "t.deleted_at IS NULL \
             AND t.archived_at IS NULL \
             AND json_extract(t.payload_json, '$.archivedAt') IS NULL \
             AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent' \
             AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1 \
             AND json_extract(t.payload_json, '$.settledOverride') = 'settled' \
             AND json_extract(t.payload_json, '$.settledAt') IS NOT NULL",
        );
        if let Some(ids) = project_ids {
            if ids.is_empty() {
                return Ok(json!({
                    "snapshotSequence": sequence,
                    "threads": [],
                    "counts": [],
                }));
            }
            let placeholders = vec!["?"; ids.len()].join(",");
            where_sql.push_str(&format!(" AND t.project_id IN ({placeholders})"));
            for id in ids {
                params.push(rusqlite::types::Value::Text(id.clone()));
            }
        }
        let cursor_sql = match before_thread_id {
            None => {
                params.push(rusqlite::types::Value::Text(before_settled_at.to_owned()));
                format!("json_extract(t.payload_json, '$.settledAt') < ?{}", params.len())
            }
            Some(tid) => {
                params.push(rusqlite::types::Value::Text(before_settled_at.to_owned()));
                let p_time = params.len();
                params.push(rusqlite::types::Value::Text(tid.to_owned()));
                let p_tid = params.len();
                format!(
                    "(json_extract(t.payload_json, '$.settledAt') < ?{p_time} \
                     OR (json_extract(t.payload_json, '$.settledAt') = ?{p_time} AND t.thread_id > ?{p_tid}))"
                )
            }
        };
        if limit == 0 {
            let sql = format!(
                "SELECT t.project_id, COUNT(*) \
                 FROM orchestration_v2_projection_threads t \
                 WHERE {where_sql} AND {cursor_sql} \
                 GROUP BY t.project_id"
            );
            let mut stmt = db.prepare(&sql)?;
            let counts = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                    Ok(json!({
                        "projectId": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(json!({
                "snapshotSequence": sequence,
                "threads": [],
                "counts": counts,
            }));
        }
        params.push(rusqlite::types::Value::Integer(limit as i64));
        let p_limit = params.len();
        let sql = format!(
            "SELECT t.payload_json \
             FROM orchestration_v2_projection_threads t \
             WHERE {where_sql} AND {cursor_sql} \
             ORDER BY json_extract(t.payload_json, '$.settledAt') DESC, t.thread_id ASC \
             LIMIT ?{p_limit}"
        );
        let mut stmt = db.prepare(&sql)?;
        let threads = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| r.get::<_, String>(0))?
            .map(|row| hydrate_thread_shell(&db, &row?))
            .collect::<Result<Vec<Value>, rusqlite::Error>>()?;
        Ok(json!({
            "snapshotSequence": sequence,
            "threads": threads,
            "counts": [],
        }))
    }
    pub fn get_thread_family(&self, thread_id: &str) -> Result<serde_json::Value, BusError> {
        use rusqlite::OptionalExtension;
        use serde_json::{json, Value};
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let sequence = event_store::latest_application_sequence(&db)?;
        let root_id: Option<String> = db
            .query_row(
                "SELECT COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) \
                 FROM orchestration_v2_projection_threads \
                 WHERE thread_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(root_id) = root_id else {
            return Ok(json!({
                "snapshotSequence": sequence,
                "threads": [],
            }));
        };
        let mut stmt = db.prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads \
             WHERE deleted_at IS NULL AND archived_at IS NULL \
             AND (thread_id = ?1 OR json_extract(payload_json, '$.lineage.rootThreadId') = ?1) \
             ORDER BY updated_at, thread_id",
        )?;
        let threads = stmt
            .query_map([root_id], |r| r.get::<_, String>(0))?
            .map(|row| hydrate_thread_shell(&db, &row?))
            .collect::<Result<Vec<Value>, rusqlite::Error>>()?;
        Ok(json!({
            "snapshotSequence": sequence,
            "threads": threads,
        }))
    }
    pub fn get_worktree_thread_ids(&self, worktree_path: &str) -> Result<serde_json::Value, BusError> {
        use serde_json::json;
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let mut stmt = db.prepare(
            "SELECT thread_id FROM orchestration_v2_projection_threads \
             WHERE deleted_at IS NULL AND archived_at IS NULL \
             AND json_extract(payload_json, '$.worktreePath') = ?1 \
             ORDER BY updated_at, thread_id",
        )?;
        let thread_ids = stmt
            .query_map([worktree_path], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(json!({ "threadIds": thread_ids }))
    }
    fn shell_snapshot_for(&self, archived: bool) -> Result<serde_json::Value, BusError> {
        use serde_json::{json, Value};
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let sequence = event_store::latest_application_sequence(&db)?;
        let mut stmt = db.prepare("SELECT project_id,title,workspace_root,default_model_selection_json,default_thread_env_mode,auto_pull,scripts_json,pinned_at,archived_at,created_at,updated_at,has_custom_title,favicon_path,project_icon_json FROM projection_projects WHERE deleted_at IS NULL ORDER BY created_at,project_id")?;
        let projects = stmt.query_map([], |r| {
            let selection: Option<String> = r.get(3)?;
            let scripts: String = r.get(6)?;
            let icon: Option<String> = r.get(13)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"hasCustomTitle":r.get::<_,bool>(11)?,"workspaceRoot":r.get::<_,String>(2)?,"repositoryIdentity":null,"faviconPath":r.get::<_,Option<String>>(12)?,"projectIcon":icon.and_then(|s| serde_json::from_str::<Value>(&s).ok()),"defaultModelSelection":selection.and_then(|s| serde_json::from_str::<Value>(&s).ok()),"defaultThreadEnvMode":r.get::<_,Option<String>>(4)?,"autoPull":r.get::<_,bool>(5)?,"scripts":serde_json::from_str::<Value>(&scripts).unwrap_or(json!([])),"pinnedAt":r.get::<_,Option<String>>(7)?,"archivedAt":r.get::<_,Option<String>>(8)?,"createdAt":r.get::<_,String>(9)?,"updatedAt":r.get::<_,String>(10)?}))
        })?.collect::<Result<Vec<_>,_>>()?;
        let sql = if archived {
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY updated_at,thread_id"
        } else {
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at,thread_id"
        };
        let mut stmt = db.prepare(sql)?;
        let threads = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|row| hydrate_thread_shell(&db, &row?))
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        Ok(
            json!({"schemaVersion":2,"snapshotSequence":sequence,"projects":projects,"threads":threads,"archivedThreads":[]}),
        )
    }
    /// Build latest-wins shell deltas through an atomic snapshot's cursor.
    /// `None` indicates that the cursor cannot be replayed safely.
    pub fn shell_resume(
        &self,
        after: i64,
    ) -> Result<Option<(i64, Vec<serde_json::Value>)>, BusError> {
        use rusqlite::OptionalExtension;
        use serde_json::json;
        let snapshot = self.shell_snapshot()?;
        let head = snapshot["snapshotSequence"].as_i64().unwrap_or(0);
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let pruned: i64 = db.query_row("SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'", [], |r| r.get(0)).optional()?.unwrap_or(0);
        if after < 0 || after > head || head - after > 1000 || (after < head && after < pruned) {
            return Ok(None);
        }
        let mut stmt = db.prepare("SELECT aggregate_kind,stream_id,MAX(sequence) FROM orchestration_events WHERE (aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')) AND sequence>?1 AND sequence<=?2 GROUP BY aggregate_kind,stream_id ORDER BY MAX(sequence)")?;
        let entries = stmt
            .query_map(rusqlite::params![after, head], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut items = Vec::new();
        for (kind, id, sequence) in entries {
            let field = if kind == "project" {
                "projects"
            } else {
                "threads"
            };
            let row = snapshot[field]
                .as_array()
                .and_then(|rows| rows.iter().find(|v| v["id"] == id));
            let value = match (kind.as_str(), row) {
                ("project", Some(row)) => {
                    json!({"kind":"project.updated","sequence":sequence,"project":row})
                }
                ("project", None) => {
                    json!({"kind":"project.removed","sequence":sequence,"projectId":id})
                }
                (_, Some(row)) => {
                    json!({"kind":"thread.updated","sequence":sequence,"location":"active","thread":row})
                }
                (_, None) => {
                    json!({"kind":"thread.removed","sequence":sequence,"location":"active","threadId":id})
                }
            };
            items.push(value);
        }
        if serde_json::to_vec(&items)
            .map_err(|_| BusError::InvalidSequence)?
            .len()
            > 8 * 1024 * 1024
        {
            return Ok(None);
        }
        Ok(Some((head, items)))
    }
    /// Capture a bounded thread replay at a single high-water mark. `None` means
    /// the caller must load a snapshot instead.
    pub fn thread_resume(
        &self,
        id: &str,
        after: i64,
    ) -> Result<Option<(i64, Vec<StoredEvent>)>, BusError> {
        use rusqlite::OptionalExtension;
        crate::legacy_transcript::ensure_transcript(self, id)?;
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let head = event_store::latest_thread_sequence(&db, Some(id))?;
        let pruned: i64 = db.query_row("SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='event-log-pruned-through'", [], |r| r.get(0)).optional()?.unwrap_or(0);
        if after > head || (after < head && after < pruned) {
            return Ok(None);
        }
        let (count, bytes): (i64, i64) = db.query_row("SELECT COUNT(*), COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=?1 AND sequence>?2 AND sequence<=?3", rusqlite::params![id, after, head], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if count > 128 || bytes > 1_048_576 {
            return Ok(None);
        }
        let events = event_store::read_agent_events(
            &db,
            &EventFilter {
                after,
                through: Some(head),
                thread_id: Some(id),
                ..Default::default()
            },
        )?;
        if events
            .iter()
            .any(|e| e.event.event_type == "thread.created")
        {
            return Ok(None);
        }
        let encoded_size: usize = events
            .iter()
            .map(|e| {
                e.event.payload.to_string().len()
                    + e.event.id.len()
                    + e.event.event_type.len()
                    + e.event.occurred_at.len()
                    + id.len()
                    + 100
            })
            .sum();
        if encoded_size > 1_048_576 {
            return Ok(None);
        }
        Ok(Some((head, coalesce_thread_events(events))))
    }
    /// Read a thread projection and its per-thread cursor atomically.
    pub fn thread_snapshot(&self, id: &str) -> Result<Option<(i64, serde_json::Value)>, BusError> {
        use rusqlite::OptionalExtension;
        use serde_json::{json, Value};
        crate::legacy_transcript::ensure_transcript(self, id)?;
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let thread: Option<String> = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [id], |r| r.get(0)).optional()?;
        let Some(thread) = thread else {
            return Ok(None);
        };
        let thread: Value = serde_json::from_str(&thread).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
        // Forked run histories require recursive inherited timeline assembly.
        // Do not return a snapshot that silently omits that conversation.
        if thread["forkedFrom"]["type"] == "run" && thread["lineage"]["sideChat"] != true {
            return Err(BusError::InvalidSequence);
        }
        let seq = event_store::latest_thread_sequence(&db, Some(id))?;
        let queries = [
            ("runs", "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal"),
            ("attempts", "SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 ORDER BY run_id,attempt_ordinal"),
            ("nodes", "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 ORDER BY COALESCE(started_at,''),node_id"),
            ("subagents", "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 ORDER BY COALESCE(started_at,''),subagent_id"),
            ("providerSessions", "SELECT s.payload_json FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 ORDER BY s.updated_at,s.provider_session_id"),
            ("providerThreads", "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id=?1) OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id=?1) ORDER BY COALESCE(first_run_ordinal,0),provider_thread_id"),
            ("providerTurns", "SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 ORDER BY provider_thread_id,ordinal"),
            ("runtimeRequests", "SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 ORDER BY created_at,runtime_request_id"),
            ("messages", "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 ORDER BY created_at,message_id"),
            ("plans", "SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id=?1 ORDER BY plan_id"),
            ("turnItems", "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 ORDER BY ordinal,turn_item_id"),
            ("checkpointScopes", "SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id=?1 ORDER BY ordinal_within_parent,scope_id"),
            ("checkpoints", "SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE thread_id=?1 ORDER BY scope_id,ordinal_within_scope"),
            ("contextHandoffs", "SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE thread_id=?1 ORDER BY rowid"),
            ("contextTransfers", "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 OR target_thread_id=?1 ORDER BY rowid"),
        ];
        let mut projection = json!({"updatedAt":thread["updatedAt"],"thread":thread});
        for (field, sql) in queries {
            let mut stmt = db.prepare(sql)?;
            let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
            let values = rows
                .map(|row| {
                    serde_json::from_str::<Value>(&row?).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut values = values;
            if field == "contextHandoffs" {
                for handoff in &mut values {
                    crate::context_handoff::project_for_wire(handoff);
                }
            }
            projection[field] = json!(values);
        }
        let runs = projection["runs"].as_array().unwrap();
        let attempts = projection["attempts"].as_array().unwrap();
        let items = projection["turnItems"].as_array().unwrap();
        let visible: Vec<Value> = items.iter().filter(|item| {
            let run_id = item["runId"].as_str();
            let status = runs.iter().find(|r| r["id"].as_str() == run_id && run_id.is_some()).and_then(|r| r["status"].as_str());
            if status == Some("rolled_back") || (item["type"] == "user_message" && item["inputIntent"] == "queued_turn" && matches!(status, Some("queued" | "cancelled"))) { return false; }
            if item["type"] == "run_interrupt_result" && run_id.is_some() && !item["nodeId"].is_null() {
                let superseded = attempts.iter().any(|a| a["runId"] == item["runId"] && a["rootNodeId"] == item["nodeId"] && a["status"] == "superseded");
                let requested = items.iter().any(|i| i["runId"] == item["runId"] && i["type"] == "run_interrupt_request");
                if superseded && !requested { return false; }
            }
            true
        }).enumerate().map(|(position,item)| json!({"position":position,"visibility":"local","sourceThreadId":item["threadId"],"sourceItemId":item["id"],"item":item})).collect();
        projection["visibleTurnItems"] = json!(visible);
        Ok(Some((seq, projection)))
    }
    /// Read titles and project links for existing, non-deleted threads.
    pub fn thread_links(
        &self,
        ids: &[String],
    ) -> Result<Vec<(String, String, Option<String>)>, BusError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let ids = serde_json::to_string(ids).map_err(|_| BusError::InvalidSequence)?;
        let mut stmt = db.prepare("SELECT thread_id, title, project_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND thread_id IN (SELECT value FROM json_each(?1))")?;
        let rows = stmt.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    /// Subscribe before capturing the high-water mark, then replay through that
    /// mark in pages of 256. Live events at or below it are discarded.
    pub fn subscribe(&self, after: i64, filter: Filter) -> Result<Subscription, BusError> {
        let db = self.inner.db.lock().map_err(|_| BusError::Poisoned)?;
        let receiver = self.inner.events.subscribe();
        let high_water = event_store::latest_thread_sequence(&db, None)?;
        Ok(Subscription {
            bus: self.clone(),
            receiver,
            filter,
            cursor: after.max(0),
            high_water,
            replay_done: false,
            page: std::collections::VecDeque::new(),
        })
    }
}
pub struct Subscription {
    bus: EventBus,
    receiver: broadcast::Receiver<StoredEvent>,
    filter: Filter,
    cursor: i64,
    high_water: i64,
    replay_done: bool,
    page: std::collections::VecDeque<StoredEvent>,
}
impl Subscription {
    /// On lag the subscriber must reconnect and replay from its last delivered
    /// sequence; no silently incomplete stream is returned.
    pub async fn next(&mut self) -> Result<StoredEvent, BusError> {
        loop {
            if let Some(event) = self.page.pop_front() {
                self.cursor = event.sequence;
                return Ok(event);
            }
            if !self.replay_done {
                if self.cursor >= self.high_water {
                    self.replay_done = true;
                    continue;
                }
                let db = self.bus.inner.db.lock().map_err(|_| BusError::Poisoned)?;
                let events = event_store::read_agent_events(
                    &db,
                    &EventFilter {
                        after: self.cursor,
                        through: Some(self.high_water),
                        thread_id: self.filter.thread_id.as_deref(),
                        event_type: self.filter.event_type.as_deref(),
                        limit: Some(PAGE_SIZE),
                        ..Default::default()
                    },
                )?;
                if events.len() < PAGE_SIZE as usize {
                    self.replay_done = true;
                }
                self.page = events.into();
                continue;
            }
            match self.receiver.recv().await {
                Ok(event)
                    if event.sequence > self.high_water.max(self.cursor)
                        && self.filter.matches(&event) =>
                {
                    self.cursor = event.sequence;
                    return Ok(event);
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(n)) => return Err(BusError::Lagged(n)),
                Err(broadcast::error::RecvError::Closed) => return Err(BusError::Closed),
            }
        }
    }
    pub fn cursor(&self) -> i64 {
        self.cursor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_store::{self, Event};
    fn bus(capacity: usize) -> EventBus {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL, application_event_version INTEGER NOT NULL);").unwrap();
        EventBus::new(db, capacity)
    }
    fn event(id: String, thread: &str) -> Event {
        Event {
            id,
            aggregate_kind: "thread".into(),
            stream_id: thread.into(),
            event_type: "test".into(),
            occurred_at: "now".into(),
            command_id: None,
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: serde_json::json!({}),
            metadata: serde_json::json!({}),
        }
    }
    #[test]
    fn coalescing_respects_barriers_and_identity_switches() {
        let make = |sequence: i64, kind: &str, id: &str| {
            let mut e = event(sequence.to_string(), "t");
            e.event_type = kind.into();
            e.payload =
                serde_json::json!({"id":id,"runId":"r","role":"assistant","streaming":true});
            StoredEvent {
                sequence,
                stream_version: sequence,
                event: e,
            }
        };
        let events = vec![
            make(1, "message.updated", "a"),
            make(2, "message.updated", "a"),
            make(3, "message.updated", "b"),
            make(4, "message.updated", "a"),
            make(5, "run.updated", "r"),
            make(6, "message.updated", "a"),
            make(7, "message.updated", "a"),
        ];
        let sequences: Vec<_> = coalesce_thread_events(events)
            .into_iter()
            .map(|e| e.sequence)
            .collect();
        assert_eq!(sequences, vec![2, 3, 4, 5, 7]);
    }
    #[test]
    fn shell_detects_thread_wait_and_other_active_work() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','auto','default','now','now',?1)",[serde_json::json!({"id":"t"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','running','now',?1)",[serde_json::json!({"id":"r","status":"running"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES('i','t','r',1,'dynamic_tool','running','now',?1)",[serde_json::json!({"id":"i","runId":"r","type":"dynamic_tool","status":"running","toolName":"mcp__t3_code__t3_thread_wait"}).to_string()]).unwrap();
        let mut thread = serde_json::json!({"id":"t"});
        enrich_shell(&db, &mut thread).unwrap();
        assert_eq!(thread["blockedOnThreadWait"], true);
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES('j','t','r',2,'command_execution','running','now',?1)",[serde_json::json!({"id":"j","runId":"r","type":"command_execution","status":"running"}).to_string()]).unwrap();
        enrich_shell(&db, &mut thread).unwrap();
        assert_eq!(thread["blockedOnThreadWait"], false);
    }
    #[test]
    fn shell_snapshot_orders_by_updated_time_then_thread_id() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, created, updated) in [("a", "01", "03"), ("b", "02", "02"), ("c", "01", "02")] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p','T','codex','auto','default',?2,?3,?4)",rusqlite::params![id,created,updated,serde_json::json!({"id":id}).to_string()]).unwrap();
        }
        let snapshot = EventBus::new(db, 8).shell_snapshot().unwrap();
        let ids: Vec<_> = snapshot["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|thread| thread["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }
    #[test]
    fn shell_snapshot_preserves_project_appearance_and_title_provenance() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,has_custom_title,favicon_path,project_icon_json) VALUES('p','Project','/tmp','[]','now','now',1,'/favicon',?1)", [serde_json::json!({"type":"emoji","value":"x"}).to_string()]).unwrap();
        let snapshot = EventBus::new(db, 8).shell_snapshot().unwrap();
        assert_eq!(snapshot["projects"][0]["hasCustomTitle"], true);
        assert_eq!(snapshot["projects"][0]["faviconPath"], "/favicon");
        assert_eq!(snapshot["projects"][0]["projectIcon"]["value"], "x");
        assert!(snapshot["projects"][0]["repositoryIdentity"].is_null());
    }
    #[test]
    fn archived_shell_only_returns_archived_threads() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, archived) in [("active", None), ("old", Some("2026-01-01T00:00:00Z"))] {
            let payload=serde_json::json!({"id":id,"projectId":"p","updatedAt":"2026-01-01T00:00:00Z","archivedAt":archived}).to_string();
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,archived_at,payload_json) VALUES(?1,'p','Title','codex','full-access','default','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?2,?3)",rusqlite::params![id,archived,payload]).unwrap();
        }
        let bus = EventBus::new(db, 8);
        assert_eq!(bus.shell_snapshot().unwrap()["threads"][0]["id"], "active");
        assert_eq!(
            bus.archived_shell_snapshot().unwrap()["threads"][0]["id"],
            "old"
        );
    }
    #[test]
    fn snapshot_reads_records_and_filters_hidden_timeline_items() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('t','p','title','codex','full-access','default','a','a',?1)", [r#"{"id":"t","updatedAt":"a"}"#]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('r','t',1,'codex','queued','a',?1)", [r#"{"id":"r","status":"queued"}"#]).unwrap();
        for (id, ordinal, payload) in [
            (
                "hidden",
                1,
                r#"{"id":"hidden","threadId":"t","runId":"r","type":"user_message","inputIntent":"queued_turn"}"#,
            ),
            (
                "visible",
                2,
                r#"{"id":"visible","threadId":"t","runId":"r","type":"assistant_message"}"#,
            ),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,'t',?2,'user_message','completed','a',?3)", rusqlite::params![id,ordinal,payload]).unwrap();
        }
        let bus = EventBus::new(db, 8);
        let (_, snapshot) = bus.thread_snapshot("t").unwrap().unwrap();
        assert_eq!(snapshot["runs"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["turnItems"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["visibleTurnItems"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["visibleTurnItems"][0]["sourceItemId"], "visible");
    }
    #[tokio::test]
    async fn replay_and_live_are_ordered_and_rollback_is_invisible() {
        let bus = bus(16);
        bus.commit(|tx| {
            Ok((
                (),
                event_store::append(tx, &[event("1".into(), "a"), event("2".into(), "b")])?,
            ))
        })
        .unwrap();
        let mut sub = bus
            .subscribe(
                0,
                Filter {
                    thread_id: Some("a".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let failed: Result<(), BusError> = bus.commit(|tx| {
            event_store::append(tx, &[event("3".into(), "a")])?;
            Err(rusqlite::Error::InvalidQuery)
        });
        assert!(failed.is_err());
        bus.commit(|tx| Ok(((), event_store::append(tx, &[event("4".into(), "a")])?)))
            .unwrap();
        assert_eq!(sub.next().await.unwrap().event.id, "1");
        assert_eq!(sub.next().await.unwrap().event.id, "4");
        assert_eq!(sub.cursor(), 3);
    }
    #[tokio::test]
    async fn concurrent_commits_are_published_in_commit_order() {
        let bus = bus(256);
        let mut a = bus.subscribe(0, Filter::default()).unwrap();
        let mut b = bus.subscribe(0, Filter::default()).unwrap();
        let mut threads = Vec::new();
        for n in 0..64 {
            let bus = bus.clone();
            threads.push(std::thread::spawn(move || {
                bus.commit(|tx| Ok(((), event_store::append(tx, &[event(n.to_string(), "a")])?)))
                    .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        for seq in 1..=64 {
            assert_eq!(a.next().await.unwrap().sequence, seq);
            assert_eq!(b.next().await.unwrap().sequence, seq);
        }
    }
    #[tokio::test]
    async fn lag_is_explicit_and_replay_recovers() {
        let bus = bus(2);
        let mut sub = bus.subscribe(0, Filter::default()).unwrap();
        for n in 0..4 {
            bus.commit(|tx| Ok(((), event_store::append(tx, &[event(n.to_string(), "a")])?)))
                .unwrap();
        }
        assert!(matches!(sub.next().await, Err(BusError::Lagged(_))));
        let mut recovered = bus.subscribe(sub.cursor(), Filter::default()).unwrap();
        for seq in 1..=4 {
            assert_eq!(recovered.next().await.unwrap().sequence, seq);
        }
    }
}
