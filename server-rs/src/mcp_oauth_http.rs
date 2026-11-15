//! HTTP bindings for MCP OAuth. Kept separate until MCP client authorization
//! and link fencing are wired into the public MCP router.
use crate::mcp_oauth::{self, McpOAuth};
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(crate) struct OAuthHttpState {
    pub oauth: McpOAuth,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub signing_key: [u8; 32],
    pub settings: Arc<crate::settings::Settings>,
    /// Browser sessions are optional until the isolated router is mounted.
    pub auth: Option<Arc<crate::auth_http::AuthHttpState>>,
}

pub(crate) fn router(state: Arc<OAuthHttpState>) -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server),
        )
        .route("/oauth/mcp/register", post(register))
        .route("/oauth/mcp/authorize", get(authorize))
        .route("/oauth/mcp/approval", post(approval))
        .route("/oauth/mcp/decision", post(decision))
        .route("/oauth/mcp/token", post(token))
        .with_state(state)
}

fn urls(headers: &HeaderMap) -> Option<(String, String)> {
    let host = headers.get("host")?.to_str().ok()?;
    let protocol = if headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        == Some("https")
    {
        "https"
    } else {
        "http"
    };
    let parsed = url::Url::parse(&format!("{protocol}://{host}")).ok()?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let issuer = parsed.origin().ascii_serialization();
    let resource = format!("{issuer}/mcp");
    Some((issuer, resource))
}

async fn protected_resource(headers: HeaderMap) -> Response {
    let Some((issuer, resource)) = urls(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    Json(json!({"resource":resource,"authorization_servers":[issuer],"scopes_supported":["orchestration:read","orchestration:operate"],"bearer_methods_supported":["header"],"resource_name":"T3 Code"})).into_response()
}
async fn authorization_server(headers: HeaderMap) -> Response {
    let Some((issuer, _)) = urls(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    Json(json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/oauth/mcp/authorize"),"token_endpoint":format!("{issuer}/oauth/mcp/token"),"registration_endpoint":format!("{issuer}/oauth/mcp/register"),"response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"scopes_supported":["orchestration:read","orchestration:operate"],"authorization_response_iss_parameter_supported":true})).into_response()
}
fn oauth_error(error: mcp_oauth::OAuthError) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [("cache-control", "no-store"), ("pragma", "no-cache")],
        Json(json!({"error":error.code,"error_description":error.description})),
    )
        .into_response()
}
fn safe_redirect_error(error: &mcp_oauth::OAuthError, request: &Value, issuer: &str, resource: &str) -> Option<String> {
    if error.code == "invalid_client" || error.description == "The redirect URI was not registered." { return None; }
    let mut redirect = request["redirect_uri"].as_str().and_then(|s| url::Url::parse(s).ok())?;
    {
        let mut query = redirect.query_pairs_mut();
        query.append_pair("error", error.code);
        let description = if error.code == "invalid_target" { format!("This server only issues tokens for {resource}.") } else { error.description.to_owned() };
        query.append_pair("error_description", &description);
        if let Some(state) = request["state"].as_str() { query.append_pair("state", state); }
        query.append_pair("iss", issuer);
    }
    Some(redirect.to_string())
}
fn authorization_failure(error: mcp_oauth::OAuthError, request: &Value, issuer: &str, resource: &str) -> Response {
    if error.code == "invalid_client" || error.description == "The redirect URI was not registered." {
        let message = if error.code == "invalid_client" {
            "This sign-in link names an unknown app. Start the sign-in again from it."
        } else {
            "This sign-in link sends you to an address the app did not register."
        };
        return (StatusCode::BAD_REQUEST, [("cache-control", "no-store"), ("referrer-policy", "no-referrer"), ("content-type", "text/html; charset=utf-8"), ("x-frame-options", "DENY"), ("x-content-type-options", "nosniff"), ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")], message).into_response();
    }
    let Some(redirect) = safe_redirect_error(&error, request, issuer, resource) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    (StatusCode::FOUND, [("location", redirect), ("cache-control", "no-store".to_owned()), ("referrer-policy", "no-referrer".to_owned())]).into_response()
}

const APPROVAL_PAGE_PATH: &str = "/connect-agent";
const HOSTED_APPROVAL_PATH: &str = "/approve-agent";
const DEFAULT_HOSTED_APP_URL: &str = "https://app.t3.codes";

fn resolve_hosted_app_url() -> String {
    let raw = match std::env::var("T3CODE_HOSTED_APP_URL") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_owned(),
        _ => return DEFAULT_HOSTED_APP_URL.to_owned(),
    };
    let Ok(url) = url::Url::parse(&raw) else {
        return DEFAULT_HOSTED_APP_URL.to_owned();
    };
    let is_loopback_http = url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        );
    if (url.scheme() != "https" && !is_loopback_http)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return DEFAULT_HOSTED_APP_URL.to_owned();
    }
    url.origin().ascii_serialization()
}

async fn hosted_approval_url(state: &OAuthHttpState, issuer: &str, raw_query: &str) -> Option<String> {
    let auth = state.auth.as_ref()?;
    let environment_id = auth
        .environment_descriptor
        .get()
        .and_then(|d| d["environmentId"].as_str())?;
    let replay_dir = &auth.replay_dir;
    let linked = std::fs::read_to_string(replay_dir.join("cloud-linked-user-id.bin"))
        .is_ok_and(|s| !s.trim().is_empty());
    let link_revoked = replay_dir.join("cloud-link-revoked.bin").exists();
    let has_runtime_config = replay_dir.join("cloud-endpoint-runtime-config.bin").exists();
    if !linked || link_revoked || !has_runtime_config {
        return None;
    }
    let tunnel_hostname = auth.cloud_connector.hostname().await?;
    let issuer_host = url::Url::parse(issuer).ok()?.host_str()?.to_owned();
    if tunnel_hostname != issuer_host {
        return None;
    }
    let mut url = url::Url::parse(&resolve_hosted_app_url()).ok()?;
    url.set_path(HOSTED_APPROVAL_PATH);
    url.set_query(if raw_query.is_empty() { None } else { Some(raw_query) });
    let existing: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "environment")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for (k, v) in existing {
            pairs.append_pair(&k, &v);
        }
        pairs.append_pair("environment", environment_id);
    }
    Some(url.to_string())
}

async fn authorize(State(state): State<Arc<OAuthHttpState>>, headers: HeaderMap, OriginalUri(uri): OriginalUri) -> Response {
    let Some((issuer, resource)) = urls(&headers) else { return StatusCode::BAD_REQUEST.into_response(); };
    let raw = uri.query().unwrap_or("");
    let fields: serde_json::Map<String, Value> = url::form_urlencoded::parse(raw.as_bytes())
        .map(|(key, value)| (key.into_owned(), Value::String(value.into_owned()))).collect();
    let request = Value::Object(fields);
    match state.oauth.approval_details(&request, &resource) {
        Ok((client, _)) => {
            let hosted = if client.peer_link {
                None
            } else {
                hosted_approval_url(&state, &issuer, raw).await
            };
            let target = hosted.unwrap_or_else(|| {
                if raw.is_empty() {
                    APPROVAL_PAGE_PATH.to_owned()
                } else {
                    format!("{APPROVAL_PAGE_PATH}?{raw}")
                }
            });
            (StatusCode::FOUND, [("location", target), ("cache-control", "no-store".to_owned()), ("referrer-policy", "no-referrer".to_owned())]).into_response()
        }
        Err(error) => authorization_failure(error, &request, &issuer, &resource),
    }
}

async fn approval(State(state): State<Arc<OAuthHttpState>>, headers: HeaderMap, Json(request): Json<Value>) -> Response {
    let Some((issuer, resource)) = urls(&headers) else { return StatusCode::BAD_REQUEST.into_response(); };
    match state.oauth.approval_details(&request, &resource) {
        Ok((client, redirect)) => {
            let redirect_host = url::Url::parse(&redirect).ok().and_then(|url| url.host_str().map(|host| match url.port() { Some(port) => format!("{host}:{port}"), None => host.to_owned() }));
            let environment_host = url::Url::parse(&issuer).ok().and_then(|url| url.host_str().map(|host| match url.port() { Some(port) => format!("{host}:{port}"), None => host.to_owned() }));
            let mut result = json!({"clientName":client.name,"redirectHost":redirect_host,"environmentHost":environment_host});
            if let Some(principal) = state.auth.as_ref().and_then(|auth| crate::auth_http::authenticate_at(auth, &headers, None, None, "POST", "/oauth/mcp/approval").ok()) {
                if let Ok(Some((csrf, accesses))) = state.oauth.browser_approval(&request, &resource, &principal) {
                    result["csrfToken"] = json!(csrf);
                    result["oneClickAccess"] = json!(accesses);
                }
            }
            ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(result)).into_response()
        }
        Err(error) => match safe_redirect_error(&error, &request, &issuer, &resource) {
            Some(redirect) => ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"redirectTo":redirect}))).into_response(),
            None => (StatusCode::BAD_REQUEST, Json(json!({"_tag":"AuthMcpApprovalError","message": if error.code == "invalid_client" {"This sign-in link names an unknown app. Start the sign-in again from it."} else {"This sign-in link sends you to an address the app did not register."}}))).into_response(),
        },
    }
}
async fn register(State(state): State<Arc<OAuthHttpState>>, Json(input): Json<Value>) -> Response {
    match state.oauth.register(&input,state.settings.snapshot()["linkedEnvironmentsEnabled"]==true) {
        Ok(client)=>(StatusCode::CREATED,[("cache-control", "no-store"), ("pragma", "no-cache")],Json(json!({"client_id":client.id,"client_name":client.name,"redirect_uris":client.redirects,"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}))).into_response(),
        Err(error)=>oauth_error(error),
    }
}
async fn decision(
    State(state): State<Arc<OAuthHttpState>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let Some((issuer, resource)) = urls(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let authorization = &input["authorization"];
    let decision = &input["decision"];
    let (_, redirect) = match state.oauth.approval_details(authorization, &resource) {
        Ok(details) => details,
        Err(error) => return match safe_redirect_error(&error, authorization, &issuer, &resource) {
            Some(redirect) => ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"redirectTo":redirect}))).into_response(),
            None => (StatusCode::BAD_REQUEST, Json(json!({"_tag":"AuthMcpApprovalError","message":if error.code == "invalid_client" {"This sign-in link names an unknown app. Start the sign-in again from it."} else {"This sign-in link sends you to an address the app did not register."}}))).into_response(),
        },
    };
    if decision["_tag"] == "deny" {
        let Ok(mut url) = url::Url::parse(&redirect) else { return StatusCode::BAD_REQUEST.into_response(); };
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("error", "access_denied");
            if let Some(state) = authorization["state"].as_str() { query.append_pair("state", state); }
            query.append_pair("iss", &issuer);
        }
        return ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"redirectTo":url.to_string()}))).into_response();
    }
    if decision["_tag"] == "browser-session" {
        let principal = state.auth.as_ref().and_then(|auth| crate::auth_http::authenticate_at(auth, &headers, None, None, "POST", "/oauth/mcp/decision").ok());
        let access = decision["access"].as_str().unwrap_or("");
        let csrf = decision["csrfToken"].as_str().unwrap_or("");
        let code = principal.as_ref().and_then(|principal| state.oauth.approve_browser(authorization, &resource, principal, csrf, access).ok());
        let Some(code) = code else {
            return (StatusCode::BAD_REQUEST, [("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"_tag":"AuthMcpApprovalError","message":"Your session cannot approve this request. Enter a pairing code instead."}))).into_response();
        };
        let Ok(mut url) = url::Url::parse(&redirect) else { return StatusCode::BAD_REQUEST.into_response(); };
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("code", &code);
            if let Some(state) = authorization["state"].as_str() { query.append_pair("state", state); }
            query.append_pair("iss", &issuer);
        }
        return ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"redirectTo":url.to_string()}))).into_response();
    }
    if decision["_tag"] != "pairing-code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"_tag":"AuthMcpApprovalError","message":"A pairing code is required."})),
        )
            .into_response();
    }
    let Some(access) = decision["access"].as_str() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(credential) = decision["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    match state.oauth.approve_pairing(
        &state.db,
        authorization,
        &resource,
        access,
        credential,
        &now,
    ) {
        Ok(code) => {
            let Some(redirect) = authorization["redirect_uri"].as_str() else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            let Ok(mut url) = url::Url::parse(redirect) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("code", &code);
                if let Some(state) = authorization["state"].as_str() {
                    query.append_pair("state", state);
                }
                query.append_pair("iss", &issuer);
            }
            ([("cache-control", "no-store"), ("pragma", "no-cache")], Json(json!({"redirectTo":url.to_string()}))).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            [("cache-control", "no-store"), ("pragma", "no-cache")],
            Json(json!({"_tag":"AuthMcpApprovalError","message":error.description})),
        )
            .into_response(),
    }
}
async fn token(
    State(state): State<Arc<OAuthHttpState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some((_, resource)) = urls(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if body.len() > 64 * 1024 {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let mut fields = serde_json::Map::new();
    for (key, value) in url::form_urlencoded::parse(&body) {
        fields
            .entry(key.into_owned())
            .or_insert(Value::String(value.into_owned()));
    }
    let grant = match state.oauth.exchange(&Value::Object(fields), &resource) {
        Ok(grant) => grant,
        Err(error) => return oauth_error(error),
    };
    match mcp_oauth::issue_session(
        &state.db,
        &state.signing_key,
        grant,
        chrono::Utc::now().timestamp_millis(),
    ) {
        Ok(result) => (
            [("cache-control", "no-store"), ("pragma", "no-cache")],
            Json(result),
        )
            .into_response(),
        Err(error) => oauth_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browser_approval_requires_authenticated_scope_and_bound_csrf() {
        use axum::{body::{Body, to_bytes}, http::Request};
        use tower::ServiceExt;
        let dir = std::env::temp_dir().join(format!("mcp-oauth-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,subject TEXT,scopes TEXT,method TEXT,expires_at TEXT,revoked_at TEXT); INSERT INTO auth_sessions VALUES('owner','owner','[\"access:write\",\"orchestration:read\"]','browser-session-cookie','2999',NULL)").unwrap();
        let signing_key = [5; 32];
        let now = chrono::Utc::now().timestamp_millis();
        let token = crate::auth::sign_session(&signing_key, &crate::auth::SessionClaims { v:1, kind:"session".into(), sid:"owner".into(), sub:"owner".into(), scopes:vec!["access:write".into(),"orchestration:read".into()], method:"browser-session-cookie".into(), jkt:None, rtc:None, plk:None, iat:now, exp:now+60_000 }).unwrap();
        let auth = Arc::new(crate::auth_http::AuthHttpState { replay_dir:dir.clone(), environment_descriptor:std::sync::OnceLock::new(), cloud_action_lock:tokio::sync::Mutex::new(()), cloud_generation:std::sync::atomic::AtomicU64::new(0), cloud_connector:crate::cloud_connector::Connector::default(), listen_address:std::sync::OnceLock::new(), db:Mutex::new(db), lifecycle:Default::default(), signing_key, descriptor:json!({"sessionCookieName":"test"}), trusted_origins:vec![], accept_legacy_cookie:false, desktop_bootstrap:None });
        let oauth = McpOAuth::new([6;32]);
        let client = oauth.register(&json!({"redirect_uris":["http://localhost:51234/callback"]}),false).unwrap();
        let verifier = "a".repeat(43);
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use sha2::{Digest, Sha256};
        let authorization = json!({"client_id":client.id,"redirect_uri":"http://localhost:51234/callback","response_type":"code","code_challenge":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),"code_challenge_method":"S256","resource":"http://example.test/mcp"});
        let app = router(Arc::new(OAuthHttpState { oauth, db:Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())), signing_key, settings:Arc::new(crate::settings::Settings::new(dir.join("settings.json"))), auth:Some(auth) }));
        let call = |path:&str, body:Value, cookie:Option<&str>| {
            let mut builder = Request::builder().method("POST").uri(path).header("host","example.test").header("content-type","application/json");
            if let Some(cookie) = cookie { builder = builder.header("cookie",format!("test={cookie}")); }
            builder.body(Body::from(body.to_string())).unwrap()
        };
        let response = app.clone().oneshot(call("/oauth/mcp/approval", authorization.clone(), Some(&token))).await.unwrap();
        let approval: Value = serde_json::from_slice(&to_bytes(response.into_body(),4096).await.unwrap()).unwrap();
        assert_eq!(approval["oneClickAccess"], json!(["read-only"]));
        let csrf = approval["csrfToken"].as_str().unwrap();
        let decision = |csrf:&str,access:&str| json!({"authorization":authorization,"decision":{"_tag":"browser-session","access":access,"csrfToken":csrf}});
        let response = app.clone().oneshot(call("/oauth/mcp/decision",decision(csrf,"read-only"),None)).await.unwrap();
        assert_eq!(response.status(),StatusCode::BAD_REQUEST);
        let response = app.clone().oneshot(call("/oauth/mcp/decision",decision("tampered","read-only"),Some(&token))).await.unwrap();
        assert_eq!(response.status(),StatusCode::BAD_REQUEST);
        let response = app.clone().oneshot(call("/oauth/mcp/decision",decision(csrf,"full-access"),Some(&token))).await.unwrap();
        assert_eq!(response.status(),StatusCode::BAD_REQUEST);
        let response = app.oneshot(call("/oauth/mcp/decision",decision(csrf,"read-only"),Some(&token))).await.unwrap();
        assert_eq!(response.status(),StatusCode::OK);
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(),4096).await.unwrap()).unwrap();
        assert!(url::Url::parse(body["redirectTo"].as_str().unwrap()).unwrap().query_pairs().any(|(key,_)| key=="code"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn authorization_handoff_validates_client_before_redirect() {
        use axum::{body::{Body, to_bytes}, http::Request};
        use tower::ServiceExt;
        let dir = std::env::temp_dir().join(format!("mcp-oauth-approval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(crate::settings::Settings::new(dir.join("settings.json")));
        let oauth = McpOAuth::new([6; 32]);
        let client = oauth.register(&json!({"client_name":"Fixture","redirect_uris":["http://localhost:51234/callback"]}), false).unwrap();
        let app = router(Arc::new(OAuthHttpState { oauth, db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())), signing_key:[5;32], settings, auth:None }));
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/oauth/mcp/register").header("content-type","application/json").body(Body::from(json!({"redirect_uris":["http://localhost:51234/callback"]}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["pragma"], "no-cache");
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/oauth/mcp/token").header("host","example.test").body(Body::from("grant_type=invalid")).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let auth = json!({"client_id":client.id,"redirect_uri":"http://localhost:51234/callback","response_type":"code","code_challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","code_challenge_method":"S256","resource":"http://example.test/mcp","state":"state"});
        let query = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(auth.as_object().unwrap().iter().map(|(k,v)| (k.as_str(),v.as_str().unwrap()))).finish();
        let response = app.clone().oneshot(Request::builder().uri(format!("/oauth/mcp/authorize?{query}")).header("host","example.test").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers()["location"], format!("/connect-agent?{query}"));
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/oauth/mcp/approval").header("host","example.test").header("content-type","application/json").body(Body::from(auth.to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body, json!({"clientName":"Fixture","redirectHost":"localhost:51234","environmentHost":"example.test"}));
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/oauth/mcp/decision").header("host","example.test").header("content-type","application/json").body(Body::from(json!({"authorization":auth,"decision":{"_tag":"deny"}}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        let denied = url::Url::parse(body["redirectTo"].as_str().unwrap()).unwrap();
        let params: std::collections::HashMap<_,_> = denied.query_pairs().into_owned().collect();
        assert_eq!(params.get("error").map(String::as_str), Some("access_denied"));
        assert_eq!(params.get("state").map(String::as_str), Some("state"));
        assert_eq!(params.get("iss").map(String::as_str), Some("http://example.test"));
        let mut invalid = auth.clone(); invalid["response_type"] = json!("token");
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/oauth/mcp/approval").header("host","example.test").header("content-type","application/json").body(Body::from(invalid.to_string())).unwrap()).await.unwrap();
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        let redirect = url::Url::parse(body["redirectTo"].as_str().unwrap()).unwrap();
        assert_eq!(redirect.host_str(), Some("localhost"));
        assert!(redirect.query_pairs().any(|(key,value)| key == "error" && value == "unsupported_response_type"));
        let response = app.oneshot(Request::builder().uri("/oauth/mcp/authorize?client_id=forged&redirect_uri=https%3A%2F%2Fevil.test").header("host","example.test").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!response.headers().contains_key("location"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn peer_pairing_exchanges_once_for_a_scoped_revocable_session() {
        let dir = std::env::temp_dir().join(format!("mcp-oauth-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(crate::settings::Settings::new(dir.join("settings.json")));
        settings
            .update(&json!({"linkedEnvironmentsEnabled":true}))
            .unwrap();
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut conn).unwrap();
        conn.execute("INSERT INTO auth_pairing_links(id,credential,method,scopes,subject,created_at,expires_at) VALUES('pair','23456789ABCD','one-time-token','[\"orchestration:read\"]','one-time-token','2020-01-01T00:00:00Z','2999-01-01T00:00:00Z')",[]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let signing_key = [5; 32];
        let app = router(Arc::new(OAuthHttpState {
            oauth: McpOAuth::new([6; 32]),
            db: db.clone(),
            signing_key,
            settings,
            auth: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::peer_links::peer_client().unwrap();
        let issued =
            crate::peer_links::sign_in(&client, &origin, "fixture", "23456789ABCD", "read-only")
                .await
                .unwrap();
        let principal = crate::auth::verify_session(
            &db.lock().unwrap(),
            &signing_key,
            &issued.token,
            chrono::Utc::now().timestamp_millis(),
        )
        .unwrap();
        assert_eq!(principal.subject, "mcp-client");
        assert!(principal.peer_link);
        assert_eq!(principal.scopes, vec!["orchestration:read"]);
        assert!(crate::peer_links::sign_in(
            &client,
            &origin,
            "fixture",
            "23456789ABCD",
            "read-only"
        )
        .await
        .is_err());
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn authorize_redirects_tunnel_to_hosted_app_and_keeps_peer_links_local() {
        use axum::{body::Body, http::Request};
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use sha2::{Digest, Sha256};
        use tower::ServiceExt;
        let dir = std::env::temp_dir().join(format!("mcp-oauth-hosted-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cloud-linked-user-id.bin"), "user_1").unwrap();
        std::fs::write(dir.join("cloud-endpoint-runtime-config.bin"), "{}").unwrap();

        let metrics_router = Router::new().route(
            "/config",
            get(|| async { Json(json!({"config":{"ingress":[{"hostname":"box.example.ts.net"}]}})) }),
        );
        let metrics_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let metrics_addr = metrics_listener.local_addr().unwrap();
        let metrics_server = tokio::spawn(async move { axum::serve(metrics_listener, metrics_router).await.unwrap() });

        let descriptor_lock = std::sync::OnceLock::new();
        descriptor_lock.set(json!({"environmentId": "env-123"})).unwrap();
        let connector = crate::cloud_connector::Connector::default();
        connector.set_metrics_for_test(metrics_addr).await;

        let auth = Arc::new(crate::auth_http::AuthHttpState {
            replay_dir: dir.clone(),
            environment_descriptor: descriptor_lock,
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: connector,
            listen_address: std::sync::OnceLock::new(),
            db: Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            lifecycle: Default::default(),
            signing_key: [5; 32],
            descriptor: json!({"sessionCookieName":"test"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let oauth = McpOAuth::new([6; 32]);
        let app_client = oauth
            .register(&json!({"client_name":"Agent","redirect_uris":["http://localhost:51234/callback"]}), false)
            .unwrap();
        let peer_client = oauth
            .register(
                &json!({"client_name":"Peer","redirect_uris":["http://localhost:51234/callback"],"software_id":"t3code-peer-link"}),
                true,
            )
            .unwrap();
        let app = router(Arc::new(OAuthHttpState {
            oauth,
            db: Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap())),
            signing_key: [5; 32],
            settings: Arc::new(crate::settings::Settings::new(dir.join("settings.json"))),
            auth: Some(auth),
        }));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest("a".repeat(43).as_bytes()));
        let make_query = |client_id: &str, resource: &str| {
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("client_id", client_id)
                .append_pair("redirect_uri", "http://localhost:51234/callback")
                .append_pair("response_type", "code")
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("resource", resource)
                .finish()
        };

        let tunnel_query = make_query(&app_client.id, "https://box.example.ts.net/mcp");
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/oauth/mcp/authorize?{tunnel_query}"))
                    .header("host", "box.example.ts.net")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let loc = res.headers().get("location").unwrap().to_str().unwrap();
        let hosted = url::Url::parse(loc).unwrap();
        assert_eq!(hosted.origin().ascii_serialization(), "https://app.t3.codes");
        assert_eq!(hosted.path(), "/approve-agent");
        assert_eq!(
            hosted.query_pairs().find(|(k, _)| k == "environment").map(|(_, v)| v.into_owned()),
            Some("env-123".to_owned())
        );

        let other_query = make_query(&app_client.id, "https://other.t3coderelay.com/mcp");
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/oauth/mcp/authorize?{other_query}"))
                    .header("host", "other.t3coderelay.com")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        assert_eq!(
            res.headers().get("location").unwrap().to_str().unwrap(),
            format!("/connect-agent?{other_query}")
        );

        let peer_query = make_query(&peer_client.id, "https://box.example.ts.net/mcp");
        let res = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/oauth/mcp/authorize?{peer_query}"))
                    .header("host", "box.example.ts.net")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        assert_eq!(
            res.headers().get("location").unwrap().to_str().unwrap(),
            format!("/connect-agent?{peer_query}")
        );

        metrics_server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
