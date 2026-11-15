//! Capture and verify the exact GitHub credential used for a routed read.
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CommandFailure {
    Spawn(std::io::ErrorKind),
    Unauthenticated,
    NotFound,
    RateLimited,
    Failed,
}

/// Run a bounded command and retain only a classified failure, never raw stderr.
pub(crate) fn run_classified(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<Vec<u8>, CommandFailure> {
    run_classified_bounded(cmd, timeout, 1_048_576)
}

pub(crate) fn run_classified_with_status(
    cmd: &mut Command,
    timeout: Duration,
    exit_code: &mut Option<i32>,
) -> Result<Vec<u8>, CommandFailure> {
    run_classified_bounded_with_status(cmd, timeout, 1_048_576, exit_code)
}

pub(crate) fn run_classified_bounded(
    cmd: &mut Command,
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, CommandFailure> {
    run_classified_bounded_with_status(cmd, timeout, limit, &mut None)
}

fn run_classified_bounded_with_status(
    cmd: &mut Command,
    timeout: Duration,
    limit: usize,
    exit_code: &mut Option<i32>,
) -> Result<Vec<u8>, CommandFailure> {
    run_classified_impl(cmd, timeout, limit, exit_code, None)
}

pub(crate) fn run_classified_with_input(
    cmd: &mut Command,
    timeout: Duration,
    input: Vec<u8>,
) -> Result<Vec<u8>, CommandFailure> {
    run_classified_impl(cmd, timeout, 1_048_576, &mut None, Some(input))
}

fn run_classified_impl(
    cmd: &mut Command,
    timeout: Duration,
    limit: usize,
    exit_code: &mut Option<i32>,
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, CommandFailure> {
    cmd.env("GH_PROMPT_DISABLED", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let deadline = Instant::now() + timeout;
    let mut child = loop {
        match cmd.spawn() {
            Ok(child) => break child,
            Err(error) => {
                // Forking while an executable is still open for writing can
                // transiently yield ETXTBSY; process pressure can yield EAGAIN.
                let transient = error.kind() == std::io::ErrorKind::Interrupted
                    || error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::ExecutableFileBusy;
                if !transient { return Err(CommandFailure::Spawn(error.kind())); }
                if Instant::now() >= deadline { return Err(CommandFailure::Failed); }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    if let Some(input) = input {
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (tx, rx) = std::sync::mpsc::sync_channel(2);
    for (index, mut stream) in [
        (0, Box::new(stdout) as Box<dyn Read + Send>),
        (1, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = (&mut stream)
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes);
            let _ = tx.send((index, result.map(|_| bytes)));
        });
    }
    drop(tx);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(CommandFailure::Failed);
    }
    let mut output = [None, None];
    for _ in 0..2 {
        let (index, result) = rx
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| CommandFailure::Failed)?;
        let bytes = result.map_err(|_| CommandFailure::Failed)?;
        if bytes.len() > limit {
            return Err(CommandFailure::Failed);
        }
        output[index] = Some(bytes);
    }
    *exit_code = status.as_ref().and_then(|s| s.code());
    if status.unwrap().success() {
        Ok(output[0].take().unwrap())
    } else {
        Err(classify_stderr(&output[1].take().unwrap()))
    }
}

fn classify_stderr(stderr: &[u8]) -> CommandFailure {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("rate limit") || text.contains("rate-limit") || text.contains("http 429") {
        CommandFailure::RateLimited
    } else if text.contains("http 401")
        || text.contains("bad credentials")
        || text.contains("not logged into")
        || text.contains("gh auth login")
    {
        CommandFailure::Unauthenticated
    } else if text.contains("http 404")
        || text.contains("could not resolve to a pullrequest")
        || text.contains("could not resolve to a issue or pullrequest")
    {
        CommandFailure::NotFound
    } else {
        CommandFailure::Failed
    }
}

pub(crate) fn run(cmd: &mut Command) -> Result<Option<Vec<u8>>, std::io::Error> {
    match run_classified(cmd, Duration::from_secs(10)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(CommandFailure::Spawn(kind)) => Err(std::io::Error::from(kind)),
        Err(_) => Ok(None),
    }
}

pub(crate) fn operation_error(failure: CommandFailure, operation: &str, detail: &str) -> Value {
    match failure {
        CommandFailure::Spawn(std::io::ErrorKind::NotFound) => {
            serde_json::json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"github"})
        }
        CommandFailure::Unauthenticated => {
            serde_json::json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"github"})
        }
        CommandFailure::NotFound => {
            serde_json::json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail,"reason":"not-found"})
        }
        _ => {
            serde_json::json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail})
        }
    }
}

pub(crate) struct PinnedCredential {
    token: String,
    enterprise: bool,
}
impl PinnedCredential {
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
    pub(crate) fn apply(&self, command: &mut Command) {
        command
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_ENTERPRISE_TOKEN")
            .env_remove("GITHUB_ENTERPRISE_TOKEN")
            .env(
                if self.enterprise {
                    "GH_ENTERPRISE_TOKEN"
                } else {
                    "GH_TOKEN"
                },
                &self.token,
            );
    }
}

pub(crate) fn capture(
    exe: &str,
    cwd: &str,
    host: &str,
    expected: &str,
) -> Option<PinnedCredential> {
    let enterprise = !host.eq_ignore_ascii_case("github.com")
        && !host.to_ascii_lowercase().ends_with(".ghe.com");
    let names = if enterprise {
        ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    } else {
        ["GH_TOKEN", "GITHUB_TOKEN"]
    };
    let token = names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|s| !s.is_empty()))
        .or_else(|| {
            let mut command = Command::new(exe);
            command
                .current_dir(cwd)
                .args(["auth", "token", "--hostname", host]);
            String::from_utf8(run(&mut command).ok()??)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        })?;
    let credential = PinnedCredential { token, enterprise };
    let mut command = Command::new(exe);
    command
        .current_dir(cwd)
        .args(["api", "user", "--hostname", host]);
    credential.apply(&mut command);
    let value: Value = serde_json::from_slice(&run(&mut command).ok()??).ok()?;
    let id = value.get("id")?.as_u64().filter(|id| *id > 0)?;
    let login = value.get("login")?.as_str()?.trim();
    if login.is_empty() || id.to_string() != expected {
        return None;
    }
    Some(credential)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_github_failures_without_exposing_stderr() {
        for (text, expected) in [
            (
                "gh: Bad credentials (HTTP 401)",
                CommandFailure::Unauthenticated,
            ),
            (
                "API rate limit exceeded (HTTP 403)",
                CommandFailure::RateLimited,
            ),
            ("Not Found (HTTP 404)", CommandFailure::NotFound),
            (
                "Could not resolve to a Issue or PullRequest",
                CommandFailure::NotFound,
            ),
            ("connection refused secret-token", CommandFailure::Failed),
        ] {
            assert_eq!(classify_stderr(text.as_bytes()), expected);
        }
        let error = operation_error(CommandFailure::NotFound, "detail", "Unable to read.");
        assert_eq!(error["reason"], "not-found");
        assert!(!error.to_string().contains("secret-token"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn command_retries_a_temporarily_busy_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("command-busy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("cli");
        std::fs::write(&executable, "#!/bin/sh\nprintf ready\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let writer = std::fs::OpenOptions::new().write(true).open(&executable).unwrap();
        assert_eq!(Command::new(&executable).status().unwrap_err().raw_os_error(), Some(libc::ETXTBSY));
        let release = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(80)); drop(writer); });
        assert_eq!(run_classified(&mut Command::new(&executable), Duration::from_secs(2)).unwrap(), b"ready");
        release.join().unwrap(); std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn command_failure_captures_stderr_and_bounds_execution() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'Bad credentials (HTTP 401)' >&2; exit 1"]);
        assert_eq!(
            run_classified(&mut command, Duration::from_secs(1)),
            Err(CommandFailure::Unauthenticated)
        );
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        assert_eq!(
            run_classified(&mut command, Duration::from_millis(50)),
            Err(CommandFailure::Failed)
        );
    }
}
