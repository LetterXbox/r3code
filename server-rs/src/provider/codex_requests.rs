//! Translation and durable projection of live Codex server requests.
use super::codex_events::RootTurn;
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
};
use rusqlite::params;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct RequestArtifacts {
    pub request: Value,
    pub node: Value,
    pub item: Value,
    pub method: String,
    pub params: Value,
}

fn nonempty<'a>(v: &'a Value, default: &'a str) -> &'a str {
    v.as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default)
}

/// Translate only requests belonging to the active root turn. Unknown methods
/// remain errors, so callers cannot accidentally acknowledge unsupported work.
pub fn translate(
    turn: &RootTurn,
    session_id: &str,
    method: &str,
    params: Value,
    at: &str,
    ordinal: u64,
) -> Result<RequestArtifacts, String> {
    let legacy = matches!(method, "execCommandApproval" | "applyPatchApproval");
    let expected = if legacy {
        params.get("conversationId").and_then(Value::as_str) == Some(&turn.native_thread_id)
    } else {
        params.get("turnId").and_then(Value::as_str) == Some(&turn.native_turn_id)
            && params.get("threadId").and_then(Value::as_str) == Some(&turn.native_thread_id)
    };
    if !expected {
        return Err("Codex request does not belong to the active turn".into());
    }
    let item_id = params
        .get(if legacy { "callId" } else { "itemId" })
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Missing native item id")?;
    let native_request = if matches!(
        method,
        "item/commandExecution/requestApproval" | "execCommandApproval"
    ) {
        params
            .get("approvalId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(item_id)
    } else {
        item_id
    };
    let kind = match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => "command",
        "item/fileChange/requestApproval" | "applyPatchApproval" => "file-change",
        "item/tool/requestUserInput" => "user_input",
        "item/permissions/requestApproval" => {
            let fs = &params["permissions"]["fileSystem"];
            let asks = |access: &str| {
                fs[access].as_array().is_some_and(|a| !a.is_empty())
                    || fs["entries"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|e| e["access"] == access))
            };
            if asks("write") {
                "file-change"
            } else if asks("read") {
                "file-read"
            } else {
                "command"
            }
        }
        _ => return Err(format!("Unsupported Codex server request: {method}")),
    };
    let request_id = format!(
        "runtime-request:provider:codex:provider-turn:{}:native-request:{}:{}",
        turn.provider_turn_id,
        native_request,
        uuid::Uuid::new_v4()
    );
    let node_id = format!("node:runtime-request:{request_id}");
    let item_projection_id = format!("turn-item:runtime-request:{request_id}");
    let input = kind == "user_input";
    let item_type = if input {
        "user_input_request"
    } else {
        "approval_request"
    };
    let native = json!({"driver":"codex","nativeId":item_id,"strength":"strong"});
    let parent = if input {
        turn.root_node_id.clone()
    } else {
        format!("node:provider:codex:native-item:{item_id}")
    };
    let node = json!({"id":node_id,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":parent,"rootNodeId":turn.root_node_id,"kind":item_type,"status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":request_id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let request = json!({"id":request_id,"nodeId":node_id,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":{"driver":"codex","nativeId":native_request,"strength":"strong"},"kind":kind,"status":"pending","responseCapability":{"type":"live","providerSessionId":session_id},"createdAt":at,"resolvedAt":null});
    let mut item = json!({"id":item_projection_id,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node_id,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":item_type,"requestId":request_id});
    if input {
        let questions = params["questions"].as_array().ok_or("Missing questions")?.iter().enumerate().map(|(i,q)| {
            let id = format!("question-{}",i+1);
            let options:Vec<Value> = q["options"].as_array().into_iter().flatten().enumerate().map(|(j,o)| { let fallback=format!("Option {}",j+1); let label=nonempty(&o["label"],&fallback); json!({"label":label,"description":nonempty(&o["description"],label)}) }).collect();
            json!({"id":nonempty(&q["id"],&id),"header":nonempty(&q["header"],"Question"),"question":nonempty(&q["question"],"Choose an answer."),"options":options})
        }).collect::<Vec<_>>();
        item["questions"] = json!(questions);
    } else {
        item["requestKind"] = json!(kind);
        if matches!(
            method,
            "item/fileChange/requestApproval" | "applyPatchApproval"
        ) {
            let reason = params["reason"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let mut entries = params["fileChanges"]
                .as_object()
                .map(|o| o.iter().collect::<Vec<_>>())
                .unwrap_or_default();
            entries.sort_by_key(|(path, _)| *path);
            let mut lines: Vec<String> = entries
                .iter()
                .take(20)
                .map(|(path, kind)| {
                    let op = kind["type"].as_str().unwrap_or("");
                    match kind["move_path"]
                        .as_str()
                        .filter(|s| op == "update" && !s.is_empty())
                    {
                        Some(dest) => format!("{op} {path} -> {dest}"),
                        None => format!("{op} {path}"),
                    }
                })
                .collect();
            if entries.len() > 20 {
                lines.push(format!("+{} more", entries.len() - 20));
            }
            let prompt = reason
                .map(str::to_owned)
                .or_else(|| (!lines.is_empty()).then(|| lines.join("\n")))
                .or_else(|| {
                    params["grantRoot"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                });
            item["prompt"] = json!(prompt);
        } else if let Some(prompt) = params
            .get("reason")
            .filter(|v| !v.is_null())
            .or_else(|| params.get("command").filter(|v| v.is_string()))
        {
            item["prompt"] = prompt.clone();
        }
    }
    Ok(RequestArtifacts {
        request,
        node,
        item,
        method: method.into(),
        params,
    })
}

/// Commit the three projection updates and publish their events atomically.
pub fn ingest(
    bus: &EventBus,
    turn: &RootTurn,
    artifacts: &RequestArtifacts,
    at: &str,
) -> Result<(), BusError> {
    bus.commit(|tx| {
        let n=&artifacts.node; let i=&artifacts.item; let r=&artifacts.request;
        let s=|v: &Value| v.as_str().unwrap_or("").to_owned();
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,'waiting',?7,?8,?9,NULL,?10)",params![s(&n["id"]),turn.thread_id,turn.run_id,s(&n["parentNodeId"]),turn.root_node_id,s(&n["kind"]),turn.provider_thread_id,turn.provider_turn_id,at,n.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'waiting',?9,?10)",params![s(&i["id"]),turn.thread_id,turn.run_id,s(&n["id"]),turn.provider_thread_id,turn.provider_turn_id,i["ordinal"].as_u64().unwrap_or(0),s(&i["type"]),at,i.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json) VALUES (?1,?2,?3,?4,?5,'pending',?6,NULL,?7)",params![s(&r["id"]),turn.thread_id,s(&n["id"]),turn.provider_turn_id,s(&r["kind"]),at,r.to_string()])?;
        let events = [("node.updated",n),("turn-item.updated",i),("runtime-request.updated",r)].into_iter().map(|(kind,payload)| Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:payload.clone(),metadata:json!({})}).collect::<Vec<_>>();
        let events=event_store::append(tx,&events)?; Ok(((),events))
    })
}

/// Convert a client response back to the native Codex result shape.
pub fn response(
    a: &RequestArtifacts,
    decision: Option<&str>,
    answers: Option<&Value>,
) -> Result<Value, String> {
    if a.method == "item/tool/requestUserInput" {
        let mut result = serde_json::Map::new();
        for (idx, q) in a.item["questions"].as_array().unwrap().iter().enumerate() {
            let Some(native) = a.params["questions"][idx]["id"].as_str() else {
                continue;
            };
            let Some(value) = answers.and_then(|v| v.get(q["id"].as_str().unwrap_or(""))) else {
                continue;
            };
            let stringify = |v: &Value| match v {
                Value::String(s) => s.clone(),
                _ => v.to_string(),
            };
            let vals: Vec<String> = match value {
                Value::Null => vec![],
                Value::Array(v) => v.iter().map(stringify).collect(),
                v => vec![stringify(v)],
            };
            result.insert(native.into(), json!({"answers":vals}));
        }
        return Ok(json!({"answers":result}));
    }
    let d = decision.ok_or("Missing approval decision")?;
    if !matches!(
        d,
        "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
    ) {
        return Err("Invalid approval decision".into());
    }
    if a.method == "item/permissions/requestApproval" {
        return Ok(
            json!({"permissions":if matches!(d,"accept"|"acceptForSession") {a.params["permissions"].clone()} else {json!({})},"scope":if d=="acceptForSession" {"session"} else {"turn"}}),
        );
    }
    if matches!(
        a.method.as_str(),
        "execCommandApproval" | "applyPatchApproval"
    ) {
        return Ok(
            json!({"decision":match d {"accept"=>json!("approved"),"acceptForSession"|"acceptAlways"=>json!("approved_for_session"),"decline"=>json!({"denied":{"rejection":"User declined the request."}}),_=>json!("abort")}}),
        );
    }
    Ok(json!({"decision":if d=="acceptAlways" {"acceptForSession"} else {d}}))
}

// The native JSON-RPC id is process-bound and deliberately never persisted as
// answerable state across restarts. The durable projection remains the source
// of user-facing request state.
struct Pending {
    session: super::session_registry::SessionHandle,
    native_id: Value,
    artifacts: RequestArtifacts,
}
fn pending() -> &'static std::sync::Mutex<std::collections::HashMap<String, Pending>> {
    static PENDING: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Pending>>,
    > = std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}
pub fn register(
    session: super::session_registry::SessionHandle,
    native_id: Value,
    artifacts: RequestArtifacts,
) {
    pending().lock().unwrap().insert(
        artifacts.request["id"].as_str().unwrap().to_owned(),
        Pending {
            session,
            native_id,
            artifacts,
        },
    );
}
pub fn forget(id: &str) {
    pending().lock().unwrap().remove(id);
}
pub async fn deliver(
    id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
) -> Result<(), String> {
    let p = pending()
        .lock()
        .map_err(|_| "Request registry poisoned")?
        .remove(id)
        .ok_or("Unknown or expired runtime request")?;
    let result = match response(&p.artifacts, decision, answers) {
        Ok(result) => result,
        Err(e) => {
            pending().lock().unwrap().insert(id.into(), p);
            return Err(e);
        }
    };
    match p.session.respond(p.native_id.clone(), Ok(result)).await {
        Ok(()) => Ok(()),
        Err(error) => {
            // A failed send has not completed the response; retain the live
            // correlation so the outbox retry can attempt delivery again.
            pending()
                .lock()
                .map_err(|_| "Request registry poisoned")?
                .insert(id.into(), p);
            Err(error.to_string())
        }
    }
}

/// Resolve a live request and enqueue delivery in the same transaction.
pub fn respond_command(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    at: &str,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError> {
    respond_command_checked(
        bus,
        command_id,
        thread_id,
        request_id,
        decision,
        answers,
        at,
        |_| Ok(()),
    )
}

/// Resolve a request using the current server settings for message delivery.
#[allow(clippy::too_many_arguments)]
pub fn respond_command_with_settings(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    at: &str,
    settings: &crate::settings::Settings,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError> {
    respond_command_with_settings_and_attachments(
        bus,
        command_id,
        thread_id,
        request_id,
        decision,
        answers,
        None,
        at,
        settings,
    )
}

/// Resolve a request using the current server settings and claimed question attachments.
#[allow(clippy::too_many_arguments)]
pub fn respond_command_with_settings_and_attachments(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    attachments_by_question_id: Option<&Value>,
    at: &str,
    settings: &crate::settings::Settings,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError> {
    respond_command_checked_with_settings_and_attachments(
        bus,
        command_id,
        thread_id,
        request_id,
        decision,
        answers,
        attachments_by_question_id,
        at,
        Some(settings),
        |_| Ok(()),
    )
}

/// Run a caller-supplied authorization check under the response transaction lock.
#[allow(clippy::too_many_arguments)]
pub fn respond_command_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    at: &str,
    check: F,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    respond_command_checked_with_settings(
        bus, command_id, thread_id, request_id, decision, answers, at, None, check,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn respond_command_checked_with_settings<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    at: &str,
    settings: Option<&crate::settings::Settings>,
    check: F,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    respond_command_checked_with_settings_and_attachments(
        bus, command_id, thread_id, request_id, decision, answers, None, at, settings, check,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn respond_command_checked_with_settings_and_attachments<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    request_id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
    attachments_by_question_id: Option<&Value>,
    at: &str,
    settings: Option<&crate::settings::Settings>,
    check: F,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    use crate::{
        event_store::Receipt,
        message_commands::DispatchError,
        outbox::{self, Effect},
        thread_commands::CommitResult,
    };
    use rusqlite::OptionalExtension;
    let normalized_answers = answers.map(|answers| {
        answers
            .as_object()
            .map(|map| {
                map.iter()
                    .map(|(key, value)| {
                        let value = value
                            .as_object()
                            .and_then(|o| o.get("answers"))
                            .unwrap_or(value);
                        (key.clone(), value.clone())
                    })
                    .collect::<serde_json::Map<String, Value>>()
            })
            .map(Value::Object)
    });
    let answers_valid = normalized_answers.as_ref().is_none_or(|v| {
        v.as_ref().is_some_and(|v| {
            v.as_object().is_some_and(|map| {
                map.values().all(|v| {
                    v.is_string() || v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                })
            })
        })
    });
    let answers = normalized_answers.as_ref().and_then(Option::as_ref);
    bus.commit_with(|tx| {
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {
            if receipt.aggregate_id != thread_id { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult {receipt,committed:false},vec![]));
        }
        let row:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1 AND thread_id=?2 AND status='pending'",params![request_id,thread_id],|r|r.get(0)).optional()?;
        let mut receipt=Receipt {command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"runtime-request.respond".into(),accepted_at:at.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:"accepted".into(),error:None};
        let Some(row)=row else {receipt.status="rejected".into(); receipt.error=Some("This question has already been answered.".into()); event_store::insert_receipt_if_absent(tx,&receipt)?; return Ok((CommitResult{receipt,committed:false},vec![]));};
        let mut request:Value=serde_json::from_str(&row).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let capability=request.pointer("/responseCapability/type").and_then(Value::as_str).unwrap_or("").to_owned();
        let valid=if request["kind"]=="user_input" {answers.is_some_and(Value::is_object) || matches!(decision,Some("decline"|"cancel"))} else {decision.is_some_and(|d| matches!(d,"accept"|"acceptForSession"|"acceptAlways"|"decline"|"cancel"))};
        let offered = if request["nativeRequestRef"]["driver"] == "muse" && request["kind"] != "user_input" {
            let item:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE node_id=?1 AND json_extract(payload_json,'$.requestId')=?2",params![request["nodeId"].as_str(),request_id],|row|row.get(0)).optional()?;
            item.and_then(|raw|serde_json::from_str::<Value>(&raw).ok()).and_then(|item|item["options"].as_array().cloned()).is_some_and(|options|decision.is_some_and(|d|options.iter().any(|option|option["decision"]==d)))
        } else { true };
        if !valid || !offered || !answers_valid || !matches!(capability.as_str(),"live"|"message") {receipt.status="rejected".into();receipt.error=Some("Invalid response to runtime request.".into());event_store::insert_receipt_if_absent(tx,&receipt)?;return Ok((CommitResult{receipt,committed:false},vec![]));}
        let cancelled=matches!(decision,Some("decline"|"cancel")); let status=if cancelled {"cancelled"} else {"completed"};
        let mut replies = Vec::new();
        if capability == "message" && !cancelled {
            if let Some(settings) = settings {
                let thread: Option<(String,String)> = tx.query_row("SELECT project_id,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((project,raw)) = thread {
                    let thread: Value = serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                    let instance=thread.pointer("/modelSelection/instanceId").and_then(Value::as_str).unwrap_or("");
                    let snapshot=settings.snapshot();
                    let entry = snapshot["providerInstances"].get(instance);
                    let enabled = snapshot["projectSettingsOverrides"][&project]["providerInstances"][instance]["enabled"].as_bool().unwrap_or_else(|| match entry {
                        None => matches!(instance, "codex" | "claudeAgent"),
                        Some(entry) => {
                            let enabled = entry["enabled"].as_bool();
                            let config_enabled = entry["config"]["enabled"].as_bool();
                            if enabled == Some(false) || config_enabled == Some(false) { false } else {
                                enabled.or(config_enabled).unwrap_or_else(|| !matches!(entry["driver"].as_str(), Some("cursor" | "grok" | "fx" | "kiro" | "muse" | "pi" | "opencode" | "antigravity")))
                            }
                        }
                    });
                    if !enabled {receipt.status="rejected".into();receipt.error=Some("The provider for this project is disabled.".into());event_store::insert_receipt_if_absent(tx,&receipt)?;return Ok((CommitResult{receipt,committed:false},vec![]));}
                }
            }
            let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND node_id=?2 AND type='user_input_request'",params![thread_id,request["nodeId"].as_str()],|r|r.get(0)).optional()?;
            let item: Value = match raw { Some(raw) => serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?, None => {receipt.status="rejected".into(); receipt.error=Some("The question for this request was not found.".into()); event_store::insert_receipt_if_absent(tx,&receipt)?; return Ok((CommitResult{receipt,committed:false},vec![]));} };
            let questions=item["questions"].as_array().cloned().unwrap_or_default();
            let answer_text = |v: &Value| -> Option<String> { if let Some(s)=v.as_str() { if !s.trim().is_empty() { return Some(s.trim().to_owned()); } } else if let Some(a)=v.as_array() { if !a.is_empty() && a.iter().all(|v|v.as_str().is_some_and(|s|!s.trim().is_empty())) { return Some(a.iter().map(|v|v.as_str().unwrap()).collect::<Vec<_>>().join(", ").trim().to_owned()); } } None };
            let map=answers.and_then(Value::as_object);
            let invalid_extra=map.is_some_and(|m|m.iter().any(|(id,v)| !questions.iter().any(|q|q["id"].as_str()==Some(id)) && answer_text(v).is_none()));
            let mut invalid=invalid_extra;
            for q in &questions { let answer=map.and_then(|m|q["id"].as_str().and_then(|id|m.get(id))).and_then(&answer_text); match answer { Some(a)=>replies.push(format!("{}\n{}",q["question"].as_str().unwrap_or(""),a)), None if q["required"] == false => (), None=>invalid=true } }
            let error=if invalid {Some("Answer each question before sending.")} else if replies.is_empty() {Some("Enter an answer before sending.")} else {None};
            if let Some(error)=error {receipt.status="rejected".into();receipt.error=Some(error.into());event_store::insert_receipt_if_absent(tx,&receipt)?;return Ok((CommitResult{receipt,committed:false},vec![]));}
        }
        request["status"]=json!("resolved"); request["resolvedAt"]=json!(at);
        if let Some(d)=decision {request["decision"]=json!(d);}
        if let Some(a)=answers {request["answers"]=a.clone();}
        tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='resolved',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1",params![request_id,at,request.to_string()])?;
        let node_id=request["nodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",[node_id],|r|r.get(0))?;
        let mut node:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; node["status"]=json!(status);node["completedAt"]=json!(at);
        tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1",params![node_id,status,at,node.to_string()])?;
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE node_id=?1",[node_id],|r|r.get(0))?;
        let mut item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; item["status"]=json!(status);item["completedAt"]=json!(at);item["updatedAt"]=json!(at);
        if let Some(a)=answers {let questions=item["questions"].as_array().cloned().unwrap_or_default();let texts:serde_json::Map<String,Value>=questions.iter().filter_map(|q|Some((q["id"].as_str()?.into(),q["question"].clone()))).collect();item["questionAnswer"]=json!({"requestId":request_id,"answers":a,"attachmentsByQuestionId":attachments_by_question_id.cloned().unwrap_or_else(|| json!({})),"questionTextById":texts});}
        tx.execute("UPDATE orchestration_v2_projection_turn_items SET status=?2,updated_at=?3,payload_json=?4 WHERE node_id=?1",params![node_id,status,at,item.to_string()])?;
        if capability == "live" {
        let mut effect_request=json!({"type":"runtime-request.respond","providerSessionId":request["responseCapability"]["providerSessionId"],"requestId":request_id});
        if let Some(d)=decision {effect_request["decision"]=json!(d);}
        if let Some(a)=answers {effect_request["answers"]=a.clone();}
        let effect=Effect{id:format!("effect:{command_id}:runtime-request.respond:{request_id}"),command_id:command_id.into(),thread_id:thread_id.into(),request:effect_request,status:"pending".into(),attempt_count:0,available_at:at.into(),lease_owner:None,created_at:at.into(),updated_at:at.into(),completed_at:None,last_error:None};outbox::enqueue(tx,&effect)?;
        }
        let events=[("runtime-request.updated",request),("node.updated",node),("turn-item.updated",item)].into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:kind.into(),occurred_at:at.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:None,actor_kind:"user".into(),payload,metadata:json!({})}).collect::<Vec<_>>();
        let mut events=event_store::append(tx,&events)?;
        if capability == "message" && !cancelled {
            let text=replies.join("\n\n"); let message_id=format!("async-answer:{request_id}");
            let cwd: String=tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root,'.') FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[thread_id],|r|r.get(0)).unwrap_or_else(|_| ".".into());
            let cmd=crate::message_commands::DispatchMessage { context: None,command_id,thread_id,message_id:&message_id,text:&text,attachments:&[],creation_source:"server",cwd:&cwd,driver:"codex"};
            let steer: Option<String> = tx.query_row("SELECT r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns pt ON pt.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') AND pt.status='running' JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=json_extract(r.payload_json,'$.providerThreadId') JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=json_extract(p.payload_json,'$.providerSessionId') WHERE r.thread_id=?1 AND r.status='running' AND json_extract(s.payload_json,'$.capabilities.turns.supportsActiveSteering')=1 ORDER BY r.ordinal DESC LIMIT 1",[thread_id],|r|r.get(0)).optional()?;
            let (dispatched,more)=if let Some(target)=steer { crate::message_commands::steer_message_tx(tx,cmd,&target,at,None,&[])? } else { crate::message_commands::dispatch_message_tx(tx,cmd,at,false,None,None)? };
            if dispatched.receipt.status != "accepted" { return Err(DispatchError::Database(rusqlite::Error::InvalidQuery)); }
            events.extend(more);
            tx.execute("UPDATE orchestration_v2_command_receipts SET command_type='runtime-request.respond' WHERE command_id=?1",[command_id])?;
            return Ok((CommitResult {receipt: Receipt {command_type:"runtime-request.respond".into(), ..dispatched.receipt},committed:true},events));
        }
        receipt.result_sequence=event_store::latest_thread_sequence(tx,Some(thread_id))?;event_store::insert_receipt_if_absent(tx,&receipt)?;
        Ok((CommitResult {receipt,committed:true},events))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn turn() -> RootTurn {
        RootTurn {
            driver: "codex".into(),
            native_thread_id: "nt".into(),
            native_turn_id: "nv".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "pv".into(),
            thread_id: "t".into(),
            run_id: Some("r".into()),
            run_attempt_id: "a".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "now".into(),
        }
    }
    #[test]
    fn translates_and_persists_user_input_and_maps_answers() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let a=translate(&turn(),"session","item/tool/requestUserInput",json!({"threadId":"nt","turnId":"nv","itemId":"call","questions":[{"id":"scope","question":"Which?","options":[{"label":"All"}]}]}),"now",1).unwrap();
        ingest(&bus, &turn(), &a, "now").unwrap();
        assert_eq!(a.item["questions"][0]["options"][0]["description"], "All");
        assert_eq!(
            response(&a, None, Some(&json!({"scope":"All","unknown":"ignored"}))).unwrap(),
            json!({"answers":{"scope":{"answers":["All"]}}})
        );
        let request_id = a.request["id"].as_str().unwrap();
        assert!(
            respond_command(
                &bus,
                "answer",
                "t",
                request_id,
                None,
                Some(&json!({"scope":"All"})),
                "later"
            )
            .unwrap()
            .committed
        );
        assert!(
            !respond_command(
                &bus,
                "answer",
                "t",
                request_id,
                None,
                Some(&json!({"scope":"All"})),
                "later"
            )
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let status: String = tx.query_row("SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1", [request_id], |r| r.get(0))?;
            assert_eq!(status, "resolved");
            let effect = crate::outbox::get(tx, &format!("effect:answer:runtime-request.respond:{request_id}"))?.unwrap();
            assert_eq!(effect.request["answers"]["scope"], "All");
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn approval_response_maps_session_and_permissions() {
        let a=translate(&turn(),"s","item/permissions/requestApproval",json!({"threadId":"nt","turnId":"nv","itemId":"i","permissions":{"fileSystem":{"entries":[{"access":"write"}]}}}),"now",1).unwrap();
        assert_eq!(a.request["kind"], "file-change");
        assert_eq!(
            response(&a, Some("acceptAlways"), None).unwrap(),
            json!({"permissions":{},"scope":"turn"})
        );
        assert_eq!(
            response(&a, Some("acceptForSession"), None).unwrap()["scope"],
            "session"
        );
    }
}
