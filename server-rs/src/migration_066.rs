//! Migration 066: repair settlement timestamps from affected client sweeps.
use rusqlite::{params, Transaction};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnState {
    Running,
    Completed,
    Interrupted,
    Error,
}
struct Turn {
    state: TurnState,
    checkpoint: Option<i64>,
}
struct Repair {
    occurred_at: String,
    cutoff: f64,
    activity: Option<String>,
    time: f64,
}
struct Event {
    sequence: i64,
    kind: String,
    occurred_at: String,
    turn_id: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    completed_at: Option<String>,
    role: Option<String>,
    streaming: Option<i64>,
    status: Option<String>,
    session_turn_id: Option<String>,
    session_updated_at: Option<String>,
    checkpoint: Option<i64>,
    turn_count: Option<i64>,
}

fn epoch(tx: &Transaction<'_>, value: &str) -> rusqlite::Result<Option<f64>> {
    tx.query_row("SELECT unixepoch(?1, 'subsec')", [value], |row| row.get(0))
}
fn record(
    tx: &Transaction<'_>,
    repairs: &mut [Repair],
    value: Option<&str>,
) -> rusqlite::Result<()> {
    if let Some((value, time)) = value
        .map(|value| epoch(tx, value).map(|time| time.map(|t| (value, t))))
        .transpose()?
        .flatten()
    {
        for repair in repairs {
            if time <= repair.cutoff && time > repair.time {
                repair.activity = Some(value.to_owned());
                repair.time = time;
            }
        }
    }
    Ok(())
}

pub fn apply_migration_066(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let settlements = {
        let mut stmt = tx.prepare(r#"
        WITH legacy_settlements AS (
          SELECT stream_id AS thread_id, occurred_at, unixepoch(occurred_at, 'subsec') AS occurred_seconds
          FROM orchestration_events WHERE aggregate_kind = 'thread' AND event_type = 'thread.settled'
          AND actor_kind = 'client' AND application_event_version = 1
          AND json_type(payload_json, '$.settledAt') = 'text'
          AND json_extract(payload_json, '$.settledAt') = occurred_at
          AND json_extract(metadata_json, '$.origin.appVersion') IN ('0.0.35', '0.0.36', '0.0.37', '0.0.38')
          AND julianday(occurred_at) < julianday('2026-09-05T00:00:00.000Z')
        ), ordered AS (
          SELECT thread_id, occurred_at, occurred_seconds,
          occurred_seconds - LAG(occurred_seconds) OVER (ORDER BY occurred_seconds, thread_id) AS gap_seconds
          FROM legacy_settlements
        ), clustered AS (
          SELECT thread_id, occurred_at, occurred_seconds,
          SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > 30 THEN 1 ELSE 0 END)
          OVER (ORDER BY occurred_seconds, thread_id) AS cluster_id FROM ordered
        ), burst_clusters AS (
          SELECT cluster_id, COUNT(DISTINCT thread_id) AS distinct_thread_count,
          MAX(occurred_seconds) - MIN(occurred_seconds) AS span_seconds FROM clustered GROUP BY cluster_id
        ) SELECT DISTINCT clustered.thread_id, clustered.occurred_at FROM clustered
        JOIN burst_clusters ON burst_clusters.cluster_id = clustered.cluster_id
        WHERE burst_clusters.distinct_thread_count >= 10 AND burst_clusters.span_seconds <= 120
        ORDER BY clustered.thread_id, clustered.occurred_at"#)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut by_thread: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, at) in settlements {
        by_thread.entry(id).or_default().push(at);
    }
    for (thread_id, sweeps) in by_thread {
        let mut repairs = Vec::new();
        for occurred_at in sweeps {
            let cutoff = epoch(tx, &occurred_at)?.ok_or(rusqlite::Error::InvalidQuery)?;
            repairs.push(Repair {
                occurred_at,
                cutoff,
                activity: None,
                time: f64::NEG_INFINITY,
            });
        }
        for i in 0..repairs.len() {
            let latest: Option<String> = tx.query_row(
                "SELECT (SELECT created_at FROM projection_thread_messages WHERE thread_id = ?1 AND role = 'user' AND julianday(created_at) <= julianday(?2) ORDER BY julianday(created_at) DESC LIMIT 1)",
                params![thread_id, repairs[i].occurred_at], |row| row.get(0))?;
            record(tx, &mut repairs, latest.as_deref())?;
        }
        let mut turns: HashMap<String, Turn> = HashMap::new();
        let mut running: HashSet<String> = HashSet::new();
        let mut active: Option<String> = None;
        let mut after_sequence = 0_i64;
        loop {
            let events = {
                let mut stmt = tx.prepare(r#"SELECT sequence, event_type, occurred_at,
                  json_extract(payload_json,'$.turnId'), json_extract(payload_json,'$.createdAt'),
                  json_extract(payload_json,'$.updatedAt'), json_extract(payload_json,'$.completedAt'),
                  json_extract(payload_json,'$.role'), json_extract(payload_json,'$.streaming'),
                  json_extract(payload_json,'$.session.status'), json_extract(payload_json,'$.session.activeTurnId'),
                  json_extract(payload_json,'$.session.updatedAt'), json_extract(payload_json,'$.checkpointTurnCount'),
                  json_extract(payload_json,'$.turnCount')
                  FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
                  WHERE aggregate_kind='thread' AND stream_id=?1 AND application_event_version=1 AND sequence>?2
                  AND event_type IN ('thread.created','thread.turn-start-requested','thread.session-set',
                  'thread.message-sent','thread.turn-interrupt-requested','thread.turn-diff-completed','thread.reverted')
                  ORDER BY sequence LIMIT 500"#)?;
                let rows = stmt
                    .query_map(params![thread_id, after_sequence], |r| {
                        Ok(Event {
                            sequence: r.get(0)?,
                            kind: r.get(1)?,
                            occurred_at: r.get(2)?,
                            turn_id: r.get(3)?,
                            created_at: r.get(4)?,
                            updated_at: r.get(5)?,
                            completed_at: r.get(6)?,
                            role: r.get(7)?,
                            streaming: r.get(8)?,
                            status: r.get(9)?,
                            session_turn_id: r.get(10)?,
                            session_updated_at: r.get(11)?,
                            checkpoint: r.get(12)?,
                            turn_count: r.get(13)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for event in &events {
                match event.kind.as_str() {
                    "thread.created" => {
                        turns.clear();
                        running.clear();
                        active = None;
                    }
                    "thread.turn-start-requested" => {
                        record(tx, &mut repairs, event.created_at.as_deref())?
                    }
                    "thread.session-set" => {
                        active = if event.status.as_deref() == Some("running") {
                            event.session_turn_id.clone()
                        } else {
                            None
                        };
                        let ended_at = match event.session_updated_at.as_deref() {
                            Some(at) if epoch(tx, at)?.is_some() => at,
                            _ => &event.occurred_at,
                        };
                        if let Some(ref id) = active {
                            for other in running.clone() {
                                if &other != id {
                                    turns.get_mut(&other).expect("running turn").state =
                                        TurnState::Completed;
                                    running.remove(&other);
                                    record(tx, &mut repairs, Some(ended_at))?;
                                }
                            }
                            if !turns.contains_key(id) {
                                turns.insert(
                                    id.clone(),
                                    Turn {
                                        state: TurnState::Running,
                                        checkpoint: None,
                                    },
                                );
                                running.insert(id.clone());
                                record(tx, &mut repairs, Some(&event.occurred_at))?;
                            } else if turns[id].state == TurnState::Interrupted {
                                turns.get_mut(id).unwrap().state = TurnState::Running;
                                running.insert(id.clone());
                            }
                        } else if matches!(
                            event.status.as_deref(),
                            Some("idle" | "ready" | "error" | "interrupted" | "stopped")
                        ) {
                            for id in running.drain() {
                                turns.get_mut(&id).expect("running turn").state =
                                    match event.status.as_deref() {
                                        Some("error") => TurnState::Error,
                                        Some("interrupted" | "stopped") => TurnState::Interrupted,
                                        _ => TurnState::Completed,
                                    };
                                record(tx, &mut repairs, Some(ended_at))?;
                            }
                        }
                    }
                    "thread.message-sent" => {
                        if event.role.as_deref() != Some("assistant") {
                            continue;
                        }
                        let Some(id) = event.turn_id.as_ref() else {
                            continue;
                        };
                        record(tx, &mut repairs, event.created_at.as_deref())?;
                        if event.streaming == Some(0) && active.as_ref() != Some(id) {
                            if turns
                                .get(id)
                                .is_none_or(|turn| turn.state == TurnState::Running)
                            {
                                record(tx, &mut repairs, event.updated_at.as_deref())?;
                            }
                            let turn = turns.entry(id.clone()).or_insert(Turn {
                                state: TurnState::Completed,
                                checkpoint: None,
                            });
                            if turn.state == TurnState::Running {
                                turn.state = TurnState::Completed;
                            }
                            running.remove(id);
                        } else if !turns.contains_key(id) {
                            turns.insert(
                                id.clone(),
                                Turn {
                                    state: TurnState::Running,
                                    checkpoint: None,
                                },
                            );
                            running.insert(id.clone());
                        }
                    }
                    "thread.turn-interrupt-requested" => {
                        let Some(id) = event.turn_id.as_ref() else {
                            continue;
                        };
                        record(tx, &mut repairs, event.created_at.as_deref())?;
                        let checkpoint = turns.get(id).and_then(|turn| turn.checkpoint);
                        turns.insert(
                            id.clone(),
                            Turn {
                                state: TurnState::Interrupted,
                                checkpoint,
                            },
                        );
                        running.remove(id);
                    }
                    "thread.turn-diff-completed" => {
                        let Some(id) = event.turn_id.as_ref() else {
                            continue;
                        };
                        record(tx, &mut repairs, event.completed_at.as_deref())?;
                        let previous = turns.get(id).map(|turn| turn.state);
                        let state = if active.as_ref() == Some(id) {
                            previous.unwrap_or(TurnState::Running)
                        } else if previous == Some(TurnState::Interrupted) {
                            TurnState::Interrupted
                        } else {
                            TurnState::Completed
                        };
                        turns.insert(
                            id.clone(),
                            Turn {
                                state,
                                checkpoint: event.checkpoint,
                            },
                        );
                        if state == TurnState::Running {
                            running.insert(id.clone());
                        } else {
                            running.remove(id);
                        }
                    }
                    "thread.reverted" => {
                        turns.retain(|id, turn| {
                            let retain = turn.checkpoint.is_some_and(|checkpoint| {
                                checkpoint <= event.turn_count.unwrap_or(0)
                            });
                            if !retain {
                                running.remove(id);
                            }
                            retain
                        });
                    }
                    _ => {}
                }
            }
            if events.len() < 500 {
                break;
            }
            after_sequence = events.last().expect("nonempty page").sequence;
        }
        for repair in repairs {
            tx.execute("UPDATE projection_threads SET settled_at=COALESCE(?1,created_at) WHERE thread_id=?2 AND settled_override='settled' AND settled_at=?3",params![repair.activity,thread_id,repair.occurred_at])?;
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledAt',COALESCE(?1,json_extract(payload_json,'$.createdAt'))) WHERE thread_id=?2 AND json_extract(payload_json,'$.settledOverride')='settled' AND json_extract(payload_json,'$.settledAt')=?3",params![repair.activity,thread_id,repair.occurred_at])?;
            tx.execute("UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.settledAt',COALESCE(?1,json_extract(payload_json,'$.createdAt'),json_extract(payload_json,'$.settledAt'))) WHERE aggregate_kind='thread' AND stream_id=?2 AND application_event_version=2 AND json_extract(payload_json,'$.settledOverride')='settled' AND json_extract(payload_json,'$.settledAt')=?3",params![repair.activity,thread_id,repair.occurred_at])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::run_ported_migrations_to;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn repairs_only_dense_client_sweeps_and_replays_retained_turns() {
        let mut db = Connection::open_in_memory().unwrap();
        run_ported_migrations_to(&mut db, 63).unwrap();
        let created = "2026-03-01T00:00:00.000Z";
        let sweep = "2026-09-04T13:33:00.000Z";
        for i in 0..11 {
            let id = format!("thread-{i:02}");
            let version = if i == 10 { "0.0.40" } else { "0.0.37" };
            let metadata = json!({"origin":{"appVersion":version}}).to_string();
            let payload = json!({"settledAt":sweep}).to_string();
            db.execute("INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,settled_override,settled_at) VALUES (?1,'p','t','{}',?2,?3,'settled',?3)",params![id,created,sweep]).unwrap();
            db.execute("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?1,'thread',?1,0,'thread.settled',?2,'client',?3,?4,1)",params![id,sweep,payload,metadata]).unwrap();
        }
        let message = "2026-04-01T00:00:00.000Z";
        db.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('m','thread-00','user','x',0,?1,?1)",[message]).unwrap();
        let start = "2026-06-01T00:00:00.000Z";
        let finish = "2026-06-01T00:05:00.000Z";
        for (version, at, status, active) in [
            (1, start, "running", Some("turn")),
            (2, finish, "ready", None),
            (3, "2026-06-03T00:00:00.000Z", "stopped", None),
        ] {
            let payload = json!({"session":{"status":status,"activeTurnId":active,"updatedAt":at}})
                .to_string();
            db.execute("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?1,'thread','thread-01',?2,'thread.session-set',?3,'server',?4,'{}',1)",params![format!("session-{version}"),version,at,payload]).unwrap();
        }
        let snapshot =
            json!({"createdAt":created,"settledAt":sweep,"settledOverride":"settled"}).to_string();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('thread-00','p','t','codex','full-access','default',?1,?2,?3)",params![created,sweep,snapshot]).unwrap();
        db.execute("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('snapshot','thread','thread-00',1,'thread.created',?1,'server',?2,'{}',2)",params![sweep,snapshot]).unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_066(&tx).unwrap();
        apply_migration_066(&tx).unwrap();
        tx.commit().unwrap();
        for (id, expected) in [
            ("thread-00", message),
            ("thread-01", finish),
            ("thread-02", created),
            ("thread-10", sweep),
        ] {
            let result: String = db
                .query_row(
                    "SELECT settled_at FROM projection_threads WHERE thread_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(result, expected, "{id}");
        }
        for sql in ["SELECT json_extract(payload_json,'$.settledAt') FROM orchestration_v2_projection_threads WHERE thread_id='thread-00'", "SELECT json_extract(payload_json,'$.settledAt') FROM orchestration_events WHERE event_id='snapshot'"] {
            assert_eq!(db.query_row(sql,[],|r|r.get::<_,String>(0)).unwrap(),message);
        }
        assert_eq!(db.query_row("SELECT json_extract(payload_json,'$.settledAt') FROM orchestration_events WHERE event_id='thread-00'",[],|r|r.get::<_,String>(0)).unwrap(),sweep);
    }
}
