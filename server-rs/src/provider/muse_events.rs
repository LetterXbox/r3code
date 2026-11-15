//! Muse notification state, scoped to one native session and turn.
use serde_json::Value;
use std::collections::HashMap;

const ITEM_LIMIT: usize = 2048;
const TEXT_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn approval_choices(approval: &Value) -> Result<HashMap<String, Value>, String> {
    let choices = approval["availableChoices"]
        .as_array()
        .ok_or("Invalid Muse approval choices")?;
    if choices.len() > 128 {
        return Err("Too many Muse approval choices".into());
    }
    let mut result: HashMap<String, (u8, Value)> = HashMap::new();
    for choice in choices {
        let (Some(id), Some(label), Some(decision), Some(scope)) = (
            choice["choiceId"].as_str(),
            choice["label"].as_str(),
            choice["decision"].as_str(),
            choice["scope"].as_str(),
        ) else {
            return Err("Invalid Muse approval choice".into());
        };
        if id.is_empty() || decision.is_empty() {
            return Err("Invalid Muse approval choice".into());
        }
        let mapped = match decision {
            "approved" => Some("accept"),
            "approvedForSession" => Some("acceptForSession"),
            "approvedPolicyAmendment" if scope == "session" => Some("acceptForSession"),
            "approvedPolicyAmendment" if scope == "localPersistent" => Some("acceptAlways"),
            "denied" | "deniedPolicyAmendment" => Some("decline"),
            "abort" => Some("cancel"),
            _ => None,
        };
        if let Some(mapped) = mapped {
            let rank = (if scope == "once" {
                0
            } else if scope == "session" {
                2
            } else {
                4
            }) + u8::from(decision.ends_with("PolicyAmendment"));
            if result.get(mapped).is_none_or(|(old, _)| rank < *old) {
                result.insert(
                    mapped.to_owned(),
                    (rank, serde_json::json!({"choiceId":id,"label":label})),
                );
            }
        }
    }
    if !result.contains_key("decline") {
        if let Some(abort) = result.get("cancel").cloned() {
            result.insert("decline".into(), abort);
        }
    }
    Ok(result
        .into_iter()
        .map(|(decision, (_, choice))| (decision, choice))
        .collect())
}

pub(crate) fn question_answers(request: &Value, answers: &Value) -> Result<Vec<Value>, String> {
    let questions = request["questions"]
        .as_array()
        .ok_or("Invalid Muse questions")?;
    if questions.len() > 128 {
        return Err("Too many Muse questions".into());
    }
    let mut result = Vec::new();
    for question in questions {
        let id = question["id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("Invalid Muse question")?;
        let raw = &answers[id];
        let values: Vec<&str> = if let Some(value) = raw.as_str() {
            vec![value]
        } else {
            raw.as_array()
                .ok_or("Invalid Muse answer")?
                .iter()
                .map(|value| value.as_str().ok_or("Invalid Muse answer"))
                .collect::<Result<_, _>>()?
        };
        let mut distinct = Vec::new();
        for value in values {
            if !distinct.contains(&value) {
                distinct.push(value);
            }
        }
        let options = question["options"]
            .as_array()
            .ok_or("Invalid Muse options")?;
        let (selected, free): (Vec<_>, Vec<_>) = distinct
            .into_iter()
            .partition(|value| options.iter().any(|option| option["label"] == *value));
        let free = free.join("\n");
        if free.encode_utf16().count() > 500 || (free.is_empty() && selected.is_empty()) {
            return Err("Invalid Muse answer".into());
        }
        let mode = question["selection"]["mode"]
            .as_str()
            .ok_or("Invalid Muse selection")?;
        let min = question["selection"]["minSelections"].as_u64().unwrap_or(0) as usize;
        let max = question["selection"]["maxSelections"]
            .as_u64()
            .map(|value| value as usize)
            .unwrap_or(usize::MAX);
        if !matches!(mode, "single" | "multiple")
            || (mode == "single" && selected.len() > 1)
            || (!selected.is_empty() && (selected.len() < min || selected.len() > max))
        {
            return Err("Invalid Muse selection count".into());
        }
        let mut answer = serde_json::json!({"questionId":id});
        if !selected.is_empty() {
            if mode == "single" {
                answer["selectedLabel"] = serde_json::json!(selected[0]);
            } else {
                answer["selectedLabels"] = serde_json::json!(selected);
            }
        }
        if !free.is_empty() {
            answer[if selected.is_empty() {
                "freeText"
            } else {
                "note"
            }] = serde_json::json!(free);
        }
        result.push(answer);
    }
    Ok(result)
}

pub(crate) fn merge_token_usage(
    previous: &Value,
    event: &Value,
    complete: bool,
    has_subagents: bool,
) -> Result<Value, String> {
    let usage = &event["usage"];
    let required = |key: &str| usage[key].as_u64().ok_or("Invalid Muse token usage");
    let prior = |key: &str| {
        if complete {
            0
        } else {
            previous[key].as_u64().unwrap_or(0)
        }
    };
    let input = if complete {
        previous["inputTokens"]
            .as_u64()
            .unwrap_or(required("inputTokens")?)
    } else {
        prior("inputTokens").saturating_add(
            event["promptTokens"]
                .as_u64()
                .ok_or("Invalid Muse token usage")?,
        )
    };
    let cached = usage["cacheReadTokens"]
        .as_u64()
        .unwrap_or(required("cachedTokens")?);
    let mut result = serde_json::json!({"usageScope":"main_agent","usageStatus":if complete {"complete"} else {"partial"},"hasSubagents":has_subagents,"inputTokens":input,"outputTokens":prior("outputTokens").saturating_add(required("outputTokens")?),"cachedInputTokens":prior("cachedInputTokens").saturating_add(cached),"reasoningTokens":prior("reasoningTokens").saturating_add(required("reasoningTokens")?)});
    if usage["cacheWriteTokens"].as_u64().is_some()
        || (!complete && previous["cacheCreationTokens"].as_u64().is_some())
    {
        result["cacheCreationTokens"] = serde_json::json!(prior("cacheCreationTokens")
            .saturating_add(usage["cacheWriteTokens"].as_u64().unwrap_or(0)));
    }
    Ok(result)
}

pub(crate) struct MuseEvents {
    session: String,
    turn: String,
    items: HashMap<String, Value>,
    retained: usize,
}

impl MuseEvents {
    pub(crate) fn new(session: String, turn: String) -> Self {
        Self {
            session,
            turn,
            items: HashMap::new(),
            retained: 0,
        }
    }
    /// Returns a changed item or a terminal payload; unrelated sessions/turns are ignored.
    pub(crate) fn ingest(&mut self, frame: &Value) -> Result<Option<Value>, String> {
        let method = frame["method"]
            .as_str()
            .ok_or("Missing Muse notification method")?;
        let params = &frame["params"];
        if params["sessionId"]
            .as_str()
            .is_some_and(|id| id != self.session)
            || params["turnId"].as_str().is_some_and(|id| id != self.turn)
        {
            return Ok(None);
        }
        match method {
            "item/started" | "item/updated" | "item/completed" => {
                let item = &params["item"];
                let id = item["itemId"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .ok_or("Invalid Muse item ID")?;
                if item["turnId"].as_str().is_some_and(|id| id != self.turn) {
                    return Ok(None);
                }
                let revision = item["revision"]
                    .as_u64()
                    .filter(|v| *v > 0)
                    .ok_or("Invalid Muse item revision")?;
                if item["kind"].as_str().is_none_or(str::is_empty)
                    || item["status"].as_str().is_none_or(str::is_empty)
                {
                    return Err("Invalid Muse item".into());
                }
                if self
                    .items
                    .get(id)
                    .is_some_and(|old| old["revision"].as_u64().unwrap_or(0) >= revision)
                {
                    return Ok(None);
                }
                if !self.items.contains_key(id) && self.items.len() >= ITEM_LIMIT {
                    return Err("Muse item limit exceeded".into());
                }
                let size = serde_json::to_vec(item)
                    .map_err(|_| "Invalid Muse item")?
                    .len();
                let old = self
                    .items
                    .get(id)
                    .and_then(|v| serde_json::to_vec(v).ok())
                    .map_or(0, |v| v.len());
                let total = self.retained.saturating_sub(old).saturating_add(size);
                if size > TEXT_LIMIT || total > TOTAL_LIMIT {
                    return Err("Muse item too large".into());
                }
                self.retained = total;
                self.items.insert(id.to_owned(), item.clone());
                Ok(Some(item.clone()))
            }
            "item/delta" => {
                let id = params["itemId"].as_str().ok_or("Invalid Muse delta")?;
                let delta = params["delta"].as_str().ok_or("Invalid Muse delta")?;
                let Some(item) = self.items.get_mut(id) else {
                    return Ok(None);
                };
                if item["status"] != "inProgress" {
                    return Ok(None);
                }
                let field = params["field"].as_str().unwrap_or("text");
                if let Some(index) = field
                    .strip_prefix("summary.")
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|index| *index < 100)
                {
                    if self.retained.saturating_add(delta.len().saturating_mul(6)) > TOTAL_LIMIT {
                        return Err("Muse delta too large".into());
                    }
                    let summary = item["summary"].as_array().cloned().unwrap_or_default();
                    let mut summary = summary;
                    if summary.len() <= index {
                        summary.resize(index + 1, Value::String(String::new()));
                    }
                    let text = summary[index].as_str().unwrap_or("");
                    if text.len().saturating_add(delta.len()) > TEXT_LIMIT {
                        return Err("Muse delta too large".into());
                    }
                    summary[index] = Value::String(format!("{text}{delta}"));
                    item["summary"] = Value::Array(summary);
                    self.retained = self.retained.saturating_add(delta.len().saturating_mul(6));
                    return Ok(Some(item.clone()));
                }
                let key = match field {
                    "text" => "text",
                    "output" | "visibleOutput" => "visibleOutput",
                    _ => return Ok(None),
                };
                let old = item[key].as_str().unwrap_or("");
                if old.len().saturating_add(delta.len()) > TEXT_LIMIT
                    || self.retained.saturating_add(delta.len().saturating_mul(6)) > TOTAL_LIMIT
                {
                    return Err("Muse delta too large".into());
                }
                self.retained = self.retained.saturating_add(delta.len().saturating_mul(6));
                item[key] = Value::String(format!("{old}{delta}"));
                Ok(Some(item.clone()))
            }
            "turn/completed" if params["turnId"] == self.turn => Ok(Some(params.clone())),
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ignores_stale_revisions_and_foreign_turns_and_applies_deltas() {
        let mut events = MuseEvents::new("session".into(), "turn".into());
        let item = json!({"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"session","item":{"itemId":"a","turnId":"turn","revision":1,"kind":"assistantMessage","status":"inProgress","text":"one"}}});
        assert!(events.ingest(&item).unwrap().is_some());
        assert!(events.ingest(&item).unwrap().is_none());
        assert!(events.ingest(&json!({"method":"item/delta","params":{"sessionId":"wrong","itemId":"a","delta":"wrong"}})).unwrap().is_none());
        assert_eq!(events.ingest(&json!({"method":"item/delta","params":{"sessionId":"session","itemId":"a","delta":" two"}})).unwrap().unwrap()["text"], "one two");
    }
    #[test]
    fn approval_choices_prefer_once_and_fallback_decline_to_abort() {
        let result = approval_choices(&json!({"availableChoices":[
            {"choiceId":"persistent","label":"Always","decision":"approvedPolicyAmendment","scope":"localPersistent"},
            {"choiceId":"one","label":"Once","decision":"approved","scope":"once"},
            {"choiceId":"abort","label":"Stop","decision":"abort","scope":"once"}
        ]})).unwrap();
        assert_eq!(result["accept"]["choiceId"], "one");
        assert_eq!(result["acceptAlways"]["choiceId"], "persistent");
        assert_eq!(result["decline"]["choiceId"], "abort");
    }
    #[test]
    fn summary_delta_preserves_other_sections() {
        let mut events = MuseEvents::new("s".into(), "t".into());
        events.ingest(&json!({"method":"item/started","params":{"item":{"itemId":"a","turnId":"t","revision":1,"kind":"reasoning","status":"inProgress","summary":["one","two"]}}})).unwrap();
        let item = events.ingest(&json!({"method":"item/delta","params":{"itemId":"a","field":"summary.0","delta":"!"}})).unwrap().unwrap();
        assert_eq!(item["summary"], json!(["one!", "two"]));
    }
    #[test]
    fn questions_map_selection_and_free_text() {
        let request = json!({"questions":[{"id":"q","options":[{"label":"one"},{"label":"two"}],"selection":{"mode":"multiple","minSelections":1}}]});
        let answers = question_answers(&request, &json!({"q":["one","one","custom"]})).unwrap();
        assert_eq!(
            answers,
            vec![json!({"questionId":"q","selectedLabels":["one"],"note":"custom"})]
        );
        assert!(question_answers(&request, &json!({"q":[]})).is_err());
    }
    #[test]
    fn usage_accumulates_partial_and_replaces_terminal_totals() {
        let usage = json!({"promptTokens":5,"usage":{"inputTokens":4,"outputTokens":2,"cachedTokens":1,"reasoningTokens":1}});
        let first = merge_token_usage(&json!({}), &usage, false, false).unwrap();
        let second = merge_token_usage(&first, &usage, false, false).unwrap();
        assert_eq!(second["inputTokens"], 10);
        assert_eq!(second["outputTokens"], 4);
        let final_usage = merge_token_usage(&second, &usage, true, true).unwrap();
        assert_eq!(final_usage["inputTokens"], 10);
        assert_eq!(final_usage["outputTokens"], 2);
        assert_eq!(final_usage["usageStatus"], "complete");
    }
}
