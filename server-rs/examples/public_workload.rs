//! Public-protocol workload. See docs/public-workload.md.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    error::Error,
    io::{Read, Write},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(socket: &mut Socket) -> Result<Value> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(15), socket.next())
            .await?
            .ok_or("WebSocket closed")??;
        if message.is_text() {
            return Ok(serde_json::from_str(message.to_text()?)?);
        }
        if message.is_close() {
            return Err("WebSocket closed".into());
        }
    }
}
async fn command(socket: &mut Socket, id: u64, payload: Value) -> Result<f64> {
    request(socket, id, "orchestration.dispatchCommand", payload).await
}
async fn request(socket: &mut Socket, id: u64, tag: &str, payload: Value) -> Result<f64> {
    let start = Instant::now();
    socket
        .send(Message::Text(
            json!({"_tag":"Request","id":id,"tag":tag,"payload":payload,"headers":[]})
                .to_string()
                .into(),
        ))
        .await?;
    let reply = next_json(socket).await?;
    if reply["requestId"] != json!(id) || reply["exit"]["_tag"] != "Success" {
        return Err(format!("command {id} failed: {reply}").into());
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}
async fn connect(base: &url::Url, cookie: &str) -> Result<Socket> {
    let mut ws = base.clone();
    ws.set_scheme("ws").map_err(|_| "invalid scheme")?;
    ws.set_path("/ws");
    ws.set_query(Some("orchestrationProtocol=2"));
    let mut request = ws.as_str().into_client_request()?;
    request.headers_mut().insert("cookie", cookie.parse()?);
    Ok(tokio_tungstenite::connect_async(request).await?.0)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: T3_PAIRING_CREDENTIAL=... cargo run --example public_workload -- http://127.0.0.1:PORT /absolute/workspace".into());
    }
    let base = url::Url::parse(&args[1])?;
    if base.scheme() != "http"
        || !matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("base URL must be a loopback HTTP origin without a path or query".into());
    }
    let workspace = std::fs::canonicalize(&args[2])?;
    if !workspace.is_dir() {
        return Err("workspace must be a directory".into());
    }
    let credential = std::env::var("T3_PAIRING_CREDENTIAL")?;
    let port = base.port_or_known_default().ok_or("missing port")?;
    let mut stream = std::net::TcpStream::connect((base.host_str().unwrap(), port))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let body = json!({"credential":credential}).to_string();
    let start = Instant::now();
    write!(stream, "POST /api/auth/browser-session HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", base.authority(), body.len(), body)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let pairing_ms = start.elapsed().as_secs_f64() * 1000.0;
    if !response.starts_with("HTTP/1.1 200 ") {
        return Err("pairing failed (HTTP status was not 200)".into());
    }
    let cookie = response
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
        .and_then(|(_, value)| value.trim().split(';').next())
        .ok_or("missing session cookie")?;
    let start = Instant::now();
    let mut socket = connect(&base, cookie).await?;
    let connect_ms = start.elapsed().as_secs_f64() * 1000.0;
    let suffix = uuid::Uuid::new_v4().to_string();
    let project = format!("workload-project-{suffix}");
    let thread = format!("workload-thread-{suffix}");
    let mut timings = serde_json::Map::new();
    timings.insert("pairing".into(), json!(pairing_ms));
    timings.insert("websocket_connect".into(), json!(connect_ms));
    timings.insert("project_create".into(), json!(request(&mut socket, 1, "projects.mutate", json!({"type":"project.create","commandId":format!("project-{suffix}"),"projectId":project,"title":"Workload project","workspaceRoot":workspace})).await?));
    timings.insert("thread_create".into(), json!(command(&mut socket, 2, json!({"type":"thread.create","commandId":format!("thread-{suffix}"),"threadId":thread,"projectId":project,"title":"Workload thread","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null})).await?));
    let mut events = connect(&base, cookie).await?;
    events.send(Message::Text(json!({"_tag":"Request","id":"thread-stream","tag":"orchestration.subscribeThread","payload":{"threadId":thread,"afterSequence":0},"headers":[]}).to_string().into())).await?;
    let turn_start = Instant::now();
    timings.insert("message_dispatch".into(), json!(command(&mut socket, 3, json!({"type":"message.dispatch","commandId":format!("message-{suffix}"),"threadId":thread,"messageId":format!("message-{suffix}"),"text":"hello from client","attachments":[],"createdBy":"user","creationSource":"web","dispatchMode":{"type":"start_immediately"}})).await?));
    let mut approval = false;
    let mut completed = false;
    let mut assistant = false;
    tokio::time::timeout(Duration::from_secs(30), async {
        while !completed || !assistant || !approval {
            let frame = next_json(&mut events).await?;
            if frame["_tag"] != "Chunk" { return Err(format!("unexpected subscription frame: {frame}").into()); }
            events.send(Message::Text(json!({"_tag":"Ack","requestId":"thread-stream"}).to_string().into())).await?;
            for item in frame["values"].as_array().ok_or("missing stream values")? {
                let event = &item["event"];
                if event["type"] == "run.updated"
                    && matches!(event["payload"]["status"].as_str(), Some("failed" | "cancelled" | "interrupted"))
                {
                    return Err(format!("mock-provider run did not complete: {}", event["payload"]["status"]).into());
                }
                if !approval && event["type"] == "runtime-request.updated" && event["payload"]["status"] == "pending" {
                    let request = event["payload"]["id"].as_str().ok_or("missing approval id")?;
                    timings.insert("approval_response".into(), json!(command(&mut socket, 4, json!({"type":"runtime-request.respond","commandId":format!("approval-{suffix}"),"threadId":thread,"requestId":request,"decision":"accept"})).await?));
                    approval = true;
                }
                completed |= event["type"] == "run.updated" && event["payload"]["status"] == "completed";
                assistant |= event["type"] == "message.updated" && event["payload"]["role"] == "assistant" && event["payload"]["text"] == "hello from codex";
            }
        }
        Result::<()>::Ok(())
    }).await??;
    timings.insert(
        "turn_to_completion".into(),
        json!(turn_start.elapsed().as_secs_f64() * 1000.0),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"workload":"mock-codex-turn-v1","success":true,"timings_ms":timings})
        )?
    );
    events.close(None).await?;
    socket.close(None).await?;
    Ok(())
}
