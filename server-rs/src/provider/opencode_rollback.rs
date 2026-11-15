//! Safe OpenCode 2 history-only rollback preparation and mutation.
use super::{
    opencode_http::{OpenCodeEvents, OpenCodeHttp, OpenCodeVersion},
    opencode_session::OpenCodeSession,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::Duration};

pub(crate) struct Prepared {
    http: OpenCodeHttp,
    session: OpenCodeSession,
    events: OpenCodeEvents,
    pub boundary: Option<String>,
    version: OpenCodeVersion,
    v1_index: Option<usize>,
}

pub(crate) async fn prepare(
    settings_path: &Path,
    instance: &str,
    thread: &str,
    cwd: &str,
    native: &str,
    later: &[String],
) -> Result<Prepared, String> {
    if crate::managed_policy::has_provider_restrictions()? {
        return Err("OpenCode provider restrictions cannot be safely enforced".into());
    }
    if super::opencode_executor::has_background(thread) {
        return Err("OpenCode background tasks must finish before rollback".into());
    }
    if later
        .iter()
        .any(|id| !id.starts_with("msg_") && !id.contains(":wake:"))
    {
        return Err("OpenCode turn lacks a safe rollback boundary".into());
    }
    let settings = super::opencode_executor::resolved_settings(Some(settings_path))?;
    let entry = &settings["providerInstances"][instance];
    if entry["enabled"] == false
        || (!entry.is_null() && entry["driver"].as_str() != Some("opencode"))
    {
        return Err("OpenCode provider instance is unavailable".into());
    }
    let config = &entry["config"];
    let password = super::opencode_executor::effective_password(entry)?;
    let configured = config["serverUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty());
    let (url, version) = if let Some(url) = configured {
        let http = OpenCodeHttp::new(url, password.clone())?;
        (url.to_owned(), http.probe().await?)
    } else {
        super::opencode_owner::connect(
            instance,
            thread,
            config,
            &settings["providerInstances"][instance]["environment"],
            cwd,
            password.as_deref(),
        )
        .await?
    };
    let mut http = OpenCodeHttp::new(&url, password)?;
    if version == OpenCodeVersion::V1 {
        http.scope_directory(cwd);
    }
    let (session, events) =
        OpenCodeSession::connect(http.clone(), version, Some(native), Value::Null).await?;
    if version == OpenCodeVersion::V1 {
        let status = http
            .request(reqwest::Method::GET, &["session", "status"], None)
            .await?;
        if status
            .get(native)
            .is_some_and(|value| value["type"] != "idle")
        {
            return Err("OpenCode session is still running".into());
        }
        let history = http
            .request(reqwest::Method::GET, &["session", native, "message"], None)
            .await?;
        let messages = history
            .as_array()
            .or_else(|| history["data"].as_array())
            .ok_or("Invalid OpenCode history")?;
        if messages.len() > 10_000 {
            return Err("OpenCode history limit exceeded".into());
        }
        let boundary = later
            .iter()
            .find(|id| {
                id.starts_with("msg_")
                    && messages.iter().any(|message| {
                        message["info"]["id"].as_str() == Some(id.as_str())
                            && message["info"]["role"] == "user"
                    })
            })
            .cloned();
        if boundary.is_none() && later.iter().any(|id| id.starts_with("msg_")) {
            return Err("OpenCode rollback boundary is missing from native history".into());
        }
        let v1_index = boundary.as_ref().and_then(|id| {
            messages
                .iter()
                .position(|message| message["info"]["id"] == id.as_str())
        });
        return Ok(Prepared {
            http,
            session,
            events,
            boundary,
            version,
            v1_index,
        });
    }
    let active = session.active_sessions().await?;
    if active["data"]
        .as_object()
        .ok_or("Invalid OpenCode active session response")?
        .contains_key(native)
    {
        return Err("OpenCode session is still running".into());
    }
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut prompts = HashSet::new();
    let mut total = 0usize;
    for _ in 0..200 {
        let page = session.history(cursor.as_deref()).await?;
        for message in page["data"].as_array().ok_or("Invalid OpenCode history")? {
            total += 1;
            if total > 10_000 {
                return Err("OpenCode history limit exceeded".into());
            }
            if matches!(message["type"].as_str(), Some("user" | "synthetic")) {
                if let Some(id) = message["id"].as_str() {
                    prompts.insert(id.to_owned());
                }
            }
        }
        cursor = page["cursor"]["next"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let Some(value) = cursor.as_ref() else { break };
        if !seen.insert(value.clone()) {
            return Err("OpenCode history cursor loop".into());
        }
    }
    if cursor.is_some() {
        return Err("OpenCode history page limit exceeded".into());
    }
    let boundary = later
        .iter()
        .find(|id| id.starts_with("msg_") && prompts.contains(*id))
        .cloned();
    if boundary.is_none() && later.iter().any(|id| id.starts_with("msg_")) {
        return Err("OpenCode rollback boundary is missing from native history".into());
    }
    Ok(Prepared {
        http,
        session,
        events,
        boundary,
        version,
        v1_index: None,
    })
}
impl Prepared {
    pub(crate) async fn fork(&self, cwd: &str) -> Result<String, String> {
        if self.version == OpenCodeVersion::V1 {
            let mut body = json!({});
            if let Some(boundary) = &self.boundary {
                body["messageID"] = json!(boundary);
            }
            let value = self
                .http
                .request(
                    reqwest::Method::POST,
                    &["session", self.session.native_id(), "fork"],
                    Some(body),
                )
                .await?;
            let id = value["id"]
                .as_str()
                .or_else(|| value["data"]["id"].as_str())
                .filter(|id| !id.is_empty())
                .ok_or("OpenCode did not return a forked session id")?
                .to_owned();
            if let Some(index) = self.v1_index {
                let history = self
                    .http
                    .request(reqwest::Method::GET, &["session", &id, "message"], None)
                    .await?;
                let retained = history
                    .as_array()
                    .or_else(|| history["data"].as_array())
                    .ok_or("Invalid OpenCode fork history")?;
                if retained.len() != index {
                    return Err("OpenCode did not preserve the requested fork boundary".into());
                }
            }
            return Ok(id);
        }
        let mut body = json!({});
        if let Some(boundary) = &self.boundary {
            body["before"] = json!(boundary);
        }
        let value = self
            .http
            .request(
                reqwest::Method::POST,
                &["api", "session", self.session.native_id(), "fork"],
                Some(body),
            )
            .await?;
        let id = value["data"]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("OpenCode did not return a forked session id")?
            .to_owned();
        if value["data"]["location"]["directory"].as_str() != Some(cwd) {
            self.http
                .request(
                    reqwest::Method::POST,
                    &["api", "session", &id, "move"],
                    Some(json!({"directory":cwd})),
                )
                .await?;
        }
        Ok(id)
    }
    pub(crate) async fn apply(&mut self, mode: &str) -> Result<Option<String>, String> {
        let Some(boundary) = self.boundary.as_deref() else {
            return Ok(None);
        };
        let native = self.session.native_id();
        if self.version == OpenCodeVersion::V1 {
            let value = self
                .http
                .request(
                    reqwest::Method::POST,
                    &["session", native, "fork"],
                    Some(json!({"messageID":boundary})),
                )
                .await?;
            let forked = value["id"]
                .as_str()
                .or_else(|| value["data"]["id"].as_str())
                .filter(|id| !id.is_empty())
                .ok_or("OpenCode did not return a forked session id")?
                .to_owned();
            let history = self
                .http
                .request(reqwest::Method::GET, &["session", &forked, "message"], None)
                .await?;
            let retained = history
                .as_array()
                .or_else(|| history["data"].as_array())
                .ok_or("Invalid OpenCode fork history")?;
            if Some(retained.len()) != self.v1_index {
                return Err("OpenCode did not preserve the requested rewind boundary".into());
            }
            let rules = if mode == "full-access" {
                json!([{"permission":"*","pattern":"*","action":"allow"}])
            } else {
                let mut rules = vec![json!({"permission":"*","pattern":"*","action":"ask"})];
                for permission in [
                    "question",
                    "read",
                    "glob",
                    "grep",
                    "lsp",
                    "todowrite",
                    "task",
                    "skill",
                ] {
                    rules.push(json!({"permission":permission,"pattern":"*","action":"allow"}));
                }
                rules.push(json!({"permission":"read","pattern":"*.env","action":"ask"}));
                rules.push(json!({"permission":"read","pattern":"*.env.*","action":"ask"}));
                rules.push(json!({"permission":"read","pattern":"*.env.example","action":"allow"}));
                if mode == "auto-accept-edits" {
                    rules.push(json!({"permission":"edit","pattern":"*","action":"allow"}));
                }
                json!(rules)
            };
            self.session
                .for_native(&forked)
                .update_permissions(rules)
                .await?;
            return Ok(Some(forked));
        }
        let result = async {
            self.http
                .request(
                    reqwest::Method::POST,
                    &["api", "session", native, "revert", "stage"],
                    Some(json!({"messageID":boundary,"files":false})),
                )
                .await?;
            self.http
                .request(
                    reqwest::Method::POST,
                    &["api", "session", native, "revert", "commit"],
                    Some(json!({})),
                )
                .await?;
            Ok::<(), String>(())
        }
        .await;
        if result.is_err() {
            let _ = self
                .http
                .request(
                    reqwest::Method::DELETE,
                    &["api", "session", native, "revert"],
                    None,
                )
                .await;
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let event = self.events.next().await?;
                    if event["data"]["sessionID"] == native
                        && event["type"]
                            .as_str()
                            .is_some_and(|kind| kind.starts_with("session.execution."))
                    {
                        return Ok::<(), String>(());
                    }
                }
            })
            .await;
        }
        result.map(|_| None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::Request, response::Response, routing::any, Router};
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn v1_rollback_forks_and_checks_retained_history() {
        let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let observed = calls.clone();
        let app=Router::new().fallback(any(move |request:Request| {let observed=observed.clone();async move {
            let path=request.uri().path().to_owned();
            if path=="/api/info" {return Response::builder().status(404).body(Body::empty()).unwrap();}
            if path=="/global/health" {return Response::new(Body::from(r#"{"healthy":true,"version":"1.3.15"}"#));}
            if path=="/event" {return Response::builder().header("content-type","text/event-stream").body(Body::from("data: {}\n\n")).unwrap();}
            if path=="/session/status" {return Response::new(Body::from("{}"));}
            if path=="/session/native/message" {return Response::new(Body::from(r#"[{"info":{"id":"msg_a","role":"user"}},{"info":{"id":"msg_b","role":"user"}}]"#));}
            if path=="/session/forked/message" {return Response::new(Body::from(r#"[{"info":{"id":"msg_a","role":"user"}}]"#));}
            let body=axum::body::to_bytes(request.into_body(),4096).await.unwrap();let value=serde_json::from_slice(&body).unwrap_or(Value::Null);
            observed.lock().unwrap().push((path.clone(),value));
            if path.ends_with("/fork") {return Response::new(Body::from(r#"{"id":"forked"}"#));}
            Response::new(Body::from("{}"))
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir =
            std::env::temp_dir().join(format!("t3-opencode-v1-rollback-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings,json!({"providerInstances":{"opencode":{"driver":"opencode","config":{"serverUrl":format!("http://{addr}")}}}}).to_string()).unwrap();
        let mut prepared = prepare(
            &settings,
            "opencode",
            "rollback-v1",
            dir.to_str().unwrap(),
            "native",
            &["msg_b".into()],
        )
        .await
        .unwrap();
        assert_eq!(
            prepared.fork(dir.to_str().unwrap()).await.unwrap(),
            "forked"
        );
        {
            let mut recorded = calls.lock().unwrap();
            assert_eq!(recorded.len(), 1);
            assert_eq!(recorded[0].1, json!({"messageID":"msg_b"}));
            recorded.clear();
        }
        assert_eq!(
            prepared.apply("full-access").await.unwrap().as_deref(),
            Some("forked")
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].0.ends_with("/fork"));
        assert_eq!(calls[0].1, json!({"messageID":"msg_b"}));
        assert!(calls[1].0.ends_with("/forked"));
        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rollback_uses_earliest_valid_later_prompt_and_never_restores_files() {
        let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let observed = calls.clone();
        let app=Router::new().fallback(any(move |request:Request| {let observed=observed.clone();async move {
            let path=request.uri().path().to_owned();
            if path=="/api/info" {return Response::new(Body::from(r#"{"version":"2.0.18"}"#));}
            if path=="/api/event" {return Response::builder().header("content-type","text/event-stream").body(Body::from("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")).unwrap();}
            if path=="/api/session/active" {return Response::new(Body::from(r#"{"data":{}}"#));}
            if path.ends_with("/message") {return Response::new(Body::from(r#"{"data":[{"id":"msg_b","type":"user"},{"id":"msg_a","type":"user"}],"cursor":{}}"#));}
            let bytes=axum::body::to_bytes(request.into_body(),4096).await.unwrap();
            let body=serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let fork=path.ends_with("/fork");
            observed.lock().unwrap().push((path,body));
            if fork {return Response::new(Body::from(r#"{"data":{"id":"forked","location":{"directory":"/old"}}}"#));}
            Response::new(Body::from("{}"))
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir =
            std::env::temp_dir().join(format!("t3-opencode-rollback-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings,json!({"providerInstances":{"opencode":{"driver":"opencode","config":{"serverUrl":format!("http://{addr}")}}}}).to_string()).unwrap();
        assert!(prepare(
            &settings,
            "opencode",
            "rollback-test",
            dir.to_str().unwrap(),
            "native",
            &["unsafe-id".into()]
        )
        .await
        .is_err());
        assert!(calls.lock().unwrap().is_empty());
        assert!(prepare(
            &settings,
            "opencode",
            "rollback-test",
            dir.to_str().unwrap(),
            "native",
            &["msg_missing".into()]
        )
        .await
        .is_err());
        assert!(calls.lock().unwrap().is_empty());
        let mut prepared = prepare(
            &settings,
            "opencode",
            "rollback-test",
            dir.to_str().unwrap(),
            "native",
            &["msg_a".into(), "msg_b".into()],
        )
        .await
        .unwrap();
        assert_eq!(prepared.boundary.as_deref(), Some("msg_a"));
        assert_eq!(prepared.fork("/destination").await.unwrap(), "forked");
        {
            let mut calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert!(calls[0].0.ends_with("/fork"));
            assert_eq!(calls[0].1, json!({"before":"msg_a"}));
            assert!(calls[1].0.ends_with("/forked/move"));
            assert_eq!(calls[1].1, json!({"directory":"/destination"}));
            calls.clear();
        }
        prepared.apply("full-access").await.unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].0.ends_with("/revert/stage"));
        assert_eq!(calls[0].1, json!({"messageID":"msg_a","files":false}));
        assert!(calls[1].0.ends_with("/revert/commit"));
        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
}
