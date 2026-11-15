//! GitHub pull request diff reads.
use crate::github_pinned_credential;
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn read(projects: Vec<(String, String, String)>, input: &Value) -> Result<Value, Value> {
    read_with(projects, input, "gh")
}
fn read_with(
    projects: Vec<(String, String, String)>,
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let rejected = || json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."});
    let unsupported =
        || json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"});
    let mismatch = || json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."});
    let resolved: Vec<_> = projects
        .into_iter()
        .map(|(id, title, root)| {
            let identity = crate::repository_identity::resolve(&root);
            (id, title, root, identity)
        })
        .collect();
    let requested = input["projectId"].as_str().unwrap();
    let repo = input["repository"].as_str().unwrap().trim();
    let host = input.get("host").and_then(Value::as_str).map(str::trim);
    let matches = |p: &&(String, String, String, Option<Value>)| {
        p.3.as_ref()
            .and_then(|v| v["canonicalKey"].as_str())
            .and_then(|k| k.split_once('/'))
            .is_some_and(|(h, r)| {
                r.eq_ignore_ascii_case(repo) && host.is_none_or(|x| x.eq_ignore_ascii_case(h))
            })
    };
    let selected = resolved.iter().find(|p| p.0 == requested);
    let project = selected
        .filter(matches)
        .or_else(|| host.and_then(|_| resolved.iter().find(matches)))
        .ok_or_else(|| {
            if input.get("expectedAccountId").is_some() {
                return rejected();
            }
            if host.is_none() && selected.is_some_and(|p| p.3.is_some()) {
                mismatch()
            } else {
                unsupported()
            }
        })?;
    let identity = project.3.as_ref().unwrap();
    if identity["provider"] == "gitlab" {
        return crate::gitlab_pull_request_diff::read(project, input);
    }
    if identity["provider"] != "github" {
        return Err(if input.get("expectedAccountId").is_some() {
            rejected()
        } else {
            unsupported()
        });
    }
    let (host, _) = identity["canonicalKey"]
        .as_str()
        .unwrap()
        .split_once('/')
        .unwrap();
    let credential = if let Some(expected) = input.get("expectedAccountId").and_then(Value::as_str)
    {
        if !input
            .get("host")
            .and_then(Value::as_str)
            .is_some_and(|h| h.eq_ignore_ascii_case(host))
        {
            return Err(rejected());
        }
        Some(
            github_pinned_credential::capture(exe, &project.2, host, expected)
                .ok_or_else(rejected)?,
        )
    } else {
        None
    };
    let repo = identity["displayName"].as_str().ok_or_else(unsupported)?;
    let (owner, name) = repo.split_once('/').ok_or_else(unsupported)?;
    let number = input["number"].as_u64().unwrap();
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"diff","detail":"The pull request diff could not be read."});
    let cursor = input.get("cursor").and_then(Value::as_str);
    let commit = input.get("commit").and_then(Value::as_str);
    if cursor.is_some_and(|s| {
        s.len() > 7 || s.starts_with('0') || !s.bytes().all(|c| c.is_ascii_digit())
    }) || commit
        .is_some_and(|s| !(7..=64).contains(&s.len()) || !s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(fail());
    }
    let page = cursor.and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let run = |path: &str, diff: bool| {
        let mut cmd = Command::new(exe);
        cmd.args(["api", "--hostname", host]);
        if diff {
            cmd.args(["-H", "Accept: application/vnd.github.diff"]);
        }
        cmd.arg(path).current_dir(&project.2);
        if let Some(credential) = &credential {
            credential.apply(&mut cmd);
        }
        github_pinned_credential::run_classified_bounded(
            &mut cmd,
            Duration::from_secs(30),
            8 * 1024 * 1024,
        )
    };
    let files_path = if let Some(commit) = commit {
        format!("repos/{owner}/{name}/commits/{commit}?per_page=100&page={page}")
    } else {
        format!("repos/{owner}/{name}/pulls/{number}/files?per_page=100&page={page}")
    };
    if cursor.is_none() && commit.is_none() {
        if let Ok(bytes) = run(&format!("repos/{owner}/{name}/pulls/{number}"), true) {
            if bytes.len() <= 8 * 1024 * 1024 {
                let patch = String::from_utf8(bytes).map_err(|_| fail())?;
                return Ok(json!({"patch":patch,"truncated":false,"nextCursor":null}));
            }
        }
    }
    let bytes = run(&files_path, false).map_err(|e| {
        github_pinned_credential::operation_error(
            e,
            "diff",
            "The pull request diff could not be read.",
        )
    })?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(fail());
    }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let files = if commit.is_some() {
        response.get("files").and_then(Value::as_array)
    } else {
        response.as_array()
    }
    .ok_or_else(fail)?;
    Ok(map_files(files, page))
}

pub(crate) fn quote_path(path: &str) -> String {
    let mut body = String::new();
    let mut quoted = false;
    for c in path.chars() {
        let escaped = match c {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\x07' => Some("\\a"),
            '\x08' => Some("\\b"),
            '\t' => Some("\\t"),
            '\n' => Some("\\n"),
            '\x0b' => Some("\\v"),
            '\x0c' => Some("\\f"),
            '\r' => Some("\\r"),
            _ => None,
        };
        if let Some(escape) = escaped {
            quoted = true;
            body.push_str(escape);
        } else if (c as u32) < 0x20 || c == '\x7f' {
            quoted = true;
            body.push_str(&format!("\\{:03o}", c as u32));
        } else {
            body.push(c);
        }
    }
    if quoted {
        format!("\"{body}\"")
    } else {
        body
    }
}
fn map_files(files: &[Value], page: u32) -> Value {
    let mut patch = String::new();
    let mut omitted = Vec::new();
    for file in files {
        let Some(path) = file["filename"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let status = file["status"].as_str().unwrap_or("").trim().to_lowercase();
        let hunks = file["patch"].as_str().unwrap_or("");
        let additions = file["additions"].as_u64().unwrap_or(0);
        let deletions = file["deletions"].as_u64().unwrap_or(0);
        if hunks.is_empty() && additions + deletions > 0 {
            omitted.push(json!({"path":path,"additions":additions,"deletions":deletions}));
        }
        let old = if status == "renamed" {
            file["previous_filename"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(path)
        } else {
            path
        };
        patch.push_str(&format!(
            "diff --git {} {}\n",
            quote_path(&format!("a/{old}")),
            quote_path(&format!("b/{path}"))
        ));
        match status.as_str() {
            "added" => patch.push_str("new file mode 100644\n"),
            "removed" => patch.push_str("deleted file mode 100644\n"),
            "renamed" => patch.push_str(&format!(
                "similarity index {}%\nrename from {}\nrename to {}\n",
                if !hunks.is_empty() || additions + deletions > 0 {
                    0
                } else {
                    100
                },
                quote_path(old),
                quote_path(path)
            )),
            _ => {}
        }
        patch.push_str(&format!(
            "--- {}\n+++ {}\n",
            if status == "added" {
                "/dev/null".into()
            } else {
                quote_path(&format!("a/{old}"))
            },
            if status == "removed" {
                "/dev/null".into()
            } else {
                quote_path(&format!("b/{path}"))
            }
        ));
        if !hunks.is_empty() {
            patch.push_str(hunks);
            if !hunks.ends_with('\n') {
                patch.push('\n');
            }
        }
    }
    let mut result = json!({"patch":patch,"truncated":!omitted.is_empty(),"nextCursor":if files.len() >= 100 {Some((page+1).to_string())} else {None}});
    if !omitted.is_empty() {
        result["omittedFileStats"] = json!(omitted);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_renames_omitted_binary_and_pagination() {
        let mut files = vec![
            json!({"filename":"new name","previous_filename":"old name","status":"renamed","patch":"@@ -1 +1 @@\n-old\n+new","additions":1,"deletions":1}),
            json!({"filename":"binary","status":"modified","additions":3,"deletions":2}),
        ];
        files.resize(100, Value::Null);
        let result = map_files(&files, 1);
        assert!(result["patch"]
            .as_str()
            .unwrap()
            .contains("rename from old name\nrename to new name"));
        assert_eq!(
            result["omittedFileStats"][0],
            json!({"path":"binary","additions":3,"deletions":2})
        );
        assert_eq!(result["nextCursor"], "2");
        assert_eq!(result["truncated"], true);
    }
    #[test]
    fn quotes_only_control_characters_and_git_escapes() {
        assert_eq!(quote_path("a/space é"), "a/space é");
        assert_eq!(
            quote_path("a/a\tb\n\"\\\u{7f}"),
            "\"a/a\\tb\\n\\\"\\\\\\177\""
        );
    }
    #[test]
    #[cfg(unix)]
    fn reads_full_and_paged_diff_from_matching_checkout() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("t3-pr-diff-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&tmp)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/Owner/Repo.git"
            ])
            .current_dir(&tmp)
            .status()
            .unwrap()
            .success());
        let script = tmp.join("fake-gh");
        std::fs::write(&script, "#!/bin/sh\ncase \"$*\" in *files?*) printf '%s' '[{\"filename\":\"a\",\"status\":\"added\",\"patch\":\"@@ +1 @@\\n+x\"}]' ;; *) printf 'full patch' ;; esac\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let projects = || vec![("p".into(), "P".into(), tmp.to_string_lossy().into_owned())];
        let mut input = json!({"projectId":"p","repository":"owner/repo","number":7});
        assert_eq!(
            read_with(projects(), &input, script.to_str().unwrap()).unwrap()["patch"],
            "full patch"
        );
        input["cursor"] = json!("2");
        assert!(
            read_with(projects(), &input, script.to_str().unwrap()).unwrap()["patch"]
                .as_str()
                .unwrap()
                .contains("new file mode 100644")
        );
        input["cursor"] = json!("../bad");
        assert_eq!(
            read_with(projects(), &input, script.to_str().unwrap()).unwrap_err()["operation"],
            "diff"
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
