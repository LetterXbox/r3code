//! Loopback-only supervisor for an already-installed local Expo device hub.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{process::Child, sync::Mutex};

// Match the device runtime versions in the supported T3 release.
pub(crate) const HUB_VERSION: &str = "0.22.1";
pub(crate) const AGENT_VERSION: &str = "0.21.36";
const AVDMANAGER_LIST_FAILED: &str = "[android-utils] Failed to run `avdmanager list avd`";

struct HubProcess {
    child: Child,
    port: u16,
    emulator_extra_args: Option<String>,
    emulator_stamp: Option<String>,
    #[cfg(unix)]
    group: u32,
}
impl Drop for HubProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        if matches!(self.child.try_wait(), Ok(None)) {
            unsafe {
                libc::kill(-(self.group as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}
pub struct LocalHub {
    base: PathBuf,
    process: Mutex<Option<HubProcess>>,
    client: reqwest::Client,
}
impl LocalHub {
    pub fn new(base: PathBuf) -> Self {
        Self {
            base,
            process: Mutex::new(None),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .expect("HTTP client"),
        }
    }
    pub async fn shutdown(&self, device: &str, platform: &str) -> io::Result<()> {
        let process = self.process.lock().await;
        let hub = process
            .as_ref()
            .ok_or_else(|| io::Error::other("Device hub is not running"))?;
        let (path, body) = if platform == "ios" {
            (
                "/vendor/serve-sim/grid/api/shutdown",
                json!({"udid":device}),
            )
        } else {
            (
                "/api/devices/shutdown",
                json!({"platform":platform,"id":device}),
            )
        };
        let mut response = self
            .client
            .post(format!("http://127.0.0.1:{}{path}", hub.port))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(io::Error::other)?
            .error_for_status()
            .map_err(io::Error::other)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(io::Error::other)? {
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err(io::Error::other("Device hub response too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if result["ok"] != true {
            return Err(io::Error::other("Device hub rejected shutdown"));
        }
        Ok(())
    }
    pub async fn stop(&self) {
        self.process.lock().await.take();
    }
    pub async fn refresh(&self) -> io::Result<Value> {
        let mut process = self.process.lock().await;
        if process
            .as_mut()
            .is_some_and(|p| p.child.try_wait().ok().flatten().is_some())
        {
            process.take();
        }
        let sdk_root = crate::device_status::android_sdk_root();
        let stamp = sdk_root.as_deref().and_then(emulator_binary_stamp);
        let mut prepared_env: Option<(BTreeMap<String, String>, Option<String>)> = None;
        if let Some(live) = process.as_mut() {
            if stamp != live.emulator_stamp {
                let (env_map, extra) = resolve_hub_env(sdk_root.as_deref()).await;
                if extra == live.emulator_extra_args {
                    live.emulator_stamp = stamp.clone();
                } else {
                    process.take();
                    prepared_env = Some((env_map, extra));
                }
            }
        }
        if process.is_none() {
            let dir = self.base.join("tools/expo-device-hub").join(HUB_VERSION);
            let entry = dir.join("node_modules/expo-device-hub/dist/server/cli.mjs");
            let sentinel =
                std::fs::read_to_string(dir.join(".install-complete")).unwrap_or_default();
            if sentinel.trim() != HUB_VERSION || !entry.is_file() {
                return Err(io::Error::other(
                    "The required device hub is not installed.",
                ));
            }
            let (env_map, extra) = match prepared_env {
                Some(pair) => pair,
                None => resolve_hub_env(sdk_root.as_deref()).await,
            };
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
            let port = listener.local_addr()?.port();
            drop(listener);
            let mut command = tokio::process::Command::new("node");
            command.arg(entry).args([
                "--port",
                &port.to_string(),
                "--host",
                "127.0.0.1",
                "--hide-sidebar",
                "--hide-boot-device",
            ]);
            if !cfg!(target_os = "macos") {
                command.args(["--platform", "android"]);
            }
            for (k, v) in &env_map {
                command.env(k, v);
            }
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(unix)]
            command.process_group(0);
            let child = command.spawn()?;
            #[cfg(unix)]
            let group = child
                .id()
                .ok_or_else(|| io::Error::other("Device hub process unavailable"))?;
            let mut hub = HubProcess {
                child,
                port,
                emulator_extra_args: extra,
                emulator_stamp: stamp,
                #[cfg(unix)]
                group,
            };
            let ready = tokio::time::timeout(Duration::from_secs(15), async {
                for _ in 0..100 {
                    if hub.child.try_wait().ok().flatten().is_some() {
                        return false;
                    }
                    if self
                        .client
                        .get(format!("http://127.0.0.1:{port}/readyz"))
                        .send()
                        .await
                        .is_ok_and(|r| r.status().is_success())
                    {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                false
            })
            .await
            .unwrap_or(false);
            if !ready {
                return Err(io::Error::other("The device hub did not become ready."));
            }
            *process = Some(hub);
        }
        let port = process.as_ref().unwrap().port;
        let response = self
            .client
            .get(format!("http://127.0.0.1:{port}/api/devices"))
            .send()
            .await
            .map_err(io::Error::other)?
            .error_for_status()
            .map_err(io::Error::other)?;
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(io::Error::other)? {
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(io::Error::other("Device hub response too large"));
            }
            body.extend_from_slice(&chunk);
        }
        let data: Value = serde_json::from_slice(&body).map_err(io::Error::other)?;
        let errors = data["errors"].as_array().cloned().unwrap_or_default();
        let has_avdmanager_err = errors.iter().any(|e| {
            e.as_str()
                .or_else(|| e["message"].as_str())
                .is_some_and(|s| s.starts_with(AVDMANAGER_LIST_FAILED))
        });
        let has_other_err = errors.iter().any(|e| {
            !e.as_str()
                .or_else(|| e["message"].as_str())
                .is_some_and(|s| s.starts_with(AVDMANAGER_LIST_FAILED))
        });
        if has_other_err {
            return Err(io::Error::other("Device hub reported incomplete discovery"));
        }
        let mut devices = Vec::new();
        for field in ["simulators", "emulators"] {
            for value in data[field]
                .as_array()
                .ok_or_else(|| io::Error::other("Invalid device hub response"))?
            {
                if !["id", "name", "version", "platform"]
                    .iter()
                    .all(|key| value[*key].is_string())
                    || !["booted", "physical"]
                        .iter()
                        .all(|key| value[*key].is_boolean())
                    || !matches!(value["platform"].as_str(), Some("ios" | "android"))
                {
                    return Err(io::Error::other("Invalid device hub response"));
                }
                devices.push(json!({"hostId":"local","id":value["id"],"name":value["name"],"version":value["version"],"platform":value["platform"],"booted":value["booted"],"physical":value["physical"]}));
            }
        }
        if has_avdmanager_err {
            let adb_devices = list_adb_devices(sdk_root.as_deref())
                .await
                .ok_or_else(|| io::Error::other("Device hub reported incomplete discovery"))?;
            devices.extend(adb_devices);
        }
        Ok(json!({"devices":devices,"hostStatuses":{"local":{"status":"ready"}}}))
    }
}

fn emulator_binary_path(sdk_root: &Path) -> PathBuf {
    sdk_root.join("emulator").join(if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    })
}

fn emulator_binary_stamp(sdk_root: &Path) -> Option<String> {
    let meta = std::fs::metadata(emulator_binary_path(sdk_root)).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())?;
    Some(format!("{mtime_ms}:{}", meta.len()))
}

fn help_contains_word(help: &str, word: &str) -> bool {
    help.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| token == word)
}

async fn resolve_hub_env(sdk_root: Option<&Path>) -> (BTreeMap<String, String>, Option<String>) {
    let mut env = BTreeMap::new();
    env.insert("FORCE_COLOR".into(), "0".into());
    env.insert("NO_COLOR".into(), "1".into());
    let mut extra = std::env::var("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if let Some(root) = sdk_root {
        env.insert(
            "ANDROID_HOME".into(),
            root.to_string_lossy().into_owned(),
        );
        let emulator = emulator_binary_path(root);
        let mut overrides = Vec::new();
        for facing in ["front", "back"] {
            let mut cmd = tokio::process::Command::new(&emulator);
            cmd.arg(format!("-help-camera-{facing}"))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            if let Ok(Ok(out)) =
                tokio::time::timeout(Duration::from_secs(5), cmd.output()).await
            {
                if out.status.success() {
                    let help = format!(
                        "{}\n{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    if help_contains_word(&help, "emulated") && !help_contains_word(&help, "imagefile") {
                        overrides.push(format!("-camera-{facing} emulated"));
                    }
                }
            }
        }
        if !overrides.is_empty() {
            let joined = overrides.join(" ");
            extra = Some(match extra {
                Some(prev) => format!("{joined} {prev}"),
                None => joined,
            });
        }
    }
    if let Some(ref value) = extra {
        env.insert("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS".into(), value.clone());
    }
    (env, extra)
}

async fn list_adb_devices(sdk_root: Option<&Path>) -> Option<Vec<Value>> {
    let adb_path = sdk_root
        .map(|root| {
            root.join("platform-tools").join(if cfg!(windows) {
                "adb.exe"
            } else {
                "adb"
            })
        })
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("adb"));
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(&adb_path)
            .args(["devices", "-l"])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut serials = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(serial), Some("device")) = (parts.next(), parts.next()) {
            serials.push(serial.to_owned());
        }
    }
    let mut result = Vec::with_capacity(serials.len());
    for serial in serials {
        let props_out = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new(&adb_path)
                .args(["-s", &serial, "shell", "getprop"])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()
        .and_then(Result::ok);
        let mut props = BTreeMap::new();
        if let Some(p) = props_out {
            for line in String::from_utf8_lossy(&p.stdout).lines() {
                let t = line.trim();
                if let Some((k, v)) = t.strip_prefix('[').and_then(|s| s.split_once("]: [")) {
                    if let Some(val) = v.strip_suffix(']') {
                        props.insert(k.to_owned(), val.to_owned());
                    }
                }
            }
        }
        let emulator = props.get("ro.kernel.qemu").map(String::as_str) == Some("1")
            || props.get("ro.boot.qemu").map(String::as_str) == Some("1");
        let avd_name = if emulator {
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::process::Command::new(&adb_path)
                    .args(["-s", &serial, "emu", "avd", "name"])
                    .stdin(Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty() && *l != "OK" && !l.starts_with("KO"))
                    .map(str::to_owned)
            })
        } else {
            None
        };
        let model = props.get("ro.product.model").map(String::as_str).unwrap_or("");
        let manufacturer = props
            .get("ro.product.manufacturer")
            .map(String::as_str)
            .unwrap_or("");
        let name = if emulator {
            avd_name.unwrap_or_else(|| serial.clone())
        } else if !model.is_empty() {
            [manufacturer, model]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            serial.clone()
        };
        let release = props
            .get("ro.build.version.release")
            .map(String::as_str)
            .unwrap_or("");
        let version = if release.is_empty() {
            "Android".to_owned()
        } else if release.chars().all(|c| c.is_ascii_digit()) {
            format!("Android {release}.0")
        } else {
            format!("Android {release}")
        };
        result.push(json!({
            "hostId": "local",
            "id": serial,
            "name": name,
            "version": version,
            "platform": "android",
            "booted": true,
            "physical": !emulator,
        }));
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn supervises_installed_loopback_hub_and_lists_devices() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-hub-test-{}", uuid::Uuid::new_v4()));
        let install = root.join("tools/expo-device-hub").join(HUB_VERSION);
        let entry = install.join("node_modules/expo-device-hub/dist/server/cli.mjs");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(install.join(".install-complete"), format!("{HUB_VERSION}\n")).unwrap();
        std::fs::write(entry,r#"import http from 'node:http';
const n=process.argv.indexOf('--port');const port=Number(process.argv[n+1]);
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url==='/readyz'?'{}':req.url==='/api/devices/shutdown'?JSON.stringify({ok:true}):JSON.stringify({simulators:[],emulators:[{id:'emu',name:'Fixture',version:'Android',platform:'android',booted:false,physical:false}]}));}).listen(port,'127.0.0.1');"#).unwrap();
        let hub = LocalHub::new(root.clone());
        let result = hub.refresh().await.unwrap();
        assert_eq!(result["devices"][0]["hostId"], "local");
        assert_eq!(result["devices"][0]["id"], "emu");
        assert_eq!(result["hostStatuses"]["local"]["status"], "ready");
        hub.shutdown("emu", "android").await.unwrap();
        hub.stop().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
