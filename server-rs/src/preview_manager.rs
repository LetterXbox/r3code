//! In-memory preview tab coordination. Headless server browsing is not implemented.
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Mutex};

pub struct PreviewManager {
    epoch: String,
    state: Mutex<State>,
    events: tokio::sync::broadcast::Sender<Value>,
}
#[derive(Default)]
struct State {
    sessions: BTreeMap<(String, String), Value>,
    revision: u64,
    sequence: u64,
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn id(input: &Value, key: &str) -> Option<String> {
    input[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && (key != "tabId" || s.chars().count() <= 128))
        .map(str::to_owned)
}
fn viewport(v: &Value) -> bool {
    if v["_tag"] == "fill" {
        return true;
    }
    if !matches!(v["_tag"].as_str(), Some("freeform" | "preset")) {
        return false;
    }
    let Some((w, h)) = v["width"].as_u64().zip(v["height"].as_u64()) else {
        return false;
    };
    if !(240..=3840).contains(&w) || !(240..=3840).contains(&h) || w * h > 3840 * 2160 {
        return false;
    }
    if v["_tag"] == "preset" {
        matches!(
            v["presetId"].as_str(),
            Some(
                "iphone-se"
                    | "iphone-xr"
                    | "iphone-12-pro"
                    | "iphone-14-pro-max"
                    | "pixel-7"
                    | "samsung-galaxy-s8-plus"
                    | "samsung-galaxy-s20-ultra"
                    | "ipad-mini"
                    | "ipad-air"
                    | "ipad-pro"
                    | "surface-pro-7"
                    | "surface-duo"
                    | "galaxy-z-fold-5"
                    | "asus-zenbook-fold"
                    | "samsung-galaxy-a51-71"
                    | "nest-hub"
                    | "nest-hub-max"
                    | "desktop-1920x1080"
                    | "desktop-1440x900"
                    | "laptop-1366x768"
                    | "laptop-1280x800"
                    | "ipad-pro-11"
                    | "iphone-15-pro"
                    | "pixel-8"
                    | "galaxy-s24"
            )
        )
    } else {
        true
    }
}
fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize] as char);
        n /= 36;
    }
    digits.iter().rev().collect()
}
pub fn normalize_url(input: &str) -> Option<String> {
    let value = input.trim();
    if value.is_empty() || value.chars().count() > 2048 {
        return None;
    }
    let candidate = if value.contains("://") {
        value.to_string()
    } else if value.starts_with("localhost")
        || value.starts_with("127.0.0.1")
        || value.starts_with("0.0.0.0")
        || value.starts_with("[::1]")
    {
        format!("http://{value}")
    } else {
        format!("https://{value}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    Some(parsed.to_string())
}
impl PreviewManager {
    pub fn new() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            state: Mutex::new(State::default()),
            events: tokio::sync::broadcast::channel(256).0,
        }
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.events.subscribe()
    }
    pub fn dispatch(&self, tag: &str, input: &Value) -> Result<Value, Value> {
        self.dispatch_inner(tag, input, false)
    }
    pub fn report_server(&self, input: &Value) -> Result<Value, Value> {
        self.dispatch_inner("preview.reportStatus", input, true)
    }
    pub fn snapshot(&self, thread: &str, tab: &str) -> Option<Value> {
        self.state
            .lock()
            .ok()?
            .sessions
            .get(&(thread.to_owned(), tab.to_owned()))
            .cloned()
    }
    fn dispatch_inner(
        &self,
        tag: &str,
        input: &Value,
        server_controlled: bool,
    ) -> Result<Value, Value> {
        let bad = || json!({"name":"Error","message":"Invalid RPC payload"});
        if tag == "preview.reportProfiles" {
            if !input.get("profiles").is_some_and(Value::is_array) {
                return Err(bad());
            }
            return Ok(Value::Null);
        }
        let thread = id(input, "threadId").ok_or_else(bad)?;
        let mut state = self.state.lock().map_err(|_| bad())?;
        if tag == "preview.list" {
            let mut sessions: Vec<_> = state
                .sessions
                .iter()
                .filter(|((t, _), _)| t == &thread)
                .map(|(_, v)| v.clone())
                .collect();
            sessions.sort_by(|a, b| a["updatedAt"].as_str().cmp(&b["updatedAt"].as_str()));
            return Ok(
                json!({"sessions":sessions,"serverEpoch":self.epoch,"revision":state.revision}),
            );
        }
        if tag == "preview.open" {
            if input
                .get("runtime")
                .is_some_and(|v| v != "desktop" && v != "server")
                || input.get("reveal").is_some_and(|v| !v.is_boolean())
                || input
                    .get("profileId")
                    .is_some_and(|_| id(input, "profileId").is_none())
                || input.get("viewport").is_some_and(|v| !viewport(v))
            {
                return Err(bad());
            }
            let nav = if let Some(raw) = input.get("url") {
                let raw = raw.as_str().ok_or_else(bad)?;
                let url = normalize_url(raw).ok_or_else(bad)?;
                json!({"_tag":"Loading","url":url,"title":""})
            } else {
                json!({"_tag":"Idle"})
            };
            state.sequence += 1;
            let mut tab = format!("tab_{}", base36(state.sequence));
            if input["runtime"] == "server" {
                tab.push('_');
                tab.push_str(&self.epoch);
            }
            let stamp = now();
            let mut snapshot = json!({"threadId":thread,"tabId":tab,"navStatus":nav,"canGoBack":false,"canGoForward":false,"viewport":input.get("viewport").cloned().unwrap_or(json!({"_tag":"fill"})),"updatedAt":stamp});
            for key in ["profileId", "runtime", "reveal"] {
                if let Some(v) = input.get(key) {
                    snapshot[key] = v.clone();
                }
            }
            state.revision += 1;
            state
                .sessions
                .insert((thread.clone(), tab.clone()), snapshot.clone());
            let _=self.events.send(json!({"type":"opened","threadId":thread,"tabId":tab,"createdAt":stamp,"serverEpoch":self.epoch,"revision":state.revision,"snapshot":snapshot}));
            return Ok(snapshot);
        }
        if tag == "preview.close" {
            let tab = input
                .get("tabId")
                .map(|_| id(input, "tabId").ok_or_else(bad))
                .transpose()?;
            let keys: Vec<_> = state
                .sessions
                .keys()
                .filter(|(t, b)| t == &thread && tab.as_ref().is_none_or(|id| id == b))
                .cloned()
                .collect();
            let stamp = now();
            for key in keys {
                state.sessions.remove(&key);
                state.revision += 1;
                let _=self.events.send(json!({"type":"closed","threadId":thread,"tabId":key.1,"createdAt":stamp,"serverEpoch":self.epoch,"revision":state.revision}));
            }
            return Ok(Value::Null);
        }
        let tab = id(input, "tabId").ok_or_else(bad)?;
        let key = (thread.clone(), tab.clone());
        let Some(mut snapshot) = state.sessions.get(&key).cloned() else {
            return Err(json!({"_tag":"PreviewSessionLookupError","threadId":thread,"tabId":tab}));
        };
        let stamp = now();
        snapshot["updatedAt"] = json!(stamp);
        let (event, result) = match tag {
            "preview.resize" => {
                if !viewport(&input["viewport"]) {
                    return Err(bad());
                }
                snapshot["viewport"] = input["viewport"].clone();
                (
                    json!({"type":"resized","snapshot":snapshot}),
                    snapshot.clone(),
                )
            }
            "preview.reportStatus" => {
                if snapshot["runtime"] == "server" && !server_controlled {
                    return Err(json!({"_tag":"PreviewControlRequiredError","tabId":tab}));
                }
                let nav = &input["navStatus"];
                if !matches!(
                    nav["_tag"].as_str(),
                    Some("Idle" | "Loading" | "Success" | "LoadFailed")
                ) || !input["canGoBack"].is_boolean()
                    || !input["canGoForward"].is_boolean()
                {
                    return Err(bad());
                }
                if nav["_tag"] != "Idle" && (!nav["url"].is_string() || !nav["title"].is_string()) {
                    return Err(bad());
                }
                if nav["_tag"] == "LoadFailed"
                    && (!nav["code"].is_i64() || !nav["description"].is_string())
                {
                    return Err(bad());
                }
                snapshot["navStatus"] = nav.clone();
                snapshot["canGoBack"] = input["canGoBack"].clone();
                snapshot["canGoForward"] = input["canGoForward"].clone();
                let event = if nav["_tag"] == "LoadFailed" {
                    let mut e = json!({"type":"failed","url":nav["url"],"title":nav["title"],"code":nav["code"],"description":nav["description"]});
                    if let Some(v) = nav.get("download") {
                        e["download"] = v.clone();
                    }
                    e
                } else {
                    json!({"type":"navigated","snapshot":snapshot})
                };
                (event, Value::Null)
            }
            "preview.adjust" => {
                if input
                    .get("colorScheme")
                    .is_some_and(|v| !matches!(v.as_str(), Some("system" | "light" | "dark")))
                    || input.get("zoomFactor").is_some_and(|v| {
                        v.as_f64().is_none_or(|n| {
                            ![
                                0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75,
                                2.0, 2.5, 3.0, 4.0, 5.0,
                            ]
                            .contains(&n)
                        })
                    })
                    || input.get("hardReload").is_some_and(|v| !v.is_boolean())
                    || input
                        .get("clear")
                        .is_some_and(|v| !matches!(v.as_str(), Some("cookies" | "cache")))
                {
                    return Err(bad());
                }
                for field in ["colorScheme", "zoomFactor"] {
                    if let Some(v) = input.get(field) {
                        snapshot[field] = v.clone();
                    }
                }
                let mut event = json!({"type":"resized","snapshot":snapshot});
                let mut request = json!({});
                if input["hardReload"] == true {
                    request["hardReload"] = json!(true);
                }
                if let Some(v) = input.get("clear") {
                    request["clear"] = v.clone();
                }
                if request.as_object().is_some_and(|v| !v.is_empty()) {
                    event["request"] = request;
                }
                (event, snapshot.clone())
            }
            _ => return Err(bad()),
        };
        state.sessions.insert(key, snapshot);
        state.revision += 1;
        let mut event = event;
        event["threadId"] = json!(thread);
        event["tabId"] = json!(tab);
        event["createdAt"] = json!(stamp);
        event["serverEpoch"] = json!(self.epoch);
        event["revision"] = json!(state.revision);
        let _ = self.events.send(event);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manages_desktop_tabs_and_emits_ordered_revisions() {
        let manager = PreviewManager::new();
        let mut events = manager.subscribe();
        let opened = manager
            .dispatch(
                "preview.open",
                &json!({"threadId":"t","url":"localhost:5173"}),
            )
            .unwrap();
        assert_eq!(opened["navStatus"]["url"], "http://localhost:5173/");
        let tab = opened["tabId"].as_str().unwrap();
        let event = events.try_recv().unwrap();
        assert_eq!(event["type"], "opened");
        assert_eq!(event["revision"], 1);
        assert_eq!(
            manager
                .dispatch("preview.list", &json!({"threadId":"t"}))
                .unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let size = json!({"_tag":"freeform","width":600,"height":500});
        let resized = manager
            .dispatch(
                "preview.resize",
                &json!({"threadId":"t","tabId":tab,"viewport":size}),
            )
            .unwrap();
        assert_eq!(resized["viewport"], size);
        assert_eq!(events.try_recv().unwrap()["revision"], 2);
        assert_eq!(
            manager
                .dispatch("preview.close", &json!({"threadId":"t","tabId":tab}))
                .unwrap(),
            Value::Null
        );
        assert_eq!(events.try_recv().unwrap()["revision"], 3);
        assert_eq!(
            manager
                .dispatch(
                    "preview.resize",
                    &json!({"threadId":"t","tabId":tab,"viewport":size})
                )
                .unwrap_err()["_tag"],
            "PreviewSessionLookupError"
        );
        let server = manager
            .dispatch("preview.open", &json!({"threadId":"t","runtime":"server"}))
            .unwrap();
        assert!(server["tabId"].as_str().unwrap().contains('_'));
    }
}
