//! OpenCode HTTP/SSE transport, shared by local and configured servers.
use serde_json::Value;
use std::{collections::VecDeque, time::Duration};
use url::Url;

const FRAME_LIMIT: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub(crate) struct OpenCodeHttp {
    client: reqwest::Client,
    base: Url,
    password: Option<String>,
    directory: Option<String>,
}
impl OpenCodeHttp {
    pub(crate) fn new(base: &str, password: Option<String>) -> Result<Self, String> {
        let base = Url::parse(base).map_err(|_| "Invalid OpenCode server URL")?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err("Invalid OpenCode server URL".into());
        }
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10));
        if base.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        }) {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base,
            password,
            directory: None,
        })
    }
    pub(crate) fn scope_directory(&mut self, directory: &str) {
        self.directory = Some(directory.to_owned());
    }
    fn url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url = self.base.clone();
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "Invalid OpenCode server URL")?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
        drop(path);
        Ok(url)
    }
    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.password {
            Some(password) => request.basic_auth("opencode", Some(password)),
            None => request,
        }
    }
    pub(crate) async fn read_image(&self, directory: &str, file: &str) -> Result<Vec<u8>, String> {
        let url = self.url(&["api", "fs", "read", file])?;
        let mut response = self
            .authorize(
                self.client
                    .get(url)
                    .query(&[("location[directory]", directory)]),
            )
            .send()
            .await
            .map_err(|_| "OpenCode image request failed")?;
        if !response.status().is_success() {
            return Err("OpenCode image request failed".into());
        }
        const LIMIT: usize = 10 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|size| size > LIMIT as u64)
        {
            return Err("OpenCode image is too large".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "OpenCode image request failed")?
        {
            if bytes.len().saturating_add(chunk.len()) > LIMIT {
                return Err("OpenCode image is too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub(crate) async fn request(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.request_with_query(method, segments, body, None).await
    }
    pub(crate) async fn request_with_query(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
        query: Option<(&str, &str)>,
    ) -> Result<Value, String> {
        self.request_with_queries(
            method,
            segments,
            body,
            &query.into_iter().collect::<Vec<_>>(),
        )
        .await
    }
    pub(crate) async fn request_with_queries(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
        queries: &[(&str, &str)],
    ) -> Result<Value, String> {
        self.request_inner(method, segments, body, queries, true)
            .await
    }
    pub(crate) async fn request_long_lived(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.request_inner(method, segments, body, &[], false).await
    }
    async fn request_inner(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
        queries: &[(&str, &str)],
        bounded: bool,
    ) -> Result<Value, String> {
        let mut url = self.url(segments)?;
        for (name, value) in queries {
            url.query_pairs_mut().append_pair(name, value);
        }
        let is_get = method == reqwest::Method::GET || method == reqwest::Method::HEAD;
        if is_get {
            if let Some(directory) = &self.directory {
                url.query_pairs_mut().append_pair("directory", directory);
            }
        }
        let mut request = self.authorize(self.client.request(method, url));
        if bounded {
            request = request.timeout(Duration::from_secs(30));
        }
        if !is_get {
            if let Some(directory) = &self.directory {
                request = request.header(
                    "x-opencode-directory",
                    percent_encoding::utf8_percent_encode(
                        directory,
                        percent_encoding::NON_ALPHANUMERIC,
                    )
                    .to_string(),
                );
            }
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "OpenCode request failed")?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            if status == 404
                && segments.len() == 4
                && segments[0] == "api"
                && segments[1] == "session"
                && segments[3] == "message"
            {
                let mut body = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "OpenCode response failed")?
                {
                    if body.len().saturating_add(chunk.len()) > 16 * 1024 {
                        break;
                    }
                    body.extend_from_slice(&chunk);
                }
                if serde_json::from_slice::<Value>(&body)
                    .ok()
                    .is_some_and(|value| {
                        value["_tag"] == "SessionNotFoundError" && value["sessionID"] == segments[2]
                    })
                {
                    return Err("OpenCode native session not found".into());
                }
            }
            return Err(format!("OpenCode HTTP status {status}"));
        }
        if response
            .content_length()
            .is_some_and(|n| n > FRAME_LIMIT as u64)
        {
            return Err("OpenCode response too large".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "OpenCode response failed")?
        {
            if bytes.len().saturating_add(chunk.len()) > FRAME_LIMIT {
                return Err("OpenCode response too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Invalid OpenCode JSON response".into())
    }
    pub(crate) async fn events(&self, v2: bool) -> Result<OpenCodeEvents, String> {
        let path: &[&str] = if v2 { &["api", "event"] } else { &["event"] };
        let mut url = self.url(path)?;
        if let Some(directory) = &self.directory {
            url.query_pairs_mut().append_pair("directory", directory);
        }
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            self.authorize(self.client.get(url))
                .header("accept", "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| "OpenCode event connection timed out")?
        .map_err(|_| "OpenCode event connection failed")?;
        if !response.status().is_success() {
            return Err(format!(
                "OpenCode event HTTP status {}",
                response.status().as_u16()
            ));
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Err("OpenCode event response is not an event stream".into());
        }
        Ok(OpenCodeEvents {
            response,
            buffer: Vec::new(),
            data: Vec::new(),
            data_size: 0,
            pending: VecDeque::new(),
        })
    }
}
/// API paths below are taken from the pinned 1.x and 2.x generated clients.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenCodeVersion {
    V1,
    V2,
}
impl OpenCodeHttp {
    /// Probe both generation-specific health endpoints without accepting SPA HTML as JSON.
    pub(crate) async fn probe(&self) -> Result<OpenCodeVersion, String> {
        if let Ok(info) = self
            .request(reqwest::Method::GET, &["api", "info"], None)
            .await
        {
            if info["version"]
                .as_str()
                .is_some_and(|v| v.starts_with("2."))
            {
                return Ok(OpenCodeVersion::V2);
            }
        }
        let health = self
            .request(reqwest::Method::GET, &["global", "health"], None)
            .await?;
        if health["healthy"] == true
            && health["version"]
                .as_str()
                .is_some_and(|v| v.starts_with("1."))
        {
            return Ok(OpenCodeVersion::V1);
        }
        Err("Unsupported OpenCode server version".into())
    }
    pub(crate) async fn create_session(
        &self,
        version: OpenCodeVersion,
        body: Value,
    ) -> Result<Value, String> {
        match version {
            OpenCodeVersion::V1 => {
                self.request(reqwest::Method::POST, &["session"], Some(body))
                    .await
            }
            OpenCodeVersion::V2 => {
                self.request(reqwest::Method::POST, &["api", "session"], Some(body))
                    .await
            }
        }
    }
    pub(crate) async fn prompt(
        &self,
        version: OpenCodeVersion,
        session: &str,
        body: Value,
    ) -> Result<Value, String> {
        match version {
            OpenCodeVersion::V1 => {
                self.request(
                    reqwest::Method::POST,
                    &["session", session, "prompt_async"],
                    Some(body),
                )
                .await
            }
            OpenCodeVersion::V2 => {
                self.request(
                    reqwest::Method::POST,
                    &["api", "session", session, "prompt"],
                    Some(body),
                )
                .await
            }
        }
    }
    pub(crate) async fn interrupt(
        &self,
        version: OpenCodeVersion,
        session: &str,
    ) -> Result<Value, String> {
        match version {
            OpenCodeVersion::V1 => {
                self.request(reqwest::Method::POST, &["session", session, "abort"], None)
                    .await
            }
            OpenCodeVersion::V2 => {
                self.request(
                    reqwest::Method::POST,
                    &["api", "session", session, "interrupt"],
                    None,
                )
                .await
            }
        }
    }
    pub(crate) async fn reply_permission(
        &self,
        version: OpenCodeVersion,
        session: &str,
        request: &str,
        decision: &str,
    ) -> Result<Value, String> {
        match version {
            OpenCodeVersion::V1 => {
                self.request(
                    reqwest::Method::POST,
                    &["permission", request, "reply"],
                    Some(serde_json::json!({"reply":decision})),
                )
                .await
            }
            OpenCodeVersion::V2 => {
                self.request(
                    reqwest::Method::POST,
                    &["api", "session", session, "permission", request, "reply"],
                    Some(serde_json::json!({"decision":decision})),
                )
                .await
            }
        }
    }
}
pub(crate) struct OpenCodeEvents {
    response: reqwest::Response,
    buffer: Vec<u8>,
    data: Vec<String>,
    data_size: usize,
    pending: VecDeque<Value>,
}
impl OpenCodeEvents {
    pub(crate) async fn next(&mut self) -> Result<Value, String> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(event);
            }
            let chunk = self
                .response
                .chunk()
                .await
                .map_err(|_| "OpenCode event stream failed")?
                .ok_or("OpenCode event stream closed")?;
            if self.buffer.len().saturating_add(chunk.len()) > FRAME_LIMIT {
                return Err("OpenCode event frame too large".into());
            }
            self.buffer.extend_from_slice(&chunk);
            while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
                let mut line = self.buffer.drain(..=pos).collect::<Vec<_>>();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let line =
                    std::str::from_utf8(&line).map_err(|_| "Invalid OpenCode event encoding")?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        let data = self.data.join("\n");
                        self.data.clear();
                        self.data_size = 0;
                        self.pending.push_back(
                            serde_json::from_str(&data)
                                .map_err(|_| "Invalid OpenCode event JSON")?,
                        );
                    }
                } else if let Some(value) = line.strip_prefix("data:") {
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    self.data_size = self.data_size.saturating_add(value.len()).saturating_add(1);
                    if self.data_size > FRAME_LIMIT {
                        return Err("OpenCode event frame too large".into());
                    }
                    self.data.push(value.to_owned());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body, extract::Request, http::StatusCode, response::Response, routing::any, Router,
    };
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn legacy_api_uses_v1_endpoints_and_reply_shape() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let log = captured.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let log = log.clone();
            async move {
                let path = request.uri().path().to_owned();
                let bytes = axum::body::to_bytes(request.into_body(), 4096)
                    .await
                    .unwrap();
                log.lock().unwrap().push((path.clone(), bytes.to_vec()));
                if path == "/api/info" {
                    return Response::new(Body::from("<html>SPA</html>"));
                }
                if path == "/global/health" {
                    return Response::new(Body::from("{\"healthy\":true,\"version\":\"1.18.32\"}"));
                }
                Response::new(Body::from("{}"))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OpenCodeHttp::new(&format!("http://{addr}"), None).unwrap();
        assert_eq!(client.probe().await.unwrap(), OpenCodeVersion::V1);
        client
            .create_session(OpenCodeVersion::V1, serde_json::json!({"title":"test"}))
            .await
            .unwrap();
        client
            .prompt(OpenCodeVersion::V1, "s", serde_json::json!({"parts":[]}))
            .await
            .unwrap();
        client.interrupt(OpenCodeVersion::V1, "s").await.unwrap();
        client
            .reply_permission(OpenCodeVersion::V1, "s", "p", "once")
            .await
            .unwrap();
        let entries = captured.lock().unwrap();
        assert!(entries
            .iter()
            .any(|(path, _)| path == "/session/s/prompt_async"));
        assert!(entries.iter().any(|(path, _)| path == "/session/s/abort"));
        let body = &entries
            .iter()
            .find(|(path, _)| path == "/permission/p/reply")
            .unwrap()
            .1;
        assert_eq!(
            serde_json::from_slice::<Value>(body).unwrap()["reply"],
            "once"
        );
        server.abort();
    }
    #[tokio::test]
    async fn missing_session_requires_matching_tag_and_session_id() {
        let app = Router::new().fallback(any(|request: Request| async move {
            let path = request.uri().path();
            let body = if path.contains("/match/") {
                r#"{"_tag":"SessionNotFoundError","sessionID":"match","message":"missing"}"#
            } else if path.contains("/wrong/") {
                r#"{"_tag":"SessionNotFoundError","sessionID":"other","message":"missing"}"#
            } else {
                r#"{"message":"not found"}"#
            };
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from(body))
                .unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OpenCodeHttp::new(&format!("http://{addr}"), None).unwrap();
        for (id, expected) in [
            ("match", "OpenCode native session not found"),
            ("wrong", "OpenCode HTTP status 404"),
            ("plain", "OpenCode HTTP status 404"),
        ] {
            let error = client
                .request_with_queries(
                    reqwest::Method::GET,
                    &["api", "session", id, "message"],
                    None,
                    &[],
                )
                .await
                .unwrap_err();
            assert_eq!(error, expected);
        }
        server.abort();
    }
    #[tokio::test]
    async fn fake_server_covers_auth_urls_json_and_sse_frames() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let log = captured.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let log = log.clone();
            async move {
                let path = request.uri().path().to_owned();
                log.lock().unwrap().push((request.method().to_string(), path.clone(), request.headers().get("authorization").and_then(|x| x.to_str().ok()).unwrap_or("").to_owned()));
                if path == "/api/info" {
                    Response::new(Body::from("{\"version\":\"2.0.18\"}"))
                } else if path == "/api/event" {
                    Response::builder().header("content-type", "text/event-stream").body(Body::from(": heartbeat\r\ndata: {\"type\":\"server.connected\",\r\ndata: \"data\":{}}\r\n\r\ndata: {\"type\":\"next\"}\n\n")).unwrap()
                } else if path == "/api/session" {
                    Response::new(Body::from("{\"data\":{\"id\":\"ses_1\"}}"))
                } else if path == "/api/session/ses_1/prompt" || path == "/api/session/ses_1/interrupt" {
                    Response::new(Body::from("{}"))
                } else if path == "/api/session/ses_1/permission/p%2F1/reply" {
                    Response::builder().status(StatusCode::NO_CONTENT).body(Body::empty()).unwrap()
                } else { Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap() }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OpenCodeHttp::new(&format!("http://{addr}"), Some("secret".into())).unwrap();
        assert_eq!(client.probe().await.unwrap(), OpenCodeVersion::V2);
        let mut events = client.events(true).await.unwrap();
        assert_eq!(events.next().await.unwrap()["type"], "server.connected");
        assert_eq!(events.next().await.unwrap()["type"], "next");
        let (session, _) = super::super::opencode_session::OpenCodeSession::connect(
            client.clone(),
            OpenCodeVersion::V2,
            None,
            serde_json::json!({"location":{"directory":"/tmp"}}),
        )
        .await
        .unwrap();
        assert_eq!(session.native_id(), "ses_1");
        session
            .prompt(serde_json::json!({"text":"hello"}))
            .await
            .unwrap();
        session.interrupt().await.unwrap();
        session.reply_permission("p/1", "once").await.unwrap();
        assert_eq!(
            client
                .create_session(
                    OpenCodeVersion::V2,
                    serde_json::json!({"location":{"directory":"/tmp"}})
                )
                .await
                .unwrap()["data"]["id"],
            "ses_1"
        );
        client
            .prompt(
                OpenCodeVersion::V2,
                "ses_1",
                serde_json::json!({"text":"hi"}),
            )
            .await
            .unwrap();
        client
            .interrupt(OpenCodeVersion::V2, "ses_1")
            .await
            .unwrap();
        assert!(client
            .reply_permission(OpenCodeVersion::V2, "ses_1", "p/1", "once")
            .await
            .unwrap()
            .is_null());
        let entries = captured.lock().unwrap();
        assert!(entries
            .iter()
            .all(|(_, _, auth)| auth == "Basic b3BlbmNvZGU6c2VjcmV0"));
        let subscription = entries
            .iter()
            .rposition(|(_, path, _)| path == "/api/event")
            .unwrap();
        let creation = entries
            .iter()
            .position(|(_, path, _)| path == "/api/session")
            .unwrap();
        assert!(subscription < creation);

        server.abort();
    }
}
