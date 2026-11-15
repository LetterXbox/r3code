//! Migrations 079–083: recovery indexes and readable citation search text.
use crate::migration_069_073::create_message_search_triggers;
use rusqlite::{params, Transaction};
use url::Url;

pub fn apply_migration_079_083(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        79 => tx.execute_batch(include_str!("../migrations/079.sql")),
        80 => tx.execute_batch(include_str!("../migrations/080.sql")),
        81 => add_message_search_text(tx),
        82 => tx.execute_batch(include_str!("../migrations/082.sql")),
        83 => tx.execute_batch(include_str!("../migrations/083.sql")),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn add_message_search_text(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE orchestration_v2_projection_messages ADD COLUMN search_text TEXT",
    )?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        tx.execute_batch("DROP TRIGGER orchestration_v2_message_search_insert; DROP TRIGGER orchestration_v2_message_search_update; DROP TRIGGER orchestration_v2_message_search_delete;")?;
        create_message_search_triggers(tx)?;
    }
    let mut after = String::new();
    loop {
        let rows = {
            let mut stmt=tx.prepare("SELECT message_id, json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE message_id > ?1 AND payload_json LIKE '%t3-citation://%' AND json_type(payload_json,'$.text')='text' ORDER BY message_id LIMIT 500")?;
            let rows = stmt
                .query_map([&after], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (id, text) in &rows {
            let readable = assistant_citations_to_plain_text(text);
            if readable != *text {
                tx.execute("UPDATE orchestration_v2_projection_messages SET search_text=?1 WHERE message_id=?2",params![readable,id])?;
            }
        }
        if rows.len() < 500 {
            break;
        }
        after = rows.last().expect("nonempty page").0.clone();
    }
    Ok(())
}

// Parse and replace only validated serialized citations; invalid links stay literal.
fn assistant_citations_to_plain_text(input: &str) -> String {
    const PREFIX: &str = "[Assistant quote](t3-citation://v1/";
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(offset) = input[cursor..].find(PREFIX) {
        let start = cursor + offset;
        output.push_str(&input[cursor..start]);
        let href_start = start + "[Assistant quote](".len();
        let Some(end_offset) = input[href_start..].find(')') else {
            output.push_str(&input[start..start + 1]);
            cursor = start + 1;
            continue;
        };
        let end = href_start + end_offset;
        let href = &input[href_start..end];
        if href.chars().any(|c| c.is_whitespace() || c == '\u{feff}') {
            output.push_str(&input[start..start + 1]);
            cursor = start + 1;
            continue;
        }
        let replacement = parse_citation(href);
        if let Some((text, comment)) = replacement {
            output.push_str(&text);
            if let Some(comment) = comment {
                output.push_str("\nComment: ");
                output.push_str(&comment);
            }
        } else {
            output.push_str(&input[start..=end]);
        }
        cursor = end + 1;
    }
    output.push_str(&input[cursor..]);
    output
}
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn decode_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let digit = |b: u8| (b as char).to_digit(16).map(|n| n as u8);
            decoded.push(digit(bytes[i + 1])? * 16 + digit(bytes[i + 2])?);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).ok()
}
fn parse_citation(href: &str) -> Option<(String, Option<String>)> {
    const HREF_PREFIX: &str = "t3-citation://v1/";
    const MAX_HREF: usize = 9 * (8000 + 8000 + 3 * 4096 + 2 * 32) + 1000;
    if !href.starts_with(HREF_PREFIX) || utf16_len(href) > MAX_HREF {
        return None;
    }
    let url = Url::parse(href).ok()?;
    if url.scheme() != "t3-citation"
        || url.host_str() != Some("v1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path().strip_prefix('/')?.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    for part in parts {
        let decoded = decode_component(part)?;
        if decoded.trim().is_empty() || utf16_len(decoded.trim()) > 4096 {
            return None;
        }
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let count = |key: &str| pairs.iter().filter(|(k, _)| k == key).count();
    let value = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
    };
    let comment = value("comment");
    if pairs.len() != 5 + usize::from(comment.is_some())
        || ["text", "start", "end", "prefix", "suffix"]
            .iter()
            .any(|key| count(key) != 1)
    {
        return None;
    }
    let text = value("text")?;
    if text.trim().is_empty()
        || utf16_len(text) > 8000
        || comment.is_some_and(|v| utf16_len(v) > 8000)
        || utf16_len(value("prefix")?) > 32
        || utf16_len(value("suffix")?) > 32
    {
        return None;
    }
    let number = |key: &str| -> Option<u64> {
        let s = value(key)?;
        if s.is_empty() || s.len() > 16 || !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let n = s.parse::<u64>().ok()?;
        (n <= 9_007_199_254_740_991).then_some(n)
    };
    if number("end")? <= number("start")? {
        return None;
    }
    Some((text.to_owned(), comment.map(str::to_owned)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::Connection;
    use serde_json::json;

    const CITATION: &str="[Assistant quote](t3-citation://v1/environment%3Alocal/thread%3Aquoted/quoted-answer?text=A+lighthouse+guides+ships+safely+through+the+darkness.&start=0&end=54&prefix=beacon01&suffix=harbor&comment=what+are+you+talking+about)";
    const READABLE: &str="A lighthouse guides ships safely through the darkness.\nComment: what are you talking about";
    #[test]
    fn citation_backfill_and_index_updates_across_500_row_pages() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 78).unwrap();
        let insert="INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,'t','user',0,'x','x',?2)";
        for i in 0..501 {
            db.execute(
                insert,
                params![format!("page-{i:03}"), json!({"text":CITATION}).to_string()],
            )
            .unwrap();
        }
        db.execute(
            insert,
            params![
                "invalid",
                json!({"text":"[Assistant quote](t3-citation://v1/not-a-citation)"}).to_string()
            ],
        )
        .unwrap();
        db.execute(
            insert,
            params!["plain", json!({"text":"quiet silver lantern"}).to_string()],
        )
        .unwrap();
        db.execute(
            insert,
            params!["unreadable", json!({"text":20261001}).to_string()],
        )
        .unwrap();
        let tasks="INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES (?1,'t','p',1,'{}','p',?2,'{}','{}','full-access','default','user','web','x','x','never',0)";
        db.execute(tasks, params!["with-thread", Some("thread")])
            .unwrap();
        db.execute(tasks, params!["without-thread", Option::<String>::None])
            .unwrap();
        let tx = db.transaction().unwrap();
        for id in 79..=83 {
            apply_migration_079_083(&tx, id).unwrap();
        }
        tx.commit().unwrap();
        for id in ["page-000", "page-500"] {
            assert_eq!(db.query_row("SELECT search_text FROM orchestration_v2_projection_messages WHERE message_id=?1",[id],|r|r.get::<_,String>(0)).unwrap(),READABLE);
        }
        for id in ["invalid", "plain", "unreadable"] {
            assert!(db.query_row("SELECT search_text FROM orchestration_v2_projection_messages WHERE message_id=?1",[id],|r|r.get::<_,Option<String>>(0)).unwrap().is_none());
        }
        for (id, mode) in [
            ("with-thread", "continue"),
            ("without-thread", "new_thread"),
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT thread_mode FROM scheduled_tasks WHERE task_id=?1",
                    [id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                mode
            );
        }
        for index in [
            "orchestration_v2_projection_threads_subagent_result_idx",
            "orchestration_v2_projection_runs_delegated_delivery_idx",
            "orchestration_v2_projection_turn_items_conversation_idx",
            "orchestration_v2_projection_nodes_settled_leaf_idx",
            "orchestration_v2_projection_context_transfers_source_thread_status_idx",
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                    [index],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_schema WHERE name='orchestration_v2_projection_context_transfers_source_thread_idx'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let available:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_message_search')",[],|r|r.get(0)).unwrap();
        if available {
            assert_eq!(db.query_row("SELECT count(*) FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH '\"what are you talking about\"'",[],|r|r.get::<_,i64>(0)).unwrap(),501);
            assert_eq!(db.query_row("SELECT count(*) FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'beacon01'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        }
    }
    #[test]
    fn validates_citations_before_replacing_them() {
        assert_eq!(
            assistant_citations_to_plain_text(&format!("before {CITATION} after")),
            format!("before {READABLE} after")
        );
        let cases = [
            "t3-citation://v1/a/b/c?text=ok&start=0&end=1&prefix=&suffix=&extra=x",
            "t3-citation://v1/a/b/c?text=ok&start=2&end=1&prefix=&suffix=",
            "t3-citation://v1/a/%FF/c?text=ok&start=0&end=1&prefix=&suffix=",
            "t3-citation://v1/a/b/c?text=ok&start=0&end=1&prefix=&suffix=&comment=a&comment=b",
        ];
        for href in cases {
            let original = format!("[Assistant quote]({href})");
            assert_eq!(assistant_citations_to_plain_text(&original), original);
        }
        let nested = format!("[Assistant quote](t3-citation://v1/invalid {CITATION}");
        assert_eq!(
            assistant_citations_to_plain_text(&nested),
            format!("[Assistant quote](t3-citation://v1/invalid {READABLE}")
        );
    }
}
