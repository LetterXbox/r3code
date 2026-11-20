//! Discovery/status probing for provider instances whose driver is not
//! `codex` or `claudeAgent`: grok, fx, opencode, antigravity, kiro, muse, pi,
//! cursor and acpRegistry. `discovery::discover_instance` used to report
//! every one of these as `availability:"unavailable"` ("Provider driver is
//! not supported.") even though their executors (acp_executor.rs,
//! cursor_executor.rs, opencode_executor.rs, muse_executor.rs,
//! fx_subagents.rs, grok_* ) can run real sessions. This module gives each
//! driver an honest, cheap, side-effect-free status instead: resolve its
//! binary the way its executor's `launch()` would, run `--version` under a
//! hard timeout, and read whatever auth signal that driver exposes without
//! starting a session.
use super::path_resolve::{cached_probe, first_line, resolve_binary};
use serde_json::{json, Value};
use std::path::Path;

const SUPPORTED: &[&str] = &[
    "grok", "fx", "opencode", "antigravity", "kiro", "muse", "pi", "cursor", "acpRegistry",
];

fn display_name(driver: &str) -> &'static str {
    match driver {
        "grok" => "Grok",
        "fx" => "fx",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        "kiro" => "Kiro",
        "muse" => "Muse Code",
        "pi" => "Pi",
        "cursor" => "Cursor",
        "acpRegistry" => "ACP Registry",
        _ => "Provider",
    }
}

/// Default binary name, matching `acp_executor.rs`'s `launch()` and the
/// other executors' own `unwrap_or(...)` defaults.
fn default_binary(driver: &str) -> &'static str {
    match driver {
        "grok" => "grok",
        "fx" => "fx",
        "opencode" => "opencode",
        "antigravity" => "agy",
        "kiro" => "kiro-cli",
        "muse" => "muse",
        "pi" => "pi",
        _ => "",
    }
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.trim().is_empty())
}

/// Apply a resolved-binary `--version` probe to `provider`: installed,
/// version and status on success; an honest message otherwise. Never blocks
/// more than the probe's own hard timeout.
fn apply_binary_probe(provider: &mut Value, resolved: Option<std::path::PathBuf>, raw_binary: &str) {
    let Some(bin) = resolved else {
        provider["message"] = json!(format!(
            "Could not find `{raw_binary}` on PATH. Install it, or set a binary path in Settings → Providers."
        ));
        return;
    };
    match cached_probe(&bin, &["--version"]) {
        Some((_, text)) if !text.is_empty() => {
            provider["installed"] = json!(true);
            provider["version"] = json!(first_line(&text));
            provider["status"] = json!("ready");
        }
        Some(_) => {
            provider["installed"] = json!(true);
            provider["status"] = json!("warning");
            provider["message"] =
                json!(format!("`{}` ran but did not report a version.", bin.display()));
        }
        None => {
            provider["message"] =
                json!(format!("Timed out running `{} --version`.", bin.display()));
        }
    }
}

/// `~/.config/muse/auth.json` existing (and non-empty) is Muse's own
/// side-effect-free sign-in signal.
fn muse_auth(home: Option<&str>) -> Value {
    let Some(home) = home else {
        return json!({ "status": "unknown" });
    };
    match std::fs::metadata(Path::new(home).join(".config/muse/auth.json")) {
        Ok(meta) if meta.len() > 0 => json!({ "status": "authenticated" }),
        Ok(_) | Err(_) => json!({ "status": "unauthenticated" }),
    }
}

/// The R3-managed Cursor SDK credential cache (`cursor_credentials.rs`),
/// separate from `cursor-agent`'s own CLI login.
fn cursor_auth(settings_path: Option<&Path>, id: &str) -> Value {
    let Some(path) = settings_path else {
        return json!({ "status": "unknown" });
    };
    match super::cursor_credentials::read(path, id) {
        Ok(Some(value)) => {
            let mut auth = json!({ "status": "authenticated" });
            if let Some(email) = value.get("email").and_then(Value::as_str) {
                auth["email"] = json!(email);
            }
            auth
        }
        Ok(None) => json!({ "status": "unauthenticated" }),
        Err(_) => json!({ "status": "unknown" }),
    }
}

fn probe_generic_cli(driver: &str, entry: &Value, home: Option<&str>, provider: &mut Value) {
    let configured = entry["config"]["binaryPath"].as_str();
    let default = default_binary(driver);
    let raw = configured
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default);
    let resolved = resolve_binary(configured, default, home);
    apply_binary_probe(provider, resolved, raw);
}

fn probe_antigravity(
    id: &str,
    entry: &Value,
    home: Option<&str>,
    settings_path: Option<&Path>,
    provider: &mut Value,
) {
    provider["setup"] = json!({"canAuthenticate": true, "canInstall": false});
    probe_generic_cli("antigravity", entry, home, provider);
    if let Some(auth_method) = entry["config"]["authMethod"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        provider["auth"]["type"] = json!(auth_method);
    }
    if provider["installed"] != true {
        return;
    }
    let saved = settings_path
        .and_then(|path| super::antigravity_auth::profile_dir(path, id))
        .and_then(|profile| super::antigravity_auth::saved_auth_method(&profile));
    if let Some(method) = saved {
        provider["status"] = json!("ready");
        provider["auth"]["status"] = json!("authenticated");
        provider["auth"]["type"] = json!(method);
        provider["auth"]["canLogout"] = json!(true);
        return;
    }
    // Antigravity validates Google/Vertex credentials at session start when not
    // yet recorded by `provider.auth.*`; "warning" + auth "unknown" is the UI's
    // existing special case (statusKey's antigravitySignInUnchecked) that
    // renders "Installed · Sign-in not checked" instead of an error.
    provider["status"] = json!("warning");
}

fn probe_muse(entry: &Value, home: Option<&str>, provider: &mut Value) {
    probe_generic_cli("muse", entry, home, provider);
    if provider["installed"] == true {
        provider["auth"] = muse_auth(home);
    }
}

fn probe_cursor(settings_path: Option<&Path>, id: &str, home: Option<&str>, provider: &mut Value) {
    // Cursor runs through a bundled Node SDK (cursor_bridge.cjs), not a
    // `cursor-agent` CLI; `cursor_executor.rs` resolves the Node binary the
    // same way, honoring T3CODE_CURSOR_NODE.
    let node_override = std::env::var("T3CODE_CURSOR_NODE")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let raw = node_override.as_deref().unwrap_or("node");
    let resolved = super::path_resolve::resolve_binary(node_override.as_deref(), "node", home);
    apply_binary_probe(provider, resolved, raw);
    // Node's own version string is not Cursor's; don't present it as one.
    provider["version"] = Value::Null;
    if provider["installed"] == true {
        provider["auth"] = cursor_auth(settings_path, id);
    }
}

fn probe_opencode(entry: &Value, home: Option<&str>, provider: &mut Value) {
    let server_url = entry["config"]["serverUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(url) = server_url {
        let url = url.to_owned();
        let probe_url = url.clone();
        let password = super::opencode_executor::effective_password(entry).ok().flatten();
        let probed = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()?;
            runtime.block_on(async move {
                tokio::time::timeout(std::time::Duration::from_secs(5), async move {
                    let http = super::opencode_http::OpenCodeHttp::new(&probe_url, password).ok()?;
                    http.probe().await.ok()
                })
                .await
                .ok()
                .flatten()
            })
        })
        .join()
        .ok()
        .flatten();
        match probed {
            Some(_) => {
                provider["installed"] = json!(true);
                provider["status"] = json!("ready");
            }
            None => {
                provider["message"] = json!(format!(
                    "Could not reach the configured OpenCode server at {url}."
                ));
            }
        }
        return;
    }
    probe_generic_cli("opencode", entry, home, provider);
}

fn probe_acp_registry(
    entry: &Value,
    home: Option<&str>,
    settings_path: Option<&Path>,
    provider: &mut Value,
) {
    let config = &entry["config"];
    let local = config["source"] == "local"
        || config["commandPath"].as_str().is_some_and(|s| !s.is_empty());
    if !local {
        // A registry-sourced instance has no command of its own; its config
        // only ever stores {agentId, distribution:"auto"}. server.prepareAcpRegistryAgent
        // resolves it and writes a launch receipt (see acp_registry.rs) that
        // this reads back to report whether it is actually ready to launch.
        let receipt = config["agentId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .and_then(|agent_id| {
                let base_dir = settings_path.and_then(Path::parent).and_then(Path::parent)?;
                super::acp_registry::installed_launch(&base_dir.join("tools/acp-registry"), agent_id)
            });
        match receipt {
            Some(receipt) => {
                provider["status"] = json!("ready");
                provider["installed"] = json!(true);
                provider["version"] = json!(receipt.version);
            }
            None => {
                provider["status"] = json!("warning");
                provider["message"] = json!(
                    "This ACP Registry agent has not been prepared yet. Add it again from the ACP Registry search."
                );
            }
        }
        return;
    }
    let configured = config["commandPath"].as_str();
    let Some(raw) = configured.filter(|s| !s.trim().is_empty()) else {
        provider["message"] = json!("No executable is configured for this ACP command.");
        return;
    };
    // No sane default: an ACP Registry local command must name its own executable.
    let resolved = resolve_binary(Some(raw), "", home);
    apply_binary_probe(provider, resolved, raw);
}

/// Probe one non-codex/claudeAgent instance. Mirrors
/// `discovery::discover_instance`'s codex skeleton (same field shape) but
/// never starts a full session.
pub(crate) fn discover(
    _cwd: &Path,
    id: &str,
    entry: &Value,
    settings_path: Option<&Path>,
    _secrets: Option<&super::secret_store::SecretStore>,
) -> Value {
    let driver = entry["driver"].as_str().unwrap_or("").to_owned();
    let checked = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut provider = json!({
        "instanceId": id,
        "driver": driver,
        "displayName": display_name(&driver),
        "enabled": true,
        "installed": false,
        "version": null,
        "status": "error",
        "auth": {"status": "unknown"},
        "checkedAt": checked,
        "models": [],
    });
    if let Some(name) = entry["displayName"].as_str().filter(|s| !s.trim().is_empty()) {
        provider["displayName"] = json!(name.trim());
    }
    if let Some(color) = entry.get("accentColor") {
        provider["accentColor"] = color.clone();
    }

    if entry["enabled"] == false || entry["config"]["enabled"] == false {
        provider["enabled"] = json!(false);
        provider["status"] = json!("disabled");
        return provider;
    }

    if !SUPPORTED.contains(&driver.as_str()) {
        provider["enabled"] = json!(false);
        provider["availability"] = json!("unavailable");
        provider["unavailableReason"] = json!("Provider driver is not supported.");
        provider["message"] = provider["unavailableReason"].clone();
        return provider;
    }

    if let Err(error) = crate::managed_policy::check_provider_allowed(&driver) {
        provider["availability"] = json!("unavailable");
        provider["unavailableReason"] = json!(error);
        provider["message"] = provider["unavailableReason"].clone();
        return provider;
    }

    let home = home_dir();
    match driver.as_str() {
        "antigravity" => probe_antigravity(id, entry, home.as_deref(), settings_path, &mut provider),
        "muse" => probe_muse(entry, home.as_deref(), &mut provider),
        "cursor" => probe_cursor(settings_path, id, home.as_deref(), &mut provider),
        "opencode" => probe_opencode(entry, home.as_deref(), &mut provider),
        "acpRegistry" => probe_acp_registry(entry, home.as_deref(), settings_path, &mut provider),
        "grok" | "fx" | "kiro" | "pi" => probe_generic_cli(&driver, entry, home.as_deref(), &mut provider),
        _ => unreachable!("checked against SUPPORTED above"),
    }
    provider
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fake_bin(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn reports_ready_with_version_when_the_binary_resolves() {
        let dir = std::env::temp_dir().join(format!("t3-cli-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(&dir, "fake-grok", "#!/bin/sh\necho grok-cli 1.4.0\n");
        let entry = json!({"driver":"grok","config":{"binaryPath":bin}});
        let provider = discover(Path::new("/"), "grok", &entry, None, None);
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["status"], "ready");
        assert_eq!(provider["version"], "grok-cli 1.4.0");
        assert_eq!(provider["driver"], "grok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hanging_binary_never_blocks_discovery_and_reports_an_honest_message() {
        let dir = std::env::temp_dir().join(format!("t3-cli-discovery-hang-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(&dir, "fake-fx", "#!/bin/sh\nsleep 30\n");
        let entry = json!({"driver":"fx","config":{"binaryPath":bin}});
        let start = std::time::Instant::now();
        let provider = discover(Path::new("/"), "fx", &entry, None, None);
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(provider["installed"], false);
        assert!(provider["message"].as_str().unwrap().contains("Timed out"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_binary_reports_not_installed_with_a_hint() {
        let entry = json!({"driver":"kiro","config":{"binaryPath":"/definitely/not/a/real/t3-kiro-cli"}});
        let provider = discover(Path::new("/"), "kiro", &entry, None, None);
        assert_eq!(provider["installed"], false);
        assert_eq!(provider["status"], "error");
        assert!(provider["message"].as_str().unwrap().contains("Could not find"));
    }

    #[test]
    fn disabled_entry_reports_disabled_and_keeps_the_real_driver() {
        let entry = json!({"driver":"opencode","enabled":false});
        let provider = discover(Path::new("/"), "opencode", &entry, None, None);
        assert_eq!(provider["status"], "disabled");
        assert_eq!(provider["driver"], "opencode");
        assert_eq!(provider["enabled"], false);
    }

    #[test]
    fn unknown_driver_is_unavailable_and_unsupported() {
        let entry = json!({"driver":"somethingElse"});
        let provider = discover(Path::new("/"), "other", &entry, None, None);
        assert_eq!(provider["availability"], "unavailable");
        assert_eq!(provider["unavailableReason"], "Provider driver is not supported.");
    }

    #[test]
    fn antigravity_installed_reports_warning_with_unknown_auth_for_the_uis_sign_in_unchecked_case() {
        let dir = std::env::temp_dir().join(format!("t3-cli-discovery-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(&dir, "fake-agy", "#!/bin/sh\necho agy_acp_server_20261001_1\n");
        let entry = json!({"driver":"antigravity","config":{"binaryPath":bin}});
        let provider = discover(Path::new("/"), "antigravity", &entry, None, None);
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["status"], "warning");
        assert_eq!(provider["auth"]["status"], "unknown");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn muse_auth_file_presence_drives_authenticated_status() {
        let home = std::env::temp_dir().join(format!("t3-cli-discovery-muse-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".config/muse")).unwrap();
        std::fs::write(home.join(".config/muse/auth.json"), r#"{"token":"x"}"#).unwrap();
        let bin_dir = home.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = fake_bin(&bin_dir, "fake-muse", "#!/bin/sh\necho muse 0.9.0\n");
        let entry = json!({"driver":"muse","config":{"binaryPath":bin}});
        let provider = discover(Path::new("/"), "muse", &entry, None, None);
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["auth"]["status"], "authenticated");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn acp_registry_without_a_local_command_reports_a_warning_instead_of_guessing() {
        let entry = json!({"driver":"acpRegistry","config":{"source":"registry","agentId":"devin"}});
        let provider = discover(Path::new("/"), "acpRegistry", &entry, None, None);
        assert_eq!(provider["status"], "warning");
        assert_eq!(provider["installed"], false);
    }

    #[test]
    fn acp_registry_reports_ready_once_prepare_wrote_a_launch_receipt() {
        let base_dir = std::env::temp_dir().join(format!(
            "t3code-cli-discovery-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let settings_path = base_dir.join("userdata/settings.json");
        let receipt = super::super::acp_registry::LaunchReceipt {
            command: "npx".into(),
            args: vec!["-y".into(), "devin@1.0.0".into()],
            env: Default::default(),
            version: "1.0.0".into(),
            distribution: "npx".into(),
        };
        let tools_dir = base_dir.join("tools/acp-registry/devin");
        std::fs::create_dir_all(&tools_dir).unwrap();
        std::fs::write(
            tools_dir.join("launch.json"),
            serde_json::to_string(&receipt).unwrap(),
        )
        .unwrap();
        let entry = json!({"driver":"acpRegistry","config":{"source":"registry","agentId":"devin"}});
        let provider = discover(Path::new("/"), "acpRegistry", &entry, Some(&settings_path), None);
        assert_eq!(provider["status"], "ready");
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["version"], "1.0.0");
        std::fs::remove_dir_all(&base_dir).unwrap();
    }
}
