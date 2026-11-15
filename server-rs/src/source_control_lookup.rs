//! Resolve repository identities through source-control provider clients.
use crate::github_pinned_credential::{run_classified_bounded, CommandFailure};
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

fn error(provider: &str, detail: &str) -> Value {
    json!({"_tag":"SourceControlRepositoryError","provider":provider,"operation":"lookupRepository","detail":detail})
}
fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
fn run(command: &mut Command, provider: &str) -> Result<Value, Value> {
    let output = run_classified_bounded(command, Duration::from_secs(30), 1024 * 1024).map_err(
        |failure| {
            error(
                provider,
                match failure {
                    CommandFailure::Spawn(_) => "The source control client is not installed.",
                    CommandFailure::Unauthenticated => {
                        "The source control provider is not authenticated."
                    }
                    CommandFailure::NotFound => {
                        "Repository not found. Check the owner and name and try again."
                    }
                    CommandFailure::RateLimited => {
                        "The source control provider rate limit was exceeded."
                    }
                    CommandFailure::Failed => {
                        "The source control operation could not be completed."
                    }
                },
            )
        },
    )?;
    serde_json::from_slice(&output).map_err(|_| {
        error(
            provider,
            "The source control provider returned an invalid repository.",
        )
    })
}
fn source_control_secret(
    snapshot: &Value,
    slot: &Value,
    provider: &str,
) -> Result<Option<String>, Value> {
    if slot.is_object() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| {
                error(
                    provider,
                    "The saved source control credential could not be read.",
                )
            })?;
        return runtime
            .block_on(crate::mcp_secret::resolve_reference(snapshot, slot))
            .map(Some)
            .ok_or_else(|| {
                error(
                    provider,
                    "The saved source control credential could not be read.",
                )
            });
    }
    Ok(slot.as_str().filter(|v| !v.is_empty()).map(str::to_owned))
}
type RefusedAppTokens = std::collections::HashSet<(String, String)>;
fn refused_app_tokens() -> &'static std::sync::Mutex<RefusedAppTokens> {
    static REFUSED: std::sync::OnceLock<std::sync::Mutex<RefusedAppTokens>> =
        std::sync::OnceLock::new();
    REFUSED.get_or_init(|| std::sync::Mutex::new(Default::default()))
}
fn app_token_key(settings: &crate::settings::Settings, token: &str) -> (String, String) {
    use sha2::{Digest, Sha256};
    (
        settings.path().to_string_lossy().into_owned(),
        format!("{:x}", Sha256::digest(token.as_bytes())),
    )
}
pub(crate) fn reject_github_app_token(settings: &crate::settings::Settings, token: &str) {
    if let Ok(mut refused) = refused_app_tokens().lock() {
        refused.insert(app_token_key(settings, token));
    }
}
pub(crate) fn clear_github_app_refusals(settings: &crate::settings::Settings) {
    if let Ok(mut refused) = refused_app_tokens().lock() {
        let path = settings.path().to_string_lossy();
        refused.retain(|(stored, _)| stored != path.as_ref());
    }
}
fn is_github_app_token_refused(settings: &crate::settings::Settings, token: &str) -> bool {
    refused_app_tokens()
        .lock()
        .map(|refused| refused.contains(&app_token_key(settings, token)))
        .unwrap_or(true)
}
pub(crate) fn github_app_token(
    settings: &crate::settings::Settings,
    host: &str,
    client_id: &str,
) -> Result<Option<String>, Value> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    let failure = || {
        error(
            "github",
            "The saved GitHub App credential could not be refreshed.",
        )
    };
    let _guard = LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .map_err(|_| failure())?;
    let mut snapshot = settings.private_snapshot();
    crate::settings::materialize_secrets(settings.path(), &mut snapshot).map_err(|_| failure())?;
    let Some(raw) = source_control_secret(
        &snapshot,
        &snapshot["sourceControlHosts"]["github"]["signIns"][host],
        "github",
    )?
    else {
        return Ok(None);
    };
    let Ok(session) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let Some(token) = session["accessToken"].as_str() else {
        return Ok(None);
    };
    let expiry = &session["accessTokenExpiresAt"];
    let refresh = &session["refreshToken"];
    let refresh_expiry = &session["refreshTokenExpiresAt"];
    if !(expiry.is_null() || expiry.is_number())
        || !(refresh.is_null() || refresh.is_string())
        || !(refresh_expiry.is_null() || refresh_expiry.is_number())
    {
        return Ok(None);
    }
    let now = chrono::Utc::now().timestamp_millis();
    let refused = is_github_app_token_refused(settings, token);
    if !refused && (expiry.is_null() || expiry.as_i64().is_some_and(|v| v > now + 300_000)) {
        return Ok(Some(token.to_owned()));
    }
    let usable = !refused && (expiry.is_null() || expiry.as_i64().is_some_and(|v| v > now));
    let Some(refresh_token) = refresh
        .as_str()
        .filter(|v| !v.is_empty())
        .filter(|_| refresh_expiry.is_null() || refresh_expiry.as_i64().is_some_and(|v| v > now))
    else {
        let _ = settings.compare_exchange_github_app_session(host, token, "");
        return Ok(None);
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure())?;
    let result = runtime.block_on(async {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("t3code");
        if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
            if let Ok(pem) = std::fs::read(path) {
                if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                    builder = builder.add_root_certificate(cert);
                }
            }
        }
        let client = builder.build().map_err(|_| failure())?;
        let mut response = client
            .post(format!("https://{host}/login/oauth/access_token"))
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .send()
            .await
            .map_err(|_| failure())?;
        if !response.status().is_success() {
            return Err(failure());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
            if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
                return Err(failure());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&bytes).map_err(|_| failure())
    });
    let response = match result {
        Ok(v) => v,
        Err(e) => {
            return if usable {
                Ok(Some(token.to_owned()))
            } else {
                Err(e)
            }
        }
    };
    if response["error"] == "bad_refresh_token" {
        let _ = settings.compare_exchange_github_app_session(host, token, "");
        return Ok(None);
    }
    let Some(next_token) = response["access_token"].as_str().filter(|v| !v.is_empty()) else {
        return if usable {
            Ok(Some(token.to_owned()))
        } else {
            Err(failure())
        };
    };
    let duration = |name: &str| {
        response[name]
            .as_i64()
            .and_then(|v| v.checked_mul(1000))
            .and_then(|v| now.checked_add(v))
    };
    let next=json!({"accessToken":next_token,"accessTokenExpiresAt":duration("expires_in"),"refreshToken":response["refresh_token"].as_str(),"refreshTokenExpiresAt":duration("refresh_token_expires_in")}).to_string();
    match settings.compare_exchange_github_app_session(host, token, &next) {
        Ok(false) => {
            let mut latest = settings.private_snapshot();
            crate::settings::materialize_secrets(settings.path(), &mut latest)
                .map_err(|_| failure())?;
            Ok(latest["sourceControlHosts"]["github"]["signIns"][host]
                .as_str()
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .and_then(|v| v["accessToken"].as_str().map(str::to_owned)))
        }
        _ => Ok(Some(next_token.to_owned())),
    }
}
fn github_app_api(
    host: &str,
    path: &str,
    token: &str,
    settings: &crate::settings::Settings,
) -> Result<Value, Value> {
    match github_token_request(host, path, Some(token), true) {
        Err(e) if e["detail"] == "GitHub App credential was rejected." => {
            reject_github_app_token(settings, token);
            Err(error(
                "github",
                "The source control provider is not authenticated.",
            ))
        }
        other => other,
    }
}
#[derive(Clone)]
struct AppCoverage {
    accounts: std::collections::HashSet<String>,
    repositories: std::collections::HashSet<String>,
}
type AppCoverageCache =
    std::collections::HashMap<(String, String), (std::time::Instant, Option<AppCoverage>)>;
fn app_coverage_cache() -> &'static std::sync::Mutex<AppCoverageCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<AppCoverageCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
pub(crate) fn invalidate_github_app_access(settings: &crate::settings::Settings) {
    if let Ok(mut cache) = app_coverage_cache().lock() {
        let path = settings.path().to_string_lossy();
        cache.retain(|(stored, _), _| stored != path.as_ref());
    }
}
pub(crate) fn github_app_access(input: &Value, settings: &crate::settings::Settings) -> Value {
    use sha2::{Digest, Sha256};
    if input["provider"] != "github" {
        return json!({"status":"signed-out"});
    }
    let host = input["host"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let Ok(client_id) = std::env::var("T3CODE_GITHUB_APP_CLIENT_ID") else {
        return json!({"status":"signed-out"});
    };
    if host != "github.com" || client_id.trim().is_empty() {
        return json!({"status":"signed-out"});
    }
    let token = match github_app_token(settings, &host, client_id.trim()) {
        Ok(Some(token)) => token,
        Ok(None) => return json!({"status":"signed-out"}),
        Err(_) => return json!({"status":"covered"}),
    };
    let repository = input["repository"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let repository = repository.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = repository
        .split(['/', ':'])
        .filter(|v| !v.is_empty())
        .collect();
    let repository = if parts.len() >= 2 {
        format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        parts.first().copied().unwrap_or("").to_owned()
    };
    let owner = repository.split('/').next().unwrap_or("");
    let Ok(mut cache) = app_coverage_cache().lock() else {
        return json!({"status":"covered"});
    };
    let key = (
        settings.path().to_string_lossy().into_owned(),
        format!("{:x}", Sha256::digest(token.as_bytes())),
    );
    let coverage = if let Some((expires, value)) = cache
        .get(&key)
        .filter(|(expires, _)| *expires > std::time::Instant::now())
    {
        let _ = expires;
        value.clone()
    } else {
        let result = (|| -> Result<AppCoverage, Value> {
            let mut installations = Vec::new();
            for page in 1..=10 {
                let value = github_app_api(
                    &host,
                    &format!("user/installations?per_page=100&page={page}"),
                    &token,
                    settings,
                )?;
                let entries = value["installations"]
                    .as_array()
                    .ok_or_else(|| error("github", "Invalid app installation response."))?;
                let len = entries.len();
                installations.extend(entries.iter().cloned());
                if len < 100 {
                    break;
                }
            }
            let mut coverage = AppCoverage {
                accounts: Default::default(),
                repositories: Default::default(),
            };
            for install in installations {
                let id = install["id"]
                    .as_i64()
                    .ok_or_else(|| error("github", "Invalid app installation response."))?;
                let selection = install["repository_selection"]
                    .as_str()
                    .ok_or_else(|| error("github", "Invalid app installation response."))?;
                if install["account"].is_null() {
                    continue;
                }
                let login = install["account"]["login"]
                    .as_str()
                    .ok_or_else(|| error("github", "Invalid app installation response."))?
                    .to_ascii_lowercase();
                if selection == "all" {
                    coverage.accounts.insert(login);
                    continue;
                }
                for page in 1..=10 {
                    let value = github_app_api(
                        &host,
                        &format!("user/installations/{id}/repositories?per_page=100&page={page}"),
                        &token,
                        settings,
                    )?;
                    let entries = value["repositories"]
                        .as_array()
                        .ok_or_else(|| error("github", "Invalid app repository response."))?;
                    for entry in entries {
                        let name = entry["full_name"]
                            .as_str()
                            .ok_or_else(|| error("github", "Invalid app repository response."))?;
                        coverage.repositories.insert(name.to_ascii_lowercase());
                    }
                    if entries.len() < 100 {
                        break;
                    }
                    if page == 10 {
                        coverage.accounts.insert(login.clone());
                    }
                }
            }
            Ok(coverage)
        })();
        let ttl = if result.is_ok() { 120 } else { 30 };
        let value = result.ok();
        if cache.len() >= 8 {
            cache.retain(|_, (expires, _)| *expires > std::time::Instant::now());
            if cache.len() >= 8 {
                cache.clear();
            }
        }
        cache.insert(
            key,
            (
                std::time::Instant::now() + Duration::from_secs(ttl),
                value.clone(),
            ),
        );
        value
    };
    let covered = coverage.is_none_or(|value| {
        value.accounts.contains(owner) || value.repositories.contains(&repository)
    });
    json!({"status":if covered {"covered"}else{"not-covered"}})
}
pub(crate) fn github_star(
    input: &Value,
    settings: &crate::settings::Settings,
    write: bool,
) -> bool {
    if input["provider"] != "github" {
        return false;
    }
    let host = input["host"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let Some(repository) = input["repository"].as_str() else {
        return false;
    };
    let parts: Vec<_> = repository.split('/').collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|v| v.is_empty() || *v == "." || *v == "..")
    {
        return false;
    }
    let Ok(authority) = url::Url::parse(&format!("https://{host}/")) else {
        return false;
    };
    if authority.host_str().is_none()
        || !authority.username().is_empty()
        || authority.password().is_some()
        || authority.path() != "/"
        || authority.query().is_some()
        || authority.fragment().is_some()
    {
        return false;
    }
    let path = format!(
        "user/starred/{}/{}",
        crate::message_commands::encode_id_part(parts[0]),
        crate::message_commands::encode_id_part(parts[1])
    );
    let mut snapshot = settings.private_snapshot();
    if crate::settings::materialize_secrets(settings.path(), &mut snapshot).is_err() {
        return false;
    }
    let config = &snapshot["sourceControlHosts"]["github"];
    if config["hosts"][&host]["enabled"] == false {
        return false;
    }
    let Ok(saved) = source_control_secret(&snapshot, &config["tokens"][&host], "github") else {
        return false;
    };
    let enterprise = !host.eq_ignore_ascii_case("github.com") && !host.ends_with(".ghe.com");
    let keys = if enterprise {
        ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    } else {
        ["GH_TOKEN", "GITHUB_TOKEN"]
    };
    let personal = || {
        keys.into_iter().find_map(|key| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        })
    };
    let mut from_app = false;
    let mut token = saved.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if token.is_none() && host == "github.com" {
        if let Ok(client) = std::env::var("T3CODE_GITHUB_APP_CLIENT_ID") {
            if !client.trim().is_empty() {
                if let Ok(Some(value)) = github_app_token(settings, &host, client.trim()) {
                    token = Some(value);
                    from_app = true;
                }
            }
        }
    }
    if token.is_none() {
        token = personal();
    }
    let send = |token: &str| -> Option<(u16, bool)> {
        let base = if host == "github.com" {
            "https://api.github.com".to_owned()
        } else if host.ends_with(".ghe.com") {
            format!("https://api.{host}")
        } else {
            format!("https://{host}/api/v3")
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        runtime.block_on(async {
            let mut builder = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("t3code-server");
            if let Some(file) = std::env::var_os("SSL_CERT_FILE") {
                if let Ok(pem) = std::fs::read(file) {
                    if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                        builder = builder.add_root_certificate(cert);
                    }
                }
            }
            let client = builder.build().ok()?;
            let request = if write {
                client.put(format!("{base}/{path}"))
            } else {
                client.get(format!("{base}/{path}"))
            };
            let mut response = request
                .bearer_auth(token)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .ok()?;
            let status = response.status().as_u16();
            let mut refused = false;
            if status == 403 {
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.ok()? {
                    if bytes.len().saturating_add(chunk.len()) > 65536 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                refused = String::from_utf8_lossy(&bytes)
                    .to_ascii_lowercase()
                    .contains("not accessible by integration");
            }
            Some((status, refused))
        })
    };
    if let Some(token) = token {
        let status = send(&token);
        if from_app && status.is_some_and(|(code, _)| code == 401) {
            reject_github_app_token(settings, &token);
        }
        if from_app && status.is_some_and(|(code, refused)| code == 404 || refused) {
            if let Some(token) = personal() {
                return send(&token).is_some_and(|(code, _)| code == 204);
            }
        } else {
            return status.is_some_and(|(code, _)| code == 204);
        }
    }
    let mut command = Command::new("gh");
    command.args([
        "api",
        "--hostname",
        &host,
        "--include",
        "--method",
        if write { "PUT" } else { "GET" },
        &path,
    ]);
    let Ok(output) = crate::vcs_worktree::run_command(&mut command, Duration::from_secs(30)) else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("HTTP/") && line.split_whitespace().nth(1) == Some("204"))
}
pub(crate) fn github_api(
    host: &str,
    path: &str,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    github_request(host, path, cwd, settings, None)
}
pub(crate) fn github_request(
    host: &str,
    path: &str,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
    body: Option<&Value>,
) -> Result<Value, Value> {
    if let Some(settings) = settings {
        let mut snapshot = settings.private_snapshot();
        crate::settings::materialize_secrets(settings.path(), &mut snapshot).map_err(|_| {
            error(
                "github",
                "The saved source control credential could not be read.",
            )
        })?;
        let host_settings = &snapshot["sourceControlHosts"]["github"];
        if host_settings["hosts"][host]["enabled"] == false {
            let detail = format!("GitHub host {host} is turned off in Settings → Source Control.");
            return Err(
                json!({"_tag":"SourceControlRepositoryError","provider":"github","operation":"lookupRepository","detail":"The source control operation could not be completed.","cause":{"name":"SourceControlProviderError","message":format!("Source control provider github failed in getRepositoryCloneUrls: {detail}"),"cause":{"name":"GitHubHostDisabledError","message":detail}}}),
            );
        }
        let saved = source_control_secret(&snapshot, &host_settings["tokens"][host], "github")?;
        if let Some(token) = saved.as_deref().filter(|v| !v.trim().is_empty()) {
            return github_token_request_body(host, path, Some(token.trim()), false, body);
        }
        if host.eq_ignore_ascii_case("github.com") {
            if let Ok(client_id) = std::env::var("T3CODE_GITHUB_APP_CLIENT_ID") {
                if !client_id.trim().is_empty() {
                    match github_app_token(settings, host, client_id.trim()) {
                        Ok(Some(token)) => {
                            let result =
                                github_token_request_body(host, path, Some(&token), true, body);
                            if let Err(ref app_error) = result {
                                if app_error["detail"] == "GitHub App credential was rejected." {
                                    reject_github_app_token(settings, &token);
                                    return Err(error(
                                        "github",
                                        "The source control provider is not authenticated.",
                                    ));
                                }
                                if app_error["detail"]=="Repository not found. Check the owner and name and try again." || app_error["detail"]=="GitHub App integration cannot access this repository." {
                                    let fallback_error=if app_error["detail"]=="GitHub App integration cannot access this repository." {error("github","The source control provider is not authenticated.")} else {app_error.clone()};
                                    return github_personal_api(host,path,cwd,body).map_err(|_|fallback_error);
                                }
                            }
                            return result;
                        }
                        Ok(None) => {}
                        Err(app_error) => {
                            return github_personal_api(host, path, cwd, body).or(Err(app_error))
                        }
                    }
                }
            }
        }
    }
    github_personal_api(host, path, cwd, body)
}
fn github_personal_api(
    host: &str,
    path: &str,
    cwd: &Path,
    body: Option<&Value>,
) -> Result<Value, Value> {
    let enterprise = !host.eq_ignore_ascii_case("github.com")
        && !host.to_ascii_lowercase().ends_with(".ghe.com");
    let keys = if enterprise {
        ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    } else {
        ["GH_TOKEN", "GITHUB_TOKEN"]
    };
    if keys
        .into_iter()
        .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
    {
        return github_token_request_body(host, path, None, false, body);
    }
    let mut cmd = Command::new("gh");
    cmd.args(["api", "--hostname", host, path]).current_dir(cwd);
    if let Some(body) = body {
        let name = body["name"].as_str().unwrap_or("");
        let private = if body["private"] == true {
            "private=true"
        } else {
            "private=false"
        };
        cmd.args([
            "--method",
            "POST",
            "--raw-field",
            &format!("name={name}"),
            "--field",
            private,
        ]);
    }
    match run_classified_bounded(&mut cmd, Duration::from_secs(30), 1024 * 1024) {
        Ok(output) => serde_json::from_slice(&output).map_err(|_| {
            error(
                "github",
                "The source control provider returned an invalid repository.",
            )
        }),
        Err(CommandFailure::Spawn(std::io::ErrorKind::NotFound)) => {
            github_token_request_body(host, path, None, false, body)
        }
        Err(failure) => Err(error(
            "github",
            match failure {
                CommandFailure::Unauthenticated => {
                    "The source control provider is not authenticated."
                }
                CommandFailure::NotFound => {
                    "Repository not found. Check the owner and name and try again."
                }
                CommandFailure::RateLimited => {
                    "The source control provider rate limit was exceeded."
                }
                _ => "The source control operation could not be completed.",
            },
        )),
    }
}

// A server with an environment token can use GitHub without the optional gh CLI.
// The caller runs on a blocking worker, away from Tokio's asynchronous tasks.
fn github_token_request(
    host: &str,
    path: &str,
    saved: Option<&str>,
    app: bool,
) -> Result<Value, Value> {
    github_token_request_body(host, path, saved, app, None)
}
fn github_token_request_body(
    host: &str,
    path: &str,
    saved: Option<&str>,
    app: bool,
    body: Option<&Value>,
) -> Result<Value, Value> {
    let enterprise = !host.eq_ignore_ascii_case("github.com")
        && !host.to_ascii_lowercase().ends_with(".ghe.com");
    let keys = if enterprise {
        ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    } else {
        ["GH_TOKEN", "GITHUB_TOKEN"]
    };
    let token = saved
        .map(str::to_owned)
        .or_else(|| {
            keys.into_iter()
                .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()))
        })
        .ok_or_else(|| error("github", "The source control client is not installed."))?;
    let authority = url::Url::parse(&format!("https://{host}/"))
        .map_err(|_| error("github", "Invalid GitHub host."))?;
    if authority.host_str().is_none()
        || !authority.username().is_empty()
        || authority.password().is_some()
        || authority.path() != "/"
        || authority.query().is_some()
        || authority.fragment().is_some()
    {
        return Err(error("github", "Invalid GitHub host."));
    }
    let base = if host.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_owned()
    } else if host.to_ascii_lowercase().ends_with(".ghe.com") {
        format!("https://api.{host}")
    } else {
        format!("https://{host}/api/v3")
    };
    let url = format!("{base}/{path}");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| {
            error(
                "github",
                "The source control operation could not be completed.",
            )
        })?;
    runtime.block_on(async {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("t3code-server");
        if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
            if let Ok(pem) = std::fs::read(path) {
                if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                    builder = builder.add_root_certificate(cert);
                }
            }
        }
        let client = builder.build().map_err(|_| {
            error(
                "github",
                "The source control operation could not be completed.",
            )
        })?;
        let request = if let Some(body) = body {
            client
                .post(url)
                .header("Content-Type", "application/json")
                .body(body.to_string())
        } else {
            client.get(url)
        };
        let mut response = request
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| {
                error(
                    "github",
                    "The source control operation could not be completed.",
                )
            })?;
        match response.status().as_u16() {
            200..=299 => {}
            401 if app => return Err(error("github", "GitHub App credential was rejected.")),
            403 if app => {
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| {
                    error(
                        "github",
                        "The source control operation could not be completed.",
                    )
                })? {
                    if bytes.len().saturating_add(chunk.len()) > 65536 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let message = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                if message.contains("not accessible by integration") {
                    return Err(error(
                        "github",
                        "GitHub App integration cannot access this repository.",
                    ));
                }
                return Err(error(
                    "github",
                    "The source control provider is not authenticated.",
                ));
            }
            401 | 403 => {
                return Err(error(
                    "github",
                    "The source control provider is not authenticated.",
                ))
            }
            404 => {
                return Err(error(
                    "github",
                    "Repository not found. Check the owner and name and try again.",
                ))
            }
            429 => {
                return Err(error(
                    "github",
                    "The source control provider rate limit was exceeded.",
                ))
            }
            _ => {
                return Err(error(
                    "github",
                    "The source control operation could not be completed.",
                ))
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            error(
                "github",
                "The source control operation could not be completed.",
            )
        })? {
            if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
                return Err(error(
                    "github",
                    "The source control provider returned an invalid repository.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            error(
                "github",
                "The source control provider returned an invalid repository.",
            )
        })
    })
}

pub(crate) fn bitbucket_request(
    repository: &str,
    settings: Option<&crate::settings::Settings>,
    visibility: Option<&str>,
) -> Result<Value, Value> {
    let trimmed = repository
        .trim()
        .strip_suffix(".git")
        .unwrap_or(repository.trim());
    let parts: Vec<_> = trimmed.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Err(error("bitbucket", "Enter a repository name."));
    }
    let base = std::env::var("T3CODE_BITBUCKET_API_BASE_URL")
        .unwrap_or_else(|_| "https://api.bitbucket.org/2.0".into());
    let mut base = url::Url::parse(&base).map_err(|_| {
        error(
            "bitbucket",
            "The source control operation could not be completed.",
        )
    })?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(error(
            "bitbucket",
            "The source control operation could not be completed.",
        ));
    }
    let path = format!(
        "{}/repositories/{}/{}",
        base.path().trim_end_matches('/'),
        crate::message_commands::encode_id_part(parts[parts.len() - 2]),
        crate::message_commands::encode_id_part(parts[parts.len() - 1])
    );
    base.set_path(&path);
    let mut access = None;
    let mut basic = None;
    if let Some(settings) = settings {
        let mut snapshot = settings.private_snapshot();
        crate::settings::materialize_secrets(settings.path(), &mut snapshot).map_err(|_| {
            error(
                "bitbucket",
                "The saved source control credential could not be read.",
            )
        })?;
        let host = &snapshot["sourceControlHosts"]["bitbucket"];
        access = source_control_secret(&snapshot, &host["accessToken"], "bitbucket")?
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_owned());
        let saved_api = if access.is_some() {
            None
        } else {
            source_control_secret(&snapshot, &host["apiToken"], "bitbucket")?
        };
        if let (Some(email), Some(token)) = (host["email"].as_str(), saved_api.as_deref()) {
            if !email.trim().is_empty() && !token.trim().is_empty() {
                basic = Some((email.trim().to_owned(), token.trim().to_owned()));
            }
        }
    }
    if access.is_none() && basic.is_none() {
        access = std::env::var("T3CODE_BITBUCKET_ACCESS_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty());
        if let (Ok(email), Ok(token)) = (
            std::env::var("T3CODE_BITBUCKET_EMAIL"),
            std::env::var("T3CODE_BITBUCKET_API_TOKEN"),
        ) {
            if !email.trim().is_empty() && !token.trim().is_empty() {
                basic = Some((email.trim().to_owned(), token.trim().to_owned()));
            }
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| {
            error(
                "bitbucket",
                "The source control operation could not be completed.",
            )
        })?;
    let raw: Value = runtime.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                error(
                    "bitbucket",
                    "The source control operation could not be completed.",
                )
            })?;
        let mut request = if let Some(visibility) = visibility {
            client
                .post(base)
                .header("Content-Type", "application/json")
                .body(json!({"scm":"git","is_private":visibility=="private"}).to_string())
        } else {
            client.get(base)
        };
        if let Some(token) = access {
            request = request.bearer_auth(token);
        } else if let Some((email, token)) = basic {
            request = request.basic_auth(email, Some(token));
        }
        let mut response = request.send().await.map_err(|_| {
            error(
                "bitbucket",
                "The source control operation could not be completed.",
            )
        })?;
        if !response.status().is_success() {
            return Err(error(
                "bitbucket",
                "The source control operation could not be completed.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            error(
                "bitbucket",
                "The source control operation could not be completed.",
            )
        })? {
            if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
                return Err(error(
                    "bitbucket",
                    "The source control operation could not be completed.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            error(
                "bitbucket",
                "The source control provider returned an invalid repository.",
            )
        })
    })?;
    let name = raw["full_name"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            error(
                "bitbucket",
                "The source control provider returned an invalid repository.",
            )
        })?;
    let clone = raw["links"]["clone"].as_array();
    let find = |kind: &str| {
        clone
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    entry["name"]
                        .as_str()
                        .is_some_and(|v| v.eq_ignore_ascii_case(kind))
                })
            })
            .and_then(|v| v["href"].as_str())
    };
    let url = find("https")
        .or_else(|| raw["links"]["html"]["href"].as_str())
        .unwrap_or(name);
    let ssh = find("ssh").unwrap_or(url);
    Ok(json!({"provider":"bitbucket","nameWithOwner":name,"url":url,"sshUrl":ssh}))
}
fn cursor_origin_token(
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
    rejected: Option<&str>,
) -> Result<String, Value> {
    type CachedToken = (Result<String, Value>, std::time::Instant);
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, CachedToken>>,
    > = std::sync::OnceLock::new();
    let failure = || {
        error(
            "cursor-origin",
            "The source control operation could not be completed.",
        )
    };
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new(Default::default()))
        .lock()
        .map_err(|_| failure())?;
    let key = settings.map_or_else(
        || cwd.to_path_buf(),
        |settings| settings.path().to_path_buf(),
    );
    if let Some((result, expires)) = cache.get(&key) {
        if *expires > std::time::Instant::now()
            && match result {
                Ok(token) => rejected != Some(token.as_str()),
                Err(_) => true,
            }
        {
            return result.clone();
        }
    }
    let mut command = Command::new("origin");
    command
        .current_dir(cwd)
        .args(["auth", "token"])
        .env("NO_COLOR", "1");
    let result = run_classified_bounded(&mut command, Duration::from_secs(30), 65536)
        .map_err(|_| failure())
        .and_then(|output| String::from_utf8(output).map_err(|_| failure()))
        .and_then(|output| {
            let token = output.trim().to_owned();
            if token.is_empty() {
                Err(failure())
            } else {
                Ok(token)
            }
        });
    let ttl = if result.is_ok() { 300 } else { 10 };
    cache.retain(|_, (_, expires)| *expires > std::time::Instant::now());
    cache.insert(
        key,
        (
            result.clone(),
            std::time::Instant::now() + Duration::from_secs(ttl),
        ),
    );
    result
}
fn cursor_origin_api(
    path: &str,
    method: &str,
    body: Option<&Value>,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let failure = || {
        error(
            "cursor-origin",
            "The source control operation could not be completed.",
        )
    };
    let endpoint = format!("https://api.cursor.com{path}");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure())?;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        if let Ok(pem) = std::fs::read(path) {
            if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                builder = builder.add_root_certificate(cert);
            }
        }
    }
    let client = builder.build().map_err(|_| failure())?;
    let mut raw = None;
    let mut rejected = None::<String>;
    for attempt in 0..2 {
        let token = cursor_origin_token(cwd, settings, rejected.as_deref())?;
        let (status, bytes) = runtime.block_on(async {
            let request = match method {
                "POST" => client.post(&endpoint),
                "PATCH" => client.patch(&endpoint),
                _ => client.get(&endpoint),
            };
            let request = if let Some(body) = body {
                request
                    .header("Content-Type", "application/json")
                    .body(body.to_string())
            } else {
                request
            };
            let mut response = request
                .bearer_auth(&token)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|_| failure())?;
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| failure())? {
                if bytes.len().saturating_add(chunk.len()) > 8_000_000 {
                    return Err(failure());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, Value>((status, bytes))
        })?;
        if status.as_u16() == 401 && attempt == 0 {
            rejected = Some(token);
            continue;
        }
        if !status.is_success() {
            return Err(if matches!(status.as_u16(), 401 | 429) {
                error(
                    "cursor-origin",
                    if status.as_u16() == 401 {
                        "The source control provider is not authenticated."
                    } else {
                        "The source control provider rate limit was exceeded."
                    },
                )
            } else {
                failure()
            });
        }
        raw = Some(serde_json::from_slice::<Value>(&bytes).map_err(|_| failure())?);
        break;
    }
    raw.ok_or_else(failure)
}
fn cursor_origin_normalize(raw: &Value, repository: &str) -> Result<Value, Value> {
    let failure = || {
        error(
            "cursor-origin",
            "The source control operation could not be completed.",
        )
    };
    let name = raw["name"].as_str().ok_or_else(failure)?;
    for key in ["fullName", "defaultBranch", "cloneUrl"] {
        if raw.get(key).is_some_and(|v| !v.is_null() && !v.is_string()) {
            return Err(failure());
        }
    }
    for key in ["allowMergeCommit", "allowSquashMerge"] {
        if raw
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_boolean())
        {
            return Err(failure());
        }
    }
    if raw
        .get("owner")
        .is_some_and(|owner| !owner.is_null() && owner["slug"].as_str().is_none())
    {
        return Err(failure());
    }
    let full = raw["fullName"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            raw["owner"]["slug"]
                .as_str()
                .map(|owner| format!("{owner}/{name}"))
        })
        .unwrap_or_else(|| repository.to_owned());
    let url = raw["cloneUrl"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("https://origin.cursor.com/{full}.git"));
    Ok(json!({"provider":"cursor-origin","nameWithOwner":full,"url":url,"sshUrl":url}))
}
fn cursor_origin_lookup(
    repository: &str,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let path = format!(
        "/v1/origin/repos/{}",
        repository
            .split('/')
            .map(crate::message_commands::encode_id_part)
            .collect::<Vec<_>>()
            .join("/")
    );
    let raw = cursor_origin_api(&path, "GET", None, cwd, settings)?;
    cursor_origin_normalize(&raw, repository)
}
pub(crate) fn cursor_origin_create(
    repository: &str,
    visibility: &str,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let failure = |detail: &str| json!({"_tag":"SourceControlRepositoryError","provider":"cursor-origin","operation":"publishRepository","detail":"The source control operation could not be completed.","cause":{"name":"SourceControlProviderError","message":format!("Source control provider cursor-origin failed in createRepository: {detail}"),"cause":{"name":"OriginCliError","message":format!("Cursor Origin failed in createRepository: {detail}")}}});
    if visibility == "public" {
        return Err(failure(
            "Cursor Origin repositories are private. Choose private visibility.",
        ));
    }
    let parts: Vec<_> = repository.split('/').collect();
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|part| part.trim().is_empty()) {
        return Err(failure(
            "Specify an Origin repository as owner/name or name.",
        ));
    }
    let (owner, name) = if parts.len() == 2 {
        (parts[0].to_owned(), parts[1])
    } else {
        let namespaces = cursor_origin_api("/v1/origin/namespaces", "GET", None, cwd, settings)?;
        let owner=namespaces["namespaces"].as_array().and_then(|rows|rows.iter().find(|row|row["namespace"]["type"]=="user")).and_then(|row|row["namespace"]["slug"].as_str()).filter(|s|!s.is_empty()).ok_or_else(||failure("This Cursor account has no Origin namespace. Claim one at cursor.com/codebase."))?;
        (owner.to_owned(), parts[0])
    };
    let owner_encoded = crate::message_commands::encode_id_part(&owner);
    let path = format!("/v1/origin/repos/{owner_encoded}");
    let repository = format!("{owner}/{name}");
    let created = cursor_origin_api(&path, "POST", Some(&json!({"name":name})), cwd, settings)?;
    if created.is_object() && created.get("name").is_none() {
        let detail = "Cursor Origin returned a response this version cannot read.";
        return Err(
            json!({"_tag":"SourceControlRepositoryError","provider":"cursor-origin","operation":"publishRepository","detail":"The source control operation could not be completed.","cause":{"name":"SourceControlProviderError","message":format!("Source control provider cursor-origin failed in createRepository: {detail}"),"cause":{"name":"OriginCliError","message":format!("Cursor Origin failed in createRepository: {detail}"),"cause":{"name":"SchemaError","message":"Missing key\n  at [\"name\"]"}}}}),
        );
    }
    cursor_origin_normalize(&created, &repository)
        .map_err(|_| failure("Cursor Origin returned a response this version cannot read."))?;
    let path = format!("{path}/{}", crate::message_commands::encode_id_part(name));
    for attempt in 0..3 {
        match cursor_origin_api(
            &path,
            "PATCH",
            Some(&json!({"visibility":"private"})),
            cwd,
            settings,
        ) {
            Ok(raw) => {
                if let Ok(result) = cursor_origin_normalize(&raw, &repository) {
                    return Ok(result);
                } else if attempt < 2 {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            Err(e) => {
                let stop = matches!(
                    e["detail"].as_str(),
                    Some(
                        "The source control provider is not authenticated."
                            | "The source control provider rate limit was exceeded."
                    )
                );
                if stop || attempt == 2 {
                    break;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
    Err(failure(&format!("Created {repository}, but could not make it private, so your Cursor team can still see it. Set it to private on cursor.com.")))
}
fn gitcafe_primary_remote_host(cwd: &Path) -> Option<String> {
    let mut list = Command::new("git");
    list.current_dir(cwd).arg("remote");
    let output = crate::vcs_worktree::run_command(&mut list, Duration::from_secs(10)).ok()?;
    if !output.status.success() {
        return None;
    }
    let names = String::from_utf8(output.stdout).ok()?;
    let name = names
        .lines()
        .find(|v| *v == "origin")
        .or_else(|| names.lines().next())?;
    let mut get = Command::new("git");
    get.current_dir(cwd)
        .args(["config", "--get", &format!("remote.{name}.url")]);
    let output = crate::vcs_worktree::run_command(&mut get, Duration::from_secs(10)).ok()?;
    if !output.status.success() {
        return None;
    }
    let remote = String::from_utf8(output.stdout).ok()?;
    let remote = remote.trim();
    let parsed = url::Url::parse(remote)
        .ok()
        .filter(|v| matches!(v.scheme(), "http" | "https" | "ssh") && v.host_str().is_some())
        .map(|v| {
            (
                v.host_str().unwrap_or_default().to_ascii_lowercase(),
                v.path().trim_matches('/').to_owned(),
            )
        })
        .or_else(|| forgejo_scp(remote))?;
    if !matches!(parsed.0.as_str(), "git.cafe" | "staging.git.cafe") {
        return None;
    }
    let path = parsed.1.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|v| {
            v.is_empty()
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
    {
        return None;
    }
    Some(parsed.0)
}
fn gitcafe_admission_error(repository: &str, state: &str) -> Value {
    let detail =
        format!("GitCafe repository {repository} is {state}. Check it on GitCafe before retrying.");
    json!({"_tag":"SourceControlRepositoryError","provider":"gitcafe","operation":"publishRepository","detail":"The source control operation could not be completed.","cause":{"name":"SourceControlProviderError","message":format!("Source control provider gitcafe failed in createRepository: {detail}")}})
}
pub(crate) fn gitcafe_request(
    repository: &str,
    cwd: &Path,
    settings: Option<&crate::settings::Settings>,
    visibility: Option<&str>,
) -> Result<Value, Value> {
    let failure = || {
        error(
            "gitcafe",
            "The source control operation could not be completed.",
        )
    };
    let input = repository.trim();
    let scp = forgejo_scp(input);
    let remote = url::Url::parse(input)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https" | "ssh") && url.host_str().is_some());
    let (host, path) = if let Some(url) = remote {
        (
            url.host_str().unwrap_or_default().to_ascii_lowercase(),
            url.path().trim_matches('/').to_owned(),
        )
    } else if let Some((host, path)) = scp {
        (host, path)
    } else {
        (
            gitcafe_primary_remote_host(cwd).unwrap_or_else(|| "git.cafe".to_owned()),
            input.to_owned(),
        )
    };
    if !matches!(host.as_str(), "git.cafe" | "staging.git.cafe") {
        return Err(failure());
    }
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
    {
        return Err(failure());
    }
    let mut token = None;
    if host == "git.cafe" {
        if let Some(settings) = settings {
            let mut snapshot = settings.private_snapshot();
            crate::settings::materialize_secrets(settings.path(), &mut snapshot)
                .map_err(|_| failure())?;
            let saved = &snapshot["sourceControlHosts"]["gitcafe"]["token"];
            token = source_control_secret(&snapshot, saved, "gitcafe")?;
        }
    }
    if token.is_none() {
        let configured_host = std::env::var("CAFE_HOST")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let configured = configured_host
            .as_ref()
            .cloned()
            .filter(|v| !v.trim().is_empty())
            .map(|v| {
                if v.contains("://") {
                    v
                } else {
                    format!("https://{v}")
                }
            })
            .and_then(|v| url::Url::parse(&v).ok())
            .and_then(|v| {
                v.host_str().map(|host| match v.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_owned(),
                })
            })
            .or_else(|| {
                if configured_host.is_none() {
                    Some("git.cafe".into())
                } else {
                    None
                }
            });
        if configured
            .as_ref()
            .is_some_and(|v| v.eq_ignore_ascii_case(&host))
        {
            token = std::env::var("CAFE_TOKEN")
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty());
        }
    }
    if token.is_none() {
        use std::io::{Read, Write};
        use std::process::Stdio;
        let mut command = Command::new("cafe");
        command
            .current_dir(std::env::current_dir().unwrap_or_else(|_| cwd.to_path_buf()))
            .args([
                "auth",
                "http",
                "credential",
                "--host",
                &format!("https://{host}/api"),
                "get",
            ])
            .env("CAFE_NO_UPDATE_CHECK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| failure())?;
        if let Some(mut input) = child.stdin.take() {
            input
                .write_all(format!("protocol=https\nhost={host}\n\n").as_bytes())
                .map_err(|_| failure())?;
        }
        let mut stdout = child.stdout.take().ok_or_else(failure)?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.by_ref().take(65536).read_to_end(&mut bytes);
            bytes
        });
        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let output = reader.join().unwrap_or_default();
        if !status.is_some_and(|v| v.success()) {
            return Err(failure());
        }
        token = String::from_utf8_lossy(&output).lines().find_map(|line| {
            line.strip_prefix("password=")
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        });
    }
    let token = token.ok_or_else(failure)?;
    let endpoint = if visibility.is_some() {
        format!(
            "https://{host}/api/orgs/{}/repos",
            crate::message_commands::encode_id_part(parts[0])
        )
    } else {
        format!(
            "https://{host}/api/repos/{}/{}",
            crate::message_commands::encode_id_part(parts[0]),
            crate::message_commands::encode_id_part(parts[1])
        )
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure())?;
    runtime.block_on(async {
        let mut builder=reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).user_agent("t3code");
        if let Some(file)=std::env::var_os("SSL_CERT_FILE") {if let Ok(pem)=std::fs::read(file) {if let Ok(cert)=reqwest::Certificate::from_pem(&pem) {builder=builder.add_root_certificate(cert);}}}
        let client=builder.build().map_err(|_|failure())?;
        let mut target=url::Url::parse(&endpoint).map_err(|_|failure())?;let origin=target.origin();let mut hops=0;
        let mut create_body=visibility.map(|visibility|json!({"name":parts[1],"requestKey":uuid::Uuid::new_v4().to_string(),"visibility":visibility,"defaultBranch":"main"}).to_string());
        let mut deadline=None;
        let mut initial_state=None::<String>;
        loop {
        let fetch=async {
        let mut response=loop {let request=if let Some(body)=&create_body {client.post(target.clone()).header("Content-Type","application/json").body(body.clone())}else{client.get(target.clone())};let response=request.bearer_auth(&token).header("Accept","application/json").send().await.map_err(|_|failure())?;
            if matches!(response.status().as_u16(),301|302|303|307|308) && hops<5 {if let Some(location)=response.headers().get(reqwest::header::LOCATION).and_then(|v|v.to_str().ok()){if let Ok(next)=target.join(location){if next.origin()==origin && next.path().starts_with("/api/") && next.username().is_empty() && next.password().is_none(){target=next;hops+=1;continue;}}}}break response;};
        if !response.status().is_success(){return Err(failure());}
        let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|failure())? {if bytes.len().saturating_add(chunk.len())>8*1024*1024{return Err(failure());}bytes.extend_from_slice(&chunk);}
        serde_json::from_slice::<Value>(&bytes).map_err(|_|failure())
        };
        let raw=if let Some(until)=deadline {
            tokio::time::timeout_at(until,fetch).await.map_err(|_|gitcafe_admission_error(path,initial_state.as_deref().unwrap_or("pending")))??
        } else { fetch.await? };
        if visibility.is_some() {
            let get=|key:&str|raw[key].as_str().filter(|v|!v.trim().is_empty()).ok_or_else(failure);
            let owner=get("owner")?;let name=get("name")?;let id=get("repoId")?;let state=get("state")?;
            if state=="complete" {let repo=format!("{owner}/{name}");return Ok(json!({"provider":"gitcafe","nameWithOwner":repo,"url":format!("https://{host}/{repo}"),"sshUrl":format!("ssh@{host}:{repo}.git")}));}
            if initial_state.is_none() { initial_state=Some(state.to_owned()); }
            let until=*deadline.get_or_insert_with(||tokio::time::Instant::now()+Duration::from_secs(30));
            if state=="blocked" || tokio::time::Instant::now()>=until {return Err(gitcafe_admission_error(path,state));}
            if create_body.is_none() { tokio::time::sleep(Duration::from_millis(500)).await; }
            target=url::Url::parse(&format!("https://{host}/api/orgs/{}/admissions/{}",crate::message_commands::encode_id_part(owner),crate::message_commands::encode_id_part(id))).map_err(|_|failure())?;
            create_body=None;hops=0;continue;
        }
        if raw["name"].as_str().is_none_or(|v|v.trim().is_empty()) || !(raw["defaultBranch"].is_null() || raw["defaultBranch"].as_str().is_some_and(|v|!v.trim().is_empty())) || raw.get("defaultBranch").is_none(){return Err(failure());}
        return Ok(json!({"provider":"gitcafe","nameWithOwner":path,"url":format!("https://{host}/{path}"),"sshUrl":format!("ssh@{host}:{path}.git")}));
        }
    })
}
fn forgejo_scp(repository: &str) -> Option<(String, String)> {
    let pattern = regex::Regex::new(r"^(?:[^@/]+@)?([^:/]+):([^/].*)$").expect("valid SCP pattern");
    let captures = pattern.captures(repository.trim())?;
    Some((captures[1].to_ascii_lowercase(), captures[2].to_owned()))
}
#[cfg(unix)]
fn forgejo_fj_lookup(repository: &str, visibility: Option<&str>) -> Option<Result<Value, Value>> {
    let failure = || {
        error(
            "forgejo",
            "The source control operation could not be completed.",
        )
    };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".local/share"));
    let path = data.join("forgejo-cli/keys.json");
    let data = std::fs::read(&path).ok()?;
    let keys: Value = match serde_json::from_slice(&data) {
        Ok(v) => v,
        Err(_) => return Some(Err(failure())),
    };
    let hosts = match keys["hosts"].as_object() {
        Some(v) => v,
        None => return Some(Err(failure())),
    };
    if hosts.is_empty() {
        return None;
    }
    let remote = url::Url::parse(repository)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());
    let scp = forgejo_scp(repository);
    let candidates: Vec<_> = hosts
        .keys()
        .filter(|host| {
            let Ok(base) = url::Url::parse(&format!("https://{host}/")) else {
                return false;
            };
            base.host_str().is_some()
                && base.path() == "/"
                && scp.as_ref().is_none_or(|(ssh, _)| {
                    base.host_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(ssh))
                        || keys["aliases"][ssh].as_str() == Some(host.as_str())
                })
                && remote.as_ref().is_none_or(|url| {
                    url.host_str() == base.host_str() && url.port() == base.port()
                })
        })
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    let host = candidates[0];
    let scheme = if remote.as_ref().is_some_and(|url| url.scheme() == "http") {
        "http"
    } else {
        "https"
    };
    let base = format!("{scheme}://{host}");
    let mut whoami = Command::new("fj");
    whoami.current_dir(&home).args(["--host", &base, "whoami"]);
    match crate::vcs_worktree::run_command(&mut whoami, Duration::from_secs(30)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Ok(output) if output.status.success() => {}
        _ => return Some(Err(failure())),
    }
    let keys: Value = match std::fs::read(&path)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
    {
        Some(v) => v,
        None => return Some(Err(failure())),
    };
    let token = match keys["hosts"][host]["token"]
        .as_str()
        .filter(|v| !v.is_empty())
    {
        Some(v) => v.to_owned(),
        None => return Some(Err(failure())),
    };
    let repo = remote
        .as_ref()
        .map(|v| v.path().trim_matches('/'))
        .or_else(|| scp.as_ref().map(|(_, path)| path.as_str()))
        .unwrap_or(repository.trim())
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|v| v.is_empty() || v.chars().any(char::is_whitespace))
    {
        return Some(Err(failure()));
    }
    let endpoint = format!(
        "{base}/api/v1/repos/{}/{}",
        crate::message_commands::encode_id_part(parts[0]),
        crate::message_commands::encode_id_part(parts[1])
    );
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(v) => v,
        Err(_) => return Some(Err(failure())),
    };
    let result=runtime.block_on(async {
        let client=reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|failure())?;
        let (endpoint, body) = if let Some(visibility) = visibility {
            let mut response = client.get(format!("{base}/api/v1/user")).header("Authorization",format!("token {token}")).send().await.map_err(|_|failure())?;
            if !response.status().is_success() { return Err(failure()); }
            let mut bytes=Vec::new(); while let Some(chunk)=response.chunk().await.map_err(|_|failure())? { if bytes.len().saturating_add(chunk.len())>1024*1024 {return Err(failure());} bytes.extend_from_slice(&chunk); }
            let viewer:Value=serde_json::from_slice(&bytes).map_err(|_|failure())?;
            let login=viewer["login"].as_str().ok_or_else(failure)?;
            let path=if parts[0]==login {"user/repos".to_owned()} else {format!("orgs/{}/repos",crate::message_commands::encode_id_part(parts[0]))};
            (format!("{base}/api/v1/{path}"),Some(json!({"name":parts[1],"private":visibility=="private","auto_init":false}).to_string()))
        } else { (endpoint, None) };
        let mut target=url::Url::parse(&endpoint).map_err(|_|failure())?;
        let origin=target.origin();
        let mut hops=0;
        let mut response=loop {
            let request=if let Some(body)=&body {client.post(target.clone()).header("Content-Type","application/json").body(body.clone())} else {client.get(target.clone())};
            let response=request.header("Authorization",format!("token {token}")).send().await.map_err(|_|failure())?;
            if matches!(response.status().as_u16(),301|302|307|308) && hops<5 {
                if let Some(location)=response.headers().get(reqwest::header::LOCATION).and_then(|v|v.to_str().ok()) {
                    if let Ok(next)=target.join(location) {
                        if next.origin()==origin && next.path().starts_with("/api/v1/") && next.username().is_empty() && next.password().is_none() {target=next;hops+=1;continue;}
                    }
                }
            }
            break response;
        };
        if !response.status().is_success(){return Err(failure());}
        let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|failure())? {if bytes.len().saturating_add(chunk.len())>8*1024*1024 {return Err(failure());} bytes.extend_from_slice(&chunk);}
        let raw:Value=serde_json::from_slice(&bytes).map_err(|_|failure())?;
        let value=|key:&str|raw[key].as_str().filter(|v|!v.is_empty()).ok_or_else(failure);
        Ok(json!({"provider":"forgejo","nameWithOwner":value("full_name")?,"url":value("clone_url")?,"sshUrl":value("ssh_url")?}))
    });
    Some(result)
}
#[cfg(not(unix))]
fn forgejo_fj_lookup(_repository: &str, _visibility: Option<&str>) -> Option<Result<Value, Value>> {
    None
}
pub(crate) fn forgejo_request(
    repository: &str,
    cwd: &Path,
    visibility: Option<&str>,
) -> Result<Value, Value> {
    if let Some(result) = forgejo_fj_lookup(repository, visibility) {
        return result;
    }
    let failure = || {
        error(
            "forgejo",
            "The source control operation could not be completed.",
        )
    };
    let mut login_command = Command::new("tea");
    login_command
        .current_dir(cwd)
        .args(["login", "list", "--output", "json"]);
    let output = crate::vcs_worktree::run_command(&mut login_command, Duration::from_secs(30))
        .map_err(|_| failure())?;
    if !output.status.success() {
        return Err(failure());
    }
    let logins: Vec<Value> = serde_json::from_slice(&output.stdout).map_err(|_| failure())?;
    let parsed = url::Url::parse(repository)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());
    let scp = forgejo_scp(repository);
    let selected = if let Some((ssh, _)) = &scp {
        let matches: Vec<_> = logins
            .iter()
            .filter(|login| {
                login["ssh_host"]
                    .as_str()
                    .is_some_and(|v| v.eq_ignore_ascii_case(ssh))
                    || login["url"]
                        .as_str()
                        .and_then(|v| url::Url::parse(v).ok())
                        .and_then(|u| u.host_str().map(str::to_owned))
                        .is_some_and(|v| v.eq_ignore_ascii_case(ssh))
            })
            .collect();
        if matches.len() == 1 {
            matches.first().copied()
        } else {
            matches.into_iter().find(|login| login["default"] == "true")
        }
    } else if let Some(remote) = &parsed {
        let matches: Vec<_> = logins
            .iter()
            .filter(|login| {
                login["url"]
                    .as_str()
                    .and_then(|v| url::Url::parse(v).ok())
                    .is_some_and(|url| {
                        url.host_str() == remote.host_str()
                            && url.port_or_known_default() == remote.port_or_known_default()
                            && (url.path() == "/"
                                || remote.path() == url.path()
                                || remote
                                    .path()
                                    .starts_with(&format!("{}/", url.path().trim_end_matches('/'))))
                    })
            })
            .collect();
        if matches.len() == 1 {
            matches.first().copied()
        } else {
            matches.into_iter().find(|login| login["default"] == "true")
        }
    } else {
        logins
            .iter()
            .find(|login| login["default"] == "true")
            .or_else(|| {
                if logins.len() == 1 {
                    logins.first()
                } else {
                    None
                }
            })
    }
    .ok_or_else(failure)?;
    let name = selected["name"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(failure)?;
    let base = selected["url"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(failure)?
        .trim_end_matches('/');
    let mut repo = if let Some(remote) = &parsed {
        remote.path().trim_matches('/').to_owned()
    } else if let Some((_, path)) = &scp {
        path.clone()
    } else {
        repository.trim().to_owned()
    };
    if let Ok(url) = url::Url::parse(base) {
        let mount = url.path().trim_matches('/');
        if !mount.is_empty() && repo.starts_with(&format!("{mount}/")) {
            repo = repo[mount.len() + 1..].to_owned();
        }
    }
    repo = repo
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(repo.trim_end_matches('/'))
        .to_owned();
    if !repo.contains('/') {
        let user = selected["user"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(failure)?;
        repo = format!("{user}/{repo}");
    }
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|v| v.is_empty() || v.chars().any(char::is_whitespace))
    {
        return Err(failure());
    }
    let api = |path: &str, body: Option<&Value>| -> Result<Value, Value> {
        let endpoint = format!("{base}/api/v1/{path}");
        let mut command = Command::new("tea");
        command.current_dir(cwd).args([
            "api",
            "--include",
            "--login",
            name,
            "--repo",
            &repo,
            "--method",
            if body.is_some() { "POST" } else { "GET" },
        ]);
        if body.is_some() {
            command.args(["--data", "@-"]);
        }
        command.arg(&endpoint);
        let input = body.map(Value::to_string);
        let output = crate::vcs_worktree::run_command_input(
            &mut command,
            Duration::from_secs(30),
            input.as_deref().map(str::as_bytes),
        )
        .map_err(|_| failure())?;
        let status = String::from_utf8_lossy(&output.stderr);
        let status = status.lines().find_map(|line| {
            line.strip_prefix("HTTP/")
                .and_then(|v| v.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u16>().ok())
        });
        if !output.status.success() || !matches!(status, Some(200..=399)) {
            return Err(failure());
        }
        serde_json::from_slice(&output.stdout).map_err(|_| failure())
    };
    let raw = if let Some(visibility) = visibility {
        let viewer = api("user", None)?;
        let login = viewer["login"].as_str().ok_or_else(failure)?;
        let endpoint = if parts[0] == login {
            "user/repos".to_owned()
        } else {
            format!(
                "orgs/{}/repos",
                crate::message_commands::encode_id_part(parts[0])
            )
        };
        api(
            &endpoint,
            Some(&json!({"name":parts[1],"private":visibility=="private","auto_init":false})),
        )?
    } else {
        api(
            &format!(
                "repos/{}/{}",
                crate::message_commands::encode_id_part(parts[0]),
                crate::message_commands::encode_id_part(parts[1])
            ),
            None,
        )?
    };
    let value = |key: &str| {
        raw[key]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(failure)
    };
    Ok(
        json!({"provider":"forgejo","nameWithOwner":value("full_name")?,"url":value("clone_url")?,"sshUrl":value("ssh_url")?}),
    )
}
pub(crate) fn github_selector(input: &str) -> Option<(String, String)> {
    let input = input.trim();
    if input.split('/').any(|part| part == "." || part == "..") {
        return None;
    }
    let (host, path) = if let Ok(url) = url::Url::parse(input) {
        if !matches!(url.scheme(), "http" | "https" | "ssh") || url.host_str().is_none() {
            return None;
        }
        (
            url[url::Position::BeforeHost..url::Position::AfterPort].to_lowercase(),
            url.path().trim_matches('/').to_owned(),
        )
    } else if let Some((userhost, path)) = input.split_once(':') {
        let host = userhost.rsplit('@').next()?.to_lowercase();
        if host.is_empty() {
            return None;
        }
        (host, path.trim_matches('/').to_owned())
    } else {
        let parts: Vec<_> = input.split('/').collect();
        if parts.len() == 3 && parts[0].contains('.') {
            (parts[0].to_lowercase(), parts[1..].join("/"))
        } else {
            (
                std::env::var("GH_HOST")
                    .unwrap_or_else(|_| "github.com".into())
                    .to_lowercase(),
                input.trim_matches('/').into(),
            )
        }
    };
    let path = path.strip_suffix(".git").unwrap_or(&path);
    let parts: Vec<_> = path.split('/').collect();
    if parts.is_empty()
        || parts.len() > 2
        || parts.iter().any(|v| {
            v.is_empty()
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    Some((host, path.into()))
}
pub(crate) fn lookup(
    input: &Value,
    settings: Option<&crate::settings::Settings>,
) -> Result<Value, Value> {
    let provider = input["provider"].as_str().unwrap_or("unknown");
    let repository = input["repository"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(provider, "Enter a repository name."))?;
    let cwd = input["cwd"]
        .as_str()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("."));
    if !cwd.is_dir() {
        return Err(error(
            provider,
            "The source control working directory is unavailable.",
        ));
    }
    let raw = match provider {
        "github" => {
            let (host, mut name) = github_selector(repository)
                .ok_or_else(|| error(provider, "Repositories are named owner/name."))?;
            if !name.contains('/') {
                let viewer = github_api(&host, "user", cwd, settings)?;
                let login = viewer["login"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        error(
                            provider,
                            "The source control provider returned an invalid repository.",
                        )
                    })?;
                name = format!("{login}/{name}");
            }
            let (owner, repo) = name
                .split_once('/')
                .ok_or_else(|| error(provider, "Repositories are named owner/name."))?;
            let path = format!("repos/{}/{}", encode(owner), encode(repo));
            github_api(&host, &path, cwd, settings)?
        }
        "bitbucket" => return bitbucket_request(repository, settings, None),
        "forgejo" => return forgejo_request(repository, cwd, None),
        "gitcafe" => return gitcafe_request(repository, cwd, settings, None),
        "cursor-origin" => return cursor_origin_lookup(repository, cwd, settings),
        "gitlab" => {
            let name = repository
                .trim()
                .trim_end_matches('/')
                .trim_end_matches(".git");
            if name.is_empty() || name.starts_with('-') {
                return Err(error(provider, "Enter a repository name."));
            }
            let path = format!("projects/{}", encode(name));
            let mut cmd = Command::new("glab");
            cmd.args(["api", &path])
                .current_dir(cwd)
                .env("GLAB_PROMPT_DISABLED", "1");
            run(&mut cmd, provider)?
        }
        "azure-devops" => {
            let parts: Vec<_> = repository
                .split('/')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            let name = parts.last().copied().unwrap_or(repository);
            let mut cmd = Command::new("az");
            cmd.args(["repos", "show", "--detect", "true", "--repository", name]);
            if parts.len() > 1 {
                cmd.args(["--project", parts[parts.len() - 2]]);
            }
            cmd.args(["--only-show-errors", "--output", "json"])
                .current_dir(cwd);
            run(&mut cmd, provider)?
        }
        "unknown" => {
            return Err(error(
                provider,
                "Choose a source control provider before continuing.",
            ))
        }
        _ => {
            return Err(error(
                provider,
                "This source control provider is not supported.",
            ))
        }
    };
    if provider == "azure-devops" {
        let required = |field: &str| raw[field].as_str().filter(|s| !s.trim().is_empty());
        let name = required("name").ok_or_else(|| {
            error(
                provider,
                "The source control provider returned an invalid repository.",
            )
        })?;
        let _web = required("webUrl").ok_or_else(|| {
            error(
                provider,
                "The source control provider returned an invalid repository.",
            )
        })?;
        let url = required("remoteUrl").ok_or_else(|| {
            error(
                provider,
                "The source control provider returned an invalid repository.",
            )
        })?;
        let ssh = required("sshUrl").ok_or_else(|| {
            error(
                provider,
                "The source control provider returned an invalid repository.",
            )
        })?;
        let full = raw["project"]["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(|project| format!("{}/{name}", project.trim()))
            .unwrap_or_else(|| name.to_owned());
        return Ok(json!({"provider":provider,"nameWithOwner":full,"url":url,"sshUrl":ssh}));
    }
    if provider == "gitlab"
        && raw["http_url_to_repo"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
    {
        return Err(error(
            provider,
            "The source control provider returned an invalid repository.",
        ));
    }
    let fields = if provider == "github" {
        (&raw["full_name"], &raw["html_url"], &raw["ssh_url"])
    } else {
        (
            &raw["path_with_namespace"],
            &raw["web_url"],
            &raw["ssh_url_to_repo"],
        )
    };
    if ![fields.0, fields.1, fields.2]
        .iter()
        .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
    {
        return Err(error(
            provider,
            "The source control provider returned an invalid repository.",
        ));
    }
    Ok(json!({"provider":provider,"nameWithOwner":fields.0,"url":fields.1,"sshUrl":fields.2}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_repository_response_requires_valid_schema() {
        assert!(cursor_origin_normalize(&json!({}), "group/repo").is_err());
        assert!(cursor_origin_normalize(&json!({"name":"repo","owner":{}}), "group/repo").is_err());
        assert!(
            cursor_origin_normalize(&json!({"name":"repo","cloneUrl":42}), "group/repo").is_err()
        );
        assert!(cursor_origin_normalize(
            &json!({"name":"repo","owner":{"slug":"group"}}),
            "group/repo"
        )
        .is_ok());
    }
    #[test]
    fn github_selectors_preserve_host_and_reject_invalid_names() {
        assert_eq!(
            github_selector("https://github.example/acme/project.git"),
            Some(("github.example".into(), "acme/project".into()))
        );
        assert_eq!(
            github_selector("git@github.example:acme/project.git"),
            Some(("github.example".into(), "acme/project".into()))
        );
        assert!(github_selector("https://github.example/acme/../project").is_none());
        assert!(github_selector("https://github.example/acme/project/extra").is_none());
    }
}
