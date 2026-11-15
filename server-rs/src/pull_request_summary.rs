//! GitHub pull request summary reads.
use crate::github_pinned_credential;
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh")
}
fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
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
        return crate::gitlab_pull_request_read::read(project, input, false);
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
    let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ number title url state isDraft mergeable reviewDecision additions deletions changedFiles updatedAt mergedAt closedAt headRefName baseRefName author {{ login avatarUrl ... on User {{ name }} }} latestReviews(first:20) {{ nodes {{ state isMinimized }} }} commits(last:1) {{ nodes {{ commit {{ statusCheckRollup {{ state }} }} }} }} }} }} }}", json!(owner), json!(name));
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
    let error = || json!({"_tag":"PullRequestOperationError","operation":"summary","detail":"The pull request could not be read."});
    let bytes = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
        .map_err(|failure| {
            github_pinned_credential::operation_error(
                failure,
                "summary",
                "The pull request could not be read.",
            )
        })?;
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
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
    Ok(map(pr, &project.0, repo))
}
fn map(pr: &Value, project_id: &str, repo: &str) -> Value {
    let state = if !pr["mergedAt"].is_null() || pr["state"] == "MERGED" {
        "merged"
    } else if pr["state"] == "CLOSED" {
        "closed"
    } else {
        "open"
    };
    let merge = match pr["mergeable"].as_str() {
        Some("MERGEABLE") => "mergeable",
        Some("CONFLICTING") => "conflicting",
        _ => "unknown",
    };
    let reviews = pr["latestReviews"]["nodes"].as_array();
    let has_review = |s: &str| {
        reviews.is_some_and(|a| {
            a.iter()
                .any(|v| v["isMinimized"] != true && v["state"] == s)
        })
    };
    let review = match pr["reviewDecision"].as_str() {
        Some("APPROVED") => Some("approved"),
        Some("CHANGES_REQUESTED") => Some("changes-requested"),
        _ if has_review("CHANGES_REQUESTED") => Some("changes-requested"),
        Some("REVIEW_REQUIRED") => Some("review-required"),
        _ if has_review("APPROVED") => Some("approved"),
        _ => None,
    };
    let checks = match pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str() {
        Some("SUCCESS") => Some("passing"),
        Some("FAILURE" | "ERROR") => Some("failing"),
        Some("PENDING" | "EXPECTED") => Some("pending"),
        _ => None,
    };
    let trim = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let author = trim(&pr["author"]["login"]).map(|login| json!({"login":login,"name":trim(&pr["author"]["name"]),"avatarUrl":trim(&pr["author"]["avatarUrl"])}));
    json!({"provider":"github","projectId":project_id,"repository":repo,"number":pr["number"],"title":pr["title"],"url":pr["url"],"state":state,"isDraft":pr["isDraft"],"headBranch":pr["headRefName"],"baseBranch":pr["baseRefName"],"closedAt":pr["closedAt"],"mergedAt":pr["mergedAt"],"updatedAt":pr["updatedAt"],"observedAt":chrono::Utc::now().timestamp_millis(),"author":author,"additions":pr["additions"],"deletions":pr["deletions"],"changedFiles":pr["changedFiles"],"reviewDecision":review,"checksState":checks,"mergeability":merge})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_summary() {
        let pr = json!({"number":3,"title":"Fix","url":"https://x","state":"CLOSED","mergedAt":"2026-01-01T00:00:00Z","isDraft":false,"headRefName":"a","baseRefName":"b","updatedAt":"2026-01-01T00:00:00Z","additions":1,"deletions":2,"changedFiles":1,"mergeable":"CONFLICTING","latestReviews":{"nodes":[{"state":"CHANGES_REQUESTED","isMinimized":false}]}});
        let v = map(&pr, "p", "a/b");
        assert_eq!(v["state"], "merged");
        assert_eq!(v["mergeability"], "conflicting");
        assert_eq!(v["reviewDecision"], "changes-requested");
    }
    #[test]
    #[cfg(unix)]
    fn read_classifies_upstream_failures_without_leaking_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-summary-errors-{}", std::process::id()));
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
        let input = json!({"projectId":"p","repository":"owner/repo","number":7});
        for (stderr, tag, reason) in [
            (
                "Bad credentials (HTTP 401) secret-token",
                "PullRequestUnavailableError",
                "cli-unauthenticated",
            ),
            (
                "Not Found (HTTP 404) secret-token",
                "PullRequestOperationError",
                "not-found",
            ),
            (
                "connection refused secret-token",
                "PullRequestOperationError",
                "",
            ),
        ] {
            std::fs::write(
                &script,
                format!("#!/bin/sh\nprintf '%s' '{}' >&2\nexit 1\n", stderr),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            let projects = vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())];
            let error = read_with(projects, &input, script.to_str().unwrap()).unwrap_err();
            assert_eq!(error["_tag"], tag);
            assert_eq!(error["reason"].as_str().unwrap_or(""), reason);
            assert!(!error.to_string().contains("secret-token"));
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn routes_to_matching_checkout_and_uses_its_project_and_repository() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-summary-{}", std::process::id()));
        let a = tmp.join("a");
        let b = tmp.join("b");
        for (root, remote) in [
            (&a, "https://github.com/Other/Repo.git"),
            (&b, "https://github.com/Owner/Repo.git"),
        ] {
            std::fs::create_dir_all(root).unwrap();
            assert!(Command::new("git")
                .args(["init", "-q"])
                .current_dir(root)
                .status()
                .unwrap()
                .success());
            assert!(Command::new("git")
                .args(["remote", "add", "origin", remote])
                .current_dir(root)
                .status()
                .unwrap()
                .success());
        }
        let script = tmp.join("fake-gh");
        std::fs::write(&script, r##"#!/bin/sh
printf '%s' '{"data":{"repository":{"pullRequest":{"number":7,"title":"Fix","url":"https://example.test","state":"OPEN","isDraft":false,"headRefName":"a","baseRefName":"b","updatedAt":"2026-01-01T00:00:00Z","additions":0,"deletions":0,"changedFiles":0,"author":null}}}}'
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![
            ("one".into(), "One".into(), a.to_string_lossy().into_owned()),
            ("two".into(), "Two".into(), b.to_string_lossy().into_owned()),
        ];
        let result = read_with(
            projects,
            &json!({"projectId":"one","repository":"owner/repo","host":"GITHUB.COM","number":7}),
            script.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(result["projectId"], "two");
        assert_eq!(result["repository"], "Owner/Repo");
        assert_eq!(result["author"], Value::Null);
        assert_eq!(result["closedAt"], Value::Null);
        assert_eq!(result["mergedAt"], Value::Null);
        assert_eq!(result["checksState"], Value::Null);
        assert!(result.get("headSha").is_none());
        std::fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn pinned_summary_verifies_account_and_reuses_credential() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-pin-{}", std::process::id()));
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
printf '%s' "$GH_TOKEN" > summary-token
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
            std::fs::read(tmp.join("summary-token")).unwrap()
        );
        std::fs::remove_file(tmp.join("summary-token")).unwrap();
        let mut mismatch = input.clone();
        mismatch["expectedAccountId"] = json!("202");
        let error = read_with(projects(), &mismatch, script.to_str().unwrap()).unwrap_err();
        assert_eq!(error["operation"], "routeIdentity");
        assert!(!tmp.join("summary-token").exists());
        mismatch.as_object_mut().unwrap().remove("host");
        assert_eq!(
            read_with(projects(), &mismatch, script.to_str().unwrap()).unwrap_err()["operation"],
            "routeIdentity"
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
