//! Project Pi stream and tool records into provider-neutral events.
use super::{
    codex_events::{AssistantArtifact, NormalizedEvent, ReasoningArtifact, RootTurn, ToolArtifact},
    pi_events::PiUpdate,
};
use serde_json::json;
use std::collections::HashMap;
struct Item {
    ordinal: u64,
    started: String,
}
pub(crate) struct Projector {
    turn: RootTurn,
    items: HashMap<String, Item>,
    next: u64,
}
impl Projector {
    pub(crate) fn new(turn: RootTurn) -> Self {
        let next = turn
            .provider_turn_ordinal
            .saturating_mul(100)
            .saturating_add(1);
        Self {
            turn,
            items: HashMap::new(),
            next,
        }
    }
    fn item(&mut self, id: &str, at: &str) -> Result<(u64, String), String> {
        if let Some(item) = self.items.get(id) {
            return Ok((item.ordinal, item.started.clone()));
        }
        if self.items.len() >= 2048 {
            return Err("Pi item limit exceeded".into());
        }
        let ordinal = self.next;
        self.next = self.next.checked_add(1).ok_or("Pi ordinal overflow")?;
        self.items.insert(
            id.into(),
            Item {
                ordinal,
                started: at.into(),
            },
        );
        Ok((ordinal, at.into()))
    }
    pub(crate) fn project(
        &mut self,
        update: PiUpdate,
        at: &str,
    ) -> Result<Vec<NormalizedEvent>, String> {
        match update {
            PiUpdate::Text {
                id,
                text,
                reasoning,
                completed,
            } => {
                let (ordinal, started_at) = self.item(&id, at)?;
                let artifact = AssistantArtifact {
                    turn: self.turn.clone(),
                    native_item_id: id.clone(),
                    phase: None,
                    text,
                    ordinal,
                    started_at,
                    updated_at: at.into(),
                    completed,
                };
                if reasoning {
                    let reasoning = ReasoningArtifact {
                        artifact,
                        native_reasoning_item_id: id,
                        stream: "text".into(),
                        index: 0,
                        interrupted: false,
                    };
                    Ok(vec![
                        NormalizedEvent::ReasoningNodeUpdated(reasoning.clone()),
                        NormalizedEvent::ReasoningTurnItemUpdated(reasoning),
                    ])
                } else {
                    Ok(vec![
                        NormalizedEvent::NodeUpdated(artifact.clone()),
                        NormalizedEvent::MessageUpdated(artifact.clone()),
                        NormalizedEvent::TurnItemUpdated(artifact),
                    ])
                }
            }
            PiUpdate::Tool {
                id,
                name,
                input,
                output,
                status,
            } => {
                let (ordinal, started_at) = self.item(&id, at)?;
                let content = output["content"].as_array().cloned().unwrap_or_default();
                let text = content
                    .iter()
                    .filter_map(|item| {
                        if item["type"] == "text" {
                            item["text"].as_str()
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let (kind, mut fields) = if name == "bash" || name == "powershell" {
                    let mut value =
                        json!({"title":name,"input":input["command"].as_str().unwrap_or("")});
                    if !text.is_empty() {
                        value["output"] = json!(text);
                    }
                    if let Some(code) = output["structuredContent"]["exit_code"]
                        .as_i64()
                        .or_else(|| output["details"]["exitCode"].as_i64())
                    {
                        value["exitCode"] = json!(code);
                    }
                    ("command_execution", value)
                } else if (name == "edit" || name == "write")
                    && input["path"]
                        .as_str()
                        .or_else(|| input["file_path"].as_str())
                        .is_some()
                {
                    let mut value = json!({"title":name,"fileName":input["path"].as_str().or_else(||input["file_path"].as_str())});
                    if let Some(patch) = output["details"]["patch"].as_str().or_else(|| {
                        if status == "failed" && !text.trim().is_empty() {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    }) {
                        value["diffStr"] = json!(patch);
                    }
                    if name == "write" && input["content"].is_string() {
                        value["newStr"] = input["content"].clone();
                    }
                    ("file_change", value)
                } else {
                    let mut value = json!({"title":name,"toolName":name,"input":input});
                    if !content.is_empty() {
                        if content.iter().all(|item| item["type"] == "text")
                            && output["structuredContent"].is_null()
                        {
                            if !text.is_empty() {
                                value["output"] = json!(text);
                            }
                        } else {
                            value["output"] = json!({"content":content,"structuredContent":output["structuredContent"]});
                        }
                    }
                    ("dynamic_tool", value)
                };
                if fields["title"].is_null() {
                    fields["title"] = json!(name);
                }
                Ok(vec![NormalizedEvent::ToolUpdated(ToolArtifact {
                    turn: self.turn.clone(),
                    native_item_id: id,
                    ordinal,
                    started_at,
                    updated_at: at.into(),
                    status: status.into(),
                    kind: kind.into(),
                    fields,
                })])
            }
            _ => Ok(vec![]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projects_pi_command_and_file_results() {
        let turn = RootTurn {
            driver: "pi".into(),
            native_thread_id: "/tmp/session".into(),
            native_turn_id: "native".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "turn".into(),
            thread_id: "thread".into(),
            run_id: Some("run".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "start".into(),
        };
        let mut projector = Projector::new(turn);
        let updates=projector.project(PiUpdate::Tool{id:"cmd".into(),name:"bash".into(),input:json!({"command":"exit 7"}),output:json!({"content":[{"type":"text","text":"failed"}],"details":{"exitCode":7}}),status:"failed"},"end").unwrap();
        let NormalizedEvent::ToolUpdated(item) = &updates[0] else {
            panic!("tool missing")
        };
        assert_eq!(item.kind, "command_execution");
        assert_eq!(item.ordinal, 101);
        assert_eq!(item.fields["exitCode"], 7);
        assert_eq!(item.fields["output"], "failed");
        let updates = projector
            .project(
                PiUpdate::Tool {
                    id: "file".into(),
                    name: "write".into(),
                    input: json!({"path":"a.txt","content":"new"}),
                    output: json!({"details":{"patch":"+new"}}),
                    status: "completed",
                },
                "end",
            )
            .unwrap();
        let NormalizedEvent::ToolUpdated(item) = &updates[0] else {
            panic!("tool missing")
        };
        assert_eq!(item.kind, "file_change");
        assert_eq!(item.fields["newStr"], "new");
    }
}
