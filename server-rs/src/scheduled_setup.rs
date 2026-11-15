//! Run the selected project setup script in a visible terminal for scheduled worktrees.
use crate::terminal::TerminalManager;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use crate::project_setup::setup_script as selected_script;

fn wrap_command(command: &str, shell: &str, sentinel: &str) -> Option<String> {
    let name = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    let body = command.replace("\r\n", "\n").replace('\n', "\r");
    match name {
        "cmd" => Some(format!("cmd /d /c call \"%T3CODE_SETUP_SCRIPT%\"\recho {sentinel}%errorlevel%")),
        "fish" => Some(format!("begin\r{body}\rend; printf '\\n{sentinel}%s\\n' $status")),
        "pwsh" | "powershell" => Some(format!("$global:LASTEXITCODE = $null; & {{\r{body}\r}}; $__t3ok = $?; if ($null -ne $LASTEXITCODE) {{ $__t3c = $LASTEXITCODE }} elseif ($__t3ok) {{ $__t3c = 0 }} else {{ $__t3c = 1 }}; Write-Host \"{sentinel}$__t3c\"")),
        "nu" => {
            let escaped: String = command.chars().map(|c| match c {
                '"' | '\\' => format!("\\{c}"),
                c if c <= '\u{1f}' => format!("\\u{{{:x}}}", c as u32),
                c => c.to_string(),
            }).collect();
            Some([
                "$env.LAST_EXIT_CODE = 0".to_owned(),
                "let __t3f = try { mktemp --tmpdir-path $env.T3CODE_WORKTREE_PATH --suffix .nu .t3-setup-XXXXXXXX } catch {|e| print -e $e.msg; null }".to_owned(),
                format!("if $__t3f == null {{ $env.LAST_EXIT_CODE = 1 }} else {{ try {{ [$\"rm --permanent ($__t3f | to nuon)\" \"{escaped}\"] | str join (char newline) | save --force --raw $__t3f; ^$nu.current-exe --login --commands $\"cd $env.T3CODE_WORKTREE_PATH; source ($__t3f | to nuon)\" }} catch {{|e| if $e != null and $e.exit_code? == null {{ print -e $e.msg }}; if $env.LAST_EXIT_CODE == 0 {{ $env.LAST_EXIT_CODE = 1 }} }} }}"),
                "let __t3c = $env.LAST_EXIT_CODE".to_owned(),
                "try { if $__t3f != null and ($__t3f | path exists) { rm --permanent $__t3f } } catch {|e| print -e $e.msg }".to_owned(),
                format!("print $\"\\n{sentinel}($__t3c)\""),
            ].join("; "))
        }
        _ => Some(format!("( {body}\r); printf '\\n{sentinel}%s\\n' \"$?\"")),
    }
}

// Keep the batch file alive for asynchronous setup and delete it on every exit path.
#[cfg(windows)]
struct SetupFile {
    path: std::path::PathBuf,
}
#[cfg(windows)]
impl SetupFile {
    fn create(command: &str) -> Result<Self, String> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("t3-setup-{}.cmd", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Unable to create setup script: {e}"))?;
        let normalized = command.replace("\r\n", "\n").replace('\n', "\r\n");
        if let Err(e) = file.write_all(normalized.as_bytes()) {
            let _ = std::fs::remove_file(&path);
            return Err(format!("Unable to write setup script: {e}"));
        }
        Ok(Self { path })
    }
}
#[cfg(windows)]
impl Drop for SetupFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Start the setup terminal; synchronous scripts must finish successfully before dispatch.
/// Asynchronous scripts continue in the terminal while the scheduled task starts.
#[allow(clippy::too_many_arguments)]
pub fn run(
    terminals: &Arc<TerminalManager>,
    settings: &Value,
    project_id: &str,
    project_root: &str,
    scripts: &Value,
    thread_id: &str,
    worktree_path: &str,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let Some(script) = selected_script(settings, project_id, scripts) else {
        return Ok(());
    };
    let command = script["command"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Invalid project setup command.")?;
    let id = script["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Invalid project setup script id.")?;
    let terminal_id = format!("setup-{id}");
    let token = uuid::Uuid::new_v4().simple().to_string();
    let sentinel = format!("__T3_SETUP_DONE___{token}:");
    #[cfg(windows)]
    let setup_file = SetupFile::create(command)?;
    let mut events = terminals.subscribe_events();
    #[allow(unused_mut)]
    let mut request = json!({"threadId":thread_id,"terminalId":terminal_id,"cwd":worktree_path,"worktreePath":worktree_path,"env":{"T3CODE_PROJECT_ROOT":project_root,"T3CODE_WORKTREE_PATH":worktree_path,"COLORTERM":"","NO_COLOR":"1","FORCE_COLOR":"0"}});
    #[cfg(windows)]
    {
        request["env"]["T3CODE_SETUP_SCRIPT"] = json!(setup_file.path);
    }
    let opened = terminals
        .open(&request)
        .map_err(|e| format!("Unable to open setup terminal: {e}"))?;
    if opened["status"] != "running" {
        return Err("Unable to start setup terminal.".into());
    }
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let Some(wrapped) = wrap_command(command, &shell, &sentinel) else {
        let _ = terminals.dispatch(
            "terminal.close",
            &json!({"threadId":thread_id,"terminalId":terminal_id}),
        );
        return Err("Setup completion is not supported for cmd.".into());
    };
    let manager = terminals.clone();
    let thread = thread_id.to_owned();
    let terminal = terminal_id.clone();
    let cancelled = cancelled.clone();
    let mut wait = move || -> Result<(), String> {
        #[cfg(windows)]
        let _setup_file = setup_file;
        // A shell startup file may run an interactive program that would consume
        // typed input. Wait for the line editor or a quiet, idle shell first.
        let mut last_activity = Instant::now();
        let mut busy = false;
        let mut carry = String::new();
        loop {
            if cancelled.load(Ordering::Acquire) {
                let _ = manager.dispatch(
                    "terminal.close",
                    &json!({"threadId":thread,"terminalId":terminal}),
                );
                return Err("Project setup interrupted by server shutdown.".into());
            }
            match events.try_recv() {
                Ok(event) if event["threadId"] == thread && event["terminalId"] == terminal => {
                    last_activity = Instant::now();
                    if event["type"] == "activity" {
                        busy = event["hasRunningSubprocess"] == true;
                    } else if event["type"] == "output" {
                        carry.push_str(event["data"].as_str().unwrap_or(""));
                        let on = carry.rfind("\x1b[?2004h");
                        let off = carry.rfind("\x1b[?2004l");
                        if on.is_some() && (off.is_none() || on > off) {
                            break;
                        }
                        if carry.len() > 1024 {
                            let keep = carry.floor_char_boundary(carry.len() - 64);
                            carry.drain(..keep);
                        }
                    } else if event["type"] == "exited" || event["type"] == "closed" {
                        return Err("Project setup terminal exited during shell startup.".into());
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    if !busy && last_activity.elapsed() >= Duration::from_secs(3) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(format!("Unable to observe shell startup: {e}")),
            }
        }
        manager
            .dispatch(
                "terminal.write",
                &json!({"threadId":thread,"terminalId":terminal,"data":format!(" {wrapped}\r")}),
            )
            .map_err(|e| format!("Unable to write setup command: {e}"))?;
        let mut buffer = String::new();
        loop {
            if cancelled.load(Ordering::Acquire) {
                let _ = manager.dispatch(
                    "terminal.close",
                    &json!({"threadId":thread,"terminalId":terminal}),
                );
                return Err("Project setup interrupted by server shutdown.".into());
            }
            match events.try_recv() {
                Ok(event) if event["threadId"] == thread && event["terminalId"] == terminal => {
                    if event["type"] == "output" {
                        buffer.push_str(event["data"].as_str().unwrap_or(""));
                        while let Some(end) = buffer.find(['\r', '\n']) {
                            let line = buffer[..end].to_string();
                            buffer.drain(..=end);
                            if let Some((_, value)) = line.split_once(&sentinel) {
                                if let Ok(code) = value.trim().parse::<i32>() {
                                    if code == 0 {
                                        let _ = manager.dispatch(
                                            "terminal.close",
                                            &json!({"threadId":thread,"terminalId":terminal}),
                                        );
                                        return Ok(());
                                    }
                                    return Err(format!(
                                        "Project setup script failed with exit code {code}."
                                    ));
                                }
                            }
                        }
                        if buffer.len() > 8192 {
                            let keep = buffer.floor_char_boundary(buffer.len() - 4096);
                            buffer.drain(..keep);
                        }
                    } else if event["type"] == "exited" || event["type"] == "closed" {
                        return Err("Project setup terminal exited before completion.".into());
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(format!("Unable to observe project setup: {e}")),
            }
        }
    };
    if script["async"] != false {
        std::thread::spawn(move || {
            if let Err(e) = wait() {
                eprintln!("Warning: {e}");
            }
        });
        Ok(())
    } else {
        wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_shell_commands_and_escapes_nushell_source() {
        let nu = wrap_command(
            "print \"quoted\"; print 'C:\\tools'\nexit 7",
            "/usr/bin/nu",
            "DONE:",
        )
        .unwrap();
        assert!(nu.contains(r#"print \"quoted\"; print 'C:\\tools'\u{a}exit 7"#));
        assert!(nu.contains("source ($__t3f | to nuon)"));
        assert!(nu.contains("print $\"\\nDONE:($__t3c)\""));
        assert!(
            wrap_command("exit 7", r"C:\Windows\PowerShell.EXE", "DONE:")
                .unwrap()
                .contains("$global:LASTEXITCODE")
        );
        let cmd = wrap_command("exit 7", "cmd.exe", "DONE:").unwrap();
        assert!(cmd.contains("%T3CODE_SETUP_SCRIPT%"));
        assert!(cmd.contains("echo DONE:%errorlevel%"));
    }

    #[test]
    fn powershell_wrapper_reports_success_and_failure() {
        if std::process::Command::new("pwsh")
            .arg("-Version")
            .output()
            .is_err()
        {
            return;
        }
        for (script, expected) in [
            ("Write-Output ok", "DONE:0"),
            ("& /bin/sh -c 'exit 7'", "DONE:7"),
        ] {
            let wrapped = wrap_command(script, "pwsh", "DONE:").unwrap();
            let output = std::process::Command::new("pwsh")
                .args(["-NoProfile", "-Command", &wrapped])
                .output()
                .unwrap();
            assert!(
                String::from_utf8_lossy(&output.stdout).contains(expected),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }

    #[test]
    fn selects_settings_override_and_legacy_fallback() {
        let scripts = json!([{"id":"old","runOnWorktreeCreate":true}]);
        let settings = json!({"defaultProjectScripts":[{"id":"default","runOnWorktreeCreate":true}],"projectScriptOverrides":{"p":null},"projectSettingsOverrides":{"p":{"defaultProjectScripts":[{"id":"override","runOnWorktreeCreate":true}]}}});
        assert_eq!(
            selected_script(&settings, "p", &scripts).unwrap()["id"],
            "override"
        );
        assert_eq!(
            selected_script(&settings, "other", &scripts).unwrap()["id"],
            "old"
        );
        assert_eq!(selected_script(&json!({"projectScriptOverrides":{"p":null},"defaultProjectScripts":[{"id":"default","runOnWorktreeCreate":true}]}),"p",&scripts).unwrap()["id"], "default");
    }
    #[cfg(windows)]
    #[test]
    fn windows_setup_runs_multiline_and_reports_exit_status() {
        let dir = std::env::temp_dir().join(format!("t3-setup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        let manager = Arc::new(TerminalManager::default());
        let scripts = json!([{"id":"ok","runOnWorktreeCreate":true,"async":false,"command":"@echo off\r\nset VALUE=hello\r\nif defined VALUE (\r\n  echo %VALUE%> result\r\n)"}]);
        run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("result")).unwrap().trim(),
            "hello"
        );
        let scripts = json!([{"id":"fail","runOnWorktreeCreate":true,"async":false,"command":"@echo off\r\nexit /b 7"}]);
        assert!(run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false))
        )
        .unwrap_err()
        .contains("exit code 7"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_async_setup_returns_before_completion() {
        let dir = std::env::temp_dir().join(format!("t3-setup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        let manager = Arc::new(TerminalManager::default());
        let scripts = json!([{"id":"async","runOnWorktreeCreate":true,"async":true,"command":"@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho done>result"}]);
        run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(!dir.join("result").exists());
        for _ in 0..500 {
            if dir.join("result").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("result")).unwrap().trim(),
            "done"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn synchronous_setup_runs_in_worktree_and_propagates_failure() {
        let dir = std::env::temp_dir().join(format!("t3-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        let manager = Arc::new(TerminalManager::default());
        let scripts = json!([{"id":"test","runOnWorktreeCreate":true,"async":false,"command":"printf '%s' \"$T3CODE_WORKTREE_PATH\" > result"}]);
        run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("result")).unwrap(), path);
        let scripts =
            json!([{"id":"failure","runOnWorktreeCreate":true,"async":false,"command":"exit 7"}]);
        assert!(run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false))
        )
        .unwrap_err()
        .contains("exit code 7"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn asynchronous_setup_returns_before_script_finishes() {
        let dir = std::env::temp_dir().join(format!("t3-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        let manager = Arc::new(TerminalManager::default());
        let scripts = json!([{"id":"async","runOnWorktreeCreate":true,"async":true,"command":"sleep 0.3; printf done > result"}]);
        run(
            &manager,
            &json!({}),
            "p",
            path,
            &scripts,
            "thread",
            path,
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(!dir.join("result").exists());
        for _ in 0..250 {
            if dir.join("result").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_to_string(dir.join("result")).unwrap(), "done");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
