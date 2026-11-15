//! Publish a consistent, one-time snapshot of a legacy V1 database.
use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::{
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug)]
pub struct V2DatabaseImportError {
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub cause: Box<dyn Error + Send + Sync>,
}
impl fmt::Display for V2DatabaseImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Could not copy the V1 database at {} to {}. The V1 database has not been migrated.",
            self.source_path.display(),
            self.destination_path.display()
        )
    }
}
impl Error for V2DatabaseImportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.cause.as_ref())
    }
}

type Cause = Box<dyn Error + Send + Sync>;
struct TemporaryDirectory(PathBuf);
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "Unable to remove V1 import directory {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

/// Removes abandoned import directories, then copies `state.sqlite` alongside the
/// destination if and only if the destination is absent. Publication is atomic.
pub fn initialize_v2_database(
    destination_path: impl AsRef<Path>,
) -> Result<(), V2DatabaseImportError> {
    let destination = destination_path.as_ref();
    let dir = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let source = dir.join("state.sqlite");
    remove_abandoned_copies(dir);
    let result = (|| -> Result<(), Cause> {
        if destination.try_exists()? || !source.try_exists()? {
            return Ok(());
        }
        let temp = loop {
            let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
            let path = dir.join(format!(".v2-import-{}-{suffix}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => break TemporaryDirectory(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        };
        let snapshot = temp.0.join("snapshot.sqlite");
        {
            let source_db = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let mut destination_db = Connection::open(&snapshot)?;
            let backup = Backup::new(&source_db, &mut destination_db)?;
            backup.run_to_completion(128, Duration::from_millis(10), None)?;
        }
        match fs::hard_link(&snapshot, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.into()),
        }
    })();
    result.map_err(|cause| V2DatabaseImportError {
        source_path: source,
        destination_path: destination.to_owned(),
        cause,
    })
}

fn remove_abandoned_copies(dir: &Path) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(error) => {
            eprintln!(
                "Unable to list V1 import directories in {}: {error}",
                dir.display()
            );
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("Unable to inspect V1 import directory: {error}");
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(".v2-import-") else {
            continue;
        };
        let (pid, suffix) = match rest.split_once('-') {
            Some((pid, suffix)) if !pid.is_empty() && pid.bytes().all(|c| c.is_ascii_digit()) => {
                (pid.parse::<u32>().ok(), suffix)
            }
            Some(_) => continue,
            None => (None, rest),
        };
        if suffix.len() != 6 || !suffix.bytes().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        if pid.is_some_and(process_alive) {
            continue;
        }
        let path = entry.path();
        // Remove symlinks and files without following them; directories are recursive.
        let result = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(&path),
            Ok(_) => fs::remove_file(&path),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "Unable to remove abandoned V1 import {}: {error}",
                    path.display()
                );
            }
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn directory() -> TemporaryDirectory {
        let path =
            std::env::temp_dir().join(format!("t3-v1-snapshot-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        TemporaryDirectory(path)
    }
    #[test]
    fn snapshots_committed_wal_without_uncommitted_rows() {
        let dir = directory();
        let source = dir.0.join("state.sqlite");
        let destination = dir.0.join("statev2.sqlite");
        let db = Connection::open(&source).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');").unwrap();
        initialize_v2_database(&destination).unwrap();
        let copy = Connection::open(&destination).unwrap();
        let mut statement = copy.prepare("SELECT text FROM messages").unwrap();
        let rows: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows, ["committed"]);
        db.execute_batch("ROLLBACK; INSERT INTO messages VALUES ('later');")
            .unwrap();
        initialize_v2_database(&destination).unwrap();
        assert_eq!(
            copy.query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn invalid_snapshot_is_not_published_and_preserves_underlying_cause() {
        let dir = directory();
        let source = dir.0.join("state.sqlite");
        let destination = dir.0.join("statev2.sqlite");
        fs::write(&source, "invalid SQLite").unwrap();
        let error = initialize_v2_database(&destination).unwrap_err();
        assert!(error
            .source()
            .unwrap()
            .downcast_ref::<rusqlite::Error>()
            .is_some());
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), b"invalid SQLite");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
    #[test]
    fn fresh_and_existing_destination_leave_source_alone() {
        let dir = directory();
        let destination = dir.0.join("statev2.sqlite");
        initialize_v2_database(&destination).unwrap();
        assert!(!destination.exists());
        assert!(!dir.0.join("state.sqlite").exists());
        fs::write(dir.0.join("state.sqlite"), "invalid SQLite").unwrap();
        fs::write(&destination, "existing").unwrap();
        initialize_v2_database(&destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"existing");
    }
    #[test]
    fn cleanup_removes_only_abandoned_matching_entries() {
        let dir = directory();
        let live = format!(".v2-import-{}-Wm3nPa", std::process::id());
        for name in [
            ".v2-import-2147483647-Wm3nPa",
            ".v2-import-Q3xZ9a",
            ".v2-import-not-a-copy",
            &live,
        ] {
            fs::create_dir(dir.0.join(name)).unwrap();
            fs::write(dir.0.join(name).join("file"), "x").unwrap();
        }
        initialize_v2_database(dir.0.join("statev2.sqlite")).unwrap();
        assert!(!dir.0.join(".v2-import-2147483647-Wm3nPa").exists());
        assert!(!dir.0.join(".v2-import-Q3xZ9a").exists());
        assert!(dir.0.join(".v2-import-not-a-copy").exists());
        assert!(dir.0.join(live).exists());
    }
    #[test]
    fn snapshot_leaves_source_bytes_unchanged() {
        let dir = directory();
        let source = dir.0.join("state.sqlite");
        let db = Connection::open(&source).unwrap();
        db.execute("CREATE TABLE t (value TEXT)", []).unwrap();
        db.execute("INSERT INTO t VALUES (?1)", params!["v1"])
            .unwrap();
        drop(db);
        let original = fs::read(&source).unwrap();
        initialize_v2_database(dir.0.join("statev2.sqlite")).unwrap();
        assert_eq!(fs::read(&source).unwrap(), original);
    }
}
