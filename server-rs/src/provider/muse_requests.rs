//! Live Muse approval decisions, scoped to the originating turn.
use crate::{
    event_bus::EventBus,
    provider::{
        codex_events::RootTurn,
        codex_requests::{self, RequestArtifacts},
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::sync::oneshot;
struct Pending {
    thread: String,
    native: String,
    choices: HashMap<String, Value>,
    reply: oneshot::Sender<String>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn owns(id: &str) -> bool {
    pending().lock().is_ok_and(|map| map.contains_key(id))
}
pub(crate) fn deliver(id: &str, decision: &str) -> Result<(), String> {
    let mut map = pending()
        .lock()
        .map_err(|_| "Muse approval registry unavailable")?;
    let entry = map.get(id).ok_or("Unknown or expired Muse approval")?;
    if !entry.choices.contains_key(decision) {
        return Err("Muse did not offer that decision".into());
    }
    map.remove(id)
        .ok_or("Unknown Muse approval")?
        .reply
        .send(decision.to_owned())
        .map_err(|_| "Muse approval is no longer active".into())
}
pub(crate) fn cancel_thread(thread: &str) {
    if let Ok(mut map) = pending().lock() {
        map.retain(|_, entry| entry.thread != thread);
    }
}
pub(crate) fn cancel_native(bus: &EventBus, turn: &RootTurn, native: &str) {
    let ids = if let Ok(mut map) = pending().lock() {
        let ids: Vec<_> = map
            .iter()
            .filter(|(_, entry)| entry.thread == turn.thread_id && entry.native == native)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            map.remove(id);
        }
        ids
    } else {
        Vec::new()
    };
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for id in ids {
        let _ = crate::provider::ingest::cancel_native_request(bus, turn, &id, &at);
    }
}
pub(crate) fn project(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    approval: &Value,
    ordinal: u64,
    cancelled: &Arc<AtomicBool>,
) -> Result<oneshot::Receiver<String>, String> {
    if approval["sessionId"] != turn.native_thread_id {
        return Err("Muse approval belongs to another session".into());
    }
    let native = approval["approvalId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Invalid Muse approval")?;
    let choices = super::muse_events::approval_choices(approval)?;
    if choices.is_empty() {
        return Err("Muse offered no supported approval decisions".into());
    }
    let kind = match approval["subject"]["kind"].as_str() {
        Some("file") if approval["subject"]["access"] == "read" => "file-read",
        Some("file") => "file-change",
        _ => "command",
    };
    let id = format!(
        "runtime-request:provider:muse:{}:{}",
        turn.provider_turn_id,
        uuid::Uuid::new_v4()
    );
    let node = format!("node:runtime-request:{id}");
    let item = format!("turn-item:runtime-request:{id}");
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let reference = json!({"driver":"muse","nativeId":native,"strength":"strong"});
    let request = json!({"id":id,"nodeId":node,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":reference,"kind":kind,"status":"pending","responseCapability":{"type":"live","providerSessionId":session},"createdAt":at,"resolvedAt":null});
    let node_value = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"approval_request","status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let prompt = approval["subject"]["command"]
        .as_str()
        .or_else(|| approval["subject"]["path"].as_str())
        .or_else(|| approval["toolName"].as_str())
        .unwrap_or("Approval requested");
    let options: Vec<Value> = choices
        .iter()
        .map(|(decision, choice)| json!({"decision":decision,"label":choice["label"]}))
        .collect();
    let item_value = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"approval_request","requestId":id,"requestKind":kind,"prompt":prompt,"options":options});
    let artifact = RequestArtifacts {
        request,
        node: node_value,
        item: item_value,
        method: "muse:approval".into(),
        params: json!({}),
    };
    let (tx, rx) = oneshot::channel();
    let mut map = pending()
        .lock()
        .map_err(|_| "Muse approval registry unavailable")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Muse turn cancelled".into());
    }
    if map
        .values()
        .filter(|entry| entry.thread == turn.thread_id)
        .count()
        >= 128
        || map
            .values()
            .any(|entry| entry.thread == turn.thread_id && entry.native == native)
    {
        return Err("Duplicate or excessive Muse approval".into());
    }
    map.insert(
        id.clone(),
        Pending {
            thread: turn.thread_id.clone(),
            native: native.to_owned(),
            choices,
            reply: tx,
        },
    );
    if let Err(error) = codex_requests::ingest(bus, turn, &artifact, &at) {
        map.remove(&id);
        return Err(error.to_string());
    }
    Ok(rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn only_offered_decisions_are_delivered_once() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        pending().lock().unwrap().insert(
            id.clone(),
            Pending {
                thread: "thread".into(),
                native: "native".into(),
                choices: HashMap::from([("accept".into(), json!({"choiceId":"once"}))]),
                reply: tx,
            },
        );
        assert!(deliver(&id, "acceptAlways").is_err());
        assert!(owns(&id));
        deliver(&id, "accept").unwrap();
        assert_eq!(rx.await.unwrap(), "accept");
        assert!(!owns(&id));
    }
}
