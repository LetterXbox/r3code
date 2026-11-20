//! Read pull request lists from configured GitHub checkouts.
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) fn valid(v: &Value) -> bool {
    let string = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
    matches!(
        v.get("state").and_then(Value::as_str),
        Some("all" | "open" | "closed" | "merged")
    ) && v
        .get("involvement")
        .is_none_or(|x| matches!(x.as_str(), Some("all" | "reviewing" | "authored")))
        && ["host", "projectId", "query"]
            .iter()
            .all(|k| v.get(k).is_none_or(string))
        && v.get("query")
            .is_none_or(|x| x.as_str().is_some_and(|s| s.len() <= 200))
        && v.get("projectIds").is_none_or(|x| {
            x.as_array()
                .is_some_and(|a| a.len() <= 100 && a.iter().all(string))
        })
        && v.get("limit")
            .is_none_or(|x| x.as_u64().is_some_and(|n| (1..=500).contains(&n)))
        && v.get("cursors").is_none_or(|x| {
            x.as_object().is_some_and(|o| {
                o.iter().all(|(k, v)| {
                    !k.trim().is_empty() && string(v) && v.as_str().unwrap().len() <= 4096
                })
            })
        })
        && v.get("filters").is_none_or(valid_filters)
}
fn valid_filters(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let opt = |k: &str, choices: &[&str]| {
        o.get(k)
            .is_none_or(|x| x.as_str().is_some_and(|s| choices.contains(&s)))
    };
    let vals = |v: &Value| {
        v.as_array().is_some_and(|a| {
            a.len() <= 10
                && a.iter().all(|x| {
                    x.as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
                })
        })
    };
    opt("draft", &["only", "hide"])
        && opt(
            "review",
            &["approved", "changes-requested", "review-required", "none"],
        )
        && opt("checks", &["passing", "failing"])
        && o.get("author").is_none_or(|x| {
            x.as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
        })
        && o.get("excludedLabels").is_none_or(vals)
        && o.get("labels").is_none_or(|x| {
            x.as_array()
                .is_some_and(|a| a.len() <= 10 && a.iter().all(vals))
        })
}

fn command(executable: &str, root: &str, args: &[String]) -> Result<Value, &'static str> {
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|_| "cli-missing")?;
    let mut out = child.stdout.take().ok_or("failed")?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let r = (&mut out).take(4_194_305).read_to_end(&mut b);
        let _ = tx.send(r.map(|_| b));
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("failed");
    }
    if !status.unwrap().success() {
        return Err("failed");
    }
    let b = rx
        .recv_timeout(Duration::from_millis(200))
        .map_err(|_| "failed")?
        .map_err(|_| "failed")?;
    if b.len() > 4_194_304 {
        return Err("failed");
    }
    serde_json::from_slice(&b).map_err(|_| "failed")
}

fn checks_state(value: &Value) -> Option<&'static str> {
    let checks = value.as_array()?;
    let mut passing = false;
    let mut pending = false;
    for check in checks {
        let status = check["status"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if !status.is_empty() && status != "COMPLETED" {
            pending = true;
            continue;
        }
        match check["conclusion"]
            .as_str()
            .or_else(|| check["state"].as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase()
            .as_str()
        {
            "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE" | "CANCELLED" => {
                return Some("failing")
            }
            "PENDING" | "EXPECTED" | "ACTION_REQUIRED" => pending = true,
            "SUCCESS" => passing = true,
            _ => {}
        }
    }
    if pending {
        Some("pending")
    } else if passing {
        Some("passing")
    } else {
        None
    }
}

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh")
}
fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let cursors = input.get("cursors").and_then(Value::as_object);
    let pattern = regex::Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2}))\|([0-9]{1,9})\|([0-9]{1,9}(?:,[0-9]{1,9})*)?(?:\|([A-Za-z0-9_.:~+-]{1,128}))?$").unwrap();
    if cursors.is_some_and(|c| {
        c.values()
            .any(|v| !v.as_str().is_some_and(|s| pattern.is_match(s)))
    }) {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"list","detail":"The list could not be carried on from where it left off."}),
        );
    }
    let selected: Option<HashSet<&str>> = input
        .get("projectIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect());
    let mut hosts: BTreeMap<String, Vec<(String, String, String, String)>> = BTreeMap::new();
    let mut gitlab_hosts: BTreeMap<String, Vec<(String, String, String, String)>> = BTreeMap::new();
    let mut seen = HashSet::new();
    for (id, title, root) in projects {
        if input
            .get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|p| p != id)
            || selected
                .as_ref()
                .is_some_and(|ids| !ids.contains(id.as_str()))
        {
            continue;
        }
        let Some(identity) = crate::repository_identity::resolve(&root) else {
            continue;
        };
        let Some(key) = identity["canonicalKey"].as_str() else {
            continue;
        };
        let Some((host, repo)) = key.split_once('/') else {
            continue;
        };
        if input
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|h| !h.trim().eq_ignore_ascii_case(host))
            || !seen.insert(key.to_lowercase())
        {
            continue;
        }
        let kind = identity["provider"].as_str().unwrap_or("");
        let target = match kind {
            "github" => &mut hosts,
            "gitlab" => &mut gitlab_hosts,
            _ => continue,
        };
        target.entry(host.to_owned()).or_default().push((
            id,
            title,
            root,
            identity["displayName"].as_str().unwrap_or(repo).to_owned(),
        ));
    }
    let mut viewers = json!({});
    let mut providers = Vec::new();
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    let mut truncated = false;
    let mut next_cursors = serde_json::Map::new();
    for (host, group) in hosts {
        let args = vec![
            "api".into(),
            "--hostname".into(),
            host.clone(),
            "user".into(),
        ];
        let viewer = command(exe, &group[0].2, &args)
            .ok()
            .and_then(|v| v["login"].as_str().map(str::to_owned));
        if let Some(ref login) = viewer {
            viewers[&host] = json!(login);
        }
        providers.push(json!({"host":host,"kind":"github","searchesOnHost":true,"actions":["merge","ready","draft","close","reopen","delete-branch","update-branch","enable-auto-merge","disable-auto-merge","revert","approve-workflows"],"projectCount":group.len(),"projectIds":Value::Null,"configured":viewer.is_some(),"detail":if viewer.is_some(){Value::Null}else{json!("The signed-in account could not be verified.")}}));
        for (id, title, root, repo) in group {
            let Some(ref viewer) = viewer else {
                errors.push(json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be read.")}));
                continue;
            };
            let key = format!("{} {}", host, repo.to_lowercase());
            let cursor = match cursors {
                Some(c) => match c.get(&key).and_then(Value::as_str) {
                    Some(raw) => pattern.captures(raw),
                    None => continue,
                },
                None => None,
            };
            let boundary = cursor.as_ref().map(|c| c[1].to_owned());
            let delivered = cursor
                .as_ref()
                .and_then(|c| c[2].parse::<u64>().ok())
                .unwrap_or(0);
            let seen_at: Vec<u64> = cursor
                .as_ref()
                .and_then(|c| c.get(3))
                .map(|m| {
                    m.as_str()
                        .split(',')
                        .filter_map(|n| n.parse().ok())
                        .collect()
                })
                .unwrap_or_default();
            let state = input["state"].as_str().unwrap();
            let mut search = vec!["sort:updated-desc".to_string()];
            if let Some(ref b) = boundary {
                search.push(format!("updated:<={b}"));
            }
            if state == "merged" {
                search.push("is:merged".to_string());
            }
            match input.get("involvement").and_then(Value::as_str) {
                Some("authored") => search.push(format!("author:{viewer}")),
                Some("reviewing") => search.push(format!("review-requested:{viewer}")),
                _ => {}
            }
            if let Some(q) = input.get("query").and_then(Value::as_str) {
                search.push(q.to_owned());
            }
            let f = &input["filters"];
            if let Some(d) = f["draft"].as_str() {
                search.push(format!(
                    "draft:{}",
                    if d == "only" { "true" } else { "false" }
                ));
            }
            if let Some(r) = f["review"].as_str() {
                search.push(format!(
                    "review:{}",
                    match r {
                        "changes-requested" => "changes_requested",
                        "review-required" => "required",
                        x => x,
                    }
                ));
            }
            if let Some(c) = f["checks"].as_str() {
                search.push(format!(
                    "status:{}",
                    if c == "passing" { "success" } else { "failure" }
                ));
            }
            if let Some(a) = f["author"].as_str() {
                search.push(format!("author:{}", if a == "@me" { viewer } else { a }));
            }
            if let Some(groups) = f["labels"].as_array() {
                for group in groups {
                    let labels: Vec<_> = group
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .collect();
                    if !labels.is_empty() {
                        search.push(format!("label:{}", labels.join(",")));
                    }
                }
            }
            if let Some(labels) = f["excludedLabels"].as_array() {
                for label in labels {
                    search.push(format!("-label:{}", label.as_str().unwrap()));
                }
            }
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(99);
            let mut args=vec!["pr".into(),"list".into(),"--repo".into(),format!("{host}/{repo}"),"--state".into(),if state=="merged" {"merged".into()} else {state.into()},"--limit".into(),(limit as usize + seen_at.len() + 1).min(1000).to_string(),"--json".into(),"number,title,url,author,headRefName,baseRefName,state,isDraft,mergeable,createdAt,updatedAt,labels,reviewDecision,reviewRequests,statusCheckRollup".into()];
            if !search.is_empty() {
                args.extend(["--search".into(), search.join(" ")]);
            }
            let Ok(data) = command(exe, &root, &args) else {
                errors.push(json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be read.")}));
                continue;
            };
            let Some(items) = data.as_array() else {
                errors.push(json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be read.")}));
                continue;
            };
            let observed_at = chrono::Utc::now().timestamp_millis();
            let remaining: Vec<_> = items
                .iter()
                .filter(|p| {
                    !(boundary.as_deref() == p["updatedAt"].as_str()
                        && p["number"].as_u64().is_some_and(|n| seen_at.contains(&n)))
                })
                .collect();
            // gh's search endpoint cannot return more than 1,000 matches. If all of
            // those rows were already delivered at this timestamp, declaring the
            // listing complete would silently hide any further rows at that instant.
            if items.len() >= 1000 && remaining.is_empty() {
                errors.push(json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be fully paginated because too many pull requests share the same update time.")}));
                continue;
            }
            let page: Vec<_> = remaining.iter().take(limit as usize).copied().collect();
            let has_more = remaining.len() > limit as usize
                || (items.len() >= (limit as usize + seen_at.len() + 1).min(1000)
                    && remaining.len() >= limit as usize);
            truncated |= has_more;
            if has_more {
                if let Some(oldest) = page.iter().filter_map(|p| p["updatedAt"].as_str()).min() {
                    let mut seen = Vec::new();
                    if boundary.as_deref() == Some(oldest) {
                        for &number in &seen_at {
                            if !seen.contains(&number) {
                                seen.push(number);
                            }
                        }
                    }
                    for number in page
                        .iter()
                        .filter(|p| p["updatedAt"].as_str() == Some(oldest))
                        .filter_map(|p| p["number"].as_u64())
                    {
                        if !seen.contains(&number) {
                            seen.push(number);
                        }
                    }
                    let next = format!(
                        "{}|{}|{}",
                        oldest,
                        delivered + page.len() as u64,
                        seen.iter()
                            .map(u64::to_string)
                            .collect::<Vec<_>>()
                            .join(",")
                    );
                    if next.len() <= 4096 {
                        next_cursors.insert(key, json!(next));
                    } else {
                        errors.push(json!({"projectId":id,"projectTitle":title,"message":format!("{repo} could not be fully paginated because too many pull requests share the same update time.")}));
                    }
                }
            }
            for p in page {
                let author=p["author"]["login"].as_str().map(|login| json!({"login":login,"name":p["author"].get("name").cloned().unwrap_or(Value::Null),"avatarUrl":p["author"].get("avatarUrl").cloned().unwrap_or(Value::Null)})).unwrap_or(Value::Null);
                let labels=p["labels"].as_array().map(|ls| ls.iter().filter_map(|l| l["name"].as_str().map(|n| json!({"name":n,"color":l.get("color").cloned().unwrap_or(Value::Null),"description":l.get("description").cloned().unwrap_or(Value::Null)}))).collect::<Vec<_>>()).unwrap_or_default();
                let requested = p["reviewRequests"].as_array().is_some_and(|a| {
                    a.iter().any(|r| {
                        r["login"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case(viewer))
                    })
                });
                let mut entry = json!({"provider":"github","host":host,"projectId":id,"projectTitle":title,"repository":repo,"number":p["number"],"title":p["title"],"url":p["url"],"author":author,"headBranch":p["headRefName"],"baseBranch":p["baseRefName"],"state":p["state"].as_str().unwrap_or("OPEN").to_lowercase(),"isDraft":p["isDraft"],"mergeability":match p["mergeable"].as_str(){Some("MERGEABLE")=>"mergeable",Some("CONFLICTING")=>"conflicting",_=>"unknown"},"additions":0,"deletions":0,"createdAt":p["createdAt"],"updatedAt":p["updatedAt"],"viewerReviewRequested":requested,"labels":labels});
                entry["observedAt"] = json!(observed_at);
                if let Some(checks) = checks_state(&p["statusCheckRollup"]) {
                    entry["checksState"] = json!(checks);
                }
                if let Some(review) = p["reviewDecision"].as_str().filter(|s| !s.is_empty()) {
                    entry["reviewDecision"] = json!(review.to_lowercase().replace('_', "-"));
                }
                entries.push(entry);
            }
        }
    }
    crate::gitlab_pull_request_list::read_hosts(
        gitlab_hosts,
        input,
        crate::gitlab_pull_request_list::ListOutput {
            viewers: &mut viewers,
            providers: &mut providers,
            entries: &mut entries,
            errors: &mut errors,
            truncated: &mut truncated,
            next: &mut next_cursors,
        },
    );
    entries.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    Ok(
        json!({"viewers":viewers,"providers":providers,"entries":entries,"errors":errors,"truncated":truncated,"nextCursors":next_cursors}),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn validates_and_lists_using_fake_cli() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("t3-pr-list-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/Owner/Repo.git"
            ])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        let gh = root.join("gh");
        std::fs::write(&gh, r##"#!/bin/sh
if [ "$1" = api ]; then printf '%s' '{"login":"alice"}'; else printf '%s' '[{"number":7,"title":"Fix","url":"https://github.com/Owner/Repo/pull/7","author":{"login":"bob"},"headRefName":"fix","baseRefName":"main","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","createdAt":"2025-01-01T00:00:00Z","updatedAt":"2025-01-02T00:00:00Z","labels":[],"reviewRequests":[{"login":"alice"}],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}]'; fi
"##).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![(
            "p".into(),
            "Project".into(),
            root.to_string_lossy().into_owned(),
        )];
        let input = json!({"state":"open"});
        assert!(valid(&input));
        let result = read_with(projects, &input, gh.to_str().unwrap()).unwrap();
        assert_eq!(result["viewers"]["github.com"], "alice");
        assert_eq!(result["providers"][0].get("projectIds"), Some(&Value::Null));
        assert_eq!(result["entries"][0]["checksState"], "passing");
        assert_eq!(
            checks_state(&json!([{"state":"SUCCESS"}, {"state":"FAILURE"}])),
            Some("failing")
        );
        assert_eq!(
            checks_state(&json!([{"status":"IN_PROGRESS"}])),
            Some("pending")
        );
        assert_eq!(checks_state(&json!([])), None);
        assert_eq!(result["entries"][0]["number"], 7);
        assert_eq!(result["entries"][0]["viewerReviewRequested"], true);
        assert_eq!(result["entries"][0]["mergeability"], "mergeable");
        std::fs::write(&gh, r##"#!/bin/sh
if [ "$1" = api ]; then printf '%s' '{"login":"alice"}'; else printf '%s' '[{"number":9,"title":"A","updatedAt":"2025-01-02T00:00:00Z"},{"number":7,"title":"B","updatedAt":"2025-01-02T00:00:00Z"},{"number":5,"title":"C","updatedAt":"2025-01-02T00:00:00Z"}]'; fi
"##).unwrap();
        let projects = vec![(
            "p".into(),
            "Project".into(),
            root.to_string_lossy().into_owned(),
        )];
        let first = read_with(
            projects.clone(),
            &json!({"state":"open","limit":1}),
            gh.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(first["entries"][0]["number"], 9);
        assert_eq!(
            first["nextCursors"]["github.com owner/repo"],
            "2025-01-02T00:00:00Z|1|9"
        );
        let second = read_with(
            projects,
            &json!({"state":"open","limit":1,"cursors":first["nextCursors"]}),
            gh.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(second["entries"][0]["number"], 7);
        assert_eq!(
            second["nextCursors"]["github.com owner/repo"],
            "2025-01-02T00:00:00Z|2|9,7"
        );
        let third = read_with(
            vec![(
                "p".into(),
                "Project".into(),
                root.to_string_lossy().into_owned(),
            )],
            &json!({"state":"open","limit":1,"cursors":second["nextCursors"]}),
            gh.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(third["entries"][0]["number"], 5);
        assert_eq!(third["truncated"], false);
        assert_eq!(third["nextCursors"], json!({}));
        assert!(!valid(&json!({"state":"invalid"})));
        assert!(!valid(&json!({"state":"all","limit":0})));
        assert!(read_with(
            vec![],
            &json!({"state":"all","cursors":{"a":"bad"}}),
            gh.to_str().unwrap()
        )
        .is_err());
        let rows: Vec<_> = (1..=1000)
            .map(|number| json!({"number":number,"updatedAt":"2025-01-02T00:00:00Z"}))
            .collect();
        std::fs::write(root.join("rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
        std::fs::write(&gh, "#!/bin/sh\nif [ \"$1\" = api ]; then printf '%s' '{\"login\":\"alice\"}'; else cat rows.json; fi\n").unwrap();
        let seen = (1..=1000)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let stalled = read_with(
            vec![("p".into(), "Project".into(), root.to_string_lossy().into_owned())],
            &json!({"state":"open","limit":1,"cursors":{"github.com owner/repo":format!("2025-01-02T00:00:00Z|1000|{seen}")}}),
            gh.to_str().unwrap(),
        ).unwrap();
        assert!(stalled["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("could not be fully paginated"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
