//! MCP stdio-to-HTTP bridge for ACP agents without native HTTP MCP support.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::{Arc, Mutex},
};

async fn forward(
    client: reqwest::Client,
    endpoint: String,
    authorization: String,
    session: Arc<Mutex<Option<String>>>,
    output: Arc<Mutex<()>>,
    request: Value,
) {
    let id = request.get("id").cloned();
    let current = session.lock().ok().and_then(|v| v.clone());
    let mut post = client
        .post(&endpoint)
        .header("Authorization", authorization)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .header("t3-tool-exposure", "deferred");
    if let Some(session) = current {
        post = post
            .header("mcp-session-id", session)
            .header("mcp-protocol-version", "2025-06-18");
    }
    let response = post.body(request.to_string()).send().await;
    let payload = match response {
        Ok(response) => {
            if let Some(id) = response
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
            {
                if let Ok(mut current) = session.lock() {
                    *current = Some(id.to_owned());
                }
            }
            let status = response.status();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let body = response.text().await.unwrap_or_default();
            if content_type.starts_with("text/event-stream") {body.lines().filter_map(|line|line.strip_prefix("data:").map(str::trim)).find_map(|line|serde_json::from_str::<Value>(line).ok())} else {serde_json::from_str::<Value>(&body).ok()}.unwrap_or_else(||json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":format!("MCP bridge request failed ({status})")}}))
        }
        Err(_) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"MCP bridge request failed"}})
        }
    };
    if id.is_some() {
        if let Ok(_guard) = output.lock() {
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(stdout, "{payload}");
            let _ = stdout.flush();
        }
    }
}

pub fn run() -> Result<(), String> {
    let endpoint = std::env::var("T3_ACP_MCP_ENDPOINT").map_err(|_| "Missing MCP endpoint")?;
    let authorization =
        std::env::var("T3_ACP_MCP_AUTHORIZATION").map_err(|_| "Missing MCP authorization")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3900))
        .build()
        .map_err(|e| e.to_string())?;
    let session = Arc::new(Mutex::new(None));
    let output = Arc::new(Mutex::new(()));
    let mut pending = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) if line.len() <= 1024 * 1024 => value,
            _ => {
                let mut stdout = std::io::stdout().lock();
                writeln!(stdout,"{}",json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})).map_err(|e|e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let initialize = request["method"] == "initialize";
        let operation = forward(
            client.clone(),
            endpoint.clone(),
            authorization.clone(),
            session.clone(),
            output.clone(),
            request,
        );
        // Initialization must finish before later messages can use its session ID.
        if initialize {
            runtime.block_on(operation)
        } else {
            pending.push(runtime.spawn(operation));
            pending.retain(|task| !task.is_finished());
        }
    }
    runtime.block_on(async {
        for task in pending {
            let _ = task.await;
        }
    });
    Ok(())
}

/// One-shot terminal fallback used when an ACP agent cannot expose MCP tools.
pub fn call(tool: &str, arguments: &str) -> Result<(), String> {
    let args: Value = serde_json::from_str(arguments).map_err(|_| "Invalid tool arguments")?;
    if tool.trim().is_empty() || !args.is_object() {
        return Err("Invalid tool arguments".into());
    }
    let endpoint = std::env::var("T3_ACP_MCP_ENDPOINT").map_err(|_| "Missing MCP endpoint")?;
    let authorization =
        std::env::var("T3_ACP_MCP_AUTHORIZATION").map_err(|_| "Missing MCP authorization")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let result=runtime.block_on(async {
        let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(3900)).build().map_err(|_|"MCP client unavailable")?;
        let init=json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t3-acp-fallback","version":"1"}}});
        let response=client.post(&endpoint).header("Authorization",&authorization).header("Accept","application/json, text/event-stream").header("Content-Type","application/json").header("t3-tool-exposure","deferred").body(init.to_string()).send().await.map_err(|_|"MCP initialization failed")?;
        let session=response.headers().get("mcp-session-id").and_then(|v|v.to_str().ok()).ok_or("MCP session missing")?.to_owned();
        let request=json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":args}});
        let response=client.post(&endpoint).header("Authorization",&authorization).header("Accept","application/json, text/event-stream").header("Content-Type","application/json").header("t3-tool-exposure","deferred").header("mcp-session-id",session).header("mcp-protocol-version","2025-06-18").body(request.to_string()).send().await.map_err(|_|"MCP call failed")?;
        let payload:Value=serde_json::from_str(&response.text().await.map_err(|_|"MCP call failed")?).map_err(|_|"Invalid MCP response")?;
        if payload.get("error").is_some(){return Err("MCP call failed")}
        Ok::<_,&str>(payload["result"].clone())
    }).map_err(str::to_owned)?;
    let mut result = result;
    if let Some(structured) = result.get("structuredContent").cloned() {
        let encoded = structured.to_string();
        if let Some(content) = result["content"].as_array_mut() {
            content.retain(|part| {
                !(part["type"] == "text" && part["text"].as_str() == Some(encoded.as_str()))
            });
        }
    }
    writeln!(std::io::stdout(), "{result}").map_err(|e| e.to_string())
}
