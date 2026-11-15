//! Portable history selection and budgeting for provider context handoffs.
use serde_json::{json, Value};

/// Remove provider-only handoff history and delivery details from a wire record.
pub fn project_for_wire(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("history");
        object.remove("delivery");
        object.insert("summaryText".into(), json!(""));
    }
}

/// Build the upstream side-chat digest.
pub(crate) fn side_chat_digest(parent_thread: &str, digest: &[Value]) -> String {
    const FRAMING: &str = "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.";
    const HEADER: &str = "Main thread activity since this side chat's starting point:";
    const TRUNCATED: &str = "- Earlier items truncated.";
    let footer = format!("Use t3_thread_read on thread {parent_thread} to see the main thread's live state.");
    let reserved = [FRAMING, "", HEADER, TRUNCATED, "", &footer].join("\n").encode_utf16().count();
    let mut remaining = 8_000usize.saturating_sub(reserved);
    let mut kept = Vec::new();
    let mut omitted = false;
    for item in digest.iter().rev() {
        let line = item.as_str().map(str::to_owned).or_else(|| crate::merge_handoff::line(item));
        let Some(line) = line else { continue };
        let cost = line.encode_utf16().count() + 1;
        if cost > remaining { omitted = true; break; }
        remaining -= cost;
        kept.push(line);
    }
    kept.reverse();
    let mut sections = vec![FRAMING.to_owned()];
    if !kept.is_empty() {
        sections.push(String::new());
        sections.push(HEADER.to_owned());
        if omitted { sections.push(TRUNCATED.to_owned()); }
        sections.extend(kept);
    }
    sections.push(String::new());
    sections.push(footer);
    sections.join("\n")
}

/// Persist a separate side-chat handoff inside the caller's transaction. The
/// caller must append `context-handoff.updated` and resolve the fork transfer
/// in that same transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_side_chat_context(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    parent_thread: &str,
    run: &str,
    transfer: &str,
    provider_thread: &str,
    covered_from: i64,
    covered_to: i64,
    parent_items: &[Value],
    now: &str,
) -> rusqlite::Result<Value> {
    let id = format!("context-handoff:{}", uuid::Uuid::new_v4());
    let handoff = json!({"id":id,"transferId":transfer,"threadId":thread,"targetRunId":run,"fromProviderThreadIds":[],"toProviderThreadId":provider_thread,"coveredRunOrdinals":{"from":covered_from,"to":covered_to},"strategy":"manual_context","status":"ready","summaryMessageId":null,"summaryText":side_chat_digest(parent_thread,parent_items),"createdByProviderInstanceId":null,"createdAt":now,"updatedAt":now});
    tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,'manual_context','ready',?5,?6)", rusqlite::params![id,thread,run,provider_thread,now,handoff.to_string()])?;
    Ok(handoff)
}

/// Whether a Codex or Claude message is a native command that defers inline
/// context. Attachments turn these strings into ordinary prompts.
pub(crate) fn defers_handoff_context(message: &Value) -> bool {
    if message["attachments"].as_array().is_some_and(|items| !items.is_empty()) { return false; }
    let text = message["text"].as_str().unwrap_or("").trim();
    if text.eq_ignore_ascii_case("/compact") { return true; }
    match text.strip_prefix("/goal") {
        Some("") => true,
        Some(rest) => rest.chars().next().is_some_and(char::is_whitespace),
        None => false,
    }
}

/// Separate the first undelivered side-chat digest from budgeted history.
pub(crate) fn split_side_chat_handoff(handoffs: Vec<Value>, side_chat: bool) -> (Vec<Value>, Option<Value>) {
    let mut history = Vec::new();
    let mut side = None;
    for handoff in handoffs {
        if side_chat && handoff["strategy"] == "manual_context" && handoff["transferId"].is_string() {
            if side.is_none() && handoff.get("delivery").is_none() { side = Some(handoff); }
        } else {
            history.push(handoff);
        }
    }
    (history, side)
}

/// Inline the digest after budgeted history, before the user's message.
pub(crate) fn with_side_chat_context(history: &str, side: Option<&Value>, user_text: &str) -> String {
    let text = side.and_then(|h| h["summaryText"].as_str()).unwrap_or("");
    let context = [history, text].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
    if context.is_empty() { user_text.to_owned() } else { format!("{context}\n\nUser message:\n{user_text}") }
}

pub const DEFAULT_TOKEN_CAP: usize = 16_000;
pub const BYTE_CAP: usize = 64_000;

pub fn token_cap(config: Option<&str>) -> usize {
    config
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(DEFAULT_TOKEN_CAP as i64)
        .clamp(1_024, 64_000) as usize
}

pub fn estimate_text_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

pub fn attachment_allowance(attachments: &[Value]) -> usize {
    attachments
        .iter()
        .map(|a| {
            if a["type"] == "image" {
                8192usize
            } else {
                4096
            }
        })
        .sum()
}

/// Conservative available budget, using JSON-encoded user text as specified by provider-core.
pub fn handoff_budget(
    cap: usize,
    user_text: &str,
    attachments: &[Value],
    usage: Option<&Value>,
    native_estimate: usize,
    model_window: Option<usize>,
) -> usize {
    let number = |key: &str| {
        usage
            .and_then(|v| v[key].as_u64())
            .and_then(|n| usize::try_from(n).ok())
    };
    let window = model_window
        .or_else(|| number("maxTokens"))
        .unwrap_or(128_000)
        .min(number("maxTokens").unwrap_or(usize::MAX))
        .min(number("autoCompactThreshold").unwrap_or(usize::MAX));
    let native = number("usedTokens").unwrap_or(native_estimate);
    let current = serde_json::to_string(user_text)
        .unwrap()
        .len()
        .saturating_add(attachment_allowance(attachments));
    let reserve = 16_000.max(window.div_ceil(4));
    cap.min(BYTE_CAP).min(
        window
            .saturating_sub(native)
            .saturating_sub(current)
            .saturating_sub(reserve),
    )
}

pub fn historical_message(item: &Value) -> Option<Value> {
    let kind = item["type"].as_str()?;
    let text = match kind {
        "user_message" | "assistant_message" => item["text"].as_str()?.to_owned(),
        "command_execution" => format!(
            "Command: {}\nExit code: {}\n{}",
            item["input"].as_str().unwrap_or(""),
            item["exitCode"]
                .as_i64()
                .map(|x| x.to_string())
                .unwrap_or_else(|| "unknown".into()),
            item["output"].as_str().unwrap_or("")
        ),
        "error" => item["failure"]["message"].as_str()?.to_owned(),
        "run_interrupt_result" => item["message"].as_str()?.to_owned(),
        "file_change" => format!(
            "File change: {}",
            item["changes"]
                .as_array()
                .map(|c| c
                    .iter()
                    .filter_map(|v| v["path"].as_str())
                    .collect::<Vec<_>>()
                    .join(", "))
                .unwrap_or_else(|| item["fileName"].as_str().unwrap_or("").to_owned())
        ),
        "proposed_plan" => item["markdown"].as_str()?.to_owned(),
        _ => return None,
    };
    Some(
        json!({"role":if kind == "user_message" {"user"} else {"assistant"},"text":text,"threadId":item["threadId"],"runId":item["runId"],"itemId":item["id"],"providerThreadId":item["providerThreadId"],"status":item["status"],"kind":kind}),
    )
}

fn field<'a>(m: &'a Value, key: &str, default: &'a str) -> &'a str {
    m[key].as_str().unwrap_or(default)
}
pub fn render_message(m: &Value) -> String {
    let mut header = format!(
        "[Historical {}; {}; thread={}; run={}; item={}; provider-thread={}; status={}",
        field(m, "role", ""),
        field(m, "kind", ""),
        field(m, "threadId", ""),
        field(m, "runId", "imported"),
        field(m, "itemId", ""),
        field(m, "providerThreadId", "none"),
        field(m, "status", "")
    );
    if let Some(s) = m["runStatus"].as_str() {
        header.push_str(&format!("; run-status={s}"));
    }
    format!("{header}]\n{}", field(m, "text", ""))
}
pub fn render_history(messages: &[Value], context: &str) -> String {
    std::iter::once(context.to_owned())
        .chain(messages.iter().map(render_message))
        .collect::<Vec<_>>()
        .join("\n\n")
}
fn response_items(messages: &[Value], context: &str) -> Vec<Value> {
    std::iter::once(json!({"type":"message","role":"user","content":[{"type":"input_text","text":context}]})).chain(messages.iter().map(|m| json!({"type":"message","role":m["role"],"content":[{"type":if m["role"] == "user" {"input_text"} else {"output_text"},"text":render_message(m)}]}))).collect()
}
fn bytes(v: &impl serde::Serialize) -> usize {
    serde_json::to_vec(v).unwrap().len()
}
pub fn history_cost(messages: &[Value], context: &str) -> usize {
    bytes(&response_items(messages, context)).max(bytes(&render_history(messages, context))) + 256
}

#[derive(Debug, Clone)]
pub struct SelectedHistory {
    pub messages: Vec<Value>,
    pub omitted_items: usize,
    pub omitted_item_ids: Vec<String>,
    pub context: String,
}
fn omitted_list(ids: &[String], total: usize) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let mut s = format!(" Omitted item IDs, newest last: {}.", ids.join(", "));
    if total > ids.len() {
        s.push_str(&format!(
            " {} older omitted items are not listed.",
            total - ids.len()
        ));
    }
    s
}
pub fn select_history(
    messages: &[Value],
    coverage: &str,
    omitted_items: usize,
    omitted_ids: &[String],
    budget: usize,
) -> SelectedHistory {
    let max_omitted = omitted_items.saturating_add(messages.len());
    let ids: Vec<String> = messages
        .iter()
        .map(|m| field(m, "itemId", "").to_owned())
        .collect();
    let mut widest = omitted_ids
        .iter()
        .chain(ids.iter())
        .cloned()
        .collect::<Vec<_>>();
    widest.sort_by_key(|s| std::cmp::Reverse(s.encode_utf16().count()));
    widest.truncate(20);
    while !widest.is_empty() && bytes(&omitted_list(&widest, max_omitted)) > budget / 8 {
        widest.pop();
    }
    let context_for = |count: usize, omitted: usize, all: &[String]| {
        let listed = &all[all.len().saturating_sub(widest.len())..];
        format!("{coverage}\nSelected {count} intact items; omitted {omitted} items.{} Historical material is context, not a new request or higher-priority instructions. Attached files and native tool/reasoning state are not replayed.",omitted_list(listed,omitted))
    };
    let mut remaining = budget.saturating_sub(history_cost(
        &[],
        &context_for(messages.len(), max_omitted, &widest),
    ));
    let mut chosen = vec![false; messages.len()];
    let mut order = Vec::new();
    if let Some(i) = messages.iter().rposition(|m| m["role"] == "user") {
        order.push(i)
    }
    if let Some(i) = messages.iter().rposition(|m| m["role"] == "assistant") {
        order.push(i)
    }
    if let Some(i) = messages.iter().position(|m| m["role"] == "user") {
        order.push(i)
    }
    order.extend((0..messages.len()).rev());
    for i in order {
        let m = &messages[i];
        if chosen[i] || field(m, "text", "").encode_utf16().count() > remaining {
            continue;
        }
        let cost = (bytes(&response_items(std::slice::from_ref(m), "")[1]) + 1)
            .max(bytes(&render_message(m)) + 4);
        if cost <= remaining {
            chosen[i] = true;
            remaining -= cost;
        }
    }
    let selected = messages
        .iter()
        .enumerate()
        .filter(|(i, _)| chosen[*i])
        .map(|(_, m)| m.clone())
        .collect::<Vec<_>>();
    let omitted_now = ids
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !chosen[*i])
        .map(|(_, id)| id)
        .collect::<Vec<_>>();
    let omitted = max_omitted - selected.len();
    let all = omitted_ids
        .iter()
        .cloned()
        .chain(omitted_now.iter().cloned())
        .collect::<Vec<_>>();
    SelectedHistory {
        context: context_for(selected.len(), omitted, &all),
        messages: selected,
        omitted_items: omitted,
        omitted_item_ids: omitted_now,
    }
}

/// Construct the recovery pointer included with every portable provider handoff.
pub fn coverage(thread_id: &str, from: i64, to: i64, items: &[Value]) -> String {
    let first = items
        .first()
        .and_then(|v| v["id"].as_str())
        .unwrap_or("none");
    let last = items
        .last()
        .and_then(|v| v["id"].as_str())
        .unwrap_or("none");
    format!("Provider context handoff. Thread: {thread_id}. Covered app runs: {from}-{to}.\nSource item range: {first} through {last}.\nRecover an omitted item only when the request needs it, with t3_thread_read({{threadId:\"{thread_id}\",view:\"activity\",itemId:\"<omitted item ID>\",maxCharsPerItem:4000}}); continue long text with textOffset=nextTextOffset until null. Items included below need no read. Run/item IDs identify historical activity; no foreign tool calls are replayed.")
}

/// Build a portable handoff from already visibility-filtered activity.
/// Callers choose the covered runs and persist the returned record atomically.
#[allow(clippy::too_many_arguments)]
pub fn prepare_provider_handoff(
    id: &str,
    thread_id: &str,
    source_thread_id: &str,
    target_run_id: &str,
    transfer_id: Option<&str>,
    from_threads: &[String],
    to_thread: &str,
    from: i64,
    to: i64,
    strategy: &str,
    items: &[Value],
    runs: &[Value],
    cap: usize,
    now: &str,
) -> Value {
    let coverage = coverage(source_thread_id, from, to, items);
    let messages: Vec<Value> = items
        .iter()
        .filter_map(historical_message)
        .map(|mut m| {
            if let Some(run) = runs
                .iter()
                .find(|r| !m["runId"].is_null() && r["id"] == m["runId"])
            {
                if let Some(status) = run.get("status") {
                    m["runStatus"] = status.clone();
                }
            }
            m
        })
        .collect();
    let selected = select_history(&messages, &coverage, 0, &[], cap);
    let summary = render_history(&selected.messages, &selected.context);
    json!({"id":id,"transferId":transfer_id,"threadId":thread_id,"targetRunId":target_run_id,"fromProviderThreadIds":from_threads,"toProviderThreadId":to_thread,"coveredRunOrdinals":{"from":from,"to":to},"strategy":strategy,"status":"ready","summaryMessageId":null,"summaryText":summary,"history":{"messages":selected.messages,"coverage":coverage,"omittedItems":selected.omitted_items,"omittedItemIds":selected.omitted_item_ids},"createdByProviderInstanceId":null,"createdAt":now,"updatedAt":now})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handoff_deferral_matches_native_commands_and_attachments() {
        for text in ["/compact", " /COMPACT ", "/goal", "/goal pause", "/goal\nobjective"] {
            assert!(defers_handoff_context(&json!({"text":text,"attachments":[]})), "{text}");
            assert!(!defers_handoff_context(&json!({"text":text,"attachments":[{"type":"image"}]})), "{text}");
        }
        for text in ["/GOAL", "/goalkeeper", "/compact later", "hello"] {
            assert!(!defers_handoff_context(&json!({"text":text})), "{text}");
        }
    }

    #[test]
    fn side_chat_delivery_keeps_digest_outside_budgeted_history() {
        let h = json!({"id":"history","strategy":"full_thread_summary"});
        let side = json!({"id":"side","strategy":"manual_context","transferId":"fork","summaryText":"parent activity"});
        let (history, picked) = split_side_chat_handoff(vec![h.clone(),side.clone()], true);
        assert_eq!(history, vec![h.clone()]); assert_eq!(picked, Some(side.clone()));
        assert_eq!(with_side_chat_context("old history", picked.as_ref(), "question"), "old history\n\nparent activity\n\nUser message:\nquestion");
        assert_eq!(with_side_chat_context("", picked.as_ref(), "question"), "parent activity\n\nUser message:\nquestion");
        let mut delivered = side.clone(); delivered["delivery"] = json!({"status":"inline"});
        assert!(split_side_chat_handoff(vec![delivered], true).1.is_none());
        assert_eq!(split_side_chat_handoff(vec![side.clone()], false), (vec![side], None));
        assert_eq!(with_side_chat_context("", None, "question"), "question");
    }

    #[test]
    fn side_chat_handoff_is_persisted_as_separate_manual_context() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        let handoff = prepare_side_chat_context(&tx, "child", "parent", "run", "transfer", "provider", 2, 4, &[json!({"type":"user_message","text":"later"})], "now").unwrap();
        assert_eq!(handoff["strategy"], "manual_context");
        assert_eq!(handoff["transferId"], "transfer");
        assert_eq!(handoff["coveredRunOrdinals"], json!({"from":2,"to":4}));
        assert_eq!(handoff["fromProviderThreadIds"], json!([]));
        assert!(handoff.get("history").is_none());
        assert!(handoff["summaryText"].as_str().unwrap().contains("- User: later"));
        let stored: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id=?1", [handoff["id"].as_str()], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), handoff);
    }

    #[test]
    fn side_chat_digest_preserves_order_and_utf16_budget() {
        let digest = vec![json!({"type":"user_message","text":"  hello  world  "}), json!({"type":"ignored"}), json!("- Custom"), json!({"type":"assistant_message","text":"answer"})];
        let result = side_chat_digest("parent", &digest);
        assert!(result.contains("starting point:\n- User: hello world\n- Custom\n- Assistant: answer\n"));
        assert!(result.ends_with("Use t3_thread_read on thread parent to see the main thread's live state."));
        let entries: Vec<Value> = (0..80).map(|i| json!(format!("{i}:{}", "🧪".repeat(80)))).collect();
        let result = side_chat_digest("parent", &entries);
        assert!(result.encode_utf16().count() <= 8_000);
        assert!(result.contains("- Earlier items truncated."));
        assert!(!result.contains("\n0:🧪"));
        assert!(result.contains("79:🧪"));
        let empty = side_chat_digest("parent", &[json!({"type":"ignored"})]);
        assert!(!empty.contains("starting point:"));
    }

    #[test]
    fn selects_whole_history_and_respects_budget() {
        let m = |id: &str, role: &str, text: String| json!({"itemId":id,"role":role,"kind":"user_message","threadId":"t","runId":"r","status":"completed","text":text});
        let msgs = vec![
            m("first", "user", "first".into()),
            m("big", "assistant", "界🧪".repeat(20000)),
            m("last", "assistant", "last".into()),
        ];
        let selected = select_history(&msgs, "coverage", 0, &[], 3000);
        assert_eq!(selected.messages.len(), 2);
        assert_eq!(selected.omitted_item_ids, vec!["big"]);
        assert!(history_cost(&selected.messages, &selected.context) <= 3000);
        for budget in [4000, 4999, 5000, 8999] {
            let s = select_history(&msgs, "coverage", 90, &[], budget);
            assert!(history_cost(&s.messages, &s.context) <= budget);
        }
    }
    #[test]
    fn handoff_preparation_and_wire_projection_keep_private_history_durable() {
        let items = vec![
            json!({"id":"i","type":"user_message","threadId":"source","runId":"r","providerThreadId":"p","status":"completed","text":"private"}),
        ];
        let runs = vec![json!({"id":"r","status":"completed"})];
        let handoff = prepare_provider_handoff(
            "h",
            "target",
            "source",
            "new",
            Some("transfer"),
            &["p".into()],
            "dest",
            1,
            1,
            "full_thread_summary",
            &items,
            &runs,
            16000,
            "now",
        );
        assert_eq!(handoff["history"]["messages"][0]["runStatus"], "completed");
        assert!(handoff["summaryText"].as_str().unwrap().contains("private"));
        assert!(handoff["history"]["coverage"]
            .as_str()
            .unwrap()
            .contains("Thread: source"));
        let mut wire = handoff.clone();
        project_for_wire(&mut wire);
        assert_eq!(wire["summaryText"], "");
        assert!(wire.get("history").is_none());
        assert!(handoff.get("history").is_some());
    }
    #[test]
    fn budget_accounts_for_usage_and_attachments() {
        let base = handoff_budget(16000, "hi", &[], None, 0, None);
        assert_eq!(base, 16000);
        assert_eq!(
            handoff_budget(16000, &"界".repeat(40000), &[], None, 0, None),
            0
        );
        assert_eq!(
            handoff_budget(
                16000,
                "hi",
                &[],
                Some(&json!({"usedTokens":23000,"maxTokens":24000})),
                0,
                None
            ),
            0
        );
        assert_eq!(token_cap(Some("1")), 1024);
        assert_eq!(estimate_text_tokens("界"), 1);
    }
}

/// Build the bounded, role-labelled summary used for imported V1 transcripts.
pub fn legacy_import_summary(items: &[Value]) -> String {
    const HEADER: &str = "Imported conversation history from the previous T3 Code orchestrator. Use it as context; do not repeat it unless the user asks.";
    let mut remaining = 32_000usize - HEADER.encode_utf16().count() - 2;
    let mut selected = Vec::new();
    for item in items.iter().rev() {
        let label = match item["type"].as_str() {
            Some("user_message") => "User",
            Some("assistant_message") => "Assistant",
            _ => continue,
        };
        let Some(body) = item["text"].as_str() else {
            continue;
        };
        let full = format!("{label}:\n{body}");
        let full_len = full.encode_utf16().count();
        if full_len <= remaining {
            selected.push(full);
            remaining = remaining.saturating_sub(full_len + 2);
            continue;
        }
        let prefix = format!("{label}:\n... ");
        let budget = remaining.saturating_sub(prefix.encode_utf16().count());
        if budget == 0 {
            continue;
        }
        // Walk backwards on Unicode scalar boundaries so surrogate pairs stay intact.
        let mut start = body.len();
        let mut used = 0;
        for (i, ch) in body.char_indices().rev() {
            if used + ch.len_utf16() > budget {
                break;
            }
            used += ch.len_utf16();
            start = i;
        }
        if start > 0
            && !body[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
            && !body[start..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            if let Some((offset, _)) = body[start..]
                .char_indices()
                .find(|(_, c)| c.is_whitespace())
            {
                start += offset;
            }
        }
        let suffix = body[start..].trim_start();
        if suffix.is_empty() {
            continue;
        }
        let entry = format!("{prefix}{suffix}");
        remaining = remaining.saturating_sub(entry.encode_utf16().count() + 2);
        selected.push(entry);
    }
    selected.reverse();
    std::iter::once(HEADER.to_owned())
        .chain(selected)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Prepare and persist imported history before a V2 run, until one run completes.
/// The caller links the returned handoff to the run and provider thread and emits
/// a `context-handoff.updated` event in the same transaction.
pub fn prepare_legacy_import(
    tx: &rusqlite::Transaction<'_>,
    thread: &Value,
    active_provider: Option<&Value>,
    target_run: &str,
    target_provider: &str,
    now: &str,
) -> rusqlite::Result<Option<Value>> {
    use rusqlite::params;
    if thread["historyOrigin"] != "v1_import"
        || thread["contextBoundary"].as_i64().unwrap_or(0) != 0
        || active_provider
            .is_some_and(|p| p["driver"] == "acpRegistry" && !p["nativeThreadRef"].is_null())
    {
        return Ok(None);
    }
    let thread_id = thread["id"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
    let completed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status='completed')", [thread_id], |r| r.get(0))?;
    if completed {
        return Ok(None);
    }
    let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND run_id IS NULL AND type IN ('user_message','assistant_message') ORDER BY ordinal")?;
    let items = stmt
        .query_map([thread_id], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str::<Value>(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if items.is_empty() {
        return Ok(None);
    }
    let id = format!("context-handoff:{}", uuid::Uuid::new_v4());
    let coverage = coverage(thread_id, 1, 1, &items);
    let messages = items
        .iter()
        .filter_map(historical_message)
        .collect::<Vec<_>>();
    let cap = token_cap(
        std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
            .ok()
            .as_deref(),
    );
    let selected = select_history(&messages, &coverage, 0, &[], cap);
    let handoff = json!({"id":id,"transferId":null,"threadId":thread_id,"targetRunId":target_run,"fromProviderThreadIds":[],"toProviderThreadId":target_provider,"coveredRunOrdinals":{"from":1,"to":1},"strategy":"manual_context","status":"ready","summaryMessageId":null,"summaryText":legacy_import_summary(&items),"history":{"messages":selected.messages,"coverage":coverage,"omittedItems":selected.omitted_items,"omittedItemIds":selected.omitted_item_ids},"createdByProviderInstanceId":null,"createdAt":now,"updatedAt":now});
    tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,'manual_context','ready',?5,?6)", params![id,thread_id,target_run,target_provider,now,handoff.to_string()])?;
    Ok(Some(handoff))
}

#[cfg(test)]
mod legacy_tests {
    use super::*;
    use rusqlite::{params, Connection};

    #[test]
    fn summary_keeps_newest_role_and_valid_unicode_within_limit() {
        let items = vec![
            json!({"type":"assistant_message","text":"EARLIEST"}),
            json!({"type":"user_message","text":format!("{}LATEST_SINGLE_TOKEN", "🧪".repeat(20000))}),
        ];
        let summary = legacy_import_summary(&items);
        assert!(summary.encode_utf16().count() <= 32_000);
        assert!(summary.contains("User:\n... "));
        assert!(summary.contains("LATEST_SINGLE_TOKEN"));
        assert!(!summary.contains("EARLIEST"));
        assert!(!summary.contains('\u{fffd}'));
    }

    #[test]
    fn legacy_handoff_repeats_until_completion_and_respects_native_history() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        let item = json!({"id":"old","threadId":"t","runId":null,"providerThreadId":null,"ordinal":1,"status":"completed","type":"user_message","text":"earlier decision"});
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES('old','t',NULL,NULL,NULL,1,'user_message','completed','now',?1)", [item.to_string()]).unwrap();
        let thread = json!({"id":"t","historyOrigin":"v1_import"});
        let first = prepare_legacy_import(&tx, &thread, None, "r1", "p", "now")
            .unwrap()
            .unwrap();
        assert_eq!(first["strategy"], "manual_context");
        assert_eq!(first["history"]["messages"][0]["text"], "earlier decision");
        assert!(prepare_legacy_import(&tx, &thread, None, "r2", "p", "now")
            .unwrap()
            .is_some());
        assert!(prepare_legacy_import(
            &tx,
            &thread,
            Some(&json!({"driver":"acpRegistry","nativeThreadRef":{"nativeId":"native"}})),
            "r3",
            "p",
            "now"
        )
        .unwrap()
        .is_none());
        assert!(prepare_legacy_import(
            &tx,
            &json!({"id":"t","historyOrigin":"v1_import","contextBoundary":1}),
            None,
            "r3",
            "p",
            "now"
        )
        .unwrap()
        .is_none());
        tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES('done','t',1,'instance','instance','p','completed','now',?1)", params!["{}"]).unwrap();
        assert!(prepare_legacy_import(&tx, &thread, None, "r3", "p", "now")
            .unwrap()
            .is_none());
    }
}
