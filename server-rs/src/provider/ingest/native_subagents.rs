use super::{encoded, event, id};
use crate::{event_store::Event, provider::codex_events::RootTurn};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn project(
    tx: &Transaction<'_>,
    turn: &RootTurn,
    item: &Value,
    ordinal: u64,
    at: &str,
    events: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let kind = item["type"].as_str().unwrap_or("");
    let call = item["id"].as_str().unwrap_or("");
    let mut registrations = Vec::new();
    if kind == "collabAgentToolCall" && item["tool"] == "spawnAgent" {
        for child in item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            registrations.push((child, item["prompt"].as_str().unwrap_or(""), None));
        }
    } else if kind == "subAgentActivity" && item["kind"] == "started" {
        if let Some(child) = item["agentThreadId"].as_str() {
            registrations.push((child, "", item["agentPath"].as_str()));
        }
    }
    for (index, (native_child, prompt, title)) in registrations.iter().enumerate() {
        let native = format!("{call}:{native_child}");
        let node = id("node", &turn.driver, &native);
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND provider_thread_id=?2)", params![turn.thread_id,format!("provider-thread:provider:codex:native-thread:{}",encoded(native_child))], |r| r.get(0))?;
        if exists {
            // An activity notification can precede the spawn tool snapshot. Merge
            // metadata when it arrives rather than permanently losing the prompt.
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND provider_thread_id=?2", params![turn.thread_id,format!("provider-thread:provider:codex:native-thread:{}",encoded(native_child))], |r| r.get(0))?;
            let mut task: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let mut changed = false;
            if !prompt.is_empty() && task["prompt"].as_str().unwrap_or("").is_empty() {
                task["prompt"] = json!(prompt);
                changed = true;
            }
            if !item["model"].is_null() && task["model"] != item["model"] {
                task["model"] = item["model"].clone();
                changed = true;
            }
            if changed {
                task["updatedAt"] = json!(at);
                write_task(tx, turn, &task, ordinal + index as u64, at, events)?;
            }
            continue;
        }
        let parent: Value = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                [&turn.thread_id],
                |r| r.get::<_, String>(0),
            )
            .and_then(|v| serde_json::from_str(&v).map_err(|_| rusqlite::Error::InvalidQuery))?;
        let parent_provider: Value = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [&turn.provider_thread_id], |r| r.get::<_,String>(0)).and_then(|v| serde_json::from_str(&v).map_err(|_|rusqlite::Error::InvalidQuery))?;
        let instance = parent_provider["providerInstanceId"]
            .as_str()
            .or_else(|| parent["providerInstanceId"].as_str())
            .unwrap_or("codex");
        let legacy = format!(
            "thread:provider:codex:native-thread:{}",
            encoded(native_child)
        );
        let digest = format!("{:x}", Sha256::digest(legacy.as_bytes()));
        let child = format!("thread:subagent:{}", &digest[..16]);
        let pt = format!(
            "provider-thread:provider:codex:native-thread:{}",
            encoded(native_child)
        );
        let root = id("node", &turn.driver, &format!("{native}:thread-root"));
        let child_title = title.map(str::to_owned).unwrap_or_else(|| {
            format!(
                "{} subagent {}",
                parent["title"].as_str().unwrap_or("Thread"),
                index + 1
            )
        });
        let mut app = parent.clone();
        for (key, value) in [
            ("id", json!(child)),
            ("title", json!(child_title)),
            ("activeProviderThreadId", json!(pt)),
            ("createdBy", json!("agent")),
            ("creationSource", json!("provider")),
            ("createdAt", json!(at)),
            ("updatedAt", json!(at)),
            ("archivedAt", Value::Null),
            ("deletedAt", Value::Null),
            ("settledAt", Value::Null),
            ("forkedFrom", json!({"type":"node","nodeId":node})),
            (
                "lineage",
                json!({"parentThreadId":turn.thread_id,"relationshipToParent":"subagent","rootThreadId":parent["lineage"]["rootThreadId"]}),
            ),
        ] {
            app[key] = value;
        }
        let provider = json!({"id":pt,"driver":"codex","providerInstanceId":instance,"providerSessionId":parent_provider["providerSessionId"],"appThreadId":child,"ownerNodeId":null,"nativeThreadRef":{"driver":"codex","nativeId":native_child,"strength":"strong"},"nativeConversationHeadRef":null,"status":"idle","firstRunOrdinal":null,"lastRunOrdinal":null,"handoffIds":[],"forkedFrom":{"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id},"createdAt":at,"updatedAt":at});
        let task = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"origin":"provider_native","createdBy":"agent","driver":"codex","providerInstanceId":instance,"providerThreadId":pt,"childThreadId":child,"nativeTaskRef":{"driver":"codex","nativeId":native,"strength":"strong"},"prompt":prompt,"title":title,"model":item["model"],"status":"running","result":null,"startedAt":at,"completedAt":null,"updatedAt":at});
        let parent_node = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"subagent","status":"running","countsForRun":false,"providerThreadId":pt,"providerTurnId":turn.provider_turn_id,"nativeItemRef":{"driver":"codex","nativeId":call,"strength":"strong"},"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
        let child_node = json!({"id":root,"threadId":child,"runId":null,"parentNodeId":null,"rootNodeId":root,"kind":"root_turn","status":"running","countsForRun":false,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":task["nativeTaskRef"],"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
        tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,payload_json) VALUES(?1,?2,?3,'codex',?4,?5,?6,?7,?8,?8,?9)",params![child,parent["projectId"].as_str().unwrap_or(""),child_title,instance,parent["runtimeMode"].as_str().unwrap_or("full-access"),parent["interactionMode"].as_str().unwrap_or("default"),pt,at,app.to_string()])?;
        for (n, tid, run, parent_id, root_id, k, provider_id, turn_id, payload) in [
            (
                &node,
                &turn.thread_id,
                turn.run_id.as_deref(),
                Some(turn.root_node_id.as_str()),
                &turn.root_node_id,
                "subagent",
                &pt,
                Some(turn.provider_turn_id.as_str()),
                &parent_node,
            ),
            (
                &root,
                &child,
                None,
                None,
                &root,
                "root_turn",
                &pt,
                None,
                &child_node,
            ),
        ] {
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'running',?7,?8,?9,?10)",params![n,tid,run,parent_id,root_id,k,provider_id,turn_id,at,payload.to_string()])?;
        }
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES(?1,?2,'codex',?3,'idle',?4,?5)",params![pt,child,parent_provider["providerSessionId"].as_str(),at,provider.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,child_thread_id,origin,status,started_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,'codex','codex',?5,?6,?7,'provider_native','running',?8,?8,?9)",params![node,turn.thread_id,turn.run_id,turn.root_node_id,instance,pt,child,at,task.to_string()])?;
        events.push(event(&child, "thread.created", app, at));
        events.push(event(&turn.thread_id, "node.updated", parent_node, at));
        events.push(event(&child, "node.updated", child_node, at));
        events.push(event(&child, "provider-thread.updated", provider, at));
        write_task(tx, turn, &task, ordinal + index as u64, at, events)?;
    }
    let mut states: Vec<(&str, &str, Option<&str>)> = Vec::new();
    if let Some(map) = item["agentsStates"].as_object() {
        for (thread, state) in map {
            if let Some(status) = state["status"].as_str() {
                states.push((thread, status, state["message"].as_str()));
            }
        }
    }
    if kind == "subAgentActivity" {
        if let (Some(thread), Some(status)) =
            (item["agentThreadId"].as_str(), item["kind"].as_str())
        {
            if matches!(status, "completed" | "interrupted") {
                states.push((thread, status, None));
            }
        }
    }
    for (thread, state, result) in states {
        let state = match state {
            "pendingInit" => "pending",
            "running" => "running",
            "interrupted" => "interrupted",
            "completed" => "completed",
            "errored" | "notFound" => "failed",
            "shutdown" => "cancelled",
            _ => continue,
        };
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND provider_thread_id=?2",params![turn.thread_id,format!("provider-thread:provider:codex:native-thread:{}",encoded(thread))],|r|r.get(0)).optional()?;
        if let Some(raw) = raw {
            let mut task: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if !matches!(
                task["status"].as_str(),
                Some("running" | "pending" | "waiting")
            ) {
                continue;
            }
            task["status"] = json!(state);
            if let Some(result) = result {
                task["result"] = json!(result);
            }
            if !matches!(state, "running" | "pending" | "waiting") {
                task["completedAt"] = json!(at);
            }
            task["updatedAt"] = json!(at);
            write_task(tx, turn, &task, ordinal, at, events)?;
        }
    }
    Ok(())
}

fn write_task(
    tx: &Transaction<'_>,
    turn: &RootTurn,
    task: &Value,
    ordinal: u64,
    at: &str,
    events: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let native = task["nativeTaskRef"]["nativeId"].as_str().unwrap_or("");
    let item_id = id("turn-item", &turn.driver, native);
    let prior: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",
            [&item_id],
            |r| r.get(0),
        )
        .optional()?;
    let ordinal = prior
        .and_then(|p| serde_json::from_str::<Value>(&p).ok())
        .and_then(|p| p["ordinal"].as_u64())
        .unwrap_or(ordinal);
    let mut item = json!({"id":item_id,"threadId":turn.thread_id,"runId":task["runId"],"nodeId":task["id"],"providerThreadId":task["providerThreadId"],"providerTurnId":turn.provider_turn_id,"nativeItemRef":task["nativeTaskRef"],"parentItemId":null,"ordinal":ordinal,"status":task["status"],"title":task["title"],"startedAt":task["startedAt"],"completedAt":task["completedAt"],"updatedAt":at,"type":"subagent","subagentId":task["id"],"origin":"provider_native","driver":"codex","providerInstanceId":task["providerInstanceId"],"childThreadId":task["childThreadId"],"prompt":task["prompt"],"result":task["result"]});
    if let Some(progress) = task.get("progress") {
        item["progress"] = progress.clone();
    }
    tx.execute("UPDATE orchestration_v2_projection_subagents SET status=?2,completed_at=?3,updated_at=?4,payload_json=?5 WHERE subagent_id=?1",params![task["id"].as_str(),task["status"].as_str(),task["completedAt"].as_str(),at,task.to_string()])?;
    let raw: String = tx.query_row(
        "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",
        [task["id"].as_str()],
        |r| r.get(0),
    )?;
    let mut node: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if node["status"] != task["status"] || node["completedAt"] != task["completedAt"] {
        node["status"] = task["status"].clone();
        node["completedAt"] = task["completedAt"].clone();
        tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1", params![task["id"].as_str(),task["status"].as_str(),task["completedAt"].as_str(),node.to_string()])?;
        events.push(event(&turn.thread_id, "node.updated", node, at));
    }
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'subagent',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item_id,turn.thread_id,task["runId"].as_str(),task["id"].as_str(),task["providerThreadId"].as_str(),turn.provider_turn_id,ordinal,task["status"].as_str(),at,item.to_string()])?;
    events.push(event(&turn.thread_id, "subagent.updated", task.clone(), at));
    events.push(event(&turn.thread_id, "turn-item.updated", item, at));
    Ok(())
}
