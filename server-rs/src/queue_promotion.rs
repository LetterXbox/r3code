//! Promotion of an eligible queued run after the preceding run settles.
#[path = "fresh_context.rs"]
pub(crate) mod fresh_context;
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Start the next ordinary same-provider run. Unsupported handoff/deferred
/// variants remain queued until their dedicated promotion logic is available.
pub fn promote(bus: &EventBus, thread_id: &str, now: &str) -> Result<bool, BusError> {
    promote_selected(bus, thread_id, None, now)
}

pub fn promote_selected(
    bus: &EventBus,
    thread_id: &str,
    selected: Option<&str>,
    now: &str,
) -> Result<bool, BusError> {
    bus.commit(|tx| {
        let thread:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL",[thread_id],|r|r.get(0)).optional()?;
        let Some(thread)=thread else {return Ok((false,vec![]))};
        let mut thread:Value=serde_json::from_str(&thread).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))",[thread_id],|r|r.get(0))?;
        if active {return Ok((false,vec![]));}
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' AND ((?2 IS NOT NULL AND run_id=?2) OR (?2 IS NULL AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=0)) ORDER BY COALESCE(json_extract(payload_json,'$.queuePosition'),ordinal),ordinal LIMIT 1",params![thread_id,selected],|r|r.get(0)).optional()?;
        let Some(raw)=raw else {return Ok((false,vec![]))};
        let mut run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        // A deferred steer whose target settled is an ordinary queued turn.
        if !run["restartContinuationOfRunId"].is_null() {return Ok((false,vec![]));}
        let required=|v:&Value,k:&str| -> rusqlite::Result<String> {v[k].as_str().filter(|s|!s.is_empty()).map(str::to_owned).ok_or(rusqlite::Error::InvalidQuery)};
        let run_id=required(&run,"id")?; let mut provider_id=required(&run,"providerThreadId")?;
        let fresh = run["freshContext"] == true;
        if !fresh {
            // Ordinary queued messages resume the main conversation after a
            // scheduled fresh run; notifications continue the active one.
            let ordinary: bool = tx.query_row("SELECT COALESCE(json_type(payload_json,'$.notification') IS NULL AND json_type(payload_json,'$.delegatedCompletion') IS NULL,1) FROM orchestration_v2_projection_messages WHERE message_id=json_extract(?1,'$.userMessageId')", [run.to_string()], |r| r.get(0)).optional()?.unwrap_or(true);
            if ordinary {
                if let Some(id) = crate::conversation_provider::select(tx, thread_id)? {
                    let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND provider_instance_id=?2)", params![id,run["providerInstanceId"].as_str()], |r| r.get(0))?;
                    if matches { provider_id=id; run["providerThreadId"]=json!(provider_id); }
                }
            }
            let boundary:i64=tx.query_row("SELECT COALESCE(MAX(r.ordinal),0) FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND json_extract(r.payload_json,'$.freshContext')=1 AND r.status!='queued' AND NOT (r.status='cancelled' AND json_extract(r.payload_json,'$.startedAt') IS NULL) AND json_extract(m.payload_json,'$.scheduledTaskId') IS NULL",[thread_id],|r|r.get(0))?;
            let first:Option<i64>=tx.query_row("SELECT first_run_ordinal FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[&provider_id],|r|r.get(0)).optional()?.flatten();
            if boundary>0 && first.is_none_or(|first|first<boundary) {
                let replacement:Option<String>=tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_instance_id=?2 AND owner_node_id IS NULL AND first_run_ordinal>=?3 ORDER BY CASE WHEN provider_thread_id=?4 THEN 0 ELSE 1 END,last_run_ordinal DESC LIMIT 1",params![thread_id,run["providerInstanceId"].as_str(),boundary,thread["activeProviderThreadId"].as_str()],|r|r.get(0)).optional()?;
                let replacement=if let Some(replacement)=replacement {replacement} else {
                    let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[&provider_id],|r|r.get(0))?;
                    let prior:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
                    let driver=prior["driver"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
                    let id=crate::message_commands::pending_provider_thread_id(driver,&format!("{run_id}:context"));
                    let provider=json!({"id":id,"driver":driver,"providerInstanceId":run["providerInstanceId"],"providerSessionId":null,"appThreadId":thread_id,"ownerNodeId":null,"nativeThreadRef":null,"nativeConversationHeadRef":null,"status":"not_loaded","firstRunOrdinal":null,"lastRunOrdinal":null,"handoffIds":[],"forkedFrom":null,"pendingBackgroundTasks":[],"contextUsage":null,"nativeMetadata":null,"goal":null,"createdAt":now,"updatedAt":now});
                    tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES(?1,?2,NULL,?3,?4,NULL,'not_loaded',NULL,NULL,?5,?6)",params![id,thread_id,driver,run["providerInstanceId"].as_str(),now,provider.to_string()])?;
                    id
                };
                provider_id=replacement;run["providerThreadId"]=json!(provider_id);
            }
        }
        let fresh_detach = if fresh { fresh_context::plan(tx,thread_id,None,true)?.unwrap_or_default() } else { vec![] };
        let switching = !fresh && thread["activeProviderThreadId"].as_str().is_some_and(|id| id != provider_id);
        let command=format!("command:system:start-queued:{run_id}");
        if event_store::get_receipt(tx,&command,"thread")?.is_some() {return Ok((false,vec![]));}
        let load=|sql:&str,id:&str| -> rusqlite::Result<Value> {let raw:String=tx.query_row(sql,[id],|r|r.get(0))?;serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)};
        let mut provider=load("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",&provider_id)?;
        if provider["providerInstanceId"] != run["providerInstanceId"] {return Ok((false,vec![]));}
        if provider["providerSessionId"].as_str().is_none() { provider["providerSessionId"] = if provider["driver"] == "codex" { json!(format!("provider-session:provider-instance:{}:shared", crate::message_commands::encode_id_part(run["providerInstanceId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?))) } else { json!(format!("provider-session:{}",uuid::Uuid::new_v4())) }; }
        if fresh && fresh_context::needs_new_session(tx,thread_id,provider["providerSessionId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)? {provider["providerSessionId"]=json!(format!("provider-session:{}",uuid::Uuid::new_v4()));}
        let instance = run["providerInstanceId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let pending_merge = match crate::merge_handoff::pending(tx, thread_id, fresh)? {
            Ok(pending) => pending,
            Err(_) => return Ok((false, vec![])),
        };
        let fork_handoff = if fresh {None} else {crate::message_commands::prepare_fork_handoff(tx, thread_id, &run_id, &provider_id, instance, provider["driver"].as_str().ok_or(rusqlite::Error::InvalidQuery)?, now)?};
        let is_fork = fork_handoff.is_some();
        let switch_handoff = if switching { crate::message_commands::prepare_switch_handoff(tx, thread_id, &run_id, &provider_id, instance, now, pending_merge.is_some())? } else { None };
        let (merge_handoff, merge_events) = if let Some(pending) = pending_merge {
            let (handoff, events) = crate::merge_handoff::consume(tx, pending, thread_id, &run_id, &provider_id, instance, now)?;
            (Some(handoff), events)
        } else { (None, vec![]) };
        let active_provider = if let Some(id) = thread["activeProviderThreadId"].as_str() {
            tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [id], |r| r.get::<_, String>(0)).optional()?
                .map(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?
        } else { None };
        let legacy_handoff = if !fresh && fork_handoff.is_none() && switch_handoff.is_none() && merge_handoff.is_none() { crate::context_handoff::prepare_legacy_import(tx, &thread, active_provider.as_ref(), &run_id, &provider_id, now)? } else { None };
        for h in fork_handoff.as_ref().map(|(h, _, _)| h).into_iter().chain(switch_handoff.as_ref().map(|(h, _)| h)).chain(merge_handoff.as_ref()).chain(legacy_handoff.as_ref()) { if run["contextHandoffId"].is_null() { run["contextHandoffId"] = h["id"].clone(); } provider["handoffIds"].as_array_mut().ok_or(rusqlite::Error::InvalidQuery)?.push(h["id"].clone()); }
        if let Some((_, _, Some(side))) = fork_handoff.as_ref() { provider["handoffIds"].as_array_mut().ok_or(rusqlite::Error::InvalidQuery)?.push(side["id"].clone()); }
        let node_id=required(&run,"rootNodeId")?; let attempt_id=required(&run,"activeAttemptId")?; let msg_id=required(&run,"userMessageId")?;
        let mut node=load("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1",&node_id)?;
        let mut attempt=load("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?1",&attempt_id)?;
        node["providerThreadId"]=json!(provider_id);attempt["providerThreadId"]=json!(provider_id);
        let message=load("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",&msg_id)?;
        let scope_id=node["checkpointScopeId"].as_str().map(str::to_owned).or_else(|| tx.query_row("SELECT scope_id FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id=?1 AND kind='root_run' LIMIT 1",[thread_id],|r|r.get(0)).optional().ok().flatten()).ok_or(rusqlite::Error::InvalidQuery)?;
        let mut scope=load("SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id=?1",&scope_id)?;
        let old_ordinal=run["ordinal"].as_i64().ok_or(rusqlite::Error::InvalidQuery)?;
        let started_ahead:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_turn_items i ON i.run_id=r.run_id AND i.type IN ('user_message','notification') WHERE r.thread_id=?1 AND r.status!='queued' AND r.ordinal>?2)",params![thread_id,old_ordinal],|r|r.get(0))?;
        let ordinal=if started_ahead { tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_runs WHERE thread_id=?1",[thread_id],|r|r.get(0))? } else { old_ordinal };
        run["ordinal"]=json!(ordinal);
        if let Some(obj)=run.as_object_mut() { obj.remove("steerWhenReadyRunId"); }
        run["status"]=json!("starting");run["queuePosition"]=Value::Null;run["startedAt"]=Value::Null;
        node["checkpointScopeId"]=json!(scope_id);scope["runId"]=json!(run_id);scope["nodeId"]=json!(node_id);scope["providerThreadId"]=json!(provider_id);scope["createdAt"]=json!(now);
        if provider["firstRunOrdinal"].is_null() {provider["firstRunOrdinal"]=json!(ordinal);} provider["lastRunOrdinal"]=json!(ordinal);provider["updatedAt"]=json!(now); thread["activeProviderThreadId"]=json!(provider_id);
        let item_id=format!("turn-item:message:{msg_id}");
        let visible_fork = is_fork && thread["lineage"]["sideChat"] != true;
        let handoff_source = if visible_fork { fork_handoff.as_ref().map(|(h,_,_)| h) } else { merge_handoff.as_ref().or(switch_handoff.as_ref().map(|(h,_)| h)) }.or(legacy_handoff.as_ref());
        let band_start = ordinal * 1_000_000;
        let band_end = band_start + 999_999;
        let existing_base: i64 = tx.query_row(
            "SELECT COALESCE(MAX(ordinal), ?2) FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id!=?3 AND ordinal>=?2 AND ordinal<=?4",
            params![thread_id, band_start, item_id, band_end],
            |r| r.get(0),
        )?;
        let (handoff_ordinal, user_ordinal) = if handoff_source.is_some() {
            (Some(existing_base + 1), existing_base + 2)
        } else {
            (None, existing_base + 1)
        };
        if let Some(h_ord) = handoff_ordinal {
            // Move user_message out of the lower slot first so (thread_id, ordinal) stays unique.
            event_store::set_turn_item_ordinal(tx, thread_id, &item_id, user_ordinal)?;
            let _ = h_ord;
        } else if ordinal != old_ordinal {
            event_store::set_turn_item_ordinal(tx, thread_id, &item_id, user_ordinal)?;
        }
        let mut item=json!({"createdBy":message["createdBy"],"creationSource":message["creationSource"],"id":item_id,"threadId":thread_id,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":user_ordinal,"status":"completed","title":null,"startedAt":now,"completedAt":now,"updatedAt":now,"type":"user_message","messageId":msg_id,"inputIntent":"queued_turn","text":message["text"],"attachments":message["attachments"]});
        if let Some(context)=message.get("context"){item["context"]=context.clone();}
        if fresh { item["freshContext"]=json!(true); }
        if let Some(parent) = message["delegatedCompletion"]["parentRunId"].as_str() {
            let tasks = crate::message_commands::delegated_tasks(tx, thread_id, parent)?;
            crate::message_commands::delegated_notification(&mut item, &message["delegatedCompletion"], &tasks);
        }
        let handoff_item = handoff_source.map(|h| {
            let h_ord = handoff_ordinal.expect("handoff ordinal");
            let mut signal = crate::message_commands::handoff_turn_item(tx,h,&run,&node_id,h_ord,now)?;
            if is_fork { signal["title"] = json!("Fork context"); } else if merge_handoff.is_some() && switch_handoff.is_none() { signal["title"] = json!("Merge-back context"); }
            if let Some(sig_id) = signal["id"].as_str() {
                event_store::set_turn_item_ordinal(tx, thread_id, sig_id, h_ord)?;
            }
            Ok::<_,rusqlite::Error>(signal)
        }).transpose()?;
        tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',ordinal=?2,payload_json=?3,provider_thread_id=?4 WHERE run_id=?1 AND status='queued'",params![run_id,ordinal,run.to_string(),provider_id])?;
        tx.execute("UPDATE orchestration_v2_projection_nodes SET checkpoint_scope_id=?2,payload_json=?3,provider_thread_id=?4 WHERE node_id=?1",params![node_id,scope_id,node.to_string(),provider_id])?;
        tx.execute("UPDATE orchestration_v2_projection_run_attempts SET provider_thread_id=?2,payload_json=?3 WHERE attempt_id=?1",params![attempt_id,provider_id,attempt.to_string()])?;
        tx.execute("UPDATE orchestration_v2_projection_checkpoint_scopes SET run_id=?2,node_id=?3,provider_thread_id=?4,created_at=?5,payload_json=?6 WHERE scope_id=?1",params![scope_id,run_id,node_id,provider_id,now,scope.to_string()])?;
        tx.execute("UPDATE orchestration_v2_projection_provider_threads SET last_run_ordinal=?2,updated_at=?3,payload_json=?4,provider_session_id=json_extract(?4,'$.providerSessionId'),first_run_ordinal=COALESCE(first_run_ordinal,?2) WHERE provider_thread_id=?1",params![provider_id,ordinal,now,provider.to_string()])?;
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2 WHERE thread_id=?1",params![thread_id,thread.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?9,'completed',?7,?8) ON CONFLICT(turn_item_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,provider_thread_id=excluded.provider_thread_id,ordinal=excluded.ordinal,type=excluded.type,status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item_id,thread_id,run_id,node_id,provider_id,user_ordinal,now,item.to_string(),item["type"].as_str()])?;
        if let Some(ref signal)=handoff_item {tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'handoff','completed',?7,?8)",params![signal["id"].as_str(),thread_id,run_id,node_id,provider_id,signal["ordinal"].as_i64(),now,signal.to_string()])?;}
        if fresh { fresh_context::defer_detach(tx,thread_id,&command,&fresh_detach,provider["providerSessionId"].as_str(),now)?; }
        let effect=Effect{id:format!("effect:{command}:provider-turn.start:{run_id}"),command_id:command.clone(),thread_id:thread_id.into(),request:json!({"type":"provider-turn.start","runId":run_id}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None}; outbox::enqueue(tx,&effect)?;
        let mut payloads=vec![("run.updated",run),("run-attempt.updated",attempt),("node.updated",node),("checkpoint-scope.created",scope),("provider-thread.updated",provider)];
        if let Some((h,t,side))=fork_handoff {payloads.push(("context-transfer.updated",t));payloads.push(("context-handoff.updated",h));if let Some(side)=side {payloads.push(("context-handoff.updated",side));}}
        if let Some((h,t))=switch_handoff {payloads.push(("context-transfer.created",t));payloads.push(("context-handoff.updated",h));}
        payloads.extend(merge_events);
        if let Some(h)=legacy_handoff {payloads.push(("context-handoff.updated",h));}
        if let Some(signal)=handoff_item {payloads.push(("turn-item.updated",signal));}
        payloads.push(("turn-item.updated",item));
        let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.clone()),causation_event_id:None,correlation_id:Some(command.clone()),actor_kind:"system".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;event_store::insert_receipt_if_absent(tx,&Receipt{command_id:command,aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"message.dispatch".into(),accepted_at:now.into(),result_sequence:stored.last().unwrap().sequence,status:"accepted".into(),error:None})?;
        Ok((true,stored))
    })
}

/// A provider failure holds queued runs for that provider until the user resumes.
pub fn hold_after_failure(
    bus: &EventBus,
    thread_id: &str,
    failed_id: &str,
    now: &str,
) -> Result<(), BusError> {
    bus.commit(|tx| {
        let failed: Option<(String, String)> = tx.query_row("SELECT json_extract(payload_json,'$.providerInstanceId'), COALESCE((SELECT json_extract(payload_json,'$.failure.class') FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND type='error' ORDER BY ordinal DESC LIMIT 1),'provider_error') FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='failed' AND ordinal=(SELECT MAX(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id=?2 AND status!='queued')",params![failed_id,thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((instance,class))=failed else {return Ok(((),vec![]))};
        if class == "usage_limit" || class == "validation_error" {return Ok(((),vec![]))}
        let same:bool=tx.query_row("SELECT COALESCE((SELECT json_extract(payload_json,'$.providerInstanceId')=?2 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=0 ORDER BY COALESCE(json_extract(payload_json,'$.queuePosition'),ordinal),ordinal LIMIT 1),0)",params![thread_id,instance],|r|r.get(0))?;
        if !same {return Ok(((),vec![]))}
        let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' ORDER BY ordinal")?;
        let rows=stmt.query_map([thread_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut events=vec![];
        for raw in rows {let mut run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; if run["queueHeld"] == true {continue} run["queueHeld"]=json!(true);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![run["id"].as_str(),run.to_string()])?;events.push(Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:"run.updated".into(),occurred_at:now.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload:run,metadata:json!({})});}
        let stored=event_store::append(tx,&events)?;Ok(((),stored))
    })
}

/// Release all queued runs and record the user command before attempting promotion.
pub fn resume(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    selected: Option<&str>,
    now: &str,
) -> Result<crate::thread_commands::CommitResult, crate::message_commands::DispatchError> {
    use crate::{message_commands::DispatchError, thread_commands::CommitResult};
    let result = bus.commit_with(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            if receipt.aggregate_id != thread_id { return Err(DispatchError::CommandIdConflict); }
            return Ok((CommitResult { receipt, committed: false }, vec![]));
        }
        let thread: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL", [thread_id], |r| r.get(0)).optional()?;
        let valid_selected: bool = match selected {
            None => true,
            Some(id) => tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.run_id=?2 AND r.status='queued' AND json_extract(m.payload_json,'$.delegatedCompletion') IS NULL AND json_extract(m.payload_json,'$.notification') IS NULL) AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))", params![thread_id,id], |r|r.get(0))?,
        };
        let limited: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_turn_items i ON i.run_id=r.run_id AND i.type='error' WHERE r.thread_id=?1 AND r.status='failed' AND r.ordinal=(SELECT MAX(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status!='queued') AND json_extract(i.payload_json,'$.failure.class')='usage_limit' AND json_extract(r.payload_json,'$.providerInstanceId')=COALESCE((SELECT json_extract(q.payload_json,'$.providerInstanceId') FROM orchestration_v2_projection_runs q WHERE q.thread_id=?1 AND q.status='queued' ORDER BY CASE WHEN q.run_id=?2 THEN 0 ELSE 1 END, COALESCE(json_extract(q.payload_json,'$.queuePosition'),q.ordinal),q.ordinal LIMIT 1),json_extract((SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1),'$.modelSelection.instanceId')))", params![thread_id,selected], |r|r.get(0))?;
        let error = if thread.is_none() { Some(format!("Thread {thread_id} is not active.")) } else if !valid_selected { Some("A queued user message can only be sent now while the thread is stopped.".into()) } else if limited { Some("Continue the limited thread before resuming its queue.".into()) } else { None };
        let mut receipt = Receipt {command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:if selected.is_some(){"queued-run.start"}else{"queue.resume"}.into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(DispatchError::CommandIdConflict)}
        if receipt.error.is_some() {return Ok((CommitResult{receipt,committed:false},vec![]))}
        let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' ORDER BY ordinal")?;
        let rows=stmt.query_map([thread_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut payloads=Vec::new();
        for raw in rows { let mut run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; if selected.is_some_and(|id| run["id"].as_str() != Some(id)) || run["queueHeld"] != true { continue; } run["queueHeld"]=json!(false);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![run["id"].as_str(),run.to_string()])?;payloads.push(("run.updated",run)); }
        if payloads.is_empty() { payloads.push(("thread.metadata-updated",serde_json::from_str(&thread.unwrap()).map_err(|_|rusqlite::Error::InvalidQuery)?)); }
        let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;receipt.result_sequence=stored.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult{receipt,committed:true},stored))
    })?;
    if result.committed && result.receipt.status == "accepted" {
        promote_selected(bus, thread_id, selected, now)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn queued_delegated_wake_starts_as_notification() {
        use crate::delegated_continuation::{ContinuationRequest, DeliveryKey};
        use crate::message_commands::dispatch_delegated_completion;
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
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
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "first",
                thread_id: "t",
                message_id: "m1",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let parent = "run:thread:t:ordinal:1";
        bus.commit(|tx| {
            let cohort = json!({"disposition":"open","delivery":{"generation":1,"messageId":"wake","taskIds":["task"]}});
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.delegatedCompletion',json(?2)) WHERE run_id=?1", params![parent,cohort.to_string()])?;
            let task = json!({"id":"task","runId":parent,"origin":"app_owned","status":"completed","title":"Review","result":"done","childThreadId":"child"});
            tx.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('task','t',?1,'n','codex','app_owned','completed','now',?2)",params![parent,task.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let request = ContinuationRequest {
            thread_id: "t".into(),
            provider_thread_id: "pt".into(),
            driver: "codex".into(),
            detail: None,
            delivery: "message_text".into(),
            delegated_completion: DeliveryKey {
                parent_run_id: parent.into(),
                generation: 1,
                message_id: "wake".into(),
            },
        };
        assert!(
            dispatch_delegated_completion(&bus, &request, "/tmp", "2026-01-01T00:00:02Z")
                .unwrap()
                .unwrap()
                .committed
        );
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id=?1",[parent])?;Ok(((),vec![]))}).unwrap();
        assert!(promote(&bus, "t", "2026-01-01T00:00:03Z").unwrap());
        bus.commit(|tx| {
            let (kind, raw):(String,String) = tx.query_row("SELECT type,payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:message:wake'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let item: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(kind,"notification");
            assert_eq!(item["summary"],"Delegated task \"Review\" finished");
            assert_eq!(item["source"]["childThreadId"],"child");
            assert!(item.get("messageId").is_none());
            Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn settled_run_promotes_one_queued_message_and_replays_safely() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
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
            "2026-01-01T00:00:00.000Z",
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
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01.000Z").unwrap();
        dispatch_first_message(&bus, send("next", "m2"), "2026-01-01T00:00:02.000Z").unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:thread:t:ordinal:1'",[])?;Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.steerWhenReadyRunId','run:thread:t:ordinal:1') WHERE ordinal=2",[])?;Ok(((),vec![])) }).unwrap();
        assert!(promote(&bus, "t", "2026-01-01T00:00:03.000Z").unwrap());
        assert!(!promote(&bus, "t", "2026-01-01T00:00:04.000Z").unwrap());
        bus.commit(|tx| {let state:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert_eq!(state,"starting");let (marker,intent):(Option<String>,String)=tx.query_row("SELECT json_extract(r.payload_json,'$.steerWhenReadyRunId'),json_extract(i.payload_json,'$.inputIntent') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_turn_items i ON i.run_id=r.run_id WHERE r.ordinal=2 AND i.type='user_message'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(marker,None);assert_eq!(intent,"queued_turn");let effect:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE command_id='command:system:start-queued:run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert_eq!(effect,1);Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn queued_promotion_consumes_pending_merge_back() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
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
            "2026-01-01T00:00:00.000Z",
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
        dispatch_first_message(&bus, send("first", "m1"), "2026-01-01T00:00:01.000Z").unwrap();
        dispatch_first_message(&bus, send("next", "m2"), "2026-01-01T00:00:02.000Z").unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:thread:t:ordinal:1'",[])?;Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.steerWhenReadyRunId','run:thread:t:ordinal:1') WHERE ordinal=2",[])?;Ok(((),vec![])) }).unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='t' LIMIT 1", [], |r| r.get(0))?;
            let mut provider: Value = serde_json::from_str(&raw).unwrap();
            provider["id"] = json!("switch-provider"); provider["providerInstanceId"] = json!("other"); provider["handoffIds"] = json!([]);
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_instance_id,status,updated_at,payload_json) VALUES('switch-provider','t','codex','other','not_loaded','now',?1)", [provider.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET provider_thread_id='switch-provider', provider_instance_id='other',payload_json=json_set(payload_json,'$.providerThreadId','switch-provider','$.providerInstanceId','other') WHERE run_id='run:thread:t:ordinal:2'", [])?;
            let transfer = json!({"id":"merge", "sourceThreadId":"t", "targetThreadId":"t", "sourcePoint":{"runId":"run:thread:t:ordinal:1"}, "type":"merge_back", "status":"pending", "updatedAt":"now"});
            tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('merge','t','t','merge_back','pending','now',?1)", [transfer.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        assert!(promote(&bus, "t", "2026-01-01T00:00:03.000Z").unwrap());
        assert!(!promote(&bus, "t", "2026-01-01T00:00:04.000Z").unwrap());
        bus.commit(|tx| {
            let (status, count, linked, handoffs, signals): (String, i64, String, i64, i64) = tx.query_row("SELECT t.status,(SELECT COUNT(*) FROM orchestration_v2_projection_context_handoffs WHERE target_run_id=t.target_run_id),json_extract(r.payload_json,'$.contextHandoffId'),json_array_length(json_extract(p.payload_json,'$.handoffIds')),(SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE run_id=t.target_run_id AND type='handoff') FROM orchestration_v2_projection_context_transfers t JOIN orchestration_v2_projection_runs r ON r.run_id=t.target_run_id JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE t.context_transfer_id='merge'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
            assert_eq!(status, "consumed"); assert_eq!(count, 2); assert_eq!(handoffs, 2); assert_eq!(signals, 1);
            let strategies: Vec<String> = { let mut stmt = tx.prepare("SELECT strategy FROM orchestration_v2_projection_context_handoffs WHERE target_run_id='run:thread:t:ordinal:2' ORDER BY rowid")?; let rows=stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?; rows };
            assert_eq!(strategies, vec!["full_thread_summary", "fork_delta_summary"]);
            let switched: String = tx.query_row("SELECT context_handoff_id FROM orchestration_v2_projection_context_handoffs WHERE strategy='full_thread_summary'", [], |r| r.get(0))?; assert_eq!(linked, switched);
            let (signal_id,title): (String,String) = tx.query_row("SELECT json_extract(payload_json,'$.contextHandoffId'),json_extract(payload_json,'$.title') FROM orchestration_v2_projection_turn_items WHERE run_id='run:thread:t:ordinal:2' AND type='handoff'", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            let merged: String = tx.query_row("SELECT context_handoff_id FROM orchestration_v2_projection_context_handoffs WHERE strategy='fork_delta_summary'", [], |r| r.get(0))?; assert_eq!(signal_id, merged); assert_eq!(title, "Provider handoff");
            Ok(((),vec![]))
        }).unwrap();
        bus.commit(|tx| {let state:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert_eq!(state,"starting");let (marker,intent):(Option<String>,String)=tx.query_row("SELECT json_extract(r.payload_json,'$.steerWhenReadyRunId'),json_extract(i.payload_json,'$.inputIntent') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_turn_items i ON i.run_id=r.run_id WHERE r.ordinal=2 AND i.type='user_message'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(marker,None);assert_eq!(intent,"queued_turn");let effect:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE command_id='command:system:start-queued:run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert_eq!(effect,1);Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn queued_promotion_consumes_pending_side_chat_fork() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let origin = json!("web");
        for id in ["parent", "child"] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: id,
                    thread_id: id,
                    project_id: "p",
                    title: id,
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &origin,
                    link_origin: None,
                    delegated_from: None,
                },
                &format!("event-{id}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        for (command, message) in [("first", "m1"), ("queued", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: command,
                    thread_id: "child",
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
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='child'", [])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE thread_id='child' AND ordinal=1", [])?;
            let transfer = json!({"id":"fork-transfer","type":"fork","sourceThreadId":"parent","targetThreadId":"child","sourcePoint":{"threadId":"parent"},"sourceProviderInstanceId":"codex","status":"pending"});
            tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,source_provider,source_provider_instance_id,updated_at,payload_json) VALUES('fork-transfer','parent','child','fork','pending','codex','codex','2026-01-01',?1)", [transfer.to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        assert!(promote(&bus, "child", "2026-01-01T00:00:03Z").unwrap());
        assert!(!promote(&bus, "child", "2026-01-01T00:00:04Z").unwrap());
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='fork-transfer'", [], |r| r.get(0))?;
            let transfer: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(transfer["status"], "consumed");
            assert_eq!(transfer["targetRunId"], "run:thread:child:ordinal:2");
            assert_eq!(transfer["resolution"]["strategy"], "portable_context");
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE target_run_id='run:thread:child:ordinal:2'", [], |r| r.get(0))?;
            let handoff: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(handoff["strategy"], "manual_context");
            assert!(handoff["summaryText"].as_str().unwrap().starts_with("You are in a side chat beside the main thread."));
            assert_eq!(transfer["resolution"]["contextHandoffId"], handoff["id"]);
            let (linked, visible): (String, i64) = tx.query_row("SELECT json_extract(payload_json,'$.contextHandoffId'), (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE run_id='run:thread:child:ordinal:2' AND type='handoff') FROM orchestration_v2_projection_runs WHERE run_id='run:thread:child:ordinal:2'", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!(linked, handoff["id"].as_str().unwrap());
            assert_eq!(visible, 0);
            let events: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE event_type='context-transfer.updated' AND stream_id='child'", [], |r| r.get(0))?;
            assert_eq!(events, 1);
            Ok(((), vec![]))
        }).unwrap();
    }

    #[test]
    fn queued_promotion_consumes_fork_merge_and_switch_together() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let origin = json!("web");
        for id in ["parent", "child"] {
            create_thread_ordered(
                &bus,
                CreateThread {
                    command_id: id,
                    thread_id: id,
                    project_id: "p",
                    title: id,
                    model_selection: &selection,
                    runtime_mode: "full-access",
                    interaction_mode: "default",
                    branch: None,
                    worktree_path: None,
                    created_by: "user",
                    creation_source: &origin,
                    link_origin: None,
                    delegated_from: None,
                },
                &format!("event-{id}"),
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        dispatch_first_message(&bus, DispatchMessage { context: None, command_id: "parent-message", thread_id: "parent", message_id: "parent-m1", text: "fork source context", attachments: &[], creation_source: "web", cwd: "/tmp", driver: "codex" }, "2026-01-01T00:00:01Z").unwrap();
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE thread_id='parent'", [])?; Ok(((),vec![])) }).unwrap();
        for (command, message) in [("first", "m1"), ("queued", "m2")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id: command,
                    thread_id: "child",
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
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='child'", [])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE thread_id='child' AND ordinal=1", [])?;
            let transfer = json!({"id":"fork-transfer","type":"fork","sourceThreadId":"parent","targetThreadId":"child","sourcePoint":{"threadId":"parent"},"sourceProviderInstanceId":"codex","status":"pending"});
            tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,source_provider,source_provider_instance_id,updated_at,payload_json) VALUES('fork-transfer','parent','child','fork','pending','codex','codex','2026-01-01',?1)", [transfer.to_string()])?;
            let merge = json!({"id":"merge-transfer","type":"merge_back","sourceThreadId":"parent","targetThreadId":"child","sourcePoint":{"runId":"run:thread:parent:ordinal:1"},"status":"pending","updatedAt":"2026-01-01"});
            tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('merge-transfer','parent','child','merge_back','pending','2026-01-01',?1)", [merge.to_string()])?;
            Ok(((), vec![]))
        }).unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id='child' LIMIT 1", [], |r| r.get(0))?;
            let mut provider: Value = serde_json::from_str(&raw).unwrap();
            provider["id"] = json!("switch-provider"); provider["providerInstanceId"] = json!("other"); provider["handoffIds"] = json!([]);
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_instance_id,status,updated_at,payload_json) VALUES('switch-provider','child','codex','other','not_loaded','now',?1)", [provider.to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET provider_thread_id='switch-provider',provider_instance_id='other',payload_json=json_set(payload_json,'$.providerThreadId','switch-provider','$.providerInstanceId','other') WHERE thread_id='child' AND ordinal=2", [])?;
            Ok(((),vec![]))
        }).unwrap();
        assert!(promote(&bus, "child", "2026-01-01T00:00:03Z").unwrap());
        assert!(!promote(&bus, "child", "2026-01-01T00:00:04Z").unwrap());
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='fork-transfer'", [], |r| r.get(0))?;
            let transfer: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(transfer["status"], "consumed");
            assert_eq!(transfer["targetRunId"], "run:thread:child:ordinal:2");
            assert_eq!(transfer["resolution"]["strategy"], "portable_context");
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE target_run_id='run:thread:child:ordinal:2' AND json_extract(payload_json,'$.transferId')='fork-transfer'", [], |r| r.get(0))?;
            let handoff: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(handoff["strategy"], "manual_context");
            assert!(handoff["summaryText"].as_str().unwrap().starts_with("You are in a side chat beside the main thread."));
            assert_eq!(transfer["resolution"]["contextHandoffId"], handoff["id"]);
            let (linked, visible): (String, i64) = tx.query_row("SELECT json_extract(payload_json,'$.contextHandoffId'), (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE run_id='run:thread:child:ordinal:2' AND type='handoff') FROM orchestration_v2_projection_runs WHERE run_id='run:thread:child:ordinal:2'", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!(linked, handoff["id"].as_str().unwrap());
            assert_eq!(visible, 1);
            let (status, signal, title, count): (String, String, String, i64) = tx.query_row("SELECT t.status,json_extract(i.payload_json,'$.contextHandoffId'),json_extract(i.payload_json,'$.title'),(SELECT COUNT(*) FROM orchestration_v2_projection_context_handoffs WHERE target_run_id=t.target_run_id) FROM orchestration_v2_projection_context_transfers t JOIN orchestration_v2_projection_turn_items i ON i.run_id=t.target_run_id AND i.type='handoff' WHERE t.context_transfer_id='merge-transfer'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            let merge_id: String = tx.query_row("SELECT context_handoff_id FROM orchestration_v2_projection_context_handoffs WHERE strategy='fork_delta_summary'", [], |r| r.get(0))?;
            assert_eq!(status, "consumed"); assert_eq!(signal, merge_id); assert_eq!(title, "Fork context"); assert_eq!(count, 3);
            let handoffs = crate::provider::executor::pending_handoffs(tx, Some("switch-provider"), "run:thread:child:ordinal:2")?;
            assert_eq!(handoffs.len(), 3);
            assert_eq!(handoffs[0]["transferId"], "fork-transfer");
            assert_eq!(handoffs[1]["strategy"], "full_thread_summary");
            assert_eq!(handoffs[2]["transferId"], "merge-transfer");
            assert!(handoffs[1]["summaryText"].as_str().unwrap().contains("hello"));
            let events: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_events WHERE event_type='context-transfer.updated' AND stream_id='child'", [], |r| r.get(0))?;
            assert_eq!(events, 2);
            Ok(((), vec![]))
        }).unwrap();
    }

    #[test]
    fn failed_provider_holds_all_queued_runs_until_resume() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
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
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        for (command_id, message_id) in [("first", "m1"), ("second", "m2"), ("third", "m3")] {
            dispatch_first_message(
                &bus,
                DispatchMessage {
                    context: None,
                    command_id,
                    thread_id: "t",
                    message_id,
                    text: "hello",
                    attachments: &[],
                    creation_source: "web",
                    cwd: "/tmp",
                    driver: "codex",
                },
                "2026-01-01T00:00:01.000Z",
            )
            .unwrap();
        }
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_runs SET status='failed',payload_json=json_set(payload_json,'$.status','failed') WHERE ordinal=1",[])?;Ok(((),vec![]))}).unwrap();
        hold_after_failure(
            &bus,
            "t",
            "run:thread:t:ordinal:1",
            "2026-01-01T00:00:02.000Z",
        )
        .unwrap();
        assert!(!promote(&bus, "t", "2026-01-01T00:00:03.000Z").unwrap());
        bus.commit(|tx|{let n:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status='queued' AND json_extract(payload_json,'$.queueHeld')=1",[],|r|r.get(0))?;assert_eq!(n,2);Ok(((),vec![]))}).unwrap();
        let result = resume(
            &bus,
            "resume",
            "t",
            Some("run:thread:t:ordinal:3"),
            "2026-01-01T00:00:04.000Z",
        )
        .unwrap();
        assert!(result.committed);
        bus.commit(|tx|{let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE ordinal=3",[],|r|r.get(0))?;assert_eq!(status,"starting");let held:bool=tx.query_row("SELECT json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?;assert!(held);Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn switching_queued_provider_prepares_history_when_promoted() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"one","model":"gpt"});
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
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let send = |command_id, message_id| DispatchMessage {
            context: None,
            command_id,
            thread_id: "t",
            message_id,
            text: "remember this",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(&bus, send("one", "m1"), "2026-01-01T00:00:01.000Z").unwrap();
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.instanceId','two') WHERE thread_id='t'",[])?;Ok(((),vec![]))}).unwrap();
        assert!(
            dispatch_first_message(&bus, send("two", "m2"), "2026-01-01T00:00:02.000Z")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE ordinal=1",[])?;Ok(((),vec![]))}).unwrap();
        assert!(promote(&bus, "t", "2026-01-01T00:00:03.000Z").unwrap());
        bus.commit(|tx| {let h:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE target_run_id='run:thread:t:ordinal:2'",[],|r|r.get(0))?;assert!(h.contains("remember this"));let linked:bool=tx.query_row("SELECT json_extract(payload_json,'$.contextHandoffId') IS NOT NULL FROM orchestration_v2_projection_runs WHERE ordinal=2",[],|r|r.get(0))?;assert!(linked);Ok(((),vec![]))}).unwrap();
        bus.commit(|tx| {
            let source: String = tx.query_row("SELECT json_extract(payload_json,'$.sourcePoint.runId') FROM orchestration_v2_projection_context_transfers", [], |r| r.get(0))?;
            assert_eq!(source, "run:thread:t:ordinal:1");
            let signal: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type='handoff'", [], |r| r.get(0))?;
            let signal: Value = serde_json::from_str(&signal).unwrap();
            assert_eq!(signal["fromProviderInstanceIds"], json!(["one"]));
            assert_eq!(signal["toProviderInstanceId"], "two");
            assert_eq!(signal["ordinal"], 2_000_001);
            Ok(((), vec![]))
        }).unwrap();
    }
}
