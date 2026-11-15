//! Reconcile durable projections whose provider process was lost at startup.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn rows(tx: &rusqlite::Transaction<'_>, sql: &str, thread: &str) -> rusqlite::Result<Vec<Value>> {
    let mut statement = tx.prepare(sql)?;
    let values = statement
        .query_map([thread], |r| r.get::<_, String>(0))?
        .map(|raw| serde_json::from_str(&raw?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect();
    values
}
fn event(thread: &str, kind: &str, payload: Value, command: &str, now: &str) -> Event {
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        aggregate_kind: "thread".into(),
        stream_id: thread.into(),
        event_type: kind.into(),
        occurred_at: now.into(),
        command_id: Some(command.into()),
        causation_event_id: None,
        correlation_id: Some(command.into()),
        actor_kind: "system".into(),
        payload,
        metadata: json!({}),
    }
}

/// Recover the ordinary interrupted-run and held-queue cases. More elaborate
/// restart continuations and background-task recovery still require implementation.
pub fn recover(bus: &EventBus, now: &str) -> Result<(), BusError> {
    recover_with_settings(bus, now, &json!({"continueThreadsAfterServerUpdate":true}))
}
pub fn recover_with_settings(bus: &EventBus, now: &str, settings: &Value) -> Result<(), BusError> {
    bus.commit(|tx| {
        let mut stmt=tx.prepare("SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs WHERE status IN ('queued','preparing','starting','running','waiting') UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_sessions WHERE thread_id IS NOT NULL AND (status NOT IN ('stopped','error') OR (status='error' AND COALESCE(json_array_length(json_extract(payload_json,'$.extensionStatuses')),0)>0)) UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending' UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_subagents WHERE origin='provider_native' AND status IN ('pending','running','waiting') UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_nodes WHERE kind='root_turn' AND run_id IS NULL AND status IN ('pending','running','waiting') UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_threads WHERE COALESCE(json_array_length(json_extract(payload_json,'$.pendingBackgroundTasks')),0)>0 UNION SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type IN ('command_execution','dynamic_tool','subagent') AND status IN ('pending','running','waiting')")?;
        let threads=stmt.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
        let mut events=Vec::new();
        for thread in threads {
            let command=format!("command:runtime-reconcile:startup:{thread}:{now}");
            let continuation=crate::restart_continuation::select(tx,&thread,settings)?;
            let mut note_stmt=tx.prepare("SELECT p.provider_thread_id,(SELECT r.run_id FROM orchestration_v2_projection_runs r WHERE r.provider_thread_id=p.provider_thread_id AND r.status NOT IN ('queued','rolled_back') AND ((json_type(r.payload_json,'$.startedAt') IS NOT NULL AND json_type(r.payload_json,'$.startedAt')!='null') OR json_type(r.payload_json,'$.restartContinuationOfRunId') IS NOT NULL) ORDER BY (r.completed_at IS NULL) DESC,r.completed_at DESC,r.ordinal DESC LIMIT 1) FROM orchestration_v2_projection_provider_threads p WHERE p.thread_id=?1")?;
            let note_runs=note_stmt.query_map([&thread],|r|r.get::<_,Option<String>>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(note_stmt);
            for source in note_runs.into_iter().flatten() {
                let work=crate::restart_continuation::cancelled_work(tx,&thread,&source)?;
                if !work.is_empty() {let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1",[&source],|r|r.get(0))?;let mut run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;let mut merged=run["restartCancelledBackgroundWork"].as_array().cloned().unwrap_or_default();let before=merged.len();for entry in work{if !merged.iter().any(|old|old["id"]==entry["id"]){merged.push(entry)}}if merged.len()!=before{run["restartCancelledBackgroundWork"]=json!(merged);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![source,run.to_string()])?;events.push(event(&thread,"run.updated",run,&command,now));}}
            }
            if let Some(source)=continuation {
                crate::outbox::enqueue(tx,&crate::outbox::Effect{id:format!("effect:restart-continuation:{source}"),command_id:command.clone(),thread_id:thread.clone(),request:json!({"type":"provider-runtime.continue","sourceRunId":source}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
            }
            let runs=rows(tx,"SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting') ORDER BY ordinal",&thread)?;
            let mut cancelled=Vec::<(String,bool)>::new();
            for mut run in runs {
                let id=run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                let status=run["status"].as_str().unwrap_or("").to_owned();
                if status=="waiting" && tx.query_row::<bool,_,_>("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_type='checkpoint.capture' AND status IN ('pending','running') AND json_extract(payload_json,'$.runId')=?1)",[&id],|r|r.get(0))? { continue; }

                let unstarted=status=="starting" && run["startedAt"].is_null() && !tx.query_row::<bool,_,_>("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=json_extract(?1,'$.activeAttemptId'))",[run.to_string()],|r|r.get(0))? && !tx.query_row::<bool,_,_>("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests q JOIN orchestration_v2_projection_nodes n ON n.node_id=q.node_id WHERE n.run_id=?1 AND q.status='pending')",[&id],|r|r.get(0))?;
                let ordinary:bool=tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.createdBy')='user' AND json_type(payload_json,'$.scheduledTaskId') IS NULL AND json_type(payload_json,'$.notification') IS NULL AND json_type(payload_json,'$.delegatedCompletion') IS NULL,0) FROM orchestration_v2_projection_messages WHERE message_id=json_extract(?1,'$.userMessageId')",[run.to_string()],|r|r.get(0)).optional()?.unwrap_or(false);
                let buffered:bool=tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.createdBy')='agent' AND json_extract(payload_json,'$.creationSource')='provider' AND json_type(payload_json,'$.notification') IS NOT NULL AND json_type(payload_json,'$.delegatedCompletion') IS NULL,0) FROM orchestration_v2_projection_messages WHERE message_id=json_extract(?1,'$.userMessageId')",[run.to_string()],|r|r.get(0)).optional()?.unwrap_or(false);
                if (status=="queued" && !buffered) || (unstarted && ordinary) {
                    if status!="queued" || run["queueHeld"]!=true {run["status"]=json!("queued");run["queueHeld"]=json!(true);tx.execute("UPDATE orchestration_v2_projection_runs SET status='queued',payload_json=?2 WHERE run_id=?1",params![id,run.to_string()])?;events.push(event(&thread,"run.updated",run,&command,now));}
                } else {
                    run["status"]=json!("cancelled");run["queuePosition"]=Value::Null;run["completedAt"]=json!(now);
                    tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![id,now,run.to_string()])?;
                    events.push(event(&thread,"run.updated",run,&command,now));cancelled.push((id,status!="queued"));
                }
            }
            for (id, show_notice) in cancelled {
                for (sql, update, kind, field) in [
                    ("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 AND status IN ('pending','running')", "UPDATE orchestration_v2_projection_run_attempts SET status='cancelled',payload_json=?2 WHERE attempt_id=?1", "run-attempt.updated", "id"),
                    ("SELECT n.payload_json FROM orchestration_v2_projection_nodes n WHERE n.thread_id=?1 AND n.status IN ('pending','running','waiting') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents a WHERE a.subagent_id=n.node_id AND a.origin='app_owned') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests q WHERE q.node_id=n.node_id AND q.status='pending' AND (json_extract(q.payload_json,'$.responseCapability.type')='message' OR (q.kind='user_input' AND json_extract(q.payload_json,'$.responseCapability.type')='live' AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.node_id=n.node_id AND i.type='user_input_request' AND json_extract(i.payload_json,'$.requestId')=q.runtime_request_id AND json_array_length(json_extract(i.payload_json,'$.questions'))>0 AND NOT EXISTS (SELECT 1 FROM json_each(i.payload_json,'$.questions') question WHERE trim(COALESCE(json_extract(question.value,'$.question'),''),char(9)||char(10)||char(11)||char(12)||char(13)||' '||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))= '') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads question_thread WHERE question_thread.thread_id=i.thread_id AND json_extract(question_thread.payload_json,'$.lineage.relationshipToParent')='subagent' AND json_extract(question_thread.payload_json,'$.creationSource')='provider')))))", "UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?3,payload_json=?2 WHERE node_id=?1", "node.updated", "id"),
                    ("SELECT p.payload_json FROM orchestration_v2_projection_provider_turns p JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=p.run_attempt_id WHERE p.thread_id=?1 AND p.status IN ('pending','running')", "UPDATE orchestration_v2_projection_provider_turns SET status='cancelled',completed_at=?3,payload_json=?2 WHERE provider_turn_id=?1", "provider-turn.updated", "id"),
                ] {
                    for mut value in rows(tx,sql,&thread)? { if kind=="provider-turn.updated" {let run:Option<String>=tx.query_row("SELECT run_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1",[value["runAttemptId"].as_str()],|r|r.get(0)).optional()?; if run.as_deref()!=Some(&id){continue} } else if value["runId"]!=id {continue}
                        value["status"]=json!("cancelled");value["completedAt"]=json!(now);let key=value[field].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                        if kind=="run-attempt.updated" {tx.execute(update,params![key,value.to_string()])?;}else{tx.execute(update,params![key,value.to_string(),now])?;}
                        events.push(event(&thread,kind,value,&command,now));
                    }
                }
                for mut delegation in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' AND status IN ('pending','running','waiting') AND json_extract(payload_json,'$.completionWake')='settled_only'",&thread)? {
                    if delegation["runId"]!=id {continue;}
                    let agent_id=delegation["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();delegation["completionWake"]=json!("always");delegation["updatedAt"]=json!(now);
                    tx.execute("UPDATE orchestration_v2_projection_subagents SET updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![agent_id,now,delegation.to_string()])?;events.push(event(&thread,"subagent.updated",delegation,&command,now));
                }
                let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1",[&id],|r|r.get(0))?;
                let run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE run_id=?1 AND streaming=1")?;
                let messages=stmt.query_map([&id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
                for raw in messages {let mut message:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;let mid=message["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();message["streaming"]=json!(false);message["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_messages SET streaming=0,updated_at=?2,payload_json=?3 WHERE message_id=?1",params![mid,now,message.to_string()])?;events.push(event(&thread,"message.updated",message,&command,now));}
                if show_notice {
                let mut stmt=tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i WHERE i.run_id=?1 AND i.status IN ('pending','running','waiting') AND i.type!='link_request' AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents a WHERE a.subagent_id=json_extract(i.payload_json,'$.subagentId') AND a.origin='app_owned') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests q WHERE q.node_id=i.node_id AND q.status='pending' AND (json_extract(q.payload_json,'$.responseCapability.type')='message' OR (q.kind='user_input' AND json_extract(q.payload_json,'$.responseCapability.type')='live' AND i.type='user_input_request' AND json_array_length(json_extract(i.payload_json,'$.questions'))>0 AND NOT EXISTS (SELECT 1 FROM json_each(i.payload_json,'$.questions') question WHERE trim(COALESCE(json_extract(question.value,'$.question'),''),char(9)||char(10)||char(11)||char(12)||char(13)||' '||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))= '') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads question_thread WHERE question_thread.thread_id=i.thread_id AND json_extract(question_thread.payload_json,'$.lineage.relationshipToParent')='subagent' AND json_extract(question_thread.payload_json,'$.creationSource')='provider'))))")?;
                let items=stmt.query_map([&id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
                for raw in items {let mut item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;let iid=item["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();item["status"]=json!("cancelled");item["completedAt"]=json!(now);item["updatedAt"]=json!(now);if item.get("streaming").is_some(){item["streaming"]=json!(false);}
                if item["type"]=="secret_request" && item["secretStatus"]=="pending" {item["secretStatus"]=json!("cancelled");}tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![iid,now,item.to_string()])?;events.push(event(&thread,"turn-item.updated",item,&command,now));}
                let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[&thread],|r|r.get(0))?;
                let item_id=crate::interrupt_commands::signal(&id,"server-recovery");
                let item=json!({"id":item_id,"threadId":thread,"runId":id,"nodeId":run["rootNodeId"],"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Server restarted","startedAt":now,"completedAt":now,"updatedAt":now,"type":"system_notice","message":"Cancelled because the server restarted before the provider work completed."});
                tx.execute("INSERT OR IGNORE INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'system_notice','completed',?7,?8)",params![item_id,thread,id,item["nodeId"].as_str(),item["providerThreadId"].as_str(),ordinal,now,item.to_string()])?;events.push(event(&thread,"turn-item.updated",item,&command,now));
                }
            }
            for mut item in rows(tx,"SELECT i.payload_json FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=?1 AND i.type IN ('command_execution','dynamic_tool','subagent') AND i.status IN ('pending','running','waiting') AND NOT (i.type='subagent' AND (COALESCE(json_extract(i.payload_json,'$.origin'),'')='app_owned' OR EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents a WHERE a.subagent_id=json_extract(i.payload_json,'$.subagentId') AND a.origin='app_owned'))) AND (i.run_id IS NULL OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id=i.run_id AND r.status IN ('queued','preparing','starting','running','waiting') AND NOT (r.status='waiting' AND EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.effect_type='checkpoint.capture' AND e.status IN ('pending','running') AND json_extract(e.payload_json,'$.runId')=r.run_id))))",&thread)? {
                let id=item["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();item["status"]=json!("cancelled");item["completedAt"]=json!(now);item["updatedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='cancelled',updated_at=?2,payload_json=?3 WHERE turn_item_id=?1",params![id,now,item.to_string()])?;events.push(event(&thread,"turn-item.updated",item.clone(),&command,now));
                if let Some(node_id)=item["nodeId"].as_str(){let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1 AND status IN ('pending','running','waiting')",[node_id],|r|r.get(0)).optional()?;if let Some(raw)=raw{let mut node:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;node["status"]=json!("cancelled");node["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![node_id,now,node.to_string()])?;events.push(event(&thread,"node.updated",node,&command,now));}}
            }
            for mut agent in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='provider_native' AND status IN ('pending','running','waiting')",&thread)? {
                let id=agent["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                agent["status"]=json!("cancelled");agent["completedAt"]=json!(now);agent["updatedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_subagents SET status='cancelled',completed_at=?2,updated_at=?2,payload_json=?3 WHERE subagent_id=?1",params![id,now,agent.to_string()])?;
                events.push(event(&thread,"subagent.updated",agent,&command,now));
                let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1 AND status IN ('pending','running','waiting')",[&id],|r|r.get(0)).optional()?;
                if let Some(raw)=raw {let mut node:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;node["status"]=json!("cancelled");node["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![id,now,node.to_string()])?;events.push(event(&thread,"node.updated",node,&command,now));}
            }
            for mut node in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND kind='root_turn' AND run_id IS NULL AND status IN ('pending','running','waiting')",&thread)? {
                let id=node["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();node["status"]=json!("cancelled");node["completedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![id,now,node.to_string()])?;events.push(event(&thread,"node.updated",node,&command,now));
            }
            for mut provider in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND (status='active' OR COALESCE(json_array_length(json_extract(payload_json,'$.pendingBackgroundTasks')),0)>0)",&thread)? {let id=provider["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();provider["status"]=json!("idle");provider["pendingBackgroundTasks"]=json!([]);provider["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='idle',updated_at=?2,payload_json=?3 WHERE provider_thread_id=?1",params![id,now,provider.to_string()])?;events.push(event(&thread,"provider-thread.updated",provider,&command,now));}
            for mut request in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending'",&thread)? {
                if request["responseCapability"]["type"]=="message" {continue}
                let id=request["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
                let resumable = request["kind"]=="user_input" && request["responseCapability"]["type"]=="live" && tx.query_row::<bool,_,_>("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.thread_id=?1 AND i.node_id=?2 AND i.type='user_input_request' AND json_extract(i.payload_json,'$.requestId')=?3 AND json_array_length(json_extract(i.payload_json,'$.questions'))>0 AND NOT EXISTS (SELECT 1 FROM json_each(i.payload_json,'$.questions') question WHERE trim(COALESCE(json_extract(question.value,'$.question'),''),char(9)||char(10)||char(11)||char(12)||char(13)||' '||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))= '') AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads question_thread WHERE question_thread.thread_id=i.thread_id AND json_extract(question_thread.payload_json,'$.lineage.relationshipToParent')='subagent' AND json_extract(question_thread.payload_json,'$.creationSource')='provider'))",params![thread,request["nodeId"].as_str(),id],|r|r.get(0))?;
                if resumable {request["responseCapability"]=json!({"type":"message"});tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET payload_json=?2 WHERE runtime_request_id=?1",params![id,request.to_string()])?;events.push(event(&thread,"runtime-request.updated",request,&command,now));continue;}
                request["status"]=json!("expired");request["resolvedAt"]=json!(now);request["responseCapability"]=json!({"type":"not_resumable","reason":"The server restarted before this runtime request was resolved."});
                tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET status='expired',resolved_at=?2,payload_json=?3 WHERE runtime_request_id=?1",params![id,now,request.to_string()])?;events.push(event(&thread,"runtime-request.updated",request,&command,now));
            }
            for mut session in rows(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE thread_id=?1 AND (status NOT IN ('stopped','error') OR (status='error' AND COALESCE(json_array_length(json_extract(payload_json,'$.extensionStatuses')),0)>0))",&thread)? {let id=session["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();let failed=session["status"]=="error";if !failed {session["status"]=json!("stopped");session["lastError"]=Value::Null;}session["updatedAt"]=json!(now);if session.get("extensionStatuses").is_some(){session["extensionStatuses"]=json!([]);}tx.execute("UPDATE orchestration_v2_projection_provider_sessions SET status=?4,updated_at=?2,payload_json=?3 WHERE provider_session_id=?1",params![id,now,session.to_string(),if failed {"error"}else{"stopped"}])?;events.push(event(&thread,"provider-session.updated",session,&command,now));}
        }
        Ok(((),event_store::append(tx,&events)?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn interrupted_run_is_cancelled_and_queued_work_is_held_on_restart() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"test"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let send = |command_id, message_id| DispatchMessage {
            context: None,
            command_id,
            thread_id: "t",
            message_id,
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01Z").unwrap();
        dispatch_first_message(&bus, send("second", "m2"), "2026-01-01T00:00:02Z").unwrap();
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running','$.startedAt','2026-01-01T00:00:01Z') WHERE ordinal=1",[])?;Ok(((),vec![]))}).unwrap();
        let run = bus
            .with_autocommit(|db| {
                db.query_row(
                    "SELECT payload_json FROM orchestration_v2_projection_runs WHERE ordinal=1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap()
            })
            .unwrap();
        let run: Value = serde_json::from_str(&run).unwrap();
        let turn = crate::provider::codex_events::RootTurn {
            driver: "claudeAgent".into(),
            native_thread_id: "native".into(),
            native_turn_id: "turn".into(),
            provider_thread_id: run["providerThreadId"].as_str().unwrap().into(),
            provider_turn_id: "provider-turn:test".into(),
            thread_id: "t".into(),
            run_id: run["id"].as_str().map(str::to_owned),
            run_attempt_id: run["activeAttemptId"].as_str().unwrap().into(),
            root_node_id: run["rootNodeId"].as_str().unwrap().into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:01Z".into(),
        };
        crate::provider::claude_subagents::start(
            &bus,
            &turn,
            "claudeAgent",
            "delegated",
            "Delegated",
            "review",
            1,
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        bus.with_autocommit(|db|db.execute("UPDATE orchestration_v2_projection_subagents SET origin='app_owned',payload_json=json_set(payload_json,'$.origin','app_owned','$.completionWake','settled_only') WHERE json_extract(payload_json,'$.nativeTaskRef.nativeId')='delegated'",[]).unwrap()).unwrap();
        recover(&bus, "2026-01-01T00:00:03Z").unwrap();
        bus.commit(|tx|{let (status,held):(String,bool)=tx.query_row("SELECT (SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t' AND ordinal=1),json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE thread_id='t' AND ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"cancelled");assert!(held);let attempt:String=tx.query_row("SELECT status FROM orchestration_v2_projection_run_attempts WHERE run_id='run:thread:t:ordinal:1'",[],|r|r.get(0))?;assert_eq!(attempt,"cancelled");Ok(((),vec![]))}).unwrap();
        bus.with_autocommit(|db|{let (status,wake):(String,String)=db.query_row("SELECT status,json_extract(payload_json,'$.completionWake') FROM orchestration_v2_projection_subagents WHERE origin='app_owned'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(status,"running");assert_eq!(wake,"always");}).unwrap();
        recover(&bus, "2026-01-01T00:00:04Z").unwrap();
    }
    #[test]
    fn replayable_checkpoint_and_unstarted_user_turn_survive_restart() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"test"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        for (command, message) in [("first", "m1"), ("second", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: command,
                    thread_id: "t",
                    message_id: message,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:01Z",
            )
            .unwrap();
        }
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='waiting',payload_json=json_set(payload_json,'$.status','waiting','$.startedAt','2026-01-01T00:00:01Z') WHERE ordinal=1",[])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',payload_json=json_set(payload_json,'$.status','starting','$.startedAt',NULL) WHERE ordinal=2",[])?;
            tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='idle',payload_json=json_set(payload_json,'$.status','idle','$.pendingBackgroundTasks',json('[{\"id\":\"task\"}]')) WHERE thread_id='t'",[])?;
            let run:String=tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0))?;
            let at="2026-01-01T00:00:02Z";
            let failed=json!({"id":"failed-session","status":"error","lastError":"provider error","extensionStatuses":[{"key":"watch","text":"Watching"}]});
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('failed-session','t','codex','error',?1,?2)",params![at,failed.to_string()])?;
            crate::outbox::enqueue(tx,&crate::outbox::Effect{id:"checkpoint".into(),command_id:"checkpoint".into(),thread_id:"t".into(),request:json!({"type":"checkpoint.capture","runId":run}),status:"pending".into(),attempt_count:0,available_at:at.into(),lease_owner:None,created_at:at.into(),updated_at:at.into(),completed_at:None,last_error:None})?;
            Ok(((),vec![]))
        }).unwrap();
        let run = bus
            .with_autocommit(|db| {
                db.query_row(
                    "SELECT payload_json FROM orchestration_v2_projection_runs WHERE ordinal=1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap()
            })
            .unwrap();
        let run: Value = serde_json::from_str(&run).unwrap();
        let turn = crate::provider::codex_events::RootTurn {
            driver: "claudeAgent".into(),
            native_thread_id: "native".into(),
            native_turn_id: "turn".into(),
            provider_thread_id: run["providerThreadId"].as_str().unwrap().into(),
            provider_turn_id: "provider-turn:test".into(),
            thread_id: "t".into(),
            run_id: run["id"].as_str().map(str::to_owned),
            run_attempt_id: run["activeAttemptId"].as_str().unwrap().into(),
            root_node_id: run["rootNodeId"].as_str().unwrap().into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:01Z".into(),
        };
        crate::provider::claude_subagents::start(
            &bus,
            &turn,
            "claudeAgent",
            "native-task",
            "Native task",
            "review",
            1,
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        crate::provider::claude_subagents::start(
            &bus,
            &turn,
            "claudeAgent",
            "delegated-task",
            "Delegated task",
            "review",
            2,
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        bus.with_autocommit(|db|db.execute("UPDATE orchestration_v2_projection_subagents SET origin='app_owned',payload_json=json_set(payload_json,'$.origin','app_owned') WHERE json_extract(payload_json,'$.nativeTaskRef.nativeId')='delegated-task'",[]).unwrap()).unwrap();
        recover_with_settings(
            &bus,
            "2026-01-01T00:00:03Z",
            &json!({"continueThreadsAfterServerUpdate":false}),
        )
        .unwrap();
        bus.with_autocommit(|db| {
            let waiting:String=db.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0)).unwrap();
            let (held,status):(bool,String)=db.query_row("SELECT json_extract(payload_json,'$.queueHeld'),status FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(waiting,"waiting");assert_eq!(status,"queued");assert!(held);
            let note:String=db.query_row("SELECT json_extract(payload_json,'$.restartCancelledBackgroundWork') FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0)).unwrap();assert!(note.contains("native-task"));
            let (error,extensions,last_error):(String,i64,String)=db.query_row("SELECT status,json_array_length(json_extract(payload_json,'$.extensionStatuses')),json_extract(payload_json,'$.lastError') FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id='failed-session'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();assert_eq!(error,"error");assert_eq!(extensions,0);assert_eq!(last_error,"provider error");
            let continuations:i64=db.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-runtime.continue'",[],|r|r.get(0)).unwrap();assert_eq!(continuations,0);
            let roster:i64=db.query_row("SELECT json_array_length(json_extract(payload_json,'$.pendingBackgroundTasks')) FROM orchestration_v2_projection_provider_threads WHERE thread_id='t' LIMIT 1",[],|r|r.get(0)).unwrap();assert_eq!(roster,0);
            let native:String=db.query_row("SELECT status FROM orchestration_v2_projection_subagents WHERE json_extract(payload_json,'$.nativeTaskRef.nativeId')='native-task'",[],|r|r.get(0)).unwrap();
            let delegated:String=db.query_row("SELECT status FROM orchestration_v2_projection_subagents WHERE json_extract(payload_json,'$.nativeTaskRef.nativeId')='delegated-task'",[],|r|r.get(0)).unwrap();
            let child_root:String=db.query_row("SELECT n.status FROM orchestration_v2_projection_nodes n JOIN orchestration_v2_projection_subagents a ON n.thread_id=a.child_thread_id WHERE a.origin='provider_native' AND n.kind='root_turn'",[],|r|r.get(0)).unwrap();
            assert_eq!(native,"cancelled");assert_eq!(child_root,"cancelled");assert_eq!(delegated,"running");
            let item:String=db.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json,'$.nativeItemRef.nativeId')='native-task' AND type='subagent'",[],|r|r.get(0)).unwrap();assert_eq!(item,"cancelled");
            let delegated_item:String=db.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json,'$.nativeItemRef.nativeId')='delegated-task' AND type='subagent'",[],|r|r.get(0)).unwrap();assert_eq!(delegated_item,"running");
        }).unwrap();
    }
    #[test]
    fn only_valid_questions_in_messageable_threads_survive() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"test"});
        let source = json!("web");
        for (thread, text, native) in [
            ("valid", "What next?", false),
            ("blank", "  \t", false),
            ("native", "What next?", true),
        ] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: thread,
                    thread_id: thread,
                    project_id: "p",
                    title: thread,
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &source,
                    link_origin: None,
                    delegated_from: None,
                },
                thread,
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
            bus.with_autocommit(|db| {
                if native {db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.creationSource','provider','$.lineage.relationshipToParent','subagent') WHERE thread_id=?1",[thread]).unwrap();}
                let node=format!("node-{thread}");let request=format!("request-{thread}");let item=format!("item-{thread}");let at="2026-01-01T00:00:01Z";
                let n=json!({"id":node,"threadId":thread,"runId":null,"status":"waiting","kind":"tool_call"});
                let q=json!({"id":request,"threadId":thread,"nodeId":node,"kind":"user_input","status":"pending","responseCapability":{"type":"live"}});
                let i=json!({"id":item,"threadId":thread,"nodeId":node,"requestId":request,"type":"user_input_request","status":"waiting","questions":[{"question":text}]});
                db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,started_at,payload_json) VALUES(?1,?2,NULL,NULL,?1,'tool_call','waiting',?3,?4)",params![node,thread,at,n.to_string()]).unwrap();
                db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES(?1,?2,?3,'user_input','pending',?4,?5)",params![request,thread,node,at,q.to_string()]).unwrap();
                db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,?3,1,'user_input_request','waiting',?4,?5)",params![item,thread,node,at,i.to_string()]).unwrap();
            }).unwrap();
        }
        recover(&bus, "2026-01-01T00:00:03Z").unwrap();
        bus.with_autocommit(|db|for (thread,expected) in [("valid","message"),("blank","not_resumable"),("native","not_resumable")] {
            let (status,cap):(String,String)=db.query_row("SELECT status,json_extract(payload_json,'$.responseCapability.type') FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1",[thread],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(cap,expected);assert_eq!(status,if thread=="valid" {"pending"}else{"expired"});
            if thread=="valid" {let node:String=db.query_row("SELECT status FROM orchestration_v2_projection_nodes WHERE thread_id=?1",[thread],|r|r.get(0)).unwrap();let item:String=db.query_row("SELECT status FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0)).unwrap();assert_eq!(node,"waiting");assert_eq!(item,"waiting");}
        }).unwrap();
    }
}
