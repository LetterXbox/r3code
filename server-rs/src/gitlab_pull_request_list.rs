//! List GitLab merge requests with glab's REST API.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, process::Command, time::Duration};

type Project = (String, String, String, String);
fn api(exe: &str, root: &str, host: &str, path: &str) -> Option<Value> {
    let mut command = Command::new(exe);
    command
        .args(["api", path])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let bytes = crate::github_pinned_credential::run_classified_bounded(
        &mut command,
        Duration::from_secs(10),
        4_194_304,
    )
    .ok()?;
    serde_json::from_slice(&bytes).ok()
}
fn encoded(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn list_state(exe: &str, root: &str, host: &str, repo: &str, items: &[Value]) -> Option<Value> {
    let ids = items
        .iter()
        .filter_map(|item| item["iid"].as_u64())
        .map(|id| serde_json::to_string(&id.to_string()).unwrap())
        .collect::<Vec<_>>()
        .join(",");
    if ids.is_empty() {
        return None;
    }
    let repo_literal = serde_json::to_string(repo).unwrap();
    let query = format!("query {{ metadata {{ enterprise }} project(fullPath: {repo_literal}) {{ mergeRequests(iids: [{ids}], first: 100) {{ nodes {{ iid approved approvedBy(first: 1) {{ nodes {{ username }} }} reviewers(first: 20) {{ nodes {{ mergeRequestInteraction {{ reviewState }} }} }} headPipeline {{ status }} }} }} }} }}");
    let mut command = Command::new(exe);
    command
        .args([
            "api",
            "graphql",
            "--method",
            "POST",
            "--raw-field",
            &format!("query={query}"),
        ])
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let bytes = crate::github_pinned_credential::run_classified_bounded(
        &mut command,
        Duration::from_secs(10),
        4_194_304,
    )
    .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("errors").is_some() {
        None
    } else {
        Some(value)
    }
}

fn apply_state(entry: &mut Value, item: &Value, state: &Value) {
    if let Some(node) = state["data"]["project"]["mergeRequests"]["nodes"]
        .as_array()
        .and_then(|nodes| {
            nodes.iter().find(|node| {
                node["iid"].as_str() == item["iid"].as_u64().map(|id| id.to_string()).as_deref()
            })
        })
    {
        crate::gitlab_pull_request_read::apply_list_state(
            entry,
            node,
            &state["data"]["metadata"]["enterprise"],
        );
    }
}

pub(crate) struct ListOutput<'a> {
    pub viewers: &'a mut Value,
    pub providers: &'a mut Vec<Value>,
    pub entries: &'a mut Vec<Value>,
    pub errors: &'a mut Vec<Value>,
    pub truncated: &'a mut bool,
    pub next: &'a mut Map<String, Value>,
}

pub(crate) fn read_hosts(
    hosts: BTreeMap<String, Vec<Project>>,
    input: &Value,
    output: ListOutput<'_>,
) {
    read_hosts_with("glab", hosts, input, output)
}
fn read_hosts_with(
    exe: &str,
    hosts: BTreeMap<String, Vec<Project>>,
    input: &Value,
    output: ListOutput<'_>,
) {
    let ListOutput {
        viewers,
        providers,
        entries,
        errors,
        truncated,
        next,
    } = output;
    for (host, projects) in hosts {
        let viewer = api(exe, &projects[0].2, &host, "user").and_then(|v| {
            v["username"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        });
        if let Some(ref name) = viewer {
            viewers[&host] = json!(name);
        }
        providers.push(json!({"host":host,"kind":"gitlab","searchesOnHost":true,"actions":["merge","ready","draft","close","reopen","update-branch","enable-auto-merge","disable-auto-merge","revert","delete-branch"],"projectCount":projects.len(),"projectIds":null,"configured":viewer.is_some(),"detail":if viewer.is_some(){Value::Null}else{json!("The signed-in account could not be verified.")}}));
        for (id, title, root, repo) in projects {
            let fail = || json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be read.")});
            let Some(ref viewer) = viewer else {
                errors.push(fail());
                continue;
            };
            let key = format!("{} {}", host, repo.to_lowercase());
            let delivered = match input.get("cursors").and_then(Value::as_object) {
                Some(c) => match c.get(&key).and_then(Value::as_str) {
                    Some(c) => c
                        .split('|')
                        .nth(1)
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0),
                    None => continue,
                },
                None => 0,
            };
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(99) as usize;
            let per_page = (limit + 1).min(100);
            let mut page = delivered / per_page + 1;
            let mut skip = delivered % per_page;
            let mut consumed = delivered;
            let mut collected = Vec::new();
            let mut has_more = false;
            let mut failed = false;
            let mut last_scanned = None;
            let mut exhausted = false;
            let mut states = BTreeMap::new();
            for _ in 0..=((limit / per_page) + 1) {
                let mut params = vec![
                    (
                        "state",
                        match input["state"].as_str().unwrap_or("all") {
                            "open" => "opened".to_owned(),
                            s => s.to_owned(),
                        },
                    ),
                    ("order_by", "updated_at".into()),
                    ("sort", "desc".into()),
                    ("per_page", per_page.to_string()),
                    ("page", page.to_string()),
                ];
                match input["involvement"].as_str() {
                    Some("authored") => params.push(("author_username", viewer.clone())),
                    Some("reviewing") => params.push(("reviewer_username", viewer.clone())),
                    _ => {}
                }
                if let Some(q) = input["query"].as_str() {
                    params.push(("search", q.into()));
                }
                if let Some(a) = input["filters"]["author"].as_str() {
                    if input["involvement"] != "authored" {
                        params.push((
                            "author_username",
                            if a == "@me" { viewer.clone() } else { a.into() },
                        ));
                    }
                }
                if let Some(d) = input["filters"]["draft"].as_str() {
                    params.push(("wip", if d == "only" { "yes" } else { "no" }.into()));
                }
                match input["filters"]["review"].as_str() {
                    Some("approved") => params.push(("approved_by_usernames[]", "Any".into())),
                    Some("none") => params.push(("approved_by_ids[]", "None".into())),
                    _ => {}
                }
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(params)
                    .finish();
                let path = format!("projects/{}/merge_requests?{}", encoded(&repo), query);
                let Some(data) = api(exe, &root, &host, &path) else {
                    failed = true;
                    break;
                };
                let Some(items) = data.as_array() else {
                    failed = true;
                    break;
                };
                let raw_len = items.len();
                let needs_state = input["filters"]["checks"].is_string()
                    || input["filters"]["review"].is_string();
                let page_state = needs_state
                    .then(|| list_state(exe, &root, &host, &repo, items))
                    .flatten();
                for item in items.iter().skip(skip) {
                    if collected.len() >= limit {
                        has_more = true;
                        break;
                    }
                    consumed += 1;
                    if let Some(timestamp) = item["updated_at"].as_str() {
                        last_scanned = Some(timestamp.to_owned());
                    }
                    if item["iid"].as_u64().is_none_or(|n| n == 0)
                        || [
                            "title",
                            "web_url",
                            "source_branch",
                            "target_branch",
                            "created_at",
                            "updated_at",
                        ]
                        .iter()
                        .any(|k| item[*k].as_str().is_none_or(|s| s.trim().is_empty()))
                    {
                        continue;
                    }
                    let labels = item["labels"].as_array();
                    let has_label = |name: &str| {
                        labels.is_some_and(|ls| {
                            ls.iter()
                                .any(|l| l.as_str().is_some_and(|s| s.eq_ignore_ascii_case(name)))
                        })
                    };
                    if input["filters"]["labels"].as_array().is_some_and(|groups| {
                        groups.iter().any(|g| {
                            g.as_array().is_some_and(|names| {
                                !names.is_empty()
                                    && !names.iter().filter_map(Value::as_str).any(has_label)
                            })
                        })
                    }) || input["filters"]["excludedLabels"]
                        .as_array()
                        .is_some_and(|names| names.iter().filter_map(Value::as_str).any(has_label))
                    {
                        continue;
                    }
                    if let Some(ref state) = page_state {
                        let mut summary = json!({});
                        apply_state(&mut summary, item, state);
                        let review_matches =
                            input["filters"]["review"].as_str().is_none_or(|wanted| {
                                summary.get("reviewDecision").is_none_or(|actual| {
                                    if wanted == "none" {
                                        actual.is_null()
                                    } else {
                                        actual.as_str() == Some(wanted)
                                    }
                                })
                            });
                        let checks_match =
                            input["filters"]["checks"].as_str().is_none_or(|wanted| {
                                summary
                                    .get("checksState")
                                    .is_none_or(|actual| actual.as_str() == Some(wanted))
                            });
                        if !review_matches || !checks_match {
                            continue;
                        }
                        if let Some(iid) = item["iid"].as_u64() {
                            states.insert(iid, summary);
                        }
                    }
                    collected.push(item.clone());
                }
                if has_more {
                    break;
                }
                if raw_len < per_page {
                    exhausted = true;
                    break;
                }
                if collected.len() >= limit {
                    has_more = true;
                    break;
                }
                skip = 0;
                page += 1;
            }
            if failed {
                errors.push(fail());
                continue;
            }
            if has_more || !exhausted {
                if let Some(last) = last_scanned.as_deref() {
                    *truncated = true;
                    let previous = input["cursors"][&key].as_str().unwrap_or("");
                    let mut seen: Vec<String> = if previous.split('|').next() == Some(last) {
                        previous
                            .split('|')
                            .nth(2)
                            .unwrap_or("")
                            .split(',')
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    for number in collected
                        .iter()
                        .filter(|item| item["updated_at"].as_str() == Some(last))
                        .filter_map(|item| item["iid"].as_u64())
                    {
                        let value = number.to_string();
                        if !seen.contains(&value) {
                            seen.push(value);
                        }
                    }
                    next.insert(key, json!(format!("{last}|{consumed}|{}", seen.join(","))));
                }
            }
            let state = if states.is_empty() {
                list_state(exe, &root, &host, &repo, &collected)
            } else {
                None
            };
            for item in collected {
                let author = item["author"]["username"].as_str().map(|login| json!({"login":login,"name":item["author"]["name"],"avatarUrl":item["author"]["avatar_url"]})).unwrap_or(Value::Null);
                let labels = item["labels"]
                    .as_array()
                    .map(|ls| {
                        ls.iter()
                            .filter_map(|l| {
                                l.as_str().map(|name| json!({"name":name,"color":null}))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let requested = item["reviewers"].as_array().is_some_and(|a| {
                    a.iter().any(|r| {
                        r["username"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case(viewer))
                    })
                });
                let mut entry = json!({"provider":"gitlab","host":host,"projectId":id,"projectTitle":title,"repository":repo,"number":item["iid"],"title":item["title"],"url":item["web_url"],"author":author,"headBranch":item["source_branch"],"baseBranch":item["target_branch"],"state":match item["state"].as_str(){Some("merged")=>"merged",Some("closed")=>"closed",_=>"open"},"isDraft":item["draft"] == true || item["work_in_progress"] == true,"mergeability":match item["detailed_merge_status"].as_str().or_else(|| item["merge_status"].as_str()) {Some("mergeable" | "can_be_merged")=>"mergeable", Some("conflict" | "cannot_be_merged")=>"conflicting", _=>"unknown"},"additions":0,"deletions":0,"createdAt":item["created_at"],"updatedAt":item["updated_at"],"observedAt":chrono::Utc::now().timestamp_millis(),"viewerReviewRequested":requested,"labels":labels});
                if let Some(summary) = item["iid"].as_u64().and_then(|iid| states.get(&iid)) {
                    if let Some(map) = summary.as_object() {
                        for (key, value) in map {
                            entry[key] = value.clone();
                        }
                    }
                } else if let Some(ref state) = state {
                    apply_state(&mut entry, &item, state);
                }
                entries.push(entry);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn lists_gitlab_projects_and_continues_offset_pages() {
        let dir = std::env::temp_dir().join(format!("t3-gitlab-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("glab");
        std::fs::write(&exe, r##"#!/bin/sh
case "$2" in
user) printf '%s' '{"username":"alice"}';;
*page=1*) printf '%s' '[{"iid":7,"title":"Fix","web_url":"https://gitlab.com/a/b/-/merge_requests/7","source_branch":"topic","target_branch":"main","state":"opened","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-02T00:00:00Z","author":{"username":"bob"},"reviewers":[{"username":"alice"}],"labels":["bug"]},{"iid":8,"title":"More","web_url":"https://gitlab.com/a/b/-/merge_requests/8","source_branch":"x","target_branch":"main","state":"merged","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}]';;
*) printf '%s' '[]';;
esac
"##).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = BTreeMap::from([(
            "gitlab.com".to_owned(),
            vec![(
                "p".into(),
                "Project".into(),
                dir.to_string_lossy().into_owned(),
                "a/b".into(),
            )],
        )]);
        let invoke = |input: Value| {
            let (mut viewers, mut providers, mut entries, mut errors, mut truncated, mut next) =
                (json!({}), vec![], vec![], vec![], false, Map::new());
            read_hosts_with(
                exe.to_str().unwrap(),
                projects.clone(),
                &input,
                ListOutput {
                    viewers: &mut viewers,
                    providers: &mut providers,
                    entries: &mut entries,
                    errors: &mut errors,
                    truncated: &mut truncated,
                    next: &mut next,
                },
            );
            (viewers, providers, entries, errors, truncated, next)
        };
        let first = invoke(json!({"state":"all","limit":1}));
        assert_eq!(first.0["gitlab.com"], "alice");
        assert_eq!(first.1[0]["kind"], "gitlab");
        assert_eq!(first.2[0]["number"], 7);
        assert_eq!(first.2[0]["viewerReviewRequested"], true);
        assert_eq!(first.2[0]["labels"][0]["name"], "bug");
        assert!(first.3.is_empty());
        assert!(first.4);
        let second = invoke(json!({"state":"all","limit":1,"cursors":first.5}));
        assert_eq!(second.2[0]["number"], 8);
        assert!(second.4);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
