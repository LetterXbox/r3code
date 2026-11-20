//! GitLab merge request reads through glab's REST API.
use crate::github_pinned_credential::{self, CommandFailure};
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn read(
    project: &(String, String, String, Option<Value>),
    input: &Value,
    detail: bool,
) -> Result<Value, Value> {
    let operation = if detail { "detail" } else { "summary" };
    let error = || json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"The pull request could not be read."});
    // An account-pinned read must never silently fall back to glab's active account.
    if input.get("expectedAccountId").is_some() {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."}),
        );
    }
    let identity = project.3.as_ref().ok_or_else(error)?;
    let repo = identity["displayName"].as_str().ok_or_else(error)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|v| v.split_once('/'))
        .map(|v| v.0)
        .ok_or_else(error)?;
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
    let path = format!(
        "projects/{encoded}/merge_requests/{}?include_diverged_commits_count=true",
        input["number"].as_u64().unwrap()
    );
    let mut cmd = Command::new("glab");
    cmd.args(["api", &path])
        .current_dir(&project.2)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let mut exit_code = None;
    let bytes = github_pinned_credential::run_classified_with_status(
        &mut cmd,
        Duration::from_secs(10),
        &mut exit_code,
    )
    .map_err(|failure| read_failure(failure, operation, &project.2, exit_code))?;
    let mr: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
    if mr["iid"].as_u64().is_none_or(|n| n == 0)
        || [
            "title",
            "web_url",
            "state",
            "source_branch",
            "target_branch",
            "created_at",
            "updated_at",
        ]
        .iter()
        .any(|k| mr[*k].as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err(error());
    }
    let mut result = map(&mr, project, repo, detail);
    // These fields are not available on the REST merge request response. GitLab hosts
    // may reject newer GraphQL fields, so each enrichment is best effort.
    let number = input["number"].as_u64().unwrap();
    let path_literal = serde_json::to_string(repo).unwrap();
    let iid_literal = serde_json::to_string(&number.to_string()).unwrap();
    let stats_query = format!("query {{ project(fullPath: {path_literal}) {{ mergeRequests(iids: [{iid_literal}], first: 100) {{ nodes {{ iid diffStatsSummary {{ additions deletions }} }} }} }} }}");
    if let Some(data) = optional_graphql(project, host, &stats_query, operation)? {
        if let Some(nodes) = data["data"]["project"]["mergeRequests"]["nodes"].as_array() {
            if let Some(stats) = nodes
                .iter()
                .find(|n| n["iid"].as_str() == Some(&number.to_string()))
            {
                if let (Some(additions), Some(deletions)) = (
                    stats["diffStatsSummary"]["additions"].as_i64(),
                    stats["diffStatsSummary"]["deletions"].as_i64(),
                ) {
                    result["additions"] = json!(additions);
                    result["deletions"] = json!(deletions);
                }
            }
        }
    }
    if !detail {
        let query = format!("query {{ metadata {{ enterprise }} project(fullPath: {path_literal}) {{ mergeRequests(iids: [{iid_literal}], first: 100) {{ nodes {{ iid approved approvedBy(first: 1) {{ nodes {{ username }} }} reviewers(first: 20) {{ nodes {{ mergeRequestInteraction {{ reviewState }} }} }} headPipeline {{ status }} }} }} }} }}");
        if let Some(data) = optional_graphql(project, host, &query, operation)? {
            if let Some(nodes) = data["data"]["project"]["mergeRequests"]["nodes"].as_array() {
                if let Some(node) = nodes
                    .iter()
                    .find(|n| n["iid"].as_str() == Some(&number.to_string()))
                {
                    apply_list_state(&mut result, node, &data["data"]["metadata"]["enterprise"]);
                }
            }
        }
    }
    if detail {
        let query = format!("query {{ project(fullPath: {path_literal}) {{ mergeRequest(iid: {iid_literal}) {{ userPermissions {{ adminMergeRequest }} }} }} }}");
        if let Some(data) = optional_graphql(project, host, &query, operation)? {
            result["viewerPermissions"]["labels"] = json!(
                data["data"]["project"]["mergeRequest"]["userPermissions"]["adminMergeRequest"]
                    == true
            );
        }
        let fork = mr["source_project_id"]
            .as_u64()
            .zip(mr["target_project_id"].as_u64())
            .is_some_and(|(a, b)| a != b);
        if fork {
            result["maintainerCanModify"] = json!(mr["allow_collaboration"] == true);
            if result["state"] == "open" {
                let query = format!("query {{ currentUser {{ username }} project(fullPath: {path_literal}) {{ visibility mergeRequest(iid: {iid_literal}) {{ author {{ username }} userPermissions {{ pushToSourceBranch }} sourceBranchProtected sourceProject {{ visibility }} }} }} }}");
                if let Some(data) = optional_graphql(project, host, &query, operation)? {
                    let project = &data["data"]["project"];
                    let request = &project["mergeRequest"];
                    let visible = |v: &Value| matches!(v.as_str(), Some("public" | "internal"));
                    let user = data["data"]["currentUser"]["username"].as_str();
                    result["viewerPermissions"]["maintainerEdits"] = json!(
                        user.is_some()
                            && user == request["author"]["username"].as_str()
                            && request["userPermissions"]["pushToSourceBranch"] == true
                            && request["sourceBranchProtected"] == false
                            && visible(&project["visibility"])
                            && visible(&request["sourceProject"]["visibility"])
                    );
                }
            }
        }
        if result["state"] != "open" {
            let query = format!("query {{ project(fullPath: {path_literal}) {{ mergeRequest(iid: {iid_literal}) {{ userPermissions {{ removeSourceBranch }} }} }} }}");
            if let Some(data) = optional_graphql(project, host, &query, operation)? {
                if data["data"]["project"]["mergeRequest"]["userPermissions"]["removeSourceBranch"]
                    == true
                {
                    result["viewerPermissions"]["actions"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("delete-branch"));
                }
            }
        }
        if input["downstreamChecks"] != false {
            if let (Some(pipeline_id), Some(pipeline_project_id)) = (
                mr["head_pipeline"]["id"].as_u64(),
                mr["head_pipeline"]["project_id"].as_u64(),
            ) {
                let query = format!("query {{ project(fullPath: {path_literal}) {{ mergeRequest(iid: {iid_literal}) {{ headPipeline {{ path stages(first: 100) {{ nodes {{ name status detailedStatus {{ label detailsPath }} jobs(first: 100) {{ nodes {{ name status allowFailure retried webPath detailedStatus {{ label }} downstreamPipeline {{ status path }} }} pageInfo {{ hasNextPage }} }} }} pageInfo {{ hasNextPage }} }} }} }} }} }}");
                let origin = mr["web_url"].as_str().and_then(|url| {
                    let origin = url::Url::parse(url).ok()?.origin().ascii_serialization();
                    (origin != "null").then_some(origin)
                });
                let stages = if let Some(origin) = origin {
                    optional_graphql(project, host, &query, operation)?
                        .and_then(|data| pipeline_checks(&data, &origin))
                } else {
                    None
                };
                if let Some(checks) = stages {
                    result["checks"] = json!(checks);
                } else {
                    let path = format!("projects/{pipeline_project_id}/pipelines/{pipeline_id}/bridges?per_page=100");
                    let mut cmd = Command::new("glab");
                    cmd.args(["api", &path])
                        .current_dir(&project.2)
                        .env("GITLAB_HOST", host)
                        .env("GLAB_PROMPT_DISABLED", "1");
                    let mut exit_code = None;
                    let response = github_pinned_credential::run_classified_with_status(
                        &mut cmd,
                        Duration::from_secs(10),
                        &mut exit_code,
                    );
                    if let Some(bytes) =
                        optional_command(response, operation, &project.2, exit_code)?
                    {
                        if let Ok(bridges) = serde_json::from_slice::<Value>(&bytes) {
                            result["checks"]
                                .as_array_mut()
                                .unwrap()
                                .extend(bridge_checks(&bridges));
                        }
                    }
                }
            }
        }
        let mut cmd = Command::new("glab");
        cmd.args(["api", &format!("projects/{encoded}?license=false")])
            .current_dir(&project.2)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        let mut exit_code = None;
        let response = github_pinned_credential::run_classified_with_status(
            &mut cmd,
            Duration::from_secs(10),
            &mut exit_code,
        );
        let settings: Value = serde_json::from_slice(
            &response.map_err(|failure| read_failure(failure, operation, &project.2, exit_code))?,
        )
        .map_err(|_| error())?;
        if !settings.is_object() {
            return Err(error());
        }
        let method = settings["merge_method"].as_str().unwrap_or("");
        let squash = settings["squash_option"].as_str().unwrap_or("");
        let mut viewer_cmd = Command::new("glab");
        viewer_cmd
            .args(["api", "user"])
            .current_dir(&project.2)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        let mut exit_code = None;
        let response = github_pinned_credential::run_classified_with_status(
            &mut viewer_cmd,
            Duration::from_secs(10),
            &mut exit_code,
        );
        let viewer: Value = serde_json::from_slice(
            &response.map_err(|failure| read_failure(failure, operation, &project.2, exit_code))?,
        )
        .map_err(|_| error())?;
        let username = viewer["username"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(error)?;
        result["viewer"] = json!(username);
        result["mergeCapabilities"] = json!({"merge":method=="merge","rebase":matches!(method,"rebase_merge"|"ff"),"squash":matches!(squash,"always"|"default_on"|"default_off")});
    }
    Ok(result)
}
fn pipeline_status(value: &Value) -> &'static str {
    match value
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "success" => "success",
        "failed" => "failure",
        "canceled" | "canceling" => "cancelled",
        "skipped" => "skipped",
        "manual" => "neutral",
        _ => "pending",
    }
}

fn trimmed(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn pipeline_checks(data: &Value, origin: &str) -> Option<Vec<Value>> {
    let pipeline = &data["data"]["project"]["mergeRequest"]["headPipeline"];
    let stages = pipeline["stages"]["nodes"].as_array()?;
    if pipeline["stages"]["pageInfo"]["hasNextPage"] == true
        || stages.iter().any(|s| trimmed(&s["name"]).is_none())
    {
        return None;
    }
    let link = |path: Option<&str>| {
        path.filter(|p| p.starts_with('/'))
            .map(|p| format!("{origin}{p}"))
    };
    let mut checks = Vec::new();
    for stage in stages {
        let name = trimmed(&stage["name"])?;
        let jobs = stage["jobs"]["nodes"].as_array();
        let whole = jobs.is_some_and(|j| {
            !j.is_empty()
                && stage["jobs"]["pageInfo"]["hasNextPage"] != true
                && j.iter().all(|job| trimmed(&job["name"]).is_some())
        });
        if !whole {
            checks.push(json!({"name":name,"status":pipeline_status(&stage["status"]),"description":trimmed(&stage["detailedStatus"]["label"]),"url":link(trimmed(&stage["detailedStatus"]["detailsPath"]).or_else(|| trimmed(&pipeline["path"]))) }));
            continue;
        }
        for job in jobs.unwrap() {
            if job["retried"] == true {
                continue;
            }
            let downstream = &job["downstreamPipeline"];
            let is_downstream = downstream.is_object();
            let status = pipeline_status(if is_downstream {
                &downstream["status"]
            } else {
                &job["status"]
            });
            checks.push(json!({"name":format!("{name} / {}", trimmed(&job["name"])?),"status":if status == "failure" && job["allowFailure"] == true { "neutral" } else { status },"description":if is_downstream { Some("Downstream pipeline") } else { trimmed(&job["detailedStatus"]["label"]) },"url":link(trimmed(if is_downstream { &downstream["path"] } else { &job["webPath"] }))}));
        }
    }
    if checks.is_empty() {
        None
    } else {
        Some(checks)
    }
}

fn bridge_checks(data: &Value) -> Vec<Value> {
    let Some(rows) = data.as_array().filter(|r| r.len() < 100) else {
        return Vec::new();
    };
    rows.iter().filter_map(|row| {
        let downstream = row["downstream_pipeline"].as_object()?;
        let name = trimmed(&row["name"])?;
        let status = pipeline_status(downstream.get("status").unwrap_or(&Value::Null));
        Some(json!({"name":name,"status":if status == "failure" && row["allow_failure"] == true { "neutral" } else { status },"description":"Downstream pipeline","url":trimmed(downstream.get("web_url").unwrap_or(&Value::Null))}))
    }).collect()
}
pub(crate) fn read_failure(
    failure: CommandFailure,
    operation: &str,
    cwd: &str,
    exit_code: Option<i32>,
) -> Value {
    let provider_operation = match operation {
        "summary" => "getChangeRequestSummary",
        "preview" => "getChangeRequestPreview",
        _ => "getChangeRequest",
    };
    let cause = |kind: &str, detail: &str, process_detail: &str| {
        json!({
            "name":"PullRequestProviderError", "message":format!("gitlab failed in {provider_operation}: {detail}"),
            "cause": {"name":kind,"message":format!("GitLab CLI failed in execute: {detail}"),
                "cause":{"name":"VcsProcessExitError","message":format!("VCS process failed in GitLabCli.execute: glab ({cwd}) exited with {} - {process_detail}", exit_code.map_or_else(|| "unknown".to_owned(), |code| code.to_string()))}}
        })
    };
    match failure {
        CommandFailure::Spawn(_) => {
            json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"gitlab"})
        }
        CommandFailure::Unauthenticated => {
            let detail = "GitLab CLI is not authenticated. Run `glab auth login` and retry.";
            json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"gitlab","requirement":detail,"cause":cause("GitLabCliAuthenticationError", detail, "Authentication failed.")})
        }
        CommandFailure::RateLimited => {
            let detail = "GitLab API rate limit exceeded.";
            json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail,"cause":cause("GitLabCliRateLimitError", detail, "API rate limit exceeded.")})
        }
        CommandFailure::NotFound => {
            json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"The pull request could not be read.","reason":"not-found"})
        }
        _ => {
            json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"The pull request could not be read."})
        }
    }
}

fn optional_command(
    result: Result<Vec<u8>, CommandFailure>,
    operation: &str,
    cwd: &str,
    exit_code: Option<i32>,
) -> Result<Option<Vec<u8>>, Value> {
    match result {
        Ok(bytes) => Ok(Some(bytes)),
        Err(
            failure @ (CommandFailure::Spawn(_)
            | CommandFailure::Unauthenticated
            | CommandFailure::RateLimited),
        ) => Err(read_failure(failure, operation, cwd, exit_code)),
        Err(_) => Ok(None),
    }
}

fn optional_graphql(
    project: &(String, String, String, Option<Value>),
    host: &str,
    query: &str,
    operation: &str,
) -> Result<Option<Value>, Value> {
    let mut cmd = Command::new("glab");
    cmd.args([
        "api",
        "graphql",
        "--method",
        "POST",
        "--raw-field",
        &format!("query={query}"),
    ])
    .current_dir(&project.2)
    .env("GITLAB_HOST", host)
    .env("GLAB_PROMPT_DISABLED", "1");
    let mut exit_code = None;
    let response = github_pinned_credential::run_classified_with_status(
        &mut cmd,
        Duration::from_secs(10),
        &mut exit_code,
    );
    let Some(bytes) = optional_command(response, operation, &project.2, exit_code)? else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    if value.get("errors").is_some() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

pub(crate) fn apply_list_state(result: &mut Value, node: &Value, enterprise: &Value) {
    let checks = match node["headPipeline"]["status"]
        .as_str()
        .map(|s| s.trim().to_ascii_lowercase())
    {
        None => Value::Null,
        Some(s) => match s.as_str() {
            "success" => json!("passing"),
            "failed" | "canceled" | "canceling" => json!("failing"),
            "skipped" | "manual" => Value::Null,
            _ => json!("pending"),
        },
    };
    result["checksState"] = checks;
    let requested = node["reviewers"]["nodes"].as_array().is_some_and(|nodes| {
        nodes
            .iter()
            .any(|n| n["mergeRequestInteraction"]["reviewState"] == "REQUESTED_CHANGES")
    });
    if requested {
        result["reviewDecision"] = json!("changes-requested");
        return;
    }
    if let (Some(approved), Some(approvals)) = (
        node["approved"].as_bool(),
        node["approvedBy"]["nodes"].as_array(),
    ) {
        if !approved && approvals.is_empty() && enterprise.is_null() {
            return;
        }
        result["reviewDecision"] = if !approved && (enterprise == true || !approvals.is_empty()) {
            json!("review-required")
        } else if !approvals.is_empty() {
            json!("approved")
        } else {
            Value::Null
        };
    }
}
fn actor(v: &Value) -> Value {
    match v["username"].as_str().filter(|s| !s.trim().is_empty()) {
        Some(login) => json!({"login":login,"name":v["name"],"avatarUrl":v["avatar_url"]}),
        None => Value::Null,
    }
}
pub(crate) fn action_summary(
    mr: &Value,
    project: &(String, String, String, Option<Value>),
    repo: &str,
) -> Option<Value> {
    if mr["iid"].as_u64().is_none_or(|n| n == 0)
        || [
            "title",
            "web_url",
            "state",
            "source_branch",
            "target_branch",
            "created_at",
            "updated_at",
        ]
        .iter()
        .any(|k| mr[*k].as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return None;
    }
    let mut v = map(mr, project, repo, false);
    let obj = v.as_object_mut()?;
    for key in ["additions", "deletions", "changedFiles"] {
        obj.remove(key);
    }
    if mr["merge_when_pipeline_succeeds"].is_boolean() || mr["auto_merge_enabled"].is_boolean() {
        let enabled =
            mr["merge_when_pipeline_succeeds"] == true || mr["auto_merge_enabled"] == true;
        obj.insert("autoMergeEnabled".into(), json!(enabled));
        if enabled && mr["squash_on_merge"] == true {
            obj.insert("autoMergeMethod".into(), json!("squash"));
        }
    }
    Some(v)
}

fn map(
    mr: &Value,
    project: &(String, String, String, Option<Value>),
    repo: &str,
    detail: bool,
) -> Value {
    let state = match mr["state"].as_str() {
        Some("merged") => "merged",
        Some("closed") => "closed",
        _ => "open",
    };
    let mergeability = match mr["detailed_merge_status"]
        .as_str()
        .or_else(|| mr["merge_status"].as_str())
    {
        Some("mergeable" | "can_be_merged") => "mergeable",
        Some("conflict" | "cannot_be_merged") => "conflicting",
        _ => "unknown",
    };
    let changed = mr["changes_count"]
        .as_str()
        .and_then(|s| s.trim_end_matches('+').parse::<u64>().ok())
        .or_else(|| mr["changes_count"].as_u64())
        .unwrap_or(0);
    let draft = mr["draft"]
        .as_bool()
        .or_else(|| mr["work_in_progress"].as_bool())
        .unwrap_or(false);
    let status = mr["head_pipeline"]["status"].as_str();
    let mut result = json!({"provider":"gitlab","projectId":project.0,"repository":repo,"number":mr["iid"],"title":mr["title"],"url":mr["web_url"],"state":state,"isDraft":draft,"headBranch":mr["source_branch"],"baseBranch":mr["target_branch"],"closedAt":mr["closed_at"],"mergedAt":mr["merged_at"],"updatedAt":mr["updated_at"],"observedAt":chrono::Utc::now().timestamp_millis(),"author":actor(&mr["author"]),"additions":0,"deletions":0,"changedFiles":changed,"mergeability":mergeability});
    match mr["detailed_merge_status"].as_str() {
        Some("need_rebase") => result["rebaseRequired"] = json!(true),
        Some("mergeable") => result["rebaseRequired"] = json!(false),
        _ => {}
    }
    if let Some(sha) = mr["sha"].as_str().filter(|s| !s.is_empty()) {
        result["headSha"] = json!(sha);
    }
    if detail {
        let reviewers: Vec<_> = mr["reviewers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(actor)
            .filter(|v| !v.is_null())
            .collect();
        let labels: Vec<_> = mr["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(|name| json!({"name":name,"color":null})))
            .collect();
        let checks = status.map(|s| vec![json!({"name":"Pipeline","status":match s {"success"=>"success","failed"=>"failure","canceled"|"canceling"=>"cancelled","skipped"=>"skipped","manual"=>"neutral",_=>"pending"},"description":mr["head_pipeline"]["source"],"url":mr["head_pipeline"]["web_url"]})]).unwrap_or_default();
        let can_merge = mr["user"]["can_merge"] != false;
        let mut actions = Vec::new();
        if can_merge {
            actions.push("merge");
        }
        actions.extend(["ready", "draft", "close", "reopen"]);
        if can_merge {
            actions.extend([
                "update-branch",
                "enable-auto-merge",
                "disable-auto-merge",
            ]);
        }
        let caps = json!({"diff":true,"comment":true,"actions":["merge","ready","draft","close","reopen","update-branch","enable-auto-merge","disable-auto-merge","delete-branch"],"mergeMethods":["merge","squash","rebase"],"deleteBranch":true,"updateMethods":["rebase"],"search":true,"reactions":true,"mentions":true,"referenceSigils":["#","!"],"viewedFiles":"environment","review":{"inlineComment":true,"reply":true,"resolve":true,"verdicts":["comment","approve","request-changes"]},"reviewers":{"request":true,"listCandidates":true,"searchCandidates":true},"labels":true,"edit":{"changeRequest":true,"comment":true,"maintainerEdits":true}});
        let behind = mr["diverged_commits_count"].as_u64();
        let obj = result.as_object_mut().unwrap();
        obj.extend(json!({"capabilities":caps,"viewerPermissions":{"actions":actions,"comment":true,"resolve":true,"verdicts":["comment","approve","request-changes"],"requestReviewers":true,"maintainerEdits":false,"labels":false},"projectTitle":project.1,"workspaceRoot":project.2,"body":mr["description"].as_str().unwrap_or(""),"createdAt":mr["created_at"],"reviewers":reviewers,"labels":labels,"checks":checks,"mergeCapabilities":{"merge":false,"squash":false,"rebase":false},"baseComparison":behind.map_or("unknown",|n|if n>0 {"behind"} else {"up-to-date"})}).as_object().unwrap().clone());
        if can_merge {
            obj["viewerPermissions"]["updateMethods"] = json!(["rebase"]);
        }
        if let Some(n) = behind {
            obj.insert("behindBy".into(), json!(n));
        }
        if let Some(sha) = mr["sha"].as_str().filter(|s| !s.is_empty()) {
            obj.insert("headSha".into(), json!(sha));
        }
        if mr["merge_when_pipeline_succeeds"].is_boolean() || mr["auto_merge_enabled"].is_boolean()
        {
            obj.insert(
                "autoMergeEnabled".into(),
                json!(
                    mr["merge_when_pipeline_succeeds"] == true || mr["auto_merge_enabled"] == true
                ),
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_reads_only_suppress_recoverable_failures() {
        for operation in ["summary", "detail"] {
            assert!(
                optional_command(Err(CommandFailure::Failed), operation, "/repo", Some(1))
                    .unwrap()
                    .is_none()
            );
            assert!(
                optional_command(Err(CommandFailure::NotFound), operation, "/repo", Some(1))
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                optional_command(
                    Err(CommandFailure::Unauthenticated),
                    operation,
                    "/repo",
                    Some(1)
                )
                .unwrap_err()["reason"],
                "cli-unauthenticated"
            );
            assert_eq!(
                optional_command(
                    Err(CommandFailure::Spawn(std::io::ErrorKind::NotFound)),
                    operation,
                    "/repo",
                    Some(1)
                )
                .unwrap_err()["reason"],
                "cli-missing"
            );
            let rate = optional_command(
                Err(CommandFailure::RateLimited),
                operation,
                "/repo",
                Some(1),
            )
            .unwrap_err();
            assert_eq!(rate["detail"], "GitLab API rate limit exceeded.");
            assert_eq!(rate["operation"], operation);
            let alternate_exit =
                read_failure(CommandFailure::RateLimited, operation, "/repo", Some(42));
            assert!(alternate_exit["cause"]["cause"]["cause"]["message"]
                .as_str()
                .unwrap()
                .contains("exited with 42"));
        }
    }
    #[test]
    fn maps_graphql_summary_state() {
        let mut result = json!({});
        apply_list_state(
            &mut result,
            &json!({"headPipeline":{"status":"failed"},"approved":false,"approvedBy":{"nodes":[]},"reviewers":{"nodes":[]}}),
            &json!(true),
        );
        assert_eq!(result["checksState"], "failing");
        assert_eq!(result["reviewDecision"], "review-required");
        let mut result = json!({});
        apply_list_state(
            &mut result,
            &json!({"reviewers":{"nodes":[{"mergeRequestInteraction":{"reviewState":"REQUESTED_CHANGES"}}]}}),
            &Value::Null,
        );
        assert_eq!(result["reviewDecision"], "changes-requested");
        assert!(result["checksState"].is_null());
    }
    #[test]
    fn expands_pipeline_jobs_and_falls_back_for_partial_stages() {
        let data = json!({"data":{"project":{"mergeRequest":{"headPipeline":{"path":"/pipeline/1","stages":{"nodes":[
            {"name":"build","jobs":{"nodes":[{"name":"test","status":"FAILED","allowFailure":true,"webPath":"/job/1"},{"name":"old","retried":true},{"name":"trigger","downstreamPipeline":{"status":"SUCCESS","path":"/pipeline/2"}}]}},
            {"name":"deploy","status":"RUNNING","jobs":{"nodes":[],"pageInfo":{"hasNextPage":true}}}
        ]}}}}}});
        let checks = pipeline_checks(&data, "https://gitlab.example").unwrap();
        assert_eq!(checks.len(), 3);
        assert_eq!(checks[0]["status"], "neutral");
        assert_eq!(checks[0]["url"], "https://gitlab.example/job/1");
        assert_eq!(checks[1]["description"], "Downstream pipeline");
        assert_eq!(checks[2]["url"], "https://gitlab.example/pipeline/1");
        let mut partial = data.clone();
        partial["data"]["project"]["mergeRequest"]["headPipeline"]["stages"]["pageInfo"]
            ["hasNextPage"] = json!(true);
        assert!(pipeline_checks(&partial, "https://gitlab.example").is_none());
    }
    #[test]
    fn bridges_require_complete_page_and_map_allowed_failures() {
        let bridge = json!({"name":"child","allow_failure":true,"downstream_pipeline":{"status":"failed","web_url":"https://example/pipeline"}});
        let checks = bridge_checks(&json!([bridge.clone()]));
        assert_eq!(checks[0]["status"], "neutral");
        assert_eq!(checks[0]["url"], "https://example/pipeline");
        assert!(bridge_checks(&json!(vec![bridge; 100])).is_empty());
    }
    #[test]
    fn maps_gitlab_merge_request() {
        let project = ("p".into(), "Project".into(), "/repo".into(), None);
        let mr = json!({"iid":7,"title":"Fix","web_url":"https://gitlab.example/group/sub/repo/-/merge_requests/7","state":"opened","draft":true,"source_branch":"topic","target_branch":"main","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z","changes_count":"1000+","author":{"username":"alice","name":"Alice"},"head_pipeline":{"status":"failed"},"diverged_commits_count":2,"user":{"can_merge":false}});
        let summary = map(&mr, &project, "group/sub/repo", false);
        assert_eq!(summary["changedFiles"], 1000);
        assert!(summary.get("checksState").is_none());
        assert_eq!(summary["author"]["login"], "alice");
        let detail = map(&mr, &project, "group/sub/repo", true);
        assert_eq!(detail["baseComparison"], "behind");
        assert_eq!(detail["checks"][0]["status"], "failure");
        assert!(!detail["viewerPermissions"]["actions"]
            .as_array()
            .unwrap()
            .contains(&json!("merge")));
    }
}
