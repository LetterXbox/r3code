//! Client activity leases used to schedule background work.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default)]
pub struct DesktopElectronProcess {
    pub pid: u32,
    pub creation_time_ms: u64,
    pub kind: String,
    pub name: Option<String>,
    pub service_name: Option<String>,
    pub cpu_percent: f64,
    pub cumulative_cpu_seconds: Option<f64>,
    pub resident_bytes: u64,
    pub idle_wakeups_per_second: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct DesktopTelemetrySnapshot {
    pub descriptor_configured: bool,
    pub stream_closed: bool,
    pub last_sample_at: Option<String>,
    pub last_received_unix_ms: Option<i64>,
    pub last_error: Option<String>,
    pub electron_pid: Option<u32>,
    pub electron_processes: Vec<DesktopElectronProcess>,
    pub speed_limit_percent: Option<f64>,
    pub power: Option<(i64, i64, Value)>,
}

#[derive(Default)]
pub struct ClientActivity {
    leases: Mutex<HashMap<(String, String), (Instant, Value)>>,
    scheduler_started: std::sync::atomic::AtomicBool,
    host_power: Mutex<Option<(i64, i64, Value)>>,
    desktop_telemetry: Mutex<DesktopTelemetrySnapshot>,
}
impl ClientActivity {
    fn ingest_desktop_telemetry(
        &self,
        line: &[u8],
        registry: Option<&crate::provider::session_registry::SessionRegistry>,
    ) -> bool {
        let Ok(message) = serde_json::from_slice::<Value>(line) else {
            return false;
        };
        if message["version"] != 1 {
            return false;
        }
        match message["type"].as_str() {
            Some("shellEnvironment") => {
                let Some(platform) = message["platform"].as_str() else {
                    return false;
                };
                let Some(values) = message["environment"].as_object() else {
                    return false;
                };
                if !message["discovered"].is_boolean() {
                    return false;
                }
                let native = if cfg!(target_os = "macos") {
                    "darwin"
                } else if cfg!(windows) {
                    "win32"
                } else {
                    std::env::consts::OS
                };
                let allowed = [
                    "PATH",
                    "DBUS_SESSION_BUS_ADDRESS",
                    "DISPLAY",
                    "LANG",
                    "LC_ALL",
                    "LC_CTYPE",
                    "SSH_AUTH_SOCK",
                    "HOMEBREW_PREFIX",
                    "HOMEBREW_CELLAR",
                    "HOMEBREW_REPOSITORY",
                    "XDG_CONFIG_HOME",
                    "XDG_CURRENT_DESKTOP",
                    "XDG_DATA_HOME",
                    "XDG_RUNTIME_DIR",
                    "XDG_SESSION_DESKTOP",
                    "XDG_SESSION_TYPE",
                    "WAYLAND_DISPLAY",
                    "SSL_CERT_FILE",
                    "SSL_CERT_DIR",
                    "NODE_EXTRA_CA_CERTS",
                    "T3CODE_TELEMETRY_ENABLED",
                    "T3CODE_GITHUB_APP_CLIENT_ID",
                    "__MISE_DIFF",
                    "JAVA_HOME",
                    "FNM_DIR",
                    "FNM_MULTISHELL_PATH",
                ];
                if values.iter().any(|(key, value)| {
                    allowed.contains(&key.as_str()) && !value.is_null() && !value.is_string()
                }) {
                    return false;
                }
                if platform == native {
                    if let Some(registry) = registry {
                        if let Ok(mut current) = registry.desktop_shell_env.lock() {
                            for (key, value) in values {
                                if allowed.contains(&key.as_str()) {
                                    current.insert(key.clone(), value.as_str().map(str::to_owned));
                                }
                            }
                        }
                    }
                }
                return true;
            }
            Some("desktopTelemetryHello" | "desktopUpdateStatus") => return true,
            Some("desktopTelemetry") => {}
            _ => return false,
        }
        let power = &message["power"];
        let bool_states = ["idle", "locked", "onBattery", "lowPowerMode"];
        if message["sequence"].as_u64().is_none()
            || message["electronPid"].as_u64().is_none_or(|pid| pid == 0)
            || !message["electronProcesses"].is_array()
            || !power["stale"].is_boolean()
            || !power["suspended"].is_boolean()
            || !bool_states
                .iter()
                .all(|key| matches!(power[*key].as_str(), Some("true" | "false" | "unknown")))
            || !matches!(
                power["thermalState"].as_str(),
                Some("unknown" | "nominal" | "fair" | "serious" | "critical")
            )
            || !matches!(
                power["source"].as_str(),
                Some(
                    "unknown"
                        | "node-macos-shell"
                        | "node-macos-native"
                        | "node-linux"
                        | "node-windows"
                        | "electron-main"
                )
            )
        {
            return false;
        }
        let Some(sampled_at) = message["sampledAtUnixMs"].as_i64().filter(|v| *v >= 0) else {
            return false;
        };
        let Some(updated_at) = power["updatedAt"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
        else {
            return false;
        };
        if let Ok(mut latest) = self.host_power.lock() {
            if latest
                .as_ref()
                .is_none_or(|(_, previous, _)| updated_at >= *previous)
            {
                *latest = Some((sampled_at, updated_at, power.clone()));
            }
        }
        if let Ok(mut snapshot) = self.desktop_telemetry.lock() {
            let received_ms = chrono::Utc::now().timestamp_millis();
            snapshot.last_received_unix_ms = Some(received_ms);
            snapshot.last_sample_at = chrono::DateTime::from_timestamp_millis(sampled_at)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            snapshot.last_error = None;
            snapshot.electron_pid = message["electronPid"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok());
            snapshot.speed_limit_percent = message["speedLimitPercent"].as_f64();
            snapshot.electron_processes = message["electronProcesses"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let pid = item["pid"].as_u64().and_then(|v| u32::try_from(v).ok())?;
                            let creation_time_ms = item["creationTimeMs"].as_u64().unwrap_or(0);
                            let kind = item["type"].as_str().unwrap_or("Unknown").to_owned();
                            let name = item["name"].as_str().map(str::to_owned);
                            let service_name = item["serviceName"].as_str().map(str::to_owned);
                            let cpu_percent = item["cpuPercent"]
                                .as_f64()
                                .filter(|v| v.is_finite() && *v >= 0.0)
                                .unwrap_or(0.0);
                            let cumulative_cpu_seconds = item["cumulativeCpuSeconds"]
                                .as_f64()
                                .filter(|v| v.is_finite() && *v >= 0.0);
                            let resident_bytes = item["residentBytes"].as_u64().unwrap_or(0);
                            let idle_wakeups_per_second = item["idleWakeupsPerSecond"]
                                .as_f64()
                                .filter(|v| v.is_finite() && *v >= 0.0);
                            Some(DesktopElectronProcess {
                                pid,
                                creation_time_ms,
                                kind,
                                name,
                                service_name,
                                cpu_percent,
                                cumulative_cpu_seconds,
                                resident_bytes,
                                idle_wakeups_per_second,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let replace_power = snapshot
                .power
                .as_ref()
                .is_none_or(|(_, previous, _)| updated_at >= *previous);
            if replace_power {
                snapshot.power = Some((sampled_at, updated_at, power.clone()));
            }
        }
        true
    }
    pub fn desktop_telemetry_snapshot(&self) -> DesktopTelemetrySnapshot {
        self.desktop_telemetry
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
    #[cfg(unix)]
    pub fn start_desktop_telemetry(
        self: &std::sync::Arc<Self>,
        fd: i32,
        registry: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    ) {
        use std::os::fd::FromRawFd;
        if let Ok(mut snapshot) = self.desktop_telemetry.lock() {
            snapshot.descriptor_configured = true;
            snapshot.stream_closed = false;
            snapshot.last_error = None;
        }
        let duplicate = unsafe { libc::dup(fd) };
        if duplicate < 0 {
            if let Ok(mut snapshot) = self.desktop_telemetry.lock() {
                snapshot.last_error = Some(format!("Failed to attach desktop telemetry fd {fd}."));
            }
            return;
        }
        let weak = std::sync::Arc::downgrade(self);
        let registry = std::sync::Arc::downgrade(&registry);
        std::thread::spawn(move || {
            use std::io::Read;
            use std::os::fd::AsRawFd;
            let mut file = unsafe { std::fs::File::from_raw_fd(duplicate) };
            let mut chunk = [0u8; 8192];
            let mut line = Vec::new();
            let record_stop = |reason: &str| {
                if let Some(activity) = weak.upgrade() {
                    if let Ok(mut snapshot) = activity.desktop_telemetry.lock() {
                        snapshot.stream_closed = true;
                        if snapshot.last_error.is_none() {
                            snapshot.last_error = Some(reason.to_owned());
                        }
                    }
                }
            };
            loop {
                if weak.strong_count() == 0 {
                    break;
                }
                let mut poll = libc::pollfd {
                    fd: file.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let ready = unsafe { libc::poll(&mut poll, 1, 1000) };
                if ready == 0 {
                    continue;
                }
                if ready < 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    record_stop("Desktop telemetry stream failed.");
                    break;
                }
                let Ok(count) = file.read(&mut chunk) else {
                    record_stop("Desktop telemetry stream read failed.");
                    break;
                };
                if count == 0 {
                    record_stop("Desktop telemetry stream closed.");
                    break;
                }
                for byte in &chunk[..count] {
                    if *byte == b'\n' {
                        let Some(activity) = weak.upgrade() else {
                            return;
                        };
                        if !line.is_empty()
                            && !activity
                                .ingest_desktop_telemetry(&line, registry.upgrade().as_deref())
                        {
                            record_stop("Desktop telemetry payload was rejected.");
                            return;
                        }
                        line.clear();
                    } else if line.len() < 1_048_576 {
                        line.push(*byte);
                    } else {
                        record_stop("Desktop telemetry frame exceeded 1 MiB limit.");
                        return;
                    }
                }
            }
        });
    }
    #[cfg(not(unix))]
    pub fn start_desktop_telemetry(
        self: &std::sync::Arc<Self>,
        _fd: i32,
        _registry: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    ) {
    }
    pub fn start_scheduler(&self) -> bool {
        !self
            .scheduler_started
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }
    pub fn provider_refresh_interval(settings: &Value) -> u64 {
        let activity = &settings["backgroundActivity"];
        let profile = activity["profile"].as_str().unwrap_or("balanced");
        let base = if profile == "custom" {
            activity["baseProfile"].as_str().unwrap_or("balanced")
        } else {
            profile
        };
        let preset = match base {
            "performance" => 60_000,
            "battery-saver" => 900_000,
            _ => 300_000,
        };
        if profile == "custom" {
            activity["overrides"]["providerHealthRefreshInterval"]
                .as_u64()
                .unwrap_or(preset)
        } else if activity.is_null()
            || (profile == "balanced"
                && activity["baseProfile"].is_null()
                && activity["overrides"]
                    .as_object()
                    .is_none_or(|v| v.is_empty()))
        {
            settings["providerHealthRefreshInterval"]
                .as_u64()
                .unwrap_or(preset)
        } else {
            preset
        }
    }
    pub fn provider_demands(&self, settings: &Value) -> Vec<String> {
        let now = Instant::now();
        let activity = &settings["backgroundActivity"];
        let profile = activity["profile"]
            .as_str()
            .or_else(|| settings["backgroundActivityProfile"].as_str())
            .unwrap_or("balanced");
        let base = if profile == "custom" {
            activity["baseProfile"].as_str().unwrap_or("balanced")
        } else {
            profile
        };
        let performance = base == "performance";
        let overrides = &activity["overrides"];
        let setting = |name: &str, default: bool| {
            if profile == "custom" {
                overrides[name].as_bool().unwrap_or(default)
            } else {
                default
            }
        };
        let idle_ms = if profile == "custom" {
            overrides["hostPowerMonitorIdleInterval"]
                .as_u64()
                .unwrap_or(if base == "battery-saver" {
                    600_000
                } else if performance {
                    120_000
                } else {
                    300_000
                })
        } else if base == "battery-saver" {
            600_000
        } else if performance {
            120_000
        } else {
            300_000
        };
        let active_ms = if profile == "custom" {
            overrides["hostPowerMonitorActiveInterval"]
                .as_u64()
                .unwrap_or(if base == "battery-saver" {
                    60_000
                } else {
                    30_000
                })
        } else if base == "battery-saver" {
            60_000
        } else {
            30_000
        };
        let stale_after =
            Duration::from_millis(idle_ms.max(active_ms).saturating_add(30_000).max(90_000));
        let host_constrained = self
            .host_power
            .lock()
            .ok()
            .and_then(|power| power.clone())
            .is_some_and(|(sampled_at, _, power)| {
                chrono::Utc::now()
                    .timestamp_millis()
                    .saturating_sub(sampled_at)
                    < stale_after.as_millis() as i64
                    && power["stale"] == false
                    && (power["suspended"] == true
                        || (setting("pauseWhenHostLocked", true) && power["locked"] == "true")
                        || matches!(power["thermalState"].as_str(), Some("serious" | "critical"))
                        || (setting("pauseWhenHostLowPower", !performance)
                            && power["lowPowerMode"] == "true")
                        || (setting("pauseWhenOnBattery", base == "battery-saver")
                            && power["onBattery"] == "true"))
            });
        if host_constrained {
            return Vec::new();
        }
        let pause_low_power = if profile == "custom" {
            activity["overrides"]["pauseWhenClientLowPower"]
                .as_bool()
                .unwrap_or(!performance)
        } else {
            !performance
        };
        let mut result = Vec::new();
        if let Ok(leases) = self.leases.lock() {
            for (expiry, lease) in leases.values() {
                if *expiry <= now
                    || (pause_low_power && lease["lowPowerMode"] == "true")
                    || !(performance
                        || (lease["visible"] == true
                            && (lease["focused"] == true || lease["recentlyInteracted"] == true)))
                {
                    continue;
                }
                for scope in lease["scopes"].as_array().into_iter().flatten() {
                    if scope["type"] == "provider-status" {
                        let id = scope["instanceId"].as_str().unwrap_or("*").to_owned();
                        if !result.contains(&id) {
                            result.push(id);
                        }
                    }
                }
            }
        }
        result
    }
    pub fn has_provider_demand(&self, settings: &Value) -> bool {
        !self.provider_demands(settings).is_empty()
    }
    pub fn report(&self, session: &str, input: &Value) -> Result<(), &'static str> {
        let client = input["clientId"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 128)
            .ok_or("Invalid client activity")?;
        if !matches!(
            input["clientKind"].as_str(),
            Some("web" | "desktop-renderer" | "mobile" | "unknown")
        ) || !["visible", "focused", "recentlyInteracted"]
            .iter()
            .all(|k| input[*k].is_boolean())
            || input["observedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_none()
        {
            return Err("Invalid client activity");
        }
        if input.get("appState").is_some_and(|v| {
            !matches!(
                v.as_str(),
                Some("active" | "inactive" | "background" | "unknown")
            )
        }) || input
            .get("lowPowerMode")
            .is_some_and(|v| !matches!(v.as_str(), Some("true" | "false" | "unknown")))
        {
            return Err("Invalid client activity");
        }
        let scopes = input["scopes"]
            .as_array()
            .ok_or("Invalid client activity")?;
        if !scopes.iter().all(|v| match v["type"].as_str() {
            Some("server-config" | "diagnostics") => true,
            Some("provider-status") => v.get("instanceId").is_none_or(Value::is_string),
            Some("vcs-status" | "git-refs") => v["cwd"].is_string(),
            Some("thread") => v["threadId"].as_str().is_some_and(|s| !s.trim().is_empty()),
            _ => false,
        }) {
            return Err("Invalid client activity");
        }
        let ttl = match input.get("ttlMs") {
            None => 45_000,
            Some(v) => v
                .as_f64()
                .filter(|n| n.is_finite())
                .map(|n| n.clamp(1_000.0, 120_000.0) as u64)
                .ok_or("Invalid client activity")?,
        };
        let now = Instant::now();
        let mut leases = self.leases.lock().map_err(|_| "Activity unavailable")?;
        leases.retain(|_, (expiry, _)| *expiry > now);
        let key = (session.to_owned(), client.to_owned());
        if !leases.contains_key(&key) {
            let oldest = leases
                .iter()
                .filter(|((sid, _), _)| sid == session)
                .min_by_key(|(_, (expires, _))| *expires)
                .map(|(key, _)| key.clone());
            if leases.keys().filter(|(sid, _)| sid == session).count() >= 16 {
                if let Some(oldest) = oldest {
                    leases.remove(&oldest);
                }
            }
        }
        leases.insert(key, (now + Duration::from_millis(ttl), input.clone()));
        Ok(())
    }
}
fn host_power_intervals(settings: &Value) -> (u64, u64) {
    let activity = &settings["backgroundActivity"];
    let profile = activity["profile"]
        .as_str()
        .or_else(|| settings["backgroundActivityProfile"].as_str())
        .unwrap_or("balanced");
    let base = if profile == "custom" {
        activity["baseProfile"].as_str().unwrap_or("balanced")
    } else {
        profile
    };
    let (active, idle) = match base {
        "performance" => (30_000, 120_000),
        "battery-saver" => (60_000, 600_000),
        _ => (30_000, 300_000),
    };
    if profile == "custom" {
        (
            activity["overrides"]["hostPowerMonitorActiveInterval"]
                .as_u64()
                .unwrap_or(active)
                .max(1),
            activity["overrides"]["hostPowerMonitorIdleInterval"]
                .as_u64()
                .unwrap_or(idle)
                .max(1),
        )
    } else {
        (active, idle)
    }
}

#[cfg(target_os = "linux")]
fn write_pipe_without_sigpipe(fd: i32, bytes: &[u8]) -> std::io::Result<usize> {
    unsafe {
        let mut blocked: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        let mut pending: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut blocked);
        libc::sigaddset(&mut blocked, libc::SIGPIPE);
        if libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut previous) != 0 {
            return Err(std::io::Error::other("cannot block SIGPIPE"));
        }
        libc::sigpending(&mut pending);
        let already_pending = libc::sigismember(&pending, libc::SIGPIPE) == 1;
        let result = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
        let error = std::io::Error::last_os_error();
        if result < 0 && error.raw_os_error() == Some(libc::EPIPE) && !already_pending {
            let timeout = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            libc::sigtimedwait(&blocked, std::ptr::null_mut(), &timeout);
        }
        libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
        if result < 0 {
            Err(error)
        } else {
            Ok(result as usize)
        }
    }
}
#[cfg(all(unix, not(target_os = "linux")))]
fn write_pipe_without_sigpipe(_fd: i32, _bytes: &[u8]) -> std::io::Result<usize> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(unix)]
pub fn start_desktop_control(fd: i32, settings: std::sync::Arc<crate::settings::Settings>) {
    use std::os::fd::FromRawFd;
    let mut socket_type: libc::c_int = 0;
    let mut socket_type_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let is_socket = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut socket_type as *mut libc::c_int).cast(),
            &mut socket_type_len,
        )
    } == 0;
    let duplicate = if is_socket {
        unsafe { libc::dup(fd) }
    } else {
        #[cfg(target_os = "linux")]
        let path = format!("/proc/self/fd/{fd}");
        #[cfg(not(target_os = "linux"))]
        let path = format!("/dev/fd/{fd}");
        let Ok(path) = std::ffi::CString::new(path) else {
            return;
        };
        unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        }
    };
    if duplicate < 0 {
        return;
    }
    let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicate) };
    // SAFETY: `owned` holds this descriptor until `descriptor` is dropped.
    let Ok(descriptor) = (unsafe { tokio::io::unix::AsyncFd::register(owned) }) else {
        return;
    };
    let mut changes = settings.subscribe();
    let initial = settings.snapshot();
    drop(settings);
    tokio::spawn(async move {
        use std::os::fd::AsRawFd;
        let mut next = initial;
        loop {
            let (active, idle) = host_power_intervals(&next);
            let frame = serde_json::json!({"version":1,"type":"setHostPowerIntervals","activeIntervalMs":active,"idleIntervalMs":idle}).to_string() + "\n";
            let write = async {
                let mut remaining = frame.as_bytes();
                while !remaining.is_empty() {
                    let mut ready = descriptor.writable().await?;
                    match ready.try_io(|fd| {
                        if is_socket {
                            let count = unsafe {
                                libc::send(
                                    fd.get_ref().as_raw_fd(),
                                    remaining.as_ptr().cast(),
                                    remaining.len(),
                                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                                )
                            };
                            if count < 0 {
                                Err(std::io::Error::last_os_error())
                            } else {
                                Ok(count as usize)
                            }
                        } else {
                            write_pipe_without_sigpipe(fd.get_ref().as_raw_fd(), remaining)
                        }
                    }) {
                        Ok(Ok(0)) => return Err(std::io::ErrorKind::WriteZero.into()),
                        Ok(Ok(count)) => remaining = &remaining[count..],
                        Ok(Err(error)) => return Err(error),
                        Err(_) => continue,
                    }
                }
                Ok::<(), std::io::Error>(())
            };
            if !matches!(
                tokio::time::timeout(Duration::from_secs(3), write).await,
                Ok(Ok(()))
            ) {
                break;
            }
            match changes.recv().await {
                Ok(settings) => next = settings,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}
#[cfg(not(unix))]
pub fn start_desktop_control(_fd: i32, _settings: std::sync::Arc<crate::settings::Settings>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_demand_requires_a_live_foreground_lease() {
        let activity = ClientActivity::default();
        let mut report = json!({"clientId":"a","clientKind":"web","visible":true,"focused":true,"recentlyInteracted":false,"scopes":[{"type":"provider-status"}],"observedAt":"2026-01-01T00:00:00Z"});
        assert!(!activity.has_provider_demand(&json!({})));
        assert!(activity.start_scheduler());
        assert!(!activity.start_scheduler());
        activity.report("s", &report).unwrap();
        assert!(activity.has_provider_demand(&json!({})));
        report["visible"] = json!(false);
        activity.report("s", &report).unwrap();
        assert!(!activity.has_provider_demand(&json!({})));
        assert!(activity.has_provider_demand(&json!({"backgroundActivityProfile":"performance"})));
        report["lowPowerMode"] = json!("true");
        report["visible"] = json!(true);
        activity.report("s", &report).unwrap();
        assert!(!activity.has_provider_demand(&json!({})));
        assert!(
            activity.has_provider_demand(&json!({"backgroundActivity":{"profile":"performance"}}))
        );
        report["lowPowerMode"] = json!("false");
        report["scopes"] = json!([{"type":"provider-status","instanceId":"kiro-a"}]);
        activity.report("s", &report).unwrap();
        assert_eq!(activity.provider_demands(&json!({})), vec!["kiro-a"]);
        assert_eq!(
            ClientActivity::provider_refresh_interval(
                &json!({"backgroundActivity":{"profile":"performance"}})
            ),
            60_000
        );
        assert_eq!(
            ClientActivity::provider_refresh_interval(
                &json!({"backgroundActivity":{"profile":"custom","baseProfile":"balanced","overrides":{"providerHealthRefreshInterval":0}}})
            ),
            0
        );
        report["scopes"] = json!([{"type":"server-config"}]);
        activity.report("s", &report).unwrap();
        assert!(!activity.has_provider_demand(&json!({"backgroundActivityProfile":"performance"})));
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn desktop_control_supports_pipe_descriptors() {
        use std::os::fd::FromRawFd;
        use tokio::io::AsyncBufReadExt;
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let reader = unsafe { std::fs::File::from_raw_fd(fds[0]) };
        let writer = unsafe { std::os::fd::OwnedFd::from_raw_fd(fds[1]) };
        let path =
            std::env::temp_dir().join(format!("t3-control-pipe-{}.json", uuid::Uuid::new_v4()));
        let settings = std::sync::Arc::new(crate::settings::Settings::new(path));
        use std::os::fd::AsRawFd;
        let flags_before = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) };
        start_desktop_control(writer.as_raw_fd(), settings);
        let flags_after = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(
            flags_before, flags_after,
            "control must not alter the inherited descriptor flags"
        );
        drop(writer);
        let mut reader = tokio::io::BufReader::new(tokio::fs::File::from_std(reader));
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "setHostPowerIntervals");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn closed_control_pipe_returns_epipe_without_signalling_the_process() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let reader = unsafe { std::os::fd::OwnedFd::from_raw_fd(fds[0]) };
        let writer = unsafe { std::os::fd::OwnedFd::from_raw_fd(fds[1]) };
        drop(reader);
        let error = write_pipe_without_sigpipe(writer.as_raw_fd(), b"test").unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EPIPE));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_control_tracks_settings_changes() {
        use std::os::fd::AsRawFd;
        use tokio::io::AsyncBufReadExt;
        let path = std::env::temp_dir().join(format!("t3-control-{}.json", uuid::Uuid::new_v4()));
        let settings = std::sync::Arc::new(crate::settings::Settings::new(path.clone()));
        let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        start_desktop_control(writer.as_raw_fd(), settings.clone());
        drop(writer);
        let mut reader =
            tokio::io::BufReader::new(tokio::net::UnixStream::from_std(reader).unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let initial: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(initial["activeIntervalMs"], 30_000);
        assert_eq!(initial["idleIntervalMs"], 300_000);
        settings.update(&json!({"backgroundActivity":{"schemaVersion":1,"profile":"battery-saver","overrides":{}}})).unwrap();
        line.clear();
        tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let changed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(changed["activeIntervalMs"], 60_000);
        assert_eq!(changed["idleIntervalMs"], 600_000);
        let _ = std::fs::remove_file(path);
    }
    #[cfg(unix)]
    #[test]
    fn desktop_telemetry_reader_handles_split_frames_and_stops_with_owner() {
        use std::io::{Read, Write};
        use std::os::fd::AsRawFd;
        let (reader, mut writer) = std::os::unix::net::UnixStream::pair().unwrap();
        writer
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let activity = std::sync::Arc::new(ClientActivity::default());
        activity.start_desktop_telemetry(
            reader.as_raw_fd(),
            std::sync::Arc::new(crate::provider::session_registry::SessionRegistry::default()),
        );
        drop(reader);
        let frame = json!({"version":1,"type":"desktopTelemetry","sequence":1,"electronPid":1,"electronProcesses":[],"sampledAtUnixMs":chrono::Utc::now().timestamp_millis(),"power":{"updatedAt":"2026-11-14T00:00:00Z","source":"electron-main","idle":"false","onBattery":"false","lowPowerMode":"false","thermalState":"nominal","stale":false,"suspended":false,"locked":"true"}}).to_string() + "\n";
        let (first, second) = frame.as_bytes().split_at(frame.len() / 2);
        writer.write_all(first).unwrap();
        writer.write_all(second).unwrap();
        for _ in 0..100 {
            if activity.host_power.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(activity.host_power.lock().unwrap().is_some());
        drop(activity);
        assert_eq!(writer.read(&mut [0u8; 1]).unwrap(), 0);
    }
    #[test]
    fn desktop_power_gates_status_and_stale_snapshots_do_not() {
        let activity = ClientActivity::default();
        let report = json!({"clientId":"a","clientKind":"web","visible":true,"focused":true,"recentlyInteracted":false,"scopes":[{"type":"provider-status"}],"observedAt":"2026-01-01T00:00:00Z"});
        activity.report("s", &report).unwrap();
        let mut power = json!({"source":"electron-main","idle":"false","stale":false,"suspended":false,"locked":"true","onBattery":"false","lowPowerMode":"false","thermalState":"nominal","updatedAt":"2026-11-14T00:00:00Z"});
        let ingest = |power: &Value| {
            let _ = activity.ingest_desktop_telemetry(
                json!({"version":1,"type":"desktopTelemetry","sequence":1,"electronPid":1,"electronProcesses":[],"sampledAtUnixMs":chrono::Utc::now().timestamp_millis(),"power":power})
                    .to_string()
                    .as_bytes(),
                None,
            );
        };
        ingest(&power);
        assert!(!activity.has_provider_demand(&json!({})));
        power["updatedAt"] = json!("2026-11-13T23:59:59Z");
        power["locked"] = json!("false");
        ingest(&power);
        assert!(
            !activity.has_provider_demand(&json!({})),
            "older telemetry must not replace the latest power state"
        );
        power["updatedAt"] = json!("2026-11-14T00:00:00Z");
        power["locked"] = json!("false");
        power["onBattery"] = json!("true");
        ingest(&power);
        assert!(activity.has_provider_demand(&json!({})));
        assert!(!activity
            .has_provider_demand(&json!({"backgroundActivity":{"profile":"battery-saver"}})));
        power["onBattery"] = json!("false");
        power["thermalState"] = json!("serious");
        ingest(&power);
        assert!(!activity.has_provider_demand(&json!({})));
        power["stale"] = json!(true);
        ingest(&power);
        assert!(activity.has_provider_demand(&json!({})));
        power["stale"] = json!(false);
        ingest(&power);
        activity.host_power.lock().unwrap().as_mut().unwrap().0 -= 331_000;
        assert!(activity.has_provider_demand(&json!({})));
    }
    #[test]
    fn validates_and_bounds_leases() {
        let policy = ClientActivity::default();
        let mut v = json!({"clientId":"a","clientKind":"web","visible":true,"focused":false,"recentlyInteracted":true,"scopes":[{"type":"thread","threadId":"t"}],"observedAt":"2026-01-01T00:00:00Z"});
        for n in 0..20 {
            v["clientId"] = json!(format!("id-{n}"));
            policy.report("s", &v).unwrap();
        }
        assert_eq!(policy.leases.lock().unwrap().len(), 16);
        v["scopes"] = json!([{"type":"thread"}]);
        assert!(policy.report("s", &v).is_err());
    }
}
