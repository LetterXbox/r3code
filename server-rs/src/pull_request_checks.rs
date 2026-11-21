//! Pull request check status reads for supported providers.
use serde_json::{Value, json};

/// Reuse the provider detail reader so checks retain its pagination, routing,
/// account pinning, and provider-specific pipeline handling.
pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    crate::pull_request_detail::read(projects, input).map(|detail| from_detail(&detail))
}

fn from_detail(detail: &Value) -> Value {
    let mut result = json!({"state": detail["state"], "checks": detail["checks"]});
    if let Some(observed_at) = detail.get("observedAt") {
        result["observedAt"] = observed_at.clone();
    }
    result
}

const DEFAULT_CHECK_LOGS: usize = 5;
const MAX_CHECK_LOG_CHARS: usize = 32_000;
const NOT_A_JOB: &str = "This check is not a GitHub Actions job.";
const ONE_JOB_AT_A_TIME: &str = "Re-running the first check in this run; wait for it to start before re-running another in the same run.";

pub(crate) fn github_actions_job_id(url: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?:/actions/runs/\d+/jobs?/|/runs/)(\d+)(?:$|[/?#])").ok()?;
    let cap = re.captures(url)?;
    Some(cap.get(1)?.as_str().to_owned())
}

pub(crate) fn tail_log_lines(raw: &str, tail_lines: usize) -> (String, bool) {
    let normalized = raw.replace("\r\n", "\n");
    let trimmed = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if trimmed.is_empty() {
        return (String::new(), false);
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let truncated = lines.len() > tail_lines;
    let slice = if lines.len() > tail_lines {
        &lines[lines.len() - tail_lines..]
    } else {
        &lines[..]
    };
    let joined = slice.join("\n");
    let char_count = joined.chars().count();
    if char_count > MAX_CHECK_LOG_CHARS {
        let tail: String = joined
            .chars()
            .skip(char_count - MAX_CHECK_LOG_CHARS)
            .collect();
        (tail, true)
    } else {
        (joined, truncated)
    }
}

fn select_checks(detail: &Value, named: Option<&str>, operation: &str) -> Result<Vec<Value>, Value> {
    let checks = detail["checks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c["placeholder"] != true)
        .collect::<Vec<_>>();
    if let Some(target) = named.map(str::trim).filter(|s| !s.is_empty()) {
        let matched: Vec<Value> = checks
            .into_iter()
            .filter(|c| {
                c["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(target))
            })
            .collect();
        if matched.is_empty() {
            return Err(json!({
                "_tag": "PullRequestOperationError",
                "operation": operation,
                "detail": format!("No check named {target} is on this PR."),
            }));
        }
        Ok(matched)
    } else {
        Ok(checks
            .into_iter()
            .filter(|c| matches!(c["status"].as_str(), Some("failure" | "cancelled")))
            .collect())
    }
}

fn gh_rest(
    exe: &str,
    cwd: &str,
    host: &str,
    method: &str,
    path: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
    operation: &str,
) -> Result<Vec<u8>, Value> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["api", "--hostname", host, "--method", method, path])
        .current_dir(cwd);
    if let Some(cred) = credential {
        cred.apply(&mut cmd);
    }
    crate::github_pinned_credential::run_classified(&mut cmd, std::time::Duration::from_secs(15))
        .map_err(|failure| {
            crate::github_pinned_credential::operation_error(
                failure,
                operation,
                "The GitHub Actions request failed.",
            )
        })
}

pub(crate) fn check_logs(
    projects: Vec<(String, String, String)>,
    input: &Value,
) -> Result<Value, Value> {
    check_logs_with(projects, input, "gh")
}

pub(crate) fn check_logs_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects.clone(), input)?;
    if detail["provider"] != "github" {
        return Err(json!({
            "_tag": "PullRequestOperationError",
            "operation": "checkLogs",
            "detail": "This host cannot read check logs.",
        }));
    }
    let named = input["check"].as_str();
    let tail_lines = input["tailLines"]
        .as_u64()
        .map(|n| n.clamp(1, 2000) as usize)
        .unwrap_or(200);
    let checks = select_checks(&detail, named, "checkLogs")?;
    if checks.is_empty() {
        return Ok(json!([]));
    }
    let cwd = detail["workspaceRoot"].as_str().unwrap_or(".");
    let repo = detail["repository"].as_str().unwrap_or("");
    let project = projects.iter().find(|p| p.2 == cwd);
    let host = project
        .and_then(|p| crate::repository_identity::resolve(&p.2))
        .and_then(|id| {
            id["canonicalKey"]
                .as_str()
                .and_then(|k| k.split_once('/'))
                .map(|(h, _)| h.to_owned())
        })
        .unwrap_or_else(|| "github.com".into());

    let (shown, rest) = if named.is_none() && checks.len() > DEFAULT_CHECK_LOGS {
        (&checks[..DEFAULT_CHECK_LOGS], &checks[DEFAULT_CHECK_LOGS..])
    } else {
        (&checks[..], &[][..])
    };
    let mut results = Vec::new();
    for check in shown {
        let name = check["name"].as_str().unwrap_or("").to_owned();
        let url = check.get("url").and_then(Value::as_str).map(str::to_owned);
        let Some(job_id) = url.as_deref().and_then(github_actions_job_id) else {
            results.push(json!({
                "name": name,
                "url": url,
                "log": Value::Null,
                "truncated": false,
                "detail": NOT_A_JOB,
            }));
            continue;
        };
        let path = format!("repos/{repo}/actions/jobs/{job_id}/logs");
        match gh_rest(exe, cwd, &host, "GET", &path, credential.as_ref(), "checkLogs") {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let (log, truncated) = tail_log_lines(&text, tail_lines);
                results.push(json!({
                    "name": name,
                    "url": url,
                    "log": log,
                    "truncated": truncated,
                    "detail": Value::Null,
                }));
            }
            Err(err) => {
                let message = err["detail"]
                    .as_str()
                    .unwrap_or("Could not read check log.")
                    .to_owned();
                results.push(json!({
                    "name": name,
                    "url": url,
                    "log": Value::Null,
                    "truncated": false,
                    "detail": message,
                }));
            }
        }
    }
    for check in rest {
        results.push(json!({
            "name": check["name"],
            "url": check["url"],
            "log": Value::Null,
            "truncated": false,
            "detail": "Not read, to keep the reply short. Ask for this check by name.",
        }));
    }
    Ok(Value::Array(results))
}

pub(crate) fn rerun_checks(
    projects: Vec<(String, String, String)>,
    input: &Value,
) -> Result<Value, Value> {
    rerun_checks_with(projects, input, "gh")
}

pub(crate) fn rerun_checks_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects.clone(), input)?;
    if detail["provider"] != "github" {
        return Err(json!({
            "_tag": "PullRequestOperationError",
            "operation": "rerunChecks",
            "detail": "This host cannot re-run checks.",
        }));
    }
    let checks = select_checks(&detail, input["check"].as_str(), "rerunChecks")?;
    if checks.is_empty() {
        return Ok(json!([]));
    }
    let cwd = detail["workspaceRoot"].as_str().unwrap_or(".");
    let repo = detail["repository"].as_str().unwrap_or("");
    let project = projects.iter().find(|p| p.2 == cwd);
    let host = project
        .and_then(|p| crate::repository_identity::resolve(&p.2))
        .and_then(|id| {
            id["canonicalKey"]
                .as_str()
                .and_then(|k| k.split_once('/'))
                .map(|(h, _)| h.to_owned())
        })
        .unwrap_or_else(|| "github.com".into());

    struct Located {
        name: String,
        job_id: Option<String>,
        run_id: Option<u64>,
        detail: Option<String>,
    }
    let mut located = Vec::with_capacity(checks.len());
    let mut by_run: std::collections::BTreeMap<u64, Vec<usize>> = std::collections::BTreeMap::new();
    for check in &checks {
        let name = check["name"].as_str().unwrap_or("").to_owned();
        let Some(job_id) = check["url"].as_str().and_then(github_actions_job_id) else {
            located.push(Located {
                name,
                job_id: None,
                run_id: None,
                detail: Some(NOT_A_JOB.into()),
            });
            continue;
        };
        let path = format!("repos/{repo}/actions/jobs/{job_id}");
        match gh_rest(exe, cwd, &host, "GET", &path, credential.as_ref(), "rerunChecks") {
            Ok(bytes) => {
                let job: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                if let Some(run_id) = job["run_id"].as_u64() {
                    let idx = located.len();
                    located.push(Located {
                        name,
                        job_id: Some(job_id),
                        run_id: Some(run_id),
                        detail: None,
                    });
                    by_run.entry(run_id).or_default().push(idx);
                } else {
                    located.push(Located {
                        name,
                        job_id: Some(job_id),
                        run_id: None,
                        detail: Some(NOT_A_JOB.into()),
                    });
                }
            }
            Err(err) => {
                located.push(Located {
                    name,
                    job_id: Some(job_id),
                    run_id: None,
                    detail: Some(
                        err["detail"]
                            .as_str()
                            .unwrap_or("Could not inspect check job.")
                            .to_owned(),
                    ),
                });
            }
        }
    }

    let mut outcomes: Vec<Option<String>> = vec![None; located.len()];
    let mut rerun_ok: Vec<bool> = vec![false; located.len()];
    for (run_id, indices) in by_run {
        if indices.len() > 1 {
            let jobs_path = format!("repos/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100");
            let selected_failed_match = gh_rest(
                exe,
                cwd,
                &host,
                "GET",
                &jobs_path,
                credential.as_ref(),
                "rerunChecks",
            )
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|body| {
                let total = body["total_count"].as_u64().unwrap_or(0) as usize;
                let jobs = body["jobs"].as_array().cloned().unwrap_or_default();
                if total > jobs.len() {
                    return false;
                }
                let failed_ids: std::collections::HashSet<String> = jobs
                    .iter()
                    .filter(|j| matches!(j["conclusion"].as_str(), Some("failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure")))
                    .filter_map(|j| j["id"].as_u64().map(|id| id.to_string()))
                    .collect();
                failed_ids.len() == indices.len()
                    && indices
                        .iter()
                        .all(|&idx| located[idx].job_id.as_ref().is_some_and(|id| failed_ids.contains(id)))
            });
            if selected_failed_match {
                let post_path = format!("repos/{repo}/actions/runs/{run_id}/rerun-failed-jobs");
                match gh_rest(exe, cwd, &host, "POST", &post_path, credential.as_ref(), "rerunChecks") {
                    Ok(_) => {
                        for idx in indices {
                            rerun_ok[idx] = true;
                        }
                    }
                    Err(err) => {
                        let msg = err["detail"].as_str().unwrap_or("Could not re-run checks.").to_owned();
                        for idx in indices {
                            outcomes[idx] = Some(msg.clone());
                        }
                    }
                }
                continue;
            }
        }
        let first_idx = indices[0];
        if let Some(job_id) = &located[first_idx].job_id {
            let post_path = format!("repos/{repo}/actions/jobs/{job_id}/rerun");
            match gh_rest(exe, cwd, &host, "POST", &post_path, credential.as_ref(), "rerunChecks") {
                Ok(_) => rerun_ok[first_idx] = true,
                Err(err) => {
                    outcomes[first_idx] = Some(
                        err["detail"]
                            .as_str()
                            .unwrap_or("Could not re-run check.")
                            .to_owned(),
                    );
                }
            }
        }
        for &idx in &indices[1..] {
            outcomes[idx] = Some(ONE_JOB_AT_A_TIME.into());
        }
    }

    Ok(Value::Array(
        located
            .into_iter()
            .enumerate()
            .map(|(idx, item)| {
                let ok = item.run_id.is_some() && rerun_ok[idx];
                let detail = if item.run_id.is_none() {
                    item.detail
                } else {
                    outcomes[idx].clone()
                };
                json!({
                    "name": item.name,
                    "rerun": ok,
                    "detail": detail,
                })
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_and_job_id_helpers_match_contract() {
        assert_eq!(
            github_actions_job_id("https://github.com/octo/repo/actions/runs/10/job/11"),
            Some("11".into())
        );
        assert_eq!(
            github_actions_job_id("https://github.com/octo/repo/runs/21"),
            Some("21".into())
        );
        assert_eq!(
            github_actions_job_id("https://vercel.com/octo/deployments/1"),
            None
        );
        assert_eq!(tail_log_lines("a\nb\nc\n", 2), ("b\nc".into(), true));
        assert_eq!(tail_log_lines("a\nb\n", 5), ("a\nb".into(), false));
        let (big, trunc) = tail_log_lines(&"x".repeat(40_000), 10);
        assert_eq!(big.len(), MAX_CHECK_LOG_CHARS);
        assert!(trunc);
    }

    #[test]
    fn projects_provider_detail_to_checks_contract() {
        let detail = json!({"state":"open","checks":[{"name":"build","status":"failure","url":null,"description":null}],"observedAt":123,"title":"private detail"});
        assert_eq!(
            from_detail(&detail),
            json!({"state":"open","checks":[{"name":"build","status":"failure","url":null,"description":null}],"observedAt":123})
        );
        assert_eq!(
            from_detail(&json!({"state":"merged","checks":[]})),
            json!({"state":"merged","checks":[]})
        );
    }
}

/// Include unfinished GitHub workflows and fork workflows that require approval.
pub(crate) fn augment(
    detail: &mut Value,
    pr: &Value,
    exe: &str,
    host: &str,
    cwd: &str,
    repo: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<(), Value> {
    if detail["state"] != "open" {
        return Ok(());
    }
    use crate::github_pinned_credential::{CommandFailure, run_classified};
    use std::{process::Command, time::Duration};
    let call = |args: &[String]| -> Result<Option<Value>, Value> {
        let mut cmd = Command::new(exe);
        cmd.args(args).current_dir(cwd);
        if let Some(c) = credential {
            c.apply(&mut cmd);
        }
        match run_classified(&mut cmd, Duration::from_secs(10)) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(CommandFailure::RateLimited) => Err(
                json!({"_tag":"PullRequestOperationError","operation":"detail","detail":"The pull request could not be read."}),
            ),
            Err(_) => Ok(None),
        }
    };
    if let Some(sha) = pr["headRefOid"].as_str().filter(|sha| !sha.is_empty()) {
        let sha = percent_encoding::utf8_percent_encode(sha, percent_encoding::NON_ALPHANUMERIC);
        let endpoint = format!("repos/{repo}/actions/runs?head_sha={sha}&per_page=100");
        if let Some(response) = call(&["api".into(), "--hostname".into(), host.into(), endpoint])? {
            append_unfinished_runs(detail, &response);
        }
    }
    if pr["isCrossRepository"] == true {
        match approval_runs(pr, host, repo, call) {
            Ok(Some(runs)) => {
                detail["workflowApprovalsRequired"] = json!(runs.len());
                let checks = detail["checks"].as_array_mut().expect("mapped checks");
                for run in runs {
                    let id = run["id"].to_string();
                    let marker = format!("/actions/runs/{id}");
                    if !checks.iter().any(|c| c["status"] == "action-required" && c["url"].as_str().is_some_and(|u| u.split_once(&marker).is_some_and(|(_, suffix)| suffix.is_empty() || suffix.starts_with('/')))) {
                        let name = run["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("Workflow run {id}"));
                        let url = run["html_url"].as_str().map(str::trim).filter(|s| !s.is_empty());
                        checks.push(json!({"name":name,"status":"action-required","description":"A maintainer must approve this workflow before it can run.","url":url}));
                    }
                }
            }
            Ok(None) => detail["checks"].as_array_mut().expect("mapped checks").push(json!({"name":"Workflow approval status","status":"action-required","description":"GitHub could not determine whether workflows are awaiting approval.","url":null,"placeholder":true})),
            Err(e) => return Err(e),
        }
    } else {
        detail["workflowApprovalsRequired"] = json!(0);
    }
    Ok(())
}

fn append_unfinished_runs(detail: &mut Value, response: &Value) {
    let Some(runs) = response["workflow_runs"].as_array() else {
        return;
    };
    if runs
        .iter()
        .any(|run| !run["id"].is_i64() && !run["id"].is_u64())
    {
        return;
    }
    let checks = detail["checks"].as_array_mut().expect("mapped checks");
    for run in runs {
        if !matches!(
            run["status"].as_str(),
            Some("requested" | "queued" | "pending" | "waiting" | "in_progress")
        ) {
            continue;
        }
        let id = &run["id"];
        let marker = format!("/actions/runs/{id}");
        let represented = checks.iter().any(|check| {
            matches!(
                check["status"].as_str(),
                Some("pending" | "action-required")
            ) && check["url"].as_str().is_some_and(|url| {
                url.split_once(&marker).is_some_and(|(_, suffix)| {
                    suffix.is_empty() || suffix.starts_with(['/', '?', '#'])
                })
            })
        });
        if represented {
            continue;
        }
        let name = run["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Workflow run {id}"));
        let url = run["html_url"]
            .as_str()
            .map(str::trim)
            .filter(|url| !url.is_empty());
        checks.push(json!({
            "name": name,
            "status": "pending",
            "description": "This workflow run has not finished.",
            "url": url,
        }));
    }
}

fn approval_runs(
    pr: &Value,
    host: &str,
    repo: &str,
    call: impl Fn(&[String]) -> Result<Option<Value>, Value>,
) -> Result<Option<Vec<Value>>, Value> {
    let Some(sha) = pr["headRefOid"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(branch) = pr["headRefName"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(owner) = pr["headRepositoryOwner"]["login"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let Some((repo_owner, repo_name)) = repo.split_once('/') else {
        return Ok(None);
    };
    let mut after: Option<String> = None;
    let mut exact = Vec::new();
    let mut total = 0;
    loop {
        let cursor = after
            .as_ref()
            .map(|s| format!(",after:{}", json!(s)))
            .unwrap_or_default();
        let query = format!(
            "query {{ repository(owner:{},name:{}) {{ pullRequests(first:100,states:[OPEN],headRefName:{}{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ number headRefOid isCrossRepository headRepositoryOwner {{ login }} }} }} }} }}",
            json!(repo_owner),
            json!(repo_name),
            json!(branch),
            cursor
        );
        let Some(v) = call(&[
            "api".into(),
            "graphql".into(),
            "--hostname".into(),
            host.into(),
            "-f".into(),
            format!("query={query}"),
        ])?
        else {
            return Ok(None);
        };
        let page = &v["data"]["repository"]["pullRequests"];
        let Some(nodes) = page["nodes"].as_array() else {
            return Ok(None);
        };
        total += nodes.len();
        if total > 1000 {
            return Ok(None);
        }
        exact.extend(
            nodes
                .iter()
                .filter(|n| {
                    n["headRefOid"] == sha
                        && n["isCrossRepository"] == true
                        && n["headRepositoryOwner"]["login"]
                            .as_str()
                            .is_some_and(|x| x.eq_ignore_ascii_case(owner))
                })
                .cloned(),
        );
        if page["pageInfo"]["hasNextPage"] != true {
            break;
        }
        let Some(next) = page["pageInfo"]["endCursor"].as_str() else {
            return Ok(None);
        };
        if after.as_deref() == Some(next) {
            return Ok(None);
        }
        after = Some(next.to_owned());
    }
    if exact.len() != 1 || exact[0]["number"] != pr["number"] {
        return Ok(None);
    }
    let encode = |s: &str| {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    let mut runs = Vec::new();
    for page in 1..=11 {
        let endpoint = format!(
            "repos/{repo}/actions/runs?head_sha={}&branch={}&event=pull_request&status=action_required&per_page=100&page={page}",
            encode(sha),
            encode(branch)
        );
        let Some(v) = call(&["api".into(), "--hostname".into(), host.into(), endpoint])? else {
            return Ok(None);
        };
        let Some(items) = v["workflow_runs"].as_array() else {
            return Ok(None);
        };
        if items.iter().any(|r| !r["id"].is_i64() && !r["id"].is_u64()) {
            return Ok(None);
        }
        runs.extend(items.iter().cloned());
        if runs.len() > 1000 {
            return Ok(None);
        }
        if items.len() < 100 {
            return Ok(Some(runs));
        }
    }
    Ok(None)
}

#[cfg(all(test, unix))]
mod augmentation_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn projects_unfinished_workflows_without_duplicate_pending_checks() {
        let dir = std::env::temp_dir().join(format!("t3-check-runs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("gh");
        std::fs::write(&exe, r##"#!/bin/sh
printf '%s' '{"workflow_runs":[{"id":1,"name":"CI","status":"queued","html_url":"https://github.com/a/b/actions/runs/1"},{"id":2,"name":"Build","status":"in_progress","html_url":"https://github.com/a/b/actions/runs/2"},{"id":3,"status":"completed"}]}'
"##).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut detail = json!({"state":"open","checks":[{"name":"job","status":"pending","url":"https://github.com/a/b/actions/runs/1/job/5"}]});
        augment(
            &mut detail,
            &json!({"headRefOid":"abc","isCrossRepository":false}),
            exe.to_str().unwrap(),
            "github.com",
            dir.to_str().unwrap(),
            "a/b",
            None,
        )
        .unwrap();
        assert_eq!(detail["checks"].as_array().unwrap().len(), 2);
        assert_eq!(
            detail["checks"][1],
            json!({
                "name":"Build",
                "status":"pending",
                "description":"This workflow run has not finished.",
                "url":"https://github.com/a/b/actions/runs/2"
            })
        );
        assert_eq!(detail["workflowApprovalsRequired"], 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn approval_errors_and_large_ids_are_handled() {
        let dir = std::env::temp_dir().join(format!("t3-approval-errors-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("gh");
        let pr = json!({"number":7,"headRefOid":"abc","headRefName":"feature","headRepositoryOwner":{"login":"contributor"},"isCrossRepository":true});
        for (message, rate_limited) in [("HTTP 401", false), ("HTTP 429", true)] {
            std::fs::write(&exe, format!("#!/bin/sh\ncase \"$*\" in *graphql*) echo '{} ' >&2; exit 1;; *) echo '{{\"workflow_runs\":[]}}';; esac\n", message)).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            let mut detail = json!({"state":"open","checks":[]});
            let result = augment(
                &mut detail,
                &pr,
                exe.to_str().unwrap(),
                "github.com",
                dir.to_str().unwrap(),
                "a/b",
                None,
            );
            assert_eq!(result.is_err(), rate_limited);
            if !rate_limited {
                assert_eq!(detail["checks"][0]["placeholder"], true);
            }
        }
        std::fs::write(&exe, r##"#!/bin/sh
case "$*" in
  *graphql*) printf '%s' '{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"headRefOid":"abc","isCrossRepository":true,"headRepositoryOwner":{"login":"contributor"}}],"pageInfo":{"hasNextPage":false}}}}}' ;;
  *status=action_required*) printf '%s' '{"workflow_runs":[{"id":18446744073709551615}]}' ;;
  *) printf '%s' '{"workflow_runs":[]}' ;;
esac
"##).unwrap();
        let mut detail = json!({"state":"open","checks":[]});
        augment(
            &mut detail,
            &pr,
            exe.to_str().unwrap(),
            "github.com",
            dir.to_str().unwrap(),
            "a/b",
            None,
        )
        .unwrap();
        assert_eq!(
            detail["checks"][0]["name"],
            "Workflow run 18446744073709551615"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn fork_approval_and_unavailable_placeholder() {
        let dir = std::env::temp_dir().join(format!("t3-approval-runs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("gh");
        std::fs::write(&exe, r##"#!/bin/sh
case "$*" in
  *graphql*) printf '%s' '{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"headRefOid":"abc","isCrossRepository":true,"headRepositoryOwner":{"login":"contributor"}}],"pageInfo":{"hasNextPage":false}}}}}' ;;
  *status=action_required*) printf '%s' '{"workflow_runs":[{"id":42,"name":"CI","html_url":"https://github.com/a/b/actions/runs/42"}]}' ;;
  *) printf '%s' '{"workflow_runs":[]}' ;;
esac
"##).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut detail = json!({"state":"open","checks":[]});
        let mut pr = json!({"number":7,"headRefOid":"abc","headRefName":"feature","headRepositoryOwner":{"login":"Contributor"},"isCrossRepository":true});
        augment(
            &mut detail,
            &pr,
            exe.to_str().unwrap(),
            "github.com",
            dir.to_str().unwrap(),
            "a/b",
            None,
        )
        .unwrap();
        assert_eq!(detail["workflowApprovalsRequired"], 1);
        assert_eq!(detail["checks"][0]["status"], "action-required");
        pr["number"] = json!(8);
        let mut unavailable = json!({"state":"open","checks":[]});
        augment(
            &mut unavailable,
            &pr,
            exe.to_str().unwrap(),
            "github.com",
            dir.to_str().unwrap(),
            "a/b",
            None,
        )
        .unwrap();
        assert!(unavailable.get("workflowApprovalsRequired").is_none());
        assert_eq!(unavailable["checks"][0]["placeholder"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
