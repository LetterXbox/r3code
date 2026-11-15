//! Durable acknowledgement of a delegated task result.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

fn load(
    tx: &Transaction<'_>,
    table: &str,
    key: &str,
    thread: &str,
    id: &str,
) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row(
            &format!("SELECT payload_json FROM {table} WHERE thread_id=?1 AND {key}=?2"),
            params![thread, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}
fn wake_detail(ids: &[Value], tasks: &[Value]) -> String {
    let mut budget = 16000usize;
    ids.iter()
        .filter_map(Value::as_str)
        .map(|id| {
            let task = tasks.iter().find(|t| t["id"] == id);
            let title = task
                .and_then(|t| t["title"].as_str())
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            let suffix = task
                .map(|t| format!(" [{}]", t["status"].as_str().unwrap_or("")))
                .unwrap_or_else(|| " reached a terminal state".into());
            let label = format!("Delegated task {id}{title}{suffix}");
            if let Some(result) = task.and_then(|t| t["result"].as_str()) {
                let detail = format!("{label}:\n{result}");
                if detail.len() <= budget {
                    budget -= detail.len();
                    return detail;
                }
            }
            format!("{label}. Use task_status with taskId {id} to read the result.")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) fn plan_unobserved(
    tx: &Transaction<'_>,
    thread: &str,
    task: &mut Value,
    now: &str,
    planned: &mut Vec<(&'static str, Value)>,
) -> rusqlite::Result<()> {
    if !matches!(
        task["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted")
    ) || task["completionDelivery"]["state"] != "pending"
    {
        return Ok(());
    }
    let parent_id = task["runId"].as_str().unwrap_or("").to_owned();
    let mut parent = load(
        tx,
        "orchestration_v2_projection_runs",
        "run_id",
        thread,
        &parent_id,
    )?;
    if task["completionWake"] != "always"
        && parent.as_ref().is_some_and(|p| {
            matches!(
                p["status"].as_str(),
                Some("preparing" | "starting" | "running")
            )
        })
    {
        return Ok(());
    }
    let unavailable: bool = tx.query_row("SELECT archived_at IS NOT NULL OR deleted_at IS NOT NULL FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r| r.get(0)).optional()?.unwrap_or(false);
    let disposed = unavailable
        || parent.as_ref().is_none_or(|p| {
            !p["delegatedCompletion"].is_null() && p["delegatedCompletion"]["disposition"] != "open"
        });
    if disposed {
        task["completionDelivery"] = json!({"state":"disposed","observedByRunId":null});
    } else {
        let p = parent.as_mut().unwrap();
        let delivery = p["delegatedCompletion"]["delivery"].clone();
        let id = task["id"].as_str().unwrap_or("").to_owned();
        if !delivery.is_null() {
            let message_id = delivery["messageId"].as_str().unwrap_or("");
            let mut message = load(
                tx,
                "orchestration_v2_projection_messages",
                "message_id",
                thread,
                message_id,
            )?;
            let wake = if let Some(run_id) = message.as_ref().and_then(|m| m["runId"].as_str()) {
                load(
                    tx,
                    "orchestration_v2_projection_runs",
                    "run_id",
                    thread,
                    run_id,
                )?
            } else {
                None
            };
            if wake
                .as_ref()
                .is_some_and(|w| w["status"] != "queued" || w["userMessageId"] != message_id)
            {
                return Ok(());
            }
            let mut ids = delivery["taskIds"].as_array().cloned().unwrap_or_default();
            if !ids.iter().any(|v| v == &id) {
                ids.push(json!(id));
            }
            p["delegatedCompletion"]["delivery"]["taskIds"] = json!(ids);
            task["completionDelivery"] = json!({"state":"claimed","observedByRunId":null});
            if wake.is_some() {
                if let Some(ref mut msg) = message {
                    let mut tasks = vec![];
                    for id in &ids {
                        if let Some(id) = id.as_str() {
                            if id == task["id"].as_str().unwrap_or("") {
                                tasks.push(task.clone());
                            } else if let Some(t) = load(
                                tx,
                                "orchestration_v2_projection_subagents",
                                "subagent_id",
                                thread,
                                id,
                            )? {
                                tasks.push(t);
                            }
                        }
                    }
                    msg["text"] = json!(wake_detail(&ids, &tasks));
                    msg["delegatedCompletion"] = json!({"parentRunId":parent_id,"generation":delivery["generation"],"taskIds":ids});
                    msg["updatedAt"] = json!(now);
                    tx.execute("UPDATE orchestration_v2_projection_messages SET updated_at=?3,payload_json=?4 WHERE thread_id=?1 AND message_id=?2", params![thread,message_id,now,msg.to_string()])?;
                    planned.push(("message.updated", msg.clone()));
                }
            }
        } else {
            let generation = p["delegatedCompletion"]["nextGeneration"]
                .as_u64()
                .unwrap_or(1);
            let message_id = format!("message:{}", uuid::Uuid::new_v4());
            p["delegatedCompletion"] = json!({"disposition":"open","nextGeneration":generation+1,"delivery":{"generation":generation,"messageId":message_id,"taskIds":[id]}});
            task["completionDelivery"] = json!({"state":"claimed","observedByRunId":null});
        }
        tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?3 WHERE thread_id=?1 AND run_id=?2", params![thread,parent_id,p.to_string()])?;
        planned.insert(0, ("run.updated", p.clone()));
    }
    tx.execute("UPDATE orchestration_v2_projection_subagents SET completion_delivery_state=?3,payload_json=?4 WHERE thread_id=?1 AND subagent_id=?2", params![thread,task["id"].as_str().unwrap_or(""),task["completionDelivery"]["state"].as_str(),task.to_string()])?;
    planned.insert(0, ("subagent.updated", task.clone()));
    Ok(())
}
/// Commit the acknowledgement and its projection changes atomically. A replay returns its original receipt.
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread: &str,
    task_id: &str,
    observed_by: Option<&str>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_inner(bus, command_id, thread, task_id, observed_by, false, now)
}

/// Dispose an undeliverable result and remove it from its reserved cohort.
pub fn dispose(
    bus: &EventBus,
    command_id: &str,
    thread: &str,
    task_id: &str,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_inner(bus, command_id, thread, task_id, None, true, now)
}

fn dispatch_inner(
    bus: &EventBus,
    command_id: &str,
    thread: &str,
    task_id: &str,
    observed_by: Option<&str>,
    dispose: bool,
    now: &str,
) -> Result<CommitResult, BusError> {
    bus.commit(|tx| {
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {return Ok((CommitResult{receipt,committed:false},vec![]));}
        let task = load(tx,"orchestration_v2_projection_subagents","subagent_id",thread,task_id)?.filter(|t|t["origin"]=="app_owned");
        let error=task.is_none().then(||format!("Delegated task {task_id} is not an app-owned task of thread {thread}."));
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread.into(),command_type:if dispose {"delegated_task.completion-delivery.dispose"} else {"delegated_task.completion-delivery.acknowledge"}.into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery)}
        let Some(mut task)=task else {return Ok((CommitResult{receipt,committed:false},vec![]));};
        let mut planned:Vec<(&str,Value)>=vec![];
        // Unobserved acknowledgements are eligible for a delivery offer, not direct acknowledgement.
        if observed_by.is_none() && !dispose {
            let parent_live:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status IN ('preparing','starting','running'))",params![thread,task["runId"].as_str()],|r|r.get(0))?;
            if !parent_live { plan_unobserved(tx, thread, &mut task, now, &mut planned)?; }
        }
        if dispose || observed_by.is_some() {
            if !matches!(task["completionDelivery"]["state"].as_str(),Some("acknowledged"|"disposed")) {
                let state = if dispose {"disposed"} else {"acknowledged"};
                task["completionDelivery"]=json!({"state":state,"observedByRunId":observed_by});task["updatedAt"]=json!(now);
                tx.execute("UPDATE orchestration_v2_projection_subagents SET completion_delivery_state=?5,updated_at=?3,payload_json=?4 WHERE thread_id=?1 AND subagent_id=?2",params![thread,task_id,now,task.to_string(),state])?;
                if let Some(parent_id)=task["runId"].as_str() {
                    if let Some(mut parent)=load(tx,"orchestration_v2_projection_runs","run_id",thread,parent_id)? {
                        let delivery=parent["delegatedCompletion"]["delivery"].clone();
                        if let Some(ids)=delivery["taskIds"].as_array().filter(|ids|ids.iter().any(|id|id==task_id)) {
                            let remaining:Vec<Value>=ids.iter().filter(|id|*id!=task_id).cloned().collect();
                            let message_id=delivery["messageId"].as_str().unwrap_or("");
                            let mut message=load(tx,"orchestration_v2_projection_messages","message_id",thread,message_id)?;
                            let mut wake=if let Some(id)=message.as_ref().and_then(|m|m["runId"].as_str()) {load(tx,"orchestration_v2_projection_runs","run_id",thread,id)?} else {None};
                            let queued=wake.as_ref().is_some_and(|r|r["status"]=="queued");
                            if remaining.is_empty() && (wake.is_none() || queued) {parent["delegatedCompletion"]["delivery"]=Value::Null;} else {parent["delegatedCompletion"]["delivery"]["taskIds"]=json!(remaining);}
                            tx.execute("UPDATE orchestration_v2_projection_runs SET payload_json=?3 WHERE thread_id=?1 AND run_id=?2",params![thread,parent_id,parent.to_string()])?;planned.push(("run.updated",parent));
                            if queued && remaining.is_empty() {
                                let mut run=wake.take().unwrap();let id=run["id"].as_str().unwrap_or("").to_owned();run["status"]=json!("cancelled");run["queuePosition"]=Value::Null;run["completedAt"]=json!(now);
                                tx.execute("UPDATE orchestration_v2_projection_runs SET status='cancelled',completed_at=?3,payload_json=?4 WHERE thread_id=?1 AND run_id=?2",params![thread,id,now,run.to_string()])?;
                                let root = if let Some(id)=run["rootNodeId"].as_str() {load(tx,"orchestration_v2_projection_nodes","node_id",thread,id)?} else {None};
                                planned.push(("run.updated",run.clone()));
                                if root.is_some() {if let Some(id)=run["activeAttemptId"].as_str() {if let Some(mut attempt)=load(tx,"orchestration_v2_projection_run_attempts","attempt_id",thread,id)? {attempt["status"]=json!("cancelled");attempt["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_run_attempts SET status='cancelled',payload_json=?3 WHERE thread_id=?1 AND attempt_id=?2",params![thread,id,attempt.to_string()])?;planned.push(("run-attempt.updated",attempt));}}}
                                if let Some(mut node)=root {let id=node["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();node["status"]=json!("cancelled");node["completedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_nodes SET status='cancelled',completed_at=?3,payload_json=?4 WHERE thread_id=?1 AND node_id=?2",params![thread,id,now,node.to_string()])?;planned.push(("node.updated",node));}
                            } else if queued {
                                if let Some(ref mut msg)=message {let mut tasks=vec![];for id in &remaining {if let Some(id)=id.as_str() {if let Some(t)=load(tx,"orchestration_v2_projection_subagents","subagent_id",thread,id)? {tasks.push(t);}}}msg["text"]=json!(wake_detail(&remaining,&tasks));msg["delegatedCompletion"]=json!({"parentRunId":parent_id,"generation":delivery["generation"],"taskIds":remaining});msg["updatedAt"]=json!(now);tx.execute("UPDATE orchestration_v2_projection_messages SET updated_at=?3,payload_json=?4 WHERE thread_id=?1 AND message_id=?2",params![thread,message_id,now,msg.to_string()])?;planned.push(("message.updated",msg.clone()));}
                            }
                        }
                    }
                }
            }
            planned.insert(0,("subagent.updated",task));
        }
        let events:Vec<Event>=planned.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;if let Some(last)=stored.last(){receipt.result_sequence=last.sequence;event_store::upsert_receipt(tx,&receipt)?;}Ok((CommitResult{receipt,committed:true},stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unobserved_pending_reserves_or_waits_for_live_parent() {
        for live in [false, true] {
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            crate::migrations::run_ported_migrations(&mut db).unwrap();
            let task = json!({"id":"task","runId":"parent","origin":"app_owned","status":"completed","completionDelivery":{"state":"pending","observedByRunId":null}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json,completion_delivery_state) VALUES('task','t','parent','n','codex','app_owned','completed','old',?1,'pending')",[task.to_string()]).unwrap();
            let status = if live { "running" } else { "completed" };
            let parent = json!({"id":"parent","status":status});
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('parent','t',1,'codex',?1,'old',?2)",params![status,parent.to_string()]).unwrap();
            let bus = EventBus::new(db, 16);
            dispatch(&bus, "ack", "t", "task", None, "now").unwrap();
            bus.commit(|tx| {
                let task = load(
                    tx,
                    "orchestration_v2_projection_subagents",
                    "subagent_id",
                    "t",
                    "task",
                )?
                .unwrap();
                let parent = load(
                    tx,
                    "orchestration_v2_projection_runs",
                    "run_id",
                    "t",
                    "parent",
                )?
                .unwrap();
                if live {
                    assert_eq!(task["completionDelivery"]["state"], "pending");
                    assert!(parent["delegatedCompletion"].is_null());
                } else {
                    assert_eq!(task["completionDelivery"]["state"], "claimed");
                    assert_eq!(
                        parent["delegatedCompletion"]["delivery"]["taskIds"],
                        json!(["task"])
                    );
                    assert_eq!(parent["delegatedCompletion"]["nextGeneration"], 2);
                }
                Ok(((), vec![]))
            })
            .unwrap();
        }
    }
    #[test]
    fn observed_ack_rewrites_then_cancels_wake_and_replays() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for id in ["a", "b"] {
            let task = json!({"id":id,"threadId":"t","runId":"parent","origin":"app_owned","status":"completed","result":"child finished","completionDelivery":{"state":"claimed","observedByRunId":null}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json,completion_delivery_state) VALUES(?1,'t','parent','n','codex','app_owned','completed','old',?2,'claimed')",params![id,task.to_string()]).unwrap();
        }
        let parent = json!({"id":"parent","status":"completed","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"m","taskIds":["a","b"]}}});
        let wake = json!({"id":"wake","status":"queued","ordinal":2,"userMessageId":"m","queuePosition":1,"rootNodeId":"node","activeAttemptId":"attempt"});
        for (id, ordinal, status, value) in [
            ("parent", 1, "completed", parent),
            ("wake", 2, "queued", wake),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex',?3,'old',?4)",params![id,ordinal,status,value.to_string()]).unwrap();
        }
        let node = json!({"id":"node","status":"queued"});
        db.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES('node','t','wake','node','run','queued',?1)",[node.to_string()]).unwrap();
        let attempt = json!({"id":"attempt","status":"queued"});
        db.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('attempt','t','wake',1,'node','codex','pt','queued',?1)",[attempt.to_string()]).unwrap();
        let message = json!({"id":"m","runId":"wake","role":"user","text":"old","delegatedCompletion":{"parentRunId":"parent","generation":1,"taskIds":["a","b"]}});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'old','old',?1)",[message.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        assert!(
            dispatch(&bus, "one", "t", "a", Some("reader"), "now")
                .unwrap()
                .committed
        );
        assert!(
            !dispatch(&bus, "one", "t", "a", Some("reader"), "now")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            let m = load(
                tx,
                "orchestration_v2_projection_messages",
                "message_id",
                "t",
                "m",
            )?
            .unwrap();
            let parent = load(
                tx,
                "orchestration_v2_projection_runs",
                "run_id",
                "t",
                "parent",
            )?
            .unwrap();
            assert_eq!(
                parent["delegatedCompletion"]["delivery"]["taskIds"],
                json!(["b"])
            );
            assert_eq!(m["text"], "Delegated task b [completed]:\nchild finished");
            assert_eq!(m["delegatedCompletion"]["taskIds"], json!(["b"]));
            Ok(((), vec![]))
        })
        .unwrap();
        assert!(
            dispatch(&bus, "two", "t", "b", Some("reader"), "later")
                .unwrap()
                .committed
        );
        bus.commit(|tx| {
            let p = load(
                tx,
                "orchestration_v2_projection_runs",
                "run_id",
                "t",
                "parent",
            )?
            .unwrap();
            let w = load(
                tx,
                "orchestration_v2_projection_runs",
                "run_id",
                "t",
                "wake",
            )?
            .unwrap();
            assert!(p["delegatedCompletion"]["delivery"].is_null());
            assert_eq!(w["status"], "cancelled");
            let completed: String=tx.query_row("SELECT completed_at FROM orchestration_v2_projection_runs WHERE run_id='wake'",[],|r|r.get(0))?;
            let node_completed: String=tx.query_row("SELECT completed_at FROM orchestration_v2_projection_nodes WHERE node_id='node'",[],|r|r.get(0))?;
            assert_eq!(completed,"later"); assert_eq!(node_completed,"later");
            let mut stmt=tx.prepare("SELECT event_type,payload_json FROM orchestration_events WHERE command_id='two' ORDER BY sequence")?;
            let events=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            assert_eq!(events.iter().map(|v|v.0.as_str()).collect::<Vec<_>>(),vec!["subagent.updated","run.updated","run.updated","run-attempt.updated","node.updated"]);
            assert_eq!(serde_json::from_str::<Value>(&events[1].1).unwrap()["id"],"parent");
            assert_eq!(serde_json::from_str::<Value>(&events[2].1).unwrap()["id"],"wake");
            Ok(((), vec![]))
        })
        .unwrap();
        let missing = dispatch(&bus, "bad", "t", "missing", Some("reader"), "now").unwrap();
        assert_eq!(missing.receipt.status, "rejected");
    }
    #[test]
    fn clears_missing_wake_but_keeps_empty_delivery_for_running_wake() {
        for running in [false, true] {
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            crate::migrations::run_ported_migrations(&mut db).unwrap();
            let task = json!({"id":"task","runId":"parent","origin":"app_owned","status":"completed","completionDelivery":{"state":"claimed"}});
            db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,origin,status,updated_at,payload_json,completion_delivery_state) VALUES('task','t','parent','n','codex','app_owned','completed','old',?1,'claimed')",[task.to_string()]).unwrap();
            let parent = json!({"id":"parent","status":"completed","completedAt":"earlier","checkpointId":"checkpoint","delegatedCompletion":{"disposition":"open","nextGeneration":2,"delivery":{"generation":1,"messageId":"m","taskIds":["task"]}}});
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES('parent','t',1,'codex','completed','old','earlier',?1)",[parent.to_string()]).unwrap();
            if running {
                let wake = json!({"id":"wake","status":"running"});
                db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('wake','t',2,'codex','running','old',?1)",[wake.to_string()]).unwrap();
                let message = json!({"id":"m","runId":"wake","role":"user"});
                db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'old','old',?1)",[message.to_string()]).unwrap();
            }
            let bus = EventBus::new(db, 16);
            dispatch(&bus, "ack", "t", "task", Some("reader"), "now").unwrap();
            bus.commit(|tx| {
                let parent = load(
                    tx,
                    "orchestration_v2_projection_runs",
                    "run_id",
                    "t",
                    "parent",
                )?
                .unwrap();
                assert_eq!(parent["status"], "completed");
                assert_eq!(parent["completedAt"], "earlier");
                assert_eq!(parent["checkpointId"], "checkpoint");
                if running {
                    assert_eq!(
                        parent["delegatedCompletion"]["delivery"]["taskIds"],
                        json!([])
                    );
                } else {
                    assert!(parent["delegatedCompletion"]["delivery"].is_null());
                }
                Ok(((), vec![]))
            })
            .unwrap();
        }
    }
}
