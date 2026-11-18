//! Codex readiness and model discovery for the client configuration.
use super::{CodexClient, CodexLaunch, ProviderClient, ProviderError};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn model(row: &Value) -> Option<Value> {
    let slug = row.get("model")?.as_str()?;
    let mut descriptors = Vec::new();
    if let Some(efforts) = row
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty())
    {
        let default = if slug.starts_with("gpt-6-astra") {
            Some("medium")
        } else {
            row.get("defaultReasoningEffort").and_then(Value::as_str)
        };
        let options: Vec<Value> = efforts
            .iter()
            .filter_map(|e| {
                let id = e
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .or_else(|| e.as_str())?;
                let label = match id {
                    "none" => "None",
                    "minimal" => "Minimal",
                    "low" => "Low",
                    "medium" => "Medium",
                    "high" => "High",
                    "xhigh" => "Extra High",
                    "max" => "Max",
                    "ultra" => "Ultra",
                    _ => id,
                };
                let mut option = json!({"id":id,"label":label});
                if Some(id) == default {
                    option["isDefault"] = json!(true);
                }
                Some(option)
            })
            .collect();
        let mut descriptor =
            json!({"id":"reasoningEffort","label":"Reasoning","type":"select","options":options});
        if let Some(default) = default {
            descriptor["currentValue"] = json!(default);
        }
        descriptors.push(descriptor);
    }
    if let Some(tiers) = row
        .get("serviceTiers")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        let default = row
            .get("defaultServiceTier")
            .and_then(Value::as_str)
            .unwrap_or("default");
        let mut options = vec![json!({"id":"default","label":"Standard"})];
        for tier in tiers {
            if let Some(id) = tier.get("id").and_then(Value::as_str) {
                let mut option =
                    json!({"id":id,"label":tier.get("name").and_then(Value::as_str).unwrap_or(id)});
                if id == "ultrafast" {
                    option["description"] = json!("Even faster, more expensive");
                } else if let Some(description) = tier.get("description") {
                    option["description"] = description.clone();
                }
                options.push(option);
            }
        }
        for option in &mut options {
            if option["id"] == default {
                option["isDefault"] = json!(true);
            }
        }
        descriptors.push(json!({"id":"serviceTier","label":"Service Tier","type":"select","options":options,"currentValue":default}));
    }
    if let Some(programs) = row
        .pointer("/availableAccessPrograms/cyber")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        let mut ids: Vec<&str> = programs.iter().filter_map(Value::as_str).collect();
        if !ids.contains(&"standard") {
            ids.insert(0, "standard");
        }
        let options: Vec<Value> = ids
            .into_iter()
            .map(|id| {
                let label = match id {
                    "standard" => "Standard",
                    "daybreakBlue" => "Daybreak Blue",
                    "daybreakRed" => "Daybreak Red",
                    _ => id,
                };
                let mut option = json!({"id":id,"label":label});
                if id == "standard" {
                    option["isDefault"] = json!(true);
                }
                option
            })
            .collect();
        descriptors.push(json!({"id":"cyberAccessProgram","label":"Cyber Access","type":"select","options":options,"currentValue":"standard"}));
    }
    let mut result = json!({"slug":slug,"name":row.get("displayName").and_then(Value::as_str).unwrap_or(slug),"isCustom":false,"capabilities":{"optionDescriptors":descriptors}});
    if row.get("isDefault") == Some(&json!(true)) {
        result["isDefault"] = json!(true);
    }
    Some(result)
}

type DiscoverySnapshot = (Value, Vec<Value>, Vec<Value>, Option<String>, Option<Value>);
fn codex_usage(response: &Value, checked_at: &str) -> Option<Value> {
    use chrono::TimeZone;
    let limits = response.pointer("/rateLimitsByLimitId/codex").filter(|v| v.is_object()).or_else(|| response.get("rateLimits").filter(|v| v.is_object()))?;
    if limits["limitId"].as_str().is_some_and(|id| id != "codex" && !id.is_empty()) { return Some(json!({"checkedAt":checked_at,"windows":[]})); }
    let monthly = matches!(limits["planType"].as_str(), Some("free"|"go"));
    let mut windows = Vec::new();
    let date = |v: &Value| v.as_f64().filter(|n| n.is_finite() && *n > 0.0).and_then(|seconds| chrono::Utc.timestamp_millis_opt((seconds * 1000.0) as i64).single()).map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis,true));
    for (id, duration) in [("primary",if monthly {43200} else {300}), ("secondary",10080)] {
        let window = &limits[id]; let Some(percent) = window["usedPercent"].as_f64().filter(|v| v.is_finite()) else { continue };
        let duration = window["windowDurationMins"].as_i64().unwrap_or(duration);
        let (kind,label) = if duration >= 43200 {("monthly","Monthly")} else if duration >= 10080 {("weekly","Weekly")} else {("session","Session")};
        let mut row = json!({"id":id,"kind":kind,"label":label,"usedPercent":percent.clamp(0.0,100.0),"windowDurationMins":duration});
        if let Some(reset) = date(&window["resetsAt"]) { row["resetsAt"] = json!(reset); }
        windows.push(row);
    }
    let individual = &limits["individualLimit"];
    if let Some(remaining) = individual["remainingPercent"].as_f64().filter(|v| v.is_finite()) {
        let mut row = json!({"id":"individual","kind":"monthly","label":"Monthly credit limit","usedPercent":(100.0-remaining).clamp(0.0,100.0)});
        if let Some(reset) = date(&individual["resetsAt"]) { row["resetsAt"] = json!(reset); }
        windows.push(row);
    }
    let mut result = json!({"checkedAt":checked_at,"windows":windows});
    if let Some(summary) = response.get("rateLimitResetCredits").filter(|v| v.is_object()) {
        if let Some(available) = summary["availableCount"].as_i64() {
            let mut credits = json!({"availableCount":available.max(0)});
            let earliest = summary["credits"].as_array().into_iter().flatten().filter(|credit| credit["status"] == "available").filter_map(|credit| credit["expiresAt"].as_f64()).filter(|v| v.is_finite()).min_by(|a,b| a.total_cmp(b));
            if let Some(expires) = earliest.and_then(|n| date(&json!(n))) { credits["nextExpiresAt"] = json!(expires); }
            result["resetCredits"] = credits;
        }
    }
    Some(result)
}
fn snapshot(cwd: &Path, launch: CodexLaunch) -> Result<DiscoverySnapshot, ProviderError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let mut client = CodexClient::spawn(launch)?;
    let init = client.initialize(
        env!("CARGO_PKG_VERSION"),
        json!({"experimentalApi":true}),
        remaining(),
    )?;
    let version = init
        .get("userAgent")
        .and_then(Value::as_str)
        .and_then(|s| s.split_once('/'))
        .map(|(_, v)| v.split_whitespace().next().unwrap_or(v).to_owned());
    let account = client.request("account/read", Some(json!({})), remaining())?;
    if account.get("account").is_none_or(Value::is_null) && account["requiresOpenaiAuth"] == true {
        return Ok((account, vec![], vec![], version, None));
    }
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let args = cursor
            .as_ref()
            .map_or_else(|| json!({}), |c| json!({"cursor":c}));
        let response = client.request("model/list", Some(args), remaining())?;
        if let Some(data) = response.get("data").and_then(Value::as_array) {
            rows.extend(data.iter().filter_map(model));
        }
        let next = response
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if next.is_none() || next == cursor {
            break;
        }
        cursor = next;
    }
    for family in [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ] {
        if let Some(index) = rows.iter().position(|m| {
            m["slug"].as_str().is_some_and(|s| {
                let s = s.strip_prefix("openai.").unwrap_or(s);
                s == family || s.starts_with(&format!("{family}-"))
            })
        }) {
            for row in &mut rows {
                row.as_object_mut().unwrap().remove("isDefault");
            }
            rows[index]["isDefault"] = json!(true);
            break;
        }
    }
    let skills = client.request("skills/list", Some(json!({"cwds":[cwd.to_string_lossy()]})), remaining()).ok().and_then(|v| v.get("data").and_then(Value::as_array).cloned()).unwrap_or_default().into_iter().flat_map(|entry| entry.get("skills").and_then(Value::as_array).cloned().unwrap_or_default()).filter_map(|s| {
        let mut v = json!({"name":s.get("name")?,"path":s.get("path")?,"enabled":s.get("enabled").unwrap_or(&json!(true))});
        for key in ["description","scope","shortDescription"] { if let Some(value) = s.get(key) { v[key]=value.clone(); } }
        if let Some(value)=s.pointer("/interface/displayName") { v["displayName"]=value.clone(); }
        Some(v)
    }).collect();
    let usage = if remaining().is_zero() { None } else {
        client.request("account/rateLimits/read", None, remaining().min(Duration::from_secs(1))).ok()
            .and_then(|response| codex_usage(&response, &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)))
    };
    Ok((account, rows, skills, version, usage))
}

/// A best-effort probe; failures are represented in the wire snapshot.
pub fn discover(cwd: &Path) -> Value {
    discover_instance(cwd, "codex", &json!({"driver":"codex"}), None, None)
}

pub(crate) fn discover_instance(
    cwd: &Path,
    id: &str,
    entry: &Value,
    settings_path: Option<&Path>,
    secrets: Option<&super::secret_store::SecretStore>,
) -> Value {
    if entry["driver"] == "claudeAgent" {
        return super::claude_discovery::discover(cwd, id, entry, settings_path, secrets);
    }
    let checked = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut provider = json!({"instanceId":"codex","driver":"codex","displayName":"Codex","showInteractionModeToggle":true,"reportsContextWindow":true,"enabled":true,"installed":false,"version":null,"status":"error","auth":{"status":"unknown"},"checkedAt":checked,"models":[],"skills":[],"slashCommands":[{"name":"compact","description":"Summarize the conversation and reduce context usage"},{"name":"goal","description":"Set a goal Codex keeps working toward until it is done","input":{"hint":"Objective, or pause, resume, clear"}},{"name":"feedback","description":"Send this thread and Codex logs to OpenAI","input":{"hint":"Describe the issue (optional)"}}]});
    provider["instanceId"] = json!(id);
    if let Some(name) = entry["displayName"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        provider["displayName"] = json!(name.trim());
    }
    if let Some(color) = entry.get("accentColor") {
        provider["accentColor"] = color.clone();
    }
    if entry["enabled"] == false || entry["config"]["enabled"] == false {
        provider["enabled"] = json!(false);
        provider["status"] = json!("disabled");
        return provider;
    }
    if entry["driver"] != "codex" {
        provider["driver"] = entry["driver"].clone();
        provider["enabled"] = json!(false);
        provider["availability"] = json!("unavailable");
        provider["unavailableReason"] = json!("Provider driver is not supported.");
        provider["message"] = provider["unavailableReason"].clone();
        return provider;
    }
    if let Err(error) = crate::managed_policy::check_provider_allowed("codex") {
        provider["availability"] = json!("unavailable");
        provider["unavailableReason"] = json!(error);
        provider["message"] = provider["unavailableReason"].clone();
        return provider;
    }
    let launch = CodexLaunch {
        cwd: Some(cwd.to_owned()),
        ..Default::default()
    };
    let launch = match super::instance::resolve_codex_launch_with_secrets(
        settings_path,
        id,
        launch,
        secrets,
    ) {
        Ok(launch) => launch,
        Err(error) => {
            provider["message"] = json!(error);
            return provider;
        }
    };
    let binary = launch
        .binary
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "codex".to_owned());
    match snapshot(cwd, launch) {
        Ok((account, models, skills, version, usage)) => {
            provider["installed"] = json!(true);
            provider["version"] = json!(version);
            provider["models"] = json!(models);
            provider["skills"] = json!(skills);
            if let Some(usage) = usage { provider["usageLimits"] = usage; }
            if let Some(a) = account.get("account").filter(|a| !a.is_null()) {
                provider["status"] = json!("ready");
                provider["auth"] = json!({"status":"authenticated"});
                if let Some(kind) = a.get("type") {
                    provider["auth"]["type"] = kind.clone();
                }
                if let Some(email) = a.get("email") {
                    provider["auth"]["email"] = email.clone();
                }
            } else if account["requiresOpenaiAuth"] == true {
                provider["auth"]["status"] = json!("unauthenticated");
                provider["message"] =
                    json!("Codex CLI is not authenticated. Run `codex login` and try again.");
            } else {
                provider["status"] = json!("ready");
            }
        }
        Err(ProviderError::Io(_)) => {
            let hint = if binary == "codex" {
                "Installing ChatGPT or Codex desktop may not add codex to PATH."
            } else {
                "Make sure the configured executable exists and can be run."
            };
            provider["message"] = json!(format!("Could not start Codex CLI (`{binary}`). Check Settings → Providers → Codex → Binary path on the server. {hint}"));
        }
        Err(ProviderError::Timeout) => {
            provider["installed"] = json!(true);
            provider["message"] =
                json!("Timed out while checking Codex app-server provider status.");
        }
        Err(error) => {
            provider["installed"] = json!(true);
            provider["message"] =
                json!(format!("Codex app-server provider probe failed: {error}."));
        }
    }
    provider
}

/// Discover every configured instance, probing each with its own credentials and home.
/// The default Codex instance is present even when it has no explicit settings.
pub fn discover_all(cwd: &Path, settings_path: Option<&Path>) -> Vec<Value> {
    discover_all_with_secrets(cwd, settings_path, None)
}

pub fn discover_all_with_secrets(
    cwd: &Path,
    settings_path: Option<&Path>,
    secrets: Option<&super::secret_store::SecretStore>,
) -> Vec<Value> {
    let settings = match super::session_registry::read_provider_settings(settings_path) {
        Ok(settings) => settings,
        Err(error) => {
            return vec![
                json!({"instanceId":"codex","driver":"codex","displayName":"Codex","enabled":false,"installed":false,"status":"error","availability":"unavailable","unavailableReason":error,"message":error}),
            ]
        }
    };
    let mut entries = settings
        .get("providerInstances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    entries
        .entry("codex".to_owned())
        .or_insert_with(|| json!({"driver":"codex"}));
    entries
        .entry("claudeAgent".to_owned())
        .or_insert_with(|| json!({"driver":"claudeAgent"}));
    entries
        .iter()
        .map(|(id, entry)| discover_instance(cwd, id, entry, settings_path, secrets))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_usage_matches_original_windows_and_resets() {
        let response = json!({"rateLimits":{"limitId":"codex","planType":"pro","primary":{"usedPercent":120,"windowDurationMins":300,"resetsAt":2000000000},"secondary":{"usedPercent":25},"individualLimit":{"remainingPercent":20,"resetsAt":2000000001}}});
        assert_eq!(codex_usage(&response,"2026-01-01T00:00:00.000Z"), Some(json!({"checkedAt":"2026-01-01T00:00:00.000Z","windows":[{"id":"primary","kind":"session","label":"Session","usedPercent":100.0,"windowDurationMins":300,"resetsAt":"2033-05-18T03:33:20.000Z"},{"id":"secondary","kind":"weekly","label":"Weekly","usedPercent":25.0,"windowDurationMins":10080},{"id":"individual","kind":"monthly","label":"Monthly credit limit","usedPercent":80.0,"resetsAt":"2033-05-18T03:33:21.000Z"}]})));
        let credits = json!({"rateLimits":{"limitId":"codex"},"rateLimitResetCredits":{"availableCount":-2,"credits":[{"status":"available","expiresAt":2000000100},{"status":"used","expiresAt":1900000000},{"status":"available","expiresAt":2000000000}]}});
        assert_eq!(codex_usage(&credits,"t").unwrap()["resetCredits"],json!({"availableCount":0,"nextExpiresAt":"2033-05-18T03:33:20.000Z"}));
    }
    #[test]
    fn invalid_settings_prevent_provider_probe() {
        let path =
            std::env::temp_dir().join(format!("t3-discovery-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "{").unwrap();
        let providers = discover_all(Path::new("/"), Some(&path));
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["availability"], "unavailable");
        assert_eq!(providers[0]["installed"], false);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn maps_service_tiers_and_cyber_access() {
        let mapped = model(&json!({"model":"test","defaultServiceTier":"flex","serviceTiers":[{"id":"flex","name":"Flex","description":"Lower cost"}],"availableAccessPrograms":{"cyber":["daybreakBlue"]}})).unwrap();
        let descriptors = &mapped["capabilities"]["optionDescriptors"];
        assert_eq!(descriptors[0]["currentValue"], "flex");
        assert_eq!(descriptors[0]["options"][1]["isDefault"], true);
        assert_eq!(descriptors[1]["options"][0]["id"], "standard");
        assert_eq!(descriptors[1]["options"][1]["label"], "Daybreak Blue");
    }

    #[test]
    fn lists_disabled_and_unsupported_instances_without_starting_them() {
        let path = std::env::temp_dir().join(format!("t3-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{"providerInstances":{"codex":{"driver":"codex","enabled":false},"claudeAgent":{"driver":"claudeAgent","enabled":false},"work":{"driver":"codex","enabled":false,"displayName":" Work "},"other":{"driver":"other"}}}"#).unwrap();
        let providers = discover_all(Path::new("/"), Some(&path));
        let work = providers
            .iter()
            .find(|p| p["instanceId"] == "work")
            .unwrap();
        assert_eq!(work["displayName"], "Work");
        assert_eq!(work["status"], "disabled");
        let other = providers
            .iter()
            .find(|p| p["instanceId"] == "other")
            .unwrap();
        assert_eq!(other["availability"], "unavailable");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn discovery_uses_resolved_secret_cache() {
        let dir =
            std::env::temp_dir().join(format!("t3-discovery-secret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, json!({"providerInstances":{"claudeAgent":{"driver":"claudeAgent","enabled":false},"codex":{"driver":"codex", "config":{"binaryPath":"/missing-t3-codex"},"environment":[{"name":"TOKEN","secret":{"provider":"vault","reference":"op://v/i/f"}}]}}}).to_string()).unwrap();
        let store = super::super::secret_store::SecretStore::default();
        let first = discover_all_with_secrets(Path::new("/"), Some(&path), Some(&store));
        let codex = first.iter().find(|p| p["instanceId"] == "codex").unwrap();
        assert!(codex["message"].as_str().unwrap().contains("unresolved"));
        store
            .apply("vault", "op://v/i/f", "private".into())
            .unwrap();
        let second = discover_all_with_secrets(Path::new("/"), Some(&path), Some(&store));
        let codex = second.iter().find(|p| p["instanceId"] == "codex").unwrap();
        assert!(codex["message"]
            .as_str()
            .unwrap()
            .contains("Could not start"));
        assert!(!second[0].to_string().contains("private"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn maps_reasoning_catalog_and_preferred_default_effort() {
        let mapped = model(&json!({"model":"gpt-6-astra","displayName":"Astra","isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}]})).unwrap();
        assert_eq!(mapped["slug"], "gpt-6-astra");
        assert_eq!(
            mapped["capabilities"]["optionDescriptors"][0]["currentValue"],
            "medium"
        );
        assert_eq!(
            mapped["capabilities"]["optionDescriptors"][0]["options"][0]["isDefault"],
            true
        );
        assert!(model(&json!({})).is_none());
    }
}
