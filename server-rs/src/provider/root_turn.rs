//! Root-turn transport bridge. The caller owns orchestration persistence and must
//! route unsupported notifications before treating a terminal event as final.
use super::{
    codex_events::{
        CodexRootTurnTranslator, NormalizedEvent, RootTurn, Translation, TranslationError,
    },
    ProviderClient, ProviderError, ProviderEvent,
};
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum RootTurnError {
    Provider(ProviderError),
    Translation(TranslationError),
    InvalidStartResponse,
}
impl From<ProviderError> for RootTurnError {
    fn from(e: ProviderError) -> Self {
        Self::Provider(e)
    }
}
impl From<TranslationError> for RootTurnError {
    fn from(e: TranslationError) -> Self {
        Self::Translation(e)
    }
}
impl std::fmt::Display for RootTurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RootTurnError {}

/// A notification not covered by the root-turn translator, or a server request
/// that needs an orchestration response. Never silently discard these messages.
#[derive(Debug)]
pub enum RootTurnOutput {
    Events(Vec<NormalizedEvent>),
    Unsupported(ProviderEvent),
    Idle,
}

pub struct RootTurnStream<C> {
    client: C,
    translator: CodexRootTurnTranslator,
    last_flush: Instant,
}
impl<C: ProviderClient> RootTurnStream<C> {
    /// Starts a native turn and registers the returned ID. Notifications arriving
    /// before the response remain queued by the transport and are read in order.
    /// `turn` contains IDs and ordinals allocated by the orchestration layer;
    /// its native turn ID is filled from the provider response.
    pub fn start(
        mut client: C,
        params: Value,
        mut turn: RootTurn,
        timeout: Duration,
    ) -> Result<(Self, NormalizedEvent), RootTurnError> {
        let result = client.request("turn/start", Some(params), timeout)?;
        let id = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(RootTurnError::InvalidStartResponse)?;
        turn.native_turn_id = id.to_owned();
        let (translator, started) = CodexRootTurnTranslator::start(turn);
        Ok((
            Self {
                client,
                translator,
                last_flush: Instant::now(),
            },
            started,
        ))
    }

    /// Poll at intervals no longer than 50ms to emit buffered text promptly.
    /// The caller supplies its own clock and native timestamp conversion.
    pub fn poll<F>(
        &mut self,
        timeout: Duration,
        now: &str,
        native_time: F,
    ) -> Result<RootTurnOutput, RootTurnError>
    where
        F: Fn(i64) -> String,
    {
        let remaining = Duration::from_millis(50).saturating_sub(self.last_flush.elapsed());
        match self.client.next_event(timeout.min(remaining)) {
            Ok(ProviderEvent::Notification { method, params }) => {
                match self.translator.notification(
                    &method,
                    params.clone().unwrap_or(Value::Null),
                    now,
                    native_time,
                )? {
                    Translation::Events(mut events) => {
                        if self.last_flush.elapsed() >= Duration::from_millis(50) {
                            events.extend(self.translator.flush(now));
                            self.last_flush = Instant::now();
                        }
                        Ok(RootTurnOutput::Events(events))
                    }
                    Translation::Unsupported => {
                        Ok(RootTurnOutput::Unsupported(ProviderEvent::Notification {
                            method,
                            params,
                        }))
                    }
                }
            }
            Ok(request) => Ok(RootTurnOutput::Unsupported(request)),
            Err(ProviderError::Timeout) => {
                let events = if self.last_flush.elapsed() >= Duration::from_millis(50) {
                    self.last_flush = Instant::now();
                    self.translator.flush(now)
                } else {
                    Vec::new()
                };
                Ok(if events.is_empty() {
                    RootTurnOutput::Idle
                } else {
                    RootTurnOutput::Events(events)
                })
            }
            Err(e) => Err(e.into()),
        }
    }
    pub fn client_mut(&mut self) -> &mut C {
        &mut self.client
    }
    pub fn mark_interrupting(&mut self) {
        self.translator.mark_interrupting();
    }
    pub fn into_client(self) -> C {
        self.client
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;

    struct Fake(VecDeque<ProviderEvent>);
    impl ProviderClient for Fake {
        fn request(
            &mut self,
            method: &str,
            _: Option<Value>,
            _: Duration,
        ) -> Result<Value, ProviderError> {
            assert_eq!(method, "turn/start");
            Ok(json!({"turn":{"id":"native-turn"}}))
        }
        fn notify(&mut self, _: &str, _: Option<Value>) -> Result<(), ProviderError> {
            Ok(())
        }
        fn next_event(&mut self, _: Duration) -> Result<ProviderEvent, ProviderError> {
            self.0.pop_front().ok_or(ProviderError::Timeout)
        }
        fn respond(
            &mut self,
            _: Value,
            _: Result<Value, (i64, String)>,
        ) -> Result<(), ProviderError> {
            Ok(())
        }
    }
    #[test]
    fn start_and_stream_preserve_unknown_notifications_and_terminal() {
        let events = VecDeque::from([
            ProviderEvent::Notification {
                method: "item/agentMessage/delta".into(),
                params: Some(
                    json!({"threadId":"native-thread","turnId":"native-turn","itemId":"item","delta":"hello"}),
                ),
            },
            ProviderEvent::Notification {
                method: "thread/tokenUsage/updated".into(),
                params: Some(json!({"value":1})),
            },
            ProviderEvent::Notification {
                method: "turn/completed".into(),
                params: Some(
                    json!({"threadId":"native-thread","turn":{"id":"native-turn","status":"completed"}}),
                ),
            },
        ]);
        let turn = RootTurn {
            driver: "codex".into(),
            native_thread_id: "native-thread".into(),
            native_turn_id: String::new(),
            provider_thread_id: "provider-thread".into(),
            provider_turn_id: "provider-turn".into(),
            thread_id: "thread".into(),
            run_id: Some("run".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "now".into(),
        };
        let (mut stream, start) =
            RootTurnStream::start(Fake(events), json!({}), turn, Duration::from_secs(1)).unwrap();
        assert!(matches!(start, NormalizedEvent::ProviderTurnUpdated { .. }));
        assert!(matches!(
            stream
                .poll(Duration::ZERO, "now", |_| "now".into())
                .unwrap(),
            RootTurnOutput::Events(_)
        ));
        assert!(
            matches!(stream.poll(Duration::ZERO,"now", |_| "now".into()).unwrap(), RootTurnOutput::Unsupported(ProviderEvent::Notification { method, .. }) if method == "thread/tokenUsage/updated")
        );
        assert!(
            matches!(stream.poll(Duration::ZERO,"now", |_| "now".into()).unwrap(), RootTurnOutput::Events(events) if events.iter().any(|e| matches!(e, NormalizedEvent::TurnTerminal { .. })))
        );
    }
}
