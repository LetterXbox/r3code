//! Hold an idle-sleep inhibitor while this server has active agent runs.
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    process::{Child, Command},
    sync::{broadcast::error::RecvError, oneshot},
    time::{Instant, MissedTickBehavior},
};

use crate::{event_bus::EventBus, settings::Settings};

const RELEASE_GRACE: Duration = Duration::from_secs(60);
const INITIAL_RETRY: Duration = Duration::from_secs(5);
const MAX_RETRY: Duration = Duration::from_secs(600);

fn inhibitor(pid: u32) -> Option<Command> {
    let command = match std::env::consts::OS {
        "macos" => {
            let mut cmd = Command::new("/usr/bin/caffeinate");
            cmd.args(["-i", "-w", &pid.to_string()]);
            cmd
        }
        "linux" => {
            let mut cmd = Command::new("systemd-inhibit");
            cmd.args([
                "--what=idle:sleep",
                "--who=R3 Code",
                "--why=Agents are working",
                "--mode=block",
                "--no-ask-password",
                "tail",
                &format!("--pid={pid}"),
                "-f",
                "/dev/null",
            ]);
            cmd
        }
        "windows" => {
            let mut cmd = Command::new("powershell.exe");
            let script = format!(
                r#"$type = Add-Type -Name Power -Namespace R3 -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [void]$type::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id {pid}"#
            );
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            cmd
        }
        _ => return None,
    };
    Some(command)
}

fn active_runs(bus: &EventBus) -> Option<bool> {
    bus.with_autocommit(|db| {
        db.query_row(
            "SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
                WHERE status IN ('preparing', 'starting', 'running'))",
            [],
            |row| row.get(0),
        )
    })
    .ok()?
    .ok()
}

#[derive(Default)]
struct Hold {
    active: bool,
    release_at: Option<Instant>,
}

impl Hold {
    fn wanted(&mut self, active: bool, now: Instant) -> bool {
        if self.active && !active {
            self.release_at = Some(now + RELEASE_GRACE);
        }
        self.active = active;
        active || self.release_at.is_some_and(|deadline| deadline > now)
    }
}

pub(crate) async fn run(bus: EventBus, settings: Arc<Settings>, shutdown: oneshot::Receiver<()>) {
    let Some(command) = inhibitor(std::process::id()) else {
        return;
    };
    hold_inhibitor(bus, settings, command, shutdown).await;
}

async fn hold_inhibitor(
    bus: EventBus,
    settings: Arc<Settings>,
    mut command: Command,
    mut shutdown: oneshot::Receiver<()>,
) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok((_, mut events)) = bus.subscribe_application() else {
        return;
    };
    let mut settings_changes = settings.subscribe();
    let mut enabled = settings.snapshot()["keepAwakeWhileAgentsWork"]
        .as_bool()
        .unwrap_or(true);
    let mut active = false;
    let mut hold = Hold::default();
    let mut child: Option<Child> = None;
    let mut retry = INITIAL_RETRY;
    let mut retry_at = Instant::now();
    let mut tick = tokio::time::interval(INITIAL_RETRY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        if enabled {
            active = active_runs(&bus).unwrap_or(active);
        }
        let now = Instant::now();
        if hold.wanted(enabled && active, now) {
            if let Some(process) = child.as_mut() {
                if !matches!(process.try_wait(), Ok(None)) {
                    eprintln!("Warning: idle-sleep inhibitor exited while still needed");
                    drop(child.take());
                    retry_at = now + retry;
                    retry = (retry * 2).min(MAX_RETRY);
                }
            }
            if child.is_none() && now >= retry_at {
                match command.spawn() {
                    Ok(process) => child = Some(process),
                    Err(error) => {
                        eprintln!("Warning: could not start idle-sleep inhibitor: {error}");
                        retry_at = now + retry;
                        retry = (retry * 2).min(MAX_RETRY);
                    }
                }
            }
        } else {
            if let Some(mut process) = child.take() {
                let _ = process.kill().await;
            }
            retry = INITIAL_RETRY;
            retry_at = now;
        }
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tick.tick() => {}
            closed = async {
                loop {
                    match events.recv().await {
                        Ok(event) if matches!(event.event.event_type.as_str(), "run.created" | "run.updated") => break false,
                        Ok(_) => {}
                        Err(RecvError::Lagged(_)) => break false,
                        Err(RecvError::Closed) => break true,
                    }
                }
            } => { if closed { break; } },
            change = settings_changes.recv() => match change {
                Ok(_) | Err(RecvError::Lagged(_)) => {
                    enabled = settings.snapshot()["keepAwakeWhileAgentsWork"].as_bool().unwrap_or(true);
                }
                Err(RecvError::Closed) => break,
            },
        }
    }
    if let Some(mut process) = child {
        let _ = process.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn active_run_starts_the_inhibitor_and_shutdown_reaps_it() {
        let root = std::env::temp_dir().join(format!("r3-keep-awake-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let pid_file = root.join("inhibitor.pid");
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute_batch(
            "INSERT INTO orchestration_v2_projection_runs
                (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
             VALUES ('run', 'thread', 1, 'mock', 'running', '2026-01-01', '{}');",
        )
        .unwrap();
        let bus = EventBus::new(db, 8);
        let settings = Arc::new(Settings::new(root.join("settings.json")));
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                r#"printf '%s\n' "$$" > "$1"; exec /bin/sleep 120"#,
                "inhibitor",
            ])
            .arg(&pid_file);
        let (stop, stopping) = oneshot::channel();
        let task = tokio::spawn(hold_inhibitor(bus, settings, command, stopping));
        let pid: libc::pid_t = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(contents) = tokio::fs::read_to_string(&pid_file).await {
                    if let Ok(pid) = contents.trim().parse() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        // Signal 0 checks only the isolated child process.
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grace_bridges_runs_and_releases_when_idle() {
        let mut hold = Hold::default();
        let start = Instant::now();
        assert!(!hold.wanted(false, start));
        assert!(hold.wanted(true, start));
        assert!(hold.wanted(false, start + Duration::from_secs(1)));
        assert!(hold.wanted(true, start + RELEASE_GRACE));
        assert!(hold.wanted(false, start + Duration::from_secs(61)));
        assert!(hold.wanted(false, start + Duration::from_secs(120)));
        assert!(!hold.wanted(false, start + Duration::from_secs(121)));
    }

    #[test]
    fn only_live_run_statuses_hold_the_inhibitor() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_runs (status TEXT NOT NULL)")
            .unwrap();
        let bus = EventBus::new(db, 8);
        assert_eq!(active_runs(&bus), Some(false));
        for status in [
            "queued",
            "completed",
            "interrupted",
            "preparing",
            "starting",
            "running",
        ] {
            bus.with_autocommit(|db| {
                db.execute("DELETE FROM orchestration_v2_projection_runs", [])?;
                db.execute(
                    "INSERT INTO orchestration_v2_projection_runs VALUES (?1)",
                    [status],
                )
            })
            .unwrap()
            .unwrap();
            assert_eq!(
                active_runs(&bus),
                Some(matches!(status, "preparing" | "starting" | "running"))
            );
        }
    }
}
