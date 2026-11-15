//! Durable records for future scheduled worktree preparation.
//!
//! Callers must insert a plan before creating a checkout. Recovery inspects
//! unattached plans and verifies repository ownership before any cleanup.
use rusqlite::{params, Connection};

#[derive(Debug, PartialEq, Eq)]
pub struct Preparation {
    pub run_key: String,
    pub task_id: String,
    pub thread_id: String,
    pub project_root: String,
    pub worktree_path: String,
    pub branch: String,
    pub phase: String,
    pub created_at: String,
}

/// Initialize the private journal independently of upstream migration IDs.
pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(include_str!(
        "../migrations/internal-scheduled-worktrees.sql"
    ))
}

pub fn plan(db: &Connection, p: &Preparation) -> rusqlite::Result<()> {
    db.execute("INSERT INTO scheduled_worktree_preparations (run_key, task_id, thread_id, project_root, worktree_path, branch, phase, created_at) VALUES (?1,?2,?3,?4,?5,?6,'planned',?7)", params![p.run_key,p.task_id,p.thread_id,p.project_root,p.worktree_path,p.branch,p.created_at])?;
    Ok(())
}

/// Advance only the expected phase; stale workers cannot overwrite recovery.
pub fn advance(db: &Connection, key: &str, expected: &str, next: &str) -> rusqlite::Result<bool> {
    if !matches!(
        (expected, next),
        ("planned", "created") | ("created", "attached")
    ) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(db.execute(
        "UPDATE scheduled_worktree_preparations SET phase=?3 WHERE run_key=?1 AND phase=?2",
        params![key, expected, next],
    )? == 1)
}

/// Return unfinished records for an ownership-aware recovery worker.
pub fn pending(db: &Connection) -> rusqlite::Result<Vec<Preparation>> {
    let mut stmt = db.prepare("SELECT run_key,task_id,thread_id,project_root,worktree_path,branch,phase,created_at FROM scheduled_worktree_preparations WHERE phase != 'attached' ORDER BY created_at,run_key")?;
    let rows = stmt.query_map([], |r| {
        Ok(Preparation {
            run_key: r.get(0)?,
            task_id: r.get(1)?,
            thread_id: r.get(2)?,
            project_root: r.get(3)?,
            worktree_path: r.get(4)?,
            branch: r.get(5)?,
            phase: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    rows.collect()
}

/// Reconcile a crash after thread creation with its durable preparation.
///
/// This only recognizes a thread whose project, checkout and branch all match
/// the journal. Other entries are intentionally retained: a missing thread is
/// not by itself proof that a checkout or branch can safely be removed.
pub fn reconcile_attached(db: &Connection) -> rusqlite::Result<usize> {
    db.execute(
        "UPDATE scheduled_worktree_preparations AS w SET phase='attached' \
         WHERE w.phase IN ('planned','created') AND EXISTS ( \
           SELECT 1 FROM orchestration_v2_projection_threads AS t \
           JOIN projection_projects AS p ON p.project_id=t.project_id \
           WHERE t.thread_id=w.thread_id AND t.deleted_at IS NULL \
             AND p.workspace_root=w.project_root \
             AND json_extract(t.payload_json,'$.worktreePath')=w.worktree_path \
             AND json_extract(t.payload_json,'$.branch')=w.branch \
         )",
        [],
    )
}

/// Remove a record only after cleanup has succeeded or ownership is resolved.
pub fn forget(db: &Connection, key: &str, expected: &str) -> rusqlite::Result<bool> {
    Ok(db.execute(
        "DELETE FROM scheduled_worktree_preparations WHERE run_key=?1 AND phase=?2",
        params![key, expected],
    )? == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_survives_reopen_and_rejects_stale_transitions() {
        let path = std::env::temp_dir().join(format!("journal-{}.db", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).unwrap();
        initialize(&db).unwrap();
        initialize(&db).unwrap();
        let p = Preparation {
            run_key: "run".into(),
            task_id: "task".into(),
            thread_id: "thread".into(),
            project_root: "/repo".into(),
            worktree_path: "/trees/run".into(),
            branch: "t3/run".into(),
            phase: "planned".into(),
            created_at: "now".into(),
        };
        plan(&db, &p).unwrap();
        assert!(plan(&db, &p).is_err());
        drop(db);
        let db = Connection::open(&path).unwrap();
        assert_eq!(pending(&db).unwrap(), vec![p]);
        assert!(advance(&db, "run", "planned", "attached").is_err());
        assert!(advance(&db, "run", "planned", "created").unwrap());
        assert!(!forget(&db, "run", "planned").unwrap());
        assert!(advance(&db, "run", "created", "attached").unwrap());
        assert!(pending(&db).unwrap().is_empty());
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reconciliation_requires_exact_thread_ownership_and_preserves_other_plans() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        initialize(&db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/repo','[]','now','now')", []).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('thread','p','T','codex','auto','default','now','now',?1)", [r#"{"worktreePath":"/trees/run","branch":"t3/run"}"#]).unwrap();
        let p = Preparation {
            run_key: "run".into(),
            task_id: "task".into(),
            thread_id: "thread".into(),
            project_root: "/repo".into(),
            worktree_path: "/trees/run".into(),
            branch: "t3/run".into(),
            phase: "planned".into(),
            created_at: "now".into(),
        };
        plan(&db, &p).unwrap();
        let other = Preparation {
            run_key: "other".into(),
            worktree_path: "/trees/other".into(),
            ..p
        };
        plan(&db, &other).unwrap();
        assert_eq!(reconcile_attached(&db).unwrap(), 1);
        assert_eq!(reconcile_attached(&db).unwrap(), 0);
        assert_eq!(pending(&db).unwrap(), vec![other]);
    }
}

/// Create a checkout from a committed reference. The database must be in
/// autocommit mode: the plan must survive a process crash before Git runs.
#[allow(clippy::too_many_arguments)]
pub fn prepare_checkout(
    db: &Connection,
    task_id: &str,
    thread_id: &str,
    project_root: &std::path::Path,
    worktrees_root: &std::path::Path,
    base_ref: &str,
    requested_branch: Option<&str>,
    created_at: &str,
) -> Result<Preparation, String> {
    if !db.is_autocommit() {
        return Err("Worktree preparation requires an autocommit connection".into());
    }
    let (p, commit) = checkout_plan(
        task_id,
        thread_id,
        project_root,
        worktrees_root,
        base_ref,
        requested_branch,
        created_at,
    )?;
    initialize(db).map_err(|e| e.to_string())?;
    plan(db, &p).map_err(|e| e.to_string())?;
    create_planned_checkout(&p, &commit)?;
    if !advance(db, &p.run_key, "planned", "created").map_err(|e| e.to_string())? {
        return Err("Worktree preparation was concurrently recovered".into());
    }
    Ok(Preparation {
        phase: "created".into(),
        ..p
    })
}

pub fn checkout_plan(
    task_id: &str,
    thread_id: &str,
    project_root: &std::path::Path,
    worktrees_root: &std::path::Path,
    base_ref: &str,
    requested_branch: Option<&str>,
    created_at: &str,
) -> Result<(Preparation, String), String> {
    let root = std::fs::canonicalize(project_root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(worktrees_root).map_err(|e| e.to_string())?;
    let trees = std::fs::canonicalize(worktrees_root).map_err(|e| e.to_string())?;
    let commit = git_output(
        &root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{base_ref}^{{commit}}"),
        ],
    )?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = trees.join(format!("scheduled-{id}"));
    Ok((
        Preparation {
            run_key: id.clone(),
            task_id: task_id.into(),
            thread_id: thread_id.into(),
            project_root: project_root
                .to_str()
                .ok_or("Non-UTF-8 project root")?
                .into(),
            worktree_path: path.to_str().ok_or("Non-UTF-8 worktree path")?.into(),
            branch: requested_branch
                .map(str::to_owned)
                .unwrap_or_else(|| format!("t3/scheduled-{id}")),
            phase: "planned".into(),
            created_at: created_at.into(),
        },
        commit,
    ))
}

pub fn create_planned_checkout(p: &Preparation, commit: &str) -> Result<(), String> {
    git_output(
        std::path::Path::new(&p.project_root),
        &[
            "worktree",
            "add",
            "-b",
            &p.branch,
            "--",
            &p.worktree_path,
            commit,
        ],
    )?;
    Ok(())
}

/// Resolve and fetch the remote branch used by an origin-based launch.
pub fn fetch_base(root: &std::path::Path, base: &str) -> Result<Option<String>, String> {
    let remotes = git_output(root, &["remote"])?;
    let mut names: Vec<&str> = remotes.lines().collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    let local = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)",
            &format!("refs/heads/{base}"),
        ],
    )?;
    let target = local
        .lines()
        .filter_map(|l| {
            let mut fields = l.split('\t');
            Some((fields.next()?, fields.next()?, fields.next()?))
        })
        .find(|v| v.0 == format!("refs/heads/{base}"));
    let parsed = target
        .and_then(|(_, remote, merge)| {
            names
                .contains(&remote)
                .then(|| {
                    merge
                        .strip_prefix("refs/heads/")
                        .map(|branch| (remote, branch))
                })
                .flatten()
        })
        .or_else(|| {
            if target.is_some() {
                None
            } else {
                names.iter().find_map(|name| {
                    base.strip_prefix(&format!("{name}/"))
                        .map(|branch| (*name, branch))
                })
            }
        });
    let (remote, branch) = parsed.unwrap_or(("origin", base));
    if !names.contains(&remote) {
        return Ok(None);
    }
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let refspec = format!("+refs/heads/{branch}:{remote_ref}");
    git_output(
        root,
        &["fetch", "--quiet", "--no-tags", "--", remote, &refspec],
    )?;
    Ok(Some(git_output(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{remote_ref}^{{commit}}"),
        ],
    )?))
}

fn git_output(root: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}

/// Populate the checkout after its branch has been selected. A project setting
/// overrides t3.json; absent or invalid values fall back to recursive checkout.
/// As in the Git driver, a failed submodule checkout is reported to the caller
/// but does not invalidate the worktree itself.
pub fn initialize_submodules(
    checkout: &std::path::Path,
    setting: Option<&str>,
) -> Result<(), String> {
    if !checkout.join(".gitmodules").exists() {
        return Ok(());
    }
    let file_setting = std::fs::read_to_string(checkout.join("t3.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("worktreeSubmodules")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        });
    let mode = setting.or(file_setting.as_deref()).unwrap_or("recursive");
    if mode == "none" {
        return Ok(());
    }
    git_output(checkout, &["submodule", "init"])?;
    let mut args = vec!["submodule", "update", "--init"];
    if mode != "top-level" {
        args.push("--recursive");
    }
    git_output(checkout, &args)?;
    Ok(())
}

/// Recover orphaned registered checkouts at startup, before workers start.
/// Only an exact path/branch pairing registered in the recorded repository is
/// eligible. Ambiguous or partial Git state is left for manual inspection.
pub fn recover_checkouts(db: &Connection) -> Result<usize, String> {
    if !db.is_autocommit() {
        return Err("Worktree recovery requires an autocommit connection".into());
    }
    initialize(db).map_err(|e| e.to_string())?;
    reconcile_attached(db).map_err(|e| e.to_string())?;
    let mut recovered = 0;
    for p in pending(db).map_err(|e| e.to_string())? {
        if !remove_orphan_checkout(&p)? {
            continue;
        }
        // A clean checkout can still contain commits made after creation. Keep
        // its branch so recovery cannot discard those commits.
        if forget(db, &p.run_key, &p.phase).map_err(|e| e.to_string())? {
            recovered += 1;
        }
    }
    Ok(recovered)
}

/// Remove only a clean, exactly registered checkout; no database lock is needed.
pub fn remove_orphan_checkout(p: &Preparation) -> Result<bool, String> {
    let root = std::path::Path::new(&p.project_root);
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(false);
    }
    let expected_path = format!("worktree {}", p.worktree_path);
    let expected_branch = format!("branch refs/heads/{}", p.branch);
    let matched = out
        .stdout
        .split(|b| *b == 0)
        .collect::<Vec<_>>()
        .split(|entry| entry.is_empty())
        .any(|record| {
            record.contains(&expected_path.as_bytes())
                && record.contains(&expected_branch.as_bytes())
        });
    if !matched {
        return Ok(false);
    }
    // Never discard edits made after the checkout was created.
    let checkout = std::path::Path::new(&p.worktree_path);
    if git_output(
        checkout,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .map_or(true, |status| !status.is_empty())
    {
        return Ok(false);
    }
    if git_output(root, &["worktree", "remove", "--", &p.worktree_path]).is_err() {
        return Ok(false);
    }
    Ok(true)
}

#[cfg(test)]
mod checkout_tests {
    use super::*;
    use std::path::Path;
    fn git(root: &Path, args: &[&str]) {
        git_output(root, args).unwrap();
    }
    #[test]
    fn submodules_follow_checkout_configuration_and_override() {
        let temp =
            std::env::temp_dir().join(format!("scheduled-submodule-{}", uuid::Uuid::new_v4()));
        let sub = temp.join("sub");
        let root = temp.join("repo");
        for dir in [&sub, &root] {
            std::fs::create_dir_all(dir).unwrap();
            git(dir, &["init", "-q"]);
            git(dir, &["config", "user.email", "test@example.com"]);
            git(dir, &["config", "user.name", "Test"]);
            git(dir, &["config", "protocol.file.allow", "always"]);
        }
        std::fs::write(sub.join("file"), "submodule contents").unwrap();
        git(&sub, &["add", "file"]);
        git(&sub, &["commit", "-qm", "sub"]);
        git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                sub.to_str().unwrap(),
                "vendor",
            ],
        );
        std::fs::write(root.join("t3.json"), r#"{"worktreeSubmodules":"none"}"#).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let p = prepare_checkout(
            &db,
            "task",
            "thread",
            &root,
            &temp.join("trees"),
            "HEAD",
            None,
            "now",
        )
        .unwrap();
        let checkout = Path::new(&p.worktree_path);
        initialize_submodules(checkout, None).unwrap();
        assert!(!checkout.join("vendor/file").exists());
        std::fs::write(
            checkout.join("t3.json"),
            r#"{"worktreeSubmodules":"recursive"}"#,
        )
        .unwrap();
        initialize_submodules(checkout, Some("none")).unwrap();
        assert!(!checkout.join("vendor/file").exists());
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn checkout_uses_requested_commit_and_recovers_after_crash() {
        let temp =
            std::env::temp_dir().join(format!("scheduled-checkout-{}", uuid::Uuid::new_v4()));
        let root = temp.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("file"), "base").unwrap();
        git(&root, &["add", "file"]);
        git(&root, &["commit", "-qm", "base"]);
        git(&root, &["branch", "base"]);
        std::fs::write(root.join("file"), "later").unwrap();
        git(&root, &["commit", "-qam", "later"]);
        let path = temp.join("journal.db");
        let mut db = Connection::open(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let p = prepare_checkout(
            &db,
            "task",
            "thread",
            &root,
            &temp.join("trees"),
            "base",
            Some("feature/requested"),
            "now",
        )
        .unwrap();
        assert_eq!(p.branch, "feature/requested");
        assert_eq!(
            git_output(Path::new(&p.worktree_path), &["branch", "--show-current"]).unwrap(),
            "feature/requested"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.worktree_path).join("file")).unwrap(),
            "base"
        );
        // Simulate a crash between Git and the journal phase update.
        db.execute(
            "UPDATE scheduled_worktree_preparations SET phase='planned' WHERE run_key=?1",
            [&p.run_key],
        )
        .unwrap();
        drop(db);
        let db = Connection::open(&path).unwrap();
        assert_eq!(recover_checkouts(&db).unwrap(), 1);
        assert!(!Path::new(&p.worktree_path).exists());
        assert!(git_output(&root, &["rev-parse", "--verify", &p.branch]).is_ok());
        assert!(pending(&db).unwrap().is_empty());
        assert_eq!(recover_checkouts(&db).unwrap(), 0);
        drop(db);
        std::fs::remove_dir_all(temp).unwrap();
    }
}
