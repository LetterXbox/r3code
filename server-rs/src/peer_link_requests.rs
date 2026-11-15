use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    mcp_credentials::Scope,
    mcp_projects::require_full_access_writer,
    message_commands::{self, DispatchMessage},
    peer_links,
    settings::Settings,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};

type Failure = (&'static str, String);

static ANSWER_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn answer_lock(turn_item_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = ANSWER_LOCKS.lock().expect("answer lock mutex");
    map.retain(|_, v| Arc::strong_count(v) > 1);
    map.entry(turn_item_id.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub fn definition() -> Value {
    json!({
        "name": "t3_environment_link",
        "description": "Ask the user to link another environment to this one so you can read or act there. Pass `environmentId` (to relink an expired peer), `url`, or `hint`. Returns immediately with `pending` and a `turnItemId`, or `linked` if already usable; when the user approves or declines, this thread is woken with the result.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "environmentId": { "type": "string", "minLength": 1 },
                "url": { "type": "string", "minLength": 1 },
                "hint": { "type": "string", "minLength": 1, "maxLength": 200 },
                "reason": { "type": "string", "maxLength": 500 },
                "requestedAccess": {
                    "type": "string",
                    "enum": ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"]
                },
                "clientRequestId": { "type": "string", "minLength": 1, "maxLength": 256 }
            },
            "additionalProperties": false
        },
        "annotations": {
            "title": "Request environment link",
            "destructiveHint": true
        }
    })
}

fn enc(s: &str) -> String {
    crate::message_commands::encode_id_part(s)
}

fn mapped_outcome(card: &Value) -> Value {
    let link_status = card["linkStatus"].as_str().unwrap_or("pending");
    match link_status {
        "pending" => json!({
            "status": "pending",
            "turnItemId": card["id"],
        }),
        "linked" => json!({
            "status": "linked",
            "environmentId": card["linkedEnvironmentId"],
            "label": card["linkedLabel"],
            "access": card["linkedAccess"],
        }),
        "failed" => json!({
            "status": "failed",
            "turnItemId": card["id"],
            "failure": card["failure"],
        }),
        other => json!({
            "status": other,
            "turnItemId": card["id"],
        }),
    }
}

pub async fn request(
    bus: &EventBus,
    db: &Mutex<rusqlite::Connection>,
    settings: &Settings,
    scope: &Scope,
    args: &Value,
) -> Result<Value, Failure> {
    if scope.thread_id.is_empty() {
        return Err((
            "invalid_request",
            "t3_environment_link requires a thread-scoped MCP session.".into(),
        ));
    }
    let Some(obj) = args.as_object() else {
        return Err(("invalid_request", "Arguments must be a JSON object.".into()));
    };
    if settings.snapshot()["linkedEnvironmentsEnabled"] != true {
        return Err((
            "capability_denied",
            "Linked environments are turned off in Settings.".into(),
        ));
    }
    let environment_id = obj
        .get("environmentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if environment_id.is_some() && url.is_some() {
        return Err((
            "invalid_request",
            "Pass either environmentId or url, not both.".into(),
        ));
    }
    let hint = obj
        .get("hint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let reason = obj
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let requested_access = match obj.get("requestedAccess").and_then(Value::as_str) {
        None => None,
        Some(a)
            if matches!(
                a,
                "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access"
            ) =>
        {
            Some(a.to_owned())
        }
        Some(_) => return Err(("invalid_request", "Invalid requestedAccess.".into())),
    };
    let client_request_id = match obj.get("clientRequestId") {
        None => None,
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.encode_utf16().count() > 256 {
                return Err(("invalid_request", "Invalid clientRequestId.".into()));
            }
            Some(trimmed.to_owned())
        }
        _ => return Err(("invalid_request", "clientRequestId must be a string.".into())),
    };

    let key = client_request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let turn_item_id = format!(
        "turn-item:link-request:{}:{}:{}",
        enc(&scope.thread_id),
        enc(&scope.provider_session_id),
        enc(&key)
    );
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(ref target_env) = environment_id {
        if let Ok(Some(usable)) = peer_links::get_usable_link(db, target_env) {
            if client_request_id.is_some() {
                let _ = bus.commit(|tx| {
                    let row: Option<String> = tx
                        .query_row(
                            "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2 AND type='link_request'",
                            params![&scope.thread_id, &turn_item_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(raw) = row {
                        let mut card: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
                        if card["linkStatus"].as_str() == Some("pending") {
                            card["status"] = json!("completed");
                            card["linkStatus"] = json!("linked");
                            card["linkedEnvironmentId"] = usable["environmentId"].clone();
                            card["linkedLabel"] = usable["label"].clone();
                            card["linkedAccess"] = usable["access"].clone();
                            card["completedAt"] = json!(&now);
                            card["updatedAt"] = json!(&now);
                            tx.execute(
                                "UPDATE orchestration_v2_projection_turn_items SET status='completed', updated_at=?3, payload_json=?4 WHERE thread_id=?1 AND turn_item_id=?2",
                                params![&scope.thread_id, &turn_item_id, &now, card.to_string()],
                            )?;
                            let event = Event {
                                id: uuid::Uuid::new_v4().to_string(),
                                aggregate_kind: "thread".into(),
                                stream_id: scope.thread_id.clone(),
                                event_type: "turn-item.updated".into(),
                                occurred_at: now.clone(),
                                command_id: None,
                                causation_event_id: None,
                                correlation_id: None,
                                actor_kind: "server".into(),
                                payload: card,
                                metadata: json!({}),
                            };
                            let stored = event_store::append(tx, &[event])?;
                            return Ok(((), stored));
                        }
                    }
                    Ok(((), vec![]))
                });
            }
            return Ok(json!({
                "status": "linked",
                "environmentId": usable["environmentId"],
                "label": usable["label"],
                "access": usable["access"],
            }));
        }
    }

    let denied = RefCell::new(None::<Failure>);
    let result = bus
        .commit(|tx| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            require_full_access_writer(tx, scope, "link environments", false).map_err(&reject)?;

            if client_request_id.is_some() {
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2 AND type='link_request'",
                        params![&scope.thread_id, &turn_item_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(raw) = existing {
                    let card: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
                    return Ok((mapped_outcome(&card), vec![]));
                }
            }

            let run_row: Option<(String, Option<String>, Option<String>)> = tx
                .query_row(
                    "SELECT r.run_id, json_extract(r.payload_json,'$.rootNodeId'), json_extract(r.payload_json,'$.providerThreadId') FROM orchestration_v2_projection_runs r WHERE r.thread_id=?1 AND r.status IN ('preparing','starting','running','waiting') AND r.provider_instance_id=?2 ORDER BY r.ordinal DESC LIMIT 1",
                    params![&scope.thread_id, &scope.provider_instance_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let (run_id, root_node_id, provider_thread_id) = run_row.ok_or_else(|| {
                reject((
                    "parent_not_active",
                    "The calling provider no longer owns an active thread run.".into(),
                ))
            })?;
            let node_id = root_node_id.ok_or_else(|| {
                reject((
                    "parent_not_active",
                    "The calling run has no active node.".into(),
                ))
            })?;
            let ordinal: i64 = tx.query_row(
                "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",
                [&scope.thread_id],
                |r| r.get(0),
            )?;
            let title = hint
                .clone()
                .or_else(|| url.clone())
                .unwrap_or_else(|| "Link an environment".to_owned());
            let mut card = json!({
                "id": turn_item_id,
                "threadId": scope.thread_id,
                "runId": run_id,
                "nodeId": node_id,
                "providerThreadId": provider_thread_id,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": ordinal,
                "status": "waiting",
                "title": title,
                "startedAt": now,
                "completedAt": null,
                "updatedAt": now,
                "type": "link_request",
                "reason": reason,
                "linkStatus": "pending",
            });
            if let Some(u) = &url {
                card["url"] = json!(u);
            }
            if let Some(eid) = &environment_id {
                card["environmentId"] = json!(eid);
            }
            if let Some(h) = &hint {
                card["hint"] = json!(h);
            }
            if let Some(acc) = &requested_access {
                card["requestedAccess"] = json!(acc);
            }
            tx.execute(
                "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, provider_thread_id, type, status, ordinal, updated_at, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, 'link_request', 'waiting', ?6, ?7, ?8)",
                params![
                    &turn_item_id,
                    &scope.thread_id,
                    &run_id,
                    &node_id,
                    &provider_thread_id,
                    ordinal,
                    &now,
                    card.to_string(),
                ],
            )?;
            let event = Event {
                id: uuid::Uuid::new_v4().to_string(),
                aggregate_kind: "thread".into(),
                stream_id: scope.thread_id.clone(),
                event_type: "turn-item.updated".into(),
                occurred_at: now.clone(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                actor_kind: "server".into(),
                payload: card,
                metadata: json!({}),
            };
            let stored = event_store::append(tx, &[event])?;
            Ok((
                json!({
                    "status": "pending",
                    "turnItemId": turn_item_id,
                }),
                stored,
            ))
        })
        .map_err(|e| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("orchestration_error", e.to_string()))
        })?;

    Ok(result)
}

pub async fn answer(
    bus: &EventBus,
    db: &Mutex<rusqlite::Connection>,
    secrets_dir: &Path,
    local_descriptor: &Value,
    input: &Value,
) -> Result<(), Failure> {
    let thread_id = input["threadId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("invalid_request", "threadId is required.".into()))?
        .to_owned();
    let turn_item_id = input["turnItemId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ("invalid_request", "turnItemId is required.".into()))?
        .to_owned();
    let answer_obj = input["answer"]
        .as_object()
        .ok_or_else(|| ("invalid_request", "answer must be an object.".into()))?;
    let answer_type = answer_obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ("invalid_request", "answer.type is required.".into()))?;

    let lock = answer_lock(&turn_item_id);
    let _guard = lock.lock().await;

    let denied = RefCell::new(None::<Failure>);
    let (card, workspace_root, driver) = bus
        .with_autocommit(|conn| {
            let reject = |f: Failure| {
                *denied.borrow_mut() = Some(f);
                rusqlite::Error::InvalidQuery
            };
            let row: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT i.payload_json, COALESCE(json_extract(t.payload_json,'$.worktreePath'), p.workspace_root), t.default_provider FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_threads t ON t.thread_id=i.thread_id LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE i.thread_id=?1 AND i.turn_item_id=?2 AND i.type='link_request' AND t.deleted_at IS NULL",
                    params![&thread_id, &turn_item_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let (raw, cwd, driver) =
                row.ok_or_else(|| reject(("not_found", "Link request was not found.".into())))?;
            let card: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
            if card["runId"].is_null() || card["nodeId"].is_null() {
                return Err(reject(("not_found", "Link request has no run or node.".into())));
            }
            if card["linkStatus"].as_str() != Some("pending") {
                return Err(reject((
                    "already_answered",
                    "Link request has already been answered.".into(),
                )));
            }
            Ok((card, cwd.unwrap_or_default(), driver))
        })
        .map_err(|e| ("load_failed", e.to_string()))?
        .map_err(|_| {
            denied
                .into_inner()
                .unwrap_or_else(|| ("load_failed", "Could not load link request.".into()))
        })?;

    enum Outcome {
        Linked {
            environment_id: String,
            label: String,
            access: String,
        },
        Declined,
        Failed(String),
    }

    let target_desc = card["hint"]
        .as_str()
        .or_else(|| card["url"].as_str())
        .or_else(|| card["environmentId"].as_str())
        .unwrap_or("that environment")
        .to_owned();

    let outcome = if !card["url"].is_null()
        && !card["environmentId"].is_null()
        && answer_type == "link"
        && answer_obj.get("environmentId").is_some_and(Value::is_string)
    {
        Outcome::Failed("This request is from before an update. Ask for the link again.".into())
    } else {
        match answer_type {
            "decline" => Outcome::Declined,
            "use-existing" => {
                let eid = answer_obj
                    .get("environmentId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| ("invalid_request", "answer.environmentId is required.".into()))?;
                match peer_links::get_usable_link(db, eid) {
                    Ok(Some(usable)) => Outcome::Linked {
                        environment_id: usable["environmentId"].as_str().unwrap_or(eid).to_owned(),
                        label: usable["label"].as_str().unwrap_or("").to_owned(),
                        access: usable["access"].as_str().unwrap_or("read-only").to_owned(),
                    },
                    _ => Outcome::Failed("That linked environment is no longer usable.".into()),
                }
            }
            "link" => {
                let urls = answer_obj
                    .get("urls")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| ("invalid_request", "answer.urls must be non-empty.".into()))?;
                let primary = urls[0]
                    .as_str()
                    .ok_or_else(|| ("invalid_request", "answer.urls must contain strings.".into()))?;
                let alternates: Vec<Value> = urls[1..].to_vec();
                let access = answer_obj
                    .get("access")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ("invalid_request", "answer.access is required.".into()))?;
                let pairing_code = answer_obj
                    .get("pairingCode")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ("invalid_request", "answer.pairingCode is required.".into()))?;
                let mut link_input = json!({
                    "url": primary,
                    "alternateUrls": alternates,
                    "access": access,
                    "pairingCode": pairing_code,
                });
                if let Some(eid) = answer_obj.get("environmentId").and_then(Value::as_str) {
                    link_input["expectedEnvironmentId"] = json!(eid);
                }
                match peer_links::link(db, secrets_dir, local_descriptor, &link_input).await {
                    Ok(linked) => Outcome::Linked {
                        environment_id: linked["environmentId"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned(),
                        label: linked["label"].as_str().unwrap_or("").to_owned(),
                        access: linked["access"].as_str().unwrap_or(access).to_owned(),
                    },
                    Err(err) => {
                        let wire = peer_links::wire_error(err);
                        Outcome::Failed(
                            wire["message"]
                                .as_str()
                                .unwrap_or("Could not link environment.")
                                .to_owned(),
                        )
                    }
                }
            }
            _ => return Err(("invalid_request", "Unsupported answer.type.".into())),
        }
    };

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        let current_raw: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2 AND type='link_request'",
                params![&thread_id, &turn_item_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = current_raw else {
            return Ok(((), vec![]));
        };
        let mut next_card: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        if next_card["linkStatus"].as_str() != Some("pending") {
            return Ok(((), vec![]));
        }

        let (item_status, link_status, wake_text, wake_outcome, wake_summary) = match &outcome {
            Outcome::Linked {
                environment_id,
                label,
                access,
            } => {
                next_card["linkedEnvironmentId"] = json!(environment_id);
                next_card["linkedLabel"] = json!(label);
                next_card["linkedAccess"] = json!(access);
                (
                    "completed",
                    "linked",
                    format!(
                        "The user linked {label} with {access} access. Pass environmentId {environment_id} to act there."
                    ),
                    "completed",
                    format!("Linked {label}"),
                )
            }
            Outcome::Failed(failure) => {
                next_card["failure"] = json!(failure);
                (
                    "failed",
                    "failed",
                    format!(
                        "Linking {target_desc} failed: {failure}. Call t3_environment_link again if the user still wants it."
                    ),
                    "failed",
                    format!("Could not link {target_desc}"),
                )
            }
            Outcome::Declined => (
                "cancelled",
                "declined",
                format!("The user declined to link {target_desc}."),
                "cancelled",
                format!("Declined to link {target_desc}"),
            ),
        };

        next_card["status"] = json!(item_status);
        next_card["linkStatus"] = json!(link_status);
        next_card["completedAt"] = json!(&now);
        next_card["updatedAt"] = json!(&now);

        tx.execute(
            "UPDATE orchestration_v2_projection_turn_items SET status=?3, updated_at=?4, payload_json=?5 WHERE thread_id=?1 AND turn_item_id=?2",
            params![&thread_id, &turn_item_id, item_status, &now, next_card.to_string()],
        )?;

        let mut events = vec![Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id.clone(),
            event_type: "turn-item.updated".into(),
            occurred_at: now.clone(),
            command_id: None,
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: next_card,
            metadata: json!({}),
        }];
        let mut stored = event_store::append(tx, &events)?;
        events.clear();

        let thread_active: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT archived_at, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                [&thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if matches!(thread_active, Some((None, None))) {
            let msg_cmd = format!("link-request:{turn_item_id}:{link_status}");
            let msg_id = format!("message:link-request:{turn_item_id}");
            let notification = json!({
                "source": { "kind": "background_task" },
                "outcome": wake_outcome,
                "summary": wake_summary,
            });
            let cmd = DispatchMessage {
                context: None,
                command_id: &msg_cmd,
                thread_id: &thread_id,
                message_id: &msg_id,
                text: &wake_text,
                attachments: &[],
                creation_source: "server",
                cwd: &workspace_root,
                driver: &driver,
            };
            if let Ok((_, wake_events)) =
                message_commands::dispatch_agent_notification_tx(tx, cmd, &now, &notification)
            {
                stored.extend(wake_events);
            }
        }
        Ok(((), stored))
    })
    .map_err(|e| ("record_failed", e.to_string()))
}

pub fn cancel_pending_for_thread(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    now: &str,
) -> Result<Vec<event_store::StoredEvent>, rusqlite::Error> {
    let mut stmt = tx.prepare(
        "SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='link_request' AND status='waiting'",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([thread_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut events = Vec::new();
    for (turn_item_id, raw) in rows {
        let mut card: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        if card["linkStatus"].as_str() != Some("pending") {
            continue;
        }
        card["status"] = json!("cancelled");
        card["linkStatus"] = json!("cancelled");
        card["completedAt"] = json!(now);
        card["updatedAt"] = json!(now);
        tx.execute(
            "UPDATE orchestration_v2_projection_turn_items SET status='cancelled', updated_at=?3, payload_json=?4 WHERE thread_id=?1 AND turn_item_id=?2",
            params![thread_id, &turn_item_id, now, card.to_string()],
        )?;
        events.push(Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id.to_owned(),
            event_type: "turn-item.updated".into(),
            occurred_at: now.to_owned(),
            command_id: None,
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: card,
            metadata: json!({}),
        });
    }
    if events.is_empty() {
        Ok(vec![])
    } else {
        event_store::append(tx, &events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn link_request_is_idempotent_and_answer_wakes_thread() {
        let mut db_conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db_conn).unwrap();
        let now = "2026-11-15T00:00:00.000Z";
        let dir = std::env::temp_dir().join(format!("t3-link-req-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        db_conn
            .execute(
                "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'P1', ?1, '[]', ?2, ?2)",
                params![dir.to_string_lossy().to_string(), now],
            )
            .unwrap();
        db_conn
            .execute(
                "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('t1', 'p1', 'T1', 'codex', 'codex', 'full-access', 'default', ?1, ?1, '{\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"gpt-5.4\"}}')",
                [now],
            )
            .unwrap();
        db_conn
            .execute(
                "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json) VALUES ('r1', 't1', 1, 'codex', 'codex', 'running', ?1, '{\"id\":\"r1\",\"status\":\"running\",\"ordinal\":1,\"rootNodeId\":\"n1\",\"providerInstanceId\":\"codex\"}')",
                [now],
            )
            .unwrap();

        let bus = EventBus::new(db_conn, 16);
        let peer_db = Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        {
            let mut conn = peer_db.lock().unwrap();
            crate::migrations::run_ported_migrations(&mut conn).unwrap();
        }
        let settings = Settings::new(dir.join("settings.json"));
        let _ = settings.update(&json!({ "linkedEnvironmentsEnabled": true }));
        let scope = Scope {
            thread_id: "t1".into(),
            provider_instance_id: "codex".into(),
            provider_session_id: "sess-1".into(),
            ..Default::default()
        };

        let first = request(
            &bus,
            &peer_db,
            &settings,
            &scope,
            &json!({ "hint": "Laptop", "clientRequestId": "req-1" }),
        )
        .await
        .unwrap();
        assert_eq!(first["status"], "pending");
        let second = request(
            &bus,
            &peer_db,
            &settings,
            &scope,
            &json!({ "hint": "Laptop", "clientRequestId": "req-1" }),
        )
        .await
        .unwrap();
        assert_eq!(first["turnItemId"], second["turnItemId"]);

        let turn_item_id = first["turnItemId"].as_str().unwrap().to_owned();
        answer(
            &bus,
            &peer_db,
            &dir,
            &json!({ "environmentId": "local", "label": "Local" }),
            &json!({
                "threadId": "t1",
                "turnItemId": turn_item_id,
                "answer": { "type": "decline" }
            }),
        )
        .await
        .unwrap();

        let err = answer(
            &bus,
            &peer_db,
            &dir,
            &json!({ "environmentId": "local", "label": "Local" }),
            &json!({
                "threadId": "t1",
                "turnItemId": turn_item_id,
                "answer": { "type": "decline" }
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, "already_answered");
    }
}
