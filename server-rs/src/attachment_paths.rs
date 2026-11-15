//! Attachment identifiers and extension rules shared by upload and claim flows.
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const IMAGE_EXTENSIONS: &[&str] = &[
    "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tiff", "webp",
];

pub fn safe_thread_segment(thread_id: &str) -> Option<String> {
    let mut out = String::new();
    let mut dash = false;
    for c in thread_id.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.trim_matches(['-', '_']);
    let bounded = &trimmed[..trimmed.len().min(80)];
    let bounded = bounded.trim_end_matches(['-', '_']);
    if bounded.is_empty() {
        None
    } else if bounded == "pending" {
        Some("_pending".into())
    } else {
        Some(bounded.into())
    }
}
fn extension_suffix(ext: Option<&str>) -> String {
    let Some(ext) = ext.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let ext = ext.strip_prefix('.').unwrap_or(ext).to_ascii_lowercase();
    if (1..=10).contains(&ext.len())
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        format!("-{ext}")
    } else {
        "-bin".into()
    }
}
pub fn pending_id(ext: Option<&str>) -> String {
    format!("pending-{}{}", uuid::Uuid::new_v4(), extension_suffix(ext))
}
pub fn attachment_id(thread_id: &str, ext: Option<&str>) -> Option<String> {
    Some(format!(
        "{}-{}{}",
        safe_thread_segment(thread_id)?,
        uuid::Uuid::new_v4(),
        extension_suffix(ext)
    ))
}
pub fn deterministic_id(thread_id: &str, stable_key: &str) -> Option<String> {
    let input = serde_json::to_vec(&[thread_id, stable_key]).ok()?;
    let digest = format!("{:x}", Sha256::digest(input));
    Some(format!(
        "{}-{}-{}-{}-{}-{}",
        safe_thread_segment(thread_id)?,
        &digest[0..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    ))
}
#[derive(Debug, PartialEq, Eq)]
pub struct ParsedId {
    pub thread_segment: String,
    pub uuid: String,
    pub extension: Option<String>,
}
pub fn parse_id(value: &str) -> Option<ParsedId> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^([a-z0-9_]+(?:-[a-z0-9_]+)*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([a-z0-9]{1,10}))?$").unwrap());
    let captures = pattern.captures(value)?;
    Some(ParsedId {
        thread_segment: captures[1].to_ascii_lowercase(),
        uuid: captures[2].to_ascii_lowercase(),
        extension: captures.get(3).map(|m| m.as_str().to_ascii_lowercase()),
    })
}
pub fn file_extension(name: &str) -> String {
    let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) else {
        return ".bin".into();
    };
    let ext = ext.to_ascii_lowercase();
    if ext == "part"
        || !(1..=10).contains(&ext.len())
        || !ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        ".bin".into()
    } else {
        format!(".{ext}")
    }
}
pub fn image_extension(mime: &str, filename: Option<&str>) -> String {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let explicit = match mime.as_str() {
        "image/avif" => Some("avif"),
        "image/bmp" | "image/x-ms-bmp" => Some("bmp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/svg+xml" => Some("svg"),
        "image/tiff" => Some("tiff"),
        "image/webp" => Some("webp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        _ => None,
    };
    let from_mime = explicit.or_else(|| {
        mime_guess::get_mime_extensions_str(&mime)
            .and_then(|list| list.first().copied())
            .filter(|ext| IMAGE_EXTENSIONS.contains(ext))
    });
    let from_name = filename
        .and_then(|name| Path::new(name.trim()).extension())
        .and_then(|e| e.to_str())
        .filter(|ext| {
            (1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        })
        .map(str::to_ascii_lowercase)
        .filter(|ext| IMAGE_EXTENSIONS.contains(&ext.as_str()));
    format!(
        ".{}",
        from_mime
            .map(str::to_owned)
            .or(from_name)
            .unwrap_or_else(|| "bin".into())
    )
}
/// Resolve only canonical flat attachment names; IDs cannot carry path separators.
pub fn find_by_id(root: &Path, id: &str) -> Option<PathBuf> {
    let parsed = parse_id(id)?;
    let extensions: Vec<&str> = parsed.extension.as_deref().map_or_else(
        || {
            IMAGE_EXTENSIONS
                .iter()
                .copied()
                .chain(std::iter::once("bin"))
                .collect()
        },
        |ext| vec![ext],
    );
    extensions
        .into_iter()
        .map(|ext| root.join(format!("{id}.{ext}")))
        .find(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_preserve_ownership_and_reject_paths() {
        assert_eq!(
            safe_thread_segment("  Pending  ").as_deref(),
            Some("_pending")
        );
        assert_eq!(safe_thread_segment("__A...B---_").as_deref(), Some("a-b"));
        assert_eq!(safe_thread_segment("///"), None);
        let id = attachment_id("My Thread", Some(".PNG")).unwrap();
        let parsed = parse_id(&id).unwrap();
        assert_eq!(parsed.thread_segment, "my-thread");
        assert_eq!(parsed.extension.as_deref(), Some("png"));
        assert!(parse_id(&format!("../{id}")).is_none());
        assert_eq!(
            deterministic_id("a.b", "key"),
            deterministic_id("a.b", "key")
        );
        assert_ne!(
            deterministic_id("a.b", "key"),
            deterministic_id("a b", "key")
        );
        assert_eq!(file_extension("x.PART"), ".bin");
        assert_eq!(file_extension(".env"), ".bin");
        assert_eq!(file_extension("x.PDF"), ".pdf");
        assert_eq!(image_extension("image/jpeg", Some("wrong.png")), ".jpg");
        assert_eq!(image_extension("unknown/type", Some("photo.WEBP")), ".webp");
        assert_eq!(image_extension("unknown/type", Some("file.exe")), ".bin");
    }
}
