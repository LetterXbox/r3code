//! Atomic thread metadata changes and provider detachment on workspace changes.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    outbox::{self, Effect},
    thread_commands::CommitResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub fn validate(input: &Value) -> bool {
    let Some(object) = input.as_object() else {
        return false;
    };
    if let Some(link) = object.get("linkedPullRequest") {
        if !link.is_null()
            && (link.as_object().is_none()
                || ["projectId", "repository", "url"]
                    .iter()
                    .any(|k| link[*k].as_str().is_none_or(|s| s.trim().is_empty()))
                || link["number"].as_i64().is_none_or(|n| n <= 0))
        {
            return false;
        }
    }
    for key in ["title"] {
        if let Some(v) = object.get(key) {
            if v.as_str().is_none_or(|s| s.trim().is_empty()) {
                return false;
            }
        }
    }
    for key in [
        "branch",
        "worktreePath",
        "expectedBranch",
        "expectedWorktreePath",
    ] {
        if let Some(v) = object.get(key) {
            if !v.is_null() && v.as_str().is_none_or(|s| s.trim().is_empty()) {
                return false;
            }
        }
    }
    for key in ["regenerateTitle", "expectedEmpty"] {
        if object.get(key).is_some_and(|v| !v.is_boolean()) {
            return false;
        }
    }
    if let Some(v) = object.get("limitRecovery") {
        if !v.is_null()
            && (!v.is_object()
                || v["runId"].as_str().is_none_or(|s| s.trim().is_empty())
                || v["resetAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_none()
                || (!v.get("autoResume").is_some_and(Value::is_boolean)
                    && !v.get("snooze").is_some_and(Value::is_boolean))
                || ["autoResume", "snooze"]
                    .iter()
                    .any(|k| v.get(k).is_some_and(|x| !x.is_boolean())))
        {
            return false;
        }
    }
    true
}
fn legacy_key(link: &Value) -> Option<crate::migration_050::PullRequestKey> {
    Some(crate::migration_050::legacy_pull_request_key(
        link["repository"].as_str()?,
        link["number"].as_i64()?,
        link["url"].as_str()?,
    ))
}

fn link_matches(link: &Value, key: &crate::migration_050::PullRequestKey) -> bool {
    link["host"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case(&key.host))
        && link["repository"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case(&key.repository))
        && link["number"].as_i64() == Some(key.number)
}

fn update_linked_pull_request(thread: &mut Value, replacement: &Value, now: &str) {
    let old = thread["linkedPullRequest"].clone();
    let old_key = legacy_key(&old);
    let new_key = legacy_key(replacement);
    let mut links = thread.get("pullRequests").and_then(Value::as_array).cloned().unwrap_or_else(|| {
        old_key.as_ref().map(|key| vec![json!({"host":key.host,"repository":key.repository,"number":key.number,"url":old["url"],"source":"manual","linkedAt":"1970-01-01T00:00:00.000Z","snapshot":null,"stack":null})]).unwrap_or_default()
    });
    let existing = new_key
        .as_ref()
        .and_then(|key| links.iter().find(|link| link_matches(link, key)))
        .cloned();
    links.retain(|link| {
        !old_key.as_ref().is_some_and(|key| link_matches(link, key))
            && !new_key.as_ref().is_some_and(|key| link_matches(link, key))
    });
    if let Some(key) = new_key {
        let mut url = replacement["url"].as_str().unwrap_or_default().to_owned();
        if let Ok(parsed) = url::Url::parse(&url) {
            let parts: Vec<_> = parsed
                .path_segments()
                .map(|p| p.collect())
                .unwrap_or_default();
            if parsed.host_str().is_some_and(|h| {
                h.eq_ignore_ascii_case("git.cafe") || h.eq_ignore_ascii_case("staging.git.cafe")
            }) && parts.len() >= 4
                && (parts[2] == "pull" || parts[2] == "pulls")
                && parts[3].parse::<i64>().is_ok()
            {
                url = format!(
                    "{}://{}/{}/{}/pulls/{}",
                    parsed.scheme(),
                    parsed.host_str().unwrap(),
                    parts[0],
                    parts[1],
                    parts[3]
                );
            }
        }
        let mut link = json!({"host":key.host,"repository":key.repository,"number":key.number,"url":url,"source":"manual","linkedAt":now,"snapshot":null,"stack":null});
        if let Some(existing) = existing {
            for field in ["repositoryWebUrl", "watch"] {
                if let Some(v) = existing.get(field) {
                    link[field] = v.clone();
                }
            }
            if existing.get("watch").is_none() {
                if let Some(v) = existing.get("endedWatch") {
                    link["endedWatch"] = v.clone();
                }
            }
        }
        links.push(link);
    }
    thread["linkedPullRequest"] = replacement.clone();
    thread["pullRequests"] = Value::Array(links);
}

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    input: &Value,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, input, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    input: &Value,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"thread")? {return Ok((CommitResult{receipt,committed:false},vec![]));}
        let row:Option<(String,Option<String>)>=tx.query_row("SELECT payload_json,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let mut thread:Value=match &row {Some((s,_))=>serde_json::from_str(s).map_err(|_|rusqlite::Error::InvalidQuery)?,None=>Value::Null};
        let mut error=match &row { None=>Some(format!("Thread {thread_id} does not exist.")),Some((_,Some(_)))=>Some(format!("Thread {thread_id} is deleted.")),_=>None};
        for (key,field,label) in [("expectedWorktreePath","worktreePath","worktree"),("expectedBranch","branch","branch")] {
            if error.is_none() && input.get(key).is_some_and(|v|v != &thread[field]) {error=Some(format!("Thread {thread_id} {label} changed before the metadata update could be applied."));}
        }
        if error.is_none() && input["expectedEmpty"] == true {
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id=?1 UNION ALL SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1)",[thread_id],|r|r.get(0))?;
            if exists {error=Some(format!("Thread {thread_id} is no longer empty."));}
        }
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"thread".into(),aggregate_id:thread_id.into(),command_type:"thread.metadata.update".into(),accepted_at:now.into(),result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery);}
        if receipt.error.is_some(){return Ok((CommitResult{receipt,committed:false},vec![]));}
        let worktree_changed=input.get("worktreePath").is_some_and(|v|v != &thread["worktreePath"]);
        for key in ["title","branch","worktreePath"] {if let Some(v)=input.get(key){thread[key]=v.as_str().map(|s|json!(s.trim())).unwrap_or(Value::Null);}}
        if input["regenerateTitle"]==true {thread["titleRegeneration"]=json!({"requestId":command_id,"startedAt":now});}
        else if input["regenerateTitle"]==false || input.get("title").is_some(){thread["titleRegeneration"]=Value::Null;}
        if let Some(recovery)=input.get("limitRecovery") {
            let old=thread["limitRecovery"].clone();
            if recovery.is_null(){thread["limitRecovery"]=Value::Null;}else{
                let prev=if old["runId"]==recovery["runId"] && old["resetAt"]==recovery["resetAt"] {&old}else{&Value::Null};
                thread["limitRecovery"]=json!({"requestId":command_id,"runId":recovery["runId"],"resetAt":recovery["resetAt"],"autoResume":recovery.get("autoResume").or_else(||prev.get("autoResume")).and_then(Value::as_bool).unwrap_or(false),"snooze":recovery.get("snooze").or_else(||prev.get("snooze")).and_then(Value::as_bool).unwrap_or(false)});
            }
            let reset=thread["limitRecovery"]["resetAt"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok());
            let current=chrono::DateTime::parse_from_rfc3339(now).map_err(|_|rusqlite::Error::InvalidQuery)?;
            if thread["limitRecovery"]["snooze"]==true && reset.is_some_and(|t|t>current) {thread["snoozedUntil"]=thread["limitRecovery"]["resetAt"].clone();thread["snoozedAt"]=json!(now);}
            else if old["snooze"]==true && !old["resetAt"].is_null() && thread["snoozedUntil"]==old["resetAt"] {thread["snoozedUntil"]=Value::Null;thread["snoozedAt"]=Value::Null;thread["lastSnoozeWakeAt"]=json!(now);}
        }
        if let Some(link) = input.get("linkedPullRequest") { update_linked_pull_request(&mut thread, link, now); }
        thread["updatedAt"]=json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET title=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1",params![thread_id,thread["title"].as_str(),now,thread.to_string()])?;
        let mut planned=vec![("thread.metadata-updated",thread)];
        if worktree_changed {
            let mut stmt=tx.prepare("SELECT s.provider_session_id FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.status NOT IN ('stopped','error') ORDER BY s.updated_at,s.provider_session_id")?;
            let ids=stmt.query_map([thread_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
            for id in ids {
                tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![thread_id,id])?;
                let reason="Thread worktree changed.";
                planned.push(("provider-session.detached",json!({"providerSessionId":id,"detachedAt":now,"reason":reason})));
                outbox::enqueue(tx,&Effect{id:format!("effect:{command_id}:provider-session.detach:{id}"),command_id:command_id.into(),thread_id:thread_id.into(),request:json!({"type":"provider-session.detach","providerSessionId":id,"detail":reason}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?;
            }
        }
        if input["regenerateTitle"]==true { outbox::enqueue(tx,&Effect{id:format!("effect:{command_id}:thread-title.generate"),command_id:command_id.into(),thread_id:thread_id.into(),request:json!({"type":"thread-title.generate","kind":{"type":"regenerate"}}),status:"pending".into(),attempt_count:0,available_at:now.into(),lease_owner:None,created_at:now.into(),updated_at:now.into(),completed_at:None,last_error:None})?; }
        let events:Vec<Event>=planned.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;receipt.result_sequence=stored.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?; Ok((CommitResult{receipt,committed:true},stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linked_pull_request_replaces_matching_links_and_preserves_watch() {
        let old = json!({"projectId":"p","repository":"Owner/Repo","number":1,"url":"https://github.com/Owner/Repo/pull/1"});
        let new = json!({"projectId":"p","repository":"Owner/Repo","number":2,"url":"https://github.com/Owner/Repo/pull/2"});
        assert!(validate(&json!({"linkedPullRequest":new})));
        assert!(!validate(
            &json!({"linkedPullRequest":{"projectId":"p","repository":"r","number":0,"url":"x"}})
        ));
        let mut thread = json!({"linkedPullRequest":old,"pullRequests":[
            {"host":"github.com","repository":"owner/repo","number":1},
            {"host":"github.com","repository":"owner/repo","number":2,"watch":{"type":"checks"},"repositoryWebUrl":"repo"},
            {"host":"github.com","repository":"owner/repo","number":3}
        ]});
        update_linked_pull_request(&mut thread, &new, "now");
        assert_eq!(thread["linkedPullRequest"], new);
        assert_eq!(thread["pullRequests"].as_array().unwrap().len(), 2);
        assert_eq!(thread["pullRequests"][1]["watch"]["type"], "checks");
        assert_eq!(thread["pullRequests"][1]["repositoryWebUrl"], "repo");
        assert_eq!(thread["pullRequests"][1]["linkedAt"], "now");
        update_linked_pull_request(&mut thread, &Value::Null, "later");
        assert_eq!(thread["pullRequests"].as_array().unwrap().len(), 1);
        assert!(thread["linkedPullRequest"].is_null());
    }

    #[test]
    fn metadata_guards_and_recovery_are_transactional() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","title":"Original","branch":"main","worktreePath":null,"updatedAt":"2026-01-01T00:00:00.000Z","limitRecovery":null});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','Original','codex','full-access','default','2026','2026',?1)", [thread.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let now = "2026-01-02T00:00:00.000Z";
        let stale = json!({"title":"New","expectedBranch":"old"});
        assert!(validate(&stale));
        assert_eq!(
            dispatch(&bus, "bad", "t", &stale, now)
                .unwrap()
                .receipt
                .status,
            "rejected"
        );
        let change = json!({"title":" New ","expectedBranch":"main","limitRecovery":{"runId":"r","resetAt":"2026-01-03T00:00:00.000Z","snooze":true}});
        assert!(validate(&change));
        assert!(dispatch(&bus, "good", "t", &change, now).unwrap().committed);
        assert!(!dispatch(&bus, "good", "t", &change, now).unwrap().committed);
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let value: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["title"], "New");
            assert_eq!(value["snoozedUntil"], "2026-01-03T00:00:00.000Z");
            assert_eq!(value["limitRecovery"]["requestId"], "good");
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
