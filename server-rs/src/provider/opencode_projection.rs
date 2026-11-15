//! Translate decoded OpenCode items into provider-neutral orchestration events.
use super::{
    codex_events::{
        AssistantArtifact, FailureClass, NormalizedEvent, ProviderFailure, ReasoningArtifact,
        RootTurn, ThreadDisposition, ToolArtifact, TurnStatus,
    },
    opencode_events::Update,
};
use serde_json::json;
use std::collections::HashMap;

fn read_output(value: &str) -> String {
    let Some(rest) = value.strip_prefix("<path>") else {
        return value.to_owned();
    };
    let Some((path, rest)) = rest.split_once("</path>") else {
        return value.to_owned();
    };
    if path.is_empty() || path.contains(['\r', '\n']) {
        return value.to_owned();
    }
    let Some(rest) = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
    else {
        return value.to_owned();
    };
    let (open, close, rest) = if let Some(rest) = rest
        .strip_prefix("<type>directory</type>\r\n")
        .or_else(|| rest.strip_prefix("<type>directory</type>\n"))
    {
        ("<entries>", "</entries>", rest)
    } else if let Some(rest) = rest
        .strip_prefix("<type>file</type>\r\n")
        .or_else(|| rest.strip_prefix("<type>file</type>\n"))
    {
        ("<content>", "</content>", rest)
    } else {
        return value.to_owned();
    };
    let Some(mut body) = rest.strip_prefix(open) else {
        return value.to_owned();
    };
    if open == "<entries>" {
        let Some(rest) = body
            .strip_prefix("\r\n")
            .or_else(|| body.strip_prefix('\n'))
        else {
            return value.to_owned();
        };
        body = rest;
    } else if let Some(rest) = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
    {
        body = rest;
        if let Some(suffix) = body.strip_prefix(close) {
            if suffix.is_empty() || suffix.starts_with('\n') || suffix.starts_with("\r\n") {
                return suffix.to_owned();
            }
        }
    }
    let marker = format!("\n{close}");
    let Some(index) = body.find(&marker) else {
        return value.to_owned();
    };
    let end = index + marker.len();
    let suffix = &body[end..];
    if !suffix.is_empty() && !suffix.starts_with('\n') && !suffix.starts_with("\r\n") {
        return value.to_owned();
    }
    format!(
        "{}{}",
        body[..index].strip_suffix('\r').unwrap_or(&body[..index]),
        suffix
    )
}

pub(crate) struct Projector {
    turn: RootTurn,
    ordinals: HashMap<String, u64>,
    next: u64,
    settled: bool,
}
impl Projector {
    pub(crate) fn new(turn: RootTurn) -> Self {
        let next = if turn.run_id.is_none() {
            1
        } else {
            turn.run_ordinal.saturating_mul(1_000_000).saturating_add(2)
        };
        Self {
            turn,
            ordinals: HashMap::new(),
            next,
            settled: false,
        }
    }
    pub(crate) fn set_native_turn_id(&mut self, id: &str) {
        self.turn.native_turn_id = id.to_owned();
    }
    pub(crate) fn child(turn: RootTurn, has_prompt: bool) -> Self {
        let mut projector = Self::new(turn);
        if has_prompt {
            projector.next = 2;
        }
        projector
    }
    pub(crate) fn ordinal(&mut self, id: &str) -> Result<u64, String> {
        if let Some(value) = self.ordinals.get(id) {
            return Ok(*value);
        }
        if self.ordinals.len() >= 2048 {
            return Err("OpenCode item limit exceeded".into());
        }
        let value = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or("OpenCode ordinal overflow")?;
        self.ordinals.insert(id.to_owned(), value);
        Ok(value)
    }
    pub(crate) fn project(
        &mut self,
        update: Update,
        at: &str,
    ) -> Result<Vec<NormalizedEvent>, String> {
        if self.settled {
            return Ok(Vec::new());
        }
        match update {
            Update::Text {
                id,
                text,
                reasoning,
                completed,
            } => {
                let ordinal = self.ordinal(&id)?;
                let artifact = AssistantArtifact {
                    turn: self.turn.clone(),
                    native_item_id: id.clone(),
                    phase: None,
                    text,
                    ordinal,
                    started_at: self.turn.started_at.clone(),
                    updated_at: at.into(),
                    completed,
                };
                if reasoning {
                    let artifact = ReasoningArtifact {
                        artifact,
                        native_reasoning_item_id: id,
                        stream: "text".into(),
                        index: 0,
                        interrupted: false,
                    };
                    Ok(vec![
                        NormalizedEvent::ReasoningNodeUpdated(artifact.clone()),
                        NormalizedEvent::ReasoningTurnItemUpdated(artifact),
                    ])
                } else {
                    Ok(vec![
                        NormalizedEvent::NodeUpdated(artifact.clone()),
                        NormalizedEvent::MessageUpdated(artifact.clone()),
                        NormalizedEvent::TurnItemUpdated(artifact),
                    ])
                }
            }
            Update::Tool {
                id,
                name,
                input,
                output,
                exit_code,
                metadata,
                status,
                ..
            } => {
                let ordinal = self.ordinal(&id)?;
                let normalized = name.to_ascii_lowercase();
                let command = !normalized.starts_with("mcp__")
                    && !normalized.starts_with("t3-code_")
                    && (normalized.contains("bash") || normalized.contains("shell"));
                let (kind, fields) = if command {
                    let command = input["command"]
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            input["cmd"]
                                .as_str()
                                .filter(|value| !value.trim().is_empty())
                        })
                        .map(str::to_owned)
                        .unwrap_or_else(|| input.to_string());
                    let text = output.as_str().map(str::to_owned).or_else(|| {
                        output.as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| part["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    });
                    let mut fields = json!({"input":command});
                    if let Some(text) = text {
                        fields["output"] = json!(text);
                    }
                    if let Some(exit) = exit_code {
                        fields["exitCode"] = json!(exit);
                    }
                    ("command_execution", fields)
                } else if !normalized.starts_with("mcp__")
                    && !normalized.starts_with("t3-code_")
                    && (normalized.contains("edit")
                        || normalized.contains("write")
                        || normalized.contains("patch"))
                    && normalized != "todowrite"
                {
                    let pick = |value: &serde_json::Value, keys: &[&str]| {
                        keys.iter()
                            .find_map(|key| value[*key].as_str().map(str::to_owned))
                    };
                    let mut fields = json!({"fileName":pick(&input,&["filePath","path","file"]).filter(|value|!value.trim().is_empty()).unwrap_or_else(||name.clone())});
                    if let Some(value) = pick(&input, &["oldString", "oldText"]) {
                        fields["oldStr"] = json!(value);
                    }
                    if let Some(value) = pick(&input, &["newString", "content", "newText"]) {
                        fields["newStr"] = json!(value);
                    }
                    let text = output.as_str().map(str::to_owned).or_else(|| {
                        output.as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| part["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    });
                    let diff = pick(&metadata, &["diff", "patch"])
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            if status == "failed" {
                                text.filter(|value| !value.trim().is_empty())
                            } else {
                                None
                            }
                        });
                    if let Some(value) = diff {
                        fields["diffStr"] = json!(value);
                    }
                    ("file_change", fields)
                } else if !normalized.starts_with("mcp__")
                    && !normalized.starts_with("t3-code_")
                    && normalized != "read"
                    && (normalized.contains("web")
                        || normalized == "codesearch"
                        || normalized == "code_search"
                        || normalized.contains("glob")
                        || normalized.contains("grep")
                        || normalized.contains("search")
                        || normalized.contains("lsp"))
                {
                    let pick = |keys: &[&str]| {
                        keys.iter().find_map(|key| {
                            input[*key]
                                .as_str()
                                .filter(|value| !value.trim().is_empty())
                                .map(str::to_owned)
                        })
                    };
                    let text = output.as_str().map(str::to_owned).or_else(|| {
                        output.as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| part["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    });
                    let web = normalized.contains("web")
                        || normalized == "codesearch"
                        || normalized == "code_search";
                    if web {
                        let pattern = pick(&["query", "url", "pattern"]);
                        let url = pick(&["url"]);
                        let mut fields = json!({});
                        if let Some(pattern) = pattern {
                            fields["patterns"] = json!([pattern]);
                        }
                        if let Some(text) = text.filter(|s| !s.trim().is_empty()) {
                            let mut result =
                                json!({"snippet":text.chars().take(8000).collect::<String>()});
                            if let Some(url) = url {
                                result["url"] = json!(url.trim());
                            }
                            fields["results"] = json!([result]);
                        }
                        ("web_search", fields)
                    } else {
                        let pattern = pick(&["pattern", "query", "path", "filePath"]);
                        let root = pick(&["path", "filePath"]).or_else(|| pattern.clone());
                        let mut fields = json!({});
                        if let Some(pattern) = pattern {
                            fields["pattern"] = json!(pattern);
                        }
                        if let (Some(root), Some(text)) =
                            (root, text.filter(|s| !s.trim().is_empty()))
                        {
                            fields["results"] = json!([{"fileName":root.trim(),"preview":text.chars().take(8000).collect::<String>()}]);
                        }
                        ("file_search", fields)
                    }
                } else {
                    use base64::Engine;
                    let mut fields = json!({"toolName":name,"input":input});
                    if normalized == "read" {
                        if let Some(path) = ["filePath", "path", "file"].iter().find_map(|key| {
                            input[*key]
                                .as_str()
                                .filter(|value| !value.trim().is_empty())
                        }) {
                            fields["title"] = json!(format!("Read {}", path.trim()));
                        }
                    }
                    let text = output.as_str().map(str::to_owned).or_else(|| {
                        output.as_array().map(|parts| {
                            parts
                                .iter()
                                .filter(|part| part["type"] == "text")
                                .filter_map(|part| {
                                    part["text"].as_str().filter(|value| !value.is_empty())
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    });
                    let text = text.map(|value| {
                        if normalized == "read" {
                            read_output(&value)
                        } else {
                            value
                        }
                    });
                    let mut images = Vec::new();
                    for part in output
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|part| part["type"] == "file")
                    {
                        let (Some(uri), Some(mime)) = (part["uri"].as_str(), part["mime"].as_str())
                        else {
                            continue;
                        };
                        let Some(encoded) = uri.strip_prefix(&format!("data:{mime};base64,"))
                        else {
                            continue;
                        };
                        if !mime.starts_with("image/")
                            || encoded.is_empty()
                            || encoded.len() > 13_981_016
                            || base64::engine::general_purpose::STANDARD
                                .decode(encoded)
                                .is_err()
                        {
                            continue;
                        }
                        images.push(json!({"type":"image","mimeType":mime,"data":encoded}));
                        if images.len() == 8 {
                            break;
                        }
                    }
                    if images.is_empty() {
                        if let Some(text) = text {
                            fields["output"] = json!(text);
                        }
                    } else {
                        let mut content = Vec::new();
                        if let Some(text) = text.filter(|value| !value.is_empty()) {
                            content.push(json!({"type":"text","text":text}));
                        }
                        content.extend(images);
                        fields["output"] = json!({"content":content});
                    }
                    ("dynamic_tool", fields)
                };
                Ok(vec![NormalizedEvent::ToolUpdated(ToolArtifact {
                    turn: self.turn.clone(),
                    native_item_id: id,
                    ordinal,
                    started_at: self.turn.started_at.clone(),
                    updated_at: at.into(),
                    status: status.into(),
                    kind: kind.into(),
                    fields,
                })])
            }
            Update::Terminal(status) => {
                let status_name = status;
                self.settled = true;
                let status = match status {
                    "completed" => TurnStatus::Completed,
                    "interrupted" => TurnStatus::Interrupted,
                    _ => TurnStatus::Failed,
                };
                let failure = (status == TurnStatus::Failed).then(|| ProviderFailure {
                    class: FailureClass::ProviderError,
                    message: if status_name == "reconnect_failed" {
                        "OpenCode ended the turn with an error while T3 Code was reconnecting."
                    } else {
                        "OpenCode provider turn failed."
                    }
                    .into(),
                    code: None,
                    retryable: if status_name == "reconnect_failed" {
                        None
                    } else {
                        Some(false)
                    },
                    managed_usage_limit: false,
                });
                Ok(vec![
                    NormalizedEvent::ProviderTurnUpdated {
                        turn: self.turn.clone(),
                        status,
                        completed_at: Some(at.into()),
                    },
                    NormalizedEvent::TurnTerminal {
                        failure_item_ordinal: (status == TurnStatus::Failed).then_some(self.next),
                        turn: self.turn.clone(),
                        status,
                        failure,
                        thread_disposition: ThreadDisposition::Reusable,
                    },
                ])
            }
            Update::Started | Update::Permission(_) | Update::Question(_) => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_read_envelope_preserves_following_instructions() {
        assert_eq!(
            read_output("<path>a</path>\n<type>file</type>\n<content>\n</content>\nmore"),
            "\nmore"
        );
        assert_eq!(
            read_output(
                "<path>a.txt</path>\n<type>file</type>\n<content>\n1: hello\n</content>\nmore"
            ),
            "1: hello\nmore"
        );
        assert_eq!(
            read_output(
                "<path>a.txt</path>\n<type>file</type>\n<content>\n1: hello\n</content>suffix"
            ),
            "<path>a.txt</path>\n<type>file</type>\n<content>\n1: hello\n</content>suffix"
        );
    }
    #[test]
    fn projection_keeps_item_identity_and_settles_once() {
        let turn = RootTurn {
            driver: "opencode".into(),
            native_thread_id: "ses".into(),
            native_turn_id: "turn".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "turn-id".into(),
            thread_id: "thread".into(),
            run_id: Some("run".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:00Z".into(),
        };
        let mut projector = Projector::new(turn);
        let edit = projector
            .project(
                Update::Tool {
                    id: "edit".into(),
                    name: "edit".into(),
                    input: json!({"filePath":"a.txt","oldString":"a","newString":"b"}),
                    output: serde_json::Value::Null,
                    metadata: json!({"diff":"-a\n+b"}),
                    exit_code: None,
                    status: "completed",
                    child_session: None,
                },
                "2026-01-01T00:00:01Z",
            )
            .unwrap();
        let NormalizedEvent::ToolUpdated(edit) = &edit[0] else {
            panic!("missing file edit")
        };
        assert_eq!(edit.kind, "file_change");
        assert_eq!(edit.fields["fileName"], "a.txt");
        assert_eq!(edit.fields["diffStr"], "-a\n+b");
        let text = |value: &str| Update::Text {
            id: "msg:text:0".into(),
            text: value.into(),
            reasoning: false,
            completed: false,
        };
        let first = projector
            .project(text("a"), "2026-01-01T00:00:01Z")
            .unwrap();
        let second = projector
            .project(text("ab"), "2026-01-01T00:00:02Z")
            .unwrap();
        let (NormalizedEvent::NodeUpdated(first), NormalizedEvent::NodeUpdated(second)) =
            (&first[0], &second[0])
        else {
            panic!("missing message node");
        };
        assert_eq!(first.ordinal, second.ordinal);
        assert_eq!(first.native_item_id, second.native_item_id);
        assert_eq!(second.text, "ab");
        assert_eq!(
            projector
                .project(Update::Terminal("completed"), "2026-01-01T00:00:03Z")
                .unwrap()
                .len(),
            2
        );
        assert!(projector
            .project(Update::Terminal("failed"), "2026-01-01T00:00:04Z")
            .unwrap()
            .is_empty());
    }
}
