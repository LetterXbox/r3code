//! Read the two sides of a changed pull request file, after checking membership.
use crate::github_pinned_credential;
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh", "glab")
}

fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    gh: &str,
    glab: &str,
) -> Result<Value, Value> {
    let rejected = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."});
    let unavailable =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"diffFileContents","detail":"The pull request file contents could not be read."});
    let mismatch = || json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."});
    let resolved: Vec<_> = projects
        .into_iter()
        .map(|(id, title, root)| {
            let identity = crate::repository_identity::resolve(&root);
            (id, title, root, identity)
        })
        .collect();
    let requested = input["projectId"].as_str().ok_or_else(fail)?;
    let repo = input["repository"].as_str().ok_or_else(fail)?.trim();
    let host_input = input.get("host").and_then(Value::as_str).map(str::trim);
    let matches = |p: &&(String, String, String, Option<Value>)| {
        p.3.as_ref()
            .and_then(|v| v["canonicalKey"].as_str())
            .and_then(|s| s.split_once('/'))
            .is_some_and(|(h, r)| {
                r.eq_ignore_ascii_case(repo) && host_input.is_none_or(|x| x.eq_ignore_ascii_case(h))
            })
    };
    let selected = resolved.iter().find(|p| p.0 == requested);
    let project = selected
        .filter(matches)
        .or_else(|| host_input.and_then(|_| resolved.iter().find(matches)))
        .ok_or_else(|| {
            if input.get("expectedAccountId").is_some() {
                rejected()
            } else if host_input.is_none() && selected.is_some_and(|p| p.3.is_some()) {
                mismatch()
            } else {
                unavailable()
            }
        })?;
    let identity = project.3.as_ref().ok_or_else(unavailable)?;
    let provider = identity["provider"].as_str().ok_or_else(unavailable)?;
    if provider != "github" && provider != "gitlab" {
        return Err(unavailable());
    }
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(unavailable)?;
    let repo = identity["displayName"].as_str().ok_or_else(unavailable)?;
    let number = input["number"].as_u64().ok_or_else(fail)?;
    let change = input["changeType"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "change" | "rename-pure" | "rename-changed" | "new" | "deleted"
            )
        })
        .ok_or_else(fail)?;
    let old = input["oldPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(fail)?;
    let new = input["newPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(fail)?;
    let commit = input.get("commit").and_then(Value::as_str);
    if commit.is_some_and(|s| !sha(s)) {
        return Err(fail());
    }
    let credential = if let Some(expected) = input.get("expectedAccountId").and_then(Value::as_str)
    {
        if provider != "github" || !host_input.is_some_and(|h| h.eq_ignore_ascii_case(host)) {
            return Err(rejected());
        }
        Some(
            github_pinned_credential::capture(gh, &project.2, host, expected)
                .ok_or_else(rejected)?,
        )
    } else {
        None
    };
    let run = |path: &str, raw: bool, limit: usize| -> Result<Vec<u8>, Value> {
        let mut cmd = Command::new(if provider == "github" { gh } else { glab });
        if provider == "github" {
            cmd.args(["api", "--hostname", host]);
            if raw {
                cmd.args(["-H", "Accept: application/vnd.github.raw+json"]);
            }
            cmd.arg(path);
            if let Some(c) = &credential {
                c.apply(&mut cmd);
            }
        } else {
            cmd.args(["api", path])
                .env("GITLAB_HOST", host)
                .env("GLAB_PROMPT_DISABLED", "1");
        }
        cmd.current_dir(&project.2);
        github_pinned_credential::run_classified_bounded(&mut cmd, Duration::from_secs(60), limit)
            .map_err(|e| {
                let mut error = github_pinned_credential::operation_error(
                    e,
                    "diffFileContents",
                    "The pull request file contents could not be read.",
                );
                if provider == "gitlab" && error.get("provider").is_some() {
                    error["provider"] = json!("gitlab");
                }
                error
            })
    };
    let prefix = if provider == "github" {
        format!("repos/{repo}")
    } else {
        format!("projects/{}", encode(repo, false))
    };
    // Check the complete changed-file list before using the project credential to read content.
    let mut found = false;
    for page in 1..=10000 {
        let (path, size) = if provider == "github" {
            (
                match commit {
                    Some(c) => format!("{prefix}/commits/{c}?per_page=100&page={page}"),
                    None => format!("{prefix}/pulls/{number}/files?per_page=100&page={page}"),
                },
                100,
            )
        } else {
            (
                match commit {
                    Some(c) => {
                        format!("{prefix}/repository/commits/{c}/diff?per_page=100&page={page}")
                    }
                    None => {
                        format!("{prefix}/merge_requests/{number}/diffs?per_page=30&page={page}")
                    }
                },
                if commit.is_some() { 100 } else { 30 },
            )
        };
        let (bytes, legacy) = match run(&path, false, 8 * 1024 * 1024) {
            Ok(bytes) => (bytes, false),
            Err(error)
                if provider == "gitlab"
                    && commit.is_none()
                    && page == 1
                    && error["reason"] == "not-found" =>
            {
                (
                    run(
                        &format!("{prefix}/merge_requests/{number}/changes?access_raw_diffs=true"),
                        false,
                        8 * 1024 * 1024,
                    )
                    .map_err(gitlab_diff_error)?,
                    true,
                )
            }
            Err(error) if provider == "gitlab" => return Err(gitlab_diff_error(error)),
            Err(error) => return Err(error),
        };
        let response: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        let files = if legacy {
            response["changes"].as_array()
        } else if provider == "github" && commit.is_some() {
            response["files"].as_array()
        } else {
            response.as_array()
        }
        .ok_or_else(fail)?;
        found = files.iter().any(|f| {
            let (a, b) = if provider == "github" {
                let b = f["filename"].as_str().unwrap_or("");
                (f["previous_filename"].as_str().unwrap_or(b), b)
            } else {
                (
                    f["old_path"].as_str().unwrap_or(""),
                    f["new_path"].as_str().unwrap_or(""),
                )
            };
            a == old && b == new
        });
        if found || legacy || files.len() < size {
            break;
        }
    }
    if !found {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"diffFileContents","detail":"This file is not part of the change request.","reason":"not-found"}),
        );
    }
    let refs_path = if provider == "github" {
        match commit {
            Some(c) => format!("{prefix}/commits/{c}"),
            None => format!("{prefix}/pulls/{number}"),
        }
    } else {
        match commit {
            Some(c) => format!("{prefix}/repository/commits/{c}"),
            None => format!("{prefix}/merge_requests/{number}"),
        }
    };
    let refs: Value =
        serde_json::from_slice(&run(&refs_path, false, 8 * 1024 * 1024)?).map_err(|_| fail())?;
    let (base, head) = if provider == "github" {
        if commit.is_some() {
            (
                refs["parents"][0]["sha"].as_str().unwrap_or(""),
                refs["sha"].as_str().unwrap_or(""),
            )
        } else {
            (
                refs["base"]["sha"].as_str().unwrap_or(""),
                refs["head"]["sha"].as_str().unwrap_or(""),
            )
        }
    } else if commit.is_some() {
        (
            refs["parent_ids"][0].as_str().unwrap_or(""),
            refs["id"].as_str().unwrap_or(""),
        )
    } else {
        (
            refs["diff_refs"]["base_sha"].as_str().unwrap_or(""),
            refs["diff_refs"]["head_sha"].as_str().unwrap_or(""),
        )
    };
    if !(sha(head) && (sha(base) || change == "new" && base.is_empty())) {
        return Err(fail());
    }
    let old_ref = if provider == "github" && commit.is_none() && change != "new" {
        run(
            &format!("{prefix}/compare/{base}...{head}?per_page=1&page=2"),
            false,
            8 * 1024 * 1024,
        )
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| {
            v["merge_base_commit"]["sha"]
                .as_str()
                .filter(|s| sha(s))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| base.to_owned())
    } else {
        base.to_owned()
    };
    let read_file = |revision: &str, path: &str| -> Result<String, Value> {
        let endpoint = if provider == "github" {
            format!(
                "{prefix}/contents/{}?ref={}",
                encode(path, true),
                encode(revision, false)
            )
        } else {
            format!(
                "{prefix}/repository/files/{}/raw?ref={}",
                encode(path, false),
                encode(revision, false)
            )
        };
        let bytes = run(&endpoint, true, 1024 * 1024).map_err(|mut error| {
            if error["reason"] == "not-found" {
                if provider == "gitlab" {
                    error.as_object_mut().unwrap().remove("reason");
                    error["detail"] = json!("GitLab CLI command failed.");
                } else {
                    error["detail"] = json!("GitHub could not find the requested resource, or the credential cannot see it.");
                }
            }
            error
        })?;
        if bytes.contains(&0) {
            return Err(
                json!({"_tag":"PullRequestOperationError","operation":"diffFileContents","detail":format!("The diff file '{path}' is binary.")}),
            );
        }
        String::from_utf8(bytes).map_err(|_| json!({"_tag":"PullRequestOperationError","operation":"diffFileContents","detail":format!("The diff file '{path}' is binary.")}))
    };
    Ok(
        json!({"oldContents":if change == "new" {String::new()} else {read_file(&old_ref,old)?},"newContents":if change == "deleted" {String::new()} else {read_file(head,new)?}}),
    )
}

fn gitlab_diff_error(mut error: Value) -> Value {
    if error["_tag"] == "PullRequestOperationError" {
        error["operation"] = json!("diff");
        if error["detail"] == "The pull request file contents could not be read." {
            error["detail"] = json!("GitLab CLI command failed.");
            if let Some(object) = error.as_object_mut() {
                object.remove("reason");
            }
        }
    }
    error
}
fn sha(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn encode(s: &str, slash: bool) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) || (slash && b == b'/') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn checks_membership_before_reading_github_contents() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-contents-{}", std::process::id()));
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
        let script = tmp.join("gh");
        std::fs::write(
            &script,
            r##"#!/bin/sh
case "$*" in
 *pulls/7/files*) printf '%s' '[{"filename":"new","previous_filename":"old"}]' ;;
 *pulls/7*) printf '%s' '{"base":{"sha":"aaaaaaa"},"head":{"sha":"bbbbbbb"}}' ;;
 *compare*) printf '%s' '{"merge_base_commit":{"sha":"ccccccc"}}' ;;
 *contents/old*) printf 'old contents' ;;
 *contents/new*) printf 'new contents' ;;
 *) exit 1 ;;
esac
"##,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = || vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())];
        let mut input = json!({"projectId":"p","repository":"owner/repo","number":7,"changeType":"rename-changed","oldPath":"old","newPath":"new"});
        let result = read_with(projects(), &input, script.to_str().unwrap(), "glab").unwrap();
        assert_eq!(
            result,
            json!({"oldContents":"old contents","newContents":"new contents"})
        );
        input["newPath"] = json!("secret");
        assert_eq!(
            read_with(projects(), &input, script.to_str().unwrap(), "glab").unwrap_err()["reason"],
            "not-found"
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn falls_back_to_legacy_gitlab_changes_for_membership() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-legacy-{}", uuid::Uuid::new_v4()));
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
                "https://gitlab.com/Owner/Repo.git"
            ])
            .current_dir(&tmp)
            .status()
            .unwrap()
            .success());
        let script = tmp.join("glab");
        std::fs::write(
            &script,
            r##"#!/bin/sh
case "$*" in
 *'/diffs?'*) printf '%s\n' 'HTTP 404 Not Found' >&2; exit 1 ;;
 *'/changes?'*) printf '%s' '{"changes":[{"old_path":"file","new_path":"file"}]}' ;;
 *'/repository/files/'*) printf 'contents' ;;
 *'/merge_requests/7'*) printf '%s' '{"diff_refs":{"base_sha":"aaaaaaa","head_sha":"bbbbbbb"}}' ;;
 *) exit 1 ;;
esac
"##,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())];
        let input = json!({"projectId":"p","repository":"Owner/Repo","number":7,"changeType":"change","oldPath":"file","newPath":"file"});
        assert_eq!(
            read_with(projects, &input, "gh", script.to_str().unwrap()).unwrap(),
            json!({"oldContents":"contents","newContents":"contents"})
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
