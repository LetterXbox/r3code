//! MCP thread title updates with transaction-scoped authorization.
use crate::{event_bus::EventBus, mcp_credentials::Scope};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::cell::RefCell;

type Failure = (&'static str, String);
pub fn definition() -> Value {
    json!({"name":"t3_thread_update","description":"Rename a thread or regenerate its title. Omit threadId for this thread.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"action":{"enum":["rename","regenerate_title"]},"title":{"type":"string","minLength":1,"maxLength":512},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"required":["action"],"additionalProperties":false},"annotations":{"title":"Update T3 thread metadata","destructiveHint":true}})
}
pub fn call(bus: &EventBus, scope: &Scope, args: &Value, now: &str) -> Result<Value, Failure> {
    if !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.".into(),
        ));
    }
    let invalid = || {
        (
            "invalid_request",
            "Invalid thread update arguments.".to_owned(),
        )
    };
    let obj = args.as_object().ok_or_else(invalid)?;
    if obj.keys().any(|k| {
        ![
            "environmentId",
            "threadId",
            "action",
            "title",
            "clientRequestId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    let thread = match obj.get("threadId") {
        None => scope.thread_id.as_str(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim(),
        _ => return Err(invalid()),
    };
    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .filter(|s| ["rename", "regenerate_title"].contains(s))
        .ok_or_else(invalid)?;
    let input = match (action, obj.get("title")) {
        ("rename", Some(Value::String(s)))
            if !s.trim().is_empty() && s.trim().encode_utf16().count() <= 512 =>
        {
            json!({"title":s.trim()})
        }
        ("regenerate_title", None) => json!({"regenerateTitle":true}),
        _ => return Err(invalid()),
    };
    let key = match obj.get("clientRequestId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(s))
            if !s.trim().is_empty() && s.trim().encode_utf16().count() <= 256 =>
        {
            s.trim().to_owned()
        }
        _ => return Err(invalid()),
    };
    let encode = crate::message_commands::encode_id_part;
    let command = format!(
        "command:mcp:{}:thread-update:{}:{}:{}",
        encode(&scope.provider_session_id),
        encode(thread),
        action,
        encode(&key)
    );
    let denied = RefCell::new(None);
    let result =
        crate::thread_metadata::dispatch_checked(bus, &command, thread, &input, now, |tx| {
            crate::mcp_thread_organize::check(tx, scope, thread).map_err(|error| {
                *denied.borrow_mut() = Some(error);
                rusqlite::Error::InvalidQuery
            })
        })
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
                .unwrap_or_else(|| "Thread update failed.".into()),
        ));
    }
    bus.commit(|tx| {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_events WHERE command_id=?1 AND stream_id=?2 AND event_type='thread.metadata-updated' ORDER BY sequence LIMIT 1", params![command,thread], |r|r.get(0)).optional()?;
        let raw = match raw { Some(s) => s, None => tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread], |r|r.get(0))? };
        let t: Value = serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        Ok((json!({"threadId":thread,"action":action,"commandId":command,"sequence":result.receipt.result_sequence,"title":t["title"],"titleRegeneration":t["titleRegeneration"],"linkedPullRequest":t["linkedPullRequest"],"updatedAt":t["updatedAt"]}), vec![]))
    }).map_err(|e| ("orchestration_error",e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn update_is_authorized_and_replays_original_result() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        for (id, mode) in [
            ("caller", "auto"),
            ("target", "auto"),
            ("higher", "full-access"),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p',?1,'codex','codex',?2,'default','now','now',?3)", params![id,mode,json!({"id":id,"title":id,"updatedAt":"now","runtimeMode":mode,"interactionMode":"default"}).to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES('r','caller',1,'codex','codex','running','now','{}')",[]).unwrap();
        let bus = EventBus::new(db, 16);
        let scope = Scope {
            thread_id: "caller".into(),
            provider_session_id: "s".into(),
            provider_instance_id: "codex".into(),
            capabilities: HashSet::from(["orchestration".into()]),
            subagent: false, client: None,
        };
        let args = json!({"threadId":"target","action":"rename","title":" Updated ","clientRequestId":"same"});
        let first = call(&bus, &scope, &args, "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(first["title"], "Updated");
        let other = json!({"threadId":"target","action":"rename","title":"Other","clientRequestId":"other"});
        call(&bus, &scope, &other, "2026-01-01T00:00:01Z").unwrap();
        assert_eq!(
            call(&bus, &scope, &args, "2026-01-01T00:00:02Z").unwrap(),
            first
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"threadId":"higher","action":"rename","title":"X"}),
                "now"
            )
            .unwrap_err()
            .0,
            "runtime_mode_escalation_denied"
        );
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"action":"regenerate_title","title":"X"}),
                "now"
            )
            .unwrap_err()
            .0,
            "invalid_request"
        );
        // Linked callers may mutate only work started by the same link.
        bus.commit(|tx| {
            for (id, origin) in [("caller", json!({"sessionId":"laptop","label":"Laptop","access":"auto"})), ("target", json!({"sessionId":"desk","label":"Desk","access":"auto"}))] {
                tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin',json(?1)) WHERE thread_id=?2", params![origin.to_string(), id])?;
            }
            Ok(((), vec![]))
        }).unwrap();
        assert_eq!(
            call(
                &bus,
                &scope,
                &json!({"threadId":"target","action":"rename","title":"Denied"}),
                "now"
            )
            .unwrap_err()
            .0,
            "capability_denied"
        );
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.linkOrigin.sessionId','laptop') WHERE thread_id='target'", [])?;
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='r'", [])?;
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.pendingBackgroundTasks',json('[{\"kind\":\"subagent\",\"providerInstanceId\":\"codex\"}]')) WHERE thread_id='caller'", [])?;
            Ok(((), vec![]))
        }).unwrap();
        assert!(call(
            &bus,
            &scope,
            &json!({"threadId":"target","action":"rename","title":"Allowed"}),
            "now"
        )
        .is_ok());
        let regenerated = call(
            &bus,
            &scope,
            &json!({"threadId":"target","action":"regenerate_title"}),
            "2026-01-01T00:00:03Z",
        )
        .unwrap();
        assert!(regenerated["titleRegeneration"]["requestId"].is_string());
    }
}
