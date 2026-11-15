//! Durable dispatch of previously admitted webhook deliveries.
use crate::{
    event_bus::EventBus,
    provider::session_registry::SessionRegistry,
    webhook_template::{render_webhook_prompt, WebhookRequest},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;

// Never open the database inode just to lock it: closing that descriptor can
// release this process's SQLite POSIX locks on Unix. Keep the sidecar persistent.
#[cfg(any(unix, windows, test))]
fn try_sidecar_lock(path: &std::path::Path) -> Result<Option<std::fs::File>, String> {
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SQLite's WAL sidecars are path-based, so hard-link aliases are unsafe
        // even before considering the separate webhook-worker lock.
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.nlink() != 1 {
            return Err("Webhook dispatch requires a database without hard-link aliases.".into());
        }
    }
    let mut name = path.into_os_string();
    name.push(".webhook-worker.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&name).map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let opened = file.metadata().map_err(|e| e.to_string())?;
                let current = std::fs::symlink_metadata(&name).map_err(|e| e.to_string())?;
                if !opened.is_file() || opened.nlink() != 1 ||
                    (opened.dev(), opened.ino()) != (current.dev(), current.ino()) {
                    return Err("Webhook worker lock was replaced or is not a private file.".into());
                }
            }
            Ok(Some(file))
        },
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

// A forked child can temporarily inherit the open file description. Explicitly
// unlock it when dispatch ends instead of waiting for every duplicate to close.
#[cfg(unix)]
struct DatabaseLock(std::fs::File);

#[cfg(unix)]
impl Drop for DatabaseLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); }
    }
}

fn release_claims(tx: &rusqlite::Connection, delivery: &str) -> rusqlite::Result<()> {
    crate::webhook_dedupe::release(tx, delivery)?;
    // Coalesced relay deliveries share the pending owner; release every claim.
    tx.execute("DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id IN (SELECT substr(value, 16) FROM scheduled_task_webhook_pending, json_each(CASE WHEN json_valid(delivery_ids_json) THEN delivery_ids_json ELSE '[]' END) WHERE delivery_id=?1 AND value LIKE 'delivery:relay:%') OR relay_delivery_id=?2", params![delivery, delivery.strip_prefix("delivery:relay:").unwrap_or("")])?;
    Ok(())
}

fn fail_pending(tx: &rusqlite::Connection, delivery: &str, reason: &str) -> rusqlite::Result<()> {
    tx.execute("UPDATE scheduled_task_webhook_deliveries SET outcome='dispatch_failed',error=?2 WHERE delivery_id=?1", params![delivery, reason])?;
    release_claims(tx, delivery)?;
    tx.execute(
        "DELETE FROM scheduled_task_webhook_pending WHERE delivery_id=?1",
        [delivery],
    )?;
    Ok(())
}

/// Process one due delivery. A dispatching row retains the original attempt
/// timestamp and rendered prompt across restarts, making command ids stable.
pub fn run_one(bus: &EventBus, sessions: Option<&SessionRegistry>) -> Result<bool, String> {
    run_one_inner(bus, sessions, None)
}

/// Dispatch durable webhook work without blocking the scheduler on worktree setup.
pub fn run_one_background(
    bus: &EventBus,
    sessions: std::sync::Arc<SessionRegistry>,
) -> Result<bool, String> {
    run_one_inner(bus, Some(&sessions), Some(sessions.clone()))
}

fn run_one_inner(
    bus: &EventBus,
    sessions: Option<&SessionRegistry>,
    background_sessions: Option<std::sync::Arc<SessionRegistry>>,
) -> Result<bool, String> {
    // A persisted dispatching claim is recoverable after a process restart, but
    // must not be retried concurrently by two workers in the same process.
    static DISPATCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = DISPATCH_LOCK.lock().map_err(|e| e.to_string())?;
    // A process-local mutex cannot protect a shared SQLite database against a
    // second server process. Until a platform lock is implemented, fail closed
    // rather than dispatch the same durable claim concurrently.
    #[cfg(not(any(unix, windows)))]
    {
        let path: String = bus
            .commit(|tx| {
                let path = tx.query_row(
                    "SELECT file FROM pragma_database_list WHERE name='main'",
                    [],
                    |r| r.get(0),
                )?;
                Ok((path, vec![]))
            })
            .map_err(|e| e.to_string())?;
        if !path.is_empty() {
            return Err(
                "Webhook dispatch requires cross-process database locking on this platform.".into(),
            );
        }
    }
    // Dispatch spans transactions, so serialize workers on a stable sidecar.
    #[cfg(unix)]
    let _database_lock = {
        let path: String = bus.commit(|tx| {
            let path = tx.query_row("SELECT file FROM pragma_database_list WHERE name='main'", [], |r| r.get(0))?;
            Ok((path, vec![]))
        }).map_err(|e| e.to_string())?;
        if path.is_empty() { None } else {
            match try_sidecar_lock(std::path::Path::new(&path))? {
                Some(file) => Some(DatabaseLock(file)),
                None => return Ok(false),
            }
        }
    };
    // Windows SQLite uses byte-range locks on the database itself, so use a
    // separate stable file for the worker lock instead of locking the DB.
    #[cfg(windows)]
    let _database_lock = {
        let path: String = bus
            .commit(|tx| {
                let path = tx.query_row(
                    "SELECT file FROM pragma_database_list WHERE name='main'",
                    [],
                    |r| r.get(0),
                )?;
                Ok((path, vec![]))
            })
            .map_err(|e| e.to_string())?;
        if path.is_empty() {
            None
        } else {
            match try_sidecar_lock(std::path::Path::new(&path))? {
                Some(file) => Some(file),
                None => return Ok(false),
            }
        }
    };
    let now = Utc::now();
    let start = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let row = bus.commit(|tx| {
        let row: Option<(String,String,String,String,String)> = tx.query_row(
            "SELECT p.delivery_id,p.task_id,p.state,p.task_json,p.request_json FROM scheduled_task_webhook_pending p JOIN scheduled_tasks t ON t.task_id=p.task_id WHERE p.due_at<=?1 AND (p.state='dispatching' OR (p.state IN ('pending','ready') AND t.last_run_status<>'running')) ORDER BY p.due_at,p.delivery_id LIMIT 1", [now.timestamp_millis()], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let Some((delivery,id,state,task_json,request_json)) = row else { return Ok((None,vec![])) };
        let mut task: Value = match serde_json::from_str::<Value>(&task_json) {
            Ok(task) if task.is_object() && task["id"].as_str() == Some(id.as_str()) && task["createdAt"].is_string() && task["prompt"].is_string() => task,
            _ => { fail_pending(tx, &delivery, "The pending webhook payload could not be prepared.")?; return Ok((Some(None),vec![])); }
        };
        if state == "pending" || state == "ready" {
            let current = crate::scheduled_tasks::get(tx,&id).map_err(|_|rusqlite::Error::InvalidQuery)?.ok_or(rusqlite::Error::InvalidQuery)?;
            let reason = if current["createdAt"] != task["createdAt"] {
                Some("The task was replaced before this delivery ran.")
            } else if current["schedule"]["type"] != "webhook" {
                Some("The task's trigger changed before this delivery ran.")
            } else if current["enabled"] != true {
                Some("The task was paused before this delivery ran.")
            } else { None };
            if let Some(reason) = reason {
                fail_pending(tx, &delivery, reason)?;
                return Ok((Some(None),vec![]));
            }
            // The queued snapshot guards the task incarnation. The active task
            // supplies the current thread, mode and prompt at dispatch time.
            task = current;
            let req = serde_json::from_str::<Value>(&request_json).ok().and_then(|request| {
                Some(WebhookRequest { method:request["method"].as_str()?.into(), path:request["path"].as_str()?.into(), query:request["query"].as_str()?.into(), headers:serde_json::from_value::<BTreeMap<String,String>>(request["headers"].clone()).ok()?, body_text:request["bodyText"].as_str()?.into() })
            });
            let Some(req) = req else { fail_pending(tx, &delivery, "The pending webhook payload could not be prepared.")?; return Ok((Some(None),vec![])); };
            let frame = uuid::Uuid::new_v4().simple().to_string();
            let rendered = render_webhook_prompt(task["prompt"].as_str().unwrap_or(""),&req,&frame[..12],false);
            if rendered.prompt.trim().encode_utf16().count() > 120_000 {
                fail_pending(tx, &delivery, "The filled-in prompt is too long.")?;
                return Ok((Some(None), vec![]));
            }
            task["prompt"] = Value::String(rendered.prompt.clone());
            task["_webhookDeliveryId"] = Value::String(delivery.clone());
            task["lastRunAt"] = Value::String(start.clone());
            task["lastRunStatus"] = Value::String("running".into());
            tx.execute("UPDATE scheduled_tasks SET last_run_at=?2,updated_at=?2,last_run_status='running',last_run_error=NULL,last_run_webhook_delivery_id=?3 WHERE task_id=?1",params![id,start,delivery])?;
            tx.execute("UPDATE scheduled_task_webhook_pending SET state='dispatching',task_json=?2 WHERE delivery_id=?1 AND state IN ('pending','ready')",params![delivery,task.to_string()])?;
            tx.execute("UPDATE scheduled_task_webhook_deliveries SET rendered_prompt=?2,missing_fields_json=?3 WHERE delivery_id=?1",params![delivery,rendered.prompt,serde_json::to_string(&rendered.missing).unwrap()])?;
        }
        Ok((Some(Some((delivery,task))),vec![]))
    }).map_err(|e|e.to_string())?;
    let (delivery, task) = match row {
        None => return Ok(false),
        Some(None) => return Ok(true),
        Some(Some(work)) => work,
    };
    let deferred = background_sessions.is_some()
        && task["threadId"].is_null()
        && task["workspaceStrategy"]["type"] == "worktree";
    let mut prepared_thread = None;
    let result = if deferred {
        crate::scheduled_tasks::start_scheduled_preparation(bus, &task, "webhook", sessions)
            .map(|thread| prepared_thread = Some(thread))
    } else if task["threadId"].is_string() {
        crate::scheduled_tasks::dispatch_bound(bus, &task, "webhook", sessions)
    } else {
        crate::scheduled_tasks::dispatch_new_thread(bus, &task, "webhook", sessions).map(|_| ())
    };
    bus.commit(|tx| {
        if let Some(thread) = &prepared_thread {
            crate::scheduled_tasks::bind_thread(tx, &task, thread)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
        }
        crate::scheduled_tasks::complete_run(
            tx,
            &task,
            Utc::now(),
            result.as_ref().err().map(String::as_str),
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
        tx.execute(
            "UPDATE scheduled_task_webhook_deliveries SET outcome=?2,error=?3 WHERE delivery_id=?1",
            params![
                delivery,
                if result.is_ok() {
                    "accepted"
                } else {
                    "dispatch_failed"
                },
                result.as_ref().err()
            ],
        )?;
        if result.is_err() {
            release_claims(tx, &delivery)?;
        }
        tx.execute(
            "DELETE FROM scheduled_task_webhook_pending WHERE delivery_id=?1",
            [&delivery],
        )?;
        Ok(((), vec![]))
    })
    .map_err(|e| e.to_string())?;
    if result.is_ok() && deferred {
        let worker_bus = bus.clone();
        let sessions = background_sessions.expect("deferred preparation needs sessions");
        std::thread::spawn(move || {
            if let Err(error) = crate::scheduled_tasks::dispatch_new_thread(
                &worker_bus,
                &task,
                "webhook",
                Some(&sessions),
            ) {
                eprintln!("Warning: webhook worktree preparation failed: {error}");
            }
        });
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sidecar_lock_excludes_other_workers_and_releases_on_close() {
        let path =
            std::env::temp_dir().join(format!("webhook-lock-{}.sqlite", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let owner = try_sidecar_lock(&path).unwrap().unwrap();
        assert!(try_sidecar_lock(&path).unwrap().is_none());
        drop(owner);
        assert!(try_sidecar_lock(&path).unwrap().is_some());
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".webhook-worker.lock");
        std::fs::remove_file(lock_path).unwrap();
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_database_paths_share_the_worker_lock_across_processes() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("webhook-alias-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("state.sqlite");
        std::fs::File::create(&path).unwrap();
        let alias = dir.join("alias.sqlite");
        symlink(&path, &alias).unwrap();
        let owner = try_sidecar_lock(&path).unwrap().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "webhook_worker::tests::external_worker_fixture", "--nocapture"])
            .env("T3_TEST_WEBHOOK_DATABASE", &alias)
            .env("T3_TEST_WEBHOOK_MODE", "lock")
            .status().unwrap();
        assert!(status.success());
        drop(owner);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_linked_databases_and_symlinked_sidecars() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("webhook-hardlink-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("state.sqlite");
        std::fs::File::create(&path).unwrap();
        let alias = dir.join("alias.sqlite");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(try_sidecar_lock(&path).is_err());
        assert!(try_sidecar_lock(&alias).is_err());
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "webhook_worker::tests::external_worker_fixture", "--nocapture"])
            .env("T3_TEST_WEBHOOK_DATABASE", &alias)
            .env("T3_TEST_WEBHOOK_MODE", "reject")
            .status().unwrap();
        assert!(status.success());
        std::fs::remove_file(&alias).unwrap();
        let sidecar = dir.join("state.sqlite.webhook-worker.lock");
        symlink(&path, &sidecar).unwrap();
        assert!(try_sidecar_lock(&path).is_err());
        std::fs::remove_file(&sidecar).unwrap();
        std::fs::hard_link(&path, &sidecar).unwrap();
        assert!(try_sidecar_lock(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn another_connection_cannot_recover_a_live_dispatch() {
        let path =
            std::env::temp_dir().join(format!("webhook-worker-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = rusqlite::Connection::open(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let input = json!({"commandId":"hook", "title":"t", "prompt":"hello", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"missing", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
        let mut task = crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        task["lastRunAt"] = json!("2026-01-01T00:00:00.000Z");
        task["lastRunStatus"] = json!("running");
        db.execute("UPDATE scheduled_tasks SET enabled=1,last_run_status='running',last_run_webhook_delivery_id='d'", []).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')", []).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,state,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,'dispatching',?1,'{}','[\"d\"]')", [task.to_string()]).unwrap();
        let other = rusqlite::Connection::open(&path).unwrap();
        let bus = EventBus::new(other, 16);
        // This independent open file description models a live worker process.
        let owner = DatabaseLock(try_sidecar_lock(&path).unwrap().unwrap());
        assert!(!run_one(&bus, None).unwrap());
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM scheduled_task_webhook_pending",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        // A duplicate models a descriptor inherited by a concurrent fork.
        let inherited = owner.0.try_clone().unwrap();
        drop(owner);
        assert!(run_one(&bus, None).unwrap());
        drop(inherited);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM scheduled_task_webhook_pending",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(bus);
        drop(db);
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".webhook-worker.lock");
        std::fs::remove_file(lock_path).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    // Invoked in a fresh process so SQLite's OS locks and WAL lifetime are real.
    #[cfg(unix)]
    #[test]
    fn external_worker_fixture() {
        let Ok(path) = std::env::var("T3_TEST_WEBHOOK_DATABASE") else { return };
        let mode = std::env::var("T3_TEST_WEBHOOK_MODE").unwrap();
        if mode == "lock" {
            assert!(try_sidecar_lock(std::path::Path::new(&path)).unwrap().is_none());
        } else if mode == "reject" {
            assert!(try_sidecar_lock(std::path::Path::new(&path)).is_err());
        } else {
            let db = crate::database::open_writer(std::path::Path::new(&path)).unwrap();
            db.execute("INSERT INTO webhook_lock_probe VALUES ('external')", []).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn worker_lock_preserves_sqlite_wal_and_excludes_other_processes() {
        let dir = std::env::temp_dir().join(format!("webhook-wal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("state.sqlite");
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute_batch("CREATE TABLE webhook_lock_probe(value TEXT); INSERT INTO webhook_lock_probe VALUES ('initial');").unwrap();
        let bus = EventBus::new(crate::database::open_writer(&path).unwrap(), 16);
        assert!(!run_one(&bus, None).unwrap());
        let run_child = |mode: &str| {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "webhook_worker::tests::external_worker_fixture", "--nocapture"])
                .env("T3_TEST_WEBHOOK_DATABASE", &path)
                .env("T3_TEST_WEBHOOK_MODE", mode)
                .status().unwrap();
            assert!(status.success());
        };
        let owner = DatabaseLock(try_sidecar_lock(&path).unwrap().unwrap());
        run_child("lock");
        drop(owner);
        run_child("write");
        let count: i64 = db.query_row("SELECT count(*) FROM webhook_lock_probe WHERE value='external'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "worker lock must not discard SQLite locks or split the WAL");
        drop(bus);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_claim_keeps_its_identity_on_recovery() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let input = json!({"commandId":"hook", "title":"t", "prompt":"ignored", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"p", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
        let mut task = crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        let started = "2026-01-01T00:00:00.000Z";
        task["prompt"] = json!("persisted prompt");
        task["lastRunAt"] = json!(started);
        task["lastRunStatus"] = json!("running");
        db.execute("UPDATE scheduled_tasks SET enabled=1,last_run_status='running',last_run_at=?1,last_run_webhook_delivery_id='d'",[started]).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')",[]).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,state,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,'dispatching',?1,'{}','[\"d\"]')",[task.to_string()]).unwrap();
        assert_eq!(
            crate::scheduled_tasks::recover_interrupted(&db, Utc::now()).unwrap(),
            0
        );
        let bus = EventBus::new(db, 16);
        assert!(run_one(&bus, None).unwrap());
        assert!(!run_one(&bus, None).unwrap());
        bus.commit(|tx| { let (id,text):(String,String)=tx.query_row("SELECT message_id,json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert!(id.contains("1767225600000:webhook")); assert_eq!(text,"persisted prompt"); Ok(((),vec![])) }).unwrap();
    }
    #[test]
    fn retries_after_commit_failure_without_duplicate_message() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let input = json!({"commandId":"hook", "title":"t", "prompt":"hello", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"p", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
        let task = crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')",[]).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,?1,?2,'[\"d\"]')",params![task.to_string(),json!({"method":"POST","path":"/","query":"","headers":{},"bodyText":""}).to_string()]).unwrap();
        db.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON scheduled_task_webhook_pending BEGIN SELECT RAISE(FAIL,'injected crash'); END;").unwrap();
        let bus = EventBus::new(db, 16);
        assert!(run_one(&bus, None).is_err());
        bus.commit(|tx| {
            tx.execute_batch("DROP TRIGGER fail_delete")?;
            Ok(((), vec![]))
        })
        .unwrap();
        assert!(run_one(&bus, None).unwrap());
        bus.commit(|tx| {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_messages",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn skips_paused_or_changed_tasks_and_discards_malformed_payloads() {
        for case in ["paused", "trigger", "task_json", "request_json"] {
            let mut db = rusqlite::Connection::open_in_memory().unwrap();
            crate::migrations::run_ported_migrations(&mut db).unwrap();
            let input = json!({"commandId":"hook", "title":"t", "prompt":"hello", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"p", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
            let task = crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
            if case != "paused" {
                db.execute("UPDATE scheduled_tasks SET enabled=1", [])
                    .unwrap();
            }
            if case == "trigger" {
                db.execute(r#"UPDATE scheduled_tasks SET schedule_json='{"type":"interval","everyMs":60000}'"#, []).unwrap();
            }
            db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')",[]).unwrap();
            let task_json = if case == "task_json" {
                "broken".to_owned()
            } else {
                task.to_string()
            };
            let request_json = if case == "request_json" {
                "broken".to_owned()
            } else {
                json!({"method":"POST","path":"/","query":"","headers":{},"bodyText":""})
                    .to_string()
            };
            db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,?1,?2,'[\"d\"]')",params![task_json,request_json]).unwrap();
            db.execute("INSERT INTO scheduled_task_webhook_replay_keys(task_id,replay_key,delivery_id,expires_at) VALUES('scheduled-task:hook','k','d',9999999999999)",[]).unwrap();
            let bus = EventBus::new(db, 16);
            assert!(run_one(&bus, None).unwrap(), "{case}");
            assert!(!run_one(&bus, None).unwrap(), "{case}");
            bus.commit(|tx| {
                let (outcome,error):(String,String)=tx.query_row("SELECT outcome,error FROM scheduled_task_webhook_deliveries WHERE delivery_id='d'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
                assert_eq!(outcome,"dispatch_failed", "{case}");
                assert!(error.contains(match case { "paused"=>"paused", "trigger"=>"trigger changed", _=>"could not be prepared" }), "{case}: {error}");
                let claims:i64=tx.query_row("SELECT count(*) FROM scheduled_task_webhook_replay_keys",[],|r|r.get(0))?;
                assert_eq!(claims,0);
                let messages:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_projection_messages",[],|r|r.get(0))?;
                assert_eq!(messages,0);
                Ok(((),vec![]))
            }).unwrap();
        }
    }
    #[test]
    fn dispatches_a_durable_delivery() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let input = json!({"commandId":"hook", "title":"t", "prompt":"Hello {{body.name}}", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"p", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
        let task = crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        let request = json!({"method":"POST","path":"/api/hooks/scheduled-task%3Ahook","query":"","headers":{},"bodyText":"{\"name\":\"Ada\"}"});
        db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')",[]).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,?1,?2,'[\"d\"]')",params![task.to_string(),request.to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let bus = bus.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    run_one(&bus, None).unwrap()
                })
            })
            .collect();
        barrier.wait();
        let processed = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|processed| *processed)
            .count();
        assert_eq!(processed, 1);
        assert!(!run_one(&bus, None).unwrap());
        bus.commit(|tx| {
            let text:String = tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages",[],|r|r.get(0))?;
            assert!(text.contains("Ada"));
            assert!(text.contains("webhook-data-"));
            let count:i64 = tx.query_row("SELECT count(*) FROM scheduled_task_webhook_pending",[],|r|r.get(0))?;
            assert_eq!(count,0);
            Ok(((),vec![]))
        }).unwrap();
    }
}
