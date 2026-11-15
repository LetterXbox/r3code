//! Cross-thread search for the MCP thread toolkit.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub fn definitions() -> Vec<Value> {
    vec![
        json!({"name":"t3_thread_search","description":"Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive.","inputSchema":{"type":"object","properties":{"environmentId":{"type":"string"},"query":{"type":"string","minLength":2,"maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":50},"projectId":{"type":"string"}},"required":["query"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false}}),
    ]
}

pub(crate) fn fold(s: &str) -> String {
    s.replace(['‘', '’'], "'")
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}
fn snippet(text: &str, offset: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut start = offset.saturating_sub(24).min(chars.len());
    if start > 0 {
        if let Some(i) = chars[start..offset.min(chars.len())]
            .iter()
            .position(|c| c.is_whitespace())
        {
            start += i + 1;
        }
    }
    let end = (start + 480).min(chars.len());
    let cleaned = chars[start..end]
        .iter()
        .collect::<String>()
        .replace("**", "")
        .replace('`', "");
    let clean = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = clean.chars().count() > 238 || end < chars.len();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        clean.chars().take(238).collect::<String>(),
        if cut { "…" } else { "" }
    )
}
pub(crate) fn pr_fields(payload: &Value) -> Vec<String> {
    let mut links = Vec::new();
    if let Some(v) = payload.get("branchPullRequest").filter(|v| v.is_object()) {
        links.push((v, false));
    }
    let mut prs: Vec<&Value> = payload
        .get("pullRequests")
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter(|x| x.get("source").and_then(Value::as_str) != Some("stack-dismissed"))
                .collect()
        })
        .unwrap_or_default();
    prs.sort_by(|a, b| {
        let date = |v: &Value| {
            v.pointer("/snapshot/updatedAt")
                .or_else(|| v.get("linkedAt"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        date(b).cmp(&date(a))
    });
    if payload
        .get("pullRequests")
        .and_then(Value::as_array)
        .is_some_and(|p| !p.is_empty())
    {
        links.extend(prs.into_iter().enumerate().map(|(i, v)| (v, i < 3)));
    } else if let Some(v) = payload.get("linkedPullRequest").filter(|v| v.is_object()) {
        links.push((v, false));
    }
    let mut fields = Vec::new();
    for (pr, include_title) in links {
        if let Some(number) = pr.get("number").and_then(Value::as_u64) {
            fields.push(format!("#{number}"));
            if let Some(repo) = pr.get("repository").and_then(Value::as_str) {
                fields.push(format!("{repo}#{number}"));
            }
        }
        if let Some(url) = pr.get("url").and_then(Value::as_str) {
            fields.push(url.to_owned());
        }
        if include_title {
            if let Some(title) = pr.pointer("/snapshot/title").and_then(Value::as_str) {
                fields.push(title.to_owned());
            }
        }
    }
    fields
}
fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x9fff | 0xf900..=0xfaff)
}
fn searchable_cjk(c: char) -> bool {
    cjk(c) || ('\u{ac00}'..='\u{d7af}').contains(&c)
}
fn starts_word(chars: &[char], i: usize) -> bool {
    let Some(&c) = chars.get(i) else { return false };
    if !c.is_alphanumeric() {
        return true;
    }
    let prev = i.checked_sub(1).and_then(|j| chars.get(j)).copied();
    if matches!(prev, Some('\'' | '’')) && i >= 2 && chars[i - 2].is_alphanumeric() {
        return false;
    }
    match prev {
        None => true,
        Some(p) => {
            !p.is_alphanumeric()
                || (p.is_lowercase() && c.is_uppercase())
                || (p.is_uppercase()
                    && c.is_uppercase()
                    && chars.get(i + 1).is_some_and(|n| n.is_lowercase()))
                || p.is_numeric() != c.is_numeric()
                || cjk(c)
        }
    }
}
fn message_match(text: &str, words: &[&str]) -> Option<(f64, usize)> {
    // Fold one source character at a time so positions still point into the
    // displayed text even when normalization expands or removes characters.
    let original: Vec<char> = text.chars().collect();
    let mut normalized = String::new();
    let mut offsets = Vec::new();
    for (i, c) in original.iter().enumerate() {
        for f in fold(&c.to_string()).chars() {
            normalized.push(f);
            offsets.push(i);
        }
    }
    let mut quality: f64 = 1.0;
    let mut positions: Vec<Vec<usize>> = Vec::new();
    let mut long_count = 0;
    for word in words {
        let len = word.chars().count();
        let long = len >= 3 || (len == 2 && word.chars().any(searchable_cjk));
        if long {
            long_count += 1;
        }
        let mut best: f64 = 0.0;
        let mut places = Vec::new();
        for (byte, _) in normalized.match_indices(word) {
            let pos = normalized[..byte].chars().count();
            let start = offsets[pos];
            let end = offsets.get(pos + len - 1).copied().unwrap_or(start) + 1;
            let mut run_start = start;
            while run_start > 0 && original[run_start - 1].is_alphanumeric() {
                run_start -= 1;
            }
            let mut run_end = end;
            while run_end < original.len() && original[run_end].is_alphanumeric() {
                run_end += 1;
            }
            let run = &original[run_start..run_end];
            if start > run_start
                && run.len() >= 7
                && run.iter().all(|c| c.is_ascii_hexdigit())
                && run.iter().any(|c| c.is_ascii_digit())
            {
                continue;
            }
            let q = if !starts_word(&original, start) {
                0.3
            } else if end >= original.len()
                || !original[end].is_alphanumeric()
                || starts_word(&original, end)
            {
                1.0
            } else {
                0.8
            };
            if q > best {
                best = q;
                places.clear();
                places.push(start);
            } else if q == best {
                places.push(start);
            }
        }
        if best == 0.0 || (len < 4 && best < 0.8) {
            return None;
        }
        if long {
            quality = quality.min(best);
        }
        positions.push(places);
    }
    if words.len() > 1 {
        // Phrase boundaries are whole words, with arbitrary whitespace.
        let pattern = format!(
            r"(?:^|[^\p{{L}}\p{{N}}])({})(?:$|[^\p{{L}}\p{{N}}])",
            words
                .iter()
                .map(|w| regex::escape(w))
                .collect::<Vec<_>>()
                .join(r"\s+")
        );
        if let Ok(re) = regex::Regex::new(&pattern) {
            if let Some(m) = re.captures(&normalized).and_then(|c| c.get(1)) {
                let pos = normalized[..m.start()].chars().count();
                return Some((quality + 0.25, offsets[pos]));
            }
        }
    }
    let mut all: Vec<(usize, usize)> = positions
        .iter()
        .enumerate()
        .flat_map(|(word, p)| p.iter().map(move |&i| (i, word)))
        .collect();
    all.sort_unstable();
    let mut counts = vec![0; positions.len()];
    let (mut covered, mut left) = (0, 0);
    let (mut start, mut span) = (0, usize::MAX);
    for right in 0..all.len() {
        let w = all[right].1;
        counts[w] += 1;
        if counts[w] == 1 {
            covered += 1;
        }
        while covered == positions.len() {
            let width = all[right].0 - all[left].0;
            if width < span {
                start = all[left].0;
                span = width;
            }
            let w = all[left].1;
            counts[w] -= 1;
            if counts[w] == 0 {
                covered -= 1;
            }
            left += 1;
        }
    }
    if long_count > 1 && span <= 60 {
        quality += 0.1;
    }
    Some((quality, start))
}
#[derive(Clone)]
struct Hit {
    source: String,
    message_id: String,
    text: String,
    date: String,
    count: usize,
    quality: f64,
    offset: usize,
}
#[derive(Clone)]
struct Thread {
    id: String,
    project: String,
    title: String,
    payload: Value,
    project_title: String,
    updated: String,
}

/// Search threads using an optional caller project and caller thread. The caller must
/// perform authorization and environment routing before invoking this function.
pub fn search(
    db: &Connection,
    args: &Value,
    caller_project: Option<&str>,
    caller_thread: Option<&str>,
    environment_id: &str,
) -> Result<Value, String> {
    search_impl(
        db,
        args,
        caller_project,
        caller_thread,
        environment_id,
        false,
    )
}

/// Message-only search used by the cross-thread RPC.
pub fn search_messages(db: &Connection, args: &Value) -> Result<Value, String> {
    search_impl(db, args, None, None, "", true)
}

fn search_impl(
    db: &Connection,
    args: &Value,
    caller_project: Option<&str>,
    caller_thread: Option<&str>,
    environment_id: &str,
    messages_only: bool,
) -> Result<Value, String> {
    if !args.as_object().is_some_and(|o| {
        o.keys()
            .all(|k| ["query", "limit", "projectId"].contains(&k.as_str()))
    }) {
        return Err("Invalid search arguments.".into());
    }
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or("query is required")?
        .trim();
    if !(2..=200).contains(&query.encode_utf16().count()) {
        return Err("query must contain between 2 and 200 characters".into());
    }
    let limit = match args.get("limit") {
        None => 50,
        Some(v) => v
            .as_u64()
            .filter(|v| (1..=50).contains(v))
            .ok_or("limit must be between 1 and 50")? as usize,
    };
    let project = match args.get("projectId") {
        None => caller_project,
        Some(v) => Some(v.as_str().ok_or("projectId must be a string")?),
    };
    let normalized =
        fold(query.trim_matches(|c: char| c.is_whitespace() || "\"'`“”‘’".contains(c)));
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.is_empty() {
        return Ok(if messages_only {
            json!({"matches":[]})
        } else {
            json!({"currentThreadId":caller_thread,"matches":[]})
        });
    }
    let mut stmt = db.prepare("SELECT t.thread_id,t.project_id,t.title,t.payload_json,p.title,t.updated_at FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND p.deleted_at IS NULL AND (?1 IS NULL OR t.project_id=?1) AND json_extract(t.payload_json,'$.lineage.relationshipToParent') IS NOT 'subagent' AND json_extract(t.payload_json,'$.lineage.sideChat') IS NOT 1").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![project], |r| {
            let p: String = r.get(3)?;
            Ok(Thread {
                id: r.get(0)?,
                project: r.get(1)?,
                title: r.get(2)?,
                payload: serde_json::from_str(&p).unwrap_or(Value::Null),
                project_title: r.get(4)?,
                updated: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut titles: Vec<(i32, &Thread)> = rows
        .iter()
        .filter_map(|t| {
            let prs = pr_fields(&t.payload);
            let mut fields = vec![
                t.title.as_str(),
                t.payload
                    .get("branch")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                t.project_title.as_str(),
                t.id.as_str(),
            ];
            fields.extend(prs.iter().map(String::as_str));
            fields
                .iter()
                .enumerate()
                .filter_map(|(i, f)| {
                    let f = fold(f);
                    if words.iter().all(|w| f.contains(w)) {
                        Some(
                            if f == normalized {
                                100
                            } else if f.starts_with(&normalized) {
                                80
                            } else {
                                60
                            } - i as i32 * 5,
                        )
                    } else {
                        None
                    }
                })
                .max()
                .map(|score| (score, t))
        })
        .collect();
    titles.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.updated.cmp(&a.1.updated))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    if messages_only {
        titles.clear();
    }
    titles.truncate(limit);
    let excluded: HashSet<&str> = titles.iter().map(|(_, t)| t.id.as_str()).collect();
    let by_id: HashMap<&str, &Thread> = rows.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut hits: HashMap<String, Hit> = HashMap::new();
    // JavaScript Map retains the first insertion position even when a later
    // message replaces the best hit. Stable upstream sorting preserves it.
    let mut hit_order: HashMap<String, usize> = HashMap::new();
    if words.iter().any(|w| {
        w.chars().count() >= 3 || (w.chars().count() == 2 && w.chars().any(searchable_cjk))
    }) {
        let has_search_text: bool = db.prepare("SELECT 1 FROM pragma_table_info('orchestration_v2_projection_messages') WHERE name='search_text'").and_then(|mut s|s.exists([])).map_err(|e|e.to_string())?;
        let text = if has_search_text {
            "COALESCE(search_text,json_extract(payload_json,'$.text'))"
        } else {
            "json_extract(payload_json,'$.text')"
        };
        let indexed: bool = words
            .iter()
            .filter(|w| w.chars().count() >= 3)
            .all(|w| w.chars().count() >= 3)
            && words.iter().any(|w| w.chars().count() >= 3)
            && db
                .prepare("SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search'")
                .and_then(|mut s| s.exists([]))
                .map_err(|e| e.to_string())?;
        let indexed = indexed
            && !words
                .iter()
                .any(|w| w.chars().count() == 2 && w.chars().any(searchable_cjk));
        let index_words: Vec<String> = query
            .trim_matches(|c: char| c.is_whitespace() || "\"'`“”‘’".contains(c))
            .replace(['‘', '’'], "'")
            .nfc()
            .collect::<String>()
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let match_query = index_words
            .iter()
            .filter(|w| w.chars().count() >= 3)
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let sql = if indexed {
            format!("SELECT m.thread_id,m.role,{},m.created_at,m.message_id FROM orchestration_v2_message_search f JOIN orchestration_v2_projection_messages m ON m.rowid=f.rowid WHERE orchestration_v2_message_search MATCH ?1 AND f.rowid >= coalesce((SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH ?1 ORDER BY rowid DESC LIMIT 1 OFFSET 9999),0) AND m.streaming=0 AND (m.role='assistant' OR (m.role='user' AND COALESCE(json_extract(m.payload_json,'$.createdBy'),'user')='user')) AND m.message_id NOT LIKE 'async-answer:%' ORDER BY f.rowid DESC", text.replace("search_text", "m.search_text").replace("payload_json", "m.payload_json"))
        } else {
            format!("SELECT thread_id,role,{text},created_at,message_id FROM orchestration_v2_projection_messages WHERE rowid > (SELECT coalesce(max(rowid),0)-20000 FROM orchestration_v2_projection_messages) AND streaming=0 AND (role='assistant' OR (role='user' AND COALESCE(json_extract(payload_json,'$.createdBy'),'user')='user')) AND message_id NOT LIKE 'async-answer:%' ORDER BY rowid DESC")
        };
        let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
        let mut results = if indexed {
            stmt.query(params![match_query])
        } else {
            stmt.query([])
        }
        .map_err(|e| e.to_string())?;
        let markdown = regex::Regex::new(r"!?\[([^\]\n]*)\]\([^\)\s]*\)").unwrap();
        let mut candidates = 0;
        while let Some(r) = results.next().map_err(|e| e.to_string())? {
            let id: String = r.get(0).map_err(|e| e.to_string())?;
            if excluded.contains(id.as_str()) || !by_id.contains_key(id.as_str()) {
                continue;
            }
            let source: String = r.get(1).map_err(|e| e.to_string())?;
            let Some(raw): Option<String> = r.get(2).map_err(|e| e.to_string())? else {
                continue;
            };
            let placeholder = raw
                .strip_prefix("Ultrathink:")
                .map(str::trim_start)
                .unwrap_or(&raw);
            if placeholder == "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]" { continue; }
            if !words.iter().all(|w| fold(&raw).contains(w)) {
                continue;
            }
            candidates += 1;
            if candidates > 2000 {
                break;
            }
            let text = markdown.replace_all(&raw, "$1").into_owned();
            let Some((quality, offset)) = message_match(&text, &words) else {
                continue;
            };
            let date: String = r.get(3).map_err(|e| e.to_string())?;
            let hit = Hit {
                source,
                message_id: r.get(4).map_err(|e| e.to_string())?,
                text,
                date,
                count: 1,
                quality,
                offset,
            };
            let next_order = hit_order.len();
            hit_order.entry(id.clone()).or_insert(next_order);
            hits.entry(id)
                .and_modify(|h| {
                    if hit.quality > h.quality {
                        *h = hit.clone();
                    } else if hit.quality == h.quality {
                        let count = h.count + 1;
                        if (hit.source == "user" && h.source != "user")
                            || (hit.source == h.source && hit.date > h.date)
                        {
                            *h = hit.clone();
                        }
                        h.count = count;
                    }
                })
                .or_insert(hit);
        }
    }
    let mut messages: Vec<_> = hits.into_iter().collect();
    messages.sort_by(|a, b| {
        b.1.quality
            .total_cmp(&a.1.quality)
            .then_with(|| b.1.count.cmp(&a.1.count))
            .then_with(|| b.1.date.cmp(&a.1.date))
            .then_with(|| hit_order[&a.0].cmp(&hit_order[&b.0]))
    });
    messages.truncate(50);
    let slots = if messages_only {
        0
    } else {
        messages.len().min(limit / 5)
    };
    let mut matches = Vec::new();
    let link = |t: &Thread| crate::mcp_http::thread_link(environment_id, &t.id, Some(&t.title));
    for (_, t) in titles.into_iter().take(limit - slots) {
        matches.push(json!({"threadId":t.id,"projectId":t.project,"title":t.title,"source":"title","link":link(t)}));
    }
    for (id, hit) in messages.into_iter().take(limit - matches.len()) {
        let t = by_id[id.as_str()];
        if messages_only {
            matches.push(json!({"threadId":id,"projectId":t.project,"messageId":hit.message_id,"source":hit.source,"snippet":snippet(&hit.text,hit.offset),"messageCreatedAt":hit.date,"quality":hit.quality,"hits":hit.count}));
        } else {
            matches.push(json!({"threadId":id,"projectId":t.project,"title":t.title,"source":hit.source,"snippet":snippet(&hit.text,hit.offset),"messageCreatedAt":hit.date,"link":link(t)}));
        }
    }
    if messages_only {
        Ok(json!({"matches":matches}))
    } else {
        Ok(json!({"currentThreadId":caller_thread,"matches":matches}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_and_excludes_hidden_threads_and_finds_messages() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,streaming INTEGER,payload_json TEXT,created_at TEXT); INSERT INTO projection_projects VALUES('p','Project',NULL),('q','Other',NULL); INSERT INTO orchestration_v2_projection_threads VALUES('a','p','Release plan','{}','2026',NULL,NULL),('b','p','Other','{}','2025',NULL,NULL),('c','p','Release subagent','{\"lineage\":{\"relationshipToParent\":\"subagent\"}}','2026',NULL,NULL),('d','q','Release external','{}','2026',NULL,NULL); INSERT INTO orchestration_v2_projection_messages VALUES('m','b','user',0,'{\"text\":\"Discuss release plan today\"}','2026');").unwrap();
        let result = search(
            &db,
            &json!({"query":"release","limit":5}),
            Some("p"),
            Some("a"),
            "local",
        )
        .unwrap();
        assert_eq!(result["currentThreadId"], "a");
        let hits = result["matches"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["threadId"], "a");
        assert_eq!(hits[1]["threadId"], "b");
        assert_eq!(hits[1]["source"], "user");
    }
    #[test]
    fn matches_pull_requests_and_grades_visible_message_text() {
        let fields = pr_fields(
            &json!({"pullRequests":[{"number":42,"repository":"acme/app","url":"https://example.test/42","snapshot":{"title":"Fix rendering"}}]}),
        );
        assert!(fields.contains(&"#42".to_owned()));
        assert!(fields.contains(&"Fix rendering".to_owned()));
        assert!(message_match("drafts", &["fts"]).is_none());
        assert!(
            message_match("rust code", &["rust"]).unwrap().0
                > message_match("trust code", &["rust"]).unwrap().0
        );
    }
    #[test]
    fn uses_trigram_index_for_message_candidates() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,streaming INTEGER,payload_json TEXT,created_at TEXT); CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, tokenize='trigram'); INSERT INTO projection_projects VALUES('p','Project',NULL); INSERT INTO orchestration_v2_projection_threads VALUES('a','p','Other','{}','2026',NULL,NULL); INSERT INTO orchestration_v2_projection_messages VALUES('m','a','user',0,'{\"text\":\"See [release](https://hidden.test) today\"}','2026'); INSERT INTO orchestration_v2_message_search(rowid,text) VALUES(1,'See [release](https://hidden.test) today');").unwrap();
        let result = search(&db, &json!({"query":"release"}), None, None, "local").unwrap();
        assert_eq!(result["matches"][0]["snippet"], "See release today");
        assert!(
            search(&db, &json!({"query":"hidden"}), None, None, "local").unwrap()["matches"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn rpc_returns_message_metadata_without_title_hits() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,streaming INTEGER,payload_json TEXT,created_at TEXT); INSERT INTO projection_projects VALUES('p','Project',NULL); INSERT INTO orchestration_v2_projection_threads VALUES('a','p','Release','{}','2026',NULL,NULL),('b','p','Other','{}','2026',NULL,NULL); INSERT INTO orchestration_v2_projection_messages VALUES('m','b','user',0,'{\"text\":\"release today\"}','2026');").unwrap();
        let result = search_messages(&db, &json!({"query":"release"})).unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["matches"][0]["threadId"], "b");
        assert_eq!(result["matches"][0]["messageId"], "m");
        assert_eq!(result["matches"][0]["hits"], 1);
        assert!(result.get("currentThreadId").is_none());
    }
    #[test]
    fn message_boundaries_and_closest_span_follow_visible_text() {
        assert_eq!(
            message_match("fixJSONSchema now", &["schema"]).unwrap().0,
            1.0
        );
        assert_eq!(message_match("实现全文搜索", &["搜索"]).unwrap().0, 1.0);
        assert!(message_match("7cafe52bb8", &["cafe"]).is_none());
        assert_eq!(
            message_match("café and rust", &["cafe", "rust"]).unwrap().0,
            1.1
        );
        let text = format!("rust {} rust and code", "x".repeat(100));
        let (quality, offset) = message_match(&text, &["rust", "code"]).unwrap();
        assert_eq!(quality, 1.1);
        assert!(offset > 100);
        assert_eq!(
            message_match("rust    code", &["rust", "code"]).unwrap().0,
            1.25
        );
    }
    #[test]
    fn indexed_search_excludes_streaming_and_agent_notices() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,streaming INTEGER,payload_json TEXT,created_at TEXT); CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, tokenize='trigram'); INSERT INTO projection_projects VALUES('p','Project',NULL); INSERT INTO orchestration_v2_projection_threads VALUES('a','p','Other','{}','2026',NULL,NULL); INSERT INTO orchestration_v2_projection_messages VALUES('m1','a','assistant',1,'{\"text\":\"release\"}','2026'),('m2','a','user',0,'{\"text\":\"release\",\"createdBy\":\"agent\"}','2026'); INSERT INTO orchestration_v2_message_search(rowid,text) VALUES(1,'release'),(2,'release');").unwrap();
        assert!(
            search_messages(&db, &json!({"query":"release"})).unwrap()["matches"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn equal_rank_messages_keep_newest_row_insertion_order() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT,archived_at TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,streaming INTEGER,payload_json TEXT,created_at TEXT); INSERT INTO projection_projects VALUES('p','Project',NULL); INSERT INTO orchestration_v2_projection_threads VALUES('0','p','Other','{}','2026',NULL,NULL),('1','p','Other','{}','2026',NULL,NULL),('2','p','Other','{}','2026',NULL,NULL); INSERT INTO orchestration_v2_projection_messages VALUES('m0','0','user',0,'{\"text\":\"release\"}','2026'),('m1','1','user',0,'{\"text\":\"release\"}','2026'),('m2','2','user',0,'{\"text\":\"release\"}','2026');").unwrap();
        for _ in 0..10 {
            let result = search_messages(&db, &json!({"query":"release"})).unwrap();
            let ids: Vec<_> = result["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["threadId"].as_str().unwrap())
                .collect();
            assert_eq!(ids, ["2", "1", "0"]);
        }
    }
    #[test]
    fn rejects_invalid_inputs() {
        let db = Connection::open_in_memory().unwrap();
        assert!(search(&db, &json!({"query":"x"}), None, None, "local").is_err());
        assert!(search(
            &db,
            &json!({"query":"valid","limit":51}),
            None,
            None,
            "local"
        )
        .is_err());
    }
}
