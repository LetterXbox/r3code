//! Materialize the Codex authentication overlay while sharing non-private state.
#[cfg(unix)]
pub fn shared_home() -> std::io::Result<std::path::PathBuf> {
    use std::{io, path::PathBuf};
    let home = std::env::var_os("HOME")
        .map(|v| PathBuf::from(v).join(".codex"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Codex home unavailable"))?;
    if home.is_absolute() {
        Ok(home)
    } else {
        Ok(std::env::current_dir()?.join(home))
    }
}

#[cfg(unix)]
pub fn materialize(shared: &std::path::Path, shadow: &std::path::Path) -> std::io::Result<()> {
    use std::{collections::BTreeSet, fs, io, os::unix::fs::symlink};
    fn normalize_absolute(path: &std::path::Path) -> std::path::PathBuf {
        use std::path::{Component, PathBuf};
        let mut result = PathBuf::new();
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    result.pop();
                }
                Component::CurDir => {}
                other => result.push(other.as_os_str()),
            }
        }
        result
    }
    const SHARED: &[&str] = &[
        "sessions",
        "archived_sessions",
        "sqlite",
        "shell_snapshots",
        "worktrees",
        "skills",
        "plugins",
        "cache",
        "logs",
        "mcp-oauth-locks",
        "thread-writer-locks",
    ];
    const PRIVATE: &[&str] = &[
        "auth.json",
        "auth.json.lock",
        "auth.lock",
        "models_cache.json",
    ];
    const LOCAL: &[&str] = &[
        "log",
        "memories",
        "tmp",
        ".tmp",
        "app-server-control",
        "app-server-daemon",
        ".DS_Store",
    ];
    if !shared.is_absolute() || !shadow.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "home paths must be absolute",
        ));
    }
    fs::create_dir_all(shared)?;
    fs::create_dir_all(shadow)?;
    let shared = fs::canonicalize(shared)?;
    let shadow = fs::canonicalize(shadow)?;
    if shared == shadow || shared.starts_with(&shadow) || shadow.starts_with(&shared) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "shared and shadow homes overlap",
        ));
    }
    for name in SHARED {
        fs::create_dir_all(shared.join(name))?;
    }
    for name in PRIVATE {
        let path = shadow.join(name);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            if *name == "auth.json" {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "shadow authentication must be private",
                ));
            }
            fs::remove_file(path)?;
        }
    }
    let mut names: BTreeSet<std::ffi::OsString> = SHARED.iter().map(|s| (*s).into()).collect();
    // These files are created lazily by Codex. Link them before first launch so
    // a fresh shared home does not silently fork the session database or index.
    for name in [
        "state_5.sqlite",
        "thread_history_1.sqlite",
        "session_index.jsonl",
        "session_index.jsonl.lock",
    ] {
        names.insert(name.into());
    }
    for entry in fs::read_dir(&shared)? {
        let name = entry?.file_name();
        if !PRIVATE.iter().chain(LOCAL).any(|s| name == *s) {
            names.insert(name);
        }
    }
    for name in names {
        let target = shared.join(&name);
        let link = shadow.join(&name);
        match fs::symlink_metadata(&link) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => symlink(&target, &link)?,
            Err(e) => return Err(e),
            Ok(meta) if meta.file_type().is_symlink() => {
                let old = fs::read_link(&link)?;
                let old = if old.is_absolute() {
                    old
                } else {
                    shadow.join(old)
                };
                if normalize_absolute(&old) != target {
                    fs::remove_file(&link)?;
                    symlink(&target, &link)?;
                }
            }
            Ok(meta) => {
                let replaceable = name == "mcp-oauth-locks"
                    || name == "thread-writer-locks"
                    || name == ".sqlite-maintenance.lock";
                if !replaceable {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "shadow home entry conflict",
                    ));
                }
                if name == "thread-writer-locks"
                    && meta.is_dir()
                    && fs::read_dir(&link)?.any(|e| {
                        e.ok().is_some_and(|e| {
                            let n = e.file_name();
                            let n = n.to_string_lossy();
                            n.ends_with(".lock") && n != ".coordination.lock"
                        })
                    })
                {
                    continue;
                }
                if meta.is_dir() {
                    fs::remove_dir_all(&link)?;
                } else {
                    fs::remove_file(&link)?;
                }
                symlink(&target, &link)?;
            }
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};
    #[test]
    fn shares_configuration_without_linking_private_auth() {
        let root = std::env::temp_dir().join(format!("codex-shadow-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let shadow = root.join("shadow");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&shadow).unwrap();
        fs::write(shared.join("config.toml"), "shared config").unwrap();
        fs::write(shared.join("auth.json"), "private shared auth").unwrap();
        fs::write(shadow.join("auth.json"), "private shadow auth").unwrap();
        materialize(&shared, &shadow).unwrap();
        materialize(&shared, &shadow).unwrap();
        assert_eq!(
            fs::read_to_string(shadow.join("config.toml")).unwrap(),
            "shared config"
        );
        assert!(fs::symlink_metadata(shadow.join("sessions"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(shadow.join("auth.json")).unwrap(),
            "private shadow auth"
        );
        fs::remove_file(shadow.join("auth.json")).unwrap();
        symlink(shared.join("auth.json"), shadow.join("auth.json")).unwrap();
        assert!(materialize(&shared, &shadow).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preserves_conflicts_and_live_writer_locks() {
        let root = std::env::temp_dir().join(format!("codex-shadow-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let shadow = root.join("shadow");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(shadow.join("thread-writer-locks")).unwrap();
        fs::write(shadow.join("thread-writer-locks/a.lock"), "live").unwrap();
        materialize(&shared, &shadow).unwrap();
        assert!(shadow.join("thread-writer-locks/a.lock").exists());
        fs::write(shared.join("config.toml"), "original").unwrap();
        fs::write(shadow.join("config.toml"), "local").unwrap();
        assert!(materialize(&shared, &shadow).is_err());
        assert_eq!(
            fs::read_to_string(shadow.join("config.toml")).unwrap(),
            "local"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preserves_equivalent_relative_symlinks() {
        let root = std::env::temp_dir().join(format!("codex-shadow-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let shadow = root.join("shadow");
        fs::create_dir_all(shared.join("sessions")).unwrap();
        fs::create_dir_all(&shadow).unwrap();
        symlink("../shared/sessions", shadow.join("sessions")).unwrap();
        materialize(&shared, &shadow).unwrap();
        assert_eq!(
            fs::read_link(shadow.join("sessions")).unwrap(),
            std::path::PathBuf::from("../shared/sessions")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
