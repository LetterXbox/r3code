//! Verification of T3 Connect's signed webhook delivery metadata.
//! Invalid or absent proofs are treated as direct deliveries by callers.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub struct RelayDelivery {
    pub delivery_id: String,
    pub received_at: String,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: i64,
    exp: i64,
    environment_id: String,
    delivery_id: String,
    received_at: String,
    hook_id: String,
    #[serde(default)]
    nbf: Option<i64>,
}

/// Verify a compact Ed25519 JWT with the relay's SPKI PEM public key. `now` is
/// Unix seconds, supplied by the caller to make clock handling explicit.
pub fn verify(
    headers: &HashMap<String, String>,
    hook_id: &str,
    environment_id: &str,
    public_key_pem: Option<&str>,
    issuer: Option<&str>,
    relay_url: Option<&str>,
    now: i64,
) -> Option<RelayDelivery> {
    let token = headers.get("x-t3-relay-delivery")?;
    let delivery_id = headers.get("x-t3-relay-delivery-id")?;
    let received_at = headers.get("x-t3-relay-received-at")?;
    let issuer = issuer.or(relay_url)?.trim().trim_end_matches('/');
    let pem = public_key_pem?.replace("\\n", "\n");
    let encoded = pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")?
        .strip_suffix("-----END PUBLIC KEY-----")?;
    let der = STANDARD
        .decode(encoded.split_whitespace().collect::<String>())
        .ok()?;
    // RFC 8410 SubjectPublicKeyInfo for Ed25519: algorithm OID 1.3.101.112.
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || !der.starts_with(&PREFIX) {
        return None;
    }
    let mut parts = token.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
    if header.alg != "EdDSA" || header.typ != "t3-relay-hook-delivery+jwt" {
        return None;
    }
    let signature = URL_SAFE_NO_PAD.decode(s).ok()?;
    UnparsedPublicKey::new(&ED25519, &der[12..])
        .verify(format!("{h}.{p}").as_bytes(), &signature)
        .ok()?;
    let c: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()?;
    let nonempty = |s: &str| !s.trim().is_empty();
    if ![
        &c.iss,
        &c.aud,
        &c.sub,
        &c.jti,
        &c.environment_id,
        &c.delivery_id,
        &c.received_at,
        &c.hook_id,
    ]
    .iter()
    .all(|s| nonempty(s))
        || c.iss != issuer
        || c.aud != format!("t3-env:{environment_id}")
        || c.environment_id != environment_id
        || c.delivery_id != *delivery_id
        || c.received_at != *received_at
        || c.hook_id != hook_id
        || c.iat > now.saturating_add(60)
        || c.iat < now.saturating_sub(25 * 3600 + 60)
        || c.exp <= now.saturating_sub(60)
        || c.nbf.is_some_and(|n| n > now.saturating_add(60))
    {
        return None;
    }
    Some(RelayDelivery {
        delivery_id: delivery_id.clone(),
        received_at: received_at.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    use serde_json::{json, Value};

    fn sign(key: &Ed25519KeyPair, header: Value, claims: Value) -> String {
        let h = URL_SAFE_NO_PAD.encode(header.to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let message = format!("{h}.{p}");
        format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())
        )
    }
    #[test]
    fn signed_metadata_requires_matching_claims_key_and_valid_time() {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(key.public_key().as_ref());
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
            STANDARD.encode(der)
        );
        let header = json!({"alg":"EdDSA","typ":"t3-relay-hook-delivery+jwt"});
        let claims = json!({"iss":"https://relay.example", "aud":"t3-env:env", "sub":"relay", "jti":"nonce", "iat":100000, "exp":100500, "environmentId":"env", "deliveryId":"id", "receivedAt":"date", "hookId":"hook"});
        let mut headers = HashMap::from([
            (String::from("x-t3-relay-delivery-id"), String::from("id")),
            (String::from("x-t3-relay-received-at"), String::from("date")),
        ]);
        headers.insert(
            "x-t3-relay-delivery".into(),
            sign(&key, header.clone(), claims.clone()),
        );
        let verify_at = |h: &HashMap<String, String>, hook: &str, pem: Option<&str>, now| {
            verify(
                h,
                hook,
                "env",
                pem,
                None,
                Some(" https://relay.example/// "),
                now,
            )
        };
        assert!(verify_at(&headers, "hook", Some(&pem), 100000).is_some());
        assert!(verify_at(&headers, "other", Some(&pem), 100000).is_none());
        assert!(verify_at(&headers, "hook", None, 100000).is_none());
        assert!(verify_at(&headers, "hook", Some(&pem), 100561).is_none());
        let mut forged = headers.clone();
        forged.insert("x-t3-relay-delivery-id".into(), "other".into());
        assert!(verify_at(&forged, "hook", Some(&pem), 100000).is_none());
        let wrong_key = Ed25519KeyPair::from_pkcs8(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        forged.insert("x-t3-relay-delivery-id".into(), "id".into());
        forged.insert(
            "x-t3-relay-delivery".into(),
            sign(&wrong_key, header.clone(), claims.clone()),
        );
        assert!(verify_at(&forged, "hook", Some(&pem), 100000).is_none());
        forged.insert(
            "x-t3-relay-delivery".into(),
            sign(
                &key,
                json!({"alg":"none","typ":"t3-relay-hook-delivery+jwt"}),
                claims.clone(),
            ),
        );
        assert!(verify_at(&forged, "hook", Some(&pem), 100000).is_none());
        let mut old = claims.clone();
        old["iat"] = json!(9900);
        forged.insert("x-t3-relay-delivery".into(), sign(&key, header, old));
        assert!(verify_at(&forged, "hook", Some(&pem), 100000).is_none());
    }
}
