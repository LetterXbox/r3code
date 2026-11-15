//! MCP OAuth registration and one-time PKCE authorization codes.
//! HTTP routing and external-client authorization are integrated separately.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

type HmacSha256 = Hmac<Sha256>;
const CODE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OAuthError {
    pub code: &'static str,
    pub description: &'static str,
}
fn error(code: &'static str, description: &'static str) -> OAuthError {
    OAuthError { code, description }
}

#[derive(Debug, Clone)]
pub(crate) struct Client {
    pub id: String,
    pub name: String,
    pub redirects: Vec<String>,
    pub peer_link: bool,
}

struct Pending {
    client_id: String,
    redirect: String,
    challenge: String,
    resource: String,
    access: String,
    peer_link: bool,
    label: String,
    expires: Instant,
}

struct ValidatedAuthorization {
    client: Client,
    redirect: String,
    challenge: String,
}

pub(crate) struct GrantedCode {
    pub access: String,
    pub peer_link: bool,
    pub label: String,
}

/// Persist a scoped, revocable MCP bearer session after successful code exchange.
pub(crate) fn issue_session(
    db: &Mutex<rusqlite::Connection>,
    signing_key: &[u8; 32],
    grant: GrantedCode,
    now_ms: i64,
) -> Result<Value, OAuthError> {
    let expires_ms = now_ms
        .checked_add(30 * 24 * 60 * 60 * 1000)
        .ok_or_else(|| error("invalid_grant", "The session could not be issued."))?;
    let iso = |milliseconds| {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .ok_or_else(|| error("invalid_grant", "The session could not be issued."))
    };
    let now = iso(now_ms)?;
    let expires = iso(expires_ms)?;
    let scopes: Vec<String> = match grant.access.as_str() {
        "read-only" => vec!["orchestration:read".into()],
        "approval-required" | "auto-accept-edits" | "auto" => {
            vec!["orchestration:read".into(), "orchestration:operate".into()]
        }
        "full-access" => vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
            "settings:write".into(),
            "source-control:write".into(),
        ],
        _ => return Err(error("invalid_grant", "The session could not be issued.")),
    };
    let sid = uuid::Uuid::new_v4().to_string();
    let claims = crate::auth::SessionClaims {
        v: 1,
        kind: "session".into(),
        sid: sid.clone(),
        sub: "mcp-client".into(),
        scopes: scopes.clone(),
        method: "bearer-access-token".into(),
        jkt: None,
        rtc: (grant.access != "read-only").then_some(grant.access),
        plk: grant.peer_link.then_some(1),
        iat: now_ms,
        exp: expires_ms,
    };
    let token = crate::auth::sign_session(signing_key, &claims)
        .map_err(|_| error("invalid_grant", "The session could not be issued."))?;
    let encoded = serde_json::to_string(&scopes)
        .map_err(|_| error("invalid_grant", "The session could not be issued."))?;
    db.lock().map_err(|_|error("invalid_grant", "The session could not be issued."))?.execute(
        "INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at,client_label,client_device_type) VALUES(?1,'mcp-client',?2,'bearer-access-token',?3,?4,?5,'bot')",
        rusqlite::params![sid,encoded,now,expires,grant.label],
    ).map_err(|_|error("invalid_grant", "The session could not be issued."))?;
    Ok(
        json!({"access_token":token,"token_type":"Bearer","expires_in":30*24*60*60,"scope":scopes.join(" ")}),
    )
}

pub(crate) struct McpOAuth {
    key: [u8; 32],
    pending: Mutex<HashMap<String, Pending>>,
}

fn redirect_url(value: &str) -> Option<url::Url> {
    // The wire contract counts JavaScript UTF-16 units, not UTF-8 bytes.
    if value.encode_utf16().count() > 512 || value.contains('#') {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_matches(['[', ']']);
    if url.scheme() == "https"
        || (url.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "::1"))
    {
        Some(url)
    } else {
        None
    }
}

fn redirect_matches(registered: &str, presented: &str) -> bool {
    let (Some(left), Some(right)) = (redirect_url(registered), redirect_url(presented)) else {
        return false;
    };
    if left.scheme() == "https" || right.scheme() == "https" {
        return left == right;
    }
    left.host_str() == right.host_str()
        && left.path() == right.path()
        && left.query() == right.query()
}

fn same_resource(expected: &str, presented: Option<&str>) -> bool {
    let Some(presented) = presented else {
        return true;
    };
    let Ok(url) = url::Url::parse(presented) else {
        return false;
    };
    // WHATWG URL.hash is empty for both no fragment and a bare `#`.
    url.fragment().is_none_or(str::is_empty)
        && format!(
            "{}{}",
            url.origin().ascii_serialization(),
            url.path().trim_end_matches('/')
        ) == expected
}

fn random_token(bytes: usize) -> Result<String, OAuthError> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|_| error("server_error", "Could not create authorization."))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

impl McpOAuth {
    pub(crate) fn new(key: [u8; 32]) -> Self {
        Self {
            key,
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn sign(&self, body: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        mac.update(format!("mcp-client-id.{body}").as_bytes());
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    pub(crate) fn register(
        &self,
        metadata: &Value,
        links_enabled: bool,
    ) -> Result<Client, OAuthError> {
        let name = metadata["client_name"].as_str().unwrap_or("").trim();
        // JavaScript's String.slice limit counts UTF-16 code units. Preserve a
        // valid UTF-8 boundary when a supplementary character straddles it.
        let mut units = 0;
        let name: String = if name.is_empty() { "MCP client" } else { name }
            .chars()
            .take_while(|ch| {
                units += ch.len_utf16();
                units <= 100
            })
            .collect();
        let redirects = metadata["redirect_uris"].as_array().ok_or_else(|| {
            error(
                "invalid_redirect_uri",
                "Register between 1 and 5 redirect URIs.",
            )
        })?;
        if redirects.is_empty() || redirects.len() > 5 {
            return Err(error(
                "invalid_redirect_uri",
                "Register between 1 and 5 redirect URIs.",
            ));
        }
        let redirects: Vec<String> = redirects
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<_>>()
            .ok_or_else(|| {
                error(
                    "invalid_redirect_uri",
                    "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
                )
            })?;
        if redirects.iter().any(|uri| redirect_url(uri).is_none()) {
            return Err(error(
                "invalid_redirect_uri",
                "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
            ));
        }
        let peer_link = metadata["software_id"] == "t3code-peer-link";
        if peer_link && !links_enabled {
            return Err(error(
                "invalid_client_metadata",
                "Linked environments is off on that machine. Turn it on in its Settings → Labs.",
            ));
        }
        let mut value = json!({"v":1,"n":name,"r":redirects});
        if peer_link {
            value["p"] = json!(1);
        }
        let body = URL_SAFE_NO_PAD.encode(value.to_string());
        Ok(Client {
            id: format!("{body}.{}", self.sign(&body)),
            name,
            redirects,
            peer_link,
        })
    }

    pub(crate) fn parse_client(&self, id: &str) -> Option<Client> {
        let (body, signature) = id.split_once('.')?;
        if signature.contains('.') {
            return None;
        }
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        let mut mac = HmacSha256::new_from_slice(&self.key).ok()?;
        mac.update(format!("mcp-client-id.{body}").as_bytes());
        mac.verify_slice(&signature).ok()?;
        let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
        if value["v"] != 1 {
            return None;
        }
        let name = value["n"].as_str()?.to_owned();
        let redirects = value["r"]
            .as_array()?
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        Some(Client {
            id: id.to_owned(),
            name,
            redirects,
            peer_link: value["p"] == 1,
        })
    }

    fn validate_authorization(
        &self,
        request: &Value,
        resource: &str,
    ) -> Result<ValidatedAuthorization, OAuthError> {
        let client = self
            .parse_client(request["client_id"].as_str().unwrap_or(""))
            .ok_or_else(|| error("invalid_client", "The client is unknown."))?;
        let redirect = request["redirect_uri"]
            .as_str()
            .filter(|v| client.redirects.iter().any(|r| redirect_matches(r, v)))
            .ok_or_else(|| error("invalid_request", "The redirect URI was not registered."))?;
        if request["response_type"] != "code" {
            return Err(error(
                "unsupported_response_type",
                "Only response_type=code is supported.",
            ));
        }
        let challenge = request["code_challenge"]
            .as_str()
            .filter(|s| {
                s.len() == 43
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(|| {
                error(
                    "invalid_request",
                    "PKCE with code_challenge_method=S256 is required.",
                )
            })?;
        if request["code_challenge_method"] != "S256" {
            return Err(error(
                "invalid_request",
                "PKCE with code_challenge_method=S256 is required.",
            ));
        }
        if !same_resource(resource, request["resource"].as_str()) {
            return Err(error(
                "invalid_target",
                "The requested resource does not match this server.",
            ));
        }
        Ok(ValidatedAuthorization {
            client,
            redirect: redirect.to_owned(),
            challenge: challenge.to_owned(),
        })
    }

    /// Validate an authorization request without granting a code or consuming credentials.
    pub(crate) fn approval_details(&self, request: &Value, resource: &str) -> Result<(Client, String), OAuthError> {
        let validated = self.validate_authorization(request, resource)?;
        Ok((validated.client, validated.redirect))
    }

    fn browser_csrf(&self, principal: &crate::auth::Principal, authorization: &ValidatedAuthorization) -> String {
        let holder = principal.jkt.as_ref().map(|value| format!("dpop:{value}")).unwrap_or_else(|| principal.session_id.clone());
        let payload = serde_json::to_string(&json!([holder, authorization.client.id, authorization.redirect, authorization.challenge])).expect("serializable csrf input");
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        mac.update(format!("mcp-csrf.{payload}").as_bytes());
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }

    fn access_scopes(access: &str) -> Option<&'static [&'static str]> {
        match access {
            "read-only" => Some(&["orchestration:read"]),
            "approval-required" | "auto-accept-edits" | "auto" => Some(&["orchestration:read", "orchestration:operate"]),
            "full-access" => Some(&["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]),
            _ => None,
        }
    }

    /// Return browser approval options only for an already-authenticated session
    /// with permission to manage access and read orchestration.
    pub(crate) fn browser_approval(&self, request: &Value, resource: &str, principal: &crate::auth::Principal) -> Result<Option<(String, Vec<&'static str>)>, OAuthError> {
        let authorization = self.validate_authorization(request, resource)?;
        if !["access:write", "orchestration:read"].iter().all(|scope| principal.scopes.iter().any(|s| s == scope)) { return Ok(None); }
        let accesses = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"]
            .into_iter().filter(|access| Self::access_scopes(access).unwrap().iter().all(|scope| principal.scopes.iter().any(|s| s == scope))).collect();
        Ok(Some((self.browser_csrf(principal, &authorization), accesses)))
    }

    /// Mint a code only after the caller has independently authenticated the session.
    pub(crate) fn approve_browser(&self, request: &Value, resource: &str, principal: &crate::auth::Principal, csrf: &str, access: &str) -> Result<String, OAuthError> {
        let authorization = self.validate_authorization(request, resource)?;
        let denial = || error("access_denied", "Your session cannot approve this request. Enter a pairing code instead.");
        let scopes = Self::access_scopes(access).ok_or_else(denial)?;
        if !["access:write", "orchestration:read"].iter().chain(scopes.iter()).all(|scope| principal.scopes.iter().any(|s| s == scope)) { return Err(denial()); }
        let expected = self.browser_csrf(principal, &authorization);
        let expected_bytes = URL_SAFE_NO_PAD.decode(expected).map_err(|_| denial())?;
        let supplied = URL_SAFE_NO_PAD.decode(csrf).map_err(|_| denial())?;
        let mut left = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        left.update(&expected_bytes);
        let signature = left.finalize().into_bytes();
        let mut right = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        right.update(&supplied);
        if right.verify_slice(&signature).is_err() { return Err(denial()); }
        self.issue_code(authorization, resource, access)
    }

    /// Called only after the HTTP layer has consumed a valid pairing grant or
    /// authorized browser approval. The one-time code never contains secrets.
    #[cfg(test)]
    pub(crate) fn authorize(
        &self,
        request: &Value,
        resource: &str,
        access: &str,
    ) -> Result<String, OAuthError> {
        let validated = self.validate_authorization(request, resource)?;
        self.issue_code(validated, resource, access)
    }

    fn issue_code(
        &self,
        validated: ValidatedAuthorization,
        resource: &str,
        access: &str,
    ) -> Result<String, OAuthError> {
        if !matches!(
            access,
            "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access"
        ) {
            return Err(error("invalid_request", "Invalid access."));
        }
        let code = random_token(32)?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| error("server_error", "Could not create authorization."))?;
        pending.retain(|_, v| v.expires > Instant::now());
        if pending.len() >= 4096 {
            return Err(error("server_error", "Could not create authorization."));
        }
        pending.insert(
            code.clone(),
            Pending {
                client_id: validated.client.id,
                redirect: validated.redirect,
                challenge: validated.challenge,
                resource: resource.into(),
                access: access.into(),
                peer_link: validated.client.peer_link,
                label: validated.client.name,
                expires: Instant::now() + CODE_TTL,
            },
        );
        Ok(code)
    }

    /// Validate the OAuth request before consuming the pairing credential.
    pub(crate) fn approve_pairing(
        &self,
        db: &Mutex<rusqlite::Connection>,
        request: &Value,
        resource: &str,
        access: &str,
        credential: &str,
        now: &str,
    ) -> Result<String, OAuthError> {
        let validated = self.validate_authorization(request, resource)?;
        let approval_prefix = credential
            .trim()
            .split_once('-')
            .is_some_and(|(prefix, rest)| {
                ["READ", "SUPERVISED", "EDITS", "AUTO", "FULL"]
                    .iter()
                    .any(|value| prefix.eq_ignore_ascii_case(value))
                    && rest.len() == 12
                    && rest.bytes().all(|byte| {
                        b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&byte.to_ascii_uppercase())
                    })
            });
        if validated.client.peer_link && approval_prefix {
            return Err(error(
                "access_denied",
                "Linking needs a plain pairing code, not an app approval code.",
            ));
        }
        let scopes: Vec<String> = match access {
            "read-only" => vec!["orchestration:read".into()],
            "approval-required" | "auto-accept-edits" | "auto" => {
                vec!["orchestration:read".into(), "orchestration:operate".into()]
            }
            "full-access" => vec![
                "orchestration:read".into(),
                "orchestration:operate".into(),
                "settings:write".into(),
                "source-control:write".into(),
            ],
            _ => return Err(error("invalid_request", "Invalid access.")),
        };
        let mut conn = db
            .lock()
            .map_err(|_| error("server_error", "Could not check pairing code."))?;
        let tx = conn
            .transaction()
            .map_err(|_| error("server_error", "Could not check pairing code."))?;
        let subject = format!("mcp-approval:{access}");
        let grant = crate::auth::consume_pairing(
            &tx,
            credential.trim(),
            now,
            Some(&subject),
            None,
            None,
            &scopes,
        )
        .map_err(|_| error("server_error", "Could not check pairing code."))?
        .ok_or_else(|| {
            error(
                "access_denied",
                "That pairing code is unknown, expired, or already used.",
            )
        })?;
        if grant.method != "one-time-token" && grant.method != "reusable-dev-token" {
            return Err(error("access_denied", "A pairing code is required."));
        }
        let code = self.issue_code(validated, resource, access)?;
        if tx.commit().is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&code);
            }
            return Err(error("server_error", "Could not check pairing code."));
        }
        Ok(code)
    }

    /// Codes are consumed before their binding checks, including failed PKCE.
    pub(crate) fn exchange(
        &self,
        request: &Value,
        resource: &str,
    ) -> Result<GrantedCode, OAuthError> {
        if request["grant_type"] != "authorization_code" {
            return Err(error(
                "unsupported_grant_type",
                "Only authorization_code is supported.",
            ));
        }
        let required = |name: &str| {
            request[name]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    error(
                        "invalid_request",
                        "code, redirect_uri, client_id and code_verifier are required.",
                    )
                })
        };
        let code = required("code")?;
        let redirect = required("redirect_uri")?;
        let client_id = required("client_id")?;
        let verifier = required("code_verifier")?;
        if self.parse_client(client_id).is_none() {
            return Err(error("invalid_client", "The client is unknown."));
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| error("server_error", "Could not read authorization."))?
            .remove(code);
        let invalid = || {
            error(
                "invalid_grant",
                "The authorization code is invalid or expired.",
            )
        };
        let pending = pending.ok_or_else(invalid)?;
        if pending.expires <= Instant::now()
            || pending.client_id != client_id
            || pending.redirect != redirect
            || pending.resource != resource
            || !same_resource(resource, request["resource"].as_str())
            || !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        {
            return Err(invalid());
        }
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        mac.update(expected.as_bytes());
        let signature = mac.finalize().into_bytes();
        let mut verify = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        verify.update(pending.challenge.as_bytes());
        if verify.verify_slice(&signature).is_err() {
            return Err(invalid());
        }
        Ok(GrantedCode {
            access: pending.access,
            peer_link: pending.peer_link,
            label: pending.label,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_approval_is_session_and_request_bound_and_cannot_expand_scopes() {
        let oauth = McpOAuth::new([9; 32]);
        let client = oauth.register(&json!({"client_name":"browser fixture","redirect_uris":["http://127.0.0.1:4321/callback"]}), false).unwrap();
        let verifier = "a".repeat(43);
        let request = json!({"client_id":client.id,"redirect_uri":"http://127.0.0.1:4321/callback","response_type":"code","code_challenge_method":"S256","code_challenge":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),"resource":"http://127.0.0.1:1234/mcp"});
        let mut principal = crate::auth::Principal { session_id:"owner".into(), subject:"owner".into(), scopes:vec!["access:write".into(),"orchestration:read".into(),"orchestration:operate".into()], method:"browser-session-cookie".into(), jkt:None, rtc:None, peer_link:false };
        let (csrf, options) = oauth.browser_approval(&request,"http://127.0.0.1:1234/mcp",&principal).unwrap().unwrap();
        assert_eq!(options, vec!["read-only", "approval-required", "auto-accept-edits", "auto"]);
        assert!(oauth.approve_browser(&request,"http://127.0.0.1:1234/mcp",&principal,&csrf,"full-access").is_err());
        principal.session_id = "other".into();
        assert!(oauth.approve_browser(&request,"http://127.0.0.1:1234/mcp",&principal,&csrf,"read-only").is_err());
        principal.session_id = "owner".into();
        let mut changed = request.clone(); changed["code_challenge"] = json!("B".repeat(43));
        assert!(oauth.approve_browser(&changed,"http://127.0.0.1:1234/mcp",&principal,&csrf,"read-only").is_err());
        let code = oauth.approve_browser(&request,"http://127.0.0.1:1234/mcp",&principal,&csrf,"read-only").unwrap();
        let grant = oauth.exchange(&json!({"grant_type":"authorization_code","code":code,"client_id":client.id,"redirect_uri":"http://127.0.0.1:4321/callback","code_verifier":verifier,"resource":"http://127.0.0.1:1234/mcp"}),"http://127.0.0.1:1234/mcp").unwrap();
        assert_eq!(grant.access, "read-only");
        principal.scopes.retain(|scope| scope != "access:write");
        assert!(oauth.browser_approval(&request,"http://127.0.0.1:1234/mcp",&principal).unwrap().is_none());
    }

    #[test]
    fn client_registration_is_signed_and_redirects_are_constrained() {
        let oauth = McpOAuth::new([7; 32]);
        let registration = json!({"client_name":" Example ","redirect_uris":["http://127.0.0.1:1234/callback"],"software_id":"t3code-peer-link"});
        assert_eq!(
            oauth.register(&registration, false).unwrap_err().code,
            "invalid_client_metadata"
        );
        let client = oauth.register(&registration, true).unwrap();
        assert_eq!(client.name, "Example");
        assert!(oauth.parse_client(&client.id).unwrap().peer_link);
        assert!(oauth.parse_client(&(client.id.clone() + "x")).is_none());
        assert!(redirect_matches(
            "http://127.0.0.1:1234/callback",
            "http://127.0.0.1:9876/callback"
        ));
        assert!(!redirect_matches(
            "http://127.0.0.1:1234/callback",
            "http://127.0.0.1:9876/other"
        ));
        assert!(oauth
            .register(
                &json!({"redirect_uris":["http://example.invalid/callback"]}),
                true
            )
            .is_err());
    }

    #[test]
    fn client_name_limit_counts_utf16_units() {
        let oauth = McpOAuth::new([7; 32]);
        let client = oauth.register(&json!({"client_name":"🧪".repeat(51),"redirect_uris":["https://example.test/callback"]}), false).unwrap();
        assert_eq!(client.name, "🧪".repeat(50));
        let client = oauth.register(&json!({"client_name":format!("{}🧪", "x".repeat(99)),"redirect_uris":["https://example.test/callback"]}), false).unwrap();
        assert_eq!(client.name, "x".repeat(99));
    }

    #[test]
    fn redirect_length_uses_utf16_and_empty_resource_fragment_matches_url_semantics() {
        let oauth = McpOAuth::new([7; 32]);
        let unicode = format!("https://example.test/{}", "é".repeat(300));
        assert!(unicode.len() > 512);
        assert!(oauth.register(&json!({"redirect_uris":[unicode]}), false).is_ok());
        let too_long = format!("https://example.test/{}", "é".repeat(512));
        assert!(oauth.register(&json!({"redirect_uris":[too_long]}), false).is_err());
        assert!(same_resource("https://example.test/mcp", Some("https://example.test/mcp#")));
        assert!(!same_resource("https://example.test/mcp", Some("https://example.test/mcp#fragment")));
    }

    #[test]
    fn authorization_code_is_bound_and_consumed_even_on_bad_verifier() {
        let oauth = McpOAuth::new([9; 32]);
        let client = oauth
            .register(
                &json!({"client_name":"client","redirect_uris":["http://127.0.0.1/callback"]}),
                true,
            )
            .unwrap();
        let verifier = "a".repeat(43);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let auth = json!({"client_id":client.id,"redirect_uri":"http://127.0.0.1/callback","response_type":"code","code_challenge_method":"S256","code_challenge":challenge,"resource":"http://127.0.0.1:1234/mcp"});
        let code = oauth
            .authorize(&auth, "http://127.0.0.1:1234/mcp", "approval-required")
            .unwrap();
        let mut token = json!({"grant_type":"authorization_code","client_id":client.id,"redirect_uri":"http://127.0.0.1/callback","code":code,"code_verifier":"b".repeat(43),"resource":"http://127.0.0.1:1234/mcp"});
        assert_eq!(
            oauth
                .exchange(&token, "http://127.0.0.1:1234/mcp")
                .err()
                .unwrap()
                .code,
            "invalid_grant"
        );
        token["code_verifier"] = json!(verifier);
        assert_eq!(
            oauth
                .exchange(&token, "http://127.0.0.1:1234/mcp")
                .err()
                .unwrap()
                .code,
            "invalid_grant"
        );
        token["code"] = json!(oauth
            .authorize(&auth, "http://127.0.0.1:1234/mcp", "approval-required")
            .unwrap());
        let grant = oauth.exchange(&token, "http://127.0.0.1:1234/mcp").unwrap();
        assert_eq!(grant.access, "approval-required");
        assert!(!grant.peer_link);
        assert_eq!(grant.label, "client");
        assert_eq!(
            oauth
                .exchange(&token, "http://127.0.0.1:1234/mcp")
                .err()
                .unwrap()
                .code,
            "invalid_grant"
        );
    }

    #[test]
    fn pairing_is_consumed_only_after_oauth_validation() {
        let oauth = McpOAuth::new([3; 32]);
        let client = oauth.register(&json!({"redirect_uris":["http://127.0.0.1/callback"],"software_id":"t3code-peer-link"}), true).unwrap();
        let verifier = "a".repeat(43);
        let mut request = json!({"client_id":client.id,"redirect_uri":"http://127.0.0.1/callback","response_type":"code","code_challenge_method":"S256","code_challenge":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),"resource":"http://127.0.0.1:1234/mcp"});
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE auth_pairing_links(id TEXT PRIMARY KEY,credential TEXT UNIQUE,method TEXT,scopes TEXT,subject TEXT,label TEXT,proof_key_thumbprint TEXT,created_at TEXT,expires_at TEXT,consumed_at TEXT,revoked_at TEXT); INSERT INTO auth_pairing_links VALUES('one','23456789ABCD','one-time-token','[\"orchestration:read\"]','one-time-token',NULL,NULL,'2020','2999',NULL,NULL)").unwrap();
        let db = Mutex::new(conn);
        request["code_challenge_method"] = json!("plain");
        assert!(oauth
            .approve_pairing(
                &db,
                &request,
                "http://127.0.0.1:1234/mcp",
                "read-only",
                "23456789ABCD",
                "2026"
            )
            .is_err());
        let consumed: Option<String> = db
            .lock()
            .unwrap()
            .query_row("SELECT consumed_at FROM auth_pairing_links", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(consumed.is_none());
        request["code_challenge_method"] = json!("S256");
        assert_eq!(
            oauth
                .approve_pairing(
                    &db,
                    &request,
                    "http://127.0.0.1:1234/mcp",
                    "read-only",
                    "READ-23456789ABCD",
                    "2026"
                )
                .unwrap_err()
                .description,
            "Linking needs a plain pairing code, not an app approval code."
        );
        let code = oauth
            .approve_pairing(
                &db,
                &request,
                "http://127.0.0.1:1234/mcp",
                "read-only",
                "23456789ABCD",
                "2026",
            )
            .unwrap();
        let token = json!({"grant_type":"authorization_code","client_id":client.id,"redirect_uri":"http://127.0.0.1/callback","code":code,"code_verifier":verifier,"resource":"http://127.0.0.1:1234/mcp"});
        assert!(
            oauth
                .exchange(&token, "http://127.0.0.1:1234/mcp")
                .unwrap()
                .peer_link
        );
        assert!(oauth
            .approve_pairing(
                &db,
                &request,
                "http://127.0.0.1:1234/mcp",
                "read-only",
                "23456789ABCD",
                "2026"
            )
            .is_err());
    }

    #[test]
    fn issued_mcp_session_retains_mode_fence_and_revocation() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,subject TEXT,scopes TEXT,method TEXT,issued_at TEXT,expires_at TEXT,client_label TEXT,client_device_type TEXT,revoked_at TEXT)").unwrap();
        let db = Mutex::new(conn);
        let key = [4; 32];
        let result = issue_session(
            &db,
            &key,
            GrantedCode {
                access: "approval-required".into(),
                peer_link: true,
                label: "Peer".into(),
            },
            1_800_000_000_000,
        )
        .unwrap();
        let token = result["access_token"].as_str().unwrap();
        let principal =
            crate::auth::verify_session(&db.lock().unwrap(), &key, token, 1_800_000_000_001)
                .unwrap();
        assert_eq!(principal.subject, "mcp-client");
        assert_eq!(principal.rtc.as_deref(), Some("approval-required"));
        assert!(principal.peer_link);
        assert_eq!(
            principal.scopes,
            vec!["orchestration:read", "orchestration:operate"]
        );
        db.lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET revoked_at='2027-01-01T00:00:00.000Z'",
                [],
            )
            .unwrap();
        assert!(matches!(
            crate::auth::verify_session(&db.lock().unwrap(), &key, token, 1_800_000_000_001),
            Err(crate::auth::AuthError::Revoked)
        ));
    }
}
