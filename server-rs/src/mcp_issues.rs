//! MCP issue tools: list_issues, read_issue, create_issue, comment_on_issue,
//! set_issue_state, link_issue, unlink_issue, and list_thread_issues.
use crate::{
    event_bus::EventBus,
    issues::{self, ResolvedProject},
    mcp_credentials::Scope,
    thread_issues::{self, IssueCommand, LinkThreadIssue, ThreadIssueKey},
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{cell::RefCell, path::Path, sync::Mutex};

type Failure = (&'static str, String);

pub fn definitions() -> Vec<Value> {
    let target_props = json!({
        "url": { "type": "string", "minLength": 1, "description": "The issue's web URL. Preferred when you have it." },
        "key": { "type": "string", "minLength": 1, "description": "The issue's key in the project's tracker, such as its number." },
        "projectId": { "type": "string", "minLength": 1, "description": "Project whose tracker holds key. Defaults to this thread's project." }
    });
    vec![
        json!({
            "name": "list_issues",
            "description": "List issues in a project's tracker, newest updated first. Pass the returned nextCursors as cursors for the next page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": { "type": "string", "minLength": 1, "description": "Defaults to this thread's project." },
                    "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "Defaults to open." },
                    "query": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Free text the tracker matches itself." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                    "cursors": { "type": "object", "additionalProperties": { "type": "string" } }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "List issues", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
        }),
        json!({
            "name": "read_issue",
            "description": "Read an issue: body, state, labels, assignees, recent comments and linked pull requests. Pass its url, or its key.",
            "inputSchema": { "type": "object", "properties": target_props, "additionalProperties": false },
            "annotations": { "title": "Read issue", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
        }),
        json!({
            "name": "create_issue",
            "description": "File an issue in a project's tracker.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": { "type": "string", "minLength": 1, "description": "Defaults to this thread's project." },
                    "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
                    "body": { "type": "string", "maxLength": 65536 },
                    "labels": { "type": "array", "items": { "type": "string", "minLength": 1 }, "maxItems": 50 },
                    "assignees": { "type": "array", "items": { "type": "string", "minLength": 1 }, "maxItems": 25 }
                },
                "required": ["title"],
                "additionalProperties": false
            },
            "annotations": { "title": "Create issue", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true }
        }),
        json!({
            "name": "comment_on_issue",
            "description": "Post a comment on an issue.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": target_props["url"],
                    "key": target_props["key"],
                    "projectId": target_props["projectId"],
                    "body": { "type": "string", "minLength": 1, "maxLength": 65536 }
                },
                "required": ["body"],
                "additionalProperties": false
            },
            "annotations": { "title": "Comment on issue", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true }
        }),
        json!({
            "name": "set_issue_state",
            "description": "Move an issue to one of its states. read_issue lists them under states.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": target_props["url"],
                    "key": target_props["key"],
                    "projectId": target_props["projectId"],
                    "state": { "type": "string", "minLength": 1, "description": "A state name from read_issue's states." }
                },
                "required": ["state"],
                "additionalProperties": false
            },
            "annotations": { "title": "Set issue state", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
        }),
        json!({
            "name": "link_issue",
            "description": "Link an issue to a thread so T3 Code shows it beside the thread. Link every issue you work on or file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": target_props["url"],
                    "key": target_props["key"],
                    "projectId": target_props["projectId"],
                    "threadId": { "type": "string", "minLength": 1, "description": "Thread to act on. Omit for this thread." }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "Link issue to thread", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "unlink_issue",
            "description": "Remove an issue link from a thread. The issue itself is not changed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": target_props["url"],
                    "key": target_props["key"],
                    "projectId": target_props["projectId"],
                    "threadId": { "type": "string", "minLength": 1, "description": "Thread to act on. Omit for this thread." }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "Unlink issue from thread", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "list_thread_issues",
            "description": "List the issues linked to a thread.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string", "minLength": 1, "description": "Thread to act on. Omit for this thread." }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "List thread issues", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
    ]
}

pub fn handles(name: &str) -> bool {
    matches!(
        name,
        "list_issues"
            | "read_issue"
            | "create_issue"
            | "comment_on_issue"
            | "set_issue_state"
            | "link_issue"
            | "unlink_issue"
            | "list_thread_issues"
    )
}

fn format_wire_error(err: Value) -> Failure {
    let msg = err
        .get("detail")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| err.get("reason").and_then(Value::as_str))
        .unwrap_or("Issue request failed.")
        .to_owned();
    ("issue_error", msg)
}

fn require_capability(scope: &Scope) -> Result<(), Failure> {
    if !scope.capabilities.contains("issues") && !scope.capabilities.contains("orchestration") {
        return Err((
            "capability_denied",
            "This MCP credential does not grant issues capabilities.".into(),
        ));
    }
    Ok(())
}

fn require_write_access(scope: &Scope) -> Result<(), Failure> {
    if let Some(client) = scope.client.as_ref() {
        if client.access == "read-only" {
            return Err((
                "access_denied",
                "Read-only MCP sessions cannot modify issues.".into(),
            ));
        }
    }
    Ok(())
}

fn load_thread_shell(db: &Connection, thread_id: &str) -> Result<Value, Failure> {
    let raw: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT payload_json, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?1",
            [thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| ("orchestration_error", "Failed to read thread.".to_owned()))?;
    match raw {
        Some((json_str, None)) => serde_json::from_str(&json_str)
            .map_err(|_| ("orchestration_error", "Invalid thread payload.".to_owned())),
        _ => Err(("not_found", format!("Thread {thread_id} was not found."))),
    }
}

fn caller_thread_project(db: &Mutex<Connection>, scope: &Scope) -> Option<String> {
    if scope.thread_id.trim().is_empty() {
        return None;
    }
    let guard = db.lock().ok()?;
    guard
        .query_row(
            "SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ?1 AND deleted_at IS NULL",
            [&scope.thread_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn resolve_thread_id(scope: &Scope, requested: Option<&str>) -> Result<String, Failure> {
    if let Some(tid) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(tid.to_owned());
    }
    if !scope.thread_id.trim().is_empty() {
        return Ok(scope.thread_id.clone());
    }
    Err((
        "invalid_request",
        "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
    ))
}

fn resolve_project_id(
    db: &Mutex<Connection>,
    scope: &Scope,
    requested: Option<&str>,
) -> Result<String, Failure> {
    if let Some(pid) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(pid.to_owned());
    }
    caller_thread_project(db, scope).ok_or_else(|| {
        (
            "invalid_request",
            "Pass projectId: this MCP client is not running inside a T3 thread.".into(),
        )
    })
}

async fn resolve_target(
    db: &Mutex<Connection>,
    secrets_dir: &Path,
    scope: &Scope,
    args: &Value,
    default_project: Option<&str>,
) -> Result<(ResolvedProject, String, Option<String>, Option<Value>), Failure> {
    let url = args.get("url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let key = args.get("key").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let req_pid = args
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(default_project);

    if let Some(u) = url {
        let preferred = req_pid
            .map(str::to_owned)
            .or_else(|| caller_thread_project(db, scope));
        let (resolved, k, cached) = issues::resolve_url(db, secrets_dir, u, preferred.as_deref())
            .await
            .map_err(format_wire_error)?;
        return Ok((resolved, k, Some(u.to_owned()), cached));
    }
    let Some(k) = key else {
        return Err((
            "invalid_request",
            "Pass either url, or key (with projectId when not running inside a T3 thread).".into(),
        ));
    };
    let pid = resolve_project_id(db, scope, req_pid)?;
    let bound = issues::project_scope(db, &pid).map_err(|_| {
        (
            "not_found",
            format!("Project {pid} was not found or has no issue tracker."),
        )
    })?;
    Ok((
        ResolvedProject {
            bound,
            writable: true,
        },
        k.to_owned(),
        None,
        None,
    ))
}

fn identity_value(resolved: &ResolvedProject, key: &str, url: Option<&str>) -> Value {
    let mut obj = json!({
        "projectId": resolved.bound.project.id,
        "tracker": resolved.bound.tracker,
        "host": resolved.bound.host,
        "scope": resolved.bound.scope,
        "key": key,
    });
    if let Some(u) = url {
        obj["url"] = json!(u);
    }
    obj
}

pub async fn call(
    bus: &EventBus,
    db: &Mutex<Connection>,
    secrets_dir: &Path,
    scope: &Scope,
    name: &str,
    args: &Value,
    now: &str,
) -> Result<Value, Failure> {
    require_capability(scope)?;
    match name {
        "list_issues" => {
            let req_pid = args.get("projectId").and_then(Value::as_str);
            let pid = resolve_project_id(db, scope, req_pid)?;
            let mut list_payload = args.clone();
            if !list_payload.is_object() {
                list_payload = json!({});
            }
            list_payload["projectId"] = json!(pid);
            let res = issues::list(db, secrets_dir, &list_payload)
                .await
                .map_err(format_wire_error)?;
            let mapped = res["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| {
                    json!({
                        "projectId": entry["projectId"],
                        "tracker": entry["tracker"],
                        "host": entry["host"],
                        "scope": entry["scope"],
                        "key": entry["key"],
                        "url": entry["url"],
                        "displayKey": entry["displayKey"],
                        "title": entry["title"],
                        "state": entry["state"],
                        "author": entry["author"]["login"],
                        "assignees": entry["assignees"].as_array().into_iter().flatten().filter_map(|a| a["login"].as_str()).collect::<Vec<_>>(),
                        "labels": entry["labels"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str()).collect::<Vec<_>>(),
                        "updatedAt": entry["updatedAt"],
                        "commentCount": entry["commentCount"],
                    })
                })
                .collect::<Vec<_>>();
            let errors = res["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| json!({ "projectId": e["projectId"], "message": e["message"] }))
                .collect::<Vec<_>>();
            Ok(json!({
                "issues": mapped,
                "nextCursors": res["nextCursors"],
                "errors": errors,
            }))
        }
        "read_issue" => {
            let (resolved, key, url, cached) = resolve_target(db, secrets_dir, scope, args, None).await?;
            let detail = match cached {
                Some(d) => d,
                None => issues::detail_resolved(&resolved, secrets_dir, &key)
                    .await
                    .map_err(format_wire_error)?,
            };
            let resolved_url = url
                .as_deref()
                .or_else(|| detail.get("url").and_then(Value::as_str))
                .unwrap_or("");
            let comments = detail["comments"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| {
                    json!({
                        "id": c["id"],
                        "author": c["author"]["login"],
                        "body": c["body"],
                        "createdAt": c["createdAt"],
                    })
                })
                .collect::<Vec<_>>();
            let linked_prs = detail["linkedPullRequests"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|pr| {
                    json!({
                        "url": pr["url"],
                        "title": pr["title"],
                        "state": pr["state"],
                        "closesIssue": pr["closesIssue"],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "projectId": resolved.bound.project.id,
                "tracker": resolved.bound.tracker,
                "host": resolved.bound.host,
                "scope": resolved.bound.scope,
                "key": key,
                "url": resolved_url,
                "displayKey": detail["displayKey"],
                "title": detail["title"],
                "state": detail["state"],
                "writable": detail["writable"],
                "capabilities": detail["capabilities"],
                "states": detail["states"],
                "author": detail["author"]["login"],
                "assignees": detail["assignees"].as_array().into_iter().flatten().filter_map(|a| a["login"].as_str()).collect::<Vec<_>>(),
                "labels": detail["labels"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str()).collect::<Vec<_>>(),
                "createdAt": detail["createdAt"],
                "updatedAt": detail["updatedAt"],
                "closedAt": detail["closedAt"],
                "body": detail["body"],
                "comments": comments,
                "commentsTruncated": !detail["commentsCursor"].is_null(),
                "linkedPullRequests": linked_prs,
            }))
        }
        "create_issue" => {
            require_write_access(scope)?;
            let req_pid = args.get("projectId").and_then(Value::as_str);
            let pid = resolve_project_id(db, scope, req_pid)?;
            let bound = issues::project_scope(db, &pid).map_err(|_| {
                ("not_found", format!("Project {pid} was not found or has no issue tracker."))
            })?;
            let create_payload = json!({
                "projectId": bound.project.id,
                "tracker": bound.tracker,
                "host": bound.host,
                "scope": bound.scope,
                "title": args["title"],
                "body": args.get("body").cloned().unwrap_or_else(|| json!("")),
                "labels": args.get("labels").cloned().unwrap_or_else(|| json!([])),
                "assignees": args.get("assignees").cloned().unwrap_or_else(|| json!([])),
            });
            let created = issues::create(db, secrets_dir, &create_payload)
                .await
                .map_err(format_wire_error)?;
            Ok(json!({
                "projectId": bound.project.id,
                "tracker": bound.tracker,
                "host": bound.host,
                "scope": bound.scope,
                "key": created["key"],
                "url": created["url"],
                "displayKey": created["displayKey"],
            }))
        }
        "comment_on_issue" => {
            require_write_access(scope)?;
            let (resolved, key, url, _) = resolve_target(db, secrets_dir, scope, args, None).await?;
            let comment_payload = json!({
                "projectId": resolved.bound.project.id,
                "tracker": resolved.bound.tracker,
                "host": resolved.bound.host,
                "scope": resolved.bound.scope,
                "key": key,
                "body": args["body"],
            });
            issues::comment(db, secrets_dir, &comment_payload)
                .await
                .map_err(format_wire_error)?;
            Ok(identity_value(&resolved, &key, url.as_deref()))
        }
        "set_issue_state" => {
            require_write_access(scope)?;
            let (resolved, key, url, _) = resolve_target(db, secrets_dir, scope, args, None).await?;
            let state_payload = json!({
                "projectId": resolved.bound.project.id,
                "tracker": resolved.bound.tracker,
                "host": resolved.bound.host,
                "scope": resolved.bound.scope,
                "key": key,
                "state": args["state"],
            });
            issues::set_state(db, secrets_dir, &state_payload)
                .await
                .map_err(format_wire_error)?;
            Ok(identity_value(&resolved, &key, url.as_deref()))
        }
        "link_issue" | "unlink_issue" => {
            let tid = resolve_thread_id(scope, args.get("threadId").and_then(Value::as_str))?;
            let thread = {
                let guard = db.lock().map_err(|_| ("orchestration_error", "DB unavailable".into()))?;
                load_thread_shell(&guard, &tid)?
            };
            let thread_project = thread.get("projectId").and_then(Value::as_str);
            let (resolved, key, url, cached) =
                resolve_target(db, secrets_dir, scope, args, thread_project).await?;
            if name == "unlink_issue" {
                let target_key = ThreadIssueKey::normalized(
                    &resolved.bound.tracker,
                    &resolved.bound.host,
                    &resolved.bound.scope,
                    &key,
                );
                let existing_url = thread["issues"]
                    .as_array()
                    .and_then(|arr| arr.iter().find(|link| target_key.matches_link(link)))
                    .and_then(|link| link["url"].as_str())
                    .map(str::to_owned);
                if existing_url.is_none() {
                    let mut out = identity_value(&resolved, &key, url.as_deref());
                    out["wasLinked"] = json!(false);
                    return Ok(out);
                }
                let encode = crate::message_commands::encode_id_part;
                let cmd_id = format!(
                    "command:mcp:{}:thread-issue-unlink:{}:{}",
                    encode(&scope.provider_session_id),
                    encode(&tid),
                    uuid::Uuid::new_v4()
                );
                let denied = RefCell::new(None);
                let commit = thread_issues::dispatch_checked(
                    bus,
                    &cmd_id,
                    &tid,
                    IssueCommand::Unlink(target_key),
                    now,
                    |tx| {
                        crate::mcp_thread_organize::check(tx, scope, &tid).map_err(|error| {
                            *denied.borrow_mut() = Some(error);
                            rusqlite::Error::InvalidQuery
                        })
                    },
                )
                .map_err(|e| {
                    denied
                        .into_inner()
                        .unwrap_or_else(|| ("orchestration_error", e.to_string()))
                })?;
                if commit.receipt.status != "accepted" {
                    return Err((
                        "orchestration_error",
                        commit
                            .receipt
                            .error
                            .unwrap_or_else(|| "Could not change the issue link.".into()),
                    ));
                }
                let mut out = identity_value(&resolved, &key, existing_url.as_deref());
                out["wasLinked"] = json!(commit.committed);
                return Ok(out);
            }
            let detail = match cached {
                Some(d) => d,
                None => issues::detail_resolved(&resolved, secrets_dir, &key)
                    .await
                    .map_err(format_wire_error)?,
            };
            let link_url = url
                .as_deref()
                .or_else(|| detail.get("url").and_then(Value::as_str))
                .unwrap_or("")
                .to_owned();
            let display_key = detail["displayKey"].as_str().unwrap_or(&key).to_owned();
            let title = detail["title"].as_str().unwrap_or("").to_owned();
            let encode = crate::message_commands::encode_id_part;
            let cmd_id = format!(
                "command:mcp:{}:thread-issue-link:{}:{}",
                encode(&scope.provider_session_id),
                encode(&tid),
                uuid::Uuid::new_v4()
            );
            let denied = RefCell::new(None);
            let commit = thread_issues::dispatch_checked(
                bus,
                &cmd_id,
                &tid,
                IssueCommand::Link(LinkThreadIssue {
                    tracker: &resolved.bound.tracker,
                    host: &resolved.bound.host,
                    scope: &resolved.bound.scope,
                    key: &key,
                    project_id: &resolved.bound.project.id,
                    url: &link_url,
                    display_key: &display_key,
                    title: &title,
                    source: "agent",
                }),
                now,
                |tx| {
                    crate::mcp_thread_organize::check(tx, scope, &tid).map_err(|error| {
                        *denied.borrow_mut() = Some(error);
                        rusqlite::Error::InvalidQuery
                    })
                },
            )
            .map_err(|e| {
                denied
                    .into_inner()
                    .unwrap_or_else(|| ("orchestration_error", e.to_string()))
            })?;
            if commit.receipt.status != "accepted" {
                return Err((
                    "orchestration_error",
                    commit
                        .receipt
                        .error
                        .unwrap_or_else(|| "Could not change the issue link.".into()),
                ));
            }
            Ok(json!({
                "projectId": resolved.bound.project.id,
                "tracker": resolved.bound.tracker,
                "host": resolved.bound.host,
                "scope": resolved.bound.scope,
                "key": key,
                "url": link_url,
                "alreadyLinked": !commit.committed,
            }))
        }
        "list_thread_issues" => {
            let tid = resolve_thread_id(scope, args.get("threadId").and_then(Value::as_str))?;
            let guard = db.lock().map_err(|_| ("orchestration_error", "DB unavailable".into()))?;
            let thread = load_thread_shell(&guard, &tid)?;
            let issues = thread["issues"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|link| {
                    json!({
                        "projectId": link["projectId"],
                        "tracker": link["tracker"],
                        "host": link["host"],
                        "scope": link["scope"],
                        "key": link["key"],
                        "url": link["url"],
                        "source": link["source"],
                        "displayKey": link["displayKey"],
                        "title": link["title"],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "issues": issues }))
        }
        _ => Err(("method_not_found", format!("Unknown issue tool: {name}"))),
    }
}
