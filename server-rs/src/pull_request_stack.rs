//! GitHub native pull request stack reads.
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
    let number = input["number"].as_u64().unwrap();
    let error = || json!({"_tag":"PullRequestOperationError","operation":"stack","detail":"The pull request stack could not be read."});
    let fetch = |path: &str| -> Result<Option<Value>, Value> {
        let mut cmd = Command::new(exe);
        cmd.args(["api", path, "--hostname", host])
            .current_dir(&project.2);
        if let Some(credential) = &credential {
            credential.apply(&mut cmd);
        }
        fetch_command(&mut cmd)
    };
    let Some(listing) = fetch(&format!("repos/{repo}/stacks?pull_request={number}"))? else {
        return Ok(Value::Null);
    };
    let stacks = listing.as_array().ok_or_else(error)?;
    let Some(first) = stacks.first() else {
        return Ok(Value::Null);
    };
    let stack_number = first["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(error)?;
    let Some(stack) = fetch(&format!("repos/{repo}/stacks/{stack_number}"))? else {
        return Ok(Value::Null);
    };
    map(&stack).ok_or_else(error)
}

fn fetch_command(cmd: &mut Command) -> Result<Option<Value>, Value> {
    use github_pinned_credential::CommandFailure;
    let detail = "The pull request stack could not be read.";
    match github_pinned_credential::run_classified(cmd, Duration::from_secs(10)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(
            |_| json!({"_tag":"PullRequestOperationError","operation":"stack","detail":detail}),
        ),
        Err(CommandFailure::NotFound) => Ok(None),
        Err(failure) => Err(github_pinned_credential::operation_error(
            failure, "stack", detail,
        )),
    }
}

fn map(stack: &Value) -> Option<Value> {
    let number = stack["number"].as_u64().filter(|n| *n > 0)?;
    let id = match &stack["id"] {
        Value::String(s) if !s.trim().is_empty() => s.clone(),
        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        Value::Null => stack["node_id"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&number.to_string())
            .to_owned(),
        _ => return None,
    };
    let url = stack["html_url"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| stack["url"].as_str().filter(|s| !s.trim().is_empty()))?;
    let base = stack["base"]
        .as_str()
        .or_else(|| stack["base"]["ref"].as_str())
        .filter(|s| !s.trim().is_empty())?;
    let mut layers = Vec::new();
    for pr in stack["pull_requests"].as_array()? {
        let n = pr["number"].as_u64().filter(|n| *n > 0)?;
        let branch = pr["head"]["ref"]
            .as_str()
            .filter(|s| !s.trim().is_empty())?;
        let state = if !pr["merged_at"].is_null() {
            "merged"
        } else if pr["state"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("closed"))
        {
            "closed"
        } else {
            "open"
        };
        let mut layer = json!({"number":n,"headBranch":branch,"state":state});
        for (source, target) in [("title", "title"), ("draft", "isDraft")] {
            if let Some(value) = pr.get(source) {
                layer[target] = value.clone();
            }
        }
        if let Some(sha) = pr["head"].get("sha") {
            layer["headSha"] = sha.clone();
        }
        layers.push(layer);
    }
    Some(json!({"id":id,"number":number,"url":url,"base":base,"layers":layers}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_404_is_absent_but_other_failures_are_errors() {
        let mut not_found = Command::new("sh");
        not_found.args(["-c", "printf 'gh: Not Found (HTTP 404)' >&2; exit 1"]);
        assert_eq!(fetch_command(&mut not_found), Ok(None));
        let mut failed = Command::new("sh");
        failed.args(["-c", "printf 'gh: server error (HTTP 500)' >&2; exit 1"]);
        assert_eq!(
            fetch_command(&mut failed).unwrap_err()["operation"],
            "stack"
        );
    }
    #[test]
    fn maps_native_stack() {
        assert_eq!(
            map(
                &json!({"id":42,"number":3,"url":"api","html_url":"web","base":{"ref":"main"},"pull_requests":[{"number":7,"title":"one","draft":false,"head":{"ref":"feature","sha":"abc"},"state":"closed","merged_at":"now"}]})
            ),
            Some(
                json!({"id":"42","number":3,"url":"web","base":"main","layers":[{"number":7,"title":"one","isDraft":false,"headSha":"abc","headBranch":"feature","state":"merged"}]})
            )
        );
        assert!(map(&json!({"number":3})).is_none());
    }
}
