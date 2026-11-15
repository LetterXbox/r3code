//! Wait for a thread run without losing updates between projection reads and subscription.
use crate::{
    event_bus::{BusError, EventBus, Filter},
    mcp_credentials::Scope,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Duration;
type Failure = (&'static str, String);
const NEXT: &str = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
fn invalid(s: &str) -> Failure {
    ("invalid_request", s.into())
}
pub fn definition() -> Value {
    json!({"name":"t3_thread_wait","description":"Wait for a thread's run to finish. No runId: latest. Idle: at once. On timeout, with next end your turn; without, call again.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"runId":{"type":"string"},"timeoutMs":{"type":"number"},"untilDelegatedWorkSettled":{"type":"boolean"}},"required":["threadId"],"additionalProperties":false},"annotations":{"title":"Wait for a T3 thread","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true}})
}
fn terminal(v: &Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted" | "rolled_back")
    )
}
fn outcome(run: &Value) -> &str {
    let status = run["status"].as_str().unwrap_or("idle");
    if matches!(status, "completed" | "cancelled")
        && run["restartCancelledBackgroundWork"]
            .as_array()
            .is_some_and(|v| {
                v.iter().any(|w| {
                    w["awaited"] == true || (w["kind"] != "shell" && w["kind"] != "monitor")
                })
            })
    {
        "interrupted"
    } else {
        status
    }
}
struct Evaluation {
    run: Option<Value>,
    result: Option<Value>,
    settled: bool,
    next: bool,
}
fn evaluate(
    bus: &EventBus,
    scope: &Scope,
    thread: &str,
    selected: Option<&str>,
    until: bool,
) -> Result<Evaluation, Failure> {
    bus.commit(|tx| {
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",[thread],|r|r.get(0))?;if !exists{return Ok((Err(("thread_not_found","The thread was not found.".to_owned())),vec![]));}
  let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal")?;let runs:Vec<Value>=stmt.query_map([thread],|r|r.get::<_,String>(0))?.map(|v|serde_json::from_str(&v?).map_err(|_|rusqlite::Error::InvalidQuery)).collect::<rusqlite::Result<_>>()?;drop(stmt);
  let mut run=match selected {Some(id)=>match runs.iter().find(|r|r["id"]==id){Some(r)=>Some(r),None=>return Ok((Err(("run_not_found",format!("Run {id} was not found on thread {thread}."))),vec![]))},None=>runs.last()};
  for _ in 0..runs.len(){let Some(current)=run else{break};let next=runs.iter().find(|r|r["restartContinuationOfRunId"]==current["id"] && !r["restartContinuationOfRunId"].is_null());if next.is_none(){break;}run=next;}
  let Some(run)=run else{return Ok((Ok(Evaluation{run:None,result:None,settled:true,next:false}),vec![]));};
  let id=run["id"].as_str().unwrap_or("");let restart:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1 AND status IN ('pending','running'))",[format!("effect:restart-continuation:{id}")],|r|r.get(0))?;
  let mut settled=terminal(run) && !restart;let mut result=None;
  if settled && until {
    let outstanding:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND (status IN ('pending','running','waiting') OR (status!='idle' AND completion_delivery_state IN ('pending','claimed')))) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p, json_each(p.payload_json,'$.pendingBackgroundTasks') j WHERE p.thread_id=?1 AND (json_extract(j.value,'$.awaited')=1 OR json_extract(j.value,'$.kind') IN ('subagent','background_task')))",[thread],|r|r.get(0))?;
    let mut stmt=tx.prepare("SELECT DISTINCT run_id FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='user' AND json_extract(payload_json,'$.notification.source.kind')='monitor' AND run_id IS NOT NULL")?;
    let monitor=stmt.query_map([thread],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;drop(stmt);
    let work:Vec<&Value>=runs.iter().filter(|r|r["status"]!="rolled_back" && !r["id"].as_str().is_some_and(|id|monitor.contains(id))).collect();
    let active=work.iter().any(|r|!(terminal(r) || r["status"]=="queued" && r["queueHeld"]==true));
    let result_run=work.iter().copied().filter(|r|terminal(r) && (!r["startedAt"].is_null() || r["ordinal"]==1)).max_by(|a,b| {let end=|r:&Value|r["completedAt"].as_str().unwrap_or("\u{10ffff}").to_owned();end(a).cmp(&end(b)).then_with(||a["ordinal"].as_i64().cmp(&b["ordinal"].as_i64()))});
    let result_run=result_run.or_else(|| if runs.iter().all(terminal) {runs.last()} else {None});
    let result_restart:bool=if let Some(r)=result_run {tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1 AND status IN ('pending','running'))",[format!("effect:restart-continuation:{}",r["id"].as_str().unwrap_or(""))],|r|r.get(0))?}else{false};
    settled=!outstanding && !active && result_run.is_some() && !result_restart;
    if settled {result=result_run.cloned();}
  }
  let task=run["delegatedTaskId"].as_str().unwrap_or("");let wake:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND subagent_id=?2 AND origin='app_owned' AND child_thread_id=?3 AND COALESCE(json_extract(payload_json,'$.completionDelivery.state'),'')!='disposed') AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?3 AND status='pending')",params![scope.thread_id,task,thread],|r|r.get(0))?;
  Ok((Ok(Evaluation{run:Some(run.clone()),result,settled,next:wake}),vec![]))
 }).map_err(|e|("orchestration_error",e.to_string()))?
}
fn response(thread: &str, e: Evaluation) -> Value {
    let timed_out = !e.settled;
    let status = e.run.as_ref().map(outcome).unwrap_or("idle");
    let mut v = json!({"threadId":thread,"runId":e.run.as_ref().map(|r|r["id"].clone()),"status":status,"timedOut":timed_out});
    if timed_out && status != "waiting" && e.next {
        v["next"] = json!(NEXT);
    }
    if let Some(run) = e.result {
        v["resultRun"] = json!({"runId":run["id"],"status":outcome(&run)});
    }
    v
}
pub async fn call(bus: &EventBus, scope: &Scope, args: &Value) -> Result<Value, Failure> {
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
            "runId",
            "timeoutMs",
            "untilDelegatedWorkSettled",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Invalid arguments."));
    }
    let thread = args["threadId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid("threadId is required."))?;
    let run = match obj.get("runId") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.as_str()),
        _ => return Err(invalid("Invalid runId.")),
    };
    let timeout = match obj.get("timeoutMs") {
        None => 600_000,
        Some(v) => v
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| invalid("Invalid timeoutMs."))?
            .clamp(1.0, 3_600_000.0) as u64,
    };
    let until = match obj.get("untilDelegatedWorkSettled") {
        None => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(invalid("Invalid untilDelegatedWorkSettled.")),
    };
    let cursor = bus
        .commit(|tx| {
            Ok((
                crate::event_store::latest_thread_sequence(tx, None)?,
                vec![],
            ))
        })
        .map_err(|e| ("orchestration_error", e.to_string()))?;
    let mut sub = bus
        .subscribe(
            cursor,
            Filter {
                thread_id: Some(thread.into()),
                event_type: None,
            },
        )
        .map_err(|e| ("orchestration_error", e.to_string()))?;
    let first = evaluate(bus, scope, thread, run, until)?;
    if first.settled {
        return Ok(response(thread, first));
    }
    let chosen = first
        .run
        .as_ref()
        .and_then(|r| r["id"].as_str())
        .unwrap_or("")
        .to_owned();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(response(
                thread,
                evaluate(bus, scope, thread, Some(&chosen), until)?,
            ));
        }
        let wait = (deadline - now).min(Duration::from_secs(1));
        match tokio::time::timeout(wait, sub.next()).await {
            Ok(Err(BusError::Lagged(_))) => {
                sub = bus
                    .subscribe(
                        sub.cursor(),
                        Filter {
                            thread_id: Some(thread.into()),
                            event_type: None,
                        },
                    )
                    .map_err(|e| ("orchestration_error", e.to_string()))?;
            }
            Ok(Err(e)) => return Err(("orchestration_error", e.to_string())),
            _ => {}
        }
        let current = evaluate(bus, scope, thread, Some(&chosen), until)?;
        if current.settled {
            return Ok(response(thread, current));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[tokio::test]
    async fn delegated_wait_ignores_held_queue_and_unawaited_monitors() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','auto','default','now','now',?1)",[json!({"id":"t"}).to_string()]).unwrap();
        for (id, n, status, held) in [("done", 1, "completed", false), ("held", 2, "queued", true)]
        {
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex',?3,'now',?4)",params![id,n,status,json!({"id":id,"ordinal":n,"status":status,"queueHeld":held}).to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('p','t','codex','ready','now',?1)",[json!({"id":"p","pendingBackgroundTasks":[{"taskId":"monitor","kind":"monitor"}]}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let result = call(
            &bus,
            &scope,
            &json!({"threadId":"t","runId":"done","untilDelegatedWorkSettled":true}),
        )
        .await
        .unwrap();
        assert_eq!(result["timedOut"], false);
        assert_eq!(result["resultRun"]["runId"], "done");
    }
    #[tokio::test]
    async fn waits_for_selected_run_and_follows_restart() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','auto','default','now','now',?1)",[json!({"id":"t"}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        assert_eq!(
            call(&bus, &scope, &json!({"threadId":"t"})).await.unwrap()["status"],
            "idle"
        );
        bus.commit(|tx|{for (id,n,status,from) in [("old",1,"interrupted",None),("new",2,"running",Some("old"))] {let mut run=json!({"id":id,"threadId":"t","ordinal":n,"status":status});if let Some(from)=from{run["restartContinuationOfRunId"]=json!(from);}tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,'t',?2,'codex',?3,'now',?4)",params![id,n,status,run.to_string()])?;}Ok(((),vec![]))}).unwrap();
        let timed = call(
            &bus,
            &scope,
            &json!({"threadId":"t","runId":"old","timeoutMs":1}),
        )
        .await
        .unwrap();
        assert_eq!(timed["runId"], "new");
        assert_eq!(timed["timedOut"], true);
        let b = bus.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            b.commit(|tx|{let run=json!({"id":"new","threadId":"t","ordinal":2,"status":"completed","restartContinuationOfRunId":"old"});tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=?1 WHERE run_id='new'",[run.to_string()])?;let event=crate::event_store::Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:"t".into(),event_type:"run.updated".into(),occurred_at:"now".into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:run,metadata:json!({})};let events=crate::event_store::append(tx,&[event])?;Ok(((),events))}).unwrap();
        });
        let done = call(
            &bus,
            &scope,
            &json!({"threadId":"t","runId":"old","timeoutMs":1000}),
        )
        .await
        .unwrap();
        assert_eq!(done["runId"], "new");
        assert_eq!(done["status"], "completed");
        assert_eq!(done["timedOut"], false);
    }
}
