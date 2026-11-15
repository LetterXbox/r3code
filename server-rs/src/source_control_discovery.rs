//! Discovery of local source-control tools and their authentication state.
use crate::github_pinned_credential::{run_classified_bounded, CommandFailure};
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};
fn option(value: Option<&str>) -> Value {
    value.map_or_else(
        || json!({"_tag":"None"}),
        |v| json!({"_tag":"Some","value":v}),
    )
}
fn probe(cwd: &Path, executable: &str, args: &[&str]) -> Result<String, CommandFailure> {
    let mut cmd = Command::new(executable);
    cmd.args(args).current_dir(cwd);
    let bytes = run_classified_bounded(&mut cmd, Duration::from_secs(5), 8000)?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}
fn item(
    cwd: &Path,
    kind: &str,
    label: &str,
    executable: &str,
    hint: &str,
    implemented: Option<bool>,
) -> Value {
    let version = probe(cwd, executable, &["--version"]).map(|s| {
        s.lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_owned()
    });
    let missing = version.is_err();
    let detail = if missing {
        Some(format!(
            "VCS process failed to spawn in source-control.discovery.probe: {executable} ({})",
            cwd.display()
        ))
    } else {
        None
    };
    let mut value = json!({"kind":kind,"label":label,"executable":executable,"status":if missing {"missing"}else{"available"},"version":option(version.as_ref().ok().filter(|s|!s.is_empty()).map(String::as_str)),"installHint":hint,"detail":option(detail.as_deref())});
    if let Some(implemented) = implemented {
        value["implemented"] = json!(implemented);
    }
    value
}
fn auth_unknown(detail: Option<&str>) -> Value {
    json!({"status":"unknown","account":option(None),"host":option(None),"detail":option(detail)})
}
fn provider(cwd: &Path, kind: &str, label: &str, exe: &str, hint: &str) -> Value {
    let mut v = item(cwd, kind, label, exe, hint, None);
    let auth = if v["status"] == "missing" {
        auth_unknown(Some(hint))
    } else if kind == "github" {
        let version = v["version"]["value"].as_str().unwrap_or("");
        let old = version
            .split_whitespace()
            .nth(2)
            .and_then(|s| {
                let mut n = s.split('.');
                Some((
                    n.next()?.parse::<u32>().ok()?,
                    n.next()?.parse::<u32>().ok()?,
                ))
            })
            .is_some_and(|n| n < (2, 81));
        github_auth(cwd).unwrap_or_else(|| if old {
            auth_unknown(Some("GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan."))
        } else { auth_unknown(None) })
    } else {
        auth_unknown(None)
    };
    v["auth"] = auth;
    v
}
fn github_auth(cwd: &Path) -> Option<Value> {
    let Ok(output) = probe(cwd, "gh", &["auth", "status", "--json", "hosts"]) else {
        return None;
    };
    let Ok(data) = serde_json::from_str::<Value>(&output) else {
        return None;
    };
    let hosts = data["hosts"].as_object()?;
    let mut accounts = Vec::new();
    for (host, entries) in hosts {
        for entry in entries.as_array().into_iter().flatten() {
            if let Some(login) = entry["login"].as_str() {
                accounts.push(json!({"host":host,"account":login,"active":entry["active"]==true,"authenticated":entry["state"]=="success"}));
            }
        }
    }
    let selected = accounts
        .iter()
        .find(|v| v["active"] == true && v["authenticated"] == true)
        .or_else(|| accounts.iter().find(|v| v["authenticated"] == true));
    let mut auth = json!({"status":if selected.is_some(){"authenticated"}else{"unauthenticated"},"account":option(selected.and_then(|v|v["account"].as_str())),"host":option(selected.and_then(|v|v["host"].as_str())),"detail":option(None)});
    if selected.is_none() {
        auth["detail"] = option(Some(
            "Run `gh auth login` to authenticate GitHub CLI with an active account.",
        ));
    }
    auth["accounts"] = json!(accounts);
    Some(auth)
}
pub fn discover(cwd: &Path) -> Value {
    let git_hint = "Install Git from https://git-scm.com/downloads or with your package manager.";
    let jj_hint = "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.";
    let specs=[
        ("github","GitHub","gh","Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`)."),
        ("cursor-origin","Cursor Origin","origin","Install the Origin CLI with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then run `origin auth login`."),
        ("gitlab","GitLab","glab","Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`)."),
        ("gitcafe","GitCafe","cafe","Install the GitCafe CLI with `bun install -g @gitcafe/cli`, then run `cafe auth login --host https://git.cafe/api`, save a token in Settings, or set CAFE_TOKEN on the server."),
        ("forgejo","Forgejo / Gitea","tea","Install `fj` 0.6 or later from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj --host <server-url> auth add-token`, or install `tea` 0.16 or later from https://gitea.com/gitea/tea and run `tea login add` for each Forgejo or Gitea server."),
        ("azure-devops","Azure DevOps","az","Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`."),
    ];
    let (vcs, mut providers) = std::thread::scope(|scope| {
        let git = scope.spawn(|| item(cwd, "git", "Git", "git", git_hint, Some(true)));
        let jj = scope.spawn(|| item(cwd, "jj", "Jujutsu", "jj", jj_hint, Some(false)));
        let handles: Vec<_> = specs
            .iter()
            .map(|&(kind, label, exe, hint)| {
                scope.spawn(move || provider(cwd, kind, label, exe, hint))
            })
            .collect();
        (
            vec![git.join().unwrap(), jj.join().unwrap()],
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>(),
        )
    });
    providers.insert(5,json!({"kind":"bitbucket","label":"Bitbucket","status":"available","version":option(None),"installHint":"Add a Bitbucket token in Settings → Source Control.","detail":option(None),"auth":{"status":"unauthenticated","account":option(None),"host":option(Some("bitbucket.org")),"detail":option(Some("Add a Bitbucket token in Settings → Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server."))}}));
    json!({"versionControlSystems":vcs,"sourceControlProviders":providers})
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn probes_versions_and_classifies_missing_tools() {
        let dir = std::env::temp_dir().join(format!("source-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("fake");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '\\n fake version 1.2\\nsecond line\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let found = item(
            &dir,
            "fake",
            "Fake",
            executable.to_str().unwrap(),
            "hint",
            Some(true),
        );
        assert_eq!(found["status"], "available");
        assert_eq!(found["version"]["value"], "fake version 1.2");
        let missing = item(
            &dir,
            "missing",
            "Missing",
            dir.join("absent").to_str().unwrap(),
            "hint",
            Some(false),
        );
        assert_eq!(missing["status"], "missing");
        assert_eq!(missing["version"]["_tag"], "None");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
