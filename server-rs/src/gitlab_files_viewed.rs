//! Environment-backed GitLab viewed marks, scoped to the signed-in viewer.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Command,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

fn glab(exe: &str, root: &str, host: &str, args: &[&str]) -> Option<Value> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(root)
        .env("GITLAB_HOST", host)
        .env("GLAB_PROMPT_DISABLED", "1");
    let bytes =
        crate::github_pinned_credential::run_classified(&mut cmd, Duration::from_secs(10)).ok()?;
    let result: Value = serde_json::from_slice(&bytes).ok()?;
    if result
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|e| !e.is_empty())
    {
        return None;
    }
    Some(result)
}
fn revisions(
    exe: &str,
    root: &str,
    host: &str,
    repo: &str,
    number: u64,
    paths: &[String],
) -> HashMap<String, String> {
    let mut result = HashMap::new();
    if paths.is_empty() {
        return result;
    }
    let encoded: String = repo
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let Some(mr) = glab(
        exe,
        root,
        host,
        &[
            "api",
            &format!("projects/{encoded}/merge_requests/{number}"),
        ],
    ) else {
        return result;
    };
    let Some(head) = mr["diff_refs"]["head_sha"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return result;
    };
    for batch in paths.chunks(100) {
        let query=format!("query {{ project(fullPath:{}) {{ repository {{ blobs(ref:{}, paths:{}) {{ nodes {{ path oid }} }} }} }} }}",json!(repo),json!(head),json!(batch));
        let Some(page) = glab(
            exe,
            root,
            host,
            &["api", "graphql", "-f", &format!("query={query}")],
        ) else {
            continue;
        };
        let Some(nodes) = page["data"]["project"]["repository"]["blobs"]["nodes"].as_array() else {
            continue;
        };
        for path in batch {
            result.insert(path.clone(), String::new());
        }
        for node in nodes {
            if let (Some(path), Some(oid)) = (
                node["path"].as_str(),
                node["oid"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            ) {
                result.insert(path.to_string(), oid.to_string());
            }
        }
    }
    result
}

pub(crate) fn run(
    db: &Mutex<Connection>,
    root: &str,
    host: &str,
    repo: &str,
    remote: &str,
    input: &Value,
    write: bool,
) -> Result<Value, Value> {
    run_with("glab", db, root, host, (repo, remote), input, write)
}

fn run_with(
    exe: &str,
    db: &Mutex<Connection>,
    root: &str,
    host: &str,
    repository: (&str, &str),
    input: &Value,
    write: bool,
) -> Result<Value, Value> {
    let (repo, remote) = repository;
    // Serialize mutations per change request while leaving unrelated database work free.
    static GATES: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let gate = if write {
        let mut gates = GATES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        gates.retain(|_, value| value.strong_count() > 0);
        let key = format!("{host}/{remote}/{}", input["number"]);
        let gate = gates
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        gates.insert(key, Arc::downgrade(&gate));
        Some(gate)
    } else {
        None
    };
    let _guard = gate
        .as_ref()
        .map(|gate| gate.lock().unwrap_or_else(|e| e.into_inner()));
    let operation = if write {
        "setFilesViewed"
    } else {
        "filesViewed"
    };
    let store_error = || json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"This environment could not reach its record of which files you have seen."});
    let viewer_error = || json!({"_tag":"PullRequestOperationError","operation":operation,"detail":"The signed-in account could not be verified before starting the operation."});
    let user = glab(exe, root, host, &["api", "user"]).ok_or_else(viewer_error)?;
    let viewer = user["username"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(viewer_error)?;
    let number = input["number"].as_u64().unwrap();
    if write {
        let files = input["files"].as_array().unwrap();
        let paths: Vec<String> = files
            .iter()
            .filter(|f| f["viewed"] == true)
            .map(|f| f["path"].as_str().unwrap().to_string())
            .collect();
        let revisions = revisions(exe, root, host, repo, number, &paths);
        let mut db = db.lock().map_err(|_| store_error())?;
        let tx = db.transaction().map_err(|_| store_error())?;
        for file in files {
            let path = file["path"].as_str().unwrap();
            if file["viewed"] == true {
                let revision = revisions.get(path).map(String::as_str);
                tx.execute("INSERT INTO pull_request_files_viewed (provider,host,repository,number,viewer,path,revision,viewed_at) VALUES ('gitlab',?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(provider,host,repository,number,viewer,path) DO UPDATE SET revision=excluded.revision,viewed_at=excluded.viewed_at",params![host,remote,number,viewer,path,revision]).map_err(|_|store_error())?;
            } else {
                tx.execute("DELETE FROM pull_request_files_viewed WHERE provider='gitlab' AND host=?1 AND repository=?2 AND number=?3 AND viewer=?4 AND path=?5",params![host,remote,number,viewer,path]).map_err(|_|store_error())?;
            }
        }
        tx.commit().map_err(|_| store_error())?;
        return Ok(Value::Null);
    }
    let marks: Vec<(String, Option<String>)> = {
        let db = db.lock().map_err(|_| store_error())?;
        let mut stmt=db.prepare("SELECT path,revision FROM pull_request_files_viewed WHERE provider='gitlab' AND host=?1 AND repository=?2 AND number=?3 AND viewer=?4 ORDER BY path LIMIT 501").map_err(|_|store_error())?;
        let rows = stmt
            .query_map(params![host, remote, number, viewer], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|_| store_error())?;
        rows.collect::<Result<_, _>>().map_err(|_| store_error())?
    };
    let truncated = marks.len() > 500;
    let paths: Vec<_> = marks
        .iter()
        .take(500)
        .map(|(path, _)| path.clone())
        .collect();
    let revisions = revisions(exe, root, host, repo, number, &paths);
    let files: Vec<_> = marks
        .into_iter()
        .take(500)
        .map(|(path, revision)| {
            let state = match (revision, revisions.get(&path)) {
                (Some(old), Some(current)) if old != *current => "dismissed",
                _ => "viewed",
            };
            json!({"path":path,"state":state})
        })
        .collect();
    Ok(json!({"files":files,"truncated":truncated}))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    #[test]
    fn persists_scoped_marks_and_detects_changed_and_deleted_blobs() {
        let dir = std::env::temp_dir().join(format!("t3-viewed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("glab");
        fs::write(
            &script,
            r##"#!/bin/sh
case "$2" in
user) printf '%s' '{"username":"reviewer"}' ;;
graphql) cat "$PWD/blobs.json" ;;
*) printf '%s' '{"diff_refs":{"head_sha":"head"}}' ;;
esac
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let root = dir.to_str().unwrap();
        let exe = script.to_str().unwrap();
        fs::write(
            dir.join("blobs.json"),
            r#"{"data":{"project":{"repository":{"blobs":{"nodes":[{"path":"a","oid":"one"}]}}}}}"#,
        )
        .unwrap();
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/053.sql"))
            .unwrap();
        let db = Mutex::new(db);
        let input = json!({"number":1,"files":[{"path":"a","viewed":true},{"path":"b","viewed":true}]});
        run_with(
            exe,
            &db,
            root,
            "gitlab.test",
            ("a/b", "gitlab.test/a/b"),
            &input,
            true,
        )
        .unwrap();
        let read = run_with(
            exe,
            &db,
            root,
            "gitlab.test",
            ("a/b", "gitlab.test/a/b"),
            &input,
            false,
        )
        .unwrap();
        assert_eq!(
            read,
            json!({"files":[{"path":"a","state":"viewed"},{"path":"b","state":"viewed"}],"truncated":false})
        );
        fs::write(
            dir.join("blobs.json"),
            r#"{"data":{"project":{"repository":{"blobs":{"nodes":[{"path":"a","oid":"two"}]}}}}}"#,
        )
        .unwrap();
        let read = run_with(
            exe,
            &db,
            root,
            "gitlab.test",
            ("a/b", "gitlab.test/a/b"),
            &input,
            false,
        )
        .unwrap();
        assert_eq!(read["files"][0]["state"], "dismissed");
        let other = run_with(
            exe,
            &db,
            root,
            "gitlab.test",
            ("a/b", "gitlab.test/other"),
            &input,
            false,
        )
        .unwrap();
        assert_eq!(other["files"], json!([]));
        let clear = json!({"number":1,"files":[{"path":"a","viewed":false}]});
        run_with(
            exe,
            &db,
            root,
            "gitlab.test",
            ("a/b", "gitlab.test/a/b"),
            &clear,
            true,
        )
        .unwrap();
        assert_eq!(
            run_with(
                exe,
                &db,
                root,
                "gitlab.test",
                ("a/b", "gitlab.test/a/b"),
                &input,
                false
            )
            .unwrap()["files"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn network_wait_does_not_hold_database_mutex() {
        let dir = std::env::temp_dir().join(format!("t3-viewed-lock-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("glab");
        fs::write(&script, "#!/bin/sh\ntouch \"$PWD/started\"\nsleep 1\nprintf '%s' '{\"username\":\"reviewer\"}'\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
        db.lock()
            .unwrap()
            .execute_batch(include_str!("../migrations/053.sql"))
            .unwrap();
        let db2 = db.clone();
        let root = dir.to_string_lossy().to_string();
        let exe = script.to_string_lossy().to_string();
        let worker = std::thread::spawn(move || {
            run_with(
                &exe,
                &db2,
                &root,
                "gitlab.test",
                ("a/b", "gitlab.test/a/b"),
                &json!({"number": 1}),
                false,
            )
        });
        for _ in 0..100 {
            if dir.join("started").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(dir.join("started").exists());
        assert!(db.try_lock().is_ok());
        worker.join().unwrap().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
