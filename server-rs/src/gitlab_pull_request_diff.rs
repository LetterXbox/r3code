//! GitLab merge request diff slices through glab.
use crate::github_pinned_credential::{self, CommandFailure};
use crate::pull_request_diff::quote_path;
use serde_json::{json, Value};
use std::{process::Command, time::Duration};

pub(crate) fn read(
    project: &(String, String, String, Option<Value>),
    input: &Value,
) -> Result<Value, Value> {
    read_with(project, input, "glab")
}

fn read_with(
    project: &(String, String, String, Option<Value>),
    input: &Value,
    exe: &str,
) -> Result<Value, Value> {
    let fail = || json!({"_tag":"PullRequestOperationError","operation":"diff","detail":"The pull request diff could not be read."});
    if input.get("expectedAccountId").is_some() {
        return Err(
            json!({"_tag":"PullRequestOperationError","operation":"routeIdentity","detail":"The signed-in account could not be verified before starting the operation."}),
        );
    }
    let identity = project.3.as_ref().ok_or_else(fail)?;
    let repo = identity["displayName"].as_str().ok_or_else(fail)?;
    let host = identity["canonicalKey"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .map(|x| x.0)
        .ok_or_else(fail)?;
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
    let cursor = input.get("cursor").and_then(Value::as_str);
    let commit = input.get("commit").and_then(Value::as_str);
    if cursor.is_some_and(|s| {
        s.is_empty() || s.len() > 7 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
    }) || commit
        .is_some_and(|s| !(7..=64).contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(fail());
    }
    let page = cursor.and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let size = if commit.is_some() { 100 } else { 30 };
    let number = input["number"].as_u64().ok_or_else(fail)?;
    let endpoint = match commit {
        Some(sha) => format!("repository/commits/{sha}/diff"),
        None => format!("merge_requests/{number}/diffs"),
    };
    let path = format!("projects/{encoded}/{endpoint}?per_page={size}&page={page}");
    let run = |path: &str| {
        let mut cmd = Command::new(exe);
        cmd.args(["api", path])
            .current_dir(&project.2)
            .env("GITLAB_HOST", host)
            .env("GLAB_PROMPT_DISABLED", "1");
        github_pinned_credential::run_classified_bounded(
            &mut cmd,
            Duration::from_secs(60),
            8 * 1024 * 1024,
        )
    };
    let (bytes, legacy) = match run(&path) {
        Ok(bytes) => (bytes, false),
        Err(CommandFailure::NotFound) if commit.is_none() && page == 1 => (
            run(&format!(
                "projects/{encoded}/merge_requests/{number}/changes?access_raw_diffs=true"
            ))
            .map_err(map_error)?,
            true,
        ),
        Err(e) => return Err(map_error(e)),
    };
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let files = if legacy {
        response["changes"].as_array()
    } else {
        response.as_array()
    }
    .ok_or_else(fail)?;
    let mut result = map_files(files, page, size, legacy);
    if legacy
        && (response["overflow"] == true
            || response["changes_count"]
                .as_str()
                .is_some_and(|s| s.ends_with('+')))
    {
        result["truncated"] = json!(true);
    }
    Ok(result)
}
fn map_error(e: CommandFailure) -> Value {
    match e {
        CommandFailure::Spawn(std::io::ErrorKind::NotFound) => {
            json!({"_tag":"PullRequestUnavailableError","reason":"cli-missing","provider":"gitlab"})
        }
        CommandFailure::Unauthenticated => {
            json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"gitlab"})
        }
        CommandFailure::NotFound => {
            json!({"_tag":"PullRequestOperationError","operation":"diff","detail":"The pull request diff could not be read.","reason":"not-found"})
        }
        _ => {
            json!({"_tag":"PullRequestOperationError","operation":"diff","detail":"The pull request diff could not be read."})
        }
    }
}
fn map_files(files: &[Value], page: u32, size: usize, legacy: bool) -> Value {
    let mut sections = Vec::new();
    let mut truncated = false;
    for file in files {
        let (Some(old), Some(new)) = (file["old_path"].as_str(), file["new_path"].as_str()) else {
            truncated = true;
            continue;
        };
        let hunks = file["diff"].as_str().unwrap_or("");
        let omitted = file["too_large"] == true || file["collapsed"] == true;
        if hunks.is_empty() && omitted {
            truncated = true;
        }
        let mut header = format!(
            "diff --git {} {}\n",
            quote_path(&format!("a/{old}")),
            quote_path(&format!("b/{new}"))
        );
        if file["new_file"] == true {
            header.push_str(&format!(
                "new file mode {}\n",
                file["b_mode"].as_str().unwrap_or("100644")
            ));
        }
        if file["deleted_file"] == true {
            header.push_str(&format!(
                "deleted file mode {}\n",
                file["a_mode"].as_str().unwrap_or("100644")
            ));
        }
        if file["renamed_file"] == true {
            header.push_str(&format!(
                "similarity index {}%\nrename from {}\nrename to {}\n",
                if !hunks.is_empty() || omitted { 0 } else { 100 },
                quote_path(old),
                quote_path(new)
            ));
        }
        header.push_str(&format!(
            "--- {}\n+++ {}",
            if file["new_file"] == true {
                "/dev/null".to_owned()
            } else {
                quote_path(&format!("a/{old}"))
            },
            if file["deleted_file"] == true {
                "/dev/null".to_owned()
            } else {
                quote_path(&format!("b/{new}"))
            }
        ));
        if !hunks.is_empty() {
            header.push('\n');
            header.push_str(hunks.trim_end_matches('\n'));
            header.push('\n');
        }
        sections.push(header);
    }
    let mut patch = sections.join("\n");
    if !patch.is_empty() && !patch.ends_with('\n') {
        patch.push('\n');
    }
    json!({"patch":patch,"truncated":truncated,"nextCursor":if !legacy && files.len() >= size {Some((page+1).to_string())} else {None}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_renames_truncation_and_pages() {
        let mut files = vec![
            json!({"old_path":"old","new_path":"new","renamed_file":true,"diff":"@@ -1 +1 @@\n-a\n+b"}),
            json!({"old_path":"binary","new_path":"binary","collapsed":true}),
        ];
        files.resize(30, Value::Null);
        let result = map_files(&files, 1, 30, false);
        assert!(result["patch"]
            .as_str()
            .unwrap()
            .contains("similarity index 0%\nrename from old\nrename to new"));
        assert_eq!(result["truncated"], true);
        assert_eq!(result["nextCursor"], "2");
    }
}
