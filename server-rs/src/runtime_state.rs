//! Atomic publication of `server-runtime.json` and owner-checked cleanup.
//!
//! Runtime discovery must never observe a partially written record, and a
//! process must not remove a replacement server's record during shutdown.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRuntimeState {
    pub version: u8,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub private_network_only: bool,
    pub port: u16,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_url: Option<String>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub service_managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl ServerRuntimeState {
    pub fn new(input: ServerRuntimeStateInput) -> Self {
        let origin_host = input
            .host
            .as_deref()
            .filter(|host| !matches!(*host, "0.0.0.0" | "::" | "[::]"))
            .unwrap_or("127.0.0.1");
        let origin_host = if origin_host.contains(':') && !origin_host.starts_with('[') {
            format!("[{origin_host}]")
        } else {
            origin_host.to_owned()
        };
        Self {
            version: 1,
            pid: std::process::id(),
            owner_id: Some(input.owner_id),
            host: input.host,
            private_network_only: input.private_network_only,
            port: input.port,
            origin: format!("http://{origin_host}:{}", input.port),
            dev_url: input.dev_url,
            started_at: input.started_at,
            service_managed: input.service_managed,
            server_version: Some(input.server_version),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerRuntimeStateInput {
    pub owner_id: String,
    pub host: Option<String>,
    pub private_network_only: bool,
    pub port: u16,
    pub dev_url: Option<String>,
    pub service_managed: bool,
    pub server_version: String,
    pub started_at: String,
}

/// Write one JSON line using a same-directory temporary file and atomic rename.
pub fn publish(path: &Path, state: &ServerRuntimeState) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime state path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(".server-runtime-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut file = options.open(&temp_path)?;
    let write_result = (|| {
        serde_json::to_writer(&mut file, state).map_err(io::Error::other)?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

/// Remove a runtime record only when it still belongs to the shutting-down owner.
/// A legacy record without `ownerId` is deliberately left untouched.
pub fn remove_if_owned(path: &Path, owner_id: &str) -> io::Result<bool> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let value: serde_json::Value = serde_json::from_str(&text).map_err(io::Error::other)?;
    if value.get("ownerId").and_then(serde_json::Value::as_str) != Some(owner_id) {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("t3-runtime-state-{}", Uuid::new_v4()));
        (root.join("userdata/server-runtime.json"), root)
    }

    fn state(owner_id: &str, host: Option<String>) -> ServerRuntimeState {
        ServerRuntimeState::new(ServerRuntimeStateInput {
            owner_id: owner_id.into(),
            host,
            private_network_only: true,
            port: 3773,
            dev_url: None,
            service_managed: false,
            server_version: "0.1.0".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        })
    }

    #[test]
    fn publish_is_discoverable_and_shutdown_only_removes_its_own_record() {
        let (path, root) = temp_file();
        let first = state("owner-one", Some("0.0.0.0".into()));
        publish(&path, &first).unwrap();
        let published: ServerRuntimeState =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(published, first);
        assert_eq!(published.origin, "http://127.0.0.1:3773");
        assert!(!remove_if_owned(&path, "owner-two").unwrap());
        assert!(path.exists());

        let replacement = state("owner-two", Some("::1".into()));
        publish(&path, &replacement).unwrap();
        assert_eq!(replacement.origin, "http://[::1]:3773");
        assert!(!remove_if_owned(&path, "owner-one").unwrap());
        assert!(remove_if_owned(&path, "owner-two").unwrap());
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_runtime_state_without_owner_is_not_removed() {
        let (path, root) = temp_file();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":1,"pid":1,"port":3773}"#).unwrap();
        assert!(!remove_if_owned(&path, "owner-one").unwrap());
        assert!(path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
