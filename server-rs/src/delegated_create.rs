//! Atomic creation of an app-owned delegated child and its first run.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    message_commands::{self, DispatchError, DispatchMessage},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub struct DelegatedRequest<'a> {
    pub command_id: &'a str,
    pub parent_thread_id: &'a str,
    pub parent_run_id: &'a str,
    pub parent_node_id: &'a str,
    pub task: &'a str,
    pub title: Option<&'a str>,
    pub model_selection: &'a Value,
    pub runtime_mode: &'a str,
    pub interaction_mode: &'a str,
    pub completion_wake: &'a str,
    pub driver: &'a str,
    pub cwd: &'a str,
    pub isolated_branch: Option<&'a str>,
    pub isolated_worktree: Option<&'a str>,
}

/// Caller must resolve provider and mode permissions before invoking this command.
pub fn dispatch(
    bus: &EventBus,
    cmd: DelegatedRequest<'_>,
    now: &str,
) -> Result<CommitResult, DispatchError> {
    bus.commit_with(|tx| {
    if let Some(receipt)=event_store::get_receipt(tx,cmd.command_id,"thread")? {
        if receipt.aggregate_id != cmd.parent_thread_id { return Err(DispatchError::CommandIdConflict); }
        return Ok((CommitResult{receipt,committed:false},vec![]));
    }
    let parent: Option<(String,String,String)> = tx.query_row("SELECT payload_json,runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[cmd.parent_thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let run: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status IN ('preparing','starting','running','waiting')",params![cmd.parent_thread_id,cmd.parent_run_id],|r|r.get(0)).optional()?;
    let node_valid: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND run_id=?2 AND node_id=?3)",params![cmd.parent_thread_id,cmd.parent_run_id,cmd.parent_node_id],|r|r.get(0))?;
    let (Some((parent,parent_runtime,parent_interaction)),Some(run))=(parent,run) else { return Err(DispatchError::Database(rusqlite::Error::InvalidQuery)); };
    let rank=|mode:&str|match mode {"approval-required"=>Some(0),"auto-accept-edits"=>Some(1),"auto"=>Some(2),"full-access"=>Some(3),_=>None};
    if rank(cmd.runtime_mode).is_none() || rank(parent_runtime.as_str()).is_none() || rank(cmd.runtime_mode)>rank(parent_runtime.as_str()) || (parent_interaction=="plan" && cmd.interaction_mode!="plan") { return Err(DispatchError::Database(rusqlite::Error::InvalidQuery)); }
    let parent:Value=serde_json::from_str(&parent).map_err(|_|rusqlite::Error::InvalidQuery)?;
    let run:Value=serde_json::from_str(&run).map_err(|_|rusqlite::Error::InvalidQuery)?;
    if !node_valid || run["rootNodeId"].as_str().is_none() || cmd.model_selection["instanceId"].as_str().is_none() {return Err(DispatchError::Database(rusqlite::Error::InvalidQuery));}
    let instance=cmd.model_selection["instanceId"].as_str().unwrap();
    let task_id=format!("node:delegated-task:{}",cmd.command_id);
    let child_id=format!("thread:delegated-task:{}",cmd.command_id);
    let message_id=format!("message:delegated-task:{}",cmd.command_id);
    let item_id=format!("turn-item:delegated-task:{}",cmd.command_id);
    let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE thread_id=?1",[cmd.parent_thread_id],|r|r.get(0))?;
    let title=cmd.title.map(str::to_owned).unwrap_or_else(||format!("{} subagent {}",parent["title"].as_str().unwrap_or("Thread"),count+1));
    let mut child=json!({
        "projectId": parent["projectId"], "branch": parent["branch"],
        "worktreePath": parent["worktreePath"], "titleRegeneration": null,
        "linkedPullRequest": null, "pinnedAt": null, "pinOrderKey": null,
        "autoSettleDisabledAt": null, "guestShare": null
    });
    if let Some(branch)=cmd.isolated_branch { child["branch"]=json!(branch); }
    if let Some(path)=cmd.isolated_worktree { child["worktreePath"]=json!(path); }
    if let Some(origin) = parent.get("linkOrigin") { child["linkOrigin"] = origin.clone(); }
    for (k,v) in [("id",json!(child_id)),("title",json!(title)),("providerInstanceId",json!(instance)),("modelSelection",cmd.model_selection.clone()),("runtimeMode",json!(cmd.runtime_mode)),("interactionMode",json!(cmd.interaction_mode)),("activeProviderThreadId",Value::Null),("createdBy",json!("agent")),("creationSource",json!("mcp")),("createdAt",json!(now)),("updatedAt",json!(now)),("archivedAt",Value::Null),("deletedAt",Value::Null),("lastVisitedAt",Value::Null),("settledAt",Value::Null),("settledOverride",Value::Null),("snoozedAt",Value::Null),("snoozedUntil",Value::Null),("pullRequests",json!([])),("forkedFrom",json!({"type":"node","nodeId":task_id})),("lineage",json!({"parentThreadId":cmd.parent_thread_id,"relationshipToParent":"subagent","rootThreadId":parent["lineage"]["rootThreadId"]}))] {child[k]=v;}
    let task=json!({"id":task_id,"threadId":cmd.parent_thread_id,"runId":cmd.parent_run_id,"parentNodeId":cmd.parent_node_id,"origin":"app_owned","createdBy":"agent","driver":cmd.driver,"providerInstanceId":instance,"providerThreadId":null,"childThreadId":child_id,"nativeTaskRef":null,"prompt":cmd.task,"title":cmd.title,"model":cmd.model_selection["model"],"completionWake":cmd.completion_wake,"status":"running","result":null,"startedAt":now,"completedAt":null,"updatedAt":now});
    let node=json!({"id":task_id,"threadId":cmd.parent_thread_id,"runId":cmd.parent_run_id,"parentNodeId":cmd.parent_node_id,"rootNodeId":run["rootNodeId"],"kind":"subagent","status":"running","countsForRun":false,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":now,"completedAt":null});
    let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[cmd.parent_thread_id],|r|r.get(0))?;
    let item=json!({"id":item_id,"threadId":cmd.parent_thread_id,"runId":cmd.parent_run_id,"nodeId":task_id,"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"running","title":title,"startedAt":now,"completedAt":null,"updatedAt":now,"type":"subagent","subagentId":task_id,"origin":"app_owned","driver":cmd.driver,"providerInstanceId":instance,"childThreadId":child_id,"prompt":cmd.task,"result":null});
    let event=|thread:&str,kind:&str,payload:Value| Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(cmd.command_id.into()),causation_event_id:None,correlation_id:Some(cmd.command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})};
    let mut stored=event_store::append(tx,&[event(&child_id,"thread.created",child.clone()),event(cmd.parent_thread_id,"node.updated",node.clone()),event(cmd.parent_thread_id,"subagent.updated",task.clone()),event(cmd.parent_thread_id,"turn-item.updated",item.clone())])?;
    let normalized_item = stored.iter().rev().find(|e| e.event.event_type == "turn-item.updated" && e.event.payload["id"].as_str() == Some(item_id.as_str())).map(|e| e.event.payload.clone()).unwrap_or_else(|| item.clone());
    let normalized_ordinal = normalized_item["ordinal"].as_i64().unwrap_or(ordinal);
    tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?7,?8)",params![child_id,parent["projectId"].as_str(),title,instance,cmd.runtime_mode,cmd.interaction_mode,now,child.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,started_at,payload_json) VALUES(?1,?2,?3,?4,?5,'subagent','running',?6,?7)",params![task_id,cmd.parent_thread_id,cmd.parent_run_id,cmd.parent_node_id,run["rootNodeId"].as_str(),now,node.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,child_thread_id,origin,status,started_at,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'app_owned','running',?7,?7,?8)",params![task_id,cmd.parent_thread_id,cmd.parent_run_id,cmd.parent_node_id,cmd.driver,child_id,now,task.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'subagent','running',?7,?8)",params![item_id,cmd.parent_thread_id,cmd.parent_run_id,task_id,run["providerThreadId"].as_str(),normalized_ordinal,now,normalized_item.to_string()])?;
    let (mut result, child_events)=message_commands::dispatch_message_tx_with_sender(tx,DispatchMessage{context:None,command_id:cmd.command_id,thread_id:&child_id,message_id:&message_id,text:cmd.task,attachments:&[],creation_source:"mcp",cwd:cmd.cwd,driver:cmd.driver},now,true,None,None,Some(cmd.parent_thread_id))?;
    if !result.committed {return Err(DispatchError::Database(rusqlite::Error::InvalidQuery));}
    stored.extend(child_events);
    let child_run=crate::message_commands::run_id(&child_id,1);
    let transfer_id=format!("context-transfer:{}",uuid::Uuid::new_v4());
    let transfer=json!({"id":transfer_id,"type":"subagent_spawn","sourceThreadId":cmd.parent_thread_id,"targetThreadId":child_id,"sourcePoint":{"threadId":cmd.parent_thread_id,"runId":cmd.parent_run_id,"turnItemId":item_id},"basePoint":null,"sourceProviderInstanceId":run["providerInstanceId"],"targetProviderInstanceId":instance,"targetRunId":child_run,"status":"consumed","resolution":null,"createdBy":"agent","error":null,"createdAt":now,"updatedAt":now,"consumedAt":now});
    stored.extend(event_store::append(tx,&[event(&child_id,"context-transfer.created",transfer.clone())])?);
    tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,target_provider,updated_at,payload_json) VALUES(?1,?2,?3,?4,'subagent_spawn','consumed',?5,?6,?7,?8)",params![transfer_id,cmd.parent_thread_id,child_id,child_run,run["providerInstanceId"].as_str(),instance,now,transfer.to_string()])?;
    result.receipt.aggregate_id=cmd.parent_thread_id.into(); result.receipt.command_type="delegated_task.request".into(); result.receipt.result_sequence=stored.last().unwrap().sequence; event_store::upsert_receipt(tx,&result.receipt)?;
    Ok((result,stored))
 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creation_is_atomic_and_replayed() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "parent-create",
                thread_id: "parent",
                project_id: "p",
                title: "Parent",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: Some("feature"),
                worktree_path: Some("/workspace/tree"),
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "start",
                thread_id: "parent",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        bus.commit(|tx| {
            tx.execute(r#"UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.guestShare',json('{"token":"private"}'),'$.pinnedAt','yesterday','$.pinOrderKey','a','$.titleRegeneration',json('{"status":"pending"}'),'$.linkedPullRequest',json('{"url":"x"}'),'$.historyOrigin','v1_import','$.unexpectedParentOnly','secret','$.delegatedFrom','other','$.contextHandoffId','old') WHERE thread_id='parent'"#, [])?;
            Ok(((), vec![]))
        }).unwrap();
        let run = "run:thread:parent:ordinal:1";
        let root = format!(
            "node:run:{}:root",
            crate::message_commands::encode_id_part(run)
        );
        let request = || DelegatedRequest {
            command_id: "delegate",
            parent_thread_id: "parent",
            parent_run_id: run,
            parent_node_id: &root,
            task: "inspect",
            title: None,
            model_selection: &selection,
            runtime_mode: "full-access",
            interaction_mode: "default",
            completion_wake: "always",
            driver: "codex",
            cwd: "/tmp",
            isolated_branch: None,
            isolated_worktree: None,
        };
        assert!(
            dispatch(&bus, request(), "2026-01-01T00:00:01Z")
                .unwrap()
                .committed
        );
        assert!(
            !dispatch(&bus, request(), "2026-01-01T00:00:01Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            let child: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='thread:delegated-task:delegate'", [], |r| r.get(0))?;
            let child: Value = serde_json::from_str(&child).unwrap();
            for field in ["guestShare", "pinnedAt", "pinOrderKey", "titleRegeneration", "linkedPullRequest", "historyOrigin", "unexpectedParentOnly", "delegatedFrom", "contextHandoffId"] { assert!(child[field].is_null(), "{field}"); }
            assert_eq!(child["lineage"]["parentThreadId"], "parent");
            assert_eq!(child["branch"], "feature");
            assert_eq!(child["worktreePath"], "/workspace/tree");
            assert_eq!(child["projectId"], "p");
            assert_eq!(child["createdBy"], "agent");
            assert_eq!(child["creationSource"], "mcp");
            let message: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='message:delegated-task:delegate'", [], |r| r.get(0))?;
            let event: String = tx.query_row("SELECT payload_json FROM orchestration_events WHERE event_type='message.updated' AND stream_id='thread:delegated-task:delegate'", [], |r| r.get(0))?;
            let message: Value = serde_json::from_str(&message).unwrap();
            assert_eq!(message, serde_json::from_str::<Value>(&event).unwrap());
            assert_eq!(message["createdBy"], "agent");
            assert_eq!(message["creationSource"], "mcp");
            assert_eq!(message["senderThreadId"], "parent");
            let item: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id='thread:delegated-task:delegate' AND type='user_message'", [], |r| r.get(0))?;
            let event: String = tx.query_row("SELECT payload_json FROM orchestration_events WHERE event_type='turn-item.updated' AND stream_id='thread:delegated-task:delegate' AND json_extract(payload_json,'$.type')='user_message'", [], |r| r.get(0))?;
            let item: Value = serde_json::from_str(&item).unwrap();
            assert_eq!(item, serde_json::from_str::<Value>(&event).unwrap());
            assert_eq!(item["createdBy"], "agent");
            assert_eq!(item["senderThreadId"], "parent");
            Ok(((), vec![]))
        }).unwrap();
        bus.commit(|tx| {let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE thread_id='parent'",[],|r|r.get(0))?; assert_eq!(count,1); let effects:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE thread_id='thread:delegated-task:delegate'",[],|r|r.get(0))?; assert_eq!(effects,1); Ok(((),vec![]))}).unwrap();
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='approval-required' WHERE thread_id='parent'",[])?;Ok(((),vec![]))}).unwrap();
        let mut narrowed = request();
        narrowed.command_id = "after-mode-change";
        assert!(dispatch(&bus, narrowed, "2026-01-01T00:00:02Z").is_err());
        bus.commit(|tx| {let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_subagents WHERE thread_id='parent'",[],|r|r.get(0))?; assert_eq!(count,1);Ok(((),vec![]))}).unwrap();
    }
}
