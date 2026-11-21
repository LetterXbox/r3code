//! Issue tracking service: aggregates git-host and standalone (Linear) issue trackers.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::Mutex,
};
use url::Url;

pub mod azure_devops;
pub mod forgejo;
pub mod github;
pub mod gitlab;
pub mod linear;
pub mod trackers;

const DEFAULT_LIST_LIMIT: i64 = 50;

#[derive(Clone, Debug)]
pub struct TrackerError {
    pub tracker: String,
    pub operation: String,
    pub reason: &'static str,
    pub detail: String,
    pub retry_at: Option<i64>,
}

impl TrackerError {
    pub fn new(
        tracker: impl Into<String>,
        operation: impl Into<String>,
        reason: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            tracker: tracker.into(),
            operation: operation.into(),
            reason,
            detail: detail.into(),
            retry_at: None,
        }
    }

    pub fn detail_text(&self) -> String {
        let t = self.detail.trim();
        if t.is_empty() {
            "The issue tracker request failed.".to_owned()
        } else {
            t.to_owned()
        }
    }

    pub fn is_unusable(&self) -> bool {
        matches!(self.reason, "missing-tool" | "unauthenticated")
    }

    pub fn to_issue_error(&self, operation: &str) -> Value {
        if self.is_unusable() {
            let reason = if self.reason == "missing-tool" {
                "tool-missing"
            } else {
                "unauthenticated"
            };
            return json!({
                "_tag": "IssueUnavailableError",
                "reason": reason,
                "tracker": self.tracker,
            });
        }
        let mut obj = json!({
            "_tag": "IssueOperationError",
            "operation": operation,
            "detail": self.detail_text(),
        });
        if matches!(self.reason, "not-found" | "rate-limited") {
            obj["reason"] = json!(self.reason);
        }
        if let Some(retry_at) = self.retry_at {
            obj["retryAt"] = json!(retry_at);
        }
        obj
    }
}

pub fn capabilities(
    create: bool,
    edit: bool,
    comment: bool,
    labels: bool,
    assignees: bool,
    reactions: bool,
    templates: bool,
    linked_pull_requests: bool,
    events: bool,
    search: bool,
) -> Value {
    json!({
        "create": create,
        "edit": edit,
        "comment": comment,
        "labels": labels,
        "assignees": assignees,
        "reactions": reactions,
        "templates": templates,
        "linkedPullRequests": linked_pull_requests,
        "events": events,
        "search": search,
    })
}

fn tracker_capabilities(tracker: &str) -> Option<Value> {
    match tracker {
        "github" => Some(github::caps()),
        "gitlab" => Some(gitlab::caps()),
        "azure-devops" => Some(azure_devops::caps()),
        "forgejo" => Some(forgejo::caps()),
        "linear" => Some(linear::caps()),
        _ => None,
    }
}

fn read_only_error(operation: &str) -> Value {
    json!({
        "_tag": "IssueOperationError",
        "operation": operation,
        "reason": "read-only",
        "detail": "This issue belongs to a repository outside the selected project and cannot be changed from here.",
    })
}

fn operation_error(operation: &str, detail: &str) -> Value {
    json!({
        "_tag": "IssueOperationError",
        "operation": operation,
        "detail": detail,
    })
}

fn not_found_error(operation: &str, detail: &str) -> Value {
    json!({
        "_tag": "IssueOperationError",
        "operation": operation,
        "reason": "not-found",
        "detail": detail,
    })
}

fn unsupported_error() -> Value {
    json!({
        "_tag": "IssueUnavailableError",
        "reason": "tracker-unsupported",
    })
}

fn unsupported_capability(operation: &str, what: &str) -> Value {
    operation_error(operation, &format!("This tracker does not support {what}."))
}

#[derive(Clone, Debug)]
pub struct ListInput {
    pub project_id: Option<String>,
    pub exclude_project_ids: Vec<String>,
    pub host: Option<String>,
    pub state: String,
    pub involvement: String,
    pub query: Option<String>,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
    pub sort: String,
    pub limit: i64,
    pub cursor: Option<String>,
    pub cursors: Option<HashMap<String, String>>,
    pub refresh: bool,
}

impl ListInput {
    pub fn from_payload(payload: &Value) -> Self {
        let str_opt = |k: &str| {
            payload
                .get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let list_strings = |k: &str| -> Vec<String> {
            payload
                .get(k)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
                .collect()
        };
        let cursors = payload.get("cursors").and_then(Value::as_object).map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        });
        Self {
            project_id: str_opt("projectId"),
            exclude_project_ids: list_strings("excludeProjectIds"),
            host: str_opt("host"),
            state: str_opt("state").unwrap_or_else(|| "open".into()),
            involvement: str_opt("involvement").unwrap_or_else(|| "all".into()),
            query: str_opt("query"),
            labels: list_strings("labels"),
            assignee: str_opt("assignee"),
            sort: str_opt("sort").unwrap_or_else(|| "updated".into()),
            limit: payload
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_LIST_LIMIT)
                .clamp(1, 100),
            cursor: None,
            cursors,
            refresh: payload.get("refresh").and_then(Value::as_bool) == Some(true),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProjectRow {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
    pub identity: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct BoundTracker {
    pub project: ProjectRow,
    pub tracker: String,
    pub host: String,
    pub scope: String,
}

fn identity_host(identity: &Value, tracker: Option<&str>) -> Option<String> {
    if tracker == Some("azure-devops") {
        if let Some(web) = identity.get("webUrl").and_then(Value::as_str) {
            if let Ok(u) = Url::parse(web) {
                return u.host_str().map(str::to_ascii_lowercase);
            }
        }
        return Some("dev.azure.com".into());
    }
    if let Some(web) = identity.get("webUrl").and_then(Value::as_str) {
        if let Ok(u) = Url::parse(web) {
            return Some(u.host().map(|h| h.to_string()).unwrap_or_default().to_ascii_lowercase()).map(|_| {
                match u.port() {
                    Some(p) => format!("{}:{p}", u.host_str().unwrap_or("").to_ascii_lowercase()),
                    None => u.host_str().unwrap_or("").to_ascii_lowercase(),
                }
            });
        }
    }
    identity
        .get("canonicalKey")
        .and_then(Value::as_str)
        .and_then(|ck| ck.split('/').next())
        .map(str::to_ascii_lowercase)
}

fn issue_scope_from_identity(identity: &Value) -> Option<String> {
    let provider = identity.get("provider").and_then(Value::as_str)?;
    let display = identity
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ck = identity.get("canonicalKey").and_then(Value::as_str).unwrap_or("");
    match provider {
        "azure-devops" => {
            // canonicalKey is e.g. dev.azure.com/org/project/_git/repo
            let parts: Vec<&str> = ck.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() >= 3 {
                Some(format!("{}/{}", parts[1], parts[2]))
            } else {
                display.map(str::to_owned)
            }
        }
        _ => display
            .map(str::to_owned)
            .or_else(|| {
                let tail = ck.split('/').skip(1).collect::<Vec<_>>().join("/");
                (!tail.is_empty()).then_some(tail)
            }),
    }
}

pub fn git_host_bindings_for_project(project: &ProjectRow) -> Vec<(String, String, String)> {
    let Some(identity) = project.identity.as_ref() else {
        return Vec::new();
    };
    let Some(tracker) = identity.get("provider").and_then(Value::as_str) else {
        return Vec::new();
    };
    if tracker == "unknown" || tracker.is_empty() {
        return Vec::new();
    }
    let Some(scope) = issue_scope_from_identity(identity) else {
        return Vec::new();
    };
    let Some(host) = identity_host(identity, Some(tracker)) else {
        return Vec::new();
    };
    let mut out = vec![(tracker.to_owned(), host.clone(), scope.clone())];
    if let Some(origin) = identity.get("origin").filter(|v| !v.is_null()) {
        let origin_host = identity_host(origin, None);
        if origin_host.as_deref() == Some(host.as_str()) {
            let mut synth = origin.clone();
            synth["provider"] = json!(tracker);
            if let Some(origin_scope) = issue_scope_from_identity(&synth) {
                if !origin_scope.eq_ignore_ascii_case(&scope) {
                    out.push((tracker.to_owned(), host, origin_scope));
                }
            }
        }
    }
    out
}

pub fn load_project_rows(db: &Connection, filter_project_id: Option<&str>) -> Vec<ProjectRow> {
    let mut stmt = match db.prepare(
        "SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL ORDER BY rowid",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten()
        .filter(|(id, _, _)| filter_project_id.is_none_or(|f| id == f))
        .map(|(id, title, workspace_root)| ProjectRow {
            id,
            title,
            workspace_root,
            identity: None,
        })
        .collect()
}

fn list_projects(
    db: &Mutex<Connection>,
    filter_project_id: Option<&str>,
    exclude_project_ids: &[String],
    host_filter: Option<&str>,
    authority_filter: Option<&str>,
) -> (Vec<BoundTracker>, Vec<(String, String, usize)>) {
    let (mut projects, bindings) = {
        let guard = match db.lock() {
            Ok(g) => g,
            Err(_) => return (Vec::new(), Vec::new()),
        };
        let projects = load_project_rows(&guard, filter_project_id);
        let bindings = trackers::list_bindings(&guard).unwrap_or_default();
        (projects, bindings)
    };
    for p in &mut projects {
        if !exclude_project_ids.contains(&p.id) {
            p.identity = crate::repository_identity::resolve(&p.workspace_root);
        }
    }
    let host_f = host_filter.map(|h| h.trim().to_ascii_lowercase());
    let auth_f = authority_filter.map(|h| h.trim().to_ascii_lowercase());
    let mut supported = Vec::new();
    let mut unimplemented: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();

    for project in projects {
        if exclude_project_ids.contains(&project.id) {
            continue;
        }
        let mut candidates: Vec<(String, String, String)> = Vec::new();
        if let Some(binding) = bindings.get(&project.id) {
            if binding.tracker == trackers::LINEAR_KIND {
                candidates.push((
                    binding.tracker.clone(),
                    linear::LINEAR_HOST.to_owned(),
                    binding.scope.clone(),
                ));
            }
        }
        candidates.extend(git_host_bindings_for_project(&project));
        for (tracker, host, scope) in candidates {
            if let Some(ref hf) = host_f {
                if &host != hf && auth_f.as_deref() != Some(host.as_str()) {
                    continue;
                }
            }
            if tracker_capabilities(&tracker).is_none() {
                let entry = unimplemented
                    .entry(host.clone())
                    .or_insert_with(|| (tracker.clone(), BTreeSet::new()));
                entry.1.insert(project.id.clone());
                continue;
            }
            supported.push(BoundTracker {
                project: project.clone(),
                tracker,
                host,
                scope,
            });
        }
    }
    let unimpl_out = unimplemented
        .into_iter()
        .map(|(h, (t, set))| (h, t, set.len()))
        .collect();
    (supported, unimpl_out)
}

#[derive(Clone, Debug)]
pub struct ResolvedProject {
    pub bound: BoundTracker,
    pub writable: bool,
}

fn require_project(db: &Mutex<Connection>, payload: &Value) -> Result<ResolvedProject, Value> {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(unsupported_error)?;
    let tracker = payload
        .get("tracker")
        .and_then(Value::as_str)
        .ok_or_else(unsupported_error)?;
    let scope = payload
        .get("scope")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(unsupported_error)?;
    let host_opt = payload
        .get("host")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    let (supported, _) = list_projects(db, Some(project_id), &[], None, None);
    let on_host: Vec<BoundTracker> = supported
        .into_iter()
        .filter(|c| c.tracker == tracker && host_opt.as_deref().is_none_or(|h| c.host == h))
        .collect();
    let own = on_host
        .iter()
        .find(|c| c.scope.eq_ignore_ascii_case(scope))
        .cloned();
    let served = own.clone().or_else(|| on_host.into_iter().next()).ok_or_else(unsupported_error)?;
    Ok(ResolvedProject {
        bound: BoundTracker {
            project: served.project,
            tracker: served.tracker,
            host: served.host,
            scope: scope.to_owned(),
        },
        writable: own.is_some(),
    })
}

fn require_writable(db: &Mutex<Connection>, payload: &Value, operation: &str) -> Result<ResolvedProject, Value> {
    let resolved = require_project(db, payload)?;
    if !resolved.writable {
        return Err(read_only_error(operation));
    }
    Ok(resolved)
}

fn list_cursor_key(host: &str, scope: &str) -> String {
    format!("{host} {}", scope.to_ascii_lowercase())
}

fn require_linear_token(secrets_dir: &Path, operation: &str) -> Result<String, TrackerError> {
    trackers::read_tracker_token(secrets_dir, trackers::LINEAR_KIND)
        .map_err(|_| {
            TrackerError::new(
                "linear",
                operation,
                "failed",
                "The stored credential could not be read.",
            )
        })?
        .ok_or_else(|| {
            TrackerError::new(
                "linear",
                operation,
                "unauthenticated",
                "Linear is not connected on this server.",
            )
        })
}

async fn get_viewer_for(
    bound: &BoundTracker,
    secrets_dir: &Path,
) -> Result<String, TrackerError> {
    let cwd = bound.project.workspace_root.clone();
    let host = bound.host.clone();
    match bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "getViewer")?;
            linear::get_viewer(&tok).await
        }
        "github" => tokio::task::spawn_blocking(move || github::get_viewer(&cwd, &host))
            .await
            .map_err(|_| TrackerError::new("github", "getViewer", "failed", "Task failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::get_viewer(&cwd, &host))
            .await
            .map_err(|_| TrackerError::new("gitlab", "getViewer", "failed", "Task failed"))?,
        "azure-devops" => Ok(azure_devops::get_viewer()),
        "forgejo" => forgejo::get_viewer(&cwd, &host).await,
        other => Err(TrackerError::new(other, "getViewer", "failed", "Unsupported tracker")),
    }
}

pub async fn list(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let input = ListInput::from_payload(payload);
    let (supported, unimplemented) = list_projects(
        db,
        input.project_id.as_deref(),
        &input.exclude_project_ids,
        None,
        None,
    );

    let mut trackers_map: BTreeMap<String, Value> = BTreeMap::new();
    let mut counted = BTreeSet::new();
    for p in &supported {
        let ckey = format!("{} {}", p.host, p.project.id);
        if !counted.insert(ckey) {
            continue;
        }
        if let Some(existing) = trackers_map.get_mut(&p.host) {
            let cur = existing["projectCount"].as_u64().unwrap_or(0);
            existing["projectCount"] = json!(cur + 1);
        } else {
            trackers_map.insert(
                p.host.clone(),
                json!({
                    "tracker": p.tracker,
                    "host": p.host,
                    "projectCount": 1,
                    "capabilities": tracker_capabilities(&p.tracker),
                    "configured": true,
                    "detail": Value::Null,
                }),
            );
        }
    }
    for (host, tracker, count) in unimplemented {
        trackers_map.insert(
            host.clone(),
            json!({
                "tracker": tracker,
                "host": host,
                "projectCount": count,
                "capabilities": Value::Null,
                "configured": false,
                "detail": "Issues cannot be browsed for this host yet.",
            }),
        );
    }

    let mut scopes_map: Vec<(String, BoundTracker)> = Vec::new();
    let mut seen_scope_keys = BTreeSet::new();
    for p in &supported {
        if input.host.as_deref().is_some_and(|h| !p.host.eq_ignore_ascii_case(h)) {
            continue;
        }
        let k = list_cursor_key(&p.host, &p.scope);
        if seen_scope_keys.insert(k.clone()) {
            scopes_map.push((k, p.clone()));
        }
    }

    let mut viewers = serde_json::Map::new();
    let mut viewer_cache = HashMap::<String, Result<String, TrackerError>>::new();
    if input.involvement != "all" {
        for (_, b) in &scopes_map {
            if !viewer_cache.contains_key(&b.host) {
                let res = get_viewer_for(b, secrets_dir).await;
                if let Ok(ref v) = res {
                    viewers.insert(b.host.clone(), json!(v));
                }
                viewer_cache.insert(b.host.clone(), res);
            }
        }
    }

    let mut entries = Vec::new();
    let mut errors = Vec::new();
    let mut next_cursors = serde_json::Map::new();
    for (key, b) in &scopes_map {
        let cursor = match input.cursors.as_ref() {
            None => None,
            Some(c) => match c.get(key) {
                None => continue,
                Some(v) => Some(v.as_str()),
            },
        };
        let viewer_val = if input.involvement == "all" {
            Ok(None)
        } else {
            match viewer_cache.get(&b.host) {
                Some(Ok(v)) => Ok(Some(v.clone())),
                Some(Err(err)) => Err(err.clone()),
                None => Ok(None),
            }
        };
        let mut scope_input = input.clone();
        scope_input.cursor = cursor.map(str::to_owned);
        let page_res = match viewer_val {
            Err(err) => Err(err),
            Ok(viewer_opt) => {
                let cwd = b.project.workspace_root.clone();
                let host = b.host.clone();
                let scope = b.scope.clone();
                let involvement = input.involvement.clone();
                match b.tracker.as_str() {
                    "linear" => match require_linear_token(secrets_dir, "listIssues") {
                        Ok(tok) => {
                            linear::list_issues(&tok, &scope, &involvement, viewer_opt.as_deref(), &scope_input).await
                        }
                        Err(e) => Err(e),
                    },
                    "github" => tokio::task::spawn_blocking(move || {
                        github::list_issues(&cwd, &host, &scope, &involvement, viewer_opt.as_deref(), &scope_input)
                    })
                    .await
                    .map_err(|_| TrackerError::new("github", "listIssues", "failed", "Task failed"))
                    .and_then(|r| r),
                    "gitlab" => tokio::task::spawn_blocking(move || {
                        gitlab::list_issues(&cwd, &host, &scope, &involvement, viewer_opt.as_deref(), &scope_input)
                    })
                    .await
                    .map_err(|_| TrackerError::new("gitlab", "listIssues", "failed", "Task failed"))
                    .and_then(|r| r),
                    "azure-devops" => tokio::task::spawn_blocking(move || {
                        azure_devops::list_issues(&cwd, &host, &scope, &involvement, &scope_input)
                    })
                    .await
                    .map_err(|_| TrackerError::new("azure-devops", "listIssues", "failed", "Task failed"))
                    .and_then(|r| r),
                    "forgejo" => {
                        forgejo::list_issues(&cwd, &host, &scope, &involvement, viewer_opt.as_deref(), &scope_input).await
                    }
                    other => Err(TrackerError::new(other, "listIssues", "failed", "Unsupported tracker")),
                }
            }
        };
        match page_res {
            Err(err) => {
                if let Some(c) = cursor {
                    next_cursors.insert(key.clone(), json!(c));
                }
                if err.is_unusable() {
                    if let Some(t) = trackers_map.get_mut(&b.host) {
                        t["configured"] = json!(false);
                        t["detail"] = json!(err.detail_text());
                    }
                }
                let forked = supported
                    .iter()
                    .any(|other| other.project.id == b.project.id && other.scope != b.scope);
                let title = if forked {
                    format!("{} ({})", b.project.title, b.scope)
                } else {
                    b.project.title.clone()
                };
                errors.push(json!({
                    "projectId": b.project.id,
                    "projectTitle": title,
                    "message": err.detail_text(),
                }));
            }
            Ok((items, next_c)) => {
                for mut item in items {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("tracker".into(), json!(b.tracker));
                        obj.insert("host".into(), json!(b.host));
                        obj.insert("scope".into(), json!(b.scope));
                        obj.insert("projectId".into(), json!(b.project.id));
                        obj.insert("projectTitle".into(), json!(b.project.title));
                    }
                    entries.push(item);
                }
                if let Some(nc) = next_c {
                    next_cursors.insert(key.clone(), json!(nc));
                }
            }
        }
    }
    entries.sort_by(|a, b| {
        let ua = a.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let ub = b.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        ub.cmp(ua)
    });
    let scope_refs = scopes_map
        .into_iter()
        .map(|(_, b)| {
            json!({
                "projectId": b.project.id,
                "tracker": b.tracker,
                "host": b.host,
                "scope": b.scope,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "viewers": Value::Object(viewers),
        "trackers": trackers_map.into_values().collect::<Vec<_>>(),
        "entries": entries,
        "errors": errors,
        "nextCursors": Value::Object(next_cursors),
        "scopes": scope_refs,
    }))
}

fn attach_detail_fields(resolved: &ResolvedProject, mut detail: Value) -> Value {
    if let Some(obj) = detail.as_object_mut() {
        obj.insert("tracker".into(), json!(resolved.bound.tracker));
        obj.insert("host".into(), json!(resolved.bound.host));
        obj.insert("scope".into(), json!(resolved.bound.scope));
        obj.insert("projectId".into(), json!(resolved.bound.project.id));
        obj.insert("projectTitle".into(), json!(resolved.bound.project.title));
        obj.insert("writable".into(), json!(resolved.writable));
        obj.insert(
            "capabilities".into(),
            tracker_capabilities(&resolved.bound.tracker).unwrap_or(Value::Null),
        );
    }
    detail
}

pub async fn detail_resolved(
    resolved: &ResolvedProject,
    secrets_dir: &Path,
    key: &str,
) -> Result<Value, Value> {
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let key_s = key.to_owned();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "getIssue")
                .map_err(|e| e.to_issue_error("detail"))?;
            linear::get_issue(&tok, &key_s).await
        }
        "github" => tokio::task::spawn_blocking(move || github::get_issue(&cwd, &host, &scope, &key_s))
            .await
            .map_err(|_| operation_error("detail", "Issue read failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::get_issue(&cwd, &host, &scope, &key_s))
            .await
            .map_err(|_| operation_error("detail", "Issue read failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::get_issue(&cwd, &host, &scope, &key_s))
                .await
                .map_err(|_| operation_error("detail", "Issue read failed"))?
        }
        "forgejo" => forgejo::get_issue(&cwd, &host, &scope, &key_s).await,
        _ => return Err(unsupported_error()),
    };
    res.map(|v| attach_detail_fields(resolved, v))
        .map_err(|e| e.to_issue_error("detail"))
}

pub async fn detail(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_project(db, payload)?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("detail", "Issue key is required."))?;
    detail_resolved(&resolved, secrets_dir, key).await
}

pub async fn comments(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_project(db, payload)?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("comments", "Issue key is required."))?
        .to_owned();
    let cursor = payload
        .get("cursor")
        .and_then(Value::as_str)
        .ok_or_else(|| operation_error("comments", "Comment cursor is required."))?
        .to_owned();
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "getComments")
                .map_err(|e| e.to_issue_error("comments"))?;
            linear::get_comments(&tok, &key, &cursor).await
        }
        "github" => tokio::task::spawn_blocking(move || github::get_comments(&cwd, &host, &scope, &key, &cursor))
            .await
            .map_err(|_| operation_error("comments", "Comments read failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::get_comments(&cwd, &host, &scope, &key, &cursor))
            .await
            .map_err(|_| operation_error("comments", "Comments read failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::get_comments(&cwd, &host, &scope, &key, &cursor))
                .await
                .map_err(|_| operation_error("comments", "Comments read failed"))?
        }
        "forgejo" => forgejo::get_comments(&cwd, &host, &scope, &key, &cursor).await,
        _ => return Err(unsupported_error()),
    };
    res.map_err(|e| e.to_issue_error("comments"))
}

pub async fn templates(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_project(db, payload)?;
    let caps = tracker_capabilities(&resolved.bound.tracker).ok_or_else(unsupported_error)?;
    if caps.get("templates").and_then(Value::as_bool) != Some(true) {
        return Err(unsupported_capability("templates", "issue templates"));
    }
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "listTemplates")
                .map_err(|e| e.to_issue_error("templates"))?;
            linear::list_templates(&tok, &scope).await
        }
        "github" => tokio::task::spawn_blocking(move || github::list_templates(&cwd, &host, &scope))
            .await
            .map_err(|_| operation_error("templates", "Templates read failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::list_templates(&cwd, &host, &scope))
            .await
            .map_err(|_| operation_error("templates", "Templates read failed"))?,
        "forgejo" => forgejo::list_templates(&cwd, &host, &scope).await,
        _ => return Err(unsupported_capability("templates", "issue templates")),
    };
    res.map_err(|e| e.to_issue_error("templates"))
}

pub async fn candidates(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_project(db, payload)?;
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "listCandidates")
                .map_err(|e| e.to_issue_error("candidates"))?;
            linear::list_candidates(&tok, &scope).await
        }
        "github" => tokio::task::spawn_blocking(move || github::list_candidates(&cwd, &host, &scope))
            .await
            .map_err(|_| operation_error("candidates", "Candidates read failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::list_candidates(&cwd, &host, &scope))
            .await
            .map_err(|_| operation_error("candidates", "Candidates read failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::list_candidates(&cwd, &host, &scope))
                .await
                .map_err(|_| operation_error("candidates", "Candidates read failed"))?
        }
        "forgejo" => forgejo::list_candidates(&cwd, &host, &scope).await,
        _ => return Err(unsupported_error()),
    };
    res.map_err(|e| e.to_issue_error("candidates"))
}

#[derive(Clone, Debug)]
pub struct IssueCreateResult {
    pub key: String,
    pub display_key: String,
    pub url: String,
}

fn string_vec(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}

pub async fn create(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_writable(db, payload, "create")?;
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| operation_error("create", "Issue title is required."))?
        .to_owned();
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("").to_owned();
    let labels = string_vec(payload.get("labels"));
    let assignees = string_vec(payload.get("assignees"));
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "create")
                .map_err(|e| e.to_issue_error("create"))?;
            linear::create(&tok, &scope, &title, &body, &labels, &assignees).await
        }
        "github" => tokio::task::spawn_blocking(move || github::create(&cwd, &host, &scope, &title, &body, &labels, &assignees))
            .await
            .map_err(|_| operation_error("create", "Issue create failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::create(&cwd, &host, &scope, &title, &body, &labels, &assignees))
            .await
            .map_err(|_| operation_error("create", "Issue create failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::create(&cwd, &host, &scope, &title, &body, &labels, &assignees))
                .await
                .map_err(|_| operation_error("create", "Issue create failed"))?
        }
        "forgejo" => forgejo::create(&cwd, &host, &scope, &title, &body, &labels, &assignees).await,
        _ => return Err(unsupported_error()),
    };
    let created = res.map_err(|e| e.to_issue_error("create"))?;
    Ok(json!({
        "key": created.key,
        "displayKey": created.display_key,
        "url": created.url,
    }))
}

pub async fn comment(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_writable(db, payload, "comment")?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("comment", "Issue key is required."))?
        .to_owned();
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("").to_owned();
    if body.trim().is_empty() {
        return Err(operation_error("comment", "A comment needs some text."));
    }
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "comment")
                .map_err(|e| e.to_issue_error("comment"))?;
            linear::comment(&tok, &scope, &key, &body).await
        }
        "github" => tokio::task::spawn_blocking(move || github::comment(&cwd, &host, &scope, &key, &body))
            .await
            .map_err(|_| operation_error("comment", "Comment failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::comment(&cwd, &host, &scope, &key, &body))
            .await
            .map_err(|_| operation_error("comment", "Comment failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::comment(&cwd, &host, &scope, &key, &body))
                .await
                .map_err(|_| operation_error("comment", "Comment failed"))?
        }
        "forgejo" => forgejo::comment(&cwd, &host, &scope, &key, &body).await,
        _ => return Err(unsupported_error()),
    };
    res.map(|()| json!({})).map_err(|e| e.to_issue_error("comment"))
}

pub async fn update(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_writable(db, payload, "update")?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("update", "Issue key is required."))?
        .to_owned();
    let title = payload.get("title").and_then(Value::as_str).map(str::to_owned);
    let body = payload.get("body").and_then(Value::as_str).map(str::to_owned);
    let labels = payload.get("labels").map(|v| string_vec(Some(v)));
    let assignees = payload.get("assignees").map(|v| string_vec(Some(v)));
    if title.is_none() && body.is_none() && labels.is_none() && assignees.is_none() {
        return Err(operation_error("update", "Nothing to change."));
    }
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "update")
                .map_err(|e| e.to_issue_error("update"))?;
            linear::update(
                &tok,
                &scope,
                &key,
                title.as_deref(),
                body.as_deref(),
                labels.as_deref(),
                assignees.as_deref(),
            )
            .await
        }
        "github" => tokio::task::spawn_blocking(move || {
            github::update(
                &cwd,
                &host,
                &scope,
                &key,
                title.as_deref(),
                body.as_deref(),
                labels.as_deref(),
                assignees.as_deref(),
            )
        })
        .await
        .map_err(|_| operation_error("update", "Update failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || {
            gitlab::update(
                &cwd,
                &host,
                &scope,
                &key,
                title.as_deref(),
                body.as_deref(),
                labels.as_deref(),
                assignees.as_deref(),
            )
        })
        .await
        .map_err(|_| operation_error("update", "Update failed"))?,
        "azure-devops" => tokio::task::spawn_blocking(move || {
            azure_devops::update(
                &cwd,
                &host,
                &scope,
                &key,
                title.as_deref(),
                body.as_deref(),
                labels.as_deref(),
                assignees.as_deref(),
            )
        })
        .await
        .map_err(|_| operation_error("update", "Update failed"))?,
        "forgejo" => {
            forgejo::update(
                &cwd,
                &host,
                &scope,
                &key,
                title.as_deref(),
                body.as_deref(),
                labels.as_deref(),
                assignees.as_deref(),
            )
            .await
        }
        _ => return Err(unsupported_error()),
    };
    res.map(|()| json!({})).map_err(|e| e.to_issue_error("update"))
}

pub async fn set_state(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_writable(db, payload, "setState")?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("setState", "Issue key is required."))?
        .to_owned();
    let state_name = payload
        .get("state")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| operation_error("setState", "Target state is required."))?
        .to_owned();
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "setState")
                .map_err(|e| e.to_issue_error("setState"))?;
            linear::set_state(&tok, &scope, &key, &state_name).await
        }
        "github" => tokio::task::spawn_blocking(move || github::set_state(&cwd, &host, &scope, &key, &state_name))
            .await
            .map_err(|_| operation_error("setState", "State change failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || gitlab::set_state(&cwd, &host, &scope, &key, &state_name))
            .await
            .map_err(|_| operation_error("setState", "State change failed"))?,
        "azure-devops" => {
            tokio::task::spawn_blocking(move || azure_devops::set_state(&cwd, &host, &scope, &key, &state_name))
                .await
                .map_err(|_| operation_error("setState", "State change failed"))?
        }
        "forgejo" => forgejo::set_state(&cwd, &host, &scope, &key, &state_name).await,
        _ => return Err(unsupported_error()),
    };
    res.map(|()| json!({})).map_err(|e| e.to_issue_error("setState"))
}

pub async fn react(db: &Mutex<Connection>, secrets_dir: &Path, payload: &Value) -> Result<Value, Value> {
    let resolved = require_writable(db, payload, "react")?;
    let key = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| not_found_error("react", "Issue key is required."))?
        .to_owned();
    let subject_id = payload
        .get("subjectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| operation_error("react", "Reaction content is required."))?
        .to_owned();
    let reacted = payload
        .get("reacted")
        .and_then(Value::as_bool)
        .ok_or_else(|| operation_error("react", "Reaction state is required."))?;
    let cwd = resolved.bound.project.workspace_root.clone();
    let host = resolved.bound.host.clone();
    let scope = resolved.bound.scope.clone();
    let res = match resolved.bound.tracker.as_str() {
        "linear" => {
            let tok = require_linear_token(secrets_dir, "setReaction")
                .map_err(|e| e.to_issue_error("react"))?;
            linear::set_reaction(&tok, &scope, &key, subject_id.as_deref(), &content, reacted).await
        }
        "github" => tokio::task::spawn_blocking(move || {
            github::set_reaction(&cwd, &host, &scope, &key, subject_id.as_deref(), &content, reacted)
        })
        .await
        .map_err(|_| operation_error("react", "Reaction failed"))?,
        "gitlab" => tokio::task::spawn_blocking(move || {
            gitlab::set_reaction(&cwd, &host, &scope, &key, subject_id.as_deref(), &content, reacted)
        })
        .await
        .map_err(|_| operation_error("react", "Reaction failed"))?,
        "azure-devops" => tokio::task::spawn_blocking(move || {
            azure_devops::set_reaction(&cwd, &host, &scope, &key, subject_id.as_deref(), &content, reacted)
        })
        .await
        .map_err(|_| operation_error("react", "Reaction failed"))?,
        "forgejo" => {
            forgejo::set_reaction(&cwd, &host, &scope, &key, subject_id.as_deref(), &content, reacted)
                .await
        }
        _ => return Err(unsupported_error()),
    };
    res.map(|()| json!({})).map_err(|e| e.to_issue_error("react"))
}

pub fn project_scope(db: &Mutex<Connection>, project_id: &str) -> Result<BoundTracker, Value> {
    let (supported, _) = list_projects(db, Some(project_id), &[], None, None);
    supported.into_iter().next().ok_or_else(unsupported_error)
}

pub fn parse_issue_url_any(url_str: &str) -> Option<(String, String, String, String, Option<String>)> {
    let url = Url::parse(url_str.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if let Some(lin) = linear::parse_linear_issue_url(&url) {
        return Some(("linear".into(), lin.host, lin.scope, lin.key, Some(lin.workspace)));
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let authority = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    let segs: Vec<&str> = url.path_segments()?.collect();
    if segs.len() >= 4 && segs[2] == "issues" {
        // GitHub / Forgejo style: /<owner>/<repo>/issues/<number>
        let num = segs[3].trim();
        if num.chars().all(|c| c.is_ascii_digit()) && !num.is_empty() {
            let scope = format!("{}/{}", segs[0], segs[1]);
            let tracker = if host == "codeberg.org" || host.contains("forgejo") || host.contains("gitea") {
                "forgejo"
            } else {
                "github"
            };
            return Some((tracker.into(), authority, scope, num.into(), None));
        }
    }
    if let Some(pos) = segs.windows(2).position(|w| w == ["-", "issues"]) {
        if let Some(num) = segs.get(pos + 2).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())) {
            let scope = segs[..pos].join("/");
            return Some(("gitlab".into(), authority, scope, (*num).to_owned(), None));
        }
    }
    if let Some(pos) = segs.windows(2).position(|w| w == ["_workitems", "edit"]) {
        if let Some(num) = segs.get(pos + 2).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())) {
            let scope = if pos >= 2 {
                format!("{}/{}", segs[0], segs[1])
            } else {
                segs[..pos].join("/")
            };
            return Some(("azure-devops".into(), host, scope, (*num).to_owned(), None));
        }
    }
    None
}

pub async fn resolve_url(
    db: &Mutex<Connection>,
    secrets_dir: &Path,
    url_str: &str,
    preferred_project_id: Option<&str>,
) -> Result<(ResolvedProject, String, Option<Value>), Value> {
    let Some((tracker, host, scope, key, linear_ws)) = parse_issue_url_any(url_str) else {
        return Err(not_found_error("resolveUrl", "This is not a recognised issue URL."));
    };
    let host_only = host.split(':').next().unwrap_or(&host);
    let (supported, _) = list_projects(db, None, &[], Some(host_only), Some(&host));
    let on_tracker: Vec<BoundTracker> = supported
        .into_iter()
        .filter(|b| b.tracker == tracker)
        .collect();
    let prefer = |items: Vec<BoundTracker>| -> Option<BoundTracker> {
        if let Some(pref) = preferred_project_id {
            if let Some(hit) = items.iter().find(|b| b.project.id == pref) {
                return Some(hit.clone());
            }
        }
        items.into_iter().next()
    };
    let own = prefer(
        on_tracker
            .iter()
            .filter(|b| b.scope.eq_ignore_ascii_case(&scope))
            .cloned()
            .collect(),
    );
    let lender = own.clone().or_else(|| prefer(on_tracker)).ok_or_else(unsupported_error)?;
    let resolved = ResolvedProject {
        bound: BoundTracker {
            project: lender.project,
            tracker: lender.tracker,
            host: lender.host,
            scope: if own.is_some() { lender.scope } else { scope },
        },
        writable: own.is_some(),
    };
    if let Some(expected_ws) = linear_ws {
        let detail_val = detail_resolved(&resolved, secrets_dir, &key).await?;
        let canonical = detail_val
            .get("url")
            .and_then(Value::as_str)
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| linear::parse_linear_issue_url(&u));
        if canonical.as_ref().is_none_or(|c| c.workspace != expected_ws) {
            return Err(not_found_error(
                "resolveUrl",
                "This issue URL does not belong to the connected workspace.",
            ));
        }
        return Ok((resolved, key, Some(detail_val)));
    }
    Ok((resolved, key, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_url_and_identifier_parsing_match_contracts() {
        let u = Url::parse("https://linear.app/acme/issue/ENG-123/some-slug").unwrap();
        let parsed = linear::parse_linear_issue_url(&u).unwrap();
        assert_eq!(parsed.workspace, "acme");
        assert_eq!(parsed.scope, "ENG");
        assert_eq!(parsed.key, "ENG-123");
        assert_eq!(linear::parse_identifier(" eng-42 "), Some("ENG-42".into()));
        assert_eq!(linear::parse_identifier("ENG-0"), None);
    }

    #[test]
    fn tracker_secret_and_binding_round_trip() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p1','Proj','/tmp/p1','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let db = Mutex::new(conn);
        let dir = std::env::temp_dir().join(format!("issue-tracker-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        trackers::bind_project(
            &db,
            &json!({
                "projectId": "p1",
                "binding": { "tracker": "linear", "scope": "ENG" }
            }),
        )
        .unwrap();
        let map = trackers::list_bindings(&db.lock().unwrap()).unwrap();
        assert_eq!(map["p1"].scope, "ENG");
        assert_eq!(map["p1"].tracker, "linear");
        trackers::bind_project(&db, &json!({ "projectId": "p1", "binding": null })).unwrap();
        let map = trackers::list_bindings(&db.lock().unwrap()).unwrap();
        assert!(!map.contains_key("p1"));
        assert_eq!(
            trackers::issue_tracker_secret_name("linear"),
            "issue-tracker-bGluZWFy-token"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fork_origin_bindings_include_upstream_and_fork() {
        let p = ProjectRow {
            id: "p1".into(),
            title: "Repo".into(),
            workspace_root: "/tmp/repo".into(),
            identity: Some(json!({
                "provider": "github",
                "canonicalKey": "github.com/upstream/repo",
                "displayName": "upstream/repo",
                "webUrl": "https://github.com/upstream/repo",
                "origin": {
                    "canonicalKey": "github.com/fork/repo",
                    "displayName": "fork/repo",
                    "webUrl": "https://github.com/fork/repo"
                }
            })),
        };
        let bindings = git_host_bindings_for_project(&p);
        assert_eq!(
            bindings,
            vec![
                ("github".into(), "github.com".into(), "upstream/repo".into()),
                ("github".into(), "github.com".into(), "fork/repo".into()),
            ]
        );
    }
}
