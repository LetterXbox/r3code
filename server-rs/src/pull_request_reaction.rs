//! Reaction writes for GitHub and GitLab change requests.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

fn names(content: &str) -> Option<(&'static str, &'static str)> {
    Some(match content {
        "thumbs-up" => ("THUMBS_UP", "thumbsup"),
        "thumbs-down" => ("THUMBS_DOWN", "thumbsdown"),
        "laugh" => ("LAUGH", "laughing"),
        "hooray" => ("HOORAY", "tada"),
        "confused" => ("CONFUSED", "confused"),
        "heart" => ("HEART", "heart"),
        "rocket" => ("ROCKET", "rocket"),
        "eyes" => ("EYES", "eyes"),
        _ => return None,
    })
}
pub(crate) fn valid(input: &Value) -> bool {
    crate::pull_request_links::valid(input)
        && input
            .get("subjectId")
            .is_none_or(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
        && input["content"].as_str().and_then(names).is_some()
        && input["reacted"].is_boolean()
}
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn invoke(
    root: &str,
    host: &str,
    github: bool,
    args: &[&str],
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Value, ()> {
    let mut cmd = Command::new(if github { "gh" } else { "glab" });
    cmd.args(args).current_dir(root);
    if !github {
        cmd.env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
    }
    if let Some(credential) = credential {
        credential.apply(&mut cmd);
    }
    let bytes = crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
        .map_err(|_| ())?;
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_slice(&bytes).map_err(|_| ())
    }
}
fn in_scope(v: &Value) -> bool {
    let expected = v["data"]["repository"]["pullRequest"]["id"].as_str();
    let node = &v["data"]["node"];
    let actual = match node["__typename"].as_str() {
        Some("IssueComment") => node["pullRequest"]["id"].as_str(),
        Some("PullRequestReviewComment") => node["reviewCommentPullRequest"]["id"].as_str(),
        Some("PullRequestReview") => node["reviewPullRequest"]["id"].as_str(),
        _ => node["id"].as_str(),
    };
    expected.is_some() && expected == actual
}
pub(crate) fn run(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"setReaction","detail":"The reaction could not be updated."});
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects, input)?;
    let root = detail["workspaceRoot"].as_str().ok_or_else(fail)?;
    let repo = detail["repository"].as_str().ok_or_else(fail)?;
    let identity = crate::repository_identity::resolve(root).ok_or_else(fail)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(fail)?;
    let number = input["number"].as_u64().ok_or_else(fail)?;
    let (gh_name, gl_name) = names(input["content"].as_str().unwrap()).unwrap();
    let reacted = input["reacted"].as_bool().unwrap();
    if detail["provider"] == "github" {
        let (owner, name) = repo.split_once('/').ok_or_else(fail)?;
        let subject = input["subjectId"].as_str().map(str::trim);
        let node = subject.map(|s| format!("node(id:{}) {{ id __typename ... on IssueComment {{ pullRequest {{ id }} }} ... on PullRequestReviewComment {{ reviewCommentPullRequest:pullRequest {{ id }} }} ... on PullRequestReview {{ reviewPullRequest:pullRequest {{ id }} }} }}", json!(s))).unwrap_or_default();
        let query = format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id }} }} {node} }}", json!(owner), json!(name));
        let read = invoke(
            root,
            host,
            true,
            &[
                "api",
                "graphql",
                "--hostname",
                host,
                "-f",
                &format!("query={query}"),
            ],
            credential.as_ref(),
        )
        .map_err(|_| fail())?;
        if read.get("errors").is_some() {
            return Err(fail());
        }
        let id = if let Some(id) = subject {
            if !in_scope(&read) {
                return Err(
                    json!({"_tag":"PullRequestOperationError","operation":"setReaction","detail":"The named subject did not belong to the named pull request."}),
                );
            }
            id
        } else {
            read["data"]["repository"]["pullRequest"]["id"]
                .as_str()
                .ok_or_else(fail)?
        };
        let mutation = if reacted {
            "addReaction"
        } else {
            "removeReaction"
        };
        let query = format!("mutation {{ {mutation}(input:{{subjectId:{},content:{gh_name}}}) {{ clientMutationId }} }}", json!(id));
        let result = invoke(
            root,
            host,
            true,
            &[
                "api",
                "graphql",
                "--hostname",
                host,
                "-f",
                &format!("query={query}"),
            ],
            credential.as_ref(),
        )
        .map_err(|_| fail())?;
        if result.get("errors").is_some() || result["data"].is_null() {
            return Err(fail());
        }
    } else if detail["provider"] == "gitlab" {
        let mut path = format!("projects/{}/merge_requests/{number}", encode(repo));
        if let Some(subject) = input["subjectId"].as_str() {
            path.push_str(&format!("/notes/{}", encode(subject.trim())));
        }
        path.push_str("/award_emoji");
        if reacted {
            invoke(
                root,
                host,
                false,
                &["api", &format!("{path}?name={gl_name}"), "--method", "POST"],
                None,
            )
            .map_err(|_| fail())?;
        } else {
            let viewer = invoke(root, host, false, &["api", "user"], None).map_err(|_| fail())?;
            let username = viewer["username"].as_str().ok_or_else(fail)?;
            let awards = invoke(root, host, false, &["api", &path], None).map_err(|_| fail())?;
            let awards = awards.as_array().ok_or_else(fail)?;
            if let Some(award) = awards.iter().find(|a| {
                a["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(gl_name))
                    && a["user"]["username"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case(username))
            }) {
                let id = award["id"].as_u64().ok_or_else(fail)?;
                invoke(
                    root,
                    host,
                    false,
                    &["api", &format!("{path}/{id}"), "--method", "DELETE"],
                    None,
                )
                .map_err(|_| fail())?;
            }
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
    fn contract_and_scope() {
        let mut v = json!({"projectId":"p","repository":"a/b","number":1,"content":"thumbs-up","reacted":true});
        assert!(valid(&v));
        v["content"] = json!("invalid");
        assert!(!valid(&v));
        let mut r = json!({"data":{"repository":{"pullRequest":{"id":"p"}},"node":{"__typename":"PullRequestReview","reviewPullRequest":{"id":"p"}}}});
        assert!(in_scope(&r));
        r["data"]["node"]["reviewPullRequest"]["id"] = json!("other");
        assert!(!in_scope(&r));
        assert_eq!(encode("a/b"), "a%2Fb");
    }
}
