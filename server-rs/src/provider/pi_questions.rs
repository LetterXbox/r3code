//! Live Pi extension questions.
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
    reply: oneshot::Sender<Option<Value>>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn owns(id: &str) -> bool {
    pending().lock().is_ok_and(|map| map.contains_key(id))
}
pub(crate) fn deliver(id: &str, answers: Option<&Value>) -> Result<(), String> {
    if answers.is_some_and(|value| !value.is_object()) {
        return Err("Invalid Pi question answers".into());
    }
    let request = pending()
        .lock()
        .map_err(|_| "Pi question registry unavailable")?
        .remove(id)
        .ok_or("Unknown or expired Pi question")?;
    request
        .reply
        .send(answers.cloned())
        .map_err(|_| "Pi question is no longer active".into())
}
pub(crate) fn cancel_thread(thread: &str) {
    if let Ok(mut map) = pending().lock() {
        let keys = map
            .iter()
            .filter(|(_, p)| p.thread == thread)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in keys {
            if let Some(p) = map.remove(&id) {
                let _ = p.reply.send(None);
            }
        }
    }
}
pub(crate) fn project(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    event: &Value,
    ordinal: u64,
    cancelled: &Arc<AtomicBool>,
) -> Result<(String, oneshot::Receiver<Option<Value>>), String> {
    let native = event["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Pi question has no id")?;
    let method = event["method"]
        .as_str()
        .ok_or("Pi question has no method")?;
    if !["select", "input", "editor"].contains(&method) {
        return Err("Unsupported Pi question".into());
    }
    let title = event["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Question");
    let detail = event["message"]
        .as_str()
        .or_else(|| event["placeholder"].as_str())
        .filter(|s| !s.trim().is_empty());
    let options: Vec<Value> = if method == "select" {
        event["options"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|s|json!({"label":if s.is_empty(){"Empty value"}else{s},"description":if s.is_empty(){"Empty value"}else{s},"value":s})).collect()
    } else if method == "input" {
        vec![
            json!({"label":"Submit empty value","description":"Send an empty string to the extension.","value":""}),
        ]
    } else {
        vec![]
    };
    if options.len() > 100 {
        return Err("Too many Pi question options".into());
    }
    let mut question = json!({"id":native,"header":if detail.is_some(){title}else{"Question"},"question":detail.unwrap_or(title),"options":options});
    if method == "editor" {
        question["initialAnswer"] = json!(event["prefill"].as_str().unwrap_or(""));
    }
    let id = format!(
        "runtime-request:provider:pi:{}:{}",
        turn.provider_turn_id,
        uuid::Uuid::new_v4()
    );
    let node = format!("node:runtime-request:{id}");
    let item = format!("turn-item:runtime-request:{id}");
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let reference = json!({"driver":"pi","nativeId":native,"strength":"strong"});
    let request = json!({"id":id,"nodeId":node,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":reference,"kind":"user_input","status":"pending","responseCapability":{"type":"live","providerSessionId":session},"createdAt":at,"resolvedAt":null});
    let node_value = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"user_input_request","status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let item_value = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":title,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"user_input_request","requestId":id,"questions":[question]});
    let artifact = RequestArtifacts {
        request,
        node: node_value,
        item: item_value,
        method: "pi:question".into(),
        params: json!({}),
    };
    let (tx, rx) = oneshot::channel();
    let mut map = pending()
        .lock()
        .map_err(|_| "Pi question registry unavailable")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Pi turn already cancelled".into());
    }
    map.insert(
        id.clone(),
        Pending {
            thread: turn.thread_id.clone(),
            reply: tx,
        },
    );
    if let Err(error) = codex_requests::ingest(bus, turn, &artifact, &at) {
        map.remove(&id);
        return Err(error.to_string());
    }
    Ok((id, rx))
}
pub(crate) fn expire(bus: &EventBus, turn: &RootTurn, id: &str) {
    let removed = pending()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(id))
        .is_some();
    if removed {
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let _ = super::ingest::cancel_native_request(bus, turn, id, &at);
    }
}
