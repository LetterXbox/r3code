//! Azure DevOps work items as an issue tracker, over `az devops` / `az boards`.
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    process::Command,
    time::Duration,
};
use uuid::Uuid;

use crate::github_pinned_credential::{self, CommandFailure};

use super::{capabilities, IssueCreateResult, ListInput, TrackerError};

pub fn caps() -> Value {
    capabilities(true, true, true, true, true, true, false, true, true, true)
}

const TIMEOUT: Duration = Duration::from_secs(25);
const REST_API_VERSION: &str = "7.1";
const PAGE_SIZE: i64 = 100;
const UPDATE_PAGE_LIMIT: usize = 5;
const LINKED_PR_LIMIT: usize = 10;
const CREATE_TYPES: &[&str] = &["Issue", "Bug", "Task", "User Story", "Product Backlog Item"];
const LIST_FIELDS: &[&str] = &[
    "System.Id",
    "System.Title",
    "System.State",
    "System.CreatedDate",
    "System.ChangedDate",
    "System.CreatedBy",
    "System.AssignedTo",
    "System.CommentCount",
    "System.Tags",
    "System.TeamProject",
    "Microsoft.VSTS.Common.ClosedDate",
];

fn map_failure(operation: &str, failure: CommandFailure) -> TrackerError {
    let reason = match failure {
        CommandFailure::Spawn(std::io::ErrorKind::NotFound) => "missing-tool",
        CommandFailure::Unauthenticated => "unauthenticated",
        CommandFailure::RateLimited => "rate-limited",
        CommandFailure::NotFound => "not-found",
        CommandFailure::Spawn(_) | CommandFailure::Failed => "failed",
    };
    let detail = match reason {
        "missing-tool" => "Azure CLI (`az`) is not installed.",
        "unauthenticated" => "Run `az login` to authenticate Azure CLI.",
        "rate-limited" => "Azure DevOps API rate limit exceeded.",
        "not-found" => "Azure DevOps could not find the requested work item.",
        _ => "The Azure DevOps work item request failed.",
    };
    TrackerError::new("azure-devops", operation, reason, detail)
}

fn parse_scope(host: &str, scope: &str, operation: &str) -> Result<(String, String), TrackerError> {
    let parts: Vec<&str> = scope
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.iter().any(|p| p.starts_with('@')) {
        return Err(TrackerError::new(
            "azure-devops",
            operation,
            "failed",
            "An Azure DevOps scope is named `organization/project`.",
        ));
    }
    if host.to_ascii_lowercase().ends_with(".visualstudio.com") {
        let project = if parts.len() == 1 || parts.len() == 2 {
            parts.last().copied()
        } else {
            None
        };
        return match project {
            Some(p) => Ok((format!("https://{host}"), p.to_owned())),
            None => Err(TrackerError::new(
                "azure-devops",
                operation,
                "failed",
                "An Azure DevOps scope is named `organization/project`.",
            )),
        };
    }
    if parts.len() != 2 {
        return Err(TrackerError::new(
            "azure-devops",
            operation,
            "failed",
            "An Azure DevOps scope is named `organization/project`.",
        ));
    }
    let org = percent_encoding::utf8_percent_encode(parts[0], percent_encoding::NON_ALPHANUMERIC);
    Ok((format!("https://{host}/{org}"), parts[1].to_owned()))
}

fn parse_number(key: &str, operation: &str) -> Result<i64, TrackerError> {
    let t = key.trim();
    if !t.is_empty()
        && t.len() <= 10
        && t.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
        && t.chars().all(|c| c.is_ascii_digit())
    {
        if let Ok(n) = t.parse::<i64>() {
            return Ok(n);
        }
    }
    Err(TrackerError::new(
        "azure-devops",
        operation,
        "not-found",
        "Azure DevOps could not find the requested work item.",
    ))
}

fn wiql_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn run_az(cwd: &str, operation: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<Value, TrackerError> {
    let mut cmd = Command::new("az");
    cmd.args(args)
        .args(["--only-show-errors", "--output", "json"])
        .current_dir(cwd);
    let bytes = match stdin {
        Some(bytes) => {
            github_pinned_credential::run_classified_with_input(&mut cmd, TIMEOUT, bytes.to_vec())
        }
        None => github_pinned_credential::run_classified(&mut cmd, TIMEOUT),
    }
    .map_err(|f| map_failure(operation, f))?;
    let trimmed = String::from_utf8_lossy(&bytes);
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|_| {
        TrackerError::new(
            "azure-devops",
            operation,
            "failed",
            format!("Azure DevOps returned an unreadable {operation} response."),
        )
    })
}

fn invoke_wit(
    cwd: &str,
    operation: &str,
    organization: &str,
    project: &str,
    resource: &str,
    route: &[&str],
    query: &[&str],
    method: Option<&str>,
    api_version: Option<&str>,
    body: Option<&Value>,
) -> Result<Value, TrackerError> {
    let proj_arg = format!("project={project}");
    let mut args: Vec<String> = vec![
        "devops".into(),
        "invoke".into(),
        "--detect".into(),
        "false".into(),
        "--organization".into(),
        organization.into(),
        "--area".into(),
        "wit".into(),
        "--resource".into(),
        resource.into(),
        "--api-version".into(),
        api_version.unwrap_or(REST_API_VERSION).into(),
        "--route-parameters".into(),
        proj_arg,
    ];
    for r in route {
        args.push((*r).to_owned());
    }
    if !query.is_empty() {
        args.push("--query-parameters".into());
        for q in query {
            args.push((*q).to_owned());
        }
    }
    if let Some(m) = method {
        args.push("--http-method".into());
        args.push(m.into());
    }
    let _temp_guard = if let Some(payload) = body {
        let path = std::env::temp_dir().join(format!("t3-azure-issue-{}.json", Uuid::new_v4()));
        let bytes = serde_json::to_vec(payload).map_err(|_| {
            TrackerError::new("azure-devops", operation, "failed", "Invalid Azure payload.")
        })?;
        std::fs::write(&path, bytes).map_err(|_| {
            TrackerError::new(
                "azure-devops",
                operation,
                "failed",
                "Could not write the Azure DevOps request body.",
            )
        })?;
        args.push("--in-file".into());
        args.push(path.to_string_lossy().into_owned());
        args.push("--media-type".into());
        args.push("application/json".into());
        Some(path)
    } else {
        None
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let res = run_az(cwd, operation, &arg_refs, None);
    if let Some(path) = _temp_guard {
        let _ = std::fs::remove_file(path);
    }
    res
}

fn trimmed_opt(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn identity_actor(raw: Option<&Value>) -> Value {
    let Some(u) = raw.filter(|v| !v.is_null()) else {
        return Value::Null;
    };
    let login = trimmed_opt(u.get("uniqueName")).or_else(|| trimmed_opt(u.get("displayName")));
    let Some(login) = login else {
        return Value::Null;
    };
    json!({
        "login": login,
        "name": trimmed_opt(u.get("displayName")),
        "avatarUrl": trimmed_opt(u.get("imageUrl")),
    })
}

fn state_for(name: &str, closed: &BTreeSet<String>) -> Value {
    let category = if closed.contains(name) { "closed" } else { "open" };
    json!({ "category": category, "name": name })
}

fn load_work_item_types(
    cwd: &str,
    organization: &str,
    project: &str,
    operation: &str,
) -> Result<(Vec<Value>, BTreeSet<String>), TrackerError> {
    let res = invoke_wit(
        cwd,
        operation,
        organization,
        project,
        "workitemtypes",
        &[],
        &[],
        None,
        None,
        None,
    )?;
    let types = res.get("value").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut closed = BTreeSet::new();
    for t in &types {
        for s in t.get("states").and_then(Value::as_array).into_iter().flatten() {
            let cat = s.get("category").and_then(Value::as_str).unwrap_or("");
            if matches!(cat, "Completed" | "Removed") {
                if let Some(name) = s.get("name").and_then(Value::as_str) {
                    closed.insert(name.to_owned());
                }
            }
        }
    }
    Ok((types, closed))
}

fn work_item_to_summary(
    raw: &Value,
    organization: &str,
    project: &str,
    closed: &BTreeSet<String>,
) -> Value {
    let fields = &raw["fields"];
    let id = raw
        .get("id")
        .or_else(|| fields.get("System.Id"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let state_name = fields
        .get("System.State")
        .and_then(Value::as_str)
        .unwrap_or("New");
    let proj_seg = percent_encoding::utf8_percent_encode(project, percent_encoding::NON_ALPHANUMERIC);
    let url = trimmed_opt(raw.pointer("/_links/html/href")).unwrap_or_else(|| {
        format!(
            "{}/{}/_workitems/edit/{id}",
            organization.trim_end_matches('/'),
            proj_seg
        )
    });
    let assignees = match identity_actor(fields.get("System.AssignedTo")) {
        Value::Null => Vec::new(),
        v => vec![v],
    };
    let labels = fields
        .get("System.Tags")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|name| json!({ "name": name, "color": Value::Null }))
        .collect::<Vec<_>>();
    json!({
        "key": id.to_string(),
        "displayKey": format!("#{id}"),
        "title": fields.get("System.Title").and_then(Value::as_str).unwrap_or(""),
        "url": url,
        "author": identity_actor(fields.get("System.CreatedBy")),
        "state": state_for(state_name, closed),
        "createdAt": fields.get("System.CreatedDate").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": fields.get("System.ChangedDate").and_then(Value::as_str).unwrap_or(""),
        "closedAt": trimmed_opt(fields.get("Microsoft.VSTS.Common.ClosedDate")),
        "assignees": assignees,
        "labels": labels,
        "commentCount": fields.get("System.CommentCount").and_then(Value::as_i64).unwrap_or(0).max(0),
    })
}

pub fn get_viewer() -> String {
    "@Me".to_owned()
}

pub fn list_issues(
    cwd: &str,
    host: &str,
    scope: &str,
    involvement: &str,
    input: &ListInput,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let (organization, project) = parse_scope(host, scope, "listIssues")?;
    let limit = input.limit.clamp(1, PAGE_SIZE);
    let cursor = match input.cursor.as_deref() {
        None => None,
        Some(c) => {
            let Some((date, id_str)) = c.split_once('|') else {
                return Err(TrackerError::new(
                    "azure-devops",
                    "listIssues",
                    "failed",
                    "The cursor was not one Azure DevOps handed out.",
                ));
            };
            let Ok(id) = id_str.parse::<i64>() else {
                return Err(TrackerError::new(
                    "azure-devops",
                    "listIssues",
                    "failed",
                    "The cursor was not one Azure DevOps handed out.",
                ));
            };
            Some((date.to_owned(), id))
        }
    };
    let (_, closed) = load_work_item_types(cwd, &organization, &project, "listIssues")?;
    let created = input.sort == "created";
    let date_field = if created {
        "[System.CreatedDate]"
    } else {
        "[System.ChangedDate]"
    };
    let mut wiql = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = {}",
        wiql_quote(&project)
    );
    if input.state != "all" && !closed.is_empty() {
        let closed_list = closed
            .iter()
            .map(|s| wiql_quote(s))
            .collect::<Vec<_>>()
            .join(", ");
        if input.state == "open" {
            wiql.push_str(&format!(" AND [System.State] NOT IN ({closed_list})"));
        } else {
            wiql.push_str(&format!(" AND [System.State] IN ({closed_list})"));
        }
    }
    match involvement {
        "assigned" => wiql.push_str(" AND [System.AssignedTo] = @Me"),
        "authored" => wiql.push_str(" AND [System.CreatedBy] = @Me"),
        _ => {}
    }
    if let Some(q) = input.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        wiql.push_str(&format!(" AND [System.Title] CONTAINS {}", wiql_quote(q)));
    }
    for l in &input.labels {
        wiql.push_str(&format!(" AND [System.Tags] CONTAINS {}", wiql_quote(l)));
    }
    if let Some(a) = input.assignee.as_deref() {
        wiql.push_str(&format!(" AND [System.AssignedTo] = {}", wiql_quote(a)));
    }
    if let Some((c_date, c_id)) = cursor {
        wiql.push_str(&format!(
            " AND ({date_field} < {} OR ({date_field} = {} AND [System.Id] < {c_id}))",
            wiql_quote(&c_date),
            wiql_quote(&c_date)
        ));
    }
    wiql.push_str(&format!(" ORDER BY {date_field} DESC, [System.Id] DESC"));
    let top_arg = format!("$top={}", limit + 1);
    let wiql_res = invoke_wit(
        cwd,
        "listIssues",
        &organization,
        &project,
        "wiql",
        &[],
        &["timePrecision=true", &top_arg],
        Some("POST"),
        None,
        Some(&json!({ "query": wiql })),
    )?;
    let ids: Vec<i64> = wiql_res
        .get("workItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| w.get("id").and_then(Value::as_i64))
        .collect();
    if ids.is_empty() {
        return Ok((Vec::new(), None));
    }
    let slice: Vec<i64> = ids.iter().take(limit as usize).copied().collect();
    let batch = invoke_wit(
        cwd,
        "listIssues",
        &organization,
        &project,
        "workitemsbatch",
        &[],
        &[],
        Some("POST"),
        None,
        Some(&json!({ "ids": slice, "fields": LIST_FIELDS })),
    )?;
    let rows = batch.get("value").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut by_id: HashMap<i64, Value> = HashMap::new();
    for r in &rows {
        let sum = work_item_to_summary(r, &organization, &project, &closed);
        if let Some(id) = r.get("id").and_then(Value::as_i64) {
            by_id.insert(id, sum);
        }
    }
    let ordered: Vec<Value> = slice.iter().filter_map(|id| by_id.remove(id)).collect();
    let next_cursor = if ids.len() > limit as usize {
        ordered.last().map(|last| {
            let dt = if created {
                last["createdAt"].as_str().unwrap_or("")
            } else {
                last["updatedAt"].as_str().unwrap_or("")
            };
            format!("{dt}|{}", last["key"].as_str().unwrap_or(""))
        })
    } else {
        None
    };
    Ok((ordered, next_cursor))
}

fn reaction_to_ado(content: &str) -> Option<&'static str> {
    match content {
        "thumbs-up" => Some("like"),
        "thumbs-down" => Some("dislike"),
        "laugh" => Some("laugh"),
        "hooray" => Some("hooray"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        _ => None,
    }
}

fn reaction_from_ado(kind: &str) -> Option<&'static str> {
    match kind {
        "like" => Some("thumbs-up"),
        "dislike" => Some("thumbs-down"),
        "laugh" => Some("laugh"),
        "hooray" => Some("hooray"),
        "confused" => Some("confused"),
        "heart" => Some("heart"),
        _ => None,
    }
}

fn fetch_work_item(
    cwd: &str,
    organization: &str,
    project: &str,
    id: i64,
    operation: &str,
) -> Result<Value, TrackerError> {
    let route = format!("id={id}");
    let item = invoke_wit(
        cwd,
        operation,
        organization,
        project,
        "workitems",
        &[&route],
        &["$expand=relations"],
        None,
        None,
        None,
    )?;
    if item.pointer("/fields/System.TeamProject").and_then(Value::as_str) != Some(project) {
        return Err(TrackerError::new(
            "azure-devops",
            operation,
            "not-found",
            "Azure DevOps could not find the requested work item.",
        ));
    }
    Ok(item)
}

fn fetch_comments(
    cwd: &str,
    organization: &str,
    project: &str,
    id: i64,
    cursor: Option<&str>,
    operation: &str,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let route = format!("workItemId={id}");
    let top_q = format!("$top={PAGE_SIZE}");
    let cont_q = cursor.map(|c| format!("continuationToken={c}"));
    let mut query = vec![
        top_q.as_str(),
        "order=desc",
        "$expand=reactions",
        "api-version=7.1-preview.4",
    ];
    if let Some(ref cq) = cont_q {
        query.push(cq.as_str());
    }
    let res = invoke_wit(
        cwd,
        operation,
        organization,
        project,
        "comments",
        &[&route],
        &query,
        None,
        Some("7.1-preview"),
        None,
    )?;
    let mut comments = res
        .get("comments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| {
            let reactions = c
                .get("reactions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    let kind = r.get("type").and_then(Value::as_str)?;
                    let content = reaction_from_ado(kind)?;
                    Some(json!({
                        "content": content,
                        "count": r.get("count").and_then(Value::as_i64).unwrap_or(0),
                        "actors": [],
                        "viewerHasReacted": r.get("isCurrentUserEngaged").and_then(Value::as_bool).unwrap_or(false),
                    }))
                })
                .collect::<Vec<_>>();
            json!({
                "id": c.get("id").and_then(Value::as_i64).unwrap_or(0).to_string(),
                "author": identity_actor(c.get("createdBy")),
                "body": c.get("text").and_then(Value::as_str).unwrap_or(""),
                "createdAt": c.get("createdDate").and_then(Value::as_str).unwrap_or(""),
                "url": trimmed_opt(c.get("url")),
                "reactions": reactions,
            })
        })
        .collect::<Vec<_>>();
    comments.reverse();
    let next = trimmed_opt(res.get("continuationToken"));
    Ok((comments, next))
}

pub fn get_issue(cwd: &str, host: &str, scope: &str, key: &str) -> Result<Value, TrackerError> {
    let (organization, project) = parse_scope(host, scope, "getIssue")?;
    let id = parse_number(key, "getIssue")?;
    let (types, closed) = load_work_item_types(cwd, &organization, &project, "getIssue")?;
    let item = fetch_work_item(cwd, &organization, &project, id, "getIssue")?;
    let fields = &item["fields"];
    let wi_type = fields.get("System.WorkItemType").and_then(Value::as_str).unwrap_or("");
    let body = trimmed_opt(fields.get("Microsoft.VSTS.TCM.ReproSteps"))
        .or_else(|| trimmed_opt(fields.get("System.Description")))
        .unwrap_or_default();
    let states = types
        .iter()
        .find(|t| t.get("name").and_then(Value::as_str) == Some(wi_type))
        .and_then(|t| t.get("states"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let name = trimmed_opt(s.get("name"))?;
            let cat = if matches!(
                s.get("category").and_then(Value::as_str).unwrap_or(""),
                "Completed" | "Removed"
            ) {
                "closed"
            } else {
                "open"
            };
            Some(json!({ "category": cat, "name": name }))
        })
        .collect::<Vec<_>>();
    let (comments, comments_cursor) =
        fetch_comments(cwd, &organization, &project, id, None, "getIssue")?;
    let mut events = Vec::new();
    let route = format!("id={id}");
    for page in 0..UPDATE_PAGE_LIMIT {
        let top_q = format!("$top={PAGE_SIZE}");
        let skip_q = format!("$skip={}", page as i64 * PAGE_SIZE);
        let q = if page == 0 {
            vec![top_q.as_str()]
        } else {
            vec![top_q.as_str(), skip_q.as_str()]
        };
        let Ok(upd) = invoke_wit(cwd, "getIssue", &organization, &project, "updates", &[&route], &q, None, None, None) else {
            break;
        };
        let arr = upd.get("value").and_then(Value::as_array).cloned().unwrap_or_default();
        for u in &arr {
            let uid = u.get("id").and_then(Value::as_i64).unwrap_or(0);
            let revised_at = trimmed_opt(u.get("revisedDate"))
                .or_else(|| trimmed_opt(u.pointer("/fields/System.ChangedDate/newValue")))
                .unwrap_or_default();
            let actor = identity_actor(u.get("revisedBy"));
            if let Some(new_state) = trimmed_opt(u.pointer("/fields/System.State/newValue")) {
                let kind = if closed.contains(&new_state) { "closed" } else { "state-changed" };
                events.push(json!({
                    "id": format!("{uid}:state"),
                    "kind": kind,
                    "detail": new_state,
                    "actor": actor,
                    "createdAt": revised_at,
                }));
            }
            if let Some(new_title) = trimmed_opt(u.pointer("/fields/System.Title/newValue")) {
                events.push(json!({
                    "id": format!("{uid}:title"),
                    "kind": "renamed",
                    "detail": new_title,
                    "actor": actor,
                    "createdAt": revised_at,
                }));
            }
        }
        if (arr.len() as i64) < PAGE_SIZE {
            break;
        }
    }
    let mut pr_numbers = BTreeSet::new();
    for rel in item.get("relations").and_then(Value::as_array).into_iter().flatten() {
        if rel.get("rel").and_then(Value::as_str) == Some("ArtifactLink") {
            if let Some(url) = rel.get("url").and_then(Value::as_str) {
                if let Some(idx) = url.rfind("PullRequestId/") {
                    if let Some(num) = url[idx + 14..].split(&['%', '/'][..]).next().and_then(|s| s.parse::<i64>().ok()) {
                        pr_numbers.insert(num);
                    }
                }
            }
        }
    }
    let mut linked_prs = Vec::new();
    for pr_id in pr_numbers.into_iter().take(LINKED_PR_LIMIT) {
        let id_str = pr_id.to_string();
        if let Ok(pr) = run_az(
            cwd,
            "getIssue",
            &["repos", "pr", "show", "--detect", "false", "--organization", &organization, "--id", &id_str],
            None,
        ) {
            let repo = pr.pointer("/repository/name").and_then(Value::as_str).unwrap_or(&project);
            let title = pr.get("title").and_then(Value::as_str).unwrap_or("");
            let st = match pr.get("status").and_then(Value::as_str).unwrap_or("") {
                "completed" => "merged",
                "abandoned" => "closed",
                _ => "open",
            };
            let draft = pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false);
            let url = format!("{}/{}/_git/{}/pullrequest/{pr_id}", organization.trim_end_matches('/'), project, repo);
            linked_prs.push(json!({
                "repository": format!("{project}/{repo}"),
                "number": pr_id,
                "title": title,
                "url": url,
                "state": st,
                "isDraft": draft,
                "closesIssue": true,
            }));
        }
    }
    let mut summary = work_item_to_summary(&item, &organization, &project, &closed);
    let obj = summary.as_object_mut().unwrap();
    obj.insert("body".into(), json!(body));
    obj.insert("viewer".into(), Value::Null);
    obj.insert(
        "viewerPermissions".into(),
        json!({ "setState": true, "comment": true, "edit": true, "labels": true, "assignees": true }),
    );
    obj.insert("states".into(), Value::Array(states));
    obj.insert("comments".into(), Value::Array(comments));
    obj.insert("commentsCursor".into(), json!(comments_cursor));
    obj.insert("events".into(), Value::Array(events));
    obj.insert("linkedPullRequests".into(), Value::Array(linked_prs));
    Ok(summary)
}

pub fn get_comments(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    cursor: &str,
) -> Result<Value, TrackerError> {
    if cursor.trim().starts_with('@') {
        return Err(TrackerError::new(
            "azure-devops",
            "getComments",
            "failed",
            "The cursor was not one Azure DevOps handed out.",
        ));
    }
    let (organization, project) = parse_scope(host, scope, "getComments")?;
    let id = parse_number(key, "getComments")?;
    let (comments, next_cursor) =
        fetch_comments(cwd, &organization, &project, id, Some(cursor), "getComments")?;
    Ok(json!({ "comments": comments, "nextCursor": next_cursor }))
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
    let (organization, project) = parse_scope(host, scope, "create")?;
    let (types, closed) = load_work_item_types(cwd, &organization, &project, "create")?;
    let enabled: Vec<&str> = types
        .iter()
        .filter(|t| t.get("isDisabled").and_then(Value::as_bool) != Some(true))
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .collect();
    let wi_type = CREATE_TYPES
        .iter()
        .copied()
        .find(|c| enabled.contains(c))
        .or_else(|| enabled.first().copied())
        .ok_or_else(|| {
            TrackerError::new(
                "azure-devops",
                "create",
                "failed",
                "The project offers no work item type to file.",
            )
        })?;
    let mut args = vec![
        "boards".to_owned(),
        "work-item".to_owned(),
        "create".to_owned(),
        "--detect".to_owned(),
        "false".to_owned(),
        "--organization".to_owned(),
        organization.clone(),
        "--project".to_owned(),
        project.clone(),
        "--type".to_owned(),
        wi_type.to_owned(),
        "--title".to_owned(),
        title.to_owned(),
    ];
    if !body.is_empty() {
        args.push("--description".into());
        args.push(body.to_owned());
    }
    if let Some(a) = assignees.first() {
        args.push("--assigned-to".into());
        args.push(a.to_owned());
    }
    if !labels.is_empty() {
        args.push("--fields".into());
        args.push(format!("System.Tags={}", labels.join("; ")));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let created = run_az(cwd, "create", &refs, None)?;
    let sum = work_item_to_summary(&created, &organization, &project, &closed);
    Ok(IssueCreateResult {
        key: sum["key"].as_str().unwrap_or("").to_owned(),
        display_key: sum["displayKey"].as_str().unwrap_or("").to_owned(),
        url: sum["url"].as_str().unwrap_or("").to_owned(),
    })
}

pub fn comment(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    body: &str,
) -> Result<(), TrackerError> {
    let (organization, project) = parse_scope(host, scope, "comment")?;
    let id = parse_number(key, "comment")?;
    let route = format!("workItemId={id}");
    invoke_wit(
        cwd,
        "comment",
        &organization,
        &project,
        "comments",
        &[&route],
        &["format=markdown", "api-version=7.1-preview.4"],
        Some("POST"),
        Some("7.1-preview"),
        Some(&json!({ "text": body })),
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
    let (organization, project) = parse_scope(host, scope, "update")?;
    let id = parse_number(key, "update")?;
    let item = fetch_work_item(cwd, &organization, &project, id, "update")?;
    let body_field = if item.pointer("/fields/Microsoft.VSTS.TCM.ReproSteps").is_some()
        || item.pointer("/fields/System.WorkItemType").and_then(Value::as_str) == Some("Bug")
    {
        "Microsoft.VSTS.TCM.ReproSteps"
    } else {
        "System.Description"
    };
    let id_str = id.to_string();
    let mut args = vec![
        "boards".to_owned(),
        "work-item".to_owned(),
        "update".to_owned(),
        "--detect".to_owned(),
        "false".to_owned(),
        "--organization".to_owned(),
        organization.clone(),
        "--id".to_owned(),
        id_str,
    ];
    if let Some(t) = title {
        args.push("--title".into());
        args.push(t.to_owned());
    }
    let mut fields_pairs = Vec::new();
    if let Some(b) = body {
        if body_field == "System.Description" {
            args.push("--description".into());
            args.push(b.to_owned());
        } else {
            fields_pairs.push(format!("{body_field}={b}"));
        }
    }
    if let Some(l) = labels {
        fields_pairs.push(format!("System.Tags={}", l.join("; ")));
    }
    if let Some(a) = assignees {
        args.push("--assigned-to".into());
        args.push(a.first().cloned().unwrap_or_default());
    }
    if !fields_pairs.is_empty() {
        args.push("--fields".into());
        args.extend(fields_pairs);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_az(cwd, "update", &refs, None)?;
    Ok(())
}

pub fn set_state(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    state_name: &str,
) -> Result<(), TrackerError> {
    let (organization, project) = parse_scope(host, scope, "setState")?;
    let id = parse_number(key, "setState")?;
    let item = fetch_work_item(cwd, &organization, &project, id, "setState")?;
    let wi_type = item
        .pointer("/fields/System.WorkItemType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (types, _) = load_work_item_types(cwd, &organization, &project, "setState")?;
    let valid = types
        .iter()
        .find(|t| t.get("name").and_then(Value::as_str) == Some(wi_type))
        .and_then(|t| t.get("states"))
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter()
                .any(|s| s.get("name").and_then(Value::as_str) == Some(state_name))
        });
    if !valid {
        return Err(TrackerError::new(
            "azure-devops",
            "setState",
            "failed",
            format!("This work item has no \"{state_name}\" state."),
        ));
    }
    let id_str = id.to_string();
    run_az(
        cwd,
        "setState",
        &[
            "boards",
            "work-item",
            "update",
            "--detect",
            "false",
            "--organization",
            &organization,
            "--id",
            &id_str,
            "--state",
            state_name,
        ],
        None,
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
    let (organization, project) = parse_scope(host, scope, "setReaction")?;
    let id = parse_number(key, "setReaction")?;
    let Some(cid) = subject_id else {
        return Err(TrackerError::new(
            "azure-devops",
            "setReaction",
            "failed",
            "Azure DevOps reactions go on comments only.",
        ));
    };
    let comment_id = parse_number(cid, "setReaction").map_err(|_| {
        TrackerError::new(
            "azure-devops",
            "setReaction",
            "failed",
            "The comment id names no Azure DevOps comment.",
        )
    })?;
    let Some(reaction_type) = reaction_to_ado(content) else {
        return Err(TrackerError::new(
            "azure-devops",
            "setReaction",
            "failed",
            "Azure DevOps has no such reaction.",
        ));
    };
    let r1 = format!("workItemId={id}");
    let r2 = format!("commentId={comment_id}");
    let r3 = format!("reactionType={reaction_type}");
    let method = if reacted { "PUT" } else { "DELETE" };
    invoke_wit(
        cwd,
        "setReaction",
        &organization,
        &project,
        "commentsReactions",
        &[&r1, &r2, &r3],
        &["api-version=7.1-preview.1"],
        Some(method),
        Some("7.1-preview"),
        None,
    )?;
    Ok(())
}

pub fn list_candidates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let (organization, project) = parse_scope(host, scope, "listCandidates")?;
    let tags_res = invoke_wit(cwd, "listCandidates", &organization, &project, "tags", &[], &[], None, None, None)
        .unwrap_or_else(|_| json!({ "value": [] }));
    let labels = tags_res
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let name = trimmed_opt(t.get("name"))?;
            Some(json!({ "name": name, "color": Value::Null, "description": Value::Null }))
        })
        .collect::<Vec<_>>();
    let teams = run_az(
        cwd,
        "listCandidates",
        &["devops", "team", "list", "--detect", "false", "--organization", &organization, "--project", &project],
        None,
    )
    .unwrap_or_else(|_| json!([]));
    let mut assignees_map = HashMap::<String, Value>::new();
    for team in teams.as_array().into_iter().flatten().take(10) {
        let Some(team_id) = team.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Ok(Value::Array(members)) = run_az(
            cwd,
            "listCandidates",
            &["devops", "team", "list-member", "--detect", "false", "--organization", &organization, "--project", &project, "--team", team_id],
            None,
        ) {
            for m in members {
                if m.pointer("/identity/isContainer").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let mut actor = identity_actor(m.get("identity"));
                if let Some(login) = actor.get("login").and_then(Value::as_str).map(str::to_owned) {
                    actor["id"] = json!(login);
                    assignees_map.entry(login.to_ascii_lowercase()).or_insert(actor);
                }
            }
        }
    }
    Ok(json!({
        "labels": labels,
        "assignees": assignees_map.into_values().collect::<Vec<_>>(),
        "truncated": false,
    }))
}
