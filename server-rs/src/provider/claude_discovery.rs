//! Bounded, read-only Claude CLI readiness probe.
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};
use super::secret_store::SecretStore;

fn configured_endpoint(home: Option<&Path>, env: &[(String, String)]) -> Option<String> {
    let configured_home = home.map(Path::to_path_buf).or_else(|| env.iter().find(|(k,_)| k == "CLAUDE_CONFIG_DIR").map(|(_,v)| PathBuf::from(v))).or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)).or_else(|| std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".claude")));
    let managed = if cfg!(target_os="macos") { PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json") } else { PathBuf::from("/etc/claude-code/managed-settings.json") };
    let mut endpoint = None;
    for path in configured_home.into_iter().map(|p| p.join("settings.json")).chain(std::iter::once(managed)) {
        if std::fs::metadata(&path).ok().is_none_or(|m| m.len() > 1024 * 1024) { continue; }
        if let Some(value) = std::fs::read(path).ok().and_then(|data| crate::lenient_json::parse::<Value>(&data).ok()).and_then(|v| v.pointer("/env/ANTHROPIC_BASE_URL").and_then(Value::as_str).map(str::to_owned)) { endpoint = Some(value); }
    }
    endpoint.or_else(|| env.iter().find(|(k,_)| k == "ANTHROPIC_BASE_URL").map(|(_,v)| v.clone())).or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok())
}
fn custom_endpoint(base_url: Option<&str>) -> Option<url::Url> {
    base_url.and_then(|v| url::Url::parse(v.trim()).ok()).filter(|v| matches!(v.scheme(),"http"|"https") && v.host_str().is_some_and(|host| !host.eq_ignore_ascii_case("api.anthropic.com")))
}

fn update_checks_enabled(settings_path: Option<&Path>) -> bool {
    settings_path
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| crate::lenient_json::parse::<Value>(&bytes).ok())
        .and_then(|v| v.get("enableProviderUpdateChecks").and_then(Value::as_bool))
        .unwrap_or(true)
}

fn state_dir_from_settings(settings_path: Option<&Path>) -> Option<PathBuf> {
    let parent = settings_path?.parent()?;
    if parent.file_name().and_then(|n| n.to_str()) == Some("userdata") {
        parent.parent().map(Path::to_path_buf)
    } else {
        Some(parent.to_path_buf())
    }
}

fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

enum Maintenance {
    Native(PathBuf),
    Npm { executable: PathBuf, prefix: PathBuf },
    Mise(PathBuf),
}

impl Maintenance {
    fn resolve(entry: &Value) -> Option<Self> {
        // An instance-specific PATH can select a different binary than the
        // host's package manager. Require an explicit path for that case.
        let configured = entry["config"]["binaryPath"]
            .as_str().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("claude");
        if !configured.contains('/') && entry["environment"].as_array().is_some_and(|env| {
            env.iter().any(|item| item["name"] == "PATH")
        }) {
            return None;
        }
        let home = std::env::var("HOME").ok();
        let launcher = super::path_resolve::resolve_binary(Some(configured), "claude", home.as_deref())?;
        let binary = launcher.canonicalize().ok()?;
        let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| Path::new(home).join(".local/share")))?;
        let versions = data_home.join("claude/versions");
        if versions.canonicalize().is_ok_and(|versions| binary.parent() == Some(versions.as_path()))
            && launcher != binary
        {
            return Some(Self::Native(launcher));
        }
        let mise_data = std::env::var_os("MISE_DATA_DIR").map(PathBuf::from)
            .unwrap_or_else(|| data_home.join("mise"));
        if launcher == mise_data.join("shims/claude") {
            let mise = super::path_resolve::which("mise", home.as_deref())?;
            let mut probe = Command::new(&mise);
            probe.args(["which", "claude"]);
            if let Some(home) = &home {
                probe.current_dir(home);
            }
            let result = crate::vcs_worktree::run_command(&mut probe, Duration::from_secs(2)).ok()?;
            let resolved = std::str::from_utf8(&result.stdout).ok()?.trim();
            if result.status.success() && Path::new(resolved).starts_with(mise_data.join("installs/claude")) {
                return Some(Self::Mise(mise));
            }
            return None;
        }
        let package = binary.parent()?;
        if package.file_name()? != "claude-code" || package.parent()?.file_name()? != "@anthropic-ai" {
            return None;
        }
        let modules = package.parent()?.parent()?;
        if modules.file_name()? != "node_modules" || modules.parent()?.file_name()? != "lib" {
            return None;
        }
        let prefix = modules.parent()?.parent()?.to_owned();
        if launcher.parent().and_then(|dir| dir.canonicalize().ok())? != prefix.join("bin").canonicalize().ok()? {
            return None;
        }
        let npm = prefix.join("bin/npm");
        let executable = if super::path_resolve::is_executable_file(&npm) {
            npm
        } else {
            super::path_resolve::which("npm", home.as_deref())?
        };
        Some(Self::Npm { executable, prefix })
    }

    fn command(&self) -> Command {
        match self {
            Self::Native(binary) => {
                let mut command = Command::new(binary);
                command.arg("update");
                command
            }
            Self::Npm { executable, prefix } => {
                let mut command = Command::new(executable);
                command.args(["install", "--global", "--prefix"]).arg(prefix)
                    .arg("@anthropic-ai/claude-code@latest");
                command
            }
            Self::Mise(executable) => {
                let mut command = Command::new(executable);
                command.args(["upgrade", "claude"]);
                command
            }
        }
    }

    fn display_command(&self) -> Option<String> {
        let command = self.command();
        let words = std::iter::once(command.get_program()).chain(command.get_args());
        let words = words.map(|word| word.to_str()).collect::<Option<Vec<_>>>()?;
        shlex::try_join(words).ok()
    }

    fn latest_version(&self) -> Option<String> {
        if let Self::Mise(executable) = self {
            let mut command = Command::new(executable);
            command.args(["latest", "claude"]);
            if let Some(home) = std::env::var_os("HOME") {
                command.current_dir(home);
            }
            let result = crate::vcs_worktree::run_command(&mut command, Duration::from_secs(5)).ok()?;
            let version = std::str::from_utf8(&result.stdout).ok()?.trim();
            return (result.status.success() && parse_semver(version).is_some()).then(|| version.to_owned());
        }
        let native = matches!(self, Self::Native(_));
        let url = if native {
            format!("https://downloads.claude.ai/claude-code-releases/{}", native_channel())
        } else {
            "https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest".to_owned()
        };
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
            runtime.block_on(async {
                let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
                let text = client.get(url).send().await.ok()?.error_for_status().ok()?.text().await.ok()?;
                let version = if native {
                    text.trim().to_owned()
                } else {
                    serde_json::from_str::<Value>(&text).ok()?["version"].as_str()?.to_owned()
                };
                parse_semver(&version)?;
                Some(version)
            })
        }).join().ok().flatten()
    }
}

fn native_channel() -> &'static str {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")));
    let managed = if cfg!(target_os = "macos") {
        Path::new("/Library/Application Support/ClaudeCode")
    } else {
        Path::new("/etc/claude-code")
    };
    let mut paths: Vec<PathBuf> = config.into_iter().map(|dir| dir.join("settings.json")).collect();
    paths.push(managed.join("managed-settings.json"));
    let mut drop_ins: Vec<_> = std::fs::read_dir(managed.join("managed-settings.d"))
        .into_iter().flatten().filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| !name.starts_with('.') && name.ends_with(".json")))
        .map(|entry| entry.path()).collect();
    drop_ins.sort();
    paths.extend(drop_ins);
    paths.into_iter().rev().find_map(|path| {
        if std::fs::metadata(&path).ok()?.len() > 1_048_576 {
            return None;
        }
        let data = std::fs::read(path).ok()?;
        let settings = crate::lenient_json::parse::<Value>(&data).ok()?;
        match settings["autoUpdatesChannel"].as_str()? {
            "stable" => Some("stable"),
            "latest" => Some("latest"),
            _ => None,
        }
    }).unwrap_or("latest")
}

pub(crate) fn update(entry: &Value) -> Result<(), String> {
    static UPDATING_CLAUDE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = UPDATING_CLAUDE.lock().map_err(|_| "Claude maintenance is unavailable.")?;
    crate::managed_policy::check_provider_allowed("claudeAgent")?;
    let maintenance = Maintenance::resolve(entry)
        .ok_or("This Claude installation is not managed by an updater supported by R3.")?;
    let mut command = maintenance.command();
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    command.stdin(Stdio::null());
    let result = crate::vcs_worktree::run_command(&mut command, Duration::from_secs(180))
        .map_err(|error| format!("Could not run the Claude updater: {error}"))?;
    if result.status.success() {
        Ok(())
    } else {
        Err(format!("The Claude updater exited with {}.", result.status))
    }
}

pub(crate) fn discover(
    cwd: &Path,
    id: &str,
    entry: &Value,
    settings_path: Option<&Path>,
    secrets: Option<&SecretStore>,
) -> Value {
    let update_checks = update_checks_enabled(settings_path);
    let state_dir = state_dir_from_settings(settings_path);
    let checked = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut result = json!({"instanceId":id,"driver":"claudeAgent","displayName":entry["displayName"].as_str().map(str::trim).filter(|v| !v.is_empty()).unwrap_or("Claude"),"showInteractionModeToggle":true,"reportsContextWindow":true,"enabled":true,"installed":false,"version":null,"status":"error","auth":{"status":"unknown"},"setup":{"canAuthenticate":false,"canInstall":false},"checkedAt":checked,"models":[],"skills":[],"slashCommands":[{"name":"compact","description":"Summarize the conversation and reduce context usage"}]});
    result["models"] = super::claude_capabilities::discovered_with_catalog(&Value::Null, None, None, &entry["config"]["customModels"], state_dir.as_deref(), update_checks).0;
    result["versionAdvisory"] = json!({"status":"unknown","currentVersion":null,"latestVersion":null,"updateCommand":null,"canUpdate":false,"canInstallVersion":false,"checkedAt":checked,"message":null});
    if let Some(color) = entry.get("accentColor") { result["accentColor"] = color.clone(); }
    if entry["enabled"] == false || entry["config"]["enabled"] == false { result["enabled"] = json!(false); result["status"] = json!("disabled"); result["message"] = json!("Claude is disabled in T3 Code settings."); return result; }
    if let Err(message) = crate::managed_policy::check_provider_allowed("claudeAgent") { result["availability"] = json!("unavailable"); result["unavailableReason"] = json!(message); return result; }
    let configured = entry["config"]["binaryPath"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("claude");
    let binary: PathBuf = if configured == "~" || configured.starts_with("~/") { match super::instance::home_path(configured) { Ok(path) => path, Err(_) => { result["message"] = json!("Invalid Claude CLI binary path."); return result; } } } else { configured.into() };
    let mut env = Vec::<(String,String)>::new();
    for item in entry["environment"].as_array().into_iter().flatten() {
        let Some(name) = item["name"].as_str().filter(|s| !s.is_empty() && s.len() <= 128 && s.chars().enumerate().all(|(i,c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))) else { result["message"] = json!("Invalid provider environment."); return result };
        let value = if let Some(reference) = item.get("secret").filter(|v| !v.is_null()) {
            let Some(value) = reference["provider"].as_str().zip(reference["reference"].as_str()).and_then(|(provider,path)| secrets.and_then(|s| s.get(provider,path).ok().flatten())) else { result["message"] = json!("Provider instance contains unresolved environment credentials."); return result }; value
        } else { let Some(value) = item["value"].as_str() else { result["message"] = json!("Invalid provider environment."); return result }; value.to_owned() };
        env.push((name.to_owned(),value));
    }
    let home = match entry["config"]["homePath"].as_str().filter(|v| !v.trim().is_empty()).map(super::instance::home_path).transpose() { Ok(home)=>home,Err(_)=>{ result["message"] = json!("Invalid Claude configuration directory."); return result; } };
    let continuation_home = home.clone().or_else(|| env.iter().find(|(k,v)|k=="CLAUDE_CONFIG_DIR" && !v.trim().is_empty()).map(|(_,v)|PathBuf::from(v.trim()))).or_else(||std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|v|!v.trim().is_empty()).map(|v|PathBuf::from(v.trim()))).or_else(||std::env::var_os("HOME").map(|v|PathBuf::from(v).join(".claude")));
    if let Some(path)=continuation_home { if let Ok(path)=std::path::absolute(path) {result["continuation"]=json!({"groupKey":format!("claude:home:{}",path.display())});} }
    let build_command = |args: &[&str]| {
        let mut command = Command::new(&binary); command.current_dir(cwd).args(args).stdin(Stdio::null());
        for key in ["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_HOST_SESSION_ID","CLAUDE_CODE_CHILD_SESSION","CLAUDE_CODE_SESSION_ATTENDED","CLAUDE_CODE_MESSAGING_SOCKET","CLAUDE_CODE_MESSAGING_TOKEN","CLAUDE_CODE_EXECPATH","CLAUDE_CODE_DESKTOP_APP_VERSION","CLAUDE_EFFORT","CLAUDE_PID","CLAUDE_AGENT_SDK_VERSION","ELECTRON_RUN_AS_NODE"] { command.env_remove(key); }
        command.env("CLAUDE_CODE_ENTRYPOINT","t3-code").envs(env.iter().map(|(k,v)|(k,v)));
        if let Some(home) = &home { command.env("CLAUDE_CONFIG_DIR",home); }
        command
    };
    let command = |args: &[&str]| crate::vcs_worktree::run_command(&mut build_command(args),Duration::from_secs(if args == ["--version"] {20} else {5}));
    let version = match command(&["--version"]) {
        Ok(output) => output,
        Err(e) => { result["installed"] = json!(e.kind() != std::io::ErrorKind::NotFound); result["message"] = json!(if e.kind() == std::io::ErrorKind::NotFound { "Claude Agent CLI (`claude`) was not found on PATH." } else if e.kind() == std::io::ErrorKind::TimedOut { "Claude Agent CLI is installed but failed to run. Timed out while running command." } else { "Failed to execute Claude Agent CLI health check." }); return result; }
    };
    result["installed"] = json!(true);
    let version_text = String::from_utf8_lossy(&version.stdout);
    if let Some(value) = regex::Regex::new(r"\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?").unwrap().find(&version_text) { result["version"] = json!(value.as_str()); }
    let advisory_status = result["version"].as_str().filter(|v|v.split('.').count()==3 && v.split('.').all(|p|!p.is_empty() && p.chars().all(|c|c.is_ascii_digit()))).and_then(|v| {let parts:Vec<u64>=v.split('.').map(|s|s.parse().ok()).collect::<Option<_>>()?; Some(if parts >= vec![2,1,280] {"supported"} else if parts >= vec![2,1,111] {"graceful"} else {"unsupported"})}).unwrap_or("unknown");
    let advisory_message=match advisory_status {"graceful"=>Some("This provider version has limited compatibility with this T3 Code release. Use >=2.1.301."),"unsupported"=>Some("This provider version is outside the supported range for this T3 Code release. Use >=2.1.301."),_=>None};
    result["compatibilityAdvisory"]=json!({"status":advisory_status,"message":advisory_message,"recommendedVersion":null,"recommendedRange":">=2.1.301"});
    result["versionAdvisory"]["currentVersion"] = result["version"].clone();
    if version.status.success() {
        if let Some(maintenance) = Maintenance::resolve(entry) {
            result["versionAdvisory"]["canUpdate"] = json!(true);
            result["versionAdvisory"]["updateCommand"] = json!(maintenance.display_command());
            if update_checks {
                if let Some((latest, relation)) = maintenance.latest_version().and_then(|latest| {
                    let current = parse_semver(result["version"].as_str()?)?;
                    let behind = current < parse_semver(&latest)?;
                    Some((latest, if behind { "behind_latest" } else { "current" }))
                }) {
                    result["versionAdvisory"]["latestVersion"] = json!(latest);
                    result["versionAdvisory"]["status"] = json!(relation);
                }
            }
        }
    }
    if !version.status.success() { result["message"] = json!("Claude Agent CLI is installed but failed to run."); return result; }
    let (models, commands, update) = super::claude_capabilities::discovered_with_catalog(&Value::Null, None, result["version"].as_str(), &entry["config"]["customModels"], state_dir.as_deref(), update_checks);
    result["models"] = models; result["slashCommands"] = commands; if update.as_array().is_some_and(|v| !v.is_empty()) {result["updateRequiredModels"] = update;}
    result["status"] = json!("warning"); result["message"] = json!("Could not verify Claude authentication status from initialization result.");
    let mut sdk = build_command(&["--output-format","stream-json","--input-format","stream-json","--verbose","--tools","","--setting-sources","user,project,local","--settings",r#"{"disableAllHooks":true}"#,"--no-session-persistence","--permission-mode","dontAsk"]);
    let managed_mcp = if cfg!(target_os="macos") { "/Library/Application Support/ClaudeCode/managed-mcp.json" } else { "/etc/claude-code/managed-mcp.json" };
    if !Path::new(managed_mcp).exists() { sdk.arg("--strict-mcp-config"); }
    sdk.env("ENABLE_CLAUDEAI_MCP_SERVERS","false").env_remove("FORCE_CODE_TERMINAL").env("CLAUDE_CODE_AUTO_CONNECT_IDE","0").env("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL","1");
    match super::claude_capabilities::probe(sdk) {
      Ok((init,usage,settings)) => {
        let (models, commands, update) = super::claude_capabilities::discovered_with_catalog(&init, settings.as_ref(), result["version"].as_str(), &entry["config"]["customModels"], state_dir.as_deref(), update_checks);
        result["models"] = models; result["slashCommands"] = commands; if update.as_array().is_some_and(|v| !v.is_empty()) {result["updateRequiredModels"] = update;}
        let account=&init["account"];
        let base_url=configured_endpoint(home.as_deref(), &env);
        let endpoint=custom_endpoint(base_url.as_deref());
        let authenticated = endpoint.is_some() || account["apiProvider"].as_str().is_some_and(|v|v != "firstParty") || account["tokenSource"].as_str().is_none_or(|v|v != "none") || account["apiKeySource"].as_str().is_some_and(|v|v != "none" && !v.is_empty()) || account["email"].as_str().is_some_and(|v|!v.is_empty()) || account["subscriptionType"].as_str().is_some_and(|v|!v.is_empty());
        if authenticated {
            result["status"]=json!("ready"); result["auth"]["status"]=json!("authenticated"); result.as_object_mut().unwrap().remove("message");
            for field in ["email","workspaceId"] { if let Some(value)=account.get(field).filter(|v|v.as_str().is_some_and(|s|!s.is_empty())) { result["auth"][field]=value.clone(); } }
            if account["apiProvider"] == "bedrock" {result["auth"]["type"]=json!("bedrock"); result["auth"]["label"]=json!("Amazon Bedrock");}
            else if let Some(endpoint)=endpoint { result["auth"]["type"]=json!("customEndpoint"); result["auth"]["label"]=json!("Custom API endpoint"); result["auth"]["endpoint"]=json!(endpoint.origin().ascii_serialization()); }
            else if let Some(method)=account["tokenSource"].as_str() {
                let normalized=method.to_lowercase().replace([' ', '_', '-'], "");
                if ["apikey","anthropicapikey","anthropicauthtoken"].contains(&normalized.as_str()) {result["auth"]["type"]=json!("apiKey");result["auth"]["label"]=json!("Claude API Key");}
            }
            if result["auth"].get("type").is_none() { if let Some(subscription)=account["subscriptionType"].as_str().filter(|v|!v.is_empty()) {
                let normalized=subscription.to_lowercase().replace([' ', '_', '-'], "");
                let label=match normalized.as_str() {"claudemaxsubscription"|"claudemax5xsubscription"|"max"|"maxplan"|"max5"=>"Max".to_owned(),"claudemax20xsubscription"|"max20"=>"Ultra".to_owned(),"claudeenterprisesubscription"|"enterprise"=>"Enterprise".to_owned(),"claudeteamsubscription"|"team"=>"Team".to_owned(),"claudeprosubscription"|"pro"=>"Pro".to_owned(),"claudefreesubscription"|"free"=>"Free".to_owned(),_=>subscription.split([' ', '_', '-']).filter(|p|!p.is_empty()).map(|p|{let mut c=p.chars();c.next().map(|x|x.to_uppercase().collect::<String>()+&c.as_str().to_lowercase()).unwrap_or_default()}).collect::<Vec<_>>().join(" ")};
                let key=label.to_lowercase().replace([' ', '_', '-'], "");
                let label=if key.starts_with("claude") && key.ends_with("subscription") {label} else if key.starts_with("claude") {format!("{label} Subscription")} else if key.ends_with("subscription") {format!("Claude {label}")} else {format!("Claude {label} Subscription")};
                result["auth"]["type"]=json!(subscription); result["auth"]["label"]=json!(label);
            }}
            result["usageLimits"]=usage.as_ref().map(|v|super::claude_capabilities::usage(v,&checked)).unwrap_or_else(||json!({"checkedAt":checked,"windows":[],"unavailable":{"reason":"probeFailed"}}));
        } else {
            result["status"]=json!("error"); result["auth"]["status"]=json!("unauthenticated"); result["message"]=json!("Claude Code is not authenticated. Run `claude auth login` and try again.");
        }
      }
      Err(super::claude_capabilities::ProbeError::Failed) => result["message"]=json!("Claude Agent CLI failed while checking account status."),
      Err(super::claude_capabilities::ProbeError::TimedOut) => result["message"]=json!("Timed out after 25s while checking Claude account status."),
    }
    result
}

#[cfg(all(test,unix))]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn maintenance_uses_the_npm_prefix_that_owns_the_launcher() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = std::env::temp_dir().join(format!("t3-claude-maintenance-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let bin = dir.join("bin");
        let package = dir.join("lib/node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        let cli = package.join("cli.js");
        let npm = bin.join("npm");
        let launcher = bin.join("claude");
        for script in [&cli, &npm] {
            std::fs::write(script, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        symlink(&cli, &launcher).unwrap();
        let install = Maintenance::resolve(&json!({"config":{"binaryPath":launcher}})).unwrap();
        let command = install.command();
        assert_eq!(command.get_program(), npm.as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["install".as_ref(), "--global".as_ref(), "--prefix".as_ref(), dir.as_os_str(), "@anthropic-ai/claude-code@latest".as_ref()]);
        assert!(Maintenance::resolve(&json!({"config":{"binaryPath":cli}})).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn custom_endpoint_reads_private_claude_settings_before_environment() {
        let dir = std::env::temp_dir().join(format!("t3-claude-home-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("settings.json"),r#"{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example.test/api"}}"#).unwrap();
        let value=configured_endpoint(Some(&dir), &[("ANTHROPIC_BASE_URL".into(),"https://api.anthropic.com".into())]);
        assert_eq!(custom_endpoint(value.as_deref()).unwrap().host_str(),Some("proxy.example.test"));
        assert!(custom_endpoint(Some("https://api.anthropic.com")).is_none());
        assert!(custom_endpoint(Some("file:///tmp/socket")).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn sdk_initialization_collects_usage_and_respects_custom_endpoint() {
        let dir=std::env::temp_dir().join(format!("t3-claude-sdk-probe-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("settings.json"),r#"{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example.test/v1"}}"#).unwrap();
        let binary=dir.join("claude");
        std::fs::write(&binary, r##"#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.100'; exit 0; fi
while IFS= read -r line; do
case "$line" in
*probe-init*) echo '{"type":"control_response","response":{"request_id":"probe-init","subtype":"success","response":{"account":{"tokenSource":"none","apiKeySource":"none"}}}}' ;;
*probe-usage*) echo '{"type":"control_response","response":{"request_id":"probe-usage","subtype":"success","response":{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":91}}}}}' ;;
*probe-settings*) echo '{"type":"control_response","response":{"request_id":"probe-settings","subtype":"success","response":{"effective":{"maxEffortLevel":"low"}}}}' ;;
esac
done
"##).unwrap();
        std::fs::set_permissions(&binary,std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings_path = dir.join("t3-settings.json");
        std::fs::write(&settings_path, r#"{"enableProviderUpdateChecks":false}"#).unwrap();
        let output=discover(&dir,"claudeAgent",&json!({"driver":"claudeAgent","config":{"binaryPath":binary,"homePath":dir}}),Some(&settings_path),None);
        assert_eq!(output["status"],"ready"); assert_eq!(output["auth"]["type"],"customEndpoint"); assert_eq!(output["auth"]["endpoint"],"https://proxy.example.test");
        assert_eq!(output["usageLimits"]["windows"][0]["id"],"five_hour"); assert_eq!(output["usageLimits"]["windows"][0]["usedPercent"],91.0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn distinguishes_authenticated_signed_out_and_unknown_without_leaking_credentials() {
        let dir = std::env::temp_dir().join(format!("t3-claude-probe-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        let binary = dir.join("claude"); let captured = dir.join("environment");
        std::fs::write(&binary, format!("#!/bin/sh\nif [ \"$1\" = '--version' ]; then printf '%s\\n' '2.1.100 (Claude Code)'; exit 0; fi\nprintf '%s' \"$TOKEN\" > '{}'\nprintf '%s\\n' \"$RESULT\"\n",captured.display())).unwrap();
        std::fs::set_permissions(&binary,std::fs::Permissions::from_mode(0o700)).unwrap();
        let entry = |status: &str| json!({"driver":"claudeAgent","config":{"binaryPath":binary},"environment":[{"name":"TOKEN","secret":{"provider":"vault","reference":"ref"}},{"name":"RESULT","value":status}]});
        let store=SecretStore::default(); store.apply("vault","ref","private-key".into()).unwrap();
        let settings_path = dir.join("t3-settings.json");
        std::fs::write(&settings_path, r#"{"enableProviderUpdateChecks":false}"#).unwrap();
        let ready=discover(&dir,"work",&entry("{\"loggedIn\":true}"),Some(&settings_path),Some(&store)); assert_eq!(ready["installed"],true); assert_eq!(ready["version"],"2.1.100"); assert_eq!(ready["auth"]["status"],"unknown"); assert!(!ready.to_string().contains("private-key")); assert_eq!(std::fs::read_to_string(&captured).unwrap(),"private-key");
        let signed_out=discover(&dir,"work",&entry("{\"loggedIn\":false}"),Some(&settings_path),Some(&store)); assert_eq!(signed_out["auth"]["status"],"unknown"); assert_eq!(signed_out["status"],"warning");
        let unknown=discover(&dir,"work",&entry("not-json"),Some(&settings_path),Some(&store)); assert_eq!(unknown["auth"]["status"],"unknown"); assert_eq!(unknown["status"],"warning");
        let missing=discover(&dir,"work",&entry("{}"),Some(&settings_path),None); assert_eq!(missing["installed"],false); assert!(!missing.to_string().contains("private-key"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
