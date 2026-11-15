//! Probe an OTLP HTTP collector with an empty export.
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// The server currently has no configured OTLP exporter; consequently no
/// exporter credentials are attached to candidate endpoints.
pub async fn check(input: &Value) -> Result<Value, ()> {
    let signal = input.get("signal").and_then(Value::as_str).ok_or(())?;
    let field = match signal {
        "traces" => "resourceSpans",
        "metrics" => "resourceMetrics",
        "logs" => "resourceLogs",
        _ => return Err(()),
    };
    let url = input.get("url").and_then(Value::as_str).ok_or(())?.trim();
    let parsed = url::Url::parse(url).map_err(|_| ())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| ())?;
    let started = Instant::now();
    let body = json!({(field): []}).to_string();
    let result = client
        .post(parsed)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await;
    Ok(match result {
        Ok(response) if response.status().is_success() => {
            json!({"_tag":"Accepted","latencyMs":started.elapsed().as_millis() as u64})
        }
        Ok(response) => json!({"_tag":"Rejected","status":response.status().as_u16()}),
        Err(error) => json!({"_tag":"Unreachable","timedOut":error.is_timeout()}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn sends_empty_export_and_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            stream.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n").await.unwrap();
            request
        });
        let result = check(&json!({"signal":"traces","url":format!("http://{addr}/v1/traces")}))
            .await
            .unwrap();
        assert_eq!(result, json!({"_tag":"Rejected","status":307}));
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /v1/traces HTTP/1.1"));
        assert!(request.contains("{\"resourceSpans\":[]}"));
        assert!(check(&json!({"signal":"bad","url":"http://localhost"}))
            .await
            .is_err());
        assert!(check(&json!({"signal":"logs","url":"file:///tmp/x"}))
            .await
            .is_err());
    }
}
