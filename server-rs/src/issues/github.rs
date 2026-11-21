//! GitHub issue tracker driver over `gh api`.
use serde_json::{json, Value};
use std::{collections::BTreeSet, process::Command, time::Duration};

use crate::github_pinned_credential::{self, CommandFailure};

use super::{capabilities, IssueCreateResult, ListInput, TrackerError};

pub fn caps() -> Value {
    capabilities(true, true, true, true, true, true, true, true, true, true)
}

const TIMEOUT: Duration = Duration::from_secs(20);

fn map_failure(operation: &str, failure: CommandFailure) -> TrackerError {
    let reason = match failure {
        CommandFailure::Spawn(std::io::ErrorKind::NotFound) => "missing-tool",
        CommandFailure::Unauthenticated => "unauthenticated",
        CommandFailure::RateLimited => "rate-limited",
        CommandFailure::NotFound => "not-found",
        CommandFailure::Spawn(_) | CommandFailure::Failed => "failed",
    };
    let detail = match reason {
        "missing-tool" => "GitHub CLI is not installed.",
        "unauthenticated" => "GitHub authentication is unavailable. Sign in and retry.",
        "rate-limited" => "GitHub API rate limit exceeded.",
        "not-found" => "GitHub could not find the requested issue.",
        _ => "The GitHub issue request failed.",
    };
    TrackerError::new("github", operation, reason, detail)
}

fn validate_repo(scope: &str, operation: &str) -> Result<(String, String), TrackerError> {
    let trimmed = scope.trim();
    if trimmed.ends_with("/.") || trimmed.ends_with("/..") {
        return Err(TrackerError::new(
            "github",
            operation,
            "failed",
            "A repository was named that GitHub cannot address.",
        ));
    }
    let Some((owner, name)) = trimmed.split_once('/') else {
        return Err(TrackerError::new(
            "github",
            operation,
            "failed",
            "A repository was named that GitHub cannot address.",
        ));
    };
    let owner_ok = !owner.is_empty()
        && owner.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !owner_ok || !name_ok {
        return Err(TrackerError::new(
            "github",
            operation,
            "failed",
            "A repository was named that GitHub cannot address.",
        ));
    }
    Ok((owner.to_owned(), name.to_owned()))
}

fn parse_issue_number(key: &str, operation: &str) -> Result<i64, TrackerError> {
    let trimmed = key.trim();
    let ok = !trimmed.is_empty()
        && trimmed.chars().next().is_some_and(|c| ('1'..='9').contains(&c))
        && trimmed.chars().all(|c| c.is_ascii_digit());
    let num = ok.then(|| trimmed.parse::<i64>().ok()).flatten();
    match num {
        Some(n) if n <= 2_147_483_647 => Ok(n),
        _ => Err(TrackerError::new(
            "github",
            operation,
            "not-found",
            "GitHub could not find the requested issue.",
        )),
    }
}

fn graphql(
    cwd: &str,
    host: &str,
    operation: &str,
    query: &str,
    variables: Value,
) -> Result<Value, TrackerError> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", "graphql"]);
    if !host.trim().is_empty() && !host.eq_ignore_ascii_case("github.com") {
        cmd.args(["--hostname", host.trim()]);
    }
    cmd.args(["--input", "-"]).current_dir(cwd);
    let body = serde_json::to_vec(&json!({ "query": query, "variables": variables }))
        .map_err(|_| TrackerError::new("github", operation, "failed", "Invalid GraphQL payload."))?;
    let bytes = github_pinned_credential::run_classified_with_input(&mut cmd, TIMEOUT, body)
        .map_err(|f| map_failure(operation, f))?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        TrackerError::new(
            "github",
            operation,
            "failed",
            format!("GitHub returned an unreadable {operation} response."),
        )
    })?;
    if let Some(errors) = payload.get("errors").and_then(Value::as_array) {
        if let Some(first) = errors.first() {
            let msg = first
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The GitHub issue request failed.");
            let reason = if first.get("type").and_then(Value::as_str) == Some("NOT_FOUND")
                || msg.to_ascii_lowercase().contains("could not resolve to an issue")
            {
                "not-found"
            } else {
                "failed"
            };
            return Err(TrackerError::new("github", operation, reason, msg));
        }
    }
    payload.get("data").cloned().ok_or_else(|| {
        TrackerError::new(
            "github",
            operation,
            "failed",
            format!("GitHub returned an unreadable {operation} response."),
        )
    })
}

fn rest(
    cwd: &str,
    host: &str,
    operation: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, TrackerError> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", path, "--method", method]);
    if !host.trim().is_empty() && !host.eq_ignore_ascii_case("github.com") {
        cmd.args(["--hostname", host.trim()]);
    }
    let stdin_bytes = if let Some(b) = body {
        cmd.args(["--input", "-", "--header", "Content-Type: application/json"]);
        Some(serde_json::to_vec(&b).map_err(|_| {
            TrackerError::new("github", operation, "failed", "Invalid REST body.")
        })?)
    } else {
        None
    };
    cmd.current_dir(cwd);
    let bytes = match stdin_bytes {
        Some(bytes) => github_pinned_credential::run_classified_with_input(&mut cmd, TIMEOUT, bytes),
        None => github_pinned_credential::run_classified(&mut cmd, TIMEOUT),
    }
    .map_err(|f| map_failure(operation, f))?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        TrackerError::new(
            "github",
            operation,
            "failed",
            format!("GitHub returned an unreadable {operation} response."),
        )
    })
}

fn trimmed_opt(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn to_actor(raw: Option<&Value>) -> Value {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Value::Null;
    };
    let Some(login) = trimmed_opt(raw.get("login")) else {
        return Value::Null;
    };
    json!({
        "login": login,
        "name": trimmed_opt(raw.get("name")),
        "avatarUrl": trimmed_opt(raw.get("avatarUrl")),
    })
}

fn to_issue_state(state: Option<&str>, reason: Option<&str>) -> Value {
    if state.map(str::trim).is_none_or(|s| !s.eq_ignore_ascii_case("CLOSED")) {
        return json!({ "category": "open", "name": "Open" });
    }
    match reason.map(str::trim).unwrap_or("").to_ascii_uppercase().as_str() {
        "COMPLETED" => json!({ "category": "closed", "name": "Completed", "closeReason": "completed" }),
        "NOT_PLANNED" => json!({ "category": "closed", "name": "Not planned", "closeReason": "not-planned" }),
        "DUPLICATE" => json!({ "category": "closed", "name": "Duplicate", "closeReason": "duplicate" }),
        _ => json!({ "category": "closed", "name": "Closed" }),
    }
}

fn issue_states() -> Value {
    json!([
        { "category": "open", "name": "Open" },
        { "category": "closed", "name": "Completed", "closeReason": "completed" },
        { "category": "closed", "name": "Not planned", "closeReason": "not-planned" },
        { "category": "closed", "name": "Duplicate", "closeReason": "duplicate" }
    ])
}

fn reaction_content_from_gh(s: &str) -> Option<&'static str> {
    match s {
        "THUMBS_UP" => Some("thumbs-up"),
        "THUMBS_DOWN" => Some("thumbs-down"),
        "LAUGH" => Some("laugh"),
        "HOORAY" => Some("hooray"),
        "CONFUSED" => Some("confused"),
        "HEART" => Some("heart"),
        "ROCKET" => Some("rocket"),
        "EYES" => Some("eyes"),
        _ => None,
    }
}

fn reaction_content_to_gh(s: &str) -> Option<&'static str> {
    match s {
        "thumbs-up" => Some("THUMBS_UP"),
        "thumbs-down" => Some("THUMBS_DOWN"),
        "laugh" => Some("LAUGH"),
        "hooray" => Some("HOORAY"),
        "confused" => Some("CONFUSED"),
        "heart" => Some("HEART"),
        "rocket" => Some("ROCKET"),
        "eyes" => Some("EYES"),
        _ => None,
    }
}

fn to_reactions(groups: Option<&Value>, viewer: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    for g in groups.and_then(Value::as_array).into_iter().flatten() {
        let Some(content) = g
            .get("content")
            .and_then(Value::as_str)
            .and_then(reaction_content_from_gh)
        else {
            continue;
        };
        let count = g
            .pointer("/reactors/totalCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if count <= 0 {
            continue;
        }
        let viewer_has_reacted = g.get("viewerHasReacted").and_then(Value::as_bool) == Some(true);
        let actors = g
            .pointer("/reactors/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|u| u.get("login").and_then(Value::as_str).map(str::to_owned))
            .filter(|login| viewer.is_none_or(|v| !login.eq_ignore_ascii_case(v)))
            .collect::<Vec<_>>();
        out.push(json!({
            "content": content,
            "count": count,
            "actors": actors,
            "viewerHasReacted": viewer_has_reacted,
        }));
    }
    out
}

fn to_summary(raw: &Value) -> Value {
    let number = raw.get("number").and_then(Value::as_i64).unwrap_or(0);
    let assignees = raw
        .pointer("/assignees/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let v = to_actor(Some(a));
            (!v.is_null()).then_some(v)
        })
        .collect::<Vec<_>>();
    let labels = raw
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let name = trimmed_opt(l.get("name"))?;
            Some(json!({
                "name": name,
                "color": trimmed_opt(l.get("color")),
            }))
        })
        .collect::<Vec<_>>();
    let comment_count = raw
        .pointer("/comments/totalCount")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    json!({
        "key": number.to_string(),
        "displayKey": format!("#{number}"),
        "title": raw.get("title").and_then(Value::as_str).unwrap_or(""),
        "url": raw.get("url").and_then(Value::as_str).unwrap_or(""),
        "author": to_actor(raw.get("author")),
        "state": to_issue_state(
            raw.get("state").and_then(Value::as_str),
            raw.get("stateReason").and_then(Value::as_str),
        ),
        "createdAt": raw.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": raw.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
        "closedAt": trimmed_opt(raw.get("closedAt")),
        "assignees": assignees,
        "labels": labels,
        "commentCount": comment_count,
    })
}

fn to_comment(raw: &Value, viewer: Option<&str>) -> Option<Value> {
    let id = trimmed_opt(raw.get("id"))?;
    Some(json!({
        "id": id,
        "author": to_actor(raw.get("author")),
        "body": raw.get("body").and_then(Value::as_str).unwrap_or(""),
        "createdAt": raw.get("createdAt").and_then(Value::as_str).unwrap_or(""),
        "url": trimmed_opt(raw.get("url")),
        "reactions": to_reactions(raw.get("reactionGroups"), viewer),
    }))
}

fn to_linked_pr(raw: &Value, closes: bool) -> Option<Value> {
    let repository = raw.pointer("/repository/nameWithOwner")?.as_str()?.to_owned();
    let number = raw.get("number")?.as_i64()?;
    let title = raw.get("title")?.as_str()?.to_owned();
    let url = raw.get("url")?.as_str()?.to_owned();
    let state = match raw.get("state").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase().as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ => "open",
    };
    let is_draft = raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false);
    Some(json!({
        "repository": repository,
        "number": number,
        "title": title,
        "url": url,
        "state": state,
        "isDraft": is_draft,
        "closesIssue": closes,
    }))
}

fn quoted_term(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn get_viewer(cwd: &str, host: &str) -> Result<String, TrackerError> {
    let data = graphql(cwd, host, "getViewer", "query IssueViewer { viewer { login } }", json!({}))?;
    Ok(data
        .pointer("/viewer/login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}

pub fn list_issues(
    cwd: &str,
    host: &str,
    scope: &str,
    involvement: &str,
    viewer: Option<&str>,
    input: &ListInput,
) -> Result<(Vec<Value>, Option<String>), TrackerError> {
    validate_repo(scope, "listIssues")?;
    let mut parts = vec!["is:issue".to_owned(), format!("repo:{}", scope.trim())];
    if input.state != "all" {
        parts.push(format!("is:{}", input.state));
    }
    if let (Some(qual), Some(v)) = (
        match involvement {
            "assigned" => Some("assignee"),
            "authored" => Some("author"),
            "mentioned" => Some("mentions"),
            _ => None,
        },
        viewer,
    ) {
        parts.push(format!("{qual}:{v}"));
    }
    for label in &input.labels {
        parts.push(format!("label:{}", quoted_term(label)));
    }
    if let Some(assignee) = input.assignee.as_deref() {
        parts.push(format!("assignee:{}", quoted_term(assignee)));
    }
    parts.push(format!("sort:{}-desc", input.sort));
    if let Some(q) = input.query.as_deref() {
        for word in q.split_whitespace() {
            if !word.is_empty() {
                parts.push(quoted_term(word));
            }
        }
    }
    let query = r#"
fragment IssueRow on Issue {
  number title url state stateReason createdAt updatedAt closedAt
  author { __typename login avatarUrl ... on User { name } }
}
query IssueSearch($q: String!, $cursor: String, $rows: Int!) {
  search(query: $q, type: ISSUE, first: $rows, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        ...IssueRow
        assignees(first: 20) { nodes { login name avatarUrl } }
        labels(first: 20) { nodes { name color } }
        comments { totalCount }
      }
    }
  }
}
"#;
    let rows = input.limit.clamp(1, 100);
    let data = graphql(
        cwd,
        host,
        "listIssues",
        query,
        json!({ "q": parts.join(" "), "cursor": input.cursor, "rows": rows }),
    )?;
    let items = data
        .pointer("/search/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|n| n.get("__typename").and_then(Value::as_str) == Some("Issue"))
        .map(to_summary)
        .collect();
    let next_cursor = if data.pointer("/search/pageInfo/hasNextPage") == Some(&json!(true)) {
        trimmed_opt(data.pointer("/search/pageInfo/endCursor"))
    } else {
        None
    };
    Ok((items, next_cursor))
}

pub fn get_issue(cwd: &str, host: &str, scope: &str, key: &str) -> Result<Value, TrackerError> {
    let (owner, name) = validate_repo(scope, "getIssue")?;
    let number = parse_issue_number(key, "getIssue")?;
    let detail_query = r#"
fragment IssueRow on Issue {
  number title url state stateReason createdAt updatedAt closedAt
  author { __typename login avatarUrl ... on User { name } }
}
fragment Reactions on Reactable {
  __typename
  reactionGroups {
    content viewerHasReacted
    reactors(first: 10) {
      totalCount
      nodes {
        __typename
        ... on User { login }
        ... on Bot { login }
        ... on Organization { login }
        ... on Mannequin { login }
      }
    }
  }
}
query IssueDetail($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) {
      ...IssueRow
      assignees(first: 100) { pageInfo { hasNextPage endCursor } nodes { login name avatarUrl } }
      labels(first: 100) { pageInfo { hasNextPage endCursor } nodes { name color } }
      body viewerCanUpdate viewerCanClose viewerCanReopen
      ...Reactions
      comments(last: 100) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { __typename login avatarUrl } body createdAt url ...Reactions }
      }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        pageInfo { hasNextPage endCursor }
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      timelineItems(last: 100, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on ClosedEvent { id createdAt actor { __typename login avatarUrl } }
          ... on ReopenedEvent { id createdAt actor { __typename login avatarUrl } }
          ... on LabeledEvent { id createdAt actor { __typename login avatarUrl } label { name } }
          ... on UnlabeledEvent { id createdAt actor { __typename login avatarUrl } label { name } }
          ... on AssignedEvent { id createdAt actor { __typename login avatarUrl } assignee { __typename ... on User { login name } ... on Bot { login } } }
          ... on UnassignedEvent { id createdAt actor { __typename login avatarUrl } assignee { __typename ... on User { login name } ... on Bot { login } } }
          ... on RenamedTitleEvent { id createdAt actor { __typename login avatarUrl } currentTitle }
          ... on CrossReferencedEvent {
            id createdAt actor { __typename login avatarUrl }
            source {
              __typename
              ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
              ... on Issue { number repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}
"#;
    let data = graphql(
        cwd,
        host,
        "getIssue",
        detail_query,
        json!({ "owner": owner, "name": name, "number": number }),
    )?;
    let repo = data.get("repository").filter(|v| !v.is_null());
    let issue = repo.and_then(|r| r.get("issue")).filter(|v| !v.is_null());
    let (Some(repo), Some(issue)) = (repo, issue) else {
        return Err(TrackerError::new(
            "github",
            "getIssue",
            "not-found",
            "GitHub could not find the requested issue.",
        ));
    };
    let viewer = trimmed_opt(data.pointer("/viewer/login"));
    let mut summary = to_summary(issue);
    let mut labels_info = issue["labels"]["pageInfo"].clone();
    let mut assignees_info = issue["assignees"]["pageInfo"].clone();
    let mut closing_info = issue["closedByPullRequestsReferences"]["pageInfo"].clone();
    let mut extra_labels = Vec::new();
    let mut extra_assignees = Vec::new();
    let mut all_closing = issue
        .pointer("/closedByPullRequestsReferences/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen_pages = BTreeSet::new();
    let collections_query = r#"
query IssueCollections($owner: String!, $name: String!, $number: Int!, $labelsCursor: String, $assigneesCursor: String, $closingPullRequestsCursor: String, $withLabels: Boolean!, $withAssignees: Boolean!, $withClosingPullRequests: Boolean!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      labels(first: 100, after: $labelsCursor) @include(if: $withLabels) { pageInfo { hasNextPage endCursor } nodes { name color } }
      assignees(first: 100, after: $assigneesCursor) @include(if: $withAssignees) { pageInfo { hasNextPage endCursor } nodes { login name avatarUrl } }
      closedByPullRequestsReferences(first: 100, after: $closingPullRequestsCursor, includeClosedPrs: true) @include(if: $withClosingPullRequests) { pageInfo { hasNextPage endCursor } nodes { number title url state isDraft repository { nameWithOwner } } }
    }
  }
}
"#;
    while labels_info.get("hasNextPage") == Some(&json!(true))
        || assignees_info.get("hasNextPage") == Some(&json!(true))
        || closing_info.get("hasNextPage") == Some(&json!(true))
    {
        let lc = (labels_info.get("hasNextPage") == Some(&json!(true)))
            .then(|| trimmed_opt(labels_info.get("endCursor")))
            .flatten();
        let ac = (assignees_info.get("hasNextPage") == Some(&json!(true)))
            .then(|| trimmed_opt(assignees_info.get("endCursor")))
            .flatten();
        let cc = (closing_info.get("hasNextPage") == Some(&json!(true)))
            .then(|| trimmed_opt(closing_info.get("endCursor")))
            .flatten();
        let key_str = format!(
            "{} {} {}",
            lc.as_deref().unwrap_or(""),
            ac.as_deref().unwrap_or(""),
            cc.as_deref().unwrap_or("")
        );
        if (lc.is_none() && ac.is_none() && cc.is_none()) || !seen_pages.insert(key_str) {
            return Err(TrackerError::new(
                "github",
                "getIssue",
                "failed",
                "GitHub did not return complete issue labels, assignees or linked pull requests.",
            ));
        }
        let page = graphql(
            cwd,
            host,
            "getIssue",
            collections_query,
            json!({
                "owner": owner,
                "name": name,
                "number": number,
                "labelsCursor": lc,
                "assigneesCursor": ac,
                "closingPullRequestsCursor": cc,
                "withLabels": lc.is_some(),
                "withAssignees": ac.is_some(),
                "withClosingPullRequests": cc.is_some(),
            }),
        )?;
        let Some(next) = page.pointer("/repository/issue").filter(|v| !v.is_null()) else {
            return Err(TrackerError::new(
                "github",
                "getIssue",
                "not-found",
                "GitHub could not find the requested issue.",
            ));
        };
        if lc.is_some() {
            labels_info = next["labels"]["pageInfo"].clone();
            for l in next
                .pointer("/labels/nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(lname) = trimmed_opt(l.get("name")) {
                    extra_labels.push(json!({ "name": lname, "color": trimmed_opt(l.get("color")) }));
                }
            }
        }
        if ac.is_some() {
            assignees_info = next["assignees"]["pageInfo"].clone();
            for a in next
                .pointer("/assignees/nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let v = to_actor(Some(a));
                if !v.is_null() {
                    extra_assignees.push(v);
                }
            }
        }
        if cc.is_some() {
            closing_info = next["closedByPullRequestsReferences"]["pageInfo"].clone();
            if let Some(nodes) = next
                .pointer("/closedByPullRequestsReferences/nodes")
                .and_then(Value::as_array)
            {
                all_closing.extend(nodes.iter().cloned());
            }
        }
    }
    if let Some(arr) = summary["labels"].as_array_mut() {
        arr.extend(extra_labels);
    }
    if let Some(arr) = summary["assignees"].as_array_mut() {
        arr.extend(extra_assignees);
    }

    let mut pr_links = serde_json::Map::new();
    for node in &all_closing {
        if let Some(link) = to_linked_pr(node, true) {
            let k = format!(
                "{}#{}",
                link["repository"].as_str().unwrap_or("").to_ascii_lowercase(),
                link["number"].as_i64().unwrap_or(0)
            );
            pr_links.insert(k, link);
        }
    }
    let mut events = Vec::new();
    for item in issue
        .pointer("/timelineItems/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let typename = item.get("__typename").and_then(Value::as_str).unwrap_or("");
        if typename == "CrossReferencedEvent" {
            if item.pointer("/source/__typename").and_then(Value::as_str) == Some("PullRequest") {
                if let Some(link) = to_linked_pr(&item["source"], false) {
                    let k = format!(
                        "{}#{}",
                        link["repository"].as_str().unwrap_or("").to_ascii_lowercase(),
                        link["number"].as_i64().unwrap_or(0)
                    );
                    pr_links.entry(k).or_insert(link);
                }
            }
        }
        let parsed = match typename {
            "ClosedEvent" => Some(("closed", None)),
            "ReopenedEvent" => Some(("reopened", None)),
            "LabeledEvent" => Some(("labeled", trimmed_opt(item.pointer("/label/name")))),
            "UnlabeledEvent" => Some(("unlabeled", trimmed_opt(item.pointer("/label/name")))),
            "AssignedEvent" => Some(("assigned", trimmed_opt(item.pointer("/assignee/login")))),
            "UnassignedEvent" => Some(("unassigned", trimmed_opt(item.pointer("/assignee/login")))),
            "RenamedTitleEvent" => Some(("renamed", trimmed_opt(item.get("currentTitle")))),
            "CrossReferencedEvent" => {
                let r = trimmed_opt(item.pointer("/source/repository/nameWithOwner"));
                let n = item.pointer("/source/number").and_then(Value::as_i64).unwrap_or(0);
                let detail = r.filter(|_| n > 0).map(|repo| format!("{repo}#{n}"));
                Some(("referenced", detail))
            }
            _ => None,
        };
        if let (Some((kind, detail)), Some(id), Some(created_at)) = (
            parsed,
            trimmed_opt(item.get("id")),
            trimmed_opt(item.get("createdAt")),
        ) {
            events.push(json!({
                "id": id,
                "kind": kind,
                "detail": detail,
                "actor": to_actor(item.get("actor")),
                "createdAt": created_at,
            }));
        }
    }

    let vp = repo
        .get("viewerPermission")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_uppercase();
    let can_triage = matches!(vp.as_str(), "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE");
    let can_update = issue.get("viewerCanUpdate").and_then(Value::as_bool) != Some(false);
    let set_state = if issue.get("state").and_then(Value::as_str) == Some("CLOSED") {
        issue.get("viewerCanReopen").and_then(Value::as_bool) != Some(false)
    } else {
        issue.get("viewerCanClose").and_then(Value::as_bool) != Some(false)
    };
    let comments = issue
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| to_comment(c, viewer.as_deref()))
        .collect::<Vec<_>>();
    let comments_cursor =
        if issue.pointer("/comments/pageInfo/hasPreviousPage") == Some(&json!(true)) {
            trimmed_opt(issue.pointer("/comments/pageInfo/startCursor"))
        } else {
            None
        };
    let obj = summary.as_object_mut().unwrap();
    obj.insert("body".into(), json!(issue.get("body").and_then(Value::as_str).unwrap_or("")));
    obj.insert("viewer".into(), json!(viewer));
    obj.insert(
        "viewerPermissions".into(),
        json!({
            "setState": set_state,
            "comment": true,
            "edit": can_update,
            "labels": can_triage,
            "assignees": can_triage,
        }),
    );
    obj.insert("states".into(), issue_states());
    obj.insert("reactions".into(), Value::Array(to_reactions(issue.get("reactionGroups"), viewer.as_deref())));
    obj.insert("comments".into(), Value::Array(comments));
    obj.insert("commentsCursor".into(), json!(comments_cursor));
    obj.insert("events".into(), Value::Array(events));
    obj.insert("linkedPullRequests".into(), Value::Array(pr_links.into_values().collect()));
    Ok(summary)
}

pub fn get_comments(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    cursor: &str,
) -> Result<Value, TrackerError> {
    let (owner, name) = validate_repo(scope, "getComments")?;
    let number = parse_issue_number(key, "getComments")?;
    let query = r#"
fragment Reactions on Reactable {
  __typename
  reactionGroups {
    content viewerHasReacted
    reactors(first: 10) {
      totalCount
      nodes {
        __typename
        ... on User { login }
        ... on Bot { login }
        ... on Organization { login }
        ... on Mannequin { login }
      }
    }
  }
}
query IssueComments($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: 100, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { __typename login avatarUrl } body createdAt url ...Reactions }
      }
    }
  }
}
"#;
    let data = graphql(
        cwd,
        host,
        "getComments",
        query,
        json!({ "owner": owner, "name": name, "number": number, "cursor": cursor }),
    )?;
    let comments_conn = data
        .pointer("/repository/issue/comments")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            TrackerError::new(
                "github",
                "getComments",
                "not-found",
                "GitHub could not find the requested issue.",
            )
        })?;
    let viewer = trimmed_opt(data.pointer("/viewer/login"));
    let comments = comments_conn
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| to_comment(c, viewer.as_deref()))
        .collect::<Vec<_>>();
    let next_cursor =
        if comments_conn.pointer("/pageInfo/hasPreviousPage") == Some(&json!(true)) {
            trimmed_opt(comments_conn.pointer("/pageInfo/startCursor"))
        } else {
            None
        };
    Ok(json!({ "comments": comments, "nextCursor": next_cursor }))
}

fn verify_issue_node(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    operation: &str,
) -> Result<(String, String, i64, String, Option<String>, Option<String>), TrackerError> {
    let (owner, name) = validate_repo(scope, operation)?;
    let number = parse_issue_number(key, operation)?;
    let query = r#"
query IssueNodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { id state stateReason }
  }
}
"#;
    let data = graphql(
        cwd,
        host,
        operation,
        query,
        json!({ "owner": owner, "name": name, "number": number }),
    )?;
    let found = data
        .pointer("/repository/issue")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            TrackerError::new(
                "github",
                operation,
                "not-found",
                "GitHub could not find the requested issue.",
            )
        })?;
    let id = found["id"].as_str().unwrap_or("").to_owned();
    let state = trimmed_opt(found.get("state"));
    let reason = trimmed_opt(found.get("stateReason"));
    Ok((owner, name, number, id, state, reason))
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
    let (owner, name) = validate_repo(scope, "create")?;
    let res = rest(
        cwd,
        host,
        "create",
        "POST",
        &format!("repos/{owner}/{name}/issues"),
        Some(json!({
            "title": title,
            "body": body,
            "labels": labels,
            "assignees": assignees,
        })),
    )?;
    let number = res.get("number").and_then(Value::as_i64).ok_or_else(|| {
        TrackerError::new(
            "github",
            "create",
            "failed",
            "GitHub returned an unreadable create response.",
        )
    })?;
    let url = trimmed_opt(res.get("html_url")).ok_or_else(|| {
        TrackerError::new(
            "github",
            "create",
            "failed",
            "GitHub returned an unreadable create response.",
        )
    })?;
    Ok(IssueCreateResult {
        key: number.to_string(),
        display_key: format!("#{number}"),
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
    let (owner, name, number, _, _, _) = verify_issue_node(cwd, host, scope, key, "comment")?;
    rest(
        cwd,
        host,
        "comment",
        "POST",
        &format!("repos/{owner}/{name}/issues/{number}/comments"),
        Some(json!({ "body": body })),
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
    let (owner, name, number, _, _, _) = verify_issue_node(cwd, host, scope, key, "update")?;
    let mut patch = serde_json::Map::new();
    if let Some(t) = title {
        patch.insert("title".into(), json!(t));
    }
    if let Some(b) = body {
        patch.insert("body".into(), json!(b));
    }
    if let Some(l) = labels {
        patch.insert("labels".into(), json!(l));
    }
    if let Some(a) = assignees {
        patch.insert("assignees".into(), json!(a));
    }
    let res = rest(
        cwd,
        host,
        "update",
        "PATCH",
        &format!("repos/{owner}/{name}/issues/{number}"),
        Some(Value::Object(patch)),
    )?;
    let same_set = |wanted: &[String], got: BTreeSet<String>| {
        let w: BTreeSet<String> = wanted
            .iter()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        w == got
    };
    if let Some(wanted) = labels {
        if let Some(arr) = res.get("labels").and_then(Value::as_array) {
            let got: BTreeSet<String> = arr
                .iter()
                .filter_map(|v| {
                    v.as_str()
                        .or_else(|| v.get("name").and_then(Value::as_str))
                        .map(|s| s.trim().to_ascii_lowercase())
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !same_set(wanted, got) {
                return Err(TrackerError::new(
                    "github",
                    "update",
                    "failed",
                    "GitHub did not apply the labels or assignees. Changing them needs triage access to the repository.",
                ));
            }
        }
    }
    if let Some(wanted) = assignees {
        if let Some(arr) = res.get("assignees").and_then(Value::as_array) {
            let got: BTreeSet<String> = arr
                .iter()
                .filter_map(|v| v.get("login").and_then(Value::as_str))
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            if !same_set(wanted, got) {
                return Err(TrackerError::new(
                    "github",
                    "update",
                    "failed",
                    "GitHub did not apply the labels or assignees. Changing them needs triage access to the repository.",
                ));
            }
        }
    }
    Ok(())
}

pub fn set_state(
    cwd: &str,
    host: &str,
    scope: &str,
    key: &str,
    state_name: &str,
) -> Result<(), TrackerError> {
    let (owner, name, number, _, cur_state, cur_reason) =
        verify_issue_node(cwd, host, scope, key, "setState")?;
    let (category, reason) = match state_name {
        "Open" => ("open", None),
        "Completed" => ("closed", Some("completed")),
        "Not planned" => ("closed", Some("not_planned")),
        "Duplicate" => ("closed", Some("duplicate")),
        other => {
            return Err(TrackerError::new(
                "github",
                "setState",
                "failed",
                format!("A GitHub issue has no \"{other}\" state."),
            ));
        }
    };
    if let Some(r) = reason {
        if cur_state.as_deref() == Some("CLOSED")
            && !cur_reason
                .as_deref()
                .is_some_and(|cr| cr.eq_ignore_ascii_case(r))
        {
            return Err(TrackerError::new(
                "github",
                "setState",
                "failed",
                "GitHub cannot change why a closed issue was closed. Reopen it, then close it again.",
            ));
        }
    }
    let mut patch = json!({ "state": category });
    if let Some(r) = reason {
        patch["state_reason"] = json!(r);
    }
    rest(
        cwd,
        host,
        "setState",
        "PATCH",
        &format!("repos/{owner}/{name}/issues/{number}"),
        Some(patch),
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
    let Some(gh_content) = reaction_content_to_gh(content) else {
        return Err(TrackerError::new(
            "github",
            "setReaction",
            "failed",
            "Unsupported reaction.",
        ));
    };
    let resolved_subject = if let Some(cid) = subject_id {
        let (owner, name) = validate_repo(scope, "setReaction")?;
        let number = parse_issue_number(key, "setReaction")?;
        let data = graphql(
            cwd,
            host,
            "setReaction",
            "query IssueCommentScope($owner: String!, $name: String!, $number: Int!, $commentId: ID!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } node(id: $commentId) { __typename ... on IssueComment { issue { id } } } }",
            json!({ "owner": owner, "name": name, "number": number, "commentId": cid }),
        )?;
        let expected = data.pointer("/repository/issue/id").and_then(Value::as_str);
        let actual = data.pointer("/node/issue/id").and_then(Value::as_str);
        let typename = data.pointer("/node/__typename").and_then(Value::as_str);
        if expected.is_none() || typename != Some("IssueComment") || actual != expected {
            return Err(TrackerError::new(
                "github",
                "setReaction",
                "failed",
                "The comment does not belong to the selected issue.",
            ));
        }
        cid.to_owned()
    } else {
        verify_issue_node(cwd, host, scope, key, "setReaction")?.3
    };
    let mutation = if reacted {
        "mutation AddReaction($subjectId: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } } }"
    } else {
        "mutation RemoveReaction($subjectId: ID!, $content: ReactionContent!) { removeReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } } }"
    };
    graphql(
        cwd,
        host,
        "setReaction",
        mutation,
        json!({ "subjectId": resolved_subject, "content": gh_content }),
    )?;
    Ok(())
}

pub fn list_candidates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let (owner, name) = validate_repo(scope, "listCandidates")?;
    let query = r#"
query IssueCandidates($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100) { pageInfo { hasNextPage } nodes { name color description } }
    assignableUsers(first: 100) { pageInfo { hasNextPage } nodes { login name avatarUrl } }
  }
}
"#;
    let data = graphql(
        cwd,
        host,
        "listCandidates",
        query,
        json!({ "owner": owner, "name": name }),
    )?;
    let repo = data
        .get("repository")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            TrackerError::new(
                "github",
                "listCandidates",
                "not-found",
                "GitHub could not find the requested repository.",
            )
        })?;
    let labels = repo
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let lname = trimmed_opt(l.get("name"))?;
            Some(json!({
                "name": lname,
                "color": l.get("color").and_then(Value::as_str).unwrap_or(""),
                "description": l.get("description").and_then(Value::as_str),
            }))
        })
        .collect::<Vec<_>>();
    let assignees = repo
        .pointer("/assignableUsers/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let mut actor = to_actor(Some(u));
            let login = actor.get("login")?.as_str()?.to_owned();
            actor["id"] = json!(login);
            Some(actor)
        })
        .collect::<Vec<_>>();
    let truncated = repo.pointer("/labels/pageInfo/hasNextPage") == Some(&json!(true))
        || repo.pointer("/assignableUsers/pageInfo/hasNextPage") == Some(&json!(true));
    Ok(json!({ "labels": labels, "assignees": assignees, "truncated": truncated }))
}

fn unquote_yaml_scalar(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        return t[1..t.len() - 1].to_owned();
    }
    t.to_owned()
}

fn parse_config_blank_enabled(text: &str) -> bool {
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("blank_issues_enabled:") {
            let val = t.trim_start_matches("blank_issues_enabled:").trim();
            return val != "false";
        }
    }
    true
}

fn parse_yaml_issue_form(filename: &str, text: &str) -> Option<Value> {
    let mut name = String::new();
    let mut about = String::new();
    let mut title = String::new();
    let mut labels = Vec::new();
    let mut assignees = Vec::new();
    let mut sections = Vec::new();
    let mut in_body = false;
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim();
        i += 1;
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !raw.starts_with(' ') && !raw.starts_with('\t') {
            in_body = trimmed == "body:";
            if let Some(rest) = trimmed.strip_prefix("name:") {
                name = unquote_yaml_scalar(rest);
            } else if let Some(rest) = trimmed.strip_prefix("description:") {
                about = unquote_yaml_scalar(rest);
            } else if let Some(rest) = trimmed.strip_prefix("title:") {
                title = unquote_yaml_scalar(rest);
            } else if let Some(rest) = trimmed.strip_prefix("labels:") {
                let r = rest.trim().trim_start_matches('[').trim_end_matches(']');
                for item in r.split(',').map(unquote_yaml_scalar).filter(|s| !s.is_empty()) {
                    labels.push(item);
                }
            } else if let Some(rest) = trimmed.strip_prefix("assignees:") {
                let r = rest.trim().trim_start_matches('[').trim_end_matches(']');
                for item in r.split(',').map(unquote_yaml_scalar).filter(|s| !s.is_empty()) {
                    assignees.push(item);
                }
            }
        } else if in_body {
            if let Some(rest) = trimmed.strip_prefix("label:") {
                let lbl = unquote_yaml_scalar(rest);
                if !lbl.is_empty() {
                    sections.push(format!("### {lbl}"));
                }
            } else if let Some(rest) = trimmed.strip_prefix("value:") {
                let val = unquote_yaml_scalar(rest);
                if !val.is_empty() && val != "|" && val != ">" {
                    sections.push(val);
                }
            } else if let Some(rest) = trimmed.strip_prefix("placeholder:") {
                let ph = unquote_yaml_scalar(rest);
                if !ph.is_empty() {
                    sections.push(format!("Example:\n> {ph}"));
                }
            }
        }
    }
    if name.trim().is_empty() {
        return None;
    }
    Some(json!({
        "key": filename,
        "name": name,
        "about": about,
        "title": title,
        "body": sections.join("\n\n"),
        "labels": labels,
        "assignees": assignees,
    }))
}

pub fn list_templates(cwd: &str, host: &str, scope: &str) -> Result<Value, TrackerError> {
    let (owner, name) = validate_repo(scope, "listTemplates")?;
    let query = r#"
query IssueTemplates($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    templateDirectory: object(expression: "HEAD:.github/ISSUE_TEMPLATE") {
      __typename
      ... on Tree {
        entries {
          name
          object { __typename ... on Blob { text isTruncated } }
        }
      }
    }
    issueTemplates {
      filename name about title body
      assignees(first: 25) { nodes { login } }
      labels(first: 50) { nodes { name } }
    }
  }
}
"#;
    let data = graphql(
        cwd,
        host,
        "listTemplates",
        query,
        json!({ "owner": owner, "name": name }),
    )?;
    let repo = data
        .get("repository")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            TrackerError::new(
                "github",
                "listTemplates",
                "not-found",
                "GitHub could not find the requested repository.",
            )
        })?;
    let mut templates = Vec::new();
    let mut seen_keys = BTreeSet::new();
    for tpl in repo
        .get("issueTemplates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(filename) = trimmed_opt(tpl.get("filename")) else {
            continue;
        };
        seen_keys.insert(filename.clone());
        let labels = tpl
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|n| trimmed_opt(n.get("name")))
            .collect::<Vec<_>>();
        let assignees = tpl
            .pointer("/assignees/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|n| trimmed_opt(n.get("login")))
            .collect::<Vec<_>>();
        templates.push(json!({
            "key": filename,
            "name": tpl.get("name").and_then(Value::as_str).unwrap_or(""),
            "about": tpl.get("about").and_then(Value::as_str).unwrap_or(""),
            "title": tpl.get("title").and_then(Value::as_str).unwrap_or(""),
            "body": tpl.get("body").and_then(Value::as_str).unwrap_or(""),
            "labels": labels,
            "assignees": assignees,
        }));
    }
    let mut blank_issues_enabled = true;
    for entry in repo
        .pointer("/templateDirectory/entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let fname = entry.get("name").and_then(Value::as_str).unwrap_or("");
        let text = entry.pointer("/object/text").and_then(Value::as_str);
        let truncated = entry.pointer("/object/isTruncated").and_then(Value::as_bool) == Some(true);
        let Some(text) = text.filter(|_| !truncated) else {
            continue;
        };
        if fname.eq_ignore_ascii_case("config.yml") || fname.eq_ignore_ascii_case("config.yaml") {
            blank_issues_enabled = parse_config_blank_enabled(text);
        } else if (fname.ends_with(".yml") || fname.ends_with(".yaml")) && !seen_keys.contains(fname) {
            if let Some(parsed) = parse_yaml_issue_form(fname, text) {
                seen_keys.insert(fname.to_owned());
                templates.push(parsed);
            }
        }
    }
    Ok(json!({ "templates": templates, "blankIssuesEnabled": blank_issues_enabled }))
}
