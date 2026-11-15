use serde_json::json;
use std::{
    fs,
    sync::{Arc, Mutex},
};
use t3code_server::{
    attachment_paths, database,
    effect_worker::{EffectWorker, RuntimeExecutor, Signals},
    event_bus::EventBus,
    migrations,
    provider::{executor::CodexTurnExecutor, session_registry::SessionRegistry},
    terminal::TerminalManager,
    thread_deletion,
};

#[tokio::test]
async fn deletion_worker_processes_cleanup_effects_in_order() {
    let root = std::env::temp_dir().join(format!("t3-delete-worker-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let db_path = root.join("state.sqlite");
    let mut db = database::open_writer(&db_path).unwrap();
    migrations::run_ported_migrations(&mut db).unwrap();
    let thread = json!({"id":"t","title":"T","updatedAt":"2026","deletedAt":null});
    db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
    let asset = attachment_paths::attachment_id("t", Some("txt")).unwrap();
    let message = json!({"id":"m","attachments":[{"id":asset}]});
    db.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES('m','t','user',0,'2026','2026',?1)",[message.to_string()]).unwrap();
    db.execute("INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES ('task','t','p',1,'{}','p','t','{}','{}','full-access','default','user','web','x','x','never',0)",[]).unwrap();
    let attachments = root.join("attachments");
    let logs = root.join("logs");
    fs::create_dir_all(&attachments).unwrap();
    let asset_path = attachments.join(format!("{asset}.txt"));
    fs::write(&asset_path, "content").unwrap();
    let terminals = Arc::new(TerminalManager::with_logs_dir(logs.clone()).unwrap());
    fs::write(logs.join("terminal_dA.log"), "history").unwrap();
    let bus = EventBus::new(db, 16);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    thread_deletion::dispatch(&bus, "delete", "t", false, &now).unwrap();
    let sessions = Arc::new(SessionRegistry::default());
    let mut provider = CodexTurnExecutor::new(bus.clone(), sessions);
    provider.attachments_dir = attachments;
    let executor = RuntimeExecutor {
        bus: bus.clone(),
        provider,
        worktrees_dir: root.join("worktrees"),
        settings_path: root.join("settings.json"),
        terminals,
    };
    let worker = EffectWorker::new(
        Arc::new(Mutex::new(database::open_writer(&db_path).unwrap())),
        Arc::new(Signals::default()),
        Arc::new(executor),
        "test".into(),
        2,
    )
    .with_supported_types(&[
        "scheduled-tasks.cleanup",
        "terminal.cleanup",
        "preview.cleanup",
        "attachment.cleanup",
    ]);
    assert_eq!(worker.drain(8).await.unwrap(), 4);
    assert!(!asset_path.exists());
    assert!(!logs.join("terminal_dA.log").exists());
    bus.commit(|tx| {
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM scheduled_tasks WHERE thread_id='t'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(((), vec![]))
    })
    .unwrap();
    drop(worker);
    drop(bus);
    fs::remove_dir_all(root).unwrap();
}
