//! MCP thread organization with transaction-scoped caller limits.
use crate::{
    event_bus::{EventBus, Filter},
    mcp_credentials::Scope,
    thread_controls::{self, Control},
    thread_lifecycle::{self, Lifecycle},
    thread_visit,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::cell::RefCell;
type Failure = (&'static str, String);
fn rank(s: &str) -> Option<u8> {
    match s {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    }
}
/// Enforce the linked-origin fence for a mutation target; reads are unrestricted.
pub(crate) fn check_link(tx: &Transaction<'_>, scope: &Scope, target: &str) -> Result<(), Failure> {
    if let Some(client) = scope.client.as_ref() {
        if !client.linked || client.access == "full-access" {
            return Ok(());
        }
        let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [target], |r| r.get(0))
            .map_err(|e| ("orchestration_error", e.to_string()))?;
        let target_payload: Value = serde_json::from_str(&raw).map_err(|e| ("orchestration_error", e.to_string()))?;
        if target_payload["linkOrigin"]["sessionId"].as_str() == Some(client.session_id.as_str()) {
            return Ok(());
        }
        return Err(("capability_denied", format!("This work was started from {} through a linked environment, so it may change only threads that link started. A link paired with full access is not limited this way.", client.label)));
    }
    if target == scope.thread_id { return Ok(()); }
    let read = |id: &str| -> Result<Value, Failure> {
        let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [id], |r| r.get(0))
            .map_err(|e| ("orchestration_error", e.to_string()))?;
        serde_json::from_str(&raw).map_err(|e: serde_json::Error| ("orchestration_error", e.to_string()))
    };
    let caller = read(&scope.thread_id)?;
    let origin = &caller["linkOrigin"];
    if !origin.is_object() || origin["access"] == "full-access" { return Ok(()); }
    let target = read(target)?;
    if origin["sessionId"].as_str().is_some_and(|id| !id.trim().is_empty()) && origin["sessionId"] == target["linkOrigin"]["sessionId"] { return Ok(()); }
    let label = origin["label"].as_str().unwrap_or("a linked environment");
    Err(("capability_denied", format!("This work was started from {label} through a linked environment, so it may change only threads that link started. A link paired with full access is not limited this way.")))
}

pub(crate) fn check_not_linked(tx: &Transaction<'_>, scope: &Scope, what: &str) -> Result<(), Failure> {
    if let Some(client) = scope.client.as_ref() {
        if !client.linked || client.access == "full-access" {
            return Ok(());
        }
        return Err(("capability_denied", format!("This work was started from {} through a linked environment, so it cannot {what}. A link paired with full access is not limited this way.", client.label)));
    }
    let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&scope.thread_id], |r| r.get(0))
        .map_err(|e| ("orchestration_error", e.to_string()))?;
    let caller: Value = serde_json::from_str(&raw).map_err(|e: serde_json::Error| ("orchestration_error", e.to_string()))?;
    let origin = &caller["linkOrigin"];
    if !origin.is_object() || origin["access"] == "full-access" { return Ok(()); }
    let label = origin["label"].as_str().unwrap_or("a linked environment");
    Err(("capability_denied", format!("This work was started from {label} through a linked environment, so it cannot {what}. A link paired with full access is not limited this way.")))
}

pub(crate) fn check(tx: &Transaction<'_>, scope: &Scope, target: &str) -> Result<(), Failure> {
    let (runtime, interaction) = if let Some(client) = scope.client.as_ref() {
        if client.access == "read-only" {
            return Err((
                "capability_denied",
                "This tool changes the environment, and this MCP client was approved for read-only access.".into(),
            ));
        }
        (client.runtime_mode.clone(), client.interaction_mode.clone())
    } else {
        let caller: Option<(String, String, String, Option<String>, String)> = tx.query_row(
            "SELECT runtime_mode,interaction_mode,COALESCE(provider_instance_id,default_provider),archived_at,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
            [&scope.thread_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
        ).optional().map_err(|e| ("orchestration_error", e.to_string()))?;
        let (runtime, interaction, owner, archived, caller_raw) = caller.ok_or_else(|| {
            (
                "thread_not_found",
                "The calling thread was not found.".into(),
            )
        })?;
        let caller_payload: Value =
            serde_json::from_str(&caller_raw).map_err(|e| ("orchestration_error", e.to_string()))?;
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND provider_instance_id=?2)", params![scope.thread_id,scope.provider_instance_id], |r| r.get(0)).map_err(|e| ("orchestration_error", e.to_string()))?;
        let background = caller_payload["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| {
                tasks.iter().any(|task| {
                    task["kind"] == "subagent"
                        && task["providerInstanceId"] == scope.provider_instance_id
                })
            });
        if archived.is_some() || owner != scope.provider_instance_id || !(active || background) {
            return Err((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            ));
        }
        (runtime, interaction)
    };
    let target_row: Option<(String,String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|("orchestration_error",e.to_string()))?;
    let (tr, ti, _target_raw) = target_row.ok_or_else(|| {
        (
            "thread_not_found",
            format!("Thread {target} was not found."),
        )
    })?;
    if rank(&runtime).is_none() || rank(&tr).is_none() || rank(&tr) > rank(&runtime) {
        return Err((
            "runtime_mode_escalation_denied",
            "The target thread exceeds the caller's runtime mode.".into(),
        ));
    }
    if !matches!(interaction.as_str(), "plan" | "default")
        || !matches!(ti.as_str(), "plan" | "default")
        || (interaction == "plan" && ti != "plan")
    {
        return Err((
            "interaction_mode_escalation_denied",
            "The target thread exceeds the caller's interaction mode.".into(),
        ));
    }
    check_link(tx, scope, target)?;
    Ok(())
}
pub fn definition() -> Value {
    json!({"name":"t3_thread_organize","description":"Pin, snooze, settle, archive, or mark a thread unread. Omit threadId for this thread. A failed turn or queued message leaves it active.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"action":{"enum":["pin","unpin","snooze","unsnooze","settle","unsettle","archive","unarchive","mark_unread"]},"snoozedUntil":{"type":"string"}},"required":["action"],"additionalProperties":false},"annotations":{"destructiveHint":true}})
}
/// Router authenticates and checks environmentId before entry.
pub fn call(bus: &EventBus, scope: &Scope, args: &Value, now: &str) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    let o = args
        .as_object()
        .ok_or(("invalid_request", "Invalid arguments.".into()))?;
    if o.keys()
        .any(|k| !["environmentId", "threadId", "action", "snoozedUntil"].contains(&k.as_str()))
    {
        return Err(("invalid_request", "Invalid arguments.".into()));
    }
    let action = args["action"]
        .as_str()
        .filter(|s| {
            [
                "pin",
                "unpin",
                "snooze",
                "unsnooze",
                "settle",
                "unsettle",
                "archive",
                "unarchive",
                "mark_unread",
            ]
            .contains(s)
        })
        .ok_or(("invalid_request", "Invalid action.".into()))?;
    let target = match o.get("threadId") {
        None => scope.thread_id.as_str(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.as_str(),
        _ => return Err(("invalid_request", "Invalid threadId.".into())),
    };
    let until = if action == "snooze" {
        Some(
            args.get("snoozedUntil")
                .and_then(Value::as_str)
                .ok_or(("invalid_request", "snooze requires snoozedUntil.".into()))?,
        )
    } else {
        None
    };
    if action == "settle" && target == scope.thread_id {
        let initial=bus.commit(|tx|{let result=check(tx,scope,target); let active=if result.is_ok(){tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running') ORDER BY ordinal DESC LIMIT 1",[target],|r|r.get::<_,String>(0)).optional()?}else{None};let sequence=crate::event_store::latest_thread_sequence(tx,Some(target))?;Ok(((result,active,sequence),vec![]))}).map_err(|e|("orchestration_error",e.to_string()))?;
        initial.0?;
        if let Some(run) = initial.1 {
            let mut subscription = bus
                .subscribe(
                    initial.2,
                    Filter {
                        thread_id: Some(target.into()),
                        event_type: Some("run.updated".into()),
                    },
                )
                .map_err(|e| ("orchestration_error", e.to_string()))?;
            let bus = bus.clone();
            let target = target.to_owned();
            let requested = now.to_owned();
            tokio::spawn(async move {
                let future = async {
                    loop {
                        if settle_after(&bus, &target, &run, &requested).await {
                            return;
                        }
                        if subscription.next().await.is_err() {
                            return;
                        }
                    }
                };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(86400), future).await;
            });
            return Ok(json!({"settlesWhenTurnEnds":true}));
        }
    }
    let denied = RefCell::new(None::<Failure>);
    let guard = |tx: &Transaction<'_>| {
        check(tx, scope, target).map_err(|failure| {
            *denied.borrow_mut() = Some(failure);
            rusqlite::Error::InvalidQuery
        })
    };
    let id = format!("mcp:{}", uuid::Uuid::new_v4());
    let result = match action {
        "pin" => thread_controls::dispatch_checked(
            bus,
            &id,
            target,
            Control::Pin { order_key: None },
            now,
            guard,
        ),
        "unpin" => thread_controls::dispatch_checked(bus, &id, target, Control::Unpin, now, guard),
        "snooze" => thread_controls::dispatch_checked(
            bus,
            &id,
            target,
            Control::Snooze {
                until: until.unwrap(),
            },
            now,
            guard,
        ),
        "unsnooze" => {
            thread_controls::dispatch_checked(bus, &id, target, Control::Unsnooze, now, guard)
        }
        "archive" => {
            thread_lifecycle::dispatch_checked(bus, &id, target, Lifecycle::Archive, now, guard)
        }
        "unarchive" => {
            thread_lifecycle::dispatch_checked(bus, &id, target, Lifecycle::Unarchive, now, guard)
        }
        "settle" => thread_lifecycle::dispatch_checked(
            bus,
            &id,
            target,
            Lifecycle::Settle {
                expected_latest_run_id: None,
                settled_at: None,
            },
            now,
            guard,
        ),
        "unsettle" => {
            thread_lifecycle::dispatch_checked(bus, &id, target, Lifecycle::Unsettle, now, guard)
        }
        _ => thread_visit::mark_unread_checked(bus, &id, target, now, guard),
    }
    .map_err(|e| {
        denied
            .into_inner()
            .unwrap_or_else(|| ("orchestration_error", e.to_string()))
    })?;
    if let Some(error) = result.receipt.error {
        return Err(("orchestration_error", error));
    }
    Ok(json!({"sequence":result.receipt.result_sequence}))
}
async fn settle_after(
    bus: &EventBus,
    thread: &str,
    requested_run: &str,
    requested_at: &str,
) -> bool {
    let state=bus.commit(|tx|{
  let run:Option<(String,i64)>=tx.query_row("SELECT status,ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![thread,requested_run],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
  let Some((status,ordinal))=run else{return Ok((Some(None),vec![]));};
  if matches!(status.as_str(),"queued"|"preparing"|"starting"|"running"|"waiting"){return Ok((None,vec![]));}
  if status!="completed" {return Ok((Some(None),vec![]));}
  let watch:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t,json_each(t.payload_json,'$.pullRequests') p WHERE t.thread_id=?1 AND json_extract(p.value,'$.watch.startedAt')>=?2)",params![thread,requested_at],|r|r.get(0))?;if watch{return Ok((Some(None),vec![]));}
  let mut stmt=tx.prepare("SELECT r.run_id,r.status,m.payload_json FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.ordinal>?2 ORDER BY r.ordinal")?;
  let following=stmt.query_map(params![thread,ordinal],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;drop(stmt);
  let mut latest=requested_run.to_owned();for (id,status,raw) in following {let msg:Value=raw.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null); if msg["notification"].is_null() && msg["delegatedCompletion"].is_null(){return Ok((Some(None),vec![]));}
  if !matches!(status.as_str(),"queued"|"completed"|"failed"|"interrupted"|"cancelled"|"rolled_back"){return Ok((None,vec![]));}
  if status!="queued" && status!="completed"{return Ok((Some(None),vec![]));}latest=id;}
  Ok((Some(Some(latest)),vec![]))
 });
    match state {
        Ok(None) => false,
        Ok(Some(None)) | Err(_) => true,
        Ok(Some(Some(latest))) => {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let cmd = format!(
                "server:settle-after-run:{requested_run}:{}",
                uuid::Uuid::new_v4()
            );
            match thread_lifecycle::dispatch(
                bus,
                &cmd,
                thread,
                Lifecycle::Settle {
                    expected_latest_run_id: Some(&latest),
                    settled_at: None,
                },
                &now,
            ) {
                Ok(r) => r.receipt.status == "accepted",
                Err(_) => true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn link_fence_checks_session_and_full_access() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, deleted_at TEXT, payload_json TEXT NOT NULL);").unwrap();
        let scope = Scope {thread_id:"caller".into(),provider_session_id:"s".into(),provider_instance_id:"codex".into(),capabilities:HashSet::new(),subagent:false, client: None,};
        let tx = db.transaction().unwrap();
        let set = |id: &str, origin: Value| {
            tx.execute("INSERT OR REPLACE INTO orchestration_v2_projection_threads(thread_id,payload_json) VALUES(?1,?2)", params![id,json!({"linkOrigin":origin}).to_string()]).unwrap();
        };
        set("caller",json!({"sessionId":"a","label":"Laptop"}));
        set("target",json!({"sessionId":"b","label":"Other","access":"auto"}));
        assert_eq!(check_link(&tx,&scope,"target").unwrap_err().0,"capability_denied");
        assert_eq!(check_not_linked(&tx,&scope,"change scheduled tasks").unwrap_err().0,"capability_denied");
        set("target",json!({"sessionId":"a","label":"Laptop","access":"auto"}));
        assert!(check_link(&tx,&scope,"target").is_ok());
        set("caller",json!({"sessionId":"a","label":"Laptop","access":"full-access"}));
        set("target",Value::Null);
        assert!(check_link(&tx,&scope,"target").is_ok());
        assert!(check_not_linked(&tx,&scope,"change scheduled tasks").is_ok());
    }
    #[tokio::test]
    async fn writes_check_limits_and_own_settlement_waits_for_completion() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, mode) in [("caller", "auto"), ("target", "full-access")] {
            let thread = json!({"id":id,"runtimeMode":mode,"interactionMode":"default"});
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex',?2,'default','now','now',?3)",params![id,mode,thread.to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','caller',1,'codex','codex','running','2026-01-01T00:00:00Z',?1)",[json!({"id":"r","threadId":"caller","ordinal":1,"status":"running"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "caller".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let now = "2026-01-01T00:00:00Z";
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"pin","threadId":"target"}),
                now
            )
            .unwrap_err()
            .0,
            "runtime_mode_escalation_denied"
        );
        assert_eq!(
            call(&bus, &scope, &json!({"action":"settle"}), now).unwrap(),
            json!({"settlesWhenTurnEnds":true})
        );
        bus.commit(|tx|{let run=json!({"id":"r","threadId":"caller","ordinal":1,"status":"completed","completedAt":"2026-01-01T00:00:01Z"});tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',completed_at='2026-01-01T00:00:01Z',payload_json=?1 WHERE run_id='r'",[run.to_string()])?;let event=crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:"caller".into(),event_type:"run.updated".into(),occurred_at:"2026-01-01T00:00:01Z".into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:run,metadata:json!({})};let events=crate::event_store::append(tx,&[event])?;Ok(((),events))}).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2),async {loop {let done=bus.commit(|tx|{let v:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id='caller'",[],|r|r.get(0))?;Ok((v.as_deref()==Some("settled"),vec![]))}).unwrap();if done{break;}tokio::task::yield_now().await;}}).await.unwrap();
    }
}
