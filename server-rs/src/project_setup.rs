//! Resolve the project setup action using the same precedence as the client.
use serde_json::Value;

/// The first action marked for worktree creation, after applying project settings.
pub fn setup_script<'a>(
    settings: &'a Value,
    project_id: &str,
    scripts: &'a Value,
) -> Option<&'a Value> {
    let defaults = settings.get("defaultProjectScripts");
    let explicit = settings
        .get("projectSettingsOverrides")
        .and_then(|v| v.get(project_id))
        .and_then(|v| v.get("defaultProjectScripts"));
    let legacy = settings
        .get("projectScriptOverrides")
        .and_then(|v| v.get(project_id));
    let selected = if let Some(value) = explicit {
        Some(value)
    } else if settings
        .get("projectSettingsFolded")
        .and_then(Value::as_bool)
        == Some(true)
    {
        defaults
    } else if let Some(value) = legacy {
        if value.is_null() {
            defaults
        } else {
            Some(value)
        }
    } else if scripts.as_array().is_some_and(|v| !v.is_empty()) {
        Some(scripts)
    } else {
        defaults
    };
    selected
        .and_then(Value::as_array)?
        .iter()
        .find(|v| v.get("runOnWorktreeCreate") == Some(&Value::Bool(true)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn respects_project_overrides_folded_defaults_and_legacy_scripts() {
        let project = json!([{ "id":"project", "runOnWorktreeCreate":true }]);
        let mut settings = json!({"defaultProjectScripts":[{"id":"default","runOnWorktreeCreate":true}],"projectSettingsOverrides":{},"projectScriptOverrides":{}});
        assert_eq!(
            setup_script(&settings, "p", &project).unwrap()["id"],
            "project"
        );
        settings["projectScriptOverrides"]["p"] = Value::Null;
        assert_eq!(
            setup_script(&settings, "p", &project).unwrap()["id"],
            "default"
        );
        settings["projectSettingsOverrides"]["p"] = json!({"defaultProjectScripts":[]});
        assert!(setup_script(&settings, "p", &project).is_none());
        settings["projectSettingsOverrides"] = json!({});
        settings["projectSettingsFolded"] = json!(true);
        assert_eq!(
            setup_script(&settings, "p", &project).unwrap()["id"],
            "default"
        );
    }
}
