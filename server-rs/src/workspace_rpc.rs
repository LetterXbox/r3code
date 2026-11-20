//! Filesystem RPCs used by the project picker and file browser.
use crate::http_server::RpcFailure;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

// Resolve each component from an already-open directory. This prevents an
// ancestor replaced by a symlink after canonicalization from redirecting a write.
#[cfg(unix)]
fn open_workspace_output(root: &Path, target: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    let relative = target.strip_prefix(root).map_err(std::io::Error::other)?;
    let components: Vec<_> = relative.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(std::io::Error::other("invalid workspace path"));
    }
    let mut dir = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    for component in &components[..components.len() - 1] {
        let name = CString::new(component.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
        let mut fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            let created = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o777) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(std::io::Error::last_os_error());
            }
            fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { fs::File::from_raw_fd(fd) };
    }
    let name = CString::new(components.last().unwrap().as_os_str().as_bytes())
        .map_err(std::io::Error::other)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o666,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(std::io::Error::other(
            "workspace target must be a regular file with one link",
        ));
    }
    file.set_len(0)?;
    use std::io::Write;
    file.write_all(contents)?;
    Ok(())
}

pub fn handles(tag: &str) -> bool {
    matches!(
        tag,
        "filesystem.browse"
            | "filesystem.getMetadata"
            | "projects.readFile"
            | "projects.listEntries"
            | "projects.listIgnoredFiles"
            | "projects.searchEntries"
            | "projects.searchContents"
    )
}

fn list_ignored_files(v: &Value) -> Result<Value, RpcFailure> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let cwd = field(v, "cwd")?;
    let query = match v.get("query") {
        None => "",
        Some(Value::String(s)) if s.encode_utf16().count() <= 256 => s.trim(),
        _ => return Err(invalid()),
    }
    .to_lowercase();
    let root = fs::canonicalize(expand(cwd)).map_err(|_| {
        err(
            "ProjectListEntriesError",
            "Failed to list workspace entries.",
            "workspace_root_not_found",
        )
    })?;
    let empty = || json!({"files":[],"truncated":false});
    let Ok(mut child) = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Ok(empty());
    };
    let Some(stdout) = child.stdout.take() else {
        return Ok(empty());
    };
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Ok(Ok(bytes)) = reader.join() else {
        return Ok(empty());
    };
    if !status.is_some_and(|s| s.success()) || bytes.len() > 4 * 1024 * 1024 {
        return Ok(empty());
    }
    let mut paths: Vec<String> = bytes
        .split(|b| *b == 0)
        .filter_map(|b| std::str::from_utf8(b).ok())
        .filter(|p| !p.is_empty() && !p.ends_with('/') && p.to_lowercase().contains(&query))
        .map(str::to_owned)
        .collect();
    paths.sort();
    let truncated = paths.len() > 200;
    let files: Vec<Value> = paths
        .into_iter()
        .take(200)
        .filter_map(|path| {
            let meta = fs::symlink_metadata(root.join(&path)).ok()?;
            meta.is_file()
                .then(|| json!({"path":path,"byteLength":meta.len()}))
        })
        .collect();
    Ok(json!({"files":files,"truncated":truncated}))
}

fn search_contents(v: &Value) -> Result<Value, RpcFailure> {
    use std::io::BufRead;
    use std::time::{Duration, Instant};

    let cwd = field(v, "cwd")?;
    let query = v
        .get("query")
        .and_then(Value::as_str)
        .filter(|q| !q.is_empty() && q.encode_utf16().count() <= 256)
        .ok_or_else(invalid)?;
    let limit = v
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|n| (1..=500).contains(n))
        .ok_or_else(invalid)? as usize;
    let case_sensitive = v
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let whole_word = v
        .get("wholeWord")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let use_regex = v
        .get("useRegex")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let fail = || {
        err(
            "ProjectSearchContentsError",
            "Failed to search workspace contents.",
            "search_index_create_failed",
        )
    };
    let root = fs::canonicalize(expand(cwd)).map_err(|_| fail())?;
    if !root.is_dir() {
        return Err(fail());
    }
    let make_pattern = |pattern: &str| {
        regex::RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .build()
    };
    let mut fallback = None;
    let matcher = if use_regex {
        match make_pattern(query) {
            Ok(regex) => regex,
            Err(error) => {
                fallback = Some(error.to_string());
                make_pattern(&regex::escape(query)).map_err(|_| invalid())?
            }
        }
    } else {
        make_pattern(&regex::escape(query)).map_err(|_| invalid())?
    };
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let word =
        WORD.get_or_init(|| regex::Regex::new(r"^[\p{Letter}\p{Mark}\p{Number}_]$").unwrap());
    let is_word = |c: Option<char>| c.is_some_and(|c| word.is_match(c.encode_utf8(&mut [0; 4])));
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut walker = ignore::WalkBuilder::new(&root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false);
    let mut matches = Vec::new();
    let mut truncated = false;
    'files: for entry in walker.build().flatten().skip(1) {
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(path) = entry.path().strip_prefix(&root) else {
            continue;
        };
        if path.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let Ok(file) = fs::File::open(entry.path()) else {
            continue;
        };
        let mut file_matches = 0;
        for (index, line) in std::io::BufReader::new(file).lines().enumerate() {
            if Instant::now() >= deadline {
                truncated = true;
                break 'files;
            }
            let Ok(line) = line else { break };
            if line.contains('\0') {
                break;
            }
            let mut ranges = Vec::new();
            for found in matcher.find_iter(&line) {
                if whole_word
                    && (found.is_empty()
                        || (is_word(line[..found.start()].chars().next_back())
                            && is_word(line[found.start()..].chars().next()))
                        || (is_word(line[..found.end()].chars().next_back())
                            && is_word(line[found.end()..].chars().next())))
                {
                    continue;
                }
                if line[..found.end()].chars().count() <= 512 {
                    ranges.push(json!({"start":line[..found.start()].encode_utf16().count(),"end":line[..found.end()].encode_utf16().count()}));
                }
            }
            if ranges.is_empty() && (whole_word || !matcher.is_match(&line)) {
                continue;
            }
            if matches.len() == limit {
                truncated = true;
                break 'files;
            }
            let content: String = line.chars().take(512).collect();
            matches.push(json!({"path":path.to_string_lossy(),"lineNumber":index + 1,"lineContent":content,"matchRanges":ranges}));
            file_matches += 1;
            if file_matches >= 100 {
                break;
            }
        }
    }
    let mut result = json!({"matches":matches,"truncated":truncated});
    if let Some(error) = fallback {
        result["regexFallbackError"] = json!(error);
    }
    Ok(result)
}
fn invalid() -> RpcFailure {
    RpcFailure::Die(json!({"name":"Error","message":"Invalid RPC payload"}))
}
fn field<'a>(v: &'a Value, name: &str) -> Result<&'a str, RpcFailure> {
    v.get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 512)
        .ok_or_else(invalid)
}
fn expand(s: &str) -> PathBuf {
    if s == "~" || s.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(s.strip_prefix("~/").unwrap_or(""));
        }
    }
    PathBuf::from(s)
}
fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_owned()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    }
}
fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in p.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            x => out.push(x.as_os_str()),
        }
    }
    out
}
pub(crate) fn internal(path: &Path, state: &Path) -> bool {
    let state = fs::canonicalize(state).unwrap_or_else(|_| state.to_owned());
    path.starts_with(state.join("secrets"))
        || path.starts_with("/dev/fd")
        || (path.parent() == Some(state.as_path())
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().contains(".sqlite")))
}
fn err(tag: &str, msg: &str, reason: &str) -> RpcFailure {
    RpcFailure::Fail(json!({"_tag": tag,"message":msg,"failure":reason}))
}
fn browse(v: &Value) -> Result<Value, RpcFailure> {
    let p = field(v, "partialPath")?;
    let cwd = v.get("cwd").and_then(Value::as_str);
    let fail = |reason| {
        err(
            "FilesystemBrowseError",
            "Failed to browse filesystem path.",
            reason,
        )
    };
    if cfg!(not(windows))
        && (p.starts_with("\\\\")
            || (p.len() >= 3 && p.as_bytes()[1] == b':' && matches!(p.as_bytes()[2], b'/' | b'\\')))
    {
        return Err(fail("windows_path_unsupported"));
    }
    let relative = p == "." || p == ".." || p.starts_with("./") || p.starts_with("../");
    let resolved = if relative {
        clean(
            &absolute(&expand(
                cwd.ok_or_else(|| fail("current_project_required"))?,
            ))
            .join(p),
        )
    } else {
        clean(&absolute(&expand(p)))
    };
    let trailing = p.ends_with('/') || p.ends_with('\\') || p == "~";
    let parent = if trailing {
        resolved.as_path()
    } else {
        resolved.parent().unwrap_or(Path::new("/"))
    };
    let prefix = if trailing {
        String::new()
    } else {
        resolved
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    };
    let mut entries = Vec::new();
    match fs::read_dir(parent) {
        Ok(dir) => {
            for entry in dir.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().is_ok_and(|t| t.is_dir())
                    && name.to_lowercase().starts_with(&prefix)
                    && (trailing || prefix.starts_with('.') || !name.starts_with('.'))
                {
                    entries.push(json!({"name":name,"fullPath":entry.path().to_string_lossy()}));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(_) => return Err(fail("read_directory_failed")),
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({"parentPath":parent.to_string_lossy(),"entries":entries}))
}
fn read(v: &Value, state: &Path) -> Result<Value, RpcFailure> {
    let cwd = field(v, "cwd")?;
    let requested = field(v, "relativePath")?;
    let fail = |reason| {
        err(
            "ProjectReadFileError",
            &format!("Failed to read workspace file '{requested}' in '{cwd}'."),
            reason,
        )
    };
    let path = expand(requested);
    let normalized_relative = clean(&path).to_string_lossy().into_owned();
    let is_absolute = path.is_absolute();
    if requested.starts_with("//") {
        return Err(fail("workspace_path_outside_root"));
    }
    let target = if is_absolute {
        path
    } else {
        let root = fs::canonicalize(expand(cwd)).map_err(|_| fail("operation_failed"))?;
        let lexical = clean(&root.join(&path));
        if lexical == root || !lexical.starts_with(&root) {
            return Err(fail("workspace_path_outside_root"));
        }
        let mut ancestor = lexical.as_path();
        loop {
            match fs::canonicalize(ancestor) {
                Ok(real) => {
                    if !real.starts_with(&root) {
                        return Err(fail("resolved_path_outside_root"));
                    }
                    break;
                }
                Err(_) if fs::symlink_metadata(ancestor).is_ok() => {
                    return Err(fail("operation_failed"))
                }
                Err(_) => {
                    ancestor = ancestor.parent().ok_or_else(|| fail("operation_failed"))?;
                }
            }
        }
        lexical
    };
    let real = match fs::canonicalize(&target) {
        Ok(p) => p,
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && v.get("allowMissing") == Some(&json!(true)) =>
        {
            return Ok(
                json!({"relativePath":if is_absolute { requested } else { &normalized_relative },"contents":"","byteLength":0,"truncated":false,"exists":false}),
            )
        }
        Err(_) => return Err(fail("operation_failed")),
    };
    if internal(&real, state) {
        return Err(fail("workspace_path_outside_root"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(real).map_err(|_| fail("operation_failed"))?;
    let metadata = file.metadata().map_err(|_| fail("operation_failed"))?;
    if !metadata.is_file() {
        return Err(fail("path_not_file"));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("operation_failed"))?;
    if bytes.contains(&0) {
        return Err(fail("binary_file"));
    }
    let truncated = metadata.len() > 1024 * 1024;
    if truncated {
        if let Err(e) = std::str::from_utf8(&bytes) {
            if e.error_len().is_none() {
                bytes.truncate(e.valid_up_to());
            }
        }
    }
    Ok(
        json!({"relativePath":if is_absolute { requested } else { &normalized_relative },"contents":String::from_utf8_lossy(&bytes),"byteLength":metadata.len(),"truncated":truncated}),
    )
}
/// Write only within a registered project or managed worktree.
pub fn write_file(
    v: &Value,
    state: &Path,
    db: &rusqlite::Connection,
    settings: &Value,
) -> Result<Value, RpcFailure> {
    #[cfg(not(unix))]
    use std::io::Write;
    let cwd = field(v, "cwd")?;
    let requested = field(v, "relativePath")?;
    let contents = v
        .get("contents")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let fail = |reason: &str, message: String, operation: Option<&str>| {
        let mut value = json!({"_tag":"ProjectWriteFileError", "cwd":cwd, "relativePath":requested, "failure":reason, "message":message});
        if let Some(op) = operation {
            value["operation"] = json!(op);
        }
        RpcFailure::Fail(value)
    };
    let default_message = || format!("Failed to write workspace file '{requested}' in '{cwd}'.");
    let operation = |op| fail("operation_failed", default_message(), Some(op));
    let root = fs::canonicalize(absolute(&expand(cwd))).map_err(|_| {
        fail(
            "operation_failed",
            format!(
                "'{cwd}' is not a registered project, a managed worktree, or a thread's worktree."
            ),
            None,
        )
    })?;
    let mut managed = vec![state.join("worktrees")];
    for value in settings.get("worktreesDirectory").into_iter().chain(
        settings
            .get("previousWorktreesDirectories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten(),
    ) {
        if let Some(s) = value.as_str().filter(|s| !s.is_empty()) {
            let p = expand(s);
            if p.is_absolute() {
                managed.push(clean(&p));
            }
        }
    }
    let resolve = |p: &Path| {
        let p = clean(&absolute(p));
        let p = fs::canonicalize(&p).unwrap_or(p);
        (p.parent().is_some()).then_some(p)
    };
    let managed: Vec<_> = managed.iter().filter_map(|p| resolve(p)).collect();
    let mut projects = Vec::<(String, PathBuf)>::new();
    if let Ok(mut stmt) = db.prepare(
        "SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                PathBuf::from(r.get::<_, String>(1)?),
            ))
        }) {
            projects.extend(rows.flatten());
        }
    }
    let mut known = managed.iter().any(|p| root.starts_with(p))
        || projects
            .iter()
            .filter_map(|(_, p)| resolve(p))
            .any(|p| root.starts_with(p));
    if !known {
        if let Ok(mut stmt) = db.prepare("SELECT json_extract(payload_json,'$.worktreePath'), project_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') IS NOT NULL") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (path, id) in rows.flatten() {
                    let path = PathBuf::from(path);
                    if !path.is_absolute() { continue; }
                    let Some(real) = resolve(&path) else { continue; };
                    if !root.starts_with(&real) { continue; }
                    if managed.iter().any(|p| clean(&path).starts_with(p)) { known = true; break; }
                    if let Some((_, project)) = projects.iter().find(|(pid, _)| pid == &id) {
                        if let Ok(output) = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(project).output() {
                            if output.status.success() && String::from_utf8_lossy(&output.stdout).lines().filter_map(|l| l.strip_prefix("worktree ")).filter_map(|p| resolve(Path::new(p))).any(|p| p == real) { known = true; break; }
                        }
                    }
                }
            }
        }
    }
    if !known {
        return Err(fail(
            "operation_failed",
            format!(
                "'{cwd}' is not a registered project, a managed worktree, or a thread's worktree."
            ),
            None,
        ));
    }
    let path = Path::new(requested);
    let named = clean(&root.join(path));
    if path.is_absolute()
        || named == root
        || !named.starts_with(&root)
        || requested.starts_with('~')
        // Drive-relative paths and alternate data streams are not workspace files.
        || (cfg!(windows) && (requested.contains(':') || path.components().any(|c| matches!(c, std::path::Component::Prefix(_) | std::path::Component::RootDir))))
    {
        return Err(fail(
            "workspace_path_outside_root",
            format!("Workspace file path must be relative to the project root: {requested}"),
            None,
        ));
    }
    let relative = named.strip_prefix(&root).unwrap();
    let mut ancestor = named.as_path();
    let real = loop {
        match fs::canonicalize(ancestor) {
            Ok(p) => break p.join(named.strip_prefix(ancestor).unwrap()),
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && fs::symlink_metadata(ancestor)
                        .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| operation("realpath-target"))?;
            }
            Err(_) => return Err(operation("realpath-target")),
        }
    };
    fn in_git(path: &Path) -> std::io::Result<bool> {
        if path.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            let s = s
                .split(':')
                .next()
                .unwrap_or("")
                .trim_end_matches(['.', ' ']);
            s.eq_ignore_ascii_case(".git") || s.eq_ignore_ascii_case("git~1")
        }) {
            return Ok(true);
        }
        let exists = |p: &Path| match fs::symlink_metadata(p) {
            Ok(m) => Ok(Some(m)),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        };
        for dir in path.parent().into_iter().flat_map(Path::ancestors) {
            if exists(&dir.join("HEAD"))?.is_some()
                && (exists(&dir.join("commondir"))?.is_some()
                    || (exists(&dir.join("objects"))?.is_some()
                        && exists(&dir.join("refs"))?.is_some()))
            {
                return Ok(true);
            }
            if exists(&dir.join(".git"))?.is_some_and(|m| m.is_file()) {
                break;
            }
        }
        Ok(false)
    }
    if !real.starts_with(&root)
        || in_git(&real).map_err(|_| operation("stat"))?
        || in_git(&named).map_err(|_| operation("stat"))?
    {
        return Err(fail("resolved_path_outside_root", default_message(), None));
    }
    #[cfg(unix)]
    open_workspace_output(&root, &real, contents.as_bytes())
        .map_err(|_| operation("write-file"))?;
    #[cfg(not(unix))]
    fs::create_dir_all(real.parent().ok_or_else(|| operation("make-directory"))?)
        .map_err(|_| operation("make-directory"))?;
    #[cfg(not(unix))]
    let mut options = fs::OpenOptions::new();
    #[cfg(not(unix))]
    options.write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself, so a final-component link cannot redirect a write.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(not(unix))]
    let mut f = options.open(&real).map_err(|_| operation("write-file"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let metadata = f.metadata().map_err(|_| operation("write-file"))?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(operation("write-file"));
        }
        f.set_len(0).map_err(|_| operation("write-file"))?;
    }
    #[cfg(not(unix))]
    f.write_all(contents.as_bytes())
        .map_err(|_| operation("write-file"))?;
    Ok(json!({"relativePath":relative.to_string_lossy()}))
}
fn entries(v: &Value, search: bool) -> Result<Value, RpcFailure> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let cwd = field(v, "cwd")?;
    let fail = || {
        err(
            "ProjectListEntriesError",
            "Failed to list workspace entries.",
            "directory_list_failed",
        )
    };
    let root = fs::canonicalize(expand(cwd)).map_err(|_| fail())?;
    let directory = if search {
        None
    } else {
        v.get("directoryPath").and_then(Value::as_str)
    };
    let mut result = Vec::new();
    if let Some(directory) = directory {
        let relative = Path::new(directory);
        let target = clean(&root.join(relative));
        let real = fs::canonicalize(&target).map_err(|_| fail())?;
        if !real.starts_with(&root)
            || relative.components().any(|c| c.as_os_str() == ".git")
            || real
                .strip_prefix(&root)
                .unwrap_or(Path::new(""))
                .components()
                .any(|c| c.as_os_str() == ".git")
        {
            return Err(err(
                "ProjectListEntriesError",
                "Directory must be inside the workspace and outside .git.",
                "directory_list_failed",
            ));
        }
        let mut visited = vec![root.clone()];
        let mut prefix = root.clone();
        for part in relative.components() {
            prefix.push(part.as_os_str());
            if let Ok(p) = fs::canonicalize(&prefix) {
                visited.push(p);
            }
        }
        for item in fs::read_dir(real).map_err(|_| fail())?.flatten() {
            if item.file_name() == ".git" {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            let kind = if meta.is_dir() {
                "directory"
            } else if meta.is_file() {
                "file"
            } else {
                continue;
            };
            if item.file_type().is_ok_and(|t| t.is_symlink()) {
                let Ok(dest) = fs::canonicalize(item.path()) else {
                    continue;
                };
                if !dest.starts_with(&root)
                    || dest
                        .strip_prefix(&root)
                        .unwrap_or(Path::new(""))
                        .components()
                        .any(|c| c.as_os_str() == ".git")
                    || (kind == "directory" && visited.iter().any(|p| p.starts_with(&dest)))
                {
                    continue;
                }
            }
            result.push(
                json!({"path":relative.join(item.file_name()).to_string_lossy(), "kind":kind}),
            );
        }
        // Git labels ignored entries in lazy listings, while retaining them in the result.
        if let Ok(mut child) = Command::new("git")
            .args([
                "-c",
                "core.fsmonitor=false",
                "check-ignore",
                "-z",
                "--stdin",
            ])
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                for entry in &result {
                    let _ = stdin.write_all(entry["path"].as_str().unwrap_or("").as_bytes());
                    let _ = stdin.write_all(&[0]);
                }
            }
            if let Ok(output) = child.wait_with_output() {
                if output.status.code().is_some_and(|c| c == 0 || c == 1) {
                    let ignored: std::collections::HashSet<_> = output
                        .stdout
                        .split(|b| *b == 0)
                        .filter_map(|b| std::str::from_utf8(b).ok())
                        .collect();
                    for entry in &mut result {
                        if ignored.contains(entry["path"].as_str().unwrap_or("")) {
                            entry["ignored"] = json!(true);
                        }
                    }
                }
            }
        }
        return Ok(json!({"entries":result,"truncated":false}));
    }
    // The index respects ignore files, but includes hidden files and safe symlinks.
    let mut walker = ignore::WalkBuilder::new(&root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false);
    for item in walker.build().flatten().skip(1) {
        let path = item.path();
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        if relative.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let Ok(meta) = fs::metadata(path) else {
            continue;
        };
        let kind = if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            continue;
        };
        if item.file_type().is_some_and(|t| t.is_symlink()) {
            let Ok(dest) = fs::canonicalize(path) else {
                continue;
            };
            if !dest.starts_with(&root)
                || dest
                    .strip_prefix(&root)
                    .unwrap_or(Path::new(""))
                    .components()
                    .any(|c| c.as_os_str() == ".git")
            {
                continue;
            }
        }
        result.push(json!({"path":relative.to_string_lossy(),"kind":kind}));
    }
    if search {
        let query = v
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .replace('[', "")
            .to_lowercase();
        let limit = v
            .get("limit")
            .and_then(Value::as_u64)
            .filter(|n| (1..=200).contains(n))
            .ok_or_else(invalid)? as usize;
        let image = v.get("imageOnly") == Some(&json!(true));
        let kind = v.get("kind").and_then(Value::as_str);
        let matches = |query: &str, path: &str| -> Option<usize> {
            if query.contains(['*', '?', '{']) {
                return globset::GlobBuilder::new(query)
                    .case_insensitive(true)
                    .literal_separator(false)
                    .build()
                    .ok()
                    .filter(|g| g.compile_matcher().is_match(path))
                    .map(|_| 0);
            }
            let mut positions = Vec::new();
            let mut chars = path.chars().enumerate();
            for c in query.chars() {
                positions.push(chars.find(|(_, p)| *p == c)?.0);
            }
            if positions.is_empty() {
                return Some(0);
            }
            let first = positions[0];
            let last = *positions.last().unwrap();
            let gaps = last - first + 1 - positions.len();
            Some(
                first * 2 + gaps * 4 + path.chars().count().saturating_sub(positions.len()).min(64),
            )
        };
        let filter = |query: &str| {
            let mut found: Vec<_> = result
                .iter()
                .filter_map(|e| {
                    let path = e["path"].as_str()?.to_lowercase();
                    if image {
                        if e["kind"] != "file"
                            || ![
                                "avif", "bmp", "gif", "ico", "heic", "heif", "jpeg", "jpg", "png",
                                "svg", "tif", "tiff", "webp", "icns",
                            ]
                            .iter()
                            .any(|x| path.ends_with(&format!(".{x}")))
                        {
                            return None;
                        }
                    } else if kind.is_some_and(|k| e["kind"] != k) {
                        return None;
                    }
                    matches(query, &path).map(|score| (score, e.clone()))
                })
                .collect();
            found.sort_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| a.1["path"].as_str().cmp(&b.1["path"].as_str()))
            });
            found.into_iter().map(|(_, e)| e).collect::<Vec<_>>()
        };
        let mut found = filter(&query);
        if found.is_empty() && query.contains('{') {
            found = filter(&query.replace('{', ""));
        }
        let truncated = found.len() > limit;
        found.truncate(limit);
        return Ok(json!({"entries":found,"truncated":truncated}));
    }
    result.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let truncated = result.len() > 25000;
    result.truncate(25000);
    Ok(json!({"entries":result,"truncated":truncated}))
}
pub fn dispatch(tag: &str, v: &Value, state: &Path) -> Result<Value, RpcFailure> {
    match tag {
        "filesystem.browse" => browse(v),
        "filesystem.getMetadata" => {
            let paths = v
                .get("paths")
                .and_then(Value::as_array)
                .filter(|p| (1..=64).contains(&p.len()))
                .ok_or_else(invalid)?;
            let mut result = Vec::new();
            for path in paths {
                let p = path
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 512)
                    .ok_or_else(invalid)?;
                let expanded = expand(p);
                let entry = if expanded.is_absolute() {
                    fs::canonicalize(expanded)
                        .ok()
                        .filter(|p| !internal(p, state))
                        .and_then(|p| {
                            fs::metadata(&p).ok().map(|m| {
                                let kind = if m.is_file() {
                                    "file"
                                } else if m.is_dir() {
                                    "directory"
                                } else {
                                    "other"
                                };
                                let mut item = json!({"kind":kind});
                                if m.is_file() {
                                    item["byteLength"] = json!(m.len());
                                    if let Some(mime) = mime_guess::from_path(p).first_raw() {
                                        item["mimeType"] = json!(mime);
                                    }
                                }
                                item
                            })
                        })
                } else {
                    None
                };
                result.push(entry);
            }
            Ok(json!({"entries":result}))
        }
        "projects.readFile" => read(v, state),
        "projects.listEntries" => entries(v, false),
        "projects.listIgnoredFiles" => list_ignored_files(v),
        "projects.searchEntries" => entries(v, true),
        "projects.searchContents" => search_contents(v),
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn workspace_output_rejects_replaced_ancestor_symlink() {
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!("workspace-race-{}", uuid::Uuid::new_v4()));
        let root = tmp.join("root");
        let outside = tmp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("file"), "protected").unwrap();
        symlink(&outside, root.join("directory")).unwrap();
        assert!(open_workspace_output(&root, &root.join("directory/file"), b"oops").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("file")).unwrap(),
            "protected"
        );
        fs::remove_dir_all(tmp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_output_rejects_hard_link_without_modifying_outside_file() {
        let tmp = std::env::temp_dir().join(format!("workspace-hardlink-{}", uuid::Uuid::new_v4()));
        let root = tmp.join("root");
        fs::create_dir_all(&root).unwrap();
        let outside = tmp.join("outside.txt");
        fs::write(&outside, "protected").unwrap();
        fs::hard_link(&outside, root.join("linked.txt")).unwrap();

        assert!(open_workspace_output(&root, &root.join("linked.txt"), b"replacement").is_err());

        assert_eq!(fs::read_to_string(&outside).unwrap(), "protected");
        assert_eq!(
            fs::read_to_string(root.join("linked.txt")).unwrap(),
            "protected"
        );
        fs::remove_dir_all(tmp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_output_preserves_existing_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("workspace-mode-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("script");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o751)).unwrap();
        open_workspace_output(&root, &path, b"new").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o751
        );
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writes_only_known_workspaces_and_refuses_escapes_and_git() {
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!("workspace-write-{}", uuid::Uuid::new_v4()));
        let root = tmp.join("project");
        let outside = tmp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);").unwrap();
        let payload = |path: &str| json!({"cwd":root,"relativePath":path,"contents":"hello"});
        assert!(write_file(&payload("a.txt"), &tmp, &db, &json!({})).is_err());
        db.execute(
            "INSERT INTO projection_projects VALUES ('p', ?1, NULL)",
            [root.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(
            write_file(&payload("dir/./a.txt"), &tmp, &db, &json!({})).unwrap(),
            json!({"relativePath":"dir/a.txt"})
        );
        assert_eq!(fs::read_to_string(root.join("dir/a.txt")).unwrap(), "hello");
        assert!(write_file(&payload("../outside/file"), &tmp, &db, &json!({})).is_err());
        symlink(&outside, root.join("escape")).unwrap();
        assert!(write_file(&payload("escape/file"), &tmp, &db, &json!({})).is_err());
        assert!(write_file(&payload(".git/config"), &tmp, &db, &json!({})).is_err());
        fs::create_dir_all(root.join("bare/objects")).unwrap();
        fs::create_dir_all(root.join("bare/refs")).unwrap();
        fs::write(root.join("bare/HEAD"), "ref").unwrap();
        assert!(write_file(&payload("bare/config"), &tmp, &db, &json!({})).is_err());
        fs::remove_dir_all(tmp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ignored_files_filters_before_cap_and_skips_folders_and_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("workspace-ignored-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("build")).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        fs::write(root.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        fs::write(root.join("notes.log"), "abc").unwrap();
        fs::write(root.join("build/hidden.log"), "hidden").unwrap();
        symlink(root.join("notes.log"), root.join("link.log")).unwrap();
        let all = dispatch("projects.listIgnoredFiles", &json!({"cwd":root}), &root).unwrap();
        assert_eq!(
            all,
            json!({"files":[{"path":"notes.log","byteLength":3}],"truncated":false})
        );
        let filtered = dispatch(
            "projects.listIgnoredFiles",
            &json!({"cwd":root,"query":"NOTES"}),
            &root,
        )
        .unwrap();
        assert_eq!(filtered, all);
        for index in 0..201 {
            fs::write(root.join(format!("filler-{index:03}.log")), "x").unwrap();
        }
        let capped = dispatch("projects.listIgnoredFiles", &json!({"cwd":root}), &root).unwrap();
        assert_eq!(capped["truncated"], true);
        let filtered = dispatch(
            "projects.listIgnoredFiles",
            &json!({"cwd":root,"query":"NOTES"}),
            &root,
        )
        .unwrap();
        assert_eq!(filtered, all);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn content_search_respects_ignores_boundaries_and_utf16_offsets() {
        let root = std::env::temp_dir().join(format!("workspace-grep-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(root.join("ignored/hidden.txt"), "FOO").unwrap();
        fs::write(root.join("visible.txt"), "😀 foo foobar FOO!\n").unwrap();
        let query = json!({"cwd":root,"query":"foo","limit":10,"caseSensitive":false,"wholeWord":true,"useRegex":false});
        let result = dispatch("projects.searchContents", &query, &root).unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["matches"][0]["matchRanges"],
            json!([{"start":3,"end":6},{"start":14,"end":17}])
        );
        let fallback = dispatch("projects.searchContents", &json!({"cwd":root,"query":"[","limit":10,"caseSensitive":false,"wholeWord":false,"useRegex":true}), &root).unwrap();
        assert!(fallback["regexFallbackError"].is_string());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn entry_search_honors_ignore_reinclusion_of_git_ignored_files() {
        let root = std::env::temp_dir().join(format!("workspace-reinclude-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("notes/daily")).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        fs::write(root.join(".gitignore"), "notes/\n").unwrap();
        fs::write(
            root.join(".ignore"),
            "!notes/\nnotes/**/*\n!notes/**/\n!notes/**/*.md\n",
        )
        .unwrap();
        fs::write(root.join("notes/daily/standup.md"), "standup").unwrap();
        fs::write(root.join("notes/daily/standup.txt"), "standup").unwrap();
        let result = dispatch(
            "projects.searchEntries",
            &json!({"cwd":root,"query":"standup","limit":10,"kind":"file"}),
            &root.join("state"),
        );
        fs::remove_dir_all(root).unwrap();
        let expected: PathBuf = ["notes", "daily", "standup.md"].iter().collect();
        assert_eq!(
            result.unwrap()["entries"],
            json!([{"kind":"file","path":expected.to_string_lossy()}])
        );
    }

    #[test]
    fn search_respects_ignores_ranking_and_image_mode() {
        let root = std::env::temp_dir().join(format!("workspace-index-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("hidden")).unwrap();
        fs::write(root.join(".gitignore"), "hidden/\n").unwrap();
        fs::write(root.join("hidden/secret.txt"), "x").unwrap();
        fs::write(root.join("long-abc.txt"), "x").unwrap();
        fs::write(root.join("abc.txt"), "x").unwrap();
        fs::write(root.join("icon.avif"), "x").unwrap();
        let state = root.join("state");
        let list = dispatch("projects.listEntries", &json!({"cwd":root}), &state).unwrap();
        assert!(!list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["path"].as_str().unwrap().starts_with("hidden")));
        let search = dispatch(
            "projects.searchEntries",
            &json!({"cwd":root,"query":"abc","limit":10}),
            &state,
        )
        .unwrap();
        assert_eq!(search["entries"][0]["path"], "abc.txt");
        let images = dispatch(
            "projects.searchEntries",
            &json!({"cwd":root,"query":"","limit":10,"kind":"directory","imageOnly":true}),
            &state,
        )
        .unwrap();
        assert_eq!(images["entries"][0]["path"], "icon.avif");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn previews_and_containment() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("workspace-rpc-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ok.txt"), "hello").unwrap();
        fs::write(base.join("outside.txt"), "secret").unwrap();
        symlink(base.join("outside.txt"), root.join("escape")).unwrap();
        let state = base.join("state");
        let payload = |path| json!({"cwd":root,"relativePath":path});
        assert_eq!(
            dispatch("projects.readFile", &payload("ok.txt"), &state).unwrap()["contents"],
            "hello"
        );
        assert!(dispatch("projects.readFile", &payload("escape"), &state).is_err());
        assert!(dispatch("projects.readFile", &payload("../outside.txt"), &state).is_err());
        let missing = json!({"cwd":root,"relativePath":"missing", "allowMissing":true});
        assert_eq!(
            dispatch("projects.readFile", &missing, &state).unwrap()["exists"],
            false
        );
        let list = dispatch(
            "projects.listEntries",
            &json!({"cwd":root,"directoryPath":""}),
            &state,
        )
        .unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(base).unwrap();
    }
}
