//! Publish a local repository through a source-control provider.
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Output},
    time::Duration,
};

fn error(provider: &str, detail: &str) -> Value {
    json!({"_tag":"SourceControlRepositoryError","provider":provider,"operation":"publishRepository","detail":detail})
}

fn git_config_locked(diagnostics: &str) -> bool {
    regex::Regex::new(r"could not lock config file .+: file exists")
        .expect("valid Git config lock pattern")
        .is_match(diagnostics)
}

fn command(cwd: &Path, program: &str, args: &[&str]) -> Result<Output, std::io::Error> {
    let mut command = Command::new(program);
    command
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GLAB_PROMPT_DISABLED", "1");
    let timeout = if program == "git" && args.first() == Some(&"push") {
        Duration::MAX
    } else if program == "git" {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(30)
    };
    crate::vcs_worktree::run_command(&mut command, timeout)
}

fn glab(cwd: &Path, args: &[&str]) -> Result<Value, Value> {
    let output = command(cwd, "glab", args).map_err(|_| {
        error(
            "gitlab",
            "The source control operation could not be completed.",
        )
    })?;
    if !output.status.success() {
        return Err(error(
            "gitlab",
            "The source control operation could not be completed.",
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| {
        error(
            "gitlab",
            "The source control provider returned an invalid repository.",
        )
    })
}

fn create_gitlab(cwd: &Path, repository: &str, visibility: &str) -> Result<Value, Value> {
    let parts: Vec<_> = repository
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let name = parts
        .last()
        .copied()
        .ok_or_else(|| error("gitlab", "Enter a repository name."))?;
    let namespace = if parts.len() > 1 {
        let path = parts[..parts.len() - 1].join("/");
        let endpoint = format!(
            "namespaces/{}",
            url::form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>()
        );
        let value = glab(cwd, &["api", &endpoint])?;
        Some(
            value["id"]
                .as_i64()
                .ok_or_else(|| {
                    error(
                        "gitlab",
                        "The source control provider returned an invalid repository.",
                    )
                })?
                .to_string(),
        )
    } else {
        None
    };
    let path_arg = format!("path={name}");
    let name_arg = format!("name={name}");
    let visibility_arg = format!("visibility={visibility}");
    let namespace_arg = namespace.map(|id| format!("namespace_id={id}"));
    let mut args = vec![
        "api",
        "--method",
        "POST",
        "projects",
        "--raw-field",
        &path_arg,
        "--raw-field",
        &name_arg,
        "--raw-field",
        &visibility_arg,
    ];
    if let Some(ref namespace) = namespace_arg {
        args.extend(["--raw-field", namespace]);
    }
    let raw = glab(cwd, &args)?;
    let required = |key: &str| {
        raw[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                error(
                    "gitlab",
                    "The source control provider returned an invalid repository.",
                )
            })
    };
    let _http = required("http_url_to_repo")?;
    Ok(
        json!({"provider":"gitlab","nameWithOwner":required("path_with_namespace")?,"url":required("web_url")?,"sshUrl":required("ssh_url_to_repo")?}),
    )
}
fn create_azure(cwd: &Path, repository: &str) -> Result<Value, Value> {
    let parts: Vec<_> = repository
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let name = parts
        .last()
        .copied()
        .ok_or_else(|| error("azure-devops", "Enter a repository name."))?;
    let mut args = vec!["repos", "create", "--detect", "true", "--name", name];
    if parts.len() > 1 {
        args.extend(["--project", parts[parts.len() - 2]]);
    }
    args.extend(["--only-show-errors", "--output", "json"]);
    let output = command(cwd, "az", &args).map_err(|_| {
        error(
            "azure-devops",
            "The source control operation could not be completed.",
        )
    })?;
    if !output.status.success() {
        return Err(error(
            "azure-devops",
            "The source control operation could not be completed.",
        ));
    }
    let raw: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        error(
            "azure-devops",
            "The source control provider returned an invalid repository.",
        )
    })?;
    let required = |key: &str| {
        raw[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                error(
                    "azure-devops",
                    "The source control provider returned an invalid repository.",
                )
            })
    };
    let name = required("name")?;
    let _web = required("webUrl")?;
    let owner = raw["project"]["name"]
        .as_str()
        .filter(|value| !value.trim().is_empty());
    let full = owner.map_or_else(|| name.to_owned(), |project| format!("{project}/{name}"));
    Ok(
        json!({"provider":"azure-devops","nameWithOwner":full,"url":required("remoteUrl")?,"sshUrl":required("sshUrl")?}),
    )
}
fn github_publish_error(mut value: Value) -> Value {
    value["operation"] = json!("publishRepository");
    if let Some(message) = value["cause"]["message"].as_str() {
        value["cause"]["message"] = json!(message.replace(
            "failed in getRepositoryCloneUrls:",
            "failed in createRepository:"
        ));
    }
    value
}
fn create_github(
    cwd: &Path,
    repository: &str,
    visibility: &str,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let (host, path) = crate::source_control_lookup::github_selector(repository)
        .ok_or_else(|| error("github", "Enter a repository name."))?;
    let viewer = crate::source_control_lookup::github_api(&host, "user", cwd, settings)
        .map_err(github_publish_error)?;
    let login = viewer["login"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            error(
                "github",
                "The source control provider returned an invalid account.",
            )
        })?;
    let (owner, name) = path.split_once('/').unwrap_or((login, path.as_str()));
    let endpoint = if owner.eq_ignore_ascii_case(login) {
        "user/repos".to_owned()
    } else {
        format!(
            "orgs/{}/repos",
            crate::message_commands::encode_id_part(owner)
        )
    };
    let raw = crate::source_control_lookup::github_request(
        &host,
        &endpoint,
        cwd,
        settings,
        Some(&json!({"name":name,"private":visibility=="private"})),
    )
    .map_err(github_publish_error)?;
    let required = |key: &str| {
        raw[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                error(
                    "github",
                    "The source control provider returned an invalid repository.",
                )
            })
    };
    Ok(
        json!({"provider":"github","nameWithOwner":required("full_name")?,"url":required("html_url")?,"sshUrl":required("ssh_url")?}),
    )
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<Output, Value> {
    command(cwd, "git", args)
        .map_err(|_| error("unknown", "The Git operation could not be completed."))
}
fn git(cwd: &Path, args: &[&str]) -> Result<String, Value> {
    let output = git_output(cwd, args)?;
    if !output.status.success() {
        return Err(error(
            "unknown",
            "The Git operation could not be completed.",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn remote_key(value: &str) -> String {
    let value = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let normalized = if let Ok(url) = url::Url::parse(value) {
        format!(
            "{}/{}",
            url.host_str().unwrap_or("").to_ascii_lowercase(),
            url.path().trim_matches('/').trim_end_matches(".git")
        )
    } else if let Some((host, path)) = value.split_once(':') {
        format!(
            "{}/{}",
            host.rsplit('@').next().unwrap_or(host).to_ascii_lowercase(),
            path.trim_matches('/')
        )
    } else {
        value.to_owned()
    };
    normalized.to_ascii_lowercase()
}
fn push_error(
    provider: &str,
    repository: &Value,
    remote_name: &str,
    remote: &str,
    cwd: &Path,
    stderr: &[u8],
) -> Value {
    let text = crate::source_control_clone::git_diagnostics(stderr);
    let reason = if git_config_locked(&text) {
        Some("config_locked")
    } else if crate::source_control_clone::git_auth_failed(&text) {
        Some("authentication_failed")
    } else if text.contains("host key verification failed") {
        Some("host_key_unverified")
    } else if regex::Regex::new(r"(?m)^\s*!\s+\[remote rejected\]")
        .expect("valid remote rejection pattern")
        .is_match(&text)
    {
        Some("push_rejected_by_remote")
    } else if regex::Regex::new(
        r"(?m)^\s*!\s+\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)",
    )
    .expect("valid push rejection pattern")
    .is_match(&text)
        && text
            .lines()
            .any(|line| line.starts_with("error: failed to push some refs"))
    {
        Some("push_rejected_non_fast_forward")
    } else {
        None
    };
    let name = repository["nameWithOwner"].as_str().unwrap_or("");
    let https = repository["url"].as_str().unwrap_or("");
    let ssh = repository["sshUrl"].as_str().unwrap_or("");
    let created =
        format!("Created {name} and added it as remote \"{remote_name}\", but the push failed");
    let switch = format!("git remote set-url {remote_name} {https}");
    let detail = match reason {
        Some("authentication_failed") if remote == ssh => format!("{created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with \"{switch}\", then push again."),
        Some("authentication_failed") => format!("{created} because Git could not authenticate. Check your Git credentials, then push again."),
        Some("host_key_unverified") => format!("{created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with \"{switch}\", then push again."),
        _ => format!("{created}. Fix the problem, then push again."),
    };
    let suffix = reason.map(|r| format!(" ({r})")).unwrap_or_default();
    let cause_detail = match reason {
        Some("config_locked") => "Another Git process kept the repository's config locked. Wait for it to finish, then retry.",
        Some("push_rejected_by_remote") => "The remote rejected the push. Push this branch from a terminal to see the server's message.",
        Some("push_rejected_non_fast_forward") => "The remote has commits this branch doesn't have. Pull or rebase, then push again.",
        _ => "Git command exited with a non-zero status.",
    };
    let mut result = error(provider, &detail);
    result["cause"] = json!({"name":"GitCommandError","message":format!("Git command failed in GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote ({}): {cause_detail}{suffix}",cwd.display())});
    result
}

pub fn publish(
    input: &Value,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let provider = input["provider"].as_str().unwrap_or("unknown");
    let cwd = input["cwd"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .map(Path::new)
        .ok_or_else(|| error(provider, "Choose a working directory."))?;
    let name = input["repository"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error(provider, "Enter a repository name."))?;
    let visibility = input["visibility"]
        .as_str()
        .filter(|v| matches!(*v, "public" | "private"))
        .ok_or_else(|| error(provider, "Choose a repository visibility."))?;
    if input
        .get("protocol")
        .is_some_and(|value| !matches!(value.as_str(), Some("auto" | "ssh" | "https")))
        || input
            .get("remoteName")
            .is_some_and(|value| value.as_str().is_none_or(|name| name.trim().is_empty()))
    {
        return Err(error(provider, "Invalid publish options."));
    }
    if !cwd.is_dir() {
        return Err(error(
            provider,
            "The source control working directory is unavailable.",
        ));
    }
    let repository = match provider {
        "gitlab" => create_gitlab(cwd, name, visibility)?,
        "github" => create_github(cwd, name, visibility, settings)?,
        "azure-devops" => create_azure(cwd, name)?,
        "bitbucket" => {
            crate::source_control_lookup::bitbucket_request(name, settings, Some(visibility))
                .map_err(|mut e| {
                    e["operation"] = json!("publishRepository");
                    e
                })?
        }
        "forgejo" => crate::source_control_lookup::forgejo_request(name, cwd, Some(visibility))
            .map_err(|mut e| {
                e["operation"] = json!("publishRepository");
                e
            })?,
        "cursor-origin" => {
            crate::source_control_lookup::cursor_origin_create(name, visibility, cwd, settings)?
        }
        "gitcafe" => {
            crate::source_control_lookup::gitcafe_request(name, cwd, settings, Some(visibility))
                .map_err(|mut e| {
                    e["operation"] = json!("publishRepository");
                    e
                })?
        }
        _ => {
            return Err(error(
                provider,
                "This source control provider is not supported.",
            ))
        }
    };
    let use_ssh = input["protocol"] != "https";
    let ssh = repository["sshUrl"].as_str().unwrap_or("");
    let https = repository["url"].as_str().unwrap_or("");
    let mut remote = if use_ssh { ssh } else { https }.to_owned();
    let preferred = input["remoteName"].as_str().unwrap_or("origin").trim();
    let preferred = regex::Regex::new(r"[^A-Za-z0-9._-]+")
        .expect("constant pattern")
        .replace_all(preferred, "-")
        .trim_matches('-')
        .to_owned();
    let preferred = if preferred.is_empty() {
        "fork"
    } else {
        &preferred
    };
    let listed = git(cwd, &["remote", "-v"])?;
    let mut remotes = std::collections::BTreeMap::new();
    for line in listed.lines() {
        if let Some((name, rest)) = line.split_once('\t') {
            if let Some(url) = rest.strip_suffix(" (fetch)") {
                remotes.insert(name.to_owned(), url.to_owned());
            }
        }
    }
    let remote_name = if let Some((name, _)) = remotes
        .iter()
        .find(|(_, value)| remote_key(value) == remote_key(&remote))
    {
        name.clone()
    } else {
        let mut candidate = preferred.to_owned();
        let mut suffix = 1;
        while remotes.contains_key(&candidate) {
            candidate = format!("{preferred}-{suffix}");
            suffix += 1;
        }
        let mut failure = None;
        let mut added = false;
        for attempt in 0..=10 {
            let output = git_output(cwd, &["remote", "add", "--", &candidate, &remote])?;
            if output.status.success() {
                added = true;
                break;
            }
            let diagnostic = crate::source_control_clone::git_diagnostics(&output.stderr);
            let locked = git_config_locked(&diagnostic);
            failure = Some(if locked {
                let mut failure = error(
                    provider,
                    "The source control operation could not be completed.",
                );
                failure["cause"] = json!({"name":"GitCommandError","message":format!("Git command failed in GitVcsDriver.ensureRemote.add ({}): Another Git process kept the repository's config locked. Wait for it to finish, then retry. (config_locked)", cwd.display())});
                failure
            } else {
                let mut failure = error(
                    provider,
                    "The source control operation could not be completed.",
                );
                failure["cause"] = json!({"name":"GitCommandError","message":format!("Git command failed in GitVcsDriver.ensureRemote.add ({}): Git command exited with a non-zero status.", cwd.display())});
                failure
            });
            if !locked || attempt == 10 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if added {
            candidate
        } else {
            let matching = git(cwd, &["remote", "-v"]).ok().and_then(|listed| {
                listed.lines().find_map(|line| {
                    let (name, rest) = line.split_once('\t')?;
                    let url = rest.strip_suffix(" (fetch)")?;
                    (remote_key(url) == remote_key(&remote)).then(|| name.to_owned())
                })
            });
            matching.ok_or_else(|| {
                failure.unwrap_or_else(|| {
                    error("unknown", "The Git operation could not be completed.")
                })
            })?
        }
    };
    let branch = git(cwd, &["symbolic-ref", "--short", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    if !git_output(cwd, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        return Ok(
            json!({"repository":repository,"remoteName":remote_name,"remoteUrl":remote,"branch":branch.unwrap_or_else(|| "main".into()),"status":"remote_added"}),
        );
    }
    let branch = branch.ok_or_else(|| {
        let mut result = error(provider, &format!("Created {} and added it as remote \"{}\", but the push failed. Fix the problem, then push again.", repository["nameWithOwner"].as_str().unwrap_or(name), remote_name));
        result["cause"] = json!({"name":"GitCommandError","message":format!("Git command failed in GitVcsDriver.pushCurrentBranch ({}): Cannot push from detached HEAD.", cwd.display())});
        result
    })?;
    let names = git(cwd, &["remote"]).unwrap_or_default();
    let publish_branch = names
        .lines()
        .find_map(|name| {
            branch
                .strip_prefix(&format!("{name}/"))
                .map(str::trim)
                .filter(|rest| !rest.is_empty())
        })
        .unwrap_or(&branch);
    let refspec = format!("HEAD:refs/heads/{publish_branch}");
    let mut pushed = git_output(cwd, &["push", "--", &remote_name, &refspec])?;
    if !pushed.status.success()
        && use_ssh
        && input["protocol"] != "ssh"
        && crate::source_control_clone::ssh_auth_rejected(&pushed.stderr)
    {
        let prior = push_error(
            provider,
            &repository,
            &remote_name,
            &remote,
            cwd,
            &pushed.stderr,
        );
        if git(cwd, &["remote", "set-url", &remote_name, https]).is_err() {
            return Err(prior);
        }
        remote = https.to_owned();
        pushed = git_output(cwd, &["push", "--", &remote_name, &refspec])?;
    }
    if !pushed.status.success() {
        return Err(push_error(
            provider,
            &repository,
            &remote_name,
            &remote,
            cwd,
            &pushed.stderr,
        ));
    }
    if git(
        cwd,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{publish_branch}"),
        ],
    )
    .is_ok()
        && git(
            cwd,
            &["config", &format!("branch.{branch}.remote"), &remote_name],
        )
        .is_ok()
        && matches!(
            git(cwd, &["config", "--get", "branch.autoSetupRebase"]).as_deref(),
            Ok("always" | "remote")
        )
    {
        let _ = git(cwd, &["config", &format!("branch.{branch}.rebase"), "true"]);
    }
    Ok(
        json!({"repository":repository,"remoteName":remote_name,"remoteUrl":remote,"branch":branch,"status":"pushed"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_failures_only_classify_git_diagnostics() {
        let repository = json!({"nameWithOwner":"team/repo","url":"https://example.invalid/team/repo","sshUrl":"git@example.invalid:team/repo"});
        let classify = |stderr: &[u8]| {
            push_error(
                "gitlab",
                &repository,
                "origin",
                "https://example.invalid/team/repo",
                Path::new("/repo"),
                stderr,
            )["cause"]["message"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert!(
            classify(b"error: could not lock config file .git/config: File exists\n")
                .contains("(config_locked)")
        );
        assert!(
            !classify(b"error: could not lock config file .git/config: Permission denied\n")
                .contains("(config_locked)")
        );
        assert!(
            !classify(b"remote: error: could not lock config file .git/config: File exists\n")
                .contains("(config_locked)")
        );
        assert!(classify(
            b" ! [remote rejected] main -> main (hook declined)\nerror: failed to push some refs\n"
        )
        .contains("(push_rejected_by_remote)"));
    }

    #[test]
    fn rejects_invalid_options_before_creating_remote() {
        let input = json!({"cwd":".","provider":"gitlab","repository":"group/repo","visibility":"private","protocol":"invalid"});
        assert_eq!(
            publish(&input, None).unwrap_err()["detail"],
            "Invalid publish options."
        );
        let mut input = input;
        input["protocol"] = json!("ssh");
        input["remoteName"] = json!("");
        assert_eq!(
            publish(&input, None).unwrap_err()["detail"],
            "Invalid publish options."
        );
    }
}
