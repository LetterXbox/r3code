//! Atomic dispatch for idle threads and app-owned queued turns.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Encode a single ID component using JavaScript's encodeURIComponent rules.
pub(crate) fn encode_id_part(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub(crate) fn run_id(thread: &str, ordinal: i64) -> String {
    format!("run:thread:{}:ordinal:{ordinal}", encode_id_part(thread))
}
pub(crate) fn pending_provider_thread_id(driver: &str, run: &str) -> String {
    format!(
        "provider-thread:provider:{}:native-thread:{}",
        encode_id_part(driver),
        encode_id_part(&format!("pending:{run}"))
    )
}

fn source_point(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    run: &Value,
) -> rusqlite::Result<Value> {
    let mut point = json!({"threadId":thread,"runId":run["id"]});
    if !run["checkpointId"].is_null() {
        point["checkpointId"] = run["checkpointId"].clone();
    }
    let native_thread: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.nativeThreadRef') FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [run["providerThreadId"].as_str()], |r| r.get(0)).optional()?.flatten();
    if let Some(reference) = native_thread {
        point["providerThreadRef"] = json!(reference);
    }
    let native_turn: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.nativeTurnRef') FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY rowid DESC LIMIT 1", [run["activeAttemptId"].as_str()], |r| r.get(0)).optional()?.flatten();
    if let Some(reference) = native_turn {
        point["providerTurnRef"] = json!(reference);
    }
    Ok(point)
}

/// Create the visible signal describing the portable context supplied to a run.
pub(crate) fn handoff_turn_item(
    tx: &rusqlite::Transaction<'_>,
    handoff: &Value,
    run: &Value,
    node: &str,
    ordinal: i64,
    now: &str,
) -> rusqlite::Result<Value> {
    let thread = run["threadId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let from = handoff["coveredRunOrdinals"]["from"].as_i64();
    let to = handoff["coveredRunOrdinals"]["to"].as_i64();
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<=?3 AND status NOT IN ('queued','rolled_back') ORDER BY ordinal")?;
    let rows = stmt
        .query_map(params![thread, from.unwrap_or(1), to.unwrap_or(0)], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut instances = Vec::<Value>::new();
    let mut models = Vec::<Value>::new();
    for raw in rows {
        let source: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !source["providerInstanceId"].is_null()
            && !instances.contains(&source["providerInstanceId"])
        {
            instances.push(source["providerInstanceId"].clone());
        }
        if !source["modelSelection"].is_null()
            && !models.iter().any(|m| {
                m["instanceId"] == source["modelSelection"]["instanceId"]
                    && m["model"] == source["modelSelection"]["model"]
            })
        {
            models.push(source["modelSelection"].clone());
        }
    }
    let id = crate::interrupt_commands::signal(
        run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?,
        &format!(
            "context-handoff:{}",
            handoff["id"]
                .as_str()
                .ok_or(rusqlite::Error::InvalidQuery)?
        ),
    );
    Ok(
        json!({"id":id,"threadId":thread,"runId":run["id"],"nodeId":node,"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Provider handoff","startedAt":now,"completedAt":now,"updatedAt":now,"type":"handoff","contextHandoffId":handoff["id"],"fromProviderThreadIds":handoff["fromProviderThreadIds"],"toProviderThreadId":handoff["toProviderThreadId"],"fromProviderInstanceIds":instances,"toProviderInstanceId":run["providerInstanceId"],"fromModelSelections":models,"toModel":run["modelSelection"]["model"],"strategy":handoff["strategy"],"summary":handoff["summaryText"]}),
    )
}

pub struct DispatchMessage<'a> {
    pub command_id: &'a str,
    pub thread_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    pub attachments: &'a [Value],
    pub context: Option<&'a Value>,
    pub creation_source: &'a str,
    pub cwd: &'a str,
    pub driver: &'a str,
}

#[derive(Debug)]
pub enum DispatchError {
    Database(rusqlite::Error),
    Bus(BusError),
    CommandIdConflict,
}
impl From<rusqlite::Error> for DispatchError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
impl From<BusError> for DispatchError {
    fn from(e: BusError) -> Self {
        Self::Bus(e)
    }
}
impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DispatchError {}

// Read the visible activity of each fork ancestor through its recorded fork point.
// Missing ancestors and cycles terminate traversal, matching the projection reader.
fn inherited_handoff_items(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
) -> rusqlite::Result<Vec<Value>> {
    let mut current = thread.to_owned();
    let mut seen = std::collections::HashSet::from([current.clone()]);
    let mut segments = Vec::new();
    loop {
        let raw: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                [&current],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else { break };
        let value: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if value["forkedFrom"]["type"] != "run" || value["lineage"]["sideChat"] == true {
            break;
        }
        let (Some(parent), Some(fork_run)) = (
            value["forkedFrom"]["threadId"].as_str(),
            value["forkedFrom"]["runId"].as_str(),
        ) else {
            break;
        };
        if !seen.insert(parent.to_owned()) {
            break;
        }
        let through: Option<i64> = tx.query_row("SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", params![parent,fork_run], |r| r.get(0)).optional()?;
        let Some(through) = through else { break };
        let mut stmt = tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND ((r.ordinal<=?2 AND r.status NOT IN ('rolled_back','queued')) OR (i.run_id IS NULL AND json_extract((SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1),'$.historyOrigin')='v1_import')) ORDER BY i.ordinal")?;
        let items = stmt
            .query_map(params![parent, through], |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
            .collect::<rusqlite::Result<Vec<Value>>>()?;
        segments.push(filter_handoff_items(tx, parent, items)?);
        current = parent.to_owned();
    }
    Ok(segments.into_iter().rev().flatten().collect())
}

fn filter_handoff_items(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    items: Vec<Value>,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt =
        tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1")?;
    let runs = stmt
        .query_map([thread], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str::<Value>(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = tx.prepare(
        "SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1",
    )?;
    let attempts = stmt
        .query_map([thread], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str::<Value>(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items
        .iter()
        .filter(|item| {
            let run = runs
                .iter()
                .find(|r| !item["runId"].is_null() && r["id"] == item["runId"]);
            let status = run.and_then(|r| r["status"].as_str());
            if status == Some("rolled_back")
                || (item["type"] == "user_message"
                    && item["inputIntent"] == "queued_turn"
                    && matches!(status, Some("queued" | "cancelled")))
            {
                return false;
            }
            if item["type"] == "run_interrupt_result"
                && !item["runId"].is_null()
                && !item["nodeId"].is_null()
                && attempts.iter().any(|a| {
                    a["runId"] == item["runId"]
                        && a["rootNodeId"] == item["nodeId"]
                        && a["status"] == "superseded"
                })
                && !items
                    .iter()
                    .any(|i| i["runId"] == item["runId"] && i["type"] == "run_interrupt_request")
            {
                return false;
            }
            true
        })
        .cloned()
        .collect())
}

/// Persist portable context for a provider switch within the run's transaction.
pub(crate) fn prepare_switch_handoff(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    run: &str,
    target: &str,
    instance: &str,
    now: &str,
    full_context: bool,
) -> rusqlite::Result<Option<(Value, Value)>> {
    let boundary:i64 = tx.query_row("SELECT COALESCE(MAX(r.ordinal),0) FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND json_extract(r.payload_json,'$.freshContext')=1 AND r.status!='queued' AND NOT (r.status='cancelled' AND json_extract(r.payload_json,'$.startedAt') IS NULL) AND json_extract(m.payload_json,'$.scheduledTaskId') IS NULL",[thread],|r|r.get(0))?;
    let last: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0) FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND provider_thread_id=?2 AND (status='completed' OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns p WHERE p.run_attempt_id=json_extract(orchestration_v2_projection_runs.payload_json,'$.activeAttemptId'))) AND status NOT IN ('rolled_back','queued')", params![thread,target], |r|r.get(0))?;
    let last = if full_context || last < boundary { 0 } else { last };
    let lower = last.max(boundary.saturating_sub(1));
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status NOT IN ('queued','rolled_back') ORDER BY ordinal")?;
    let runs: Vec<Value> = stmt
        .query_map(params![thread, lower], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<_>>()?;
    if runs.is_empty() {
        return Ok(None);
    }
    let from = runs.first().unwrap()["ordinal"].as_i64().unwrap_or(1);
    let to = runs.last().unwrap()["ordinal"].as_i64().unwrap_or(from);
    let mut stmt=tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND ((r.ordinal>?2 AND r.status NOT IN ('queued','rolled_back')) OR (?2=0 AND i.run_id IS NULL AND json_extract((SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1),'$.historyOrigin')='v1_import')) ORDER BY i.ordinal")?;
    let items: Vec<Value> = stmt
        .query_map(params![thread, lower], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<_>>()?;
    let mut items = filter_handoff_items(tx, thread, items)?;
    if last == 0 && boundary == 0 {
        let mut inherited = inherited_handoff_items(tx, thread)?;
        inherited.append(&mut items);
        items = inherited;
    }
    let mut sources = Vec::new();
    for r in &runs {
        if let Some(id) = r["providerThreadId"].as_str() {
            if !sources.iter().any(|x| x == id) {
                sources.push(id.to_owned())
            }
        }
    }
    let id = format!("context-handoff:{}", uuid::Uuid::new_v4());
    let transfer_id = format!("context-transfer:{}", uuid::Uuid::new_v4());
    let strategy = if last == 0 {
        "full_thread_summary"
    } else {
        "delta_since_target_last_seen"
    };
    let handoff = crate::context_handoff::prepare_provider_handoff(
        &id,
        thread,
        thread,
        run,
        Some(&transfer_id),
        &sources,
        target,
        from,
        to,
        strategy,
        &items,
        &runs,
        crate::context_handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
        now,
    );
    let source = source_point(tx, thread, runs.last().unwrap())?;
    let base = if last == 0 {
        Value::Null
    } else {
        let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND provider_thread_id=?2 AND ordinal=?3", params![thread,target,last], |r|r.get(0))?;
        source_point(
            tx,
            thread,
            &serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?,
        )?
    };
    let transfer = json!({"id":transfer_id,"type":"provider_handoff","sourceThreadId":thread,"targetThreadId":thread,"sourcePoint":source,"basePoint":base,"sourceProviderInstanceId":runs.last().unwrap()["providerInstanceId"],"targetProviderInstanceId":instance,"targetRunId":run,"status":"consumed","resolution":{"strategy":if last==0 {"portable_context"} else {"delta_context"},"contextHandoffId":id},"createdBy":"user","error":null,"createdAt":now,"updatedAt":now,"consumedAt":now});
    tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,'ready',?6,?7)",params![id,thread,run,target,strategy,now,handoff.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,target_provider,updated_at,payload_json) VALUES(?1,?2,?2,?3,'provider_handoff','consumed',?4,?5,?6,?7)",params![transfer_id,thread,run,runs.last().unwrap()["providerInstanceId"].as_str(),instance,now,transfer.to_string()])?;
    Ok(Some((handoff, transfer)))
}

/// Return a safely bounded Codex fork candidate, if the source is compatible.
pub(crate) fn native_fork_candidate(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    instance: &str,
) -> rusqlite::Result<Option<Value>> {
    native_fork_candidate_for(tx, thread, instance, "codex")
}

pub(crate) fn native_fork_candidate_for(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    instance: &str,
    driver: &str,
) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type='fork' AND status='pending' ORDER BY rowid DESC LIMIT 1", [thread], |r| r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let transfer: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let side: bool = tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.lineage.sideChat'),0) FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r| r.get(0))?;
    let source = &transfer["sourcePoint"];
    if side
        || transfer["sourceProviderInstanceId"] != instance
        || source["providerThreadRef"]["driver"] != driver
        || source["providerThreadRef"]["strength"] != "strong"
        || source["providerThreadRef"]["nativeId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return Ok(None);
    }
    if driver == "pi" {
        if source["providerTurnRef"]["driver"] != "pi"
            || source["providerTurnRef"]["strength"] != "strong"
            || source["providerTurnRef"]["nativeId"].as_str().is_none_or(str::is_empty)
        {
            return Ok(None);
        }
        let eligible: bool = tx.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM orchestration_v2_projection_runs
                 WHERE run_id=?1 AND thread_id=?2 AND status='completed'
             ) AND NOT EXISTS(
                 SELECT 1 FROM orchestration_v2_projection_runs
                 WHERE thread_id=?2 AND status IN ('preparing','starting','running','waiting')
             )",
            params![source["runId"].as_str(), transfer["sourceThreadId"].as_str()],
            |row| row.get(0),
        )?;
        return Ok(eligible.then_some(transfer));
    }
    // A missing native cursor can still be bounded using the persisted provider-turn ordinal.
    let boundary: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.run_id=?1 AND r.thread_id=?2 AND r.status IN ('completed','waiting') AND p.provider_thread_id=r.provider_thread_id)", params![source["runId"].as_str(), transfer["sourceThreadId"].as_str()], |r| r.get(0))?;
    if !boundary {
        return Ok(None);
    }
    let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_runs base ON base.run_id=?2 AND base.thread_id=?1 WHERE r.thread_id=?1 AND r.ordinal>base.ordinal AND r.status IN ('preparing','starting','running','waiting'))", params![transfer["sourceThreadId"].as_str(),source["runId"].as_str()], |r|r.get(0))?;
    Ok((!busy).then_some(transfer))
}

/// Resolve a pending fork into a bounded portable history on its first run.
pub(crate) fn prepare_fork_handoff(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    run: &str,
    target: &str,
    instance: &str,
    driver: &str,
    now: &str,
) -> rusqlite::Result<Option<(Value, Value, Option<Value>)>> {
    prepare_fork_handoff_impl(tx, thread, run, target, instance, driver, now, false)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_fork_handoff_impl(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    run: &str,
    target: &str,
    instance: &str,
    driver: &str,
    now: &str,
    force: bool,
) -> rusqlite::Result<Option<(Value, Value, Option<Value>)>> {
    let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type='fork' AND status='pending' ORDER BY rowid DESC LIMIT 1", [thread], |r| r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    // Keep an eligible native transfer pending until the provider has actually
    // forked it. Side chats require portable framing and always use a handoff.
    if !force
        && (native_fork_candidate(tx, thread, instance)?.is_some()
            || native_fork_candidate_for(tx, thread, instance, "opencode")?.is_some()
            || (driver == "pi" && native_fork_candidate_for(tx, thread, instance, "pi")?.is_some()))
    {
        return Ok(None);
    }
    let mut transfer: Value =
        serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let source = transfer["sourceThreadId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let side_chat: bool = tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.lineage.sideChat'),0) FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r| r.get(0))?;
    let _ = transfer["sourcePoint"]["runId"].is_string();
    // Side chats require portable framing and always use a handoff.
    if side_chat && !matches!(driver, "codex" | "claudeAgent" | "pi" | "opencode" | "cursor" | "muse" | "fx" | "grok" | "kiro" | "acpRegistry" | "antigravity") {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let through: i64 = match transfer["sourcePoint"]["runId"].as_str() {
        Some(id) => tx.query_row("SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", params![source,id], |r| r.get(0)).optional()?.ok_or(rusqlite::Error::InvalidQuery)?,
        None => 0,
    };
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal<=?2 AND status NOT IN ('queued','rolled_back') ORDER BY ordinal")?;
    let runs: Vec<Value> = stmt
        .query_map(params![source, through], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND r.ordinal<=?2 AND r.status NOT IN ('queued','rolled_back') ORDER BY i.ordinal")?;
    let items: Vec<Value> = stmt
        .query_map(params![source, through], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<_>>()?;
    let mut inherited = inherited_handoff_items(tx, source)?;
    inherited.extend(filter_handoff_items(tx, source, items)?);
    let mut sources = Vec::<String>::new();
    for r in &runs {
        if let Some(id) = r["providerThreadId"].as_str() {
            if !sources.iter().any(|s| s == id) {
                sources.push(id.into());
            }
        }
    }
    let id = format!("context-handoff:{}", uuid::Uuid::new_v4());
    let transfer_id = transfer["id"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let from = runs
        .first()
        .and_then(|r| r["ordinal"].as_i64())
        .unwrap_or(1);
    let to = runs.last().and_then(|r| r["ordinal"].as_i64()).unwrap_or(0);
    let handoff = crate::context_handoff::prepare_provider_handoff(
        &id,
        thread,
        source,
        run,
        Some(&transfer_id),
        &sources,
        target,
        from,
        to,
        "full_thread_summary",
        &inherited,
        &runs,
        crate::context_handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
        now,
    );
    let side_handoff = if side_chat {
        let mut stmt = tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND ((r.ordinal>?2 AND r.status NOT IN ('queued','rolled_back')) OR (?2=0 AND i.run_id IS NULL AND json_extract((SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1),'$.historyOrigin')='v1_import')) ORDER BY i.ordinal")?;
        let items: Vec<Value> = stmt.query_map(params![source, through], |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery)).collect::<rusqlite::Result<_>>()?;
        let mut parent_items = if through == 0 { inherited_handoff_items(tx, source)? } else { vec![] };
        parent_items.extend(filter_handoff_items(tx, source, items)?);
        let mut ordinals = Vec::new();
        for item in &parent_items {
            if let Some(item_run) = item["runId"].as_str() {
                if let Some(ordinal) = tx.query_row("SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", params![source,item_run], |r| r.get::<_,i64>(0)).optional()? { ordinals.push(ordinal); }
            }
        }
        Some(crate::context_handoff::prepare_side_chat_context(tx, thread, source, run, &transfer_id, target, *ordinals.iter().min().unwrap_or(&1), *ordinals.iter().max().unwrap_or(&1), &parent_items, now)?)
    } else { None };
    transfer["targetProviderInstanceId"] = json!(instance);
    transfer["targetRunId"] = json!(run);
    transfer["status"] = json!("consumed");
    let no_source = side_chat && through == 0;
    let primary = if no_source { side_handoff.as_ref().ok_or(rusqlite::Error::InvalidQuery)? } else { &handoff };
    transfer["resolution"] = json!({"strategy":"portable_context","contextHandoffId":primary["id"]});
    transfer["error"] = Value::Null;
    transfer["updatedAt"] = json!(now);
    transfer["consumedAt"] = json!(now);
    if !no_source { tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,'full_thread_summary','ready',?5,?6)",params![id,thread,run,target,now,handoff.to_string()])?; }
    tx.execute("UPDATE orchestration_v2_projection_context_transfers SET target_run_id=?2,target_provider=?3,target_provider_instance_id=?3,status='consumed',updated_at=?4,payload_json=?5 WHERE context_transfer_id=?1",params![transfer_id,run,instance,now,transfer.to_string()])?;
    if no_source { Ok(Some((side_handoff.unwrap(), transfer, None))) } else { Ok(Some((handoff, transfer, side_handoff))) }
}

/// Commits events, projections, effect and receipt in one serialized transaction.
/// Dispatches a turn on an idle thread using its existing provider thread.
pub fn dispatch_first_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    dispatch_message_with_mode(bus, cmd, now, false)
}

/// Require an idle thread for an explicitly immediate dispatch.
pub fn dispatch_message_with_mode(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    require_idle: bool,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| dispatch_message_tx(tx, cmd, now, require_idle, None, None))
}

/// Dispatch with a per-run selection; queued runs apply it when promoted.
pub fn dispatch_with_selection(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    require_idle: bool,
    selection: &Value,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        dispatch_message_tx_inner(
            tx,
            cmd,
            now,
            require_idle,
            None,
            None,
            None,
            None,
            false,
            None,
            None,
            Some(selection),
            None,
        )
    })
}

/// Dispatch a fresh or workspace-prepared run with a per-run selection.
pub fn dispatch_selected_context(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    fresh: bool,
    deferred: Option<Option<&Value>>,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
    selection: &Value,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        dispatch_message_tx_inner(
            tx,
            cmd,
            now,
            false,
            None,
            None,
            None,
            deferred,
            fresh,
            sessions,
            None,
            Some(selection),
            None,
        )
    })
}

/// Prepare a run without starting its provider; release starts it after setup.
pub fn dispatch_deferred_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    workspace_strategy: Option<&Value>,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        dispatch_message_tx_inner(
            tx,
            cmd,
            now,
            false,
            None,
            None,
            None,
            Some(workspace_strategy),
            false,
            None,
            None,
            None,
            None,
        )
    })
}

/// Start workspace preparation for a fresh-context turn. If another run is
/// active, the existing dispatch rules queue it without starting preparation.
pub fn dispatch_fresh_deferred_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    workspace_strategy: Option<&Value>,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        dispatch_message_tx_inner(
            tx,
            cmd,
            now,
            false,
            None,
            None,
            None,
            Some(workspace_strategy),
            true,
            sessions,
            None,
            None,
            None,
        )
    })
}

/// Dispatch a fresh-context turn. Active threads queue it for a separate turn.
pub fn dispatch_fresh_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| dispatch_fresh_message_tx(tx, cmd, now, sessions, None))
}
/// Transactional variant for callers which must authorize and dispatch atomically.
pub fn dispatch_fresh_message_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
    sender_thread_id: Option<&str>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_inner(
        tx,
        cmd,
        now,
        false,
        None,
        None,
        sender_thread_id,
        None,
        true,
        sessions,
        None,
        None,
        None,
    )
}

/// Resolve automatic delivery against the same snapshot used to commit it.
pub fn dispatch_auto_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    dispatch_auto_selected(bus, cmd, now, None)
}

pub fn dispatch_auto_selected(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    now: &str,
    selection: Option<&Value>,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        let active: Option<(String, bool)> = tx.query_row("SELECT r.run_id, (r.status='running' AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns p WHERE p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') AND p.status='running') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='run_interrupt_request') AND lower(trim(COALESCE(json_extract(m.payload_json,'$.text'),''))) NOT IN ('/compact','/logout')) FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status IN ('preparing','starting','running','waiting') ORDER BY r.ordinal DESC LIMIT 1", [cmd.thread_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((target, true)) = active {
            steer_message_tx_options(tx, cmd, &target, now, None, &[], None, false, selection)
        } else {
            dispatch_message_tx_inner(tx, cmd, now, false, None, None, None, None, false, None, None, selection, None)
        }
    })
}

/// Redispatch a steer that was definitively not delivered, preserving its identity.
pub fn dispatch_steer_follow_up(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    source_run: &str,
    after_ordinal: Option<i64>,
    declined: bool,
    model_selection: Option<&Value>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    dispatch_steer_follow_up_with_delegated(
        bus,
        cmd,
        source_run,
        after_ordinal,
        declined,
        model_selection,
        None,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn dispatch_steer_follow_up_with_delegated(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    source_run: &str,
    after_ordinal: Option<i64>,
    declined: bool,
    model_selection: Option<&Value>,
    delegated: Option<&Value>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        dispatch_message_tx(
            tx,
            cmd,
            now,
            false,
            Some((
                source_run,
                after_ordinal,
                declined || delegated.is_some(),
                model_selection,
            )),
            delegated,
        )
    })
}

pub(crate) fn delegated_tasks(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    parent: &str,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND run_id=?2 AND origin='app_owned'")?;
    let values = stmt
        .query_map(params![thread, parent], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect();
    values
}

fn delegated_wake_detail(ids: &[Value], tasks: &[Value]) -> String {
    let mut remaining = 16000usize;
    ids.iter()
        .filter_map(Value::as_str)
        .map(|id| {
            let task = tasks.iter().find(|t| t["id"] == id);
            let mut label = format!("Delegated task {id}");
            if let Some(title) = task.and_then(|t| t["title"].as_str()) {
                label.push_str(&format!(" ({title})"));
            }
            match task {
                Some(t) => label.push_str(&format!(" [{}]", t["status"].as_str().unwrap_or(""))),
                None => label.push_str(" reached a terminal state"),
            }
            if let Some(result) = task.and_then(|t| t["result"].as_str()) {
                let detail = format!("{label}:\n{result}");
                if detail.len() <= remaining {
                    remaining -= detail.len();
                    return detail;
                }
            }
            format!("{label}. Use task_status with taskId {id} to read the result.")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn report_label(value: &str) -> Option<String> {
    let line = value.trim().lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    if line.encode_utf16().count() <= 80 {
        return Some(line.to_owned());
    }
    let mut units = 0;
    let prefix: String = line
        .chars()
        .take_while(|c| {
            let next = units + c.len_utf16();
            if next > 79 {
                false
            } else {
                units = next;
                true
            }
        })
        .collect();
    Some(format!("{prefix}…"))
}

pub(crate) fn delegated_notification(item: &mut Value, delegated: &Value, tasks: &[Value]) {
    let ids = delegated["taskIds"].as_array().cloned().unwrap_or_default();
    let reports: Vec<_> = ids
        .iter()
        .map(|id| tasks.iter().find(|t| t["id"] == *id))
        .collect();
    let outcomes: Vec<_> = reports
        .iter()
        .map(|task| match task.and_then(|t| t["status"].as_str()) {
            Some("failed") => "failed",
            Some("cancelled" | "interrupted") => "cancelled",
            Some("completed") => "completed",
            _ => "unknown",
        })
        .collect();
    let outcome = if outcomes.contains(&"failed") {
        "failed"
    } else if outcomes.contains(&"cancelled") {
        "cancelled"
    } else if !outcomes.is_empty() && outcomes.iter().all(|s| *s == "completed") {
        "completed"
    } else {
        "unknown"
    };
    let verb = match outcome {
        "failed" => "failed",
        "cancelled" => "stopped",
        _ => "finished",
    };
    let labels: Vec<String> = reports
        .iter()
        .filter_map(|t| {
            let t = t.as_ref()?;
            let label = t["title"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| t["prompt"].as_str())?;
            report_label(label)
        })
        .collect();
    let mut source = json!({"kind":"delegated_task","taskIds":ids});
    let summary = if ids.len() == 1 {
        if let Some(child) = reports[0].and_then(|t| t["childThreadId"].as_str()) {
            source["childThreadId"] = json!(child);
        }
        format!(
            "Delegated task{} {verb}",
            labels
                .first()
                .map(|l| format!(" \"{l}\""))
                .unwrap_or_default()
        )
    } else {
        let count = if tasks.len() > ids.len() {
            format!("{} of {}", ids.len(), tasks.len())
        } else {
            ids.len().to_string()
        };
        format!(
            "{count} delegated tasks {verb}{}",
            if labels.is_empty() {
                String::new()
            } else {
                format!(": {}", labels.join(", "))
            }
        )
    };
    let object = item.as_object_mut().unwrap();
    for key in [
        "messageId",
        "inputIntent",
        "text",
        "attachments",
        "createdBy",
        "creationSource",
        "scheduledTaskId",
        "modelSwitch",
    ] {
        object.remove(key);
    }
    object.insert("type".into(), json!("notification"));
    object.insert("source".into(), source);
    object.insert("outcome".into(), json!(outcome));
    object.insert("summary".into(), json!(summary));
}

/// Atomically check the durable reservation and dispatch its reserved message.
/// Stale or already delivered offers return `Ok(None)` without creating a receipt.
pub fn dispatch_delegated_completion(
    bus: &EventBus,
    request: &crate::delegated_continuation::ContinuationRequest,
    cwd: &str,
    now: &str,
) -> Result<Option<CommitResult>, DispatchError> {
    dispatch_delegated_completion_with_session(bus, request, cwd, now, |_| false)
}

/// Dispatch a wake into a live turn only when its provider session is known to
/// support active steering without interrupting tools. The callback must be a
/// nonblocking, read-only session lookup.
pub fn dispatch_delegated_completion_with_session(
    bus: &EventBus,
    request: &crate::delegated_continuation::ContinuationRequest,
    cwd: &str,
    now: &str,
    session_can_steer: impl Fn(&str) -> bool,
) -> Result<Option<CommitResult>, DispatchError> {
    bus.commit_with(|tx| {
        let key = &request.delegated_completion;
        let available: bool = tx.query_row("SELECT archived_at IS NULL AND deleted_at IS NULL FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&request.thread_id], |r| r.get(0)).optional()?.unwrap_or(false);
        if !available { return Ok((None, vec![])); }
        let Some(delivery) = crate::delegated_continuation::current_delivery(tx, &request.thread_id, key)? else { return Ok((None, vec![])); };
        let ids = delivery["taskIds"].as_array().ok_or(rusqlite::Error::InvalidQuery)?;
        let tasks = delegated_tasks(tx, &request.thread_id, &key.parent_run_id)?;
        let text = delegated_wake_detail(ids, &tasks);
        let metadata = json!({"parentRunId":key.parent_run_id,"generation":key.generation,"taskIds":ids});
        let command_id = format!("command:fixture:delegated-completion:dispatch:{}", uuid::Uuid::new_v4());
        let old_run: Option<String> = tx.query_row("SELECT run_id FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2", params![request.thread_id,key.message_id], |r| r.get(0)).optional()?.flatten();
        let cmd = DispatchMessage { context: None, command_id: &command_id, thread_id: &request.thread_id, message_id: &key.message_id, text: &text, attachments: &[], creation_source: "server", cwd, driver: &request.driver };
        // Existing mailbox messages are only redispatched through the queued
        // follow-up path; never send the same wake twice into a live turn.
        let all_always = !ids.is_empty() && ids.iter().all(|id| tasks.iter().any(|task| task["id"] == *id && task["completionWake"] == "always"));
        let target: Option<(String, String)> = if old_run.is_none() && all_always {
            tx.query_row("SELECT r.run_id, pt.provider_session_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id=json_extract(r.payload_json,'$.providerThreadId') JOIN orchestration_v2_projection_provider_turns p ON p.rowid=(SELECT p2.rowid FROM orchestration_v2_projection_provider_turns p2 WHERE p2.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') ORDER BY p2.rowid DESC LIMIT 1) LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status='running' AND p.status='running' AND pt.provider_session_id IS NOT NULL AND lower(trim(COALESCE(json_extract(m.payload_json,'$.text'),''))) NOT IN ('/compact','/logout') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='run_interrupt_request') ORDER BY r.ordinal DESC LIMIT 1", [&request.thread_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?
        } else { None };
        let (result, events) = if let Some((target, _)) = target.filter(|(_, session)| session_can_steer(session)) {
            steer_message_tx(tx, cmd, &target, now, Some(&metadata), &tasks)?
        } else {
            let follow = old_run.as_deref().map(|run| (run, None, false, None));
            dispatch_message_tx(tx, cmd, now, false, follow, Some(&metadata))?
        };
        Ok((Some(result), events))
    })
}

pub(crate) fn dispatch_message_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    require_idle: bool,
    follow_up: Option<(&str, Option<i64>, bool, Option<&Value>)>,
    delegated: Option<&Value>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_with_sender(tx, cmd, now, require_idle, follow_up, delegated, None)
}

pub(crate) fn dispatch_message_tx_with_sender(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    require_idle: bool,
    follow_up: Option<(&str, Option<i64>, bool, Option<&Value>)>,
    delegated: Option<&Value>,
    sender_thread_id: Option<&str>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_inner(
        tx,
        cmd,
        now,
        require_idle,
        follow_up,
        delegated,
        sender_thread_id,
        None,
        false,
        None,
        None,
        None,
        None,
    )
}

/// Construct a buffered provider continuation without starting another native prompt.
pub(crate) fn dispatch_provider_wake_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    notification: &Value,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_inner(
        tx,
        cmd,
        now,
        true,
        None,
        None,
        None,
        None,
        false,
        None,
        None,
        None,
        Some(notification),
    )
}

pub(crate) fn dispatch_agent_notification_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    notification: &Value,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_inner(
        tx,
        cmd,
        now,
        false,
        None,
        None,
        None,
        None,
        false,
        None,
        None,
        None,
        Some(notification),
    )
}

/// Dispatch a scheduled message with its task identity in the durable event.
pub(crate) fn dispatch_scheduled_message_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    task_id: &str,
    fresh: bool,
    deferred: Option<&Value>,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    dispatch_message_tx_inner(
        tx,
        cmd,
        now,
        false,
        None,
        None,
        None,
        deferred.map(Some),
        fresh,
        sessions,
        Some(task_id),
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn dispatch_message_tx_inner(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    now: &str,
    require_idle: bool,
    follow_up: Option<(&str, Option<i64>, bool, Option<&Value>)>,
    delegated: Option<&Value>,
    sender_thread_id: Option<&str>,
    deferred: Option<Option<&Value>>,
    fresh: bool,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
    scheduled_task_id: Option<&str>,
    selection_override: Option<&Value>,
    provider_notification: Option<&Value>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    if let Some(receipt) = event_store::get_receipt(tx, cmd.command_id, "thread")? {
        if receipt.aggregate_id != cmd.thread_id {
            return Err(DispatchError::CommandIdConflict);
        }
        return Ok((
            CommitResult {
                receipt,
                committed: false,
            },
            vec![],
        ));
    }
    let thread: Option<(String, Option<String>, Option<String>)> = tx.query_row("SELECT payload_json,archived_at,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1", [cmd.thread_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_runs WHERE thread_id=?1", [cmd.thread_id], |r| r.get(0))?;
    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))", [cmd.thread_id], |r| r.get(0))?;
    // An active run turns defer_start into an ordinary queued dispatch.
    let deferred = if active { None } else { deferred };
    let duplicate: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id=?1)",
        [cmd.message_id],
        |r| r.get(0),
    )?;
    let pending_fork: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type='fork' AND status='pending' LIMIT 1", [cmd.thread_id], |r|r.get(0)).optional()?;
    let mut fork_error = None;
    if !active {
        if let Some(ref raw) = pending_fork {
            let transfer: Value =
                serde_json::from_str(raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let id = transfer["id"].as_str().unwrap_or("");
            let is_side_chat = thread.as_ref().and_then(|(raw,_,_)| serde_json::from_str::<Value>(raw).ok()).is_some_and(|thread| thread["lineage"]["sideChat"] == true);
            if is_side_chat && !matches!(cmd.driver, "codex" | "claudeAgent" | "pi" | "opencode" | "cursor" | "muse" | "fx" | "grok" | "kiro" | "acpRegistry" | "antigravity") {
                fork_error = Some(format!("Side chat context delivery is not supported for provider {} in this configuration.", cmd.driver));
            }
            if let Some(source_run) = transfer["sourcePoint"]["runId"].as_str() {
                let resolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE r.thread_id=?1 AND r.run_id=?2)", params![transfer["sourceThreadId"].as_str(),source_run], |r|r.get(0))?;
                if !resolved {
                    fork_error = Some(format!(
                        "Pending fork transfer {id} has no resolvable source provider thread."
                    ));
                }
            }
            if fork_error.is_none() && transfer["sourceProviderInstanceId"].is_null() {
                fork_error = Some(format!(
                    "Pending fork transfer {id} has no source provider."
                ));
            }
        }
    }
    let merge_pending = crate::merge_handoff::pending(tx, cmd.thread_id, false)?;
    let merge_error = match &merge_pending {
        Err(error) => Some(error.clone()),
        _ => None,
    };
    let fresh_plan = if fresh && !active && thread.is_some() {
        crate::queue_promotion::fresh_context::plan(tx, cmd.thread_id, sessions, false)?
    } else {
        Ok(vec![])
    };
    let fresh_error = fresh_plan.as_ref().err().map(|e| (*e).to_owned());
    let reason = if thread.is_none() {
        Some(format!("Thread {} does not exist.", cmd.thread_id))
    } else if thread
        .as_ref()
        .is_some_and(|(_, a, d)| a.is_some() || d.is_some())
    {
        Some("Thread is archived or deleted.".into())
    } else if crate::rollback_commands::in_progress(tx, cmd.thread_id)? {
        Some("Wait for the thread rewind to finish before sending a message.".into())
    } else if fresh_error.is_some() {
        fresh_error
    } else if merge_error.is_some() {
        merge_error
    } else if duplicate && follow_up.is_none() {
        Some(format!("Message {} already exists.", cmd.message_id))
    } else if require_idle && active {
        Some("Immediate dispatch while a run is active is not supported.".into())
    } else {
        fork_error
    };
    let mut receipt = Receipt {
        command_id: cmd.command_id.into(),
        aggregate_kind: "thread".into(),
        aggregate_id: cmd.thread_id.into(),
        command_type: "message.dispatch".into(),
        accepted_at: now.into(),
        result_sequence: event_store::latest_thread_sequence(tx, Some(cmd.thread_id))?,
        status: if reason.is_some() {
            "rejected"
        } else {
            "accepted"
        }
        .into(),
        error: reason,
    };
    if !event_store::insert_receipt_if_absent(tx, &receipt)? {
        return Err(DispatchError::CommandIdConflict);
    }
    if receipt.error.is_some() {
        return Ok((
            CommitResult {
                receipt,
                committed: false,
            },
            vec![],
        ));
    }
    let mut thread: Value =
        serde_json::from_str(&thread.unwrap().0).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if let Some((source, _, declined, _)) = follow_up {
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_runs r ON r.run_id=m.run_id WHERE m.message_id=?1 AND m.thread_id=?2 AND m.run_id=?3 AND (?4=0 OR NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='run_interrupt_request')))", params![cmd.message_id,cmd.thread_id,source,declined], |r|r.get(0))?;
        if !valid {
            return Ok((
                CommitResult {
                    receipt,
                    committed: false,
                },
                vec![],
            ));
        }
    }
    let queue_tail_selection: Option<Value> = if active
        && selection_override.is_none()
        && follow_up.is_none()
        && delegated.is_none()
        && provider_notification.is_none()
    {
        tx.query_row(
            "SELECT json_extract(r.payload_json, '$.modelSelection') \
             FROM orchestration_v2_projection_runs r \
             LEFT JOIN orchestration_v2_projection_messages m \
               ON m.message_id = json_extract(r.payload_json, '$.userMessageId') \
              AND m.thread_id = r.thread_id \
             WHERE r.thread_id = ?1 \
               AND r.status = 'queued' \
               AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL \
               AND COALESCE(json_extract(m.payload_json, '$.followsThreadSelection'), 0) = 0 \
               AND COALESCE(json_extract(m.payload_json, '$.notification.source.kind'), '') != 'monitor' \
             ORDER BY COALESCE(CAST(json_extract(r.payload_json, '$.queuePosition') AS INTEGER), r.ordinal) DESC, r.ordinal DESC \
             LIMIT 1",
            [cmd.thread_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    } else {
        None
    };
    let selection = selection_override
        .or_else(|| {
            follow_up
                .and_then(|(_, _, declined, selection)| {
                    if declined || delegated.is_some() {
                        selection
                    } else {
                        None
                    }
                })
                .or(queue_tail_selection.as_ref())
                .or_else(|| thread.get("modelSelection"))
        })
        .filter(|v| v.is_object())
        .cloned();
    let instance = selection
        .as_ref()
        .and_then(|s| s.get("instanceId"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let Some(instance) = instance else {
        receipt.status = "rejected".into();
        receipt.error = Some("Thread has no valid provider selection.".into());
        event_store::upsert_receipt(tx, &receipt)?;
        return Ok((
            CommitResult {
                receipt,
                committed: false,
            },
            vec![],
        ));
    };
    let selection = selection.as_ref().unwrap();
    let run = run_id(cmd.thread_id, ordinal);
    let attempt = format!("run-attempt:run:{}:attempt:1", encode_id_part(&run));
    let node = format!("node:run:{}:root", encode_id_part(&run));
    let scope = format!("checkpoint-scope:thread:{}:name:root", cmd.thread_id);
    let conversation = if !fresh && delegated.is_none() {
        crate::conversation_provider::select(tx, cmd.thread_id)?
    } else {
        thread["activeProviderThreadId"].as_str().map(str::to_owned)
    };
    let existing: Option<String> = if let Some(id) = conversation {
        tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [id], |r| r.get(0)).optional()?
    } else if !fresh && delegated.is_none() {
        tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_instance_id=?2 AND owner_node_id IS NULL ORDER BY last_run_ordinal DESC LIMIT 1", params![cmd.thread_id, instance], |r| r.get(0)).optional()?
    } else {
        None
    };
    let existing: Option<Value> = existing
        .map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()?;
    let switching = existing
        .as_ref()
        .is_some_and(|p| p["providerInstanceId"] != instance);
    let existing = if fresh {
        None
    } else if switching {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_instance_id=?2 AND json_extract(payload_json,'$.ownerNodeId') IS NULL ORDER BY last_run_ordinal DESC LIMIT 1", params![cmd.thread_id,instance], |r| r.get(0)).optional()?;
        raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
            .transpose()?
    } else {
        existing
    };
    let pt = existing
        .as_ref()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| pending_provider_thread_id(cmd.driver, &run));
    let mut session = existing
        .as_ref()
        .and_then(|p| p.get("providerSessionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if cmd.driver == "codex" {
                format!(
                    "provider-session:provider-instance:{}:shared",
                    encode_id_part(instance)
                )
            } else {
                format!("provider-session:{}", uuid::Uuid::new_v4())
            }
        });
    if fresh
        && !active
        && crate::queue_promotion::fresh_context::needs_new_session(tx, cmd.thread_id, &session)?
    {
        session = format!("provider-session:{}", uuid::Uuid::new_v4());
    }
    let item = format!("turn-item:message:{}", cmd.message_id);
    let is_new_provider = existing.is_none();
    let mut provider_thread=existing.unwrap_or_else(|| json!({"id":pt,"driver":cmd.driver,"providerInstanceId":instance,"providerSessionId":session,"appThreadId":cmd.thread_id,"ownerNodeId":null,"nativeThreadRef":null,"nativeConversationHeadRef":null,"status":"not_loaded","firstRunOrdinal":ordinal,"lastRunOrdinal":ordinal,"handoffIds":[],"forkedFrom":null,"pendingBackgroundTasks":[],"contextUsage":null,"nativeMetadata":null,"goal":null,"createdAt":now,"updatedAt":now}));
    if !active {
        if provider_thread["firstRunOrdinal"].is_null() {
            provider_thread["firstRunOrdinal"] = json!(ordinal);
        }
        if provider_thread["providerSessionId"].is_null() {
            provider_thread["providerSessionId"] = json!(session);
        }
        provider_thread["lastRunOrdinal"] = json!(ordinal);
        provider_thread["updatedAt"] = json!(now);
    } else if is_new_provider {
        provider_thread["providerSessionId"] = Value::Null;
        provider_thread["firstRunOrdinal"] = Value::Null;
        provider_thread["lastRunOrdinal"] = Value::Null;
    }
    let mut turn_ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),?2)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<?2+1000000", params![cmd.thread_id, ordinal * 1_000_000], |r| r.get(0))?;
    let mut queue_position: i64 = tx.query_row("SELECT COALESCE(MAX(COALESCE(CAST(json_extract(payload_json,'$.queuePosition') AS INTEGER),ordinal)),0)+1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued'", [cmd.thread_id], |r| r.get(0))?;
    let mut shifted_runs = Vec::new();
    if let Some((_, Some(after), true, _)) = follow_up {
        queue_position = tx.query_row("SELECT COALESCE(MAX(COALESCE(CAST(json_extract(q.payload_json,'$.queuePosition') AS INTEGER),q.ordinal)),0)+1 FROM orchestration_v2_projection_runs q WHERE q.thread_id=?1 AND q.status='queued' AND (q.ordinal<=?2 OR json_extract(q.payload_json,'$.userMessageId') IN (SELECT json_extract(i.payload_json,'$.messageId') FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=?1 AND i.type='user_message' AND i.ordinal < COALESCE((SELECT ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_message' AND json_extract(payload_json,'$.messageId')=?3 LIMIT 1),-1)))",params![cmd.thread_id,after,cmd.message_id],|r|r.get(0))?;
        let mut stmt = tx.prepare("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.queuePosition',COALESCE(CAST(json_extract(payload_json,'$.queuePosition') AS INTEGER),ordinal)+1) WHERE thread_id=?1 AND status='queued' AND COALESCE(CAST(json_extract(payload_json,'$.queuePosition') AS INTEGER),ordinal)>=?2 RETURNING payload_json")?;
        let rows = stmt.query_map(params![cmd.thread_id, queue_position], |r| {
            r.get::<_, String>(0)
        })?;
        for row in rows {
            shifted_runs.push(
                serde_json::from_str::<Value>(&row?).map_err(|_| rusqlite::Error::InvalidQuery)?,
            );
        }
    }
    let preparing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='preparing')", [cmd.thread_id], |r| r.get(0))?;
    let with_scope = deferred.is_none() && (!active || !preparing);
    let run_status = if active {
        "queued"
    } else if deferred.is_some() {
        "preparing"
    } else {
        "starting"
    };
    let mut run_payload = json!({"id":run,"threadId":cmd.thread_id,"ordinal":ordinal,"providerInstanceId":instance,"modelSelection":selection,"providerThreadId":pt,"userMessageId":cmd.message_id,"rootNodeId":node,"activeAttemptId":attempt,"status":run_status,"queuePosition":if active { Some(queue_position) } else { None },"requestedAt":now,"startedAt":null,"completedAt":null,"checkpointId":null,"contextHandoffId":null});
    if fresh {
        run_payload["freshContext"] = json!(true);
    }
    if let Some(Some(strategy)) = deferred {
        run_payload["workspacePreparation"] = strategy.clone();
    }
    let attempt_payload = json!({"id":attempt,"runId":run,"attemptOrdinal":1,"rootNodeId":node,"providerInstanceId":instance,"providerThreadId":pt,"providerTurnId":null,"reason":"initial","status":"pending","startedAt":null,"completedAt":null});
    let node_payload = json!({"id":node,"threadId":cmd.thread_id,"runId":run,"parentNodeId":null,"rootNodeId":node,"kind":"root_turn","status":"pending","countsForRun":true,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"runtimeRequestId":null,"checkpointScopeId":if with_scope { Some(&scope) } else { None },"startedAt":null,"completedAt":null});
    let scope_payload = json!({"id":scope,"threadId":cmd.thread_id,"runId":run,"nodeId":node,"parentScopeId":null,"providerThreadId":pt,"kind":"root_run","ordinalWithinParent":0,"advancesAppRunCount":true,"cwd":cmd.cwd,"createdAt":now});
    let mut message = json!({"createdBy":"user","creationSource":cmd.creation_source,"id":cmd.message_id,"threadId":cmd.thread_id,"runId":run,"nodeId":node,"role":"user","text":cmd.text,"attachments":cmd.attachments,"streaming":false,"createdAt":now,"updatedAt":now});
    if let Some(context) = cmd.context {
        message["context"] = context.clone();
    }
    let mut item_payload = json!({"createdBy":"user","creationSource":cmd.creation_source,"id":item,"threadId":cmd.thread_id,"runId":run,"nodeId":node,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":turn_ordinal,"status":"completed","title":null,"startedAt":now,"completedAt":now,"updatedAt":now,"type":"user_message","messageId":cmd.message_id,"inputIntent":"turn_start","text":cmd.text,"attachments":cmd.attachments});
    if let Some(context) = cmd.context {
        item_payload["context"] = context.clone();
    }
    if let Some(notification) = provider_notification {
        message["createdBy"] = json!("agent");
        message["notification"] = notification.clone();
        if let Some(obj) = item_payload.as_object_mut() {
            for key in [
                "createdBy",
                "creationSource",
                "type",
                "messageId",
                "inputIntent",
                "text",
                "attachments",
                "scheduledTaskId",
                "modelSwitch",
            ] {
                obj.remove(key);
            }
            obj.insert("type".into(), json!("notification"));
            if let Some(fields) = notification.as_object() {
                for (key, value) in fields {
                    obj.insert(key.clone(), value.clone());
                }
            }
        }
    }
    if let Some(task_id) = scheduled_task_id {
        message["scheduledTaskId"] = json!(task_id);
        item_payload["scheduledTaskId"] = json!(task_id);
    }
    if fresh {
        item_payload["freshContext"] = json!(true);
    }
    if let Some(sender) = sender_thread_id {
        message["createdBy"] = json!("agent");
        message["senderThreadId"] = json!(sender);
        item_payload["createdBy"] = json!("agent");
        item_payload["senderThreadId"] = json!(sender);
    }
    if follow_up.is_some() {
        let old: String = tx.query_row(
            "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",
            [cmd.message_id],
            |r| r.get(0),
        )?;
        message = serde_json::from_str(&old).map_err(|_| rusqlite::Error::InvalidQuery)?;
        message["runId"] = json!(run);
        message["nodeId"] = json!(node);
        message["updatedAt"] = json!(now);
        let old: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",[&item],|r|r.get(0)).optional()?;
        if let Some(old) = old {
            item_payload = serde_json::from_str(&old).map_err(|_| rusqlite::Error::InvalidQuery)?;
            item_payload["runId"] = json!(run);
            item_payload["nodeId"] = json!(node);
            item_payload["providerThreadId"] = json!(pt);
            item_payload["providerTurnId"] = Value::Null;
            item_payload["updatedAt"] = json!(now);
            if active {
                item_payload["status"] = json!("pending");
                item_payload["inputIntent"] = json!("queued_turn");
                item_payload["startedAt"] = Value::Null;
                item_payload["completedAt"] = Value::Null;
            }
        }
    }
    if let Some(delegated) = delegated {
        message["createdBy"] = json!("agent");
        message["delegatedCompletion"] = delegated.clone();
        message["text"] = json!(cmd.text);
        item_payload["createdBy"] = json!("agent");
        item_payload["text"] = json!(cmd.text);
        let tasks = delegated_tasks(
            tx,
            cmd.thread_id,
            delegated["parentRunId"].as_str().unwrap_or(""),
        )?;
        delegated_notification(&mut item_payload, delegated, &tasks);
    }
    let mut payloads = Vec::new();
    if provider_notification.is_none()
        && thread.get("lastVisitedAt").is_none_or(Value::is_null)
        && !matches!(cmd.text.trim(), "/compact" | "/logout")
    {
        let previous = chrono::DateTime::parse_from_rfc3339(now)
            .map(|t| {
                (t - chrono::Duration::milliseconds(1))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|_| now.to_owned());
        thread["lastVisitedAt"] = json!(previous);
        payloads.push(("thread.metadata-updated", thread.clone()));
    }
    if !active
        && (!crate::provider_selection::selections_equal(&thread["modelSelection"], selection)
            || thread["providerInstanceId"] != instance)
    {
        let kind = if thread["providerInstanceId"] == instance {
            "thread.model-selection-updated"
        } else {
            "thread.provider-switched"
        };
        thread["providerInstanceId"] = json!(instance);
        thread["modelSelection"] = selection.clone();
        thread["updatedAt"] = json!(now);
        payloads.push((kind, thread.clone()));
    }
    if !active || is_new_provider {
        payloads.push(("provider-thread.updated", provider_thread.clone()));
    }
    let mut handoff_items = Vec::new();
    let mut portable_fork = false;
    let mut switch_handoff = false;
    if !active && !fresh {
        if let Some((handoff, transfer, side_handoff)) =
            prepare_fork_handoff(tx, cmd.thread_id, &run, &pt, instance, cmd.driver, now)?
        {
            portable_fork = true;
            run_payload["contextHandoffId"] = handoff["id"].clone();
            provider_thread["handoffIds"]
                .as_array_mut()
                .unwrap()
                .push(handoff["id"].clone());
            if let Some((_, p)) = payloads
                .iter_mut()
                .find(|(kind, _)| *kind == "provider-thread.updated")
            {
                *p = provider_thread.clone();
            }
            if thread["lineage"]["sideChat"] != true {
                let mut item =
                    handoff_turn_item(tx, &handoff, &run_payload, &node, turn_ordinal, now)?;
                item["title"] = json!("Fork context");
                handoff_items.push(item);
                turn_ordinal += 1;
                item_payload["ordinal"] = json!(turn_ordinal);
            }
            payloads.push(("context-handoff.updated", handoff));
            if let Some(side) = side_handoff { provider_thread["handoffIds"].as_array_mut().unwrap().push(side["id"].clone()); if let Some((_, p)) = payloads.iter_mut().find(|(kind, _)| *kind == "provider-thread.updated") { *p = provider_thread.clone(); } payloads.push(("context-handoff.updated", side)); }
            payloads.push(("context-transfer.updated", transfer));
        }
    }
    if !fresh && switching && !active {
        if let Some((handoff, transfer)) =
            prepare_switch_handoff(tx, cmd.thread_id, &run, &pt, instance, now, matches!(&merge_pending, Ok(Some(_))))?
        {
            switch_handoff = true;
            if !portable_fork { run_payload["contextHandoffId"] = handoff["id"].clone(); }
            provider_thread["handoffIds"]
                .as_array_mut()
                .unwrap()
                .push(handoff["id"].clone());
            // Replace the provider projection event with the final handoff ids.
            if let Some((_, p)) = payloads
                .iter_mut()
                .find(|(kind, _)| *kind == "provider-thread.updated")
            {
                *p = provider_thread.clone();
            }
            payloads.push(("context-transfer.created", transfer));
            if !portable_fork || thread["lineage"]["sideChat"] == true { handoff_items.push(handoff_turn_item(
                tx,
                &handoff,
                &run_payload,
                &node,
                turn_ordinal,
                now,
            )?);
            turn_ordinal += 1;
            item_payload["ordinal"] = json!(turn_ordinal); }
            payloads.push(("context-handoff.updated", handoff));
        }
    }
    if !fresh && !active {
        if let Ok(Some(pending)) = merge_pending {
            let (handoff, events) = crate::merge_handoff::consume(
                tx,
                pending,
                cmd.thread_id,
                &run,
                &pt,
                instance,
                now,
            )?;
            if handoff_items.is_empty() && !portable_fork { run_payload["contextHandoffId"] = handoff["id"].clone(); }
            provider_thread["handoffIds"].as_array_mut().unwrap().push(handoff["id"].clone());
            if let Some((_, p)) = payloads.iter_mut().find(|(kind, _)| *kind == "provider-thread.updated") {
                *p = provider_thread.clone();
            }
            if !portable_fork || thread["lineage"]["sideChat"] == true {
                let has_switch = !handoff_items.is_empty();
                if has_switch { handoff_items.clear(); turn_ordinal -= 1; }
                let mut item = handoff_turn_item(tx, &handoff, &run_payload, &node, turn_ordinal, now)?;
                item["title"] = json!(if portable_fork { "Fork context" } else if switch_handoff { "Provider handoff" } else { "Merge-back context" });
                handoff_items.push(item);
                turn_ordinal += 1;
                item_payload["ordinal"] = json!(turn_ordinal);
            }
            payloads.extend(events);
        }
    }
    if !fresh && !active && handoff_items.is_empty() && thread["historyOrigin"] == "v1_import" {
        let active_provider: Option<Value> = if let Some(id) =
            thread["activeProviderThreadId"].as_str()
        {
            let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2",params![cmd.thread_id,id],|r|r.get(0)).optional()?;
            raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
                .transpose()?
        } else {
            None
        };
        if let Some(handoff) = crate::context_handoff::prepare_legacy_import(
            tx,
            &thread,
            active_provider.as_ref(),
            &run,
            &pt,
            now,
        )? {
            run_payload["contextHandoffId"] = handoff["id"].clone();
            provider_thread["handoffIds"]
                .as_array_mut()
                .ok_or(rusqlite::Error::InvalidQuery)?
                .push(handoff["id"].clone());
            if let Some((_, p)) = payloads
                .iter_mut()
                .find(|(kind, _)| *kind == "provider-thread.updated")
            {
                *p = provider_thread.clone();
            }
            handoff_items.push(handoff_turn_item(
                tx,
                &handoff,
                &run_payload,
                &node,
                turn_ordinal,
                now,
            )?);
            turn_ordinal += 1;
            item_payload["ordinal"] = json!(turn_ordinal);
            payloads.push(("context-handoff.updated", handoff));
        }
    }
    payloads.extend(
        [
            ("run.created", &run_payload),
            ("run-attempt.created", &attempt_payload),
            ("node.updated", &node_payload),
        ]
        .into_iter()
        .map(|(k, v)| (k, v.clone())),
    );
    for run in shifted_runs {
        payloads.push(("run.updated", run));
    }
    if with_scope {
        payloads.push(("checkpoint-scope.created", scope_payload.clone()));
    }
    for item in &handoff_items {
        payloads.push(("turn-item.updated", item.clone()));
    }
    payloads.push(("message.updated", message.clone()));
    if !active || follow_up.is_some() {
        payloads.push(("turn-item.updated", item_payload.clone()));
    }
    let preparation_item = deferred.map(|_| json!({"id":format!("turn-item:provider:{}:native-item:{}", encode_id_part(cmd.driver), encode_id_part(&format!("workspace-preparation:{run}"))), "threadId":cmd.thread_id,"runId":run,"nodeId":node,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":turn_ordinal+1,"status":"running","title":"Preparing workspace","startedAt":now,"completedAt":null,"updatedAt":now,"type":"command_execution","input":"Preparing workspace"}));
    if let Some(item) = &preparation_item {
        payloads.push(("turn-item.updated", item.clone()));
    }
    if fresh && !active {
        let detach = crate::queue_promotion::fresh_context::detach(
            tx,
            cmd.thread_id,
            cmd.command_id,
            &fresh_plan.unwrap_or_default(),
            Some(&session),
            now,
        )?;
        payloads.extend(detach.into_iter().map(|v| ("provider-session.detached", v)));
    }
    let events: Vec<Event> = payloads
        .iter()
        .map(|(kind, payload)| Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: cmd.thread_id.into(),
            event_type: (*kind).into(),
            occurred_at: now.into(),
            command_id: Some(cmd.command_id.into()),
            causation_event_id: None,
            correlation_id: Some(cmd.command_id.into()),
            actor_kind: if provider_notification.is_some() {
                "provider"
            } else {
                "client"
            }
            .into(),
            payload: payload.clone(),
            metadata: json!({}),
        })
        .collect();
    let stored = event_store::append(tx, &events)?;
    if !active {
        thread["activeProviderThreadId"] = json!(pt);
    }
    // Run/message events advance the thread activity timestamp in the upstream projection.
    thread["updatedAt"] = json!(now);
    tx.execute(
        "UPDATE orchestration_v2_projection_threads SET payload_json=?2,updated_at=?3,provider_instance_id=?4 WHERE thread_id=?1",
        params![cmd.thread_id, thread.to_string(), now, thread["providerInstanceId"].as_str()],
    )?;
    if !active || is_new_provider {
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,'not_loaded',?8,?8,?6,?7) ON CONFLICT(provider_thread_id) DO UPDATE SET last_run_ordinal=excluded.last_run_ordinal,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![pt,cmd.thread_id,cmd.driver,instance,if active { None } else { Some(&session) },now,provider_thread.to_string(),if active { None } else { Some(ordinal) }])?;
    }
    tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES (?1,?2,?8,?3,?4,?5,?9,?6,?7)",params![run,cmd.thread_id,cmd.driver,instance,pt,now,run_payload.to_string(),ordinal,run_status])?;
    tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,status,payload_json) VALUES (?1,?2,?3,1,?4,?5,?6,?7,'pending',?8)",params![attempt,cmd.thread_id,run,node,cmd.driver,instance,pt,attempt_payload.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,provider_thread_id,checkpoint_scope_id,payload_json) VALUES (?1,?2,?3,?1,'root_turn','pending',?4,?5,?6)",params![node,cmd.thread_id,run,pt,if with_scope { Some(&scope) } else { None },node_payload.to_string()])?;
    if with_scope {
        tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,run_id,node_id,provider_thread_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES (?1,?2,?3,?4,?5,'root_run',0,1,?6,?7) ON CONFLICT(scope_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,provider_thread_id=excluded.provider_thread_id,created_at=excluded.created_at,payload_json=excluded.payload_json",params![scope,cmd.thread_id,run,node,pt,now,scope_payload.to_string()])?;
    }
    let normalized_turn_item = |id: &str, fallback: &Value| -> Value {
        stored
            .iter()
            .rev()
            .find(|e| e.event.event_type == "turn-item.updated" && e.event.payload["id"].as_str() == Some(id))
            .map(|e| e.event.payload.clone())
            .unwrap_or_else(|| fallback.clone())
    };
    for handoff_item in &handoff_items {
        let id = handoff_item["id"].as_str().unwrap_or("");
        let normalized = normalized_turn_item(id, handoff_item);
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,'handoff','completed',?7,?8)",params![normalized["id"].as_str(),cmd.thread_id,run,node,pt,normalized["ordinal"].as_i64(),now,normalized.to_string()])?;
    }
    tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,?2,?3,?4,'user',0,?5,?5,?6) ON CONFLICT(message_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![cmd.message_id,cmd.thread_id,run,node,now,message.to_string()])?;
    if !active || follow_up.is_some() {
        let normalized = normalized_turn_item(&item, &item_payload);
        let normalized_ordinal = normalized["ordinal"].as_i64().unwrap_or(turn_ordinal);
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?8,?10,?9,?6,?7) ON CONFLICT(turn_item_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,provider_thread_id=excluded.provider_thread_id,ordinal=excluded.ordinal,type=excluded.type,status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,cmd.thread_id,run,node,pt,now,normalized.to_string(),normalized_ordinal,if active {"pending"} else {"completed"},normalized["type"].as_str()])?;
    }
    if let Some(prep_item) = &preparation_item {
        let id = prep_item["id"].as_str().unwrap_or("");
        let normalized = normalized_turn_item(id, prep_item);
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,'command_execution','running',?7,?8)", params![normalized["id"].as_str(),cmd.thread_id,run,node,pt,normalized["ordinal"].as_i64(),now,normalized.to_string()])?;
    }
    let effect = Effect {
        id: format!("effect:{}:provider-turn.start:{}", cmd.command_id, run),
        command_id: cmd.command_id.into(),
        thread_id: cmd.thread_id.into(),
        request: json!({"type":"provider-turn.start","runId":run}),
        status: "pending".into(),
        attempt_count: 0,
        available_at: now.into(),
        lease_owner: None,
        created_at: now.into(),
        updated_at: now.into(),
        completed_at: None,
        last_error: None,
    };
    if !active && deferred.is_none() && (!require_idle || provider_notification.is_none()) {
        outbox::enqueue(tx, &effect)?;
    }
    receipt.result_sequence = stored.last().unwrap().sequence;
    event_store::upsert_receipt(tx, &receipt)?;
    Ok((
        CommitResult {
            receipt,
            committed: true,
        },
        stored,
    ))
}

/// Advance workspace preparation. The caller validates the command schema and supplies
/// the current effective workspace path for release.
pub fn prepared_run_command(
    bus: &EventBus,
    command: &Value,
    cwd: &str,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    let id = command["commandId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let thread = command["threadId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let run_id = command["runId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let kind = command["type"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    bus.commit_with(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx,id,"thread")? {
            if receipt.aggregate_id != thread { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult { receipt, committed:false },vec![]));
        }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![thread,run_id],|r|r.get(0)).optional()?;
        let mut run: Value = raw.as_deref().map(serde_json::from_str).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?.unwrap_or(Value::Null);
        let raw_item: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='command_execution' AND json_extract(payload_json,'$.input')='Preparing workspace'",params![thread,run_id],|r|r.get(0)).optional()?;
        let mut item: Value = raw_item.as_deref().map(serde_json::from_str).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?.unwrap_or(Value::Null);
        let failure_raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='error' AND status='failed' AND json_extract(payload_json,'$.failure.code')='workspace_preparation_failed' LIMIT 1",params![thread,run_id],|r|r.get(0)).optional()?;
        let thread_live: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL)",[thread],|r|r.get(0))?;
        let other_active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id<>?2 AND status IN ('preparing','starting','running','waiting'))",params![thread,run_id],|r|r.get(0))?;
        let latest_executed: Option<String> = tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status<>'queued' AND NOT(status='cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL) ORDER BY CASE WHEN json_extract(payload_json,'$.completedAt') IS NULL THEN 1 ELSE 0 END DESC, json_extract(payload_json,'$.completedAt') DESC, ordinal DESC LIMIT 1",[thread],|r|r.get(0)).optional()?;
        let components: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1 AND thread_id=?4) AND EXISTS(SELECT 1 FROM orchestration_v2_projection_nodes WHERE node_id=?2 AND thread_id=?4) AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?3 AND thread_id=?4)",params![run["activeAttemptId"].as_str(),run["rootNodeId"].as_str(),run["providerThreadId"].as_str(),thread],|r|r.get(0))?;
        let valid = components && !item.is_null() && if kind == "prepared-run.retry" { run["status"] == "failed" && !run["workspacePreparation"].is_null() && failure_raw.is_some() && thread_live && !other_active } else { matches!(kind,"prepared-run.release"|"prepared-run.progress"|"prepared-run.fail") && run["status"] == "preparing" };
        let mut receipt = Receipt { command_id:id.into(), aggregate_kind:"thread".into(), aggregate_id:thread.into(), command_type:kind.into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(thread))?, status:if valid {"accepted"} else {"rejected"}.into(), error:if valid {None} else if kind == "prepared-run.retry" && components && !item.is_null() && run["status"] == "failed" && !run["workspacePreparation"].is_null() && failure_raw.is_some() && thread_live && other_active {Some("Another run is active on this thread.".into())} else if kind == "prepared-run.retry" {Some(format!("Run {run_id} has no failed workspace preparation to retry."))} else {Some(format!("Run {run_id} is not awaiting workspace preparation."))} };
        event_store::insert_receipt_if_absent(tx,&receipt)?;
        if !valid { return Ok((CommitResult {receipt,committed:false},vec![])); }
        let mut payloads: Vec<(&str, Value)> = Vec::new();
        if kind == "prepared-run.progress" {
            item["title"] = json!(if command["phase"] == "worktree" { "Preparing worktree" } else { "Starting setup script" });
            item["updatedAt"] = json!(now);
        } else if kind == "prepared-run.fail" || kind == "prepared-run.retry" {
            let retry = kind == "prepared-run.retry";
            let node_id=run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let attempt_id=run["activeAttemptId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let raw_node:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1 AND thread_id=?2",params![node_id,thread],|r|r.get(0))?;
            let raw_attempt:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1 AND thread_id=?2",params![attempt_id,thread],|r|r.get(0))?;
            let mut node:Value=serde_json::from_str(&raw_node).map_err(|_|rusqlite::Error::InvalidQuery)?;
            let mut attempt:Value=serde_json::from_str(&raw_attempt).map_err(|_|rusqlite::Error::InvalidQuery)?;
            if retry {
                let mut failure:Value=serde_json::from_str(failure_raw.as_ref().unwrap()).map_err(|_|rusqlite::Error::InvalidQuery)?;
                failure["status"]=json!("cancelled"); failure["updatedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![failure["id"].as_str(),now,failure.to_string()])?;
                payloads.push(("turn-item.updated",failure));
                item.as_object_mut().unwrap().remove("output"); item.as_object_mut().unwrap().remove("exitCode");
                item["status"]=json!("running"); item["title"]=json!("Preparing workspace"); item["completedAt"]=Value::Null;
            } else {
                item["status"]=json!("failed"); item["title"]=json!("Workspace preparation failed"); item["output"]=command["failure"]["message"].clone(); item["exitCode"]=json!(1); item["completedAt"]=json!(now);
            }
            item["updatedAt"]=json!(now);
            let status=if retry {"pending"} else {"failed"};
            let completed=if retry {Value::Null} else {json!(now)};
            attempt["status"]=json!(status); attempt["completedAt"]=completed.clone(); node["status"]=json!(status); node["completedAt"]=completed.clone();
            tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status=?2,payload_json=?3 WHERE attempt_id=?1",params![attempt_id,status,attempt.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,payload_json=?3 WHERE node_id=?1",params![node_id,status,node.to_string()])?;
            payloads.push(("run-attempt.updated",attempt)); payloads.push(("node.updated",node));
            if !retry {
                let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0))?;
                let driver:String=tx.query_row("SELECT provider FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0))?;
                let error_id=format!("turn-item:provider:{}:native-item:{}",encode_id_part(&driver),encode_id_part(&format!("workspace-preparation-failure:{run_id}")));
                let mut failure=command["failure"].clone(); failure["code"]=json!("workspace_preparation_failed");
                let error=json!({"id":error_id,"threadId":thread,"runId":run_id,"nodeId":node_id,"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"failed","title":"Workspace preparation failed","startedAt":now,"completedAt":now,"updatedAt":now,"type":"error","failure":failure});
                tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'error','failed',?7,?8) ON CONFLICT(turn_item_id) DO UPDATE SET ordinal=excluded.ordinal,status='failed',updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![error_id,thread,run_id,node_id,run["providerThreadId"].as_str(),ordinal,now,error.to_string()])?;
                payloads.push(("turn-item.updated",error));
            }
            run["status"]=json!(if retry {"preparing"} else {"failed"}); run["completedAt"]=completed;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status=?2,payload_json=?3 WHERE run_id=?1",params![run_id,run["status"].as_str(),run.to_string()])?;
            if retry && latest_executed.as_deref()==Some(run_id) {
                    let mut stmt=tx.prepare("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.queueHeld',json('false')) WHERE thread_id=?1 AND status='queued' AND json_extract(payload_json,'$.queueHeld')=1 RETURNING payload_json")?;
                    let rows=stmt.query_map([thread],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    for raw in rows { payloads.push(("run.updated",serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?)); }
            }
        } else {
            let node_id=run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let pt=run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
            let raw_node:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1 AND thread_id=?2",params![node_id,thread],|r|r.get(0))?;
            let mut node:Value=serde_json::from_str(&raw_node).map_err(|_|rusqlite::Error::InvalidQuery)?;
            let scope=format!("checkpoint-scope:thread:{thread}:name:root");
            let scope_value=json!({"id":scope,"threadId":thread,"runId":run_id,"nodeId":node_id,"parentScopeId":null,"providerThreadId":pt,"kind":"root_run","ordinalWithinParent":0,"advancesAppRunCount":true,"cwd":cwd,"createdAt":now});
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,run_id,node_id,provider_thread_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES (?1,?2,?3,?4,?5,'root_run',0,1,?6,?7) ON CONFLICT(scope_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,provider_thread_id=excluded.provider_thread_id,created_at=excluded.created_at,payload_json=excluded.payload_json",params![scope,thread,run_id,node_id,pt,now,scope_value.to_string()])?;
            node["checkpointScopeId"]=json!(scope);
            tx.execute("UPDATE orchestration_v2_projection_nodes SET checkpoint_scope_id=?2,payload_json=?3 WHERE node_id=?1",params![node_id,scope,node.to_string()])?;
            payloads.push(("checkpoint-scope.created",scope_value)); payloads.push(("node.updated",node));
            item["status"]=json!("completed"); item["title"]=json!("Workspace ready"); item["output"]=json!("Workspace preparation completed."); item["exitCode"]=json!(0); item["completedAt"]=json!(now); item["updatedAt"]=json!(now);
            run["status"]=json!("starting");
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',payload_json=?2 WHERE run_id=?1",params![run_id,run.to_string()])?;
            outbox::enqueue(tx,&Effect { id:format!("effect:{id}:provider-turn.start:{run_id}"),command_id:id.into(),thread_id:thread.into(),request:json!({"type":"provider-turn.start","runId":run_id}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None })?;
        }
        tx.execute("UPDATE orchestration_v2_projection_turn_items SET status=?2,updated_at=?3,payload_json=?4 WHERE turn_item_id=?1",params![item["id"].as_str(),item["status"].as_str(),now,item.to_string()])?;
        payloads.push(("turn-item.updated",item));
        if kind != "prepared-run.progress" { payloads.push(("run.updated",run)); }
        if kind == "prepared-run.fail" {
            // The preparation item precedes the error item in the event stream.
            if let Some(index)=payloads.iter().position(|(kind,p)| *kind=="turn-item.updated" && p["type"]=="error") {
                let error=payloads.remove(index);
                let item_index=payloads.iter().position(|(kind,p)| *kind=="turn-item.updated" && p["type"]=="command_execution").unwrap();
                payloads.insert(item_index+1,error);
            }
        } else if kind == "prepared-run.retry" {
            if let Some(index)=payloads.iter().position(|(kind,p)| *kind=="turn-item.updated" && p["type"]=="command_execution") {
                let preparation=payloads.remove(index); payloads.insert(1,preparation);
            }
            if let Some(index)=payloads.iter().position(|(kind,p)| *kind=="run.updated" && p["id"]==run_id) {
                let main_run=payloads.remove(index); payloads.insert(4,main_run);
            }
        }
        let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event { id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(id.into()),causation_event_id:None,correlation_id:Some(id.into()),actor_kind:"client".into(),payload,metadata:json!({}) }).collect();
        let stored=event_store::append(tx,&events)?; receipt.result_sequence=stored.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult {receipt,committed:true},stored))
    })
}

/// Append a user steer to a running provider turn and enqueue its delivery atomically.
pub fn steer_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| steer_message_tx(tx, cmd, target, now, None, &[]))
}

pub(crate) fn steer_message_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
    delegated: Option<&Value>,
    tasks: &[Value],
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    steer_message_tx_with_sender(tx, cmd, target, now, delegated, tasks, None)
}

pub(crate) fn steer_message_tx_with_sender(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
    delegated: Option<&Value>,
    tasks: &[Value],
    sender: Option<&str>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    steer_message_tx_options(tx, cmd, target, now, delegated, tasks, sender, false, None)
}

/// Force interrupt-and-restart, preserving a transaction supplied by the caller.
#[allow(clippy::too_many_arguments)]
pub fn restart_message_tx(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
    sender: Option<&str>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    steer_message_tx_options(tx, cmd, target, now, None, &[], sender, true, None)
}

/// Force a restart using the normal event bus transaction.
pub fn restart_message(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| restart_message_tx(tx, cmd, target, now, None))
}

pub fn steer_selected(
    bus: &EventBus,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
    selection: &Value,
    restart: bool,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
        steer_message_tx_options(
            tx,
            cmd,
            target,
            now,
            None,
            &[],
            None,
            restart,
            Some(selection),
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn steer_message_tx_options(
    tx: &rusqlite::Transaction<'_>,
    cmd: DispatchMessage<'_>,
    target: &str,
    now: &str,
    delegated: Option<&Value>,
    tasks: &[Value],
    sender: Option<&str>,
    force_restart: bool,
    selection: Option<&Value>,
) -> Result<(CommitResult, Vec<event_store::StoredEvent>), DispatchError> {
    if let Some(receipt) = event_store::get_receipt(tx, cmd.command_id, "thread")? {
        if receipt.aggregate_id != cmd.thread_id {
            return Err(DispatchError::CommandIdConflict);
        }
        return Ok((
            CommitResult {
                receipt,
                committed: false,
            },
            vec![],
        ));
    }
    // A steer requested before the provider turn is ready is held as a queued
    // message and delivered when that attempt reports a running turn.
    let deferred: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id=?1 AND r.thread_id=?2 AND r.status IN ('preparing','starting','running') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns p WHERE p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') AND p.status='running') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='run_interrupt_request'))", params![target,cmd.thread_id], |r| r.get(0))?;
    if deferred
        && !force_restart
        && !matches!(
            cmd.text.trim().to_ascii_lowercase().as_str(),
            "/compact" | "/logout"
        )
    {
        let thread_id = cmd.thread_id.to_owned();
        let message_id = cmd.message_id.to_owned();
        let (result, mut events) = dispatch_message_tx_inner(
            tx, cmd, now, false, None, None, sender, None, false, None, None, selection, None,
        )?;
        if result.committed {
            let raw: String = tx.query_row("SELECT r.payload_json FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.run_id=r.run_id WHERE m.message_id=?1", [&message_id], |r| r.get(0))?;
            let mut run: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            run["steerWhenReadyRunId"] = json!(target);
            tx.execute(
                "UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",
                params![run["id"].as_str(), run.to_string()],
            )?;
            let event = Event {
                id: uuid::Uuid::new_v4().to_string(),
                aggregate_kind: "thread".into(),
                stream_id: thread_id,
                event_type: "run.updated".into(),
                occurred_at: now.into(),
                command_id: Some(result.receipt.command_id.clone()),
                causation_event_id: None,
                correlation_id: Some(result.receipt.command_id.clone()),
                actor_kind: "client".into(),
                payload: run,
                metadata: json!({}),
            };
            let stored = event_store::append(tx, &[event])?;
            let mut receipt = result.receipt.clone();
            receipt.result_sequence = stored.last().unwrap().sequence;
            event_store::upsert_receipt(tx, &receipt)?;
            events.extend(stored);
            return Ok((
                CommitResult {
                    receipt,
                    committed: true,
                },
                events,
            ));
        }
        return Ok((result, events));
    }
    let row: Option<(String,String,String,String,String)> = tx.query_row(
            "SELECT r.payload_json, p.provider_turn_id, p.provider_thread_id, pt.provider_session_id, p.node_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id=p.provider_thread_id JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id WHERE r.run_id=?1 AND r.thread_id=?2 AND r.status='running' AND p.status='running' AND t.archived_at IS NULL AND t.deleted_at IS NULL AND pt.provider_session_id IS NOT NULL", params![target,cmd.thread_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let duplicate: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id=?1)",
        [cmd.message_id],
        |r| r.get(0),
    )?;
    let stopped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='run_interrupt_request')", params![cmd.thread_id,target], |r| r.get(0))?;
    let target_text: Option<String> = tx.query_row("SELECT json_extract(m.payload_json,'$.text') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.run_id=?1 AND r.thread_id=?2", params![target,cmd.thread_id], |r| r.get(0)).optional()?;
    let maintenance = target_text
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase());
    let merge_pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type='merge_back' AND status='pending')", [cmd.thread_id], |r|r.get(0))?;
    let caps: Option<String> = match row.as_ref() {Some((_,_,_,session,_))=>tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?1",[session],|r|r.get(0)).optional()?,None=>None};
    let caps: Value = caps
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .unwrap_or(Value::Null);
    let turns = &caps["capabilities"]["turns"];
    let target_selection: Value = row
        .as_ref()
        .and_then(|r| serde_json::from_str::<Value>(&r.0).ok())
        .map(|r| r["modelSelection"].clone())
        .unwrap_or(Value::Null);
    let instance_changed =
        selection.is_some_and(|s| s["instanceId"] != target_selection["instanceId"]);
    let needs_restart = force_restart
        || turns["supportsActiveSteering"] == false
        || (!cmd.attachments.is_empty() && turns["activeSteeringAcceptsAttachments"] == false);
    let restart = needs_restart
        && turns["supportsInterrupt"] == true
        && turns["supportsSteeringByInterruptRestart"] == true
        && delegated.is_none();
    let force_starting_status: Option<String> = if force_restart && deferred {
        tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status IN ('preparing','starting')",params![target,cmd.thread_id],|r|r.get(0)).optional()?
    } else {
        None
    };
    let reason = if let Some(status) = force_starting_status {
        Some(format!(
            "Target run {target} is {status} and cannot be steered."
        ))
    } else if instance_changed {
        Some("Switching provider instances while steering is not supported.".into())
    } else if needs_restart && !restart {
        Some("The provider cannot steer this turn or restart it with this input.".into())
    } else if merge_pending {
        Some(format!("Thread {} has a pending merge-back transfer; merge-back consumption is not implemented yet.", cmd.thread_id))
    } else if duplicate {
        Some(format!("Message {} already exists.", cmd.message_id))
    } else if cmd.text.trim().eq_ignore_ascii_case("/compact") {
        Some("Context compaction must run as a separate turn. Queue it or wait for the active turn to finish.".to_owned())
    } else if cmd.text.trim().eq_ignore_ascii_case("/logout") {
        Some("Signing out must run as a separate turn. Queue it or wait for the active turn to finish.".to_owned())
    } else if maintenance.as_deref() == Some("/compact") {
        Some("Wait for context compaction to finish before steering the thread.".to_owned())
    } else if maintenance.as_deref() == Some("/logout") {
        Some("Wait for sign-out to finish before steering the thread.".to_owned())
    } else if stopped {
        Some(format!(
            "Target run {target} is stopping and cannot be steered."
        ))
    } else if row.is_none() {
        Some("The target run does not have a running provider turn.".to_owned())
    } else {
        None
    };
    let mut receipt = Receipt {
        command_id: cmd.command_id.into(),
        aggregate_kind: "thread".into(),
        aggregate_id: cmd.thread_id.into(),
        command_type: "message.dispatch".into(),
        accepted_at: now.into(),
        result_sequence: event_store::latest_thread_sequence(tx, Some(cmd.thread_id))?,
        status: if reason.is_some() {
            "rejected"
        } else {
            "accepted"
        }
        .into(),
        error: reason,
    };
    event_store::insert_receipt_if_absent(tx, &receipt)?;
    if receipt.error.is_some() {
        return Ok((
            CommitResult {
                receipt,
                committed: false,
            },
            vec![],
        ));
    }
    let (run, turn, pt, session, mut node) = row.unwrap();
    let run: Value = serde_json::from_str(&run).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [cmd.thread_id], |r| r.get(0))?;
    let max_run: i64 = tx.query_row(
        "SELECT COALESCE(MAX(ordinal),0) FROM orchestration_v2_projection_runs WHERE thread_id=?1",
        [cmd.thread_id],
        |r| r.get(0),
    )?;
    let mut selection_events = Vec::new();
    if let Some(selection) = selection {
        let raw: String = tx.query_row(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",
            [cmd.thread_id],
            |r| r.get(0),
        )?;
        let mut thread: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !crate::provider_selection::selections_equal(&thread["modelSelection"], selection) {
            thread["modelSelection"] = selection.clone();
            thread["updatedAt"] = json!(now);
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2,updated_at=?3 WHERE thread_id=?1", params![cmd.thread_id,thread.to_string(),now])?;
            selection_events.push(("thread.model-selection-updated", thread));
        }
        if restart {
            let mut updated = run.clone();
            updated["modelSelection"] = selection.clone();
            tx.execute(
                "UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",
                params![target, updated.to_string()],
            )?;
        }
    }
    let restart_events = if restart {
        let (next, events) = crate::queue_steer::stage_restart(
            tx,
            cmd.thread_id,
            target,
            cmd.message_id,
            cmd.command_id,
            &pt,
            &turn,
            &session,
            now,
        )?;
        node = next;
        events
    } else {
        vec![]
    };
    let item = format!("turn-item:message:{}", cmd.message_id);
    let mut message = json!({"createdBy":if delegated.is_some() { "agent" } else { "user" },"creationSource":cmd.creation_source,"id":cmd.message_id,"threadId":cmd.thread_id,"runId":target,"nodeId":node,"role":"user","text":cmd.text,"attachments":cmd.attachments,"streaming":false,"createdAt":now,"updatedAt":now});
    if let Some(context) = cmd.context {
        message["context"] = context.clone();
    }
    let mut turn_item = json!({"createdBy":if delegated.is_some() { "agent" } else { "user" },"creationSource":cmd.creation_source,"id":item,"threadId":cmd.thread_id,"runId":target,"nodeId":node,"providerThreadId":pt,"providerTurnId":if restart {Value::Null} else {json!(turn)},"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":null,"startedAt":now,"completedAt":now,"updatedAt":now,"type":"user_message","messageId":cmd.message_id,"inputIntent":"steer","text":cmd.text,"attachments":cmd.attachments});
    if let Some(context) = cmd.context {
        turn_item["context"] = context.clone();
    }
    if restart {
        if let Some(selection) = selection.filter(|selection| {
            !crate::provider_selection::selections_equal(&target_selection, selection)
        }) {
            turn_item["modelSwitch"] = json!({"from":target_selection,"to":selection});
        }
    }
    if let Some(sender) = sender {
        message["createdBy"] = json!("agent");
        message["senderThreadId"] = json!(sender);
        turn_item["createdBy"] = json!("agent");
        turn_item["senderThreadId"] = json!(sender);
    }
    if let Some(delegated) = delegated {
        message["delegatedCompletion"] = delegated.clone();
        delegated_notification(&mut turn_item, delegated, tasks);
    }
    let item_type = turn_item["type"].as_str().unwrap_or("user_message");
    // The reference supersedes the old attempt and node before publishing a
    // changed selection, then publishes the replacement state.
    let mut restart_events = restart_events.into_iter();
    let leading_restart: Vec<_> = if restart {
        restart_events.by_ref().take(2).collect()
    } else {
        vec![]
    };
    let events: Vec<Event> = leading_restart
        .into_iter()
        .chain(selection_events)
        .chain(restart_events)
        .chain([
            ("message.updated", message.clone()),
            ("turn-item.updated", turn_item.clone()),
        ])
        .map(|(kind, payload)| Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: cmd.thread_id.into(),
            event_type: kind.into(),
            occurred_at: now.into(),
            command_id: Some(cmd.command_id.into()),
            causation_event_id: None,
            correlation_id: Some(cmd.command_id.into()),
            actor_kind: "client".into(),
            payload,
            metadata: json!({}),
        })
        .collect();
    let stored = event_store::append(tx, &events)?;
    let normalized_turn_item = stored
        .iter()
        .rev()
        .find(|e| e.event.event_type == "turn-item.updated" && e.event.payload["id"].as_str() == Some(item.as_str()))
        .map(|e| e.event.payload.clone())
        .unwrap_or_else(|| turn_item.clone());
    let normalized_ordinal = normalized_turn_item["ordinal"].as_i64().unwrap_or(ordinal);
    tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,?2,?3,?4,'user',0,?5,?5,?6)",params![cmd.message_id,cmd.thread_id,target,node,now,message.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'completed',?9,?10)",params![item,cmd.thread_id,target,node,pt,if restart {None} else {Some(turn.as_str())},normalized_ordinal,item_type,now,normalized_turn_item.to_string()])?;
    let effect = Effect {
        id: format!("effect:{}:provider-turn.steer:{}", cmd.command_id, turn),
        command_id: cmd.command_id.into(),
        thread_id: cmd.thread_id.into(),
        request: json!({"type":"provider-turn.steer","providerSessionId":session,"providerThreadId":pt,"providerTurnId":turn,"messageId":cmd.message_id,"modelSelection":selection.unwrap_or(&run["modelSelection"]),"steerFollowUpAfterRunOrdinal":max_run}),
        status: "pending".into(),
        attempt_count: 0,
        available_at: now.into(),
        lease_owner: None,
        created_at: now.into(),
        updated_at: now.into(),
        completed_at: None,
        last_error: None,
    };
    if !restart {
        outbox::enqueue(tx, &effect)?;
    }
    receipt.result_sequence = stored.last().unwrap().sequence;
    event_store::upsert_receipt(tx, &receipt)?;
    Ok((
        CommitResult {
            receipt,
            committed: true,
        },
        stored,
    ))
}

/// Deliver queued steers once their target attempt has a running provider turn.
pub fn deliver_deferred(
    bus: &EventBus,
    thread: &str,
    attempt: &str,
    now: &str,
) -> Result<(), BusError> {
    crate::queue_steer::deliver_deferred(bus, thread, attempt, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread_commands::{create_thread_ordered, CreateThread};
    #[test]
    fn message_dispatch_advances_thread_activity_for_immediate_and_queued_turns() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:01Z").unwrap();
        bus.commit(|tx|{let (column,payload):(String,String)=tx.query_row("SELECT updated_at,json_extract(payload_json,'$.updatedAt') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(column,"2026-01-01T00:00:01Z");assert_eq!(payload,column);Ok(((),vec![]))}).unwrap();
        dispatch_first_message(&bus, cmd("queued", "m2"), "2026-01-01T00:00:02Z").unwrap();
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:03Z").unwrap();
        bus.commit(|tx|{let (column,payload):(String,String)=tx.query_row("SELECT updated_at,json_extract(payload_json,'$.updatedAt') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(column,"2026-01-01T00:00:02Z");assert_eq!(payload,column);Ok(((),vec![]))}).unwrap();
    }

    #[test]
    fn fresh_deferred_queues_when_a_run_is_active() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:00Z").unwrap();
        let strategy = json!({"type":"root"});
        let selected = json!({"instanceId":"codex","model":"other"});
        let result = dispatch_selected_context(
            &bus,
            cmd("fresh", "m2"),
            "2026-01-01T00:00:01Z",
            true,
            Some(Some(&strategy)),
            None,
            &selected,
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx|{let (status,fresh):(String,bool)=tx.query_row("SELECT status,json_extract(payload_json,'$.freshContext') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"queued");assert!(fresh);let model:String=tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?;assert_eq!(model,"other");let default_model:String=tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?;assert_eq!(default_model,"gpt");let preparations:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE run_id='run:thread:t:ordinal:2' AND type='command_execution'",[],|r|r.get(0))?;assert_eq!(preparations,0);Ok(((),vec![]))}).unwrap();
    }

    #[test]
    fn first_fresh_deferred_run_reserves_standard_pending_provider_thread() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        let strategy = json!({"type":"root"});
        let result = dispatch_fresh_deferred_message(
            &bus,
            cmd("fresh", "m1"),
            "2026-01-01T00:00:01Z",
            Some(&strategy),
            None,
        )
        .unwrap();
        assert_eq!(result.receipt.status, "accepted");
        bus.commit(|tx| {
            let (status, provider_id): (String, String) = tx.query_row(
                "SELECT status, provider_thread_id FROM orchestration_v2_projection_runs WHERE ordinal=1",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(status, "preparing");
            assert_eq!(provider_id, "provider-thread:provider:codex:native-thread:pending%3Arun%3Athread%3At%3Aordinal%3A1");
            let active: String = tx.query_row("SELECT json_extract(payload_json,'$.activeProviderThreadId') FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0))?;
            assert_eq!(active, provider_id);
            Ok(((), vec![]))
        }).unwrap();
    }

    #[test]
    fn fresh_context_queues_separate_provider_and_skips_handoff() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:00Z").unwrap();
        bus.commit(|tx| {let id:String=tx.query_row("SELECT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|r.get(0))?;let session=json!({"id":id,"status":"active","capabilities":{"sessions":{"supportsMultipleProviderThreadsPerSession":false}}});tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES(?1,'t','codex','active','old',?2)",params![id,session.to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES(?1,'t')",[id])?;Ok(((),vec![]))}).unwrap();
        dispatch_fresh_message(
            &bus,
            cmd("fresh", "m2"),
            "2026-01-01T00:00:01Z",
            Some(&crate::provider::session_registry::SessionRegistry::default()),
        )
        .unwrap();
        bus.commit(|tx|{
            let (prior,fresh,status,flag):(String,String,String,bool)=tx.query_row("SELECT (SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE ordinal=1),provider_thread_id,status,json_extract(payload_json,'$.freshContext') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;assert_ne!(prior,fresh);assert_eq!(fresh, pending_provider_thread_id("codex", "run:thread:t:ordinal:2"));assert_eq!(status,"queued");assert!(flag);
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE ordinal=1",[])?;Ok(((),vec![]))
        }).unwrap();
        crate::queue_promotion::promote(&bus, "t", "2026-01-01T00:00:02Z").unwrap();
        bus.commit(|tx|{let (status,handoff):(String,Option<String>)=tx.query_row("SELECT status,json_extract(payload_json,'$.contextHandoffId') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"starting");assert!(handoff.is_none());let flag:bool=tx.query_row("SELECT json_extract(payload_json,'$.freshContext') FROM orchestration_v2_projection_turn_items WHERE run_id='run:thread:t:ordinal:2' AND type='user_message'",[],|r|r.get(0))?;assert!(flag);let detach:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_type='provider-session.detach' AND json_extract(payload_json,'$.onlyIfIdle')=1)",[],|r|r.get(0))?;assert!(detach);Ok(((),vec![]))}).unwrap();
    }

    #[test]
    fn fresh_context_detaches_old_single_thread_session() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:00Z").unwrap();
        bus.commit(|tx| {let id:String=tx.query_row("SELECT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|r.get(0))?;let session=json!({"id":id,"status":"active","capabilities":{"sessions":{"supportsMultipleProviderThreadsPerSession":false}}});tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES(?1,'t','codex','active','old',?2)",params![id,session.to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES(?1,'t')",[id])?;Ok(((),vec![]))}).unwrap();
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE ordinal=1",[])?;Ok(((),vec![]))}).unwrap();
        dispatch_fresh_message(
            &bus,
            cmd("fresh", "m2"),
            "2026-01-01T00:00:01Z",
            Some(&crate::provider::session_registry::SessionRegistry::default()),
        )
        .unwrap();
        bus.commit(|tx| {
            let (prior,new_session):(String,String)=tx.query_row("SELECT (SELECT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=(SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE ordinal=1)), p.provider_session_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE r.ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_ne!(prior,new_session);
            let detached:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE command_id='fresh' AND effect_type='provider-session.detach')",[],|r|r.get(0))?;assert!(detached);
            let bound:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1)",[prior],|r|r.get(0))?;assert!(!bound);Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn queued_message_before_fresh_run_uses_new_context() {
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
        let cmd = |id, msg| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id: msg,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, cmd("first", "m1"), "2026-01-01T00:00:00Z").unwrap();
        dispatch_first_message(&bus, cmd("queued", "m2"), "2026-01-01T00:00:01Z").unwrap();
        dispatch_fresh_message(&bus, cmd("fresh", "m3"), "2026-01-01T00:00:02Z", None).unwrap();
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:thread:t:ordinal:1'",[])?;Ok(((),vec![]))}).unwrap();
        assert!(crate::queue_promotion::promote_selected(
            &bus,
            "t",
            Some("run:thread:t:ordinal:3"),
            "2026-01-01T00:00:03Z"
        )
        .unwrap());
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:thread:t:ordinal:3'",[])?;Ok(((),vec![]))}).unwrap();
        assert!(crate::queue_promotion::promote(&bus, "t", "2026-01-01T00:00:04Z").unwrap());
        bus.commit(|tx|{let (prior,fresh):(String,String)=tx.query_row("SELECT provider_thread_id,(SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE run_id='run:thread:t:ordinal:3') FROM orchestration_v2_projection_runs WHERE run_id='run:thread:t:ordinal:2'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(prior,fresh);let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_context_handoffs WHERE target_run_id='run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert_eq!(count,0);Ok(((),vec![]))}).unwrap();
    }

    #[test]
    fn fresh_context_rejects_pending_fork_without_writes() {
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
        bus.commit(|tx|{tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,source_provider,source_provider_instance_id,updated_at,payload_json) VALUES('fork','parent','t','fork','pending','codex','codex','old','{}')",[])?;Ok(((),vec![]))}).unwrap();
        let cmd = DispatchMessage {
            context: None,
            command_id: "fresh",
            thread_id: "t",
            message_id: "m",
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        let result = dispatch_fresh_message(&bus, cmd, "2026-01-01T00:00:01Z", None).unwrap();
        assert_eq!(result.receipt.status, "rejected");
        assert_eq!(
            result.receipt.error.as_deref(),
            Some(crate::queue_promotion::fresh_context::TRANSFER_ERROR)
        );
        bus.commit(|tx| {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        })
        .unwrap();
    }

    #[test]
    fn execution_ids_encode_each_component_like_upstream() {
        assert_eq!(
            encode_id_part("space / 雪!~'()"),
            "space%20%2F%20%E9%9B%AA!~'()"
        );
        let run = run_id("thread:a/雪", 7);
        assert_eq!(run, "run:thread:thread%3Aa%2F%E9%9B%AA:ordinal:7");
        assert_eq!(pending_provider_thread_id("codex", &run), "provider-thread:provider:codex:native-thread:pending%3Arun%3Athread%3Athread%253Aa%252F%25E9%259B%25AA%3Aordinal%3A7");
    }
    #[test]
    fn delegated_detail_uses_utf8_budget_and_keeps_scanning() {
        let ids = vec![json!("a"), json!("b"), json!("c")];
        let tasks = vec![
            json!({"id":"a","status":"completed","title":"Large","result":"界".repeat(6000)}),
            json!({"id":"b","status":"completed","result":"ok"}),
            json!({"id":"c","status":"failed","result":""}),
        ];
        let detail = delegated_wake_detail(&ids, &tasks);
        assert!(detail.contains("Delegated task a (Large) [completed]. Use task_status"));
        assert!(detail.contains("Delegated task b [completed]:\nok"));
        assert!(detail.ends_with("Delegated task c [failed]:\n"));
        let mut item = json!({"id":"item","type":"user_message","messageId":"m","text":"secret","createdBy":"agent"});
        delegated_notification(&mut item, &json!({"taskIds":["b","c"]}), &tasks);
        assert_eq!(item["type"], "notification");
        assert_eq!(item["outcome"], "failed");
        assert_eq!(item["summary"], "2 of 3 delegated tasks failed");
        assert!(item.get("text").is_none());
        assert!(item.get("messageId").is_none());
        assert_eq!(
            report_label(&format!("{}😀Z", "x".repeat(78))).unwrap(),
            format!("{}…", "x".repeat(78))
        );
    }

    #[test]
    fn delegated_offer_dispatches_once_with_authoritative_task_ids() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        bus.commit(|tx| {
            let parent = json!({"id":"parent","status":"completed","providerThreadId":"pt","delegatedCompletion":{"disposition":"open","delivery":{"generation":1,"messageId":"wake","taskIds":["a","b"]}}});
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex','completed','now',?1)", [parent.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','now',?1)", [json!({"id":"pt","driver":"codex"}).to_string()])?;
            for (id, title) in [("a", "First"), ("b", "Second"), ("c", "Earlier")] {
                let task = json!({"id":id,"runId":"parent","origin":"app_owned","status":"completed","title":title,"result":"current result"});
                tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES(?1,'t','parent','n','codex','app_owned','completed','now',?2)", params![id,task.to_string()])?;
            }
            Ok(((),vec![]))
        }).unwrap();
        let request = bus
            .commit(|tx| {
                Ok((
                    crate::delegated_continuation::offer(tx, "t", "parent")?.unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        assert!(
            dispatch_delegated_completion(&bus, &request, "/tmp", "2026-01-01T00:00:01Z")
                .unwrap()
                .unwrap()
                .committed
        );
        assert!(
            dispatch_delegated_completion(&bus, &request, "/tmp", "2026-01-01T00:00:02Z")
                .unwrap()
                .is_none()
        );
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='wake'", [], |r| r.get(0))?;
            let message: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(message["createdBy"], "agent");
            assert_eq!(message["creationSource"], "server");
            assert_eq!(message["delegatedCompletion"]["taskIds"], json!(["a","b"]));
            assert!(message["text"].as_str().unwrap().contains("Delegated task a (First) [completed]:\ncurrent result"));
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='notification'", [], |r| r.get(0))?;
            let notice: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(notice["summary"], "2 of 3 delegated tasks finished: First, Second");
            assert!(notice.get("messageId").is_none());
            Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn inherited_handoff_respects_fork_point_and_visibility() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,run_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_run_attempts(thread_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,ordinal INTEGER,payload_json TEXT);").unwrap();
        let tx = db.transaction().unwrap();
        for (id, value) in [
            (
                "child",
                json!({"forkedFrom":{"type":"run","threadId":"parent","runId":"r1"}}),
            ),
            ("parent", json!({"forkedFrom":null})),
        ] {
            tx.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES(?1,?2)",
                params![id, value.to_string()],
            )
            .unwrap();
        }
        for (id, n, status) in [("r1", 1, "cancelled"), ("r2", 2, "completed")] {
            tx.execute(
                "INSERT INTO orchestration_v2_projection_runs VALUES('parent',?1,?2,?3,?4)",
                params![id, n, status, json!({"id":id,"status":status}).to_string()],
            )
            .unwrap();
        }
        for (id, run, n, intent) in [
            ("kept", "r1", 1, "normal"),
            ("cancelled", "r1", 2, "queued_turn"),
            ("after", "r2", 3, "normal"),
        ] {
            tx.execute(
                "INSERT INTO orchestration_v2_projection_turn_items VALUES('parent',?1,?2,?3)",
                params![
                    run,
                    n,
                    json!({"id":id,"runId":run,"type":"user_message","inputIntent":intent})
                        .to_string()
                ],
            )
            .unwrap();
        }
        let items = inherited_handoff_items(&tx, "child").unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["kept"]
        );
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?1 WHERE thread_id='child'",[json!({"forkedFrom":{"type":"run","threadId":"parent","runId":"r1"},"lineage":{"sideChat":true}}).to_string()]).unwrap();
        assert!(inherited_handoff_items(&tx, "child").unwrap().is_empty());
    }

    #[test]
    fn outbox_failure_rolls_back_events_projections_and_receipt() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
            "now",
        )
        .unwrap();
        bus.commit(|tx| { tx.execute_batch("CREATE TRIGGER fail_effect BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END;")?; Ok(((),vec![])) }).unwrap();
        let result = dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "t",
                message_id: "m",
                text: "Hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "now",
        );
        assert!(result.is_err());
        bus.commit(|tx| {
            assert_eq!(event_store::read_thread_events(tx, "t", 0, 100)?.len(), 1);
            assert!(event_store::get_receipt(tx, "send", "thread")?.is_none());
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM orchestration_v2_projection_runs",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM orchestration_v2_projection_messages",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(((), vec![]))
        })
        .unwrap();
    }

    #[test]
    fn first_turn_is_atomic_and_replay_does_not_duplicate_effects() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
            "thread-event",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let command = || DispatchMessage {
            context: None,
            command_id: "send",
            thread_id: "t",
            message_id: "m",
            text: "Hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        let first = dispatch_first_message(&bus, command(), "2026-01-01T00:00:01.000Z").unwrap();
        assert!(first.committed);
        assert_eq!(first.receipt.result_sequence, 9);
        let shell = bus.shell_snapshot().unwrap();
        let thread = &shell["threads"][0];
        assert_eq!(thread["status"], "starting");
        assert_eq!(thread["latestRunId"], "run:thread:t:ordinal:1");
        assert_eq!(thread["activeRunId"], thread["latestRunId"]);
        assert_eq!(
            thread["latestUserAuthoredMessageAt"],
            "2026-01-01T00:00:01.000Z"
        );
        assert_eq!(thread["itemCount"], 1);
        assert_eq!(
            dispatch_first_message(&bus, command(), "later")
                .unwrap()
                .receipt,
            first.receipt
        );
        bus.commit(|tx| {
            let events = event_store::read_thread_events(tx, "t", 1, 100)?;
            assert_eq!(
                events
                    .iter()
                    .map(|e| e.event.event_type.as_str())
                    .collect::<Vec<_>>(),
                vec![
                    "thread.metadata-updated",
                    "provider-thread.updated",
                    "run.created",
                    "run-attempt.created",
                    "node.updated",
                    "checkpoint-scope.created",
                    "message.updated",
                    "turn-item.updated"
                ]
            );
            assert_eq!(
                events[2].event.payload["rootNodeId"],
                "node:run:run%3Athread%3At%3Aordinal%3A1:root"
            );
            let effects = outbox::list_by_command_id(tx, "send")?;
            assert_eq!(effects.len(), 1);
            assert_eq!(
                effects[0].request,
                json!({"type":"provider-turn.start","runId":"run:thread:t:ordinal:1"})
            );
            Ok(((), vec![]))
        })
        .unwrap();
        let second = dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "second",
                ..command()
            },
            "later",
        )
        .unwrap();
        assert_eq!(second.receipt.status, "rejected");
        assert_eq!(second.receipt.result_sequence, 9);
    }
    #[test]
    fn next_idle_turn_reuses_provider_and_root_scope() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let send = |command_id, message_id| DispatchMessage {
            context: None,
            command_id,
            thread_id: "t",
            message_id,
            text: "Hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("one", "m1"), "2026-01-01T00:00:01.000Z").unwrap();
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE thread_id='t'", [])?;
            Ok(((), vec![]))
        }).unwrap();
        assert!(
            dispatch_first_message(&bus, send("two", "m2"), "2026-01-01T00:00:02.000Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_provider_threads", [], |r| r.get::<_, i64>(0))?, 1);
            let (run,): (String,) = tx.query_row("SELECT run_id FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id='t'", [], |r| Ok((r.get(0)?,)))?;
            assert_eq!(run, "run:thread:t:ordinal:2");
            let item: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:message:m2'", [], |r| r.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&item).unwrap()["ordinal"], 2_000_001);
            assert_eq!(outbox::list_by_command_id(tx, "two")?.len(), 1);
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn deferred_dispatch_creates_preparing_run_without_start_effect_or_checkpoint() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
        let cmd = DispatchMessage {
            context: None,
            command_id: "defer",
            thread_id: "t",
            message_id: "m",
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        assert!(
            dispatch_deferred_message(
                &bus,
                cmd,
                "2026-01-01T00:00:01Z",
                Some(&json!({"type":"worktree"}))
            )
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let (status, raw):(String,String)=tx.query_row("SELECT status,payload_json FROM orchestration_v2_projection_runs",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"preparing");
            assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["workspacePreparation"]["type"],"worktree");
            assert_eq!(tx.query_row("SELECT count(*) FROM orchestration_v2_projection_checkpoint_scopes",[],|r|r.get::<_,i64>(0))?,0);
            assert_eq!(tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type='command_execution' AND status='running'",[],|r|r.get::<_,i64>(0))?,1);
            let ordinals: Vec<i64> = tx.prepare("SELECT ordinal FROM orchestration_v2_projection_turn_items ORDER BY ordinal")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            assert_eq!(ordinals, vec![1_000_001, 1_000_002]);
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads", [], |r| r.get(0))?;
            let provider: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(provider["pendingBackgroundTasks"], json!([]));
            for field in ["contextUsage", "nativeMetadata", "goal"] { assert!(provider.get(field).is_some_and(Value::is_null)); }
            assert!(outbox::list_by_command_id(tx,"defer")?.is_empty());
            Ok(((),vec![]))
        }).unwrap();
        let run = "run:thread:t:ordinal:1";
        let progress = json!({"type":"prepared-run.progress","commandId":"progress","threadId":"t","runId":run,"phase":"setup"});
        assert!(
            prepared_run_command(&bus, &progress, "/tmp", "2026-01-01T00:00:02Z")
                .unwrap()
                .committed
        );
        let queued = DispatchMessage {
            context: None,
            command_id: "queued",
            thread_id: "t",
            message_id: "m2",
            text: "follow up",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        assert!(
            dispatch_deferred_message(&bus, queued, "2026-01-01T00:00:02Z", None)
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            assert_eq!(tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get::<_,String>(0))?,"queued");
            assert_eq!(tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE type='command_execution'",[],|r|r.get::<_,i64>(0))?,1);
            Ok(((),vec![]))
        }).unwrap();
        let fail = json!({"type":"prepared-run.fail","commandId":"fail","threadId":"t","runId":run,"failure":{"message":"setup failed"}});
        assert!(
            prepared_run_command(&bus, &fail, "/tmp", "2026-01-01T00:00:02Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.queueHeld',json('true')) WHERE ordinal=2",[])?; Ok(((),vec![])) }).unwrap();
        let retry =
            json!({"type":"prepared-run.retry","commandId":"retry","threadId":"t","runId":run});
        assert!(
            prepared_run_command(&bus, &retry, "/tmp", "2026-01-01T00:00:02Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",
                    [],
                    |r| r.get::<_, String>(0)
                )?,
                "preparing"
            );
            assert_eq!(
                tx.query_row(
                    "SELECT status FROM orchestration_v2_projection_turn_items WHERE type='error'",
                    [],
                    |r| r.get::<_, String>(0)
                )?,
                "cancelled"
            );
            assert_eq!(tx.query_row("SELECT json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get::<_,i64>(0))?,0);
            let events=event_store::read_thread_events(tx,"t",1,100)?;
            let fail_types:Vec<_>=events.iter().filter(|e|e.event.command_id.as_deref()==Some("fail")).map(|e|e.event.event_type.as_str()).collect();
            assert_eq!(fail_types,vec!["run-attempt.updated","node.updated","turn-item.updated","turn-item.updated","run.updated"]);
            let retry_types:Vec<_>=events.iter().filter(|e|e.event.command_id.as_deref()==Some("retry")).map(|e|e.event.event_type.as_str()).collect();
            assert_eq!(retry_types,vec!["turn-item.updated","turn-item.updated","run-attempt.updated","node.updated","run.updated","run.updated"]);
            Ok(((), vec![]))
        })
        .unwrap();
        let release =
            json!({"type":"prepared-run.release","commandId":"release","threadId":"t","runId":run});
        assert!(
            prepared_run_command(&bus, &release, "/tmp", "2026-01-01T00:00:03Z")
                .unwrap()
                .committed
        );
        assert!(
            !prepared_run_command(&bus, &release, "/tmp", "later")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?1",
                    [run],
                    |r| r.get::<_, String>(0)
                )?,
                "starting"
            );
            assert_eq!(
                tx.query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_checkpoint_scopes",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(outbox::list_by_command_id(tx, "release")?.len(), 1);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn old_provider_identifiers_are_reused_for_subsequent_runs() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
            "now",
        )
        .unwrap();
        bus.commit(|tx| {
            let provider=json!({"id":"legacy:provider","driver":"codex","providerInstanceId":"codex","providerSessionId":"legacy:session","appThreadId":"t","ownerNodeId":null,"status":"not_loaded","firstRunOrdinal":1,"lastRunOrdinal":1,"handoffIds":[],"createdAt":"now","updatedAt":"now"});
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_instance_id,provider_session_id,status,updated_at,payload_json) VALUES('legacy:provider','t','codex','codex','legacy:session','not_loaded','now',?1)",[provider.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.activeProviderThreadId','legacy:provider') WHERE thread_id='t'",[])?;
            Ok(((),vec![]))
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
            "now",
        )
        .unwrap();
        bus.commit(|tx| {
            let (provider,session):(String,String)=tx.query_row("SELECT provider_thread_id,json_extract(payload_json,'$.providerSessionId') FROM orchestration_v2_projection_provider_threads WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!((provider.as_str(),session.as_str()),("legacy:provider","legacy:session"));
            assert_eq!(tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs",[],|r|r.get::<_,String>(0))?,"legacy:provider");
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn pending_merge_back_rejects_dispatch_without_side_effects() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
        bus.commit(|tx| { tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('x','child','t','merge_back','pending','now','{}')",[])?; Ok(((),vec![])) }).unwrap();
        let cmd = || DispatchMessage {
            context: None,
            command_id: "send",
            thread_id: "t",
            message_id: "m",
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        let result = dispatch_first_message(&bus, cmd(), "now").unwrap();
        assert_eq!(result.receipt.status, "rejected");
        assert!(result
            .receipt
            .error
            .as_deref()
            .unwrap()
            .to_lowercase()
            .contains("pending merge-back"));
        assert_eq!(
            dispatch_first_message(&bus, cmd(), "later")
                .unwrap()
                .receipt,
            result.receipt
        );
        bus.commit(|tx| {
            assert_eq!(
                tx.query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_messages",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                tx.query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_runs",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            assert!(outbox::list_by_command_id(tx, "send")?.is_empty());
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn active_turn_queues_distinct_messages_without_start_effect() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
        let send = |id, message_id| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01Z").unwrap();
        let queued =
            dispatch_first_message(&bus, send("second", "m2"), "2026-01-01T00:00:02Z").unwrap();
        assert!(queued.committed);
        assert_eq!(
            dispatch_first_message(&bus, send("second", "m2"), "later")
                .unwrap()
                .receipt,
            queued.receipt
        );
        dispatch_first_message(&bus, send("third", "m3"), "2026-01-01T00:00:03Z").unwrap();
        bus.commit(|tx| {
            let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE status='queued' ORDER BY ordinal")?;
            let runs: Vec<Value> = stmt.query_map([], |r| r.get::<_,String>(0))?.map(|r| serde_json::from_str(&r.unwrap()).unwrap()).collect();
            assert_eq!(runs.len(), 2);
            assert_eq!(runs[0]["queuePosition"], 1);
            assert_eq!(runs[1]["queuePosition"], 2);
            assert!(outbox::list_by_command_id(tx, "second")?.is_empty());
            let events = event_store::read_thread_events(tx, "t", 9, 100)?;
            assert_eq!(events.iter().take(5).map(|e| e.event.event_type.as_str()).collect::<Vec<_>>(), vec!["run.created", "run-attempt.created", "node.updated", "checkpoint-scope.created", "message.updated"]);
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_turn_items", [], |r| r.get::<_,i64>(0))?, 1);
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn delegated_wake_steers_only_with_safe_live_session() {
        for safe in [true, false] {
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            crate::migrations::run_ported_migrations(&mut db).unwrap();
            let bus = EventBus::new(db, 16);
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
                "now",
            )
            .unwrap();
            let send = DispatchMessage {
                context: None,
                command_id: "first",
                thread_id: "t",
                message_id: "opening",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            };
            dispatch_first_message(&bus, send, "now").unwrap();
            bus.commit(|tx| {
                tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running','$.delegatedCompletion',json(?1)) WHERE ordinal=1", [json!({"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"wake","taskIds":["a"]}}).to_string()])?;
                tx.execute("UPDATE orchestration_v2_projection_provider_threads SET provider_session_id='session',payload_json=json_set(payload_json,'$.providerSessionId','session')", [])?;
                tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) SELECT 'turn',thread_id,provider_thread_id,root_node_id,attempt_id,1,'running','{}' FROM orchestration_v2_projection_run_attempts WHERE run_id='run:thread:t:ordinal:1'", [])?;
                let task=json!({"id":"a","runId":"run:thread:t:ordinal:1","origin":"app_owned","status":"completed","result":"done","completionWake":"always","completionDelivery":{"state":"claimed","observedByRunId":null}});
                tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('a','t','run:thread:t:ordinal:1','n','codex','app_owned','completed','now',?1)", [task.to_string()])?;
                Ok(((),vec![]))
            }).unwrap();
            let request = bus
                .commit(|tx| {
                    Ok((
                        crate::delegated_continuation::offer(tx, "t", "run:thread:t:ordinal:1")?
                            .unwrap(),
                        vec![],
                    ))
                })
                .unwrap();
            assert!(
                dispatch_delegated_completion_with_session(&bus, &request, "/tmp", "later", |id| {
                    safe && id == "session"
                })
                .unwrap()
                .unwrap()
                .committed
            );
            bus.commit(|tx| {
                let (run,raw):(String,String)=tx.query_row("SELECT run_id,payload_json FROM orchestration_v2_projection_messages WHERE message_id='wake'", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
                let message:Value=serde_json::from_str(&raw).unwrap();
                assert_eq!(message["delegatedCompletion"]["taskIds"],json!(["a"]));
                assert_eq!(run == "run:thread:t:ordinal:1",safe);
                let effect_count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE json_extract(payload_json,'$.type')='provider-turn.steer'",[],|r|r.get(0))?;
                assert_eq!(effect_count,if safe {1} else {0});
                if safe {
                    let kind:String=tx.query_row("SELECT type FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:message:wake'",[],|r|r.get(0))?;
                    assert_eq!(kind,"notification");
                }
                Ok(((),vec![]))
            }).unwrap();
        }
    }
    #[test]
    fn running_steer_records_message_and_one_effect_on_replay() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
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
        let send = |id, message_id| DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t",
            message_id,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01Z").unwrap();
        let deferred = steer_message(
            &bus,
            send("deferred", "m3"),
            "run:thread:t:ordinal:1",
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        assert!(deferred.committed);
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running') WHERE ordinal=1", [])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) SELECT 'turn',thread_id,provider_thread_id,root_node_id,attempt_id,1,'running','{}' FROM orchestration_v2_projection_run_attempts WHERE run_id='run:thread:t:ordinal:1'", [])?;
            Ok(((),vec![]))
        }).unwrap();
        let attempt = "run-attempt:run:run%3Athread%3At%3Aordinal%3A1:attempt:1";
        deliver_deferred(&bus, "t", attempt, "2026-01-01T00:00:02Z").unwrap();
        deliver_deferred(&bus, "t", attempt, "2026-01-01T00:00:02Z").unwrap();
        bus.commit(|tx| {
            let (status, run): (String,String) = tx.query_row("SELECT r.status,m.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id='m3' WHERE r.ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"cancelled"); assert_eq!(run,"run:thread:t:ordinal:1");
            let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE json_extract(payload_json,'$.messageId')='m3'",[],|r|r.get(0))?; assert_eq!(count,1);
            Ok(((),vec![]))
        }).unwrap();
        let first = steer_message(
            &bus,
            send("steer", "m2"),
            "run:thread:t:ordinal:1",
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        assert!(first.committed);
        assert_eq!(
            steer_message(&bus, send("steer", "m2"), "run:thread:t:ordinal:1", "later")
                .unwrap()
                .receipt,
            first.receipt
        );
        bus.commit(|tx| {
            let effects=outbox::list_by_command_id(tx,"steer")?;
            assert_eq!(effects.len(),1);
            assert_eq!(effects[0].request["providerTurnId"],"turn");
            let item: String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:message:m2'",[],|r|r.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&item).unwrap()["inputIntent"],"steer");
            assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_runs",[],|r|r.get::<_,i64>(0))?,2);
            Ok(((),vec![]))
        }).unwrap();
        let selected = json!({"instanceId":"codex","model":"new"});
        let selected_steer = steer_selected(
            &bus,
            send("selected-steer", "m-selected"),
            "run:thread:t:ordinal:1",
            "later",
            &selected,
            false,
        )
        .unwrap();
        assert!(selected_steer.committed);
        bus.commit(|tx| {
            assert_eq!(outbox::list_by_command_id(tx, "selected-steer")?[0].request["modelSelection"], selected);
            let (thread_model, run_model): (String,String) = tx.query_row("SELECT json_extract(t.payload_json,'$.modelSelection.model'),json_extract(r.payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id WHERE r.ordinal=1", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!((thread_model.as_str(), run_model.as_str()), ("new", "gpt"));
            Ok(((),vec![]))
        }).unwrap();
        let auto =
            dispatch_auto_selected(&bus, send("auto", "m-auto"), "later", Some(&selected)).unwrap();
        assert!(auto.committed);
        bus.commit(|tx| {
            assert_eq!(
                outbox::list_by_command_id(tx, "auto")?[0].request["type"],
                "provider-turn.steer"
            );
            Ok(((), vec![]))
        })
        .unwrap();
        let follow = dispatch_steer_follow_up(
            &bus,
            send("follow", "m2"),
            "run:thread:t:ordinal:1",
            Some(2),
            true,
            None,
            "2026-01-01T00:00:03Z",
        )
        .unwrap();
        assert!(follow.committed);
        assert!(
            !dispatch_steer_follow_up(
                &bus,
                send("follow", "m2"),
                "run:thread:t:ordinal:1",
                Some(2),
                true,
                None,
                "2026-01-01T00:00:03Z"
            )
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let (run, status, intent): (String,String,String) = tx.query_row("SELECT m.run_id,i.status,json_extract(i.payload_json,'$.inputIntent') FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_turn_items i ON json_extract(i.payload_json,'$.messageId')=m.message_id WHERE m.message_id='m2'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            assert_eq!(run, "run:thread:t:ordinal:3");
            assert_eq!((status.as_str(),intent.as_str()), ("pending","queued_turn"));
            assert_eq!(tx.query_row("SELECT count(*) FROM orchestration_v2_projection_messages WHERE message_id='m2'",[],|r|r.get::<_,i64>(0))?,1);
            Ok(((),vec![]))
        }).unwrap();
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES ('stop','t','run:thread:t:ordinal:1',99,'run_interrupt_request','completed','now','{}')", [])?;
            Ok(((),vec![]))
        }).unwrap();
        let stopped = steer_message(
            &bus,
            send("after-stop", "m5"),
            "run:thread:t:ordinal:1",
            "later",
        )
        .unwrap();
        assert_eq!(stopped.receipt.status, "rejected");
        assert!(stopped.receipt.error.unwrap().contains("stopping"));
        let queued = dispatch_auto_message(&bus, send("auto-after-stop", "m4"), "later").unwrap();
        assert!(queued.committed);
        assert_eq!(
            dispatch_auto_message(&bus, send("auto", "m-auto"), "later")
                .unwrap()
                .receipt,
            auto.receipt
        );
        bus.commit(|tx| {
            let status: String = tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE json_extract(payload_json,'$.userMessageId')='m4'", [], |r| r.get(0))?;
            assert_eq!(status, "queued");
            assert!(outbox::list_by_command_id(tx, "auto-after-stop")?.is_empty());
            Ok(((), vec![]))
        }).unwrap();
    }
}
