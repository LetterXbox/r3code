//! Guarded, durable checkpoint rollback execution.
use crate::{
    checkpoint,
    event_bus::EventBus,
    event_store::{self, Event},
    outbox::Effect,
    provider::{executor::CodexTurnExecutor, rollback},
    workspace_safety::{self, ReservationKind},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn time() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn load(tx: &rusqlite::Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = tx.query_row(sql, [id], |r| r.get(0)).optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}
fn marker(
    bus: &EventBus,
    effect: &Effect,
    path: &str,
    value: Value,
    previous: Option<&str>,
) -> Result<(), String> {
    let owner = effect.lease_owner.as_deref().ok_or("Missing lease owner")?;
    bus.commit(|tx| {
        let n = tx.execute("UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json,?3,json(?4)) WHERE effect_id=?1 AND lease_owner=?2 AND status='running' AND ((?5 IS NULL AND json_type(payload_json,?3) IS NULL) OR json_extract(payload_json,?3||'.state')=?5)", params![effect.id,owner,path,value.to_string(),previous])?;
        if n != 1 { return Err(rusqlite::Error::InvalidQuery); }
        Ok(((),vec![]))
    }).map_err(|e| e.to_string())
}

fn managed(
    path: &std::path::Path,
    default_root: &std::path::Path,
    settings: &std::path::Path,
) -> bool {
    use std::path::{Component, Path};
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    let mut roots = vec![default_root.to_path_buf()];
    if let Ok(value) = std::fs::read(settings)
        .and_then(|v| serde_json::from_slice::<Value>(&v).map_err(std::io::Error::other))
    {
        let mut values = vec![&value["worktreesDirectory"]];
        if let Some(previous) = value["previousWorktreesDirectories"].as_array() {
            values.extend(previous);
        }
        for v in values {
            if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                let expanded = if s == "~" || s.starts_with("~/") {
                    std::env::var_os("HOME").map(PathBuf::from).map(|home| {
                        if s == "~" {
                            home
                        } else {
                            home.join(&s[2..])
                        }
                    })
                } else {
                    Some(PathBuf::from(s))
                };
                if let Some(root) = expanded
                    .filter(|p| p.is_absolute() && p.parent().is_some_and(|x| x != Path::new("")))
                {
                    roots.push(root);
                }
            }
        }
    }
    let candidate = workspace_safety::canonicalize_reservation(path);
    roots.into_iter().any(|root| {
        let root = workspace_safety::canonicalize_reservation(&root);
        root.parent().is_some_and(|parent| parent != root)
            && candidate.strip_prefix(root).ok().is_some_and(|rel| {
                rel.components().count() == 2
                    && rel.components().all(|c| matches!(c, Component::Normal(_)))
            })
    })
}

fn recreate_worktree(
    bus: &EventBus,
    thread: &Value,
    scope: &Value,
    restore: bool,
    root: &std::path::Path,
    settings: &std::path::Path,
) -> Result<(), String> {
    use std::{fs, path::Path, process::Command};
    let (Some(path), Some(branch), Some(project)) = (
        thread["worktreePath"].as_str(),
        thread["branch"].as_str(),
        thread["projectId"].as_str(),
    ) else {
        return Ok(());
    };
    let path = Path::new(path);
    let exists = path.try_exists().map_err(|e| e.to_string())?;
    let leftover =
        restore && exists && !path.join(".git").try_exists().map_err(|e| e.to_string())?;
    if (exists && !leftover) || !managed(path, root, settings) {
        return Ok(());
    }
    let project_root: Option<String> = bus
        .commit(|tx| {
            Ok((
                tx.query_row(
                    "SELECT workspace_root FROM projection_projects WHERE project_id=?1",
                    [project],
                    |r| r.get(0),
                )
                .optional()?,
                vec![],
            ))
        })
        .map_err(|e| e.to_string())?;
    let Some(project_root) = project_root else {
        return Ok(());
    };
    if leftover {
        let cwd = required(scope, "cwd")?;
        let safe = bus
            .commit(|tx| {
                Ok((
                    workspace_safety::restore_isolated_in_snapshot(
                        tx,
                        required(thread, "id").map_err(|_| rusqlite::Error::InvalidQuery)?,
                        Some(path),
                        Path::new(cwd),
                    )?,
                    vec![],
                ))
            })
            .map_err(|e| e.to_string())?;
        if !safe {
            return Err(workspace_safety::SHARED_WORKSPACE_RESTORE_MESSAGE.into());
        }
    }
    let aside = if leftover {
        let parent = path.parent().ok_or("Missing worktree parent")?;
        let aside = parent.join(format!(".t3-replaced-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&aside).map_err(|e| e.to_string())?;
        if let Err(e) = fs::rename(path, aside.join("folder")) {
            let _ = fs::remove_dir(&aside);
            return Err(e.to_string());
        }
        Some(aside)
    } else {
        None
    };
    let run = |args: &[&std::ffi::OsStr]| -> Result<(), String> {
        let result = Command::new("git")
            .current_dir(&project_root)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if result.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&result.stderr).into_owned())
        }
    };
    let result = run(&["worktree".as_ref(), "prune".as_ref()]).and_then(|_| {
        run(&[
            "worktree".as_ref(),
            "add".as_ref(),
            "--".as_ref(),
            path.as_os_str(),
            branch.as_ref(),
        ])
    });
    if let Some(aside) = aside {
        if result.is_err() {
            if path.exists() {
                fs::remove_dir_all(path).map_err(|e| {
                    format!(
                        "Could not remove failed checkout; original preserved at {}: {e}",
                        aside.display()
                    )
                })?;
            }
            fs::rename(aside.join("folder"), path).map_err(|e| {
                format!(
                    "Could not restore original folder from {}: {e}",
                    aside.display()
                )
            })?;
        }
        fs::remove_dir_all(&aside)
            .map_err(|e| format!("Could not remove set-aside folder {}: {e}", aside.display()))?;
    }
    result
}

pub async fn execute(
    bus: &EventBus,
    provider: &CodexTurnExecutor,
    effect: &Effect,
) -> Result<(), String> {
    execute_with_roots(
        bus,
        provider,
        effect,
        std::path::Path::new(""),
        std::path::Path::new(""),
    )
    .await
}

pub async fn execute_with_roots(
    bus: &EventBus,
    provider: &CodexTurnExecutor,
    effect: &Effect,
    worktrees_root: &std::path::Path,
    settings_path: &std::path::Path,
) -> Result<(), String> {
    let pt_id = required(&effect.request, "providerThreadId")?.to_owned();
    let checkpoint_id = required(&effect.request, "checkpointId")?.to_owned();
    let scope_id = required(&effect.request, "scopeId")?.to_owned();
    let restore = effect.request["restoreFiles"] != false;
    let worktree = bus.commit(|tx| Ok((load(tx,"SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",&effect.thread_id)?.and_then(|v| v["worktreePath"].as_str().map(PathBuf::from)),vec![]))).map_err(|e| e.to_string())?;
    // Blocking lock acquisition stays off the async runtime. Both guards survive
    // through all mutations and projection publication.
    let guard_path = worktree.clone();
    let (_reservation, _lease) = tokio::task::spawn_blocking(move || {
        let reservation = if restore {
            guard_path
                .as_ref()
                .map(|p| workspace_safety::reserve(p, ReservationKind::Restore))
        } else {
            None
        };
        let lease = guard_path.as_ref().map(workspace_safety::workspace_lease);
        (reservation, lease)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (thread,pt,ck,scope,count,head,later) = bus.commit(|tx| {
        let thread = load(tx,"SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",&effect.thread_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let pt = load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",&pt_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let ck = load(tx,"SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id=?1",&checkpoint_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let scope = load(tx,"SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id=?1",&scope_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        if thread["worktreePath"].as_str().map(PathBuf::from) != worktree { return Err(rusqlite::Error::InvalidQuery); }
        if thread["activeProviderThreadId"] != pt_id || thread["rollbackRequestId"] != effect.command_id || ck["threadId"] != effect.thread_id || scope["threadId"] != effect.thread_id || ck["scopeId"] != scope_id || !(ck["status"] == "ready" || (!restore && ck["status"] == "missing")) { return Err(rusqlite::Error::InvalidQuery); }
        let cwd = scope["cwd"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        if restore && !workspace_safety::restore_isolated_in_snapshot(tx,&effect.thread_id,worktree.as_deref(),std::path::Path::new(cwd))? { return Err(rusqlite::Error::InvalidQuery); }
        let ordinal = ck["appRunOrdinal"].as_i64().unwrap_or(0);
        let active:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))",[&effect.thread_id],|r|r.get(0))?;
        if active { return Err(rusqlite::Error::InvalidQuery); }
        if pt["providerInstanceId"] != thread["modelSelection"]["instanceId"] { return Err(rusqlite::Error::InvalidQuery); }
        let target: Option<(i64,String)> = if ordinal > 0 {
            tx.query_row("SELECT t.ordinal,t.payload_json FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=json_extract(r.payload_json,'$.activeAttemptId') JOIN orchestration_v2_projection_provider_turns t ON t.provider_turn_id=COALESCE((SELECT x.provider_turn_id FROM orchestration_v2_projection_provider_turns x WHERE x.run_attempt_id=a.attempt_id ORDER BY x.ordinal DESC LIMIT 1),a.provider_turn_id) WHERE r.thread_id=?1 AND r.ordinal=?2 AND r.status!='rolled_back' AND t.provider_thread_id=?3",params![effect.thread_id,ordinal,pt_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?
        } else { None };
        if ordinal > 0 && target.is_none() { return Err(rusqlite::Error::InvalidQuery); }
        let boundary = target.as_ref().map_or(0, |t| t.0);
        let head = target.as_ref().map(|t| serde_json::from_str::<Value>(&t.1).map(|v|v["nativeTurnRef"].clone()).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()?.unwrap_or(Value::Null);
        let count:i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_provider_turns t LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=t.run_attempt_id LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id WHERE t.provider_thread_id=?1 AND t.ordinal>?2 AND t.status IN ('completed','failed','cancelled','interrupted') AND json_type(t.payload_json,'$.nativeTurnRef')='object' AND COALESCE(r.status,'')!='rolled_back'",params![pt_id,boundary],|r|r.get(0))?;
        let later_runs:i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status IN ('completed','failed','cancelled','interrupted')",params![effect.thread_id,ordinal],|r|r.get(0))?;
        let count=if later_runs == 0 {0} else {count};
        let later={
            let mut stmt=tx.prepare("SELECT json_extract(t.payload_json,'$.nativeTurnRef.nativeId') FROM orchestration_v2_projection_provider_turns t LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=t.run_attempt_id LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id WHERE t.provider_thread_id=?1 AND t.ordinal>?2 AND t.status IN ('completed','failed','cancelled','interrupted') AND COALESCE(r.status,'')!='rolled_back' ORDER BY t.ordinal")?;
            let rows=stmt.query_map(params![pt_id,boundary],|row|row.get::<_,Option<String>>(0))?;
            rows.collect::<Result<Vec<_>,_>>()?.into_iter().map(Option::unwrap_or_default).collect::<Vec<_>>()
        };
        Ok(((thread,pt,ck,scope,count,head,later),vec![]))
    }).map_err(|e| format!("Invalid or unsafe rollback target: {e}"))?;
    let state = &effect.request["nativeRollback"];
    if state["state"] == "started" {
        return Err("Native rollback outcome is uncertain; refusing to repeat it.".into());
    }
    let mut opencode_prepared =
        if pt["driver"] == "opencode" && !later.is_empty() && state["state"] != "applied" {
            Some(
                crate::provider::opencode_rollback::prepare(
                    settings_path,
                    required(&pt, "providerInstanceId")?,
                    &effect.thread_id,
                    required(&scope, "cwd")?,
                    required(&pt["nativeThreadRef"], "nativeId")?,
                    &later,
                )
                .await?,
            )
        } else {
            None
        };
    recreate_worktree(bus, &thread, &scope, restore, worktrees_root, settings_path)?;
    if (count > 0 || (pt["driver"] == "opencode" && !later.is_empty()))
        && state["state"] != "applied"
    {
        let sid = required(&pt, "providerSessionId")?;
        let native = required(&pt["nativeThreadRef"], "nativeId")?;
        if pt["driver"] == "opencode" {
            let prepared = opencode_prepared
                .as_mut()
                .ok_or("Missing OpenCode rollback preparation")?;
            if let Some(boundary) = prepared.boundary.clone() {
                marker(
                    bus,
                    effect,
                    "$.nativeRollback",
                    json!({"state":"started","boundary":boundary}),
                    None,
                )?;
                let forked = prepared
                    .apply(
                        thread["runtimeMode"]
                            .as_str()
                            .unwrap_or("approval-required"),
                    )
                    .await?;
                marker(
                    bus,
                    effect,
                    "$.nativeRollback",
                    json!({"state":"applied","boundary":boundary,"nativeThreadId":forked}),
                    Some("started"),
                )?;
            }
        } else {
            let session = provider
                .sessions
                .open(sid, (provider.launch)())
                .map_err(|e| e.to_string())?;
            let params = crate::provider::codex_thread_runtime_params(
                Some(&effect.thread_id),
                scope["cwd"].as_str(),
                thread
                    .pointer("/modelSelection/model")
                    .and_then(Value::as_str),
                None,
            );
            let boundary = rollback::prepare_boundary(&session, native, count as usize, params)
                .await?
                .ok_or("Missing native rollback boundary")?;
            marker(
                bus,
                effect,
                "$.nativeRollback",
                json!({"state":"started","boundary":boundary}),
                None,
            )?;
            let response = rollback::apply_boundary(&session, native, Some(&boundary)).await?;
            marker(
                bus,
                effect,
                "$.nativeRollback",
                json!({"state":"applied","boundary":boundary,"response":response}),
                Some("started"),
            )?;
        }
    }
    if restore {
        let isolated = bus
            .commit(|tx| {
                Ok((
                    workspace_safety::restore_isolated_in_snapshot(
                        tx,
                        &effect.thread_id,
                        worktree.as_deref(),
                        std::path::Path::new(
                            required(&scope, "cwd").map_err(|_| rusqlite::Error::InvalidQuery)?,
                        ),
                    )?,
                    vec![],
                ))
            })
            .map_err(|e| e.to_string())?;
        if !isolated {
            return Err(workspace_safety::SHARED_WORKSPACE_RESTORE_MESSAGE.into());
        }
        let state = &effect.request["fileRollback"];
        if state["state"] == "started" {
            return Err("File restore outcome is uncertain; refusing to repeat it.".into());
        }
        if state["state"] != "applied" {
            let cwd = required(&scope, "cwd")?.to_owned();
            let reference = required(&ck, "ref")?.to_owned();
            // Verify before the write-ahead marker, then fail closed if a crash
            // occurs during the destructive operation.
            if !checkpoint::has_ref(std::path::Path::new(&cwd), &reference)
                .map_err(|e| e.to_string())?
            {
                return Err("Checkpoint reference missing".into());
            }
            marker(
                bus,
                effect,
                "$.fileRollback",
                json!({"state":"started"}),
                None,
            )?;
            // Keep the guards alive until the synchronous restore has finished,
            // even if the worker's async future is cancelled.
            let ok = checkpoint::restore(std::path::Path::new(&cwd), &reference)
                .map_err(|e| e.to_string())?;
            if !ok {
                return Err("Checkpoint reference missing".into());
            }
            marker(
                bus,
                effect,
                "$.fileRollback",
                json!({"state":"applied"}),
                Some("started"),
            )?;
        }
    }
    // Stale refs are deterministic and deleting an already-deleted ref is safe.
    let stale = bus.commit(|tx| {
        let mut stmt=tx.prepare("SELECT ordinal_within_scope FROM orchestration_v2_projection_checkpoints WHERE thread_id=?1 AND scope_id=?2 AND app_run_ordinal>?3 AND status='ready'")?;
        let rows=stmt.query_map(params![effect.thread_id,scope_id,ck["appRunOrdinal"].as_i64().unwrap_or(0)],|r|r.get::<_,i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows,vec![]))
    }).map_err(|e|e.to_string())?;
    let refs: Vec<String> = stale
        .into_iter()
        .map(|n| checkpoint::checkpoint_ref(&scope_id, n as u64))
        .collect();
    checkpoint::delete_refs(std::path::Path::new(required(&scope, "cwd")?), &refs)
        .map_err(|e| e.to_string())?;
    finish(bus, effect, &pt_id, &scope_id, &ck, &head)
}

fn finish(
    bus: &EventBus,
    effect: &Effect,
    pt_id: &str,
    scope_id: &str,
    ck: &Value,
    head: &Value,
) -> Result<(), String> {
    let at = time();
    let ordinal = ck["appRunOrdinal"].as_i64().unwrap_or(0);
    bus.commit(|tx| {
        let mut pt=load(tx,"SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",pt_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let thread=load(tx,"SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",&effect.thread_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id=?1 AND lease_owner=?2 AND status='running')",params![effect.id,effect.lease_owner],|r|r.get(0))?;
        if !owned || thread["rollbackRequestId"] != effect.command_id || thread["activeProviderThreadId"] != pt_id { return Err(rusqlite::Error::InvalidQuery); }
        let completed: bool = tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.rollbackProjectionApplied'),0) FROM orchestration_v2_effect_outbox WHERE effect_id=?1",[&effect.id],|r|r.get(0))?;
        if completed { return Ok(((),vec![])); }
        let native:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.nativeRollback.nativeThreadId') FROM orchestration_v2_effect_outbox WHERE effect_id=?1",[&effect.id],|row|row.get(0)).optional()?.flatten();
        if let Some(native)=native {pt["nativeThreadRef"]=json!({"driver":"opencode","nativeId":native,"strength":"strong"});}
        pt["nativeConversationHeadRef"]=head.clone(); pt["status"]=json!("idle"); pt["lastRunOrdinal"]=if ordinal==0 {Value::Null} else {json!(ordinal)}; pt["updatedAt"]=json!(at);
        tx.execute("UPDATE orchestration_v2_projection_provider_threads SET payload_json=?2,last_run_ordinal=?3,updated_at=?4,status='idle' WHERE provider_thread_id=?1",params![pt_id,pt.to_string(),if ordinal==0 {None} else {Some(ordinal)},at])?;
        let mut payloads=vec![("provider-thread.updated",pt)];
        let mut stmt=tx.prepare("SELECT checkpoint_id,payload_json FROM orchestration_v2_projection_checkpoints WHERE thread_id=?1 AND scope_id=?2 AND app_run_ordinal>?3 AND status='ready' ORDER BY app_run_ordinal")?;
        let checkpoints=stmt.query_map(params![effect.thread_id,scope_id,ordinal],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?; drop(stmt);
        for (id,raw) in checkpoints { let mut p:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; p["status"]=json!("stale"); tx.execute("UPDATE orchestration_v2_projection_checkpoints SET status='stale',payload_json=?2 WHERE checkpoint_id=?1",params![id,p.to_string()])?; payloads.push(("checkpoint.captured",p)); }
        let mut stmt=tx.prepare("SELECT run_id,payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND ordinal>?2 AND status IN ('completed','failed','cancelled','interrupted') ORDER BY ordinal")?;
        let runs=stmt.query_map(params![effect.thread_id,ordinal],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?; drop(stmt);
        for (id,raw) in runs { let mut p:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?; p["status"]=json!("rolled_back"); p["completedAt"]=json!(at); tx.execute("UPDATE orchestration_v2_projection_runs SET status='rolled_back',completed_at=?2,payload_json=?3 WHERE run_id=?1",params![id,at,p.to_string()])?; payloads.push(("run.updated",p));
            let node:Option<(String,String)>=tx.query_row("SELECT node_id,payload_json FROM orchestration_v2_projection_nodes WHERE run_id=?1 AND node_id=root_node_id LIMIT 1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((nid,raw))=node {let mut p:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;p["status"]=json!("rolled_back");p["completedAt"]=json!(at);tx.execute("UPDATE orchestration_v2_projection_nodes SET status='rolled_back',completed_at=?2,payload_json=?3 WHERE node_id=?1",params![nid,at,p.to_string()])?;payloads.push(("node.updated",p));}
        }
        let events:Vec<Event>=payloads.into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:effect.thread_id.clone(),event_type:kind.into(),occurred_at:at.clone(),command_id:Some(effect.command_id.clone()),causation_event_id:None,correlation_id:Some(effect.command_id.clone()),actor_kind:"system".into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;
        tx.execute("UPDATE orchestration_v2_effect_outbox SET payload_json=json_set(payload_json,'$.rollbackProjectionApplied',json('true')) WHERE effect_id=?1",[&effect.id])?;
        Ok(((),stored))
    }).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{outbox, provider::session_registry::SessionRegistry};
    use std::sync::Arc;

    #[test]
    fn managed_recreation_restores_original_on_git_failure() {
        use std::{fs, process::Command};
        let dir = std::env::temp_dir().join(format!("rollback-worktree-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        let root = dir.join("worktrees");
        let tree = root.join("repo/feature");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(tree.parent().unwrap()).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial"
            ])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','repo',?1,'[]','now','now')", [repo.to_str().unwrap()]).unwrap();
        let bus = EventBus::new(db, 32);
        let thread =
            json!({"id":"t", "projectId":"p", "worktreePath":tree, "branch":"does-not-exist"});
        let scope = json!({"cwd":tree});
        fs::create_dir(&tree).unwrap();
        fs::write(tree.join("user-file"), "preserve").unwrap();
        assert!(recreate_worktree(&bus, &thread, &scope, true, &root, &dir.join("none")).is_err());
        assert_eq!(
            fs::read_to_string(tree.join("user-file")).unwrap(),
            "preserve"
        );
        fs::remove_dir_all(&tree).unwrap();
        let mut thread = thread;
        thread["branch"] = json!("feature");
        assert!(Command::new("git")
            .args(["branch", "feature"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        recreate_worktree(&bus, &thread, &scope, false, &root, &dir.join("none")).unwrap();
        assert!(tree.join(".git").exists());
        assert!(!managed(&root.join("repo"), &root, &dir.join("none")));
        assert!(!managed(
            &root.join("repo/feature/nested"),
            &root,
            &dir.join("none")
        ));
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn projection_commit_is_replayable_and_uncertain_native_revert_is_not_repeated() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let effect = Effect {
            id: "e".into(),
            command_id: "c".into(),
            thread_id: "t".into(),
            request: json!({"type":"provider-thread.rollback","providerThreadId":"pt","checkpointId":"ck","scopeId":"sc","restoreFiles":false}),
            status: "running".into(),
            attempt_count: 1,
            available_at: "now".into(),
            lease_owner: Some("worker".into()),
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            last_error: None,
        };
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)",[json!({"id":"t","activeProviderThreadId":"pt","rollbackRequestId":"c"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','idle','now',?1)",[json!({"id":"pt","driver":"codex","providerSessionId":"s"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,node_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES('sc','t','n','root',0,1,'now',?1)",[json!({"id":"sc","threadId":"t","cwd":"/tmp"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoints(checkpoint_id,thread_id,scope_id,node_id,ordinal_within_scope,app_run_ordinal,status,captured_at,payload_json) VALUES('ck','t','sc','n',0,0,'ready','now',?1)",[json!({"id":"ck","threadId":"t","scopeId":"sc","appRunOrdinal":0,"status":"ready"}).to_string()])?;
            let mut pending=effect.clone(); pending.status="pending".into();pending.lease_owner=None;outbox::enqueue(tx,&pending)?;
            tx.execute("UPDATE orchestration_v2_effect_outbox SET status='running',lease_owner='worker' WHERE effect_id='e'",[])?;
            Ok(((),vec![]))
        }).unwrap();
        let provider = CodexTurnExecutor::new(bus.clone(), Arc::new(SessionRegistry::default()));
        let mut uncertain = effect.clone();
        uncertain.request["nativeRollback"] = json!({"state":"started","boundary":"turn"});
        assert!(execute(&bus, &provider, &uncertain)
            .await
            .unwrap_err()
            .contains("uncertain"));
        execute(&bus, &provider, &effect).await.unwrap();
        let before = bus
            .commit(|tx| Ok((event_store::latest_thread_sequence(tx, Some("t"))?, vec![])))
            .unwrap();
        execute(&bus, &provider, &effect).await.unwrap();
        let after = bus
            .commit(|tx| Ok((event_store::latest_thread_sequence(tx, Some("t"))?, vec![])))
            .unwrap();
        assert_eq!(before, after);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn reverts_native_history_restores_files_and_retires_later_history() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let dir = std::env::temp_dir().join(format!("rollback-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap()
            .success());
        let cwd = dir.to_str().unwrap();
        std::fs::write(dir.join("file"), "before").unwrap();
        let reference = checkpoint::checkpoint_ref("sc", 0);
        checkpoint::capture(&dir, &reference).unwrap();
        std::fs::write(dir.join("file"), "after").unwrap();
        let stale = checkpoint::checkpoint_ref("sc", 1);
        checkpoint::capture(&dir, &stale).unwrap();
        let script = dir.join("provider.py");
        std::fs::write(&script,r##"#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params') or {}
 if method=='initialized': continue
 if method=='initialize': result={}
 elif method=='thread/read': result={'thread':{'id':'native','historyMode':'paginated','status':{'type':'idle'}}}
 elif method=='thread/turns/list':
  assert p['limit']==1; result={'data':[{'id':'native-turn'}],'nextCursor':None}
 elif method=='thread/revert':
  assert p=={'threadId':'native','beforeTurnId':'native-turn'}; result={'thread':{'id':'native'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
"##).unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        // The provider binary is outside the restore tree, which removes untracked files.
        let binary =
            std::env::temp_dir().join(format!("rollback-provider-{}", uuid::Uuid::new_v4()));
        std::fs::copy(&script, &binary).unwrap();
        std::fs::set_permissions(&binary, std::fs::metadata(&script).unwrap().permissions())
            .unwrap();
        std::fs::remove_file(&script).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let effect = Effect {
            id: "e".into(),
            command_id: "c".into(),
            thread_id: "t".into(),
            request: json!({"type":"provider-thread.rollback","providerThreadId":"pt","checkpointId":"ck","scopeId":"sc"}),
            status: "running".into(),
            attempt_count: 1,
            available_at: "now".into(),
            lease_owner: Some("worker".into()),
            created_at: "now".into(),
            updated_at: "now".into(),
            completed_at: None,
            last_error: None,
        };
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now',?1)",[json!({"id":"t","activeProviderThreadId":"pt","rollbackRequestId":"c","worktreePath":cwd,"modelSelection":{"instanceId":"codex","model":"m"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','t','codex','idle','now',?1)",[json!({"id":"pt","driver":"codex","providerInstanceId":"codex","providerSessionId":"s","nativeThreadRef":{"nativeId":"native"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id,thread_id,node_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES('sc','t','n','root',0,1,'now',?1)",[json!({"id":"sc","threadId":"t","cwd":cwd}).to_string()])?;
            for (id,n,reference) in [("ck",0,&reference),("later",1,&stale)] {tx.execute("INSERT INTO orchestration_v2_projection_checkpoints(checkpoint_id,thread_id,scope_id,node_id,ordinal_within_scope,app_run_ordinal,status,captured_at,payload_json) VALUES(?1,'t','sc','n',?2,?2,'ready','now',?3)",params![id,n,json!({"id":id,"threadId":"t","scopeId":"sc","appRunOrdinal":n,"status":"ready","ref":reference}).to_string()])?;}
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','completed','now',?1)",[json!({"id":"r","status":"completed"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES('a','t','r',1,'n','codex','pt','completed','{}')",[])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','t','pt','n','a',1,'completed',?1)",[json!({"id":"turn","nativeTurnRef":{"nativeId":"native-turn"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json) VALUES('local','t','pt','n',2,'completed',?1)",[json!({"id":"local","nativeTurnRef":null}).to_string()])?;
            let mut pending=effect.clone();pending.status="pending".into();pending.lease_owner=None;outbox::enqueue(tx,&pending)?;tx.execute("UPDATE orchestration_v2_effect_outbox SET status='running',lease_owner='worker' WHERE effect_id='e'",[])?;Ok(((),vec![]))
        }).unwrap();
        let mut provider =
            CodexTurnExecutor::new(bus.clone(), Arc::new(SessionRegistry::default()));
        let launch_binary = binary.clone();
        provider.launch = Arc::new(move || crate::provider::CodexLaunch {
            binary: Some(launch_binary.clone()),
            ..Default::default()
        });
        execute(&bus, &provider, &effect).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("file")).unwrap(), "before");
        assert!(!checkpoint::has_ref(&dir, &stale).unwrap());
        bus.commit(|tx| {let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE run_id='r'",[],|r|r.get(0))?;assert_eq!(status,"rolled_back");let status:String=tx.query_row("SELECT status FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id='later'",[],|r|r.get(0))?;assert_eq!(status,"stale");Ok(((),vec![]))}).unwrap();
        provider.sessions.remove("s").unwrap();
        std::fs::remove_file(binary).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
