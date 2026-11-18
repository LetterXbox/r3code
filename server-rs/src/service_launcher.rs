//! Background service manager (`t3 service ...`) and supervisor (`__service-launcher`, `__service-preflight`).
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const SERVICE_PROTOCOL: u64 = 4;
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const EXIT_OWNED: i32 = 78;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServicePaths {
    pub base_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub state_path: PathBuf,
    pub versions_dir: PathBuf,
    pub env_path: PathBuf,
    pub stopping_marker: PathBuf,
    pub restart_pending: PathBuf,
    pub log_path: PathBuf,
}

impl ServicePaths {
    pub fn from_base_dir(base_dir: &Path) -> Self {
        let runtime_dir = base_dir.join("runtime");
        let logs_dir = base_dir.join("logs");
        Self {
            base_dir: base_dir.to_path_buf(),
            state_path: runtime_dir.join("service-state.json"),
            versions_dir: runtime_dir.join("versions"),
            env_path: base_dir.join("service.env"),
            stopping_marker: runtime_dir.join(".service-stopping"),
            restart_pending: runtime_dir.join(".restart-pending"),
            log_path: logs_dir.join("boot-service.log"),
            runtime_dir,
        }
    }
}

pub fn parse_semver(value: &str) -> Option<(u64, u64, u64)> {
    let core = value.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn systemd_unit_path(home: &Path) -> PathBuf {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    config_home.join("systemd/user/t3code.service")
}

pub fn launchd_plist_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents/com.t3tools.t3code.service.plist")
}

pub fn default_unit_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        launchd_plist_path(home)
    } else {
        systemd_unit_path(home)
    }
}

pub fn render_systemd_unit(launcher_bin: &Path, paths: &ServicePaths) -> String {
    format!(
        "[Unit]\n\
Description=T3 Code Server\n\
After=network-online.target\n\
\n\
[Service]\n\
Type=simple\n\
Restart=always\n\
RestartSec=5\n\
KillMode=mixed\n\
OOMPolicy=continue\n\
CPUWeight=1000\n\
IOWeight=1000\n\
MemoryLow=1536M\n\
OOMScoreAdjust=100\n\
ManagedOOMPreference=avoid\n\
StandardOutput=append:{log}\n\
StandardError=append:{log}\n\
Environment=T3CODE_HOME={home}\n\
Environment=T3_BOOT_SERVICE_UNIT=t3code.service\n\
ExecStart={bin} __service-launcher\n\
\n\
[Install]\n\
WantedBy=default.target\n",
        log = paths.log_path.display(),
        home = paths.base_dir.display(),
        bin = launcher_bin.display(),
    )
}

pub fn render_launchd_plist(launcher_bin: &Path, paths: &ServicePaths) -> String {
    let mut path_parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    for fallback in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        if !path_parts.iter().any(|p| p == fallback) {
            path_parts.push(fallback.to_owned());
        }
    }
    let path_env = path_parts.join(":");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
  <key>Label</key>\n\
  <string>com.t3tools.t3code.service</string>\n\
  <key>ProgramArguments</key>\n\
  <array>\n\
    <string>{bin}</string>\n\
    <string>__service-launcher</string>\n\
  </array>\n\
  <key>EnvironmentVariables</key>\n\
  <dict>\n\
    <key>PATH</key>\n\
    <string>{path_env}</string>\n\
    <key>T3CODE_HOME</key>\n\
    <string>{home}</string>\n\
    <key>T3_BOOT_SERVICE_UNIT</key>\n\
    <string>com.t3tools.t3code.service.plist</string>\n\
  </dict>\n\
  <key>RunAtLoad</key>\n\
  <true/>\n\
  <key>KeepAlive</key>\n\
  <true/>\n\
  <key>ThrottleInterval</key>\n\
  <integer>5</integer>\n\
  <key>ExitTimeOut</key>\n\
  <integer>90</integer>\n\
  <key>ProcessType</key>\n\
  <string>Interactive</string>\n\
  <key>StandardOutPath</key>\n\
  <string>{log}</string>\n\
  <key>StandardErrorPath</key>\n\
  <string>{log}</string>\n\
</dict>\n\
</plist>\n",
        bin = xml_escape(&launcher_bin.to_string_lossy()),
        path_env = xml_escape(&path_env),
        home = xml_escape(&paths.base_dir.to_string_lossy()),
        log = xml_escape(&paths.log_path.to_string_lossy()),
    )
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn unit_base_dir(unit_contents: &str) -> Option<PathBuf> {
    for line in unit_contents.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Environment=T3CODE_HOME=") {
            return Some(PathBuf::from(rest.trim()));
        }
    }
    let marker = "<key>T3CODE_HOME</key>";
    if let Some(idx) = unit_contents.find(marker) {
        let after = &unit_contents[idx + marker.len()..];
        if let Some(start) = after.find("<string>") {
            let rest = &after[start + "<string>".len()..];
            if let Some(end) = rest.find("</string>") {
                return Some(PathBuf::from(&rest[..end]));
            }
        }
    }
    None
}

pub fn parse_service_env(content: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, val)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if matches!(
            key,
            "PATH" | "T3CODE_HOME" | "T3_BOOT_SERVICE_UNIT" | "T3_SERVICE_LAUNCHER_CONTEXT"
        ) || key.is_empty()
        {
            continue;
        }
        let val = val.trim().trim_matches('"').trim_matches('\'');
        map.insert(key.to_owned(), val.to_owned());
    }
    map
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(content).map_err(|e| e.to_string())?;
        let _ = file.sync_all();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn read_service_state(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let val: Value = serde_json::from_str(&raw).map_err(|e| format!("Invalid service-state.json: {e}"))?;
    Ok(Some(val))
}

pub fn write_service_state(path: &Path, state: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(path, text.as_bytes())
}

fn pin_runtime_binary(paths: &ServicePaths, version: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let version_dir = paths.versions_dir.join(version);
    fs::create_dir_all(&version_dir).map_err(|e| e.to_string())?;
    let target_name = if cfg!(windows) { "t3.exe" } else { "t3code" };
    let target = version_dir.join(target_name);
    let marker = version_dir.join(".install-complete");
    if !marker.exists() || !target.exists() {
        let tmp = version_dir.join(format!("{target_name}.tmp.{}", uuid::Uuid::new_v4()));
        fs::copy(&exe, &tmp).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
        }
        fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        write_atomic(&marker, version.as_bytes())?;
    }
    Ok(target)
}

fn parse_service_args(args: &[String]) -> Result<(Option<PathBuf>, bool), String> {
    let mut base_dir = None;
    let mut allow_downgrade = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--base-dir" => {
                i += 1;
                let val = args.get(i).ok_or("--base-dir requires a path")?;
                base_dir = Some(PathBuf::from(val));
            }
            arg if arg.starts_with("--base-dir=") => {
                base_dir = Some(PathBuf::from(&arg["--base-dir=".len()..]));
            }
            "--allow-downgrade" => allow_downgrade = true,
            "--yes" | "--undo" => {}
            other => return Err(format!("Unknown service flag: {other}")),
        }
        i += 1;
    }
    Ok((base_dir, allow_downgrade))
}

fn resolve_base_dir(home: &Path, cwd: &Path, flag: Option<PathBuf>) -> PathBuf {
    let raw = flag
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| std::env::var("T3CODE_HOME").ok().filter(|s| !s.trim().is_empty()));
    crate::runtime::resolve_base_dir(raw.as_deref(), home, cwd)
}

#[cfg(target_os = "macos")]
fn macos_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(target_os = "macos"))]
fn macos_uid() -> u32 {
    0
}

fn run_systemctl(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run systemctl --user {}: {e}", args.join(" ")))
}

pub fn run_service_cli(args: &[String], home: &Path, cwd: &Path) -> Result<String, (u8, String)> {
    let Some(sub) = args.first().map(String::as_str) else {
        return Ok("Usage: t3 service <install|restart|uninstall|status|update> [--base-dir <dir>] [--allow-downgrade]\n".into());
    };
    let (flag_base, allow_downgrade) = parse_service_args(&args[1..]).map_err(|e| (2, e))?;
    let base_dir = resolve_base_dir(home, cwd, flag_base);
    let paths = ServicePaths::from_base_dir(&base_dir);
    let unit_path = default_unit_path(home);
    let version = env!("CARGO_PKG_VERSION");

    match sub {
        "install" | "update" => {
            if sub == "update" {
                eprintln!("Note: `t3 service update` is deprecated; use `t3 service install`.");
            }
            if let Ok(Some(existing)) = read_service_state(&paths.state_path) {
                if let Some(active) = existing["activeVersion"].as_str() {
                    if !allow_downgrade {
                        if let (Some(cur), Some(new)) = (parse_semver(active), parse_semver(version)) {
                            if new < cur {
                                return Err((1, format!("Refusing downgrade from {active} to {version} without --allow-downgrade.")));
                            }
                        }
                    }
                }
            }
            fs::create_dir_all(&paths.runtime_dir).map_err(|e| (1, e.to_string()))?;
            if let Some(log_parent) = paths.log_path.parent() {
                fs::create_dir_all(log_parent).map_err(|e| (1, e.to_string()))?;
            }
            if !paths.env_path.exists() {
                write_atomic(&paths.env_path, b"T3CODE_LAN=false\n").map_err(|e| (1, e))?;
            } else {
                let raw = fs::read_to_string(&paths.env_path).unwrap_or_default();
                let parsed = parse_service_env(&raw);
                if !parsed.contains_key("T3CODE_LAN") && !parsed.contains_key("T3CODE_HOST") {
                    let mut updated = raw;
                    if !updated.is_empty() && !updated.ends_with('\n') {
                        updated.push('\n');
                    }
                    updated.push_str("T3CODE_LAN=false\n");
                    write_atomic(&paths.env_path, updated.as_bytes()).map_err(|e| (1, e))?;
                }
            }
            let launcher_bin = pin_runtime_binary(&paths, version).map_err(|e| (1, e))?;
            write_service_state(
                &paths.state_path,
                &json!({
                    "protocol": SERVICE_PROTOCOL,
                    "activeVersion": version,
                }),
            )
            .map_err(|e| (1, e))?;

            let unit_content = if cfg!(target_os = "macos") {
                render_launchd_plist(&launcher_bin, &paths)
            } else {
                render_systemd_unit(&launcher_bin, &paths)
            };
            write_atomic(&unit_path, unit_content.as_bytes()).map_err(|e| (1, e))?;

            if cfg!(target_os = "linux") {
                if let Ok(out) = run_systemctl(&["daemon-reload"]) {
                    if out.status.success() {
                        let _ = run_systemctl(&["enable", "t3code.service"]);
                        let _ = run_systemctl(&["restart", "t3code.service"]);
                    }
                }
            } else if cfg!(target_os = "macos") {
                let uid = macos_uid();
                let target = format!("gui/{uid}/com.t3tools.t3code.service");
                let _ = Command::new("launchctl").args(["bootout", &target]).output();
                let _ = Command::new("launchctl").args(["enable", &target]).output();
                let _ = Command::new("launchctl")
                    .args(["bootstrap", &format!("gui/{uid}"), &unit_path.to_string_lossy()])
                    .output();
            }
            Ok(format!(
                "Installed T3 Code service (v{version}) at {}\nUnit: {}\n",
                paths.base_dir.display(),
                unit_path.display()
            ))
        }
        "restart" => {
            if !unit_path.exists() {
                return Ok("T3 Code service is not installed.\n".into());
            }
            if let Ok(raw) = fs::read_to_string(&unit_path) {
                if let Some(unit_home) = unit_base_dir(&raw) {
                    if unit_home != paths.base_dir {
                        return Err((1, format!("Service unit serves {} rather than {}.", unit_home.display(), paths.base_dir.display())));
                    }
                }
            }
            let _ = fs::remove_file(&paths.restart_pending);
            if cfg!(target_os = "linux") {
                let out = run_systemctl(&["restart", "t3code.service"]).map_err(|e| (1, e))?;
                if !out.status.success() {
                    return Err((1, String::from_utf8_lossy(&out.stderr).into_owned()));
                }
            } else if cfg!(target_os = "macos") {
                let uid = macos_uid();
                let target = format!("gui/{uid}/com.t3tools.t3code.service");
                let _ = Command::new("launchctl").args(["kickstart", "-k", &target]).output();
            }
            Ok("Restarted T3 Code service.\n".into())
        }
        "uninstall" => {
            if !unit_path.exists() {
                return Ok("T3 Code service is not installed.\n".into());
            }
            if let Ok(raw) = fs::read_to_string(&unit_path) {
                if let Some(unit_home) = unit_base_dir(&raw) {
                    if unit_home != paths.base_dir {
                        return Err((1, format!("Refusing uninstall: unit serves {} rather than {}.", unit_home.display(), paths.base_dir.display())));
                    }
                }
            }
            if cfg!(target_os = "linux") {
                let _ = run_systemctl(&["disable", "--now", "t3code.service"]);
            } else if cfg!(target_os = "macos") {
                let uid = macos_uid();
                let target = format!("gui/{uid}/com.t3tools.t3code.service");
                let _ = Command::new("launchctl").args(["bootout", &target]).output();
            }
            let _ = fs::remove_file(&unit_path);
            if cfg!(target_os = "linux") {
                let _ = run_systemctl(&["daemon-reload"]);
            }
            Ok(format!("Uninstalled T3 Code service unit at {}.\n", unit_path.display()))
        }
        "status" => {
            let installed = unit_path.exists();
            let state = read_service_state(&paths.state_path).ok().flatten();
            let installed_version = state
                .as_ref()
                .and_then(|s| s["activeVersion"].as_str())
                .unwrap_or("none");
            let mut problems = Vec::<&str>::new();
            if paths.restart_pending.exists() {
                problems.push("restart-pending");
            }
            if installed && cfg!(target_os = "linux") {
                match run_systemctl(&["is-enabled", "t3code.service"]) {
                    Ok(out) if !out.status.success() => problems.push("service-disabled"),
                    Err(_) => problems.push("user-manager-unavailable"),
                    _ => {}
                }
                if let Ok(out) = run_systemctl(&["is-active", "t3code.service"]) {
                    if !out.status.success() {
                        problems.push("service-stopped");
                    }
                }
            }
            Ok(format!(
                "Installed: {installed}\nVersion: {installed_version}\nUnit: {}\nLogs: {}\nProblems: {}\n",
                unit_path.display(),
                paths.log_path.display(),
                if problems.is_empty() { "none".to_owned() } else { problems.join(", ") }
            ))
        }
        other => Err((2, format!("Unknown service subcommand: {other}"))),
    }
}

fn rotate_log_if_needed(log_path: &Path) {
    if let Ok(meta) = fs::metadata(log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let rotated = log_path.with_extension("log.1");
            let _ = fs::rename(log_path, rotated);
        }
    }
}

pub fn run_launcher(args: &[String], home: &Path, cwd: &Path) -> Result<u8, String> {
    let (flag_base, _) = parse_service_args(
        &args
            .iter()
            .enumerate()
            .filter_map(|(i, a)| {
                if (a == "--log-file" || a == "--service-unit")
                    || (i > 0 && (args[i - 1] == "--log-file" || args[i - 1] == "--service-unit"))
                {
                    None
                } else {
                    Some(a.clone())
                }
            })
            .collect::<Vec<_>>(),
    )?;
    let base_dir = resolve_base_dir(home, cwd, flag_base);
    let paths = ServicePaths::from_base_dir(&base_dir);
    let _ = fs::remove_file(&paths.stopping_marker);
    rotate_log_if_needed(&paths.log_path);

    let state = read_service_state(&paths.state_path)?.unwrap_or_else(|| {
        json!({
            "protocol": SERVICE_PROTOCOL,
            "activeVersion": env!("CARGO_PKG_VERSION"),
        })
    });
    let active_version = state["activeVersion"]
        .as_str()
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_owned();
    let child_bin = {
        let pinned = paths
            .versions_dir
            .join(&active_version)
            .join(if cfg!(windows) { "t3.exe" } else { "t3code" });
        if pinned.exists() {
            pinned
        } else {
            std::env::current_exe().map_err(|e| e.to_string())?
        }
    };
    let env_vars = fs::read_to_string(&paths.env_path)
        .map(|s| parse_service_env(&s))
        .unwrap_or_default();
    let context = json!({
        "protocol": SERVICE_PROTOCOL,
        "childVersion": active_version,
        "update": state.get("update").cloned().unwrap_or(Value::Null),
    });

    loop {
        rotate_log_if_needed(&paths.log_path);
        let mut cmd = Command::new(&child_bin);
        cmd.args([
            "serve",
            "--base-dir",
            &paths.base_dir.to_string_lossy(),
            "--no-browser",
        ])
        .envs(&env_vars)
        .env("T3CODE_HOME", &paths.base_dir)
        .env("T3_SERVICE_LAUNCHER_CONTEXT", context.to_string())
        .stdin(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn server: {e}"))?;
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.code() == Some(EXIT_OWNED) {
            std::thread::sleep(Duration::from_secs(30));
            continue;
        }
        return Ok(status.code().unwrap_or(1) as u8);
    }
}

pub fn run_preflight(args: &[String]) -> Result<String, (u8, String)> {
    let mut db_path: Option<PathBuf> = None;
    let mut protocol: Option<u64> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--database-path" => {
                i += 1;
                db_path = args.get(i).map(PathBuf::from);
            }
            "--launcher-protocol" => {
                i += 1;
                protocol = args.get(i).and_then(|v| v.parse::<u64>().ok());
            }
            other => return Err((2, format!("Unknown preflight flag: {other}"))),
        }
        i += 1;
    }
    let Some(db_path) = db_path else {
        return Err((2, "--database-path is required".into()));
    };
    let version = env!("CARGO_PKG_VERSION");
    if protocol.is_some_and(|p| p > SERVICE_PROTOCOL) {
        return Ok(json!({
            "version": version,
            "status": "blocked",
            "reason": format!("Unsupported launcher protocol {protocol:?}")
        })
        .to_string());
    }
    match crate::database::open_writer(&db_path) {
        Ok(mut db) => match crate::migrations::run_ported_migrations(&mut db) {
            Ok(_) => Ok(json!({"version": version, "status": "ready"}).to_string()),
            Err(err) => Ok(json!({
                "version": version,
                "status": "blocked",
                "reason": err.to_string()
            })
            .to_string()),
        },
        Err(err) => Ok(json!({
            "version": version,
            "status": "blocked",
            "reason": err.to_string()
        })
        .to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_and_plist_render_with_expected_home_and_env() {
        let dir = std::env::temp_dir().join(format!("t3-svc-test-{}", uuid::Uuid::new_v4()));
        let paths = ServicePaths::from_base_dir(&dir);
        let bin = Path::new("/usr/local/bin/t3code");
        let unit = render_systemd_unit(bin, &paths);
        assert!(unit.contains("ExecStart=/usr/local/bin/t3code __service-launcher"));
        assert_eq!(unit_base_dir(&unit).as_deref(), Some(dir.as_path()));
        let plist = render_launchd_plist(bin, &paths);
        assert!(plist.contains("<string>com.t3tools.t3code.service</string>"));
        assert_eq!(unit_base_dir(&plist).as_deref(), Some(dir.as_path()));
    }

    #[test]
    fn service_env_ignores_protected_keys_and_parses_values() {
        let parsed = parse_service_env(
            "# comment\nPATH=/evil\nT3CODE_HOME=/bad\nT3CODE_LAN = true\nFOO=\"bar\"\n",
        );
        assert!(!parsed.contains_key("PATH"));
        assert!(!parsed.contains_key("T3CODE_HOME"));
        assert_eq!(parsed.get("T3CODE_LAN").map(String::as_str), Some("true"));
        assert_eq!(parsed.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn preflight_reports_ready_on_valid_database() {
        let dir = std::env::temp_dir().join(format!("t3-preflight-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("statev2.sqlite");
        let out = run_preflight(&[
            "--database-path".into(),
            db.to_string_lossy().into_owned(),
            "--launcher-protocol".into(),
            "4".into(),
        ])
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "ready");
        let _ = fs::remove_dir_all(dir);
    }
}
