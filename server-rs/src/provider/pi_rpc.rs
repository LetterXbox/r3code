//! Bounded Pi RPC JSONL transport. A connection owns one Pi process.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
};

const MAX_FRAME: usize = 2 * 8 * ((10_usize * 1024 * 1024).div_ceil(3) * 4) + 8 * 1024 * 1024;
const EVENT_CAPACITY: usize = 32;
type Reply = oneshot::Sender<Result<Value, String>>;
type QueuedEvent = (Value, OwnedSemaphorePermit);
fn enqueue(
    sender: &mpsc::Sender<QueuedEvent>,
    budget: &Arc<Semaphore>,
    value: Value,
    bytes: usize,
) -> Result<(), ()> {
    let units = bytes.saturating_add(1023) / 1024;
    let permit = budget
        .clone()
        .try_acquire_many_owned(u32::try_from(units.max(1)).map_err(|_| ())?)
        .map_err(|_| ())?;
    sender.try_send((value, permit)).map_err(|_| ())
}
struct PendingGuard {
    pending: Arc<Mutex<HashMap<String, Reply>>>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.id);
        }
    }
}
pub(crate) fn signal_group(child: &mut Child) {
    #[cfg(unix)]
    if matches!(child.try_wait(), Ok(None)) {
        if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}
#[cfg(target_os = "linux")]
pub(crate) fn group_quiescent(pgid: Option<i32>) -> bool {
    let Some(pgid) = pgid.filter(|value| *value > 1) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else { return false };
        if !entry
            .file_name()
            .to_string_lossy()
            .bytes()
            .all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        };
        let Some((_, rest)) = stat.rsplit_once(") ") else {
            return false;
        };
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        let Some(group) = fields.get(2).and_then(|value| value.parse::<i32>().ok()) else {
            return false;
        };
        if group == pgid
            && fields
                .first()
                .is_none_or(|state| *state != "Z" && *state != "X")
        {
            return false;
        }
    }
    true
}
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn group_quiescent(pgid: Option<i32>) -> bool {
    let Some(pgid) = pgid.filter(|value| *value > 1) else {
        return false;
    };
    unsafe {
        libc::kill(-pgid, 0) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}
#[cfg(not(unix))]
pub(crate) fn group_quiescent(_pgid: Option<i32>) -> bool {
    false
}
pub(crate) async fn stop_child(child: &Arc<AsyncMutex<Child>>, pgid: Option<i32>) -> bool {
    let mut child = child.lock().await;
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            signal_group(&mut child);
            if child.kill().await.is_err() {
                return false;
            }
        }
        Err(_) => return false,
    }
    #[cfg(unix)]
    for _ in 0..25 {
        if group_quiescent(pgid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    #[cfg(not(unix))]
    let _ = pgid;
    false
}

struct WriteGuard {
    closed: Arc<AtomicBool>,
    child: Arc<AsyncMutex<Child>>,
    pgid: Option<i32>,
    armed: bool,
}
impl Drop for WriteGuard {
    fn drop(&mut self) {
        if self.armed {
            self.closed.store(true, Ordering::Release);
            let child = self.child.clone();
            let pgid = self.pgid;
            tokio::spawn(async move {
                let _ = stop_child(&child, pgid).await;
            });
        }
    }
}

pub(crate) struct PiRpc {
    input: Arc<AsyncMutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, Reply>>>,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    events: AsyncMutex<mpsc::Receiver<QueuedEvent>>,
    child: Arc<AsyncMutex<Child>>,
    pgid: Option<i32>,
}

impl Drop for PiRpc {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.try_lock() {
            signal_group(&mut child);
            let _ = child.start_kill();
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let child = self.child.clone();
            let pgid = self.pgid;
            handle.spawn(async move {
                let _ = stop_child(&child, pgid).await;
            });
        }
    }
}

impl PiRpc {
    pub(crate) async fn spawn(
        command: &str,
        args: &[String],
        cwd: Option<&Path>,
        env: &[(String, String)],
    ) -> Result<Self, String> {
        let mut process = Command::new(command);
        process
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.as_std_mut().process_group(0);
        }
        #[cfg(target_os = "linux")]
        unsafe {
            let parent = libc::getpid();
            process.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("Pi parent exited during launch"));
                }
                Ok(())
            });
        }
        if let Some(cwd) = cwd {
            process.current_dir(cwd);
        }
        for key in [
            "T3_MCP_URL",
            "T3_MCP_BEARER_TOKEN",
            "T3_PI_MCP_EXTENSION_PATH",
            "T3_PI_RUNTIME_MODE",
        ] {
            process.env_remove(key);
        }
        for (name, value) in env {
            process.env(name, value);
        }
        let mut child = process
            .spawn()
            .map_err(|e| format!("Pi process could not start: {e}"))?;
        let pgid = child.id().and_then(|pid| i32::try_from(pid).ok());
        let input = child.stdin.take().ok_or("Pi stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                while matches!(stderr.read(&mut buf).await,Ok(n) if n>0) {}
            });
        }
        let child = Arc::new(AsyncMutex::new(child));
        let reader_child = child.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = closed.clone();
        let (sender, events) = mpsc::channel(EVENT_CAPACITY);
        let event_budget = Arc::new(Semaphore::new(MAX_FRAME.div_ceil(1024)));
        let pending: Arc<Mutex<HashMap<String, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let requests = pending.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut frame = Vec::new();
            let error = loop {
                let available = match reader.fill_buf().await {
                    Ok(value) => value,
                    Err(_) => break "Pi stdout read failed",
                };
                if available.is_empty() {
                    break "Pi stdout closed";
                }
                let n = available
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(available.len(), |index| index + 1);
                if frame.len().saturating_add(n) > MAX_FRAME {
                    break "Pi stdout frame too large";
                }
                frame.extend_from_slice(&available[..n]);
                let done = frame.last() == Some(&b'\n');
                reader.consume(n);
                if !done {
                    continue;
                }
                frame.pop();
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                let frame_bytes = frame.len();
                let parsed = serde_json::from_slice::<Value>(&frame);
                frame.clear();
                let Ok(value) = parsed else { continue };
                if !value.is_object() {
                    continue;
                }
                if value["type"] == "response" {
                    if let Some(id) = value["id"].as_str() {
                        let request = requests.lock().ok().and_then(|mut map| map.remove(id));
                        if let Some(request) = request {
                            let result = if value["success"] == true {
                                Ok(value["data"].clone())
                            } else {
                                Err(value["error"]
                                    .as_str()
                                    .unwrap_or("Pi request failed")
                                    .chars()
                                    .take(200)
                                    .collect())
                            };
                            let _ = request.send(result);
                        }
                    } else if enqueue(&sender, &event_budget, value, frame_bytes).is_err() {
                        break "Pi event queue overflow";
                    }
                } else if enqueue(&sender, &event_budget, value, frame_bytes).is_err() {
                    break "Pi event queue overflow";
                }
            };
            reader_closed.store(true, Ordering::Release);
            if let Ok(mut pending) = requests.lock() {
                for (_, request) in pending.drain() {
                    let _ = request.send(Err(error.into()));
                }
            }
            let _ = stop_child(&reader_child, pgid).await;
        });
        Ok(Self {
            input: Arc::new(AsyncMutex::new(input)),
            pending,
            next: AtomicU64::new(0),
            closed,
            events: AsyncMutex::new(events),
            child,
            pgid,
        })
    }
    pub(crate) async fn send(&self, value: &Value) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Pi connection closed".into());
        }
        let mut bytes = serde_json::to_vec(value).map_err(|_| "Invalid Pi request")?;
        if bytes.len() > MAX_FRAME {
            return Err("Pi request too large".into());
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut input = self.input.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err("Pi connection closed".to_owned());
            }
            let mut guard = WriteGuard {
                closed: self.closed.clone(),
                child: self.child.clone(),
                pgid: self.pgid,
                armed: true,
            };
            input
                .write_all(&bytes)
                .await
                .map_err(|_| "Pi stdin closed".to_owned())?;
            guard.armed = false;
            Ok(())
        })
        .await
        .map_err(|_| "Pi write timed out".to_owned())?
    }
    pub(crate) async fn request(
        &self,
        mut value: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !value.is_object() {
            return Err("Invalid Pi request".into());
        }
        let id = format!("t3-{}", self.next.fetch_add(1, Ordering::Relaxed));
        value["id"] = json!(id);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Pi request lock failed")?;
            if self.closed.load(Ordering::Acquire) {
                return Err("Pi connection closed".into());
            }
            pending.insert(id.clone(), sender);
        }
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id,
        };
        match tokio::time::timeout(timeout, async {
            self.send(&value).await?;
            receiver
                .await
                .map_err(|_| "Pi connection closed".to_owned())?
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err("Pi request timed out".into()),
        }
    }
    pub(crate) async fn next_event(&self) -> Option<Value> {
        self.events
            .lock()
            .await
            .recv()
            .await
            .map(|(value, _permit)| value)
    }
    pub(crate) fn process_group(&self) -> Option<i32> {
        self.pgid
    }
    pub(crate) async fn terminate(&self) -> bool {
        stop_child(&self.child, self.pgid).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    async fn group_stops(drop_only: bool) {
        let path = std::env::temp_dir().join(format!("pi-child-{}", uuid::Uuid::new_v4()));
        let script = r#"import subprocess,sys,time
p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
open(sys.argv[1],'w').write(str(p.pid))
time.sleep(60)
"#;
        let rpc = PiRpc::spawn(
            "python3",
            &[
                "-u".into(),
                "-c".into(),
                script.into(),
                path.to_string_lossy().into_owned(),
            ],
            None,
            &[],
        )
        .await
        .unwrap();
        let mut pid = None;
        for _ in 0..100 {
            if let Ok(value) = std::fs::read_to_string(&path) {
                pid = value.trim().parse::<u32>().ok();
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = pid.expect("child pid");
        let _ = std::fs::remove_file(path);
        if drop_only {
            drop(rpc);
        } else {
            assert!(rpc.terminate().await);
        }
        let mut stopped = false;
        for _ in 0..100 {
            let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
            if state.as_deref().is_none_or(|value| {
                value
                    .rsplit_once(") ")
                    .is_some_and(|(_, rest)| rest.starts_with('Z'))
            }) {
                stopped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(stopped, "Pi subprocess survived group termination");
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn terminate_stops_spawned_process_group() {
        group_stops(false).await;
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn drop_stops_spawned_process_group() {
        group_stops(true).await;
    }
    #[tokio::test]
    async fn routes_responses_and_events_across_crlf_and_late_replies() {
        let script = r#"import sys,json,time
for line in sys.stdin:
 r=json.loads(line)
 if r['type']=='prompt':
  sys.stdout.write(json.dumps({'type':'response','command':'prompt','success':True})+'\n');sys.stdout.flush();continue
 if r['type']=='slow': time.sleep(.12)
 if r['type']=='get_state':
  sys.stdout.write(json.dumps({'type':'message_update','text':'one\u2028two'},ensure_ascii=False)+'\r\n');sys.stdout.flush()
 sys.stdout.write(json.dumps({'type':'response','id':r['id'],'command':r['type'],'success':True,'data':{'type':r['type']}})+'\r\n');sys.stdout.flush()
"#;
        let rpc = PiRpc::spawn(
            "python3",
            &["-u".into(), "-c".into(), script.into()],
            None,
            &[],
        )
        .await
        .unwrap();
        let state = rpc
            .request(json!({"type":"get_state"}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(state["type"], "get_state");
        assert_eq!(rpc.next_event().await.unwrap()["text"], "one\u{2028}two");
        rpc.send(&json!({"type":"prompt","message":"hello"}))
            .await
            .unwrap();
        assert_eq!(rpc.next_event().await.unwrap()["command"], "prompt");
        assert!(rpc
            .request(json!({"type":"slow"}), Duration::from_millis(10))
            .await
            .is_err());
        let next = rpc
            .request(json!({"type":"get_entries"}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(next["type"], "get_entries");
        rpc.terminate().await;
    }
}
