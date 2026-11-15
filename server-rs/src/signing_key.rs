//! Persistent signing key compatible with the server's flat secret store.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug)]
pub enum SigningKeyError {
    Secure(io::Error),
    Read(io::Error),
    Persist(io::Error),
    Random(getrandom::Error),
    ConcurrentRead,
    InvalidLength(usize),
}
impl std::fmt::Display for SigningKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SigningKeyError {}

/// The directory must be private before any key is read or written.
pub fn secure_secrets_dir(dir: &Path) -> Result<(), SigningKeyError> {
    fs::create_dir_all(dir).map_err(SigningKeyError::Secure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(SigningKeyError::Secure)?;
    }
    Ok(())
}
fn read_key(path: &Path) -> Result<Option<[u8; 32]>, SigningKeyError> {
    match fs::read(path) {
        Ok(bytes) => {
            let len = bytes.len();
            bytes
                .try_into()
                .map(Some)
                .map_err(|_| SigningKeyError::InvalidLength(len))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(SigningKeyError::Read(error)),
    }
}
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Load the stable 32-byte server signing key, atomically creating it when absent.
/// A losing creator reads the winning value; no reader sees partially written bytes.
pub fn load_or_create_server_signing_key(secrets_dir: &Path) -> Result<[u8; 32], SigningKeyError> {
    load_or_create_key(secrets_dir, "server-signing-key.bin")
}

pub fn load_or_create_key(secrets_dir: &Path, name: &str) -> Result<[u8; 32], SigningKeyError> {
    secure_secrets_dir(secrets_dir)?;
    let target = secrets_dir.join(name);
    if let Some(key) = read_key(&target)? {
        return Ok(key);
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(SigningKeyError::Random)?;
    let temp = TempFile(secrets_dir.join(format!("{name}.{}.tmp", Uuid::new_v4())));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp.0).map_err(SigningKeyError::Persist)?;
    file.write_all(&key).map_err(SigningKeyError::Persist)?;
    file.sync_all().map_err(SigningKeyError::Persist)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(SigningKeyError::Persist)?;
    }
    match fs::hard_link(&temp.0, &target) {
        Ok(()) => Ok(key),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            read_key(&target)?.ok_or(SigningKeyError::ConcurrentRead)
        }
        Err(error) => Err(SigningKeyError::Persist(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_creators_share_complete_private_key() {
        let dir = std::env::temp_dir().join(format!("t3-signing-test-{}", Uuid::new_v4()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let path = dir.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    load_or_create_server_signing_key(&path).unwrap()
                })
            })
            .collect();
        let keys: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(keys.iter().all(|key| key == &keys[0]));
        assert_eq!(
            fs::read(dir.join("server-signing-key.bin")).unwrap(),
            keys[0]
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(dir.join("server-signing-key.bin"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_existing_key_fails_without_replacement() {
        let dir = std::env::temp_dir().join(format!("t3-signing-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("server-signing-key.bin"), b"bad").unwrap();
        assert!(matches!(
            load_or_create_server_signing_key(&dir),
            Err(SigningKeyError::InvalidLength(3))
        ));
        assert_eq!(
            fs::read(dir.join("server-signing-key.bin")).unwrap(),
            b"bad"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
