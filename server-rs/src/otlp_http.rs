//! Browser OTLP trace ingestion endpoint.
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

const PATH: &str = "/api/observability/v1/traces";

#[derive(Clone, Default)]
pub struct ExportConfig {
    pub url: Option<String>,
    pub headers: Vec<(String, String)>,
    pub protobuf: bool,
    pub(crate) trace_writer: Option<Arc<crate::trace_writer::TraceWriter>>,
}

impl ExportConfig {
    pub fn from_environment(settings: &Value, bootstrap_url: Option<&str>) -> Self {
        let get = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
        let disabled = get("T3CODE_OTEL_SDK_DISABLED")
            .map(|v| matches!(v.to_lowercase().as_str(), "true" | "yes" | "on" | "1" | "y"))
            .unwrap_or_else(|| {
                get("OTEL_SDK_DISABLED").is_some_and(|v| v.eq_ignore_ascii_case("true"))
            });
        if disabled {
            return Self::default();
        }
        let t3 = get("T3CODE_OTLP_TRACES_URL");
        let own = get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
        let generic = get("OTEL_EXPORTER_OTLP_ENDPOINT");
        let off = get("OTEL_TRACES_EXPORTER").is_some_and(|v| {
            !v.split(',').any(|s| s.trim().eq_ignore_ascii_case("otlp"))
                && v.split(',').any(|s| s.trim().eq_ignore_ascii_case("none"))
        });
        let is_t3 = t3.is_some();
        let is_otel = !is_t3 && !off && (own.is_some() || generic.is_some());
        let url = if is_t3 {
            t3
        } else if off {
            None
        } else if let Some(own) = own {
            Some(own)
        } else if let Some(base) = generic {
            url::Url::parse(&base).ok().map(|mut u| {
                u.set_path(&format!("{}/v1/traces", u.path().trim_end_matches('/')));
                u.to_string()
            })
        } else {
            bootstrap_url
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    settings
                        .pointer("/observability/otlpTracesUrl")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_owned)
                })
        };
        let protocol = if is_otel {
            get("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
                .or_else(|| get("OTEL_EXPORTER_OTLP_PROTOCOL"))
                .unwrap_or_else(|| "http/protobuf".into())
        } else {
            get("T3CODE_OTLP_PROTOCOL").unwrap_or_else(|| "http/json".into())
        };
        if is_otel && !["http/json", "http/protobuf"].contains(&protocol.to_lowercase().as_str()) {
            return Self::default();
        }
        if is_otel
            && !url
                .as_deref()
                .and_then(|s| url::Url::parse(s).ok())
                .is_some_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
        {
            return Self::default();
        }
        let raw_headers = if is_otel {
            get("OTEL_EXPORTER_OTLP_TRACES_HEADERS").or_else(|| get("OTEL_EXPORTER_OTLP_HEADERS"))
        } else {
            get("T3CODE_OTLP_HEADERS")
        };
        let parsed_headers: Option<Vec<_>> = raw_headers
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|pair| {
                let (k, v) = pair.split_once('=')?;
                if k.trim().is_empty() {
                    return None;
                }
                let bytes = v.trim().as_bytes();
                for (i, byte) in bytes.iter().enumerate() {
                    if *byte == b'%'
                        && (i + 2 >= bytes.len()
                            || !bytes[i + 1].is_ascii_hexdigit()
                            || !bytes[i + 2].is_ascii_hexdigit())
                    {
                        return None;
                    }
                }
                Some((
                    k.trim().to_owned(),
                    percent_encoding::percent_decode_str(v.trim())
                        .decode_utf8()
                        .ok()?
                        .into_owned(),
                ))
            })
            .collect();
        let Some(headers) = parsed_headers else {
            return Self::default();
        };
        Self {
            url,
            headers,
            protobuf: protocol.eq_ignore_ascii_case("http/protobuf"),
            trace_writer: None,
        }
    }
}

#[derive(Clone)]
struct IngestState {
    auth: Arc<crate::auth_http::AuthHttpState>,
    export: ExportConfig,
}

pub fn router(auth: Arc<crate::auth_http::AuthHttpState>, export: ExportConfig) -> Router {
    Router::new()
        .route(PATH, post(ingest))
        .with_state(IngestState { auth, export })
}

async fn ingest(State(state): State<IngestState>, request: Request) -> Response {
    let headers = request.headers();
    let principal =
        match crate::auth_http::authenticate_at(&state.auth, headers, None, None, "POST", PATH) {
            Ok(principal) => principal,
            Err(error) => return auth_error(error, headers),
        };
    let grants = principal.scopes.into_iter().collect();
    if let Some(missing) = crate::authorization::first_missing(&grants, &["orchestration:operate"])
    {
        return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":missing.required_scope,"requiredPermission":missing.required_permission,"traceId":uuid::Uuid::new_v4().to_string()}))).into_response();
    }
    let body = match axum::body::to_bytes(request.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if let (Some(writer), Ok(records)) = (&state.export.trace_writer, crate::otlp_trace::decode(&value)) {
        for record in records { let _ = writer.browser_record(&record); }
    }
    let Some(url) = &state.export.url else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let (content_type, payload) = if state.export.protobuf {
        if !protobuf_shape_supported(&value) {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        use prost::Message;
        let Ok(trace) = serde_json::from_value::<
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest,
        >(value) else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        ("application/x-protobuf", trace.encode_to_vec())
    } else {
        ("application/json", value.to_string().into_bytes())
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let Ok(client) = client else {
        return (StatusCode::BAD_GATEWAY, "Trace export failed.").into_response();
    };
    let mut request = client
        .post(url)
        .header("content-type", content_type)
        .body(payload);
    for (key, value) in &state.export.headers {
        request = request.header(key.as_str(), value.as_str());
    }
    match request.send().await {
        Ok(response) if response.status().is_success() => StatusCode::NO_CONTENT.into_response(),
        _ => (StatusCode::BAD_GATEWAY, "Trace export failed.").into_response(),
    }
}

// Effect's protobuf encoder expects the internal, fully populated OTLP shape.
// Missing repeated fields throw during serialization before the HTTP request.
fn protobuf_shape_supported(value: &Value) -> bool {
    let Some(resources) = value.get("resourceSpans").and_then(Value::as_array) else { return false };
    resources.iter().all(|resource| {
        resource.pointer("/resource/attributes").is_some_and(Value::is_array)
            && resource.get("scopeSpans").and_then(Value::as_array).is_some_and(|scopes| scopes.iter().all(|scope| {
                scope.get("scope").is_some_and(Value::is_object)
                    && scope.get("spans").and_then(Value::as_array).is_some_and(|spans| spans.iter().all(|span| {
                        ["attributes", "events", "links"].iter().all(|key| span.get(key).is_some_and(Value::is_array))
                            && span.get("status").is_some_and(Value::is_object)
                            && ["traceId", "spanId"].iter().all(|key| span.get(key).is_some_and(Value::is_string))
                            && ["startTimeUnixNano", "endTimeUnixNano"].iter().all(|key| span.get(key).is_some_and(|v| v.is_string() || v.is_i64() || v.is_u64()))
                            && span.get("events").and_then(Value::as_array).is_some_and(|events| events.iter().all(|event| event.get("attributes").is_some_and(Value::is_array)))
                            && span.get("links").and_then(Value::as_array).is_some_and(|links| links.iter().all(|link| link.get("attributes").is_some_and(Value::is_array)))
                    }))
            }))
    })
}

fn auth_error(error: crate::auth::AuthError, headers: &HeaderMap) -> Response {
    if !headers.contains_key(axum::http::header::AUTHORIZATION)
        && !headers.contains_key(axum::http::header::COOKIE)
    {
        (StatusCode::UNAUTHORIZED, Json(json!({"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential","traceId":uuid::Uuid::new_v4().to_string()}))).into_response()
    } else {
        crate::auth_http::auth_failure(error, headers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[test]
    fn protobuf_accepts_browser_otlp_json() {
        use prost::Message;
        type Traces = opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
        let value = json!({"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"browser","startTimeUnixNano":"1760000000123456789","endTimeUnixNano":"1760000001123456789"}]}]}]});
        let traces: Traces = serde_json::from_value(value).unwrap();
        let decoded = Traces::decode(traces.encode_to_vec().as_slice()).unwrap();
        let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.name, "browser");
        assert_eq!(span.trace_id, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
        assert_eq!(span.span_id, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
        assert_eq!(span.start_time_unix_nano, 1_760_000_000_123_456_789);
        assert_eq!(span.end_time_unix_nano, 1_760_000_001_123_456_789);
    }

    #[test]
    fn protobuf_encoder_requires_effect_repeated_fields() {
        assert!(protobuf_shape_supported(&json!({"resourceSpans":[]})));
        assert!(!protobuf_shape_supported(&json!({"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"ui"},"spans":[{"traceId":"00","spanId":"00","startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":[],"events":[],"status":{"code":0}}]}]}]})));
    }

    #[tokio::test]
    async fn authenticates_and_checks_scope_before_parsing() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, method TEXT, expires_at TEXT, revoked_at TEXT)").unwrap();
        let auth = Arc::new(crate::auth_http::AuthHttpState {
            replay_dir: std::env::temp_dir(),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            db: std::sync::Mutex::new(db),
            lifecycle: Default::default(),
            signing_key: [9; 32],
            descriptor: json!({"sessionCookieName":"test"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let token = |id: &str, scope: &str| {
            auth.db.lock().unwrap().execute("INSERT INTO auth_sessions VALUES (?1,'user',?2,'bearer-access-token','2999',NULL)", rusqlite::params![id, json!([scope]).to_string()]).unwrap();
            crate::auth::sign_session(
                &auth.signing_key,
                &crate::auth::SessionClaims {
                    v: 1,
                    kind: "session".into(),
                    sid: id.into(),
                    sub: "user".into(),
                    scopes: vec![scope.into()],
                    method: "bearer-access-token".into(),
                    jkt: None,
                    rtc: None,
                    plk: None,
                    iat: 0,
                    exp: 4_102_444_800_000,
                },
            )
            .unwrap()
        };
        let limited = token("limited", "orchestration:read");
        let operator = token("operator", "orchestration:operate");
        let app = router(auth.clone(), ExportConfig::default());
        for (credential, body, expected) in [
            (None, "invalid", StatusCode::UNAUTHORIZED),
            (Some(&limited), "invalid", StatusCode::FORBIDDEN),
            (Some(&operator), "invalid", StatusCode::BAD_REQUEST),
            (
                Some(&operator),
                "{\"resourceSpans\":[]}",
                StatusCode::NO_CONTENT,
            ),
        ] {
            let mut request = Request::post(PATH);
            if let Some(token) = credential {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::from(body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let protobuf_app = router(auth.clone(), ExportConfig {
            url: Some("http://127.0.0.1:1/v1/traces".into()),
            protobuf: true,
            ..Default::default()
        });
        let incomplete = json!({"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"ui"},"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"browser","startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":[],"events":[],"status":{"code":0}}]}]}]});
        let response = protobuf_app.oneshot(Request::post(PATH).header("authorization", format!("Bearer {operator}")).body(Body::from(incomplete.to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let trace_path = std::env::temp_dir().join(format!("browser-traces-{}", uuid::Uuid::new_v4()));
        let writer = Arc::new(crate::trace_writer::TraceWriter::new(trace_path.clone()).unwrap());
        let collector = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let size = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]).to_lowercase();
            assert!(request.starts_with("post /traces http/1.1"));
            assert!(request.contains("x-api-key: secret"));
            socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let app = router(
            auth,
            ExportConfig {
                url: Some(format!("http://{addr}/traces")),
                headers: vec![("x-api-key".into(), "secret".into())],
                protobuf: false,
                trace_writer: Some(writer.clone()),
            },
        );
        let denied = app.clone().oneshot(Request::post(PATH).body(Body::from("{\"resourceSpans\":[]}")).unwrap()).await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(
                Request::post(PATH)
                    .header("authorization", format!("Bearer {operator}"))
                    .body(Body::from(json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"web"}}]},"scopeSpans":[{"scope":{"name":"ui"},"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"render","kind":3,"startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000002500000","attributes":[{"key":"url.full","value":{"stringValue":"https://example.test/?dpop=secret"}}],"events":[{"name":"paint","timeUnixNano":"1700000000001000000"}],"status":{"code":2}}]}]}]}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        collector.await.unwrap();
        writer.flush(std::time::Duration::from_secs(2)).await.unwrap();
        let line = std::fs::read_to_string(&trace_path).unwrap();
        assert!(!line.contains("dpop=secret"));
        let record: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(record["type"], "otlp-span");
        assert_eq!(record["traceId"], "0123456789abcdef0123456789abcdef");
        assert_eq!(record["kind"], "client");
        assert_eq!(record["durationMs"], 2.5);
        assert_eq!(record["resourceAttributes"]["service.name"], "web");
        assert_eq!(record["scope"]["name"], "ui");
        assert_eq!(record["events"][0]["name"], "paint");
        assert_eq!(record["status"]["code"], "2");
        assert_eq!(record["attributes"]["url.full"], "https://example.test/?dpop=<redacted>");
        let _ = std::fs::remove_file(trace_path);
    }
}
