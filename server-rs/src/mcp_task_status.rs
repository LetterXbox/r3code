//! Read a caller's delegated task and acknowledge delivered terminal results.
use crate::{event_bus::EventBus, mcp_credentials::Scope};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Failure = (&'static str, String);
fn failure(message: impl Into<String>) -> Failure {
    ("orchestration_error", message.into())
}
fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}
fn row(db: &Connection, sql: &str, args: &[&str]) -> Result<Option<Value>, Failure> {
    let raw: Option<String> = db
        .query_row(sql, rusqlite::params_from_iter(args), |r| r.get(0))
        .optional()
        .map_err(|e| failure(e.to_string()))?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| failure(e.to_string())))
        .transpose()
}

/// `db` must be the same projection database used by `bus`; the lock is dropped
/// before dispatching the acknowledgement. Errors are MCP tool error codes.
pub fn call(
    db: &Arc<Mutex<Connection>>,
    bus: &EventBus,
    scope: &Scope,
    task_id: &str,
    environment_id: &str,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    if task_id.is_empty() {
        return Err(("invalid_request", "taskId is required.".into()));
    }
    let (result, acknowledge, observing_run) = {
        let db = db
            .lock()
            .map_err(|_| failure("The operation could not be completed."))?;
        let not_found = || {
            (
                "task_not_found",
                format!(
                    "Delegated task {task_id} does not belong to thread {}.",
                    scope.thread_id
                ),
            )
        };
        let task = row(&db, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned'", &[&scope.thread_id,task_id])?.ok_or_else(not_found)?;
        if task["id"] != task_id || task["threadId"] != scope.thread_id {
            return Err(not_found());
        }
        let child = task["childThreadId"].as_str();
        if child.is_none() && !task["remoteChild"].is_object() {
            return Err(not_found());
        }
        let thread = if let Some(child) = child {
            Some(row(&db, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", &[child])?.ok_or_else(not_found)?)
        } else {
            None
        };
        // A corrupted cross-thread task must never expose an unrelated thread.
        if let Some(thread) = &thread {
            if thread["lineage"]["parentThreadId"] != scope.thread_id
                || thread["lineage"]["relationshipToParent"] != "subagent"
            {
                return Err(not_found());
            }
        }
        let run = if let Some(child) = child {
            row(&db, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND json_extract(payload_json,'$.delegatedTaskId')=?2 ORDER BY ordinal ASC LIMIT 1", &[child,task_id])?.or(if thread.as_ref().is_some_and(|t| t["forkedFrom"]["type"] == "node" && t["forkedFrom"]["nodeId"] == task_id) { row(&db, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal ASC LIMIT 1", &[child])? } else { None })
        } else {
            None
        };
        // Follow-up turns may continue the same delegated task after its original run.
        let progress_run = if let Some(child) = child {
            row(&db, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND json_extract(payload_json,'$.delegatedTaskId')=?2 AND NOT (status='queued' AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=1) AND NOT (status='cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL) ORDER BY CASE WHEN status IN ('preparing','starting','running','waiting') THEN 0 WHEN status='queued' THEN 1 ELSE 2 END, ordinal DESC LIMIT 1", &[child,task_id])?.or_else(|| run.clone())
        } else {
            None
        };
        let latest_terminal = if let Some(child) = child {
            row(&db, "SELECT r.payload_json FROM orchestration_v2_projection_runs r WHERE r.thread_id=?1 AND r.status IN ('completed','failed','cancelled','interrupted') AND (r.run_id=?2 OR json_extract(r.payload_json,'$.startedAt') IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.run_id=r.run_id AND json_extract(m.payload_json,'$.notification.source.kind')='monitor') ORDER BY COALESCE(json_extract(r.payload_json,'$.startedAt'),json_extract(r.payload_json,'$.requestedAt')) DESC, r.ordinal DESC LIMIT 1", &[child,run.as_ref().and_then(|r|r["id"].as_str()).unwrap_or("")])?
        } else {
            None
        };
        let result_present = task["result"].is_string();
        let task_status = task["status"].as_str().unwrap_or("running");
        let mut status = if result_present {
            if terminal(task_status) {
                task_status
            } else {
                "completed"
            }
        } else if progress_run
            .as_ref()
            .is_some_and(|r| r["status"] == "queued")
        {
            "queued"
        } else {
            "running"
        };
        let model = progress_run
            .as_ref()
            .map(|r| &r["modelSelection"])
            .filter(|m| m.is_object())
            .or_else(|| {
                thread
                    .as_ref()
                    .map(|t| &t["modelSelection"])
                    .filter(|m| m.is_object())
            });
        let mut result = json!({"taskId":task_id,"childThreadId":child,"childRunId":run.as_ref().map(|r| &r["id"]),"childNodeId":task_id,"status":status,"workState":if result_present {"result_available"} else {"working"},"hasPendingChildRuns":false,"providerInstanceId":model.map(|m| &m["instanceId"]).unwrap_or(&task["providerInstanceId"]),"model":model.map(|m| &m["model"]).unwrap_or(&task["model"]),"executedModel":null,"summary":task["result"],"resultContextTransferId":null,"latestTerminalRunId":null,"latestTerminalStatus":if terminal(status) {Some(status)} else {None},"latestTerminalSummary":if child.is_none() && terminal(status) {task["result"].clone()} else {Value::Null},"latestTerminalResultContextTransferId":null,"hasPendingQuestion":false,"pendingApproval":null,"waitTimedOut":false});
        if let (Some(child), Some(thread)) = (child, &thread) {
            let title = thread["title"].as_str().unwrap_or(child);
            result["link"] = json!(format!(
                "[{title}](t3-thread://v2/{environment_id}/{child})"
            ));
            result["options"] = model
                .and_then(|m| m["options"].as_array())
                .map(|v| json!(v))
                .unwrap_or(json!([]));
            let pending_runs: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting') AND NOT (status='queued' AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=1) AND ordinal>COALESCE((SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id=?2),-1))", params![child,run.as_ref().and_then(|r|r["id"].as_str())], |r|r.get(0)).map_err(|e|failure(e.to_string()))?;
            if let Some(attempt) = progress_run
                .as_ref()
                .and_then(|r| r["activeAttemptId"].as_str())
            {
                let executed: Option<String> = db.query_row("SELECT json_extract(payload_json,'$.model') FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY ordinal DESC LIMIT 1", [attempt], |r| r.get(0)).optional().map_err(|e|failure(e.to_string()))?.flatten();
                result["executedModel"] = json!(executed);
            }
            let pending_children: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND status IN ('pending','idle','running','waiting'))", [child], |r|r.get(0)).map_err(|e|failure(e.to_string()))?;
            let pending_background: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0)", [child], |r|r.get(0)).map_err(|e|failure(e.to_string()))?;
            let question: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND kind='user_input' AND status='pending' AND json_extract(payload_json,'$.responseCapability.type')='live')", [child], |r|r.get(0)).map_err(|e|failure(e.to_string()))?;
            let approval = row(&db, "SELECT json_object('requestId',q.runtime_request_id,'kind',q.kind,'runId',n.run_id) FROM orchestration_v2_projection_runtime_requests q JOIN orchestration_v2_projection_nodes n ON n.node_id=q.node_id AND n.thread_id=q.thread_id JOIN orchestration_v2_projection_runs r ON r.run_id=n.run_id WHERE q.thread_id=?1 AND q.status='pending' AND q.kind IN ('command','file-read','file-change','mcp-elicitation','permission') AND json_extract(q.payload_json,'$.responseCapability.type')='live' AND r.status IN ('queued','preparing','starting','running','waiting') AND (json_extract(r.payload_json,'$.delegatedTaskId')=?2 OR r.run_id=?3) ORDER BY q.created_at LIMIT 1", &[child,task_id,run.as_ref().and_then(|r|r["id"].as_str()).unwrap_or("")])?;
            if !terminal(status) && task["completionDelivery"]["state"] != "disposed" {
                result["pendingApproval"] = approval.unwrap_or(Value::Null);
            }
            if !result_present
                && progress_run
                    .as_ref()
                    .is_some_and(|r| terminal(r["status"].as_str().unwrap_or("")))
                && !pending_children
                && !pending_background
            {
                let progress = progress_run.as_ref().unwrap();
                status = progress["status"].as_str().unwrap_or("running");
                if task["cancelledRunId"].is_string() && status == "completed" {
                    status = "interrupted";
                }
                result["status"] = json!(status);
                result["workState"] = json!("result_available");
                result["pendingApproval"] = Value::Null;
                if let Some(id) = progress["id"].as_str() {
                    let item = row(&db, "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type IN ('assistant_message','error') ORDER BY ordinal DESC LIMIT 1", &[child,id])?;
                    let text = item
                        .as_ref()
                        .map(|i| {
                            if i["type"] == "error" {
                                i["error"]["message"].clone()
                            } else {
                                i["text"].clone()
                            }
                        })
                        .filter(|v| v.is_string())
                        .unwrap_or_else(|| {
                            json!(if status == "completed" {
                                "Child task completed without an assistant result.".to_string()
                            } else {
                                format!("Child task ended with status {status}.")
                            })
                        });
                    result["summary"] = text;
                }
            }
            result["hasPendingChildRuns"] = json!(pending_runs);
            result["hasPendingQuestion"] = json!(!terminal(status) && question);
            if !result_present && !pending_runs && (pending_children || pending_background) {
                result["workState"] = json!("waiting_for_children");
            }
            if terminal(status) {
                if let Some(run_id) = run.as_ref().and_then(|r| r["id"].as_str()) {
                    let transfer = row(&db,"SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 AND target_thread_id=?2 AND type='subagent_result' AND (json_extract(payload_json,'$.sourcePoint.runId')=?3 OR json_extract(payload_json,'$.sourcePoint.runId') IS NULL) ORDER BY updated_at DESC LIMIT 1", &[child,&scope.thread_id,run_id])?;
                    result["resultContextTransferId"] =
                        transfer.map(|t| t["id"].clone()).unwrap_or(Value::Null);
                }
            }
            if let Some(latest) = &latest_terminal {
                result["latestTerminalRunId"] = latest["id"].clone();
                result["latestTerminalStatus"] = latest["status"].clone();
                if latest["id"] != run.as_ref().map(|r| r["id"].clone()).unwrap_or(Value::Null) {
                    if let Some(id) = latest["id"].as_str() {
                        let item = row(&db, "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type IN ('assistant_message','error') ORDER BY ordinal DESC LIMIT 1", &[child,id])?;
                        let summary = item
                            .as_ref()
                            .map(|i| {
                                if i["type"] == "error" {
                                    i["error"]["message"].clone()
                                } else {
                                    i["text"].clone()
                                }
                            })
                            .unwrap_or(Value::Null);
                        if summary != result["summary"] {
                            result["latestTerminalSummary"] = summary;
                        }
                        let transfer = row(&db, "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 AND target_thread_id=?2 AND type='subagent_result' AND json_extract(payload_json,'$.sourcePoint.runId')=?3 ORDER BY updated_at DESC LIMIT 1", &[child,&scope.thread_id,id])?;
                        let transfer_id = transfer.map(|t| t["id"].clone()).unwrap_or(Value::Null);
                        if transfer_id != result["resultContextTransferId"] {
                            result["latestTerminalResultContextTransferId"] = transfer_id;
                        }
                    }
                }
            }
        } else {
            result["remoteChild"] = task["remoteChild"].clone();
        }
        if !terminal(status)
            && result["hasPendingQuestion"] != true
            && result["pendingApproval"].is_null()
            && task["completionDelivery"]["state"] != "disposed"
        {
            result["next"] = json!(
                "Completion wakes this thread, so end your turn. Do not wait on it or poll it."
            );
        }
        let acknowledge = terminal(status)
            && task["completionDelivery"]["state"] != "acknowledged"
            && task["completionDelivery"]["state"] != "disposed";
        let observing_run: Option<String> = db.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND provider_instance_id=?2 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0)).optional().map_err(|e|failure(e.to_string()))?;
        (result, acknowledge, observing_run)
    };
    if acknowledge {
        let command = format!("mcp:task-status-acknowledge:{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let response = crate::delegated_ack::dispatch(
            bus,
            &command,
            &scope.thread_id,
            task_id,
            observing_run.as_deref(),
            &now,
        )
        .map_err(|e| {
            failure(format!(
                "Unable to acknowledge delegated task {task_id}: {e}"
            ))
        })?;
        if let Some(error) = response.receipt.error {
            return Err(failure(format!(
                "Unable to acknowledge delegated task {task_id}: {error}"
            )));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn status_is_limited_to_owned_direct_children() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut conn).unwrap();
        conn.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('child','p','Child','codex','full-access','default','now','now',?1)", [json!({"id":"child","title":"Child","lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"},"forkedFrom":{"type":"node","nodeId":"task"}}).to_string()]).unwrap();
        conn.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,child_thread_id,origin,status,updated_at,payload_json) VALUES('task','parent','n','codex','child','app_owned','running','now',?1)", [json!({"id":"task","threadId":"parent","childThreadId":"child","origin":"app_owned","status":"running","result":null}).to_string()]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let bus = EventBus::new(Connection::open_in_memory().unwrap(), 16);
        let mut scope = Scope {
            thread_id: "parent".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let value = call(&db, &bus, &scope, "task", "env").unwrap();
        assert_eq!(value["status"], "running");
        assert_eq!(value["childThreadId"], "child");
        assert!(value["next"].is_string());
        {
            let conn = db.lock().unwrap();
            conn.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('first','child',1,'codex','completed','2026-01-01',?1)", [json!({"id":"first","status":"completed","delegatedTaskId":"task","startedAt":"2026-01-01"}).to_string()]).unwrap();
            conn.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('follow','child',2,'codex','running','2026-01-02',?1)", [json!({"id":"follow","status":"running","delegatedTaskId":"task","startedAt":"2026-01-02","modelSelection":{"instanceId":"other","model":"new"}}).to_string()]).unwrap();
        }
        let value = call(&db, &bus, &scope, "task", "env").unwrap();
        assert_eq!(value["childRunId"], "first");
        assert_eq!(value["latestTerminalRunId"], "first");
        assert_eq!(value["latestTerminalStatus"], "completed");
        assert_eq!(value["model"], "new");
        assert_eq!(value["hasPendingChildRuns"], true);
        assert_eq!(value["status"], "running");
        scope.thread_id = "other".into();
        assert_eq!(
            call(&db, &bus, &scope, "task", "env").unwrap_err().0,
            "task_not_found"
        );
        scope.thread_id = "parent".into();
        db.lock().unwrap().execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','other')", []).unwrap();
        assert_eq!(
            call(&db, &bus, &scope, "task", "env").unwrap_err().0,
            "task_not_found"
        );
        scope.capabilities.clear();
        assert_eq!(
            call(&db, &bus, &scope, "task", "env").unwrap_err().0,
            "capability_denied"
        );
    }
}
