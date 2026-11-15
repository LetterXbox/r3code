//! Map supported Muse items onto the shared provider projection.
use super::{
    codex_events::{
        FailureClass, NormalizedEvent, ProviderFailure, RootTurn, ThreadDisposition, TurnStatus,
    },
    opencode_events::Update,
    opencode_projection::Projector,
};
use serde_json::{json, Value};

pub(crate) struct MuseProjection {
    projector: Projector,
    turn: RootTurn,
}
impl MuseProjection {
    pub(crate) fn new(turn: RootTurn) -> Self {
        Self {
            projector: Projector::new(turn.clone()),
            turn,
        }
    }
    pub(crate) fn item(&mut self, item: &Value, at: &str) -> Result<Vec<NormalizedEvent>, String> {
        let id = item["itemId"]
            .as_str()
            .ok_or("Missing Muse item ID")?
            .to_owned();
        let kind = item["kind"].as_str().ok_or("Missing Muse item kind")?;
        if matches!(kind, "userMessage" | "reminderChild") {
            return Ok(vec![]);
        }
        let text = item["text"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                item["summary"].as_array().map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            })
            .or_else(|| item["fallbackText"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let completed = item["status"] != "inProgress";
        if matches!(kind, "agentMessage" | "reasoning") {
            return self.projector.project(
                Update::Text {
                    id,
                    text,
                    reasoning: kind == "reasoning",
                    completed,
                },
                at,
            );
        }
        let status = match item["status"].as_str() {
            Some("inProgress") => "running",
            Some("completed") => "completed",
            Some("cancelled") => "interrupted",
            _ => "failed",
        };
        let name = item["tool"].as_str().unwrap_or(kind).to_owned();
        let input = item["args"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .unwrap_or_else(|| item["args"].clone());
        let output = item["visibleOutput"]
            .as_str()
            .or_else(|| item["result"]["summary"].as_str())
            .or_else(|| item["text"].as_str())
            .or_else(|| item["finalSummary"].as_str())
            .or_else(|| item["fallbackText"].as_str())
            .unwrap_or("");
        self.projector.project(
            Update::Tool {
                id,
                name,
                input,
                output: json!(output),
                exit_code: item["exitCode"].as_i64(),
                metadata: json!({}),
                status,
                child_session: item["childSessionId"].as_str().map(str::to_owned),
            },
            at,
        )
    }
    pub(crate) fn terminal(
        &mut self,
        terminal: &Value,
        interrupted: bool,
        at: &str,
    ) -> Result<Vec<NormalizedEvent>, String> {
        let status = match terminal["terminal"].as_str() {
            Some("completed") => TurnStatus::Completed,
            Some("cancelled") if interrupted => TurnStatus::Interrupted,
            _ => TurnStatus::Failed,
        };
        let failure = (status == TurnStatus::Failed).then(|| ProviderFailure {
            class: FailureClass::ProviderError,
            message: terminal["error"]["message"]
                .as_str()
                .or_else(|| terminal["reason"].as_str())
                .unwrap_or("Muse provider turn failed.")
                .chars()
                .take(2048)
                .collect(),
            code: None,
            retryable: None,
            managed_usage_limit: false,
        });
        Ok(vec![
            NormalizedEvent::ProviderTurnUpdated {
                turn: self.turn.clone(),
                status,
                completed_at: Some(at.into()),
            },
            NormalizedEvent::TurnTerminal {
                turn: self.turn.clone(),
                status,
                failure,
                failure_item_ordinal: (status == TurnStatus::Failed).then_some(
                    self.turn
                        .run_ordinal
                        .saturating_mul(1_000_000)
                        .saturating_add(900_000),
                ),
                thread_disposition: ThreadDisposition::Reusable,
            },
        ])
    }
}
