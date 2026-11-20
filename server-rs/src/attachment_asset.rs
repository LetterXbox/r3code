//! Signed URLs for reading persisted attachments.
//!
//! The URL is a short-lived bearer credential, like the upload URL. Attachment IDs
//! are always parsed and resolved as flat files inside the attachment store.
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    io::{self, Read},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

type HmacSha256 = Hmac<Sha256>;
const TOKEN_TTL_MS: i64 = 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetClaims {
    version: u8,
    kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    attachment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    download: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    render_intent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inode: Option<String>,
    expires_at: i64,
}

#[derive(Clone)]
pub struct AssetState {
    pub directory: PathBuf,
    pub state_directory: PathBuf,
    pub signing_key: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedAssetUrl {
    pub relative_url: String,
    pub expires_at: i64,
    pub image_dimensions: Option<crate::image_dimensions::Dimensions>,
    pub file_revision: Option<String>,
}

pub struct AttachmentAssetRequest<'a> {
    pub attachment_id: &'a str,
    pub file_name: Option<&'a str>,
    pub mime_type: Option<&'a str>,
    pub inline: bool,
    pub render_intent: Option<&'a str>,
}

/// Mint a t3code-compatible URL for a stored attachment. Missing and malformed
/// IDs are rejected before any URL is returned.
pub fn issue_attachment_asset_url(
    directory: &std::path::Path,
    signing_key: &[u8; 32],
    request: AttachmentAssetRequest<'_>,
    now_ms: i64,
) -> Result<IssuedAssetUrl, &'static str> {
    let AttachmentAssetRequest {
        attachment_id,
        file_name,
        mime_type,
        inline,
        render_intent,
    } = request;
    if render_intent.is_some_and(|v| v != "mcp-app") {
        return Err("Invalid attachment render intent");
    }
    let parsed = crate::attachment_paths::parse_id(attachment_id).ok_or("Invalid attachment id")?;
    let path = crate::attachment_paths::find_by_id(directory, attachment_id)
        .ok_or("Attachment not found")?;
    if !std::fs::metadata(&path).is_ok_and(|m| m.is_file()) {
        return Err("Attachment not found");
    }
    let image_dimensions = if parsed.extension.is_none() {
        read_attachment_file(directory, &path)
            .ok()
            .and_then(|bytes| crate::image_dimensions::read(&bytes))
    } else {
        None
    };
    let name = file_name.map(str::trim).filter(|s| !s.is_empty());
    if name.is_some_and(|n| n.encode_utf16().count() > 255 || n.chars().any(char::is_control)) {
        return Err("Invalid attachment filename");
    }
    let mime = mime_type.map(str::trim).filter(|s| !s.is_empty());
    if mime.is_some_and(|m| m.len() > 100 || !valid_mime(m)) {
        return Err("Invalid attachment MIME type");
    }
    let extension = parsed.extension.as_deref().unwrap_or("");
    let safe_inline_ext = matches!(extension, "pdf" | "html" | "htm" | "svg");
    let is_video = mime.is_some_and(|m| {
        m.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .starts_with("video/")
    });
    // Mirrors the reference server: generic files download by default; viewers
    // may explicitly request inline for known document types.
    let download = if is_video {
        Some(false)
    } else if extension.is_empty() || (safe_inline_ext && inline) {
        None
    } else {
        Some(true)
    };
    let claims = AssetClaims {
        version: 1,
        kind: "attachment".into(),
        attachment_id: attachment_id.into(),
        workspace_root: None,
        relative_path: None,
        base_relative_path: None,
        download,
        file_name: name.map(str::to_owned),
        mime_type: if inline && matches!(extension, "html" | "htm") {
            Some("text/html".into())
        } else {
            mime.map(str::to_owned)
        },
        render_intent: (render_intent == Some("mcp-app")
            && inline
            && matches!(extension, "html" | "htm"))
        .then(|| "mcp-app".into()),
        file_path: None,
        device: None,
        inode: None,
        expires_at: now_ms.saturating_add(TOKEN_TTL_MS),
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|_| "Unable to encode asset URL")?);
    let mut mac = HmacSha256::new_from_slice(signing_key).map_err(|_| "Invalid signing key")?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let display_name = name.unwrap_or_else(|| {
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(attachment_id)
    });
    let encoded_name =
        percent_encoding::utf8_percent_encode(display_name, percent_encoding::NON_ALPHANUMERIC);
    Ok(IssuedAssetUrl {
        relative_url: format!("/api/assets/{token}/{encoded_name}"),
        expires_at: claims.expires_at,
        image_dimensions,
        file_revision: None,
    })
}

/// Issue a project favicon URL, including a stable missing-icon marker.
pub fn issue_project_favicon_url(
    root: &std::path::Path,
    state_dir: &std::path::Path,
    key: &[u8; 32],
    override_path: Option<&str>,
    now: i64,
) -> Result<IssuedAssetUrl, &'static str> {
    let root = std::fs::canonicalize(root).map_err(|_| "AssetWorkspaceRootNormalizationError")?;
    let mut candidates = Vec::new();
    if let Some(value) = override_path.filter(|s| !s.trim().is_empty()) {
        candidates.push(value.to_owned());
    }
    candidates.extend(
        [
            "favicon.svg",
            "favicon.ico",
            "favicon.png",
            "public/favicon.svg",
            "public/favicon.ico",
            "public/favicon.png",
            "app/favicon.ico",
            "app/favicon.png",
            "app/icon.svg",
            "app/icon.png",
            "app/icon.ico",
            "src/favicon.ico",
            "src/favicon.svg",
            "src/app/favicon.ico",
            "src/app/icon.svg",
            "src/app/icon.png",
            "assets/icon.svg",
            "assets/icon.png",
            "assets/logo.svg",
            "assets/logo.png",
            ".idea/icon.svg",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    for candidate in candidates {
        let path = std::path::Path::new(&candidate);
        let requested = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        if !matches!(
            extension(&requested).as_str(),
            "svg" | "ico" | "png" | "jpg" | "jpeg" | "webp" | "gif"
        ) || !requested.is_file()
        {
            continue;
        }
        let canonical =
            std::fs::canonicalize(&requested).map_err(|_| "AssetProjectFaviconInspectionError")?;
        if !canonical.starts_with(&root) && override_path != Some(candidate.as_str()) {
            continue;
        }
        return issue_media_asset_url(
            Some(&root),
            state_dir,
            key,
            &canonical.to_string_lossy(),
            false,
            now,
        );
    }
    let claims = AssetClaims {
        version: 1,
        kind: "project-favicon-missing".into(),
        attachment_id: String::new(),
        workspace_root: Some(root.to_string_lossy().into_owned()),
        relative_path: None,
        base_relative_path: None,
        download: None,
        file_name: None,
        mime_type: None,
        render_intent: None,
        file_path: None,
        device: None,
        inode: None,
        expires_at: (now.div_euclid(1_800_000) + 2).saturating_mul(1_800_000),
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|_| "AssetSigningKeyLoadError")?);
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| "AssetSigningKeyLoadError")?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    Ok(IssuedAssetUrl {
        relative_url: format!("/api/assets/{token}/project-favicon-missing"),
        expires_at: claims.expires_at,
        image_dimensions: None,
        file_revision: None,
    })
}

/// Issues a workspace preview grant. Errors are the reference RPC error tags.
pub fn issue_workspace_asset_url(
    root: &std::path::Path,
    state_dir: &std::path::Path,
    key: &[u8; 32],
    requested: &str,
    is_draft: bool,
    now: i64,
) -> Result<IssuedAssetUrl, &'static str> {
    let root = std::fs::canonicalize(root).map_err(|_| "AssetWorkspaceRootNormalizationError")?;
    let requested_path = std::path::Path::new(requested);
    let relative = if requested_path.is_absolute() {
        requested_path
            .strip_prefix(&root)
            .map_err(|_| "AssetWorkspacePathValidationError")?
    } else {
        requested_path
    };
    if !safe_relative(relative, false) {
        return Err("AssetWorkspacePathValidationError");
    }
    let ext = extension(relative);
    let entry = matches!(
        ext.as_str(),
        "html"
            | "htm"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "avif"
            | "bmp"
            | "ico"
            | "otf"
            | "ttf"
            | "woff"
            | "woff2"
            | "zip"
            | "jar"
            | "sqlite"
            | "sqlite3"
            | "db"
            | "docx"
            | "xlsx"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "epub"
            | "ipynb"
    );
    if is_draft && media_mime(&ext).is_some() {
        let canonical = std::fs::canonicalize(root.join(relative))
            .map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
        if !canonical.starts_with(&root) || crate::workspace_rpc::internal(&canonical, state_dir) {
            return Err("AssetWorkspaceAssetNotFoundError");
        }
        return issue_media_asset_url(
            Some(&root),
            state_dir,
            key,
            canonical
                .to_str()
                .ok_or("AssetWorkspaceAssetNotFoundError")?,
            false,
            now,
        );
    }
    if !entry {
        return Err("AssetPreviewTypeValidationError");
    }
    if crate::workspace_rpc::internal(&root.join(relative), state_dir) {
        return Err("AssetWorkspacePathValidationError");
    }
    let bytes =
        read_workspace_file(&root, relative).map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
    let image_dimensions = if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        crate::image_dimensions::read(&bytes)
    } else {
        None
    };
    let html = matches!(ext.as_str(), "html" | "htm");
    let rel = relative
        .to_str()
        .ok_or("AssetWorkspacePathValidationError")?;
    let name = relative
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("AssetWorkspacePathValidationError")?;
    let claims = AssetClaims {
        version: 1,
        kind: if html {
            "workspace-file"
        } else {
            "workspace-file-exact"
        }
        .into(),
        attachment_id: String::new(),
        workspace_root: Some(root.to_string_lossy().into_owned()),
        relative_path: (!html).then(|| rel.to_owned()),
        base_relative_path: html.then(|| {
            relative
                .parent()
                .and_then(|p| p.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(".")
                .to_owned()
        }),
        download: None,
        file_name: None,
        mime_type: None,
        render_intent: None,
        file_path: None,
        device: None,
        inode: None,
        expires_at: now.saturating_add(TOKEN_TTL_MS),
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|_| "AssetSigningKeyLoadError")?);
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| "AssetSigningKeyLoadError")?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let encoded = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    Ok(IssuedAssetUrl {
        relative_url: format!("/api/assets/{token}/{encoded}"),
        expires_at: claims.expires_at,
        image_dimensions,
        file_revision: None,
    })
}

fn media_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "aiff" => "audio/aiff",
        "weba" | "webm-audio" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        _ => return None,
    })
}

#[cfg(unix)]
fn file_revision(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
        i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())
    )
}
#[cfg(not(unix))]
fn file_revision(meta: &std::fs::Metadata) -> String {
    format!("{}:{:?}", meta.len(), meta.modified().ok())
}

#[cfg(unix)]
fn identity(_file: &std::fs::File, meta: &std::fs::Metadata) -> (String, String) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev().to_string(), meta.ino().to_string())
}
#[cfg(windows)]
fn identity(file: &std::fs::File, _meta: &std::fs::Metadata) -> (String, String) {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation_time: FileTime,
        access_time: FileTime,
        write_time: FileTime,
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            info: *mut ByHandleFileInformation,
        ) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return (String::new(), String::new());
    }
    let info = unsafe { info.assume_init() };
    let index = (u64::from(info.index_high) << 32) | u64::from(info.index_low);
    (info.volume_serial.to_string(), index.to_string())
}
#[cfg(not(any(unix, windows)))]
fn identity(_file: &std::fs::File, _meta: &std::fs::Metadata) -> (String, String) {
    (String::new(), String::new())
}

pub fn issue_media_asset_url(
    root: Option<&std::path::Path>,
    state_dir: &std::path::Path,
    key: &[u8; 32],
    requested: &str,
    download: bool,
    now: i64,
) -> Result<IssuedAssetUrl, &'static str> {
    let expanded = if let Some(rest) = requested.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or("AssetWorkspaceAssetNotFoundError")?)
            .join(rest)
    } else {
        PathBuf::from(requested)
    };
    #[cfg(windows)]
    {
        use std::path::Component;
        fn normalize(path: &std::path::Path) -> PathBuf {
            let mut out = PathBuf::new();
            for part in path.components() {
                match part {
                    Component::ParentDir => {
                        out.pop();
                    }
                    Component::CurDir => {}
                    other => out.push(other.as_os_str()),
                }
            }
            out
        }
        let raw = expanded.to_string_lossy();
        if raw.starts_with("\\\\") || raw.starts_with("//") {
            let Some(root) = root else {
                return Err("AssetWorkspaceAssetNotFoundError");
            };
            if !normalize(&expanded).starts_with(normalize(root)) {
                return Err("AssetWorkspaceAssetNotFoundError");
            }
        }
    }
    let path = if expanded.is_absolute() {
        expanded.clone()
    } else {
        root.ok_or("AssetWorkspaceContextNotFoundError")?
            .join(&expanded)
    };
    #[cfg(windows)]
    let network_path = expanded.to_string_lossy().starts_with("\\\\")
        || expanded.to_string_lossy().starts_with("//");
    let path = std::fs::canonicalize(path).map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
    #[cfg(windows)]
    if network_path {
        let canonical_root = std::fs::canonicalize(root.ok_or("AssetWorkspaceAssetNotFoundError")?)
            .map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
        if !path.starts_with(canonical_root) {
            return Err("AssetWorkspaceAssetNotFoundError");
        }
    }
    if crate::workspace_rpc::internal(&path, state_dir) {
        return Err("AssetWorkspacePathValidationError");
    }
    issue_exact_asset_url(&path, key, download, now, "media-file-exact")
}

pub(crate) fn issue_theme_background_url(
    path: &std::path::Path,
    key: &[u8; 32],
    now: i64,
) -> Result<IssuedAssetUrl, &'static str> {
    if !matches!(extension(path).as_str(), "webp" | "png" | "jpg" | "jpeg")
        || std::fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err("AssetWorkspaceAssetNotFoundError");
    }
    issue_exact_asset_url(path, key, false, now, "environment-theme-background")
}

fn issue_exact_asset_url(
    path: &std::path::Path,
    key: &[u8; 32],
    download: bool,
    now: i64,
    kind: &str,
) -> Result<IssuedAssetUrl, &'static str> {
    if !download && media_mime(&extension(&path)).is_none() {
        return Err("AssetPreviewTypeValidationError");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
    let meta = file
        .metadata()
        .map_err(|_| "AssetWorkspaceAssetNotFoundError")?;
    if !meta.is_file()
        || (kind == "environment-theme-background"
            && meta.len() > crate::environment_theme::MAX_THEME_BACKGROUND_BYTES)
    {
        return Err("AssetWorkspaceAssetNotFoundError");
    }
    let (device, inode) = identity(&file, &meta);
    if device.is_empty() || inode.is_empty() {
        return Err("AssetWorkspaceAssetNotFoundError");
    }
    let name = path
        .file_name()
        .and_then(|x| x.to_str())
        .ok_or("AssetWorkspacePathValidationError")?;
    let revision = file_revision(&meta);
    let dimensions = if matches!(
        extension(&path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp"
    ) {
        {
            let mut b = Vec::new();
            file.by_ref()
                .take(1024 * 1024)
                .read_to_end(&mut b)
                .ok()
                .and_then(|_| crate::image_dimensions::read(&b))
        }
    } else {
        None
    };
    let claims = AssetClaims {
        version: 1,
        kind: kind.into(),
        attachment_id: String::new(),
        workspace_root: None,
        relative_path: None,
        base_relative_path: None,
        download: download.then_some(true),
        file_name: None,
        mime_type: None,
        render_intent: None,
        file_path: Some(path.to_string_lossy().into_owned()),
        device: Some(device),
        inode: Some(inode),
        expires_at: now.saturating_add(TOKEN_TTL_MS),
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|_| "AssetSigningKeyLoadError")?);
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| "AssetSigningKeyLoadError")?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    Ok(IssuedAssetUrl {
        relative_url: format!(
            "/api/assets/{token}/{}",
            percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC)
        ),
        expires_at: claims.expires_at,
        image_dimensions: dimensions,
        file_revision: Some(revision),
    })
}

async fn get_media_asset(
    claims: &AssetClaims,
    name: &str,
    headers: &HeaderMap,
    method: &Method,
) -> Response {
    let Some(path) = claims.file_path.as_deref().map(PathBuf::from) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path.file_name().and_then(|x| x.to_str()) != Some(name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let file_path = path.clone();
    let expected_dev = claims.device.clone().unwrap_or_default();
    let expected_ino = claims.inode.clone().unwrap_or_default();
    let theme_background = claims.kind == "environment-theme-background";
    let opened = tokio::task::spawn_blocking(move || -> io::Result<(std::fs::File, u64)> {
        if std::fs::canonicalize(&file_path)? != file_path {
            return Err(io::Error::other("path changed"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(&file_path)?;
        let meta = file.metadata()?;
        if !meta.is_file()
            || identity(&file, &meta) != (expected_dev, expected_ino)
            || (theme_background && meta.len() > crate::environment_theme::MAX_THEME_BACKGROUND_BYTES)
        {
            return Err(io::Error::other("file changed"));
        }
        Ok((file, meta.len()))
    })
    .await;
    let Ok(Ok((file, total))) = opened else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut file = tokio::fs::File::from_std(file);
    let mut status = StatusCode::OK;
    let mut content_range = None;
    let range = if method == Method::GET && !headers.contains_key(header::IF_RANGE) {
        headers
            .get(header::RANGE)
            .and_then(|x| x.to_str().ok())
            .and_then(|value| parse_byte_range(value, total))
    } else {
        None
    };
    let (start, length) = match range {
        Some(Err(())) => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
            );
            response
                .headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return response;
        }
        Some(Ok((start, end))) => {
            status = StatusCode::PARTIAL_CONTENT;
            content_range = Some(format!("bytes {start}-{end}/{total}"));
            (start, end - start + 1)
        }
        None => (0, total),
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let stream =
        futures_util::stream::try_unfold((file, length), |(mut file, remaining)| async move {
            if remaining == 0 {
                return Ok::<_, io::Error>(None);
            }
            let mut buffer = vec![0; remaining.min(64 * 1024) as usize];
            let n = file.read(&mut buffer).await?;
            if n == 0 {
                return Ok(None);
            }
            buffer.truncate(n);
            Ok(Some((buffer, (file, remaining - n as u64))))
        });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    let h = response.headers_mut();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).unwrap(),
    );
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if claims.download.unwrap_or(false) {
            "application/octet-stream"
        } else {
            media_mime(&extension(&path)).unwrap_or("application/octet-stream")
        }),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(
            if media_mime(&extension(&path))
                .is_some_and(|mime| mime.starts_with("audio/") || mime.starts_with("video/"))
                && !claims.download.unwrap_or(false)
            {
                "private, no-store"
            } else {
                "private, max-age=3600"
            },
        ),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if let Some(value) = content_range {
        h.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&value).unwrap(),
        );
    }
    if claims.download.unwrap_or(false) {
        h.insert(header::CONTENT_DISPOSITION, content_disposition(name));
        h.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; sandbox"),
        );
    } else if matches!(extension(&path).as_str(), "html" | "htm" | "svg") {
        h.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    response
}

// None means an invalid Range header, which is ignored. Err indicates a valid
// range that cannot select bytes from this representation.
fn parse_byte_range(value: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let (unit, spec) = value.trim().split_once('=')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    if (first.is_empty() && last.is_empty())
        || !first.bytes().all(|b| b.is_ascii_digit())
        || !last.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    // Saturation preserves the ordering and clamping behavior for very large numbers.
    let number = |s: &str| {
        s.bytes().fold(0u128, |n, b| {
            n.saturating_mul(10).saturating_add(u128::from(b - b'0'))
        })
    };
    let first = (!first.is_empty()).then(|| number(first));
    let last = (!last.is_empty()).then(|| number(last));
    if matches!((first, last), (Some(a), Some(b)) if b < a) {
        return None;
    }
    let size = u128::from(total);
    if total == 0 || first.is_some_and(|n| n >= size) || (first.is_none() && last == Some(0)) {
        return Some(Err(()));
    }
    let start = first.unwrap_or_else(|| size.saturating_sub(last.unwrap()));
    let end = if first.is_none() {
        size - 1
    } else {
        last.unwrap_or(size - 1).min(size - 1)
    };
    // The reference only serves ranges representable as JavaScript safe integers.
    if start > 9_007_199_254_740_991 || end > 9_007_199_254_740_991 {
        return Some(Err(()));
    }
    Some(Ok((start as u64, end as u64)))
}

fn extension(path: &std::path::Path) -> String {
    path.extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn safe_relative(path: &std::path::Path, reject_hidden: bool) -> bool {
    use std::path::Component;
    !path.as_os_str().is_empty()
        && path.components().all(|c| match c {
            Component::Normal(s) => !reject_hidden || !s.to_string_lossy().starts_with('.'),
            _ => false,
        })
}

async fn get_workspace_asset(
    claims: &AssetClaims,
    name: &str,
    state_dir: &std::path::Path,
    request_headers: &HeaderMap,
    method: &Method,
) -> Response {
    let Some(root) = claims.workspace_root.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let relative = if claims.kind == "workspace-file-exact" {
        let Some(path) = claims.relative_path.as_deref() else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            != Some(name)
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        PathBuf::from(path)
    } else {
        let path = std::path::Path::new(name);
        if name.contains('\\')
            || !safe_relative(path, true)
            || !matches!(
                extension(path).as_str(),
                "htm"
                    | "html"
                    | "pdf"
                    | "avif"
                    | "gif"
                    | "ico"
                    | "jpeg"
                    | "jpg"
                    | "png"
                    | "svg"
                    | "webp"
                    | "css"
                    | "js"
                    | "mjs"
                    | "otf"
                    | "ttf"
                    | "woff"
                    | "woff2"
            )
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        let base = claims.base_relative_path.as_deref().unwrap_or("");
        if base == "." {
            path.to_owned()
        } else {
            std::path::Path::new(base).join(path)
        }
    };
    if !safe_relative(&relative, false) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = PathBuf::from(root);
    if crate::workspace_rpc::internal(&root.join(&relative), state_dir) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = relative.clone();
    let Ok(bytes) = tokio::task::spawn_blocking(move || read_workspace_file(&root, &path))
        .await
        .unwrap_or_else(|_| Err(io::Error::other("read failed")))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = extension(&relative);
    let mime = mime_guess::from_path(&relative)
        .first_or_octet_stream()
        .to_string();
    let total = bytes.len();
    let range = if *method == Method::GET && !request_headers.contains_key(header::IF_RANGE) {
        request_headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| parse_byte_range(v, total as u64))
    } else {
        None
    };
    let (status, start, end) = match range {
        Some(Err(())) => (StatusCode::RANGE_NOT_SATISFIABLE, 0, 0),
        Some(Ok((start, end))) => (
            StatusCode::PARTIAL_CONTENT,
            start as usize,
            end as usize + 1,
        ),
        None => (StatusCode::OK, 0, total),
    };
    let mut response = Response::new(
        if *method == Method::HEAD || status == StatusCode::RANGE_NOT_SATISFIABLE {
            Body::empty()
        } else {
            Body::from(bytes[start..end].to_vec())
        },
    );
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
        );
    } else {
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(end - start).to_string()).unwrap(),
        );
        if status == StatusCode::PARTIAL_CONTENT {
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{}/{total}", end - 1)).unwrap(),
            );
        }
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if matches!(ext.as_str(), "html" | "htm" | "svg") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(if ext == "svg" {
                "default-src 'none'; style-src 'unsafe-inline'; sandbox"
            } else {
                "sandbox allow-scripts allow-forms allow-popups allow-downloads"
            }),
        );
    }
    response
}

#[cfg(unix)]
fn read_workspace_file(root: &std::path::Path, relative: &std::path::Path) -> io::Result<Vec<u8>> {
    read_workspace_file_checked(root, relative, None)
}
#[cfg(unix)]
fn read_workspace_file_checked(
    root: &std::path::Path,
    relative: &std::path::Path,
    expected: Option<(&str, &str)>,
) -> io::Result<Vec<u8>> {
    use std::ffi::CString;
    use std::os::unix::{
        ffi::OsStrExt,
        io::{AsRawFd, FromRawFd},
    };
    if !safe_relative(relative, false) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid path",
        ));
    }
    let root =
        CString::new(root.as_os_str().as_bytes()).map_err(|_| io::Error::other("invalid root"))?;
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut dir = unsafe { std::fs::File::from_raw_fd(fd) };
    let parts: Vec<_> = relative.components().collect();
    for (i, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_os_str().as_bytes())
            .map_err(|_| io::Error::other("invalid path"))?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                libc::O_NONBLOCK
            };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        dir = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    let meta = dir.metadata()?;
    let (dev, ino) = identity(&dir, &meta);
    if expected.is_some_and(|id| id != (dev.as_str(), ino.as_str())) {
        return Err(io::Error::other("file changed"));
    }
    if !meta.is_file() || meta.len() > 100 * 1024 * 1024 {
        return Err(io::Error::other("invalid file"));
    }
    let mut bytes = Vec::new();
    dir.take(100 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(io::Error::other("file too large"));
    }
    Ok(bytes)
}
#[cfg(windows)]
fn read_workspace_file(root: &std::path::Path, relative: &std::path::Path) -> io::Result<Vec<u8>> {
    use std::ffi::c_void;
    use std::os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    };
    use std::ptr;

    // NtCreateFile supports opening one name relative to an already opened
    // directory. Win32 CreateFile does not provide this race-free primitive.
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root: *mut c_void,
        name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_qos: *mut c_void,
    }
    #[repr(C)]
    struct IoStatusBlock {
        status: usize,
        information: usize,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            handle: *mut *mut c_void,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatusBlock,
            allocation_size: *const i64,
            file_attributes: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea_buffer: *const c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            path: *mut u16,
            size: u32,
            flags: u32,
        ) -> u32;
    }
    const REPARSE: u32 = 0x400;
    const BACKUP_SEMANTICS: u32 = 0x02000000;
    const OPEN_REPARSE_POINT: u32 = 0x00200000;
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    if !safe_relative(relative, false) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid path",
        ));
    }
    let mut dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(root)?;
    let meta = dir.metadata()?;
    if !meta.is_dir() || meta.file_attributes() & REPARSE != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid workspace root",
        ));
    }
    // The signed root was canonicalized at grant time. Check the identity of
    // the opened root by its handle, so a swapped ancestor cannot redirect it.
    let mut final_path = vec![0u16; 32768];
    let len = unsafe {
        GetFinalPathNameByHandleW(
            dir.as_raw_handle().cast(),
            final_path.as_mut_ptr(),
            final_path.len() as u32,
            0,
        )
    } as usize;
    if len == 0 || len >= final_path.len() {
        return Err(io::Error::last_os_error());
    }
    let actual =
        String::from_utf16(&final_path[..len]).map_err(|_| io::Error::other("invalid root"))?;
    let expected = root
        .to_str()
        .ok_or_else(|| io::Error::other("invalid root"))?;
    if !actual
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(expected.trim_end_matches('\\'))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "workspace root changed",
        ));
    }
    let parts: Vec<_> = relative.components().collect();
    for (i, part) in parts.iter().enumerate() {
        let mut name: Vec<u16> = part.as_os_str().encode_wide().collect();
        // Reject alternate data streams as well as invalid counted strings.
        if name.is_empty()
            || name.contains(&(b':' as u16))
            || name.contains(&0)
            || name.len() > u16::MAX as usize / 2
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid path",
            ));
        }
        let mut unicode = UnicodeString {
            length: (name.len() * 2) as u16,
            maximum_length: (name.len() * 2) as u16,
            buffer: name.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: dir.as_raw_handle().cast(),
            name: &mut unicode,
            attributes: 0x40,
            security_descriptor: ptr::null_mut(),
            security_qos: ptr::null_mut(),
        };
        let mut status = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let mut handle = ptr::null_mut();
        let last = i + 1 == parts.len();
        // FILE_OPEN_REPARSE_POINT opens the link itself rather than its target.
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                0x80000000 | 0x00100000,
                &mut attributes,
                &mut status,
                ptr::null(),
                0,
                7,
                1,
                OPEN_REPARSE_POINT | 0x20 | if last { 0x40 } else { 0x1 },
                ptr::null(),
                0,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(result) } as i32,
            ));
        }
        let file = unsafe { std::fs::File::from_raw_handle(handle.cast()) };
        let meta = file.metadata()?;
        if meta.file_attributes() & REPARSE != 0
            || if last {
                !meta.is_file()
            } else {
                !meta.is_dir()
            }
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid workspace path",
            ));
        }
        dir = file;
    }
    if dir.metadata()?.len() > MAX_BYTES {
        return Err(io::Error::other("file too large"));
    }
    let mut bytes = Vec::new();
    dir.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io::Error::other("file too large"));
    }
    Ok(bytes)
}
#[cfg(not(any(unix, windows)))]
fn read_workspace_file(
    _root: &std::path::Path,
    _relative: &std::path::Path,
) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure workspace asset access unavailable",
    ))
}

fn valid_mime(mime: &str) -> bool {
    let bare = mime.split(';').next().unwrap_or("").trim();
    let Some((major, minor)) = bare.split_once('/') else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && bare
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-/".contains(&b))
}

pub fn router(state: Arc<AssetState>) -> Router {
    Router::new()
        .route("/api/assets/{token}/{*name}", get(get_asset))
        .with_state(state)
}

async fn get_asset(
    State(state): State<Arc<AssetState>>,
    Path((token, name)): Path<(String, String)>,
    request_headers: HeaderMap,
    method: Method,
) -> Response {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX);
    let Some(claims) = verify(&state.signing_key, &token, now) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if claims.kind == "project-favicon-missing" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if matches!(claims.kind.as_str(), "media-file-exact" | "environment-theme-background") {
        return get_media_asset(&claims, &name, &request_headers, &method).await;
    }
    if claims.kind == "workspace-file" || claims.kind == "workspace-file-exact" {
        return get_workspace_asset(
            &claims,
            &name,
            &state.state_directory,
            &request_headers,
            &method,
        )
        .await;
    }
    let Some(path) = crate::attachment_paths::find_by_id(&state.directory, &claims.attachment_id)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Open with O_NOFOLLOW where available to close the symlink-swap race between
    // checking the canonical path and reading its bytes.
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mcp_preview = claims.render_intent.as_deref() == Some("mcp-app")
        && !claims.download.unwrap_or(false)
        && matches!(ext.as_str(), "html" | "htm");
    let directory = state.directory.clone();
    let read_path = path.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        read_attachment_file_bounded(
            &directory,
            &read_path,
            if mcp_preview {
                5 * 1024 * 1024 + 128 * 1024
            } else {
                100 * 1024 * 1024
            },
        )
    })
    .await
    .unwrap_or_else(|_| Err(io::Error::other("attachment read task failed")));
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) if mcp_preview && error.kind() == io::ErrorKind::FileTooLarge => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "MCP app is too large to preview.",
            )
                .into_response();
        }
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = claims
        .mime_type
        .as_deref()
        .and_then(|m| m.split(';').next())
        .map(str::trim)
        .filter(|m| {
            !matches!(*m, "text/html" | "image/svg+xml")
                || matches!(ext.as_str(), "html" | "htm" | "svg")
        })
        .map(str::to_owned)
        .or_else(|| mime_guess::from_path(&path).first().map(|m| m.to_string()))
        .unwrap_or_else(|| "application/octet-stream".into());
    let download = claims.download.unwrap_or(false);
    if mcp_preview {
        let html = crate::mcp_app_html::inject(&String::from_utf8_lossy(&bytes));
        let length = html.len();
        let mut response = Response::new(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(html)
        });
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&length.to_string()).unwrap(),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=3600"),
        );
        headers.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "sandbox allow-scripts allow-forms allow-popups allow-downloads",
            ),
        );
        return response;
    }
    let filename = claims
        .file_name
        .as_deref()
        .or_else(|| path.file_name().and_then(|n| n.to_str()))
        .unwrap_or("attachment");
    let total = bytes.len() as u64;
    let range = if method == Method::GET && !request_headers.contains_key(header::IF_RANGE) {
        request_headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| parse_byte_range(v, total))
    } else {
        None
    };
    let (status, start, end) = match range {
        Some(Err(())) => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
            );
            response
                .headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return response;
        }
        Some(Ok((start, end))) => (
            StatusCode::PARTIAL_CONTENT,
            start as usize,
            end as usize + 1,
        ),
        None => (StatusCode::OK, 0, bytes.len()),
    };
    let mut response = Response::new(if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes[start..end].to_vec())
    });
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&(end - start).to_string()).unwrap(),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{}/{total}", end - 1)).unwrap(),
        );
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(
            if mime.starts_with("video/") || mime.starts_with("audio/") {
                "private, no-store"
            } else {
                "private, max-age=3600"
            },
        ),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if download {
        headers.insert(header::CONTENT_DISPOSITION, content_disposition(filename));
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; sandbox"),
        );
    } else if matches!(ext.as_str(), "html" | "htm") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "sandbox allow-scripts allow-forms allow-popups allow-downloads",
            ),
        );
    } else if ext == "svg" {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    response
}

fn read_attachment_file(
    directory: &std::path::Path,
    path: &std::path::Path,
) -> io::Result<Vec<u8>> {
    read_attachment_file_bounded(directory, path, 100 * 1024 * 1024)
}

fn read_attachment_file_bounded(
    directory: &std::path::Path,
    path: &std::path::Path,
    max_bytes: u64,
) -> io::Result<Vec<u8>> {
    let root = std::fs::canonicalize(directory)?;
    let link_meta = std::fs::symlink_metadata(path)?;
    let canonical = std::fs::canonicalize(path)?;
    if link_meta.file_type().is_symlink() || canonical.parent() != Some(root.as_path()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "attachment escapes its store",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid attachment file",
        ));
    }
    if meta.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "attachment too large",
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "attachment too large",
        ));
    }
    Ok(bytes)
}

fn content_disposition(name: &str) -> HeaderValue {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '"' | '\\') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let fallback: String = safe
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded = percent_encoding::utf8_percent_encode(&safe, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let value = format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}");
    HeaderValue::from_str(&value).unwrap_or(HeaderValue::from_static("attachment"))
}

fn verify(key: &[u8; 32], token: &str, now_ms: i64) -> Option<AssetClaims> {
    let (payload, signature) = token.split_once('.')?;
    if payload.is_empty() || signature.is_empty() || signature.contains('.') {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig).ok()?;
    let claims: AssetClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if claims.version != 1
        || claims.expires_at <= now_ms
        || !match claims.kind.as_str() {
            "attachment" => crate::attachment_paths::parse_id(&claims.attachment_id).is_some(),
            "project-favicon-missing" => claims.workspace_root.is_some(),
            "workspace-file" => {
                claims.workspace_root.is_some() && claims.base_relative_path.is_some()
            }
            "media-file-exact" | "environment-theme-background" => {
                claims.file_path.is_some() && claims.device.is_some() && claims.inode.is_some()
            }
            "workspace-file-exact" => {
                claims.workspace_root.is_some() && claims.relative_path.is_some()
            }
            _ => false,
        }
    {
        return None;
    }
    Some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("t3-asset-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn theme_background_url_streams_the_image_and_rechecks_size() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let path = dir.join("night.png");
        std::fs::write(&path, b"sample").unwrap();
        let key = [7; 32];
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let issued = issue_theme_background_url(&path, &key, now).unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.clone(),
            signing_key: key,
        }));
        let request = || Request::builder().uri(&issued.relative_url).body(Body::empty()).unwrap();
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap().as_ref(), b"sample");
        std::fs::OpenOptions::new().write(true).open(&path).unwrap()
            .set_len(crate::environment_theme::MAX_THEME_BACKGROUND_BYTES + 1).unwrap();
        assert_eq!(app.oneshot(request()).await.unwrap().status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn missing_project_favicon_has_stable_marker_and_safe_404() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let key = [7u8; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued = issue_project_favicon_url(&dir, &dir.join("state"), &key, None, now).unwrap();
        assert!(issued.relative_url.ends_with("/project-favicon-missing"));
        let app = router(Arc::new(AssetState {
            directory: dir.join("attachments"),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        let response = app
            .oneshot(
                Request::builder()
                    .uri(&issued.relative_url)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn oversized_mcp_preview_is_rejected_before_reading() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", Some("html")).unwrap();
        let path = dir.join(format!("{id}.html"));
        std::fs::write(&path, "<html></html>").unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let key = [19; 32];
        let issued = issue_attachment_asset_url(
            &dir,
            &key,
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: Some("app.html"),
                mime_type: Some("text/html"),
                inline: true,
                render_intent: Some("mcp-app"),
            },
            now,
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(5 * 1024 * 1024 + 128 * 1024 + 1)
            .unwrap();
        let state = Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        });
        for method in [Method::GET, Method::HEAD] {
            let response = router(state.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(&issued.relative_url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn mcp_app_inline_preserves_csp_and_injects_sandbox_bootstraps() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", Some("html")).unwrap();
        let html = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><body>app</body>";
        std::fs::write(dir.join(format!("{id}.html")), html).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let key = [17; 32];
        let issued = issue_attachment_asset_url(
            &dir,
            &key,
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: Some("app.html"),
                mime_type: Some("text/html"),
                inline: true,
                render_intent: Some("mcp-app"),
            },
            now,
        )
        .unwrap();
        let state = Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        });
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri(&issued.relative_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(
            csp.contains("sandbox")
                && csp.contains("allow-scripts")
                && !csp.contains("allow-same-origin")
        );
        let body = to_bytes(response.into_body(), 10000).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(
            text.find("Content-Security-Policy").unwrap() < text.find("document.cookie").unwrap()
        );
        assert!(text.contains("ui/notifications/host-context-changed"));
        assert!(text.contains("event.source !== window.parent"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn signed_get_serves_attachment_safely_and_rejects_tampering() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", Some("pdf")).unwrap();
        std::fs::write(dir.join(format!("{id}.pdf")), b"pdf bytes").unwrap();
        let key = [9u8; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued = issue_attachment_asset_url(
            &dir,
            &key,
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: Some("study guide.pdf"),
                mime_type: Some("application/pdf"),
                inline: false,
                render_intent: None,
            },
            now,
        )
        .unwrap();
        assert!(issued.relative_url.starts_with("/api/assets/"));
        let state = Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        });
        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&issued.relative_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
        assert!(response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("study guide.pdf"));
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "pdf bytes"
        );
        let pieces = issued.relative_url.splitn(4, '/').collect::<Vec<_>>();
        let token = pieces[3].split('/').next().unwrap();
        let bad_token = format!(
            "{}{}",
            if token.starts_with('a') { "b" } else { "a" },
            &token[1..]
        );
        let tampered = issued.relative_url.replacen(token, &bad_token, 1);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(tampered)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_grants_limit_paths_and_reject_symlink_replacement() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("web")).unwrap();
        std::fs::write(dir.join("web/page.html"), b"page").unwrap();
        std::fs::write(dir.join("web/style.css"), b"style").unwrap();
        std::fs::write(dir.join("web/image.png"), b"image").unwrap();
        std::fs::create_dir_all(dir.join("state/secrets")).unwrap();
        std::fs::write(dir.join("state/page.html"), b"page").unwrap();
        std::fs::write(dir.join("state/secrets/key.png"), b"secret").unwrap();
        std::fs::write(dir.join("state/private.sqlite"), b"secret").unwrap();
        let outside = dir.with_extension("secret");
        std::fs::write(&outside, b"secret").unwrap();
        let key = [7; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let html =
            issue_workspace_asset_url(&dir, &dir.join("state"), &key, "web/page.html", false, now)
                .unwrap();
        let exact =
            issue_workspace_asset_url(&dir, &dir.join("state"), &key, "web/image.png", false, now)
                .unwrap();
        assert_eq!(
            issue_workspace_asset_url(&dir, &dir.join("state"), &key, "../secret.png", false, now)
                .unwrap_err(),
            "AssetWorkspacePathValidationError"
        );
        assert_eq!(
            issue_workspace_asset_url(
                &dir,
                &dir.join("state"),
                &key,
                "state/private.sqlite",
                false,
                now
            )
            .unwrap_err(),
            "AssetWorkspacePathValidationError"
        );
        let state_html = issue_workspace_asset_url(
            &dir,
            &dir.join("state"),
            &key,
            "state/page.html",
            false,
            now,
        )
        .unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        let fetch = |url: String| {
            app.clone()
                .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
        };
        assert_eq!(
            fetch(
                state_html
                    .relative_url
                    .replace("page%2Ehtml", "secrets/key.png")
            )
            .await
            .unwrap()
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fetch(html.relative_url.replace("page%2Ehtml", "style.css"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fetch(exact.relative_url.replace("image%2Epng", "style.css"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_file(dir.join("web/image.png")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("web/image.png")).unwrap();
        assert_eq!(
            fetch(exact.relative_url).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_file(outside).unwrap();
    }

    #[tokio::test]
    async fn workspace_ranges_and_head_preserve_preview_headers() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("page.html"), b"0123456789").unwrap();
        let key = [8; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued =
            issue_workspace_asset_url(&dir, &dir.join("state"), &key, "page.html", false, now)
                .unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        for (method, range, if_range, status, body, content_range, length) in [
            (
                "GET",
                "bytes=2-5",
                false,
                206,
                "2345",
                Some("bytes 2-5/10"),
                Some("4"),
            ),
            (
                "GET",
                "bytes=-3",
                false,
                206,
                "789",
                Some("bytes 7-9/10"),
                Some("3"),
            ),
            (
                "GET",
                "bytes=99-",
                false,
                416,
                "",
                Some("bytes */10"),
                Some("0"),
            ),
            (
                "GET",
                "bytes=2-5",
                true,
                200,
                "0123456789",
                None,
                Some("10"),
            ),
            ("HEAD", "bytes=2-5", false, 200, "", None, Some("10")),
        ] {
            let mut request = Request::builder()
                .method(method)
                .uri(&issued.relative_url)
                .header(header::RANGE, range);
            if if_range {
                request = request.header(header::IF_RANGE, "anything");
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok()),
                content_range
            );
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok()),
                length
            );
            assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
            assert!(response.headers().contains_key("content-security-policy"));
            assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), body);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn media_range_and_replaced_identity() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp4");
        std::fs::write(&path, b"0123456789").unwrap();
        let key = [7; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued =
            issue_media_asset_url(Some(&dir), &dir.join("state"), &key, "clip.mp4", false, now)
                .unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&issued.relative_url)
                    .header(header::RANGE, "bytes=2-5")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), "2345");
        std::fs::rename(&path, dir.join("old.mp4")).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .uri(&issued.relative_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn attachment_video_supports_ranges_and_head() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", Some("mp4")).unwrap();
        std::fs::write(dir.join(format!("{id}.mp4")), b"0123456789").unwrap();
        let key = [7; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued = issue_attachment_asset_url(
            &dir,
            &key,
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: None,
                mime_type: Some("video/mp4"),
                inline: false,
                render_intent: None,
            },
            now,
        )
        .unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        for (method, range, if_range, status, body, content_range) in [
            ("GET", "bytes=2-5", false, 206, "2345", Some("bytes 2-5/10")),
            ("GET", "bytes=10-", false, 416, "", Some("bytes */10")),
            ("GET", "bytes=2-5", true, 200, "0123456789", None),
            ("HEAD", "bytes=2-5", false, 200, "", None),
        ] {
            let mut request = Request::builder()
                .method(method)
                .uri(&issued.relative_url)
                .header(header::RANGE, range);
            if if_range {
                request = request.header(header::IF_RANGE, "stale");
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .map(|v| v.to_str().unwrap()),
                content_range
            );
            if status != 416 {
                assert_eq!(
                    response.headers()[header::CACHE_CONTROL],
                    "private, no-store"
                );
            }
            assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), body);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn media_range_headers_match_http_semantics() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.mp4"), b"0123456789").unwrap();
        let key = [8; 32];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let issued =
            issue_media_asset_url(Some(&dir), &dir.join("state"), &key, "clip.mp4", false, now)
                .unwrap();
        let app = router(Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        }));
        for (method, range, if_range, status, body, content_range) in [
            ("GET", "bytes=-3", false, 206, "789", Some("bytes 7-9/10")),
            ("GET", "BYTES=8-99", false, 206, "89", Some("bytes 8-9/10")),
            ("GET", "bytes=10-", false, 416, "", Some("bytes */10")),
            ("GET", "bytes=4-2", false, 200, "0123456789", None),
            ("GET", "bytes=0-1,3-4", false, 200, "0123456789", None),
            ("GET", "bytes=0-1", true, 200, "0123456789", None),
            ("HEAD", "bytes=0-1", false, 200, "", None),
        ] {
            let mut req = Request::builder()
                .method(method)
                .uri(&issued.relative_url)
                .header(header::RANGE, range);
            if if_range {
                req = req.header(header::IF_RANGE, "stale");
            }
            let response = app
                .clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status, "{method} {range}");
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .map(|v| v.to_str().unwrap()),
                content_range
            );
            assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), body);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn workspace_reads_reject_reparse_points_and_alternate_streams() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let dir = temp();
        let outside = dir.with_extension("outside");
        std::fs::create_dir_all(dir.join("web")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(dir.join("web/page.html"), b"page").unwrap();
        std::fs::write(outside.join("secret.html"), b"secret").unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(
            read_workspace_file(&root, std::path::Path::new("web/page.html")).unwrap(),
            b"page"
        );
        assert!(read_workspace_file(&root, std::path::Path::new("web/page.html:secret")).is_err());
        // Symlink creation may require Developer Mode or elevated privileges.
        if symlink_file(outside.join("secret.html"), dir.join("web/link.html")).is_ok() {
            assert!(read_workspace_file(&root, std::path::Path::new("web/link.html")).is_err());
        }
        if symlink_dir(&outside, dir.join("link")).is_ok() {
            assert!(read_workspace_file(&root, std::path::Path::new("link/secret.html")).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn image_grants_include_dimensions_when_image_header_is_available() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let mut png = vec![0; 24];
        png[..4].copy_from_slice(b"\x89PNG");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&640u32.to_be_bytes());
        png[20..24].copy_from_slice(&480u32.to_be_bytes());
        let id = crate::attachment_paths::attachment_id("thread", None).unwrap();
        std::fs::write(dir.join(format!("{id}.png")), &png).unwrap();
        std::fs::write(dir.join("image.png"), &png).unwrap();
        let expected = Some(crate::image_dimensions::Dimensions {
            width: 640,
            height: 480,
        });
        let attachment = issue_attachment_asset_url(
            &dir,
            &[1; 32],
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: None,
                mime_type: None,
                inline: false,
                render_intent: None,
            },
            0,
        )
        .unwrap();
        assert_eq!(attachment.image_dimensions, expected);
        let workspace =
            issue_workspace_asset_url(&dir, &dir.join("state"), &[1; 32], "image.png", false, 0)
                .unwrap();
        assert_eq!(workspace.image_dimensions, expected);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_pending_ids_and_missing_files() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(issue_attachment_asset_url(
            &dir,
            &[1; 32],
            AttachmentAssetRequest {
                attachment_id: "../escape",
                file_name: None,
                mime_type: None,
                inline: false,
                render_intent: None
            },
            0
        )
        .is_err());
        let id = crate::attachment_paths::attachment_id("thread", Some("pdf")).unwrap();
        assert!(issue_attachment_asset_url(
            &dir,
            &[1; 32],
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: None,
                mime_type: None,
                inline: false,
                render_intent: Some("mcp-app")
            },
            0
        )
        .is_err());
        assert!(issue_attachment_asset_url(
            &dir,
            &[1; 32],
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: None,
                mime_type: None,
                inline: false,
                render_intent: None
            },
            0
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_ids_without_file_extensions_default_to_inline() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", None).unwrap();
        std::fs::write(dir.join(format!("{id}.png")), b"png").unwrap();
        let issued = issue_attachment_asset_url(
            &dir,
            &[1; 32],
            AttachmentAssetRequest {
                attachment_id: &id,
                file_name: Some("image.png"),
                mime_type: Some("image/png"),
                inline: false,
                render_intent: None,
            },
            0,
        )
        .unwrap();
        let token = issued.relative_url.split('/').nth(3).unwrap();
        let payload = token.split('.').next().unwrap();
        let claims: AssetClaims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(claims.download, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn rejects_expired_assets_and_symlink_escape() {
        let dir = temp();
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", Some("txt")).unwrap();
        let outside = dir.with_extension("outside");
        std::fs::write(&outside, b"secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join(format!("{id}.txt"))).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, dir.join(format!("{id}.txt"))).unwrap();
        let key = [4u8; 32];
        let state = Arc::new(AssetState {
            directory: dir.clone(),
            state_directory: dir.join("state"),
            signing_key: key,
        });
        let token_for = |expires_at| {
            let payload = URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&AssetClaims {
                    version: 1,
                    kind: "attachment".into(),
                    attachment_id: id.clone(),
                    workspace_root: None,
                    relative_path: None,
                    base_relative_path: None,
                    download: Some(true),
                    file_name: None,
                    mime_type: None,
                    render_intent: None,
                    file_path: None,
                    device: None,
                    inode: None,
                    expires_at,
                })
                .unwrap(),
            );
            let mut mac = HmacSha256::new_from_slice(&key).unwrap();
            mac.update(payload.as_bytes());
            format!(
                "{payload}.{}",
                URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
            )
        };
        let expired_url = format!("/api/assets/{}/x.txt", token_for(1));
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri(expired_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let current_url = format!("/api/assets/{}/x.txt", token_for(i64::MAX));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri(current_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(dir);
    }
}
