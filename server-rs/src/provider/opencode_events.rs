//! Session-scoped decoding of OpenCode 2 SSE events into cumulative items.
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Update {
    Started,
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
        exit_code: Option<i64>,
        metadata: Value,
        status: &'static str,
        child_session: Option<String>,
    },
    Permission(Value),
    Question(Value),
    Terminal(&'static str),
}
#[derive(Default)]
struct Tool {
    name: String,
    input: Value,
    output: Value,
    child_session: Option<String>,
}
pub(crate) struct Decoder {
    session: String,
    scope: String,
    texts: HashMap<String, String>,
    tools: HashMap<String, Tool>,
    text_bytes: usize,
    tool_bytes: usize,
    roles: HashMap<String, String>,
    pending_v1: HashMap<String, Vec<Value>>,
    ready: Vec<Update>,
    pending_bytes: usize,
}
impl Decoder {
    pub(crate) fn new(session: String) -> Self {
        Self {
            session,
            scope: String::new(),
            texts: HashMap::new(),
            tools: HashMap::new(),
            text_bytes: 0,
            tool_bytes: 0,
            roles: HashMap::new(),
            pending_v1: HashMap::new(),
            ready: Vec::new(),
            pending_bytes: 0,
        }
    }
    pub(crate) fn with_scope(session: String) -> Self {
        let scope = format!("{session}:");
        let mut decoder = Self::new(session);
        decoder.scope = scope;
        decoder
    }
    pub(crate) fn drain_ready(&mut self) -> Vec<Update> {
        std::mem::take(&mut self.ready)
    }
    pub(crate) fn event_v1(&mut self, event: &Value) -> Result<Option<Update>, String> {
        let kind = event["type"]
            .as_str()
            .ok_or("Missing OpenCode event type")?;
        let props = &event["properties"];
        if props["sessionID"].as_str() != Some(self.session.as_str()) {
            return Ok(None);
        }
        match kind {
            "message.updated" => {
                if let (Some(id), Some(role)) =
                    (props["info"]["id"].as_str(), props["info"]["role"].as_str())
                {
                    if !self.roles.contains_key(id) && self.roles.len() >= 4096 {
                        return Err("OpenCode message limit exceeded".into());
                    }
                    self.roles.insert(id.to_owned(), role.to_owned());
                    if let Some(parts) = self.pending_v1.remove(id) {
                        for part in parts {
                            self.pending_bytes =
                                self.pending_bytes.saturating_sub(part.to_string().len());
                            if role == "assistant" {
                                let kind = part["type"].as_str().unwrap_or("");
                                self.ready.push(Update::Text {
                                    id: part["id"].as_str().unwrap_or("").into(),
                                    text: part["text"].as_str().unwrap_or("").into(),
                                    reasoning: kind == "reasoning",
                                    completed: !part["time"]["end"].is_null(),
                                });
                            }
                        }
                    }
                }
                Ok(None)
            }
            "session.status" => match props["status"]["type"].as_str() {
                Some("busy") => Ok(Some(Update::Started)),
                Some("idle") => Ok(Some(Update::Terminal("completed"))),
                _ => Ok(None),
            },
            "session.error" => Ok(Some(Update::Terminal("failed"))),
            "permission.asked" => Ok(Some(Update::Permission(props.clone()))),
            "question.asked" => Ok(Some(Update::Question(props.clone()))),
            "message.part.updated" => {
                let part = &props["part"];
                let part_kind = part["type"].as_str().unwrap_or("");
                let id = part["id"]
                    .as_str()
                    .ok_or("Missing OpenCode part id")?
                    .to_owned();
                if matches!(part_kind, "text" | "reasoning") {
                    let message = part["messageID"]
                        .as_str()
                        .ok_or("Missing OpenCode message id")?;
                    if !self.roles.contains_key(message) {
                        let entries = self.pending_v1.entry(message.to_owned()).or_default();
                        if let Some(index) =
                            entries.iter().position(|value| value["id"] == part["id"])
                        {
                            self.pending_bytes = self
                                .pending_bytes
                                .saturating_sub(entries[index].to_string().len());
                            entries[index] = part.clone();
                        } else {
                            if entries.len() >= 1024 {
                                return Err("OpenCode item limit exceeded".into());
                            }
                            entries.push(part.clone());
                        }
                        self.pending_bytes =
                            self.pending_bytes.saturating_add(part.to_string().len());
                        if self.pending_bytes > 16 * 1024 * 1024 || self.pending_v1.len() > 1024 {
                            return Err("OpenCode item limit exceeded".into());
                        }
                        return Ok(None);
                    }
                    if self.roles.get(message).map(String::as_str) != Some("assistant") {
                        return Ok(None);
                    }
                    let text = part["text"].as_str().unwrap_or("").to_owned();
                    if text.len() > 16 * 1024 * 1024 {
                        return Err("OpenCode text limit exceeded".into());
                    }
                    return Ok(Some(Update::Text {
                        id,
                        text,
                        reasoning: part_kind == "reasoning",
                        completed: !part["time"]["end"].is_null(),
                    }));
                }
                if part_kind == "tool" {
                    let state = &part["state"];
                    let status = match state["status"].as_str() {
                        Some("completed")
                            if command_failed(
                                part["tool"].as_str().unwrap_or(""),
                                &state["metadata"],
                            ) =>
                        {
                            "failed"
                        }
                        Some("completed") => "completed",
                        Some("error") => "failed",
                        _ => "running",
                    };
                    return Ok(Some(Update::Tool {
                        id,
                        name: part["tool"].as_str().unwrap_or("").to_owned(),
                        input: state["input"].clone(),
                        output: state["output"].clone(),
                        exit_code: command_exit(&state["metadata"]),
                        metadata: state["metadata"].clone(),
                        status,
                        child_session: state["metadata"]["sessionId"]
                            .as_str()
                            .or_else(|| state["metadata"]["sessionID"].as_str())
                            .map(str::to_owned),
                    }));
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
    pub(crate) fn event(&mut self, event: &Value) -> Result<Option<Update>, String> {
        let kind = event["type"]
            .as_str()
            .ok_or("Missing OpenCode event type")?;
        let data = &event["data"];
        let session = data["sessionID"]
            .as_str()
            .or_else(|| data["form"]["sessionID"].as_str());
        if session != Some(self.session.as_str()) {
            return Ok(None);
        }
        match kind {
            "session.execution.started" => Ok(Some(Update::Started)),
            "session.execution.succeeded" => Ok(Some(Update::Terminal("completed"))),
            "session.execution.interrupted" => Ok(Some(Update::Terminal("interrupted"))),
            "session.execution.failed" => Ok(Some(Update::Terminal("failed"))),
            "t3.reconnect.failed" => Ok(Some(Update::Terminal("reconnect_failed"))),
            "t3.reconnect.missing" => Ok(Some(Update::Terminal("interrupted"))),
            "permission.asked" => Ok(Some(Update::Permission(data.clone()))),
            "form.created" => Ok(Some(Update::Question(data["form"].clone()))),
            kind if kind.starts_with("session.text.") || kind.starts_with("session.reasoning.") => {
                let message = data["assistantMessageID"]
                    .as_str()
                    .ok_or("Missing OpenCode message id")?;
                let ordinal = data["ordinal"]
                    .as_u64()
                    .ok_or("Missing OpenCode text ordinal")?;
                let reasoning = kind.starts_with("session.reasoning.");
                let id = format!(
                    "{}:{}:{}",
                    message,
                    if reasoning { "reasoning" } else { "text" },
                    ordinal
                );
                if !self.texts.contains_key(&id) && self.texts.len() >= 1024 {
                    return Err("OpenCode item limit exceeded".into());
                }
                let text = self.texts.entry(id.clone()).or_default();
                let previous_len = text.len();
                if let Some(delta) = data["delta"].as_str() {
                    text.push_str(delta);
                }
                if let Some(final_text) = data["text"].as_str() {
                    *text = final_text.to_owned();
                }
                self.text_bytes = self
                    .text_bytes
                    .saturating_sub(previous_len)
                    .saturating_add(text.len());
                if self.text_bytes > 16 * 1024 * 1024 {
                    return Err("OpenCode text limit exceeded".into());
                }
                Ok(Some(Update::Text {
                    id,
                    text: text.clone(),
                    reasoning,
                    completed: kind.ends_with(".ended"),
                }))
            }
            kind if kind.starts_with("session.tool.") => {
                let id = format!(
                    "{}{}",
                    self.scope,
                    data["id"].as_str().ok_or("Missing OpenCode tool id")?
                );
                if !self.tools.contains_key(&id) && self.tools.len() >= 1024 {
                    return Err("OpenCode tool limit exceeded".into());
                }
                let tool = self.tools.entry(id.clone()).or_default();
                let previous_size = tool
                    .name
                    .len()
                    .saturating_add(tool.input.to_string().len())
                    .saturating_add(tool.output.to_string().len());
                if let Some(name) = data["name"].as_str() {
                    tool.name = name.to_owned();
                }
                if !data["input"].is_null() {
                    tool.input = data["input"].clone();
                }
                if !data["content"].is_null() {
                    tool.output = data["content"].clone();
                }
                if !data["error"].is_null() {
                    tool.output = data["error"].clone();
                }
                if let Some(child) = data["metadata"]["sessionID"].as_str() {
                    tool.child_session = Some(child.to_owned());
                }
                let next_size = tool
                    .name
                    .len()
                    .saturating_add(tool.input.to_string().len())
                    .saturating_add(tool.output.to_string().len());
                self.tool_bytes = self
                    .tool_bytes
                    .saturating_sub(previous_size)
                    .saturating_add(next_size);
                if self.tool_bytes > 16 * 1024 * 1024 {
                    return Err("OpenCode tool data limit exceeded".into());
                }
                let status = match kind {
                    "session.tool.success" if command_failed(&tool.name, &data["metadata"]) => {
                        "failed"
                    }
                    "session.tool.success" => "completed",
                    "session.tool.failed" => "failed",
                    _ => "running",
                };
                Ok(Some(Update::Tool {
                    id,
                    name: tool.name.clone(),
                    input: tool.input.clone(),
                    output: tool.output.clone(),
                    exit_code: command_exit(&data["metadata"]),
                    metadata: data["metadata"].clone(),
                    status,
                    child_session: tool.child_session.clone(),
                }))
            }
            _ => Ok(None),
        }
    }
}
fn command_exit(metadata: &Value) -> Option<i64> {
    metadata["exit"]
        .as_i64()
        .or_else(|| metadata["exitCode"].as_i64())
}
fn command_failed(name: &str, metadata: &Value) -> bool {
    let name = name.to_ascii_lowercase();
    !name.starts_with("mcp__")
        && !name.starts_with("t3-code_")
        && (name.contains("bash") || name.contains("shell"))
        && command_exit(metadata).is_some_and(|code| code != 0)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_success_with_nonzero_exit_is_a_failed_command() {
        let mut decoder = Decoder::new("ses".into());
        decoder.event(&json!({"type":"session.tool.input.started","data":{"sessionID":"ses","id":"call","name":"shell"}})).unwrap();
        let update=decoder.event(&json!({"type":"session.tool.success","data":{"sessionID":"ses","id":"call","metadata":{"exit":7},"content":[{"type":"text","text":"error"}]}})).unwrap();
        assert!(matches!(
            update,
            Some(Update::Tool {
                status: "failed",
                exit_code: Some(7),
                ..
            })
        ));
    }
    use serde_json::json;
    #[test]
    fn v1_user_parts_do_not_become_assistant_messages() {
        let mut decoder = Decoder::new("ses".into());
        let message = |id, role| json!({"type":"message.updated","properties":{"sessionID":"ses","info":{"id":id,"role":role}}});
        let text = |id| json!({"type":"message.part.updated","properties":{"sessionID":"ses","part":{"id":"part","messageID":id,"type":"text","text":"example"}}});
        decoder.event_v1(&message("u", "user")).unwrap();
        decoder.event_v1(&message("a", "assistant")).unwrap();
        assert_eq!(decoder.event_v1(&text("u")).unwrap(), None);
        assert_eq!(decoder.event_v1(&text("unknown")).unwrap(), None);
        decoder.event_v1(&message("unknown", "assistant")).unwrap();
        assert!(
            matches!(decoder.drain_ready().as_slice(), [Update::Text { text, .. }] if text == "example")
        );
        assert!(matches!(
            decoder.event_v1(&text("a")).unwrap(),
            Some(Update::Text {
                reasoning: false,
                ..
            })
        ));
    }
    #[test]
    fn decodes_cumulative_text_tools_and_session_boundaries() {
        let mut decoder = Decoder::new("ses_1".into());
        assert_eq!(
            decoder
                .event(
                    &json!({"type":"session.execution.succeeded","data":{"sessionID":"ses_other"}})
                )
                .unwrap(),
            None
        );
        assert!(matches!(
            decoder
                .event(&json!({"type":"session.execution.started","data":{"sessionID":"ses_1"}}))
                .unwrap(),
            Some(Update::Started)
        ));
        let delta = |text| json!({"type":"session.text.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_1","ordinal":0,"delta":text}});
        decoder.event(&delta("hel")).unwrap();
        assert!(
            matches!(decoder.event(&delta("lo")).unwrap(), Some(Update::Text{text,..}) if text == "hello")
        );
        assert!(
            matches!(decoder.event(&json!({"type":"session.text.ended","data":{"sessionID":"ses_1","assistantMessageID":"msg_1","ordinal":0,"text":"hello"}})).unwrap(), Some(Update::Text{completed:true,text,..}) if text == "hello")
        );
        decoder.event(&json!({"type":"session.tool.input.started","data":{"sessionID":"ses_1","id":"call_1","name":"shell"}})).unwrap();
        assert!(
            matches!(decoder.event(&json!({"type":"session.tool.called","data":{"sessionID":"ses_1","id":"call_1","input":{"command":"true"}}})).unwrap(), Some(Update::Tool{name,input,..}) if name == "shell" && input["command"] == "true")
        );
        assert!(matches!(decoder.event(&json!({"type":"session.tool.success","data":{"sessionID":"ses_1","id":"call_1","content":[]}})).unwrap(), Some(Update::Tool{status:"completed",..})));
        assert!(matches!(
            decoder
                .event(
                    &json!({"type":"permission.asked","data":{"sessionID":"ses_1","id":"per_1"}})
                )
                .unwrap(),
            Some(Update::Permission(_))
        ));
        assert!(matches!(
            decoder
                .event(
                    &json!({"type":"session.execution.interrupted","data":{"sessionID":"ses_1"}})
                )
                .unwrap(),
            Some(Update::Terminal("interrupted"))
        ));
    }
}
