//! Projection of OpenCode's native child sessions and foreground calls.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    provider::codex_events::RootTurn,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
pub(crate) fn call_node(call: &str) -> String {
    format!(
        "node:provider:opencode:native-item:{}",
        crate::message_commands::encode_id_part(call)
    )
}
fn ids(
    instance: &str,
    child: &str,
    call: &str,
) -> (String, String, String, String, String, String) {
    let e = crate::message_commands::encode_id_part;
    let legacy = format!(
        "thread:provider:opencode:provider-instance:{}:native-thread:{}",
        e(instance),
        e(child)
    );
    let thread =
        format!("thread:subagent:{:x}", Sha256::digest(legacy.as_bytes()))[..32].to_owned();
    let provider = format!(
        "provider-thread:provider:opencode:provider-instance:{}:native-thread:{}",
        e(instance),
        e(child)
    );
    let node = format!("node:provider:opencode:native-item:{}", e(call));
    let item = format!("turn-item:provider:opencode:native-item:{}", e(call));
    let native_turn = format!("{child}:turn:1");
    let root = format!(
        "node:provider:opencode:native-item:{}",
        e(&format!("{native_turn}:root"))
    );
    let pt = format!(
        "provider-turn:provider:opencode:native-turn:{}",
        e(&native_turn)
    );
    (thread, provider, node, item, root, pt)
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn attach(
    bus: &EventBus,
    parent: &RootTurn,
    instance: &str,
    provider_session: &str,
    call: &str,
    child: &str,
    input: &Value,
    ordinal: u64,
    at: &str,
) -> Result<RootTurn, String> {
    let (thread_id, provider_id, node_id, item_id, root_id, turn_id) = ids(instance, child, call);
    let native_turn = format!("{child}:turn:1");
    let child_turn = RootTurn {
        driver: "opencode".into(),
        native_thread_id: child.into(),
        native_turn_id: native_turn.clone(),
        provider_thread_id: provider_id.clone(),
        provider_turn_id: turn_id.clone(),
        thread_id: thread_id.clone(),
        run_id: None,
        run_attempt_id: String::new(),
        root_node_id: root_id.clone(),
        provider_turn_ordinal: 1,
        run_ordinal: 0,
        started_at: at.into(),
    };
    bus.commit(|tx| {
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE subagent_id=?1)",[&node_id],|r|r.get(0))?;
        if exists {return Ok(((),vec![]));}
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&parent.thread_id],|r|r.get(0))?;
        let original:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let title=input["description"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Subagent");let prompt=input["prompt"].as_str().unwrap_or("");
        let task_ref=json!({"driver":"opencode","nativeId":call,"strength":"strong"});
        let native_ref=json!({"driver":"opencode","nativeId":child,"strength":"strong"});
        let mut thread=original.clone();
        for (key,value) in [("id",json!(thread_id)),("title",json!(title)),("activeProviderThreadId",json!(provider_id)),("createdBy",json!("agent")),("creationSource",json!("provider")),("createdAt",json!(at)),("updatedAt",json!(at)),("archivedAt",Value::Null),("deletedAt",Value::Null),("settledAt",Value::Null),("forkedFrom",json!({"type":"node","nodeId":node_id})),("lineage",json!({"parentThreadId":parent.thread_id,"relationshipToParent":"subagent","rootThreadId":original["lineage"]["rootThreadId"]}))] {thread[key]=value;}
        let provider=json!({"id":provider_id,"driver":"opencode","providerInstanceId":instance,"providerSessionId":provider_session,"appThreadId":thread_id,"ownerNodeId":node_id,"nativeThreadRef":native_ref,"nativeConversationHeadRef":null,"status":"active","firstRunOrdinal":null,"lastRunOrdinal":null,"handoffIds":[],"forkedFrom":null,"createdAt":at,"updatedAt":at});
        let node=json!({"id":node_id,"threadId":parent.thread_id,"runId":parent.run_id,"parentNodeId":parent.root_node_id,"rootNodeId":parent.root_node_id,"kind":"subagent","status":"running","countsForRun":false,"providerThreadId":provider_id,"providerTurnId":parent.provider_turn_id,"nativeItemRef":task_ref,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
        let root=json!({"id":root_id,"threadId":thread_id,"runId":null,"parentNodeId":null,"rootNodeId":root_id,"kind":"root_turn","status":"running","countsForRun":false,"providerThreadId":provider_id,"providerTurnId":turn_id,"nativeItemRef":null,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
        let native_turn_ref=json!({"driver":"opencode","nativeId":native_turn,"strength":"weak"});
        let provider_turn=json!({"id":turn_id,"providerThreadId":provider_id,"nodeId":root_id,"runAttemptId":null,"nativeTurnRef":native_turn_ref,"ordinal":1,"status":"running","startedAt":at,"completedAt":null});
        let sub=json!({"id":node_id,"threadId":parent.thread_id,"runId":parent.run_id,"parentNodeId":parent.root_node_id,"origin":"provider_native","createdBy":"agent","driver":"opencode","providerInstanceId":instance,"providerThreadId":provider_id,"childThreadId":thread_id,"nativeTaskRef":task_ref,"prompt":prompt,"title":title,"model":null,"result":null,"status":"running","startedAt":at,"completedAt":null,"updatedAt":at});
        let item=json!({"id":item_id,"threadId":parent.thread_id,"runId":parent.run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":parent.provider_turn_id,"nativeItemRef":task_ref,"parentItemId":null,"ordinal":ordinal,"status":"running","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"subagent","subagentId":node_id,"origin":"provider_native","driver":"opencode","providerInstanceId":instance,"childThreadId":thread_id,"prompt":prompt,"result":null});
        tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,payload_json) VALUES(?1,?2,?3,'opencode',?4,?5,?6,?7,?8,?8,?9)",params![thread_id,original["projectId"].as_str(),title,instance,original["runtimeMode"].as_str(),original["interactionMode"].as_str(),provider_id,at,thread.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_session_id,status,updated_at,payload_json) VALUES(?1,?2,?3,'opencode',?4,'active',?5,?6)",params![provider_id,thread_id,node_id,provider_session,at,provider.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,?3,?4,?4,'subagent','running',?5,?6,?7,?8)",params![node_id,parent.thread_id,parent.run_id,parent.root_node_id,provider_id,parent.provider_turn_id,at,node.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,NULL,NULL,?1,'root_turn','running',?3,?4,?5,?6)",params![root_id,thread_id,provider_id,turn_id,at,root.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,payload_json) VALUES(?1,?2,?3,?4,NULL,1,'running',?5,?6)",params![turn_id,thread_id,provider_id,root_id,at,provider_turn.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,child_thread_id,origin,status,started_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,'opencode','opencode',?5,?6,?7,'provider_native','running',?8,?8,?9)",params![node_id,parent.thread_id,parent.run_id,parent.root_node_id,instance,provider_id,thread_id,at,sub.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'subagent','running',?8,?9)",params![item_id,parent.thread_id,parent.run_id,node_id,provider_id,parent.provider_turn_id,ordinal,at,item.to_string()])?;
        let mut events=vec![event(&thread_id,"thread.created",thread,at),event(&thread_id,"provider-thread.updated",provider,at),event(&parent.thread_id,"node.updated",node,at),event(&thread_id,"node.updated",root,at),event(&thread_id,"provider-turn.updated",provider_turn,at),event(&parent.thread_id,"subagent.updated",sub,at),event(&parent.thread_id,"turn-item.updated",item,at)];
        if !prompt.is_empty() {
            let enc=crate::message_commands::encode_id_part;
            let native=format!("{native_turn}:prompt");
            let message_id=format!("message:provider:opencode:native-item:{}",enc(&native));
            let item_id=format!("turn-item:provider:opencode:native-item:{}",enc(&native));
            let message=json!({"id":message_id,"threadId":thread_id,"runId":null,"nodeId":root_id,"role":"user","createdBy":"agent","creationSource":"provider","senderThreadId":parent.thread_id,"text":prompt,"attachments":[],"streaming":false,"createdAt":at,"updatedAt":at});
            let item=json!({"id":item_id,"threadId":thread_id,"runId":null,"nodeId":root_id,"providerThreadId":provider_id,"providerTurnId":turn_id,"nativeItemRef":{"driver":"opencode","nativeId":native,"strength":"weak"},"parentItemId":null,"ordinal":1,"status":"completed","title":null,"startedAt":at,"completedAt":at,"updatedAt":at,"type":"user_message","createdBy":"agent","creationSource":"provider","senderThreadId":parent.thread_id,"inputIntent":"turn_start","messageId":message_id,"text":prompt,"attachments":[]});
            tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,?2,NULL,?3,'user',0,?4,?4,?5)",params![message_id,thread_id,root_id,at,message.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,?3,?4,?5,1,'user_message','completed',?6,?7)",params![item_id,thread_id,root_id,provider_id,turn_id,at,item.to_string()])?;
            events.push(event(&thread_id,"message.updated",message,at));events.push(event(&thread_id,"turn-item.updated",item,at));
        }
        Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())?;
    Ok(child_turn)
}

pub(crate) fn finish_child(
    bus: &EventBus,
    child_turn: &RootTurn,
    status: &str,
    at: &str,
) -> Result<(), String> {
    let status = match status {
        "completed" => "completed",
        "interrupted" => "interrupted",
        _ => "failed",
    };
    bus.commit(|tx| {
        let mut events=Vec::new();
        for (id,select,update,kind) in [
            (child_turn.provider_turn_id.as_str(),"SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?1","UPDATE orchestration_v2_projection_provider_turns SET status=?2,completed_at=?3,payload_json=?4 WHERE provider_turn_id=?1","provider-turn.updated"),
            (child_turn.root_node_id.as_str(),"SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1","UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1","node.updated")
        ] {
            let raw:Option<String>=tx.query_row(select,[id],|r|r.get(0)).optional()?;
            if let Some(raw)=raw {let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;if value["status"]!="running" {continue;}value["status"]=json!(status);value["completedAt"]=json!(at);tx.execute(update,params![id,status,at,value.to_string()])?;events.push(event(&child_turn.thread_id,kind,value,at));}
        }
        if status != "completed" {
            let open={
                let mut stmt=tx.prepare("SELECT turn_item_id,payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND provider_turn_id=?2 AND status IN ('running','waiting')")?;
                let rows=stmt.query_map(params![child_turn.thread_id,child_turn.provider_turn_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?;
                rows.collect::<Result<Vec<_>,_>>()?
            };
            for (id,raw) in open {
                let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                value["status"]=json!(status);value["completedAt"]=json!(at);value["updatedAt"]=json!(at);
                tx.execute("UPDATE orchestration_v2_projection_turn_items SET status=?2,updated_at=?3,payload_json=?4 WHERE turn_item_id=?1",params![id,status,at,value.to_string()])?;
                events.push(event(&child_turn.thread_id,"turn-item.updated",value,at));
            }
        }
        Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish_call(
    bus: &EventBus,
    parent: &RootTurn,
    instance: &str,
    child: &str,
    call: &str,
    status: &str,
    result: Option<&str>,
    at: &str,
) -> Result<(), String> {
    let (_, _, node, item, _, _) = ids(instance, child, call);
    let status = match status {
        "completed" => "completed",
        "interrupted" => "interrupted",
        _ => "failed",
    };
    bus.commit(|tx| {
        let mut events=Vec::new();
        for (id,select,update,kind) in [
            (node.as_str(),"SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1","UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1","node.updated"),
            (node.as_str(),"SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id=?1","UPDATE orchestration_v2_projection_subagents SET status=?2,updated_at=?3,payload_json=?4 WHERE subagent_id=?1","subagent.updated"),
            (item.as_str(),"SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1","UPDATE orchestration_v2_projection_turn_items SET status=?2,updated_at=?3,payload_json=?4 WHERE turn_item_id=?1","turn-item.updated")
        ] {
            let raw:Option<String>=tx.query_row(select,[id],|r|r.get(0)).optional()?;
            if let Some(raw)=raw {let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;if value["status"]!="running" {continue;}value["status"]=json!(status);value["completedAt"]=json!(at);if kind!="node.updated" {value["updatedAt"]=json!(at);value["result"]=json!(result);}tx.execute(update,params![id,status,at,value.to_string()])?;events.push(event(&parent.thread_id,kind,value,at));}
        }
        Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())
}
