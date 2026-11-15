//! Claude CLI model options from the pinned bundled model manifest.
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub model: String,
    pub effort: Option<String>,
    pub thinking: Option<bool>,
    pub fast_mode: bool,
    pub ultracode: Option<bool>,
}
fn option<'a>(selection: &'a Value, id: &str) -> Option<&'a Value> {
    selection["options"].as_array()?.iter().find(|v| v["id"] == id).map(|v| &v["value"])
}
fn select_value(descriptor: &Value, raw: Option<&str>) -> Option<String> {
    let default = descriptor["currentValue"].as_str().or_else(|| descriptor["options"].as_array()?.iter().find(|v| v["isDefault"] == true)?.get("id")?.as_str());
    let raw = raw.map(str::trim).filter(|v| !v.is_empty());
    let injected = raw.is_some_and(|raw| descriptor["promptInjectedValues"].as_array().is_some_and(|a| a.iter().any(|v| v == raw)));
    let valid = raw.filter(|raw| descriptor["options"].as_array().is_some_and(|a| a.is_empty() || a.iter().any(|v| v["id"] == *raw)));
    (if injected { default } else { valid.or(default) }).map(str::to_owned)
}
pub(crate) fn resolve(selection: &Value, custom: &Value) -> Resolved {
    static MODELS: OnceLock<Value> = OnceLock::new();
    let models = MODELS.get_or_init(|| serde_json::from_str(include_str!("review_guide_claude_catalog.json")).expect("bundled Claude catalog"));
    let requested = selection["model"].as_str().unwrap_or("");
    let trimmed = requested.trim();
    let custom_entries = custom.as_array().into_iter().flatten().filter_map(|item| {
        let slug = item.as_str().or_else(|| item["slug"].as_str())?.trim();
        (!slug.is_empty()).then_some((slug, item))
    }).collect::<Vec<_>>();
    let alias_shadowed = custom_entries.iter().any(|(slug, _)| slug.eq_ignore_ascii_case(trimmed));
    let bundled = models.as_array().unwrap().iter().find(|entry| entry["slug"].as_str() == Some(trimmed)).or_else(|| (!alias_shadowed).then(|| models.as_array().unwrap().iter().find(|entry| entry["aliases"].as_array().is_some_and(|aliases| aliases.iter().any(|a| a.as_str().is_some_and(|a| a.eq_ignore_ascii_case(trimmed)))))).flatten());
    let custom_model = custom_entries.iter().find(|(slug, v)| *slug == trimmed && v["capabilities"].is_object()).map(|(_, v)| *v);
    let model = bundled.and_then(|v| v["slug"].as_str()).unwrap_or(requested);
    let descriptors = bundled.map(|v| &v["descriptors"]).or_else(|| custom_model.map(|v| &v["capabilities"]["optionDescriptors"]));
    let desc = |id: &str| descriptors.and_then(Value::as_array).and_then(|v| v.iter().find(|d| d["id"] == id));
    let has_legacy_ultracode = desc("effort").and_then(|v| v["options"].as_array()).is_some_and(|v| v.iter().any(|v| v["id"] == "ultracode"));
    let raw_effort = option(selection,"effort").and_then(Value::as_str);
    let raw_effort = if has_legacy_ultracode && raw_effort == Some("ultracode") { Some("xhigh") } else { raw_effort };
    let mut effort = if bundled.is_none() && custom_model.is_none() {
        raw_effort.map(str::trim).filter(|v| ["low","medium","high","xhigh","max"].contains(v)).map(str::to_owned)
    } else { desc("effort").and_then(|d| select_value(d, raw_effort)) };
    if let (Some(e), Some(entry)) = (&effort, bundled) {
        if let Some(mapped) = entry["runtime"]["effortMap"].get(e.as_str()) { effort = mapped.as_str().map(str::to_owned); }
    }
    let context = desc("contextWindow").and_then(|d| select_value(d, option(selection,"contextWindow").and_then(Value::as_str)));
    let suffix = bundled.and_then(|v| context.as_deref().and_then(|context| v["runtime"]["modelSuffixes"]["contextWindow"].get(context))).and_then(Value::as_str).unwrap_or("");
    let thinking = desc("thinking").filter(|d| d["type"] == "boolean").and_then(|_| option(selection,"thinking").and_then(Value::as_bool));
    let fast_mode = desc("fastMode").filter(|d| d["type"] == "boolean").and_then(|d| option(selection,"fastMode").and_then(Value::as_bool).or_else(|| d["currentValue"].as_bool())).unwrap_or(false);
    let ultracode = if has_legacy_ultracode { option(selection,"ultracode").and_then(Value::as_bool).or_else(|| (option(selection,"effort").and_then(Value::as_str) == Some("ultracode")).then_some(true)) } else { None };
    Resolved { model: format!("{model}{suffix}"), effort, thinking, fast_mode, ultracode }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn matches_original_bundled_alias_effort_and_context_cases() {
        for (selection, model, effort) in [
            (json!({"model":"opus-4.6"}), "claude-opus-4-6[1m]", Some("high")),
            (json!({"model":"sonnet-4.6","options":[{"id":"effort","value":"max"},{"id":"contextWindow","value":"1m"}]}), "claude-sonnet-4-6[1m]", Some("high")),
            (json!({"model":"haiku"}), "claude-haiku-5-5", Some("medium")),
            (json!({"model":"custom","options":[{"id":"effort","value":"xhigh"}]}), "custom", Some("xhigh")),
            (json!({"model":"opus-4.7","options":[{"id":"effort","value":"xhigh"}]}), "claude-opus-4-7", Some("max")),
        ] {
            let resolved = resolve(&selection, &Value::Null);
            assert_eq!(resolved.model, model);
            assert_eq!(resolved.effort.as_deref(), effort);
        }
    }
    #[test]
    fn custom_alias_shadows_builtin_and_legacy_ultracode_is_translated() {
        let custom = json!([{"slug":"opus","capabilities":{"optionDescriptors":[]}}]);
        assert_eq!(resolve(&json!({"model":"opus"}), &custom).model, "opus");
        let resolved = resolve(&json!({"model":"opus","options":[{"id":"effort","value":"ultracode"}]}), &Value::Null);
        assert_eq!(resolved.model, "claude-opus-5-5");
        assert_eq!(resolved.effort.as_deref(), Some("xhigh"));
        assert_eq!(resolved.ultracode, Some(true));
    }
}
