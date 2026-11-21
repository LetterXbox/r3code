//! Read-only MCP thread timeline access.
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

pub fn definitions() -> Vec<Value> {
    vec![
        json!({"name":"t3_thread_read","description":"Read a thread's messages or activity. Use beforePosition for older items, afterPosition for forward paging, and itemId and textOffset to continue truncated text.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"threadId":{"type":"string"},"view":{"enum":["messages","activity"]},"limit":{"type":"integer","minimum":1,"description":"Maximum 100; larger values are clamped."},"runLimit":{"type":"integer","minimum":1,"description":"Maximum 50; larger values are clamped."},"maxCharsPerItem":{"type":"integer","minimum":1,"description":"Maximum 20000; larger values are clamped."},"afterPosition":{"type":"integer","minimum":-1},"beforePosition":{"type":"integer","minimum":0},"itemId":{"type":"string"},"textOffset":{"type":"integer","minimum":0}},"required":["threadId"],"additionalProperties":false},"annotations":{"title":"Read a T3 thread","readOnlyHint":false,"destructiveHint":false,"idempotentHint":true}}),
    ]
}
fn bounded(args: &Value, name: &str, default: usize, maximum: usize) -> Result<usize, String> {
    match args.get(name).filter(|v| !v.is_null()) {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n >= 1)
            .map(|n| n.min(maximum as u64) as usize)
            .ok_or_else(|| format!("{name} must be greater than or equal to 1.")),
    }
}
fn parse(s: String) -> Value {
    serde_json::from_str(&s).unwrap_or(Value::Null)
}
fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}
fn text(item: &Value) -> Option<String> {
    let s = |k| str_field(item, k).map(str::to_owned);
    match str_field(item, "type").unwrap_or("") {
        "user_message" | "assistant_message" | "reasoning" => s("text"),
        "proposed_plan" => s("markdown"),
        "system_notice" | "run_interrupt_request" | "run_interrupt_result" => s("message"),
        "error" => item
            .pointer("/failure/message")
            .and_then(Value::as_str)
            .map(str::to_owned),
        "notification" => Some(
            [s("summary"), s("detail")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "command_execution" => Some(
            [s("input").map(|x| format!("$ {x}")), s("output")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "subagent" => s("result")
            .or_else(|| s("progress"))
            .or_else(|| s("prompt")),
        "compaction" | "handoff" => s("summary"),
        "approval_request" => Some(
            [s("prompt").or_else(|| s("requestKind")), s("reason")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}
fn text_slice(s: &str, offset: usize, max: usize) -> (String, Option<usize>) {
    let mut pos = 0;
    let mut result = String::new();
    let mut end = offset;
    for ch in s.chars() {
        let width = ch.len_utf16();
        if pos + width <= offset {
            pos += width;
            continue;
        }
        if pos >= offset && end - offset + width > max && !result.is_empty() {
            break;
        }
        result.push(ch);
        pos += width;
        end = pos;
    }
    (
        result,
        if end < s.encode_utf16().count() {
            Some(end)
        } else {
            None
        },
    )
}
#[derive(Clone)]
struct TimelineRow {
    item: Value,
    source: String,
    visibility: &'static str,
    run_ordinal: Option<i64>,
    run_status: Option<String>,
}

fn timeline(
    db: &Connection,
    id: &str,
    thread: &Value,
    seen: &mut std::collections::HashSet<String>,
    include_rolled_back: bool,
) -> Result<Vec<TimelineRow>, String> {
    if !seen.insert(id.to_owned()) {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    let fork = &thread["forkedFrom"];
    if fork["type"] == "run" && thread["lineage"]["sideChat"] != true {
        let source = fork["threadId"].as_str().ok_or("Invalid fork source.")?;
        let source_thread: Option<String> = db
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                [source],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let source_thread = source_thread
            .map(parse)
            .ok_or("Inherited thread history is unavailable.")?;
        let boundary: Option<i64> = db.query_row("SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2", rusqlite::params![source, fork["runId"].as_str()], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let inherited = timeline(db, source, &source_thread, seen, true)?;
        if let Some(boundary) = boundary {
            for mut row in inherited {
                if row.source != source
                    || row.item["type"] == "fork"
                    || row.run_ordinal.is_some_and(|n| n <= boundary)
                    || (row.run_ordinal.is_none() && source_thread["historyOrigin"] == "v1_import")
                {
                    if row.source == source && row.run_status.as_deref() == Some("rolled_back") {
                        let rolled_before_fork: bool = db.query_row(
                            "SELECT COALESCE(julianday(json_extract(payload_json,'$.completedAt')) < julianday(?2), 0) FROM orchestration_v2_projection_runs WHERE run_id=?1",
                            rusqlite::params![row.item["runId"].as_str(), thread["createdAt"].as_str()],
                            |r| r.get(0),
                        ).optional().map_err(|e| e.to_string())?.unwrap_or(false);
                        if rolled_before_fork {
                            continue;
                        }
                    }
                    row.visibility = "inherited";
                    rows.push(row);
                }
            }
        }
        rows.push(TimelineRow { item: json!({"id":format!("turn-item:fork:{id}"),"type":"fork","status":"completed","title":"Forked from conversation","updatedAt":thread["createdAt"]}), source:source.to_owned(), visibility:"synthetic", run_ordinal:None, run_status:None });
    }
    let mut stmt = db.prepare("SELECT i.payload_json,r.ordinal,r.status FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND NOT (i.type='user_message' AND COALESCE(json_extract(i.payload_json,'$.inputIntent'),'')='queued_turn' AND COALESCE(r.status,'') IN ('queued','cancelled')) ORDER BY i.ordinal,i.turn_item_id").map_err(|e|e.to_string())?;
    let local = stmt
        .query_map([id], |r| {
            Ok(TimelineRow {
                item: parse(r.get(0)?),
                source: id.to_owned(),
                visibility: "local",
                run_ordinal: r.get(1)?,
                run_status: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.extend(
        local
            .into_iter()
            .filter(|r| include_rolled_back || r.run_status.as_deref() != Some("rolled_back")),
    );
    seen.remove(id);
    Ok(rows)
}
/// `caller_is_thread` selects newest-first cursorless paging for provider credentials.
/// Callers must authenticate before invoking this function; reads are not fenced by ownership.
pub fn call(
    db: &Connection,
    args: &Value,
    environment_id: &str,
    caller_is_thread: bool,
) -> Result<Value, String> {
    let obj = args.as_object().ok_or("Arguments must be an object.")?;
    if obj.keys().any(|k| {
        ![
            "threadId",
            "view",
            "limit",
            "runLimit",
            "maxCharsPerItem",
            "afterPosition",
            "beforePosition",
            "itemId",
            "textOffset",
        ]
        .contains(&k.as_str())
    }) {
        return Err("Unknown thread-read argument.".into());
    }
    let id = args
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("threadId is required.")?;
    let view = args
        .get("view")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .filter(|s| ["messages", "activity"].contains(s))
                .ok_or("Invalid view.")
        })
        .transpose()?
        .unwrap_or("messages");
    let limit = bounded(args, "limit", 10, 100)?;
    let run_limit = bounded(args, "runLimit", 10, 50)?;
    let max = bounded(args, "maxCharsPerItem", 500, 20000)?;
    let cursor = |name: &str, min: i64| -> Result<Option<i64>, String> {
        args.get(name)
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_i64()
                    .filter(|n| *n >= min)
                    .ok_or_else(|| format!("Invalid {name}."))
            })
            .transpose()
    };
    let after = cursor("afterPosition", -1)?;
    let before = cursor("beforePosition", 0)?;
    let offset = cursor("textOffset", 0)?.unwrap_or(0) as usize;
    let item_id = args
        .get("itemId")
        .filter(|v| !v.is_null())
        .map(|v| v.as_str().ok_or("Invalid itemId."))
        .transpose()?;
    let thread: Option<String>=db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let thread = match thread {
        Some(raw) => parse(raw),
        None => {
            let prefix = format!("t3-thread://v2/{environment_id}/");
            if let Some(rest) = id.split(&prefix).nth(1) {
                let candidate: String = rest
                    .chars()
                    .take_while(|c| !matches!(c, ')' | '>' | ']' | ' ' | '\t' | '\n' | '\r'))
                    .collect();
                if !candidate.is_empty() {
                    let exists: bool = db
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL)",
                            [&candidate],
                            |r| r.get(0),
                        )
                        .unwrap_or(false);
                    if exists {
                        return Err(format!(
                            "`{id}` is a thread link, not a thread id. Pass `{candidate}` instead."
                        ));
                    }
                }
            }
            return Err(format!("Thread {id} is no longer available."));
        }
    };
    let mut stmt=db.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal DESC").map_err(|e|e.to_string())?;
    let runs = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|x| x.map(parse))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let all = timeline(
        db,
        id,
        &thread,
        &mut std::collections::HashSet::new(),
        false,
    )?;
    let visible: Vec<_> = all
        .iter()
        .enumerate()
        .filter(|(_, i)| {
            view == "activity"
                || matches!(
                    str_field(&i.item, "type"),
                    Some("user_message" | "assistant_message" | "proposed_plan")
                )
        })
        .collect();
    let total = all.len();
    let eligible: Vec<_> = visible
        .into_iter()
        .filter(|(p, i)| {
            after.is_none_or(|a| (*p as i64) > a)
                && before.is_none_or(|b| (*p as i64) < b)
                && item_id.is_none_or(|x| str_field(&i.item, "id") == Some(x))
        })
        .collect();
    let newest = before.is_some() || (after.is_none() && caller_is_thread);
    let start = if newest {
        eligible.len().saturating_sub(limit)
    } else {
        0
    };
    let selected = &eligible[start..eligible.len().min(start + limit)];
    let mut items = Vec::new();
    for (position, row) in selected {
        let item = &row.item;
        let (body, next) = text(item)
            .map(|s| {
                let (x, n) = text_slice(&s, if item_id.is_some() { offset } else { 0 }, max);
                (Some(x), n)
            })
            .unwrap_or((None, None));
        let message_id = item.get("messageId").cloned().unwrap_or(Value::Null);
        let message: Option<String> = if let Some(m) = message_id.as_str() {
            db.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",
                [m],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        let message = message.map(parse).unwrap_or(Value::Null);
        let mut value = json!({"position":position,"visibility":row.visibility,"sourceThreadId":row.source,"itemId":item["id"],"runId":item["runId"],"messageId":message_id,"createdBy":message["createdBy"],"creationSource":message["creationSource"],"type":item["type"],"status":item["status"],"title":item["title"],"text":body,"textTruncated":next.is_some(),"nextTextOffset":next,"updatedAt":item["updatedAt"]});
        if !message["senderThreadId"].is_null() {
            value["senderThreadId"] = message["senderThreadId"].clone();
        }
        if item["type"] == "subagent" {
            value["subagentId"] = item["subagentId"].clone();
        }
        items.push(value);
    }
    let title = str_field(&thread, "title").unwrap_or("");
    let latest = runs.first();
    let active = runs.iter().find(|r| {
        matches!(
            str_field(r, "status"),
            Some("preparing" | "starting" | "running" | "waiting")
        )
    });
    let pending_count: i64 = db.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending'", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let pending: Option<String> = db.query_row("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' ORDER BY (kind='user_input'),created_at DESC LIMIT 1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let pending = pending.map(parse).unwrap_or(Value::Null);
    let millis = |v: &Value| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| v.timestamp_millis())
    };
    let at = millis(&thread["snoozedAt"]);
    let request_wakes = !pending.is_null()
        && (pending["kind"] != "user_input"
            || at.is_none()
            || millis(&pending["createdAt"])
                .zip(at)
                .is_some_and(|(a, b)| a > b));
    let shell_latest = runs
        .iter()
        .find(|r| !(r["status"] == "queued" && r["queueHeld"] == true));
    let error_wakes = shell_latest.is_some_and(|r| {
        r["status"] == "failed"
            && (at.is_none()
                || millis(&r["completedAt"])
                    .zip(at)
                    .is_some_and(|(a, b)| a > b))
    });
    let snoozed = millis(&thread["snoozedUntil"])
        .is_some_and(|until| until > chrono::Utc::now().timestamp_millis())
        && thread["pendingGuestMessageCount"].as_u64().unwrap_or(0) == 0
        && !request_wakes
        && !error_wakes;
    let background: Vec<Value> = thread["pendingBackgroundTasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|task| {
            let mut value = serde_json::Map::new();
            for key in ["taskId", "kind", "description", "awaited"] {
                if let Some(v) = task.get(key) {
                    value.insert(key.into(), v.clone());
                }
            }
            if task["kind"] == "subagent" {
                if let Some(v) = task.get("childThreadId") {
                    value.insert("childThreadId".into(), v.clone());
                }
            }
            Value::Object(value)
        })
        .collect();
    let detail = json!({"threadId":id,"projectId":thread["projectId"],"title":title,"link":crate::mcp_http::thread_link(environment_id,id,Some(title)),"createdBy":thread["createdBy"],"creationSource":thread["creationSource"],"status":active.or(latest).and_then(|r|str_field(r,"status")).unwrap_or("idle"),"latestRunId":latest.map(|r|&r["id"]),"activeRunId":active.map(|r|&r["id"]),"providerInstanceId":thread["modelSelection"]["instanceId"],"model":thread["modelSelection"]["model"],"runtimeMode":thread["runtimeMode"],"interactionMode":thread["interactionMode"],"linkedPullRequest":thread["linkedPullRequest"],"titleRegeneration":thread["titleRegeneration"],"lastTitleRegeneration":thread["lastTitleRegeneration"],"settled":thread["settledOverride"] == "settled","settledAt":if thread["settledOverride"] == "settled" { thread["settledAt"].clone() } else { Value::Null },"branch":thread["branch"],"worktreePath":thread["worktreePath"],"parentThreadId":thread["lineage"]["parentThreadId"],"relationshipToParent":thread["lineage"]["relationshipToParent"],"runCount":runs.len(),"itemCount":total,"pendingRequestCount":pending_count,"snoozed":snoozed,"snoozedUntil":if snoozed { thread["snoozedUntil"].clone() } else { Value::Null },"blockedOnThreadWait":thread["blockedOnThreadWait"] == true,"pendingBackgroundTasks":background,"archived":!thread["archivedAt"].is_null(),"createdAt":thread["createdAt"],"updatedAt":thread["updatedAt"]});
    let links: Vec<&Value> = thread["pullRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|link| link["source"] != "stack-dismissed")
        .collect();
    let mut detail = detail;
    detail["pullRequestCount"] = json!(links.len());
    if after.is_none() && before.is_none() && item_id.is_none() {
        let mut open: Vec<&Value> = links
            .into_iter()
            .filter(|link| {
                !matches!(
                    link["snapshot"]["state"].as_str(),
                    Some("closed" | "merged")
                )
            })
            .collect();
        detail["openPullRequestCount"] = json!(open.len());
        open.sort_by(|a, b| {
            let date = |link: &Value| {
                link.pointer("/snapshot/updatedAt")
                    .and_then(Value::as_str)
                    .or_else(|| link["linkedAt"].as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map_or(0, |d| d.timestamp_millis())
            };
            let watching = |link: &Value| link.get("watch").is_some_and(|v| !v.is_null());
            watching(b)
                .cmp(&watching(a))
                .then_with(|| date(b).cmp(&date(a)))
        });
        detail["pullRequests"] = json!(open.into_iter().take(5).map(|link| json!({"host":link["host"].as_str().map(str::to_lowercase),"repository":link["repository"],"number":link["number"],"url":link["url"],"source":link["source"],"state":link["snapshot"]["state"],"watching":!link["watch"].is_null(),"watchStartedAt":link["watch"]["startedAt"]})).collect::<Vec<_>>());
    }
    let mut recent = Vec::new();
    for run in runs.iter().take(run_limit) {
        let executed: Option<String> = if let Some(attempt) = run["activeAttemptId"].as_str() {
            db.query_row("SELECT json_extract(payload_json,'$.model') FROM orchestration_v2_projection_provider_turns WHERE thread_id=?1 AND run_attempt_id=?2 ORDER BY ordinal DESC LIMIT 1", rusqlite::params![id, attempt], |row| row.get(0)).optional().map_err(|e| e.to_string())?.flatten()
        } else {
            None
        };
        recent.push(json!({"runId":run["id"],"ordinal":run["ordinal"],"status":run["status"],"providerInstanceId":run["modelSelection"]["instanceId"],"model":run["modelSelection"]["model"],"executedModel":executed,"requestedAt":run["requestedAt"],"startedAt":run["startedAt"],"completedAt":run["completedAt"]}));
    }
    // Keep the page below the MCP response budget, taking rows from the end being paged toward.
    let envelope = json!({"thread":detail,"recentRuns":recent,"nextPosition":null,"hasMore":false,"earlierPosition":null,"items":[]});
    let budget = 30_000usize
        .saturating_sub(envelope.to_string().len())
        .max(15_000);
    let mut kept = Vec::new();
    let mut bytes = 0;
    let ordered: Box<dyn Iterator<Item = Value>> = if newest {
        Box::new(items.into_iter().rev())
    } else {
        Box::new(items.into_iter())
    };
    for mut item in ordered {
        let size = item.to_string().len() + usize::from(!kept.is_empty());
        if bytes + size <= budget {
            bytes += size;
            kept.push(item);
            continue;
        }
        if kept.is_empty() {
            // Preserve a usable text page even when a single item or title is huge.
            let original = item["text"].as_str().map(str::to_owned);
            if let Some(body) = original {
                let base = if item_id.is_some() { offset } else { 0 };
                let previous_next = item["nextTextOffset"].as_u64().map(|n| n as usize);
                let mut low = 1;
                let mut high = body.encode_utf16().count();
                let mut best = 1;
                while low <= high {
                    let mid = low + (high - low) / 2;
                    let (part, next) = text_slice(&body, 0, mid);
                    let mut candidate = item.clone();
                    candidate["text"] = json!(part);
                    candidate["nextTextOffset"] = json!(next.map(|n| base + n).or(previous_next));
                    candidate["textTruncated"] = json!(!candidate["nextTextOffset"].is_null());
                    if candidate.to_string().len() <= budget {
                        best = mid;
                        low = mid + 1;
                    } else {
                        high = mid.saturating_sub(1);
                    }
                }
                let (part, next) = text_slice(&body, 0, best);
                item["text"] = json!(part);
                item["nextTextOffset"] = json!(next.map(|n| base + n).or(previous_next));
                item["textTruncated"] = json!(!item["nextTextOffset"].is_null());
            }
            if item.to_string().len() > budget {
                if let Some(title) = item["title"].as_str() {
                    let mut chars = title.chars().collect::<Vec<_>>();
                    while !chars.is_empty() && item.to_string().len() > budget / 2 {
                        chars.truncate(chars.len() / 2);
                        item["title"] = json!(chars.iter().collect::<String>());
                    }
                }
            }
            kept.push(item);
        }
        break;
    }
    if newest {
        kept.reverse();
    }
    let trimmed_start = if newest {
        selected.len().saturating_sub(kept.len())
    } else {
        0
    };
    let has_more =
        !newest && (start + selected.len() < eligible.len() || kept.len() < selected.len());
    let earlier = if start > 0
        || trimmed_start > 0
        || kept
            .first()
            .and_then(|i| i["position"].as_u64())
            .is_some_and(|p| p > 0)
    {
        kept.first().map(|i| i["position"].clone())
    } else {
        None
    };
    let next = kept.last().map(|i| i["position"].clone());
    Ok(
        json!({"thread":detail,"recentRuns":recent,"nextPosition":next,"hasMore":has_more,"earlierPosition":earlier,"items":kept}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fork_history_and_budget_page_correctly() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT,thread_id TEXT,run_id TEXT,ordinal INTEGER,type TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,status TEXT,kind TEXT,created_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_turns(thread_id TEXT,run_attempt_id TEXT,ordinal INTEGER,payload_json TEXT);").unwrap();
        for (id, value) in [
            ("parent", json!({"id":"parent"})),
            (
                "child",
                json!({"id":"child","createdAt":"2025-01-01","forkedFrom":{"type":"run","threadId":"parent","runId":"r1"}}),
            ),
        ] {
            db.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES(?1,NULL,?2)",
                rusqlite::params![id, value.to_string()],
            )
            .unwrap();
        }
        for (n, run) in [(1, "r1"), (2, "r2")] {
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES(?1,'parent',?2,'completed',?3)",rusqlite::params![run,n,json!({"id":run,"ordinal":n,"status":"completed"}).to_string()]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?1,'parent',?2,?3,'assistant_message',?4)",rusqlite::params![format!("i{n}"),run,n,json!({"id":format!("i{n}"),"runId":run,"type":"assistant_message","text":"界".repeat(15000)}).to_string()]).unwrap();
        }
        db.execute_batch("INSERT INTO orchestration_v2_projection_runtime_requests(thread_id,status,kind,created_at,payload_json) VALUES ('child','pending','user_input','2026','{}'),('child','resolved','user_input','2026','{}'),('parent','pending','user_input','2026','{}');").unwrap();
        let page = call(
            &db,
            &json!({"threadId":"child","view":"activity","maxCharsPerItem":20000}),
            "env",
            false,
        )
        .unwrap();
        assert_eq!(page["thread"]["pendingRequestCount"], 1);
        assert_eq!(page["items"][0]["itemId"], "i1");
        assert_eq!(page["items"][0]["visibility"], "inherited");
        assert_eq!(page["items"][0]["sourceThreadId"], "parent");
        assert_eq!(page["items"][0]["textTruncated"], true);
        assert!(page.to_string().len() <= 30000);
        assert_eq!(page["hasMore"], true);
        let next = call(
            &db,
            &json!({"threadId":"child","view":"activity","afterPosition":0}),
            "env",
            false,
        )
        .unwrap();
        assert_eq!(next["items"][0]["type"], "fork");
    }
    #[test]
    fn fork_retains_only_history_visible_when_created() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT,thread_id TEXT,run_id TEXT,ordinal INTEGER,type TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,status TEXT,kind TEXT,created_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_turns(thread_id TEXT,run_attempt_id TEXT,ordinal INTEGER,payload_json TEXT);").unwrap();
        for (id, value) in [
            ("parent", json!({"historyOrigin":"v1_import"})),
            (
                "child",
                json!({"createdAt":"2025-01-02T00:00:00Z","forkedFrom":{"type":"run","threadId":"parent","runId":"r2"}}),
            ),
        ] {
            db.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES(?1,NULL,?2)",
                rusqlite::params![id, value.to_string()],
            )
            .unwrap();
        }
        for (n, completed) in [(1, "2025-01-01T00:00:00Z"), (2, "2025-01-03T00:00:00Z")] {
            let run = format!("r{n}");
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES(?1,'parent',?2,'rolled_back',?3)", rusqlite::params![run,n,json!({"id":run,"status":"rolled_back","completedAt":completed}).to_string()]).unwrap();
            db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?1,'parent',?2,?3,'assistant_message',?4)", rusqlite::params![format!("i{n}"),run,n,json!({"id":format!("i{n}"),"runId":run,"type":"assistant_message","text":"result"}).to_string()]).unwrap();
        }
        db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES('import','parent',NULL,0,'user_message',?1)", [json!({"id":"import","type":"user_message","text":"imported"}).to_string()]).unwrap();
        let child = call(
            &db,
            &json!({"threadId":"child","view":"activity"}),
            "env",
            false,
        )
        .unwrap();
        let ids: Vec<_> = child["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["itemId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["import", "i2", "turn-item:fork:child"]);
        let parent = call(
            &db,
            &json!({"threadId":"parent","view":"activity"}),
            "env",
            false,
        )
        .unwrap();
        assert_eq!(parent["items"].as_array().unwrap().len(), 1);
        assert_eq!(parent["items"][0]["itemId"], "import");
    }
    #[test]
    fn thread_detail_reports_snooze_and_redacts_background_work() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","title":"Thread","snoozedUntil":"2999-01-01T00:00:00Z","snoozedAt":"2025-01-01T00:00:00Z","pendingBackgroundTasks":[{"taskId":"a","kind":"subagent","childThreadId":"child","providerInstanceId":"secret"}]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','Thread','codex','auto','default','now','now',?1)",[thread.to_string()]).unwrap();
        let detail = call(&db, &json!({"threadId":"t"}), "env", true).unwrap();
        assert_eq!(detail["thread"]["snoozed"], true);
        assert_eq!(
            detail["thread"]["pendingBackgroundTasks"][0]["childThreadId"],
            "child"
        );
        assert!(detail["thread"]["pendingBackgroundTasks"][0]
            .get("providerInstanceId")
            .is_none());
        let request = json!({"id":"q","kind":"user_input","createdAt":"2026-01-01T00:00:00Z"});
        db.execute("INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES('q','t','n','user_input','pending','2026-01-01T00:00:00Z',?1)",[request.to_string()]).unwrap();
        assert_eq!(
            call(&db, &json!({"threadId":"t"}), "env", true).unwrap()["thread"]["snoozed"],
            false
        );
    }
    #[test]
    fn pages_and_truncates_unicode_and_clamps_limits() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT,thread_id TEXT,run_id TEXT,ordinal INTEGER,type TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT,status TEXT,kind TEXT,created_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_turns(thread_id TEXT,run_attempt_id TEXT,ordinal INTEGER,payload_json TEXT);").unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES('t',NULL,?1)",
            [json!({"id":"t","title":"Thread","projectId":"p","settledOverride":"settled","settledAt":"2026-01-01T00:00:00Z","pullRequests":[{"host":"GITHUB.COM","repository":"a/b","number":1,"source":"manual","linkedAt":"2026-01-01T00:00:00Z"},{"host":"github.com","repository":"a/b","number":2,"source":"stack-dismissed"},{"host":"github.com","repository":"a/b","number":3,"source":"agent","snapshot":{"state":"closed"}}]}).to_string()],
        )
        .unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_runs VALUES('r','t',1,'completed',?1)", [json!({"id":"r","activeAttemptId":"attempt","status":"completed","modelSelection":{"model":"requested"}}).to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_turns VALUES('t','attempt',1,?1),('t','attempt',2,?2)", rusqlite::params![json!({"model":"earlier"}).to_string(),json!({"model":"executed"}).to_string()]).unwrap();
        for (n, kind, body) in [
            (0, "user_message", "hello"),
            (1, "reasoning", "thinking"),
            (2, "assistant_message", "a😀b"),
        ] {
            let item = json!({"id":format!("i{n}"),"type":kind,"text":body,"status":"completed"});
            db.execute(
                "INSERT INTO orchestration_v2_projection_turn_items VALUES(?1,'t',NULL,?2,?3,?4)",
                rusqlite::params![format!("i{n}"), n, kind, item.to_string()],
            )
            .unwrap();
        }
        let page = call(
            &db,
            &json!({"threadId":"t","limit":1,"maxCharsPerItem":2}),
            "env",
            true,
        )
        .unwrap();
        assert_eq!(page["recentRuns"][0]["executedModel"], "executed");
        assert_eq!(page["thread"]["settled"], true);
        assert_eq!(page["thread"]["pullRequestCount"], 2);
        assert_eq!(page["thread"]["openPullRequestCount"], 1);
        assert_eq!(page["thread"]["pullRequests"][0]["host"], "github.com");
        assert_eq!(page["items"][0]["itemId"], "i2");
        assert_eq!(page["items"][0]["text"], "a");
        assert_eq!(page["items"][0]["nextTextOffset"], 1);
        assert_eq!(page["earlierPosition"], 2);
        let page=call(&db,&json!({"threadId":"t","view":"activity","itemId":"i2","textOffset":1,"maxCharsPerItem":2,"limit":1000}),"env",true).unwrap();
        assert_eq!(page["items"][0]["text"], "😀");
        assert_eq!(page["items"][0]["nextTextOffset"], 3);
        let page = call(
            &db,
            &json!({"threadId":"t","afterPosition":-1,"limit":1}),
            "env",
            true,
        )
        .unwrap();
        assert_eq!(page["items"][0]["itemId"], "i0");
        assert_eq!(page["hasMore"], true);
        assert!(call(&db, &json!({"threadId":"t","limit":0}), "env", true).is_err());
    }
}
