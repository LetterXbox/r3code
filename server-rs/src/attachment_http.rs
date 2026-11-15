//! Unauthenticated upload endpoint: the signed, short-lived URL is the credential.
use crate::attachment_store::{self, UploadError};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use futures_util::StreamExt;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;

struct PartFile(PathBuf);
impl Drop for PartFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Clone)]
pub struct UploadState {
    pub directory: PathBuf,
    pub signing_key: [u8; 32],
}
pub fn router(state: Arc<UploadState>) -> Router {
    Router::new()
        .route("/api/attachments/upload/{token}", post(upload))
        .with_state(state)
}
async fn upload(
    State(state): State<Arc<UploadState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as i64)
        .unwrap_or(i64::MAX);
    let Some(claims) = attachment_store::verify_upload(&state.signing_key, &token, now) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Tokens are authenticated, but validate the size before allocating or consuming a body.
    if claims.size_bytes > 50 * 1024 * 1024 {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(length) = headers.get(header::CONTENT_LENGTH) {
        if length.to_str().ok().and_then(|s| s.parse::<u64>().ok()) != Some(claims.size_bytes) {
            return (
                StatusCode::BAD_REQUEST,
                "Content-Length must match the upload size.",
            )
                .into_response();
        }
    }
    let part = match attachment_store::upload_part_path(&state.directory, &claims) {
        Ok(path) => PartFile(path),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to resolve attachment path.",
            )
                .into_response()
        }
    };
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part.0)
        .await
    {
        Ok(file) => file,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist upload.",
            )
                .into_response()
        }
    };
    let mut stream = body.into_data_stream();
    let mut received = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to persist upload.",
                )
                    .into_response()
            }
        };
        received = received.saturating_add(chunk.len() as u64);
        if received > claims.size_bytes {
            return (
                StatusCode::BAD_REQUEST,
                format!("Body was {received} bytes, expected {}.", claims.size_bytes),
            )
                .into_response();
        }
        if file.write_all(&chunk).await.is_err() {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist upload.",
            )
                .into_response();
        }
    }
    if received != claims.size_bytes {
        return (
            StatusCode::BAD_REQUEST,
            format!("Body was {received} bytes, expected {}.", claims.size_bytes),
        )
            .into_response();
    }
    if file.flush().await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to persist upload.",
        )
            .into_response();
    }
    drop(file);
    let directory = state.directory.clone();
    match tokio::task::spawn_blocking(move || {
        let result = attachment_store::publish_part(&directory, &claims, &part.0);
        if result.is_ok() {
            if let Some(path) =
                crate::attachment_paths::find_by_id(&directory, &claims.attachment_id)
            {
                crate::document_text::ensure(&path);
            }
        }
        result
    })
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(UploadError::Conflict)) => {
            (StatusCode::CONFLICT, "Attachment already uploaded.").into_response()
        }
        Ok(Err(UploadError::Size(actual, expected))) => (
            StatusCode::BAD_REQUEST,
            format!("Body was {actual} bytes, expected {expected}."),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to persist upload.",
        )
            .into_response(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn endpoint_authenticates_and_enforces_lengths_and_immutability() {
        let directory =
            std::env::temp_dir().join(format!("attachment-http-{}", uuid::Uuid::new_v4()));
        let state = Arc::new(UploadState {
            directory: directory.clone(),
            signing_key: [7; 32],
        });
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let (_, token) = attachment_store::create_upload(
            &state.signing_key,
            "file",
            "a.txt",
            "text/plain",
            3,
            now,
        )
        .unwrap();
        let call = |token: String, headers: HeaderMap, body: &'static str| {
            upload(State(state.clone()), Path(token), headers, Body::from(body))
        };
        assert_eq!(
            call("bad".into(), HeaderMap::new(), "abc").await.status(),
            StatusCode::NOT_FOUND
        );
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "2".parse().unwrap());
        assert_eq!(
            call(token.clone(), headers, "abc").await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(token.clone(), HeaderMap::new(), "ab").await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(token.clone(), HeaderMap::new(), "abcd").await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(token.clone(), HeaderMap::new(), "abc").await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(token.clone(), HeaderMap::new(), "abc").await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(token, HeaderMap::new(), "xyz").await.status(),
            StatusCode::CONFLICT
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
