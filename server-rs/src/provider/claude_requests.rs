//! Live Claude permission callbacks, projected through the shared request store.
use crate::{
    event_bus::EventBus,
    provider::{
        codex_events::RootTurn,
        codex_requests::{self, RequestArtifacts},
    },
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};
use tokio::sync::{mpsc, oneshot};
pub(crate) struct ProcessWrite {
    pub value: Value,
    pub ack: Option<oneshot::Sender<Result<(), String>>>,
    pub begin: Option<RootTurn>,
}
struct Pending {
    native: String,
    native_item: String,
    tool: String,
    suggestions: Value,
    input: Value,
    output: mpsc::UnboundedSender<ProcessWrite>,
    turn: String,
    questions: Vec<(String, String)>,
    elicitation: Option<Value>,
    grant_key: Option<String>,
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static P: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
fn grants() -> &'static Mutex<HashSet<String>> {
    static GRANTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashSet::new()))
}
pub(crate) fn clear_session(thread: &str) {
    if let Ok(mut grants) = grants().lock() {
        let prefix = format!("{thread}\0");
        grants.retain(|key| !key.starts_with(&prefix));
    }
}
pub(crate) fn register(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    event: &Value,
    ordinal: u64,
    output: mpsc::UnboundedSender<ProcessWrite>,
) -> Result<(), String> {
    let native = event["request_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Missing Claude request id")?;
    let request = &event["request"];
    let tool = request["tool_name"]
        .as_str()
        .ok_or("Missing Claude tool name")?;
    let native_item = request["tool_use_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(native);
    let is_question = tool == "AskUserQuestion";
    let kind = match tool.to_ascii_lowercase().as_str() {
        "askuserquestion" => "user_input",
        "mcpelicitation" => "mcp-elicitation",
        "read" | "glob" | "grep" | "ls" => "file-read",
        "write" | "edit" | "multiedit" | "notebookedit" => "file-change",
        _ => "command",
    };
    let id = format!(
        "runtime-request:provider:claudeAgent:{}:{}",
        turn.provider_turn_id,
        uuid::Uuid::new_v4()
    );
    let node_id = format!("node:runtime-request:{id}");
    let item_id = format!("turn-item:runtime-request:{id}");
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let reference = json!({"driver":"claudeAgent","nativeId":native_item,"strength":"strong"});
    let item_type = if is_question {
        "user_input_request"
    } else {
        "approval_request"
    };
    let parent = if kind == "mcp-elicitation" {
        turn.root_node_id.clone()
    } else {
        format!(
            "node:provider:claudeAgent:native-item:{}",
            crate::message_commands::encode_id_part(native_item)
        )
    };
    let node = json!({"id":node_id,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":parent,"rootNodeId":turn.root_node_id,"kind":item_type,"status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let runtime = json!({"id":id,"nodeId":node_id,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":{"driver":"claudeAgent","nativeId":native,"strength":"strong"},"kind":kind,"status":"pending","responseCapability":{"type":"live","providerSessionId":session},"createdAt":at,"resolvedAt":null});
    let prompt = request["input"]["command"]
        .as_str()
        .or_else(|| request["title"].as_str())
        .or_else(|| request["description"].as_str())
        .or_else(|| request["message"].as_str())
        .unwrap_or(tool);
    let mut item = json!({"id":item_id,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node_id,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":item_type,"requestId":id});
    let mut questions = Vec::new();
    if is_question {
        let raw = request["input"]["questions"]
            .as_array()
            .ok_or("Missing Claude questions")?;
        let mut projected = Vec::new();
        for (index, q) in raw.iter().enumerate() {
            let question = q["question"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Missing Claude question")?;
            let question_id = question.trim().to_owned();
            let options=q["options"].as_array().into_iter().flatten().filter_map(|o|o["label"].as_str().filter(|s|!s.trim().is_empty()).map(|label|json!({"label":label,"description":o["description"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or(label)}))).collect::<Vec<_>>();
            projected.push(json!({"id":question_id,"header":q["header"].as_str().map(str::trim).filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("Question {}",index+1)),"question":question.trim(),"options":options,"multiSelect":q["multiSelect"]==true}));
            questions.push((question_id, question.trim().to_owned()));
        }
        item["questions"] = json!(projected);
    } else {
        item["requestKind"] = json!(kind);
        item["prompt"] = if kind == "mcp-elicitation" {
            request["message"].clone()
        } else {
            json!(prompt)
        };
        if kind == "mcp-elicitation" {
            item["appName"] = request["_app_name"].clone();
            item["options"] = json!([{"decision":"cancel","label":"Cancel"},{"decision":"decline","label":"Decline"},{"decision":"acceptForSession","label":"Always allow this session"},{"decision":"accept","label":"Approve"}]);
        }
    }
    let artifact = RequestArtifacts {
        request: runtime,
        node,
        item,
        method: "claude:approval".into(),
        params: request.clone(),
    };
    pending()
        .lock()
        .map_err(|_| "Claude approval registry unavailable")?
        .insert(
            id.clone(),
            Pending {
                native: native.into(),
                native_item: native_item.into(),
                tool: tool.into(),
                suggestions: request["permission_suggestions"].clone(),
                input: request["input"].clone(),
                output,
                turn: turn.provider_turn_id.clone(),
                questions,
                elicitation: request.get("_elicitation").cloned(),
                grant_key: request["_grant_key"].as_str().map(str::to_owned),
            },
        );
    if let Err(e) = codex_requests::ingest(bus, turn, &artifact, &at) {
        pending().lock().ok().map(|mut p| p.remove(&id));
        return Err(e.to_string());
    }
    Ok(())
}
pub(crate) fn register_elicitation(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    event: &Value,
    ordinal: u64,
    output: mpsc::UnboundedSender<ProcessWrite>,
) -> Result<bool, String> {
    let request = &event["request"];
    if request["mode"] == "url" {
        return Ok(false);
    }
    let Some(schema) = request["requested_schema"].as_object() else {
        return Ok(false);
    };
    if schema.get("properties").is_some_and(|v| !v.is_object())
        || schema.get("required").is_some_and(|v| {
            !v.is_null() && !v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
        })
    {
        return Ok(false);
    }
    let mut content = serde_json::Map::new();
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, field) in properties {
            if !field.is_object() {
                return Ok(false);
            }
            let options: Vec<&str> =
                if let Some(one_of) = field.get("oneOf").and_then(Value::as_array) {
                    one_of.iter().filter_map(|v| v["const"].as_str()).collect()
                } else {
                    field["enum"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect()
                };
            let choice = options.into_iter().find(|value| {
                let lower = value.trim().to_ascii_lowercase();
                if ["session", "always", "permanent", "forever", "persistent"]
                    .iter()
                    .any(|word| lower.contains(word))
                {
                    return false;
                }
                let normalized: String = lower
                    .chars()
                    .filter(|c| !matches!(c, ' ' | '_' | '-'))
                    .collect();
                [
                    "once",
                    "accept",
                    "approve",
                    "allow",
                    "acceptonce",
                    "approveonce",
                    "allowonce",
                    "acceptonceonly",
                    "approveonceonly",
                    "allowonceonly",
                    "acceptthistime",
                    "approvethistime",
                    "allowthistime",
                ]
                .contains(&normalized.as_str())
            });
            if let Some(choice) = choice {
                content.insert(key.clone(), json!(choice));
            } else if field["type"] == "boolean"
                && [
                    key.as_str(),
                    field["title"].as_str().unwrap_or(""),
                    field["description"].as_str().unwrap_or(""),
                ]
                .iter()
                .any(|s| {
                    let s = s.to_ascii_lowercase();
                    s == "persist"
                        || ["session", "always", "permanent", "forever", "persistent"]
                            .iter()
                            .any(|word| s.contains(word))
                })
            {
                content.insert(key.clone(), json!(false));
            }
        }
    }
    if schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|required| {
            required
                .iter()
                .filter_map(Value::as_str)
                .any(|key| !content.contains_key(key))
        })
    {
        return Ok(false);
    }
    let native = event["request_id"]
        .as_str()
        .ok_or("Missing Claude request id")?;
    let key = format!(
        "{}\0{}\0{}",
        turn.thread_id,
        request["mcp_server_name"].as_str().unwrap_or(""),
        request["message"].as_str().unwrap_or("")
    );
    if grants()
        .lock()
        .map_err(|_| "Claude grant registry unavailable")?
        .contains(&key)
    {
        output.send(ProcessWrite{value:json!({"type":"control_response","response":{"subtype":"success","request_id":native,"response":{"action":"accept","content":content}}}),ack:None,begin:None}).map_err(|_|"Claude session is no longer active")?;
        return Ok(true);
    }
    let synthetic = json!({"request_id":native,"request":{"tool_name":"McpElicitation","tool_use_id":format!("mcp-elicitation:{native}"),"message":request["message"],"title":request["title"],"input":{},"_elicitation":content,"_grant_key":key,"_app_name":request["display_name"].as_str().or_else(||request["title"].as_str()).or_else(||request["mcp_server_name"].as_str()).unwrap_or("MCP")}});
    register(bus, turn, session, &synthetic, ordinal, output)?;
    Ok(true)
}
pub(crate) fn deliver(
    id: &str,
    decision: Option<&str>,
    answers: Option<&Value>,
) -> Result<(), String> {
    let mut registry = pending()
        .lock()
        .map_err(|_| "Claude approval registry unavailable")?;
    let request = registry
        .get(id)
        .ok_or("Unknown or expired runtime request")?;
    let answer = if let Some(content) = &request.elicitation {
        match decision.ok_or("Missing approval decision")? {
            "accept" | "acceptForSession" => {
                if decision == Some("acceptForSession") {
                    if let Some(key) = &request.grant_key {
                        grants()
                            .lock()
                            .map_err(|_| "Claude grant registry unavailable")?
                            .insert(key.clone());
                    }
                }
                json!({"action":"accept","content":content})
            }
            "cancel" => json!({"action":"cancel"}),
            "decline" | "acceptAlways" => json!({"action":"decline"}),
            _ => return Err("Invalid approval decision".into()),
        }
    } else if request.questions.is_empty() {
        let decision = decision.ok_or("Missing approval decision")?;
        if !matches!(
            decision,
            "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
        ) {
            return Err("Invalid approval decision".into());
        }
        if matches!(decision, "accept" | "acceptForSession" | "acceptAlways") {
            let mut result = json!({"behavior":"allow","updatedInput":request.input,"toolUseID":request.native_item,"decisionClassification":if decision=="accept" {"user_temporary"}else{"user_permanent"}});
            if decision != "accept" {
                let mut updates = request.suggestions.as_array().cloned().unwrap_or_default();
                if updates.is_empty() {
                    updates.push(json!({"type":"addRules","rules":[{"toolName":request.tool}],"behavior":"allow","destination":"session"}));
                } else {
                    for update in &mut updates {
                        if let Some(object) = update.as_object_mut() {
                            object.insert("destination".into(), json!("session"));
                        }
                    }
                }
                result["updatedPermissions"] = json!(updates);
            }
            result
        } else {
            json!({"behavior":"deny","message":"The user declined the request.","interrupt":decision=="cancel","toolUseID":request.native_item})
        }
    } else {
        let answers = answers
            .and_then(Value::as_object)
            .ok_or("Missing answers")?;
        let mut mapped = serde_json::Map::new();
        for (id, question) in &request.questions {
            if let Some(value) = answers.get(id) {
                let value = value.get("answers").unwrap_or(value);
                let answer = if let Some(array) = value.as_array() {
                    array
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                } else {
                    value.as_str().unwrap_or("").to_owned()
                };
                mapped.insert(question.clone(), json!(answer));
            }
        }
        let mut input = request.input.clone();
        input["answers"] = Value::Object(mapped);
        json!({"behavior":"allow","updatedInput":input,"toolUseID":request.native_item})
    };
    let request = registry.remove(id).unwrap();
    request.output.send(ProcessWrite{value:json!({"type":"control_response","response":{"subtype":"success","request_id":request.native,"response":answer}}),ack:None,begin:None}).map_err(|_|"Claude session is no longer active".to_owned())
}
pub(crate) fn cancel_native(bus: &EventBus, turn: &RootTurn, native: &str) -> Result<(), String> {
    let id = {
        let mut entries = pending()
            .lock()
            .map_err(|_| "Claude approval registry unavailable")?;
        let id = entries
            .iter()
            .find(|(_, entry)| entry.turn == turn.provider_turn_id && entry.native == native)
            .map(|(id, _)| id.clone());
        if let Some(id) = &id {
            entries.remove(id);
        }
        id
    };
    if let Some(id) = id {
        crate::provider::ingest::cancel_native_request(
            bus,
            turn,
            &id,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn forget_turn(turn: &str) {
    if let Ok(mut p) = pending().lock() {
        p.retain(|_, value| value.turn != turn)
    }
}
