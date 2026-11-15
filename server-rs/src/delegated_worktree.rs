//! Prepare an isolated checkout for a delegated task.
//!
//! Call this only after checking for a command receipt. The checkout is a
//! filesystem side effect and must be removed if the subsequent dispatch fails.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug)]
pub struct PreparedWorktree {
    pub path: PathBuf,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PrepareError {
    pub code: &'static str,
    pub message: String,
}

fn git(cwd: &Path, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    String::from_utf8(out.stdout)
        .map(|s| s.trim().to_owned())
        .map_err(|e| e.to_string())
}

/// Resolve the parent's committed HEAD and create a new branch and worktree
/// rooted in the project repository. Uncommitted parent changes are excluded.
pub fn prepare(
    project_root: &Path,
    project_title: &str,
    parent_worktree: Option<&Path>,
    worktrees_root: &Path,
) -> Result<PreparedWorktree, PrepareError> {
    let base = git(
        parent_worktree.unwrap_or(project_root),
        &[
            "rev-parse".as_ref(),
            "--verify".as_ref(),
            "HEAD^{commit}".as_ref(),
        ],
    )
    .map_err(|_| PrepareError {
        code: "invalid_request",
        message: "Unable to resolve the parent checkout commit.".into(),
    })?;
    if parent_worktree.is_some()
        && git(
            project_root,
            &[
                "cat-file".as_ref(),
                "-e".as_ref(),
                format!("{base}^{{commit}}").as_ref(),
            ],
        )
        .is_err()
    {
        return Err(PrepareError {code:"invalid_request", message:format!("Isolation \"worktree\" creates the child checkout in project \"{}\" ({}), which does not contain the parent checkout's commit. Use isolation \"shared\" to work in the parent's checkout.", project_title, project_root.display())});
    }
    std::fs::create_dir_all(worktrees_root).map_err(|e| PrepareError {
        code: "orchestration_error",
        message: format!("Unable to create delegated task worktree: {e}"),
    })?;
    // Git resolves a relative worktree path against its working directory, not
    // the server's. Resolve it here so the returned path names the checkout.
    let worktrees_root = std::fs::canonicalize(worktrees_root).map_err(|e| PrepareError {
        code: "orchestration_error",
        message: format!("Unable to create delegated task worktree: {e}"),
    })?;
    let id = uuid::Uuid::new_v4();
    let branch = format!("t3/delegate-{id}");
    let path = worktrees_root.join(format!("delegate-{id}"));
    let prepared = PreparedWorktree {
        path,
        branch,
        base_commit: base,
    };
    if let Err(e) = git(
        project_root,
        &[
            "worktree".as_ref(),
            "add".as_ref(),
            "-b".as_ref(),
            prepared.branch.as_ref(),
            "--".as_ref(),
            prepared.path.as_os_str(),
            prepared.base_commit.as_ref(),
        ],
    ) {
        let cleanup_error = cleanup(project_root, &prepared).err();
        return Err(PrepareError {
            code: "orchestration_error",
            message: match cleanup_error {
                Some(cleanup_error) => format!("Unable to create delegated task worktree: {e}; cleanup failed: {cleanup_error}"),
                None => format!("Unable to create delegated task worktree: {e}"),
            },
        });
    }
    Ok(prepared)
}

/// Remove a checkout created by `prepare` after a failed dispatch. The caller
/// must ensure no accepted task uses it before invoking this function.
pub fn cleanup(project_root: &Path, worktree: &PreparedWorktree) -> Result<(), String> {
    // Only remove paths registered to this repository; never delete a directory
    // merely because its name matches a failed or previously cleaned checkout.
    let listed = Command::new("git")
        .current_dir(project_root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    if !listed.status.success() {
        return Err(String::from_utf8_lossy(&listed.stderr).trim().to_owned());
    }
    let registered = listed.stdout.split(|b| *b == 0).any(|entry| {
        entry.strip_prefix(b"worktree ") == Some(worktree.path.as_os_str().as_encoded_bytes())
    });
    if registered {
        git(
            project_root,
            &[
                "worktree".as_ref(),
                "remove".as_ref(),
                "--force".as_ref(),
                "--".as_ref(),
                worktree.path.as_os_str(),
            ],
        )?;
    }
    let branch_ref = format!("refs/heads/{}", worktree.branch);
    let status = Command::new("git")
        .current_dir(project_root)
        .args(["show-ref", "--verify", "--quiet", &branch_ref])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        git(
            project_root,
            &[
                "branch".as_ref(),
                "-D".as_ref(),
                "--".as_ref(),
                worktree.branch.as_ref(),
            ],
        )?;
    } else if status.code() != Some(1) {
        return Err(format!("Unable to inspect delegated branch: {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn repo(root: &Path) {
        std::fs::create_dir_all(root).unwrap();
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "test@example.com"]);
        run(root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("file"), "committed").unwrap();
        run(root, &["add", "file"]);
        run(root, &["commit", "-qm", "initial"]);
    }
    #[test]
    fn checkout_uses_parent_commit_and_cleanup() {
        let dir = std::env::temp_dir().join(format!("delegate-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("repo");
        repo(&root);
        let parent = dir.join("parent");
        run(
            &root,
            &["worktree", "add", "--detach", parent.to_str().unwrap()],
        );
        std::fs::write(parent.join("file"), "parent commit").unwrap();
        run(&parent, &["add", "file"]);
        run(&parent, &["commit", "-qm", "parent"]);
        std::fs::write(parent.join("file"), "dirty").unwrap();
        let w = prepare(&root, "Project", Some(&parent), &dir.join("trees")).unwrap();
        assert_eq!(
            std::fs::read_to_string(w.path.join("file")).unwrap(),
            "parent commit"
        );
        assert_eq!(
            git(&w.path, &["rev-parse".as_ref(), "HEAD".as_ref()]).unwrap(),
            w.base_commit
        );
        cleanup(&root, &w).unwrap();
        assert!(!w.path.exists());
        cleanup(&root, &w).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn cleanup_handles_missing_checkout_and_preserves_unregistered_directory() {
        let dir = std::env::temp_dir().join(format!("delegate-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("repo");
        repo(&root);
        let w = prepare(&root, "Project", None, &dir.join("trees")).unwrap();
        std::fs::remove_dir_all(&w.path).unwrap();
        cleanup(&root, &w).unwrap();
        std::fs::create_dir(&w.path).unwrap();
        std::fs::write(w.path.join("keep"), "user data").unwrap();
        cleanup(&root, &w).unwrap();
        assert_eq!(
            std::fs::read_to_string(w.path.join("keep")).unwrap(),
            "user data"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_unrelated_parent_and_unborn_head() {
        let dir = std::env::temp_dir().join(format!("delegate-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("repo");
        let other = dir.join("other");
        repo(&root);
        repo(&other);
        std::fs::write(other.join("file"), "different").unwrap();
        run(&other, &["add", "file"]);
        run(&other, &["commit", "-qm", "different"]);
        let err = prepare(&root, "Project", Some(&other), &dir.join("trees")).unwrap_err();
        assert_eq!(err.code, "invalid_request");
        assert!(err
            .message
            .contains("does not contain the parent checkout's commit"));
        assert!(!dir.join("trees").exists());
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        run(&empty, &["init", "-q"]);
        assert_eq!(
            prepare(&root, "Project", Some(&empty), &dir.join("trees"))
                .unwrap_err()
                .message,
            "Unable to resolve the parent checkout commit."
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
