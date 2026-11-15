//! Cross-thread search RPC. The shell snapshot must be obtained under the
//! application's normal snapshot lock, so its rows and sequence agree.
use crate::mcp_thread_search::{fold, pr_fields, search_messages};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn search(db: &Connection, input: &Value, snapshot: Option<&Value>) -> Result<Value, String> {
    let object = input.as_object().ok_or("Invalid search arguments")?;
    if object.keys().any(|k| {
        ![
            "query",
            "limit",
            "olderSettledBefore",
            "projectIds",
            "environmentLabel",
            "titlesOnly",
        ]
        .contains(&k.as_str())
    }) {
        return Err("Invalid search arguments".into());
    }
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .ok_or("query is required")?;
    if !(2..=200).contains(&query.encode_utf16().count()) {
        return Err("query must contain between 2 and 200 characters".into());
    }
    if let Some(v) = input.get("limit") {
        if !v.as_u64().is_some_and(|n| (1..=50).contains(&n)) {
            return Err("limit must be between 1 and 50".into());
        }
    }
    let titles_only = match input.get("titlesOnly") {
        Some(v) => v.as_bool().ok_or("titlesOnly must be a boolean")?,
        None => false,
    };
    let before = match input.get("olderSettledBefore") {
        Some(v) => Some(v.as_str().ok_or("olderSettledBefore must be a string")?),
        None => None,
    };
    let projects = match input.get("projectIds") {
        Some(v) => Some(
            v.as_array()
                .ok_or("projectIds must be an array")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or("invalid projectId")
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
    };
    let label = match input.get("environmentLabel") {
        Some(v) => v.as_str().ok_or("environmentLabel must be a string")?,
        None => "",
    };
    let mut args = json!({"query": query});
    if let Some(limit) = input.get("limit") {
        args["limit"] = limit.clone();
    }
    let mut result = if titles_only {
        json!({"matches":[]})
    } else {
        search_messages(db, &args)?
    };
    if let Some(before) = before {
        let snap = snapshot.ok_or("shell snapshot is required")?;
        let threads = snap
            .get("threads")
            .and_then(Value::as_array)
            .ok_or("invalid shell snapshot")?;
        let project_rows = snap
            .get("projects")
            .and_then(Value::as_array)
            .ok_or("invalid shell snapshot")?;
        let words = fold(query);
        let words: Vec<_> = words.split_whitespace().map(str::to_owned).collect();
        let eligible = |t: &&Value| {
            let project = t.get("projectId").and_then(Value::as_str).unwrap_or("");
            t.get("settledOverride").and_then(Value::as_str) == Some("settled")
                && t.get("settledAt")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s < before)
                && t.get("archivedAt").is_none_or(Value::is_null)
                && t.pointer("/lineage/relationshipToParent")
                    .and_then(Value::as_str)
                    != Some("subagent")
                && t.pointer("/lineage/sideChat").and_then(Value::as_bool) != Some(true)
                && projects.as_ref().is_none_or(|p| p.contains(&project))
        };
        let candidates: Vec<_> = threads.iter().filter(eligible).collect();
        let mut titles: Vec<(i32, &Value)> = candidates
            .iter()
            .filter_map(|t| {
                let project = t.get("projectId").and_then(Value::as_str).unwrap_or("");
                let pt = project_rows
                    .iter()
                    .find(|p| p.get("id").and_then(Value::as_str) == Some(project))
                    .and_then(|p| p.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut fields = vec![
                    t.get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    t.get("branch")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    pt.to_owned(),
                    t.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                    label.to_owned(),
                ];
                fields.extend(pr_fields(t));
                fields
                    .iter()
                    .enumerate()
                    .filter_map(|(i, f)| {
                        let f = fold(f);
                        if !words.is_empty() && words.iter().all(|w| f.contains(w)) {
                            Some(
                                (if f == fold(query) {
                                    100
                                } else if f.starts_with(&fold(query)) {
                                    80
                                } else {
                                    60
                                }) - i as i32 * 5,
                            )
                        } else {
                            None
                        }
                    })
                    .max()
                    .map(|s| (s, *t))
            })
            .collect();
        titles.sort_by(|a, b| {
            b.0.cmp(&a.0).then_with(|| {
                b.1.get("updatedAt")
                    .and_then(Value::as_str)
                    .cmp(&a.1.get("updatedAt").and_then(Value::as_str))
            })
        });
        let mut selected: Vec<Value> = titles
            .into_iter()
            .take(15)
            .map(|(_, t)| t.clone())
            .collect();
        let matches = result["matches"].as_array().unwrap();
        let mut message_rows = 0;
        for m in matches {
            if message_rows >= 5 {
                break;
            }
            let id = m.get("threadId");
            if selected.iter().any(|t| t.get("id") == id) {
                continue;
            }
            if let Some(t) = candidates.iter().find(|t| t.get("id") == id) {
                selected.push((*t).clone());
                message_rows += 1;
            }
        }
        result["snapshotSequence"] = snap
            .get("snapshotSequence")
            .cloned()
            .ok_or("invalid shell snapshot")?;
        result["threads"] = Value::Array(selected);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titles_only_returns_older_rows_and_sequence() {
        let db = Connection::open_in_memory().unwrap();
        let snapshot = json!({"snapshotSequence": 7,"projects":[{"id":"p","title":"Project"}],"threads":[{"id":"a","projectId":"p","title":"Release plan","settledOverride":"settled","settledAt":"2020-01-01T00:00:00Z"},{"id":"b","projectId":"p","title":"Release newer","settledOverride":"settled","settledAt":"2025-01-01T00:00:00Z"}]});
        let result = search(&db, &json!({"query":"release","titlesOnly":true,"olderSettledBefore":"2023-01-01T00:00:00Z"}), Some(&snapshot)).unwrap();
        assert_eq!(result["matches"], json!([]));
        assert_eq!(result["snapshotSequence"], 7);
        assert_eq!(result["threads"].as_array().unwrap().len(), 1);
        assert_eq!(result["threads"][0]["id"], "a");
    }
}
