//! Transactional event and receipt primitives for the V2 orchestration store.
//!
//! Schema installation is intentionally separate from opening the production database:
//! the full migration history must be implemented before this is used at startup.
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub aggregate_kind: String,
    pub stream_id: String,
    pub event_type: String,
    pub occurred_at: String,
    pub command_id: Option<String>,
    pub causation_event_id: Option<String>,
    pub correlation_id: Option<String>,
    pub actor_kind: String,
    pub payload: Value,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub sequence: i64,
    pub stream_version: i64,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Receipt {
    pub command_id: String,
    pub aggregate_kind: String,
    pub aggregate_id: String,
    pub command_type: String,
    pub accepted_at: String,
    pub result_sequence: i64,
    pub status: String,
    pub error: Option<String>,
}

/// Install the event and receipt tables on an empty test database. This is not
/// a substitute for the full production migration runner.
#[cfg(test)]
fn install_test_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL, application_event_version INTEGER NOT NULL DEFAULT 1); CREATE UNIQUE INDEX idx_orch_events_stream_version ON orchestration_events(aggregate_kind, stream_id, stream_version); CREATE TABLE orchestration_command_receipts (command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, accepted_at TEXT NOT NULL, result_sequence INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, command_type TEXT NOT NULL DEFAULT 'legacy');")
}

const TURN_ITEM_ORDINAL_BAND: i64 = 1_000_000;
const TURN_ITEM_ORDINAL_MAX_OFFSET: i64 = 999_999;

fn table_exists(tx: &Transaction<'_>, name: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}

fn allocate_turn_item_ordinal_inner(
    tx: &Transaction<'_>,
    thread_id: &str,
    turn_item_id: &str,
    run_id: Option<&str>,
    supplied_run_ordinal: Option<i64>,
    has_runs: bool,
    has_turn_items: bool,
    pending_batch_items: &std::collections::HashSet<(String, String)>,
) -> rusqlite::Result<i64> {
    if let Some(existing) = tx
        .query_row(
            "SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND turn_item_id=?2 LIMIT 1",
            params![thread_id, turn_item_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(existing);
    }

    let run_ordinal = if let Some(ord) = supplied_run_ordinal {
        Some(ord)
    } else if let (Some(rid), true) = (run_id, has_runs) {
        tx.query_row(
            "SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 LIMIT 1",
            params![thread_id, rid],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    } else {
        None
    };

    let lower_bound = run_ordinal.map_or(0, |n| n.saturating_mul(TURN_ITEM_ORDINAL_BAND));
    let upper_bound = lower_bound.saturating_add(TURN_ITEM_ORDINAL_MAX_OFFSET);

    let max_in_positions: Option<i64> = tx.query_row(
        "SELECT MAX(ordinal) FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<=?3",
        params![thread_id, lower_bound, upper_bound],
        |r| r.get(0),
    )?;
    let max_in_items: Option<i64> = if has_turn_items {
        let mut stmt = tx.prepare(
            "SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id!=?4 AND ordinal>=?2 AND ordinal<=?3 ORDER BY ordinal DESC",
        )?;
        let mut rows = stmt.query(params![thread_id, lower_bound, upper_bound, turn_item_id])?;
        let mut found = None;
        while let Some(row) = rows.next()? {
            let other_id: String = row.get(0)?;
            if !pending_batch_items.contains(&(thread_id.to_owned(), other_id)) {
                found = Some(row.get::<_, i64>(1)?);
                break;
            }
        }
        found
    } else {
        None
    };

    let max_used = match (max_in_positions, max_in_items) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    let mut candidate = max_used.unwrap_or(lower_bound).saturating_add(1);
    if candidate > upper_bound {
        // Fallback: find the lowest unused ordinal in the run's band, or after all positions.
        let mut stmt = tx.prepare(
            "SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<=?3 ORDER BY ordinal ASC",
        )?;
        let used: Vec<i64> = stmt
            .query_map(params![thread_id, lower_bound + 1, upper_bound], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut probe = lower_bound + 1;
        for u in used {
            if u > probe {
                break;
            }
            if u == probe {
                probe += 1;
            }
        }
        if probe <= upper_bound {
            candidate = probe;
        } else {
            let global_max: i64 = tx.query_row(
                "SELECT COALESCE(MAX(ordinal), 0) FROM orchestration_v2_turn_item_positions WHERE thread_id=?1",
                [thread_id],
                |r| r.get(0),
            )?;
            candidate = global_max.saturating_add(1);
        }
    }

    tx.execute(
        "INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, turn_item_id) DO NOTHING",
        params![thread_id, turn_item_id, candidate],
    )?;
    tx.query_row(
        "SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND turn_item_id=?2 LIMIT 1",
        params![thread_id, turn_item_id],
        |r| r.get(0),
    )
}

/// Explicitly assign or relocate a turn item's ordinal in `orchestration_v2_turn_item_positions`
/// (for example when queue promotion places a handoff banner immediately ahead of a queued user message
/// or re-bands a promoted run whose ordinal advanced).
pub(crate) fn set_turn_item_ordinal(
    tx: &Transaction<'_>,
    thread_id: &str,
    turn_item_id: &str,
    ordinal: i64,
) -> rusqlite::Result<()> {
    if !table_exists(tx, "orchestration_v2_turn_item_positions")? {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal=excluded.ordinal",
        params![thread_id, turn_item_id, ordinal],
    )?;
    Ok(())
}

/// Allocate (or return the already-recorded) stable ordinal for a turn item in a thread.
/// Falls back to direct query if `orchestration_v2_turn_item_positions` is unavailable in minimal unit tests.
pub fn allocate_turn_item_ordinal(
    tx: &Transaction<'_>,
    thread_id: &str,
    turn_item_id: &str,
    run_id: Option<&str>,
    supplied_run_ordinal: Option<i64>,
) -> rusqlite::Result<i64> {
    let has_positions = table_exists(tx, "orchestration_v2_turn_item_positions")?;
    let has_runs = table_exists(tx, "orchestration_v2_projection_runs")?;
    let has_turn_items = table_exists(tx, "orchestration_v2_projection_turn_items")?;
    if has_positions {
        let empty_batch = std::collections::HashSet::new();
        return allocate_turn_item_ordinal_inner(
            tx,
            thread_id,
            turn_item_id,
            run_id,
            supplied_run_ordinal,
            has_runs,
            has_turn_items,
            &empty_batch,
        );
    }
    let run_ordinal = if let Some(ord) = supplied_run_ordinal {
        Some(ord)
    } else if let (Some(rid), true) = (run_id, has_runs) {
        tx.query_row(
            "SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 LIMIT 1",
            params![thread_id, rid],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    } else {
        None
    };
    let lower_bound = run_ordinal.map_or(0, |n| n.saturating_mul(TURN_ITEM_ORDINAL_BAND));
    let upper_bound = lower_bound.saturating_add(TURN_ITEM_ORDINAL_MAX_OFFSET);
    if has_turn_items {
        let max_used: Option<i64> = tx.query_row(
            "SELECT MAX(ordinal) FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<=?3",
            params![thread_id, lower_bound, upper_bound],
            |r| r.get(0),
        )?;
        Ok(max_used.unwrap_or(lower_bound).saturating_add(1))
    } else {
        Ok(lower_bound.saturating_add(1))
    }
}

/// Idempotently repair existing databases where turn items were persisted outside
/// their run's `[run_ordinal * 1_000_000, +999_999]` band or without position rows.
pub fn repair_turn_item_positions(tx: &Transaction<'_>) -> rusqlite::Result<usize> {
    if !table_exists(tx, "orchestration_v2_turn_item_positions")?
        || !table_exists(tx, "orchestration_v2_projection_turn_items")?
        || !table_exists(tx, "orchestration_v2_projection_runs")?
        || !table_exists(tx, "orchestration_events")?
    {
        return Ok(0);
    }

    let needs_repair: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM orchestration_v2_projection_turn_items AS i
            LEFT JOIN orchestration_v2_projection_runs AS r
              ON r.thread_id = i.thread_id AND r.run_id = i.run_id
            LEFT JOIN orchestration_v2_turn_item_positions AS p
              ON p.thread_id = i.thread_id AND p.turn_item_id = i.turn_item_id
            WHERE p.turn_item_id IS NULL
               OR p.ordinal != i.ordinal
               OR i.ordinal < CASE WHEN COALESCE(r.ordinal, 0) = 0 THEN 0 ELSE COALESCE(r.ordinal, 0) * 1000000 + 1 END
               OR i.ordinal > COALESCE(r.ordinal, 0) * 1000000 + 999999
               OR (json_valid(i.payload_json) AND json_extract(i.payload_json, '$.ordinal') IS NOT i.ordinal)
               OR EXISTS(
                    SELECT 1 FROM orchestration_v2_projection_turn_items AS other
                    WHERE other.thread_id = i.thread_id
                      AND other.ordinal = i.ordinal
                      AND other.turn_item_id != i.turn_item_id
                  )
        )",
        [],
        |r| r.get(0),
    )?;
    if !needs_repair {
        return Ok(0);
    }

    #[derive(Clone)]
    struct ItemRow {
        thread_id: String,
        band: i64,
        turn_item_id: String,
        ordinal: i64,
        pos_ordinal: Option<i64>,
        payload_ordinal: Option<i64>,
    }

    let mut stmt = tx.prepare(
        "SELECT
            i.thread_id,
            COALESCE(r.ordinal, 0) AS band,
            i.turn_item_id,
            i.ordinal,
            p.ordinal AS pos_ordinal,
            CASE WHEN json_valid(i.payload_json) THEN json_extract(i.payload_json, '$.ordinal') ELSE NULL END AS payload_ordinal,
            (
                SELECT MIN(e.sequence)
                FROM orchestration_events AS e
                WHERE e.aggregate_kind = 'thread'
                  AND e.stream_id = i.thread_id
                  AND e.event_type = 'turn-item.updated'
                  AND json_extract(e.payload_json, '$.id') = i.turn_item_id
            ) AS first_seq
         FROM orchestration_v2_projection_turn_items AS i
         LEFT JOIN orchestration_v2_projection_runs AS r
           ON r.thread_id = i.thread_id AND r.run_id = i.run_id
         LEFT JOIN orchestration_v2_turn_item_positions AS p
           ON p.thread_id = i.thread_id AND p.turn_item_id = i.turn_item_id
         ORDER BY
           i.thread_id ASC,
           band ASC,
           COALESCE(first_seq, 9223372036854775807) ASC,
           i.updated_at ASC,
           i.ordinal ASC,
           i.turn_item_id ASC",
    )?;
    let rows: Vec<ItemRow> = stmt
        .query_map([], |r| {
            Ok(ItemRow {
                thread_id: r.get(0)?,
                band: r.get(1)?,
                turn_item_id: r.get(2)?,
                ordinal: r.get(3)?,
                pos_ordinal: r.get(4)?,
                payload_ordinal: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let mut groups: std::collections::BTreeMap<(String, i64), Vec<ItemRow>> =
        std::collections::BTreeMap::new();
    for row in rows {
        groups
            .entry((row.thread_id.clone(), row.band))
            .or_default()
            .push(row);
    }

    let mut repaired_count = 0usize;
    for ((thread_id, band), items) in groups {
        let lower_bound = band.saturating_mul(TURN_ITEM_ORDINAL_BAND);
        let upper_bound = lower_bound.saturating_add(TURN_ITEM_ORDINAL_MAX_OFFSET);
        let mut seen = std::collections::HashSet::new();
        let mut needs_renumber = false;
        let mut needs_sync = false;
        for item in &items {
            let in_band = item.ordinal >= lower_bound
                && item.ordinal <= upper_bound
                && (band == 0 || item.ordinal > lower_bound);
            if !in_band || !seen.insert(item.ordinal) {
                needs_renumber = true;
                break;
            }
            if item.pos_ordinal != Some(item.ordinal) || item.payload_ordinal != Some(item.ordinal) {
                needs_sync = true;
            }
        }

        if needs_renumber {
            for item in &items {
                tx.execute(
                    "DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND turn_item_id=?2",
                    params![thread_id, item.turn_item_id],
                )?;
            }
            tx.execute(
                "DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id=?1 AND ordinal>=?2 AND ordinal<=?3 AND turn_item_id NOT IN (SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id=?1)",
                params![thread_id, lower_bound, upper_bound],
            )?;
            for (idx, item) in items.iter().enumerate() {
                let target_ordinal = lower_bound.saturating_add(idx as i64 + 1);
                tx.execute(
                    "INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal=excluded.ordinal",
                    params![thread_id, item.turn_item_id, target_ordinal],
                )?;
                if item.ordinal != target_ordinal || item.payload_ordinal != Some(target_ordinal) {
                    tx.execute(
                        "UPDATE orchestration_v2_projection_turn_items SET ordinal=?3, payload_json=CASE WHEN json_valid(payload_json) THEN json_set(payload_json, '$.ordinal', ?3) ELSE payload_json END WHERE thread_id=?1 AND turn_item_id=?2",
                        params![thread_id, item.turn_item_id, target_ordinal],
                    )?;
                    tx.execute(
                        "UPDATE orchestration_events SET payload_json=json_set(payload_json, '$.ordinal', ?3) WHERE aggregate_kind='thread' AND stream_id=?1 AND event_type='turn-item.updated' AND json_valid(payload_json) AND json_extract(payload_json, '$.id')=?2 AND json_extract(payload_json, '$.ordinal') IS NOT ?3",
                        params![thread_id, item.turn_item_id, target_ordinal],
                    )?;
                    repaired_count += 1;
                }
            }
        } else if needs_sync {
            for item in &items {
                let mut changed = false;
                if item.pos_ordinal != Some(item.ordinal) {
                    tx.execute(
                        "INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal=excluded.ordinal",
                        params![thread_id, item.turn_item_id, item.ordinal],
                    )?;
                    changed = true;
                }
                if item.payload_ordinal != Some(item.ordinal) {
                    tx.execute(
                        "UPDATE orchestration_v2_projection_turn_items SET payload_json=CASE WHEN json_valid(payload_json) THEN json_set(payload_json, '$.ordinal', ?3) ELSE payload_json END WHERE thread_id=?1 AND turn_item_id=?2",
                        params![thread_id, item.turn_item_id, item.ordinal],
                    )?;
                    changed = true;
                }
                if changed {
                    repaired_count += 1;
                }
            }
        }
    }

    Ok(repaired_count)
}

/// Append inside the caller's write transaction, so events, projections, effects,
/// and receipt can be committed atomically. The transaction must be IMMEDIATE.
pub fn append(tx: &Transaction<'_>, events: &[Event]) -> rusqlite::Result<Vec<StoredEvent>> {
    let mut stored = Vec::with_capacity(events.len());
    // Some callers use the event store independently of the V2 projection schema.
    let has_threads = table_exists(tx, "orchestration_v2_projection_threads")?;
    let has_positions = table_exists(tx, "orchestration_v2_turn_item_positions")?;
    let has_turn_items = table_exists(tx, "orchestration_v2_projection_turn_items")?;
    let has_runs = table_exists(tx, "orchestration_v2_projection_runs")?;

    let mut batch_run_ordinals = std::collections::HashMap::<String, i64>::new();
    let mut pending_batch_items = std::collections::HashSet::<(String, String)>::new();
    if has_positions {
        for ev in events {
            if ev.aggregate_kind == "thread"
                && matches!(ev.event_type.as_str(), "run.created" | "run.updated")
            {
                if let (Some(id), Some(ord)) =
                    (ev.payload["id"].as_str(), ev.payload["ordinal"].as_i64())
                {
                    batch_run_ordinals.insert(id.to_owned(), ord);
                }
            } else if ev.aggregate_kind == "thread" && ev.event_type == "turn-item.updated" {
                if let Some(item_id) = ev.payload["id"].as_str() {
                    let thread_id = ev.payload["threadId"]
                        .as_str()
                        .unwrap_or(&ev.stream_id)
                        .to_owned();
                    pending_batch_items.insert((thread_id, item_id.to_owned()));
                }
            }
        }
    }

    for orig_event in events {
        let mut event = orig_event.clone();
        if has_positions
            && event.aggregate_kind == "thread"
            && event.event_type == "turn-item.updated"
        {
            if let Some(item_id) = event.payload["id"].as_str().map(str::to_owned) {
                let thread_id = event.payload["threadId"]
                    .as_str()
                    .unwrap_or(&event.stream_id)
                    .to_owned();
                let run_id = event.payload["runId"].as_str().map(str::to_owned);
                let supplied_run_ordinal = run_id
                    .as_deref()
                    .and_then(|id| batch_run_ordinals.get(id).copied());
                let ordinal = allocate_turn_item_ordinal_inner(
                    tx,
                    &thread_id,
                    &item_id,
                    run_id.as_deref(),
                    supplied_run_ordinal,
                    has_runs,
                    has_turn_items,
                    &pending_batch_items,
                )?;
                pending_batch_items.remove(&(thread_id.clone(), item_id.clone()));
                event.payload["ordinal"] = serde_json::json!(ordinal);
                if has_turn_items {
                    tx.execute(
                        "UPDATE orchestration_v2_projection_turn_items SET ordinal=?3, payload_json=CASE WHEN json_valid(payload_json) THEN json_set(payload_json, '$.ordinal', ?3) ELSE payload_json END WHERE thread_id=?1 AND turn_item_id=?2 AND (ordinal!=?3 OR (json_valid(payload_json) AND json_extract(payload_json, '$.ordinal') IS NOT ?3))",
                        params![thread_id, item_id, ordinal],
                    )?;
                }
            }
        }
        let version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(stream_version)+1,0) FROM orchestration_events WHERE aggregate_kind=?1 AND stream_id=?2",
            params![event.aggregate_kind, event.stream_id], |r| r.get(0),
        )?;
        tx.execute("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,2)", params![event.id,event.aggregate_kind,event.stream_id,version,event.event_type,event.occurred_at,event.command_id,event.causation_event_id,event.correlation_id,event.actor_kind,event.payload.to_string(),event.metadata.to_string()])?;
        let sequence = tx.last_insert_rowid();
        if has_threads
            && event.aggregate_kind == "thread"
            && updates_thread_activity(&event.event_type)
        {
            tx.execute(
                "UPDATE orchestration_v2_projection_threads SET updated_at=?2, payload_json=json_set(payload_json, '$.updatedAt', ?2) WHERE thread_id=?1",
                params![event.stream_id, event.occurred_at],
            )?;
        }
        stored.push(StoredEvent {
            sequence,
            stream_version: version,
            event,
        });
    }
    Ok(stored)
}

// Thread-owned events project their own timestamps, often intentionally leaving
// activity unchanged (for example, a visit). Other events advance activity at
// their event time, in event order.
fn updates_thread_activity(event_type: &str) -> bool {
    !matches!(
        event_type,
        "thread.created"
            | "thread.archived"
            | "thread.unarchived"
            | "thread.deleted"
            | "thread.settled"
            | "thread.unsettled"
            | "thread.snoozed"
            | "thread.unsnoozed"
            | "thread.auto-settle-set"
            | "thread.pinned"
            | "thread.unpinned"
            | "thread.pin-reordered"
            | "thread.active-reordered"
            | "thread.tags-updated"
            | "thread.visited"
            | "thread.visit-recorded"
            | "thread.marked-unread"
            | "thread.metadata-updated"
            | "thread.pull-request-synced"
            | "thread.pull-request-link-updated"
            | "thread.issue-synced"
            | "thread.runtime-mode-updated"
            | "thread.interaction-mode-updated"
            | "thread.model-selection-updated"
            | "thread.provider-switched"
            | "thread.guest-share-updated"
    )
}

/// Read V2 thread events in global sequence order. A cursor is exclusive.
/// Event-type validation is required before this can serve production replay.
#[derive(Debug, Default)]
pub struct EventFilter<'a> {
    pub after: i64,
    pub through: Option<i64>,
    pub thread_id: Option<&'a str>,
    pub command_id: Option<&'a str>,
    pub event_type: Option<&'a str>,
    pub limit: Option<i64>,
}

pub fn read_agent_events(
    db: &Connection,
    filter: &EventFilter<'_>,
) -> rusqlite::Result<Vec<StoredEvent>> {
    let mut stmt = db.prepare("SELECT sequence,stream_version,event_id,aggregate_kind,stream_id,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,CASE WHEN event_type IN ('subagent.updated','turn-item.updated') AND json_type(payload_json,'$.promptSequence')='integer' THEN json_set(json_remove(payload_json,'$.promptSequence'),'$.prompt',(SELECT json_extract(anchor.payload_json,'$.prompt') FROM orchestration_events AS anchor WHERE anchor.sequence=json_extract(orchestration_events.payload_json,'$.promptSequence'))) ELSE payload_json END,metadata_json, CASE WHEN event_type IN ('subagent.updated','turn-item.updated') AND json_type(payload_json,'$.promptSequence')='integer' THEN EXISTS(SELECT 1 FROM orchestration_events AS anchor WHERE anchor.sequence=json_extract(orchestration_events.payload_json,'$.promptSequence')) ELSE 1 END FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND sequence>?1 AND sequence<=?2 AND (?3 IS NULL OR stream_id=?3) AND (?4 IS NULL OR command_id=?4) AND (?5 IS NULL OR event_type=?5) ORDER BY sequence ASC LIMIT ?6")?;
    let rows = stmt.query_map(
        params![
            filter.after,
            filter.through.unwrap_or(i64::MAX),
            filter.thread_id,
            filter.command_id,
            filter.event_type,
            filter.limit.unwrap_or(i64::MAX).max(0)
        ],
        |r| {
            // Returning a null prompt would silently corrupt replay when an anchor
            // is missing (for example after an unsafe prune).
            if !r.get::<_, bool>(13)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let payload: String = r.get(11)?;
            let metadata: String = r.get(12)?;
            let parse = |value: &str, column| {
                serde_json::from_str(value).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        column,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            };
            Ok(StoredEvent {
                sequence: r.get(0)?,
                stream_version: r.get(1)?,
                event: Event {
                    id: r.get(2)?,
                    aggregate_kind: r.get(3)?,
                    stream_id: r.get(4)?,
                    event_type: r.get(5)?,
                    occurred_at: r.get(6)?,
                    command_id: r.get(7)?,
                    causation_event_id: r.get(8)?,
                    correlation_id: r.get(9)?,
                    actor_kind: r.get(10)?,
                    payload: parse(&payload, 11)?,
                    metadata: parse(&metadata, 12)?,
                },
            })
        },
    )?;
    rows.collect()
}

/// Convenience wrapper for a single thread and exclusive cursor.
pub fn read_thread_events(
    db: &Connection,
    thread_id: &str,
    after: i64,
    limit: i64,
) -> rusqlite::Result<Vec<StoredEvent>> {
    read_agent_events(
        db,
        &EventFilter {
            thread_id: Some(thread_id),
            after,
            limit: Some(limit),
            ..Default::default()
        },
    )
}

pub fn insert_receipt_if_absent(tx: &Transaction<'_>, receipt: &Receipt) -> rusqlite::Result<bool> {
    Ok(tx.execute("INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(command_id) DO NOTHING", params![receipt.command_id,receipt.aggregate_kind,receipt.aggregate_id,receipt.command_type,receipt.accepted_at,receipt.result_sequence,receipt.status,receipt.error])? == 1)
}

/// Replace every stored receipt field when the command ID already exists.
pub fn upsert_receipt(tx: &Transaction<'_>, receipt: &Receipt) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(command_id) DO UPDATE SET aggregate_kind=excluded.aggregate_kind, aggregate_id=excluded.aggregate_id, command_type=excluded.command_type, accepted_at=excluded.accepted_at, result_sequence=excluded.result_sequence, status=excluded.status, error=excluded.error", params![receipt.command_id,receipt.aggregate_kind,receipt.aggregate_id,receipt.command_type,receipt.accepted_at,receipt.result_sequence,receipt.status,receipt.error])?;
    Ok(())
}

/// Latest V2 thread event cursor, optionally restricted to one thread.
pub fn latest_thread_sequence(db: &Connection, thread_id: Option<&str>) -> rusqlite::Result<i64> {
    db.query_row("SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND (?1 IS NULL OR stream_id=?1)", params![thread_id], |r| r.get(0))
}

/// Latest application event cursor, including project events and legacy projects.
pub fn latest_application_sequence(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')", [], |r| r.get(0))
}

pub fn get_receipt(
    db: &Connection,
    command_id: &str,
    kind: &str,
) -> rusqlite::Result<Option<Receipt>> {
    db.query_row("SELECT command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error FROM orchestration_command_receipts WHERE command_id=?1 AND aggregate_kind=?2", params![command_id,kind], |r| Ok(Receipt { command_id:r.get(0)?, aggregate_kind:r.get(1)?, aggregate_id:r.get(2)?, command_type:r.get(3)?, accepted_at:r.get(4)?, result_sequence:r.get(5)?, status:r.get(6)?, error:r.get(7)? })).optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;
    fn event(id: &str, stream: &str) -> Event {
        Event {
            id: id.into(),
            aggregate_kind: "thread".into(),
            stream_id: stream.into(),
            event_type: "thread.created".into(),
            occurred_at: "2026-10-01T00:00:00.000Z".into(),
            command_id: Some("cmd".into()),
            causation_event_id: None,
            correlation_id: Some("cmd".into()),
            actor_kind: "server".into(),
            payload: serde_json::json!({}),
            metadata: serde_json::json!({}),
        }
    }
    #[test]
    fn activity_events_update_thread_timestamp_atomically_in_event_order() {
        let mut db = Connection::open_in_memory().unwrap();
        install_test_schema(&db).unwrap();
        db.execute_batch(r#"CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, updated_at TEXT, payload_json TEXT); INSERT INTO orchestration_v2_projection_threads VALUES('a','old','{"updatedAt":"old","title":"A"}');"#).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let mut activity = event("activity", "a");
        activity.event_type = "run.updated".into();
        activity.occurred_at = "new".into();
        let mut visit = event("visit", "a");
        visit.event_type = "thread.visited".into();
        visit.occurred_at = "later".into();
        let stored = append(&tx, &[activity, visit]).unwrap();
        assert_eq!(
            stored.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            vec![1, 2]
        );
        let (column, payload): (String, String) = tx.query_row("SELECT updated_at,payload_json FROM orchestration_v2_projection_threads WHERE thread_id='a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(column, "new");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            serde_json::json!({"updatedAt":"new","title":"A"})
        );
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id='a'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "old"
        );
    }

    #[test]
    fn replay_restores_prompt_anchor() {
        let mut db = Connection::open_in_memory().unwrap();
        install_test_schema(&db).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let mut anchor = event("anchor", "a");
        anchor.event_type = "subagent.updated".into();
        anchor.payload = serde_json::json!({"id":"s", "prompt":"original"});
        let mut reference = event("reference", "a");
        reference.event_type = "subagent.updated".into();
        reference.payload = serde_json::json!({"id":"s", "prompt":"", "promptSequence":1});
        append(&tx, &[anchor, reference]).unwrap();
        tx.commit().unwrap();
        let rows = read_thread_events(&db, "a", 0, 10).unwrap();
        assert_eq!(
            rows[1].event.payload,
            serde_json::json!({"id":"s", "prompt":"original"})
        );
    }
    #[test]
    fn replay_rejects_a_missing_prompt_anchor() {
        let mut db = Connection::open_in_memory().unwrap();
        install_test_schema(&db).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let mut reference = event("reference", "a");
        reference.event_type = "subagent.updated".into();
        reference.payload = serde_json::json!({"id":"s", "prompt":"", "promptSequence":99});
        append(&tx, &[reference]).unwrap();
        tx.commit().unwrap();
        assert!(read_thread_events(&db, "a", 0, 10).is_err());
    }
    #[test]
    fn sequences_and_receipt_are_atomic_and_idempotent() {
        let mut db = Connection::open_in_memory().unwrap();
        install_test_schema(&db).unwrap();
        let receipt = Receipt {
            command_id: "cmd".into(),
            aggregate_kind: "thread".into(),
            aggregate_id: "a".into(),
            command_type: "thread.create".into(),
            accepted_at: "2026-10-01T00:00:00.000Z".into(),
            result_sequence: 2,
            status: "accepted".into(),
            error: None,
        };
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let rows = append(&tx, &[event("1", "a"), event("2", "a"), event("3", "b")]).unwrap();
        assert_eq!(
            rows.iter()
                .map(|e| (e.sequence, e.stream_version))
                .collect::<Vec<_>>(),
            vec![(1, 0), (2, 1), (3, 0)]
        );
        assert!(insert_receipt_if_absent(&tx, &receipt).unwrap());
        assert!(!insert_receipt_if_absent(&tx, &receipt).unwrap());
        tx.commit().unwrap();
        assert_eq!(
            read_thread_events(&db, "a", 1, 10)
                .unwrap()
                .iter()
                .map(|e| e.sequence)
                .collect::<Vec<_>>(),
            vec![2]
        );
        assert_eq!(get_receipt(&db, "cmd", "thread").unwrap(), Some(receipt));
        assert_eq!(get_receipt(&db, "cmd", "project").unwrap(), None);
        assert_eq!(
            read_agent_events(
                &db,
                &EventFilter {
                    command_id: Some("cmd"),
                    through: Some(2),
                    event_type: Some("thread.created"),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            2
        );
        assert_eq!(
            read_agent_events(
                &db,
                &EventFilter {
                    limit: Some(-1),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            0
        );
        assert_eq!(latest_thread_sequence(&db, Some("a")).unwrap(), 2);
        assert_eq!(latest_thread_sequence(&db, None).unwrap(), 3);
        assert_eq!(latest_application_sequence(&db).unwrap(), 3);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let replacement = Receipt {
            command_id: "cmd".into(),
            aggregate_kind: "project".into(),
            aggregate_id: "p".into(),
            command_type: "project.create".into(),
            accepted_at: "2026-10-01T00:00:00.000Z".into(),
            result_sequence: 3,
            status: "rejected".into(),
            error: Some("failure".into()),
        };
        upsert_receipt(&tx, &replacement).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            get_receipt(&db, "cmd", "project").unwrap(),
            Some(replacement)
        );
        assert_eq!(get_receipt(&db, "cmd", "thread").unwrap(), None);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(append(&tx, &[event("4", "a"), event("1", "a")]).is_err());
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM orchestration_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn turn_item_ordinals_normalize_across_runs_and_repair_out_of_band_rows() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let selection = serde_json::json!({"instanceId":"claudeAgent","model":"claude-sonnet-4-6"});
        let source = serde_json::json!("web");
        assert!(crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create-t-order",
                thread_id: "t-order",
                project_id: "p-order",
                title: "Order",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "ev-create-t-order",
            "2026-01-01T00:00:00Z",
        ).unwrap().committed);

        let cmd = |id: &'static str, msg: &'static str, text: &'static str| crate::message_commands::DispatchMessage {
            context: None,
            command_id: id,
            thread_id: "t-order",
            message_id: msg,
            text,
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "claudeAgent",
        };
        assert!(crate::message_commands::dispatch_first_message(&bus, cmd("c1", "m1", "hello"), "2026-01-01T00:00:01Z").unwrap().committed);

        bus.commit(|tx| {
            // Simulate a provider stream that passes low ordinals (2, 3) and pre-inserts into projection_turn_items.
            let r_id = "turn-item:provider:claudeAgent:native-item:r1";
            let a_id = "turn-item:provider:claudeAgent:native-item:a1";
            let r_item = serde_json::json!({"id":r_id,"threadId":"t-order","runId":"run:thread:t-order:ordinal:1","nodeId":"n1","ordinal":2,"type":"reasoning","status":"running","updatedAt":"2026-01-01T00:00:02Z","text":"thinking","streaming":true});
            let a_item = serde_json::json!({"id":a_id,"threadId":"t-order","runId":"run:thread:t-order:ordinal:1","nodeId":"n1","ordinal":3,"type":"assistant_message","status":"completed","updatedAt":"2026-01-01T00:00:03Z","text":"hi!","streaming":false});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t-order','run:thread:t-order:ordinal:1','n1',2,'reasoning','running','2026-01-01T00:00:02Z',?2)", params![r_id, r_item.to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t-order','run:thread:t-order:ordinal:1','n1',3,'assistant_message','completed','2026-01-01T00:00:03Z',?2)", params![a_id, a_item.to_string()])?;
            let stored = append(tx, &[
                Event { id: "e-r1".into(), aggregate_kind: "thread".into(), stream_id: "t-order".into(), event_type: "turn-item.updated".into(), occurred_at: "2026-01-01T00:00:02Z".into(), command_id: None, causation_event_id: None, correlation_id: None, actor_kind: "provider".into(), payload: r_item, metadata: serde_json::json!({}) },
                Event { id: "e-a1".into(), aggregate_kind: "thread".into(), stream_id: "t-order".into(), event_type: "turn-item.updated".into(), occurred_at: "2026-01-01T00:00:03Z".into(), command_id: None, causation_event_id: None, correlation_id: None, actor_kind: "provider".into(), payload: a_item, metadata: serde_json::json!({}) },
            ])?;
            assert_eq!(stored[0].event.payload["ordinal"], 1_000_002);
            assert_eq!(stored[1].event.payload["ordinal"], 1_000_003);
            // Updating an existing item keeps its allocated ordinal rather than re-allocating or regressing.
            let r_done = serde_json::json!({"id":r_id,"threadId":"t-order","runId":"run:thread:t-order:ordinal:1","nodeId":"n1","ordinal":2,"type":"reasoning","status":"completed","updatedAt":"2026-01-01T00:00:04Z","text":"thinking","streaming":false});
            tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='completed',payload_json=?2 WHERE turn_item_id=?1", params![r_id, r_done.to_string()])?;
            let stored2 = append(tx, &[
                Event { id: "e-r2".into(), aggregate_kind: "thread".into(), stream_id: "t-order".into(), event_type: "turn-item.updated".into(), occurred_at: "2026-01-01T00:00:04Z".into(), command_id: None, causation_event_id: None, correlation_id: None, actor_kind: "provider".into(), payload: r_done, metadata: serde_json::json!({}) },
            ])?;
            assert_eq!(stored2[0].event.payload["ordinal"], 1_000_002);
            tx.execute("UPDATE orchestration_v2_projection_runs SET status='completed',completed_at='2026-01-01T00:00:05Z',payload_json=json_set(payload_json,'$.status','completed') WHERE run_id='run:thread:t-order:ordinal:1'", [])?;
            Ok(((), vec![]))
        }).unwrap();

        assert!(crate::message_commands::dispatch_message_with_mode(&bus, cmd("c2", "m2", "second"), "2026-01-01T00:00:06Z", false).unwrap().committed);
        bus.commit(|tx| {
            let a2_id = "turn-item:provider:claudeAgent:native-item:a2";
            let a2_item = serde_json::json!({"id":a2_id,"threadId":"t-order","runId":"run:thread:t-order:ordinal:2","nodeId":"n2","ordinal":2,"type":"assistant_message","status":"completed","updatedAt":"2026-01-01T00:00:07Z","text":"second reply","streaming":false});
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,'t-order','run:thread:t-order:ordinal:2','n2',2,'assistant_message','completed','2026-01-01T00:00:07Z',?2)", params![a2_id, a2_item.to_string()])?;
            let stored = append(tx, &[
                Event { id: "e-a2".into(), aggregate_kind: "thread".into(), stream_id: "t-order".into(), event_type: "turn-item.updated".into(), occurred_at: "2026-01-01T00:00:07Z".into(), command_id: None, causation_event_id: None, correlation_id: None, actor_kind: "provider".into(), payload: a2_item, metadata: serde_json::json!({}) },
            ])?;
            assert_eq!(stored[0].event.payload["ordinal"], 2_000_002);
            Ok(((), vec![]))
        }).unwrap();

        let (_, snapshot) = bus.thread_snapshot("t-order").unwrap().unwrap();
        let visible: Vec<(String, i64)> = snapshot["visibleTurnItems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| (entry["item"]["type"].as_str().unwrap().to_owned(), entry["item"]["ordinal"].as_i64().unwrap()))
            .collect();
        assert_eq!(visible, vec![
            ("user_message".into(), 1_000_001),
            ("reasoning".into(), 1_000_002),
            ("assistant_message".into(), 1_000_003),
            ("user_message".into(), 2_000_001),
            ("assistant_message".into(), 2_000_002),
        ]);

        // Now corrupt one run's rows as if written by the pre-fix server and verify startup repair fixes it.
        bus.commit(|tx| {
            let a2_id = "turn-item:provider:claudeAgent:native-item:a2";
            tx.execute("DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id='t-order'", [])?;
            tx.execute("UPDATE orchestration_v2_projection_turn_items SET ordinal=2, payload_json=json_set(payload_json,'$.ordinal',2) WHERE turn_item_id=?1", [a2_id])?;
            tx.execute("UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.ordinal',2) WHERE event_id='e-a2'", [])?;
            let repaired = repair_turn_item_positions(tx)?;
            assert!(repaired > 0);
            assert_eq!(repair_turn_item_positions(tx)?, 0);
            let ev_ord: i64 = tx.query_row("SELECT json_extract(payload_json,'$.ordinal') FROM orchestration_events WHERE event_id='e-a2'", [], |r| r.get(0))?;
            assert_eq!(ev_ord, 2_000_002);
            Ok(((), vec![]))
        }).unwrap();

        let (_, repaired_snapshot) = bus.thread_snapshot("t-order").unwrap().unwrap();
        let visible_after: Vec<(String, i64)> = repaired_snapshot["visibleTurnItems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| (entry["item"]["type"].as_str().unwrap().to_owned(), entry["item"]["ordinal"].as_i64().unwrap()))
            .collect();
        assert_eq!(visible_after, visible);
    }

}
