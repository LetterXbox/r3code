use chrono::Utc;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Arc};
use t3code_server::{
    event_bus::EventBus, migrations, scheduled_tasks, settings::Settings, terminal::TerminalManager,
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

fn run_setup(command: &str, cancel: bool) -> (Value, Option<Value>, bool, bool, bool) {
    let temp = std::env::temp_dir().join(format!("scheduled-setup-e2e-{}", uuid::Uuid::new_v4()));
    let repo = temp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("tracked"), "content").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    let mut db = Connection::open_in_memory().unwrap();
    migrations::run_ported_migrations(&mut db).unwrap();
    let setup_started = temp.join("setup-started");
    let setup_command = if cancel {
        let marker = shlex::try_quote(setup_started.to_str().unwrap()).unwrap();
        format!("printf started > {marker}; {command}")
    } else {
        command.to_owned()
    };
    let scripts = json!([{"id":"setup", "name":"Setup", "command":setup_command, "runOnWorktreeCreate":true, "async":false}]);
    db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P',?1,?2,'now','now')", rusqlite::params![repo.to_str().unwrap(), scripts.to_string()]).unwrap();
    let task = json!({"commandId":"abc","title":"Title","prompt":"Prompt","enabled":true,"schedule":{"type":"interval","everyMs":60000},"projectId":"p","workspaceStrategy":{"type":"worktree","baseRef":"main"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
    scheduled_tasks::upsert(&db, &task, Utc::now()).unwrap();
    let bus = EventBus::new(db, 16);
    bus.set_worktrees_dir(temp.join("trees"));
    bus.set_setup_context(
        Arc::new(TerminalManager::default()),
        Arc::new(Settings::new(temp.join("settings.json"))),
    );
    let canceller = if cancel {
        let flag = bus.shutdown_flag();
        Some(std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !setup_started.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            flag.store(true, std::sync::atomic::Ordering::Release);
            assert!(setup_started.exists(), "setup did not start before shutdown");
        }))
    } else {
        None
    };
    let result = scheduled_tasks::run_task(&bus, "scheduled-task:abc", false, None)
        .unwrap()
        .unwrap();
    if let Some(canceller) = canceller {
        canceller.join().unwrap();
    }
    let (thread, has_message, has_result, has_start) = bus
        .with_autocommit(|db| {
            let payload: Option<String> = db
                .query_row(
                    "SELECT payload_json FROM orchestration_v2_projection_threads LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            let thread: Option<Value> = payload.map(|p| serde_json::from_str(&p).unwrap());
            let messages: i64 = db
                .query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_messages",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let has_result = thread
                .as_ref()
                .and_then(|t| t["worktreePath"].as_str())
                .is_some_and(|p| Path::new(p).join("setup-result").exists());
            let starts: i64 = db.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start'", [], |r| r.get(0)).unwrap();
            (thread, messages > 0, has_result, starts > 0)
        })
        .unwrap();
    drop(bus);
    std::fs::remove_dir_all(temp).unwrap();
    (result, thread, has_message, has_result, has_start)
}

#[test]
fn scheduled_worktree_waits_for_successful_setup_before_dispatch() {
    let (result, thread, message, result_file, started) =
        run_setup("printf ready > setup-result", false);
    assert_eq!(result["lastRunStatus"], "succeeded");
    assert!(thread.is_some());
    assert!(message);
    assert!(result_file);
    assert!(started);
}

#[test]
fn scheduled_worktree_failure_does_not_start_provider() {
    let (result, thread, message, _, started) = run_setup("exit 7", false);
    assert_eq!(result["lastRunStatus"], "failed");
    assert!(result["lastRunError"]
        .as_str()
        .unwrap()
        .contains("exit code 7"));
    assert!(thread.is_some());
    assert!(message);
    assert!(!started);
}

#[test]
fn shutdown_during_setup_prevents_scheduled_dispatch() {
    let (result, thread, message, _, started) = run_setup("sleep 30", true);
    assert_eq!(result["lastRunStatus"], "failed");
    assert!(result["lastRunError"]
        .as_str()
        .unwrap()
        .contains("shutdown"));
    assert!(thread.is_some());
    assert!(message);
    assert!(!started);
}

#[cfg(unix)]
#[test]
fn checkout_does_not_hold_writer_while_git_hook_runs() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};
    let temp = std::env::temp_dir().join(format!("scheduled-lock-{}", uuid::Uuid::new_v4()));
    let repo = temp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("tracked"), "content").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    let hook = repo.join(".git/hooks/post-checkout");
    let started = temp.join("started");
    let release = temp.join("release");
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
    let task = json!({"commandId":"lock","title":"Title","prompt":"Prompt","enabled":true,"schedule":{"type":"interval","everyMs":60000},"projectId":"p","workspaceStrategy":{"type":"worktree","baseRef":"main"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
    scheduled_tasks::upsert(&db, &task, Utc::now()).unwrap();
    let bus = EventBus::new(db, 16);
    bus.set_worktrees_dir(temp.join("trees"));
    let worker_bus = bus.clone();
    let worker = std::thread::spawn(move || {
        scheduled_tasks::run_task(&worker_bus, "scheduled-task:lock", false, None)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !started.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(started.exists(), "Git hook did not start");
    let (tx, rx) = std::sync::mpsc::channel();
    let writer_bus = bus.clone();
    let writer = std::thread::spawn(move || {
        tx.send(writer_bus.commit(|_| Ok(((), vec![]))).is_ok())
            .unwrap();
    });
    let available = rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
    std::fs::write(&release, "").unwrap();
    writer.join().unwrap();
    worker.join().unwrap().unwrap();
    assert!(available, "writer was blocked by Git checkout");
    std::fs::remove_dir_all(temp).unwrap();
}
