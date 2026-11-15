//! Cursor SDK browser sign-in state, isolated by provider instance and owner.
use super::{
    cursor_bridge::{CursorBridge, CursorCancel},
    cursor_credentials,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

struct Flow {
    id: String,
    owner: String,
    cancelled: Arc<AtomicBool>,
    cancel: CursorCancel,
    state: tokio::sync::watch::Sender<Value>,
}
pub(crate) struct CursorAuth {
    flows: Arc<Mutex<HashMap<String, Flow>>>,
    updates: tokio::sync::watch::Sender<u64>,
}
impl Default for CursorAuth {
    fn default() -> Self {
        Self {
            flows: Arc::new(Mutex::new(HashMap::new())),
            updates: tokio::sync::watch::channel(0).0,
        }
    }
}
fn idle(instance: &str) -> Value {
    json!({"instanceId":instance,"phase":"idle","flowId":null,"authorizationUrl":null,"expiresAt":null,"message":null})
}
fn verify_credentials(credentials: &Value, backend: &str) -> Result<(), bool> {
    let key = credentials["apiKey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or(false)?
        .to_owned();
    let backend = backend.trim_end_matches('/').to_owned();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| false)?;
    runtime.block_on(async move {
        async fn read_json(mut response: reqwest::Response) -> Result<Value, bool> {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| false)? {
                if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
                    return Err(false);
                }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_| false)
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| false)?;
        let user = client
            .get(format!("{backend}/v1/me"))
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|_| false)?;
        if !user.status().is_success() {
            return Err(user.status().as_u16() == 401);
        }
        let user = read_json(user).await?;
        if !user["apiKeyName"].is_string() || !user["createdAt"].is_string() {
            return Err(false);
        }
        let models = client
            .get(format!("{backend}/v1/models"))
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|_| false)?;
        if !models.status().is_success() {
            return Err(models.status().as_u16() == 401);
        }
        let models = read_json(models).await?;
        if !models["items"].as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item["id"].is_string() && item["displayName"].is_string())
        }) {
            return Err(false);
        }
        Ok(())
    })
}
pub(crate) struct CursorAuthStart<'a> {
    pub instance: &'a str,
    pub owner: &'a str,
    pub display: &'a str,
    pub settings: PathBuf,
    pub node: &'a str,
    pub sdk_path: Option<&'a str>,
    pub backend: Option<&'a str>,
}
impl CursorAuth {
    pub(crate) fn state(&self, instance: &str, owner: &str) -> Value {
        let mut value = self
            .flows
            .lock()
            .ok()
            .and_then(|flows| {
                flows.get(instance).map(|flow| {
                    let mut state = flow.state.borrow().clone();
                    if flow.owner != owner {
                        state["flowId"] = Value::Null;
                        state["authorizationUrl"] = Value::Null;
                        state["expiresAt"] = Value::Null;
                        state["message"] = json!("Sign-in is in progress in another client.");
                    }
                    state
                })
            })
            .unwrap_or_else(|| idle(instance));
        value["credentialOwner"] = json!("t3");
        value["methods"] = json!([{"id":"browser","name":"Sign in with Cursor","description":null,"type":"agent"}]);
        value["interaction"] = if value["phase"] == "waiting"
            && value["flowId"].is_string()
            && value["authorizationUrl"].is_string()
        {
            json!({"type":"browser","id":value["flowId"],"url":value["authorizationUrl"],"requiresConsent":false})
        } else {
            Value::Null
        };
        value
    }
    pub(crate) fn subscribe_updates(&self) -> tokio::sync::watch::Receiver<u64> {
        self.updates.subscribe()
    }
    pub(crate) fn subscribe(
        &self,
        instance: &str,
        owner: &str,
    ) -> Option<tokio::sync::watch::Receiver<Value>> {
        self.flows
            .lock()
            .ok()?
            .get(instance)
            .filter(|flow| flow.owner == owner)
            .map(|flow| flow.state.subscribe())
    }
    pub(crate) fn start(&self, input: CursorAuthStart<'_>) -> Result<Value, String> {
        let CursorAuthStart {
            instance,
            owner,
            display,
            settings,
            node,
            sdk_path,
            backend,
        } = input;
        let mut flows = self
            .flows
            .lock()
            .map_err(|_| "Cursor sign-in is unavailable")?;
        if let Some(existing) = flows.get(instance) {
            if existing.owner == owner
                && matches!(
                    existing.state.borrow()["phase"].as_str(),
                    Some("starting" | "waiting" | "verifying")
                )
            {
                return Ok(existing.state.borrow().clone());
            }
            if matches!(
                existing.state.borrow()["phase"].as_str(),
                Some("starting" | "waiting" | "verifying")
            ) {
                return Err("Cursor setup is already in progress".into());
            }
        }
        let mut bridge = CursorBridge::spawn(node, sdk_path)?;
        let cancel = bridge.cancel_handle();
        let id = uuid::Uuid::new_v4().to_string();
        let expires = (chrono::Utc::now() + chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let initial = json!({"instanceId":instance,"phase":"starting","flowId":id,"authorizationUrl":null,"expiresAt":expires,"message":"Starting Cursor sign-in."});
        let (state, _) = tokio::sync::watch::channel(initial.clone());
        let cancelled = Arc::new(AtomicBool::new(false));
        flows.insert(
            instance.to_owned(),
            Flow {
                id: id.clone(),
                owner: owner.to_owned(),
                cancelled: cancelled.clone(),
                cancel,
                state: state.clone(),
            },
        );
        drop(flows);
        self.updates.send_modify(|n| *n = n.wrapping_add(1));
        let updates = self.updates.clone();
        let map = self.flows.clone();
        let instance = instance.to_owned();
        let display = display.to_owned();
        let backend = backend.unwrap_or("https://api.cursor.com").to_owned();
        tokio::task::spawn_blocking(move || {
            let result = bridge.request(
                "login",
                json!({"apiKeyName":format!("T3 Code - {display}")}),
                Duration::from_secs(300),
                |event| {
                    if cancelled.load(Ordering::Acquire) {
                        return;
                    }
                    if event["method"] == "login.url" {
                        if let Some(url) = event["params"]["url"].as_str() {
                            let mut value = state.borrow().clone();
                            value["phase"] = json!("waiting");
                            value["authorizationUrl"] = json!(url);
                            value["message"] = json!("Open the Cursor sign-in page and finish signing in. This page updates automatically.");
                            state.send_replace(value);
                            updates.send_modify(|n| *n = n.wrapping_add(1));
                        }
                    }
                },
            );
            let credentials = result
                .ok()
                .and_then(|value| value.get("credentials").cloned());
            let verification = if let Some(credentials) = &credentials {
                if cancelled.load(Ordering::Acquire) {
                    return;
                }
                let mut value = state.borrow().clone();
                value["phase"] = json!("verifying");
                value["authorizationUrl"] = Value::Null;
                value["message"] = json!("Checking Cursor sign-in.");
                state.send_replace(value);
                updates.send_modify(|n| *n = n.wrapping_add(1));
                verify_credentials(credentials, &backend)
            } else {
                Err(false)
            };
            // The lock makes cancellation and committing credentials mutually exclusive.
            let Ok(flows) = map.lock() else { return };
            if cancelled.load(Ordering::Acquire)
                || flows.get(&instance).is_none_or(|flow| flow.id != id)
            {
                return;
            }
            let saved = verification.is_ok()
                && credentials.as_ref().is_some_and(|value| {
                    cursor_credentials::save(&settings, &instance, value).is_ok()
                });
            let mut value = state.borrow().clone();
            value["authorizationUrl"] = Value::Null;
            value["expiresAt"] = Value::Null;
            if saved {
                value["phase"] = json!("succeeded");
                value["message"] = json!("Signed in with Cursor.");
            } else {
                value["phase"] = json!("failed");
                value["message"] = if verification == Err(true) {
                    json!("Cursor sign-in expired or was rejected. Sign in again in provider settings.")
                } else {
                    json!("Cursor sign-in failed or expired. Start sign-in again.")
                };
            }
            state.send_replace(value);
            updates.send_modify(|n| *n = n.wrapping_add(1));
        });
        Ok(initial)
    }
    pub(crate) fn logout(&self, instance: &str, settings: &std::path::Path) -> Result<(), String> {
        let mut flows = self
            .flows
            .lock()
            .map_err(|_| "Cursor sign-in is unavailable")?;
        if let Some(flow) = flows.remove(instance) {
            flow.cancelled.store(true, Ordering::Release);
            let _ = flow.cancel.cancel_login();
        }
        cursor_credentials::remove(settings, instance)?;
        self.updates.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }
    pub(crate) fn cancel(
        &self,
        instance: &str,
        owner: &str,
        flow_id: &str,
    ) -> Result<Value, String> {
        let flows = self
            .flows
            .lock()
            .map_err(|_| "Cursor sign-in is unavailable")?;
        let Some(flow) = flows.get(instance).filter(|flow| flow.owner == owner) else {
            return Ok(idle(instance));
        };
        if !matches!(
            flow.state.borrow()["phase"].as_str(),
            Some("starting" | "waiting" | "verifying")
        ) {
            return Ok(flow.state.borrow().clone());
        }
        if flow.id != flow_id {
            return Err("This sign-in is no longer active in this client.".into());
        }
        flow.cancelled.store(true, Ordering::Release);
        let _ = flow.cancel.cancel_login();
        let mut state = flow.state.borrow().clone();
        state["phase"] = json!("cancelled");
        state["authorizationUrl"] = Value::Null;
        state["expiresAt"] = Value::Null;
        state["message"] = json!("Cursor sign-in was cancelled.");
        flow.state.send_replace(state.clone());
        self.updates.send_modify(|n| *n = n.wrapping_add(1));
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_rejects_invalid_credentials_without_exposing_them() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let backend = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        assert_eq!(
            verify_credentials(&json!({"apiKey":"fixture-private-key"}), &backend),
            Err(true)
        );
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn cancelled_login_never_persists_a_late_sdk_result() {
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-cursor-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk,r#"module.exports={Cursor:{auth:{login:async({store,onLoginUrl})=>{onLoginUrl('https://example.test/login');await new Promise(r=>setTimeout(r,250));await store.save({version:1,backendUrl:'https://example.test',apiKey:'late-private-key',createdAtMs:1});}}}};"#).unwrap();
        let settings = root.join("settings.json");
        let auth = CursorAuth::default();
        auth.start(CursorAuthStart {
            instance: "cursor",
            owner: "owner",
            display: "Cursor",
            settings: settings.clone(),
            node: "node",
            sdk_path: sdk.to_str(),
            backend: None,
        })
        .unwrap();
        let mut states = auth.subscribe("cursor", "owner").unwrap();
        tokio::time::timeout(Duration::from_secs(3), states.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(states.borrow()["phase"], "waiting");
        assert_eq!(
            auth.cancel(
                "cursor",
                "owner",
                auth.state("cursor", "owner")["flowId"].as_str().unwrap()
            )
            .unwrap()["phase"],
            "cancelled"
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(auth.state("cursor", "owner")["phase"], "cancelled");
        assert_eq!(cursor_credentials::read(&settings, "cursor").unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn login_is_owner_scoped_and_saves_the_sdk_credentials() {
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let root = std::env::temp_dir().join(format!("t3-cursor-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sdk = root.join("sdk.cjs");
        std::fs::write(&sdk,r#"module.exports={Cursor:{auth:{login:async({store,onLoginUrl})=>{onLoginUrl('https://example.test/login');await new Promise(r=>setTimeout(r,80));await store.save({version:1,backendUrl:'https://example.test',apiKey:'fixture-private-key',createdAtMs:1});}}}};"#).unwrap();
        let settings = root.join("settings.json");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let backend = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut request = [0u8; 4096];
                let count = stream.read(&mut request).unwrap();
                let body = if String::from_utf8_lossy(&request[..count]).starts_with("GET /v1/me ")
                {
                    r#"{"apiKeyName":"Fixture","createdAt":"2026-01-01"}"#
                } else {
                    r#"{"items":[{"id":"model","displayName":"Model"}]}"#
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let auth = CursorAuth::default();
        assert_eq!(
            auth.start(CursorAuthStart {
                instance: "cursor",
                owner: "owner",
                display: "Cursor",
                settings: settings.clone(),
                node: "node",
                sdk_path: sdk.to_str(),
                backend: Some(&backend)
            })
            .unwrap()["phase"],
            "starting"
        );
        assert!(auth.state("cursor", "other")["flowId"].is_null());
        let mut states = auth.subscribe("cursor", "owner").unwrap();
        let mut waiting = false;
        for _ in 0..20 {
            tokio::time::timeout(Duration::from_secs(3), states.changed())
                .await
                .unwrap()
                .unwrap();
            let state = states.borrow().clone();
            if state["phase"] == "waiting" {
                waiting = true;
                assert_eq!(state["authorizationUrl"], "https://example.test/login");
            }
            if state["phase"] == "succeeded" {
                break;
            }
        }
        assert!(waiting);
        assert_eq!(auth.state("cursor", "owner")["phase"], "succeeded");
        assert_eq!(
            cursor_credentials::read(&settings, "cursor")
                .unwrap()
                .unwrap()["apiKey"],
            "fixture-private-key"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
