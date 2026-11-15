//! Security-critical pieces of the managed Codex OAuth client.
//! Credentials are returned to the caller only after OIDC verification.
//! The controller manages one owner-scoped flow and commits verified credentials;
//! an optional loopback listener handles browser redirects.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
const MAX_RESPONSE: usize = 256 * 1024;

fn http_client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| "http")
}
async fn read_json(
    response: reqwest::Response,
    stage: &'static str,
) -> Result<Value, &'static str> {
    if !response.status().is_success() {
        return Err(stage);
    }
    read_json_body(response, stage).await
}
async fn read_json_body(
    mut response: reqwest::Response,
    stage: &'static str,
) -> Result<Value, &'static str> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(stage);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| stage)? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(stage);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| stage)
}
const RESOURCE: &str = "https://api.openai.com/v1";

#[derive(Clone, Debug)]
pub struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
}

impl Discovery {
    #[cfg(test)]
    pub(crate) fn test_discovery() -> Self {
        Self {
            issuer: "http://127.0.0.1".into(),
            authorization_endpoint: "http://127.0.0.1/authorize".into(),
            token_endpoint: "http://127.0.0.1/token".into(),
            jwks_uri: "http://127.0.0.1/keys".into(),
            revocation_endpoint: None,
        }
    }
    /// Load the pinned production issuer configuration.
    pub async fn production() -> Result<Self, &'static str> {
        Self::fetch(DISCOVERY_URL, true).await
    }

    pub async fn verify_import(
        &self,
        registration: &crate::codex_credential_store::Registration,
        credentials: &crate::codex_credential_store::Credentials,
    ) -> Result<(), &'static str> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "import")?
            .as_millis();
        if credentials.client_id != registration.client_id
            || credentials.issuer.as_deref() != Some(&self.issuer)
            || !credentials
                .scopes
                .iter()
                .any(|s| s == "chatgpt.tokens.use.direct")
            || credentials.expires_at <= i64::try_from(now).map_err(|_| "import")?
        {
            return Err("import");
        }
        let keys = read_json(
            http_client()?
                .get(&self.jwks_uri)
                .send()
                .await
                .map_err(|_| "import")?,
            "import",
        )
        .await?;
        let claims = verify_id_token_inner(
            credentials.id_token.as_deref().ok_or("import")?,
            &keys,
            &self.issuer,
            &credentials.client_id,
            None,
        )
        .map_err(|_| "import")?;
        if claims["sub"].as_str() != Some(&credentials.subject)
            || registration.subject.as_deref() != Some(&credentials.subject)
            || claims["email"].as_str() != credentials.email.as_deref()
            || registration
                .email
                .as_ref()
                .is_some_and(|email| Some(email) != credentials.email.as_ref())
        {
            return Err("import");
        }
        Ok(())
    }

    /// Return the current credential, renewing it under the store's rotation lock.
    pub async fn access(
        &self,
        store: &crate::codex_credential_store::CredentialStore,
        now_ms: i64,
    ) -> Result<crate::codex_credential_store::Credentials, crate::codex_credential_store::StoreError>
    {
        self.access_for_profile(store, now_ms, None).await
    }

    pub async fn access_for_profile(
        &self,
        store: &crate::codex_credential_store::CredentialStore,
        now_ms: i64,
        expected_profile: Option<&str>,
    ) -> Result<crate::codex_credential_store::Credentials, crate::codex_credential_store::StoreError>
    {
        use crate::codex_credential_store::StoreError;
        store
            .access_or_refresh_for_profile(now_ms, expected_profile, |mut old| async move {
                let response = http_client()
                    .map_err(|_| StoreError::Refresh)?
                    .post(&self.token_endpoint)
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", old.client_id.as_str()),
                        (
                            "refresh_token",
                            old.refresh_token.as_deref().ok_or(StoreError::Refresh)?,
                        ),
                        ("resource", RESOURCE),
                    ])
                    .send()
                    .await
                    .map_err(|_| StoreError::Refresh)?;
                let success = response.status().is_success();
                let token = read_json_body(response, "refresh")
                    .await
                    .map_err(|_| StoreError::Refresh)?;
                if !success {
                    return Err(match token["error"].as_str() {
                        Some(
                            "invalid_grant"
                            | "invalid_refresh_token"
                            | "token_expired"
                            | "refresh_token_expired"
                            | "refresh_token_invalidated"
                            | "refresh_token_reused",
                        ) => StoreError::RefreshRevoked,
                        Some("invalid_client") => StoreError::Client,
                        _ => StoreError::Refresh,
                    });
                }
                let nonempty = |key: &str| {
                    token[key]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                };
                if !token["token_type"]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
                {
                    return Err(StoreError::Invalid);
                }
                old.access_token = nonempty("access_token").ok_or(StoreError::Invalid)?;
                old.refresh_token = Some(nonempty("refresh_token").ok_or(StoreError::Invalid)?);
                let lifetime = token["expires_in"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or(StoreError::Invalid)?;
                old.expires_at = i64::try_from(lifetime)
                    .ok()
                    .and_then(|n| n.checked_mul(1000))
                    .and_then(|n| now_ms.checked_add(n))
                    .ok_or(StoreError::Invalid)?;
                old.earliest_refresh_at = match token.get("earliest_refresh_at") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(
                        v.as_i64()
                            .and_then(|n| n.checked_mul(1000))
                            .ok_or(StoreError::Invalid)?,
                    ),
                };
                old.scopes = token["scope"]
                    .as_str()
                    .ok_or(StoreError::Invalid)?
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect();
                Ok(old)
            })
            .await
    }
    /// Production metadata is pinned to the OpenAI issuer and origin.
    async fn fetch(url: &str, production: bool) -> Result<Self, &'static str> {
        if production && url != DISCOVERY_URL {
            return Err("discover");
        }
        let client = http_client().map_err(|_| "discover")?;
        let v = read_json(
            client.get(url).send().await.map_err(|_| "discover")?,
            "discover",
        )
        .await?;
        let field = |k: &str| {
            v[k].as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or("discover")
        };
        let d = Self {
            issuer: field("issuer")?,
            authorization_endpoint: field("authorization_endpoint")?,
            token_endpoint: field("token_endpoint")?,
            jwks_uri: field("jwks_uri")?,
            revocation_endpoint: v
                .get("revocation_endpoint")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        };
        if production
            && (d.issuer != "https://auth.openai.com"
                || [&d.authorization_endpoint, &d.token_endpoint, &d.jwks_uri]
                    .into_iter()
                    .chain(d.revocation_endpoint.iter())
                    .any(|s| {
                        Url::parse(s).map_or(true, |u| {
                            u.origin().ascii_serialization() != d.issuer
                                || !u.username().is_empty()
                                || u.password().is_some()
                        })
                    }))
        {
            return Err("discover");
        }
        Ok(d)
    }
}

#[derive(Default)]
pub struct AuthorizationHints<'a> {
    pub email: Option<&'a str>,
    pub id_token: Option<&'a str>,
    pub consent: bool,
}

/// One-use authorization request. Keep this private to the initiating client.
pub struct Flow {
    pub state: String,
    pub nonce: String,
    verifier: String,
    pub redirect_uri: String,
    expected_client_id: Option<String>,
}
impl Flow {
    pub fn new(redirect_uri: String) -> Result<Self, &'static str> {
        let u = Url::parse(&redirect_uri).map_err(|_| "redirect")?;
        if u.scheme() != "http"
            || u.host_str() != Some("127.0.0.1")
            || u.port().is_none()
            || u.path() != "/auth/callback"
            || u.query().is_some()
            || u.fragment().is_some()
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err("redirect");
        }
        fn random(n: usize) -> Result<String, &'static str> {
            let mut b = vec![0; n];
            getrandom::fill(&mut b).map_err(|_| "random")?;
            Ok(URL_SAFE_NO_PAD.encode(b))
        }
        Ok(Self {
            state: random(32)?,
            nonce: random(32)?,
            verifier: random(64)?,
            redirect_uri,
            expected_client_id: None,
        })
    }
    pub fn authorization_url(
        &self,
        d: &Discovery,
        host_id: &str,
        client_id: Option<&str>,
    ) -> Result<String, &'static str> {
        self.authorization_url_with_hints(d, host_id, client_id, &AuthorizationHints::default())
    }
    pub fn authorization_url_with_hints(
        &self,
        d: &Discovery,
        host_id: &str,
        client_id: Option<&str>,
        hints: &AuthorizationHints<'_>,
    ) -> Result<String, &'static str> {
        let mut u = Url::parse(&d.authorization_endpoint).map_err(|_| "discover")?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        u.query_pairs_mut()
            .clear()
            .append_pair("client_id", client_id.unwrap_or("dynamic_agent_client"))
            .append_pair("ext_agent_host_id", host_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &self.state)
            .append_pair("nonce", &self.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &challenge);
        {
            let mut query = u.query_pairs_mut();
            if client_id.is_some() {
                if let Some(email) = hints.email {
                    query.append_pair("login_hint", email);
                }
                if let Some(token) = hints.id_token {
                    query.append_pair("id_token_hint", token);
                }
                if hints.consent {
                    query.append_pair("prompt", "consent");
                }
            } else {
                query.append_pair("agent_name_hint", "T3 Code");
            }
        }
        Ok(u.into())
    }
    pub fn callback(&self, value: &str) -> Result<(String, String), &'static str> {
        if value.len() > 16384 {
            return Err("callback");
        }
        let s = value.trim_start();
        let owned;
        let s = if s.contains("://") {
            s
        } else {
            owned = format!("http://{s}");
            &owned
        };
        let u = Url::parse(s).map_err(|_| "callback")?;
        let expected = Url::parse(&self.redirect_uri).map_err(|_| "callback")?;
        if u.origin() != expected.origin()
            || u.path() != expected.path()
            || !u.username().is_empty()
            || u.password().is_some()
            || u.fragment().is_some()
        {
            return Err("callback");
        }
        let vals = |key: &str| {
            u.query_pairs()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned())
                .collect::<Vec<_>>()
        };
        let states = vals("state");
        let codes = vals("code");
        let errors = vals("error");
        let clients = vals("client_id");
        if states != [self.state.clone()]
            || codes.len() != 1
            || codes[0].is_empty()
            || !errors.is_empty()
            || clients.len() > 1
        {
            return Err("callback");
        }
        let client = match (&self.expected_client_id, clients.first()) {
            (Some(expected), Some(actual)) if expected == actual => expected.clone(),
            (Some(expected), None) => expected.clone(),
            (None, Some(actual)) if valid_client(actual) => actual.clone(),
            _ => return Err("callback"),
        };
        Ok((codes[0].clone(), client))
    }
    pub async fn exchange(self, d: &Discovery, callback: &str) -> Result<Value, &'static str> {
        Ok(self.exchange_verified(d, callback).await?.0)
    }
    async fn exchange_verified(
        self,
        d: &Discovery,
        callback: &str,
    ) -> Result<(Value, Value, String), &'static str> {
        let (code, client_id) = self.callback(callback)?;
        let form = [
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("code", &code),
            ("code_verifier", &self.verifier),
            ("redirect_uri", &self.redirect_uri),
            ("resource", RESOURCE),
        ];
        let http = http_client().map_err(|_| "exchange")?;
        let token = read_json(
            http.post(&d.token_endpoint)
                .form(&form)
                .send()
                .await
                .map_err(|_| "exchange")?,
            "exchange",
        )
        .await?;
        if token["access_token"].as_str().is_none_or(|s| s.is_empty())
            || !token["token_type"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
            || token["expires_in"].as_u64().is_none_or(|n| n == 0)
            || !token["scope"].is_string()
        {
            return Err("exchange");
        }
        let jwt = token["id_token"].as_str().ok_or("verify")?;
        let jwks = read_json(
            http.get(&d.jwks_uri).send().await.map_err(|_| "verify")?,
            "verify",
        )
        .await?;
        let claims = verify_id_token(jwt, &jwks, &d.issuer, &client_id, &self.nonce)?;
        Ok((token, claims, client_id))
    }
}
fn valid_client(s: &str) -> bool {
    s.strip_prefix("oaiapp_").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

pub fn verify_id_token(
    token: &str,
    jwks: &Value,
    issuer: &str,
    audience: &str,
    nonce: &str,
) -> Result<Value, &'static str> {
    verify_id_token_inner(token, jwks, issuer, audience, Some(nonce))
}

fn verify_id_token_inner(
    token: &str,
    jwks: &Value,
    issuer: &str,
    audience: &str,
    nonce: Option<&str>,
) -> Result<Value, &'static str> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("verify");
    }
    let decode = |s| URL_SAFE_NO_PAD.decode(s).map_err(|_| "verify");
    let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| "verify")?;
    let claims: Value = serde_json::from_slice(&decode(parts[1])?).map_err(|_| "verify")?;
    let alg = header["alg"].as_str().ok_or("verify")?;
    let kid = header["kid"].as_str().ok_or("verify")?;
    let keys = jwks["keys"].as_array().ok_or("verify")?;
    let candidates: Vec<_> = keys
        .iter()
        .filter(|k| {
            k["kid"] == kid
                && (k.get("alg").is_none() || k["alg"] == alg)
                && (k.get("use").is_none() || k["use"] == "sig")
        })
        .collect();
    if candidates.len() != 1 {
        return Err("verify");
    }
    let key = candidates[0];
    let data = format!("{}.{}", parts[0], parts[1]);
    let sig = decode(parts[2])?;
    match alg {
        "RS256" if key["kty"] == "RSA" => {
            let n = decode(key["n"].as_str().ok_or("verify")?)?;
            let e = decode(key["e"].as_str().ok_or("verify")?)?;
            signature::RsaPublicKeyComponents { n: &n, e: &e }
                .verify(
                    &signature::RSA_PKCS1_2048_8192_SHA256,
                    data.as_bytes(),
                    &sig,
                )
                .map_err(|_| "verify")?;
        }
        "ES256" if key["kty"] == "EC" && key["crv"] == "P-256" => {
            let x = decode(key["x"].as_str().ok_or("verify")?)?;
            let y = decode(key["y"].as_str().ok_or("verify")?)?;
            if x.len() != 32 || y.len() != 32 {
                return Err("verify");
            }
            let mut point = vec![4];
            point.extend(x);
            point.extend(y);
            signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(data.as_bytes(), &sig)
                .map_err(|_| "verify")?;
        }
        _ => return Err("verify"),
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "verify")?
        .as_secs();
    let aud = claims["aud"].as_str() == Some(audience)
        || claims["aud"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(audience)));
    if claims["iss"] != issuer
        || !aud
        || nonce.is_some_and(|n| claims["nonce"] != n)
        || claims["sub"].as_str().is_none_or(|s| s.is_empty())
        || claims["exp"]
            .as_u64()
            .is_none_or(|exp| exp.saturating_add(5) <= now)
        || claims["nbf"]
            .as_u64()
            .is_some_and(|nbf| nbf > now.saturating_add(5))
    {
        return Err("verify");
    }
    Ok(claims)
}

/// A public snapshot contains no OAuth state, nonce, verifier, or tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthState {
    pub phase: &'static str,
    pub flow_id: Option<String>,
    pub authorization_url: Option<String>,
    pub expires_at: Option<std::time::SystemTime>,
    pub message: Option<&'static str>,
}
impl AuthState {
    fn idle() -> Self {
        Self {
            phase: "idle",
            flow_id: None,
            authorization_url: None,
            expires_at: None,
            message: None,
        }
    }
    /// Render the provider-auth state shape without including credential material.
    pub fn to_provider_state(&self, instance_id: &str) -> Value {
        let interaction = match (&self.flow_id, &self.authorization_url) {
            (Some(id), Some(url)) if self.phase == "waiting" => serde_json::json!({
                "type": "browser", "id": id, "url": url,
                "requiresConsent": false, "acceptsCallback": true
            }),
            _ => Value::Null,
        };
        let expires_at = self.expires_at.map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        serde_json::json!({
            "instanceId": instance_id, "phase": self.phase, "flowId": self.flow_id,
            "authorizationUrl": self.authorization_url, "expiresAt": expires_at,
            "message": self.message, "interaction": interaction, "credentialOwner": "t3",
            "methods": [{"id":"chatgpt", "name":"Sign in with ChatGPT", "description":null, "type":"agent"}]
        })
    }
}
struct ActiveFlow {
    owner: String,
    id: String,
    flow: Option<Flow>,
    expires: tokio::time::Instant,
    timer: Option<tokio::task::AbortHandle>,
}
impl Drop for ActiveFlow {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}
struct ControllerState {
    owner: Option<String>,
    state: AuthState,
    active: Option<ActiveFlow>,
}
struct ControllerInner {
    discovery: Discovery,
    timeout: std::time::Duration,
    state: std::sync::Mutex<ControllerState>,
    updates: tokio::sync::watch::Sender<u64>,
    retirement: std::sync::Mutex<Option<RetirementHook>>,
}
pub type RetirementHook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<tokio::sync::OwnedMutexGuard<()>, &'static str>,
                    > + Send,
            >,
        > + Send
        + Sync,
>;
/// A bounded, single-flow controller. Clone it to share ownership across requests.
#[derive(Clone)]
pub struct AuthController(std::sync::Arc<ControllerInner>);
/// A subscription produces the current snapshot first, then the latest changes.
/// Updates are coalesced, so slow subscribers cannot accumulate unbounded memory.
pub struct AuthSubscription {
    controller: AuthController,
    owner: String,
    updates: tokio::sync::watch::Receiver<u64>,
    initial: bool,
}
impl AuthController {
    /// Once requested, logout must finish even if its RPC connection disappears
    /// during remote revocation. The spawned task retains the store lock until
    /// local credentials are removed.
    pub async fn logout_durable(
        &self,
        store: crate::codex_credential_store::CredentialStore,
    ) -> Result<AuthState, &'static str> {
        let controller = self.clone();
        tokio::spawn(async move {
            let _retirement = controller.retire_sessions().await?;
            controller.logout(&store).await
        })
        .await
        .map_err(|_| "storage")?
    }

    pub fn new(discovery: Discovery, timeout: std::time::Duration) -> Self {
        let (updates, _) = tokio::sync::watch::channel(0);
        Self(std::sync::Arc::new(ControllerInner {
            discovery,
            timeout,
            updates,
            retirement: std::sync::Mutex::new(None),
            state: std::sync::Mutex::new(ControllerState {
                owner: None,
                state: AuthState::idle(),
                active: None,
            }),
        }))
    }
    pub fn set_retirement_hook(&self, hook: RetirementHook) {
        *self.0.retirement.lock().unwrap() = Some(hook);
    }
    pub(crate) async fn retire_sessions(
        &self,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, &'static str> {
        let hook = self.0.retirement.lock().unwrap().clone();
        match hook {
            Some(hook) => Ok(Some(hook().await?)),
            None => Ok(None),
        }
    }
    fn changed(&self) {
        self.0.updates.send_modify(|n| *n = n.wrapping_add(1));
    }
    pub(crate) fn profiles_changed(&self) {
        self.changed();
    }
    pub(crate) async fn adopt_profile(
        &self,
        store: &crate::codex_credential_store::CredentialStore,
        registration: crate::codex_credential_store::Registration,
        credentials: crate::codex_credential_store::Credentials,
        owner: &str,
    ) -> Result<AuthState, &'static str> {
        let _guard = store.lock().await.map_err(|_| "storage")?;
        let mut state = self.0.state.lock().unwrap();
        // Holding both locks excludes a callback from committing over the import.
        store
            .import_profile_locked(registration, credentials)
            .map_err(|_| "import")?;
        state.active = None;
        state.owner = Some(owner.to_owned());
        state.state = AuthState::idle();
        let result = state.state.clone();
        self.changed();
        Ok(result)
    }
    fn visible(state: &ControllerState, owner: &str) -> AuthState {
        let mut result = state.state.clone();
        if state.owner.as_deref().is_some_and(|o| o != owner) {
            result.flow_id = None;
            result.authorization_url = None;
            result.expires_at = None;
            if state.active.is_some() {
                result.message = Some("Sign-in is in progress in another client.");
            }
        }
        result
    }
    pub fn snapshot(&self, owner: &str) -> AuthState {
        Self::visible(&self.0.state.lock().unwrap(), owner)
    }
    pub fn subscribe(&self, owner: impl Into<String>) -> AuthSubscription {
        AuthSubscription {
            controller: self.clone(),
            owner: owner.into(),
            updates: self.0.updates.subscribe(),
            initial: true,
        }
    }
    /// Start or return the existing flow for the same owner. The caller controls the
    /// loopback listener and must pass its exact redirect URI here.
    pub fn start(
        &self,
        owner: &str,
        redirect_uri: String,
        host_id: &str,
        client_id: Option<&str>,
    ) -> Result<AuthState, &'static str> {
        self.start_with_hints(
            owner,
            redirect_uri,
            host_id,
            client_id,
            &AuthorizationHints::default(),
        )
    }
    fn start_with_hints(
        &self,
        owner: &str,
        redirect_uri: String,
        host_id: &str,
        client_id: Option<&str>,
        hints: &AuthorizationHints<'_>,
    ) -> Result<AuthState, &'static str> {
        let mut state = self.0.state.lock().unwrap();
        if let Some(active) = &state.active {
            return if active.owner == owner {
                Ok(state.state.clone())
            } else {
                Err("busy")
            };
        }
        let mut flow = Flow::new(redirect_uri)?;
        flow.expected_client_id = client_id.map(str::to_owned);
        let url =
            flow.authorization_url_with_hints(&self.0.discovery, host_id, client_id, hints)?;
        let id = uuid::Uuid::new_v4().to_string();
        let expires = tokio::time::Instant::now() + self.0.timeout;
        state.owner = Some(owner.to_owned());
        state.state = AuthState {
            phase: "waiting",
            flow_id: Some(id.clone()),
            authorization_url: Some(url),
            expires_at: std::time::SystemTime::now().checked_add(self.0.timeout),
            message: Some("Complete sign-in to continue."),
        };
        state.active = Some(ActiveFlow {
            owner: owner.to_owned(),
            id: id.clone(),
            flow: Some(flow),
            expires,
            timer: None,
        });
        let result = state.state.clone();
        self.changed();
        let weak = std::sync::Arc::downgrade(&self.0);
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(expires).await;
            if let Some(inner) = weak.upgrade() {
                let controller = AuthController(inner);
                controller.finish(&id, "failed", "Sign-in expired. Start again.");
            }
        });
        state.active.as_mut().unwrap().timer = Some(timer.abort_handle());
        drop(state);
        Ok(result)
    }
    /// Start a flow whose callback URL is delivered by the authenticated client.
    pub async fn start_client_callback(
        &self,
        owner: &str,
        host_id: &str,
        client_id: Option<&str>,
    ) -> Result<AuthState, &'static str> {
        self.start_client_callback_with_hints(
            owner,
            host_id,
            client_id,
            &AuthorizationHints::default(),
        )
        .await
    }
    pub async fn start_client_callback_with_hints(
        &self,
        owner: &str,
        host_id: &str,
        client_id: Option<&str>,
        hints: &AuthorizationHints<'_>,
    ) -> Result<AuthState, &'static str> {
        // The redirect is an identifier in client callback mode; no server is kept open.
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "callback")?;
        let port = socket.local_addr().map_err(|_| "callback")?.port();
        self.start_with_hints(
            owner,
            format!("http://127.0.0.1:{port}/auth/callback"),
            host_id,
            client_id,
            hints,
        )
    }
    /// Bind an ephemeral loopback callback listener and start a managed flow.
    /// The listener closes after cancellation, expiry, or completion.
    pub async fn start_loopback(
        &self,
        owner: &str,
        host_id: &str,
        client_id: Option<&str>,
        store: crate::codex_credential_store::CredentialStore,
    ) -> Result<AuthState, &'static str> {
        self.start_loopback_with_hints(
            owner,
            host_id,
            client_id,
            store,
            &AuthorizationHints::default(),
        )
        .await
    }
    pub async fn start_loopback_with_hints(
        &self,
        owner: &str,
        host_id: &str,
        client_id: Option<&str>,
        store: crate::codex_credential_store::CredentialStore,
        hints: &AuthorizationHints<'_>,
    ) -> Result<AuthState, &'static str> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "callback")?;
        let port = listener.local_addr().map_err(|_| "callback")?.port();
        let redirect = format!("http://127.0.0.1:{port}/auth/callback");
        let state = self.start_with_hints(owner, redirect.clone(), host_id, client_id, hints)?;
        // An already active flow owns its own listener.
        let actual = state
            .authorization_url
            .as_deref()
            .and_then(|s| Url::parse(s).ok())
            .and_then(|u| {
                u.query_pairs()
                    .find(|(k, _)| k == "redirect_uri")
                    .map(|(_, v)| v.into_owned())
            });
        if actual.as_deref() != Some(redirect.as_str()) {
            return Ok(state);
        }
        let id = state.flow_id.clone().ok_or("inactive")?;
        let controller = self.clone();
        let owner = owner.to_owned();
        let mut updates = self.0.updates.subscribe();
        let shutdown_controller = self.clone();
        let shutdown_id = id.clone();
        let route = axum::Router::new().route(
            "/auth/callback",
            axum::routing::get(move |uri: axum::http::Uri| {
                let controller = controller.clone();
                let owner = owner.clone();
                let id = id.clone();
                let store = store.clone();
                let redirect = redirect.clone();
                async move {
                    let callback = format!(
                        "{}{}",
                        redirect,
                        uri.query().map(|q| format!("?{q}")).unwrap_or_default()
                    );
                    match controller.complete(&owner, &id, &callback, &store).await {
                        Ok(_) => (
                            axum::http::StatusCode::OK,
                            "Sign-in complete. You can close this window.",
                        ),
                        Err("callback") => (
                            axum::http::StatusCode::BAD_REQUEST,
                            "This response does not belong to the active sign-in.",
                        ),
                        Err("inactive") => {
                            (axum::http::StatusCode::GONE, "Sign-in is no longer active.")
                        }
                        Err(_) => (
                            axum::http::StatusCode::BAD_REQUEST,
                            "Sign-in failed. Return to the application and try again.",
                        ),
                    }
                }
            }),
        );
        tokio::spawn(async move {
            let shutdown = async move {
                loop {
                    if shutdown_controller
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .active
                        .as_ref()
                        .is_none_or(|a| a.id != shutdown_id)
                    {
                        break;
                    }
                    if updates.changed().await.is_err() {
                        break;
                    }
                }
            };
            let _ = axum::serve(listener, route)
                .with_graceful_shutdown(shutdown)
                .await;
        });
        Ok(state)
    }
    fn finish(&self, id: &str, phase: &'static str, message: &'static str) -> bool {
        let mut s = self.0.state.lock().unwrap();
        if s.active.as_ref().is_none_or(|a| a.id != id) {
            return false;
        }
        let expired = s
            .active
            .as_ref()
            .is_some_and(|a| tokio::time::Instant::now() >= a.expires);
        let (phase, message) = if expired {
            ("failed", "Sign-in expired. Start again.")
        } else {
            (phase, message)
        };
        s.active = None;
        s.state.phase = phase;
        s.state.authorization_url = None;
        s.state.expires_at = None;
        s.state.message = Some(message);
        self.changed();
        !expired
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Result<AuthState, &'static str> {
        let mut s = self.0.state.lock().unwrap();
        if !s.active.as_ref().is_some_and(|a| {
            a.owner == owner && a.id == id && tokio::time::Instant::now() < a.expires
        }) {
            return Err("inactive");
        }
        s.active = None;
        s.state.phase = "cancelled";
        s.state.authorization_url = None;
        s.state.expires_at = None;
        s.state.message = Some("Sign-in cancelled.");
        let result = s.state.clone();
        self.changed();
        Ok(result)
    }
    /// End any in-flight sign-in and remove the active local credential atomically
    /// with respect to callback commits and token refreshes.
    pub async fn logout(
        &self,
        store: &crate::codex_credential_store::CredentialStore,
    ) -> Result<AuthState, &'static str> {
        let _guard = store.lock().await.map_err(|_| "storage")?;
        let credential = store.active_locked().map_err(|_| "storage")?;
        let revocation_failed = if let Some((endpoint, credential, token)) = self
            .0
            .discovery
            .revocation_endpoint
            .as_ref()
            .zip(credential.as_ref())
            .and_then(|(endpoint, credential)| {
                credential
                    .refresh_token
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|token| (endpoint, credential, token))
            }) {
            if let Ok(client) = http_client() {
                let mut confirmed = false;
                for attempt in 0..3 {
                    let result = client
                        .post(endpoint)
                        .form(&[
                            ("token", token),
                            ("token_type_hint", "refresh_token"),
                            ("client_id", credential.client_id.as_str()),
                        ])
                        .send()
                        .await;
                    let retry = match result {
                        Ok(response) => {
                            confirmed = response.status() == reqwest::StatusCode::OK;
                            response.status().is_server_error()
                        }
                        Err(_) => true,
                    };
                    if confirmed || !retry || attempt == 2 {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(if attempt == 0 {
                        250
                    } else {
                        1000
                    }))
                    .await;
                }
                !confirmed
            } else {
                true
            }
        } else {
            credential
                .as_ref()
                .is_some_and(|c| c.refresh_token.as_deref().is_some_and(|t| !t.is_empty()))
        };
        let mut state = self.0.state.lock().unwrap();
        state.active = None;
        state.owner = None;
        if store.remove_active_locked().is_err() {
            state.state = AuthState::idle();
            state.state.phase = "failed";
            state.state.message = Some("Could not sign out. Try again.");
            self.changed();
            return Err("storage");
        }
        state.state = AuthState::idle();
        state.state.message = Some(if revocation_failed {
            "Signed out locally. Remote revocation could not be confirmed. Disconnect the app in ChatGPT Settings."
        } else {
            "Signed out."
        });
        let result = state.state.clone();
        self.changed();
        Ok(result)
    }

    pub fn respond(&self, owner: &str, flow_id: &str) -> Result<AuthState, &'static str> {
        let state = self.0.state.lock().unwrap();
        if !state.active.as_ref().is_some_and(|a| {
            a.owner == owner && a.id == flow_id && tokio::time::Instant::now() < a.expires
        }) {
            return Err("inactive");
        }
        // Managed ChatGPT browser interactions accept callback URLs but have no responder.
        Err("interaction")
    }

    /// Consume a callback exactly once. Success is published only after the verified
    /// credentials have been stored. The caller still coordinates provider sessions.
    pub async fn complete(
        &self,
        owner: &str,
        id: &str,
        callback: &str,
        store: &crate::codex_credential_store::CredentialStore,
    ) -> Result<AuthState, &'static str> {
        let mut updates = self.0.updates.subscribe();
        let flow = {
            let mut s = self.0.state.lock().unwrap();
            let active = s
                .active
                .as_mut()
                .filter(|a| {
                    a.owner == owner && a.id == id && tokio::time::Instant::now() < a.expires
                })
                .ok_or("inactive")?;
            // Invalid input does not consume the flow, matching the upstream callback handler.
            active.flow.as_ref().ok_or("inactive")?.callback(callback)?;
            let flow = active.flow.take().ok_or("inactive")?;
            s.state.phase = "verifying";
            s.state.authorization_url = None;
            s.state.message = Some("Checking provider sign-in.");
            self.changed();
            flow
        };
        let redirect_uri = flow.redirect_uri.clone();
        let exchange = flow.exchange_verified(&self.0.discovery, callback);
        tokio::pin!(exchange);
        let result = loop {
            tokio::select! {
                result = &mut exchange => break result,
                changed = updates.changed() => {
                    if changed.is_err() || self.0.state.lock().unwrap().active.as_ref().is_none_or(|a| a.id != id) { return Err("inactive"); }
                }
            }
        };
        match result {
            Ok((token, claims, client_id)) => {
                let scopes: Vec<String> = token["scope"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect();
                if !scopes.iter().any(|s| s == "chatgpt.tokens.use.direct") {
                    self.finish(
                        id,
                        "failed",
                        "Token sharing is disabled. Sign in again and enable token sharing.",
                    );
                    return Err("sharing");
                }
                let record =
                    (|| -> Result<crate::codex_credential_store::Credentials, &'static str> {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_err(|_| "exchange")?
                            .as_millis();
                        let expires = now
                            .checked_add(
                                u128::from(token["expires_in"].as_u64().ok_or("exchange")?) * 1000,
                            )
                            .and_then(|n| i64::try_from(n).ok())
                            .ok_or("exchange")?;
                        Ok(crate::codex_credential_store::Credentials {
                            client_id,
                            access_token: token["access_token"]
                                .as_str()
                                .ok_or("exchange")?
                                .to_owned(),
                            refresh_token: token["refresh_token"].as_str().map(str::to_owned),
                            id_token: token["id_token"].as_str().map(str::to_owned),
                            issuer: Some(self.0.discovery.issuer.clone()),
                            expires_at: expires,
                            earliest_refresh_at: token["earliest_refresh_at"]
                                .as_i64()
                                .and_then(|n| n.checked_mul(1000)),
                            scopes,
                            subject: claims["sub"].as_str().ok_or("verify")?.to_owned(),
                            email: claims["email"].as_str().map(str::to_owned),
                        })
                    })();
                let record = match record {
                    Ok(record) => record,
                    Err(e) => {
                        self.finish(id, "failed", "Sign-in failed. Start again.");
                        return Err(e);
                    }
                };
                let _retirement = self.retire_sessions().await?;
                // The store lock precedes the controller lock; holding both through
                // the write prevents cancellation or expiry racing a successful commit.
                let _store_guard = store.lock().await.map_err(|_| "storage")?;
                let mut s = self.0.state.lock().unwrap();
                if !s.active.as_ref().is_some_and(|a| {
                    a.id == id && a.owner == owner && tokio::time::Instant::now() < a.expires
                }) {
                    return Err("inactive");
                }
                let mut registration = crate::codex_credential_store::Registration {
                    client_id: record.client_id.clone(),
                    subject: Some(record.subject.clone()),
                    email: record.email.clone(),
                    connection_label: None,
                    sharing_enabled: Some(true),
                    redirect_uri: Some(redirect_uri),
                };
                if store.validate_record_locked(&record).is_err()
                    || store.save_registration_locked(&mut registration).is_err()
                    || store.save_locked(record).is_err()
                {
                    s.active = None;
                    s.state.phase = "failed";
                    s.state.expires_at = None;
                    s.state.message = Some("Could not save provider sign-in.");
                    self.changed();
                    return Err("storage");
                }
                s.active = None;
                s.state.phase = "succeeded";
                s.state.expires_at = None;
                s.state.message = Some("Sign-in complete.");
                let result = s.state.clone();
                self.changed();
                Ok(result)
            }
            Err(e) => {
                self.finish(id, "failed", "Sign-in failed. Start again.");
                Err(e)
            }
        }
    }
}
impl AuthSubscription {
    pub async fn next(&mut self) -> Option<AuthState> {
        if self.initial {
            self.initial = false;
            self.updates.borrow_and_update();
        } else if self.updates.changed().await.is_err() {
            return None;
        }
        Some(self.controller.snapshot(&self.owner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
    };
    use serde_json::json;

    #[test]
    fn authorization_hints_follow_selected_registration() {
        let flow = Flow::new("http://127.0.0.1:12345/auth/callback".into()).unwrap();
        let hints = AuthorizationHints {
            email: Some("person@example.test"),
            id_token: Some("saved-id"),
            consent: true,
        };
        let registered = flow
            .authorization_url_with_hints(&local_discovery(), "host", Some("oaiapp_saved"), &hints)
            .unwrap();
        let url = Url::parse(&registered).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params.get("client_id").unwrap(), "oaiapp_saved");
        assert_eq!(params.get("login_hint").unwrap(), "person@example.test");
        assert_eq!(params.get("id_token_hint").unwrap(), "saved-id");
        assert_eq!(params.get("prompt").unwrap(), "consent");
        assert!(!params.contains_key("agent_name_hint"));
        let new = flow
            .authorization_url_with_hints(&local_discovery(), "host", None, &hints)
            .unwrap();
        let url = Url::parse(&new).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params.get("agent_name_hint").unwrap(), "T3 Code");
        assert!(!params.contains_key("login_hint"));
        assert!(!params.contains_key("id_token_hint"));
        assert!(!params.contains_key("prompt"));
    }

    #[tokio::test]
    async fn logout_revokes_current_refresh_token_and_clears_local_credentials() {
        use axum::{routing::post, Form, Router};
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let app = Router::new().route(
            "/revoke",
            post(
                move |Form(form): Form<std::collections::HashMap<String, String>>| {
                    let tx = tx.clone();
                    async move {
                        if let Some(tx) = tx.lock().unwrap().take() {
                            let _ = tx.send(form);
                        }
                        axum::http::StatusCode::OK
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut discovery = local_discovery();
        discovery.revocation_endpoint = Some(format!("http://{addr}/revoke"));
        let controller = AuthController::new(discovery, std::time::Duration::from_secs(60));
        let dir = std::env::temp_dir().join(format!("revoke-test-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "managed").unwrap();
        store
            .save(crate::codex_credential_store::Credentials {
                client_id: "oaiapp_mock".into(),
                access_token: "access".into(),
                refresh_token: Some("rotated-refresh".into()),
                expires_at: 1,
                earliest_refresh_at: None,
                scopes: vec![],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        let state = controller.logout(&store).await.unwrap();
        let form = rx.await.unwrap();
        assert_eq!(form["token"], "rotated-refresh");
        assert_eq!(form["client_id"], "oaiapp_mock");
        assert_eq!(form["token_type_hint"], "refresh_token");
        assert_eq!(state.message, Some("Signed out."));
        assert!(store.read().await.unwrap().is_none());
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn logout_finishes_after_request_disconnects() {
        use axum::{routing::post, Router};
        let (arrived, wait) = tokio::sync::oneshot::channel();
        let arrived = std::sync::Arc::new(std::sync::Mutex::new(Some(arrived)));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let released = std::sync::Arc::new(tokio::sync::Mutex::new(Some(released)));
        let app = Router::new().route(
            "/revoke",
            post(move || {
                let arrived = arrived.clone();
                let released = released.clone();
                async move {
                    if let Some(tx) = arrived.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    if let Some(rx) = released.lock().await.take() {
                        let _ = rx.await;
                    }
                    axum::http::StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut discovery = local_discovery();
        discovery.revocation_endpoint = Some(format!("http://{addr}/revoke"));
        let controller = AuthController::new(discovery, std::time::Duration::from_secs(60));
        let dir = std::env::temp_dir().join(format!("logout-detached-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "managed").unwrap();
        store
            .save(crate::codex_credential_store::Credentials {
                client_id: "oaiapp_mock".into(),
                access_token: "access".into(),
                refresh_token: Some("refresh".into()),
                expires_at: 1,
                earliest_refresh_at: None,
                scopes: vec!["chatgpt.tokens.use.direct".into()],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        let task = tokio::spawn({
            let controller = controller.clone();
            let store = store.clone();
            async move { controller.logout_durable(store).await }
        });
        wait.await.unwrap();
        task.abort();
        release.send(()).unwrap();
        let saved = tokio::time::timeout(std::time::Duration::from_secs(5), store.read())
            .await
            .unwrap()
            .unwrap();
        assert!(saved.is_none());
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn signed(claims: Value) -> (String, Value) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let point = key.public_key().as_ref();
        let jwks = json!({"keys":[{"kty":"EC","crv":"P-256","kid":"test","alg":"ES256","x":URL_SAFE_NO_PAD.encode(&point[1..33]),"y":URL_SAFE_NO_PAD.encode(&point[33..65])}]});
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","kid":"test"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let data = format!("{header}.{payload}");
        let sig = key.sign(&rng, data.as_bytes()).unwrap();
        (
            format!("{data}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref())),
            jwks,
        )
    }
    fn local_discovery() -> Discovery {
        Discovery {
            issuer: "http://127.0.0.1".into(),
            authorization_endpoint: "http://127.0.0.1/authorize".into(),
            token_endpoint: "http://127.0.0.1/token".into(),
            jwks_uri: "http://127.0.0.1/keys".into(),
            revocation_endpoint: None,
        }
    }
    #[tokio::test]
    async fn access_renews_once_and_commits_rotated_credentials() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = axum::Router::new().route("/token", axum::routing::post(move |body: String| {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
                assert_eq!(form.get("grant_type").map(String::as_str), Some("refresh_token"));
                assert_eq!(form.get("refresh_token").map(String::as_str), Some("old-refresh"));
                assert_eq!(form.get("resource").map(String::as_str), Some(RESOURCE));
                axum::Json(json!({"access_token":"new-access", "refresh_token":"new-refresh", "token_type":"Bearer", "expires_in":3600, "scope":"chatgpt.tokens.use.direct"}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut discovery = local_discovery();
        discovery.token_endpoint = format!("http://{addr}/token");
        let dir = std::env::temp_dir().join(format!("oauth-refresh-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "test").unwrap();
        store
            .save(crate::codex_credential_store::Credentials {
                client_id: "oaiapp_test".into(),
                access_token: "old-access".into(),
                refresh_token: Some("old-refresh".into()),
                expires_at: 0,
                earliest_refresh_at: None,
                scopes: vec!["chatgpt.tokens.use.direct".into()],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            discovery.access(&store, 1000),
            discovery.access(&store, 1000)
        );
        assert_eq!(a.unwrap().access_token, "new-access");
        assert_eq!(b.unwrap().refresh_token.as_deref(), Some("new-refresh"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            store
                .read()
                .await
                .unwrap()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("new-refresh")
        );
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn access_classifies_oauth_errors_without_exposing_response() {
        let app = axum::Router::new().route(
            "/token",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error":"invalid_grant", "error_description":"secret"})),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut discovery = local_discovery();
        discovery.token_endpoint = format!("http://{addr}/token");
        let dir = std::env::temp_dir().join(format!("oauth-failure-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "test").unwrap();
        store
            .save(crate::codex_credential_store::Credentials {
                client_id: "oaiapp_test".into(),
                access_token: "old".into(),
                refresh_token: Some("old".into()),
                expires_at: 0,
                earliest_refresh_at: None,
                scopes: vec!["chatgpt.tokens.use.direct".into()],
                subject: "subject".into(),
                email: None,
                id_token: None,
                issuer: None,
            })
            .await
            .unwrap();
        assert!(matches!(
            discovery.access(&store, 1000).await,
            Err(crate::codex_credential_store::StoreError::Refresh)
        ));
        assert!(store.read().await.unwrap().is_none());
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn controller_isolates_owners_cancels_and_restarts() {
        let c = AuthController::new(local_discovery(), std::time::Duration::from_secs(5));
        let mut owner = c.subscribe("alice");
        let mut other = c.subscribe("bob");
        assert_eq!(owner.next().await.unwrap().phase, "idle");
        assert_eq!(other.next().await.unwrap().phase, "idle");
        let start = c
            .start(
                "alice",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None,
            )
            .unwrap();
        assert_eq!(owner.next().await.unwrap(), start);
        let hidden = other.next().await.unwrap();
        assert!(
            hidden.flow_id.is_none()
                && hidden.authorization_url.is_none()
                && hidden.expires_at.is_none()
        );
        assert_eq!(
            c.start(
                "bob",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None
            )
            .unwrap_err(),
            "busy"
        );
        assert_eq!(
            c.start(
                "alice",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None
            )
            .unwrap(),
            start
        );
        let id = start.flow_id.as_deref().unwrap();
        let dir = std::env::temp_dir().join(format!("oauth-controller-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "test").unwrap();
        assert_eq!(c.cancel("bob", id).unwrap_err(), "inactive");
        assert_eq!(
            c.complete("alice", id, "invalid", &store)
                .await
                .unwrap_err(),
            "callback"
        );
        assert_eq!(c.cancel("alice", id).unwrap().phase, "cancelled");
        assert_eq!(
            c.complete("alice", id, "invalid", &store)
                .await
                .unwrap_err(),
            "inactive"
        );
        let next = c
            .start(
                "bob",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None,
            )
            .unwrap();
        assert_ne!(start.flow_id, next.flow_id);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn client_callback_state_matches_wire_shape_and_is_owner_scoped() {
        let c = AuthController::new(local_discovery(), std::time::Duration::from_secs(5));
        let state = c
            .start_client_callback("alice", "host", None)
            .await
            .unwrap();
        let wire = state.to_provider_state("managed");
        assert_eq!(wire["interaction"]["id"], wire["flowId"]);
        assert_eq!(wire["interaction"]["url"], wire["authorizationUrl"]);
        assert_eq!(wire["interaction"]["acceptsCallback"], true);
        assert_eq!(wire["credentialOwner"], "t3");
        assert_eq!(wire["methods"][0]["id"], "chatgpt");
        assert_eq!(wire["methods"][0]["type"], "agent");
        let other = c.snapshot("bob").to_provider_state("managed");
        assert!(other["interaction"].is_null());
        assert!(other["flowId"].is_null());
        assert!(other["authorizationUrl"].is_null());
        c.cancel("alice", state.flow_id.as_deref().unwrap())
            .unwrap();
    }
    #[tokio::test]
    async fn loopback_rejects_strays_and_closes_on_cancel() {
        let controller = AuthController::new(local_discovery(), std::time::Duration::from_secs(5));
        let dir = std::env::temp_dir().join(format!("oauth-listener-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "test").unwrap();
        let started = controller
            .start_loopback("owner", "host", None, store)
            .await
            .unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let redirect = authorization
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .unwrap()
            .1
            .into_owned();
        let client = reqwest::Client::new();
        let response = client
            .get(format!(
                "{redirect}?state=wrong&code=x&client_id=oaiapp_test"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(controller.snapshot("owner").phase, "waiting");
        controller
            .cancel("owner", started.flow_id.as_deref().unwrap())
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if client.get(&redirect).send().await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn controller_expires_and_clears_secrets() {
        let c = AuthController::new(local_discovery(), std::time::Duration::from_millis(10));
        let mut sub = c.subscribe("alice");
        sub.next().await.unwrap();
        let start = c
            .start(
                "alice",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None,
            )
            .unwrap();
        loop {
            let state = tokio::time::timeout(std::time::Duration::from_secs(1), sub.next())
                .await
                .unwrap()
                .unwrap();
            if state.phase == "failed" {
                assert!(state.authorization_url.is_none() && state.expires_at.is_none());
                break;
            }
        }
        assert_eq!(
            c.cancel("alice", start.flow_id.as_deref().unwrap())
                .unwrap_err(),
            "inactive"
        );
    }
    #[test]
    fn checks_callback_binding_and_ambiguity() {
        let mut flow = Flow::new("http://127.0.0.1:12345/auth/callback".into()).unwrap();
        let callback = format!(
            "{}?state={}&code=abc&client_id=oaiapp_test",
            flow.redirect_uri, flow.state
        );
        assert!(flow.callback(&callback).is_ok());
        assert!(flow
            .callback(&format!("{callback}&state={}", flow.state))
            .is_err());
        assert!(flow.callback(&callback.replace("12345", "12346")).is_err());
        assert!(flow
            .callback(&format!("{callback}&error=access_denied"))
            .is_err());
        assert!(flow
            .callback(&callback.replace("oaiapp_test", "bad"))
            .is_err());
        flow.expected_client_id = Some("oaiapp_test".into());
        assert!(flow
            .callback(&callback.replace("&client_id=oaiapp_test", ""))
            .is_ok());
        assert!(flow
            .callback(&callback.replace("oaiapp_test", "oaiapp_other"))
            .is_err());
    }
    #[tokio::test]
    async fn imported_identity_requires_trusted_local_jwks_and_matching_profile() {
        use crate::codex_credential_store::{Credentials, Registration};
        use axum::{routing::get, Router};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (token, keys) = signed(
            json!({"iss":"http://127.0.0.1", "aud":"oaiapp_test", "sub":"subject", "email":"person@example.test", "exp":now+60}),
        );
        let app = Router::new().route(
            "/keys",
            get(move || {
                let keys = keys.clone();
                async move { axum::Json(keys) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut discovery = local_discovery();
        discovery.jwks_uri = format!("http://{addr}/keys");
        let registration = Registration {
            client_id: "oaiapp_test".into(),
            subject: Some("subject".into()),
            email: Some("person@example.test".into()),
            connection_label: None,
            sharing_enabled: None,
            redirect_uri: None,
        };
        let mut credentials = Credentials {
            client_id: "oaiapp_test".into(),
            access_token: "access".into(),
            refresh_token: None,
            expires_at: ((now + 60) * 1000) as i64,
            earliest_refresh_at: None,
            scopes: vec!["chatgpt.tokens.use.direct".into()],
            subject: "subject".into(),
            email: Some("person@example.test".into()),
            id_token: Some(token),
            issuer: Some(discovery.issuer.clone()),
        };
        assert!(discovery
            .verify_import(&registration, &credentials)
            .await
            .is_ok());
        credentials.subject = "other".into();
        assert!(discovery
            .verify_import(&registration, &credentials)
            .await
            .is_err());
        credentials.subject = "subject".into();
        credentials.id_token.as_mut().unwrap().push('a');
        assert!(discovery
            .verify_import(&registration, &credentials)
            .await
            .is_err());
        server.abort();
    }
    #[test]
    fn verifies_signed_identity_and_rejects_mismatches() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (token, keys) = signed(
            json!({"iss":"https://issuer.example", "aud":"oaiapp_test", "sub":"subject", "nonce":"nonce", "exp":now+60}),
        );
        assert!(verify_id_token(
            &token,
            &keys,
            "https://issuer.example",
            "oaiapp_test",
            "nonce"
        )
        .is_ok());
        assert!(verify_id_token(
            &token,
            &keys,
            "https://issuer.example",
            "oaiapp_test",
            "wrong"
        )
        .is_err());
        assert!(
            verify_id_token(&token, &keys, "https://issuer.example", "other", "nonce").is_err()
        );
        let mut corrupted = token.clone();
        corrupted.push('a');
        assert!(verify_id_token(
            &corrupted,
            &keys,
            "https://issuer.example",
            "oaiapp_test",
            "nonce"
        )
        .is_err());
        let (expired, keys) = signed(
            json!({"iss":"https://issuer.example", "aud":"oaiapp_test", "sub":"subject", "nonce":"nonce", "exp":now-10}),
        );
        assert!(verify_id_token(
            &expired,
            &keys,
            "https://issuer.example",
            "oaiapp_test",
            "nonce"
        )
        .is_err());
    }
    #[tokio::test]
    async fn exchanges_against_disposable_loopback_provider() {
        use axum::{
            routing::{get, post},
            Router,
        };
        let flow = Flow::new("http://127.0.0.1:12345/auth/callback".into()).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (id_token, jwks) = signed(
            json!({"iss":"http://test-issuer", "aud":"oaiapp_test", "sub":"test", "nonce":flow.nonce, "exp":now+60}),
        );
        let token = json!({"access_token":"disposable", "id_token":id_token, "token_type":"Bearer", "expires_in":60, "scope":"openid"}).to_string();
        let key_body = jwks.to_string();
        let app = Router::new()
            .route(
                "/token",
                post(move || {
                    let body = token.clone();
                    async move { body }
                }),
            )
            .route(
                "/keys",
                get(move || {
                    let body = key_body.clone();
                    async move { body }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let d = Discovery {
            issuer: "http://test-issuer".into(),
            authorization_endpoint: format!("http://{addr}/authorize"),
            token_endpoint: format!("http://{addr}/token"),
            jwks_uri: format!("http://{addr}/keys"),
            revocation_endpoint: None,
        };
        let callback = format!(
            "{}?state={}&code=disposable&client_id=oaiapp_test",
            flow.redirect_uri, flow.state
        );
        assert_eq!(
            flow.exchange(&d, &callback).await.unwrap()["access_token"],
            "disposable"
        );
        server.abort();
    }
    #[tokio::test]
    async fn controller_publishes_success_only_after_credential_commit() {
        use axum::{
            routing::{get, post},
            Router,
        };
        let bodies = std::sync::Arc::new(std::sync::Mutex::new((String::new(), String::new())));
        let token_bodies = bodies.clone();
        let key_bodies = bodies.clone();
        let app = Router::new()
            .route(
                "/token",
                post(move || {
                    let b = token_bodies.clone();
                    async move { b.lock().unwrap().0.clone() }
                }),
            )
            .route(
                "/keys",
                get(move || {
                    let b = key_bodies.clone();
                    async move { b.lock().unwrap().1.clone() }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let d = Discovery {
            issuer: "http://test-issuer".into(),
            authorization_endpoint: format!("http://{addr}/authorize"),
            token_endpoint: format!("http://{addr}/token"),
            jwks_uri: format!("http://{addr}/keys"),
            revocation_endpoint: None,
        };
        let c = AuthController::new(d, std::time::Duration::from_secs(5));
        let dir = std::env::temp_dir().join(format!("oauth-commit-{}", uuid::Uuid::new_v4()));
        let store = crate::codex_credential_store::CredentialStore::new(&dir, "test").unwrap();
        let start = c
            .start_loopback("owner", "host", None, store.clone())
            .await
            .unwrap();
        let url = Url::parse(start.authorization_url.as_deref().unwrap()).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (id_token, jwks) = signed(
            json!({"iss":"http://test-issuer", "aud":"oaiapp_test", "sub":"subject", "nonce":params["nonce"], "exp":now+60}),
        );
        *bodies.lock().unwrap() = (json!({"access_token":"disposable", "refresh_token":"refresh", "id_token":id_token, "token_type":"Bearer", "expires_in":60, "scope":"openid chatgpt.tokens.use.direct"}).to_string(), jwks.to_string());
        let callback = format!(
            "{}?state={}&code=disposable&client_id=oaiapp_test",
            params["redirect_uri"], params["state"]
        );
        let response = reqwest::get(&callback).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(c.snapshot("owner").phase, "succeeded");
        let saved = store.read().await.unwrap().unwrap();
        assert_eq!(saved.subject, "subject");
        assert_eq!(saved.access_token, "disposable");
        // A legacy store can contain credentials without a registration. A
        // conflicting sign-in must not create a registration for the wrong account.
        let driver = "codex-chatgpt-registration";
        let digest = Sha256::digest(format!("{}:{}{}", driver.len(), driver, "test").as_bytes());
        let name = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        std::fs::remove_file(dir.join(format!("provider-auth-{name}.bin"))).unwrap();
        let start = c
            .start(
                "owner",
                "http://127.0.0.1:12345/auth/callback".into(),
                "host",
                None,
            )
            .unwrap();
        let url = Url::parse(start.authorization_url.as_deref().unwrap()).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let (id_token, jwks) = signed(
            json!({"iss":"http://test-issuer", "aud":"oaiapp_test", "sub":"different-subject", "nonce":params["nonce"], "exp":now+60}),
        );
        *bodies.lock().unwrap() = (json!({"access_token":"replacement", "id_token":id_token, "token_type":"Bearer", "expires_in":60, "scope":"chatgpt.tokens.use.direct"}).to_string(), jwks.to_string());
        let callback = format!(
            "http://127.0.0.1:12345/auth/callback?state={}&code=disposable&client_id=oaiapp_test",
            params["state"]
        );
        assert_eq!(
            c.complete(
                "owner",
                start.flow_id.as_deref().unwrap(),
                &callback,
                &store
            )
            .await
            .unwrap_err(),
            "storage"
        );
        assert_eq!(c.snapshot("owner").phase, "failed");
        assert_eq!(
            store.read().await.unwrap().unwrap().access_token,
            "disposable"
        );
        assert!(store.registrations().await.unwrap().is_empty());
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn discovery_rejects_redirects_oversized_bodies_and_nonproduction_urls() {
        use axum::{
            http::{header, StatusCode},
            routing::get,
            Router,
        };
        let app = Router::new()
            .route("/redirect", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/metadata")], "") }))
            .route("/large", get(|| async { "x".repeat(MAX_RESPONSE + 1) }))
            .route("/metadata", get(|| async { r#"{"issuer":"http://test","authorization_endpoint":"http://test/auth","token_endpoint":"http://test/token","jwks_uri":"http://test/keys"}"# }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert!(Discovery::fetch(&format!("http://{addr}/metadata"), true)
            .await
            .is_err());
        assert!(Discovery::fetch(&format!("http://{addr}/redirect"), false)
            .await
            .is_err());
        assert!(Discovery::fetch(&format!("http://{addr}/large"), false)
            .await
            .is_err());
        assert!(Discovery::fetch(&format!("http://{addr}/metadata"), false)
            .await
            .is_ok());
        server.abort();
    }
}
