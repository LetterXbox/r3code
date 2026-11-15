//! Authentication primitives for scheduled-task webhook requests.
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

type HmacSha256 = Hmac<Sha256>;

/// Compare fixed-length hashes so the comparison does not disclose token lengths.
pub fn constant_time_equals(a: &str, b: &str) -> bool {
    let left = Sha256::digest(a.as_bytes());
    let right = Sha256::digest(b.as_bytes());
    // `verify_slice` provides the constant-time comparison for equal-length tags.
    let mut mac = HmacSha256::new_from_slice(&left).expect("HMAC accepts any key length");
    mac.update(b"t3-webhook-token-comparison");
    let mut other = HmacSha256::new_from_slice(&right).expect("HMAC accepts any key length");
    other.update(b"t3-webhook-token-comparison");
    mac.verify_slice(&other.finalize().into_bytes()).is_ok()
}

/// Verify a webhook signature over the exact request bytes. Header names in `headers`
/// must be lowercased, as they are in the webhook request representation.
pub fn verify_signature(
    header: &str,
    encoding: &str,
    prefix: &str,
    secret: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    let Some(value) = headers.get(&header.to_ascii_lowercase()) else {
        return false;
    };
    let value = value.trim();
    let Some(start) = value.get(..prefix.len()) else {
        return false;
    };
    if !start.eq_ignore_ascii_case(prefix) {
        return false;
    }
    let Some(candidate) = value.get(prefix.len()..) else {
        return false;
    };
    let tag = match encoding {
        "hex" => {
            if candidate.len() % 2 != 0 || !candidate.is_ascii() {
                return false;
            }
            let mut bytes = Vec::with_capacity(candidate.len() / 2);
            for pair in candidate.as_bytes().chunks_exact(2) {
                let Some(hi) = (pair[0] as char).to_digit(16) else {
                    return false;
                };
                let Some(lo) = (pair[1] as char).to_digit(16) else {
                    return false;
                };
                bytes.push(((hi << 4) | lo) as u8);
            }
            bytes
        }
        "base64" => match STANDARD.decode(candidate) {
            Ok(bytes) => bytes,
            Err(_) => return false,
        },
        _ => return false,
    };
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(body);
    mac.verify_slice(&tag).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_known_signatures_and_rejects_tampering() {
        // HMAC-SHA256 test vector computed independently with OpenSSL.
        let body = b"The quick brown fox jumps over the lazy dog";
        let hex = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
        let headers = HashMap::from([(
            "x-signature".into(),
            format!(" SHA256={} ", hex.to_uppercase()),
        )]);
        assert!(verify_signature(
            "X-Signature",
            "hex",
            "sha256=",
            "key",
            &headers,
            body
        ));
        assert!(!verify_signature(
            "X-Signature",
            "hex",
            "sha256=",
            "key",
            &headers,
            b"tampered"
        ));
        assert!(!verify_signature(
            "X-Signature",
            "hex",
            "sha256=",
            "wrong",
            &headers,
            body
        ));
        assert!(!verify_signature(
            "missing", "hex", "sha256=", "key", &headers, body
        ));
        assert!(!verify_signature(
            "X-Signature",
            "hex",
            "bad=",
            "key",
            &headers,
            body
        ));
        let base64 = HashMap::from([(
            "x-signature".into(),
            "97yD9DBThCSxMpjmqm+xQ+9NWaFJRh dZl0edvC0aPNg=".replace(' ', ""),
        )]);
        assert!(verify_signature(
            "x-signature",
            "base64",
            "",
            "key",
            &base64,
            body
        ));
        for invalid in ["0", "zz", "é", "%%%"] {
            let h = HashMap::from([("x".into(), invalid.into())]);
            assert!(!verify_signature("x", "hex", "", "key", &h, body));
            assert!(!verify_signature("x", "base64", "", "key", &h, body));
        }
        assert!(constant_time_equals("token", "token"));
        assert!(!constant_time_equals("token", "tokens"));
    }
}
