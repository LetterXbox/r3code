//! Transactional preparation of pending merge-back context for a new run.
use crate::context_handoff::{self, historical_message};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

/// A validated choice, selected before creating the new run so failures can be
/// recorded as rejected command receipts without leaving projection changes.
pub struct PendingMerge {
    selected: Value,
    stale: Vec<Value>,
    source_run: Value,
    source_provider: String,
}

pub fn pending(
    tx: &Transaction<'_>,
    thread: &str,
    fresh: bool,
) -> rusqlite::Result<Result<Option<PendingMerge>, String>> {
    let mut stmt=tx.prepare("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE target_thread_id=?1 AND type='merge_back' AND status='pending' ORDER BY rowid")?;
    let mut transfers: Vec<Value> = stmt
        .query_map([thread], |r| r.get::<_, String>(0))?
        .map(|v| serde_json::from_str(&v?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<_>>()?;
    if transfers.is_empty() {
        return Ok(Ok(None));
    }
    let first = transfers[0]["sourceThreadId"].clone();
    if transfers.iter().any(|t| t["sourceThreadId"] != first) {
        return Ok(Err(format!(
            "Thread {thread} has pending merge-back transfers from multiple forks."
        )));
    }
    if fresh {
        return Ok(Err(
            "A fresh session can't start while a fork or merge is still being applied.".into(),
        ));
    }
    let index = transfers
        .iter()
        .enumerate()
        .max_by(|(ai, a), (bi, b)| {
            a["updatedAt"]
                .as_str()
                .unwrap_or("")
                .cmp(b["updatedAt"].as_str().unwrap_or(""))
                .then(ai.cmp(bi))
        })
        .unwrap()
        .0;
    let selected = transfers.remove(index);
    let id = selected["id"].as_str().unwrap_or("");
    let source = selected["sourceThreadId"].as_str().unwrap_or("");
    let run_id = selected["sourcePoint"]["runId"].as_str().unwrap_or("");
    let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2",params![source,run_id],|r|r.get(0)).optional()?;
    let Some(raw) = raw else {
        return Ok(Err(format!(
            "Pending merge-back transfer {id} has no resolvable source run."
        )));
    };
    let source_run: Value =
        serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let provider = source_run["providerThreadId"].as_str().unwrap_or("");
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2)",params![source,provider],|r|r.get(0))?;
    if !exists {
        return Ok(Err(format!(
            "Pending merge-back transfer {id} has no resolvable source provider thread."
        )));
    }
    let source_provider = provider.to_owned();
    Ok(Ok(Some(PendingMerge {
        selected,
        stale: transfers,
        source_run,
        source_provider,
    })))
}

fn compact(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.encode_utf16().count() <= 240 {
        return collapsed;
    }
    let mut units = 0;
    let mut out = String::new();
    for c in collapsed.chars() {
        let n = c.len_utf16();
        if units + n > 237 {
            break;
        }
        units += n;
        out.push(c);
    }
    out.push_str("...");
    out
}
pub(crate) fn line(item: &Value) -> Option<String> {
    let text = |key: &str| item[key].as_str().unwrap_or("");
    Some(match item["type"].as_str()? {
        "user_message" => format!("- User: {}", compact(text("text"))),
        "assistant_message" => format!("- Assistant: {}", compact(text("text"))),
        "command_execution" => format!("- Command: {}", compact(text("input"))),
        "file_change" => {
            let paths = item["changes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|c| c["path"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| text("fileName").into());
            format!("- File change: {}", compact(&paths))
        }
        "checkpoint" => format!(
            "- Checkpoint: {} files",
            item["files"].as_array().map_or(0, Vec::len)
        ),
        "handoff" => format!(
            "- Handoff: {}",
            compact(
                item["summary"]
                    .as_str()
                    .or_else(|| item["strategy"].as_str())
                    .unwrap_or("")
            )
        ),
        _ => return None,
    })
}

/// Writes the handoff and transfer projections inside the caller's transaction.
/// The returned events must be appended with the message dispatch events.
pub fn consume(
    tx: &Transaction<'_>,
    pending: PendingMerge,
    thread: &str,
    run: &str,
    provider_thread: &str,
    instance: &str,
    now: &str,
) -> rusqlite::Result<(Value, Vec<(&'static str, Value)>)> {
    let PendingMerge {
        mut selected,
        stale,
        source_run,
        source_provider,
    } = pending;
    let source = selected["sourceThreadId"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let transfer_id = selected["id"]
        .as_str()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .to_owned();
    let through = source_run["ordinal"]
        .as_i64()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let mut stmt=tx.prepare("SELECT i.payload_json,r.ordinal FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id AND r.thread_id=i.thread_id WHERE i.thread_id=?1 AND r.ordinal<=?2 AND r.status != 'rolled_back' AND NOT (i.type='user_message' AND COALESCE(json_extract(i.payload_json,'$.inputIntent'),'')='queued_turn' AND r.status IN ('queued','cancelled')) ORDER BY i.ordinal,i.turn_item_id")?;
    let rows = stmt
        .query_map(params![source, through], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut items = Vec::new();
    let mut ordinals = Vec::new();
    for (raw, ordinal) in rows {
        items.push(serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?);
        ordinals.push(ordinal);
    }
    let from = ordinals.iter().min().copied().unwrap_or(1);
    let to = ordinals.iter().max().copied().unwrap_or(1);
    let id = format!("context-handoff:{}", uuid::Uuid::new_v4());
    let coverage = context_handoff::coverage(&source, from, to, &items);
    let messages: Vec<Value> = items.iter().filter_map(historical_message).collect();
    let selected_history = context_handoff::select_history(
        &messages,
        &coverage,
        0,
        &[],
        context_handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
    );
    let mut lines: Vec<String> = items.iter().filter_map(line).collect();
    if lines.is_empty() {
        lines.push("- No user-visible delta items.".into());
    }
    let summary=format!("Merge-back context from forked conversation.\nSource thread: {source}\nTarget thread: {thread}\nCovered fork runs: {from}-{to}\n\nFork delta:\n{}",lines.join("\n"));
    let handoff = json!({"id":id,"transferId":transfer_id,"threadId":thread,"targetRunId":run,"fromProviderThreadIds":[source_provider],"toProviderThreadId":provider_thread,"coveredRunOrdinals":{"from":from,"to":to},"strategy":"fork_delta_summary","status":"ready","summaryMessageId":null,"summaryText":summary,"history":{"messages":selected_history.messages,"coverage":coverage,"omittedItems":selected_history.omitted_items,"omittedItemIds":selected_history.omitted_item_ids},"createdByProviderInstanceId":null,"createdAt":now,"updatedAt":now});
    tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,'fork_delta_summary','ready',?5,?6)",params![id,thread,run,provider_thread,now,handoff.to_string()])?;
    let mut events = vec![("context-handoff.updated", handoff.clone())];
    for mut t in stale {
        t["status"] = json!("superseded");
        t["error"] = json!(format!("Superseded by merge-back transfer {transfer_id}."));
        t["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_context_transfers SET status='superseded',updated_at=?2,payload_json=?3 WHERE context_transfer_id=?1",params![t["id"].as_str(),now,t.to_string()])?;
        events.push(("context-transfer.updated", t));
    }
    selected["targetProviderInstanceId"] = json!(instance);
    selected["targetRunId"] = json!(run);
    selected["status"] = json!("consumed");
    selected["resolution"] = json!({"strategy":"fork_delta_context","contextHandoffId":id});
    selected["error"] = Value::Null;
    selected["updatedAt"] = json!(now);
    selected["consumedAt"] = json!(now);
    tx.execute("UPDATE orchestration_v2_projection_context_transfers SET target_run_id=?2,target_provider=?3,target_provider_instance_id=?3,status='consumed',updated_at=?4,payload_json=?5 WHERE context_transfer_id=?1",params![transfer_id,run,instance,now,selected.to_string()])?;
    events.push(("context-transfer.updated", selected));
    Ok((handoff, events))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_history_keeps_visible_queued_items_and_excludes_hidden_inputs() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('p','source','codex','active','now','{}')", []).unwrap();
        for (ordinal, status) in [
            (1, "queued"),
            (2, "cancelled"),
            (3, "rolled_back"),
            (4, "completed"),
        ] {
            let id = format!("r{ordinal}");
            let run = json!({"id":id,"ordinal":ordinal,"providerThreadId":"p"});
            db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES(?1,'source',?2,'codex',?3,'now',?4)",params![id,ordinal,status,run.to_string()]).unwrap();
            for (suffix, intent) in [("visible", "normal"), ("hidden", "queued_turn")] {
                let item_id = format!("{id}-{suffix}");
                let item = json!({"id":item_id,"threadId":"source","runId":id,"type":"user_message","text":item_id,"inputIntent":intent,"status":"completed"});
                db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'source',?2,?3,'user_message','completed','now',?4)",params![item_id,id,ordinal * 10 + if suffix == "visible" {0} else {1},item.to_string()]).unwrap();
            }
        }
        let transfer = json!({"id":"x","sourceThreadId":"source","targetThreadId":"target","sourcePoint":{"runId":"r4"},"type":"merge_back","status":"pending","updatedAt":"now"});
        db.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES('x','source','target','merge_back','pending','now',?1)",[transfer.to_string()]).unwrap();
        let tx = db.transaction().unwrap();
        let pending = pending(&tx, "target", false).unwrap().unwrap().unwrap();
        let (handoff, _) = consume(
            &tx,
            pending,
            "target",
            "target-run",
            "target-provider",
            "codex",
            "now",
        )
        .unwrap();
        let summary = handoff["summaryText"].as_str().unwrap();
        for text in ["r1-visible", "r2-visible", "r4-visible", "r4-hidden"] {
            assert!(summary.contains(text), "missing {text}");
        }
        for text in ["r1-hidden", "r2-hidden", "r3-visible", "r3-hidden"] {
            assert!(!summary.contains(text), "unexpected {text}");
        }
        assert_eq!(handoff["coveredRunOrdinals"], json!({"from":1,"to":4}));
    }

    #[test]
    fn consumes_latest_and_supersedes_older_atomically() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let run = json!({"id":"source-run","ordinal":2,"providerThreadId":"source-provider"});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('source-run','source',2,'codex','completed','now',?1)",[run.to_string()]).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('source-provider','source','codex','active','now','{}')",[]).unwrap();
        let item = json!({"id":"item","threadId":"source","runId":"source-run","type":"assistant_message","text":"fork result","status":"completed"});
        db.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES('item','source','source-run',1,'assistant_message','completed','now',?1)",[item.to_string()]).unwrap();
        for (id, time) in [("old", "a"), ("new", "b")] {
            let transfer = json!({"id":id,"sourceThreadId":"source","targetThreadId":"target","sourcePoint":{"runId":"source-run"},"type":"merge_back","status":"pending","updatedAt":time});
            db.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,type,status,updated_at,payload_json) VALUES(?1,'source','target','merge_back','pending',?2,?3)",params![id,time,transfer.to_string()]).unwrap();
        }
        let tx = db.transaction().unwrap();
        assert!(pending(&tx, "target", true).unwrap().is_err());
        let p = pending(&tx, "target", false).unwrap().unwrap().unwrap();
        let (handoff, events) = consume(
            &tx,
            p,
            "target",
            "new-run",
            "target-provider",
            "codex",
            "now",
        )
        .unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events.iter().map(|e| e.0).collect::<Vec<_>>(),
            vec![
                "context-handoff.updated",
                "context-transfer.updated",
                "context-transfer.updated"
            ]
        );
        assert_eq!(events[2].1["resolution"]["strategy"], "fork_delta_context");
        assert_eq!(handoff["transferId"], "new");
        assert!(handoff["summaryText"]
            .as_str()
            .unwrap()
            .contains("- Assistant: fork result"));
        let statuses: Vec<String> = {
            let mut stmt=tx.prepare("SELECT status FROM orchestration_v2_projection_context_transfers ORDER BY context_transfer_id").unwrap();
            let rows = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            rows
        };
        assert_eq!(statuses, vec!["consumed", "superseded"]);
        tx.rollback().unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM orchestration_v2_projection_context_handoffs",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
