//! Retention cleanup for browser artifacts and rotated server logs.
//!
//! Callers supply the current policy on each deletion so a sweep stops when
//! settings change. Worktree cleanup supports a conservative subset of upstream
//! rules and keeps checkouts when safety cannot be established.
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileCategory {
    BrowserArtifacts,
    RotatedLogs,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RemovedFiles {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug)]
pub struct CleanupError {
    pub source: io::Error,
    pub removed: RemovedFiles,
}

/// Removes expired files and reports partial progress on failure. A `None` age
/// disables the category; the policy callback must return the current age.
pub fn clean_files(
    root: &Path,
    category: FileCategory,
    days: Option<u32>,
    now: SystemTime,
    mut current_days: impl FnMut() -> io::Result<Option<u32>>,
) -> Result<RemovedFiles, CleanupError> {
    let mut removed = RemovedFiles::default();
    let Some(days) = days else { return Ok(removed) };
    let result = (|| {
        let meta = match fs::symlink_metadata(root) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Ok(());
        }
        let real_root = fs::canonicalize(root)?;
        let Some(parent) = root.parent() else {
            return Ok(());
        };
        let Some(name) = root.file_name() else {
            return Ok(());
        };
        if fs::canonicalize(parent)?.join(name) != real_root {
            return Ok(());
        }
        let cutoff = now.checked_sub(Duration::from_secs(u64::from(days) * 86_400));
        let Some(cutoff) = cutoff else { return Ok(()) };
        clean_anchored(
            &real_root,
            category,
            days,
            cutoff,
            &mut current_days,
            &mut removed,
        )?;
        Ok(())
    })();
    result
        .map(|()| removed)
        .map_err(|source| CleanupError { source, removed })
}

// Unix directory file descriptors pin each ancestor even if another process renames it.
#[cfg(unix)]
fn clean_anchored(
    root: &Path,
    category: FileCategory,
    days: u32,
    cutoff: SystemTime,
    current_days: &mut impl FnMut() -> io::Result<Option<u32>>,
    removed: &mut RemovedFiles,
) -> io::Result<()> {
    use std::ffi::{CStr, CString, OsStr};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::time::UNIX_EPOCH;

    struct DirHandle(*mut libc::DIR);
    impl Drop for DirHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
    }

    fn stat_mtime(st: &libc::stat) -> Option<SystemTime> {
        let secs = st.st_mtime;
        let nsec = u32::try_from(st.st_mtime_nsec).unwrap_or(0);
        if secs >= 0 {
            UNIX_EPOCH.checked_add(Duration::new(secs as u64, nsec))
        } else {
            let abs = secs.unsigned_abs();
            if nsec == 0 {
                UNIX_EPOCH.checked_sub(Duration::from_secs(abs))
            } else {
                UNIX_EPOCH.checked_sub(Duration::new(abs.saturating_sub(1), 1_000_000_000 - nsec))
            }
        }
    }

    let root_c = CString::new(root.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))?;
    let root_fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pending = vec![unsafe { OwnedFd::from_raw_fd(root_fd) }];
    while let Some(directory) = pending.pop() {
        let dup_fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if dup_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let dirp = unsafe { libc::fdopendir(dup_fd) };
        if dirp.is_null() {
            let err = io::Error::last_os_error();
            unsafe {
                libc::close(dup_fd);
            }
            return Err(err);
        }
        let _dir_guard = DirHandle(dirp);
        loop {
            // A null result means EOF only when readdir leaves errno clear.
            errno::set_errno(errno::Errno(0));
            // SAFETY: the guard owns this live scan handle until the loop exits.
            let entry = unsafe { libc::readdir(dirp) };
            if entry.is_null() {
                let code = errno::errno().0;
                if code != 0 {
                    return Err(io::Error::from_raw_os_error(code));
                }
                break;
            }
            let name_c = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let name_bytes = name_c.to_bytes();
            if name_bytes == b"." || name_bytes == b".." {
                continue;
            }
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name_c.as_ptr(),
                    &mut st,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::NotFound {
                    continue;
                }
                return Err(err);
            }
            let kind = st.st_mode & libc::S_IFMT;
            if kind == libc::S_IFLNK {
                continue;
            }
            if kind == libc::S_IFDIR && category == FileCategory::RotatedLogs {
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name_c.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::NotFound {
                        continue;
                    }
                    return Err(err);
                }
                pending.push(unsafe { OwnedFd::from_raw_fd(fd) });
            } else if kind == libc::S_IFREG
                && (category == FileCategory::BrowserArtifacts
                    || is_rotated_log(Path::new(OsStr::from_bytes(name_bytes))))
                && stat_mtime(&st).is_some_and(|mtime| mtime < cutoff)
            {
                if current_days()? != Some(days) {
                    return Ok(());
                }
                if unsafe { libc::unlinkat(directory.as_raw_fd(), name_c.as_ptr(), 0) } != 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::NotFound {
                        continue;
                    }
                    return Err(err);
                }
                removed.files += 1;
                removed.bytes += u64::try_from(st.st_size).unwrap_or(0);
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn clean_anchored(
    _root: &Path,
    _category: FileCategory,
    _days: u32,
    _cutoff: SystemTime,
    _current_days: &mut impl FnMut() -> io::Result<Option<u32>>,
    _removed: &mut RemovedFiles,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "safe cleanup is not supported on this platform",
    ))
}

#[cfg(unix)]
fn is_rotated_log(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some((stem, number)) = name.rsplit_once('.') else {
        return false;
    };
    !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
        && (stem.ends_with(".log") || stem.ends_with(".ndjson"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("t3-cleanup-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"abc").unwrap();
            File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_secs(1))
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(200_000)
    }

    #[test]
    fn logs_recurse_but_only_remove_expired_rotations() {
        let f = Fixture::new();
        for name in [
            "server.log.1",
            "sub/events.ndjson.23",
            "server.log",
            "sub/other.txt.1",
            "server.log.x",
        ] {
            f.file(name);
        }
        fs::write(f.0.join("recent.log.1"), "recent").unwrap();
        let report = clean_files(&f.0, FileCategory::RotatedLogs, Some(1), now(), || {
            Ok(Some(1))
        })
        .unwrap();
        assert_eq!(report, RemovedFiles { files: 2, bytes: 6 });
        for name in [
            "server.log",
            "sub/other.txt.1",
            "server.log.x",
            "recent.log.1",
        ] {
            assert!(f.0.join(name).exists());
        }
    }

    #[test]
    fn artifacts_are_shallow_and_policy_change_stops_deletion() {
        let f = Fixture::new();
        f.file("one.png");
        f.file("nested/two.png");
        let result = clean_files(&f.0, FileCategory::BrowserArtifacts, Some(1), now(), || {
            Ok(None)
        })
        .unwrap();
        assert_eq!(result.files, 0);
        assert!(f.0.join("one.png").exists());
        let result = clean_files(&f.0, FileCategory::BrowserArtifacts, Some(1), now(), || {
            Ok(Some(1))
        })
        .unwrap();
        assert_eq!(result.files, 1);
        assert!(f.0.join("nested/two.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_root_and_entries() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.file("old.log.1");
        symlink(&outside.0, f.0.join("link")).unwrap();
        symlink(outside.0.join("old.log.1"), f.0.join("old.log.1")).unwrap();
        assert_eq!(
            clean_files(&f.0, FileCategory::RotatedLogs, Some(1), now(), || Ok(
                Some(1)
            ))
            .unwrap()
            .files,
            0
        );
        assert_eq!(
            clean_files(
                &f.0.join("link"),
                FileCategory::RotatedLogs,
                Some(1),
                now(),
                || Ok(Some(1))
            )
            .unwrap()
            .files,
            0
        );
        assert!(outside.0.join("old.log.1").exists());
    }
}

// Best-effort reclaimed-block estimate. Refuse an estimate for pnpm stores,
// where reflinks can make allocated blocks appear exclusive when they are not.
#[cfg(unix)]
fn worktree_bytes(root: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    if root.join("node_modules/.modules.yaml").exists() {
        return None;
    }
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0u64;
    let mut count = 0usize;
    while let Some(path) = pending.pop() {
        count += 1;
        if count > 2_000_000 {
            return None;
        }
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            for entry in fs::read_dir(path).ok()? {
                pending.push(entry.ok()?.path());
            }
        } else if meta.is_file() && meta.nlink() == 1 {
            bytes = bytes.checked_add(meta.blocks().checked_mul(512)?)?;
        }
    }
    Some(bytes)
}
#[cfg(not(unix))]
fn worktree_bytes(_root: &Path) -> Option<u64> {
    None
}

// Refresh the primary remote's default branch before using it as evidence.
// Unknown refs and failed fetches preserve the checkout.
fn branch_evidence(project: &Path, tree: &Path) -> Option<(&'static str, Option<String>, bool)> {
    let run = |cwd: &Path, args: &[&str]| -> Option<std::process::Output> {
        let mut command = std::process::Command::new("git");
        command
            .current_dir(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0");
        crate::vcs_worktree::run_command(&mut command, Duration::from_secs(30)).ok()
    };
    let remotes = run(project, &["remote"])?;
    if !remotes.status.success() {
        return None;
    }
    let names: Vec<_> = std::str::from_utf8(&remotes.stdout)
        .ok()?
        .lines()
        .filter(|s| !s.is_empty())
        .collect();
    let (reference, reason, default_branch) = if names.is_empty() {
        let head = run(project, &["symbolic-ref", "--quiet", "HEAD"])?;
        if !head.status.success() {
            return None;
        }
        let branch = std::str::from_utf8(&head.stdout).ok()?.trim();
        if !branch.starts_with("refs/heads/") {
            return None;
        }
        (
            branch.to_owned(),
            "No commits beyond the project branch",
            None,
        )
    } else {
        let remote = if names.contains(&"origin") {
            "origin"
        } else {
            names[0]
        };
        let prefix = format!("refs/remotes/{remote}/");
        let head_ref = format!("{prefix}HEAD");
        let symbolic = run(project, &["symbolic-ref", "--quiet", &head_ref])?;
        let branch = if symbolic.status.success() {
            std::str::from_utf8(&symbolic.stdout)
                .ok()?
                .trim()
                .strip_prefix(&prefix)?
                .to_owned()
        } else {
            let head = run(project, &["ls-remote", "--symref", "--", remote, "HEAD"])?;
            if !head.status.success() {
                return None;
            }
            std::str::from_utf8(&head.stdout)
                .ok()?
                .lines()
                .find_map(|line| {
                    line.strip_prefix("ref: refs/heads/")?
                        .strip_suffix("\tHEAD")
                })
                .map(str::to_owned)?
        };
        let source = format!("refs/heads/{branch}");
        if !run(project, &["check-ref-format", &source])?
            .status
            .success()
        {
            return None;
        }
        let target = format!("{prefix}{branch}");
        let refspec = format!("+{source}:{target}");
        if !run(project, &["fetch", "--no-tags", "--", remote, &refspec])?
            .status
            .success()
        {
            return None;
        }
        (target, "No commits beyond the default branch", Some(branch))
    };
    let ancestor = run(tree, &["merge-base", "--is-ancestor", "HEAD", &reference])?;
    if !matches!(ancestor.status.code(), Some(0 | 1)) {
        return None;
    }
    Some((reason, default_branch, ancestor.status.success()))
}
fn unchanged_project_branch(project: &Path, tree: &Path) -> Option<&'static str> {
    branch_evidence(project, tree).and_then(|(reason, _, integrated)| integrated.then_some(reason))
}

// Require an unambiguous fresh result. Squash/rebase merges must identify
// this exact branch, head and refreshed default branch.
fn merged_pr_evidence(
    data: &serde_json::Value,
    branch: &str,
    head: &str,
    base: &str,
    integrated: bool,
) -> bool {
    let Some(items) = data.as_array().filter(|items| items.len() < 100) else {
        return false;
    };
    let matching: Vec<_> = items
        .iter()
        .filter(|pr| pr["state"] == "MERGED" && pr["headRefName"] == branch)
        .collect();
    let [pr] = matching.as_slice() else {
        return false;
    };
    pr["headRefOid"] == head && (integrated || pr["baseRefName"] == base)
}
fn merged_provider_pr(project: &Path, tree: &Path, branch: &str) -> bool {
    let Some(root) = project.to_str() else {
        return false;
    };
    let Some(identity) = crate::repository_identity::resolve(root) else {
        return false;
    };
    let provider = identity["provider"].as_str().unwrap_or("");
    let Some((host, repo)) = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
    else {
        return false;
    };
    if !matches!(provider, "github" | "gitlab") {
        return false;
    }
    let Some((_, Some(base), integrated)) = branch_evidence(project, tree) else {
        return false;
    };
    let mut git = std::process::Command::new("git");
    git.current_dir(tree)
        .args(["rev-parse", "--verify", "HEAD"]);
    let Some(head) = crate::vcs_worktree::run_command(&mut git, Duration::from_secs(30))
        .ok()
        .filter(|o| o.status.success())
    else {
        return false;
    };
    let Ok(head) = std::str::from_utf8(&head.stdout) else {
        return false;
    };
    let output = if provider == "github" {
        let mut gh = std::process::Command::new("gh");
        gh.current_dir(project)
            .env("GH_PROMPT_DISABLED", "1")
            .args([
                "pr",
                "list",
                "--repo",
                &format!("{host}/{repo}"),
                "--head",
                branch,
                "--state",
                "merged",
                "--limit",
                "100",
                "--json",
                "state,headRefName,headRefOid,baseRefName",
            ]);
        crate::github_pinned_credential::run_classified(&mut gh, Duration::from_secs(30)).ok()
    } else {
        let encode = |s: &str| {
            s.bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>()
        };
        let display = identity["displayName"].as_str().unwrap_or(repo);
        let endpoint = format!(
            "projects/{}/merge_requests?state=merged&source_branch={}&per_page=100",
            encode(display),
            encode(branch)
        );
        let mut glab = std::process::Command::new("glab");
        glab.current_dir(project)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1")
            .args(["api", &endpoint]);
        crate::github_pinned_credential::run_classified(&mut glab, Duration::from_secs(30)).ok()
    };
    let Some(data) = output.and_then(|out| serde_json::from_slice::<serde_json::Value>(&out).ok())
    else {
        return false;
    };
    if provider == "github" {
        return merged_pr_evidence(&data, branch, head.trim(), &base, integrated);
    }
    let Some(items) = data.as_array().filter(|items| items.len() < 100) else {
        return false;
    };
    let matches: Vec<_> = items
        .iter()
        .filter(|mr| {
            mr["state"] == "merged"
                && mr["source_branch"] == branch
                && mr["source_project_id"].is_number()
                && mr["source_project_id"] == mr["target_project_id"]
        })
        .collect();
    let [mr] = matches.as_slice() else {
        return false;
    };
    mr["sha"] == head.trim() && (integrated || mr["target_branch"] == base)
}

fn dirty_reason(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new("git");
    command.current_dir(path).args([
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        "--untracked-files=all",
    ]);
    let result = crate::vcs_worktree::run_command(&mut command, Duration::from_secs(30)).ok()?;
    if !result.status.success() {
        return None;
    }
    let records: Vec<_> = result
        .stdout
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .collect();
    let mut count = 0;
    let mut i = 0;
    while i < records.len() {
        count += 1;
        if records[i].first().is_some_and(|b| *b == b'R' || *b == b'C')
            || records[i].get(1).is_some_and(|b| *b == b'R' || *b == b'C')
        {
            i += 1;
        }
        i += 1;
    }
    (count > 0).then(|| {
        format!(
            "Has uncommitted changes ({count} {})",
            if count == 1 { "file" } else { "files" }
        )
    })
}

/// Coordinates serialized file-retention sweeps and publishes the latest report.
/// Worktree removal uses live state and Git safety checks, and retains cases
/// whose upstream cleanup rules are not yet implemented.
pub struct StorageCleanup {
    settings: std::sync::Arc<crate::settings::Settings>,
    artifacts: std::path::PathBuf,
    logs: std::path::PathBuf,
    gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    reports: tokio::sync::watch::Sender<Option<serde_json::Value>>,
    worktree_context: std::sync::Mutex<
        Option<(
            crate::event_bus::EventBus,
            std::sync::Arc<crate::terminal::TerminalManager>,
        )>,
    >,
}

impl StorageCleanup {
    pub fn new(
        settings: std::sync::Arc<crate::settings::Settings>,
        artifacts: std::path::PathBuf,
        logs: std::path::PathBuf,
    ) -> std::sync::Arc<Self> {
        let (reports, _) = tokio::sync::watch::channel(None);
        std::sync::Arc::new(Self {
            settings,
            artifacts,
            logs,
            gate: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            reports,
            worktree_context: std::sync::Mutex::new(None),
        })
    }

    pub fn set_worktree_context(
        &self,
        bus: crate::event_bus::EventBus,
        terminals: std::sync::Arc<crate::terminal::TerminalManager>,
    ) {
        if let Ok(mut context) = self.worktree_context.lock() {
            *context = Some((bus, terminals));
        }
    }

    pub fn latest_report(&self) -> Option<serde_json::Value> {
        self.reports.borrow().clone()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Option<serde_json::Value>> {
        self.reports.subscribe()
    }

    pub async fn run_now(self: &std::sync::Arc<Self>) -> serde_json::Value {
        self.sweep("manual").await
    }

    /// Starts an immediate sweep and repeats hourly or when cleanup settings change.
    /// Abort the returned task when the owning server shuts down.
    pub fn start(self: &std::sync::Arc<Self>) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        let mut changes = service.settings.subscribe();
        let bus = service
            .worktree_context
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|(bus, _)| bus.clone()));
        let mut events = bus.as_ref().and_then(|bus| {
            let sequence = bus
                .with_autocommit(|db| crate::event_store::latest_thread_sequence(db, None))
                .ok()?
                .ok()?;
            bus.subscribe(sequence, crate::event_bus::Filter::default())
                .ok()
        });
        tokio::spawn(async move {
            let cleanup_settings = |snapshot: &serde_json::Value| {
                serde_json::json!([
                    snapshot["storageCleanup"],
                    snapshot["worktreeCleanup"],
                    snapshot["projectSettingsOverrides"]
                ])
            };
            let deletion_enabled = |snapshot: &serde_json::Value| {
                crate::storage_cleanup_worktrees::resolve_policy(snapshot, "")["worktreeOnDelete"]
                    == true
                    || snapshot["projectSettingsOverrides"]
                        .as_object()
                        .is_some_and(|projects| {
                            projects.keys().any(|id| {
                                crate::storage_cleanup_worktrees::resolve_policy(snapshot, id)
                                    ["worktreeOnDelete"]
                                    == true
                            })
                        })
            };
            let mut last = cleanup_settings(&service.settings.snapshot());
            service.sweep("automatic").await;
            let pending_deletions = || {
                if !deletion_enabled(&service.settings.snapshot()) {
                    return false;
                }
                bus.as_ref().is_some_and(|bus| {
                bus.with_autocommit(|db| db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox e JOIN orchestration_v2_projection_threads t ON t.thread_id=e.thread_id WHERE t.deleted_at IS NOT NULL AND e.status IN ('pending','running'))", [], |r| r.get::<_,bool>(0))).ok().and_then(Result::ok).unwrap_or(false)
            })
            };
            let mut retry_deletions = pending_deletions();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
            interval.tick().await;
            let mut retry_interval = tokio::time::interval(std::time::Duration::from_secs(1));
            retry_interval.tick().await;
            loop {
                tokio::select! {
                    _ = interval.tick() => { service.sweep("automatic").await; }
                    change = changes.recv() => {
                        match change {
                            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                let current = cleanup_settings(&service.settings.snapshot());
                                if current != last { last = current; service.sweep("automatic").await; retry_deletions = deletion_enabled(&service.settings.snapshot()); }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    event = async {
                        match events.as_mut() {
                            Some(events) => events.next().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        match event {
                            Ok(event) if event.event.event_type == "thread.deleted" ||
                                (event.event.event_type == "provider-session.updated" && matches!(event.event.payload["status"].as_str(), Some("stopped" | "error"))) => {
                                let snapshot = service.settings.snapshot();
                                let enabled = deletion_enabled(&snapshot);
                                if enabled { service.sweep("automatic").await; retry_deletions = true; }
                            }
                            Err(crate::event_bus::BusError::Lagged(_)) => {
                                let cursor = events.as_ref().map(|events| events.cursor()).unwrap_or(0);
                                events = bus.as_ref().and_then(|bus| bus.subscribe(cursor, crate::event_bus::Filter::default()).ok());
                            }
                            Err(_) => events = None,
                            _ => {}
                        }
                    }
                    _ = retry_interval.tick(), if retry_deletions => {
                        let was_pending = pending_deletions();
                        service.sweep("automatic").await;
                        retry_deletions = was_pending || pending_deletions();
                    }
                }
            }
        })
    }

    async fn sweep(self: &std::sync::Arc<Self>, trigger: &'static str) -> serde_json::Value {
        let guard = self.gate.clone().lock_owned().await;
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            service.sweep_blocking(trigger)
        })
        .await
        .expect("storage cleanup worker failed")
    }

    // Only inactive or settled, single-owner live threads are removed. Other
    // policies are reported as retained until their complete safety checks exist.
    fn clean_worktrees(&self, now: SystemTime, entries: &mut Vec<serde_json::Value>) {
        use crate::storage_cleanup_worktrees::{self as wt, PolicyDecision};
        let settings = self.settings.snapshot();
        let context = self.worktree_context.lock().ok().and_then(|c| c.clone());
        let Some((bus, terminals)) = context else {
            let p = &settings["storageCleanup"];
            if ["worktreeAfterDays", "worktreeSettledAfterDays"]
                .iter()
                .any(|k| p[*k].is_u64())
                || ["worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"]
                    .iter()
                    .any(|k| p[*k] == true)
            {
                entries.push(serde_json::json!({"kind":"worktree","outcome":"failed","reason":"Worktree cleanup state unavailable","path":null,"projectPath":null,"threadId":null,"threadTitle":null,"bytes":null,"files":null}));
            }
            return;
        };
        let Ok(mut snapshot) = bus.shell_snapshot() else {
            return;
        };
        // The regular shell excludes archived threads, but those threads still
        // own their worktrees and can qualify for the unchanged-worktree rule.
        let Ok(archived) = bus.archived_shell_snapshot() else {
            return;
        };
        if let (Some(threads), Some(archived_threads)) = (
            snapshot["threads"].as_array_mut(),
            archived["threads"].as_array(),
        ) {
            threads.extend(archived_threads.iter().cloned());
        } else {
            return;
        }
        let Some(threads) = snapshot["threads"].as_array() else {
            return;
        };
        for thread in threads {
            let (Some(id), Some(project_id), Some(path), Some(branch)) = (
                thread["id"].as_str(),
                thread["projectId"].as_str(),
                thread["worktreePath"].as_str(),
                thread["branch"].as_str(),
            ) else {
                continue;
            };
            let policy = wt::resolve_policy(&settings, project_id);
            if !["worktreeAfterDays", "worktreeSettledAfterDays"]
                .iter()
                .any(|k| policy[*k].is_u64())
                && !["worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"]
                    .iter()
                    .any(|k| policy[*k] == true)
            {
                continue;
            }
            let project = snapshot["projects"]
                .as_array()
                .and_then(|p| p.iter().find(|p| p["id"] == project_id))
                .and_then(|p| p["workspaceRoot"].as_str());
            let Some(project) = project else {
                continue;
            };
            let path = Path::new(path);
            if !path.exists() {
                continue;
            }
            let mut entry = serde_json::json!({"kind":"worktree","outcome":"kept","reason":"Not due.","path":path,"projectPath":project,"threadId":id,"threadTitle":thread["title"],"bytes":null,"files":null});
            // PR metadata changes updatedAt but must not reset the inactivity
            // clock. Require every present activity timestamp to parse.
            let elapsed = |value: &serde_json::Value| -> Option<u64> {
                let stamp = chrono::DateTime::parse_from_rfc3339(value.as_str()?)
                    .ok()?
                    .timestamp_millis();
                let now_ms = now.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis();
                let then_ms: u128 = stamp.try_into().ok()?;
                u64::try_from(now_ms.checked_sub(then_ms)? / 1000).ok()
            };
            let mut ages = Vec::new();
            let mut invalid = false;
            for key in [
                "createdAt",
                "latestUserMessageAt",
                "latestRunRequestedAt",
                "latestRunStartedAt",
                "latestRunCompletedAt",
            ] {
                if !thread[key].is_null() {
                    match elapsed(&thread[key]) {
                        Some(age) => ages.push(age),
                        None => invalid = true,
                    }
                } else if key == "createdAt" {
                    invalid = true;
                }
            }
            let Some(age) = ages.into_iter().min().filter(|_| !invalid) else {
                entry["reason"] = serde_json::json!("Thread activity time unavailable.");
                entries.push(entry);
                continue;
            };
            let settled_age = if thread["settledAt"].is_null() {
                None
            } else {
                let Some(value) = elapsed(&thread["settledAt"]) else {
                    entry["reason"] = serde_json::json!("Settlement time unavailable.");
                    entries.push(entry);
                    continue;
                };
                Some(value.min(age))
            };
            if settled_age.is_some()
                && elapsed(&thread["updatedAt"]).is_none_or(|updated_age| updated_age.min(age) < 60)
            {
                entry["reason"] = serde_json::json!("Settled moments ago.");
                entries.push(entry);
                continue;
            }
            let archived = !thread["archivedAt"].is_null();
            let due = wt::policy_decision(&policy, false, age, settled_age, archived);
            let unchanged_reason = if matches!(due, PolicyDecision::NeedsGit)
                && policy["worktreeUnchanged"] == true
                && (settled_age.is_some() || archived)
            {
                unchanged_project_branch(Path::new(project), path)
            } else {
                None
            };
            let unchanged = unchanged_reason.is_some();
            let merged = matches!(due, PolicyDecision::NeedsGit)
                && policy["worktreeOnMerge"] == true
                && !unchanged
                && merged_provider_pr(Path::new(project), path, branch);
            if !matches!(due, PolicyDecision::Due("inactive" | "settled")) && !unchanged && !merged
            {
                entry["reason"] = serde_json::json!("Worktree rule not yet supported or not due.");
                entries.push(entry);
                continue;
            }
            // A complete, stable shell is required in addition to the projection
            // checks: queued runtime requests and pending background work protect it.
            let idle = |t: &serde_json::Value| {
                matches!(
                    t["status"].as_str(),
                    Some(
                        "idle"
                            | "completed"
                            | "interrupted"
                            | "cancelled"
                            | "rolled_back"
                    )
                ) && t["activeRunId"].is_null()
                    && t["pendingRuntimeRequest"].is_null()
                    && t["pendingBackgroundTasks"]
                        .as_array()
                        .is_some_and(|a| a.is_empty())
                    // Failed runs may be awaiting usage-limit recovery; the
                    // projection does not expose all recovery state reliably.
                    && t["lastErrorClass"].is_null()
                    && t["pendingGuestMessageCount"].as_u64() == Some(0)
            };
            if !idle(thread) {
                entry["reason"] = serde_json::json!("Thread is running or has pending work.");
                entries.push(entry);
                continue;
            }
            let initial = bus
                .with_autocommit(|db| wt::read_live_state(db, &terminals, path))
                .ok()
                .and_then(Result::ok);
            let Some(initial) = initial else {
                entry["reason"] = serde_json::json!("Live state unavailable.");
                entries.push(entry);
                continue;
            };
            let mut roots = Vec::new();
            if let Some(root) = bus.worktrees_dir() {
                roots.push(root);
            }
            if let Some(configured) = settings["worktreesDirectory"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
            {
                roots.push(configured.into());
            }
            if let Some(previous) = settings["previousWorktreesDirectories"].as_array() {
                roots.extend(previous.iter().filter_map(|v| v.as_str().map(Into::into)));
            }
            let mut measured = None;
            let keep_when = policy["worktreeKeepWhen"]
                .as_str()
                .unwrap_or("uncommitted-changes");
            let result =
                wt::remove_if_safe(Path::new(project), path, &roots, branch, keep_when, || {
                    if self.settings.snapshot() != settings
                        || (unchanged
                            && unchanged_project_branch(Path::new(project), path)
                                != unchanged_reason)
                        || (merged && !merged_provider_pr(Path::new(project), path, branch))
                    {
                        return Ok(false);
                    }
                    let latest_shell = if archived {
                        bus.archived_shell_snapshot()
                    } else {
                        bus.shell_snapshot()
                    }
                    .map_err(|e| io::Error::other(format!("{e:?}")))?;
                    let Some(current) = latest_shell["threads"]
                        .as_array()
                        .and_then(|ts| ts.iter().find(|t| t["id"] == id))
                    else {
                        return Ok(false);
                    };
                    if current != thread || !idle(current) {
                        return Ok(false);
                    }
                    let latest = bus
                        .with_autocommit(|db| wt::read_live_state(db, &terminals, path))
                        .map_err(|e| io::Error::other(format!("{e:?}")))?
                        .map_err(io::Error::other)?;
                    let eligible = wt::live_state_eligible(path, id, branch, &initial, &latest)?;
                    if eligible {
                        measured = worktree_bytes(path);
                    }
                    Ok(eligible)
                });
            match result {
                Ok(wt::Outcome::Removed) => {
                    entry["outcome"] = serde_json::json!("removed");
                    entry["bytes"] = serde_json::json!(measured);
                    entry["reason"] = if merged {
                        serde_json::json!("Pull request was merged")
                    } else if unchanged {
                        serde_json::json!(unchanged_reason)
                    } else if matches!(due, PolicyDecision::Due("settled")) {
                        serde_json::json!(format!(
                            "Settled for {} days",
                            settled_age.unwrap_or(0) / 86_400
                        ))
                    } else {
                        serde_json::json!(format!("Inactive for {} days", age / 86_400))
                    };
                }
                Ok(wt::Outcome::Kept(reason)) => {
                    entry["reason"] = serde_json::json!(if reason == "worktree has local changes" {
                        dirty_reason(path).unwrap_or_else(|| reason.to_owned())
                    } else {
                        reason.to_owned()
                    })
                }
                Ok(wt::Outcome::KeptIgnored(path)) => {
                    entry["reason"] = serde_json::json!(format!("Has ignored files ({path})"));
                }
                Err(e) => {
                    entry["outcome"] = serde_json::json!("failed");
                    entry["reason"] = serde_json::json!(e.to_string());
                }
            }
            entries.push(entry);
        }
        self.clean_deleted_worktrees(&bus, &terminals, &settings, entries);
        self.report_orphan_worktrees(&bus, &settings, now, entries);
    }

    fn clean_deleted_worktrees(
        &self,
        bus: &crate::event_bus::EventBus,
        terminals: &crate::terminal::TerminalManager,
        settings: &serde_json::Value,
        entries: &mut Vec<serde_json::Value>,
    ) {
        use crate::storage_cleanup_worktrees as wt;
        use rusqlite::OptionalExtension;
        let rows = bus.with_autocommit(|db| -> rusqlite::Result<Vec<(String, String, String)>> {
            let mut stmt = db.prepare("SELECT t.thread_id,t.payload_json,p.workspace_root FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.deleted_at IS NOT NULL ORDER BY t.thread_id")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect();
            rows
        });
        let Ok(Ok(rows)) = rows else { return };
        let mut roots = Vec::new();
        if let Some(root) = bus.worktrees_dir() {
            roots.push(root);
        }
        if let Some(root) = settings["worktreesDirectory"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        {
            roots.push(root.into());
        }
        if let Some(previous) = settings["previousWorktreesDirectories"].as_array() {
            roots.extend(previous.iter().filter_map(|v| v.as_str().map(Into::into)));
        }
        for (id, raw, project) in rows {
            let Ok(thread) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let (Some(project_id), Some(path), Some(branch)) = (
                thread["projectId"].as_str(),
                thread["worktreePath"].as_str(),
                thread["branch"].as_str(),
            ) else {
                continue;
            };
            let policy = wt::resolve_policy(settings, project_id);
            if policy["worktreeOnDelete"] != true {
                continue;
            }
            let path = Path::new(path);
            if !path.exists() {
                continue;
            }
            let mut entry = serde_json::json!({"kind":"worktree","outcome":"kept","reason":"Thread is running or has pending work.","path":path,"projectPath":project,"threadId":id,"threadTitle":thread["title"],"bytes":null,"files":null});
            let initial = bus
                .with_autocommit(|db| wt::read_live_state(db, terminals, path))
                .ok()
                .and_then(Result::ok);
            let Some(initial) = initial else {
                entries.push(entry);
                continue;
            };
            let mut measured = None;
            let keep_when = policy["worktreeKeepWhen"]
                .as_str()
                .unwrap_or("uncommitted-changes");
            let result = wt::remove_if_safe(
                Path::new(&project),
                path,
                &roots,
                branch,
                keep_when,
                || {
                    if self.settings.snapshot() != *settings {
                        return Ok(false);
                    }
                    let current = bus.with_autocommit(|db| -> rusqlite::Result<bool> {
                    let row: Option<(String,String)> = db.query_row("SELECT t.payload_json,p.workspace_root FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NOT NULL", [&id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
                    let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))", [&id], |r| r.get(0))?;
                    let pending_effect: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id=?1 AND status NOT IN ('succeeded','cancelled'))", [&id], |r| r.get(0))?;
                    Ok(!active && !pending_effect && row.as_ref().is_some_and(|(payload,root)| payload == &raw && root == &project))
                }).map_err(|e| io::Error::other(format!("{e:?}")))?.map_err(io::Error::other)?;
                    if !current {
                        return Ok(false);
                    }
                    let latest = bus
                        .with_autocommit(|db| wt::read_live_state(db, terminals, path))
                        .map_err(|e| io::Error::other(format!("{e:?}")))?
                        .map_err(io::Error::other)?;
                    let eligible = wt::deleted_state_eligible(path, &initial, &latest)?;
                    if eligible {
                        measured = worktree_bytes(path);
                    }
                    Ok(eligible)
                },
            );
            match result {
                Ok(wt::Outcome::Removed) => {
                    entry["outcome"] = serde_json::json!("removed");
                    entry["reason"] = serde_json::json!("Thread was deleted");
                    entry["bytes"] = serde_json::json!(measured);
                }
                Ok(wt::Outcome::Kept(reason)) => {
                    entry["reason"] =
                        serde_json::json!(if reason == "worktree has local changes" {
                            dirty_reason(path).unwrap_or_else(|| reason.to_owned())
                        } else {
                            reason.to_owned()
                        });
                }
                Ok(wt::Outcome::KeptIgnored(path)) => {
                    entry["reason"] = serde_json::json!(format!("Has ignored files ({path})"));
                }
                Err(error) => {
                    entry["outcome"] = serde_json::json!("failed");
                    entry["reason"] = serde_json::json!(error.to_string());
                }
            }
            entries.push(entry);
        }
    }

    fn report_orphan_worktrees(
        &self,
        bus: &crate::event_bus::EventBus,
        settings: &serde_json::Value,
        now: SystemTime,
        entries: &mut Vec<serde_json::Value>,
    ) {
        let enabled = |policy: &serde_json::Value| {
            ["worktreeAfterDays", "worktreeSettledAfterDays"]
                .iter()
                .any(|k| policy[*k].is_u64())
                || ["worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"]
                    .iter()
                    .any(|k| policy[*k] == true)
        };
        let override_enabled = settings["projectSettingsOverrides"]
            .as_object()
            .is_some_and(|m| {
                m.keys().any(|id| {
                    enabled(&crate::storage_cleanup_worktrees::resolve_policy(
                        settings, id,
                    ))
                })
            });
        if !enabled(&crate::storage_cleanup_worktrees::resolve_policy(
            settings, "",
        )) && !override_enabled
        {
            return;
        }
        let paths = bus.with_autocommit(|db| -> rusqlite::Result<(Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
            let mut referenced = Vec::new();
            let mut stmt = db.prepare("SELECT DISTINCT json_extract(payload_json,'$.worktreePath') FROM orchestration_v2_projection_threads WHERE json_type(payload_json,'$.worktreePath')='text'")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))? { let p = std::path::PathBuf::from(row?); if p.is_absolute() { referenced.push(fs::canonicalize(&p).unwrap_or(p)); } else { return Err(rusqlite::Error::InvalidQuery); } }
            let mut projects = Vec::new();
            let mut stmt = db.prepare("SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL")?;
            for row in stmt.query_map([], |r| r.get::<_, String>(0))? { let p = std::path::PathBuf::from(row?); if !p.is_absolute() { return Err(rusqlite::Error::InvalidQuery); } projects.push(fs::canonicalize(&p).unwrap_or(p)); }
            Ok((referenced, projects))
        });
        let Ok(Ok((referenced, projects))) = paths else {
            return;
        };
        let mut roots = Vec::new();
        if let Some(root) = bus.worktrees_dir() {
            roots.push(root);
        }
        if let Some(root) = settings["worktreesDirectory"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            roots.push(root.into());
        }
        if let Some(previous) = settings["previousWorktreesDirectories"].as_array() {
            roots.extend(previous.iter().filter_map(|v| v.as_str().map(Into::into)));
        }
        let dirs = |path: &Path| -> Vec<std::path::PathBuf> {
            fs::read_dir(path)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let meta = e.file_type().ok()?;
                    if !meta.is_dir() || meta.is_symlink() {
                        return None;
                    }
                    let path = e.path();
                    let canonical = fs::canonicalize(&path).ok()?;
                    (canonical == path).then_some(path)
                })
                .collect()
        };
        let mut seen = std::collections::HashSet::new();
        for root in roots
            .into_iter()
            .filter_map(|p| fs::canonicalize(p).ok())
            .filter(|p| p.parent().is_some())
        {
            for parent in dirs(&root) {
                let candidates = if parent.join(".git").is_file() {
                    vec![parent]
                } else if parent.join(".git").exists() {
                    vec![]
                } else {
                    dirs(&parent)
                };
                for path in candidates {
                    if !seen.insert(path.clone())
                        || referenced
                            .iter()
                            .any(|p| p == &path || p.starts_with(&path))
                        || projects
                            .iter()
                            .any(|p| p.starts_with(&path) || path.starts_with(p))
                    {
                        continue;
                    }
                    let Ok(meta) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if meta
                        .modified()
                        .ok()
                        .and_then(|t| now.duration_since(t).ok())
                        .is_none_or(|age| age < Duration::from_secs(3600))
                    {
                        continue;
                    }
                    let linked = fs::symlink_metadata(path.join(".git")).is_ok_and(|m| m.is_file());
                    entries.push(serde_json::json!({"kind":"worktree","outcome":"kept","reason":if linked { "No thread uses this worktree" } else { "No thread uses this folder, and it isn't a git worktree" },"path":path,"projectPath":null,"threadId":null,"threadTitle":null,"bytes":worktree_bytes(&path),"files":null}));
                }
            }
        }
    }

    fn sweep_blocking(&self, trigger: &str) -> serde_json::Value {
        let now = SystemTime::now();
        let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let policy = self.settings.snapshot()["storageCleanup"].clone();
        let mut entries = Vec::new();
        self.clean_worktrees(now, &mut entries);
        for (kind, label, key, root, category) in [
            (
                "browser-artifacts",
                "browser artifacts",
                "browserArtifactsAfterDays",
                &self.artifacts,
                FileCategory::BrowserArtifacts,
            ),
            (
                "logs",
                "rotated logs",
                "logsAfterDays",
                &self.logs,
                FileCategory::RotatedLogs,
            ),
        ] {
            let Some(days) = policy[key].as_u64().and_then(|n| u32::try_from(n).ok()) else {
                continue;
            };
            let result = clean_files(root, category, Some(days), now, || {
                Ok(self.settings.snapshot()["storageCleanup"][key]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok()))
            });
            let (outcome, reason, removed) = match result {
                Ok(r) if r.files == 0 => ("kept", "No expired files".to_owned(), r),
                Ok(r) => ("removed", format!("Removed {} {}", r.files, label), r),
                Err(e) => ("failed", e.source.to_string(), e.removed),
            };
            entries.push(serde_json::json!({"kind":kind,"outcome":outcome,"reason":reason,"path":null,"projectPath":null,"threadId":null,"threadTitle":null,"bytes":if removed.files > 0 {Some(removed.bytes)} else {None},"files":if removed.files > 0 {Some(removed.files)} else {None}}));
        }
        entries.sort_by_key(|entry| match entry["outcome"].as_str() {
            Some("failed") => 0,
            Some("removed") => 1,
            _ => 2,
        });
        let count = |outcome: &str| {
            entries
                .iter()
                .filter(|entry| entry["outcome"] == outcome)
                .count()
        };
        let bytes: u64 = entries
            .iter()
            .filter(|entry| entry["outcome"] != "kept")
            .filter_map(|entry| entry["bytes"].as_u64())
            .sum();
        let report = serde_json::json!({"trigger":trigger,"startedAt":started,"finishedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),"counts":{"removed":count("removed"),"kept":count("kept"),"failed":count("failed")},"omittedCount":entries.len().saturating_sub(200),"bytesFreed":bytes,"entries":entries.into_iter().take(200).collect::<Vec<_>>()});
        self.reports.send_replace(Some(report.clone()));
        report
    }
}

#[cfg(all(test, unix))]
mod service_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn merged_pr_must_unambiguously_match_branch_and_head() {
        let pr = serde_json::json!({"state":"MERGED","headRefName":"feature","headRefOid":"abc","baseRefName":"main"});
        assert!(merged_pr_evidence(
            &serde_json::json!([pr]),
            "feature",
            "abc",
            "main",
            false
        ));
        assert!(!merged_pr_evidence(
            &serde_json::json!([pr]),
            "feature",
            "def",
            "main",
            false
        ));
        assert!(!merged_pr_evidence(
            &serde_json::json!([pr]),
            "feature",
            "abc",
            "other",
            false
        ));
        assert!(!merged_pr_evidence(
            &serde_json::json!([pr]),
            "feature",
            "def",
            "other",
            true
        ));
        assert!(!merged_pr_evidence(
            &serde_json::json!([pr, pr]),
            "feature",
            "abc",
            "main",
            false
        ));
        assert!(!merged_pr_evidence(
            &serde_json::json!({}),
            "feature",
            "abc",
            "main",
            false
        ));
    }

    #[tokio::test]
    async fn removes_only_old_idle_clean_registered_worktrees() {
        use std::process::Command;
        let root =
            std::env::temp_dir().join(format!("t3-cleanup-integration-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let managed = root.join("worktrees");
        let tree = managed.join("tree");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&managed).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&project)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.com"]);
        fs::write(project.join("file"), "initial").unwrap();
        git(&["add", "file"]);
        git(&["commit", "-qm", "initial"]);
        git(&[
            "worktree",
            "add",
            "-qb",
            "cleanup-test",
            tree.to_str().unwrap(),
        ]);
        assert!(unchanged_project_branch(&project, &tree).is_some());
        fs::write(tree.join("file"), "new commit").unwrap();
        for args in [
            ["add", "file"].as_slice(),
            ["commit", "-qm", "change"].as_slice(),
        ] {
            assert!(Command::new("git")
                .current_dir(&tree)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        assert!(unchanged_project_branch(&project, &tree).is_none());
        assert!(Command::new("git")
            .current_dir(&tree)
            .args(["reset", "--hard", "HEAD~1"])
            .output()
            .unwrap()
            .status
            .success());
        let bare = root.join("remote.git");
        assert!(Command::new("git")
            .args(["init", "--bare", "-q", bare.to_str().unwrap()])
            .status()
            .unwrap()
            .success());
        git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&["push", "-q", "origin", "HEAD:refs/heads/main"]);
        assert!(Command::new("git")
            .arg("--git-dir")
            .arg(&bare)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .status()
            .unwrap()
            .success());
        assert_eq!(
            unchanged_project_branch(&project, &tree),
            Some("No commits beyond the default branch")
        );
        git(&["remote", "remove", "origin"]);
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P',?1,'[]','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')", [project.to_str().unwrap()]).unwrap();
        let payload = serde_json::json!({"id":"t","projectId":"p","title":"T","worktreePath":tree,"branch":"cleanup-test","createdAt":"2020-01-01T00:00:00Z","updatedAt":"2020-01-01T00:00:00Z"}).to_string();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','auto','default','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z',?1)",[payload]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        bus.set_worktrees_dir(managed);
        let settings = Arc::new(crate::settings::Settings::new(root.join("settings.json")));
        settings
            .update(&serde_json::json!({"storageCleanup":{"worktreeAfterDays":1}}))
            .unwrap();
        let cleanup =
            StorageCleanup::new(settings.clone(), root.join("artifacts"), root.join("logs"));
        cleanup.set_worktree_context(
            bus.clone(),
            Arc::new(crate::terminal::TerminalManager::default()),
        );
        fs::write(tree.join("untracked"), "keep").unwrap();
        let first = cleanup.run_now().await;
        assert_eq!(first["counts"]["removed"], 0, "{first}");
        assert!(tree.exists());
        fs::remove_file(tree.join("untracked")).unwrap();
        bus.with_autocommit(|db| db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('r','t',1,'codex','queued','2020-01-01T00:00:00Z',?1)", [serde_json::json!({"id":"r","status":"queued","queueHeld":true}).to_string()]).unwrap()).unwrap();
        let queued = cleanup.run_now().await;
        assert_eq!(queued["counts"]["removed"], 0, "{queued}");
        assert!(tree.exists());
        bus.with_autocommit(|db| {
            db.execute(
                "DELETE FROM orchestration_v2_projection_runs WHERE run_id='r'",
                [],
            )
            .unwrap()
        })
        .unwrap();
        let second = cleanup.run_now().await;
        assert_eq!(second["counts"]["removed"], 1, "{second}");
        assert!(!tree.exists());
        git(&[
            "worktree",
            "add",
            "-q",
            tree.to_str().unwrap(),
            "cleanup-test",
        ]);
        bus.with_autocommit(|db| db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledAt','2020-01-02T00:00:00Z') WHERE thread_id='t'", []).unwrap()).unwrap();
        settings.update(&serde_json::json!({"storageCleanup":{"worktreeAfterDays":null,"worktreeUnchanged":true}})).unwrap();
        let unchanged = cleanup.run_now().await;
        assert_eq!(unchanged["counts"]["removed"], 1, "{unchanged}");
        assert_eq!(
            unchanged["entries"][0]["reason"],
            "No commits beyond the project branch"
        );
        assert!(!tree.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reports_file_results_and_unimplemented_worktrees() {
        let root =
            std::env::temp_dir().join(format!("t3-cleanup-service-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("artifacts")).unwrap();
        fs::create_dir_all(root.join("logs")).unwrap();
        let old = root.join("logs/server.log.1");
        fs::write(&old, b"abc").unwrap();
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();
        let settings = Arc::new(crate::settings::Settings::new(root.join("settings.json")));
        settings
            .update(
                &serde_json::json!({"storageCleanup":{"logsAfterDays":1,"worktreeOnDelete":true}}),
            )
            .unwrap();
        let cleanup = StorageCleanup::new(settings, root.join("artifacts"), root.join("logs"));
        let mut reports = cleanup.subscribe();
        assert!(reports.borrow().is_none());
        let report = cleanup.run_now().await;
        reports.changed().await.unwrap();
        assert_eq!(report["trigger"], "manual");
        assert_eq!(report["counts"]["removed"], 1);
        assert_eq!(report["counts"]["failed"], 1);
        assert_eq!(report["bytesFreed"], 3);
        assert_eq!(cleanup.latest_report(), Some(report));
        assert!(!old.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
