//! Read stored pull-request review guides. Generation is not yet wired.
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

fn error(detail: &str) -> Value {
    json!({"_tag":"PullRequestOperationError","operation":"reviewGuide","detail":detail})
}

pub(crate) fn key(input: &Value, identity: Option<Value>) -> Option<crate::migration_050::PullRequestKey> {
    if let Some(identity) = identity {
        return crate::pull_request_links::key(input, Some(identity));
    }
    Some(crate::migration_050::normalize_key(
        input.get("host")?.as_str()?.trim(),
        input.get("repository")?.as_str()?.trim(),
        input.get("number")?.as_i64()?,
    ))
}

pub(crate) fn read_stored(db: &Connection, key: &crate::migration_050::PullRequestKey) -> Result<Value, Value> {
    let read_error = || error("Could not read the stored review guide.");
    let raw: Option<String> = db.query_row(
        "SELECT guide_json FROM pull_request_review_guides WHERE host=?1 AND repository=?2 AND number=?3",
        rusqlite::params![key.host, key.repository, key.number],
        |row| row.get(0),
    ).optional().map_err(|_| read_error())?;
    let Some(raw) = raw else { return Ok(Value::Null); };
    let mut guide: Value = serde_json::from_str(&raw).map_err(|_| read_error())?;
    if let Some(error) = crate::review_guide_schema::diagnose(&guide) { return Err(error); }
    // The persistence layer decodes the guide schema, rather than returning
    // malformed stored JSON as though it were a valid guide.
    let nonempty = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
    let positive = |v: &Value| v.as_i64().is_some_and(|n| n > 0);
    let valid_stop = |stop: &Value| {
        let attention = stop.get("attention").is_some_and(|a| a.is_null() || (
            matches!(a["kind"].as_str(), Some("tradeoff" | "contract" | "product" | "risk" | "accessibility")) && nonempty(&a["note"])
        ));
        let excerpts = stop["excerpts"].as_array().is_some_and(|items| items.iter().all(|v|
            nonempty(&v["path"]) && matches!(v["side"].as_str(), Some("new" | "old")) && positive(&v["start"]) && positive(&v["end"]) && v["caption"].is_string()));
        let files = stop["files"].as_array().is_some_and(|items| items.iter().all(|v|
            nonempty(&v["path"]) && v.get("note").is_none_or(Value::is_string)));
        let notes = stop["notes"].as_array().is_some_and(|items| items.iter().all(|v|
            nonempty(&v["path"]) && positive(&v["line"]) && nonempty(&v["title"]) && v["body"].is_string()));
        let questions = stop["questions"].as_array().is_some_and(|items| items.iter().all(nonempty));
        nonempty(&stop["title"]) && stop["summary"].is_string() && attention && excerpts && files && notes && questions
    };
    let valid = nonempty(&guide["headSha"])
        && guide["generatedAt"].is_string()
        && guide["modelSelection"].is_object()
        && nonempty(&guide["modelSelection"]["model"])
        && guide["modelSelection"].get("instanceId").or_else(|| guide["modelSelection"].get("provider")).is_some_and(nonempty)
        && guide["stops"].as_array().is_some_and(|stops| stops.iter().all(valid_stop));
    if !valid { return Err(read_error()); }
    let selection = &guide["modelSelection"];
    let instance = selection.get("instanceId").or_else(|| selection.get("provider")).and_then(Value::as_str).unwrap().trim();
    if instance.len() > 64 || !instance.as_bytes()[0].is_ascii_alphabetic() || !instance.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return Err(read_error()); }
    let mut normalized = json!({"instanceId":instance,"model":selection["model"].as_str().unwrap().trim()});
    if let Some(options) = selection.get("options") {
        let mut result = Vec::new();
        let mut add = |id: &str, value: &Value| -> bool {
            let id = id.trim();
            let value = match value {
                Value::Bool(_) => value.clone(),
                Value::String(s) if !s.trim().is_empty() => json!(s.trim()),
                _ => return false,
            };
            if id.is_empty() { return false; }
            result.push(json!({"id":id,"value":value}));
            true
        };
        if let Some(items) = options.as_array() {
            for item in items {
                if !item["id"].as_str().is_some_and(|id| add(id, &item["value"])) { return Err(read_error()); }
            }
        } else if let Some(items) = options.as_object() {
            for (id, value) in items { add(id, value); }
        } else { return Err(read_error()); }
        normalized["options"] = json!(result);
    }
    guide["modelSelection"] = normalized;
    fn trim_field(value: &mut Value, key: &str) {
        if let Some(s) = value[key].as_str() { value[key] = json!(s.trim()); }
    }
    trim_field(&mut guide, "headSha");
    for stop in guide["stops"].as_array_mut().unwrap() {
        stop.as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "title" | "summary" | "attention" | "excerpts" | "files" | "notes" | "questions"));
        trim_field(stop, "title");
        if stop["attention"].is_object() {
            stop["attention"].as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "kind" | "note"));
            trim_field(&mut stop["attention"], "note");
        }
        for entry in stop["excerpts"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "path" | "side" | "start" | "end" | "caption"));
            trim_field(entry, "path");
        }
        for entry in stop["files"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "path" | "note"));
            trim_field(entry, "path");
        }
        for entry in stop["notes"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "path" | "line" | "title" | "body"));
            trim_field(entry, "path");
            trim_field(entry, "title");
        }
        for q in stop["questions"].as_array_mut().unwrap() {
            *q = json!(q.as_str().unwrap().trim());
        }
    }
    guide.as_object_mut().unwrap().retain(|k, _| matches!(k.as_str(), "headSha" | "generatedAt" | "modelSelection" | "stops"));
    Ok(guide)
}

pub(crate) fn unidentified() -> Value {
    error("Could not identify this pull request's host.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_normalized_key_and_rejects_corrupt_stored_guide() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/061.sql")).unwrap();
        let reference = json!({"projectId":"p","host":"GitHub.COM","repository":"Owner/Repo","number":42});
        let key = key(&reference, None).unwrap();
        assert_eq!(read_stored(&db, &key).unwrap(), Value::Null);
        let guide = json!({"headSha":"abc","generatedAt":"2026-01-01T00:00:00Z","modelSelection":{"instanceId":"codex","model":"gpt"},"stops":[]});
        db.execute("INSERT INTO pull_request_review_guides VALUES (?1,?2,?3,?4)", rusqlite::params![key.host,key.repository,key.number,guide.to_string()]).unwrap();
        assert_eq!(read_stored(&db, &key).unwrap(), guide);
        let legacy = json!({"headSha":"abc","generatedAt":"legacy date","modelSelection":{"provider":"codex","model":" gpt ","options":{"reasoning":" high ","ignored":12}},"stops":[]});
        db.execute("UPDATE pull_request_review_guides SET guide_json=?1", [legacy.to_string()]).unwrap();
        let decoded = read_stored(&db, &key).unwrap();
        assert_eq!(decoded["modelSelection"], json!({"instanceId":"codex","model":"gpt","options":[{"id":"reasoning","value":"high"}]}));
        db.execute("UPDATE pull_request_review_guides SET guide_json='{}'", []).unwrap();
        assert_eq!(read_stored(&db, &key).unwrap_err()["operation"], "reviewGuide");
    }
}

#[derive(Default)]
pub(crate) struct Runs {
    entries: std::sync::Mutex<std::collections::HashMap<String, (String, Value)>>,
    claim_gate: std::sync::Mutex<()>,
}
fn run_key(key: &crate::migration_050::PullRequestKey) -> String {
    format!("{}/{}#{}", key.host, key.repository, key.number)
}
impl Runs {
    pub fn get(&self, key: &crate::migration_050::PullRequestKey) -> Value {
        self.entries.lock().unwrap().get(&run_key(key)).map(|(_, run)| run.clone()).unwrap_or(Value::Null)
    }
    fn claim(&self, key: &crate::migration_050::PullRequestKey, head: &str) -> (Value, Option<String>) {
        let mut runs = self.entries.lock().unwrap();
        let k = run_key(key);
        if let Some((_, existing)) = runs.get(&k).filter(|(_, run)| run["_tag"] == "Running" && run["headSha"] == head) {
            return (existing.clone(), None);
        }
        let run = json!({"_tag":"Running","headSha":head,"startedAt":now()});
        let owner = uuid::Uuid::new_v4().to_string();
        runs.insert(k, (owner.clone(), run.clone()));
        (run, Some(owner))
    }
    fn finish(&self, key: &crate::migration_050::PullRequestKey, owner: &str, claim: &Value, result: Result<(), String>) {
        let mut runs = self.entries.lock().unwrap();
        let k = run_key(key);
        if runs.get(&k).is_none_or(|(current, _)| current != owner) { return; }
        match result {
            Ok(()) => { runs.remove(&k); }
            Err(detail) => { runs.insert(k, (owner.to_owned(), json!({"_tag":"Failed","headSha":claim["headSha"],"failedAt":now(),"detail":detail}))); }
        }
    }
    fn claim_checked(&self, key: &crate::migration_050::PullRequestKey, head: &str, read_latest: impl FnOnce() -> Result<Value, Value>) -> Result<(Value, Option<String>), Value> {
        let _gate = self.claim_gate.lock().map_err(|_| generation_error("The review guide could not be written."))?;
        let latest = read_latest()?;
        if latest["headSha"].as_str() != Some(head) { return Err(generation_error("The pull request changed while the guide was starting. Try again.")); }
        Ok(self.claim(key, head))
    }
}
fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
fn generation_error(detail: &str) -> Value { json!({"_tag":"PullRequestOperationError","operation":"generateReviewGuide","detail":detail}) }

pub(crate) fn prepare(db: &std::sync::Mutex<Connection>, settings: &Value, input: &Value) -> Result<(crate::migration_050::PullRequestKey, String, Value, Value, Value), Value> {
    if settings["reviewGuidesEnabled"] != true {
        return Err(generation_error("Review guides are off. Turn them on in Settings → Source Control."));
    }
    let projects = { let guard = db.lock().map_err(|_| generation_error("Could not read the stored review guide."))?; crate::pull_request_routing::projects(&guard)? };
    let root = projects.iter().find(|(id, _, _)| Some(id.as_str()) == input["projectId"].as_str()).map(|(_, _, root)| root.clone()).ok_or_else(unidentified)?;
    let identity = crate::repository_identity::resolve(&root);
    let key = key(input, identity.clone()).ok_or_else(unidentified)?;
    let own = identity.as_ref().and_then(|identity| identity["canonicalKey"].as_str());
    if !own.is_some_and(|own| own.eq_ignore_ascii_case(&format!("{}/{}", key.host, key.repository))) {
        return Err(generation_error("Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository."));
    }
    let stored = { let guard = db.lock().map_err(|_| generation_error("Could not read the stored review guide."))?; read_stored(&guard, &key)? };
    let detail = crate::pull_request_detail::read(projects, input)?;
    if detail["headSha"].as_str().is_none_or(str::is_empty) { return Err(generation_error("This host did not report the pull request's head commit.")); }
    Ok((key, root, identity.unwrap(), detail, stored))
}

// Git cleanup runs on all success and failure paths, without touching the user's checkout.
struct Checkout { root: String, directory: std::path::PathBuf, checkout: std::path::PathBuf, base_ref: String }
impl Drop for Checkout {
    fn drop(&mut self) {
        if let Some(path) = self.checkout.to_str() { let _ = git_timeout(&self.root, &["worktree", "remove", "--force", path], 10); }
        let _ = git_timeout(&self.root, &["update-ref", "-d", &self.base_ref], 10);
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    Ok(git_raw_timeout(cwd, args, 300)?.trim().to_owned())
}
fn git_timeout(cwd: &str, args: &[&str], seconds: u64) -> Result<String, String> {
    Ok(git_raw_timeout(cwd, args, seconds)?.trim().to_owned())
}
fn git_raw_timeout(cwd: &str, args: &[&str], seconds: u64) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command.current_dir(cwd).args(args).stdin(std::process::Stdio::null());
    const MAX_OUTPUT: usize = 64 * 1024 * 1024;
    let output = crate::vcs_worktree::run_command_input_with_stdout_limit(&mut command, std::time::Duration::from_secs(seconds), None, MAX_OUTPUT + 1).map_err(|_| "The review guide could not be written.".to_owned())?;
    if !output.status.success() || output.stdout.len() > MAX_OUTPUT { return Err("The review guide could not be written.".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn checkout(root: String, identity: &Value, detail: &Value, worktrees: &std::path::Path) -> Result<(Checkout, String), String> {
    let sha = detail["headSha"].as_str().unwrap_or("").to_ascii_lowercase();
    if !(7..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(format!("The host reported a head for #{} that is not a commit hash.", detail["number"])); }
    let base = detail["baseBranch"].as_str().unwrap_or("");
    if base.starts_with('+') || base.contains(':') || git(&root, &["check-ref-format", "--branch", base]).is_err() { return Err("The pull request's base branch name is not one git can fetch.".into()); }
    let locator = &identity["locator"];
    let expected = locator["remoteUrl"].as_str().unwrap_or("");
    let remotes = git(&root, &["remote"])?;
    let preferred = locator["remoteName"].as_str().unwrap_or("");
    let remote = std::iter::once(preferred).chain(remotes.lines().filter(|x| *x != preferred)).find(|name| git(&root, &["remote", "get-url", "--", name]).is_ok_and(|url| url == expected)).ok_or("This project's checkout no longer has a remote for the pull request's repository.")?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::create_dir_all(worktrees).map_err(|_| "The review guide could not be written.")?;
    let dir = worktrees.join(format!("review-guide-{id}"));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(&dir).map_err(|_| "The review guide could not be written.")?;
    let worktree = dir.join("checkout");
    let guard = Checkout { root: root.clone(), directory: dir, checkout: worktree, base_ref: format!("refs/t3/review-guide/{id}/base") };
    let refspec = format!("+refs/heads/{base}:{}", guard.base_ref);
    git(&root, &["fetch", "--quiet", "--no-tags", "--", remote, &refspec])?;
    let resolve = || git(&root, &["rev-parse", "--verify", &format!("{sha}^{{commit}}")]).ok().filter(|commit| commit.starts_with(&sha));
    let mut head = resolve();
    if head.is_none() && (sha.len() == 40 || sha.len() == 64) { let _ = git(&root, &["fetch", "--quiet", "--no-tags", "--", remote, &sha]); head = resolve(); }
    if head.is_none() {
        let branch = detail["headBranch"].as_str().unwrap_or("");
        let head_ref = format!("refs/heads/{branch}");
        if git(&root, &["check-ref-format", &head_ref]).is_ok() { let _ = git(&root, &["fetch", "--quiet", "--no-tags", "--", remote, &head_ref]); head = resolve(); }
    }
    if head.is_none() {
        let number = detail["number"].as_i64().unwrap_or(0);
        let host_ref = match detail["provider"].as_str() {
            Some("github" | "forgejo" | "gitea") => Some(format!("refs/pull/{number}/head")),
            Some("gitlab") => Some(format!("refs/merge-requests/{number}/head")),
            _ => None,
        };
        if let Some(host_ref) = host_ref { let _ = git(&root, &["fetch", "--quiet", "--no-tags", "--", remote, &host_ref]); head = resolve(); }
    }
    let head = head.ok_or_else(|| format!("Could not find head {sha} of #{}.", detail["number"]))?;
    let path = guard.checkout.to_str().ok_or("The review guide could not be written.")?;
    git(&root, &["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", path, &head])?;
    let merge_base = git(path, &["merge-base", &guard.base_ref, "HEAD"])?;
    Ok((guard, merge_base))
}

fn resolve_stack_layers(root: &str, identity: &Value, detail: &Value, stack: &Value) -> Value {
    let Some(layers) = stack["layers"].as_array() else { return Value::Null };
    let remote_url = identity["locator"]["remoteUrl"].as_str().unwrap_or("");
    let preferred = identity["locator"]["remoteName"].as_str().unwrap_or("");
    let remotes = git(root, &["remote"]).unwrap_or_default();
    let remote = std::iter::once(preferred).chain(remotes.lines().filter(|v| *v != preferred)).find(|name| git(root, &["remote", "get-url", "--", name]).is_ok_and(|url| url == remote_url));
    let mut result = Vec::new();
    for layer in layers {
        let head = if layer["number"] == detail["number"] { detail["headSha"].clone() } else {
            let sha = layer["headSha"].as_str().unwrap_or("").to_ascii_lowercase();
            if !(7..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) { Value::Null } else {
                let resolve = || git(root, &["rev-parse", "--verify", &format!("{sha}^{{commit}}")]).ok().filter(|commit| commit.starts_with(&sha));
                let mut commit = resolve();
                if commit.is_none() && (sha.len() == 40 || sha.len() == 64) { if let Some(remote) = remote { let _ = git(root, &["fetch", "--quiet", "--no-tags", "--", remote, &sha]); commit = resolve(); } }
                if commit.is_none() {
                    let branch = format!("refs/heads/{}", layer["headBranch"].as_str().unwrap_or(""));
                    if let Some(remote) = remote { if git(root, &["check-ref-format", &branch]).is_ok() { let _ = git(root, &["fetch", "--quiet", "--no-tags", "--", remote, &branch]); commit = resolve(); } }
                }
                if commit.is_none() {
                    let number = layer["number"].as_i64().unwrap_or(0);
                    let host_ref = match detail["provider"].as_str() { Some("github" | "forgejo" | "gitea") => Some(format!("refs/pull/{number}/head")), Some("gitlab") => Some(format!("refs/merge-requests/{number}/head")), _ => None };
                    if let (Some(remote), Some(host_ref)) = (remote, host_ref) { let _ = git(root, &["fetch", "--quiet", "--no-tags", "--", remote, &host_ref]); commit = resolve(); }
                }
                commit.map_or(Value::Null, |v| json!(v))
            }
        };
        result.push(json!({"number":layer["number"],"title":layer["title"],"state":layer["state"],"headSha":head}));
    }
    Value::Array(result)
}

struct GuideWork {
    root: String,
    identity: Value,
    detail: Value,
    settings: Value,
    providers: Option<Vec<Value>>,
    settings_path: std::path::PathBuf,
    worktrees: std::path::PathBuf,
    input: Value,
    activity: Value,
    stack: Value,
}

async fn write_guide(work: GuideWork) -> Result<Value, String> {
    let GuideWork { root, identity, detail, settings, providers, settings_path, worktrees, input, activity, stack } = work;
    let project = input["projectId"].as_str().unwrap_or("");
    let overrides = &settings["projectSettingsOverrides"][project];
    let plan = crate::review_guide_model::plan(&settings, project, providers.as_deref(), chrono::Utc::now().timestamp_millis()).ok_or("Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control.")?;
    let selection = plan.execution;
    let instance = selection["instanceId"].as_str().ok_or("The review guide could not be written.")?;
    let model = selection["model"].as_str().ok_or("The review guide could not be written.")?;
    let driver = settings["providerInstances"][instance]["driver"].as_str().unwrap_or(instance);
    crate::managed_policy::check_provider_allowed(driver)?;
    let checkout_root = root.clone(); let checkout_identity = identity.clone(); let checkout_detail = detail.clone();
    let (guard, base, stack_layers) = tokio::task::spawn_blocking(move || {
        let (guard, base) = checkout(checkout_root.clone(), &checkout_identity, &checkout_detail, &worktrees)?;
        let stack_layers = resolve_stack_layers(&checkout_root, &checkout_identity, &checkout_detail, &stack);
        Ok::<_, String>((guard, base, stack_layers))
    }).await.map_err(|_| "The review guide could not be written.")??;
    let cwd = guard.checkout.to_str().ok_or("The review guide could not be written.")?;
    let instructions = overrides["reviewGuideInstructions"].as_str().or_else(|| settings["reviewGuideInstructions"].as_str()).unwrap_or("");
    let prompt = crate::review_guide_prompt::build(&detail, &base, &activity, &stack_layers, instructions);
    let schema = json!({"type":"object","additionalProperties":false,"required":["stops"],"properties":{"stops":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["title","summary","attention","excerpts","files","notes","questions"],"properties":{"title":{"type":"string"},"summary":{"type":"string"},"attention":{"anyOf":[{"type":"null"},{"type":"object","additionalProperties":false,"required":["kind","note"],"properties":{"kind":{"type":"string","enum":["tradeoff","contract","product","risk","accessibility"]},"note":{"type":"string"}}}]},"excerpts":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["path","side","start","end","caption"],"properties":{"path":{"type":"string"},"side":{"type":"string","enum":["new","old"]},"start":{"type":"integer"},"end":{"type":"integer"},"caption":{"type":"string"}}}},"files":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["path","note"],"properties":{"path":{"type":"string"},"note":{"type":"string"}}}},"notes":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["path","line","title","body"],"properties":{"path":{"type":"string"},"line":{"type":"integer"},"title":{"type":"string"},"body":{"type":"string"}}}},"questions":{"type":"array","items":{"type":"string"}}}}}}}).to_string();
    let raw = match driver {
        "codex" => {
            let launch = crate::provider::instance::resolve_codex_launch(Some(&settings_path), instance, crate::provider::CodexLaunch::default())?;
            crate::thread_title::run_codex_structured(cwd, model, &prompt, &[], &launch, &selection, &schema).await?
        }
        "claudeAgent" => crate::review_guide_claude::generate(std::path::Path::new(cwd), &prompt, &schema, &selection, &settings).await?,
        _ => return Err("Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control.".into()),
    };
    let result: Value = serde_json::from_str(&raw).map_err(|_| "The review guide could not be written.")?;
    let changed = git_raw_timeout(cwd, &["diff", "--name-only", "-z", &format!("{base}...HEAD")], 300)?;
    let paths: Vec<&str> = changed.split('\0').filter(|s| !s.is_empty()).collect();
    let patch = git(cwd, &["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", &format!("{base}...HEAD")])?;
    let stops = normalize_stops(&result, &paths, &patch)?;
    let guide = json!({"headSha":detail["headSha"],"generatedAt":now(),"modelSelection":plan.recorded,"stops":stops});
    // Decode through the same schema as reads before persisting provider output.
    let validation = Connection::open_in_memory().map_err(|_| "The review guide could not be written.")?;
    validation.execute_batch(include_str!("../migrations/061.sql")).map_err(|_| "The review guide could not be written.")?;
    let validation_key = crate::migration_050::normalize_key("local", "validation", 1);
    validation.execute("INSERT INTO pull_request_review_guides VALUES ('local','validation',1,?1)", [guide.to_string()]).map_err(|_| "The review guide could not be written.")?;
    read_stored(&validation, &validation_key).map_err(|_| "The review guide could not be written.".to_owned())
}

pub(crate) struct ProviderReadiness {
    pub sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    pub cache: std::sync::Arc<std::sync::Mutex<Option<Vec<Value>>>>,
    pub cwd: String,
}
pub(crate) async fn generate(runs: std::sync::Arc<Runs>, auth: std::sync::Arc<crate::auth_http::AuthHttpState>, settings: std::sync::Arc<crate::settings::Settings>, readiness: ProviderReadiness, worktrees: std::path::PathBuf, input: Value) -> Result<Value, Value> {
    let snapshot = settings.private_snapshot();
    let worker_auth = auth.clone(); let worker_input = input.clone(); let worker_snapshot = snapshot.clone(); let worker_runs = runs.clone();
    let (key, root, identity, detail, stored, run, owner) = tokio::task::spawn_blocking(move || -> Result<_, Value> {
        let (key, root, identity, detail, stored) = prepare(&worker_auth.db, &worker_snapshot, &worker_input)?;
        let head = detail["headSha"].as_str().unwrap();
        let (run, owner) = worker_runs.claim_checked(&key, head, || {
            let projects = { let db = worker_auth.db.lock().map_err(|_| generation_error("The review guide could not be written."))?; crate::pull_request_routing::projects(&db)? };
            crate::pull_request_detail::read(projects, &worker_input)
        })?;
        Ok((key, root, identity, detail, stored, run, owner))
    }).await.map_err(|_| generation_error("The review guide could not be written."))??;
    let head = detail["headSha"].as_str().unwrap().to_owned();
    if let Some(owner) = owner {
        let response_run = run.clone(); let settings_path = settings.path().to_owned();
        tokio::spawn(async move {
            let refresh_ms = crate::background_activity::ClientActivity::provider_refresh_interval(&snapshot);
            let force = refresh_ms > 0 && readiness.sessions.last_provider_refresh.lock().map(|last| last.get("*").is_none_or(|at| at.elapsed() >= std::time::Duration::from_millis(refresh_ms))).unwrap_or(false);
            let providers = crate::application::discover_providers(&readiness.cwd, &settings_path, &readiness.sessions, &readiness.cache, force, false).await.ok().or_else(|| readiness.cache.lock().ok().and_then(|cache| cache.clone()));
            let context_auth = auth.clone(); let context_input = input.clone();
            let context = tokio::task::spawn_blocking(move || {
                let projects = { let db = context_auth.db.lock().map_err(|_| "The review guide could not be written.".to_owned())?; crate::pull_request_routing::projects(&db).map_err(|_| "The review guide could not be written.".to_owned())? };
                let activity = crate::pull_request_activity::read(projects.clone(), &context_input).map_err(|e| e["detail"].as_str().unwrap_or("The review guide could not be written.").to_owned())?;
                let stack = crate::pull_request_stack::read(projects, &context_input).unwrap_or(Value::Null);
                Ok::<_, String>((activity, stack))
            }).await.map_err(|_| "The review guide could not be written.".to_owned()).and_then(|v| v);
            let result = match context { Ok((activity, stack)) => write_guide(GuideWork { root, identity, detail, settings: snapshot, providers, settings_path, worktrees, input, activity, stack }).await, Err(e) => Err(e) }.and_then(|guide| {
                let guard = runs.entries.lock().map_err(|_| "The review guide could not be written.".to_owned())?;
                if guard.get(&run_key(&key)).is_none_or(|(current, _)| current != &owner) { return Ok(()); }
                let db = auth.db.lock().map_err(|_| "The review guide could not be written.".to_owned())?;
                db.execute("INSERT INTO pull_request_review_guides(host,repository,number,guide_json) VALUES (?1,?2,?3,?4) ON CONFLICT(host,repository,number) DO UPDATE SET guide_json=excluded.guide_json", rusqlite::params![key.host,key.repository,key.number,guide.to_string()]).map_err(|_| "The review guide could not be written.".to_owned())?;
                Ok(())
            });
            runs.finish(&key, &owner, &run, result);
        });
        return Ok(json!({"guide":stored,"run":response_run,"currentHeadSha":head}));
    }
    Ok(json!({"guide":stored,"run":run,"currentHeadSha":head}))
}

fn patch_header_path(line: &str, prefix: &str) -> Option<String> {
    let token = line.get(4..)?.split('\t').next()?;
    let decoded = if let Some(body) = token.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        let bytes = body.as_bytes(); let mut out = Vec::new(); let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'\\' { out.push(bytes[i]); i += 1; continue; }
            i += 1;
            if i == bytes.len() { out.push(b'\\'); break; }
            if i + 2 < bytes.len() && bytes[i..i+3].iter().all(|b| (b'0'..=b'7').contains(b)) {
                out.push(((bytes[i]-b'0') as u16 * 64 + (bytes[i+1]-b'0') as u16 * 8 + (bytes[i+2]-b'0') as u16) as u8); i += 3; continue;
            }
            out.push(match bytes[i] { b'a'=>7,b'b'=>8,b't'=>9,b'n'=>10,b'v'=>11,b'f'=>12,b'r'=>13,other=>other }); i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    } else { token.to_owned() };
    decoded.strip_prefix(prefix).map(str::to_owned)
}

fn normalize_stops(result: &Value, changed: &[&str], patch: &str) -> Result<Vec<Value>, String> {
    use std::collections::{HashMap, HashSet};
    let mut hunks: HashMap<(String, &'static str), Vec<(i64, i64)>> = HashMap::new();
    let header = regex::Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap();
    let mut old: Option<String> = None;
    let mut path: Option<String> = None;
    let mut in_hunks = false;
    for line in patch.lines() {
        if line.starts_with("diff --git ") { old = None; path = None; in_hunks = false; }
        else if !in_hunks && line.starts_with("--- ") { old = patch_header_path(line, "a/"); }
        else if !in_hunks && line.starts_with("+++ ") { path = patch_header_path(line, "b/").or_else(|| old.clone()); }
        else if let (Some(path), Some(c)) = (&path, header.captures(line)) {
            in_hunks = true;
            for (side, start, count) in [("old", 1, 2), ("new", 3, 4)] {
                let start = c[start].parse::<i64>().unwrap_or(0);
                let count = c.get(count).map(|v| v.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(1);
                if count > 0 { hunks.entry((path.clone(), side)).or_default().push((start, start + count - 1)); }
            }
        }
    }
    let mut stops = result["stops"].as_array().cloned().ok_or("The review guide could not be written.")?;
    stops.retain(|s| s["title"].as_str().is_some_and(|s| !s.trim().is_empty()));
    let mut excerpt_paths = HashSet::new();
    for stop in &mut stops {
        let excerpts = stop["excerpts"].as_array_mut().ok_or("The review guide could not be written.")?;
        excerpts.retain_mut(|excerpt| {
            let Some(path) = excerpt["path"].as_str() else { return false };
            let side = match excerpt["side"].as_str() { Some("new") => "new", Some("old") => "old", _ => return false };
            if !changed.contains(&path) { return false; }
            let (Some(a),Some(b)) = (excerpt["start"].as_i64(), excerpt["end"].as_i64()) else { return false };
            let (start,end) = (a.min(b),a.max(b));
            let Some(ranges) = hunks.get(&(path.to_owned(),side)) else { return false };
            let overlap: Vec<_> = ranges.iter().filter(|(a,b)| *a <= end && start <= *b).collect();
            if overlap.is_empty() { return false; }
            let start = start.max(overlap.first().unwrap().0);
            let end = end.min(overlap.last().unwrap().1);
            excerpt_paths.insert(path.to_owned());
            excerpt["start"] = json!(start); excerpt["end"] = json!(end); true
        });
        // Match the original's transitive merging before clamping each merged range to 25 lines.
        let mut merged: Vec<Value> = Vec::new();
        for excerpt in std::mem::take(excerpts) {
            let start = excerpt["start"].as_i64().unwrap(); let end = excerpt["end"].as_i64().unwrap();
            let touches = |other: &Value| other["path"] == excerpt["path"] && other["side"] == excerpt["side"] && other["start"].as_i64().unwrap() <= end.saturating_add(1) && start <= other["end"].as_i64().unwrap().saturating_add(1);
            let group: Vec<_> = merged.iter().enumerate().filter(|(_, item)| touches(item)).map(|(i,_)| i).collect();
            if group.is_empty() { merged.push(excerpt); continue; }
            let mut combined = merged[group[0]].clone();
            combined["start"] = json!(group.iter().map(|i| merged[*i]["start"].as_i64().unwrap()).chain([start]).min().unwrap());
            combined["end"] = json!(group.iter().map(|i| merged[*i]["end"].as_i64().unwrap()).chain([end]).max().unwrap());
            combined["caption"] = group.iter().filter_map(|i| merged[*i]["caption"].as_str().filter(|s| !s.is_empty())).next().map(|s| json!(s)).unwrap_or_else(|| excerpt["caption"].clone());
            let first = group[0];
            for index in group.into_iter().rev() { merged.remove(index); }
            merged.insert(first, combined);
        }
        for excerpt in &mut merged { let start = excerpt["start"].as_i64().unwrap(); let end = excerpt["end"].as_i64().unwrap(); excerpt["end"] = json!(end.min(start.saturating_add(24))); }
        *excerpts = merged;
        let excerpts = excerpts.clone();
        let notes = stop["notes"].as_array_mut().ok_or("The review guide could not be written.")?;
        notes.retain(|note| note["title"].as_str().is_some_and(|s| !s.trim().is_empty()) && excerpts.iter().any(|ex| ex["path"] == note["path"] && note["line"].as_i64().is_some_and(|line| ex["start"].as_i64().unwrap_or(0) <= line && line <= ex["end"].as_i64().unwrap_or(0))));
        stop["questions"].as_array_mut().ok_or("The review guide could not be written.")?.retain(|q| q.as_str().is_some_and(|s| !s.trim().is_empty()));
        if stop["attention"].is_object() && stop["attention"]["note"].as_str().is_none_or(|s| s.trim().is_empty()) { stop["attention"] = Value::Null; }
    }
    let mut placed = excerpt_paths;
    for stop in &mut stops {
        let files = stop["files"].as_array_mut().ok_or("The review guide could not be written.")?;
        files.retain(|file| file["path"].as_str().is_some_and(|p| changed.contains(&p) && placed.insert(p.to_owned())));
        for file in files { if file["note"].as_str().is_some_and(|note| note.trim().is_empty()) { file.as_object_mut().map(|v| v.remove("note")); } }
    }
    let missing: Vec<_> = changed.iter().filter(|p| !placed.contains(**p)).copied().collect();
    if !missing.is_empty() { stops.push(json!({"title":"Other files","summary":"Changed files the tour does not otherwise cover.","attention":null,"excerpts":[],"files":missing.into_iter().map(|path| json!({"path":path})).collect::<Vec<_>>(),"notes":[],"questions":[]})); }
    Ok(stops)
}

#[cfg(test)]
mod generation_tests {
    use super::*;
    #[test]
    fn feature_gate_precedes_repository_access() {
        let db = std::sync::Mutex::new(Connection::open_in_memory().unwrap());
        let error = prepare(&db, &json!({"reviewGuidesEnabled":false}), &json!({})).unwrap_err();
        assert_eq!(error["operation"], "generateReviewGuide");
        assert_eq!(error["detail"], "Review guides are off. Turn them on in Settings → Source Control.");
    }
    #[test]
    fn run_claims_join_head_and_old_owner_cannot_finish_new_run() {
        let runs = Runs::default(); let key = crate::migration_050::normalize_key("github.com", "owner/repo", 4);
        let (first, owner1) = runs.claim(&key,"aaaaaaa"); let owner1 = owner1.unwrap();
        let (joined, owner2) = runs.claim(&key,"aaaaaaa"); assert_eq!(first,joined); assert!(owner2.is_none());
        let (second, owner2) = runs.claim(&key,"bbbbbbb"); let owner2 = owner2.unwrap();
        runs.finish(&key,&owner1,&first,Ok(())); assert_eq!(runs.get(&key),second);
        runs.finish(&key,&owner2,&second,Err("failed".into())); assert_eq!(runs.get(&key)["_tag"],"Failed");
        let (third, owner3) = runs.claim(&key,"bbbbbbb"); runs.finish(&key,&owner3.unwrap(),&third,Ok(())); assert!(runs.get(&key).is_null());
    }
    #[test]
    fn stale_head_cannot_claim_after_newer_head() {
        let runs = Runs::default();
        let key = crate::migration_050::normalize_key("github.com", "owner/repo", 4);
        let (new_run, _) = runs.claim_checked(&key, "bbbbbbb", || Ok(json!({"headSha":"bbbbbbb"}))).unwrap();
        let stale = runs.claim_checked(&key, "aaaaaaa", || Ok(json!({"headSha":"bbbbbbb"}))).unwrap_err();
        assert_eq!(stale["detail"], "The pull request changed while the guide was starting. Try again.");
        assert_eq!(runs.get(&key), new_run);
    }
    #[test]
    fn normalization_clamps_to_hunks_and_accounts_for_files() {
        let paths: Vec<_> = ["src/a.rs", "src/b.rs"].into_iter().collect();
        let patch = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +5,3 @@\n";
        let result = json!({"stops":[{"title":"Change","summary":"summary","attention":null,"excerpts":[{"path":"src/a.rs","side":"new","start":1,"end":30,"caption":""},{"path":"unrelated","side":"new","start":1,"end":2,"caption":""}],"files":[],"notes":[{"path":"src/a.rs","line":6,"title":"note","body":"body"},{"path":"src/a.rs","line":20,"title":"bad","body":""}],"questions":["", "why?"]}]});
        let stops = normalize_stops(&result,&paths,patch).unwrap();
        assert_eq!(stops[0]["excerpts"][0]["start"],5); assert_eq!(stops[0]["excerpts"][0]["end"],7);
        assert_eq!(stops[0]["excerpts"].as_array().unwrap().len(),1); assert_eq!(stops[0]["notes"].as_array().unwrap().len(),1);
        assert_eq!(stops[1]["files"][0]["path"],"src/b.rs");
    }
    #[test]
    fn normalizes_quoted_paths_and_merges_overlapping_excerpts() {
        let paths = vec!["tab\tfile.rs", "last.rs", "first.rs"];
        let patch = "diff --git \"a/tab\\tfile.rs\" \"b/tab\\tfile.rs\"\n--- \"a/tab\\tfile.rs\"\n+++ \"b/tab\\tfile.rs\"\n@@ -1,4 +5,40 @@\n";
        let result = json!({"stops":[{"title":"Change","summary":"","attention":null,"excerpts":[{"path":"tab\tfile.rs","side":"new","start":5,"end":9,"caption":""},{"path":"tab\tfile.rs","side":"new","start":10,"end":35,"caption":"caption"}],"files":[],"notes":[{"path":"tab\tfile.rs","line":28,"title":"within cap","body":""},{"path":"tab\tfile.rs","line":31,"title":"outside cap","body":""}],"questions":[]}]});
        let stops = normalize_stops(&result, &paths, patch).unwrap();
        assert_eq!(stops[0]["excerpts"], json!([{"path":"tab\tfile.rs","side":"new","start":5,"end":29,"caption":"caption"}]));
        assert_eq!(stops[0]["notes"].as_array().unwrap().len(), 1);
        assert_eq!(stops[1]["files"], json!([{"path":"last.rs"},{"path":"first.rs"}]));
        assert_eq!(patch_header_path("+++ \"b/\\303\\251\\tfile\"", "b/").as_deref(), Some("é\tfile"));
    }
    #[test]
    fn diff_path_list_preserves_leading_whitespace() {
        let temp = std::env::temp_dir().join(format!("review-guide-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&temp).unwrap();
        let root = temp.to_str().unwrap();
        git(root, &["init"]).unwrap();
        git(root, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(root, &["config", "user.name", "Test"]).unwrap();
        git(root, &["commit", "--allow-empty", "-m", "base"]).unwrap();
        std::fs::write(temp.join(" leading"), "one\n").unwrap();
        git(root, &["add", "--", " leading"]).unwrap();
        git(root, &["commit", "-m", "change"]).unwrap();
        let paths = git_raw_timeout(root, &["diff", "--name-only", "-z", "HEAD^...HEAD"], 10).unwrap();
        assert_eq!(paths, " leading\0");
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn detached_checkout_is_private_and_removed() {
        let temp = std::env::temp_dir().join(format!("review-guide-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&temp).unwrap();
        let root = temp.join("repo"); std::fs::create_dir(&root).unwrap();
        let root = root.to_str().unwrap();
        git(root, &["init", "-b", "main"]).unwrap();
        git(root, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(root, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(std::path::Path::new(root).join("file"), "one\n").unwrap();
        git(root, &["add", "file"]).unwrap(); git(root, &["commit", "-m", "fixture"]).unwrap();
        let head = git(root, &["rev-parse", "HEAD"]).unwrap();
        git(root, &["remote", "add", "origin", root]).unwrap();
        let (guard, base) = checkout(root.into(), &json!({"locator":{"remoteName":"origin","remoteUrl":root}}), &json!({"number":1,"headSha":head,"baseBranch":"main","headBranch":"main","provider":"github"}), &temp.join("worktrees")).unwrap();
        assert_eq!(base, head);
        assert!(guard.checkout.join("file").exists());
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&guard.directory).unwrap().permissions().mode() & 0o777, 0o700); }
        let path = guard.checkout.clone(); drop(guard); assert!(!path.exists());
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn claude_generation_reads_scratch_and_produces_a_valid_guide() {
        use std::os::unix::fs::PermissionsExt;
        let temp = std::env::temp_dir().join(format!("guide-claude-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&temp).unwrap();
        let repo = temp.join("repo"); std::fs::create_dir(&repo).unwrap(); let root = repo.to_str().unwrap();
        git(root, &["init", "-b", "main"]).unwrap(); git(root, &["config", "user.email", "test@example.invalid"]).unwrap(); git(root, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(repo.join("file"), "one\n").unwrap(); git(root, &["add", "file"]).unwrap(); git(root, &["commit", "-m", "base"]).unwrap();
        git(root, &["checkout", "-b", "feature"]).unwrap(); std::fs::write(repo.join("file"), "one\ntwo\n").unwrap(); git(root, &["add", "file"]).unwrap(); git(root, &["commit", "-m", "change"]).unwrap();
        let head = git(root, &["rev-parse", "HEAD"]).unwrap(); git(root, &["remote", "add", "origin", root]).unwrap();
        let binary = temp.join("claude"); std::fs::write(&binary, "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"result\",\"structured_output\":{\"stops\":[]}}'\n").unwrap(); std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = json!({"reviewGuideModelSelection":{"instanceId":"claudeAgent","model":"claude-test"},"providerInstances":{"claudeAgent":{"driver":"claudeAgent","config":{"binaryPath":binary}}}});
        let detail = json!({"number":1,"headSha":head,"baseBranch":"main","headBranch":"feature","provider":"github","title":"Fixture","body":""});
        let worktrees = temp.join("worktrees");
        let guide = write_guide(GuideWork { root: root.into(), identity: json!({"locator":{"remoteName":"origin","remoteUrl":root}}), detail, settings, providers: None, settings_path: temp.join("settings.json"), worktrees: worktrees.clone(), input: json!({"projectId":"p"}), activity: Value::Null, stack: Value::Null }).await.unwrap();
        assert_eq!(guide["headSha"], head); assert_eq!(guide["modelSelection"]["instanceId"], "claudeAgent");
        assert_eq!(guide["stops"][0]["files"][0]["path"], "file");
        assert_eq!(std::fs::read_dir(worktrees).unwrap().count(), 0);
        std::fs::remove_dir_all(temp).unwrap();
    }
}
