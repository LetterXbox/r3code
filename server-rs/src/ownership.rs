//! SQLite-backed single-owner lock for a T3 state directory.
use rusqlite::{Connection, ErrorCode};
use std::{
    fmt,
    path::{Path, PathBuf},
    time::Duration,
};

pub const STATE_DIR_OWNED_EXIT_CODE: i32 = 78;

#[derive(Debug)]
pub enum OwnershipError {
    AlreadyOwned(PathBuf),
    Database(rusqlite::Error),
    OlderBootService(PathBuf),
}
impl fmt::Display for OwnershipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyOwned(dir) => write!(f, "A T3 Code server already owns {}. Stop that server, or use a separate T3 home and pair with it, then retry. No server was stopped. server-owner.sqlite is the ownership lock; do not delete it while a server is running.", dir.display()),
            Self::OlderBootService(dir) => write!(f, "A T3 Code background service for {} may use an older release without ownership locking. Run `t3 update` or `t3 service restart`; if necessary uninstall and reinstall the service, then retry. No server was stopped.", dir.display()),
            Self::Database(err) => write!(f, "Could not acquire server ownership: {err}"),
        }
    }
}
impl std::error::Error for OwnershipError {}

/// The exclusive transaction stays open until this handle is dropped.
/// Legacy owner and older boot-service checks must additionally be performed
/// by startup before this can establish full ownership compatibility.
pub struct OwnershipLock {
    _connection: Connection,
    #[cfg(unix)]
    _pinned_file: std::fs::File,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl OwnershipLock {
    pub fn acquire(state_dir: &Path) -> Result<Self, OwnershipError> {
        let path = state_dir.join("server-owner.sqlite");
        // Pin the inode before SQLite opens it, then verify that the path still
        // names that inode after the transaction is held.
        #[cfg(unix)]
        let (pinned_file, expected) = {
            use std::os::unix::fs::MetadataExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .map_err(io_error)?;
            let metadata = file.metadata().map_err(io_error)?;
            (file, (metadata.dev(), metadata.ino()))
        };
        let connection = Connection::open(&path).map_err(OwnershipError::Database)?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(OwnershipError::Database)?;
        connection.execute_batch("BEGIN EXCLUSIVE").map_err(|err| {
            if matches!(&err, rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::DatabaseBusy) {
                OwnershipError::AlreadyOwned(state_dir.to_owned())
            } else { OwnershipError::Database(err) }
        })?;
        // A pre-lock server may still own this home. Conservatively treat a
        // live PID in its legacy runtime record as an owner, including when
        // process start time cannot be checked.
        if let Ok(bytes) = std::fs::read(state_dir.join("server-runtime.json")) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if value.get("ownerId").and_then(|v| v.as_str()).is_none() {
                    if let Some(pid) = value
                        .get("pid")
                        .and_then(|v| v.as_u64())
                        .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                    {
                        #[cfg(unix)]
                        {
                            let result = unsafe { libc::kill(pid as i32, 0) };
                            if (result == 0
                                || std::io::Error::last_os_error().raw_os_error()
                                    == Some(libc::EPERM))
                                && legacy_process_matches(
                                    pid as u32,
                                    value.get("startedAt").and_then(|v| v.as_str()),
                                )
                            {
                                return Err(OwnershipError::AlreadyOwned(state_dir.to_owned()));
                            }
                        }
                        #[cfg(not(unix))]
                        return Err(OwnershipError::AlreadyOwned(state_dir.to_owned()));
                    }
                }
            }
        }
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let identity = std::fs::metadata(&path).map_err(io_error)?;
            if (identity.dev(), identity.ino()) != expected {
                return Err(OwnershipError::AlreadyOwned(state_dir.to_owned()));
            }
            let stopped = stop.clone();
            std::thread::spawn(move || {
                while !stopped.load(std::sync::atomic::Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(5));
                    if stopped.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    match std::fs::metadata(&path) {
                        Ok(metadata) if (metadata.dev(), metadata.ino()) == expected => {}
                        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                            eprintln!(
                                "Cannot check server ownership lock at {}: {error}",
                                path.display()
                            );
                            continue;
                        }
                        _ => {
                            eprintln!("Server ownership lock at {} was deleted or replaced. Another server may now share this T3 home. Stop any other server using this home, then restart this server. Do not delete server-owner.sqlite while a server is running.", path.display());
                            break;
                        }
                    }
                }
            });
        }
        Ok(Self {
            _connection: connection,
            #[cfg(unix)]
            _pinned_file: pinned_file,
            stop,
        })
    }
}

#[cfg(unix)]
fn io_error(error: std::io::Error) -> OwnershipError {
    OwnershipError::Database(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

#[cfg(unix)]
fn legacy_process_matches(pid: u32, recorded_at: Option<&str>) -> bool {
    use std::process::{Command, Stdio};
    let Some(recorded) = recorded_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    else {
        return true;
    };
    let Ok(mut child) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return true;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return true;
            }
        }
    }
    let Ok(output) = child.wait_with_output() else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    legacy_start_matches(&text, recorded.timestamp_millis())
}

#[cfg(unix)]
fn legacy_start_matches(output: &str, recorded_ms: i64) -> bool {
    chrono::NaiveDateTime::parse_from_str(output.trim(), "%a %b %e %H:%M:%S %Y")
        .map(|started| started.and_utc().timestamp_millis() <= recorded_ms.saturating_add(1000))
        .unwrap_or(true)
}

impl Drop for OwnershipLock {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

// Match the original launcher's exact-semver validation before comparing with
// the first version supporting ownership locks. Numeric components are strings
// so even arbitrarily large valid versions remain comparable without overflow.
fn older_than_ownership_protocol(version: &str) -> Option<bool> {
    let pattern = regex::Regex::new(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$").unwrap();
    let v = pattern.captures(version)?;
    if &v[1] != "0" {
        return Some(false);
    }
    match &v[2] {
        "0" => Some(true),
        "1" => Some(&v[3] == "0" && v.get(4).is_some()),
        _ => Some(false),
    }
}

/// Refuse a loaded or enabled pre-lock boot service that targets this home.
/// Missing configuration or an unavailable service manager cannot establish an owner.
pub fn check_older_boot_service(
    base_dir: &Path,
    state_dir: &Path,
    home: &Path,
    service_managed: bool,
) -> Result<(), OwnershipError> {
    if service_managed {
        return Ok(());
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let unit = if cfg!(target_os = "macos") {
            home.join("Library/LaunchAgents/com.t3tools.t3code.service.plist")
        } else {
            home.join(".config/systemd/user/t3code.service")
        };
        let Ok(contents) = std::fs::read_to_string(unit) else {
            return Ok(());
        };
        let re = regex::Regex::new(r#"(?m)^Environment=T3CODE_HOME=(.*)$|<key>T3CODE_HOME</key>\s*<string>([^<]*)</string>"#).unwrap();
        let Some(captures) = re.captures(&contents) else {
            return Ok(());
        };
        let raw = captures
            .get(1)
            .or_else(|| captures.get(2))
            .unwrap()
            .as_str()
            .trim()
            .trim_matches('"');
        let raw = raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'");
        let Ok(target) = std::fs::canonicalize(Path::new(&raw).join("userdata")) else {
            return Ok(());
        };
        if std::fs::canonicalize(state_dir).ok().as_ref() != Some(&target) {
            return Ok(());
        }
        let runtime = Path::new(&raw).join("runtime");
        let Ok(state) = std::fs::read_to_string(runtime.join("service-state.json")) else {
            return Ok(());
        };
        let Ok(state) = serde_json::from_str::<serde_json::Value>(&state) else {
            return Ok(());
        };
        let Some(version) = state.get("activeVersion").and_then(|v| v.as_str()) else {
            return Ok(());
        };
        let Some(older) = older_than_ownership_protocol(version) else {
            return Ok(());
        };
        let run = |command: &str, args: &[&str]| -> Option<(bool, String)> {
            use std::process::{Command, Stdio};
            let mut child = Command::new(command)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if child.try_wait().ok()?.is_some() {
                    let output = child.wait_with_output().ok()?;
                    return Some((
                        output.status.success(),
                        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
                    ));
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let loaded = if cfg!(target_os = "macos") {
            let uid = unsafe { libc::getuid() };
            run(
                "launchctl",
                &["print", &format!("gui/{uid}/com.t3tools.t3code.service")],
            )
            .map(|v| v.0)
            .unwrap_or(false)
        } else {
            run("systemctl", &["--user", "is-active", "t3code.service"])
                .map(|(ok, output)| ok || output == "activating")
                .unwrap_or(false)
        };
        let enabled = if loaded {
            true
        } else if cfg!(target_os = "macos") {
            let uid = unsafe { libc::getuid() };
            run("launchctl", &["print-disabled", &format!("gui/{uid}")])
                .map(|(ok, output)| {
                    ok && !output.contains("\"com.t3tools.t3code.service\" => disabled")
                        && !output.contains("\"com.t3tools.t3code.service\" => true")
                })
                .unwrap_or(false)
        } else {
            run("systemctl", &["--user", "is-enabled", "t3code.service"])
                .map(|(ok, output)| ok && output == "enabled")
                .unwrap_or(false)
        };
        if enabled && (older || (loaded && runtime.join(".restart-pending").exists())) {
            return Err(OwnershipError::OlderBootService(base_dir.to_owned()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_version_requires_exact_semver_and_handles_large_numbers() {
        for v in ["0.0.99", "0.1.0-rc.1", "0.1.0-0+build.1"] {
            assert_eq!(older_than_ownership_protocol(v), Some(true), "{v}");
        }
        for v in ["0.1.0", "0.1.1-alpha", "0.184467440737095516160.0", "1.0.0-rc.1"] {
            assert_eq!(older_than_ownership_protocol(v), Some(false), "{v}");
        }
        for v in ["0.1.0-01", "0.1.0-rc..1", "0.1.0+build.", "00.1.0", "0.1.0-"] {
            assert_eq!(older_than_ownership_protocol(v), None, "{v}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn legacy_start_time_detects_reused_pid_and_unknown_is_conservative() {
        let timestamp = chrono::DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert!(legacy_start_matches("Mon Jan  1 00:00:01 2024", timestamp));
        assert!(!legacy_start_matches("Mon Jan  1 00:00:02 2024", timestamp));
        assert!(legacy_start_matches("unparseable", timestamp));
    }

    #[test]
    fn exclusive_owner_is_released_on_drop() {
        let path = std::env::temp_dir().join(format!(
            "t3-owner-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let owner = OwnershipLock::acquire(&path).unwrap();
        assert!(matches!(
            OwnershipLock::acquire(&path),
            Err(OwnershipError::AlreadyOwned(_))
        ));
        drop(owner);
        let next = OwnershipLock::acquire(&path).unwrap();
        drop(next);
        std::fs::remove_dir_all(path).unwrap();
    }
}
