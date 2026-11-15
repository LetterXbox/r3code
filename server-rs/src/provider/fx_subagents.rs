//! Projection of FX native subagent calls and their child threads.
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
fn ids(turn: &RootTurn, instance: &str, task: &str) -> (String, String, String, String) {
    let enc = crate::message_commands::encode_id_part;
    let scoped = format!("provider-instance:{}:{task}", enc(instance));
    let node = format!("node:provider:fx:native-item:{}", enc(&scoped));
    let root = format!(
        "node:provider:fx:native-item:{}",
        enc(&format!(
            "provider-instance:{}:{task}:child-root",
            enc(instance)
        ))
    );
    let legacy = format!(
        "thread:provider:fx:provider-instance:{}:native-thread:{}",
        enc(instance),
        enc(&format!("{}:task:{task}", turn.native_thread_id))
    );
    let hash = format!("{:x}", Sha256::digest(legacy.as_bytes()));
    let child = format!("thread:subagent:{}", &hash[..16]);
    let item = format!("turn-item:provider:fx:native-item:{}", enc(&scoped));
    (node, root, child, item)
}
#[allow(clippy::too_many_arguments)]
fn child_message(
    tx: &rusqlite::Transaction<'_>,
    turn: &RootTurn,
    instance: &str,
    task: &str,
    child: &str,
    root: &str,
    role: &str,
    text: &str,
    at: &str,
    events: &mut Vec<Event>,
) -> rusqlite::Result<()> {
    let enc = crate::message_commands::encode_id_part;
    let native = if role == "user" {
        format!("{task}:prompt")
    } else {
        format!("{task}:message:result")
    };
    let scoped = format!("provider-instance:{}:{native}", enc(instance));
    let message_id = format!("message:provider:fx:native-item:{}", enc(&scoped));
    let item_id = format!("turn-item:provider:fx:native-item:{}", enc(&scoped));
    let ordinal = if role == "user" { 100 } else { 101 };
    let mut message = json!({"createdBy":"agent","creationSource":"provider","id":message_id,"threadId":child,"runId":null,"nodeId":root,"role":role,"text":text,"attachments":[],"streaming":false,"createdAt":at,"updatedAt":at});
    if role == "user" {
        message["senderThreadId"] = json!(turn.thread_id);
    }
    let mut item = json!({"id":item_id,"threadId":child,"runId":null,"nodeId":root,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":{"driver":"fx","nativeId":native,"strength":"weak"},"parentItemId":null,"ordinal":ordinal,"status":"completed","title":null,"startedAt":at,"completedAt":at,"updatedAt":at,"messageId":message_id,"text":text,"type":if role=="user"{"user_message"}else{"assistant_message"}});
    if role == "user" {
        item["createdBy"] = json!("agent");
        item["creationSource"] = json!("provider");
        item["senderThreadId"] = json!(turn.thread_id);
        item["inputIntent"] = json!("turn_start");
        item["attachments"] = json!([]);
    } else {
        item["streaming"] = json!(false);
    }
    tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,?2,NULL,?3,?4,0,?5,?5,?6) ON CONFLICT(message_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![message_id,child,root,role,at,message.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,?3,?4,?5,'completed',?6,?7) ON CONFLICT(turn_item_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item_id,child,root,ordinal,item["type"].as_str(),at,item.to_string()])?;
    events.push(event(child, "message.updated", message, at));
    events.push(event(child, "turn-item.updated", item, at));
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    bus: &EventBus,
    turn: &RootTurn,
    instance: &str,
    task: &str,
    description: &str,
    prompt: &str,
    model: Option<&str>,
    ordinal: u64,
    at: &str,
) -> Result<(), String> {
    let (node, root, child, item) = ids(turn, instance, task);
    let native = json!({"driver":"fx","nativeId":task,"strength":"strong"});
    bus.commit(|tx| {
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE subagent_id=?1)",[&node],|r|r.get(0))?;if exists{return Ok(((),vec![]))}
  let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&turn.thread_id],|r|r.get(0))?;let parent:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
  let title=if description.trim().is_empty(){prompt.trim()}else{description.trim()};let title=if title.is_empty(){"Subagent"}else{title};let mut thread=parent.clone();
  for (key,value) in [("id",json!(child)),("title",json!(title)),("activeProviderThreadId",Value::Null),("createdBy",json!("agent")),("creationSource",json!("provider")),("createdAt",json!(at)),("updatedAt",json!(at)),("archivedAt",Value::Null),("deletedAt",Value::Null),("settledAt",Value::Null),("forkedFrom",json!({"type":"node","nodeId":node})),("lineage",json!({"parentThreadId":turn.thread_id,"relationshipToParent":"subagent","rootThreadId":parent["lineage"]["rootThreadId"]}))]{thread[key]=value;}
  if let Some(model)=model.filter(|value|!value.trim().is_empty()){thread["modelSelection"]["model"]=json!(model.trim());}
  let n=json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"subagent","status":"running","countsForRun":false,"providerThreadId":null,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
  let child_root=json!({"id":root,"threadId":child,"runId":null,"parentNodeId":null,"rootNodeId":root,"kind":"root_turn","status":"running","countsForRun":false,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
  let task_value=json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"origin":"provider_native","createdBy":"agent","driver":"fx","providerInstanceId":instance,"providerThreadId":null,"childThreadId":child,"nativeTaskRef":native,"prompt":prompt,"title":if description.trim().is_empty(){None}else{Some(description)},"model":model.map(str::trim).filter(|value|!value.is_empty()),"result":null,"status":"running","startedAt":at,"completedAt":null,"updatedAt":at});
  let item_value=json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":null,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":ordinal,"status":"running","title":title,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"subagent","subagentId":node,"origin":"provider_native","driver":"fx","providerInstanceId":instance,"childThreadId":child,"prompt":prompt,"result":null});
  tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,payload_json) VALUES(?1,?2,?3,'fx',?4,?5,?6,NULL,?7,?7,?8)",params![child,parent["projectId"].as_str(),title,instance,parent["runtimeMode"].as_str(),parent["interactionMode"].as_str(),at,thread.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,?3,?4,?4,'subagent','running',NULL,?5,?6,?7)",params![node,turn.thread_id,turn.run_id,turn.root_node_id,turn.provider_turn_id,at,n.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,payload_json) VALUES(?1,?2,NULL,NULL,?1,'root_turn','running',NULL,NULL,?3,?4)",params![root,child,at,child_root.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,child_thread_id,origin,status,started_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,'fx','fx',?5,NULL,?6,'provider_native','running',?7,?7,?8)",params![node,turn.thread_id,turn.run_id,turn.root_node_id,instance,child,at,task_value.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,NULL,?5,?6,'subagent','running',?7,?8)",params![item,turn.thread_id,turn.run_id,node,turn.provider_turn_id,ordinal,at,item_value.to_string()])?;
  let mut events=vec![event(&child,"thread.created",thread,at),event(&turn.thread_id,"node.updated",n,at),event(&child,"node.updated",child_root,at),event(&turn.thread_id,"subagent.updated",task_value,at),event(&turn.thread_id,"turn-item.updated",item_value,at)];child_message(tx,turn,instance,task,&child,&root,"user",prompt,at,&mut events)?;Ok(((),event_store::append(tx,&events)?))
 }).map_err(|e|e.to_string())
}
pub(crate) fn finish(
    bus: &EventBus,
    turn: &RootTurn,
    instance: &str,
    task: &str,
    status: &str,
    result: Option<&str>,
    at: &str,
) -> Result<(), String> {
    let (node, root, child, item) = ids(turn, instance, task);
    let task_id = task;
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
  if let Some(text)=result.filter(|text|!text.is_empty()){child_message(tx,turn,instance,task_id,&child,&root,"assistant",text,at,&mut events)?;}
  events.push(event(&turn.thread_id,"subagent.updated",task,at));events.push(event(&turn.thread_id,"turn-item.updated",value,at));Ok(((),event_store::append(tx,&events)?))
 }).map_err(|e|e.to_string())
}

/// FX may truncate the JSON result mid-string; preserve its readable prefix.
pub(crate) fn outcome(text: &str) -> Option<(bool, Option<String>)> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if let Some(ok) = value["ok"].as_bool() {
            if value["result"].is_null() {
                return Some((ok, None));
            }
            if let Some(result) = value["result"].as_str() {
                return Some((ok, Some(result.to_owned())));
            }
        }
    }
    let re = regex::Regex::new(r#"^\{"ok":(true|false),"result":"((?:[^"\\]|\\.)*)"#).ok()?;
    let captures = re.captures(text)?;
    let complete = captures.get(0)?;
    let fragment = captures.get(2)?.as_str();
    let parse = |part: &str| serde_json::from_str::<String>(&format!("\"{part}\"")).ok();
    let decoded = parse(fragment).or_else(|| {
        let suffix = regex::Regex::new(r"\\u[0-9a-fA-F]{0,3}$").ok()?;
        parse(&suffix.replace(fragment, ""))
    });
    let cut = text.as_bytes().get(complete.end()) != Some(&b'"');
    Some((
        &captures[1] == "true",
        decoded.map(|value| if cut { format!("{value}…") } else { value }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_complete_and_truncated_fx_results() {
        assert_eq!(
            outcome(r#"{"ok":true,"result":"done"}"#),
            Some((true, Some("done".into())))
        );
        assert_eq!(
            outcome(r#"{"ok":false,"result":null}"#),
            Some((false, None))
        );
        assert_eq!(
            outcome(r#"{"ok":true,"result":"partial"#),
            Some((true, Some("partial…".into())))
        );
        assert!(outcome("plain output").is_none());
    }
}
