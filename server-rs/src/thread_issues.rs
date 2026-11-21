//! Issues linked to threads (`thread.issue.link`, `thread.issue.unlink`, and `issues.linkedThreads`).
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
    thread_commands::CommitResult,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadIssueKey {
    pub tracker: String,
    pub host: String,
    pub scope: String,
    pub key: String,
}

impl ThreadIssueKey {
    pub fn normalized(tracker: &str, host: &str, scope: &str, key: &str) -> Self {
        Self {
            tracker: tracker.trim().to_owned(),
            host: host.trim().to_ascii_lowercase(),
            scope: scope.trim().to_owned(),
            key: key.trim().to_owned(),
        }
    }

    pub fn matches_link(&self, link: &Value) -> bool {
        let lt = link.get("tracker").and_then(Value::as_str).unwrap_or("").trim();
        let lh = link.get("host").and_then(Value::as_str).unwrap_or("").trim();
        let ls = link.get("scope").and_then(Value::as_str).unwrap_or("").trim();
        let lk = link.get("key").and_then(Value::as_str).unwrap_or("").trim();
        lt == self.tracker
            && lh.eq_ignore_ascii_case(&self.host)
            && ls.eq_ignore_ascii_case(&self.scope)
            && lk.eq_ignore_ascii_case(&self.key)
    }
}

#[derive(Clone, Debug)]
pub struct LinkThreadIssue<'a> {
    pub tracker: &'a str,
    pub host: &'a str,
    pub scope: &'a str,
    pub key: &'a str,
    pub project_id: &'a str,
    pub url: &'a str,
    pub display_key: &'a str,
    pub title: &'a str,
    pub source: &'a str,
}

pub enum IssueCommand<'a> {
    Link(LinkThreadIssue<'a>),
    Unlink(ThreadIssueKey),
}

pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: IssueCommand<'_>,
    now: &str,
) -> Result<CommitResult, BusError> {
    dispatch_checked(bus, command_id, thread_id, command, now, |_| Ok(()))
}

pub fn dispatch_checked<F>(
    bus: &EventBus,
    command_id: &str,
    thread_id: &str,
    command: IssueCommand<'_>,
    now: &str,
    check: F,
) -> Result<CommitResult, BusError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    let kind = match command {
        IssueCommand::Link(_) => "thread.issue.link",
        IssueCommand::Unlink(_) => "thread.issue.unlink",
    };
    bus.commit(|tx| {
        check(tx)?;
        if let Some(receipt) = event_store::get_receipt(tx, command_id, "thread")? {
            return Ok((
                CommitResult {
                    receipt,
                    committed: false,
                },
                vec![],
            ));
        }
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT payload_json, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?1",
                [thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let error = match &row {
            None => Some(format!("Thread {thread_id} does not exist.")),
            Some((_, Some(_))) => Some(format!("Thread {thread_id} is deleted.")),
            Some(_) => None,
        };
        let mut receipt = Receipt {
            command_id: command_id.into(),
            aggregate_kind: "thread".into(),
            aggregate_id: thread_id.into(),
            command_type: kind.into(),
            accepted_at: now.into(),
            result_sequence: event_store::latest_thread_sequence(tx, Some(thread_id))?,
            status: if error.is_some() { "rejected" } else { "accepted" }.into(),
            error,
        };
        if !event_store::insert_receipt_if_absent(tx, &receipt)? {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if receipt.error.is_some() {
            return Ok((
                CommitResult {
                    receipt,
                    committed: false,
                },
                vec![],
            ));
        }
        let mut thread: Value =
            serde_json::from_str(&row.unwrap().0).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let links = thread
            .get("issues")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next_links = match command {
            IssueCommand::Unlink(ref key) => {
                let Some(pos) = links.iter().position(|link| key.matches_link(link)) else {
                    return Ok((
                        CommitResult {
                            receipt,
                            committed: false,
                        },
                        vec![],
                    ));
                };
                let mut updated = links;
                updated.remove(pos);
                updated
            }
            IssueCommand::Link(ref link) => {
                let key = ThreadIssueKey::normalized(link.tracker, link.host, link.scope, link.key);
                if links.iter().any(|existing| key.matches_link(existing)) {
                    return Ok((
                        CommitResult {
                            receipt,
                            committed: false,
                        },
                        vec![],
                    ));
                }
                let mut updated = links;
                updated.push(json!({
                    "tracker": key.tracker,
                    "host": key.host,
                    "scope": key.scope,
                    "key": key.key,
                    "projectId": link.project_id,
                    "url": link.url,
                    "displayKey": link.display_key,
                    "title": link.title,
                    "source": link.source,
                    "linkedAt": now,
                }));
                updated
            }
        };
        thread["issues"] = Value::Array(next_links);
        thread["updatedAt"] = json!(now);
        let payload_json =
            serde_json::to_string(&thread).map_err(|_| rusqlite::Error::InvalidQuery)?;
        tx.execute(
            "UPDATE orchestration_v2_projection_threads SET payload_json = ?2, updated_at = ?3 WHERE thread_id = ?1",
            params![thread_id, payload_json, now],
        )?;
        let event = Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread_id.to_owned(),
            event_type: "thread.issue-synced".into(),
            occurred_at: now.to_owned(),
            command_id: Some(command_id.to_owned()),
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "server".into(),
            payload: thread,
            metadata: json!({}),
        };
        let events = event_store::append(tx, &[event])?;
        receipt.result_sequence = events.last().unwrap().sequence;
        event_store::upsert_receipt(tx, &receipt)?;
        Ok((
            CommitResult {
                receipt,
                committed: true,
            },
            events,
        ))
    })
}

pub fn linked_threads(db: &Connection, payload: &Value) -> Result<Value, Value> {
    let err = || {
        json!({
            "_tag": "IssueOperationError",
            "operation": "linkedThreads",
            "detail": "Could not load linked threads.",
        })
    };
    let tracker = payload
        .get("tracker")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(err)?;
    let host = payload
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(err)?;
    let scope = payload
        .get("scope")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(err)?;
    let key_str = payload
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(err)?;
    let key = ThreadIssueKey::normalized(tracker, host, scope, key_str);

    let mut stmt = db
        .prepare(
            "SELECT t.thread_id, t.project_id, t.title, t.archived_at,
               (json_extract(t.payload_json, '$.settledAt') IS NOT NULL
                OR json_extract(t.payload_json, '$.settledOverride') IS 'settled') AS settled,
               json_extract(link.value, '$.tracker') AS tracker,
               json_extract(link.value, '$.host') AS host,
               json_extract(link.value, '$.scope') AS scope,
               json_extract(link.value, '$.key') AS ikey,
               t.updated_at
             FROM orchestration_v2_projection_threads AS t
             JOIN json_each(t.payload_json, '$.issues') AS link
             WHERE t.deleted_at IS NULL
               AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
             ORDER BY t.updated_at DESC, t.thread_id ASC",
        )
        .map_err(|_| err())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)? == 1,
                ThreadIssueKey::normalized(
                    &row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    &row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    &row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    &row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                ),
            ))
        })
        .map_err(|_| err())?;

    let mut threads = Vec::new();
    for item in rows {
        let (id, project_id, title, archived_at, settled, row_key) = item.map_err(|_| err())?;
        if row_key.tracker == key.tracker
            && row_key.host.eq_ignore_ascii_case(&key.host)
            && row_key.scope.eq_ignore_ascii_case(&key.scope)
            && row_key.key.eq_ignore_ascii_case(&key.key)
        {
            threads.push(json!({
                "id": id,
                "projectId": project_id,
                "title": title,
                "archivedAt": archived_at,
                "settled": settled,
            }));
        }
    }
    Ok(json!({ "threads": threads }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_unlink_and_list_linked_threads_round_trip() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t1","projectId":"p1","title":"Fix login","updatedAt":"2026-01-01T00:00:00Z"});
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t1','p1','Fix login','codex','full-access','default','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?1)",
            [thread.to_string()],
        )
        .unwrap();
        let bus = EventBus::new(db, 8);
        let first = dispatch(
            &bus,
            "cmd-link-1",
            "t1",
            IssueCommand::Link(LinkThreadIssue {
                tracker: "linear",
                host: "Linear.app",
                scope: "eng",
                key: "ENG-12",
                project_id: "p1",
                url: "https://linear.app/acme/issue/ENG-12",
                display_key: "ENG-12",
                title: "Broken login",
                source: "agent",
            }),
            "2026-01-02T00:00:00Z",
        )
        .unwrap();
        assert!(first.committed);
        // Duplicate link is a no-op.
        let dup = dispatch(
            &bus,
            "cmd-link-2",
            "t1",
            IssueCommand::Link(LinkThreadIssue {
                tracker: "linear",
                host: "linear.app",
                scope: "ENG",
                key: "eng-12",
                project_id: "p1",
                url: "https://linear.app/acme/issue/ENG-12",
                display_key: "ENG-12",
                title: "Broken login",
                source: "agent",
            }),
            "2026-01-02T00:01:00Z",
        )
        .unwrap();
        assert!(!dup.committed);

        bus.commit(|tx| {
            let res = linked_threads(
                tx,
                &json!({"tracker":"linear","host":"linear.app","scope":"ENG","key":"ENG-12"}),
            )
            .unwrap();
            assert_eq!(res["threads"].as_array().unwrap().len(), 1);
            assert_eq!(res["threads"][0]["id"], "t1");
            Ok(((), vec![]))
        })
        .unwrap();

        let unlinked = dispatch(
            &bus,
            "cmd-unlink-1",
            "t1",
            IssueCommand::Unlink(ThreadIssueKey::normalized("linear", "linear.app", "ENG", "ENG-12")),
            "2026-01-03T00:00:00Z",
        )
        .unwrap();
        assert!(unlinked.committed);
    }
}
