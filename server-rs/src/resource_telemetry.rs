//! Native process tree, resource history, and process signal diagnostics for the server.
use crate::background_activity::{ClientActivity, DesktopTelemetrySnapshot};
use crate::codec::encode_option;
use crate::config::Mode;
use crate::http_server::RpcFailure;
use crate::terminal::TerminalManager;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};
use tokio::sync::{mpsc, Notify};

const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 1_000;
const IDLE_SAMPLE_INTERVAL_MS: u64 = 15_000;
const HISTORY_RETENTION_MS: i64 = 3_600_000;
const DEFAULT_HISTORY_WINDOW_MS: i64 = 900_000;
const MIN_HISTORY_WINDOW_MS: i64 = 60_000;
const MAX_HISTORY_WINDOW_MS: i64 = 3_600_000;
const DEFAULT_BUCKET_COUNT: i64 = 30;
const MAX_HISTORY_SAMPLES: usize = 3_700;
const MAX_TOP_PROCESSES: usize = 25;
const DESKTOP_STALE_AFTER_MS: i64 = 90_000;
const MIN_HISTORY_APPEND_SPACING_MS: i64 = 500;

fn iso_from_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn round2(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 0.0;
    }
    (value * 100.0).round() / 100.0
}

fn status_label(status: ProcessStatus) -> &'static str {
    match status {
        ProcessStatus::Run => "running",
        ProcessStatus::Sleep => "sleeping",
        ProcessStatus::Idle => "idle",
        ProcessStatus::Stop => "stopped",
        ProcessStatus::Zombie => "zombie",
        ProcessStatus::Dead => "dead",
        _ => "unknown",
    }
}

fn format_elapsed(run_time_ms: u64) -> String {
    let total_seconds = run_time_ms / 1000;
    let days = total_seconds / 86_400;
    let hours = (total_seconds % 86_400) / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if days > 0 {
        format!("{days}-{hours:02}:{minutes:02}:{seconds:02}")
    } else if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn map_electron_category(kind: &str) -> &'static str {
    match kind {
        "Browser" => "electron-main",
        "Tab" => "electron-renderer",
        "GPU" => "electron-gpu",
        _ => "electron-utility",
    }
}

fn looks_like_provider_root(name: &str, command: &str) -> bool {
    let haystack = format!("{name} {command}").to_ascii_lowercase();
    [
        "codex",
        "claude",
        "opencode",
        "gemini",
        "cursor-agent",
        "kiro-cli",
        "pi-coding-agent",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

fn is_backend_category(category: &str) -> bool {
    matches!(
        category,
        "server" | "server-child" | "provider-root" | "terminal-root"
    )
}

fn is_signalable_descendant(category: &str) -> bool {
    matches!(category, "server-child" | "provider-root" | "terminal-root")
}

fn invalid_payload() -> RpcFailure {
    RpcFailure::Die(json!({ "name": "Error", "message": "Invalid RPC payload" }))
}

fn pgid_for_pid(pid: u32) -> Option<i64> {
    #[cfg(unix)]
    {
        let raw = unsafe { libc::getpgid(pid as libc::pid_t) };
        (raw >= 0).then_some(raw as i64)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_disk_usage()
        .with_cmd(UpdateKind::Always)
        .with_exe(UpdateKind::OnlyIfNotSet)
}

#[derive(Clone, Debug)]
struct ProcessEntry {
    pid: u32,
    start_time_ms: u64,
    ppid: u32,
    pgid: Option<i64>,
    child_pids: Vec<u32>,
    depth: u32,
    name: String,
    command: String,
    status: String,
    category: &'static str,
    electron_type: Option<String>,
    electron_service_name: Option<String>,
    idle_wakeups_per_second: Option<f64>,
    cpu_percent: f64,
    cpu_time_ms: u64,
    resident_bytes: u64,
    peak_resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_read_bytes_per_second: f64,
    io_write_bytes_per_second: f64,
    io_semantics: &'static str,
    run_time_ms: u64,
    first_seen_at: String,
    last_seen_at: String,
}

impl ProcessEntry {
    fn identity_key(&self) -> String {
        format!("{}:{}", self.pid, self.start_time_ms)
    }

    fn to_telemetry_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "identity".into(),
            json!({ "pid": self.pid, "startTimeMs": self.start_time_ms }),
        );
        obj.insert("ppid".into(), json!(self.ppid));
        obj.insert("childPids".into(), json!(self.child_pids));
        obj.insert("depth".into(), json!(self.depth));
        obj.insert("name".into(), json!(self.name));
        obj.insert("command".into(), json!(self.command));
        obj.insert("status".into(), json!(self.status));
        obj.insert("category".into(), json!(self.category));
        if let Some(electron_type) = &self.electron_type {
            obj.insert("electronType".into(), json!(electron_type));
        }
        if let Some(service_name) = &self.electron_service_name {
            obj.insert("electronServiceName".into(), json!(service_name));
        }
        if let Some(wakeups) = self.idle_wakeups_per_second {
            obj.insert("idleWakeupsPerSecond".into(), json!(wakeups));
        }
        obj.insert("cpuPercent".into(), json!(self.cpu_percent));
        obj.insert("cpuTimeMs".into(), json!(self.cpu_time_ms));
        obj.insert("residentBytes".into(), json!(self.resident_bytes));
        obj.insert("peakResidentBytes".into(), json!(self.peak_resident_bytes));
        obj.insert("virtualBytes".into(), json!(self.virtual_bytes));
        obj.insert("ioReadBytes".into(), json!(self.io_read_bytes));
        obj.insert("ioWriteBytes".into(), json!(self.io_write_bytes));
        obj.insert(
            "ioReadBytesPerSecond".into(),
            json!(self.io_read_bytes_per_second),
        );
        obj.insert(
            "ioWriteBytesPerSecond".into(),
            json!(self.io_write_bytes_per_second),
        );
        obj.insert("ioSemantics".into(), json!(self.io_semantics));
        obj.insert("runTimeMs".into(), json!(self.run_time_ms));
        obj.insert("firstSeenAt".into(), json!(self.first_seen_at));
        obj.insert("lastSeenAt".into(), json!(self.last_seen_at));
        Value::Object(obj)
    }

    fn to_diagnostics_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "startTimeMs": self.start_time_ms,
            "ppid": self.ppid,
            "pgid": encode_option(self.pgid.map(Value::from)),
            "status": self.status,
            "cpuPercent": self.cpu_percent,
            "rssBytes": self.resident_bytes,
            "elapsed": format_elapsed(self.run_time_ms),
            "command": self.command,
            "depth": self.depth,
            "childPids": self.child_pids,
        })
    }
}

#[derive(Clone, Debug)]
struct ProcessLifecycle {
    first_seen_at_ms: i64,
    peak_resident_bytes: u64,
    last_sample_at_ms: i64,
    last_io_read_bytes: u64,
    last_io_write_bytes: u64,
    last_cpu_time_ms: u64,
}

#[derive(Clone, Debug, Default)]
struct GroupLifecycle {
    active: HashSet<(u32, u64)>,
    starts: u64,
    exits: u64,
}

#[derive(Clone, Debug)]
struct HistoryProcessSample {
    pid: u32,
    start_time_ms: u64,
    ppid: u32,
    depth: u32,
    name: String,
    command: String,
    category: &'static str,
    cpu_percent: f64,
    cpu_time_ms: u64,
    cpu_time_delta_ms: u64,
    resident_bytes: u64,
    peak_resident_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_read_delta_bytes: u64,
    io_write_delta_bytes: u64,
    io_semantics: &'static str,
}

#[derive(Clone, Debug)]
struct RetainedSample {
    sampled_at_ms: i64,
    all_cpu_percent: f64,
    all_rss_bytes: u64,
    all_io_read_delta_bytes: u64,
    all_io_write_delta_bytes: u64,
    all_process_count: usize,
    backend_cpu_percent: f64,
    backend_rss_bytes: u64,
    backend_process_count: usize,
    processes: Vec<HistoryProcessSample>,
}

#[derive(Clone, Debug, Default)]
struct AttributionEntry {
    logical_read_bytes: u64,
    logical_write_bytes: u64,
    count: u64,
    duration_ms: u64,
}

struct CollectorState {
    system: Option<System>,
    system_error: Option<String>,
    mode_label: &'static str,
    last_sampled_at_ms: Option<i64>,
    last_snapshot: Option<Value>,
    last_entries: Vec<ProcessEntry>,
    lifecycle: HashMap<(u32, u64), ProcessLifecycle>,
    groups: HashMap<&'static str, GroupLifecycle>,
    history: VecDeque<RetainedSample>,
    attributions: BTreeMap<(String, String), AttributionEntry>,
}

impl CollectorState {
    fn new() -> Self {
        let (system, system_error) = match System::new() {
            Ok(mut sys) => {
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
                (Some(sys), None)
            }
            Err(err) => (None, Some(err.to_string())),
        };
        Self {
            system,
            system_error,
            mode_label: "web",
            last_sampled_at_ms: None,
            last_snapshot: None,
            last_entries: Vec::new(),
            lifecycle: HashMap::new(),
            groups: HashMap::new(),
            history: VecDeque::new(),
            attributions: BTreeMap::new(),
        }
    }

    fn record_attribution(
        &mut self,
        component: &str,
        operation: &str,
        logical_read_bytes: u64,
        logical_write_bytes: u64,
        duration_ms: u64,
    ) {
        let entry = self
            .attributions
            .entry((component.to_owned(), operation.to_owned()))
            .or_default();
        entry.logical_read_bytes = entry
            .logical_read_bytes
            .saturating_add(logical_read_bytes);
        entry.logical_write_bytes = entry
            .logical_write_bytes
            .saturating_add(logical_write_bytes);
        entry.count = entry.count.saturating_add(1);
        entry.duration_ms = entry.duration_ms.saturating_add(duration_ms);
    }

    fn update_group_aggregate(
        &mut self,
        group_name: &'static str,
        entries: &[&ProcessEntry],
    ) -> Value {
        let current: HashSet<(u32, u64)> = entries
            .iter()
            .map(|entry| (entry.pid, entry.start_time_ms))
            .collect();
        let lifecycle = self.groups.entry(group_name).or_default();
        if lifecycle.active.is_empty() && lifecycle.starts == 0 && lifecycle.exits == 0 {
            lifecycle.starts = current.len() as u64;
        } else {
            let new_starts = current.difference(&lifecycle.active).count() as u64;
            let new_exits = lifecycle.active.difference(&current).count() as u64;
            lifecycle.starts = lifecycle.starts.saturating_add(new_starts);
            lifecycle.exits = lifecycle.exits.saturating_add(new_exits);
        }
        lifecycle.active = current;

        let current_cpu_percent = round2(entries.iter().map(|e| e.cpu_percent).sum());
        let cpu_time_ms: u64 = entries.iter().map(|e| e.cpu_time_ms).sum();
        let current_rss_bytes: u64 = entries.iter().map(|e| e.resident_bytes).sum();
        let peak_rss_bytes: u64 = entries.iter().map(|e| e.peak_resident_bytes).sum();
        let io_read_bytes: u64 = entries.iter().map(|e| e.io_read_bytes).sum();
        let io_write_bytes: u64 = entries.iter().map(|e| e.io_write_bytes).sum();
        let io_read_bps = round2(entries.iter().map(|e| e.io_read_bytes_per_second).sum());
        let io_write_bps = round2(entries.iter().map(|e| e.io_write_bytes_per_second).sum());

        json!({
            "processCount": entries.len(),
            "currentCpuPercent": current_cpu_percent,
            "cpuTimeMs": cpu_time_ms,
            "currentRssBytes": current_rss_bytes,
            "peakRssBytes": peak_rss_bytes,
            "ioReadBytes": io_read_bytes,
            "ioWriteBytes": io_write_bytes,
            "ioReadBytesPerSecond": io_read_bps,
            "ioWriteBytesPerSecond": io_write_bps,
            "processStarts": lifecycle.starts,
            "processExits": lifecycle.exits,
        })
    }

    fn build_health(
        &self,
        now_ms: i64,
        read_at: &str,
        desktop: &DesktopTelemetrySnapshot,
        duration_micros: u64,
        scanned_count: usize,
        retained_count: usize,
    ) -> Value {
        let desktop_health = if !desktop.descriptor_configured {
            json!({
                "status": "unavailable",
                "lastSampleAt": encode_option(None),
                "lastError": encode_option(Some(Value::String(format!(
                    "Desktop telemetry descriptor is unavailable in '{}' mode.",
                    self.mode_label
                )))),
            })
        } else if desktop.stream_closed {
            let error = desktop
                .last_error
                .clone()
                .unwrap_or_else(|| "Desktop telemetry stream closed.".to_owned());
            json!({
                "status": "degraded",
                "lastSampleAt": encode_option(desktop.last_sample_at.clone().map(Value::String)),
                "lastError": encode_option(Some(Value::String(error))),
            })
        } else if let Some(last_at) = desktop.last_sample_at.as_ref() {
            let stale = desktop
                .last_received_unix_ms
                .is_none_or(|received| now_ms.saturating_sub(received) > DESKTOP_STALE_AFTER_MS);
            if stale {
                json!({
                    "status": "degraded",
                    "lastSampleAt": encode_option(Some(Value::String(last_at.clone()))),
                    "lastError": encode_option(Some(Value::String(
                        "Desktop telemetry sample is stale.".to_owned()
                    ))),
                })
            } else {
                json!({
                    "status": "healthy",
                    "lastSampleAt": encode_option(Some(Value::String(last_at.clone()))),
                    "lastError": encode_option(None),
                })
            }
        } else {
            json!({
                "status": "starting",
                "lastSampleAt": encode_option(None),
                "lastError": encode_option(desktop.last_error.clone().map(Value::String)),
            })
        };

        let native_health = if let Some(err) = self.system_error.as_ref() {
            json!({
                "status": "unavailable",
                "lastSampleAt": encode_option(None),
                "lastError": encode_option(Some(Value::String(err.clone()))),
            })
        } else {
            json!({
                "status": "healthy",
                "lastSampleAt": encode_option(Some(Value::String(read_at.to_owned()))),
                "lastError": encode_option(None),
            })
        };

        json!({
            "native": native_health,
            "desktop": desktop_health,
            "sidecarVersion": encode_option(Some(Value::String(format!(
                "builtin-{}",
                env!("CARGO_PKG_VERSION")
            )))),
            "sidecarPid": encode_option(Some(Value::from(std::process::id()))),
            "restartCount": 0,
            "collectionDurationMicros": duration_micros,
            "scannedProcessCount": scanned_count,
            "retainedProcessCount": retained_count,
            "inaccessibleProcessCount": 0,
        })
    }

    fn build_power(&self, read_at: &str, now_ms: i64, desktop: &DesktopTelemetrySnapshot) -> Value {
        if let Some((sampled_at, _, power)) = desktop.power.as_ref() {
            let mut value = power.clone();
            if now_ms.saturating_sub(*sampled_at) > DESKTOP_STALE_AFTER_MS {
                value["stale"] = Value::Bool(true);
            }
            if value.is_object() {
                return value;
            }
        }
        json!({
            "source": "unknown",
            "idle": "unknown",
            "idleSeconds": Value::Null,
            "locked": "unknown",
            "suspended": false,
            "onBattery": "unknown",
            "lowPowerMode": "unknown",
            "thermalState": "unknown",
            "stale": false,
            "updatedAt": read_at,
        })
    }
}

/// Collects native process tree telemetry, bounded resource history, and process signals.
pub struct ResourceTelemetry {
    background_activity: Arc<ClientActivity>,
    terminals: Arc<TerminalManager>,
    state: Mutex<CollectorState>,
    active_subscribers: AtomicUsize,
    background_started: AtomicBool,
    notify: Arc<Notify>,
}

impl ResourceTelemetry {
    pub fn new(background_activity: Arc<ClientActivity>, terminals: Arc<TerminalManager>) -> Self {
        Self {
            background_activity,
            terminals,
            state: Mutex::new(CollectorState::new()),
            active_subscribers: AtomicUsize::new(0),
            background_started: AtomicBool::new(false),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn set_mode(&self, mode: Mode) {
        if let Ok(mut state) = self.state.lock() {
            state.mode_label = match mode {
                Mode::Desktop => "desktop",
                Mode::Web => "web",
            };
        }
    }

    pub fn start_background_sampler(self: &Arc<Self>) {
        if self
            .background_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(telemetry) = weak.upgrade() else {
                    break;
                };
                let has_subscribers = telemetry.active_subscribers.load(Ordering::Acquire) > 0;
                let interval = if has_subscribers {
                    Duration::from_millis(DEFAULT_SAMPLE_INTERVAL_MS)
                } else {
                    Duration::from_millis(IDLE_SAMPLE_INTERVAL_MS)
                };
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {
                        let telemetry_bg = telemetry.clone();
                        let _ = tokio::task::spawn_blocking(move || telemetry_bg.sample_now()).await;
                    }
                    _ = telemetry.notify.notified() => {}
                }
            }
        });
    }

    pub fn sample_now(&self) -> Value {
        let started = Instant::now();
        let now_ms = Utc::now().timestamp_millis();
        let read_at = iso_from_ms(now_ms);
        let desktop = self.background_activity.desktop_telemetry_snapshot();
        let terminal_pids: HashSet<u32> = self
            .terminals
            .discovery_processes()
            .into_iter()
            .map(|(pid, _, _)| pid)
            .collect();

        let mut state_guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = &mut *state_guard;
        if let Some(sys) = state.system.as_mut() {
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
        }
        let empty_procs: HashMap<Pid, sysinfo::Process> = HashMap::new();
        let processes = state
            .system
            .as_ref()
            .map_or(&empty_procs, |sys| sys.processes());

        let server_pid = std::process::id();
        let scanned_count = processes.len();

        let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in processes {
            let pid_u32 = pid.as_u32();
            if let Some(parent) = process.parent() {
                children_by_parent
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid_u32);
            }
        }
        for children in children_by_parent.values_mut() {
            children.sort_unstable();
        }

        let electron_by_pid: HashMap<u32, _> = desktop
            .electron_processes
            .iter()
            .map(|item| (item.pid, item.clone()))
            .collect();

        // Collect server subtree in deterministic DFS pre-order.
        let mut ordered: Vec<(u32, u32, &'static str)> = Vec::new();
        let mut seen_pids: HashSet<u32> = HashSet::new();
        let mut stack: Vec<(u32, u32)> = vec![(server_pid, 0)];
        while let Some((pid, depth)) = stack.pop() {
            if !seen_pids.insert(pid) {
                continue;
            }
            let Some(proc_ref) = processes.get(&Pid::from_u32(pid)) else {
                continue;
            };
            let name = proc_ref.name().to_string_lossy().into_owned();
            let command = join_command(proc_ref, &name);
            let category = if pid == server_pid {
                "server"
            } else if depth == 1 && terminal_pids.contains(&pid) {
                "terminal-root"
            } else if depth == 1 && looks_like_provider_root(&name, &command) {
                "provider-root"
            } else {
                "server-child"
            };
            ordered.push((pid, depth, category));

            if let Some(children) = children_by_parent.get(&pid) {
                for &child in children.iter().rev() {
                    if !seen_pids.contains(&child) {
                        stack.push((child, depth.saturating_add(1)));
                    }
                }
            }
        }

        // Also include any live desktop host processes reported over desktop_telemetry_fd.
        if let Some(electron_pid) = desktop.electron_pid {
            if seen_pids.insert(electron_pid) {
                let kind = electron_by_pid
                    .get(&electron_pid)
                    .map(|p| map_electron_category(&p.kind))
                    .unwrap_or("electron-main");
                ordered.push((electron_pid, 0, kind));
            }
        }
        for proc_metric in &desktop.electron_processes {
            if seen_pids.insert(proc_metric.pid) {
                let depth = if desktop.electron_pid == Some(proc_metric.pid) {
                    0
                } else {
                    1
                };
                ordered.push((proc_metric.pid, depth, map_electron_category(&proc_metric.kind)));
            }
        }

        let io_semantics = if cfg!(target_os = "macos") {
            "all-io"
        } else {
            "storage"
        };

        let mut entries = Vec::with_capacity(ordered.len());
        let mut history_samples = Vec::with_capacity(ordered.len());
        let mut total_io_read_delta = 0u64;
        let mut total_io_write_delta = 0u64;

        for (pid, depth, category) in ordered {
            let os_proc = processes.get(&Pid::from_u32(pid));
            let electron_meta = electron_by_pid.get(&pid);
            let Some((start_time_ms, ppid, name, command, status, cpu_percent, cpu_time_ms, resident_bytes, virtual_bytes, io_read_bytes, io_write_bytes, run_time_ms)) =
                extract_process_metrics(os_proc, electron_meta, desktop.electron_pid, now_ms)
            else {
                continue;
            };

            let child_pids = children_by_parent
                .get(&pid)
                .map(|children| {
                    children
                        .iter()
                        .copied()
                        .filter(|child| seen_pids.contains(child))
                        .collect()
                })
                .unwrap_or_default();

            let key = (pid, start_time_ms);
            let prev = state.lifecycle.get(&key).cloned();
            let first_seen_at_ms = prev.as_ref().map(|p| p.first_seen_at_ms).unwrap_or(now_ms);
            let peak_resident_bytes = prev
                .as_ref()
                .map(|p| p.peak_resident_bytes.max(resident_bytes))
                .unwrap_or(resident_bytes);

            let (io_read_delta, io_write_delta, io_read_bps, io_write_bps, cpu_time_delta_ms) =
                if let Some(prev) = prev.as_ref() {
                    let elapsed_ms = now_ms.saturating_sub(prev.last_sample_at_ms);
                    let r_delta = io_read_bytes.saturating_sub(prev.last_io_read_bytes);
                    let w_delta = io_write_bytes.saturating_sub(prev.last_io_write_bytes);
                    let c_delta = cpu_time_ms.saturating_sub(prev.last_cpu_time_ms);
                    let (r_bps, w_bps) = if elapsed_ms > 0 {
                        let secs = elapsed_ms as f64 / 1000.0;
                        (round2(r_delta as f64 / secs), round2(w_delta as f64 / secs))
                    } else {
                        (0.0, 0.0)
                    };
                    (r_delta, w_delta, r_bps, w_bps, c_delta)
                } else {
                    (0, 0, 0.0, 0.0, 0)
                };

            total_io_read_delta = total_io_read_delta.saturating_add(io_read_delta);
            total_io_write_delta = total_io_write_delta.saturating_add(io_write_delta);

            state.lifecycle.insert(
                key,
                ProcessLifecycle {
                    first_seen_at_ms,
                    peak_resident_bytes,
                    last_sample_at_ms: now_ms,
                    last_io_read_bytes: io_read_bytes,
                    last_io_write_bytes: io_write_bytes,
                    last_cpu_time_ms: cpu_time_ms,
                },
            );

            let entry = ProcessEntry {
                pid,
                start_time_ms,
                ppid,
                pgid: pgid_for_pid(pid),
                child_pids,
                depth,
                name: name.clone(),
                command: command.clone(),
                status,
                category,
                electron_type: electron_meta.map(|m| m.kind.clone()),
                electron_service_name: electron_meta.and_then(|m| m.service_name.clone()),
                idle_wakeups_per_second: electron_meta.and_then(|m| m.idle_wakeups_per_second),
                cpu_percent,
                cpu_time_ms,
                resident_bytes,
                peak_resident_bytes,
                virtual_bytes,
                io_read_bytes,
                io_write_bytes,
                io_read_bytes_per_second: io_read_bps,
                io_write_bytes_per_second: io_write_bps,
                io_semantics,
                run_time_ms,
                first_seen_at: iso_from_ms(first_seen_at_ms),
                last_seen_at: read_at.clone(),
            };
            history_samples.push(HistoryProcessSample {
                pid,
                start_time_ms,
                ppid,
                depth,
                name,
                command,
                category,
                cpu_percent,
                cpu_time_ms,
                cpu_time_delta_ms,
                resident_bytes,
                peak_resident_bytes,
                io_read_bytes,
                io_write_bytes,
                io_read_delta_bytes: io_read_delta,
                io_write_delta_bytes: io_write_delta,
                io_semantics,
            });
            entries.push(entry);
        }

        // Prune exited processes from lifecycle cache if absent for over retention window.
        let cutoff = now_ms - HISTORY_RETENTION_MS;
        state
            .lifecycle
            .retain(|_, info| info.last_sample_at_ms >= cutoff);

        let backend_entries: Vec<&ProcessEntry> = entries
            .iter()
            .filter(|e| is_backend_category(e.category))
            .collect();
        let electron_entries: Vec<&ProcessEntry> = entries
            .iter()
            .filter(|e| e.category.starts_with("electron-"))
            .collect();
        let monitor_entries: Vec<&ProcessEntry> = entries
            .iter()
            .filter(|e| e.category == "resource-monitor")
            .collect();
        let all_entries: Vec<&ProcessEntry> = entries.iter().collect();

        let backend_cpu = round2(backend_entries.iter().map(|e| e.cpu_percent).sum());
        let backend_rss: u64 = backend_entries.iter().map(|e| e.resident_bytes).sum();
        let backend_count = backend_entries.len();
        let all_cpu = round2(all_entries.iter().map(|e| e.cpu_percent).sum());
        let all_rss: u64 = all_entries.iter().map(|e| e.resident_bytes).sum();
        let all_count = all_entries.len();

        let groups_json = json!({
            "backend": state.update_group_aggregate("backend", &backend_entries),
            "electron": state.update_group_aggregate("electron", &electron_entries),
            "monitor": state.update_group_aggregate("monitor", &monitor_entries),
            "allT3": state.update_group_aggregate("allT3", &all_entries),
        });

        let duration_ms = started.elapsed().as_millis() as u64;
        let duration_micros = started.elapsed().as_micros() as u64;
        state.record_attribution(
            "resource-telemetry",
            "process-scan",
            all_rss.min(64 * 1024),
            0,
            duration_ms,
        );

        let should_append_history = state.history.back().is_none_or(|last| {
            now_ms.saturating_sub(last.sampled_at_ms) >= MIN_HISTORY_APPEND_SPACING_MS
        });
        if should_append_history {
            state.history.push_back(RetainedSample {
                sampled_at_ms: now_ms,
                all_cpu_percent: all_cpu,
                all_rss_bytes: all_rss,
                all_io_read_delta_bytes: total_io_read_delta,
                all_io_write_delta_bytes: total_io_write_delta,
                all_process_count: all_count,
                backend_cpu_percent: backend_cpu,
                backend_rss_bytes: backend_rss,
                backend_process_count: backend_count,
                processes: history_samples,
            });
            while state
                .history
                .front()
                .is_some_and(|sample| sample.sampled_at_ms < cutoff)
                || state.history.len() > MAX_HISTORY_SAMPLES
            {
                state.history.pop_front();
            }
        }

        let attribution_entries: Vec<Value> = state
            .attributions
            .iter()
            .map(|((component, operation), item)| {
                json!({
                    "component": component,
                    "operation": operation,
                    "logicalReadBytes": item.logical_read_bytes,
                    "logicalWriteBytes": item.logical_write_bytes,
                    "count": item.count,
                    "durationMs": item.duration_ms,
                })
            })
            .collect();

        let health = state.build_health(
            now_ms,
            &read_at,
            &desktop,
            duration_micros,
            scanned_count,
            entries.len(),
        );
        let power = state.build_power(&read_at, now_ms, &desktop);
        let speed_limit = encode_option(desktop.speed_limit_percent.map(|v| json!(v)));
        let process_values: Vec<Value> =
            entries.iter().map(ProcessEntry::to_telemetry_json).collect();

        let snapshot = json!({
            "readAt": read_at,
            "sampleIntervalMs": DEFAULT_SAMPLE_INTERVAL_MS,
            "processes": process_values,
            "groups": groups_json,
            "power": power,
            "speedLimitPercent": speed_limit,
            "attribution": {
                "readAt": read_at,
                "entries": attribution_entries,
            },
            "health": health,
        });

        state.last_sampled_at_ms = Some(now_ms);
        state.last_entries = entries;
        state.last_snapshot = Some(snapshot.clone());
        snapshot
    }

    pub fn subscribe_stream(self: &Arc<Self>) -> mpsc::Receiver<Result<Vec<Value>, Value>> {
        self.start_background_sampler();
        let (tx, rx) = mpsc::channel(8);
        let telemetry = self.clone();
        telemetry.active_subscribers.fetch_add(1, Ordering::AcqRel);
        telemetry.notify.notify_waiters();

        tokio::spawn(async move {
            struct SubscriberGuard(Arc<ResourceTelemetry>);
            impl Drop for SubscriberGuard {
                fn drop(&mut self) {
                    self.0.active_subscribers.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _guard = SubscriberGuard(telemetry.clone());

            let initial = {
                let t = telemetry.clone();
                tokio::task::spawn_blocking(move || t.sample_now())
                    .await
                    .unwrap_or_else(|_| Value::Null)
            };
            if initial.is_null() || tx.send(Ok(vec![initial])).await.is_err() {
                return;
            }

            let mut last_sent_at: Option<i64> = telemetry
                .state
                .lock()
                .ok()
                .and_then(|s| s.last_sampled_at_ms);

            loop {
                tokio::select! {
                    _ = tx.closed() => break,
                    _ = tokio::time::sleep(Duration::from_millis(DEFAULT_SAMPLE_INTERVAL_MS)) => {
                        let t = telemetry.clone();
                        let next = tokio::task::spawn_blocking(move || {
                            let fresh_enough = t
                                .state
                                .lock()
                                .ok()
                                .and_then(|s| {
                                    let now = Utc::now().timestamp_millis();
                                    s.last_sampled_at_ms
                                        .filter(|ms| now.saturating_sub(*ms) < 850)
                                        .and_then(|ms| Some((ms, s.last_snapshot.clone()?)))
                                });
                            if let Some((ms, snap)) = fresh_enough {
                                (ms, snap)
                            } else {
                                let snap = t.sample_now();
                                let ms = t.state.lock().ok().and_then(|s| s.last_sampled_at_ms).unwrap_or(0);
                                (ms, snap)
                            }
                        }).await;
                        match next {
                            Ok((ms, snap)) => {
                                if Some(ms) != last_sent_at {
                                    last_sent_at = Some(ms);
                                    if tx.send(Ok(vec![snap])).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    _ = telemetry.notify.notified() => {
                        let latest = telemetry
                            .state
                            .lock()
                            .ok()
                            .and_then(|s| Some((s.last_sampled_at_ms?, s.last_snapshot.clone()?)));
                        if let Some((ms, snap)) = latest {
                            if Some(ms) != last_sent_at {
                                last_sent_at = Some(ms);
                                if tx.send(Ok(vec![snap])).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        });
        rx
    }

    pub fn retry(&self) -> Value {
        let snapshot = self.sample_now();
        self.notify.notify_waiters();
        json!({
            "accepted": true,
            "snapshot": snapshot,
        })
    }

    pub fn telemetry_history(&self, payload: &Value) -> Result<Value, RpcFailure> {
        let (window_ms, bucket_ms) = parse_history_window(payload)?;
        self.ensure_recent_sample();
        let desktop = self.background_activity.desktop_telemetry_snapshot();
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let now_ms = Utc::now().timestamp_millis();
        let read_at = iso_from_ms(now_ms);
        let window_start = now_ms - window_ms;
        let samples: Vec<&RetainedSample> = state
            .history
            .iter()
            .filter(|sample| sample.sampled_at_ms >= window_start)
            .collect();

        let buckets = aggregate_telemetry_buckets(&samples, window_start, now_ms, bucket_ms);
        let top_processes = aggregate_telemetry_top_processes(&samples);
        let health = state
            .last_snapshot
            .as_ref()
            .and_then(|s| s.get("health"))
            .cloned()
            .unwrap_or_else(|| state.build_health(now_ms, &read_at, &desktop, 0, 0, 0));

        Ok(json!({
            "readAt": read_at,
            "windowMs": window_ms,
            "bucketMs": bucket_ms,
            "sampleIntervalMs": DEFAULT_SAMPLE_INTERVAL_MS,
            "retainedSampleCount": state.history.len(),
            "buckets": buckets,
            "topProcesses": top_processes,
            "health": health,
        }))
    }

    pub fn process_diagnostics(&self) -> Value {
        let _ = self.sample_now();
        let now_ms = Utc::now().timestamp_millis();
        let read_at = iso_from_ms(now_ms);
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let backend: Vec<&ProcessEntry> = state
            .last_entries
            .iter()
            .filter(|e| is_backend_category(e.category))
            .collect();
        let total_rss_bytes: u64 = backend.iter().map(|e| e.resident_bytes).sum();
        let total_cpu_percent = round2(backend.iter().map(|e| e.cpu_percent).sum());
        let processes: Vec<Value> = backend
            .iter()
            .map(|e| e.to_diagnostics_json())
            .collect();

        json!({
            "serverPid": std::process::id(),
            "readAt": read_at,
            "processCount": processes.len(),
            "totalRssBytes": total_rss_bytes,
            "totalCpuPercent": total_cpu_percent,
            "processes": processes,
            "error": encode_option(None),
        })
    }

    pub fn process_resource_history(&self, payload: &Value) -> Result<Value, RpcFailure> {
        let (window_ms, bucket_ms) = parse_history_window(payload)?;
        self.ensure_recent_sample();
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let now_ms = Utc::now().timestamp_millis();
        let read_at = iso_from_ms(now_ms);
        let window_start = now_ms - window_ms;
        let samples: Vec<&RetainedSample> = state
            .history
            .iter()
            .filter(|sample| sample.sampled_at_ms >= window_start)
            .collect();

        let buckets = aggregate_process_buckets(&samples, window_start, now_ms, bucket_ms);
        let (top_processes, total_cpu_seconds_approx) = aggregate_process_top(&samples);

        Ok(json!({
            "readAt": read_at,
            "windowMs": window_ms,
            "bucketMs": bucket_ms,
            "sampleIntervalMs": DEFAULT_SAMPLE_INTERVAL_MS,
            "retainedSampleCount": state.history.len(),
            "totalCpuSecondsApprox": round2(total_cpu_seconds_approx),
            "buckets": buckets,
            "topProcesses": top_processes,
            "error": encode_option(None),
        }))
    }

    pub fn signal_process(&self, payload: &Value) -> Result<Value, RpcFailure> {
        let pid = payload["pid"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid_payload())?;
        let signal = payload["signal"]
            .as_str()
            .filter(|s| matches!(*s, "SIGINT" | "SIGKILL"))
            .ok_or_else(|| invalid_payload())?;
        let expected_start_time_ms = match payload.get("startTimeMs") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .ok_or_else(|| invalid_payload())?,
            ),
        };

        if pid == std::process::id() {
            return Ok(json!({
                "pid": pid,
                "signal": signal,
                "signaled": false,
                "message": encode_option(Some(Value::String(
                    "Cannot signal the T3 server root process.".to_owned()
                ))),
            }));
        }

        let _ = self.sample_now();
        let selected = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .last_entries
                .iter()
                .find(|entry| {
                    entry.pid == pid
                        && expected_start_time_ms
                            .is_none_or(|expected| expected == entry.start_time_ms)
                })
                .map(|entry| entry.category)
        };

        let Some(category) = selected else {
            return Ok(json!({
                "pid": pid,
                "signal": signal,
                "signaled": false,
                "message": encode_option(Some(Value::String(format!(
                    "Process {pid} no longer matches the selected process identity."
                )))),
            }));
        };

        if !is_signalable_descendant(category) {
            return Ok(json!({
                "pid": pid,
                "signal": signal,
                "signaled": false,
                "message": encode_option(Some(Value::String(format!(
                    "Process {pid} is not a signalable T3 backend descendant."
                )))),
            }));
        }

        #[cfg(unix)]
        {
            let sig_num = match signal {
                "SIGINT" => libc::SIGINT,
                "SIGKILL" => libc::SIGKILL,
                _ => return Err(invalid_payload()),
            };
            let rc = unsafe { libc::kill(pid as libc::pid_t, sig_num) };
            if rc == 0 {
                Ok(json!({
                    "pid": pid,
                    "signal": signal,
                    "signaled": true,
                    "message": encode_option(None),
                }))
            } else {
                let err = std::io::Error::last_os_error().to_string();
                Ok(json!({
                    "pid": pid,
                    "signal": signal,
                    "signaled": false,
                    "message": encode_option(Some(Value::String(err))),
                }))
            }
        }
        #[cfg(not(unix))]
        {
            Ok(json!({
                "pid": pid,
                "signal": signal,
                "signaled": false,
                "message": encode_option(Some(Value::String(
                    "Signaling child processes is only supported on Unix hosts.".to_owned()
                ))),
            }))
        }
    }

    fn ensure_recent_sample(&self) {
        let needs_sample = self
            .state
            .lock()
            .ok()
            .and_then(|s| s.last_sampled_at_ms)
            .is_none_or(|ms| Utc::now().timestamp_millis().saturating_sub(ms) > 2_000);
        if needs_sample {
            let _ = self.sample_now();
        }
    }
}

fn parse_history_window(payload: &Value) -> Result<(i64, i64), RpcFailure> {
    let window_ms = match payload.get("windowMs") {
        None | Some(Value::Null) => DEFAULT_HISTORY_WINDOW_MS,
        Some(v) => v
            .as_i64()
            .ok_or_else(|| invalid_payload())?
            .clamp(MIN_HISTORY_WINDOW_MS, MAX_HISTORY_WINDOW_MS),
    };
    let bucket_ms = match payload.get("bucketMs") {
        None | Some(Value::Null) => (window_ms / DEFAULT_BUCKET_COUNT).clamp(1_000, window_ms),
        Some(v) => v
            .as_i64()
            .ok_or_else(|| invalid_payload())?
            .clamp(1_000, window_ms),
    };
    Ok((window_ms, bucket_ms))
}

fn join_command(process: &sysinfo::Process, fallback_name: &str) -> String {
    let cmd = process.cmd();
    if cmd.is_empty() {
        process
            .exe()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_name.to_owned())
    } else {
        cmd.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[allow(clippy::type_complexity)]
fn extract_process_metrics(
    os_proc: Option<&sysinfo::Process>,
    electron_meta: Option<&crate::background_activity::DesktopElectronProcess>,
    electron_root_pid: Option<u32>,
    now_ms: i64,
) -> Option<(
    u64,
    u32,
    String,
    String,
    String,
    f64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
)> {
    match (os_proc, electron_meta) {
        (Some(proc_ref), meta) => {
            let name = proc_ref.name().to_string_lossy().into_owned();
            let command = join_command(proc_ref, &name);
            let start_time_ms = meta
                .map(|m| m.creation_time_ms)
                .filter(|ms| *ms > 0)
                .unwrap_or_else(|| proc_ref.start_time().saturating_mul(1000));
            let ppid = proc_ref.parent().map(|p| p.as_u32()).unwrap_or(0);
            let status = status_label(proc_ref.status()).to_owned();
            let cpu_percent = meta
                .map(|m| round2(m.cpu_percent))
                .filter(|v| *v > 0.0)
                .unwrap_or_else(|| round2(proc_ref.cpu_usage() as f64));
            let cpu_time_ms = proc_ref.accumulated_cpu_time().max(
                meta.and_then(|m| m.cumulative_cpu_seconds)
                    .map(|s| (s * 1000.0).round() as u64)
                    .unwrap_or(0),
            );
            let resident_bytes = proc_ref
                .memory()
                .max(meta.map(|m| m.resident_bytes).unwrap_or(0));
            let virtual_bytes = proc_ref.virtual_memory();
            let disk = proc_ref.disk_usage();
            let run_time_ms = proc_ref.run_time().saturating_mul(1000);
            Some((
                start_time_ms,
                ppid,
                name,
                command,
                status,
                cpu_percent,
                cpu_time_ms,
                resident_bytes,
                virtual_bytes,
                disk.total_read_bytes,
                disk.total_written_bytes,
                run_time_ms,
            ))
        }
        (None, Some(meta)) => {
            let ppid = if electron_root_pid == Some(meta.pid) {
                0
            } else {
                electron_root_pid.unwrap_or(0)
            };
            let name = meta.name.clone().unwrap_or_else(|| meta.kind.clone());
            let command = meta
                .service_name
                .clone()
                .unwrap_or_else(|| name.clone());
            let run_time_ms = if meta.creation_time_ms > 0 {
                (now_ms.max(0) as u64).saturating_sub(meta.creation_time_ms)
            } else {
                0
            };
            Some((
                meta.creation_time_ms,
                ppid,
                name,
                command,
                "running".to_owned(),
                round2(meta.cpu_percent),
                meta.cumulative_cpu_seconds
                    .map(|s| (s * 1000.0).round() as u64)
                    .unwrap_or(0),
                meta.resident_bytes,
                meta.resident_bytes,
                0,
                0,
                run_time_ms,
            ))
        }
        (None, None) => None,
    }
}

fn aggregate_telemetry_buckets(
    samples: &[&RetainedSample],
    window_start: i64,
    now_ms: i64,
    bucket_ms: i64,
) -> Vec<Value> {
    let mut grouped: BTreeMap<i64, Vec<&RetainedSample>> = BTreeMap::new();
    for &sample in samples {
        let index = ((sample.sampled_at_ms - window_start).max(0)) / bucket_ms;
        grouped.entry(index).or_default().push(sample);
    }
    grouped
        .into_iter()
        .map(|(index, items)| {
            let started_at = window_start + index * bucket_ms;
            let ended_at = (started_at + bucket_ms).min(now_ms);
            let count = items.len() as f64;
            let sum_cpu: f64 = items.iter().map(|s| s.all_cpu_percent).sum();
            let max_cpu = items
                .iter()
                .map(|s| s.all_cpu_percent)
                .fold(0.0_f64, f64::max);
            let max_rss = items.iter().map(|s| s.all_rss_bytes).max().unwrap_or(0);
            let io_read: u64 = items.iter().map(|s| s.all_io_read_delta_bytes).sum();
            let io_write: u64 = items.iter().map(|s| s.all_io_write_delta_bytes).sum();
            let max_procs = items
                .iter()
                .map(|s| s.all_process_count)
                .max()
                .unwrap_or(0);
            json!({
                "startedAt": iso_from_ms(started_at),
                "endedAt": iso_from_ms(ended_at),
                "avgCpuPercent": round2(sum_cpu / count),
                "maxCpuPercent": round2(max_cpu),
                "maxRssBytes": max_rss,
                "ioReadBytes": io_read,
                "ioWriteBytes": io_write,
                "maxProcessCount": max_procs,
            })
        })
        .collect()
}

fn aggregate_process_buckets(
    samples: &[&RetainedSample],
    window_start: i64,
    now_ms: i64,
    bucket_ms: i64,
) -> Vec<Value> {
    let mut grouped: BTreeMap<i64, Vec<&RetainedSample>> = BTreeMap::new();
    for &sample in samples {
        let index = ((sample.sampled_at_ms - window_start).max(0)) / bucket_ms;
        grouped.entry(index).or_default().push(sample);
    }
    grouped
        .into_iter()
        .map(|(index, items)| {
            let started_at = window_start + index * bucket_ms;
            let ended_at = (started_at + bucket_ms).min(now_ms);
            let count = items.len() as f64;
            let sum_cpu: f64 = items.iter().map(|s| s.backend_cpu_percent).sum();
            let max_cpu = items
                .iter()
                .map(|s| s.backend_cpu_percent)
                .fold(0.0_f64, f64::max);
            let max_rss = items
                .iter()
                .map(|s| s.backend_rss_bytes)
                .max()
                .unwrap_or(0);
            let max_procs = items
                .iter()
                .map(|s| s.backend_process_count)
                .max()
                .unwrap_or(0);
            json!({
                "startedAt": iso_from_ms(started_at),
                "endedAt": iso_from_ms(ended_at),
                "avgCpuPercent": round2(sum_cpu / count),
                "maxCpuPercent": round2(max_cpu),
                "maxRssBytes": max_rss,
                "maxProcessCount": max_procs,
            })
        })
        .collect()
}

struct ProcessAccum {
    pid: u32,
    start_time_ms: u64,
    ppid: u32,
    depth: u32,
    name: String,
    command: String,
    category: &'static str,
    first_seen_at_ms: i64,
    last_seen_at_ms: i64,
    current_cpu_percent: f64,
    sum_cpu_percent: f64,
    max_cpu_percent: f64,
    cpu_time_ms: u64,
    cpu_time_delta_ms: u64,
    current_rss_bytes: u64,
    peak_rss_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_semantics: &'static str,
    sample_count: u64,
}

fn collect_process_accum(samples: &[&RetainedSample], backend_only: bool) -> Vec<ProcessAccum> {
    let mut map: HashMap<(u32, u64), ProcessAccum> = HashMap::new();
    for &sample in samples {
        for proc_sample in &sample.processes {
            if backend_only && !is_backend_category(proc_sample.category) {
                continue;
            }
            let key = (proc_sample.pid, proc_sample.start_time_ms);
            map.entry(key)
                .and_modify(|acc| {
                    acc.ppid = proc_sample.ppid;
                    acc.depth = proc_sample.depth;
                    acc.name = proc_sample.name.clone();
                    acc.command = proc_sample.command.clone();
                    acc.category = proc_sample.category;
                    acc.last_seen_at_ms = sample.sampled_at_ms;
                    acc.current_cpu_percent = proc_sample.cpu_percent;
                    acc.sum_cpu_percent += proc_sample.cpu_percent;
                    acc.max_cpu_percent = acc.max_cpu_percent.max(proc_sample.cpu_percent);
                    acc.cpu_time_ms = acc.cpu_time_ms.max(proc_sample.cpu_time_ms);
                    acc.cpu_time_delta_ms = acc
                        .cpu_time_delta_ms
                        .saturating_add(proc_sample.cpu_time_delta_ms);
                    acc.current_rss_bytes = proc_sample.resident_bytes;
                    acc.peak_rss_bytes = acc.peak_rss_bytes.max(proc_sample.peak_resident_bytes);
                    acc.io_read_bytes = acc.io_read_bytes.saturating_add(proc_sample.io_read_delta_bytes);
                    acc.io_write_bytes = acc.io_write_bytes.saturating_add(proc_sample.io_write_delta_bytes);
                    acc.sample_count += 1;
                })
                .or_insert_with(|| ProcessAccum {
                    pid: proc_sample.pid,
                    start_time_ms: proc_sample.start_time_ms,
                    ppid: proc_sample.ppid,
                    depth: proc_sample.depth,
                    name: proc_sample.name.clone(),
                    command: proc_sample.command.clone(),
                    category: proc_sample.category,
                    first_seen_at_ms: sample.sampled_at_ms,
                    last_seen_at_ms: sample.sampled_at_ms,
                    current_cpu_percent: proc_sample.cpu_percent,
                    sum_cpu_percent: proc_sample.cpu_percent,
                    max_cpu_percent: proc_sample.cpu_percent,
                    cpu_time_ms: proc_sample.cpu_time_ms,
                    cpu_time_delta_ms: proc_sample.cpu_time_delta_ms,
                    current_rss_bytes: proc_sample.resident_bytes,
                    peak_rss_bytes: proc_sample.peak_resident_bytes,
                    io_read_bytes: proc_sample.io_read_delta_bytes,
                    io_write_bytes: proc_sample.io_write_delta_bytes,
                    io_semantics: proc_sample.io_semantics,
                    sample_count: 1,
                });
        }
    }
    let mut list: Vec<ProcessAccum> = map.into_values().collect();
    list.sort_by(|a, b| {
        b.peak_rss_bytes
            .cmp(&a.peak_rss_bytes)
            .then_with(|| {
                b.max_cpu_percent
                    .partial_cmp(&a.max_cpu_percent)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.pid.cmp(&b.pid))
    });
    list
}

fn aggregate_telemetry_top_processes(samples: &[&RetainedSample]) -> Vec<Value> {
    collect_process_accum(samples, false)
        .into_iter()
        .take(MAX_TOP_PROCESSES)
        .map(|acc| {
            let avg_cpu = if acc.sample_count > 0 {
                round2(acc.sum_cpu_percent / acc.sample_count as f64)
            } else {
                0.0
            };
            json!({
                "identity": { "pid": acc.pid, "startTimeMs": acc.start_time_ms },
                "ppid": acc.ppid,
                "depth": acc.depth,
                "name": acc.name,
                "command": acc.command,
                "category": acc.category,
                "firstSeenAt": iso_from_ms(acc.first_seen_at_ms),
                "lastSeenAt": iso_from_ms(acc.last_seen_at_ms),
                "currentCpuPercent": round2(acc.current_cpu_percent),
                "avgCpuPercent": avg_cpu,
                "maxCpuPercent": round2(acc.max_cpu_percent),
                "cpuTimeMs": acc.cpu_time_ms,
                "currentRssBytes": acc.current_rss_bytes,
                "peakRssBytes": acc.peak_rss_bytes,
                "ioReadBytes": acc.io_read_bytes,
                "ioWriteBytes": acc.io_write_bytes,
                "ioSemantics": acc.io_semantics,
                "sampleCount": acc.sample_count,
            })
        })
        .collect()
}

fn aggregate_process_top(samples: &[&RetainedSample]) -> (Vec<Value>, f64) {
    let list = collect_process_accum(samples, true);
    let total_cpu_seconds_approx: f64 = list
        .iter()
        .map(|acc| acc.cpu_time_delta_ms as f64 / 1000.0)
        .sum();
    let top = list
        .into_iter()
        .take(MAX_TOP_PROCESSES)
        .map(|acc| {
            let avg_cpu = if acc.sample_count > 0 {
                round2(acc.sum_cpu_percent / acc.sample_count as f64)
            } else {
                0.0
            };
            json!({
                "processKey": format!("{}:{}", acc.pid, acc.start_time_ms),
                "pid": acc.pid,
                "ppid": acc.ppid,
                "command": acc.command,
                "depth": acc.depth,
                "isServerRoot": acc.category == "server",
                "firstSeenAt": iso_from_ms(acc.first_seen_at_ms),
                "lastSeenAt": iso_from_ms(acc.last_seen_at_ms),
                "currentCpuPercent": round2(acc.current_cpu_percent),
                "avgCpuPercent": avg_cpu,
                "maxCpuPercent": round2(acc.max_cpu_percent),
                "cpuSecondsApprox": round2(acc.cpu_time_delta_ms as f64 / 1000.0),
                "currentRssBytes": acc.current_rss_bytes,
                "maxRssBytes": acc.peak_rss_bytes,
                "sampleCount": acc.sample_count,
            })
        })
        .collect();
    (top, total_cpu_seconds_approx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_includes_server_root_and_history_populates() {
        let activity = Arc::new(ClientActivity::default());
        let terminals = Arc::new(TerminalManager::default());
        let telemetry = ResourceTelemetry::new(activity, terminals);

        let snap = telemetry.sample_now();
        let pid = std::process::id();
        let processes = snap["processes"].as_array().expect("processes array");
        let root = processes
            .iter()
            .find(|p| p["identity"]["pid"] == json!(pid))
            .expect("server root present");
        assert_eq!(root["category"], "server");
        assert_eq!(root["depth"], 0);
        assert_eq!(snap["health"]["native"]["status"], "healthy");
        assert_eq!(snap["health"]["desktop"]["status"], "unavailable");

        let history = telemetry.telemetry_history(&json!({})).unwrap();
        assert!(!history["buckets"].as_array().unwrap().is_empty());
        assert!(!history["topProcesses"].as_array().unwrap().is_empty());

        let diag = telemetry.process_diagnostics();
        assert_eq!(diag["serverPid"], pid);
        assert!(diag["processCount"].as_u64().unwrap() >= 1);

        let proc_hist = telemetry.process_resource_history(&json!({})).unwrap();
        assert!(!proc_hist["topProcesses"].as_array().unwrap().is_empty());
    }

    #[test]
    fn signal_process_refuses_server_root_and_stale_or_non_descendant() {
        let activity = Arc::new(ClientActivity::default());
        let terminals = Arc::new(TerminalManager::default());
        let telemetry = ResourceTelemetry::new(activity, terminals);

        let root_refusal = telemetry
            .signal_process(&json!({
                "pid": std::process::id(),
                "startTimeMs": 0,
                "signal": "SIGINT"
            }))
            .unwrap();
        assert_eq!(root_refusal["signaled"], false);
        assert!(root_refusal["message"]["value"]
            .as_str()
            .unwrap()
            .contains("server root"));

        let missing_refusal = telemetry
            .signal_process(&json!({
                "pid": 999_999_999u64,
                "startTimeMs": 123,
                "signal": "SIGKILL"
            }))
            .unwrap();
        assert_eq!(missing_refusal["signaled"], false);
        assert!(missing_refusal["message"]["value"]
            .as_str()
            .unwrap()
            .contains("no longer matches"));
    }
}
