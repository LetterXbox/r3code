#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    process::Command,
    sync::{Arc, Mutex},
};
use t3code_server::{
    application::Application,
    auth::Principal,
    auth_http::AuthHttpState,
    http_server::RpcApplication,
    provider::{session_registry::SessionRegistry, CodexLaunch},
    rpc::{Request, RequestId},
};

// Run the actual RPC in a child so HOME and PATH are isolated from parallel tests.
#[tokio::test]
async fn check_secret_source_refreshes_provider_and_redacts_private_value() {
    const CHILD: &str = "T3_CHECK_SECRET_SOURCE_CHILD";
    if std::env::var_os(CHILD).is_some() {
        exercise_rpc().await;
        return;
    }

    let root = std::env::temp_dir().join(format!("check-secret-source-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let bin = root.join("bin");
    std::fs::create_dir_all(home.join(".t3/userdata")).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let secret = "private-value-must-never-escape";
    let op = bin.join("op");
    std::fs::write(&op, format!("#!/bin/sh\nprintf '%s' '{secret}'\n")).unwrap();
    std::fs::set_permissions(&op, std::fs::Permissions::from_mode(0o700)).unwrap();
    let codex = bin.join("codex");
    std::fs::write(&codex, "#!/bin/sh\nwhile IFS= read -r line; do :; done\n").unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        home.join(".t3/userdata/settings.json"),
        json!({"secretProviders":{"vault":{"kind":"one_password","label":"Test Vault","config":{"account":"test"}}}}).to_string(),
    ).unwrap();

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "check_secret_source_refreshes_provider_and_redacts_private_value",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("HOME", &home)
        .env("PATH", &bin)
        .status()
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
    assert!(status.success(), "isolated RPC test child failed: {status}");
}

async fn exercise_rpc() {
    let secret = "private-value-must-never-escape";
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, method TEXT, expires_at TEXT, revoked_at TEXT); INSERT INTO auth_sessions VALUES ('s','user','[\"settings:write\"]','bearer-access-token','2999-01-01T00:00:00Z',NULL);").unwrap();
    let auth = Arc::new(AuthHttpState {
        replay_dir: std::env::temp_dir()
            .join(format!("check-secret-dpop-{}", uuid::Uuid::new_v4())),
        environment_descriptor: std::sync::OnceLock::new(),
        cloud_action_lock: tokio::sync::Mutex::new(()),
        cloud_generation: std::sync::atomic::AtomicU64::new(0),
        cloud_connector: t3code_server::cloud_connector::Connector::default(),
        listen_address: std::sync::OnceLock::new(),
        lifecycle: Default::default(),
        db: Mutex::new(db),
        signing_key: [7; 32],
        descriptor: json!({"sessionCookieName":"t3"}),
        trusted_origins: vec![],
        accept_legacy_cookie: false,
        desktop_bootstrap: None,
    });
    let sessions = Arc::new(SessionRegistry::default());
    let binary = std::env::var_os("PATH").unwrap();
    let session = sessions
        .open_with_references(
            "session",
            CodexLaunch {
                binary: Some(std::path::PathBuf::from(binary).join("codex")),
                ..Default::default()
            },
            vec![("vault".into(), "op://Personal/Item/password".into())],
        )
        .unwrap();
    let lease = sessions.claim_turn("session", &session).unwrap().unwrap();
    let app = Application::new(auth, "secret-test".into(), "test host".into())
        .with_session_registry(sessions.clone());
    let principal = Principal {
        session_id: "s".into(),
        subject: "user".into(),
        scopes: vec!["settings:write".into()],
        method: "bearer-access-token".into(),
        jkt: None,
        rtc: None,
        peer_link: false,
    };
    let request = Request {
        id: RequestId::String("1".into()),
        tag: "server.checkSecretSource".into(),
        payload: json!({"source":{"provider":"vault","reference":"op://Personal/Item/password"}}),
        headers: vec![],
        is_notification: false,
        discard: false,
        trace_id: None,
        span_id: None,
        sampled: None,
    };
    app.authorize(&principal, &request).unwrap();
    let result: Value = app.dispatch(principal, request).await.unwrap();
    assert_eq!(result, json!({"_tag":"Resolved"}));
    assert!(!result.to_string().contains(secret));
    assert!(sessions.claim_turn("session", &session).unwrap().is_none());
    assert!(sessions.get("session").unwrap().is_some());
    drop(lease);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while sessions.get("session").unwrap().is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
