//! Cursor SDK credential records share the original server's private secret-store layout.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn secret_path(settings: &Path, instance: &str) -> Result<PathBuf, String> {
    if instance.is_empty() {
        return Err("Cursor credential binding is invalid".into());
    }
    let directory = settings
        .parent()
        .ok_or("Cursor credential directory is unavailable")?
        .join("secrets");
    crate::signing_key::secure_secrets_dir(&directory)
        .map_err(|_| "Cursor credential directory is unavailable")?;
    let hash = Sha256::digest(format!("6:cursor{instance}").as_bytes());
    let encoded: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(directory.join(format!("provider-auth-{encoded}.bin")))
}
fn valid(value: &Value) -> bool {
    value["version"] == 1
        && value["backendUrl"].is_string()
        && value["apiKey"].as_str().is_some_and(|v| !v.is_empty())
        && value["createdAtMs"].as_f64().is_some_and(f64::is_finite)
        && value
            .get("apiKeyExpiresAtMs")
            .is_none_or(|v| v.as_f64().is_some_and(f64::is_finite))
        && value.get("email").is_none_or(Value::is_string)
}
pub(crate) fn read(settings: &Path, instance: &str) -> Result<Option<Value>, String> {
    let path = secret_path(settings, instance)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read Cursor credentials".into()),
    };
    let mut data = Vec::new();
    file.take(1_048_577)
        .read_to_end(&mut data)
        .map_err(|_| "Could not read Cursor credentials")?;
    if data.len() > 1_048_576 {
        return Err("Could not read Cursor credentials".into());
    }
    let Ok(value) = serde_json::from_slice::<Value>(&data) else {
        return Ok(None);
    };
    if !valid(&value) {
        return Ok(None);
    }
    if value["apiKeyExpiresAtMs"]
        .as_f64()
        .is_some_and(|expires| expires <= chrono::Utc::now().timestamp_millis() as f64)
    {
        return Ok(None);
    }
    Ok(Some(value))
}
pub(crate) fn save(settings: &Path, instance: &str, value: &Value) -> Result<(), String> {
    if !valid(value) {
        return Err("Cursor returned an unsupported credential format".into());
    }
    let path = secret_path(settings, instance)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, value).map_err(std::io::Error::other)?;
        file.flush()?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
        return Err("Could not save Cursor credentials".into());
    }
    Ok(())
}
pub(crate) fn remove(settings: &Path, instance: &str) -> Result<(), String> {
    match std::fs::remove_file(secret_path(settings, instance)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not remove Cursor credentials".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn credentials_are_private_scoped_and_expire() {
        let root =
            std::env::temp_dir().join(format!("t3-cursor-credentials-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        let value = json!({"version":1,"backendUrl":"https://example.test","apiKey":"fixture-private-key","createdAtMs":1});
        save(&settings, "first", &value).unwrap();
        assert_eq!(read(&settings, "first").unwrap(), Some(value.clone()));
        assert_eq!(read(&settings, "second").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(secret_path(&settings, "first").unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let mut expired = value;
        expired["apiKeyExpiresAtMs"] = json!(1);
        save(&settings, "first", &expired).unwrap();
        assert_eq!(read(&settings, "first").unwrap(), None);
        remove(&settings, "first").unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
