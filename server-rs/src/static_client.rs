//! Static web client and development-server fallback.
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

pub struct StaticClient {
    root: Option<PathBuf>,
    dev_url: Option<url::Url>,
    immutable: HashSet<String>,
}
impl StaticClient {
    pub fn new(root: Option<PathBuf>, dev_url: Option<&str>) -> Self {
        let mut immutable = HashSet::new();
        if let Some(root) = &root {
            if let Ok(bytes) = std::fs::read(root.join(".vite/manifest.json")) {
                if let Ok(serde_json::Value::Object(entries)) =
                    serde_json::from_slice::<serde_json::Value>(&bytes)
                {
                    for entry in entries.values() {
                        if let Some(file) = entry.get("file").and_then(|v| v.as_str()) {
                            immutable.insert(file.to_owned());
                        }
                        for key in ["css", "assets"] {
                            if let Some(items) = entry.get(key).and_then(|v| v.as_array()) {
                                immutable.extend(
                                    items.iter().filter_map(|v| v.as_str().map(str::to_owned)),
                                );
                            }
                        }
                    }
                }
            }
        }
        Self {
            root,
            dev_url: dev_url.and_then(|s| url::Url::parse(s).ok()),
            immutable,
        }
    }
}
fn proxied(path: &str) -> bool {
    ["/api", "/oauth", "/.well-known", "/ws", "/mcp"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}
fn loopback(headers: &HeaderMap) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let hostname = if host.starts_with('[') {
        host.split(']').next().unwrap_or("").trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(
        hostname.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}
fn text(status: StatusCode, body: &'static str) -> Response {
    (status, body).into_response()
}

pub async fn serve(
    State(state): State<Arc<StaticClient>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return text(StatusCode::NOT_FOUND, "Not Found");
    }
    let path = uri.path();
    if let Some(dev) = &state.dev_url {
        if proxied(path) {
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
        if loopback(&headers) {
            let target = format!(
                "{}{}",
                dev.origin().ascii_serialization(),
                uri.path_and_query().map_or("/", |p| p.as_str())
            );
            return match HeaderValue::from_str(&target) {
                Ok(value) => (StatusCode::FOUND, [(header::LOCATION, value)]).into_response(),
                Err(_) => text(StatusCode::BAD_REQUEST, "Bad Request"),
            };
        }
    }
    let Some(root) = &state.root else {
        if state.dev_url.is_some() {
            return (StatusCode::SERVICE_UNAVAILABLE, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::RETRY_AFTER, "2")], "<!doctype html><meta http-equiv=\"refresh\" content=\"2\"><p>Waiting for the first web build. This page reloads by itself.</p>").into_response();
        }
        return text(
            StatusCode::SERVICE_UNAVAILABLE,
            "No static directory configured and no dev URL set.",
        );
    };
    let decoded =
        match percent_encoding::percent_decode_str(path.trim_start_matches('/')).decode_utf8() {
            Ok(v) if !v.contains('\0') => v,
            _ => return text(StatusCode::BAD_REQUEST, "Invalid static file path"),
        };
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return text(StatusCode::BAD_REQUEST, "Invalid static file path");
    }
    let mut file = root.join(relative);
    if file.extension().is_none() {
        file.push("index.html");
    }
    if !file.is_file() {
        file = root.join("index.html");
    }
    let root_canonical = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return text(StatusCode::NOT_FOUND, "Not Found"),
    };
    let canonical = match file.canonicalize() {
        Ok(p) if p.starts_with(&root_canonical) => p,
        Ok(_) => return text(StatusCode::BAD_REQUEST, "Invalid static file path"),
        Err(_) => return text(StatusCode::NOT_FOUND, "Not Found"),
    };
    let metadata = match std::fs::metadata(&canonical) {
        Ok(m) => m,
        Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    };
    let is_html = canonical
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("html"));
    let relative_name = file
        .strip_prefix(root)
        .unwrap_or(&file)
        .to_string_lossy()
        .replace('\\', "/");
    let hashed = regex::Regex::new(r"^assets/.+-[\w-]{8}\.[^/]+$")
        .unwrap()
        .is_match(&relative_name);
    let cache = if !is_html && hashed && state.immutable.contains(&relative_name) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::empty());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(if is_html {
            "text/html; charset=utf-8"
        } else {
            mime.essence_str()
        })
        .unwrap(),
    );
    if !is_html {
        if let Ok(modified) = metadata.modified() {
            let millis = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let etag = format!("W/\"{:x}-{millis:x}\"", metadata.len());
            response
                .headers_mut()
                .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
            response.headers_mut().insert(
                header::LAST_MODIFIED,
                HeaderValue::from_str(&httpdate::fmt_http_date(modified)).unwrap(),
            );
            let matches = if let Some(v) = headers
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
            {
                v.split(',').any(|s| {
                    s.trim() == "*"
                        || s.trim().trim_start_matches("W/") == etag.trim_start_matches("W/")
                })
            } else {
                headers
                    .get(header::IF_MODIFIED_SINCE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| httpdate::parse_http_date(v).ok())
                    .is_some_and(|date| {
                        modified.duration_since(date).unwrap_or_default().as_secs() == 0
                    })
            };
            if matches {
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                response
                    .headers_mut()
                    .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
                return response;
            }
        }
    }
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.len().to_string()).unwrap(),
    );
    if method == Method::GET {
        match std::fs::read(canonical) {
            Ok(bytes) => *response.body_mut() = Body::from(bytes),
            Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn serves_spa_and_manifest_assets_with_validators() {
        let root = std::env::temp_dir().join(format!("t3-static-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(root.join(".vite")).unwrap();
        std::fs::write(root.join("index.html"), "<html>app</html>").unwrap();
        std::fs::write(root.join("assets/app-12345678.js"), "hello").unwrap();
        std::fs::write(
            root.join(".vite/manifest.json"),
            r#"{"main":{"file":"assets/app-12345678.js"}}"#,
        )
        .unwrap();
        let state = Arc::new(StaticClient::new(Some(root.clone()), None));
        let page = serve(
            State(state.clone()),
            Method::GET,
            "/pair".parse().unwrap(),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-cache");
        let asset = serve(
            State(state.clone()),
            Method::GET,
            "/assets/app-12345678.js".parse().unwrap(),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(
            asset.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, asset.headers()[header::ETAG].clone());
        let cached = serve(
            State(state.clone()),
            Method::GET,
            "/assets/app-12345678.js".parse().unwrap(),
            headers,
        )
        .await;
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        let traversal = serve(
            State(state),
            Method::GET,
            "/%2e%2e/secret".parse().unwrap(),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn dev_redirect_keeps_query_and_excludes_api() {
        let state = Arc::new(StaticClient::new(None, Some("http://localhost:5173/base")));
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:3773"));
        let redirect = serve(
            State(state.clone()),
            Method::GET,
            "/pair?x=1".parse().unwrap(),
            headers.clone(),
        )
        .await;
        assert_eq!(
            redirect.headers()[header::LOCATION],
            "http://localhost:5173/pair?x=1"
        );
        assert_eq!(
            serve(
                State(state),
                Method::GET,
                "/api/missing".parse().unwrap(),
                headers
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
}
