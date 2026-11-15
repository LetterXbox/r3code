//! Select and dispatch a durable continuation after provider process loss.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    message_commands::{self, DispatchMessage},
    outbox::{self, Effect},
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub(crate) fn enabled(settings: &Value, project: &str) -> bool {
    settings["projectSettingsOverrides"][project]["continueThreadsAfterServerUpdate"]
        .as_bool()
        .or_else(|| settings["continueThreadsAfterServerUpdate"].as_bool())
        .unwrap_or(true)
}

/// Inspect the pre-recovery state, before sessions and runs are terminalized.
pub(crate) fn select(
    tx: &Transaction<'_>,
    thread_id: &str,
    settings: &Value,
) -> rusqlite::Result<Option<String>> {
    let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL",[thread_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if !enabled(settings, thread["projectId"].as_str().unwrap_or(""))
        || thread["settledOverride"] == "settled"
        || thread["snoozedUntil"]
            .as_str()
            .is_some_and(|s| s > chrono::Utc::now().to_rfc3339().as_str())
    {
        return Ok(None);
    }
    let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status!='queued' AND ((json_type(payload_json,'$.startedAt') IS NOT NULL AND json_type(payload_json,'$.startedAt')!='null') OR json_type(payload_json,'$.restartContinuationOfRunId') IS NOT NULL) ORDER BY (completed_at IS NULL) DESC,completed_at DESC,ordinal DESC LIMIT 1",[thread_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let run: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let running = run["status"] == "running";
    let prepared = run["status"] == "starting" && run.get("restartContinuationOfRunId").is_some();
    let settled = run["status"] == "completed" || run["status"] == "waiting";
    if (!running && !prepared && !settled)
        || (run["startedAt"].is_null() && !prepared)
        || run["providerInstanceId"] != thread["providerInstanceId"]
    {
        return Ok(None);
    }
    let run_id = run["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
    let eligible:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id WHERE p.provider_thread_id=?1 AND p.thread_id=?2 AND p.owner_node_id IS NULL AND p.status NOT IN ('closed','archived') AND (?3=0 OR p.status='active') AND (?4=1 OR s.status NOT IN ('stopped','error')) AND json_extract(p.payload_json,'$.nativeThreadRef.strength')='strong' AND json_extract(p.payload_json,'$.nativeThreadRef.nativeId') IS NOT NULL AND json_extract(p.payload_json,'$.nativeThreadRef.driver')=json_extract(p.payload_json,'$.driver') AND json_extract(s.payload_json,'$.providerInstanceId')=json_extract(p.payload_json,'$.providerInstanceId') AND json_extract(s.payload_json,'$.driver')=json_extract(p.payload_json,'$.driver'))",params![run["providerThreadId"].as_str(),thread_id,running,prepared],|r|r.get(0))?;
    let live_turn:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1 AND run_attempt_id=?2 AND status='running')",params![run["providerThreadId"].as_str(),run["activeAttemptId"].as_str()],|r|r.get(0))?;
    let awaited:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND i.status IN ('pending','running','waiting') AND i.type IN ('subagent','dynamic_tool','command_execution') AND COALESCE(i.provider_thread_id,r.provider_thread_id)=?2 AND NOT (i.type='subagent' AND COALESCE(json_extract(i.payload_json,'$.origin'),'')='app_owned' AND json_extract(i.payload_json,'$.childThreadId') IS NOT NULL) AND (i.type='subagent' OR (i.type='dynamic_tool' AND COALESCE(json_extract(i.payload_json,'$.input.persistent'),0)!=1) OR (i.type='command_execution' AND json_extract(i.payload_json,'$.completionWake')='always'))) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p,json_each(p.payload_json,'$.pendingBackgroundTasks') task WHERE p.provider_thread_id=?2 AND (json_extract(task.value,'$.kind') IN ('subagent','background_task') OR json_extract(task.value,'$.parentTaskId') IS NOT NULL))",params![thread_id,run["providerThreadId"].as_str()],|r|r.get(0))?;
    if (running && !live_turn) || (settled && !awaited) {
        return Ok(None);
    }
    if prepared {
        let terminal:bool=tx.query_row("SELECT COALESCE((SELECT status IN ('completed','failed','interrupted') FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY rowid DESC LIMIT 1),0)",[run["activeAttemptId"].as_str()],|r|r.get(0))?;
        if terminal {
            return Ok(None);
        }
    }
    let blocking:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' AND kind NOT IN ('dynamic_tool_call','auth_refresh') AND COALESCE(json_extract(payload_json,'$.responseCapability.type'),'')!='message') OR EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE run_id=?2 AND type IN ('run_interrupt_request','secret_request') AND (type='run_interrupt_request' OR json_extract(payload_json,'$.secretStatus')='pending'))",params![thread_id,run_id],|r|r.get(0))?;
    if eligible && !blocking {
        Ok(Some(run_id.into()))
    } else {
        Ok(None)
    }
}

fn compact_label(text: &str, limit: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= limit {
        normalized
    } else {
        format!(
            "{}…",
            normalized
                .chars()
                .take(limit.saturating_sub(1))
                .collect::<String>()
        )
    }
}
fn with_suffix(name: &str, fallback: &str, suffix: &str) -> String {
    let budget = 160usize.saturating_sub(suffix.chars().count());
    if budget < 2 {
        return compact_label(&format!("{fallback}{suffix}"), 160);
    }
    let label = compact_label(name, budget);
    format!(
        "{}{suffix}",
        if label.is_empty() {
            compact_label(fallback, budget)
        } else {
            label
        }
    )
}

pub(crate) fn cancelled_work(
    tx: &Transaction<'_>,
    thread: &str,
    run_id: &str,
) -> rusqlite::Result<Vec<Value>> {
    let mut work = Vec::<Value>::new();
    let mut native_ids = std::collections::HashSet::<String>::new();
    let mut stmt=tx.prepare("SELECT i.payload_json FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND i.status IN ('pending','running','waiting') AND i.type IN ('command_execution','dynamic_tool','subagent') AND r.provider_thread_id=(SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE run_id=?2) AND NOT (i.type='subagent' AND COALESCE(json_extract(i.payload_json,'$.origin'),'')='app_owned') AND (i.run_id!=?2 OR (SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?2)!='running' OR (i.type='subagent' AND json_extract(i.payload_json,'$.origin')='provider_native')) ORDER BY i.ordinal")?;
    let items = stmt
        .query_map(params![thread, run_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for raw in items {
        let item: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(id) = item["nativeItemRef"]["nativeId"].as_str() {
            native_ids.insert(id.to_owned());
        }
        let kind = match item["type"].as_str() {
            Some("subagent") => "subagent",
            Some("command_execution") if item["monitor"] == true => "monitor",
            Some("command_execution") => "shell",
            Some("dynamic_tool") if item["input"]["persistent"] == true => "monitor",
            _ => "task",
        };
        let label = match kind {
            "subagent" => {
                let title = item["title"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| item["prompt"].as_str())
                    .unwrap_or("subagent");
                let suffix = item["nativeItemRef"]["nativeId"]
                    .as_str()
                    .map(|id| format!(" (id {id})"))
                    .unwrap_or_default();
                with_suffix(title, "subagent", &suffix)
            }
            "shell" | "monitor" if item["type"] == "command_execution" => compact_label(
                item["input"]
                    .as_str()
                    .or_else(|| item["title"].as_str())
                    .unwrap_or("background command"),
                160,
            ),
            _ => compact_label(
                item["title"]
                    .as_str()
                    .or_else(|| item["toolName"].as_str())
                    .unwrap_or("background tool"),
                160,
            ),
        };
        let mut entry = json!({"kind":kind,"label":label,"id":item["id"]});
        if item["completionWake"] == "always" {
            entry["awaited"] = json!(true);
        }
        work.push(entry);
    }
    let raw:Option<String>=tx.query_row("SELECT p.payload_json FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_runs r ON r.provider_thread_id=p.provider_thread_id WHERE r.run_id=?1",[run_id],|r|r.get(0)).optional()?;
    if let Some(raw) = raw {
        let p: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        for task in p["pendingBackgroundTasks"].as_array().into_iter().flatten() {
            let kind = match task["kind"].as_str() {
                Some("command") => "shell",
                Some("monitor") => "monitor",
                Some("subagent") => "subagent",
                _ => "task",
            };
            let id = task["parentTaskId"]
                .as_str()
                .or_else(|| task["taskId"].as_str())
                .unwrap_or("");
            if native_ids.contains(id)
                || task["taskId"]
                    .as_str()
                    .is_some_and(|id| native_ids.contains(id))
            {
                continue;
            }
            if let Some(task_id) = task["taskId"].as_str() {
                native_ids.insert(task_id.to_owned());
            }
            let description = task["description"]
                .as_str()
                .filter(|s| !s.trim().is_empty());
            let label = if task["parentTaskId"].is_string() {
                with_suffix(
                    description.unwrap_or("background task"),
                    "background task",
                    &format!(" (subagent {id})"),
                )
            } else if let Some(description) = description {
                compact_label(&format!("{description} (id {id})"), 160)
            } else {
                compact_label(id, 160)
            };
            let mut entry = json!({"kind":if task["parentTaskId"].is_string(){"subagent"}else{kind},"label":label,"id":id});
            if task["awaited"] == true {
                entry["awaited"] = json!(true)
            }
            work.push(entry);
        }
    }
    Ok(work)
}

pub(crate) fn execute(
    bus: &EventBus,
    effect: &Effect,
    settings: &Value,
    now: &str,
) -> Result<(), String> {
    let source = effect.request["sourceRunId"]
        .as_str()
        .ok_or("Missing source run")?;
    bus.commit_with(|tx|->Result<_,message_commands::DispatchError>{
        let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2",params![source,effect.thread_id],|r|r.get(0)).optional()?;
        let Some(raw)=raw else{return Ok(((),vec![]))};let run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL",[&effect.thread_id],|r|r.get(0))?;let thread:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if !enabled(settings,thread["projectId"].as_str().unwrap_or("")) || thread["providerInstanceId"]!=run["providerInstanceId"] || thread["settledOverride"]=="settled" || thread["snoozedUntil"].as_str().is_some_and(|value|value>now) || !matches!(run["status"].as_str(),Some("cancelled"|"starting"|"completed"|"waiting")) {return Ok(((),vec![]))}
        let unsafe_to_continue:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND (type='run_interrupt_request' OR (type='secret_request' AND json_extract(payload_json,'$.secretStatus') IN ('pending','cancelled')))) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?2 AND kind NOT IN ('dynamic_tool_call','auth_refresh') AND ((status='pending' AND COALESCE(json_extract(payload_json,'$.responseCapability.type'),'')!='message') OR (status IN ('expired','cancelled') AND json_extract(payload_json,'$.responseCapability.type')='not_resumable' AND provider_turn_id IN (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?3))))",params![source,effect.thread_id,run["activeAttemptId"].as_str()],|r|r.get(0))?;
        if unsafe_to_continue{return Ok(((),vec![]))}
        let maintenance:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id=?1 AND lower(trim(COALESCE(json_extract(payload_json,'$.text'),''))) IN ('/compact','/logout') AND COALESCE(json_array_length(json_extract(payload_json,'$.attachments')),0)=0)",[run["userMessageId"].as_str()],|r|r.get(0))?;if maintenance{return Ok(((),vec![]))}
        if thread["lineage"]["relationshipToParent"]=="subagent" {
            let parent=thread["lineage"]["parentThreadId"].as_str();let task=run["delegatedTaskId"].as_str().or_else(||thread["forkedFrom"]["nodeId"].as_str());
            if let (Some(parent),Some(task))=(parent,task) {let stopped:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents a JOIN orchestration_v2_projection_turn_items i ON i.run_id=a.run_id AND i.type='run_interrupt_request' WHERE a.thread_id=?1 AND a.subagent_id=?2 AND a.status IN ('pending','running','waiting') AND json_type(a.payload_json,'$.result')='null')",params![parent,task],|r|r.get(0))?;if stopped{return Ok(((),vec![]))}}
        }
        let mut ancestor=run.clone();let mut chain=0;
        let limit=run["completedAt"].as_str().or_else(||run["requestedAt"].as_str()).and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).map(|t|t-chrono::Duration::minutes(5));
        while let Some(previous)=ancestor["restartContinuationOfRunId"].as_str() {
            if let (Some(limit),Some(at))=(limit,ancestor["requestedAt"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok())) {if at<limit{break}}
            chain+=1;if chain>=3{return Ok(((),vec![]))} let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1",[previous],|r|r.get(0)).optional()?;let Some(raw)=raw else{break};ancestor=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        }
        let blocked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting')) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id!=?2 AND status!='queued' AND NOT (status='cancelled' AND json_type(payload_json,'$.startedAt')='null' AND json_type(payload_json,'$.restartContinuationOfRunId') IS NULL) AND (completed_at IS NULL OR completed_at>?3 OR (completed_at=?3 AND ordinal>?4)))",params![effect.thread_id,source,run["completedAt"].as_str().unwrap_or(now),run["ordinal"].as_i64()],|r|r.get(0))?;if blocked{return Ok(((),vec![]))}
        let message=format!("message:restart-continuation:{source}");let command=format!("command:restart-continuation:{source}");
        let prompt="Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";
        let work=run["restartCancelledBackgroundWork"].as_array().cloned().unwrap_or_default();
        let note=if work.is_empty(){None}else{let mut lines=vec!["Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back on its own, so resume or restart what you still need and wait for its result:".to_owned()];for item in work.iter().take(10){lines.push(format!("- {}: {}",item["kind"].as_str().unwrap_or("task"),item["label"].as_str().unwrap_or("background task")));}if work.len()>10{lines.push(format!("- and {} more",work.len()-10));}Some(lines.join("\n"))};
        let settled=run["status"]=="completed" || run["status"]=="waiting";
        let text=match note {Some(note) if settled=>note,Some(note)=>format!("{note}\n\n{prompt}"),None=>prompt.to_owned()};
        let notification=json!({"source":{"kind":"system"},"outcome":"updated","summary":if settled {"T3 Code restarted and stopped background work"}else{"T3 Code restarted and resumed this turn"},"detail":text});
        let driver:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.driver') FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0)).optional()?.flatten();let Some(driver)=driver else{return Ok(((),vec![]))};
        let cwd=thread["worktreePath"].as_str().map(str::to_owned).or_else(||tx.query_row("SELECT workspace_root FROM projection_projects WHERE project_id=?1",[thread["projectId"].as_str()],|r|r.get(0)).optional().ok().flatten()).unwrap_or_default();
        // The continuation runs before held queue entries. The temporary status is transaction-local.
        tx.execute("UPDATE orchestration_v2_projection_runs SET status='recovery-held' WHERE thread_id=?1 AND status='queued' AND json_extract(payload_json,'$.queueHeld')=1",[&effect.thread_id])?;
        let cmd=DispatchMessage{context:None,command_id:&command,thread_id:&effect.thread_id,message_id:&message,text:&text,attachments:&[],creation_source:"server",cwd:&cwd,driver:&driver};
        let (result,mut events)=message_commands::dispatch_provider_wake_tx(tx,cmd,now,&notification)?;
        tx.execute("UPDATE orchestration_v2_projection_runs SET status='queued' WHERE thread_id=?1 AND status='recovery-held'",[&effect.thread_id])?;
        if !result.committed || result.receipt.status!="accepted" {return Ok(((),events))}
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND json_extract(payload_json,'$.userMessageId')=?2",params![effect.thread_id,message],|r|r.get(0))?;let mut next:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;next["restartContinuationOfRunId"]=json!(source);let run_id=next["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?2 WHERE run_id=?1",params![run_id,next.to_string()])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:effect.thread_id.clone(),event_type:"run.updated".into(),occurred_at:now.into(),command_id:Some(command.clone()),causation_event_id:None,correlation_id:Some(command.clone()),actor_kind:"system".into(),payload:next,metadata:json!({})};events.extend(event_store::append(tx,&[event])?);
        outbox::enqueue(tx,&Effect{id:format!("effect:{command}:provider-turn.start:{run_id}"),command_id:command,thread_id:effect.thread_id.clone(),request:json!({"type":"provider-turn.start","runId":run_id}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
        Ok(((),events))
    }).map_err(|e|format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider::{codex_events::RootTurn, lifecycle},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn running_session_selects_and_continues_before_held_queue() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let source = json!("web");
        let at = "2026-01-01T00:00:00Z";
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
            at,
        )
        .unwrap();
        for (command, message) in [("one", "m1"), ("two", "m2")] {
            message_commands::dispatch_first_message(
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
                at,
            )
            .unwrap();
        }
        let (run,mut pt)=bus.with_autocommit(|db|{let raw:String=db.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE ordinal=1",[],|r|r.get(0)).unwrap();let run:Value=serde_json::from_str(&raw).unwrap();let raw:String=db.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0)).unwrap();(run,serde_json::from_str::<Value>(&raw).unwrap())}).unwrap();
        pt["nativeThreadRef"] = json!({"driver":"codex","nativeId":"native","strength":"strong"});
        let turn = RootTurn {
            driver: "codex".into(),
            native_thread_id: "native".into(),
            native_turn_id: "native-turn".into(),
            provider_thread_id: run["providerThreadId"].as_str().unwrap().into(),
            provider_turn_id: "turn".into(),
            thread_id: "t".into(),
            run_id: run["id"].as_str().map(str::to_owned),
            run_attempt_id: run["activeAttemptId"].as_str().unwrap().into(),
            root_node_id: run["rootNodeId"].as_str().unwrap().into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: at.into(),
        };
        lifecycle::start(&bus, &turn, pt, &run, Some("/tmp"), json!({})).unwrap();
        let settings = json!({"continueThreadsAfterServerUpdate":true});
        bus.commit(|tx|{
            let id=turn.run_id.as_deref().unwrap();let provider=&turn.provider_thread_id;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',completed_at='2025-01-01T00:00:00Z',payload_json=json_set(payload_json,'$.status','completed','$.startedAt','2025-01-01T00:00:00Z','$.completedAt','2025-01-01T00:00:00Z') WHERE ordinal=2",[])?;
            assert_eq!(select(tx,"t",&settings)?.as_deref(),Some(id));
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',completed_at=NULL,payload_json=json_set(payload_json,'$.status','starting','$.startedAt',NULL,'$.completedAt',NULL) WHERE ordinal=2",[])?;
            assert_eq!(select(tx,"t",&settings)?.as_deref(),Some(id));
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='queued',payload_json=json_set(payload_json,'$.status','queued') WHERE ordinal=2",[])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed','$.completedAt',?2) WHERE run_id=?1",params![id,at])?;
            tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='idle',payload_json=json_set(payload_json,'$.status','idle','$.pendingBackgroundTasks',json(?2)) WHERE provider_thread_id=?1",params![provider,json!([{"kind":"subagent","id":"agent"}]).to_string()])?;
            assert_eq!(select(tx,"t",&settings)?.as_deref(),Some(id));
            tx.execute("UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.pendingBackgroundTasks',json('[]')) WHERE provider_thread_id=?1",[provider])?;
            assert!(select(tx,"t",&settings)?.is_none());
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='starting',payload_json=json_set(payload_json,'$.status','starting','$.startedAt',NULL,'$.restartContinuationOfRunId','earlier') WHERE run_id=?1",[id])?;
            tx.execute("UPDATE orchestration_v2_projection_provider_sessions SET status='stopped' WHERE thread_id='t'",[])?;
            assert_eq!(select(tx,"t",&settings)?.as_deref(),Some(id));
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_remove(json_set(payload_json,'$.status','running','$.startedAt',?2),'$.restartContinuationOfRunId') WHERE run_id=?1",params![id,at])?;
            tx.execute("UPDATE orchestration_v2_projection_provider_threads SET status='active',payload_json=json_set(payload_json,'$.status','active','$.pendingBackgroundTasks',json(?2)) WHERE provider_thread_id=?1",params![provider,json!([{"kind":"subagent","taskId":"task1","description":"Review work"}]).to_string()])?;
            let agent=json!({"id":"agent-item","threadId":"t","runId":id,"nodeId":null,"providerThreadId":provider,"type":"subagent","origin":"provider_native","title":"Review work","status":"running","nativeItemRef":{"nativeId":"task1"}});
            let foreground=json!({"id":"command-item","threadId":"t","runId":id,"nodeId":null,"providerThreadId":provider,"type":"command_execution","input":"foreground command","status":"running"});
            for (item,kind,ordinal) in [(&agent,"subagent",1),(&foreground,"command_execution",2)] {tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t',?2,NULL,?3,?4,?5,'running',?6,?7)",params![item["id"].as_str(),id,provider,ordinal,kind,at,item.to_string()])?;}
            tx.execute("UPDATE orchestration_v2_projection_provider_sessions SET status='ready' WHERE thread_id='t'",[])?;
            Ok(((),vec![]))
        }).unwrap();
        crate::runtime_recovery::recover_with_settings(&bus, "2026-01-01T00:00:01Z", &settings)
            .unwrap();
        let effect=bus.with_autocommit(|db|{let raw:String=db.query_row("SELECT payload_json FROM orchestration_v2_effect_outbox WHERE effect_type='provider-runtime.continue'",[],|r|r.get(0)).unwrap();Effect{id:"effect".into(),command_id:"recover".into(),thread_id:"t".into(),request:serde_json::from_str(&raw).unwrap(),status:"running".into(),attempt_count:1,available_at:at.into(),lease_owner:None,created_at:at.into(),updated_at:at.into(),completed_at:None,last_error:None}}).unwrap();
        execute(&bus, &effect, &settings, "2026-01-01T00:00:02Z").unwrap();
        execute(&bus, &effect, &settings, "2026-01-01T00:00:03Z").unwrap();
        bus.with_autocommit(|db|{let (count,source,held):(i64,String,bool)=db.query_row("SELECT (SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id='t'),json_extract(payload_json,'$.restartContinuationOfRunId'),(SELECT json_extract(payload_json,'$.queueHeld') FROM orchestration_v2_projection_runs WHERE ordinal=2) FROM orchestration_v2_projection_runs WHERE ordinal=3",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();assert_eq!(count,3);assert_eq!(source,turn.run_id.unwrap());assert!(held);let text:String=db.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE message_id LIKE 'message:restart-continuation:%'",[],|r|r.get(0)).unwrap();assert_eq!(text.matches("- subagent: Review work (id task1)").count(),1);assert!(!text.contains("foreground command"));assert!(text.contains("Continue where you left off."));}).unwrap();
    }
}
