//! MCP thread configuration for provider-issued thread credentials.
use crate::{
    event_bus::EventBus, mcp_credentials::Scope, provider::session_registry::SessionRegistry,
    provider_selection,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{cell::RefCell, path::Path};
type Failure = (&'static str, String);
fn invalid(s: &str) -> Failure {
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
fn interaction(s: &str) -> Option<u8> {
    match s {
        "plan" => Some(0),
        "default" => Some(1),
        _ => None,
    }
}
fn db_error(e: impl std::fmt::Display) -> Failure {
    ("orchestration_error", e.to_string())
}

fn normalize_options(value: &Value) -> Option<Value> {
    value
        .as_array()?
        .iter()
        .map(|option| {
            let obj = option.as_object()?;
            if obj.keys().any(|k| k != "id" && k != "value") {
                return None;
            }
            let id = option["id"].as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let value = match &option["value"] {
                Value::String(s) if !s.trim().is_empty() => json!(s.trim()),
                Value::Bool(_) => option["value"].clone(),
                _ => return None,
            };
            Some(json!({"id":id,"value":value}))
        })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

pub fn definition() -> Value {
    json!({"name":"t3_thread_configure","description":"Read a thread's provider, model, and modes, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"modelSelection":{"type":"object","properties":{"instanceId":{"type":"string"},"model":{"type":"string"},"options":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"value":{"anyOf":[{"type":"string"},{"type":"boolean"}]}},"required":["id","value"],"additionalProperties":false}}},"required":["instanceId","model"],"additionalProperties":false}},"additionalProperties":false},"annotations":{"title":"Use thread model settings","readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}})
}
/// Router must check environmentId and authenticate the credential before calling.
pub fn call(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    now: &str,
    settings_path: &Path,
    sessions: &SessionRegistry,
) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let obj = args
        .as_object()
        .ok_or_else(|| invalid("Invalid arguments."))?;
    if obj
        .keys()
        .any(|k| !["environmentId", "threadId", "modelSelection"].contains(&k.as_str()))
    {
        return Err(invalid("Invalid arguments."));
    }
    let target = match obj.get("threadId") {
        None => scope.thread_id.as_str(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.as_str(),
        _ => return Err(invalid("Invalid threadId.")),
    };
    if target.is_empty() {
        return Err((
            "target_required",
            "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
        ));
    }
    let selection = match obj.get("modelSelection") {
        None => None,
        Some(v) => {
            let m = v
                .as_object()
                .ok_or_else(|| invalid("Invalid modelSelection."))?;
            if m.keys()
                .any(|k| !["instanceId", "model", "options"].contains(&k.as_str()))
            {
                return Err(invalid("Invalid modelSelection."));
            }
            let instance = v["instanceId"]
                .as_str()
                .map(str::trim)
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 64
                        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
                .ok_or_else(|| invalid("Invalid modelSelection."))?;
            let model = v["model"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("Invalid modelSelection."))?;
            let mut normalized = json!({"instanceId":instance,"model":model});
            if let Some(options) = v.get("options") {
                if !options.is_array() {
                    return Err(invalid("Invalid modelSelection."));
                }
                normalized["options"] =
                    normalize_options(options).ok_or_else(|| invalid("Invalid modelSelection."))?;
            }
            Some(normalized)
        }
    };
    let thread = bus.commit(|tx| {
        let row:Option<(String,String,String)>=tx.query_row("SELECT payload_json,runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        Ok((row,vec![]))
    }).map_err(db_error)?;
    let (raw, runtime, interaction_mode) =
        thread.ok_or_else(|| ("thread_not_found", "The thread was not found.".into()))?;
    let mut thread: Value = serde_json::from_str(&raw).map_err(db_error)?;
    thread["runtimeMode"] = json!(runtime);
    thread["interactionMode"] = json!(interaction_mode);
    let Some(selection) = selection else {
        return Ok(
            json!({"threadId":target,"modelSelection":thread["modelSelection"],"runtimeMode":thread["runtimeMode"],"interactionMode":thread["interactionMode"]}),
        );
    };
    let initial_instance = thread["modelSelection"]["instanceId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let explicit_switch = initial_instance != selection["instanceId"].as_str().unwrap_or("");
    let denied = RefCell::new(None::<Failure>);
    let command_id = format!("mcp:{}", uuid::Uuid::new_v4());
    let result=provider_selection::dispatch(bus,&command_id,target,&selection,explicit_switch,now,|tx,current| {
        let check = || -> Result<(),Failure> {
            let caller:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
            let (parent_runtime,parent_interaction)=caller.ok_or_else(||("parent_not_active","The calling provider no longer owns an active thread run.".into()))?;
            let live:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND provider_instance_id=?2)",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0)).map_err(db_error)?;
            if !live { return Err(("parent_not_active","The calling provider no longer owns an active thread run.".into())); }
            let modes:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
            let (runtime,interaction_mode)=modes.ok_or_else(||("thread_not_found","The thread was not found.".into()))?;
            if rank(&runtime).is_none() || rank(&parent_runtime).is_none() || rank(&runtime)>rank(&parent_runtime) {return Err(("runtime_mode_escalation_denied","The target thread exceeds the caller's runtime mode.".into()));}
            if interaction(&interaction_mode).is_none() || interaction(&parent_interaction).is_none() || interaction(&interaction_mode)>interaction(&parent_interaction) {return Err(("interaction_mode_escalation_denied","The target thread exceeds the caller's interaction mode.".into()));}
            crate::mcp_thread_organize::check_link(tx,scope,target)?;
            if current["modelSelection"]["instanceId"].as_str().unwrap_or("") != initial_instance {return Err(("orchestration_error","The thread provider changed while this call ran. Retry the request.".into()));}
            Ok(())
        };
        if let Err(failure)=check() {let message=failure.1.clone(); *denied.borrow_mut()=Some(failure); return Err(message);}
        provider_selection::codex_decision(tx,current,&selection,settings_path,sessions)
    }).map_err(db_error)?;
    if let Some(failure) = denied.into_inner() {
        return Err(failure);
    }
    if let Some(error) = result.receipt.error {
        return Err(("orchestration_error", error));
    }
    Ok(json!({"sequence":result.receipt.result_sequence}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    fn setup() -> (EventBus, Scope, SessionRegistry) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, mode) in [("caller", "auto"), ("target", "auto")] {
            let payload = json!({"id":id,"modelSelection":{"instanceId":"codex","model":"old"},"providerInstanceId":"codex","runtimeMode":mode,"interactionMode":"default","deletedAt":null});
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','codex',?2,'default','now','now',?3)",params![id,mode,payload.to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('run','caller',1,'codex','codex','running','now','{}')",[]).unwrap();
        (
            EventBus::new(db, 8),
            Scope {
                thread_id: "caller".into(),
                provider_session_id: "session".into(),
                provider_instance_id: "codex".into(),
                capabilities: HashSet::from(["orchestration".into()]),
                subagent: false, client: None,
            },
            SessionRegistry::default(),
        )
    }
    #[test]
    fn read_write_and_mode_guards() {
        let (bus, scope, sessions) = setup();
        let path = Path::new("/nonexistent-t3-settings");
        let invoke =
            |args: &Value| call(&bus, &scope, args, "2026-01-01T00:00:00Z", path, &sessions);
        let read = invoke(&json!({"threadId":"target"})).unwrap();
        assert_eq!(read["modelSelection"]["model"], "old");
        assert_eq!(read["runtimeMode"], "auto");
        let result = invoke(
            &json!({"threadId":"target","modelSelection":{"instanceId":"codex","model":"new"}}),
        )
        .unwrap();
        assert!(result["sequence"].as_i64().is_some());
        assert_eq!(
            invoke(&json!({"threadId":"target"})).unwrap()["modelSelection"]["model"],
            "new"
        );
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='full-access' WHERE thread_id='target'",[])?;Ok(((),vec![]))}).unwrap();
        assert_eq!(invoke(&json!({"threadId":"target","modelSelection":{"instanceId":"codex","model":"other"}})).unwrap_err().0,"runtime_mode_escalation_denied");
        assert_eq!(
            invoke(&json!({"threadId":"target"})).unwrap()["modelSelection"]["model"],
            "new"
        );
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='auto',interaction_mode='plan' WHERE thread_id='caller'",[])?; Ok(((),vec![]))}).unwrap();
        bus.commit(|tx|{tx.execute("UPDATE orchestration_v2_projection_threads SET runtime_mode='auto' WHERE thread_id='target'",[])?; Ok(((),vec![]))}).unwrap();
        assert_eq!(invoke(&json!({"threadId":"target","modelSelection":{"instanceId":"codex","model":"other"}})).unwrap_err().0,"interaction_mode_escalation_denied");
    }
    #[test]
    fn requires_capability_and_live_caller_for_writes() {
        let (bus, mut scope, sessions) = setup();
        let args = json!({"modelSelection":{"instanceId":"codex","model":"new"}});
        scope.capabilities.clear();
        assert_eq!(
            call(
                &bus,
                &scope,
                &args,
                "now",
                Path::new("/nonexistent"),
                &sessions
            )
            .unwrap_err()
            .0,
            "capability_denied"
        );
        scope.capabilities.insert("orchestration".into());
        bus.commit(|tx| {
            tx.execute(
                "UPDATE orchestration_v2_projection_runs SET status='completed'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert_eq!(
            call(
                &bus,
                &scope,
                &args,
                "now",
                Path::new("/nonexistent"),
                &sessions
            )
            .unwrap_err()
            .0,
            "parent_not_active"
        );
    }
}
