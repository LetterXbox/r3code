//! GitHub pull request detail reads.
use crate::github_pinned_credential;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::{process::Command, time::Duration};

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh")
}
fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    read_pinned_with(projects, input, exe).map(|(detail, _)| detail)
}

pub(crate) fn read_pinned(
    projects: Vec<(String, String, String)>,
    input: &Value,
) -> Result<(Value, Option<github_pinned_credential::PinnedCredential>), Value> {
    read_pinned_with(projects, input, "gh")
}

fn read_pinned_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<(Value, Option<github_pinned_credential::PinnedCredential>), Value> {
    let rejected = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."});
    let unsupported =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    let mismatch = || json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."});
    let resolved: Vec<_> = projects
        .into_iter()
        .map(|(id, title, root)| {
            let identity = crate::repository_identity::resolve(&root);
            (id, title, root, identity)
        })
        .collect();
    let requested = input["projectId"].as_str().unwrap();
    let repo = input["repository"].as_str().unwrap().trim();
    let host = input.get("host").and_then(Value::as_str).map(str::trim);
    let matches = |p: &&(String, String, String, Option<Value>)| {
        p.3.as_ref()
            .and_then(|v| v["canonicalKey"].as_str())
            .and_then(|k| k.split_once('/'))
            .is_some_and(|(h, r)| {
                r.eq_ignore_ascii_case(repo) && host.is_none_or(|x| x.eq_ignore_ascii_case(h))
            })
    };
    let selected = resolved.iter().find(|p| p.0 == requested);
    let project = selected
        .filter(matches)
        .or_else(|| host.and_then(|_| resolved.iter().find(matches)))
        .ok_or_else(|| {
            if input.get("expectedAccountId").is_some() {
                return rejected();
            }
            if host.is_none() && selected.is_some_and(|p| p.3.is_some()) {
                mismatch()
            } else {
                unsupported()
            }
        })?;
    let identity = project.3.as_ref().unwrap();
    if identity["provider"] == "gitlab" {
        return crate::gitlab_pull_request_read::read(project, input, true)
            .map(|detail| (detail, None));
    }
    if identity["provider"] != "github" {
        return Err(if input.get("expectedAccountId").is_some() {
            rejected()
        } else {
            unsupported()
        });
    }
    let (host, _) = identity["canonicalKey"]
        .as_str()
        .unwrap()
        .split_once('/')
        .unwrap();
    let credential = if let Some(expected) = input.get("expectedAccountId").and_then(Value::as_str)
    {
        if !input
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|h| h.eq_ignore_ascii_case(host))
        {
            return Err(rejected());
        }
        Some(
            github_pinned_credential::capture(exe, &project.2, host, expected)
                .ok_or_else(rejected)?,
        )
    } else {
        None
    };
    let repo = identity["displayName"].as_str().ok_or_else(unsupported)?;
    let (owner, name) = repo.split_once('/').ok_or_else(unsupported)?;
    let number = input["number"].as_u64().unwrap();
    let required_field = if host.eq_ignore_ascii_case("github.com") {
        format!("isRequired(pullRequestNumber:{number})")
    } else {
        String::new()
    };
    let query = format!(
        r#"query {{ viewer {{ login }} repository(owner:{},name:{}) {{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerPermission pullRequest(number:{number}) {{ number title url body state isDraft mergeable mergeStateStatus additions deletions changedFiles createdAt updatedAt mergedAt closedAt headRefName baseRefName headRefOid isCrossRepository maintainerCanModify viewerCanUpdate viewerDidAuthor viewerCanUpdateBranch headRepositoryOwner {{ __typename login }} headRepository {{ nameWithOwner viewerPermission }} headRef {{ id }} baseRef {{ compare(headRef:{}) {{ behindBy }} }} author {{ login avatarUrl ... on User {{ name }} }} autoMergeRequest {{ mergeMethod }} reviewRequests(first:100) {{ nodes {{ requestedReviewer {{ ... on User {{ login name }} ... on Bot {{ login }} ... on Team {{ slug combinedSlug teamName:name teamAvatarUrl:avatarUrl }} }} }} }} labels(first:100) {{ nodes {{ name color description }} }} commits(last:1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first:100) {{ nodes {{ ... on StatusContext {{ context state targetUrl description createdAt {required_field} }} ... on CheckRun {{ name status conclusion detailsUrl startedAt completedAt checkSuite {{ workflowRun {{ workflow {{ name }} }} }} {required_field} }} }} pageInfo {{ hasNextPage endCursor }} }} }} }} }} }} }} }} }} }}"#,
        json!(owner),
        json!(name),
        json!(format!("refs/pull/{number}/head"))
    );
    let args = [
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        &format!("query={query}"),
    ];
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(&project.2);
    if let Some(credential) = &credential {
        credential.apply(&mut cmd);
    }
    let error = || json!({"_tag":"PullRequestOperationError","operation":"detail","detail":"The pull request could not be read."});
    let bytes = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
        .map_err(|failure| {
            github_pinned_credential::operation_error(
                failure,
                "detail",
                "The pull request could not be read.",
            )
        })?;
    let mut response: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
    let pr = &response["data"]["repository"]["pullRequest"];
    if !pr.is_object()
        || ["title", "url", "headRefName", "baseRefName", "updatedAt"]
            .iter()
            .any(|k| pr[*k].as_str().is_none_or(|s| s.trim().is_empty()))
        || pr["number"].as_u64().is_none_or(|n| n == 0)
        || !pr["isDraft"].is_boolean()
        || ["additions", "deletions", "changedFiles"]
            .iter()
            .any(|k| pr[*k].as_u64().is_none())
    {
        return Err(error());
    }
    let head = pr["headRefOid"].clone();
    let contexts = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"];
    let mut after = if contexts["pageInfo"]["hasNextPage"] == true {
        contexts["pageInfo"]["endCursor"]
            .as_str()
            .map(str::to_owned)
    } else {
        None
    };
    let mut seen = HashSet::new();
    for _ in 1..10 {
        let Some(cursor) = after.take() else { break };
        if !seen.insert(cursor.clone()) {
            break;
        }
        let page_query = format!(
            r#"query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ headRefOid commits(last:1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first:100,after:{}) {{ nodes {{ ... on StatusContext {{ context state targetUrl description createdAt {required_field} }} ... on CheckRun {{ name status conclusion detailsUrl startedAt completedAt checkSuite {{ workflowRun {{ workflow {{ name }} }} }} {required_field} }} }} pageInfo {{ hasNextPage endCursor }} }} }} }} }} }} }} }} }}"#,
            json!(owner),
            json!(name),
            json!(cursor)
        );
        let mut cmd = Command::new(exe);
        cmd.args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={page_query}"),
        ])
        .current_dir(&project.2);
        if let Some(credential) = &credential {
            credential.apply(&mut cmd);
        }
        let bytes = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
            .map_err(|failure| {
                github_pinned_credential::operation_error(
                    failure,
                    "detail",
                    "The pull request could not be read.",
                )
            })?;
        let page: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
        let page_pr = &page["data"]["repository"]["pullRequest"];
        let page_contexts =
            &page_pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"];
        if !page_pr.is_object()
            || page_pr["headRefOid"] != head
            || !page_contexts["nodes"].is_array()
        {
            return Err(
                json!({"_tag":"PullRequestOperationError","operation":"detail","detail":"Pull request head changed while reading checks."}),
            );
        }
        let next = if page_contexts["pageInfo"]["hasNextPage"] == true {
            page_contexts["pageInfo"]["endCursor"]
                .as_str()
                .map(str::to_owned)
        } else {
            None
        };
        if next.as_deref() == Some(cursor.as_str()) {
            break;
        }
        let nodes = response.pointer_mut("/data/repository/pullRequest/commits/nodes/0/commit/statusCheckRollup/contexts/nodes").and_then(Value::as_array_mut).ok_or_else(error)?;
        nodes.extend(page_contexts["nodes"].as_array().unwrap().iter().cloned());
        after = next;
    }
    let pr = &response["data"]["repository"]["pullRequest"];
    let mut result = map(
        pr,
        &response["data"]["repository"],
        &response["data"]["viewer"],
        &project.0,
        &project.1,
        &project.2,
        repo,
    );
    crate::pull_request_checks::augment(
        &mut result,
        pr,
        exe,
        host,
        &project.2,
        repo,
        credential.as_ref(),
    )?;
    Ok((result, credential))
}
fn map(
    pr: &Value,
    repository: &Value,
    viewer: &Value,
    project_id: &str,
    title: &str,
    root: &str,
    repo: &str,
) -> Value {
    let trim = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let actor = trim(&pr["author"]["login"]).map(|login| json!({"login":login,"name":trim(&pr["author"]["name"]),"avatarUrl":trim(&pr["author"]["avatarUrl"])}));
    let state = if pr["state"] == "MERGED" || !pr["mergedAt"].is_null() {
        "merged"
    } else if pr["state"] == "CLOSED" {
        "closed"
    } else {
        "open"
    };
    let mergeability = match pr["mergeable"].as_str() {
        Some("MERGEABLE") => "mergeable",
        Some("CONFLICTING") => "conflicting",
        _ => "unknown",
    };
    let write = matches!(
        repository["viewerPermission"].as_str(),
        Some("ADMIN" | "MAINTAIN" | "WRITE")
    );
    let triage = write || repository["viewerPermission"] == "TRIAGE";
    let author = pr["viewerDidAuthor"] == true;
    let update = pr["viewerCanUpdate"] == true;
    let update_branch = state == "open"
        && pr["baseRef"]["compare"].is_object()
        && pr["viewerCanUpdateBranch"] == true;
    let delete = matches!(
        pr["headRepository"]["viewerPermission"].as_str(),
        Some("ADMIN" | "MAINTAIN" | "WRITE")
    ) && pr["headRef"].is_object();
    let mut actions = Vec::new();
    if delete {
        actions.push("delete-branch");
    }
    if write {
        actions.push("merge");
        if repository["autoMergeAllowed"] == true
            && !matches!(
                pr["mergeStateStatus"].as_str(),
                Some("CLEAN" | "HAS_HOOKS" | "UNSTABLE")
            )
        {
            actions.push("enable-auto-merge");
        }
        actions.extend(["disable-auto-merge", "revert", "approve-workflows"]);
    }
    if update {
        actions.extend(["ready", "draft", "close", "reopen"]);
    }
    if update_branch {
        actions.push("update-branch");
    }
    let mut permissions = json!({"actions":actions,"comment":true,"resolve":write||author,"verdicts":if author {vec!["comment"]} else {vec!["comment","approve","request-changes"]},"requestReviewers":write,"labels":triage,"maintainerEdits":state=="open" && pr["isCrossRepository"]==true && author && pr["headRepositoryOwner"]["__typename"]=="User" && pr["headRepository"].is_object() && pr["headRef"].is_object()});
    if write {
        permissions["stackRebase"] = json!(true);
    }
    if update_branch {
        permissions["updateMethods"] = json!(["merge", "rebase"]);
    }
    let mut reviewer_seen = HashSet::new();
    let reviewers: Vec<Value> = pr["reviewRequests"]["nodes"].as_array().into_iter().flatten().filter_map(|v| { let r=&v["requestedReviewer"]; trim(&r["login"]).map(|login|json!({"login":login,"name":null,"avatarUrl":null})).or_else(|| trim(&r["combinedSlug"]).or_else(||trim(&r["slug"])).map(|login|json!({"login":login,"name":trim(&r["teamName"]),"avatarUrl":trim(&r["teamAvatarUrl"])}))) }).filter(|v| reviewer_seen.insert(v["login"].as_str().unwrap_or("").to_lowercase())).collect();
    let labels: Vec<Value> = pr["labels"]["nodes"].as_array().into_iter().flatten().filter_map(|v|trim(&v["name"]).map(|name|json!({"name":name,"color":trim(&v["color"])}))).collect();
    let mut checks_by_key: HashMap<(String, String), usize> = HashMap::new();
    let mut entries: Vec<(String, String, Option<String>, Value)> = Vec::new();
    for v in pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some(name) = trim(&v["name"]).or_else(|| trim(&v["context"])) else {
            continue;
        };
        let status = if v["status"]
            .as_str()
            .is_some_and(|s| s != "COMPLETED" && !s.is_empty())
        {
            "pending"
        } else {
            match v["conclusion"].as_str().or_else(|| v["state"].as_str()) {
                Some("SUCCESS") => "success",
                Some("ACTION_REQUIRED") => "action-required",
                Some("FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE") => "failure",
                Some("CANCELLED") => "cancelled",
                Some("SKIPPED") => "skipped",
                Some("PENDING" | "EXPECTED") => "pending",
                _ => "neutral",
            }
        };
        let workflow =
            trim(&v["checkSuite"]["workflowRun"]["workflow"]["name"]).unwrap_or_default();
        let at = if status == "pending" {
            Some("9999-12-31T23:59:59Z".to_owned())
        } else {
            trim(&v["completedAt"])
                .or_else(|| trim(&v["startedAt"]))
                .or_else(|| trim(&v["createdAt"]))
                .filter(|s| s != "0001-01-01T00:00:00Z")
        };
        let mut check = json!({"name":name,"status":status,"description":trim(&v["description"]),"url":trim(&v["detailsUrl"]).or_else(||trim(&v["targetUrl"]))});
        if let Some(required) = v["isRequired"].as_bool() {
            check["required"] = json!(required);
        }
        let key = (workflow.clone(), name.clone());
        if let Some(&index) = checks_by_key.get(&key) {
            if at >= entries[index].2 {
                entries[index] = (workflow, name, at, check);
            }
        } else {
            checks_by_key.insert(key, entries.len());
            entries.push((workflow, name, at, check));
        }
    }
    let mut counts = HashMap::new();
    for (_, name, _, _) in &entries {
        *counts.entry(name.clone()).or_insert(0usize) += 1;
    }
    let mut checks: Vec<Value> = entries
        .into_iter()
        .map(|(workflow, name, _, mut check)| {
            if !workflow.is_empty() && counts[&name] > 1 {
                check["name"] = json!(format!("{workflow} / {name}"));
            }
            check
        })
        .collect();
    checks.sort_by_key(|v| !matches!(v["status"].as_str(), Some("failure" | "cancelled")));

    let capabilities = json!({"diff":true,"comment":true,"actions":["merge","ready","draft","close","reopen","delete-branch","update-branch","enable-auto-merge","disable-auto-merge","revert","approve-workflows"],"mergeMethods":["merge","squash","rebase"],"deleteBranch":true,"updateMethods":["merge","rebase"],"search":true,"reactions":true,"mentions":true,"referenceSigils":["#"],"viewedFiles":"host","review":{"inlineComment":true,"rangeComment":true,"reply":true,"resolve":true,"verdicts":["comment","approve","request-changes"]},"reviewers":{"request":true,"listCandidates":true,"searchCandidates":true},"edit":{"changeRequest":true,"comment":true,"maintainerEdits":true},"stacks":true,"stackActions":true,"labels":true,"checksAlwaysReport":true});
    let behind = if state == "open" {
        pr["baseRef"]["compare"]["behindBy"].as_u64()
    } else {
        None
    };
    let mut result = json!({"provider":"github","capabilities":capabilities,"viewerPermissions":permissions,"projectId":project_id,"projectTitle":title,"workspaceRoot":root,"repository":repo,"number":pr["number"],"title":pr["title"],"body":pr["body"].as_str().unwrap_or(""),"url":pr["url"],"author":actor,"state":state,"isDraft":pr["isDraft"],"mergeability":mergeability,"additions":pr["additions"],"deletions":pr["deletions"],"changedFiles":pr["changedFiles"],"headBranch":pr["headRefName"],"headRepositoryNameWithOwner":trim(&pr["headRepository"]["nameWithOwner"]),"baseBranch":pr["baseRefName"],"createdAt":pr["createdAt"],"updatedAt":pr["updatedAt"],"observedAt":chrono::Utc::now().timestamp_millis(),"mergedAt":pr["mergedAt"],"closedAt":pr["closedAt"],"reviewers":reviewers,"labels":labels,"checks":checks,"mergeCapabilities":{"merge":repository["mergeCommitAllowed"],"squash":repository["squashMergeAllowed"],"rebase":repository["rebaseMergeAllowed"]},"baseComparison":behind.map_or("unknown",|n|if n>0 {"behind"} else {"up-to-date"}),"autoMergeEnabled":!pr["autoMergeRequest"].is_null(),"maintainerCanModify":pr["maintainerCanModify"]});
    if state != "open" || pr["isCrossRepository"] == false {
        result["workflowApprovalsRequired"] = json!(0);
    }
    if let Some(v) = trim(&pr["headRefOid"]) {
        result["headSha"] = json!(v)
    }
    if let Some(v) = trim(&viewer["login"]) {
        result["viewer"] = json!(v)
    }
    if let Some(n) = behind {
        result["behindBy"] = json!(n)
    }
    if let Some(m) = pr["autoMergeRequest"]["mergeMethod"]
        .as_str()
        .filter(|m| matches!(*m, "MERGE" | "SQUASH" | "REBASE"))
    {
        result["autoMergeMethod"] = json!(m.to_lowercase())
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_detail_permissions_and_comparison() {
        let pr = json!({"number":7,"title":"Fix","url":"https://example.test/7","body":"Body","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","additions":2,"deletions":1,"changedFiles":1,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","headRefName":"feature","baseRefName":"main","headRefOid":"abc","maintainerCanModify":true,"viewerCanUpdate":true,"viewerDidAuthor":true,"viewerCanUpdateBranch":true,"baseRef":{"compare":{"behindBy":2}},"labels":{"nodes":[{"name":"bug","color":"ff0000","description":null}]},"reviewRequests":{"nodes":[{"requestedReviewer":{"login":"reviewer"}}]}});
        let repo = json!({"viewerPermission":"WRITE","mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":false});
        let value = map(
            &pr,
            &repo,
            &json!({"login":"me"}),
            "p",
            "Project",
            "/tmp/project",
            "a/b",
        );
        assert_eq!(value["viewerPermissions"]["verdicts"], json!(["comment"]));
        assert_eq!(value["baseComparison"], "behind");
        assert_eq!(value["behindBy"], 2);
        assert_eq!(value["reviewers"][0]["login"], "reviewer");
        assert_eq!(value["labels"][0]["name"], "bug");
        assert_eq!(value["headSha"], "abc");
    }
    #[test]
    fn deduplicates_checks_and_reviewers_and_disambiguates_workflows() {
        let pr = json!({"reviewRequests":{"nodes":[{"requestedReviewer":{"login":"Alice"}},{"requestedReviewer":{"login":"alice"}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
            {"name":"test","status":"COMPLETED","conclusion":"SUCCESS","completedAt":"2026-01-01T00:00:00Z","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}}},
            {"name":"test","status":"COMPLETED","conclusion":"FAILURE","completedAt":"2026-01-02T00:00:00Z","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}}},
            {"name":"test","status":"COMPLETED","conclusion":"SUCCESS","checkSuite":{"workflowRun":{"workflow":{"name":"Other"}}}}
        ]}}}}]}});
        let value = map(&pr, &json!({}), &json!({}), "p", "P", "/tmp", "a/b");
        assert_eq!(value["reviewers"].as_array().unwrap().len(), 1);
        assert_eq!(value["checks"].as_array().unwrap().len(), 2);
        assert_eq!(value["checks"][0]["name"], "CI / test");
        assert_eq!(value["checks"][0]["status"], "failure");
        assert_eq!(value["checks"][1]["name"], "Other / test");
    }

    #[test]
    #[cfg(unix)]
    fn follows_check_pages_and_rejects_changed_heads() {
        use std::os::unix::fs::PermissionsExt;
        for scenario in ["complete", "repeat", "changed", "auth"] {
            let tmp = std::env::temp_dir().join(format!(
                "t3-pr-detail-pages-{}-{scenario}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&tmp);
            std::fs::create_dir_all(&tmp).unwrap();
            assert!(Command::new("git")
                .args(["init", "-q"])
                .current_dir(&tmp)
                .status()
                .unwrap()
                .success());
            assert!(Command::new("git")
                .args([
                    "remote",
                    "add",
                    "origin",
                    "https://github.com/Owner/Repo.git"
                ])
                .current_dir(&tmp)
                .status()
                .unwrap()
                .success());
            let contexts = |nodes: Value, next: bool, cursor: &str| json!({"nodes":nodes,"pageInfo":{"hasNextPage":next,"endCursor":cursor}});
            let mut pr = json!({"number":7,"title":"Fix","url":"https://example.test/7","state":"OPEN","isDraft":false,"headRefName":"a","baseRefName":"b","headRefOid":"abc","updatedAt":"2026-01-01T00:00:00Z","additions":0,"deletions":0,"changedFiles":0,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":null}}}]}});
            pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"] = contexts(
                json!([{"name":"first","status":"COMPLETED","conclusion":"SUCCESS"}]),
                true,
                "cursor-1",
            );
            let first = json!({"data":{"repository":{"pullRequest":pr}}});
            let mut page = first.clone();
            page["data"]["repository"]["pullRequest"]["headRefOid"] =
                json!(if scenario == "changed" {
                    "new-head"
                } else {
                    "abc"
                });
            page["data"]["repository"]["pullRequest"]["commits"]["nodes"][0]["commit"]
                ["statusCheckRollup"]["contexts"] = contexts(
                json!([{"name":"second","status":"COMPLETED","conclusion":"FAILURE"}]),
                scenario == "repeat",
                if scenario == "repeat" {
                    "cursor-1"
                } else {
                    "cursor-2"
                },
            );
            std::fs::write(tmp.join("first.json"), first.to_string()).unwrap();
            std::fs::write(tmp.join("page.json"), page.to_string()).unwrap();
            if scenario == "auth" {
                std::fs::write(tmp.join("fail-auth"), "").unwrap();
            }
            let script = tmp.join("fake-gh");
            std::fs::write(
                &script,
                r##"#!/bin/sh
printf '%s\n' "$*" >> calls
case "$*" in
  *'after:"cursor-1"'*) if [ -f fail-auth ]; then printf 'Bad credentials (HTTP 401) secret-token' >&2; exit 1; fi; cat page.json ;;
  *'after:'*) exit 2 ;;
  *) cat first.json ;;
esac
"##,
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let result = read_with(
                vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())],
                &json!({"projectId":"p","repository":"owner/repo","number":7}),
                script.to_str().unwrap(),
            );
            if scenario == "auth" {
                let error = result.unwrap_err();
                assert_eq!(error["reason"], "cli-unauthenticated");
                assert!(!error.to_string().contains("secret-token"));
            } else if scenario == "changed" {
                assert_eq!(
                    result.unwrap_err()["detail"],
                    "Pull request head changed while reading checks."
                );
            } else {
                let result = result.unwrap();
                let names: Vec<_> = result["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|check| check["name"].as_str().unwrap())
                    .collect();
                if scenario == "complete" {
                    assert_eq!(names, ["second", "first"]);
                } else {
                    assert_eq!(names, ["first"]);
                }
            }
            let calls = std::fs::read_to_string(tmp.join("calls")).unwrap();
            assert_eq!(calls.lines().count(), 2, "{scenario}: {calls}");
            assert!(calls.contains("after:\"cursor-1\""));
            std::fs::remove_dir_all(tmp).unwrap();
        }
    }

    #[test]
    #[cfg(unix)]
    fn pinned_detail_verifies_account_and_reuses_credential() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-detail-pin-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&tmp)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/Owner/Repo.git"
            ])
            .current_dir(&tmp)
            .status()
            .unwrap()
            .success());
        let script = tmp.join("fake-gh");
        std::fs::write(&script, r##"#!/bin/sh
if [ "$1" = auth ]; then printf 'captured-token'; exit 0; fi
if [ "$2" = user ]; then printf '%s' "$GH_TOKEN" > identity-token; printf '{"id":101,"login":"viewer"}'; exit 0; fi
printf '%s' "$GH_TOKEN" > detail-token
printf '%s' '{"data":{"repository":{"pullRequest":{"number":7,"title":"Fix","url":"https://example.test","state":"OPEN","isDraft":false,"headRefName":"a","baseRefName":"b","updatedAt":"2026-01-01T00:00:00Z","additions":0,"deletions":0,"changedFiles":0}}}}'
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = || vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())];
        let input = json!({"projectId":"p","repository":"owner/repo","host":"github.com","number":7,"expectedAccountId":"101"});
        read_with(projects(), &input, script.to_str().unwrap()).unwrap();
        let identity_token = std::fs::read(tmp.join("identity-token")).unwrap();
        assert!(!identity_token.is_empty());
        assert_eq!(
            identity_token,
            std::fs::read(tmp.join("detail-token")).unwrap()
        );
        std::fs::remove_file(tmp.join("detail-token")).unwrap();
        let mut mismatch = input.clone();
        mismatch["expectedAccountId"] = json!("202");
        let error = read_with(projects(), &mismatch, script.to_str().unwrap()).unwrap_err();
        assert_eq!(error["operation"], "routeIdentity");
        assert!(!tmp.join("detail-token").exists());
        mismatch.as_object_mut().unwrap().remove("host");
        assert_eq!(
            read_with(projects(), &mismatch, script.to_str().unwrap()).unwrap_err()["operation"],
            "routeIdentity"
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
