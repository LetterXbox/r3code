//! Projection of Cursor SDK tool updates into provider-neutral turn items.
use super::codex_events::{RootTurn, ToolArtifact};
use serde_json::{json, Value};

pub(crate) fn project(
    turn: &RootTurn,
    update: &Value,
    ordinal: u64,
    started: &str,
    at: &str,
) -> Result<ToolArtifact, String> {
    let call = &update["toolCall"];
    let id = update["callId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Cursor tool call is missing an ID")?;
    let kind = call["type"]
        .as_str()
        .ok_or("Cursor tool call is missing a type")?;
    if matches!(kind, "task" | "createPlan" | "updateTodos") {
        return Err("Cursor subagent and plan projections are not yet supported".into());
    }
    let completed = update["type"] == "tool-call-completed";
    let result = &call["result"];
    let failed = completed
        && (result["status"] == "error" || (kind == "mcp" && result["value"]["isError"] == true));
    let status = if !completed {
        "running"
    } else if failed {
        "failed"
    } else {
        "completed"
    };
    let output = match result["status"].as_str() {
        Some("success") => result.get("value"),
        Some("error") => result.get("error"),
        _ => None,
    };
    let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
    let (item_type, fields) = match kind {
        "shell" => {
            let stdout = result["value"]["stdout"].as_str().unwrap_or("");
            let stderr = result["value"]["stderr"].as_str().unwrap_or("");
            let joined = [stdout, stderr]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let mut fields = json!({"input":args["command"].as_str().unwrap_or("")});
            if !joined.is_empty() {
                fields["output"] = json!(joined);
            }
            if result["status"] == "success" && result["value"]["exitCode"].is_number() {
                fields["exitCode"] = result["value"]["exitCode"].clone();
            }
            ("command_execution", fields)
        }
        "write" | "delete" | "edit" | "generateImage" => {
            let filename = if kind == "generateImage" { args["filePath"].as_str().unwrap_or("generated-image") } else { args["path"].as_str().unwrap_or("") };
            let mut fields = json!({"fileName":filename});
            if kind == "write" {
                if let Some(text) = args["fileText"].as_str() { fields["newStr"] = json!(text); }
            }
            if kind == "edit" && result["status"] == "success" {
                for (from, to) in [
                    ("linesAdded", "additions"),
                    ("linesRemoved", "deletions"),
                    ("diffString", "diffStr"),
                ] {
                    if let Some(value) = result["value"].get(from) {
                        fields[to] = value.clone();
                    }
                }
            }
            ("file_change", fields)
        }
        "read" => {
            let mut fields = json!({"toolName":"Read","input":args});
            if let Some(output) = output {
                fields["output"] = output.clone();
            }
            ("dynamic_tool", fields)
        }
        "mcp" => {
            let name = if kind == "mcp" {
                call["args"]["toolName"].as_str().unwrap_or("MCP")
            } else {
                kind
            };
            let input = if kind == "mcp" {
                args.get("args").cloned().unwrap_or_else(|| json!({}))
            } else {
                args
            };
            let mut fields = json!({"toolName":name,"input":input});
            if let Some(output) = output {
                fields["output"] = output.clone();
            }
            ("dynamic_tool", fields)
        }
        _ => return Err("Cursor tool type is not yet supported".into()),
    };
    Ok(ToolArtifact {
        turn: turn.clone(),
        native_item_id: id.into(),
        ordinal,
        started_at: started.into(),
        updated_at: at.into(),
        status: status.into(),
        kind: item_type.into(),
        fields,
    })
}

/// Project Cursor's createPlan/updateTodos tool calls as plan artifacts.
/// Guard writes in the same transaction against a stopped or replaced attempt.
pub(crate) fn project_plan(bus: &crate::event_bus::EventBus, turn: &RootTurn, update: &Value, ordinal: u64, at: &str) -> Result<(), String> {
    use rusqlite::params;
    let id = update["callId"].as_str().filter(|s| !s.is_empty()).ok_or("Cursor plan call is missing an ID")?;
    let call = &update["toolCall"];
    let (prefix, node_kind, item_kind, content) = match call["type"].as_str() {
        Some("createPlan") => ("plan", "plan", "proposed_plan", json!({"markdown":call["args"]["plan"].as_str().ok_or("Cursor plan text is missing")?})),
        Some("updateTodos") => {
            let todos = if call["result"]["status"] == "success" { &call["result"]["value"]["todos"] } else { &call["args"]["todos"] };
            let todos = todos.as_array().ok_or("Cursor todo list is missing")?;
            let mut steps = Vec::new();
            for todo in todos {
                let text = todo["content"].as_str().ok_or("Cursor todo text is missing")?;
                if todo["status"] == "cancelled" || text.trim().is_empty() { continue; }
                steps.push(json!({"id":format!("todo-{}",steps.len()+1),"text":text,"status":match todo["status"].as_str(){Some("inProgress")=>"running",Some("completed")=>"completed",_=>"pending"}}));
            }
            ("todos", "todo_list", "todo_list", json!({"steps":steps}))
        }
        _ => return Err("Cursor plan type is not supported".into()),
    };
    let native = format!("{prefix}:{id}");
    let encoded = crate::message_commands::encode_id_part(&native);
    let node = format!("node:provider:cursor:native-item:{encoded}");
    let item = format!("turn-item:provider:cursor:native-item:{encoded}");
    let plan = format!("plan:provider:cursor:native-item:{encoded}");
    let completed = update["type"] == "tool-call-completed";
    let status = if completed && call["result"]["status"] == "error" { "failed" } else if completed { "completed" } else { "running" };
    let plan_status = if completed { "active" } else { "draft" };
    let reference = json!({"driver":"cursor","nativeId":id,"strength":"strong"});
    let n = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":node_kind,"status":status,"countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":turn.started_at,"completedAt":if completed {Some(at)} else {None}});
    let mut p = json!({"id":plan,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"kind":item_kind,"status":plan_status});
    p.as_object_mut().unwrap().extend(content.as_object().unwrap().clone());
    let mut i = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":status,"title":null,"startedAt":turn.started_at,"completedAt":if completed {Some(at)} else {None},"updatedAt":at,"type":item_kind,"planId":plan});
    i.as_object_mut().unwrap().extend(content.as_object().unwrap().clone());
    if item_kind == "proposed_plan" { i["streaming"] = json!(!completed); }
    bus.commit(|tx| {
        let active: Option<bool> = match turn.run_id.as_deref() {
            Some(run) => Some(tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status IN ('starting','running') AND json_extract(payload_json,'$.activeAttemptId')=?3)", params![run,turn.thread_id,turn.run_attempt_id], |r|r.get(0))?),
            None => None,
        };
        if active == Some(false) { return Ok(((),vec![])); }
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,turn.thread_id,turn.run_id,turn.root_node_id,node_kind,status,turn.provider_thread_id,turn.provider_turn_id,turn.started_at,if completed {Some(at)} else {None},n.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_plans(plan_id,thread_id,run_id,node_id,kind,status,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(plan_id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json",params![plan,turn.thread_id,turn.run_id,node,item_kind,plan_status,p.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,turn.thread_id,turn.run_id,node,turn.provider_thread_id,turn.provider_turn_id,ordinal,item_kind,status,at,i.to_string()])?;
        let events = [("node.updated",n.clone()),("plan.updated",p.clone()),("turn-item.updated",i.clone())].into_iter().map(|(kind,payload)|crate::event_store::Event {id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({})}).collect::<Vec<_>>();
        Ok(((),crate::event_store::append(tx,&events)?))
    }).map_err(|error|error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_shell_completion_with_stable_identity() {
        let turn = RootTurn {
            driver: "cursor".into(), native_thread_id: "thread".into(),
            native_turn_id: "turn".into(), provider_thread_id: "pt".into(),
            provider_turn_id: "pv".into(), thread_id: "t".into(),
            run_id: Some("run".into()), run_attempt_id: "attempt".into(),
            root_node_id: "root".into(), provider_turn_ordinal: 1, run_ordinal: 1,
            started_at: "start".into(),
        };
        let artifact = project(&turn, &json!({"type":"tool-call-completed", "callId":"call", "toolCall":{"type":"shell", "args":{"command":"pwd"}, "result":{"status":"success", "value":{"stdout":"/tmp", "exitCode":0}}}}), 7, "start", "end").unwrap();
        assert_eq!(artifact.native_item_id, "call");
        assert_eq!(artifact.kind, "command_execution");
        assert_eq!(artifact.status, "completed");
        assert_eq!(artifact.fields["output"], "/tmp");
        assert_eq!(artifact.fields["exitCode"], 0);
        let write = project(&turn, &json!({"type":"tool-call-completed","callId":"write","toolCall":{"type":"write","args":{"path":"src/a","fileText":"new contents"},"result":{"status":"success","value":{}}}}), 8, "start", "end").unwrap();
        assert_eq!(write.fields["newStr"], "new contents");
        let image = project(&turn, &json!({"type":"tool-call-started","callId":"image","toolCall":{"type":"generateImage","args":{"filePath":"asset.png"}}}), 9, "start", "end").unwrap();
        assert_eq!(image.fields["fileName"], "asset.png");
    }
}
