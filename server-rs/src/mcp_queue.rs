//! MCP access to queued runs.
use crate::{
    event_bus::EventBus,
    mcp_credentials::Scope,
    queue_ops::{self, QueueOp},
    queue_reorder, queue_steer,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
type Failure = (&'static str, String);
fn invalid(s: impl Into<String>) -> Failure {
    ("invalid_request", s.into())
}
fn rank(s: &str) -> Option<u8> {
    match s {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    }
}
pub fn definition() -> Value {
    json!({"name":"t3_queue","description":"Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"action":{"enum":["list","read","edit","cancel","reorder","promote_to_steer"]},"queuedRunId":{"type":"string"},"text":{"type":"string","maxLength":100000},"beforeRunId":{"type":["string","null"]},"targetRunId":{"type":"string"},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["action"],"additionalProperties":false},"annotations":{"destructiveHint":true}})
}
pub fn call(bus: &EventBus, scope: &Scope, args: &Value, now: &str) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    let obj = args
        .as_object()
        .ok_or_else(|| invalid("Invalid arguments."))?;
    if obj.keys().any(|k| {
        ![
            "environmentId",
            "threadId",
            "action",
            "queuedRunId",
            "text",
            "beforeRunId",
            "targetRunId",
            "cursor",
            "limit",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Invalid arguments."));
    }
    let action = args["action"]
        .as_str()
        .filter(|a| {
            [
                "list",
                "read",
                "edit",
                "cancel",
                "reorder",
                "promote_to_steer",
            ]
            .contains(a)
        })
        .ok_or_else(|| invalid("Invalid action."))?;
    let target = match obj.get("threadId") {
        None => scope.thread_id.as_str(),
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => return Err(invalid("Invalid threadId.")),
    };
    if target.is_empty() {
        return Err((
            "target_required",
            "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
        ));
    }
    let required = |key: &str| -> Result<&str, Failure> {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid(format!("This action needs `{key}`.")))
    };
    let id = if action != "list" {
        Some(required("queuedRunId")?)
    } else {
        None
    };
    let cursor = match obj.get("cursor") {
        None => 0,
        Some(v) => v.as_u64().ok_or_else(|| invalid("Invalid cursor."))? as usize,
    };
    let limit = match obj.get("limit") {
        None => 20,
        Some(v) => v
            .as_u64()
            .filter(|v| (1..=100).contains(v))
            .ok_or_else(|| invalid("Invalid limit."))? as usize,
    };
    if action == "list" || action == "read" {
        return bus.commit(|tx|{
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",[target],|r|r.get(0))?;
  if !exists{return Ok((Err(("thread_not_found","The thread was not found.".into())),vec![]));}
  let mut stmt=tx.prepare("SELECT r.payload_json,m.payload_json FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.thread_id=r.thread_id AND m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status='queued'")?;
  let rows=stmt.query_map([target],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
  let mut runs=Vec::new(); for (r,m) in rows {let r:Value=serde_json::from_str(&r).map_err(|_|rusqlite::Error::InvalidQuery)?;let m:Option<Value>=m.map(|v|serde_json::from_str(&v)).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?;runs.push((r,m));}
  runs.sort_by_key(|(r,m)|(m.as_ref().is_none_or(|m|m["delegatedCompletion"].is_null()),r["queuePosition"].as_i64().or_else(||r["ordinal"].as_i64()).unwrap_or(i64::MAX),r["ordinal"].as_i64().unwrap_or(i64::MAX)));
  let entry=|(r,m): &(Value,Option<Value>), n:usize| -> Option<Value> {let m=m.as_ref()?;let text=m["text"].as_str()?;let chars:Vec<char>=text.chars().collect();Some(json!({"queuedRunId":r["id"],"text":chars.iter().take(n).collect::<String>(),"truncated":chars.len()>n}))};
  if action=="read" {let value=runs.iter().find(|(r,_)|r["id"]==id.unwrap()).and_then(|r|entry(r,16000)).ok_or_else(||invalid("The queued message was not found."));return Ok((value,vec![]));}
  let end=cursor.saturating_add(limit);let items:Vec<_>=runs.iter().skip(cursor).take(limit).filter_map(|r|entry(r,1000)).collect();Ok((Ok(json!({"items":items,"nextCursor":if end<runs.len(){Some(end)}else{None}})),vec![]))
 }).map_err(|e|("orchestration_error",e.to_string()))?;
    }
    let text = if action == "edit" {
        let t = required("text")?;
        if t.chars().count() > 100000 {
            return Err(invalid("Invalid text."));
        }
        Some(t)
    } else {
        None
    };
    let before = if action == "reorder" {
        match obj.get("beforeRunId") {
            None => return Err(invalid("This action needs `beforeRunId`.")),
            Some(Value::Null) => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
            _ => return Err(invalid("Invalid beforeRunId.")),
        }
    } else {
        None
    };
    let steer_target = if action == "promote_to_steer" {
        Some(required("targetRunId")?)
    } else {
        None
    };
    let denied = std::cell::RefCell::new(None::<Failure>);
    let check = |tx: &rusqlite::Transaction<'_>| {
        let reject = |f| {
            *denied.borrow_mut() = Some(f);
            rusqlite::Error::InvalidQuery
        };
        let caller:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (pr, pi) = caller.ok_or_else(|| {
            reject((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            ))
        })?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND provider_instance_id=?2)",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0))?;
        if !active {
            return Err(reject((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            )));
        }
        let modes:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (rt, it) = modes
            .ok_or_else(|| reject(("thread_not_found", "The thread was not found.".into())))?;
        if rank(&rt).is_none() || rank(&pr).is_none() || rank(&rt) > rank(&pr) {
            return Err(reject((
                "runtime_mode_escalation_denied",
                "The target thread exceeds the caller's runtime mode.".into(),
            )));
        }
        if pi == "plan" && it != "plan" {
            return Err(reject((
                "interaction_mode_escalation_denied",
                "The target thread exceeds the caller's interaction mode.".into(),
            )));
        }
        crate::mcp_thread_organize::check_link(tx, scope, target).map_err(&reject)?;
        if let Some(edit_text) = text {
            if edit_text.trim().eq_ignore_ascii_case("/logout") {
                let empty_attachments: bool = tx
                    .query_row(
                        "SELECT COALESCE(json_array_length(json_extract(m.payload_json,'$.attachments')),0)=0 FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.run_id=?1 AND r.thread_id=?2",
                        params![id.unwrap(), target],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or(true);
                if empty_attachments {
                    return Err(reject((
                        "invalid_request",
                        "A queued message cannot be edited into a provider sign-out.".into(),
                    )));
                }
            }
        }
        Ok(())
    };
    let command = format!("mcp:{}", uuid::Uuid::new_v4());
    let result = match action {
        "promote_to_steer" => queue_steer::dispatch_checked(
            bus,
            &command,
            target,
            id.unwrap(),
            steer_target.unwrap(),
            now,
            check,
        ),
        "reorder" => {
            queue_reorder::dispatch_checked(bus, &command, target, id.unwrap(), before, now, check)
        }
        _ => queue_ops::dispatch_checked(
            bus,
            &command,
            target,
            id.unwrap(),
            if let Some(text) = text {
                QueueOp::Edit {
                    text,
                    attachments: None,
                    context: None,
                }
            } else {
                QueueOp::Cancel
            },
            now,
            check,
        ),
    }
    .map_err(|e| {
        denied
            .into_inner()
            .unwrap_or_else(|| ("orchestration_error", e.to_string()))
    })?;
    if result.receipt.status != "accepted" {
        return Err((
            "orchestration_error",
            result
                .receipt
                .error
                .unwrap_or_else(|| "The operation could not be completed.".into()),
        ));
    }
    Ok(json!({"sequence":result.receipt.result_sequence}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn list_read_and_edit_respect_ownership() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')",[]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('active','t',1,'codex','provider','running','now','{}')",[]).unwrap();
        let m = json!({"id":"m","text":"hello"});
        let r = json!({"id":"q","ordinal":2,"queuePosition":1,"userMessageId":"m"});
        db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'now','now',?1)",[m.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('q','t',2,'codex','queued','now',?1)",[r.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let mut scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "provider".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        assert_eq!(
            call(&bus, &scope, &json!({"action":"list"}), "now").unwrap()["items"][0]["text"],
            "hello"
        );
        scope.provider_instance_id = "other".into();
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"edit","queuedRunId":"q","text":"changed"}),
                "now"
            )
            .unwrap_err()
            .0,
            "parent_not_active"
        );
        scope.provider_instance_id = "provider".into();
        call(
            &bus,
            &scope,
            &json!({"action":"edit","queuedRunId":"q","text":"changed"}),
            "now",
        )
        .unwrap();
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"read","queuedRunId":"q"}),
                "now"
            )
            .unwrap()["text"],
            "changed"
        );
    }
}
