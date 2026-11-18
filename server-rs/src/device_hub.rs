//! Loopback-only supervisor for an already-installed local Expo device hub.
use serde_json::{json, Value};
use std::{io, path::PathBuf, process::Stdio, time::Duration};
use tokio::{process::Child, sync::Mutex};

struct HubProcess {
    child: Child,
    port: u16,
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
        if process.is_none() {
            let dir = self.base.join("tools/expo-device-hub/0.22.1");
            let entry = dir.join("node_modules/expo-device-hub/dist/server/cli.mjs");
            let sentinel =
                std::fs::read_to_string(dir.join(".install-complete")).unwrap_or_default();
            if sentinel.trim() != "0.22.1" || !entry.is_file() {
                return Err(io::Error::other(
                    "The required device hub is not installed.",
                ));
            }
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
        if data["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
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
        Ok(json!({"devices":devices,"hostStatuses":{"local":{"status":"ready"}}}))
    }
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
        let install = root.join("tools/expo-device-hub/0.22.1");
        let entry = install.join("node_modules/expo-device-hub/dist/server/cli.mjs");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(install.join(".install-complete"), "0.22.1\n").unwrap();
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
