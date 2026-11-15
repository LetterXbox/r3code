//! Run a process-bound session outside the async runtime without leaking it when
//! its owning effect is cancelled. Each task owns its own app-server process.
use super::{CodexClient, CodexLaunch, CodexShutdown};

struct ShutdownOnDrop(Option<CodexShutdown>);
impl Drop for ShutdownOnDrop {
    fn drop(&mut self) {
        if let Some(shutdown) = self.0.take() {
            // Shutdown may wait for a stubborn process. Never block the runtime's
            // executor during future cancellation.
            std::thread::spawn(move || {
                let _ = shutdown.shutdown();
            });
        }
    }
}

/// Own a Codex process for the duration of a blocking operation. Dropping this
/// future terminates its process group even while the operation waits for I/O.
/// The operation must not share the process with unrelated sessions.
pub async fn run<T, F>(options: CodexLaunch, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(CodexClient) -> Result<T, String> + Send + 'static,
{
    let client = CodexClient::spawn(options).map_err(|e| e.to_string())?;
    let mut guard = ShutdownOnDrop(Some(client.shutdown_handle()));
    let result = tokio::task::spawn_blocking(move || operation(client))
        .await
        .map_err(|e| format!("Codex session task failed: {e}"))?;
    guard.0 = None;
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::provider::ProviderClient;
    use std::{os::unix::fs::PermissionsExt, time::Duration};

    #[tokio::test]
    async fn cancellation_terminates_a_blocked_session() {
        let path = std::env::temp_dir().join(format!("codex-session-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/usr/bin/env python3\nimport sys,json\nfor line in sys.stdin:\n print(json.dumps({'method':'ready'}),flush=True)\n while True: pass\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(
            CodexLaunch {
                binary: Some(path.clone()),
                ..Default::default()
            },
            move |mut client| {
                let pid = client.shutdown.state.lock().unwrap().child.id();
                let _ = tx.send(pid);
                client
                    .request("blocked", None, Duration::from_secs(30))
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            },
        ));
        let pid = rx.await.unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if unsafe { libc::kill(pid as libc::pid_t, 0) } == -1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("session process was not reaped");
        std::fs::remove_file(path).unwrap();
    }
}
