//! Session-scoped OpenCode requests; the event subscription is opened before work.
use super::opencode_http::{OpenCodeEvents, OpenCodeHttp, OpenCodeVersion};
use serde_json::Value;

pub(crate) fn skill_mentions(text: &str) -> Vec<String> {
    use std::sync::OnceLock;
    static CURRENCY: OnceLock<regex::Regex> = OnceLock::new();
    let currency =
        CURRENCY.get_or_init(|| regex::Regex::new(r"^\p{Sc}$").expect("valid currency class"));
    let mut names = Vec::new();
    for word in text.split_whitespace() {
        let Some(first) = word.chars().next() else {
            continue;
        };
        if !currency.is_match(&first.to_string()) {
            continue;
        }
        let name = &word[first.len_utf8()..];
        if !name
            .bytes()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
            || !name
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, b':' | b'_' | b'-'))
            || !name.bytes().any(|value| value.is_ascii_alphabetic())
        {
            continue;
        }
        if !names.iter().any(|value| value == name) {
            names.push(name.to_owned());
        }
    }
    names
}

#[derive(Clone)]
pub(crate) struct OpenCodeSession {
    http: OpenCodeHttp,
    version: OpenCodeVersion,
    native_id: String,
}
impl OpenCodeSession {
    pub(crate) fn existing(
        http: OpenCodeHttp,
        version: OpenCodeVersion,
        native_id: String,
    ) -> Self {
        Self {
            http,
            version,
            native_id,
        }
    }
    pub(crate) async fn is_active(&self) -> Result<bool, String> {
        if self.version == OpenCodeVersion::V2 {
            let status = self
                .http
                .request(reqwest::Method::GET, &["api", "session", "active"], None)
                .await?;
            Ok(status["data"]
                .as_object()
                .ok_or("Invalid OpenCode active session response")?
                .contains_key(&self.native_id))
        } else {
            let status = self
                .http
                .request(reqwest::Method::GET, &["session", "status"], None)
                .await?;
            Ok(status
                .as_object()
                .ok_or("Invalid OpenCode status response")?
                .get(&self.native_id)
                .is_some_and(|value| value["type"] != "idle"))
        }
    }
    pub(crate) async fn stop_owned_shells(&self, cwd: Option<&str>) -> Result<(), String> {
        if self.version != OpenCodeVersion::V2 {
            return Ok(());
        }
        let cwd = cwd.unwrap_or("");
        let inventory = self
            .http
            .request_with_queries(
                reqwest::Method::GET,
                &["api", "experimental", "job"],
                None,
                &[
                    ("sessionID", &self.native_id),
                    ("kind", "shell"),
                    ("descendants", "true"),
                ],
            )
            .await;
        let (inventory, legacy) = match inventory {
            Ok(value) => (value, false),
            Err(error) if error == "OpenCode HTTP status 404" => (
                self.http
                    .request_with_queries(
                        reqwest::Method::GET,
                        &["api", "shell"],
                        None,
                        &[("location[directory]", cwd)],
                    )
                    .await?,
                true,
            ),
            Err(error) => return Err(error),
        };
        let shells = inventory["data"]
            .as_array()
            .ok_or("Invalid OpenCode shell inventory")?;
        if shells.len() > 1024 {
            return Err("OpenCode shell inventory limit exceeded".into());
        }
        for shell in shells {
            if !legacy && shell["kind"] != "shell" {
                return Err("Invalid OpenCode shell inventory kind".into());
            }
            let status = shell["status"]
                .as_str()
                .ok_or("Missing OpenCode shell status")?;
            if legacy {
                if !matches!(status, "running" | "exited" | "timeout" | "killed") {
                    return Err("Invalid OpenCode shell status".into());
                }
            } else if !matches!(status, "running" | "completed" | "error" | "cancelled") {
                return Err("Invalid OpenCode shell status".into());
            }
            if status != "running" {
                continue;
            }
            let id = if legacy {
                shell["id"].as_str()
            } else {
                shell["shellID"].as_str()
            }
            .filter(|id| !id.is_empty())
            .ok_or("Invalid OpenCode shell identity")?;
            let mut owner = if legacy {
                shell["metadata"]["sessionID"].as_str()
            } else {
                shell["sessionID"].as_str()
            }
            .ok_or("Missing OpenCode shell owner")?
            .to_owned();
            let mut owned = false;
            for _ in 0..5 {
                if owner == self.native_id {
                    owned = true;
                    break;
                }
                let session = self
                    .http
                    .request(reqwest::Method::GET, &["api", "session", &owner], None)
                    .await?;
                let Some(parent) = session["data"]["parentID"].as_str() else {
                    break;
                };
                owner = parent.to_owned();
            }
            if !owned {
                continue;
            }
            match self
                .http
                .request_with_queries(
                    reqwest::Method::DELETE,
                    &["api", "shell", id],
                    None,
                    &[("location[directory]", cwd)],
                )
                .await
            {
                Ok(_) => {}
                Err(error) if error == "OpenCode HTTP status 404" => {}
                Err(error) => return Err(error),
            }
            match self
                .http
                .request_with_queries(
                    reqwest::Method::GET,
                    &["api", "shell", id],
                    None,
                    &[("location[directory]", cwd)],
                )
                .await
            {
                Err(error) if error == "OpenCode HTTP status 404" => {}
                Ok(value)
                    if matches!(
                        value["data"]["status"].as_str(),
                        Some("exited" | "timeout" | "killed")
                    ) => {}
                _ => return Err("OpenCode shell termination is unconfirmed".into()),
            }
        }
        Ok(())
    }
    pub(crate) async fn connect(
        http: OpenCodeHttp,
        version: OpenCodeVersion,
        native_id: Option<&str>,
        create: Value,
    ) -> Result<(Self, OpenCodeEvents), String> {
        let mut events = http.events(version == OpenCodeVersion::V2).await?;
        // Wait until subscription is active before creating or resuming sessions:
        // otherwise volatile execution updates can be missed.
        if version == OpenCodeVersion::V2 {
            loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(30), events.next())
                    .await
                    .map_err(|_| "OpenCode event subscription timed out")??;
                if event["type"] == "server.connected" {
                    break;
                }
            }
        }
        let native_id = if let Some(id) = native_id.filter(|s| !s.is_empty()) {
            id.to_owned()
        } else {
            let response = http.create_session(version, create).await?;
            response["data"]["id"]
                .as_str()
                .or_else(|| response["id"].as_str())
                .filter(|s| !s.is_empty())
                .ok_or("OpenCode did not return a session id")?
                .to_owned()
        };
        Ok((
            Self {
                http,
                version,
                native_id,
            },
            events,
        ))
    }
    pub(crate) async fn reconnect(&self) -> Result<OpenCodeEvents, String> {
        let mut events = self
            .http
            .events(self.version == OpenCodeVersion::V2)
            .await?;
        if self.version == OpenCodeVersion::V2 {
            loop {
                let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.next())
                    .await
                    .map_err(|_| "OpenCode event subscription timed out")??;
                if event["type"] == "server.connected" {
                    break;
                }
            }
        }
        Ok(events)
    }
    pub(crate) async fn active_sessions(&self) -> Result<Value, String> {
        self.http
            .request(reqwest::Method::GET, &["api", "session", "active"], None)
            .await
    }
    pub(crate) async fn history(&self, cursor: Option<&str>) -> Result<Value, String> {
        let mut queries = vec![("limit", "50"), ("order", "desc")];
        if let Some(cursor) = cursor {
            queries.push(("cursor", cursor));
        }
        self.http
            .request_with_queries(
                reqwest::Method::GET,
                &["api", "session", &self.native_id, "message"],
                None,
                &queries,
            )
            .await
    }
    pub(crate) async fn pending_requests(&self) -> Result<(Value, Value), String> {
        let permissions = self
            .http
            .request(
                reqwest::Method::GET,
                &["api", "session", &self.native_id, "permission"],
                None,
            )
            .await?;
        let forms = self
            .http
            .request(
                reqwest::Method::GET,
                &["api", "session", &self.native_id, "form"],
                None,
            )
            .await?;
        Ok((permissions, forms))
    }
    pub(crate) fn for_native(&self, native: &str) -> Self {
        let mut session = self.clone();
        session.native_id = native.to_owned();
        session
    }
    pub(crate) fn native_id(&self) -> &str {
        &self.native_id
    }
    pub(crate) async fn v1_parent(&self, id: &str) -> Result<Option<String>, String> {
        let value = self
            .http
            .request(reqwest::Method::GET, &["session", id], None)
            .await?;
        Ok(value["parentID"]
            .as_str()
            .or_else(|| value["data"]["parentID"].as_str())
            .map(str::to_owned))
    }
    pub(crate) async fn read_image(&self, directory: &str, file: &str) -> Result<Vec<u8>, String> {
        self.http.read_image(directory, file).await
    }
    pub(crate) async fn image_jobs(&self) -> Result<Value, String> {
        self.http
            .request_with_queries(
                reqwest::Method::GET,
                &["api", "experimental", "job"],
                None,
                &[("sessionID", &self.native_id), ("kind", "image")],
            )
            .await
    }
    pub(crate) async fn shell_output(
        &self,
        id: &str,
        cwd: &str,
        cursor: u64,
    ) -> Result<Value, String> {
        let cursor = cursor.to_string();
        self.http
            .request_with_queries(
                reqwest::Method::GET,
                &["api", "shell", id, "output"],
                None,
                &[
                    ("location[directory]", cwd),
                    ("cursor", &cursor),
                    ("limit", "65536"),
                ],
            )
            .await
    }
    pub(crate) async fn shell_info(&self, id: &str, cwd: &str) -> Result<Value, String> {
        self.http
            .request_with_queries(
                reqwest::Method::GET,
                &["api", "shell", id],
                None,
                &[("location[directory]", cwd)],
            )
            .await
    }
    pub(crate) async fn switch_agent(&self, agent: &str) -> Result<Value, String> {
        self.http
            .request(
                reqwest::Method::POST,
                &["api", "session", &self.native_id, "agent"],
                Some(serde_json::json!({"agent": agent})),
            )
            .await
    }
    pub(crate) async fn switch_model(&self, model: Value) -> Result<Value, String> {
        self.http
            .request(
                reqwest::Method::POST,
                &["api", "session", &self.native_id, "model"],
                Some(serde_json::json!({"model":model})),
            )
            .await
    }
    pub(crate) async fn model_catalog(&self, cwd: &str) -> Result<Value, String> {
        match self.version {
            OpenCodeVersion::V2 => {
                self.http
                    .request_with_query(
                        reqwest::Method::GET,
                        &["api", "model"],
                        None,
                        Some(("location[directory]", cwd)),
                    )
                    .await
            }
            OpenCodeVersion::V1 => {
                self.http
                    .request(reqwest::Method::GET, &["provider"], None)
                    .await
            }
        }
    }
    pub(crate) async fn update_permissions(&self, permissions: Value) -> Result<Value, String> {
        match self.version {
            OpenCodeVersion::V1 => {
                self.http
                    .request(
                        reqwest::Method::PATCH,
                        &["session", &self.native_id],
                        Some(serde_json::json!({"permission":permissions})),
                    )
                    .await
            }
            OpenCodeVersion::V2 => {
                self.http
                    .request(
                        reqwest::Method::PATCH,
                        &["api", "session", &self.native_id],
                        Some(serde_json::json!({"permissions":permissions})),
                    )
                    .await
            }
        }
    }
    pub(crate) fn version(&self) -> OpenCodeVersion {
        self.version
    }
    pub(crate) async fn add_mcp(
        &self,
        name: &str,
        directory: &str,
        endpoint: &str,
        authorization: &str,
    ) -> Result<Value, String> {
        let config = serde_json::json!({"type":"remote","url":endpoint,"headers":{"Authorization":authorization},"oauth":false});
        match self.version {
            OpenCodeVersion::V1 => {
                self.http
                    .request(
                        reqwest::Method::POST,
                        &["mcp"],
                        Some(serde_json::json!({"name":"t3-code","config":config})),
                    )
                    .await
            }
            OpenCodeVersion::V2 => {
                self.http
                    .request_with_query(
                        reqwest::Method::PUT,
                        &["api", "experimental", "mcp", name],
                        Some(serde_json::json!({"config":config})),
                        Some(("location[directory]", directory)),
                    )
                    .await
            }
        }
    }
    pub(crate) async fn remove_mcp(&self, name: &str, directory: &str) -> Result<Value, String> {
        match self.version {
            OpenCodeVersion::V1 => Ok(Value::Null),
            OpenCodeVersion::V2 => {
                self.http
                    .request_with_query(
                        reqwest::Method::DELETE,
                        &["api", "experimental", "mcp", name],
                        None,
                        Some(("location[directory]", directory)),
                    )
                    .await
            }
        }
    }
    pub(crate) async fn set_instructions(&self, instructions: &str) -> Result<Value, String> {
        self.http
            .request(
                reqwest::Method::PUT,
                &[
                    "api",
                    "experimental",
                    "session",
                    &self.native_id,
                    "instructions",
                    "entries",
                    "t3-code",
                ],
                Some(serde_json::json!({"value":instructions})),
            )
            .await
    }
    pub(crate) async fn reply_question(
        &self,
        native: &str,
        answer: Option<Value>,
    ) -> Result<Value, String> {
        match (self.version, answer) {
            (OpenCodeVersion::V1, Some(answer)) => {
                self.http
                    .request(
                        reqwest::Method::POST,
                        &["question", native, "reply"],
                        Some(serde_json::json!({"answers":answer})),
                    )
                    .await
            }
            (OpenCodeVersion::V1, None) => {
                self.http
                    .request(reqwest::Method::POST, &["question", native, "reject"], None)
                    .await
            }
            (OpenCodeVersion::V2, Some(answer)) => {
                self.http
                    .request(
                        reqwest::Method::POST,
                        &["api", "session", &self.native_id, "form", native, "reply"],
                        Some(serde_json::json!({"answer":answer})),
                    )
                    .await
            }
            (OpenCodeVersion::V2, None) => {
                self.http
                    .request(
                        reqwest::Method::DELETE,
                        &["api", "session", &self.native_id, "form", native],
                        None,
                    )
                    .await
            }
        }
    }
    pub(crate) async fn known_skills(&self, cwd: &str, names: &[String]) -> Vec<String> {
        if self.version != OpenCodeVersion::V2 || names.is_empty() {
            return Vec::new();
        }
        let list = || {
            self.http.request_with_query(
                reqwest::Method::GET,
                &["api", "skill"],
                None,
                Some(("location[directory]", cwd)),
            )
        };
        let mut known = std::collections::HashSet::new();
        if let Ok(Ok(value)) = tokio::time::timeout(std::time::Duration::from_secs(5), list()).await
        {
            for item in value["data"].as_array().into_iter().flatten() {
                if let Some(id) = item["id"].as_str() {
                    known.insert(id.to_owned());
                }
            }
        }
        if names.iter().any(|name| !known.contains(name)) {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(5), self.model_catalog(cwd))
                    .await;
            if let Ok(Ok(value)) =
                tokio::time::timeout(std::time::Duration::from_secs(5), list()).await
            {
                for item in value["data"].as_array().into_iter().flatten() {
                    if let Some(id) = item["id"].as_str() {
                        known.insert(id.to_owned());
                    }
                }
            }
        }
        names
            .iter()
            .filter(|name| known.contains(*name))
            .cloned()
            .collect()
    }
    pub(crate) async fn known_command(&self, cwd: &str, name: &str) -> bool {
        let result = match self.version {
            OpenCodeVersion::V2 => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.http.request_with_query(
                        reqwest::Method::GET,
                        &["api", "command"],
                        None,
                        Some(("location[directory]", cwd)),
                    ),
                )
                .await
            }
            OpenCodeVersion::V1 => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.http.request(reqwest::Method::GET, &["command"], None),
                )
                .await
            }
        };
        match result {
            Ok(Ok(value)) => value["data"]
                .as_array()
                .or_else(|| value.as_array())
                .is_some_and(|items| items.iter().any(|item| item["name"] == name)),
            _ => false,
        }
    }
    pub(crate) async fn prompt(&self, body: Value) -> Result<Value, String> {
        match body["_t3_submit"].as_str() {
            Some("command") => match self.version {
                OpenCodeVersion::V2 => {
                    self.http
                        .request(
                            reqwest::Method::POST,
                            &["api", "session", &self.native_id, "command"],
                            Some(serde_json::json!({"name":body["name"],"text":body["text"]})),
                        )
                        .await
                }
                OpenCodeVersion::V1 => {
                    self.http
                        .request_long_lived(
                            reqwest::Method::POST,
                            &["session", &self.native_id, "command"],
                            Some(body["_t3_native"].clone()),
                        )
                        .await
                }
            },
            Some("compact") => {
                self.http
                    .request(
                        reqwest::Method::POST,
                        &["api", "session", &self.native_id, "compact"],
                        Some(serde_json::json!({"id":body["id"]})),
                    )
                    .await
            }
            _ => self.http.prompt(self.version, &self.native_id, body).await,
        }
    }
    pub(crate) async fn interrupt(&self) -> Result<Value, String> {
        self.http.interrupt(self.version, &self.native_id).await
    }
    pub(crate) async fn reply_permission(
        &self,
        request: &str,
        decision: &str,
    ) -> Result<Value, String> {
        self.http
            .reply_permission(self.version, &self.native_id, request, decision)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::skill_mentions;
    #[tokio::test]
    async fn v1_known_command_uses_native_endpoint_and_arguments() {
        use super::{OpenCodeHttp, OpenCodeSession, OpenCodeVersion};
        use axum::{body::Body, extract::Request, response::Response, routing::any, Router};
        use serde_json::json;
        let app = Router::new().fallback(any(|request: Request| async move {
            let path = request.uri().path().to_owned();
            if path == "/command" {
                return Response::new(Body::from(r#"[{"name":"hello"}]"#));
            }
            assert_eq!(path, "/session/native/command");
            let body = axum::body::to_bytes(request.into_body(), 4096)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["command"], "hello");
            assert_eq!(value["arguments"], "world");
            Response::new(Body::from("{}"))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let session = OpenCodeSession {
            http: OpenCodeHttp::new(&format!("http://{addr}"), None).unwrap(),
            version: OpenCodeVersion::V1,
            native_id: "native".into(),
        };
        assert!(session.known_command("/work", "hello").await);
        assert!(!session.known_command("/work", "unknown").await);
        session.prompt(json!({"_t3_submit":"command","_t3_native":{"command":"hello","arguments":"world"}})).await.unwrap();
        server.abort();
    }
    #[test]
    fn extracts_distinct_well_formed_skill_mentions() {
        assert_eq!(
            skill_mentions("Use $review and $review; $123 €audit $x_2 $_bad $also-ok"),
            vec!["review", "audit", "x_2", "also-ok"]
        );
    }
}
