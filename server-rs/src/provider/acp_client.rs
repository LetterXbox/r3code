//! Scoped client-side ACP filesystem and terminal callbacks.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
const FILE_LIMIT: u64 = 8 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;
const LIVE_LIMIT: usize = 16;
const UNRELEASED_LIMIT: usize = 64;

struct Buffer {
    bytes: Vec<u8>,
    truncated: bool,
    limit: usize,
    budget: Arc<Mutex<usize>>,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        if let Ok(mut total) = self.budget.lock() {
            *total = total.saturating_sub(self.bytes.len());
        }
    }
}
struct Terminal {
    session: String,
    child: Arc<Mutex<Child>>,
    output: Arc<Mutex<Buffer>>,
    readers: Arc<AtomicUsize>,
}
pub(crate) struct ClientServices {
    session: String,
    cwd: PathBuf,
    roots: Vec<PathBuf>,
    terminals: HashMap<String, Terminal>,
    budget: Arc<Mutex<usize>>,
    next: u64,
    allow_read: bool,
    allow_write: bool,
    allow_terminal: bool,
    shell_commands: bool,
    session_execute_grant: bool,
    turn_execute_grant: bool,
}
impl ClientServices {
    pub(crate) fn new(
        session: String,
        cwd: PathBuf,
        roots: Vec<PathBuf>,
        read: bool,
        write: bool,
        terminal: bool,
        shell: bool,
    ) -> Self {
        Self {
            session,
            cwd,
            roots,
            terminals: HashMap::new(),
            budget: Arc::new(Mutex::new(0)),
            next: 0,
            allow_read: read,
            allow_write: write,
            allow_terminal: terminal,
            shell_commands: shell,
            session_execute_grant: false,
            turn_execute_grant: false,
        }
    }
    pub(crate) fn bind_session(&mut self, id: &str) -> Result<(), String> {
        if id.trim().is_empty() || (!self.session.is_empty() && self.session != id) {
            return Err("ACP callback session mismatch".into());
        }
        self.session = id.to_owned();
        Ok(())
    }

    pub(crate) fn begin_turn(&mut self) {
        self.turn_execute_grant = false;
    }
    pub(crate) fn grant_execute(&mut self, permanent: bool) {
        if permanent {
            self.session_execute_grant = true;
        } else {
            self.turn_execute_grant = true;
        }
    }
    pub(crate) fn has_execute_grant(&self) -> bool {
        self.session_execute_grant || self.turn_execute_grant
    }

    pub(crate) fn wait_handle(
        &self,
        params: &Value,
    ) -> Result<(Arc<Mutex<Child>>, Arc<AtomicUsize>), String> {
        if !self.allow_terminal || params["sessionId"].as_str() != Some(&self.session) {
            return Err("ACP request belongs to another session".into());
        }
        let id = params["terminalId"].as_str().ok_or("Missing terminal id")?;
        let terminal = self
            .terminals
            .get(id)
            .filter(|t| t.session == self.session)
            .ok_or("Unknown terminal id")?;
        Ok((terminal.child.clone(), terminal.readers.clone()))
    }
    pub(crate) fn cancel_terminals(&mut self) {
        for t in self.terminals.values_mut() {
            if let Ok(mut child) = t.child.lock() {
                kill(&mut child);
            }
        }
    }
    fn checked_path(&self, path: &str, write: bool) -> Result<PathBuf, String> {
        if path.trim().is_empty() {
            return Err("Missing file path".into());
        }
        let raw = Path::new(path);
        let path = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.cwd.join(raw)
        };
        let resolved = if write && !path.exists() {
            if std::fs::symlink_metadata(&path).is_ok() {
                return Err("File target is unavailable".into());
            }
            let parent = path
                .parent()
                .ok_or("Invalid file path")?
                .canonicalize()
                .map_err(|_| "File parent is unavailable")?;
            parent.join(path.file_name().ok_or("Invalid file path")?)
        } else {
            path.canonicalize().map_err(|_| "File is unavailable")?
        };
        if !self
            .roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| resolved.starts_with(root))
        {
            return Err("Path is outside the session workspace".into());
        }
        Ok(resolved)
    }
    #[cfg(unix)]
    fn open_confined(&self, path: &str, write: bool) -> Result<std::fs::File, String> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let resolved = self.checked_path(path, write)?;
        let root = self
            .roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .find(|root| resolved.starts_with(root))
            .ok_or("Path is outside the session workspace")?;
        let relative = resolved
            .strip_prefix(&root)
            .map_err(|_| "Invalid file path")?;
        let mut dir = std::fs::File::open("/").map_err(|_| "File root unavailable")?;
        let components: Vec<_> = root
            .components()
            .chain(relative.components())
            .filter_map(|part| match part {
                std::path::Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect();
        if components.is_empty() {
            return Err("Invalid file path".into());
        }
        for (i, component) in components.iter().enumerate() {
            let name =
                std::ffi::CString::new(component.as_bytes()).map_err(|_| "Invalid file path")?;
            let last = i + 1 == components.len();
            let flags = libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if !last {
                    libc::O_RDONLY | libc::O_DIRECTORY
                } else if write {
                    libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK
                } else {
                    libc::O_RDONLY | libc::O_NONBLOCK
                };
            // Every component is opened relative to an already-open directory,
            // so replacing a path component with a symlink cannot redirect it.
            let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o666) };
            if fd < 0 {
                return Err("File is unavailable".into());
            }
            dir = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        Ok(dir)
    }
    #[cfg(not(unix))]
    fn open_confined(&self, _path: &str, _write: bool) -> Result<std::fs::File, String> {
        Err("Secure filesystem callbacks are unavailable on this platform".into())
    }
    pub(crate) fn handle(
        &mut self,
        method: &str,
        params: &Value,
        allow_execute: bool,
    ) -> Result<Value, String> {
        let request_session = params["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("ACP request has no session")?;
        if self.session.is_empty() {
            self.session = request_session.to_owned();
        }
        if request_session != self.session {
            return Err("ACP request belongs to another session".into());
        }
        match method {
            "fs/read_text_file" if self.allow_read => {
                let path = params["path"].as_str().ok_or("Missing file path")?;
                let file = self.open_confined(path, false)?;
                let metadata = file.metadata().map_err(|_| "File is unavailable")?;
                if !metadata.is_file() || metadata.len() > FILE_LIMIT {
                    return Err("File is not a readable text file under 8 MiB".into());
                }
                let mut bytes = Vec::new();
                file.take(FILE_LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Could not read file")?;
                if bytes.len() > FILE_LIMIT as usize {
                    return Err("File is too large".into());
                }
                let text = String::from_utf8(bytes).map_err(|_| "File is not UTF-8")?;
                if text.contains('\0') {
                    return Err("File contains binary data".into());
                }
                let content = if params.get("line").is_some() || params.get("limit").is_some() {
                    let start = params["line"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
                    let limit = params["limit"]
                        .as_u64()
                        .map(|n| n as usize)
                        .unwrap_or(usize::MAX);
                    text.split('\n')
                        .skip(start)
                        .take(limit)
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    text
                };
                Ok(json!({"content":content}))
            }
            "fs/write_text_file" if self.allow_write => {
                let path = params["path"].as_str().ok_or("Missing file path")?;
                let content = params["content"].as_str().ok_or("Missing file content")?;
                if content.len() > FILE_LIMIT as usize {
                    return Err("File is too large".into());
                }
                use std::io::Write;
                let mut file = self.open_confined(path, true)?;
                if !file
                    .metadata()
                    .map_err(|_| "File is unavailable")?
                    .is_file()
                {
                    return Err("File is not a regular file".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if file.metadata().map_err(|_| "File is unavailable")?.nlink() != 1 {
                        return Err("Cannot write a file with multiple hard links".into());
                    }
                }
                file.set_len(0).map_err(|_| "Could not write file")?;
                file.write_all(content.as_bytes())
                    .map_err(|_| "Could not write file")?;
                Ok(json!({}))
            }
            "terminal/create" if self.allow_terminal => {
                if !allow_execute {
                    return Err(
                        "The active runtime policy requires approval for terminal/create".into(),
                    );
                }
                let live = self
                    .terminals
                    .values_mut()
                    .map(|t| {
                        t.child
                            .lock()
                            .ok()
                            .and_then(|mut c| c.try_wait().ok())
                            .flatten()
                            .is_none()
                    })
                    .filter(|active| *active)
                    .count();
                if live >= LIVE_LIMIT || self.terminals.len() >= UNRELEASED_LIMIT {
                    return Err("ACP terminal limit reached".into());
                }
                let command = params["command"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Missing terminal command")?;
                let args = params["args"].as_array().cloned().unwrap_or_default();
                if args.iter().any(|v| !v.is_string()) {
                    return Err("Invalid terminal arguments".into());
                }
                let mut process = if self.shell_commands && args.is_empty() {
                    let mut p = Command::new("/bin/sh");
                    p.args(["-c", command]);
                    p
                } else {
                    let mut p = Command::new(command);
                    p.args(args.iter().filter_map(Value::as_str));
                    p
                };
                process
                    .current_dir(
                        params["cwd"]
                            .as_str()
                            .map(PathBuf::from)
                            .unwrap_or_else(|| self.cwd.clone()),
                    )
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(env) = params["env"].as_array() {
                    for entry in env {
                        let (Some(name), Some(value)) =
                            (entry["name"].as_str(), entry["value"].as_str())
                        else {
                            return Err("Invalid terminal environment".into());
                        };
                        if name.contains('=') || name.contains('\0') || value.contains('\0') {
                            return Err("Invalid terminal environment".into());
                        }
                        process.env(name, value);
                    }
                }
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    process.process_group(0);
                }
                let mut child = process
                    .spawn()
                    .map_err(|_| "Could not start terminal command")?;
                let buffer = Arc::new(Mutex::new(Buffer {
                    limit: params["outputByteLimit"]
                        .as_u64()
                        .map(|n| (n as usize).min(OUTPUT_LIMIT))
                        .unwrap_or(4 * 1024 * 1024),
                    bytes: Vec::new(),
                    truncated: false,
                    budget: self.budget.clone(),
                }));
                let readers = Arc::new(AtomicUsize::new(0));
                for stream in [
                    child
                        .stdout
                        .take()
                        .map(|s| Box::new(s) as Box<dyn Read + Send>),
                    child
                        .stderr
                        .take()
                        .map(|s| Box::new(s) as Box<dyn Read + Send>),
                ]
                .into_iter()
                .flatten()
                {
                    let output = buffer.clone();
                    readers.fetch_add(1, Ordering::SeqCst);
                    let reader_count = readers.clone();
                    thread::spawn(move || {
                        let mut reader = BufReader::new(stream);
                        let mut bytes = [0u8; 8192];
                        while let Ok(n) = reader.read(&mut bytes) {
                            if n == 0 {
                                break;
                            }
                            if let Ok(mut b) = output.lock() {
                                let budget = b.budget.clone();
                                let Ok(mut total) = budget.lock() else { break };
                                let old = b.bytes.len();
                                b.bytes.extend_from_slice(&bytes[..n]);
                                let available =
                                    TOTAL_LIMIT.saturating_sub(total.saturating_sub(old));
                                let keep = b.limit.min(available);
                                let excess = b.bytes.len().saturating_sub(keep);
                                if excess > 0 {
                                    b.bytes.drain(..excess);
                                    b.truncated = true;
                                }
                                *total = total.saturating_sub(old).saturating_add(b.bytes.len());
                            } else {
                                break;
                            }
                        }
                        reader_count.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                self.next += 1;
                let id = format!("t3-term-{}", self.next);
                self.terminals.insert(
                    id.clone(),
                    Terminal {
                        session: self.session.clone(),
                        child: Arc::new(Mutex::new(child)),
                        output: buffer,
                        readers,
                    },
                );
                Ok(json!({"terminalId":id}))
            }
            "terminal/output" | "terminal/wait_for_exit" | "terminal/kill" | "terminal/release"
                if self.allow_terminal =>
            {
                let id = params["terminalId"].as_str().ok_or("Missing terminal id")?;
                let terminal = self
                    .terminals
                    .get_mut(id)
                    .filter(|t| t.session == self.session)
                    .ok_or("Unknown terminal id")?;
                match method {
                    "terminal/output" => {
                        let state = terminal
                            .child
                            .lock()
                            .map_err(|_| "Terminal unavailable")?
                            .try_wait()
                            .map_err(|_| "Could not inspect terminal")?;
                        let buffer = terminal
                            .output
                            .lock()
                            .map_err(|_| "Terminal output unavailable")?;
                        let start = if buffer.truncated {
                            buffer
                                .bytes
                                .iter()
                                .position(|b| b & 0xc0 != 0x80)
                                .unwrap_or(buffer.bytes.len())
                        } else {
                            0
                        };
                        let mut result = json!({"output":String::from_utf8_lossy(&buffer.bytes[start..]),"truncated":buffer.truncated});
                        if let Some(status) = state {
                            result["exitStatus"] = terminal_status(status);
                        }
                        Ok(result)
                    }
                    "terminal/wait_for_exit" => {
                        wait(terminal.child.clone(), terminal.readers.clone())
                    }
                    "terminal/kill" => {
                        if let Ok(mut child) = terminal.child.lock() {
                            kill(&mut child);
                        }
                        Ok(json!({}))
                    }
                    _ => {
                        let terminal = self.terminals.remove(id).ok_or("Unknown terminal id")?;
                        if let Ok(mut child) = terminal.child.lock() {
                            kill(&mut child);
                        }
                        Ok(json!({}))
                    }
                }
            }
            _ => Err("ACP client method is not available".into()),
        }
    }
}
pub(crate) fn wait(child: Arc<Mutex<Child>>, readers: Arc<AtomicUsize>) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        let status = child
            .lock()
            .map_err(|_| "Terminal unavailable")?
            .try_wait()
            .map_err(|_| "Could not inspect terminal")?;
        if let Some(status) = status {
            let drain = Instant::now() + Duration::from_secs(1);
            while readers.load(Ordering::SeqCst) > 0 && Instant::now() < drain {
                thread::sleep(Duration::from_millis(5));
            }
            return Ok(terminal_status(status));
        }
        if Instant::now() >= deadline {
            return Err("Terminal wait timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn terminal_status(status: std::process::ExitStatus) -> Value {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match signal {
            libc::SIGTERM => "SIGTERM".to_owned(),
            libc::SIGKILL => "SIGKILL".to_owned(),
            libc::SIGINT => "SIGINT".to_owned(),
            libc::SIGHUP => "SIGHUP".to_owned(),
            other => format!("SIG{other}"),
        })
    };
    #[cfg(not(unix))]
    let signal: Option<String> = None;
    json!({"exitCode":status.code(),"signal":signal})
}
fn kill(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
impl Drop for ClientServices {
    fn drop(&mut self) {
        for terminal in self.terminals.values_mut() {
            if let Ok(mut child) = terminal.child.lock() {
                kill(&mut child);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test]
    fn filesystem_callbacks_enforce_roots_session_and_utf8() {
        let root = std::env::temp_dir().join(format!("t3-acp-files-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(workspace.join("file"), "one\ntwo\nthree").unwrap();
        std::fs::write(outside.join("secret"), "private").unwrap();
        symlink(outside.join("secret"), workspace.join("escape")).unwrap();
        let mut services = ClientServices::new(
            "session".into(),
            workspace.clone(),
            vec![workspace.clone()],
            true,
            true,
            false,
            false,
        );
        assert_eq!(services.handle("fs/read_text_file",&json!({"sessionId":"session","path":workspace.join("file"),"line":2,"limit":1}),false).unwrap()["content"],"two");
        assert!(services
            .handle(
                "fs/read_text_file",
                &json!({"sessionId":"other","path":workspace.join("file")}),
                false
            )
            .is_err());
        assert!(services
            .handle(
                "fs/read_text_file",
                &json!({"sessionId":"session","path":workspace.join("escape")}),
                false
            )
            .is_err());
        assert!(services
            .handle(
                "fs/write_text_file",
                &json!({"sessionId":"session","path":workspace.join("escape"),"content":"bad"}),
                false
            )
            .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("secret")).unwrap(),
            "private"
        );
        std::fs::hard_link(outside.join("secret"), workspace.join("hardlink")).unwrap();
        assert!(services
            .handle(
                "fs/write_text_file",
                &json!({"sessionId":"session","path":workspace.join("hardlink"),"content":"bad"}),
                false
            )
            .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("secret")).unwrap(),
            "private"
        );
        std::fs::write(workspace.join("binary"), b"a\0b").unwrap();
        assert!(services
            .handle(
                "fs/read_text_file",
                &json!({"sessionId":"session","path":workspace.join("binary")}),
                false
            )
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn filesystem_reads_resist_concurrent_symlink_swaps() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let root = std::env::temp_dir().join(format!("t3-acp-race-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(workspace.join("safe")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(workspace.join("safe/file"), "safe").unwrap();
        std::fs::write(outside.join("file"), "secret").unwrap();
        let active = workspace.join("active");
        symlink(workspace.join("safe"), &active).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let active_copy = active.clone();
        let safe = workspace.join("safe");
        let worker = std::thread::spawn(move || {
            while flag.load(Ordering::Relaxed) {
                let _ = std::fs::remove_file(&active_copy);
                let _ = symlink(&outside, &active_copy);
                let _ = std::fs::remove_file(&active_copy);
                let _ = symlink(&safe, &active_copy);
            }
        });
        let mut services = ClientServices::new(
            "session".into(),
            workspace.clone(),
            vec![workspace],
            true,
            false,
            false,
            false,
        );
        for _ in 0..3000 {
            if let Ok(value) = services.handle(
                "fs/read_text_file",
                &json!({"sessionId":"session","path":active.join("file")}),
                false,
            ) {
                assert_eq!(value["content"], "safe");
            }
        }
        running.store(false, Ordering::Relaxed);
        worker.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_callbacks_require_grant_and_are_session_scoped() {
        let root = std::env::temp_dir().join(format!("t3-acp-terminal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut services = ClientServices::new(
            "session".into(),
            root.clone(),
            vec![root.clone()],
            false,
            false,
            true,
            true,
        );
        let create = json!({"sessionId":"session","command":"printf hello"});
        assert!(services.handle("terminal/create", &create, false).is_err());
        assert!(!services.has_execute_grant());
        services.grant_execute(false);
        assert!(services.has_execute_grant());
        services.begin_turn();
        assert!(!services.has_execute_grant());
        services.grant_execute(true);
        services.begin_turn();
        assert!(services.has_execute_grant());
        let id = services.handle("terminal/create", &create, true).unwrap()["terminalId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(services
            .handle(
                "terminal/output",
                &json!({"sessionId":"other","terminalId":id}),
                true
            )
            .is_err());
        let exit = services
            .handle(
                "terminal/wait_for_exit",
                &json!({"sessionId":"session","terminalId":id}),
                true,
            )
            .unwrap();
        assert_eq!(exit["exitCode"], 0);
        let mut output = Value::Null;
        for _ in 0..100 {
            output = services
                .handle(
                    "terminal/output",
                    &json!({"sessionId":"session","terminalId":id}),
                    true,
                )
                .unwrap();
            if output["output"] == "hello" {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(output["output"], "hello");
        services
            .handle(
                "terminal/release",
                &json!({"sessionId":"session","terminalId":id}),
                true,
            )
            .unwrap();
        assert!(services
            .handle(
                "terminal/output",
                &json!({"sessionId":"session","terminalId":id}),
                true
            )
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
