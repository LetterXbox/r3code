//! Lightweight pull request preview reads.
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
                rejected()
            } else if host.is_none() && selected.is_some_and(|p| p.3.is_some()) {
                mismatch()
            } else {
                unsupported()
            }
        })?;
    let identity = project.3.as_ref().unwrap();
    if identity["provider"] == "gitlab" {
        return gitlab_preview(project, input, "glab");
    }
    if identity["provider"] != "github" {
        return Err(if input.get("expectedAccountId").is_some() {
            rejected()
        } else {
            unsupported()
        });
    }
    let host = identity["canonicalKey"]
        .as_str()
        .unwrap()
        .split('/')
        .next()
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
    let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ number title url state isDraft createdAt author {{ login avatarUrl ... on User {{ name }} }} }} }} }}",json!(owner),json!(name));
    let mut command = Command::new(exe);
    command.current_dir(&project.2).args([
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        &format!("query={query}"),
    ]);
    if let Some(credential) = credential {
        credential.apply(&mut command)
    }
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"preview","detail":"The pull request could not be read."});
    let bytes = github_pinned_credential::run_classified(&mut command, Duration::from_secs(10))
        .map_err(|e| {
            github_pinned_credential::operation_error(
                e,
                "preview",
                "The pull request could not be read.",
            )
        })?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let pr = &data["data"]["repository"]["pullRequest"];
    if ["title", "url", "createdAt"]
        .iter()
        .any(|k| pr[*k].as_str().is_none_or(|s| s.trim().is_empty()))
        || pr["number"].as_u64().is_none_or(|n| n == 0)
        || !pr["isDraft"].is_boolean()
        || !matches!(pr["state"].as_str(), Some("OPEN" | "CLOSED" | "MERGED"))
    {
        return Err(fail());
    }
    let clean = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let author = clean(&pr["author"]["login"]).map(|login|json!({"login":login,"name":clean(&pr["author"]["name"]),"avatarUrl":clean(&pr["author"]["avatarUrl"])}));
    Ok(
        json!({"projectId":project.0,"repository":repo,"number":pr["number"],"title":pr["title"],"url":pr["url"],"state":pr["state"].as_str().unwrap().to_lowercase(),"isDraft":pr["isDraft"],"createdAt":pr["createdAt"],"author":author}),
    )
}

fn gitlab_preview(
    project: &(String, String, String, Option<Value>),
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let rejected = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."});
    if input.get("expectedAccountId").is_some() {
        return Err(rejected());
    }
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"preview","detail":"The pull request could not be read."});
    let identity = project.3.as_ref().ok_or_else(fail)?;
    let repo = identity["displayName"].as_str().ok_or_else(fail)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|key| key.split_once('/'))
        .map(|v| v.0)
        .ok_or_else(fail)?;
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
    let mut command = Command::new(exe);
    command
        .args(["api", &path])
        .current_dir(&project.2)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let mut exit_code = None;
    let bytes = github_pinned_credential::run_classified_with_status(
        &mut command,
        Duration::from_secs(10),
        &mut exit_code,
    )
    .map_err(|e| {
        crate::gitlab_pull_request_read::read_failure(e, "preview", &project.2, exit_code)
    })?;
    let mr: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    if mr["iid"].as_u64().is_none_or(|n| n == 0)
        || ["title", "web_url", "state", "created_at"]
            .iter()
            .any(|k| mr[*k].as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err(fail());
    }
    let clean = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let author = clean(&mr["author"]["username"]).map(|login|json!({"login":login,"name":clean(&mr["author"]["name"]),"avatarUrl":clean(&mr["author"]["avatar_url"])}));
    let state = match mr["state"].as_str() {
        Some("merged") => "merged",
        Some("closed") => "closed",
        _ => "open",
    };
    Ok(
        json!({"projectId":project.0,"repository":repo,"number":mr["iid"],"title":mr["title"],"url":mr["web_url"],"author":author,"state":state,"isDraft":mr["draft"].as_bool().or_else(||mr["work_in_progress"].as_bool()).unwrap_or(false),"createdAt":mr["created_at"]}),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn reads_a_lightweight_preview() {
        let root = std::env::temp_dir().join(format!("t3-preview-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
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
                "https://github.com/Owner/Repo.git"
            ])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        let gh = root.join("gh");
        std::fs::write(&gh, "#!/bin/sh\nprintf '%s' '{\"data\":{\"repository\":{\"pullRequest\":{\"number\":7,\"title\":\"Fix\",\"url\":\"https://example.invalid/7\",\"state\":\"OPEN\",\"isDraft\":false,\"createdAt\":\"2025-01-01T00:00:00Z\",\"author\":{\"login\":\"alice\",\"name\":null,\"avatarUrl\":null}}}}}'\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![(
            "p".into(),
            "project".into(),
            root.to_string_lossy().into_owned(),
        )];
        let result = read_with(
            projects,
            &json!({"projectId":"p","repository":"owner/repo","number":7}),
            gh.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"projectId":"p","repository":"Owner/Repo","number":7,"title":"Fix","url":"https://example.invalid/7","state":"open","isDraft":false,"createdAt":"2025-01-01T00:00:00Z","author":{"login":"alice","name":null,"avatarUrl":null}})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gitlab_preview_does_not_require_detail_enrichment() {
        let root = std::env::temp_dir().join(format!("t3-gitlab-preview-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let glab = root.join("glab");
        std::fs::write(&glab, "#!/bin/sh\ncase \"$*\" in *graphql*|*license=false*) exit 1 ;; esac\nprintf '%s' '{\"iid\":7,\"title\":\"Fix\",\"web_url\":\"https://gitlab.com/o/r/-/merge_requests/7\",\"state\":\"opened\",\"created_at\":\"2025-01-01T00:00:00Z\",\"author\":{\"username\":\"bob\"}}'\n").unwrap();
        std::fs::set_permissions(&glab, std::fs::Permissions::from_mode(0o755)).unwrap();
        let project = (
            "p".into(),
            "Project".into(),
            root.to_string_lossy().into_owned(),
            Some(json!({"canonicalKey":"gitlab.com/o/r","displayName":"O/R","provider":"gitlab"})),
        );
        let result = gitlab_preview(
            &project,
            &json!({"projectId":"p","repository":"O/R","number":7}),
            glab.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(result["number"], 7);
        assert_eq!(result["author"]["login"], "bob");
        assert_eq!(result["isDraft"], false);
        assert_eq!(
            gitlab_preview(
                &project,
                &json!({"number":7,"expectedAccountId":"123"}),
                glab.to_str().unwrap()
            )
            .unwrap_err()["operation"],
            "routeIdentity"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
