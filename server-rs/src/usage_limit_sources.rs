//! Usage limit sources polling, CliproxyAPI client, and reset-credit redemption.

use crate::background_activity::ClientActivity;
use crate::settings::Settings;
use chrono::{DateTime, Utc};
use ring::digest::{Context as DigestContext, SHA1_FOR_LEGACY_USE_ONLY};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};
use url::Url;

const CODEX_BASE: &str = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const GROK_USAGE_URL: &str = "https://api.x.ai/v1/usage";
const GROK_CLI_VERSION: &str = "1.0.77";
const ANTIGRAVITY_SUMMARY_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const CREDIT_REDEEM_NAMESPACE: [u8; 16] = [
    0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
];

#[derive(Clone)]
pub struct UsageLimitSources {
    state_tx: Arc<watch::Sender<Vec<Value>>>,
    _state_rx: watch::Receiver<Vec<Value>>,
    source_endpoints: Arc<Mutex<HashMap<String, String>>>,
    http: reqwest::Client,
    settings: Arc<Settings>,
}

impl UsageLimitSources {
    pub fn new(settings: Arc<Settings>) -> Self {
        let (state_tx, state_rx) = watch::channel(Vec::new());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("t3code-server")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            state_tx: Arc::new(state_tx),
            _state_rx: state_rx,
            source_endpoints: Arc::new(Mutex::new(HashMap::new())),
            http,
            settings,
        }
    }

    pub fn current(&self) -> Vec<Value> {
        self.state_tx.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Vec<Value>> {
        self.state_tx.subscribe()
    }

    fn publish(&self, next: Vec<Value>) {
        let changed = *self.state_tx.borrow() != next;
        if changed {
            let _ = self.state_tx.send(next);
        }
    }

    pub async fn refresh(&self) {
        let mut previous_endpoints = self.source_endpoints.lock().await;
        let mut settings = self.settings.private_snapshot();
        let _ = crate::settings::materialize_secrets(self.settings.path(), &mut settings);
        let entries: Vec<(String, Value)> = settings
            .get("usageLimitSources")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter(|(_, cfg)| cfg.get("enabled") == Some(&Value::Bool(true)))
                    .map(|(id, cfg)| (id.clone(), cfg.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let next_endpoints: HashMap<_, _> = entries
            .iter()
            .filter_map(|(id, config)| Some((id.clone(), config["url"].as_str()?.to_owned())))
            .collect();
        let mut handles = Vec::with_capacity(entries.len());
        for (id, config) in entries {
            let http = self.http.clone();
            let settings_clone = settings.clone();
            handles.push(tokio::spawn(async move {
                read_source(&http, &settings_clone, &id, &config).await
            }));
        }
        let mut snapshots = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok(snapshot) = handle.await {
                snapshots.push(snapshot);
            }
        }
        let previous = self.state_tx.borrow();
        for source in &mut snapshots {
            let Some(id) = source["id"].as_str() else { continue };
            if previous_endpoints.get(id).is_some_and(|url| next_endpoints.get(id) == Some(url)) {
                if let Some(last) = previous.iter().find(|entry| entry["id"] == id) {
                    keep_last_good_readings(last, source);
                }
            }
        }
        drop(previous);
        *previous_endpoints = next_endpoints;
        self.publish(snapshots);
    }

    pub async fn consume_reset_credit(&self, input: &Value) -> Result<Value, Value> {
        let mut endpoints = self.source_endpoints.lock().await;
        let source_id = input
            .get("sourceId")
            .and_then(Value::as_str)
            .ok_or_else(|| source_error("sourceId is required."))?;
        let account_id = input
            .get("accountId")
            .and_then(Value::as_str)
            .ok_or_else(|| source_error("accountId is required."))?;
        let credit_id = input
            .get("creditId")
            .and_then(Value::as_str)
            .ok_or_else(|| source_error("creditId is required."))?;

        let mut settings = self.settings.private_snapshot();
        let _ = crate::settings::materialize_secrets(self.settings.path(), &mut settings);
        let config = settings
            .get("usageLimitSources")
            .and_then(|s| s.get(source_id))
            .filter(|cfg| cfg.get("enabled") == Some(&Value::Bool(true)))
            .ok_or_else(|| source_error("The usage limit source is missing or disabled."))?;

        let hub_url = config
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| source_error("The hub URL is not valid."))?;
        let management_key = resolve_management_key(&settings, config).await;
        if management_key.is_empty() {
            return Err(source_error(&missing_management_key(config)));
        }

        let files = fetch_auth_files(&self.http, hub_url, &management_key).await?;
        let account = files
            .iter()
            .find(|a| {
                a.get("id").and_then(Value::as_str) == Some(account_id)
                    && a.get("disabled") != Some(&Value::Bool(true))
                    && a.get("provider").and_then(Value::as_str) == Some("codex")
            })
            .ok_or_else(|| source_error("The Codex hub account is missing or disabled."))?;

        let auth_index = account
            .get("auth_index")
            .and_then(Value::as_str)
            .unwrap_or("");
        let identity = account
            .get("id_token")
            .and_then(|t| t.get("chatgpt_account_id"))
            .and_then(Value::as_str)
            .unwrap_or(account_id);
        let redeem_request_id = credit_redeem_request_id(identity, credit_id);
        let headers = codex_headers(account);
        let body = api_call(
            &self.http,
            hub_url,
            &management_key,
            auth_index,
            "POST",
            &format!("{CREDIT_URL}/consume"),
            &headers,
            Some(&json!({
                "redeem_request_id": redeem_request_id,
                "credit_id": credit_id,
            })),
        )
        .await?;

        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| source_error("The hub returned an unexpected reset-credit response."))?;
        let outcome = match parsed.get("code").and_then(Value::as_str) {
            Some("reset") => "reset",
            Some("nothing_to_reset") => "nothingToReset",
            Some("no_credit") => "noCredit",
            Some("already_redeemed") => "alreadyRedeemed",
            _ => {
                return Err(source_error(
                    "The hub returned an unexpected reset-credit response.",
                ))
            }
        };

        let mut result = json!({ "outcome": outcome });
        if outcome == "reset" || outcome == "alreadyRedeemed" {
            let cleared = management_request(
                &self.http,
                hub_url,
                &management_key,
                "reset-quota",
                Some(&json!({ "auth_index": auth_index })),
            )
            .await;
            if cleared.is_err() {
                result["warning"] = json!(
                    "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires."
                );
            }
        }

        let updated_snapshot = read_source(&self.http, &settings, source_id, config).await;
        endpoints.insert(source_id.to_owned(), hub_url.to_owned());
        let next: Vec<Value> = self
            .current()
            .into_iter()
            .map(|src| {
                if src.get("id").and_then(Value::as_str) == Some(source_id) {
                    updated_snapshot.clone()
                } else {
                    src
                }
            })
            .collect();
        self.publish(next);
        Ok(result)
    }

    pub fn start_background_loop(&self, background: Arc<ClientActivity>) {
        let initial = self.clone();
        tokio::spawn(async move {
            initial.refresh().await;
        });

        let settings_watcher = self.clone();
        let mut settings_rx = self.settings.subscribe();
        let mut last_sources = self.settings.private_snapshot()["usageLimitSources"].clone();
        tokio::spawn(async move {
            loop {
                match settings_rx.recv().await {
                    Ok(_) => {
                        let current_sources =
                            settings_watcher.settings.private_snapshot()["usageLimitSources"]
                                .clone();
                        if current_sources != last_sources {
                            last_sources = current_sources;
                            settings_watcher.refresh().await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        settings_watcher.refresh().await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        let periodic = self.clone();
        tokio::spawn(async move {
            loop {
                let snapshot = periodic.settings.snapshot();
                let wait_ms = ClientActivity::provider_refresh_interval(&snapshot).max(60_000);
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                let latest = periodic.settings.snapshot();
                if ClientActivity::provider_refresh_interval(&latest) > 0
                    && background.has_provider_demand(&latest)
                {
                    periodic.refresh().await;
                }
            }
        });
    }
}

fn source_error(detail: &str) -> Value {
    json!({
        "_tag": "UsageLimitSourceError",
        "detail": detail,
        "message": detail,
    })
}

fn source_label(id: &str, config: &Value) -> String {
    if let Some(label) = config
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return label.to_owned();
    }
    let fallback = match id.trim() {
        "" => "Usage limit source",
        other => other,
    };
    if let Some(url_str) = config.get("url").and_then(Value::as_str) {
        if let Ok(parsed) = Url::parse(url_str) {
            if let Some(host) = parsed.host_str().filter(|h| !h.is_empty()) {
                return host.to_owned();
            }
        }
    }
    fallback.to_owned()
}

fn missing_management_key(config: &Value) -> String {
    if config.get("managementKey").is_some_and(Value::is_string) {
        "No management key configured.".to_owned()
    } else {
        "Could not read the management key from its secret provider.".to_owned()
    }
}

async fn resolve_management_key(settings: &Value, config: &Value) -> String {
    match config.get("managementKey") {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(reference) if reference.is_object() => {
            crate::mcp_secret::resolve_reference(settings, reference)
                .await
                .unwrap_or_default()
                .trim()
                .to_owned()
        }
        _ => String::new(),
    }
}

fn build_management_url(raw_url: &str, path: &str) -> Result<String, Value> {
    let mut base =
        Url::parse(raw_url).map_err(|_| source_error("The hub URL is not valid."))?;
    let current_path = base.path().to_owned();
    let trimmed = current_path
        .strip_suffix("/management.html")
        .or_else(|| current_path.strip_suffix("/management.html/"))
        .unwrap_or(&current_path)
        .trim_end_matches('/');
    let next_path = if trimmed.is_empty() {
        format!("/v0/management/{path}")
    } else {
        format!("{trimmed}/v0/management/{path}")
    };
    base.set_path(&next_path);
    base.set_query(None);
    base.set_fragment(None);
    Ok(base.to_string())
}

async fn management_request(
    http: &reqwest::Client,
    hub_url: &str,
    management_key: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, Value> {
    let url = build_management_url(hub_url, path)?;
    let req = match body {
        None => http.get(&url),
        Some(payload) => http
            .post(&url)
            .header("Content-Type", "application/json")
            .body(payload.to_string()),
    }
    .header("Authorization", format!("Bearer {management_key}"));

    let resp = req.send().await.map_err(|err| {
        if err.is_timeout() {
            source_error("The hub did not answer within 15 seconds.")
        } else {
            source_error("The hub management request failed.")
        }
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(source_error(&format!(
            "The hub answered with HTTP {}.",
            status.as_u16()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|_| source_error("The hub management request failed."))?;
    serde_json::from_str::<Value>(&text)
        .map_err(|_| source_error("The hub management request failed."))
}

async fn fetch_auth_files(
    http: &reqwest::Client,
    hub_url: &str,
    management_key: &str,
) -> Result<Vec<Value>, Value> {
    let raw = management_request(http, hub_url, management_key, "auth-files", None).await?;
    raw.get("files")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| source_error("The hub could not list accounts."))
}

#[allow(clippy::too_many_arguments)]
async fn api_call(
    http: &reqwest::Client,
    hub_url: &str,
    management_key: &str,
    auth_index: &str,
    method: &str,
    url: &str,
    header: &Value,
    data: Option<&Value>,
) -> Result<String, Value> {
    let mut payload = json!({
        "auth_index": auth_index,
        "method": method,
        "url": url,
        "header": header,
    });
    if let Some(d) = data {
        payload["data"] = Value::String(d.to_string());
    }
    let raw = management_request(http, hub_url, management_key, "api-call", Some(&payload)).await?;
    let status_code = raw
        .get("status_code")
        .and_then(Value::as_u64)
        .ok_or_else(|| source_error("The hub management request failed."))?;
    let body = raw
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| source_error("The hub management request failed."))?;
    if !(200..300).contains(&status_code) {
        return Err(source_error(&format!(
            "The provider refused the hub request (HTTP {status_code})."
        )));
    }
    Ok(body.to_owned())
}

fn keep_last_good_readings(previous: &Value, next: &mut Value) {
    let (Some(previous), Some(accounts)) = (
        previous["accounts"].as_array(),
        next["accounts"].as_array_mut(),
    ) else {
        return;
    };
    for account in accounts {
        if account["usageLimits"]["unavailable"]["reason"] != "probeFailed"
            || (account["email"].is_null() && account["workspaceId"].is_null())
        {
            continue;
        }
        if let Some(last) = previous.iter().find(|last| {
            last["usageLimits"]["unavailable"].is_null()
                && last["usageLimits"]["credentialFingerprint"].is_null()
                && ["id", "driver", "email", "workspaceId"]
                    .iter()
                    .all(|key| last[*key] == account[*key])
        }) {
            account["usageLimits"] = last["usageLimits"].clone();
        }
    }
}

async fn read_source(http: &reqwest::Client, settings: &Value, id: &str, config: &Value) -> Value {
    let checked_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let kind = config
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("cliproxyapi");
    let label = source_label(id, config);
    let hub_url = config.get("url").and_then(Value::as_str).unwrap_or("");
    let origin = Url::parse(hub_url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.origin().ascii_serialization());

    let mut base = json!({
        "id": id,
        "kind": kind,
        "label": label,
        "checkedAt": checked_at,
        "accounts": [],
    });
    if let Some(orig) = origin {
        base["origin"] = Value::String(orig);
    }

    let management_key = resolve_management_key(settings, config).await;
    if management_key.is_empty() {
        base["error"] = Value::String(missing_management_key(config));
        return base;
    }

    let files = match fetch_auth_files(http, hub_url, &management_key).await {
        Ok(files) => files,
        Err(err) => {
            base["error"] = Value::String(
                err.get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("The hub could not list accounts.")
                    .to_owned(),
            );
            return base;
        }
    };

    let mut accounts = Vec::new();
    for account in files {
        if account.get("disabled") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(provider) = account.get("provider").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(provider, "codex" | "claude" | "xai" | "antigravity") {
            continue;
        }
        accounts.push(read_account(http, hub_url, &management_key, &account, provider).await);
    }
    base["accounts"] = Value::Array(accounts);
    base
}

fn listed_identity(account: &Value, obj: &mut serde_json::Map<String, Value>) {
    if let Some(email) = account
        .get("email")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        obj.insert("email".into(), Value::String(email.to_owned()));
    }
    if let Some(ws) = account
        .get("id_token")
        .and_then(|t| t.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        obj.insert("workspaceId".into(), Value::String(ws.to_owned()));
    }
}

fn codex_headers(account: &Value) -> Value {
    let mut header = json!({
        "Authorization": "Bearer $TOKEN$",
        "Content-Type": "application/json",
        "OpenAI-Beta": "codex-1",
        "Originator": "Codex Desktop",
    });
    if let Some(acc_id) = account
        .get("id_token")
        .and_then(|t| t.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        header["Chatgpt-Account-Id"] = Value::String(acc_id.to_owned());
    }
    header
}

fn codex_plan_label(plan_type: Option<&str>) -> String {
    match plan_type.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("plus") => "ChatGPT Plus".into(),
        Some("pro") => "ChatGPT Pro".into(),
        Some("team") => "ChatGPT Team".into(),
        Some("enterprise") => "ChatGPT Enterprise".into(),
        Some("edu") => "ChatGPT Edu".into(),
        Some("free") => "ChatGPT Free".into(),
        Some(other) if !other.is_empty() => format!("ChatGPT {other}"),
        _ => "ChatGPT".into(),
    }
}

fn codex_window_json(
    window: Option<&Value>,
    id: &str,
    kind: &str,
    label: &str,
    default_duration: u64,
) -> Option<Value> {
    let w = window?.as_object()?;
    let used = w.get("used_percent").and_then(Value::as_f64)?;
    let duration = w
        .get("limit_window_seconds")
        .and_then(Value::as_u64)
        .map(|s| s / 60)
        .unwrap_or(default_duration);
    let mut row = json!({
        "id": id,
        "kind": kind,
        "label": label,
        "windowDurationMins": duration,
        "usedPercent": used.clamp(0.0, 100.0),
    });
    if let Some(reset_ts) = w.get("reset_at").and_then(Value::as_i64) {
        if let Some(dt) = DateTime::from_timestamp(reset_ts, 0) {
            row["resetsAt"] = Value::String(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    Some(row)
}

async fn read_account(
    http: &reqwest::Client,
    hub_url: &str,
    management_key: &str,
    account: &Value,
    provider: &str,
) -> Value {
    let checked_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let id = account.get("id").and_then(Value::as_str).unwrap_or("");
    let auth_index = account
        .get("auth_index")
        .and_then(Value::as_str)
        .unwrap_or("");
    let driver = match provider {
        "codex" => "codex",
        "claude" => "claudeAgent",
        "xai" => "grok",
        "antigravity" => "antigravity",
        _ => provider,
    };

    let mut out = serde_json::Map::new();
    out.insert("id".into(), Value::String(id.to_owned()));
    out.insert("driver".into(), Value::String(driver.to_owned()));
    listed_identity(account, &mut out);

    let fallback_limits = || {
        json!({
            "checkedAt": checked_at,
            "windows": [],
            "unavailable": {
                "reason": "probeFailed",
                "message": "The hub could not read this account's usage.",
            }
        })
    };

    match provider {
        "codex" => {
            let headers = codex_headers(account);
            if let Ok(body) = api_call(
                http,
                hub_url,
                management_key,
                auth_index,
                "GET",
                &format!("{CODEX_BASE}/usage"),
                &headers,
                None,
            )
            .await
            {
                if let Ok(usage) = serde_json::from_str::<Value>(&body) {
                    let plan_type = usage
                        .get("plan_type")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            account
                                .get("id_token")
                                .and_then(|t| t.get("plan_type").or_else(|| t.get("chatgpt_plan_type")))
                                .and_then(Value::as_str)
                        });
                    out.insert("plan".into(), Value::String(codex_plan_label(plan_type)));
                    let mut windows = Vec::new();
                    if let Some(rate_limit) = usage.get("rate_limit") {
                        if let Some(w) = codex_window_json(
                            rate_limit.get("primary_window"),
                            "primary",
                            "session",
                            "Session",
                            300,
                        ) {
                            windows.push(w);
                        }
                        if let Some(w) = codex_window_json(
                            rate_limit.get("secondary_window"),
                            "secondary",
                            "weekly",
                            "Weekly",
                            10080,
                        ) {
                            windows.push(w);
                        }
                    }
                    let mut limits = json!({
                        "checkedAt": checked_at,
                        "windows": windows,
                    });
                    if let Ok(credits_body) = api_call(
                        http,
                        hub_url,
                        management_key,
                        auth_index,
                        "GET",
                        CREDIT_URL,
                        &headers,
                        None,
                    )
                    .await
                    {
                        if let Ok(parsed_credits) = serde_json::from_str::<Value>(&credits_body) {
                            let now_ms = Utc::now().timestamp_millis();
                            let mut available: Vec<(i64, String, String)> = parsed_credits
                                .get("credits")
                                .and_then(Value::as_array)
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|c| {
                                            if c.get("reset_type").and_then(Value::as_str)
                                                != Some("codex_rate_limits")
                                                || c.get("status").and_then(Value::as_str)
                                                    != Some("available")
                                            {
                                                return None;
                                            }
                                            let exp_str =
                                                c.get("expires_at").and_then(Value::as_str)?;
                                            let exp_dt =
                                                DateTime::parse_from_rfc3339(exp_str).ok()?;
                                            let exp_ms = exp_dt.timestamp_millis();
                                            if exp_ms <= now_ms {
                                                return None;
                                            }
                                            let cid = c.get("id").and_then(Value::as_str)?;
                                            Some((
                                                exp_ms,
                                                cid.to_owned(),
                                                exp_dt
                                                    .with_timezone(&Utc)
                                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                                            ))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            available.sort_by_key(|(exp_ms, _, _)| *exp_ms);
                            let mut rc = json!({ "availableCount": available.len() });
                            if let Some((_, next_id, next_exp)) = available.first() {
                                rc["nextCreditId"] = Value::String(next_id.clone());
                                rc["nextExpiresAt"] = Value::String(next_exp.clone());
                            }
                            limits["resetCredits"] = rc;
                        }
                    }
                    out.insert("usageLimits".into(), limits);
                    return Value::Object(out);
                }
            }
            out.insert("usageLimits".into(), fallback_limits());
        }
        "claude" => {
            let headers = json!({
                "Authorization": "Bearer $TOKEN$",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-code/2.1.273",
            });
            if let Ok(body) = api_call(
                http,
                hub_url,
                management_key,
                auth_index,
                "GET",
                "https://api.anthropic.com/api/oauth/usage",
                &headers,
                None,
            )
            .await
            {
                if let Ok(usage) = serde_json::from_str::<Value>(&body) {
                    let model_scoped: Vec<Value> = usage
                        .get("limits")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|limit| {
                                    if limit.get("kind").and_then(Value::as_str)
                                        != Some("weekly_scoped")
                                    {
                                        return None;
                                    }
                                    let display_name = limit
                                        .get("scope")
                                        .and_then(|s| s.get("model"))
                                        .and_then(|m| m.get("display_name"))
                                        .and_then(Value::as_str)?;
                                    let percent = limit.get("percent").and_then(Value::as_f64)?;
                                    Some(json!({
                                        "display_name": display_name,
                                        "utilization": percent,
                                        "resets_at": limit.get("resets_at").cloned().unwrap_or(Value::Null),
                                    }))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let synthetic = json!({
                        "rate_limits_available": true,
                        "rate_limits": {
                            "five_hour": usage.get("five_hour").cloned().unwrap_or(Value::Null),
                            "seven_day": usage.get("seven_day").cloned().unwrap_or(Value::Null),
                            "model_scoped": model_scoped,
                            "spend": usage.get("spend").cloned().unwrap_or(Value::Null),
                            "extra_usage": usage.get("extra_usage").cloned().unwrap_or(Value::Null),
                        }
                    });
                    out.insert("plan".into(), Value::String("Claude Subscription".into()));
                    out.insert(
                        "usageLimits".into(),
                        crate::provider::claude_capabilities::usage(&synthetic, &checked_at),
                    );
                    return Value::Object(out);
                }
            }
            out.insert("usageLimits".into(), fallback_limits());
        }
        "xai" => {
            let headers = json!({
                "Authorization": "Bearer $TOKEN$",
                "x-xai-token-auth": "xai-grok-cli",
                "x-grok-client-version": GROK_CLI_VERSION,
                "User-Agent": format!("grok-cli/{GROK_CLI_VERSION}"),
            });
            if let Ok(body) = api_call(
                http,
                hub_url,
                management_key,
                auth_index,
                "GET",
                GROK_USAGE_URL,
                &headers,
                None,
            )
            .await
            {
                if let Ok(usage) = serde_json::from_str::<Value>(&body) {
                    let windows = usage
                        .get("windows")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    out.insert(
                        "usageLimits".into(),
                        json!({ "checkedAt": checked_at, "windows": windows }),
                    );
                    return Value::Object(out);
                }
            }
            out.insert("usageLimits".into(), fallback_limits());
        }
        "antigravity" => {
            if let Some(project) = account
                .get("project_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let headers = json!({
                    "Authorization": "Bearer $TOKEN$",
                    "Content-Type": "application/json",
                    "User-Agent": format!("antigravity/{} {}", std::env::consts::OS, std::env::consts::ARCH),
                });
                if let Ok(body) = api_call(
                    http,
                    hub_url,
                    management_key,
                    auth_index,
                    "POST",
                    ANTIGRAVITY_SUMMARY_URL,
                    &headers,
                    Some(&json!({ "project": project })),
                )
                .await
                {
                    if let Ok(summary) = serde_json::from_str::<Value>(&body) {
                        let windows = summary
                            .get("windows")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        out.insert(
                            "usageLimits".into(),
                            json!({ "checkedAt": checked_at, "windows": windows }),
                        );
                        return Value::Object(out);
                    }
                }
            }
            out.insert("usageLimits".into(), fallback_limits());
        }
        _ => {
            out.insert("usageLimits".into(), fallback_limits());
        }
    }

    Value::Object(out)
}

fn credit_redeem_request_id(account_id: &str, credit_id: &str) -> String {
    let mut ctx = DigestContext::new(&SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(&CREDIT_REDEEM_NAMESPACE);
    ctx.update(format!("{account_id}:{credit_id}").as_bytes());
    let hash = ctx.finish();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash.as_ref()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        routing::{get, post},
        Json, Router,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn refused_usage_probe_keeps_only_the_same_identified_accounts_reading() {
        let good = json!({"checkedAt":"earlier","windows":[{"usedPercent":42}]});
        let refused = json!({"checkedAt":"later","windows":[],"unavailable":{"reason":"probeFailed"}});
        let mut account = json!({
            "id":"auth-file","driver":"claudeAgent","email":"user@example.com","usageLimits":good,
        });
        let previous = json!({"accounts":[account.clone()]});
        account["usageLimits"] = refused.clone();

        let mut same_login = json!({"accounts":[account.clone()]});
        keep_last_good_readings(&previous, &mut same_login);
        assert_eq!(same_login["accounts"][0]["usageLimits"], good);

        for email in [json!("replacement@example.com"), Value::Null] {
            account["email"] = email;
            let mut changed_login = json!({"accounts":[account.clone()]});
            keep_last_good_readings(&previous, &mut changed_login);
            assert_eq!(changed_login["accounts"][0]["usageLimits"], refused);
        }
    }

    fn temp_settings_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "t3code-uls-test-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[tokio::test]
    async fn refresh_polls_enabled_cliproxy_source_and_publishes_accounts() {
        let app = Router::new()
            .route(
                "/v0/management/auth-files",
                get(|| async {
                    Json(json!({
                        "files": [
                            {
                                "id": "acc-1",
                                "auth_index": "0",
                                "provider": "claude",
                                "email": "user@example.com",
                                "disabled": false
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/v0/management/api-call",
                post(|State(usage_body): State<String>| async move {
                    Json(json!({
                        "status_code": 200,
                        "body": usage_body
                    }))
                }),
            )
            .with_state(
                json!({
                    "five_hour": { "utilization": 42.0, "resets_at": "2030-01-01T00:00:00Z" },
                    "seven_day": { "utilization": 10.0, "resets_at": null }
                })
                .to_string(),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let settings_path = temp_settings_path();
        let settings = Arc::new(Settings::new(settings_path.clone()));
        settings
            .update(&json!({
                "usageLimitSources": {
                    "hub-1": {
                        "kind": "cliproxyapi",
                        "label": "Team Hub",
                        "url": format!("http://{addr}"),
                        "enabled": true,
                        "managementKey": "secret-key"
                    }
                }
            }))
            .unwrap();

        let sources = UsageLimitSources::new(settings);
        let mut rx = sources.subscribe();
        sources.refresh().await;
        rx.changed().await.unwrap();
        let current = sources.current();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["id"], "hub-1");
        assert_eq!(current[0]["label"], "Team Hub");
        assert!(current[0].get("error").is_none());
        let accounts = current[0]["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["driver"], "claudeAgent");
        assert_eq!(accounts[0]["email"], "user@example.com");
        assert_eq!(accounts[0]["usageLimits"]["windows"][0]["usedPercent"], 42.0);
        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }

    #[tokio::test]
    async fn refresh_reports_missing_management_key_without_http_call() {
        let settings_path = temp_settings_path();
        let settings = Arc::new(Settings::new(settings_path.clone()));
        settings
            .update(&json!({
                "usageLimitSources": {
                    "hub-empty": {
                        "kind": "cliproxyapi",
                        "url": "http://127.0.0.1:1",
                        "enabled": true,
                        "managementKey": ""
                    }
                }
            }))
            .unwrap();

        let sources = UsageLimitSources::new(settings);
        sources.refresh().await;
        let current = sources.current();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["error"], "No management key configured.");
        assert_eq!(current[0]["accounts"], json!([]));
        let _ = std::fs::remove_dir_all(settings_path.parent().unwrap());
    }
}
