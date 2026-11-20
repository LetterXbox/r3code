//! GitHub activity reads.
use crate::github_pinned_credential;
use serde_json::{json, Value};
use std::{collections::HashSet, process::Command, time::Duration};

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh").map(|mut activity| {
        if let Some(fields) = activity.as_object_mut() {
            fields.remove("watchTopLevelComplete");
        }
        activity
    })
}
pub(crate) fn read_for_watch(
    projects: Vec<(String, String, String)>,
    input: &Value,
) -> Result<Value, Value> {
    let mut activity = read_with(projects.clone(), input, "gh")?;
    hydrate_watch_tails(&mut activity, |thread_id, cursor| {
        let mut request = input.clone();
        request["threadId"] = json!(thread_id);
        request["cursor"] = json!(cursor);
        crate::pull_request_thread_comments::read(projects.clone(), &request).ok()
    });
    Ok(activity)
}

fn hydrate_watch_tails(
    activity: &mut Value,
    mut read_page: impl FnMut(&str, &str) -> Option<Value>,
) {
    if activity["commentsTruncated"] != true || activity["watchTopLevelComplete"] != true {
        return;
    }
    let Some(threads) = activity["reviewThreads"].as_array() else { return };
    let mut tails = Vec::new();
    let mut budget = 32usize;
    for thread in threads {
        let (Some(id), Some(first)) = (thread["id"].as_str(), thread["nextCommentsCursor"].as_str()) else {
            continue;
        };
        let mut cursor = first.to_owned();
        let mut seen = HashSet::new();
        loop {
            if budget == 0 || !seen.insert(cursor.clone()) {
                return;
            }
            budget -= 1;
            let Some(page) = read_page(id, &cursor) else { return };
            let Some(comments) = page["comments"].as_array() else { return };
            tails.extend(comments.iter().cloned());
            let Some(next) = page["nextCursor"].as_str() else { break };
            cursor = next.to_owned();
        }
    }
    if let Some(comments) = activity["comments"].as_array_mut() {
        comments.extend(tails);
        activity["commentsTruncated"] = json!(false);
    }
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
        return crate::gitlab_pull_request_activity::read(project, input);
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
    let mut comments = Vec::new();
    let mut commits = Vec::new();
    let mut commit_ids = Vec::new();
    let mut author = Value::Null;
    let mut viewer = None::<String>;
    let mut pr_reactions = Vec::new();
    let reaction_fields = "reactionGroups { content viewerHasReacted reactors(first:10) { totalCount nodes { ... on User { login } ... on Bot { login } ... on Organization { login } ... on Mannequin { login } } } }";
    let mut comments_cursor: Option<String> = None;
    let mut reviews_cursor: Option<String> = None;
    let mut comments_active = true;
    let mut reviews_active = true;
    let mut seen = HashSet::new();
    for page in 0..10 {
        if !comments_active && !reviews_active {
            break;
        }
        let head = if page == 0 {
            "author { login avatarUrl ... on User { name } } commits(last:100) { nodes { commit { id oid messageHeadline committedDate parents(first:1) { totalCount } authors(first:10) { nodes { name avatarUrl user { login } } } } } }"
        } else {
            ""
        };
        let comments_query = if comments_active {
            format!("comments(first:100{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ id body createdAt lastEditedAt url isMinimized author {{ login avatarUrl ... on User {{ name }} }} {reaction_fields} }} }}", comments_cursor.as_ref().map(|c| format!(",after:{}",json!(c))).unwrap_or_default())
        } else {
            String::new()
        };
        let reviews_query = if reviews_active {
            format!("reviews(first:100{}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ id body state submittedAt lastEditedAt url isMinimized author {{ login avatarUrl ... on User {{ name }} }} {reaction_fields} }} }}", reviews_cursor.as_ref().map(|c| format!(",after:{}",json!(c))).unwrap_or_default())
        } else {
            String::new()
        };
        let query = format!("query {{ viewer {{ login }} repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ {head} {reaction_fields} {comments_query} {reviews_query} }} }} }}",json!(owner),json!(name));
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
        let error = || json!({"_tag":"PullRequestOperationError","operation":"activity","detail":"The pull request activity could not be read."});
        let bytes = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
            .map_err(|e| {
                github_pinned_credential::operation_error(
                    e,
                    "activity",
                    "The pull request activity could not be read.",
                )
            })?;
        let response: Value = serde_json::from_slice(&bytes).map_err(|_| error())?;
        let pr = &response["data"]["repository"]["pullRequest"];
        if !pr.is_object() {
            return Err(error());
        }
        if page == 0 {
            author = actor(&pr["author"]);
            viewer = response["data"]["viewer"]["login"]
                .as_str()
                .map(str::to_owned);
            pr_reactions = reactions(&pr["reactionGroups"], viewer.as_deref());
            for node in pr["commits"]["nodes"].as_array().into_iter().flatten() {
                let c = &node["commit"];
                if c["oid"].as_str().is_none() || c["committedDate"].as_str().is_none() {
                    continue;
                }
                if c["parents"]["totalCount"].as_u64().unwrap_or(0) <= 1 {
                    if let Some(id) = c["id"].as_str() {
                        commit_ids.push(id.to_owned());
                    }
                }
                let authors: Vec<Value> = c["authors"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| {
                        let login = a["user"]["login"].as_str().or_else(|| a["name"].as_str())?;
                        if login.trim().is_empty() {
                            return None;
                        }
                        Some(json!({"login":login,"name":a["name"],"avatarUrl":a["avatarUrl"]}))
                    })
                    .collect();
                commits.push(json!({"oid":c["oid"],"messageHeadline":c["messageHeadline"].as_str().unwrap_or(""),"committedDate":c["committedDate"],"authors":authors}));
            }
        }
        for (key, kind, active, cursor) in [
            (
                "comments",
                "issue-comment",
                &mut comments_active,
                &mut comments_cursor,
            ),
            (
                "reviews",
                "review",
                &mut reviews_active,
                &mut reviews_cursor,
            ),
        ] {
            if !*active {
                continue;
            }
            let connection = &pr[key];
            let nodes = connection["nodes"].as_array().ok_or_else(error)?;
            for n in nodes {
                let date = if kind == "review" {
                    &n["submittedAt"]
                } else {
                    &n["createdAt"]
                };
                let state = n["state"].as_str().unwrap_or("");
                if n["isMinimized"] == true
                    || n["id"].as_str().is_none()
                    || date.as_str().is_none()
                    || (kind == "review"
                        && n["body"].as_str().unwrap_or("").trim().is_empty()
                        && !matches!(state, "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"))
                {
                    continue;
                }
                comments.push(json!({"id":n["id"],"kind":kind,"author":actor(&n["author"]),"body":n["body"].as_str().unwrap_or(""),"createdAt":date,"editedAt":n["lastEditedAt"],"url":n["url"],"path":null,"reviewState":if kind=="review" {n["state"].clone()} else {Value::Null},"reactions":reactions(&n["reactionGroups"], viewer.as_deref())}));
            }
            *active = connection["pageInfo"]["hasNextPage"] == true;
            if *active {
                let next = connection["pageInfo"]["endCursor"]
                    .as_str()
                    .ok_or_else(error)?
                    .to_owned();
                if !seen.insert((key.to_owned(), next.clone())) {
                    return Err(error());
                }
                *cursor = Some(next);
            }
        }
    }
    let mut threads = Vec::new();
    let mut reviewers = Vec::new();
    let mut thread_truncated = false;
    let mut nested_truncated = false;
    let mut missing_tail_cursor = false;
    let mut missing_comments = 0u64;
    let mut cursor: Option<String> = None;
    let mut thread_seen = HashSet::new();
    for _ in 0..10 {
        let after = cursor
            .as_ref()
            .map(|c| format!(",after:{}", json!(c)))
            .unwrap_or_default();
        let reviewer_fields = if cursor.is_none() {
            "reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { login name avatarUrl } ... on Bot { login avatarUrl } ... on Team { combinedSlug teamName:name teamAvatarUrl:avatarUrl } } } } latestReviews(first:50) { nodes { isMinimized author { __typename login avatarUrl ... on User { name } } } }"
        } else {
            ""
        };
        let query=format!("query {{ repository(owner:{},name:{}) {{ pullRequest(number:{number}) {{ {reviewer_fields} reviewThreads(first:100{after}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ id path line diffSide isResolved isOutdated comments(first:10) {{ totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ id body createdAt lastEditedAt url isMinimized author {{ __typename login avatarUrl }} pullRequestReview {{ url }} {reaction_fields} }} }} }} }} }} }} }}",json!(owner),json!(name));
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
        let page = github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let Some(page) = page else {
            thread_truncated = true;
            break;
        };
        let conn = &page["data"]["repository"]["pullRequest"]["reviewThreads"];
        let Some(nodes) = conn["nodes"].as_array() else {
            thread_truncated = true;
            break;
        };
        if cursor.is_none() {
            let pr = &page["data"]["repository"]["pullRequest"];
            let requested = pr["reviewRequests"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|n| &n["requestedReviewer"]);
            let reviewed = pr["latestReviews"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|n| n["isMinimized"] != true)
                .map(|n| &n["author"]);
            let mut seen_reviewers = HashSet::new();
            for raw in requested.chain(reviewed) {
                let mut mapped = actor(raw);
                if mapped.is_null() {
                    if let Some(login) = raw["combinedSlug"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        mapped = json!({"login":login,"name":raw["teamName"],"avatarUrl":raw["teamAvatarUrl"]});
                    }
                }
                if let Some(login) = mapped["login"].as_str() {
                    if seen_reviewers.insert(login.to_owned()) {
                        reviewers.push(mapped);
                    }
                }
            }
        }
        for t in nodes {
            if t["id"].as_str().is_none() || t["path"].as_str().is_none() {
                continue;
            }
            let mut thread_comments = Vec::new();
            for c in t["comments"]["nodes"].as_array().into_iter().flatten() {
                if c["isMinimized"] == true
                    || c["id"].as_str().is_none()
                    || c["createdAt"].as_str().is_none()
                {
                    continue;
                }
                let mut inline_author = actor(&c["author"]);
                if inline_author.is_object() {
                    inline_author["name"] = Value::Null;
                }
                let mut tc = json!({"id":c["id"],"author":inline_author,"body":c["body"].as_str().unwrap_or(""),"createdAt":c["createdAt"],"editedAt":c["lastEditedAt"],"url":c["url"],"reactions":reactions(&c["reactionGroups"], viewer.as_deref())});
                if let Some(url) = c["pullRequestReview"]["url"].as_str().map(str::trim).filter(|url| !url.is_empty()) {
                    tc["reviewUrl"] = json!(url);
                }
                comments.push(json!({"id":c["id"],"kind":"review-comment","author":tc["author"],"body":tc["body"],"createdAt":tc["createdAt"],"editedAt":tc["editedAt"],"url":tc["url"],"path":t["path"],"reviewState":null,"reactions":tc["reactions"]}));
                thread_comments.push(tc);
            }
            if thread_comments.is_empty() && t["comments"]["pageInfo"]["hasNextPage"] != true {
                continue;
            }
            let mut thread = json!({"id":t["id"],"path":t["path"],"line":t["line"],"side":if t["diffSide"]=="LEFT" {"left"} else {"right"},"isResolved":t["isResolved"],"isOutdated":t["isOutdated"],"comments":thread_comments,"commentCount":t["comments"]["totalCount"]});
            if t["comments"]["pageInfo"]["hasNextPage"] == true {
                nested_truncated = true;
                missing_comments +=
                    t["comments"]["totalCount"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_sub(
                            t["comments"]["nodes"].as_array().map_or(0, |n| n.len()) as u64
                        );
                if let Some(c) = t["comments"]["pageInfo"]["endCursor"].as_str() {
                    thread["nextCommentsCursor"] = json!(c);
                } else {
                    missing_tail_cursor = true;
                }
            }
            threads.push(thread);
        }
        if conn["pageInfo"]["hasNextPage"] != true {
            break;
        }
        let Some(next) = conn["pageInfo"]["endCursor"].as_str() else {
            thread_truncated = true;
            break;
        };
        if !thread_seen.insert(next.to_owned()) {
            thread_truncated = true;
            break;
        }
        cursor = Some(next.to_owned());
        if thread_seen.len() == 10 {
            thread_truncated = true;
        }
    }
    if !commit_ids.is_empty() {
        let query = format!("query PullRequestCommitStats {{ nodes(ids:{}) {{ ... on Commit {{ oid additions deletions }} }} }}", json!(commit_ids));
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
        if let Some(stats) =
            github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            for entry in stats["data"]["nodes"].as_array().into_iter().flatten() {
                for commit in &mut commits {
                    if entry["oid"].is_string() && entry["oid"] == commit["oid"] {
                        if let (Some(a), Some(d)) =
                            (entry["additions"].as_u64(), entry["deletions"].as_u64())
                        {
                            commit["additions"] = json!(a);
                            commit["deletions"] = json!(d);
                        }
                    }
                }
            }
        }
    }
    comments.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
    Ok(
        json!({"author":author,"viewer":viewer,"comments":comments,"commentCount":comments.len() as u64 + missing_comments,"commentsTruncated":thread_truncated || nested_truncated || comments_active || reviews_active,"reviewThreadsTruncated":thread_truncated,"watchTopLevelComplete":!(thread_truncated || missing_tail_cursor || comments_active || reviews_active),"reviewThreads":threads,"commits":commits,"reactions":pr_reactions,"reviewers":reviewers}),
    )
}
pub(crate) fn reactions(groups: &Value, viewer: Option<&str>) -> Vec<Value> {
    groups.as_array().into_iter().flatten().filter_map(|group| {
        let content = match group["content"].as_str()? {
            "THUMBS_UP" => "thumbs-up", "THUMBS_DOWN" => "thumbs-down",
            "LAUGH" => "laugh", "HOORAY" => "hooray", "CONFUSED" => "confused",
            "HEART" => "heart", "ROCKET" => "rocket", "EYES" => "eyes", _ => return None,
        };
        let logins: Vec<&str> = group["reactors"]["nodes"].as_array().into_iter().flatten()
            .filter_map(|n| n["login"].as_str().map(str::trim).filter(|s| !s.is_empty())).collect();
        let count = group["reactors"]["totalCount"].as_u64().unwrap_or(0).max(logins.len() as u64);
        if count == 0 { return None; }
        let actors: Vec<&str> = logins.into_iter().filter(|login| !viewer.is_some_and(|v| v.eq_ignore_ascii_case(login))).collect();
        Some(json!({"content":content,"count":count,"actors":actors,"viewerHasReacted":group["viewerHasReacted"].as_bool().unwrap_or(false)}))
    }).collect()
}
pub(crate) fn actor(value: &Value) -> Value {
    let clean = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    match clean(&value["login"]) {
        Some(login) => {
            let mut result = json!({"login":login,"name":clean(&value["name"]),"avatarUrl":clean(&value["avatarUrl"])});
            if value["__typename"] == "Bot" {
                result["isBot"] = json!(true);
            }
            result
        }
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_tails_only_publish_after_all_pages_arrive() {
        let initial = json!({
            "commentsTruncated":true,"watchTopLevelComplete":true,
            "comments":[{"id":"first"}],
            "reviewThreads":[{"id":"thread","nextCommentsCursor":"one"}]
        });
        let mut partial = initial.clone();
        hydrate_watch_tails(&mut partial, |_, cursor| {
            (cursor == "one").then(|| json!({"comments":[{"id":"second"}],"nextCursor":"two"}))
        });
        assert_eq!(partial, initial);

        let mut repeated = initial.clone();
        hydrate_watch_tails(&mut repeated, |_, _| {
            Some(json!({"comments":[{"id":"second"}],"nextCursor":"one"}))
        });
        assert_eq!(repeated, initial);

        let mut complete = initial;
        hydrate_watch_tails(&mut complete, |thread, cursor| {
            assert_eq!(thread, "thread");
            match cursor {
                "one" => Some(json!({"comments":[{"id":"second"}],"nextCursor":"two"})),
                "two" => Some(json!({"comments":[{"id":"third"}],"nextCursor":null})),
                _ => None,
            }
        });
        assert_eq!(complete["commentsTruncated"], false);
        assert_eq!(complete["comments"], json!([{"id":"first"},{"id":"second"},{"id":"third"}]));
    }

    #[test]
    fn maps_reactions_and_excludes_viewer_from_actor_list() {
        let groups = json!([
            {"content":"THUMBS_UP","viewerHasReacted":true,"reactors":{"totalCount":5,"nodes":[{"login":"Alice"},{"login":"bob"}]}},
            {"content":"HEART","viewerHasReacted":false,"reactors":{"totalCount":0,"nodes":[]}},
            {"content":"UNKNOWN","reactors":{"totalCount":1,"nodes":[]}}
        ]);
        assert_eq!(
            reactions(&groups, Some("alice")),
            vec![json!({
                "content":"thumbs-up", "count":5, "actors":["bob"], "viewerHasReacted":true
            })]
        );
    }

    #[test]
    fn maps_nullable_actor() {
        assert_eq!(actor(&json!(null)), Value::Null);
        assert_eq!(
            actor(&json!({"login":"alice","name":"Alice","avatarUrl":"https://example.test/a"}))
                ["login"],
            "alice"
        );
        assert_eq!(
            actor(&json!({"__typename":"Bot","login":" robot ","name":" ","avatarUrl":null})),
            json!({"login":"robot","name":null,"avatarUrl":null,"isBot":true})
        );
    }
}
