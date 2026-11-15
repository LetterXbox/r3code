//! Access-management snapshots and live updates.
use crate::{auth::Principal, auth_http::AuthHttpState, authorization};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};

/// Shared change signal and active WebSocket reference counts.
pub struct Lifecycle {
    changes: tokio::sync::watch::Sender<u64>,
    connected: Mutex<HashMap<String, usize>>,
}
impl Default for Lifecycle {
    fn default() -> Self {
        let (changes, _) = tokio::sync::watch::channel(0);
        Self {
            changes,
            connected: Mutex::new(HashMap::new()),
        }
    }
}
impl Lifecycle {
    pub fn notify(&self) {
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }
    pub fn connected(&self, id: &str) -> bool {
        self.connected
            .lock()
            .map(|m| m.contains_key(id))
            .unwrap_or(false)
    }
    pub fn connect(&self, id: &str) {
        if let Ok(mut m) = self.connected.lock() {
            *m.entry(id.to_owned()).or_default() += 1;
        }
        self.notify();
    }
    pub fn disconnect(&self, id: &str) {
        if let Ok(mut m) = self.connected.lock() {
            if let Some(n) = m.get_mut(id) {
                *n -= 1;
                if *n == 0 {
                    m.remove(id);
                }
            }
        }
        self.notify();
    }
}

fn snapshot(state: &AuthHttpState, current: &str) -> Result<(Vec<Value>, Vec<Value>), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT id,scopes,subject,label,created_at,expires_at FROM auth_pairing_links WHERE revoked_at IS NULL AND consumed_at IS NULL AND julianday(expires_at)>julianday('now') AND subject != 'administrative-bootstrap' AND subject NOT LIKE 'mcp-approval:%' ORDER BY created_at DESC,id").map_err(|e| e.to_string())?;
    let links = stmt.query_map([], |r| {
        let raw: String = r.get(1)?;
        let scopes: Vec<String> = serde_json::from_str(&raw).map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?;
        let mut v = json!({"id":r.get::<_,String>(0)?,"scopes":authorization::legacy_scopes(&scopes),"permissions":scopes,"subject":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(4)?,"expiresAt":r.get::<_,String>(5)?});
        if let Some(label) = r.get::<_,Option<String>>(3)? { v["label"] = json!(label); }
        Ok(v)
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT session_id,subject,scopes,method,client_label,client_ip_address,client_user_agent,client_device_type,client_os,client_browser,issued_at,expires_at,last_connected_at FROM auth_sessions WHERE revoked_at IS NULL AND julianday(expires_at)>julianday('now') ORDER BY CASE WHEN EXISTS (SELECT 1 FROM json_each(auth_sessions.scopes) WHERE value='access:write') THEN 0 ELSE 1 END,issued_at DESC,session_id").map_err(|e| e.to_string())?;
    let sessions = stmt.query_map([], |r| {
        let raw: String = r.get(2)?;
        let scopes: Vec<String> = serde_json::from_str(&raw).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?;
        let sid: String = r.get(0)?;
        let mut client = json!({"deviceType":r.get::<_,String>(7)?});
        for (key,index) in [("label",4),("ipAddress",5),("userAgent",6),("os",8),("browser",9)] { if let Some(value) = r.get::<_,Option<String>>(index)? { client[key] = json!(value); } }
        Ok(json!({"sessionId":sid,"subject":r.get::<_,String>(1)?,"scopes":authorization::legacy_scopes(&scopes),"permissions":scopes,"method":r.get::<_,String>(3)?,"client":client,"issuedAt":r.get::<_,String>(10)?,"expiresAt":r.get::<_,String>(11)?,"lastConnectedAt":r.get::<_,Option<String>>(12)?,"connected":state.lifecycle.connected(&sid),"current":sid==current}))
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    Ok((links, sessions))
}
fn next_expiry(state: &AuthHttpState) -> Duration {
    let Ok(db) = state.db.lock() else {
        return Duration::from_secs(60);
    };
    let seconds: Option<f64> = db.query_row("SELECT min(seconds) FROM (SELECT (julianday(expires_at)-julianday('now'))*86400 AS seconds FROM auth_sessions WHERE revoked_at IS NULL AND julianday(expires_at)>julianday('now') UNION ALL SELECT (julianday(expires_at)-julianday('now'))*86400 FROM auth_pairing_links WHERE revoked_at IS NULL AND consumed_at IS NULL AND julianday(expires_at)>julianday('now'))", [], |r| r.get(0)).unwrap_or(None);
    seconds
        .map(|s| Duration::from_secs_f64((s + 0.01).max(0.01)))
        .unwrap_or(Duration::from_secs(86400))
}
fn indexed(items: Vec<Value>, key: &str) -> BTreeMap<String, Value> {
    items
        .into_iter()
        .filter_map(|v| Some((v.get(key)?.as_str()?.to_owned(), v)))
        .collect()
}
pub fn stream(
    state: Arc<AuthHttpState>,
    principal: Principal,
) -> tokio::sync::mpsc::Receiver<Result<Vec<Value>, Value>> {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        let mut changes = state.lifecycle.subscribe();
        let (links, sessions) = match snapshot(&state, &principal.session_id) {
            Ok(v) => v,
            Err(message) => {
                let _ = tx
                    .send(Err(
                        json!({"_tag":"AuthAccessStreamError","message":message}),
                    ))
                    .await;
                return;
            }
        };
        if tx.send(Ok(vec![json!({"version":1,"revision":1,"type":"snapshot","payload":{"pairingLinks":links,"clientSessions":sessions}})])).await.is_err() { return; }
        let mut previous = [indexed(links, "id"), indexed(sessions, "sessionId")];
        let mut revision = 1;
        loop {
            tokio::select! { _ = tx.closed() => break, result = changes.changed() => if result.is_err() { break; }, _ = tokio::time::sleep(next_expiry(&state)) => {} }
            let (links, sessions) = match snapshot(&state, &principal.session_id) {
                Ok(v) => v,
                Err(message) => {
                    let _ = tx
                        .send(Err(
                            json!({"_tag":"AuthAccessStreamError","message":message}),
                        ))
                        .await;
                    break;
                }
            };
            let next = [indexed(links, "id"), indexed(sessions, "sessionId")];
            for i in 0..2 {
                for (id, value) in &next[i] {
                    if previous[i].get(id) != Some(value) {
                        revision += 1;
                        let kind = if i == 0 {
                            "pairingLinkUpserted"
                        } else {
                            "clientUpserted"
                        };
                        if tx.send(Ok(vec![json!({"version":1,"revision":revision,"type":kind,"payload":value})])).await.is_err() {return;}
                    }
                }
                for id in previous[i].keys().filter(|id| !next[i].contains_key(*id)) {
                    revision += 1;
                    let (kind, payload) = if i == 0 {
                        ("pairingLinkRemoved", json!({"id":id}))
                    } else {
                        ("clientRemoved", json!({"sessionId":id}))
                    };
                    if tx
                        .send(Ok(vec![
                            json!({"version":1,"revision":revision,"type":kind,"payload":payload}),
                        ]))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            previous = next;
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Mutex;
    fn state() -> Arc<AuthHttpState> {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/031.sql"))
            .unwrap();
        db.execute_batch("INSERT INTO auth_pairing_links VALUES ('p','secret','one-time-token','[\"access:read\"]','user',NULL,'2020-01-01T00:00:00Z','2999-01-01T00:00:00Z',NULL,NULL); INSERT INTO auth_pairing_links VALUES ('hidden','hidden-secret','one-time-token','[]','administrative-bootstrap',NULL,'2020-01-01T00:00:00Z','2999-01-01T00:00:00Z',NULL,NULL); INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES ('s','user','[\"access:read\"]','bearer-access-token','2020-01-01T00:00:00Z','2999-01-01T00:00:00Z');").unwrap();
        Arc::new(AuthHttpState {
            replay_dir: std::env::temp_dir().join(format!("t3-dpop-test-{}", uuid::Uuid::new_v4())),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: Mutex::new(db),
            signing_key: [0; 32],
            descriptor: json!({}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        })
    }
    #[tokio::test]
    async fn connection_counts_drive_stream_updates() {
        let state = state();
        let principal = Principal {
            session_id: "s".into(),
            subject: "user".into(),
            scopes: vec!["access:read".into()],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            peer_link: false,
        };
        let mut stream = stream(state.clone(), principal);
        stream.recv().await.unwrap().unwrap();
        state.lifecycle.connect("s");
        let event = tokio::time::timeout(Duration::from_secs(1), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .remove(0);
        assert_eq!(event["payload"]["connected"], true);
        state.lifecycle.connect("s");
        state.lifecycle.disconnect("s");
        assert!(state.lifecycle.connected("s"));
        state.lifecycle.disconnect("s");
        let event = tokio::time::timeout(Duration::from_secs(1), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .remove(0);
        assert_eq!(event["payload"]["connected"], false);
    }
    #[tokio::test]
    async fn snapshot_redacts_credentials_and_streams_revocation() {
        let state = state();
        let principal = Principal {
            session_id: "s".into(),
            subject: "user".into(),
            scopes: vec!["access:read".into()],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            peer_link: false,
        };
        let mut stream = stream(state.clone(), principal);
        let initial = stream.recv().await.unwrap().unwrap().remove(0);
        assert_eq!(initial["revision"], 1);
        assert_eq!(
            initial["payload"]["pairingLinks"].as_array().unwrap().len(),
            1
        );
        assert!(!initial.to_string().contains("secret"));
        assert_eq!(initial["payload"]["clientSessions"][0]["current"], true);
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_pairing_links SET revoked_at='2020-01-01' WHERE id='p'",
                [],
            )
            .unwrap();
        state.lifecycle.notify();
        let event = tokio::time::timeout(Duration::from_secs(2), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .remove(0);
        assert_eq!(
            event,
            json!({"version":1,"revision":2,"type":"pairingLinkRemoved","payload":{"id":"p"}})
        );
    }
}
