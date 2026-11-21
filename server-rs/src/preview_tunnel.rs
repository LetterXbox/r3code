//! Raw TCP loopback tunnel over WebSocket (`GET /api/preview/tunnel`).
use crate::{
    auth::{AuthError, Principal},
    auth_http::{self, AuthHttpState},
    managed_policy,
    settings::Settings,
};
use axum::{
    extract::ws::{rejection::WebSocketUpgradeRejection, CloseFrame, Message, WebSocket, WebSocketUpgrade},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::broadcast,
};

pub const PREVIEW_TUNNEL_PORT_REFUSED_HEADER: &str = "x-t3-tunnel-port-refused";
pub const PREVIEW_TUNNEL_DISABLED_HEADER: &str = "x-t3-tunnel-disabled";
const REQUIRED_SCOPE: &str = "terminal:operate";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_BUFFER_SIZE: usize = 64 * 1024;

fn parse_port(value: Option<&str>) -> Option<u16> {
    let raw = value?.trim();
    let port: u16 = raw.parse().ok()?;
    (port >= 1).then_some(port)
}

fn header_is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn header_port(headers: &HeaderMap) -> Option<u16> {
    let host = headers.get(axum::http::header::HOST)?.to_str().ok()?;
    let suffix = host.rsplit_once(':')?.1;
    parse_port(Some(suffix))
}

fn single_header_response(
    status: StatusCode,
    header_name: &'static str,
    header_value: &'static str,
    message: String,
) -> Response {
    let mut response = (status, message).into_response();
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(header_name.as_bytes()),
        HeaderValue::from_str(header_value),
    ) {
        response.headers_mut().insert(name, value);
    }
    response
}

fn tunnel_allowed(settings: &Value) -> bool {
    managed_policy::allows_preview_tunnel(settings).unwrap_or(false)
}

async fn dial_loopback(port: u16) -> Option<TcpStream> {
    for addr in [format!("127.0.0.1:{port}"), format!("[::1]:{port}")] {
        if let Ok(Ok(stream)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr)).await
        {
            let _ = stream.set_nodelay(true);
            return Some(stream);
        }
    }
    None
}

fn auth_rejection_response(
    error: AuthError,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Response {
    let internal = matches!(
        error,
        AuthError::Database(_) | AuthError::Proof(crate::dpop::ProofError::Storage)
    );
    let status = if internal {
        StatusCode::INTERNAL_SERVER_ERROR
    } else if matches!(error, AuthError::Proof(crate::dpop::ProofError::Replay)) {
        StatusCode::CONFLICT
    } else {
        StatusCode::UNAUTHORIZED
    };
    let has_credential = query.contains_key("wsTicket")
        || headers.contains_key(axum::http::header::AUTHORIZATION)
        || headers.contains_key(axum::http::header::COOKIE);
    let mut body = json!({
        "code": if internal { "internal_error" } else { "auth_invalid" },
        "reason": if internal {
            "internal_error"
        } else if has_credential {
            "invalid_credential"
        } else {
            "missing_credential"
        },
        "traceId": uuid::Uuid::new_v4().to_string(),
    });
    let is_proof = if let AuthError::Proof(proof) = error {
        body["dpopFailureReason"] = json!(proof.wire_reason());
        true
    } else {
        false
    };
    let mut response = (status, Json(body)).into_response();
    if is_proof {
        response.headers_mut().insert(
            axum::http::header::WWW_AUTHENTICATE,
            HeaderValue::from_static("DPoP"),
        );
    }
    response
}

pub async fn handle(
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    headers: HeaderMap,
    query: HashMap<String, String>,
    auth: Arc<AuthHttpState>,
    settings: Arc<Settings>,
) -> Response {
    let Some(port) = parse_port(query.get("port").map(String::as_str)) else {
        return (StatusCode::BAD_REQUEST, "Bad Request").into_response();
    };
    let Ok(ws) = ws else {
        return (StatusCode::BAD_REQUEST, "Bad Request").into_response();
    };
    if !header_is_websocket_upgrade(&headers) {
        return (StatusCode::BAD_REQUEST, "Bad Request").into_response();
    }
    let principal = match auth_http::authenticate_media(
        &auth,
        &headers,
        query.get("wsTicket").map(String::as_str),
        query.get("dpop").map(String::as_str),
        "/api/preview/tunnel",
    ) {
        Ok(principal) if crate::application::session_current(&auth, &principal) => principal,
        Ok(_) => return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
        Err(error) => return auth_rejection_response(error, &headers, &query),
    };
    if !principal.scopes.iter().any(|s| s == REQUIRED_SCOPE) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "code": "insufficient_scope",
                "requiredScope": REQUIRED_SCOPE,
                "traceId": uuid::Uuid::new_v4().to_string(),
            })),
        )
            .into_response();
    }
    // Subscribe before checking the snapshot so a switch-off during dialing isn't missed.
    let settings_rx = settings.subscribe();
    if !tunnel_allowed(&settings.snapshot()) {
        return single_header_response(
            StatusCode::FORBIDDEN,
            PREVIEW_TUNNEL_DISABLED_HEADER,
            "1",
            "The preview tunnel is turned off on this T3 Code server.".into(),
        );
    }
    let served_port = auth
        .listen_address
        .get()
        .map(|addr| addr.port())
        .or_else(|| header_port(&headers));
    if served_port == Some(port) {
        return single_header_response(
            StatusCode::FORBIDDEN,
            PREVIEW_TUNNEL_PORT_REFUSED_HEADER,
            "1",
            format!("Port {port} is this T3 Code server's own port."),
        );
    }
    let Some(stream) = dial_loopback(port).await else {
        // Not 502: Cloudflare, in front of T3 Connect, swaps an origin 502 for its own page.
        return single_header_response(
            StatusCode::FORBIDDEN,
            PREVIEW_TUNNEL_PORT_REFUSED_HEADER,
            "1",
            format!("Nothing accepted a connection on loopback port {port}."),
        );
    };
    ws.on_upgrade(move |socket| bridge(socket, stream, auth, principal, settings, settings_rx))
        .into_response()
}

async fn bridge(
    socket: WebSocket,
    tcp: TcpStream,
    auth: Arc<AuthHttpState>,
    principal: Principal,
    settings: Arc<Settings>,
    mut settings_rx: broadcast::Receiver<Value>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (mut tcp_rx, mut tcp_tx) = tcp.into_split();
    let mut read_buf = vec![0u8; READ_BUFFER_SIZE];
    let mut session_check = tokio::time::interval(Duration::from_millis(500));
    session_check.tick().await;
    // Catch any setting transition between initial check and WebSocket upgrade completion.
    if !tunnel_allowed(&settings.snapshot()) || !crate::application::session_current(&auth, &principal) {
        let _ = ws_tx
            .send(Message::Close(Some(CloseFrame {
                code: 1000,
                reason: "tunnel closed".into(),
            })))
            .await;
        return;
    }

    loop {
        tokio::select! {
            read = tcp_rx.read(&mut read_buf) => {
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ws_tx.send(Message::Binary(read_buf[..n].to_vec().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Binary(bytes))) => {
                        if tcp_tx.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if tcp_tx.write_all(text.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                }
            }
            change = settings_rx.recv() => {
                match change {
                    Ok(next) => {
                        if !tunnel_allowed(&next) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if !tunnel_allowed(&settings.snapshot()) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = session_check.tick() => {
                if !crate::application::session_current(&auth, &principal) {
                    break;
                }
            }
        }
    }

    let _ = tcp_tx.shutdown().await;
    let _ = ws_tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::Application, auth::SessionClaims, auth_http::AuthHttpState,
        http_server::router_with_auth,
    };
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{connect_async, tungstenite};

    struct TestCleanup(PathBuf);
    impl Drop for TestCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sign_bearer(key: &[u8; 32], sid: &str, subject: &str, scopes: Vec<String>) -> String {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        crate::auth::sign_session(
            key,
            &SessionClaims {
                v: 1,
                kind: "session".into(),
                sid: sid.into(),
                sub: subject.into(),
                scopes,
                method: "bearer-access-token".into(),
                jkt: None,
                rtc: None,
                plk: None,
                iat: now_ms,
                exp: now_ms + 600_000,
            },
        )
        .unwrap()
    }

    fn test_app() -> (
        TestCleanup,
        Arc<Application>,
        Arc<AuthHttpState>,
        String,
        String,
    ) {
        let dir = std::env::temp_dir().join(format!("t3-tunnel-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::database::open_writer(&dir.join("state.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, method TEXT, expires_at TEXT, revoked_at TEXT);
             INSERT INTO auth_sessions(session_id, subject, scopes, method, expires_at, revoked_at) VALUES
             ('op-sid','test-op','[\"orchestration:read\",\"terminal:operate\"]','bearer-access-token','2999-01-01T00:00:00Z',NULL),
             ('ro-sid','test-ro','[\"orchestration:read\"]','bearer-access-token','2999-01-01T00:00:00Z',NULL);",
        )
        .unwrap();
        let signing_key = [7u8; 32];
        let auth = Arc::new(AuthHttpState {
            replay_dir: dir.join("secrets"),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: std::sync::Mutex::new(db),
            signing_key,
            descriptor: json!({"sessionCookieName":"t3_session_test"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let settings = Arc::new(Settings::new(dir.join("settings.json")));
        let app = Arc::new(
            Application::new(auth.clone(), "env-test".into(), "test".into())
                .with_settings_for_test(settings),
        );
        let op_token = sign_bearer(
            &signing_key,
            "op-sid",
            "test-op",
            vec!["orchestration:read".into(), "terminal:operate".into()],
        );
        let ro_token = sign_bearer(
            &signing_key,
            "ro-sid",
            "test-ro",
            vec!["orchestration:read".into()],
        );
        (TestCleanup(dir), app, auth, op_token, ro_token)
    }

    async fn spawn_server(app: Arc<Application>, auth: Arc<AuthHttpState>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _ = auth.listen_address.set(addr);
        let router = router_with_auth(app, auth);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        addr.port()
    }

    #[tokio::test]
    async fn tunnel_enforces_port_auth_policy_and_bridges_loopback_tcp() {
        let (_dir, app, auth, op_token, ro_token) = test_app();
        let server_port = spawn_server(app.clone(), auth.clone()).await;
        let client = reqwest::Client::new();

        // Missing upgrade header or bad port -> 400
        let res = client
            .get(format!("http://127.0.0.1:{server_port}/api/preview/tunnel?port=0"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let res = client
            .get(format!("http://127.0.0.1:{server_port}/api/preview/tunnel?port=9999"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Missing auth on WS upgrade -> 401
        let err = connect_async(format!(
            "ws://127.0.0.1:{server_port}/api/preview/tunnel?port=9999"
        ))
        .await
        .unwrap_err();
        if let tungstenite::Error::Http(resp) = err {
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        } else {
            panic!("expected HTTP error on unauthenticated tunnel upgrade: {err}");
        }

        // Missing terminal:operate scope -> 403 insufficient_scope
        let req = tungstenite::http::Request::builder()
            .uri(format!(
                "ws://127.0.0.1:{server_port}/api/preview/tunnel?port=9999"
            ))
            .header("host", format!("127.0.0.1:{server_port}"))
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header(
                "sec-websocket-key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("authorization", format!("Bearer {ro_token}"))
            .body(())
            .unwrap();
        let err = connect_async(req).await.unwrap_err();
        if let tungstenite::Error::Http(resp) = err {
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        } else {
            panic!("expected 403 for insufficient scope");
        }

        // Own server port refused -> 403 + x-t3-tunnel-port-refused: 1
        let req = tungstenite::http::Request::builder()
            .uri(format!(
                "ws://127.0.0.1:{server_port}/api/preview/tunnel?port={server_port}"
            ))
            .header("host", format!("127.0.0.1:{server_port}"))
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header(
                "sec-websocket-key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("authorization", format!("Bearer {op_token}"))
            .body(())
            .unwrap();
        let err = connect_async(req).await.unwrap_err();
        if let tungstenite::Error::Http(resp) = err {
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            assert_eq!(
                resp.headers()
                    .get(PREVIEW_TUNNEL_PORT_REFUSED_HEADER)
                    .and_then(|v| v.to_str().ok()),
                Some("1")
            );
        } else {
            panic!("expected 403 own-port refusal");
        }

        // Start a live TCP echo server on 127.0.0.1:0
        let echo_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = echo_listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = stream.read(&mut buf).await {
                        if n == 0 || stream.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        // Connect WebSocket tunnel -> echoes binary payload end-to-end
        let req = tungstenite::http::Request::builder()
            .uri(format!(
                "ws://127.0.0.1:{server_port}/api/preview/tunnel?port={echo_port}"
            ))
            .header("host", format!("127.0.0.1:{server_port}"))
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header(
                "sec-websocket-key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("authorization", format!("Bearer {op_token}"))
            .body(())
            .unwrap();
        let (mut ws, _) = connect_async(req).await.unwrap();
        ws.send(tungstenite::Message::Binary(b"hello-tunnel".to_vec().into()))
            .await
            .unwrap();
        let echoed = ws.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_data().as_ref(), b"hello-tunnel");

        // Turning off enablePreviewTunnel closes the active tunnel and blocks new ones with 403 + x-t3-tunnel-disabled
        app.settings_for_test()
            .update(&json!({"enablePreviewTunnel": false}))
            .unwrap();
        let next = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("tunnel should close after disable");
        assert!(matches!(
            next,
            None | Some(Ok(tungstenite::Message::Close(_))) | Some(Err(_))
        ));

        let req = tungstenite::http::Request::builder()
            .uri(format!(
                "ws://127.0.0.1:{server_port}/api/preview/tunnel?port={echo_port}"
            ))
            .header("host", format!("127.0.0.1:{server_port}"))
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header(
                "sec-websocket-key",
                tungstenite::handshake::client::generate_key(),
            )
            .header("authorization", format!("Bearer {op_token}"))
            .body(())
            .unwrap();
        let err = connect_async(req).await.unwrap_err();
        if let tungstenite::Error::Http(resp) = err {
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            assert_eq!(
                resp.headers()
                    .get(PREVIEW_TUNNEL_DISABLED_HEADER)
                    .and_then(|v| v.to_str().ok()),
                Some("1")
            );
        } else {
            panic!("expected 403 disabled header");
        }
    }
}
