//! Projection of Claude's native agent task lifecycle.
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
fn ids(turn: &RootTurn, task: &str) -> (String, String, String, String) {
    let enc = crate::message_commands::encode_id_part;
    let node = format!(
        "node:provider:claudeAgent:native-item:{}",
        enc(&format!("task:{task}"))
    );
    let root = format!(
        "node:provider:claudeAgent:native-item:{}",
        enc(&format!("task:{task}:thread-root"))
    );
    let legacy = format!(
        "thread:provider:claudeAgent:native-thread:{}",
        enc(&format!("{}:{task}", turn.provider_thread_id))
    );
    let hash = format!("{:x}", Sha256::digest(legacy.as_bytes()));
    let child = format!("thread:subagent:{}", &hash[..16]);
    let item = format!(
        "turn-item:provider:claudeAgent:native-item:{}",
        enc(&format!("task:{task}:subagent"))
    );
    (node, root, child, item)
}
pub(crate) fn child_turn(source: &RootTurn, task: &str) -> RootTurn {
    let (_, root, child, _) = ids(source, task);
    let mut turn = source.clone();
    turn.thread_id = child;
    turn.root_node_id = root;
    turn.run_id = None;
    turn
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    bus: &EventBus,
    turn: &RootTurn,
    instance: &str,
    task: &str,
    description: &str,
    prompt: &str,
    ordinal: u64,
    at: &str,
) -> Result<(), String> {
    let (node, root, child, item) = ids(turn, task);
    let native = json!({"driver":"claudeAgent","nativeId":task,"strength":"strong"});
    bus.commit(|tx| {
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE subagent_id=?1)",[&node],|r|r.get(0))?;if exists{return Ok(((),vec![]))}
  let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&turn.thread_id],|r|r.get(0))?;let parent:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
  let title=if description.trim().is_empty(){"Subagent"}else{description};let mut thread=parent.clone();
  for (key,value) in [("id",json!(child)),("title",json!(title)),("activeProviderThreadId",Value::Null),("createdBy",json!("agent")),("creationSource",json!("provider")),("createdAt",json!(at)),("updatedAt",json!(at)),("archivedAt",Value::Null),("deletedAt",Value::Null),("settledAt",Value::Null),("forkedFrom",json!({"type":"node","nodeId":node})),("lineage",json!({"parentThreadId":turn.thread_id,"relationshipToParent":"subagent","rootThreadId":parent["lineage"]["rootThreadId"]}))]{thread[key]=value;}
  let n=json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"subagent","status":"running","countsForRun":false,"providerThreadId":null,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
  let child_root=json!({"id":root,"threadId":child,"runId":null,"parentNodeId":null,"rootNodeId":root,"kind":"root_turn","status":"running","countsForRun":false,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
  let task_value=json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"origin":"provider_native","createdBy":"agent","driver":"claudeAgent","providerInstanceId":instance,"providerThreadId":null,"childThreadId":child,"nativeTaskRef":native,"prompt":prompt,"title":title,"model":null,"result":null,"status":"running","startedAt":at,"completedAt":null,"updatedAt":at});
  let item_value=json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":null,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":ordinal,"status":"running","title":title,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"subagent","subagentId":node,"origin":"provider_native","driver":"claudeAgent","providerInstanceId":instance,"childThreadId":child,"prompt":prompt,"result":null});
  tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,payload_json) VALUES(?1,?2,?3,'claudeAgent',?4,?5,?6,NULL,?7,?7,?8)",params![child,parent["projectId"].as_str(),title,instance,parent["runtimeMode"].as_str(),parent["interactionMode"].as_str(),at,thread.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,?3,?4,?4,'subagent','running',NULL,?5,?6,?7)",params![node,turn.thread_id,turn.run_id,turn.root_node_id,turn.provider_turn_id,at,n.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,NULL,NULL,?1,'root_turn','running',NULL,NULL,?3,?4)",params![root,child,at,child_root.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,child_thread_id,origin,status,started_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,'claudeAgent','claudeAgent',?5,NULL,?6,'provider_native','running',?7,?7,?8)",params![node,turn.thread_id,turn.run_id,turn.root_node_id,instance,child,at,task_value.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,NULL,?5,?6,'subagent','running',?7,?8)",params![item,turn.thread_id,turn.run_id,node,turn.provider_turn_id,ordinal,at,item_value.to_string()])?;
  let events=vec![event(&child,"thread.created",thread,at),event(&turn.thread_id,"node.updated",n,at),event(&child,"node.updated",child_root,at),event(&turn.thread_id,"subagent.updated",task_value,at),event(&turn.thread_id,"turn-item.updated",item_value,at)];Ok(((),event_store::append(tx,&events)?))
 }).map_err(|e|e.to_string())
}
pub(crate) fn finish(
    bus: &EventBus,
    turn: &RootTurn,
    task: &str,
    status: &str,
    result: Option<&str>,
    at: &str,
) -> Result<(), String> {
    let (node, root, child, item) = ids(turn, task);
    let status = match status {
        "completed" => "completed",
        "failed" => "failed",
        "stopped" => "cancelled",
        _ => return Ok(()),
    };
    bus.commit(|tx| {let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id=?1",[&node],|r|r.get(0)).optional()?;let Some(raw)=raw else{return Ok(((),vec![]))};let mut task:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;if !matches!(task["status"].as_str(),Some("running"|"pending"|"waiting")){return Ok(((),vec![]))} task["status"]=json!(status);task["result"]=json!(result);task["completedAt"]=json!(at);task["updatedAt"]=json!(at);
  tx.execute("UPDATE orchestration_v2_projection_subagents SET status=?2,completed_at=?3,updated_at=?3,payload_json=?4 WHERE subagent_id=?1",params![node,status,at,task.to_string()])?;let mut events=vec![];
  for (id,thread) in [(&node,&turn.thread_id),(&root,&child)] {let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",[id],|r|r.get(0)).optional()?;if let Some(raw)=raw {let mut n:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;n["status"]=json!(status);n["completedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,payload_json=?4 WHERE node_id=?1",params![id,status,at,n.to_string()])?;events.push(event(thread,"node.updated",n,at));}}
  let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",[&item],|r|r.get(0))?;let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;value["status"]=json!(status);value["result"]=json!(result);value["completedAt"]=json!(at);value["updatedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_turn_items SET status=?2,updated_at=?3,payload_json=?4 WHERE turn_item_id=?1",params![item,status,at,value.to_string()])?;
  events.push(event(&turn.thread_id,"subagent.updated",task,at));events.push(event(&turn.thread_id,"turn-item.updated",value,at));Ok(((),event_store::append(tx,&events)?))
 }).map_err(|e|e.to_string())
}
