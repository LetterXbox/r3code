//! Pi RPC event decoding, independent of process lifecycle.
use serde_json::{json, Value};
use std::collections::HashMap;
const ITEMS: usize = 2048;
const TEXT_BYTES: usize = 8 * 1024 * 1024;
#[derive(Debug, PartialEq)]
pub(crate) enum PiUpdate {
    Text {
        id: String,
        text: String,
        reasoning: bool,
        completed: bool,
    },
    Tool {
        id: String,
        name: String,
        input: Value,
        output: Value,
        status: &'static str,
    },
    SettledCandidate(&'static str),
    PromptResponse {
        success: bool,
        error: Option<String>,
    },
    Extension(Value),
}
struct Item {
    text: String,
    completed: bool,
    reasoning: bool,
}
struct Tool {
    name: String,
    input: Value,
    input_bytes: usize,
}
pub(crate) struct Decoder {
    turn: String,
    message: u64,
    items: HashMap<String, Item>,
    tools: HashMap<String, Tool>,
    failure: bool,
    interrupted: bool,
    settled: bool,
    buffered: usize,
}
impl Decoder {
    pub(crate) fn new(turn: &str) -> Self {
        Self {
            turn: turn.into(),
            message: 0,
            items: HashMap::new(),
            tools: HashMap::new(),
            failure: false,
            interrupted: false,
            settled: false,
            buffered: 0,
        }
    }
    pub(crate) fn finish(&mut self) {
        self.settled = true;
    }
    pub(crate) fn interrupt(&mut self) {
        self.interrupted = true;
    }
    pub(crate) fn event(&mut self, event: &Value) -> Result<Vec<PiUpdate>, String> {
        let kind = event["type"].as_str().ok_or("Pi event missing type")?;
        if self.settled {
            return Ok(vec![]);
        }
        match kind {
            "message_start" if event["message"]["role"] == "assistant" => {
                self.message = self
                    .message
                    .checked_add(1)
                    .ok_or("Pi message ordinal overflow")?;
                Ok(vec![])
            }
            "message_update" => {
                let delta = &event["assistantMessageEvent"];
                let name = delta["type"].as_str().unwrap_or("");
                let (reasoning, completed) = match name {
                    "text_delta" => (false, false),
                    "thinking_delta" => (true, false),
                    "text_end" => (false, true),
                    "thinking_end" => (true, true),
                    _ => return Ok(vec![]),
                };
                let index = delta["contentIndex"].as_u64().unwrap_or(0);
                let id = format!("{}:m{}:c{}", self.turn, self.message, index);
                if !self.items.contains_key(&id) && self.items.len() >= ITEMS {
                    return Err("Pi item limit exceeded".into());
                }
                let item = self.items.entry(id.clone()).or_insert_with(|| Item {
                    text: String::new(),
                    completed: false,
                    reasoning,
                });
                if item.completed {
                    return Ok(vec![]);
                }
                let value = if completed {
                    delta["content"]
                        .as_str()
                        .or_else(|| delta["thinking"].as_str())
                        .unwrap_or("")
                } else {
                    delta["delta"].as_str().unwrap_or("")
                };
                let prior = item.text.len();
                let next = if completed && !value.is_empty() {
                    value.len()
                } else if !completed {
                    prior.saturating_add(value.len())
                } else {
                    prior
                };
                let total = self.buffered.saturating_sub(prior).saturating_add(next);
                if total > TEXT_BYTES {
                    return Err("Pi output limit exceeded".into());
                }
                if completed && !value.is_empty() {
                    item.text = value.to_owned();
                } else if !completed {
                    item.text.push_str(value);
                }
                self.buffered = total;
                item.completed = completed;
                if item.text.is_empty() {
                    return Ok(vec![]);
                }
                Ok(vec![PiUpdate::Text {
                    id,
                    text: item.text.clone(),
                    reasoning: item.reasoning,
                    completed,
                }])
            }
            "message_end" if event["message"]["role"] == "assistant" => {
                if event["message"]["stopReason"] == "error" {
                    self.failure = true;
                }
                let mut out = Vec::new();
                for (id, item) in &mut self.items {
                    if !item.completed && !item.text.is_empty() {
                        item.completed = true;
                        out.push(PiUpdate::Text {
                            id: id.clone(),
                            text: item.text.clone(),
                            reasoning: item.reasoning,
                            completed: true,
                        });
                    }
                }
                Ok(out)
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                let id = event["toolCallId"]
                    .as_str()
                    .ok_or("Pi tool missing id")?
                    .to_owned();
                if !self.tools.contains_key(&id) && self.tools.len() >= ITEMS {
                    return Err("Pi tool limit exceeded".into());
                }
                let tool = self.tools.entry(id.clone()).or_insert_with(|| Tool {
                    name: event["toolName"].as_str().unwrap_or("tool").into(),
                    input: json!({}),
                    input_bytes: 0,
                });
                if !event["args"].is_null() {
                    let prior = tool.input_bytes;
                    let next = event["args"].to_string().len();
                    let total = self.buffered.saturating_sub(prior).saturating_add(next);
                    if total > TEXT_BYTES {
                        return Err("Pi input limit exceeded".into());
                    }
                    self.buffered = total;
                    tool.input_bytes = next;
                    tool.input = event["args"].clone();
                }
                let done = kind == "tool_execution_end";
                let status = if !done {
                    "running"
                } else if event["isError"] == true {
                    if self.interrupted {
                        "interrupted"
                    } else {
                        "failed"
                    }
                } else {
                    "completed"
                };
                let result = if done {
                    &event["result"]
                } else {
                    &event["partialResult"]
                };
                Ok(vec![PiUpdate::Tool {
                    id,
                    name: tool.name.clone(),
                    input: tool.input.clone(),
                    output: result.clone(),
                    status,
                }])
            }
            "agent_settled" => Ok(vec![PiUpdate::SettledCandidate(
                if self.interrupted || event["aborted"] == true {
                    "interrupted"
                } else if self.failure {
                    "failed"
                } else {
                    "completed"
                },
            )]),
            "response" if event["command"] == "prompt" => Ok(vec![PiUpdate::PromptResponse {
                success: event["success"] == true,
                error: event["error"].as_str().map(str::to_owned),
            }]),
            "extension_ui_request" | "extension_error" => {
                Ok(vec![PiUpdate::Extension(event.clone())])
            }
            _ => Ok(vec![]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_incremental_text_reasoning_tool_and_settlement_order() {
        let mut decoder = Decoder::new("turn");
        assert!(decoder
            .event(&json!({"type":"message_start","message":{"role":"assistant"}}))
            .unwrap()
            .is_empty());
        let text=decoder.event(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello"}})).unwrap();
        assert!(
            matches!(&text[0],PiUpdate::Text{id,text,reasoning:false,completed:false} if id=="turn:m1:c0" && text=="hello")
        );
        decoder.event(&json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":1,"delta":"reason"}})).unwrap();
        let endings = decoder
            .event(
                &json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}),
            )
            .unwrap();
        assert!(endings.iter().any(|event|matches!(event,PiUpdate::Text{text,reasoning:true,completed:true,..} if text=="reason")));
        decoder.event(&json!({"type":"tool_execution_start","toolCallId":"call","toolName":"bash","args":{"command":"false"}})).unwrap();
        let end=decoder.event(&json!({"type":"tool_execution_end","toolCallId":"call","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"failed"}]}})).unwrap();
        assert!(
            matches!(&end[0],PiUpdate::Tool{input,status:"failed",..} if input["command"]=="false")
        );
        assert!(decoder
            .event(&json!({"type":"agent_end"}))
            .unwrap()
            .is_empty());
        assert_eq!(
            decoder.event(&json!({"type":"agent_settled"})).unwrap(),
            vec![PiUpdate::SettledCandidate("completed")]
        );
        decoder.finish();
        assert!(decoder
            .event(&json!({"type":"agent_settled"}))
            .unwrap()
            .is_empty());
    }
}
