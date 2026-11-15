//! MCP access to pending user-input requests.
use crate::{event_bus::EventBus, mcp_credentials::Scope, provider::codex_requests};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

type Failure = (&'static str, String);
fn invalid(s: impl Into<String>) -> Failure {
    ("invalid_request", s.into())
}
fn db_error(e: impl std::fmt::Display) -> Failure {
    ("orchestration_error", e.to_string())
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
    json!({"name":"t3_pending_request","description":"Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"action":{"enum":["list","read","respond"]},"requestId":{"type":"string"},"answers":{"type":"object","additionalProperties":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"array","items":{"type":"string"}}]}}},"required":["action"],"additionalProperties":false},"annotations":{"destructiveHint":true,"openWorldHint":true}})
}

/// `environmentId` must be checked by the HTTP router before calling this function.
pub fn call(bus: &EventBus, scope: &Scope, args: &Value, now: &str) -> Result<Value, Failure> {
    call_with_settings(bus, scope, args, now, None)
}

pub fn call_with_settings(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    now: &str,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Failure> {
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
            "requestId",
            "answers",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Invalid arguments."));
    }
    let action = args["action"]
        .as_str()
        .filter(|s| ["list", "read", "respond"].contains(s))
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
    let request_id = if action != "list" {
        Some(
            args.get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("This action needs `requestId`."))?,
        )
    } else {
        None
    };
    let answers = if action == "respond" {
        let a = args
            .get("answers")
            .ok_or_else(|| invalid("This action needs `answers`."))?;
        let valid = a.as_object().is_some_and(|m| {
            m.values().all(|v| {
                v.is_string()
                    || v.is_boolean()
                    || v.is_number()
                    || v.as_array()
                        .is_some_and(|xs| xs.iter().all(Value::is_string))
            })
        });
        if !valid {
            return Err(invalid("Invalid answers."));
        }
        Some(Value::Object(
            a.as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if v.is_number() || v.is_boolean() {
                            Value::String(v.to_string())
                        } else {
                            v.clone()
                        },
                    )
                })
                .collect(),
        ))
    } else {
        None
    };
    let result = bus.commit(|tx| {
        let target_modes: Option<(String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((runtime,interaction)) = target_modes else { return Ok((Err(("thread_not_found", "The thread was not found.".to_owned())),vec![])); };
        if action == "respond" {
            let caller: Option<(String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&scope.thread_id],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((parent_runtime,parent_interaction)) = caller else { return Ok((Err(("thread_not_found", "The calling thread was not found.".to_owned())),vec![])); };
            if rank(&runtime).is_none() || rank(&parent_runtime).is_none() || rank(&runtime) > rank(&parent_runtime) { return Ok((Err(("runtime_mode_escalation_denied", "The target thread exceeds the caller's runtime mode.".to_owned())),vec![])); }
            if parent_interaction == "plan" && interaction != "plan" { return Ok((Err(("interaction_mode_escalation_denied", "The target thread exceeds the caller's interaction mode.".to_owned())),vec![])); }
        }
        if action == "list" {
            let mut stmt = tx.prepare("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND kind='user_input' AND status='pending' ORDER BY created_at,runtime_request_id")?;
            let ids = stmt.query_map([target], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            return Ok((Ok(json!({"requestIds":ids})),vec![]));
        }
        let id = request_id.unwrap();
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND runtime_request_id=?2 AND kind='user_input'",params![target,id],|r|r.get(0)).optional()?;
        let item: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_input_request' AND json_extract(payload_json,'$.requestId')=?2 AND node_id=(SELECT node_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND runtime_request_id=?2) LIMIT 1",params![target,id],|r|r.get(0)).optional()?;
        let (Some(raw),Some(item)) = (raw,item) else { return Ok((Err(invalid("The pending user-input request was not found.")),vec![])); };
        let request: Value = serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let item: Value = serde_json::from_str(&item).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let status = request["status"].as_str().unwrap_or("");
        if status != "pending" { return Ok((Err(invalid(if status == "resolved" { "The user-input request was already answered.".to_owned() } else { format!("The user-input request is no longer pending ({status}).") })),vec![])); }
        if action == "respond" && !matches!(request["responseCapability"]["type"].as_str(), Some("live" | "message")) { return Ok((Err(("orchestration_error", "Answering this request's response capability is not supported.".to_owned())),vec![])); }
        Ok((Ok(json!({"requestId":id,"questions":item["questions"]})),vec![]))
    }).map_err(db_error)??;
    if action != "respond" {
        return Ok(result);
    }
    let denied = std::cell::RefCell::new(None::<Failure>);
    let check = |tx: &rusqlite::Transaction<'_>| -> rusqlite::Result<()> {
        let refuse = |f: Failure| {
            *denied.borrow_mut() = Some(f);
            rusqlite::Error::InvalidQuery
        };
        let caller: Option<(String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (parent_runtime, parent_interaction) = caller.ok_or_else(|| {
            refuse((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            ))
        })?;
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=(SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1) AND provider_instance_id=?2)",params![scope.thread_id,scope.provider_instance_id],|r|r.get(0))?;
        if !active {
            return Err(refuse((
                "parent_not_active",
                "The calling provider no longer owns an active thread run.".into(),
            )));
        }
        let target_modes: Option<(String,String)> = tx.query_row("SELECT runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[target],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (runtime, interaction) = target_modes
            .ok_or_else(|| refuse(("thread_not_found", "The thread was not found.".into())))?;
        if rank(&runtime).is_none()
            || rank(&parent_runtime).is_none()
            || rank(&runtime) > rank(&parent_runtime)
        {
            return Err(refuse((
                "runtime_mode_escalation_denied",
                "The target thread exceeds the caller's runtime mode.".into(),
            )));
        }
        if parent_interaction == "plan" && interaction != "plan" {
            return Err(refuse((
                "interaction_mode_escalation_denied",
                "The target thread exceeds the caller's interaction mode.".into(),
            )));
        }
        crate::mcp_thread_organize::check_link(tx, scope, target).map_err(&refuse)?;
        let id = request_id.unwrap();
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND runtime_request_id=?2 AND kind='user_input' AND status='pending'",params![target,id],|r|r.get(0)).optional()?;
        let raw =
            raw.ok_or_else(|| refuse(invalid("The pending user-input request was not found.")))?;
        let request: Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !matches!(
            request["responseCapability"]["type"].as_str(),
            Some("live" | "message")
        ) {
            return Err(refuse((
                "orchestration_error",
                "Answering this request's response capability is not supported.".into(),
            )));
        }
        let node = request["nodeId"]
            .as_str()
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let items: i64 = tx.query_row(
            "SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE node_id=?1",
            [node],
            |r| r.get(0),
        )?;
        let matching: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE node_id=?1 AND thread_id=?2 AND type='user_input_request' AND json_extract(payload_json,'$.requestId')=?3)",params![node,target,id],|r|r.get(0))?;
        if items != 1 || !matching {
            return Err(refuse(invalid(
                "The pending user-input request was not found.",
            )));
        }
        Ok(())
    };
    let command = format!("mcp:{}", uuid::Uuid::new_v4());
    let response = codex_requests::respond_command_checked_with_settings(
        bus,
        &command,
        target,
        request_id.unwrap(),
        None,
        answers.as_ref(),
        now,
        settings,
        check,
    );
    let committed = match response {
        Ok(v) => v,
        Err(e) => return Err(denied.into_inner().unwrap_or_else(|| db_error(e))),
    };
    if committed.receipt.status != "accepted" {
        return Err((
            "orchestration_error",
            committed
                .receipt
                .error
                .unwrap_or_else(|| "The operation could not be completed.".into()),
        ));
    }
    Ok(json!({"sequence":committed.receipt.result_sequence}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    fn setup() -> (EventBus, Scope) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')", []).unwrap();
        for (id, kind, status, capability) in [
            ("q", "user_input", "pending", "message"),
            ("answered", "user_input", "resolved", "live"),
            ("approval", "command", "pending", "live"),
        ] {
            let request = json!({"id":id,"threadId":"t","nodeId":format!("node-{id}"),"kind":kind,"status":status,"responseCapability":{"type":capability}});
            db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES(?1,'t',?2,?3,?4,'now',?5)",params![id,format!("node-{id}"),kind,status,request.to_string()]).unwrap();
            if kind == "user_input" {
                let item = json!({"id":format!("item-{id}"),"threadId":"t","type":"user_input_request","requestId":id,"questions":[{"id":"color","question":"Color?"}]});
                db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,node_id,type,status,ordinal,updated_at,payload_json) VALUES(?1,'t',?2,'user_input_request','waiting',1,'now',?3)",params![format!("item-{id}"),format!("node-{id}"),item.to_string()]).unwrap();
            }
        }
        (
            EventBus::new(db, 16),
            Scope {
                thread_id: "t".into(),
                provider_session_id: "s".into(),
                provider_instance_id: "p".into(),
                capabilities: HashSet::from(["orchestration".into()]),
                subagent: false, client: None,
            },
        )
    }
    #[test]
    fn lists_and_reads_only_questions_and_rejects_answered_or_approval() {
        let (bus, scope) = setup();
        assert_eq!(
            call(&bus, &scope, &json!({"action":"list"}), "now").unwrap(),
            json!({"requestIds":["q"]})
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"read","requestId":"q"}),
                "now"
            )
            .unwrap()["questions"][0]["id"],
            "color"
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"respond","requestId":"answered","answers":{}}),
                "now"
            )
            .unwrap_err()
            .1,
            "The user-input request was already answered."
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"read","requestId":"approval"}),
                "now"
            )
            .unwrap_err()
            .1,
            "The pending user-input request was not found."
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"respond","requestId":"q","answers":{"color":"red"}}),
                "now"
            )
            .unwrap_err()
            .0,
            "parent_not_active"
        );
    }
    #[test]
    fn live_answer_requires_active_caller_and_resolves_atomically() {
        let (bus, scope) = setup();
        bus.commit(|tx| {
            let mut request: Value = serde_json::from_str(&tx.query_row::<String,_,_>("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'",[],|r|r.get(0))?).unwrap();
            request["responseCapability"] = json!({"type":"live","providerSessionId":"session"});
            tx.execute("UPDATE orchestration_v2_projection_runtime_requests SET payload_json=?1 WHERE runtime_request_id='q'",[request.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,root_node_id,kind,status,payload_json) VALUES('node-q','t','node-q','user_input','waiting',?1)",[json!({"id":"node-q","status":"waiting"}).to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let args = json!({"action":"respond","requestId":"q","answers":{"color":"red"}});
        assert_eq!(
            call(&bus, &scope, &args, "now").unwrap_err().0,
            "parent_not_active"
        );
        bus.commit(|tx| { tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','p','running','now','{}')",[])?; Ok(((),vec![])) }).unwrap();
        assert!(call(&bus, &scope, &args, "now").unwrap()["sequence"].is_number());
        assert_eq!(
            call(&bus, &scope, &args, "now").unwrap_err().1,
            "The user-input request was already answered."
        );
    }
    #[test]
    fn message_answer_is_queued_atomically() {
        let (bus, scope) = setup();
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,root_node_id,kind,status,payload_json) VALUES('node-q','t','node-q','user_input','waiting',?1)",[json!({"id":"node-q","status":"waiting"}).to_string()])?;
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?1 WHERE thread_id='t'", [json!({"modelSelection":{"instanceId":"p","model":"test"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','p','running','now','{}')",[])?;
            Ok(((),vec![]))
        }).unwrap();
        assert!(call(
            &bus,
            &scope,
            &json!({"action":"respond","requestId":"q","answers":{"color":" "}}),
            "now"
        )
        .is_err());
        let result = call(
            &bus,
            &scope,
            &json!({"action":"respond","requestId":"q","answers":{"color":" red "}}),
            "now",
        )
        .unwrap();
        assert!(result["sequence"].is_number());
        bus.commit(|tx| {
            let (status,raw):(String,String)=tx.query_row("SELECT status,payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(status,"resolved");
            assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["answers"]["color"]," red ");
            let message:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='async-answer:q'",[],|r|r.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&message).unwrap()["text"],"Color?\nred");
            let effects:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='runtime-request.respond'",[],|r|r.get(0))?;
            assert_eq!(effects,0);
            Ok(((),vec![]))
        }).unwrap();
    }
    #[test]
    fn disabled_provider_rejects_message_without_resolving_request() {
        let (bus, scope) = setup();
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?1 WHERE thread_id='t'",[json!({"modelSelection":{"instanceId":"p","model":"test"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','p','running','now','{}')",[])?;
            Ok(((),vec![]))
        }).unwrap();
        let dir = std::env::temp_dir().join(format!("t3-answer-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path,json!({"providerInstances":{"p":{"driver":"codex","enabled":true}},"projectSettingsOverrides":{"p":{"providerInstances":{"p":{"enabled":false}}}}}).to_string()).unwrap();
        let settings = crate::settings::Settings::new(path);
        let error = call_with_settings(
            &bus,
            &scope,
            &json!({"action":"respond","requestId":"q","answers":{"color":"red"}}),
            "now",
            Some(&settings),
        )
        .unwrap_err();
        assert_eq!(error.1, "The provider for this project is disabled.");
        bus.commit(|tx| { let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id='q'",[],|r|r.get(0))?; assert_eq!(status,"pending"); Ok(((),vec![])) }).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
