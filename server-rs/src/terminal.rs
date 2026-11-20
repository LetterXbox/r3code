//! Local PTY sessions and terminal RPC operations.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
    os::fd::{AsRawFd, FromRawFd},
    process::{Command, Stdio},
};
use tokio::sync::broadcast;
#[cfg(windows)]
struct WindowsPty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}
#[cfg(windows)]
impl Write for WindowsPty {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.writer.write(data)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
#[cfg(unix)]
type PtyMaster = std::fs::File;
#[cfg(windows)]
type PtyMaster = WindowsPty;

type Key = (String, String);
struct Session {
    cwd: String,
    worktree: Value,
    status: String,
    pid: Option<u32>,
    history: String,
    pending_control: String,
    sequence: u64,
    cols: u16,
    rows: u16,
    updated: String,
    master: Option<PtyMaster>,
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
    has_running_subprocess: bool,
    child_command: Option<String>,
    input_count: u64,
}
#[derive(Default)]
struct Viewer {
    streams: usize,
    grid: Option<(u16, u16)>,
}
#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<Key, Session>>,
    closed: Mutex<std::collections::HashSet<Key>>,
    events: Mutex<Option<broadcast::Sender<Value>>>,
    logs_dir: Option<PathBuf>,
    viewers: Mutex<HashMap<Key, HashMap<String, Viewer>>>,
    pending_history: Arc<Mutex<HashMap<Key, Option<String>>>>,
    poll_started: AtomicBool,
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn key(p: &Value) -> Result<Key, Value> {
    let get = |k| {
        p.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_owned()).ok_or_else(|| json!({"_tag":"TerminalSessionLookupError","message":"Invalid terminal identifier"}))
    };
    Ok((get("threadId")?, get("terminalId")?))
}
fn grid(p: &Value, field: &str, default: u16, max: u64) -> Result<u16, Value> {
    match p.get(field) {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0 && *n <= max)
            .map(|n| n as u16)
            .ok_or_else(|| json!({"_tag":"TerminalError","message":"Invalid terminal size"})),
    }
}
fn lookup(k: &Key) -> Value {
    json!({"_tag":"TerminalSessionLookupError","threadId":k.0,"terminalId":k.1,"message":format!("Unknown terminal thread: {}, terminal: {}",k.0,k.1)})
}
fn label(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let n = lower
        .strip_prefix("terminal-")
        .or_else(|| lower.strip_prefix("term-"));
    if let Some(n) = n {
        let digits: String = n.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty()
            && (digits.len() == n.len() || n.as_bytes().get(digits.len()) == Some(&b'-'))
        {
            return format!("Terminal {digits}");
        }
    }
    id.chars().take(128).collect()
}
// Keep query sequences out of replayed history while forwarding raw PTY output.
fn sanitize_history(pending: &mut String, data: &str) -> String {
    let input = format!("{}{}", std::mem::take(pending), data);
    let b = input.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != 0x1b {
            let end = input[i..].find('\x1b').map_or(b.len(), |n| i + n);
            out.push_str(&input[i..end]);
            i = end;
            continue;
        }
        let start = i;
        i += 1;
        if i == b.len() {
            *pending = input[start..].into();
            break;
        }
        let kind = b[i];
        i += 1;
        if kind == b'[' {
            while i < b.len() && !(0x40..=0x7e).contains(&b[i]) && b[i] != 0x18 && b[i] != 0x1a {
                i += 1;
            }
            if i == b.len() {
                *pending = input[start..].into();
                break;
            }
            let final_byte = b[i];
            let body = &input[start + 2..i];
            i += 1;
            let numeric = |s: &str| s.bytes().all(|c| c.is_ascii_digit() || b";?".contains(&c));
            let strip = final_byte == b'n'
                || (final_byte == b'R' && numeric(body))
                || (final_byte == b'c'
                    && body
                        .bytes()
                        .all(|c| c.is_ascii_digit() || b">=;?".contains(&c)))
                || (matches!(final_byte, b'p' | b'y')
                    && body.strip_suffix('$').is_some_and(numeric))
                || (final_byte == b'q'
                    && body
                        .strip_prefix('>')
                        .is_some_and(|s| s.bytes().all(|c| c.is_ascii_digit() || c == b';')))
                || (final_byte == b'u' && body.starts_with('?'));
            if !strip {
                out.push_str(&input[start..i]);
            }
        } else if matches!(kind, b']' | b'P' | b'^' | b'_') {
            let content_start = i;
            while i < b.len()
                && b[i] != 0x18
                && b[i] != 0x1a
                && !(kind == b']' && b[i] == 7)
                && b[i] != 0x1b
            {
                i += 1;
            }
            if i == b.len() || (b[i] == 0x1b && i + 1 == b.len()) {
                *pending = input[start..].into();
                break;
            }
            let content = &input[content_start..i];
            let strip = (kind == b']'
                && ["10;?", "11;?", "12;?", "10;rgb:", "11;rgb:", "12;rgb:"]
                    .iter()
                    .any(|p| content.starts_with(p)))
                || (kind == b'P' && {
                    let c = content.trim_start_matches(['0', '1']);
                    c.starts_with("$q")
                        || c.starts_with("$r")
                        || c.starts_with("+q")
                        || c.starts_with("+r")
                });
            if b[i] == 0x1b {
                if b[i + 1] == b'\\' {
                    i += 2;
                }
            } else {
                i += 1;
            }
            if !strip {
                out.push_str(&input[start..i]);
            }
        } else if !(0x20..=0x2f).contains(&kind) {
            if kind != b'Z' {
                out.push_str(&input[start..i]);
            }
        } else {
            while i < b.len() && (0x20..=0x2f).contains(&b[i]) {
                i += 1;
            }
            if i == b.len() {
                *pending = input[start..].into();
                break;
            }
            if b[i] != 0x1b {
                i += 1;
            }
            if kind != b'Z' {
                out.push_str(&input[start..i]);
            }
        }
    }
    out
}
// PTY reads can split a UTF-8 code point across arbitrary byte boundaries.
// Retain only an incomplete suffix; invalid complete bytes still become U+FFFD.
fn decode_pty_output(pending: &mut Vec<u8>, bytes: &[u8], flush: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut out = String::new();
    let mut offset = 0;
    while offset < pending.len() {
        match std::str::from_utf8(&pending[offset..]) {
            Ok(s) => {
                out.push_str(s);
                offset = pending.len();
            }
            Err(e) => {
                let valid_end = offset + e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[offset..valid_end]).unwrap());
                offset = valid_end;
                if let Some(len) = e.error_len() {
                    out.push('�');
                    offset += len;
                } else if flush {
                    out.push('�');
                    offset = pending.len();
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..offset);
    out
}
#[cfg(unix)]
fn terminate(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        // Signal the process group only if it still exists.
        unsafe {
            if libc::kill(-(pid as i32), 0) == 0 {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    });
}
#[cfg(windows)]
fn terminate(pid: u32) {
    // taskkill terminates descendants as well as the shell.
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
fn trim_history(history: &str, max: usize) -> &str {
    let mut start = history.len().saturating_sub(max);
    while !history.is_char_boundary(start) {
        start += 1;
    }
    &history[start..]
}
fn bound_history(history: &mut String, max: usize) {
    while history.len() > max || history.bytes().filter(|b| *b == b'\n').count() > 5000 {
        if let Some(i) = history.find('\n') {
            history.drain(..=i);
        } else {
            let keep = trim_history(history, max).to_owned();
            *history = keep;
            break;
        }
    }
}
fn wire_label(k: &Key, s: &Session) -> String {
    s.child_command
        .as_deref()
        .filter(|c| s.has_running_subprocess && !c.trim().is_empty())
        .map(|c| c.trim().chars().take(128).collect())
        .unwrap_or_else(|| label(&k.1))
}

fn inspect_process_table(output: &str, pid: u32) -> (bool, Option<String>) {
    let mut commands = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(id), Some(parent), Some(command)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(id), Ok(parent)) = (id.parse::<u32>(), parent.parse::<u32>()) else {
            continue;
        };
        let name = command
            .trim_matches(['[', ']', '(', ')'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_owned();
        commands.insert(id, name);
        children.entry(parent).or_default().push(id);
    }
    let shell = commands.get(&pid).filter(|s| !s.is_empty());
    let child = children.get(&pid).into_iter().flatten().find(|id| {
        shell.is_none()
            || commands.get(id) != shell
            || children.get(id).is_some_and(|v| !v.is_empty())
    });
    match child {
        Some(id) => (true, commands.get(id).filter(|s| !s.is_empty()).cloned()),
        None => (false, None),
    }
}
// A single bounded snapshot serves all sessions. Nonblocking reads keep both the
// time and memory limits effective even when the process writes continuously.
#[cfg(unix)]
fn process_snapshot(timeout: Duration) -> std::io::Result<String> {
    use std::io::{Error, ErrorKind};
    let executable = ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .unwrap_or("ps");
    let mut child = Command::new(executable)
        .args(["-eo", "pid=,ppid=,comm="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    unsafe {
        libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
    }
    let start = Instant::now();
    let mut output = Vec::new();
    let mut buf = [0; 8192];
    let result = loop {
        match stdout.read(&mut buf) {
            Ok(n) if n > 0 => {
                output.extend_from_slice(&buf[..n]);
                if output.len() > 524_288 {
                    break Err(Error::other("process table truncated"));
                }
            }
            Ok(_) => match child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    break Ok(String::from_utf8_lossy(&output).into_owned())
                }
                Ok(Some(_)) => break Err(Error::other("process table command failed")),
                Err(e) => break Err(e),
                _ => {}
            },
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
            Err(e) => break Err(e),
        }
        if start.elapsed() >= timeout {
            break Err(Error::new(ErrorKind::TimedOut, "process table timed out"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}
#[cfg(windows)]
fn process_snapshot(_timeout: Duration) -> std::io::Result<String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut output = String::new();
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            output.push_str(&format!(
                "{} {} {}\n",
                entry.th32ProcessID, entry.th32ParentProcessID, name
            ));
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        Ok(output)
    }
}
fn poll_delay(failures: u32, elapsed: Duration) -> Duration {
    Duration::from_millis(
        (1000u64.saturating_mul(1u64 << failures.min(30)))
            .max(elapsed.as_millis().saturating_mul(4).min(u64::MAX as u128) as u64)
            .min(60_000),
    )
}
fn poll_subprocesses(weak: std::sync::Weak<TerminalManager>) {
    let mut quiet: HashMap<Key, (u32, u64, u8)> = HashMap::new();
    let mut skipped = 0;
    let mut failures = 0;
    let mut delay = Duration::from_secs(1);
    loop {
        std::thread::sleep(delay);
        let Some(manager) = weak.upgrade() else { break };
        let running: Vec<_> = manager
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(k, s)| {
                (s.status == "running")
                    .then_some(s.pid)
                    .flatten()
                    .map(|pid| {
                        (
                            k.clone(),
                            pid,
                            s.sequence.saturating_add(s.input_count),
                            s.has_running_subprocess,
                        )
                    })
            })
            .collect();
        if running.is_empty() {
            quiet.clear();
            failures = 0;
            delay = Duration::from_secs(1);
            continue;
        }
        quiet.retain(|k, _| running.iter().any(|(key, _, _, _)| key == k));
        if running
            .iter()
            .all(|(k, pid, mark, busy)| !busy && quiet.get(k) == Some(&(*pid, *mark, 2)))
            && skipped < 29
        {
            skipped += 1;
            failures = 0;
            delay = Duration::from_secs(1);
            continue;
        }
        skipped = 0;
        let started = Instant::now();
        let snapshot = process_snapshot(Duration::from_secs(15));
        let elapsed = started.elapsed();
        let table = match snapshot {
            Ok(table) => {
                failures = 0;
                table
            }
            Err(e) => {
                eprintln!("failed to snapshot processes for terminal subprocess polling: {e}");
                quiet.clear();
                failures = (failures + 1).min(30);
                delay = poll_delay(failures, elapsed);
                continue;
            }
        };
        let mut events = Vec::new();
        let mut sessions = manager.sessions.lock().unwrap();
        for (k, pid, mut mark, _) in running {
            let previous = quiet.remove(&k);
            let (running, command) = inspect_process_table(&table, pid);
            let Some(s) = sessions
                .get_mut(&k)
                .filter(|s| s.status == "running" && s.pid == Some(pid))
            else {
                continue;
            };
            if s.has_running_subprocess != running || s.child_command != command {
                s.has_running_subprocess = running;
                s.child_command = command;
                s.sequence += 1;
                mark = mark.saturating_add(1);
                events.push(json!({"type":"activity","threadId":k.0,"terminalId":k.1,"sequence":s.sequence,"hasRunningSubprocess":running,"label":wire_label(&k,s)}));
            }
            if !running && s.sequence.saturating_add(s.input_count) == mark {
                let count = if previous.is_some_and(|(p, m, _)| p == pid && m == mark) {
                    2
                } else {
                    1
                };
                quiet.insert(k, (pid, mark, count));
            }
        }
        drop(sessions);
        for event in events {
            manager.emit(event);
        }
        delay = poll_delay(failures, elapsed);
    }
}
fn snapshot(k: &Key, s: &Session) -> Value {
    json!({"threadId":k.0,"terminalId":k.1,"cwd":s.cwd,"worktreePath":s.worktree,"status":s.status,"pid":s.pid,"history":s.history,"exitCode":s.exit_code,"exitSignal":s.exit_signal,"label":wire_label(k,s),"updatedAt":s.updated,"sequence":s.sequence,"cols":s.cols,"rows":s.rows})
}
fn summary(k: &Key, s: &Session) -> Value {
    let mut v = snapshot(k, s);
    let o = v.as_object_mut().unwrap();
    for f in ["history", "sequence", "cols", "rows"] {
        o.remove(f);
    }
    o.insert(
        "hasRunningSubprocess".into(),
        json!(s.has_running_subprocess),
    );
    v
}
impl TerminalManager {
    /// Snapshot all running terminal roots while the caller holds a workspace
    /// reservation. Terminal startup takes the corresponding reservation before
    /// inserting its session, so no overlapping terminal can start meanwhile.
    pub(crate) fn discovery_processes(&self) -> Vec<(u32, String, String)> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter_map(|((thread, terminal), session)| {
                        (session.status == "running")
                            .then_some(session.pid)
                            .flatten()
                            .map(|pid| (pid, thread.clone(), terminal.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(crate) fn cleanup_active_paths(&self) -> std::io::Result<Vec<PathBuf>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| std::io::Error::other("terminal state unavailable"))?;
        let mut paths = Vec::new();
        for session in sessions.values().filter(|s| s.status == "running") {
            paths.push(PathBuf::from(&session.cwd));
            if let Some(path) = session.worktree.as_str() {
                paths.push(PathBuf::from(path));
            } else if !session.worktree.is_null() {
                return Err(std::io::Error::other("invalid terminal worktree path"));
            }
        }
        Ok(paths)
    }
    pub fn with_logs_dir(path: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&path)?;
        Ok(Self {
            logs_dir: Some(path),
            ..Self::default()
        })
    }
    fn history_paths(&self, k: &Key) -> Vec<PathBuf> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use sha2::{Digest, Sha256};
        let Some(dir) = &self.logs_dir else {
            return vec![];
        };
        let encode = |s: &str| URL_SAFE_NO_PAD.encode(s.as_bytes());
        let hash = |s: &str| URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()));
        let name = |thread: String, terminal: String| {
            if k.1 == "term-1" {
                format!("{thread}.log")
            } else {
                format!("{thread}_{terminal}.log")
            }
        };
        let encoded = name(format!("terminal_{}", encode(&k.0)), encode(&k.1));
        let preferred = if encoded.len() <= 143 {
            encoded.clone()
        } else {
            name(format!("terminal_sha256.{}", hash(&k.0)), hash(&k.1))
        };
        let mut paths = vec![dir.join(preferred)];
        let encoded_path = dir.join(encoded);
        if !paths.contains(&encoded_path) {
            paths.push(encoded_path);
        }
        if k.1 == "term-1" {
            let safe: String =
                k.0.chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || "._-".contains(c) {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
            paths.push(dir.join(format!("{safe}.log")));
        }
        paths
    }
    fn delete_all_history(&self, thread: &str) {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use sha2::{Digest, Sha256};
        let Some(dir) = &self.logs_dir else { return };
        let encoded = format!("terminal_{}", URL_SAFE_NO_PAD.encode(thread.as_bytes()));
        let hashed = format!(
            "terminal_sha256.{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(thread.as_bytes()))
        );
        let legacy: String = thread
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        for (key, value) in self.pending_history.lock().unwrap().iter_mut() {
            if key.0 == thread {
                *value = None;
            }
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == format!("{legacy}.log")
                || [&encoded, &hashed].iter().any(|prefix| {
                    name == format!("{prefix}.log") || name.starts_with(&format!("{prefix}_"))
                })
            {
                if let Err(error) = std::fs::remove_file(entry.path()) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("failed to delete terminal histories for thread: {error}");
                    }
                }
            }
        }
    }
    fn persist(&self, k: &Key, history: &str) {
        if let Some(path) = self.history_paths(k).first() {
            if let Err(e) = std::fs::write(path, history) {
                eprintln!("failed to persist terminal history: {e}");
            }
        }
    }
    fn queue_persist(&self, k: &Key, history: &str) {
        let Some(path) = self.history_paths(k).first().cloned() else {
            return;
        };
        let mut pending = self.pending_history.lock().unwrap();
        let spawn = !pending.contains_key(k);
        pending.insert(k.clone(), Some(history.to_owned()));
        if spawn {
            let pending = self.pending_history.clone();
            let key = k.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let mut pending = pending.lock().unwrap();
                if let Some(Some(history)) = pending.remove(&key) {
                    if let Err(e) = std::fs::write(path, history) {
                        eprintln!("failed to persist terminal history: {e}");
                    }
                }
            });
        }
    }
    fn persist_immediate(&self, k: &Key, history: &str) {
        let mut pending = self.pending_history.lock().unwrap();
        // Leave a tombstone so an already-scheduled worker cannot overwrite this write.
        if let Some(value) = pending.get_mut(k) {
            *value = None;
        }
        self.persist(k, history);
    }
    fn apply_grid(&self, k: &Key, sessions: &mut HashMap<Key, Session>, grid: Option<(u16, u16)>) {
        let Some((cols, rows)) = grid else {
            return;
        };
        let Some(s) = sessions.get_mut(k) else {
            return;
        };
        if s.status != "running" || (s.cols, s.rows) == (cols, rows) {
            return;
        }
        if let Some(f) = &s.master {
            #[cfg(unix)]
            let size = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            #[cfg(unix)]
            if unsafe { libc::ioctl(f.as_raw_fd(), libc::TIOCSWINSZ, &size) } != 0 {
                return;
            }
            #[cfg(windows)]
            if f.master
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .is_err()
            {
                return;
            }
            s.cols = cols;
            s.rows = rows;
            s.sequence += 1;
            s.updated = now();
            self.emit(json!({"type":"activity","threadId":k.0,"terminalId":k.1,"sequence":s.sequence,"hasRunningSubprocess":s.has_running_subprocess,"label":wire_label(k,s),"cols":cols,"rows":rows}));
        }
    }
    fn shared_grid(viewers: Option<&HashMap<String, Viewer>>) -> Option<(u16, u16)> {
        viewers
            .into_iter()
            .flat_map(|v| v.values())
            .filter_map(|v| v.grid)
            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
    }
    fn retain_viewer(&self, k: &Key, viewer: &str, grid: Option<(u16, u16)>) {
        let mut sessions = self.sessions.lock().unwrap();
        let mut viewers = self.viewers.lock().unwrap();
        let v = viewers
            .entry(k.clone())
            .or_default()
            .entry(viewer.to_owned())
            .or_default();
        v.streams += 1;
        if v.grid.is_none() {
            v.grid = grid;
        }
        self.apply_grid(k, &mut sessions, Self::shared_grid(viewers.get(k)));
    }
    fn release_viewer(&self, k: &Key, viewer: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let mut viewers = self.viewers.lock().unwrap();
        if let Some(group) = viewers.get_mut(k) {
            if let Some(v) = group.get_mut(viewer) {
                v.streams -= 1;
                if v.streams == 0 {
                    group.remove(viewer);
                }
            }
            if group.is_empty() {
                viewers.remove(k);
            }
        }
        self.apply_grid(k, &mut sessions, Self::shared_grid(viewers.get(k)));
    }
    fn read_history(&self, k: &Key) -> Result<String, Value> {
        let paths = self.history_paths(k);
        for path in &paths {
            let mut f = match std::fs::File::open(path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    return Err(
                        json!({"_tag":"TerminalHistoryError","operation":"read","threadId":k.0,"terminalId":k.1,"message":e.to_string()}),
                    )
                }
            };
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            let offset = len.saturating_sub(8 * 1024 * 1024);
            f.seek(SeekFrom::Start(offset)).map_err(|e| json!({"_tag":"TerminalHistoryError","operation":"read","message":e.to_string()}))?;
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|e| json!({"_tag":"TerminalHistoryError","operation":"read","message":e.to_string()}))?;
            if offset > 0 {
                while bytes.first().is_some_and(|b| b & 0xc0 == 0x80) {
                    bytes.remove(0);
                }
            }
            let mut history = String::from_utf8_lossy(&bytes).into_owned();
            bound_history(&mut history, 512 * 1024);
            if path != &paths[0] {
                std::fs::write(&paths[0], &history).map_err(|e| json!({"_tag":"TerminalHistoryError","operation":"migrate","message":e.to_string()}))?;
                let _ = std::fs::remove_file(path);
            }
            if history.contains('\x1b') {
                history.push_str("\x1b[?1049h\x1b[<100u\x1b[=0;1u\x1b[?1049l\x1b[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l\x1b[?25;1035;1036h\x1b[<100u\x1b[=0;1u\x1b[>4m");
            }
            return Ok(history);
        }
        Ok(String::new())
    }
    fn sender(&self) -> broadcast::Sender<Value> {
        self.events
            .lock()
            .unwrap()
            .get_or_insert_with(|| broadcast::channel(512).0)
            .clone()
    }
    pub(crate) fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.sender().subscribe()
    }
    fn emit(&self, v: Value) {
        let _ = self.sender().send(v);
    }
    pub fn handles(tag: &str) -> bool {
        matches!(
            tag,
            "terminal.open"
                | "terminal.write"
                | "terminal.resize"
                | "terminal.clear"
                | "terminal.close"
                | "terminal.attach"
                | "terminal.observe"
                | "subscribeTerminalMetadata"
        )
    }
    pub fn open(self: &Arc<Self>, p: &Value) -> Result<Value, Value> {
        let k = key(p)?;
        let cwd = p
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| lookup(&k))?
            .trim();
        // Protect the interval between validating the directory and publishing
        // the live terminal from concurrent worktree removal or restore.
        let _reservation = crate::workspace_safety::reserve(
            cwd,
            crate::workspace_safety::ReservationKind::TurnStart,
        );
        match std::fs::metadata(cwd) {
            Err(_) => {
                return Err(
                    json!({"_tag":"TerminalCwdNotFoundError","cwd":cwd,"message":format!("Terminal folder does not exist: {cwd}. Restore the folder at this path before retrying.")}),
                )
            }
            Ok(m) if !m.is_dir() => {
                return Err(
                    json!({"_tag":"TerminalCwdNotDirectoryError","cwd":cwd,"message":format!("Terminal cwd is not a directory: {cwd}")}),
                )
            }
            _ => {}
        }
        let cols = grid(p, "cols", 120, 1000)?;
        let rows = grid(p, "rows", 30, 500)?;
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.get(&k) {
            if s.status == "running" && s.cwd == cwd {
                return Ok(snapshot(&k, s));
            }
        }
        let inherited = if sessions.contains_key(&k) {
            String::new()
        } else {
            self.read_history(&k)?
        };
        if let Some(old) = sessions.remove(&k) {
            self.persist_immediate(&k, "");
            if let Some(pid) = old.pid {
                terminate(pid);
            }
        }
        #[cfg(unix)]
        let (status, pid, master, reader, child) = {
            let mut master = 0;
            let mut slave = 0;
            let mut size = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            if unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut::<libc::termios>(),
                    &raw mut size,
                )
            } != 0
            {
                return Err(json!({"_tag":"TerminalError","message":"Could not open PTY"}));
            }
            let master = unsafe { std::fs::File::from_raw_fd(master) };
            let slave = unsafe { std::fs::File::from_raw_fd(slave) };
            let shell = std::env::var("SHELL")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/bin/sh".into());
            let fallback_slave = slave.try_clone().ok();
            let mut cmd = Command::new(&shell);
            cmd.current_dir(cwd)
                .env("TERM", "xterm-256color")
                .stdin(Stdio::from(slave.try_clone().unwrap()))
                .stdout(Stdio::from(slave.try_clone().unwrap()))
                .stderr(Stdio::from(slave));
            if let Some(env) = p.get("env").and_then(Value::as_object) {
                if env.len() > 128 {
                    return Err(json!({"_tag":"TerminalError","message":"Invalid environment"}));
                }
                for (k, v) in env {
                    if k.len() > 128
                        || !k.chars().enumerate().all(|(i, c)| {
                            c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                        })
                        || k.is_empty()
                        || v.as_str().is_none_or(|v| v.len() > 8192)
                    {
                        return Err(
                            json!({"_tag":"TerminalError","message":"Invalid environment"}),
                        );
                    }
                    cmd.env(k, v.as_str().unwrap());
                }
            }
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                    Ok(())
                });
            }
            let child = match cmd.spawn() {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && shell != "/bin/sh" => {
                    if let Some(slave) = fallback_slave {
                        let mut fallback = Command::new("/bin/sh");
                        fallback
                            .current_dir(cwd)
                            .env("TERM", "xterm-256color")
                            .stdin(Stdio::from(slave.try_clone().unwrap()))
                            .stdout(Stdio::from(slave.try_clone().unwrap()))
                            .stderr(Stdio::from(slave));
                        if let Some(env) = p.get("env").and_then(Value::as_object) {
                            for (k, v) in env {
                                fallback.env(k, v.as_str().unwrap());
                            }
                        }
                        unsafe {
                            fallback.pre_exec(|| {
                                libc::setsid();
                                libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                                Ok(())
                            });
                        }
                        fallback.spawn()
                    } else {
                        Err(e)
                    }
                }
                other => other,
            };
            let (status, pid, master, child) = match child {
                Ok(c) => ("running", Some(c.id()), Some(master), Some(c)),
                Err(_) => ("error", None, None, None),
            };
            let reader = master.as_ref().and_then(|f| f.try_clone().ok());
            (status, pid, master, reader, child)
        };
        #[cfg(windows)]
        let (status, pid, master, reader, child) = {
            use portable_pty::{native_pty_system, CommandBuilder, PtySize};
            if let Some(env) = p.get("env").and_then(Value::as_object) {
                if env.len() > 128
                    || env.iter().any(|(k, v)| {
                        k.is_empty()
                            || k.len() > 128
                            || !k.chars().enumerate().all(|(i, c)| {
                                c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                            })
                            || v.as_str().is_none_or(|v| v.len() > 8192)
                    })
                {
                    return Err(json!({"_tag":"TerminalError","message":"Invalid environment"}));
                }
            }
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|_| json!({"_tag":"TerminalError","message":"Could not open PTY"}))?;
            let shell = std::env::var("COMSPEC")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "cmd.exe".into());
            let mut cmd = CommandBuilder::new(shell);
            cmd.cwd(cwd);
            cmd.env("TERM", "xterm-256color");
            if let Some(env) = p.get("env").and_then(Value::as_object) {
                for (k, v) in env {
                    cmd.env(k, v.as_str().unwrap());
                }
            }
            let child = pair.slave.spawn_command(cmd);
            drop(pair.slave);
            match child {
                Ok(c) => {
                    let pid = c.process_id();
                    let reader = pair.master.try_clone_reader().map_err(
                        |_| json!({"_tag":"TerminalError","message":"Could not read PTY"}),
                    )?;
                    let writer = pair.master.take_writer().map_err(
                        |_| json!({"_tag":"TerminalError","message":"Could not write PTY"}),
                    )?;
                    (
                        "running",
                        pid,
                        Some(WindowsPty {
                            master: pair.master,
                            writer,
                        }),
                        Some(reader),
                        Some(c),
                    )
                }
                Err(_) => ("error", None, None, None, None),
            }
        };
        let s = Session {
            cwd: cwd.into(),
            worktree: p.get("worktreePath").cloned().unwrap_or(Value::Null),
            status: status.into(),
            pid,
            history: inherited,
            pending_control: String::new(),
            sequence: 1,
            cols,
            rows,
            updated: now(),
            master,
            exit_code: None,
            exit_signal: None,
            has_running_subprocess: false,
            child_command: None,
            input_count: 0,
        };
        let result = snapshot(&k, &s);
        sessions.insert(k.clone(), s);
        self.closed.lock().unwrap().remove(&k);
        drop(sessions);
        self.emit(json!({"type":"started","threadId":k.0,"terminalId":k.1,"sequence":1,"snapshot":result}));
        if pid.is_some() && !self.poll_started.swap(true, Ordering::AcqRel) {
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || poll_subprocesses(weak));
        }
        if let (Some(mut reader), Some(mut child)) = (reader, child) {
            let manager = self.clone();
            let key = k.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut utf8_pending = Vec::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = decode_pty_output(&mut utf8_pending, &buf[..n], false);
                            if data.is_empty() {
                                continue;
                            }
                            let mut sessions = manager.sessions.lock().unwrap();
                            let Some(s) = sessions.get_mut(&key).filter(|s| s.pid == pid) else {
                                break;
                            };
                            let visible = sanitize_history(&mut s.pending_control, &data);
                            s.history.push_str(&visible);
                            bound_history(&mut s.history, 8 * 1024 * 1024);
                            if !visible.is_empty() {
                                manager.queue_persist(&key, &s.history);
                            }
                            s.sequence += 1;
                            s.updated = now();
                            let event = json!({"type":"output","threadId":key.0,"terminalId":key.1,"sequence":s.sequence,"data":data});
                            drop(sessions);
                            manager.emit(event);
                        }
                    }
                }
                let tail = decode_pty_output(&mut utf8_pending, &[], true);
                if !tail.is_empty() {
                    let mut sessions = manager.sessions.lock().unwrap();
                    if let Some(s) = sessions.get_mut(&key).filter(|s| s.pid == pid) {
                        let visible = sanitize_history(&mut s.pending_control, &tail);
                        s.history.push_str(&visible);
                        bound_history(&mut s.history, 8 * 1024 * 1024);
                        if !visible.is_empty() {
                            manager.queue_persist(&key, &s.history);
                        }
                        s.sequence += 1;
                        s.updated = now();
                        let event = json!({"type":"output","threadId":key.0,"terminalId":key.1,"sequence":s.sequence,"data":tail});
                        drop(sessions);
                        manager.emit(event);
                    }
                }
                let status = child.wait().ok();
                #[cfg(unix)]
                use std::os::unix::process::ExitStatusExt;
                let mut sessions = manager.sessions.lock().unwrap();
                if let Some(s) = sessions.get_mut(&key).filter(|s| s.pid == pid) {
                    s.status = "exited".into();
                    s.pid = None;
                    s.master = None;
                    s.has_running_subprocess = false;
                    s.child_command = None;
                    #[cfg(unix)]
                    {
                        s.exit_code = status.as_ref().and_then(|x| x.code());
                        s.exit_signal = status.as_ref().and_then(|x| x.signal());
                    }
                    #[cfg(windows)]
                    {
                        s.exit_code = status.as_ref().map(|x| x.exit_code() as i32);
                        s.exit_signal = None;
                    }
                    s.sequence += 1;
                    s.updated = now();
                    let event = json!({"type":"exited","threadId":key.0,"terminalId":key.1,"sequence":s.sequence,"exitCode":s.exit_code,"exitSignal":s.exit_signal});
                    drop(sessions);
                    manager.emit(event);
                }
            });
        }
        Ok(result)
    }
    pub fn dispatch(self: &Arc<Self>, tag: &str, p: &Value) -> Result<Value, Value> {
        self.dispatch_for_viewer(tag, p, None)
    }
    pub fn dispatch_for_viewer(
        self: &Arc<Self>,
        tag: &str,
        p: &Value,
        viewer: Option<&str>,
    ) -> Result<Value, Value> {
        if tag == "terminal.open" {
            return self.open(p);
        }
        let k = if tag == "terminal.close" && p.get("terminalId").is_none() {
            (
                p.get("threadId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| json!({"_tag":"TerminalError","message":"Invalid thread"}))?
                    .to_owned(),
                String::new(),
            )
        } else {
            key(p)?
        };
        let mut sessions = self.sessions.lock().unwrap();
        if tag == "terminal.close" {
            let keys: Vec<_> = sessions
                .keys()
                .filter(|x| x.0 == k.0 && (p.get("terminalId").is_none() || **x == k))
                .cloned()
                .collect();
            if p.get("terminalId").is_some() && keys.is_empty() {
                self.closed.lock().unwrap().insert(k.clone());
                if p.get("deleteHistory") == Some(&json!(true)) {
                    for path in self.history_paths(&k) {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            for key in keys {
                if let Some(s) = sessions.remove(&key) {
                    if let Some(pid) = s.pid {
                        terminate(pid);
                    }
                    self.persist_immediate(&key, &s.history);
                    if p.get("deleteHistory") == Some(&json!(true)) {
                        for path in self.history_paths(&key) {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                    self.closed.lock().unwrap().insert(key.clone());
                    self.emit(json!({"type":"closed","threadId":key.0,"terminalId":key.1,"sequence":s.sequence+1}));
                }
            }
            if p.get("terminalId").is_none() && p.get("deleteHistory") == Some(&json!(true)) {
                self.delete_all_history(&k.0);
            }
            return Ok(Value::Null);
        }
        let Some(s) = sessions.get_mut(&k) else {
            if tag == "terminal.resize" {
                return Ok(Value::Null);
            }
            return Err(lookup(&k));
        };
        match tag {
            "terminal.write" => {
                let data = p
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty() && v.chars().count() <= 65536)
                    .ok_or_else(
                        || json!({"_tag":"TerminalError","message":"Invalid terminal input"}),
                    )?;
                if let Some(f) = s.master.as_mut() {
                    f.write_all(data.as_bytes()).map_err(|_|json!({"_tag":"TerminalWriteError","threadId":k.0,"terminalId":k.1,"terminalPid":s.pid,"message":"Failed to write to terminal"}))?;
                    s.input_count = s.input_count.saturating_add(1);
                } else if s.status != "exited" {
                    return Err(
                        json!({"_tag":"TerminalNotRunningError","threadId":k.0,"terminalId":k.1,"message":"Terminal is not running"}),
                    );
                }
            }
            "terminal.clear" => {
                s.history.clear();
                s.pending_control.clear();
                self.persist_immediate(&k, "");
                s.sequence += 1;
                s.updated = now();
                self.emit(
                    json!({"type":"cleared","threadId":k.0,"terminalId":k.1,"sequence":s.sequence}),
                );
            }
            "terminal.resize" => {
                let cols = grid(p, "cols", 0, 1000)?;
                let rows = grid(p, "rows", 0, 500)?;
                if cols == 0 || rows == 0 {
                    return Err(json!({"_tag":"TerminalError","message":"Invalid terminal size"}));
                }
                let mut viewers = self.viewers.lock().unwrap();
                let group = viewers.get_mut(&k);
                let mut attached = false;
                if let (Some(group), Some(viewer)) = (group, viewer) {
                    if let Some(v) = group.get_mut(viewer) {
                        v.grid = Some((cols, rows));
                        attached = true;
                    }
                }
                let shared = Self::shared_grid(viewers.get(&k));
                let target = if attached {
                    shared
                } else if shared.is_none() {
                    Some((cols, rows))
                } else {
                    None
                };
                self.apply_grid(&k, &mut sessions, target);
            }
            _ => {}
        }
        Ok(Value::Null)
    }
    #[allow(clippy::possible_missing_else)]
    pub fn stream(
        self: &Arc<Self>,
        tag: &str,
        p: &Value,
    ) -> tokio::sync::mpsc::Receiver<Result<Vec<Value>, Value>> {
        self.stream_for_viewer(tag, p, None)
    }
    #[allow(clippy::possible_missing_else)]
    pub fn stream_for_viewer(
        self: &Arc<Self>,
        tag: &str,
        p: &Value,
        viewer: Option<&str>,
    ) -> tokio::sync::mpsc::Receiver<Result<Vec<Value>, Value>> {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let viewer = viewer
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut events = self.sender().subscribe();
        let manager = self.clone();
        let tag = tag.to_owned();
        let p = p.clone();
        tokio::spawn(async move {
            let metadata = tag == "subscribeTerminalMetadata";
            let k = if metadata {
                None
            } else {
                match key(&p) {
                    Ok(k) => Some(k),
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                }
            };
            if tag == "terminal.attach" {
                let grid = match (p.get("cols"), p.get("rows")) {
                    (Some(_), Some(_)) => {
                        match (grid(&p, "cols", 0, 1000), grid(&p, "rows", 0, 500)) {
                            (Ok(c), Ok(r)) => Some((c, r)),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                manager.retain_viewer(k.as_ref().unwrap(), &viewer, grid);
            }
            let initial = if metadata {
                let sessions = manager.sessions.lock().unwrap();
                let mut terminals: Vec<_> = sessions.iter().map(|(k, s)| summary(k, s)).collect();
                terminals.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
                Ok(json!({"type":"snapshot","terminals":terminals}))
            } else {
                let key = k.as_ref().unwrap();
                let existing = manager
                    .sessions
                    .lock()
                    .unwrap()
                    .get(key)
                    .map(|s| snapshot(key, s));
                match existing {
                    Some(s) => Ok(json!({"type":"snapshot","snapshot":s})),
                    None if tag == "terminal.attach"
                        && p.get("resume") == Some(&json!(true))
                        && manager.closed.lock().unwrap().contains(key) =>
                    {
                        Ok(json!({"type":"closed","threadId":key.0,"terminalId":key.1}))
                    }
                    None if tag == "terminal.attach" && p.get("cwd").is_some() => manager
                        .open(&p)
                        .map(|s| json!({"type":"snapshot","snapshot":s})),
                    None => Err(lookup(key)),
                }
            };
            if tag == "terminal.attach" && initial.is_ok() {
                let mut sessions = manager.sessions.lock().unwrap();
                let viewers = manager.viewers.lock().unwrap();
                manager.apply_grid(
                    k.as_ref().unwrap(),
                    &mut sessions,
                    Self::shared_grid(viewers.get(k.as_ref().unwrap())),
                );
            }
            let mut initial = initial;
            if let Some(max) = p.get("maxHistoryBytes").and_then(Value::as_u64) {
                if let Ok(event) = &mut initial {
                    if let Some(history) = event.pointer_mut("/snapshot/history") {
                        if let Some(value) = history.as_str() {
                            *history = json!(trim_history(value, max as usize));
                        }
                    }
                }
            }
            let mut floor = initial
                .as_ref()
                .ok()
                .and_then(|v| v["snapshot"]["sequence"].as_u64())
                .unwrap_or(0);
            let failed = initial.is_err();
            if tx.send(initial.map(|v| vec![v])).await.is_err() || failed {
                if tag == "terminal.attach" {
                    manager.release_viewer(k.as_ref().unwrap(), &viewer);
                }
                return;
            }
            loop {
                tokio::select! { _=tx.closed()=>break, event=events.recv()=> { match event { Ok(mut event)=> { if metadata { let kind=event["type"].as_str().unwrap_or(""); if ["output","cleared"].contains(&kind) {continue} let key=(event["threadId"].as_str().unwrap_or("").to_owned(),event["terminalId"].as_str().unwrap_or("").to_owned()); event=if kind=="closed" {json!({"type":"remove","threadId":key.0,"terminalId":key.1})} else { let sessions=manager.sessions.lock().unwrap(); match sessions.get(&key) {Some(s)=>json!({"type":"upsert","terminal":summary(&key,s)}),None=>continue} }; } else { let key=k.as_ref().unwrap(); if event["threadId"]!=key.0 || event["terminalId"]!=key.1 || event["sequence"].as_u64().is_some_and(|n|n<=floor) {continue} if event["type"]=="started" { event=json!({"type":"snapshot","snapshot":event["snapshot"]}); } } if tx.send(Ok(vec![event])).await.is_err(){break} }, Err(broadcast::error::RecvError::Lagged(_))=> { if let Some(key)=&k { let snap=manager.sessions.lock().unwrap().get(key).map(|s|snapshot(key,s)); let e=match snap {Some(mut s)=>{ floor=s["sequence"].as_u64().unwrap_or(0); if let Some(max)=p.get("maxHistoryBytes").and_then(Value::as_u64) { if let Some(h)=s["history"].as_str() { s["history"]=json!(trim_history(h,max as usize)); } } json!({"type":"snapshot","snapshot":s}) },None=>json!({"type":"closed","threadId":key.0,"terminalId":key.1})}; if tx.send(Ok(vec![e])).await.is_err(){break} } }, Err(_)=>break } } }
            }
            if tag == "terminal.attach" {
                manager.release_viewer(k.as_ref().unwrap(), &viewer);
            }
        });
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn terminal_start_waits_for_overlapping_restore_reservation() {
        let root =
            std::env::temp_dir().join(format!("t3-terminal-reserve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let reservation = crate::workspace_safety::reserve(
            &root,
            crate::workspace_safety::ReservationKind::Restore,
        );
        let manager = Arc::new(TerminalManager::default());
        let other = manager.clone();
        let cwd = root.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let task = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = other.open(&json!({"threadId":"t", "terminalId":"term", "cwd":cwd}));
            result_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(result_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        drop(reservation);
        assert!(result_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .is_ok());
        task.join().unwrap();
        manager
            .dispatch(
                "terminal.close",
                &json!({"threadId":"t", "terminalId":"term"}),
            )
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn poll_backoff_accounts_for_failures_and_query_duration() {
        assert_eq!(poll_delay(0, Duration::ZERO), Duration::from_secs(1));
        assert_eq!(poll_delay(2, Duration::ZERO), Duration::from_secs(4));
        assert_eq!(
            poll_delay(1, Duration::from_secs(15)),
            Duration::from_secs(60)
        );
        assert_eq!(poll_delay(30, Duration::ZERO), Duration::from_secs(60));
    }
    #[test]
    fn process_table_ignores_idle_helper_shells_and_finds_commands() {
        let idle = "10 1 /bin/bash\n11 10 /bin/bash\n";
        assert_eq!(inspect_process_table(idle, 10), (false, None));
        let active = "10 1 /bin/bash\n11 10 /bin/bash\n12 11 /usr/bin/sleep\n";
        assert_eq!(
            inspect_process_table(active, 10),
            (true, Some("bash".into()))
        );
        let active = "10 1 /bin/bash\n12 10 /usr/bin/sleep\n";
        assert_eq!(
            inspect_process_table(active, 10),
            (true, Some("sleep".into()))
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_activity_tracks_command_start_and_exit() {
        let manager = Arc::new(TerminalManager::default());
        let input = json!({"threadId":"activity", "terminalId":"term-1", "cwd":"/tmp"});
        let mut stream = manager.stream("terminal.attach", &input);
        stream.recv().await.unwrap().unwrap();
        manager
            .dispatch(
                "terminal.write",
                &json!({"threadId":"activity", "terminalId":"term-1", "data":"/bin/sleep 120\n"}),
            )
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let event = stream.recv().await.unwrap().unwrap();
                if event[0]["type"] == "activity" && event[0]["hasRunningSubprocess"] == true
                    && event[0]["label"] == "sleep"
                {
                    break;
                }
            }
        })
        .await
        .expect("terminal did not report the foreground sleep");
        manager
            .dispatch(
                "terminal.write",
                &json!({"threadId":"activity", "terminalId":"term-1", "data":"\u{3}"}),
            )
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let event = stream.recv().await.unwrap().unwrap();
                if event[0]["type"] == "activity" && event[0]["hasRunningSubprocess"] == false {
                    break;
                }
            }
        })
        .await
        .expect("terminal did not report the foreground sleep exiting");
        manager.dispatch("terminal.close", &input).unwrap();
    }
    #[test]
    fn pty_decoder_preserves_split_unicode_and_flushes_invalid_suffix() {
        let mut pending = Vec::new();
        assert_eq!(decode_pty_output(&mut pending, b"a\xe7", false), "a");
        assert_eq!(decode_pty_output(&mut pending, b"\x95", false), "");
        assert_eq!(
            decode_pty_output(&mut pending, b"\x8cb\xff\xe2", false),
            "界b�"
        );
        assert_eq!(decode_pty_output(&mut pending, b"", true), "�");
        assert!(pending.is_empty());
    }
    #[test]
    fn history_removes_split_queries_but_preserves_formatting() {
        let mut pending = String::new();
        assert_eq!(sanitize_history(&mut pending, "a\x1b[3"), "a");
        assert_eq!(sanitize_history(&mut pending, "1mred\x1b[6"), "\x1b[31mred");
        assert_eq!(sanitize_history(&mut pending, "n!\x1b]10;?\x07end"), "!end");
        assert!(pending.is_empty());
        assert_eq!(sanitize_history(&mut pending, "\x1bZx"), "x");
        assert_eq!(trim_history("a界b", 3), "b");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn pty_streams_output_and_can_close() {
        let manager = Arc::new(TerminalManager::default());
        let input = json!({"threadId":"thread", "terminalId":"term-1", "cwd":"/tmp"});
        let mut stream = manager.stream("terminal.attach", &input);
        let first = stream.recv().await.unwrap().unwrap();
        assert_eq!(first[0]["type"], "snapshot");
        assert_eq!(first[0]["snapshot"]["status"], "running");
        manager.dispatch("terminal.write", &json!({"threadId":"thread", "terminalId":"term-1", "data":"printf 'terminal-test-123\\n'\n"})).unwrap();
        let mut output = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !output.contains("terminal-test-123") {
                let event = stream.recv().await.unwrap().unwrap();
                if let Some(data) = event[0]["data"].as_str() {
                    output.push_str(data);
                }
            }
        })
        .await
        .unwrap();
        manager
            .dispatch(
                "terminal.resize",
                &json!({"threadId":"thread", "terminalId":"term-1", "cols":80, "rows":24}),
            )
            .unwrap();
        manager.dispatch("terminal.clear", &input).unwrap();
        assert_eq!(
            manager
                .sessions
                .lock()
                .unwrap()
                .get(&("thread".into(), "term-1".into()))
                .unwrap()
                .history,
            ""
        );
        manager
            .dispatch("terminal.close", &json!({"threadId":"thread"}))
            .unwrap();
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_pty_streams_output_resizes_and_closes() {
        let manager = Arc::new(TerminalManager::default());
        let cwd = std::env::temp_dir();
        let input = json!({"threadId":"windows", "terminalId":"term-1", "cwd":cwd});
        let mut stream = manager.stream("terminal.attach", &input);
        let first = stream.recv().await.unwrap().unwrap();
        assert_eq!(first[0]["snapshot"]["status"], "running");
        manager.dispatch("terminal.write", &json!({"threadId":"windows", "terminalId":"term-1", "data":"echo terminal-test-123\r\n"})).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut output = String::new();
            while !output.contains("terminal-test-123") {
                let event = stream.recv().await.unwrap().unwrap();
                if let Some(data) = event[0]["data"].as_str() {
                    output.push_str(data);
                }
            }
        })
        .await
        .unwrap();
        manager
            .dispatch(
                "terminal.resize",
                &json!({"threadId":"windows", "terminalId":"term-1", "cols":80, "rows":24}),
            )
            .unwrap();
        manager.dispatch("terminal.close", &input).unwrap();
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
    #[test]
    fn history_persists_migrates_and_deletes() {
        let dir = std::env::temp_dir().join(format!("t3-terminal-{}", uuid::Uuid::new_v4()));
        let manager = Arc::new(TerminalManager::with_logs_dir(dir.clone()).unwrap());
        let k = ("thread/one".to_owned(), "term-1".to_owned());
        std::fs::write(dir.join("thread_one.log"), "old history").unwrap();
        assert_eq!(manager.read_history(&k).unwrap(), "old history");
        assert!(!dir.join("thread_one.log").exists());
        manager.persist(&k, "saved history");
        let next = TerminalManager::with_logs_dir(dir.clone()).unwrap();
        assert_eq!(next.read_history(&k).unwrap(), "saved history");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn shared_viewers_resize_and_release() {
        let manager = Arc::new(TerminalManager::default());
        let wide = json!({"threadId":"shared", "terminalId":"term-1", "cwd":"/tmp", "cols":130, "rows":25});
        let narrow =
            json!({"threadId":"shared", "terminalId":"term-1", "cwd":"/tmp", "cols":54, "rows":15});
        let mut a = manager.stream_for_viewer("terminal.attach", &wide, Some("wide"));
        a.recv().await.unwrap().unwrap();
        let mut b = manager.stream_for_viewer("terminal.attach", &narrow, Some("phone"));
        let snap = b.recv().await.unwrap().unwrap();
        assert_eq!(snap[0]["snapshot"]["cols"], 54);
        manager
            .dispatch_for_viewer(
                "terminal.resize",
                &json!({"threadId":"shared","terminalId":"term-1","cols":100,"rows":20}),
                Some("phone"),
            )
            .unwrap();
        manager
            .dispatch(
                "terminal.resize",
                &json!({"threadId":"shared","terminalId":"term-1","cols":200,"rows":50}),
            )
            .unwrap();
        let k = ("shared".to_owned(), "term-1".to_owned());
        assert_eq!(
            {
                let s = manager.sessions.lock().unwrap();
                (s[&k].cols, s[&k].rows)
            },
            (100, 20)
        );
        drop(b);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let resized = {
                    let s = manager.sessions.lock().unwrap();
                    (s[&k].cols, s[&k].rows) == (130, 25)
                };
                if resized {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(a);
        manager
            .dispatch("terminal.close", &json!({"threadId":"shared"}))
            .unwrap();
    }
    #[test]
    fn immediate_history_write_cancels_older_pending_output() {
        let dir = std::env::temp_dir().join(format!("t3-terminal-{}", uuid::Uuid::new_v4()));
        let manager = Arc::new(TerminalManager::with_logs_dir(dir.clone()).unwrap());
        let k = ("thread".to_owned(), "term-1".to_owned());
        manager.queue_persist(&k, "stale");
        manager.persist_immediate(&k, "");
        std::thread::sleep(std::time::Duration::from_millis(350));
        assert_eq!(manager.read_history(&k).unwrap(), "");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn thread_close_deletes_offline_history_and_pending_writes() {
        let dir =
            std::env::temp_dir().join(format!("t3-terminal-cleanup-{}", uuid::Uuid::new_v4()));
        let manager = Arc::new(TerminalManager::with_logs_dir(dir.clone()).unwrap());
        let default = ("thread".to_owned(), "term-1".to_owned());
        let other = ("thread".to_owned(), "x".repeat(128));
        manager.persist(&default, "old");
        manager.persist(&other, "other");
        manager.queue_persist(&default, "stale");
        std::fs::write(dir.join("unrelated.log"), "keep").unwrap();
        manager
            .dispatch(
                "terminal.close",
                &json!({"threadId":"thread","deleteHistory":true}),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(350));
        let names = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![std::ffi::OsString::from("unrelated.log")]);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_invalid_directory_and_input() {
        let manager = Arc::new(TerminalManager::default());
        let err = manager
            .open(&json!({"threadId":"t","terminalId":"x","cwd":"/nonexistent-t3-terminal-test"}))
            .unwrap_err();
        assert_eq!(err["_tag"], "TerminalCwdNotFoundError");
        assert!(manager
            .dispatch(
                "terminal.write",
                &json!({"threadId":"t","terminalId":"x","data":"x"})
            )
            .is_err());
    }
}
