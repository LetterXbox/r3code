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

/// Antigravity and the other non-codex CLI drivers have no managed download
/// in this server, but their install subscription must still resolve to a
/// definite state instead of the generic "Managed installation is not
/// available" error: that error left the Runtime row's install stream
/// permanently null, so the UI showed "Checking the <provider> runtime."
/// forever. Resolve the configured (or driver-default) binary the same way
/// `provider::cli_discovery` does and probe it with `--version` under a hard
/// timeout, so a hung CLI can't wedge this subscription either.
fn non_codex_default_binary(driver: &str) -> Option<&'static str> {
    match driver {
        "antigravity" => Some("agy"),
        "grok" => Some("grok"),
        "fx" => Some("fx"),
        "opencode" => Some("opencode"),
        "kiro" => Some("kiro-cli"),
        "muse" => Some("muse"),
        "pi" => Some("pi"),
        _ => None,
    }
}

fn non_codex_binary(driver: &str, entry: &Value) -> Option<String> {
    let default = non_codex_default_binary(driver)?;
    Some(
        entry["config"]["binaryPath"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(default)
            .to_owned(),
    )
}

fn non_codex_binary_probe(configured: &str, default_hint: &str) -> Option<(PathBuf, String)> {
    let home = std::env::var("HOME").ok().filter(|h| !h.trim().is_empty());
    let resolved = crate::provider::path_resolve::resolve_binary(
        Some(configured),
        default_hint,
        home.as_deref(),
    )?;
    let (_, text) = crate::provider::path_resolve::cached_probe(&resolved, &["--version"])?;
    let version = crate::provider::path_resolve::first_line(&text);
    (!version.trim().is_empty()).then(|| (resolved, version))
}

fn non_codex_runtime_state(driver: &str, binary: &str) -> Value {
    let default = non_codex_default_binary(driver).unwrap_or(binary);
    let probed = non_codex_binary_probe(binary, default);
    let found = probed.is_some();
    json!({
        "driver": driver,
        "operationId": null,
        "phase": "idle",
        "downloadedBytes": 0,
        "totalBytes": null,
        "version": null,
        "installedVersion": probed.as_ref().map(|(_, v)| v.as_str()),
        "executablePath": probed.as_ref().map(|(p, _)| p.to_string_lossy().into_owned()),
        "source": if found { json!("local") } else { Value::Null },
        "canRemove": false,
        "message": if found { Value::Null } else { json!(format!("Could not run \"{binary} --version\". Install it, make sure it is on PATH, or set a binary path.")) },
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
        if let Some(driver) = entry.and_then(|e| e["driver"].as_str()) {
            if let Some(binary) = non_codex_binary(driver, entry.unwrap()) {
                let (state, _) = watch::channel(non_codex_runtime_state(driver, &binary));
                return Ok(state.subscribe());
            }
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
    async fn antigravity_subscribe_resolves_without_managed_install_error() {
        let dir = std::env::temp_dir().join(format!("install-rpc-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let script = dir.join("agy");
        #[cfg(unix)]
        {
            std::fs::write(&script, "#!/bin/sh\necho agy 9.9.9\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(
            &settings,
            format!(
                r#"{{"providerInstances":{{"antigravity":{{"driver":"antigravity","enabled":true,"config":{{"binaryPath":"{}"}}}},"antigravity_missing":{{"driver":"antigravity","enabled":true}}}}}}"#,
                script.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        let installer = Installer::new(dir.join("tools/codex"));
        // A configured binary that resolves: never errors, never stays "Checking" (null).
        let mut found = installer
            .subscribe(&json!({"instanceId":"antigravity"}), &settings)
            .await
            .unwrap();
        let state = found.borrow_and_update().clone();
        #[cfg(unix)]
        {
            assert_eq!(state["installedVersion"], "agy 9.9.9");
            assert_eq!(state["source"], "local");
            assert_eq!(state["executablePath"], script.to_string_lossy().as_ref());
        }
        assert_eq!(state["phase"], "idle");
        assert!(state["message"].is_null() || cfg!(not(unix)));
        // No configured binaryPath and no `agy` on PATH in this sandbox: still a
        // definite (non-error) state, just unresolved, instead of an error that
        // leaves the UI stuck on "Checking the Antigravity runtime." forever.
        let mut missing = installer
            .subscribe(&json!({"instanceId":"antigravity_missing"}), &settings)
            .await
            .unwrap();
        let state = missing.borrow_and_update().clone();
        assert_eq!(state["phase"], "idle");
        assert!(!state["message"].is_null() || state["installedVersion"].is_string());
        // Starting a managed install is still correctly rejected: there is no
        // managed Antigravity download in this server.
        assert_eq!(
            installer
                .dispatch(
                    "provider.install.start",
                    &json!({"instanceId":"antigravity"}),
                    &settings
                )
                .await
                .unwrap_err()["_tag"],
            "ProviderSetupError"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
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
