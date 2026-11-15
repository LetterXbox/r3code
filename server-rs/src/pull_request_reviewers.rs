//! Reviewer candidates and requests.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

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
    body: Option<&Value>,
    credential: Option<&crate::github_pinned_credential::PinnedCredential>,
) -> Result<Value, crate::github_pinned_credential::CommandFailure> {
    let mut cmd = Command::new(if github { "gh" } else { "glab" });
    cmd.args(args).current_dir(root);
    if !github {
        cmd.env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
    }
    if let Some(c) = credential {
        c.apply(&mut cmd);
    }
    let bytes = if let Some(body) = body {
        cmd.arg("--input").arg("-");
        if !github {
            cmd.args(["--header", "Content-Type: application/json"]);
        }
        crate::github_pinned_credential::run_classified_with_input(
            &mut cmd,
            Duration::from_secs(30),
            body.to_string().into_bytes(),
        )
    } else {
        crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(30))
    }?;
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| crate::github_pinned_credential::CommandFailure::Failed)
    }
}
pub(crate) fn valid(v: &Value, write: bool) -> bool {
    crate::pull_request_links::valid(v)
        && if write {
            v["requested"].is_boolean()
                && v["reviewers"].as_array().is_some_and(|rs| {
                    (1..=25).contains(&rs.len())
                        && rs.iter().all(|r| {
                            r["id"].as_str().is_some_and(|s| !s.trim().is_empty())
                                && matches!(r["kind"].as_str(), Some("user" | "team"))
                        })
                })
        } else {
            v.get("query").is_none_or(|q| {
                q.as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.trim().chars().count() <= 100)
            })
        }
}
fn text(v: &Value) -> Value {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}
fn gitlab_reviewer_id(value: &str) -> Option<u64> {
    let value = value.trim();
    let number = if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u64::from_str_radix(digits, 16).ok()? as f64
    } else if let Some(digits) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        u64::from_str_radix(digits, 8).ok()? as f64
    } else if let Some(digits) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        u64::from_str_radix(digits, 2).ok()? as f64
    } else {
        value.parse::<f64>().ok()?
    };
    if number.is_finite()
        && number > 0.0
        && number <= 9_007_199_254_740_991.0
        && number.fract() == 0.0
    {
        Some(number as u64)
    } else {
        None
    }
}
fn github_candidates(repo: &Value, search: bool) -> Value {
    let author = repo["pullRequest"]["author"]["login"].as_str();
    let users = repo["assignableUsers"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut candidates = Vec::<Value>::new();
    for node in repo["pullRequest"]["reviewRequests"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let raw = &node["requestedReviewer"];
        let slug = raw["slug"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let id = slug.or_else(|| {
            raw["login"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });
        let Some(id) = id else { continue };
        let kind = if slug.is_some() { "team" } else { "user" };
        let login = if slug.is_some() {
            raw["combinedSlug"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(id)
        } else {
            id
        };
        let item = json!({"id":id,"kind":kind,"login":login,"name":text(&raw[if slug.is_some(){"teamName"}else{"name"}]),"avatarUrl":text(&raw[if slug.is_some(){"teamAvatarUrl"}else{"avatarUrl"}]),"isRequested":true});
        if let Some(i) = candidates
            .iter()
            .position(|v| v["id"] == id && v["kind"] == kind)
        {
            candidates[i] = item;
        } else {
            candidates.push(item);
        }
    }
    for user in &users {
        let Some(login) = user["login"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if Some(login) == author
            || candidates
                .iter()
                .any(|v| v["kind"] == "user" && v["id"] == login)
        {
            continue;
        }
        candidates.push(json!({"id":login,"kind":"user","login":login,"name":text(&user["name"]),"avatarUrl":text(&user["avatarUrl"]),"isRequested":false}));
    }
    if search {
        candidates.retain(|v| v["kind"] == "user" && users.iter().any(|u| u["login"] == v["id"]));
    }
    json!({"candidates":candidates,"truncated":repo["assignableUsers"]["pageInfo"]["hasNextPage"]==true})
}
pub(crate) fn run(
    projects: Vec<(String, String, String)>,
    input: &Value,
    write: bool,
) -> Result<Value, Value> {
    let op = if write {
        "requestReviewers"
    } else {
        "reviewerCandidates"
    };
    let fail = || json!({"_tag":"PullRequestOperationError","operation":op,"detail":"The reviewers could not be updated."});
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects, input)?;
    let cap = if write { "request" } else { "listCandidates" };
    if detail["capabilities"]["reviewers"][cap] != true {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":op,"detail":if write {"This host cannot ask somebody for a review."}else{"This host cannot say who may review a change request."}}),
        );
    }
    if detail["viewerPermissions"]["requestReviewers"] != true {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":op,"detail":"You need write access on this repository to ask for a review."}),
        );
    }
    let root = detail["workspaceRoot"].as_str().ok_or_else(fail)?;
    let repo = detail["repository"].as_str().ok_or_else(fail)?;
    let identity = crate::repository_identity::resolve(root).ok_or_else(fail)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|p| p.0)
        .ok_or_else(fail)?;
    let n = input["number"].as_u64().ok_or_else(fail)?;
    let query = input["query"].as_str().map(str::trim);
    if detail["provider"] == "github" {
        let (owner, name) = repo.split_once('/').ok_or_else(fail)?;
        if write {
            let rs = input["reviewers"].as_array().unwrap();
            let users: Vec<_> = rs
                .iter()
                .filter(|r| r["kind"] == "user")
                .map(|r| r["id"].as_str().unwrap().trim())
                .collect();
            let teams: Vec<_> = rs
                .iter()
                .filter(|r| r["kind"] == "team")
                .map(|r| r["id"].as_str().unwrap().trim())
                .collect();
            invoke(
                root,
                host,
                true,
                &[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    if input["requested"] == true {
                        "POST"
                    } else {
                        "DELETE"
                    },
                    &format!("repos/{owner}/{name}/pulls/{n}/requested_reviewers"),
                ],
                Some(&json!({"reviewers":users,"team_reviewers":teams})),
                credential.as_ref(),
            )
            .map_err(|_| fail())?;
            Ok(Value::Null)
        } else {
            let q = query.map_or("null".to_owned(), |s| json!(s).to_string());
            let gql=format!("query {{ repository(owner:{},name:{}) {{ assignableUsers(first:100,query:{q}) {{ pageInfo {{ hasNextPage }} nodes {{ login name avatarUrl }} }} pullRequest(number:{n}) {{ author {{ login }} reviewRequests(first:100) {{ nodes {{ requestedReviewer {{ ... on User {{ login name avatarUrl }} ... on Team {{ slug combinedSlug teamName:name teamAvatarUrl:avatarUrl }} ... on Bot {{ login avatarUrl }} }} }} }} }} }} }}",json!(owner),json!(name));
            let response = invoke(
                root,
                host,
                true,
                &[
                    "api",
                    "graphql",
                    "--hostname",
                    host,
                    "-f",
                    &format!("query={gql}"),
                ],
                None,
                credential.as_ref(),
            )
            .map_err(|_| fail())?;
            if response.get("errors").is_some() || response["data"]["repository"].is_null() {
                return Err(fail());
            }
            Ok(github_candidates(
                &response["data"]["repository"],
                query.is_some(),
            ))
        }
    } else if detail["provider"] == "gitlab" {
        let gitlab_fail = |e| match e {
            crate::github_pinned_credential::CommandFailure::Unauthenticated => {
                json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"gitlab","requirement":"GitLab CLI is not authenticated. Run `glab auth login` and retry."})
            }
            crate::github_pinned_credential::CommandFailure::RateLimited => {
                json!({"_tag":"PullRequestOperationError","operation":op,"detail":"GitLab API rate limit exceeded."})
            }
            crate::github_pinned_credential::CommandFailure::Spawn(
                std::io::ErrorKind::NotFound,
            ) => {
                json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"gitlab"})
            }
            _ => {
                json!({"_tag":"PullRequestOperationError","operation":op,"detail":"GitLab CLI command failed."})
            }
        };
        let base = format!("projects/{}", encode(repo));
        let mr_path = format!("{base}/merge_requests/{n}?include_diverged_commits_count=true");
        let users_path = format!(
            "{base}/users?per_page=100{}",
            query.map_or(String::new(), |q| format!("&search={}", encode(q)))
        );
        let (mr, users_response) = if write {
            (
                invoke(root, host, false, &["api", &mr_path], None, None).map_err(gitlab_fail)?,
                None,
            )
        } else {
            std::thread::scope(|scope| {
                let mr = scope.spawn(|| invoke(root, host, false, &["api", &mr_path], None, None));
                let users = invoke(root, host, false, &["api", &users_path], None, None);
                Ok::<_, Value>((
                    mr.join()
                        .map_err(|_| {
                            gitlab_fail(crate::github_pinned_credential::CommandFailure::Failed)
                        })?
                        .map_err(gitlab_fail)?,
                    Some(users.map_err(gitlab_fail)?),
                ))
            })?
        };
        let reviewers = mr["reviewers"].as_array().cloned().unwrap_or_default();
        if write {
            let mut ids: Vec<u64> = reviewers.iter().filter_map(|r| r["id"].as_u64()).collect();
            for r in input["reviewers"].as_array().unwrap() {
                if let Some(id) = gitlab_reviewer_id(r["id"].as_str().unwrap()) {
                    if input["requested"] == true {
                        if !ids.contains(&id) {
                            ids.push(id)
                        }
                    } else {
                        ids.retain(|v| *v != id)
                    }
                }
            }
            invoke(
                root,
                host,
                false,
                &[
                    "api",
                    &format!("{base}/merge_requests/{n}"),
                    "--method",
                    "PUT",
                ],
                Some(&json!({"reviewer_ids":ids})),
                None,
            )
            .map_err(gitlab_fail)?;
            Ok(Value::Null)
        } else {
            let response = users_response.ok_or_else(fail)?;
            let users = response.as_array().ok_or_else(fail)?;
            let mut candidates = Vec::new();
            let requested: Vec<u64> = reviewers.iter().filter_map(|r| r["id"].as_u64()).collect();
            let author = mr["author"]["username"].as_str();
            let actor = |u: &Value, requested: bool| -> Option<Value> {
                let id = u["id"].as_u64()?;
                let login = u["username"].as_str()?.trim();
                if login.is_empty() {
                    return None;
                }
                Some(
                    json!({"id":id.to_string(),"kind":"user","login":login,"name":text(&u["name"]),"avatarUrl":text(&u["avatar_url"]),"isRequested":requested}),
                )
            };
            if query.is_none() {
                for u in &reviewers {
                    if let Some(item) = actor(u, true) {
                        candidates.push(item)
                    }
                }
            }
            for u in users {
                let Some(item) = actor(u, requested.contains(&u["id"].as_u64().unwrap_or(0)))
                else {
                    continue;
                };
                if item["login"].as_str() == author
                    || candidates.iter().any(|c| c["id"] == item["id"])
                {
                    continue;
                }
                candidates.push(item);
            }
            Ok(json!({"candidates":candidates,"truncated":users.len()>=100}))
        }
    } else {
        Err(fail())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gitlab_ids_accept_safe_integer_numeric_spellings() {
        for id in ["12", "12.0", "1.2e1", "0xc", "0o14", "0b1100"] {
            assert_eq!(gitlab_reviewer_id(id), Some(12), "{id}");
        }
        for id in ["0", "-1", "1.5", "Infinity", "9007199254740992", "garbage"] {
            assert_eq!(gitlab_reviewer_id(id), None, "{id}");
        }
    }
    #[test]
    fn contract_and_mapping() {
        let mut v = json!({"projectId":"p","repository":"a/b","number":1,"reviewers":[{"id":"alice","kind":"user"}],"requested":true});
        assert!(valid(&v, true));
        v["reviewers"] = json!([]);
        assert!(!valid(&v, true));
        let v = github_candidates(
            &json!({"assignableUsers":{"pageInfo":{"hasNextPage":true},"nodes":[{"login":"alice"},{"login":"author"}]},"pullRequest":{"author":{"login":"author"},"reviewRequests":{"nodes":[{"requestedReviewer":{"login":"alice"}},{"requestedReviewer":{"slug":"dev","combinedSlug":"org/dev"}}]}}}),
            false,
        );
        assert_eq!(v["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(v["candidates"][1]["login"], "org/dev");
        assert_eq!(v["truncated"], true);
    }
}
