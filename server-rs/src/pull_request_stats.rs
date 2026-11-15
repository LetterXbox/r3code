//! Read line counts for pull requests already present in a list.
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashSet,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

type StatRequest = (String, String, String, u64);

pub(crate) fn valid(input: &Value) -> bool {
    input
        .get("refs")
        .and_then(Value::as_array)
        .is_some_and(|refs| refs.len() <= 500 && refs.iter().all(crate::pull_request_links::valid))
}

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Value {
    read_with(projects, input, "gh", Duration::from_secs(10))
}

fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    executable: &str,
    timeout: Duration,
) -> Value {
    let projects: Vec<_> = projects
        .into_iter()
        .filter_map(|(id, _, root)| {
            let identity = crate::repository_identity::resolve(&root)?;
            if identity["provider"] != "github" {
                return None;
            }
            let key = identity["canonicalKey"].as_str()?;
            let (host, _) = key.split_once('/')?;
            let repo = identity["displayName"].as_str()?;
            Some((id, root.clone(), host.to_owned(), repo.to_owned()))
        })
        .collect();
    let mut seen = HashSet::new();
    // Preserve the order in which hosts first appear, matching the reference's
    // insertion-ordered Map when several provider hosts are queried.
    let mut groups: Vec<(String, Vec<StatRequest>)> = Vec::new();
    for reference in input["refs"].as_array().unwrap() {
        let requested_id = reference["projectId"].as_str().unwrap();
        let requested_repo = reference["repository"].as_str().unwrap().trim();
        let requested_host = reference.get("host").and_then(Value::as_str).map(str::trim);
        let matches = |(_, _, host, repo): &&(String, String, String, String)| {
            repo.eq_ignore_ascii_case(requested_repo)
                && requested_host.is_none_or(|h| h.eq_ignore_ascii_case(host))
        };
        let selected = projects.iter().find(|(id, _, _, _)| id == requested_id);
        let Some((id, root, host, repo)) = selected
            .filter(matches)
            .or_else(|| requested_host.and_then(|_| projects.iter().find(matches)))
        else {
            continue;
        };
        let n = reference["number"].as_u64().unwrap();
        if seen.insert((id.to_owned(), n)) {
            let index = groups
                .iter()
                .position(|(key, _)| key == host)
                .unwrap_or_else(|| {
                    groups.push((host.clone(), Vec::new()));
                    groups.len() - 1
                });
            groups[index]
                .1
                .push((id.to_owned(), root.clone(), repo.clone(), n));
        }
    }
    let mut stats = Vec::new();
    for (host, entries) in groups {
        // GraphQL aliases let one host request cover multiple repositories.
        for chunk in entries.chunks(50) {
            let mut query = String::from("query {");
            for (i, (_, _, repo, n)) in chunk.iter().enumerate() {
                let Some((owner, name)) = repo.split_once('/') else {
                    continue;
                };
                query.push_str(&format!(" p{i}: repository(owner:{},name:{}) {{ pullRequest(number:{n}) {{ additions deletions }} }}", json!(owner), json!(name)));
            }
            query.push('}');
            let Some(data) = graphql(executable, &chunk[0].1, &host, &query, timeout) else {
                continue;
            };
            for (i, (id, _, repo, n)) in chunk.iter().enumerate() {
                let pr = &data["data"][format!("p{i}")]["pullRequest"];
                if let (Some(additions), Some(deletions)) =
                    (pr["additions"].as_u64(), pr["deletions"].as_u64())
                {
                    stats.push(json!({"projectId":id,"repository":repo,"number":n,"additions":additions,"deletions":deletions}));
                }
            }
        }
    }
    json!({"stats":stats})
}

fn graphql(
    executable: &str,
    root: &str,
    host: &str,
    query: &str,
    timeout: Duration,
) -> Option<Value> {
    let mut command = Command::new(executable);
    command
        .args([
            "api",
            "graphql",
            "--hostname",
            host,
            "-f",
            &format!("query={query}"),
        ])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let result = (&mut stdout).take(1_048_577).read_to_end(&mut data);
        let _ = tx.send(result.map(|_| data));
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    if !status?.success() {
        return None;
    }
    let bytes = rx.recv_timeout(Duration::from_millis(200)).ok()?.ok()?;
    if bytes.len() > 1_048_576 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn reads_counts_and_ignores_unknown_refs_and_provider_failure() {
        let dir = std::env::temp_dir().join(format!("t3-pr-stats-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.as_path();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git"
            ])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        let script = root.join("fake-gh");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s' '{\"data\":{\"p0\":{\"pullRequest\":{\"additions\":12,\"deletions\":3}}}}'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = vec![(
            "p".into(),
            "Project".into(),
            root.to_string_lossy().into_owned(),
        )];
        let reference = json!({"projectId":"p","repository":"owner/repo","number":7});
        let input = json!({"refs":[reference.clone(), reference, {"projectId":"missing","repository":"owner/repo","number":8}]});
        assert!(valid(&input));
        assert_eq!(
            read_with(
                projects.clone(),
                &input,
                script.to_str().unwrap(),
                Duration::from_secs(2)
            ),
            json!({"stats":[{"projectId":"p","repository":"owner/repo","number":7,"additions":12,"deletions":3}]})
        );
        let different_host = json!({"refs":[{"projectId":"p","repository":"owner/repo","number":7,"host":"other.example"}]});
        assert_eq!(
            read_with(
                projects.clone(),
                &different_host,
                script.to_str().unwrap(),
                Duration::from_secs(2)
            ),
            json!({"stats":[]})
        );
        let other = root.join("other-checkout");
        std::fs::create_dir_all(&other).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&other)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/Other/Repo.git"
            ])
            .current_dir(&other)
            .status()
            .unwrap()
            .success());
        let mut both = projects.clone();
        both.push((
            "other".into(),
            "Other".into(),
            other.to_string_lossy().into_owned(),
        ));
        let cross = json!({"refs":[{"projectId":"p","host":"github.com","repository":"other/repo","number":7}]});
        assert_eq!(
            read_with(
                both,
                &cross,
                script.to_str().unwrap(),
                Duration::from_secs(2)
            ),
            json!({"stats":[{"projectId":"other","repository":"Other/Repo","number":7,"additions":12,"deletions":3}]})
        );
        assert_eq!(
            read_with(projects, &input, "/nonexistent", Duration::from_secs(2)),
            json!({"stats":[]})
        );
        assert!(!valid(&json!({"refs":[{"number":0}]})));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
