#![cfg(unix)]

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::json;
use std::{
    path::Path,
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};
use t3code_server::{
    event_bus::EventBus, migrations, provider::session_registry::SessionRegistry, scheduled_tasks,
    webhook_worker,
};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn webhook_worker_accepts_before_worktree_checkout_finishes() {
    use std::os::unix::fs::PermissionsExt;
    let temp = std::env::temp_dir().join(format!("webhook-worktree-{}", uuid::Uuid::new_v4()));
    let repo = temp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("tracked"), "content").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    let started = temp.join("started");
    let release = temp.join("release");
    let hook = repo.join(".git/hooks/post-checkout");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ntouch '{}'\nwhile [ ! -e '{}' ]; do sleep 0.02; done\n",
            started.display(),
            release.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut db = Connection::open_in_memory().unwrap();
    migrations::run_ported_migrations(&mut db).unwrap();
    db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P',?1,'[]','now','now')", [repo.to_str().unwrap()]).unwrap();
    let input = json!({"commandId":"hook","title":"t","prompt":"hello","enabled":false,"schedule":{"type":"webhook"},"projectId":"p","threadMode":"continue","workspaceStrategy":{"type":"worktree","baseRef":"main"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
    let task = scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
    db.execute("UPDATE scheduled_tasks SET enabled=1", [])
        .unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')", []).unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('d','scheduled-task:hook','d',0,?1,?2,'[\"d\"]')", params![task.to_string(),json!({"method":"POST","path":"/","query":"","headers":{},"bodyText":""}).to_string()]).unwrap();
    let bus = EventBus::new(db, 16);
    bus.set_worktrees_dir(temp.join("trees"));
    bus.with_autocommit(|db| db.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON scheduled_task_webhook_pending BEGIN SELECT RAISE(FAIL,'injected failure'); END;").unwrap()).unwrap();
    assert!(
        webhook_worker::run_one_background(&bus, Arc::new(SessionRegistry::default())).is_err()
    );
    assert!(
        !started.exists(),
        "checkout must not start before acceptance commits"
    );
    bus.with_autocommit(|db| db.execute_batch("DROP TRIGGER fail_delete").unwrap())
        .unwrap();
    assert!(
        webhook_worker::run_one_background(&bus, Arc::new(SessionRegistry::default())).unwrap()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !started.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(started.exists(), "checkout hook did not start");
    bus.with_autocommit(|db| {
        let (status, thread): (String, Option<String>) = db.query_row("SELECT last_run_status,thread_id FROM scheduled_tasks WHERE task_id='scheduled-task:hook'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(status, "succeeded");
        assert!(thread.is_some(), "continuing task should bind the preparing thread");
        let run: String = db.query_row("SELECT status FROM orchestration_v2_projection_runs", [], |r| r.get(0)).unwrap();
        assert_eq!(run, "preparing");
    }).unwrap();
    assert!(
        !webhook_worker::run_one_background(&bus, Arc::new(SessionRegistry::default())).unwrap()
    );
    // A delivery queued before the first one bound its thread must use the
    // current task rather than launch a second worktree from the stale snapshot.
    bus.with_autocommit(|db| {
        db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('d2','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')", []).unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('d2','scheduled-task:hook','d2',0,?1,?2,'[\"d2\"]')", params![task.to_string(),json!({"method":"POST","path":"/","query":"","headers":{},"bodyText":""}).to_string()]).unwrap();
    }).unwrap();
    assert!(
        webhook_worker::run_one_background(&bus, Arc::new(SessionRegistry::default())).unwrap()
    );
    bus.with_autocommit(|db| {
        let threads: i64 = db
            .query_row(
                "SELECT count(*) FROM orchestration_v2_projection_threads",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let messages: i64 = db
            .query_row(
                "SELECT count(*) FROM orchestration_v2_projection_messages",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(threads, 1);
        assert_eq!(messages, 2);
    })
    .unwrap();
    std::fs::write(&release, "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let ready: bool = bus.with_autocommit(|db| db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start')", [], |r| r.get(0)).unwrap()).unwrap();
        if ready {
            break;
        }
        assert!(Instant::now() < deadline, "provider start was not released");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(bus);
    std::fs::remove_dir_all(temp).unwrap();
}
