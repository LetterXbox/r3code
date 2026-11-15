//! Send a message to a thread with transactional caller and mode checks.
use crate::{
    event_bus::EventBus,
    mcp_credentials::Scope,
    message_commands::{self, DispatchError, DispatchMessage},
    settings::Settings,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::cell::RefCell;
type Failure = (&'static str, String);
fn rank(v: &str) -> Option<u8> {
    match v {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    }
}
pub fn definition() -> Value {
    json!({"name":"t3_thread_send","description":"Send a message to a thread. Auto steers a running turn or starts a new one; queue waits behind active work.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"message":{"type":"string","minLength":1,"maxLength":120000},"mode":{"enum":["auto","queue","steer","restart"]},"freshContext":{"type":"boolean"},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"required":["threadId","message"],"additionalProperties":false},"annotations":{"title":"Send to a T3 thread","readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}})
}
pub fn call(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    settings: &Settings,
    sessions: &crate::provider::session_registry::SessionRegistry,
    environment: &str,
    now: &str,
) -> Result<Value, Failure> {
    let invalid = || ("invalid_request", "Invalid send arguments.".to_owned());
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This credential does not have the orchestration capability.".into(),
        ));
    }
    let o = args.as_object().ok_or_else(invalid)?;
    if o.keys().any(|k| {
        ![
            "environmentId",
            "threadId",
            "message",
            "mode",
            "freshContext",
            "clientRequestId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    let target = args["threadId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let text = args["message"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 120_000)
        .ok_or_else(invalid)?;
    let mode = match o.get("mode") {
        None => "auto",
        Some(Value::String(s)) if ["auto", "queue", "steer", "restart"].contains(&s.as_str()) => {
            s.as_str()
        }
        _ => return Err(invalid()),
    };
    let fresh = match o.get("freshContext") {
        None => false,
        Some(Value::Bool(v)) => *v,
        _ => return Err(invalid()),
    };
    let key = match o.get("clientRequestId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(v))
            if !v.trim().is_empty() && v.trim().encode_utf16().count() <= 256 =>
        {
            v.trim().to_owned()
        }
        _ => return Err(invalid()),
    };
    let namespace = message_commands::encode_id_part(&scope.provider_session_id);
    let key = message_commands::encode_id_part(&key);
    let command = format!("command:mcp:{namespace}:thread-send:{key}");
    let message = format!("message:mcp:{namespace}:thread-send:{key}");
    let denied = RefCell::new(None::<Failure>);
    let snapshot = settings.snapshot();
    let result=bus.commit_with(|tx| {
  let reject=|f:Failure|{*denied.borrow_mut()=Some(f);DispatchError::Database(rusqlite::Error::InvalidQuery)};
  let caller:Option<(String,String)>=tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
  let (pr,pi)=caller.ok_or_else(||reject(("thread_not_found","The calling thread was not found.".into())))?;
  if target!=scope.thread_id {let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id=t.thread_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND r.run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=t.thread_id AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND r.provider_instance_id=?2)",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0))?;if !active{return Err(reject(("parent_not_active","The calling provider no longer owns an active thread run.".into())));}}
  let target_row:Option<(String,String,String,String,Option<String>)>=tx.query_row("SELECT t.runtime_mode,t.interaction_mode,t.project_id,t.payload_json,COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
  let (rt,it,project,raw,cwd)=target_row.ok_or_else(||reject(("thread_not_found","The thread was not found.".into())))?;
  if rank(&rt).is_none() || rank(&pr).is_none() || rank(&rt)>rank(&pr){return Err(reject(("runtime_mode_escalation_denied","The target thread exceeds the caller's runtime mode.".into())));}
  if !matches!(pi.as_str(),"plan"|"default") || !matches!(it.as_str(),"plan"|"default") || (pi=="plan" && it!="plan"){return Err(reject(("interaction_mode_escalation_denied","The target thread exceeds the caller's interaction mode.".into())));}
  crate::mcp_thread_organize::check_link(tx,scope,target).map_err(&reject)?;
  let thread:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;if !thread["archivedAt"].is_null(){return Err(reject(("thread_not_sendable",format!("Thread {target} is archived."))));}
  let instance=thread["modelSelection"]["instanceId"].as_str().unwrap_or("");let entry=snapshot["providerInstances"].get(instance);let enabled=snapshot["projectSettingsOverrides"][&project]["providerInstances"][instance]["enabled"].as_bool().unwrap_or_else(||match entry {None=>matches!(instance,"codex"|"claudeAgent"),Some(entry)=>{let a=entry["enabled"].as_bool();let b=entry["config"]["enabled"].as_bool();if a==Some(false)||b==Some(false){false}else{a.or(b).unwrap_or_else(||!matches!(entry["driver"].as_str(),Some("cursor"|"grok"|"fx"|"kiro"|"muse"|"pi"|"opencode"|"antigravity")))}}});if !enabled {return Err(reject(("orchestration_error","The provider for this project is disabled.".into())));}
  let steer:Option<String>=tx.query_row("SELECT r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') AND p.status='running' WHERE r.thread_id=?1 AND r.status='running' ORDER BY r.ordinal DESC LIMIT 1",[target],|r|r.get(0)).optional()?;
  if !fresh && matches!(mode,"steer"|"restart") && steer.is_none(){return Err(reject(("thread_not_sendable",format!("Thread {target} has no running turn to steer."))));}
  let steer=if fresh || mode=="queue" {None}else{steer};let cwd=cwd.unwrap_or_default();
  if steer.is_none() && !std::path::Path::new(&cwd).is_dir(){let replay=crate::event_store::get_receipt(tx,&command,"thread")?.is_some();if !replay{return Err(reject(("thread_not_sendable",format!("Thread {target} workspace is unavailable."))));}}
  let cmd=DispatchMessage{context:None,command_id:&command,thread_id:target,message_id:&message,text,attachments:&[],creation_source:"mcp",cwd:&cwd,driver:"codex"};
  if fresh {message_commands::dispatch_fresh_message_tx(tx,cmd,now,Some(sessions),Some(&scope.thread_id))}else if let Some(run)=steer {if mode=="restart" {message_commands::restart_message_tx(tx,cmd,&run,now,Some(&scope.thread_id))}else{message_commands::steer_message_tx_with_sender(tx,cmd,&run,now,None,&[],Some(&scope.thread_id))}}else{message_commands::dispatch_message_tx_with_sender(tx,cmd,now,mode=="auto",None,None,Some(&scope.thread_id))}
 }).map_err(|e|denied.into_inner().unwrap_or_else(||("orchestration_error",format!("Unable to send to thread {target}: {e}"))))?;
    if result.receipt.status != "accepted" {
        return Err((
            "orchestration_error",
            result
                .receipt
                .error
                .unwrap_or_else(|| "The operation could not be completed.".into()),
        ));
    }
    bus.commit(|tx|{
  let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND message_id=?2",params![target,message],|r|r.get(0))?;let msg:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;let run_id=msg["runId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
  let run:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![target,run_id],|r|r.get(0))?;let run:Value=serde_json::from_str(&run).map_err(|_|rusqlite::Error::InvalidQuery)?;
  let item:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_message' AND json_extract(payload_json,'$.messageId')=?2 LIMIT 1",params![target,message],|r|r.get(0)).optional()?;let item=item.and_then(|s|serde_json::from_str::<Value>(&s).ok());
  let delivery=match item.as_ref().and_then(|v|v["inputIntent"].as_str()) {None|Some("queued_turn")=>"queued",Some("turn_start")=>"started",_ if mode=="restart" && !fresh=>"restarted",_=>"steered"};let title:Option<String>=tx.query_row("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id=?1",[target],|r|r.get(0)).optional()?;
  let mut value=json!({"threadId":target,"link":crate::mcp_http::thread_link(environment,target,title.as_deref()),"messageId":message,"runId":run_id,"status":run["status"],"delivery":delivery});if !run["delegatedTaskId"].is_null(){value["taskId"]=run["delegatedTaskId"].clone();}Ok((value,vec![]))
 }).map_err(|e|("orchestration_error",e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn send_is_idempotent_and_enforces_modes() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        for (id, mode) in [
            ("caller", "auto"),
            ("target", "auto"),
            ("high", "full-access"),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','codex',?2,'default','now','now',?3)",params![id,mode,json!({"id":id,"projectId":"p","title":id,"providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":mode,"interactionMode":"default"}).to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','caller',1,'codex','codex','running','now',?1)",[json!({"id":"r","status":"running","ordinal":1}).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "caller".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let settings =
            Settings::new(std::env::temp_dir().join(format!("send-{}.json", uuid::Uuid::new_v4())));
        let args = json!({"threadId":"target","message":"hello","clientRequestId":"key"});
        let sessions = crate::provider::session_registry::SessionRegistry::default();
        // A linked caller below full access cannot mutate another link's thread.
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin',json(?1)) WHERE thread_id='caller'", [json!({"sessionId":"link-a","label":"Laptop","access":"auto"}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let denied = call(&bus,&scope,&args,&settings,&sessions,"env","2026-01-01T00:00:00Z").unwrap_err();
        assert_eq!(denied.0, "capability_denied");
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin',json(?1)) WHERE thread_id='target'", [json!({"sessionId":"link-a","label":"Laptop","access":"auto"}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let first = call(
            &bus,
            &scope,
            &args,
            &settings,
            &sessions,
            "env",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let second = call(
            &bus,
            &scope,
            &args,
            &settings,
            &sessions,
            "env",
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        assert_eq!(first["messageId"], second["messageId"]);
        assert_eq!(first["delivery"], "started");
        bus.commit(|tx|{let run_id=first["runId"].as_str().unwrap(); let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1",[run_id],|r|r.get(0))?;let mut run:Value=serde_json::from_str(&raw).unwrap();run["status"]=json!("running");tx.execute("UPDATE orchestration_v2_projection_runs SET status='running',payload_json=?2 WHERE run_id=?1",params![run_id,run.to_string()])?;tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','target',?1,?2,?3,1,'running',?4)",params![run["providerThreadId"].as_str(),run["rootNodeId"].as_str(),run["activeAttemptId"].as_str(),json!({"id":"turn"}).to_string()])?;Ok(((),vec![]))}).unwrap();
        let steered=call(&bus,&scope,&json!({"threadId":"target","message":"steer this","mode":"steer","clientRequestId":"steer"}),&settings,&sessions,"env","2026-01-01T00:00:02Z").unwrap();
        assert_eq!(steered["delivery"], "steered");
        let fresh=call(&bus,&scope,&json!({"threadId":"target","message":"new context","freshContext":true,"clientRequestId":"fresh"}),&settings,&sessions,"env","2026-01-01T00:00:03Z").unwrap();
        assert_eq!(fresh["delivery"], "queued");
        bus.commit(|tx| {let fresh_context:bool=tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.freshContext'),0) FROM orchestration_v2_projection_runs WHERE run_id=?1",[fresh["runId"].as_str()],|r|r.get(0))?;assert!(fresh_context);Ok(((),vec![]))}).unwrap();

        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",
                [steered["messageId"].as_str()],
                |r| r.get(0),
            )?;
            let m: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(m["createdBy"], "agent");
            assert_eq!(m["senderThreadId"], "caller");
            Ok(((), vec![]))
        })
        .unwrap();

        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"threadId":"high","message":"hello"}),
                &settings,
                &sessions,
                "env",
                "now"
            )
            .unwrap_err()
            .0,
            "runtime_mode_escalation_denied"
        );
        bus.commit(|tx|{let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id='target'",[],|r|r.get(0))?;let m:Value=serde_json::from_str(&raw).unwrap();assert_eq!(m["createdBy"],"agent");assert_eq!(m["senderThreadId"],"caller");Ok(((),vec![]))}).unwrap();
    }
}
