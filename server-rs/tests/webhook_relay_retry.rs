use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::json;
use t3code_server::{event_bus::EventBus, migrations, scheduled_tasks, webhook_worker};

#[test]
fn failed_dispatch_releases_relay_and_replay_claims() {
    let mut db = Connection::open_in_memory().unwrap();
    migrations::run_ported_migrations(&mut db).unwrap();
    let input = json!({"commandId":"hook", "title":"t", "prompt":"hello", "enabled":false, "schedule":{"type":"webhook"}, "projectId":"missing", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
    let mut task = scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
    task["workspaceStrategy"] = json!({"type":"worktree"});
    db.execute(
        "UPDATE scheduled_tasks SET enabled=1,workspace_strategy_json='{\"type\":\"worktree\"}'",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES('delivery:relay:first','scheduled-task:hook','now','POST','','{}','',0,0,'accepted',0,'[]')", []).unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES('delivery:relay:first','scheduled-task:hook','key',0,?1,?2,?3)", params![task.to_string(), json!({"method":"POST","path":"/","query":"","headers":{},"bodyText":""}).to_string(), json!(["delivery:relay:first", "delivery:relay:second"]).to_string()]).unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_replay_keys(task_id,replay_key,delivery_id,expires_at) VALUES('scheduled-task:hook','key','delivery:relay:first',9999999999999)", []).unwrap();
    db.execute("INSERT INTO scheduled_task_webhook_relay_deliveries(relay_delivery_id,task_id,seen_at) VALUES('first','scheduled-task:hook','now'),('second','scheduled-task:hook','now')", []).unwrap();
    let bus = EventBus::new(db, 16);
    assert!(webhook_worker::run_one(&bus, None).unwrap());
    bus.commit(|tx| {
        let outcome: String = tx.query_row(
            "SELECT outcome FROM scheduled_task_webhook_deliveries",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(outcome, "dispatch_failed");
        for table in [
            "scheduled_task_webhook_replay_keys",
            "scheduled_task_webhook_relay_deliveries",
            "scheduled_task_webhook_pending",
        ] {
            let count: i64 =
                tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
            assert_eq!(count, 0, "{table}");
        }
        Ok(((), vec![]))
    })
    .unwrap();
}
