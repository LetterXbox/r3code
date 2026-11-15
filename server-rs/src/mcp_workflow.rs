use crate::{
    event_bus::EventBus,
    mcp_credentials::Scope,
    mcp_thread_organize::check as check_thread_access,
    provider::claude_executor,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::cell::RefCell;

type Failure = (&'static str, String);

pub fn workflow_stop_definition() -> Value {
    json!({
        "name": "t3_workflow_stop",
        "description": "Stop a running Claude workflow in a thread. `subagentId`: coordinator from `t3_thread_read` 'activity'. Stops only the workflow, not the thread.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "environmentId": { "type": "string", "minLength": 1 },
                "threadId": { "type": "string", "minLength": 1 },
                "subagentId": { "type": "string", "minLength": 1 }
            },
            "required": ["threadId", "subagentId"],
            "additionalProperties": false
        },
        "annotations": {
            "title": "Stop a workflow",
            "destructiveHint": true
        }
    })
}

pub fn background_wait_definition() -> Value {
    json!({
        "name": "t3_background_wait",
        "description": "Keep this thread in Working while background work runs. Pass its task ID after starting it. Not for work left running (dev server, watcher). `waiting=false` clears. Does not stop the task. Claude only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskIds": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": { "type": "string", "minLength": 1 }
                },
                "waiting": { "type": "boolean" }
            },
            "required": ["taskIds"],
            "additionalProperties": false
        },
        "annotations": {
            "title": "Wait on background work",
            "readOnlyHint": true,
            "destructiveHint": false
        }
    })
}

pub async fn stop_workflow(
    bus: &EventBus,
    scope: Option<&Scope>,
    args: &Value,
) -> Result<Value, Failure> {
    let Some(obj) = args.as_object() else {
        return Err(("invalid_request", "Arguments must be a JSON object.".into()));
    };
    let thread_id = obj
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("invalid_request", "threadId is required.".into()))?
        .to_owned();
    let subagent_id = obj
        .get("subagentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("invalid_request", "subagentId is required.".into()))?
        .to_owned();

    if let Some(s) = scope {
        if let Some(client) = s.client.as_ref() {
            if client.access == "read-only" {
                return Err((
                    "capability_denied",
                    "This MCP client is read-only and cannot stop workflows.".into(),
                ));
            }
        }
    }

    let denied = RefCell::new(None::<Failure>);
    let native_task_id = bus
        .commit(|tx| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            if let Some(s) = scope {
                check_thread_access(tx, s, &thread_id).map_err(&reject)?;
            } else {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",
                    [&thread_id],
                    |r| r.get(0),
                )?;
                if !exists {
                    return Err(reject(("thread_not_found", "The thread was not found.".into())));
                }
            }

            let sub_raw: Option<String> = tx
                .query_row(
                    "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2",
                    params![&thread_id, &subagent_id],
                    |r| r.get(0),
                )
                .optional()?;
            let sub_raw = sub_raw.ok_or_else(|| {
                reject(("invalid_request", "No running workflow task found for subagentId.".into()))
            })?;
            let sub: Value = serde_json::from_str(&sub_raw).unwrap_or_else(|_| json!({}));

            if sub.get("workflow").is_none_or(Value::is_null)
                || sub["status"].as_str() != Some("running")
            {
                return Err(reject((
                    "invalid_request",
                    "Workflow task is not running.".into(),
                )));
            }
            if sub["origin"].as_str() != Some("provider_native")
                || sub["driver"].as_str() != Some("claudeAgent")
            {
                return Err(reject((
                    "invalid_request",
                    "Workflow stop is only supported for Claude native workflows.".into(),
                )));
            }
            let native_id = sub["nativeTaskRef"]["nativeId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    reject((
                        "orchestration_error",
                        "Workflow task has no native task identifier.".into(),
                    ))
                })?;

            Ok((native_id, vec![]))
        })
        .map_err(|_| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("orchestration_error", "Could not inspect workflow.".into()))
        })?;

    claude_executor::stop_task(&thread_id, &native_task_id)
        .await
        .map_err(|e| ("orchestration_error", e))?;

    Ok(json!({}))
}

pub fn await_background_tasks(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
) -> Result<Value, Failure> {
    if let Some(client) = scope.client.as_ref() {
        if client.access == "read-only" {
            return Err((
                "capability_denied",
                "This MCP client is read-only and cannot modify background task waits.".into(),
            ));
        }
    }
    if scope.thread_id.is_empty() {
        return Err((
            "invalid_request",
            "t3_background_wait requires a thread-scoped MCP session.".into(),
        ));
    }
    let Some(obj) = args.as_object() else {
        return Err(("invalid_request", "Arguments must be a JSON object.".into()));
    };
    let raw_ids = obj
        .get("taskIds")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.len() <= 20)
        .ok_or_else(|| ("invalid_request", "taskIds must contain 1 to 20 items.".into()))?;
    let mut task_ids = Vec::with_capacity(raw_ids.len());
    for item in raw_ids {
        let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            return Err(("invalid_request", "Each taskId must be a non-empty string.".into()));
        };
        task_ids.push(s.to_owned());
    }
    let waiting = match obj.get("waiting") {
        None => true,
        Some(Value::Bool(v)) => *v,
        _ => return Err(("invalid_request", "waiting must be a boolean.".into())),
    };

    let denied = RefCell::new(None::<Failure>);
    let provider_thread_id = bus
        .with_autocommit(|db| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            let active_pt: Option<Option<String>> = db
                .query_row(
                    "SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                    [&scope.thread_id],
                    |r| r.get(0),
                )
                .optional()?;
            let active_pt = active_pt
                .ok_or_else(|| reject(("thread_not_found", "The calling thread was not found.".into())))?
                .ok_or_else(|| reject(("orchestration_error", "No active provider thread.".into())))?;

            let pt_row: Option<(String, Option<String>)> = db
                .query_row(
                    "SELECT provider, provider_session_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",
                    params![&active_pt, &scope.thread_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (driver, session_id) = pt_row.ok_or_else(|| {
                reject(("orchestration_error", "Active provider thread was not found.".into()))
            })?;
            if driver != "claudeAgent" {
                return Err(reject((
                    "invalid_request",
                    "t3_background_wait is only supported on Claude threads.".into(),
                )));
            }
            if session_id.is_none() {
                return Err(reject((
                    "orchestration_error",
                    "Claude session is not connected.".into(),
                )));
            }
            Ok(active_pt)
        })
        .map_err(|e| ("orchestration_error", e.to_string()))?
        .map_err(|_| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("orchestration_error", "Could not resolve provider thread.".into()))
        })?;

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (matched, unmatched) = claude_executor::await_background_tasks(
        bus,
        &scope.thread_id,
        &provider_thread_id,
        &task_ids,
        waiting,
        &now,
    )
    .map_err(|e| ("orchestration_error", e))?;

    if waiting && matched.is_empty() {
        return Err((
            "invalid_request",
            "None of the requested background task IDs are currently running.".into(),
        ));
    }

    Ok(json!({
        "matched": matched,
        "unmatched": unmatched,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workflow_stop_and_background_wait_validate_inputs_and_state() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = "2026-11-15T00:00:00.000Z";
        db.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'P1', '/tmp', '[]', ?1, ?1)",
            [now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, payload_json) VALUES ('t1', 'p1', 'T1', 'codex', 'codex', 'full-access', 'default', 'pt1', ?1, ?1, '{}')",
            [now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json) VALUES ('r1', 't1', 1, 'codex', 'codex', 'running', ?1, '{\"id\":\"r1\",\"status\":\"running\",\"ordinal\":1,\"providerInstanceId\":\"codex\"}')",
            [now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, owner_node_id, provider, provider_instance_id, provider_session_id, status, updated_at, payload_json) VALUES ('pt1', 't1', NULL, 'codex', 'codex', 'sess-1', 'ready', ?1, '{}')",
            [now],
        )
        .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json) VALUES ('sub-1', 't1', 'n1', 'claudeAgent', 'provider_native', 'completed', ?1, '{\"id\":\"sub-1\",\"threadId\":\"t1\",\"status\":\"completed\",\"origin\":\"provider_native\",\"driver\":\"claudeAgent\",\"workflow\":{\"kind\":\"team\"}}')",
            [now],
        )
        .unwrap();

        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "t1".into(),
            provider_instance_id: "codex".into(),
            provider_session_id: "sess-1".into(),
            ..Default::default()
        };

        // Non-running workflow fails with invalid_request.
        let err = stop_workflow(
            &bus,
            Some(&scope),
            &json!({ "threadId": "t1", "subagentId": "sub-1" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, "invalid_request");

        // Non-Claude thread fails background wait with invalid_request.
        let err = await_background_tasks(&bus, &scope, &json!({ "taskIds": ["bg-1"] }))
            .unwrap_err();
        assert_eq!(err.0, "invalid_request");
    }
}
