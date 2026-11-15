//! Repository-scoped completion options for pull request filters.
use crate::{github_pinned_credential, repository_identity};
use serde_json::{json, Value};
use std::{collections::HashSet, process::Command};

pub(crate) fn valid(input: &Value) -> bool {
    let nonempty = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
    matches!(
        input.get("kind").and_then(Value::as_str),
        Some("labels" | "authors" | "references")
    ) && ["projectId", "host"]
        .iter()
        .all(|k| input.get(k).is_none_or(nonempty))
        && input
            .get("query")
            .is_none_or(|v| nonempty(v) && v.as_str().unwrap().chars().count() <= 100)
        && input.get("projectIds").is_none_or(|v| {
            v.as_array()
                .is_some_and(|a| a.len() <= 100 && a.iter().all(nonempty))
        })
        && input
            .get("sigil")
            .is_none_or(|v| matches!(v.as_str(), Some("#" | "!")))
}

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Value {
    read_with(projects, input, "gh")
}

fn read_with(projects: Vec<(String, String, String)>, input: &Value, exe: &str) -> Value {
    let kind = input["kind"].as_str().unwrap();
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let ids = input.get("projectIds").and_then(Value::as_array);
    let mut repositories = HashSet::new();
    let mut unique = HashSet::new();
    let mut items: Vec<(usize, String, Value)> = Vec::new();
    let mut truncated = false;
    for (id, _, root) in projects {
        if input
            .get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|p| p != id)
            || ids.is_some_and(|a| !a.iter().any(|v| v.as_str() == Some(id.as_str())))
        {
            continue;
        }
        let Some(identity) = repository_identity::resolve(&root) else {
            continue;
        };
        if identity["provider"] != "github" {
            continue;
        }
        let Some((host, repo)) = identity["canonicalKey"]
            .as_str()
            .and_then(|k| k.split_once('/'))
        else {
            continue;
        };
        if input
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|h| !h.trim().eq_ignore_ascii_case(host))
            || !repositories.insert(format!("{} {}", host, repo).to_lowercase())
        {
            continue;
        }
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        let text = if query.is_empty() {
            "null".to_owned()
        } else {
            json!(query).to_string()
        };
        let (graph, fallback) = match kind {
            "labels" => (format!("query {{ repository(owner:{},name:{}) {{ labels(first:100,query:{text},orderBy:{{field:NAME,direction:ASC}}) {{ pageInfo {{ hasNextPage }} nodes {{ name color }} }} }} }}", json!(owner), json!(name)), None),
            "authors" => (format!("query {{ repository(owner:{},name:{}) {{ mentionableUsers(first:50,query:{text}) {{ pageInfo {{ hasNextPage }} nodes {{ login name avatarUrl }} }} }} }}", json!(owner), json!(name)), None),
            _ => {
                let numeric = query.parse::<i32>().ok().filter(|n| *n > 0);
                let term = if query.is_empty() || query.bytes().all(|c| c.is_ascii_digit()) { String::new() } else { format!("in:title {} ", json!(query)) };
                let search = format!("repo:{repo} {term}sort:updated-desc");
                let exact = numeric.map(|n| format!("repository(owner:{},name:{}) {{ issueOrPullRequest(number:{n}) {{ __typename ... on Issue {{ number title issueState:state }} ... on PullRequest {{ number title pullRequestState:state }} }} }}",json!(owner),json!(name))).unwrap_or_default();
                let search_query = format!("search(query:{},type:ISSUE,first:20) {{ pageInfo {{ hasNextPage }} nodes {{ __typename ... on Issue {{ number title issueState:state }} ... on PullRequest {{ number title pullRequestState:state }} }} }}",json!(search));
                (format!("query {{ {search_query} {exact} }}"), numeric.map(|_| format!("query {{ {search_query} }}")))
            }
        };
        let fetch = |query: &str| {
            let mut command = Command::new(exe);
            command.current_dir(&root).args([
                "api",
                "graphql",
                "--hostname",
                host,
                "-f",
                &format!("query={query}"),
            ]);
            github_pinned_credential::run_classified(
                &mut command,
                std::time::Duration::from_secs(10),
            )
        };
        let response = match fetch(&graph) {
            Err(github_pinned_credential::CommandFailure::NotFound) if fallback.is_some() => {
                fetch(fallback.as_deref().unwrap())
            }
            result => result,
        };
        let Some(data) = response
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        else {
            continue;
        };
        let page = match kind {
            "labels" => &data["data"]["repository"]["labels"],
            "authors" => &data["data"]["repository"]["mentionableUsers"],
            _ => &data["data"]["search"],
        };
        truncated |= page["pageInfo"]["hasNextPage"] == true;
        let mut nodes: Vec<&Value> = Vec::new();
        if kind == "references" && data["data"]["repository"]["issueOrPullRequest"].is_object() {
            nodes.push(&data["data"]["repository"]["issueOrPullRequest"]);
        }
        if let Some(array) = page["nodes"].as_array() {
            nodes.extend(array);
        }
        for node in nodes {
            let trimmed = |v: &Value| {
                v.as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            };
            let (key, texts, result) = match kind {
                "labels" => {
                    let Some(n) = trimmed(&node["name"]) else {
                        continue;
                    };
                    (
                        n.clone(),
                        vec![n.clone()],
                        json!({"name":n,"color":trimmed(&node["color"])}),
                    )
                }
                "authors" => {
                    let Some(login) = trimmed(&node["login"]) else {
                        continue;
                    };
                    let name = trimmed(&node["name"]);
                    (
                        login.clone(),
                        vec![login.clone(), name.clone().unwrap_or_default()],
                        json!({"login":login,"name":name,"avatarUrl":trimmed(&node["avatarUrl"])}),
                    )
                }
                _ => {
                    let Some(number) = node["number"].as_u64().filter(|n| *n > 0) else {
                        continue;
                    };
                    let Some(title) = node["title"].as_str() else {
                        continue;
                    };
                    let (k, state) = match node["__typename"].as_str() {
                        Some("Issue") => (
                            "issue",
                            if node["issueState"] == "OPEN" {
                                "open"
                            } else {
                                "closed"
                            },
                        ),
                        Some("PullRequest") => (
                            "change-request",
                            match node["pullRequestState"].as_str() {
                                Some("OPEN") => "open",
                                Some("MERGED") => "merged",
                                _ => "closed",
                            },
                        ),
                        _ => continue,
                    };
                    let key = format!("#{number}");
                    (
                        key.clone(),
                        vec![number.to_string(), title.to_owned()],
                        json!({"reference":key,"kind":k,"number":number,"title":title,"state":state}),
                    )
                }
            };
            if !unique.insert(key.to_lowercase()) {
                continue;
            }
            let q = query.to_lowercase();
            let texts: Vec<_> = texts.iter().map(|x| x.to_lowercase()).collect();
            let score = if q.is_empty() || texts.contains(&q) {
                0
            } else if texts.iter().any(|x| x.starts_with(&q)) {
                1
            } else if texts.iter().any(|x| x.contains(&q)) {
                2
            } else {
                continue;
            };
            items.push((score, key, result));
        }
    }
    items.sort_by(|a, b| {
        a.0.cmp(&b.0).then_with(|| {
            if kind == "references" {
                std::cmp::Ordering::Equal
            } else {
                a.1.to_lowercase().cmp(&b.1.to_lowercase())
            }
        })
    });
    truncated |= items.len() > 100;
    let results: Vec<Value> = items.into_iter().take(100).map(|(_, _, v)| v).collect();
    let empty: Vec<Value> = Vec::new();
    json!({"labels":if kind == "labels" {&results} else {&empty},"authors":if kind == "authors" {&results} else {&empty},"references":if kind == "references" {&results} else {&empty},"truncated":truncated})
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn reads_and_ranks_options_from_the_selected_repository() {
        let dir = std::env::temp_dir().join(format!("t3-pr-options-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
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
            .current_dir(&dir)
            .status()
            .unwrap()
            .success());
        let fake = dir.join("gh");
        std::fs::write(&fake, r##"#!/bin/sh
printf '%s' '{"data":{"repository":{"labels":{"pageInfo":{"hasNextPage":false},"nodes":[{"name":"feature","color":"abc"},{"name":"bug","color":"fff"}]},"mentionableUsers":{"pageInfo":{"hasNextPage":false},"nodes":[{"login":"Bob","name":"Bob Doe","avatarUrl":null}]},"issueOrPullRequest":{"__typename":"Issue","number":7,"title":"Fix","issueState":"OPEN"}},"search":{"pageInfo":{"hasNextPage":true},"nodes":[{"__typename":"Issue","number":7,"title":"Fix","issueState":"OPEN"}]}}}'
"##).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![(
            "p".into(),
            "Project".into(),
            dir.to_string_lossy().into_owned(),
        )];
        let labels = read_with(
            projects.clone(),
            &json!({"kind":"labels","query":"bug"}),
            fake.to_str().unwrap(),
        );
        assert_eq!(
            labels,
            json!({"labels":[{"name":"bug","color":"fff"}],"authors":[],"references":[],"truncated":false})
        );
        let authors = read_with(
            projects.clone(),
            &json!({"kind":"authors","query":"doe"}),
            fake.to_str().unwrap(),
        );
        assert_eq!(authors["authors"][0]["login"], "Bob");
        let references = read_with(
            projects.clone(),
            &json!({"kind":"references","query":"7"}),
            fake.to_str().unwrap(),
        );
        assert_eq!(references["references"].as_array().unwrap().len(), 1);
        assert_eq!(references["references"][0]["reference"], "#7");
        assert_eq!(references["truncated"], true);
        std::fs::write(&fake, r##"#!/bin/sh
case "$*" in *issueOrPullRequest*) printf '%s\n' 'GraphQL: Could not resolve to a Issue or PullRequest' >&2; exit 1 ;; esac
printf '%s' '{"data":{"search":{"pageInfo":{"hasNextPage":false},"nodes":[{"__typename":"Issue","number":7,"title":"Fix","issueState":"OPEN"}]}}}'
"##).unwrap();
        let retried = read_with(
            projects,
            &json!({"kind":"references","query":"7"}),
            fake.to_str().unwrap(),
        );
        assert_eq!(retried["references"][0]["reference"], "#7");
        assert!(!valid(&json!({"kind":"unknown"})));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
