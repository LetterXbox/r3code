#![cfg(unix)]

use std::sync::Arc;
use t3code_server::codex_token_broker::{Broker, Resolver};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_helper_uses_private_broker_and_rejects_wrong_profile() {
    let profile = "a".repeat(64);
    let expected = profile.clone();
    let resolver: Resolver = Arc::new(move |request| {
        let expected = expected.clone();
        Box::pin(async move {
            (request.instance_id == "instance" && request.profile_key == expected)
                .then(|| "mock-token".to_owned())
        })
    });
    let broker = Broker::start("environment".into(), resolver).unwrap();
    let endpoint = broker.endpoint().to_owned();
    let run = |key: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_t3code"))
            .args([
                "__managed-chatgpt-token",
                endpoint.to_str().unwrap(),
                "instance",
                "environment",
                key,
            ])
            .output()
            .unwrap()
    };
    // Run the blocking child off the runtime thread so the broker can serve it.
    let (good, bad) = tokio::task::block_in_place(|| (run(&profile), run(&"b".repeat(64))));
    assert!(good.status.success());
    assert_eq!(good.stdout, b"mock-token");
    assert!(good.stderr.is_empty());
    assert!(!bad.status.success());
    assert!(bad.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&bad.stderr).contains("mock-token"));
    broker.shutdown().await;
    assert!(!endpoint.exists());
}
