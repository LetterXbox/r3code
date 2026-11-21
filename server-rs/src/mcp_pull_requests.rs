//! MCP tools for reading, creating, updating, linking, reviewing, merging, and debugging PRs.
use crate::{auth_http::AuthHttpState, event_bus::EventBus, mcp_credentials::Scope};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

const CHILD_PULL_REQUEST_REPORT_NEXT: &str =
    "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.";
const LIST_PAGE_SIZE: usize = 50;
const CONVERSATION_PAGE_CHARS: usize = 32_000;
const THREAD_COMMENT_PAGES: usize = 4;
const REVIEW_DIFF_PAGES: usize = 10;

pub(crate) fn handles(name: &str) -> bool {
    matches!(
        name,
        "link_pull_request"
            | "link_pull_requests"
            | "unlink_pull_request"
            | "unlink_pull_requests"
            | "list_thread_pull_requests"
            | "write_pull_request_guides"
            | "read_pull_request_guide"
            | "pull_request_read"
            | "pull_request_list"
            | "pull_request_create"
            | "pull_request_update"
            | "pull_request_respond"
            | "pull_request_review"
            | "pull_request_merge"
            | "ci_logs"
            | "ci_rerun"
    )
}

pub(crate) fn definitions(include_forge: bool) -> Vec<Value> {
    let target_props = json!({
        "environmentId": {"type":"string"},
        "threadId": {"type":"string","description":"Thread. Default: this thread."},
        "url": {"type":"string"},
        "repository": {"type":"string","description":"With `number`, when no `url`."},
        "number": {"type":"integer","minimum":1,"description":"With `repository`, when no `url`."},
        "host": {"type":"string","description":"Default: this project's host."}
    });
    let thread_pr_props = json!({
        "environmentId": {"type":"string"},
        "number": {"type":"integer","minimum":1,"description":"Default: the branch's PR."},
        "repository": {"type":"string"}
    });
    let mut tools = vec![
        json!({
            "name": "link_pull_request",
            "description": "Link a PR to this thread. T3 shows its status and settles the thread on merge. For several PRs, use `link_pull_requests`.",
            "inputSchema": {"type":"object","properties":target_props,"additionalProperties":false},
            "annotations": {"title":"Link pull request to thread","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
        }),
        json!({
            "name": "link_pull_requests",
            "description": "Link several PRs to a thread. Use it instead of one `link_pull_request` per PR. URLs that are not PRs come back in `invalidUrls`.",
            "inputSchema": {
                "type":"object",
                "properties":{
                    "environmentId":{"type":"string"},
                    "threadId":{"type":"string","description":"Thread. Default: this thread."},
                    "urls":{"type":"array","minItems":1,"items":{"type":"string"}}
                },
                "required":["urls"],
                "additionalProperties":false
            },
            "annotations": {"title":"Link pull requests to thread","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
        }),
        json!({
            "name": "unlink_pull_request",
            "description": "Remove a PR link from this thread. Succeeds with `wasLinked=false` when it was not linked.",
            "inputSchema": {"type":"object","properties":target_props,"additionalProperties":false},
            "annotations": {"title":"Unlink pull request from thread","readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":false}
        }),
        json!({
            "name": "unlink_pull_requests",
            "description": "Unlink a thread's PRs whose last known state is in `states`. Use it instead of one `unlink_pull_request` per PR. PRs with no known state stay linked.",
            "inputSchema": {
                "type":"object",
                "properties":{
                    "environmentId":{"type":"string"},
                    "threadId":{"type":"string","description":"Thread. Default: this thread."},
                    "states":{"type":"array","minItems":1,"items":{"type":"string","enum":["open","closed","merged"]}}
                },
                "required":["states"],
                "additionalProperties":false
            },
            "annotations": {"title":"Unlink pull requests by state","readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":false}
        }),
        json!({
            "name": "list_thread_pull_requests",
            "description": "List a thread's PRs, with last known state and stack order (bottom to top). Not an end-of-work check.",
            "inputSchema": {
                "type":"object",
                "properties":{
                    "environmentId":{"type":"string"},
                    "threadId":{"type":"string","description":"Thread. Default: this thread."},
                    "states":{"type":"array","items":{"type":"string","enum":["open","closed","merged"]}},
                    "cursor":{"type":"string"}
                },
                "additionalProperties":false
            },
            "annotations": {"title":"List thread pull requests","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
        }),
        json!({
            "name": "write_pull_request_guides",
            "description": "Write review guides for up to 20 PRs (the tour in the PR Guide tab). Returns once runs start. Each run takes minutes in a temporary checkout. A run for the same head is joined. Read with `read_pull_request_guide`. Fails while guides are off.",
            "inputSchema": {
                "type":"object",
                "properties":{
                    "environmentId":{"type":"string"},
                    "pullRequests":{
                        "type":"array","minItems":1,"maxItems":20,
                        "items":{"type":"object","properties":{
                            "url":{"type":"string"},"repository":{"type":"string"},
                            "number":{"type":"integer","minimum":1},"host":{"type":"string"}
                        },"additionalProperties":false}
                    }
                },
                "required":["pullRequests"],
                "additionalProperties":false
            },
            "annotations": {"title":"Write pull request guides","readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
        }),
        json!({
            "name": "read_pull_request_guide",
            "description": "Read a PR's stored review guide and run state. `guide` is null when none exists. Never starts a run.",
            "inputSchema": {
                "type":"object",
                "properties":{
                    "environmentId":{"type":"string"},
                    "url":{"type":"string"},"repository":{"type":"string"},
                    "number":{"type":"integer","minimum":1},"host":{"type":"string"}
                },
                "additionalProperties":false
            },
            "annotations": {"title":"Read pull request guide","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
        }),
    ];
    if include_forge {
        tools.extend([
            json!({
                "name": "pull_request_read",
                "description": "Read a PR's state, checks, review comments, or diff. Use instead of gh or cafe.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "sections":{"type":"array","items":{"type":"string","enum":["summary","checks","conversation","diff"]},"description":"Default: summary, checks. conversation has review threads."},
                        "includeResolved":{"type":"boolean"},
                        "cursor":{"type":"string"}
                    },
                    "additionalProperties":false
                },
                "annotations": {"title":"Read pull request","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_list",
                "description": "List PRs in this thread's repository, recently updated first.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "state":{"type":"string","enum":["open","closed","merged","all"],"description":"Default: open."},
                        "involvement":{"type":"string","enum":["all","author","review-requested","assigned"]},
                        "query":{"type":"string","maxLength":200},
                        "limit":{"type":"integer","minimum":1,"maximum":100},
                        "cursor":{"type":"string"}
                    },
                    "additionalProperties":false
                },
                "annotations": {"title":"List pull requests","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_create",
                "description": "Open a PR from this thread's pushed branch and link it, or return its open PR.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "title":{"type":"string"},
                        "body":{"type":"string"},
                        "base":{"type":"string"},
                        "draft":{"type":"boolean"}
                    },
                    "required":["title","body"],
                    "additionalProperties":false
                },
                "annotations": {"title":"Create pull request","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_update",
                "description": "Edit a PR's title, body, labels, or reviewers, close or reopen it, or set ready (false: back to draft).",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "title":{"type":"string"},
                        "body":{"type":"string"},
                        "ready":{"type":"boolean"},
                        "state":{"type":"string","enum":["open","closed"]},
                        "addLabels":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string"}},
                        "removeLabels":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string"}},
                        "requestReviewers":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string"},"description":"Logins, or org/team for a team."}
                    },
                    "additionalProperties":false
                },
                "annotations": {"title":"Update pull request","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_respond",
                "description": "Reply to, resolve, or reopen a review thread. Without reviewThreadId, comment on the PR.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "reviewThreadId":{"type":"string"},
                        "body":{"type":"string"},
                        "resolved":{"type":"boolean"}
                    },
                    "additionalProperties":false
                },
                "annotations": {"title":"Respond on pull request","readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_review",
                "description": "Submit a review: approve, request changes, or comment, with optional line comments.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "verdict":{"type":"string","enum":["comment","approve","request-changes"]},
                        "body":{"type":"string"},
                        "comments":{"type":"array","maxItems":50,"items":{
                            "type":"object",
                            "properties":{
                                "path":{"type":"string"},
                                "line":{"type":"integer","minimum":1},
                                "startLine":{"type":"integer","minimum":1},
                                "side":{"type":"string","enum":["new","old"],"description":"Default new. old: line numbers in the base, for removed lines."},
                                "body":{"type":"string"}
                            },
                            "required":["path","line","body"],
                            "additionalProperties":false
                        }}
                    },
                    "required":["verdict"],
                    "additionalProperties":false
                },
                "annotations": {"title":"Review pull request","readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
            }),
            json!({
                "name": "pull_request_merge",
                "description": "Merge a PR. Refuses if the head moved from expectedHeadSha (summary.headSha).",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "expectedHeadSha":{"type":"string"},
                        "method":{"type":"string","enum":["merge","squash","rebase"]},
                        "auto":{"type":"boolean","description":"Merge when required checks pass, including later pushes."},
                        "stack":{"type":"boolean","description":"Merge this PR and every open stack layer below it at once. Not with auto."}
                    },
                    "required":["expectedHeadSha"],
                    "additionalProperties":false
                },
                "annotations": {"title":"Merge pull request","readOnlyHint":false,"destructiveHint":true,"idempotentHint":false,"openWorldHint":true}
            }),
            json!({
                "name": "ci_logs",
                "description": "Read the tail of a PR's failing check logs, or one named check's. Use instead of gh run view.",
                "inputSchema": {
                    "type":"object",
                    "properties":{
                        "environmentId":{"type":"string"},
                        "number":{"type":"integer","minimum":1,"description":"Default: the branch's PR."},
                        "repository":{"type":"string"},
                        "check":{"type":"string"},
                        "tailLines":{"type":"integer","minimum":1,"maximum":2000,"description":"Default: 200."}
                    },
                    "additionalProperties":false
                },
                "annotations": {"title":"Read CI logs","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
            }),
            json!({
                "name": "ci_rerun",
                "description": "Re-run a PR's failing checks, or one named check.",
                "inputSchema": {
                    "type":"object",
                    "properties":thread_pr_props.as_object().cloned().map(|mut m| {
                        m.insert("check".into(), json!({"type":"string"}));
                        m
                    }).unwrap(),
                    "additionalProperties":false
                },
                "annotations": {"title":"Re-run CI","readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
            }),
        ]);
    }
    tools
}

pub(crate) fn caller_has_forge(db: &Mutex<Connection>, scope: &Scope) -> bool {
    if scope.client.is_some() || scope.thread_id.is_empty() {
        return true;
    }
    let Ok(conn) = db.lock() else {
        return false;
    };
    let root: Option<String> = conn
        .query_row(
            "SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'), p.workspace_root)
             FROM orchestration_v2_projection_threads t
             JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
             WHERE t.thread_id = ?1 AND t.deleted_at IS NULL",
            [&scope.thread_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(root) = root else {
        return false;
    };
    crate::repository_identity::resolve(&root)
        .and_then(|id| id["provider"].as_str().map(str::to_owned))
        .is_some()
}

pub(crate) struct PullRequestMcpContext<'a> {
    pub db: &'a Arc<Mutex<Connection>>,
    pub bus: &'a EventBus,
    pub settings: &'a Arc<crate::settings::Settings>,
    pub auth: Option<&'a Arc<AuthHttpState>>,
    pub sessions: &'a Arc<crate::provider::session_registry::SessionRegistry>,
    pub provider_cache: &'a Arc<Mutex<Option<Vec<Value>>>>,
    pub review_guide_runs: &'a Arc<crate::pull_request_review_guide::Runs>,
    pub review_guide_worktrees: &'a Path,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedTarget {
    host: String,
    repository: String,
    number: u64,
    url: String,
}

fn trim_non_empty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn require_thread_id(scope: &Scope, args: &Value) -> Result<String, (&'static str, String)> {
    if let Some(id) = trim_non_empty(&args["threadId"]) {
        return Ok(id.to_owned());
    }
    if !scope.thread_id.is_empty() {
        return Ok(scope.thread_id.clone());
    }
    Err((
        "invalid_arguments",
        "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
    ))
}

fn load_thread(conn: &Connection, thread_id: &str) -> Result<(Value, String, String), (&'static str, String)> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT t.payload_json, t.project_id, p.workspace_root
             FROM orchestration_v2_projection_threads t
             JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
             WHERE t.thread_id = ?1 AND t.deleted_at IS NULL",
            [thread_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| ("orchestration_error", e.to_string()))?;
    let Some((raw, project_id, workspace_root)) = row else {
        return Err(("thread_not_found", format!("Thread {thread_id} was not found.")));
    };
    let thread: Value =
        serde_json::from_str(&raw).map_err(|_| ("orchestration_error", "Corrupt thread row.".into()))?;
    Ok((thread, project_id, workspace_root))
}

fn resolve_target_from_parts(
    url_raw: Option<&str>,
    host_raw: Option<&str>,
    repo_raw: Option<&str>,
    number_raw: Option<u64>,
    preferred_identity: Option<&Value>,
) -> Result<ResolvedTarget, (&'static str, String)> {
    if let Some(url) = url_raw {
        let parsed = url::Url::parse(url).map_err(|_| {
            ("invalid_arguments", format!("Invalid pull request URL: {url}"))
        })?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(("invalid_arguments", format!("Invalid pull request URL: {url}")));
        }
        let key = crate::migration_050::change_request_url_key(url).ok_or_else(|| {
            ("invalid_arguments", format!("Invalid pull request URL: {url}"))
        })?;
        return Ok(ResolvedTarget {
            host: key.host,
            repository: key.repository,
            number: key.number as u64,
            url: url.to_owned(),
        });
    }
    let Some(number) = number_raw.filter(|n| *n > 0) else {
        return Err((
            "invalid_arguments",
            "Provide a pull request url or repository and number.".into(),
        ));
    };
    let fallback_key = preferred_identity
        .and_then(|id| id["canonicalKey"].as_str())
        .and_then(|k| k.split_once('/'));
    let host = host_raw
        .or_else(|| fallback_key.map(|(h, _)| h))
        .ok_or_else(|| {
            (
                "invalid_arguments",
                "Provide host or a project checkout with a recognized remote.".into(),
            )
        })?
        .to_ascii_lowercase();
    let repo = repo_raw
        .or_else(|| fallback_key.map(|(_, r)| r))
        .ok_or_else(|| {
            (
                "invalid_arguments",
                "Provide repository or a project checkout with a recognized remote.".into(),
            )
        })?
        .trim()
        .to_owned();
    let provider = preferred_identity
        .and_then(|id| id["provider"].as_str())
        .unwrap_or_else(|| if host.contains("gitlab") { "gitlab" } else { "github" });
    let url = match provider {
        "gitlab" => format!("https://{host}/{repo}/-/merge_requests/{number}"),
        "azure-devops" => format!("https://{host}/{repo}/pullrequest/{number}"),
        "forgejo" => format!("https://{host}/{repo}/pulls/{number}"),
        _ => format!("https://{host}/{repo}/pull/{number}"),
    };
    Ok(ResolvedTarget {
        host,
        repository: repo,
        number,
        url,
    })
}

fn find_project_for_pr(
    projects: &[(String, String, String)],
    host: &str,
    repository: &str,
    preferred_project_id: Option<&str>,
) -> Option<(String, String, String)> {
    let matches = |p: &&(String, String, String)| {
        crate::repository_identity::resolve(&p.2)
            .and_then(|id| id["canonicalKey"].as_str().map(str::to_owned))
            .and_then(|k| k.split_once('/').map(|(h, r)| (h.to_owned(), r.to_owned())))
            .is_some_and(|(h, r)| h.eq_ignore_ascii_case(host) && r.eq_ignore_ascii_case(repository))
    };
    if let Some(pref) = preferred_project_id {
        if let Some(found) = projects.iter().find(|p| p.0 == pref && matches(p)) {
            return Some(found.clone());
        }
    }
    projects.iter().find(matches).cloned()
}

fn forge_err(err: Value) -> (&'static str, String) {
    let message = err["detail"]
        .as_str()
        .or_else(|| err["message"].as_str())
        .unwrap_or("Pull request operation failed.")
        .to_owned();
    ("pull_request_error", message)
}

fn pr_key_matches(link: &Value, host: &str, repository: &str, number: u64) -> bool {
    link["number"].as_u64() == Some(number)
        && link["host"]
            .as_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(host))
        && link["repository"]
            .as_str()
            .is_some_and(|r| r.eq_ignore_ascii_case(repository))
}

fn apply_link_mutation(
    bus: &EventBus,
    thread_id: &str,
    targets: &[(ResolvedTarget, &str)],
) -> Result<(Vec<ResolvedTarget>, Vec<ResolvedTarget>), (&'static str, String)> {
    let mut newly_linked = Vec::new();
    let mut already_linked = Vec::new();
    bus.commit(|tx| {
        let raw: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else {
            return Ok((None, vec![]));
        };
        let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let obj = thread.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        let arr = obj.entry("pullRequests").or_insert_with(|| json!([]));
        if arr.is_null() {
            *arr = json!([]);
        }
        let links = arr.as_array_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut changed = false;
        for (target, source) in targets {
            if let Some(pos) = links
                .iter()
                .position(|l| pr_key_matches(l, &target.host, &target.repository, target.number))
            {
                if links[pos]["source"] == "stack-dismissed" {
                    links[pos]["source"] = json!(source);
                    links[pos]["linkedAt"] = json!(now);
                    links[pos]["url"] = json!(target.url);
                    newly_linked.push(target.clone());
                    changed = true;
                } else {
                    already_linked.push(target.clone());
                }
            } else {
                links.push(json!({
                    "host": target.host.to_lowercase(),
                    "repository": target.repository.to_lowercase(),
                    "number": target.number,
                    "url": target.url,
                    "source": source,
                    "linkedAt": now,
                    "snapshot": Value::Null,
                    "stack": Value::Null,
                }));
                newly_linked.push(target.clone());
                changed = true;
            }
        }
        if !changed {
            return Ok((Some(()), vec![]));
        }
        thread["updatedAt"] = json!(now);
        tx.execute(
            "UPDATE orchestration_v2_projection_threads SET payload_json=?2, updated_at=?3 WHERE thread_id=?1",
            rusqlite::params![thread_id, thread.to_string(), now],
        )?;
        let event = crate::event_store::Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id.to_owned(),
            event_type: "thread.pull-request-synced".into(),
            occurred_at: now,
            command_id: Some(format!("mcp-pr-link:{thread_id}:{}", uuid::Uuid::new_v4())),
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: thread.clone(),
            metadata: json!({"providerInstanceId": thread["providerInstanceId"]}),
        };
        Ok((Some(()), crate::event_store::append(tx, &[event])?))
    })
    .map_err(|e| ("orchestration_error", e.to_string()))?
    .ok_or_else(|| ("thread_not_found", format!("Thread {thread_id} was not found.")))?;
    Ok((newly_linked, already_linked))
}

fn apply_unlink_mutation(
    bus: &EventBus,
    thread_id: &str,
    match_fn: impl Fn(&Value) -> bool,
) -> Result<(Vec<(String, String, u64, String)>, usize), (&'static str, String)> {
    let mut unlinked = Vec::new();
    let mut remaining = 0usize;
    bus.commit(|tx| {
        let raw: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else {
            return Ok((None, vec![]));
        };
        let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let Some(links) = thread.get_mut("pullRequests").and_then(Value::as_array_mut) else {
            return Ok((Some(()), vec![]));
        };
        let mut kept = Vec::with_capacity(links.len());
        let mut changed = false;
        for mut link in links.drain(..) {
            if link["source"] != "stack-dismissed" && match_fn(&link) {
                let host = link["host"].as_str().unwrap_or("").to_lowercase();
                let repo = link["repository"].as_str().unwrap_or("").to_owned();
                let num = link["number"].as_u64().unwrap_or(0);
                let state = link["snapshot"]["state"].as_str().unwrap_or("open").to_owned();
                unlinked.push((host, repo, num, state));
                changed = true;
                if link["source"] == "stack" {
                    if let Some(obj) = link.as_object_mut() {
                        obj.insert("source".into(), json!("stack-dismissed"));
                        obj.remove("watch");
                    }
                    kept.push(link);
                }
            } else {
                if link["source"] != "stack-dismissed" {
                    remaining += 1;
                }
                kept.push(link);
            }
        }
        *links = kept;
        if !changed {
            return Ok((Some(()), vec![]));
        }
        thread["updatedAt"] = json!(now);
        tx.execute(
            "UPDATE orchestration_v2_projection_threads SET payload_json=?2, updated_at=?3 WHERE thread_id=?1",
            rusqlite::params![thread_id, thread.to_string(), now],
        )?;
        let event = crate::event_store::Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id.to_owned(),
            event_type: "thread.pull-request-synced".into(),
            occurred_at: now,
            command_id: Some(format!("mcp-pr-unlink:{thread_id}:{}", uuid::Uuid::new_v4())),
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: thread.clone(),
            metadata: json!({"providerInstanceId": thread["providerInstanceId"]}),
        };
        Ok((Some(()), crate::event_store::append(tx, &[event])?))
    })
    .map_err(|e| ("orchestration_error", e.to_string()))?
    .ok_or_else(|| ("thread_not_found", format!("Thread {thread_id} was not found.")))?;
    Ok((unlinked, remaining))
}

fn group_by_repository(items: &[ResolvedTarget]) -> Vec<Value> {
    let mut map: BTreeMap<(String, String), Vec<u64>> = BTreeMap::new();
    for item in items {
        map.entry((item.host.to_lowercase(), item.repository.clone()))
            .or_default()
            .push(item.number);
    }
    map.into_iter()
        .map(|((host, repository), numbers)| {
            json!({
                "host": host,
                "repository": repository,
                "numbers": numbers,
            })
        })
        .collect()
}

fn encode_cursor(value: &Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
}

fn decode_cursor(cursor: &str) -> Result<Value, (&'static str, String)> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor.trim())
        .map_err(|_| ("invalid_arguments", "This cursor is not from this tool.".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ("invalid_arguments", "This cursor is not from this tool.".into()))
}

fn position_in_patch(patch: &str, path: &str, line: u64, side: &str) -> Option<Value> {
    let want_old = side == "old";
    let mut current_file: Option<String> = None;
    let mut old_cur = 0u64;
    let mut new_cur = 0u64;
    let mut in_hunk = false;
    for raw in patch.lines() {
        if let Some(rest) = raw.strip_prefix("+++ ") {
            let trimmed = rest.trim().strip_prefix("b/").unwrap_or(rest.trim());
            current_file = if trimmed == "/dev/null" {
                None
            } else {
                Some(trimmed.to_owned())
            };
            in_hunk = false;
            continue;
        }
        if raw.starts_with("--- ") {
            continue;
        }
        if let Some(hunk) = raw.strip_prefix("@@ ") {
            if let Some(header) = hunk.split(" @@").next() {
                let mut parts = header.split_whitespace();
                if let (Some(old_part), Some(new_part)) = (parts.next(), parts.next()) {
                    old_cur = old_part
                        .trim_start_matches('-')
                        .split(',')
                        .next()
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(1);
                    new_cur = new_part
                        .trim_start_matches('+')
                        .split(',')
                        .next()
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(1);
                    in_hunk = true;
                }
            }
            continue;
        }
        if !in_hunk {
            continue;
        }
        if current_file.as_deref() != Some(path) {
            continue;
        }
        if let Some(first) = raw.as_bytes().first() {
            match first {
                b'+' => {
                    if !want_old && new_cur == line {
                        return Some(json!({"kind":"added","newLine":new_cur}));
                    }
                    new_cur += 1;
                }
                b'-' => {
                    if want_old && old_cur == line {
                        return Some(json!({"kind":"deleted","oldLine":old_cur}));
                    }
                    old_cur += 1;
                }
                b' ' => {
                    let matched = if want_old { old_cur == line } else { new_cur == line };
                    if matched {
                        return Some(json!({
                            "kind": "context",
                            "oldLine": old_cur,
                            "newLine": new_cur,
                            "side": if want_old { "left" } else { "right" }
                        }));
                    }
                    old_cur += 1;
                    new_cur += 1;
                }
                _ => {}
            }
        }
    }
    None
}

fn conversation_item_fits(size: &mut usize, empty: bool, item: &Value) -> bool {
    let next = *size + item.to_string().len();
    if next > CONVERSATION_PAGE_CHARS && !empty {
        return false;
    }
    *size = next;
    true
}

fn locate_branch_pr(
    ctx: &PullRequestMcpContext<'_>,
    scope: &Scope,
    args: &Value,
) -> Result<(Value, String, Vec<(String, String, String)>, Value), (&'static str, String)> {
    let thread_id = if scope.thread_id.is_empty() {
        trim_non_empty(&args["threadId"])
            .ok_or_else(|| {
                (
                    "invalid_arguments",
                    "Pass threadId: this MCP client is not running inside a T3 thread.".into(),
                )
            })?
            .to_owned()
    } else {
        scope.thread_id.clone()
    };
    let (thread, project_id, workspace_root, projects) = {
        let conn = ctx
            .db
            .lock()
            .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
        let (thread, pid, root) = load_thread(&conn, &thread_id)?;
        let projects = crate::pull_request_routing::projects(&conn).map_err(forge_err)?;
        (thread, pid, root, projects)
    };
    let cwd = trim_non_empty(&thread["worktreePath"])
        .unwrap_or(&workspace_root)
        .to_owned();
    let preferred_identity = crate::repository_identity::resolve(&cwd)
        .or_else(|| crate::repository_identity::resolve(&workspace_root));

    let explicit_number = args["number"].as_u64().filter(|n| *n > 0);
    let explicit_repo = trim_non_empty(&args["repository"]);
    let named: Option<(Option<String>, String, u64)> = if let Some(n) = explicit_number {
        let host = preferred_identity
            .as_ref()
            .and_then(|id| id["canonicalKey"].as_str())
            .and_then(|k| k.split_once('/').map(|(h, _)| h.to_owned()));
        let repo = explicit_repo
            .map(str::to_owned)
            .or_else(|| {
                preferred_identity
                    .as_ref()
                    .and_then(|id| id["canonicalKey"].as_str())
                    .and_then(|k| k.split_once('/').map(|(_, r)| r.to_owned()))
            })
            .ok_or_else(|| {
                (
                    "invalid_arguments",
                    "Could not resolve repository; pass repository alongside number.".into(),
                )
            })?;
        Some((host, repo, n))
    } else if let Some(bpr) = thread.get("branchPullRequest").filter(|v| v.is_object()) {
        let host = bpr["host"].as_str().map(str::to_owned);
        let repo = bpr["repository"].as_str().map(str::to_owned);
        let num = bpr["number"].as_u64();
        repo.zip(num).map(|(r, n)| (host, r, n))
    } else {
        let branch = thread["branch"].as_str();
        thread["pullRequests"]
            .as_array()
            .and_then(|arr| {
                arr.iter().rev().find(|l| {
                    l["source"] == "created"
                        && (l["snapshot"].is_null() || l["snapshot"]["headBranch"].as_str() == branch)
                })
            })
            .and_then(|l| {
                l["repository"]
                    .as_str()
                    .zip(l["number"].as_u64())
                    .map(|(r, n)| (l["host"].as_str().map(str::to_owned), r.to_owned(), n))
            })
    };
    let Some((host, repository, number)) = named else {
        return Err((
            "invalid_arguments",
            "This thread's branch has no known PR. Pass number, or open one with pull_request_create.".into(),
        ));
    };
    let host_str = host
        .or_else(|| {
            preferred_identity
                .as_ref()
                .and_then(|id| id["canonicalKey"].as_str())
                .and_then(|k| k.split_once('/').map(|(h, _)| h.to_owned()))
        })
        .unwrap_or_else(|| "github.com".into());
    let target_project = find_project_for_pr(&projects, &host_str, &repository, Some(&project_id))
        .unwrap_or_else(|| (project_id.clone(), "".into(), workspace_root.clone()));
    let mut ref_payload = json!({
        "projectId": target_project.0,
        "host": host_str,
        "repository": repository,
        "number": number,
    });
    if explicit_number.is_some() && explicit_repo.is_none() {
        if let Some(dn) = preferred_identity
            .as_ref()
            .and_then(|id| id["displayName"].as_str())
        {
            if let Some((_, r)) = preferred_identity
                .as_ref()
                .and_then(|id| id["canonicalKey"].as_str())
                .and_then(|k| k.split_once('/'))
            {
                let _ = dn;
                ref_payload["repository"] = json!(r);
            }
        }
    }
    Ok((thread, cwd, projects, ref_payload))
}

fn target_url_from_ref(ref_val: &Value, detail: Option<&Value>) -> String {
    if let Some(u) = detail.and_then(|d| d["url"].as_str()).filter(|s| !s.is_empty()) {
        return u.to_owned();
    }
    let host = ref_val["host"].as_str().unwrap_or("github.com");
    let repo = ref_val["repository"].as_str().unwrap_or("");
    let num = ref_val["number"].as_u64().unwrap_or(0);
    if host.contains("gitlab") {
        format!("https://{host}/{repo}/-/merge_requests/{num}")
    } else {
        format!("https://{host}/{repo}/pull/{num}")
    }
}

fn draft_mr_title(title: &str) -> String {
    let lower = title.trim_start().to_ascii_lowercase();
    if lower.starts_with("[draft]") || lower.starts_with("(draft)") || lower.starts_with("draft:") {
        title.to_owned()
    } else {
        format!("Draft: {title}")
    }
}

fn current_branch(cwd: &str) -> Result<String, (&'static str, String)> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .map_err(|e| ("pull_request_error", format!("Failed to read git branch: {e}")))?;
    if !out.status.success() {
        return Err(("pull_request_error", "Could not read the current branch.".into()));
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if branch.is_empty() || branch == "HEAD" {
        return Err(("pull_request_error", "Check out a branch before opening a pull request.".into()));
    }
    Ok(branch)
}

fn ensure_branch_pushed(cwd: &str, branch: &str) -> Result<(), (&'static str, String)> {
    let mut push = Command::new("git");
    push.args(["push", "-u", "origin", branch])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::vcs_worktree::run_command(&mut push, Duration::from_secs(120))
        .map_err(|e| ("pull_request_error", format!("Failed to push branch: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err((
            "pull_request_error",
            if stderr.is_empty() {
                "Failed to push branch before opening pull request.".into()
            } else {
                stderr
            },
        ));
    }
    Ok(())
}

fn update_pr_title_body(
    projects: &[(String, String, String)],
    detail: &Value,
    host: &str,
    repo: &str,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<(), (&'static str, String)> {
    let provider = detail["provider"].as_str().unwrap_or("");
    let cwd = detail["workspaceRoot"].as_str().unwrap_or(".");
    match provider {
        "github" => {
            let mut cmd = Command::new("gh");
            cmd.args([
                "pr",
                "edit",
                &number.to_string(),
                "--repo",
                &format!("{host}/{repo}"),
            ])
            .current_dir(cwd);
            if let Some(t) = title {
                cmd.args(["--title", t]);
            }
            if let Some(b) = body {
                cmd.args(["--body", b]);
            }
            let out = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(15))
                .map_err(|f| {
                    forge_err(crate::github_pinned_credential::operation_error(
                        f,
                        "update",
                        "Could not update pull request.",
                    ))
                })?;
            let _ = out;
            Ok(())
        }
        "gitlab" => {
            let encoded: String = repo
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            let path = format!("projects/{encoded}/merge_requests/{number}");
            let mut cmd = Command::new("glab");
            cmd.args(["api", "--method", "PUT", &path]).current_dir(cwd);
            let title_arg;
            let desc_arg;
            if let Some(t) = title {
                title_arg = format!("title={t}");
                cmd.args(["--raw-field", &title_arg]);
            }
            if let Some(b) = body {
                desc_arg = format!("description={b}");
                cmd.args(["--raw-field", &desc_arg]);
            }
            let out = crate::vcs_worktree::run_command(&mut cmd, Duration::from_secs(15))
                .map_err(|e| ("pull_request_error", format!("Failed to update MR: {e}")))?;
            if !out.status.success() {
                return Err(("pull_request_error", "Could not update merge request.".into()));
            }
            Ok(())
        }
        _ => {
            let _ = projects;
            Err((
                "pull_request_error",
                "This host does not support editing PR title or body here.".into(),
            ))
        }
    }
}

pub(crate) async fn call(
    ctx: PullRequestMcpContext<'_>,
    scope: &Scope,
    name: &str,
    args: Value,
) -> Result<Value, (&'static str, String)> {
    if !scope.capabilities.contains("pull-requests") {
        return Err(("capability_denied", "Pull requests are unavailable in this environment.".into()));
    }
    match name {
        "link_pull_request" => {
            let thread_id = require_thread_id(scope, &args)?;
            let (preferred_identity, is_subagent) = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                let (thread, _, workspace_root) = load_thread(&conn, &thread_id)?;
                let sub = thread["lineage"]["relationshipToParent"] == "subagent";
                let cwd = trim_non_empty(&thread["worktreePath"]).unwrap_or(&workspace_root);
                (crate::repository_identity::resolve(cwd), sub)
            };
            let target = resolve_target_from_parts(
                trim_non_empty(&args["url"]),
                trim_non_empty(&args["host"]),
                trim_non_empty(&args["repository"]),
                args["number"].as_u64(),
                preferred_identity.as_ref(),
            )?;
            let (_, already) = apply_link_mutation(ctx.bus, &thread_id, &[(target.clone(), "agent")])?;
            let mut out = json!({
                "host": target.host,
                "repository": target.repository,
                "number": target.number,
                "url": target.url,
                "alreadyLinked": !already.is_empty(),
            });
            if is_subagent {
                out["next"] = json!(CHILD_PULL_REQUEST_REPORT_NEXT);
            }
            Ok(out)
        }
        "link_pull_requests" => {
            let thread_id = require_thread_id(scope, &args)?;
            let is_subagent = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                let (thread, _, _) = load_thread(&conn, &thread_id)?;
                thread["lineage"]["relationshipToParent"] == "subagent"
            };
            let urls = args["urls"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| ("invalid_arguments", "Pass at least one PR URL.".into()))?;
            let mut targets = Vec::new();
            let mut invalid_urls = Vec::new();
            let mut seen = HashSet::new();
            for val in urls {
                let Some(url) = val.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                    continue;
                };
                match resolve_target_from_parts(Some(url), None, None, None, None) {
                    Ok(t) => {
                        let key = (t.host.to_lowercase(), t.repository.to_lowercase(), t.number);
                        if seen.insert(key) {
                            targets.push(t);
                        }
                    }
                    Err(_) => invalid_urls.push(url.to_owned()),
                }
            }
            let pairs: Vec<(ResolvedTarget, &str)> = targets.iter().map(|t| (t.clone(), "agent")).collect();
            let (fresh, already) = apply_link_mutation(ctx.bus, &thread_id, &pairs)?;
            let mut out = json!({
                "linked": group_by_repository(&fresh),
                "alreadyLinked": group_by_repository(&already),
                "linkedCount": targets.len(),
            });
            if !invalid_urls.is_empty() {
                out["invalidUrls"] = json!(invalid_urls);
            }
            if is_subagent {
                out["next"] = json!(CHILD_PULL_REQUEST_REPORT_NEXT);
            }
            Ok(out)
        }
        "unlink_pull_request" => {
            let thread_id = require_thread_id(scope, &args)?;
            let preferred_identity = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                let (thread, _, workspace_root) = load_thread(&conn, &thread_id)?;
                let cwd = trim_non_empty(&thread["worktreePath"]).unwrap_or(&workspace_root);
                crate::repository_identity::resolve(cwd)
            };
            let target = resolve_target_from_parts(
                trim_non_empty(&args["url"]),
                trim_non_empty(&args["host"]),
                trim_non_empty(&args["repository"]),
                args["number"].as_u64(),
                preferred_identity.as_ref(),
            )?;
            let (unlinked, _) = apply_unlink_mutation(ctx.bus, &thread_id, |l| {
                pr_key_matches(l, &target.host, &target.repository, target.number)
            })?;
            Ok(json!({
                "host": target.host,
                "repository": target.repository,
                "number": target.number,
                "wasLinked": !unlinked.is_empty(),
            }))
        }
        "unlink_pull_requests" => {
            let thread_id = require_thread_id(scope, &args)?;
            let states: HashSet<String> = args["states"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| ("invalid_arguments", "Pass at least one state.".into()))?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            let (unlinked, remaining) = apply_unlink_mutation(ctx.bus, &thread_id, |l| {
                l["snapshot"]["state"]
                    .as_str()
                    .is_some_and(|s| states.contains(s))
            })?;
            let mut groups: BTreeMap<(String, String, String), Vec<u64>> = BTreeMap::new();
            let unlinked_count = unlinked.len();
            for (h, r, n, s) in unlinked {
                groups.entry((h, r, s)).or_default().push(n);
            }
            let grouped: Vec<Value> = groups
                .into_iter()
                .map(|((host, repository, state), numbers)| {
                    json!({"host": host, "repository": repository, "state": state, "numbers": numbers})
                })
                .collect();
            Ok(json!({
                "unlinked": grouped,
                "unlinkedCount": unlinked_count,
                "remaining": remaining,
            }))
        }
        "list_thread_pull_requests" => {
            let thread_id = require_thread_id(scope, &args)?;
            let states: Option<HashSet<String>> = args["states"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect());
            let cursor = trim_non_empty(&args["cursor"]);
            let thread = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                load_thread(&conn, &thread_id)?.0
            };
            let links = thread["pullRequests"].as_array().cloned().unwrap_or_default();
            let mut visible: Vec<(String, Value)> = links
                .iter()
                .filter(|l| l["source"] != "stack-dismissed")
                .filter(|l| {
                    states.as_ref().is_none_or(|allowed| {
                        allowed.contains(l["snapshot"]["state"].as_str().unwrap_or("open"))
                    })
                })
                .map(|l| {
                    let pos = format!(
                        "{} {} {} {:010}",
                        l["linkedAt"].as_str().unwrap_or(""),
                        l["host"].as_str().unwrap_or("").to_lowercase(),
                        l["repository"].as_str().unwrap_or("").to_lowercase(),
                        l["number"].as_u64().unwrap_or(0)
                    );
                    (pos, l.clone())
                })
                .filter(|(pos, _)| cursor.is_none_or(|c| pos.as_str() > c))
                .collect();
            visible.sort_by(|a, b| a.0.cmp(&b.0));
            let has_more = visible.len() > LIST_PAGE_SIZE;
            let page: Vec<(String, Value)> = visible.into_iter().take(LIST_PAGE_SIZE).collect();
            let next_cursor = if has_more {
                page.last().map(|(pos, _)| json!(pos)).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let mut seen_chains: HashSet<String> = HashSet::new();
            let mut chains = Vec::new();
            let entries: Vec<Value> = page
                .into_iter()
                .map(|(_, l)| {
                    let stack = l.get("stack").filter(|s| s.is_object()).and_then(|s| {
                        let layers = s["layers"].as_array()?;
                        if layers.len() < 2 {
                            return None;
                        }
                        let num = l["number"].as_u64()?;
                        let idx = layers.iter().position(|ly| ly["number"].as_u64() == Some(num))?;
                        let kind = s["kind"].as_str().unwrap_or("derived");
                        if let Some(id) = s["id"].as_str() {
                            if seen_chains.insert(id.to_owned()) {
                                chains.push(json!({
                                    "kind": kind,
                                    "numbers": layers.iter().filter_map(|ly| ly["number"].as_u64()).collect::<Vec<_>>()
                                }));
                            }
                        }
                        Some(json!({"kind": kind, "position": idx + 1, "size": layers.len()}))
                    });
                    let snap = l.get("snapshot").filter(|s| s.is_object());
                    json!({
                        "host": l["host"].as_str().unwrap_or("").to_lowercase(),
                        "repository": l["repository"],
                        "number": l["number"],
                        "url": l["url"],
                        "source": l["source"],
                        "watching": !l["watch"].is_null(),
                        "state": snap.and_then(|s| s.get("state")).cloned().unwrap_or(Value::Null),
                        "title": snap.and_then(|s| s.get("title")).cloned().unwrap_or(Value::Null),
                        "headBranch": snap.and_then(|s| s.get("headBranch")).cloned().unwrap_or(Value::Null),
                        "baseBranch": snap.and_then(|s| s.get("baseBranch")).cloned().unwrap_or(Value::Null),
                        "isDraft": snap.and_then(|s| s.get("isDraft")).cloned().unwrap_or(Value::Null),
                        "stack": stack,
                    })
                })
                .collect();
            Ok(json!({
                "pullRequests": entries,
                "chains": chains,
                "nextCursor": next_cursor,
            }))
        }
        "write_pull_request_guides" => {
            let Some(auth) = ctx.auth else {
                return Err(("orchestration_error", "Review guide generator is unavailable in this test context.".into()));
            };
            let pr_inputs = args["pullRequests"]
                .as_array()
                .filter(|a| (1..=20).contains(&a.len()))
                .ok_or_else(|| ("invalid_arguments", "Pass 1 to 20 pull requests.".into()))?
                .clone();
            let projects = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                crate::pull_request_routing::projects(&conn).map_err(forge_err)?
            };
            let mut guides = Vec::new();
            for entry in pr_inputs {
                let target = match resolve_target_from_parts(
                    trim_non_empty(&entry["url"]),
                    trim_non_empty(&entry["host"]),
                    trim_non_empty(&entry["repository"]),
                    entry["number"].as_u64(),
                    None,
                ) {
                    Ok(t) => t,
                    Err((_, msg)) => {
                        guides.push(json!({
                            "host": entry["host"].as_str().unwrap_or(""),
                            "repository": entry["repository"].as_str().unwrap_or(""),
                            "number": entry["number"].as_u64().unwrap_or(0),
                            "url": entry["url"].as_str().unwrap_or(""),
                            "outcome": "failed",
                            "detail": msg,
                        }));
                        continue;
                    }
                };
                let Some(proj) = find_project_for_pr(&projects, &target.host, &target.repository, None) else {
                    guides.push(json!({
                        "host": target.host,
                        "repository": target.repository,
                        "number": target.number,
                        "url": target.url,
                        "outcome": "failed",
                        "detail": format!("No project in this environment is a checkout of {}, so its review guide cannot be written.", target.repository),
                    }));
                    continue;
                };
                let readiness = crate::pull_request_review_guide::ProviderReadiness {
                    sessions: ctx.sessions.clone(),
                    cache: ctx.provider_cache.clone(),
                    cwd: proj.2.clone(),
                };
                let input = json!({
                    "projectId": proj.0,
                    "host": target.host,
                    "repository": target.repository,
                    "number": target.number,
                });
                match crate::pull_request_review_guide::generate(
                    ctx.review_guide_runs.clone(),
                    auth.clone(),
                    ctx.settings.clone(),
                    readiness,
                    ctx.review_guide_worktrees.to_path_buf(),
                    input,
                )
                .await
                {
                    Ok(res) => {
                        let started = res["started"].as_bool().unwrap_or(false);
                        guides.push(json!({
                            "host": target.host,
                            "repository": target.repository,
                            "number": target.number,
                            "url": target.url,
                            "outcome": if started { "started" } else { "running" },
                            "detail": Value::Null,
                        }));
                    }
                    Err(err) => {
                        guides.push(json!({
                            "host": target.host,
                            "repository": target.repository,
                            "number": target.number,
                            "url": target.url,
                            "outcome": "failed",
                            "detail": err["detail"].as_str().unwrap_or("Review guide failed."),
                        }));
                    }
                }
            }
            Ok(json!({"guides": guides}))
        }
        "read_pull_request_guide" => {
            let target = resolve_target_from_parts(
                trim_non_empty(&args["url"]),
                trim_non_empty(&args["host"]),
                trim_non_empty(&args["repository"]),
                args["number"].as_u64(),
                None,
            )?;
            let projects = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                crate::pull_request_routing::projects(&conn).map_err(forge_err)?
            };
            let proj = find_project_for_pr(&projects, &target.host, &target.repository, None)
                .or_else(|| projects.first().cloned())
                .ok_or_else(|| ("pull_request_error", "No project found in this environment.".into()))?;
            let input = json!({
                "projectId": proj.0,
                "host": target.host,
                "repository": target.repository,
                "number": target.number,
            });
            let db = ctx.db.clone();
            let runs = ctx.review_guide_runs.clone();
            tokio::task::spawn_blocking(move || {
                let key = crate::migration_050::PullRequestKey {
                    host: target.host.to_lowercase(),
                    repository: target.repository.to_lowercase(),
                    number: target.number as i64,
                };
                let guide = {
                    let guard = db
                        .lock()
                        .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                    crate::pull_request_review_guide::read_stored(&guard, &key).map_err(forge_err)?
                };
                let detail = crate::pull_request_detail::read(projects, &input).map_err(forge_err)?;
                let head = detail.get("headSha").cloned().unwrap_or(Value::Null);
                let stale = !guide.is_null()
                    && head.as_str().is_some_and(|h| guide["headSha"].as_str() != Some(h));
                Ok(json!({
                    "host": target.host,
                    "repository": target.repository,
                    "number": target.number,
                    "url": target.url,
                    "guide": guide,
                    "run": runs.get(&key),
                    "currentHeadSha": head,
                    "stale": stale,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "Review guide read panicked.".into()))?
        }
        "pull_request_read" => {
            let (_, _, projects, ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            let cursor_val = match trim_non_empty(&args["cursor"]) {
                Some(c) => Some(decode_cursor(c)?),
                None => None,
            };
            let sections: Vec<String> = if let Some(ref cur) = cursor_val {
                if cur.get("diff").is_some() {
                    vec!["diff".into()]
                } else {
                    vec!["conversation".into()]
                }
            } else if let Some(arr) = args["sections"].as_array() {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            } else {
                vec!["summary".into(), "checks".into()]
            };
            let include_resolved = cursor_val
                .as_ref()
                .and_then(|c| c["includeResolved"].as_bool())
                .unwrap_or_else(|| args["includeResolved"] == true);
            let want_summary = sections.iter().any(|s| s == "summary");
            let want_checks = sections.iter().any(|s| s == "checks");
            let want_conversation = sections.iter().any(|s| s == "conversation");
            let want_diff = sections.iter().any(|s| s == "diff");

            tokio::task::spawn_blocking(move || {
                let mut detail_url = None;
                let mut out = json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": target_url_from_ref(&ref_val, None),
                });
                if want_summary || want_checks {
                    let detail =
                        crate::pull_request_detail::read(projects.clone(), &ref_val).map_err(forge_err)?;
                    detail_url = Some(detail.clone());
                    if let Some(u) = detail["url"].as_str() {
                        out["url"] = json!(u);
                    }
                    if want_summary {
                        let labels: Vec<Value> = detail["labels"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|l| l["name"].as_str().map(|s| json!(s)))
                            .collect();
                        let reviewers: Vec<Value> = detail["reviewers"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|r| r["login"].as_str().map(|s| json!(s)))
                            .collect();
                        out["summary"] = json!({
                            "title": detail["title"],
                            "body": detail["body"].as_str().unwrap_or(""),
                            "state": detail["state"],
                            "isDraft": detail["isDraft"],
                            "author": detail["author"]["login"],
                            "headBranch": detail["headBranch"],
                            "baseBranch": detail["baseBranch"],
                            "headSha": detail.get("headSha").cloned().unwrap_or(Value::Null),
                            "mergeability": detail["mergeability"],
                            "behindBy": detail.get("behindBy").cloned().unwrap_or(Value::Null),
                            "autoMergeEnabled": detail.get("autoMergeEnabled").cloned().unwrap_or(Value::Null),
                            "additions": detail["additions"],
                            "deletions": detail["deletions"],
                            "changedFiles": detail["changedFiles"],
                            "labels": labels,
                            "reviewers": reviewers,
                        });
                    }
                    if want_checks {
                        out["checks"] = detail["checks"].clone();
                    }
                }
                if want_conversation {
                    let activity =
                        crate::pull_request_activity::read(projects.clone(), &ref_val).map_err(forge_err)?;
                    if detail_url.is_none() {
                        if let Some(u) = activity["url"].as_str() {
                            out["url"] = json!(u);
                        }
                    }
                    let start_t = cursor_val
                        .as_ref()
                        .and_then(|c| c["threads"].as_u64())
                        .unwrap_or(0) as usize;
                    let start_c = cursor_val
                        .as_ref()
                        .and_then(|c| c["comments"].as_u64())
                        .unwrap_or(0) as usize;
                    let rthreads = activity["reviewThreads"].as_array().cloned().unwrap_or_default();
                    let comments = activity["comments"].as_array().cloned().unwrap_or_default();
                    let mut size = 0usize;
                    let mut ti = start_t.min(rthreads.len());
                    let mut ci = start_c.min(comments.len());
                    let mut page_threads = Vec::new();
                    let mut page_comments = Vec::new();
                    while ti < rthreads.len() {
                        let th = &rthreads[ti];
                        if include_resolved || th["isResolved"] != true {
                            if !conversation_item_fits(
                                &mut size,
                                page_threads.is_empty() && page_comments.is_empty(),
                                th,
                            ) {
                                break;
                            }
                            page_threads.push(th.clone());
                        }
                        ti += 1;
                    }
                    if ti == rthreads.len() {
                        while ci < comments.len()
                            && conversation_item_fits(
                                &mut size,
                                page_threads.is_empty() && page_comments.is_empty(),
                                &comments[ci],
                            )
                        {
                            page_comments.push(comments[ci].clone());
                            ci += 1;
                        }
                    }
                    let done = ti == rthreads.len() && ci == comments.len();
                    let hidden_resolved = if include_resolved {
                        0
                    } else {
                        rthreads.iter().filter(|t| t["isResolved"] == true).count()
                    };
                    let mapped_threads: Vec<Value> = page_threads
                        .into_iter()
                        .map(|t| {
                            let mut th_comments: Vec<Value> = t["comments"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                                .into_iter()
                                .map(|c| {
                                    json!({
                                        "author": c["author"]["login"],
                                        "body": c["body"],
                                        "createdAt": c["createdAt"],
                                    })
                                })
                                .collect();
                            let mut next_cur = t["nextCommentsCursor"].as_str().map(str::to_owned);
                            for _ in 0..THREAD_COMMENT_PAGES {
                                let Some(cur) = next_cur.take() else { break };
                                let mut req = ref_val.clone();
                                req["threadId"] = t["id"].clone();
                                req["cursor"] = json!(cur);
                                let Ok(res) = crate::pull_request_thread_comments::read(projects.clone(), &req) else {
                                    next_cur = Some(cur);
                                    break;
                                };
                                for c in res["comments"].as_array().into_iter().flatten() {
                                    th_comments.push(json!({
                                        "author": c["author"]["login"],
                                        "body": c["body"],
                                        "createdAt": c["createdAt"],
                                    }));
                                }
                                next_cur = res["nextCursor"].as_str().map(str::to_owned);
                            }
                            json!({
                                "id": t["id"],
                                "path": t["path"],
                                "line": t["line"],
                                "isResolved": t["isResolved"],
                                "isOutdated": t["isOutdated"],
                                "comments": th_comments,
                                "moreComments": next_cur.is_some(),
                            })
                        })
                        .collect();
                    let mapped_comments: Vec<Value> = page_comments
                        .into_iter()
                        .map(|c| {
                            json!({
                                "id": c["id"],
                                "kind": c["kind"],
                                "author": c["author"]["login"],
                                "body": c["body"],
                                "createdAt": c["createdAt"],
                                "path": c.get("path").cloned().unwrap_or(Value::Null),
                                "reviewState": c.get("reviewState").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect();
                    let next_cur = if done {
                        Value::Null
                    } else {
                        json!(encode_cursor(&json!({"threads": ti, "comments": ci, "includeResolved": include_resolved})))
                    };
                    out["conversation"] = json!({
                        "comments": mapped_comments,
                        "reviewThreads": mapped_threads,
                        "hiddenResolvedThreads": hidden_resolved,
                        "truncated": activity["commentsTruncated"] == true || activity["reviewThreadsTruncated"] == true,
                        "nextCursor": next_cur,
                    });
                }
                if want_diff {
                    let mut req = ref_val.clone();
                    if let Some(dcur) = cursor_val.as_ref().and_then(|c| c["diff"].as_str()) {
                        req["cursor"] = json!(dcur);
                    }
                    let diff = crate::pull_request_diff::read(projects, &req).map_err(forge_err)?;
                    let next_cur = diff["nextCursor"]
                        .as_str()
                        .map(|c| json!(encode_cursor(&json!({"diff": c}))))
                        .unwrap_or(Value::Null);
                    out["diff"] = json!({
                        "patch": diff["patch"],
                        "truncated": diff["truncated"] == true,
                        "nextCursor": next_cur,
                    });
                }
                Ok(out)
            })
            .await
            .map_err(|_| ("orchestration_error", "PR read worker panicked.".into()))?
        }
        "pull_request_list" => {
            let thread_id = if scope.thread_id.is_empty() {
                return Err(("invalid_arguments", "Thread context required.".into()));
            } else {
                scope.thread_id.clone()
            };
            let (project_id, projects) = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                let (_, pid, _) = load_thread(&conn, &thread_id)?;
                let projects = crate::pull_request_routing::projects(&conn).map_err(forge_err)?;
                (pid, projects)
            };
            let cursors = match trim_non_empty(&args["cursor"]) {
                Some(c) => Some(decode_cursor(c)?),
                None => None,
            };
            let mut req = json!({
                "projectId": project_id,
                "state": args["state"].as_str().unwrap_or("open"),
                "involvement": args["involvement"].as_str().unwrap_or("all"),
                "limit": args["limit"].as_u64().unwrap_or(30).clamp(1, 100),
            });
            if let Some(q) = trim_non_empty(&args["query"]) {
                req["query"] = json!(q);
            }
            if let Some(c) = cursors {
                req["cursors"] = c;
            }
            tokio::task::spawn_blocking(move || {
                let listed = crate::pull_request_list::read(projects, &req).map_err(forge_err)?;
                let entries = listed["entries"].as_array().cloned().unwrap_or_default();
                if entries.is_empty() {
                    if let Some(err) = listed["errors"].as_array().and_then(|a| a.first()) {
                        return Err((
                            "pull_request_error",
                            err["message"]
                                .as_str()
                                .unwrap_or("Could not list pull requests.")
                                .to_owned(),
                        ));
                    }
                }
                let mapped: Vec<Value> = entries
                    .into_iter()
                    .map(|e| {
                        json!({
                            "number": e["number"],
                            "title": e["title"],
                            "url": e["url"],
                            "author": e["author"]["login"],
                            "headBranch": e["headBranch"],
                            "baseBranch": e["baseBranch"],
                            "state": e["state"],
                            "isDraft": e["isDraft"],
                            "reviewDecision": e.get("reviewDecision").cloned().unwrap_or(Value::Null),
                            "checksState": e.get("checksState").cloned().unwrap_or(Value::Null),
                            "updatedAt": e["updatedAt"],
                        })
                    })
                    .collect();
                let next_cursors = &listed["nextCursors"];
                let next_cursor = next_cursors
                    .as_object()
                    .filter(|m| !m.is_empty())
                    .map(|_| json!(encode_cursor(next_cursors)))
                    .unwrap_or(Value::Null);
                Ok(json!({
                    "pullRequests": mapped,
                    "truncated": listed["truncated"] == true,
                    "nextCursor": next_cursor,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "PR list worker panicked.".into()))?
        }
        "pull_request_create" => {
            let title = trim_non_empty(&args["title"])
                .ok_or_else(|| ("invalid_arguments", "title is required.".into()))?
                .to_owned();
            let body = args["body"]
                .as_str()
                .ok_or_else(|| ("invalid_arguments", "body is required.".into()))?
                .to_owned();
            let base = trim_non_empty(&args["base"]).map(str::to_owned);
            let draft = args["draft"] == true;
            if scope.thread_id.is_empty() {
                return Err(("invalid_arguments", "Thread context required.".into()));
            }
            let thread_id = scope.thread_id.clone();
            let (thread, _pid, workspace_root) = {
                let conn = ctx
                    .db
                    .lock()
                    .map_err(|_| ("orchestration_error", "Database unavailable".into()))?;
                load_thread(&conn, &thread_id)?
            };
            let is_subagent = thread["lineage"]["relationshipToParent"] == "subagent";
            let cwd = trim_non_empty(&thread["worktreePath"])
                .unwrap_or(&workspace_root)
                .to_owned();
            let identity = crate::repository_identity::resolve(&cwd)
                .or_else(|| crate::repository_identity::resolve(&workspace_root))
                .ok_or_else(|| ("pull_request_error", "This project has no recognized remote.".into()))?;
            let provider = identity["provider"].as_str().unwrap_or("");
            let canonical = identity["canonicalKey"].as_str().unwrap_or("");
            let (host, repo) = canonical
                .split_once('/')
                .ok_or_else(|| ("pull_request_error", "Unrecognized remote repository.".into()))?;
            let branch = current_branch(&cwd)?;
            ensure_branch_pushed(&cwd, &branch)?;

            let (url, created) = match provider {
                "github" => {
                    let mut existing = Command::new("gh");
                    existing
                        .args(["pr", "view", "--repo", &format!("{host}/{repo}"), "--json", "url,state"])
                        .current_dir(&cwd);
                    if let Ok(out) = crate::github_pinned_credential::run_classified(
                        &mut existing,
                        Duration::from_secs(10),
                    ) {
                        if let Ok(v) = serde_json::from_slice::<Value>(&out) {
                            if v["state"] == "OPEN" {
                                if let Some(u) = v["url"].as_str() {
                                    let target = resolve_target_from_parts(Some(u), None, None, None, Some(&identity))?;
                                    apply_link_mutation(ctx.bus, &thread_id, &[(target.clone(), "created")])?;
                                    let mut res = json!({
                                        "host": target.host,
                                        "repository": target.repository,
                                        "number": target.number,
                                        "url": target.url,
                                        "created": false,
                                    });
                                    if is_subagent {
                                        res["next"] = json!(CHILD_PULL_REQUEST_REPORT_NEXT);
                                    }
                                    return Ok(res);
                                }
                            }
                        }
                    }
                    let mut cmd = Command::new("gh");
                    cmd.args([
                        "pr",
                        "create",
                        "--repo",
                        &format!("{host}/{repo}"),
                        "--title",
                        &title,
                        "--body",
                        &body,
                        "--head",
                        &branch,
                    ])
                    .current_dir(&cwd);
                    if let Some(ref b) = base {
                        cmd.args(["--base", b]);
                    }
                    if draft {
                        cmd.arg("--draft");
                    }
                    let out = crate::github_pinned_credential::run_classified(
                        &mut cmd,
                        Duration::from_secs(30),
                    )
                    .map_err(|f| {
                        forge_err(crate::github_pinned_credential::operation_error(
                            f,
                            "createPullRequest",
                            "Could not create pull request.",
                        ))
                    })?;
                    let stdout = String::from_utf8_lossy(&out);
                    let u = stdout
                        .lines()
                        .rev()
                        .find(|l| l.trim().starts_with("http"))
                        .map(str::trim)
                        .ok_or_else(|| ("pull_request_error", "gh pr create did not return a PR URL.".into()))?
                        .to_owned();
                    (u, true)
                }
                "gitlab" => {
                    let encoded: String = repo
                        .bytes()
                        .map(|b| {
                            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                                (b as char).to_string()
                            } else {
                                format!("%{b:02X}")
                            }
                        })
                        .collect();
                    let list_path = format!("projects/{encoded}/merge_requests?state=opened&source_branch={}", url::form_urlencoded::byte_serialize(branch.as_bytes()).collect::<String>());
                    let mut check = Command::new("glab");
                    check.args(["api", &list_path]).current_dir(&cwd);
                    if let Ok(out) = crate::vcs_worktree::run_command(&mut check, Duration::from_secs(10)) {
                        if let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&out.stdout) {
                            if let Some(u) = items.first().and_then(|item| item["web_url"].as_str()) {
                                let target = resolve_target_from_parts(Some(u), None, None, None, Some(&identity))?;
                                apply_link_mutation(ctx.bus, &thread_id, &[(target.clone(), "created")])?;
                                let mut res = json!({
                                    "host": target.host,
                                    "repository": target.repository,
                                    "number": target.number,
                                    "url": target.url,
                                    "created": false,
                                });
                                if is_subagent {
                                    res["next"] = json!(CHILD_PULL_REQUEST_REPORT_NEXT);
                                }
                                return Ok(res);
                            }
                        }
                    }
                    let create_title = if draft { draft_mr_title(&title) } else { title.clone() };
                    let target_branch = base.clone().unwrap_or_else(|| "main".into());
                    let path = format!("projects/{encoded}/merge_requests");
                    let mut cmd = Command::new("glab");
                    cmd.args([
                        "api",
                        "--method",
                        "POST",
                        &path,
                        "--raw-field",
                        &format!("source_branch={branch}"),
                        "--raw-field",
                        &format!("target_branch={target_branch}"),
                        "--raw-field",
                        &format!("title={create_title}"),
                        "--raw-field",
                        &format!("description={body}"),
                    ])
                    .current_dir(&cwd);
                    let out = crate::vcs_worktree::run_command(&mut cmd, Duration::from_secs(30))
                        .map_err(|e| ("pull_request_error", format!("Failed to create MR: {e}")))?;
                    if !out.status.success() {
                        return Err(("pull_request_error", "Could not create GitLab merge request.".into()));
                    }
                    let created_mr: Value = serde_json::from_slice(&out.stdout)
                        .map_err(|_| ("pull_request_error", "Invalid GitLab merge request response.".into()))?;
                    let u = created_mr["web_url"]
                        .as_str()
                        .ok_or_else(|| ("pull_request_error", "GitLab MR response missing web_url.".into()))?
                        .to_owned();
                    (u, true)
                }
                _ => {
                    return Err(("pull_request_error", "Creating PRs via MCP is not supported for this host yet.".into()));
                }
            };
            let target = resolve_target_from_parts(Some(&url), None, None, None, Some(&identity))?;
            apply_link_mutation(ctx.bus, &thread_id, &[(target.clone(), "created")])?;
            let mut out = json!({
                "host": target.host,
                "repository": target.repository,
                "number": target.number,
                "url": target.url,
                "created": created,
            });
            if is_subagent {
                out["next"] = json!(CHILD_PULL_REQUEST_REPORT_NEXT);
            }
            Ok(out)
        }
        "pull_request_update" => {
            let title = trim_non_empty(&args["title"]).map(str::to_owned);
            let body = args.get("body").and_then(Value::as_str).map(str::to_owned);
            let ready = args.get("ready").and_then(Value::as_bool);
            let state = trim_non_empty(&args["state"]).map(str::to_owned);
            let add_labels = args.get("addLabels").and_then(Value::as_array).cloned();
            let remove_labels = args.get("removeLabels").and_then(Value::as_array).cloned();
            let request_reviewers = args.get("requestReviewers").and_then(Value::as_array).cloned();
            if title.is_none()
                && body.is_none()
                && ready.is_none()
                && state.is_none()
                && add_labels.is_none()
                && remove_labels.is_none()
                && request_reviewers.is_none()
            {
                return Err((
                    "invalid_arguments",
                    "Pass title, body, ready, state, addLabels, removeLabels, or requestReviewers.".into(),
                ));
            }
            let (_, _, projects, ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            tokio::task::spawn_blocking(move || {
                let detail =
                    crate::pull_request_detail::read(projects.clone(), &ref_val).map_err(forge_err)?;
                let url = target_url_from_ref(&ref_val, Some(&detail));
                let host = ref_val["host"].as_str().unwrap_or("");
                let repo = detail["repository"]
                    .as_str()
                    .or_else(|| ref_val["repository"].as_str())
                    .unwrap_or("");
                let number = ref_val["number"].as_u64().unwrap_or(0);
                if title.is_some() || body.is_some() {
                    update_pr_title_body(
                        &projects,
                        &detail,
                        host,
                        repo,
                        number,
                        title.as_deref(),
                        body.as_deref(),
                    )?;
                }
                for (labels_opt, applied) in [(add_labels, true), (remove_labels, false)] {
                    if let Some(labels) = labels_opt {
                        let mut input = ref_val.clone();
                        input["labels"] = Value::Array(labels);
                        input["applied"] = json!(applied);
                        crate::pull_request_labels::run(projects.clone(), &input, true)
                            .map_err(forge_err)?;
                    }
                }
                if let Some(names) = request_reviewers {
                    let mut reviewers = Vec::new();
                    for n_val in names {
                        let Some(name) = n_val.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                            continue;
                        };
                        let mut query = ref_val.clone();
                        query["query"] = json!(name);
                        let res = crate::pull_request_reviewers::run(projects.clone(), &query, false)
                            .map_err(forge_err)?;
                        let wanted = name.to_lowercase();
                        let candidate = res["candidates"]
                            .as_array()
                            .and_then(|arr| {
                                arr.iter().find(|c| {
                                    c["login"]
                                        .as_str()
                                        .is_some_and(|l| l.to_lowercase() == wanted)
                                        || c["id"].as_str().is_some_and(|i| i.to_lowercase() == wanted)
                                })
                            })
                            .cloned()
                            .ok_or_else(|| {
                                (
                                    "pull_request_error",
                                    format!("No reviewer named {name} can be requested on this PR."),
                                )
                            })?;
                        reviewers.push(json!({"id": candidate["id"], "kind": candidate["kind"]}));
                    }
                    let mut req = ref_val.clone();
                    req["reviewers"] = Value::Array(reviewers);
                    req["requested"] = json!(true);
                    crate::pull_request_reviewers::run(projects.clone(), &req, true)
                        .map_err(forge_err)?;
                }
                if let Some(r) = ready {
                    let mut req = ref_val.clone();
                    req["action"] = json!(if r { "ready" } else { "draft" });
                    crate::pull_request_actions::run(projects.clone(), &req).map_err(forge_err)?;
                }
                if let Some(s) = state {
                    let mut req = ref_val.clone();
                    req["action"] = json!(if s == "closed" { "close" } else { "reopen" });
                    crate::pull_request_actions::run(projects.clone(), &req).map_err(forge_err)?;
                }
                Ok(json!({
                    "host": host,
                    "repository": repo,
                    "number": number,
                    "url": url,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "PR update worker panicked.".into()))?
        }
        "pull_request_respond" => {
            let review_thread_id = trim_non_empty(&args["reviewThreadId"]).map(str::to_owned);
            let body = trim_non_empty(&args["body"]).map(str::to_owned);
            let resolved = args.get("resolved").and_then(Value::as_bool);
            if body.is_none() && (review_thread_id.is_none() || resolved.is_none()) {
                return Err(("invalid_arguments", "Pass body, or reviewThreadId with resolved.".into()));
            }
            if review_thread_id.is_none() && resolved.is_some() {
                return Err(("invalid_arguments", "resolved needs reviewThreadId.".into()));
            }
            let (_, _, projects, ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            tokio::task::spawn_blocking(move || {
                let detail =
                    crate::pull_request_detail::read(projects.clone(), &ref_val).map_err(forge_err)?;
                let url = target_url_from_ref(&ref_val, Some(&detail));
                if let Some(ref b) = body {
                    if let Some(ref tid) = review_thread_id {
                        let mut req = ref_val.clone();
                        req["threadId"] = json!(tid);
                        req["body"] = json!(b);
                        crate::pull_request_thread_write::run(projects.clone(), &req, false)
                            .map_err(forge_err)?;
                    } else {
                        let mut req = ref_val.clone();
                        req["body"] = json!(b);
                        crate::pull_request_comment::run(projects.clone(), &req, false)
                            .map_err(forge_err)?;
                    }
                }
                if let (Some(ref tid), Some(res)) = (&review_thread_id, resolved) {
                    let mut req = ref_val.clone();
                    req["threadId"] = json!(tid);
                    req["resolved"] = json!(res);
                    if let Err(err) = crate::pull_request_thread_write::run(projects, &req, true) {
                        let (code, msg) = forge_err(err);
                        return Err((
                            code,
                            if body.is_some() {
                                format!("The reply was posted, but setting resolved failed: {msg} Retry without body.")
                            } else {
                                msg
                            },
                        ));
                    }
                }
                Ok(json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": url,
                    "replied": body.is_some(),
                    "resolved": resolved,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "PR respond worker panicked.".into()))?
        }
        "pull_request_review" => {
            let verdict = trim_non_empty(&args["verdict"])
                .filter(|v| matches!(*v, "comment" | "approve" | "request-changes"))
                .ok_or_else(|| ("invalid_arguments", "verdict must be comment, approve, or request-changes.".into()))?
                .to_owned();
            let body = args["body"].as_str().unwrap_or("").to_owned();
            let line_comments = args["comments"].as_array().cloned().unwrap_or_default();
            let (_, _, projects, ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            tokio::task::spawn_blocking(move || {
                let detail =
                    crate::pull_request_detail::read(projects.clone(), &ref_val).map_err(forge_err)?;
                let url = target_url_from_ref(&ref_val, Some(&detail));
                let mut placed: Vec<Option<Value>> = vec![None; line_comments.len()];
                if !line_comments.is_empty() {
                    let mut cursor: Option<String> = None;
                    for _ in 0..REVIEW_DIFF_PAGES {
                        if placed.iter().all(Option::is_some) {
                            break;
                        }
                        let mut dreq = ref_val.clone();
                        if let Some(ref c) = cursor {
                            dreq["cursor"] = json!(c);
                        }
                        let diff = crate::pull_request_diff::read(projects.clone(), &dreq)
                            .map_err(forge_err)?;
                        let patch = diff["patch"].as_str().unwrap_or("");
                        for (idx, c) in line_comments.iter().enumerate() {
                            if placed[idx].is_some() {
                                continue;
                            }
                            let path = c["path"].as_str().unwrap_or("");
                            let line = c["line"].as_u64().unwrap_or(0);
                            let side = c["side"].as_str().unwrap_or("new");
                            let pos = position_in_patch(patch, path, line, side);
                            let start = match c["startLine"].as_u64() {
                                Some(s) => position_in_patch(patch, path, s, side),
                                None => None,
                            };
                            if let Some(pos) = pos {
                                if c.get("startLine").is_some_and(|v| !v.is_null()) && start.is_none() {
                                    continue;
                                }
                                let mut entry = json!({
                                    "path": path,
                                    "position": pos,
                                    "body": c["body"],
                                });
                                if let Some(sp) = start {
                                    entry["startPosition"] = sp;
                                }
                                placed[idx] = Some(entry);
                            }
                        }
                        cursor = diff["nextCursor"].as_str().map(str::to_owned);
                        if cursor.is_none() {
                            break;
                        }
                    }
                    if let Some((idx, _)) = placed.iter().enumerate().find(|(_, p)| p.is_none()) {
                        let missing = &line_comments[idx];
                        let line = missing["startLine"]
                            .as_u64()
                            .or_else(|| missing["line"].as_u64())
                            .unwrap_or(0);
                        let side = missing["side"].as_str().unwrap_or("new");
                        return Err((
                            "pull_request_error",
                            format!(
                                "{} line {} ({} side) is not in this PR's diff. Comment on a changed line or one shown around it.",
                                missing["path"].as_str().unwrap_or(""),
                                line,
                                side
                            ),
                        ));
                    }
                }
                let final_comments: Vec<Value> = placed.into_iter().flatten().collect();
                let mut req = ref_val.clone();
                req["verdict"] = json!(verdict);
                req["body"] = json!(body);
                req["comments"] = Value::Array(final_comments);
                crate::pull_request_submit_review::run(projects, &req).map_err(forge_err)?;
                Ok(json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": url,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "PR review worker panicked.".into()))?
        }
        "pull_request_merge" => {
            let expected_head_sha = trim_non_empty(&args["expectedHeadSha"])
                .ok_or_else(|| ("invalid_arguments", "expectedHeadSha is required.".into()))?
                .to_owned();
            let method = trim_non_empty(&args["method"]).map(str::to_owned);
            let auto = args["auto"] == true;
            let stack = args["stack"] == true;
            if stack && auto {
                return Err(("invalid_arguments", "A stack merge cannot wait with auto.".into()));
            }
            let (_, _, projects, ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            tokio::task::spawn_blocking(move || {
                let mut req = ref_val.clone();
                req["action"] = json!(if auto { "enable-auto-merge" } else { "merge" });
                req["expectedHeadSha"] = json!(expected_head_sha);
                if let Some(m) = method {
                    req["mergeMethod"] = json!(m);
                }
                if stack {
                    let st = crate::pull_request_stack::read(projects.clone(), &ref_val)
                        .map_err(forge_err)?;
                    let number = ref_val["number"].as_u64().unwrap_or(0);
                    let layers = st["layers"].as_array().ok_or_else(|| {
                        (
                            "pull_request_error",
                            format!("PR #{number} is not in a stack this host can merge. Merge it without stack."),
                        )
                    })?;
                    let end = layers
                        .iter()
                        .position(|l| l["number"].as_u64() == Some(number))
                        .ok_or_else(|| {
                            (
                                "pull_request_error",
                                format!("PR #{number} is not in a stack this host can merge. Merge it without stack."),
                            )
                        })?;
                    let mut heads = Vec::new();
                    for layer in &layers[..=end] {
                        if layer["state"] == "merged" {
                            continue;
                        }
                        let lnum = layer["number"].as_u64().unwrap_or(0);
                        let sha = if lnum == number {
                            Some(expected_head_sha.clone())
                        } else {
                            layer["headSha"].as_str().map(str::to_owned)
                        }
                        .ok_or_else(|| {
                            (
                                "pull_request_error",
                                format!("The host did not report PR #{lnum}'s head, so the stack cannot be pinned. Try again."),
                            )
                        })?;
                        heads.push(json!({"number": lnum, "headSha": sha}));
                    }
                    req["stackNumber"] = st["number"].clone();
                    req["expectedStackHeads"] = Value::Array(heads);
                }
                crate::pull_request_actions::run(projects.clone(), &req).map_err(forge_err)?;
                let after = crate::pull_request_summary::read(projects, &ref_val).map_err(forge_err)?;
                Ok(json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": target_url_from_ref(&ref_val, Some(&after)),
                    "state": after["state"],
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "PR merge worker panicked.".into()))?
        }
        "ci_logs" => {
            let check = trim_non_empty(&args["check"]).map(str::to_owned);
            let tail_lines = args["tailLines"].as_u64().unwrap_or(200).clamp(1, 2000);
            let (_, _, projects, mut ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            if let Some(c) = check {
                ref_val["check"] = json!(c);
            }
            ref_val["tailLines"] = json!(tail_lines);
            tokio::task::spawn_blocking(move || {
                let url = target_url_from_ref(&ref_val, None);
                let checks =
                    crate::pull_request_checks::check_logs(projects, &ref_val).map_err(forge_err)?;
                Ok(json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": url,
                    "checks": checks,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "CI logs worker panicked.".into()))?
        }
        "ci_rerun" => {
            let check = trim_non_empty(&args["check"]).map(str::to_owned);
            let (_, _, projects, mut ref_val) = locate_branch_pr(&ctx, scope, &args)?;
            if let Some(c) = check {
                ref_val["check"] = json!(c);
            }
            let bus = ctx.bus.clone();
            let thread_id = scope.thread_id.clone();
            tokio::task::spawn_blocking(move || {
                let url = target_url_from_ref(&ref_val, None);
                let checks = crate::pull_request_checks::rerun_checks(projects, &ref_val)
                    .map_err(forge_err)?;
                if !thread_id.is_empty()
                    && checks.as_array().is_some_and(|a| a.iter().any(|c| c["rerun"] == true))
                {
                    // Reopen watch check tracking when a rerun is triggered.
                    let _ = bus.commit(|tx| {
                        let raw: Option<String> = tx
                            .query_row(
                                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",
                                [&thread_id],
                                |r| r.get(0),
                            )
                            .optional()?;
                        let Some(raw) = raw else {
                            return Ok(((), vec![]));
                        };
                        let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                        let Some(links) = thread.get_mut("pullRequests").and_then(Value::as_array_mut) else {
                            return Ok(((), vec![]));
                        };
                        let mut changed = false;
                        for link in links {
                            if let Some(watch) = link.get_mut("watch").and_then(Value::as_object_mut) {
                                watch.insert("checksPending".into(), json!(true));
                                changed = true;
                            }
                        }
                        if !changed {
                            return Ok(((), vec![]));
                        }
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        tx.execute(
                            "UPDATE orchestration_v2_projection_threads SET payload_json=?2, updated_at=?3 WHERE thread_id=?1",
                            rusqlite::params![thread_id, thread.to_string(), now],
                        )?;
                        let event = crate::event_store::Event {
                            id: uuid::Uuid::new_v4().to_string(),
                            aggregate_kind: "thread".into(),
                            stream_id: thread_id.clone(),
                            event_type: "thread.pull-request-synced".into(),
                            occurred_at: now,
                            command_id: None,
                            causation_event_id: None,
                            correlation_id: None,
                            actor_kind: "server".into(),
                            payload: thread,
                            metadata: json!({}),
                        };
                        Ok(((), crate::event_store::append(tx, &[event])?))
                    });
                }
                Ok(json!({
                    "host": ref_val["host"],
                    "repository": ref_val["repository"],
                    "number": ref_val["number"],
                    "url": url,
                    "checks": checks,
                }))
            })
            .await
            .map_err(|_| ("orchestration_error", "CI rerun worker panicked.".into()))?
        }
        _ => Err(("invalid_arguments", format!("Unknown pull request tool: {name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_in_patch_locates_added_deleted_and_context_lines() {
        let patch = "\
diff --git a/src/lib.rs b/src/lib.rs
index 111..222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,4 +10,5 @@
 fn keep() {}
-let old_val = 1;
+let new_val = 2;
+let extra = 3;
 let tail = 4;
";
        assert_eq!(
            position_in_patch(patch, "src/lib.rs", 10, "new"),
            Some(json!({"kind":"context","oldLine":10,"newLine":10,"side":"right"}))
        );
        assert_eq!(
            position_in_patch(patch, "src/lib.rs", 11, "old"),
            Some(json!({"kind":"deleted","oldLine":11}))
        );
        assert_eq!(
            position_in_patch(patch, "src/lib.rs", 12, "new"),
            Some(json!({"kind":"added","newLine":12}))
        );
        assert_eq!(position_in_patch(patch, "src/lib.rs", 99, "new"), None);
    }

    #[test]
    fn draft_mr_title_preserves_existing_prefix_and_adds_when_missing() {
        assert_eq!(draft_mr_title("Fix bug"), "Draft: Fix bug");
        assert_eq!(draft_mr_title("draft: Fix bug"), "draft: Fix bug");
        assert_eq!(draft_mr_title("[Draft] Fix bug"), "[Draft] Fix bug");
        assert_eq!(draft_mr_title("(draft) Fix bug"), "(draft) Fix bug");
    }

    #[test]
    fn link_unlink_and_list_thread_pull_requests_round_trip() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        bus.commit(|tx| {
            tx.execute(
                "INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, payload_json, updated_at, created_at) VALUES('t1','p1','T','codex','auto','default',?1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [json!({"id":"t1","projectId":"p1","title":"T","lineage":{"relationshipToParent":null},"pullRequests":[]}).to_string()],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();

        let t1 = ResolvedTarget {
            host: "github.com".into(),
            repository: "acme/app".into(),
            number: 10,
            url: "https://github.com/acme/app/pull/10".into(),
        };
        let t2 = ResolvedTarget {
            host: "github.com".into(),
            repository: "acme/app".into(),
            number: 11,
            url: "https://github.com/acme/app/pull/11".into(),
        };
        let (fresh, already) = apply_link_mutation(&bus, "t1", &[(t1.clone(), "agent"), (t2.clone(), "agent")]).unwrap();
        assert_eq!(fresh.len(), 2);
        assert!(already.is_empty());

        let (fresh2, already2) = apply_link_mutation(&bus, "t1", &[(t1, "agent")]).unwrap();
        assert!(fresh2.is_empty());
        assert_eq!(already2.len(), 1);

        let (unlinked, remaining) = apply_unlink_mutation(&bus, "t1", |l| l["number"] == 10).unwrap();
        assert_eq!(unlinked.len(), 1);
        assert_eq!(remaining, 1);
    }
}
