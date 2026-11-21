//! Git worktree RPC operations. Git owns removal; never recursively delete a path.
use crate::http_server::RpcFailure;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

fn invalid() -> RpcFailure {
    RpcFailure::Die(json!({"name":"Error","message":"Invalid RPC payload"}))
}
fn field<'a>(v: &'a Value, name: &str) -> Result<&'a str, RpcFailure> {
    v.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)
}
// Drain both pipes concurrently, retaining only bounded diagnostics while allowing Git
// and hooks to continue writing. Place the child in its own process group so timeout
// cleanup includes Git's ordinary descendants.
pub(crate) fn run_command(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    run_command_input(command, timeout, None)
}
pub(crate) fn run_command_input(
    command: &mut Command,
    timeout: Duration,
    input: Option<&[u8]>,
) -> io::Result<Output> {
    run_command_input_with_stdout_limit(command, timeout, input, 1_048_576)
}

pub(crate) fn run_command_input_with_stdout_limit(
    command: &mut Command,
    timeout: Duration,
    input: Option<&[u8]>,
    stdout_limit: usize,
) -> io::Result<Output> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(input) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    }
    let read = |mut pipe: Box<dyn Read + Send>, limit: usize| {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut buf = [0; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let amount = n.min(limit.saturating_sub(kept.len()));
                kept.extend_from_slice(&buf[..amount]);
            }
            kept
        })
    };
    let stdout = read(Box::new(child.stdout.take().unwrap()), stdout_limit);
    let stderr = read(Box::new(child.stderr.take().unwrap()), 1_048_576);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => {
                break Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Git command timed out",
                ))
            }
            Err(e) => break Err(e),
        }
    };
    // Also close pipes inherited by lingering hooks after the parent exits.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    if status.is_err() {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    status.map(|status| Output {
        status,
        stdout,
        stderr,
    })
}

fn git(cwd: &str, operation: &str, args: &[&str]) -> Result<String, RpcFailure> {
    // Upstream permits lengthy checkouts and uses five minutes for removal.
    let timeout = if operation == "GitVcsDriver.removeWorktree" {
        Duration::from_secs(300)
    } else if args.contains(&"worktree") && args.contains(&"add") || args.contains(&"submodule") {
        Duration::from_secs(1800)
    } else {
        Duration::from_secs(120)
    };
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0");
    let result = run_command(&mut command, timeout);
    match result {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        result => {
            let (detail, code) = match result {
                Ok(o) => (
                    String::from_utf8_lossy(&o.stderr).trim().to_owned(),
                    o.status.code(),
                ),
                Err(e) => (e.to_string(), None),
            };
            Err(RpcFailure::Fail(
                json!({"_tag":"GitCommandError","operation":operation,"command":"git","cwd":cwd,"exitCode":code,"detail":detail}),
            ))
        }
    }
}

fn read_sparse_patterns(cwd: &str, reference: &str) -> Result<Option<String>, RpcFailure> {
    let git_ref = if reference == "-" { "@{-1}" } else { reference };
    let Ok(project_json) = git(
        cwd,
        "GitVcsDriver.createWorktree.readProjectFile",
        &["show", &format!("{git_ref}:t3.json")],
    ) else {
        return Ok(None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&project_json) else {
        return Ok(None);
    };
    let Some(raw) = parsed
        .get("worktreeSparsePatternsPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
    else {
        return Ok(None);
    };
    let mut normalized = raw;
    while let Some(rest) = normalized.strip_prefix("./") {
        normalized = rest;
    }
    if normalized.is_empty() || normalized.split('/').any(|seg| seg == "..") {
        return Err(RpcFailure::Fail(json!({
            "_tag": "GitCommandError",
            "operation": "GitVcsDriver.createWorktree",
            "command": "git worktree add",
            "cwd": cwd,
            "detail": format!("t3.json names the sparse-checkout pattern file \"{raw}\", which is not a file in {reference}.")
        })));
    }
    git(
        cwd,
        "GitVcsDriver.createWorktree.readSparsePatterns",
        &["cat-file", "blob", &format!("{git_ref}:{normalized}")],
    )
    .map(Some)
    .map_err(|_| {
        RpcFailure::Fail(json!({
            "_tag": "GitCommandError",
            "operation": "GitVcsDriver.createWorktree",
            "command": "git worktree add",
            "cwd": cwd,
            "detail": format!("t3.json names the sparse-checkout pattern file \"{raw}\", which is not a file in {reference}.")
        }))
    })
}

fn apply_sparse_checkout(repo_cwd: &str, checkout: &Path, patterns: &str) -> Result<(), RpcFailure> {
    use std::io::Write;
    let Some(checkout_str) = checkout.to_str() else {
        return Err(invalid());
    };
    let cleanup = || {
        let _ = git(
            repo_cwd,
            "GitVcsDriver.createWorktree.cleanupSparse",
            &["worktree", "remove", "--force", "--", checkout_str],
        );
    };
    if let Err(err) = git(
        checkout_str,
        "GitVcsDriver.createWorktree.sparseInit",
        &["sparse-checkout", "init", "--no-cone"],
    ) {
        cleanup();
        return Err(err);
    }
    let mut cmd = Command::new("git");
    cmd.args(["sparse-checkout", "set", "--no-cone", "--stdin"])
        .current_dir(checkout_str)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let set_res = cmd.spawn().and_then(|mut child| {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(patterns.as_bytes());
        }
        child.wait_with_output()
    });
    match set_res {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            cleanup();
            return Err(RpcFailure::Fail(json!({
                "_tag": "GitCommandError",
                "operation": "GitVcsDriver.createWorktree.sparseSet",
                "command": "git",
                "cwd": checkout_str,
                "exitCode": out.status.code(),
                "detail": String::from_utf8_lossy(&out.stderr).trim()
            })));
        }
        Err(err) => {
            cleanup();
            return Err(RpcFailure::Fail(json!({
                "_tag": "GitCommandError",
                "operation": "GitVcsDriver.createWorktree.sparseSet",
                "command": "git",
                "cwd": checkout_str,
                "detail": err.to_string()
            })));
        }
    }
    if let Err(err) = git(
        checkout_str,
        "GitVcsDriver.createWorktree.sparseCheckout",
        &["checkout", "--force", "HEAD"],
    ) {
        cleanup();
        return Err(err);
    }
    Ok(())
}

fn initialize_submodules(checkout: &Path, setting: Option<&str>) {
    let Some(cwd) = checkout.to_str() else { return };
    if git(
        cwd,
        "GitVcsDriver.createWorktree.findSubmodules",
        &["cat-file", "-e", "HEAD:.gitmodules"],
    )
    .is_err()
        && !checkout.join(".gitmodules").exists()
    {
        return;
    }
    let file_setting = git(
        cwd,
        "GitVcsDriver.createWorktree.readProjectFile",
        &["show", "HEAD:t3.json"],
    )
    .ok()
    .or_else(|| std::fs::read_to_string(checkout.join("t3.json")).ok())
    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    .and_then(|v| v["worktreeSubmodules"].as_str().map(str::to_owned));
    let mode = setting.or(file_setting.as_deref()).unwrap_or("recursive");
    if mode == "none" {
        return;
    }
    if git(
        cwd,
        "GitVcsDriver.createWorktree.initSubmodules",
        &["submodule", "init"],
    )
    .is_err()
    {
        return;
    }
    let mut args = vec!["submodule", "update", "--init"];
    if mode != "top-level" {
        args.push("--recursive");
    }
    let _ = git(cwd, "GitVcsDriver.createWorktree.updateSubmodules", &args);
}
fn optional_ref<'a>(v: &'a Value, name: &str) -> Result<Option<&'a str>, RpcFailure> {
    match v.get(name) {
        None => Ok(None),
        Some(_) => field(v, name).map(Some),
    }
}
fn ref_name(name: &str) -> Result<&str, RpcFailure> {
    if name.starts_with('-') {
        Err(invalid())
    } else {
        Ok(name)
    }
}

pub fn dispatch(
    tag: &str,
    v: &Value,
    root: &Path,
    submodules: Option<&str>,
) -> Result<Value, RpcFailure> {
    let cwd = field(v, "cwd")?;
    if tag == "vcs.createWorktree" {
        let reference = ref_name(field(v, "refName")?)?;
        let new_ref = optional_ref(v, "newRefName")?.map(ref_name).transpose()?;
        let base_ref = optional_ref(v, "baseRefName")?.map(ref_name).transpose()?;
        if v.get("path") != Some(&Value::Null) {
            return Err(invalid());
        }
        if !root.is_absolute() || root.parent().is_none() {
            return Err(invalid());
        }
        let common = git(
            cwd,
            "GitVcsDriver.createWorktree",
            &["rev-parse", "--git-common-dir"],
        )?;
        let common_path = Path::new(cwd).join(common.trim());
        let common_path = std::fs::canonicalize(common_path).map_err(|_| invalid())?;
        let repo = std::fs::canonicalize(cwd).map_err(|_| invalid())?;
        let repo_name = repo
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty())
            .ok_or_else(invalid)?;
        let target = new_ref.unwrap_or(reference);
        let mut digest = Sha256::new();
        digest.update(common_path.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(target.as_bytes());
        let hash = format!("{:x}", digest.finalize());
        let mut prefix = String::new();
        for c in target
            .chars()
            .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        {
            if prefix.len() + c.len_utf8() > 23 {
                break;
            }
            prefix.push(c);
        }
        let parent = root.join(repo_name);
        std::fs::create_dir_all(&parent).map_err(|_| invalid())?;
        let base = parent.join(format!("{prefix}-{}", &hash[..16]));
        let mut path = base.clone();
        let mut suffix = 2;
        while path.exists() {
            path = PathBuf::from(format!("{}-{suffix}", base.display()));
            suffix += 1;
        }
        let path_str = path.to_str().ok_or_else(invalid)?;
        let sparse_patterns = read_sparse_patterns(cwd, reference)?;
        if let Some(branch) = new_ref {
            git(
                cwd,
                "GitVcsDriver.createWorktree.createBranch",
                &["branch", "--", branch, reference],
            )?;
        }
        let workers = git(
            cwd,
            "GitVcsDriver.createWorktree",
            &["config", "--get", "checkout.workers"],
        )
        .unwrap_or_else(|_| "0".into());
        let checkout_workers = format!("checkout.workers={}", workers.trim());
        let mut add_args = vec!["-c", &checkout_workers, "worktree", "add"];
        if sparse_patterns.is_some() {
            add_args.push("--no-checkout");
        }
        add_args.extend(["--", path_str, target]);
        git(cwd, "GitVcsDriver.createWorktree", &add_args)?;
        if let Some(ref patterns) = sparse_patterns {
            apply_sparse_checkout(cwd, &path, patterns)?;
        }
        // Submodule and base metadata failures do not invalidate a completed checkout.
        initialize_submodules(&path, submodules);
        if let (Some(branch), Some(base)) = (new_ref, base_ref) {
            let remotes =
                git(cwd, "GitVcsDriver.resolveBranchName", &["remote"]).unwrap_or_default();
            let mut names: Vec<_> = remotes.lines().collect();
            names.sort_by_key(|name| std::cmp::Reverse(name.len()));
            let resolved = git(
                cwd,
                "GitVcsDriver.resolveBranchName.resolveRef",
                &[
                    "rev-parse",
                    "--symbolic-full-name",
                    "--verify",
                    "--end-of-options",
                    base,
                ],
            )
            .ok()
            .map(|s| s.trim().to_owned())
            .or_else(|| {
                let primary = names
                    .iter()
                    .copied()
                    .find(|n| *n == "origin")
                    .or_else(|| names.first().copied())?;
                let remote_ref = format!("refs/remotes/{primary}/{base}");
                git(
                    cwd,
                    "GitVcsDriver.resolveBranchName",
                    &["show-ref", "--verify", "--quiet", &remote_ref],
                )
                .ok()
                .map(|_| remote_ref)
            });
            if let Some(resolved) = resolved {
                let branch_name = resolved.strip_prefix("refs/heads/").or_else(|| {
                    let remote = resolved.strip_prefix("refs/remotes/")?;
                    names
                        .iter()
                        .find_map(|name| remote.strip_prefix(&format!("{name}/")))
                });
                if let Some(name) = branch_name {
                    let _ = git(
                        cwd,
                        "GitVcsDriver.createWorktree",
                        &[
                            "config",
                            "--",
                            &format!("branch.{branch}.t3-merge-base"),
                            name,
                        ],
                    );
                    if resolved.starts_with("refs/remotes/") {
                        let _ = git(
                            cwd,
                            "GitVcsDriver.createWorktree",
                            &[
                                "config",
                                "--",
                                &format!("branch.{branch}.t3-merge-base-ref"),
                                &resolved,
                            ],
                        );
                    }
                }
            }
        }
        Ok(json!({"worktree":{"path":path_str,"refName":target}}))
    } else {
        let path = field(v, "path")?;
        let force = match v.get("force") {
            None => false,
            Some(Value::Bool(b)) => *b,
            _ => return Err(invalid()),
        };
        let path = Path::new(path);
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            std::fs::canonicalize(cwd)
                .map_err(|_| invalid())?
                .join(path)
        };
        // Canonicalize existing paths so Git cannot interpret a short name as another worktree.
        let absolute = if absolute.exists() {
            std::fs::canonicalize(&absolute).map_err(|_| invalid())?
        } else {
            absolute
        };
        let path = absolute.to_str().ok_or_else(invalid)?;
        let args = if force {
            vec!["worktree", "remove", "--force", "--", path]
        } else {
            vec!["worktree", "remove", "--", path]
        };
        match git(cwd, "GitVcsDriver.removeWorktree", &args) {
            Ok(_) => Ok(Value::Null),
            Err(error) if !absolute.exists() => {
                // Match upstream's idempotent removal only for Git's missing-worktree response.
                let missing = match &error {
                    RpcFailure::Fail(v) => v["detail"]
                        .as_str()
                        .is_some_and(|s| s.contains("is not a working tree")),
                    _ => false,
                };
                if missing {
                    let _ = git(cwd, "GitVcsDriver.pruneWorktrees", &["worktree", "prune"]);
                    Ok(Value::Null)
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    #[test]
    fn stdout_limit_can_be_extended_without_changing_default() {
        let command = || { let mut c = Command::new("sh"); c.args(["-c", "head -c 1100000 /dev/zero"]); c };
        let default = run_command(&mut command(), Duration::from_secs(10)).unwrap();
        assert!(default.status.success()); assert_eq!(default.stdout.len(), 1_048_576);
        let extended = run_command_input_with_stdout_limit(&mut command(), Duration::from_secs(10), None, 1_100_001).unwrap();
        assert!(extended.status.success()); assert_eq!(extended.stdout.len(), 1_100_000);
    }
    fn run(root: &Path, args: &[&str]) {
        let result = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    fn repo() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("vcs-worktree-{}", uuid::Uuid::new_v4()));
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-b", "main"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        run(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("file"), "original").unwrap();
        run(&repo, &["add", "file"]);
        run(&repo, &["commit", "-m", "initial"]);
        (base, repo)
    }
    #[test]
    fn creates_and_removes_checkout_and_preserves_dirty_files() {
        let (base, repo) = repo();
        let root = base.join("trees");
        let input = json!({"cwd":repo,"refName":"main","newRefName":"feature/test","baseRefName":"main","path":null});
        let result = dispatch("vcs.createWorktree", &input, &root, None).unwrap();
        assert_eq!(result["worktree"]["refName"], "feature/test");
        assert_eq!(
            git(
                repo.to_str().unwrap(),
                "test",
                &["config", "--get", "branch.feature/test.t3-merge-base"]
            )
            .unwrap()
            .trim(),
            "main"
        );
        let path = PathBuf::from(result["worktree"]["path"].as_str().unwrap());
        assert!(path.starts_with(&root));
        assert_eq!(fs::read_to_string(path.join("file")).unwrap(), "original");
        fs::write(path.join("file"), "modified").unwrap();
        let remove = json!({"cwd":repo,"path":path});
        assert!(dispatch("vcs.removeWorktree", &remove, &root, None).is_err());
        assert_eq!(fs::read_to_string(path.join("file")).unwrap(), "modified");
        let force = json!({"cwd":repo,"path":path,"force":true});
        assert!(dispatch("vcs.removeWorktree", &force, &root, None).is_ok());
        assert!(!path.exists());
        assert!(dispatch("vcs.removeWorktree", &force, &root, None).is_ok());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_client_selected_paths_and_option_refs() {
        let (base, repo) = repo();
        let root = base.join("trees");
        assert!(dispatch(
            "vcs.createWorktree",
            &json!({"cwd":repo,"refName":"main","path":base.join("outside")}),
            &root,
            None
        )
        .is_err());
        assert!(dispatch(
            "vcs.createWorktree",
            &json!({"cwd":repo,"refName":"--force","path":null}),
            &root,
            None
        )
        .is_err());
        let other = base.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("file"), "keep").unwrap();
        assert!(dispatch(
            "vcs.removeWorktree",
            &json!({"cwd":repo,"path":other,"force":true}),
            &root,
            None
        )
        .is_err());
        assert!(other.join("file").exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn remote_base_and_submodule_override_are_honored() {
        let (base, repo) = repo();
        run(
            &repo,
            &[
                "remote",
                "add",
                "team/origin",
                "https://example.invalid/repo",
            ],
        );
        run(
            &repo,
            &["update-ref", "refs/remotes/team/origin/trunk", "HEAD"],
        );
        fs::write(
            repo.join(".gitmodules"),
            "[submodule \"module\"]\n path = module\n url = https://example.invalid/module\n",
        )
        .unwrap();
        fs::write(
            repo.join("t3.json"),
            r#"{"worktreeSubmodules":"recursive"}"#,
        )
        .unwrap();
        run(&repo, &["add", ".gitmodules", "t3.json"]);
        run(&repo, &["commit", "-m", "config"]);
        let root = base.join("trees");
        let result = dispatch("vcs.createWorktree", &json!({"cwd":repo,"refName":"main","newRefName":"feature/remote","baseRefName":"team/origin/trunk","path":null}), &root, Some("none")).unwrap();
        let checkout = result["worktree"]["path"].as_str().unwrap();
        assert_eq!(
            git(
                repo.to_str().unwrap(),
                "test",
                &["config", "--get", "branch.feature/remote.t3-merge-base"]
            )
            .unwrap()
            .trim(),
            "trunk"
        );
        assert_eq!(
            git(
                repo.to_str().unwrap(),
                "test",
                &["config", "--get", "branch.feature/remote.t3-merge-base-ref"]
            )
            .unwrap()
            .trim(),
            "refs/remotes/team/origin/trunk"
        );
        assert!(git(
            checkout,
            "test",
            &["config", "--get", "submodule.module.url"]
        )
        .is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn timeout_kills_git_descendants_and_reaps_parent() {
        let base = std::env::temp_dir().join(format!("vcs-timeout-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let marker = base.join("marker");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("(sleep 1; touch \"$1\") & wait")
            .arg("sh")
            .arg(&marker);
        let start = Instant::now();
        let error = run_command(&mut command, Duration::from_millis(100)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists());
        fs::remove_dir_all(base).unwrap();
    }
}
