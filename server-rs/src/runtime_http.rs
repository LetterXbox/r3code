//! Small, unauthenticated process liveness and startup readiness endpoints.
use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum StartupStatus {
    Starting = 0,
    Ready = 1,
    Failed = 2,
    ShuttingDown = 3,
}

#[derive(Debug, Clone, Default)]
pub struct StartupReadiness(Arc<AtomicU8>);

impl StartupReadiness {
    pub fn status(&self) -> StartupStatus {
        match self.0.load(Ordering::Acquire) {
            1 => StartupStatus::Ready,
            2 => StartupStatus::Failed,
            3 => StartupStatus::ShuttingDown,
            _ => StartupStatus::Starting,
        }
    }

    pub fn set(&self, status: StartupStatus) {
        self.0.store(status as u8, Ordering::Release);
    }

    /// Wait for the normal process termination signals and mark readiness
    /// unavailable before the HTTP server begins graceful shutdown.
    pub async fn shutdown_signal(&self) {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to install SIGTERM handler");
            tokio::select! {
                result = tokio::signal::ctrl_c() => {
                    if let Err(error) = result {
                        eprintln!("failed to listen for Ctrl-C: {error}");
                    }
                }
                _ = terminate.recv() => {}
            }
        }
        #[cfg(not(unix))]
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("failed to listen for Ctrl-C: {error}");
        }
        self.set(StartupStatus::ShuttingDown);
    }
}

pub fn router(readiness: StartupReadiness) -> Router {
    Router::new()
        .route("/health", get(liveness))
        .route("/ready", get(readiness_response))
        .with_state(readiness)
}

async fn liveness() -> Json<serde_json::Value> {
    Json(json!({"status":"ok"}))
}

async fn readiness_response(
    axum::extract::State(readiness): axum::extract::State<StartupReadiness>,
) -> Response {
    let status = readiness.status();
    let (code, label) = match status {
        StartupStatus::Ready => (StatusCode::OK, "ready"),
        StartupStatus::Starting => (StatusCode::SERVICE_UNAVAILABLE, "starting"),
        StartupStatus::Failed => (StatusCode::SERVICE_UNAVAILABLE, "failed"),
        StartupStatus::ShuttingDown => (StatusCode::SERVICE_UNAVAILABLE, "shutting_down"),
    };
    let mut response = (code, Json(json!({"status":label}))).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if status != StartupStatus::Ready {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    async fn get(addr: SocketAddr, path: &'static str) -> String {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(addr).unwrap();
            use std::io::{Read, Write};
            write!(
                stream,
                "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn liveness_is_separate_from_readiness() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let readiness = StartupReadiness::default();
        let app = router(readiness.clone());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });

        let live = get(addr, "/health").await;
        assert!(live.starts_with("HTTP/1.1 200"), "{live}");
        let starting = get(addr, "/ready").await;
        assert!(starting.starts_with("HTTP/1.1 503"), "{starting}");
        assert!(starting.to_ascii_lowercase().contains("retry-after: 1"));

        readiness.set(StartupStatus::Ready);
        let ready = get(addr, "/ready").await;
        assert!(ready.starts_with("HTTP/1.1 200"), "{ready}");
        let _ = stop.send(());
        server.await.unwrap();
    }
}
