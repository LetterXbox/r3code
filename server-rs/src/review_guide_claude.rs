//! Read-only structured review-guide generation through the Claude CLI.
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const NO_SESSION: &str = "--no-session-persistence";
const SESSION_REJECTED: &str = "error: unknown option '--no-session-persistence'";
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL); }
    }
}

pub(crate) async fn generate(cwd: &Path, prompt: &str, schema: &str, selection: &Value, settings: &Value) -> Result<String, String> {
    let id = selection["instanceId"].as_str().ok_or("Invalid Claude provider instance")?;
    selection["model"].as_str().filter(|s| !s.is_empty()).ok_or("Invalid Claude model")?;
    let config = &settings["providerInstances"][id];
    let binary = config["config"]["binaryPath"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("claude");
    let binary = if binary == "~" || binary.starts_with("~/") { crate::provider::instance::home_path(binary)? } else { binary.into() };
    let home = config["config"]["homePath"].as_str().filter(|s| !s.trim().is_empty()).map(crate::provider::instance::home_path).transpose()?;
    let mut env = Vec::new();
    for item in config["environment"].as_array().into_iter().flatten() {
        let name = item["name"].as_str().filter(|name| !name.is_empty() && name.chars().enumerate().all(|(i,c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))).ok_or("Invalid provider environment")?;
        let value = if let Some(secret) = item.get("secret").filter(|v| !v.is_null()) {
            crate::mcp_secret::resolve_reference(settings, secret).await.ok_or("Claude provider contains an unresolved environment credential")?
        } else { item["value"].as_str().ok_or("Invalid provider environment")?.to_owned() };
        env.push((name.to_owned(), value));
    }
    let resolved = crate::review_guide_claude_catalog::resolve(selection, &config["config"]["customModels"]);
    let mut cli_settings = json!({"disableAllHooks":true});
    if let Some(thinking) = resolved.thinking { cli_settings["alwaysThinkingEnabled"] = json!(thinking); }
    if resolved.fast_mode { cli_settings["fastMode"] = json!(true); }
    if let Some(ultracode) = resolved.ultracode { cli_settings["ultracode"] = json!(ultracode); }
    let run = |session_flag: bool| {
        let mut command = tokio::process::Command::new(&binary);
        command.current_dir(cwd).args(["-p", "--output-format", "json", "--json-schema", schema, "--model", &resolved.model]);
        if let Some(effort) = &resolved.effort { command.args(["--effort", effort]); }
        command.args(["--settings", &cli_settings.to_string(), "--tools", "Read,Grep,Glob,Bash", "--allowedTools", "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)", "--disallowedTools", "Bash(git * --output*),Bash(git * -o *)", "--disable-slash-commands"]);
        if session_flag { command.arg(NO_SESSION); }
        let managed = if cfg!(target_os="macos") { "/Library/Application Support/ClaudeCode/managed-mcp.json" } else { "/etc/claude-code/managed-mcp.json" };
        if !Path::new(managed).exists() { command.arg("--strict-mcp-config"); }
        command.args(["--permission-mode", "dontAsk"]);
        for name in ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_AGENT_SDK_VERSION", "ELECTRON_RUN_AS_NODE"] { command.env_remove(name); }
        command.env("CLAUDE_CODE_ENTRYPOINT", "t3-code");
        command.envs(env.iter().map(|(k,v)| (k,v)));
        if let Some(home) = &home { command.env("CLAUDE_CONFIG_DIR", home); }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)] { command.process_group(0); }
        command
    };
    let mut no_session = true;
    loop {
        let mut child = run(no_session).spawn().map_err(|_| "Failed to spawn Claude CLI process".to_owned())?;
        let _group = ProcessGroup(child.id().ok_or("Failed to spawn Claude CLI process")?);
        let mut stdin = child.stdin.take().ok_or("Claude CLI input unavailable")?;
        let stdout = child.stdout.take().ok_or("Claude CLI output unavailable")?;
        let stderr = child.stderr.take().ok_or("Claude CLI output unavailable")?;
        let operation = async {
            let write = async { let result = stdin.write_all(prompt.as_bytes()).await; drop(stdin); result };
            let read = async { let mut bytes = Vec::new(); stdout.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).await.map_err(|_| "Failed to read Claude CLI output")?; Ok::<_, &str>(bytes) };
            let errors = async { let mut bytes = Vec::new(); stderr.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).await.map_err(|_| "Failed to read Claude CLI output")?; Ok::<_, &str>(bytes) };
            let (input_result, out, err, status) = tokio::join!(write, read, errors, child.wait());
            let status = status.map_err(|_| "Failed to read Claude CLI exit code")?;
            if status.success() { input_result.map_err(|_| "Failed to write Claude CLI input")?; }
            Ok::<_, &str>((out?, err?, status))
        };
        let (out, err, status) = tokio::time::timeout(Duration::from_secs(180), operation).await.map_err(|_| "Claude CLI request timed out.")?.map_err(str::to_owned)?;
        if out.len() as u64 > MAX_OUTPUT || err.len() as u64 > MAX_OUTPUT { return Err("Claude CLI output exceeded the size limit.".into()); }
        let stderr = String::from_utf8_lossy(&err);
        if !status.success() && no_session && stderr.contains(SESSION_REJECTED) { no_session = false; continue; }
        let stdout = String::from_utf8_lossy(&out);
        let parsed: Value = serde_json::from_str(&stdout).map_err(|_| "Claude CLI returned unexpected output format.")?;
        if !status.success() {
            let last_error = if let Some(items) = parsed.as_array() { items.iter().rev().find(|v| v["is_error"] == true) } else { Some(&parsed) };
            let detail = last_error.and_then(|v| v["result"].as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(stderr.trim());
            return Err(if detail.is_empty() { format!("Claude CLI command failed with code {}.", status.code().unwrap_or(-1)) } else { format!("Claude CLI command failed: {detail}") });
        }
        let output = if let Some(items) = parsed.as_array() { items.iter().rev().find(|item| item["type"] == "result").and_then(|v| v.get("structured_output")) } else { parsed.get("structured_output") };
        return output.map(Value::to_string).ok_or_else(|| "Claude returned invalid structured output.".into());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn claude_runs_with_read_only_tools_and_returns_structured_output() {
        let dir = std::env::temp_dir().join(format!("t3-guide-claude-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let binary = dir.join("claude"); let args = dir.join("args"); let prompt = dir.join("prompt");
        std::fs::write(&binary, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '%s\\n' '{{\"type\":\"result\",\"structured_output\":{{\"stops\":[]}}}}'\n", args.display(), prompt.display())).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = json!({"providerInstances":{"work":{"driver":"claudeAgent","config":{"binaryPath":binary}}}});
        let selection = json!({"instanceId":"work","model":"claude-test","options":[{"id":"effort","value":"high"}]});
        let result = generate(&dir,"read-only prompt","{}",&selection,&settings).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(),json!({"stops":[]}));
        let captured = std::fs::read_to_string(args).unwrap();
        for required in ["--json-schema", "--model\nclaude-test", "--effort\nhigh", "Read,Grep,Glob,Bash", "Bash(git * --output*)", "--permission-mode\ndontAsk", "--no-session-persistence"] { assert!(captured.contains(required), "missing {required}: {captured}"); }
        assert_eq!(std::fs::read_to_string(prompt).unwrap(), "read-only prompt");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn retries_older_claude_without_no_session_persistence() {
        let dir = std::env::temp_dir().join(format!("t3-guide-claude-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        let binary = dir.join("claude");
        std::fs::write(&binary, "#!/bin/sh\ncase \"$*\" in *--no-session-persistence*) echo \"error: unknown option '--no-session-persistence'\" >&2; exit 1;; esac\ncat >/dev/null\nprintf '%s\\n' '[{\"type\":\"result\",\"structured_output\":{\"stops\":[]}}]'\n").unwrap();
        std::fs::set_permissions(&binary,std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = generate(&dir,"prompt","{}",&json!({"instanceId":"claudeAgent","model":"claude-test"}),&json!({"providerInstances":{"claudeAgent":{"config":{"binaryPath":binary}}}})).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), json!({"stops":[]}));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
