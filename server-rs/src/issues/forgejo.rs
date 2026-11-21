//! Forgejo / Gitea issue tracker driver via `fj` / `tea` REST API v1.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::OnceLock,
    time::Duration,
};
use url::Url;

use super::{capabilities, IssueCreateResult, ListInput, TrackerError};

pub fn caps() -> Value {
    capabilities(true, true, true, true, true, true, true, true, true, true)
}

const TIMEOUT: Duration = Duration::from_secs(20);
const PAGE_SIZE: i64 = 50;
const MAX_PAGES: i64 = 10;

fn client() -> Result<&'static reqwest::Client, TrackerError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| TrackerError::new("forgejo", "http", "failed", e.clone()))
}

fn find_forgejo_auth(host: &str, cwd: &str) -> Result<(String, String), TrackerError> {
    let host_clean = host.trim().to_ascii_lowercase();
    let scheme = if host_clean.starts_with("localhost") || host_clean.starts_with("127.0.0.1") {
        "http"
    } else {
        "https"
    };
    let base = format!("{scheme}://{host_clean}");
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    if let Some(ref home) = home {
        let candidates = [
            home.join("Library/Application Support/forgejo-cli/keys.json"),
            home.join("Library/Application Support/Cyborus.forgejo-cli/keys.json"),
            home.join(".local/share/forgejo-cli/keys.json"),
        ];
        for path in candidates {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(keys) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(tok) = keys["hosts"][&host_clean]["token"]
                        .as_str()
                        .or_else(|| {
                            keys["hosts"]
                                .as_object()
                                .and_then(|m| {
                                    m.iter().find_map(|(k, v)| {
                                        k.eq_ignore_ascii_case(&host_clean)
                                            .then(|| v["token"].as_str())
                                            .flatten()
                                    })
                                })
                        })
                        .filter(|s| !s.is_empty())
                    {
                        return Ok((base, tok.to_owned()));
                    }
                }
            }
        }
    }
    let mut cmd = Command::new("tea");
    cmd.current_dir(Path::new(cwd))
        .args(["login", "list", "--output", "json"]);
    let output = crate::vcs_worktree::run_command(&mut cmd, TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TrackerError::new(
                "forgejo",
                "auth",
                "missing-tool",
                "Install Forgejo CLI (`fj` or `tea`) and sign in.",
            )
        } else {
            TrackerError::new(
                "forgejo",
                "auth",
                "failed",
                "Forgejo authentication lookup failed.",
            )
        }
    })?;
    if !output.status.success() {
        return Err(TrackerError::new(
            "forgejo",
            "auth",
            "unauthenticated",
            "Forgejo authentication is unavailable. Sign in with `fj auth` or `tea login`.",
        ));
    }
    let logins: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap_or_default();
    for entry in logins {
        let Some(raw_url) = entry.get("url").and_then(Value::as_str) else {
            continue;
        };
        if let Ok(u) = Url::parse(raw_url) {
            let u_host = u.host_str().unwrap_or("").to_ascii_lowercase();
            let u_auth = match u.port() {
                Some(p) => format!("{u_host}:{p}"),
                None => u_host.clone(),
            };
            if u_auth == host_clean || u_host == host_clean {
                if let Some(tok) = entry.get("token").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    return Ok((raw_url.trim_end_matches('/').to_owned(), tok.to_owned()));
                }
            }
        }
    }
    Err(TrackerError::new(
        "forgejo",
        "auth",
        "unauthenticated",
        format!("No Forgejo login configured for {host}."),
    ))
}

async fn api(
    cwd: &str,
    host: &str,
    operation: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<(Value, Option<String>), TrackerError> {
    let (base, token) = find_forgejo_auth(host, cwd)?;
    let url = format!("{base}/api/v1/{}", path.trim_start_matches('/'));
    let mut req = client()?
        .request(method, &url)
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json");
    if let Some(b) = body {
        let body_bytes = serde_json::to_vec(&b).map_err(|_| {
            TrackerError::new("forgejo", operation, "failed", "Invalid request body.")
        })?;
        req = req
            .header("Content-Type", "application/json")
            .body(body_bytes);
    }
    let resp = req.send().await.map_err(|err| {
        TrackerError::new(
            "forgejo",
            operation,
            "failed",
            format!("Forgejo request failed: {err}"),
        )
    })?;
    let status = resp.status();
    let link = resp
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(TrackerError::new(
            "forgejo",
            operation,
            "unauthenticated",
            "Forgejo authentication failed.",
        ));
    }
    if status.as_u16() == 404 {
        return Err(TrackerError::new(
            "forgejo",
            operation,
            "not-found",
            "Forgejo could not find the requested issue.",
        ));
    }
    if status.as_u16() == 429 {
        return Err(TrackerError::new(
            "forgejo",
            operation,
            "rate-limited",
            "Forgejo API rate limit exceeded.",
        ));
    }
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(TrackerError::new(
            "forgejo",
            operation,
            "failed",
            if text.trim().is_empty() {
                format!("Forgejo returned HTTP {}.", status.as_u16())
            } else {
                text
            },
        ));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok((Value::Null, link));
    }
    let val = serde_json::from_str(trimmed).map_err(|_| {
        TrackerError::new(
            "forgejo",
            operation,
            "failed",
            "Forgejo returned an invalid response.",
        )
    })?;
    Ok((val, link))
}

fn repo_path(scope: &str) -> String {
    let segs: Vec<String> = scope
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string())
        .collect();
    format!("repos/{}", segs.join("/"))
}

fn parse_number(key: &str, operation: &str) -> Result<i64, TrackerError> {
    let t = key.trim();
    if !t.is_empty()
        && t.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
        && t.chars().all(|c| c.is_ascii_digit())
    {
        if let Ok(n) = t.parse::<i64>() {
            return Ok(n);
        }
    }
    Err(TrackerError::new(
        "forgejo",
        operation,
        "not-found",
        "Forgejo could not find the requested issue.",
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
                "forgejo",
                operation,
                "failed",
                "The cursor was not one Forgejo handed out.",
            ))
        }
    }
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
    let Some(login) = trimmed_opt(u.get("login")).or_else(|| trimmed_opt(u.get("username"))) else {
        return Value::Null;
    };
    json!({
        "login": login,
        "name": trimmed_opt(u.get("full_name")),
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

fn forgejo_states() -> Value {
    json!([
        { "category": "open", "name": "Open" },
        { "category": "closed", "name": "Closed" }
    ])
}

fn forgejo_reaction_name(content: &str) -> Option<&'static str> {
    match content {
        "thumbs-up" => Some("+1"),
        "thumbs-down" => Some("-1"),
        "laugh" => Some("laugh"),
        "hooray" => Some("hooray"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        "rocket" => Some("rocket"),
        "eyes" => Some("eyes"),
        _ => None,
    }
}

fn content_from_forgejo_reaction(r: &str) -> Option<&'static str> {
    match r {
        "+1" => Some("thumbs-up"),
        "-1" => Some("thumbs-down"),
        "laugh" => Some("laugh"),
        "hooray" => Some("hooray"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        "rocket" => Some("rocket"),
        "eyes" => Some("eyes"),
        _ => None,
    }
}

fn to_reactions(raw: Option<&Value>, viewer: &str) -> Vec<Value> {
    let mut grouped: Vec<(String, i64, Vec<String>, bool)> = Vec::new();
    for item in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(r) = item.get("content").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = content_from_forgejo_reaction(r) else {
            continue;
        };
        let user = item
            .pointer("/user/login")
            .or_else(|| item.pointer("/user/username"))
            .and_then(Value::as_str);
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

fn to_summary(raw: &Value) -> Value {
    let number = raw.get("number").and_then(Value::as_i64).unwrap_or(0);
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
            let name = trimmed_opt(l.get("name"))?;
            let color = trimmed_opt(l.get("color"))
                .map(|c| c.trim_start_matches('#').to_owned());
            Some(json!({ "name": name, "color": color }))
        })
        .collect::<Vec<_>>();
    json!({
        "key": number.to_string(),
        "displayKey": format!("#{number}"),
        "title": raw.get("title").and_then(Value::as_str).unwrap_or(""),
        "url": raw.get("html_url").and_then(Value::as_str).unwrap_or(""),
        "author": to_actor(raw.get("user")),
        "state": to_state(raw.get("state").and_then(Value::as_str)),
        "createdAt": raw.get("created_at").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": raw.get("updated_at").and_then(Value::as_str).unwrap_or(""),
        "closedAt": trimmed_opt(raw.get("closed_at")),
        "assignees": assignees,
        "labels": labels,
        "commentCount": raw.get("comments").and_then(Value::as_i64).unwrap_or(0).max(0),
    })
}

pub async fn get_viewer(cwd: &str, host: &str) -> Result<String, TrackerError> {
    let (data, _) = api(cwd, host, "getViewer", reqwest::Method::GET, "user", None).await?;
    trimmed_opt(data.get("login"))
        .or_else(|| trimmed_opt(data.get("username")))
        .ok_or_else(|| {
            TrackerError::new("forgejo", "getViewer", "failed", "Forgejo returned no login.")
        })
}

pub async fn list_issues(
    cwd: &str,
    host: &str,
    scope: &str,
    involvement: &str,
    viewer: Option<&str>,
    input: &ListInput,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let page = parse_page(input.cursor.as_deref(), "listIssues")?;
    let query_str = {
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        ser.append_pair("type", "issues")
            .append_pair("state", &input.state)
            .append_pair(
                "sort",
                if input.sort == "created" {
                    "latest"
                } else {
                    "recentupdate"
                },
            )
            .append_pair("limit", &PAGE_SIZE.to_string())
            .append_pair("page", &page.to_string());
        if !input.labels.is_empty() {
            ser.append_pair("labels", &input.labels.join(","));
        }
        if let Some(q) = input.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            ser.append_pair("q", q);
        }
        if let Some(v) = viewer {
            match involvement {
                "assigned" => {
                    ser.append_pair("assigned_by", v);
                }
                "authored" => {
                    ser.append_pair("created_by", v);
                }
                "mentioned" => {
                    ser.append_pair("mentioned_by", v);
                }
                _ => {}
            }
        }
        if let Some(a) = input.assignee.as_deref() {
            ser.append_pair("assigned_by", a);
        }
        ser.finish()
    };
    let path = format!("{}/issues?{}", repo_path(scope), query_str);
    let (val, link) = api(cwd, host, "listIssues", reqwest::Method::GET, &path, None).await?;
    let rows = val.as_array().cloned().unwrap_or_default();
    let more = !rows.is_empty()
        && link.is_none_or(|l| l.to_ascii_lowercase().contains("rel=\"next\"") || l.to_ascii_lowercase().contains("rel=next"));
    let mut items: Vec<Value> = rows.iter().map(to_summary).collect();
    if involvement == "assigned" && input.assignee.is_some() {
        if let Some(v) = viewer {
            items.retain(|i| {
                i["assignees"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|u| u["login"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(v))))
            });
        }
    }
    Ok((items, more.then(|| (page + 1).to_string())))
}

async fn comments_page(
    cwd: &str,
    host: &str,
    scope: &str,
    number: i64,
    page: i64,
    viewer: &str,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let path = format!("{}/issues/{number}/comments", repo_path(scope));
    let (val, _) = api(cwd, host, "getComments", reqwest::Method::GET, &path, None).await?;
    let rows = val.as_array().cloned().unwrap_or_default();
    let end = (page * PAGE_SIZE) as usize;
    let start = end.saturating_sub(PAGE_SIZE as usize);
    let mut out = Vec::new();
    for c in rows.get(start..end.min(rows.len())).unwrap_or(&[]) {
        let cid = c.get("id").and_then(Value::as_i64).unwrap_or(0);
        let reactions = api(
            cwd,
            host,
            "getComments",
            reqwest::Method::GET,
            &format!("{}/issues/comments/{cid}/reactions", repo_path(scope)),
            None,
        )
        .await
        .ok()
        .map(|(v, _)| v);
        out.push(json!({
            "id": cid.to_string(),
            "author": to_actor(c.get("user")),
            "body": c.get("body").and_then(Value::as_str).unwrap_or(""),
            "createdAt": c.get("created_at").and_then(Value::as_str).unwrap_or(""),
            "url": trimmed_opt(c.get("html_url")),
            "reactions": to_reactions(reactions.as_ref(), viewer),
        }));
    }
    let next_cursor = (rows.len() > end).then(|| (page + 1).to_string());
    Ok((out, next_cursor))
}

pub async fn get_issue(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
) -> Result<Value, TrackerError> {
    let number = parse_number(key, "getIssue")?;
    let ipath = format!("{}/issues/{number}", repo_path(scope));
    let (issue, _) = api(cwd, host, "getIssue", reqwest::Method::GET, &ipath, None).await?;
    let (repo, _) = api(cwd, host, "getIssue", reqwest::Method::GET, &repo_path(scope), None).await?;
    let viewer = get_viewer(cwd, host).await?;
    let reactions = api(
        cwd,
        host,
        "getIssue",
        reqwest::Method::GET,
        &format!("{ipath}/reactions"),
        None,
    )
    .await
    .ok()
    .map(|(v, _)| v);
    let (timeline_val, _) = api(
        cwd,
        host,
        "getIssue",
        reqwest::Method::GET,
        &format!("{ipath}/timeline?limit={PAGE_SIZE}&page=1"),
        None,
    )
    .await
    .unwrap_or((json!([]), None));
    let (comments, comments_cursor) =
        comments_page(cwd, host, scope, number, 1, &viewer).await?;

    let mut cited = HashMap::<String, (String, i64)>::new();
    let mut events = Vec::new();
    for entry in timeline_val.as_array().into_iter().flatten() {
        let tid = entry.get("id").and_then(Value::as_i64).unwrap_or(0);
        let etype = entry.get("type").and_then(Value::as_str).unwrap_or("");
        let created_at = entry.get("created_at").and_then(Value::as_str).unwrap_or("");
        let actor = to_actor(entry.get("user"));
        if etype == "pull_ref" && entry.pointer("/ref_issue/pull_request").and_then(Value::as_bool) == Some(true) {
            if let Some(pnum) = entry.pointer("/ref_issue/number").and_then(Value::as_i64) {
                let pr_repo = entry
                    .pointer("/ref_issue/repository/full_name")
                    .and_then(Value::as_str)
                    .map(|n| if scope.ends_with(&format!("/{n}")) { scope.to_owned() } else { n.to_owned() })
                    .unwrap_or_else(|| scope.to_owned());
                cited.insert(format!("{pr_repo}#{pnum}"), (pr_repo, pnum));
            }
        }
        let kind = match etype {
            "close" => Some("closed"),
            "reopen" => Some("reopened"),
            "label" => Some("labeled"),
            "unlabel" => Some("unlabeled"),
            "assignees" => Some("assigned"),
            "change_title" => Some("renamed"),
            "pull_ref" | "issue_ref" => Some("referenced"),
            _ => None,
        };
        if let Some(k) = kind {
            events.push(json!({
                "id": tid.to_string(),
                "kind": k,
                "detail": trimmed_opt(entry.get("body")),
                "actor": actor,
                "createdAt": created_at,
            }));
        }
    }

    let mut linked_prs = Vec::new();
    for (pr_repo, pnum) in cited.into_values() {
        if let Ok((pr, _)) = api(
            cwd,
            host,
            "getIssue",
            reqwest::Method::GET,
            &format!("{}/pulls/{pnum}", repo_path(&pr_repo)),
            None,
        )
        .await
        {
            let st = if pr.get("merged").and_then(Value::as_bool) == Some(true) {
                "merged"
            } else if pr.get("state").and_then(Value::as_str) == Some("closed") {
                "closed"
            } else {
                "open"
            };
            linked_prs.push(json!({
                "repository": pr_repo,
                "number": pnum,
                "title": pr.get("title").and_then(Value::as_str).unwrap_or(""),
                "url": pr.get("html_url").and_then(Value::as_str).unwrap_or(""),
                "state": st,
                "isDraft": pr.get("draft").and_then(Value::as_bool).unwrap_or(false),
                "closesIssue": false,
            }));
        }
    }

    let active = repo.get("archived").and_then(Value::as_bool) != Some(true);
    let can_write = repo
        .pointer("/permissions/push")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_author = issue
        .pointer("/user/login")
        .and_then(Value::as_str)
        .is_some_and(|l| l == viewer);
    let can_edit = can_write || is_author;
    let is_locked = issue.get("is_locked").and_then(Value::as_bool) == Some(true);

    let mut summary = to_summary(&issue);
    let obj = summary.as_object_mut().unwrap();
    obj.insert("body".into(), json!(issue.get("body").and_then(Value::as_str).unwrap_or("")));
    obj.insert("viewer".into(), json!(viewer));
    obj.insert(
        "viewerPermissions".into(),
        json!({
            "setState": active && can_edit,
            "comment": active && (!is_locked || can_write),
            "edit": active && can_edit,
            "labels": active && can_write,
            "assignees": active && can_write,
        }),
    );
    obj.insert("states".into(), forgejo_states());
    obj.insert(
        "reactions".into(),
        Value::Array(to_reactions(reactions.as_ref(), &viewer)),
    );
    obj.insert("comments".into(), Value::Array(comments));
    obj.insert("commentsCursor".into(), json!(comments_cursor));
    obj.insert("events".into(), Value::Array(events));
    obj.insert("linkedPullRequests".into(), Value::Array(linked_prs));
    Ok(summary)
}

pub async fn get_comments(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    cursor: &str,
) -> Result<Value, TrackerError> {
    let number = parse_number(key, "getComments")?;
    let page = parse_page(Some(cursor), "getComments")?;
    let viewer = get_viewer(cwd, host).await?;
    let (comments, next_cursor) =
        comments_page(cwd, host, scope, number, page, &viewer).await?;
    Ok(json!({ "comments": comments, "nextCursor": next_cursor }))
}

async fn resolve_label_ids(
    cwd: &str,
    host: &str,
    scope: &str,
    operation: &str,
    names: &[String],
) -> Result<Vec<i64>, TrackerError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut map = HashMap::<String, i64>::new();
    for page in 1..=MAX_PAGES {
        let (val, link) = api(
            cwd,
            host,
            operation,
            reqwest::Method::GET,
            &format!("{}/labels?limit={PAGE_SIZE}&page={page}", repo_path(scope)),
            None,
        )
        .await?;
        let rows = val.as_array().cloned().unwrap_or_default();
        for l in &rows {
            if let (Some(n), Some(id)) = (
                l.get("name").and_then(Value::as_str),
                l.get("id").and_then(Value::as_i64),
            ) {
                map.insert(n.to_owned(), id);
            }
        }
        if names.iter().all(|n| map.contains_key(n))
            || rows.is_empty()
            || link.is_some_and(|l| !l.to_ascii_lowercase().contains("next"))
        {
            break;
        }
    }
    let mut ids = Vec::with_capacity(names.len());
    for n in names {
        let Some(&id) = map.get(n) else {
            return Err(TrackerError::new(
                "forgejo",
                operation,
                "failed",
                "Forgejo found no label by one of the names given.",
            ));
        };
        ids.push(id);
    }
    Ok(ids)
}

pub async fn create(
    cwd: &str,
    host: &str,
    scope: &str,
    title: &str,
    body: &str,
    labels: &[String],
    assignees: &[String],
) -> Result<IssueCreateResult, TrackerError> {
    let label_ids = resolve_label_ids(cwd, host, scope, "create", labels).await?;
    let (issue, _) = api(
        cwd,
        host,
        "create",
        reqwest::Method::POST,
        &format!("{}/issues", repo_path(scope)),
        Some(json!({
            "title": title,
            "body": body,
            "labels": label_ids,
            "assignees": assignees,
        })),
    )
    .await?;
    let num = issue.get("number").and_then(Value::as_i64).unwrap_or(0);
    let url = issue.get("html_url").and_then(Value::as_str).unwrap_or("").to_owned();
    Ok(IssueCreateResult {
        key: num.to_string(),
        display_key: format!("#{num}"),
        url,
    })
}

pub async fn comment(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    body: &str,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "comment")?;
    api(
        cwd,
        host,
        "comment",
        reqwest::Method::POST,
        &format!("{}/issues/{number}/comments", repo_path(scope)),
        Some(json!({ "body": body })),
    )
    .await?;
    Ok(())
}

pub async fn update(
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
    let label_ids = match labels {
        Some(l) => Some(resolve_label_ids(cwd, host, scope, "update", l).await?),
        None => None,
    };
    if title.is_some() || body.is_some() || assignees.is_some() {
        let mut patch = serde_json::Map::new();
        if let Some(t) = title {
            patch.insert("title".into(), json!(t));
        }
        if let Some(b) = body {
            patch.insert("body".into(), json!(b));
        }
        if let Some(a) = assignees {
            patch.insert("assignees".into(), json!(a));
        }
        api(
            cwd,
            host,
            "update",
            reqwest::Method::PATCH,
            &format!("{}/issues/{number}", repo_path(scope)),
            Some(Value::Object(patch)),
        )
        .await?;
    }
    if let Some(ids) = label_ids {
        api(
            cwd,
            host,
            "update",
            reqwest::Method::PUT,
            &format!("{}/issues/{number}/labels", repo_path(scope)),
            Some(json!({ "labels": ids })),
        )
        .await?;
    }
    Ok(())
}

pub async fn set_state(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    state_name: &str,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "setState")?;
    let cat = match state_name {
        "Open" => "open",
        "Closed" => "closed",
        other => {
            return Err(TrackerError::new(
                "forgejo",
                "setState",
                "failed",
                format!("A Forgejo issue has no \"{other}\" state."),
            ));
        }
    };
    api(
        cwd,
        host,
        "setState",
        reqwest::Method::PATCH,
        &format!("{}/issues/{number}", repo_path(scope)),
        Some(json!({ "state": cat })),
    )
    .await?;
    Ok(())
}

pub async fn set_reaction(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    subject_id: Option<&str>,
    content: &str,
    reacted: bool,
) -> Result<(), TrackerError> {
    let number = parse_number(key, "setReaction")?;
    let Some(rname) = forgejo_reaction_name(content) else {
        return Err(TrackerError::new("forgejo", "setReaction", "failed", "Unsupported reaction."));
    };
    let path = match subject_id {
        None => format!("{}/issues/{number}/reactions", repo_path(scope)),
        Some(cid) => {
            let valid = !cid.is_empty()
                && cid.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
                && cid.chars().all(|c| c.is_ascii_digit());
            if !valid {
                return Err(TrackerError::new(
                    "forgejo",
                    "setReaction",
                    "failed",
                    "The comment id names no Forgejo comment.",
                ));
            }
            format!("{}/issues/comments/{cid}/reactions", repo_path(scope))
        }
    };
    let method = if reacted {
        reqwest::Method::POST
    } else {
        reqwest::Method::DELETE
    };
    api(cwd, host, "setReaction", method, &path, Some(json!({ "content": rname }))).await?;
    Ok(())
}

pub async fn list_templates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let (raw_tpl, _) = api(
        cwd,
        host,
        "listTemplates",
        reqwest::Method::GET,
        &format!("{}/issue_templates", repo_path(scope)),
        None,
    )
    .await
    .unwrap_or((json!([]), None));
    let blank_issues_enabled = api(
        cwd,
        host,
        "listTemplates",
        reqwest::Method::GET,
        &format!("{}/issue_config", repo_path(scope)),
        None,
    )
    .await
    .ok()
    .and_then(|(v, _)| v.get("blank_issues_enabled").and_then(Value::as_bool))
    .unwrap_or(true);
    let templates = raw_tpl
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let name = trimmed_opt(t.get("name"))?;
            let key = trimmed_opt(t.get("file_name")).unwrap_or_else(|| name.clone());
            Some(json!({
                "key": key,
                "name": name,
                "about": t.get("about").and_then(Value::as_str).unwrap_or(""),
                "title": t.get("title").and_then(Value::as_str).unwrap_or(""),
                "body": t.get("content").and_then(Value::as_str).unwrap_or(""),
                "labels": t.get("labels").cloned().unwrap_or_else(|| json!([])),
                "assignees": [],
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({ "templates": templates, "blankIssuesEnabled": blank_issues_enabled }))
}

pub async fn list_candidates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let (labels_val, l_link) = api(
        cwd,
        host,
        "listCandidates",
        reqwest::Method::GET,
        &format!("{}/labels?limit={PAGE_SIZE}&page=1", repo_path(scope)),
        None,
    )
    .await?;
    let (assignees_val, a_link) = api(
        cwd,
        host,
        "listCandidates",
        reqwest::Method::GET,
        &format!("{}/assignees?limit={PAGE_SIZE}&page=1", repo_path(scope)),
        None,
    )
    .await?;
    let labels = labels_val
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let name = trimmed_opt(l.get("name"))?;
            let color = trimmed_opt(l.get("color")).map(|c| c.trim_start_matches('#').to_owned());
            Some(json!({
                "name": name,
                "color": color,
                "description": trimmed_opt(l.get("description")),
            }))
        })
        .collect::<Vec<_>>();
    let assignees = assignees_val
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let mut actor = to_actor(Some(u));
            let login = actor.get("login")?.as_str()?.to_owned();
            actor["id"] = json!(login);
            Some(actor)
        })
        .collect::<Vec<_>>();
    let has_next = |l: Option<String>| {
        l.is_some_and(|s| s.to_ascii_lowercase().contains("rel=\"next\"") || s.to_ascii_lowercase().contains("rel=next"))
    };
    let truncated = (!labels.is_empty() && has_next(l_link)) || (!assignees.is_empty() && has_next(a_link));
    Ok(json!({ "labels": labels, "assignees": assignees, "truncated": truncated }))
}
