//! Supervised browser worker transport. RPC and media routing must authorize
//! requests before using this private interface.
use serde_json::{json, Value};
use std::{
    io,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex,
};

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
pub struct BrowserWorker {
    process: Mutex<Process>,
    next_id: AtomicU64,
    #[cfg(unix)]
    process_group: u32,
}
impl BrowserWorker {
    pub async fn start() -> io::Result<Self> {
        let mut command = tokio::process::Command::new("node");
        command
            .args([
                "--input-type=module",
                "-e",
                include_str!("preview_browser_worker.mjs"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn()?;
        #[cfg(unix)]
        let process_group = child
            .id()
            .ok_or_else(|| io::Error::other("Browser worker process unavailable"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Browser worker input unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Browser worker output unavailable"))?;
        let worker = Self {
            process: Mutex::new(Process {
                child,
                input,
                output: BufReader::new(output),
            }),
            next_id: AtomicU64::new(1),
            #[cfg(unix)]
            process_group,
        };
        worker.request(json!({"op":"start"})).await?;
        Ok(worker)
    }
    pub async fn request(&self, mut input: Value) -> io::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        input["id"] = json!(id);
        let mut bytes = serde_json::to_vec(&input).map_err(io::Error::other)?;
        if bytes.len() > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Browser request too large",
            ));
        }
        bytes.push(b'\n');
        let mut process = self.process.lock().await;
        let result = tokio::time::timeout(Duration::from_secs(45), async {
            process.input.write_all(&bytes).await?;
            process.input.flush().await?;
            let mut response = Vec::new();
            // Read incrementally with a cap; a broken worker cannot exhaust memory.
            loop {
                let available = process.output.fill_buf().await?;
                if available.is_empty() {
                    return Err(io::Error::other("Browser worker stopped"));
                }
                let end = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(available.len());
                if response.len() + end > 12 * 1024 * 1024 {
                    return Err(io::Error::other("Browser response too large"));
                }
                response.extend_from_slice(&available[..end]);
                let complete = available[end - 1] == b'\n';
                process.output.consume(end);
                if complete {
                    break;
                }
            }
            let response: Value = serde_json::from_slice(&response).map_err(io::Error::other)?;
            if response["id"].as_u64() != Some(id) {
                return Err(io::Error::other("Browser worker response mismatch"));
            }
            if let Some(error) = response["error"].as_str() {
                return Err(io::Error::other(error.to_owned()));
            }
            Ok(response["result"].clone())
        })
        .await;
        match result {
            Ok(value) => value,
            Err(_) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(self.process_group as i32), libc::SIGKILL);
                }
                let _ = process.child.kill().await;
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Browser worker timed out",
                ))
            }
        }
    }
}

impl Drop for BrowserWorker {
    fn drop(&mut self) {
        // Chromium may have descendants; the worker owns its process group.
        #[cfg(unix)]
        if let Ok(mut process) = self.process.try_lock() {
            if matches!(process.child.try_wait(), Ok(None)) {
                unsafe {
                    libc::kill(-(self.process_group as i32), libc::SIGKILL);
                }
            }
        }
    }
}

pub struct BrowserSession {
    pub worker: BrowserWorker,
    pub controller: Mutex<Option<String>>,
    pub control_changes: tokio::sync::watch::Sender<Option<String>>,
    pub generation: AtomicU64,
}
#[derive(Default)]
pub struct BrowserPool {
    sessions: Mutex<std::collections::HashMap<(String, String), std::sync::Arc<BrowserSession>>>,
}
impl BrowserPool {
    pub async fn get_or_start(
        &self,
        thread: &str,
        tab: &str,
    ) -> io::Result<std::sync::Arc<BrowserSession>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&(thread.to_owned(), tab.to_owned())) {
            return Ok(session.clone());
        }
        let session = std::sync::Arc::new(BrowserSession {
            worker: BrowserWorker::start().await?,
            controller: Mutex::new(None),
            control_changes: tokio::sync::watch::channel(None).0,
            generation: AtomicU64::new(0),
        });
        sessions.insert((thread.to_owned(), tab.to_owned()), session.clone());
        Ok(session)
    }
    pub async fn close(&self, thread: &str, tab: Option<&str>) {
        let removed = {
            let mut sessions = self.sessions.lock().await;
            let keys: Vec<_> = sessions
                .keys()
                .filter(|(t, b)| t == thread && tab.is_none_or(|id| id == b))
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| sessions.remove(&key))
                .collect::<Vec<_>>()
        };
        for session in removed {
            let _ = session.worker.request(json!({"op":"close"})).await;
        }
    }
}
