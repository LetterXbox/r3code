//! Bounded discovery of native Codex, Claude and Pi project candidates.
//! Native transcript import and some source-specific discovery rules remain separate work.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn normalize_project_path(value: &str) -> String {
    let value = value.trim();
    let windows = value.starts_with("\\\\")
        || (value.len() >= 2
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && (value.len() == 2 || matches!(value.as_bytes()[2], b'/' | b'\\')));
    let trimmed = if value == "/" || value == "\\" {
        value
    } else if value.starts_with('/') {
        value.trim_end_matches('/')
    } else {
        value.trim_end_matches(['/', '\\'])
    };
    let trimmed = if trimmed.is_empty() { value } else { trimmed };
    let normalized = if windows {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed.to_owned()
    };
    if windows && normalized.len() == 2 && normalized.ends_with(':') {
        format!("{normalized}\\")
    } else {
        normalized
    }
}

pub fn scan(db: &rusqlite::Connection, settings: &Value) -> Result<Value, String> {
    let homes = source_homes(settings);
    let mut projects = BTreeMap::new();
    let mut stmt = db
        .prepare(
            "SELECT project_id,workspace_root FROM projection_projects WHERE deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    for row in stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (id, path) = row.map_err(|e| e.to_string())?;
        let key = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
        projects.insert(key, (id, path));
    }
    type Candidate<'a> = (u64, Option<SystemTime>, Vec<&'a str>, Value);
    let mut merged: BTreeMap<PathBuf, Candidate<'_>> = BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut budget = 20_000usize;
    let mut truncated = false;
    for (source, _instance, home) in homes {
        let identity = fs::canonicalize(&home).unwrap_or(home.clone());
        if !seen.insert((source, identity)) {
            continue;
        }
        let mut dirs = vec![(home, 0usize)];
        let mut files = 0usize;
        while let Some((dir, depth)) = dirs.pop() {
            if budget == 0 {
                truncated = true;
                break;
            }
            budget -= 1;
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries.into_iter().rev() {
                if budget == 0 {
                    truncated = true;
                    break;
                }
                budget -= 1;
                let Ok(kind) = e.file_type() else { continue };
                let max_depth = if source == "codex" { 3 } else { 1 };
                if kind.is_dir() && depth < max_depth {
                    dirs.push((e.path(), depth + 1));
                    continue;
                }
                let name = e.file_name();
                let name = name.to_string_lossy();
                if !kind.is_file()
                    || (source == "codex" && (depth != 3 || !name.starts_with("rollout-")))
                    || (source == "claudeAgent" && depth != 1)
                    || !(name.ends_with(".jsonl")
                        || (source == "codex" && name.ends_with(".jsonl.zst")))
                {
                    continue;
                }
                files += 1;
                if files > 5000 {
                    truncated = true;
                    break;
                }
                let Ok(metadata) = e.metadata() else { continue };
                let Ok(file) = fs::File::open(e.path()) else {
                    continue;
                };
                let mut cwd = None;
                let reader: Box<dyn Read> = if name.ends_with(".zst") {
                    match zstd::stream::read::Decoder::new(file) {
                        Ok(decoder) => Box::new(decoder),
                        Err(_) => continue,
                    }
                } else {
                    Box::new(file)
                };
                for line in BufReader::new(reader.take(1024 * 1024))
                    .lines()
                    .take(1000)
                    .map_while(Result::ok)
                {
                    let Ok(record) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if source == "codex"
                        && record["type"] == "session_meta"
                        && (record["payload"]["source"].get("subagent").is_some()
                            || record["payload"]["source"].get("subAgent").is_some())
                    {
                        break;
                    }
                    let value = record
                        .get("cwd")
                        .or_else(|| record["payload"].get("cwd"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let Some(value) = value {
                        cwd = Some(PathBuf::from(value));
                        break;
                    }
                }
                let Some(path) = cwd.filter(|p| p.is_absolute() && p.is_dir()) else {
                    continue;
                };
                let Ok(path) = fs::canonicalize(path) else {
                    continue;
                };
                if excluded_project(&path) {
                    continue;
                }
                let (path, git) = project_directory(path);
                let modified = metadata.modified().ok();
                let item = merged.entry(path).or_insert((0, None, Vec::new(), git));
                if !item.2.contains(&source) {
                    item.2.push(source);
                }
                item.0 += 1;
                item.1 = match (item.1, modified) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
            }
        }
    }
    let mut candidates:Vec<Value>=merged.into_iter().map(|(path,(count,modified,sources,git))| {
        let project=projects.get(&path); let display=project.map_or_else(||path.to_string_lossy().into_owned(),|v|v.1.clone());
        let mut candidate=json!({"path":display,"title":Path::new(&display).file_name().map(|v|v.to_string_lossy().into_owned()).unwrap_or_else(||display.clone()),"sources":sources,"threadCount":count,"lastActiveAt":modified.map(|t|chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)),"alreadyImported":project.is_some(),"git":git});
        if let Some((id,_))=project {candidate["projectId"]=json!(id);}
        candidate
    }).collect();
    candidates.sort_by(|a, b| {
        b["lastActiveAt"]
            .as_str()
            .cmp(&a["lastActiveAt"].as_str())
            .then_with(|| a["path"].as_str().cmp(&b["path"].as_str()))
    });
    let mut result = json!({"candidates":candidates,"scannedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
    if truncated {
        result["truncated"] = json!(true);
    }
    Ok(result)
}
pub(crate) fn source_homes(settings: &Value) -> Vec<(&'static str, String, PathBuf)> {
    let mut homes: Vec<(&str, String, PathBuf)> = Vec::new();
    let instances = settings["providerInstances"].as_object();
    for source in ["claudeAgent", "codex", "pi"] {
        let mut entries: Vec<(String, Value)> = instances
            .into_iter()
            .flat_map(|v| v.iter())
            .filter(|(_, v)| {
                v["driver"] == source
                    && v["enabled"] != false
                    && v["config"]["enabled"] != false
                    && (source != "pi" || v["enabled"] == true || v["config"]["enabled"] == true)
            })
            .map(|(id, v)| (id.clone(), v.clone()))
            .collect();
        if source != "pi" && instances.is_none_or(|v| !v.contains_key(source)) {
            entries.push((source.to_owned(), json!({"driver":source})));
        }
        for (instance, entry) in entries {
            let vars = entry["environment"].as_array();
            let env = |key: &str| {
                vars.and_then(|v| v.iter().rev().find(|x| x["name"] == key))
                    .and_then(|v| v["value"].as_str())
                    .map(str::to_owned)
                    .or_else(|| std::env::var(key).ok())
                    .filter(|v| !v.trim().is_empty())
            };
            let configured = entry
                .pointer("/config/homePath")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty());
            let host_home = std::env::var_os("HOME").map(PathBuf::from);
            let dir = match source {
                "codex" => configured
                    .map(PathBuf::from)
                    .or_else(|| env("CODEX_HOME").map(PathBuf::from))
                    .or_else(|| host_home.map(|h| h.join(".codex")))
                    .map(|p| p.join("sessions")),
                "claudeAgent" => configured
                    .map(PathBuf::from)
                    .or_else(|| env("CLAUDE_CONFIG_DIR").map(PathBuf::from))
                    .or_else(|| host_home.map(|h| h.join(".claude")))
                    .map(|p| p.join("projects")),
                _ => env("PI_CODING_AGENT_SESSION_DIR")
                    .map(PathBuf::from)
                    .or_else(|| {
                        env("PI_CODING_AGENT_DIR").map(|p| PathBuf::from(p).join("sessions"))
                    })
                    .or_else(|| host_home.map(|h| h.join(".pi/agent/sessions"))),
            };
            if let Some(dir) = dir {
                homes.push((source, instance, dir));
            }
        }
    }
    homes
}

fn excluded_project(path: &Path) -> bool {
    if path == Path::new("/tmp")
        || path == Path::new("/private/tmp")
        || path == std::env::temp_dir()
    {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let home = fs::canonicalize(&home).unwrap_or(home);
        if path == home
            || path.starts_with(home.join("Downloads"))
            || path.starts_with(home.join("Documents/Codex"))
        {
            return true;
        }
    }
    false
}

pub(crate) fn project_directory(mut path: PathBuf) -> (PathBuf, Value) {
    let marker = path.join(".git");
    if !marker.exists() {
        return (path, Value::Null);
    }
    if marker.is_file() {
        if let Ok(content) = fs::read_to_string(&marker) {
            if let Some(dir) = content.trim().strip_prefix("gitdir: ") {
                let gitdir = if Path::new(dir).is_absolute() {
                    PathBuf::from(dir)
                } else {
                    path.join(dir)
                };
                if let Ok(common) = fs::read_to_string(gitdir.join("commondir")) {
                    if let Ok(common) = fs::canonicalize(gitdir.join(common.trim())) {
                        if common.file_name().is_some_and(|v| v == ".git") {
                            if let Some(parent) = common.parent() {
                                path = parent.to_path_buf();
                            }
                        }
                    }
                }
            }
        }
    }
    let identity = crate::repository_identity::resolve(&path.to_string_lossy());
    let git = json!({"remoteKey":identity.as_ref().and_then(|v|v["canonicalKey"].as_str()),"repository":identity.as_ref().and_then(|v|v["displayName"].as_str())});
    (path, git)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_codex_projects_and_matches_imported_directory() {
        let root = std::env::temp_dir().join(format!("t3-scan-{}", uuid::Uuid::new_v4()));
        let home = root.join("codex");
        let day = home.join("sessions/2026/11/14");
        let project = root.join("project");
        fs::create_dir_all(&day).unwrap();
        fs::create_dir_all(&project).unwrap();
        let record = json!({"type":"session_meta","payload":{"id":"session","cwd":project}});
        fs::write(day.join("rollout-1.jsonl"), format!("{record}\n")).unwrap();
        fs::write(day.join("rollout-2.jsonl"), format!("{record}\n")).unwrap();
        let compressed = zstd::stream::encode_all(format!("{record}\n").as_bytes(), 0).unwrap();
        fs::write(day.join("rollout-3.jsonl.zst"), compressed).unwrap();
        fs::write(
            day.join("rollout-sub.jsonl"),
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"cwd":project,"source":{"subagent":{}}}})
            ),
        )
        .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)",
        )
        .unwrap();
        db.execute(
            "INSERT INTO projection_projects VALUES('p',?1,NULL)",
            [project.to_string_lossy().as_ref()],
        )
        .unwrap();
        let result = scan(
            &db,
            &json!({"providerInstances":{"codex":{"driver":"codex","config":{"homePath":home}},"claudeAgent":{"driver":"claudeAgent","enabled":false},"pi":{"driver":"pi","enabled":false}}}),
        )
        .unwrap();
        assert_eq!(result["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(result["candidates"][0]["threadCount"], 3);
        assert_eq!(result["candidates"][0]["projectId"], "p");
        assert_eq!(result["candidates"][0]["alreadyImported"], true);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn discovers_multiple_native_sources_and_git_project() {
        let root = std::env::temp_dir().join(format!("t3-scan-multi-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let claude = root.join("claude/projects/encoded");
        let pi = root.join("pi/sessions/encoded");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&claude).unwrap();
        fs::create_dir_all(&pi).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap()
            .success());
        let record = json!({"cwd":project});
        fs::write(claude.join("one.jsonl"), format!("{record}\n")).unwrap();
        fs::write(pi.join("one.jsonl"), format!("{record}\n")).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)",
        )
        .unwrap();
        let settings = json!({"providerInstances":{
            "codex":{"driver":"codex","enabled":false},
            "claudeAgent":{"driver":"claudeAgent","config":{"homePath":root.join("claude")}},
            "pi":{"driver":"pi","enabled":true,"environment":[{"name":"PI_CODING_AGENT_SESSION_DIR","value":root.join("pi/sessions")}]} }});
        let result = scan(&db, &settings).unwrap();
        let c = &result["candidates"][0];
        assert_eq!(result["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(c["sources"], json!(["claudeAgent", "pi"]));
        assert_eq!(c["threadCount"], 2);
        assert_eq!(c["git"], json!({"remoteKey":null,"repository":null}));
        fs::remove_dir_all(root).unwrap();
    }
}
