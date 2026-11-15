//! Label candidates and mutations for change requests.
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value, write: bool) -> bool {
    crate::pull_request_links::valid(input)
        && (!write
            || (input["applied"].is_boolean()
                && input["labels"].as_array().is_some_and(|labels| {
                    (1..=25).contains(&labels.len())
                        && labels
                            .iter()
                            .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
                })))
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
// A worker takes the next lookup as soon as it finishes; output stays in input order.
fn parallel_lookups<F>(
    labels: &[&str],
    lookup: F,
) -> Vec<Result<Value, crate::github_pinned_credential::CommandFailure>>
where
    F: Fn(&str) -> Result<Value, crate::github_pinned_credential::CommandFailure> + Sync,
{
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    let next = AtomicUsize::new(0);
    let results = Mutex::new((0..labels.len()).map(|_| None).collect::<Vec<_>>());
    std::thread::scope(|scope| {
        for _ in 0..labels.len().min(4) {
            let lookup = &lookup;
            let next = &next;
            let results = &results;
            scope.spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= labels.len() {
                    break;
                }
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| lookup(labels[i])))
                        .unwrap_or(Err(crate::github_pinned_credential::CommandFailure::Failed));
                results.lock().unwrap()[i] = Some(result);
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}
fn trimmed(v: &Value) -> Value {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}
fn github_candidates(repo: &Value) -> Value {
    let applied: Vec<String> = repo["pullRequest"]["labels"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            n["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
        .collect();
    let mut candidates = Vec::new();
    for node in repo["labels"]["nodes"].as_array().into_iter().flatten() {
        let name = trimmed(&node["name"]);
        if name.is_null() {
            continue;
        }
        let item = json!({"name":name,"color":trimmed(&node["color"]),"description":trimmed(&node["description"]),"isApplied":applied.iter().any(|n| Some(n.as_str()) == name.as_str())});
        if let Some(i) = candidates.iter().position(|v: &Value| v["name"] == name) {
            candidates[i] = item;
        } else {
            candidates.push(item);
        }
    }
    let mut missing: Vec<Value> = applied
        .iter()
        .filter(|n| !candidates.iter().any(|v| v["name"] == **n))
        .map(|n| json!({"name":n,"color":null,"description":null,"isApplied":true}))
        .collect();
    missing.extend(candidates);
    json!({"candidates":missing,"truncated":repo["labels"]["pageInfo"]["hasNextPage"] == true})
}
pub(crate) fn run(
    projects: Vec<(String, String, String)>,
    input: &Value,
    write: bool,
) -> Result<Value, Value> {
    let op = if write {
        "setLabels"
    } else {
        "labelCandidates"
    };
    let fail = || json!({"_tag":"PullRequestOperationError","operation":op,"detail":"The labels could not be updated."});
    let (detail, credential) = crate::pull_request_detail::read_pinned(projects, input)?;
    if detail["capabilities"]["labels"] != true {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":op,"detail":"This host cannot change the labels on a change request."}),
        );
    }
    if detail["viewerPermissions"]["labels"] == false {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":op,"detail":"You need triage access on this repository to change its labels."}),
        );
    }
    let root = detail["workspaceRoot"].as_str().ok_or_else(fail)?;
    let repo = detail["repository"].as_str().ok_or_else(fail)?;
    let identity = crate::repository_identity::resolve(root).ok_or_else(fail)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(fail)?;
    let number = input["number"].as_u64().ok_or_else(fail)?;
    if detail["provider"] == "github" {
        let (owner, name) = repo.split_once('/').ok_or_else(fail)?;
        if !write {
            let query = format!("query {{ repository(owner:{},name:{}) {{ labels(first:100,orderBy:{{field:NAME,direction:ASC}}) {{ pageInfo {{ hasNextPage }} nodes {{ name color description }} }} pullRequest(number:{number}) {{ labels(first:100) {{ nodes {{ name }} }} }} }} }}",json!(owner),json!(name));
            let value = invoke(
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
                None,
                credential.as_ref(),
            )
            .map_err(|_| fail())?;
            if value.get("errors").is_some() || value["data"]["repository"].is_null() {
                return Err(fail());
            }
            return Ok(github_candidates(&value["data"]["repository"]));
        }
        let path = format!("repos/{owner}/{name}/issues/{number}/labels");
        let labels: Vec<&str> = input["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().trim())
            .collect();
        if input["applied"] == true {
            invoke(
                root,
                host,
                true,
                &["api", "--hostname", host, "--method", "POST", &path],
                Some(&json!({"labels":labels})),
                credential.as_ref(),
            )
            .map_err(|_| fail())?;
        } else {
            for label in labels {
                invoke(
                    root,
                    host,
                    true,
                    &[
                        "api",
                        "--hostname",
                        host,
                        "--method",
                        "DELETE",
                        &format!("{path}/{}", encode(label)),
                    ],
                    None,
                    credential.as_ref(),
                )
                .map_err(|_| fail())?;
            }
        }
        Ok(Value::Null)
    } else if detail["provider"] == "gitlab" {
        let base = format!("projects/{}", encode(repo));
        if !write {
            let response = invoke(
                root,
                host,
                false,
                &[
                    "api",
                    &format!("{base}/labels?per_page=100&include_ancestor_groups=true"),
                ],
                None,
                None,
            )
            .map_err(|_| fail())?;
            let labels = response.as_array().ok_or_else(fail)?;
            let applied = detail["labels"].as_array().ok_or_else(fail)?;
            let mut candidates = Vec::new();
            for label in applied {
                let Some(name) = label["name"].as_str() else {
                    continue;
                };
                if !labels.iter().any(|l| l["name"] == name) {
                    candidates.push(json!({"name": name, "color": label["color"], "description": null, "isApplied": true}));
                }
            }
            for label in labels {
                let Some(name) = label["name"].as_str() else {
                    continue;
                };
                let is_applied = applied.iter().any(|l| l["name"] == name);
                if label["archived"] == true && !is_applied {
                    continue;
                }
                candidates.push(json!({"name":name,"color":label["color"],"description":label["description"],"isApplied":is_applied}));
            }
            return Ok(json!({"candidates":candidates,"truncated":labels.len() >= 100}));
        }
        let labels: Vec<&str> = input["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().trim())
            .collect();
        if input["applied"] == true {
            let results = parallel_lookups(&labels, |label| {
                invoke(
                    root,
                    host,
                    false,
                    &[
                        "api",
                        &format!(
                            "{base}/labels/{}?include_ancestor_groups=true",
                            encode(label)
                        ),
                    ],
                    None,
                    None,
                )
            });
            let mut unknown = Vec::new();
            for (label, lookup) in labels.iter().zip(results) {
                if lookup
                    .as_ref()
                    .is_err_and(|e| *e != crate::github_pinned_credential::CommandFailure::NotFound)
                {
                    return Err(
                        json!({"_tag":"PullRequestOperationError","operation":op,"detail":"GitLab CLI command failed."}),
                    );
                }
                if lookup.as_ref().ok().and_then(|v| v["name"].as_str()) != Some(*label) {
                    unknown.push(*label);
                }
            }
            if !unknown.is_empty() {
                let names = unknown
                    .iter()
                    .map(|label| format!("\"{label}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(
                    json!({"_tag":"PullRequestOperationError","operation":op,"detail":format!("The project has no label named {names}.")}),
                );
            }
        }
        let key = if input["applied"] == true {
            "add_labels"
        } else {
            "remove_labels"
        };
        invoke(
            root,
            host,
            false,
            &[
                "api",
                &format!("{base}/merge_requests/{number}"),
                "--method",
                "PUT",
            ],
            Some(&json!({(key):labels.join(",")})),
            None,
        )
        .map_err(|_| fail())?;
        Ok(Value::Null)
    } else {
        Err(
            json!({"_tag":"PullRequestOperationError","operation":op,"detail":"This host cannot change the labels on a change request."}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lookups_keep_four_workers_busy_and_preserve_order() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier, Condvar, Mutex,
        };
        use std::time::Duration;
        let started = Barrier::new(4);
        let fifth = (Mutex::new(false), Condvar::new());
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let labels = ["0", "1", "2", "3", "4", "5"];
        let results = parallel_lookups(&labels, |label| {
            let number: usize = label.parse().unwrap();
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(count, Ordering::SeqCst);
            if number < 4 {
                started.wait();
            }
            if number == 0 {
                let (lock, wake) = &fifth;
                let (seen, timeout) = wake
                    .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(2), |seen| !*seen)
                    .unwrap();
                assert!(
                    *seen && !timeout.timed_out(),
                    "fifth lookup must start before the first finishes"
                );
            }
            if number == 4 {
                *fifth.0.lock().unwrap() = true;
                fifth.1.notify_one();
            }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(json!(number))
        });
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
        assert_eq!(
            results.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            labels
                .iter()
                .map(|s| json!(s.parse::<usize>().unwrap()))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn contract_and_mapping() {
        let mut i = json!({"projectId":"p","repository":"a/b","number":1,"labels":[" bug "],"applied":true});
        assert!(valid(&i, true));
        i["labels"] = json!([]);
        assert!(!valid(&i, true));
        let v = github_candidates(
            &json!({"labels":{"nodes":[{"name":"bug","color":"fff","description":" "}],"pageInfo":{"hasNextPage":true}},"pullRequest":{"labels":{"nodes":[{"name":"old"},{"name":"bug"}]}}}),
        );
        assert_eq!(v["candidates"][0]["name"], "old");
        assert_eq!(v["candidates"][1]["isApplied"], true);
        assert_eq!(v["truncated"], true);
        assert_eq!(encode("a/b"), "a%2Fb");
    }
}
