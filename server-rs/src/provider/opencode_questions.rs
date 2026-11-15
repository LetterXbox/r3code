//! Live OpenCode structured question projection and answer delivery.
use crate::{
    event_bus::EventBus,
    provider::{
        codex_events::RootTurn,
        codex_requests::{self, RequestArtifacts},
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::sync::oneshot;

struct Pending {
    thread: String,
    reply: oneshot::Sender<Option<Value>>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn deliver(id: &str, answers: Option<&Value>) -> Result<(), String> {
    let answers = answers.cloned();
    if answers.as_ref().is_some_and(|v| !v.is_object()) {
        return Err("Invalid OpenCode question answers".into());
    }
    let request = pending()
        .lock()
        .map_err(|_| "OpenCode question registry unavailable")?
        .remove(id)
        .ok_or("Unknown or expired OpenCode question")?;
    request
        .reply
        .send(answers)
        .map_err(|_| "OpenCode question is no longer active".into())
}
pub(crate) fn owns(id: &str) -> bool {
    pending().lock().is_ok_and(|map| map.contains_key(id))
}
pub(crate) fn cancel_thread(thread: &str) {
    if let Ok(mut map) = pending().lock() {
        let ids: Vec<_> = map
            .iter()
            .filter(|(_, v)| v.thread == thread)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(request) = map.remove(&id) {
                let _ = request.reply.send(None);
            }
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Question {
    pub id: String,
    pub header: String,
    pub text: String,
    pub multi: bool,
    pub custom: bool,
    pub options: Vec<Value>,
}
pub(crate) fn parse(raw: &Value, v2: bool) -> Result<Vec<Question>, String> {
    let values = if v2 {
        raw["fields"].as_array()
    } else {
        raw["questions"].as_array()
    }
    .filter(|v| !v.is_empty())
    .ok_or("OpenCode question has no fields")?;
    if values.len() > 100 {
        return Err("Too many OpenCode questions".into());
    }
    let mut out = Vec::new();
    static SLUG: OnceLock<regex::Regex> = OnceLock::new();
    let slug_pattern = SLUG.get_or_init(|| regex::Regex::new("[^a-z0-9_-]+").unwrap());
    for (index, field) in values.iter().enumerate() {
        if v2 && !matches!(field["type"].as_str(), Some("string" | "multiselect")) {
            return Err("Unsupported OpenCode form field".into());
        }
        if v2
            && (field["hidden"] == true || field["when"].as_array().is_some_and(|v| !v.is_empty()))
        {
            return Err("Unsupported OpenCode form field".into());
        }
        let header = if v2 {
            field["title"].as_str()
        } else {
            field["header"].as_str()
        }
        .unwrap_or("")
        .trim();
        let text = if v2 {
            field["description"].as_str()
        } else {
            field["question"].as_str()
        }
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(header)
        .trim();
        let id = if v2 {
            field["key"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("OpenCode form field has no key")?
                .to_owned()
        } else {
            let lower = header.to_ascii_lowercase();
            let slug = slug_pattern.replace_all(&lower, "-");
            if slug.is_empty() {
                format!("question-{index}")
            } else {
                format!("question-{index}-{slug}")
            }
        };
        let options=field["options"].as_array().into_iter().flatten().map(|option| {let label=option["label"].as_str().or_else(||option["value"].as_str()).unwrap_or("Option");let mut value=json!({"label":label,"description":option["description"].as_str().unwrap_or(label)});if v2 && option["value"].is_string(){value["value"]=option["value"].clone();}value}).collect::<Vec<_>>();
        out.push(Question {
            id,
            header: if header.is_empty() {
                format!("Question {}", index + 1)
            } else {
                header.into()
            },
            text: text.into(),
            multi: if v2 {
                field["type"] == "multiselect"
            } else {
                field["multiple"] == true
            },
            custom: field["custom"] == true || (v2 && options.is_empty()),
            options,
        });
    }
    Ok(out)
}
pub(crate) fn native_answer(questions: &[Question], answers: &Value, v2: bool) -> Value {
    let mut map = serde_json::Map::new();
    let mut rows = Vec::new();
    for q in questions {
        let value = answers
            .get(&q.id)
            .or_else(|| answers.get(&q.header))
            .or_else(|| answers.get(&q.text));
        let values: Vec<String> = match value {
            Some(Value::String(value)) if !value.trim().is_empty() => vec![value.clone()],
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .collect(),
            _ => vec![],
        };
        if v2 && !values.is_empty() {
            map.insert(
                q.id.clone(),
                if q.multi {
                    json!(values)
                } else {
                    json!(values.join(", "))
                },
            );
        }
        if !v2 {
            rows.push(json!(values));
        }
    }
    if v2 {
        Value::Object(map)
    } else {
        Value::Array(rows)
    }
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn project(
    bus: &EventBus,
    turn: &RootTurn,
    session: &str,
    native: &str,
    questions: &[Question],
    ordinal: u64,
    cancelled: &Arc<AtomicBool>,
    parent_node: Option<&str>,
) -> Result<oneshot::Receiver<Option<Value>>, String> {
    let id = format!(
        "runtime-request:provider:opencode:{}:{}",
        turn.provider_turn_id,
        uuid::Uuid::new_v4()
    );
    let node = format!("node:runtime-request:{id}");
    let item = format!("turn-item:runtime-request:{id}");
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let reference = json!({"driver":"opencode","nativeId":native,"strength":"strong"});
    let node_value = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":parent_node.unwrap_or(&turn.root_node_id),"rootNodeId":turn.root_node_id,"kind":"user_input_request","status":"waiting","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":id,"checkpointScopeId":null,"startedAt":at,"completedAt":null});
    let request = json!({"id":id,"nodeId":node,"providerTurnId":turn.provider_turn_id,"nativeRequestRef":reference,"kind":"user_input","status":"pending","responseCapability":{"type":"live","providerSessionId":session},"createdAt":at,"resolvedAt":null});
    let questions=questions.iter().map(|q|json!({"id":q.id,"header":q.header,"question":q.text,"options":q.options,"multiSelect":q.multi,"allowCustomAnswer":q.custom})).collect::<Vec<_>>();
    let item_value = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":null,"startedAt":at,"completedAt":null,"updatedAt":at,"type":"user_input_request","requestId":id,"questions":questions});
    let artifact = RequestArtifacts {
        request,
        node: node_value,
        item: item_value,
        method: "opencode:question".into(),
        params: json!({}),
    };
    let (tx, rx) = oneshot::channel();
    let mut map = pending()
        .lock()
        .map_err(|_| "OpenCode question registry unavailable")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("OpenCode turn already cancelled".into());
    }
    map.insert(
        id.clone(),
        Pending {
            thread: turn.thread_id.clone(),
            reply: tx,
        },
    );
    if let Err(error) = codex_requests::ingest(bus, turn, &artifact, &at) {
        map.remove(&id);
        return Err(error.to_string());
    }
    Ok(rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn form_and_legacy_question_answers_preserve_native_shapes() {
        let form = json!({"fields":[{"key":"color","title":"Color","description":"Pick one","type":"string","options":[{"value":"blue","label":"Blue"}]},{"key":"flags","title":"Flags","type":"multiselect","custom":true}]});
        let questions = parse(&form, true).unwrap();
        assert_eq!(questions[0].options[0]["value"], "blue");
        assert_eq!(
            native_answer(&questions, &json!({"color":"blue","flags":["a","b"]}), true),
            json!({"color":"blue","flags":["a","b"]})
        );
        assert!(parse(&json!({"fields":[{"key":"x","type":"external"}]}), true).is_err());
        assert!(parse(
            &json!({"fields":[{"key":"x","type":"string","when":[{}]}]}),
            true
        )
        .is_err());
        let legacy = parse(
            &json!({"questions":[{"header":"Scope","question":"Which?","multiple":false}]}),
            false,
        )
        .unwrap();
        assert_eq!(
            native_answer(&legacy, &json!({"Scope":"All"}), false),
            json!([["All"]])
        );
    }
}
