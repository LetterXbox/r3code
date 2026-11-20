//! Executable resolution for provider CLIs launched by a GUI process whose
//! PATH misses whatever the user's shell init adds (nvm, asdf, mise, volta,
//! custom npm prefixes…). Mirrors `tools/r3_server_supervisor.swift`'s
//! `augmentedPath` plus a condensed login-shell PATH snapshot, adapted (not
//! copied) from `zuse/crates/providers/src/shell_env.rs`: same idea (ask the
//! real shell once, cache it, hard timeout, read on a side thread so a shell
//! that blocks after printing can't wedge discovery), much smaller.
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const SHELL_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);
const EXIT_FLUSH_GRACE: Duration = Duration::from_millis(150);
const MAX_OUTPUT: usize = 256 * 1024;
const BEGIN: &str = "__T3_SHELL_PATH_BEGIN__";
const END: &str = "__T3_SHELL_PATH_END__";

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_snapshot_path(output: &[u8]) -> Option<String> {
    let begin = find_subslice(output, BEGIN.as_bytes())?;
    let after = &output[begin + BEGIN.len()..];
    let end = find_subslice(after, END.as_bytes())?;
    for line in after[..end].split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(value) = line.strip_prefix(b"PATH=") {
            if !value.is_empty() {
                return Some(String::from_utf8_lossy(value).into_owned());
            }
        }
    }
    None
}

#[cfg(unix)]
fn snapshot_path(shell: &Path) -> Option<String> {
    let script = format!("echo {BEGIN}; printf 'PATH=%s\\n' \"$PATH\"; echo {END}");
    for flags in [vec!["-l", "-i", "-c"], vec!["-l", "-c"]] {
        let mut cmd = Command::new(shell);
        cmd.args(&flags)
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("TERM", "dumb");
        let Ok(mut child) = cmd.spawn() else {
            continue;
        };
        let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut stdout) = child.stdout.take() {
            let buf = Arc::clone(&buf);
            let _ = std::thread::Builder::new()
                .name("t3-shell-env-read".into())
                .spawn(move || {
                    use std::io::Read;
                    let mut chunk = [0u8; 4096];
                    loop {
                        match stdout.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut b = buf.lock().unwrap_or_else(|e| e.into_inner());
                                if b.len() >= MAX_OUTPUT {
                                    break;
                                }
                                b.extend_from_slice(&chunk[..n]);
                            }
                        }
                    }
                });
        }
        let deadline = Instant::now() + SHELL_SNAPSHOT_TIMEOUT;
        let mut exited_at: Option<Instant> = None;
        loop {
            {
                let b = buf.lock().unwrap_or_else(|e| e.into_inner());
                if find_subslice(&b, END.as_bytes()).is_some() {
                    break;
                }
            }
            match exited_at {
                Some(at) if at.elapsed() >= EXIT_FLUSH_GRACE => break,
                Some(_) => {}
                None => match child.try_wait() {
                    Ok(Some(_)) => exited_at = Some(Instant::now()),
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => break,
                },
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if exited_at.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let out = buf.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(path) = parse_snapshot_path(&out) {
            return Some(path);
        }
    }
    None
}

#[cfg(not(unix))]
fn snapshot_path(_shell: &Path) -> Option<String> {
    None
}

fn user_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

static LOGIN_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

/// The user's login shell PATH, captured once and cached for the process.
fn login_shell_path() -> Option<&'static str> {
    if std::env::var_os("T3CODE_NO_LOGIN_SHELL_PATH").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    LOGIN_SHELL_PATH
        .get_or_init(|| user_shell().and_then(|shell| snapshot_path(&shell)))
        .as_deref()
}

/// Extra directories a GUI-launched process is missing, matching
/// `tools/r3_server_supervisor.swift`'s `augmentedPath`.
fn static_extra_dirs(home: &str) -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin".to_owned(),
        "/usr/local/bin".to_owned(),
        format!("{home}/.local/share/vite-plus/bin"),
        format!("{home}/.nvm/current/bin"),
        format!("{home}/.local/share/mise/shims"),
        format!("{home}/.bun/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.fnm/aliases/default/bin"),
        "/usr/bin".to_owned(),
        "/bin".to_owned(),
        "/usr/sbin".to_owned(),
        "/sbin".to_owned(),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn candidate_dirs(home: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(shell_path) = login_shell_path() {
        dirs.extend(std::env::split_paths(&OsString::from(shell_path)));
    }
    if let Some(home) = home {
        dirs.extend(static_extra_dirs(home));
        // nvm without the shell function loaded has no `current` symlink;
        // fall back to every installed version's bin directory.
        if let Ok(entries) = std::fs::read_dir(Path::new(home).join(".nvm/versions/node")) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    let mut seen = HashSet::new();
    dirs.into_iter().filter(|d| seen.insert(d.clone())).collect()
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Search PATH plus the augmented/login-shell directories for `name`.
pub(crate) fn which(name: &str, home: Option<&str>) -> Option<PathBuf> {
    if name.is_empty() || name.contains('/') {
        return None;
    }
    candidate_dirs(home)
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

/// Resolve a configured `binaryPath` (bare name searched like `which`,
/// `~/`-relative or absolute checked directly) or fall back to searching for
/// `default` when no override is configured. `default` empty means there is
/// no sane fallback (e.g. an unconfigured ACP Registry command).
pub(crate) fn resolve_binary(
    configured: Option<&str>,
    default: &str,
    home: Option<&str>,
) -> Option<PathBuf> {
    if let Some(raw) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(rest) = raw.strip_prefix("~/") {
            let home = home?;
            let candidate = Path::new(home).join(rest);
            return is_executable_file(&candidate).then_some(candidate);
        }
        if raw.contains('/') {
            let candidate = PathBuf::from(raw);
            return is_executable_file(&candidate).then_some(candidate);
        }
        return which(raw, home);
    }
    if default.is_empty() {
        return None;
    }
    which(default, home)
}

type ProbeCache = Mutex<std::collections::HashMap<String, (Instant, Option<(bool, String)>)>>;
static PROBE_CACHE: OnceLock<ProbeCache> = OnceLock::new();
const PROBE_CACHE_TTL: Duration = Duration::from_secs(20);

fn run_with_timeout(bin: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                use std::io::Read;
                let mut out = Vec::new();
                let mut err = Vec::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_end(&mut out);
                }
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_end(&mut err);
                }
                let success = status.success();
                let bytes = if success && !out.is_empty() { &out } else { &err };
                let text = String::from_utf8_lossy(bytes).trim().to_owned();
                return Some((success, text));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

/// Probe `bin --version` (or `args`) with a hard timeout, cached briefly so a
/// refresh across several instances sharing a driver doesn't re-spawn the
/// same CLI repeatedly. `None` means it timed out or could not be started.
pub(crate) fn cached_probe(bin: &Path, args: &[&str]) -> Option<(bool, String)> {
    let key = format!("{}:{}", bin.display(), args.join(" "));
    let cache = PROBE_CACHE.get_or_init(Default::default);
    if let Ok(guard) = cache.lock() {
        if let Some((at, value)) = guard.get(&key) {
            if at.elapsed() < PROBE_CACHE_TTL {
                return value.clone();
            }
        }
    }
    let result = run_with_timeout(bin, args, Duration::from_secs(5));
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, (Instant::now(), result.clone()));
    }
    result
}

/// First non-empty line of `--version` output, trimmed.
pub(crate) fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or(text).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_bin(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn resolves_tilde_and_absolute_and_bare_names() {
        let dir = std::env::temp_dir().join(format!("t3-path-resolve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(&dir, "fakecli", "#!/bin/sh\necho v1.2.3\n");
        assert_eq!(
            resolve_binary(Some(bin.to_str().unwrap()), "", None),
            Some(bin.clone())
        );
        assert_eq!(resolve_binary(Some("  "), "fakecli", None).is_none(), true);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probe_reports_version_and_never_hangs_on_a_runaway_process() {
        let dir = std::env::temp_dir().join(format!("t3-path-resolve-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fast = fake_bin(&dir, "fast", "#!/bin/sh\necho fake-cli 9.9.9\n");
        let (ok, text) = cached_probe(&fast, &["--version"]).unwrap();
        assert!(ok);
        assert_eq!(text, "fake-cli 9.9.9");

        let hang = fake_bin(&dir, "hang", "#!/bin/sh\nsleep 30\n");
        let start = Instant::now();
        assert!(run_with_timeout(&hang, &["--version"], Duration::from_millis(300)).is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_binary_resolves_to_none() {
        assert_eq!(which("t3-definitely-not-a-real-binary", None), None);
    }
}
