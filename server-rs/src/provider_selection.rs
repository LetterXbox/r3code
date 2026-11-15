//! Provider selection transition policy. Adapter classification and background-work
//! probes are supplied by the runtime; an unavailable or failed probe must block.
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionTransition {
    ApplyOnNextTurn,
    RestartSession,
    CreateWithHandoff,
    Reject(String),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Reuse,
    SwitchModelInSession,
    RestartAndResume,
    CreateWithHandoff,
}
#[derive(Debug, Clone)]
pub struct ProviderContext<'a> {
    pub driver: &'a str,
    pub driver_kind: &'a str,
    pub continuation_key: &'a str,
    pub selection: &'a Value,
    pub runtime_mode: &'a str,
    pub workspace: &'a str,
    pub available: bool,
}

/// Options form an unordered set; missing options and an empty list are equivalent.
pub fn selections_equal(a: &Value, b: &Value) -> bool {
    if a.get("instanceId") != b.get("instanceId") || a.get("model") != b.get("model") {
        return false;
    }
    let empty = Vec::new();
    let aa = a.get("options").and_then(Value::as_array).unwrap_or(&empty);
    let bb = b.get("options").and_then(Value::as_array).unwrap_or(&empty);
    aa.len() == bb.len()
        && aa
            .iter()
            .all(|v| aa.iter().filter(|x| *x == v).count() == bb.iter().filter(|x| *x == v).count())
}

pub fn transition(
    current: Option<&ProviderContext<'_>>,
    target: &ProviderContext<'_>,
    selection: Option<&SelectionTransition>,
) -> Result<Transition, String> {
    if !target.available {
        return Err("The target provider instance is unavailable.".into());
    }
    let Some(current) = current else {
        return Ok(Transition::CreateWithHandoff);
    };
    if current.driver != target.driver
        || current.driver_kind != target.driver_kind
        || current.continuation_key != target.continuation_key
    {
        return Ok(Transition::CreateWithHandoff);
    }
    let instance_changed =
        current.selection.get("instanceId") != target.selection.get("instanceId");
    let changed = !selections_equal(current.selection, target.selection);
    if changed && !instance_changed {
        match selection {
            Some(SelectionTransition::CreateWithHandoff) => {
                return Ok(Transition::CreateWithHandoff)
            }
            Some(SelectionTransition::Reject(reason)) => return Err(reason.clone()),
            None => {
                return Err("The provider adapter did not classify the selection change.".into())
            }
            _ => {}
        }
    }
    if instance_changed
        || current.runtime_mode != target.runtime_mode
        || current.workspace != target.workspace
    {
        return Ok(Transition::RestartAndResume);
    }
    if changed {
        return Ok(match selection {
            Some(SelectionTransition::RestartSession) => Transition::RestartAndResume,
            _ => Transition::SwitchModelInSession,
        });
    }
    Ok(Transition::Reuse)
}

#[derive(Debug, Clone)]
pub struct Session<'a> {
    pub id: &'a str,
    pub instance_id: &'a str,
    pub live: bool,
    pub background_work: Result<bool, ()>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub instance_changed: bool,
    pub transition: Transition,
    pub release_session_ids: Vec<String>,
}
/// `current_session_id` is the newest live session of the current instance.
pub fn plan(
    current: Option<&ProviderContext<'_>>,
    target: &ProviderContext<'_>,
    current_instance: &str,
    current_session_id: Option<&str>,
    sessions: &[Session<'_>],
    classification: Option<&SelectionTransition>,
) -> Result<Plan, String> {
    let transition = transition(current, target, classification)?;
    let target_instance = target
        .selection
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or("Invalid model selection.")?;
    let release_session_ids = sessions
        .iter()
        .filter(|s| {
            s.live
                && match transition {
                    Transition::RestartAndResume => Some(s.id) == current_session_id,
                    Transition::CreateWithHandoff => s.instance_id != target_instance,
                    _ => false,
                }
        })
        .map(|s| s.id.to_owned())
        .collect();
    Ok(Plan {
        instance_changed: current_instance != target_instance,
        transition,
        release_session_ids,
    })
}

pub fn guard(
    plan: &Plan,
    sessions: &[Session<'_>],
    active_run: bool,
    thread_id: &str,
) -> Result<(), String> {
    if (plan.instance_changed || !plan.release_session_ids.is_empty()) && active_run {
        return Err(format!("Thread {thread_id} has an active turn. Wait for it to finish, then retry the provider selection change."));
    }
    if sessions.iter().any(|s| {
        s.live
            && plan.release_session_ids.iter().any(|id| id == s.id)
            && s.background_work != Ok(false)
    }) {
        return Err("The current session is still running background agents or commands, and this change would end them. Wait for them to finish, or press Stop, then try again.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn ctx<'a>(selection: &'a Value, key: &'a str) -> ProviderContext<'a> {
        ProviderContext {
            driver: "codex",
            driver_kind: "codex",
            continuation_key: key,
            selection,
            runtime_mode: "full-access",
            workspace: "/tmp",
            available: true,
        }
    }
    #[test]
    fn option_order_and_missing_empty() {
        assert!(selections_equal(
            &json!({"instanceId":"a","model":"m"}),
            &json!({"instanceId":"a","model":"m","options":[]})
        ));
        assert!(selections_equal(
            &json!({"instanceId":"a","model":"m","options":[{"id":"a","value":1},{"id":"b","value":2}]}),
            &json!({"instanceId":"a","model":"m","options":[{"id":"b","value":2},{"id":"a","value":1}]})
        ));
    }
    #[test]
    fn classification_and_release_guards() {
        let a = json!({"instanceId":"a","model":"m"});
        let b = json!({"instanceId":"a","model":"n"});
        let current = ctx(&a, "key");
        let target = ctx(&b, "key");
        assert!(transition(Some(&current), &target, None).is_err());
        assert_eq!(
            transition(
                Some(&current),
                &target,
                Some(&SelectionTransition::ApplyOnNextTurn)
            )
            .unwrap(),
            Transition::SwitchModelInSession
        );
        let sessions = [Session {
            id: "s",
            instance_id: "a",
            live: true,
            background_work: Err(()),
        }];
        let plan = plan(
            Some(&current),
            &target,
            "a",
            Some("s"),
            &sessions,
            Some(&SelectionTransition::RestartSession),
        )
        .unwrap();
        assert_eq!(plan.release_session_ids, vec!["s"]);
        assert!(guard(&plan, &sessions, true, "t")
            .unwrap_err()
            .contains("active turn"));
        assert!(guard(&plan, &sessions, false, "t")
            .unwrap_err()
            .contains("background"));
    }
    #[test]
    fn incompatible_continuity_releases_only_other_instances() {
        let a = json!({"instanceId":"a","model":"m"});
        let b = json!({"instanceId":"b","model":"n"});
        let sessions = [
            Session {
                id: "old",
                instance_id: "a",
                live: true,
                background_work: Ok(false),
            },
            Session {
                id: "new",
                instance_id: "b",
                live: true,
                background_work: Ok(false),
            },
            Session {
                id: "dead",
                instance_id: "a",
                live: false,
                background_work: Ok(false),
            },
        ];
        let p = plan(
            Some(&ctx(&a, "old")),
            &ctx(&b, "new"),
            "a",
            Some("old"),
            &sessions,
            None,
        )
        .unwrap();
        assert_eq!(p.transition, Transition::CreateWithHandoff);
        assert_eq!(p.release_session_ids, vec!["old"]);
    }
}

/// Runtime facts must be obtained while deciding the command. The runtime should
/// classify through the target adapter and conservatively report probe failures.
pub struct RuntimeDecision {
    pub plan: Plan,
    pub background_blocked: bool,
}

/// Commit a model selection command. `decide` must check target adapter availability,
/// build the transition plan using the current projections, and probe sessions to
/// release. It is called inside the transaction after the deleted-thread guard.
pub fn dispatch<F>(
    bus: &crate::event_bus::EventBus,
    command_id: &str,
    thread_id: &str,
    selection: &Value,
    explicit_switch: bool,
    now: &str,
    decide: F,
) -> Result<crate::thread_commands::CommitResult, crate::event_bus::BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>, &Value) -> Result<RuntimeDecision, String>,
{
    use crate::{
        event_store::{self, Event, Receipt},
        outbox::{self, Effect},
        thread_commands::CommitResult,
    };
    use rusqlite::{params, OptionalExtension};
    use serde_json::json;
    let kind = if explicit_switch {
        "provider.switch"
    } else {
        "thread.model-selection.set"
    };
    bus.commit(|tx| {
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            if receipt.aggregate_id != thread_id { return Err(rusqlite::Error::InvalidQuery); }
            return Ok((CommitResult { receipt, committed:false }, vec![]));
        }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread_id], |r| r.get(0)).optional()?;
        let mut thread: Value = match raw { Some(raw) => serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?, None => Value::Null };
        let mut error = if thread.is_null() { Some(format!("Thread {thread_id} does not exist.")) } else if !thread["deletedAt"].is_null() { Some(format!("Thread {thread_id} is deleted.")) } else { None };
        let mut decision = None;
        if error.is_none() {
            match decide(tx, &thread) {
                Err(e) => error = Some(e),
                Ok(value) => {
                    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))", [thread_id], |r| r.get(0))?;
                    if (value.plan.instance_changed || !value.plan.release_session_ids.is_empty()) && active {
                        error = Some(format!("Thread {thread_id} has an active turn. Wait for it to finish, then retry the provider selection change."));
                    } else if value.background_blocked && !value.plan.release_session_ids.is_empty() {
                        error = Some("The current session is still running background agents or commands, and this change would end them. Wait for them to finish, or press Stop, then try again.".into());
                    }
                    decision = Some(value);
                }
            }
        }
        let mut receipt = Receipt { command_id:command_id.into(), aggregate_kind:"thread".into(), aggregate_id:thread_id.into(), command_type:kind.into(), accepted_at:now.into(), result_sequence:event_store::latest_thread_sequence(tx,Some(thread_id))?, status:if error.is_some(){"rejected"}else{"accepted"}.into(), error };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? { return Err(rusqlite::Error::InvalidQuery); }
        if receipt.error.is_some() { return Ok((CommitResult { receipt, committed:false }, vec![])); }
        let decision = decision.ok_or(rusqlite::Error::InvalidQuery)?;
        let instance = selection.get("instanceId").and_then(Value::as_str).ok_or(rusqlite::Error::InvalidQuery)?;
        thread["providerInstanceId"] = json!(instance); thread["modelSelection"] = selection.clone(); thread["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET provider_instance_id=?2,updated_at=?3,payload_json=?4 WHERE thread_id=?1", params![thread_id,instance,now,thread.to_string()])?;
        let event_type = if explicit_switch || decision.plan.instance_changed { "thread.provider-switched" } else { "thread.model-selection-updated" };
        let mut events = vec![(event_type, thread)];
        let enqueue = |id: String, request: Value| outbox::enqueue(tx, &Effect { id, command_id:command_id.into(), thread_id:thread_id.into(), request, status:"pending".into(), attempt_count:0, available_at:now.into(), lease_owner:None, created_at:now.into(), updated_at:now.into(), completed_at:None, last_error:None });
        // Codex applies model and option changes at the next turn/start; its
        // runtime exposes no live applyModelSelection hook.
        for id in decision.plan.release_session_ids {
            // The runtime plan can include only bound, live sessions. Recheck so stale
            // plans cannot detach a different thread's session.
            let live: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 AND s.provider_session_id=?2 AND s.status NOT IN ('stopped','error'))",params![thread_id,id],|r|r.get(0))?;
            if !live { continue; }
            tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=?1 AND provider_session_id=?2",params![thread_id,id])?;
            let reason="Provider or model selection changed.";
            events.push(("provider-session.detached",json!({"providerSessionId":id,"detachedAt":now,"reason":reason})));
            enqueue(format!("effect:{command_id}:provider-session.detach:{id}"),json!({"type":"provider-session.detach","providerSessionId":id,"detail":reason}))?;
        }
        let events: Vec<Event> = events.into_iter().map(|(event_type,payload)| Event { id:uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(), stream_id:thread_id.into(), event_type:event_type.into(), occurred_at:now.into(), command_id:Some(command_id.into()), causation_event_id:None, correlation_id:Some(command_id.into()), actor_kind:"client".into(), payload, metadata:json!({}) }).collect();
        let stored=event_store::append(tx,&events)?;
        receipt.result_sequence=stored.last().ok_or(rusqlite::Error::InvalidQuery)?.sequence;
        event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult { receipt, committed:true },stored))
    })
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use crate::{
        event_bus::EventBus,
        thread_commands::{create_thread_ordered, CreateThread},
    };
    use serde_json::json;

    #[test]
    fn opencode_selection_accepts_same_instance_model_change() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let old = json!({"instanceId":"opencode","model":"opencode/old"});
        let new = json!({"instanceId":"opencode","model":"opencode/new"});
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t-open-selection",
                project_id: "p",
                title: "T",
                model_selection: &old,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let result = dispatch(
            &bus,
            "change",
            "t-open-selection",
            &new,
            false,
            "2026-01-02T00:00:00Z",
            |tx, thread| {
                codex_decision(
                    tx,
                    thread,
                    &new,
                    std::path::Path::new("/nonexistent-t3-settings"),
                    &crate::provider::session_registry::SessionRegistry::default(),
                )
            },
        )
        .unwrap();
        assert!(result.committed, "{:?}", result.receipt.error);
        bus.commit(|tx| {
            let model:String=tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_threads WHERE thread_id='t-open-selection'",[],|row|row.get(0))?;
            assert_eq!(model,"opencode/new"); Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn codex_selection_applies_next_turn_without_live_effect_and_replays() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let old = json!({"instanceId":"codex","model":"old"});
        let new = json!({"instanceId":"codex","model":"new"});
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &old,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let result = dispatch(
            &bus,
            "change",
            "t",
            &new,
            false,
            "2026-01-02T00:00:00Z",
            |tx, thread| {
                codex_decision(
                    tx,
                    thread,
                    &new,
                    std::path::Path::new("/nonexistent-t3-settings"),
                    &crate::provider::session_registry::SessionRegistry::default(),
                )
            },
        )
        .unwrap();
        assert!(result.committed);
        let again = dispatch(
            &bus,
            "change",
            "t",
            &new,
            false,
            "2026-01-02T00:00:00Z",
            |_, _| panic!("replay must not classify again"),
        )
        .unwrap();
        assert!(!again.committed);
        assert!(dispatch(
            &bus,
            "change",
            "another-thread",
            &new,
            false,
            "2026-01-02T00:00:00Z",
            |_, _| panic!("conflicting receipt must not classify")
        )
        .is_err());
        bus.commit(|tx| {
            let payload: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(
                serde_json::from_str::<Value>(&payload).unwrap()["modelSelection"],
                new
            );
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE command_id='change'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        })
        .unwrap();
    }
}

/// Build a provider selection decision inside the dispatch transaction.
/// Unknown or disabled targets are rejected; background-probe failures
/// conservatively block any affected release.
pub fn codex_decision(
    tx: &rusqlite::Transaction<'_>,
    thread: &Value,
    target: &Value,
    settings_path: &std::path::Path,
    registry: &crate::provider::session_registry::SessionRegistry,
) -> Result<RuntimeDecision, String> {
    use rusqlite::{params, OptionalExtension};
    let target_id = target["instanceId"]
        .as_str()
        .ok_or("Invalid model selection.")?;
    let current = &thread["modelSelection"];
    let current_id = current["instanceId"]
        .as_str()
        .ok_or("Invalid current model selection.")?;
    let thread_id = thread["id"].as_str().ok_or("Invalid thread.")?;
    let settings = crate::provider::session_registry::read_provider_settings(Some(settings_path))?;
    let resolve = |id: &str| -> Result<(String, String), String> {
        let entry = settings["providerInstances"].get(id);
        let driver = match entry {
            Some(value) => {
                if value["enabled"] == false {
                    return Err(format!("Provider instance {id} is disabled."));
                }
                value["driver"]
                    .as_str()
                    .ok_or_else(|| format!("Provider instance {id} has no driver."))?
            }
            None if matches!(
                id,
                "codex"
                    | "claudeAgent"
                    | "opencode"
                    | "antigravity"
                    | "grok"
                    | "kiro"
                    | "fx"
                    | "pi"
                    | "cursor"
                    | "muse"
            ) =>
            {
                id
            }
            None => return Err(format!("Unknown provider instance {id}.")),
        };
        if !matches!(
            driver,
            "codex"
                | "claudeAgent"
                | "opencode"
                | "antigravity"
                | "acpRegistry"
                | "grok"
                | "kiro"
                | "fx"
                | "pi"
                | "cursor"
                | "muse"
        ) {
            return Err(format!("Unknown provider driver {driver}."));
        }
        crate::managed_policy::check_provider_allowed(driver)?;
        if driver != "codex" {
            return Ok((driver.to_owned(), format!("{driver}:instance:{id}")));
        }
        let launch = crate::provider::instance::resolve_codex_identity(
            Some(settings_path),
            id,
            crate::provider::CodexLaunch::default(),
        )?;
        let home = match launch.home {
            Some(home) => home,
            None => {
                #[cfg(unix)]
                {
                    crate::codex_shadow_home::shared_home()
                        .map_err(|_| "Cannot determine Codex home")?
                }
                #[cfg(not(unix))]
                {
                    std::path::PathBuf::from(
                        std::env::var_os("HOME").ok_or("Cannot determine Codex home")?,
                    )
                    .join(".codex")
                }
            }
        };
        Ok((driver.to_owned(), format!("codex:home:{}", home.display())))
    };
    let (target_driver, target_key) = resolve(target_id)?;
    let current_identity = resolve(current_id).ok();
    let mut stmt = tx.prepare("SELECT s.provider_session_id,s.status,s.payload_json FROM orchestration_v2_projection_provider_sessions s JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id=s.provider_session_id WHERE b.thread_id=?1 ORDER BY s.updated_at DESC,s.provider_session_id").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([thread_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut session_data = Vec::new();
    for (id, status, raw) in rows {
        let payload: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let instance = payload["providerInstanceId"]
            .as_str()
            .unwrap_or(current_id)
            .to_owned();
        session_data.push((id, status, instance, payload));
    }
    let current_session = session_data.iter().find(|(_, status, instance, _)| {
        instance == current_id && status != "stopped" && status != "error"
    });
    let provider_thread: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2",params![thread_id,thread["activeProviderThreadId"].as_str().unwrap_or("")],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let has_native = provider_thread
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .is_some_and(|v| v["providerInstanceId"] == current_id && !v["nativeThreadRef"].is_null());
    let session_workspace = current_session.and_then(|(_, _, _, v)| v["cwd"].as_str());
    let worktree = thread["worktreePath"].as_str();
    let runtime = thread["runtimeMode"].as_str().unwrap_or("full-access");
    let current_ctx = current_identity
        .as_ref()
        .filter(|_| current_session.is_some() || has_native)
        .map(|(driver, key)| ProviderContext {
            driver,
            driver_kind: driver,
            continuation_key: key,
            selection: current,
            runtime_mode: runtime,
            workspace: session_workspace
                .or(worktree)
                .unwrap_or("<unresolved-workspace>"),
            available: true,
        });
    let target_ctx = ProviderContext {
        driver: &target_driver,
        driver_kind: &target_driver,
        continuation_key: &target_key,
        selection: target,
        runtime_mode: runtime,
        workspace: worktree
            .or(session_workspace)
            .unwrap_or("<unresolved-workspace>"),
        available: true,
    };
    let sessions: Vec<Session<'_>> = session_data
        .iter()
        .map(|(id, status, instance, _)| Session {
            id,
            instance_id: instance,
            live: status != "stopped" && status != "error",
            background_work: registry.has_pending_background_work(id).map_err(|_| ()),
        })
        .collect();
    let plan = plan(
        current_ctx.as_ref(),
        &target_ctx,
        current_id,
        current_session.map(|(id, _, _, _)| id.as_str()),
        &sessions,
        Some(&SelectionTransition::ApplyOnNextTurn),
    )?;
    let background_blocked = sessions.iter().any(|s| {
        s.live
            && plan.release_session_ids.iter().any(|id| id == s.id)
            && s.background_work != Ok(false)
    });
    Ok(RuntimeDecision {
        plan,
        background_blocked,
    })
}
