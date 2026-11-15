//! Recover and publish results of app-owned delegated children.
use crate::{
    delegated_ack,
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::HashSet;

fn rows(tx: &Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = tx.prepare(sql)?;
    let raw = stmt
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    raw.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect()
}
fn terminal(v: &Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("completed" | "failed" | "interrupted" | "cancelled" | "rolled_back")
    )
}

fn ran_after(a: &Value, b: &Value) -> bool {
    match (a["completedAt"].as_str(), b["completedAt"].as_str()) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(a_time), Some(b_time)) if a_time != b_time => a_time > b_time,
        _ => a["ordinal"].as_i64().unwrap_or(0) > b["ordinal"].as_i64().unwrap_or(0),
    }
}
fn task_runs<'a>(runs: &'a [Value], messages: &[Value], task_id: &str) -> Vec<&'a Value> {
    let mut owned: HashSet<&str> = runs
        .iter()
        .filter(|r| r["delegatedTaskId"] == task_id)
        .filter_map(|r| r["id"].as_str())
        .collect();
    loop {
        let before = owned.len();
        for message in messages {
            let (Some(id), Some(parent)) = (
                message["runId"].as_str(),
                message["delegatedCompletion"]["parentRunId"].as_str(),
            ) else {
                continue;
            };
            if owned.contains(parent)
                && runs
                    .iter()
                    .any(|r| r["id"] == id && r["delegatedTaskId"].is_null())
            {
                owned.insert(id);
            }
        }
        if owned.len() == before {
            break;
        }
    }
    runs.iter()
        .filter(|r| r["id"].as_str().is_some_and(|id| owned.contains(id)))
        .collect()
}
fn task_result_run<'a>(runs: &[&'a Value]) -> Option<&'a Value> {
    let mut sorted = runs.to_vec();
    sorted.sort_by_key(|r| std::cmp::Reverse(r["ordinal"].as_i64().unwrap_or(0)));
    let awaited: Vec<_> = sorted
        .iter()
        .copied()
        .filter(|r| {
            !(r["status"] == "queued" && r["queueHeld"] == true
                || r["status"] == "cancelled"
                    && r["startedAt"].is_null()
                    && r["restartContinuationOfRunId"].is_null())
        })
        .collect();
    awaited
        .iter()
        .copied()
        .find(|r| {
            matches!(
                r["status"].as_str(),
                Some("preparing" | "starting" | "running" | "waiting")
            )
        })
        .or_else(|| awaited.iter().copied().find(|r| r["status"] == "queued"))
        .or_else(|| awaited.first().copied())
        .or_else(|| sorted.first().copied())
}
fn holds_subagent(s: &Value) -> bool {
    matches!(
        s["status"].as_str(),
        Some("pending" | "running" | "waiting")
    ) || (s["status"] != "idle"
        && matches!(
            s["completionDelivery"]["state"].as_str(),
            Some("pending" | "claimed")
        ))
}

/// Atomically publish eligible child results. Calling this repeatedly is safe.
pub fn recover(bus: &EventBus, now: &str) -> Result<usize, BusError> {
    bus.commit(|tx| {
        let children = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE json_extract(payload_json,'$.lineage.relationshipToParent')='subagent' AND deleted_at IS NULL AND ?1=?1", "")?;
        let mut all_events = Vec::new();
        let mut count = 0;
        for child in children {
            let Some(child_id) = child["id"].as_str() else {continue};
            let Some(parent_id) = child["lineage"]["parentThreadId"].as_str() else {continue};
            if child["forkedFrom"]["type"] != "node" {continue}
            let original = child["forkedFrom"]["nodeId"].as_str().unwrap_or("");
            let runs = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal", child_id)?;
            let user_messages = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='user'", child_id)?;
            let monitor_ids: HashSet<&str> = user_messages.iter().filter(|m| m["notification"]["source"]["kind"] == "monitor").filter_map(|m| m["runId"].as_str()).collect();
            let work: Vec<&Value> = runs.iter().filter(|r| r["status"] != "rolled_back" && !r["id"].as_str().is_some_and(|id| monitor_ids.contains(id))).collect();
            let working = work.iter().any(|r| !(terminal(r) || r["status"] == "queued" && r["queueHeld"] == true));
            let child_tasks = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1", child_id)?;
            let active_children = child_tasks.iter().any(holds_subagent);
            let provider_threads = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1", child_id)?;
            let background = provider_threads.iter().flat_map(|p| p["pendingBackgroundTasks"].as_array().into_iter().flatten()).any(|t| t["awaited"] == true || matches!(t["kind"].as_str(), Some("subagent" | "background_task")));
            let tasks = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' ORDER BY started_at,subagent_id", parent_id)?;
            for mut task in tasks {
                if task["childThreadId"] != child_id {continue}
                if !task["result"].is_null() {
                    let published: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 AND type='subagent_result')", [child_id], |r| r.get(0))?;
                    if published {continue}
                }
                let task_id = task["id"].as_str().unwrap_or("").to_owned();
                let tagged = task_runs(&runs, &user_messages, &task_id);
                let original_task = task_id == original;
                let result_run = work.iter().copied().filter(|r| terminal(r) && (!r["startedAt"].is_null() || r["ordinal"] == 1)).reduce(|a,b| if ran_after(b,a) {b} else {a});
                if original_task && (working || result_run.is_none() || (task["cancelledRunId"].is_null() && (active_children || background))) { continue; }
                let run = if tagged.is_empty() && original_task { result_run } else { task_result_run(&tagged) };
                let Some(run) = run else {continue};
                if !terminal(run) {continue}
                if child_tasks.iter().any(|s| holds_subagent(s) && tagged.iter().any(|r| r["id"] == s["runId"])) {continue}
                let run_id = run["id"].as_str().unwrap_or("");
                let restart_runs: Vec<&Value> = if tagged.is_empty() { runs.iter().collect() } else { tagged.clone() };
                let pending_restart = restart_runs.iter().filter(|candidate| candidate["id"] == run["id"] || ran_after(candidate, run)).any(|candidate| {
                    let effect = format!("effect:restart-continuation:{}", candidate["id"].as_str().unwrap_or(""));
                    tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1 AND status IN ('pending','running'))", [&effect], |r| r.get::<_, bool>(0)).unwrap_or(true)
                });
                if pending_restart {continue}
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 AND target_thread_id=?2 AND type='subagent_result' AND (json_extract(payload_json,'$.sourcePoint.runId')=?3 OR (?4 AND json_extract(payload_json,'$.sourcePoint.runId') IS NULL)))",params![child_id,parent_id,run_id,task_id==original],|r|r.get(0))?;
                if exists {continue}
                let mut status = run["status"].as_str().unwrap_or("interrupted");
                if status == "rolled_back" {status = "interrupted"}
                if matches!(status, "completed" | "cancelled") && run["restartCancelledBackgroundWork"].as_array().is_some_and(|tasks| tasks.iter().any(|t| t["awaited"] == true || (t["kind"] != "shell" && t["kind"] != "monitor"))) { status = "interrupted"; }
                let cancelled = task["cancelledRunId"] == run_id;
                if cancelled && status == "completed" {status = "interrupted"}
                let items = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 ORDER BY ordinal", child_id)?;
                let item = items.iter().rev().find(|i| i["runId"] == run_id && i["type"] == "assistant_message" && i["text"].as_str().is_some_and(|s| !s.trim().is_empty()));
                let messages = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant' ORDER BY updated_at,created_at", child_id)?;
                let eligible = |m: &&Value| m["runId"] == run_id && m["text"].as_str().is_some_and(|s| !s.trim().is_empty());
                let message = item.and_then(|i| messages.iter().find(|m| eligible(m) && m["id"] == i["messageId"])).or_else(|| messages.iter().rev().find(eligible));
                let mut text = message.and_then(|m|m["text"].as_str()).or_else(||item.and_then(|i|i["text"].as_str())).map(str::to_owned).unwrap_or_else(||if status == "completed" {"Child task completed without an assistant result.".into()} else {format!("Child task ended with status {status}.")});
                if status == "failed" {
                    if let Some(failure) = items.iter().rev().find(|i| i["runId"] == run_id && i["type"] == "error") {
                        if let Some(error) = failure["failure"]["message"].as_str() {
                            text = if item.is_some_and(|i| i["ordinal"].as_i64().unwrap_or(0) < failure["ordinal"].as_i64().unwrap_or(0)) {format!("{error}\n\nLast assistant message before the run failed:\n\n{text}")} else {error.to_owned()};
                        }
                    }
                }
                task["status"]=json!(status); task["result"]=json!(text); task["providerThreadId"]=run["providerThreadId"].clone(); task["completedAt"]=json!(now); task["updatedAt"]=json!(now);
                if cancelled { task["completionDelivery"]=json!({"state":"disposed","observedByRunId":null}); }
                else if task["completionDelivery"].is_null() { task["completionDelivery"]=json!({"state":"pending","observedByRunId":null}); }
                tx.execute("UPDATE orchestration_v2_projection_subagents SET status=?3,provider_thread_id=?4,updated_at=?5,completion_delivery_state=?6,payload_json=?7 WHERE thread_id=?1 AND subagent_id=?2",params![parent_id,task_id,status,run["providerThreadId"].as_str(),now,task["completionDelivery"]["state"].as_str(),task.to_string()])?;
                let mut planned=Vec::new();
                if !cancelled {delegated_ack::plan_unobserved(tx,parent_id,&mut task,now,&mut planned)?;}
                if planned.is_empty() {planned.push(("subagent.updated",task.clone()));}
                for (table,key,event) in [("orchestration_v2_projection_nodes","node_id","node.updated"),("orchestration_v2_projection_turn_items","node_id","turn-item.updated")] {
                    let sql=format!("SELECT payload_json FROM {table} WHERE thread_id=?1 AND {key}=?2{} LIMIT 1",if event == "turn-item.updated" {" AND type='subagent'"} else {""});
                    let raw:Option<String>=tx.query_row(&sql,params![parent_id,task_id],|r|r.get(0)).optional()?;
                    if let Some(raw)=raw {let mut value:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;value["status"]=json!(status);value["completedAt"]=json!(now);if event=="turn-item.updated" {value["result"]=json!(text);value["updatedAt"]=json!(now);} else {value["providerThreadId"]=run["providerThreadId"].clone();} let sql=if event=="node.updated" {"UPDATE orchestration_v2_projection_nodes SET status=?3,completed_at=?4,provider_thread_id=?5,payload_json=?6 WHERE thread_id=?1 AND node_id=?2"} else {"UPDATE orchestration_v2_projection_turn_items SET status=?3,updated_at=?4,provider_thread_id=?5,payload_json=?6 WHERE thread_id=?1 AND node_id=?2 AND type='subagent'"};tx.execute(sql,params![parent_id,task_id,status,now,run["providerThreadId"].as_str(),value.to_string()])?;planned.push((event,value));}
                }
                let parent_run=task["runId"].as_str();
                let id=format!("context-transfer:{}",uuid::Uuid::new_v4());
                let mut point=json!({"threadId":child_id,"runId":run_id});
                let source_item = if status == "failed" { items.iter().rev().find(|i| i["runId"] == run_id && i["type"] == "error") } else { item };
                if let Some(i)=source_item {point["turnItemId"]=i["id"].clone();}
                let target_provider:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.providerInstanceId') FROM orchestration_v2_projection_runs WHERE run_id=?1",[parent_run],|r|r.get(0)).optional()?.flatten();
                let transfer=json!({"id":id,"type":"subagent_result","sourceThreadId":child_id,"targetThreadId":parent_id,"sourcePoint":point,"basePoint":null,"sourceProviderInstanceId":run["providerInstanceId"],"targetProviderInstanceId":target_provider,"targetRunId":parent_run,"status":"consumed","resolution":null,"createdBy":"system","error":null,"createdAt":now,"updatedAt":now,"consumedAt":now});
                tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,target_provider,updated_at,payload_json) VALUES(?1,?2,?3,?4,'subagent_result','consumed',?5,?6,?7,?8)",params![id,child_id,parent_id,parent_run,run["providerInstanceId"].as_str(),target_provider,now,transfer.to_string()])?;
                planned.push(("context-transfer.created",transfer));
                for (kind,payload) in planned {all_events.push(Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:parent_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload,metadata:json!({})});}
                count+=1;
            }
        }
        let stored=event_store::append(tx,&all_events)?; Ok((count,stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn followup_includes_transitive_completion_wakes_and_waits_for_live_runs() {
        let runs = vec![
            json!({"id":"a","ordinal":1,"delegatedTaskId":"task","status":"completed"}),
            json!({"id":"b","ordinal":2,"status":"completed"}),
            json!({"id":"c","ordinal":3,"status":"running"}),
            json!({"id":"other","ordinal":4,"delegatedTaskId":"other","status":"running"}),
        ];
        let messages = vec![
            json!({"runId":"c","delegatedCompletion":{"parentRunId":"b"}}),
            json!({"runId":"b","delegatedCompletion":{"parentRunId":"a"}}),
        ];
        let selected = task_runs(&runs, &messages, "task");
        assert_eq!(selected.len(), 3);
        assert_eq!(task_result_run(&selected).unwrap()["id"], "c");
    }

    #[test]
    fn held_and_unstarted_cancelled_runs_do_not_mask_result() {
        let runs = [
            json!({"id":"done","ordinal":1,"status":"completed"}),
            json!({"id":"held","ordinal":2,"status":"queued","queueHeld":true}),
            json!({"id":"cancelled","ordinal":3,"status":"cancelled"}),
        ];
        assert_eq!(
            task_result_run(&runs.iter().collect::<Vec<_>>()).unwrap()["id"],
            "done"
        );
        assert!(!holds_subagent(
            &json!({"status":"idle","completionDelivery":{"state":"pending"}})
        ));
        assert!(holds_subagent(
            &json!({"status":"completed","completionDelivery":{"state":"claimed"}})
        ));
    }

    #[test]
    fn publishes_terminal_result_once_and_reserves_wake() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, payload) in [
            (
                "parent",
                json!({"id":"parent","providerInstanceId":"codex"}),
            ),
            (
                "child",
                json!({"id":"child","lineage":{"relationshipToParent":"subagent","parentThreadId":"parent"},"forkedFrom":{"type":"node","nodeId":"task"}}),
            ),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p','T','codex','full-access','default','now','now',?2)",params![id,payload.to_string()]).unwrap();
        }
        let parent = json!({"id":"pr","threadId":"parent","status":"completed","providerInstanceId":"codex"});
        let child = json!({"id":"cr","threadId":"child","ordinal":1,"status":"completed","providerInstanceId":"codex"});
        for (id, thread, run) in [("pr", "parent", parent), ("cr", "child", child)] {
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,?2,1,'codex','completed','now',?3)",params![id,thread,run.to_string()]).unwrap();
        }
        let task = json!({"id":"task","threadId":"parent","runId":"pr","origin":"app_owned","childThreadId":"child","status":"running","result":null});
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES('task','parent','pr','n','codex','app_owned','running','now',?1)",[task.to_string()]).unwrap();
        let msg =
            json!({"id":"m","threadId":"child","runId":"cr","role":"assistant","text":"Finished."});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','child','cr','assistant',0,'now','now',?1)",[msg.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        assert_eq!(recover(&bus, "later").unwrap(), 1);
        assert_eq!(recover(&bus, "later").unwrap(), 0);
        // A partially persisted result without a transfer must still be published,
        // without returning an existing claim to pending.
        bus.commit(|tx| {tx.execute("DELETE FROM orchestration_v2_projection_context_transfers WHERE source_thread_id='child'",[])?; Ok(((),vec![]))}).unwrap();
        assert_eq!(recover(&bus, "retry").unwrap(), 1);
        assert_eq!(recover(&bus, "retry").unwrap(), 0);
        bus.commit(|tx| {let task:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_subagents WHERE subagent_id='task'",[],|r|r.get(0))?;let task:Value=serde_json::from_str(&task).unwrap();assert_eq!(task["result"],"Finished.");assert_eq!(task["completionDelivery"]["state"],"claimed");let count:i64=tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers WHERE type='subagent_result'",[],|r|r.get(0))?;assert_eq!(count,1);Ok(((),vec![]))}).unwrap();
    }
}
