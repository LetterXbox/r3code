//! Standalone issue tracker credentials and per-project scope bindings.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, sync::Mutex};
use uuid::Uuid;

use super::linear;

pub const LINEAR_KIND: &str = "linear";

#[derive(Clone, Debug)]
pub struct ConnectionError {
    pub tracker: String,
    pub reason: &'static str,
    pub detail: String,
}

impl ConnectionError {
    pub fn to_wire(&self) -> Value {
        json!({
            "_tag": "IssueTrackerConnectionError",
            "tracker": self.tracker,
            "reason": self.reason,
            "detail": if self.detail.trim().is_empty() {
                "Issue tracker connection failed.".to_owned()
            } else {
                self.detail.clone()
            }
        })
    }
}

pub fn issue_tracker_secret_name(tracker: &str) -> String {
    format!(
        "issue-tracker-{}-token",
        URL_SAFE_NO_PAD.encode(tracker.as_bytes())
    )
}

fn secret_path(secrets_dir: &Path, tracker: &str) -> Result<std::path::PathBuf, ConnectionError> {
    let name = issue_tracker_secret_name(tracker);
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(ConnectionError {
            tracker: tracker.to_owned(),
            reason: "failed",
            detail: "Invalid secret name.".to_owned(),
        });
    }
    Ok(secrets_dir.join(format!("{name}.bin")))
}

pub fn read_tracker_token(secrets_dir: &Path, tracker: &str) -> Result<Option<String>, ConnectionError> {
    let path = secret_path(secrets_dir, tracker)?;
    match fs::read_to_string(&path) {
        Ok(value) => {
            let trimmed = value.trim().to_owned();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ConnectionError {
            tracker: tracker.to_owned(),
            reason: "failed",
            detail: format!("The stored credential could not be read: {error}"),
        }),
    }
}

fn write_tracker_token(secrets_dir: &Path, tracker: &str, token: &str) -> Result<(), ConnectionError> {
    crate::signing_key::secure_secrets_dir(secrets_dir).map_err(|_| ConnectionError {
        tracker: tracker.to_owned(),
        reason: "failed",
        detail: "The credential directory could not be secured.".to_owned(),
    })?;
    let target = secret_path(secrets_dir, tracker)?;
    let temp = secrets_dir.join(format!(
        "{}.{}.tmp",
        issue_tracker_secret_name(tracker),
        Uuid::new_v4()
    ));
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt, os::unix::fs::PermissionsExt};
        let write_result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(token.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp, &target)?;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp);
            return Err(ConnectionError {
                tracker: tracker.to_owned(),
                reason: "failed",
                detail: format!("The credential could not be stored: {error}"),
            });
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(error) = fs::write(&temp, token.as_bytes()).and_then(|_| fs::rename(&temp, &target)) {
            let _ = fs::remove_file(&temp);
            return Err(ConnectionError {
                tracker: tracker.to_owned(),
                reason: "failed",
                detail: format!("The credential could not be stored: {error}"),
            });
        }
    }
    Ok(())
}

fn remove_tracker_token(secrets_dir: &Path, tracker: &str) -> Result<(), ConnectionError> {
    let path = secret_path(secrets_dir, tracker)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConnectionError {
            tracker: tracker.to_owned(),
            reason: "failed",
            detail: format!("The credential could not be removed: {error}"),
        }),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectBinding {
    pub tracker: String,
    pub scope: String,
}

pub fn list_bindings(db: &Connection) -> rusqlite::Result<BTreeMap<String, ProjectBinding>> {
    let mut stmt = db.prepare(
        "SELECT project_id, tracker, scope FROM issue_tracker_bindings ORDER BY project_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ProjectBinding {
                tracker: row.get(1)?,
                scope: row.get(2)?,
            },
        ))
    })?;
    let mut out = BTreeMap::new();
    for item in rows {
        let (project_id, binding) = item?;
        out.insert(project_id, binding);
    }
    Ok(out)
}

pub fn linear_descriptor() -> Value {
    json!({
        "tracker": LINEAR_KIND,
        "displayName": "Linear",
        "host": linear::LINEAR_HOST,
        "scopeNoun": "team",
        "credential": {
            "label": "Personal API key",
            "helpUrl": "https://linear.app/settings/account/security"
        }
    })
}

fn disconnected_linear() -> Value {
    let mut d = linear_descriptor();
    d["connected"] = json!(false);
    d["account"] = Value::Null;
    d["detail"] = Value::Null;
    d["scopes"] = json!([]);
    d
}

fn connected_linear(probe: linear::ProbeResult) -> Value {
    let mut d = linear_descriptor();
    d["connected"] = json!(true);
    d["account"] = json!(probe.account);
    d["detail"] = Value::Null;
    if let Some(ws) = probe.workspace {
        d["workspace"] = json!(ws);
    }
    d["scopes"] = json!(probe
        .scopes
        .into_iter()
        .map(|(key, name)| json!({"key": key, "name": name}))
        .collect::<Vec<_>>());
    d
}

pub async fn list(db: &Mutex<Connection>, secrets_dir: &Path) -> Result<Value, Value> {
    let token = read_tracker_token(secrets_dir, LINEAR_KIND).map_err(|e| e.to_wire())?;
    let tracker = match token {
        None => disconnected_linear(),
        Some(token) => match linear::probe_credential(&token).await {
            Ok(probe) => connected_linear(probe),
            Err(err) => {
                let mut d = linear_descriptor();
                d["connected"] = json!(true);
                d["account"] = Value::Null;
                d["detail"] = json!(err.detail_text());
                d["scopes"] = json!([]);
                d
            }
        },
    };
    let bindings = {
        let guard = db.lock().map_err(|_| {
            ConnectionError {
                tracker: LINEAR_KIND.to_owned(),
                reason: "failed",
                detail: "The project bindings could not be read.".to_owned(),
            }
            .to_wire()
        })?;
        list_bindings(&guard).map_err(|_| {
            ConnectionError {
                tracker: LINEAR_KIND.to_owned(),
                reason: "failed",
                detail: "The project bindings could not be read.".to_owned(),
            }
            .to_wire()
        })?
    };
    let mut bindings_json = serde_json::Map::new();
    for (project_id, binding) in bindings {
        bindings_json.insert(
            project_id,
            json!({
                "tracker": binding.tracker,
                "scope": binding.scope,
            }),
        );
    }
    Ok(json!({
        "trackers": [tracker],
        "bindings": bindings_json,
    }))
}

pub async fn connect(
    db: &Mutex<Connection>,
    secrets_dir: &Path,
    payload: &Value,
) -> Result<Value, Value> {
    let tracker = payload
        .get("tracker")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ConnectionError {
                tracker: "unknown".to_owned(),
                reason: "unknown-tracker",
                detail: "This server has no such issue tracker.".to_owned(),
            }
            .to_wire()
        })?;
    if tracker != LINEAR_KIND {
        return Err(ConnectionError {
            tracker: tracker.to_owned(),
            reason: "unknown-tracker",
            detail: "This server has no such issue tracker.".to_owned(),
        }
        .to_wire());
    }
    let token = match payload.get("token") {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        }
        Some(_) => {
            return Err(ConnectionError {
                tracker: tracker.to_owned(),
                reason: "failed",
                detail: "Invalid issue tracker credential payload.".to_owned(),
            }
            .to_wire())
        }
    };
    match token {
        None => {
            remove_tracker_token(secrets_dir, LINEAR_KIND).map_err(|e| e.to_wire())?;
            let guard = db.lock().map_err(|_| {
                ConnectionError {
                    tracker: LINEAR_KIND.to_owned(),
                    reason: "failed",
                    detail: "The project bindings could not be cleared.".to_owned(),
                }
                .to_wire()
            })?;
            guard
                .execute("DELETE FROM issue_tracker_bindings WHERE tracker = ?1", [LINEAR_KIND])
                .map_err(|_| {
                    ConnectionError {
                        tracker: LINEAR_KIND.to_owned(),
                        reason: "failed",
                        detail: "The project bindings could not be cleared.".to_owned(),
                    }
                    .to_wire()
                })?;
            Ok(disconnected_linear())
        }
        Some(token) => {
            let probe = linear::probe_credential(&token).await.map_err(|err| {
                ConnectionError {
                    tracker: LINEAR_KIND.to_owned(),
                    reason: if err.reason == "unauthenticated" {
                        "rejected"
                    } else {
                        "failed"
                    },
                    detail: err.detail_text(),
                }
                .to_wire()
            })?;
            write_tracker_token(secrets_dir, LINEAR_KIND, &token).map_err(|e| e.to_wire())?;
            Ok(connected_linear(probe))
        }
    }
}

pub fn bind_project(db: &Mutex<Connection>, payload: &Value) -> Result<Value, Value> {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ConnectionError {
                tracker: LINEAR_KIND.to_owned(),
                reason: "failed",
                detail: "projectId is required.".to_owned(),
            }
            .to_wire()
        })?;
    let binding = match payload.get("binding") {
        None | Some(Value::Null) => None,
        Some(Value::Object(obj)) => {
            let tracker = obj
                .get("tracker")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if tracker != LINEAR_KIND {
                return Err(ConnectionError {
                    tracker: tracker.to_owned(),
                    reason: "unknown-tracker",
                    detail: "This server has no such issue tracker.".to_owned(),
                }
                .to_wire());
            }
            let scope = obj
                .get("scope")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    ConnectionError {
                        tracker: tracker.to_owned(),
                        reason: "failed",
                        detail: "Issue tracker scope is required.".to_owned(),
                    }
                    .to_wire()
                })?;
            Some((tracker.to_owned(), scope.to_owned()))
        }
        Some(_) => {
            return Err(ConnectionError {
                tracker: LINEAR_KIND.to_owned(),
                reason: "failed",
                detail: "Invalid binding payload.".to_owned(),
            }
            .to_wire())
        }
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let guard = db.lock().map_err(|_| {
        ConnectionError {
            tracker: LINEAR_KIND.to_owned(),
            reason: "failed",
            detail: "The project binding could not be saved.".to_owned(),
        }
        .to_wire()
    })?;
    match binding {
        None => {
            guard
                .execute(
                    "DELETE FROM issue_tracker_bindings WHERE project_id = ?1",
                    [project_id],
                )
                .map_err(|_| {
                    ConnectionError {
                        tracker: LINEAR_KIND.to_owned(),
                        reason: "failed",
                        detail: "The project binding could not be saved.".to_owned(),
                    }
                    .to_wire()
                })?;
        }
        Some((tracker, scope)) => {
            guard
                .execute(
                    "INSERT INTO issue_tracker_bindings(project_id, tracker, scope, updated_at)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(project_id) DO UPDATE SET
                       tracker = excluded.tracker,
                       scope = excluded.scope,
                       updated_at = excluded.updated_at",
                    params![project_id, tracker, scope, now],
                )
                .map_err(|_| {
                    ConnectionError {
                        tracker: LINEAR_KIND.to_owned(),
                        reason: "failed",
                        detail: "The project binding could not be saved.".to_owned(),
                    }
                    .to_wire()
                })?;
        }
    }
    Ok(json!({}))
}
