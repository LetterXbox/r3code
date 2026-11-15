//! Linked-environment transport primitives. Credentials must only be sent to a
//! validated origin and redirects must never forward them to another host.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{net::IpAddr, time::Duration};
use std::{path::Path, sync::Mutex};

const LINK_REDIRECT: &str = "http://127.0.0.1/t3code-peer-link";

#[derive(Debug)]
pub(crate) enum PeerError {
    Transport,
    Rejected,
    InvalidResponse,
    Random,
    Storage,
    SelfLink,
    Incompatible,
    UnknownPeer,
    Unreachable(String),
    RemoteRejected(String),
}

pub(crate) fn wire_error(error: PeerError) -> Value {
    if let PeerError::Unreachable(message) = error {
        return json!({"_tag":"PeerLinkError","reason":"unreachable","message":message});
    }
    if let PeerError::RemoteRejected(message) = error {
        return json!({"_tag":"PeerLinkError","reason":"pairing_rejected","message":message});
    }
    let (reason, message) = match error {
        PeerError::Transport | PeerError::UnknownPeer => (
            "unreachable",
            "The linked environment could not be reached.",
        ),
        PeerError::Rejected => (
            "pairing_rejected",
            "The peer did not approve the link. Check the pairing code and try again.",
        ),
        PeerError::InvalidResponse => (
            "not_a_t3_environment",
            "The peer answered in a shape this version does not understand.",
        ),
        PeerError::SelfLink => ("self", "That address is this environment."),
        PeerError::Incompatible => (
            "incompatible",
            "The peer cannot keep a linked agent's limits. Update it, then link again.",
        ),
        PeerError::Random | PeerError::Storage => (
            "storage",
            "Linked environments could not be read or saved here. The server log has details.",
        ),
        PeerError::Unreachable(_) => unreachable!(),
        PeerError::RemoteRejected(_) => unreachable!(),
    };
    json!({"_tag":"PeerLinkError","reason":reason,"message":message})
}

/// Tokens are intentionally not serializable as part of a link record.
pub(crate) struct IssuedToken {
    pub token: String,
    pub expires_in: u64,
}

pub(crate) struct ResolvedPeer {
    pub origin: String,
    pub token: String,
    pub address: std::net::SocketAddr,
}

static LINK_MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn storage_error<T>(_: T) -> PeerError {
    PeerError::Storage
}

/// Complete a pairing and persist its token separately from the public link.
/// The mutation guard prevents concurrent relinks or unlinks from leaving a
/// row pointing to a removed credential.
pub(crate) async fn link(
    db: &Mutex<rusqlite::Connection>,
    secret_dir: &Path,
    local: &Value,
    input: &Value,
) -> Result<Value, PeerError> {
    use rusqlite::{params, OptionalExtension};
    use std::io::Write;
    let _mutation = LINK_MUTATION.lock().await;
    let raw = input["url"].as_str().ok_or(PeerError::InvalidResponse)?;
    let access = input["access"].as_str().ok_or(PeerError::InvalidResponse)?;
    let code = input["pairingCode"]
        .as_str()
        .ok_or(PeerError::InvalidResponse)?;
    let expected = input["expectedEnvironmentId"].as_str();
    let client = peer_client().map_err(storage_error)?;
    let mut origins = Vec::new();
    let mut urls = vec![raw];
    if let Some(extra) = input.get("alternateUrls") {
        for url in extra.as_array().ok_or(PeerError::InvalidResponse)? {
            urls.push(url.as_str().ok_or(PeerError::InvalidResponse)?);
        }
    }
    let mut chosen: Option<(String, Value, std::net::SocketAddr)> = None;
    for raw in urls {
        let origin = match peer_origin(raw) {
            Ok(origin) => origin,
            Err(_) if expected.is_some() => continue,
            Err("unencrypted address") => return Err(PeerError::Unreachable(format!("{raw} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale address."))),
            Err(_) => return Err(PeerError::Unreachable(format!("{raw} is not an http or https address."))),
        };
        if expected.is_some() {
            let host = url::Url::parse(&origin)
                .ok()
                .and_then(|v| v.host_str().map(str::to_owned))
                .ok_or(PeerError::InvalidResponse)?;
            if host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            {
                continue;
            }
        }
        if expected.is_none() && chosen.is_some() {
            if !origins.contains(&origin) {
                origins.push(origin);
            }
            continue;
        }
        let (peer, address) = match probe_bound(&client, &origin).await {
            Ok(peer) => peer,
            Err(_) if expected.is_some() => continue,
            Err(error) => return Err(error),
        };
        if expected.is_some_and(|id| peer["environmentId"] != id) {
            continue;
        }
        if !origins.contains(&origin) {
            origins.push(origin.clone());
        }
        if chosen.is_none() {
            chosen = Some((origin, peer, address));
        }
    }
    let (origin, peer, address) = chosen.ok_or(PeerError::UnknownPeer)?;
    let peer_id = peer["environmentId"]
        .as_str()
        .ok_or(PeerError::InvalidResponse)?;
    if local["environmentId"] == peer_id {
        return Err(PeerError::SelfLink);
    }
    if peer["capabilities"]["mcpModeLimitHeader"] != true
        || peer["capabilities"]["linkFence"] != true
    {
        return Err(PeerError::Incompatible);
    }
    if expected.is_none() {
        let old: Option<(String, String)> = db
            .lock()
            .map_err(storage_error)?
            .query_row(
                "SELECT urls_json, expires_at FROM peer_environment_links WHERE environment_id=?1",
                [peer_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((urls, expires)) = old {
            let active = chrono::DateTime::parse_from_rfc3339(&expires)
                .is_ok_and(|time| time > chrono::Utc::now());
            let old_urls: Vec<String> = serde_json::from_str(&urls).map_err(storage_error)?;
            if active && !old_urls.contains(&origin) {
                return Err(PeerError::Rejected);
            }
        }
    }
    let pinned = pinned_client(&origin, address, Some(Duration::from_secs(10)))?;
    let issued = sign_in(
        &pinned,
        &origin,
        local["label"].as_str().unwrap_or("T3 Code"),
        code,
        access,
    )
    .await?;
    let now = chrono::Utc::now();
    let duration =
        chrono::Duration::try_seconds(i64::try_from(issued.expires_in).map_err(storage_error)?)
            .ok_or(PeerError::InvalidResponse)?;
    let expires = now
        .checked_add_signed(duration)
        .ok_or(PeerError::InvalidResponse)?;
    let at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let expiry = expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let name = format!("peer-link-{}", uuid::Uuid::new_v4().simple());
    crate::signing_key::secure_secrets_dir(secret_dir).map_err(storage_error)?;
    let path = secret_dir.join(format!("{name}.bin"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let save = (|| -> std::io::Result<()> {
        let mut file = opts.open(&path)?;
        file.write_all(issued.token.as_bytes())?;
        file.sync_all()
    })();
    if save.is_err() {
        let _ = std::fs::remove_file(&path);
        return Err(PeerError::Storage);
    }
    let result = (|| -> Result<Option<String>, PeerError> {
        let mut conn = db.lock().map_err(storage_error)?;
        let tx = conn.transaction().map_err(storage_error)?;
        let previous = tx
            .query_row(
                "SELECT secret_name FROM peer_environment_links WHERE environment_id=?1",
                [peer_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        tx.execute("INSERT INTO peer_environment_links(environment_id,secret_name,label,urls_json,access,linked_at,expires_at,last_reached_at,last_error,fenced) VALUES(?1,?2,?3,?4,?5,?6,?7,?6,NULL,1) ON CONFLICT(environment_id) DO UPDATE SET secret_name=excluded.secret_name,label=excluded.label,urls_json=excluded.urls_json,access=excluded.access,linked_at=excluded.linked_at,expires_at=excluded.expires_at,last_reached_at=excluded.last_reached_at,last_error=NULL,fenced=1", params![peer_id,name,peer["label"].as_str().unwrap_or(""),serde_json::to_string(&origins).map_err(storage_error)?,access,at,expiry]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(previous)
    })();
    let previous = match result {
        Ok(previous) => previous,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
    };
    if let Some(old) = previous.filter(|s| {
        s.starts_with("peer-link-") && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        let _ = std::fs::remove_file(secret_dir.join(format!("{old}.bin")));
    }
    Ok(
        json!({"environmentId":peer_id,"label":peer["label"],"urls":origins,"access":access,"linkedAt":at,"expiresAt":expiry,"lastReachedAt":at,"lastError":null}),
    )
}

/// Forget a link and remove the separately stored credential.
pub(crate) async fn unlink(
    db: &Mutex<rusqlite::Connection>,
    secret_dir: &Path,
    id: &str,
) -> Result<bool, PeerError> {
    use rusqlite::OptionalExtension;
    let _mutation = LINK_MUTATION.lock().await;
    let name: Option<String> = db
        .lock()
        .map_err(storage_error)?
        .query_row(
            "DELETE FROM peer_environment_links WHERE environment_id=?1 RETURNING secret_name",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(name) = &name {
        if !name.starts_with("peer-link-")
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(PeerError::Storage);
        }
        match std::fs::remove_file(secret_dir.join(format!("{name}.bin"))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage_error(error)),
        }
    }
    Ok(name.is_some())
}

/// Read public link metadata and probe each peer concurrently without exposing tokens.
pub(crate) async fn list(db: &Mutex<rusqlite::Connection>) -> Result<Vec<Value>, PeerError> {
    use futures_util::{stream::FuturesUnordered, StreamExt};
    let records = {
        let conn = db.lock().map_err(storage_error)?;
        let mut statement = conn.prepare("SELECT environment_id,label,urls_json,access,linked_at,expires_at,last_reached_at,last_error,fenced FROM peer_environment_links ORDER BY label,environment_id").map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })
            .map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
    };
    let client = peer_client().map_err(storage_error)?;
    let futures = records.into_iter().map(|(id,label,raw_urls,access,linked_at,expires_at,last_reached,last_error,fenced)| {
        let client = client.clone();
        async move {
            let urls: Vec<String> = serde_json::from_str(&raw_urls).map_err(storage_error)?;
            let expiry = if fenced == 1 { expires_at.clone() } else { linked_at.clone() };
            let expired = chrono::DateTime::parse_from_rfc3339(&expiry).map_err(storage_error)? <= chrono::Utc::now();
            let mut found = None;
            if !expired {
                let probes: FuturesUnordered<_> = urls.iter().map(|url| probe(&client,url)).collect();
                let mut probes = probes;
                found = tokio::time::timeout(Duration::from_secs(3), async {
                    while let Some(result) = probes.next().await {
                        if let Ok(peer) = result {
                            if peer["environmentId"] == id { return Some(peer); }
                        }
                    }
                    None
                }).await.ok().flatten();
            }
            let actual_label = found.as_ref().and_then(|v| v["label"].as_str()).unwrap_or(&label).to_owned();
            let status = if expired { "expired" } else if found.is_some() { "reachable" } else { "unreachable" };
            Ok::<_,PeerError>((id.clone(),actual_label.clone(),json!({"environmentId":id,"label":actual_label,"urls":urls,"access":access,"linkedAt":linked_at,"expiresAt":expiry,"lastReachedAt":last_reached,"lastError":last_error,"status":status})))
        }
    });
    let rows = futures_util::future::join_all(futures)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let conn = db.lock().map_err(storage_error)?;
    for (id, label, _) in &rows {
        let _ = conn.execute(
            "UPDATE peer_environment_links SET label=?1 WHERE environment_id=?2",
            rusqlite::params![label, id],
        );
    }
    Ok(rows.into_iter().map(|(_, _, value)| value).collect())
}

/// Resolve a stored link only after the selected address proves its identity.
/// The caller may then use the credential for that exact origin.
pub(crate) async fn resolve(
    db: &Mutex<rusqlite::Connection>,
    secret_dir: &Path,
    id: &str,
) -> Result<ResolvedPeer, PeerError> {
    use rusqlite::OptionalExtension;
    let (name, urls, expiry, fenced): (String, String, String, i64) = db.lock().map_err(storage_error)?.query_row(
        "SELECT secret_name,urls_json,expires_at,fenced FROM peer_environment_links WHERE environment_id=?1", [id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
    ).optional().map_err(storage_error)?.ok_or(PeerError::UnknownPeer)?;
    if fenced != 1
        || chrono::DateTime::parse_from_rfc3339(&expiry).map_err(storage_error)?
            <= chrono::Utc::now()
    {
        return Err(PeerError::Rejected);
    }
    if !name.starts_with("peer-link-")
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(PeerError::Storage);
    }
    let urls: Vec<String> = serde_json::from_str(&urls).map_err(storage_error)?;
    let client = peer_client().map_err(storage_error)?;
    for origin in urls {
        let (peer, address) = match probe_bound(&client, &origin).await {
            Ok((peer, address)) if peer["environmentId"] == id => (peer, address),
            _ => continue,
        };
        if peer["capabilities"]["mcpModeLimitHeader"] != true
            || peer["capabilities"]["linkFence"] != true
        {
            return Err(PeerError::Incompatible);
        }
        let path = secret_dir.join(format!("{name}.bin"));
        let metadata = std::fs::metadata(&path).map_err(storage_error)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 {
            return Err(PeerError::Storage);
        }
        let token = std::fs::read_to_string(path).map_err(storage_error)?;
        if token.is_empty() {
            return Err(PeerError::Storage);
        }
        let current: Option<(String, String)> = db.lock().map_err(storage_error)?.query_row(
            "SELECT secret_name,expires_at FROM peer_environment_links WHERE environment_id=?1 AND fenced=1", [id], |row| Ok((row.get(0)?,row.get(1)?))
        ).optional().map_err(storage_error)?;
        let Some((current_name, current_expiry)) = current else {
            return Err(PeerError::UnknownPeer);
        };
        if current_name != name {
            return Err(PeerError::UnknownPeer);
        }
        if chrono::DateTime::parse_from_rfc3339(&current_expiry).map_err(storage_error)?
            <= chrono::Utc::now()
        {
            return Err(PeerError::Rejected);
        }
        return Ok(ResolvedPeer {
            origin,
            token,
            address,
        });
    }
    Err(PeerError::Transport)
}

pub(crate) fn get_usable_link(
    db: &Mutex<rusqlite::Connection>,
    environment_id: &str,
) -> Result<Option<Value>, PeerError> {
    use rusqlite::OptionalExtension;
    let row: Option<(String, String, String, i64)> = db
        .lock()
        .map_err(storage_error)?
        .query_row(
            "SELECT label, access, expires_at, fenced FROM peer_environment_links WHERE environment_id=?1",
            [environment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((label, access, expiry, fenced)) = row else {
        return Ok(None);
    };
    if fenced != 1 {
        return Ok(None);
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&expiry).map_err(storage_error)?;
    if expires_at <= chrono::Utc::now() {
        return Ok(None);
    }
    Ok(Some(json!({
        "environmentId": environment_id,
        "label": label,
        "access": access,
    })))
}

/// Recheck the row and credential immediately before an already-resolved
/// request; unlink, expiry or relinking invalidate the pending operation.
pub(crate) fn recheck(
    db: &Mutex<rusqlite::Connection>,
    secret_dir: &Path,
    id: &str,
    peer: &ResolvedPeer,
) -> Result<(), PeerError> {
    use rusqlite::OptionalExtension;
    let row: Option<(String, String, String, i64)> = db.lock().map_err(storage_error)?.query_row(
        "SELECT secret_name,urls_json,expires_at,fenced FROM peer_environment_links WHERE environment_id=?1", [id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
    ).optional().map_err(storage_error)?;
    let (name, urls, expiry, fenced) = row.ok_or(PeerError::UnknownPeer)?;
    if fenced != 1
        || chrono::DateTime::parse_from_rfc3339(&expiry).map_err(storage_error)?
            <= chrono::Utc::now()
    {
        return Err(PeerError::Rejected);
    }
    if !name.starts_with("peer-link-")
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(PeerError::Storage);
    }
    let urls: Vec<String> = serde_json::from_str(&urls).map_err(storage_error)?;
    if !urls.contains(&peer.origin) {
        return Err(PeerError::UnknownPeer);
    }
    let path = secret_dir.join(format!("{name}.bin"));
    let metadata = std::fs::metadata(&path).map_err(storage_error)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 {
        return Err(PeerError::Storage);
    }
    if std::fs::read_to_string(path).map_err(storage_error)? != peer.token {
        return Err(PeerError::UnknownPeer);
    }
    Ok(())
}

/// Normalize a peer address to its origin, enforcing the upstream transport
/// policy before a pairing code or a stored access token can be sent.
pub(crate) fn peer_origin(input: &str) -> Result<String, &'static str> {
    let parsed = url::Url::parse(input).map_err(|_| "invalid address")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("invalid address");
    }
    let host = parsed.host_str().ok_or("invalid address")?;
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let local = host == "localhost"
        || host.parse::<IpAddr>().is_ok_and(|ip| match ip {
            IpAddr::V4(v4) => v4.is_loopback(),
            IpAddr::V6(v6) => v6.is_loopback(),
        });
    let tailnet = host.ends_with(".ts.net")
        || host.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| {
            let segments = ip.segments();
            segments[0..3] == [0xfd7a, 0x115c, 0xa1e0]
        });
    if parsed.scheme() == "http" && !local && !tailnet {
        return Err("unencrypted address");
    }
    Ok(parsed.origin().ascii_serialization())
}

/// A dedicated client avoids following redirects with peer credentials.
pub(crate) fn peer_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
}

pub(crate) fn pinned_client(
    origin: &str,
    address: std::net::SocketAddr,
    timeout: Option<Duration>,
) -> Result<reqwest::Client, PeerError> {
    let url = url::Url::parse(origin).map_err(|_| PeerError::InvalidResponse)?;
    let host = url
        .host_str()
        .ok_or(PeerError::InvalidResponse)?
        .trim_matches(['[', ']']);
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve(host, address);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|_| PeerError::Transport)
}

async fn json_response(mut response: reqwest::Response) -> Result<Value, PeerError> {
    if !response.status().is_success() {
        return Err(PeerError::Rejected);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PeerError::Transport)? {
        if body.len().saturating_add(chunk.len()) > 128 * 1024 {
            return Err(PeerError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| PeerError::InvalidResponse)
}

async fn oauth_response(
    mut response: reqwest::Response,
    stage: &str,
    pairing_code: &str,
) -> Result<Value, PeerError> {
    let success = response.status().is_success();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PeerError::Transport)? {
        if body.len().saturating_add(chunk.len()) > 128 * 1024 {
            return Err(PeerError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| PeerError::InvalidResponse)?;
    if success {
        return Ok(value);
    }
    let field = if stage == "decision" {
        "message"
    } else {
        "error_description"
    };
    let Some(message) = value[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
    else {
        return Err(PeerError::Rejected);
    };
    let message = message.replace(pairing_code, "[redacted]");
    let message = match stage {
        "register" => format!("The peer refused to register this environment: {message}"),
        "token" => format!("The peer refused the sign-in: {message}"),
        _ => message,
    };
    Err(PeerError::RemoteRejected(message))
}

/// Read a peer's public descriptor before any credential is sent. Callers
/// compare its environment ID with the intended target and check capabilities.
pub(crate) async fn probe(client: &reqwest::Client, origin: &str) -> Result<Value, PeerError> {
    probe_bound(client, origin).await.map(|(value, _)| value)
}

async fn probe_bound(
    client: &reqwest::Client,
    origin: &str,
) -> Result<(Value, std::net::SocketAddr), PeerError> {
    if peer_origin(origin).ok().as_deref() != Some(origin) {
        return Err(PeerError::InvalidResponse);
    }
    let host = url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .ok_or(PeerError::InvalidResponse)?;
    let normalized_host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let timeout = if normalized_host == "localhost"
        || normalized_host
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    {
        Duration::from_secs(3)
    } else {
        Duration::from_secs(10)
    };
    let request = async {
        let response = client
            .get(format!("{origin}/.well-known/t3/environment"))
            .send()
            .await
            .map_err(|_| PeerError::Transport)?;
        let address = response.remote_addr().ok_or(PeerError::Transport)?;
        let value = json_response(response).await?;
        Ok::<_, PeerError>((value, address))
    };
    let (value, address) = tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| PeerError::Transport)??;
    for key in ["environmentId", "label", "serverVersion"] {
        if value[key].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(PeerError::InvalidResponse);
        }
    }
    if !matches!(
        value["platform"]["os"].as_str(),
        Some("darwin" | "linux" | "windows" | "unknown")
    ) || !matches!(
        value["platform"]["arch"].as_str(),
        Some("arm64" | "x64" | "other")
    ) || !value["capabilities"].is_object()
    {
        return Err(PeerError::InvalidResponse);
    }
    if origin.starts_with("http://") {
        if normalized_host == "localhost" && !address.ip().is_loopback() {
            return Err(PeerError::Transport);
        }
        if normalized_host.ends_with(".ts.net") {
            let tailnet = match address.ip() {
                IpAddr::V4(ip) => ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]),
                IpAddr::V6(ip) => ip.segments()[0..3] == [0xfd7a, 0x115c, 0xa1e0],
            };
            if !tailnet {
                return Err(PeerError::Transport);
            }
        }
    }
    Ok((value, address))
}

/// Exchange a peer pairing code for an MCP access token with PKCE. The caller
/// must first verify that this origin answers as the intended environment.
pub(crate) async fn sign_in(
    client: &reqwest::Client,
    origin: &str,
    client_label: &str,
    pairing_code: &str,
    access: &str,
) -> Result<IssuedToken, PeerError> {
    if peer_origin(origin).ok().as_deref() != Some(origin)
        || !matches!(
            access,
            "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access"
        )
        || pairing_code.trim().is_empty()
    {
        return Err(PeerError::InvalidResponse);
    }
    let registered = oauth_response(client.post(format!("{origin}/oauth/mcp/register"))
        .header("content-type", "application/json")
        .body(json!({"client_name":format!("T3 Code · {client_label}"),"redirect_uris":[LINK_REDIRECT],"software_id":"t3code-peer-link"}).to_string())
        .send().await.map_err(|_| PeerError::Transport)?, "register", pairing_code).await?;
    let client_id = registered["client_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(PeerError::InvalidResponse)?;
    let mut random = [0u8; 48];
    getrandom::fill(&mut random).map_err(|_| PeerError::Random)?;
    let verifier = URL_SAFE_NO_PAD.encode(&random[..32]);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = URL_SAFE_NO_PAD.encode(&random[32..]);
    let resource = format!("{origin}/mcp");
    let decision = oauth_response(client.post(format!("{origin}/oauth/mcp/decision"))
        .header("content-type", "application/json")
        .body(json!({"authorization":{"response_type":"code","client_id":client_id,"redirect_uri":LINK_REDIRECT,"code_challenge":challenge,"code_challenge_method":"S256","state":state,"resource":resource},"decision":{"_tag":"pairing-code","access":access,"code":pairing_code}}).to_string())
        .send().await.map_err(|_| PeerError::Transport)?, "decision", pairing_code).await?;
    let redirect = url::Url::parse(
        decision["redirectTo"]
            .as_str()
            .ok_or(PeerError::InvalidResponse)?,
    )
    .map_err(|_| PeerError::InvalidResponse)?;
    if redirect.origin().ascii_serialization() != "http://127.0.0.1"
        || redirect.path() != "/t3code-peer-link"
    {
        return Err(PeerError::InvalidResponse);
    }
    let pairs: Vec<_> = redirect.query_pairs().into_owned().collect();
    let query = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    };
    if query("state") != Some(&state) {
        return Err(PeerError::Rejected);
    }
    let code = query("code")
        .filter(|s| !s.is_empty())
        .ok_or(PeerError::Rejected)?;
    let token = oauth_response(
        client
            .post(format!("{origin}/oauth/mcp/token"))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", LINK_REDIRECT),
                ("client_id", client_id),
                ("code_verifier", verifier.as_str()),
                ("resource", resource.as_str()),
            ])
            .send()
            .await
            .map_err(|_| PeerError::Transport)?,
        "token",
        pairing_code,
    )
    .await?;
    let access_token = token["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(PeerError::InvalidResponse)?;
    if token["token_type"] != "Bearer" {
        return Err(PeerError::InvalidResponse);
    }
    let expires_in = token["expires_in"]
        .as_u64()
        .filter(|&n| n > 0)
        .ok_or(PeerError::InvalidResponse)?;
    Ok(IssuedToken {
        token: access_token.to_owned(),
        expires_in,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_limited_to_secure_or_tailnet_origins() {
        assert_eq!(
            peer_origin("https://example.com/path?q=secret").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            peer_origin("http://127.0.0.2:1234/path").unwrap(),
            "http://127.0.0.2:1234"
        );
        assert!(peer_origin("http://device.example.ts.net/").is_ok());
        assert!(peer_origin("http://[fd7a:115c:a1e0::1]:80/").is_ok());
        assert!(peer_origin("http://100.64.1.2/").is_err());
        assert!(peer_origin("http://example.com/").is_err());
        assert!(peer_origin("file:///etc/passwd").is_err());
    }

    #[tokio::test]
    async fn pairing_exchange_binds_code_to_pkce_and_state() {
        use axum::{
            extract::State,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::{Arc, Mutex};
        let seen = Arc::new(Mutex::new(None::<String>));
        let app = Router::new()
            .route("/.well-known/t3/environment", get(|| async { Json(json!({"environmentId":"peer-1","label":"Peer","platform":{"os":"linux","arch":"x64"},"serverVersion":"1","capabilities":{"mcpModeLimitHeader":true,"linkFence":true}})) }))
            .route("/oauth/mcp/register", post(|| async { Json(json!({"client_id":"client"})) }))
            .route("/oauth/mcp/decision", post(|State(seen): State<Arc<Mutex<Option<String>>>>, Json(input): Json<Value>| async move {
                assert_eq!(input["decision"]["code"], "fixture-code");
                *seen.lock().unwrap() = input["authorization"]["code_challenge"].as_str().map(str::to_owned);
                let state = input["authorization"]["state"].as_str().unwrap();
                Json(json!({"redirectTo":format!("{LINK_REDIRECT}?code=fixture-authorization&state={state}")}))
            }))
            .route("/oauth/mcp/token", post(|State(seen): State<Arc<Mutex<Option<String>>>>, body: String| async move {
                let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
                assert_eq!(form["code"], "fixture-authorization");
                assert_eq!(*seen.lock().unwrap(), Some(URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes()))));
                Json(json!({"access_token":"fixture-token","token_type":"Bearer","expires_in":3600,"scope":"mcp"}))
            }))
            .with_state(seen);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert_eq!(
            probe(&peer_client().unwrap(), &origin).await.unwrap()["environmentId"],
            "peer-1"
        );
        let token = sign_in(
            &peer_client().unwrap(),
            &origin,
            "local",
            "fixture-code",
            "read-only",
        )
        .await
        .unwrap();
        assert_eq!(token.token, "fixture-token");
        assert_eq!(token.expires_in, 3600);
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE peer_environment_links(environment_id TEXT PRIMARY KEY,secret_name TEXT NOT NULL,label TEXT NOT NULL,urls_json TEXT NOT NULL,access TEXT NOT NULL,linked_at TEXT NOT NULL,expires_at TEXT NOT NULL,last_reached_at TEXT,last_error TEXT,fenced INTEGER NOT NULL DEFAULT 0)").unwrap();
        let db = Mutex::new(conn);
        let dir = std::env::temp_dir().join(format!("peer-link-test-{}", uuid::Uuid::new_v4()));
        let local = json!({"environmentId":"local-1","label":"Local"});
        let input = json!({"url":origin,"pairingCode":"fixture-code","access":"read-only"});
        let first = link(&db, &dir, &local, &input).await.unwrap();
        assert_eq!(first["environmentId"], "peer-1");
        assert!(!first.to_string().contains("fixture-token"));
        let first_secret: String = db
            .lock()
            .unwrap()
            .query_row("SELECT secret_name FROM peer_environment_links", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("{first_secret}.bin"))).unwrap(),
            "fixture-token"
        );
        link(&db, &dir, &local, &input).await.unwrap();
        assert!(!dir.join(format!("{first_secret}.bin")).exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let links = list(&db).await.unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["status"], "reachable");
        assert!(!links[0].to_string().contains("fixture-token"));
        let resolved = resolve(&db, &dir, "peer-1").await.unwrap();
        assert_eq!(resolved.origin, origin);
        assert_eq!(resolved.token, "fixture-token");
        assert!(recheck(&db, &dir, "peer-1", &resolved).is_ok());
        db.lock()
            .unwrap()
            .execute("UPDATE peer_environment_links SET fenced=0", [])
            .unwrap();
        assert_eq!(list(&db).await.unwrap()[0]["status"], "expired");
        assert!(matches!(
            recheck(&db, &dir, "peer-1", &resolved),
            Err(PeerError::Rejected)
        ));
        assert!(matches!(
            resolve(&db, &dir, "peer-1").await,
            Err(PeerError::Rejected)
        ));
        assert!(unlink(&db, &dir, "peer-1").await.unwrap());
        assert!(matches!(
            recheck(&db, &dir, "peer-1", &resolved),
            Err(PeerError::UnknownPeer)
        ));
        assert!(!unlink(&db, &dir, "peer-1").await.unwrap());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn peer_rejection_does_not_echo_pairing_code() {
        use axum::{routing::post, Json, Router};
        let app = Router::new()
            .route(
                "/oauth/mcp/register",
                post(|| async { Json(json!({"client_id":"client"})) }),
            )
            .route(
                "/oauth/mcp/decision",
                post(|| async {
                    (
                        axum::http::StatusCode::BAD_REQUEST,
                        Json(json!({"message":"bad secret-code"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = sign_in(
            &peer_client().unwrap(),
            &origin,
            "local",
            "secret-code",
            "read-only",
        )
        .await
        .err()
        .unwrap();
        let output = wire_error(error).to_string();
        assert!(!output.contains("secret-code"));
        assert!(output.contains("[redacted]"));
        server.abort();
    }

    #[tokio::test]
    async fn resolution_refuses_peer_that_no_longer_enforces_limits() {
        use axum::{routing::get, Json, Router};
        let app = Router::new().route("/.well-known/t3/environment", get(|| async { Json(json!({"environmentId":"peer","label":"Peer","platform":{"os":"linux","arch":"x64"},"serverVersion":"1","capabilities":{"mcpModeLimitHeader":true,"linkFence":false}})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE peer_environment_links(environment_id TEXT PRIMARY KEY,secret_name TEXT,urls_json TEXT,expires_at TEXT,fenced INTEGER)").unwrap();
        conn.execute("INSERT INTO peer_environment_links VALUES('peer','peer-link-fixture',?1,'2999-01-01T00:00:00Z',1)", [json!([origin]).to_string()]).unwrap();
        let db = Mutex::new(conn);
        // No credential exists: capability rejection must happen before a token is read.
        assert!(matches!(
            resolve(&db, Path::new("/nonexistent"), "peer").await,
            Err(PeerError::Incompatible)
        ));
        server.abort();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn pinned_client_connects_to_verified_address() {
        use axum::{routing::get, Router};
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = first.local_addr().unwrap().port();
        let second = tokio::net::TcpListener::bind(("127.0.0.2", port))
            .await
            .unwrap();
        let verified = second.local_addr().unwrap();
        let one = tokio::spawn(async move {
            axum::serve(
                first,
                Router::new().route("/", get(|| async { "unverified" })),
            )
            .await
            .unwrap()
        });
        let two = tokio::spawn(async move {
            axum::serve(
                second,
                Router::new().route("/", get(|| async { "verified" })),
            )
            .await
            .unwrap()
        });
        let origin = format!("http://localhost:{port}");
        let client = pinned_client(&origin, verified, Some(Duration::from_secs(3))).unwrap();
        assert_eq!(
            client
                .get(&origin)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "verified"
        );
        one.abort();
        two.abort();
    }
}
