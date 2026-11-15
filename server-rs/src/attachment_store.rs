//! Upload token, immutable file publication and pending attachment claims.
use crate::attachment_paths::{
    attachment_id, file_extension, find_by_id, image_extension, parse_id, pending_id,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

type HmacSha256 = Hmac<Sha256>;

/// Remove stored attachments and extracted-text sidecars. Missing files are
/// harmless on retry; malformed IDs never resolve outside the store.
pub fn cleanup(dir: &Path, ids: &[String]) -> Result<(), String> {
    for id in ids {
        let Some(parsed) = parse_id(id) else { continue };
        let path = find_by_id(dir, id)
            .or_else(|| parsed.extension.map(|ext| dir.join(format!("{id}.{ext}"))));
        let Some(path) = path else { continue };
        for target in [
            path.clone(),
            PathBuf::from(format!("{}.txt", path.display())),
        ] {
            if let Err(error) = fs::remove_file(target) {
                if error.kind() != io::ErrorKind::NotFound {
                    return Err(format!("attachment {id}: {error}"));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    #[test]
    fn cleanup_removes_file_and_sidecar_and_is_retry_safe() {
        let dir = std::env::temp_dir().join(format!("t3-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let id = attachment_id("thread", Some("pdf")).unwrap();
        let path = dir.join(format!("{id}.pdf"));
        let sidecar = dir.join(format!("{id}.pdf.txt"));
        fs::write(&path, b"file").unwrap();
        fs::write(&sidecar, b"text").unwrap();
        cleanup(&dir, &[id.clone(), "../escape".into()]).unwrap();
        assert!(!path.exists() && !sidecar.exists());
        fs::write(&sidecar, b"orphan").unwrap();
        cleanup(&dir, &[id]).unwrap();
        assert!(!sidecar.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}

/// Remove expired partial uploads and pending files; never delete a claimed
/// attachment. Directory and per-entry errors are deliberately ignored.
pub fn sweep_stale_pending(dir: &Path, now_ms: i64) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut deleted = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let partial = name.ends_with(".part");
        if !partial {
            let base = name
                .strip_suffix(".txt")
                .filter(|s| s.contains('.'))
                .unwrap_or(name);
            let Some((id, _)) = base.rsplit_once('.') else {
                continue;
            };
            if id.contains('.') || parse_id(id).is_none_or(|p| p.thread_segment != "pending") {
                continue;
            }
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(timestamp) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        let age = i128::from(now_ms) - timestamp.as_millis() as i128;
        let limit = if partial { 3_600_000 } else { 86_400_000 };
        if age > limit && fs::remove_file(entry.path()).is_ok() {
            deleted += 1;
        }
    }
    deleted
}
/// Sweep at most once per directory in each 15 minute window.
pub fn sweep_if_due(dir: &Path, now_ms: i64) -> usize {
    static LAST: OnceLock<Mutex<HashMap<PathBuf, i64>>> = OnceLock::new();
    let Ok(mut last) = LAST.get_or_init(Default::default).lock() else {
        return 0;
    };
    if last
        .get(dir)
        .is_some_and(|at| now_ms.saturating_sub(*at) < 900_000)
    {
        return 0;
    }
    last.insert(dir.to_path_buf(), now_ms);
    drop(last);
    sweep_stale_pending(dir, now_ms)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadClaims {
    pub version: u8,
    pub kind: String,
    #[serde(rename = "type", default = "image_type")]
    pub attachment_type: String,
    pub attachment_id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub expires_at: i64,
}
fn image_type() -> String {
    "image".into()
}
fn svg(name: &str, mime: &str) -> bool {
    let m = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    m == "image/svg+xml"
        || ((m.is_empty()
            || [
                "application/octet-stream",
                "binary/octet-stream",
                "application/unknown",
                "video/mp2t",
                "video/vnd.dlna.mpeg-tts",
            ]
            .contains(&m.as_str()))
            && name.to_ascii_lowercase().ends_with(".svg"))
}
fn extension(kind: &str, name: &str, mime: &str) -> Option<String> {
    match kind {
        "file" => Some(file_extension(name)),
        "image" => Some(image_extension(mime, Some(name))),
        _ => None,
    }
}
fn valid_id(id: &str) -> bool {
    parse_id(id).is_some()
}
fn path(dir: &Path, a: &Attachment) -> Option<PathBuf> {
    if !valid_id(&a.id) {
        return None;
    }
    Some(dir.join(format!(
        "{}{}",
        a.id,
        extension(&a.kind, &a.name, &a.mime_type)?
    )))
}

pub fn create_upload(
    key: &[u8],
    kind: &str,
    name: &str,
    mime: &str,
    size: u64,
    now_ms: i64,
) -> Result<(UploadClaims, String), &'static str> {
    let name = name.trim();
    let mime = mime.trim();
    if name.is_empty()
        || name.encode_utf16().count() > 255
        || mime.is_empty()
        || mime.encode_utf16().count() > 100
        || size == 0
        || !match kind {
            "image" => {
                size <= 10 * 1024 * 1024
                    && ["image/gif", "image/jpeg", "image/png", "image/webp"].contains(&mime)
            }
            "file" => size <= 50 * 1024 * 1024,
            _ => false,
        }
    {
        return Err("Invalid attachment upload.");
    }
    let name = if kind == "file" && svg(name, mime) && !name.to_ascii_lowercase().ends_with(".svg")
    {
        format!("{name}.svg")
    } else {
        name.into()
    };
    let ext = file_extension(&name);
    let id = pending_id(if kind == "file" { Some(&ext) } else { None });
    let claims = UploadClaims {
        version: 1,
        kind: "attachment-upload".into(),
        attachment_type: kind.into(),
        attachment_id: id,
        name,
        mime_type: mime.into(),
        size_bytes: size,
        expires_at: now_ms.saturating_add(600_000),
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|_| "Invalid attachment upload.")?);
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| "Invalid signing key.")?;
    mac.update(payload.as_bytes());
    let token = format!(
        "{}.{}",
        payload,
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    Ok((claims, token))
}
pub fn verify_upload(key: &[u8], token: &str, now_ms: i64) -> Option<UploadClaims> {
    let (payload, signature) = token.split_once('.')?;
    if payload.is_empty() || signature.is_empty() || signature.contains('.') {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig).ok()?;
    let c: UploadClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if c.version != 1
        || c.kind != "attachment-upload"
        || c.expires_at <= now_ms
        || parse_id(&c.attachment_id)?.thread_segment != "pending"
        || extension(&c.attachment_type, &c.name, &c.mime_type).is_none()
    {
        return None;
    }
    Some(c)
}
#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    Size(u64, u64),
    Conflict,
    Io,
}
pub fn upload_part_path(dir: &Path, claims: &UploadClaims) -> Result<PathBuf, UploadError> {
    if parse_id(&claims.attachment_id).is_none_or(|p| p.thread_segment != "pending") {
        return Err(UploadError::Io);
    }
    fs::create_dir_all(dir).map_err(|_| UploadError::Io)?;
    let ext = extension(&claims.attachment_type, &claims.name, &claims.mime_type)
        .ok_or(UploadError::Io)?;
    Ok(dir.join(format!(
        "{}{ext}.{}.part",
        claims.attachment_id,
        uuid::Uuid::new_v4()
    )))
}
fn file_digest(path: &Path) -> Result<(u64, [u8; 32]), UploadError> {
    let mut file = fs::File::open(path).map_err(|_| UploadError::Io)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|_| UploadError::Io)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    Ok((size, hash.finalize().into()))
}
/// Publish an already written part without replacing an existing upload.
pub fn publish_part(dir: &Path, c: &UploadClaims, part: &Path) -> Result<(), UploadError> {
    if parse_id(&c.attachment_id).is_none_or(|p| p.thread_segment != "pending") {
        return Err(UploadError::Io);
    }
    let ext = extension(&c.attachment_type, &c.name, &c.mime_type).ok_or(UploadError::Io)?;
    let dest = dir.join(format!("{}{ext}", c.attachment_id));
    let (size, digest) = file_digest(part)?;
    if size != c.size_bytes {
        return Err(UploadError::Size(size, c.size_bytes));
    }
    let compare = || match file_digest(&dest) {
        Ok((n, existing)) if n == size && existing == digest => Ok(()),
        Ok(_) => Err(UploadError::Conflict),
        Err(e) => Err(e),
    };
    match fs::hard_link(part, &dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => compare(),
        Err(_) => {
            let mut target = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
            {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return compare(),
                Err(_) => return Err(UploadError::Io),
            };
            let copy =
                fs::File::open(part).and_then(|mut source| io::copy(&mut source, &mut target));
            if copy.is_err() {
                let _ = fs::remove_file(dest);
                return Err(UploadError::Io);
            }
            Ok(())
        }
    }
}
pub fn publish_upload(dir: &Path, c: &UploadClaims, bytes: &[u8]) -> Result<(), UploadError> {
    if bytes.len() as u64 != c.size_bytes {
        return Err(UploadError::Size(bytes.len() as u64, c.size_bytes));
    }
    if parse_id(&c.attachment_id).is_none_or(|p| p.thread_segment != "pending") {
        return Err(UploadError::Io);
    }
    fs::create_dir_all(dir).map_err(|_| UploadError::Io)?;
    let ext = extension(&c.attachment_type, &c.name, &c.mime_type).ok_or(UploadError::Io)?;
    let dest = dir.join(format!("{}{ext}", c.attachment_id));
    let part = dir.join(format!("{}.{}.part", c.attachment_id, uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|_| UploadError::Io)?;
        f.write_all(bytes).map_err(|_| UploadError::Io)?;
        match fs::hard_link(&part, &dest) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if fs::read(&dest).map_err(|_| UploadError::Io)? == bytes {
                    Ok(())
                } else {
                    Err(UploadError::Conflict)
                }
            }
            Err(_) => {
                let mut out = match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&dest)
                {
                    Ok(f) => f,
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                        return if fs::read(&dest).map_err(|_| UploadError::Io)? == bytes {
                            Ok(())
                        } else {
                            Err(UploadError::Conflict)
                        }
                    }
                    Err(_) => return Err(UploadError::Io),
                };
                if out.write_all(bytes).is_err() {
                    let _ = fs::remove_file(&dest);
                    return Err(UploadError::Io);
                }
                Ok(())
            }
        }
    })();
    let _ = fs::remove_file(part);
    if result.is_ok() {
        crate::document_text::ensure(&dest);
    }
    result
}
pub fn delete_pending(dir: &Path, id: &str) {
    if parse_id(id).is_some_and(|p| p.thread_segment == "pending") {
        if let Some(p) = find_by_id(dir, id) {
            let _ = fs::remove_file(&p);
            let _ = fs::remove_file(format!("{}.txt", p.display()));
        }
    }
}
pub fn release(paths: &[PathBuf]) {
    for p in paths {
        let _ = fs::remove_file(p);
        let _ = fs::remove_file(format!("{}.txt", p.display()));
    }
}
pub fn claim(
    dir: &Path,
    thread: &str,
    attachments: &[Attachment],
) -> Result<(Vec<Attachment>, Vec<PathBuf>), String> {
    if attachments.len() > 100 {
        return Err("You can attach up to 100 files per message or question response.".into());
    }
    if attachments
        .iter()
        .filter(|a| {
            a.kind == "image"
                || ["image/gif", "image/jpeg", "image/png", "image/webp"]
                    .contains(&a.mime_type.to_ascii_lowercase().as_str())
        })
        .fold(0u64, |n, a| n.saturating_add(a.size_bytes))
        > 80 * 1024 * 1024
    {
        return Err("Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.".into());
    }
    let mut ids = HashSet::new();
    if attachments.iter().any(|a| !ids.insert(&a.id)) {
        return Err("Duplicate attachment ids are not allowed.".into());
    }
    let mut paths = Vec::new();
    let result = (|| {
        let mut output = Vec::new();
        for a in attachments {
            let Some(parsed) = parse_id(&a.id) else {
                output.push(a.clone());
                continue;
            };
            if parsed.thread_segment != "pending" {
                output.push(a.clone());
                continue;
            }
            let fail = |s: &str| format!("Attachment '{}' cannot be sent: {s}.", a.name);
            let src = find_by_id(dir, &a.id)
                .ok_or_else(|| fail("attachment not found (removed or expired)"))?;
            if fs::metadata(&src)
                .map_err(|_| fail("attachment not found"))?
                .len()
                != a.size_bytes
            {
                return Err(fail("stored size does not match"));
            }
            let mut b = a.clone();
            b.id = attachment_id(thread, parsed.extension.as_deref())
                .ok_or_else(|| fail("invalid thread id"))?;
            b.mime_type.make_ascii_lowercase();
            if b.kind == "file"
                && svg(&b.name, &b.mime_type)
                && !b.name.to_ascii_lowercase().ends_with(".svg")
            {
                b.name.push_str(".svg")
            }
            let dest = dir.join(format!(
                "{}{}",
                b.id,
                src.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| format!(".{x}"))
                    .unwrap_or_default()
            ));
            if path(dir, &b).as_ref() != Some(&dest) {
                return Err(fail("attachment type does not match the upload"));
            }
            fs::copy(&src, &dest)
                .map_err(|_| format!("Failed to claim attachment '{}' for this thread.", a.name))?;
            paths.push(dest.clone());
            let side = PathBuf::from(format!("{}.txt", src.display()));
            let target = PathBuf::from(format!("{}.txt", dest.display()));
            if side.exists() {
                if fs::copy(side, &target).is_ok() {
                    paths.push(target)
                } else {
                    let _ = fs::remove_file(target);
                }
            } else if let Some(extracted) = crate::document_text::ensure(&dest) {
                paths.push(extracted);
            }
            output.push(b);
        }
        Ok(output)
    })();
    match result {
        Ok(a) => Ok((a, paths)),
        Err(e) => {
            release(&paths);
            Err(e)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sweep_removes_only_old_pending_and_partial_files() {
        let d = std::env::temp_dir().join(format!("att-sweep-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        let pending = pending_id(Some("txt"));
        let claimed = attachment_id("thread", Some("txt")).unwrap();
        for name in [
            format!("{pending}.txt"),
            format!("{pending}.txt.txt"),
            format!("{claimed}.txt"),
            "temp.part".into(),
            "unrelated.txt".into(),
        ] {
            fs::write(d.join(name), b"x").unwrap();
        }
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            + 2 * 86_400_000;
        assert_eq!(sweep_stale_pending(&d, now), 3);
        assert!(d.join(format!("{claimed}.txt")).exists());
        assert!(d.join("unrelated.txt").exists());
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn upload_and_claim_are_immutable_and_retryable() {
        let d = std::env::temp_dir().join(format!("att-{}", uuid::Uuid::new_v4()));
        let (c, t) = create_upload(b"key", "file", "test.pdf", "application/pdf", 3, 100).unwrap();
        assert!(verify_upload(b"wrong", &t, 101).is_none());
        assert!(verify_upload(b"key", &t, 600100).is_none());
        assert!(verify_upload(b"key", &t, 101).is_some());
        publish_upload(&d, &c, b"abc").unwrap();
        publish_upload(&d, &c, b"abc").unwrap();
        assert_eq!(publish_upload(&d, &c, b"xyz"), Err(UploadError::Conflict));
        let a = Attachment {
            kind: "file".into(),
            id: c.attachment_id.clone(),
            name: c.name,
            mime_type: c.mime_type,
            size_bytes: 3,
        };
        let (claimed, paths) = claim(&d, "thread", &[a]).unwrap();
        assert_ne!(claimed[0].id, c.attachment_id);
        release(&paths);
        assert!(find_by_id(&d, &c.attachment_id).is_some());
        delete_pending(&d, &c.attachment_id);
        assert!(find_by_id(&d, &c.attachment_id).is_none());
        let _ = fs::remove_dir_all(d);
    }
    #[test]
    fn upload_metadata_is_trimmed_and_uses_utf16_limits() {
        let (claims, _) =
            create_upload(b"key", "file", "  report.pdf  ", " application/pdf ", 1, 0).unwrap();
        assert_eq!(claims.name, "report.pdf");
        assert_eq!(claims.mime_type, "application/pdf");
        assert!(create_upload(b"key", "file", "  ", "text/plain", 1, 0).is_err());
        assert!(create_upload(b"key", "file", &"🦀".repeat(128), "text/plain", 1, 0).is_err());
    }
}
