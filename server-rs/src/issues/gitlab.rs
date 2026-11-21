//! GitLab issue tracker driver over `glab api`.
use serde_json::{json, Value};
use std::{collections::HashMap, process::Command, time::Duration};

use crate::github_pinned_credential::{self, CommandFailure};

use super::{capabilities, IssueCreateResult, ListInput, TrackerError};

pub fn caps() -> Value {
    capabilities(true, true, true, true, true, true, true, true, true, true)
}

const TIMEOUT: Duration = Duration::from_secs(20);
const PAGE_SIZE: i64 = 50;
const MAX_ACTIVITY_PAGES: usize = 20;
const TEMPLATE_LIMIT: usize = 20;

fn map_failure(operation: &str, failure: CommandFailure) -> TrackerError {
    let reason = match failure {
        CommandFailure::Spawn(std::io::ErrorKind::NotFound) => "missing-tool",
        CommandFailure::Unauthenticated => "unauthenticated",
        CommandFailure::RateLimited => "rate-limited",
        CommandFailure::NotFound => "not-found",
        CommandFailure::Spawn(_) | CommandFailure::Failed => "failed",
    };
    let detail = match reason {
        "missing-tool" => "GitLab CLI (`glab`) is not installed.",
        "unauthenticated" => "GitLab authentication is unavailable. Sign in and retry.",
        "rate-limited" => "GitLab API rate limit exceeded.",
        "not-found" => "GitLab could not find the requested issue.",
        _ => "The GitLab issue request failed.",
    };
    TrackerError::new("gitlab", operation, reason, detail)
}

fn encode_project(scope: &str) -> String {
    percent_encoding::utf8_percent_encode(scope.trim(), percent_encoding::NON_ALPHANUMERIC)
        .to_string()
}

fn parse_number(key: &str, operation: &str) -> Result<i64, TrackerError> {
    let t = key.trim();
    if !t.is_empty() && t.chars().next().is_some_and(|c| ('1'..='9').contains(&c)) && t.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(n) = t.parse::<i64>() {
            return Ok(n);
        }
    }
    Err(TrackerError::new(
        "gitlab",
        operation,
        "not-found",
        "GitLab could not find the requested issue.",
    ))
}

fn parse_page(cursor: Option<&str>, operation: &str) -> Result<i64, TrackerError> {
    match cursor {
        None => Ok(1),
        Some(c) => {
            let t = c.trim();
            if !t.is_empty()
                && t.len() <= 7
                && t.chars().next().is_some_and(|ch| ('1'..='9').contains(&ch))
                && t.chars().all(|ch| ch.is_ascii_digit())
            {
                if let Ok(n) = t.parse::<i64>() {
                    return Ok(n);
                }
            }
            Err(TrackerError::new(
                "gitlab",
                operation,
                "failed",
                "The cursor was not one GitLab handed out.",
            ))
        }
    }
}

fn api_raw(
    cwd: &str,
    host: &str,
    operation: &str,
    path: &str,
    method: Option<&str>,
    body: Option<Value>,
    include_headers: bool,
) -> Result<String, TrackerError> {
    let mut cmd = Command::new("glab");
    cmd.args(["api", path]);
    if include_headers {
        cmd.arg("--include");
    }
    if let Some(m) = method {
        cmd.args(["--method", m]);
    }
    let stdin_bytes = if let Some(b) = body {
        cmd.args(["--input", "-", "--header", "Content-Type: application/json"]);
        Some(serde_json::to_vec(&b).map_err(|_| {
            TrackerError::new("gitlab", operation, "failed", "Invalid request body.")
        })?)
    } else {
        None
    };
    if !host.trim().is_empty() {
        cmd.env("GITLAB_HOST", host.trim());
    }
    cmd.env("GLAB_PROMPT_DISABLED", "1").current_dir(cwd);
    let bytes = match stdin_bytes {
        Some(bytes) => github_pinned_credential::run_classified_with_input(&mut cmd, TIMEOUT, bytes),
        None => github_pinned_credential::run_classified(&mut cmd, TIMEOUT),
    }
    .map_err(|f| map_failure(operation, f))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn api_json(
    cwd: &str,
    host: &str,
    operation: &str,
    path: &str,
    method: Option<&str>,
    body: Option<Value>,
) -> Result<Value, TrackerError> {
    let raw = api_raw(cwd, host, operation, path, method, body, false)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|_| {
        TrackerError::new(
            "gitlab",
            operation,
            "failed",
            format!("GitLab returned an unreadable {operation} response."),
        )
    })
}

fn split_paged_response(raw: &str) -> (&str, Option<Option<i64>>) {
    if !raw.starts_with("HTTP/") {
        return (raw, None);
    }
    if let Some(idx) = raw.find("\r\n\r\n").or_else(|| raw.find("\n\n")) {
        let sep_len = if raw[idx..].starts_with("\r\n\r\n") { 4 } else { 2 };
        let headers = &raw[..idx];
        let body = &raw[idx + sep_len..];
        let mut next = None;
        for line in headers.lines() {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("x-next-page") {
                    let vt = v.trim();
                    if vt.is_empty() {
                        next = Some(None);
                    } else if let Ok(p) = vt.parse::<i64>() {
                        if p > 0 {
                            next = Some(Some(p));
                        }
                    }
                }
            }
        }
        return (body, next);
    }
    (raw, None)
}

fn url_query(params: &[(&str, &str)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in params {
        ser.append_pair(k, v);
    }
    ser.finish()
}

fn trimmed_opt(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn to_actor(raw: Option<&Value>) -> Value {
    let Some(u) = raw.filter(|v| !v.is_null()) else {
        return Value::Null;
    };
    let Some(login) = trimmed_opt(u.get("username")) else {
        return Value::Null;
    };
    json!({
        "login": login,
        "name": trimmed_opt(u.get("name")),
        "avatarUrl": trimmed_opt(u.get("avatar_url")),
    })
}

fn to_state(state: Option<&str>) -> Value {
    if state.is_some_and(|s| s.eq_ignore_ascii_case("closed")) {
        json!({ "category": "closed", "name": "Closed" })
    } else {
        json!({ "category": "open", "name": "Open" })
    }
}

fn gitlab_states() -> Value {
    json!([
        { "category": "open", "name": "Open" },
        { "category": "closed", "name": "Closed" }
    ])
}

fn award_name(content: &str) -> Option<&'static str> {
    match content {
        "thumbs-up" => Some("thumbsup"),
        "thumbs-down" => Some("thumbsdown"),
        "laugh" => Some("laughing"),
        "hooray" => Some("tada"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        "rocket" => Some("rocket"),
        "eyes" => Some("eyes"),
        _ => None,
    }
}

fn reaction_from_award(name: &str) -> Option<&'static str> {
    match name {
        "thumbsup" | "+1" => Some("thumbs-up"),
        "thumbsdown" | "-1" => Some("thumbs-down"),
        "laughing" | "smile" => Some("laugh"),
        "tada" => Some("hooray"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        "rocket" => Some("rocket"),
        "eyes" => Some("eyes"),
        _ => None,
    }
}

fn to_summary(raw: &Value) -> Value {
    let iid = raw.get("iid").and_then(Value::as_i64).unwrap_or(0);
    let assignees = raw
        .get("assignees")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let v = to_actor(Some(a));
            (!v.is_null()).then_some(v)
        })
        .collect::<Vec<_>>();
    let labels = raw
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| {
            if let Some(s) = l.as_str() {
                Some(json!({ "name": s, "color": Value::Null }))
            } else {
                let name = trimmed_opt(l.get("name"))?;
                let color = trimmed_opt(l.get("color"))
                    .map(|c| c.trim_start_matches('#').to_owned());
                Some(json!({ "name": name, "color": color }))
            }
        })
        .collect::<Vec<_>>();
    json!({
        "key": iid.to_string(),
        "displayKey": format!("#{iid}"),
        "title": raw.get("title").and_then(Value::as_str).unwrap_or(""),
        "url": raw.get("web_url").and_then(Value::as_str).unwrap_or(""),
        "author": to_actor(raw.get("author")),
        "state": to_state(raw.get("state").and_then(Value::as_str)),
        "createdAt": raw.get("created_at").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": raw.get("updated_at").and_then(Value::as_str).unwrap_or(""),
        "closedAt": trimmed_opt(raw.get("closed_at")),
        "assignees": assignees,
        "labels": labels,
        "commentCount": raw.get("user_notes_count").and_then(Value::as_i64).unwrap_or(0).max(0),
    })
}

pub fn get_viewer(cwd: &str, host: &str) -> Result<String, TrackerError> {
    let data = api_json(cwd, host, "getViewer", "user", None, None)?;
    trimmed_opt(data.get("username")).ok_or_else(|| {
        TrackerError::new(
            "gitlab",
            "getViewer",
            "failed",
            "GitLab returned no username for the signed-in account.",
        )
    })
}

pub fn list_issues(
    cwd: &str,
    host: &str,
    scope: &str,
    involvement: &str,
    viewer: Option<&str>,
    input: &ListInput,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let page = parse_page(input.cursor.as_deref(), "listIssues")?;
    let per_page = input.limit.clamp(1, PAGE_SIZE);
    let page_str = page.to_string();
    let per_page_str = per_page.to_string();
    let state_param = if input.state == "open" { "opened" } else { input.state.as_str() };
    let order_by = if input.sort == "created" { "created_at" } else { "updated_at" };
    let labels_joined = input.labels.join(",");
    let mut params: Vec<(&str, &str)> = vec![("state", state_param)];
    if let Some(v) = viewer {
        match involvement {
            "authored" => params.push(("author_username", v)),
            "assigned" if input.assignee.is_none() => params.push(("assignee_username", v)),
            _ => {}
        }
    }
    if let Some(q) = input.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(("search", q));
    }
    if !labels_joined.is_empty() {
        params.push(("labels", &labels_joined));
    }
    if let Some(a) = input.assignee.as_deref() {
        params.push(("assignee_username", a));
    }
    params.push(("order_by", order_by));
    params.push(("sort", "desc"));
    params.push(("with_labels_details", "true"));
    params.push(("per_page", &per_page_str));
    params.push(("page", &page_str));

    let path = format!("projects/{}/issues?{}", encode_project(scope), url_query(&params));
    let val = api_json(cwd, host, "listIssues", &path, None, None)?;
    let arr = val.as_array().ok_or_else(|| {
        TrackerError::new(
            "gitlab",
            "listIssues",
            "failed",
            "GitLab returned an unreadable listIssues response.",
        )
    })?;
    let raw_count = arr.len() as i64;
    let also_assigned = (involvement == "assigned" && input.assignee.is_some())
        .then(|| viewer.map(str::to_ascii_lowercase))
        .flatten();
    let mut items: Vec<Value> = arr.iter().map(to_summary).collect();
    if let Some(expected) = also_assigned {
        items.retain(|item| {
            item["assignees"]
                .as_array()
                .is_some_and(|asg| asg.iter().any(|a| a["login"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(&expected))))
        });
    }
    let next_cursor = (raw_count >= per_page).then(|| (page + 1).to_string());
    Ok((items, next_cursor))
}

fn aggregate_awards(raw_awards: Option<&Value>, viewer: &str) -> Vec<Value> {
    let mut grouped: Vec<(String, i64, Vec<String>, bool)> = Vec::new();
    for item in raw_awards.and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = reaction_from_award(name) else {
            continue;
        };
        let user = item.pointer("/user/username").and_then(Value::as_str);
        let mine = user.is_some_and(|u| u.eq_ignore_ascii_case(viewer));
        if let Some(entry) = grouped.iter_mut().find(|(c, _, _, _)| c == content) {
            entry.1 += 1;
            if let Some(u) = user.filter(|_| !mine) {
                entry.2.push(u.to_owned());
            }
            entry.3 = entry.3 || mine;
        } else {
            grouped.push((
                content.to_owned(),
                1,
                user.filter(|_| !mine).map(str::to_owned).into_iter().collect(),
                mine,
            ));
        }
    }
    grouped
        .into_iter()
        .map(|(content, count, actors, viewer_has_reacted)| {
            json!({
                "content": content,
                "count": count,
                "actors": actors,
                "viewerHasReacted": viewer_has_reacted,
            })
        })
        .collect()
}

fn fetch_notes_page(
    cwd: &str,
    host: &str,
    issue_path: &str,
    page: i64,
    only_activity: bool,
    viewer: &str,
) -> Result<(Vec<Value>, Vec<Value>, Option<String>), TrackerError> {
    let page_s = page.to_string();
    let per_page_s = PAGE_SIZE.to_string();
    let mut params = vec![
        ("per_page", per_page_s.as_str()),
        ("page", page_s.as_str()),
        ("order_by", "created_at"),
        ("sort", "asc"),
    ];
    if only_activity {
        params.push(("activity_filter", "only_activity"));
    }
    let path = format!("{issue_path}/notes?{}", url_query(&params));
    let raw = api_raw(cwd, host, "notes", &path, None, None, true)?;
    let (body, next_header) = split_paged_response(&raw);
    let notes: Vec<Value> = serde_json::from_str(body.trim()).map_err(|_| {
        TrackerError::new(
            "gitlab",
            "notes",
            "failed",
            "GitLab returned an unreadable notes response.",
        )
    })?;
    let raw_count = notes.len() as i64;
    let mut comments = Vec::new();
    let mut events = Vec::new();
    for n in &notes {
        let id = n.get("id").and_then(Value::as_i64).unwrap_or(0);
        let created_at = n.get("created_at").and_then(Value::as_str).unwrap_or("");
        let author = to_actor(n.get("author"));
        let body_text = n.get("body").and_then(Value::as_str).unwrap_or("");
        if n.get("system").and_then(Value::as_bool) == Some(true) {
            let kind = if body_text.starts_with("closed") {
                Some("closed")
            } else if body_text.starts_with("reopened") {
                Some("reopened")
            } else if body_text.starts_with("changed title") {
                Some("renamed")
            } else if body_text.starts_with("assigned to") {
                Some("assigned")
            } else if body_text.starts_with("unassigned") {
                Some("unassigned")
            } else if body_text.contains("mentioned in") {
                Some("referenced")
            } else {
                None
            };
            if let Some(k) = kind {
                events.push(json!({
                    "id": format!("note-{id}"),
                    "kind": k,
                    "detail": trimmed_opt(Some(&Value::String(body_text.to_owned()))),
                    "actor": author,
                    "createdAt": created_at,
                }));
            }
        } else {
            comments.push(json!({
                "id": id.to_string(),
                "author": author,
                "body": body_text,
                "createdAt": created_at,
                "url": Value::Null,
                "reactions": aggregate_awards(n.get("award_emoji"), viewer),
            }));
        }
    }
    let next = match next_header {
        Some(Some(p)) => Some(p.to_string()),
        Some(None) => None,
        None => (raw_count >= PAGE_SIZE).then(|| (page + 1).to_string()),
    };
    Ok((comments, events, next))
}

pub fn get_issue(cwd: &str, host: &str, scope: &str, key: &str) -> Result<Value, TrackerError> {
    let number = parse_number(key, "getIssue")?;
    let encoded = encode_project(scope);
    let issue_path = format!("projects/{encoded}/issues/{number}");
    let list_q = url_query(&[
        ("iids[]", &number.to_string()),
        ("with_labels_details", "true"),
        ("per_page", "1"),
    ]);
    let list_res = api_json(
        cwd,
        host,
        "getIssue",
        &format!("projects/{encoded}/issues?{list_q}"),
        None,
        None,
    )?;
    let raw_issue = list_res
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| {
            TrackerError::new(
                "gitlab",
                "getIssue",
                "not-found",
                "GitLab could not find the requested issue.",
            )
        })?;
    let viewer = get_viewer(cwd, host)?;
    let (comments, mut events, comments_cursor) =
        fetch_notes_page(cwd, host, &issue_path, 1, false, &viewer)?;
    let mut page = 1;
    for _ in 0..MAX_ACTIVITY_PAGES {
        if let Ok((_, act_events, next)) =
            fetch_notes_page(cwd, host, &issue_path, page, true, &viewer)
        {
            events.extend(act_events);
            match next.and_then(|s| s.parse::<i64>().ok()) {
                Some(p) => page = p,
                None => break,
            }
        } else {
            break;
        }
    }
    let issue_awards = api_json(
        cwd,
        host,
        "getIssue",
        &format!("{issue_path}/award_emoji?per_page=100"),
        None,
        None,
    )
    .ok();
    let mut pr_map = HashMap::<String, Value>::new();
    for (endpoint, closes) in [("closed_by", true), ("related_merge_requests", false)] {
        if let Ok(Value::Array(mrs)) = api_json(
            cwd,
            host,
            "getIssue",
            &format!("{issue_path}/{endpoint}?per_page=100"),
            None,
            None,
        ) {
            for mr in mrs {
                let Some(iid) = mr.get("iid").and_then(Value::as_i64) else {
                    continue;
                };
                let url = mr.get("web_url").and_then(Value::as_str).unwrap_or("");
                let title = mr.get("title").and_then(Value::as_str).unwrap_or("");
                let st = match mr.get("state").and_then(Value::as_str).unwrap_or("") {
                    "merged" => "merged",
                    "closed" => "closed",
                    _ => "open",
                };
                let draft = mr.get("draft").and_then(Value::as_bool).unwrap_or(false)
                    || mr.get("work_in_progress").and_then(Value::as_bool).unwrap_or(false);
                let repo = scope.trim().to_owned();
                let k = format!("{repo}#{iid}");
                pr_map.entry(k).or_insert_with(|| {
                    json!({
                        "repository": repo,
                        "number": iid,
                        "title": title,
                        "url": url,
                        "state": st,
                        "isDraft": draft,
                        "closesIssue": closes,
                    })
                });
            }
        }
    }

    let mut summary = to_summary(&raw_issue);
    let obj = summary.as_object_mut().unwrap();
    obj.insert("body".into(), json!(raw_issue.get("description").and_then(Value::as_str).unwrap_or("")));
    obj.insert("viewer".into(), json!(viewer));
    obj.insert(
        "viewerPermissions".into(),
        json!({ "setState": true, "comment": true, "edit": true, "labels": true, "assignees": true }),
    );
    obj.insert("states".into(), gitlab_states());
    obj.insert(
        "reactions".into(),
        Value::Array(aggregate_awards(issue_awards.as_ref(), &viewer)),
    );
    obj.insert("comments".into(), Value::Array(comments));
    obj.insert("commentsCursor".into(), json!(comments_cursor));
    obj.insert("events".into(), Value::Array(events));
    obj.insert("linkedPullRequests".into(), Value::Array(pr_map.into_values().collect()));
    Ok(summary)
}

pub fn get_comments(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    cursor: &str,
) -> Result<Value, TrackerError> {
    let number = parse_number(key, "getComments")?;
    let page = parse_page(Some(cursor), "getComments")?;
    let viewer = get_viewer(cwd, host)?;
    let issue_path = format!("projects/{}/issues/{number}", encode_project(scope));
    let (comments, _, next_cursor) =
        fetch_notes_page(cwd, host, &issue_path, page, false, &viewer)?;
    Ok(json!({ "comments": comments, "nextCursor": next_cursor }))
}

fn resolve_assignee_ids(cwd: &str, host: &str, operation: &str, assignees: &[String]) -> Result<Vec<i64>, TrackerError> {
    let mut ids = Vec::with_capacity(assignees.len());
    for a in assignees {
        if !a.is_empty() && a.chars().next().is_some_and(|c| ('1'..='9').contains(&c)) && a.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(id) = a.parse::<i64>() {
                ids.push(id);
                continue;
            }
        }
        let q = url_query(&[("username", a)]);
        let res = api_json(cwd, host, operation, &format!("users?{q}"), None, None)?;
        let Some(id) = res
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|u| u.get("id"))
            .and_then(Value::as_i64)
        else {
            return Err(TrackerError::new(
                "gitlab",
                operation,
                "failed",
                format!("GitLab has no user named {a}."),
            ));
        };
        ids.push(id);
    }
    Ok(ids)
}

pub fn create(
    cwd: &str,
    host: &str,
    scope: &str,
    title: &str,
    body: &str,
    labels: &[String],
    assignees: &[String],
) -> Result<IssueCreateResult, TrackerError> {
    let encoded = encode_project(scope);
    let mut payload = json!({ "title": title, "description": body });
    if !labels.is_empty() {
        payload["labels"] = json!(labels.join(","));
    }
    if !assignees.is_empty() {
        payload["assignee_ids"] = json!(resolve_assignee_ids(cwd, host, "create", assignees)?);
    }
    let res = api_json(
        cwd,
        host,
        "create",
        &format!("projects/{encoded}/issues"),
        Some("POST"),
        Some(payload),
    )?;
    let iid = res.get("iid").and_then(Value::as_i64).ok_or_else(|| {
        TrackerError::new("gitlab", "create", "failed", "GitLab returned an unreadable create response.")
    })?;
    let url = trimmed_opt(res.get("web_url")).ok_or_else(|| {
        TrackerError::new("gitlab", "create", "failed", "GitLab returned an unreadable create response.")
    })?;
    Ok(IssueCreateResult {
        key: iid.to_string(),
        display_key: format!("#{iid}"),
        url,
    })
}

pub fn comment(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    body: &str,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "comment")?;
    let path = format!("projects/{}/issues/{number}/notes", encode_project(scope));
    api_raw(
        cwd,
        host,
        "comment",
        &path,
        Some("POST"),
        Some(json!({ "body": body })),
        false,
    )?;
    Ok(())
}

pub fn update(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    title: Option<&str>,
    body: Option<&str>,
    labels: Option<&[String]>,
    assignees: Option<&[String]>,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "update")?;
    let mut patch = serde_json::Map::new();
    if let Some(t) = title {
        patch.insert("title".into(), json!(t));
    }
    if let Some(b) = body {
        patch.insert("description".into(), json!(b));
    }
    if let Some(l) = labels {
        patch.insert("labels".into(), json!(l.join(",")));
    }
    if let Some(a) = assignees {
        patch.insert("assignee_ids".into(), json!(resolve_assignee_ids(cwd, host, "update", a)?));
    }
    let path = format!("projects/{}/issues/{number}", encode_project(scope));
    api_raw(cwd, host, "update", &path, Some("PUT"), Some(Value::Object(patch)), false)?;
    Ok(())
}

pub fn set_state(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    state_name: &str,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "setState")?;
    let event = match state_name {
        "Open" => "reopen",
        "Closed" => "close",
        other => {
            return Err(TrackerError::new(
                "gitlab",
                "setState",
                "failed",
                format!("A GitLab issue has no \"{other}\" state."),
            ));
        }
    };
    let path = format!("projects/{}/issues/{number}", encode_project(scope));
    api_raw(
        cwd,
        host,
        "setState",
        &path,
        Some("PUT"),
        Some(json!({ "state_event": event })),
        false,
    )?;
    Ok(())
}

pub fn set_reaction(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    subject_id: Option<&str>,
    content: &str,
    reacted: bool,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "setReaction")?;
    let Some(award) = award_name(content) else {
        return Err(TrackerError::new("gitlab", "setReaction", "failed", "Unsupported reaction."));
    };
    let encoded = encode_project(scope);
    let subject = match subject_id {
        None => format!("projects/{encoded}/issues/{number}/award_emoji"),
        Some(cid) => {
            let valid = !cid.is_empty()
                && cid.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
                && cid.chars().all(|c| c.is_ascii_digit());
            if !valid {
                return Err(TrackerError::new(
                    "gitlab",
                    "setReaction",
                    "failed",
                    "The comment id names no GitLab note.",
                ));
            }
            format!("projects/{encoded}/issues/{number}/notes/{cid}/award_emoji")
        }
    };
    if reacted {
        let q = url_query(&[("name", award)]);
        api_raw(cwd, host, "setReaction", &format!("{subject}?{q}"), Some("POST"), None, false)?;
        return Ok(());
    }
    let login = get_viewer(cwd, host)?;
    let mut page = 1;
    loop {
        let list = api_json(
            cwd,
            host,
            "setReaction",
            &format!("{subject}?per_page={PAGE_SIZE}&page={page}"),
            None,
            None,
        )?;
        let Some(arr) = list.as_array() else {
            break;
        };
        if arr.is_empty() {
            break;
        }
        if let Some(id) = arr.iter().find_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?;
            let user = item.pointer("/user/username").and_then(Value::as_str)?;
            (reaction_from_award(name) == Some(content) && user.eq_ignore_ascii_case(&login))
                .then(|| item.get("id").and_then(Value::as_i64))
                .flatten()
        }) {
            api_raw(
                cwd,
                host,
                "setReaction",
                &format!("{subject}/{id}"),
                Some("DELETE"),
                None,
                false,
            )?;
            return Ok(());
        }
        page += 1;
    }
    Ok(())
}

pub fn list_templates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let encoded = encode_project(scope);
    let list = api_json(
        cwd,
        host,
        "listTemplates",
        &format!("projects/{encoded}/templates/issues"),
        None,
        None,
    )?;
    let mut templates = Vec::new();
    for entry in list.as_array().into_iter().flatten().take(TEMPLATE_LIMIT) {
        let Some(key) = trimmed_opt(entry.get("key")) else {
            continue;
        };
        let encoded_key =
            percent_encoding::utf8_percent_encode(&key, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        if let Ok(tpl) = api_json(
            cwd,
            host,
            "listTemplates",
            &format!("projects/{encoded}/templates/issues/{encoded_key}"),
            None,
            None,
        ) {
            let name = trimmed_opt(tpl.get("name")).unwrap_or_else(|| key.clone());
            let body = tpl.get("content").and_then(Value::as_str).unwrap_or("");
            templates.push(json!({
                "key": key,
                "name": name,
                "about": "",
                "title": "",
                "body": body,
                "labels": [],
                "assignees": [],
            }));
        }
    }
    Ok(json!({ "templates": templates, "blankIssuesEnabled": true }))
}

pub fn list_candidates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let encoded = encode_project(scope);
    let raw_labels = api_json(
        cwd,
        host,
        "listCandidates",
        &format!("projects/{encoded}/labels?per_page={PAGE_SIZE}&page=1"),
        None,
        None,
    )?;
    let raw_members = api_json(
        cwd,
        host,
        "listCandidates",
        &format!("projects/{encoded}/members/all?per_page={PAGE_SIZE}&page=1"),
        None,
        None,
    )?;
    let labels_arr = raw_labels.as_array().cloned().unwrap_or_default();
    let members_arr = raw_members.as_array().cloned().unwrap_or_default();
    let truncated = labels_arr.len() as i64 >= PAGE_SIZE || members_arr.len() as i64 >= PAGE_SIZE;
    let labels = labels_arr
        .into_iter()
        .filter_map(|l| {
            let name = trimmed_opt(l.get("name"))?;
            let color = trimmed_opt(l.get("color"))
                .map(|c| c.trim_start_matches('#').to_owned())
                .unwrap_or_default();
            Some(json!({
                "name": name,
                "color": color,
                "description": trimmed_opt(l.get("description")),
            }))
        })
        .collect::<Vec<_>>();
    let assignees = members_arr
        .into_iter()
        .filter_map(|m| {
            let mut actor = to_actor(Some(&m));
            let id = m.get("id").and_then(Value::as_i64)?.to_string();
            actor["id"] = json!(id);
            Some(actor)
        })
        .collect::<Vec<_>>();
    Ok(json!({ "labels": labels, "assignees": assignees, "truncated": truncated }))
}
