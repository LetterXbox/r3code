//! Derive the shell's outstanding background work from the latest execution.
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn derive(thread: &Value, runs: &[Value], providers: &[Value], items: &[Value]) -> Vec<Value> {
    let active = runs.iter().any(|r| {
        matches!(
            r["status"].as_str(),
            Some("preparing" | "starting" | "running")
        )
    });
    if active {
        return vec![];
    }
    let latest = runs
        .iter()
        .rev()
        .find(|r| !(r["status"] == "queued" && r["queueHeld"] == true));
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    if latest.is_some_and(|r| {
        matches!(
            r["status"].as_str(),
            Some("completed" | "failed" | "interrupted" | "cancelled" | "waiting")
        )
    }) {
        for provider in providers.iter().filter(|p| {
            thread["activeProviderThreadId"].is_null()
                || thread["activeProviderThreadId"] == p["id"]
        }) {
            for task in provider["pendingBackgroundTasks"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(id) = task["taskId"].as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                if !ids.insert(id.to_owned()) {
                    continue;
                }
                let mut value = task.clone();
                if let Some(object) = value.as_object_mut() {
                    match task["description"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        Some(desc) => {
                            object.insert("description".into(), json!(desc));
                        }
                        None => {
                            object.remove("description");
                        }
                    }
                    if task["kind"] == "subagent" && !provider["providerInstanceId"].is_null() {
                        object.insert(
                            "providerInstanceId".into(),
                            provider["providerInstanceId"].clone(),
                        );
                    }
                }
                result.push(value);
            }
        }
        for item in items {
            let kind = match item["type"].as_str() {
                Some("command_execution") => {
                    if item["monitor"] == true {
                        "monitor"
                    } else {
                        "command"
                    }
                }
                Some("dynamic_tool") if item["input"]["persistent"] != true => "background_task",
                Some("subagent") => "subagent",
                _ => continue,
            };
            if !matches!(
                item["status"].as_str(),
                Some("pending" | "running" | "waiting")
            ) || runs
                .iter()
                .any(|r| r["id"] == item["runId"] && r["status"] == "rolled_back")
            {
                continue;
            }
            let Some(id) = item["nativeItemRef"]["nativeId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| item["id"].as_str())
            else {
                continue;
            };
            if !ids.insert(id.to_owned()) {
                continue;
            }
            let mut value = json!({"taskId":id,"kind":kind});
            let description = item["title"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| match kind {
                    "command" | "monitor" => item["input"].as_str(),
                    "subagent" => item["prompt"].as_str(),
                    _ => item["toolName"].as_str(),
                })
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(description) = description {
                value["description"] = json!(description);
            }
            if kind == "subagent" {
                if !item["childThreadId"].is_null() {
                    value["childThreadId"] = item["childThreadId"].clone();
                }
                if let Some(provider) = providers
                    .iter()
                    .find(|p| p["id"] == item["providerThreadId"])
                {
                    if !provider["providerInstanceId"].is_null() {
                        value["providerInstanceId"] = provider["providerInstanceId"].clone();
                    }
                }
            }
            result.push(value);
        }
    } else if latest.is_some() {
        return result;
    }
    for link in thread["pullRequests"].as_array().into_iter().flatten() {
        if link["watch"].is_null()
            || link["source"] == "stack-dismissed"
            || link["snapshot"]["state"] == "merged"
        {
            continue;
        }
        let (Some(host), Some(repo), Some(number)) = (
            link["host"].as_str(),
            link["repository"].as_str(),
            link["number"].as_u64(),
        ) else {
            continue;
        };
        let id = format!(
            "pull-request-watch:{}/{}#{}",
            host.to_lowercase(),
            repo.to_lowercase(),
            number
        );
        let mut value = json!({"taskId":id,"description":format!("Watching pull request #{number}"),"kind":"monitor"});
        if link["watch"]["checksPending"] != false {
            value["awaited"] = json!(true);
        }
        if let Some(position) = result.iter().position(|v| v["taskId"] == id) {
            result[position] = value;
        } else {
            result.push(value);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roster_items_and_watches_only_appear_after_run_settles() {
        let thread = json!({"activeProviderThreadId":"p","pullRequests":[{"host":"GITHUB.COM","repository":"Owner/Repo","number":7,"source":"manual","snapshot":{"state":"open"},"watch":{}}]});
        let provider = json!({"id":"p","providerInstanceId":"codex","pendingBackgroundTasks":[{"taskId":"task","kind":"subagent","description":" test "}]});
        let item = json!({"id":"i","type":"command_execution","status":"running","runId":"r","input":"npm run dev"});
        let complete = json!({"id":"r","status":"completed"});
        let tasks = derive(
            &thread,
            std::slice::from_ref(&complete),
            std::slice::from_ref(&provider),
            std::slice::from_ref(&item),
        );
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0]["description"], "test");
        assert_eq!(tasks[0]["providerInstanceId"], "codex");
        assert_eq!(tasks[1]["kind"], "command");
        assert_eq!(
            tasks[2]["taskId"],
            "pull-request-watch:github.com/owner/repo#7"
        );
        assert!(derive(
            &thread,
            &[json!({"id":"r","status":"running"})],
            &[provider],
            &[item]
        )
        .is_empty());
        assert_eq!(derive(&thread, &[], &[], &[]).len(), 1);
    }
}
