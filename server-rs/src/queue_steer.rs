//! Atomically promote a queued message into an active provider turn.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub fn dispatch(
    bus: &EventBus,
    command: &str,
    thread: &str,
    queued: &str,
    target: &str,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command, thread, queued, target, now, |_| Ok(()))
}
pub fn dispatch_checked<F>(
    bus: &EventBus,
    command: &str,
    thread: &str,
    queued: &str,
    target: &str,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
{
    let promote_after = std::cell::Cell::new(false);
    let result = bus.commit(|tx|{
  check(tx)?;
  if let Some(receipt)=event_store::get_receipt(tx,command,"thread")? {if receipt.aggregate_id != thread { return Err(rusqlite::Error::InvalidQuery); } return Ok((CommitResult{receipt,committed:false},vec![]));}
  let load=|sql:&str,id:&str| -> rusqlite::Result<Option<Value>> {let raw:Option<String>=tx.query_row(sql,params![thread,id],|r|r.get(0)).optional()?;raw.map(|s|serde_json::from_str(&s).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()};
  let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL)",[thread],|r|r.get(0))?;
  let run=load("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status='queued'",queued)?;
  let (mut run,mut message,mut attempt,mut node)=(run.clone().unwrap_or(Value::Null),Value::Null,Value::Null,Value::Null);
  if run.is_object(){message=load("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2",run["userMessageId"].as_str().unwrap_or(""))?.unwrap_or(Value::Null);attempt=load("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 AND attempt_id=?2",run["activeAttemptId"].as_str().unwrap_or(""))?.unwrap_or(Value::Null);node=load("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND node_id=?2",run["rootNodeId"].as_str().unwrap_or(""))?.unwrap_or(Value::Null);}
  let target_run=load("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",target)?;
  let turn:Option<(String,String,String,String)>=tx.query_row("SELECT p.provider_turn_id,p.provider_thread_id,pt.provider_session_id,p.node_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id=p.provider_thread_id WHERE r.thread_id=?1 AND r.run_id=?2 AND r.status='running' AND p.status='running' AND pt.provider_session_id IS NOT NULL",params![thread,target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
  let stopped:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type='run_interrupt_request')",params![thread,target],|r|r.get(0))?;
  let text=message["text"].as_str().unwrap_or("").trim().to_ascii_lowercase();
  let target_text:Option<String>=tx.query_row("SELECT json_extract(m.payload_json,'$.text') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.run_id=?2",params![thread,target],|r|r.get(0)).optional()?;
  let empty_attachments = message["attachments"].as_array().is_none_or(|v| v.is_empty());
  let original_text=message["text"].as_str().unwrap_or("").trim();
  let goal=empty_attachments && original_text.strip_prefix("/goal").is_some_and(|s|s.is_empty()||s.starts_with(char::is_whitespace));
  let goal_arg=original_text.strip_prefix("/goal").unwrap_or("").trim().to_ascii_lowercase();
  let compact_target=target_text.as_deref().is_some_and(|s|s.trim().eq_ignore_ascii_case("/compact")) && target_run.as_ref().is_some_and(|r| !r["userMessageId"].is_null());
  let special=compact_target || goal;
  let goal_error=if goal {crate::queue_ops::goal_guard(tx,thread,&run,&message,original_text,None)?}else{None};
  let caps:Option<String>=match turn.as_ref(){Some((_,_,session,_))=>tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?1",[session],|r|r.get(0)).optional()?,None=>None};
  let caps:Value=caps.as_deref().map(serde_json::from_str).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?.unwrap_or(Value::Null);
  let selection_changed = !run["modelSelection"].is_null() && target_run.as_ref().is_some_and(|r| !r["modelSelection"].is_null() && !crate::provider_selection::selections_equal(&r["modelSelection"], &run["modelSelection"]));
  // Codex accepts model and option changes at the next turn. Other adapters and
  // instance changes require transition planning and cannot reuse this session.
  let turn_provider:Option<String> = match turn.as_ref() { Some((_,pt,_,_)) => tx.query_row("SELECT provider FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",params![pt,thread],|r|r.get(0)).optional()?, None => None };
  let same_codex_instance = selection_changed && turn_provider.as_deref()==Some("codex") && run["modelSelection"]["instanceId"].as_str().is_some() && target_run.as_ref().is_some_and(|r| r["modelSelection"]["instanceId"] == run["modelSelection"]["instanceId"]);
  let restart_required = !empty_attachments && caps["capabilities"]["turns"]["activeSteeringAcceptsAttachments"] == false || selection_changed;
  let restart = !special && (restart_required || caps["capabilities"]["turns"]["supportsActiveSteering"] == false) && caps["capabilities"]["turns"]["supportsInterrupt"] == true && caps["capabilities"]["turns"]["supportsSteeringByInterruptRestart"] == true;
  let unsupported_steer = !special && (restart_required || caps["capabilities"]["turns"]["supportsActiveSteering"] == false) && (!restart || (selection_changed && !same_codex_instance));
  let deferred=target_run.as_ref().is_some_and(|r|matches!(r["status"].as_str(),Some("preparing"|"starting"|"running"))) && turn.is_none() && !stopped;
  let error=if !active {Some(format!("Thread {thread} is not active."))} else if run.is_null(){Some(format!("Queued run {queued} is not queued."))}else if message.is_null()||attempt.is_null()||node.is_null(){Some(format!("Queued run {queued} is missing message or execution state."))}else if !message["delegatedCompletion"].is_null()||!message["notification"].is_null(){Some("Automatic completion deliveries cannot be promoted to Steer.".into())}else if let Some(e)=goal_error {Some(e)}else if !compact_target && run["freshContext"]==true {Some("A message that starts a fresh session can't steer the current turn.".into())}else if text=="/compact" {Some("Context compaction must run as a separate turn. Queue it or wait for the active turn to finish.".into())}else if text=="/logout" {Some("Signing out must run as a separate turn. Queue it or wait for the active turn to finish.".into())}else if !special && target_text.as_deref().is_some_and(|s|s.trim().eq_ignore_ascii_case("/logout")){Some("Wait for sign-out to finish before steering the thread.".into())}else if unsupported_steer {Some("The provider requires interrupt-and-restart steering, which is not supported.".into())}else if !special && stopped {Some(format!("Target run {target} is stopping and cannot be steered."))}else if !special && turn.is_none()&&!deferred{Some("The target run does not have a running provider turn.".into())}else{None};
  let mut receipt=Receipt{command_id:command.into(),aggregate_kind:"thread".into(),aggregate_id:thread.into(),command_type:"queued-message.promote-to-steer".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
  if !event_store::insert_receipt_if_absent(tx,&receipt)?{return Err(rusqlite::Error::InvalidQuery);}
  if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]));}
  let mut planned=Vec::<(&str,Value)>::new();
  if special {
   run["queuePosition"]=json!(1);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![queued,run.to_string()])?;planned.push(("run.updated",run));
   let mut stmt=tx.prepare("SELECT r.payload_json,m.payload_json FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.thread_id=r.thread_id AND m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status='queued' AND r.run_id!=?2")?;
   let rows=stmt.query_map(params![thread,queued],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
   let mut others=Vec::new();for (r,m) in rows {let r:Value=serde_json::from_str(&r).map_err(|_|rusqlite::Error::InvalidQuery)?;let m:Value=m.and_then(|v|serde_json::from_str(&v).ok()).unwrap_or(Value::Null);if m["delegatedCompletion"].is_null(){others.push(r)}}
   others.sort_by_key(|r|(r["queuePosition"].as_i64().or_else(||r["ordinal"].as_i64()).unwrap_or(i64::MAX),r["ordinal"].as_i64().unwrap_or(i64::MAX)));
   for (i,mut other) in others.into_iter().enumerate(){let position=i as i64+2;if other["queuePosition"].as_i64()!=Some(position){other["queuePosition"]=json!(position);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![other["id"].as_str(),other.to_string()])?;planned.push(("run.updated",other));}}
   let goal_status:Option<String>=tx.query_row("SELECT json_extract(pt.payload_json,'$.goal.status') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id=json_extract(r.payload_json,'$.providerThreadId') WHERE r.thread_id=?1 AND r.run_id=?2",params![thread,target],|r|r.get(0)).optional()?.flatten();
   let should_stop=compact_target || (goal && match goal_arg.as_str(){""|"edit"=>false,"pause"|"clear"=>goal_status.as_deref()==Some("active"),_=>true});
   if should_stop && !stopped {
    if let Some((turn_id,pt,session,target_node))=turn.as_ref(){
     let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0))?;let itemid=crate::interrupt_commands::signal(target,"interrupt-request");let reason=if compact_target {"Skipped compaction to send a queued message"} else {"Stopped to apply /goal"};let item=json!({"id":itemid,"threadId":thread,"runId":target,"nodeId":target_node,"providerThreadId":pt,"providerTurnId":turn_id,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Interrupt requested","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_request","message":reason});
     tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'run_interrupt_request','completed',?8,?9)",params![itemid,thread,target,target_node,pt,turn_id,ordinal,now,item.to_string()])?;planned.push(("turn-item.updated",item));
     outbox::enqueue(tx,&Effect{id:format!("effect:{command}:provider-turn.interrupt:{turn_id}"),command_id:command.into(),thread_id:thread.into(),request:json!({"type":"provider-turn.interrupt","providerSessionId":session,"providerThreadId":pt,"providerTurnId":turn_id}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
    } else if let Some(target_run) = target_run.as_ref().filter(|r| matches!(r["status"].as_str(),Some("preparing"|"starting"|"running"))) {
     // Interrupt-before-start has no live provider turn. Complete the signal,
     // attempt and node together, then cancel pending start effects.
     if let (Some(aid),Some(nid),Some(pt))=(target_run["activeAttemptId"].as_str(),target_run["rootNodeId"].as_str(),target_run["providerThreadId"].as_str()) {
      let ta=load("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 AND attempt_id=?2",aid)?;
      let tn=load("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND node_id=?2",nid)?;
      if let (Some(mut ta),Some(mut tn))=(ta,tn) {
       let mut tr=target_run.clone();let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0))?;
       let request_id=crate::interrupt_commands::signal(target,"interrupt-request");let reason=if compact_target {"Skipped compaction to send a queued message"} else {"Stopped to apply /goal"};
       let request=json!({"id":request_id,"threadId":thread,"runId":target,"nodeId":nid,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":"Interrupt requested","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_request","message":reason});
       let result=json!({"id":crate::interrupt_commands::signal(target,"interrupt-result"),"threadId":thread,"runId":target,"nodeId":nid,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"parentItemId":request_id,"ordinal":ordinal+1,"status":"interrupted","title":"Interrupted","startedAt":now,"completedAt":now,"updatedAt":now,"type":"run_interrupt_result","message":"Run interrupted before provider start"});
       for item in [&request,&result] {tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![item["id"].as_str(),thread,target,nid,pt,item["ordinal"].as_i64(),item["type"].as_str(),item["status"].as_str(),now,item.to_string()])?;}
       for v in [&mut ta,&mut tn,&mut tr] {v["status"]=json!("interrupted");v["completedAt"]=json!(now);}
       tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='interrupted',payload_json=?2 WHERE attempt_id=?1",params![aid,ta.to_string()])?;
       tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![nid,now,tn.to_string()])?;
       tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![target,now,tr.to_string()])?;
       outbox::cancel_unsettled(tx,thread,&["provider-turn.start".into(),"provider-turn.restart".into()],&format!("Run {target} was interrupted before its provider turn started."),now)?;
       planned.extend([("turn-item.updated",request),("turn-item.updated",result),("run-attempt.updated",ta),("node.updated",tn),("run.updated",tr)]);promote_after.set(true);
      }
     }
    }
   }
  }
  else if deferred {run["steerWhenReadyRunId"]=json!(target);tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![queued,run.to_string()])?;planned.push(("run.updated",run));}
  else {let (turn,pt,session,mut target_node)=turn.unwrap();let target_run=target_run.unwrap();let msgid=message["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();let aid=attempt["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();let nid=node["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
   let queued_selection=run["modelSelection"].clone();
   run["status"]=json!("cancelled");run["queuePosition"]=Value::Null;run["completedAt"]=json!(now);attempt["status"]=json!("cancelled");attempt["completedAt"]=json!(now);node["status"]=json!("cancelled");node["completedAt"]=json!(now);
   tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',payload_json=?2 WHERE run_id=?1",params![queued,run.to_string()])?;tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='cancelled',payload_json=?2 WHERE attempt_id=?1",params![aid,attempt.to_string()])?;tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',payload_json=?2 WHERE node_id=?1",params![nid,node.to_string()])?;
   planned.extend([("run.updated",run),("run-attempt.updated",attempt),("node.updated",node)]);
   if restart && selection_changed {let mut updated=target_run.clone();updated["modelSelection"]=queued_selection;tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![target,updated.to_string()])?;}
   if restart {let (new_node, restart_events)=stage_restart(tx,thread,target,&msgid,command,&pt,&turn,&session,now)?;target_node=new_node;planned.extend(restart_events);}
   message["runId"]=json!(target);message["nodeId"]=json!(target_node);message["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_messages SET run_id=?2,node_id=?3,updated_at=?4,payload_json=?5 WHERE message_id=?1",params![msgid,target,target_node,now,message.to_string()])?;
   let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[thread],|r|r.get(0))?;let itemid=format!("turn-item:message:{msgid}");let item=json!({"createdBy":message["createdBy"],"creationSource":message["creationSource"],"id":itemid,"threadId":thread,"runId":target,"nodeId":target_node,"providerThreadId":pt,"providerTurnId":if restart {Value::Null} else {json!(turn)},"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":null,"startedAt":now,"completedAt":now,"updatedAt":now,"type":"user_message","messageId":msgid,"inputIntent":"promoted_queued_to_steer","text":message["text"],"attachments":message["attachments"],"context":message["context"]});
   tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'user_message','completed',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,provider_thread_id=excluded.provider_thread_id,provider_turn_id=excluded.provider_turn_id,ordinal=excluded.ordinal,status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![itemid,thread,target,target_node,pt,if restart {None} else {Some(turn.as_str())},ordinal,now,item.to_string()])?;
   let max:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0) FROM orchestration_v2_projection_runs WHERE thread_id=?1",[thread],|r|r.get(0))?;if !restart {outbox::enqueue(tx,&Effect{id:format!("effect:{command}:provider-turn.steer:{turn}"),command_id:command.into(),thread_id:thread.into(),request:json!({"type":"provider-turn.steer","providerSessionId":session,"providerThreadId":pt,"providerTurnId":turn,"messageId":msgid,"modelSelection":target_run["modelSelection"],"steerFollowUpAfterRunOrdinal":max}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;}
   planned.extend([("message.updated",message),("turn-item.updated",item)]);
  }
  let events:Vec<Event>=planned.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command.into()),causation_event_id:None,correlation_id:Some(command.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();let stored=event_store::append(tx,&events)?;receipt.result_sequence=stored.last().ok_or(rusqlite::Error::InvalidQuery)?.sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((CommitResult{receipt,committed:true},stored))
 })?;
    if promote_after.get() && result.committed {
        crate::queue_promotion::promote(bus, thread, now)?;
    }
    Ok(result)
}

/// Replaces a live run's active attempt with a pending attempt that consumes
/// `message_id`; caller persists the message and emits its own two events.
#[allow(clippy::too_many_arguments)]
pub(crate) fn stage_restart(
    tx: &Transaction<'_>,
    thread: &str,
    run_id: &str,
    message_id: &str,
    command: &str,
    pt: &str,
    turn: &str,
    session: &str,
    now: &str,
) -> rusqlite::Result<(String, Vec<(&'static str, Value)>)> {
    let load = |sql: &str, id: &str| -> rusqlite::Result<Value> {
        let raw: String = tx.query_row(sql, params![thread, id], |r| r.get(0))?;
        serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)
    };
    let mut run=load("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status='running'",run_id)?;
    let old_a = run["activeAttemptId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let old_n = run["rootNodeId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let mut attempt=load("SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 AND attempt_id=?2",&old_a)?;
    let mut node=load("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1 AND node_id=?2",&old_n)?;
    let attempt_ord:i64=tx.query_row("SELECT COALESCE(MAX(attempt_ordinal),0)+1 FROM orchestration_v2_projection_run_attempts WHERE thread_id=?1 AND run_id=?2",params![thread,run_id],|r|r.get(0))?;
    let encode = crate::message_commands::encode_id_part;
    let new_a = format!("run-attempt:run:{}:attempt:{attempt_ord}", encode(run_id));
    let new_n = format!("node:run:{}:attempt:{attempt_ord}:root", encode(run_id));
    let scope_id = node["checkpointScopeId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let mut scope=load("SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id=?1 AND scope_id=?2",&scope_id)?;
    attempt["status"] = json!("superseded");
    attempt["completedAt"] = json!(now);
    node["status"] = json!("interrupted");
    node["completedAt"] = json!(now);
    tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='superseded',payload_json=?2 WHERE attempt_id=?1",params![old_a,attempt.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_nodes SET status='interrupted',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![old_n,now,node.to_string()])?;
    let instance = run["providerInstanceId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let driver: String = tx.query_row(
        "SELECT provider FROM orchestration_v2_projection_runs WHERE run_id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    run["activeAttemptId"] = json!(new_a);
    run["rootNodeId"] = json!(new_n);
    run["userMessageId"] = json!(message_id);
    run["status"] = json!("starting");
    let next_a = json!({"id":new_a,"runId":run_id,"attemptOrdinal":attempt_ord,"rootNodeId":new_n,"providerInstanceId":instance,"providerThreadId":pt,"providerTurnId":null,"reason":"steering_restart","status":"pending","startedAt":null,"completedAt":null});
    let next_n = json!({"id":new_n,"threadId":thread,"runId":run_id,"parentNodeId":null,"rootNodeId":new_n,"kind":"root_turn","status":"pending","countsForRun":true,"providerThreadId":pt,"providerTurnId":null,"nativeItemRef":null,"runtimeRequestId":null,"checkpointScopeId":scope_id,"startedAt":null,"completedAt":null});
    scope["nodeId"] = json!(new_n);
    scope["createdAt"] = json!(now);
    tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',payload_json=?2 WHERE run_id=?1",params![run_id,run.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,status,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9)",params![new_a,thread,run_id,attempt_ord,new_n,driver,instance,pt,next_a.to_string()])?;
    tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,provider_thread_id,checkpoint_scope_id,payload_json) VALUES(?1,?2,?3,?1,'root_turn','pending',?4,?5,?6)",params![new_n,thread,run_id,pt,scope_id,next_n.to_string()])?;
    tx.execute("UPDATE orchestration_v2_projection_checkpoint_scopes SET node_id=?2,created_at=?3,payload_json=?4 WHERE scope_id=?1",params![scope_id,new_n,now,scope.to_string()])?;
    outbox::enqueue(
        tx,
        &Effect {
            id: format!("effect:{command}:provider-turn.restart:{turn}"),
            command_id: command.into(),
            thread_id: thread.into(),
            request: json!({"type":"provider-turn.restart","providerSessionId":session,"providerThreadId":pt,"providerTurnId":turn,"interruptedAttemptId":old_a,"runId":run_id}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: now.into(),
            lease_owner: None,
            created_at: now.into(),
            updated_at: now.into(),
            completed_at: None,
            last_error: None,
        },
    )?;
    Ok((
        new_n,
        vec![
            ("run-attempt.updated", attempt),
            ("node.updated", node),
            ("run.updated", run),
            ("run-attempt.created", next_a),
            ("node.updated", next_n),
            ("checkpoint-scope.created", scope),
        ],
    ))
}

/// Deliver deferred steers through the same policy and atomic promotion path as
/// an explicit queued promotion. Each run gets an attempt-specific receipt.
pub fn deliver_deferred(
    bus: &EventBus,
    thread: &str,
    attempt: &str,
    now: &str,
) -> Result<(), BusError> {
    let work=bus.commit(|tx|{
  let target:Option<String>=tx.query_row("SELECT r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.thread_id=?1 AND r.status='running' AND p.run_attempt_id=?2 AND p.status='running' AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='run_interrupt_request')",params![thread,attempt],|r|r.get(0)).optional()?;
  let Some(target)=target else{return Ok((None,vec![]))};
  let mut stmt=tx.prepare("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='queued' AND json_extract(payload_json,'$.steerWhenReadyRunId')=?2 ORDER BY COALESCE(json_extract(payload_json,'$.queuePosition'),ordinal),ordinal")?;
  let ids=stmt.query_map(params![thread,target],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok((Some((target,ids)),vec![]))
 })?;
    if let Some((target, ids)) = work {
        for id in ids {
            let command = format!("command:deferred-steer:{id}:{target}:{attempt}");
            match dispatch(bus, &command, thread, &id, &target, now) {
                Ok(result) if result.receipt.status == "rejected" => eprintln!(
                    "Failed to deliver deferred steering: {}",
                    result.receipt.error.unwrap_or_default()
                ),
                Err(e) => eprintln!("Failed to deliver deferred steering: {e}"),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(ready: bool) -> EventBus {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')",[]).unwrap();
        let q = json!({"id":"q","status":"queued","userMessageId":"m","activeAttemptId":"qa","rootNodeId":"qn","queuePosition":1});
        let target =
            json!({"id":"r","status":"running","activeAttemptId":"ra","modelSelection":{}});
        let message = json!({"id":"m","text":"hello","attachments":[]});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('q','t',2,'codex','queued','now',?1)",[q.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','running','now',?1)",[target.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'now','now',?1)",[message.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('qa','t','q',1,'qn','codex','pt','pending',?1)",[json!({"id":"qa"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('qn','t','q','qn','root_turn','pending',?1)",[json!({"id":"qn"}).to_string()]).unwrap();
        if ready {
            db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES('pt','t','codex','session','running','now','{}')",[]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','t','pt','rn','ra',1,'running','{}')",[]).unwrap();
        }
        EventBus::new(db, 16)
    }
    #[test]
    fn promotes_immediately_and_replays() {
        let bus = setup(true);
        let result = dispatch(&bus, "cmd", "t", "q", "r", "now").unwrap();
        assert!(result.committed);
        assert!(
            !dispatch(&bus, "cmd", "t", "q", "r", "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx|{let (status,run):(String,String)=tx.query_row("SELECT status,run_id FROM orchestration_v2_projection_runs WHERE run_id='q'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"cancelled");assert_eq!(run,"q");let actual:String=tx.query_row("SELECT run_id FROM orchestration_v2_projection_messages WHERE message_id='m'",[],|r|r.get(0))?;assert_eq!(actual,"r");let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.steer'",[],|r|r.get(0))?;assert_eq!(count,1);Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn defers_and_rejects_automatic_messages() {
        let bus = setup(false);
        assert!(dispatch(&bus, "c", "t", "q", "r", "now").unwrap().committed);
        bus.commit(|tx|{let target:String=tx.query_row("SELECT json_extract(payload_json,'$.steerWhenReadyRunId') FROM orchestration_v2_projection_runs WHERE run_id='q'",[],|r|r.get(0))?;assert_eq!(target,"r");tx.execute("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.notification',json('{}')) WHERE message_id='m'",[])?;Ok(((),vec![]))}).unwrap();
        let result = dispatch(&bus, "c2", "t", "q", "r", "now").unwrap();
        assert_eq!(
            result.receipt.error.as_deref(),
            Some("Automatic completion deliveries cannot be promoted to Steer.")
        );
    }
    #[test]
    fn goal_show_waits_and_compaction_skip_interrupts() {
        let bus = setup(true);
        bus.commit(|tx| { tx.execute("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','/goal') WHERE message_id='m'",[])?; Ok(((),vec![])) }).unwrap();
        assert!(
            dispatch(&bus, "goal", "t", "q", "r", "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx| { let (status,position):(String,i64)=tx.query_row("SELECT status,json_extract(payload_json,'$.queuePosition') FROM orchestration_v2_projection_runs WHERE run_id='q'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!((status.as_str(),position),("queued",1));let n:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.interrupt'",[],|r|r.get(0))?;assert_eq!(n,0); Ok(((),vec![])) }).unwrap();
        let bus = setup(true);
        bus.commit(|tx| {tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('target-message','t','user',0,'now','now',?1)",[json!({"id":"target-message","text":"/compact"}).to_string()])?;tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.userMessageId','target-message') WHERE run_id='r'",[])?;Ok(((),vec![]))}).unwrap();
        assert!(
            dispatch(&bus, "compact", "t", "q", "r", "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {let (status,position):(String,i64)=tx.query_row("SELECT status,json_extract(payload_json,'$.queuePosition') FROM orchestration_v2_projection_runs WHERE run_id='q'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!((status.as_str(),position),("queued",1));let n:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.interrupt'",[],|r|r.get(0))?;assert_eq!(n,1);let reason:String=tx.query_row("SELECT json_extract(payload_json,'$.message') FROM orchestration_v2_projection_turn_items WHERE type='run_interrupt_request'",[],|r|r.get(0))?;assert_eq!(reason,"Skipped compaction to send a queued message");Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn goal_interrupts_before_provider_start_atomically() {
        let bus = setup(false);
        bus.commit(|tx| {
          tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',payload_json=json_set(payload_json,'$.status','starting','$.activeAttemptId','ra','$.rootNodeId','rn','$.providerThreadId','pt') WHERE run_id='r'",[])?;
          tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.queueHeld',json('true')) WHERE run_id='q'",[])?;
          tx.execute("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','/goal do work') WHERE message_id='m'",[])?;
          tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('ra','t','r',1,'rn','codex','pt','pending',?1)",[json!({"id":"ra","status":"pending"}).to_string()])?;
          tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('rn','t','r','rn','root_turn','pending',?1)",[json!({"id":"rn","status":"pending"}).to_string()])?;
          outbox::enqueue(tx,&Effect{id:"start".into(),command_id:"previous".into(),thread_id:"t".into(),request:json!({"type":"provider-turn.start","runId":"r"}),status:"pending".into(),attempt_count:0,available_at:"now".into(),lease_owner:None,created_at:"now".into(),updated_at:"now".into(),completed_at:None,last_error:None})?;
          Ok(((),vec![]))
        }).unwrap();
        assert!(
            dispatch(&bus, "goal-start", "t", "q", "r", "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(status,"interrupted");let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE run_id='r' AND type IN ('run_interrupt_request','run_interrupt_result')",[],|r|r.get(0))?;assert_eq!(count,2);let status:String=tx.query_row("SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id='start'",[],|r|r.get(0))?;assert_eq!(status,"cancelled");Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn queued_promotion_restarts_when_provider_requires_it() {
        let bus = setup(true);
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.rootNodeId','rn','$.providerThreadId','pt','$.providerInstanceId','codex') WHERE run_id='r'",[])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection',json(?2)) WHERE run_id=?1",params!["r",json!({"instanceId":"codex","model":"old"}).to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection',json(?2)) WHERE run_id=?1",params!["q",json!({"instanceId":"codex","model":"new"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('ra','t','r',1,'rn','codex','pt','running',?1)",[json!({"id":"ra","status":"running"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,provider_thread_id,checkpoint_scope_id,payload_json) VALUES('rn','t','r','rn','root_turn','running','pt','scope',?1)",[json!({"id":"rn","status":"running","checkpointScopeId":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,run_id,node_id,provider_thread_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES('scope','t','r','rn','pt','root_run',0,1,'now',?1)",[json!({"id":"scope","nodeId":"rn"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('session','t','codex','ready','now',?1)",[json!({"capabilities":{"turns":{"supportsActiveSteering":false,"supportsInterrupt":true,"supportsSteeringByInterruptRestart":true}}}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        assert!(
            dispatch(&bus, "restart", "t", "q", "r", "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {let (status,attempt,message):(String,String,String)=tx.query_row("SELECT status,json_extract(payload_json,'$.activeAttemptId'),json_extract(payload_json,'$.userMessageId') FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;assert_eq!(status,"starting");assert_ne!(attempt,"ra");assert_eq!(message,"m");let model:String=tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(model,"new");let old:String=tx.query_row("SELECT status FROM orchestration_v2_projection_run_attempts WHERE attempt_id='ra'",[],|r|r.get(0))?;assert_eq!(old,"superseded");let effect:String=tx.query_row("SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id='restart'",[],|r|r.get(0))?;assert_eq!(effect,"provider-turn.restart");Ok(((),vec![]))}).unwrap();
        bus.commit(|tx| {
            let (attempt, node, payload): (String, String, String) = tx.query_row("SELECT attempt_id,root_node_id,payload_json FROM orchestration_v2_projection_run_attempts WHERE run_id='r' AND attempt_ordinal=2", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            assert_eq!(attempt, "run-attempt:run:r:attempt:2");
            assert_eq!(node, "node:run:r:attempt:2:root");
            assert!(serde_json::from_str::<Value>(&payload).unwrap().get("threadId").is_none());
            Ok(((), vec![]))
        }).unwrap();
    }
    #[test]
    fn selection_change_to_another_instance_is_not_restarted_in_old_session() {
        let bus = setup(true);
        bus.commit(|tx| {
            for (id, instance) in [("r", "codex"), ("q", "other")] {
                tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection',json(?2)) WHERE run_id=?1", params![id, json!({"instanceId":instance,"model":"m"}).to_string()])?;
            }
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('session','t','codex','ready','now',?1)", [json!({"capabilities":{"turns":{"supportsInterrupt":true,"supportsSteeringByInterruptRestart":true}}}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let result = dispatch(&bus, "change-instance", "t", "q", "r", "now").unwrap();
        assert_eq!(result.receipt.status, "rejected");
        bus.commit(|tx| {
            let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='q'", [], |r| r.get(0))?;
            assert_eq!(status, "queued");
            let effects:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE command_id='change-instance'", [], |r| r.get(0))?;
            assert_eq!(effects, 0);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn deferred_restart_only_provider_processes_one_per_attempt() {
        let bus = setup(true);
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.rootNodeId','rn','$.providerThreadId','pt','$.providerInstanceId','codex') WHERE run_id='r'",[])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.steerWhenReadyRunId','r') WHERE run_id='q'",[])?;
            let q2=json!({"id":"q2","status":"queued","userMessageId":"m2","activeAttemptId":"qa2","rootNodeId":"qn2","queuePosition":2,"steerWhenReadyRunId":"r"});
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('q2','t',3,'codex','queued','now',?1)",[q2.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m2','t','user',0,'now','now',?1)",[json!({"id":"m2","text":"second","attachments":[]}).to_string()])?;
            for (aid,rid,nid) in [("ra","r","rn"),("qa2","q2","qn2")] {tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES(?1,'t',?2,1,?3,'codex','pt','pending',?4)",params![aid,rid,nid,json!({"id":aid}).to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,checkpoint_scope_id,payload_json) VALUES(?1,'t',?2,?1,'root_turn','pending',?3,?4)",params![nid,rid,if rid=="r" {Some("scope")} else {None},json!({"id":nid,"checkpointScopeId":if rid=="r" {Some("scope")} else {None}}).to_string()])?;}
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,run_id,node_id,provider_thread_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES('scope','t','r','rn','pt','root_run',0,1,'now',?1)",[json!({"id":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('session','t','codex','ready','now',?1)",[json!({"capabilities":{"turns":{"supportsActiveSteering":false,"supportsInterrupt":true,"supportsSteeringByInterruptRestart":true}}}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        deliver_deferred(&bus, "t", "ra", "now").unwrap();
        bus.commit(|tx| {let (first,second):(String,String)=tx.query_row("SELECT (SELECT status FROM orchestration_v2_projection_runs WHERE run_id='q'),(SELECT status FROM orchestration_v2_projection_runs WHERE run_id='q2')",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!((first.as_str(),second.as_str()),("cancelled","queued"));let marker:String=tx.query_row("SELECT json_extract(payload_json,'$.steerWhenReadyRunId') FROM orchestration_v2_projection_runs WHERE run_id='q2'",[],|r|r.get(0))?;assert_eq!(marker,"r");let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.restart'",[],|r|r.get(0))?;assert_eq!(count,1);Ok(((),vec![]))}).unwrap();
        let next=bus.commit(|tx|{let (attempt,node):(String,String)=tx.query_row("SELECT json_extract(payload_json,'$.activeAttemptId'),json_extract(payload_json,'$.rootNodeId') FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running') WHERE run_id='r'",[])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn2','t','pt',?1,?2,2,'running','{}')",params![node,attempt])?;Ok((attempt,vec![]))}).unwrap();
        deliver_deferred(&bus, "t", &next, "later").unwrap();
        bus.commit(|tx|{let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='q2'",[],|r|r.get(0))?;assert_eq!(status,"cancelled");let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.restart'",[],|r|r.get(0))?;assert_eq!(count,2);Ok(((),vec![]))}).unwrap();
    }
    #[test]
    fn direct_steer_restarts_when_required_by_session() {
        use crate::message_commands::{steer_selected, DispatchMessage};
        let bus = setup(true);
        bus.commit(|tx|{
            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.rootNodeId','rn','$.providerThreadId','pt','$.providerInstanceId','codex','$.modelSelection.instanceId','codex','$.modelSelection.model','old') WHERE run_id='r'",[])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('ra','t','r',1,'rn','codex','pt','running',?1)",[json!({"id":"ra"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,checkpoint_scope_id,payload_json) VALUES('rn','t','r','rn','root_turn','running','scope',?1)",[json!({"id":"rn","checkpointScopeId":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,run_id,node_id,provider_thread_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES('scope','t','r','rn','pt','root_run',0,1,'now',?1)",[json!({"id":"scope"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('session','t','codex','ready','now',?1)",[json!({"capabilities":{"turns":{"supportsActiveSteering":false,"supportsInterrupt":true,"supportsSteeringByInterruptRestart":true}}}).to_string()])?;Ok(((),vec![]))
        }).unwrap();
        let cmd = DispatchMessage {
            context: None,
            command_id: "direct",
            thread_id: "t",
            message_id: "direct-message",
            text: "hello",
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        assert!(
            steer_selected(
                &bus,
                cmd,
                "r",
                "now",
                &json!({"instanceId":"codex","model":"new"}),
                true
            )
            .unwrap()
            .committed
        );
        bus.commit(|tx| {
            let mut stmt = tx.prepare("SELECT event_type FROM orchestration_events WHERE command_id='direct' ORDER BY sequence")?;
            let events = stmt.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            assert_eq!(&events[..4], ["run-attempt.updated", "node.updated", "thread.model-selection-updated", "run.updated"]);
            Ok(((), vec![]))
        }).unwrap();
        bus.commit(|tx|{let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(status,"starting");let effect:String=tx.query_row("SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id='direct'",[],|r|r.get(0))?;assert_eq!(effect,"provider-turn.restart");let turn:Option<String>=tx.query_row("SELECT provider_turn_id FROM orchestration_v2_projection_turn_items WHERE turn_item_id='turn-item:message:direct-message'",[],|r|r.get(0))?;assert!(turn.is_none());Ok(((),vec![]))}).unwrap();
    }
}
