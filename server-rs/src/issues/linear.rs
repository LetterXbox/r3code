//! Linear issue tracker GraphQL driver.
use reqwest::header::HeaderMap;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::OnceLock, time::Duration};
use url::Url;

use super::{capabilities, IssueCreateResult, ListInput, TrackerError};

pub const LINEAR_HOST: &str = "linear.app";
const DEFAULT_API_URL: &str = "https://api.linear.app/graphql";
const COMMENTS_PAGE: i64 = 50;
const CLOSED_STATE_TYPES: &[&str] = &["completed", "canceled", "duplicate"];
const STATE_TYPE_ORDER: &[&str] = &[
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
];

pub fn caps() -> Value {
    capabilities(true, true, true, true, true, true, true, true, true, true)
}

#[derive(Clone, Debug)]
pub struct ProbeResult {
    pub account: String,
    pub workspace: Option<String>,
    pub scopes: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedLinearIssueUrl {
    pub host: String,
    pub workspace: String,
    pub scope: String,
    pub key: String,
}

pub fn parse_linear_issue_url(url: &Url) -> Option<ParsedLinearIssueUrl> {
    if url.scheme() != "https" || !url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(LINEAR_HOST)) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let workspace = segments.next()?.trim();
    let resource = segments.next()?;
    let key = segments.next()?.trim();
    if workspace.is_empty() || resource != "issue" {
        return None;
    }
    let scope = key.split_once('-').and_then(|(prefix, num)| {
        let valid_team = !prefix.is_empty()
            && prefix.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            && prefix.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        let valid_num = !num.is_empty()
            && num.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
            && num.chars().all(|c| c.is_ascii_digit());
        (valid_team && valid_num).then_some(prefix)
    })?;
    Some(ParsedLinearIssueUrl {
        host: LINEAR_HOST.to_owned(),
        workspace: workspace.to_owned(),
        scope: scope.to_owned(),
        key: key.to_owned(),
    })
}

fn api_url() -> String {
    std::env::var("T3CODE_LINEAR_API_URL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_API_URL.to_owned())
}

fn client() -> Result<&'static reqwest::Client, TrackerError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let res = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())
    });
    res.as_ref().map_err(|err| {
        TrackerError::new("linear", "http", "failed", format!("Linear HTTP client failed: {err}"))
    })
}

fn reset_at_from_headers(headers: &HeaderMap, now_ms: i64) -> Option<i64> {
    for name in ["x-ratelimit-requests-reset", "x-ratelimit-complexity-reset"] {
        if let Some(raw) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(ts) = trimmed.parse::<i64>() {
                    if ts > now_ms {
                        return Some(ts);
                    }
                }
            }
        }
    }
    None
}

async fn graphql(
    token: &str,
    operation: &str,
    query: &str,
    variables: Value,
) -> Result<Value, TrackerError> {
    let body_bytes = serde_json::to_vec(&json!({ "query": query, "variables": variables }))
        .map_err(|_| TrackerError::new("linear", operation, "failed", "Invalid GraphQL payload."))?;
    let response = client()?
        .post(api_url())
        .header("authorization", token)
        .header("content-type", "application/json")
        .body(body_bytes)
        .send()
        .await
        .map_err(|err| {
            TrackerError::new(
                "linear",
                operation,
                "failed",
                format!("Linear could not be reached: {err}"),
            )
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    let body_text = response.text().await.map_err(|_| {
        TrackerError::new("linear", operation, "failed", "Linear returned an unreadable response.")
    })?;
    let parsed: Option<Value> = serde_json::from_str(&body_text).ok();
    let errors = parsed
        .as_ref()
        .and_then(|v| v.get("errors"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_code = |code: &str| {
        errors
            .iter()
            .any(|e| e.pointer("/extensions/code").and_then(Value::as_str) == Some(code))
    };
    if status.as_u16() == 429 || has_code("RATELIMITED") {
        let now_ms = chrono::Utc::now().timestamp_millis();
        return Err(TrackerError {
            tracker: "linear".to_owned(),
            operation: operation.to_owned(),
            reason: "rate-limited",
            detail: "Linear's rate limit was reached.".to_owned(),
            retry_at: reset_at_from_headers(&headers, now_ms),
        });
    }
    if status.as_u16() == 401 || status.as_u16() == 403 || has_code("AUTHENTICATION_ERROR") {
        return Err(TrackerError::new(
            "linear",
            operation,
            "unauthenticated",
            "Linear rejected the API key.",
        ));
    }
    let Some(json_body) = parsed else {
        return Err(TrackerError::new(
            "linear",
            operation,
            "failed",
            if status.is_success() {
                "Linear returned an unexpected body.".to_owned()
            } else {
                format!("Linear returned HTTP {} with an unexpected body.", status.as_u16())
            },
        ));
    };
    if let Some(first_msg) = errors
        .first()
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Err(TrackerError::new("linear", operation, "failed", first_msg));
    }
    if !status.is_success() {
        return Err(TrackerError::new(
            "linear",
            operation,
            "failed",
            "Linear refused the request.",
        ));
    }
    json_body.get("data").cloned().ok_or_else(|| {
        TrackerError::new("linear", operation, "failed", "Linear returned an unexpected body.")
    })
}

const FRAGMENTS: &str = r#"
fragment LinearUser on User { id name displayName email avatarUrl }
fragment LinearBot on ActorBot { name userDisplayName avatarUrl }
fragment LinearWorkflowState on WorkflowState { id name type position }
fragment LinearLabel on IssueLabel { id name color }
fragment LinearTeamLabel on IssueLabel { ...LinearLabel description }
fragment LinearReaction on Reaction { id emoji user { ...LinearUser } }
fragment LinearComment on Comment { id body createdAt url user { ...LinearUser } botActor { ...LinearBot } reactions { ...LinearReaction } }
fragment LinearIssue on Issue {
  id identifier number title url createdAt updatedAt completedAt canceledAt
  state { ...LinearWorkflowState }
  team { key }
  creator { ...LinearUser }
  botActor { ...LinearBot }
  assignee { ...LinearUser }
  labels { nodes { ...LinearLabel } }
}
fragment LinearPageInfo on PageInfo { hasNextPage endCursor }
"#;

const QUERY_VIEWER: &str = r#"
query T3Viewer {
  viewer { ...LinearUser }
  organization { urlKey }
  teams(first: 250) { nodes { id key name } }
}
"#;

const QUERY_ISSUES: &str = r#"
query T3Issues($first: Int!, $after: String, $filter: IssueFilter!, $orderBy: PaginationOrderBy!) {
  issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
    nodes { ...LinearIssue }
    pageInfo { ...LinearPageInfo }
  }
}
"#;

const QUERY_ISSUE: &str = r#"
query T3Issue($id: String!, $comments: Int!) {
  issue(id: $id) {
    ...LinearIssue
    description
    team { states(first: 100) { nodes { ...LinearWorkflowState } } }
    comments(first: $comments, orderBy: createdAt) {
      nodes { ...LinearComment }
      pageInfo { ...LinearPageInfo }
    }
    reactions { ...LinearReaction }
    attachments(first: 50) { nodes { url title sourceType metadata } }
    history(first: 100, orderBy: createdAt) {
      nodes {
        id createdAt
        actor { ...LinearUser }
        botActor { ...LinearBot }
        fromState { ...LinearWorkflowState }
        toState { ...LinearWorkflowState }
        fromAssignee { ...LinearUser }
        toAssignee { ...LinearUser }
        addedLabels { ...LinearLabel }
        removedLabels { ...LinearLabel }
        fromTitle toTitle
      }
    }
  }
}
"#;

const QUERY_COMMENTS: &str = r#"
query T3Comments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after, orderBy: createdAt) {
      nodes { ...LinearComment }
      pageInfo { ...LinearPageInfo }
    }
  }
}
"#;

const QUERY_TEAM: &str = r#"
query T3Team($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) {
    nodes {
      id key name
      states(first: 100) { nodes { ...LinearWorkflowState } pageInfo { ...LinearPageInfo } }
      labels(first: 250) { nodes { ...LinearTeamLabel } pageInfo { ...LinearPageInfo } }
      members(first: 250) { nodes { ...LinearUser } pageInfo { ...LinearPageInfo } }
      templates { nodes { id name description content type hasFormFields templateData } }
    }
  }
  issueLabels(first: 250, filter: { team: { null: true } }) {
    nodes { ...LinearTeamLabel }
    pageInfo { ...LinearPageInfo }
  }
}
"#;

fn trimmed_opt(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn to_actor(user: &Value) -> Value {
    let login = trimmed_opt(user.get("displayName"))
        .or_else(|| trimmed_opt(user.get("id")))
        .unwrap_or_default();
    json!({
        "login": login,
        "name": trimmed_opt(user.get("name")),
        "avatarUrl": trimmed_opt(user.get("avatarUrl")),
    })
}

fn actor_of(user: Option<&Value>, bot: Option<&Value>) -> Value {
    if let Some(u) = user.filter(|v| !v.is_null()) {
        return to_actor(u);
    }
    if let Some(b) = bot.filter(|v| !v.is_null()) {
        let display = trimmed_opt(b.get("userDisplayName")).or_else(|| trimmed_opt(b.get("name")));
        if let Some(name) = display {
            let login = trimmed_opt(b.get("name")).unwrap_or_else(|| name.clone());
            return json!({
                "isBot": true,
                "login": login,
                "name": name,
                "avatarUrl": trimmed_opt(b.get("avatarUrl")),
            });
        }
    }
    Value::Null
}

fn user_name(user: &Value) -> String {
    trimmed_opt(user.get("displayName"))
        .or_else(|| trimmed_opt(user.get("name")))
        .or_else(|| trimmed_opt(user.get("email")))
        .or_else(|| trimmed_opt(user.get("id")))
        .unwrap_or_default()
}

fn to_state(state: &Value) -> Value {
    let kind = state.get("type").and_then(Value::as_str).unwrap_or("");
    let name = state.get("name").and_then(Value::as_str).unwrap_or("");
    if CLOSED_STATE_TYPES.contains(&kind) {
        json!({ "category": "closed", "name": name, "closeReason": kind })
    } else {
        json!({ "category": "open", "name": name })
    }
}

fn emoji_for_content(content: &str) -> Option<(&'static str, &'static str)> {
    match content {
        "thumbs-up" => Some(("👍", "+1")),
        "thumbs-down" => Some(("👎", "-1")),
        "laugh" => Some(("😄", "smile")),
        "hooray" => Some(("🎉", "tada")),
        "confused" => Some(("😕", "confused")),
        "heart" => Some(("❤️", "heart")),
        "rocket" => Some(("🚀", "rocket")),
        "eyes" => Some(("👀", "eyes")),
        _ => None,
    }
}

fn content_for_emoji(emoji: &str) -> Option<&'static str> {
    match emoji {
        "👍" | "+1" => Some("thumbs-up"),
        "👎" | "-1" => Some("thumbs-down"),
        "😄" | "smile" => Some("laugh"),
        "🎉" | "tada" => Some("hooray"),
        "😕" | "confused" => Some("confused"),
        "❤️" | "heart" => Some("heart"),
        "🚀" | "rocket" => Some("rocket"),
        "👀" | "eyes" => Some("eyes"),
        _ => None,
    }
}

fn to_reactions(raw: Option<&Value>, viewer_id: Option<&str>) -> Vec<Value> {
    let mut grouped: Vec<(String, i64, Vec<String>, bool)> = Vec::new();
    for item in raw.and_then(Value::as_array).into_iter().flatten() {
        let Some(emoji) = item.get("emoji").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = content_for_emoji(emoji) else {
            continue;
        };
        let user = item.get("user").filter(|v| !v.is_null());
        let uid = user.and_then(|u| u.get("id")).and_then(Value::as_str);
        let mine = viewer_id.is_some() && uid == viewer_id;
        let actor_label = if !mine { user.map(user_name) } else { None };
        if let Some(entry) = grouped.iter_mut().find(|(c, _, _, _)| c == content) {
            entry.1 += 1;
            if let Some(label) = actor_label {
                entry.2.push(label);
            }
            entry.3 = entry.3 || mine;
        } else {
            grouped.push((
                content.to_owned(),
                1,
                actor_label.into_iter().collect(),
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

fn to_summary(issue: &Value, comment_count: usize) -> Value {
    let assignees = match issue.get("assignee").filter(|v| !v.is_null()) {
        Some(a) => vec![to_actor(a)],
        None => Vec::new(),
    };
    let labels = issue
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|l| {
            json!({
                "name": l.get("name").and_then(Value::as_str).unwrap_or(""),
                "color": l.get("color").and_then(Value::as_str),
            })
        })
        .collect::<Vec<_>>();
    let closed_at = trimmed_opt(issue.get("completedAt")).or_else(|| trimmed_opt(issue.get("canceledAt")));
    json!({
        "key": issue.get("identifier").and_then(Value::as_str).unwrap_or(""),
        "displayKey": issue.get("identifier").and_then(Value::as_str).unwrap_or(""),
        "title": issue.get("title").and_then(Value::as_str).unwrap_or(""),
        "url": issue.get("url").and_then(Value::as_str).unwrap_or(""),
        "author": actor_of(issue.get("creator"), issue.get("botActor")),
        "state": to_state(&issue["state"]),
        "createdAt": issue.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": issue.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
        "closedAt": closed_at,
        "assignees": assignees,
        "labels": labels,
        "commentCount": comment_count,
    })
}

fn to_comment(comment: &Value, viewer_id: Option<&str>) -> Value {
    json!({
        "id": comment.get("id").and_then(Value::as_str).unwrap_or(""),
        "author": actor_of(comment.get("user"), comment.get("botActor")),
        "body": comment.get("body").and_then(Value::as_str).unwrap_or(""),
        "createdAt": comment.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "url": trimmed_opt(comment.get("url")),
        "reactions": to_reactions(comment.get("reactions"), viewer_id),
    })
}

fn to_events(history: Option<&Value>) -> Vec<Value> {
    let mut events = Vec::new();
    for entry in history.and_then(Value::as_array).into_iter().flatten() {
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        let created_at = entry.get("createdAt").and_then(Value::as_str).unwrap_or("");
        let actor = actor_of(entry.get("actor"), entry.get("botActor"));
        let to_state_v = entry.get("toState").filter(|v| !v.is_null());
        let from_state_v = entry.get("fromState").filter(|v| !v.is_null());
        if let Some(ts) = to_state_v {
            if ts.get("id") != from_state_v.and_then(|fs| fs.get("id")) {
                let was_closed = from_state_v
                    .and_then(|fs| fs.get("type"))
                    .and_then(Value::as_str)
                    .is_some_and(|t| CLOSED_STATE_TYPES.contains(&t));
                let is_closed = ts
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|t| CLOSED_STATE_TYPES.contains(&t));
                let kind = if is_closed && !was_closed {
                    "closed"
                } else if was_closed && !is_closed {
                    "reopened"
                } else {
                    "state-changed"
                };
                events.push(json!({
                    "id": format!("{id}:state"),
                    "kind": kind,
                    "actor": actor,
                    "createdAt": created_at,
                    "detail": trimmed_opt(ts.get("name")),
                }));
            }
        }
        for label in entry.get("addedLabels").and_then(Value::as_array).into_iter().flatten() {
            let lid = label.get("id").and_then(Value::as_str).unwrap_or("");
            events.push(json!({
                "id": format!("{id}:label+{lid}"),
                "kind": "labeled",
                "actor": actor,
                "createdAt": created_at,
                "detail": trimmed_opt(label.get("name")),
            }));
        }
        for label in entry.get("removedLabels").and_then(Value::as_array).into_iter().flatten() {
            let lid = label.get("id").and_then(Value::as_str).unwrap_or("");
            events.push(json!({
                "id": format!("{id}:label-{lid}"),
                "kind": "unlabeled",
                "actor": actor,
                "createdAt": created_at,
                "detail": trimmed_opt(label.get("name")),
            }));
        }
        let from_a = entry.get("fromAssignee").filter(|v| !v.is_null());
        let to_a = entry.get("toAssignee").filter(|v| !v.is_null());
        if let Some(fa) = from_a {
            if fa.get("id") != to_a.and_then(|v| v.get("id")) {
                events.push(json!({
                    "id": format!("{id}:unassigned"),
                    "kind": "unassigned",
                    "actor": actor,
                    "createdAt": created_at,
                    "detail": user_name(fa),
                }));
            }
        }
        if let Some(ta) = to_a {
            if ta.get("id") != from_a.and_then(|v| v.get("id")) {
                events.push(json!({
                    "id": format!("{id}:assigned"),
                    "kind": "assigned",
                    "actor": actor,
                    "createdAt": created_at,
                    "detail": user_name(ta),
                }));
            }
        }
        if let Some(new_title) = entry.get("toTitle").and_then(Value::as_str) {
            if entry.get("toTitle") != entry.get("fromTitle") {
                events.push(json!({
                    "id": format!("{id}:title"),
                    "kind": "renamed",
                    "actor": actor,
                    "createdAt": created_at,
                    "detail": new_title,
                }));
            }
        }
    }
    events
}

fn to_linked_pull_requests(attachments: Option<&Value>) -> Vec<Value> {
    let re = regex::Regex::new(
        r"^https://(?:github\.com/([^/]+/[^/]+)/pull|gitlab\.com/(.+?)/-/merge_requests)/(\d+)/?(?:[?#]|$)",
    )
    .unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for att in attachments.and_then(Value::as_array).into_iter().flatten() {
        let Some(url) = att.get("url").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(url.to_owned()) {
            continue;
        }
        let Some(caps) = re.captures(url) else {
            continue;
        };
        let repo = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        let number: i64 = caps
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        let status = att
            .pointer("/metadata/status")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_draft = status == "draft"
            || att.pointer("/metadata/draft").and_then(Value::as_bool) == Some(true);
        let state = match status {
            "merged" => "merged",
            "closed" => "closed",
            _ => "open",
        };
        let title = att
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(url);
        out.push(json!({
            "repository": repo,
            "number": number,
            "title": title,
            "url": url,
            "state": state,
            "isDraft": is_draft,
            "closesIssue": false,
        }));
    }
    out
}

pub fn parse_identifier(key: &str) -> Option<String> {
    let trimmed = key.trim();
    let (prefix, num) = trimmed.split_once('-')?;
    let valid_prefix = !prefix.is_empty()
        && prefix.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric());
    let valid_num = !num.is_empty()
        && num.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
        && num.chars().all(|c| c.is_ascii_digit());
    (valid_prefix && valid_num).then(|| trimmed.to_ascii_uppercase())
}

pub async fn probe_credential(token: &str) -> Result<ProbeResult, TrackerError> {
    let data = graphql(token, "viewer", &format!("{FRAGMENTS}\n{QUERY_VIEWER}"), json!({})).await?;
    let account = user_name(&data["viewer"]);
    let workspace = trimmed_opt(data.pointer("/organization/urlKey"));
    let scopes = data
        .pointer("/teams/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let key = t.get("key").and_then(Value::as_str)?.to_owned();
            let name = t.get("name").and_then(Value::as_str).unwrap_or(&key).to_owned();
            Some((key, name))
        })
        .collect();
    Ok(ProbeResult {
        account,
        workspace,
        scopes,
    })
}

pub async fn get_viewer(token: &str) -> Result<String, TrackerError> {
    let data = graphql(token, "viewer", &format!("{FRAGMENTS}\n{QUERY_VIEWER}"), json!({})).await?;
    Ok(to_actor(&data["viewer"])["login"]
        .as_str()
        .unwrap_or("")
        .to_owned())
}

pub async fn list_issues(
    token: &str,
    scope: &str,
    involvement: &str,
    viewer: Option<&str>,
    input: &ListInput,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    let team = scope.trim().to_ascii_uppercase();
    let mut filter = serde_json::Map::new();
    filter.insert("team".into(), json!({ "key": { "eq": team } }));
    match (involvement, viewer) {
        ("assigned", Some(v)) => {
            filter.insert("assignee".into(), json!({ "displayName": { "eq": v } }));
        }
        ("authored", Some(v)) => {
            filter.insert("creator".into(), json!({ "displayName": { "eq": v } }));
        }
        ("mentioned", Some(v)) => {
            filter.insert(
                "subscribers".into(),
                json!({ "some": { "displayName": { "eq": v } } }),
            );
        }
        _ => {}
    }
    if input.state != "all" {
        filter.insert(
            "state".into(),
            json!({
                "type": if input.state == "closed" {
                    json!({ "in": CLOSED_STATE_TYPES })
                } else {
                    json!({ "nin": CLOSED_STATE_TYPES })
                }
            }),
        );
    }
    let mut clauses = Vec::new();
    if let Some(assignee) = input.assignee.as_deref() {
        clauses.push(json!({ "assignee": { "displayName": { "eq": assignee } } }));
    }
    for label in &input.labels {
        clauses.push(json!({ "labels": { "some": { "name": { "eq": label } } } }));
    }
    if !clauses.is_empty() {
        filter.insert("and".into(), Value::Array(clauses));
    }
    if let Some(q) = input.query.as_deref() {
        let mut or_clauses = vec![
            json!({ "title": { "containsIgnoreCase": q } }),
            json!({ "description": { "containsIgnoreCase": q } }),
        ];
        // A qualified issue number applies only to its own team.
        let ref_re = regex::Regex::new(r"^(?:([A-Za-z][A-Za-z0-9]*)-|#)?(\d+)$").unwrap();
        if let Some(caps) = ref_re.captures(q.trim()) {
            let team_ok = caps
                .get(1)
                .is_none_or(|m| m.as_str().eq_ignore_ascii_case(&team));
            if team_ok {
                if let Some(num) = caps.get(2).and_then(|m| m.as_str().parse::<i64>().ok()) {
                    or_clauses.push(json!({ "number": { "eq": num } }));
                }
            }
        }
        filter.insert("or".into(), Value::Array(or_clauses));
    }
    let order_by = if input.sort == "created" {
        "createdAt"
    } else {
        "updatedAt"
    };
    let data = graphql(
        token,
        "listIssues",
        &format!("{FRAGMENTS}\n{QUERY_ISSUES}"),
        json!({
            "first": input.limit,
            "after": input.cursor,
            "filter": Value::Object(filter),
            "orderBy": order_by,
        }),
    )
    .await?;
    let items = data
        .pointer("/issues/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|node| to_summary(node, 0))
        .collect();
    let next_cursor = if data.pointer("/issues/pageInfo/hasNextPage") == Some(&json!(true)) {
        trimmed_opt(data.pointer("/issues/pageInfo/endCursor"))
    } else {
        None
    };
    Ok((items, next_cursor))
}

async fn raw_issue(token: &str, operation: &str, identifier: &str, comments: i64) -> Result<Option<Value>, TrackerError> {
    let res = graphql(
        token,
        operation,
        &format!("{FRAGMENTS}\n{QUERY_ISSUE}"),
        json!({ "id": identifier, "comments": comments }),
    )
    .await;
    match res {
        Ok(data) => Ok(data.get("issue").filter(|v| !v.is_null()).cloned()),
        Err(err) if err.reason == "failed" && err.detail.to_ascii_lowercase().contains("not found") => Ok(None),
        Err(err) => Err(err),
    }
}

pub async fn get_issue(token: &str, key: &str) -> Result<Value, TrackerError> {
    let identifier = parse_identifier(key).ok_or_else(|| {
        TrackerError::new(
            "linear",
            "getIssue",
            "not-found",
            "Linear has no issue by that identifier, or this account cannot see it.",
        )
    })?;
    let viewer_fut = async {
        graphql(token, "viewer", &format!("{FRAGMENTS}\n{QUERY_VIEWER}"), json!({}))
            .await
            .ok()
            .map(|d| d["viewer"].clone())
    };
    let (issue_res, viewer_opt) = tokio::join!(
        raw_issue(token, "getIssue", &identifier, COMMENTS_PAGE),
        viewer_fut
    );
    let issue = issue_res?.ok_or_else(|| {
        TrackerError::new(
            "linear",
            "getIssue",
            "not-found",
            "Linear has no issue by that identifier, or this account cannot see it.",
        )
    })?;
    let viewer_id = viewer_opt
        .as_ref()
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str);
    let viewer_login = viewer_opt
        .as_ref()
        .and_then(|v| to_actor(v)["login"].as_str().map(str::to_owned));
    let comments_nodes = issue
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let comments_cursor = if issue.pointer("/comments/pageInfo/hasNextPage") == Some(&json!(true)) {
        trimmed_opt(issue.pointer("/comments/pageInfo/endCursor"))
    } else {
        None
    };
    let mut states = issue
        .pointer("/team/states/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    states.sort_by(|a, b| {
        let ta = a.get("type").and_then(Value::as_str).unwrap_or("");
        let tb = b.get("type").and_then(Value::as_str).unwrap_or("");
        let ia = STATE_TYPE_ORDER.iter().position(|t| *t == ta).unwrap_or(99);
        let ib = STATE_TYPE_ORDER.iter().position(|t| *t == tb).unwrap_or(99);
        ia.cmp(&ib).then_with(|| {
            let pa = a.get("position").and_then(Value::as_f64).unwrap_or(0.0);
            let pb = b.get("position").and_then(Value::as_f64).unwrap_or(0.0);
            pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let mut out = to_summary(&issue, comments_nodes.len());
    let obj = out.as_object_mut().unwrap();
    obj.insert("body".into(), json!(issue.get("description").and_then(Value::as_str).unwrap_or("")));
    obj.insert("viewer".into(), json!(viewer_login));
    obj.insert(
        "viewerPermissions".into(),
        json!({ "setState": true, "comment": true, "edit": true, "labels": true, "assignees": true }),
    );
    obj.insert("states".into(), Value::Array(states.iter().map(to_state).collect()));
    obj.insert("reactions".into(), Value::Array(to_reactions(issue.get("reactions"), viewer_id)));
    obj.insert(
        "comments".into(),
        Value::Array(comments_nodes.iter().map(|c| to_comment(c, viewer_id)).collect()),
    );
    obj.insert("commentsCursor".into(), json!(comments_cursor));
    obj.insert("events".into(), Value::Array(to_events(issue.pointer("/history/nodes"))));
    obj.insert(
        "linkedPullRequests".into(),
        Value::Array(to_linked_pull_requests(issue.pointer("/attachments/nodes"))),
    );
    Ok(out)
}

pub async fn get_comments(token: &str, key: &str, cursor: &str) -> Result<Value, TrackerError> {
    let identifier = parse_identifier(key).ok_or_else(|| {
        TrackerError::new(
            "linear",
            "getComments",
            "not-found",
            "Linear has no issue by that identifier, or this account cannot see it.",
        )
    })?;
    let data = graphql(
        token,
        "getComments",
        &format!("{FRAGMENTS}\n{QUERY_COMMENTS}"),
        json!({ "id": identifier, "first": COMMENTS_PAGE, "after": cursor }),
    )
    .await?;
    let issue = data.get("issue").filter(|v| !v.is_null()).ok_or_else(|| {
        TrackerError::new("linear", "getComments", "not-found", "This issue no longer exists.")
    })?;
    let nodes = issue
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let viewer_id = if nodes
        .iter()
        .any(|c| c.get("reactions").and_then(Value::as_array).is_some_and(|a| !a.is_empty()))
    {
        graphql(token, "viewer", &format!("{FRAGMENTS}\n{QUERY_VIEWER}"), json!({}))
            .await
            .ok()
            .and_then(|d| trimmed_opt(d.pointer("/viewer/id")))
    } else {
        None
    };
    let next_cursor = if issue.pointer("/comments/pageInfo/hasNextPage") == Some(&json!(true)) {
        trimmed_opt(issue.pointer("/comments/pageInfo/endCursor"))
    } else {
        None
    };
    Ok(json!({
        "comments": nodes.iter().map(|c| to_comment(c, viewer_id.as_deref())).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
    }))
}

struct TeamScope {
    team: Value,
    workspace_labels: Vec<Value>,
    truncated: bool,
}

async fn require_team(token: &str, operation: &str, scope: &str) -> Result<TeamScope, TrackerError> {
    let data = graphql(
        token,
        operation,
        &format!("{FRAGMENTS}\n{QUERY_TEAM}"),
        json!({ "key": scope.trim().to_ascii_uppercase() }),
    )
    .await?;
    let team = data
        .pointer("/teams/nodes/0")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or_else(|| {
            TrackerError::new(
                "linear",
                operation,
                "failed",
                format!("No Linear team has the key \"{}\".", scope),
            )
        })?;
    let workspace_labels = data
        .pointer("/issueLabels/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let truncated = team.pointer("/states/pageInfo/hasNextPage") == Some(&json!(true))
        || team.pointer("/labels/pageInfo/hasNextPage") == Some(&json!(true))
        || team.pointer("/members/pageInfo/hasNextPage") == Some(&json!(true))
        || data.pointer("/issueLabels/pageInfo/hasNextPage") == Some(&json!(true));
    Ok(TeamScope {
        team,
        workspace_labels,
        truncated,
    })
}

async fn require_team_issue(
    token: &str,
    operation: &str,
    scope: &str,
    key: &str,
) -> Result<Value, TrackerError> {
    let identifier = parse_identifier(key).ok_or_else(|| {
        TrackerError::new(
            "linear",
            operation,
            "not-found",
            "Linear has no issue by that identifier, or this account cannot see it.",
        )
    })?;
    let issue = raw_issue(token, operation, &identifier, 1)
        .await?
        .ok_or_else(|| {
            TrackerError::new(
                "linear",
                operation,
                "not-found",
                "Linear has no issue by that identifier, or this account cannot see it.",
            )
        })?;
    let team = scope.trim().to_ascii_uppercase();
    let actual = issue
        .pointer("/team/key")
        .and_then(Value::as_str)
        .unwrap_or("");
    if actual != team {
        return Err(TrackerError::new(
            "linear",
            operation,
            "failed",
            format!(
                "{} belongs to Linear team {}, not {}.",
                issue["identifier"].as_str().unwrap_or(&identifier),
                actual,
                team
            ),
        ));
    }
    Ok(issue)
}

fn resolve_label_ids(
    operation: &str,
    team: &TeamScope,
    names: &[String],
) -> Result<Vec<String>, TrackerError> {
    let all_labels: Vec<&Value> = team
        .team
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(team.workspace_labels.iter())
        .collect();
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let wanted = name.trim().to_ascii_lowercase();
        let found = all_labels.iter().find(|l| {
            l.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.to_ascii_lowercase() == wanted)
        });
        let Some(id) = found.and_then(|l| l.get("id")).and_then(Value::as_str) else {
            return Err(TrackerError::new(
                "linear",
                operation,
                "failed",
                format!("Linear has no label named \"{name}\" for this team."),
            ));
        };
        ids.push(id.to_owned());
    }
    Ok(ids)
}

fn resolve_assignee_id(
    operation: &str,
    team: &TeamScope,
    assignees: &[String],
) -> Result<Option<String>, TrackerError> {
    let Some(first) = assignees.first() else {
        return Ok(None);
    };
    if assignees.len() > 1 {
        return Err(TrackerError::new(
            "linear",
            operation,
            "failed",
            "A Linear issue has one assignee at most.",
        ));
    }
    let members = team
        .team
        .pointer("/members/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for u in members {
        let matches = u.get("id").and_then(Value::as_str) == Some(first.as_str())
            || u.get("email")
                .and_then(Value::as_str)
                .is_some_and(|s| s.eq_ignore_ascii_case(first))
            || u.get("displayName")
                .and_then(Value::as_str)
                .is_some_and(|s| s.eq_ignore_ascii_case(first));
        if matches {
            if let Some(id) = u.get("id").and_then(Value::as_str) {
                return Ok(Some(id.to_owned()));
            }
        }
    }
    Err(TrackerError::new(
        "linear",
        operation,
        "failed",
        format!("\"{first}\" is not a member of this Linear team."),
    ))
}

pub async fn list_candidates(token: &str, scope: &str) -> Result<Value, TrackerError> {
    let scope = require_team(token, "listCandidates", scope).await?;
    let labels = scope
        .team
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(scope.workspace_labels.iter())
        .map(|l| {
            json!({
                "name": l.get("name").and_then(Value::as_str).unwrap_or(""),
                "color": l.get("color").and_then(Value::as_str),
                "description": trimmed_opt(l.get("description")),
            })
        })
        .collect::<Vec<_>>();
    let assignees = scope
        .team
        .pointer("/members/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|u| {
            let mut actor = to_actor(u);
            if let Some(id) = u.get("id").and_then(Value::as_str) {
                actor["id"] = json!(id);
            }
            actor
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "labels": labels,
        "assignees": assignees,
        "truncated": scope.truncated,
    }))
}

pub async fn list_templates(token: &str, scope: &str) -> Result<Value, TrackerError> {
    let team_scope = require_team(token, "listTemplates", scope).await?;
    let team_key = team_scope
        .team
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or(scope);
    let mut label_names = BTreeMap::new();
    for l in team_scope
        .team
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(team_scope.workspace_labels.iter())
    {
        if let (Some(id), Some(name)) = (
            l.get("id").and_then(Value::as_str),
            l.get("name").and_then(Value::as_str),
        ) {
            label_names.insert(id.to_owned(), name.to_owned());
        }
    }
    let mut templates = Vec::new();
    let mut external_templates = Vec::new();
    for tpl in team_scope
        .team
        .pointer("/templates/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if tpl.get("type").and_then(Value::as_str) != Some("issue") {
            continue;
        }
        let id = tpl.get("id").and_then(Value::as_str).unwrap_or("");
        let name = tpl.get("name").and_then(Value::as_str).unwrap_or("");
        let about = tpl.get("description").and_then(Value::as_str).unwrap_or("");
        let data_val = match tpl.get("templateData") {
            Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({})),
            Some(v @ Value::Object(_)) => v.clone(),
            _ => json!({}),
        };
        let body = tpl
            .get("content")
            .and_then(Value::as_str)
            .or_else(|| data_val.get("description").and_then(Value::as_str));
        let has_form = tpl.get("hasFormFields").and_then(Value::as_bool) == Some(true)
            || (body.is_none() && data_val.get("descriptionData").is_some_and(|v| !v.is_null()));
        if has_form {
            let mut u = Url::parse(&format!(
                "https://linear.app/team/{}/new",
                percent_encoding::utf8_percent_encode(team_key, percent_encoding::NON_ALPHANUMERIC)
            ))
            .unwrap();
            u.query_pairs_mut().append_pair("template", id);
            external_templates.push(json!({
                "name": name,
                "about": about,
                "url": u.to_string(),
            }));
        } else {
            let labels = data_val
                .get("labelIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().and_then(|lid| label_names.get(lid)).cloned())
                .collect::<Vec<_>>();
            let assignees = data_val
                .get("assigneeId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| vec![s.to_owned()])
                .unwrap_or_default();
            templates.push(json!({
                "key": id,
                "name": name,
                "about": about,
                "title": data_val.get("title").and_then(Value::as_str).unwrap_or(""),
                "body": body.unwrap_or(""),
                "labels": labels,
                "assignees": assignees,
            }));
        }
    }
    Ok(json!({
        "templates": templates,
        "externalTemplates": external_templates,
        "blankIssuesEnabled": true,
    }))
}

pub async fn create(
    token: &str,
    scope: &str,
    title: &str,
    body: &str,
    labels: &[String],
    assignees: &[String],
) -> Result<IssueCreateResult, TrackerError> {
    let team_scope = require_team(token, "create", scope).await?;
    let label_ids = resolve_label_ids("create", &team_scope, labels)?;
    let assignee_id = resolve_assignee_id("create", &team_scope, assignees)?;
    let mut input = json!({
        "teamId": team_scope.team["id"],
        "title": title,
        "description": body,
        "labelIds": label_ids,
    });
    if let Some(aid) = assignee_id {
        input["assigneeId"] = json!(aid);
    }
    let data = graphql(
        token,
        "createIssue",
        "mutation T3IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
        json!({ "input": input }),
    )
    .await?;
    let created = data.pointer("/issueCreate/issue").filter(|v| !v.is_null());
    if data.pointer("/issueCreate/success") != Some(&json!(true)) || created.is_none() {
        return Err(TrackerError::new(
            "linear",
            "createIssue",
            "failed",
            "Linear did not create the issue.",
        ));
    }
    let c = created.unwrap();
    let identifier = c["identifier"].as_str().unwrap_or("").to_owned();
    let url = c["url"].as_str().unwrap_or("").to_owned();
    Ok(IssueCreateResult {
        key: identifier.clone(),
        display_key: identifier,
        url,
    })
}

pub async fn comment(token: &str, scope: &str, key: &str, body: &str) -> Result<(), TrackerError> {
    let issue = require_team_issue(token, "comment", scope, key).await?;
    let data = graphql(
        token,
        "createComment",
        "mutation T3CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        json!({ "input": { "issueId": issue["id"], "body": body } }),
    )
    .await?;
    if data.pointer("/commentCreate/success") != Some(&json!(true)) {
        return Err(TrackerError::new(
            "linear",
            "createComment",
            "failed",
            "Linear did not apply the change.",
        ));
    }
    Ok(())
}

pub async fn update(
    token: &str,
    scope: &str,
    key: &str,
    title: Option<&str>,
    body: Option<&str>,
    labels: Option<&[String]>,
    assignees: Option<&[String]>,
) -> Result<(), TrackerError> {
    let issue = require_team_issue(token, "update", scope, key).await?;
    let identifier = issue["identifier"].as_str().unwrap_or(key);
    let mut input = serde_json::Map::new();
    if let Some(t) = title {
        input.insert("title".into(), json!(t));
    }
    if let Some(b) = body {
        input.insert("description".into(), json!(b));
    }
    if labels.is_some() || assignees.is_some() {
        let team_scope = require_team(token, "update", scope).await?;
        if let Some(l) = labels {
            input.insert("labelIds".into(), json!(resolve_label_ids("update", &team_scope, l)?));
        }
        if let Some(a) = assignees {
            input.insert("assigneeId".into(), json!(resolve_assignee_id("update", &team_scope, a)?));
        }
    }
    let data = graphql(
        token,
        "updateIssue",
        "mutation T3IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        json!({ "id": identifier, "input": Value::Object(input) }),
    )
    .await?;
    if data.pointer("/issueUpdate/success") != Some(&json!(true)) {
        return Err(TrackerError::new(
            "linear",
            "updateIssue",
            "failed",
            "Linear did not apply the change.",
        ));
    }
    Ok(())
}

pub async fn set_state(token: &str, scope: &str, key: &str, state_name: &str) -> Result<(), TrackerError> {
    let issue = require_team_issue(token, "setState", scope, key).await?;
    let identifier = issue["identifier"].as_str().unwrap_or(key);
    let team_scope = require_team(token, "setState", scope).await?;
    let wanted = team_scope
        .team
        .pointer("/states/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|s| s.get("name").and_then(Value::as_str) == Some(state_name))
        .ok_or_else(|| {
            TrackerError::new(
                "linear",
                "setState",
                "failed",
                format!("This team's workflow has no \"{state_name}\" state."),
            )
        })?;
    let data = graphql(
        token,
        "updateIssue",
        "mutation T3IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
        json!({ "id": identifier, "input": { "stateId": wanted["id"] } }),
    )
    .await?;
    if data.pointer("/issueUpdate/success") != Some(&json!(true)) {
        return Err(TrackerError::new(
            "linear",
            "updateIssue",
            "failed",
            "Linear did not apply the change.",
        ));
    }
    Ok(())
}

pub async fn set_reaction(
    token: &str,
    scope: &str,
    key: &str,
    subject_id: Option<&str>,
    content: &str,
    reacted: bool,
) -> Result<(), TrackerError> {
    let issue = require_team_issue(token, "setReaction", scope, key).await?;
    let issue_id = issue["id"].as_str().unwrap_or("");
    let Some((emoji, _)) = emoji_for_content(content) else {
        return Err(TrackerError::new(
            "linear",
            "setReaction",
            "failed",
            "Unsupported reaction.",
        ));
    };
    if reacted && subject_id.is_none() {
        let data = graphql(
            token,
            "createReaction",
            "mutation T3ReactionCreate($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
            json!({ "input": { "issueId": issue_id, "emoji": emoji } }),
        )
        .await?;
        if data.pointer("/reactionCreate/success") != Some(&json!(true)) {
            return Err(TrackerError::new("linear", "createReaction", "failed", "Linear did not apply the change."));
        }
        return Ok(());
    }
    let (subject_issue_id, reactions) = if let Some(cid) = subject_id {
        let data = graphql(
            token,
            "listReactions",
            &format!("{FRAGMENTS}\nquery T3CommentReactions($id: String!) {{ comment(id: $id) {{ issue {{ id }} reactions {{ ...LinearReaction }} }} }}"),
            json!({ "id": cid }),
        )
        .await?;
        (
            data.pointer("/comment/issue/id").and_then(Value::as_str).map(str::to_owned),
            data.pointer("/comment/reactions").and_then(Value::as_array).cloned().unwrap_or_default(),
        )
    } else {
        let data = graphql(
            token,
            "listReactions",
            &format!("{FRAGMENTS}\nquery T3IssueReactions($id: String!) {{ issue(id: $id) {{ reactions {{ ...LinearReaction }} }} }}"),
            json!({ "id": issue_id }),
        )
        .await?;
        (
            Some(issue_id.to_owned()),
            data.pointer("/issue/reactions").and_then(Value::as_array).cloned().unwrap_or_default(),
        )
    };
    if subject_issue_id.as_deref() != Some(issue_id) {
        return Err(TrackerError::new(
            "linear",
            "setReaction",
            "failed",
            "The comment does not belong to the selected issue.",
        ));
    }
    if reacted {
        let data = graphql(
            token,
            "createReaction",
            "mutation T3ReactionCreate($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
            json!({ "input": { "commentId": subject_id, "emoji": emoji } }),
        )
        .await?;
        if data.pointer("/reactionCreate/success") != Some(&json!(true)) {
            return Err(TrackerError::new("linear", "createReaction", "failed", "Linear did not apply the change."));
        }
        return Ok(());
    }
    let viewer = graphql(token, "viewer", &format!("{FRAGMENTS}\n{QUERY_VIEWER}"), json!({}))
        .await
        .ok()
        .and_then(|d| trimmed_opt(d.pointer("/viewer/id")));
    if let Some(viewer_id) = viewer {
        if let Some(own_id) = reactions.iter().find_map(|r| {
            let re = r.get("emoji").and_then(Value::as_str)?;
            let ruid = r.pointer("/user/id").and_then(Value::as_str)?;
            (content_for_emoji(re) == Some(content) && ruid == viewer_id)
                .then(|| r.get("id").and_then(Value::as_str).map(str::to_owned))
                .flatten()
        }) {
            let data = graphql(
                token,
                "deleteReaction",
                "mutation T3ReactionDelete($id: String!) { reactionDelete(id: $id) { success } }",
                json!({ "id": own_id }),
            )
            .await?;
            if data.pointer("/reactionDelete/success") != Some(&json!(true)) {
                return Err(TrackerError::new("linear", "deleteReaction", "failed", "Linear did not apply the change."));
            }
        }
    }
    Ok(())
}
