//! Identify child results fully exposed by a thread-read page.
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashSet;

fn rows(db: &Connection, sql: &str, args: &[&str]) -> Result<Vec<Value>, String> {
    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let values = stmt
        .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    values
        .map(|v| {
            v.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        })
        .collect()
}

/// Returns task IDs whose terminal result is present and untruncated on this page.
/// The caller must dispatch the acknowledgement command for each returned ID.
pub fn acknowledged_tasks(
    db: &Connection,
    caller: &str,
    target: &str,
    args: &Value,
    page: &Value,
) -> Result<Vec<String>, String> {
    let items = page["items"].as_array().ok_or("Invalid thread page.")?;
    // The read API applies an offset only when an item is selected. A final
    // continuation chunk is not the whole result, even when it is nonempty
    // and textTruncated is false.
    if args["itemId"].is_string() && args["textOffset"].as_u64().unwrap_or(0) > 0 {
        return Ok(vec![]);
    }
    let threads = rows(db, "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", &[target])?;
    let Some(thread) = threads.first() else {
        return Ok(vec![]);
    };
    if thread["lineage"]["parentThreadId"] != caller
        || thread["lineage"]["relationshipToParent"] != "subagent"
    {
        return Ok(vec![]);
    }
    let runs = rows(db, "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal", &[target])?;
    let transfers = rows(db, "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=?1 OR target_thread_id=?1 ORDER BY rowid", &[target])?;
    let tasks = rows(db, "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' ORDER BY started_at,subagent_id", &[caller])?;
    let original = tasks.iter().find(|t| {
        thread["forkedFrom"]["type"] == "node"
            && t["id"] == thread["forkedFrom"]["nodeId"]
            && t["childThreadId"] == target
            && t["threadId"] == caller
    });
    let returned: HashSet<&str> = items
        .iter()
        .filter(|i| i["sourceThreadId"] == target)
        .filter_map(|i| i["runId"].as_str())
        .collect();
    let task_ids: HashSet<&str> = runs
        .iter()
        .filter(|r| r["id"].as_str().is_some_and(|id| returned.contains(id)))
        .filter_map(|r| {
            r["delegatedTaskId"]
                .as_str()
                .or_else(|| original.and_then(|t| t["id"].as_str()))
        })
        .collect();
    let mut found = Vec::new();
    for task in tasks.iter().filter(|t| {
        t["childThreadId"] == target && t["id"].as_str().is_some_and(|id| task_ids.contains(id))
    }) {
        let id = task["id"].as_str().unwrap();
        let delegated = runs
            .iter()
            .find(|r| r["delegatedTaskId"] == id)
            .or_else(|| {
                let spawn = transfers.iter().find(|t| {
                    t["type"] == "subagent_spawn"
                        && t["sourceThreadId"] == caller
                        && t["targetThreadId"] == target
                });
                match spawn {
                    Some(t) => runs
                        .iter()
                        .find(|r| !t["targetRunId"].is_null() && r["id"] == t["targetRunId"]),
                    None => runs.first(),
                }
            });
        let transfer = transfers.iter().find(|t| {
            if t["type"] != "subagent_result"
                || t["sourceThreadId"] != target
                || t["targetThreadId"] != caller
            {
                return false;
            }
            match t["sourcePoint"]["runId"].as_str() {
                Some(run_id) => {
                    runs.iter().any(|r| {
                        r["id"] == run_id
                            && (r["delegatedTaskId"] == id
                                || (delegated.is_some_and(|d| d["delegatedTaskId"].is_null())
                                    && r["delegatedTaskId"].is_null()))
                    }) || delegated.is_some_and(|r| r["id"] == run_id)
                }
                None => delegated.is_some_and(|r| r["delegatedTaskId"].is_null()),
            }
        });
        let Some(transfer) = transfer else { continue };
        let run = transfer["sourcePoint"]["runId"]
            .as_str()
            .and_then(|id| runs.iter().find(|r| r["id"] == id))
            .or_else(|| {
                if transfer["sourcePoint"]["runId"].is_null() {
                    delegated
                } else {
                    None
                }
            });
        let Some(run) = run else { continue };
        if !matches!(
            run["status"].as_str(),
            Some("completed" | "failed" | "cancelled" | "interrupted" | "rolled_back")
        ) {
            continue;
        }
        let Some(run_id) = run["id"].as_str() else {
            continue;
        };
        let result_items = rows(db, "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id=?2 AND type IN ('assistant_message','error') ORDER BY ordinal DESC", &[target, run_id])?;
        let assistant = result_items.iter().find(|i| {
            i["type"] == "assistant_message"
                && i["text"].as_str().is_some_and(|s| !s.trim().is_empty())
        });
        let failure = if run["status"] == "failed" {
            result_items.iter().find(|i| i["type"] == "error")
        } else {
            None
        };
        let result_item = failure.or(assistant);
        let messages = rows(db, "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND run_id=?2 AND role='assistant' ORDER BY updated_at DESC, created_at DESC", &[target, run_id])?;
        let messages: Vec<_> = messages
            .iter()
            .filter(|m| m["text"].as_str().is_some_and(|s| !s.trim().is_empty()))
            .collect();
        let message_id = if failure.is_none() {
            let item_message_id = assistant.and_then(|i| i["messageId"].as_str());
            messages
                .iter()
                .find(|m| m["id"].as_str() == item_message_id && item_message_id.is_some())
                .or_else(|| messages.first())
                .and_then(|m| m["id"].as_str())
                .or(item_message_id)
        } else {
            None
        };
        if items.iter().any(|i| {
            i["sourceThreadId"] == target
                && i["text"].is_string()
                && i["textTruncated"] == false
                && (result_item.is_some_and(|r| i["itemId"] == r["id"])
                    || message_id
                        .is_some_and(|m| i["type"] == "assistant_message" && i["messageId"] == m))
        }) {
            found.push(id.to_owned());
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_full_local_result_of_direct_child_is_eligible() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,ordinal INTEGER,payload_json TEXT); CREATE TABLE orchestration_v2_projection_context_transfers(source_thread_id TEXT,target_thread_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_subagents(thread_id TEXT,origin TEXT,started_at TEXT,subagent_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,ordinal INTEGER,payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(thread_id TEXT,run_id TEXT,role TEXT,updated_at TEXT,created_at TEXT,payload_json TEXT);").unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads VALUES('child',NULL,?1)", [json!({"lineage":{"parentThreadId":"parent","relationshipToParent":"subagent"},"forkedFrom":{"type":"node","nodeId":"task"}}).to_string()]).unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_runs VALUES('child',1,?1)",
            [json!({"id":"run","status":"completed","delegatedTaskId":"task"}).to_string()],
        )
        .unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_context_transfers VALUES('child','parent',?1)", [json!({"type":"subagent_result","sourceThreadId":"child","targetThreadId":"parent","sourcePoint":{"runId":"run"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('parent','app_owned','now','task',?1)", [json!({"id":"task","threadId":"parent","childThreadId":"child"}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES('child','run','assistant_message',1,?1)", [json!({"id":"result","type":"assistant_message","text":"done"}).to_string()]).unwrap();
        let mut page = json!({"items":[{"sourceThreadId":"child","runId":"run","itemId":"result","text":"done","textTruncated":false}]});
        assert_eq!(
            acknowledged_tasks(&db, "parent", "child", &json!({}), &page).unwrap(),
            vec!["task"]
        );
        // A result message can be projected without a matching turn item, or the
        // latest assistant message can supply the result when the item lacks one.
        db.execute("INSERT INTO orchestration_v2_projection_messages VALUES('child','run','assistant','2','1',?1)", [json!({"id":"message","text":"done"}).to_string()]).unwrap();
        page["items"][0]["itemId"] = json!("other");
        page["items"][0]["type"] = json!("assistant_message");
        page["items"][0]["messageId"] = json!("message");
        assert_eq!(
            acknowledged_tasks(&db, "parent", "child", &json!({}), &page).unwrap(),
            vec!["task"]
        );
        db.execute("DELETE FROM orchestration_v2_projection_turn_items", [])
            .unwrap();
        assert_eq!(
            acknowledged_tasks(&db, "parent", "child", &json!({}), &page).unwrap(),
            vec!["task"]
        );
        page["items"][0]["textTruncated"] = json!(true);
        assert!(
            acknowledged_tasks(&db, "parent", "child", &json!({}), &page)
                .unwrap()
                .is_empty()
        );
        page["items"][0]["textTruncated"] = json!(false);
        page["items"][0]["text"] = json!("final chunk");
        assert!(acknowledged_tasks(
            &db,
            "parent",
            "child",
            &json!({"itemId":"other","textOffset":20}),
            &page
        )
        .unwrap()
        .is_empty());
        // Without itemId, the read API ignores textOffset and returns full text.
        assert_eq!(
            acknowledged_tasks(&db, "parent", "child", &json!({"textOffset":20}), &page).unwrap(),
            vec!["task"]
        );
        assert!(acknowledged_tasks(&db, "other", "child", &json!({}), &page)
            .unwrap()
            .is_empty());
    }
}
