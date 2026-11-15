//! In-memory credentials for provider-launched MCP clients. Only hashes are retained.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

const LIVENESS: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedSender {
    pub environment_id: String,
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientScope {
    pub session_id: String,
    pub label: String,
    pub access: String,
    pub linked: bool,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub sender_thread: Option<LinkedSender>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    pub thread_id: String,
    pub provider_session_id: String,
    pub provider_instance_id: String,
    pub capabilities: HashSet<String>,
    pub subagent: bool,
    pub client: Option<ClientScope>,
}

/// The raw bearer token is returned only at issuance; never log this value.
pub struct IssuedCredential {
    pub token: String,
    pub scope: Scope,
}
struct Record {
    scope: Scope,
    wall: SystemTime,
    monotonic: Instant,
    expired: bool,
}
#[derive(Default)]
pub struct Registry {
    records: Mutex<HashMap<[u8; 32], Record>>,
}
fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}
impl Registry {
    pub fn issue(
        &self,
        thread_id: &str,
        provider_instance_id: &str,
        capabilities: HashSet<String>,
        subagent: bool,
    ) -> Result<IssuedCredential, getrandom::Error> {
        let mut random = [0; 32];
        getrandom::fill(&mut random)?;
        let token = URL_SAFE_NO_PAD.encode(random);
        let scope = Scope {
            thread_id: thread_id.into(),
            provider_session_id: uuid::Uuid::new_v4().to_string(),
            provider_instance_id: provider_instance_id.into(),
            capabilities,
            subagent,
            client: None,
        };
        self.records.lock().unwrap().insert(
            hash(&token),
            Record {
                scope: scope.clone(),
                wall: SystemTime::now(),
                monotonic: Instant::now(),
                expired: false,
            },
        );
        Ok(IssuedCredential { token, scope })
    }
    pub fn resolve(&self, token: &str) -> Option<Scope> {
        if token.is_empty() {
            return None;
        }
        let mut records = self.records.lock().unwrap();
        let record = records.get_mut(&hash(token))?;
        if record.expired {
            return None;
        }
        let wall = SystemTime::now();
        let monotonic = Instant::now();
        if wall
            .duration_since(record.wall)
            .unwrap_or_default()
            .max(monotonic.duration_since(record.monotonic))
            > LIVENESS
        {
            record.expired = true;
            return None;
        }
        record.wall = wall;
        record.monotonic = monotonic;
        Some(record.scope.clone())
    }
    /// A trusted active provider turn can restore an idle credential.
    pub fn touch(&self, thread_id: &str) {
        let mut records = self.records.lock().unwrap();
        for record in records
            .values_mut()
            .filter(|r| r.scope.thread_id == thread_id)
        {
            record.wall = SystemTime::now();
            record.monotonic = Instant::now();
            record.expired = false;
        }
    }
    pub fn revoke_thread(&self, thread_id: &str) {
        self.records
            .lock()
            .unwrap()
            .retain(|_, r| r.scope.thread_id != thread_id);
    }
    pub fn revoke_provider_session(&self, id: &str) {
        self.records
            .lock()
            .unwrap()
            .retain(|_, r| r.scope.provider_session_id != id);
    }
    pub fn revoke_all(&self) {
        self.records.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_lifecycle_and_idle_recovery() {
        let registry = Registry::default();
        let first = registry
            .issue(
                "thread",
                "instance",
                HashSet::from(["preview".into()]),
                false,
            )
            .unwrap();
        let second = registry
            .issue("other", "instance", HashSet::new(), true)
            .unwrap();
        assert_ne!(first.token, second.token);
        assert_eq!(registry.resolve(&first.token), Some(first.scope.clone()));
        registry
            .records
            .lock()
            .unwrap()
            .get_mut(&hash(&first.token))
            .unwrap()
            .wall = SystemTime::now() - LIVENESS - Duration::from_secs(1);
        assert_eq!(registry.resolve(&first.token), None);
        assert_eq!(registry.resolve(&first.token), None);
        registry.touch("thread");
        assert_eq!(registry.resolve(&first.token), Some(first.scope.clone()));
        registry.revoke_provider_session(&first.scope.provider_session_id);
        assert_eq!(registry.resolve(&first.token), None);
        assert!(registry.resolve(&second.token).is_some());
        registry.revoke_thread("other");
        assert_eq!(registry.resolve(&second.token), None);
    }
}
