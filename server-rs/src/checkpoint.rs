//! Git-backed workspace snapshots. Capture never modifies the user's index or branch.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, OnceLock},
};

static CAPTURE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn checkpoint_ref(scope_id: &str, ordinal: u64) -> String {
    let digest = format!("{:x}", Sha256::digest(scope_id.as_bytes()));
    format!(
        "refs/t3/orchestration-v2/checkpoints/{}/ordinal/{ordinal}",
        URL_SAFE_NO_PAD.encode(&digest[..32])
    )
}

fn git(cwd: &Path, args: &[&str], index: Option<&Path>) -> io::Result<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .args(args)
        .env("LANGUAGE", "C")
        .env("LC_ALL", "C");
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        cmd.env_remove(key);
    }
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index)
            .env("GIT_AUTHOR_NAME", "T3 Code")
            .env("GIT_AUTHOR_EMAIL", "t3code@users.noreply.github.com")
            .env("GIT_COMMITTER_NAME", "T3 Code")
            .env("GIT_COMMITTER_EMAIL", "t3code@users.noreply.github.com");
    }
    cmd.output()
}
fn checked(cwd: &Path, args: &[&str], index: Option<&Path>) -> io::Result<String> {
    let out = git(cwd, args, index)?;
    if !out.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(format!("{}.lock", self.0.display()));
    }
}

/// Capture tracked and unignored working-tree files into a hidden ref.
/// Returns an error on unsafe or unsupported repository configurations.
pub fn capture(cwd: &Path, reference: &str) -> io::Result<String> {
    let _lock = CAPTURE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| io::Error::other("checkpoint lock poisoned"))?;
    // Do not use a partially populated index: that could silently drop sparse files.
    let sparse = git(cwd, &["config", "--bool", "core.sparseCheckout"], None)?;
    if !sparse.status.success() && sparse.status.code() != Some(1) {
        return Err(io::Error::other(
            String::from_utf8_lossy(&sparse.stderr).trim().to_owned(),
        ));
    }
    if String::from_utf8_lossy(&sparse.stdout).trim() == "true" {
        return Err(io::Error::other("sparse checkout capture is not supported"));
    }
    let common = checked(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )?;
    let scratch =
        Scratch(Path::new(&common).join(format!("t3-checkpoint-index-{}", uuid::Uuid::new_v4())));
    let index = Some(scratch.0.as_path());
    let head_probe = git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"], None)?;
    let head = if head_probe.status.success() {
        Some(
            String::from_utf8_lossy(&head_probe.stdout)
                .trim()
                .to_owned(),
        )
    } else if head_probe.status.code() == Some(1) {
        None
    } else {
        return Err(io::Error::other(
            String::from_utf8_lossy(&head_probe.stderr)
                .trim()
                .to_owned(),
        ));
    };
    if let Some(ref head_oid) = head {
        checked(
            cwd,
            &[
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.splitIndex=false",
                "read-tree",
                head_oid,
            ],
            index,
        )?;
    }
    let stage = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.splitIndex=false",
        "-c",
        "splitIndex.sharedIndexExpire=never",
        "-c",
        "core.safecrlf=false",
        "add",
        "-A",
        "--",
        ".",
    ];
    if let Err(original) = checked(cwd, &stage, index) {
        // An uninitialized embedded repository makes `git add` fail. Exclude only
        // such repositories, and keep the original error for all other failures.
        let candidates = git(
            cwd,
            &[
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                ".",
            ],
            index,
        )?;
        if !candidates.status.success() || candidates.stdout.len() > 16_777_216 {
            return Err(original);
        }
        let mut exclusions = Vec::new();
        let mut candidate_count = 0;
        for path in candidates
            .stdout
            .split(|b| *b == 0)
            .filter(|p| p.ends_with(b"/"))
        {
            candidate_count += 1;
            if candidate_count > 64 {
                return Err(original);
            }
            let Ok(path) = std::str::from_utf8(path) else {
                return Err(original);
            };
            let nested = cwd.join(path);
            if nested.join(".git").exists()
                && !git(&nested, &["rev-parse", "--verify", "--quiet", "HEAD"], None)?
                    .status
                    .success()
            {
                exclusions.push(format!(":(exclude,literal){path}"));
            }
        }
        if exclusions.is_empty() {
            return Err(original);
        }
        let mut retry = stage.to_vec();
        retry.extend(exclusions.iter().map(String::as_str));
        checked(cwd, &retry, index)?;
    }
    let tree = checked(
        cwd,
        &["-c", "core.fsync=objects,reference", "write-tree"],
        index,
    )?;
    if tree.is_empty() {
        return Err(io::Error::other(
            "git write-tree returned an empty tree oid",
        ));
    }
    let message = format!("t3 checkpoint ref={reference}");
    let mut args = vec!["-c", "core.fsync=objects,reference", "commit-tree", &tree];
    if let Some(ref head_oid) = head {
        args.extend(["-p", head_oid]);
    }
    args.extend(["-m", &message]);
    let commit = checked(cwd, &args, index)?;
    if commit.is_empty() {
        return Err(io::Error::other(
            "git commit-tree returned an empty commit oid",
        ));
    }
    checked(
        cwd,
        &[
            "-c",
            "core.fsync=objects,reference",
            "update-ref",
            reference,
            &commit,
        ],
        None,
    )?;
    Ok(commit)
}

pub fn has_ref(cwd: &Path, reference: &str) -> io::Result<bool> {
    let target = format!("{reference}^{{commit}}");
    let out = git(cwd, &["rev-parse", "--verify", "--quiet", &target], None)?;
    if out.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(1)
        && !stderr
            .lines()
            .any(|l| l.starts_with("error:") || l.starts_with("fatal:"))
    {
        return Ok(false);
    }
    Err(io::Error::other(stderr.trim().to_owned()))
}

/// Delete stale hidden checkpoint references under the same lock as capture.
pub(crate) fn delete_refs(cwd: &Path, references: &[String]) -> io::Result<()> {
    if references.is_empty() {
        return Ok(());
    }
    let _lock = CAPTURE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| io::Error::other("checkpoint lock poisoned"))?;
    for reference in references {
        if !reference.starts_with("refs/t3/orchestration-v2/checkpoints/") {
            return Err(io::Error::other("invalid checkpoint reference"));
        }
        checked(cwd, &["update-ref", "-d", reference], None)?;
    }
    Ok(())
}

/// Restore a checkpoint under `cwd`, preserving ignored files. A missing ref
/// returns false without changing the worktree. Callers must ensure exclusive
/// access and verify workspace isolation before invoking this destructive operation.
#[allow(
    dead_code,
    reason = "rollback integration must acquire workspace guards before calling restore"
)]
pub(crate) fn restore(cwd: &Path, reference: &str) -> io::Result<bool> {
    let _lock = CAPTURE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| io::Error::other("checkpoint lock poisoned"))?;
    if !has_ref(cwd, reference)? {
        return Ok(false);
    }
    let target = format!("{reference}^{{commit}}");
    let files = git(
        cwd,
        &[
            "ls-files",
            "--cached",
            &format!("--with-tree={target}"),
            "-z",
            "--",
            ".",
        ],
        None,
    )?;
    if !files.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&files.stderr).trim().to_owned(),
        ));
    }
    if !files.stdout.is_empty() {
        checked(
            cwd,
            &[
                "-c",
                "core.longpaths=true",
                "restore",
                "--source",
                &target,
                "--worktree",
                "--staged",
                "--",
                ".",
            ],
            None,
        )?;
    }
    let clean_result = (|| -> io::Result<()> {
        for pass in 0..4 {
            fs::create_dir_all(cwd)?;
            let output = git(
                cwd,
                &["-c", "core.longpaths=true", "clean", "-fd", "--", "."],
                None,
            )?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let message = stderr.trim();
                let empty = fs::read_dir(cwd)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false);
                if output.status.code() == Some(1)
                    && empty
                    && message.starts_with("warning: failed to remove ./: ")
                    && !message.contains('\n')
                {
                    return Ok(());
                }
                return Err(io::Error::other(
                    if message.is_empty() {
                        "Could not clean the checkpoint workspace."
                    } else {
                        message
                    }
                    .to_owned(),
                ));
            }
            if !String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|l| l.starts_with("Removing "))
            {
                return Ok(());
            }
            if pass == 3 {
                fs::create_dir_all(cwd)?;
                let dry = git(
                    cwd,
                    &["-c", "core.longpaths=true", "clean", "-dn", "--", "."],
                    None,
                )?;
                if !dry.status.success()
                    || String::from_utf8_lossy(&dry.stdout)
                        .lines()
                        .any(|l| l.starts_with("Would remove "))
                {
                    return Err(io::Error::other(
                        "Could not clean the checkpoint workspace: untracked files remain.",
                    ));
                }
            }
        }
        Ok(())
    })();
    fs::create_dir_all(cwd)?;
    let reset = checked(
        cwd,
        &["-c", "core.longpaths=true", "reset", "--quiet", "--", "."],
        None,
    );
    clean_result?;
    reset?;
    Ok(true)
}

/// Finalize a persisted capture effect and publish its events atomically.
pub fn execute(
    bus: &crate::event_bus::EventBus,
    thread: &str,
    run_id: &str,
    scope_id: &str,
    at: &str,
) -> Result<(), crate::event_bus::BusError> {
    use crate::event_store::{self, Event, Receipt};
    use rusqlite::{params, OptionalExtension};
    use serde_json::{json, Value};
    // Read only the capture target, then release the database lane before Git runs.
    let target = bus.commit(|tx| {
        let fetch = |sql: &str, id: &str| -> rusqlite::Result<Value> {
            let raw: String = tx.query_row(sql, [id], |r| r.get(0))?;
            serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)
        };
        let run = fetch("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1", run_id)?;
        let status = run["status"].as_str().unwrap_or("");
        let stopped = status == "interrupted" || status == "cancelled";
        if run["threadId"] != thread { return Err(rusqlite::Error::InvalidQuery); }
        if status == "rolled_back" || ((status == "completed" || stopped) && !run["checkpointId"].is_null()) { return Ok((None, vec![])); }
        if status != "waiting" && !stopped { return Err(rusqlite::Error::InvalidQuery); }
        let node_id = run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let node = fetch("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", node_id)?;
        let scope = fetch("SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id=?1", scope_id)?;
        if node["checkpointScopeId"] != scope_id || scope["threadId"] != thread { return Err(rusqlite::Error::InvalidQuery); }
        let provider_id = run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let _ = fetch("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", provider_id)?;
        let thread_value = fetch("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", thread)?;
        let cwd = scope["cwd"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        let ordinal = run["ordinal"].as_i64().filter(|n| *n > 0).ok_or(rusqlite::Error::InvalidQuery)?;
        let side = thread_value.pointer("/lineage/sideChat").and_then(Value::as_bool).unwrap_or(false);
        Ok((Some((cwd, ordinal, side, node_id.to_owned(), provider_id.to_owned())), vec![]))
    })?;
    let Some((target_cwd, target_ordinal, target_side, target_node, target_provider)) = target
    else {
        crate::queue_promotion::promote(bus, thread, at)?;
        return Ok(());
    };
    let mut baseline_states = std::collections::HashMap::new();
    for n in [0, target_ordinal - 1] {
        let reference = checkpoint_ref(scope_id, n as u64);
        let state = if target_side {
            "missing"
        } else {
            match has_ref(Path::new(&target_cwd), &reference) {
                Ok(true) => "ready",
                Ok(false) => "missing",
                Err(_) => "error",
            }
        };
        baseline_states.insert(n, state);
    }
    let reference = checkpoint_ref(scope_id, target_ordinal as u64);
    let capture_state = if target_side || !Path::new(&target_cwd).exists() {
        "missing"
    } else {
        match capture(Path::new(&target_cwd), &reference) {
            Ok(_) => "ready",
            Err(_) => {
                if git(
                    Path::new(&target_cwd),
                    &["rev-parse", "--is-inside-work-tree"],
                    None,
                )
                .is_ok_and(|o| {
                    !o.status.success()
                        && String::from_utf8_lossy(&o.stderr).contains("not a git repository")
                }) {
                    "missing"
                } else {
                    "error"
                }
            }
        }
    };
    bus.commit(|tx| {
        let read = |sql: &str, id: &str| -> rusqlite::Result<Option<Value>> {
            let raw: Option<String> = tx.query_row(sql, [id], |r| r.get(0)).optional()?;
            raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()
        };
        let mut run = read("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1", run_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        if run["threadId"] != thread { return Err(rusqlite::Error::InvalidQuery); }
        let status = run["status"].as_str().unwrap_or("");
        let stopped = status == "interrupted" || status == "cancelled";
        if status == "rolled_back" || ((status == "completed" || stopped) && !run["checkpointId"].is_null()) { return Ok(((), vec![])); }
        if status != "waiting" && !stopped { return Err(rusqlite::Error::InvalidQuery); }
        let node_id = run["rootNodeId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        let mut node = read("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", &node_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let scope = read("SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id=?1", scope_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        if node["checkpointScopeId"] != scope_id || scope["threadId"] != thread { return Err(rusqlite::Error::InvalidQuery); }
        let provider_id = run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?.to_owned();
        let provider = read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", &provider_id)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let driver = provider["driver"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let ordinal = run["ordinal"].as_i64().filter(|n| *n > 0).ok_or(rusqlite::Error::InvalidQuery)?;
        let cwd = scope["cwd"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        if cwd != target_cwd || ordinal != target_ordinal || node_id != target_node || provider_id != target_provider { return Err(rusqlite::Error::InvalidQuery); }
        let thread_payload = read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", thread)?.ok_or(rusqlite::Error::InvalidQuery)?;
        let side = thread_payload.pointer("/lineage/sideChat").and_then(Value::as_bool).unwrap_or(false);
        if side != target_side { return Err(rusqlite::Error::InvalidQuery); }
        let encode = |s: &str| -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() };
        let checkpoint_id = |n: i64| format!("checkpoint:scope:{}:name:{n}", encode(scope_id));
        let mut events: Vec<(&str, Value)> = Vec::new();
        let mut ordinals = vec![];
        if ordinal > 1 { ordinals.push(0); }
        ordinals.push(ordinal - 1);
        for n in ordinals {
            let preserved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_checkpoints WHERE scope_id=?1 AND ordinal_within_scope=?2 AND (status='ready' OR (status='missing' AND run_id IS NOT NULL)))", params![scope_id,n], |r| r.get(0))?;
            if preserved { continue; }
            let reference = checkpoint_ref(scope_id, n as u64);
            let state = baseline_states[&n];
            let p = json!({"id":checkpoint_id(n),"threadId":thread,"scopeId":scope_id,"runId":null,"nodeId":node_id,"parentCheckpointId":null,"ordinalWithinScope":n,"appRunOrdinal":null,"ref":reference,"status":state,"files":[],"capturedAt":run["requestedAt"]});
            events.push(("checkpoint.captured", p));
        }
        let reference = checkpoint_ref(scope_id, ordinal as u64);
        let state = capture_state;
        let id = checkpoint_id(ordinal);
        let checkpoint = json!({"id":id,"threadId":thread,"scopeId":scope_id,"runId":run_id,"nodeId":node_id,"parentCheckpointId":checkpoint_id(ordinal-1),"ordinalWithinScope":ordinal,"appRunOrdinal":ordinal,"ref":reference,"status":state,"files":[],"capturedAt":at});
        events.push(("checkpoint.captured", checkpoint));
        let item_id = format!("turn-item:provider:{}:native-item:{}", encode(driver), encode(&format!("checkpoint:{id}")));
        let item = json!({"id":item_id,"threadId":thread,"runId":run_id,"nodeId":node_id,"providerThreadId":provider_id,"providerTurnId":node["providerTurnId"],"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal*1_000_000+99,"status":"completed","title":null,"startedAt":at,"completedAt":at,"updatedAt":at,"type":"checkpoint","checkpointId":id,"scopeId":scope_id,"files":[]});
        events.push(("turn-item.updated", item.clone()));
        run["checkpointId"] = json!(id);
        if !stopped { run["status"] = json!("completed"); run["completedAt"] = json!(at); }
        let mut event_run = run.clone(); event_run.as_object_mut().unwrap().remove("delegatedCompletion");
        events.push(("run.updated", event_run));
        if !stopped { node["status"] = json!("completed"); node["completedAt"] = json!(at); events.push(("node.updated", node.clone())); }
        for (_, p) in events.iter().filter(|(kind,_)| *kind == "checkpoint.captured") {
            tx.execute("INSERT INTO orchestration_v2_projection_checkpoints(checkpoint_id,thread_id,scope_id,run_id,node_id,parent_checkpoint_id,ordinal_within_scope,app_run_ordinal,status,captured_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(scope_id,ordinal_within_scope) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,run_id=excluded.run_id,node_id=excluded.node_id,parent_checkpoint_id=excluded.parent_checkpoint_id,app_run_ordinal=excluded.app_run_ordinal,status=excluded.status,captured_at=excluded.captured_at,payload_json=excluded.payload_json", params![p["id"].as_str(),thread,scope_id,p["runId"].as_str(),node_id,p["parentCheckpointId"].as_str(),p["ordinalWithinScope"].as_i64(),p["appRunOrdinal"].as_i64(),p["status"].as_str(),p["capturedAt"].as_str(),p.to_string()])?;
        }
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'checkpoint','completed',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at", params![item_id,thread,run_id,node_id,provider_id,node["providerTurnId"].as_str(),ordinal*1_000_000+99,at,item.to_string()])?;
        tx.execute("UPDATE orchestration_v2_projection_runs SET status=?2,completed_at=?3,payload_json=?4 WHERE run_id=?1", params![run_id,run["status"].as_str(),run["completedAt"].as_str(),run.to_string()])?;
        if !stopped { tx.execute("UPDATE orchestration_v2_projection_nodes SET status='completed',completed_at=?2,payload_json=?3 WHERE node_id=?1", params![node_id,at,node.to_string()])?; }
        let command = format!("command:effect:checkpoint.capture:{run_id}");
        let ev: Vec<Event> = events.into_iter().map(|(kind,payload)| Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(),stream_id:thread.into(),event_type:kind.into(),occurred_at:at.into(),command_id:Some(command.clone()),causation_event_id:None,correlation_id:None,actor_kind:"system".into(),payload,metadata:json!({"driver":driver,"providerInstanceId":run["providerInstanceId"]}) }).collect();
        let stored = event_store::append(tx,&ev)?;
        event_store::insert_receipt_if_absent(tx,&Receipt {command_id:command,aggregate_kind:"thread".into(),aggregate_id:thread.into(),command_type:"checkpoint.capture".into(),accepted_at:at.into(),result_sequence:stored.last().map_or(0,|e|e.sequence),status:"accepted".into(),error:None})?;
        Ok(((), stored))
    })?;
    crate::queue_promotion::promote(bus, thread, at)?;
    Ok(())
}

#[cfg(test)]
mod restore_tests {
    use super::*;
    #[test]
    fn restore_recovers_snapshot_cleans_untracked_and_keeps_ignored() {
        let dir = std::env::temp_dir().join(format!("checkpoint-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .current_dir(&dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "-q"]);
        std::fs::write(dir.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(dir.join("file"), "before").unwrap();
        let reference = checkpoint_ref("restore", 1);
        capture(&dir, &reference).unwrap();
        std::fs::write(dir.join("file"), "after").unwrap();
        std::fs::write(dir.join("extra"), "extra").unwrap();
        std::fs::write(dir.join("ignored"), "keep").unwrap();
        assert!(!restore(&dir, "refs/t3/missing").unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("file")).unwrap(), "after");
        assert!(restore(&dir, &reference).unwrap());
        assert_eq!(std::fs::read_to_string(dir.join("file")).unwrap(), "before");
        assert!(!dir.join("extra").exists());
        assert!(dir.join("ignored").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
