//! In-memory tracked project cloning with isolated temporary checkouts.
#[cfg(windows)]
#[path = "windows_clone_io.rs"]
mod windows_clone_io;
use crate::event_bus::EventBus;
#[cfg(any(unix, windows))]
use crate::{project_commands::CreateProject, project_sink};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::io::AsyncReadExt;
struct Entry {
    snapshot: Value,
    remote: String,
    fallback: Option<String>,
    cancel: tokio::sync::watch::Sender<bool>,
    generation: u64,
}
#[derive(Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    sequence: u64,
}
pub(crate) struct Tracker {
    state: Mutex<State>,
    updates: tokio::sync::watch::Sender<Vec<Value>>,
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn err(detail: &str) -> Value {
    json!({"_tag":"SourceControlRepositoryError","provider":"unknown","operation":"cloneRepository","detail":detail})
}
#[cfg(unix)]
fn same_directory(handle: &std::fs::File, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(expected) = handle.metadata() else {
        return false;
    };
    let Ok(actual) = std::fs::symlink_metadata(path) else {
        return false;
    };
    actual.is_dir() && expected.dev() == actual.dev() && expected.ino() == actual.ino()
}
#[cfg(windows)]
fn open_staging_directory(path: &Path) -> std::io::Result<std::fs::File> {
    windows_clone_io::open_directory_no_reparse(path)
}
#[cfg(not(windows))]
fn open_staging_directory(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}
#[cfg(windows)]
fn same_directory(handle: &std::fs::File, path: &Path) -> bool {
    windows_clone_io::same_directory(handle, path)
}
#[cfg(not(any(unix, windows)))]
fn same_directory(_handle: &std::fs::File, _path: &Path) -> bool {
    false
}
#[cfg(unix)]
fn install_checkout(
    handle: &std::fs::File,
    staging: &Path,
    dest: &Path,
    cancelled: &impl Fn() -> bool,
) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    fn copy_dir(
        src: &std::fs::File,
        dst: &std::fs::File,
        device: u64,
        cancelled: &impl Fn() -> bool,
    ) -> std::io::Result<()> {
        let dot = c".";
        let fd = unsafe {
            libc::openat(
                src.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe { libc::close(fd) };
            return Err(std::io::Error::last_os_error());
        }
        struct Close(*mut libc::DIR);
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let _close = Close(stream);
        loop {
            if cancelled() {
                return Err(std::io::Error::other("clone cancelled"));
            }
            let item = unsafe { libc::readdir(stream) };
            if item.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name = CString::new(name.to_bytes())
                .map_err(|_| std::io::Error::other("invalid filename"))?;
            let mut info: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    src.as_raw_fd(),
                    name.as_ptr(),
                    &mut info,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if info.st_dev as u64 != device {
                return Err(std::io::Error::other("refusing mounted entry"));
            }
            let kind = info.st_mode & libc::S_IFMT;
            if kind == libc::S_IFDIR {
                let source = unsafe {
                    libc::openat(
                        src.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    )
                };
                if source < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let source = unsafe { std::fs::File::from_raw_fd(source) };
                let meta = source.metadata()?;
                if meta.ino() != info.st_ino as u64 || meta.dev() != device {
                    return Err(std::io::Error::other("source changed"));
                }
                if unsafe { libc::mkdirat(dst.as_raw_fd(), name.as_ptr(), info.st_mode & 0o777) }
                    != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let target = unsafe {
                    libc::openat(
                        dst.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    )
                };
                if target < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let target = unsafe { std::fs::File::from_raw_fd(target) };
                copy_dir(&source, &target, device, cancelled)?;
            } else if kind == libc::S_IFREG {
                let source = unsafe {
                    libc::openat(
                        src.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                    )
                };
                if source < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut source = unsafe { std::fs::File::from_raw_fd(source) };
                let meta = source.metadata()?;
                if !meta.is_file() || meta.ino() != info.st_ino as u64 || meta.dev() != device {
                    return Err(std::io::Error::other("source changed"));
                }
                let target = unsafe {
                    libc::openat(
                        dst.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_CLOEXEC
                            | libc::O_NOFOLLOW,
                        (info.st_mode & 0o777) as libc::c_uint,
                    )
                };
                if target < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut target = unsafe { std::fs::File::from_raw_fd(target) };
                use std::io::{Read, Write};
                let mut buffer = [0u8; 65536];
                loop {
                    if cancelled() {
                        return Err(std::io::Error::other("clone cancelled"));
                    }
                    let n = source.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    target.write_all(&buffer[..n])?;
                }
                #[allow(clippy::unnecessary_cast)]
                let mode = (info.st_mode & 0o777) as u32;
                target.set_permissions(std::fs::Permissions::from_mode(mode))?;
            } else if kind == libc::S_IFLNK {
                let mut target = vec![0u8; 65536];
                let n = unsafe {
                    libc::readlinkat(
                        src.as_raw_fd(),
                        name.as_ptr(),
                        target.as_mut_ptr().cast(),
                        target.len(),
                    )
                };
                if n < 0 || n as usize == target.len() {
                    return Err(std::io::Error::other("invalid symlink"));
                }
                target.truncate(n as usize);
                let target =
                    CString::new(target).map_err(|_| std::io::Error::other("invalid symlink"))?;
                if unsafe { libc::symlinkat(target.as_ptr(), dst.as_raw_fd(), name.as_ptr()) } != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            } else {
                return Err(std::io::Error::other("unsupported checkout entry"));
            }
        }
        Ok(())
    }
    if !same_directory(handle, staging) {
        return false;
    }
    let target = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dest)
    {
        Ok(v) => v,
        Err(_) => return false,
    };
    if !same_directory(&target, dest) {
        return false;
    }
    let empty = std::fs::read_dir(dest).is_ok_and(|mut it| it.next().is_none());
    if !empty {
        return false;
    }
    let Ok(meta) = handle.metadata() else {
        return false;
    };
    copy_dir(handle, &target, meta.dev(), cancelled).is_ok()
        && same_directory(handle, staging)
        && same_directory(&target, dest)
}
#[cfg(windows)]
fn install_checkout(
    handle: &std::fs::File,
    staging: &Path,
    dest: &Path,
    cancelled: &impl Fn() -> bool,
) -> bool {
    windows_clone_io::install_checkout(handle, staging, dest, cancelled)
}
#[cfg(not(any(unix, windows)))]
fn install_checkout(
    _handle: &std::fs::File,
    _staging: &Path,
    _dest: &Path,
    _cancelled: &impl Fn() -> bool,
) -> bool {
    false
}
#[cfg(unix)]
fn remove_owned(handle: &std::fs::File, staging: &Path) {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    fn clear(dir: &std::fs::File, device: u64) -> std::io::Result<()> {
        use std::ffi::{CStr, CString};
        let dup = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if dup < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(dup) };
        if stream.is_null() {
            unsafe { libc::close(dup) };
            return Err(std::io::Error::last_os_error());
        }
        struct Close(*mut libc::DIR);
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let _close = Close(stream);
        loop {
            let item = unsafe { libc::readdir(stream) };
            if item.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name = CString::new(name.to_bytes())
                .map_err(|_| std::io::Error::other("invalid filename"))?;
            let fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if fd >= 0 {
                let child = unsafe { std::fs::File::from_raw_fd(fd) };
                let meta = child.metadata()?;
                if meta.dev() != device {
                    return Err(std::io::Error::other("refusing mounted directory"));
                }
                clear(&child, device)?;
                let mut current: libc::stat = unsafe { std::mem::zeroed() };
                if unsafe {
                    libc::fstatat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        &mut current,
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                    || current.st_dev as u64 != meta.dev()
                    || current.st_ino as u64 != meta.ino()
                {
                    return Err(std::io::Error::other("directory changed"));
                }
                // Keep directory entries: Unix cannot atomically unlink a name
                // only if it still refers to the inode we inspected.
            } else if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
    if !same_directory(handle, staging) {
        return;
    }
    let Ok(meta) = handle.metadata() else { return };
    let _ = clear(handle, meta.dev());
}
#[cfg(windows)]
fn remove_owned(handle: &std::fs::File, staging: &Path) {
    windows_clone_io::remove_owned(handle, staging);
}
#[cfg(not(any(unix, windows)))]
fn remove_owned(_handle: &std::fs::File, _staging: &Path) {}
impl Tracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            updates: tokio::sync::watch::channel(Vec::new()).0,
        })
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Vec<Value>> {
        self.updates.subscribe()
    }
    fn publish(&self, state: &State) {
        self.updates
            .send_replace(state.entries.values().map(|e| e.snapshot.clone()).collect());
    }
    pub fn blocked(&self, id: &str) -> Option<String> {
        let state = self.state.lock().ok()?;
        let entry = state.entries.get(id)?;
        match entry.snapshot["phase"].as_str() {
            Some("running") => Some("The repository is still being cloned.".into()),
            Some("failed" | "cancelled") => {
                Some("The repository was not cloned. Retry the clone first.".into())
            }
            _ => None,
        }
    }
    #[cfg(any(unix, windows))]
    pub fn start(
        self: &Arc<Self>,
        bus: &EventBus,
        input: &Value,
        settings: Option<&crate::settings::Settings>,
    ) -> Result<Value, Value> {
        let id = input["projectId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| err("Invalid project ID."))?
            .to_owned();
        let title = input["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| err("Invalid title."))?;
        if input["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_none()
        {
            return Err(err("Invalid creation time."));
        }
        let dest = crate::source_control_clone::destination(
            input["destinationPath"].as_str().unwrap_or(""),
        )?;
        match std::fs::read_dir(&dest) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Err(err("Destination path already exists and is not empty."));
                }
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(err(
                    "Destination path already exists and is not a directory.",
                ))
            }
            _ => (),
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| err("The destination path is unavailable."))?;
        }
        let (remote, repository) =
            crate::source_control_clone::resolve_remote(input, &dest, settings)?;
        let path = dest.to_string_lossy().into_owned();
        let fallback =
            crate::source_control_clone::https_fallback(&remote, &Value::Null, &input["protocol"]);
        let safe = crate::source_control_clone::redact(&remote);
        let mut state = self
            .state
            .lock()
            .map_err(|_| err("Clone tracker unavailable."))?;
        if state.entries.contains_key(&id)
            || state
                .entries
                .values()
                .any(|e| e.snapshot["destinationPath"] == path)
        {
            return Err(err("A clone into this destination is already in progress."));
        }
        std::fs::create_dir_all(&dest).map_err(|_| err("The destination path is unavailable."))?;
        let command = format!("project-clone-create:{id}");
        let at = now();
        let result = project_sink::create_project_ordered(
            bus,
            CreateProject {
                command_id: &command,
                project_id: &id,
                title,
                workspace_root: &path,
                scripts: None,
            },
            &uuid::Uuid::new_v4().to_string(),
            &at,
        )
        .map_err(|_| err("Failed to create clone project."))?;
        let project_id = if result.receipt.status == "accepted" {
            id
        } else {
            bus.with_autocommit(|db|{use rusqlite::OptionalExtension;db.query_row("SELECT project_id FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL",[&path],|r|r.get::<_,String>(0)).optional()}).ok().and_then(Result::ok).flatten().ok_or_else(||err("Failed to create clone project."))?
        };
        if state.entries.contains_key(&project_id) {
            return Err(err("A clone into this destination is already in progress."));
        }
        state.sequence += 1;
        let generation = state.sequence;
        let (cancel, _) = tokio::sync::watch::channel(false);
        let snapshot = json!({"projectId":project_id,"remoteUrl":safe,"destinationPath":path,"repository":repository,"phase":"running","stage":"connecting","percent":null,"detail":null,"stalled":false,"error":null,"startedAt":at,"endedAt":null,"sequence":generation});
        state.entries.insert(
            project_id.clone(),
            Entry {
                snapshot,
                remote,
                fallback,
                cancel,
                generation,
            },
        );
        self.publish(&state);
        drop(state);
        self.launch(project_id.clone());
        Ok(json!({"projectId":project_id,"cwd":path,"remoteUrl":safe,"repository":repository}))
    }
    #[cfg(not(any(unix, windows)))]
    pub fn start(
        self: &Arc<Self>,
        _bus: &EventBus,
        _input: &Value,
        _settings: Option<&crate::settings::Settings>,
    ) -> Result<Value, Value> {
        Err(err("Tracked cloning is unavailable on this platform."))
    }
    fn change<F>(&self, id: &str, generation: u64, mutate: F)
    where
        F: FnOnce(&mut Value),
    {
        if let Ok(mut state) = self.state.lock() {
            if state
                .entries
                .get(id)
                .is_none_or(|e| e.generation != generation)
            {
                return;
            }
            state.sequence += 1;
            let sequence = state.sequence;
            let entry = state.entries.get_mut(id).unwrap();
            mutate(&mut entry.snapshot);
            entry.snapshot["sequence"] = json!(sequence);
            self.publish(&state);
        }
    }
    fn launch(self: &Arc<Self>, id: String) {
        let (remote, fallback, dest, mut cancel, generation) = {
            let s = self.state.lock().unwrap();
            let e = &s.entries[&id];
            (
                e.remote.clone(),
                e.fallback.clone(),
                PathBuf::from(e.snapshot["destinationPath"].as_str().unwrap()),
                e.cancel.subscribe(),
                e.generation,
            )
        };
        let tracker = self.clone();
        tokio::spawn(async move {
            let Some(parent) = dest.parent() else { return };
            let mut current_remote = remote;
            let mut fallback = fallback;
            loop {
                let staging = parent.join(format!(".t3-clone-{}", uuid::Uuid::new_v4()));
                if std::fs::create_dir(&staging).is_err() {
                    tracker.finish(
                        &id,
                        generation,
                        "failed",
                        Some("The repository could not be cloned."),
                    );
                    return;
                }
                let owned = match open_staging_directory(&staging) {
                    Ok(v) if same_directory(&v, &staging) => v,
                    _ => {
                        tracker.finish(
                            &id,
                            generation,
                            "failed",
                            Some("The repository could not be cloned."),
                        );
                        return;
                    }
                };
                let mut command = tokio::process::Command::new("git");
                command
                    .current_dir(parent)
                    .args(["clone", "--progress", "--", &current_remote])
                    .arg(&staging)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .env("GIT_PROGRESS_DELAY", "0")
                    .env("LANGUAGE", "C")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                #[cfg(unix)]
                {
                    command.process_group(0);
                }
                let mut child = match command.spawn() {
                    Ok(c) => c,
                    Err(_) => {
                        remove_owned(&owned, &staging);
                        tracker.finish(
                            &id,
                            generation,
                            "failed",
                            Some("The repository could not be cloned."),
                        );
                        return;
                    }
                };
                let mut stderr = child.stderr.take();
                let mut buf = [0u8; 4096];
                let mut pending = Vec::new();
                let mut diagnostics = Vec::new();
                let mut was_cancelled = false;
                let stall = tokio::time::sleep(std::time::Duration::from_secs(20));
                tokio::pin!(stall);
                let mut stalled = false;
                let status = loop {
                    tokio::select! {changed=cancel.changed()=>{if changed.is_err()||*cancel.borrow(){was_cancelled=true;#[cfg(unix)] if let Some(pid)=child.id(){unsafe{libc::kill(-(pid as i32),libc::SIGKILL);}}#[cfg(windows)] if let Some(pid)=child.id(){let _=tokio::process::Command::new("taskkill").args(["/F","/T","/PID",&pid.to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await;}let _=child.kill().await;break child.wait().await.ok()}},read=async{match &mut stderr{Some(s)=>s.read(&mut buf).await,None=>std::future::pending().await}}=>{match read{Ok(0)=>stderr=None,Ok(n)=>{if diagnostics.len()<65536 { let take = n.min(65536-diagnostics.len()); diagnostics.extend_from_slice(&buf[..take]); }
                    if stalled{tracker.change(&id,generation,|s|s["stalled"]=json!(false));stalled=false;}stall.as_mut().reset(tokio::time::Instant::now()+std::time::Duration::from_secs(20));for b in &buf[..n]{if *b==b'\n'||*b==b'\r'{if !pending.is_empty(){let line=String::from_utf8_lossy(&pending).to_string();tracker.progress(&id,generation,&line);pending.clear();}}else if pending.len()<4096{pending.push(*b);}}},Err(_)=>stderr=None}},_= &mut stall, if !stalled =>{stalled=true;tracker.change(&id,generation,|s|s["stalled"]=json!(true));},result=child.wait()=>break result.ok()}
                };
                if *cancel.borrow() {
                    was_cancelled = true;
                }
                if was_cancelled {
                    remove_owned(&owned, &staging);
                    tracker.finish(&id, generation, "cancelled", None);
                    return;
                }
                if !status.as_ref().is_some_and(|s| s.success()) {
                    if let Some(stream) = stderr.take() {
                        let mut remaining = Vec::new();
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(1),
                            stream.take(65536).read_to_end(&mut remaining),
                        )
                        .await;
                        diagnostics.extend_from_slice(&remaining);
                    }
                    if crate::source_control_clone::ssh_auth_rejected(&diagnostics) {
                        if let Some(next_remote) = fallback.take() {
                            remove_owned(&owned, &staging);
                            current_remote = next_remote;
                            continue;
                        }
                    }
                }
                let cancel_copy = cancel.clone();
                let staging_copy = staging.clone();
                let dest_copy = dest.clone();
                let installed = tokio::task::spawn_blocking(move || {
                    let installed = status.is_some_and(|s| s.success())
                        && install_checkout(&owned, &staging_copy, &dest_copy, &|| {
                            *cancel_copy.borrow()
                        });
                    remove_owned(&owned, &staging_copy);
                    installed
                })
                .await
                .unwrap_or(false);
                if installed {
                    tracker.finish(&id, generation, "done", None);
                    let tracker2 = tracker.clone();
                    let id2 = id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        if let Ok(mut state) = tracker2.state.lock() {
                            if state.entries.get(&id2).is_some_and(|e| {
                                e.generation == generation && e.snapshot["phase"] == "done"
                            }) {
                                state.entries.remove(&id2);
                                tracker2.publish(&state);
                            }
                        }
                    });
                } else if *cancel.borrow() {
                    tracker.finish(&id, generation, "cancelled", None);
                } else {
                    tracker.finish(
                        &id,
                        generation,
                        "failed",
                        Some("The repository could not be cloned."),
                    );
                }
                break;
            }
        });
    }
    fn progress(&self, id: &str, generation: u64, line: &str) {
        let line = line.trim();
        let stage = if line.starts_with("remote: Enumerating objects")
            || line.starts_with("remote: Counting objects")
            || line.starts_with("remote: Compressing objects")
        {
            Some("counting")
        } else if line.starts_with("Receiving objects") {
            Some("receiving")
        } else if line.starts_with("Resolving deltas") {
            Some("resolving")
        } else if line.starts_with("Updating files") || line.starts_with("Checking out files") {
            Some("checkout")
        } else {
            None
        };
        if let Some(stage) = stage {
            static PERCENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let captures = PERCENT
                .get_or_init(|| regex::Regex::new(r":\s+(\d+)%\s+\(\d+/\d+\)(.*)$").unwrap())
                .captures(line);
            let percent = captures
                .as_ref()
                .and_then(|c| c[1].parse::<u64>().ok())
                .map(|n| n.min(100));
            let detail = captures.as_ref().and_then(|c| {
                let tail = c
                    .get(2)?
                    .as_str()
                    .trim_end()
                    .strip_suffix(", done.")
                    .unwrap_or(c.get(2)?.as_str().trim_end())
                    .trim();
                let tail = tail.strip_prefix(',')?.trim();
                if tail.is_empty() || tail == "done." || tail.contains("://") {
                    None
                } else {
                    Some(tail.chars().take(200).collect::<String>())
                }
            });
            self.change(id, generation, |s| {
                s["stage"] = json!(stage);
                s["percent"] = json!(percent);
                s["detail"] = json!(detail);
                s["stalled"] = json!(false)
            });
        }
    }
    fn finish(&self, id: &str, generation: u64, phase: &str, error: Option<&str>) {
        self.change(id, generation, |s| {
            s["phase"] = json!(phase);
            s["error"] = json!(error);
            s["endedAt"] = json!(now());
            s["stalled"] = json!(false);
            if phase == "done" {
                s["percent"] = json!(100)
            }
        })
    }
    pub async fn cancel(&self, id: &str) -> bool {
        let mut updates = self.subscribe();
        {
            let state = match self.state.lock() {
                Ok(s) => s,
                Err(_) => return false,
            };
            let Some(entry) = state.entries.get(id) else {
                return false;
            };
            if entry.snapshot["phase"] != "running" {
                return false;
            }
            entry.cancel.send_replace(true);
        }
        loop {
            if updates
                .borrow_and_update()
                .iter()
                .find(|s| s["projectId"] == id)
                .is_none_or(|s| s["phase"] != "running")
            {
                break;
            }
            if updates.changed().await.is_err() {
                break;
            }
        }
        true
    }
    pub fn retry(self: &Arc<Self>, id: &str) -> bool {
        let mut state = match self.state.lock() {
            Ok(s) => s,
            Err(_) => return false,
        };
        if state
            .entries
            .get(id)
            .is_none_or(|e| !matches!(e.snapshot["phase"].as_str(), Some("failed" | "cancelled")))
        {
            return false;
        }
        state.sequence += 1;
        let generation = state.sequence;
        let e = state.entries.get_mut(id).unwrap();
        let (cancel, _) = tokio::sync::watch::channel(false);
        e.cancel = cancel;
        e.generation = generation;
        e.snapshot["phase"] = json!("running");
        e.snapshot["stage"] = json!("connecting");
        e.snapshot["percent"] = Value::Null;
        e.snapshot["detail"] = Value::Null;
        e.snapshot["error"] = Value::Null;
        e.snapshot["stalled"] = json!(false);
        e.snapshot["startedAt"] = json!(now());
        e.snapshot["endedAt"] = Value::Null;
        e.snapshot["sequence"] = json!(generation);
        self.publish(&state);
        drop(state);
        self.launch(id.to_owned());
        true
    }
    pub async fn discard(&self, id: &str) {
        self.cancel(id).await;
        if let Ok(mut state) = self.state.lock() {
            if state.entries.remove(id).is_some() {
                self.publish(&state);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn replaced_staging_and_nonempty_destination_are_preserved() {
        let root =
            std::env::temp_dir().join(format!("t3-clone-ownership-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let staging = root.join("staging");
        let original = root.join("original");
        let dest = root.join("destination");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(&dest).unwrap();
        let owned = std::fs::File::open(&staging).unwrap();
        std::fs::rename(&staging, &original).unwrap();
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(staging.join("user-data"), "preserve").unwrap();
        assert!(!install_checkout(&owned, &staging, &dest, &|| false));
        remove_owned(&owned, &staging);
        assert_eq!(
            std::fs::read_to_string(staging.join("user-data")).unwrap(),
            "preserve"
        );
        assert!(dest.is_dir());
        let current = std::fs::File::open(&staging).unwrap();
        std::fs::write(dest.join("keep"), "destination").unwrap();
        assert!(!install_checkout(&current, &staging, &dest, &|| false));
        assert_eq!(
            std::fs::read_to_string(dest.join("keep")).unwrap(),
            "destination"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cleanup_stays_within_owned_directory_and_does_not_follow_links() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("t3-clone-cleanup-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let outside = root.join("outside");
        std::fs::create_dir_all(staging.join("nested")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(staging.join("nested/file"), "temporary").unwrap();
        std::fs::write(outside.join("keep"), "preserve").unwrap();
        symlink(&outside, staging.join("outside-link")).unwrap();
        let owned = std::fs::File::open(&staging).unwrap();
        remove_owned(&owned, &staging);
        assert!(staging.is_dir());
        assert!(!staging.join("nested/file").exists());
        assert!(!staging.join("outside-link").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("keep")).unwrap(),
            "preserve"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn install_preserves_executable_and_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!("t3-clone-install-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let dest = root.join("destination");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(staging.join("run"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(staging.join("run"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        symlink("run", staging.join("link")).unwrap();
        let owned = std::fs::File::open(&staging).unwrap();
        assert!(install_checkout(&owned, &staging, &dest, &|| false));
        assert_eq!(
            std::fs::metadata(dest.join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            std::fs::read_link(dest.join("link")).unwrap(),
            PathBuf::from("run")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_install_preserves_partial_and_independent_files() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = std::env::temp_dir().join(format!("t3-clone-cancel-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let dest = root.join("destination");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(staging.join("file"), vec![3u8; 131072]).unwrap();
        let owned = std::fs::File::open(&staging).unwrap();
        let checks = AtomicUsize::new(0);
        let cancelled = || {
            let n = checks.fetch_add(1, Ordering::Relaxed);
            if n == 2 {
                std::fs::write(dest.join("independent"), "keep").unwrap();
            }
            n >= 2
        };
        assert!(!install_checkout(&owned, &staging, &dest, &cancelled));
        assert!(dest.join("file").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("independent")).unwrap(),
            "keep"
        );
        std::fs::remove_file(dest.join("independent")).unwrap();
        assert!(!install_checkout(&owned, &staging, &dest, &|| false));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn install_and_cleanup_a_git_checkout() {
        let root = std::env::temp_dir().join(format!("t3-clone-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.git");
        assert!(std::process::Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let staging = root.join("staging");
        let dest = root.join("destination");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(&dest).unwrap();
        let owned = std::fs::File::open(&staging).unwrap();
        assert!(std::process::Command::new("git")
            .args(["clone", "-q", "--"])
            .arg(&source)
            .arg(&staging)
            .status()
            .unwrap()
            .success());
        assert!(install_checkout(&owned, &staging, &dest, &|| false));
        remove_owned(&owned, &staging);
        assert!(!staging.join(".git/config").exists());
        assert!(dest.join(".git").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tracked_clone_publishes_completion() {
        let root = std::env::temp_dir().join(format!("t3-clone-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.git");
        let dest = root.join("dest");
        assert!(std::process::Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let tracker = Tracker::new();
        let mut events = tracker.subscribe();
        tracker.start(&bus,&json!({"projectId":"p","title":"Clone","createdAt":"2026-01-01T00:00:00Z","remoteUrl":source,"destinationPath":dest}), None).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if events
                    .borrow_and_update()
                    .iter()
                    .any(|v| v["phase"] == "done")
                {
                    break;
                }
                events.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(dest.join(".git").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, not(any(unix, windows))))]
mod non_unix_tests {
    #[test]
    fn tracked_clone_fails_closed_before_creating_a_project() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 8);
        let tracker = super::Tracker::new();
        assert!(tracker.start(&bus, &serde_json::json!({}), None).is_err());
    }
}
