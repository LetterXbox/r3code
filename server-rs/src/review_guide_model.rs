//! Review-guide model selection and runtime provider fallback.
use serde_json::{json, Value};

#[derive(Debug, PartialEq)]
pub(crate) struct SelectionPlan { pub recorded: Value, pub execution: Value }

fn exhausted(provider: &Value, model: &str, now_ms: i64) -> bool {
    let windows = provider["usageLimits"]["windows"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let has_plan = windows.iter().any(|w| w["id"] == "primary" || w["id"] == "secondary");
    windows.iter().any(|w| {
        if w["usedPercent"].as_f64().unwrap_or(0.0) < 100.0 { return false; }
        if w.get("modelIds").and_then(Value::as_array).is_some_and(|ids| !ids.iter().any(|id| id == model)) { return false; }
        if w.get("providerIds").and_then(Value::as_array).is_some_and(|ids| !ids.iter().any(|id| id == model.split('/').next().unwrap_or(""))) { return false; }
        if w["resetsAt"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|date| date.timestamp_millis() <= now_ms) { return false; }
        !(provider["driver"] == "codex" && w["id"] == "individual" && has_plan)
    })
}

pub(crate) fn plan(settings: &Value, project: &str, snapshots: Option<&[Value]>, now_ms: i64) -> Option<SelectionPlan> {
    let overrides = &settings["projectSettingsOverrides"][project];
    let effective = |key: &str| overrides.get(key).unwrap_or(&settings[key]);
    let snapshot = |id: &str| snapshots.and_then(|items| items.iter().find(|item| item["instanceId"] == id));
    let is_generator = |id: &str| settings["textGenerators"].get(id).is_some();
    let driver = |id: &str| settings["providerInstances"][id]["driver"].as_str().unwrap_or(id).to_owned();
    let enabled = |id: &str| {
        let config = &settings["providerInstances"][id];
        let global = if config["enabled"] == false || config["config"]["enabled"] == false { false } else { config["enabled"].as_bool().or_else(|| config["config"]["enabled"].as_bool()).unwrap_or(matches!(id,"codex" | "claudeAgent") || config.is_object()) };
        overrides["providerInstances"][id]["enabled"].as_bool().unwrap_or(global)
    };
    let target_usable = |id: &str| {
        if is_generator(id) { return settings["textGenerators"][id]["enabled"] != false; }
        match snapshot(id) {
            Some(p) if p["unavailableReason"] == "Provider driver is not supported." && driver(id) == "claudeAgent" => true,
            Some(p) => p["enabled"] != false && p["availability"] != "unavailable" && p["supportsTextGeneration"] != false,
            None => snapshots.is_none(),
        }
    };
    let valid = |value: &Value| value["instanceId"].as_str().is_some_and(|id| !id.is_empty()) && value["model"].as_str().is_some_and(|m| !m.trim().is_empty());
    let review = effective("reviewGuideModelSelection"); let writer = effective("sourceControlWriterModelSelection");
    let recorded = if valid(review) && review["instanceId"].as_str().is_some_and(|id| !is_generator(id) && enabled(id) && target_usable(id)) { review }
        else if valid(writer) && writer["instanceId"].as_str().is_some_and(|id| (if is_generator(id) { settings["textGenerators"][id]["enabled"] != false } else { enabled(id) }) && target_usable(id)) { writer }
        else { &settings["textGenerationModelSelection"] };
    if !valid(recorded) { return None; }
    let selected_id = recorded["instanceId"].as_str()?; let selected_model = recorded["model"].as_str()?;
    let selected = snapshot(selected_id);
    let unusable = is_generator(selected_id) || selected.is_some_and(|p| {
        p["enabled"] == true && (p["supportsTextGeneration"] == false || p["models"].as_array().into_iter().flatten().any(|m| m["slug"] == selected_model && m["supportsTextGeneration"] == false) || (p["status"] == "error" && (p["installed"] != true || p["auth"]["status"] == "unauthenticated")))
    }) || selected.is_some_and(|p| exhausted(p, selected_model, now_ms));
    let mut execution = recorded.clone();
    if unusable {
        let mut candidates = vec![("codex".to_owned(), "codex".to_owned()), ("claudeAgent".to_owned(), "claudeAgent".to_owned())];
        for (id, config) in settings["providerInstances"].as_object().into_iter().flatten() {
            if let Some(driver) = config["driver"].as_str().filter(|driver| matches!(*driver,"codex" | "claudeAgent")) { candidates.push((id.clone(), driver.to_owned())); }
        }
        for (id, candidate_driver) in candidates {
            let Some(p) = snapshot(&id) else { continue }; if id == selected_id || !enabled(&id) || p["enabled"] != true || p["installed"] != true || p["auth"]["status"] == "unauthenticated" || p["status"] == "error" || p["availability"] == "unavailable" || p["supportsTextGeneration"] == false { continue; }
            let default = &settings["defaultModelSelection"];
            let custom = settings["providerInstances"][&id]["config"]["customModels"].as_array().into_iter().flatten().any(|entry| entry.as_str().or_else(|| entry["slug"].as_str()) == default["model"].as_str());
            let models = [if default["instanceId"] == id && custom { Some(default.clone()) } else { None }, Some(json!({"instanceId":id,"model":if candidate_driver == "codex" {"gpt-6-luna"} else {"claude-haiku-5-5"}}))];
            if let Some(model) = models.into_iter().flatten().find(|m| !exhausted(p,m["model"].as_str().unwrap_or(""),now_ms)) { execution = model; break; }
        }
    }
    if is_generator(execution["instanceId"].as_str()?) || !matches!(driver(execution["instanceId"].as_str()?).as_str(), "codex" | "claudeAgent") { return None; }
    Some(SelectionPlan { recorded: recorded.clone(), execution })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready(id: &str, driver: &str) -> Value { json!({"instanceId":id,"driver":driver,"enabled":true,"installed":true,"status":"ready","auth":{"status":"authenticated"}}) }
    #[test]
    fn runtime_fallback_preserves_recorded_selection() {
        let settings = json!({"reviewGuideModelSelection":{"instanceId":"codex","model":"gpt-5.4"},"textGenerationModelSelection":{"instanceId":"codex","model":"gpt-6-luna"},"providerInstances":{}});
        let mut codex=ready("codex","codex"); codex["usageLimits"] = json!({"windows":[{"id":"primary","usedPercent":100,"resetsAt":"2999-01-01T00:00:00Z"}]});
        let plan=plan(&settings,"p",Some(&[codex,ready("claudeAgent","claudeAgent")]),0).unwrap();
        assert_eq!(plan.recorded, settings["reviewGuideModelSelection"]);
        assert_eq!(plan.execution, json!({"instanceId":"claudeAgent","model":"claude-haiku-5-5"}));
    }
    #[test]
    fn expired_model_scoped_and_codex_individual_windows_do_not_force_fallback() {
        let mut p=ready("codex","codex");
        p["usageLimits"] = json!({"windows":[{"id":"primary","usedPercent":10},{"id":"individual","usedPercent":100},{"id":"model","usedPercent":100,"modelIds":["other"]},{"id":"expired","usedPercent":100,"resetsAt":"2000-01-01T00:00:00Z"}]});
        assert!(!exhausted(&p,"gpt",chrono::Utc::now().timestamp_millis()));
        p["usageLimits"]["windows"][3]["resetsAt"] = json!("invalid"); assert!(exhausted(&p,"gpt",chrono::Utc::now().timestamp_millis()));
    }
    #[test]
    fn selected_warning_snapshot_remains_selected_and_project_null_clears_override() {
        let settings=json!({"reviewGuideModelSelection":{"instanceId":"claudeAgent","model":"opus"},"sourceControlWriterModelSelection":{"instanceId":"codex","model":"writer"},"textGenerationModelSelection":{"instanceId":"codex","model":"default"},"projectSettingsOverrides":{"p":{"reviewGuideModelSelection":null}}});
        let mut codex=ready("codex","codex"); codex["status"]=json!("warning"); codex["installed"]=json!(false);
        let plan=plan(&settings,"p",Some(&[codex,ready("claudeAgent","claudeAgent")]),0).unwrap();
        assert_eq!(plan.recorded["model"],"writer"); assert_eq!(plan.execution["model"],"writer");
    }
    #[test]
    fn fallback_uses_custom_thread_default_if_available() {
        let settings=json!({"textGenerationModelSelection":{"instanceId":"missing","model":"x"},"sourceControlWriterModelSelection":{"instanceId":"api","model":"x"},"textGenerators":{"api":{"enabled":true}},"defaultModelSelection":{"instanceId":"codex","model":"custom"},"providerInstances":{"codex":{"driver":"codex","config":{"customModels":["custom"]}}}});
        let plan=plan(&settings,"p",Some(&[ready("codex","codex")]),0).unwrap();
        assert_eq!(plan.recorded["instanceId"],"api"); assert_eq!(plan.execution["model"],"custom");
    }
}
