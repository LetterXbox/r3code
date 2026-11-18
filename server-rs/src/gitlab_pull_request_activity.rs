//! GitLab merge request activity through glab REST reads.
use crate::github_pinned_credential::{self, CommandFailure};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    process::Command,
    time::Duration,
};

pub(crate) fn read(
    project: &(String, String, String, Option<Value>),
    input: &Value,
) -> Result<Value, Value> {
    read_with(project, input, "glab")
}

fn read_with(
    project: &(String, String, String, Option<Value>),
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    if input.get("expectedAccountId").is_some() {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."}),
        );
    }
    let identity = project.3.as_ref().unwrap();
    let repo = identity["displayName"].as_str().unwrap();
    let host = identity["canonicalKey"]
        .as_str()
        .unwrap()
        .split_once('/')
        .unwrap()
        .0;
    let encoded: String = repo
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let base = format!(
        "projects/{encoded}/merge_requests/{}",
        input["number"].as_u64().unwrap()
    );
    let call = |path: &str| -> Result<Option<Value>, Value> {
        let mut cmd = Command::new(exe);
        cmd.args(["api", path])
            .current_dir(&project.2)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        match github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10)) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(CommandFailure::Spawn(std::io::ErrorKind::NotFound)) => Err(
                json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"gitlab"}),
            ),
            Err(CommandFailure::Unauthenticated) => Err(
                json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"gitlab","requirement":"GitLab CLI is not authenticated. Run `glab auth login` and retry."}),
            ),
            Err(CommandFailure::RateLimited) => Err(
                json!({"_tag":"PullRequestOperationError","operation":"activity","detail":"GitLab API rate limit exceeded."}),
            ),
            Err(_) => Ok(None),
        }
    };
    // GraphQL supplies reaction actors, actual text edits and bot metadata in one paginated read.
    let mut awards = Awards::default();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut cmd = Command::new(exe);
        cmd.args([
            "api",
            "graphql",
            "-f",
            &format!("query={AWARDS_QUERY}"),
            "-f",
            &format!("fullPath={repo}"),
            "-f",
            &format!("iid={}", input["number"]),
        ]);
        if let Some(c) = &cursor {
            cmd.args(["-f", &format!("cursor={c}")]);
        }
        cmd.current_dir(&project.2)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        let data = match github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
        {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
            Err(CommandFailure::Spawn(std::io::ErrorKind::NotFound)) => {
                return Err(
                    json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"gitlab"}),
                )
            }
            Err(CommandFailure::Unauthenticated) => {
                return Err(
                    json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"gitlab","requirement":"GitLab CLI is not authenticated. Run `glab auth login` and retry."}),
                )
            }
            Err(CommandFailure::RateLimited) => {
                return Err(
                    json!({"_tag":"PullRequestOperationError","operation":"activity","detail":"GitLab API rate limit exceeded."}),
                )
            }
            Err(_) => None,
        };
        let Some(data) = data else {
            // Upstream recovers a failed paginated awards read as one empty
            // result, rather than exposing a partial set of reactions.
            awards = Awards::default();
            break;
        };
        cursor = awards.add_page(&data);
        if cursor.is_none() {
            break;
        }
    }
    let mut comments = Vec::new();
    let mut threads = Vec::new();
    let mut overview = Vec::new();
    let mut truncated = false;
    let detail = call(&base)?;
    let url = detail.as_ref().and_then(|v| v["web_url"].as_str());
    for endpoint in ["notes", "discussions"] {
        let comments_before_discussions = if endpoint == "discussions" {
            Some(comments.clone())
        } else {
            None
        };
        for page in 1..=10 {
            let suffix = if endpoint == "notes" {
                "&order_by=created_at&sort=asc"
            } else {
                ""
            };
            let path = format!("{base}/{endpoint}?per_page=100&page={page}{suffix}");
            let data = call(&path)?;
            let Some(rows) = data.as_ref().and_then(Value::as_array) else {
                // A failed continuation rejects the whole provider read. The
                // upstream activity service then replaces that read with an
                // empty, truncated result.
                if endpoint == "notes" {
                    comments.clear();
                } else {
                    comments = comments_before_discussions.clone().unwrap_or_default();
                    threads.clear();
                    overview.clear();
                }
                truncated = true;
                break;
            };
            if endpoint == "notes" {
                for n in rows {
                    if let Some(c) = note(n, url, false) {
                        comments.push(c);
                    }
                }
            } else {
                for d in rows {
                    let Some(id) = d["id"].as_str() else { continue };
                    let notes: Vec<_> = d["notes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|n| n["system"] != true)
                        .collect();
                    let Some(root) = notes.first() else { continue };
                    let pos = &root["position"];
                    let (path, line, side) = match pos["position_type"].as_str() {
                        Some("text") => {
                            let right = pos["new_line"].as_i64().is_some();
                            (
                                if right {
                                    pos["new_path"].as_str()
                                } else {
                                    pos["old_path"].as_str()
                                },
                                if right {
                                    pos["new_line"].as_i64()
                                } else {
                                    pos["old_line"].as_i64()
                                },
                                if right { "right" } else { "left" },
                            )
                        }
                        Some("file" | "image") => (
                            pos["new_path"]
                                .as_str()
                                .or_else(|| pos["old_path"].as_str()),
                            None,
                            "right",
                        ),
                        _ if pos.is_null() && root["resolvable"] == true => (None, None, "right"),
                        _ => continue,
                    };
                    if !pos.is_null() && path.is_none_or(|p| p.trim().is_empty()) {
                        continue;
                    }
                    let cs: Vec<_> = notes.iter().filter_map(|n| note(n, url, true)).collect();
                    let refs = &detail.as_ref().unwrap_or(&Value::Null)["diff_refs"];
                    let outdated = ["base_sha", "start_sha", "head_sha"]
                        .iter()
                        .all(|k| pos[*k].is_string() && refs[*k].is_string())
                        && ["base_sha", "start_sha", "head_sha"]
                            .iter()
                            .any(|k| pos[*k] != refs[*k]);
                    let thread = json!({"id":id,"path":path,"line":line.filter(|n| *n>0),"side":side,"isResolved":root["resolved"]==true,"isOutdated":outdated,"comments":cs});
                    if path.is_some() {
                        threads.push(thread)
                    } else {
                        if root["resolved"] != true {
                            if let Some(id) = id_string(&root["id"]) {
                                for c in &mut comments {
                                    if c["id"] == id {
                                        c["kind"] = json!("review-comment");
                                    }
                                }
                            }
                        }
                        overview.push(thread);
                    }
                }
            }
            if rows.len() < 100 {
                break;
            }
            if page == 10 {
                truncated = true
            }
        }
    }
    let mut commits = Vec::new();
    if let Some(rows) = call(&format!("{base}/commits?per_page=100&with_stats=true"))?
        .and_then(|v| v.as_array().cloned())
    {
        for c in rows.iter().rev() {
            let (Some(id), Some(date)) = (
                c["id"].as_str(),
                c["committed_date"]
                    .as_str()
                    .or_else(|| c["created_at"].as_str()),
            ) else {
                continue;
            };
            let name = c["author_name"].as_str().filter(|s| !s.trim().is_empty());
            let login =
                name.or_else(|| c["author_email"].as_str().filter(|s| !s.trim().is_empty()));
            let authors = login
                .map(|l| vec![json!({"login":l,"name":name,"avatarUrl":null})])
                .unwrap_or_default();
            let mut commit = json!({"oid":id,"messageHeadline":c["title"].as_str().unwrap_or(""),"committedDate":date,"authors":authors});
            if c["stats"].is_object() {
                commit["additions"] = json!(c["stats"]["additions"].as_i64().unwrap_or(0).max(0));
                commit["deletions"] = json!(c["stats"]["deletions"].as_i64().unwrap_or(0).max(0));
            }
            commits.push(commit);
        }
    }
    for c in &mut comments {
        awards.enrich(c);
    }
    for t in threads.iter_mut().chain(overview.iter_mut()) {
        if let Some(cs) = t["comments"].as_array_mut() {
            for c in cs {
                awards.enrich(c);
            }
        }
    }
    Ok(
        json!({"comments":comments,"commentCount":comments.len(),"commentsTruncated":truncated,"reviewThreads":threads,"overviewThreads":overview,"commits":commits,"reactions":awards.reactions}),
    )
}
const AWARDS_QUERY: &str = "query($fullPath: ID!, $iid: String!, $cursor: String) { currentUser { username } project(fullPath: $fullPath) { mergeRequest(iid: $iid) { awardEmoji { nodes { name user { username } } } notes(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id author { username bot } lastEditedAt lastEditedBy { username } resolved awardEmoji { nodes { name user { username } } } } } } } }";

#[derive(Default)]
struct Awards {
    reactions: Vec<Value>,
    by_note: HashMap<String, Vec<Value>>,
    edits: HashMap<String, String>,
    bots: HashSet<String>,
}
impl Awards {
    fn add_page(&mut self, data: &Value) -> Option<String> {
        let viewer = data["data"]["currentUser"]["username"].as_str();
        let mr = &data["data"]["project"]["mergeRequest"];
        if self.reactions.is_empty() {
            self.reactions = reactions(&mr["awardEmoji"], viewer);
        }
        for n in mr["notes"]["nodes"].as_array().into_iter().flatten() {
            if n["author"]["bot"] == true {
                if let Some(login) = n["author"]["username"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                {
                    self.bots.insert(login.trim().to_owned());
                }
            }
            let Some(id) = n["id"]
                .as_str()
                .and_then(|s| s.rsplit('/').next())
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            else {
                continue;
            };
            let rs = reactions(&n["awardEmoji"], viewer);
            if !rs.is_empty() {
                self.by_note.insert(id.to_owned(), rs);
            }
            if n["resolved"] != true
                && n["lastEditedBy"]["username"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
            {
                if let Some(date) = n["lastEditedAt"].as_str().filter(|s| !s.trim().is_empty()) {
                    self.edits.insert(id.to_owned(), date.trim().to_owned());
                }
            }
        }
        let page = &mr["notes"]["pageInfo"];
        if page["hasNextPage"] == true {
            page["endCursor"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        } else {
            None
        }
    }
    fn enrich(&self, c: &mut Value) {
        if let Some(id) = c["id"].as_str().map(str::to_owned) {
            if let Some(r) = self.by_note.get(&id) {
                c["reactions"] = json!(r);
            }
            if let Some(date) = self.edits.get(&id) {
                c["editedAt"] = json!(date);
            }
        }
        if c["author"]["login"]
            .as_str()
            .is_some_and(|s| self.bots.contains(s))
        {
            c["author"]["isBot"] = json!(true);
        }
    }
}
fn reactions(award: &Value, viewer: Option<&str>) -> Vec<Value> {
    let mut groups: Vec<(&str, usize, Vec<String>, bool)> = Vec::new();
    for n in award["nodes"].as_array().into_iter().flatten() {
        let content = match n["name"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase()
            .as_str()
        {
            "thumbsup" => "thumbs-up",
            "thumbsdown" => "thumbs-down",
            "laughing" => "laugh",
            "tada" => "hooray",
            "confused" => "confused",
            "heart" => "heart",
            "rocket" => "rocket",
            "eyes" => "eyes",
            _ => continue,
        };
        let Some(user) = n["user"]["username"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let index = groups
            .iter()
            .position(|g| g.0 == content)
            .unwrap_or_else(|| {
                groups.push((content, 0, vec![], false));
                groups.len() - 1
            });
        let g = &mut groups[index];
        g.1 += 1;
        if viewer.is_some_and(|v| v.trim().eq_ignore_ascii_case(user)) {
            g.3 = true;
        } else {
            g.2.push(user.to_owned());
        }
    }
    groups.into_iter().map(|(content,count,actors,viewer)| json!({"content":content,"count":count,"actors":actors,"viewerHasReacted":viewer})).collect()
}
fn id_string(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|n| n.to_string()))
}
fn note(n: &Value, url: Option<&str>, thread: bool) -> Option<Value> {
    if n["system"] == true {
        return None;
    }
    let id = id_string(&n["id"])?;
    let date = n["created_at"].as_str()?;
    let body = n["body"].as_str().unwrap_or("");
    if !thread && body.trim().is_empty() {
        return None;
    }
    let author=n["author"]["username"].as_str().filter(|s| !s.trim().is_empty()).map(|login|json!({"login":login,"name":n["author"]["name"],"avatarUrl":n["author"]["avatar_url"]}));
    let mut out = json!({"id":id,"author":author,"body":body,"createdAt":date,"url":url.map(|u|format!("{u}#note_{id}")),"reactions":[]});
    if !thread {
        out["kind"] = json!(if n["type"] == "DiffNote" {
            "review-comment"
        } else {
            "issue-comment"
        });
        out["path"] = n["position"]["new_path"]
            .as_str()
            .or_else(|| n["position"]["old_path"].as_str())
            .map_or(Value::Null, |s| json!(s));
        out["reviewState"] = Value::Null;
    }
    out.into()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graphql_awards_enrich_comments_and_skip_resolved_edits() {
        let mut awards = Awards::default();
        let page = json!({"data":{"currentUser":{"username":"Me"},"project":{"mergeRequest":{
            "awardEmoji":{"nodes":[{"name":"thumbsup","user":{"username":"me"}},{"name":"thumbsup","user":{"username":"alice"}}]},
            "notes":{"pageInfo":{"hasNextPage":true,"endCursor":"next"},"nodes":[
                {"id":"gid://gitlab/Note/42","author":{"username":"robot","bot":true},"lastEditedAt":"2026-01-02","lastEditedBy":{"username":"robot"},"resolved":false,"awardEmoji":{"nodes":[{"name":"heart","user":{"username":"alice"}}]}},
                {"id":"gid://gitlab/Note/43","lastEditedAt":"2026-01-02","lastEditedBy":{"username":"alice"},"resolved":true}
            ]}
        }}}});
        assert_eq!(awards.add_page(&page).as_deref(), Some("next"));
        assert_eq!(
            awards.reactions[0],
            json!({"content":"thumbs-up","count":2,"actors":["alice"],"viewerHasReacted":true})
        );
        let mut c = json!({"id":"42","author":{"login":"robot"},"reactions":[]});
        awards.enrich(&mut c);
        assert_eq!(c["author"]["isBot"], true);
        assert_eq!(c["editedAt"], "2026-01-02");
        assert_eq!(c["reactions"][0]["content"], "heart");
        assert!(!awards.edits.contains_key("43"));
    }
    #[test]
    fn note_mapping() {
        let n = json!({"id":42,"body":"Hi","created_at":"2026-01-01","type":"DiffNote","author":{"username":"alice"},"position":{"new_path":"a"}});
        let c = note(&n, Some("https://gitlab/x"), false).unwrap();
        assert_eq!(c["id"], "42");
        assert_eq!(c["url"], "https://gitlab/x#note_42");
        assert_eq!(c["kind"], "review-comment");
        assert_eq!(c["path"], "a");
    }
    #[cfg(unix)]
    #[test]
    fn failed_continuations_discard_partial_notes_and_discussions() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("t3-gitlab-activity-pages-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let note =
            json!({"id":42,"body":"text","created_at":"2026-01-01","author":{"username":"alice"}});
        let discussion = json!({"id":"thread","notes":[{"id":42,"body":"text","created_at":"2026-01-01","author":{"username":"alice"},"position":{"position_type":"text","new_path":"a","new_line":1}}]});
        let notes = serde_json::to_string(&vec![note; 100]).unwrap();
        let discussions = serde_json::to_string(&vec![discussion; 100]).unwrap();
        let glab = root.join("glab");
        let script = format!("#!/bin/sh\ncase \"$*\" in\n *graphql*) printf '%s' '{{\"data\":{{}}}}' ;;\n *'notes?'*'&page=1'*) printf '%s' '{notes}' ;;\n *'discussions?'*'&page=1'*) printf '%s' '{discussions}' ;;\n *'notes?'*'&page=2'*|*'discussions?'*'&page=2'*) exit 1 ;;\n *commits*) printf '%s' '[]' ;;\n *) printf '%s' '{{\"web_url\":\"https://gitlab.com/a/b/-/merge_requests/7\"}}' ;;\nesac\n");
        std::fs::write(&glab, script).unwrap();
        std::fs::set_permissions(&glab, std::fs::Permissions::from_mode(0o755)).unwrap();
        let project = (
            "p".into(),
            "P".into(),
            root.to_string_lossy().into_owned(),
            Some(json!({"provider":"gitlab","displayName":"a/b","canonicalKey":"gitlab.com/a/b"})),
        );
        let result = read_with(&project, &json!({"number":7}), glab.to_str().unwrap()).unwrap();
        assert_eq!(result["comments"], json!([]));
        assert_eq!(result["reviewThreads"], json!([]));
        assert_eq!(result["overviewThreads"], json!([]));
        assert_eq!(result["commentsTruncated"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
}
