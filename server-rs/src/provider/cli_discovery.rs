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

fn resolve_fx_binary(entry: &Value, home: Option<&str>) -> Option<std::path::PathBuf> {
    let configured = entry["config"]["binaryPath"].as_str();
    resolve_binary(configured, "fx", home)
}

fn fx_env_probe(bin: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut out) = stdout {
            let mut tmp = [0u8; 4096];
            while let Ok(n) = out.read(&mut tmp) {
                if n == 0 || buf.len() >= 256 * 1024 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
        }
        buf
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&bytes).trim().to_owned());
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

fn fx_configured_backends(home: Option<&str>) -> Vec<String> {
    let profile = std::env::var("FX_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| home.map(|h| Path::new(h).join(".fx")));
    let Some(profile) = profile else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(profile.join("settings.json")) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(providers) = parsed["providers"].as_object() else {
        return Vec::new();
    };
    providers
        .keys()
        .filter(|id| {
            let mut chars = id.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                && !matches!(id.to_ascii_lowercase().as_str(), "gateway" | "codex" | "grok")
        })
        .cloned()
        .collect()
}

fn probe_fx(entry: &Value, home: Option<&str>, provider: &mut Value) {
    probe_generic_cli("fx", entry, home, provider);
    if provider["installed"] != true || provider["version"].is_null() {
        return;
    }
    let Some(bin) = resolve_fx_binary(entry, home) else {
        return;
    };
    let mut supported_modes = vec![json!("approval-required"), json!("auto")];
    let status_json = fx_env_probe(&bin, &["status", "--json"], &[])
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    if let Some(status) = status_json.as_ref() {
        if status["modes"]
            .as_array()
            .is_some_and(|modes| modes.iter().any(|m| m["id"] == "full-access"))
        {
            supported_modes.push(json!("full-access"));
        }
        if let Some(auth_str) = status["auth"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            if auth_str == "missing" {
                provider["auth"] = json!({"status": "unauthenticated"});
                provider["status"] = json!("warning");
                provider["message"] = json!("Run `fx login` to sign in.");
            } else {
                provider["auth"] = json!({"status": "authenticated", "label": auth_str});
            }
        }
    }
    provider["supportedRuntimeModes"] = Value::Array(supported_modes);
    let default_model = status_json
        .as_ref()
        .and_then(|s| s["model"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let default_label = match default_model {
        Some(m) => format!("Default ({m})"),
        None => "Default".to_owned(),
    };
    let effort_descriptor = json!({
        "id": "effort",
        "label": "Effort",
        "type": "select",
        "options": [
            {"id": "auto", "label": "Auto"},
            {"id": "low", "label": "Low"},
            {"id": "medium", "label": "Medium", "isDefault": true},
            {"id": "high", "label": "High"},
            {"id": "xhigh", "label": "Extra High"},
            {"id": "max", "label": "Max"}
        ]
    });
    let model_caps = json!({"optionDescriptors": [effort_descriptor]});
    let mut models = vec![json!({
        "slug": "default",
        "name": default_label,
        "isCustom": false,
        "isDefault": true,
        "capabilities": model_caps
    })];
    let mut backends: Vec<(String, String, Option<&str>)> = vec![
        ("gateway".into(), "Vercel AI Gateway".into(), Some("fx login")),
        ("codex".into(), "Codex subscription".into(), Some("fx login codex")),
        ("grok".into(), "Grok subscription".into(), Some("fx login grok")),
    ];
    for custom_id in fx_configured_backends(home) {
        backends.push((custom_id.clone(), custom_id, None));
    }
    let mut sub_providers = Vec::new();
    let mut any_signed_in = provider["auth"]["status"] == "authenticated";
    let mut first_signed_label: Option<String> = None;
    for (backend_id, backend_name, login) in &backends {
        let env = [("FX_PROVIDER", backend_id.as_str()), ("FX_MODEL", "default")];
        let b_status = fx_env_probe(&bin, &["status", "--json"], &env)
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let auth_val = b_status
            .as_ref()
            .and_then(|s| s["auth"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let signed_in = auth_val.map(|a| a != "missing");
        if signed_in == Some(true) {
            any_signed_in = true;
            if first_signed_label.is_none() {
                first_signed_label = Some(backend_name.clone());
            }
        }
        if signed_in == Some(false) {
            let hint = login
                .map(|cmd| format!("Signed out. Run `{cmd}` on this machine."))
                .unwrap_or_else(|| {
                    b_status
                        .as_ref()
                        .and_then(|s| s["auth_help"].as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("fx has no credential for this backend.")
                        .to_owned()
                });
            sub_providers.push(json!({"name": backend_name, "unavailableReason": hint}));
            continue;
        }
        sub_providers.push(json!({"name": backend_name}));
        if let Some(ids) = fx_env_probe(&bin, &["models", "--json"], &env)
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v["ids"].as_array().cloned())
        {
            for id in ids.into_iter().filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)) {
                let slug = format!("{backend_id}:{id}");
                if !models.iter().any(|m| m["slug"] == slug) {
                    models.push(json!({
                        "slug": slug,
                        "name": id,
                        "subProvider": backend_name,
                        "isCustom": false,
                        "capabilities": model_caps
                    }));
                }
            }
        }
    }
    if any_signed_in && provider["auth"]["status"] != "authenticated" {
        provider["auth"] = json!({"status": "authenticated", "label": first_signed_label.unwrap_or_else(|| "fx".into())});
        provider["status"] = json!("ready");
        if let Some(obj) = provider.as_object_mut() {
            obj.remove("message");
        }
    }
    provider["models"] = Value::Array(models);
    if !sub_providers.is_empty() {
        provider["subProviders"] = Value::Array(sub_providers);
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
        "fx" => probe_fx(entry, home.as_deref(), &mut provider),
        "muse" => probe_muse(entry, home.as_deref(), &mut provider),
        "cursor" => probe_cursor(settings_path, id, home.as_deref(), &mut provider),
        "opencode" => probe_opencode(entry, home.as_deref(), &mut provider),
        "acpRegistry" => probe_acp_registry(entry, home.as_deref(), settings_path, &mut provider),
        "grok" | "kiro" | "pi" => probe_generic_cli(&driver, entry, home.as_deref(), &mut provider),
        _ => unreachable!("checked against SUPPORTED above"),
    }
    if provider["installed"] == true {
        if let Some(advisory) = super::claude_capabilities::check_compatibility(
            &driver,
            provider["version"].as_str(),
            settings_path.and_then(Path::parent),
        ) {
            provider["compatibilityAdvisory"] = advisory;
        }
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
        assert_eq!(provider["compatibilityAdvisory"]["status"], "unknown");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn antigravity_below_1_5_reports_broken_compatibility_advisory() {
        let dir = std::env::temp_dir().join(format!("t3-cli-discovery-agy-old-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(&dir, "fake-agy", "#!/bin/sh\necho agy_acp_server_1.4.5\n");
        let entry = json!({"driver":"antigravity","config":{"binaryPath":bin}});
        let provider = discover(Path::new("/"), "antigravity", &entry, None, None);
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["compatibilityAdvisory"]["status"], "broken");
        assert_eq!(provider["compatibilityAdvisory"]["recommendedRange"], ">=1.5.12 <2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fx_probes_full_access_runtime_mode_and_prefixed_backend_models() {
        let dir = std::env::temp_dir().join(format!("t3-cli-discovery-fx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_bin(
            &dir,
            "fake-fx",
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fx 0.0.14"
elif [ "$1" = "status" ]; then
  if [ "$FX_PROVIDER" = "codex" ]; then
    echo '{"auth":"chatgpt"}'
  else
    echo '{"auth":"api-key","model":"gpt-5","modes":[{"id":"ask"},{"id":"auto"},{"id":"full-access"}]}'
  fi
elif [ "$1" = "models" ]; then
  if [ "$FX_PROVIDER" = "codex" ]; then
    echo '{"ids":["gpt-5-codex"]}'
  else
    echo '{"ids":["anthropic/claude"]}'
  fi
fi
"#,
        );
        let entry = json!({"driver":"fx","config":{"binaryPath":bin}});
        let provider = discover(Path::new("/"), "fx", &entry, None, None);
        assert_eq!(provider["installed"], true);
        assert_eq!(provider["supportedRuntimeModes"], json!(["approval-required", "auto", "full-access"]));
        let models = provider["models"].as_array().unwrap();
        assert!(models.iter().any(|m| m["slug"] == "default" && m["name"] == "Default (gpt-5)"));
        assert!(models.iter().any(|m| m["slug"] == "codex:gpt-5-codex"));
        assert!(models.iter().any(|m| m["slug"] == "gateway:anthropic/claude"));
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
