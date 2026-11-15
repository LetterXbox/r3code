//! SQL-backed historical migration steps.
//!
//! Fixed SQL statements are copied from the original migration sources. A few
//! migrations perform runtime batching, parameterized repairs, or helper-built
//! search SQL; those require dedicated Rust ports and intentionally return an
//! error here rather than marking a partial migration complete.
use rusqlite::Transaction;

/// Apply one supported historical migration body inside the caller's transaction.
/// The migration ledger insert belongs to the outer migration runner.
pub fn apply_migration_step(tx: &Transaction<'_>, migration_id: i64) -> rusqlite::Result<()> {
    // Non-contiguous later migrations have not yet been validated against their
    // helper code and must not be recorded as successfully applied.
    if !(16..=49).contains(&migration_id) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let sql = match migration_id {
        16 => include_str!("../migrations/016.sql"),
        17 => include_str!("../migrations/017.sql"),
        18 => include_str!("../migrations/018.sql"),
        19 => include_str!("../migrations/019.sql"),
        20 => include_str!("../migrations/020.sql"),
        21 => include_str!("../migrations/021.sql"),
        22 => include_str!("../migrations/022.sql"),
        23 => include_str!("../migrations/023.sql"),
        24 => include_str!("../migrations/024.sql"),
        25 => include_str!("../migrations/025.sql"),
        26 => include_str!("../migrations/026.sql"),
        27 => include_str!("../migrations/027.sql"),
        28 => include_str!("../migrations/028.sql"),
        29 => include_str!("../migrations/029.sql"),
        30 => include_str!("../migrations/030.sql"),
        31 => include_str!("../migrations/031.sql"),
        32 => include_str!("../migrations/032.sql"),
        33 => include_str!("../migrations/033.sql"),
        34 => include_str!("../migrations/034.sql"),
        35 => include_str!("../migrations/035.sql"),
        36 => include_str!("../migrations/036.sql"),
        37 => include_str!("../migrations/037.sql"),
        38 => include_str!("../migrations/038.sql"),
        39 => include_str!("../migrations/039.sql"),
        40 => include_str!("../migrations/040.sql"),
        41 => include_str!("../migrations/041.sql"),
        42 => include_str!("../migrations/042.sql"),
        43 => include_str!("../migrations/043.sql"),
        44 => include_str!("../migrations/044.sql"),
        45 => include_str!("../migrations/045.sql"),
        46 => include_str!("../migrations/046.sql"),
        47 => include_str!("../migrations/047.sql"),
        48 => include_str!("../migrations/048.sql"),
        49 => include_str!("../migrations/049.sql"),
        // 050 and later are deliberately unavailable here. Several contain
        // runtime/data-repair behavior that is not represented by fixed SQL.
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    // The original source probes `PRAGMA table_info` before its conditional
    // ALTER TABLE ADD COLUMN steps. Reproduce that behavior for extracted SQL.
    for statement in sql
        .split(";\n;\n")
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        if let Some((table, column)) = add_column_target(statement)
            .filter(|(table, column)| conditional_add_column(migration_id, table, column))
        {
            if column_exists(tx, table, column)? {
                continue;
            }
        }
        tx.execute_batch(statement)?;
    }
    Ok(())
}

fn conditional_add_column(migration_id: i64, table: &str, column: &str) -> bool {
    match migration_id {
        17 => table == "projection_threads" && column == "archived_at",
        21 => {
            (table == "auth_pairing_links" && column == "label")
                || (table == "auth_sessions"
                    && matches!(
                        column,
                        "client_label"
                            | "client_ip_address"
                            | "client_user_agent"
                            | "client_device_type"
                            | "client_os"
                            | "client_browser"
                    ))
        }
        22 => table == "auth_sessions" && column == "last_connected_at",
        27 => table == "provider_session_runtime" && column == "provider_instance_id",
        28 => table == "projection_thread_sessions" && column == "provider_instance_id",
        32 => table == "auth_pairing_links" && column == "proof_key_thumbprint",
        33 => table == "projection_threads" && matches!(column, "settled_override" | "settled_at"),
        34 => table == "projection_threads" && matches!(column, "snoozed_until" | "snoozed_at"),
        35 => {
            table == "projection_threads"
                && matches!(
                    column,
                    "title_regeneration_request_id" | "title_regeneration_started_at"
                )
        }
        36 => table == "projection_threads" && column == "pinned_at",
        38 => table == "projection_threads" && column == "pin_order_key",
        39 => table == "projection_projects" && column == "default_thread_env_mode",
        40 => table == "projection_projects" && column == "favicon_path",
        41 => table == "auth_sessions" && matches!(column, "client_surface" | "client_app_version"),
        42 => table == "projection_threads" && column == "linked_pull_request_json",
        43 => table == "projection_threads" && column == "unsettled_at",
        45 => table == "projection_projects" && column == "auto_pull",
        47 => table == "projection_projects" && column == "project_icon_json",
        48 => table == "projection_threads" && column == "branch_pull_request_json",
        49 => table == "projection_threads" && column == "active_order_key",
        _ => false,
    }
}

fn add_column_target(statement: &str) -> Option<(&str, &str)> {
    let words: Vec<_> = statement.split_whitespace().collect();
    if words.len() < 6
        || !words[0].eq_ignore_ascii_case("ALTER")
        || !words[1].eq_ignore_ascii_case("TABLE")
        || !words[3].eq_ignore_ascii_case("ADD")
        || !words[4].eq_ignore_ascii_case("COLUMN")
    {
        return None;
    }
    let table = words[2].trim_matches('"');
    let column = words[5].trim_matches('"');
    Some((table, column))
}

fn column_exists(tx: &Transaction<'_>, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = tx.prepare(&format!(
        "PRAGMA table_info(\"{}\")",
        table.replace('"', "\"\"")
    ))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// True when this module has a complete executable body for the migration id.
pub fn supports_migration(migration_id: i64) -> bool {
    matches!(migration_id, 16..=49)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn applies_migration_16_and_rejects_unported_dynamic_work() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_initial_migrations(&mut db).unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_step(&tx, 16).unwrap();
        tx.commit().unwrap();
        assert!(supports_migration(16));
        assert!(!supports_migration(50));
        let tx = db.transaction().unwrap();
        assert!(apply_migration_step(&tx, 50).is_err());
    }

    #[test]
    fn verified_contiguous_steps_16_through_49_apply_in_order() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_initial_migrations(&mut db).unwrap();
        for id in 16..=49 {
            let tx = db.transaction().unwrap();
            apply_migration_step(&tx, id)
                .unwrap_or_else(|error| panic!("migration {id} failed: {error}"));
            tx.commit().unwrap();
        }
    }

    #[test]
    fn migration_17_matches_source_column_exists_guard() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_initial_migrations(&mut db).unwrap();
        db.execute_batch("ALTER TABLE projection_threads ADD COLUMN archived_at TEXT;")
            .unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_step(&tx, 17).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('projection_threads') WHERE name='archived_at'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}
