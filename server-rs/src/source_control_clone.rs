//! Source-control cloning for explicit repository URLs.
use serde_json::{json, Value};
use std::{
    path::{Component, PathBuf},
    process::Command,
    time::Duration,
};

fn error(provider: &str, detail: &str) -> Value {
    json!({"_tag":"SourceControlRepositoryError","provider":provider,"operation":"cloneRepository","detail":detail})
}
pub(crate) fn destination(input: &str) -> Result<PathBuf, Value> {
    let input = input.trim();
    if input.is_empty() {
        return Err(error(
            "unknown",
            "Choose a destination path before cloning.",
        ));
    }
    let expanded = if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix(r"~\")) {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| error("unknown", "The destination path is unavailable."))?;
        PathBuf::from(home).join(rest)
    } else if input == "~" {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| error("unknown", "The destination path is unavailable."))?;
        PathBuf::from(home)
    } else {
        PathBuf::from(input)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map_err(|_| error("unknown", "The destination path is unavailable."))?
            .join(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    if normalized.file_name().is_none() {
        return Err(error(
            "unknown",
            "Choose a destination path before cloning.",
        ));
    }
    Ok(normalized)
}
pub(crate) fn redact(remote: &str) -> String {
    let Ok(mut url) = url::Url::parse(remote) else {
        return remote.into();
    };
    if url.username().is_empty() && url.password().is_none() && url.query().is_none() {
        return remote.into();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.into()
}
pub(crate) fn resolve_remote(
    input: &Value,
    destination: &std::path::Path,
    settings: Option<&crate::settings::Settings>,
) -> Result<(String, Value), Value> {
    let provider = input["provider"].as_str().unwrap_or("unknown");
    if input["repository"].is_string() && input["provider"].is_string() {
        let cwd = destination
            .parent()
            .ok_or_else(|| error(provider, "Choose a destination path before cloning."))?;
        let repository = crate::source_control_lookup::lookup(
            &json!({"provider":provider,"repository":input["repository"],"cwd":cwd.to_string_lossy()}),
            settings,
        )?;
        let field = if input["protocol"] == "https" {
            "url"
        } else {
            "sshUrl"
        };
        let remote = repository[field]
            .as_str()
            .ok_or_else(|| {
                error(
                    provider,
                    "The source control provider returned an invalid repository.",
                )
            })?
            .to_owned();
        Ok((remote, repository))
    } else {
        let remote = input["remoteUrl"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                error(
                    provider,
                    "Enter a repository path or clone URL before cloning.",
                )
            })?;
        Ok((remote.to_owned(), Value::Null))
    }
}
pub(crate) fn https_fallback(remote: &str, repository: &Value, protocol: &Value) -> Option<String> {
    if protocol == "ssh" {
        return None;
    }
    if !repository.is_null() && repository["sshUrl"].as_str() == Some(remote) {
        return repository["url"].as_str().map(str::to_owned);
    }
    let value = remote.trim();
    let ssh = regex::Regex::new(r"^ssh://(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?/(.+)$")
        .expect("valid SSH URL pattern");
    let scp = regex::Regex::new(r"^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s\[\]]+):([^/].*)$")
        .expect("valid SCP URL pattern");
    let is_windows_drive = value.len() >= 2
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':';
    let (host, path, scp) = if let Some(captures) = ssh.captures(value) {
        if captures.get(2).is_some() {
            return None;
        }
        (captures[1].to_owned(), captures[3].to_owned(), false)
    } else if !is_windows_drive {
        if let Some(captures) = scp.captures(value) {
            (captures[1].to_owned(), captures[2].to_owned(), true)
        } else {
            return None;
        }
    } else {
        return None;
    };
    if host.eq_ignore_ascii_case("ssh.dev.azure.com") {
        let parts: Vec<_> = path.split('/').collect();
        return if parts.len() == 4
            && parts[0] == "v3"
            && parts[1..]
                .iter()
                .all(|v| !v.is_empty() && !v.contains(['?', '#']))
        {
            Some(format!(
                "https://dev.azure.com/{}/{}/_git/{}",
                parts[1], parts[2], parts[3]
            ))
        } else {
            None
        };
    }
    let path = if scp {
        path.split('/')
            .map(crate::message_commands::encode_id_part)
            .collect::<Vec<_>>()
            .join("/")
    } else {
        path
    };
    Some(format!("https://{host}/{path}"))
}
pub(crate) fn git_diagnostics(stderr: &[u8]) -> String {
    let raw = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let text = raw
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            line.starts_with("fatal:")
                || line.starts_with("error:")
                || trimmed.starts_with("! ")
                || (!line.starts_with("remote:")
                    && (line.contains("permission denied (publickey")
                        || line.contains("permission denied (password")
                        || line.contains("permission denied (keyboard-interactive")
                        || line.contains("permission denied, please try again")
                        || line.contains("host key verification failed")))
        })
        .collect::<Vec<_>>()
        .join("\n");
    text
}
pub(crate) fn ssh_auth_rejected(stderr: &[u8]) -> bool {
    let text = git_diagnostics(stderr);
    git_auth_failed(&text) || text.contains("host key verification failed")
}
pub(crate) fn git_auth_failed(text: &str) -> bool {
    text.contains("authentication failed")
        || text.contains("could not read username")
        || text.contains("could not read password")
        || regex::Regex::new(r"permission denied \([a-z-]+(?:,[a-z-]+)*\)")
            .expect("valid authentication failure pattern")
            .is_match(text)
        || text.contains("permission denied, please try again")
}
fn clone_failure_detail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let userinfo = regex::Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/?#]+@")
        .expect("valid URL redaction pattern");
    let query = regex::Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s?]*)\?[^\s]*")
        .expect("valid query redaction pattern");
    let lines: Vec<String> = text
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("Cloning into")
                && !line.starts_with("Receiving objects:")
                && !line.starts_with("Resolving deltas:")
                && !line.starts_with("Updating files:")
                && !line.starts_with("remote: Counting objects:")
                && !line.starts_with("remote: Compressing objects:")
                && !line.starts_with("remote: Enumerating objects:")
        })
        .map(|line| {
            userinfo
                .replace_all(&query.replace_all(line, "$1"), "$1")
                .into_owned()
        })
        .collect();
    if lines.is_empty() {
        "The repository could not be cloned.".into()
    } else {
        lines[lines.len().saturating_sub(4)..].join(" ")
    }
}
fn clone_exit_error(provider: &str, detail: &str, cwd: &std::path::Path, stderr: &[u8]) -> Value {
    let text = git_diagnostics(stderr);
    let reason = if text.contains("not a git repository")
        || text.contains("gitfile does not point to a valid repository")
    {
        Some("not_a_repository")
    } else if git_auth_failed(&text) {
        Some("authentication_failed")
    } else if text.contains("host key verification failed") {
        Some("host_key_unverified")
    } else if text.contains("could not read from remote repository")
        || text.contains("does not appear to be a git repository")
        || (text.contains("repository ") && text.contains(" not found"))
    {
        Some("remote_unreachable")
    } else if text.contains("destination path ") && text.contains(" already exists") {
        Some("path_already_exists")
    } else {
        None
    };
    let suffix = reason.map(|r| format!(" ({r})")).unwrap_or_default();
    let mut value = error(provider, detail);
    value["cause"] = json!({"name":"GitCommandError","message":format!("Git command failed in SourceControlRepositoryService.cloneRepository ({}): Git command exited with a non-zero status.{suffix}", cwd.display())});
    value
}
fn run_clone(
    parent: &std::path::Path,
    name: &std::ffi::OsStr,
    remote: &str,
) -> std::io::Result<std::process::Output> {
    let mut command = Command::new("git");
    command
        .current_dir(parent)
        .args(["clone", "--progress", "--", remote])
        .arg(name)
        .env("GIT_PROGRESS_DELAY", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANGUAGE", "C");
    crate::vcs_worktree::run_command(&mut command, Duration::from_secs(120))
}
pub fn clone_repository(
    input: &Value,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let provider = input["provider"].as_str().unwrap_or("unknown");
    let dest = destination(input["destinationPath"].as_str().unwrap_or(""))?;
    match std::fs::read_dir(&dest) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(error(
                    "unknown",
                    "Destination path already exists and is not empty.",
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = dest
                .parent()
                .ok_or_else(|| error("unknown", "Choose a destination path before cloning."))?;
            std::fs::create_dir_all(parent)
                .map_err(|_| error("unknown", "The destination path is unavailable."))?;
        }
        Err(_) => {
            return Err(error(
                "unknown",
                "Destination path already exists and is not a directory.",
            ))
        }
    }
    let (remote, repository) = resolve_remote(input, &dest, settings)?;
    let parent = dest
        .parent()
        .ok_or_else(|| error("unknown", "Choose a destination path before cloning."))?;
    let name = dest
        .file_name()
        .ok_or_else(|| error("unknown", "Choose a destination path before cloning."))?;
    let result = run_clone(parent, name, &remote);
    match result {
        Ok(output) if output.status.success() => Ok(
            json!({"cwd":dest.to_string_lossy(),"remoteUrl":redact(&remote),"repository":repository}),
        ),
        Ok(output) if ssh_auth_rejected(&output.stderr) => {
            let Some(fallback) = https_fallback(&remote, &repository, &input["protocol"]) else {
                return Err(clone_exit_error(
                    provider,
                    &clone_failure_detail(&output.stderr),
                    parent,
                    &output.stderr,
                ));
            };
            match run_clone(parent, name, &fallback) {
                Ok(retried) if retried.status.success() => Ok(
                    json!({"cwd":dest.to_string_lossy(),"remoteUrl":redact(&fallback),"repository":repository}),
                ),
                Ok(retried) => Err(clone_exit_error(provider, &format!("{} Cloning over HTTPS instead also failed: {}", clone_failure_detail(&output.stderr), clone_failure_detail(&retried.stderr)), parent, &retried.stderr)),
                Err(_) => Err(error(provider, &format!("{} Cloning over HTTPS instead also failed: The repository could not be cloned.", clone_failure_detail(&output.stderr)))),
            }
        }
        Ok(output) => Err(clone_exit_error(
            provider,
            &clone_failure_detail(&output.stderr),
            parent,
            &output.stderr,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            Err(error(provider, "The clone timed out after 2 minutes."))
        }
        Err(_) => Err(error(provider, "The repository could not be cloned.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_ssh_fallback_only_for_allowed_protocols() {
        let empty = Value::Null;
        assert_eq!(
            https_fallback("git@example.com:some/repo.git", &empty, &empty).as_deref(),
            Some("https://example.com/some/repo.git")
        );
        assert_eq!(
            https_fallback("ssh://git@example.com/some/repo.git", &empty, &empty).as_deref(),
            Some("https://example.com/some/repo.git")
        );
        assert_eq!(
            https_fallback("git@ssh.dev.azure.com:v3/a/b/c", &empty, &empty).as_deref(),
            Some("https://dev.azure.com/a/b/_git/c")
        );
        assert_eq!(
            https_fallback("ssh://git@example.com:2222/a/b", &empty, &empty),
            None
        );
        assert_eq!(
            https_fallback("git@example.com:a/b", &empty, &json!("ssh")),
            None
        );
        assert_eq!(
            https_fallback("https://example.com/a/b", &empty, &empty),
            None
        );
        assert!(ssh_auth_rejected(
            b"Permission denied (keyboard-interactive,password)."
        ));
        assert!(!ssh_auth_rejected(
            b"Permission denied writing local directory"
        ));
        assert!(!ssh_auth_rejected(
            b"remote: Permission denied (publickey)."
        ));
    }
    #[test]
    fn clones_local_repository_and_refuses_nonempty_destination() {
        let root = std::env::temp_dir().join(format!("clone-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        assert!(Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let target = root.join("target");
        let input = json!({"remoteUrl":source.to_string_lossy(),"destinationPath":target.to_string_lossy()});
        let result = clone_repository(&input, None).unwrap();
        assert_eq!(result["cwd"], target.to_string_lossy().as_ref());
        assert!(target.join(".git").is_dir());
        assert_eq!(
            clone_repository(&input, None).unwrap_err()["detail"],
            "Destination path already exists and is not empty."
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn redacts_url_userinfo_and_query() {
        assert_eq!(
            redact("https://user:secret@example.com/org/repo?token=secret"),
            "https://example.com/org/repo"
        );
    }
}
