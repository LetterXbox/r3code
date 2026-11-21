//! Workspace-bound Git review previews.
use crate::github_pinned_credential::{run_classified_bounded, run_classified_with_input};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn git(cwd: &Path, args: &[String], index: Option<&Path>, limit: usize) -> Result<Vec<u8>, ()> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    run_classified_bounded(&mut cmd, Duration::from_secs(30), limit).map_err(|_| ())
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_owned()).collect()
}
fn output(cwd: &Path, args: &[&str]) -> Option<String> {
    git(cwd, &strings(args), None, 1024 * 1024)
        .ok()
        .map(|v| String::from_utf8_lossy(&v).trim().to_owned())
}
fn err(cwd: &str, operation: &str, detail: &str) -> Value {
    json!({"_tag":"GitCommandError","operation":operation,"command":"git diff","cwd":cwd,"detail":detail})
}
#[allow(clippy::let_and_return)] // The iterator must drop before its statement.
fn known(cwd: &Path, db: &rusqlite::Connection) -> bool {
    let root = std::env::current_dir()
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok());
    if root.as_ref().is_some_and(|p| cwd.starts_with(p)) {
        return true;
    }
    let mut stmt=match db.prepare("SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL UNION SELECT json_extract(payload_json,'$.worktreePath') FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') IS NOT NULL") {Ok(s)=>s,Err(_)=>return false};
    let rows = match stmt.query_map([], |r| r.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let found = rows
        .flatten()
        .filter_map(|s| std::fs::canonicalize(s).ok())
        .any(|p| cwd.starts_with(p));
    found
}
fn stats(bytes: &[u8]) -> Vec<Value> {
    let mut fields = bytes.split(|b| *b == 0);
    let mut out = Vec::new();
    while let Some(field) = fields.next() {
        let s = String::from_utf8_lossy(field);
        let mut parts = s.splitn(3, '\t');
        let (Some(a), Some(d), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let previous = if name.is_empty() {
            fields
                .next()
                .map(|p| String::from_utf8_lossy(p).into_owned())
        } else {
            None
        };
        let path = if previous.is_some() {
            fields
                .next()
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .unwrap_or_default()
        } else {
            name.to_owned()
        };
        out.push(json!({"path":path,"previousPath":previous,"additions":a.parse::<u64>().unwrap_or(0),"deletions":d.parse::<u64>().unwrap_or(0)}));
    }
    out
}
fn hash(diff: &str, files: &[Value]) -> String {
    let mut encoded = format!("[{},[", serde_json::to_string(diff).unwrap_or_default());
    for (index, file) in files.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push_str(&format!(
            "{{\"path\":{},\"previousPath\":{},\"additions\":{},\"deletions\":{}}}",
            file["path"], file["previousPath"], file["additions"], file["deletions"]
        ));
    }
    encoded.push_str("]]");
    let mut h = Sha256::new();
    h.update(encoded.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
struct TempIndex(PathBuf);
impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn temporary_index(root: &Path) -> Option<TempIndex> {
    let path = std::env::temp_dir().join(format!("t3-review-index-{}", uuid::Uuid::new_v4()));
    let index = output(root, &["rev-parse", "--git-path", "index"])?;
    let source = if Path::new(&index).is_absolute() {
        PathBuf::from(index)
    } else {
        root.join(index)
    };
    if source.exists() {
        std::fs::copy(source, &path).ok()?;
    }
    let temp = TempIndex(path);
    git(
        root,
        &strings(&["add", "--intent-to-add", "--", "."]),
        Some(&temp.0),
        1024 * 1024,
    )
    .ok()?;
    Some(temp)
}
fn resolve_base(root: &Path, branch: &str, explicit: Option<&str>) -> Option<(String, String)> {
    let exists = |name: &str| output(root, &["show-ref", "--verify", "--quiet", name]).is_some();
    let resolve = |candidate: &str| {
        let remote = if candidate.starts_with("refs/") {
            candidate.to_owned()
        } else if candidate.contains('/') {
            format!("refs/remotes/{candidate}")
        } else {
            format!("refs/heads/{candidate}")
        };
        exists(&remote).then(|| (candidate.to_owned(), remote))
    };
    if let Some(base) = explicit {
        return Some(resolve(base).unwrap_or_else(|| (base.to_owned(), base.to_owned())));
    }
    if branch != "HEAD" {
        if let Some(configured) = output(
            root,
            &[
                "config",
                "--get",
                &format!("branch.{branch}.t3-merge-base-ref"),
            ],
        )
        .filter(|s| !s.is_empty())
        {
            if !configured.starts_with("refs/") && !configured.contains('/') && configured != branch {
                let remote_name = output(
                    root,
                    &["config", "--get", &format!("branch.{configured}.remote")],
                )
                .filter(|s| !s.is_empty());
                let merge_branch = output(
                    root,
                    &["config", "--get", &format!("branch.{configured}.merge")],
                )
                .and_then(|v| v.strip_prefix("refs/heads/").map(str::to_owned));
                if let (Some(remote_name), Some(merge_branch)) = (remote_name, merge_branch) {
                    let remote_ref = format!("refs/remotes/{remote_name}/{merge_branch}");
                    if exists(&remote_ref) {
                        return Some((format!("{remote_name}/{merge_branch}"), remote_ref));
                    }
                }
            }
            if let Some(pair) = resolve(&configured) {
                return Some(pair);
            }
        }
        let configured = output(
            root,
            &["config", "--get", &format!("branch.{branch}.merge")],
        )
        .and_then(|v| v.strip_prefix("refs/heads/").map(str::to_owned));
        let remote_head = output(
            root,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
        );
        for candidate in configured
            .into_iter()
            .chain(remote_head)
            .chain(["main".to_owned(), "master".to_owned()])
        {
            let short = candidate.strip_prefix("origin/").unwrap_or(&candidate);
            if short == branch {
                continue;
            }
            let remote = format!("refs/remotes/origin/{short}");
            if exists(&remote) {
                return Some((format!("origin/{short}"), remote));
            }
            let local = format!("refs/heads/{short}");
            if exists(&local) {
                return Some((short.to_owned(), local));
            }
        }
    }
    None
}

fn source(
    root: &Path,
    kind: &str,
    base: Option<&str>,
    reference: Option<&str>,
    head: Option<&str>,
    input: &Value,
    index: Option<&Path>,
) -> Result<Value, ()> {
    let mut args = strings(&[
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        "--find-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--submodule=short",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]);
    if input["ignoreWhitespace"] == true {
        args.push("--ignore-all-space".into());
    }
    let mut paths = Vec::new();
    if let Some(file) = input.get("file").filter(|v| v.is_object()) {
        for value in [&file["path"], &file["previousPath"]] {
            if let Some(p) = value.as_str().filter(|s| !s.is_empty()) {
                paths.push(format!(":(top,literal){p}"));
            }
        }
    }
    let (files, diff) = if let Some(reference) = reference {
        let mut stat = args.clone();
        stat.extend(strings(&["--numstat", "-z"]));
        stat.push(reference.into());
        stat.push("--".into());
        stat.extend(paths.clone());
        let files = stats(&git(root, &stat, index, 16 * 1024 * 1024)?);
        let diff = if input["metadataOnly"] == true && paths.is_empty() || files.is_empty() {
            String::new()
        } else {
            let mut patch = args;
            patch.push("--patch".into());
            patch.push(reference.into());
            patch.push("--".into());
            patch.extend(paths);
            String::from_utf8_lossy(&git(root, &patch, index, 120_000)?).into_owned()
        };
        (files, diff)
    } else {
        (vec![], String::new())
    };
    let title = if kind == "working-tree" {
        "Uncommitted".to_owned()
    } else {
        base.map_or_else(|| "Changes".to_owned(), |v| format!("Changes vs {v}"))
    };
    let mut v = json!({"id":kind,"kind":kind,"title":title,"baseRef":if kind=="working-tree"{Some("HEAD")}else{base},"headRef":head,"diffHash":hash(&diff,&files),"diff":diff,"files":files,"truncated":false});
    if input["metadataOnly"] == true && input.get("file").is_none() {
        v["patchesDeferred"] = json!(true);
    }
    Ok(v)
}
pub fn preview(input: &Value, db: &rusqlite::Connection) -> Result<Value, Value> {
    let cwd = input["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("", "ReviewService.getDiffPreview", "Invalid cwd."))?;
    for key in ["ignoreWhitespace", "trackedOnly", "metadataOnly"] {
        if input.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(err(cwd, "ReviewService.getDiffPreview", "Invalid options."));
        }
    }
    if input
        .get("sourceKind")
        .is_some_and(|v| !matches!(v.as_str(), Some("working-tree" | "branch-range")))
    {
        return Err(err(cwd, "ReviewService.getDiffPreview", "Invalid source."));
    }
    let path = std::fs::canonicalize(cwd).map_err(|_| {
        err(
            cwd,
            "ReviewService.getDiffPreview",
            "Workspace is unavailable.",
        )
    })?;
    if !known(&path, db) {
        return Err(
            json!({"_tag":"VcsRepositoryDetectionError","operation":"ReviewService.getDiffPreview","cwd":cwd,"detail":"Review diff preview cwd must stay within the configured workspace root."}),
        );
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let Some(root) = output(&path, &["rev-parse", "--show-toplevel"]) else {
        return Ok(json!({"cwd":cwd,"generatedAt":now,"sources":[]}));
    };
    let root = PathBuf::from(root);
    let file_kind = if let Some(file) = input.get("file") {
        if !file.is_object()
            || file["path"].as_str().is_none_or(|s| s.is_empty())
            || !(file["previousPath"].is_null()
                || file["previousPath"].as_str().is_some_and(|s| !s.is_empty()))
            || !matches!(
                file["sourceKind"].as_str(),
                Some("working-tree" | "branch-range" | "commit")
            )
        {
            return Err(err(cwd, "ReviewService.getDiffPreview", "Invalid file."));
        }
        file["sourceKind"].as_str()
    } else {
        None
    };
    if input.get("commitSha").is_some() || file_kind == Some("commit") {
        let sha = input["commitSha"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                err(
                    cwd,
                    "GitVcsDriver.getReviewDiffPreview",
                    "Selected commit request is invalid.",
                )
            })?;
        if !(sha.len() == 40 || sha.len() == 64) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(
                json!({"_tag":"GitCommandError","operation":"GitVcsDriver.reviewCommit","command":"git cat-file","cwd":root.to_string_lossy(),"detail":"Selected commit is invalid or no longer available."}),
            );
        }
        if file_kind.is_some_and(|k| k != "commit") {
            return Err(err(
                cwd,
                "GitVcsDriver.getReviewDiffPreview",
                "Selected commit request is invalid.",
            ));
        }
        let commit = output(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{sha}^{{commit}}"),
            ],
        )
        .ok_or_else(|| {
            err(
                cwd,
                "GitVcsDriver.getReviewDiffPreview",
                "Could not resolve the selected commit.",
            )
        })?;
        let parent = output(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{commit}^"),
            ],
        )
        .or_else(|| {
            let mut cmd = Command::new("git");
            cmd.current_dir(&root)
                .args(["hash-object", "-t", "tree", "--stdin"]);
            run_classified_with_input(&mut cmd, Duration::from_secs(5), vec![])
                .ok()
                .map(|b| String::from_utf8_lossy(&b).trim().to_owned())
        })
        .ok_or_else(|| {
            err(
                cwd,
                "GitVcsDriver.getReviewDiffPreview",
                "Could not resolve commit parent.",
            )
        })?;
        let subject = output(
            &root,
            &[
                "log",
                "-1",
                "--format=%s",
                "--no-notes",
                "--no-show-signature",
                &commit,
            ],
        )
        .unwrap_or_default();
        let reference = format!("{parent}..{commit}");
        let mut entry = source(
            &root,
            "commit",
            Some(&parent),
            Some(&reference),
            Some(&commit),
            input,
            None,
        )
        .map_err(|_| {
            err(
                cwd,
                "GitVcsDriver.getReviewDiffPreview",
                "Could not read commit diff.",
            )
        })?;
        entry["id"] = json!(commit);
        entry["title"] = json!(format!("Commit {}", &commit[..7.min(commit.len())]));
        if !subject.trim().is_empty() {
            entry["commitSubject"] = json!(subject.chars().take(300).collect::<String>());
        }
        return Ok(json!({"cwd":cwd,"generatedAt":now,"sources":[entry]}));
    }
    let branch = output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or_else(|| "HEAD".into());
    let has_head = output(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_some();
    let base_pair = resolve_base(&root, &branch, input["baseRef"].as_str());
    let base = base_pair.as_ref().map(|v| v.0.clone());
    let merge = if has_head {
        if let Some((_, comparison)) = base_pair.as_ref() {
            output(
                &root,
                &["merge-base", "--end-of-options", comparison, "HEAD"],
            )
            .ok_or_else(|| {
                err(
                    cwd,
                    "GitVcsDriver.resolveReviewMergeBase",
                    "Could not find a common commit.",
                )
            })?
        } else {
            "HEAD".into()
        }
    } else {
        "HEAD".into()
    };
    let empty = || {
        let mut cmd = Command::new("git");
        cmd.current_dir(&root)
            .args(["hash-object", "-t", "tree", "--stdin"]);
        run_classified_with_input(&mut cmd, Duration::from_secs(5), vec![])
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_owned())
    };
    let dirty = if has_head {
        Some("HEAD".to_owned())
    } else {
        empty()
    };
    let index = if input["trackedOnly"] == true {
        None
    } else {
        temporary_index(&root)
    };
    let kind = file_kind.or_else(|| input["sourceKind"].as_str());
    let mut sources = Vec::new();
    if kind != Some("branch-range") {
        sources.push(
            source(
                &root,
                "working-tree",
                None,
                dirty.as_deref(),
                None,
                input,
                index.as_ref().map(|i| i.0.as_path()),
            )
            .map_err(|_| {
                err(
                    cwd,
                    "GitVcsDriver.getReviewDiffPreview",
                    "Could not read diff.",
                )
            })?,
        );
    }
    if kind != Some("working-tree") {
        sources.push(
            source(
                &root,
                "branch-range",
                base.as_deref(),
                if has_head {
                    Some(&merge)
                } else {
                    dirty.as_deref()
                },
                Some(&branch),
                input,
                index.as_ref().map(|i| i.0.as_path()),
            )
            .map_err(|_| {
                err(
                    cwd,
                    "GitVcsDriver.getReviewDiffPreview",
                    "Could not read diff.",
                )
            })?,
        );
    }
    let mut result = json!({"cwd":cwd,"generatedAt":now,"sources":sources});
    if input["trackedOnly"] == true {
        result["incomplete"] = json!(true);
    }
    Ok(result)
}
pub fn branch_commits(input: &Value, db: &rusqlite::Connection) -> Result<Value, Value> {
    let cwd = input["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("", "ReviewService.getBranchCommits", "Invalid cwd."))?;
    let path = std::fs::canonicalize(cwd).map_err(|_| {
        err(
            cwd,
            "ReviewService.getBranchCommits",
            "Workspace is unavailable.",
        )
    })?;
    if !known(&path, db) {
        return Err(
            json!({"_tag":"VcsRepositoryDetectionError","operation":"ReviewService.getBranchCommits","cwd":cwd,"detail":"Review commit list cwd must stay within the configured workspace root."}),
        );
    }
    let Some(root) = output(&path, &["rev-parse", "--show-toplevel"]) else {
        return Ok(json!({"commits":[],"truncated":false}));
    };
    let root = PathBuf::from(root);
    if output(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_none() {
        return Ok(json!({"commits":[],"truncated":false}));
    }
    let branch = output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or_else(|| "HEAD".into());
    let base = resolve_base(&root, &branch, input["baseRef"].as_str());
    let merge = if let Some((_, reference)) = base {
        output(
            &root,
            &["merge-base", "--end-of-options", &reference, "HEAD"],
        )
        .ok_or_else(|| {
            err(
                cwd,
                "GitVcsDriver.resolveReviewMergeBase",
                "Could not find a common commit.",
            )
        })?
    } else {
        "HEAD".into()
    };
    let args = vec![
        "log".into(),
        "-z".into(),
        "--no-notes".into(),
        "--no-show-signature".into(),
        "--format=%H%x00%s%x00%cI".into(),
        "--max-count=101".into(),
        format!("{merge}..HEAD"),
    ];
    let bytes = git(&root, &args, None, 128 * 1024).map_err(|_| {
        err(
            cwd,
            "GitVcsDriver.getReviewBranchCommits",
            "Could not read branch commit metadata.",
        )
    })?;
    let fields: Vec<_> = bytes.split(|b| *b == 0).collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks_exact(3) {
        let sha = String::from_utf8_lossy(chunk[0]);
        let subject = String::from_utf8_lossy(chunk[1]);
        let at = String::from_utf8_lossy(chunk[2]);
        if !matches!(sha.len(), 40 | 64)
            || !sha.bytes().all(|c| c.is_ascii_hexdigit())
            || at.is_empty()
        {
            return Err(err(
                cwd,
                "GitVcsDriver.getReviewBranchCommits",
                "Could not read branch commit metadata.",
            ));
        }
        commits.push(json!({"sha":sha,"subject":subject.chars().take(300).collect::<String>(),"committedAt":at}));
    }
    let truncated = commits.len() > 100;
    commits.truncate(100);
    Ok(json!({"commits":commits,"truncated":truncated}))
}

fn file_error(cwd: &str, detail: &str) -> Value {
    json!({"_tag":"GitCommandError","operation":"GitVcsDriver.getReviewDiffFileContents","command":"git","cwd":cwd,"detail":detail})
}
fn revision_file(root: &Path, cwd: &str, revision: &str, path: &str) -> Result<String, Value> {
    let args = vec![
        "show".to_owned(),
        "--end-of-options".to_owned(),
        format!("{revision}:{path}"),
    ];
    let bytes = git(root, &args, None, 1024 * 1024)
        .map_err(|_| file_error(cwd, &format!("Could not read diff file '{path}'.")))?;
    if bytes.contains(&0) {
        return Err(file_error(
            cwd,
            &format!("Cannot expand binary file '{path}'."),
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
#[cfg(unix)]
fn safe_worktree_file(root: &Path, target: &Path) -> std::io::Result<Vec<u8>> {
    use std::{
        ffi::CString,
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let relative = target.strip_prefix(root).map_err(std::io::Error::other)?;
    let parts: Vec<_> = relative.components().collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        return Err(std::io::Error::other("Invalid file path"));
    }
    let mut dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    for component in &parts[..parts.len() - 1] {
        let name = CString::new(component.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    let name = CString::new(parts.last().unwrap().as_os_str().as_bytes())
        .map_err(std::io::Error::other)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return Err(std::io::Error::other("File unavailable or too large"));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(std::io::Error::other("File too large"));
    }
    Ok(bytes)
}
#[cfg(not(unix))]
fn safe_worktree_file(_root: &Path, _target: &Path) -> std::io::Result<Vec<u8>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Safe file access is unavailable",
    ))
}

pub fn file_contents(
    input: &Value,
    db: &rusqlite::Connection,
    state: &Path,
) -> Result<Value, Value> {
    let cwd = input["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| file_error("", "Invalid cwd."))?;
    let path =
        std::fs::canonicalize(cwd).map_err(|_| file_error(cwd, "Workspace is unavailable."))?;
    if !known(&path, db) {
        return Err(
            json!({"_tag":"VcsRepositoryDetectionError","operation":"ReviewService.getDiffFileContents","cwd":cwd,"detail":"Review diff file contents cwd must stay within the configured workspace root."}),
        );
    }
    let root = output(&path, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .ok_or_else(|| file_error(cwd, "Could not resolve the Git repository root."))?;
    let kind = input["sourceKind"]
        .as_str()
        .filter(|s| matches!(*s, "working-tree" | "branch-range" | "commit"))
        .ok_or_else(|| file_error(cwd, "Invalid source."))?;
    let change = input["changeType"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "change" | "rename-pure" | "rename-changed" | "new" | "deleted"
            )
        })
        .ok_or_else(|| file_error(cwd, "Invalid change type."))?;
    let old = input["oldPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| file_error(cwd, "Invalid path."))?;
    let new = input["newPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| file_error(cwd, "Invalid path."))?;
    let (base, head) = if kind == "commit" {
        let sha = input["headRef"]
            .as_str()
            .filter(|s| matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| file_error(cwd, "Selected commit is no longer available."))?;
        let commit = output(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{sha}^{{commit}}"),
            ],
        )
        .ok_or_else(|| file_error(cwd, "Selected commit is no longer available."))?;
        let parent = output(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{commit}^"),
            ],
        )
        .or_else(|| {
            let mut c = Command::new("git");
            c.current_dir(&root)
                .args(["hash-object", "-t", "tree", "--stdin"]);
            run_classified_with_input(&mut c, Duration::from_secs(5), vec![])
                .ok()
                .map(|b| String::from_utf8_lossy(&b).trim().to_owned())
        })
        .ok_or_else(|| file_error(cwd, "Selected commit's parent is unavailable."))?;
        if input["baseRef"].as_str() != Some(parent.as_str()) {
            return Err(file_error(
                cwd,
                "Selected commit changed. Refresh the comparison.",
            ));
        }
        (parent, Some(commit))
    } else if kind == "working-tree" {
        (input["baseRef"].as_str().unwrap_or("HEAD").to_owned(), None)
    } else {
        let merge =
            if let Some((_, reference)) = resolve_base(&root, "HEAD", input["baseRef"].as_str()) {
                output(
                    &root,
                    &["merge-base", "--end-of-options", &reference, "HEAD"],
                )
                .ok_or_else(|| file_error(cwd, "Could not find a common commit."))?
            } else {
                "HEAD".into()
            };
        (merge, None)
    };
    let old_contents = if change == "new" {
        String::new()
    } else {
        revision_file(&root, cwd, &base, old)?
    };
    let new_contents = if change == "deleted" {
        String::new()
    } else if let Some(head) = head {
        revision_file(&root, cwd, &head, new)?
    } else {
        let target = std::fs::canonicalize(root.join(new))
            .map_err(|_| file_error(cwd, &format!("Could not resolve diff file '{new}'.")))?;
        let root = std::fs::canonicalize(&root)
            .map_err(|_| file_error(cwd, "Could not resolve the Git repository root."))?;
        if !target.starts_with(&root) || crate::workspace_rpc::internal(&target, state) {
            return Err(file_error(
                cwd,
                &format!("Diff file '{new}' is not available."),
            ));
        }
        let bytes = safe_worktree_file(&root, &target)
            .map_err(|_| file_error(cwd, &format!("Could not read diff file '{new}'.")))?;
        if bytes.contains(&0) {
            return Err(file_error(
                cwd,
                &format!("Cannot expand binary file '{new}'."),
            ));
        }
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(json!({"oldContents":old_contents,"newContents":new_contents}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .current_dir(root)
            .args(args)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn reordered_review_uses_gits_default_diff() {
        let root = std::env::temp_dir().join(format!("t3-review-reordered-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        run(&root, &["config", "user.name", "Test"]);
        run(&root, &["config", "user.email", "test@example.invalid"]);
        run(&root, &["config", "diff.algorithm", "myers"]);
        let text = |shift| (0..2000).map(|index| format!("{}\n", (index ^ (index >> shift)) % 16)).collect::<String>();
        let file = root.join("repeated.txt");
        std::fs::write(&file, text(3)).unwrap();
        run(&root, &["add", "repeated.txt"]);
        run(&root, &["commit", "-qm", "first"]);
        std::fs::write(&file, text(5)).unwrap();
        let expected = output(&root, &["diff", "--no-color", "--numstat", "HEAD", "--"]).unwrap();
        let minimal = output(&root, &["diff", "--no-color", "--minimal", "--numstat", "HEAD", "--"]).unwrap();
        assert_ne!(expected, minimal);
        let mut totals = expected.split('\t');
        let additions: u64 = totals.next().unwrap().parse().unwrap();
        let deletions: u64 = totals.next().unwrap().parse().unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(workspace_root TEXT,deleted_at TEXT);CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT,deleted_at TEXT);").unwrap();
        db.execute("INSERT INTO projection_projects VALUES(?1,NULL)", [root.to_string_lossy().as_ref()]).unwrap();
        let result = preview(&json!({"cwd":root,"sourceKind":"working-tree"}), &db).unwrap();
        let file = &result["sources"][0]["files"][0];
        assert_eq!(file["additions"], additions);
        assert_eq!(file["deletions"], deletions);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_diff_metadata_and_commit_include_expected_files() {
        let root = std::env::temp_dir().join(format!("t3-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q"]);
        run(&root, &["config", "user.name", "Test"]);
        run(&root, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run(&root, &["add", "a.txt"]);
        run(&root, &["commit", "-qm", "first"]);
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(workspace_root TEXT,deleted_at TEXT);CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT,deleted_at TEXT);").unwrap();
        db.execute(
            "INSERT INTO projection_projects VALUES(?1,NULL)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("new.txt"), "hello\n").unwrap();
        let result = preview(
            &json!({"cwd":root,"sourceKind":"working-tree","metadataOnly":true}),
            &db,
        )
        .unwrap();
        let src = &result["sources"][0];
        assert_eq!(src["files"].as_array().unwrap().len(), 2);
        assert_eq!(src["patchesDeferred"], true);
        assert!(src["diff"].as_str().unwrap().is_empty());
        let contents=file_contents(&json!({"cwd":root,"sourceKind":"working-tree","changeType":"change","baseRef":"HEAD","headRef":null,"oldPath":"a.txt","newPath":"a.txt"}),&db,Path::new("/nonexistent-t3-state")).unwrap();
        assert_eq!(contents["oldContents"], "one\n");
        assert_eq!(contents["newContents"], "one\ntwo\n");
        run(&root, &["branch", "base"]);
        run(&root, &["add", "a.txt"]);
        run(&root, &["commit", "-qm", "second"]);
        let commits = branch_commits(&json!({"cwd":root,"baseRef":"base"}), &db).unwrap();
        assert_eq!(commits["commits"][0]["subject"], "second");
        let sha = output(&root, &["rev-parse", "HEAD"]).unwrap();
        let result = preview(&json!({"cwd":root,"commitSha":sha}), &db).unwrap();
        assert_eq!(result["sources"][0]["kind"], "commit");
        assert_eq!(result["sources"][0]["commitSubject"], "second");
        assert_eq!(result["sources"][0]["files"][0]["path"], "a.txt");
        std::fs::remove_dir_all(root).unwrap();
    }
}
