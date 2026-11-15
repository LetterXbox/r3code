//! Best-effort cleanup after an app-owned child settles.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
    outbox::{self, Effect},
    thread_question_dismiss,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Find pending message questions on the result run's restart ancestry. The caller
/// supplies its computed progress and whether restart-continuation work is pending.
pub fn question_ids(
    runs: &[Value],
    nodes: &[Value],
    requests: &[Value],
    result_run: &Value,
    task_cancelled: bool,
    progress: &str,
    restart_pending: bool,
) -> Vec<String> {
    if restart_pending
        || if task_cancelled {
            progress == "working"
        } else {
            progress != "result_available"
        }
    {
        return vec![];
    }
    if !task_cancelled
        && !matches!(
            result_run["status"].as_str(),
            Some("interrupted" | "cancelled" | "stopped")
        )
    {
        return vec![];
    }
    let mut chain = HashSet::new();
    let mut current = result_run["id"].as_str();
    while let Some(id) = current {
        if !chain.insert(id.to_owned()) {
            break;
        }
        current = runs
            .iter()
            .find(|r| r["id"] == id)
            .and_then(|r| r["restartContinuationOfRunId"].as_str());
    }
    requests
        .iter()
        .filter(|q| {
            q["status"] == "pending"
                && q["kind"] == "user_input"
                && q["responseCapability"]["type"] == "message"
                && nodes.iter().any(|n| {
                    n["id"] == q["nodeId"]
                        && n["runId"].as_str().is_some_and(|id| chain.contains(id))
                })
        })
        .filter_map(|q| q["id"].as_str().map(str::to_owned))
        .collect()
}

/// Dismiss each question independently; a failed dispatch does not block others.
pub fn dismiss_questions(bus: &EventBus, child_id: &str, ids: &[String], now: &str) {
    for id in ids {
        if let Err(error) = thread_question_dismiss::dispatch(
            bus,
            &format!("command:system:delegated-task-question:{id}"),
            child_id,
            id,
            now,
        ) {
            eprintln!("Failed to dismiss task question {id}: {error:?}");
        }
    }
}

/// Detach eligible child sessions atomically after the caller establishes that
/// child progress is result_available. Background work is rechecked in the transaction.
pub fn release_sessions(
    bus: &EventBus,
    child_id: &str,
    run_id: &str,
    progress: &str,
    now: &str,
) -> Result<usize, BusError> {
    if progress != "result_available" {
        return Ok(0);
    }
    bus.commit(|tx| {
        let background: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0)", [child_id], |r| r.get(0))?;
        let active_runs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status NOT IN ('completed','failed','interrupted','cancelled','rolled_back') AND NOT (status='queued' AND COALESCE(json_extract(payload_json,'$.queueHeld'),0)=1))", [child_id], |r| r.get(0))?;
        let active_children: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND (status IN ('pending','idle','running','waiting') OR completion_delivery_state IN ('pending','claimed')))", [child_id], |r| r.get(0))?;
        let restart: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_effect_outbox e ON e.effect_id=('effect:restart-continuation:' || r.run_id) WHERE r.thread_id=?1 AND e.status IN ('pending','running') AND r.ordinal >= COALESCE((SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id=?2 AND thread_id=?1), 0))", params![child_id,run_id], |r| r.get(0))?;
        if background || active_runs || active_children || restart { return Ok((0, vec![])); }
        let mut stmt = tx.prepare("SELECT s.provider_session_id,s.payload_json FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.status NOT IN ('stopped','error') ORDER BY s.provider_session_id")?;
        let sessions = stmt.query_map([child_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut events = Vec::new();
        for (id, raw) in sessions {
            let session: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if session["capabilities"]["sessions"]["supportsMultipleProviderThreadsPerSession"] == true { continue; }
            let command = format!("command:system:delegated-task-release:{run_id}:{id}");
            tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2", params![child_id,id])?;
            outbox::enqueue(tx, &Effect { id:format!("effect:{command}:provider-session.detach:{id}"), command_id:command.clone(), thread_id:child_id.into(), request:json!({"type":"provider-session.detach","providerSessionId":id,"detail":"Delegated task finished."}), status:"pending".into(), attempt_count:0, available_at:now.into(), lease_owner:None, created_at:now.into(), updated_at:now.into(), completed_at:None, last_error:None })?;
            events.push(Event { id:uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:child_id.into(), event_type:"provider-session.detached".into(), occurred_at:now.into(), command_id:Some(command.clone()), causation_event_id:None, correlation_id:Some(command), actor_kind:"system".into(), payload:json!({"providerSessionId":id,"detachedAt":now,"reason":"Delegated task finished."}), metadata:json!({}) });
        }
        let count = events.len();
        Ok((count, event_store::append(tx, &events)?))
    })
}

/// Scan finalized children and perform cleanup outside the snapshot transaction.
pub fn cleanup_pending(bus: &EventBus, now: &str) -> Result<(), BusError> {
    let jobs = bus.commit(|tx| {
        fn rows(tx: &rusqlite::Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Vec<Value>> {
            let mut stmt = tx.prepare(sql)?;
            let raw = stmt.query_map([id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            raw.into_iter().map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).collect()
        }
        let children = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE json_extract(payload_json,'$.lineage.relationshipToParent')='subagent' AND deleted_at IS NULL AND ?1=?1", "")?;
        let mut jobs = Vec::new();
        for child in children {
            let (Some(id), Some(parent), Some(original)) = (child["id"].as_str(), child["lineage"]["parentThreadId"].as_str(), child["forkedFrom"]["nodeId"].as_str()) else { continue };
            if child["forkedFrom"]["type"] != "node" { continue; }
            let runs = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal", id)?;
            let Some(run) = runs.iter().rev().find(|r| r["status"] != "rolled_back" && !(r["status"] == "queued" && r["queueHeld"] == true)) else { continue };
            let Some(run_id) = run["id"].as_str() else { continue };
            let working = runs.iter().any(|r| !(matches!(r["status"].as_str(), Some("completed"|"failed"|"interrupted"|"cancelled"|"rolled_back")) || r["status"] == "queued" && r["queueHeld"] == true));
            let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND status IN ('pending','idle','running','waiting'))", [id], |r|r.get(0))?;
            let background: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND json_array_length(COALESCE(json_extract(payload_json,'$.pendingBackgroundTasks'),'[]'))>0)", [id], |r|r.get(0))?;
            let progress = if working || active || background {"working"} else {"result_available"};
            let restart_pending = runs.iter().filter(|r| r["ordinal"].as_i64().unwrap_or(0) >= run["ordinal"].as_i64().unwrap_or(0)).any(|r| {
                let effect = format!("effect:restart-continuation:{}", r["id"].as_str().unwrap_or(""));
                tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1 AND status IN ('pending','running'))", [effect], |r|r.get::<_,bool>(0)).unwrap_or(true)
            });
            let tasks = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned'", parent)?;
            let task_id = run["delegatedTaskId"].as_str().unwrap_or(original);
            let task = tasks.iter().find(|t| t["id"] == task_id && t["childThreadId"] == id);
            let cancelled = task.is_some_and(|t| t["cancelledRunId"] == run_id);
            let published: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 AND target_thread_id=?2 AND type='subagent_result' AND (json_extract(payload_json,'$.sourcePoint.runId')=?3 OR json_extract(payload_json,'$.sourcePoint.runId') IS NULL))", params![id,parent,run_id], |r|r.get(0))?;
            let nodes = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id=?1", id)?;
            let requests = rows(tx, "SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1", id)?;
            let ids = if task.is_some() { question_ids(&runs, &nodes, &requests, run, cancelled, progress, restart_pending) } else { vec![] };
            jobs.push((id.to_owned(), run_id.to_owned(), progress.to_owned(), published && !restart_pending, ids));
        }
        Ok((jobs, vec![]))
    })?;
    for (child, run, progress, published, ids) in jobs {
        if published {
            if let Err(error) = release_sessions(bus, &child, &run, &progress, now) {
                eprintln!("Failed to release delegated task session: {error:?}");
            }
        }
        dismiss_questions(bus, &child, &ids, now);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn questions_follow_only_restart_ancestry_and_require_terminal_eligibility() {
        let runs = vec![
            json!({"id":"a"}),
            json!({"id":"b","status":"interrupted","restartContinuationOfRunId":"a"}),
            json!({"id":"other"}),
        ];
        let nodes = vec![
            json!({"id":"n1","runId":"a"}),
            json!({"id":"n2","runId":"other"}),
        ];
        let requests = vec![
            json!({"id":"q1","nodeId":"n1","status":"pending","kind":"user_input","responseCapability":{"type":"message"}}),
            json!({"id":"q2","nodeId":"n2","status":"pending","kind":"user_input","responseCapability":{"type":"message"}}),
        ];
        assert_eq!(
            question_ids(
                &runs,
                &nodes,
                &requests,
                &runs[1],
                false,
                "result_available",
                false
            ),
            vec!["q1"]
        );
        assert!(
            question_ids(&runs, &nodes, &requests, &runs[1], false, "working", false).is_empty()
        );
        assert!(question_ids(
            &runs,
            &nodes,
            &requests,
            &runs[1],
            false,
            "result_available",
            true
        )
        .is_empty());
        assert!(question_ids(
            &runs,
            &nodes,
            &requests,
            &json!({"id":"b","status":"completed"}),
            false,
            "result_available",
            false
        )
        .is_empty());
    }
    #[test]
    fn release_respects_background_and_shared_sessions_and_is_idempotent() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, shared) in [("single", false), ("shared", true)] {
            db.execute("INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES(?1,'child','codex','ready','now',?2)", params![id,json!({"capabilities":{"sessions":{"supportsMultipleProviderThreadsPerSession":shared}}}).to_string()]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES(?1,'child')", [id]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','child','codex','ready','now',?1)", [json!({"pendingBackgroundTasks":[{}]}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        assert_eq!(
            release_sessions(&bus, "child", "run", "result_available", "now").unwrap(),
            0
        );
        bus.commit(|tx| {
            tx.execute(
                "UPDATE orchestration_v2_projection_provider_threads SET payload_json='{}'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert_eq!(
            release_sessions(&bus, "child", "run", "working", "now").unwrap(),
            0
        );
        // A new run or restart effect may appear after the caller's snapshot.
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('run','child',1,'codex','completed','now','{}')",[])?;
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('new','child',2,'codex','queued','now','{}')",[])?;
            Ok(((),vec![]))
        }).unwrap();
        assert_eq!(
            release_sessions(&bus, "child", "run", "result_available", "now").unwrap(),
            0
        );
        bus.commit(|tx| {
            tx.execute("DELETE FROM orchestration_v2_projection_runs WHERE run_id='new'",[])?;
            tx.execute("INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,available_at,created_at,updated_at) VALUES('effect:restart-continuation:run','cmd','child','restart-continuation','{}','pending','now','now','now')",[])?;
            Ok(((),vec![]))
        }).unwrap();
        assert_eq!(
            release_sessions(&bus, "child", "run", "result_available", "now").unwrap(),
            0
        );
        bus.commit(|tx| { tx.execute("DELETE FROM orchestration_v2_effect_outbox WHERE effect_id='effect:restart-continuation:run'",[])?; Ok(((),vec![])) }).unwrap();
        assert_eq!(
            release_sessions(&bus, "child", "run", "result_available", "now").unwrap(),
            1
        );
        assert_eq!(
            release_sessions(&bus, "child", "run", "result_available", "now").unwrap(),
            0
        );
        bus.commit(|tx| { let remaining: i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='shared'",[],|r|r.get(0))?; assert_eq!(remaining,1); Ok(((),vec![])) }).unwrap();
    }
}
