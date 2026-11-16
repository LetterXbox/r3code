//! Machine-wide managed policy. Unknown or unsupported restrictions fail closed.
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[cfg(windows)]
#[path = "windows_policy_cleanup.rs"]
mod windows_policy_cleanup;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Limits {
    #[serde(rename = "webhookTasks")]
    webhook_tasks: Option<bool>,
    // This server implements neither product analytics nor browser-cookie
    // import, so both capabilities are already unavailable in all modes.
    telemetry: Option<bool>,
    #[serde(rename = "browserCookieImport")]
    browser_cookie_import: Option<bool>,
    connect: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    organization: String,
    #[serde(rename = "supportUrl")]
    support_url: Option<String>,
    limits: Option<Limits>,
}

pub fn system_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/T3Code/policy.json")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\T3Code\policy.json")
    } else {
        PathBuf::from("/etc/t3code/policy.json")
    }
}

/// Refuse platform policy sources this build cannot yet decode or enforce.
pub(crate) fn check_platform_policy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = Path::new("/Library/Managed Preferences/com.t3tools.t3code.plist");
        match std::fs::metadata(path) {
            Ok(_) => return Err("Cannot enforce the macOS managed preferences policy".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot read macOS managed preferences policy".into()),
        }
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn RegOpenKeyExW(
                key: *mut c_void,
                subkey: *const u16,
                options: u32,
                access: u32,
                result: *mut *mut c_void,
            ) -> i32;
            fn RegCloseKey(key: *mut c_void) -> i32;
        }
        let key: Vec<u16> = "SOFTWARE\\Policies\\T3Tools\\T3Code\0"
            .encode_utf16()
            .collect();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                0x80000002u32 as i32 as isize as *mut c_void,
                key.as_ptr(),
                0,
                0x20019 | 0x100,
                &mut result,
            )
        };
        match status {
            2 => {}
            0 => {
                unsafe {
                    RegCloseKey(result);
                }
                return Err("Cannot enforce the Windows managed registry policy".into());
            }
            _ => {
                return Err(format!(
                    "Cannot read the Windows managed registry policy ({status})"
                ))
            }
        }
    }
    Ok(())
}

/// Runtime ceiling for paths that start or change provider work. Installed
/// policies with unsupported restrictions are still rejected at server startup.
static STARTUP_POLICY: OnceLock<Result<Option<serde_json::Value>, String>> = OnceLock::new();

pub(crate) fn initialize_runtime() -> Result<(), String> {
    STARTUP_POLICY
        .get_or_init(read_runtime_document)
        .clone()
        .map(|_| ())
}

fn runtime_document() -> Result<Option<serde_json::Value>, String> {
    STARTUP_POLICY
        .get()
        .cloned()
        .unwrap_or_else(read_runtime_document)
}

fn read_runtime_document() -> Result<Option<serde_json::Value>, String> {
    let installed = system_path();
    let (bytes, is_installed) = match std::fs::read(installed) {
        Ok(bytes) => (bytes, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let Some(path) = std::env::var_os("T3CODE_DEV_MANAGED_POLICY_PATH") else {
                return Ok(None);
            };
            match std::fs::read(path) {
                Ok(bytes) => (bytes, false),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("Unable to read managed policy".into()),
            }
        }
        Err(_) => return Err("Unable to read managed policy".into()),
    };
    if is_installed {
        validate_installed_document(&bytes)?;
    }
    let policy: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid managed policy")?;
    validate_runtime_document(&policy)?;
    Ok(Some(policy))
}
fn validate_runtime_document(policy: &serde_json::Value) -> Result<(), String> {
    let root = policy.as_object().ok_or("Invalid managed policy")?;
    if root.keys().any(|key| {
        ![
            "schemaVersion",
            "organization",
            "supportUrl",
            "settings",
            "limits",
        ]
        .contains(&key.as_str())
    }) {
        return Err("Unknown managed policy field".into());
    }
    if policy["schemaVersion"] != 1
        || policy["organization"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
    {
        return Err("Invalid managed policy".into());
    }
    if root
        .get("supportUrl")
        .is_some_and(|value| value.as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err("Invalid managed policy supportUrl".into());
    }
    if let Some(settings) = root.get("settings") {
        for (path, rule) in settings.as_object().ok_or("Invalid managed settings")? {
            let rule = rule.as_object().ok_or("Invalid managed setting")?;
            if path.split('.').any(str::is_empty)
                || !rule.contains_key("value")
                || !rule
                    .get("locked")
                    .is_some_and(serde_json::Value::is_boolean)
                || rule.keys().any(|key| key != "value" && key != "locked")
            {
                return Err("Invalid managed setting".into());
            }
        }
        validate_setting_rules(settings)?;
    }
    if let Some(limits) = root.get("limits") {
        let limits = limits.as_object().ok_or("Invalid managed limits")?;
        for (key, value) in limits {
            match key.as_str() {
                "maxRuntimeMode"
                    if value.as_str().is_some_and(|mode| mode_rank(mode).is_some()) => {}
                "connect" | "webhookTasks" | "telemetry" | "browserCookieImport"
                    if value.is_boolean() => {}
                "clients"
                    if value.as_array().is_some_and(|items| {
                        !items.is_empty()
                            && items.iter().all(|item| {
                                matches!(
                                    item.as_str(),
                                    Some("desktop" | "local-browser" | "remote")
                                )
                            })
                    }) => {}
                "providers" => validate_provider_limits(value)?,
                "updates" => validate_update_limits(value)?,
                _ => return Err("Invalid managed policy limit".into()),
            }
        }
    }
    Ok(())
}
fn validate_setting_rules(rules: &serde_json::Value) -> Result<(), String> {
    let rules = rules.as_object().ok_or("Invalid managed settings")?;
    let mut effective = crate::settings::defaults();
    for (path, rule) in rules {
        let parts: Vec<_> = path.split('.').collect();
        let head = parts[0];
        if [
            "projectSettingsOverrides",
            "projectAgentBrowserAccessOverrides",
            "projectAutoPullOverrides",
            "projectScriptOverrides",
            "observability",
            "compactIdleThreads",
        ]
        .contains(&head)
        {
            return Err(format!("Managed setting {path} cannot be enforced"));
        }
        if parts.len() > 2 && head == "providerInstances" && rule["locked"] == true {
            return Err("Managed provider instance fields must be locked as a whole".into());
        }
        if path == "defaultRuntimeMode"
            && rule["value"]
                .as_str()
                .is_none_or(|value| mode_rank(value).is_none())
        {
            return Err("Invalid managed runtime mode".into());
        }
        if setting_value(&effective, &parts).is_none() {
            if parts.len() == 1
                && ["idleCompaction", "defaultThreadEnvMode", "usageModelFilter"].contains(&head)
            {
                effective
                    .as_object_mut()
                    .ok_or("Invalid settings")?
                    .insert(head.to_owned(), rule["value"].clone());
                continue;
            }
            return Err(format!("Unknown managed setting {path}"));
        }
        if parts.len() > 1
            && (1..parts.len()).any(|i| {
                setting_value(&effective, &parts[..i]).is_some_and(serde_json::Value::is_null)
            })
        {
            return Err(format!(
                "Managed setting {path} is inside a nullable setting"
            ));
        }
        set_overlay(&mut effective, &parts, rule["value"].clone())?;
    }
    crate::settings::validate_settings(&effective)
        .map_err(|_| "Invalid managed setting value".to_owned())?;
    Ok(())
}
fn known_driver(driver: &str) -> bool {
    matches!(
        driver,
        "codex"
            | "claudeAgent"
            | "opencode"
            | "antigravity"
            | "acpRegistry"
            | "grok"
            | "kiro"
            | "fx"
            | "pi"
            | "cursor"
            | "muse"
    )
}
fn validate_provider_limits(value: &serde_json::Value) -> Result<(), String> {
    let limits = value.as_object().ok_or("Invalid managed provider limits")?;
    for (key, value) in limits {
        match key.as_str() {
            "allowedDrivers"
                if value.as_array().is_some_and(|items| {
                    !items.is_empty()
                        && items
                            .iter()
                            .all(|item| item.as_str().is_some_and(known_driver))
                }) => {}
            "instances" => {
                for (driver, pin) in value.as_object().ok_or("Invalid managed provider pins")? {
                    if !known_driver(driver) {
                        return Err("Unknown managed provider driver".into());
                    }
                    let pin = pin.as_object().ok_or("Invalid managed provider pin")?;
                    if !pin.get("locked").is_some_and(serde_json::Value::is_boolean) {
                        return Err("Invalid managed provider pin".into());
                    }
                    if (pin.contains_key("binaryPath") && driver == "acpRegistry")
                        || (pin.contains_key("launchArgs")
                            && !["codex", "claudeAgent", "pi"].contains(&driver.as_str()))
                    {
                        return Err("Managed provider pin names an unsupported launch field".into());
                    }
                    for (field, value) in pin {
                        match field.as_str() {
                            "locked" if value.is_boolean() => {}
                            "binaryPath" | "launchArgs"
                                if value.as_str().is_some_and(|v| !v.trim().is_empty()) => {}
                            "environment"
                                if value.as_array().is_some_and(|items| {
                                    items.iter().all(|item| {
                                        item.as_object().is_some_and(|o| {
                                            o.len() == 2
                                                && o.get("name")
                                                    .and_then(serde_json::Value::as_str)
                                                    .is_some_and(|s| {
                                                        s.len() <= 128
                                                            && s.bytes().next().is_some_and(|c| {
                                                                c == b'_' || c.is_ascii_alphabetic()
                                                            })
                                                            && s.bytes().all(|c| {
                                                                c == b'_'
                                                                    || c.is_ascii_alphanumeric()
                                                            })
                                                    })
                                                && o.get("value")
                                                    .is_some_and(serde_json::Value::is_string)
                                        })
                                    })
                                }) => {}
                            _ => return Err("Invalid managed provider pin".into()),
                        }
                    }
                    let mut names = std::collections::HashSet::new();
                    for value in pin
                        .get("environment")
                        .and_then(serde_json::Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let name = value["name"]
                            .as_str()
                            .ok_or("Invalid managed provider environment")?;
                        let key = if cfg!(windows) {
                            name.to_ascii_uppercase()
                        } else {
                            name.to_owned()
                        };
                        if !names.insert(key) {
                            return Err("Managed provider environment repeats a variable".into());
                        }
                    }
                }
            }
            _ => return Err("Invalid managed provider limits".into()),
        }
    }
    Ok(())
}
fn validate_update_limits(value: &serde_json::Value) -> Result<(), String> {
    let limits = value.as_object().ok_or("Invalid managed update policy")?;
    if !matches!(
        limits.get("mode").and_then(serde_json::Value::as_str),
        Some("auto" | "off")
    ) {
        return Err("Invalid managed update policy".into());
    }
    for (key, value) in limits {
        match key.as_str() {
            "mode" => {}
            "allowNightly" if value.is_boolean() => {}
            "feedUrl"
                if value.as_str().is_some_and(|s| {
                    url::Url::parse(s)
                        .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
                }) => {}
            _ => return Err("Invalid managed update policy".into()),
        }
    }
    Ok(())
}
pub(crate) fn has_policy() -> Result<bool, String> {
    Ok(runtime_document()?.is_some())
}
pub(crate) fn webhook_denial() -> Result<Option<String>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    Ok(
        (policy.pointer("/limits/webhookTasks") == Some(&serde_json::Value::Bool(false))).then(
            || {
                format!(
                    "{}'s policy does not allow webhook tasks.",
                    policy["organization"]
                        .as_str()
                        .unwrap_or("Your organization")
                )
            },
        ),
    )
}
pub(crate) fn check_client_mode(mode: &str) -> Result<(), String> {
    let Some(policy) = runtime_document()? else {
        return Ok(());
    };
    let Some(clients) = policy.pointer("/limits/clients") else {
        return Ok(());
    };
    let clients = clients
        .as_array()
        .filter(|clients| !clients.is_empty())
        .ok_or("Invalid managed policy clients")?;
    if clients.iter().any(|client| client.as_str() == Some(mode)) {
        return Ok(());
    }
    let action = match mode {
        "desktop" => "the desktop app",
        "local-browser" => "browsers on this machine",
        _ => "remote clients",
    };
    Err(format!(
        "{}'s policy does not allow {action}.",
        policy["organization"]
            .as_str()
            .unwrap_or("Your organization")
    ))
}
pub(crate) fn allows_connect() -> Result<bool, String> {
    let policy = runtime_document()?;
    Ok(allows_connect_document(policy.as_ref()))
}
pub(crate) fn connect_denial() -> Result<Option<String>, String> {
    let policy = runtime_document()?;
    Ok((!allows_connect_document(policy.as_ref())).then(|| {
        format!(
            "{}'s policy does not allow T3 Connect.",
            policy
                .as_ref()
                .and_then(|value| value["organization"].as_str())
                .unwrap_or("Your organization")
        )
    }))
}
/// Clear only the CloudLink-owned state when managed policy disables Connect.
pub(crate) fn unlink_cloud_state(secrets: &Path) -> std::io::Result<()> {
    const FILES: &[&str] = &[
        "cloud-linked-user-id.bin",
        "cloud-relay-url.bin",
        "cloud-relay-issuer.bin",
        "cloud-relay-environment-credential.bin",
        "cloud-mint-ed25519-public-key.bin",
        "cloud-endpoint-runtime-config.bin",
        "cloud-endpoint-confirmed-origin.bin",
        "cloud-publish-agent-activity.bin",
        "cloud-hold-webhooks-while-offline.bin",
        "cloud-link-revoked.bin",
        "cloud-cli-desired-link.bin",
    ];
    #[cfg(unix)]
    {
        use std::os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        };
        let Some(parent) = secrets.parent() else {
            return Err(std::io::Error::other("Invalid cloud state directory"));
        };
        let Some(leaf) = secrets.file_name() else {
            return Err(std::io::Error::other("Invalid cloud state directory"));
        };
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        let canonical_parent = match std::fs::canonicalize(parent) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let parent_c = std::ffi::CString::new(canonical_parent.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::other("Invalid cloud state directory"))?;
        let parent_fd = unsafe {
            libc::open(
                parent_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if parent_fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(());
            }
            return Err(error);
        }
        let parent_dir = unsafe { OwnedFd::from_raw_fd(parent_fd) };
        let leaf_c = std::ffi::CString::new(leaf.as_bytes())
            .map_err(|_| std::io::Error::other("Invalid cloud state directory"))?;
        let raw = unsafe {
            libc::openat(
                parent_dir.as_raw_fd(),
                leaf_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(());
            }
            return Err(error);
        }
        let dir = unsafe { OwnedFd::from_raw_fd(raw) };
        for name in FILES {
            let name = std::ffi::CString::new(*name)
                .map_err(|_| std::io::Error::other("Invalid cloud state name"))?;
            if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        windows_policy_cleanup::unlink_cloud_state(secrets, FILES)
    }
    #[cfg(not(any(unix, windows)))]
    {
        for name in FILES {
            match std::fs::symlink_metadata(secrets.join(name)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
                Ok(_) => {
                    return Err(std::io::Error::other(
                        "Cloud state cleanup is unavailable on this platform",
                    ))
                }
            }
        }
        Ok(())
    }
}
fn allows_connect_document(policy: Option<&serde_json::Value>) -> bool {
    policy.is_none_or(|policy| {
        policy.pointer("/limits/connect") != Some(&serde_json::Value::Bool(false))
            && policy.pointer("/limits/clients").is_none_or(|clients| {
                clients
                    .as_array()
                    .is_some_and(|clients| clients.iter().any(|client| client == "remote"))
            })
    })
}
pub(crate) fn client_summary() -> Result<Option<serde_json::Value>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    let mut summary =
        serde_json::json!({"organization":policy["organization"],"lockedSettings":[]});
    if let Some(value) = policy.get("supportUrl") {
        summary["supportUrl"] = value.clone();
    }
    if let Some(rules) = policy["settings"].as_object() {
        summary["lockedSettings"] = serde_json::json!(rules
            .iter()
            .filter_map(|(path, rule)| (rule["locked"] == true).then_some(path))
            .collect::<Vec<_>>());
    }
    if let Some(limits) = policy.get("limits").and_then(serde_json::Value::as_object) {
        let mut visible = serde_json::Map::new();
        for key in [
            "maxRuntimeMode",
            "clients",
            "webhookTasks",
            "telemetry",
            "browserCookieImport",
        ] {
            if let Some(value) = limits.get(key) {
                visible.insert(key.into(), value.clone());
            }
        }
        if limits.get("connect") == Some(&serde_json::Value::Bool(false))
            || limits
                .get("clients")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|clients| !clients.iter().any(|value| value == "remote"))
        {
            visible.insert("connect".into(), serde_json::json!(false));
        }
        let ceiling = limits.get("maxRuntimeMode").is_some();
        let empty = serde_json::Map::new();
        if ceiling || limits.get("providers").is_some() {
            let providers = limits
                .get("providers")
                .and_then(serde_json::Value::as_object)
                .unwrap_or(&empty);
            let mut result = serde_json::Map::new();
            if let Some(allowed) = providers.get("allowedDrivers") {
                result.insert("allowedDrivers".into(), allowed.clone());
            }
            let mut locks = serde_json::Map::new();
            if ceiling {
                for (driver, fields) in [
                    (
                        "codex",
                        vec![
                            "config.binaryPath",
                            "config.launchArgs",
                            "config.homePath",
                            "config.shadowHomePath",
                        ],
                    ),
                    (
                        "claudeAgent",
                        vec!["config.binaryPath", "config.launchArgs", "config.homePath"],
                    ),
                    ("antigravity", vec!["config.binaryPath"]),
                    ("cursor", vec!["config.binaryPath"]),
                    ("grok", vec!["config.binaryPath"]),
                    ("fx", vec!["config.binaryPath"]),
                    ("kiro", vec!["config.binaryPath"]),
                    ("muse", vec!["config.binaryPath"]),
                    ("opencode", vec!["config.binaryPath", "config.serverUrl"]),
                    ("pi", vec!["config.binaryPath", "config.launchArgs"]),
                    (
                        "acpRegistry",
                        vec!["config.commandPath", "config.commandArgs"],
                    ),
                ] {
                    let mut fields: Vec<String> = fields.into_iter().map(str::to_owned).collect();
                    if providers
                        .get("instances")
                        .and_then(|pins| pins.get(driver))
                        .is_some()
                        && driver == "codex"
                    {
                        fields.push("config.setupMode".into());
                    }
                    fields.push("environment".into());
                    locks.insert(driver.into(), serde_json::json!(fields));
                }
            }
            if let Some(pins) = providers
                .get("instances")
                .and_then(serde_json::Value::as_object)
            {
                for (driver, pin) in pins {
                    if ceiling {
                        continue;
                    }
                    if pin["locked"] != true {
                        continue;
                    }
                    let mut fields = Vec::<String>::new();
                    for field in ["binaryPath", "launchArgs"] {
                        if pin.get(field).is_some() {
                            fields.push(format!("config.{field}"));
                        }
                    }
                    if driver == "codex" {
                        fields.push("config.setupMode".into());
                    }
                    if driver == "opencode" {
                        fields.push("config.serverUrl".into());
                    }
                    if pin["environment"].as_array().is_some_and(|values| {
                        values.iter().any(|value| {
                            environment_name_matches(
                                value,
                                if driver == "codex" {
                                    "CODEX_HOME"
                                } else if driver == "claudeAgent" {
                                    "CLAUDE_CONFIG_DIR"
                                } else {
                                    ""
                                },
                            )
                        })
                    }) {
                        if driver == "codex" || driver == "claudeAgent" {
                            fields.push("config.homePath".into());
                        }
                        if driver == "codex" {
                            fields.push("config.shadowHomePath".into());
                        }
                    }
                    for env in pin["environment"].as_array().into_iter().flatten() {
                        if let Some(name) = env["name"].as_str() {
                            fields.push(format!("environment.{name}"));
                        }
                    }
                    if !fields.is_empty() {
                        locks.insert(driver.clone(), serde_json::json!(fields));
                    }
                }
            }
            if !locks.is_empty() {
                result.insert(
                    "lockedInstanceFields".into(),
                    serde_json::Value::Object(locks),
                );
            }
            if !result.is_empty() {
                visible.insert("providers".into(), serde_json::Value::Object(result));
            }
        }
        if let Some(updates) = limits.get("updates").and_then(serde_json::Value::as_object) {
            let mut sanitized = serde_json::Map::new();
            for key in ["mode", "allowNightly"] {
                if let Some(value) = updates.get(key) {
                    sanitized.insert(key.into(), value.clone());
                }
            }
            visible.insert("updates".into(), serde_json::Value::Object(sanitized));
        }
        summary["limits"] = serde_json::Value::Object(visible);
    }
    Ok(Some(summary))
}
pub(crate) fn has_provider_restrictions() -> Result<bool, String> {
    Ok(runtime_document()?.is_some_and(|policy| {
        policy.pointer("/limits/maxRuntimeMode").is_some()
            || policy.pointer("/limits/providers").is_some()
    }))
}
pub fn runtime_ceiling() -> Result<Option<(String, String)>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    match policy.pointer("/limits/maxRuntimeMode") {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .filter(|s| mode_rank(s).is_some())
            .map(|s| {
                Some((
                    policy["organization"].as_str().unwrap_or("").to_owned(),
                    s.to_owned(),
                ))
            })
            .ok_or_else(|| "Invalid managed policy runtime ceiling".into()),
    }
}
fn mode_rank(mode: &str) -> Option<usize> {
    [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
    ]
    .iter()
    .position(|m| *m == mode)
}
fn driver_label(driver: &str) -> &str {
    match driver {
        "codex" => "Codex",
        "claudeAgent" => "Claude",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        "acpRegistry" => "ACP Registry",
        "grok" => "Grok",
        "kiro" => "Kiro",
        "fx" => "Factory",
        "pi" => "Pi",
        "cursor" => "Cursor",
        "muse" => "Muse",
        _ => driver,
    }
}
pub fn check_provider_allowed(driver: &str) -> Result<(), String> {
    let Some(policy) = runtime_document()? else {
        return Ok(());
    };
    let Some(allowed) = policy.pointer("/limits/providers/allowedDrivers") else {
        return Ok(());
    };
    let values = allowed
        .as_array()
        .filter(|v| !v.is_empty() && v.iter().all(serde_json::Value::is_string))
        .ok_or("Invalid managed provider allowlist")?;
    if values.iter().any(|v| v.as_str() == Some(driver)) {
        return Ok(());
    }
    Err(format!(
        "{}'s policy does not allow the {} provider.",
        policy["organization"]
            .as_str()
            .unwrap_or("Your organization"),
        driver_label(driver)
    ))
}
pub(crate) fn pinned_provider_environment(
    driver: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    Ok(policy
        .pointer("/limits/providers/instances")
        .and_then(|pins| pins.get(driver))
        .and_then(|pin| pin.get("environment"))
        .and_then(serde_json::Value::as_array)
        .and_then(|values| {
            values.iter().find(|value| {
                value["name"].as_str().is_some_and(|key| {
                    if cfg!(windows) {
                        key.eq_ignore_ascii_case(name)
                    } else {
                        key == name
                    }
                })
            })
        })
        .and_then(|value| value["value"].as_str())
        .map(str::to_owned))
}
fn environment_name_matches(value: &serde_json::Value, expected: &str) -> bool {
    value["name"].as_str().is_some_and(|name| {
        if cfg!(windows) {
            name.eq_ignore_ascii_case(expected)
        } else {
            name == expected
        }
    })
}
fn setting_value<'a>(root: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut v = root;
    for part in path {
        v = v.get(*part)?;
    }
    Some(v)
}
fn set_setting(
    root: &mut serde_json::Value,
    path: &[&str],
    value: Option<serde_json::Value>,
) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return Err("Invalid managed setting path".into());
    };
    let mut v = root;
    for part in parents {
        v = v.get_mut(*part).ok_or("Invalid managed setting path")?;
    }
    let object = v.as_object_mut().ok_or("Invalid managed setting path")?;
    if let Some(value) = value {
        object.insert((*last).into(), value);
    } else {
        object.remove(*last);
    }
    Ok(())
}
fn project_scoped(key: &str) -> bool {
    matches!(
        key,
        "worktreeCleanup"
            | "defaultModelSelection"
            | "defaultRuntimeMode"
            | "defaultThreadEnvMode"
            | "newWorktreesStartFromOrigin"
            | "worktreeSubmodules"
            | "defaultAutoPull"
            | "defaultProjectScripts"
            | "enableAgentBrowserAccess"
            | "enableAgentDeviceAccess"
            | "textGenerationModelSelection"
            | "threadTitleInstructions"
            | "sourceControlWriterModelSelection"
            | "reviewGuideModelSelection"
            | "reviewGuideInstructions"
            | "sourceControlWritingStyle"
            | "removeAgentCreditsOnMerge"
            | "branchNamingMode"
            | "branchNamePrefix"
            | "branchNameInstructions"
            | "pullRequestMergeMethod"
            | "sidebarAutoSettleOnMerge"
            | "sidebarAutoSettleAfterDays"
            | "sidebarAutoSettleKeepPullRequests"
            | "continueThreadsAfterServerUpdate"
            | "responseStreamingMode"
            | "speechProjectCustomWords"
            | "providerInstances"
    )
}
fn matches_lock(value: &serde_json::Value, lock: &serde_json::Value) -> bool {
    match (value.as_object(), lock.as_object()) {
        (Some(value), Some(lock)) => value
            .iter()
            .all(|(k, v)| lock.get(k).is_some_and(|l| matches_lock(v, l))),
        _ => value == lock,
    }
}
fn set_overlay(
    root: &mut serde_json::Value,
    path: &[&str],
    value: serde_json::Value,
) -> Result<(), String> {
    let Some((head, rest)) = path.split_first() else {
        *root = value;
        return Ok(());
    };
    if !root.is_object() {
        *root = serde_json::json!({});
    }
    let child = root
        .as_object_mut()
        .ok_or("Invalid managed setting path")?
        .entry(*head)
        .or_insert(serde_json::Value::Null);
    set_overlay(child, rest, value)
}
fn fill_policy_default(
    effective: &mut serde_json::Value,
    stored: Option<&serde_json::Value>,
    default: &serde_json::Value,
) {
    let Some(stored) = stored else {
        *effective = default.clone();
        return;
    };
    if let (Some(target), Some(saved), Some(values)) = (
        effective.as_object_mut(),
        stored.as_object(),
        default.as_object(),
    ) {
        for (key, value) in values {
            fill_policy_default(
                target.entry(key.clone()).or_insert(serde_json::Value::Null),
                saved.get(key),
                value,
            );
        }
    }
}
pub(crate) fn apply_setting_defaults(
    settings: &mut serde_json::Value,
    stored: &serde_json::Value,
) -> Result<(), String> {
    let Some(policy) = runtime_document()? else {
        return Ok(());
    };
    apply_policy_setting_defaults(settings, stored, &policy)
}
pub(crate) fn defaulted_setting_heads() -> Result<std::collections::BTreeSet<String>, String> {
    Ok(defaulted_setting_paths()?
        .into_iter()
        .filter_map(|path| path.split('.').next().map(str::to_owned))
        .collect())
}
pub(crate) fn defaulted_setting_paths() -> Result<Vec<String>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(Default::default());
    };
    let Some(rules) = policy.get("settings") else {
        return Ok(Default::default());
    };
    Ok(rules
        .as_object()
        .ok_or("Invalid managed settings")?
        .iter()
        .filter_map(|(path, rule)| (rule["locked"] == false).then_some(path.clone()))
        .collect())
}
fn apply_policy_setting_defaults(
    settings: &mut serde_json::Value,
    stored: &serde_json::Value,
    policy: &serde_json::Value,
) -> Result<(), String> {
    let Some(rules) = policy.get("settings") else {
        return Ok(());
    };
    for (path, rule) in rules.as_object().ok_or("Invalid managed settings")? {
        if rule["locked"].as_bool().ok_or("Invalid managed setting")? {
            continue;
        }
        let value = rule.get("value").ok_or("Invalid managed setting")?;
        let parts: Vec<_> = path.split('.').collect();
        if parts.iter().any(|part| part.is_empty()) || setting_value(settings, &parts).is_none() {
            return Err("Invalid managed setting path".into());
        }
        if path == "idleCompaction"
            && stored.get("compactIdleThreads").is_some()
            && stored.get("idleCompaction").is_none()
        {
            continue;
        }
        let mut effective = setting_value(settings, &parts)
            .cloned()
            .ok_or("Invalid managed setting path")?;
        fill_policy_default(&mut effective, setting_value(stored, &parts), value);
        set_setting(settings, &parts, Some(effective))?;
    }
    Ok(())
}
/// Apply explicitly locked settings to a client/runtime view without changing
/// the user's persisted values. Other managed settings remain startup-rejected.
pub fn apply_locked_settings(settings: &mut serde_json::Value) -> Result<(), String> {
    let Some(policy) = runtime_document()? else {
        return Ok(());
    };
    apply_policy_locked_settings(settings, &policy)
}
fn apply_policy_locked_settings(
    settings: &mut serde_json::Value,
    policy: &serde_json::Value,
) -> Result<(), String> {
    let Some(locks) = policy.get("settings") else {
        return Ok(());
    };
    let locks = locks.as_object().ok_or("Invalid managed settings")?;
    for (path, rule) in locks {
        let locked = rule["locked"].as_bool().ok_or("Invalid managed setting")?;
        if !locked {
            continue;
        }
        let value = rule
            .get("value")
            .cloned()
            .ok_or("Invalid managed setting")?;
        let parts: Vec<_> = path.split('.').collect();
        if parts.iter().any(|p| p.is_empty()) || setting_value(settings, &parts).is_none() {
            return Err("Invalid managed setting path".into());
        }
        set_setting(settings, &parts, Some(value))?;
        if project_scoped(parts[0]) {
            let projects = settings["projectSettingsOverrides"]
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            for project in projects {
                if settings["projectSettingsOverrides"][&project]
                    .get(parts[0])
                    .is_none()
                {
                    continue;
                }
                let mut target = vec!["projectSettingsOverrides", project.as_str()];
                target.extend_from_slice(&parts);
                set_overlay(settings, &target, rule["value"].clone())?;
            }
        }
    }
    Ok(())
}
/// Reject changes to locked values while allowing clients to echo the policy
/// overlay without persisting it over the user's prior setting.
pub fn vet_locked_settings(
    current: &serde_json::Value,
    next: &mut serde_json::Value,
    patch: &serde_json::Value,
) -> Result<Option<(String, String)>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    let Some(locks) = policy.get("settings") else {
        return Ok(None);
    };
    let locks = locks.as_object().ok_or("Invalid managed settings")?;
    let organization = policy["organization"].as_str().unwrap_or("").to_owned();
    for (path, rule) in locks {
        let locked = rule["locked"].as_bool().ok_or("Invalid managed setting")?;
        if !locked {
            continue;
        }
        let pin = rule.get("value").ok_or("Invalid managed setting")?;
        let parts: Vec<_> = path.split('.').collect();
        if parts.iter().any(|p| p.is_empty()) || setting_value(current, &parts).is_none() {
            return Err("Invalid managed setting path".into());
        }
        if setting_value(patch, &parts).is_some_and(|value| !matches_lock(value, pin)) {
            return Ok(Some((path.clone(), organization)));
        }
        let old = setting_value(current, &parts).cloned();
        let new = setting_value(next, &parts).cloned();
        if new != old {
            if new.as_ref() != Some(pin) {
                return Ok(Some((path.clone(), organization)));
            }
            set_setting(next, &parts, old)?;
        }
        if project_scoped(parts[0]) {
            let projects = next["projectSettingsOverrides"]
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            for project in projects {
                let mut target = vec!["projectSettingsOverrides", project.as_str()];
                target.extend_from_slice(&parts);
                if setting_value(patch, &target).is_some_and(|value| !matches_lock(value, pin)) {
                    return Ok(Some((path.clone(), organization)));
                }
                let old = setting_value(current, &target).cloned();
                let new = setting_value(next, &target).cloned();
                if let Some(new) = new.as_ref().filter(|_| new != old) {
                    if !matches_lock(new, pin) {
                        return Ok(Some((path.clone(), organization)));
                    }
                    if old.is_some()
                        || setting_value(current, &target[..target.len() - 1]).is_some()
                    {
                        set_setting(next, &target, old)?;
                    }
                }
            }
        }
    }
    Ok(None)
}
pub fn disallowed_provider_write(
    current: &serde_json::Value,
    next: &serde_json::Value,
) -> Result<Option<(String, String, String)>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    let Some(raw) = policy.pointer("/limits/providers/allowedDrivers") else {
        return Ok(None);
    };
    let allowed = raw
        .as_array()
        .filter(|v| !v.is_empty() && v.iter().all(serde_json::Value::is_string))
        .ok_or("Invalid managed provider allowlist")?;
    let denied = |driver: &str| !allowed.iter().any(|v| v.as_str() == Some(driver));
    let organization = policy["organization"].as_str().unwrap_or("").to_owned();
    let enabled = |entry: &serde_json::Value| {
        entry["enabled"] != false
            && entry["config"]["enabled"] != false
            && (entry["driver"] != "pi"
                || entry["enabled"] == true
                || entry["config"]["enabled"] == true)
    };
    if let Some(instances) = next["providerInstances"].as_object() {
        for (id, entry) in instances {
            let Some(driver) = entry["driver"].as_str() else {
                continue;
            };
            let old = &current["providerInstances"][id];
            let was_enabled = if old.is_object() {
                old["driver"] == driver && enabled(old)
            } else {
                id == driver
            };
            if enabled(entry) && !was_enabled && denied(driver) {
                return Ok(Some((
                    id.clone(),
                    driver_label(driver).into(),
                    organization,
                )));
            }
        }
    }
    if let Some(projects) = next["projectSettingsOverrides"].as_object() {
        for (project, overrides) in projects {
            if let Some(instances) = overrides["providerInstances"].as_object() {
                for (id, value) in instances {
                    let driver = next["providerInstances"][id]["driver"]
                        .as_str()
                        .unwrap_or(id);
                    if value["enabled"] == true
                        && current["projectSettingsOverrides"][project]["providerInstances"][id]
                            ["enabled"]
                            != true
                        && denied(driver)
                    {
                        return Ok(Some((
                            id.clone(),
                            driver_label(driver).into(),
                            organization,
                        )));
                    }
                }
            }
        }
    }
    Ok(None)
}

pub fn vet_locked_provider_pins(
    current: &serde_json::Value,
    next: &mut serde_json::Value,
) -> Result<Option<(String, String)>, String> {
    let Some(policy) = runtime_document()? else {
        return Ok(None);
    };
    let Some(pins) = policy.pointer("/limits/providers/instances") else {
        return Ok(None);
    };
    let pins = pins.as_object().ok_or("Invalid managed provider pins")?;
    let ceiling = policy.pointer("/limits/maxRuntimeMode").is_some();
    let org = policy["organization"].as_str().unwrap_or("").to_owned();
    let Some(instances) = next["providerInstances"].as_object_mut() else {
        return Ok(None);
    };
    for (id, entry) in instances {
        let Some(driver) = entry["driver"].as_str().map(str::to_owned) else {
            continue;
        };
        let Some(pin) = pins.get(&driver) else {
            continue;
        };
        let locked = pin["locked"]
            .as_bool()
            .ok_or("Invalid managed provider pin")?;
        if !locked && !ceiling {
            continue;
        }
        let old = &current["providerInstances"][id];
        let home_locked = locked
            && ((driver == "codex"
                && pin["environment"].as_array().is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| environment_name_matches(value, "CODEX_HOME"))
                }))
                || (driver == "claudeAgent"
                    && pin["environment"].as_array().is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| environment_name_matches(value, "CLAUDE_CONFIG_DIR"))
                    })));
        if home_locked {
            let fields: &[&str] = if driver == "codex" {
                &["homePath", "shadowHomePath"]
            } else {
                &["homePath"]
            };
            for field in fields {
                let prior = old["config"].get(*field).cloned();
                let proposed = entry["config"].get(*field).cloned();
                if proposed != prior
                    && proposed
                        .as_ref()
                        .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
                {
                    return Ok(Some((
                        format!("providerInstances.{id}.config.{field}"),
                        org,
                    )));
                }
                if proposed != prior {
                    if let Some(config) = entry["config"].as_object_mut() {
                        if let Some(prior) = prior {
                            config.insert((*field).into(), prior);
                        } else {
                            config.remove(*field);
                        }
                    }
                }
            }
        }
        for field in ["binaryPath", "launchArgs", "setupMode", "serverUrl"] {
            let pinned = match field {
                "setupMode" if driver == "codex" => Some(serde_json::json!("existing")),
                "serverUrl" if driver == "opencode" => Some(serde_json::json!("")),
                "binaryPath" | "launchArgs" => pin.get(field).cloned(),
                _ => None,
            };
            let Some(pinned) = pinned else { continue };
            let prior = old["config"].get(field).cloned();
            let proposed = entry["config"].get(field).cloned();
            if prior != proposed {
                if proposed.as_ref() != Some(&pinned) {
                    return Ok(Some((
                        format!("providerInstances.{id}.config.{field}"),
                        org,
                    )));
                }
                if let Some(config) = entry["config"].as_object_mut() {
                    if let Some(prior) = prior {
                        config.insert(field.into(), prior);
                    } else {
                        config.remove(field);
                    }
                }
            }
        }
        if let Some(values) = pin["environment"].as_array() {
            let mut environment = entry["environment"].as_array().cloned().unwrap_or_default();
            let previous = old["environment"].as_array().cloned().unwrap_or_default();
            for variable in values {
                let name = variable["name"]
                    .as_str()
                    .ok_or("Invalid managed provider environment")?;
                let eq = |v: &serde_json::Value| {
                    v["name"].as_str().is_some_and(|n| {
                        if cfg!(windows) {
                            n.eq_ignore_ascii_case(name)
                        } else {
                            n == name
                        }
                    })
                };
                let prior = previous.iter().find(|v| eq(v)).cloned();
                let proposed = environment.iter().find(|v| eq(v)).cloned();
                if prior != proposed {
                    let same = proposed
                        .as_ref()
                        .is_some_and(|v| v["value"] == variable["value"]);
                    if !same {
                        return Ok(Some((
                            format!("providerInstances.{id}.environment.{name}"),
                            org,
                        )));
                    }
                    environment.retain(|v| !eq(v));
                    if let Some(prior) = prior {
                        environment.push(prior);
                    }
                }
            }
            if environment.is_empty() {
                if let Some(o) = entry.as_object_mut() {
                    o.remove("environment");
                }
            } else {
                entry["environment"] = serde_json::json!(environment);
            }
        }
        if !ceiling && locked && driver == "codex" && pin.get("launchArgs").is_some() {
            let is_override = |value: &serde_json::Value| {
                value["name"].as_str().is_some_and(|name| {
                    if cfg!(windows) {
                        name.eq_ignore_ascii_case("T3CODE_CODEX_LAUNCH_ARGS")
                    } else {
                        name == "T3CODE_CODEX_LAUNCH_ARGS"
                    }
                })
            };
            let mut environment = entry["environment"].as_array().cloned().unwrap_or_default();
            environment.retain(|value| !is_override(value));
            environment.extend(
                old["environment"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|value| is_override(value))
                    .cloned(),
            );
            if environment.is_empty() {
                if let Some(object) = entry.as_object_mut() {
                    object.remove("environment");
                }
            } else {
                entry["environment"] = serde_json::json!(environment);
            }
        }
    }
    Ok(None)
}

const LAUNCH_FIELDS: [&str; 7] = [
    "binaryPath",
    "launchArgs",
    "homePath",
    "shadowHomePath",
    "commandPath",
    "commandArgs",
    "serverUrl",
];

/// Remove user-controlled provider launch settings when a ceiling applies.
/// Provider pins and other policy restrictions remain startup-rejected until
/// they can be enforced across all settings and launch paths.
pub fn apply_provider_ceiling(settings: &mut serde_json::Value) -> Result<(), String> {
    let Some(policy) = runtime_document()? else {
        return Ok(());
    };
    let ceiling = policy.pointer("/limits/maxRuntimeMode").is_some();
    if ceiling {
        runtime_ceiling()?;
    }
    if let Some(allowed) = policy.pointer("/limits/providers/allowedDrivers") {
        let allowed = allowed
            .as_array()
            .filter(|items| !items.is_empty())
            .ok_or("Invalid managed provider allowlist")?;
        if !settings.is_object() {
            *settings = serde_json::json!({});
        }
        for key in [
            "sourceControlWriterModelSelection",
            "reviewGuideModelSelection",
        ] {
            if let Some(id) = settings[key]["instanceId"].as_str() {
                let driver = settings["providerInstances"][id]["driver"]
                    .as_str()
                    .unwrap_or(id);
                if !allowed.iter().any(|item| item.as_str() == Some(driver)) {
                    settings[key] = serde_json::Value::Null;
                }
            }
        }
        settings["textGenerators"] = serde_json::json!({});
    }
    let pins = policy["limits"]["providers"]["instances"].as_object();
    if !ceiling && pins.is_none() {
        return Ok(());
    }
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    if !settings["providerInstances"].is_object() {
        settings["providerInstances"] = serde_json::json!({});
    }
    let instances = settings["providerInstances"]
        .as_object_mut()
        .ok_or("Invalid provider settings")?;
    if let Some(pins) = pins {
        for driver in pins.keys() {
            if [
                "codex",
                "claudeAgent",
                "opencode",
                "pi",
                "grok",
                "kiro",
                "fx",
                "cursor",
                "muse",
            ]
            .contains(&driver.as_str())
            {
                instances
                    .entry(driver.clone())
                    .or_insert_with(|| serde_json::json!({"driver":driver}));
            }
        }
    }
    for entry in instances.values_mut() {
        let Some(driver) = entry["driver"].as_str().map(str::to_owned) else {
            continue;
        };
        let pin = pins.and_then(|p| p.get(&driver));
        let locked = match pin {
            Some(pin) => pin["locked"]
                .as_bool()
                .ok_or("Invalid managed provider pin")?,
            None => false,
        };
        if ceiling {
            if let Some(config) = entry["config"].as_object_mut() {
                for field in LAUNCH_FIELDS {
                    config.remove(field);
                }
            }
        }
        if let Some(pin) = pin {
            if locked
                && pin["environment"].as_array().is_some_and(|values| {
                    values.iter().any(|value| {
                        environment_name_matches(
                            value,
                            if driver == "codex" {
                                "CODEX_HOME"
                            } else if driver == "claudeAgent" {
                                "CLAUDE_CONFIG_DIR"
                            } else {
                                ""
                            },
                        )
                    })
                })
            {
                if let Some(config) = entry["config"].as_object_mut() {
                    config.remove("homePath");
                    if driver == "codex" {
                        config.remove("shadowHomePath");
                    }
                }
            }
            for field in ["binaryPath", "launchArgs"] {
                if let Some(value) = pin.get(field) {
                    if ceiling || locked || entry["config"][field].is_null() {
                        entry["config"][field] = value.clone();
                    }
                }
            }
            if ceiling || locked {
                if driver == "codex" {
                    entry["config"]["setupMode"] = serde_json::json!("existing");
                }
                if driver == "opencode" {
                    entry["config"]["serverUrl"] = serde_json::json!("");
                }
            }
        }
        let mut environment = if ceiling {
            Vec::new()
        } else {
            entry["environment"].as_array().cloned().unwrap_or_default()
        };
        if !ceiling
            && locked
            && driver == "codex"
            && pin.is_some_and(|pin| pin.get("launchArgs").is_some())
        {
            environment.retain(|value| {
                value["name"].as_str().is_none_or(|name| {
                    if cfg!(windows) {
                        !name.eq_ignore_ascii_case("T3CODE_CODEX_LAUNCH_ARGS")
                    } else {
                        name != "T3CODE_CODEX_LAUNCH_ARGS"
                    }
                })
            });
        }
        if let Some(pin) = pin {
            if let Some(values) = pin.get("environment") {
                let values = values
                    .as_array()
                    .ok_or("Invalid managed provider environment")?;
                for variable in values {
                    let name = variable["name"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .ok_or("Invalid managed provider environment")?;
                    let value = variable["value"]
                        .as_str()
                        .ok_or("Invalid managed provider environment")?;
                    let equal = |v: &serde_json::Value| {
                        v["name"].as_str().is_some_and(|n| {
                            if cfg!(windows) {
                                n.eq_ignore_ascii_case(name)
                            } else {
                                n == name
                            }
                        })
                    };
                    let exists = environment.iter().any(equal);
                    if ceiling || locked {
                        environment.retain(|v| !equal(v));
                    }
                    if ceiling || locked || !exists {
                        environment
                            .push(serde_json::json!({"name":name,"value":value,"sensitive":false}));
                    }
                }
            }
        }
        if environment.is_empty() {
            if let Some(object) = entry.as_object_mut() {
                object.remove("environment");
            }
        } else {
            entry["environment"] = serde_json::json!(environment);
        }
    }
    Ok(())
}
pub fn validate_ceiling_settings_write(
    current: &serde_json::Value,
    next: &serde_json::Value,
) -> Result<(), String> {
    let Some((_, ceiling)) = runtime_ceiling()? else {
        return Ok(());
    };
    if let Some(instances) = next["providerInstances"].as_object() {
        for (id, entry) in instances {
            let old = &current["providerInstances"][id];
            if old["environment"] != entry["environment"] {
                return Err(format!(
                    "Managed policy locks providerInstances.{id}.environment"
                ));
            }
            for field in LAUNCH_FIELDS {
                if old["config"][field] != entry["config"][field] {
                    return Err(format!(
                        "Managed policy locks providerInstances.{id}.config.{field}"
                    ));
                }
            }
        }
    }
    let ceiling = mode_rank(&ceiling).ok_or("Invalid managed policy runtime ceiling")?;
    let validate = |old: &serde_json::Value, mode: &serde_json::Value| -> Result<(), String> {
        if old != mode {
            if let Some(mode) = mode.as_str() {
                if mode_rank(mode).is_none_or(|rank| rank > ceiling) {
                    return Err("Default runtime mode exceeds the managed policy ceiling".into());
                }
            }
        }
        Ok(())
    };
    validate(&current["defaultRuntimeMode"], &next["defaultRuntimeMode"])?;
    if let Some(projects) = next["projectSettingsOverrides"].as_object() {
        for (id, value) in projects {
            validate(
                &current["projectSettingsOverrides"][id]["defaultRuntimeMode"],
                &value["defaultRuntimeMode"],
            )?;
        }
    }
    Ok(())
}
pub fn check_runtime_mode(mode: &str) -> Result<(), String> {
    let Some((organization, ceiling)) = runtime_ceiling()? else {
        return Ok(());
    };
    let requested = mode_rank(mode).ok_or("Invalid runtime mode")?;
    if requested > mode_rank(&ceiling).ok_or("Invalid managed policy runtime ceiling")? {
        let label = match ceiling.as_str() {
            "approval-required" => "Supervised",
            "auto-accept-edits" => "Auto-accept edits",
            "auto" => "Auto",
            _ => "Full access",
        };
        return Err(format!("{organization} limits threads to {label}."));
    }
    Ok(())
}

/// Returns the denial message, if any. This build refuses unsupported policy fields.
pub fn load(path: &Path) -> Result<Option<String>, String> {
    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "Cannot read managed policy {}: {e}",
                path.display()
            ))
        }
    };
    validate_installed_document(&data)
        .map_err(|e| format!("Cannot enforce managed policy {}: {e}", path.display()))
}

fn validate_installed_document(data: &[u8]) -> Result<Option<String>, String> {
    let policy: Document = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    if policy.schema_version != 1 {
        return Err("Unsupported managed policy schemaVersion".into());
    }
    if policy.organization.trim().is_empty() {
        return Err("Managed policy organization must not be empty".into());
    }
    if let Some(url) = policy.support_url {
        if url.trim().is_empty() {
            return Err("Invalid managed policy supportUrl".into());
        }
    }
    if let Some(connect) = policy.limits.as_ref().and_then(|l| l.connect) {
        if connect || !cfg!(unix) {
            return Err("Cannot enforce this installed Connect policy".into());
        }
    }
    Ok(policy.limits.and_then(|l| {
        let _ = (l.telemetry, l.browser_cookie_import);
        (l.webhook_tasks == Some(false)).then(|| {
            format!(
                "{}'s policy does not allow webhook tasks.",
                policy.organization
            )
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn cloud_unlink_preserves_other_files_and_refuses_symlink_directory() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("t3-cloud-unlink-{}", uuid::Uuid::new_v4()));
        let secrets = root.join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("cloud-relay-url.bin"), b"linked").unwrap();
        std::fs::write(secrets.join("unrelated.bin"), b"keep").unwrap();
        unlink_cloud_state(&secrets).unwrap();
        assert!(!secrets.join("cloud-relay-url.bin").exists());
        assert_eq!(
            std::fs::read(secrets.join("unrelated.bin")).unwrap(),
            b"keep"
        );
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("cloud-relay-url.bin"), b"outside").unwrap();
        let link = root.join("link");
        symlink(&outside, &link).unwrap();
        assert!(unlink_cloud_state(&link).is_err());
        assert_eq!(
            std::fs::read(outside.join("cloud-relay-url.bin")).unwrap(),
            b"outside"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn connect_is_disabled_by_explicit_rule_or_local_only_clients() {
        assert!(allows_connect_document(None));
        assert!(!allows_connect_document(Some(
            &serde_json::json!({"limits":{"connect":false}})
        )));
        assert!(!allows_connect_document(Some(
            &serde_json::json!({"limits":{"clients":["local-browser"]}})
        )));
        assert!(allows_connect_document(Some(
            &serde_json::json!({"limits":{"clients":["remote"]}})
        )));
    }
    #[test]
    fn runtime_document_rejects_unknown_and_malformed_rules() {
        let base = serde_json::json!({"schemaVersion":1,"organization":"Example"});
        assert!(validate_runtime_document(&base).is_ok());
        for extra in [
            serde_json::json!({"unknown":true}),
            serde_json::json!({"limits":{"unrecognized":false}}),
            serde_json::json!({"limits":{"clients":[]}}),
            serde_json::json!({"settings":{"defaultRuntimeMode":{"locked":true}}}),
        ] {
            let mut candidate = base.clone();
            candidate
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(
                validate_runtime_document(&candidate).is_err(),
                "{candidate}"
            );
        }
    }
    #[test]
    fn managed_setting_validation_rejects_unsafe_or_unknown_paths() {
        for (path, value) in [
            ("notASetting", serde_json::json!(true)),
            ("defaultModelSelection.model", serde_json::json!("model")),
            ("compactIdleThreads", serde_json::json!(false)),
            ("defaultRuntimeMode", serde_json::json!("yolo")),
        ] {
            let policy = serde_json::json!({"schemaVersion":1,"organization":"Example","settings":{(path):{"value":value,"locked":true}}});
            assert!(validate_runtime_document(&policy).is_err(), "{path}");
        }
        let valid = serde_json::json!({"schemaVersion":1,"organization":"Example","settings":{"storageCleanup.logsAfterDays":{"value":9,"locked":false}}});
        assert!(validate_runtime_document(&valid).is_ok());
    }
    #[test]
    fn provider_pin_environment_names_follow_schema() {
        for (name, valid) in [
            ("SAFE_NAME", true),
            ("_SAFE1", true),
            ("1BAD", false),
            ("BAD-NAME", false),
        ] {
            let policy = serde_json::json!({"allowedDrivers":["codex"],"instances":{"codex":{"locked":true,"environment":[{"name":name,"value":"x"}]}}});
            assert_eq!(validate_provider_limits(&policy).is_ok(), valid, "{name}");
        }
        let policy = serde_json::json!({"instances":{"codex":{"locked":true,"environment":[{"name":"A".repeat(129),"value":"x"}]}}});
        assert!(validate_provider_limits(&policy).is_err());
    }
    #[test]
    fn defaults_fill_missing_values_without_overwriting_user_choices() {
        let policy = serde_json::json!({"settings":{"storageCleanup":{"value":{"logsAfterDays":9,"worktreeAfterDays":3},"locked":false}}});
        let stored = serde_json::json!({"storageCleanup":{"logsAfterDays":12}});
        let mut effective =
            serde_json::json!({"storageCleanup":{"logsAfterDays":12,"worktreeAfterDays":30}});
        apply_policy_setting_defaults(&mut effective, &stored, &policy).unwrap();
        assert_eq!(
            effective["storageCleanup"],
            serde_json::json!({"logsAfterDays":12,"worktreeAfterDays":3})
        );
        assert_eq!(
            stored["storageCleanup"],
            serde_json::json!({"logsAfterDays":12})
        );
    }
    #[test]
    fn project_nested_lock_overlays_only_existing_project_settings() {
        let policy =
            serde_json::json!({"settings":{"worktreeCleanup.days":{"value":7,"locked":true}}});
        let mut value = serde_json::json!({"worktreeCleanup":{"days":20},"projectSettingsOverrides":{"a":{"worktreeCleanup":{"days":30,"other":true}},"b":{"defaultAutoPull":true}}});
        apply_policy_locked_settings(&mut value, &policy).unwrap();
        assert_eq!(value["worktreeCleanup"]["days"], 7);
        assert_eq!(
            value["projectSettingsOverrides"]["a"]["worktreeCleanup"],
            serde_json::json!({"days":7,"other":true})
        );
        assert!(value["projectSettingsOverrides"]["b"]
            .get("worktreeCleanup")
            .is_none());
    }
    #[test]
    fn policy_blocks_and_unknown_restrictions_fail_closed() {
        let path = std::env::temp_dir().join(format!("t3-policy-{}", uuid::Uuid::new_v4()));
        assert_eq!(load(&path).unwrap(), None);
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","limits":{"webhookTasks":false}}"#,
        )
        .unwrap();
        assert_eq!(
            load(&path).unwrap().as_deref(),
            Some("Example's policy does not allow webhook tasks.")
        );
        std::fs::write(&path, r#"{"schemaVersion":1,"organization":"Example","limits":{"telemetry":false,"browserCookieImport":false}}"#).unwrap();
        assert_eq!(load(&path).unwrap(), None);
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","supportUrl":"Contact IT"}"#,
        )
        .unwrap();
        assert_eq!(load(&path).unwrap(), None);
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","supportUrl":"  "}"#,
        )
        .unwrap();
        assert!(load(&path).is_err());
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","limits":{"telemetry":"false"}}"#,
        )
        .unwrap();
        assert!(load(&path).is_err());
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","limits":{"connect":false}}"#,
        )
        .unwrap();
        assert_eq!(load(&path).is_ok(), cfg!(unix));
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"organization":"Example","limits":{"connect":true}}"#,
        )
        .unwrap();
        assert!(load(&path).is_err());
        std::fs::write(&path, r#"{"organization":"Example"}"#).unwrap();
        assert!(load(&path).is_err());
        std::fs::write(&path, r#"{"schemaVersion":2,"organization":"Example"}"#).unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
