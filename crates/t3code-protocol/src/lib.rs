//! Domain identifiers and records for the T3 Code GPUI port.
//!
//! Mirrors the entity ids in `packages/contracts/src/baseSchemas.ts`: each id
//! is a distinct newtype so a `ThreadId` can never be passed where an
//! `EnvironmentId` belongs.

use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! entity_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(v: &str) -> Self {
                Self(v.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(v: String) -> Self {
                Self(v)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl $name {
            pub const KIND: &'static str = $prefix;
        }
    };
}

entity_id! {
    /// A conversation thread. `ThreadId` in contracts.
    ThreadId, "ThreadId"
}
entity_id! {
    /// A server/environment the client talks to.
    EnvironmentId, "EnvironmentId"
}
entity_id! {
    /// A project (a checkout on some machine).
    ProjectId, "ProjectId"
}
entity_id! {
    /// An unsent draft thread.
    DraftId, "DraftId"
}
entity_id! {
    /// The provider's own id for a thread.
    ProviderThreadId, "ProviderThreadId"
}

/// A thread reference scoped to the environment that serves it.
///
/// The web app threads this pair through every runtime call, because a thread
/// id alone is ambiguous once more than one server is connected.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ScopedThreadRef {
    pub environment_id: EnvironmentId,
    pub thread_id: ThreadId,
}

impl ScopedThreadRef {
    pub fn new(environment_id: impl Into<EnvironmentId>, thread_id: impl Into<ThreadId>) -> Self {
        Self {
            environment_id: environment_id.into(),
            thread_id: thread_id.into(),
        }
    }
}

/// A project as the shell projection exposes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    /// Absolute path of the checkout on the host machine.
    pub path: String,
}

/// Run state of a thread, as the sidebar renders it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    /// No turn running.
    #[default]
    Idle,
    /// A provider turn is in flight.
    Running,
    /// Waiting on a tool/permission decision by the user.
    AwaitingInput,
    /// Last turn failed.
    Failed,
}

impl ThreadStatus {
    pub fn is_busy(self) -> bool {
        matches!(self, ThreadStatus::Running)
    }
}

/// One thread row in the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub environment_id: EnvironmentId,
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub status: ThreadStatus,
    /// Pinned threads sort above the rest and render with a pin marker.
    pub pinned: bool,
    /// Unix millis of last activity; the sidebar sorts by this.
    pub updated_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_distinct_serde_transparent() {
        let id = ThreadId::new("t_123");
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"t_123\"");
        assert_eq!(id.as_str(), "t_123");
        assert_eq!(id.to_string(), "t_123");
    }

    #[test]
    fn scoped_ref_roundtrips() {
        let r = ScopedThreadRef::new("env_1", "th_2");
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(json, r#"{"environment_id":"env_1","thread_id":"th_2"}"#);
        assert_eq!(serde_json::from_str::<ScopedThreadRef>(&json).unwrap(), r);
    }

    #[test]
    fn status_defaults_to_idle() {
        assert_eq!(ThreadStatus::default(), ThreadStatus::Idle);
        assert!(!ThreadStatus::Idle.is_busy());
        assert!(ThreadStatus::Running.is_busy());
    }
}
