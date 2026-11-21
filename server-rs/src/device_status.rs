//! Device status for the disabled local-host configuration.
//! Active hubs and remote hosts require the full device runtime and fail closed.
use crate::device_hub::{AGENT_VERSION, HUB_VERSION};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct DeviceStatus {
    base_dir: PathBuf,
    state: Mutex<(Option<Value>, u64)>,
    changes: tokio::sync::broadcast::Sender<Value>,
    configured: std::sync::atomic::AtomicBool,
    hub: crate::device_hub::LocalHub,
    hub_state: Mutex<Option<Value>>,
    tool_install: Arc<tokio::sync::Mutex<()>>,
}
impl DeviceStatus {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            hub: crate::device_hub::LocalHub::new(base_dir.clone()),
            base_dir,
            hub_state: Mutex::new(None),
            tool_install: Arc::new(tokio::sync::Mutex::new(())),
            state: Mutex::new((None, 0)),
            changes: tokio::sync::broadcast::channel(32).0,
            configured: std::sync::atomic::AtomicBool::new(false),
        }
    }
    pub async fn shutdown(&self, device: &str, platform: &str) -> Result<(), Value> {
        self.hub.shutdown(device,platform).await.map_err(|e|json!({"_tag":"DeviceOperationError","operation":"shutdown","reason":"request_failed","message":e.to_string()}))?;
        self.refresh_hub().await
    }
    pub async fn refresh_hub(&self) -> Result<(), Value> {
        let value=self.hub.refresh().await.map_err(|e|json!({"_tag":"DeviceOperationError","operation":"list","reason":"request_failed","message":e.to_string()}))?;
        *self
            .hub_state
            .lock()
            .map_err(|_| json!({"name":"Error","message":"Device state unavailable"}))? =
            Some(value);
        Ok(())
    }
    pub async fn stop_hub(&self) {
        self.hub.stop().await;
        if let Ok(mut state) = self.hub_state.lock() {
            *state = None;
        }
    }
    pub async fn ensure_tool(&self, tool: &str) -> Result<(), Value> {
        let (name, version, entry) = match tool {
            "hub" => ("expo-device-hub", HUB_VERSION, "dist/server/cli.mjs"),
            "agent" => ("agent-device", AGENT_VERSION, "bin/agent-device.mjs"),
            _ => return Err(device_install_error("Unknown device tool.")),
        };
        let install = self.tool_install.clone().lock_owned().await;
        let parent = self.base_dir.join("tools").join(name);
        tokio::task::spawn_blocking(move || {
            let _install = install;
            install_tool(&parent, name, version, entry)
        })
            .await
            .map_err(|error| device_install_error(error.to_string()))?
            .map_err(|error| device_install_error(error.to_string()))
    }
    pub fn mark_configured(&self) {
        self.configured
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.changes.subscribe()
    }
    pub fn read(&self, settings: &Value, inspect: bool) -> Result<Value, Value> {
        if ["deviceHosts", "easDeviceHosts", "simlockDeviceHosts"]
            .iter()
            .any(|key| settings[*key].as_array().is_some_and(|a| !a.is_empty()))
        {
            return Err(
                json!({"name":"Error","message":"Active device hosts are not supported by this server."}),
            );
        }
        let tools = |name: &str, required: &str, entry: &[&str]| {
            let root = self.base_dir.join("tools").join(name);
            let mut versions: Vec<String> = std::fs::read_dir(&root)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let version = e.file_name().into_string().ok()?;
                    let (core, suffix) = version
                        .split_once('-')
                        .map_or((version.as_str(), None), |(a, b)| (a, Some(b)));
                    if core.split('.').count() != 3
                        || !core
                            .split('.')
                            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                        || suffix.is_some_and(|s| {
                            s.is_empty()
                                || !s
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
                        })
                    {
                        return None;
                    }
                    let p = e.path();
                    let sentinel = std::fs::read_to_string(p.join(".install-complete")).ok()?;
                    let mut file = p.join("node_modules").join(name);
                    for part in entry {
                        file.push(part);
                    }
                    (sentinel.trim() == version && file.exists()).then_some(version)
                })
                .collect();
            versions.sort();
            json!({"requiredVersion":required,"installedVersions":versions,"runningVersion":null})
        };
        let hub = tools("expo-device-hub", HUB_VERSION, &["dist", "server", "cli.mjs"]);
        let agent = tools("agent-device", AGENT_VERSION, &["bin", "agent-device.mjs"]);
        let installed = |v: &Value| {
            v["installedVersions"]
                .as_array()
                .is_some_and(|vs| vs.contains(&v["requiredVersion"]))
        };
        let ios = if cfg!(target_os = "macos") {
            if command_exists("xcrun") {
                None
            } else {
                Some("Xcode command line tools were not found.".to_string())
            }
        } else {
            Some("iOS Simulators need macOS with Xcode.".to_string())
        };
        let android = android_reason();
        let platform = |name: &str, reason: Option<String>| match reason {
            Some(reason) => json!({"platform":name,"available":false,"reason":reason}),
            None => json!({"platform":name,"available":true}),
        };
        let mut value = json!({"supportsHostRetry":true,"supportsToolUpdate":true,"supportsToolInspection":true,"supportsEasHosts":false,"supportsSimlockHosts":false,"hosts":[{"id":"local","kind":"local","label":"This machine","platforms":[platform("ios",ios),platform("android",android)],"hubInstalled":installed(&hub),"agentDeviceInstalled":installed(&agent),"tools":{"hub":hub,"agent":agent}}],"hostStatus":if settings["enableDeviceSupport"] == true {"idle"} else {"disabled"},"hostStatuses":{},"devices":[],"sessions":[],"easHosts":[],"simlockHosts":[],"onboardingCompleted":settings["deviceOnboardingCompleted"].as_bool().unwrap_or(false),"agentAccessEnabled":settings["enableAgentDeviceAccess"].as_bool().unwrap_or(false),"hubBasePath":"/api/device-hub"});
        if settings["enableDeviceSupport"] == true && !can_enable_without_hub() {
            let live = self
                .hub_state
                .lock()
                .map_err(|_| json!({"name":"Error","message":"Device state unavailable"}))?
                .clone();
            if let Some(live) = live {
                value["devices"] = live["devices"].clone();
                value["hostStatuses"] = live["hostStatuses"].clone();
                value["hostStatus"] = json!("ready");
                value["hosts"][0]["tools"]["hub"]["runningVersion"] = json!(HUB_VERSION);
            }
        }
        if self.configured.load(std::sync::atomic::Ordering::SeqCst) {
            value["hostStatusDetail"] = Value::Null;
            value["bootingDevices"] = json!([]);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| json!({"name":"Error","message":"Device state unavailable"}))?;
        let changed = state.0.as_ref().is_some_and(|previous| previous != &value) || inspect;
        if changed {
            state.1 += 1;
        }
        state.0 = Some(value.clone());
        value["revision"] = json!(state.1);
        if changed {
            let _ = self.changes.send(value.clone());
        }
        Ok(value)
    }
}
fn device_install_error(message: impl Into<String>) -> Value {
    json!({"_tag":"DeviceOperationError","operation":"list","reason":"request_failed","message":message.into()})
}

fn install_tool(parent: &Path, name: &str, version: &str, entry: &str) -> std::io::Result<()> {
    use std::{io, process::Command, time::Duration};
    install_tool_with(parent, name, version, entry, |staging| {
        let package = format!("{name}@{version}");
        let run = |command: &mut Command| {
            command
                .args(["install", "--prefix"])
                .arg(staging)
                .args(["--no-fund", "--no-audit", &package])
                .current_dir(staging);
            crate::vcs_worktree::run_command(command, Duration::from_secs(180))
        };
        let output = match run(&mut Command::new("npm")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                run(Command::new("pnpm").args(["--package=npm@11", "dlx", "npm"]))?
            }
            output => output?,
        };
        if !output.status.success() {
            return Err(io::Error::other(format!("Could not install {package}.")));
        }
        Ok(())
    })
}

fn install_tool_with(
    parent: &Path,
    name: &str,
    version: &str,
    entry: &str,
    provision: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::{fs, io};

    let installed = parent.join(version);
    let has_entry = |dir: &Path| dir.join("node_modules").join(name).join(entry).is_file();
    let complete = || {
        has_entry(&installed)
            && fs::read_to_string(installed.join(".install-complete"))
                .is_ok_and(|value| value.trim() == version)
    };
    if complete() {
        return Ok(());
    }
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let result = (|| {
        provision(&staging)?;
        if !has_entry(&staging) {
            return Err(io::Error::other(format!("The {name} install is missing its entry point.")));
        }
        fs::write(staging.join(".install-complete"), format!("{version}\n"))?;
        match fs::rename(&staging, &installed) {
            Err(_) if complete() => Ok(()),
            result => result,
        }
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

pub fn can_enable_without_hub() -> bool {
    let ios_available = cfg!(target_os = "macos") && command_exists("xcrun");
    !ios_available && android_reason().is_some()
}
fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}
fn sdk_tool_names() -> (&'static str, &'static str, &'static str) {
    if cfg!(windows) {
        ("adb.exe", "emulator.exe", "avdmanager.bat")
    } else {
        ("adb", "emulator", "avdmanager")
    }
}

pub(crate) fn android_sdk_candidates() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let explicit: Vec<PathBuf> = [
        std::env::var_os("ANDROID_HOME"),
        std::env::var_os("ANDROID_SDK_ROOT"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|v| {
        let s = v.to_string_lossy();
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    })
    .collect();
    let mut roots = explicit.clone();
    roots.extend([
        home.join("Library/Android/sdk"),
        home.join("Android/Sdk"),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("Android/Sdk"),
    ]);
    let (exe, _, _) = sdk_tool_names();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let adb = dir.join(exe);
            if adb.exists() {
                if let Ok(p) = std::fs::canonicalize(adb) {
                    if let Some(root) = p.parent().and_then(Path::parent) {
                        roots.push(root.into());
                    }
                }
            }
        }
    }
    (explicit, roots)
}

pub(crate) fn android_sdk_root() -> Option<PathBuf> {
    let (exe, emulator, _) = sdk_tool_names();
    let (_, roots) = android_sdk_candidates();
    roots.into_iter().find(|root| {
        root.join("platform-tools").join(exe).exists()
            || root.join("emulator").join(emulator).exists()
    })
}

fn inspect_sdk_root(root: &Path) -> Result<(), String> {
    let (exe, emulator, avd) = sdk_tool_names();
    let adb = root.join("platform-tools").join(exe).exists();
    let em = root.join("emulator").join(emulator).exists();
    let r = root.to_string_lossy();
    if !adb {
        return Err(format!("Android SDK Platform-Tools are missing from {r}. Install them in Android Studio's SDK Manager."));
    }
    if !em {
        return Err(format!("Android Emulator is missing from {r}. Install them in Android Studio's SDK Manager."));
    }
    if !root.join("cmdline-tools/latest/bin").join(avd).exists() {
        return Err(if root.join("tools/bin").join(avd).exists() {
            format!("The Android SDK command-line tools in {r} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.")
        } else {
            format!("Android SDK Command-line Tools (latest) are missing from {r}. Install them in Android Studio's SDK Manager.")
        });
    }
    Ok(())
}

fn android_reason() -> Option<String> {
    if let Some(root) = android_sdk_root() {
        return inspect_sdk_root(&root).err();
    }
    let (explicit, _) = android_sdk_candidates();
    if let Some(first) = explicit.first() {
        if let Err(err) = inspect_sdk_root(first) {
            return Some(err);
        }
    }
    Some("Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_install_retries_and_preserves_the_existing_version() {
        use std::{fs, io};
        let parent = std::env::temp_dir().join(format!("t3-device-tools-{}", uuid::Uuid::new_v4()));
        let older = parent.join("0.19.1");
        fs::create_dir_all(&older).unwrap();
        fs::write(older.join(".install-complete"), "0.19.1\n").unwrap();
        let name = "expo-device-hub";
        let entry = "dist/server/cli.mjs";
        let failed = install_tool_with(&parent, name, HUB_VERSION, entry, |_| {
            Err(io::Error::other("fixture install failure"))
        });
        assert!(failed.is_err());
        assert!(!parent.join(HUB_VERSION).exists());
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        install_tool_with(&parent, name, HUB_VERSION, entry, |staging| {
            let path = staging.join("node_modules").join(name).join(entry);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, "fixture")
        }).unwrap();
        install_tool_with(&parent, name, HUB_VERSION, entry, |_| {
            panic!("a complete install must be reused");
        }).unwrap();
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 2);
        assert!(older.join(".install-complete").is_file());
        fs::remove_dir_all(&parent).unwrap();
    }
    #[test]
    fn revision_and_live_updates_for_disabled_local_host() {
        let status = DeviceStatus::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()));
        let settings = json!({"enableDeviceSupport":false,"deviceOnboardingCompleted":false,"enableAgentDeviceAccess":false,"deviceHosts":[],"easDeviceHosts":[],"simlockDeviceHosts":[]});
        let mut events = status.subscribe();
        let initial = status.read(&settings, false).unwrap();
        assert_eq!(initial["hostStatus"], "disabled");
        assert_eq!(initial["revision"], 0);
        assert_eq!(status.read(&settings, true).unwrap()["revision"], 1);
        assert_eq!(events.try_recv().unwrap()["revision"], 1);
        let mut changed = settings.clone();
        changed["enableAgentDeviceAccess"] = json!(true);
        let updated = status.read(&changed, false).unwrap();
        assert_eq!(updated["revision"], 2);
        assert_eq!(updated["agentAccessEnabled"], true);
        changed["enableDeviceSupport"] = json!(true);
        let enabled = status.read(&changed, false).unwrap();
        assert_eq!(enabled["hostStatus"], "idle");
        assert_eq!(enabled["revision"], 3);
    }
}
