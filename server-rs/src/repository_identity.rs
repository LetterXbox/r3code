//! Resolve a project's Git remote identity for shell snapshots.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

const POSITIVE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);
const CACHE_CAPACITY: usize = 512;
const QUEUE_CAPACITY: usize = 256;
const SCAN_INTERVAL: Duration = Duration::from_secs(1);

/// A completed lookup. `None` means the lookup found no remote identity.
#[derive(Clone, Debug)]
pub struct IdentityChange {
    pub root: String,
    pub identity: Option<Value>,
}

struct CacheEntry {
    identity: Option<Value>,
    resolved_at: Option<Instant>,
    last_used: Instant,
    pending: bool,
    generation: u64,
    fingerprint: Option<u64>,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CacheEntry>,
    generation: u64,
}

/// Nonblocking, bounded cache. Git runs on a dedicated worker, never on callers.
#[derive(Clone)]
pub struct RepositoryIdentityCache {
    state: Arc<Mutex<CacheState>>,
    queue: mpsc::SyncSender<(String, u64)>,
    changes: tokio::sync::broadcast::Sender<IdentityChange>,
}

impl Default for RepositoryIdentityCache {
    fn default() -> Self {
        let state = Arc::new(Mutex::new(CacheState::default()));
        let (queue, receiver) = mpsc::sync_channel::<(String, u64)>(QUEUE_CAPACITY);
        let (changes, _) = tokio::sync::broadcast::channel(256);
        let worker_state = Arc::downgrade(&state);
        let worker_changes = changes.clone();
        std::thread::spawn(move || {
            while let Ok((root, generation)) = receiver.recv() {
                let Some(worker_state) = worker_state.upgrade() else {
                    break;
                };
                // Drop obsolete work before launching a subprocess.
                if !worker_state
                    .lock()
                    .unwrap()
                    .entries
                    .get(&root)
                    .is_some_and(|entry| entry.pending && entry.generation == generation)
                {
                    continue;
                }
                let fingerprint = repository_fingerprint(&root);
                {
                    let mut state = worker_state.lock().unwrap();
                    if let Some(entry) = state
                        .entries
                        .get_mut(&root)
                        .filter(|entry| entry.generation == generation)
                    {
                        entry.fingerprint.get_or_insert(fingerprint);
                    }
                }
                let identity = resolve(&root);
                let mut state = worker_state.lock().unwrap();
                if let Some(entry) = state
                    .entries
                    .get_mut(&root)
                    .filter(|entry| entry.pending && entry.generation == generation)
                {
                    let changed = entry.resolved_at.is_none() || entry.identity != identity;
                    entry.identity = identity.clone();
                    entry.resolved_at = Some(Instant::now());
                    entry.pending = false;
                    if changed {
                        let _ = worker_changes.send(IdentityChange { root, identity });
                    }
                }
            }
        });
        // One bounded polling thread covers all cached roots, including worktrees and
        // bare repositories. Weak ownership lets both background threads shut down
        // when the cache is dropped.
        let scan_state = Arc::downgrade(&state);
        let scan_queue = queue.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(SCAN_INTERVAL);
            let Some(state) = scan_state.upgrade() else {
                break;
            };
            let roots: Vec<_> = state.lock().unwrap().entries.keys().cloned().collect();
            for root in roots {
                let fingerprint = repository_fingerprint(&root);
                let mut state = state.lock().unwrap();
                let changed = state.entries.get(&root).is_some_and(|entry| {
                    entry
                        .fingerprint
                        .is_some_and(|previous| previous != fingerprint)
                });
                if changed {
                    state.generation = state.generation.wrapping_add(1);
                    let generation = state.generation;
                    let entry = state.entries.get_mut(&root).unwrap();
                    entry.generation = generation;
                    entry.pending = scan_queue.try_send((root.clone(), generation)).is_ok();
                    // Retry through get() if the bounded queue is full.
                    if !entry.pending {
                        entry.resolved_at = None;
                    }
                }
                if let Some(entry) = state.entries.get_mut(&root) {
                    entry.fingerprint = Some(fingerprint);
                    if !entry.pending && entry.resolved_at.is_none() {
                        entry.pending = scan_queue
                            .try_send((root.clone(), entry.generation))
                            .is_ok();
                    }
                }
            }
        });
        Self {
            state,
            queue,
            changes,
        }
    }
}

impl RepositoryIdentityCache {
    /// Return the last value immediately and schedule missing or stale work.
    pub fn get(&self, root: &str) -> Option<Value> {
        self.get_with_status(root).0
    }

    /// Atomically read the identity and whether a lookup has completed.
    pub fn get_with_status(&self, root: &str) -> (Option<Value>, bool) {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        if !state.entries.contains_key(root) {
            if state.entries.len() >= CACHE_CAPACITY {
                if let Some(oldest) = state
                    .entries
                    .iter()
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(k, _)| k.clone())
                {
                    state.entries.remove(&oldest);
                }
            }
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            state.entries.insert(
                root.to_owned(),
                CacheEntry {
                    identity: None,
                    resolved_at: None,
                    last_used: now,
                    pending: false,
                    generation,
                    fingerprint: None,
                },
            );
        }
        let entry = state.entries.get_mut(root).unwrap();
        entry.last_used = now;
        if !entry.pending
            && entry.resolved_at.is_none_or(|at| {
                now.duration_since(at)
                    >= if entry.identity.is_some() {
                        POSITIVE_CACHE_TTL
                    } else {
                        NEGATIVE_CACHE_TTL
                    }
            })
        {
            entry.pending = true;
            if self
                .queue
                .try_send((root.to_owned(), entry.generation))
                .is_err()
            {
                entry.pending = false;
            }
        }
        (entry.identity.clone(), entry.resolved_at.is_some())
    }

    pub fn is_resolved(&self, root: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .entries
            .get(root)
            .is_some_and(|entry| entry.resolved_at.is_some())
    }

    /// Discard a cached result and invalidate any in-flight lookup.
    pub fn invalidate(&self, root: &str) {
        self.state.lock().unwrap().entries.remove(root);
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<IdentityChange> {
        self.changes.subscribe()
    }
}

// Hash small Git metadata files so atomic replacement, removal and recreation are
// detected as well as edits with unchanged timestamps. Walk ancestors to handle
// projects rooted below the repository and .git files used by linked worktrees.
fn repository_fingerprint(root: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let root = Path::new(root);
    let mut git_dir: Option<PathBuf> = None;
    for ancestor in root.ancestors() {
        let dot_git = ancestor.join(".git");
        hash_file(&dot_git, &mut hasher);
        if dot_git.is_dir() {
            git_dir = Some(dot_git);
            break;
        }
        if let Some(contents) = read_small_file(&dot_git).and_then(|b| String::from_utf8(b).ok()) {
            if let Some(path) = contents.trim().strip_prefix("gitdir: ") {
                git_dir = Some(ancestor.join(path));
                break;
            }
        }
        if ancestor.join("HEAD").is_file() && ancestor.join("objects").is_dir() {
            git_dir = Some(ancestor.to_path_buf());
            break;
        }
    }
    if let Some(dir) = git_dir {
        hash_file(&dir.join("commondir"), &mut hasher);
        let common = read_small_file(&dir.join("commondir"))
            .and_then(|b| String::from_utf8(b).ok())
            .map(|path| dir.join(path.trim()))
            .unwrap_or_else(|| dir.clone());
        hash_file(&common.join("config"), &mut hasher);
        hash_file(&dir.join("config.worktree"), &mut hasher);
    }
    hasher.finish()
}

fn read_small_file(path: &Path) -> Option<Vec<u8>> {
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.file_type().is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn hash_file(path: &Path, hasher: &mut impl Hasher) {
    path.hash(hasher);
    read_small_file(path).hash(hasher);
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let _ = (&mut stdout).take(1024 * 1024).read_to_end(&mut data);
        let _ = sender.send(data);
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let data = receiver.recv_timeout(Duration::from_millis(100)).ok()?;
    success.then(|| String::from_utf8_lossy(&data).into_owned())
}

// Never publish credentials or URL query parameters from Git configuration.
fn safe_remote(remote: &str) -> String {
    if let Ok(mut url) = url::Url::parse(remote) {
        if remote.contains("://") {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
    }
    // SCP-style URLs can also contain user information and query-like secrets.
    let remote = remote.split(['?', '#']).next().unwrap_or("");
    if let Some((authority, path)) = remote.split_once(':') {
        return format!("{}:{path}", authority.rsplit('@').next().unwrap_or(""));
    }
    remote.to_owned()
}

fn remote_parts(remote: &str) -> Option<(String, String)> {
    let (host, path) = if remote.contains("://") {
        let url = url::Url::parse(remote).ok()?;
        if url.scheme() == "file" {
            return None;
        }
        let host = url.host_str()?.to_lowercase();
        let host = if matches!(url.scheme(), "http" | "https") {
            url.port()
                .map_or(host.clone(), |port| format!("{host}:{port}"))
        } else {
            host
        };
        (host, url.path().to_owned())
    } else {
        let colon = remote.find(':')?;
        if remote[..colon].contains(['/', '\\']) || colon == 1 {
            return None;
        }
        (
            remote[..colon].rsplit('@').next()?.to_lowercase(),
            remote[colon + 1..].to_owned(),
        )
    };
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        None
    } else {
        Some((host, path.to_owned()))
    }
}

fn is_public_ssh_forge(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com"
            | "gitlab.com"
            | "bitbucket.org"
            | "codeberg.org"
            | "ssh.dev.azure.com"
            | "vs-ssh.visualstudio.com"
    )
}

fn ssh_resolved_remote_url(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    if trimmed.contains("://") && !trimmed.starts_with("ssh://") {
        return None;
    }
    let (scheme, after_scheme) = if let Some(rest) = trimmed.strip_prefix("ssh://") {
        ("ssh://", rest)
    } else {
        ("", trimmed)
    };
    let (user, authority_and_rest) = match after_scheme.split_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, after_scheme),
    };
    let split_idx = authority_and_rest.find([':', '/'])?;
    let host = &authority_and_rest[..split_idx];
    let rest = &authority_and_rest[split_idx..];
    if host.is_empty() || host.starts_with('-') || user.is_some_and(|u| u.starts_with('-')) {
        return None;
    }
    if is_public_ssh_forge(host) {
        return None;
    }
    let target = match user {
        Some(u) if !u.is_empty() => format!("{u}@{host}"),
        _ => host.to_owned(),
    };
    let out = Command::new("ssh")
        .args(["-G", &target])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let hostname = stdout
        .lines()
        .find_map(|line| line.strip_prefix("hostname "))?
        .trim()
        .to_ascii_lowercase();
    if hostname.is_empty()
        || hostname == host.to_ascii_lowercase()
        || hostname.split('.').all(|p| p.chars().all(|c| c.is_ascii_digit()))
        || !hostname
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        || (host.contains('.') && !is_public_ssh_forge(&hostname))
    {
        return None;
    }
    let user_prefix = user.map(|u| format!("{u}@")).unwrap_or_default();
    Some(format!("{scheme}{user_prefix}{hostname}{rest}"))
}

fn canonical_key(host: &str, path: &str) -> String {
    let key = format!("{}/{}", host, path.to_lowercase());
    let segments: Vec<_> = key.split('/').collect();
    if segments.len() == 5 && segments[1] == "v3" {
        if segments[0] == "ssh.dev.azure.com" {
            return format!(
                "dev.azure.com/{}/{}/_git/{}",
                segments[2], segments[3], segments[4]
            );
        }
        if segments[0] == "vs-ssh.visualstudio.com" {
            return format!(
                "{}.visualstudio.com/{}/_git/{}",
                segments[2], segments[3], segments[4]
            );
        }
    }
    key
}

/// Returns None for a non-repository or a repository with only local remotes.
pub fn resolve(cwd: &str) -> Option<Value> {
    if !Path::new(cwd).is_dir() {
        return None;
    }
    let (root, bare) = if let Some(root) = git(cwd, &["rev-parse", "--show-toplevel"]) {
        (root.trim_end_matches(['\r', '\n']).to_owned(), false)
    } else {
        let result = git(
            cwd,
            &[
                "--git-dir=.",
                "rev-parse",
                "--is-bare-repository",
                "--absolute-git-dir",
            ],
        )?;
        let mut lines = result.lines();
        if lines.next()? != "true" {
            return None;
        }
        (lines.next()?.to_owned(), true)
    };
    let prefix: &[&str] = if bare { &["--git-dir=."] } else { &[] };
    let mut args = prefix.to_vec();
    args.extend(["remote", "-v"]);
    let output = git(&root, &args)?;
    let mut remotes = BTreeMap::new();
    for line in output.lines() {
        if let Some((name, rest)) = line.split_once('\t') {
            if let Some((url, _)) = rest.split_once(" (fetch)") {
                if remote_parts(url).is_some() {
                    remotes.insert(name.to_owned(), safe_remote(url));
                }
            }
        }
    }
    let mut args = prefix.to_vec();
    args.extend(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]);
    let marks = git(&root, &args).unwrap_or_default();
    let marks: Vec<_> = marks
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(char::is_whitespace)?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".gh-resolved")?;
            remotes.get(name).map(|url| (name, url, value.trim()))
        })
        .collect();
    let marked = if marks.len() == 1 {
        let (name, url, value) = marks[0];
        if value == "base" {
            Some((name, url))
        } else {
            let host = remote_parts(url).map(|p| p.0);
            remotes
                .iter()
                .find(|(_, u)| {
                    remote_parts(u)
                        .is_some_and(|(h, p)| Some(h) == host && p.eq_ignore_ascii_case(value))
                })
                .map(|(n, u)| (n.as_str(), u))
        }
    } else {
        None
    };
    let (name, remote) = marked
        .or_else(|| {
            ["upstream", "origin"]
                .into_iter()
                .find_map(|n| remotes.get(n).map(|u| (n, u)))
        })
        .or_else(|| remotes.iter().next().map(|(n, u)| (n.as_str(), u)))?;
    let resolved_remote = ssh_resolved_remote_url(remote);
    let (host, path) = remote_parts(resolved_remote.as_deref().unwrap_or(remote))?;
    let key = canonical_key(&host, &path);
    let display = if key
        .split_once('/')
        .is_some_and(|(_, p)| p == path.to_lowercase())
    {
        path.clone()
    } else {
        key.split_once('/')
            .map(|(_, p)| p.to_owned())
            .unwrap_or_default()
    };
    let mut identity = json!({"canonicalKey":key,"locator":{"source":"git-remote","remoteName":name,"remoteUrl":remote},"rootPath":root,"displayName":display,"owner":display.split('/').next()?,"name":display.rsplit('/').next()?});
    let hostname = host.split(':').next().unwrap_or(&host);
    let labels: Vec<_> = hostname.split('.').collect();
    let provider = if hostname == "github.com"
        || hostname.ends_with(".ghe.com")
        || labels.contains(&"github")
    {
        Some("github")
    } else if hostname == "origin.cursor.com" {
        Some("cursor-origin")
    } else if hostname == "gitlab.com" || labels.contains(&"gitlab") {
        Some("gitlab")
    } else if matches!(hostname, "git.cafe" | "staging.git.cafe") {
        Some("gitcafe")
    } else if hostname == "codeberg.org" || labels.contains(&"forgejo") || labels.contains(&"gitea")
    {
        Some("forgejo")
    } else if hostname == "bitbucket.org" || labels.contains(&"bitbucket") {
        Some("bitbucket")
    } else if hostname == "dev.azure.com"
        || hostname.ends_with(".dev.azure.com")
        || hostname.ends_with(".visualstudio.com")
    {
        Some("azure-devops")
    } else {
        None
    };
    if let Some(provider) = provider {
        identity["provider"] = json!(provider);
    }
    if let Some(origin_raw) = remotes.get("origin") {
        let origin_resolved = ssh_resolved_remote_url(origin_raw);
        if let Some((oh, op)) = remote_parts(origin_resolved.as_deref().unwrap_or(origin_raw)) {
            let origin_key = canonical_key(&oh, &op);
            if origin_key != key {
                let origin_display = if origin_key
                    .split_once('/')
                    .is_some_and(|(_, p)| p == op.to_lowercase())
                {
                    op
                } else {
                    origin_key
                        .split_once('/')
                        .map(|(_, p)| p.to_owned())
                        .unwrap_or_default()
                };
                identity["origin"] = json!({"canonicalKey":origin_key,"remoteUrl":origin_raw,"displayName":origin_display});
            }
        }
    }
    Some(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_resolves_and_refreshes_after_invalidation() {
        let dir = std::env::temp_dir().join(format!("identity-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        git(root, &["init"]).unwrap();
        git(
            root,
            &["remote", "add", "origin", "https://github.com/one/repo.git"],
        )
        .unwrap();
        let cache = RepositoryIdentityCache::default();
        let mut changes = cache.subscribe();
        assert_eq!(cache.get(root), None);
        let deadline = Instant::now() + Duration::from_secs(5);
        let change = loop {
            if let Ok(change) = changes.try_recv() {
                break change;
            }
            assert!(Instant::now() < deadline, "lookup timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            change.identity.unwrap()["canonicalKey"],
            "github.com/one/repo"
        );
        assert_eq!(
            cache.get(root).unwrap()["canonicalKey"],
            "github.com/one/repo"
        );
        git(
            root,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/two/repo.git",
            ],
        )
        .unwrap();
        cache.invalidate(root);
        assert_eq!(cache.get(root), None);
        let deadline = Instant::now() + Duration::from_secs(5);
        let change = loop {
            if let Ok(change) = changes.try_recv() {
                break change;
            }
            assert!(Instant::now() < deadline, "refresh timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            change.identity.unwrap()["canonicalKey"],
            "github.com/two/repo"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn cache_refreshes_when_git_config_changes_without_another_read() {
        let dir = std::env::temp_dir().join(format!("identity-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        git(root, &["init"]).unwrap();
        git(
            root,
            &["remote", "add", "origin", "https://github.com/one/repo.git"],
        )
        .unwrap();
        let cache = RepositoryIdentityCache::default();
        let mut changes = cache.subscribe();
        cache.get(root);
        let deadline = Instant::now() + Duration::from_secs(8);
        let wait = |changes: &mut tokio::sync::broadcast::Receiver<IdentityChange>| loop {
            if let Ok(change) = changes.try_recv() {
                break change;
            }
            assert!(Instant::now() < deadline, "identity update timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            wait(&mut changes).identity.unwrap()["canonicalKey"],
            "github.com/one/repo"
        );
        git(
            root,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/two/repo.git",
            ],
        )
        .unwrap();
        assert_eq!(
            wait(&mut changes).identity.unwrap()["canonicalKey"],
            "github.com/two/repo"
        );
        git(root, &["remote", "remove", "origin"]).unwrap();
        assert!(wait(&mut changes).identity.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn fingerprint_skips_special_files_and_symlinks() {
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!("identity-special-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join(".git");
        let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(read_small_file(&fifo).is_none());
        repository_fingerprint(dir.to_str().unwrap());
        std::fs::remove_file(&fifo).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", &fifo).unwrap();
        assert!(read_small_file(&fifo).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn normalizes_remote_forms_and_rejects_local() {
        assert_eq!(
            safe_remote("https://user:secret@github.com/Owner/Repo.git?token=secret"),
            "https://github.com/Owner/Repo.git"
        );
        assert_eq!(
            remote_parts("git@github.com:Owner/Repo.git"),
            Some(("github.com".into(), "Owner/Repo".into()))
        );
        assert_eq!(
            remote_parts("https://gitlab.com:8443/group/repo.git?x=1"),
            Some(("gitlab.com:8443".into(), "group/repo".into()))
        );
        assert_eq!(remote_parts("/tmp/repo"), None);
        assert_eq!(remote_parts("file:///tmp/repo"), None);
    }
    #[test]
    fn recognizes_providers_and_normalizes_azure_ssh_identity() {
        let dir = std::env::temp_dir().join(format!("identity-providers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        git(root, &["init"]).unwrap();
        git(
            root,
            &[
                "remote",
                "add",
                "origin",
                "git@ssh.dev.azure.com:v3/Org/Project/Repo",
            ],
        )
        .unwrap();
        let identity = resolve(root).unwrap();
        assert_eq!(
            identity["canonicalKey"],
            "dev.azure.com/org/project/_git/repo"
        );
        assert_eq!(identity["provider"], "azure-devops");
        assert_eq!(identity["displayName"], "org/project/_git/repo");
        assert_eq!(
            identity["locator"]["remoteUrl"],
            "ssh.dev.azure.com:v3/Org/Project/Repo"
        );
        for (url, provider) in [
            ("https://github.example/a/b", "github"),
            ("https://gitlab.example/a/b", "gitlab"),
            ("https://codeberg.org/a/b", "forgejo"),
            ("https://bitbucket.org/a/b", "bitbucket"),
            ("https://git.cafe/a/b", "gitcafe"),
            ("https://origin.cursor.com/a/b", "cursor-origin"),
        ] {
            git(root, &["remote", "set-url", "origin", url]).unwrap();
            assert_eq!(resolve(root).unwrap()["provider"], provider);
        }
        git(
            root,
            &[
                "remote",
                "set-url",
                "origin",
                "https://user:secret@github.com/a/b?token=secret#secret",
            ],
        )
        .unwrap();
        assert!(!resolve(root).unwrap().to_string().contains("secret"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn resolves_real_repository_and_prefers_upstream() {
        let dir = std::env::temp_dir().join(format!(
            "identity-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        assert!(git(root, &["init"]).is_some());
        git(
            root,
            &["remote", "add", "origin", "git@github.com:Fork/Repo.git"],
        )
        .unwrap();
        git(
            root,
            &[
                "remote",
                "add",
                "upstream",
                "https://github.com/Owner/Repo.git",
            ],
        )
        .unwrap();
        let id = resolve(root).unwrap();
        assert_eq!(id["canonicalKey"], "github.com/owner/repo");
        assert_eq!(id["origin"]["canonicalKey"], "github.com/fork/repo");
        git(root, &["config", "remote.origin.gh-resolved", "base"]).unwrap();
        assert_eq!(resolve(root).unwrap()["locator"]["remoteName"], "origin");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
