//! Pairing and session credential primitives. Persistent rows remain authoritative.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
pub const STARTUP_PAIRING_SUBJECT: &str = "administrative-bootstrap";
/// Revoke credentials for remote transports disabled by the startup policy.
pub fn revoke_disallowed_pairings(
    db: &mut Connection,
    now: &str,
    remote_allowed: bool,
    connect_allowed: bool,
) -> rusqlite::Result<()> {
    if remote_allowed && connect_allowed {
        return Ok(());
    }
    let tx = db.transaction()?;
    if !remote_allowed {
        tx.execute("UPDATE auth_sessions SET revoked_at=?1 WHERE subject='one-time-token' AND revoked_at IS NULL AND expires_at>?1", [now])?;
        tx.execute("UPDATE auth_pairing_links SET revoked_at=?1 WHERE (subject='one-time-token' OR substr(subject,1,13)='mcp-approval:') AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?1", [now])?;
        let mut statement = tx.prepare("SELECT session_id, client_ip_address FROM auth_sessions WHERE subject='administrative-bootstrap' AND client_ip_address IS NOT NULL AND revoked_at IS NULL AND expires_at>?1")?;
        let rows = statement
            .query_map([now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (id, ip) in rows {
            let local = ip.eq_ignore_ascii_case("localhost") || ip.parse::<std::net::IpAddr>().is_ok_and(|address| address.is_loopback() || matches!(address, std::net::IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())));
            if !local {
                tx.execute("UPDATE auth_sessions SET revoked_at=?2 WHERE session_id=?1 AND revoked_at IS NULL", params![id,now])?;
            }
        }
    }
    if !connect_allowed {
        tx.execute("UPDATE auth_sessions SET revoked_at=?1 WHERE subject='cloud-connect' AND revoked_at IS NULL AND expires_at>?1", [now])?;
        tx.execute("UPDATE auth_pairing_links SET revoked_at=?1 WHERE subject='cloud-connect' AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?1", [now])?;
    }
    tx.commit()
}
pub const DEFAULT_STARTUP_PAIRING_TTL_MS: i64 = 5 * 60 * 1000;
pub const DEV_STARTUP_PAIRING_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// The standard browser/client grant in contract order. Keep this separate
/// from the authorization index, whose ordering serves a different purpose.
pub const STANDARD_CLIENT_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "source-control:write",
    "filesystem:read",
    "filesystem:write",
    "relay:read",
    "access:read",
    "access:write",
    "relay:write",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedStartupPairingCredential {
    pub id: String,
    pub credential: String,
    pub subject: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug)]
pub enum PairingIssueError {
    Random(getrandom::Error),
    Database(rusqlite::Error),
    Encode(serde_json::Error),
}

impl std::fmt::Display for PairingIssueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for PairingIssueError {}

/// Insert the internal startup grant. Its row is ordinary single-use pairing
/// authority, but the administrative subject is omitted from normal listings.
/// `now_iso` is the canonical UTC timestamp stored as `created_at`; `now_ms`
/// supplies the exact TTL arithmetic, matching the source DateTime behavior.
pub fn issue_startup_pairing_credential(
    db: &mut Connection,
    now_ms: i64,
    now_iso: &str,
    dev_url_set: bool,
) -> Result<IssuedStartupPairingCredential, PairingIssueError> {
    let ttl_ms = if dev_url_set {
        DEV_STARTUP_PAIRING_TTL_MS
    } else {
        DEFAULT_STARTUP_PAIRING_TTL_MS
    };
    let expires_ms = now_ms.saturating_add(ttl_ms);
    let expires_at: String = db
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1 / 1000.0, 'unixepoch')",
            [expires_ms],
            |row| row.get(0),
        )
        .map_err(PairingIssueError::Database)?;
    let credential = generate_pairing_code().map_err(PairingIssueError::Random)?;
    let id = Uuid::new_v4().to_string();
    let scopes: Vec<String> = STANDARD_CLIENT_SCOPES
        .iter()
        .map(|scope| (*scope).to_owned())
        .collect();
    let scopes_json = serde_json::to_string(&scopes).map_err(PairingIssueError::Encode)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(PairingIssueError::Database)?;
    tx.execute(
        "INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, label, proof_key_thumbprint, created_at, expires_at, consumed_at, revoked_at) \
         VALUES (?1, ?2, 'one-time-token', ?3, ?4, NULL, NULL, ?5, ?6, NULL, NULL)",
        params![id, credential, scopes_json, STARTUP_PAIRING_SUBJECT, now_iso, expires_at],
    )
    .map_err(PairingIssueError::Database)?;
    tx.commit().map_err(PairingIssueError::Database)?;
    Ok(IssuedStartupPairingCredential {
        id,
        credential,
        subject: STARTUP_PAIRING_SUBJECT.to_owned(),
        scopes,
        created_at: now_iso.to_owned(),
        expires_at,
    })
}

/// Standard pairing-link views exclude internal startup and MCP approval grants.
pub fn pairing_link_visible_in_default_list(subject: &str) -> bool {
    subject != STARTUP_PAIRING_SUBJECT && !subject.starts_with("mcp-approval:")
}

/// Build the browser target without sending the credential in the HTTP query.
pub fn startup_pairing_url(base_url: &str, credential: &str) -> Result<String, url::ParseError> {
    let mut url = url::Url::parse(base_url)?;
    url.set_path("/pair");
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "token")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if url.query().is_some() {
        url.set_query(None);
        if !retained.is_empty() {
            url.query_pairs_mut().extend_pairs(retained);
        }
    }
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", credential)
        .finish();
    url.set_fragment(Some(&fragment));
    Ok(url.into())
}

/// The desktop derives a new HMAC credential every twelve hours. The adjacent
/// windows cover token lifetime and clock skew between the desktop and server.
pub const DESKTOP_BOOTSTRAP_WINDOW_MS: i64 = 12 * 60 * 60 * 1000;
const DESKTOP_BOOTSTRAP_LEGACY_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Desktop bootstrap material supplied by the parent process. The secret and
/// legacy token are intentionally not printable through `Debug`.
pub struct DesktopBootstrap {
    secret: Option<String>,
    legacy: Option<(String, i64)>,
}
impl DesktopBootstrap {
    /// A rotating secret takes precedence over the legacy startup token. The
    /// latter is reusable for 24 hours from server startup when no secret exists.
    pub fn new(secret: Option<String>, token: Option<String>, started_ms: i64) -> Self {
        let legacy = if secret.is_none() {
            token.filter(|token| !token.is_empty()).map(|token| {
                (
                    token,
                    started_ms.saturating_add(DESKTOP_BOOTSTRAP_LEGACY_TTL_MS),
                )
            })
        } else {
            None
        };
        Self { secret, legacy }
    }
    pub fn matches(&self, presented: &str, now_ms: i64) -> bool {
        if let Some(secret) = &self.secret {
            return valid_desktop_bootstrap_token(secret, presented, now_ms);
        }
        self.legacy
            .as_ref()
            .is_some_and(|(token, expires)| now_ms < *expires && token == presented)
    }
}

/// Lowercase hex representation expected by existing desktop clients.
pub fn desktop_bootstrap_token(secret: &str, now_ms: i64) -> String {
    let window = now_ms.div_euclid(DESKTOP_BOOTSTRAP_WINDOW_MS);
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("t3-desktop-bootstrap:{window}").as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut out = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 15) as usize] as char);
    }
    out
}

pub fn valid_desktop_bootstrap_token(secret: &str, token: &str, now_ms: i64) -> bool {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in token.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |c: u8| {
            if c.is_ascii_digit() {
                c - b'0'
            } else {
                c - b'a' + 10
            }
        };
        decoded[index] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    let current = now_ms.div_euclid(DESKTOP_BOOTSTRAP_WINDOW_MS);
    for window in [current - 1, current, current + 1] {
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
        mac.update(format!("t3-desktop-bootstrap:{window}").as_bytes());
        if mac.verify_slice(&decoded).is_ok() {
            return true;
        }
    }
    false
}

/// Generate a 60-bit one-time credential using the operating system CSPRNG.
pub fn generate_pairing_code() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes)?;
    Ok(bytes
        .into_iter()
        .map(|b| ALPHABET[(b % 32) as usize] as char)
        .collect())
}
/// Only canonicalize recognized ordinary and MCP approval codes; other credentials are verbatim.
pub fn normalize_pairing_code(input: &str) -> String {
    let upper = input.to_ascii_uppercase();
    let valid_token = |s: &str| s.len() == 12 && s.bytes().all(|b| ALPHABET.contains(&b));
    if valid_token(&upper)
        || upper.split_once('-').is_some_and(|(level, token)| {
            ["READ", "SUPERVISED", "EDITS", "AUTO", "FULL"].contains(&level) && valid_token(token)
        })
    {
        upper
    } else {
        input.to_owned()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionClaims {
    pub v: u8,
    pub kind: String,
    pub sid: String,
    pub sub: String,
    pub scopes: Vec<String>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jkt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plk: Option<u8>,
    pub iat: i64,
    pub exp: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebSocketClaims {
    pub v: u8,
    pub kind: String,
    pub sid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jkt: Option<String>,
    pub iat: i64,
    pub exp: i64,
}
#[derive(Debug)]
pub enum AuthError {
    Malformed,
    InvalidSignature,
    InvalidPayload,
    Expired,
    UnknownSession,
    Revoked,
    AudienceMismatch,
    Proof(crate::dpop::ProofError),
    Database(rusqlite::Error),
}
impl From<rusqlite::Error> for AuthError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for AuthError {}

fn sign<T: Serialize>(key: &[u8; 32], claims: &T) -> Result<String, serde_json::Error> {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    Ok(format!(
        "{}.{}",
        payload,
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
fn verify<T: for<'de> Deserialize<'de>>(key: &[u8; 32], token: &str) -> Result<T, AuthError> {
    let (payload, signature) = token.split_once('.').ok_or(AuthError::Malformed)?;
    if payload.is_empty() || signature.is_empty() || signature.contains('.') {
        return Err(AuthError::Malformed);
    }
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| AuthError::InvalidSignature)?;
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| AuthError::InvalidSignature)?;
    let json = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| AuthError::InvalidPayload)?;
    serde_json::from_slice(&json).map_err(|_| AuthError::InvalidPayload)
}
pub fn sign_session(key: &[u8; 32], claims: &SessionClaims) -> Result<String, serde_json::Error> {
    sign(key, claims)
}
pub fn sign_websocket(
    key: &[u8; 32],
    claims: &WebSocketClaims,
) -> Result<String, serde_json::Error> {
    sign(key, claims)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub session_id: String,
    pub subject: String,
    pub scopes: Vec<String>,
    pub method: String,
    pub jkt: Option<String>,
    pub rtc: Option<String>,
    pub peer_link: bool,
}
struct Row {
    subject: String,
    scopes: Vec<String>,
    method: String,
    expires_at: String,
    revoked: bool,
}
fn session_row(db: &Connection, sid: &str) -> Result<Row, AuthError> {
    let result: Option<(String, String, String, String, Option<String>)> = db.query_row(
        "SELECT subject, scopes, method, expires_at, revoked_at FROM auth_sessions WHERE session_id = ?1", [sid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)) ).optional()?;
    let (subject, scopes, method, expires_at, revoked_at) =
        result.ok_or(AuthError::UnknownSession)?;
    Ok(Row {
        subject,
        scopes: serde_json::from_str(&scopes).map_err(|_| AuthError::InvalidPayload)?,
        method,
        expires_at,
        revoked: revoked_at.is_some(),
    })
}
/// `now_ms` is Unix milliseconds. Session expiry is the signed claim; the row supplies scopes and revocation.
pub fn verify_session(
    db: &Connection,
    key: &[u8; 32],
    token: &str,
    now_ms: i64,
) -> Result<Principal, AuthError> {
    let c: SessionClaims = verify(key, token)?;
    if ![1, 2].contains(&c.v)
        || c.kind != "session"
        || c.sid.is_empty()
        || c.sub.is_empty()
        || ![
            "browser-session-cookie",
            "bearer-access-token",
            "dpop-access-token",
        ]
        .contains(&c.method.as_str())
        || c.rtc.as_deref().is_some_and(|r| {
            ![
                "approval-required",
                "auto-accept-edits",
                "auto",
                "full-access",
            ]
            .contains(&r)
        })
        || c.plk.is_some_and(|p| p != 1)
    {
        return Err(AuthError::InvalidPayload);
    }
    if c.exp <= now_ms {
        return Err(AuthError::Expired);
    }
    let row = session_row(db, &c.sid)?;
    if row.revoked {
        return Err(AuthError::Revoked);
    }
    Ok(Principal {
        session_id: c.sid,
        subject: c.sub,
        scopes: row.scopes,
        method: c.method,
        jkt: c.jkt,
        rtc: c.rtc,
        peer_link: c.plk == Some(1),
    })
}
/// `now_iso` must be a canonical UTC ISO-8601 timestamp, as used by the session table.
pub fn verify_websocket(
    db: &Connection,
    key: &[u8; 32],
    token: &str,
    audience: &str,
    now_ms: i64,
    now_iso: &str,
    dev_session_id: Option<&str>,
) -> Result<Principal, AuthError> {
    let c: WebSocketClaims = verify(key, token)?;
    if c.v != 1
        || c.kind != "websocket"
        || c.sid.is_empty()
        || c.aud.as_deref().is_some_and(|a| a != "rpc" && a != "media")
    {
        return Err(AuthError::InvalidPayload);
    }
    if c.aud.as_deref().is_some_and(|a| a != audience) {
        return Err(AuthError::AudienceMismatch);
    }
    if c.sid.starts_with("dev-auth-") && dev_session_id != Some(c.sid.as_str()) {
        return Err(AuthError::UnknownSession);
    }
    if c.exp <= now_ms {
        return Err(AuthError::Expired);
    }
    let row = session_row(db, &c.sid)?;
    if row.expires_at.as_str() <= now_iso {
        return Err(AuthError::Expired);
    }
    if row.revoked {
        return Err(AuthError::Revoked);
    }
    Ok(Principal {
        session_id: c.sid,
        subject: row.subject,
        scopes: row.scopes,
        method: row.method,
        jkt: c.jkt,
        rtc: None,
        peer_link: false,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct PairingGrant {
    pub id: String,
    pub method: String,
    pub scopes: Vec<String>,
    pub subject: String,
    pub label: Option<String>,
    pub proof_key_thumbprint: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}
/// Consume only if all predicates hold, in one SQLite statement. `None` is a
/// deliberately non-specific failure; callers may perform a read-only diagnostic.
pub fn consume_pairing(
    db: &Connection,
    credential: &str,
    now_iso: &str,
    mcp_subject: Option<&str>,
    thumbprint: Option<&str>,
    requested: Option<&[String]>,
    required: &[String],
) -> Result<Option<PairingGrant>, AuthError> {
    let requested_json = requested
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| AuthError::InvalidPayload)?;
    let required_json = serde_json::to_string(required).map_err(|_| AuthError::InvalidPayload)?;
    type PairingRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let result: Option<PairingRow> = db.query_row(
        "UPDATE auth_pairing_links SET consumed_at = ?2 WHERE credential = ?1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?2
         AND (subject NOT LIKE 'mcp-approval:%' OR subject = ?3)
         AND (proof_key_thumbprint IS NULL OR proof_key_thumbprint = ?4)
         AND (?5 IS NULL OR EXISTS (SELECT 1 FROM json_each(?5) requested JOIN json_each(auth_pairing_links.scopes) granted ON requested.value = granted.value))
         AND NOT EXISTS (SELECT 1 FROM json_each(?6) required WHERE NOT EXISTS (SELECT 1 FROM json_each(auth_pairing_links.scopes) granted WHERE granted.value = required.value))
         RETURNING id, method, scopes, subject, label, proof_key_thumbprint, created_at, expires_at",
        params![normalize_pairing_code(credential), now_iso, mcp_subject, thumbprint, requested_json, required_json],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))
    ).optional()?;
    result
        .map(
            |(id, method, scopes, subject, label, proof_key_thumbprint, created_at, expires_at)| {
                Ok(PairingGrant {
                    id,
                    method,
                    scopes: serde_json::from_str(&scopes).map_err(|_| AuthError::InvalidPayload)?,
                    subject,
                    label,
                    proof_key_thumbprint,
                    created_at,
                    expires_at,
                })
            },
        )
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_bootstrap_vectors_cover_adjacent_windows_and_legacy_expiry() {
        let window = DESKTOP_BOOTSTRAP_WINDOW_MS;
        assert_eq!(
            desktop_bootstrap_token("test-secret", 1_700_000_000_000),
            "fdcc803bed0e5fcbde01221220f9abcd496feaa9b06965a0761d6927d9b5c38e"
        );
        let current = desktop_bootstrap_token("desktop-secret", 10 * window + 1);
        assert!(valid_desktop_bootstrap_token(
            "desktop-secret",
            &current,
            10 * window + 1
        ));
        assert!(valid_desktop_bootstrap_token(
            "desktop-secret",
            &current,
            11 * window + 1
        ));
        assert!(valid_desktop_bootstrap_token(
            "desktop-secret",
            &current,
            9 * window + 1
        ));
        assert!(!valid_desktop_bootstrap_token(
            "desktop-secret",
            &current,
            12 * window + 1
        ));
        assert!(!valid_desktop_bootstrap_token(
            "desktop-secret",
            &current,
            8 * window + 1
        ));
        assert!(!valid_desktop_bootstrap_token(
            "wrong",
            &current,
            10 * window + 1
        ));
        assert!(!valid_desktop_bootstrap_token(
            "desktop-secret",
            &current.to_uppercase(),
            10 * window + 1
        ));
        let legacy = DesktopBootstrap::new(None, Some("abcdefghjkmn".into()), 10 * window);
        assert!(legacy.matches("abcdefghjkmn", 12 * window - 1));
        assert!(!legacy.matches("abcdefghjkmn", 12 * window));
        assert!(!legacy.matches("ABCDEFGHJKMN", 10 * window));
        let rotating = DesktopBootstrap::new(
            Some("desktop-secret".into()),
            Some("launch-token".into()),
            0,
        );
        assert!(rotating.matches(&current, 10 * window));
        assert!(!rotating.matches("launch-token", 10 * window));
    }
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,subject TEXT,scopes TEXT,method TEXT,expires_at TEXT,revoked_at TEXT); CREATE TABLE auth_pairing_links(id TEXT PRIMARY KEY,credential TEXT UNIQUE,method TEXT,scopes TEXT,subject TEXT,label TEXT,proof_key_thumbprint TEXT,created_at TEXT,expires_at TEXT,consumed_at TEXT,revoked_at TEXT);").unwrap();
        db
    }
    #[test]
    fn startup_grants_have_expected_lifetime_and_are_single_use() {
        for (dev, expires) in [
            (false, "2024-01-01T00:05:00.000Z"),
            (true, "2024-01-02T00:00:00.000Z"),
        ] {
            let mut db = db();
            let issued = issue_startup_pairing_credential(
                &mut db,
                1_704_067_200_000,
                "2024-01-01T00:00:00.000Z",
                dev,
            )
            .unwrap();
            assert_eq!(issued.expires_at, expires);
            assert_eq!(issued.subject, STARTUP_PAIRING_SUBJECT);
            assert_eq!(issued.scopes, STANDARD_CLIENT_SCOPES);
            let grant = consume_pairing(
                &db,
                &issued.credential,
                "2024-01-01T00:00:01.000Z",
                None,
                None,
                None,
                &[],
            )
            .unwrap()
            .unwrap();
            assert_eq!(grant.subject, STARTUP_PAIRING_SUBJECT);
            assert_eq!(grant.scopes, issued.scopes);
            assert!(consume_pairing(
                &db,
                &issued.credential,
                "2024-01-01T00:00:02.000Z",
                None,
                None,
                None,
                &[]
            )
            .unwrap()
            .is_none());
            let expired = issue_startup_pairing_credential(
                &mut db,
                1_704_067_200_000,
                "2024-01-01T00:00:00.000Z",
                dev,
            )
            .unwrap();
            assert!(
                consume_pairing(&db, &expired.credential, expires, None, None, None, &[])
                    .unwrap()
                    .is_none()
            );
        }
        assert!(!pairing_link_visible_in_default_list(
            STARTUP_PAIRING_SUBJECT
        ));
        assert!(!pairing_link_visible_in_default_list("mcp-approval:auto"));
        assert!(pairing_link_visible_in_default_list("one-time-token"));
    }

    #[test]
    fn startup_url_puts_token_only_in_fragment() {
        let url = startup_pairing_url(
            "http://localhost:3773/old?x=1&token=old&token=other#old",
            "A+B C",
        )
        .unwrap();
        assert_eq!(url, "http://localhost:3773/pair?x=1#token=A%2BB+C");
        assert!(startup_pairing_url("not a url", "secret").is_err());
    }
    #[test]
    fn session_mac_and_database_scopes_and_revocation() {
        let db = db();
        db.execute("INSERT INTO auth_sessions VALUES('s','db-sub','[\"access:read\"]','bearer-access-token','2099',NULL)", []).unwrap();
        let key = [42; 32];
        let claims = SessionClaims {
            v: 1,
            kind: "session".into(),
            sid: "s".into(),
            sub: "token-sub".into(),
            scopes: vec!["access:write".into()],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            plk: None,
            iat: 0,
            exp: 100,
        };
        let token = sign_session(&key, &claims).unwrap();
        let principal = verify_session(&db, &key, &token, 1).unwrap();
        assert_eq!(principal.scopes, vec!["access:read"]);
        assert_eq!(principal.subject, "token-sub");
        assert!(matches!(
            verify_session(&db, &[7; 32], &token, 1),
            Err(AuthError::InvalidSignature)
        ));
        assert!(matches!(
            verify_session(&db, &key, &token, 100),
            Err(AuthError::Expired)
        ));
        db.execute("UPDATE auth_sessions SET revoked_at='now'", [])
            .unwrap();
        assert!(matches!(
            verify_session(&db, &key, &token, 1),
            Err(AuthError::Revoked)
        ));
    }
    #[test]
    fn pairing_denial_does_not_consume_and_success_is_once() {
        let db = db();
        db.execute("INSERT INTO auth_pairing_links VALUES('id','23456789ABCD','one-time-token','[\"access:read\"]','one-time-token',NULL,'bound','2020','2099',NULL,NULL)", []).unwrap();
        assert!(
            consume_pairing(&db, "23456789abcd", "2025", None, Some("wrong"), None, &[])
                .unwrap()
                .is_none()
        );
        assert!(consume_pairing(
            &db,
            "23456789abcd",
            "2025",
            None,
            Some("bound"),
            Some(&["access:write".into()]),
            &[]
        )
        .unwrap()
        .is_none());
        assert!(consume_pairing(
            &db,
            "23456789abcd",
            "2025",
            None,
            Some("bound"),
            None,
            &["access:write".into()]
        )
        .unwrap()
        .is_none());
        assert!(consume_pairing(
            &db,
            "23456789abcd",
            "2025",
            None,
            Some("bound"),
            Some(&[]),
            &[]
        )
        .unwrap()
        .is_none());
        assert!(consume_pairing(
            &db,
            "23456789abcd",
            "2025",
            None,
            Some("bound"),
            Some(&["access:read".into()]),
            &[]
        )
        .unwrap()
        .is_some());
        assert!(
            consume_pairing(&db, "23456789abcd", "2025", None, Some("bound"), None, &[])
                .unwrap()
                .is_none()
        );
        for _ in 0..20 {
            let code = generate_pairing_code().unwrap();
            assert_eq!(code.len(), 12);
            assert!(code.bytes().all(|c| ALPHABET.contains(&c)));
        }
    }
}
