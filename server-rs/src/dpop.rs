//! Verification of proof-of-possession requests and durable replay markers.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

#[derive(Debug, PartialEq, Eq)]
pub enum ProofError {
    Missing,
    Malformed,
    KeyMismatch,
    MethodMismatch,
    UrlMismatch,
    TokenMismatch,
    InvalidSignature,
    TimeWindow,
    Replay,
    Storage,
}
impl ProofError {
    pub fn wire_reason(&self) -> &'static str {
        match self {
            Self::KeyMismatch => "key_mismatch",
            Self::MethodMismatch | Self::UrlMismatch => "request_mismatch",
            Self::TokenMismatch => "token_mismatch",
            Self::TimeWindow => "time_window",
            Self::Replay => "replay",
            _ => "invalid_proof",
        }
    }
}
#[derive(Deserialize)]
struct Header {
    typ: String,
    alg: String,
    jwk: Jwk,
}
#[derive(Deserialize)]
struct Jwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}
#[derive(Deserialize)]
struct Payload {
    htm: String,
    htu: String,
    jti: String,
    iat: i64,
    #[serde(default)]
    ath: Option<String>,
}
fn digest(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(input))
}
/// Verify every claim and signature before atomically reserving the proof ID.
/// `request_url` is the effective external URL, including any query.
pub fn verify(
    proof: Option<&str>,
    method: &str,
    request_url: &str,
    expected_key: Option<&str>,
    token: Option<&str>,
    now_seconds: i64,
    replay_dir: &Path,
) -> Result<String, ProofError> {
    let proof = proof
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(ProofError::Missing)?;
    let mut pieces = proof.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (pieces.next(), pieces.next(), pieces.next(), pieces.next())
    else {
        return Err(ProofError::Malformed);
    };
    if h.is_empty() || p.is_empty() || s.is_empty() {
        return Err(ProofError::Malformed);
    }
    let header_value: serde_json::Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(h)
            .map_err(|_| ProofError::Malformed)?,
    )
    .map_err(|_| ProofError::Malformed)?;
    if header_value
        .get("jwk")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|jwk| jwk.contains_key("d"))
    {
        return Err(ProofError::Malformed);
    }
    let header: Header = serde_json::from_value(header_value).map_err(|_| ProofError::Malformed)?;
    let payload: Payload = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(p)
            .map_err(|_| ProofError::Malformed)?,
    )
    .map_err(|_| ProofError::Malformed)?;
    if header.typ != "dpop+jwt"
        || header.alg != "ES256"
        || header.jwk.kty != "EC"
        || header.jwk.crv != "P-256"
        || payload.htm.is_empty()
        || payload.htu.is_empty()
        || payload.jti.is_empty()
    {
        return Err(ProofError::Malformed);
    }
    let x = URL_SAFE_NO_PAD
        .decode(&header.jwk.x)
        .map_err(|_| ProofError::Malformed)?;
    let y = URL_SAFE_NO_PAD
        .decode(&header.jwk.y)
        .map_err(|_| ProofError::Malformed)?;
    if x.len() != 32 || y.len() != 32 {
        return Err(ProofError::Malformed);
    }
    let canonical =
        serde_json::json!({"crv":"P-256","kty":"EC","x":header.jwk.x,"y":header.jwk.y}).to_string();
    let thumbprint = digest(canonical.as_bytes());
    if expected_key.is_some_and(|v| v != thumbprint) {
        return Err(ProofError::KeyMismatch);
    }
    if !payload.htm.eq_ignore_ascii_case(method) {
        return Err(ProofError::MethodMismatch);
    }
    let mut url = url::Url::parse(request_url).map_err(|_| ProofError::UrlMismatch)?;
    url.set_query(None);
    url.set_fragment(None);
    if payload.htu != url.as_str() {
        return Err(ProofError::UrlMismatch);
    }
    if let Some(token) = token {
        if payload.ath.as_deref() != Some(digest(token.as_bytes()).as_str()) {
            return Err(ProofError::TokenMismatch);
        }
    }
    let mut point = Vec::with_capacity(65);
    point.push(4);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    let key = VerifyingKey::from_sec1_bytes(&point).map_err(|_| ProofError::Malformed)?;
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|_| ProofError::InvalidSignature)?,
    )
    .map_err(|_| ProofError::InvalidSignature)?;
    key.verify(format!("{h}.{p}").as_bytes(), &signature)
        .map_err(|_| ProofError::InvalidSignature)?;
    if now_seconds.abs_diff(payload.iat) > 300 {
        return Err(ProofError::TimeWindow);
    }
    fs::create_dir_all(replay_dir).map_err(|_| ProofError::Storage)?;
    let path = replay_dir.join(format!(
        "dpop-proof-{}.bin",
        digest(format!("{thumbprint}:{}", payload.jti).as_bytes())
    ));
    let temp = replay_dir.join(format!(
        "dpop-proof-{}.bin.{}.tmp",
        digest(format!("{thumbprint}:{}", payload.jti).as_bytes()),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| ProofError::Storage)?;
        let consumed_at = chrono::DateTime::from_timestamp(now_seconds, 0)
            .ok_or(ProofError::Storage)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        write!(
            file,
            "thumbprint={}\njti={}\niat={}\nconsumedAt={}",
            thumbprint, payload.jti, payload.iat, consumed_at
        )
        .map_err(|_| ProofError::Storage)?;
        file.sync_all().map_err(|_| ProofError::Storage)?;
        match fs::hard_link(&temp, &path) {
            Ok(()) => Ok(thumbprint),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(ProofError::Replay),
            Err(_) => Err(ProofError::Storage),
        }
    })();
    let _ = fs::remove_file(temp);
    result
}

/// Remove replay markers older than one day; leave all other secrets untouched.
pub fn prune_replay_markers(dir: &Path, now: std::time::SystemTime) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("dpop-proof-")
            && name.ends_with(".bin")
            && entry.file_type()?.is_file()
            && entry
                .metadata()?
                .modified()
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > std::time::Duration::from_secs(86400))
        {
            match fs::remove_file(entry.path()) {
                Ok(()) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};
    #[test]
    fn checks_proof_binding_and_persists_replay_marker() {
        let dir = std::env::temp_dir().join(format!("dpop-{}", uuid::Uuid::new_v4()));
        let key = SigningKey::from_slice(&[7; 32]).unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        let header = serde_json::json!({"typ":"dpop+jwt","alg":"ES256","jwk":{"kty":"EC","crv":"P-256","x":URL_SAFE_NO_PAD.encode(point.x().unwrap()),"y":URL_SAFE_NO_PAD.encode(point.y().unwrap())}});
        let payload = serde_json::json!({"htm":"POST","htu":"https://example.test/token","jti":"unique","iat":1000,"ath":digest(b"token")});
        let h = URL_SAFE_NO_PAD.encode(header.to_string());
        let p = URL_SAFE_NO_PAD.encode(payload.to_string());
        let signing = format!("{h}.{p}");
        let sig: Signature = key.sign(signing.as_bytes());
        let proof = format!("{signing}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        assert_eq!(
            verify(
                Some(&proof),
                "GET",
                "https://example.test/token",
                None,
                Some("token"),
                1000,
                &dir
            ),
            Err(ProofError::MethodMismatch)
        );
        let thumb = verify(
            Some(&proof),
            "POST",
            "https://example.test/token?ignored=1",
            None,
            Some("token"),
            1000,
            &dir,
        )
        .unwrap();
        assert_eq!(
            verify(
                Some(&proof),
                "POST",
                "https://example.test/token",
                Some(&thumb),
                Some("token"),
                1000,
                &dir
            ),
            Err(ProofError::Replay)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
