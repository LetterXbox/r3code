//! Pull request check status reads for supported providers.
use serde_json::{json, Value};

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

#[cfg(test)]
mod tests {
    use super::*;

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

/// Add workflow approval checks when upstream GitHub fork PR rules require maintainer approval.
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
    if pr["isCrossRepository"] == true {
        match approval_runs(pr, exe, host, cwd, repo, credential) {
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

fn approval_runs(
    pr: &Value,
    exe: &str,
    host: &str,
    cwd: &str,
    repo: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Option<Vec<Value>>, Value> {
    use crate::github_pinned_credential::{run_classified, CommandFailure};
    use std::{process::Command, time::Duration};
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
    let mut after: Option<String> = None;
    let mut exact = Vec::new();
    let mut total = 0;
    loop {
        let cursor = after
            .as_ref()
            .map(|s| format!(",after:{}", json!(s)))
            .unwrap_or_default();
        let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequests(first:100,states:[OPEN],headRefName:{}{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ number headRefOid isCrossRepository headRepositoryOwner {{ login }} }} }} }} }}", json!(repo_owner), json!(repo_name), json!(branch), cursor);
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
        let endpoint = format!("repos/{repo}/actions/runs?head_sha={}&branch={}&event=pull_request&status=action_required&per_page=100&page={page}", encode(sha), encode(branch));
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
    fn does_not_synthesize_unfinished_rest_workflow_runs_matching_upstream() {
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
        assert_eq!(detail["checks"].as_array().unwrap().len(), 1);
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
