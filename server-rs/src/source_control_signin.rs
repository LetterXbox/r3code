//! Device-flow sign-in for the built-in GitHub App.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Notify};

#[derive(Default)]
pub(crate) struct SignIns {
    pending: Mutex<HashMap<String, Arc<Pending>>>,
}
struct Pending {
    result: watch::Sender<Option<Result<String, Value>>>,
    cancel: Notify,
}
fn fail(provider: &str, host: &str, reason: &str, detail: &str) -> Value {
    json!({"_tag":"SourceControlSignInError","provider":provider,"host":host,"reason":reason,"detail":detail})
}
fn github_only(provider: &str, host: &str) -> Result<(), Value> {
    if provider != "github" {
        return Err(fail(
            provider,
            host,
            "unsupported",
            &format!("This server cannot sign in to {provider}. Use a token or the host's CLI."),
        ));
    }
    Ok(())
}
fn client() -> Result<reqwest::Client, ()> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("t3code");
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        if let Ok(pem) = std::fs::read(path) {
            if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                builder = builder.add_root_certificate(cert);
            }
        }
    }
    builder.build().map_err(|_| ())
}
async fn post(client: &reqwest::Client, path: &str, fields: &[(&str, &str)]) -> Result<Value, ()> {
    let mut response = client
        .post(format!("https://github.com{path}"))
        .header("Accept", "application/json")
        .form(fields)
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}
impl SignIns {
    pub async fn start(
        self: &Arc<Self>,
        provider: &str,
        raw_host: &str,
        settings: Arc<crate::settings::Settings>,
    ) -> Result<Value, Value> {
        github_only(provider, raw_host)?;
        let host = raw_host.trim().to_ascii_lowercase();
        let client_id = std::env::var("T3CODE_GITHUB_APP_CLIENT_ID").unwrap_or_default();
        let client_id = client_id.trim().to_owned();
        if client_id.is_empty() {
            return Err(fail(
                "github",
                &host,
                "unsupported",
                "This server is not set up to sign in with T3 Code for GitHub.",
            ));
        }
        if host != "github.com" {
            return Err(fail("github",&host,"unsupported",&format!("T3 Code for GitHub only signs in to github.com. Use a token or the GitHub CLI for {host}.")));
        }
        let http = client().map_err(|_| {
            fail(
                "github",
                &host,
                "failed",
                "The server could not reach GitHub to start the sign-in.",
            )
        })?;
        let code = post(&http, "/login/device/code", &[("client_id", &client_id)])
            .await
            .map_err(|_| {
                fail(
                    "github",
                    &host,
                    "failed",
                    "The server could not reach GitHub to start the sign-in.",
                )
            })?;
        let device = code["device_code"].as_str();
        let user = code["user_code"].as_str();
        let uri = code["verification_uri"].as_str();
        let expires = code["expires_in"].as_i64();
        let (Some(device), Some(user), Some(uri), Some(expires)) = (device, user, uri, expires)
        else {
            return Err(fail(
                "github",
                &host,
                "failed",
                code["error_description"]
                    .as_str()
                    .unwrap_or("GitHub would not start the sign-in (no reason given)."),
            ));
        };
        let expires_at = chrono::Utc::now()
            .timestamp_millis()
            .saturating_add(expires.saturating_mul(1000));
        let interval = code["interval"].as_u64().unwrap_or(5);
        let device = device.to_owned();
        let (sender, _) = watch::channel(None);
        let pending = Arc::new(Pending {
            result: sender,
            cancel: Notify::new(),
        });
        if let Some(previous) = self
            .pending
            .lock()
            .map_err(|_| {
                fail(
                    "github",
                    &host,
                    "failed",
                    "The sign-in could not be started.",
                )
            })?
            .insert(host.clone(), pending.clone())
        {
            previous.result.send_replace(Some(Err(fail(
                "github",
                &host,
                "failed",
                "A newer sign-in replaced this one.",
            ))));
            previous.cancel.notify_one();
        }
        let manager = self.clone();
        let current = pending.clone();
        let poll_host = host.clone();
        tokio::spawn(async move {
            let mut delay = interval;
            loop {
                tokio::select! {biased; _=current.cancel.notified()=>return, _=tokio::time::sleep(Duration::from_secs(delay))=>{}}
                let now = chrono::Utc::now().timestamp_millis();
                if now >= expires_at {
                    current.result.send_replace(Some(Err(fail(
                        "github",
                        &poll_host,
                        "expired",
                        "The sign-in code expired. Start again.",
                    ))));
                    return;
                }
                let fields = [
                    ("client_id", client_id.as_str()),
                    ("device_code", device.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ];
                let request = post(&http, "/login/oauth/access_token", &fields);
                let answer = tokio::select! {biased; _=current.cancel.notified()=>return, result=request=>result};
                let Ok(answer) = answer else { continue };
                if let Some(token) = answer["access_token"].as_str() {
                    let expires = |key: &str| {
                        answer[key]
                            .as_i64()
                            .and_then(|v| v.checked_mul(1000))
                            .and_then(|v| now.checked_add(v))
                    };
                    let session=json!({"accessToken":token,"accessTokenExpiresAt":expires("expires_in"),"refreshToken":answer["refresh_token"].as_str(),"refreshTokenExpiresAt":expires("refresh_token_expires_in")}).to_string();
                    let Ok(guard) = manager.pending.lock() else {
                        return;
                    };
                    if !guard
                        .get(&poll_host)
                        .is_some_and(|entry| Arc::ptr_eq(entry, &current))
                        || current.result.borrow().is_some()
                    {
                        return;
                    }
                    let patch =
                        json!({"sourceControlHosts":{"github":{"signIns":{&poll_host:session}}}});
                    let result = settings
                        .update_typed(&patch)
                        .map(|_| token.to_owned())
                        .map_err(|_| {
                            fail(
                                "github",
                                &poll_host,
                                "failed",
                                "The server could not save the sign-in.",
                            )
                        });
                    if result.is_ok() {
                        crate::source_control_lookup::clear_github_app_refusals(&settings);
                    }
                    current.result.send_replace(Some(result));
                    return;
                }
                match answer["error"].as_str() {
                    Some("authorization_pending") => {}
                    Some("slow_down") => {
                        delay = answer["interval"]
                            .as_u64()
                            .unwrap_or(delay.saturating_add(5))
                    }
                    Some("expired_token") => {
                        current.result.send_replace(Some(Err(fail(
                            "github",
                            &poll_host,
                            "expired",
                            "The sign-in code expired. Start again.",
                        ))));
                        return;
                    }
                    Some("access_denied") => {
                        current.result.send_replace(Some(Err(fail(
                            "github",
                            &poll_host,
                            "denied",
                            "The sign-in was cancelled on GitHub.",
                        ))));
                        return;
                    }
                    other => {
                        let detail = answer["error_description"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!(
                                    "GitHub refused the sign-in ({}).",
                                    other.unwrap_or("no reason given")
                                )
                            });
                        current
                            .result
                            .send_replace(Some(Err(fail("github", &poll_host, "failed", &detail))));
                        return;
                    }
                }
            }
        });
        Ok(json!({"userCode":user,"verificationUri":uri,"expiresAt":expires_at}))
    }
    pub async fn wait(
        &self,
        provider: &str,
        raw_host: &str,
        settings: Arc<crate::settings::Settings>,
    ) -> Result<Value, Value> {
        github_only(provider, raw_host)?;
        let host = raw_host.trim().to_ascii_lowercase();
        let entry = self
            .pending
            .lock()
            .map_err(|_| fail("github", &host, "failed", "The sign-in could not be read."))?
            .get(&host)
            .cloned()
            .ok_or_else(|| {
                fail(
                    "github",
                    &host,
                    "not-started",
                    "No sign-in is in progress. Start again.",
                )
            })?;
        let mut receiver = entry.result.subscribe();
        loop {
            let value = receiver.borrow_and_update().clone();
            if let Some(result) = value {
                result?;
                break;
            }
            receiver
                .changed()
                .await
                .map_err(|_| fail("github", &host, "failed", "The sign-in could not be read."))?;
        }
        crate::source_control_lookup::invalidate_github_app_access(&settings);
        let settings_for_token = settings.clone();
        let host_for_token = host.clone();
        let token = tokio::task::spawn_blocking(move || {
            let client = std::env::var("T3CODE_GITHUB_APP_CLIENT_ID").unwrap_or_default();
            if client.trim().is_empty() {
                return None;
            }
            crate::source_control_lookup::github_app_token(
                &settings_for_token,
                &host_for_token,
                client.trim(),
            )
            .ok()
            .flatten()
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            let mut error=fail("github",&host,"failed","Signed in, but GitHub would not say which account it belongs to.");
            error["cause"]=json!({"name":"GitHubApiAuthenticationError","message":format!("GitHub refused the credential for {host}. Run `gh auth login --hostname {host}` and retry.")});
            error
        })?;
        let http = client().map_err(|_| {
            fail(
                "github",
                &host,
                "failed",
                "Signed in, but GitHub would not say which account it belongs to.",
            )
        })?;
        let mut response = http
            .get("https://api.github.com/user")
            .header("Accept", "application/vnd.github+json")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| {
                fail(
                    "github",
                    &host,
                    "failed",
                    "Signed in, but GitHub would not say which account it belongs to.",
                )
            })?;
        if !response.status().is_success() {
            if response.status().as_u16() == 401 {
                crate::source_control_lookup::reject_github_app_token(&settings, &token);
            }
            return Err(fail(
                "github",
                &host,
                "failed",
                "Signed in, but GitHub would not say which account it belongs to.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            fail(
                "github",
                &host,
                "failed",
                "Signed in, but GitHub would not say which account it belongs to.",
            )
        })? {
            if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
                return Err(fail(
                    "github",
                    &host,
                    "failed",
                    "Signed in, but GitHub would not say which account it belongs to.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            fail(
                "github",
                &host,
                "failed",
                "Signed in, but GitHub would not say which account it belongs to.",
            )
        })?;
        let account = value["login"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                fail(
                    "github",
                    &host,
                    "failed",
                    "Signed in, but GitHub would not say which account it belongs to.",
                )
            })?;
        Ok(json!({"account":account}))
    }
    pub fn cancel(&self, provider: &str, raw_host: &str) -> Result<Value, Value> {
        github_only(provider, raw_host)?;
        let host = raw_host.trim().to_ascii_lowercase();
        if let Some(entry) = self
            .pending
            .lock()
            .map_err(|_| {
                fail(
                    "github",
                    &host,
                    "failed",
                    "The sign-in could not be cancelled.",
                )
            })?
            .get(&host)
        {
            if entry.result.borrow().is_none() {
                entry.result.send_replace(Some(Err(fail(
                    "github",
                    &host,
                    "cancelled",
                    "The sign-in was cancelled.",
                ))));
                entry.cancel.notify_one();
            }
        }
        Ok(Value::Null)
    }
}
