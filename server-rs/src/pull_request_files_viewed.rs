//! GitHub's per-viewer pull request file marks.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value, write: bool) -> bool {
    crate::pull_request_links::valid(input)
        && (!write
            || input
                .get("files")
                .and_then(Value::as_array)
                .is_some_and(|files| {
                    files.len() <= 500
                        && files.iter().all(|f| {
                            f["path"]
                                .as_str()
                                .is_some_and(|p| !p.is_empty() && p.chars().count() <= 4096)
                                && f["viewed"].is_boolean()
                                && f.get("revision").is_none_or(|r| {
                                    r.as_str().is_some_and(|s| {
                                        !s.trim().is_empty() && s.trim().chars().count() <= 256
                                    })
                                })
                        })
                }))
}

pub(crate) fn run(
    db: &std::sync::Mutex<rusqlite::Connection>,
    projects: Vec<(String, String, String)>,
    input: &Value,
    write: bool,
) -> Result<Value, Value> {
    let operation = if write {
        "setFilesViewed"
    } else {
        "filesViewed"
    };
    let unavailable =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    let rejected = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."});
    let mismatch = || json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."});
    let resolved: Vec<_> = projects
        .into_iter()
        .map(|(id, _, root)| {
            let identity = crate::repository_identity::resolve(&root);
            (id, root, identity)
        })
        .collect();
    let repo = input["repository"].as_str().unwrap().trim();
    let requested_host = input.get("host").and_then(Value::as_str).map(str::trim);
    let matches = |p: &&(String, String, Option<Value>)| {
        p.2.as_ref()
            .and_then(|v| v["canonicalKey"].as_str())
            .and_then(|k| k.split_once('/'))
            .is_some_and(|(h, r)| {
                r.eq_ignore_ascii_case(repo)
                    && requested_host.is_none_or(|x| x.eq_ignore_ascii_case(h))
            })
    };
    let selected = resolved
        .iter()
        .find(|p| p.0 == input["projectId"].as_str().unwrap());
    let project = selected
        .filter(matches)
        .or_else(|| requested_host.and_then(|_| resolved.iter().find(matches)))
        .ok_or_else(|| {
            if input.get("expectedAccountId").is_some() {
                rejected()
            } else if requested_host.is_none() && selected.is_some_and(|p| p.2.is_some()) {
                mismatch()
            } else {
                unavailable()
            }
        })?;
    let identity = project.2.as_ref().unwrap();
    if identity["provider"] == "gitlab" {
        if input.get("expectedAccountId").is_some() {
            return Err(rejected());
        }
        let remote = identity["canonicalKey"].as_str().ok_or_else(unavailable)?;
        let host = remote.split('/').next().ok_or_else(unavailable)?;
        let repository = identity["displayName"].as_str().ok_or_else(unavailable)?;
        return crate::gitlab_files_viewed::run(
            db, &project.1, host, repository, remote, input, write,
        );
    }
    if identity["provider"] != "github" {
        return Err(if input.get("expectedAccountId").is_some() {
            rejected()
        } else {
            unavailable()
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
        if !requested_host.is_some_and(|h| h.eq_ignore_ascii_case(host)) {
            return Err(rejected());
        }
        Some(
            crate::github_pinned_credential::capture("gh", &project.1, host, expected)
                .ok_or_else(rejected)?,
        )
    } else {
        None
    };
    let repository = identity["displayName"].as_str().ok_or_else(unavailable)?;
    let (owner, name) = repository.split_once('/').ok_or_else(unavailable)?;
    let number = input["number"].as_u64().unwrap();
    let error = || json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"The pull request could not be read."});
    let query = |q: &str| -> Result<Value, Value> {
        let mut cmd = Command::new("gh");
        cmd.args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={q}"),
        ])
        .current_dir(&project.1);
        if let Some(c) = &credential {
            c.apply(&mut cmd)
        }
        let bytes =
            crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
                .map_err(|e| {
                    crate::github_pinned_credential::operation_error(
                        e,
                        operation,
                        "The pull request could not be read.",
                    )
                })?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
        if v.get("errors")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
        {
            return Err(error());
        }
        Ok(v)
    };
    if write {
        let files = input["files"].as_array().unwrap();
        if files.is_empty() {
            return Ok(Value::Null);
        }
        let id_query = format!(
            "query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ id }} }} }}",
            json!(owner),
            json!(name)
        );
        let response = query(&id_query)?;
        let id = response["data"]["repository"]["pullRequest"]["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(error)?;
        let fields = files
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let method = if f["viewed"] == true {
                    "markFileAsViewed"
                } else {
                    "unmarkFileAsViewed"
                };
                format!(
                    "f{i}: {method}(input:{{pullRequestId:{},path:{}}}) {{ clientMutationId }}",
                    json!(id),
                    json!(f["path"])
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        query(&format!("mutation {{ {fields} }}"))?;
        return Ok(Value::Null);
    }
    let mut files = Vec::new();
    let mut cursor = None::<String>;
    let mut truncated = false;
    for _ in 0..5 {
        let after = cursor
            .as_ref()
            .map(|s| format!(",after:{}", json!(s)))
            .unwrap_or_default();
        let q=format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ files(first:100{after}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ path viewerViewedState }} }} }} }} }}",json!(owner),json!(name));
        let response = query(&q)?;
        let page = &response["data"]["repository"]["pullRequest"]["files"];
        for node in page["nodes"].as_array().ok_or_else(error)? {
            let path = node["path"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(error)?;
            let state = match node["viewerViewedState"].as_str() {
                Some("VIEWED") => "viewed",
                Some("UNVIEWED") => "unviewed",
                Some("DISMISSED") => "dismissed",
                _ => return Err(error()),
            };
            files.push(json!({"path":path,"state":state}));
        }
        let next = page["pageInfo"]["hasNextPage"]
            .as_bool()
            .ok_or_else(error)?;
        truncated = next;
        if !next {
            break;
        }
        cursor = Some(
            page["pageInfo"]["endCursor"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(error)?
                .to_owned(),
        );
    }
    Ok(json!({"files":files,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_marks_without_stripping_filename_whitespace() {
        let base = json!({"projectId":"p","repository":"a/b","number":1,"files":[{"path":" file ","viewed":true,"revision":"abc"}]});
        assert!(valid(&base, true));
        let mut bad = base.clone();
        bad["files"][0]["path"] = json!("");
        assert!(!valid(&bad, true));
        bad = base.clone();
        bad["files"][0]["viewed"] = json!("yes");
        assert!(!valid(&bad, true));
        bad = base.clone();
        bad["files"] = json!(vec![json!({"path":"a","viewed":true}); 501]);
        assert!(!valid(&bad, true));
    }
}
