//! Persistent server settings and client-safe snapshots.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

pub struct Settings {
    path: PathBuf,
    value: Arc<Mutex<Value>>,
    changes: broadcast::Sender<Value>,
    secrets: PathBuf,
}

#[derive(Debug)]
pub enum SettingsUpdateError {
    InvalidMutation,
    InstanceExists(String),
    Persistence(String),
    ManagedSetting(String, String),
    DisallowedProvider(String, String, String),
}

impl From<String> for SettingsUpdateError {
    fn from(message: String) -> Self {
        Self::Persistence(message)
    }
}

impl From<&str> for SettingsUpdateError {
    fn from(message: &str) -> Self {
        Self::Persistence(message.to_owned())
    }
}

struct ProviderMutation {
    operation: String,
    instance_id: String,
    instance: Option<Value>,
}

fn provider_slug(value: &Value) -> Option<String> {
    let slug = value.as_str()?.trim();
    if slug.is_empty()
        || slug.len() > 64
        || !slug.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_alphabetic() || (i > 0 && (c.is_ascii_digit() || c == b'_' || c == b'-'))
        })
    {
        return None;
    }
    Some(slug.to_owned())
}

fn parse_provider_mutation(value: &Value) -> Result<ProviderMutation, SettingsUpdateError> {
    let object = value
        .as_object()
        .ok_or(SettingsUpdateError::InvalidMutation)?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .filter(|v| ["create", "upsert", "remove"].contains(v))
        .ok_or(SettingsUpdateError::InvalidMutation)?
        .to_owned();
    let instance_id = object
        .get("instanceId")
        .and_then(provider_slug)
        .ok_or(SettingsUpdateError::InvalidMutation)?;
    let instance = if operation == "remove" {
        None
    } else {
        let mut instance = object
            .get("instance")
            .and_then(Value::as_object)
            .cloned()
            .ok_or(SettingsUpdateError::InvalidMutation)?;
        let driver = instance
            .get("driver")
            .and_then(provider_slug)
            .ok_or(SettingsUpdateError::InvalidMutation)?;
        instance.insert("driver".into(), json!(driver));
        for key in ["displayName", "accentColor"] {
            if let Some(value) = instance.get_mut(key) {
                let text = value
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or(SettingsUpdateError::InvalidMutation)?
                    .to_owned();
                *value = json!(text);
            }
        }
        if instance.get("enabled").is_some_and(|v| !v.is_boolean()) {
            return Err(SettingsUpdateError::InvalidMutation);
        }
        if let Some(environment) = instance.get_mut("environment") {
            let variables = environment
                .as_array_mut()
                .ok_or(SettingsUpdateError::InvalidMutation)?;
            for variable in variables {
                let var = variable
                    .as_object_mut()
                    .ok_or(SettingsUpdateError::InvalidMutation)?;
                let name = var
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| {
                        !s.is_empty()
                            && s.len() <= 128
                            && s.bytes().enumerate().all(|(i, c)| {
                                c == b'_'
                                    || c.is_ascii_alphabetic()
                                    || (i > 0 && c.is_ascii_digit())
                            })
                    })
                    .ok_or(SettingsUpdateError::InvalidMutation)?
                    .to_owned();
                var.insert("name".into(), json!(name));
                if var.get("value").is_some_and(|v| !v.is_string())
                    || var.get("sensitive").is_some_and(|v| !v.is_boolean())
                    || var.get("valueRedacted").is_some_and(|v| !v.is_boolean())
                {
                    return Err(SettingsUpdateError::InvalidMutation);
                }
                var.entry("value").or_insert(json!(""));
                var.entry("sensitive").or_insert(json!(false));
            }
        }
        Some(Value::Object(instance))
    };
    Ok(ProviderMutation {
        operation,
        instance_id,
        instance,
    })
}

pub fn defaults() -> Value {
    serde_json::from_str(include_str!("settings_defaults.json")).expect("settings defaults")
}

// Validate the stable top-level schema before accepting a file or patch. Maps with
// forward-compatible entries are intentionally left opaque here.
pub(crate) fn validate_settings(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("Settings must be an object")?;
    let defaults = defaults();
    for (key, v) in object {
        let valid = match key.as_str() {
            "idleCompaction" => v
                .as_str()
                .is_some_and(|s| ["onReturn", "beforeCacheExpires", "off"].contains(&s)),
            "compactIdleThreads" => {
                v.is_boolean()
                    || v.as_str()
                        .is_some_and(|s| ["onReturn", "beforeCacheExpires", "off"].contains(&s))
            }
            "defaultThreadEnvMode" => {
                v.is_null()
                    || v.as_str()
                        .is_some_and(|s| ["local", "worktree"].contains(&s))
            }
            "usageModelFilter" => true,
            "responseStreamingMode" => v
                .as_str()
                .is_some_and(|s| ["turn", "paragraph"].contains(&s)),
            "backgroundActivityProfile" => v
                .as_str()
                .is_some_and(|s| ["balanced", "performance", "battery-saver"].contains(&s)),
            "branchNamingMode" => v
                .as_str()
                .is_some_and(|s| ["static", "semantic", "custom"].contains(&s)),
            "sidebarAutoSettleAfterDays" => v.is_null() || v.is_number(),
            "cloudSpeechCredentials" => v.is_object(),
            _ => match defaults.get(key) {
                Some(Value::Bool(_)) => v.is_boolean(),
                Some(Value::String(_)) => v.is_string(),
                Some(Value::Number(_)) => v.is_number(),
                Some(Value::Array(_)) => v.is_array(),
                Some(Value::Object(_)) => v.is_object(),
                Some(Value::Null) | None => true,
            },
        };
        if !valid {
            return Err(format!("Invalid settings field: {key}"));
        }
    }
    Ok(())
}

fn normalize_settings(value: &mut Value) {
    let mode = value
        .get("idleCompaction")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| match value.get("compactIdleThreads") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Bool(true)) => "beforeCacheExpires".into(),
            _ => "onReturn".into(),
        });
    value["compactIdleThreads"] = json!(mode == "beforeCacheExpires");
    value["idleCompaction"] = json!(mode);
    if let Some(tags) = value
        .get_mut("hiddenThreadTags")
        .and_then(Value::as_array_mut)
    {
        tags.retain(Value::is_string);
    }
    for key in [
        "worktreesDirectory",
        "addProjectBaseDirectory",
        "threadTitleInstructions",
        "branchNamePrefix",
        "branchNameInstructions",
        "reviewGuideInstructions",
    ] {
        if let Some(v) = value.get_mut(key) {
            if let Some(s) = v.as_str() {
                *v = json!(s.trim());
            }
        }
    }
    if let Some(instances) = value
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    {
        for instance in instances.values_mut() {
            let legacy = instance
                .get_mut("config")
                .and_then(Value::as_object_mut)
                .and_then(|c| c.remove("enabled"));
            if let Some(Value::Bool(enabled)) = legacy {
                let current = instance.get("enabled").and_then(Value::as_bool);
                instance["enabled"] = json!(current.unwrap_or(enabled) && enabled);
            }
        }
    }
}

fn is_secret_reference(value: &Value) -> bool {
    value.get("provider").and_then(Value::as_str).is_some()
        && value.get("reference").and_then(Value::as_str).is_some()
}

fn client_view(value: &mut Value) {
    visit_secrets(value, &mut |_, slot, _| {
        if is_secret_reference(slot) || slot.as_str().is_some_and(|s| !s.is_empty()) {
            *slot = json!(MASK);
        }
    });
    // Unknown provider configurations may contain credentials this server cannot identify.
    if let Some(providers) = value
        .get_mut("secretProviders")
        .and_then(Value::as_object_mut)
    {
        for provider in providers.values_mut() {
            if let Some(provider) = provider.as_object_mut() {
                if provider.get("kind").and_then(Value::as_str) != Some("one_password") {
                    provider.remove("config");
                }
            }
        }
    }
    redact(value, false);
}

fn merge(dst: &mut Value, patch: &Value) {
    match (dst, patch) {
        (Value::Object(dst), Value::Object(patch)) => {
            for (key, value) in patch {
                if let Some(existing) = dst.get_mut(key) {
                    merge(existing, value);
                } else {
                    dst.insert(key.clone(), value.clone());
                }
            }
        }
        (dst, patch) => *dst = patch.clone(),
    }
}

// A directory watch survives atomic replacement of settings.json. A second
// watch follows a symlink target, including when the link is repointed.
fn watcher_target(path: &std::path::Path) -> Option<PathBuf> {
    if let Ok(target) = std::fs::canonicalize(path) {
        return Some(target);
    }
    let target = std::fs::read_link(path).ok()?;
    Some(if target.is_absolute() {
        target
    } else {
        path.parent()?.join(target)
    })
}

fn overlay_policy_at(path: &std::path::Path, value: &mut Value) {
    let stored = std::fs::read(path)
        .ok()
        .and_then(|raw| crate::lenient_json::parse::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let _ = crate::managed_policy::apply_setting_defaults(value, &stored);
    let _ = crate::managed_policy::apply_locked_settings(value);
    let _ = crate::managed_policy::apply_provider_ceiling(value);
}
fn start_watcher(
    path: PathBuf,
    value: std::sync::Weak<Mutex<Value>>,
    changes: broadcast::Sender<Value>,
) {
    use notify::{RecursiveMode, Watcher};
    use std::time::{Duration, Instant};
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let Some(parent) = path.parent().map(std::path::Path::to_path_buf) else {
        return;
    };
    if std::fs::create_dir_all(&parent).is_err() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let Ok(mut watcher) = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    }) else {
        return;
    };
    if watcher.watch(&parent, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    let mut target = watcher_target(&path);
    let mut target_dir = target
        .as_ref()
        .and_then(|p| p.parent())
        .filter(|p| *p != parent)
        .map(std::path::Path::to_path_buf);
    if let Some(dir) = &target_dir {
        let _ = std::fs::create_dir_all(dir);
        let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    }
    std::thread::spawn(move || {
        let mut deadline: Option<Instant> = None;
        loop {
            if value.strong_count() == 0 {
                break;
            }
            let wait = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(200))
                .min(Duration::from_millis(200));
            match rx.recv_timeout(wait) {
                Ok(Ok(event))
                    if matches!(
                        event.kind,
                        notify::EventKind::Any
                            | notify::EventKind::Create(_)
                            | notify::EventKind::Modify(_)
                            | notify::EventKind::Remove(_)
                    ) && event
                        .paths
                        .iter()
                        .any(|p| p == &path || target.as_ref() == Some(p)) =>
                {
                    let next = watcher_target(&path);
                    let next_dir = next
                        .as_ref()
                        .and_then(|p| p.parent())
                        .filter(|p| *p != parent)
                        .map(std::path::Path::to_path_buf);
                    if next_dir != target_dir {
                        if let Some(dir) = &target_dir {
                            let _ = watcher.unwatch(dir);
                        }
                        if let Some(dir) = &next_dir {
                            let _ = std::fs::create_dir_all(dir);
                            let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
                        }
                        target_dir = next_dir;
                    }
                    target = next;
                    deadline = Some(Instant::now() + Duration::from_millis(100));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                _ => {}
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                deadline = None;
                let Some(value) = value.upgrade() else { break };
                let mut guard = value.lock().unwrap_or_else(|e| e.into_inner());
                let mut loaded = defaults();
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match crate::lenient_json::parse::<Value>(raw.as_bytes()) {
                        Ok(parsed) if validate_settings(&parsed).is_ok() => {
                            merge(&mut loaded, &parsed);
                            normalize_settings(&mut loaded);
                        }
                        _ => loaded["continueThreadsAfterServerUpdate"] = json!(false),
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => continue,
                }
                *guard = loaded.clone();
                overlay_policy_at(&path, &mut loaded);
                client_view(&mut loaded);
                let _ = changes.send(loaded);
            }
        }
    });
}

impl Settings {
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
    pub fn new(path: PathBuf) -> Self {
        let mut value = defaults();
        if let Ok(raw) = std::fs::read_to_string(&path) {
            match crate::lenient_json::parse::<Value>(raw.as_bytes()) {
                Ok(parsed) if validate_settings(&parsed).is_ok() => {
                    merge(&mut value, &parsed);
                    normalize_settings(&mut value);
                }
                _ => value["continueThreadsAfterServerUpdate"] = json!(false),
            }
        }
        let secrets = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("secrets");
        // Migrate legacy literal field secrets on load. If storage fails, retain the
        // inline value so a later load can retry without losing the credential.
        let mut migrated = value.clone();
        visit_secrets(&mut migrated, &mut |name, slot, environment| {
            if !environment {
                if let Some(text) = slot.as_str().filter(|s| !s.is_empty() && *s != MASK) {
                    if write_secret(&secrets, name, text.as_bytes()).is_ok() {
                        *slot = json!(MASK);
                    }
                }
            }
        });
        if migrated != value && write_settings(&path, &migrated).is_ok() {
            value = migrated;
        }
        let (changes, _) = broadcast::channel(64);
        let value = Arc::new(Mutex::new(value));
        start_watcher(path.clone(), Arc::downgrade(&value), changes.clone());
        Self {
            path,
            secrets,
            value,
            changes,
        }
    }
    /// Fold legacy project columns into the settings file once, after database migrations.
    pub fn fold_legacy_project_settings(&self, db: &rusqlite::Connection) -> Result<(), String> {
        let mut guard = self.value.lock().unwrap_or_else(|e| e.into_inner());
        // A malformed file must remain untouched for the user to repair.
        if let Ok(raw) = std::fs::read_to_string(&self.path) {
            let parsed: Value = crate::lenient_json::parse(raw.as_bytes())
                .map_err(|_| "Cannot migrate malformed settings file")?;
            validate_settings(&parsed)?;
        }
        if guard["projectSettingsFolded"] == true {
            return Ok(());
        }
        let mut stmt = db.prepare("SELECT project_id, default_model_selection_json, default_thread_env_mode, auto_pull, scripts_json FROM projection_projects WHERE deleted_at IS NULL").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut next = guard.clone();
        let legacy = [
            (
                "projectAgentBrowserAccessOverrides",
                "enableAgentBrowserAccess",
            ),
            ("projectAutoPullOverrides", "defaultAutoPull"),
            ("projectScriptOverrides", "defaultProjectScripts"),
        ];
        if rows.is_empty()
            && legacy
                .iter()
                .all(|(k, _)| next[*k].as_object().is_none_or(|m| m.is_empty()))
        {
            return Ok(());
        }
        let mut entries = next["projectSettingsOverrides"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut resets = BTreeSet::new();
        for (source, target) in legacy {
            if let Some(map) = next[source].as_object() {
                for (id, value) in map {
                    if source == "projectScriptOverrides" && value.is_null() {
                        resets.insert(id.clone());
                        continue;
                    }
                    let entry = entries.entry(id.clone()).or_insert_with(|| json!({}));
                    if let Some(entry) = entry.as_object_mut() {
                        entry.entry(target).or_insert_with(|| value.clone());
                    }
                }
            }
        }
        for (id, model, mode, auto_pull, scripts) in rows {
            let entry = entries.entry(id.clone()).or_insert_with(|| json!({}));
            let Some(entry) = entry.as_object_mut() else {
                continue;
            };
            if let Some(model) = model
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(Value::is_object)
            {
                entry.entry("defaultModelSelection").or_insert(model);
            }
            if let Some(mode) = mode.filter(|s| s == "local" || s == "worktree") {
                entry.entry("defaultThreadEnvMode").or_insert(json!(mode));
            }
            if auto_pull == 1 {
                entry.entry("defaultAutoPull").or_insert(json!(true));
            }
            if !resets.contains(&id) {
                if let Ok(Value::Array(scripts)) = serde_json::from_str::<Value>(&scripts) {
                    if !scripts.is_empty() {
                        entry
                            .entry("defaultProjectScripts")
                            .or_insert(json!(scripts));
                    }
                }
            }
        }
        entries.retain(|_, value| value.as_object().is_some_and(|m| !m.is_empty()));
        for (source, target) in legacy {
            let derived: serde_json::Map<String, Value> = entries
                .iter()
                .filter_map(|(id, entry)| entry.get(target).map(|v| (id.clone(), v.clone())))
                .collect();
            next[source] = Value::Object(derived);
        }
        next["projectSettingsOverrides"] = Value::Object(entries);
        next["projectSettingsFolded"] = json!(true);
        write_settings(&self.path, &next).map_err(|e| e.to_string())?;
        *guard = next;
        Ok(())
    }
    fn overlay_policy(&self, value: &mut Value) {
        overlay_policy_at(&self.path, value);
    }
    pub(crate) fn private_snapshot(&self) -> Value {
        let mut value = self.value.lock().unwrap_or_else(|e| e.into_inner()).clone();
        self.overlay_policy(&mut value);
        value
    }
    pub fn snapshot(&self) -> Value {
        let mut value = self.value.lock().unwrap_or_else(|e| e.into_inner()).clone();
        self.overlay_policy(&mut value);
        client_view(&mut value);
        value
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.changes.subscribe()
    }
    pub fn update(&self, patch: &Value) -> Result<Value, String> {
        self.update_inner(patch, None, None).map_err(|e| match e {
            SettingsUpdateError::Persistence(message) => message,
            SettingsUpdateError::ManagedSetting(path, _) => format!("Managed policy locks {path}"),
            SettingsUpdateError::DisallowedProvider(_, label, organization) => {
                format!("{organization}'s policy does not allow the {label} provider.")
            }
            _ => "Invalid settings patch".to_owned(),
        })
    }
    pub fn update_typed(&self, patch: &Value) -> Result<Value, SettingsUpdateError> {
        self.update_inner(patch, None, None)
    }
    pub fn update_with_provider_mutation(
        &self,
        patch: &Value,
        mutation: &Value,
    ) -> Result<Value, SettingsUpdateError> {
        let mutation = parse_provider_mutation(mutation)?;
        self.update_inner(patch, Some(mutation), None)
    }
    pub(crate) fn compare_exchange_github_app_session(
        &self,
        host: &str,
        expected_token: &str,
        next: &str,
    ) -> Result<bool, String> {
        let patch = json!({"sourceControlHosts":{"github":{"signIns":{host:next}}}});
        match self.update_inner(&patch, None, Some((host, expected_token))) {
            Ok(_) => Ok(true),
            Err(SettingsUpdateError::Persistence(message))
                if message == "GitHub App session changed" =>
            {
                Ok(false)
            }
            Err(error) => Err(format!("Could not save GitHub App session: {error:?}")),
        }
    }
    fn update_inner(
        &self,
        patch: &Value,
        mutation: Option<ProviderMutation>,
        app_expected: Option<(&str, &str)>,
    ) -> Result<Value, SettingsUpdateError> {
        validate_settings(patch)?;
        let patch = patch.as_object().ok_or("Invalid settings patch")?;
        let mut guard = self.value.lock().unwrap_or_else(|e| e.into_inner());
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => {
                let disk: Value = crate::lenient_json::parse(raw.as_bytes())
                    .map_err(|_| "Cannot update malformed settings file")?;
                if validate_settings(&disk).is_err() {
                    return Err("Cannot update malformed settings file".into());
                }
                let mut loaded = defaults();
                merge(&mut loaded, &disk);
                normalize_settings(&mut loaded);
                *guard = loaded;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => *guard = defaults(),
            Err(e) => return Err(e.to_string().into()),
        }
        if let Some((host, expected_token)) = app_expected {
            let mut current = guard.clone();
            materialize_secrets(&self.path, &mut current)
                .map_err(SettingsUpdateError::Persistence)?;
            let token = current["sourceControlHosts"]["github"]["signIns"][host]
                .as_str()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|session| session["accessToken"].as_str().map(str::to_owned));
            if token.as_deref() != Some(expected_token) {
                return Err(SettingsUpdateError::Persistence(
                    "GitHub App session changed".into(),
                ));
            }
        }
        if let Some(mutation) = &mutation {
            if mutation.operation == "create"
                && guard["providerInstances"]
                    .as_object()
                    .is_some_and(|map| map.contains_key(&mutation.instance_id))
            {
                return Err(SettingsUpdateError::InstanceExists(
                    mutation.instance_id.clone(),
                ));
            }
        }
        let mut next = guard.clone();
        for (key, value) in patch {
            if !guard.as_object().unwrap().contains_key(key)
                && !["idleCompaction", "defaultThreadEnvMode", "usageModelFilter"]
                    .contains(&key.as_str())
            {
                return Err(format!("Unknown settings field: {key}").into());
            }
            if [
                "usageLimitSources",
                "textGenerators",
                "secretProviders",
                "usagePriceOverrides",
                "usageModelAliases",
                "projectSettingsOverrides",
            ]
            .contains(&key.as_str())
            {
                let entries = value.as_object().ok_or("Invalid settings map")?;
                let map = next[key].as_object_mut().ok_or("Invalid settings map")?;
                for (id, entry) in entries {
                    if entry.is_null() {
                        map.remove(id);
                    } else {
                        map.insert(id.clone(), entry.clone());
                    }
                }
            } else if [
                "providerInstances",
                "defaultModelSelection",
                "fallbackModelSelection",
                "speechPostProcessingModelSelection",
                "sourceControlWriterModelSelection",
                "reviewGuideModelSelection",
                "defaultProjectScripts",
            ]
            .contains(&key.as_str())
            {
                next[key] = value.clone();
            } else {
                merge(&mut next[key], value);
            }
        }
        if let Some(mutation) = mutation {
            let instances = next["providerInstances"]
                .as_object_mut()
                .ok_or("Invalid provider instances")?;
            if let Some(instance) = mutation.instance {
                instances.insert(mutation.instance_id, instance);
            } else {
                instances.remove(&mutation.instance_id);
            }
        }
        if patch.contains_key("compactIdleThreads") && !patch.contains_key("idleCompaction") {
            next.as_object_mut().unwrap().remove("idleCompaction");
        }
        normalize_settings(&mut next);
        if let Some((path, organization)) = crate::managed_policy::vet_locked_settings(
            &guard,
            &mut next,
            &Value::Object(patch.clone()),
        )
        .map_err(SettingsUpdateError::Persistence)?
        {
            return Err(SettingsUpdateError::ManagedSetting(path, organization));
        }
        if let Some((path, organization)) =
            crate::managed_policy::vet_locked_provider_pins(&guard, &mut next)
                .map_err(SettingsUpdateError::Persistence)?
        {
            return Err(SettingsUpdateError::ManagedSetting(path, organization));
        }
        if let Some((id, label, organization)) =
            crate::managed_policy::disallowed_provider_write(&guard, &next)
                .map_err(SettingsUpdateError::Persistence)?
        {
            return Err(SettingsUpdateError::DisallowedProvider(
                id,
                label,
                organization,
            ));
        }
        crate::managed_policy::validate_ceiling_settings_write(&guard, &next).map_err(
            |message| {
                if let Some(path) = message.strip_prefix("Managed policy locks ") {
                    if let Ok(Some((organization, _))) = crate::managed_policy::runtime_ceiling() {
                        return SettingsUpdateError::ManagedSetting(path.into(), organization);
                    }
                }
                SettingsUpdateError::Persistence(message)
            },
        )?;
        let defaulted = crate::managed_policy::defaulted_setting_heads()
            .map_err(SettingsUpdateError::Persistence)?;
        let mut effective_before = guard.clone();
        self.overlay_policy(&mut effective_before);
        let explicit_default_change = defaulted
            .iter()
            .any(|key| patch.contains_key(key) && effective_before.get(key) != next.get(key));
        if next != *guard || explicit_default_change {
            let mut previous_names = BTreeSet::new();
            let mut references = BTreeMap::new();
            let mut old = guard.clone();
            visit_secrets(&mut old, &mut |name, slot, _| {
                previous_names.insert(name.to_owned());
                if is_secret_reference(slot) {
                    references.insert(name.to_owned(), slot.clone());
                }
            });
            let mut present = BTreeSet::new();
            let mut mutations: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
            visit_secrets(&mut next, &mut |name, slot, _environment| {
                present.insert(name.to_owned());
                if slot.as_str() == Some(MASK) {
                    if let Some(reference) = references.get(name) {
                        *slot = reference.clone();
                    }
                }
                if is_secret_reference(slot) {
                    // A reference replaces any locally stored literal credential.
                    mutations.insert(name.to_owned(), None);
                    return;
                }
                match slot.as_str() {
                    Some(MASK) => {}
                    Some("") => {
                        mutations.insert(name.to_owned(), None);
                    }
                    Some(secret) => {
                        mutations.insert(name.to_owned(), Some(secret.as_bytes().to_vec()));
                        *slot = json!(MASK);
                    }
                    None => {
                        mutations.insert(name.to_owned(), None);
                    }
                }
            });
            for name in previous_names.difference(&present) {
                mutations.insert(name.clone(), None);
            }
            let mut applied = Vec::new();
            let result = (|| -> Result<(), String> {
                for (name, value) in mutations {
                    let target = self.secrets.join(format!("{name}.bin"));
                    let old = match std::fs::read(&target) {
                        Ok(bytes) => Some(bytes),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                        Err(e) => return Err(e.to_string()),
                    };
                    applied.push((name.clone(), old));
                    match value {
                        Some(bytes) => {
                            write_secret(&self.secrets, &name, &bytes).map_err(|e| e.to_string())?
                        }
                        None => remove_secret(&self.secrets, &name).map_err(|e| e.to_string())?,
                    }
                }
                write_settings_with_patch(&self.path, &next, Some(patch)).map_err(|e| e.to_string())
            })();
            if let Err(error) = result {
                for (name, old) in applied.into_iter().rev() {
                    if let Some(bytes) = old {
                        let _ = write_secret(&self.secrets, &name, &bytes);
                    } else {
                        let _ = remove_secret(&self.secrets, &name);
                    }
                }
                return Err(error.into());
            }
            *guard = next.clone();
            let mut safe = next.clone();
            self.overlay_policy(&mut safe);
            client_view(&mut safe);
            let _ = self.changes.send(safe);
        }
        self.overlay_policy(&mut next);
        client_view(&mut next);
        Ok(next)
    }
}
fn redact(value: &mut Value, sensitive: bool) {
    match value {
        Value::Object(map) => {
            let env_sensitive = map.get("sensitive") == Some(&json!(true));
            for (key, child) in map {
                let k = key.to_ascii_lowercase();
                let secret = sensitive
                    || ["token", "apikey", "api_key", "password", "secret"].contains(&k.as_str())
                    || (env_sensitive && k == "value");
                if key == "cloudSpeechCredentials" {
                    redact(child, true);
                } else {
                    redact(child, secret);
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                redact(child, sensitive);
            }
        }
        Value::String(s) if sensitive && !s.is_empty() => *s = "••••••".into(),
        _ => {}
    }
}
const MASK: &str = "••••••";
fn encode(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(s.as_bytes())
}

/// Resolve stored literal credentials for trusted server-side consumers.
pub fn materialize_secrets(path: &std::path::Path, value: &mut Value) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or("Invalid settings path")?
        .join("secrets");
    let mut error = None;
    visit_secrets(value, &mut |name, slot, _| {
        if slot.as_str() == Some(MASK) {
            match std::fs::read(dir.join(format!("{name}.bin"))) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(secret) => *slot = json!(secret),
                    Err(_) => error = Some("Stored credential is not valid UTF-8".to_owned()),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => *slot = json!(""),
                Err(_) => error = Some("Could not read stored credential".to_owned()),
            }
        }
    });
    error.map_or(Ok(()), Err)
}

// Walk only schema-declared secret fields; reference objects are retained unchanged.
fn visit_secrets(value: &mut Value, f: &mut impl FnMut(&str, &mut Value, bool)) {
    fn field(v: &mut Value, name: String, f: &mut impl FnMut(&str, &mut Value, bool)) {
        if let Some(map) = v.as_object_mut() {
            if map.contains_key("provider") && map.contains_key("reference") {
                f(&name, v, false);
                return;
            }
            for (host, entry) in map {
                f(
                    &format!("{name}-{}", encode(&host.trim().to_lowercase())),
                    entry,
                    false,
                );
            }
        } else {
            f(&name, v, false);
        }
    }
    if let Some(map) = value
        .get_mut("cloudSpeechCredentials")
        .and_then(Value::as_object_mut)
    {
        for (provider, v) in map {
            if ["openai", "xai", "openrouter"].contains(&provider.as_str()) {
                field(v, format!("voice-cloud-{provider}"), f);
            }
        }
    }
    for (group, prefix, fields) in [
        (
            "sourceControlHosts",
            "source-control",
            &["accessToken", "tokens", "signIns", "apiToken", "token"][..],
        ),
        (
            "usageLimitSources",
            "usage-limit-source",
            &["managementKey"][..],
        ),
        ("textGenerators", "text-generator", &["apiKey"][..]),
    ] {
        if let Some(map) = value.get_mut(group).and_then(Value::as_object_mut) {
            for (id, entry) in map {
                for key in fields {
                    if let Some(v) = entry.get_mut(*key) {
                        let name = if group == "usageLimitSources" && *key == "managementKey" {
                            format!("{prefix}-{}", encode(id))
                        } else {
                            format!("{prefix}-{}-{}", encode(id), encode(key))
                        };
                        field(v, name, f);
                    }
                }
            }
        }
    }
    if let Some(map) = value
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    {
        for (id, instance) in map {
            let driver = instance
                .get("driver")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let Some(config) = instance.get_mut("config").and_then(Value::as_object_mut) {
                for key in ["apiKey", "serverPassword"] {
                    if let Some(v) = config.get_mut(key) {
                        field(
                            v,
                            format!(
                                "provider-config-{}-{}-{}",
                                encode(id),
                                encode(&driver),
                                encode(key)
                            ),
                            f,
                        );
                    }
                }
            }
            if let Some(env) = instance
                .get_mut("environment")
                .and_then(Value::as_array_mut)
            {
                for variable in env {
                    let name = variable
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if variable.get("sensitive") == Some(&json!(true)) {
                        let redacted = variable.get("valueRedacted") == Some(&json!(true));
                        if let Some(v) = variable.get_mut("value") {
                            if redacted && v.as_str() == Some("") {
                                *v = json!(MASK);
                            }
                            f(
                                &format!("provider-env-{}-{}", encode(id), encode(&name)),
                                v,
                                true,
                            );
                            if v.as_str() == Some(MASK) {
                                *v = json!("");
                                variable["valueRedacted"] = json!(true);
                            } else {
                                variable.as_object_mut().unwrap().remove("valueRedacted");
                            }
                        }
                    }
                }
            }
        }
    }
    for (group, prefix, key) in [
        ("easDeviceHosts", "device-host", "accessToken"),
        ("simlockDeviceHosts", "simlock-device-host", "agentToken"),
    ] {
        if let Some(hosts) = value.get_mut(group).and_then(Value::as_array_mut) {
            for host in hosts {
                let id = host
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if let Some(v) = host.get_mut(key) {
                    field(v, format!("{prefix}-{}-{}", encode(&id), encode(key)), f);
                }
            }
        }
    }
}
fn write_settings(path: &std::path::Path, value: &Value) -> std::io::Result<()> {
    write_settings_with_patch(path, value, None)
}
fn write_settings_with_patch(
    path: &std::path::Path,
    value: &Value,
    patch: Option<&serde_json::Map<String, Value>>,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("invalid settings path"))?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut sparse = value.clone();
        let defaulted =
            crate::managed_policy::defaulted_setting_heads().map_err(std::io::Error::other)?;
        let stored = std::fs::read(path)
            .ok()
            .and_then(|bytes| crate::lenient_json::parse::<Value>(&bytes).ok())
            .unwrap_or(Value::Null);
        let patch_value = patch.cloned().map(Value::Object).unwrap_or(Value::Null);
        for path in
            crate::managed_policy::defaulted_setting_paths().map_err(std::io::Error::other)?
        {
            let parts: Vec<_> = path.split('.').collect();
            if parts.len() < 2 {
                continue;
            }
            let encode = |part: &&str| part.replace('~', "~0").replace('/', "~1");
            let pointer = format!(
                "/{}",
                parts.iter().map(encode).collect::<Vec<_>>().join("/")
            );
            if stored.pointer(&pointer).is_none()
                && patch_value.pointer(&pointer).is_none()
                && sparse.pointer(&pointer) == defaults().pointer(&pointer)
            {
                let parent = format!(
                    "/{}",
                    parts[..parts.len() - 1]
                        .iter()
                        .map(encode)
                        .collect::<Vec<_>>()
                        .join("/")
                );
                if let Some(map) = sparse.pointer_mut(&parent).and_then(Value::as_object_mut) {
                    map.remove(parts[parts.len() - 1]);
                }
            }
        }
        if let (Some(map), Some(defaults)) = (sparse.as_object_mut(), defaults().as_object()) {
            map.retain(|key, value| {
                defaults.get(key) != Some(value)
                    || (defaulted.contains(key)
                        && (stored.get(key).is_some()
                            || patch.is_some_and(|p| p.contains_key(key))))
            });
        }
        std::fs::write(
            &temp,
            format!("{}\n", serde_json::to_string_pretty(&sparse)?),
        )?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn write_secret(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let temp = dir.join(format!(".{name}-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, dir.join(format!("{name}.bin")))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn remove_secret(dir: &std::path::Path, name: &str) -> std::io::Result<()> {
    match std::fs::remove_file(dir.join(format!("{name}.bin"))) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_app_refresh_does_not_overwrite_a_newer_session() {
        let dir = std::env::temp_dir().join(format!("t3-app-refresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Settings::new(dir.join("settings.json"));
        let original=json!({"accessToken":"old","accessTokenExpiresAt":null,"refreshToken":null,"refreshTokenExpiresAt":null}).to_string();
        let replacement=json!({"accessToken":"new","accessTokenExpiresAt":null,"refreshToken":null,"refreshTokenExpiresAt":null}).to_string();
        settings
            .update_typed(
                &json!({"sourceControlHosts":{"github":{"signIns":{"github.com":original}}}}),
            )
            .unwrap();
        assert!(!settings
            .compare_exchange_github_app_session("github.com", "wrong", &replacement)
            .unwrap());
        assert!(settings
            .compare_exchange_github_app_session("github.com", "old", &replacement)
            .unwrap());
        assert!(!settings
            .compare_exchange_github_app_session("github.com", "old", &replacement)
            .unwrap());
        let mut current = settings.private_snapshot();
        materialize_secrets(settings.path(), &mut current).unwrap();
        assert_eq!(
            current["sourceControlHosts"]["github"]["signIns"]["github.com"],
            replacement
        );
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn watches_atomic_external_edits_and_redacts_secrets() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = dir.join("settings.json");
        let settings = Settings::new(path.clone());
        let mut changes = settings.subscribe();
        let temp = dir.join("new.json");
        std::fs::write(
            &temp,
            r#"{"defaultAutoPull":true,"cloudSpeechCredentials":{"openai":"external-secret"}}"#,
        )
        .unwrap();
        std::fs::rename(&temp, &path).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(3), changes.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["defaultAutoPull"], true);
        assert_eq!(event["cloudSpeechCredentials"]["openai"], MASK);
        assert_eq!(settings.snapshot(), event);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(350), changes.recv())
                .await
                .is_err(),
            "reading the file must not trigger a notification loop"
        );
        drop(settings);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn watches_symlink_target_after_repointing() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let first = dir.join("first/settings.json");
        let second = dir.join("second/settings.json");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, "{}").unwrap();
        std::fs::write(&second, r#"{"defaultAutoPull":true}"#).unwrap();
        let path = dir.join("settings.json");
        symlink(&first, &path).unwrap();
        let settings = Settings::new(path.clone());
        let mut changes = settings.subscribe();
        let replacement = dir.join("link.tmp");
        symlink(&second, &replacement).unwrap();
        std::fs::rename(replacement, path).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(3), changes.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["defaultAutoPull"], true);
        std::fs::write(&second, r#"{"defaultAutoPull":false}"#).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(3), changes.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["defaultAutoPull"], false);
        drop(settings);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn folds_project_settings_once_with_override_precedence() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, json!({"projectSettingsOverrides":{"p":{"defaultAutoPull":false}},"projectScriptOverrides":{"p":null},"projectAgentBrowserAccessOverrides":{"p":true}}).to_string()).unwrap();
        let settings = Settings::new(path.clone());
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_projects(project_id TEXT, default_model_selection_json TEXT, default_thread_env_mode TEXT, auto_pull INTEGER, scripts_json TEXT, deleted_at TEXT); INSERT INTO projection_projects VALUES ('p',NULL,'worktree',1,'[1]',NULL);").unwrap();
        settings.fold_legacy_project_settings(&db).unwrap();
        let value = settings.snapshot();
        assert_eq!(value["projectSettingsFolded"], true);
        assert_eq!(
            value["projectSettingsOverrides"]["p"],
            json!({"defaultAutoPull":false,"enableAgentBrowserAccess":true,"defaultThreadEnvMode":"worktree"})
        );
        settings
            .update(&json!({"projectSettingsOverrides":{"p":null}}))
            .unwrap();
        settings.fold_legacy_project_settings(&db).unwrap();
        assert!(settings.snapshot()["projectSettingsOverrides"]
            .get("p")
            .is_none());
        drop(settings);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persists_updates_and_protects_secret_writes() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = dir.join("settings.json");
        let settings = Settings::new(path.clone());
        let mut updates = settings.subscribe();
        assert_eq!(
            settings.update(&json!({"defaultAutoPull":true})).unwrap()["defaultAutoPull"],
            true
        );
        assert_eq!(updates.try_recv().unwrap()["defaultAutoPull"], true);
        assert_eq!(
            Settings::new(path.clone()).snapshot()["defaultAutoPull"],
            true
        );
        assert_eq!(
            settings
                .update(
                    &json!({"cloudSpeechCredentials":{"openai":"distinctive-credential-value"}})
                )
                .unwrap()["cloudSpeechCredentials"]["openai"],
            MASK
        );
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("distinctive-credential-value"));
        assert_eq!(
            std::fs::read_to_string(dir.join("secrets/voice-cloud-openai.bin")).unwrap(),
            "distinctive-credential-value"
        );
        settings
            .update(&json!({"cloudSpeechCredentials":{"openai":MASK},"defaultAutoPull":false}))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("secrets/voice-cloud-openai.bin")).unwrap(),
            "distinctive-credential-value"
        );
        settings
            .update(&json!({"cloudSpeechCredentials":{"openai":""}}))
            .unwrap();
        assert!(!dir.join("secrets/voice-cloud-openai.bin").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_inline_credentials_and_keeps_redacted_echoes() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"legacy-token","email":"a@b"}}}"#,
        )
        .unwrap();
        let settings = Settings::new(path.clone());
        let snapshot = settings.snapshot();
        assert_eq!(
            snapshot["sourceControlHosts"]["bitbucket"]["accessToken"],
            MASK
        );
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("legacy-token"));
        let name = format!(
            "source-control-{}-{}.bin",
            encode("bitbucket"),
            encode("accessToken")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("secrets").join(name)).unwrap(),
            "legacy-token"
        );
        settings
            .update(&json!({"sourceControlHosts": snapshot["sourceControlHosts"]}))
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn references_survive_redacted_echoes_and_defaults_are_sparse() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let reference = json!({"provider":"vault", "reference":"private/path"});
        std::fs::write(&path, json!({"cloudSpeechCredentials":{"openai":reference}, "secretProviders":{"new":{"kind":"future", "config":{"credential":"hidden"}}}}).to_string()).unwrap();
        let settings = Settings::new(path.clone());
        let snapshot = settings.snapshot();
        assert_eq!(snapshot["cloudSpeechCredentials"]["openai"], MASK);
        assert!(snapshot["secretProviders"]["new"].get("config").is_none());
        settings
            .update(&json!({"cloudSpeechCredentials":{"openai":MASK}, "defaultAutoPull":true}))
            .unwrap();
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored["cloudSpeechCredentials"]["openai"], reference);
        assert!(stored.get("responseStreamingMode").is_none());
        drop(settings);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validates_and_normalizes_settings() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"compactIdleThreads":"off","hiddenThreadTags":["ok",42],"providerInstances":{"x":{"driver":"codex","config":{"enabled":false}}}}"#).unwrap();
        let settings = Settings::new(path.clone());
        let snapshot = settings.snapshot();
        assert_eq!(snapshot["idleCompaction"], "off");
        assert_eq!(snapshot["compactIdleThreads"], false);
        assert_eq!(snapshot["hiddenThreadTags"], json!(["ok"]));
        assert_eq!(snapshot["providerInstances"]["x"]["enabled"], false);
        assert!(settings.update(&json!({"defaultAutoPull":"yes"})).is_err());
        let updated = settings
            .update(&json!({"compactIdleThreads":true}))
            .unwrap();
        assert_eq!(updated["idleCompaction"], "beforeCacheExpires");
        std::fs::write(&path, r#"{"defaultAutoPull":"bad"}"#).unwrap();
        assert!(settings.update(&json!({"defaultAutoPull":true})).is_err());
        assert_eq!(
            Settings::new(path).snapshot()["continueThreadsAfterServerUpdate"],
            false
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_to_overwrite_malformed_settings() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let settings = Settings::new(path.clone());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(settings.update(&json!({"defaultAutoPull":true})).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_mutations_are_atomic_with_patch_and_manage_secrets() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = dir.join("settings.json");
        let settings = Settings::new(path.clone());
        let mutation = json!({"operation":"create", "instanceId":"work", "instance":{"driver":"codex", "config":{"homePath":"/tmp/work"}, "environment":[{"name":"API_KEY","value":"fixture-secret","sensitive":true}]}});
        let created = settings
            .update_with_provider_mutation(&json!({"defaultAutoPull":true}), &mutation)
            .unwrap();
        assert_eq!(created["defaultAutoPull"], true);
        assert_eq!(
            created["providerInstances"]["work"]["environment"][0]["value"],
            ""
        );
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(!stored.contains("fixture-secret"));
        assert!(
            matches!(settings.update_with_provider_mutation(&json!({"defaultAutoPull":false}), &mutation), Err(SettingsUpdateError::InstanceExists(id)) if id == "work")
        );
        assert_eq!(settings.snapshot()["defaultAutoPull"], true);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), stored);
        let removed = settings
            .update_with_provider_mutation(
                &json!({}),
                &json!({"operation":"remove","instanceId":"work"}),
            )
            .unwrap();
        assert!(removed["providerInstances"].get("work").is_none());
        assert!(!dir
            .join("secrets")
            .join(format!(
                "provider-env-{}-{}.bin",
                encode("work"),
                encode("API_KEY")
            ))
            .exists());
        assert!(matches!(
            settings.update_with_provider_mutation(
                &json!({}),
                &json!({"operation":"create","instanceId":"../bad","instance":{"driver":"codex"}})
            ),
            Err(SettingsUpdateError::InvalidMutation)
        ));
        drop(settings);
        let _ = std::fs::remove_dir_all(dir);
    }
}
