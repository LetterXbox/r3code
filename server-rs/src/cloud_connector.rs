//! Owned Cloudflare connector process. Activation must follow relay origin confirmation.
use std::{ffi::OsString, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

#[derive(Default)]
struct State {
    child: Option<Child>,
    generation: u64,
    process_generation: u64,
    metrics: Option<std::net::SocketAddr>,
    protocol: Option<String>,
    http2: bool,
    transport_explicit: bool,
    secrets: Option<std::path::PathBuf>,
    quic_stalls: Vec<tokio::time::Instant>,
}
pub struct Connector {
    state: Arc<Mutex<State>>,
}
impl Default for Connector {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
        }
    }
}
async fn spawn_with_retry(command: &mut Command) -> std::io::Result<Child> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) => {
                let transient = matches!(error.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::ExecutableFileBusy);
                if !transient || tokio::time::Instant::now() >= deadline { return Err(error); }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}

async fn spawn(executable: &OsString, token: &str, http2: bool) -> Result<Child, String> {
    let mut command = Command::new(executable);
    command.args([
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--output",
        "default",
        "--metrics",
        "127.0.0.1:0",
    ]);
    if http2 {
        command.args(["--protocol", "http2"]);
    }
    command
        .arg("run")
        .env("TUNNEL_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    spawn_with_retry(&mut command).await.map_err(|_| "Could not start relay client".into())
}
fn enable_http2(state: &mut State) {
    if state.transport_explicit || state.http2 {
        return;
    }
    state.http2 = true;
    if let (Some(dir), Ok(now)) = (
        &state.secrets,
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH),
    ) {
        let _ = crate::cloud_link_config::record_http2_fallback(dir, now.as_millis());
    }
}
fn observe_output<R>(
    stream: R,
    state: std::sync::Weak<Mutex<State>>,
    generation: u64,
    process_generation: u64,
    pid: u32,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut stream = stream;
        let mut chunk = [0u8; 1024];
        let mut line = Vec::new();
        while let Ok(n) = stream.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            for byte in &chunk[..n] {
                if *byte == b'\n' {
                    let text = String::from_utf8_lossy(&line);
                    let lower = text.to_ascii_lowercase();
                    if lower
                        .find("registered tunnel connection")
                        .is_some_and(|index| {
                            index == 0 || !lower.as_bytes()[index - 1].is_ascii_alphanumeric()
                        })
                    {
                        let protocol = text
                            .split("protocol=")
                            .nth(1)
                            .map(|value| {
                                value
                                    .chars()
                                    .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                                    .collect::<String>()
                            })
                            .filter(|value| !value.is_empty());
                        if let Some(state) = state.upgrade() {
                            let mut guard = state.lock().await;
                            if guard.generation == generation
                                && guard.process_generation == process_generation
                                && guard.child.as_ref().and_then(Child::id) == Some(pid)
                            {
                                if protocol.as_deref() == Some("http2") {
                                    enable_http2(&mut guard);
                                }
                                guard.protocol = protocol;
                            }
                        }
                    }
                    if text.contains("timeout: no recent network activity")
                        && text
                            .split_whitespace()
                            .any(|word| matches!(word, "ERR" | "WRN" | "FTL" | "PNC"))
                    {
                        if let Some(state) = state.upgrade() {
                            let mut guard = state.lock().await;
                            if guard.generation == generation
                                && guard.process_generation == process_generation
                                && guard.child.as_ref().and_then(Child::id) == Some(pid)
                                && !guard.transport_explicit
                                && !guard.http2
                            {
                                let now = tokio::time::Instant::now();
                                guard.quic_stalls.retain(|value| {
                                    now.duration_since(*value) < Duration::from_secs(300)
                                });
                                guard.quic_stalls.push(now);
                                if guard.quic_stalls.len() >= 30 {
                                    enable_http2(&mut guard);
                                    if let Some(child) = guard.child.as_mut() {
                                        let _ = child.start_kill();
                                    }
                                }
                            }
                        }
                    }
                    if let Some(rest) = text.split("Starting metrics server on ").nth(1) {
                        if let Some(address) = rest
                            .split("/metrics")
                            .next()
                            .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
                            .filter(|address| {
                                address.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                                    && address.port() != 0
                            })
                        {
                            if let Some(state) = state.upgrade() {
                                let mut guard = state.lock().await;
                                if guard.generation == generation
                                    && guard.process_generation == process_generation
                                    && guard.child.as_ref().and_then(Child::id) == Some(pid)
                                {
                                    guard.metrics = Some(address);
                                }
                            }
                        }
                    }
                    line.clear();
                } else if line.len() < 8192 {
                    line.push(*byte);
                } else {
                    line.clear();
                }
            }
        }
    });
}
fn attach_output(
    child: &mut Child,
    state: &Arc<Mutex<State>>,
    generation: u64,
    process_generation: u64,
) {
    let Some(pid) = child.id() else { return };
    if let Some(stdout) = child.stdout.take() {
        observe_output(
            stdout,
            Arc::downgrade(state),
            generation,
            process_generation,
            pid,
        );
    }
    if let Some(stderr) = child.stderr.take() {
        observe_output(
            stderr,
            Arc::downgrade(state),
            generation,
            process_generation,
            pid,
        );
    }
}
struct Readiness {
    pid: Option<u32>,
    failures: u8,
    threshold: u8,
}
impl Default for Readiness {
    fn default() -> Self {
        Self {
            pid: None,
            failures: 0,
            threshold: 6,
        }
    }
}
impl Readiness {
    fn observe(&mut self, pid: u32, status: u16) -> bool {
        if self.pid != Some(pid) {
            self.pid = Some(pid);
            self.failures = 0;
        }
        match status {
            200 => {
                self.failures = 0;
                self.threshold = 6;
                false
            }
            503 => {
                self.failures = self.failures.saturating_add(1);
                if self.failures >= self.threshold {
                    self.failures = 0;
                    self.threshold = self.threshold.saturating_mul(2).min(60);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}
fn supervise_readiness(state: std::sync::Weak<Mutex<State>>, generation: u64, interval: Duration) {
    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            return;
        };
        let mut readiness = Readiness::default();
        loop {
            tokio::time::sleep(interval).await;
            let Some(shared) = state.upgrade() else { break };
            let (address, pid, process_generation) = {
                let guard = shared.lock().await;
                if guard.generation != generation {
                    break;
                }
                let Some(address) = guard.metrics else {
                    continue;
                };
                let Some(pid) = guard.child.as_ref().and_then(Child::id) else {
                    continue;
                };
                (address, pid, guard.process_generation)
            };
            drop(shared);
            let Ok(response) = client.get(format!("http://{address}/ready")).send().await else {
                continue;
            };
            if !readiness.observe(pid, response.status().as_u16()) {
                continue;
            }
            let Some(shared) = state.upgrade() else { break };
            let mut guard = shared.lock().await;
            if guard.generation == generation
                && guard.process_generation == process_generation
                && guard.child.as_ref().and_then(Child::id) == Some(pid)
            {
                if let Some(child) = guard.child.as_mut() {
                    let _ = child.start_kill();
                }
            }
        }
    });
}
impl Connector {
    pub(crate) async fn current_pid(&self) -> Option<u32> {
        let mut guard = self.state.lock().await;
        let child = guard.child.as_mut()?;
        if child.try_wait().ok()?.is_some() {
            return None;
        }
        child.id()
    }
    pub(crate) async fn metrics_address(&self) -> Option<std::net::SocketAddr> {
        self.state.lock().await.metrics
    }
    #[cfg(test)]
    pub(crate) async fn set_metrics_for_test(&self, address: std::net::SocketAddr) {
        self.state.lock().await.metrics = Some(address);
    }
    pub(crate) async fn protocol(&self) -> Option<String> {
        self.state.lock().await.protocol.clone()
    }
    async fn metrics_json(&self, path: &str) -> Option<serde_json::Value> {
        let address = self.metrics_address().await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?;
        let mut response = client
            .get(format!("http://{address}/{path}"))
            .send()
            .await
            .ok()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > 65536 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()
    }
    pub(crate) async fn ready_connections(&self) -> Option<u64> {
        self.metrics_json("ready").await?["readyConnections"].as_u64()
    }
    pub(crate) async fn hostname(&self) -> Option<String> {
        self.metrics_json("config").await?["config"]["ingress"]
            .as_array()?
            .iter()
            .find_map(|rule| {
                rule["hostname"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            })
    }
    pub(crate) async fn is_running(&self) -> Result<bool, String> {
        let mut guard = self.state.lock().await;
        match guard.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map(|status| status.is_none())
                .map_err(|_| "Could not inspect relay client".into()),
            None => Ok(false),
        }
    }
    pub(crate) async fn restore(
        &self,
        dir: &std::path::Path,
        address: std::net::SocketAddr,
    ) -> Result<bool, String> {
        match std::fs::read_to_string(dir.join("cloud-cli-desired-link.bin")) {
            Ok(value) if value == "publish_only" => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not read connector mode".into()),
        }
        let read = |name: &str| -> Result<Option<serde_json::Value>, String> {
            use std::io::Read as _;
            let file = match std::fs::File::open(dir.join(format!("{name}.bin"))) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("Could not read connector configuration".into()),
            };
            let mut bytes = Vec::new();
            file.take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Could not read connector configuration")?;
            if bytes.len() > 1024 * 1024 {
                return Err("Invalid stored connector configuration".into());
            }
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Invalid stored connector configuration".into())
        };
        let Some(config) = read("cloud-endpoint-runtime-config")? else {
            return Ok(false);
        };
        let Some(marker) = read("cloud-endpoint-confirmed-origin")? else {
            return Ok(false);
        };
        let origin = serde_json::json!({"localHttpHost":if address.is_ipv6(){"::1"}else{"127.0.0.1"},"localHttpPort":address.port()});
        if marker["config"] != config
            || marker["origin"] != origin
            || config["providerKind"] != "cloudflare_tunnel"
        {
            return Ok(false);
        }
        let token = config["connectorToken"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or("Invalid stored connector token")?;
        self.start(token, dir).await?;
        Ok(true)
    }
    pub(crate) async fn start(
        &self,
        token: &str,
        secrets: &std::path::Path,
    ) -> Result<u32, String> {
        if let Some(executable) =
            std::env::var_os("T3CODE_CLOUDFLARED_PATH").filter(|value| !value.is_empty())
        {
            return self.start_with(&executable, token, Some(secrets)).await;
        }
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        if let Some(base) = secrets.parent().and_then(std::path::Path::parent) {
            let executable = base
                .join("tools")
                .join("cloudflared")
                .join("2026.10.4")
                .join(format!("{platform}-{arch}"))
                .join(if cfg!(windows) {
                    "cloudflared.exe"
                } else {
                    "cloudflared"
                });
            if executable.is_file() {
                if let Ok(pid) = self
                    .start_with(&executable.into_os_string(), token, Some(secrets))
                    .await
                {
                    return Ok(pid);
                }
            }
        }
        self.start_with(&OsString::from("cloudflared"), token, Some(secrets))
            .await
    }
    async fn start_with(
        &self,
        executable: &OsString,
        token: &str,
        secrets: Option<&std::path::Path>,
    ) -> Result<u32, String> {
        if token.trim().is_empty() {
            return Err("Missing connector token".into());
        }
        use tokio::io::AsyncReadExt;
        let mut probe_command = Command::new(executable);
        probe_command.arg("version").stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let mut probe = spawn_with_retry(&mut probe_command).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound { "Relay client is not installed" } else { "Could not start relay client" }
        })?;
        let stdout = probe.stdout.take().ok_or("Relay client probe failed")?;
        let (status, bytes) = tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            stdout.take(4097).read_to_end(&mut bytes).await?;
            let status = probe.wait().await?;
            Ok::<_, std::io::Error>((status, bytes))
        })
        .await
        .map_err(|_| "Relay client probe timed out")?
        .map_err(|_| "Relay client probe failed")?;
        if bytes.len() > 4096 {
            return Err("Relay client probe output is too large".into());
        }
        let output = String::from_utf8_lossy(&bytes);
        let compatible = output
            .split_whitespace()
            .find_map(|word| {
                let mut parts = word.split('.');
                let a = parts.next()?.parse::<u32>().ok()?;
                let b = parts.next()?.parse::<u32>().ok()?;
                let c = parts.next()?.parse::<u32>().ok()?;
                Some((a, b, c) >= (2025, 6, 1))
            })
            .unwrap_or(false);
        if !status.success() || !compatible {
            return Err("Relay client is incompatible".into());
        }
        let mut guard = self.state.lock().await;
        guard.generation = guard.generation.wrapping_add(1);
        let generation = guard.generation;
        guard.transport_explicit = std::env::var_os("TUNNEL_TRANSPORT_PROTOCOL").is_some();
        guard.secrets = secrets.map(std::path::Path::to_path_buf);
        guard.http2 = !guard.transport_explicit
            && secrets.is_some_and(|dir| {
                use std::io::Read as _;
                let Ok(file) = std::fs::File::open(dir.join("cloud-endpoint-http2-fallback.bin"))
                else {
                    return false;
                };
                let mut data = Vec::new();
                if file.take(4097).read_to_end(&mut data).is_err() {
                    return false;
                }
                if data.len() > 4096 {
                    return false;
                }
                let Some(at) = serde_json::from_slice::<serde_json::Value>(&data)
                    .ok()
                    .and_then(|value| value["fellBackAt"].as_u64())
                else {
                    return false;
                };
                let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                else {
                    return false;
                };
                let now = now.as_millis();
                now >= u128::from(at) && now - u128::from(at) < 86_400_000
            });
        guard.quic_stalls.clear();
        if let Some(mut previous) = guard.child.take() {
            let _ = previous.kill().await;
            let _ = previous.wait().await;
        }
        guard.metrics = None;
        guard.protocol = None;
        guard.process_generation = guard.process_generation.wrapping_add(1);
        let process_generation = guard.process_generation;
        let mut child = spawn(executable, token, guard.http2).await?;
        let pid = child.id().ok_or("Relay client has no process ID")?;
        attach_output(&mut child, &self.state, generation, process_generation);
        guard.child = Some(child);
        let weak = Arc::downgrade(&self.state);
        supervise_readiness(weak.clone(), generation, Duration::from_secs(30));
        let executable = executable.clone();
        let token = token.to_owned();
        tokio::spawn(async move {
            let mut backoff = Duration::ZERO;
            let mut running_since = tokio::time::Instant::now();
            let mut retry_at = None;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(state) = weak.upgrade() else { break };
                let mut guard = state.lock().await;
                if guard.generation != generation {
                    break;
                }
                let dead = guard
                    .child
                    .as_mut()
                    .is_none_or(|child| !matches!(child.try_wait(), Ok(None)));
                if dead {
                    let now = tokio::time::Instant::now();
                    let due = *retry_at.get_or_insert_with(|| {
                        if now.duration_since(running_since) >= Duration::from_secs(30) {
                            backoff = Duration::ZERO;
                        }
                        let due = now + backoff;
                        backoff = if backoff.is_zero() {
                            Duration::from_secs(1)
                        } else {
                            (backoff * 2).min(Duration::from_secs(60))
                        };
                        due
                    });
                    if now >= due {
                        guard.metrics = None;
                        guard.protocol = None;
                        guard.process_generation = guard.process_generation.wrapping_add(1);
                        let process_generation = guard.process_generation;
                        guard.child = spawn(&executable, &token, guard.http2).await.ok();
                        if let Some(child) = guard.child.as_mut() {
                            attach_output(child, &state, generation, process_generation);
                        }
                        if guard.child.is_some() {
                            running_since = now;
                            retry_at = None;
                        } else {
                            retry_at = Some(now + backoff);
                            backoff = (backoff * 2).min(Duration::from_secs(60));
                        }
                    }
                }
            }
        });
        Ok(pid)
    }
    pub(crate) async fn stop(&self) -> Result<(), String> {
        let mut guard = self.state.lock().await;
        guard.generation = guard.generation.wrapping_add(1);
        guard.metrics = None;
        guard.protocol = None;
        if let Some(mut child) = guard.child.take() {
            if child
                .try_wait()
                .map_err(|_| "Could not inspect relay client")?
                .is_none()
            {
                child
                    .kill()
                    .await
                    .map_err(|_| "Could not stop relay client")?;
            }
            child
                .wait()
                .await
                .map_err(|_| "Could not wait for relay client")?;
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn retry_after_is_bounded_and_rejects_invalid_values() {
        assert_eq!(parse_retry_after("1"), Some(Duration::from_secs(1)));
        assert_eq!(parse_retry_after("999999"), Some(Duration::from_secs(900)));
        assert_eq!(parse_retry_after("0"), None);
        assert_eq!(parse_retry_after("not-a-date"), None);
        let date = (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc2822();
        assert!(parse_retry_after(&date).is_some_and(
            |delay| delay >= Duration::from_secs(58) && delay <= Duration::from_secs(60)
        ));
    }
    #[test]
    fn readiness_restarts_after_explicit_failures_and_backs_off() {
        let mut checks = Readiness::default();
        for _ in 0..5 {
            assert!(!checks.observe(1, 503));
        }
        assert!(!checks.observe(1, 500));
        assert!(checks.observe(1, 503));
        for _ in 0..11 {
            assert!(!checks.observe(2, 503));
        }
        assert!(checks.observe(2, 503));
        assert!(!checks.observe(3, 200));
        for _ in 0..5 {
            assert!(!checks.observe(3, 503));
        }
        assert!(checks.observe(3, 503));
    }
    #[tokio::test]
    async fn owns_and_stops_fake_connector() {
        let dir = std::env::temp_dir().join(format!("t3-fake-relay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(&exe,"#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\necho 'Starting metrics server on 127.0.0.1:41337/metrics' >&2\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let connector = Connector::default();
        let pid = connector
            .start_with(&exe.into_os_string(), "test-token", None)
            .await
            .unwrap();
        assert!(unsafe { libc::kill(pid as i32, 0) } == 0);
        for _ in 0..100 {
            if connector.metrics_address().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            connector.metrics_address().await,
            Some("127.0.0.1:41337".parse().unwrap())
        );
        connector.stop().await.unwrap();
        assert!(connector.metrics_address().await.is_none());
        assert!(unsafe { libc::kill(pid as i32, 0) } != 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn crashed_connector_restarts_but_stop_cancels_supervision() {
        let dir =
            std::env::temp_dir().join(format!("t3-fake-relay-crash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(&exe,"#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let connector = Connector::default();
        let first = connector
            .start_with(&exe.into_os_string(), "fixture-token", None)
            .await
            .unwrap();
        assert_eq!(unsafe { libc::kill(first as i32, libc::SIGKILL) }, 0);
        let mut replacement = None;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let guard = connector.state.lock().await;
            if let Some(pid) = guard.child.as_ref().and_then(Child::id) {
                if pid != first {
                    replacement = Some(pid);
                    break;
                }
            }
        }
        let replacement = replacement.expect("connector restarted");
        connector.stop().await.unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(connector.state.lock().await.child.is_none());
        assert_ne!(unsafe { libc::kill(replacement as i32, 0) }, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn stale_process_output_cannot_modify_replacement() {
        use tokio::io::AsyncWriteExt;
        let dir =
            std::env::temp_dir().join(format!("t3-relay-old-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(&exe,"#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let connector = Connector::default();
        let pid = connector
            .start_with(&exe.into_os_string(), "fixture-token", None)
            .await
            .unwrap();
        let mut guard = connector.state.lock().await;
        let generation = guard.generation;
        let old_process = guard.process_generation;
        guard.process_generation = guard.process_generation.wrapping_add(1);
        drop(guard);
        let (mut writer, reader) = tokio::io::duplex(4096);
        observe_output(
            reader,
            Arc::downgrade(&connector.state),
            generation,
            old_process,
            pid,
        );
        writer.write_all(b"Starting metrics server on 127.0.0.1:41337/metrics\nINF Registered tunnel connection protocol=http2\n").await.unwrap();
        drop(writer);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let guard = connector.state.lock().await;
        assert!(guard.metrics.is_none());
        assert!(!guard.http2);
        drop(guard);
        connector.stop().await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn version_probe_retries_temporarily_busy_executable() {
        let dir = std::env::temp_dir().join(format!("relay-busy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(&exe, "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let writer = std::fs::OpenOptions::new().write(true).open(&exe).unwrap();
        assert_eq!(std::process::Command::new(&exe).arg("version").spawn().unwrap_err().raw_os_error(),Some(libc::ETXTBSY));
        let release = tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(80)).await; drop(writer); });
        let connector = Connector::default();
        connector.start_with(&exe.into_os_string(), "token", None).await.unwrap();
        release.await.unwrap(); connector.stop().await.unwrap(); std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn quic_stalls_switch_owned_process_to_http2() {
        let dir =
            std::env::temp_dir().join(format!("t3-fake-relay-http2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        let marker = dir.join("http2-started");
        let script=format!("#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\ncase \" $* \" in *' --protocol http2 '*) echo yes > '{}'; exec sleep 60;; esac\ni=0; while [ $i -lt 30 ]; do echo 'WRN timeout: no recent network activity' >&2; i=$((i+1)); done\nexec sleep 60\n",marker.display());
        std::fs::write(&exe, script).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let connector = Connector::default();
        connector
            .start_with(&exe.into_os_string(), "fixture-token", Some(&dir))
            .await
            .unwrap();
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(marker.exists());
        assert!(dir.join("cloud-endpoint-http2-fallback.bin").exists());
        connector.stop().await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn restore_requires_matching_confirmed_origin_and_managed_mode() {
        let dir = std::env::temp_dir().join(format!("t3-relay-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config =
            serde_json::json!({"providerKind":"cloudflare_tunnel","connectorToken":"private"});
        std::fs::write(
            dir.join("cloud-endpoint-runtime-config.bin"),
            config.to_string(),
        )
        .unwrap();
        let marker = serde_json::json!({"config":config,"origin":{"localHttpHost":"127.0.0.1","localHttpPort":3000}});
        std::fs::write(
            dir.join("cloud-endpoint-confirmed-origin.bin"),
            marker.to_string(),
        )
        .unwrap();
        let connector = Connector::default();
        assert!(!connector
            .restore(&dir, "127.0.0.1:3001".parse().unwrap())
            .await
            .unwrap());
        std::fs::write(dir.join("cloud-cli-desired-link.bin"), "publish_only").unwrap();
        assert!(!connector
            .restore(&dir, "127.0.0.1:3000".parse().unwrap())
            .await
            .unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn reads_bounded_loopback_readiness_metrics() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 1024];
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(String::from_utf8_lossy(&buffer[..n]).starts_with("GET /ready "));
            stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{\"readyConnections\":0}").await.unwrap();
        });
        let connector = Connector::default();
        connector.state.lock().await.metrics = Some(address);
        assert_eq!(connector.ready_connections().await, Some(0));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn repeated_not_ready_restarts_connector_and_stop_cancels_watchdog() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = std::env::temp_dir().join(format!("t3-relay-watchdog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(&exe,"#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit; fi\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut bytes = [0; 1024];
                let _ = stream.read(&mut bytes).await;
                let _=stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        });
        let connector = Connector::default();
        let first = connector
            .start_with(&exe.into_os_string(), "fixture-token", None)
            .await
            .unwrap();
        let mut state = connector.state.lock().await;
        state.metrics = Some(address);
        let generation = state.generation;
        drop(state);
        supervise_readiness(
            Arc::downgrade(&connector.state),
            generation,
            Duration::from_millis(20),
        );
        let mut replacement = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let state = connector.state.lock().await;
            if let Some(pid) = state.child.as_ref().and_then(Child::id) {
                if pid != first {
                    replacement = Some(pid);
                    break;
                }
            }
        }
        let replacement = replacement.expect("watchdog restarted connector");
        connector.stop().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(connector.state.lock().await.child.is_none());
        assert_ne!(unsafe { libc::kill(replacement as i32, 0) }, 0);
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn registers_signed_origin_with_fake_relay() {
        use base64::Engine as _;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir =
            std::env::temp_dir().join(format!("t3-relay-registration-{}", uuid::Uuid::new_v4()));
        let key = crate::cloud_link_key::load_or_create(&dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut part = [0; 4096];
            loop {
                let n = stream.read(&mut part).await.unwrap();
                assert_ne!(n, 0);
                data.extend_from_slice(&part[..n]);
                if let Some(split) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..split]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse::<usize>().ok())
                        })
                        .unwrap();
                    if data.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            let split = data
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap();
            let headers = String::from_utf8_lossy(&data[..split]);
            assert!(headers.starts_with("POST /v1/environments/env-id/tunnel/recovery "));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture-credential"));
            let body: serde_json::Value = serde_json::from_slice(&data[split + 4..]).unwrap();
            assert_eq!(body["tunnelId"], "tunnel-id");
            let proof = body["proof"].as_str().unwrap();
            let parts: Vec<_> = proof.split('.').collect();
            let claims: serde_json::Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(parts[1])
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(claims["action"], "register");
            assert_eq!(claims["origin"]["localHttpPort"], 3000);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"status\":\"ready\"}").await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let relay = format!("http://{addr}");
        assert_eq!(
            register(
                &client,
                &relay,
                "https://issuer.invalid",
                "fixture-credential",
                "user-id",
                "env-id",
                "tunnel-id",
                &serde_json::json!({"localHttpHost":"127.0.0.1","localHttpPort":3000}),
                &key
            )
            .await
            .unwrap(),
            Registration::Ready
        );
        server.await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn rejected_registration_is_distinguished_from_ready() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = std::env::temp_dir().join(format!("t3-relay-denied-{}", uuid::Uuid::new_v4()));
        let key = crate::cloud_link_key::load_or_create(&dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes).await.unwrap();
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let result = register(
            &client,
            &format!("http://{address}"),
            "https://issuer.invalid",
            "credential",
            "user",
            "env",
            "tunnel",
            &serde_json::json!({"localHttpHost":"127.0.0.1","localHttpPort":3000}),
            &key,
        )
        .await
        .unwrap();
        assert_eq!(result, Registration::Unauthorized);
        server.await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Registration {
    Ready,
    RecoveryRequired,
    Unauthorized,
    Rejected(u16, Option<String>),
    Unavailable(u16, Option<String>, Option<Duration>),
}
pub(crate) fn relay_client() -> Option<reqwest::Client> {
    use std::io::Read as _;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 1024 * 1024 {
            return None;
        }
        for certificate in reqwest::Certificate::from_pem_bundle(&bytes).ok()? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().ok()
}
fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    let millis = if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        value.parse::<u64>().ok()?.saturating_mul(1000)
    } else {
        let target = chrono::DateTime::parse_from_rfc2822(value)
            .ok()?
            .timestamp_millis();
        let now = chrono::Utc::now().timestamp_millis();
        u64::try_from(target.checked_sub(now)?).ok()?
    };
    (millis > 0).then(|| Duration::from_millis(millis.min(900_000)))
}
fn structured_relay_description(data: &serde_json::Value) -> Option<String> {
    let trace = data["traceId"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())?;
    let (message, hint) = match data["_tag"].as_str()? {
        "RelayEnvironmentConnectNotAuthorizedError"
            if data["code"] == "environment_connect_not_authorized" =>
        {
            let reason = data.get("reason").and_then(serde_json::Value::as_str);
            if reason.is_some_and(|value| {
                !matches!(
                    value,
                    "client_proof_key_thumbprint_missing"
                        | "environment_link_not_found"
                        | "endpoint_provider_not_managed"
                        | "managed_endpoint_allocation_not_found"
                        | "managed_endpoint_base_domain_not_configured"
                        | "managed_endpoint_allocation_not_ready"
                        | "managed_endpoint_hostname_invalid"
                        | "managed_endpoint_mismatch"
                )
            }) {
                return None;
            }
            (reason.map_or_else(||"Relay environment connection is not authorized".to_owned(),|value|format!("Relay environment connection is not authorized: {value}")),"Retry when the relay is available. If this continues, include the trace ID when reporting it.")
        }
        "RelayEnvironmentLinkProofInvalidError"
            if data["code"] == "environment_link_proof_invalid" =>
        {
            let reason = data["reason"].as_str()?;
            if !matches!(
                reason,
                "invalid_signature_or_scope"
                    | "descriptor_mismatch"
                    | "replayed_nonce"
                    | "challenge_invalid"
                    | "origin_not_allowed"
                    | "endpoint_not_secure"
            ) {
                return None;
            }
            (
                format!("Relay environment link proof is invalid: {reason}"),
                "Check this machine's date and time, update T3 Code, then restart it.",
            )
        }
        "RelayEnvironmentLinkLimitExceededError" if data["code"]=="environment_link_limit_exceeded"=>{
            let maximum=data["maxTunnels"].as_f64()?;
            if !maximum.is_finite(){return None;}
            (format!("Relay managed tunnel limit reached: this account allows at most {maximum} tunnels"),"Unlink an unused environment in T3 Connect, then restart T3 Code on this machine.")
        }
        "RelayEnvironmentLinkProofExpiredError" if data["code"]=="environment_link_proof_expired"=>("Relay environment link proof expired".to_owned(),"Check this machine's date and time, update T3 Code, then restart it."),
        "RelayEnvironmentEndpointTimedOutError" if data["code"]=="environment_endpoint_timed_out"=>("Relay environment endpoint request timed out".to_owned(),"Retry when the relay is available. If this continues, include the trace ID when reporting it."),
        "RelayInternalError" if data["code"]=="internal_error"=>{
            let reason=data["reason"].as_str()?;
            if !matches!(reason,"database_unavailable"|"persistence_failed"|"upstream_unavailable"|"internal_error"){return None;}
            (format!("Relay internal error: {reason}"),"Retry when the relay is available. If this continues, include the trace ID when reporting it.")
        }
        "RelayEnvironmentLinkFailedError" if data["code"]=="environment_link_failed"=>{
            let reason=data["reason"].as_str()?;
            if !matches!(reason,"link_persistence_failed"|"credential_persistence_failed"|"replay_persistence_failed"|"internal_error"){return None;}
            (format!("Relay environment link failed: {reason}"),"Retry when the relay is available. If this continues, include the trace ID when reporting it.")
        }
        "RelayEnvironmentLinkUnavailableError" if data["code"]=="environment_link_unavailable"=>{
            let reason=data["reason"].as_str()?;
            if !matches!(reason,"managed_endpoint_not_configured"|"managed_endpoint_provisioning_failed") || data.get("provisioningStage").is_some_and(|value|value.as_str().is_none_or(|value|value.trim().is_empty())){return None;}
            (format!("Relay environment link is unavailable: {reason}"),"Retry when the relay is available. If this continues, include the trace ID when reporting it.")
        }
        "RelayEnvironmentEndpointUnavailableError" if data["code"]=="environment_endpoint_unavailable"=>{
            let reason=data["reason"].as_str()?;
            if !matches!(reason,"endpoint_request_failed"|"endpoint_response_invalid") || data.get("endpointStatus").is_some_and(|value|!value.is_number()) || data.get("endpointFailure").is_some_and(|value|!matches!(value.as_str(),Some("tunnel_down"|"origin_unreachable"|"dns"|"tls"|"refused"|"timeout"|"invalid_response"|"unknown"))){return None;}
            (format!("Relay environment endpoint is unavailable: {reason}"),"Retry when the relay is available. If this continues, include the trace ID when reporting it.")
        }
        _ => return None,
    };
    Some(format!("T3 Connect: {message}. {hint} Trace ID: {trace}."))
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn register(
    client: &reqwest::Client,
    relay: &str,
    issuer: &str,
    credential: &str,
    user: &str,
    environment: &str,
    tunnel: &str,
    origin: &serde_json::Value,
    key: &crate::cloud_link_key::CloudLinkKey,
) -> Result<Registration, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_secs();
    let proof=key.sign_typed("t3-env-managed-tunnel-recovery+jwt",&serde_json::json!({"iss":format!("t3-env:{environment}"),"aud":issuer.trim().trim_end_matches('/'),"sub":environment,"jti":uuid::Uuid::new_v4().to_string(),"iat":now,"exp":now+60,"environmentId":environment,"cloudUserId":user,"action":"register","tunnelId":tunnel,"origin":origin})).map_err(|_|"Could not sign registration")?;
    let mut url = url::Url::parse(relay.trim()).map_err(|_| "Invalid relay URL")?;
    url.path_segments_mut()
        .map_err(|_| "Invalid relay URL")?
        .clear()
        .extend(["v1", "environments", environment, "tunnel", "recovery"]);
    let body = serde_json::to_vec(
        &serde_json::json!({"cloudUserId":user,"tunnelId":tunnel,"origin":origin,"proof":proof}),
    )
    .map_err(|_| "Could not encode registration")?;
    let mut response = client
        .post(url)
        .bearer_auth(credential)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "Relay registration failed")?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    let ray = response
        .headers()
        .get("cf-ray")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .map(str::to_owned);
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay registration failed")?
    {
        if body.len().saturating_add(chunk.len()) > 64 * 1024 {
            return Err("Invalid relay registration response".into());
        }
        body.extend_from_slice(&chunk);
    }
    let data: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let expired = data["_tag"] == "RelayEnvironmentLinkProofExpiredError"
        && data["code"] == "environment_link_proof_expired"
        && data["traceId"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
    if status == reqwest::StatusCode::UNAUTHORIZED && !expired {
        return Ok(Registration::Unauthorized);
    }
    if !status.is_success() {
        let code = status.as_u16();
        let description = structured_relay_description(&data).or_else(||ray.map(|ray|format!("T3 Connect relay returned HTTP {code} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart T3 Code. Cloudflare Ray ID: {ray}.")));
        return if status.is_client_error() && !matches!(code, 401 | 408 | 429) {
            Ok(Registration::Rejected(code, description))
        } else {
            Ok(Registration::Unavailable(code, description, retry_after))
        };
    }
    match data["status"].as_str() {
        Some("ready") => Ok(Registration::Ready),
        Some("recovery_required") => Ok(Registration::RecoveryRequired),
        _ => Err("Invalid relay registration response".into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn recover_runtime(
    client: &reqwest::Client,
    relay: &str,
    issuer: &str,
    credential: &str,
    user: &str,
    environment: &str,
    origin: &serde_json::Value,
    key: &crate::cloud_link_key::CloudLinkKey,
) -> Result<serde_json::Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_secs();
    let proof = key.sign_typed("t3-env-managed-tunnel-recovery+jwt", &serde_json::json!({"iss":format!("t3-env:{environment}"),"aud":issuer.trim().trim_end_matches('/'),"sub":environment,"jti":uuid::Uuid::new_v4().to_string(),"iat":now,"exp":now+60,"environmentId":environment,"cloudUserId":user,"action":"recover","origin":origin})).map_err(|_| "Could not sign recovery")?;
    let mut url = url::Url::parse(relay).map_err(|_| "Invalid relay URL")?;
    url.path_segments_mut()
        .map_err(|_| "Invalid relay URL")?
        .clear()
        .extend(["v1", "environments", environment, "tunnel"]);
    let body =
        serde_json::to_vec(&serde_json::json!({"cloudUserId":user,"origin":origin,"proof":proof}))
            .map_err(|_| "Invalid recovery")?;
    let mut response = client
        .post(url)
        .bearer_auth(credential)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "Recovery failed")?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Recovery failed")? {
        if body.len().saturating_add(chunk.len()) > 64 * 1024 {
            return Err("Invalid recovery".into());
        }
        body.extend_from_slice(&chunk);
    }
    let data: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED
        && !(data["_tag"] == "RelayEnvironmentLinkProofExpiredError"
            && data["code"] == "environment_link_proof_expired"
            && data["traceId"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty()))
    {
        return Err("unauthorized".into());
    }
    if !status.is_success() {
        if status.is_server_error() || matches!(status.as_u16(), 408 | 429) {
            return Err(format!(
                "retry:{}",
                retry_after.unwrap_or_default().as_millis()
            ));
        }
        return Err("Recovery rejected".into());
    }
    let nonempty = |value: &serde_json::Value| value.as_str().is_some_and(|s| !s.trim().is_empty());
    let endpoint = &data["endpoint"];
    if !nonempty(&endpoint["httpBaseUrl"])
        || !nonempty(&endpoint["wsBaseUrl"])
        || !matches!(
            endpoint["providerKind"].as_str(),
            Some("manual" | "cloudflare_tunnel" | "t3_relay")
        )
    {
        return Err("Invalid recovery".into());
    }
    let runtime = &data["endpointRuntime"];
    if runtime["providerKind"] != "cloudflare_tunnel"
        || !nonempty(&runtime["connectorToken"])
        || ["tunnelId", "tunnelName"]
            .iter()
            .any(|name| runtime.get(*name).is_some_and(|value| !nonempty(value)))
    {
        return Err("Invalid recovery".into());
    }
    let mut normalized = serde_json::json!({"providerKind":"cloudflare_tunnel","connectorToken":runtime["connectorToken"].as_str().unwrap_or("").trim()});
    for name in ["tunnelId", "tunnelName"] {
        if let Some(value) = runtime[name].as_str() {
            normalized[name] = serde_json::json!(value.trim());
        }
    }
    Ok(normalized)
}

/// Restore an owned confirmed tunnel, then re-register without holding the
/// mutation lock across relay requests. Stale replies never activate a tunnel.
pub(crate) async fn restore_and_register(
    weak: std::sync::Weak<crate::auth_http::AuthHttpState>,
    address: std::net::SocketAddr,
) {
    let Some(state) = weak.upgrade() else { return };
    let action = state.cloud_action_lock.lock().await;
    let restored = state
        .cloud_connector
        .restore(&state.replay_dir, address)
        .await
        .unwrap_or(false);
    let snapshot = match crate::cloud_link_config::stored_registration(&state.replay_dir) {
        Ok(Some(snapshot)) => snapshot,
        _ => return,
    };
    let generation = state
        .cloud_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let Some(descriptor) = state.environment_descriptor.get() else {
        return;
    };
    let Some(environment) = descriptor["environmentId"].as_str().map(str::to_owned) else {
        return;
    };
    let key = match crate::cloud_link_key::load_or_create(&state.replay_dir) {
        Ok(key) => key,
        Err(_) => return,
    };
    drop(action);
    drop(state);
    let Some(client) = relay_client() else { return };
    if !restored {
        let mut random = [0u8; 2];
        let _ = getrandom::fill(&mut random);
        tokio::time::sleep(Duration::from_millis(
            u64::from(u16::from_le_bytes(random)) % 30_001,
        ))
        .await;
    }
    let origin = serde_json::json!({"localHttpHost":if address.is_ipv6(){"::1"}else{"127.0.0.1"},"localHttpPort":address.port()});
    let mut backoff = Duration::from_secs(1);
    let retry_started = tokio::time::Instant::now();
    let mut window_exhausted = false;
    let mut recovering = false;
    loop {
        let Some(state) = weak.upgrade() else { return };
        let action = state.cloud_action_lock.lock().await;
        if state
            .cloud_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || !matches!(crate::cloud_link_config::stored_registration(&state.replay_dir),Ok(Some(ref value)) if *value==snapshot)
        {
            return;
        }
        drop(action);
        drop(state);
        let relay = snapshot["relayUrl"].as_str().unwrap_or("");
        let issuer = snapshot["relayIssuer"].as_str().unwrap_or(relay);
        let outcome = if recovering
            || snapshot["endpointRuntime"]["tunnelId"]
                .as_str()
                .is_none_or(str::is_empty)
        {
            Ok(Registration::RecoveryRequired)
        } else {
            register(
                &client,
                relay,
                issuer,
                snapshot["environmentCredential"].as_str().unwrap_or(""),
                snapshot["cloudUserId"].as_str().unwrap_or(""),
                &environment,
                snapshot["endpointRuntime"]["tunnelId"]
                    .as_str()
                    .unwrap_or(""),
                &origin,
                &key,
            )
            .await
        };
        let recovered = if matches!(outcome, Ok(Registration::RecoveryRequired)) {
            recover_runtime(
                &client,
                relay,
                issuer,
                snapshot["environmentCredential"].as_str().unwrap_or(""),
                snapshot["cloudUserId"].as_str().unwrap_or(""),
                &environment,
                &origin,
                &key,
            )
            .await
        } else {
            Err("No recovery".into())
        };
        let Some(state) = weak.upgrade() else { return };
        let action = state.cloud_action_lock.lock().await;
        if state
            .cloud_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || !matches!(crate::cloud_link_config::stored_registration(&state.replay_dir),Ok(Some(ref value)) if *value==snapshot)
        {
            return;
        }
        let retry_after = match outcome {
            Ok(Registration::Ready) => {
                if state.cloud_connector.current_pid().await.is_none() {
                    drop(action);
                    drop(state);
                    activate_recovered(&weak, generation, &snapshot, &origin).await;
                    return;
                }
                let _ = crate::cloud_link_config::confirm_origin(
                    &state.replay_dir,
                    &snapshot["endpointRuntime"],
                    &origin,
                );
                return;
            }
            Ok(Registration::Unauthorized) => {
                let _ = crate::cloud_link_config::mark_revoked(&state.replay_dir);
                return;
            }
            Ok(Registration::RecoveryRequired) => {
                let runtime = match recovered {
                    Ok(runtime) => runtime,
                    Err(error) if error == "unauthorized" => {
                        let _ = crate::cloud_link_config::mark_revoked(&state.replay_dir);
                        return;
                    }
                    Err(error) if error == "Recovery failed" || error.starts_with("retry:") => {
                        let delay = error
                            .strip_prefix("retry:")
                            .and_then(|value| value.parse::<u64>().ok())
                            .map(Duration::from_millis)
                            .unwrap_or_default()
                            .max(Duration::from_secs(120));
                        recovering = true;
                        drop(action);
                        drop(state);
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    Err(_) => return,
                };
                if crate::cloud_link_config::replace_recovered_runtime(&state.replay_dir, &runtime)
                    .is_err()
                {
                    return;
                }
                if state.cloud_connector.stop().await.is_err() {
                    return;
                }
                let mut expected = snapshot.clone();
                expected["endpointRuntime"] = runtime.clone();
                drop(action);
                drop(state);
                activate_recovered(&weak, generation, &expected, &origin).await;
                return;
            }
            Ok(Registration::Rejected(..)) => return,
            Ok(Registration::Unavailable(_, _, delay)) => delay,
            Err(_) => None,
        };
        let mut random = [0u8; 2];
        let _ = getrandom::fill(&mut random);
        let jitter = 800 + u64::from(u16::from_le_bytes(random)) % 401;
        let delay = Duration::from_millis(
            (backoff.as_millis().saturating_mul(u128::from(jitter)) / 1000).min(300_000) as u64,
        )
        .max(retry_after.unwrap_or(Duration::ZERO));
        if !window_exhausted
            && retry_started.elapsed().saturating_add(delay) >= Duration::from_secs(600)
        {
            window_exhausted = true;
            if !restored && state.cloud_connector.current_pid().await.is_none() {
                let _ = state
                    .cloud_connector
                    .start(
                        snapshot["endpointRuntime"]["connectorToken"]
                            .as_str()
                            .unwrap_or(""),
                        &state.replay_dir,
                    )
                    .await;
            }
        }
        drop(action);
        drop(state);
        tokio::time::sleep(delay).await;
        backoff = (backoff * 2).min(Duration::from_secs(300));
    }
}

async fn activate_recovered(
    weak: &std::sync::Weak<crate::auth_http::AuthHttpState>,
    generation: u64,
    expected: &serde_json::Value,
    origin: &serde_json::Value,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let Some(state) = weak.upgrade() else { return };
        let action = state.cloud_action_lock.lock().await;
        if state
            .cloud_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || !matches!(crate::cloud_link_config::stored_registration(&state.replay_dir), Ok(Some(ref value)) if value == expected)
        {
            return;
        }
        match state
            .cloud_connector
            .start(
                expected["endpointRuntime"]["connectorToken"]
                    .as_str()
                    .unwrap_or(""),
                &state.replay_dir,
            )
            .await
        {
            Ok(_) => {
                let _ = crate::cloud_link_config::confirm_origin(
                    &state.replay_dir,
                    &expected["endpointRuntime"],
                    origin,
                );
                return;
            }
            Err(error)
                if matches!(
                    error.as_str(),
                    "Relay client is not installed" | "Could not start relay client"
                ) => {}
            Err(_) => return,
        }
        drop(action);
        drop(state);
        let mut random = [0u8; 2];
        let _ = getrandom::fill(&mut random);
        let jitter = 800 + u64::from(u16::from_le_bytes(random)) % 401;
        tokio::time::sleep(Duration::from_millis(
            (backoff.as_millis() * u128::from(jitter) / 1000) as u64,
        ))
        .await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}
