//! MCP context transfers with transaction-scoped write authorization.
use crate::{
    event_bus::EventBus,
    fork_commands::{self, ForkThread},
    mcp_credentials::Scope,
    merge_commands::{self, Merge},
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
    json!({"name":"t3_thread_transfer","description":"Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"action":{"enum":["fork","merge_back","status"]},"sourcePoint":{"type":"object","oneOf":[{"properties":{"type":{"const":"latest_stable"}},"required":["type"],"additionalProperties":false},{"properties":{"type":{"const":"run"},"runId":{"type":"string"}},"required":["type","runId"],"additionalProperties":false},{"properties":{"type":{"const":"checkpoint"},"checkpointId":{"type":"string"}},"required":["type","checkpointId"],"additionalProperties":false}]},"targetThreadId":{"type":"string"},"title":{"type":"string","minLength":1}},"required":["action"],"additionalProperties":false},"annotations":{"destructiveHint":true}})
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
            "sourcePoint",
            "targetThreadId",
            "title",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Invalid arguments."));
    }
    let action = args["action"]
        .as_str()
        .filter(|s| ["fork", "merge_back", "status"].contains(s))
        .ok_or_else(|| invalid("Invalid action."))?;
    let source = match obj.get("threadId") {
        None => scope.thread_id.as_str(),
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => return Err(invalid("Invalid threadId.")),
    };
    if source.is_empty() {
        return Err((
            "target_required",
            "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
        ));
    }
    let target = match obj.get("targetThreadId") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        _ => return Err(invalid("Invalid targetThreadId.")),
    };
    let title = match obj.get("title") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim()),
        _ => return Err(invalid("Invalid title.")),
    };
    let default_point = json!({"type":"latest_stable"});
    let point = obj.get("sourcePoint").unwrap_or(&default_point);
    let valid = point
        .as_object()
        .is_some_and(|m| match point["type"].as_str() {
            Some("latest_stable") => m.len() == 1,
            Some("run") => m.len() == 2 && point["runId"].as_str().is_some_and(|s| !s.is_empty()),
            Some("checkpoint") => {
                m.len() == 2
                    && point["checkpointId"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
            }
            _ => false,
        });
    if !valid {
        return Err(invalid("Invalid sourcePoint."));
    }
    if action == "status" {
        return bus.commit(|tx|{let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",[source],|r|r.get(0))?;if !exists{return Ok((Err(("thread_not_found","The thread was not found.".into())),vec![]));}let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 OR target_thread_id=?1 ORDER BY rowid")?;let rows=stmt.query_map([source],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;let mut transfers=Vec::new();for row in rows{let t:Value=serde_json::from_str(&row).map_err(|_|rusqlite::Error::InvalidQuery)?;transfers.push(json!({"id":t["id"],"sourceThreadId":t["sourceThreadId"],"targetThreadId":t["targetThreadId"],"status":t["status"]}));}Ok((Ok(json!({"transfers":transfers})),vec![]))}).map_err(|e|("orchestration_error",e.to_string()))?;
    }
    let target = if action == "merge_back" {
        Some(target.ok_or_else(|| invalid("This action needs `targetThreadId`."))?)
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
        let mut project = None;
        for id in std::iter::once(source).chain(target) {
            let modes:Option<(String,String,Option<String>)>=tx.query_row("SELECT runtime_mode,interaction_mode,project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (rt, it, p) = modes
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
            crate::mcp_thread_organize::check_link(tx, scope, id).map_err(&reject)?;
            if let Some(previous) = &project {
                if previous != &p {
                    return Err(reject(invalid("Threads must belong to the same project.")));
                }
            } else {
                project = Some(p);
            }
        }
        Ok(())
    };
    let command = format!("mcp:{}", uuid::Uuid::new_v4());
    let fork_target = format!("{command}:fork");
    let dest = target.unwrap_or(&fork_target);
    let result = if action == "fork" {
        let source_kind = json!("mcp");
        let ev1 = format!("event:{}", uuid::Uuid::new_v4());
        let ev2 = format!("event:{}", uuid::Uuid::new_v4());
        let transfer = format!("context-transfer:{}", uuid::Uuid::new_v4());
        fork_commands::fork_thread_ordered_checked(
            bus,
            ForkThread {
                command_id: &command,
                source_thread_id: source,
                target_thread_id: dest,
                source_point: point,
                title,
                side_chat: false,
                created_by: "agent",
                creation_source: &source_kind,
            },
            [&ev1, &ev2],
            &transfer,
            now,
            check,
        )
    } else {
        merge_commands::dispatch_checked(
            bus,
            Merge {
                command_id: &command,
                source,
                target: dest,
                source_point: point,
                created_by: "agent",
            },
            now,
            check,
        )
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
    Ok(json!({"sequence":result.receipt.result_sequence,"targetThreadId":dest}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn status_and_atomic_write_checks() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, mode) in [("caller", "auto"), ("source", "full-access")] {
            let thread = json!({"id":id,"projectId":"p","title":id,"providerInstanceId":"codex","runtimeMode":mode,"interactionMode":"default","lineage":{"rootThreadId":id}});
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex',?2,'default','now','now',?3)",params![id,mode,thread.to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('caller-run','caller',1,'codex','provider','running','now','{}')",[]).unwrap();
        let run = json!({"id":"r","status":"completed","ordinal":1,"checkpointId":"cp"});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','source',1,'codex','completed','now',?1)",[run.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let mut scope = Scope {
            thread_id: "caller".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "wrong".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let input = json!({"action":"fork","threadId":"source"});
        assert_eq!(
            call(&bus, &scope, &input, "now").unwrap_err().0,
            "parent_not_active"
        );
        scope.provider_instance_id = "provider".into();
        assert_eq!(
            call(&bus, &scope, &input, "now").unwrap_err().0,
            "runtime_mode_escalation_denied"
        );
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='auto',payload_json=json_set(payload_json,'$.runtimeMode','auto') WHERE thread_id='source'",[])?;Ok(((),vec![]))}).unwrap();
        let result = call(&bus, &scope, &input, "now").unwrap();
        let child = result["targetThreadId"].as_str().unwrap();
        assert!(child.starts_with("mcp:"));
        let status = call(
            &bus,
            &scope,
            &json!({"action":"status","threadId":child}),
            "now",
        )
        .unwrap();
        assert_eq!(status["transfers"][0]["sourceThreadId"], "source");
        bus.commit(|tx| {
            let run = json!({"id":"child-run","ordinal":1,"status":"completed","checkpointId":"cp-child","providerInstanceId":"codex"});
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('child-run',?1,1,'codex','completed','now',?2)",params![child,run.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let merged=call(&bus,&scope,&json!({"action":"merge_back","threadId":child,"targetThreadId":"source","sourcePoint":{"type":"run","runId":"child-run"}}),"now").unwrap();
        assert_eq!(merged["targetThreadId"], "source");
        let status = call(
            &bus,
            &scope,
            &json!({"action":"status","threadId":"source"}),
            "now",
        )
        .unwrap();
        assert!(status["transfers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["sourceThreadId"] == child && t["status"] == "pending"));
    }
}
