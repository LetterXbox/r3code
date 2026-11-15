//! Resolve the signed-in GitHub account for a configured project host.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn valid(input: &Value) -> bool {
    input
        .get("host")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

pub(crate) fn project_roots(db: &Connection) -> Result<Vec<String>, Value> {
    let error = || json!({"_tag":"PullRequestOperationError","operation":"listProjects","detail":"The project list could not be read."});
    let mut stmt = db.prepare("SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL ORDER BY rowid").map_err(|_| error())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| error())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| error())
}

pub(crate) fn routing_identity(roots: Vec<String>, input: &Value) -> Result<Value, Value> {
    let host = input["host"].as_str().unwrap().trim().to_lowercase();
    let unsupported =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    for root in roots {
        let Some(identity) = crate::repository_identity::resolve(&root) else {
            continue;
        };
        if identity["provider"] != "github"
            || identity["canonicalKey"]
                .as_str()
                .is_none_or(|key| key.split('/').next() != Some(host.as_str()))
        {
            continue;
        }
        return github_identity(&root, &host, "gh", Duration::from_secs(10));
    }
    Err(unsupported())
}

#[derive(Clone)]
pub(crate) struct Project {
    title: String,
    root: String,
    identity: Option<Value>,
}

pub(crate) fn projects(db: &Connection) -> Result<Vec<(String, String, String)>, Value> {
    let error = || json!({"_tag":"PullRequestOperationError","operation":"listProjects","detail":"The project list could not be read."});
    let mut stmt = db.prepare("SELECT project_id,title,workspace_root FROM projection_projects WHERE deleted_at IS NULL ORDER BY rowid").map_err(|_| error())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|_| error())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| error())
}

/// Route a reference to a checkout for the same repository and host.
fn route_with<F>(
    projects: Vec<(String, Project)>,
    input: &Value,
    provider: F,
) -> Result<Value, Value>
where
    F: Fn(&str, &str, &str) -> Result<Value, Value>,
{
    let unsupported =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    let mismatch = || json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."});
    let selected = projects
        .iter()
        .find(|(id, _)| id == input["projectId"].as_str().unwrap());
    let repo = input["repository"].as_str().unwrap().trim();
    let requested_host = input
        .get("host")
        .and_then(Value::as_str)
        .map(|h| h.trim().to_lowercase());
    let matches = |p: &Project| {
        let Some(key) = p.identity.as_ref().and_then(|v| v["canonicalKey"].as_str()) else {
            return false;
        };
        let Some((host, repository)) = key.split_once('/') else {
            return false;
        };
        repository.eq_ignore_ascii_case(repo)
            && requested_host
                .as_ref()
                .is_none_or(|h| host.eq_ignore_ascii_case(h))
    };
    let project = selected.filter(|(_, p)| matches(p)).or_else(|| {
        requested_host
            .as_ref()
            .and_then(|_| projects.iter().find(|(_, p)| matches(p)))
    });
    let Some((_, project)) = project else {
        return Err(
            if requested_host.is_none() && selected.is_some_and(|(_, p)| p.identity.is_some()) {
                mismatch()
            } else {
                unsupported()
            },
        );
    };
    let identity = project.identity.as_ref().unwrap();
    let host = identity["canonicalKey"]
        .as_str()
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let kind = identity["provider"].as_str().ok_or_else(unsupported)?;
    let mut result = provider(kind, &project.root, host)?;
    result["projectTitle"] = json!(project.title);
    result["workspaceRoot"] = json!(project.root);
    Ok(result)
}

pub(crate) fn routing(
    projects: Vec<(String, String, String)>,
    input: &Value,
) -> Result<Value, Value> {
    let projects = projects
        .into_iter()
        .map(|(id, title, root)| {
            let identity = crate::repository_identity::resolve(&root);
            (
                id,
                Project {
                    title,
                    root,
                    identity,
                },
            )
        })
        .collect();
    route_with(projects, input, |kind, root, host| match kind {
        "github" => github_identity(root, host, "gh", Duration::from_secs(10)),
        _ => Err(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"})),
    })
}

fn github_identity(
    root: &str,
    host: &str,
    executable: &str,
    timeout: Duration,
) -> Result<Value, Value> {
    let failed = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified."});
    let mut command = Command::new(executable);
    command
        .args(["api", "--hostname", host, "user"])
        .current_dir(root);
    let bytes = crate::github_pinned_credential::run_classified(&mut command, timeout).map_err(
        |error| {
            crate::github_pinned_credential::operation_error(
                error,
                "routeIdentity",
                "The signed-in account could not be verified.",
            )
        },
    )?;
    if bytes.len() > 65536 {
        return Err(failed());
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    let id = data.get("id").and_then(Value::as_u64).filter(|n| *n > 0);
    let viewer = data
        .get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    match (id, viewer) {
        (Some(id), Some(viewer)) => {
            Ok(json!({"accountId":id.to_string(),"host":host,"provider":"github","viewer":viewer}))
        }
        _ => Err(
            json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified."}),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    #[test]
    fn routes_references_to_matching_provider_and_checkout() {
        let project = |title: &str, root: &str, key: &str, kind: &str| Project {
            title: title.into(),
            root: root.into(),
            identity: Some(json!({"canonicalKey":key,"provider":kind})),
        };
        let projects = vec![
            (
                "one".into(),
                project("One", "/one", "github.com/a/one", "github"),
            ),
            (
                "two".into(),
                project("Two", "/two", "gitlab.com/b/two", "gitlab"),
            ),
        ];
        let fake = |kind: &str, root: &str, host: &str| {
            Ok(
                json!({"accountId":"42","viewer":"alice","provider":kind,"host":host,"calledRoot":root}),
            )
        };
        let own = route_with(
            projects.clone(),
            &json!({"projectId":"one","repository":"A/One","number":1}),
            fake,
        )
        .unwrap();
        assert_eq!(
            own,
            json!({"accountId":"42","viewer":"alice","provider":"github","host":"github.com","calledRoot":"/one","projectTitle":"One","workspaceRoot":"/one"})
        );
        let cross = route_with(
            projects.clone(),
            &json!({"projectId":"one","host":"GITLAB.COM","repository":"B/Two","number":2}),
            fake,
        )
        .unwrap();
        assert_eq!(cross["provider"], "gitlab");
        assert_eq!(cross["workspaceRoot"], "/two");
        assert_eq!(
            route_with(
                projects.clone(),
                &json!({"projectId":"one","repository":"b/two","number":2}),
                fake
            )
            .unwrap_err()["operation"],
            "resolveRepository"
        );
        assert_eq!(
            route_with(
                projects,
                &json!({"projectId":"one","host":"other.com","repository":"a/one","number":1}),
                fake
            )
            .unwrap_err()["reason"],
            "provider-unsupported"
        );
    }

    #[cfg(unix)]
    #[test]
    fn github_routing_uses_host_and_decodes_account() {
        let dir = std::env::temp_dir().join(format!("t3-routing-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("gh");
        std::fs::write(&script, "#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"api --hostname github.com user\" ] || exit 1\nprintf '%s' '{\"id\":123,\"login\":\"alice\"}'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = github_identity(
            dir.to_str().unwrap(),
            "github.com",
            script.to_str().unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(
            result,
            json!({"accountId":"123","host":"github.com","provider":"github","viewer":"alice"})
        );
    }

    #[test]
    fn routing_requires_nonempty_host_and_unknown_host_is_unsupported() {
        assert!(!valid(&json!({"host":"  "})));
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT)",
            [],
        )
        .unwrap();
        assert_eq!(
            routing_identity(
                project_roots(&db).unwrap(),
                &json!({"host":"unknown.example"})
            )
            .unwrap_err(),
            json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"})
        );
    }
    #[cfg(unix)]
    #[test]
    fn github_command_is_bounded() {
        let dir = std::env::temp_dir().join(format!("t3-routing-bounded-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("gh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let now = Instant::now();
        assert!(github_identity(
            dir.to_str().unwrap(),
            "github.com",
            script.to_str().unwrap(),
            Duration::from_millis(100)
        )
        .is_err());
        assert!(now.elapsed() < Duration::from_secs(2));
        std::fs::write(&script, "#!/bin/sh\nhead -c 100000 /dev/zero\n").unwrap();
        assert!(github_identity(
            dir.to_str().unwrap(),
            "github.com",
            script.to_str().unwrap(),
            Duration::from_secs(2)
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
