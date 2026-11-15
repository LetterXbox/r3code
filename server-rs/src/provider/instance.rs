//! Resolve a configured provider instance before starting its process.
use super::CodexLaunch;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub(crate) fn home_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var_os("HOME").ok_or("Cannot expand provider home path")?;
        let base = PathBuf::from(home);
        return Ok(if path == "~" {
            base
        } else {
            base.join(&path[2..])
        });
    }
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path))
    }
}

pub fn configured_shadow_home(config: &Value) -> Result<Option<PathBuf>, String> {
    config["shadowHomePath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(home_path)
        .transpose()
}

fn launch_args_override(
    managed: bool,
    ceiling: bool,
    instance: Option<String>,
    host: Option<String>,
) -> Option<String> {
    if ceiling {
        // Instance values have already been replaced by the policy overlay.
        instance
    } else {
        instance.or(if managed { None } else { host })
    }
}

/// Apply instance settings to a base launch. Unknown instances and unresolved
/// credentials are errors: silently inheriting the ambient account is unsafe.
pub fn resolve_codex_launch(
    settings_path: Option<&Path>,
    instance_id: &str,
    launch: CodexLaunch,
) -> Result<CodexLaunch, String> {
    resolve_codex_launch_with_secrets(settings_path, instance_id, launch, None)
}

/// Resolve references only from the private runtime cache; never persist hydrated values.
pub fn resolve_codex_launch_with_secrets(
    settings_path: Option<&Path>,
    instance_id: &str,
    launch: CodexLaunch,
    secrets: Option<&super::secret_store::SecretStore>,
) -> Result<CodexLaunch, String> {
    resolve_codex_launch_tracked(settings_path, instance_id, launch, secrets)
        .map(|(launch, _)| launch)
}

pub fn resolve_codex_launch_tracked(
    settings_path: Option<&Path>,
    instance_id: &str,
    launch: CodexLaunch,
    secrets: Option<&super::secret_store::SecretStore>,
) -> Result<(CodexLaunch, Vec<(String, String)>), String> {
    resolve_codex_launch_inner(settings_path, instance_id, launch, secrets, true)
}

/// Resolve process identity for switch planning without reading environment credentials.
pub fn resolve_codex_identity(
    settings_path: Option<&Path>,
    instance_id: &str,
    launch: CodexLaunch,
) -> Result<CodexLaunch, String> {
    resolve_codex_launch_inner(settings_path, instance_id, launch, None, false)
        .map(|(launch, _)| launch)
}

fn resolve_codex_launch_inner(
    settings_path: Option<&Path>,
    instance_id: &str,
    mut launch: CodexLaunch,
    secrets: Option<&super::secret_store::SecretStore>,
    require_secrets: bool,
) -> Result<(CodexLaunch, Vec<(String, String)>), String> {
    let mut references = Vec::new();
    let ceiling = crate::managed_policy::runtime_ceiling()?.is_some();
    if ceiling {
        launch.env.remove("T3CODE_CODEX_LAUNCH_ARGS");
    }
    let mut settings = super::session_registry::read_provider_settings(settings_path)?;
    if let Some(path) = settings_path {
        crate::settings::materialize_secrets(path, &mut settings)?;
    }
    let entry = settings
        .get("providerInstances")
        .and_then(Value::as_object)
        .and_then(|m| m.get(instance_id));
    if entry.is_none() && instance_id != "codex" {
        return Err(format!(
            "No orchestration provider adapter is registered for {instance_id}."
        ));
    }
    let default_entry = serde_json::json!({"driver":"codex"});
    let entry = entry.unwrap_or(&default_entry);
    if entry["driver"] != "codex" {
        return Err(format!(
            "Provider instance {instance_id} is not a Codex instance."
        ));
    }
    let config = &entry["config"];
    // Managed OAuth credentials must only reach a provider through the private
    // token broker. Until that runtime is available, never fall back to the
    // regular CLI's ambient account or a user-supplied home.
    if config["setupMode"] == "managed" {
        if entry["enabled"] == false || config["enabled"] == false {
            return Err(format!("Provider instance {instance_id} is disabled."));
        }
        #[cfg(unix)]
        if !require_secrets {
            launch.home = Some(
                match config["homePath"].as_str().filter(|s| !s.trim().is_empty()) {
                    Some(path) => home_path(path)?,
                    None => crate::codex_shadow_home::shared_home()
                        .map_err(|_| "Cannot determine Codex home")?,
                },
            );
            return Ok((launch, references));
        }
        return Err("Managed Codex provider sessions require the server runtime.".into());
    }
    if let Some(binary) = config["binaryPath"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        launch.binary = Some(if binary == "~" || binary.starts_with("~/") {
            home_path(binary)?
        } else {
            PathBuf::from(binary)
        });
    }
    if entry["enabled"] == false || config["enabled"] == false {
        return Err(format!("Provider instance {instance_id} is disabled."));
    }
    if let Some(home) = config["homePath"].as_str().filter(|s| !s.trim().is_empty()) {
        launch.home = Some(home_path(home)?);
    }
    if let Some(shadow) = config["shadowHomePath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        #[cfg(unix)]
        {
            let shared = match &launch.home {
                Some(home) => home.clone(),
                None => crate::codex_shadow_home::shared_home()
                    .map_err(|_| "Cannot determine Codex home")?,
            };
            let shadow = home_path(shadow)?;
            if require_secrets {
                crate::codex_shadow_home::materialize(&shared, &shadow)
                    .map_err(|e| format!("Could not prepare Codex shadow home: {e}"))?;
                launch.home = Some(shadow);
            } else {
                launch.home = Some(shared);
            }
        }
        #[cfg(not(unix))]
        return Err("Codex shadow homes are unavailable on this platform.".into());
    }
    // A custom instance must identify its account explicitly; otherwise it could
    // accidentally reuse the default user's ambient CODEX_HOME.
    if instance_id != "codex"
        && launch.home.is_none()
        && entry["environment"].as_array().is_none_or(|values| {
            !values.iter().any(|value| {
                value["name"].as_str().is_some_and(|name| {
                    if cfg!(windows) {
                        name.eq_ignore_ascii_case("CODEX_HOME")
                    } else {
                        name == "CODEX_HOME"
                    }
                })
            })
        })
    {
        return Err(format!(
            "Provider instance {instance_id} requires an explicit Codex home path."
        ));
    }
    if let Some(vars) = entry["environment"].as_array() {
        for var in vars {
            let name = var["name"].as_str().ok_or("Invalid provider environment")?;
            if name.is_empty()
                || name.len() > 128
                || !name.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                return Err("Invalid provider environment".into());
            }
            let value = if let Some(reference) = var.get("secret") {
                let provider = reference["provider"]
                    .as_str()
                    .ok_or("Invalid secret reference")?;
                let path = reference["reference"]
                    .as_str()
                    .ok_or("Invalid secret reference")?;
                references.push((provider.to_owned(), path.to_owned()));
                secrets
                    .and_then(|store| store.get(provider, path).ok().flatten())
                    .or_else(|| (!require_secrets).then(String::new))
                    .ok_or("Provider instance contains unresolved environment credentials.")?
            } else {
                var["value"]
                    .as_str()
                    .ok_or("Invalid provider environment")?
                    .to_owned()
            };
            if if cfg!(windows) {
                name.eq_ignore_ascii_case("CODEX_HOME")
            } else {
                name == "CODEX_HOME"
            } {
                if crate::managed_policy::pinned_provider_environment("codex", name)?.as_deref()
                    != Some(value.as_str())
                {
                    return Err(
                        "Set Codex home with homePath rather than provider environment.".into(),
                    );
                }
                // A locked pin removed conflicting home settings from the
                // effective configuration. An unlocked environment default
                // yields to an explicit homePath or shadowHomePath.
                if launch.home.is_none() {
                    launch.home = Some(home_path(&value)?);
                }
                continue;
            }
            launch.env.insert(name.to_owned(), value);
        }
    }
    // Instance environment has the same precedence as the spawned process's
    // environment. A blank override falls back to the configured arguments.
    let managed = crate::managed_policy::has_policy()?;
    let instance_args = launch.env.get("T3CODE_CODEX_LAUNCH_ARGS").cloned();
    // Every policy blocks host launch overrides. An instance-specific value
    // is policy-owned when a ceiling locks provider launch configuration.
    if managed && instance_args.is_none() {
        launch.env_remove.push("T3CODE_CODEX_LAUNCH_ARGS".into());
    }
    let env_args = launch_args_override(
        managed,
        ceiling,
        instance_args,
        std::env::var("T3CODE_CODEX_LAUNCH_ARGS").ok(),
    );
    let configured_args = config["launchArgs"].as_str().unwrap_or("");
    let args = env_args
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| configured_args.trim());
    if !args.is_empty() {
        launch
            .args
            .extend(shlex::split(args).ok_or("Invalid Codex launch arguments")?);
    }
    Ok((launch, references))
}

#[cfg(test)]
mod tests {
    #[test]
    fn policy_blocks_host_launch_args_and_ceiling_blocks_instance_override() {
        let host = Some("host".to_owned());
        assert_eq!(
            super::launch_args_override(false, false, None, host.clone()),
            host
        );
        assert_eq!(
            super::launch_args_override(true, false, None, host.clone()),
            None
        );
        assert_eq!(
            super::launch_args_override(true, false, Some("instance".into()), host.clone())
                .as_deref(),
            Some("instance")
        );
        assert_eq!(
            super::launch_args_override(true, true, Some("admin-pinned".into()), host),
            Some("admin-pinned".into())
        );
    }

    use super::*;
    #[cfg(unix)]
    #[test]
    fn explicit_shadow_home_shares_sessions_and_keeps_auth_private() {
        let root =
            std::env::temp_dir().join(format!("t3-shadow-instance-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let shadow = root.join("shadow");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&shadow).unwrap();
        std::fs::write(shared.join("auth.json"), "shared credential").unwrap();
        std::fs::write(shadow.join("auth.json"), "private credential").unwrap();
        let path = root.join("settings.json");
        std::fs::write(&path, serde_json::json!({"providerInstances":{"work":{"driver":"codex","config":{"homePath":shared,"shadowHomePath":shadow}}}}).to_string()).unwrap();
        let identity = resolve_codex_identity(Some(&path), "work", CodexLaunch::default()).unwrap();
        assert_eq!(identity.home.as_deref(), Some(shared.as_path()));
        let launch = resolve_codex_launch(Some(&path), "work", CodexLaunch::default()).unwrap();
        assert_eq!(launch.home.as_deref(), Some(shadow.as_path()));
        std::fs::write(shadow.join("sessions/continuation"), "continued").unwrap();
        assert_eq!(
            std::fs::read_to_string(shared.join("sessions/continuation")).unwrap(),
            "continued"
        );
        assert_eq!(
            std::fs::read_to_string(shadow.join("auth.json")).unwrap(),
            "private credential"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn managed_instances_cannot_fall_back_to_ambient_codex_credentials() {
        let dir = std::env::temp_dir().join(format!("t3-managed-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"providerInstances":{"codex":{"driver":"codex","config":{"setupMode":"managed","homePath":"/tmp/codex-user"}}}}"#).unwrap();
        assert!(resolve_codex_launch(Some(&path), "codex", CodexLaunch::default()).is_err());
        assert!(resolve_codex_identity(Some(&path), "codex", CodexLaunch::default()).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn runtime_reference_hydration_is_private_and_fail_closed() {
        let dir = std::env::temp_dir().join(format!("t3-hydrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let raw = r#"{"providerInstances":{"codex":{"driver":"codex","environment":[{"name":"TOKEN","value":"","secret":{"provider":"vault","reference":"op://v/i/f"}}]}}}"#;
        std::fs::write(&path, raw).unwrap();
        let store = super::super::secret_store::SecretStore::default();
        assert!(resolve_codex_identity(Some(&path), "codex", CodexLaunch::default()).is_ok());
        assert!(resolve_codex_launch_with_secrets(
            Some(&path),
            "codex",
            CodexLaunch::default(),
            Some(&store)
        )
        .is_err());
        store
            .apply("vault", "op://v/i/f", "private".into())
            .unwrap();
        let launch = resolve_codex_launch_with_secrets(
            Some(&path),
            "codex",
            CodexLaunch::default(),
            Some(&store),
        )
        .unwrap();
        assert_eq!(launch.env["TOKEN"], "private");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_unknown_and_disabled_instances_and_isolates_homes() {
        let dir =
            std::env::temp_dir().join(format!("t3-provider-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path,r#"{"providerInstances":{"work":{"driver":"codex","config":{"homePath":"/tmp/codex-work"},"environment":[{"name":"MY_VAR","value":"value"}]},"off":{"driver":"codex","enabled":false}}}"#).unwrap();
        let work = resolve_codex_launch(Some(&path), "work", CodexLaunch::default()).unwrap();
        assert_eq!(work.home, Some(PathBuf::from("/tmp/codex-work")));
        assert_eq!(work.env["MY_VAR"], "value");
        assert!(resolve_codex_launch(Some(&path), "off", CodexLaunch::default()).is_err());
        assert!(resolve_codex_launch(Some(&path), "unknown", CodexLaunch::default()).is_err());
        assert!(resolve_codex_launch(Some(&path), "codex", CodexLaunch::default()).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn applies_binary_and_shell_quoted_launch_args_with_instance_override() {
        let dir =
            std::env::temp_dir().join(format!("t3-provider-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"providerInstances":{"work":{"driver":"codex","config":{"homePath":"/tmp/codex-work","binaryPath":"/opt/custom codex","launchArgs":"--profile 'work account'"},"environment":[{"name":"T3CODE_CODEX_LAUNCH_ARGS","value":"-c 'model=x y'"}]}}}"#).unwrap();
        let launch = resolve_codex_launch(Some(&path), "work", CodexLaunch::default()).unwrap();
        assert_eq!(launch.binary, Some(PathBuf::from("/opt/custom codex")));
        assert_eq!(launch.args, ["-c", "model=x y"]);
        std::fs::write(&path, r#"{"providerInstances":{"work":{"driver":"codex","config":{"homePath":"/tmp/codex-work","launchArgs":"--profile 'work account'"},"environment":[{"name":"T3CODE_CODEX_LAUNCH_ARGS","value":" "}]}}}"#).unwrap();
        let launch = resolve_codex_launch(Some(&path), "work", CodexLaunch::default()).unwrap();
        assert_eq!(launch.args, ["--profile", "work account"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_malformed_launch_args() {
        let dir =
            std::env::temp_dir().join(format!("t3-provider-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"providerInstances":{"codex":{"driver":"codex","environment":[{"name":"T3CODE_CODEX_LAUNCH_ARGS","value":"'unclosed"}]}}}"#).unwrap();
        assert!(resolve_codex_launch(Some(&path), "codex", CodexLaunch::default()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stored_sensitive_environment_reaches_provider_only() {
        let dir =
            std::env::temp_dir().join(format!("t3-provider-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let settings = crate::settings::Settings::new(path.clone());
        let snapshot = settings.update(&serde_json::json!({"providerInstances":{"codex":{"driver":"codex","environment":[{"name":"MY_SECRET","sensitive":true,"value":"private-value"}]}}})).unwrap();
        assert!(!snapshot.to_string().contains("private-value"));
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("private-value"));
        let launch = resolve_codex_launch(Some(&path), "codex", CodexLaunch::default()).unwrap();
        assert_eq!(launch.env["MY_SECRET"], "private-value");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
