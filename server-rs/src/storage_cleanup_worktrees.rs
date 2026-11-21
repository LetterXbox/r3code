//! Conservative linked-worktree removal primitive for storage cleanup.
//!
//! Policy, ownership, live sessions and terminals must be checked by the caller.
//! The callback is repeated under the workspace reservation immediately before
//! removal; returning an error or false always preserves the checkout.
use crate::workspace_safety::{self, ReservationKind};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Removed,
    Kept(&'static str),
    KeptIgnored(String),
}

/// Resolve the project override without allowing malformed settings to enable
/// cleanup. The returned object retains the machine policy's keep-when setting.
pub fn resolve_policy(settings: &serde_json::Value, project_id: &str) -> serde_json::Value {
    let base = &settings["storageCleanup"];
    let override_policy = settings["projectSettingsOverrides"][project_id]
        .get("worktreeCleanup")
        .unwrap_or(&settings["worktreeCleanup"]);
    match override_policy["mode"].as_str() {
        Some("custom") if override_policy["rules"].is_object() => override_policy["rules"].clone(),
        Some("off") => serde_json::json!({
            "worktreeKeepWhen": base["worktreeKeepWhen"],
            "worktreeAfterDays": null, "worktreeSettledAfterDays": null,
            "worktreeOnMerge": false, "worktreeOnDelete": false, "worktreeUnchanged": false
        }),
        _ => base.clone(),
    }
}

/// Cheap policy decision. A due result is only a candidate: it must never be
/// used to remove a worktree without the full live-state and Git checks.
#[derive(Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Due(&'static str),
    NeedsGit,
    Keep(&'static str),
}

pub fn policy_decision(
    policy: &serde_json::Value,
    deleted: bool,
    activity_age_seconds: u64,
    settled_age_seconds: Option<u64>,
    archived: bool,
) -> PolicyDecision {
    let flag = |key: &str| policy[key].as_bool() == Some(true);
    let age = |key: &str| policy[key].as_u64().and_then(|n| n.checked_mul(86_400));
    if deleted {
        return if flag("worktreeOnDelete") {
            PolicyDecision::Due("thread was deleted")
        } else {
            PolicyDecision::Keep("no rules apply")
        };
    }
    if age("worktreeAfterDays").is_some_and(|limit| activity_age_seconds > limit) {
        return PolicyDecision::Due("inactive");
    }
    if let (Some(elapsed), Some(limit)) = (settled_age_seconds, age("worktreeSettledAfterDays")) {
        if elapsed >= limit {
            return PolicyDecision::Due("settled");
        }
    }
    if flag("worktreeOnMerge")
        || (flag("worktreeUnchanged") && (archived || settled_age_seconds.is_some()))
    {
        PolicyDecision::NeedsGit
    } else {
        PolicyDecision::Keep("not due")
    }
}

/// A conservative snapshot supplied by the server immediately before removal.
/// Populate it from a consistent projection read and the live terminal manager.
/// Unknown or incomplete state must be represented by `complete = false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveState {
    pub complete: bool,
    /// All live thread bindings to this checkout. Shared ownership is retained
    /// until the caller can establish the full lineage and settlement chain.
    pub thread_bindings: Vec<ThreadBinding>,
    pub project_roots: Vec<PathBuf>,
    /// Non-stopped provider session working directories, including sessions whose
    /// runtime liveness is unknown. A false positive only preserves a checkout.
    pub session_cwds: Vec<PathBuf>,
    /// Working directories and worktree paths for starting or running terminals.
    pub terminal_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadBinding {
    pub id: String,
    pub branch: Option<String>,
    pub idle: bool,
    /// Changes whenever activity, settlement, or ownership changes.
    pub revision: String,
}

/// Collect projection and terminal state while holding the candidate's workspace
/// reservation. The caller must serialize this read with projection writes.
/// A non-stopped session without a known cwd makes the snapshot incomplete.
pub fn read_live_state(
    db: &rusqlite::Connection,
    terminals: &crate::terminal::TerminalManager,
    worktree: &Path,
) -> rusqlite::Result<LiveState> {
    let tree = fs::canonicalize(worktree).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut state = LiveState {
        complete: true,
        thread_bindings: vec![],
        project_roots: vec![],
        session_cwds: vec![],
        terminal_paths: vec![],
    };
    let mut stmt = db.prepare("SELECT thread_id,payload_json,updated_at FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY thread_id")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, raw, updated) = row?;
        let payload: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(path) = payload["worktreePath"].as_str() {
            let path = Path::new(path);
            if !path.is_absolute() {
                state.complete = false;
                continue;
            }
            match fs::canonicalize(path) {
                Ok(path) if path == tree => {
                    let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('queued','preparing','starting','running','waiting'))", [&id], |r| r.get(0))?;
                    state.thread_bindings.push(ThreadBinding {
                        id,
                        branch: payload["branch"].as_str().map(str::to_owned),
                        idle: !active,
                        revision: format!("{updated}\n{raw}"),
                    });
                }
                // A thread rooted inside the candidate (or at an ancestor of
                // it) can still access the checkout. Do not treat it as an
                // unrelated owner merely because its path is not identical.
                Ok(path) if path.starts_with(&tree) || tree.starts_with(&path) => {
                    state.complete = false;
                }
                Ok(_) => (),
                Err(_) => state.complete = false,
            }
        } else if !payload["worktreePath"].is_null() {
            state.complete = false;
        }
    }
    let mut stmt =
        db.prepare("SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL")?;
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        state.project_roots.push(PathBuf::from(row?));
    }
    let mut stmt = db.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'")?;
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let raw = row?;
        let payload: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(cwd) = payload["cwd"].as_str() {
            state.session_cwds.push(PathBuf::from(cwd));
        } else {
            state.complete = false;
        }
    }
    match terminals.cleanup_active_paths() {
        Ok(paths) => state.terminal_paths = paths,
        Err(_) => state.complete = false,
    }
    Ok(state)
}

/// Compare a fresh snapshot with the candidate's initial snapshot. This accepts
/// only an unshared live thread. Shared lineage cleanup requires additional
/// ownership and settlement checks.
/// Both calls must occur under coordination shared with terminal/provider startup.
pub fn live_state_eligible(
    worktree: &Path,
    owner_id: &str,
    expected_branch: &str,
    initial: &LiveState,
    latest: &LiveState,
) -> io::Result<bool> {
    if !initial.complete || !latest.complete || initial.thread_bindings != latest.thread_bindings {
        return Ok(false);
    }
    let [owner] = latest.thread_bindings.as_slice() else {
        return Ok(false);
    };
    if owner.id != owner_id
        || owner.branch.as_deref() != Some(expected_branch)
        || !owner.idle
        || owner.revision.is_empty()
    {
        return Ok(false);
    }
    paths_clear(worktree, latest)
}

/// A deleted owner may be cleaned only while no live thread owns the checkout.
/// The caller must separately recheck the deletion record and policy under the lease.
pub fn deleted_state_eligible(
    worktree: &Path,
    initial: &LiveState,
    latest: &LiveState,
) -> io::Result<bool> {
    if !initial.complete
        || !latest.complete
        || !initial.thread_bindings.is_empty()
        || !latest.thread_bindings.is_empty()
    {
        return Ok(false);
    }
    paths_clear(worktree, latest)
}

fn paths_clear(worktree: &Path, latest: &LiveState) -> io::Result<bool> {
    let tree = fs::canonicalize(worktree)?;
    for path in latest
        .project_roots
        .iter()
        .chain(&latest.session_cwds)
        .chain(&latest.terminal_paths)
    {
        // A relative, missing, or unreadable path cannot prove isolation.
        if !path.is_absolute() {
            return Ok(false);
        }
        let Ok(path) = fs::canonicalize(path) else {
            return Ok(false);
        };
        if path.starts_with(&tree) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn git(cwd: &Path, args: &[&std::ffi::OsStr]) -> io::Result<Vec<u8>> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    let out = crate::vcs_worktree::run_command(&mut command, std::time::Duration::from_secs(300))?;
    if !out.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ));
    }
    Ok(out.stdout)
}
fn no_nested_repositories(root: &Path) -> io::Result<bool> {
    let mut todo = vec![root.to_path_buf()];
    let mut count = 0usize;
    while let Some(dir) = todo.pop() {
        count += 1;
        if count > 2_000_000 {
            return Ok(false);
        }
        let mut names = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            names.push(entry.file_name());
            if ty.is_dir() {
                todo.push(entry.path());
            }
        }
        if dir != root
            && (names.iter().any(|n| n.eq_ignore_ascii_case(".git"))
                || ["HEAD", "objects", "refs"]
                    .iter()
                    .all(|n| names.iter().any(|x| x == n)))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Remove an eligible checkout only if it is an actual linked Git worktree under
/// a managed root, clean according to the configured policy, and contains no nested repo.
/// `still_eligible` must re-read policy, thread ownership, activity, sessions,
/// terminals, and project roots; it is called while startup is reserved.
pub fn remove_if_safe(
    project: &Path,
    worktree: &Path,
    managed_roots: &[PathBuf],
    expected_branch: &str,
    keep_when: &str,
    mut still_eligible: impl FnMut() -> io::Result<bool>,
) -> io::Result<Outcome> {
    let meta = fs::symlink_metadata(worktree)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Ok(Outcome::Kept("worktree is not a directory"));
    }
    let tree = fs::canonicalize(worktree)?;
    let project = fs::canonicalize(project)?;
    if tree == project || project.starts_with(&tree) {
        return Ok(Outcome::Kept("contains project checkout"));
    }
    let managed = managed_roots
        .iter()
        .filter_map(|r| fs::canonicalize(r).ok())
        .any(|r| r.parent().is_some() && tree != r && tree.starts_with(r));
    if !managed {
        return Ok(Outcome::Kept("outside managed worktree directories"));
    }
    // Use the same reservation and lease as provider startup and checkpoint restore.
    let _reservation = workspace_safety::reserve(&tree, ReservationKind::Restore);
    let _lease = workspace_safety::workspace_lease(&tree);
    if fs::canonicalize(worktree)? != tree || !still_eligible()? {
        return Ok(Outcome::Kept("thread activity or settings changed"));
    }
    let listed = git(
        &project,
        &[
            "worktree".as_ref(),
            "list".as_ref(),
            "--porcelain".as_ref(),
            "-z".as_ref(),
        ],
    )?;
    let registered = listed
        .split(|b| *b == 0)
        .filter_map(|entry| entry.strip_prefix(b"worktree "))
        .any(|p| {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                fs::canonicalize(Path::new(std::ffi::OsStr::from_bytes(p)))
                    .ok()
                    .as_ref()
                    == Some(&tree)
            }
            #[cfg(not(unix))]
            {
                std::str::from_utf8(p)
                    .ok()
                    .and_then(|s| fs::canonicalize(s).ok())
                    .as_ref()
                    == Some(&tree)
            }
        });
    if !registered {
        return Ok(Outcome::Kept("not a registered worktree"));
    }
    let branch = git(
        &tree,
        &["symbolic-ref".as_ref(), "--quiet".as_ref(), "HEAD".as_ref()],
    );
    match branch {
        Ok(raw) => {
            let ref_name = String::from_utf8_lossy(&raw).trim().to_owned();
            let short = ref_name.strip_prefix("refs/heads/");
            if short != Some(expected_branch) {
                return Ok(Outcome::Kept("branch changed"));
            }
        }
        Err(_) => {
            // Detached HEAD: allow removal only when no rebase/merge/bisect is in progress
            // and HEAD holds no commits unreachable from branches or remotes (#34967).
            let ops = git(
                &tree,
                &[
                    "rev-parse".as_ref(),
                    "--git-path".as_ref(),
                    "rebase-merge".as_ref(),
                    "--git-path".as_ref(),
                    "rebase-apply".as_ref(),
                    "--git-path".as_ref(),
                    "MERGE_HEAD".as_ref(),
                    "--git-path".as_ref(),
                    "MERGE_AUTOSTASH".as_ref(),
                    "--git-path".as_ref(),
                    "BISECT_LOG".as_ref(),
                ],
            )?;
            let ops_str = String::from_utf8_lossy(&ops);
            for line in ops_str.lines().map(str::trim).filter(|s| !s.is_empty()) {
                let p = tree.join(line);
                if p.exists() {
                    return Ok(Outcome::Kept("branch changed"));
                }
            }
            let unreachable = git(
                &tree,
                &[
                    "rev-list".as_ref(),
                    "--max-count=1".as_ref(),
                    "HEAD".as_ref(),
                    "--not".as_ref(),
                    "--branches".as_ref(),
                    "--remotes".as_ref(),
                ],
            )?;
            if !String::from_utf8_lossy(&unreachable).trim().is_empty() {
                return Ok(Outcome::Kept("branch changed"));
            }
        }
    }
    let initial_head = git(
        &tree,
        &["rev-parse".as_ref(), "--verify".as_ref(), "HEAD".as_ref()],
    )?;
    // Status and worktree remove can ignore edits to files marked as
    // assume-unchanged or skip-worktree. Preserve such checkouts entirely.
    let flags = git(&tree, &["ls-files".as_ref(), "-v".as_ref(), "-z".as_ref()])?;
    if flags
        .split(|b| *b == 0)
        .filter_map(|entry| entry.first())
        .any(|flag| *flag == b'S' || flag.is_ascii_lowercase())
    {
        return Ok(Outcome::Kept("worktree has hidden index entries"));
    }
    let mut status_args = vec!["status", "--porcelain=v1", "-z", "--ignore-submodules=none"];
    status_args.push(if keep_when == "tracked-changes" {
        "--untracked-files=no"
    } else {
        "--untracked-files=all"
    });
    let status = git(
        &tree,
        &status_args
            .iter()
            .map(|s| s.as_ref())
            .collect::<Vec<&std::ffi::OsStr>>(),
    )?;
    if !status.is_empty() {
        return Ok(Outcome::Kept("worktree has local changes"));
    }
    if keep_when != "tracked-changes" && keep_when != "uncommitted-changes" {
        let ignored = git(
            &tree,
            &[
                "ls-files".as_ref(),
                "--others".as_ref(),
                "--ignored".as_ref(),
                "--exclude-standard".as_ref(),
                "--directory".as_ref(),
                "-z".as_ref(),
            ],
        )?;
        if let Some(path) = ignored
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .find(|p| !p.ends_with(b"/node_modules/") && *p != b"node_modules/")
        {
            return Ok(Outcome::KeptIgnored(
                String::from_utf8_lossy(path).into_owned(),
            ));
        }
    }
    // Git requires force for submodules, so preserve them rather than risk data.
    if tree.join(".gitmodules").exists() || !no_nested_repositories(&tree)? {
        return Ok(Outcome::Kept("contains nested repository or submodules"));
    }
    if !still_eligible()? || fs::canonicalize(worktree)? != tree {
        return Ok(Outcome::Kept("thread activity or settings changed"));
    }
    if git(
        &tree,
        &["rev-parse".as_ref(), "--verify".as_ref(), "HEAD".as_ref()],
    )? != initial_head
    {
        return Ok(Outcome::Kept("worktree commit changed"));
    }
    if keep_when == "tracked-changes" {
        git(&tree, &["clean".as_ref(), "-ffdx".as_ref()])?;
    }
    git(
        &project,
        &[
            "worktree".as_ref(),
            "remove".as_ref(),
            "--".as_ref(),
            tree.as_os_str(),
        ],
    )?;
    Ok(Outcome::Removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_project_policies_and_age_boundaries() {
        let settings = serde_json::json!({"storageCleanup": {"worktreeAfterDays": 8, "worktreeOnDelete": true, "worktreeKeepWhen": "all-changes"}, "projectSettingsOverrides": {
            "off": {"worktreeCleanup": {"mode": "off"}},
            "custom": {"worktreeCleanup": {"mode": "custom", "rules": {"worktreeAfterDays": 2, "worktreeOnDelete": false}}}
        }});
        let inherited = resolve_policy(&settings, "other");
        assert_eq!(
            policy_decision(&inherited, false, 8 * 86400, None, false),
            PolicyDecision::Keep("not due")
        );
        assert_eq!(
            policy_decision(&inherited, false, 8 * 86400 + 1, None, false),
            PolicyDecision::Due("inactive")
        );
        assert_eq!(
            policy_decision(&inherited, true, 0, None, false),
            PolicyDecision::Due("thread was deleted")
        );
        assert_eq!(
            policy_decision(&resolve_policy(&settings, "off"), true, 0, None, false),
            PolicyDecision::Keep("no rules apply")
        );
        let global = serde_json::json!({"storageCleanup":{"worktreeOnDelete":true},"worktreeCleanup":{"mode":"off"},"projectSettingsOverrides":{"inherit-storage":{"worktreeCleanup":null}}});
        assert_eq!(
            policy_decision(&resolve_policy(&global, "other"), true, 0, None, false),
            PolicyDecision::Keep("no rules apply")
        );
        assert_eq!(
            policy_decision(
                &resolve_policy(&global, "inherit-storage"),
                true,
                0,
                None,
                false
            ),
            PolicyDecision::Due("thread was deleted")
        );
        assert_eq!(
            policy_decision(
                &resolve_policy(&settings, "custom"),
                false,
                3 * 86400,
                None,
                false
            ),
            PolicyDecision::Due("inactive")
        );
        let settled = serde_json::json!({"worktreeSettledAfterDays": 0});
        assert_eq!(
            policy_decision(&settled, false, 0, Some(0), false),
            PolicyDecision::Due("settled")
        );
        let unchanged = serde_json::json!({"worktreeUnchanged": true});
        assert_eq!(
            policy_decision(&unchanged, false, 0, None, false),
            PolicyDecision::Keep("not due")
        );
        assert_eq!(
            policy_decision(&unchanged, false, 0, None, true),
            PolicyDecision::NeedsGit
        );
    }
    fn run(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
        tree: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("cleanup-worktree-{}", uuid::Uuid::new_v4()));
            let project = root.join("project");
            let tree = root.join("managed/tree");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(tree.parent().unwrap()).unwrap();
            run(&project, &["init", "-q"]);
            run(&project, &["config", "user.email", "test@example.com"]);
            run(&project, &["config", "user.name", "Test"]);
            fs::write(project.join("file"), "initial").unwrap();
            run(&project, &["add", "file"]);
            run(&project, &["commit", "-qm", "initial"]);
            run(
                &project,
                &[
                    "worktree",
                    "add",
                    "-qb",
                    "cleanup-test",
                    tree.to_str().unwrap(),
                ],
            );
            Self {
                root,
                project,
                tree,
            }
        }
        fn clean(&self, eligible: bool, roots: &[PathBuf]) -> Outcome {
            remove_if_safe(
                &self.project,
                &self.tree,
                roots,
                "cleanup-test",
                "any-local-files",
                || Ok(eligible),
            )
            .unwrap()
        }
        fn roots(&self) -> Vec<PathBuf> {
            vec![self.root.join("managed")]
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn live_projection_snapshot_preserves_active_and_unknown_sessions() {
        let f = Fixture::new();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,status TEXT); CREATE TABLE projection_projects(workspace_root TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT,payload_json TEXT);").unwrap();
        let payload =
            serde_json::json!({"worktreePath": f.tree, "branch":"cleanup-test"}).to_string();
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES('owner',?1,'rev',NULL)",
            [&payload],
        )
        .unwrap();
        db.execute(
            "INSERT INTO projection_projects VALUES(?1,NULL)",
            [f.project.to_str().unwrap()],
        )
        .unwrap();
        let terminals = crate::terminal::TerminalManager::default();
        let initial = read_live_state(&db, &terminals, &f.tree).unwrap();
        assert!(live_state_eligible(&f.tree, "owner", "cleanup-test", &initial, &initial).unwrap());
        db.execute(
            "INSERT INTO orchestration_v2_projection_runs VALUES('owner','queued')",
            [],
        )
        .unwrap();
        let active = read_live_state(&db, &terminals, &f.tree).unwrap();
        assert!(!live_state_eligible(&f.tree, "owner", "cleanup-test", &initial, &active).unwrap());
        db.execute("DELETE FROM orchestration_v2_projection_runs", [])
            .unwrap();
        db.execute(
            "INSERT INTO orchestration_v2_projection_provider_sessions VALUES('ready','{}')",
            [],
        )
        .unwrap();
        let unknown = read_live_state(&db, &terminals, &f.tree).unwrap();
        assert!(!unknown.complete);
        assert!(
            !live_state_eligible(&f.tree, "owner", "cleanup-test", &initial, &unknown).unwrap()
        );
    }
    #[test]
    fn live_projection_snapshot_rejects_overlapping_thread_roots() {
        let f = Fixture::new();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,payload_json TEXT,updated_at TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,status TEXT); CREATE TABLE projection_projects(workspace_root TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT,payload_json TEXT);").unwrap();
        let terminals = crate::terminal::TerminalManager::default();
        let owner =
            serde_json::json!({"worktreePath": f.tree, "branch":"cleanup-test"}).to_string();
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES('owner',?1,'rev',NULL)",
            [&owner],
        )
        .unwrap();
        fs::create_dir(f.tree.join("nested")).unwrap();
        for path in [f.tree.join("nested"), f.root.join("managed")] {
            let other = serde_json::json!({"worktreePath": path}).to_string();
            db.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES('other',?1,'rev',NULL)",
                [&other],
            )
            .unwrap();
            let snapshot = read_live_state(&db, &terminals, &f.tree).unwrap();
            assert!(!snapshot.complete);
            assert!(
                !live_state_eligible(&f.tree, "owner", "cleanup-test", &snapshot, &snapshot)
                    .unwrap()
            );
            db.execute(
                "DELETE FROM orchestration_v2_projection_threads WHERE thread_id='other'",
                [],
            )
            .unwrap();
        }
    }
    #[test]
    fn live_state_rejects_changed_shared_or_occupied_worktrees() {
        let f = Fixture::new();
        let state = LiveState {
            complete: true,
            thread_bindings: vec![ThreadBinding {
                id: "owner".into(),
                branch: Some("cleanup-test".into()),
                idle: true,
                revision: "activity-1".into(),
            }],
            project_roots: vec![f.project.clone()],
            session_cwds: vec![],
            terminal_paths: vec![],
        };
        let check = |latest: &LiveState| {
            live_state_eligible(&f.tree, "owner", "cleanup-test", &state, latest).unwrap()
        };
        assert!(check(&state));
        let mut changed = state.clone();
        changed.thread_bindings[0].revision = "activity-2".into();
        assert!(!check(&changed));
        let mut shared = state.clone();
        shared
            .thread_bindings
            .push(state.thread_bindings[0].clone());
        assert!(!check(&shared));
        let mut active = state.clone();
        active.thread_bindings[0].idle = false;
        assert!(!live_state_eligible(&f.tree, "owner", "cleanup-test", &active, &active).unwrap());
        for index in 0..3 {
            let mut occupied = state.clone();
            match index {
                0 => occupied.project_roots.push(f.tree.clone()),
                1 => occupied.session_cwds.push(f.tree.clone()),
                _ => occupied.terminal_paths.push(f.tree.clone()),
            }
            assert!(!check(&occupied));
        }
        let mut unknown = state.clone();
        unknown.complete = false;
        assert!(!check(&unknown));
        let mut missing = state.clone();
        missing.terminal_paths.push(f.tree.join("missing"));
        assert!(!check(&missing));
    }
    #[test]
    fn deleted_owner_requires_unoccupied_checkout() {
        let f = Fixture::new();
        let empty = LiveState {
            complete: true,
            thread_bindings: vec![],
            project_roots: vec![f.project.clone()],
            session_cwds: vec![],
            terminal_paths: vec![],
        };
        assert!(deleted_state_eligible(&f.tree, &empty, &empty).unwrap());
        let mut occupied = empty.clone();
        occupied.terminal_paths.push(f.tree.clone());
        assert!(!deleted_state_eligible(&f.tree, &empty, &occupied).unwrap());
        occupied.terminal_paths.clear();
        occupied.thread_bindings.push(ThreadBinding {
            id: "other".into(),
            branch: Some("cleanup-test".into()),
            idle: true,
            revision: "1".into(),
        });
        assert!(!deleted_state_eligible(&f.tree, &empty, &occupied).unwrap());
        occupied.thread_bindings.clear();
        occupied.complete = false;
        assert!(!deleted_state_eligible(&f.tree, &empty, &occupied).unwrap());
    }
    #[test]
    fn eligibility_is_rechecked_before_git_removal() {
        let f = Fixture::new();
        let mut calls = 0;
        let outcome = remove_if_safe(
            &f.project,
            &f.tree,
            &f.roots(),
            "cleanup-test",
            "any-local-files",
            || {
                calls += 1;
                Ok(calls == 1)
            },
        )
        .unwrap();
        assert_eq!(
            outcome,
            Outcome::Kept("thread activity or settings changed")
        );
        assert_eq!(calls, 2);
        assert!(f.tree.exists());
    }
    #[test]
    fn preserves_dirty_active_and_unmanaged_worktrees() {
        let f = Fixture::new();
        assert_eq!(
            f.clean(false, &f.roots()),
            Outcome::Kept("thread activity or settings changed")
        );
        assert_eq!(
            f.clean(true, &[f.root.join("project")]),
            Outcome::Kept("outside managed worktree directories")
        );
        fs::write(f.tree.join("file"), "changed").unwrap();
        assert_eq!(
            f.clean(true, &f.roots()),
            Outcome::Kept("worktree has local changes")
        );
        assert!(f.tree.exists());
    }
    #[test]
    fn keep_policy_controls_ignored_and_untracked_files() {
        let ignored = Fixture::new();
        let excludes = ignored.root.join("excludes");
        fs::write(&excludes, "ignored-file\n").unwrap();
        run(
            &ignored.project,
            &["config", "core.excludesfile", excludes.to_str().unwrap()],
        );
        fs::write(ignored.tree.join("ignored-file"), "ignored").unwrap();
        assert_eq!(
            remove_if_safe(
                &ignored.project,
                &ignored.tree,
                &ignored.roots(),
                "cleanup-test",
                "any-local-files",
                || Ok(true)
            )
            .unwrap(),
            Outcome::KeptIgnored("ignored-file".into())
        );
        assert_eq!(
            remove_if_safe(
                &ignored.project,
                &ignored.tree,
                &ignored.roots(),
                "cleanup-test",
                "uncommitted-changes",
                || Ok(true)
            )
            .unwrap(),
            Outcome::Removed
        );
        let untracked = Fixture::new();
        fs::write(untracked.tree.join("untracked-file"), "untracked").unwrap();
        assert_eq!(
            remove_if_safe(
                &untracked.project,
                &untracked.tree,
                &untracked.roots(),
                "cleanup-test",
                "tracked-changes",
                || Ok(true)
            )
            .unwrap(),
            Outcome::Removed
        );
    }
    #[test]
    fn preserves_hidden_index_entries() {
        let f = Fixture::new();
        run(&f.tree, &["update-index", "--assume-unchanged", "file"]);
        fs::write(f.tree.join("file"), "hidden edit").unwrap();
        assert_eq!(
            f.clean(true, &f.roots()),
            Outcome::Kept("worktree has hidden index entries")
        );
        assert!(f.tree.exists());
    }
    #[test]
    fn removes_clean_registered_worktree_and_preserves_nested_repo() {
        let f = Fixture::new();
        fs::create_dir(f.tree.join("nested")).unwrap();
        run(&f.tree.join("nested"), &["init", "-q"]);
        assert_ne!(f.clean(true, &f.roots()), Outcome::Removed);
        fs::remove_dir_all(f.tree.join("nested")).unwrap();
        assert_eq!(f.clean(true, &f.roots()), Outcome::Removed);
        assert!(!f.tree.exists());
    }
}
