//! Review conversation mutations for GitHub and GitLab.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value, resolution: bool) -> bool {
    crate::pull_request_links::valid(input)
        && input["threadId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && if resolution {
            input["resolved"].is_boolean()
        } else {
            input["body"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.chars().count() <= 65_536)
        }
}

pub(crate) fn run(
    projects: Vec<(String, String, String)>,
    input: &Value,
    resolution: bool,
) -> Result<Value, Value> {
    let op = if resolution {
        "setThreadResolution"
    } else {
        "replyToThread"
    };
    let fail =
        |detail: &str| json!({"_tag":"PullRequestOperationError","operation":op,"detail":detail});
    if !resolution && input["body"].as_str().unwrap().trim().is_empty() {
        return Err(fail("A reply cannot be empty."));
    }
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects, input)?;
    let permission = if resolution { "resolve" } else { "comment" };
    if detail["viewerPermissions"][permission] != true {
        return Err(fail(if resolution {
            "You need write access on this repository, or to have opened this change request, to resolve a review conversation."
        } else {
            "You need write access on this repository to reply to a review conversation."
        }));
    }
    let error = || {
        fail(if resolution {
            "The review conversation could not be updated."
        } else {
            "The reply could not be added."
        })
    };
    let root = detail["workspaceRoot"].as_str().ok_or_else(error)?;
    let repo = detail["repository"].as_str().ok_or_else(error)?;
    let identity = crate::repository_identity::resolve(root).ok_or_else(error)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(error)?;
    let thread = input["threadId"].as_str().unwrap().trim();
    if detail["provider"] == "github" {
        let query = if resolution {
            let mutation = if input["resolved"] == true {
                "resolveReviewThread"
            } else {
                "unresolveReviewThread"
            };
            format!(
                "mutation {{ {mutation}(input:{{threadId:{}}}) {{ thread {{ isResolved }} }} }}",
                json!(thread)
            )
        } else {
            format!("mutation {{ addPullRequestReviewThreadReply(input:{{pullRequestReviewThreadId:{},body:{}}}) {{ comment {{ id }} }} }}", json!(thread), json!(input["body"]))
        };
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
        if let Some(credential) = credential.as_ref() {
            credential.apply(&mut cmd);
        }
        let raw =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
                .map_err(|_| error())?;
        let result: Value = serde_json::from_slice(&raw).map_err(|_| error())?;
        if result.get("errors").is_some() || result["data"].is_null() {
            return Err(error());
        }
    } else if detail["provider"] == "gitlab" {
        let encode = |s: &str| {
            s.bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>()
        };
        let path = format!(
            "projects/{}/merge_requests/{}/discussions/{}{}",
            encode(repo),
            input["number"].as_u64().unwrap(),
            encode(thread),
            if resolution { "" } else { "/notes" }
        );
        let file_path = std::env::temp_dir().join(format!(
            "t3-thread-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&file_path).map_err(|_| error())?;
        let payload = if resolution {
            json!({"resolved":input["resolved"]})
        } else {
            json!({"body":input["body"]})
        };
        if file.write_all(payload.to_string().as_bytes()).is_err() {
            let _ = std::fs::remove_file(&file_path);
            return Err(error());
        }
        drop(file);
        let mut cmd = Command::new("glab");
        cmd.args([
            "api",
            &path,
            "--method",
            if resolution { "PUT" } else { "POST" },
            "--input",
        ])
        .arg(&file_path)
        .args(["--header", "Content-Type: application/json"])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
        let result =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30));
        let _ = std::fs::remove_file(file_path);
        result.map_err(|_| error())?;
    } else {
        return Err(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}));
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contract_validation() {
        let mut input = json!({"projectId":"p","repository":"a/b","number":1,"threadId":"thread","body":"hello"});
        assert!(valid(&input, false));
        assert!(!valid(&input, true));
        input["resolved"] = json!(false);
        assert!(valid(&input, true));
        input["threadId"] = json!("  ");
        assert!(!valid(&input, true));
        input["threadId"] = json!("id");
        input["body"] = json!("");
        assert!(!valid(&input, false));
    }
}
