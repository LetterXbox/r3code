//! Build the agent-facing provider and model catalog from live discovery.
use serde_json::{json, Value};

pub fn build(thread: &Value, settings: &Value, providers: &[Value], search: Option<&str>) -> Value {
    let inherited = &thread["modelSelection"];
    let project = thread["projectId"].as_str().unwrap_or("");
    let terms: Vec<String> = search
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    let mut entries = Vec::new();
    for p in providers {
        let id = p["instanceId"].as_str().unwrap_or("");
        let driver = p["driver"].as_str().unwrap_or("");
        let name = p["displayName"].as_str().unwrap_or("");
        let prefs = &settings["providerModelPreferences"][id];
        let hidden = prefs["hiddenModels"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let order = prefs["modelOrder"].as_array().cloned().unwrap_or_default();
        let mut models: Vec<Value> = p["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["isCustom"] == true || !hidden.contains(&m["slug"]))
            .cloned()
            .collect();
        models.sort_by_key(|m| {
            order
                .iter()
                .position(|v| v == &m["slug"])
                .unwrap_or(usize::MAX)
        });
        let provider_text = format!("{id} {driver} {name}").to_lowercase();
        let words: Vec<_> = provider_text
            .split_whitespace()
            .chain(provider_text.split(|c: char| !c.is_alphanumeric()))
            .filter(|s| !s.is_empty())
            .collect();
        let model_text = |m: &Value| {
            format!(
                "{} {} {}",
                m["slug"].as_str().unwrap_or(""),
                m["name"].as_str().unwrap_or(""),
                m["subProvider"].as_str().unwrap_or("")
            )
            .to_lowercase()
        };
        let model_terms: Vec<_> = terms
            .iter()
            .filter(|term| {
                !words.contains(&term.as_str())
                    && (!provider_text.contains(term.as_str())
                        || models.iter().any(|m| model_text(m).contains(term.as_str())))
            })
            .collect();
        let visible = models.len();
        let listed: Vec<Value> = if !model_terms.is_empty() {
            models
                .iter()
                .filter(|m| {
                    model_terms
                        .iter()
                        .all(|t| model_text(m).contains(t.as_str()))
                })
                .take(8)
                .cloned()
                .collect()
        } else {
            let mut n = 0;
            models
                .iter()
                .filter(|m| {
                    let pinned = m["isCustom"] == true
                        || (inherited["instanceId"] == id && inherited["model"] == m["slug"])
                        || settings["favorites"].as_array().is_some_and(|v| {
                            v.iter()
                                .any(|f| f["provider"] == id && f["model"] == m["slug"])
                        });
                    let current = m["isLegacy"] != true;
                    let shown = current
                        && (matches!(driver, "codex" | "claudeAgent" | "muse" | "grok") || n < 8);
                    if current {
                        n += 1;
                    }
                    pinned || shown
                })
                .cloned()
                .collect()
        };
        let matched = if model_terms.is_empty() {
            visible
        } else {
            models
                .iter()
                .filter(|m| {
                    model_terms
                        .iter()
                        .all(|t| model_text(m).contains(t.as_str()))
                })
                .count()
        };
        let mapped: Vec<Value> = listed
            .iter()
            .filter_map(|m| {
                let slug = m["slug"].as_str()?;
                let mut v = json!({"id":slug});
                if let Some(name) = m["name"].as_str().filter(|n| !n.eq_ignore_ascii_case(slug)) {
                    v["label"] = json!(name);
                }
                let descriptors = m["capabilities"]["optionDescriptors"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let options: Vec<Value> = descriptors
                    .iter()
                    .filter_map(|d| {
                        let id = d["id"].as_str()?;
                        let values = if d["type"] == "boolean" {
                            json!([false, true])
                        } else {
                            json!(d["options"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|o| o["id"].as_str())
                                .collect::<Vec<_>>())
                        };
                        let mut out = json!({"id":id,"values":values});
                        if !d["currentValue"].is_null() {
                            out["default"] = d["currentValue"].clone();
                        }
                        Some(out)
                    })
                    .collect();
                if !options.is_empty() {
                    v["options"] = json!(options)
                }
                Some(v)
            })
            .collect();
        let enabled = p["enabled"] != false
            && settings["projectSettingsOverrides"][project]["providerInstances"][id]["enabled"]
                .as_bool()
                .or_else(|| settings["providerInstances"][id]["enabled"].as_bool())
                .unwrap_or(true);
        let mut constraints = Vec::new();
        if driver != "codex" {
            constraints.push("No V2 provider adapter is registered.".to_owned());
        }
        if p["availability"] == "unavailable" {
            constraints.push(
                p["unavailableReason"]
                    .as_str()
                    .unwrap_or("Provider driver is unavailable.")
                    .to_owned(),
            );
        }
        if !enabled {
            constraints.push("Provider instance is disabled.".into())
        } else {
            if p["installed"] == false {
                constraints.push("Provider executable is not installed.".into());
            }
            if matches!(p["status"].as_str(), Some("error" | "disabled")) {
                constraints.push(p["message"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    format!(
                        "Provider status is {}.",
                        p["status"].as_str().unwrap_or("error")
                    )
                }));
            }
            if p["auth"]["status"] == "unauthenticated" {
                constraints.push("Provider is not authenticated.".into());
            }
        }
        let available = constraints.is_empty();
        let mut entry = json!({"providerInstanceId":id,"driverKind":driver,"displayName":p["displayName"],"models":mapped,"canRunChildTask":available,"canRunCrossProviderChildTask":available,"constraints":constraints});
        if matched > listed.len() {
            entry["omittedModels"] = json!(matched - listed.len())
        }
        if p["supportedRuntimeModes"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            entry["runtimeModes"] = p["supportedRuntimeModes"].clone()
        }
        entries.push(entry);
    }
    let inherited_descriptors = providers
        .iter()
        .find(|p| p["instanceId"] == inherited["instanceId"])
        .and_then(|p| p["models"].as_array())
        .and_then(|models| {
            models.iter().find(|m| {
                m["slug"] == inherited["model"]
                    || inherited["model"].as_str().is_some_and(|model| {
                        m["aliases"].as_array().is_some_and(|aliases| {
                            aliases
                                .iter()
                                .any(|a| a.as_str().is_some_and(|a| a.eq_ignore_ascii_case(model)))
                        })
                    })
            })
        })
        .and_then(|m| m["capabilities"]["optionDescriptors"].as_array());
    let inherited_options: Vec<Value> = inherited["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| {
            inherited_descriptors
                .is_none_or(|descriptors| descriptors.iter().any(|d| d["id"] == option["id"]))
        })
        .cloned()
        .collect();
    json!({"parentThreadId":thread["id"],"inheritedProviderInstanceId":inherited["instanceId"],"inheritedModel":inherited["model"],"inheritedOptions":inherited_options,"runtimeMode":thread["runtimeMode"],"interactionMode":thread["interactionMode"],"providers":entries,"features":{"appOwnedSubagents":true,"asyncPolling":true,"cancellation":false,"batchThreadCreation":false,"threadManagement":false,"incrementalThreadRead":true,"scheduledTasks":false,"maxBatchThreads":20}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_orders_and_reports_constraints() {
        let thread = json!({"id":"t","projectId":"p","runtimeMode":"full-access","interactionMode":"default","modelSelection":{"instanceId":"codex","model":"old"}});
        let settings = json!({"providerModelPreferences":{"codex":{"hiddenModels":["hidden"],"modelOrder":["next"]}},"projectSettingsOverrides":{"p":{"providerInstances":{"codex":{"enabled":false}}}}});
        let provider = json!({"instanceId":"codex","driver":"codex","displayName":"Codex","installed":true,"models":[{"slug":"old","isLegacy":true},{"slug":"hidden"},{"slug":"next"}]});
        let got = build(&thread, &settings, std::slice::from_ref(&provider), None);
        assert_eq!(
            got["providers"][0]["models"],
            json!([{"id":"next"},{"id":"old"}])
        );
        assert_eq!(got["providers"][0]["canRunChildTask"], false);
        let got = build(&thread, &settings, &[provider], Some("old"));
        assert_eq!(got["providers"][0]["models"], json!([{"id":"old"}]));
    }
    #[test]
    fn filters_inherited_options_and_reports_unavailable_disabled_provider() {
        let thread = json!({"projectId":"p","modelSelection":{"instanceId":"x","model":"ALIAS","options":[{"id":"effort","value":"high"},{"id":"stale","value":true}]}});
        let provider = json!({"instanceId":"x","driver":"other","enabled":false,"availability":"unavailable","unavailableReason":"Driver missing.","models":[{"slug":"model","aliases":["alias"],"capabilities":{"optionDescriptors":[{"id":"effort","type":"select","options":[{"id":"high"}]}]}}]});
        let settings =
            json!({"projectSettingsOverrides":{"p":{"providerInstances":{"x":{"enabled":true}}}}});
        let got = build(&thread, &settings, &[provider], None);
        assert_eq!(
            got["inheritedOptions"],
            json!([{"id":"effort","value":"high"}])
        );
        assert_eq!(
            got["providers"][0]["constraints"],
            json!([
                "No V2 provider adapter is registered.",
                "Driver missing.",
                "Provider instance is disabled."
            ])
        );
    }

    #[test]
    fn full_provider_word_does_not_filter_models() {
        let provider = json!({"instanceId":"codex-alt","driver":"codex","models":[{"slug":"one"},{"slug":"codex-alt-two"}]});
        let got = build(&json!({}), &json!({}), &[provider], Some("codex-alt"));
        assert_eq!(
            got["providers"][0]["models"],
            json!([{"id":"one"},{"id":"codex-alt-two"}])
        );
    }
}
