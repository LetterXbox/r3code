//! Reconcile accepted scheduled messages with their eventual provider outcome.
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

pub fn reconcile(db: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let mut stmt = db.prepare("SELECT task_id, last_run_at, last_run_webhook_delivery_id FROM scheduled_tasks WHERE last_run_status='succeeded' AND last_run_at IS NOT NULL").map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let mut changed = 0;
    for (task, started, delivery) in tasks {
        let Ok(time) = DateTime::parse_from_rfc3339(&started) else {
            continue;
        };
        if now
            .signed_duration_since(time.with_timezone(&Utc))
            .num_hours()
            >= 24
        {
            continue;
        }
        let prefix = format!(
            "scheduled-task-message:{}:{}:",
            task,
            time.timestamp_millis()
        );
        let webhook_message = delivery
            .as_ref()
            .map(|id| format!("scheduled-task-message:{task}:webhook:{id}"));
        let result: Option<(String, String, Option<String>, String)> = db.query_row(
            "SELECT r.run_id,r.status,m.run_id,r.payload_json FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE m.message_id=?2 OR (substr(m.message_id,1,length(?1))=?1 AND (m.message_id=?1 || 'webhook' OR (?2 IS NULL AND m.message_id IN (?1 || 'manual',?1 || 'scheduled'))) ) ORDER BY m.message_id=?2 DESC LIMIT 1",
            params![prefix,webhook_message], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((run, status, message_run, payload)) = result else {
            continue;
        };
        let fallback = match status.as_str() {
            "failed" => "The run failed.",
            "interrupted" => "The run was stopped.",
            "cancelled" if message_run.as_deref() == Some(&run) => "The run was cancelled.",
            "rolled_back" => "The run was rolled back.",
            _ => continue,
        };
        let root = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| v["rootNodeId"].as_str().map(str::to_owned));
        let error: Option<String> = if status == "failed" && root.is_some() {
            db.query_row("SELECT json_extract(payload_json,'$.failure.message') FROM orchestration_v2_projection_turn_items WHERE run_id=?1 AND node_id=?2 AND type='error' AND status='failed' ORDER BY updated_at DESC,ordinal DESC,turn_item_id DESC LIMIT 1", params![run,root], |r| r.get(0)).optional().map_err(|e|e.to_string())?.flatten()
        } else {
            None
        };
        changed += db.execute("UPDATE scheduled_tasks SET last_run_status='failed',last_run_error=?3 WHERE task_id=?1 AND last_run_at=?2 AND last_run_status='succeeded' AND last_run_webhook_delivery_id IS ?4", params![task,started,error.as_deref().unwrap_or(fallback),delivery]).map_err(|e|e.to_string())?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_only_the_current_terminal_run_and_ignores_promoted_steers() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/055-base.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/055-scheduled-tasks.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/067.sql"))
            .unwrap();
        db.execute("INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_at,last_run_status,run_count) VALUES('task','t','p',1,'{}','p','{}','{}','auto','default','user','web','x','x','2026-01-01T00:00:00.000Z','succeeded',1)", []).unwrap();
        let id = "scheduled-task-message:task:1767225600000:webhook";
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,'t','r','user',0,'x','x','{}')", [id]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','failed','x',?1)", [json!({"userMessageId":id,"rootNodeId":"root"}).to_string()]).unwrap();
        for (id, node, message) in [
            ("root-error", "root", "provider rejected"),
            ("child-error", "child", "subagent failed"),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t','r',?2,1,'error','failed','x',?3)", params![id,node,json!({"failure":{"message":message}}).to_string()]).unwrap();
        }
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:01:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(reconcile(&db, now).unwrap(), 1);
        let outcome: (String, String, i64) = db
            .query_row(
                "SELECT last_run_status,last_run_error,run_count FROM scheduled_tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(outcome, ("failed".into(), "provider rejected".into(), 1));
        db.execute(
            "UPDATE scheduled_tasks SET last_run_status='succeeded',last_run_error=NULL",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE orchestration_v2_projection_runs SET status='cancelled'",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE orchestration_v2_projection_messages SET run_id='other'",
            [],
        )
        .unwrap();
        assert_eq!(reconcile(&db, now).unwrap(), 0);
        db.execute(
            "UPDATE scheduled_tasks SET last_run_at='2026-01-01T00:02:00.000Z'",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE orchestration_v2_projection_runs SET status='failed'",
            [],
        )
        .unwrap();
        assert_eq!(reconcile(&db, now).unwrap(), 0);

        // Two webhook deliveries can start in the same millisecond. Only the
        // delivery recorded as the current task attempt may set its outcome.
        let newest = "scheduled-task-message:task:webhook:delivery-new";
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,'t','r2','user',0,'x','x','{}')", [newest]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r2','t',2,'codex','failed','x',?1)", [json!({"userMessageId":newest}).to_string()]).unwrap();
        db.execute("UPDATE scheduled_tasks SET last_run_at='2026-01-01T00:00:00.000Z',last_run_webhook_delivery_id='delivery-new',last_run_status='succeeded'", []).unwrap();
        assert_eq!(reconcile(&db, now).unwrap(), 1);
        let (status, error): (String, String) = db
            .query_row(
                "SELECT last_run_status,last_run_error FROM scheduled_tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(error, "The run failed.");
    }
}
