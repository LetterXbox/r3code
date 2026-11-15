//! Axum HTTP/WebSocket adapter for the RPC envelope. The application supplies
//! authentication, per-method authorization, dispatch, and invalidation.
use crate::rpc::{self, Request, RequestId};
use crate::transport::{self, Action, Connection, HttpRejection};
use axum::{
    extract::{
        ws::{rejection::WebSocketUpgradeRejection, Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, on, post, MethodFilter},
    Json, Router,
};
use futures_util::FutureExt;
use serde_json::Value;
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};
use tokio::{net::TcpListener, sync::mpsc, task::JoinHandle};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Debug, Clone)]
pub enum RpcFailure {
    Fail(Value),
    Die(Value),
}
impl RpcFailure {
    fn into_cause(self) -> Value {
        match self {
            Self::Fail(value) => rpc::fail(value),
            Self::Die(value) => rpc::die(value),
        }
    }
}

/// Application security and unary dispatch. `authorize` is called on every
/// request before `dispatch`; failures are encoded as declared RPC failures.
/// The invalidation future must resolve when the authenticated session expires
/// or is revoked. Stream receivers must be bounded; dropping the receiver must
/// stop the producer. Each item is one non-empty chunk or a declared error.
pub trait RpcApplication: Send + Sync + 'static {
    type Session: Clone + Send + Sync + 'static;
    fn descriptor(&self) -> Value;
    fn preview_stream(
        &self,
        _ws: WebSocketUpgrade,
        _headers: HeaderMap,
        _query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        Box::pin(async { (StatusCode::NOT_FOUND, "Not Found").into_response() })
    }
    fn pull_request_diff(&self, _request: axum::extract::Request) -> BoxFuture<Response> {
        Box::pin(async {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"not_found"})),
            )
                .into_response()
        })
    }
    fn orchestration_shell(
        &self,
        _headers: HeaderMap,
        _query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        Box::pin(async {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"not_found"})),
            )
                .into_response()
        })
    }
    fn orchestration_thread_bounded(
        &self,
        _thread_id: String,
        _headers: HeaderMap,
        _query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        Box::pin(async {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"not_found"})),
            )
                .into_response()
        })
    }
    /// Handle a raw webhook only when the application has a complete delivery service.
    fn webhook(&self, _request: WebhookHttpRequest) -> BoxFuture<WebhookHttpResponse> {
        Box::pin(async {
            WebhookHttpResponse {
                status: 404,
                outcome: "not_found".into(),
                body: serde_json::json!({"error":"hook_not_found"}),
            }
        })
    }
    fn authenticate(
        &self,
        headers: &HeaderMap,
        query: &HashMap<String, String>,
    ) -> Result<Self::Session, HttpRejection>;
    fn authorize(&self, session: &Self::Session, request: &Request) -> Result<(), RpcFailure>;
    fn dispatch(
        &self,
        session: Self::Session,
        request: Request,
    ) -> BoxFuture<Result<Value, RpcFailure>>;
    fn stream(
        &self,
        _session: Self::Session,
        _request: &Request,
    ) -> Option<mpsc::Receiver<Result<Vec<Value>, Value>>> {
        None
    }
    fn connected(&self, _session: &Self::Session) {}
    fn disconnected(&self, _session: &Self::Session) {}
    fn invalidated(&self, session: Self::Session) -> BoxFuture<()>;
}

/// Bytes are retained exactly for signature verification; the token is never included in path.
pub struct WebhookHttpRequest {
    pub hook_id: String,
    pub token: String,
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}
pub struct WebhookHttpResponse {
    pub status: u16,
    pub outcome: String,
    pub body: Value,
}
const WEBHOOK_MAX_BODY_BYTES: usize = 1024 * 1024;

async fn webhook<A: RpcApplication>(
    State(app): State<Arc<A>>,
    Path((hook_id, token)): Path<(String, String)>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let respond = |status: StatusCode, outcome: &str, body: Value| {
        let mut response = (status, Json(body)).into_response();
        if let Ok(value) = HeaderValue::from_str(outcome) {
            response.headers_mut().insert("x-t3-hook-outcome", value);
        }
        response
    };
    if parts.method == axum::http::Method::HEAD {
        let mut response = respond(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            serde_json::json!({"error":"method_not_allowed"}),
        );
        response.headers_mut().insert(
            axum::http::header::ALLOW,
            HeaderValue::from_static("GET, POST, PUT, PATCH"),
        );
        return response;
    }
    if parts
        .headers
        .get(axum::http::header::CONTENT_LENGTH)
        .is_some_and(|v| {
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .is_none_or(|n| n > WEBHOOK_MAX_BODY_BYTES)
        })
    {
        return respond(
            StatusCode::PAYLOAD_TOO_LARGE,
            "body_too_large",
            serde_json::json!({"error":"body_too_large"}),
        );
    }
    let body = match axum::body::to_bytes(body, WEBHOOK_MAX_BODY_BYTES).await {
        Ok(body) => body.to_vec(),
        Err(_) => {
            return respond(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                serde_json::json!({"error":"body_too_large_or_unreadable"}),
            )
        }
    };
    let path = format!(
        "/api/hooks/{}",
        percent_encoding::utf8_percent_encode(&hook_id, percent_encoding::NON_ALPHANUMERIC)
    );
    let result = app
        .webhook(WebhookHttpRequest {
            hook_id,
            token,
            method: parts.method.to_string(),
            path,
            query: parts.uri.query().unwrap_or("").to_owned(),
            headers: parts.headers,
            body,
        })
        .await;
    respond(
        StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &result.outcome,
        result.body,
    )
}

pub fn router<A: RpcApplication>(app: Arc<A>) -> Router {
    Router::new()
        .route("/.well-known/t3/environment", get(descriptor::<A>))
        .route("/ws", get(upgrade::<A>))
        .route("/api/preview-stream/ws", get(preview_stream::<A>))
        .route("/api/pull-requests/diff", post(pull_request_diff::<A>))
        .route("/api/orchestration/shell", get(orchestration_shell::<A>))
        .route(
            "/api/orchestration/threads/{thread_id}/bounded",
            get(orchestration_thread_bounded::<A>),
        )
        .route(
            "/api/hooks/{hook_id}/{token}",
            on(
                MethodFilter::GET
                    .or(MethodFilter::POST)
                    .or(MethodFilter::PUT)
                    .or(MethodFilter::PATCH),
                webhook::<A>,
            ),
        )
        .with_state(app)
}

async fn preview_stream<A: RpcApplication>(
    State(app): State<Arc<A>>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    app.preview_stream(ws, headers, query).await
}

/// Assemble the RPC and browser-auth routes with their separately scoped state.
pub fn router_with_auth<A: RpcApplication>(
    app: Arc<A>,
    auth: Arc<crate::auth_http::AuthHttpState>,
) -> Router {
    router_with_auth_and_otlp(app, auth, crate::otlp_http::ExportConfig::default())
}

pub fn router_with_auth_and_otlp<A: RpcApplication>(app: Arc<A>, auth: Arc<crate::auth_http::AuthHttpState>, export: crate::otlp_http::ExportConfig) -> Router {
    router(app).merge(crate::auth_http::router(auth.clone())).merge(crate::otlp_http::router(auth, export))
}

/// Serve until `shutdown` resolves. Existing connections are closed by the
/// application on session invalidation; graceful shutdown waits for them.
pub async fn serve<A: RpcApplication>(
    listener: TcpListener,
    app: Arc<A>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<crate::auth_http::SocketPeer>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

/// Serve the RPC and browser-auth HTTP surfaces from the same listener.
///
/// Keeping this as the production serving entry point avoids accidentally
/// exposing WebSocket RPC while omitting the pairing/session routes required
/// to obtain its credentials.
pub async fn serve_with_auth<A: RpcApplication>(
    listener: TcpListener,
    app: Arc<A>,
    auth: Arc<crate::auth_http::AuthHttpState>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(
        listener,
        router_with_auth(app, auth)
            .into_make_service_with_connect_info::<crate::auth_http::SocketPeer>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}
async fn pull_request_diff<A: RpcApplication>(
    State(app): State<Arc<A>>,
    request: axum::extract::Request,
) -> Response {
    app.pull_request_diff(request).await
}

async fn orchestration_shell<A: RpcApplication>(
    State(app): State<Arc<A>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    app.orchestration_shell(headers, query).await
}

async fn orchestration_thread_bounded<A: RpcApplication>(
    State(app): State<Arc<A>>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    app.orchestration_thread_bounded(thread_id, headers, query)
        .await
}

async fn descriptor<A: RpcApplication>(State(app): State<Arc<A>>) -> Json<Value> {
    Json(app.descriptor())
}

fn rejection(error: HttpRejection) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, Json(error.body)).into_response();
    for (name, value) in error.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}
async fn upgrade<A: RpcApplication>(
    State(app): State<Arc<A>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let authenticated = match transport::prepare_upgrade(
        query.get("orchestrationProtocol").map(String::as_str),
        || app.authenticate(&headers, &query),
    ) {
        Ok(session) => session,
        Err(error) => return rejection(error),
    };
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    let header_pairs = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_owned(), v.to_owned()))
        })
        .collect();
    let connection = Connection::new(
        authenticated,
        uuid::Uuid::new_v4().to_string(),
        header_pairs,
        query.contains_key("frameParts"),
    );
    ws.on_upgrade(move |socket| socket_loop(socket, app, connection))
        .into_response()
}

async fn send_value<S>(socket: &mut WebSocket, connection: &Connection<S>, value: &Value) -> bool {
    let Ok(parts) = connection.encode(value) else {
        return false;
    };
    for part in parts {
        if socket.send(Message::Text(part.into())).await.is_err() {
            return false;
        }
    }
    true
}

enum StreamEvent {
    Chunk {
        id: RequestId,
        generation: u64,
        values: Vec<Value>,
    },
    Exit {
        id: RequestId,
        generation: u64,
        result: Result<Value, Vec<Value>>,
    },
}
struct Running {
    task: JoinHandle<()>,
    notification: bool,
    generation: u64,
    ack: Option<mpsc::Sender<()>>,
}
struct SessionConnection<A: RpcApplication> {
    app: Arc<A>,
    session: A::Session,
}
impl<A: RpcApplication> Drop for SessionConnection<A> {
    fn drop(&mut self) {
        self.app.disconnected(&self.session);
    }
}
async fn socket_loop<A: RpcApplication>(
    mut socket: WebSocket,
    app: Arc<A>,
    mut connection: Connection<A::Session>,
) {
    app.connected(&connection.session);
    let _session_connection = SessionConnection {
        app: app.clone(),
        session: connection.session.clone(),
    };
    let (sender, mut receiver) = mpsc::channel::<StreamEvent>(1);
    let mut running: HashMap<RequestId, Running> = HashMap::new();
    let mut generation = 0_u64;
    let viewer_id = uuid::Uuid::new_v4().to_string();
    let invalidated = app.invalidated(connection.session.clone());
    tokio::pin!(invalidated);
    'socket: loop {
        tokio::select! {
            _ = &mut invalidated => break,
            event = receiver.recv() => {
                match event {
                    Some(StreamEvent::Chunk { id, generation, values }) => {
                        let Some(state) = running.get(&id).filter(|state| state.generation == generation) else { continue; };
                        if !state.notification {
                            let Ok(frame) = rpc::chunk(&id, values.clone()) else { continue; };
                            if !send_value(&mut socket, &connection, &frame).await { break; }
                        }
                        let synthetic = state.notification || connection.chunk_sent(&id, &values).is_some();
                        if synthetic { if let Some(ack) = &state.ack { let _ = ack.try_send(()); } }
                    }
                    Some(StreamEvent::Exit { id, generation, result }) => {
                        if running.get(&id).is_none_or(|state| state.generation != generation) { continue; }
                        let state = running.remove(&id).unwrap();
                        connection.exit_sent(&id);
                        if !state.notification {
                            let value = match result { Ok(value) => rpc::exit_success(&id, value), Err(cause) => rpc::exit_failure(&id, cause) };
                            if !send_value(&mut socket, &connection, &value).await { break; }
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                let bytes = match incoming {
                    Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                    Some(Ok(Message::Binary(bytes))) => bytes.to_vec(),
                    Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } continue; },
                    Some(Ok(Message::Pong(_))) => continue,
                    _ => break,
                };
                for action in connection.receive(&bytes) {
                    match action {
                        Action::Send(value) => if !send_value(&mut socket, &connection, &value).await { break 'socket; },
                        Action::Dispatch(mut request) => {
                            let id = request.id.clone();
                            let notification = request.is_notification;
                            if let Some(previous) = running.remove(&id) {
                                previous.task.abort();
                                connection.replace_request(&id, &request.tag);
                            }
                            if let Err(error) = app.authorize(&connection.session, &request) {
                                connection.exit_sent(&id);
                                if !notification && !send_value(&mut socket, &connection, &rpc::exit_failure(&id, vec![error.into_cause()])).await { break 'socket; }
                                continue;
                            }
                            request.headers.retain(|(name, _)| !name.eq_ignore_ascii_case("x-t3-internal-viewer"));
                            request.headers.push(("x-t3-internal-viewer".into(), viewer_id.clone()));
                            generation = generation.wrapping_add(1);
                            let task_generation = generation;
                            let tx = sender.clone();
                            let task_id = id.clone();
                            let (ack, task) = if let Some(mut stream) = app.stream(connection.session.clone(), &request) {
                                let (ack_tx, mut ack_rx) = mpsc::channel(1);
                                let task = tokio::spawn(async move {
                                    while let Some(item) = stream.recv().await {
                                        match item {
                                            Ok(values) if !values.is_empty() => {
                                                if tx.send(StreamEvent::Chunk { id: task_id.clone(), generation: task_generation, values }).await.is_err() { return; }
                                                if ack_rx.recv().await.is_none() { return; }
                                            }
                                            Ok(_) => continue,
                                            Err(error) => { let _ = tx.send(StreamEvent::Exit { id: task_id, generation: task_generation, result: Err(vec![rpc::fail(error)]) }).await; return; }
                                        }
                                    }
                                    let _ = tx.send(StreamEvent::Exit { id: task_id, generation: task_generation, result: Ok(Value::Null) }).await;
                                });
                                (Some(ack_tx), task)
                            } else {
                                let future = app.dispatch(connection.session.clone(), request);
                                let task = tokio::spawn(async move {
                                    let result = match std::panic::AssertUnwindSafe(future).catch_unwind().await {
                                        Ok(Ok(value)) => Ok(value),
                                        Ok(Err(error)) => Err(vec![error.into_cause()]),
                                        Err(_) => Err(vec![rpc::die(serde_json::json!({"name":"Error","message":"RPC handler failed"}))]),
                                    };
                                    let _ = tx.send(StreamEvent::Exit { id: task_id, generation: task_generation, result }).await;
                                });
                                (None, task)
                            };
                            running.insert(id, Running { task, notification, generation: task_generation, ack });
                        }
                        Action::Interrupt(id) => {
                            if let Some(state) = running.remove(&id) {
                                state.task.abort(); connection.exit_sent(&id);
                                if !state.notification && !send_value(&mut socket, &connection, &rpc::exit_failure(&id, vec![rpc::interrupt(None)])).await { break 'socket; }
                            }
                        }
                        Action::Ack(id) => { if let Some(ack) = running.get(&id).and_then(|state| state.ack.as_ref()) { let _ = ack.try_send(()); } }
                        Action::End => break 'socket,
                    }
                }
            }
        }
    }
    connection.close();
    for (_, state) in running {
        state.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        sync::atomic::{AtomicUsize, Ordering},
    };
    struct App(AtomicUsize);
    impl RpcApplication for App {
        type Session = ();
        fn descriptor(&self) -> Value {
            serde_json::json!({"environmentId":"test","orchestrationProtocolVersion":2})
        }
        fn authenticate(
            &self,
            _: &HeaderMap,
            _: &HashMap<String, String>,
        ) -> Result<(), HttpRejection> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(HttpRejection {
                status: 401,
                body: serde_json::json!({"code":"auth_invalid"}),
                headers: vec![],
            })
        }
        fn authorize(&self, _: &(), _: &Request) -> Result<(), RpcFailure> {
            Ok(())
        }
        fn dispatch(&self, _: (), _: Request) -> BoxFuture<Result<Value, RpcFailure>> {
            Box::pin(async { Ok(Value::Null) })
        }
        fn invalidated(&self, _: ()) -> BoxFuture<()> {
            Box::pin(std::future::pending())
        }
    }
    async fn request(addr: std::net::SocketAddr, target: &str, websocket: bool) -> String {
        let target = target.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut socket = std::net::TcpStream::connect(addr).unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let upgrade = if websocket { "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" } else { "Connection: close\r\n" };
            write!(socket, "GET {target} HTTP/1.1\r\nHost: localhost\r\n{upgrade}\r\n").unwrap();
            let mut response = [0; 4096];
            let n = socket.read(&mut response).unwrap();
            String::from_utf8_lossy(&response[..n]).into_owned()
        }).await.unwrap()
    }
    #[tokio::test]
    async fn descriptor_and_upgrade_gates() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Arc::new(App(AtomicUsize::new(0)));
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, app.clone(), async {
            let _ = stopped.await;
        }));
        assert!(request(addr, "/.well-known/t3/environment", false)
            .await
            .starts_with("HTTP/1.1 200"));
        assert!(request(addr, "/ws", true).await.starts_with("HTTP/1.1 426"));
        assert!(request(addr, "/ws", false)
            .await
            .starts_with("HTTP/1.1 426"));
        assert_eq!(app.0.load(Ordering::SeqCst), 0);
        assert!(request(addr, "/ws?orchestrationProtocol=2", true)
            .await
            .starts_with("HTTP/1.1 401"));
        assert_eq!(app.0.load(Ordering::SeqCst), 1);
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn webhook_route_is_fail_closed_and_caps_announced_payloads() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Arc::new(App(AtomicUsize::new(0)));
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, app, async {
            let _ = stopped.await;
        }));
        let raw = |request: &'static str| async move {
            tokio::task::spawn_blocking(move || {
                let mut socket = std::net::TcpStream::connect(addr).unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                socket.write_all(request.as_bytes()).unwrap();
                let mut response = [0; 4096];
                let n = socket.read(&mut response).unwrap();
                String::from_utf8_lossy(&response[..n]).into_owned()
            })
            .await
            .unwrap()
        };
        let response =
            raw("GET /api/hooks/id/token HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .await;
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
        assert!(response.contains("x-t3-hook-outcome: not_found"));
        let response = raw("POST /api/hooks/id/token HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 413"), "{response}");
        let response = raw(
            "HEAD /api/hooks/id/token HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 405"), "{response}");
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn webhook_http_delivery_survives_database_reopen_and_dispatches_once() {
        let path =
            std::env::temp_dir().join(format!("t3-hook-e2e-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = rusqlite::Connection::open(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let input = serde_json::json!({"commandId":"hook","title":"t","prompt":"Hello {{body.name}}","enabled":false,"schedule":{"type":"webhook"},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let auth = Arc::new(crate::auth_http::AuthHttpState {
            replay_dir: std::env::temp_dir(),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: std::sync::Mutex::new(rusqlite::Connection::open(&path).unwrap()),
            signing_key: [7; 32],
            descriptor: serde_json::json!({}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let bus = crate::event_bus::EventBus::new(db, 16);
        let blocked_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let blocked_addr = blocked_listener.local_addr().unwrap();
        let blocked_app =
            crate::application::Application::new(auth.clone(), "test".into(), "test".into())
                .with_event_bus(bus.clone())
                .with_webhook_policy(Some("blocked".into()));
        let (stop_blocked, stopped_blocked) = tokio::sync::oneshot::channel();
        let blocked_server = tokio::spawn(serve(blocked_listener, Arc::new(blocked_app), async {
            let _ = stopped_blocked.await;
        }));
        let response = reqwest::Client::new()
            .post(format!("http://{blocked_addr}/api/hooks/unknown/invalid"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(response.headers()["x-t3-hook-outcome"], "blocked_by_policy");
        let _ = stop_blocked.send(());
        blocked_server.await.unwrap().unwrap();
        bus.commit(|tx| {
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM scheduled_task_webhook_deliveries",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        })
        .unwrap();
        let app = crate::application::Application::new(auth, "test".into(), "test".into())
            .with_event_bus(bus.clone());
        let principal = crate::auth::Principal {
            session_id: "test".into(),
            subject: "user".into(),
            scopes: vec![],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            peer_link: false,
        };
        let rpc = |tag: &str, payload: Value| Request {
            id: crate::rpc::RequestId::String("1".into()),
            tag: tag.into(),
            payload,
            headers: vec![],
            is_notification: false,
            discard: false,
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let created = app
            .dispatch(
                principal.clone(),
                rpc("scheduledTasks.upsert", input.clone()),
            )
            .await
            .unwrap();
        assert_eq!(created["task"]["enabled"], false);
        let hook_path = created["task"]["webhook"]["path"]
            .as_str()
            .expect("operator receives a webhook path")
            .to_owned();
        let enabled = app
            .dispatch(
                principal.clone(),
                rpc(
                    "scheduledTasks.setEnabled",
                    serde_json::json!({"id":"scheduled-task:hook","enabled":true}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(enabled["task"]["enabled"], true);
        let mut enabled_input = input;
        enabled_input["enabled"] = serde_json::json!(true);
        assert_eq!(
            app.dispatch(principal, rpc("scheduledTasks.upsert", enabled_input))
                .await
                .unwrap()["task"]["enabled"],
            true
        );
        let server = tokio::spawn(serve(listener, Arc::new(app), async {
            let _ = stopped.await;
        }));
        let response = reqwest::Client::new()
            .post(format!("http://{addr}{hook_path}"))
            .body(r#"{"name":"Ada"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202);
        assert_eq!(response.headers()["x-t3-hook-outcome"], "accepted");
        let _ = stop.send(());
        server.await.unwrap().unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let scheduler = tokio::spawn(crate::scheduled_tasks::run_scheduler(
            bus.clone(),
            Arc::new(crate::provider::session_registry::SessionRegistry::default()),
            true,
        ));
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let count = bus
                    .commit(|tx| {
                        let count: i64 = tx.query_row(
                            "SELECT count(*) FROM orchestration_v2_projection_messages",
                            [],
                            |r| r.get(0),
                        )?;
                        Ok((count, vec![]))
                    })
                    .unwrap();
                if count == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        scheduler.abort();
        assert!(!crate::webhook_worker::run_one(&bus, None).unwrap());
        bus.commit(|tx| {
            let (count,text):(i64,String) = tx.query_row("SELECT count(*),json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
            assert_eq!(count,1); assert!(text.contains("Ada"));
            Ok(((),vec![]))
        }).unwrap();
        drop(bus);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn serving_with_auth_mounts_browser_session_routes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Arc::new(App(AtomicUsize::new(0)));
        let auth = Arc::new(crate::auth_http::AuthHttpState {
            replay_dir: std::env::temp_dir().join(format!("t3-dpop-test-{}", uuid::Uuid::new_v4())),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: std::sync::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            signing_key: [7; 32],
            descriptor: serde_json::json!({"sessionCookieName":"t3_session_v2"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_with_auth(listener, app, auth, async {
            let _ = stopped.await;
        }));

        // This route exists only when browser-auth is merged. With no session,
        // the handler returns its normal unauthenticated discovery response.
        let response = request(addr, "/api/auth/session", false).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"authenticated\":false"), "{response}");

        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }
    struct AuthenticatedApp;
    impl RpcApplication for AuthenticatedApp {
        type Session = ();
        fn descriptor(&self) -> Value {
            serde_json::json!({"environmentId":"test"})
        }
        fn authenticate(
            &self,
            headers: &HeaderMap,
            _: &HashMap<String, String>,
        ) -> Result<(), HttpRejection> {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer test") {
                Ok(())
            } else {
                Err(HttpRejection {
                    status: 401,
                    body: serde_json::json!({"code":"auth_invalid"}),
                    headers: vec![],
                })
            }
        }
        fn authorize(&self, _: &(), request: &Request) -> Result<(), RpcFailure> {
            if matches!(
                request.tag.as_str(),
                "server.probe" | "subscribeServerConfig" | "test.panic"
            ) {
                Ok(())
            } else {
                Err(RpcFailure::Fail(
                    serde_json::json!({"_tag":"EnvironmentAuthorizationError"}),
                ))
            }
        }
        fn dispatch(&self, _: (), request: Request) -> BoxFuture<Result<Value, RpcFailure>> {
            Box::pin(async move {
                if request.tag == "test.panic" {
                    panic!("test panic")
                }
                Ok(serde_json::json!({}))
            })
        }
        fn stream(
            &self,
            _: (),
            request: &Request,
        ) -> Option<mpsc::Receiver<Result<Vec<Value>, Value>>> {
            if request.tag != "subscribeServerConfig" {
                return None;
            }
            let (tx, rx) = mpsc::channel(1);
            tokio::spawn(async move {
                for i in 0..20 {
                    if tx.send(Ok(vec![serde_json::json!(i)])).await.is_err() {
                        break;
                    }
                }
            });
            Some(rx)
        }
        fn invalidated(&self, _: ()) -> BoxFuture<()> {
            Box::pin(std::future::pending())
        }
    }
    #[tokio::test]
    async fn real_websocket_roundtrip_auth_ping_and_unary() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, Arc::new(AuthenticatedApp), async {
            let _ = stopped.await;
        }));
        let mut request = format!("ws://{addr}/ws?orchestrationProtocol=2")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(Message::Text(r#"{"_tag":"Ping"}"#.into()))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            serde_json::json!({"_tag":"Pong"})
        );
        socket
            .send(Message::Text(
                r#"{"_tag":"Request","id":3,"tag":"server.probe","payload":{},"headers":[]}"#
                    .into(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            serde_json::json!({"_tag":"Exit","requestId":3,"exit":{"_tag":"Success","value":{}}})
        );
        socket
            .send(Message::Text(
                r#"{"_tag":"Request","id":4,"tag":"test.panic","payload":{},"headers":[]}"#.into(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["requestId"], 4);
        assert_eq!(reply["exit"]["cause"][0]["_tag"], "Die");
        socket
            .send(Message::Text(r#"{"_tag":"Ping"}"#.into()))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            serde_json::json!({"_tag":"Pong"})
        );
        socket.close(None).await.unwrap();
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn replacing_a_full_stream_starts_with_a_fresh_window() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, Arc::new(AuthenticatedApp), async {
            let _ = stopped.await;
        }));
        let mut req = format!("ws://{addr}/ws?orchestrationProtocol=2")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        let request = r#"{"_tag":"Request","id":"s","tag":"subscribeServerConfig","payload":{},"headers":[]}"#;
        socket.send(Message::Text(request.into())).await.unwrap();
        for _ in 0..8 {
            socket.next().await.unwrap().unwrap();
        }
        socket.send(Message::Text(request.into())).await.unwrap();
        for i in 0..8 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&frame).unwrap()["values"],
                serde_json::json!([i])
            );
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), socket.next())
                .await
                .is_err()
        );
        socket.close(None).await.unwrap();
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn real_websocket_stream_window_and_interrupt() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, Arc::new(AuthenticatedApp), async {
            let _ = stopped.await;
        }));
        let mut req = format!("ws://{addr}/ws?orchestrationProtocol=2")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        socket.send(Message::Text(r#"{"_tag":"Request","id":"s","tag":"subscribeServerConfig","payload":{},"headers":[]}"#.into())).await.unwrap();
        for i in 0..8 {
            let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&frame).unwrap(),
                serde_json::json!({"_tag":"Chunk","requestId":"s","values":[i]})
            );
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), socket.next())
                .await
                .is_err()
        );
        socket
            .send(Message::Text(
                r#"{"_tag":"Request","id":2,"tag":"server.probe","payload":{},"headers":[]}"#
                    .into(),
            ))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&frame).unwrap()["requestId"],
            2
        );
        socket
            .send(Message::Text(r#"{"_tag":"Ack","requestId":"s"}"#.into()))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&frame).unwrap()["values"],
            serde_json::json!([8])
        );
        socket
            .send(Message::Text(
                r#"{"_tag":"Interrupt","requestId":"s"}"#.into(),
            ))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&frame).unwrap()["exit"]["cause"][0]["_tag"],
            "Interrupt"
        );
        socket.close(None).await.unwrap();
        let _ = stop.send(());
        server.await.unwrap().unwrap();
    }
}
