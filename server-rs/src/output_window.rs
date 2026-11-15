//! Per-client stream acknowledgement windows used by the RPC transport.
use crate::rpc::RequestId;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub const MAX_PENDING_CHUNKS: usize = 8;
pub const MAX_PENDING_BYTES: usize = 65_536;
pub const EVENT_OVERHEAD: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    Count,
    Bytes,
}

pub fn window_kind(tag: &str) -> Option<WindowKind> {
    match tag {
        "terminal.attach" | "terminal.observe" => Some(WindowKind::Bytes),
        "subscribeServerConfig"
        | "orchestration.subscribeShell"
        | "orchestration.subscribeThread" => Some(WindowKind::Count),
        _ => None,
    }
}

fn string_len(value: &Value, field: &str) -> usize {
    value.get(field).and_then(Value::as_str).map_or(0, str::len)
}
/// Charge only the event fields used by the terminal output protocol.
pub fn queued_size(event: &Value) -> usize {
    let mut size = EVENT_OVERHEAD;
    if event.get("threadId").is_some() {
        size = size
            .saturating_add(string_len(event, "threadId"))
            .saturating_add(string_len(event, "terminalId"));
    }
    let field = match event.get("type").and_then(Value::as_str) {
        Some("output") => Some("data"),
        Some("error") => Some("message"),
        Some("activity") => Some("label"),
        _ => None,
    };
    if let Some(field) = field {
        size = size.saturating_add(string_len(event, field));
    }
    if let Some(snapshot) = event.get("snapshot").filter(|_| field.is_none()) {
        for field in [
            "threadId",
            "terminalId",
            "history",
            "cwd",
            "worktreePath",
            "label",
        ] {
            size = size.saturating_add(string_len(snapshot, field));
        }
    }
    size
}
pub fn chunk_size(values: &[Value]) -> usize {
    values.iter().fold(EVENT_OVERHEAD, |sum, value| {
        sum.saturating_add(queued_size(value))
    })
}

#[derive(Debug)]
struct Window {
    kind: WindowKind,
    sizes: VecDeque<usize>,
    total: usize,
}
impl Window {
    fn full(&self) -> bool {
        self.sizes.len() >= MAX_PENDING_CHUNKS || self.total >= MAX_PENDING_BYTES
    }
}

/// Transport wrapper state. Call `sent_chunk` after delivering the chunk, and
/// inject a synthetic Ack only if it returns true. `receive_ack` returns true
/// when the real Ack must be forwarded to the underlying RPC server.
#[derive(Debug, Default)]
pub struct OutputWindows {
    clients: HashMap<String, HashMap<RequestId, Window>>,
}
impl OutputWindows {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open idempotently, pruning clients no longer present in the transport.
    /// Non-windowed tags do not alter the state.
    pub fn open(
        &mut self,
        client: &str,
        id: RequestId,
        tag: &str,
        connected: &HashSet<String>,
    ) -> bool {
        let Some(kind) = window_kind(tag) else {
            return false;
        };
        self.clients.retain(|client, _| connected.contains(client));
        self.clients
            .entry(client.to_owned())
            .or_default()
            .entry(id)
            .or_insert_with(|| Window {
                kind,
                sizes: VecDeque::new(),
                total: 0,
            });
        true
    }
    pub fn sent_chunk(&mut self, client: &str, id: &RequestId, values: &[Value]) -> bool {
        let Some(window) = self
            .clients
            .get_mut(client)
            .and_then(|windows| windows.get_mut(id))
        else {
            return false;
        };
        let size = if window.kind == WindowKind::Bytes {
            chunk_size(values)
        } else {
            0
        };
        window.sizes.push_back(size);
        window.total = window.total.saturating_add(size);
        !window.full()
    }
    pub fn receive_ack(&mut self, client: &str, id: &RequestId) -> bool {
        let Some(window) = self
            .clients
            .get_mut(client)
            .and_then(|windows| windows.get_mut(id))
        else {
            return true;
        };
        let was_full = window.full();
        if let Some(size) = window.sizes.pop_front() {
            window.total = window.total.saturating_sub(size);
        }
        was_full && !window.full()
    }
    pub fn exit(&mut self, client: &str, id: &RequestId) {
        if let Some(windows) = self.clients.get_mut(client) {
            windows.remove(id);
            if windows.is_empty() {
                self.clients.remove(client);
            }
        }
    }
    pub fn disconnect(&mut self, client: &str) {
        self.clients.remove(client);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn id(s: &str) -> RequestId {
        RequestId::String(s.into())
    }
    fn connected() -> HashSet<String> {
        ["a".into(), "b".into()].into_iter().collect()
    }
    #[test]
    fn count_window_releases_only_when_full_and_isolated() {
        let mut w = OutputWindows::new();
        w.open("a", id("1"), "subscribeServerConfig", &connected());
        w.open("b", id("1"), "subscribeServerConfig", &connected());
        for _ in 0..7 {
            assert!(w.sent_chunk("a", &id("1"), &[json!(1)]));
        }
        assert!(!w.sent_chunk("a", &id("1"), &[json!(1)]));
        assert!(w.sent_chunk("b", &id("1"), &[json!(1)]));
        assert!(w.receive_ack("a", &id("1")));
        assert!(!w.receive_ack("a", &id("1")));
        assert!(!w.receive_ack("b", &id("1")));
        w.exit("a", &id("1"));
        assert!(w.receive_ack("a", &id("1")));
    }
    #[test]
    fn byte_limit_and_event_fields_use_utf8_lengths() {
        let event = json!({"type":"output","threadId":"é","terminalId":"x","data":"💡"});
        assert_eq!(queued_size(&event), 128 + 2 + 1 + 4);
        assert_eq!(chunk_size(&[event]), 128 + 128 + 7);
        let snapshot = json!({"type":"snapshot","snapshot":{"threadId":"a","terminalId":"b","history":"cc","cwd":"/","worktreePath":null,"label":"z"}});
        assert_eq!(queued_size(&snapshot), 128 + 6);
        let mut w = OutputWindows::new();
        w.open("a", id("1"), "terminal.attach", &connected());
        assert!(!w.sent_chunk(
            "a",
            &id("1"),
            &[json!({"type":"output","data":"x".repeat(65536)})]
        ));
        assert!(w.receive_ack("a", &id("1")));
    }
    #[test]
    fn opens_idempotently_and_prunes_disconnected_clients() {
        let mut w = OutputWindows::new();
        w.open("a", id("1"), "subscribeServerConfig", &connected());
        for _ in 0..8 {
            w.sent_chunk("a", &id("1"), &[]);
        }
        w.open("a", id("1"), "terminal.attach", &connected());
        assert!(w.receive_ack("a", &id("1")));
        w.open(
            "b",
            id("2"),
            "terminal.observe",
            &["b".to_owned()].into_iter().collect(),
        );
        assert!(w.receive_ack("a", &id("1")));
        assert!(!w.open("b", id("3"), "subscribeTerminalMetadata", &connected()));
        assert!(w.receive_ack("b", &id("3")));
    }

    #[test]
    fn string_and_numeric_request_ids_have_independent_windows() {
        let mut w = OutputWindows::new();
        let numeric = RequestId::Number(serde_json::Number::from(1));
        w.open("a", id("1"), "subscribeServerConfig", &connected());
        w.open("a", numeric.clone(), "subscribeServerConfig", &connected());
        for _ in 0..MAX_PENDING_CHUNKS {
            w.sent_chunk("a", &id("1"), &[serde_json::json!(1)]);
        }
        assert!(w.sent_chunk("a", &numeric, &[serde_json::json!(1)]));
        assert!(!w.receive_ack("a", &numeric));
        assert!(w.receive_ack("a", &id("1")));
    }
}
