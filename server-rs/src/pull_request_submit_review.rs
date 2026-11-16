//! Review submissions for change requests.
use serde_json::{json, Value};
use std::{io::Write, process::Command, time::Duration};

fn position_valid(p: &Value) -> bool {
    let positive = |k: &str| p[k].as_u64().is_some_and(|n| n > 0);
    match p["kind"].as_str() {
        Some("added") => positive("newLine"),
        Some("deleted") => positive("oldLine"),
        Some("context") => {
            positive("oldLine")
                && positive("newLine")
                && matches!(p["side"].as_str(), Some("left" | "right"))
        }
        _ => false,
    }
}
pub(crate) fn valid(v: &Value) -> bool {
    crate::pull_request_links::valid(v)
        && matches!(
            v["verdict"].as_str(),
            Some("comment" | "approve" | "request-changes")
        )
        && v["body"]
            .as_str()
            .is_some_and(|s| s.chars().count() <= 65536)
        && v["comments"].as_array().is_some_and(|cs| {
            cs.iter().all(|c| {
                c["path"].as_str().is_some_and(|s| !s.trim().is_empty())
                    && c.get("oldPath")
                        .is_none_or(|p| p.as_str().is_some_and(|s| !s.trim().is_empty()))
                    && position_valid(&c["position"])
                    && c.get("startPosition").is_none_or(position_valid)
                    && c["body"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.chars().count() <= 65536)
            })
        })
}
fn github_position(p: &Value) -> Value {
    let left = p["kind"] == "deleted" || (p["kind"] == "context" && p["side"] == "left");
    json!({"line": if left { &p["oldLine"] } else { &p["newLine"] }, "side":if left {"LEFT"} else {"RIGHT"}})
}
fn github_body(v: &Value) -> Value {
    let comments: Vec<Value> = v["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let end = github_position(&c["position"]);
            let mut result =
                json!({"path":c["path"],"line":end["line"],"side":end["side"],"body":c["body"]});
            if let Some(start) = c
                .get("startPosition")
                .map(github_position)
                .filter(|s| *s != end)
            {
                result["start_line"] = start["line"].clone();
                result["start_side"] = start["side"].clone();
            }
            result
        })
        .collect();
    json!({"event":match v["verdict"].as_str().unwrap() {"approve"=>"APPROVE","request-changes"=>"REQUEST_CHANGES",_=>"COMMENT"},"body":v["body"],"comments":comments})
}
fn post(
    root: &str,
    host: &str,
    provider: &str,
    path: &str,
    body: Option<&Value>,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<(), ()> {
    let file = std::env::temp_dir().join(format!(
        "t3-review-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut cmd = Command::new(if provider == "github" { "gh" } else { "glab" });
    cmd.args(["api", path, "--method", "POST"]);
    if let Some(body) = body {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&file).map_err(|_| ())?;
        if f.write_all(body.to_string().as_bytes()).is_err() {
            let _ = std::fs::remove_file(&file);
            return Err(());
        }
        cmd.arg("--input").arg(&file);
        if provider == "gitlab" {
            cmd.args(["--header", "Content-Type: application/json"]);
        }
    }
    if provider == "github" {
        cmd.args(["--hostname", host]);
    } else {
        cmd.env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
    }
    cmd.current_dir(root);
    if let Some(credential) = credential {
        credential.apply(&mut cmd);
    }
    let result = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
        .map(|_| ())
        .map_err(|_| ());
    let _ = std::fs::remove_file(file);
    result
}
fn gitlab_get(root: &str, host: &str, path: &str) -> Result<Value, ()> {
    let mut cmd = Command::new("glab");
    cmd.args(["api", path])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let raw = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
        .map_err(|_| ())?;
    serde_json::from_slice(&raw).map_err(|_| ())
}
fn gitlab_lines(p: &Value) -> Value {
    match p["kind"].as_str() {
        Some("added") => json!({"new_line":p["newLine"]}),
        Some("deleted") => json!({"old_line":p["oldLine"]}),
        _ => json!({"old_line":p["oldLine"],"new_line":p["newLine"]}),
    }
}
fn gitlab_graphql(root: &str, host: &str, query: &str, variables: Value) -> Result<(), ()> {
    let body = json!({"query":query,"variables":variables});
    // Use a private temporary file, as with REST posts, and inspect GraphQL errors.
    let file = std::env::temp_dir().join(format!(
        "t3-review-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&file).map_err(|_| ())?;
    if f.write_all(body.to_string().as_bytes()).is_err() {
        let _ = std::fs::remove_file(&file);
        return Err(());
    }
    drop(f);
    let mut cmd = Command::new("glab");
    cmd.args(["api", "graphql", "--method", "POST", "--input"])
        .arg(&file)
        .args(["--header", "Content-Type: application/json"])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let raw = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30));
    let _ = std::fs::remove_file(file);
    let result: Value = serde_json::from_slice(&raw.map_err(|_| ())?).map_err(|_| ())?;
    if result
        .get("errors")
        .is_some_and(|e| !e.as_array().is_some_and(|a| a.is_empty()))
    {
        return Err(());
    }
    let Some(data) = result["data"].as_object() else {
        return Err(());
    };
    if data.is_empty()
        || data
            .values()
            .any(|x| !x["errors"].as_array().is_some_and(|a| a.is_empty()))
    {
        return Err(());
    }
    Ok(())
}
pub(crate) fn run(projects: Vec<(String, String, String)>, v: &Value) -> Result<Value, Value> {
    let fail = |detail: &str| json!({"_tag":"PullRequestOperationError","operation":"submitReview","detail":detail});
    let verdict = v["verdict"].as_str().unwrap();
    let comments = v["comments"].as_array().unwrap();
    if verdict != "approve" && v["body"].as_str().unwrap().trim().is_empty() && comments.is_empty()
    {
        return Err(fail("A review needs a summary or at least one comment."));
    }
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects, v)?;
    let label = match verdict {
        "approve" => "approve",
        "request-changes" => "request changes on",
        _ => "review",
    };
    if !detail["capabilities"]["review"]["verdicts"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x == verdict))
    {
        return Err(fail(&format!("This host cannot {label} a change request.")));
    }
    if !comments.is_empty() && detail["capabilities"]["review"]["inlineComment"] != true {
        return Err(fail(
            "This host cannot comment on a line of a change request.",
        ));
    }
    if !detail["viewerPermissions"]["verdicts"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x == verdict))
    {
        return Err(fail(&format!(
            "You need write access on this repository to {label} a change request."
        )));
    }
    if !comments.is_empty() && detail["viewerPermissions"]["comment"] != true {
        return Err(fail(
            "You need write access on this repository to comment on a line of a change request.",
        ));
    }
    let error = || fail("The review could not be submitted.");
    let root = detail["workspaceRoot"].as_str().ok_or_else(error)?;
    let repo = detail["repository"].as_str().ok_or_else(error)?;
    let identity = crate::repository_identity::resolve(root).ok_or_else(error)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(error)?;
    let number = v["number"].as_u64().unwrap();
    if detail["provider"] == "github" {
        post(
            root,
            host,
            "github",
            &format!("repos/{repo}/pulls/{number}/reviews"),
            Some(&github_body(v)),
            credential.as_ref(),
        )
        .map_err(|_| error())?;
    } else if detail["provider"] == "gitlab" {
        let encoded = repo
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>();
        let path = format!("projects/{encoded}/merge_requests/{number}");
        if verdict == "request-changes" {
            let viewer = gitlab_get(root, host, "user").map_err(|_| error())?;
            let username = viewer["username"]
                .as_str()
                .filter(|x| !x.is_empty())
                .ok_or_else(error)?;
            let target =
                json!({"projectPath":repo,"iid":number.to_string(),"reviewers":[username]});
            gitlab_graphql(root,host,"mutation($projectPath: ID!, $iid: String!, $reviewers: [String!]!) { mergeRequestSetReviewers(input: { projectPath: $projectPath, iid: $iid, reviewerUsernames: $reviewers, operationMode: APPEND }) { errors } }",target).map_err(|_| error())?;
            gitlab_graphql(root,host,"mutation($projectPath: ID!, $iid: String!) { mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors } }",json!({"projectPath":repo,"iid":number.to_string()})).map_err(|_| error())?;
        }
        if !comments.is_empty() {
            let mr = gitlab_get(root, host, &path).map_err(|_| error())?;
            let refs = &mr["diff_refs"];
            if ["base_sha", "head_sha", "start_sha"]
                .iter()
                .any(|k| refs[*k].as_str().is_none_or(|s| s.is_empty()))
            {
                return Err(error());
            }
            for comment in comments {
                let mut position = json!({"base_sha":refs["base_sha"],"head_sha":refs["head_sha"],"start_sha":refs["start_sha"],"position_type":"text","old_path":comment.get("oldPath").unwrap_or(&comment["path"]),"new_path":comment["path"]});
                for (k, val) in gitlab_lines(&comment["position"]).as_object().unwrap() {
                    position[k] = val.clone();
                }
                post(
                    root,
                    host,
                    "gitlab",
                    &format!("{path}/discussions"),
                    Some(&json!({"body":comment["body"],"position":position})),
                    credential.as_ref(),
                )
                .map_err(|_| error())?;
            }
        }
        if !v["body"].as_str().unwrap().trim().is_empty() {
            post(
                root,
                host,
                "gitlab",
                &format!("{path}/notes"),
                Some(&json!({"body":v["body"]})),
                credential.as_ref(),
            )
            .map_err(|_| error())?;
        }
        if verdict == "approve" {
            post(
                root,
                host,
                "gitlab",
                &format!("{path}/approve"),
                None,
                credential.as_ref(),
            )
            .map_err(|_| error())?;
        }
    } else {
        return Err(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}));
    }
    Ok(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapping() {
        let v = json!({"projectId":"p","repository":"a/b","number":1,"verdict":"comment","body":"hi","comments":[{"path":"x","position":{"kind":"context","oldLine":3,"newLine":4,"side":"left"},"startPosition":{"kind":"added","newLine":2},"body":"ok"}]});
        assert!(valid(&v));
        assert_eq!(
            github_body(&v),
            json!({"event":"COMMENT","body":"hi","comments":[{"path":"x","line":3,"side":"LEFT","start_line":2,"start_side":"RIGHT","body":"ok"}]})
        );
    }
}
