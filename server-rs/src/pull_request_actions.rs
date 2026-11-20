//! Pull request state changes supported by the provider CLI.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value) -> bool {
    crate::pull_request_links::valid(input)
        && matches!(
            input["action"].as_str(),
            Some(
                "merge"
                    | "ready"
                    | "draft"
                    | "close"
                    | "reopen"
                    | "delete-branch"
                    | "update-branch"
                    | "enable-auto-merge"
                    | "disable-auto-merge"
                    | "revert"
                    | "approve-workflows"
            )
        )
        && input
            .get("mergeMethod")
            .is_none_or(|v| matches!(v.as_str(), Some("merge" | "squash" | "rebase")))
        && input
            .get("updateMethod")
            .is_none_or(|v| matches!(v.as_str(), Some("merge" | "rebase")))
        && input
            .get("stackNumber")
            .is_none_or(|v| v.as_u64().is_some_and(|n| n > 0))
        && input.get("expectedStackHeads").is_none_or(|v| {
            v.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    v["number"].as_u64().is_some_and(|n| n > 0)
                        && v["headSha"].as_str().is_some_and(|s| !s.trim().is_empty())
                })
            })
        })
        && input.get("replyWithSummary").is_none_or(|v| v == true)
}

pub(crate) fn run(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    let action = input["action"].as_str().unwrap();
    let fail = |detail: &str| json!({"_tag":"PullRequestOperationError","operation":"runAction","detail":detail});
    if input.get("stackNumber").is_some()
        && (!matches!(action, "merge" | "update-branch")
            || input.get("expectedStackHeads").is_none()
            || (action == "update-branch" && input["updateMethod"] != "rebase"))
    {
        return Err(fail(
            "This stack action is not supported or has no expected head revision.",
        ));
    }
    // Reading detail also validates repository routing and viewer permissions.
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects.clone(), input)?;
    let provider = detail["provider"].as_str().unwrap_or("");
    if provider == "gitlab" && action == "revert" {
        return Err(fail("This host cannot revert a change request."));
    }
    if !(if input.get("stackNumber").is_some() && action == "update-branch" {
        detail["viewerPermissions"]["stackRebase"] == true
    } else {
        detail["viewerPermissions"]["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == action))
    }) {
        return Err(fail("The signed-in account cannot perform this action."));
    }
    for (field, capability) in [
        ("mergeMethod", "mergeMethods"),
        ("updateMethod", "updateMethods"),
    ] {
        if let Some(method) = input.get(field) {
            if !detail["capabilities"][capability]
                .as_array()
                .is_some_and(|a| a.contains(method))
            {
                return Err(fail("This host does not support the requested strategy."));
            }
        }
    }
    let root = detail["workspaceRoot"]
        .as_str()
        .ok_or_else(|| fail("The pull request could not be updated."))?;
    let repo = detail["repository"]
        .as_str()
        .ok_or_else(|| fail("The pull request could not be updated."))?;
    let project = projects
        .iter()
        .find(|p| p.2 == root)
        .ok_or_else(|| fail("The pull request could not be updated."))?;
    let identity = crate::repository_identity::resolve(&project.2)
        .ok_or_else(|| fail("The pull request could not be updated."))?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(|| fail("The pull request could not be updated."))?;
    let number = input["number"].as_u64().unwrap().to_string();
    let error = || fail("The pull request could not be updated.");
    if provider == "gitlab" {
        if action == "disable-auto-merge" {
            let response =
                gitlab_disable_auto_merge(root, host, repo, &number).map_err(|_| error())?;
            if input["replyWithSummary"] == true {
                let selected = (
                    project.0.clone(),
                    project.1.clone(),
                    project.2.clone(),
                    Some(identity.clone()),
                );
                return Ok(crate::gitlab_pull_request_read::action_summary(
                    &response, &selected, repo,
                )
                .unwrap_or(Value::Null));
            }
            return Ok(Value::Null);
        }
        let (sub, flag) = match action {
            "ready" => ("update", Some("--ready")),
            "draft" => ("update", Some("--draft")),
            "close" => ("close", None),
            "reopen" => ("reopen", None),
            "update-branch" if input.get("updateMethod").is_none_or(|v| v == "rebase") => {
                ("rebase", None)
            }
            _ => return Err(fail("This action is not supported by this server.")),
        };
        let mut cmd = Command::new("glab");
        cmd.args(["mr", sub, &number, "--repo", repo])
            .current_dir(root)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        if let Some(flag) = flag {
            cmd.arg(flag);
        }
        crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
            .map_err(|_| error())?;
    } else if provider == "github" {
        if input.get("stackNumber").is_some() {
            return run_github_stack(root, host, repo, input, credential.as_ref())
                .map_err(|detail| {
                    let cause_name = if detail.contains(" conflicts with the layer below it.") { Some("GitHubStackRebaseConflictError") } else if detail.starts_with("Stack rebase stopped at PR #") { Some("GitHubStackRebaseGitError") } else { None };
                    if let Some(cause_name) = cause_name {
                        json!({"_tag":"PullRequestOperationError","operation":"runAction","detail":detail,"cause":{"name":"PullRequestProviderError","message":format!("github failed in runAction: {detail}"),"cause":{"name":"GitHubStackRebaseFailedError","message":detail,"cause":{"name":cause_name,"message":detail}}}})
                    } else { fail(&detail) }
                });
        }
        if action == "approve-workflows" {
            approve_github_workflows(root, host, repo, &number, credential.as_ref())
                .map_err(|_| error())?;
            return Ok(Value::Null);
        }
        if action == "delete-branch" {
            return delete_github_branch(root, host, repo, &number, credential.as_ref())
                .map_err(|_| error());
        }
        let mut mutation = match action {
            "ready" => "markPullRequestReadyForReview",
            "draft" => "convertPullRequestToDraft",
            "close" => "closePullRequest",
            "reopen" => "reopenPullRequest",
            "disable-auto-merge" => "disablePullRequestAutoMerge",
            "revert" => "revertPullRequest",
            "update-branch" => "updatePullRequestBranch",
            "merge" | "enable-auto-merge" => "mergePullRequest",
            _ => return Err(fail("This action is not supported by this server.")),
        };
        let (owner, name) = repo.split_once('/').ok_or_else(error)?;
        let query = format!(
            "query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id headRefOid isMergeQueueEnabled mergeStateStatus }} }} }}",
            json!(owner),
            json!(name)
        );
        let mut cmd = Command::new("gh");
        cmd.args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={query}"),
        ])
        .current_dir(root);
        if let Some(credential) = &credential {
            credential.apply(&mut cmd);
        }
        let raw =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
                .map_err(|_| error())?;
        let value: Value = serde_json::from_slice(&raw).map_err(|_| error())?;
        let id = value["data"]["repository"]["pullRequest"]["id"]
            .as_str()
            .ok_or_else(error)?;
        let state = &value["data"]["repository"]["pullRequest"];
        if matches!(action, "merge" | "enable-auto-merge") {
            let queued = state["isMergeQueueEnabled"].as_bool().ok_or_else(error)?;
            let status = state["mergeStateStatus"].as_str().unwrap_or("");
            if queued
                || (action == "enable-auto-merge"
                    && !matches!(status, "CLEAN" | "HAS_HOOKS" | "UNSTABLE"))
            {
                mutation = "enablePullRequestAutoMerge";
            }
        }
        if action == "update-branch" && detail["baseComparison"] == "up-to-date" {
            return Ok(Value::Null);
        }
        let extra = if action == "update-branch" {
            let sha = detail["headSha"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(error)?;
            let method = if input["updateMethod"] == "rebase" {
                "REBASE"
            } else {
                "MERGE"
            };
            format!(",expectedHeadOid:{},updateMethod:{method}", json!(sha))
        } else if matches!(action, "merge" | "enable-auto-merge") {
            let sha = state["headRefOid"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(error)?;
            let method = match input["mergeMethod"].as_str() {
                Some("squash") => "SQUASH",
                Some("rebase") => "REBASE",
                _ => "MERGE",
            };
            format!(",expectedHeadOid:{},mergeMethod:{method}", json!(sha))
        } else {
            String::new()
        };
        let result_field = if action == "revert" {
            "revertPullRequest"
        } else {
            "pullRequest"
        };
        let fields = if action == "revert" {
            "id"
        } else {
            "id number title url headRefName baseRefName state isDraft updatedAt mergedAt closedAt headRefOid author { login avatarUrl ... on User { name } } autoMergeRequest { mergeMethod }"
        };
        let query = format!(
            "mutation {{ {mutation}(input:{{pullRequestId:{}{extra}}}) {{ {result_field} {{ {fields} }} }} }}",
            json!(id)
        );
        let mut cmd = Command::new("gh");
        cmd.args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={query}"),
        ])
        .current_dir(root);
        if let Some(credential) = &credential {
            credential.apply(&mut cmd);
        }
        let raw =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
                .map_err(|_| error())?;
        let value: Value = serde_json::from_slice(&raw).map_err(|_| error())?;
        if value.get("errors").is_some() || value["data"].get(mutation).is_none() {
            return Err(error());
        }
        if action != "revert" && value["data"][mutation][result_field].is_null() {
            return Ok(Value::Null);
        }
        if value["data"][mutation][result_field]["id"]
            .as_str()
            .is_none()
        {
            return Err(error());
        }
        if input["replyWithSummary"] == true && action != "revert" {
            return github_action_summary(&value["data"][mutation][result_field], &project.0, repo)
                .ok_or_else(error);
        }
    } else {
        return Err(fail("This action is not supported by this server."));
    }
    // The default action response is void.
    Ok(Value::Null)
}

// GitHub's stack merge endpoint checks the target revision atomically. Validate
// every affected head before submitting, then poll the same asynchronous request.
fn run_github_stack(
    root: &str,
    host: &str,
    repo: &str,
    input: &Value,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Value, String> {
    const CHANGED: &str = "The stack changed. Refresh it before trying again.";
    const INVALID: &str = "GitHub returned an unreadable stack operation response.";
    const UNSUPPORTED: &str = "This operation is not supported for this stack.";
    let number = input["number"].as_u64().ok_or(INVALID)?;
    let api =
        |path: &str, method: Option<&str>, body: Option<Value>| -> Result<Value, &'static str> {
            let mut cmd = Command::new("gh");
            cmd.args(["api", "--hostname", host, path])
                .current_dir(root);
            if let Some(c) = credential {
                c.apply(&mut cmd);
            }
            if let Some(method) = method {
                cmd.args(["--method", method]);
            }
            let bytes = if let Some(body) = body {
                cmd.args(["--input", "-"]);
                crate::github_pinned_credential::run_classified_with_input(
                    &mut cmd,
                    Duration::from_secs(30),
                    body.to_string().into_bytes(),
                )
            } else {
                crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
            }
            .map_err(|_| INVALID)?;
            serde_json::from_slice(&bytes).map_err(|_| INVALID)
        };
    let stack_path = format!("repos/{repo}/stacks?pull_request={number}");
    let stacks = api(&stack_path, None, None)?;
    let stack = stacks.as_array().ok_or(INVALID)?.first().ok_or(CHANGED)?;
    if stack["number"] != input["stackNumber"] {
        return Err(CHANGED.into());
    }
    if stack["url"].as_str().is_none()
        || !(stack["base"].is_string() || stack["base"]["ref"].is_string())
    {
        return Err(INVALID.into());
    }
    let layers = stack["pull_requests"].as_array().ok_or(INVALID)?;
    for layer in layers {
        if layer["number"].as_u64().is_none()
            || layer["head"]["ref"].as_str().is_none()
            || layer.get("draft").is_some_and(|v| !v.is_boolean())
            || layer
                .get("state")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            || layer
                .get("merged_at")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            || layer["head"].get("sha").is_some_and(|v| !v.is_string())
        {
            return Err(INVALID.into());
        }
    }
    let target = layers
        .iter()
        .position(|l| l["number"].as_u64() == Some(number))
        .ok_or(CHANGED)?;
    let state = |l: &Value| {
        if l["merged_at"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
            || l["state"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("merged"))
        {
            "merged"
        } else if l["state"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("closed"))
        {
            "closed"
        } else {
            "open"
        }
    };
    let rebase = input["action"] == "update-branch";
    if rebase && target + 1 != layers.len() {
        return Err(CHANGED.into());
    }
    if !rebase && state(&layers[target]) != "open" {
        return Err(UNSUPPORTED.into());
    }
    let open: Vec<_> = layers[..=target]
        .iter()
        .filter(|l| state(l) != "merged")
        .collect();
    let expected = input["expectedStackHeads"].as_array().ok_or(CHANGED)?;
    let mut numbers = std::collections::HashSet::new();
    if expected.len() != open.len()
        || expected
            .iter()
            .any(|e| !numbers.insert(e["number"].as_u64()))
        || open.iter().any(|l| {
            !expected.iter().any(|e| {
                e["number"] == l["number"]
                    && l["head"]["sha"]
                        .as_str()
                        .is_some_and(|sha| e["headSha"] == sha)
            })
        })
    {
        return Err(CHANGED.into());
    }
    if open.is_empty()
        || open
            .iter()
            .any(|l| state(l) != "open" || (!rebase && l["draft"] == true))
    {
        return Err(UNSUPPORTED.into());
    }
    if rebase {
        let (owner, name) = repo.split_once('/').ok_or(INVALID)?;
        for layer in &open {
            let number = layer["number"].as_u64().ok_or(INVALID)?;
            let query = format!("query PullRequestBranchAccess {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ headRepository {{ viewerPermission }} maintainerCanModify }} }} }}",json!(owner),json!(name));
            let mut cmd = Command::new("gh");
            cmd.args([
                "api",
                "graphql",
                "--hostname",
                host,
                "-f",
                &format!("query={query}"),
            ])
            .current_dir(root);
            if let Some(c) = credential {
                c.apply(&mut cmd);
            }
            let bytes =
                crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
                    .map_err(|_| INVALID)?;
            let response: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
            if response.get("errors").is_some() {
                return Err(INVALID.into());
            }
            let pr = &response["data"]["repository"]["pullRequest"];
            let repository = &pr["headRepository"];
            let writable = repository["viewerPermission"].is_null()
                || matches!(
                    repository["viewerPermission"].as_str(),
                    Some("ADMIN" | "MAINTAIN" | "WRITE")
                );
            if !repository.is_object() || (pr["maintainerCanModify"] != true && !writable) {
                return Err("You cannot update every branch in this stack. Check write access and fork maintainer permissions before retrying.".into());
            }
        }
        let token = if let Some(c) = credential {
            c.token().to_owned()
        } else {
            let enterprise = !host.eq_ignore_ascii_case("github.com")
                && !host.to_ascii_lowercase().ends_with(".ghe.com");
            let names = if enterprise {
                ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
            } else {
                ["GH_TOKEN", "GITHUB_TOKEN"]
            };
            if let Some(token) = names
                .iter()
                .find_map(|n| std::env::var(n).ok().filter(|s| !s.is_empty()))
            {
                token
            } else {
                let mut cmd = Command::new("gh");
                cmd.args(["auth", "token", "--hostname", host])
                    .current_dir(root);
                String::from_utf8(
                    crate::github_pinned_credential::run_classified(
                        &mut cmd,
                        Duration::from_secs(10),
                    )
                    .map_err(|_| INVALID)?,
                )
                .map_err(|_| INVALID)?
                .trim()
                .to_owned()
            }
        };
        if token.is_empty() {
            return Err(INVALID.into());
        }
        let base = stack["base"]
            .as_str()
            .or_else(|| stack["base"]["ref"].as_str())
            .ok_or(INVALID)?;
        let first_idx = layers
            .iter()
            .position(|l| l["number"] == open[0]["number"])
            .ok_or(INVALID)?;
        let merged_head = first_idx
            .checked_sub(1)
            .and_then(|i| layers[i]["head"]["sha"].as_str());
        let remote = format!("https://{host}/{repo}.git");
        return cascade_stack_rebase(&remote, base, &open, merged_head, &token);
    }
    let path = format!("repos/{repo}/pulls/{number}/merge-async");
    let mut response = api(
        &path,
        Some("PUT"),
        Some(
            json!({"merge_method":input["mergeMethod"].as_str().unwrap_or("merge"),"merge_action":"default","sha":layers[target]["head"]["sha"]}),
        ),
    )?;
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    let mut delay = 1u64;
    loop {
        if !response["details"].is_object() {
            return Err(INVALID.into());
        }
        match response["status"].as_str() {
            Some("merged" | "enqueued") => return Ok(Value::Null),
            Some("failed") => return Err("GitHub refused the stack merge. Check the stack's branch rules and merge requirements.".into()),
            Some("pending") => {
                if std::time::Instant::now() >= deadline { return Err("The merge is still running on GitHub. Check its status there before submitting another request.".into()); }
                let uuid = response["details"]["uuid"].as_str().filter(|s| !s.is_empty()).ok_or(INVALID)?;
                let encoded: String = url::form_urlencoded::byte_serialize(uuid.as_bytes()).collect();
                std::thread::sleep(Duration::from_secs(delay));
                delay = (delay * 2).min(10);
                response = api(&format!("{path}/{encoded}"), None, None)?;
            }
            _ => return Err(INVALID.into()),
        }
    }
}

// Rebase in an isolated checkout and update each branch only with a lease
// against its reviewed head. No token is written to argv or git config.
fn cascade_stack_rebase(
    remote: &str,
    base: &str,
    layers: &[&Value],
    merged_head: Option<&str>,
    token: &str,
) -> Result<Value, String> {
    use base64::Engine as _;
    let first_number = layers
        .first()
        .and_then(|l| l["number"].as_u64())
        .unwrap_or(0);
    let failed = |step: &str, number: u64, completed: usize| {
        format!(
            "Stack rebase stopped at PR #{number} while {step}. {completed} layers were rebased."
        )
    };
    let preparing = || failed("preparing", first_number, 0);
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let dir = Temp(std::env::temp_dir().join(format!("t3-stack-rebase-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir(&dir.0).map_err(|_| preparing())?;
    let auth = format!(
        "AUTHORIZATION: basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
    );
    let git_with_status = |args: &[String], status: &mut Option<i32>| -> Result<Vec<u8>, ()> {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(&dir.0)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_COUNT", "3")
            .env("GIT_CONFIG_KEY_0", format!("http.{remote}.extraheader"))
            .env("GIT_CONFIG_VALUE_0", &auth)
            .env("GIT_CONFIG_KEY_1", "user.name")
            .env("GIT_CONFIG_VALUE_1", "T3 Code")
            .env("GIT_CONFIG_KEY_2", "user.email")
            .env("GIT_CONFIG_VALUE_2", "noreply@t3.codes");
        crate::github_pinned_credential::run_classified_with_status(
            &mut cmd,
            Duration::from_secs(120),
            status,
        )
        .map_err(|_| ())
    };
    let git = |args: &[String]| -> Result<Vec<u8>, ()> { git_with_status(args, &mut None) };
    let call = |args: &[&str]| -> Result<Vec<u8>, ()> {
        git(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    };
    call(&["init", "--quiet"]).map_err(|_| preparing())?;
    // Ref and SHA data comes from a remote API; validate before placing it in git arguments.
    for branch in
        std::iter::once(base).chain(layers.iter().filter_map(|l| l["head"]["ref"].as_str()))
    {
        call(&["check-ref-format", "--branch", branch]).map_err(|_| preparing())?;
    }
    for layer in layers {
        let sha = layer["head"]["sha"].as_str().ok_or_else(preparing)?;
        if !(sha.len() == 40 || sha.len() == 64) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(preparing());
        }
    }
    call(&["remote", "add", "origin", remote]).map_err(|_| preparing())?;
    let mut fetch = vec![
        "fetch".to_owned(),
        "--quiet".into(),
        "--no-tags".into(),
        "origin".into(),
        format!("+refs/heads/{base}:refs/remotes/origin/{base}"),
    ];
    for layer in layers {
        let branch = layer["head"]["ref"].as_str().ok_or_else(preparing)?;
        fetch.push(format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"));
    }
    git(&fetch).map_err(|_| failed("fetching", first_number, 0))?;
    let mut old = format!("origin/{base}");
    let mut new = old.clone();
    let first = layers.first().ok_or_else(preparing)?["head"]["sha"]
        .as_str()
        .ok_or_else(preparing)?;
    let merged = merged_head
        .filter(|s| (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .filter(|s| call(&["merge-base", "--is-ancestor", s, first]).is_ok());
    for (index, layer) in layers.iter().enumerate() {
        let number = layer["number"].as_u64().unwrap_or(first_number);
        let sha = layer["head"]["sha"].as_str().ok_or_else(preparing)?;
        let branch = layer["head"]["ref"].as_str().ok_or_else(preparing)?;
        let upstream = if index == 0 {
            if let Some(sha) = merged {
                sha.to_owned()
            } else {
                String::from_utf8(
                    call(&["merge-base", &old, sha])
                        .map_err(|_| failed("reading the fork point", number, index))?,
                )
                .map_err(|_| preparing())?
                .trim()
                .to_owned()
            }
        } else {
            old.clone()
        };
        call(&["checkout", "--quiet", "--detach", sha])
            .map_err(|_| failed("checking out", number, index))?;
        let rebase_args = ["rebase", "--quiet", "--onto", &new, &upstream]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let mut status = None;
        if git_with_status(&rebase_args, &mut status).is_err() {
            if status.is_none() {
                return Err(failed("rebasing", number, index));
            }
            let _ = call(&["rebase", "--abort"]);
            return Err(format!("PR #{number} conflicts with the layer below it. {index} layers were rebased; resolve #{number} with `gh stack rebase` and push."));
        }
        let rebased = String::from_utf8(
            call(&["rev-parse", "HEAD"]).map_err(|_| failed("rebasing", number, index))?,
        )
        .map_err(|_| preparing())?
        .trim()
        .to_owned();
        if rebased != sha {
            call(&[
                "push",
                "--quiet",
                &format!("--force-with-lease=refs/heads/{branch}:{sha}"),
                "origin",
                &format!("{rebased}:refs/heads/{branch}"),
            ])
            .map_err(|_| failed("pushing", number, index))?;
        }
        old = sha.to_owned();
        new = rebased;
    }
    Ok(Value::Null)
}

fn github_action_summary(pr: &Value, project_id: &str, repo: &str) -> Option<Value> {
    for key in [
        "title",
        "url",
        "headRefName",
        "baseRefName",
        "updatedAt",
        "headRefOid",
    ] {
        pr[key].as_str()?;
    }
    pr["number"].as_u64()?;
    pr["isDraft"].as_bool()?;
    let state = if pr["mergedAt"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        "merged"
    } else {
        match pr["state"].as_str()? {
            "MERGED" => "merged",
            "CLOSED" => "closed",
            "OPEN" => "open",
            _ => return None,
        }
    };
    if !pr.get("autoMergeRequest")?.is_null() && !pr["autoMergeRequest"].is_object() {
        return None;
    }
    let trim = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let author = trim(&pr["author"]["login"]).map(|login| json!({"login":login,"name":trim(&pr["author"]["name"]),"avatarUrl":trim(&pr["author"]["avatarUrl"])}));
    let mut v = json!({"provider":"github","projectId":project_id,"repository":repo,"number":pr["number"],"title":pr["title"],"url":pr["url"],"state":state,"isDraft":pr["isDraft"],"headBranch":pr["headRefName"],"baseBranch":pr["baseRefName"],"closedAt":trim(&pr["closedAt"]),"mergedAt":trim(&pr["mergedAt"]),"updatedAt":pr["updatedAt"],"observedAt":chrono::Utc::now().timestamp_millis(),"author":author,"autoMergeEnabled":!pr["autoMergeRequest"].is_null()});
    if let Some(sha) = trim(&pr["headRefOid"]) {
        v["headSha"] = json!(sha);
    }
    if let Some(method) = match pr["autoMergeRequest"]["mergeMethod"].as_str() {
        Some("MERGE") => Some("merge"),
        Some("SQUASH") => Some("squash"),
        Some("REBASE") => Some("rebase"),
        _ => None,
    } {
        v["autoMergeMethod"] = json!(method);
    }
    Some(v)
}

// Approval applies to runs rather than PRs; require an unambiguous head and
// revalidate both the head and pending run immediately before every write.
fn approve_github_workflows(
    root: &str,
    host: &str,
    repo: &str,
    number: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<(), ()> {
    let (owner, name) = repo.split_once('/').ok_or(())?;
    let gh = |args: &[&str]| -> Result<Value, ()> {
        let mut cmd = Command::new("gh");
        cmd.args(args).current_dir(root);
        if let Some(c) = credential {
            c.apply(&mut cmd);
        }
        let raw =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
                .map_err(|_| ())?;
        if raw.is_empty() {
            return Ok(Value::Null);
        }
        let v: Value = serde_json::from_slice(&raw).map_err(|_| ())?;
        if v.get("errors").is_some() {
            return Err(());
        }
        Ok(v)
    };
    let graphql = |query: String| {
        gh(&[
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={query}"),
        ])
    };
    let head = || -> Result<Value, ()> {
        let v = graphql(format!("query WorkflowApprovalHead {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ headRefOid headRefName isCrossRepository headRepositoryOwner {{ login }} }} }} }}", json!(owner), json!(name)))?;
        let pr = v["data"]["repository"]["pullRequest"].clone();
        if !pr.is_object() {
            return Err(());
        }
        Ok(pr)
    };
    let initial = head()?;
    if initial["isCrossRepository"] == false {
        return Ok(());
    }
    if initial["isCrossRepository"] != true {
        return Err(());
    }
    let sha = initial["headRefOid"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    let branch = initial["headRefName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    let head_owner = initial["headRepositoryOwner"]["login"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    let list = || -> Result<Vec<u64>, ()> {
        let mut cursor: Option<String> = None;
        let mut seen = 0usize;
        let mut matches = Vec::new();
        let mut pages = 0;
        loop {
            pages += 1;
            if pages > 11 {
                return Err(());
            }
            let after = cursor
                .as_ref()
                .map(|c| format!(",after:{}", json!(c)))
                .unwrap_or_default();
            let v = graphql(format!("query PullRequestHeads {{ repository(owner:{},name:{}) {{ pullRequests(first:100{after},states:[OPEN],headRefName:{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ number headRefOid isCrossRepository headRepositoryOwner {{ login }} }} }} }} }}", json!(owner), json!(name), json!(branch)))?;
            let page = &v["data"]["repository"]["pullRequests"];
            let nodes = page["nodes"].as_array().ok_or(())?;
            seen += nodes.len();
            if seen > 1000 {
                return Err(());
            }
            for pr in nodes {
                if pr["headRefOid"] == sha
                    && pr["isCrossRepository"] == true
                    && pr["headRepositoryOwner"]["login"]
                        .as_str()
                        .is_some_and(|o| o.eq_ignore_ascii_case(head_owner))
                {
                    matches.push(pr["number"].as_u64().ok_or(())?);
                }
            }
            match page["pageInfo"]["hasNextPage"].as_bool().ok_or(())? {
                false => break,
                true => {
                    let next = page["pageInfo"]["endCursor"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(())?
                        .to_owned();
                    if cursor.as_ref() == Some(&next) || seen >= 1000 {
                        return Err(());
                    }
                    cursor = Some(next);
                }
            }
        }
        if matches.len() != 1 || matches[0].to_string() != number {
            return Err(());
        }
        let enc =
            |s: &str| -> String { url::form_urlencoded::byte_serialize(s.as_bytes()).collect() };
        let mut ids = Vec::new();
        for page in 1..=11 {
            let path = format!("repos/{owner}/{name}/actions/runs?head_sha={}&branch={}&event=pull_request&status=action_required&per_page=100&page={page}", enc(sha), enc(branch));
            let v = gh(&["api", "--hostname", host, &path])?;
            let runs = v["workflow_runs"].as_array().ok_or(())?;
            if runs.len() > 100 {
                return Err(());
            }
            for run in runs {
                ids.push(run["id"].as_u64().filter(|id| *id > 0).ok_or(())?);
            }
            if ids.len() > 1000 {
                return Err(());
            }
            if runs.len() < 100 {
                return Ok(ids);
            }
        }
        Err(())
    };
    for id in list()? {
        let current = head()?;
        if current["isCrossRepository"] != true
            || current["headRefOid"] != sha
            || current["headRefName"] != branch
            || !current["headRepositoryOwner"]["login"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(head_owner))
        {
            return Err(());
        }
        if list()?.contains(&id) {
            let path = format!("repos/{owner}/{name}/actions/runs/{id}/approve");
            gh(&["api", "--hostname", host, "--method", "POST", &path])?;
        }
    }
    Ok(())
}

// Keep writes scoped to the selected project and clean up a newly created branch
// if the revert commit or merge request creation fails.
fn gitlab_disable_auto_merge(root: &str, host: &str, repo: &str, number: &str) -> Result<Value, ()> {
    let encode = |s: &str| -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    };
    let path = format!(
        "projects/{}/merge_requests/{number}/cancel_merge_when_pipeline_succeeds",
        encode(repo)
    );
    let mut cmd = Command::new("glab");
    cmd.args(["api", &path, "--method", "POST"])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let bytes = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
        .map_err(|_| ())?;
    // Successful writes may return an empty body.
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// Re-read both the PR and source ref immediately before using GitHub's atomic
// compare-and-delete mutation. Never fall back to an unconditional REST delete.
fn delete_github_branch(
    root: &str,
    host: &str,
    repo: &str,
    number: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Value, ()> {
    let (owner, name) = repo.split_once('/').ok_or(())?;
    let graphql = |query: String| -> Result<Value, ()> {
        let mut cmd = Command::new("gh");
        cmd.args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={query}"),
        ])
        .current_dir(root);
        if let Some(c) = credential {
            c.apply(&mut cmd);
        }
        let raw =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
                .map_err(|_| ())?;
        let value: Value = serde_json::from_slice(&raw).map_err(|_| ())?;
        if value.get("errors").is_some() {
            return Err(());
        }
        Ok(value)
    };
    let value = graphql(format!("query PullRequestBranchToDelete {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ state headRefName baseRefName headRefOid headRepository {{ id }} }} }} }}", json!(owner), json!(name)))?;
    let pr = &value["data"]["repository"]["pullRequest"];
    if pr["state"] != "CLOSED" && pr["state"] != "MERGED" {
        return Err(());
    }
    let source = pr["headRepository"]["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    let head = pr["headRefName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    let oid = pr["headRefOid"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(())?;
    if pr["baseRefName"].as_str().is_none_or(|base| base == head) {
        return Err(());
    }
    let refname = format!("refs/heads/{head}");
    let value = graphql(format!("query PullRequestSourceBranch {{ node(id:{}) {{ __typename ... on Repository {{ defaultBranchRef {{ name }} ref(qualifiedName:{}) {{ target {{ oid }} }} }} }} }}", json!(source), json!(refname)))?;
    let node = &value["data"]["node"];
    if node["__typename"] != "Repository" {
        return Err(());
    }
    if node["ref"].is_null() {
        return Ok(Value::Null);
    }
    if node["defaultBranchRef"]["name"]
        .as_str()
        .is_none_or(|default| default == head)
        || node["ref"]["target"]["oid"] != oid
    {
        return Err(());
    }
    let value = graphql(format!("mutation DeletePullRequestBranch {{ updateRefs(input:{{repositoryId:{},refUpdates:[{{name:{},beforeOid:{},afterOid:\"0000000000000000000000000000000000000000\"}}]}}) {{ clientMutationId }} }}", json!(source), json!(refname), json!(oid)))?;
    if !value["data"]["updateRefs"].is_object() {
        return Err(());
    }
    Ok(Value::Null)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    // Cargo can replace the test binary while another build is linking. On Linux,
    // execute the running inode through procfs instead of its possibly deleted path.
    fn test_executable() -> std::path::PathBuf {
        #[cfg(target_os = "linux")]
        {
            std::path::PathBuf::from("/proc/self/exe")
        }
        #[cfg(not(target_os = "linux"))]
        {
            std::env::current_exe().unwrap()
        }
    }

    #[test]
    fn stack_rebase_cascades_and_uses_force_with_lease() {
        let root = std::env::temp_dir().join(format!("t3-rebase-test-{}", uuid::Uuid::new_v4()));
        let work = root.join("work");
        let remote = root.join("remote.git");
        std::fs::create_dir_all(&work).unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| -> String {
            let out = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_CONFIG_COUNT", "2")
                .env("GIT_CONFIG_KEY_0", "user.name")
                .env("GIT_CONFIG_VALUE_0", "Fixture")
                .env("GIT_CONFIG_KEY_1", "user.email")
                .env("GIT_CONFIG_VALUE_1", "fixture@example.invalid")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        };
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(&work, &["init", "-b", "main"]);
        std::fs::write(work.join("base"), "base").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "base"]);
        git(&work, &["checkout", "-b", "one"]);
        std::fs::write(work.join("one"), "one").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "one"]);
        let one = git(&work, &["rev-parse", "HEAD"]);
        git(&work, &["checkout", "-b", "two"]);
        std::fs::write(work.join("two"), "two").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "two"]);
        let two = git(&work, &["rev-parse", "HEAD"]);
        git(&work, &["checkout", "main"]);
        std::fs::write(work.join("new-base"), "new").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "new base"]);
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&work, &["push", "origin", "main", "one", "two"]);
        let layers = [
            json!({"number":1,"head":{"ref":"one","sha":one}}),
            json!({"number":2,"head":{"ref":"two","sha":two}}),
        ];
        assert_eq!(
            cascade_stack_rebase(
                remote.to_str().unwrap(),
                "main",
                &layers.iter().collect::<Vec<_>>(),
                None,
                "fixture-token"
            ),
            Ok(Value::Null)
        );
        let new_one = git(&work, &["ls-remote", "origin", "refs/heads/one"])
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
        let new_two = git(&work, &["ls-remote", "origin", "refs/heads/two"])
            .split_whitespace()
            .next()
            .unwrap()
            .to_owned();
        assert_ne!(new_one, one);
        assert_ne!(new_two, two);
        git(&work, &["fetch", "origin"]);
        git(&work, &["merge-base", "--is-ancestor", &new_one, &new_two]);
        // Reusing reviewed old heads must fail the lease and leave both branches unchanged.
        assert!(cascade_stack_rebase(
            remote.to_str().unwrap(),
            "main",
            &layers.iter().collect::<Vec<_>>(),
            None,
            "fixture-token"
        )
        .is_err());
        assert_eq!(
            git(&work, &["ls-remote", "origin", "refs/heads/one"])
                .split_whitespace()
                .next()
                .unwrap(),
            new_one
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn github_stack_merge_requires_matching_open_heads() {
        const CHILD: &str = "T3_STACK_MERGE_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let root = std::env::var("T3_STACK_MERGE_ROOT").unwrap();
            for (mode, expected, succeeds, writes) in [
                (
                    "ok",
                    json!([{"number":2,"headSha":"bbb"},{"number":3,"headSha":"ccc"}]),
                    true,
                    true,
                ),
                ("ok", json!([{"number":3,"headSha":"old"}]), false, false),
                (
                    "draft",
                    json!([{"number":2,"headSha":"bbb"},{"number":3,"headSha":"ccc"}]),
                    false,
                    false,
                ),
                (
                    "failed",
                    json!([{"number":2,"headSha":"bbb"},{"number":3,"headSha":"ccc"}]),
                    false,
                    true,
                ),
            ] {
                std::fs::write(format!("{root}/mode"), mode).unwrap();
                std::fs::write(format!("{root}/calls"), "").unwrap();
                let input = json!({"number":3,"stackNumber":50,"expectedStackHeads":expected,"mergeMethod":"squash"});
                assert_eq!(
                    run_github_stack(&root, "github.com", "owner/repo", &input, None).is_ok(),
                    succeeds,
                    "{mode}"
                );
                let calls = std::fs::read_to_string(format!("{root}/calls")).unwrap();
                assert_eq!(calls.contains("--method PUT"), writes, "{mode}: {calls}");
                if writes {
                    assert!(calls.contains("\"sha\":\"ccc\""));
                    assert!(calls.contains("\"merge_method\":\"squash\""));
                }
            }
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-stack-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("gh");
        std::fs::write(&script,r##"#!/bin/sh
printf '%s\n' "$*" >> calls
case "$*" in
 *'--method PUT'*) cat >> calls; [ "$(cat mode)" = failed ] && printf '%s' '{"status":"failed","details":{}}' || printf '%s' '{"status":"enqueued","details":{}}' ;;
 *) [ "$(cat mode)" = draft ] && draft=true || draft=false; printf '[{"number":50,"url":"https://example.invalid/stack","base":{"ref":"main"},"pull_requests":[{"number":1,"state":"closed","merged_at":"2025-01-01","head":{"ref":"base","sha":"aaa"}},{"number":2,"state":"open","head":{"ref":"middle","sha":"bbb"}},{"number":3,"state":"open","draft":%s,"head":{"ref":"top","sha":"ccc"}}]}]' "$draft" ;;
esac
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let status = Command::new(test_executable())
            .args([
                "--exact",
                "pull_request_actions::tests::github_stack_merge_requires_matching_open_heads",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("T3_STACK_MERGE_ROOT", &root)
            .env(
                "PATH",
                format!("{}:{}", root.display(), std::env::var("PATH").unwrap()),
            )
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(root);
        assert!(status.success());
    }

    #[test]
    fn github_action_summary_maps_mutation_result() {
        let pr = json!({"number":7,"title":"Fix","url":"https://github.com/o/r/pull/7","headRefName":"feature","baseRefName":"main","state":"OPEN","isDraft":false,"updatedAt":"2025-01-01T00:00:00Z","mergedAt":null,"closedAt":null,"headRefOid":"abc","author":{"login":"alice","name":"Alice","avatarUrl":null},"autoMergeRequest":{"mergeMethod":"SQUASH"}});
        let value = github_action_summary(&pr, "p", "o/r").unwrap();
        assert_eq!(value["autoMergeEnabled"], true);
        assert_eq!(value["autoMergeMethod"], "squash");
        assert_eq!(value["headSha"], "abc");
        assert_eq!(value["author"]["login"], "alice");
        assert!(value.get("additions").is_none());
        let mut invalid = pr;
        invalid.as_object_mut().unwrap().remove("title");
        assert!(github_action_summary(&invalid, "p", "o/r").is_none());
    }

    #[test]
    fn github_workflow_approval_revalidates_head_and_runs() {
        const CHILD: &str = "T3_APPROVAL_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let root = std::env::var("T3_APPROVAL_ROOT").unwrap();
            for (mode, ok, approved) in [
                ("ok", true, true),
                ("ambiguous", false, false),
                ("changed", false, false),
                ("gone", true, false),
                ("same", true, false),
            ] {
                std::fs::write(format!("{root}/mode"), mode).unwrap();
                std::fs::write(format!("{root}/calls"), "").unwrap();
                let _ = std::fs::remove_file(format!("{root}/head-count"));
                let _ = std::fs::remove_file(format!("{root}/run-count"));
                assert_eq!(
                    approve_github_workflows(&root, "github.com", "owner/repo", "7", None).is_ok(),
                    ok,
                    "{mode}"
                );
                let calls = std::fs::read_to_string(format!("{root}/calls")).unwrap();
                assert_eq!(calls.contains("--method POST"), approved, "{mode}: {calls}");
            }
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-approval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("gh");
        std::fs::write(&script, r##"#!/bin/sh
printf '%s\n' "$*" >> calls
mode=$(cat mode)
case "$*" in
 *'query WorkflowApprovalHead'*)
   cross=true; sha=abc; [ "$mode" = same ] && cross=false
   [ "$mode" = changed ] && [ -f head-count ] && sha=def
   touch head-count
   printf '{"data":{"repository":{"pullRequest":{"isCrossRepository":%s,"headRefOid":"%s","headRefName":"feature","headRepositoryOwner":{"login":"fork"}}}}}' "$cross" "$sha" ;;
 *'query PullRequestHeads'*)
   node='{"number":7,"headRefOid":"abc","isCrossRepository":true,"headRepositoryOwner":{"login":"fork"}}'
   [ "$mode" = ambiguous ] && nodes="$node,$node" || nodes="$node"
   printf '{"data":{"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false},"nodes":[%s]}}}}' "$nodes" ;;
 *'--method POST'*) printf '{}' ;;
 *'/actions/runs?'*)
   runs='[{"id":42}]'; [ "$mode" = gone ] && [ -f run-count ] && runs='[]'; touch run-count
   printf '{"workflow_runs":%s}' "$runs" ;;
 *) exit 1 ;;
esac
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let status = Command::new(test_executable())
            .args([
                "--exact",
                "pull_request_actions::tests::github_workflow_approval_revalidates_head_and_runs",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("T3_APPROVAL_ROOT", &root)
            .env(
                "PATH",
                format!("{}:{}", root.display(), std::env::var("PATH").unwrap()),
            )
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(root);
        assert!(status.success());
    }

    #[test]
    fn gitlab_disable_auto_merge_posts_to_the_merge_request() {
        const CHILD: &str = "T3_GITLAB_DISABLE_AUTO_MERGE_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = root.to_str().unwrap();
            assert_eq!(gitlab_disable_auto_merge(root, "gitlab.example", "group/repo", "7"), Ok(Value::Null));
            assert_eq!(
                std::fs::read_to_string(format!("{root}/calls")).unwrap().trim(),
                "api projects/group%2Frepo/merge_requests/7/cancel_merge_when_pipeline_succeeds --method POST"
            );
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-gitlab-disable-auto-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("glab");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s\\n' \"$*\" > calls\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let status = Command::new(test_executable())
            .args([
                "--exact",
                "pull_request_actions::tests::gitlab_disable_auto_merge_posts_to_the_merge_request",
                "--nocapture",
            ])
            .env(CHILD, &root)
            .env(
                "PATH",
                format!("{}:{}", root.display(), std::env::var("PATH").unwrap()),
            )
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(root);
        assert!(status.success());
    }

    #[test]
    fn github_actions_use_expected_mutations() {
        const CHILD: &str = "T3_ACTIONS_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let root = std::env::var("T3_ACTIONS_TEST_ROOT").unwrap();
            let projects = vec![("p".into(), "P".into(), root.clone())];
            for action in [
                "ready",
                "draft",
                "close",
                "reopen",
                "disable-auto-merge",
                "revert",
                "update-branch",
                "merge",
                "enable-auto-merge",
            ] {
                let input =
                    json!({"projectId":"p","repository":"owner/repo","number":7,"action":action});
                assert!(valid(&input));
                assert_eq!(run(projects.clone(), &input), Ok(Value::Null), "{action}");
            }
            // Deletion requires a closed PR, a matching source ref, and an atomic OID guard.
            for (mode, succeeds, mutation) in [
                ("ok", true, true),
                ("moved", false, false),
                ("gone", true, false),
                ("open", false, false),
            ] {
                std::fs::write(format!("{root}/branch-mode"), mode).unwrap();
                std::fs::write(format!("{root}/calls"), "").unwrap();
                let result = delete_github_branch(&root, "github.com", "owner/repo", "7", None);
                assert_eq!(result.is_ok(), succeeds, "{mode}");
                let calls = std::fs::read_to_string(format!("{root}/calls")).unwrap();
                assert_eq!(
                    calls.contains("mutation DeletePullRequestBranch"),
                    mutation,
                    "{mode}: {calls}"
                );
                if mutation {
                    assert!(calls.contains("beforeOid:\"abc\""));
                }
            }
            // The fixture changes the CLI credential after capture; all action
            // requests must still use the token captured at the start.
            std::fs::write(format!("{root}/tokens"), "").unwrap();
            let pinned = json!({"projectId":"p","host":"github.com","repository":"owner/repo","number":7,"action":"close","expectedAccountId":"123"});
            assert_eq!(run(projects.clone(), &pinned), Ok(Value::Null));
            let tokens = std::fs::read_to_string(format!("{root}/tokens")).unwrap();
            assert!(
                tokens.lines().all(|line| line == "original-token"),
                "{tokens}"
            );
            assert!(tokens.lines().count() >= 4);
            std::fs::write(format!("{root}/calls"), "").unwrap();
            std::fs::remove_file(format!("{root}/switched")).unwrap();
            let mut wrong = pinned.clone();
            wrong["expectedAccountId"] = json!("456");
            assert_eq!(
                run(projects.clone(), &wrong).unwrap_err()["operation"],
                "routeIdentity"
            );
            assert!(!std::fs::read_to_string(format!("{root}/calls"))
                .unwrap()
                .contains("mutation {"));
            // Isolated fake responses exercise the same action-state cases as upstream.
            for (queued, status, action, method, expected) in [
                (
                    true,
                    "CLEAN",
                    "merge",
                    "squash",
                    "enablePullRequestAutoMerge",
                ),
                (
                    false,
                    "CLEAN",
                    "enable-auto-merge",
                    "rebase",
                    "mergePullRequest",
                ),
                (
                    false,
                    "BLOCKED",
                    "enable-auto-merge",
                    "squash",
                    "enablePullRequestAutoMerge",
                ),
            ] {
                let state = json!({"data":{"repository":{"pullRequest":{"id":"id","headRefOid":"abc","isMergeQueueEnabled":queued,"mergeStateStatus":status}}}});
                std::fs::write(format!("{root}/state.json"), state.to_string()).unwrap();
                std::fs::write(format!("{root}/calls"), "").unwrap();
                let input = json!({"projectId":"p","repository":"owner/repo","number":7,"action":action,"mergeMethod":method});
                assert_eq!(run(projects.clone(), &input), Ok(Value::Null));
                let calls = std::fs::read_to_string(format!("{root}/calls")).unwrap();
                assert!(
                    calls.contains(&format!("mutation {{ {expected}(")),
                    "{calls}"
                );
                assert!(
                    calls.contains(&format!(
                        "expectedHeadOid:\"abc\",mergeMethod:{}",
                        method.to_uppercase()
                    )),
                    "{calls}"
                );
            }
            let missing_head = json!({"data":{"repository":{"pullRequest":{"id":"id","isMergeQueueEnabled":false,"mergeStateStatus":"CLEAN"}}}});
            std::fs::write(format!("{root}/state.json"), missing_head.to_string()).unwrap();
            std::fs::write(format!("{root}/calls"), "").unwrap();
            let input =
                json!({"projectId":"p","repository":"owner/repo","number":7,"action":"merge"});
            assert!(run(projects.clone(), &input).is_err());
            assert!(!std::fs::read_to_string(format!("{root}/calls"))
                .unwrap()
                .contains("mutation {"));
            std::fs::remove_file(format!("{root}/state.json")).unwrap();
            // Restore the standard fixture calls for the assertions below.
            for action in [
                "ready",
                "draft",
                "close",
                "reopen",
                "disable-auto-merge",
                "revert",
                "update-branch",
                "merge",
                "enable-auto-merge",
            ] {
                let input =
                    json!({"projectId":"p","repository":"owner/repo","number":7,"action":action});
                assert_eq!(run(projects.clone(), &input), Ok(Value::Null));
            }
            let calls = std::fs::read_to_string(format!("{root}/calls")).unwrap();
            for mutation in [
                "markPullRequestReadyForReview",
                "convertPullRequestToDraft",
                "closePullRequest",
                "reopenPullRequest",
                "disablePullRequestAutoMerge",
                "revertPullRequest",
                "updatePullRequestBranch",
                "mergePullRequest",
                "enablePullRequestAutoMerge",
            ] {
                assert!(calls.contains(mutation), "missing {mutation}");
            }
            assert!(calls.contains("expectedHeadOid:\"abc\",updateMethod:MERGE"));
            assert!(calls.contains("expectedHeadOid:\"abc\",mergeMethod:MERGE"));
            assert!(calls.contains("revertPullRequest { id }"));
            let bad = json!({"projectId":"p","repository":"owner/repo","number":7,"action":"merge","stackNumber":1});
            assert_eq!(run(projects, &bad).unwrap_err()["operation"], "runAction");
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-actions-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git"
            ])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        let detail = json!({"data":{"viewer":{"login":"me"},"repository":{"viewerPermission":"WRITE","autoMergeAllowed":true,"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"pullRequest":{"number":7,"title":"Fix","url":"https://github.com/owner/repo/pull/7","state":"OPEN","mergeStateStatus":"BLOCKED","isDraft":false,"additions":0,"deletions":0,"changedFiles":0,"headRefName":"feature","baseRefName":"main","headRefOid":"abc","updatedAt":"2026-01-01T00:00:00Z","viewerCanUpdate":true,"viewerCanUpdateBranch":true,"baseRef":{"compare":{"behindBy":1}},"commits":{"nodes":[]}}}}});
        std::fs::write(root.join("detail.json"), detail.to_string()).unwrap();
        let script = bin.join("gh");
        std::fs::write(&script, r##"#!/bin/sh
printf '%s\n' "$*" >> calls
case "$*" in
 *'auth token'*) [ -f switched ] && { printf '%s' 'changed-token'; exit; }; touch switched; printf '%s' 'original-token'; exit ;;
 *'api user'*) printf '%s\n' "$GH_TOKEN" >> tokens; printf '%s' '{"id":123,"login":"me"}'; exit ;;
esac
[ -n "$GH_TOKEN" ] && printf '%s\n' "$GH_TOKEN" >> tokens
case "$*" in
 *'query PullRequestBranchToDelete'*) if [ "$(cat branch-mode)" = open ]; then state=OPEN; else state=CLOSED; fi; printf '{"data":{"repository":{"pullRequest":{"state":"%s","headRefName":"feature","baseRefName":"main","headRefOid":"abc","headRepository":{"id":"repo-id"}}}}}' "$state" ;;
 *'query PullRequestSourceBranch'*) case "$(cat branch-mode)" in gone) ref=null ;; moved) ref='{"target":{"oid":"changed"}}' ;; *) ref='{"target":{"oid":"abc"}}' ;; esac; printf '{"data":{"node":{"__typename":"Repository","defaultBranchRef":{"name":"main"},"ref":%s}}}' "$ref" ;;
 *'mutation DeletePullRequestBranch'*) printf '%s' '{"data":{"updateRefs":{"clientMutationId":null}}}' ;;
 *'mutation {'*'revertPullRequest'*) printf '%s' '{"data":{"revertPullRequest":{"revertPullRequest":{"id":"new"}}}}' ;;
 *'mutation {'*) name=$(printf '%s' "$*" | sed -n 's/.*mutation { \([A-Za-z]*\)(.*/\1/p'); printf '{"data":{"%s":{"pullRequest":{"id":"id"}}}}' "$name" ;;
 *'pullRequest(number:7) { id headRefOid'* ) [ -f state.json ] && { cat state.json; exit; }; printf '%s' '{"data":{"repository":{"pullRequest":{"id":"id","headRefOid":"abc","isMergeQueueEnabled":false,"mergeStateStatus":"BLOCKED"}}}}' ;;
 *) cat detail.json ;;
esac
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
        let status = Command::new(test_executable())
            .args([
                "--exact",
                "pull_request_actions::tests::github_actions_use_expected_mutations",
                "--nocapture",
            ])
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env(CHILD, "1")
            .env("T3_ACTIONS_TEST_ROOT", &root)
            .env("PATH", path)
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(root);
        assert!(status.success());
    }
}
