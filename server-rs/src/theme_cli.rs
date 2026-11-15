//! CLI management of published environment themes.
use crate::{environment_theme, lenient_json, runtime::ServerPaths};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn settings(path: &Path) -> Result<(String, Value), String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => {
            return Err(format!(
                "Could not read {}. Fix its permissions, then run this again.",
                path.display()
            ))
        }
    };
    let value = if raw.trim().is_empty() {
        json!({})
    } else {
        let parsed: Value = lenient_json::parse(raw.as_bytes()).map_err(|_| {
            format!(
                "{} is not a JSON object. Fix or remove it, then run this again.",
                path.display()
            )
        })?;
        if !parsed.is_object() {
            return Err(format!(
                "{} is not a JSON object. Fix or remove it, then run this again.",
                path.display()
            ));
        }
        parsed
    };
    Ok((raw, value))
}
fn write_default(path: &Path, id: Option<&str>) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid settings path")?;
    fs::create_dir_all(parent).map_err(|_| format!("Could not write {}.", path.display()))?;
    for _ in 0..5 {
        let (raw, mut value) = settings(path)?;
        let map = value.as_object_mut().unwrap();
        if let Some(id) = id {
            map.insert("defaultTheme".into(), json!(id));
            map.insert(
                "defaultThemeSetAt".into(),
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
        } else {
            map.remove("defaultTheme");
            map.remove("defaultThemeSetAt");
        }
        if settings(path)?.0 != raw {
            continue;
        }
        let temp = parent.join(format!(".theme-settings-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            fs::write(
                &temp,
                format!("{}\n", serde_json::to_string_pretty(&value)?),
            )?;
            fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
            return Err(format!("Could not write {}.", path.display()));
        }
        return Ok(());
    }
    Err(format!(
        "{} kept changing while writing (gave up after 5 attempts). Try again.",
        path.display()
    ))
}
fn known(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = ["t3-chat", "grove", "ocean", "ember", "iris"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    ids.extend(
        environment_theme::read(dir)
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned)),
    );
    ids.sort();
    ids
}
fn expand(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_owned()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}
fn live_runtime(path: &Path) -> bool {
    let Some(pid) = fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
        .and_then(|v| v["pid"].as_u64())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
    else {
        return false;
    };
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}
#[cfg(unix)]
fn same_file(path: &Path, original: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|m| m.dev() == original.dev() && m.ino() == original.ino())
}
#[cfg(not(unix))]
fn same_file(_path: &Path, _original: &fs::Metadata) -> bool {
    false
}
pub fn run(args: &[String], home: &Path, cwd: &Path) -> Result<String, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    if !["set", "clear", "show"].contains(&action) {
        return Err("Usage: t3 theme set <theme> [--id <id>] | clear | show".into());
    }
    let mut base = None;
    let mut id = None;
    let mut target = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--base-dir" | "--id" => {
                let key = &args[i];
                i += 1;
                let val = args
                    .get(i)
                    .ok_or_else(|| format!("{key} requires a value"))?;
                if key == "--base-dir" {
                    base = Some(val.clone());
                } else {
                    id = Some(val.clone());
                }
            }
            value if value.starts_with('-') => return Err(format!("Unsupported option: {value}")),
            value if target.is_none() => target = Some(value.to_owned()),
            _ => return Err("Unexpected argument".into()),
        }
        i += 1;
    }
    if action != "set" && (id.is_some() || target.is_some()) {
        return Err("Unexpected argument".into());
    }
    let explicit = base
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("T3CODE_HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
        });
    let base_dir = crate::runtime::resolve_base_dir(explicit.as_deref(), home, cwd);
    let mut paths = ServerPaths::new(base_dir.clone(), false, explicit.is_some(), None::<PathBuf>);
    if explicit.is_none() && !live_runtime(&paths.server_runtime_state_path) {
        let dev = ServerPaths::new(base_dir, true, false, None::<PathBuf>);
        if live_runtime(&dev.server_runtime_state_path) {
            paths = dev;
        }
    }
    let settings_path = &paths.settings_path;
    let dir = &paths.environment_themes_dir;
    match action {
        "show" => {
            let (_, v) = settings(settings_path)?;
            let selected = v["defaultTheme"].as_str().filter(|s| !s.is_empty());
            let ids: Vec<String> = environment_theme::read(dir)
                .iter()
                .filter_map(|v| v["id"].as_str().map(str::to_owned))
                .collect();
            Ok(format!(
                "Environment theme: {}.\n\nPublished themes: {}.\n",
                selected
                    .map(|s| format!("\"{s}\""))
                    .unwrap_or_else(|| "not set".into()),
                if ids.is_empty() {
                    format!("none (publish into {})", dir.display())
                } else {
                    ids.join(", ")
                }
            ))
        }
        "clear" => {
            write_default(settings_path, None)?;
            Ok(format!(
                "Environment theme cleared in {}.\n",
                settings_path.display()
            ))
        }
        _ => {
            let target = target.ok_or(
                "Provide a theme id or file, or run `t3 theme clear` to remove the theme.",
            )?;
            let target = target.trim();
            if target.is_empty() {
                return Err(
                    "Provide a theme id or file, or run `t3 theme clear` to remove the theme."
                        .into(),
                );
            }
            let is_path = target.ends_with(".json")
                || target.contains('/')
                || target.contains('\\')
                || target.starts_with('~');
            if !is_path {
                let known = known(dir);
                if !known.iter().any(|v| v == target) {
                    if !environment_theme::valid_id(target) {
                        return Err(format!("\"{target}\" is not a valid theme id (lowercase letters, digits, and hyphens; not an appearance keyword)."));
                    }
                    return Err(format!("No theme named \"{target}\". Available: {}. Publish one by passing a theme file instead of an id.",known.join(", ")));
                }
                write_default(settings_path, Some(target))?;
                return Ok(format!(
                    "Environment theme set to \"{target}\" in {}.\n",
                    settings_path.display()
                ));
            }
            let source = expand(target, home);
            let info = fs::metadata(&source)
                .map_err(|_| format!("Could not read {}.", source.display()))?;
            if !info.is_file() {
                return Err(format!("Could not read {}.", source.display()));
            }
            if info.len() > 32768 {
                return Err(format!(
                    "{} is larger than 32768 bytes, which is more than a theme can publish.",
                    source.display()
                ));
            }
            let resolved = fs::canonicalize(&source)
                .map_err(|_| format!("Could not read {}.", source.display()))?;
            let raw = environment_theme::read_file(&resolved)
                .ok_or_else(|| format!("Could not read {}.", source.display()))?;
            let theme_id = id
                .as_deref()
                .or_else(|| source.file_stem().and_then(|v| v.to_str()))
                .unwrap_or("");
            if !environment_theme::valid_id(theme_id) {
                return Err(format!("\"{theme_id}\" is not a valid theme id (lowercase letters, digits, and hyphens; not an appearance keyword). Pass one with --id."));
            }
            if raw.len() > 32768 || environment_theme::theme(theme_id, &raw).is_none() {
                return Err(format!("{} is not a valid theme file. Use a theme exported from T3 Code, or a seeded file with name, appearance, canvas, and accent.",source.display()));
            }
            settings(settings_path)?;
            fs::create_dir_all(dir)
                .map_err(|_| format!("Could not publish the theme into {}.", dir.display()))?;
            let dest = dir.join(format!("{theme_id}.json"));
            let stage = dir.join(format!(".theme-{}.tmp", uuid::Uuid::new_v4()));
            let backup = dir.join(format!(".theme-{}.backup", uuid::Uuid::new_v4()));
            fs::write(&stage, &raw)
                .map_err(|_| format!("Could not publish the theme into {}.", dir.display()))?;
            let staged = fs::symlink_metadata(&stage)
                .map_err(|_| format!("Could not publish the theme into {}.", dir.display()))?;
            let had = match fs::rename(&dest, &backup) {
                Ok(()) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => {
                    let _ = fs::remove_file(&stage);
                    return Err(format!(
                        "Could not publish the theme into {}.",
                        dir.display()
                    ));
                }
            };
            if fs::rename(&stage, &dest).is_err() {
                if had {
                    let _ = fs::rename(&backup, &dest);
                }
                let _ = fs::remove_file(stage);
                return Err(format!(
                    "Could not publish the theme into {}.",
                    dir.display()
                ));
            }
            if let Err(error) = write_default(settings_path, Some(theme_id)) {
                let ours = same_file(&dest, &staged);
                let absent = fs::symlink_metadata(&dest)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
                if ours || absent {
                    if ours {
                        let _ = fs::remove_file(&dest);
                    }
                    if had {
                        let _ = fs::rename(&backup, &dest);
                    }
                } else if had {
                    let _ = fs::remove_file(&backup);
                }
                return Err(error);
            }
            if had {
                let _ = fs::remove_file(backup);
            }
            Ok(format!(
                "Published {} as \"{theme_id}\" and set it as the environment theme.\n",
                source.display()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }
    #[test]
    fn publishes_sets_shows_and_clears_without_losing_settings() {
        let root = std::env::temp_dir().join(format!("t3-theme-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("night.json");
        fs::write(
            &source,
            r##"{"name":"Night","appearance":"dark","colors":{"canvas":"#123"}}"##,
        )
        .unwrap();
        let base = root.join("home");
        let base_str = base.to_str().unwrap();
        run(
            &args(&["set", source.to_str().unwrap(), "--base-dir", base_str]),
            &root,
            &root,
        )
        .unwrap();
        let path = base.join("userdata/settings.json");
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["defaultTheme"], "night");
        assert!(value["defaultThemeSetAt"].as_str().is_some());
        assert!(run(&args(&["show", "--base-dir", base_str]), &root, &root)
            .unwrap()
            .contains("Published themes: night."));
        run(
            &args(&["set", "t3-chat", "--base-dir", base_str]),
            &root,
            &root,
        )
        .unwrap();
        let before: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(before["defaultTheme"], "t3-chat");
        let mut changed = before;
        changed["futureField"] = json!({"keep":true});
        fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        run(&args(&["clear", "--base-dir", base_str]), &root, &root).unwrap();
        let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(after.get("defaultTheme").is_none());
        assert_eq!(after["futureField"]["keep"], true);
        fs::write(&path, "{broken").unwrap();
        assert!(run(
            &args(&["set", "night", "--base-dir", base_str]),
            &root,
            &root
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
        fs::remove_dir_all(root).unwrap();
    }
}
