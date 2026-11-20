//! Git-backed status reads and status streams.
use crate::{http_server::RpcFailure, vcs_parse};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

// Refresh requests wake existing subscribers immediately. Weak entries keep the
// registry from retaining a channel for every workspace ever observed.
fn refresh_channel(cwd: &str) -> Arc<tokio::sync::broadcast::Sender<()>> {
    static CHANNELS: OnceLock<Mutex<HashMap<PathBuf, Weak<tokio::sync::broadcast::Sender<()>>>>> =
        OnceLock::new();
    let key = crate::workspace_safety::canonicalize_reservation(Path::new(cwd));
    let mut channels = CHANNELS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    channels.retain(|_, value| value.strong_count() > 0);
    if let Some(existing) = channels.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    let channel = Arc::new(tokio::sync::broadcast::channel(16).0);
    channels.insert(key, Arc::downgrade(&channel));
    channel
}
fn wake_subscribers(cwd: &str) {
    let _ = refresh_channel(cwd).send(());
}

pub fn handles(tag: &str) -> bool {
    matches!(
        tag,
        "vcs.refreshStatus"
            | "vcs.refreshBranch"
            | "subscribeVcsStatus"
            | "subscribeVcsBranch"
            | "vcs.listRefs"
            | "vcs.createWorktree"
            | "vcs.removeWorktree"
            | "vcs.createRef"
            | "vcs.switchRef"
            | "vcs.init"
    )
}
fn cwd(v: &Value) -> Result<&str, RpcFailure> {
    v.get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RpcFailure::Die(json!({"name":"Error","message":"Invalid RPC payload"})))
}
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}
fn trimmed(cwd: &str, args: &[&str]) -> Option<String> {
    git(cwd, args)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
fn default_ref(cwd: &str) -> Option<String> {
    let remotes = trimmed(cwd, &["remote"]).unwrap_or_default();
    let remote = if remotes.lines().any(|r| r == "origin") {
        "origin"
    } else {
        remotes.lines().next().unwrap_or("origin")
    };
    trimmed(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
    )
    .and_then(|s| s.strip_prefix(&format!("{remote}/")).map(str::to_owned))
}
fn local(cwd: &str) -> Value {
    let Some(root) = trimmed(cwd, &["rev-parse", "--show-toplevel"]) else {
        return json!({"isRepo":false,"hasPrimaryRemote":false,"isDefaultRef":false,"refName":null,"hasWorkingTreeChanges":false,"workingTree":{"files":[],"insertions":0,"deletions":0}});
    };
    let branch = trimmed(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let default = default_ref(cwd);
    let is_default = branch.as_deref().is_some_and(|b| {
        default
            .as_deref()
            .map_or(b == "main" || b == "master", |d| b == d)
    });
    let mut files: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    if let Some(status) = git(
        &root,
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    ) {
        let mut records = status.split('\0');
        while let Some(record) = records.next() {
            if let Some(path) = vcs_parse::porcelain_path(record) {
                files.entry(path.to_owned()).or_default();
            }
            if record.starts_with("2 ") {
                records.next();
            }
        }
    }
    // Compare HEAD to the working tree to account for staged and unstaged edits together.
    let diff = git(&root, &["diff", "--numstat", "-z", "HEAD", "--"])
        .or_else(|| git(&root, &["diff", "--cached", "--numstat", "-z", "--"]));
    if let Some(diff) = diff {
        for row in vcs_parse::review_numstat(&diff) {
            if let Some(counts) = files.get_mut(&row.path) {
                *counts = (row.additions, row.deletions);
            }
        }
    }
    let (mut adds, mut dels) = (0, 0);
    let rows: Vec<Value> = files
        .into_iter()
        .map(|(path, (a, d))| {
            adds += a;
            dels += d;
            json!({"path":path,"insertions":a,"deletions":d})
        })
        .collect();
    let dirty = !rows.is_empty();
    json!({"isRepo":true,"hasPrimaryRemote":git(cwd,&["remote", "get-url", "origin"]).is_some(),"isDefaultRef":is_default,"refName":branch,"hasWorkingTreeChanges":dirty,"workingTree":{"rootPath":root,"files":rows,"insertions":adds,"deletions":dels}})
}
fn remote(cwd: &str) -> Value {
    let upstream = trimmed(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let branch = trimmed(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let default = default_ref(cwd);
    let is_default = branch.as_deref().is_some_and(|b| {
        default
            .as_deref()
            .map_or(b == "main" || b == "master", |d| b == d)
    });
    let base_ahead = if branch.is_some() && !is_default {
        let mut candidates = Vec::new();
        if let Some(ref name) = default {
            candidates.push(format!("refs/remotes/origin/{name}"));
            candidates.push(format!("refs/heads/{name}"));
        }
        for name in ["main", "master"] {
            candidates.push(format!("refs/remotes/origin/{name}"));
            candidates.push(format!("refs/heads/{name}"));
        }
        candidates
            .into_iter()
            .filter(|base| git(cwd, &["show-ref", "--verify", "--quiet", base]).is_some())
            .find_map(|base| {
                trimmed(
                    cwd,
                    &[
                        "rev-list",
                        "--count",
                        "--end-of-options",
                        &format!("{base}..HEAD"),
                    ],
                )
                .and_then(|n| n.parse::<u64>().ok())
            })
            .unwrap_or(0)
    } else {
        0
    };
    let (ahead, behind) = if upstream.is_some() {
        trimmed(
            cwd,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )
        .and_then(|s| {
            let mut x = s.split_whitespace();
            Some((
                x.next()?.parse::<u64>().ok()?,
                x.next()?.parse::<u64>().ok()?,
            ))
        })
        .unwrap_or((0, 0))
    } else {
        (base_ahead, 0)
    };
    json!({"hasUpstream":upstream.is_some(),"aheadCount":ahead,"behindCount":behind,"aheadOfDefaultCount":base_ahead,"pr":null})
}
fn merged(local: Value, remote: Value) -> Value {
    let mut l = local.as_object().cloned().unwrap_or_default();
    l.extend(remote.as_object().cloned().unwrap_or_default());
    Value::Object(l)
}
fn invalid_payload() -> RpcFailure {
    RpcFailure::Die(json!({"name":"Error","message":"Invalid RPC payload"}))
}

fn run_branch_git(cwd: &str, operation: &str, args: &[&str]) -> Result<String, RpcFailure> {
    let output = Command::new("git")
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
    match output {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        result => {
            let (detail, code) = match result {
                Ok(out) => (
                    String::from_utf8_lossy(&out.stderr).trim().to_owned(),
                    out.status.code(),
                ),
                Err(e) => (e.to_string(), None),
            };
            Err(RpcFailure::Fail(
                json!({"_tag":"GitCommandError", "operation":operation,
                "command":"git", "cwd":cwd, "exitCode":code, "detail":detail}),
            ))
        }
    }
}

fn branch_dispatch(tag: &str, cwd: &str, v: &Value) -> Result<Value, RpcFailure> {
    if tag == "vcs.init" {
        if v.get("kind").is_some_and(|x| x != "git") {
            return Err(invalid_payload());
        }
        run_branch_git(cwd, "GitVcsDriver.initRepo", &["init"])?;
        return Ok(Value::Null);
    }
    if tag == "vcs.createRef" || tag == "vcs.switchRef" {
        let name = v
            .get("refName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('-'))
            .ok_or_else(invalid_payload)?;
        if v.get("switchRef").is_some_and(|x| !x.is_boolean()) {
            return Err(invalid_payload());
        }
        if tag == "vcs.createRef" {
            run_branch_git(cwd, "GitVcsDriver.createRef", &["branch", "--", name])?;
            if v.get("switchRef") != Some(&Value::Bool(true)) {
                return Ok(json!({"refName":name}));
            }
        }
        let local_exists = git(
            cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )
        .is_some();
        let remote_exists = git(
            cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{name}"),
            ],
        )
        .is_some();
        let mut checkout = name.to_owned();
        let mut track = false;
        if remote_exists && !local_exists {
            let remote_ref = format!("refs/remotes/{name}");
            let branches = git(
                cwd,
                &[
                    "for-each-ref",
                    "--format=%(refname:lstrip=2)%09%(upstream)",
                    "refs/heads",
                ],
            )
            .unwrap_or_default();
            let existing = branches
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .find(|(_, upstream)| *upstream == remote_ref)
                .map(|(branch, _)| branch.to_owned());
            if let Some(branch) = existing {
                checkout = branch;
            } else if let Some((_, candidate)) = name.split_once('/').filter(|(_, b)| !b.is_empty())
            {
                let candidate_ref = format!("refs/heads/{candidate}");
                if git(cwd, &["show-ref", "--verify", "--quiet", &candidate_ref]).is_none() {
                    run_branch_git(
                        cwd,
                        "GitVcsDriver.switchRef.createTrackingBranch",
                        &["branch", "--no-track", "--", candidate, &remote_ref],
                    )?;
                    let upstream = format!("--set-upstream-to={remote_ref}");
                    if let Err(error) = run_branch_git(
                        cwd,
                        "GitVcsDriver.switchRef.trackRemote",
                        &["branch", &upstream, "--", candidate],
                    ) {
                        let _ = git(cwd, &["update-ref", "-d", &candidate_ref, &remote_ref]);
                        return Err(error);
                    }
                    checkout = candidate.to_owned();
                } else {
                    track = true;
                }
            } else {
                track = true;
            }
        }
        let args = if track {
            vec!["checkout", "--track", checkout.as_str(), "--"]
        } else {
            vec!["checkout", checkout.as_str(), "--"]
        };
        run_branch_git(cwd, "GitVcsDriver.switchRef.checkout", &args)?;
        let current = trimmed(cwd, &["branch", "--show-current"]);
        return Ok(json!({"refName":current}));
    }
    for key in ["refresh", "includeMatchingRemoteRefs"] {
        if v.get(key).is_some_and(|x| !x.is_boolean()) {
            return Err(invalid_payload());
        }
    }
    let kind = v
        .get("refKind")
        .map(|x| x.as_str())
        .unwrap_or(Some("all"))
        .filter(|x| matches!(*x, "all" | "local" | "remote"))
        .ok_or_else(invalid_payload)?;
    let query = match v.get("query") {
        None => "",
        Some(Value::String(s)) if !s.trim().is_empty() && s.encode_utf16().count() <= 256 => {
            s.trim()
        }
        _ => return Err(invalid_payload()),
    }
    .to_lowercase();
    let cursor = match v.get("cursor") {
        None => 0,
        Some(x) => x.as_u64().ok_or_else(invalid_payload)? as usize,
    };
    let limit = match v.get("limit") {
        None => 100,
        Some(x) => x
            .as_u64()
            .filter(|n| (1..=200).contains(n))
            .ok_or_else(invalid_payload)? as usize,
    };
    let Some(root) = trimmed(cwd, &["rev-parse", "--show-toplevel"]) else {
        return Ok(
            json!({"refs":[],"isRepo":false,"hasPrimaryRemote":false,"nextCursor":null,"totalCount":0}),
        );
    };
    let current = trimmed(cwd, &["branch", "--show-current"]);
    let default = default_ref(cwd);
    let remote_names = trimmed(cwd, &["remote"]).unwrap_or_default();
    let worktrees = git(cwd, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let mut paths = BTreeMap::new();
    let mut path = None;
    for line in worktrees.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_owned());
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = path.take() {
                paths.insert(branch.to_owned(), p);
            }
        }
    }
    let output = run_branch_git(
        cwd,
        "GitVcsDriver.listRefs",
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%09%(symref)%09%(upstream)%09%(committerdate:unix)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let rows: Vec<Vec<&str>> = output.lines().map(|l| l.split('\t').collect()).collect();
    let local_names: std::collections::HashSet<&str> = rows
        .iter()
        .filter_map(|r| r.first()?.strip_prefix("refs/heads/"))
        .collect();
    let mut refs = Vec::new();
    for row in &rows {
        if row.len() < 4 || !row[1].is_empty() {
            continue;
        }
        let (name, is_remote) = if let Some(n) = row[0].strip_prefix("refs/heads/") {
            (n, false)
        } else if let Some(n) = row[0].strip_prefix("refs/remotes/") {
            (n, true)
        } else {
            continue;
        };
        let remote = remote_names
            .lines()
            .filter(|r| name.strip_prefix(r).is_some_and(|s| s.starts_with('/')))
            .max_by_key(|r| r.len());
        if is_remote
            && v.get("includeMatchingRemoteRefs") != Some(&Value::Bool(true))
            && remote == Some("origin")
            && remote
                .and_then(|r| name.strip_prefix(&format!("{r}/")))
                .is_some_and(|n| local_names.contains(n))
        {
            continue;
        }
        if (kind == "local" && is_remote)
            || (kind == "remote" && !is_remote)
            || !name.to_lowercase().contains(&query)
        {
            continue;
        }
        let is_current = !is_remote && current.as_deref() == Some(name);
        let is_default = default.as_deref().is_some_and(|d| {
            if is_remote {
                name == format!("origin/{d}")
            } else {
                name == d
            }
        });
        let mut item = json!({"name":name,"current":is_current,"isRemote":is_remote,"isDefault":is_default,"worktreePath":paths.get(name)});
        if is_remote {
            if let Some(r) = remote {
                item["remoteName"] = json!(r);
            }
        } else if !row[2].is_empty() {
            item["upstreamRef"] = json!(row[2]);
        }
        refs.push((item, row[3].parse::<i64>().unwrap_or(0)));
    }
    refs.sort_by(|(a, at), (b, bt)| {
        let priority = |v: &Value| {
            if v["current"] == true {
                0
            } else if v["isDefault"] == true {
                1
            } else {
                2
            }
        };
        priority(a)
            .cmp(&priority(b))
            .then_with(|| a["isRemote"].as_bool().cmp(&b["isRemote"].as_bool()))
            .then_with(|| bt.cmp(at))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    let count = refs.len();
    let selected: Vec<_> = refs
        .into_iter()
        .skip(cursor)
        .take(limit)
        .map(|(item, _)| item)
        .collect();
    let next = cursor.checked_add(selected.len()).filter(|n| *n < count);
    let at_root = std::fs::canonicalize(cwd).ok() == std::fs::canonicalize(root).ok();
    Ok(
        json!({"isAtRepositoryRoot":at_root,"refs":selected,"isRepo":true,"hasPrimaryRemote":!remote_names.is_empty(),"nextCursor":next,"totalCount":count}),
    )
}

pub fn dispatch(tag: &str, payload: &Value) -> Result<Value, RpcFailure> {
    let root = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".t3/worktrees");
    dispatch_with_worktrees(tag, payload, &root)
}

pub fn dispatch_with_worktrees(
    tag: &str,
    payload: &Value,
    worktrees_root: &Path,
) -> Result<Value, RpcFailure> {
    dispatch_with_worktrees_and_submodules(tag, payload, worktrees_root, None)
}

pub fn dispatch_with_worktrees_and_submodules(
    tag: &str,
    payload: &Value,
    worktrees_root: &Path,
    submodules: Option<&str>,
) -> Result<Value, RpcFailure> {
    if matches!(tag, "vcs.createWorktree" | "vcs.removeWorktree") {
        return crate::vcs_worktree::dispatch(tag, payload, worktrees_root, submodules);
    }
    let cwd = cwd(payload)?;
    if matches!(
        tag,
        "vcs.listRefs" | "vcs.createRef" | "vcs.switchRef" | "vcs.init"
    ) {
        return branch_dispatch(tag, cwd, payload);
    }
    if tag == "vcs.refreshBranch" {
        wake_subscribers(cwd);
        return Ok(Value::Null);
    }
    if payload.get("localOnly").is_some_and(|v| !v.is_boolean()) {
        return Err(RpcFailure::Die(
            json!({"name":"Error","message":"Invalid RPC payload"}),
        ));
    }
    let result = merged(
        local(cwd),
        if payload.get("localOnly") == Some(&Value::Bool(true)) {
            json!({"hasUpstream":false,"aheadCount":0,"behindCount":0,"aheadOfDefaultCount":0,"pr":null})
        } else {
            remote(cwd)
        },
    );
    wake_subscribers(cwd);
    Ok(result)
}
pub fn stream(
    tag: &str,
    payload: &Value,
) -> tokio::sync::mpsc::Receiver<Result<Vec<Value>, Value>> {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let cwd = match cwd(payload) {
        Ok(c) => c.to_owned(),
        Err(_) => {
            tokio::spawn(async move {
                let _ = tx
                    .send(Err(json!({"name":"Error","message":"Invalid RPC payload"})))
                    .await;
            });
            return rx;
        }
    };
    let branch_only = tag == "subscribeVcsBranch";
    let include_remote = payload.get("includeRemote") != Some(&Value::Bool(false));
    let channel = refresh_channel(&cwd);
    let mut refreshes = channel.subscribe();
    tokio::spawn(async move {
        let _channel = channel;
        let mut previous: Option<Value> = None;
        loop {
            let path = cwd.clone();
            let Ok(state) = tokio::task::spawn_blocking(move || {
                if branch_only {
                    let is_repo = trimmed(&path, &["rev-parse", "--show-toplevel"]).is_some();
                    let branch = is_repo
                        .then(|| trimmed(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"]))
                        .flatten();
                    json!({"refName":branch,"isRepo":is_repo})
                } else {
                    json!({"local":local(&path),"remote":include_remote.then(|| remote(&path))})
                }
            })
            .await
            else {
                break;
            };
            let mut events = Vec::new();
            if let Some(old) = &previous {
                if branch_only {
                    if *old != state {
                        events.push(state.clone());
                    }
                } else {
                    if old["local"] != state["local"] {
                        events.push(json!({"_tag":"localUpdated","local":state["local"]}));
                    }
                    if old["remote"] != state["remote"] {
                        events.push(json!({"_tag":"remoteUpdated","remote":state["remote"]}));
                    }
                }
            } else if branch_only {
                events.push(state.clone());
            } else {
                events.push(
                    json!({"_tag":"snapshot","local":state["local"],"remote":state["remote"]}),
                );
            }
            previous = Some(state);
            for event in events {
                if tx.send(Ok(vec![event])).await.is_err() {
                    return;
                }
            }
            tokio::select! { _ = tx.closed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = refreshes.recv() => {} }
        }
    });
    rx
}
#[allow(dead_code)]
fn _path(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn run(path: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap()
            .status
            .success());
    }
    #[tokio::test]
    async fn refresh_branch_wakes_live_subscribers() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-refresh-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-b", "main"]);
        let input = json!({"cwd":dir,"includeRemote":false});
        let channel = refresh_channel(cwd(&input).unwrap());
        let mut refreshes = channel.subscribe();
        let mut events = stream("subscribeVcsBranch", &input);
        let first = events.recv().await.unwrap().unwrap();
        assert_eq!(first[0]["refName"], "main");
        run(&dir, &["symbolic-ref", "HEAD", "refs/heads/next"]);
        assert_eq!(dispatch("vcs.refreshBranch", &input).unwrap(), Value::Null);
        // Check the notification directly so a periodic poll cannot satisfy this assertion.
        refreshes.try_recv().expect("branch refresh must wake live subscribers");
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(event[0]["refName"], "next");
        drop(events);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn reports_real_worktree_and_branch_changes() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-b", "main"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "Test"]);
        fs::write(dir.join("a file"), "one\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "initial"]);
        let payload = json!({"cwd":dir.to_str().unwrap(),"includeRemote":false});
        let mut events = stream("subscribeVcsStatus", &payload);
        let first = events.recv().await.unwrap().unwrap().remove(0);
        assert_eq!(first["_tag"], "snapshot");
        assert_eq!(first["local"]["refName"], "main");
        fs::write(dir.join("a file"), "one\ntwo\n").unwrap();
        let second = tokio::time::timeout(Duration::from_secs(4), events.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .remove(0);
        assert_eq!(second["_tag"], "localUpdated");
        assert_eq!(second["local"]["workingTree"]["files"][0]["path"], "a file");
        assert_eq!(second["local"]["workingTree"]["insertions"], 1);
        run(&dir, &["checkout", "-b", "feature"]);
        let third = tokio::time::timeout(Duration::from_secs(4), events.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .remove(0);
        assert_eq!(third["local"]["refName"], "feature");
        drop(events);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn reports_divergence_and_working_tree_updates() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-divergence-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-b", "main"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "Test"]);
        fs::write(dir.join("file"), "one\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "initial"]);
        assert_eq!(
            dispatch("vcs.refreshStatus", &json!({"cwd":dir})).unwrap()["isDefaultRef"],
            true
        );
        run(&dir, &["checkout", "-b", "feature"]);
        let mut events = stream("subscribeVcsStatus", &json!({"cwd":dir}));
        events.recv().await.unwrap().unwrap();
        fs::write(dir.join("file"), "one\ntwo\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "feature"]);
        fs::write(dir.join("file"), "one\ntwo\nthree\n").unwrap();
        // The poll can observe the commit before the working-tree edit. Wait for
        // both final values regardless of whether they arrive in one cycle.
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut saw_local = false;
            let mut saw_remote = false;
            while !saw_local || !saw_remote {
                for event in events.recv().await.unwrap().unwrap() {
                    if event["_tag"] == "localUpdated" {
                        saw_local |= event["local"]["workingTree"]["files"]
                            .as_array()
                            .is_some_and(|files| files.iter().any(|file| file["path"] == "file"));
                    }
                    if event["_tag"] == "remoteUpdated" {
                        saw_remote |= event["remote"]["aheadCount"] == 1
                            && event["remote"]["aheadOfDefaultCount"] == 1;
                    }
                }
            }
        })
        .await
        .expect("both final VCS status updates should reach the subscriber");
        drop(events);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn branch_operations_and_paginated_listing() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-refs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dispatch("vcs.init", &json!({"cwd":dir})).unwrap();
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "Test"]);
        fs::write(dir.join("file"), "hello").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "initial"]);
        let created = dispatch(
            "vcs.createRef",
            &json!({"cwd":dir,"refName":"feature","switchRef":true}),
        )
        .unwrap();
        assert_eq!(created["refName"], "feature");
        let page = dispatch("vcs.listRefs", &json!({"cwd":dir,"limit":1})).unwrap();
        assert_eq!(page["totalCount"], 2);
        assert_eq!(page["refs"][0]["name"], "feature");
        assert_eq!(page["refs"][0]["current"], true);
        assert_eq!(page["nextCursor"], 1);
        let next = dispatch("vcs.listRefs", &json!({"cwd":dir,"cursor":1,"limit":1})).unwrap();
        assert_eq!(next["refs"].as_array().unwrap().len(), 1);
        assert!(next["nextCursor"].is_null());
        let filtered = dispatch("vcs.listRefs", &json!({"cwd":dir,"query":"FEATURE"})).unwrap();
        assert_eq!(filtered["totalCount"], 1);
        assert!(dispatch("vcs.switchRef", &json!({"cwd":dir,"refName":"--force"})).is_err());
        assert!(dispatch("vcs.createRef", &json!({"cwd":dir,"refName":"feature"})).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn remote_refs_create_or_reuse_tracking_branches_and_sort_locals_first() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-remotes-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-b", "main"]);
        run(&dir, &["config", "user.email", "test@example.com"]);
        run(&dir, &["config", "user.name", "Test"]);
        fs::write(dir.join("file"), "hello").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "initial"]);
        run(
            &dir,
            &["remote", "add", "origin", "https://example.invalid/repo"],
        );
        run(
            &dir,
            &["remote", "add", "other", "https://example.invalid/other"],
        );
        run(&dir, &["update-ref", "refs/remotes/origin/feature", "HEAD"]);
        run(&dir, &["update-ref", "refs/remotes/other/feature", "HEAD"]);
        let switched = dispatch(
            "vcs.switchRef",
            &json!({"cwd":dir,"refName":"origin/feature"}),
        )
        .unwrap();
        assert_eq!(switched["refName"], "feature");
        assert_eq!(
            trimmed(
                dir.to_str().unwrap(),
                &["rev-parse", "--abbrev-ref", "feature@{upstream}"]
            )
            .as_deref(),
            Some("origin/feature")
        );
        run(&dir, &["checkout", "main"]);
        let switched = dispatch(
            "vcs.switchRef",
            &json!({"cwd":dir,"refName":"origin/feature"}),
        )
        .unwrap();
        assert_eq!(switched["refName"], "feature");
        let refs = dispatch("vcs.listRefs", &json!({"cwd":dir,"query":"feature"})).unwrap();
        assert_eq!(refs["totalCount"], 2);
        assert_eq!(refs["refs"][0]["name"], "feature");
        assert_eq!(refs["refs"][1]["name"], "other/feature");
        let all = dispatch(
            "vcs.listRefs",
            &json!({"cwd":dir,"query":"feature","includeMatchingRemoteRefs":true}),
        )
        .unwrap();
        assert_eq!(all["totalCount"], 3);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn non_repository_has_empty_status() {
        let status = dispatch("vcs.refreshStatus", &json!({"cwd":std::env::temp_dir()})).unwrap();
        assert_eq!(status["isRepo"], false);
        assert_eq!(status["workingTree"]["files"], json!([]));
    }
}
