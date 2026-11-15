//! Native Codex rollback primitives. Persist the selected boundary before issuing
//! `apply_boundary`: selecting by count again after an uncertain request is unsafe.
use super::session_registry::SessionHandle;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(30);

async fn request(session: &SessionHandle, method: &str, params: Value) -> Result<Value, String> {
    session
        .request(method, Some(params), TIMEOUT)
        .await
        .map_err(|e| e.to_string())
}

/// Initialize, verify history supports revert, resume unloaded threads, and find
/// the oldest of the requested newest native turns. This performs no revert.
pub async fn prepare_boundary(
    session: &SessionHandle,
    thread_id: &str,
    count: usize,
    mut resume_params: Value,
) -> Result<Option<String>, String> {
    if count == 0 {
        return Ok(None);
    }
    session
        .initialize(TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    let metadata = request(
        session,
        "thread/read",
        json!({"threadId":thread_id,"includeTurns":false}),
    )
    .await?;
    let thread = metadata
        .get("thread")
        .and_then(Value::as_object)
        .ok_or("Invalid thread/read response")?;
    if thread.get("historyMode").and_then(Value::as_str) != Some("paginated") {
        return Err(format!("Cannot roll back Codex thread {thread_id}: the thread uses legacy history, which Codex 0.156 cannot revert."));
    }
    if thread
        .get("status")
        .and_then(|s| s.get("type"))
        .and_then(Value::as_str)
        == Some("notLoaded")
    {
        let params = resume_params
            .as_object_mut()
            .ok_or("Invalid resume parameters")?;
        params.insert("threadId".into(), json!(thread_id));
        params.insert("excludeTurns".into(), json!(true));
        request(session, "thread/resume", resume_params).await?;
    }
    let mut remaining = count;
    let mut cursor: Option<String> = None;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(cursor.clone()) {
            return Err("Thread history pagination repeated a cursor.".into());
        }
        let page = request(session, "thread/turns/list", json!({"threadId":thread_id,"cursor":cursor,"limit":remaining.min(100),"sortDirection":"desc","itemsView":"summary"})).await?;
        let data = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or("Invalid thread/turns/list response")?;
        for turn in data {
            let id = turn
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("Invalid native turn ID")?;
            remaining -= 1;
            if remaining == 0 {
                return Ok(Some(id.to_owned()));
            }
        }
        cursor = match page.get("nextCursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => return Err("Invalid thread history cursor".into()),
        };
        if cursor.is_none() {
            return Err("Native thread history has fewer turns than the rollback requires.".into());
        }
    }
}

/// Apply a previously persisted boundary. Repeating the same boundary is safe
/// only if the provider guarantees that boundary still identifies the intended
/// history; callers must resolve uncertain outcomes before replaying.
pub async fn apply_boundary(
    session: &SessionHandle,
    thread_id: &str,
    boundary: Option<&str>,
) -> Result<Value, String> {
    let response = match boundary {
        Some(id) => {
            request(
                session,
                "thread/revert",
                json!({"threadId":thread_id,"beforeTurnId":id}),
            )
            .await?
        }
        None => {
            request(
                session,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )
            .await?
        }
    };
    if response.pointer("/thread/id").and_then(Value::as_str) != Some(thread_id) {
        return Err("Invalid Codex thread response".into());
    }
    Ok(response)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::provider::{session_registry::SessionRegistry, CodexLaunch};
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn selects_paginated_boundary_and_resumes_unloaded_thread() {
        let path = std::env::temp_dir().join(format!("codex-rollback-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r##"#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params') or {}
 if method=='initialized': continue
 if method=='initialize': result={}
 elif method=='thread/read': result={'thread':{'id':'thr','historyMode':'paginated','status':{'type':'notLoaded'}}}
 elif method=='thread/resume':
  assert p['threadId']=='thr' and p['excludeTurns'] and p['cwd']=='/work'; result={}
 elif method=='thread/turns/list':
  assert p['sortDirection']=='desc' and p['itemsView']=='summary'
  result=({'data':[{'id':'new'}],'nextCursor':'next'} if p['cursor'] is None else {'data':[{'id':'old'}],'nextCursor':None})
 elif method=='thread/revert':
  assert p=={'threadId':'thr','beforeTurnId':'old'}; result={'thread':{'id':'thr'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
"##).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        let registry = SessionRegistry::default();
        let session = registry
            .open(
                "test",
                CodexLaunch {
                    binary: Some(path.clone()),
                    ..CodexLaunch::default()
                },
            )
            .unwrap();
        let boundary = prepare_boundary(&session, "thr", 2, json!({"cwd":"/work"}))
            .await
            .unwrap();
        assert_eq!(boundary.as_deref(), Some("old"));
        apply_boundary(&session, "thr", boundary.as_deref())
            .await
            .unwrap();
        registry.remove("test").unwrap();
        std::fs::remove_file(path).unwrap();
    }
}

/// Persist the native boundary and a write-ahead mutation marker in the claimed
/// effect. A recovered marker is deliberately not replayed: the server may have
/// applied the prior request before its response or database update was lost.
/// This function must commit before the caller sends `thread/revert`.
pub fn mark_revert_started(
    db: &rusqlite::Connection,
    effect_id: &str,
    lease_owner: &str,
    boundary: &str,
) -> rusqlite::Result<bool> {
    if boundary.is_empty() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let updated = db.execute(
        "UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json, '$.nativeRollback', json_object('state','started','boundary',?3)) WHERE effect_id=?1 AND lease_owner=?2 AND status='running' AND json_type(payload_json,'$.nativeRollback') IS NULL",
        rusqlite::params![effect_id, lease_owner, boundary],
    )?;
    Ok(updated == 1)
}

/// Persist the response before proceeding to file restoration and projection.
/// An unmarked or superseded lease may not mark another worker's operation.
pub fn mark_revert_applied(
    db: &rusqlite::Connection,
    effect_id: &str,
    lease_owner: &str,
    boundary: &str,
    response: &Value,
) -> rusqlite::Result<bool> {
    if response
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let updated = db.execute(
        "UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json, '$.nativeRollback.state','applied', '$.nativeRollback.response',json(?4)) WHERE effect_id=?1 AND lease_owner=?2 AND status='running' AND json_extract(payload_json,'$.nativeRollback.state')='started' AND json_extract(payload_json,'$.nativeRollback.boundary')=?3",
        rusqlite::params![effect_id, lease_owner, boundary, response.to_string()],
    )?;
    Ok(updated == 1)
}

#[cfg(test)]
mod durability_tests {
    use super::*;
    #[test]
    fn mutation_marker_survives_retry_and_guards_ownership() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT PRIMARY KEY, lease_owner TEXT, status TEXT, payload_json TEXT); INSERT INTO orchestration_v2_effect_outbox VALUES('e','worker','running','{\"type\":\"provider-thread.rollback\"}');").unwrap();
        assert!(!mark_revert_started(&db, "e", "other", "turn").unwrap());
        assert!(mark_revert_started(&db, "e", "worker", "turn").unwrap());
        assert!(!mark_revert_started(&db, "e", "worker", "turn").unwrap());
        assert!(!mark_revert_applied(
            &db,
            "e",
            "worker",
            "different",
            &json!({"thread":{"id":"thr"}})
        )
        .unwrap());
        assert!(
            mark_revert_applied(&db, "e", "worker", "turn", &json!({"thread":{"id":"thr"}}))
                .unwrap()
        );
        let payload: String = db
            .query_row(
                "SELECT payload_json FROM orchestration_v2_effect_outbox WHERE effect_id='e'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["nativeRollback"]["state"], "applied");
        assert_eq!(payload["nativeRollback"]["boundary"], "turn");
        assert_eq!(payload["nativeRollback"]["response"]["thread"]["id"], "thr");
    }
}
