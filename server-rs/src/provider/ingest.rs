//! Transactional projection and ordered publication of translated root-turn events.
//! This does not launch or manage provider processes.
use super::codex_events::{
    AssistantArtifact, CommandArtifact, FailureClass, NormalizedEvent, ReasoningArtifact,
    ToolArtifact, TurnStatus,
};
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
    outbox::{self, Effect},
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
mod native_subagents;

fn status(s: TurnStatus) -> &'static str {
    match s {
        TurnStatus::Running => "running",
        TurnStatus::Completed => "completed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::Failed => "failed",
    }
}
fn encoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char)
        } else {
            out.push_str(&format!("%{b:02X}"))
        }
    }
    out
}
fn id(kind: &str, driver: &str, native: &str) -> String {
    format!("{kind}:provider:{driver}:native-item:{}", encoded(native))
}
fn event(thread: &str, kind: &str, payload: Value, at: &str) -> Event {
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        aggregate_kind: "thread".into(),
        stream_id: thread.into(),
        event_type: kind.into(),
        occurred_at: at.into(),
        command_id: None,
        causation_event_id: None,
        correlation_id: None,
        actor_kind: "provider".into(),
        payload,
        metadata: json!({}),
    }
}
fn artifact(
    tx: &Transaction<'_>,
    a: &AssistantArtifact,
    kind: &str,
    native_ref: &str,
    emit: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let t = &a.turn;
    let node = id("node", &a.turn.driver, &a.native_item_id);
    let message = id("message", &a.turn.driver, &a.native_item_id);
    let item = id("turn-item", &a.turn.driver, &a.native_item_id);
    let done = if a.completed {
        Some(a.updated_at.as_str())
    } else {
        None
    };
    let state = if a.completed { "completed" } else { "running" };
    let native = json!({"driver":t.driver,"nativeId":native_ref,"strength":if t.driver == "codex" || t.driver == "claudeAgent" || t.driver == "pi" {"strong"} else {"weak"}});
    let payload = match kind {
        "node.updated" => {
            let p = json!({"id":node,"threadId":t.thread_id,"runId":t.run_id,"parentNodeId":t.root_node_id,"rootNodeId":t.root_node_id,"kind":"assistant_message","status":state,"countsForRun":false,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":a.started_at,"completedAt":done});
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?4,'assistant_message',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,t.thread_id,t.run_id,t.root_node_id,state,t.provider_thread_id,t.provider_turn_id,a.started_at,done,p.to_string()])?;
            p
        }
        "message.updated" => {
            let p = json!({"createdBy":"agent","creationSource":"provider","id":message,"threadId":t.thread_id,"runId":t.run_id,"nodeId":node,"role":"assistant","text":a.text,"attachments":[],"streaming":!a.completed,"createdAt":a.started_at,"updatedAt":a.updated_at});
            tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,?2,?3,?4,'assistant',?5,?6,?7,?8) ON CONFLICT(message_id) DO UPDATE SET streaming=excluded.streaming,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![message,t.thread_id,t.run_id,node,!a.completed,a.started_at,a.updated_at,p.to_string()])?;
            p
        }
        _ => {
            let mut p = json!({"id":item,"threadId":t.thread_id,"runId":t.run_id,"nodeId":node,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":a.ordinal,"status":state,"title":null,"startedAt":a.started_at,"completedAt":done,"updatedAt":a.updated_at,"type":"assistant_message","messageId":message,"text":a.text,"streaming":!a.completed});
            if let Some(phase) = &a.phase {
                p["phase"] = json!(phase)
            }
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'assistant_message',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,t.thread_id,t.run_id,node,t.provider_thread_id,t.provider_turn_id,a.ordinal,state,a.updated_at,p.to_string()])?;
            p
        }
    };
    emit.push(event(&t.thread_id, kind, payload, &a.updated_at));
    Ok(())
}
fn command(
    tx: &Transaction<'_>,
    a: &CommandArtifact,
    emit: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let t = &a.turn;
    let node = id("node", &a.turn.driver, &a.native_item_id);
    let item = id("turn-item", &a.turn.driver, &a.native_item_id);
    let done = (a.status != "running").then_some(a.updated_at.as_str());
    let native = json!({"driver":t.driver,"nativeId":a.native_item_id,"strength":if t.driver == "codex" || t.driver == "claudeAgent" || t.driver == "pi" {"strong"} else {"weak"}});
    let n = json!({"id":node,"threadId":t.thread_id,"runId":t.run_id,"parentNodeId":t.root_node_id,"rootNodeId":t.root_node_id,"kind":"tool_call","status":a.status,"countsForRun":false,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":a.started_at,"completedAt":done});
    let mut i = json!({"id":item,"threadId":t.thread_id,"runId":t.run_id,"nodeId":node,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":a.ordinal,"status":a.status,"title":null,"startedAt":a.started_at,"completedAt":done,"updatedAt":a.updated_at,"type":"command_execution","input":a.input,"completionWake":"always"});
    if let Some(output) = &a.output {
        i["output"] = json!(output);
    }
    if let Some(code) = a.exit_code {
        i["exitCode"] = json!(code);
    }
    tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?4,'tool_call',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,t.thread_id,t.run_id,t.root_node_id,a.status,t.provider_thread_id,t.provider_turn_id,a.started_at,done,n.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'command_execution',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,t.thread_id,t.run_id,node,t.provider_thread_id,t.provider_turn_id,a.ordinal,a.status,a.updated_at,i.to_string()])?;
    emit.push(event(&t.thread_id, "node.updated", n, &a.updated_at));
    emit.push(event(&t.thread_id, "turn-item.updated", i, &a.updated_at));
    Ok(())
}
/// Dismiss only still-pending native questions for the terminating turn. The
/// read and updates share the event transaction, preserving a concurrent answer.
fn dismiss_native_questions(
    tx: &Transaction<'_>,
    turn: &super::codex_events::RootTurn,
    at: &str,
    emit: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND provider_turn_id=?2 AND (kind='user_input' OR ?3 != 'codex') AND status='pending' AND json_type(payload_json,'$.nativeRequestRef')='object' ORDER BY created_at,runtime_request_id")?;
    let raws = stmt
        .query_map(
            params![turn.thread_id, turn.provider_turn_id, turn.driver],
            |r| r.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut nodes = Vec::new();
    let mut items = Vec::new();
    for raw in raws {
        let mut request: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let request_id = request["id"]
            .as_str()
            .ok_or(rusqlite::Error::InvalidQuery)?
            .to_owned();
        let node_id = request["nodeId"]
            .as_str()
            .ok_or(rusqlite::Error::InvalidQuery)?
            .to_owned();
        request["status"] = json!("cancelled");
        request["resolvedAt"] = json!(at);
        if tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='cancelled',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1 AND status='pending'",params![request_id,at,request.to_string()])? != 1 { continue; }
        emit.push(event(
            &turn.thread_id,
            "runtime-request.updated",
            request,
            at,
        ));
        let node: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
                [&node_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = node {
            let mut node: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            node["status"] = json!("cancelled");
            node["completedAt"] = json!(at);
            tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,at,node.to_string()])?;
            nodes.push(node);
        }
        let mut stmt=tx.prepare("SELECT turn_item_id,payload_json FROM orchestration_v2_projection_turn_items WHERE node_id=?1 AND type IN ('user_input_request','approval_request') AND json_extract(payload_json,'$.requestId')=?2")?;
        let rows = stmt
            .query_map(params![node_id, request_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (id, raw) in rows {
            let mut item: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            item["status"] = json!("cancelled");
            item["completedAt"] = json!(at);
            item["updatedAt"] = json!(at);
            tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![id,at,item.to_string()])?;
            items.push(item);
        }
    }
    emit.extend(
        nodes
            .into_iter()
            .map(|v| event(&turn.thread_id, "node.updated", v, at)),
    );
    emit.extend(
        items
            .into_iter()
            .map(|v| event(&turn.thread_id, "turn-item.updated", v, at)),
    );
    Ok(())
}

/// Cancel a live native request withdrawn by its provider, without touching a
/// response that won the race to resolve it.
pub(crate) fn cancel_native_request(
    bus: &EventBus,
    turn: &super::codex_events::RootTurn,
    request_id: &str,
    at: &str,
) -> Result<(), BusError> {
    bus.commit(|tx| {
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1 AND thread_id=?2 AND provider_turn_id=?3 AND status='pending'",params![request_id,turn.thread_id,turn.provider_turn_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok(((),vec![]))};
        let mut request:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let node_id=request["nodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        request["status"]=json!("cancelled");request["resolvedAt"]=json!(at);
        if tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='cancelled',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1 AND status='pending'",params![request_id,at,request.to_string()])? != 1 {return Ok(((),vec![]))}
        let mut events=vec![event(&turn.thread_id,"runtime-request.updated",request,at)];
        let node:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",[&node_id],|r|r.get(0)).optional()?;
        if let Some(raw)=node {let mut node:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;node["status"]=json!("cancelled");node["completedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,at,node.to_string()])?;events.push(event(&turn.thread_id,"node.updated",node,at));}
        let mut stmt=tx.prepare("SELECT turn_item_id,payload_json FROM orchestration_v2_projection_turn_items WHERE node_id=?1 AND json_extract(payload_json,'$.requestId')=?2")?;
        let rows=stmt.query_map(params![node_id,request_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
        for (id,raw) in rows {let mut item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;item["status"]=json!("cancelled");item["completedAt"]=json!(at);item["updatedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![id,at,item.to_string()])?;events.push(event(&turn.thread_id,"turn-item.updated",item,at));}
        Ok(((),event_store::append(tx,&events)?))
    })
}
fn bound_tool_output(value: &mut Value) {
    fn image_data(v: &Value) -> Option<Option<usize>> {
        if v["type"] != "image" {
            return None;
        }
        let source = v.get("source").filter(|v| v.is_object());
        let (mime, data) = if let Some(s) = source {
            if s["type"] != "base64" {
                return None;
            }
            (s["media_type"].as_str(), s["data"].as_str())
        } else {
            (v["mimeType"].as_str(), v["data"].as_str())
        };
        if !matches!(
            mime.map(|s| s.to_ascii_lowercase()).as_deref(),
            Some("image/png" | "image/jpeg" | "image/gif" | "image/webp")
        ) {
            return None;
        }
        Some(data.map(str::len))
    }
    fn strip(v: &mut Value, key: &str, depth: usize, served: bool) {
        if depth > 32 || served {
            return;
        }
        if let Some(a) = v.as_array_mut() {
            for x in a {
                strip(x, "", depth + 1, false);
            }
            return;
        }
        let Some(o) = v.as_object_mut() else {
            return;
        };
        let typ = o.get("type").and_then(Value::as_str);
        let image = typ == Some("image")
            || key == "image"
            || (["mimeType", "mime_type", "media_type", "type"]
                .iter()
                .any(|k| {
                    o.get(*k)
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.to_ascii_lowercase().starts_with("image/"))
                })
                && typ
                    .is_none_or(|s| s == "base64" || s.to_ascii_lowercase().starts_with("image/")));
        let mut removed = None;
        for (k, x) in o.iter_mut() {
            if image && matches!(k.as_str(), "data" | "blob" | "base64") {
                if let Some(s) = x.as_str() {
                    let body = s.trim_end_matches('=');
                    if s.len() >= 64
                        && s.len() - body.len() <= 2
                        && !body.is_empty()
                        && body
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"+/_-".contains(&c))
                    {
                        removed = Some(body.len() * 3 / 4);
                        *x = Value::Null;
                        continue;
                    }
                }
            }
            strip(x, k, depth + 1, false);
        }
        if let Some(size) = removed {
            o.retain(|k, v| !(matches!(k.as_str(), "data" | "blob" | "base64") && v.is_null()));
            o.insert("sizeBytes".into(), json!(size));
        }
    }
    fn candidates(a: &mut [Value]) {
        let mut count = 0;
        for v in a {
            let valid = image_data(v);
            let served =
                valid.is_some() && count < 8 && valid.flatten().is_none_or(|n| n <= 13_981_016);
            if valid.is_some() {
                count += 1;
            }
            strip(v, "", 1, served);
        }
    }
    if let Some(a) = value.as_array_mut() {
        candidates(a);
    } else if value.get("content").is_some_and(Value::is_array) {
        let o = value.as_object_mut().unwrap();
        for (k, v) in o {
            if k == "content" {
                candidates(v.as_array_mut().unwrap());
            } else {
                strip(v, k, 1, false);
            }
        }
    } else {
        let served = image_data(value).is_some_and(|n| n.is_none_or(|n| n <= 13_981_016));
        strip(value, "", 0, served);
    }
}

#[cfg(test)]
#[test]
fn bounds_only_unserved_image_bodies() {
    let data = "A".repeat(64);
    let mut output = json!((0..9)
        .map(|_| json!({"type":"image","mimeType":"image/png","data":data}))
        .collect::<Vec<_>>());
    bound_tool_output(&mut output);
    assert_eq!(output[0]["data"], data);
    assert!(output[8].get("data").is_none());
    assert_eq!(output[8]["sizeBytes"], 48);
    let mut nested = json!({"file":{"type":"image/png","base64":data}});
    bound_tool_output(&mut nested);
    assert_eq!(nested["file"]["sizeBytes"], 48);
}

fn tool(tx: &Transaction<'_>, a: &ToolArtifact, emit: &mut Vec<Event>) -> rusqlite::Result<()> {
    let t = &a.turn;
    let node = id("node", &a.turn.driver, &a.native_item_id);
    let item = id("turn-item", &a.turn.driver, &a.native_item_id);
    let done = (a.status != "running").then_some(a.updated_at.as_str());
    let native = json!({"driver":t.driver,"nativeId":a.native_item_id,"strength":if t.driver == "codex" || t.driver == "claudeAgent" || t.driver == "pi" || t.driver == "cursor" {"strong"} else {"weak"}});
    let n = json!({"id":node,"threadId":t.thread_id,"runId":t.run_id,"parentNodeId":t.root_node_id,"rootNodeId":t.root_node_id,"kind":"tool_call","status":a.status,"countsForRun":false,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":a.started_at,"completedAt":done});
    let mut i = json!({"id":item,"threadId":t.thread_id,"runId":t.run_id,"nodeId":node,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":a.ordinal,"status":a.status,"title":null,"startedAt":a.started_at,"completedAt":done,"updatedAt":a.updated_at,"type":a.kind});
    if let Some(fields) = a.fields.as_object() {
        i.as_object_mut().unwrap().extend(fields.clone());
    }
    if a.kind == "dynamic_tool" {
        if let Some(output) = i.get_mut("output") {
            bound_tool_output(output);
        }
    }
    if a.kind == "file_change" {
        for key in ["diffStr", "oldStr", "newStr"] {
            if let Some(text) = i.get(key).and_then(Value::as_str) {
                if text.len() > 32768 {
                    let marker = "\n… output truncated for transport";
                    let mut end = 32768 - marker.len();
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    i[key] = json!(format!("{}{marker}", &text[..end]));
                }
            }
        }
    }
    tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?4,'tool_call',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,t.thread_id,t.run_id,t.root_node_id,a.status,t.provider_thread_id,t.provider_turn_id,a.started_at,done,n.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,t.thread_id,t.run_id,node,t.provider_thread_id,t.provider_turn_id,a.ordinal,a.kind,a.status,a.updated_at,i.to_string()])?;
    emit.push(event(&t.thread_id, "node.updated", n, &a.updated_at));
    emit.push(event(&t.thread_id, "turn-item.updated", i, &a.updated_at));
    Ok(())
}
fn reasoning(
    tx: &Transaction<'_>,
    r: &ReasoningArtifact,
    node_update: bool,
    emit: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let a = &r.artifact;
    let t = &a.turn;
    let node = id("node", &a.turn.driver, &a.native_item_id);
    let item = id("turn-item", &a.turn.driver, &a.native_item_id);
    let state = if r.interrupted {
        "interrupted"
    } else if a.completed {
        "completed"
    } else {
        "running"
    };
    let done = a.completed.then_some(a.updated_at.as_str());
    let native = json!({"driver":t.driver,"nativeId":r.native_reasoning_item_id,"strength":if t.driver == "codex" || t.driver == "claudeAgent" || t.driver == "pi" {"strong"} else {"weak"}});
    let (kind, p) = if node_update {
        let p = json!({"id":node,"threadId":t.thread_id,"runId":t.run_id,"parentNodeId":t.root_node_id,"rootNodeId":t.root_node_id,"kind":"reasoning","status":state,"countsForRun":false,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":a.started_at,"completedAt":done});
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?4,'reasoning',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json", params![node,t.thread_id,t.run_id,t.root_node_id,state,t.provider_thread_id,t.provider_turn_id,a.started_at,done,p.to_string()])?;
        ("node.updated", p)
    } else {
        let p = json!({"id":item,"threadId":t.thread_id,"runId":t.run_id,"nodeId":node,"providerThreadId":t.provider_thread_id,"providerTurnId":t.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":a.ordinal,"status":state,"title":null,"startedAt":a.started_at,"completedAt":done,"updatedAt":a.updated_at,"type":"reasoning","text":a.text,"streaming":!a.completed});
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'reasoning',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,t.thread_id,t.run_id,node,t.provider_thread_id,t.provider_turn_id,a.ordinal,state,a.updated_at,p.to_string()])?;
        ("turn-item.updated", p)
    };
    emit.push(event(&t.thread_id, kind, p, &a.updated_at));
    Ok(())
}

// Settle only the currently-owned attempt; late terminal notifications must not
// overwrite a stopped or superseded run. The provider turn and error item have
// already been projected by the preceding normalized events.
fn finalize_run(
    tx: &Transaction<'_>,
    turn: &super::codex_events::RootTurn,
    terminal: TurnStatus,
    at: &str,
    emit: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let Some(run_id) = turn.run_id.as_deref() else {
        return Ok(());
    };
    let row: Option<(String, String)> = tx.query_row("SELECT status,payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2", params![run_id,turn.thread_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    // A translator can also be used without an orchestrated run projection.
    let Some((current, raw)) = row else {
        return Ok(());
    };
    let mut run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if !matches!(current.as_str(), "starting" | "running")
        || run.get("activeAttemptId").and_then(Value::as_str) != Some(&turn.run_attempt_id)
    {
        return Ok(());
    }
    let read = |sql: &str, id: &str| -> rusqlite::Result<Value> {
        let raw: String = tx.query_row(sql, [id], |r| r.get(0))?;
        serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)
    };
    if terminal == TurnStatus::Interrupted {
        let request_id = crate::interrupt_commands::signal(run_id, "interrupt-request");
        let request: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1", [&request_id], |r| r.get(0)).optional()?;
        if let Some(request) = request {
            let request: Value =
                serde_json::from_str(&request).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let ordinal: i64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1", [&turn.thread_id], |r| r.get(0))?;
            let item = json!({"id":crate::interrupt_commands::signal(run_id,"interrupt-result"),"threadId":turn.thread_id,"runId":run_id,"nodeId":turn.root_node_id,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":null,"parentItemId":request_id,"ordinal":ordinal,"status":"interrupted","title":"Interrupted","startedAt":at,"completedAt":at,"updatedAt":at,"type":"run_interrupt_result","message":request["message"]});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'run_interrupt_result','interrupted',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item["id"].as_str(),turn.thread_id,run_id,turn.root_node_id,turn.provider_thread_id,turn.provider_turn_id,ordinal,at,item.to_string()])?;
            emit.push(event(&turn.thread_id, "turn-item.updated", item, at));
        }
    }
    let mut attempt = read(
        "SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1",
        &turn.run_attempt_id,
    )?;
    let mut node = read(
        "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
        &turn.root_node_id,
    )?;
    let mut provider = read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", &turn.provider_thread_id)?;
    let final_status = status(terminal);
    let persisted = if terminal == TurnStatus::Completed {
        "waiting"
    } else {
        final_status
    };
    let completed = if terminal == TurnStatus::Completed {
        Value::Null
    } else {
        json!(at)
    };
    attempt["status"] = json!(final_status);
    attempt["completedAt"] = json!(at);
    run["status"] = json!(persisted);
    run["completedAt"] = completed.clone();
    node["status"] = json!(persisted);
    node["completedAt"] = completed.clone();
    provider["status"] = json!("idle");
    provider["updatedAt"] = json!(at);
    tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status=?2,payload_json=?3 WHERE attempt_id=?1", params![turn.run_attempt_id,final_status,attempt.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_runs SET status=?2,completed_at=?3,payload_json=?4 WHERE run_id=?1", params![run_id,persisted,if terminal == TurnStatus::Completed {None} else {Some(at)},run.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1", params![turn.root_node_id,persisted,if terminal == TurnStatus::Completed {None} else {Some(at)},node.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='idle',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1", params![turn.provider_thread_id,at,provider.to_string()])?;
    for (kind, payload) in [
        ("run-attempt.updated", attempt),
        ("run.updated", run),
        ("node.updated", node.clone()),
        ("provider-thread.updated", provider),
    ] {
        emit.push(event(&turn.thread_id, kind, payload, at));
    }
    if terminal != TurnStatus::Failed {
        let scope = node
            .get("checkpointScopeId")
            .and_then(Value::as_str)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let command = format!("command:effect:checkpoint.capture:{run_id}");
        let effect = Effect {
            id: format!("effect:checkpoint.capture:{run_id}"),
            command_id: command,
            thread_id: turn.thread_id.clone(),
            request: json!({"type":"checkpoint.capture","runId":run_id,"scopeId":scope}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: at.into(),
            lease_owner: None,
            created_at: at.into(),
            updated_at: at.into(),
            completed_at: None,
            last_error: None,
        };
        outbox::enqueue(tx, &effect)?;
    }
    Ok(())
}

/// Commit a batch atomically. Unsupported normalized variants fail the entire batch;
/// callers must not settle a turn until the missing handling is implemented.
pub fn ingest(bus: &EventBus, updates: &[NormalizedEvent]) -> Result<(), BusError> {
    let applied = bus.commit(|tx| { let mut events=Vec::new(); let mut applied=vec![true; updates.len()]; for (index,update) in updates.iter().enumerate() {
        // Native provider events can race a force-stop. Check the current
        // attempt in the same transaction before applying these projections.
        let guarded_turn = match update {
            NormalizedEvent::ProviderTurnUpdated { turn, .. } | NormalizedEvent::TurnTerminal { turn, .. } if matches!(turn.driver.as_str(),"cursor"|"pi") => Some(turn),
            NormalizedEvent::NodeUpdated(a) | NormalizedEvent::MessageUpdated(a) | NormalizedEvent::TurnItemUpdated(a) if matches!(a.turn.driver.as_str(),"cursor"|"pi") => Some(&a.turn),
            NormalizedEvent::ReasoningNodeUpdated(a) | NormalizedEvent::ReasoningTurnItemUpdated(a) if matches!(a.artifact.turn.driver.as_str(),"cursor"|"pi") => Some(&a.artifact.turn),
            NormalizedEvent::ToolUpdated(a) if matches!(a.turn.driver.as_str(),"cursor"|"pi") => Some(&a.turn),
            _ => None,
        };
        if let Some(turn) = guarded_turn {
            if let Some(run_id) = turn.run_id.as_deref() {
                let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status IN ('starting','running') AND json_extract(payload_json,'$.activeAttemptId')=?3)", params![run_id, turn.thread_id, turn.run_attempt_id], |row| row.get(0))?;
                if !active { applied[index]=false; continue; }
            }
        }
        match update {
        NormalizedEvent::ProviderTurnUpdated{turn,status:s,completed_at}=>{
            let p=json!({"id":turn.provider_turn_id,"providerThreadId":turn.provider_thread_id,"nodeId":turn.root_node_id,"runAttemptId":turn.run_attempt_id,"nativeTurnRef":{"driver":turn.driver,"nativeId":turn.native_turn_id,"strength":if turn.driver == "codex" || turn.driver == "cursor" {"strong"} else {"weak"}},"ordinal":turn.provider_turn_ordinal,"status":status(*s),"startedAt":turn.started_at,"completedAt":completed_at});
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(provider_turn_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![turn.provider_turn_id,turn.thread_id,turn.provider_thread_id,turn.root_node_id,turn.run_attempt_id,turn.provider_turn_ordinal,status(*s),turn.started_at,completed_at,p.to_string()])?;
            events.push(event(&turn.thread_id,"provider-turn.updated",p,completed_at.as_deref().unwrap_or(&turn.started_at)));
        },
        NormalizedEvent::TokenUsageUpdated{turn,usage,at}=>{
            let mut p: Value = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1", [&turn.provider_turn_id], |r| r.get::<_,String>(0)).and_then(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))?;
            p["turnTokenUsage"]=usage.clone();
            tx.execute("UPDATE orchestration_v2_projection_provider_turns SET payload_json=?2 WHERE provider_turn_id=?1",params![turn.provider_turn_id,p.to_string()])?;
            // Terminal status and its usage are one provider-turn update in the
            // reference event stream. Keep standalone usage updates observable.
            if let Some(previous) = events.last_mut().filter(|e| e.event_type == "provider-turn.updated" && e.payload["id"] == p["id"]) {
                previous.payload = p;
            } else {
                events.push(event(&turn.thread_id,"provider-turn.updated",p,at));
            }
        },
        NormalizedEvent::NodeUpdated(a)=>artifact(tx,a,"node.updated",&a.native_item_id,&mut events)?,
        NormalizedEvent::MessageUpdated(a)=>artifact(tx,a,"message.updated",&a.native_item_id,&mut events)?,
        NormalizedEvent::TurnItemUpdated(a)=>artifact(tx,a,"turn-item.updated",&a.native_item_id,&mut events)?,
        NormalizedEvent::ReasoningNodeUpdated(a)=>reasoning(tx,a,true,&mut events)?,
        NormalizedEvent::ReasoningTurnItemUpdated(a)=>reasoning(tx,a,false,&mut events)?,
        NormalizedEvent::CommandUpdated(a)=>command(tx,a,&mut events)?,
        NormalizedEvent::ToolUpdated(a)=>tool(tx,a,&mut events)?,
        NormalizedEvent::NativeSubagent{turn,item,ordinal,at}=>native_subagents::project(tx,turn,item,*ordinal,at,&mut events)?,
        NormalizedEvent::TurnTerminal{turn,status:s,failure,failure_item_ordinal,..}=>{
            if *s == TurnStatus::Running { return Err(rusqlite::Error::InvalidQuery); }
            let at: String = tx.query_row("SELECT completed_at FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1 AND status=?2",params![turn.provider_turn_id,status(*s)],|r| r.get(0))?;
            dismiss_native_questions(tx,turn,&at,&mut events)?;
            if *s == TurnStatus::Failed {
                let f = failure.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
                let ordinal = failure_item_ordinal.ok_or(rusqlite::Error::InvalidQuery)?;
                let item=id("turn-item",&turn.driver,&format!("terminal-failure:{}",turn.provider_turn_id));
                let class=match f.class {FailureClass::ProviderError=>"provider_error",FailureClass::UsageLimit=>"usage_limit"};
                let p=json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":turn.root_node_id,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"failed","title":if f.class==FailureClass::UsageLimit {"Usage limit reached"} else {"Provider error"},"startedAt":at,"completedAt":at,"updatedAt":at,"type":"error","failure":{"class":class,"message":f.message,"code":f.code,"retryable":f.retryable}});
                tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'error','failed',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,turn.thread_id,turn.run_id,turn.root_node_id,turn.provider_thread_id,turn.provider_turn_id,ordinal,at,p.to_string()])?;
                events.push(event(&turn.thread_id,"turn-item.updated",p,&at));
            }
            finalize_run(tx,turn,*s,&at,&mut events)?;
        },
    }} let stored=event_store::append(tx,&events)?; Ok((applied,stored)) })?;
    for (index,update) in updates.iter().enumerate() {
        if !applied[index] { continue; }
        if let NormalizedEvent::ProviderTurnUpdated {
            turn,
            status: TurnStatus::Running,
            ..
        } = update
        {
            crate::message_commands::deliver_deferred(
                bus,
                &turn.thread_id,
                &turn.run_attempt_id,
                &turn.started_at,
            )?;
        }
        if let NormalizedEvent::TurnTerminal { turn, status, .. } = update {
            if let Some(run_id) = turn.run_id.as_deref() {
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                if *status == TurnStatus::Failed {
                    crate::queue_promotion::hold_after_failure(bus, &turn.thread_id, run_id, &at)?;
                }
                if *status == TurnStatus::Interrupted {
                    crate::queue_promotion::promote(bus, &turn.thread_id, &at)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::codex_events::{RootTurn, ThreadDisposition};
    fn turn() -> RootTurn {
        RootTurn {
            driver: "codex".into(),
            native_thread_id: "native-thread".into(),
            native_turn_id: "native-turn".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "pv".into(),
            thread_id: "t".into(),
            run_id: Some("r".into()),
            run_attempt_id: "a".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:00Z".into(),
        }
    }
    fn bus() -> EventBus {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        EventBus::new(db, 16)
    }
    #[test]
    fn native_subagent_spawn_and_terminal_snapshot_are_projected() {
        use crate::provider::codex_events::{CodexRootTurnTranslator, Translation};
        let bus = bus();
        bus.commit(|tx| {
            let parent=json!({"id":"t","projectId":"p","title":"Parent","providerInstanceId":"codex","runtimeMode":"full-access","interactionMode":"default","lineage":{"rootThreadId":"t"}});
            let provider=json!({"id":"pt","providerInstanceId":"codex","providerSessionId":"session"});
            tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','Parent','codex','full-access','default','now','now',?1)",[parent.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','active','now',?1)",[provider.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let (mut translator, _) = CodexRootTurnTranslator::start(turn());
        let notify = |translator: &mut CodexRootTurnTranslator, item: Value, at: &str| {
            let Translation::Events(events) = translator
                .notification(
                    "item/completed",
                    json!({"threadId":"native-thread","turnId":"native-turn","item":item}),
                    at,
                    |_| at.into(),
                )
                .unwrap()
            else {
                panic!("unsupported")
            };
            ingest(&bus, &events).unwrap();
        };
        notify(
            &mut translator,
            json!({"type":"subAgentActivity","id":"early","kind":"started","agentThreadId":"child"}),
            "early",
        );
        notify(
            &mut translator,
            json!({"type":"collabAgentToolCall","id":"call","tool":"spawnAgent","receiverThreadIds":["child"],"prompt":"Inspect","agentsStates":{"child":{"status":"running"}}}),
            "start",
        );
        notify(
            &mut translator,
            json!({"type":"collabAgentToolCall","id":"wait","tool":"wait","agentsStates":{"child":{"status":"completed","message":"Done"}}}),
            "done",
        );
        notify(
            &mut translator,
            json!({"type":"collabAgentToolCall","id":"late","tool":"wait","agentsStates":{"child":{"status":"running"}}}),
            "late",
        );
        bus.commit(|tx| {
            let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents",[],|r|r.get(0))?;
            let task:Value=serde_json::from_str(&raw).unwrap();
            assert_eq!(task["status"],"completed"); assert_eq!(task["result"],"Done"); assert_eq!(task["completedAt"],"done");
            let children:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_threads WHERE thread_id != 't'",[],|r|r.get(0))?; assert_eq!(children,1);
            let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='subagent'",[],|r|r.get(0))?;
            let item:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(item["status"],"completed"); assert_eq!(item["prompt"],"Inspect");
            let node_status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_nodes WHERE kind='subagent'",[],|r|r.get(0))?; assert_eq!(node_status,"completed");
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn codex_usage_notification_is_persisted_on_completion() {
        use crate::provider::codex_events::{CodexRootTurnTranslator, Translation};
        let bus = bus();
        let (mut translator, started) = CodexRootTurnTranslator::start(turn());
        ingest(&bus, &[started]).unwrap();
        let counters = json!({"inputTokens":100,"cachedInputTokens":30,"outputTokens":20,"reasoningOutputTokens":5});
        assert!(matches!(translator.notification("thread/tokenUsage/updated", json!({"threadId":"native-thread","turnId":"native-turn","tokenUsage":{"total":counters,"last":counters}}), "now", |_| "now".into()).unwrap(), Translation::Events(_)));
        let Translation::Events(events) = translator.notification("turn/completed", json!({"threadId":"native-thread","turn":{"id":"native-turn","status":"completed"}}), "done", |_| "done".into()).unwrap() else { panic!("missing completion") };
        ingest(&bus, &events).unwrap();
        bus.commit(|tx| {
            let payload: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id='pv'", [], |r| r.get(0))?;
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["turnTokenUsage"]["inputTokens"], 100);
            assert_eq!(payload["turnTokenUsage"]["usageStatus"], "complete");
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn terminal_dismisses_only_unanswered_native_questions() {
        let bus = bus();
        let t = turn();
        let make = |item: &str| {
            crate::provider::codex_requests::translate(&t, "session", "item/tool/requestUserInput", json!({"threadId":"native-thread","turnId":"native-turn","itemId":item,"questions":[{"id":"q","question":"Choose"}]}), "start", 1).unwrap()
        };
        let pending = make("one");
        let answered = make("two");
        crate::provider::codex_requests::ingest(&bus, &t, &pending, "start").unwrap();
        crate::provider::codex_requests::ingest(&bus, &t, &answered, "start").unwrap();
        let answered_id = answered.request["id"].as_str().unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='resolved' WHERE runtime_request_id=?1", [answered_id])?; Ok(((),vec![])) }).unwrap();
        ingest(
            &bus,
            &[
                NormalizedEvent::ProviderTurnUpdated {
                    turn: t.clone(),
                    status: TurnStatus::Completed,
                    completed_at: Some("done".into()),
                },
                NormalizedEvent::TurnTerminal {
                    turn: t,
                    status: TurnStatus::Completed,
                    failure: None,
                    failure_item_ordinal: None,
                    thread_disposition: ThreadDisposition::Reusable,
                },
            ],
        )
        .unwrap();
        bus.commit(|tx| { let status: String=tx.query_row("SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1",[pending.request["id"].as_str().unwrap()],|r|r.get(0))?; assert_eq!(status,"cancelled"); let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?1",[answered_id],|r|r.get(0))?; assert_eq!(status,"resolved"); Ok(((),vec![])) }).unwrap();
    }
    #[test]
    fn persists_stream_and_completion_in_order() {
        let bus = bus();
        let t = turn();
        let mut a = AssistantArtifact {
            turn: t.clone(),
            native_item_id: "item:1".into(),
            phase: Some("final_answer".into()),
            text: "hello".into(),
            ordinal: 101,
            started_at: t.started_at.clone(),
            updated_at: "2026-01-01T00:00:01Z".into(),
            completed: false,
        };
        ingest(
            &bus,
            &[
                NormalizedEvent::ProviderTurnUpdated {
                    turn: t.clone(),
                    status: TurnStatus::Running,
                    completed_at: None,
                },
                NormalizedEvent::NodeUpdated(a.clone()),
                NormalizedEvent::TurnItemUpdated(a.clone()),
            ],
        )
        .unwrap();
        a.text = "hello world".into();
        a.completed = true;
        ingest(
            &bus,
            &[
                NormalizedEvent::NodeUpdated(a.clone()),
                NormalizedEvent::MessageUpdated(a.clone()),
                NormalizedEvent::TurnItemUpdated(a),
            ],
        )
        .unwrap();
        bus.commit(|tx| {
            let s: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_turn_items",
                [],
                |r| r.get(0),
            )?;
            let p: Value = serde_json::from_str(&s).unwrap();
            assert_eq!(p["text"], "hello world");
            assert_eq!(p["id"], "turn-item:provider:codex:native-item:item%3A1");
            assert_eq!(p["status"], "completed");
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_messages",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn reasoning_and_failure_are_persisted_with_terminal_update() {
        let bus = bus();
        let t = turn();
        let a = ReasoningArtifact {
            artifact: AssistantArtifact {
                turn: t.clone(),
                native_item_id: "part".into(),
                phase: None,
                text: "thinking".into(),
                ordinal: 101,
                started_at: t.started_at.clone(),
                updated_at: "end".into(),
                completed: true,
            },
            native_reasoning_item_id: "native-reasoning".into(),
            stream: "summary".into(),
            index: 0,
            interrupted: true,
        };
        let failure = super::super::codex_events::ProviderFailure {
            class: FailureClass::UsageLimit,
            message: "limit".into(),
            code: Some("limit_code".into()),
            retryable: Some(false),
            managed_usage_limit: false,
        };
        ingest(
            &bus,
            &[
                NormalizedEvent::ReasoningNodeUpdated(a.clone()),
                NormalizedEvent::ReasoningTurnItemUpdated(a),
                NormalizedEvent::ProviderTurnUpdated {
                    turn: t.clone(),
                    status: TurnStatus::Failed,
                    completed_at: Some("end".into()),
                },
                NormalizedEvent::TurnTerminal {
                    turn: t,
                    status: TurnStatus::Failed,
                    failure: Some(failure),
                    failure_item_ordinal: Some(102),
                    thread_disposition: ThreadDisposition::Reusable,
                },
            ],
        )
        .unwrap();
        bus.commit(|tx| {
            let reasoning: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='reasoning'", [], |r| r.get(0))?;
            let reasoning: Value = serde_json::from_str(&reasoning).unwrap();
            assert_eq!(reasoning["status"], "interrupted");
            assert_eq!(reasoning["nativeItemRef"]["nativeId"], "native-reasoning");
            assert_eq!(reasoning["streaming"], false);
            let failure: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='error'", [], |r| r.get(0))?;
            let failure: Value = serde_json::from_str(&failure).unwrap();
            assert_eq!(failure["title"], "Usage limit reached");
            assert_eq!(failure["failure"]["class"], "usage_limit");
            assert_eq!(reasoning["ordinal"], 1);
            assert_eq!(failure["ordinal"], 2);
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn terminal_updates_current_run_and_queues_one_capture() {
        let bus = bus();
        let t = turn();
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('r','t',1,'codex','running','start',?1)", [json!({"id":"r","activeAttemptId":"a","status":"running","delegatedCompletion":{"generation":1}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES ('a','t','r',1,'root','codex','pt','running',?1)", [json!({"id":"a","status":"running"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,checkpoint_scope_id,payload_json) VALUES ('root','t','r','root','root_turn','running','scope',?1)", [json!({"id":"root","status":"running","checkpointScopeId":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES ('pt','t','codex','active','start',?1)", [json!({"id":"pt","status":"active"}).to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        let updates = [
            NormalizedEvent::ProviderTurnUpdated {
                turn: t.clone(),
                status: TurnStatus::Completed,
                completed_at: Some("end".into()),
            },
            NormalizedEvent::TurnTerminal {
                turn: t,
                status: TurnStatus::Completed,
                failure: None,
                failure_item_ordinal: None,
                thread_disposition: ThreadDisposition::Reusable,
            },
        ];
        ingest(&bus, &updates).unwrap();
        ingest(&bus, &updates).unwrap();
        bus.commit(|tx| {
            let (status,raw): (String,String) = tx.query_row("SELECT status,payload_json FROM orchestration_v2_projection_runs WHERE run_id='r'", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"waiting");
            let run: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(run["completedAt"], Value::Null);
            assert_eq!(run["delegatedCompletion"]["generation"],1);
            let count:i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_id='effect:checkpoint.capture:r'",[],|r| r.get(0))?;
            assert_eq!(count,1);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn invalid_terminal_rolls_back_entire_batch() {
        let bus = bus();
        let t = turn();
        assert!(ingest(
            &bus,
            &[
                NormalizedEvent::ProviderTurnUpdated {
                    turn: t.clone(),
                    status: TurnStatus::Completed,
                    completed_at: Some("now".into())
                },
                NormalizedEvent::TurnTerminal {
                    turn: t,
                    status: TurnStatus::Running,
                    failure: None,
                    failure_item_ordinal: None,
                    thread_disposition: ThreadDisposition::Reusable
                }
            ]
        )
        .is_err());
        bus.commit(|tx| {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_provider_turns",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
