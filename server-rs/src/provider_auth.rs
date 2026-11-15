//! Provider auth RPC boundary. Existing Codex installations own their credentials.
use serde_json::{json, Value};
use std::path::Path;

pub fn handles(tag: &str) -> bool {
    matches!(
        tag,
        "provider.auth.start"
            | "provider.auth.respond"
            | "provider.auth.complete"
            | "provider.auth.cancel"
            | "provider.auth.removeMethod"
            | "provider.auth.logout"
            | "provider.auth.subscribe"
            | "provider.chatgpt.reconnect-profile"
            | "provider.chatgpt.import-profile"
    )
}

pub fn error(tag: &str, payload: &Value, settings_path: &Path) -> Value {
    let id = payload
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let operation = match tag {
        "provider.chatgpt.reconnect-profile" => "export",
        "provider.chatgpt.import-profile" => "import",
        _ => tag.rsplit('.').next().unwrap_or("unknown"),
    };
    let settings = crate::provider::session_registry::read_provider_settings(Some(settings_path))
        .unwrap_or(Value::Null);
    let entry = settings.pointer(&format!(
        "/providerInstances/{}",
        id.replace('~', "~0").replace('/', "~1")
    ));
    let driver = entry
        .and_then(|entry| entry["driver"].as_str())
        .or((id == "codex").then_some("codex"));
    let permitted =
        driver.is_none_or(|driver| crate::managed_policy::check_provider_allowed(driver).is_ok());
    let exists = permitted && (entry.is_some() || id == "codex");
    let managed =
        entry.is_some_and(|v| v["driver"] == "codex" && v["config"]["setupMode"] == "managed");
    let detail = if !exists {
        "This provider instance is no longer available."
    } else if managed {
        "Managed Codex sign-in is not implemented by this server."
    } else {
        "This provider does not support sign-in in T3 Code."
    };
    json!({"_tag":"ProviderSetupError", "instanceId":id, "operation":operation, "detail":detail})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saved_profiles_are_listed_without_exposing_tokens() {
        let dir = std::env::temp_dir().join(format!("profile-methods-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "managed").unwrap();
        store
            .save_registration(crate::codex_credential_store::Registration {
                client_id: "oaiapp_saved".into(),
                subject: None,
                email: Some("person@example.com".into()),
                connection_label: Some("Work".into()),
                sharing_enabled: None,
                redirect_uri: None,
            })
            .await
            .unwrap();
        let flows = ManagedFlows::for_test();
        let controller = flows.controller("managed").await.unwrap();
        let state = ManagedFlows::render_state(&controller.snapshot("owner"), "managed", &dir)
            .await
            .unwrap();
        assert_eq!(state["methods"][2]["id"], "chatgpt-profile:oaiapp_saved");
        assert_eq!(state["methods"][2]["canRemove"], true);
        assert!(!state.to_string().contains("accessToken"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reports_existing_missing_and_managed_instances_without_touching_credentials() {
        let dir = std::env::temp_dir().join(format!("provider-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, r#"{"providerInstances":{"managed":{"driver":"codex","config":{"setupMode":"managed"}}}}"#).unwrap();
        let e = error(
            "provider.auth.subscribe",
            &json!({"instanceId":"codex"}),
            &settings,
        );
        assert_eq!(e["operation"], "subscribe");
        assert_eq!(
            e["detail"],
            "This provider does not support sign-in in T3 Code."
        );
        assert_eq!(
            error(
                "provider.auth.start",
                &json!({"instanceId":"missing"}),
                &settings
            )["detail"],
            "This provider instance is no longer available."
        );
        assert_eq!(
            error(
                "provider.chatgpt.reconnect-profile",
                &json!({"instanceId":"managed"}),
                &settings
            )["operation"],
            "export"
        );
        assert_eq!(
            error(
                "provider.auth.logout",
                &json!({"instanceId":"managed"}),
                &settings
            )["detail"],
            "Managed Codex sign-in is not implemented by this server."
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Validate the wire payload without inspecting credentials or starting a provider process.
pub fn validate(tag: &str, payload: &Value) -> bool {
    fn string(v: &Value, max: usize, nonblank: bool) -> bool {
        v.as_str().is_some_and(|s| {
            (!nonblank || !s.trim().is_empty())
                && (if nonblank { s.trim() } else { s }).encode_utf16().count() <= max
        })
    }
    fn optional(v: &Value, key: &str, f: impl FnOnce(&Value) -> bool) -> bool {
        v.get(key).is_none_or(f)
    }
    fn id(v: &Value) -> bool {
        string(v, 128, true)
    }
    fn profile(v: &Value) -> bool {
        let Some(reg) = v.get("registration").filter(|v| v.is_object()) else {
            return false;
        };
        let Some(creds) = v.get("credentials").filter(|v| v.is_object()) else {
            return false;
        };
        let client = reg["clientId"]
            .as_str()
            .and_then(|s| s.strip_prefix("oaiapp_"))
            .is_some_and(|s| {
                !s.is_empty()
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            });
        let redirect = optional(reg, "redirectUri", |v| {
            v.as_str().is_some_and(|s| {
                regex::Regex::new(
                    r"^http://(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}/auth/callback$",
                )
                .unwrap()
                .is_match(s)
            })
        });
        let null_string = |v: &Value| v.is_null() || v.is_string();
        client
            && redirect
            && optional(reg, "subject", Value::is_string)
            && optional(reg, "email", null_string)
            && optional(reg, "connectionLabel", Value::is_string)
            && optional(reg, "sharingEnabled", Value::is_boolean)
            && optional(reg, "idTokenHint", |v| string(v, 16384, false))
            && creds["clientId"].is_string()
            && string(&creds["accessToken"], 16384, false)
            && creds["accessToken"].as_str().is_some_and(|s| !s.is_empty())
            && creds
                .get("refreshToken")
                .is_some_and(|v| v.is_null() || string(v, 16384, false))
            && string(&creds["idToken"], 16384, false)
            && creds["idToken"].as_str().is_some_and(|s| !s.is_empty())
            && creds["issuer"].is_string()
            && creds["expiresAt"].as_f64().is_some_and(f64::is_finite)
            && creds
                .get("earliestRefreshAt")
                .is_some_and(|v| v.is_null() || v.as_f64().is_some_and(f64::is_finite))
            && creds["scopes"]
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
            && creds["subject"].is_string()
            && creds.get("email").is_some_and(null_string)
    }
    if !payload.is_object() {
        return false;
    }
    let Some(instance) = payload["instanceId"].as_str().map(str::trim) else {
        return false;
    };
    if instance.len() > 64
        || instance.is_empty()
        || !instance.as_bytes()[0].is_ascii_alphabetic()
        || !instance
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return false;
    }
    match tag {
        "provider.auth.start" => {
            optional(payload, "methodId", id)
                && optional(payload, "returnUrl", Value::is_string)
                && optional(payload, "callbackMode", |v| {
                    matches!(v.as_str(), Some("server" | "client"))
                })
        }
        "provider.auth.logout" | "provider.auth.subscribe" => true,
        "provider.auth.cancel" => id(&payload["flowId"]),
        "provider.auth.removeMethod" => id(&payload["methodId"]),
        "provider.auth.complete" => {
            id(&payload["flowId"]) && string(&payload["callbackUrl"], 16384, true)
        }
        "provider.chatgpt.reconnect-profile" => payload["methodId"].is_string(),
        "provider.chatgpt.import-profile" => profile(&payload["profile"]),
        "provider.auth.respond" => {
            if !id(&payload["flowId"]) || !id(&payload["interactionId"]) {
                return false;
            }
            let response = &payload["response"];
            match response["type"].as_str() {
                Some("browser") => {
                    matches!(response["action"].as_str(), Some("accept" | "decline"))
                }
                Some("terminal") => {
                    string(&response["data"], 4096, false)
                        && optional(response, "size", |v| {
                            v.is_object()
                                && ["cols", "rows"]
                                    .iter()
                                    .all(|k| v[*k].as_i64().is_some_and(|n| (1..=500).contains(&n)))
                        })
                }
                Some("credentials") => response["values"].as_object().is_some_and(|v| {
                    v.len() <= 16
                        && v.iter()
                            .all(|(k, v)| id(&Value::String(k.clone())) && string(v, 16384, false))
                }),
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    #[tokio::test]
    async fn reconnect_uses_selected_profile_hints() {
        use crate::codex_credential_store::{CredentialStore, Credentials, Registration};
        let dir = std::env::temp_dir().join(format!("provider-hints-{}", uuid::Uuid::new_v4()));
        let store = CredentialStore::new(&dir, "managed").unwrap();
        store
            .save_registration(Registration {
                client_id: "oaiapp_saved".into(),
                subject: Some("subject".into()),
                email: Some("saved@example.test".into()),
                connection_label: None,
                sharing_enabled: Some(false),
                redirect_uri: None,
            })
            .await
            .unwrap();
        store
            .save(Credentials {
                client_id: "oaiapp_saved".into(),
                access_token: "access".into(),
                refresh_token: Some("refresh".into()),
                expires_at: 1000,
                earliest_refresh_at: None,
                scopes: vec![],
                subject: "subject".into(),
                email: Some("saved@example.test".into()),
                id_token: Some("saved-id".into()),
                issuer: None,
            })
            .await
            .unwrap();
        let flows = ManagedFlows::for_test();
        let state = flows.dispatch("provider.auth.start", &json!({"instanceId":"managed", "callbackMode":"client", "methodId":"chatgpt-profile:oaiapp_saved"}), "owner", "host", &dir).await.unwrap();
        let url = url::Url::parse(state["authorizationUrl"].as_str().unwrap()).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params.get("login_hint").unwrap(), "saved@example.test");
        assert_eq!(params.get("id_token_hint").unwrap(), "saved-id");
        assert_eq!(params.get("prompt").unwrap(), "consent");
        assert!(!params.contains_key("agent_name_hint"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn logout_cancels_flow_and_removes_active_credential() {
        use crate::codex_credential_store::{CredentialStore, Credentials};
        let dir = std::env::temp_dir().join(format!("provider-logout-{}", uuid::Uuid::new_v4()));
        let store = CredentialStore::new(&dir, "managed").unwrap();
        store
            .save(Credentials {
                client_id: "oaiapp_test".into(),
                access_token: "secret".into(),
                refresh_token: Some("refresh".into()),
                expires_at: 1000,
                earliest_refresh_at: None,
                scopes: vec![],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        let flows = ManagedFlows::for_test();
        let start = flows
            .dispatch(
                "provider.auth.start",
                &json!({"instanceId":"managed","callbackMode":"client"}),
                "owner",
                "host",
                &dir,
            )
            .await
            .unwrap();
        let id = start["flowId"].as_str().unwrap();
        assert_eq!(
            flows
                .dispatch(
                    "provider.auth.respond",
                    &json!({"instanceId":"managed","flowId":id}),
                    "other",
                    "host",
                    &dir
                )
                .await
                .unwrap_err(),
            "inactive"
        );
        assert_eq!(
            flows
                .dispatch(
                    "provider.auth.respond",
                    &json!({"instanceId":"managed","flowId":id}),
                    "owner",
                    "host",
                    &dir
                )
                .await
                .unwrap_err(),
            "interaction"
        );
        let state = flows
            .dispatch(
                "provider.auth.logout",
                &json!({"instanceId":"managed"}),
                "owner",
                "host",
                &dir,
            )
            .await
            .unwrap();
        assert_eq!(state["phase"], "idle");
        assert!(state["message"]
            .as_str()
            .unwrap()
            .contains("Remote revocation could not be confirmed"));
        assert!(store.read().await.unwrap().is_none());
        assert_eq!(
            flows
                .dispatch(
                    "provider.auth.cancel",
                    &json!({"instanceId":"managed","flowId":id}),
                    "owner",
                    "host",
                    &dir
                )
                .await
                .unwrap_err(),
            "inactive"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_each_operation_and_response_variant() {
        for (tag, payload) in [
            (
                "provider.auth.start",
                json!({"instanceId":"codex","callbackMode":"client"}),
            ),
            ("provider.auth.logout", json!({"instanceId":"codex"})),
            ("provider.auth.subscribe", json!({"instanceId":"codex"})),
            (
                "provider.auth.cancel",
                json!({"instanceId":"codex","flowId":"f"}),
            ),
            (
                "provider.auth.removeMethod",
                json!({"instanceId":"codex","methodId":"m"}),
            ),
            (
                "provider.auth.complete",
                json!({"instanceId":"codex","flowId":"f","callbackUrl":"url"}),
            ),
            (
                "provider.chatgpt.reconnect-profile",
                json!({"instanceId":"codex","methodId":""}),
            ),
            (
                "provider.auth.respond",
                json!({"instanceId":"codex","flowId":"f","interactionId":"i","response":{"type":"browser","action":"accept"}}),
            ),
            (
                "provider.auth.respond",
                json!({"instanceId":"codex","flowId":"f","interactionId":"i","response":{"type":"terminal","data":"","size":{"cols":80,"rows":24}}}),
            ),
            (
                "provider.auth.respond",
                json!({"instanceId":"codex","flowId":"f","interactionId":"i","response":{"type":"credentials","values":{"key":"value"}}}),
            ),
            (
                "provider.chatgpt.import-profile",
                json!({"instanceId":"codex","profile":{"registration":{"clientId":"oaiapp_test"},"credentials":{"clientId":"x","accessToken":"x","refreshToken":null,"idToken":"x","issuer":"x","expiresAt":1,"earliestRefreshAt":null,"scopes":[],"subject":"x","email":null}}}),
            ),
        ] {
            assert!(validate(tag, &payload), "{tag}");
            assert!(!validate(tag, &json!({"instanceId":"!bad"})), "{tag}");
        }
        assert!(!validate(
            "provider.auth.start",
            &json!({"instanceId":"codex","callbackMode":"other"})
        ));
        assert!(!validate(
            "provider.auth.complete",
            &json!({"instanceId":"codex","flowId":"f","callbackUrl":" "})
        ));
        assert!(!validate(
            "provider.auth.respond",
            &json!({"instanceId":"codex","flowId":"f","interactionId":"i","response":{"type":"terminal","data":"x","size":{"cols":0,"rows":24}}})
        ));
        assert!(!validate(
            "provider.chatgpt.import-profile",
            &json!({"instanceId":"codex","profile":{}})
        ));
    }
}

/// Managed flow registry. Kept separate from provider capability discovery until
/// managed credentials can also be supplied to provider processes.
#[derive(Default)]
pub struct ManagedFlows {
    discovery: tokio::sync::OnceCell<crate::codex_oauth::Discovery>,
    controllers:
        tokio::sync::Mutex<std::collections::HashMap<String, crate::codex_oauth::AuthController>>,
}
impl ManagedFlows {
    pub async fn render_state(
        state: &crate::codex_oauth::AuthState,
        instance: &str,
        secrets: &Path,
    ) -> Result<Value, &'static str> {
        let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
            .map_err(|_| "storage")?;
        let (mut profiles, sessions, current) =
            store.profile_snapshot().await.map_err(|_| "storage")?;
        if let Some(index) = profiles
            .iter()
            .position(|p| Some(&p.client_id) == current.as_ref())
        {
            let profile = profiles.remove(index);
            profiles.insert(0, profile);
        }
        let email = profiles
            .first()
            .filter(|p| Some(&p.client_id) == current.as_ref())
            .and_then(|p| p.email.as_ref());
        let mut first = json!({"id":"chatgpt", "name":"Sign in with ChatGPT", "description":email.map(|e| format!("Reconnect {e}.")), "type":"agent"});
        if let Some(email) = email {
            first["accountEmail"] = json!(email);
        }
        let mut methods = vec![
            first,
            json!({"id":"chatgpt-change-account", "name":"Use a different ChatGPT account", "description":"Register a connection for another ChatGPT account.", "type":"agent"}),
        ];
        for profile in profiles.into_iter().take(30) {
            let mut method = json!({"id":format!("chatgpt-profile:{}", profile.client_id), "canRemove":profile.subject.is_none() && !sessions.iter().any(|s| s.client_id == profile.client_id), "name":format!("{} · {}", profile.email.as_deref().unwrap_or("ChatGPT account"), profile.connection_label.as_deref().unwrap_or("Connection")), "description":"Reuse this account's original sign-in registration.", "type":"agent"});
            if let Some(email) = profile.email {
                method["accountEmail"] = json!(email);
            }
            methods.push(method);
        }
        let mut value = state.to_provider_state(instance);
        value["methods"] = json!(methods);
        Ok(value)
    }
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self {
            discovery: tokio::sync::OnceCell::new_with(Some(
                crate::codex_oauth::Discovery::test_discovery(),
            )),
            controllers: Default::default(),
        }
    }
    async fn controller(
        &self,
        instance: &str,
    ) -> Result<crate::codex_oauth::AuthController, &'static str> {
        let mut controllers = self.controllers.lock().await;
        if let Some(controller) = controllers.get(instance) {
            return Ok(controller.clone());
        }
        let discovery = self
            .discovery
            .get_or_try_init(crate::codex_oauth::Discovery::production)
            .await?
            .clone();
        let controller =
            crate::codex_oauth::AuthController::new(discovery, std::time::Duration::from_secs(300));
        controllers.insert(instance.to_owned(), controller.clone());
        Ok(controller)
    }
    pub fn managed(payload: &Value, settings: &Path) -> bool {
        if crate::managed_policy::check_provider_allowed("codex").is_err() {
            return false;
        }
        let id = payload["instanceId"].as_str().unwrap_or("");
        crate::provider::session_registry::read_provider_settings(Some(settings))
            .ok()
            .and_then(|s| s.get("providerInstances").and_then(|v| v.get(id)).cloned())
            .is_some_and(|v| v["driver"] == "codex" && v["config"]["setupMode"] == "managed")
    }
    pub async fn set_retirement_hook(
        &self,
        instance: &str,
        hook: crate::codex_oauth::RetirementHook,
    ) -> Result<(), &'static str> {
        self.controller(instance).await?.set_retirement_hook(hook);
        Ok(())
    }
    pub async fn dispatch(
        &self,
        tag: &str,
        payload: &Value,
        owner: &str,
        host_id: &str,
        secrets: &Path,
    ) -> Result<Value, &'static str> {
        let instance = payload["instanceId"].as_str().ok_or("invalid")?;
        let controller = self.controller(instance).await?;
        let state = match tag {
            "provider.auth.start" => {
                if payload.get("returnUrl").is_some() {
                    return Err("return_url");
                }
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                let (profiles, sessions, current) =
                    store.profile_snapshot().await.map_err(|_| "storage")?;
                let method = payload["methodId"].as_str().unwrap_or("chatgpt");
                let selected = match method {
                    "chatgpt-change-account" => None,
                    "chatgpt" => current
                        .as_deref()
                        .and_then(|id| profiles.iter().find(|p| p.client_id == id)),
                    id => {
                        let id = id.strip_prefix("chatgpt-profile:").ok_or("method")?;
                        Some(
                            profiles
                                .iter()
                                .find(|p| p.client_id == id)
                                .ok_or("method")?,
                        )
                    }
                };
                // Legacy localhost registrations require a new registration on reauthentication.
                let client = selected
                    .filter(|p| {
                        !p.redirect_uri
                            .as_deref()
                            .is_some_and(|uri| uri.contains("//localhost:"))
                    })
                    .map(|p| p.client_id.as_str());
                let tokens = client.and_then(|id| sessions.iter().find(|s| s.client_id == id));
                let hints = crate::codex_oauth::AuthorizationHints {
                    email: client.and_then(|_| selected.and_then(|p| p.email.as_deref())),
                    id_token: tokens.and_then(|s| s.id_token.as_deref()),
                    consent: client.is_some()
                        && (selected.is_some_and(|p| p.sharing_enabled == Some(false))
                            || tokens.is_some_and(|s| {
                                !s.scopes
                                    .iter()
                                    .any(|scope| scope == "chatgpt.tokens.use.direct")
                            })),
                };
                if payload["callbackMode"] == "client" {
                    controller
                        .start_client_callback_with_hints(owner, host_id, client, &hints)
                        .await?
                } else {
                    controller
                        .start_loopback_with_hints(owner, host_id, client, store, &hints)
                        .await?
                }
            }
            "provider.auth.logout" => {
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                controller.logout_durable(store).await?
            }
            "provider.auth.respond" => {
                controller.respond(owner, payload["flowId"].as_str().ok_or("invalid")?)?
            }
            "provider.auth.removeMethod" => {
                let id = payload["methodId"]
                    .as_str()
                    .and_then(|v| v.strip_prefix("chatgpt-profile:"))
                    .ok_or("remove_method")?;
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                store
                    .remove_registration(id)
                    .await
                    .map_err(|_| "remove_method")?;
                controller.profiles_changed();
                controller.snapshot(owner)
            }
            "provider.chatgpt.import-profile" => {
                let registration: crate::codex_credential_store::Registration =
                    serde_json::from_value(payload["profile"]["registration"].clone())
                        .map_err(|_| "import")?;
                let credentials: crate::codex_credential_store::Credentials =
                    serde_json::from_value(payload["profile"]["credentials"].clone())
                        .map_err(|_| "import")?;
                self.discovery
                    .get_or_try_init(crate::codex_oauth::Discovery::production)
                    .await?
                    .verify_import(&registration, &credentials)
                    .await?;
                let _retirement = controller.retire_sessions().await?;
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                controller
                    .adopt_profile(&store, registration, credentials, owner)
                    .await?
            }
            "provider.chatgpt.reconnect-profile" => {
                let method = payload["methodId"].as_str().ok_or("invalid")?;
                if method == "chatgpt-change-account" {
                    return Ok(Value::Null);
                }
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                let (registrations, sessions, current) =
                    store.profile_snapshot().await.map_err(|_| "storage")?;
                let explicit = method.strip_prefix("chatgpt-profile:");
                let selected = explicit
                    .or(current.as_deref())
                    .or_else(|| registrations.first().map(|p| p.client_id.as_str()));
                let Some(profile) =
                    selected.and_then(|id| registrations.iter().find(|p| p.client_id == id))
                else {
                    return if explicit.is_some() {
                        Err("profile_missing")
                    } else {
                        Ok(Value::Null)
                    };
                };
                let mut profile = serde_json::to_value(profile).map_err(|_| "storage")?;
                if let Some(token) = sessions
                    .iter()
                    .find(|c| Some(c.client_id.as_str()) == selected)
                    .and_then(|c| c.id_token.as_ref())
                {
                    profile["idTokenHint"] = json!(token);
                }
                return Ok(profile);
            }
            "provider.auth.cancel" => {
                controller.cancel(owner, payload["flowId"].as_str().ok_or("invalid")?)?
            }
            "provider.auth.complete" => {
                let store = crate::codex_credential_store::CredentialStore::new(secrets, instance)
                    .map_err(|_| "storage")?;
                controller
                    .complete(
                        owner,
                        payload["flowId"].as_str().ok_or("invalid")?,
                        payload["callbackUrl"].as_str().ok_or("invalid")?,
                        &store,
                    )
                    .await?
            }
            _ => return Err("unsupported"),
        };
        Self::render_state(&state, instance, secrets).await
    }
    pub async fn subscribe(
        &self,
        instance: &str,
        owner: &str,
    ) -> Result<crate::codex_oauth::AuthSubscription, &'static str> {
        Ok(self.controller(instance).await?.subscribe(owner))
    }
}

pub fn managed_error(tag: &str, instance: &str, cause: &str) -> Value {
    let detail = match cause {
        "busy" => "Sign-in is in progress in another client.",
        "inactive" => "This sign-in is no longer active.",
        "callback" => "This response does not belong to the active sign-in.",
        "method" => "This sign-in method is not available.",
        "interaction" => "This sign-in interaction is no longer available.",
        "remove_method" => "Only incomplete ChatGPT connections can be removed.",
        "import" => {
            "The transferred ChatGPT connection is invalid, expired, or could not be verified."
        }
        "profile_missing" => "This saved connection is no longer available.",
        "return_url" => "Sign-in return URLs are not supported by this server.",
        "unsupported" => "This sign-in operation is not supported by this server.",
        "storage" => "Could not save provider sign-in.",
        "stop_sessions" => "Could not stop all sessions for this provider. Try again.",
        _ => "Could not complete provider sign-in. Try again.",
    };
    let operation = match tag {
        "provider.chatgpt.reconnect-profile" => "export",
        "provider.chatgpt.import-profile" => "import",
        _ => tag.rsplit('.').next().unwrap_or("unknown"),
    };
    json!({"_tag":"ProviderSetupError", "instanceId":instance, "operation":operation, "detail":detail})
}
