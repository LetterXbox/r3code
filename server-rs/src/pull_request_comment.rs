//! Comment mutations for GitHub and GitLab change requests.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value, update: bool) -> bool {
    crate::pull_request_links::valid(input)
        && input["body"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.chars().count() <= 65_536)
        && (!update
            || (input["commentId"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && matches!(
                    input["kind"].as_str(),
                    Some("issue-comment" | "review-comment")
                )))
}

pub(crate) fn run(
    projects: Vec<(String, String, String)>,
    input: &Value,
    update: bool,
) -> Result<Value, Value> {
    let op = if update { "updateComment" } else { "comment" };
    let fail =
        |detail: &str| json!({"_tag":"PullRequestOperationError","operation":op,"detail":detail});
    let body = input["body"].as_str().unwrap();
    if body.trim().is_empty() {
        return Err(fail("A comment cannot be empty."));
    }
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects.clone(), input)?;
    if !update && detail["viewerPermissions"]["comment"] != true {
        return Err(fail(
            "You need write access on this repository to comment on a change request.",
        ));
    }
    let root = detail["workspaceRoot"]
        .as_str()
        .ok_or_else(|| fail("The comment could not be updated."))?;
    let repo = detail["repository"]
        .as_str()
        .ok_or_else(|| fail("The comment could not be updated."))?;
    let identity = crate::repository_identity::resolve(root)
        .ok_or_else(|| fail("The comment could not be updated."))?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(|| fail("The comment could not be updated."))?;
    let number = input["number"].as_u64().unwrap();
    let error = || fail("The comment could not be updated.");
    if detail["provider"] == "github" {
        let (owner, name) = repo.split_once('/').ok_or_else(error)?;
        let id = if update {
            let id = input["commentId"].as_str().unwrap().trim();
            let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id }} }} node(id:{}) {{ __typename ... on IssueComment {{ pullRequest {{ id }} }} ... on PullRequestReviewComment {{ pullRequest {{ id }} }} }} }}", json!(owner), json!(name), json!(id));
            let data = github(root, host, &query, credential.as_ref()).map_err(|_| error())?;
            if !github_comment_in_scope(&data, input["kind"].as_str().unwrap()) {
                return Err(fail(
                    "The named subject did not belong to the named pull request.",
                ));
            }
            id.to_owned()
        } else {
            let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id }} }} }}", json!(owner), json!(name));
            github(root, host, &query, credential.as_ref()).map_err(|_| error())?["data"]
                ["repository"]["pullRequest"]["id"]
                .as_str()
                .ok_or_else(error)?
                .to_owned()
        };
        let query = if update {
            let mutation = if input["kind"] == "issue-comment" {
                "updateIssueComment"
            } else {
                "updatePullRequestReviewComment"
            };
            format!(
                "mutation {{ {mutation}(input:{{{}:{},body:{}}}) {{ clientMutationId }} }}",
                if mutation == "updateIssueComment" {
                    "id"
                } else {
                    "pullRequestReviewCommentId"
                },
                json!(id),
                json!(body)
            )
        } else {
            format!(
                "mutation {{ addComment(input:{{subjectId:{},body:{}}}) {{ clientMutationId }} }}",
                json!(id),
                json!(body)
            )
        };
        let result = github(root, host, &query, credential.as_ref()).map_err(|_| error())?;
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
        let mut path = format!("projects/{}/merge_requests/{number}/notes", encode(repo));
        if update {
            path.push('/');
            path.push_str(&encode(input["commentId"].as_str().unwrap().trim()));
        }
        // Use an input file so strings such as "true" and "123" stay JSON strings.
        let path_file = std::env::temp_dir().join(format!(
            "t3-comment-{}-{}",
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
        let mut file = options.open(&path_file).map_err(|_| error())?;
        if file
            .write_all(json!({"body":body}).to_string().as_bytes())
            .is_err()
        {
            let _ = std::fs::remove_file(&path_file);
            return Err(error());
        }
        drop(file);
        let mut cmd = Command::new("glab");
        cmd.args([
            "api",
            &path,
            "--method",
            if update { "PUT" } else { "POST" },
            "--input",
        ])
        .arg(&path_file)
        .args(["--header", "Content-Type: application/json"])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
        let result =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30));
        let _ = std::fs::remove_file(path_file);
        result.map_err(|_| error())?;
    } else {
        return Err(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}));
    }
    Ok(Value::Null)
}
fn github_comment_in_scope(data: &Value, kind: &str) -> bool {
    let expected = data["data"]["repository"]["pullRequest"]["id"].as_str();
    let node = &data["data"]["node"];
    let typename = if kind == "issue-comment" {
        "IssueComment"
    } else {
        "PullRequestReviewComment"
    };
    expected.is_some()
        && node["__typename"] == typename
        && node["pullRequest"]["id"].as_str() == expected
}
fn github(
    root: &str,
    host: &str,
    query: &str,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Value, ()> {
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
    if let Some(credential) = credential {
        credential.apply(&mut cmd);
    }
    let raw = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
        .map_err(|_| ())?;
    serde_json::from_slice(&raw).map_err(|_| ())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_edit_rejects_wrong_pull_request_and_comment_kind() {
        let mut response = json!({"data":{"repository":{"pullRequest":{"id":"PR_7"}},"node":{"__typename":"IssueComment","pullRequest":{"id":"PR_7"}}}});
        assert!(github_comment_in_scope(&response, "issue-comment"));
        assert!(!github_comment_in_scope(&response, "review-comment"));
        response["data"]["node"]["pullRequest"]["id"] = json!("PR_8");
        assert!(!github_comment_in_scope(&response, "issue-comment"));
        response["data"]["repository"]["pullRequest"]["id"] = Value::Null;
        assert!(!github_comment_in_scope(&response, "issue-comment"));
    }
    #[test]
    fn validates_contract_and_preserves_markdown() {
        let mut v = json!({"projectId":"p","repository":"a/b","number":1,"body":"  x\n"});
        assert!(valid(&v, false));
        assert!(!valid(&v, true));
        v["commentId"] = json!("id");
        v["kind"] = json!("review-comment");
        assert!(valid(&v, true));
        v["body"] = json!("");
        assert!(!valid(&v, true));
    }
}
