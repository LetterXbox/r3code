//! Private one-use secret request storage.
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
#[cfg(test)]
use std::io::Read;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

type HmacSha256 = Hmac<Sha256>;
const TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Derive the same stable reference used by the upstream secret-request service.
pub fn reference(salt: &[u8; 32], thread_id: &str, item_id: &str) -> String {
    let key: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC key");
    mac.update(thread_id.as_bytes());
    mac.update(b"\0");
    mac.update(item_id.as_bytes());
    let bytes = mac.finalize().into_bytes();
    format!(
        "secret-ref:{}",
        bytes[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
fn filename(reference: &str) -> Result<String, String> {
    let id = reference
        .strip_prefix("secret-ref:")
        .ok_or("That secretRef is not valid.")?;
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("That secretRef is not valid.".into());
    }
    Ok(format!("secret-request-{id}.bin"))
}
/// Create a request value without overwriting an earlier answer.
pub fn create(
    dir: &Path,
    reference: &str,
    project: &str,
    value: &str,
    now_ms: i64,
) -> Result<(), String> {
    let name = filename(reference)?;
    crate::signing_key::secure_secrets_dir(dir).map_err(|_| "Could not store the secret.")?;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let temp = dir.join(format!(".secret-request-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = opts
        .open(&temp)
        .map_err(|_| "Could not store the secret.")?;
    let result = file
        .write_all(
            json!({"projectId":project,"value":value,"savedAt":now_ms})
                .to_string()
                .as_bytes(),
        )
        .and_then(|_| file.sync_all());
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Could not store the secret.".into());
    }
    let linked = fs::hard_link(&temp, dir.join(name));
    let _ = fs::remove_file(&temp);
    linked.map_err(|_| "Could not store the secret.".to_string())
}
pub fn delivery_path(dir: &Path, reference: &str) -> Result<std::path::PathBuf, String> {
    let name = filename(reference)?;
    let id = name
        .strip_prefix("secret-request-")
        .and_then(|s| s.strip_suffix(".bin"))
        .ok_or("Invalid secret reference.")?;
    Ok(dir.join("files").join(id))
}

/// Write a private file once. Retries preserve the original bytes.
pub fn write_delivery_file(
    dir: &Path,
    reference: &str,
    value: &str,
) -> Result<std::path::PathBuf, String> {
    let name = filename(reference)?;
    let id = name
        .strip_prefix("secret-request-")
        .and_then(|s| s.strip_suffix(".bin"))
        .ok_or("Invalid secret reference.")?;
    crate::signing_key::secure_secrets_dir(dir).map_err(|_| "Could not store the secret.")?;
    let files = dir.join("files");
    crate::signing_key::secure_secrets_dir(&files).map_err(|_| "Could not store the secret.")?;
    let target = files.join(id);
    if target.exists() {
        return Ok(target);
    }
    let temp = files.join(format!(".{id}.{}.partial", uuid::Uuid::new_v4()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&temp)
        .map_err(|_| "Could not store the secret.")?;
    if file
        .write_all(value.as_bytes())
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temp);
        return Err("Could not store the secret.".into());
    }
    let linked = fs::hard_link(&temp, &target);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(target),
        Err(_) => Err("Could not store the secret.".into()),
    }
}

/// Delete expired private values and delivery files. Unknown files are untouched.
pub fn sweep_expired(dir: &Path, now_ms: i64) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|_| "Could not sweep secrets.")? {
        let entry = entry.map_err(|_| "Could not sweep secrets.")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_prefix("secret-request-")
            .and_then(|s| s.strip_suffix(".bin"))
        else {
            continue;
        };
        if filename(&format!("secret-ref:{id}")).is_err() {
            continue;
        }
        let expired = fs::read(entry.path())
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["savedAt"].as_i64())
            .is_none_or(|saved| now_ms.saturating_sub(saved) > TTL_MS);
        if expired {
            fs::remove_file(entry.path()).map_err(|_| "Could not sweep secrets.")?;
        }
    }
    let files = dir.join("files");
    if files.exists() {
        for entry in fs::read_dir(files).map_err(|_| "Could not sweep secrets.")? {
            let entry = entry.map_err(|_| "Could not sweep secrets.")?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = if let Some(partial) = name
                .strip_prefix('.')
                .and_then(|n| n.strip_suffix(".partial"))
            {
                partial.split_once('.').map(|(id, _)| id).unwrap_or("")
            } else {
                name.strip_suffix(".partial").unwrap_or(&name)
            };
            if filename(&format!("secret-ref:{id}")).is_err() {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            if modified.is_some_and(|t| now_ms.saturating_sub(t) > TTL_MS) {
                fs::remove_file(entry.path()).map_err(|_| "Could not sweep secrets.")?;
            }
        }
    }
    Ok(())
}

pub fn remove(dir: &Path, reference: &str) -> Result<(), String> {
    match fs::remove_file(dir.join(filename(reference)?)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not remove the secret.".into()),
    }
}

/// Remove files whose claims committed. A crash before cleanup leaves the claim
/// authoritative and cleanup can safely be retried on startup or the next save.
pub fn cleanup_claimed(db: &rusqlite::Connection, dir: &Path) -> Result<(), String> {
    if !db.is_autocommit() {
        return Err("Secret cleanup requires a committed transaction.".into());
    }
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_private_secret_ref_claims')", [], |r| r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Ok(());
    }
    let mut statement = db
        .prepare("SELECT ref FROM t3_private_secret_ref_claims")
        .map_err(|e| e.to_string())?;
    let refs = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for reference in refs {
        let path = dir.join(filename(&reference.map_err(|e| e.to_string())?)?);
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Could not remove a used secret.".into()),
        }
    }
    Ok(())
}

/// Read a private value for a transaction that will atomically claim its reference.
/// Callers must serialize and record the claim in the same database transaction as use.
pub(crate) fn read_for_claim(
    dir: &Path,
    reference: &str,
    project: &str,
    now_ms: i64,
) -> Result<String, String> {
    let path = dir.join(filename(reference)?);
    let bytes = fs::read(path).map_err(|_| {
        "That secretRef was already used or does not exist. Ask the user again with request_secret."
    })?;
    let stored: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        "That secretRef was already used or does not exist. Ask the user again with request_secret."
    })?;
    if stored["projectId"].as_str() != Some(project) {
        return Err("That secretRef was already used or does not exist. Ask the user again with request_secret.".into());
    }
    let saved = stored["savedAt"]
        .as_i64()
        .ok_or("Could not read the secret.")?;
    if now_ms.saturating_sub(saved) > TTL_MS {
        return Err("That secretRef expired. Ask the user again with request_secret.".into());
    }
    stored["value"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Could not read the secret.".into())
}

/// Consume a value once, subject to project binding and a 24-hour lifetime.
/// An advisory directory lock serializes consumers across processes.
#[cfg(test)]
fn consume(dir: &Path, reference: &str, project: &str, now_ms: i64) -> Result<String, String> {
    let name = filename(reference)?;
    #[cfg(not(unix))]
    return Err("Secret consumption is unavailable on this platform.".into());
    crate::signing_key::secure_secrets_dir(dir).map_err(|_| "Could not read the secret.")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(dir.join(".secret-request.lock"))
        .map_err(|_| "Could not read the secret.")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err("Could not read the secret.".into());
        }
    }
    let path = dir.join(name);
    let mut bytes = Vec::new();
    let mut file = OpenOptions::new().read(true).open(&path).map_err(|_| {
        "That secretRef was already used or does not exist. Ask the user again with request_secret."
    })?;
    file.read_to_end(&mut bytes)
        .map_err(|_| "Could not read the secret.")?;
    let stored: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        "That secretRef was already used or does not exist. Ask the user again with request_secret."
    })?;
    if stored["projectId"].as_str() != Some(project) {
        return Err("That secretRef was already used or does not exist. Ask the user again with request_secret.".into());
    }
    let saved = stored["savedAt"].as_i64().ok_or("That secretRef was already used or does not exist. Ask the user again with request_secret.")?;
    let value = stored["value"].as_str().ok_or("That secretRef was already used or does not exist. Ask the user again with request_secret.")?.to_owned();
    if now_ms.saturating_sub(saved) > TTL_MS {
        fs::remove_file(path).map_err(|_| "Could not use that secretRef. Try again.")?;
        return Err("That secretRef expired. Ask the user again with request_secret.".into());
    }
    fs::remove_file(path).map_err(|_| "Could not use that secretRef. Try again.")?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_is_private_idempotent_and_expired_files_are_swept() {
        let dir = std::env::temp_dir().join(format!("t3-secret-test-{}", uuid::Uuid::new_v4()));
        let reference = reference(&[8; 32], "thread", "item");
        let file = write_delivery_file(&dir, &reference, "first").unwrap();
        assert_eq!(
            write_delivery_file(&dir, &reference, "second").unwrap(),
            file
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "first");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(file.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        create(&dir, &reference, "p", "private", 100).unwrap();
        sweep_expired(&dir, i64::MAX).unwrap();
        assert!(!file.exists());
        assert!(read_for_claim(&dir, &reference, "p", 100).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn project_expiry_and_concurrent_consumption() {
        let dir = std::env::temp_dir().join(format!("t3-secret-test-{}", uuid::Uuid::new_v4()));
        let r = reference(&[3; 32], "thread", "item");
        create(&dir, &r, "p", "private", 100).unwrap();
        assert!(consume(&dir, &r, "other", 100).is_err());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let d = dir.clone();
                let r = r.clone();
                std::thread::spawn(move || consume(&d, &r, "p", 100))
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
        create(&dir, &r, "p", "private", 100).unwrap();
        assert!(consume(&dir, &r, "p", 100 + TTL_MS + 1)
            .unwrap_err()
            .contains("expired"));
        assert!(consume(&dir, &r, "p", 100).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
