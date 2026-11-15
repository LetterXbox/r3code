//! Transport-independent HTTP upgrade and WebSocket RPC plumbing.
//!
//! The network adapter must perform the actual HTTP/WebSocket upgrade, provide
//! an authenticator, authorize each dispatched method with the returned session,
//! and close the socket when that session is invalidated.
use crate::output_window::OutputWindows;
use crate::rpc::{self, ClientMessage, Request, RequestId};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const FRAME_PART_BYTES: usize = 49_152;

#[derive(Debug, Clone, PartialEq)]
pub struct HttpRejection {
    pub status: u16,
    pub body: Value,
    pub headers: Vec<(String, String)>,
}

/// Check protocol compatibility before invoking authentication. `authenticate`
/// must implement the server's ticket/cookie/bearer/DPoP validation; its error
/// is returned as an HTTP response before the caller upgrades the socket.
#[derive(Debug, PartialEq)]
pub struct Authenticated<S>(S);

pub fn prepare_upgrade<S>(
    protocol: Option<&str>,
    authenticate: impl FnOnce() -> Result<S, HttpRejection>,
) -> Result<Authenticated<S>, HttpRejection> {
    if protocol != Some("2") {
        return Err(HttpRejection {
            status: 426,
            body: json!({"code":"orchestration_protocol_incompatible","message":"Update this client to one that supports orchestration protocol 2.","orchestrationProtocolVersion":2}),
            headers: vec![("content-type".into(), "application/json".into())],
        });
    }
    authenticate().map(Authenticated)
}

/// Messages for the network adapter and request executor. Requests must be
/// authorized against `Connection::session` before invoking a method handler.
#[derive(Debug, PartialEq)]
pub enum Action {
    Send(Value),
    Dispatch(Request),
    Ack(RequestId),
    Interrupt(RequestId),
    End,
}

pub struct Connection<S> {
    pub session: S,
    client_id: String,
    upgrade_headers: Vec<(String, String)>,
    pub frame_parts: bool,
    windows: OutputWindows,
    ended: bool,
}
impl<S> Connection<S> {
    /// Only construct after `prepare_upgrade` has successfully authenticated.
    pub fn new(
        session: Authenticated<S>,
        client_id: String,
        upgrade_headers: Vec<(String, String)>,
        frame_parts: bool,
    ) -> Self {
        Self {
            session: session.0,
            client_id,
            upgrade_headers: upgrade_headers
                .into_iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v))
                .collect(),
            frame_parts,
            windows: OutputWindows::new(),
            ended: false,
        }
    }
    pub fn receive(&mut self, frame: &[u8]) -> Vec<Action> {
        if self.ended {
            return Vec::new();
        }
        let messages = match rpc::decode_frame(frame) {
            Ok(messages) => messages,
            Err(error) => {
                return vec![Action::Send(rpc::defect(
                    json!({"name":"Error","message":error.to_string()}),
                ))]
            }
        };
        let mut actions = Vec::new();
        for message in messages {
            match message {
                ClientMessage::Ping => actions.push(Action::Send(rpc::pong())),
                ClientMessage::Eof => {
                    self.ended = true;
                    self.windows.disconnect(&self.client_id);
                    actions.push(Action::End);
                    break;
                }
                ClientMessage::Request(mut request) => {
                    let mut headers = self.upgrade_headers.clone();
                    headers.append(&mut request.headers);
                    request.headers = headers;
                    let connected = HashSet::from([self.client_id.clone()]);
                    self.windows.open(
                        &self.client_id,
                        request.id.clone(),
                        &request.tag,
                        &connected,
                    );
                    actions.push(Action::Dispatch(request));
                }
                ClientMessage::Ack { request_id } => {
                    if self.windows.receive_ack(&self.client_id, &request_id) {
                        actions.push(Action::Ack(request_id));
                    }
                }
                ClientMessage::Interrupt { request_id } => {
                    actions.push(Action::Interrupt(request_id))
                }
            }
        }
        actions
    }
    /// Discard the old window when the adapter replaces a running request.
    /// Otherwise the replacement inherits the old request's unacknowledged
    /// chunks and can block before it has sent its own window.
    pub fn replace_request(&mut self, id: &RequestId, tag: &str) {
        self.windows.exit(&self.client_id, id);
        let connected = HashSet::from([self.client_id.clone()]);
        self.windows
            .open(&self.client_id, id.clone(), tag, &connected);
    }
    /// Call after delivering a stream chunk. A returned Ack is synthetic and
    /// must be passed to the stream producer, never sent to the client.
    pub fn chunk_sent(&mut self, id: &RequestId, values: &[Value]) -> Option<Action> {
        self.windows
            .sent_chunk(&self.client_id, id, values)
            .then(|| Action::Ack(id.clone()))
    }
    pub fn exit_sent(&mut self, id: &RequestId) {
        self.windows.exit(&self.client_id, id);
    }
    /// The adapter must cancel every running request when the socket closes.
    pub fn close(&mut self) {
        self.ended = true;
        self.windows.disconnect(&self.client_id);
    }
    pub fn encode(&self, value: &Value) -> Result<Vec<String>, serde_json::Error> {
        let text = rpc::encode_frame(value)?;
        Ok(if self.frame_parts {
            split_frame(&text)
        } else {
            vec![text]
        })
    }
}

/// Apply the shared socket-frame splitter used by the original protocol.
pub fn split_frame(text: &str) -> Vec<String> {
    crate::shared::split_frame(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn version_gate_precedes_authentication_and_preserves_auth_failures() {
        let called = Cell::new(false);
        let rejection = prepare_upgrade(Some("1"), || {
            called.set(true);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(rejection.status, 426);
        assert_eq!(rejection.body["orchestrationProtocolVersion"], 2);
        assert!(!called.get());
        let auth = HttpRejection {
            status: 401,
            body: json!({"code":"auth_invalid"}),
            headers: vec![],
        };
        assert_eq!(
            prepare_upgrade(Some("2"), || -> Result<(), _> { Err(auth.clone()) }),
            Err(auth)
        );
    }
    #[test]
    fn routes_ping_request_and_flow_control() {
        let mut c = Connection::new(
            prepare_upgrade(Some("2"), || Ok::<_, HttpRejection>(())).unwrap(),
            "a".into(),
            vec![("Authorization".into(), "x".into())],
            false,
        );
        assert_eq!(
            c.receive(br#"{"_tag":"Ping"}"#),
            vec![Action::Send(json!({"_tag":"Pong"}))]
        );
        let actions = c.receive(br#"{"_tag":"Request","id":1,"tag":"subscribeServerConfig","payload":{},"headers":[["extra","v"]]}"#);
        let Action::Dispatch(req) = &actions[0] else {
            panic!()
        };
        assert_eq!(
            req.headers,
            vec![
                ("authorization".into(), "x".into()),
                ("extra".into(), "v".into())
            ]
        );
        let id = req.id.clone();
        for _ in 0..7 {
            assert_eq!(
                c.chunk_sent(&id, &[json!(1)]),
                Some(Action::Ack(id.clone()))
            );
        }
        assert_eq!(c.chunk_sent(&id, &[json!(1)]), None);
        assert_eq!(
            c.receive(br#"{"_tag":"Ack","requestId":1}"#),
            vec![Action::Ack(id)]
        );
        assert!(matches!(&c.receive(b"no json")[0], Action::Send(v) if v["_tag"] == "Defect"));
    }
    #[test]
    fn splits_on_utf8_boundaries_and_reassembles() {
        let text = format!("{}{}", "a".repeat(49_150), "💡".repeat(30_000));
        let parts = split_frame(&text);
        assert!(parts.len() > 2);
        assert!(parts.iter().all(|part| part.len() <= FRAME_PART_BYTES));
        assert!(parts[..parts.len() - 1]
            .iter()
            .all(|part| part.starts_with('\u{1e}')));
        let joined: String = parts
            .iter()
            .map(|p| p.strip_prefix('\u{1e}').unwrap_or(p))
            .collect();
        assert_eq!(joined, text);
    }
}
