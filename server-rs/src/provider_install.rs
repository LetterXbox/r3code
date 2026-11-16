//! Managed Codex installation RPC state and progress.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{oneshot, watch, Mutex};

pub fn handles(tag: &str) -> bool {
    matches!(
        tag,
        "provider.install.start"
            | "provider.install.cancel"
            | "provider.install.subscribe"
            | "provider.install.remove"
    )
}
pub fn valid(tag: &str, payload: &Value) -> bool {
    let id = |v: &Value| {
        v.as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 128)
    };
    payload.is_object()
        && id(&payload["instanceId"])
        && (tag != "provider.install.cancel" || id(&payload["operationId"]))
}
fn error(id: &str, op: &str, detail: &str) -> Value {
    json!({"_tag":"ProviderSetupError","instanceId":id,"operation":op,"detail":detail})
}

/// Antigravity has no managed download in this server (unlike Codex), but its
/// install subscription must still resolve to a definite state instead of the
/// generic "Managed installation is not available" error: that error left the
/// Runtime row's install stream permanently null, so the UI showed "Checking
/// the Antigravity runtime." forever. Probe the configured (or default `agy`)
/// binary directly with `--version` and report whatever that finds.
fn antigravity_binary(entry: &Value) -> String {
    entry["config"]["binaryPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("agy")
        .to_owned()
}

fn antigravity_version(binary: &str) -> Option<String> {
    let output = std::process::Command::new(binary).arg("--version").output().ok()?;
    let text = if output.status.success() && !output.stdout.is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    let text = String::from_utf8_lossy(&text).trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn antigravity_state(binary: &str) -> Value {
    let version = antigravity_version(binary);
    let found = version.is_some();
    json!({
        "driver": "antigravity",
        "operationId": null,
        "phase": "idle",
        "downloadedBytes": 0,
        "totalBytes": null,
        "version": null,
        "installedVersion": version,
        "executablePath": if found { json!(binary) } else { Value::Null },
        "source": if found { json!("path") } else { Value::Null },
        "canRemove": false,
        "message": if found { Value::Null } else { json!(format!("Could not run \"{binary} --version\". Install the agy CLI, make sure it is on PATH, or set a binary path.")) },
    })
}

fn require(payload: &Value, path: &Path, op: &str, managed_only: bool) -> Result<(), Value> {
    let id = payload["instanceId"].as_str().unwrap_or("");
    let settings = crate::provider::session_registry::read_provider_settings(Some(path))
        .unwrap_or(Value::Null);
    let entry = settings.get("providerInstances").and_then(|v| v.get(id));
    if !entry.is_some_and(|e| e["driver"] == "codex") {
        return Err(error(
            id,
            op,
            "Managed installation is not available for this provider instance.",
        ));
    }
    let config = &entry.unwrap()["config"];
    if config["setupMode"] != "managed" {
        return Err(error(
            id,
            op,
            "Choose managed setup to install Codex in T3 Code.",
        ));
    }
    if managed_only
        && config["binaryPath"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s != "codex")
    {
        return Err(error(id, op, "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code."));
    }
    Ok(())
}
struct Inner {
    state: watch::Sender<Value>,
    cancel: Option<oneshot::Sender<()>>,
}
pub struct Installer {
    root: PathBuf,
    #[cfg(test)]
    fixture: Option<Vec<u8>>,
    inner: Mutex<Inner>,
}
impl Installer {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let asset = crate::codex_release::pinned(std::env::consts::OS, std::env::consts::ARCH);
        let state = json!({"driver":"codex","operationId":null,"phase":"idle","downloadedBytes":0,"totalBytes":asset.map(|a|a.bytes),"version":asset.map(|a|a.version),"installedVersion":null,"executablePath":null,"source":null,"canRemove":false,"message":null});
        let (state, _) = watch::channel(state);
        Arc::new(Self {
            root,
            #[cfg(test)]
            fixture: None,
            inner: Mutex::new(Inner {
                state,
                cancel: None,
            }),
        })
    }
    pub async fn subscribe(
        &self,
        payload: &Value,
        settings: &Path,
    ) -> Result<watch::Receiver<Value>, Value> {
        let id = payload["instanceId"].as_str().unwrap_or("");
        let settings_value = crate::provider::session_registry::read_provider_settings(Some(settings))
            .unwrap_or(Value::Null);
        let entry = settings_value.get("providerInstances").and_then(|v| v.get(id));
        if entry.is_some_and(|e| e["driver"] == "antigravity") {
            let (state, _) = watch::channel(antigravity_state(&antigravity_binary(entry.unwrap())));
            return Ok(state.subscribe());
        }
        require(payload, settings, "observe-install", false)?;
        let inner = self.inner.lock().await;
        #[cfg(unix)]
        if inner.state.borrow()["phase"] == "idle" {
            if let Ok(lease) = crate::codex_release::acquire_installed(&self.root).await {
                inner.state.send_modify(|s| {
                    s["installedVersion"] = s["version"].clone();
                    s["executablePath"] = json!(lease.binary().to_string_lossy());
                    s["source"] = json!("managed");
                    s["canRemove"] = json!(true);
                });
            }
        }
        Ok(inner.state.subscribe())
    }
    pub async fn dispatch(
        self: &Arc<Self>,
        tag: &str,
        payload: &Value,
        settings: &Path,
    ) -> Result<Value, Value> {
        let id = payload["instanceId"].as_str().unwrap_or("");
        let op = match tag {
            "provider.install.start" => "install",
            "provider.install.cancel" => "cancel-install",
            _ => "remove-install",
        };
        if tag == "provider.install.start" {
            crate::managed_policy::check_provider_allowed("codex")
                .map_err(|detail| error(id, op, &detail))?;
        }
        require(payload, settings, op, tag != "provider.install.cancel")?;
        let mut inner = self.inner.lock().await;
        let current = inner.state.borrow().clone();
        if tag == "provider.install.cancel" {
            if current["operationId"] != payload["operationId"] {
                return Err(error(
                    id,
                    "cancel",
                    "This installation is no longer current. Refresh its status before cancelling.",
                ));
            }
            if let Some(cancel) = inner.cancel.take() {
                let _ = cancel.send(());
            }
            // The worker publishes cancellation after the installer has stopped.
            let mut sub = inner.state.subscribe();
            drop(inner);
            while matches!(
                sub.borrow()["phase"].as_str(),
                Some("downloading" | "extracting" | "verifying")
            ) {
                if sub.changed().await.is_err() {
                    break;
                }
            }
            return Ok(sub.borrow().clone());
        }
        if tag == "provider.install.remove" {
            if inner.cancel.is_some() {
                return Err(error(
                    id,
                    op,
                    "Stop the installation before removing Codex.",
                ));
            }
            let settings_value =
                crate::provider::session_registry::read_provider_settings(Some(settings))
                    .unwrap_or(Value::Null);
            let protected =
                settings_value["providerInstances"]
                    .as_object()
                    .is_some_and(|entries| {
                        entries.values().any(|entry| {
                            entry["config"]["binaryPath"]
                                .as_str()
                                .is_some_and(|path| !path.is_empty() && path != "codex")
                        })
                    });
            if protected {
                return Err(error(id, op, "A provider instance uses this executable. Clear its binary path before removing Codex."));
            }
            #[cfg(unix)]
            {
                // Verification reads and expands the pinned archive; keep this
                // filesystem work off the asynchronous request executor.
                let root = self.root.clone();
                tokio::task::spawn_blocking(move || crate::codex_release::remove_installed(&root))
                    .await
                    .map_err(|_| error(id, op, "Could not remove Codex. Stop Codex sessions and check directory access."))?
                    .map_err(|_| {
                    error(
                        id,
                        op,
                        "Could not remove Codex. Stop Codex sessions and check directory access.",
                    )
                })?;
                let mut state = current;
                state["phase"] = json!("idle");
                state["operationId"] = Value::Null;
                state["installedVersion"] = Value::Null;
                state["executablePath"] = Value::Null;
                state["source"] = Value::Null;
                state["canRemove"] = json!(false);
                state["message"] = Value::Null;
                inner.state.send_replace(state.clone());
                return Ok(state);
            }
            #[cfg(not(unix))]
            {
                return Err(error(
                    id,
                    op,
                    "Managed Codex installation is not supported on this platform.",
                ));
            }
        }
        if inner.cancel.is_some() {
            return Ok(current);
        }
        #[cfg(not(unix))]
        {
            return Err(error(
                id,
                op,
                "Managed Codex installation is not supported on this platform.",
            ));
        }
        #[cfg(unix)]
        {
            let asset = crate::codex_release::pinned(std::env::consts::OS, std::env::consts::ARCH)
                .ok_or_else(|| {
                    error(
                        id,
                        op,
                        "OpenAI does not publish a Codex runtime for this platform.",
                    )
                })?;
            if let Ok(lease) = crate::codex_release::acquire_installed(&self.root).await {
                let mut state = current;
                state["phase"] = json!("succeeded");
                state["installedVersion"] = json!(asset.version);
                state["executablePath"] = json!(lease.binary().to_string_lossy());
                state["source"] = json!("managed");
                state["canRemove"] = json!(true);
                state["message"] = json!("Codex installed.");
                inner.state.send_replace(state.clone());
                return Ok(state);
            }
            let operation = uuid::Uuid::new_v4().to_string();
            let (cancel, cancelled) = oneshot::channel();
            inner.cancel = Some(cancel);
            let mut next = current;
            next["operationId"] = json!(operation);
            next["phase"] = json!("downloading");
            next["downloadedBytes"] = json!(0);
            next["message"] = json!("Downloading Codex.");
            inner.state.send_replace(next.clone());
            let this = self.clone();
            let state = inner.state.clone();
            let root = self.root.clone();
            tokio::spawn(async move {
                let progress_state = state.clone();
                let work = async {
                    #[cfg(test)]
                    if let Some(script) = &this.fixture {
                        progress_state.send_modify(|v| {
                            v["phase"] = json!("extracting");
                            v["downloadedBytes"] = json!(3);
                        });
                        let installed = crate::codex_release::install_fixture(&root, script).await;
                        return Ok(root.join(installed.version).join("bin/codex"));
                    }
                    crate::codex_release::install_with_progress(
                        &root,
                        asset,
                        move |phase, bytes| {
                            progress_state.send_modify(|v| {
                                v["phase"] = json!(phase);
                                v["downloadedBytes"] = json!(bytes);
                            });
                        },
                    )
                    .await
                };
                let result = tokio::select! { biased; r = work => Some(r), _ = cancelled => None };
                let mut inner = this.inner.lock().await;
                inner.cancel = None;
                let mut state = inner.state.borrow().clone();
                match result {
                    Some(Ok(path)) => {
                        state["phase"] = json!("succeeded");
                        state["installedVersion"] = json!(asset.version);
                        state["executablePath"] = json!(path.to_string_lossy());
                        state["source"] = json!("managed");
                        state["canRemove"] = json!(true);
                        state["message"] = json!("Codex installed.");
                    }
                    Some(Err(_)) => {
                        state["phase"] = json!("failed");
                        state["message"] = json!("Could not install Codex. Check disk space, directory access, and your internet connection, then try again.");
                    }
                    None => {
                        state["phase"] = json!("cancelled");
                        state["message"] =
                            json!("Installation cancelled. The previous runtime is unchanged.");
                    }
                }
                inner.state.send_replace(state);
            });
            Ok(next)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn subscription_validation_and_operation_matching() {
        let dir = std::env::temp_dir().join(format!("install-rpc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, r#"{"providerInstances":{"managed":{"driver":"codex","config":{"setupMode":"managed"}},"local":{"driver":"codex","config":{"setupMode":"local"}}}}"#).unwrap();
        let installer = Installer::new(dir.join("tools/codex"));
        let input = json!({"instanceId":"managed"});
        let mut updates = installer.subscribe(&input, &settings).await.unwrap();
        assert_eq!(updates.borrow_and_update()["phase"], "idle");
        {
            let inner = installer.inner.lock().await;
            inner.state.send_modify(|s| {
                s["operationId"] = json!("operation");
                s["phase"] = json!("failed");
            });
        }
        updates.changed().await.unwrap();
        assert_eq!(updates.borrow_and_update()["operationId"], "operation");
        let wrong = installer
            .dispatch(
                "provider.install.cancel",
                &json!({"instanceId":"managed","operationId":"old"}),
                &settings,
            )
            .await
            .unwrap_err();
        assert_eq!(wrong["_tag"], "ProviderSetupError");
        assert_eq!(
            installer
                .dispatch(
                    "provider.install.cancel",
                    &json!({"instanceId":"managed","operationId":"operation"}),
                    &settings
                )
                .await
                .unwrap()["phase"],
            "failed"
        );
        assert!(installer
            .subscribe(&json!({"instanceId":"local"}), &settings)
            .await
            .is_err());
        assert!(!valid(
            "provider.install.cancel",
            &json!({"instanceId":"managed"})
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn start_installs_fixture_and_streams_completion_without_network() {
        let dir =
            std::env::temp_dir().join(format!("install-rpc-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, r#"{"providerInstances":{"managed":{"driver":"codex","config":{"setupMode":"managed"}}}}"#).unwrap();
        let root = dir.join("tools/codex");
        let mut installer = Installer::new(root.clone());
        Arc::get_mut(&mut installer).unwrap().fixture = Some(b"#!/bin/sh\nexit 0\n".to_vec());
        let input = json!({"instanceId":"managed"});
        let mut sub = installer.subscribe(&input, &settings).await.unwrap();
        sub.borrow_and_update();
        let started = installer
            .dispatch("provider.install.start", &input, &settings)
            .await
            .unwrap();
        assert_eq!(started["phase"], "downloading");
        loop {
            sub.changed().await.unwrap();
            if sub.borrow_and_update()["phase"] == "succeeded" {
                break;
            }
        }
        let state = sub.borrow().clone();
        assert_eq!(state["operationId"], started["operationId"]);
        assert_eq!(state["source"], "managed");
        assert!(Path::new(state["executablePath"].as_str().unwrap()).starts_with(&dir));
        assert!(root.join("active.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
