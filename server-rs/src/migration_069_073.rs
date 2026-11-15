//! Migrations 069–073: message search, peer links and projection lookup indexes.
use rusqlite::Transaction;

const PLACEHOLDER: &str = "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
const SPACE: &str = "\t\n\x0b\x0c\r \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

pub fn apply_migration_069_073(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<()> {
    match id {
        69 => create_message_search(tx),
        70 => tx.execute_batch(include_str!("../migrations/070.sql")),
        71 => {
            let fenced: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('peer_environment_links') WHERE name='fenced')", [], |row| row.get(0))?;
            if !fenced {
                tx.execute_batch("ALTER TABLE peer_environment_links ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0")?;
            }
            Ok(())
        }
        72 => tx.execute_batch(include_str!("../migrations/072.sql")),
        73 => tx.execute_batch(include_str!("../migrations/073.sql")),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

/// Search predicates are shared by migrations 069 and 074, and index rebuilds.
pub(crate) fn indexed_message_condition(row: &str) -> String {
    format!(
        r#"{row}.streaming = 0 AND (
        {row}.role = 'assistant' OR ({row}.role = 'user'
        AND COALESCE(json_extract({row}.payload_json, '$.createdBy'), 'user') = 'user'))
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
        WHERE subagent_threads.thread_id = {row}.thread_id
        AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent')
      AND CASE WHEN substr(json_extract({row}.payload_json, '$.text'), 1, 11) = 'Ultrathink:' COLLATE NOCASE
        THEN ltrim(substr(json_extract({row}.payload_json, '$.text'), 12), '{SPACE}')
        ELSE json_extract({row}.payload_json, '$.text') END COLLATE BINARY <> '{PLACEHOLDER}'"#
    )
}

fn folded(expr: &str) -> String {
    format!("replace(replace({expr}, '’', ''''), '‘', '''')")
}
pub(crate) fn text(row: &str, search_text: bool) -> String {
    let payload = format!("json_extract({row}.payload_json, '$.text')");
    if search_text {
        folded(&format!("COALESCE({row}.search_text, {payload})"))
    } else {
        folded(&payload)
    }
}

/// The original helper selects its expression based on whether migration 081
/// has added search_text, so migration 074 and future rebuilds can reuse it.
pub(crate) fn create_message_search_triggers(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let search_text: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('orchestration_v2_projection_messages') WHERE name='search_text')", [], |row| row.get(0))?;
    let new_text = text("new", search_text);
    let old_text = text("old", search_text);
    let condition = indexed_message_condition("new");
    tx.execute_batch(&format!(r#"
      CREATE TRIGGER orchestration_v2_message_search_insert
      AFTER INSERT ON orchestration_v2_projection_messages WHEN {condition}
      BEGIN INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, {new_text} WHERE json_extract(new.payload_json, '$.text') IS NOT NULL; END;
      CREATE TRIGGER orchestration_v2_message_search_update
      AFTER UPDATE ON orchestration_v2_projection_messages
      WHEN (old.streaming = 0 OR new.streaming = 0)
        AND (old.streaming IS NOT new.streaming OR old.role IS NOT new.role
          OR {old_text} IS NOT {new_text}
          OR json_extract(old.payload_json, '$.createdBy') IS NOT json_extract(new.payload_json, '$.createdBy'))
      BEGIN DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid AND old.streaming = 0;
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, {new_text} WHERE {condition}
          AND json_extract(new.payload_json, '$.text') IS NOT NULL; END;
      CREATE TRIGGER orchestration_v2_message_search_delete
      AFTER DELETE ON orchestration_v2_projection_messages WHEN old.streaming = 0
      BEGIN DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid; END;
    "#))
}

fn create_message_search(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let create = tx.execute_batch("CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram remove_diacritics 1')");
    match create {
        Ok(()) => (),
        Err(rusqlite::Error::SqliteFailure(error, message)) if error.extended_code == 1 => {
            eprintln!(
                "Message search index unavailable; search will scan messages: {}",
                message.unwrap_or_default()
            );
            return Ok(());
        }
        Err(error) => return Err(error),
    }
    create_message_search_triggers(tx)?;
    tx.execute_batch(&format!("INSERT INTO orchestration_v2_message_search (rowid, text) SELECT messages.rowid, {} FROM orchestration_v2_projection_messages AS messages WHERE {} AND json_extract(messages.payload_json, '$.text') IS NOT NULL",text("messages", false),indexed_message_condition("messages")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::{params, Connection};

    #[test]
    fn source_schema_and_search_triggers_match_historical_migrations() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 68).unwrap();
        let insert="INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (?1,'t',?2,?3,'x','x',?4)";
        for (id, role, streaming, payload) in [
            ("user", "user", 0, r#"{"text":"needle from user"}"#),
            (
                "assistant",
                "assistant",
                0,
                r#"{"text":"needle from assistant"}"#,
            ),
            (
                "streaming",
                "assistant",
                1,
                r#"{"text":"needle streaming"}"#,
            ),
            (
                "notice",
                "user",
                0,
                r#"{"text":"needle notice","createdBy":"agent"}"#,
            ),
        ] {
            db.execute(insert, params![id, role, streaming, payload])
                .unwrap();
        }
        let tx = db.transaction().unwrap();
        for id in 69..=73 {
            apply_migration_069_073(&tx, id).unwrap();
        }
        // Migration 071 is intentionally safe for preview databases that already have the column.
        apply_migration_069_073(&tx, 71).unwrap();
        let available: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='orchestration_v2_message_search')",[],|r|r.get(0)).unwrap();
        if !available {
            // SQLite builds without the configured tokenizer select the scan path.
            // Exercise the same trigger and predicate SQL with its supported trigram tokenizer.
            tx.execute_batch("CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, content='', contentless_delete=1, tokenize='trigram')").unwrap();
            create_message_search_triggers(&tx).unwrap();
            tx.execute_batch(&format!("INSERT INTO orchestration_v2_message_search(rowid,text) SELECT messages.rowid, {} FROM orchestration_v2_projection_messages AS messages WHERE {} AND json_extract(messages.payload_json,'$.text') IS NOT NULL",text("messages",false),indexed_message_condition("messages"))).unwrap();
        }
        tx.commit().unwrap();
        let search = || -> Vec<String> {
            db.prepare("SELECT m.message_id FROM orchestration_v2_message_search s JOIN orchestration_v2_projection_messages m ON m.rowid=s.rowid WHERE orchestration_v2_message_search MATCH 'needle' ORDER BY m.message_id").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap()
        };
        assert_eq!(search(), vec!["assistant", "user"]);
        db.execute(
            "DELETE FROM orchestration_v2_projection_messages WHERE message_id='user'",
            [],
        )
        .unwrap();
        assert_eq!(search(), vec!["assistant"]);
        let placeholder=serde_json::json!({"text":format!("uLtRaThInK:\n\u{a0}{PLACEHOLDER}"),"createdBy":"user"}).to_string();
        db.execute(insert, params!["placeholder", "user", 0, placeholder])
            .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_message_search",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_table_info('peer_environment_links') WHERE name='fenced' AND dflt_value='0'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        for index in [
            "orchestration_v2_projection_turn_items_waiting_link_idx",
            "orchestration_v2_projection_turn_items_active_ordinal_idx",
            "orchestration_v2_projection_turn_items_active_run_idx",
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
    }
}
