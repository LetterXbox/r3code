//! Runtime paths and persistent environment identity.
use std::{
    env, fmt, fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ServerPaths {
    pub base_dir: PathBuf,
    pub state_dir: PathBuf,
    pub db_path: PathBuf,
    pub keybindings_config_path: PathBuf,
    pub settings_path: PathBuf,
    pub environment_themes_dir: PathBuf,
    pub provider_status_cache_dir: PathBuf,
    pub worktrees_dir: PathBuf,
    pub worktree_checkout_cache_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub browser_artifacts_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub server_trace_path: PathBuf,
    pub provider_logs_dir: PathBuf,
    pub provider_event_log_path: PathBuf,
    pub terminal_logs_dir: PathBuf,
    pub anonymous_id_path: PathBuf,
    pub environment_id_path: PathBuf,
    pub server_runtime_state_path: PathBuf,
    pub secrets_dir: PathBuf,
    pub ownership_lock_path: PathBuf,
}

impl ServerPaths {
    /// `explicit_base_dir` means a nonblank CLI or environment home, not a desktop bootstrap home.
    pub fn new(
        base_dir: PathBuf,
        dev_url_set: bool,
        explicit_base_dir: bool,
        trace_override: Option<PathBuf>,
    ) -> Self {
        let state_dir = base_dir.join(if dev_url_set && !explicit_base_dir {
            "dev"
        } else {
            "userdata"
        });
        let logs_dir = state_dir.join("logs");
        let provider_logs_dir = logs_dir.join("provider");
        let provider_status_cache_dir = base_dir.join("caches");
        Self {
            db_path: state_dir.join("statev2.sqlite"),
            keybindings_config_path: state_dir.join("keybindings.json"),
            settings_path: state_dir.join("settings.json"),
            environment_themes_dir: state_dir.join("themes"),
            worktrees_dir: base_dir.join("worktrees"),
            worktree_checkout_cache_dir: provider_status_cache_dir.join("worktree-checkouts"),
            attachments_dir: state_dir.join("attachments"),
            browser_artifacts_dir: state_dir.join("browser-artifacts"),
            server_trace_path: trace_override
                .unwrap_or_else(|| logs_dir.join("server.trace.ndjson")),
            provider_event_log_path: provider_logs_dir.join("events.log"),
            terminal_logs_dir: logs_dir.join("terminals"),
            anonymous_id_path: state_dir.join("anonymous-id"),
            environment_id_path: state_dir.join("environment-id"),
            server_runtime_state_path: state_dir.join("server-runtime.json"),
            secrets_dir: state_dir.join("secrets"),
            ownership_lock_path: state_dir.join("server-owner.sqlite"),
            base_dir,
            state_dir,
            logs_dir,
            provider_logs_dir,
            provider_status_cache_dir,
        }
    }

    /// Create the startup directories. A chmod failure is reported separately as a warning.
    pub fn ensure_directories(&self, cwd: &Path) -> io::Result<Option<io::Error>> {
        for path in [
            &self.state_dir,
            &self.logs_dir,
            &self.provider_logs_dir,
            &self.terminal_logs_dir,
            &self.attachments_dir,
            &self.worktrees_dir,
            &self.provider_status_cache_dir,
            cwd,
        ] {
            fs::create_dir_all(path)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            Ok(fs::set_permissions(&self.state_dir, fs::Permissions::from_mode(0o700)).err())
        }
        #[cfg(not(unix))]
        {
            Ok(None)
        }
    }
}

/// Expand a leading `~` and resolve relative homes against the current directory.
pub fn resolve_base_dir(value: Option<&str>, home: &Path, cwd: &Path) -> PathBuf {
    let value = value.filter(|v| !v.trim().is_empty());
    let path = match value {
        None => home.join(".t3"),
        Some("~") => home.to_owned(),
        Some(v) if v.starts_with("~/") || v.starts_with("~\\") => home.join(&v[2..]),
        Some(v) => PathBuf::from(v),
    };
    let absolute = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    normalize_path(&absolute)
}

fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

#[derive(Debug)]
pub struct EnvironmentIdError {
    pub operation: &'static str,
    pub source: io::Error,
}
impl fmt::Display for EnvironmentIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ServerEnvironmentIdPersistenceError ({}): {}",
            self.operation, self.source
        )
    }
}
impl std::error::Error for EnvironmentIdError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}
fn id_error(operation: &'static str, source: io::Error) -> EnvironmentIdError {
    EnvironmentIdError { operation, source }
}
fn read_id(path: &Path) -> Result<Option<String>, EnvironmentIdError> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let trimmed = value.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(id_error("read", e)),
    }
}

/// Persist an identity with a hard-link publication so concurrent starters share the winner.
pub fn load_or_create_environment_id(state_dir: &Path) -> Result<String, EnvironmentIdError> {
    let dest = state_dir.join("environment-id");
    if let Some(id) = read_id(&dest)? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let temp = state_dir.join(format!(".environment-id-{}", Uuid::new_v4()));
    fs::write(&temp, format!("{id}\n")).map_err(|e| id_error("write", e))?;
    let published = fs::hard_link(&temp, &dest);
    let _ = fs::remove_file(&temp);
    if let Err(e) = published {
        if e.kind() != io::ErrorKind::AlreadyExists {
            return Err(id_error("initialize", e));
        }
    }
    if let Some(winner) = read_id(&dest)? {
        return Ok(winner);
    }
    // An empty pre-existing file cannot be replaced by the no-clobber link above.
    let recovery = state_dir.join("environment-id.recovery");
    let temp = state_dir.join(format!(".environment-id-{}", Uuid::new_v4()));
    fs::write(&temp, format!("{id}\n")).map_err(|e| id_error("write", e))?;
    let result = (|| -> io::Result<()> {
        match fs::hard_link(&temp, &recovery) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        // Retain the recovery anchor so delayed initializers publish the same ID.
        fs::remove_file(&temp)?;
        fs::copy(&recovery, &temp)?;
        fs::rename(&temp, &dest)
    })();
    let _ = fs::remove_file(&temp);
    result.map_err(|e| id_error("write", e))?;
    read_id(&dest)?.ok_or_else(|| {
        id_error(
            "initialize",
            io::Error::new(io::ErrorKind::InvalidData, "environment id is empty"),
        )
    })
}

/// Resolve an installed client bundle, preferring the bundled distribution.
pub fn resolve_static_dir(exe_dir: &Path) -> Option<PathBuf> {
    [exe_dir.join("client"), exe_dir.join("../../web/dist")]
        .into_iter()
        .find(|p| p.join("index.html").is_file())
}

/// Resolve the default home using the process environment.
pub fn default_base_dir(value: Option<&str>) -> io::Result<PathBuf> {
    let cwd = env::current_dir()?;
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory is unavailable"))?;
    Ok(resolve_base_dir(value, &home, &cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_identity_are_stable() {
        let root = env::temp_dir().join(format!("t3-runtime-test-{}", Uuid::new_v4()));
        let paths = ServerPaths::new(root.clone(), true, false, None);
        assert_eq!(paths.state_dir, root.join("dev"));
        paths.ensure_directories(&root.join("project")).unwrap();
        let first = load_or_create_environment_id(&paths.state_dir).unwrap();
        assert!(Uuid::parse_str(&first).unwrap().get_version_num() == 4);
        assert_eq!(
            first,
            load_or_create_environment_id(&paths.state_dir).unwrap()
        );
        fs::write(&paths.environment_id_path, "\n").unwrap();
        let recovered = load_or_create_environment_id(&paths.state_dir).unwrap();
        fs::write(&paths.environment_id_path, "\n").unwrap();
        assert_eq!(
            load_or_create_environment_id(&paths.state_dir).unwrap(),
            recovered
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn home_resolution() {
        assert_eq!(
            resolve_base_dir(Some("~/x/../y"), Path::new("/home/user"), Path::new("/tmp")),
            PathBuf::from("/home/user/y")
        );
        assert_eq!(
            resolve_base_dir(Some(" "), Path::new("/home/user"), Path::new("/tmp")),
            PathBuf::from("/home/user/.t3")
        );
    }
}
