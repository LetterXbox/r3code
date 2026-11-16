//! Read one page of review-thread comments from GitHub.
use crate::{
    github_pinned_credential,
    pull_request_activity::{actor, reactions},
};
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
        if input.get("expectedAccountId").is_some() {
            return Err(rejected());
        }
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"threadComments","detail":"This host does not page review thread comments."}),
        );
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
    let query = format!("query {{ viewer {{ login }} repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id }} }} node(id:{}) {{ ... on PullRequestReviewThread {{ pullRequest {{ id }} comments(first:100,after:{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ id body createdAt lastEditedAt url isMinimized author {{ login avatarUrl }} pullRequestReview {{ url }} reactionGroups {{ content viewerHasReacted reactors(first:10) {{ totalCount nodes {{ ... on User {{ login }} ... on Bot {{ login }} ... on Organization {{ login }} ... on Mannequin {{ login }} }} }} }} }} }} }} }} }}", json!(owner), json!(name), json!(input["threadId"].as_str().unwrap().trim()), json!(input["cursor"].as_str().unwrap().trim()));
    let mut cmd = Command::new(exe);
    cmd.args([
        "api",
        "graphql",
        "--hostname",
        host,
        "-f",
        &format!("query={query}"),
    ])
    .current_dir(&project.2);
    if let Some(c) = &credential {
        c.apply(&mut cmd);
    }
    let error = || json!({"_tag":"PullRequestOperationError","operation":"threadComments","detail":"The pull request thread comments could not be read."});
    let bytes = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
        .map_err(|e| {
            github_pinned_credential::operation_error(
                e,
                "threadComments",
                "The pull request thread comments could not be read.",
            )
        })?;
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
    parse_page(&response).ok_or_else(error)
}
fn parse_page(response: &Value) -> Option<Value> {
    let data = &response["data"];
    let pr_id = data["repository"]["pullRequest"]["id"].as_str()?;
    let thread = &data["node"];
    if thread["pullRequest"]["id"].as_str()? != pr_id {
        return None;
    }
    let connection = &thread["comments"];
    let nodes = connection["nodes"].as_array()?;
    let viewer = data["viewer"]["login"].as_str();
    let mut hidden = 0;
    let mut comments = Vec::new();
    for c in nodes {
        if c["isMinimized"] == true {
            hidden += 1;
            continue;
        }
        if c["id"].as_str().is_none() || c["createdAt"].as_str().is_none() {
            return None;
        }
        let comment = json!({"id":c["id"],"author":actor(&c["author"]),"body":c["body"].as_str().unwrap_or(""),"createdAt":c["createdAt"],"editedAt":c["lastEditedAt"],"url":c["url"],"reactions":reactions(&c["reactionGroups"], viewer)});
        comments.push(comment);
    }
    let next = if connection["pageInfo"]["hasNextPage"] == true {
        Some(connection["pageInfo"]["endCursor"].as_str()?.to_owned())
    } else {
        None
    };
    Some(json!({"comments":comments,"nextCursor":next,"hiddenCount":hidden}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_visible_comments_and_checks_scope() {
        let mut response = json!({"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{"id":"pr"}},"node":{"pullRequest":{"id":"pr"},"comments":{"pageInfo":{"hasNextPage":true,"endCursor":"next"},"nodes":[{"id":"1","createdAt":"date","body":"hello","author":{"login":"me"},"isMinimized":false},{"isMinimized":true}]}}}});
        let page = parse_page(&response).unwrap();
        assert_eq!(page["nextCursor"], "next");
        assert_eq!(page["hiddenCount"], 1);
        assert_eq!(page["comments"].as_array().unwrap().len(), 1);
        response["data"]["node"]["pullRequest"]["id"] = json!("other");
        assert!(parse_page(&response).is_none());
    }
}
