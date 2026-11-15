//! Resolve T3 release metadata through the host's configured npm registry.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

type Cached = Option<(Instant, Result<Value, String>)>;
type Entry = Arc<AsyncMutex<Cached>>;
struct State {
    entries: Mutex<HashMap<String, Entry>>,
    permits: Arc<Semaphore>,
}
fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| State {
        entries: Mutex::new(HashMap::new()),
        permits: Arc::new(Semaphore::new(2)),
    })
}
fn valid(spec: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    spec.len() <= 64
        && PATTERN
            .get_or_init(|| {
                regex::Regex::new(
                    r"\A(?:latest|nightly|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\z",
                )
                .unwrap()
            })
            .is_match(spec)
}
fn decode(spec: &str, bytes: &[u8]) -> Result<Value, String> {
    let invalid = || "npm returned invalid release metadata.".to_owned();
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let value = match &value {
        Value::Array(a) if a.len() == 1 => &a[0],
        _ => &value,
    };
    let version = value
        .as_str()
        .or_else(|| value.get("version").and_then(Value::as_str))
        .ok_or_else(invalid)?;
    if !valid(version)
        || matches!(version, "latest" | "nightly")
        || (!matches!(spec, "latest" | "nightly") && version != spec)
    {
        return Err(invalid());
    }
    let mut result = json!({"version":version});
    if let Some(migration) = value
        .pointer("/t3code/databaseMigration")
        .and_then(Value::as_i64)
    {
        result["databaseMigration"] = json!(migration);
    }
    Ok(result)
}

/// Invalid input is rejected before resolving or invoking npm.
pub async fn get(spec: &str) -> Result<Value, String> {
    if !valid(spec) {
        return Err("Invalid release version or track.".into());
    }
    let state = state();
    let entry = {
        let mut entries = state.entries.lock().expect("npm cache lock poisoned");
        if !entries.contains_key(spec) && entries.len() >= 32 {
            if let Some(key) = entries.keys().next().cloned() {
                entries.remove(&key);
            }
        }
        entries.entry(spec.to_owned()).or_default().clone()
    };
    let mut entry = entry.lock().await;
    if let Some((at, result)) = &*entry {
        if at.elapsed() < Duration::from_secs(60) {
            return result.clone();
        }
    }
    let result = lookup(spec.to_owned(), state.permits.clone()).await;
    *entry = Some((Instant::now(), result.clone()));
    result
}
async fn lookup(spec: String, permits: Arc<Semaphore>) -> Result<Value, String> {
    let permit = permits
        .acquire_owned()
        .await
        .map_err(|_| "npm could not complete the lookup.".to_owned())?;
    let requested = spec.clone();
    let output = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let executable = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let mut command = std::process::Command::new(executable);
        command.args([
            "view",
            "--global",
            "--json",
            &format!("t3@{requested}"),
            "version",
            "t3code",
        ]);
        crate::vcs_worktree::run_command(&mut command, Duration::from_secs(15))
    })
    .await
    .map_err(|_| "npm could not complete the lookup.".to_owned())?;
    match output {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => public_lookup(&spec).await,
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            Err("npm returned an incomplete response.".into())
        }
        Err(_) => Err("npm could not complete the lookup.".into()),
        Ok(output) => {
            if output.stdout.len() > 256 * 1024 || std::str::from_utf8(&output.stdout).is_err() {
                return Err("npm returned an incomplete response.".into());
            }
            if !output.status.success() {
                let error: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
                return if error.pointer("/error/code").and_then(Value::as_str) == Some("E404") {
                    Ok(Value::Null)
                } else {
                    Err("npm could not read release metadata.".into())
                };
            }
            decode(&spec, &output.stdout)
        }
    }
}
async fn public_lookup(spec: &str) -> Result<Value, String> {
    let unreachable =
        || "npm is not installed and the public npm registry could not be reached.".to_owned();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| unreachable())?;
    let mut response = client
        .get(format!("https://registry.npmjs.org/t3/{spec}"))
        .send()
        .await
        .map_err(|_| unreachable())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(unreachable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable())? {
        if bytes.len().saturating_add(chunk.len()) > 256 * 1024 {
            return Err(unreachable());
        }
        bytes.extend_from_slice(&chunk);
    }
    decode(spec, &bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_specs_and_release_metadata() {
        for bad in [
            "",
            "--registry=https://example.org",
            "../x",
            "t3@latest",
            "*",
        ] {
            assert!(!valid(bad));
        }
        let manifest =
            br#"[{"version":"0.1.5-nightly.20261030.1","t3code":{"databaseMigration":42}}]"#;
        assert_eq!(
            decode("nightly", manifest).unwrap(),
            json!({"version":"0.1.5-nightly.20261030.1","databaseMigration":42})
        );
        assert_eq!(
            decode("latest", br#""1.2.3""#).unwrap(),
            json!({"version":"1.2.3"})
        );
        assert!(decode("1.2.4", br#"{"version":"1.2.3"}"#).is_err());
        assert!(decode("latest", b"[]").is_err());
    }
}
