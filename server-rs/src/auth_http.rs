//! HTTP browser pairing and session discovery. Mount `router` alongside the RPC router.
use crate::{
    auth::{self, SessionClaims},
    authorization, shared,
};
use axum::{
    body::Bytes,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct AuthHttpState {
    pub replay_dir: std::path::PathBuf,
    pub environment_descriptor: std::sync::OnceLock<Value>,
    pub cloud_action_lock: tokio::sync::Mutex<()>,
    pub cloud_generation: std::sync::atomic::AtomicU64,
    pub cloud_connector: crate::cloud_connector::Connector,
    pub listen_address: std::sync::OnceLock<std::net::SocketAddr>,
    pub db: Mutex<Connection>,
    pub lifecycle: crate::auth_access::Lifecycle,
    pub signing_key: [u8; 32],
    /// A fully resolved ServerAuthDescriptor, including sessionCookieName.
    pub descriptor: Value,
    /// Additional trusted browser origins, e.g. the configured dev URL.
    pub trusted_origins: Vec<String>,
    /// Enable reading the old t3_session cookie for migration.
    pub accept_legacy_cookie: bool,
    /// Desktop parent credentials, configured from the inherited bootstrap envelope.
    pub desktop_bootstrap: Option<auth::DesktopBootstrap>,
}

// Preserve the contract's order: OAuth scope output is ordered and the desktop
// grant includes relay:read before the access scopes.
const DESKTOP_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "source-control:write",
    "filesystem:read",
    "filesystem:write",
    "relay:read",
    "access:read",
    "access:write",
    "relay:write",
];
struct BootstrapGrant {
    method: String,
    scopes: Vec<String>,
    subject: String,
    label: Option<String>,
}
impl From<auth::PairingGrant> for BootstrapGrant {
    fn from(grant: auth::PairingGrant) -> Self {
        Self {
            method: grant.method,
            scopes: grant.scopes,
            subject: grant.subject,
            label: grant.label,
        }
    }
}
fn desktop_grant(state: &AuthHttpState, credential: &str, now_ms: i64) -> Option<BootstrapGrant> {
    state
        .desktop_bootstrap
        .as_ref()
        .filter(|source| source.matches(credential, now_ms))
        .map(|_| BootstrapGrant {
            method: "desktop-bootstrap".into(),
            scopes: DESKTOP_SCOPES
                .iter()
                .map(|scope| (*scope).to_owned())
                .collect(),
            subject: "desktop-bootstrap".into(),
            label: None,
        })
}
fn granted_scopes(requested: Option<Vec<String>>, grant: &[String]) -> Option<Vec<String>> {
    let scopes = match requested {
        Some(requested) => requested
            .into_iter()
            .filter(|scope| grant.contains(scope))
            .collect(),
        None => grant.to_vec(),
    };
    if scopes.is_empty() {
        None
    } else {
        Some(scopes)
    }
}
pub fn router(state: Arc<AuthHttpState>) -> Router {
    Router::new()
        .route("/api/auth/session", get(session))
        .route("/api/auth/browser-session", post(browser_session))
        .route("/api/auth/pairing-token", post(pairing_token))
        .route("/api/auth/pairing-links/revoke", post(revoke_pairing))
        .route("/api/auth/clients/revoke", post(revoke_client))
        .route(
            "/api/auth/clients/revoke-others",
            post(revoke_other_clients),
        )
        .route("/api/auth/websocket-ticket", post(websocket_ticket))
        .route("/api/connect/link-state", get(disabled_connect_state))
        .route("/api/connect/unlink", post(disabled_connect_unlink))
        .route(
            "/api/connect/preferences",
            post(disabled_connect_preferences),
        )
        .route("/api/connect/link-proof", post(disabled_connect_link_proof))
        .route(
            "/api/connect/relay-config",
            post(disabled_connect_relay_config),
        )
        .route("/api/connect/reachability", post(connect_reachability))
        .route("/api/t3-connect/health", post(t3_connect_health))
        .route(
            "/api/t3-connect/mint-credential",
            post(t3_connect_mint_credential),
        )
        .route(
            "/api/auth/websocket-ticket/{use}",
            post(websocket_ticket_for),
        )
        .route("/oauth/token", post(token_exchange))
        .with_state(state)
        .layer(axum::middleware::from_fn(capture_socket_peer))
}
async fn connect_reachability(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
) -> Response {
    let principal = match authenticate_at(
        &state,
        &headers,
        None,
        None,
        "POST",
        "/api/connect/reachability",
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, &headers),
    };
    if !principal.scopes.iter().any(|scope| scope == "relay:read") {
        return (StatusCode::FORBIDDEN,Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:read","requiredPermission":"relay:read","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    match std::fs::metadata(state.replay_dir.join("cloud-endpoint-runtime-config.bin")) {
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Json(json!({"status":"unreachable","checkedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"cause":"not_linked","reason":"The server has not set up a T3 Connect tunnel.","hint":null,"fix":"Run `t3 connect`, then restart T3 Code so it applies the link."})).into_response(),
        Err(_)=>internal(),
        Ok(_)=>match state.cloud_connector.is_running().await {
            Ok(false)=>Json(json!({"status":"unreachable","checkedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"cause":"connector_not_running","reason":"The tunnel client (cloudflared) is not running.","hint":null,"fix":"Restart T3 Code. If it stays down, check the server log for relay client errors."})).into_response(),
            Ok(true)=>{
                let (ready,hostname)=tokio::join!(state.cloud_connector.ready_connections(),state.cloud_connector.hostname());
                if let Some(hostname)=hostname.filter(|_|ready!=Some(0)) {
                    let Some(result)=crate::cloud_reachability::probe(&hostname).await else{return (StatusCode::SERVICE_UNAVAILABLE,"Connect tunnel reachability is unavailable.").into_response()};
                    let checked=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
                    let (status,code)=match result {
                        crate::cloud_reachability::Probe::Response(status,code)=>(status,code),
                        crate::cloud_reachability::Probe::DnsFailed=>{
                            let (public,exit)=tokio::join!(crate::cloud_reachability::public_dns(&hostname),crate::cloud_reachability::exit_node());
                            let (reason,fix)=match public {
                                Some(true)=>("The T3 Connect address resolves in public DNS, but this network's DNS still has an old cached answer that it does not exist.","Wait. The cached answer usually clears within about 30 minutes."),
                                Some(false)=>("The T3 Connect address is missing from public DNS. The relay did not publish it.","Restart T3 Code. If it stays, run `t3 connect` again."),
                                None=>("The T3 Connect address does not resolve from this machine.","Check the DNS settings on this machine or its VPN."),
                            };
                            return Json(json!({"status":"unreachable","checkedAt":checked,"cause":"dns_failed","reason":reason,"hint":crate::cloud_reachability::exit_node_hint(exit.as_ref()),"fix":fix})).into_response();
                        },
                        crate::cloud_reachability::Probe::TimedOut=>{let exit=crate::cloud_reachability::exit_node().await;return Json(json!({"status":"unreachable","checkedAt":checked,"cause":"timeout","reason":"The T3 Connect address did not answer from this machine.","hint":crate::cloud_reachability::exit_node_hint(exit.as_ref()),"fix":"Check the network, VPN, or proxy on this machine."})).into_response()},
                    };
                    if status==200 {return Json(json!({"status":"reachable","checkedAt":checked,"readyConnections":ready,"protocol":state.cloud_connector.protocol().await})).into_response();}
                    let (cause,reason,fix)=crate::cloud_reachability::classify_http(status,code.as_deref());
                    return Json(json!({"status":"unreachable","checkedAt":checked,"cause":cause,"reason":reason,"hint":null,"fix":fix})).into_response();
                }
                let probe=|host:&'static str|async move {tokio::time::timeout(Duration::from_secs(5),tokio::net::TcpStream::connect((host,7844))).await.is_ok_and(|result|result.is_ok())};
                let (first,second,exit)=if ready.is_some_and(|connections|connections>0){(true,false,None)}else{tokio::join!(probe("region1.v2.argotunnel.com"),probe("region2.v2.argotunnel.com"),crate::cloud_reachability::exit_node())};
                let (cause,reason,hint,fix)=if first||second {("connector_not_ready","cloudflared has not connected to Cloudflare yet.",None,"Wait a minute. If it stays, check the network and the server log.")}else{("edge_unreachable","Cloudflare's tunnel port (7844) times out from this machine.",crate::cloud_reachability::exit_node_hint(exit.as_ref()).or_else(||Some("A VPN, proxy, or firewall may block it.".to_owned())),if exit.is_some(){"tailscale set --exit-node=   (or allow outbound 7844 on that network)"}else{"Allow outbound TCP and UDP port 7844, or turn off the VPN or firewall that blocks it."})};
                Json(json!({"status":"unreachable","checkedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"cause":cause,"reason":reason,"hint":hint,"fix":fix})).into_response()
            },
            Err(_)=>internal(),
        },
    }
}

struct VerifiedCloudProof {
    nonce: String,
    claims: Value,
    environment_id: String,
    descriptor: Value,
    normalized_issuer: String,
}

enum CloudProofError {
    BadRequest(&'static str),
    Unauthorized(&'static str),
    Conflict(&'static str),
    Internal,
}

impl CloudProofError {
    fn into_response(self) -> Response {
        match self {
            Self::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"_tag": "EnvironmentHttpBadRequestError", "message": message})),
            )
                .into_response(),
            Self::Unauthorized(message) => (
                StatusCode::UNAUTHORIZED,
                Json(json!({"_tag": "EnvironmentHttpUnauthorizedError", "message": message})),
            )
                .into_response(),
            Self::Conflict(message) => (
                StatusCode::CONFLICT,
                Json(json!({"_tag": "EnvironmentHttpConflictError", "message": message})),
            )
                .into_response(),
            Self::Internal => internal(),
        }
    }
}

fn read_cloud_secret(dir: &std::path::Path, name: &str) -> Result<Option<String>, CloudProofError> {
    match std::fs::read_to_string(dir.join(format!("{name}.bin"))) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(CloudProofError::Internal),
    }
}

fn parse_ed25519_spki_pem(pem: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let normalized = pem.replace("\\n", "\n");
    let body = normalized
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")?
        .strip_suffix("-----END PUBLIC KEY-----")?;
    let der = STANDARD
        .decode(body.split_whitespace().collect::<String>())
        .ok()?;
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() == 44 && der.starts_with(&PREFIX) {
        Some(der[12..].to_vec())
    } else {
        None
    }
}

fn consume_cloud_replay_guard(
    dir: &std::path::Path,
    kind: &str,
    value: &str,
) -> Result<(), CloudProofError> {
    use std::io::Write as _;
    let digest = ring::digest::digest(&ring::digest::SHA256, value.as_bytes());
    let mut hex = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    let path = dir.join(format!("cloud-{kind}-{hex}.bin"));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            let _ = file.write_all(b"1");
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
            CloudProofError::Conflict("Cloud proof has already been used."),
        ),
        Err(_) => Err(CloudProofError::Internal),
    }
}

fn verify_cloud_request_proof(
    state: &AuthHttpState,
    body: &[u8],
    expected_typ: &str,
    expected_scope: &str,
    guard_prefix: &str,
) -> Result<VerifiedCloudProof, CloudProofError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ring::signature::{UnparsedPublicKey, ED25519};

    let Ok(payload) = serde_json::from_slice::<Value>(body) else {
        return Err(CloudProofError::BadRequest("Invalid Connect request"));
    };
    let Some(token) = payload["proof"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(CloudProofError::BadRequest("Invalid Connect request"));
    };

    let public_key_pem = read_cloud_secret(&state.replay_dir, "cloud-mint-ed25519-public-key")?
        .ok_or(CloudProofError::Internal)?;
    let raw_public_key = parse_ed25519_spki_pem(&public_key_pem).ok_or(CloudProofError::Internal)?;
    let issuer = match read_cloud_secret(&state.replay_dir, "cloud-relay-issuer")? {
        Some(value) => value,
        None => read_cloud_secret(&state.replay_dir, "cloud-relay-url")?
            .ok_or(CloudProofError::Internal)?,
    };
    let normalized_issuer = issuer.trim().trim_end_matches('/').to_owned();
    let descriptor = state
        .environment_descriptor
        .get()
        .cloned()
        .ok_or(CloudProofError::Internal)?;
    let environment_id = descriptor["environmentId"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(CloudProofError::Internal)?
        .to_owned();
    let linked_user_id = read_cloud_secret(&state.replay_dir, "cloud-linked-user-id")?
        .ok_or(CloudProofError::BadRequest(
            "This environment is not linked to T3 Connect.",
        ))?;

    let mut parts = token.split('.');
    let (Some(header_b64), Some(claims_b64), Some(sig_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(CloudProofError::Unauthorized("Cloud proof was rejected."));
    };
    let header: Value = URL_SAFE_NO_PAD
        .decode(header_b64)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or(CloudProofError::Unauthorized("Cloud proof was rejected."))?;
    if header["alg"].as_str() != Some("EdDSA") || header["typ"].as_str() != Some(expected_typ) {
        return Err(CloudProofError::Unauthorized("Cloud proof was rejected."));
    }
    let signature = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .ok()
        .ok_or(CloudProofError::Unauthorized("Cloud proof was rejected."))?;
    UnparsedPublicKey::new(&ED25519, &raw_public_key)
        .verify(format!("{header_b64}.{claims_b64}").as_bytes(), &signature)
        .map_err(|_| CloudProofError::Unauthorized("Cloud proof was rejected."))?;

    let claims: Value = URL_SAFE_NO_PAD
        .decode(claims_b64)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or(CloudProofError::Unauthorized("Cloud proof was rejected."))?;
    let nonempty = |key: &str| {
        claims[key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let (Some(iss), Some(aud), Some(sub), Some(jti), Some(claim_env), Some(nonce)) = (
        nonempty("iss"),
        nonempty("aud"),
        nonempty("sub"),
        nonempty("jti"),
        nonempty("environmentId"),
        nonempty("nonce"),
    ) else {
        return Err(CloudProofError::Unauthorized("Cloud proof was rejected."));
    };
    let (Some(iat), Some(exp)) = (claims["iat"].as_i64(), claims["exp"].as_i64()) else {
        return Err(CloudProofError::Unauthorized("Cloud proof was rejected."));
    };
    let now_secs = chrono::Utc::now().timestamp();
    let scopes = claims["scope"].as_array();
    let scope_ok = scopes.is_some_and(|list| {
        list.len() == 1 && list[0].as_str() == Some(expected_scope)
    });
    if iss != normalized_issuer
        || aud != format!("t3-env:{environment_id}")
        || sub != linked_user_id.trim()
        || claim_env != environment_id
        || !scope_ok
        || exp <= iat
        || exp - iat > 300
        || iat > now_secs.saturating_add(60)
        || exp <= now_secs.saturating_sub(60)
    {
        return Err(CloudProofError::Unauthorized("Cloud proof was rejected."));
    }

    consume_cloud_replay_guard(&state.replay_dir, &format!("{guard_prefix}-jti"), jti)?;
    consume_cloud_replay_guard(&state.replay_dir, &format!("{guard_prefix}-nonce"), nonce)?;

    Ok(VerifiedCloudProof {
        nonce: nonce.to_owned(),
        claims,
        environment_id,
        descriptor,
        normalized_issuer,
    })
}

async fn t3_connect_health(State(state): State<Arc<AuthHttpState>>, body: Bytes) -> Response {
    let verified = match verify_cloud_request_proof(
        &state,
        &body,
        "t3-cloud-health+jwt",
        "environment:status",
        "health",
    ) {
        Ok(verified) => verified,
        Err(error) => return error.into_response(),
    };
    let Ok(signing_key) = crate::cloud_link_key::load_or_create(&state.replay_dir) else {
        return internal();
    };
    let now = chrono::Utc::now();
    let now_secs = now.timestamp();
    let checked_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let response_payload = json!({
        "iss": format!("t3-env:{}", verified.environment_id),
        "aud": verified.normalized_issuer,
        "sub": verified.environment_id,
        "jti": Uuid::new_v4().to_string(),
        "iat": now_secs,
        "exp": now_secs + 300,
        "environmentId": verified.environment_id,
        "requestNonce": verified.nonce,
        "status": "online",
        "descriptor": verified.descriptor,
        "checkedAt": checked_at,
    });
    let Ok(proof) = signing_key.sign_typed("t3-env-health+jwt", &response_payload) else {
        return internal();
    };
    let mut response = Json(json!({
        "environmentId": verified.environment_id,
        "status": "online",
        "descriptor": verified.descriptor,
        "checkedAt": checked_at,
        "proof": proof,
    }))
    .into_response();
    no_store(&mut response);
    response
}

async fn t3_connect_mint_credential(
    State(state): State<Arc<AuthHttpState>>,
    body: Bytes,
) -> Response {
    let verified = match verify_cloud_request_proof(
        &state,
        &body,
        "t3-cloud-mint+jwt",
        "environment:connect",
        "mint",
    ) {
        Ok(verified) => verified,
        Err(error) => return error.into_response(),
    };
    let Some(thumbprint) = verified.claims["clientProofKeyThumbprint"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return CloudProofError::Unauthorized("Cloud proof was rejected.").into_response();
    };
    if verified.claims["cnf"]["jkt"].as_str().map(str::trim) != Some(thumbprint) {
        return CloudProofError::Unauthorized("Cloud proof was rejected.").into_response();
    }
    let Ok(now) = now_ms() else {
        return internal();
    };
    let expires_ms = now.saturating_add(120_000);
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let (Ok(created_at), Ok(expires_at), Ok(credential), Ok(scopes_json)) = (
        iso(&db, now),
        iso(&db, expires_ms),
        auth::generate_pairing_code(),
        serde_json::to_string(&auth::STANDARD_CLIENT_SCOPES),
    ) else {
        return internal();
    };
    let id = Uuid::new_v4().to_string();
    if db
        .execute(
            "INSERT INTO auth_pairing_links (id,credential,method,scopes,subject,label,proof_key_thumbprint,created_at,expires_at,consumed_at,revoked_at) VALUES (?1,?2,'one-time-token',?3,'cloud-connect','T3 Connect connect',?4,?5,?6,NULL,NULL)",
            params![id, credential, scopes_json, thumbprint, created_at, expires_at],
        )
        .is_err()
    {
        return internal();
    }
    drop(db);
    state.lifecycle.notify();
    let Ok(signing_key) = crate::cloud_link_key::load_or_create(&state.replay_dir) else {
        return internal();
    };
    let now_secs = now / 1000;
    let exp_secs = expires_ms / 1000;
    let response_payload = json!({
        "iss": format!("t3-env:{}", verified.environment_id),
        "aud": verified.normalized_issuer,
        "sub": verified.environment_id,
        "jti": Uuid::new_v4().to_string(),
        "iat": now_secs,
        "exp": exp_secs,
        "environmentId": verified.environment_id,
        "clientProofKeyThumbprint": thumbprint,
        "requestNonce": verified.nonce,
        "credential": credential,
    });
    let Ok(proof) = signing_key.sign_typed("t3-env-mint+jwt", &response_payload) else {
        return internal();
    };
    let mut response = Json(json!({
        "credential": credential,
        "expiresAt": expires_at,
        "proof": proof,
    }))
    .into_response();
    no_store(&mut response);
    response
}
const INTERNAL_PEER_HEADER: &str = "x-t3-internal-socket-peer";
#[derive(Clone)]
pub(crate) struct SocketPeer(std::net::SocketAddr);
impl
    axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>>
    for SocketPeer
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        Self(*stream.remote_addr())
    }
}
impl
    axum::extract::connect_info::Connected<
        axum::serve::IncomingStream<'_, crate::startup_access::PrivateNetworkListener>,
    > for SocketPeer
{
    fn connect_info(
        stream: axum::serve::IncomingStream<'_, crate::startup_access::PrivateNetworkListener>,
    ) -> Self {
        Self(*stream.remote_addr())
    }
}
async fn capture_socket_peer(
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketPeer>>()
        .map(|peer| match peer.0 .0.ip() {
            std::net::IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map_or_else(|| ip.to_string(), |mapped| mapped.to_string()),
            ip => ip.to_string(),
        });
    request.headers_mut().remove(INTERNAL_PEER_HEADER);
    if let Some(peer) = peer.and_then(|peer| HeaderValue::from_str(&peer).ok()) {
        request.headers_mut().insert(INTERNAL_PEER_HEADER, peer);
    }
    next.run(request).await
}
fn socket_peer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(INTERNAL_PEER_HEADER)
        .and_then(|value| value.to_str().ok())
}
async fn disabled_connect_state(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
) -> Response {
    let principal = match authenticate_at(
        &state,
        &headers,
        None,
        None,
        "GET",
        "/api/connect/link-state",
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, &headers),
    };
    if !principal.scopes.iter().any(|scope| scope == "relay:read") {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:read","requiredPermission":"relay:read","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    let linkable = connect_linkable_here(&headers, &principal.subject);
    match crate::managed_policy::allows_connect() {
        Ok(false) => Json(json!({"linked":false,"cloudUserId":null,"relayUrl":null,"relayIssuer":null,"managedTunnelActive":false,"publishAgentActivity":false,"holdWebhooksWhileOffline":false,"linkRevoked":false,"linkableHere":linkable})).into_response(),
        Ok(true) => match connect_link_state(&state.replay_dir) {
            Ok(mut value) => { value["linkableHere"] = json!(linkable); Json(value).into_response() },
            Err(_) => internal(),
        },
        Err(_) => internal(),
    }
}
fn connect_linkable_here(headers: &HeaderMap, subject: &str) -> bool {
    if subject != "desktop-bootstrap" {
        return false;
    }
    for name in ["x-forwarded-host", "x-forwarded-proto"] {
        if headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| !value.split(',').next().unwrap_or("").trim().is_empty())
        {
            return false;
        }
    }
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    url::Url::parse(&format!("http://{host}/api/connect/link-state")).is_ok()
}
async fn disabled_connect_unlink(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
) -> Response {
    let principal =
        match authenticate_at(&state, &headers, None, None, "POST", "/api/connect/unlink") {
            Ok(principal) => principal,
            Err(error) => return auth_failure(error, &headers),
        };
    if !principal.scopes.iter().any(|scope| scope == "relay:write") {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:write","requiredPermission":"relay:write","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    let _action = state.cloud_action_lock.lock().await;
    state
        .cloud_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    if state.cloud_connector.stop().await.is_err() {
        return internal();
    }
    match crate::managed_policy::allows_connect() {
        Ok(false) => match crate::cloud_link_config::unlink(&state.replay_dir) {
            Ok(()) => Json(json!({"ok":true,"endpointRuntimeStatus":{"status":"disabled"}}))
                .into_response(),
            Err(_) => internal(),
        },
        Ok(true) => match crate::cloud_link_config::unlink(&state.replay_dir) {
            Ok(()) => Json(json!({"ok":true,"endpointRuntimeStatus":{"status":"disabled"}}))
                .into_response(),
            Err(_) => internal(),
        },
        Err(_) => internal(),
    }
}
fn connect_link_state(dir: &std::path::Path) -> std::io::Result<Value> {
    let read = |name: &str| -> std::io::Result<Option<String>> {
        match std::fs::read_to_string(dir.join(format!("{name}.bin"))) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    };
    let user = read("cloud-linked-user-id")?;
    let relay = read("cloud-relay-url")?;
    let issuer = read("cloud-relay-issuer")?;
    let active = read("cloud-endpoint-runtime-config")?.is_some();
    let publish = read("cloud-publish-agent-activity")?.as_deref() == Some("true");
    let hold = read("cloud-hold-webhooks-while-offline")?.as_deref() == Some("true");
    let revoked = user.is_some() && read("cloud-link-revoked")?.is_some();
    Ok(
        json!({"linked":user.is_some(),"cloudUserId":user,"relayUrl":relay,"relayIssuer":issuer,"managedTunnelActive":active,"publishAgentActivity":publish,"holdWebhooksWhileOffline":hold,"linkRevoked":revoked}),
    )
}
async fn disabled_connect_preferences(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let principal = match authenticate_at(
        &state,
        &headers,
        None,
        None,
        "POST",
        "/api/connect/preferences",
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, &headers),
    };
    if !principal.scopes.iter().any(|scope| scope == "relay:write") {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:write","requiredPermission":"relay:write","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    if !input["publishAgentActivity"].is_boolean()
        || input
            .get("holdWebhooksWhileOffline")
            .is_some_and(|value| !value.is_boolean())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"_tag":"HttpApiDecodeError","message":"Invalid Connect preferences"})),
        )
            .into_response();
    }
    match crate::managed_policy::connect_denial() {
        Ok(Some(message)) => (
            StatusCode::FORBIDDEN,
            Json(json!({"_tag":"EnvironmentHttpForbiddenError","message":message})),
        )
            .into_response(),
        Ok(None) => {
            let publish = input["publishAgentActivity"].as_bool().unwrap_or(false);
            if std::fs::write(
                state.replay_dir.join("cloud-publish-agent-activity.bin"),
                if publish { "true" } else { "false" },
            )
            .is_err()
            {
                return internal();
            }
            if let Some(hold) = input.get("holdWebhooksWhileOffline").and_then(Value::as_bool) {
                if std::fs::write(
                    state.replay_dir.join("cloud-hold-webhooks-while-offline.bin"),
                    if hold { "true" } else { "false" },
                )
                .is_err()
                {
                    return internal();
                }
            }
            match connect_link_state(&state.replay_dir) {
                Ok(link_state) => (StatusCode::OK, Json(link_state)).into_response(),
                Err(_) => internal(),
            }
        }
        Err(_) => internal(),
    }
}
async fn disabled_connect_link_proof(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let endpoint = &input["endpoint"];
    let origin = &input["origin"];
    let nonempty = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    let valid = input["challenge"].is_string()
        && input["relayIssuer"].is_string()
        && nonempty(&endpoint["httpBaseUrl"])
        && nonempty(&endpoint["wsBaseUrl"])
        && matches!(
            endpoint["providerKind"].as_str(),
            Some("manual" | "cloudflare_tunnel" | "t3_relay")
        )
        && nonempty(&origin["localHttpHost"])
        && origin["localHttpPort"]
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port));
    let principal = match authenticate_at(
        &state,
        &headers,
        None,
        None,
        "POST",
        "/api/connect/link-proof",
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, &headers),
    };
    if !principal.scopes.iter().any(|scope| scope == "relay:write") {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:write","requiredPermission":"relay:write","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"_tag":"HttpApiDecodeError","message":"Invalid Connect request"})),
        )
            .into_response();
    }
    match crate::managed_policy::connect_denial() {
        Ok(Some(message)) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"_tag":"EnvironmentHttpForbiddenError","message":message})),
            )
                .into_response()
        }
        Err(_) => return internal(),
        Ok(None) => {}
    }
    let forwarded = ["x-forwarded-host", "x-forwarded-proto"]
        .iter()
        .any(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| !value.split(',').next().unwrap_or("").trim().is_empty())
        });
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    let request_url = url::Url::parse(&format!("http://{host}/api/connect/link-proof"));
    let local_host = origin["localHttpHost"]
        .as_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let supported = matches!(
        endpoint["providerKind"].as_str(),
        Some("manual" | "cloudflare_tunnel")
    );
    let allowed = request_url.as_ref().is_ok_and(|url| {
        let request_host = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        let loopback = |host: &str| matches!(host, "127.0.0.1" | "::1" | "localhost");
        loopback(&local_host)
            && (principal.subject == "desktop-bootstrap" || loopback(&request_host))
            && origin["localHttpPort"].as_u64() == url.port_or_known_default().map(u64::from)
    });
    if forwarded || !supported || !allowed {
        return (StatusCode::BAD_REQUEST,Json(json!({"_tag":"EnvironmentHttpBadRequestError","message":"Invalid managed endpoint origin."}))).into_response();
    }
    let Some(descriptor) = state.environment_descriptor.get() else {
        return internal();
    };
    let Some(environment_id) = descriptor["environmentId"].as_str() else {
        return internal();
    };
    let key = match crate::cloud_link_key::load_or_create(&state.replay_dir) {
        Ok(value) => value,
        Err(_) => return internal(),
    };
    use base64::Engine as _;
    let now = match now_ms() {
        Ok(value) => value / 1000,
        Err(_) => return internal(),
    };
    let challenge = input["challenge"].as_str().unwrap_or("");
    let mut parts = challenge.split('.');
    let issued = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(body), Some(_signature), None) => {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(header)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(Value::is_object)
                .and_then(|_| {
                    base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .decode(body)
                        .ok()
                })
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|claims| claims["iat"].as_i64())
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        }
        _ => None,
    }
    .unwrap_or(now);
    let scopes = if endpoint["providerKind"] == "cloudflare_tunnel" {
        json!(["agent_activity_notifications", "managed_tunnels"])
    } else {
        json!(["agent_activity_notifications"])
    };
    let payload = json!({"iss":format!("t3-env:{environment_id}"),"aud":input["relayIssuer"].as_str().unwrap_or("").trim().trim_end_matches('/'),"sub":environment_id,"jti":Uuid::new_v4().to_string(),"iat":issued,"exp":issued.saturating_add(300),"challenge":challenge,"descriptor":descriptor,"environmentId":environment_id,"environmentPublicKey":key.public_key.trim(),"endpoint":endpoint,"origin":origin,"scopes":scopes});
    match key.sign(&payload) {
        Ok(proof) => {
            let mut response = Json(proof).into_response();
            no_store(&mut response);
            response
        }
        Err(_) => internal(),
    }
}
async fn disabled_connect_relay_config(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let runtime = &input["endpointRuntime"];
    let valid_runtime = runtime.is_null()
        || (matches!(
            runtime["providerKind"].as_str(),
            Some("manual" | "cloudflare_tunnel" | "t3_relay")
        ) && runtime["connectorToken"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
            && ["tunnelId", "tunnelName"].iter().all(|key| {
                runtime.get(*key).is_none_or(|value| {
                    value.as_str().is_some_and(|value| !value.trim().is_empty())
                })
            }));
    let valid = [
        "relayUrl",
        "cloudUserId",
        "environmentCredential",
        "cloudMintPublicKey",
    ]
    .iter()
    .all(|key| input[*key].is_string())
        && input.get("relayIssuer").is_none_or(Value::is_string)
        && input.get("endpointRuntime").is_some()
        && valid_runtime;
    let principal = match authenticate_at(
        &state,
        &headers,
        None,
        None,
        "POST",
        "/api/connect/relay-config",
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, &headers),
    };
    if !principal.scopes.iter().any(|scope| scope == "relay:write") {
        return (StatusCode::FORBIDDEN,Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"relay:write","requiredPermission":"relay:write","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"_tag":"HttpApiDecodeError","message":"Invalid Connect request"})),
        )
            .into_response();
    }
    match crate::managed_policy::connect_denial() {
        Ok(Some(message)) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"_tag":"EnvironmentHttpForbiddenError","message":message})),
            )
                .into_response()
        }
        Err(_) => return internal(),
        Ok(None) => {}
    }
    let _action = state.cloud_action_lock.lock().await;
    let outcome = match crate::cloud_link_config::validate(&state.replay_dir, &input) {
        Ok(()) => {
            state
                .cloud_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            if state.cloud_connector.stop().await.is_err() {
                return internal();
            }
            crate::cloud_link_config::apply(&state.replay_dir, &input)
        }
        Err(error) => Err(error),
    };
    match outcome{
        Ok(())=>Json(json!({"ok":true,"endpointRuntimeStatus":{"status":"disabled"}})).into_response(),
        Err(crate::cloud_link_config::Error::Invalid(message))=>(StatusCode::BAD_REQUEST,Json(json!({"_tag":"EnvironmentHttpBadRequestError","message":message}))).into_response(),
        Err(crate::cloud_link_config::Error::AccountMismatch)=>(StatusCode::CONFLICT,Json(json!({"_tag":"EnvironmentHttpConflictError","message":"This environment is already linked to a different cloud account. Unlink it before switching accounts."}))).into_response(),
        Err(crate::cloud_link_config::Error::OriginUnconfirmed)=>(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"_tag":"EnvironmentCloudEndpointUnavailableError","message":"Managed endpoint origin could not be confirmed.","endpointRuntimeStatus":{"status":"disabled"}}))).into_response(),
        Err(crate::cloud_link_config::Error::NeedsRegistration)=>{let generation=state.cloud_generation.load(std::sync::atomic::Ordering::Acquire);drop(_action);register_and_start_connector(&state,&input,generation).await},
        Err(crate::cloud_link_config::Error::Unsupported) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "_tag": "EnvironmentCloudEndpointUnavailableError",
                "message": "Managed Connect tunnel is unavailable.",
                "endpointRuntimeStatus": {"status": "disabled"}
            })),
        )
            .into_response(),
        Err(crate::cloud_link_config::Error::Storage)=>internal(),
    }
}
async fn register_and_start_connector(
    state: &AuthHttpState,
    input: &Value,
    generation: u64,
) -> Response {
    let unavailable = || {
        (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"_tag":"EnvironmentCloudEndpointUnavailableError","message":"Managed endpoint origin could not be confirmed.","endpointRuntimeStatus":{"status":"disabled"}}))).into_response()
    };
    let Some(address) = state.listen_address.get() else {
        return internal();
    };
    let Some(descriptor) = state.environment_descriptor.get() else {
        return internal();
    };
    let Some(environment) = descriptor["environmentId"].as_str() else {
        return internal();
    };
    let Some(tunnel) = input["endpointRuntime"]["tunnelId"].as_str() else {
        return internal();
    };
    let relay = input["relayUrl"].as_str().unwrap_or("");
    let issuer = input["relayIssuer"].as_str().unwrap_or(relay);
    let origin = json!({"localHttpHost":if address.is_ipv6(){"::1"}else{"127.0.0.1"},"localHttpPort":address.port()});
    let key = match crate::cloud_link_key::load_or_create(&state.replay_dir) {
        Ok(key) => key,
        Err(_) => return internal(),
    };
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        use std::io::Read as _;
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(_) => return internal(),
        };
        let mut bytes = Vec::new();
        if file.take(1024 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 * 1024
        {
            return internal();
        }
        let certificates = match reqwest::Certificate::from_pem_bundle(&bytes) {
            Ok(certificates) => certificates,
            Err(_) => return internal(),
        };
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(_) => return internal(),
    };
    let mut registered = Err("Relay registration failed".to_owned());
    for _ in 0..3 {
        registered = crate::cloud_connector::register(
            &client,
            relay,
            issuer,
            input["environmentCredential"].as_str().unwrap_or(""),
            input["cloudUserId"].as_str().unwrap_or(""),
            environment,
            tunnel,
            &origin,
            &key,
        )
        .await;
        if !matches!(
            registered,
            Err(_) | Ok(crate::cloud_connector::Registration::Unavailable(..))
        ) {
            break;
        }
    }
    let _action = state.cloud_action_lock.lock().await;
    if state
        .cloud_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != generation
    {
        return (StatusCode::CONFLICT,Json(json!({"_tag":"EnvironmentHttpConflictError","message":"The managed tunnel configuration changed during registration."}))).into_response();
    }
    match crate::cloud_link_config::is_current(&state.replay_dir,input) {
        Ok(true)=>{},
        Ok(false)=>return (StatusCode::CONFLICT,Json(json!({"_tag":"EnvironmentHttpConflictError","message":"The managed tunnel configuration changed during registration."}))).into_response(),
        Err(_)=>return internal(),
    }
    match registered {
        Ok(crate::cloud_connector::Registration::Ready) => {}
        Ok(crate::cloud_connector::Registration::Unauthorized) => {
            if crate::cloud_link_config::mark_revoked(&state.replay_dir).is_err() {
                return internal();
            }
            return unavailable();
        }
        Ok(crate::cloud_connector::Registration::Rejected(code, description))
        | Ok(crate::cloud_connector::Registration::Unavailable(code, description, _)) => {
            let message=description.unwrap_or_else(||format!("T3 Connect relay returned HTTP {code} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart T3 Code."));
            let (status, tag) = if code == 403 {
                (StatusCode::FORBIDDEN, "EnvironmentHttpForbiddenError")
            } else if (400..500).contains(&code) && !matches!(code, 401 | 408 | 429) {
                (StatusCode::BAD_REQUEST, "EnvironmentHttpBadRequestError")
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "EnvironmentHttpInternalServerError",
                )
            };
            return (status, Json(json!({"_tag":tag,"message":message}))).into_response();
        }
        Err(error) => {
            let detail = if error == "Relay registration failed" {
                "The relay request failed (TransportError)."
            } else {
                "The relay returned an unexpected response."
            };
            let message=format!("Could not complete the T3 Connect relay request. {detail} Check this machine's network connection and relay availability, then retry.");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"_tag":"EnvironmentHttpInternalServerError","message":message})),
            )
                .into_response();
        }
        _ => return unavailable(),
    }
    let pid = match state
        .cloud_connector
        .start(
            input["endpointRuntime"]["connectorToken"]
                .as_str()
                .unwrap_or(""),
            &state.replay_dir,
        )
        .await
    {
        Ok(pid) => pid,
        Err(_) => return unavailable(),
    };
    if crate::cloud_link_config::confirm_origin(
        &state.replay_dir,
        &input["endpointRuntime"],
        &origin,
    )
    .is_err()
    {
        let _ = state.cloud_connector.stop().await;
        return internal();
    }
    let mut status = json!({"status":"running","providerKind":"cloudflare_tunnel","pid":pid});
    for key in ["tunnelId", "tunnelName"] {
        if let Some(value) = input["endpointRuntime"].get(key) {
            status[key] = value.clone();
        }
    }
    Json(json!({"ok":true,"endpointRuntimeStatus":status})).into_response()
}
fn now_ms() -> Result<i64, ()> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis(),
    )
    .map_err(|_| ())
}
fn iso(db: &Connection, ms: i64) -> Result<String, rusqlite::Error> {
    db.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1 / 1000.0, 'unixepoch')",
        [ms],
        |r| r.get(0),
    )
}
fn cookie_name(state: &AuthHttpState) -> Option<&str> {
    state
        .descriptor
        .get("sessionCookieName")?
        .as_str()
        .filter(|n| {
            !n.is_empty()
                && n.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
}
fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name && !value.is_empty()).then_some(value))
}
fn trusted_cookie_origin(state: &AuthHttpState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if state
        .trusted_origins
        .iter()
        .any(|allowed| allowed == origin)
        || origin == "t3code://app"
        || origin == "t3code-dev://app"
    {
        return true;
    }
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("same-origin") {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let origin_host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    [header::HOST.as_str(), "x-forwarded-host"]
        .iter()
        .any(|name| {
            headers
                .get(*name)
                .and_then(|h| h.to_str().ok())
                .and_then(|h| h.split(',').next())
                .is_some_and(|h| h.trim().eq_ignore_ascii_case(&origin_host))
        })
}
struct Credential<'a> {
    token: &'a str,
    legacy: bool,
    dpop: bool,
}
/// Selection never falls back after a selected credential fails verification.
fn select_credential<'a>(state: &AuthHttpState, headers: &'a HeaderMap) -> Option<Credential<'a>> {
    let name = cookie_name(state)?;
    if let Some(token) = cookie_value(headers, name) {
        return trusted_cookie_origin(state, headers).then_some(Credential {
            token,
            legacy: false,
            dpop: false,
        });
    }
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        let value = auth.to_str().ok()?;
        let (scheme, token) = value.split_once(' ')?;
        if !(scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("dpop"))
            || token.trim().is_empty()
        {
            return None;
        }
        return Some(Credential {
            token: token.trim(),
            legacy: false,
            dpop: scheme.eq_ignore_ascii_case("dpop"),
        });
    }
    if state.accept_legacy_cookie {
        if let Some(token) = cookie_value(headers, "t3_session") {
            return trusted_cookie_origin(state, headers).then_some(Credential {
                token,
                legacy: true,
                dpop: false,
            });
        }
    }
    None
}
fn request_url(headers: &HeaderMap, path: &str) -> Option<String> {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))?
        .to_str()
        .ok()?
        .split(',')
        .next()?
        .trim();
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .unwrap_or("http")
        .trim();
    if !["http", "https"].contains(&scheme) {
        return None;
    }
    Some(format!("{scheme}://{host}{path}"))
}
#[allow(clippy::too_many_arguments)]
fn verify_proof(
    state: &AuthHttpState,
    headers: &HeaderMap,
    proof: Option<&str>,
    method: &str,
    path: &str,
    key: Option<&str>,
    token: Option<&str>,
    now: i64,
) -> Result<String, crate::dpop::ProofError> {
    let url = request_url(headers, path).ok_or(crate::dpop::ProofError::UrlMismatch)?;
    crate::dpop::verify(
        proof,
        method,
        &url,
        key,
        token,
        now / 1000,
        &state.replay_dir,
    )
}
pub fn authenticate_rpc(
    state: &AuthHttpState,
    headers: &HeaderMap,
    ticket: Option<&str>,
) -> Result<auth::Principal, auth::AuthError> {
    authenticate_at(state, headers, ticket, None, "GET", "/ws")
}
pub fn authenticate_at(
    state: &AuthHttpState,
    headers: &HeaderMap,
    ticket: Option<&str>,
    query_proof: Option<&str>,
    method: &str,
    path: &str,
) -> Result<auth::Principal, auth::AuthError> {
    authenticate_audience(state, headers, ticket, query_proof, method, path, "rpc")
}

pub fn authenticate_media(
    state: &AuthHttpState,
    headers: &HeaderMap,
    ticket: Option<&str>,
    query_proof: Option<&str>,
    path: &str,
) -> Result<auth::Principal, auth::AuthError> {
    authenticate_audience(state, headers, ticket, query_proof, "GET", path, "media")
}

fn authenticate_audience(
    state: &AuthHttpState,
    headers: &HeaderMap,
    ticket: Option<&str>,
    query_proof: Option<&str>,
    method: &str,
    path: &str,
    audience: &str,
) -> Result<auth::Principal, auth::AuthError> {
    let now = now_ms().map_err(|_| auth::AuthError::InvalidPayload)?;
    let db = state
        .db
        .lock()
        .map_err(|_| auth::AuthError::InvalidPayload)?;
    let header_proof = headers.get("dpop").and_then(|v| v.to_str().ok());
    let principal = if let Some(ticket) = ticket.filter(|v| !v.trim().is_empty()) {
        let now_iso = iso(&db, now)?;
        let p = auth::verify_websocket(
            &db,
            &state.signing_key,
            ticket.trim(),
            audience,
            now,
            &now_iso,
            None,
        )?;
        if let Some(key) = &p.jkt {
            verify_proof(
                state,
                headers,
                query_proof.or(header_proof),
                method,
                path,
                Some(key),
                Some(ticket.trim()),
                now,
            )
            .map_err(auth::AuthError::Proof)?;
        }
        p
    } else {
        let credential = select_credential(state, headers).ok_or(auth::AuthError::Malformed)?;
        let p = auth::verify_session(&db, &state.signing_key, credential.token, now)?;
        match (&p.jkt, credential.dpop) {
            (Some(key), true) => {
                verify_proof(
                    state,
                    headers,
                    header_proof,
                    method,
                    path,
                    Some(key),
                    Some(credential.token),
                    now,
                )
                .map_err(auth::AuthError::Proof)?;
            }
            (None, false) => (),
            _ => return Err(auth::AuthError::InvalidPayload),
        }
        p
    };
    if principal.subject == "mcp-client" {
        return Err(auth::AuthError::InvalidPayload);
    }
    Ok(principal)
}

fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}
fn add_cookie(response: &mut Response, name: &str, token: &str, expires_ms: i64) -> Result<(), ()> {
    let expiry = UNIX_EPOCH
        .checked_add(Duration::from_millis(
            u64::try_from(expires_ms).map_err(|_| ())?,
        ))
        .ok_or(())?;
    let value = format!(
        "{name}={token}; Path=/; HttpOnly; SameSite=Lax; Expires={}",
        httpdate::fmt_http_date(expiry)
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).map_err(|_| ())?,
    );
    Ok(())
}
fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"_tag":"EnvironmentInternalError","code":"internal_error","reason":"internal_error","traceId":Uuid::new_v4().to_string()})),
    )
        .into_response()
}
fn invalid() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","traceId":Uuid::new_v4().to_string()}))).into_response()
}
pub(crate) fn auth_failure(error: auth::AuthError, headers: &HeaderMap) -> Response {
    match error {
        auth::AuthError::Database(_) | auth::AuthError::Proof(crate::dpop::ProofError::Storage) => {
            internal()
        }
        auth::AuthError::Proof(error) => proof_failure(error),
        _ => {
            let mut response = invalid();
            if headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("DPoP ")))
            {
                response
                    .headers_mut()
                    .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("DPoP"));
            }
            response
        }
    }
}
fn proof_failure(error: crate::dpop::ProofError) -> Response {
    if error == crate::dpop::ProofError::Storage {
        return internal();
    }
    let status = if error == crate::dpop::ProofError::Replay {
        StatusCode::CONFLICT
    } else {
        StatusCode::UNAUTHORIZED
    };
    let mut response = (status, Json(json!({"_tag":"EnvironmentAuthInvalidError", "code":"auth_invalid", "reason":"invalid_credential", "dpopFailureReason":error.wire_reason(), "traceId":Uuid::new_v4().to_string()}))).into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("DPoP"));
    no_store(&mut response);
    response
}
fn invalid_scope() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"_tag":"EnvironmentRequestInvalidError","code":"invalid_request","reason":"invalid_scope","traceId":Uuid::new_v4().to_string()}))).into_response()
}
fn scope_fields(scopes: &[String]) -> (Vec<&str>, &[String]) {
    (authorization::legacy_scopes(scopes), scopes)
}

#[allow(clippy::result_large_err)]
fn access_writer(
    state: &AuthHttpState,
    headers: &HeaderMap,
    path: &str,
) -> Result<auth::Principal, Response> {
    let principal = match authenticate_at(state, headers, None, None, "POST", path) {
        Ok(principal) => principal,
        Err(error) => return Err(auth_failure(error, headers)),
    };
    if !principal.scopes.iter().any(|s| s == "access:write") {
        return Err((StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"access:write","requiredPermission":"access:write","traceId":Uuid::new_v4().to_string()}))).into_response());
    }
    Ok(principal)
}
#[derive(Deserialize)]
struct RevokePairingInput {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeClientInput {
    session_id: String,
}

async fn revoke_pairing(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<RevokePairingInput>,
) -> Response {
    if let Err(response) = access_writer(&state, &headers, "/api/auth/pairing-links/revoke") {
        return response;
    }
    let id = input.id.trim();
    if id.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let Ok(at) = iso(&db, now) else {
        return internal();
    };
    let Ok(changed) = db.execute("UPDATE auth_pairing_links SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL AND consumed_at IS NULL", params![id, at]) else { return internal(); };
    if changed != 0 {
        state.lifecycle.notify();
    }
    let mut response = Json(json!({"revoked":changed != 0})).into_response();
    no_store(&mut response);
    response
}
async fn revoke_client(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<RevokeClientInput>,
) -> Response {
    let principal = match access_writer(&state, &headers, "/api/auth/clients/revoke") {
        Ok(p) => p,
        Err(r) => return r,
    };
    let id = input.session_id.trim();
    if id.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if id == principal.session_id {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentOperationForbiddenError","code":"operation_forbidden","reason":"current_session_revoke_not_allowed","traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let Ok(at) = iso(&db, now) else {
        return internal();
    };
    let Ok(changed) = db.execute(
        "UPDATE auth_sessions SET revoked_at=?2 WHERE session_id=?1 AND revoked_at IS NULL",
        params![id, at],
    ) else {
        return internal();
    };
    if changed != 0 {
        state.lifecycle.notify();
    }
    let mut response = Json(json!({"revoked":changed != 0})).into_response();
    no_store(&mut response);
    response
}
async fn revoke_other_clients(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
) -> Response {
    let principal = match access_writer(&state, &headers, "/api/auth/clients/revoke-others") {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let Ok(at) = iso(&db, now) else {
        return internal();
    };
    let Ok(changed) = db.execute(
        "UPDATE auth_sessions SET revoked_at=?2 WHERE session_id<>?1 AND revoked_at IS NULL",
        params![principal.session_id, at],
    ) else {
        return internal();
    };
    if changed != 0 {
        state.lifecycle.notify();
    }
    let mut response = Json(json!({"revokedCount":changed})).into_response();
    no_store(&mut response);
    response
}

async fn websocket_ticket(State(state): State<Arc<AuthHttpState>>, headers: HeaderMap) -> Response {
    issue_websocket_ticket(&state, &headers, None)
}
async fn websocket_ticket_for(
    State(state): State<Arc<AuthHttpState>>,
    Path(audience): Path<String>,
    headers: HeaderMap,
) -> Response {
    if audience != "rpc" && audience != "media" {
        return StatusCode::BAD_REQUEST.into_response();
    }
    issue_websocket_ticket(&state, &headers, Some(audience))
}
fn issue_websocket_ticket(
    state: &AuthHttpState,
    headers: &HeaderMap,
    audience: Option<String>,
) -> Response {
    let principal = match authenticate_at(
        state,
        headers,
        None,
        None,
        "POST",
        &audience
            .as_ref()
            .map(|a| format!("/api/auth/websocket-ticket/{a}"))
            .unwrap_or_else(|| "/api/auth/websocket-ticket".into()),
    ) {
        Ok(principal) => principal,
        Err(error) => return auth_failure(error, headers),
    };
    let Ok(now) = now_ms() else {
        return internal();
    };
    let expires_ms = now.saturating_add(300_000);
    let claims = auth::WebSocketClaims {
        v: 1,
        kind: "websocket".into(),
        sid: principal.session_id,
        aud: audience.clone(),
        jkt: if audience.as_deref() == Some("rpc") {
            principal.jkt
        } else {
            None
        },
        iat: now,
        exp: expires_ms,
    };
    let Ok(ticket) = auth::sign_websocket(&state.signing_key, &claims) else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let Ok(expires) = iso(&db, expires_ms) else {
        return internal();
    };
    let mut response = Json(json!({"ticket":ticket,"expiresAt":expires})).into_response();
    no_store(&mut response);
    response
}

#[derive(Deserialize)]
struct PairingTokenInput {
    label: Option<String>,
    scopes: Option<Vec<String>>,
    access: Option<String>,
}

async fn pairing_token(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<PairingTokenInput>,
) -> Response {
    let principal = match access_writer(&state, &headers, "/api/auth/pairing-token") {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let (prefix, scopes): (Option<&str>, Vec<String>) = match input.access.as_deref() {
        None => (
            None,
            input.scopes.unwrap_or_else(|| {
                auth::STANDARD_CLIENT_SCOPES
                    .iter()
                    .map(|s| (*s).into())
                    .collect()
            }),
        ),
        Some("read-only") => (Some("READ"), vec!["orchestration:read".into()]),
        Some("full-access") => (
            Some("FULL"),
            vec![
                "orchestration:read".into(),
                "orchestration:operate".into(),
                "settings:write".into(),
                "source-control:write".into(),
            ],
        ),
        Some(access @ ("approval-required" | "auto-accept-edits" | "auto")) => (
            Some(match access {
                "approval-required" => "SUPERVISED",
                "auto-accept-edits" => "EDITS",
                _ => "AUTO",
            }),
            vec!["orchestration:read".into(), "orchestration:operate".into()],
        ),
        Some(_) => return invalid_scope(),
    };
    let mut seen = std::collections::HashSet::new();
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|s| !authorization::GRANT_SCOPES.contains(&s.as_str()) || !seen.insert(s))
    {
        return invalid_scope();
    }
    let grants = principal.scopes.into_iter().collect();
    let delegated: Vec<&str> = scopes.iter().map(String::as_str).collect();
    if let Err(missing) = authorization::check_delegation(&grants, &delegated) {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":missing.required_scope,"requiredPermission":missing.required_permission,"traceId":Uuid::new_v4().to_string()}))).into_response();
    }
    let label = input.label.as_deref().map(str::trim);
    if label == Some("") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"code":"invalid_request"})),
        )
            .into_response();
    }
    if let Err(message) = crate::managed_policy::check_client_mode("remote") {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentHttpForbiddenError","message":format!("{}, so this server cannot create pairing links.", message.trim_end_matches('.'))}))).into_response();
    }
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let (Ok(created), Ok(expires), Ok(code)) = (
        iso(&db, now),
        iso(&db, now.saturating_add(300_000)),
        auth::generate_pairing_code(),
    ) else {
        return internal();
    };
    let credential = prefix.map_or_else(|| code.clone(), |p| format!("{p}-{code}"));
    let subject = input.access.as_deref().map_or_else(
        || "one-time-token".to_string(),
        |access| format!("mcp-approval:{access}"),
    );
    let id = Uuid::new_v4().to_string();
    let Ok(encoded) = serde_json::to_string(&scopes) else {
        return internal();
    };
    if db.execute("INSERT INTO auth_pairing_links (id,credential,method,scopes,subject,label,proof_key_thumbprint,created_at,expires_at,consumed_at,revoked_at) VALUES (?1,?2,'one-time-token',?3,?4,?5,NULL,?6,?7,NULL,NULL)", params![id, credential, encoded, subject, label, created, expires]).is_err() { return internal(); }
    state.lifecycle.notify();
    let mut result = json!({"id":id,"credential":credential,"expiresAt":expires});
    if let Some(label) = label {
        result["label"] = json!(label);
    }
    if let Some(access) = input.access {
        result["access"] = json!(access);
    }
    let mut response = Json(result).into_response();
    no_store(&mut response);
    response
}

async fn session(State(state): State<Arc<AuthHttpState>>, headers: HeaderMap) -> Response {
    let Some(credential) = select_credential(&state, &headers) else {
        return Json(json!({"authenticated":false,"auth":state.descriptor})).into_response();
    };
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Ok(db) = state.db.lock() else {
        return internal();
    };
    let principal = match auth::verify_session(&db, &state.signing_key, credential.token, now) {
        Ok(p) if p.subject != "mcp-client" => match (&p.jkt, credential.dpop) {
            (Some(key), true)
                if verify_proof(
                    &state,
                    &headers,
                    headers.get("dpop").and_then(|v| v.to_str().ok()),
                    "GET",
                    "/api/auth/session",
                    Some(key),
                    Some(credential.token),
                    now,
                )
                .is_ok() =>
            {
                p
            }
            (None, false) => p,
            _ => {
                return Json(json!({"authenticated":false,"auth":state.descriptor})).into_response()
            }
        },
        Err(auth::AuthError::Database(_)) => return internal(),
        _ => return Json(json!({"authenticated":false,"auth":state.descriptor})).into_response(),
    };
    let expires: Result<Option<String>, _> = db
        .query_row(
            "SELECT expires_at FROM auth_sessions WHERE session_id=?1",
            [&principal.session_id],
            |r| r.get(0),
        )
        .optional();
    let Ok(Some(expires)) = expires else {
        return internal();
    };
    let (legacy, permissions) = scope_fields(&principal.scopes);
    let mut response = Json(json!({"authenticated":true,"auth":state.descriptor,"scopes":legacy,"permissions":permissions,"sessionMethod":principal.method,"expiresAt":expires})).into_response();
    if credential.legacy && principal.method == "browser-session-cookie" {
        let expires_ms: Result<i64, _> = db.query_row(
            "SELECT CAST((julianday(?1)-2440587.5)*86400000 AS INTEGER)",
            [&expires],
            |r| r.get(0),
        );
        if let (Some(name), Ok(ms)) = (cookie_name(&state), expires_ms) {
            if add_cookie(&mut response, name, credential.token, ms).is_err() {
                return internal();
            }
            no_store(&mut response);
        }
    }
    response
}
#[derive(Deserialize)]
struct BrowserRequest {
    credential: String,
}
async fn browser_session(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    Json(body): Json<BrowserRequest>,
) -> Response {
    let credential = body.credential.trim();
    if credential.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"_tag":"HttpApiDecodeError","message":"credential must not be empty"})),
        )
            .into_response();
    }
    let Some(name) = cookie_name(&state) else {
        return internal();
    };
    let Ok(now) = now_ms() else {
        return internal();
    };
    let Some(expires_ms) = now.checked_add(30 * 24 * 60 * 60 * 1000) else {
        return internal();
    };
    let Ok(mut db) = state.db.lock() else {
        return internal();
    };
    let Ok(now_iso) = iso(&db, now) else {
        return internal();
    };
    let Ok(expiry) = iso(&db, expires_ms) else {
        return internal();
    };
    // Capture a valid old browser session to revoke as part of the same transaction.
    let old_sid = if trusted_cookie_origin(&state, &headers) {
        cookie_value(&headers, name)
            .and_then(|v| auth::verify_session(&db, &state.signing_key, v, now).ok())
            .filter(|p| p.method == "browser-session-cookie" && p.jkt.is_none())
            .map(|p| p.session_id)
    } else {
        None
    };
    let Ok(tx) = db.transaction() else {
        return internal();
    };
    let grant = match desktop_grant(&state, credential, now) {
        Some(grant) => grant,
        None => match auth::consume_pairing(&tx, credential, &now_iso, None, None, None, &[]) {
            Ok(Some(grant)) => grant.into(),
            Ok(None) => return invalid(),
            Err(_) => return internal(),
        },
    };
    let sid = Uuid::new_v4().to_string();
    let claims = SessionClaims {
        v: 1,
        kind: "session".into(),
        sid: sid.clone(),
        sub: grant.subject.clone(),
        scopes: grant.scopes.clone(),
        method: "browser-session-cookie".into(),
        jkt: None,
        rtc: None,
        plk: None,
        iat: now,
        exp: expires_ms,
    };
    let Ok(token) = auth::sign_session(&state.signing_key, &claims) else {
        return internal();
    };
    let Ok(scopes_json) = serde_json::to_string(&grant.scopes) else {
        return internal();
    };
    if tx.execute("INSERT INTO auth_sessions (session_id,subject,scopes,method,issued_at,expires_at,client_ip_address) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![sid, grant.subject, scopes_json, claims.method, now_iso, expiry, socket_peer(&headers)]).is_err() { return internal(); }
    if let Some(old) = old_sid {
        if tx
            .execute(
                "UPDATE auth_sessions SET revoked_at=?1 WHERE session_id=?2 AND revoked_at IS NULL",
                params![now_iso, old],
            )
            .is_err()
        {
            return internal();
        }
    }
    let (legacy, permissions) = scope_fields(&grant.scopes);
    let mut response = Json(json!({"authenticated":true,"scopes":legacy,"permissions":permissions,"sessionMethod":"browser-session-cookie","expiresAt":expiry})).into_response();
    if add_cookie(&mut response, name, &token, expires_ms).is_err() {
        return internal();
    }
    if tx.commit().is_err() {
        return internal();
    }
    state.lifecycle.notify();
    no_store(&mut response);
    response
}

const TOKEN_GRANT: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

fn token_invalid_request(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"_tag":"EnvironmentRequestInvalidError", "code":"invalid_request", "reason":reason, "traceId":Uuid::new_v4().to_string()}))).into_response()
}
fn token_invalid_credential(dpop: bool) -> Response {
    let mut payload = json!({"_tag":"EnvironmentAuthInvalidError", "code":"auth_invalid", "reason":"invalid_credential", "traceId":Uuid::new_v4().to_string()});
    if dpop {
        payload["dpopFailureReason"] = json!("invalid_proof");
    }
    let mut response = (StatusCode::UNAUTHORIZED, Json(payload)).into_response();
    if dpop {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("DPoP"));
    }
    response
}
fn token_internal() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"_tag":"EnvironmentInternalError", "code":"internal_error", "reason":"access_token_issuance_failed", "traceId":Uuid::new_v4().to_string()}))).into_response()
}
fn token_decode_error() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"_tag":"HttpApiDecodeError", "message":"Invalid token exchange request"})),
    )
        .into_response()
}

/// RFC 8693 exchange of a one-time pairing credential for a bearer session.
/// DPoP credentials are deliberately rejected until proof verification exists.
async fn token_exchange(
    State(state): State<Arc<AuthHttpState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let is_form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';').next().is_some_and(|v| {
                v.trim()
                    .eq_ignore_ascii_case("application/x-www-form-urlencoded")
            })
        });
    if !is_form {
        return token_decode_error();
    }
    let values: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(&body).into_owned().collect();
    let field = |name: &str| values.get(name).map(|v| v.trim()).filter(|v| !v.is_empty());
    if values.get("grant_type").map(String::as_str) != Some(TOKEN_GRANT)
        || values.get("subject_token_type").map(String::as_str) != Some(BOOTSTRAP_TYPE)
        || values.get("requested_token_type").map(String::as_str) != Some(ACCESS_TYPE)
    {
        return token_decode_error();
    }
    let Some(credential) = field("subject_token") else {
        return token_decode_error();
    };
    for name in ["client_label", "client_os"] {
        if values.contains_key(name) && field(name).is_none() {
            return token_decode_error();
        }
    }
    let device = values.get("client_device_type").map(String::as_str);
    if device.is_some_and(|v| !["desktop", "mobile", "tablet", "bot", "unknown"].contains(&v)) {
        return token_decode_error();
    }
    let requested = if let Some(scope) = values.get("scope") {
        let Some(parsed) = shared::parse_oauth_scope(scope.trim()) else {
            return token_invalid_request("invalid_scope");
        };
        let requested: Vec<String> = parsed
            .into_iter()
            .filter(|scope| authorization::GRANT_SCOPES.contains(scope))
            .map(str::to_owned)
            .collect();
        if requested.is_empty() {
            return token_invalid_request("invalid_scope");
        }
        Some(requested)
    } else {
        None
    };
    let Ok(now) = now_ms() else {
        return token_internal();
    };
    let thumbprint = if headers.contains_key("dpop") {
        match verify_proof(
            &state,
            &headers,
            headers.get("dpop").and_then(|v| v.to_str().ok()),
            "POST",
            "/oauth/token",
            None,
            None,
            now,
        ) {
            Ok(key) => Some(key),
            Err(error) => return proof_failure(error),
        }
    } else {
        None
    };
    let Some(expires_ms) = now.checked_add(if thumbprint.is_some() {
        60 * 60 * 1000
    } else {
        30 * 24 * 60 * 60 * 1000
    }) else {
        return token_internal();
    };
    let Ok(mut db) = state.db.lock() else {
        return token_internal();
    };
    let (Ok(now_iso), Ok(expiry)) = (iso(&db, now), iso(&db, expires_ms)) else {
        return token_internal();
    };
    let Ok(tx) = db.transaction() else {
        return token_internal();
    };
    let grant = match desktop_grant(&state, credential, now) {
        Some(grant) => grant,
        None => match auth::consume_pairing(
            &tx,
            credential,
            &now_iso,
            None,
            thumbprint.as_deref(),
            requested.as_deref(),
            &[],
        ) {
            Ok(Some(grant)) => grant.into(),
            Ok(None) => {
                // Diagnose disjoint scopes only for a still-available, unbound link.
                // This read cannot consume a rejected credential.
                if let Some(requested) = &requested {
                    let row: rusqlite::Result<Option<String>> = tx.query_row("SELECT scopes FROM auth_pairing_links WHERE credential=?1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?2 AND proof_key_thumbprint IS NULL", params![auth::normalize_pairing_code(credential), now_iso], |r| r.get(0)).optional();
                    match row {
                        Ok(Some(scopes)) => match serde_json::from_str::<Vec<String>>(&scopes) {
                            Ok(scopes) if !requested.iter().any(|scope| scopes.contains(scope)) => {
                                let mut response = token_invalid_request("scope_not_granted");
                                no_store(&mut response);
                                return response;
                            }
                            Ok(_) => {}
                            Err(_) => return token_internal(),
                        },
                        Ok(None) => {}
                        Err(_) => return token_internal(),
                    }
                }
                let mut response = token_invalid_credential(false);
                no_store(&mut response);
                return response;
            }
            Err(_) => return token_internal(),
        },
    };
    // Stored grants use the environment scope schema, which also accepts the
    // retired review permission for compatibility with older databases.
    if !["desktop-bootstrap", "one-time-token"].contains(&grant.method.as_str())
        || grant.scopes.iter().any(|scope| {
            scope != "review:write" && !authorization::GRANT_SCOPES.contains(&scope.as_str())
        })
    {
        return token_internal();
    }
    let Some(scopes) = granted_scopes(requested, &grant.scopes) else {
        let mut response = token_invalid_request("scope_not_granted");
        no_store(&mut response);
        return response;
    };
    let refs = scopes.iter().map(String::as_str).collect::<Vec<_>>();
    let Some(encoded_scopes) = shared::encode_oauth_scope(&refs) else {
        return token_internal();
    };
    let sid = Uuid::new_v4().to_string();
    let claims = SessionClaims {
        v: 1,
        kind: "session".into(),
        sid: sid.clone(),
        sub: grant.subject.clone(),
        scopes: scopes.clone(),
        method: if thumbprint.is_some() {
            "dpop-access-token"
        } else {
            "bearer-access-token"
        }
        .into(),
        jkt: thumbprint.clone(),
        rtc: None,
        plk: None,
        iat: now,
        exp: expires_ms,
    };
    let Ok(token) = auth::sign_session(&state.signing_key, &claims) else {
        return token_internal();
    };
    let Ok(scopes_json) = serde_json::to_string(&scopes) else {
        return token_internal();
    };
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let lower = user_agent.map(str::to_ascii_lowercase);
    let inferred_device = lower
        .as_deref()
        .map(|s| {
            if ["bot", "crawler", "spider", "slurp", "curl", "wget"]
                .iter()
                .any(|p| s.contains(p))
            {
                "bot"
            } else if s.contains("ipad") || s.contains("tablet") {
                "tablet"
            } else if s.contains("iphone") || s.contains("mobile") {
                "mobile"
            } else {
                "desktop"
            }
        })
        .unwrap_or("unknown");
    let inferred_os = lower.as_deref().and_then(|s| {
        if ["iphone", "ipad", "ipod"].iter().any(|p| s.contains(p)) {
            Some("iOS")
        } else if s.contains("android") {
            Some("Android")
        } else if s.contains("mac os x") || s.contains("macintosh") {
            Some("macOS")
        } else if s.contains("windows nt") {
            Some("Windows")
        } else if s.contains("linux") {
            Some("Linux")
        } else {
            None
        }
    });
    let browser = lower.as_deref().and_then(|s| {
        if ["edg/", "edge/", "edga/", "edgios/"]
            .iter()
            .any(|p| s.contains(p))
        {
            Some("Edge")
        } else if s.contains("opr/") || s.contains("opios/") {
            Some("Opera")
        } else if s.contains("firefox/") || s.contains("fxios/") {
            Some("Firefox")
        } else if s.contains("electron/") {
            Some("Electron")
        } else if s.contains("chrome/") || s.contains("crios/") {
            Some("Chrome")
        } else if s.contains("safari/") {
            Some("Safari")
        } else {
            None
        }
    });
    if grant.method == "desktop-bootstrap" && tx.execute("UPDATE auth_sessions SET revoked_at=?1 WHERE subject=?2 AND method IN ('bearer-access-token','dpop-access-token') AND revoked_at IS NULL AND expires_at>?1", params![now_iso, grant.subject]).is_err() { return token_internal(); }
    if tx.execute("INSERT INTO auth_sessions (session_id,subject,scopes,method,client_label,client_user_agent,client_device_type,client_os,client_browser,issued_at,expires_at,client_ip_address) VALUES (?1,?2,?3,?11,?4,?5,?6,?7,?8,?9,?10,?12)", params![sid, grant.subject, scopes_json, grant.label.as_deref().filter(|label| !label.is_empty()).or_else(||field("client_label")), user_agent, device.unwrap_or(inferred_device), field("client_os").or(inferred_os), browser, now_iso, expiry, claims.method, socket_peer(&headers)]).is_err() { return token_internal(); }
    if tx.commit().is_err() {
        return token_internal();
    }
    state.lifecycle.notify();
    let remaining = now_ms().unwrap_or(now);
    let mut response = Json(json!({"access_token":token,"issued_token_type":ACCESS_TYPE,"token_type":if thumbprint.is_some() { "DPoP" } else { "Bearer" },"expires_in":((expires_ms-remaining)/1000).max(0),"scope":encoded_scopes})).into_response();
    no_store(&mut response);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_linkability_rejects_forwarded_authority() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:3000"));
        assert!(connect_linkable_here(&headers, "desktop-bootstrap"));
        assert!(!connect_linkable_here(&headers, "one-time-token"));
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("proxy.example"),
        );
        assert!(!connect_linkable_here(&headers, "desktop-bootstrap"));
        headers.remove("x-forwarded-host");
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert!(!connect_linkable_here(&headers, "desktop-bootstrap"));
    }
    fn form(scope: Option<&str>) -> Bytes {
        form_for("23456789abcd", scope)
    }
    fn form_for(credential: &str, scope: Option<&str>) -> Bytes {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", TOKEN_GRANT)
            .append_pair("subject_token", credential)
            .append_pair("subject_token_type", BOOTSTRAP_TYPE)
            .append_pair("requested_token_type", ACCESS_TYPE)
            .append_pair("client_label", "  User label  ")
            .append_pair("client_device_type", "mobile")
            .append_pair("client_os", "iOS");
        if let Some(scope) = scope {
            form.append_pair("scope", scope);
        }
        Bytes::from(form.finish())
    }
    fn form_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("Test Firefox/123"),
        );
        headers
    }
    fn state() -> Arc<AuthHttpState> {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,subject TEXT,scopes TEXT,method TEXT,client_label TEXT,client_ip_address TEXT,client_user_agent TEXT,client_device_type TEXT NOT NULL DEFAULT 'unknown',client_os TEXT,client_browser TEXT,issued_at TEXT,expires_at TEXT,revoked_at TEXT); CREATE TABLE auth_pairing_links(id TEXT PRIMARY KEY,credential TEXT UNIQUE,method TEXT,scopes TEXT,subject TEXT,label TEXT,proof_key_thumbprint TEXT,created_at TEXT,expires_at TEXT,consumed_at TEXT,revoked_at TEXT); INSERT INTO auth_pairing_links VALUES('i','23456789ABCD','one-time-token','[\"orchestration:read\",\"settings:write\"]','one-time-token',NULL,NULL,'2020-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',NULL,NULL);").unwrap();
        Arc::new(AuthHttpState {
            replay_dir: std::env::temp_dir().join(format!("t3-dpop-test-{}", uuid::Uuid::new_v4())),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: Mutex::new(db),
            signing_key: [5; 32],
            descriptor: json!({"sessionCookieName":"t3_session_test"}),
            trusted_origins: vec![],
            accept_legacy_cookie: true,
            desktop_bootstrap: None,
        })
    }
    #[tokio::test]
    async fn dpop_exchange_and_request_bind_key_and_reject_replay() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use p256::ecdsa::{signature::Signer, Signature, SigningKey};
        use sha2::{Digest, Sha256};
        let state = state();
        let key = SigningKey::from_slice(&[7; 32]).unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        let make = |method: &str, path: &str, jti: &str, token: Option<&str>| {
            let header = json!({"typ":"dpop+jwt","alg":"ES256","jwk":{"kty":"EC","crv":"P-256","x":URL_SAFE_NO_PAD.encode(point.x().unwrap()),"y":URL_SAFE_NO_PAD.encode(point.y().unwrap())}});
            let mut payload = json!({"htm":method,"htu":format!("http://example.test{path}"),"jti":jti,"iat":now_ms().unwrap()/1000});
            if let Some(token) = token {
                payload["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())));
            }
            let input = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(header.to_string()),
                URL_SAFE_NO_PAD.encode(payload.to_string())
            );
            let signature: Signature = key.sign(input.as_bytes());
            format!("{}.{}", input, URL_SAFE_NO_PAD.encode(signature.to_bytes()))
        };
        let mut headers = form_headers();
        headers.insert(header::HOST, HeaderValue::from_static("example.test"));
        headers.insert(
            "dpop",
            HeaderValue::from_str(&make("POST", "/oauth/token", "exchange", None)).unwrap(),
        );
        let response = token_exchange(State(state.clone()), headers, form(None)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["token_type"], "DPoP");
        assert!(value["expires_in"].as_i64().unwrap() <= 3600);
        let token = value["access_token"].as_str().unwrap();
        let mut request = HeaderMap::new();
        request.insert(header::HOST, HeaderValue::from_static("example.test"));
        request.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("DPoP {token}")).unwrap(),
        );
        request.insert(
            "dpop",
            HeaderValue::from_str(&make("GET", "/ws", "request", Some(token))).unwrap(),
        );
        assert!(authenticate_rpc(&state, &request, None).is_ok());
        assert!(matches!(
            authenticate_rpc(&state, &request, None),
            Err(auth::AuthError::Proof(crate::dpop::ProofError::Replay))
        ));
        request.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert!(authenticate_rpc(&state, &request, None).is_err());
    }
    #[tokio::test]
    async fn revocation_forbids_self_and_invalidates_other_sessions_and_pairings() {
        let mut state = state();
        Arc::get_mut(&mut state).unwrap().desktop_bootstrap = Some(auth::DesktopBootstrap::new(
            None,
            Some("desktop".into()),
            now_ms().unwrap(),
        ));
        let session = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "desktop".into(),
            }),
        )
        .await;
        let cookie = session.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        let principal = authenticate_rpc(&state, &headers, None).unwrap();
        let own = revoke_client(
            State(state.clone()),
            headers.clone(),
            Json(RevokeClientInput {
                session_id: principal.session_id.clone(),
            }),
        )
        .await;
        assert_eq!(own.status(), StatusCode::FORBIDDEN);
        let pairing = revoke_pairing(
            State(state.clone()),
            headers.clone(),
            Json(RevokePairingInput { id: "i".into() }),
        )
        .await;
        assert_eq!(pairing.status(), StatusCode::OK);
        assert_eq!(
            browser_session(
                State(state.clone()),
                HeaderMap::new(),
                Json(BrowserRequest {
                    credential: "23456789ABCD".into()
                })
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        state.db.lock().unwrap().execute("INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES('other','other','[]','bearer-access-token','2020','2999')", []).unwrap();
        let response = revoke_other_clients(State(state.clone()), headers.clone()).await;
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["revokedCount"], 1);
        assert!(authenticate_rpc(&state, &headers, None).is_ok());
        let again = revoke_client(
            State(state),
            headers,
            Json(RevokeClientInput {
                session_id: "other".into(),
            }),
        )
        .await;
        let body: Value =
            serde_json::from_slice(&axum::body::to_bytes(again.into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(body["revoked"], false);
    }
    #[tokio::test]
    async fn pairing_token_enforces_delegation_and_issues_consumable_code() {
        let mut state = state();
        Arc::get_mut(&mut state).unwrap().desktop_bootstrap = Some(auth::DesktopBootstrap::new(
            None,
            Some("desktop".into()),
            now_ms().unwrap(),
        ));
        let session = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "desktop".into(),
            }),
        )
        .await;
        let cookie = session.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes = '[\"orchestration:read\"]'",
                [],
            )
            .unwrap();
        let denied = pairing_token(
            State(state.clone()),
            headers.clone(),
            Json(PairingTokenInput {
                label: None,
                scopes: Some(vec!["orchestration:read".into()]),
                access: None,
            }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(denied.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["requiredScope"], "access:write");
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes = ?1",
                [serde_json::to_string(auth::STANDARD_CLIENT_SCOPES).unwrap()],
            )
            .unwrap();
        let duplicate = pairing_token(
            State(state.clone()),
            headers.clone(),
            Json(PairingTokenInput {
                label: None,
                scopes: Some(vec!["access:read".into(), "access:read".into()]),
                access: None,
            }),
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        let issued = pairing_token(
            State(state.clone()),
            headers,
            Json(PairingTokenInput {
                label: Some(" Phone ".into()),
                scopes: Some(vec!["orchestration:read".into()]),
                access: None,
            }),
        )
        .await;
        assert_eq!(issued.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(issued.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["label"], "Phone");
        let exchanged = browser_session(
            State(state),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: body["credential"].as_str().unwrap().into(),
            }),
        )
        .await;
        assert_eq!(exchanged.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn websocket_ticket_is_audience_bound_and_revoked_with_session() {
        let mut state = state();
        Arc::get_mut(&mut state).unwrap().desktop_bootstrap = Some(auth::DesktopBootstrap::new(
            None,
            Some("desktop".into()),
            now_ms().unwrap(),
        ));
        let session = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "desktop".into(),
            }),
        )
        .await;
        let cookie = session.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        let issued = issue_websocket_ticket(&state, &headers, Some("rpc".into()));
        assert_eq!(issued.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(issued.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        let ticket = body["ticket"].as_str().unwrap();
        let principal = authenticate_rpc(&state, &HeaderMap::new(), Some(ticket)).unwrap();
        let now = now_ms().unwrap();
        let db = state.db.lock().unwrap();
        assert!(matches!(
            auth::verify_websocket(
                &db,
                &state.signing_key,
                ticket,
                "media",
                now,
                &iso(&db, now).unwrap(),
                None
            ),
            Err(auth::AuthError::AudienceMismatch)
        ));
        db.execute(
            "UPDATE auth_sessions SET revoked_at='2026-01-01' WHERE session_id=?1",
            [&principal.session_id],
        )
        .unwrap();
        drop(db);
        assert!(authenticate_rpc(&state, &HeaderMap::new(), Some(ticket)).is_err());
    }
    #[test]
    fn browser_origin_checks_direct_and_forwarded_hosts() {
        let state = state();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://app.example"),
        );
        headers.insert(header::HOST, HeaderValue::from_static("app.example"));
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("proxy.example"),
        );
        assert!(trusted_cookie_origin(&state, &headers));
        headers.insert(header::HOST, HeaderValue::from_static("other.example"));
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("app.example, proxy.example"),
        );
        assert!(trusted_cookie_origin(&state, &headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!trusted_cookie_origin(&state, &headers));
    }

    #[tokio::test]
    async fn bearer_exchange_rejects_disjoint_and_retired_scopes_without_spending_code() {
        let state = state();
        for (scope, reason) in [
            ("review:write", "invalid_scope"),
            ("terminal:operate", "scope_not_granted"),
        ] {
            let result =
                token_exchange(State(state.clone()), form_headers(), form(Some(scope))).await;
            assert_eq!(result.status(), StatusCode::BAD_REQUEST);
            let body = axum::body::to_bytes(result.into_body(), 4096)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["reason"],
                reason
            );
            assert_eq!(
                state
                    .db
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT consumed_at FROM auth_pairing_links WHERE id='i'",
                        [],
                        |r| r.get::<_, Option<String>>(0)
                    )
                    .unwrap(),
                None
            );
        }
        let response = token_exchange(
            State(state.clone()),
            form_headers(),
            form(Some(
                "settings:write unknown:read orchestration:read settings:write",
            )),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["token_type"], "Bearer");
        assert_eq!(body["issued_token_type"], ACCESS_TYPE);
        assert_eq!(body["scope"], "settings:write orchestration:read");
        assert!((2_591_999..=2_592_000).contains(&body["expires_in"].as_i64().unwrap()));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "Bearer {}",
                body["access_token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let principal = authenticate_rpc(&state, &headers, None).unwrap();
        assert_eq!(
            principal.scopes,
            vec!["settings:write", "orchestration:read"]
        );
        let metadata: (String, String, String, String) = {
            let db = state.db.lock().unwrap();
            db.query_row("SELECT client_label,client_device_type,client_os,client_browser FROM auth_sessions WHERE session_id=?1", [&principal.session_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
        };
        assert_eq!(
            metadata,
            (
                "User label".into(),
                "mobile".into(),
                "iOS".into(),
                "Firefox".into()
            )
        );
        assert_eq!(
            token_exchange(State(state), form_headers(), form(None))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn dpop_and_proof_bound_link_fail_without_spending_the_code() {
        let state = state();
        let mut headers = form_headers();
        headers.insert("dpop", HeaderValue::from_static("unverified-proof"));
        let result = token_exchange(State(state.clone()), headers, form(None)).await;
        assert_eq!(result.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(result.headers()[header::WWW_AUTHENTICATE], "DPoP");
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_pairing_links SET proof_key_thumbprint='bound' WHERE id='i'",
                [],
            )
            .unwrap();
        assert_eq!(
            token_exchange(State(state.clone()), form_headers(), form(None))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT consumed_at FROM auth_pairing_links WHERE id='i'",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn failed_session_insert_rolls_back_pairing_consumption() {
        let state = state();
        state.db.lock().unwrap().execute_batch("CREATE TRIGGER fail_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'failed'); END;").unwrap();
        let result = token_exchange(State(state.clone()), form_headers(), form(None)).await;
        assert_eq!(result.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let db = state.db.lock().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT consumed_at FROM auth_pairing_links WHERE id='i'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM auth_sessions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn desktop_exchange_replaces_only_other_active_bearer_sessions() {
        let state = state();
        {
            let db = state.db.lock().unwrap();
            db.execute("UPDATE auth_pairing_links SET method='desktop-bootstrap',subject='desktop-bootstrap',label='Desktop label' WHERE id='i'", []).unwrap();
            for (id, method, expires) in [
                ("active", "bearer-access-token", "2999-01-01T00:00:00.000Z"),
                ("expired", "bearer-access-token", "2020-01-01T00:00:00.000Z"),
                (
                    "browser",
                    "browser-session-cookie",
                    "2999-01-01T00:00:00.000Z",
                ),
            ] {
                db.execute("INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES (?1,'desktop-bootstrap','[\"orchestration:read\"]',?2,'2020-01-01T00:00:00.000Z',?3)", params![id, method, expires]).unwrap();
            }
        }
        let result = token_exchange(State(state.clone()), form_headers(), form(None)).await;
        assert_eq!(result.status(), StatusCode::OK);
        let db = state.db.lock().unwrap();
        let revoked = |id| {
            db.query_row(
                "SELECT revoked_at FROM auth_sessions WHERE session_id=?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap()
        };
        assert!(revoked("active").is_some());
        assert_eq!(revoked("expired"), None);
        assert_eq!(revoked("browser"), None);
        let label: String = db.query_row("SELECT client_label FROM auth_sessions WHERE session_id NOT IN ('active','expired','browser')", [], |r| r.get(0)).unwrap();
        assert_eq!(label, "Desktop label");
    }

    #[tokio::test]
    async fn rotating_desktop_token_is_reusable_and_replaces_prior_bearer() {
        let mut state = state();
        Arc::get_mut(&mut state).unwrap().desktop_bootstrap = Some(auth::DesktopBootstrap::new(
            Some("desktop-secret".into()),
            Some("obsolete-launch-token".into()),
            now_ms().unwrap(),
        ));
        let now = now_ms().unwrap();
        let token = auth::desktop_bootstrap_token("desktop-secret", now);
        let invalid = token_exchange(
            State(state.clone()),
            form_headers(),
            form_for(&token, Some("retired:permission")),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM auth_sessions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            granted_scopes(
                Some(vec!["different".into()]),
                &["orchestration:read".into()]
            ),
            None
        );

        let first =
            token_exchange(State(state.clone()), form_headers(), form_for(&token, None)).await;
        assert_eq!(first.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&axum::body::to_bytes(first.into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(body["scope"], DESKTOP_SCOPES.join(" "));
        let first_token = body["access_token"].as_str().unwrap().to_owned();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {first_token}")).unwrap(),
        );
        let first_principal = authenticate_rpc(&state, &headers, None).unwrap();
        assert_eq!(first_principal.subject, "desktop-bootstrap");
        assert_eq!(
            first_principal.scopes,
            DESKTOP_SCOPES
                .iter()
                .map(|s| (*s).to_owned())
                .collect::<Vec<_>>()
        );

        let rejected = token_exchange(
            State(state.clone()),
            form_headers(),
            form_for(&token, Some("retired:permission")),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            authenticate_rpc(&state, &headers, None).unwrap().session_id,
            first_principal.session_id
        );
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM auth_sessions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );

        let second = token_exchange(
            State(state.clone()),
            form_headers(),
            form_for(&token, Some("terminal:operate")),
        )
        .await;
        assert_eq!(second.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(second.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["scope"], "terminal:operate");
        assert!(matches!(
            authenticate_rpc(&state, &headers, None),
            Err(auth::AuthError::Revoked)
        ));
        let mut new_headers = HeaderMap::new();
        new_headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "Bearer {}",
                body["access_token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        let second_principal = authenticate_rpc(&state, &new_headers, None).unwrap();
        assert_eq!(second_principal.subject, "desktop-bootstrap");
        assert_eq!(second_principal.scopes, vec!["terminal:operate"]);
        assert_eq!(
            state
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT consumed_at FROM auth_pairing_links WHERE id='i'",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn legacy_desktop_token_can_issue_a_browser_session() {
        let mut state = state();
        Arc::get_mut(&mut state).unwrap().desktop_bootstrap = Some(auth::DesktopBootstrap::new(
            None,
            Some("legacy-desktop-token".into()),
            now_ms().unwrap(),
        ));
        let response = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "legacy-desktop-token".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        let principal = authenticate_rpc(&state, &headers, None).unwrap();
        assert_eq!(principal.subject, "desktop-bootstrap");
        assert_eq!(
            principal.scopes,
            DESKTOP_SCOPES
                .iter()
                .map(|s| (*s).to_owned())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn token_route_serves_form_exchange_on_the_real_listener() {
        use std::io::{Read, Write};
        let state = state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Arc::new(crate::application::Application::new(
            state.clone(),
            "test".into(),
            "host".into(),
        ));
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(crate::http_server::serve_with_auth(
            listener,
            app,
            state.clone(),
            async {
                let _ = stopped.await;
            },
        ));
        let body = form(Some("orchestration:read"));
        let response = tokio::task::spawn_blocking(move || {
            let mut socket = std::net::TcpStream::connect(addr).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            write!(socket, "POST /oauth/token HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            socket.write_all(&body).unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            response
        }).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["scope"], "orchestration:read");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "Bearer {}",
                body["access_token"].as_str().unwrap()
            ))
            .unwrap(),
        );
        assert_eq!(
            authenticate_rpc(&state, &headers, None).unwrap().scopes,
            vec!["orchestration:read"]
        );
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn pairing_issues_cookie_once_and_status_requires_it() {
        let state = state();
        let empty = session(State(state.clone()), HeaderMap::new()).await;
        assert_eq!(empty.status(), StatusCode::OK);
        let result = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "23456789abcd".into(),
            }),
        )
        .await;
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(result.headers()[header::CACHE_CONTROL], "no-store");
        let set_cookie = result.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(set_cookie.split(';').next().unwrap()).unwrap(),
        );
        let principal = authenticate_rpc(&state, &headers, None).unwrap();
        let now = now_ms().unwrap();
        let ticket = auth::sign_websocket(
            &state.signing_key,
            &auth::WebSocketClaims {
                v: 1,
                kind: "websocket".into(),
                sid: principal.session_id.clone(),
                aud: Some("rpc".into()),
                jkt: None,
                iat: now,
                exp: now + 60_000,
            },
        )
        .unwrap();
        assert_eq!(
            authenticate_rpc(&state, &HeaderMap::new(), Some(&ticket))
                .unwrap()
                .session_id,
            principal.session_id
        );
        let wrong_audience = auth::sign_websocket(
            &state.signing_key,
            &auth::WebSocketClaims {
                v: 1,
                kind: "websocket".into(),
                sid: principal.session_id,
                aud: Some("media".into()),
                jkt: None,
                iat: now,
                exp: now + 60_000,
            },
        )
        .unwrap();
        assert!(matches!(
            authenticate_rpc(&state, &HeaderMap::new(), Some(&wrong_audience)),
            Err(auth::AuthError::AudienceMismatch)
        ));
        let status = session(State(state.clone()), headers.clone()).await;
        let body = axum::body::to_bytes(status.into_body(), 4096)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["authenticated"], true);
        assert_eq!(
            value["permissions"],
            json!(["orchestration:read", "settings:write"])
        );
        assert_eq!(value["scopes"], json!(["orchestration:read"]));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        let blocked = session(State(state.clone()), headers).await;
        let body = axum::body::to_bytes(blocked.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["authenticated"],
            false
        );
        let replay = browser_session(
            State(state),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "23456789ABCD".into(),
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }
    #[tokio::test]
    async fn paired_cookie_authenticates_real_websocket() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
        let state = state();
        let response = browser_session(
            State(state.clone()),
            HeaderMap::new(),
            Json(BrowserRequest {
                credential: "23456789ABCD".into(),
            }),
        )
        .await;
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let app = Arc::new(crate::application::Application::new(
            state,
            "environment-test".into(),
            "Test".into(),
        ));
        let server = tokio::spawn(crate::http_server::serve(listener, app, async {
            let _ = stopped.await;
        }));
        let mut request = format!("ws://{addr}/ws?orchestrationProtocol=2")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        ws.send(Message::Text(
            r#"{"_tag":"Request","id":7,"tag":"server.probe","payload":{},"headers":[]}"#.into(),
        ))
        .await
        .unwrap();
        let response = ws.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({"_tag":"Exit","requestId":7,"exit":{"_tag":"Success","value":{}}})
        );
        ws.close(None).await.unwrap();
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }

    async fn read_body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn relay_config_rejects_t3_relay_with_endpoint_unavailable_json() {
        let state = state();
        std::fs::create_dir_all(&state.replay_dir).unwrap();
        state.db.lock().unwrap().execute("INSERT INTO auth_pairing_links VALUES('relay-link','RELAYTEST123','one-time-token','[\"relay:write\"]','one-time-token',NULL,NULL,'2020-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',NULL,NULL)", []).unwrap();
        let exchanged = token_exchange(State(state.clone()), form_headers(), form_for("RELAYTEST123", None)).await;
        let token = read_body_json(exchanged).await["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let mint_dir = std::env::temp_dir().join(format!("t3-mint-key-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&mint_dir).unwrap();
        let mint_key = crate::cloud_link_key::load_or_create(&mint_dir).unwrap();
        let response = disabled_connect_relay_config(
            State(state),
            headers,
            Json(json!({
                "relayUrl": "https://relay.example.com",
                "cloudUserId": "user-1",
                "environmentCredential": "cred-1",
                "cloudMintPublicKey": mint_key.public_key,
                "endpointRuntime": {
                    "providerKind": "t3_relay",
                    "connectorToken": "tok-1"
                }
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = read_body_json(response).await;
        assert_eq!(body["_tag"], "EnvironmentCloudEndpointUnavailableError");
        assert_eq!(body["endpointRuntimeStatus"]["status"], "disabled");
        assert!(body["message"].as_str().is_some_and(|m| !m.is_empty()));
        let _ = std::fs::remove_dir_all(&mint_dir);
    }

    #[tokio::test]
    async fn t3_connect_health_verifies_proof_signs_response_and_blocks_replay() {
        let state = state();
        std::fs::create_dir_all(&state.replay_dir).unwrap();
        let _ = state
            .environment_descriptor
            .set(json!({"environmentId": "env-test", "label": "Test"}));
        let mint_dir = std::env::temp_dir().join(format!("t3-mint-key-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&mint_dir).unwrap();
        let mint_key = crate::cloud_link_key::load_or_create(&mint_dir).unwrap();
        std::fs::write(
            state.replay_dir.join("cloud-mint-ed25519-public-key.bin"),
            &mint_key.public_key,
        )
        .unwrap();
        std::fs::write(
            state.replay_dir.join("cloud-relay-url.bin"),
            "https://relay.example.com/",
        )
        .unwrap();
        std::fs::write(state.replay_dir.join("cloud-linked-user-id.bin"), "user-1").unwrap();

        let now = chrono::Utc::now().timestamp();
        let proof = mint_key
            .sign_typed(
                "t3-cloud-health+jwt",
                &json!({
                    "iss": "https://relay.example.com",
                    "aud": "t3-env:env-test",
                    "sub": "user-1",
                    "jti": "health-jti-1",
                    "iat": now,
                    "exp": now + 60,
                    "environmentId": "env-test",
                    "nonce": "health-nonce-1",
                    "scope": ["environment:status"]
                }),
            )
            .unwrap();
        let body_bytes = Bytes::from(json!({"proof": proof}).to_string());

        let response = t3_connect_health(State(state.clone()), body_bytes.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["pragma"], "no-cache");
        let body = read_body_json(response).await;
        assert_eq!(body["environmentId"], "env-test");
        assert_eq!(body["status"], "online");
        assert_eq!(body["descriptor"]["environmentId"], "env-test");
        assert!(body["proof"].as_str().is_some_and(|p| p.split('.').count() == 3));

        let replay = t3_connect_health(State(state.clone()), body_bytes).await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
        assert_eq!(read_body_json(replay).await["_tag"], "EnvironmentHttpConflictError");

        let bad = t3_connect_health(
            State(state),
            Bytes::from(json!({"proof": "bad.jwt.token"}).to_string()),
        )
        .await;
        assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(&mint_dir);
    }

    #[tokio::test]
    async fn t3_connect_mint_credential_issues_bound_pairing_code_and_blocks_replay() {
        let state = state();
        std::fs::create_dir_all(&state.replay_dir).unwrap();
        let _ = state
            .environment_descriptor
            .set(json!({"environmentId": "env-test", "label": "Test"}));
        let mint_dir = std::env::temp_dir().join(format!("t3-mint-key-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&mint_dir).unwrap();
        let mint_key = crate::cloud_link_key::load_or_create(&mint_dir).unwrap();
        std::fs::write(
            state.replay_dir.join("cloud-mint-ed25519-public-key.bin"),
            &mint_key.public_key,
        )
        .unwrap();
        std::fs::write(
            state.replay_dir.join("cloud-relay-issuer.bin"),
            "https://relay.example.com",
        )
        .unwrap();
        std::fs::write(state.replay_dir.join("cloud-linked-user-id.bin"), "user-1").unwrap();

        let now = chrono::Utc::now().timestamp();
        let proof = mint_key
            .sign_typed(
                "t3-cloud-mint+jwt",
                &json!({
                    "iss": "https://relay.example.com",
                    "aud": "t3-env:env-test",
                    "sub": "user-1",
                    "jti": "mint-jti-1",
                    "iat": now,
                    "exp": now + 60,
                    "environmentId": "env-test",
                    "clientProofKeyThumbprint": "jkt-thumbprint-1",
                    "cnf": {"jkt": "jkt-thumbprint-1"},
                    "nonce": "mint-nonce-1",
                    "scope": ["environment:connect"]
                }),
            )
            .unwrap();
        let body_bytes = Bytes::from(json!({"proof": proof}).to_string());

        let response = t3_connect_mint_credential(State(state.clone()), body_bytes.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["pragma"], "no-cache");
        let body = read_body_json(response).await;
        let credential = body["credential"].as_str().unwrap().to_owned();
        assert!(!credential.is_empty());
        assert!(body["expiresAt"].as_str().is_some());
        assert!(body["proof"].as_str().is_some_and(|p| p.split('.').count() == 3));

        let stored_jkt: Option<String> = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT proof_key_thumbprint FROM auth_pairing_links WHERE credential = ?1",
                [&credential],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_jkt.as_deref(), Some("jkt-thumbprint-1"));

        let replay = t3_connect_mint_credential(State(state), body_bytes).await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
        let _ = std::fs::remove_dir_all(&mint_dir);
    }
}
