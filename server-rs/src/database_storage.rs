//! SQLite file accounting and bounded incremental space reclamation.
use crate::auth_http::AuthHttpState;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

pub struct DatabaseStorage {
    auth: Arc<AuthHttpState>,
    base_dir: PathBuf,
    db_path: PathBuf,
    updates: tokio::sync::watch::Sender<Option<Value>>,
}

impl DatabaseStorage {
    pub fn new(auth: Arc<AuthHttpState>, base_dir: PathBuf, db_path: PathBuf) -> Arc<Self> {
        let (updates, _) = tokio::sync::watch::channel(None);
        Arc::new(Self {
            auth,
            base_dir,
            db_path,
            updates,
        })
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Option<Value>> {
        self.updates.subscribe()
    }
    pub fn command(&self) -> String {
        format!(
            "t3 doctor --base-dir {}",
            shell_word(&self.base_dir.to_string_lossy())
        )
    }
    fn status(&self) -> Option<Value> {
        // The upstream doctor only repairs userdata, never a separate dev database.
        if self.db_path.parent()? != self.base_dir.join("userdata") {
            return None;
        }
        let db = self.auth.db.lock().ok()?;
        let actual: String = db
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |r| r.get(0),
            )
            .ok()?;
        if actual.is_empty()
            || std::fs::canonicalize(actual).ok()? != std::fs::canonicalize(&self.db_path).ok()?
        {
            return None;
        }
        let page_size: u64 = db.query_row("PRAGMA page_size", [], |r| r.get(0)).ok()?;
        let pages: u64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).ok()?;
        let free: u64 = db
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .ok()?;
        let auto: u32 = db.query_row("PRAGMA auto_vacuum", [], |r| r.get(0)).ok()?;
        let mut status = json!({"databaseBytes":pages.saturating_mul(page_size), "reclaimableBytes":free.saturating_mul(page_size), "incrementalVacuumEnabled":auto == 2, "compactCommand":self.command(), "canReclaim":false});
        let failure = self.db_path.parent()?.join("reclaim-failed");
        if let Some(message) = read_failure(&failure) {
            status["reclaimFailure"] = json!(message);
        }
        Some(status)
    }
    fn publish(&self) {
        let next = self.status();
        self.updates.send_if_modified(|old| {
            if *old == next {
                false
            } else {
                *old = next;
                true
            }
        });
    }
    fn reclaim_page(&self) -> bool {
        let Ok(db) = self.auth.db.lock() else {
            return false;
        };
        let mode = db
            .query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, u32>(0))
            .ok();
        let free = db
            .query_row("PRAGMA freelist_count", [], |r| r.get::<_, u64>(0))
            .unwrap_or(0);
        mode == Some(2) && free > 0 && db.execute_batch("PRAGMA incremental_vacuum(1)").is_ok()
    }
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            let s = service.clone();
            let _ = tokio::task::spawn_blocking(move || s.publish()).await;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                for _ in 0..1024 {
                    let s = service.clone();
                    if !tokio::task::spawn_blocking(move || s.reclaim_page())
                        .await
                        .unwrap_or(false)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                let s = service.clone();
                let _ = tokio::task::spawn_blocking(move || s.publish()).await;
            }
        })
    }
}

fn read_failure(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut contents = Vec::new();
    file.take(65537).read_to_end(&mut contents).ok()?;
    if contents.len() > 65536 {
        return None;
    }
    String::from_utf8(contents).ok()
}

fn shell_word(path: &str) -> String {
    if cfg!(windows) {
        format!(
            "\"{}\"",
            path.replace('`', "``")
                .replace('$', "`$")
                .replace('"', "\"\"")
        )
    } else if !path.is_empty()
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b))
    {
        path.to_owned()
    } else {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    #[test]
    fn status_tracks_real_database_and_excludes_dev_or_other_database() {
        let root = std::env::temp_dir().join(format!("t3-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("userdata")).unwrap();
        let db_path = root.join("userdata/statev2.sqlite");
        let db = crate::database::open_writer(&db_path).unwrap();
        db.execute_batch("CREATE TABLE data(x BLOB); INSERT INTO data VALUES(zeroblob(20000)); DELETE FROM data;").unwrap();
        let auth = Arc::new(AuthHttpState {
            replay_dir: root.join("replay"),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            db: std::sync::Mutex::new(db),
            lifecycle: Default::default(),
            signing_key: [1; 32],
            descriptor: json!({}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let service = DatabaseStorage::new(auth.clone(), root.clone(), db_path.clone());
        let status = service.status().unwrap();
        assert!(status["databaseBytes"].as_u64().unwrap() > 0);
        assert!(status["reclaimableBytes"].as_u64().unwrap() > 0);
        assert_eq!(status["incrementalVacuumEnabled"], true);
        assert_eq!(status["canReclaim"], false);
        assert!(service.reclaim_page());
        assert!(
            service.status().unwrap()["reclaimableBytes"]
                .as_u64()
                .unwrap()
                < status["reclaimableBytes"].as_u64().unwrap()
        );
        assert!(
            DatabaseStorage::new(auth.clone(), root.clone(), root.join("dev/statev2.sqlite"))
                .status()
                .is_none()
        );
        assert!(
            DatabaseStorage::new(auth, root.clone(), root.join("userdata/other.sqlite"))
                .status()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn failure_read_rejects_symlinks_and_oversized_files() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("t3-reclaim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("target"), "secret").unwrap();
        symlink(root.join("target"), root.join("link")).unwrap();
        assert_eq!(read_failure(&root.join("link")), None);
        std::fs::write(root.join("large"), vec![b'x'; 65537]).unwrap();
        assert_eq!(read_failure(&root.join("large")), None);
        assert_eq!(
            read_failure(&root.join("target")).as_deref(),
            Some("secret")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shell_command_quotes_special_characters() {
        assert_eq!(
            shell_word("/tmp/a'b"),
            if cfg!(windows) {
                "\"/tmp/a'b\""
            } else {
                "'/tmp/a'\"'\"'b'"
            }
        );
    }
    #[test]
    fn incremental_vacuum_reclaims_free_pages() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE t(x BLOB); INSERT INTO t SELECT zeroblob(20000); DELETE FROM t;").unwrap();
        let before: u64 = db
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(before > 0);
        db.execute_batch("PRAGMA incremental_vacuum(1)").unwrap();
        let after: u64 = db
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(after < before);
    }
}
