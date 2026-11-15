//! Private, atomic storage for managed Codex credentials. Values and errors never
//! implement credential-bearing debug output. The refresh coordinator serializes
//! operations across store instances and, on Unix, across server processes.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub client_id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub earliest_refresh_at: Option<i64>,
    pub scopes: Vec<String>,
    pub subject: String,
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials([REDACTED])")
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sessions {
    active_client_id: Option<String>,
    sessions: Vec<Credentials>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registrations {
    profiles: Vec<Registration>,
    last_client_id: Option<String>,
}

#[derive(Debug)]
pub enum StoreError {
    Storage,
    Invalid,
    Missing,
    ProfileChanged,
    Refresh,
    /// The authorization server definitively rejected the refresh token.
    RefreshRevoked,
    Client,
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Managed credential operation failed: {self:?}")
    }
}
impl std::error::Error for StoreError {}

static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();
#[derive(Clone)]
pub struct CredentialStore {
    dir: PathBuf,
    path: PathBuf,
    registration_path: PathBuf,
    journal_path: PathBuf,
    lock: Arc<AsyncMutex<()>>,
}
pub(crate) struct CredentialGuard<'a> {
    _local: tokio::sync::MutexGuard<'a, ()>,
    #[cfg(unix)]
    _file: std::fs::File,
}
impl CredentialStore {
    pub fn new(dir: &Path, instance_id: &str) -> Result<Self, StoreError> {
        if instance_id.is_empty() {
            return Err(StoreError::Invalid);
        }
        crate::signing_key::secure_secrets_dir(dir).map_err(|_| StoreError::Storage)?;
        let dir = std::fs::canonicalize(dir).map_err(|_| StoreError::Storage)?;
        let driver = "codex-chatgpt";
        let hash = Sha256::digest(format!("{}:{}{}", driver.len(), driver, instance_id).as_bytes());
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        let path = dir.join(format!("provider-auth-{hex}.bin"));
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| StoreError::Storage)?;
        locks.retain(|_, v| v.strong_count() > 0);
        let lock = locks.get(&path).and_then(Weak::upgrade).unwrap_or_else(|| {
            let l = Arc::new(AsyncMutex::new(()));
            locks.insert(path.clone(), Arc::downgrade(&l));
            l
        });
        let driver = "codex-chatgpt-registration";
        let hash = Sha256::digest(format!("{}:{}{}", driver.len(), driver, instance_id).as_bytes());
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        let registration_path = dir.join(format!("provider-auth-{hex}.bin"));
        Ok(Self {
            dir,
            path: path.clone(),
            journal_path: path.with_extension("journal"),
            registration_path,
            lock,
        })
    }
    fn recover_import(&self) -> Result<(), StoreError> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = match options.open(&self.journal_path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(StoreError::Storage),
        };
        let metadata = file.metadata().map_err(|_| StoreError::Storage)?;
        if !metadata.is_file() || metadata.len() > 3 * 1024 * 1024 {
            return Err(StoreError::Invalid);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(StoreError::Invalid);
            }
        }
        let mut bytes = Vec::new();
        file.take(3 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StoreError::Storage)?;
        if bytes.len() > 3 * 1024 * 1024 {
            return Err(StoreError::Invalid);
        }
        let (sessions, registrations): (Sessions, Registrations) =
            serde_json::from_slice(&bytes).map_err(|_| StoreError::Invalid)?;
        self.write_sessions(&sessions)?;
        self.write_registrations_locked(&registrations)?;
        self.finish_import_journal()
    }
    fn finish_import_journal(&self) -> Result<(), StoreError> {
        #[cfg(unix)]
        std::fs::File::open(&self.dir)
            .and_then(|d| d.sync_all())
            .map_err(|_| StoreError::Storage)?;
        std::fs::remove_file(&self.journal_path).map_err(|_| StoreError::Storage)?;
        #[cfg(unix)]
        std::fs::File::open(&self.dir)
            .and_then(|d| d.sync_all())
            .map_err(|_| StoreError::Storage)?;
        Ok(())
    }
    pub async fn import_profile(
        &self,
        registration: Registration,
        record: Credentials,
    ) -> Result<(), StoreError> {
        let _guard = self.lock().await?;
        self.import_profile_locked(registration, record)
    }
    pub(crate) fn import_profile_locked(
        &self,
        mut registration: Registration,
        record: Credentials,
    ) -> Result<(), StoreError> {
        self.validate_record_locked(&record)?;
        let sessions = self.read_sessions()?;
        let registrations = self.read_registrations_locked()?;
        if registrations.profiles.iter().any(|p| {
            p.client_id == record.client_id
                && p.subject.as_ref().is_some_and(|s| s != &record.subject)
        }) {
            return Err(StoreError::Invalid);
        }
        // A durable rollback journal makes a partially completed pair recoverable.
        let bytes =
            serde_json::to_vec(&(sessions, registrations)).map_err(|_| StoreError::Invalid)?;
        let tmp = self
            .dir
            .join(format!(".provider-auth-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), std::io::Error> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.journal_path)?;
            #[cfg(unix)]
            std::fs::File::open(&self.dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(tmp);
            return Err(StoreError::Storage);
        }
        if self
            .save_registration_locked(&mut registration)
            .and_then(|_| self.save_locked(record))
            .is_err()
        {
            self.recover_import()?;
            return Err(StoreError::Storage);
        }
        self.finish_import_journal()
    }
    fn read_sessions(&self) -> Result<Sessions, StoreError> {
        const MAX_BYTES: u64 = 1024 * 1024;
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Open the reparse point itself so it can be rejected by handle metadata.
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = match options.open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Sessions::default()),
            Err(_) => return Err(StoreError::Storage),
        };
        let metadata = file.metadata().map_err(|_| StoreError::Storage)?;
        if !metadata.is_file() || metadata.len() > MAX_BYTES {
            return Err(StoreError::Invalid);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                // FILE_ATTRIBUTE_REPARSE_POINT
                return Err(StoreError::Invalid);
            }
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StoreError::Storage)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(StoreError::Invalid);
        }
        if let Ok(sessions) = serde_json::from_slice::<Sessions>(&bytes) {
            return Ok(sessions);
        }
        let record: Credentials =
            serde_json::from_slice(&bytes).map_err(|_| StoreError::Invalid)?;
        Ok(Sessions {
            active_client_id: Some(record.client_id.clone()),
            sessions: vec![record],
        })
    }
    fn write_sessions(&self, sessions: &Sessions) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(sessions).map_err(|_| StoreError::Invalid)?;
        let tmp = self
            .dir
            .join(format!(".provider-auth-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)?;
            Ok::<_, std::io::Error>(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(tmp);
        }
        result.map_err(|_| StoreError::Storage)
    }
    fn read_registrations_locked(&self) -> Result<Registrations, StoreError> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = match options.open(&self.registration_path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Registrations::default()),
            Err(_) => return Err(StoreError::Storage),
        };
        let meta = file.metadata().map_err(|_| StoreError::Storage)?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Err(StoreError::Invalid);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(StoreError::Invalid);
            }
        }
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StoreError::Storage)?;
        if bytes.len() > 1024 * 1024 {
            return Err(StoreError::Invalid);
        }
        let mut registrations = match serde_json::from_slice::<Registrations>(&bytes) {
            Ok(r) => r,
            Err(_) => {
                let profile: Registration =
                    serde_json::from_slice(&bytes).map_err(|_| StoreError::Invalid)?;
                Registrations {
                    last_client_id: Some(profile.client_id.clone()),
                    profiles: vec![profile],
                }
            }
        };
        for (i, p) in registrations.profiles.iter_mut().enumerate() {
            if p.connection_label.is_none() {
                p.connection_label = Some(format!("Connection {}", i + 1));
            }
        }
        if let Some(id) = &registrations.last_client_id {
            if let Some(i) = registrations
                .profiles
                .iter()
                .position(|p| &p.client_id == id)
            {
                let selected = registrations.profiles.remove(i);
                registrations.profiles.insert(0, selected);
            }
        }
        Ok(registrations)
    }
    fn write_registrations_locked(&self, registrations: &Registrations) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(registrations).map_err(|_| StoreError::Invalid)?;
        let tmp = self
            .dir
            .join(format!(".provider-auth-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.registration_path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(tmp);
        }
        result.map_err(|_| StoreError::Storage)
    }
    pub async fn registrations(&self) -> Result<Vec<Registration>, StoreError> {
        let _guard = self.lock().await?;
        Ok(self.read_registrations_locked()?.profiles)
    }
    pub async fn profile_snapshot(
        &self,
    ) -> Result<(Vec<Registration>, Vec<Credentials>, Option<String>), StoreError> {
        let _guard = self.lock().await?;
        let registrations = self.read_registrations_locked()?;
        let sessions = self.read_sessions()?;
        Ok((
            registrations.profiles,
            sessions.sessions,
            sessions.active_client_id.or(registrations.last_client_id),
        ))
    }
    pub async fn save_registration(&self, mut profile: Registration) -> Result<(), StoreError> {
        let _guard = self.lock().await?;
        self.save_registration_locked(&mut profile)
    }
    pub(crate) fn save_registration_locked(
        &self,
        profile: &mut Registration,
    ) -> Result<(), StoreError> {
        if !profile.client_id.starts_with("oaiapp_") {
            return Err(StoreError::Invalid);
        }
        let mut registrations = self.read_registrations_locked()?;
        if let Some(old) = registrations
            .profiles
            .iter()
            .find(|p| p.client_id == profile.client_id)
        {
            if old.subject.is_some() && profile.subject.is_some() && old.subject != profile.subject
            {
                return Err(StoreError::Invalid);
            }
            profile.connection_label = old
                .connection_label
                .clone()
                .or(profile.connection_label.clone());
        }
        if profile.connection_label.is_none() {
            let mut n = registrations.profiles.len() + 1;
            while registrations
                .profiles
                .iter()
                .any(|p| p.connection_label.as_deref() == Some(&format!("Connection {n}")))
            {
                n += 1;
            }
            profile.connection_label = Some(format!("Connection {n}"));
        }
        registrations
            .profiles
            .retain(|p| p.client_id != profile.client_id);
        registrations.last_client_id = Some(profile.client_id.clone());
        registrations.profiles.insert(0, profile.clone());
        self.write_registrations_locked(&registrations)
    }
    pub async fn remove_registration(&self, client_id: &str) -> Result<(), StoreError> {
        let _guard = self.lock().await?;
        let mut registrations = self.read_registrations_locked()?;
        let sessions = self.read_sessions()?;
        let index = registrations
            .profiles
            .iter()
            .position(|p| p.client_id == client_id)
            .ok_or(StoreError::Missing)?;
        if registrations.profiles[index].subject.is_some()
            || sessions.sessions.iter().any(|s| s.client_id == client_id)
        {
            return Err(StoreError::Invalid);
        }
        registrations.profiles.remove(index);
        if registrations.last_client_id.as_deref() == Some(client_id) {
            registrations.last_client_id =
                registrations.profiles.first().map(|p| p.client_id.clone());
        }
        self.write_registrations_locked(&registrations)
    }
    pub async fn read(&self) -> Result<Option<Credentials>, StoreError> {
        let _guard = self.lock().await?;
        let s = self.read_sessions()?;
        Ok(s.sessions
            .into_iter()
            .find(|r| Some(&r.client_id) == s.active_client_id.as_ref()))
    }
    pub async fn save(&self, record: Credentials) -> Result<(), StoreError> {
        let _guard = self.lock().await?;
        self.save_locked(record)
    }
    pub(crate) async fn lock(&self) -> Result<CredentialGuard<'_>, StoreError> {
        let local = self.lock.lock().await;
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(self.path.with_extension("lock"))
                .map_err(|_| StoreError::Storage)?;
            if !file.metadata().map_err(|_| StoreError::Storage)?.is_file() {
                return Err(StoreError::Storage);
            }
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(40);
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    let guard = CredentialGuard {
                        _local: local,
                        _file: file,
                    };
                    self.recover_import()?;
                    return Ok(guard);
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != ErrorKind::WouldBlock || tokio::time::Instant::now() >= deadline
                {
                    return Err(StoreError::Storage);
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        #[cfg(not(unix))]
        {
            let guard = CredentialGuard { _local: local };
            self.recover_import()?;
            Ok(guard)
        }
    }
    pub(crate) fn validate_record_locked(&self, record: &Credentials) -> Result<(), StoreError> {
        if record.client_id.is_empty()
            || record.access_token.is_empty()
            || record.subject.is_empty()
        {
            return Err(StoreError::Invalid);
        }
        let sessions = self.read_sessions()?;
        if sessions.sessions.iter().any(|existing| {
            existing.client_id == record.client_id && existing.subject != record.subject
        }) {
            return Err(StoreError::Invalid);
        }
        Ok(())
    }
    pub(crate) fn save_locked(&self, record: Credentials) -> Result<(), StoreError> {
        self.validate_record_locked(&record)?;
        let mut sessions = self.read_sessions()?;
        sessions
            .sessions
            .retain(|r| r.client_id != record.client_id);
        sessions.active_client_id = Some(record.client_id.clone());
        sessions.sessions.push(record);
        self.write_sessions(&sessions)
    }
    pub async fn remove_active(&self) -> Result<(), StoreError> {
        let _guard = self.lock().await?;
        self.remove_active_locked()
    }
    pub(crate) fn active_locked(&self) -> Result<Option<Credentials>, StoreError> {
        let sessions = self.read_sessions()?;
        Ok(sessions
            .sessions
            .into_iter()
            .find(|record| Some(&record.client_id) == sessions.active_client_id.as_ref()))
    }
    pub(crate) fn remove_active_locked(&self) -> Result<(), StoreError> {
        let mut s = self.read_sessions()?;
        s.sessions
            .retain(|r| Some(&r.client_id) != s.active_client_id.as_ref());
        s.active_client_id = None;
        if s.sessions.is_empty() {
            match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(_) => Err(StoreError::Storage),
            }
        } else {
            self.write_sessions(&s)
        }
    }
    /// Re-read inside the lock so concurrent callers do not reuse a rotated token.
    /// The closure must validate the response and return the complete replacement.
    pub async fn access_or_refresh<F, Fut>(
        &self,
        now_ms: i64,
        refresh: F,
    ) -> Result<Credentials, StoreError>
    where
        F: FnOnce(Credentials) -> Fut,
        Fut: Future<Output = Result<Credentials, StoreError>>,
    {
        self.access_or_refresh_for_profile(now_ms, None, refresh)
            .await
    }

    /// Compare the selected profile while holding the same lock as refresh and writes.
    pub async fn access_or_refresh_for_profile<F, Fut>(
        &self,
        now_ms: i64,
        expected_profile: Option<&str>,
        refresh: F,
    ) -> Result<Credentials, StoreError>
    where
        F: FnOnce(Credentials) -> Fut,
        Fut: Future<Output = Result<Credentials, StoreError>>,
    {
        let _guard = self.lock().await?;
        let s = self.read_sessions()?;
        let old = s
            .sessions
            .into_iter()
            .find(|r| Some(&r.client_id) == s.active_client_id.as_ref())
            .ok_or(StoreError::Missing)?;
        if expected_profile.is_some_and(|key| crate::codex_token_broker::profile_key(&old) != key) {
            return Err(StoreError::ProfileChanged);
        }
        if !old.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct") {
            return Err(StoreError::Invalid);
        }
        if old.expires_at.saturating_sub(now_ms) > 60_000 {
            return Ok(old);
        }
        if old.earliest_refresh_at.is_some_and(|t| t > now_ms) {
            return if old.expires_at > now_ms {
                Ok(old)
            } else {
                Err(StoreError::Refresh)
            };
        }
        if old.refresh_token.as_deref().is_none_or(str::is_empty) {
            self.remove_active_locked()?;
            return Err(StoreError::Refresh);
        }
        let updated = match refresh(old.clone()).await {
            Err(StoreError::RefreshRevoked) => {
                self.remove_active_locked()?;
                return Err(StoreError::Refresh);
            }
            other => other?,
        };
        if updated.client_id != old.client_id
            || updated.subject != old.subject
            || updated.refresh_token.as_deref().is_none_or(str::is_empty)
            || updated.expires_at <= now_ms
        {
            return Err(StoreError::Invalid);
        }
        self.save_locked(updated.clone())?;
        if !updated
            .scopes
            .iter()
            .any(|s| s == "chatgpt.tokens.use.direct")
        {
            return Err(StoreError::Invalid);
        }
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn fixture() -> (PathBuf, CredentialStore) {
        let dir = std::env::temp_dir().join(format!("t3-managed-test-{}", uuid::Uuid::new_v4()));
        let store = CredentialStore::new(&dir, "fixture").unwrap();
        (dir, store)
    }
    fn credentials() -> Credentials {
        Credentials {
            client_id: "oaiapp_fixture".into(),
            access_token: "fixture-access".into(),
            refresh_token: Some("fixture-refresh".into()),
            expires_at: 1000,
            earliest_refresh_at: None,
            scopes: vec!["chatgpt.tokens.use.direct".into()],
            subject: "fixture-subject".into(),
            email: None,
            id_token: Some("fixture-id".into()),
            issuer: None,
        }
    }
    #[tokio::test]
    async fn refresh_failure_removes_only_definitively_revoked_credentials() {
        let (dir, store) = fixture();
        store.save(credentials()).await.unwrap();
        assert!(matches!(
            store
                .access_or_refresh(1000, |_| async { Err(StoreError::Refresh) })
                .await,
            Err(StoreError::Refresh)
        ));
        assert!(store.read().await.unwrap().is_some());
        assert!(matches!(
            store
                .access_or_refresh(1000, |_| async { Err(StoreError::RefreshRevoked) })
                .await,
            Err(StoreError::Refresh)
        ));
        assert!(store.read().await.unwrap().is_none());
        let mut no_token = credentials();
        no_token.refresh_token = None;
        store.save(no_token).await.unwrap();
        assert!(matches!(
            store
                .access_or_refresh(1000, |_| async { unreachable!() })
                .await,
            Err(StoreError::Refresh)
        ));
        assert!(store.read().await.unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_lock_serializes_credential_updates() {
        let path = std::env::var_os("T3_TEST_LOCK_DIRECTORY");
        if let Some(path) = path {
            let store = CredentialStore::new(Path::new(&path), "fixture").unwrap();
            let _guard = store.lock().await.unwrap();
            std::fs::write(Path::new(&path).join("ready"), "ready").unwrap();
            while !Path::new(&path).join("release").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            return;
        }
        let (dir, store) = fixture();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "codex_credential_store::tests::process_lock_serializes_credential_updates",
            ])
            .env("T3_TEST_LOCK_DIRECTORY", &dir)
            .spawn()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !dir.join("ready").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), store.lock())
                .await
                .is_err()
        );
        std::fs::write(dir.join("release"), "release").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), store.lock())
                .await
                .unwrap()
                .is_ok()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn interrupted_import_recovers_both_previous_records() {
        let (dir, store) = fixture();
        let original = credentials();
        store.save(original.clone()).await.unwrap();
        let old_registration = Registration {
            client_id: original.client_id.clone(),
            subject: Some(original.subject.clone()),
            email: None,
            connection_label: None,
            sharing_enabled: None,
            redirect_uri: None,
        };
        store.save_registration(old_registration).await.unwrap();
        {
            let _guard = store.lock().await.unwrap();
            let journal = serde_json::to_vec(&(
                store.read_sessions().unwrap(),
                store.read_registrations_locked().unwrap(),
            ))
            .unwrap();
            std::fs::write(&store.journal_path, journal).unwrap();
            let mut replacement = credentials();
            replacement.client_id = "oaiapp_new".into();
            store.save_locked(replacement).unwrap();
        }
        let (profiles, sessions, active) = store.profile_snapshot().await.unwrap();
        assert_eq!(active.as_deref(), Some(original.client_id.as_str()));
        assert_eq!(sessions.len(), 1);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].client_id, original.client_id);
        assert!(!store.journal_path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn private_atomic_storage_and_redaction() {
        let (dir, store) = fixture();
        store.save(credentials()).await.unwrap();
        assert!(!format!("{:?}", store.read().await.unwrap().unwrap()).contains("fixture"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let reader_path = store.path.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..500 {
                let data = std::fs::read(&reader_path).unwrap();
                assert!(serde_json::from_slice::<Sessions>(&data).is_ok());
            }
        });
        for i in 0..50 {
            let mut c = credentials();
            c.access_token = format!("fixture-{i}");
            store.save(c).await.unwrap();
        }
        reader.join().unwrap();
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            if cfg!(unix) { 2 } else { 1 }
        );
        store.remove_active().await.unwrap();
        assert!(store.read().await.unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn profile_bound_access_rechecks_after_concurrent_account_switch() {
        let (dir, store) = fixture();
        let original = credentials();
        let expected = crate::codex_token_broker::profile_key(&original);
        store.save(original).await.unwrap();
        let guard = store.lock().await.unwrap();
        let reader = store.clone();
        let request = tokio::spawn(async move {
            reader
                .access_or_refresh_for_profile(0, Some(&expected), |_| async {
                    panic!("mismatched account must never be refreshed")
                })
                .await
        });
        tokio::task::yield_now().await;
        let mut replacement = credentials();
        replacement.client_id = "oaiapp_other".into();
        replacement.subject = "other".into();
        replacement.access_token = "other-secret".into();
        store.save_locked(replacement).unwrap();
        drop(guard);
        assert!(matches!(
            request.await.unwrap(),
            Err(StoreError::ProfileChanged)
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn concurrent_refresh_uses_rotated_token_once() {
        let (dir, store) = fixture();
        store.save(credentials()).await.unwrap();
        let second = CredentialStore::new(&dir, "fixture").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let refresh = |s: CredentialStore, calls: Arc<AtomicUsize>| async move {
            s.access_or_refresh(1000, |mut c| async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                c.refresh_token = Some("rotated".into());
                c.expires_at = 100_000;
                Ok(c)
            })
            .await
            .unwrap()
        };
        let (a, b) = tokio::join!(
            refresh(store, calls.clone()),
            refresh(second, calls.clone())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(a.refresh_token, b.refresh_token);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_and_non_regular_files() {
        let (dir, store) = fixture();
        std::fs::write(&store.path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        assert!(matches!(store.read().await, Err(StoreError::Invalid)));
        std::fs::remove_file(&store.path).unwrap();
        std::fs::create_dir(&store.path).unwrap();
        assert!(store.read().await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_without_reading_target() {
        use std::os::unix::fs::symlink;
        let (dir, store) = fixture();
        let target = dir.join("target");
        std::fs::write(&target, serde_json::to_vec(&credentials()).unwrap()).unwrap();
        symlink(&target, &store.path).unwrap();
        assert!(store.read().await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn lost_refresh_scope_persists_rotated_token_but_denies_access() {
        let (dir, store) = fixture();
        store.save(credentials()).await.unwrap();
        let result = store
            .access_or_refresh(1000, |mut c| async move {
                c.access_token = "replacement".into();
                c.refresh_token = Some("rotated".into());
                c.expires_at = 100_000;
                c.scopes.clear();
                Ok(c)
            })
            .await;
        assert!(matches!(result, Err(StoreError::Invalid)));
        let saved = store.read().await.unwrap().unwrap();
        assert_eq!(saved.refresh_token.as_deref(), Some("rotated"));
        assert!(saved.scopes.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_refuses_a_symlinked_journal() {
        use std::os::unix::fs::symlink;
        let (dir, store) = fixture();
        let target = dir.join("unrelated");
        std::fs::write(&target, "keep").unwrap();
        symlink(&target, &store.journal_path).unwrap();
        assert!(store.read().await.is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod registration_tests {
    use super::*;
    fn registration(id: &str) -> Registration {
        Registration {
            client_id: id.into(),
            subject: None,
            email: None,
            connection_label: None,
            sharing_enabled: None,
            redirect_uri: None,
        }
    }
    #[tokio::test]
    async fn registrations_persist_order_labels_and_restrict_removal() {
        let dir = std::env::temp_dir().join(format!("registrations-{}", uuid::Uuid::new_v4()));
        let store = CredentialStore::new(&dir, "test").unwrap();
        store
            .save_registration(registration("oaiapp_one"))
            .await
            .unwrap();
        store
            .save_registration(registration("oaiapp_two"))
            .await
            .unwrap();
        let reopened = CredentialStore::new(&dir, "test").unwrap();
        let profiles = reopened.registrations().await.unwrap();
        assert_eq!(profiles[0].client_id, "oaiapp_two");
        assert_eq!(
            profiles[0].connection_label.as_deref(),
            Some("Connection 2")
        );
        let mut complete = registration("oaiapp_two");
        complete.subject = Some("person".into());
        reopened.save_registration(complete).await.unwrap();
        assert!(reopened.remove_registration("oaiapp_two").await.is_err());
        reopened.remove_registration("oaiapp_one").await.unwrap();
        assert_eq!(store.registrations().await.unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
