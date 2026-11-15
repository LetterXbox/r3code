//! Local NDJSON spans, compatible with the trace diagnostics reader.
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const QUEUE_CAPACITY: usize = 1024;

enum Message {
    Span(Vec<u8>),
    Barrier(tokio::sync::oneshot::Sender<Option<String>>),
}

pub struct TraceWriter {
    sender: tokio::sync::mpsc::Sender<Message>,
    backups: usize,
    max_bytes: u64,
}
impl TraceWriter {
    pub fn new(path: PathBuf) -> io::Result<Self> {
        let max_bytes = std::env::var("T3CODE_TRACE_MAX_BYTES")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(10 * 1024 * 1024);
        let backups = std::env::var("T3CODE_TRACE_MAX_FILES")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0 && *v <= 1000)
            .unwrap_or(10);
        Self::with_limits(path, max_bytes, backups)
    }
    fn with_limits(path: PathBuf, max_bytes: u64, backups: usize) -> io::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        OpenOptions::new().create(true).append(true).open(&path)?;
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Message>(QUEUE_CAPACITY);
        std::thread::Builder::new()
            .name("t3-trace-writer".into())
            .spawn(move || {
                let mut failure = None;
                while let Some(message) = receiver.blocking_recv() {
                    match message {
                        Message::Span(bytes) => {
                            if let Err(error) = append(&path, max_bytes, backups, &bytes) {
                                eprintln!("Warning: could not write local trace: {error}");
                                failure = Some(error.to_string());
                            }
                        }
                        Message::Barrier(reply) => {
                            let _ = reply.send(failure.take());
                        }
                    }
                }
            })?;
        Ok(Self { sender, backups, max_bytes })
    }
    /// Wait for earlier queued records to be written, bounded by `timeout`.
    pub async fn flush(&self, timeout: std::time::Duration) -> io::Result<()> {
        let (reply, received) = tokio::sync::oneshot::channel();
        tokio::time::timeout(timeout, async {
            self.sender
                .send(Message::Barrier(reply))
                .await
                .map_err(|_| io::Error::other("trace worker stopped"))?;
            match received
                .await
                .map_err(|_| io::Error::other("trace worker stopped"))?
            {
                Some(error) => Err(io::Error::other(error)),
                None => Ok(()),
            }
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "trace flush timed out"))?
    }
    pub fn backups(&self) -> usize {
        self.backups
    }
    pub fn start(&self) -> SpanStart {
        SpanStart {
            instant: Instant::now(),
            unix_nanos: nanos(),
        }
    }
    pub fn finish(&self, tag: &str, start: SpanStart, success: bool) -> io::Result<()> {
        let name = safe_rpc_name(tag);
        self.write_span(name, start, success)
    }
    pub fn startup(&self) -> io::Result<()> {
        self.write_span("server.startup", self.start(), true)
    }
    pub(crate) fn browser_record(&self, record: &serde_json::Value) -> io::Result<()> {
        let text = serde_json::to_string(record)?;
        static REDACT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let regex = REDACT.get_or_init(|| regex::Regex::new(r#"(^|[?&"\s])(wsTicket|dpop)=[^&#"\\\s]*"#).expect("constant regex"));
        let mut bytes = regex.replace_all(&text, "$1$2=<redacted>").into_owned().into_bytes();
        bytes.push(b'\n');
        if bytes.len() as u64 > self.max_bytes { return Ok(()); }
        self.sender.try_send(Message::Span(bytes)).map_err(|e| io::Error::other(e.to_string()))
    }
    fn write_span(&self, name: &str, start: SpanStart, success: bool) -> io::Result<()> {
        let record = json!({"name":name, "traceId":uuid::Uuid::new_v4().simple().to_string(), "spanId": &uuid::Uuid::new_v4().simple().to_string()[..16], "startTimeUnixNano":start.unix_nanos.to_string(), "endTimeUnixNano":nanos().to_string(), "durationMs":start.instant.elapsed().as_secs_f64()*1000.0, "exit": if success { json!({"_tag":"Success"}) } else { json!({"_tag":"Failure","cause":"RPC request failed"}) }});
        let mut bytes = serde_json::to_vec(&record)?;
        bytes.push(b'\n');
        self.sender
            .try_send(Message::Span(bytes))
            .map_err(|error| match error {
                tokio::sync::mpsc::error::TrySendError::Full(_) => {
                    io::Error::other("trace queue full")
                }
                tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                    io::Error::other("trace worker stopped")
                }
            })
    }
}
// Only recognized method names are recorded; arbitrary caller-controlled tags never enter traces.
fn safe_rpc_name(tag: &str) -> &str {
    if crate::authorization::RPC_REQUIRED_SCOPES
        .iter()
        .any(|(name, _)| *name == tag)
        || crate::terminal::TerminalManager::handles(tag)
        || crate::workspace_rpc::handles(tag)
        || crate::vcs_status::handles(tag)
        || matches!(
            tag,
            "server.probe"
                | "server.getHostResources"
                | "scheduledTasks.subscribe"
                | "server.checkOtlpEndpoint"
                | "shell.openInEditor"
                | "server.getConfig"
                | "server.updateSettings"
                | "server.checkSecretSource"
                | "server.upsertKeybinding"
                | "server.removeKeybinding"
                | "server.refreshProviders"
                | "subscribeServerConfig"
                | "subscribeServerLifecycle"
                | "orchestration.searchThreads"
                | "orchestration.getThreadTitles"
                | "orchestration.getThreadLinkMetadata"
                | "orchestration.subscribeShell"
                | "orchestration.subscribeThread"
        )
    {
        tag
    } else {
        "rpc.request"
    }
}
fn append(path: &Path, max_bytes: u64, backups: usize, bytes: &[u8]) -> io::Result<()> {
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size.saturating_add(bytes.len() as u64) > max_bytes {
        rotate(path, backups)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(bytes)
}
fn rotate(path: &Path, backups: usize) -> io::Result<()> {
    if backups == 0 {
        return fs::remove_file(path);
    }
    // Delete the oldest first: rename cannot replace an existing destination on Windows.
    match fs::remove_file(backup(path, backups)) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    for n in (1..=backups).rev() {
        let source = if n == 1 {
            path.to_owned()
        } else {
            backup(path, n - 1)
        };
        match fs::rename(source, backup(path, n)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn backup(path: &Path, n: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{n}"));
    name.into()
}
fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
pub struct SpanStart {
    instant: Instant,
    unix_nanos: u128,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn writes_valid_diagnostics_and_rotates_existing_backups() {
        let dir = std::env::temp_dir().join(format!("t3-trace-{}", uuid::Uuid::new_v4()));
        let path = dir.join("trace.ndjson");
        let writer = TraceWriter::with_limits(path.clone(), 1, 2).unwrap();
        for success in [true, false, true, false] {
            let start = writer.start();
            writer.finish("server.getConfig", start, success).unwrap();
        }
        writer
            .flush(std::time::Duration::from_secs(2))
            .await
            .unwrap();
        let summary = crate::trace_diagnostics::read(&path, 2);
        assert_eq!(summary["recordCount"], 3);
        assert_eq!(summary["failureCount"], 2);
        assert_eq!(summary["parseErrorCount"], 0);
        assert_eq!(summary["topSpansByCount"][0]["name"], "server.getConfig");
        assert!(!backup(&path, 3).exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn flush_is_bounded_when_worker_is_stalled() {
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        let writer = TraceWriter { sender, backups: 1, max_bytes: u64::MAX };
        writer
            .finish("server.getConfig", writer.start(), true)
            .unwrap();
        let error = writer
            .flush(std::time::Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
    #[tokio::test]
    async fn flush_reports_worker_write_failure() {
        let dir = std::env::temp_dir().join(format!("t3-trace-fail-{}", uuid::Uuid::new_v4()));
        let path = dir.join("trace.ndjson");
        let writer = TraceWriter::with_limits(path.clone(), u64::MAX, 2).unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        writer
            .finish("server.getConfig", writer.start(), true)
            .unwrap();
        assert!(writer
            .flush(std::time::Duration::from_secs(2))
            .await
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_unrecognized_names_and_sensitive_input() {
        assert_eq!(
            safe_rpc_name("server.getTraceDiagnostics"),
            "server.getTraceDiagnostics"
        );
        assert_eq!(safe_rpc_name("secret-token"), "rpc.request");
    }
    #[test]
    fn queue_is_bounded_and_nonblocking() {
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        let writer = TraceWriter { sender, backups: 1, max_bytes: u64::MAX };
        writer
            .finish("server.getConfig", writer.start(), true)
            .unwrap();
        assert_eq!(
            writer
                .finish("server.getConfig", writer.start(), true)
                .unwrap_err()
                .to_string(),
            "trace queue full"
        );
    }
}
