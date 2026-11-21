//! OAuth MCP client authentication and request-mode narrowing. The MCP router
//! does not yet admit these clients; its tool handlers must first enforce the
//! distinct client scope and linked-origin fence.
use crate::auth;
use rusqlite::{Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Client {
    pub session_id: String,
    pub label: String,
    pub access: String,
    pub linked: bool,
    pub link_expires_at: Option<String>,
}

/// Authenticate only MCP-client bearer sessions, never provider, browser, or
/// DPoP credentials. Token signature, expiry and revocation are verified by
/// the same session verifier used elsewhere in the server.
pub(crate) fn authenticate(db: &Connection, signing_key: &[u8; 32], authorization: &str, now_ms: i64) -> Option<Client> {
    let (scheme, token) = authorization.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.trim().is_empty() { return None; }
    let principal = auth::verify_session(db, signing_key, token.trim(), now_ms).ok()?;
    if principal.subject != "mcp-client" || principal.method != "bearer-access-token" { return None; }
    let label: Option<String> = db.query_row("SELECT client_label FROM auth_sessions WHERE session_id=?1", [&principal.session_id], |row| row.get(0)).optional().ok().flatten().flatten();
    let access = if principal.scopes.iter().any(|s| s == "orchestration:operate") {
        principal.rtc.unwrap_or_else(|| "approval-required".to_owned())
    } else { "read-only".to_owned() };
    let link_expires_at = if principal.peer_link {
        Some(
            auth::extend_peer_link_session(db, &principal.session_id, now_ms)
                .ok()
                .flatten()?,
        )
    } else {
        None
    };
    Some(Client { session_id:principal.session_id, label:label.unwrap_or_else(|| "MCP client".into()), access, linked:principal.peer_link, link_expires_at })
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RuntimeMode { ApprovalRequired, AutoAcceptEdits, Auto, FullAccess }
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum InteractionMode { Plan, Default }
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(crate) struct Modes { pub runtime:RuntimeMode, pub interaction:InteractionMode }

impl RuntimeMode {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value { "approval-required"=>Some(Self::ApprovalRequired), "auto-accept-edits"=>Some(Self::AutoAcceptEdits), "auto"=>Some(Self::Auto), "full-access"=>Some(Self::FullAccess), _=>None }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ApprovalRequired => "approval-required",
            Self::AutoAcceptEdits => "auto-accept-edits",
            Self::Auto => "auto",
            Self::FullAccess => "full-access",
        }
    }
}

impl InteractionMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Default => "default",
        }
    }
}

pub(crate) fn parse_mode_limit(value: &str) -> Option<Modes> {
    let (runtime, interaction) = value.trim().split_once('/')?;
    let interaction = match interaction { "plan"=>InteractionMode::Plan, "default"=>InteractionMode::Default, _=>return None };
    Some(Modes { runtime:RuntimeMode::parse(runtime)?, interaction })
}

/// A requested limit and a managed-policy ceiling can narrow but never widen
/// the client's approved runtime or interaction modes.
pub(crate) fn mode_ceiling(access: &str, requested: Option<Modes>, policy: Option<RuntimeMode>) -> Option<Modes> {
    let approved = if access == "read-only" { RuntimeMode::ApprovalRequired } else { RuntimeMode::parse(access)? };
    let requested = requested.unwrap_or(Modes { runtime:approved, interaction:InteractionMode::Default });
    Some(Modes { runtime:approved.min(requested.runtime).min(policy.unwrap_or(RuntimeMode::FullAccess)), interaction:requested.interaction })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_session_revocation_and_mode_ceiling_are_enforced() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let db = std::sync::Mutex::new(db);
        let key = [7;32];
        let granted = crate::mcp_oauth::GrantedCode { access:"auto".into(), peer_link:true, label:"Remote".into() };
        let token = crate::mcp_oauth::issue_session(&db, &key, granted, 1_800_000_000_000).unwrap()["access_token"].as_str().unwrap().to_owned();
        let guard = db.lock().unwrap();
        let client = authenticate(&guard, &key, &format!("bEaReR {token}"), 1_800_000_000_001).unwrap();
        assert_eq!((client.access.as_str(),client.label.as_str(),client.linked), ("auto","Remote",true));
        assert!(authenticate(&guard, &key, &format!("DPoP {token}"), 1_800_000_000_001).is_none());
        let mut user = crate::auth::SessionClaims { v:1,kind:"session".into(),sid:client.session_id.clone(),sub:"user".into(),scopes:vec![],method:"bearer-access-token".into(),jkt:None,rtc:None,plk:None,iat:1_800_000_000_000,exp:1_800_000_100_000 };
        let user_token = crate::auth::sign_session(&key, &user).unwrap();
        assert!(authenticate(&guard, &key, &format!("Bearer {user_token}"), 1_800_000_000_001).is_none());
        user.sub = "mcp-client".into(); user.method = "browser-session-cookie".into();
        let cookie_token = crate::auth::sign_session(&key, &user).unwrap();
        assert!(authenticate(&guard, &key, &format!("Bearer {cookie_token}"), 1_800_000_000_001).is_none());
        let asked = parse_mode_limit(" full-access/plan ").unwrap();
        assert_eq!(mode_ceiling(&client.access,Some(asked),Some(RuntimeMode::AutoAcceptEdits)),Some(Modes { runtime:RuntimeMode::AutoAcceptEdits,interaction:InteractionMode::Plan }));
        assert!(parse_mode_limit("auto/default/extra").is_none());
        guard.execute("UPDATE auth_sessions SET revoked_at='2020' WHERE session_id=?1",[&client.session_id]).unwrap();
        assert!(authenticate(&guard, &key, &format!("Bearer {token}"), 1_800_000_000_001).is_none());
    }
}
