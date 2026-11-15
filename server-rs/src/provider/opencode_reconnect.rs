//! Bounded OpenCode 2 stream reconnection and turn-history reconciliation.
use super::{opencode_http::OpenCodeEvents, opencode_session::OpenCodeSession};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) async fn recover_image_reports(session: &OpenCodeSession) -> Result<Vec<Value>, String> {
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut reports = Vec::new();
    for _ in 0..200 {
        let page = session.history(cursor.as_deref()).await?;
        for message in page["data"]
            .as_array()
            .ok_or("Invalid OpenCode message history")?
        {
            if message["type"] == "synthetic"
                && message["metadata"]["source"] == "experimental_image_generate"
            {
                reports.push(json!({"type":"session.inbox.enqueued","data":{"sessionID":session.native_id(),"inboxID":message["id"],"item":{"type":"synthetic","payload":{"text":message["text"],"description":message["description"],"metadata":message["metadata"]},"delivery":"steer"}}}));
                if reports.len() > 10_000 {
                    return Err("OpenCode image history limit exceeded".into());
                }
            }
        }
        cursor = page["cursor"]["next"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let Some(next) = cursor.as_ref() else { break };
        if !seen.insert(next.clone()) {
            return Err("OpenCode history cursor loop".into());
        }
    }
    reports.reverse();
    if let Ok(jobs) = session.image_jobs().await {
        for job in jobs["data"].as_array().into_iter().flatten() {
            if job["sessionID"].as_str() != Some(session.native_id()) {
                continue;
            }
            let Some(state) = job["status"]
                .as_str()
                .filter(|state| matches!(*state, "completed" | "error" | "cancelled"))
            else {
                continue;
            };
            reports.push(json!({"type":"session.inbox.enqueued","data":{"sessionID":session.native_id(),"item":{"type":"synthetic","payload":{"text":format!("Image generation {state}. Output path: {} ({}).",job["path"].as_str().unwrap_or(""),job["model"].as_str().unwrap_or("")),"metadata":{"source":"experimental_image_generate","jobID":job["id"],"state":state}}}}}));
        }
    }
    Ok(reports)
}

pub(crate) async fn recover(
    session: &OpenCodeSession,
    boundary: &str,
) -> Result<(OpenCodeEvents, Vec<Value>), String> {
    recover_before(session, Some(boundary)).await
}

pub(crate) async fn recover_before(
    session: &OpenCodeSession,
    boundary: Option<&str>,
) -> Result<(OpenCodeEvents, Vec<Value>), String> {
    let events = session.reconnect().await?;
    let replay = recover_history_before(session, boundary).await?;
    Ok((events, replay))
}

pub(crate) async fn recover_history(
    session: &OpenCodeSession,
    boundary: &str,
) -> Result<Vec<Value>, String> {
    recover_history_before(session, Some(boundary)).await
}

async fn recover_history_before(
    session: &OpenCodeSession,
    boundary: Option<&str>,
) -> Result<Vec<Value>, String> {
    let active = session.active_sessions().await?;
    let active = active["data"]
        .as_object()
        .ok_or("Invalid OpenCode active session response")?
        .contains_key(session.native_id());
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut history = Vec::new();
    let mut found = boundary.is_none();
    for _ in 0..200 {
        let page = match session.history(cursor.as_deref()).await {
            Ok(page) => page,
            Err(error) if error == "OpenCode native session not found" => {
                return Ok(vec![
                    json!({"type":"t3.reconnect.missing","data":{"sessionID":session.native_id()}}),
                ])
            }
            Err(error) => return Err(error),
        };
        let data = page["data"]
            .as_array()
            .ok_or("Invalid OpenCode message history")?;
        for message in data {
            if boundary.is_some() && message["id"].as_str() == boundary {
                found = true;
                break;
            }
            history.push(message.clone());
            if history.len() > 10_000 {
                return Err("OpenCode history limit exceeded".into());
            }
        }
        if found && boundary.is_some() {
            break;
        }
        cursor = page["cursor"]["next"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let Some(value) = &cursor else { break };
        if !seen.insert(value.clone()) {
            return Err("OpenCode history cursor loop".into());
        }
    }
    if !found {
        // These messages could belong to an earlier turn. The original
        // discards them and relies on current activity to settle or continue.
        history.clear();
    }
    let mut replay = Vec::new();
    let mut idle = None;
    for message in history.iter().rev() {
        if message["type"] == "user" {
            if let Some(id) = message["id"].as_str() {
                replay.push(json!({"type":"session.inbox.delivered","data":{"sessionID":session.native_id(),"inboxID":id}}));
            }
            continue;
        }
        if message["type"] == "synthetic"
            && message["metadata"]["source"] == "experimental_image_generate"
        {
            replay.push(json!({"type":"session.inbox.enqueued","data":{"sessionID":session.native_id(),"inboxID":message["id"],"item":{"type":"synthetic","payload":{"text":message["text"],"description":message["description"],"metadata":message["metadata"]},"delivery":"steer"}}}));
            continue;
        }
        if message["type"] == "idle" {
            idle = message["outcome"].as_str().map(str::to_owned);
            continue;
        }
        if message["type"] != "assistant" {
            continue;
        }
        let id = message["id"]
            .as_str()
            .ok_or("OpenCode history message has no id")?;
        let Some(parts) = message["content"].as_array() else {
            continue;
        };
        let (mut text_index, mut reasoning_index) = (0u64, 0u64);
        for (index, part) in parts.iter().enumerate() {
            match part["type"].as_str() {
                Some(kind @ ("text" | "reasoning")) => {
                    let ordinal = if kind == "text" {
                        let n = text_index;
                        text_index += 1;
                        n
                    } else {
                        let n = reasoning_index;
                        reasoning_index += 1;
                        n
                    };
                    let open = message["time"]["streamed"].is_null()
                        && message["finish"].is_null()
                        && index + 1 == parts.len();
                    if open {
                        continue;
                    }
                    replay.push(json!({"type":format!("session.{kind}.ended"),"data":{"sessionID":session.native_id(),"assistantMessageID":id,"ordinal":ordinal,"text":part["text"]}}));
                }
                Some("tool") => {
                    let tool = part["id"]
                        .as_str()
                        .ok_or("OpenCode history tool has no id")?;
                    replay.push(json!({"type":"session.tool.input.started","data":{"sessionID":session.native_id(),"id":tool,"name":part["name"]}}));
                    replay.push(json!({"type":"session.tool.called","data":{"sessionID":session.native_id(),"id":tool,"input":part["state"]["input"]}}));
                    let status = part["state"]["status"].as_str().unwrap_or("");
                    if status == "completed" {
                        replay.push(json!({"type":"session.tool.success","data":{"sessionID":session.native_id(),"id":tool,"content":part["state"]["content"],"metadata":part["state"]["metadata"]}}));
                    }
                    if status == "error" {
                        replay.push(json!({"type":"session.tool.failed","data":{"sessionID":session.native_id(),"id":tool,"error":part["state"]["error"]}}));
                    }
                }
                _ => {}
            }
        }
    }
    if active {
        let (permissions, forms) = session.pending_requests().await?;
        for value in permissions["data"]
            .as_array()
            .ok_or("Invalid OpenCode permission list")?
        {
            replay.push(json!({"type":"permission.asked","data":value}));
        }
        for value in forms["data"]
            .as_array()
            .ok_or("Invalid OpenCode form list")?
        {
            replay.push(json!({"type":"form.created","data":{"form":value}}));
        }
    } else {
        let kind = match idle.as_deref() {
            Some("succeeded") => "succeeded",
            Some("failed") => "reconnect.failed",
            _ => "interrupted",
        };
        let kind = if kind == "reconnect.failed" {
            "t3.reconnect.failed".to_owned()
        } else {
            format!("session.execution.{kind}")
        };
        replay.push(json!({"type":kind,"data":{"sessionID":session.native_id()}}));
    }
    Ok(replay)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::opencode_http::{OpenCodeHttp, OpenCodeVersion};
    use axum::{body::Body, extract::Request, response::Response, routing::any, Router};
    #[tokio::test]
    async fn recovery_backfills_only_current_turn_and_pending_requests() {
        let app=Router::new().fallback(any(|request:Request|async move {
            let path=request.uri().path();
            if path=="/api/event" {return Response::builder().header("content-type","text/event-stream").body(Body::from("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")).unwrap();}
            if path=="/api/session" {return Response::new(Body::from(r#"{"data":{"id":"ses"}}"#));}
            if path=="/api/session/active" {return Response::new(Body::from(r#"{"data":{"ses":{}}}"#));}
            if path.ends_with("/permission") {return Response::new(Body::from(r#"{"data":[{"id":"per","sessionID":"ses","action":"shell"}]}"#));}
            if path.ends_with("/form") {return Response::new(Body::from(r#"{"data":[]}"#));}
            if path.ends_with("/message") {return Response::new(Body::from(json!({"data":[{"id":"msg_assistant","type":"assistant","time":{"created":1},"finish":"stop","content":[{"type":"text","text":"restored"},{"type":"tool","id":"call","name":"read","state":{"status":"completed","input":{"path":"x"},"content":[]}}]},{"id":"msg_steer","type":"user"},{"id":"msg_boundary","type":"user"},{"id":"old","type":"assistant","content":[]}],"cursor":{}}).to_string()));}
            Response::new(Body::from("{}"))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = OpenCodeHttp::new(&format!("http://{addr}"), None).unwrap();
        let (session, _) = OpenCodeSession::connect(http, OpenCodeVersion::V2, None, json!({}))
            .await
            .unwrap();
        let (_, events) = recover(&session, "msg_boundary").await.unwrap();
        assert!(events
            .iter()
            .any(|v| v["type"] == "session.text.ended" && v["data"]["text"] == "restored"));
        assert!(events.iter().any(|v| v["type"] == "session.tool.success"));
        assert!(
            events
                .iter()
                .any(|v| v["type"] == "session.inbox.delivered"
                    && v["data"]["inboxID"] == "msg_steer")
        );
        assert!(events.iter().any(|v| v["type"] == "permission.asked"));
        assert!(events.iter().all(|v| !v["type"]
            .as_str()
            .unwrap_or("")
            .starts_with("session.execution.")));
        let (_, missing) = recover(&session, "missing").await.unwrap();
        assert!(missing.iter().any(|v| v["type"] == "permission.asked"));
        assert!(!missing.iter().any(|v| v["type"] == "session.text.ended"));
        let (_, all_events) = recover_before(&session, None).await.unwrap();
        assert!(all_events
            .iter()
            .any(|event| event["type"] == "session.text.ended"
                && event["data"]["text"] == "restored"));
        let child = session.for_native("child");
        let child_events = recover_history(&child, "msg_boundary").await.unwrap();
        assert!(child_events
            .iter()
            .any(|event| event["type"] == "session.text.ended"
                && event["data"]["sessionID"] == "child"));
        assert!(child_events
            .iter()
            .any(|event| event["type"] == "session.execution.interrupted"
                && event["data"]["sessionID"] == "child"));
        server.abort();
    }
}
