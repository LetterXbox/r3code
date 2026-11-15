//! Local lookup of threads linked to a pull request.
use crate::migration_050::{normalize_key, PullRequestKey};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn valid(input: &Value) -> bool {
    let required = |name: &str| {
        input
            .get(name)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    let optional = |name: &str| {
        input
            .get(name)
            .is_none_or(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
    };
    required("projectId")
        && required("repository")
        && optional("host")
        && optional("expectedAccountId")
        && input.get("allowStale").is_none_or(Value::is_boolean)
        && input
            .get("number")
            .and_then(Value::as_i64)
            .is_some_and(|n| n > 0)
}

pub(crate) fn project_root(db: &Connection, input: &Value) -> rusqlite::Result<Option<String>> {
    if input.get("host").and_then(Value::as_str).is_some()
        && input["repository"].as_str().unwrap().contains('/')
    {
        return Ok(None);
    }
    db.query_row(
        "SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",
        [input["projectId"].as_str().unwrap()],
        |r| r.get(0),
    )
    .optional()
}

pub(crate) fn key(input: &Value, identity: Option<Value>) -> Option<PullRequestKey> {
    let repo = input["repository"].as_str().unwrap().trim();
    let number = input["number"].as_i64().unwrap();
    let explicit_host = input.get("host").and_then(Value::as_str).map(str::trim);
    if let Some(host) = explicit_host.filter(|_| repo.contains('/')) {
        return Some(normalize_key(host, repo, number));
    }
    let identity = identity?;
    let canonical = identity["canonicalKey"].as_str()?;
    let (host, canonical_repo) = canonical.split_once('/')?;
    if identity["provider"] == "azure-devops" && !repo.contains('/') {
        if !identity["name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(repo))
            || explicit_host.is_some_and(|h| !h.eq_ignore_ascii_case(host))
        {
            return None;
        }
        return Some(normalize_key(host, canonical_repo, number));
    }
    Some(normalize_key(explicit_host.unwrap_or(host), repo, number))
}

pub(crate) fn linked_threads(
    db: &Connection,
    input: &Value,
    identity: Option<Value>,
) -> rusqlite::Result<Value> {
    let Some(key) = key(input, identity) else {
        return Ok(json!({"threads":[]}));
    };
    let mut stmt = db.prepare("SELECT t.thread_id,t.project_id,t.title,t.archived_at, (json_extract(t.payload_json,'$.settledAt') IS NOT NULL OR json_extract(t.payload_json,'$.settledOverride') IS 'settled'), json_extract(link.value,'$.host'), json_extract(link.value,'$.repository'), json_extract(link.value,'$.number') FROM orchestration_v2_projection_threads t JOIN json_each(t.payload_json,'$.pullRequests') link WHERE json_extract(link.value,'$.number')=?1 AND json_extract(link.value,'$.source') != 'stack-dismissed' AND t.deleted_at IS NULL AND json_extract(t.payload_json,'$.lineage.sideChat') IS NOT 1 ORDER BY t.updated_at DESC,t.thread_id ASC")?;
    let rows = stmt.query_map([key.number], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, bool>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;
    let mut threads = Vec::new();
    for row in rows {
        let (id, project, title, archived, settled, host, repo, number) = row?;
        if let (Some(host), Some(repo)) = (host, repo) {
            if normalize_key(&host, &repo, number) == key {
                threads.push(json!({"id":id,"projectId":project,"title":title,"archivedAt":archived,"settled":settled}));
            }
        }
    }
    Ok(json!({"threads":threads}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_identity_and_azure_bare_names() {
        let input = json!({"projectId":"p", "repository":"Repo", "number":7});
        let identity = json!({"provider":"azure-devops","canonicalKey":"dev.azure.com/org/project/_git/repo","name":"Repo"});
        assert_eq!(
            key(&input, Some(identity.clone())),
            Some(normalize_key("dev.azure.com", "org/project/_git/repo", 7))
        );
        assert_eq!(
            key(
                &json!({"projectId":"p","repository":"other","number":7}),
                Some(identity)
            ),
            None
        );
        assert_eq!(key(&input, None), None);
    }

    #[test]
    fn linked_threads_filters_and_orders_projection() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, title TEXT, archived_at TEXT, deleted_at TEXT, updated_at TEXT, payload_json TEXT); CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT);").unwrap();
        let insert = |id: &str,
                      updated: &str,
                      archived: Option<&str>,
                      deleted: Option<&str>,
                      payload: Value| {
            db.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES (?1,'p',?1,?2,?3,?4,?5)",
                rusqlite::params![id, archived, deleted, updated, payload.to_string()],
            )
            .unwrap();
        };
        let payload = |host: &str, source: &str, side: bool, settled: bool| json!({"pullRequests":[{"host":host,"repository":"Owner/Repo","number":7,"source":source}],"lineage":{"sideChat":side},"settledOverride":if settled {"settled"} else {"none"}});
        insert(
            "old",
            "1",
            Some("archived"),
            None,
            payload("GITHUB.COM", "manual", false, true),
        );
        insert(
            "new",
            "2",
            None,
            None,
            payload("github.com", "manual", false, false),
        );
        insert(
            "dismissed",
            "3",
            None,
            None,
            payload("github.com", "stack-dismissed", false, false),
        );
        insert(
            "side",
            "3",
            None,
            None,
            payload("github.com", "manual", true, false),
        );
        insert(
            "deleted",
            "3",
            None,
            Some("x"),
            payload("github.com", "manual", false, false),
        );
        insert(
            "other",
            "3",
            None,
            None,
            payload("gitlab.com", "manual", false, false),
        );
        let input =
            json!({"projectId":"p","host":"github.com","repository":"owner/repo","number":7});
        assert!(valid(&input));
        assert_eq!(
            linked_threads(&db, &input, None).unwrap(),
            json!({"threads":[{"id":"new","projectId":"p","title":"new","archivedAt":null,"settled":false},{"id":"old","projectId":"p","title":"old","archivedAt":"archived","settled":true}]})
        );
        assert!(!valid(
            &json!({"projectId":"p","repository":"x","number":0})
        ));
    }
}
