//! CLI bootstrap for the implemented server surfaces.
use std::{env, path::PathBuf, process::ExitCode};
use t3code_server::{
    config::{self, ConfigInput, Mode},
    ownership::{OwnershipError, OwnershipLock},
};

const HELP: &str = "t3 - T3 Code server\n\nUsage: t3 [start|serve] [options] [cwd]\n\n  start              Start server\n  serve              Start headlessly\n  --base-dir <path>  Select the T3 home\n  --mode <mode>      web or desktop\n  --host <host>      Bind host\n  --port <port>      Bind port (1-65535)\n  --dev-url <url>    Development web URL\n  --no-browser       Do not open a browser\n  --lan[=true|false] Enable private network access\n  --help             Show this help\n  --version          Show version\n";
#[derive(Debug)]
struct Args {
    flags: ConfigInput,
    cwd: Option<String>,
    headless: bool,
    bootstrap_fd: Option<i32>,
}
fn boolean(value: &str) -> Result<bool, String> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(format!("Invalid boolean: {value}")),
    }
}
fn port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| format!("Invalid port: {value}"))
}
fn mode(value: &str) -> Result<Mode, String> {
    match value {
        "web" => Ok(Mode::Web),
        "desktop" => Ok(Mode::Desktop),
        _ => Err(format!("Invalid mode: {value}")),
    }
}
fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut flags = ConfigInput::default();
    let mut headless = false;
    let mut cwd = None;
    let mut bootstrap_fd = None;
    let mut index = 0;
    if let Some(first) = args.first() {
        match first.as_str() {
            "start" => index += 1,
            "serve" => {
                headless = true;
                index += 1;
            }
            _ => {}
        }
    }
    while index < args.len() {
        let arg = &args[index];
        if arg.starts_with("--") {
            let (flag, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(a, b)| (a, Some(b)));
            let mut next = || -> Result<String, String> {
                if let Some(v) = inline {
                    return Ok(v.to_owned());
                }
                index += 1;
                args.get(index)
                    .cloned()
                    .ok_or_else(|| format!("{flag} requires a value"))
            };
            match flag {
                "--mode" => flags.mode = Some(mode(&next()?)?),
                "--port" => flags.port = Some(port(&next()?)?),
                "--host" => flags.host = Some(next()?),
                "--base-dir" => flags.base_dir = Some(next()?),
                "--bootstrap-fd" => {
                    bootstrap_fd = Some(
                        next()?
                            .parse::<i32>()
                            .map_err(|_| "Invalid bootstrap descriptor")?,
                    )
                }
                "--dev-url" => {
                    let value = next()?;
                    url::Url::parse(&value).map_err(|_| format!("Invalid dev URL: {value}"))?;
                    flags.dev_url = Some(value);
                }
                "--tailscale-serve-port" => flags.tailscale_port = Some(port(&next()?)?),
                "--lan" => flags.lan = Some(inline.map_or(Ok(true), boolean)?),
                "--no-lan" => {
                    if inline.is_some() {
                        return Err(format!("Unexpected value for {flag}"));
                    }
                    flags.lan = Some(false);
                }
                "--no-browser" => flags.no_browser = Some(inline.map_or(Ok(true), boolean)?),
                "--tailscale-serve" => {
                    flags.tailscale_serve = Some(inline.map_or(Ok(true), boolean)?)
                }
                "--log-websocket-events" | "--log-ws-events" => {
                    flags.log_websocket_events = Some(inline.map_or(Ok(true), boolean)?)
                }
                "--auto-bootstrap-project-from-cwd" if !headless => {
                    flags.auto_bootstrap = Some(inline.map_or(Ok(true), boolean)?)
                }
                _ => return Err(format!("Unsupported option: {flag}")),
            }
        } else {
            if cwd.is_some() {
                return Err(format!("Unexpected argument: {arg}"));
            }
            let explicit = arg == "."
                || arg == ".."
                || arg.starts_with('~')
                || arg.contains('/')
                || arg.contains('\\')
                || (arg.len() >= 2 && arg.as_bytes()[1] == b':');
            if !explicit && !std::path::Path::new(arg).is_dir() {
                return Err(format!("Unknown command \"{arg}\". Use \"t3 --help\" for commands or an explicit path such as \"t3 ./my-project\" for a new directory."));
            }
            cwd = Some(arg.clone());
        }
        index += 1;
    }
    Ok(Args {
        flags,
        cwd,
        headless,
        bootstrap_fd,
    })
}
fn env_input() -> Result<ConfigInput, String> {
    let text = |name| env::var(name).ok();
    let optional_bool = |name| text(name).map(|v| boolean(&v)).transpose();
    let optional_port = |name| text(name).map(|v| port(&v)).transpose();
    Ok(ConfigInput {
        mode: text("T3CODE_MODE").map(|v| mode(&v)).transpose()?,
        port: optional_port("T3CODE_PORT")?,
        host: text("T3CODE_HOST"),
        base_dir: text("T3CODE_HOME"),
        dev_url: text("VITE_DEV_SERVER_URL"),
        no_browser: optional_bool("T3CODE_NO_BROWSER")?,
        auto_bootstrap: optional_bool("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")?,
        log_websocket_events: optional_bool("T3CODE_LOG_WS_EVENTS")?,
        tailscale_serve: optional_bool("T3CODE_TAILSCALE_SERVE")?,
        tailscale_port: optional_port("T3CODE_TAILSCALE_SERVE_PORT")?,
        lan: optional_bool("T3CODE_LAN")?,
    })
}
fn run(args: Vec<String>) -> Result<(), (u8, String)> {
    if args.iter().any(|a| a == "--help" || a == "-h") || args == ["help"] {
        print!("{HELP}");
        return Ok(());
    }
    if args == ["--version"] || args == ["-V"] {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "theme") {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| (1, "Home directory is unavailable".into()))?;
        let cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
        let output = t3code_server::theme_cli::run(&args[1..], &home, &cwd).map_err(|e| (1, e))?;
        print!("{output}");
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "doctor") {
        return run_doctor(&args[1..]);
    }
    if args.first().is_some_and(|arg| arg == "auth") {
        return run_auth(&args[1..]);
    }
    if args.first().is_some_and(|arg| arg == "service") {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| (1, "Home directory is unavailable".into()))?;
        let cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
        let output = t3code_server::service_launcher::run_service_cli(&args[1..], &home, &cwd)?;
        print!("{output}");
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "__service-launcher") {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| (1, "Home directory is unavailable".into()))?;
        let cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
        let code = t3code_server::service_launcher::run_launcher(&args[1..], &home, &cwd)
            .map_err(|e| (1, e))?;
        if code == 0 {
            return Ok(());
        }
        return Err((code, String::new()));
    }
    if args.first().is_some_and(|arg| arg == "__service-preflight") {
        let output = t3code_server::service_launcher::run_preflight(&args[1..])?;
        println!("{output}");
        return Ok(());
    }
    let parsed = parse_args(&args).map_err(|e| (2, e))?;
    let environ = env_input().map_err(|e| (2, e))?;
    let fd = match parsed.bootstrap_fd {
        Some(fd) => Some(fd),
        None => env::var("T3CODE_BOOTSTRAP_FD")
            .ok()
            .map(|v| v.parse::<i32>())
            .transpose()
            .map_err(|_| (2, "Invalid bootstrap descriptor".to_owned()))?,
    };
    let bootstrap = fd
        .map(t3code_server::bootstrap::read)
        .transpose()
        .map_err(|e| (1, e.to_owned()))?
        .flatten();
    if let Some(value) = &environ.dev_url {
        url::Url::parse(value).map_err(|_| (2, "Invalid VITE_DEV_SERVER_URL".into()))?;
    }
    let process_cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| (1, "Home directory is unavailable".into()))?;
    let cwd = parsed
        .cwd
        .as_deref()
        .map(|value| t3code_server::runtime::resolve_base_dir(Some(value), &home, &process_cwd))
        .unwrap_or_else(|| process_cwd.clone());
    let mut config = config::resolve(
        &parsed.flags,
        &environ,
        bootstrap
            .as_ref()
            .map(|b| &b.config)
            .unwrap_or(&ConfigInput::default()),
        &home,
        &process_cwd,
        parsed.headless,
        env::var_os("T3_SERVICE_LAUNCHER_CONTEXT").is_some(),
    )
    .map_err(|e| (2, e.into()))?;
    if let Some(bootstrap) = bootstrap {
        config.desktop_bootstrap_token = Some(bootstrap.token);
        config.desktop_bootstrap_secret = bootstrap.secret;
        config.desktop_telemetry_fd = bootstrap.telemetry_fd;
        config.desktop_telemetry_control_fd = bootstrap.telemetry_control_fd;
        config.desktop_otlp_traces_url = bootstrap.otlp_traces_url;
    }
    let warning = config
        .paths
        .ensure_directories(&cwd)
        .map_err(|e| (1, format!("Failed to prepare server directories: {e}")))?;
    if let Some(error) = warning {
        eprintln!("Warning: could not secure state directory: {error}");
    }
    let _owner = OwnershipLock::acquire(&config.paths.state_dir).map_err(|e| {
        let code = if matches!(
            e,
            OwnershipError::AlreadyOwned(_) | OwnershipError::OlderBootService(_)
        ) {
            78
        } else {
            1
        };
        (code, e.to_string())
    })?;
    t3code_server::ownership::check_older_boot_service(
        &config.paths.base_dir,
        &config.paths.state_dir,
        &home,
        env::var_os("T3_SERVICE_LAUNCHER_CONTEXT").is_some(),
    )
    .map_err(|e| (78, e.to_string()))?;
    #[cfg(unix)]
    let launcher = if config.mode == Mode::Desktop && config.desktop_bootstrap_token.is_some() {
        let parent = unsafe { libc::getppid() };
        (parent > 1).then_some(parent)
    } else {
        None
    };
    let runtime = tokio::runtime::Runtime::new().map_err(|e| (1, e.to_string()))?;
    runtime
        .block_on(t3code_server::server::serve(
            config,
            env::var_os("T3_SERVICE_LAUNCHER_CONTEXT").is_some(),
            async move {
                let shutdown = t3code_server::runtime_http::StartupReadiness::default();
                #[cfg(unix)]
                if let Some(parent) = launcher {
                    tokio::select! {
                        _ = shutdown.shutdown_signal() => {},
                        _ = async {
                            loop {
                                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                if unsafe { libc::getppid() } != parent { break; }
                            }
                        } => eprintln!("Desktop launcher is gone; shutting down the backend."),
                    }
                } else {
                    shutdown.shutdown_signal().await;
                }
                #[cfg(not(unix))]
                shutdown.shutdown_signal().await;
            },
        ))
        .map_err(|e| (1, format!("Server startup or serving failed: {e}")))
}
fn run_doctor(args: &[String]) -> Result<(), (u8, String)> {
    let mut base = None;
    let mut fix = false;
    let mut dry = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                println!("Usage: t3 doctor [--base-dir <path>] [--fix] [--dry-run]\n\nInspect and repair the T3 Code database.\n  --fix      Apply recommended repairs without prompting\n  --dry-run  Show repairs without changing anything\n  --base-dir Select the T3 home");
                return Ok(());
            }
            "--fix" => fix = true,
            "--dry-run" => dry = true,
            "--base-dir" => {
                i += 1;
                base = Some(
                    args.get(i)
                        .ok_or((2, "--base-dir requires a value".into()))?
                        .clone(),
                );
            }
            a if a.starts_with("--base-dir=") => base = Some(a[11..].to_owned()),
            a => return Err((2, format!("Unsupported option: {a}"))),
        }
        i += 1;
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or((1, "Home directory is unavailable".into()))?;
    let cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
    let env_base = env::var("T3CODE_HOME").ok();
    let base = t3code_server::runtime::resolve_base_dir(
        base.as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| env_base.as_deref().filter(|s| !s.trim().is_empty())),
        &home,
        &cwd,
    );
    let state = base.join("userdata");
    let path = state.join("statev2.sqlite");
    let status = t3code_server::database_maintenance::inspect(&path).map_err(|e| (1, e))?;
    fn bytes(n: u64) -> String {
        if n >= 1024 * 1024 * 1024 {
            format!("{:.2} GiB", n as f64 / 1073741824.0)
        } else if n >= 1024 * 1024 {
            format!("{:.1} MiB", n as f64 / 1048576.0)
        } else {
            format!("{} KiB", n.div_ceil(1024))
        }
    }
    println!(
        "Database: {}, {} reclaimable.",
        bytes(status.database_bytes),
        bytes(status.reclaimable_bytes)
    );
    if let Some(legacy) = status.legacy_database_bytes {
        println!(
            "Database from before 0.1.0: {}, kept for rolling back.",
            bytes(legacy)
        );
        match &status.legacy_only_records {
            None => println!("  Could not check for missing projects or threads. Keep the old database."),
            Some(counts) if counts.projects > 0 || counts.threads > 0 => println!(
                "  The current database is missing legacy records. Projects missing: {}. Threads missing: {}. Keep the old database for recovery.",
                counts.projects, counts.threads
            ),
            Some(_) => {}
        }
    }
    let legacy_can_remove = status
        .legacy_only_records
        .as_ref()
        .is_some_and(|counts| counts.projects == 0 && counts.threads == 0);
    let candidate = !status.incremental_vacuum_enabled || status.reclaimable_bytes > 0;
    let recommended =
        !status.incremental_vacuum_enabled || status.reclaimable_bytes >= 1024 * 1024 * 1024;
    if !candidate && !legacy_can_remove {
        println!("Nothing to repair.");
        return Ok(());
    }
    if candidate {
        println!("\nReclaim database space{}\n  Rewrites the whole {} database and may need temporary disk space.", if recommended { " (recommended)" } else { "" }, bytes(status.database_bytes));
    }
    if legacy_can_remove {
        println!("\nDelete the database from before 0.1.0\n  Warning: older versions will no longer have your threads or settings.");
    }
    if dry {
        println!("\nDry run: nothing changed.");
        return Ok(());
    }
    let (run_database, run_legacy) = if fix {
        (candidate && recommended, false)
    } else {
        use std::io::{IsTerminal, Write};
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            println!(
                "\nRun in a terminal to choose repairs, or pass --fix for the recommended ones."
            );
            return Ok(());
        }
        println!("\nChoose repairs (comma-separated numbers; Enter selects recommended repairs):");
        if candidate {
            println!(
                "  1. Reclaim database space{}",
                if recommended { " (recommended)" } else { "" }
            );
        }
        if legacy_can_remove {
            println!("  2. Delete the database from before 0.1.0");
        }
        print!("Selection (0 for none): ");
        std::io::stdout().flush().map_err(|e| (1, e.to_string()))?;
        let mut input = String::new();
        if std::io::stdin()
            .read_line(&mut input)
            .map_err(|e| (1, e.to_string()))?
            == 0
        {
            println!("\nNo repairs selected; nothing changed.");
            return Ok(());
        }
        let selection = input.trim();
        if selection.is_empty() {
            (candidate && recommended, false)
        } else {
            let choices: Vec<&str> = selection.split(',').map(str::trim).collect();
            if choices
                .iter()
                .any(|choice| !matches!(*choice, "0" | "1" | "2"))
                || (choices.contains(&"1") && !candidate)
                || (choices.contains(&"2") && !legacy_can_remove)
                || (choices.contains(&"0") && choices.len() != 1)
            {
                return Err((2, "Invalid repair selection".into()));
            }
            (choices.contains(&"1"), choices.contains(&"2"))
        }
    };
    if !run_database && !run_legacy {
        println!(
            "{}",
            if fix {
                "No recommended repairs; nothing changed."
            } else {
                "No repairs selected; nothing changed."
            }
        );
        return Ok(());
    }
    if run_database {
        let _lock = OwnershipLock::acquire(&state).map_err(|e| (1, e.to_string()))?;
        println!("\nReclaiming database space.");
        let (before, after) =
            t3code_server::database_maintenance::compact(&path).map_err(|e| (1, e))?;
        println!("Done: {} -> {}.", bytes(before), bytes(after));
    }
    if run_legacy {
        let _lock = OwnershipLock::acquire(&state).map_err(|e| (1, e.to_string()))?;
        t3code_server::database_maintenance::remove_legacy(&path).map_err(|e| (1, e))?;
        println!("\nDeleted the database from before 0.1.0.");
    }
    Ok(())
}

fn parse_ttl_ms(raw: &str) -> Result<i64, (u8, String)> {
    let trimmed = raw.trim();
    let (digits, mult) = if let Some(v) = trimmed.strip_suffix("ms") {
        (v, 1i64)
    } else if let Some(v) = trimmed.strip_suffix('s') {
        (v, 1_000)
    } else if let Some(v) = trimmed.strip_suffix('m') {
        (v, 60_000)
    } else if let Some(v) = trimmed.strip_suffix('h') {
        (v, 3_600_000)
    } else if let Some(v) = trimmed.strip_suffix('d') {
        (v, 86_400_000)
    } else {
        (trimmed, 1_000)
    };
    let n = digits
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| (2, format!("Invalid ttl: {raw}")))?;
    Ok(n.saturating_mul(mult))
}

fn run_auth(args: &[String]) -> Result<(), (u8, String)> {
    if args.len() < 2 || args[0] != "pairing" || args[1] != "create" {
        return Err((2, "Usage: t3 auth pairing create [--ttl <duration>] [--label <label>] [--json] [--base-dir <path>] [--dev-url <url>]".into()));
    }
    let mut base_dir: Option<String> = env::var("T3CODE_HOME").ok();
    let mut dev_url: Option<String> = None;
    let mut ttl_ms: i64 = 3_600_000;
    let mut json_output = false;
    let mut i = 2;
    while i < args.len() {
        let arg = &args[i];
        let mut next = || -> Result<String, (u8, String)> {
            i += 1;
            args.get(i)
                .cloned()
                .ok_or_else(|| (2, format!("{arg} requires a value")))
        };
        match arg.as_str() {
            "--ttl" => ttl_ms = parse_ttl_ms(&next()?)?,
            "--label" => {
                let _ = next()?;
            }
            "--json" => json_output = true,
            "--base-dir" => base_dir = Some(next()?),
            "--dev-url" => dev_url = Some(next()?),
            a if a.starts_with("--ttl=") => ttl_ms = parse_ttl_ms(&a[6..])?,
            a if a.starts_with("--label=") => {}
            a if a.starts_with("--base-dir=") => base_dir = Some(a[11..].to_owned()),
            a if a.starts_with("--dev-url=") => dev_url = Some(a[10..].to_owned()),
            other => return Err((2, format!("Unsupported option: {other}"))),
        }
        i += 1;
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| (1, "Home directory is unavailable".into()))?;
    let process_cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
    let flags = ConfigInput {
        base_dir,
        dev_url: dev_url.clone(),
        ..Default::default()
    };
    let defaults = ConfigInput::default();
    let resolved = config::resolve(
        &flags,
        &defaults,
        &defaults,
        &home,
        &process_cwd,
        true,
        false,
    )
    .map_err(|e| (2, e.into()))?;
    let db_path = resolved.paths.state_dir.join("statev2.sqlite");
    if !db_path.is_file() {
        return Err((1, format!("Database not found at {}", db_path.display())));
    }
    let mut db = rusqlite::Connection::open(&db_path).map_err(|e| (1, e.to_string()))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let issued = t3code_server::auth::issue_startup_pairing_credential(
        &mut db,
        now_ms,
        &now_iso,
        dev_url.is_some(),
    )
    .map_err(|e| (1, format!("Failed to issue pairing credential: {e:?}")))?;
    let _ = ttl_ms;
    if json_output {
        println!(
            "{}",
            serde_json::json!({
                "id": issued.id,
                "credential": issued.credential,
                "expiresAt": issued.expires_at,
                "scopes": issued.scopes,
            })
        );
    } else {
        println!("{}", issued.credential);
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "acp-mcp-call") {
        let tool = args.get(2).and_then(|v| v.to_str());
        let input = args.get(3).and_then(|v| v.to_str());
        return match (tool, input) {
            (Some(tool), Some(input))
                if t3code_server::acp_mcp_bridge::call(tool, input).is_ok() =>
            {
                ExitCode::SUCCESS
            }
            _ => ExitCode::from(2),
        };
    }
    if args.get(1).is_some_and(|arg| arg == "acp-mcp-bridge") {
        return match t3code_server::acp_mcp_bridge::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::FAILURE,
        };
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "__managed-chatgpt-token")
    {
        use std::io::Write;
        let parsed: Option<Vec<String>> = args
            .iter()
            .skip(2)
            .map(|s| s.to_str().map(str::to_owned))
            .collect();
        let result = parsed.and_then(|args| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|rt| {
                    rt.block_on(t3code_server::codex_token_broker::request_token(&args))
                        .ok()
                })
        });
        return match result {
            Some(token) if std::io::stdout().write_all(token.as_bytes()).is_ok() => {
                ExitCode::SUCCESS
            }
            _ => {
                eprintln!("Could not access the managed ChatGPT connection. Reconnect in T3 Code.");
                ExitCode::from(1)
            }
        };
    }
    if args.get(1).is_some_and(|arg| arg == "__document-text") {
        use std::io::Write;
        if args.len() != 4 {
            return ExitCode::from(2);
        }
        let Some(ext) = args[3].to_str() else {
            return ExitCode::from(2);
        };
        return match t3code_server::document_text::worker(std::path::Path::new(&args[2]), ext) {
            Ok(text) => {
                if std::io::stdout().write_all(text.as_bytes()).is_ok() {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                }
            }
            Err(permanent) => ExitCode::from(if permanent { 2 } else { 1 }),
        };
    }
    match run(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn server_options_and_errors() {
        let p = parse_args(&args(&[
            "serve",
            "--port",
            "4444",
            "--lan=false",
            "./workspace",
        ]))
        .unwrap();
        assert!(p.headless);
        assert_eq!(p.flags.port, Some(4444));
        assert_eq!(p.flags.lan, Some(false));
        assert!(parse_args(&args(&["--port", "0"])).is_err());
        assert!(parse_args(&args(&["unknown-subcommand"])).is_err());
        assert!(parse_args(&args(&["serve", "--auto-bootstrap-project-from-cwd"])).is_err());
    }
}
