//! ACP supplies system guidance as prompt blocks because it has no system role.
use serde_json::{json, Value};

pub(crate) fn apply(
    prompt: &mut Vec<Value>,
    mode: &str,
    driver: &str,
    model: &str,
    has_mcp: bool,
    previous_mode: Option<&str>,
    previous_runtime: Option<&str>,
) -> (Option<String>, Option<String>) {
    let Some(index) = prompt.iter().position(|part| part["type"] == "text") else {
        return (None, None);
    };
    let text = prompt[index]["text"].as_str().unwrap_or("").to_owned();
    if text.trim_start().starts_with('/') {
        return (None, None);
    }
    let normalized_mode = if mode == "plan" { "plan" } else { "default" };
    let mut state = None;
    if previous_mode != Some(normalized_mode) {
        let mode_prompt = if normalized_mode == "plan" {
            include_str!("acp_plan_mode.txt")
        } else {
            include_str!("acp_default_mode.txt")
        };
        let mut sections = vec![mode_prompt.trim()];
        if has_mcp {
            sections.extend([
                include_str!("acp_browser_prompt.txt").trim(),
                include_str!("acp_orchestration_prompt.txt").trim(),
                include_str!("acp_mcp_fallback.txt").trim(),
            ]);
        }
        prompt[index]["text"]=json!(format!("<t3_code_instructions>\n{}\n</t3_code_instructions>\n\n<user_request>\n{text}\n</user_request>",sections.join("\n\n")));
        state = Some(normalized_mode.to_owned());
    }
    let harness = match driver {
        "grok" => "Grok",
        "kiro" => "Kiro",
        other => other,
    };
    let model_info = if model.is_empty() || model == "default" || model == "auto" {
        String::new()
    } else {
        format!(
            ", as {}",
            model.split_whitespace().collect::<Vec<_>>().join(" ")
        )
    };
    let runtime = include_str!("claude_system_prompt.txt").replacen(
        "Claude Code harness",
        &format!("{harness} harness{model_info}"),
        1,
    );
    let runtime = runtime.trim().to_owned();
    if previous_runtime != Some(runtime.as_str()) {
        prompt.push(json!({"type":"text","text":runtime}));
        (state, Some(runtime))
    } else {
        (state, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_mode_and_runtime_once_and_preserves_slash() {
        let mut prompt = vec![json!({"type":"text","text":"hello"})];
        let (mode, runtime) = apply(&mut prompt, "default", "fx", "default", false, None, None);
        assert!(prompt[0]["text"]
            .as_str()
            .unwrap()
            .contains("<user_request>\nhello\n</user_request>"));
        assert!(prompt[1]["text"]
            .as_str()
            .unwrap()
            .contains("through the fx harness"));
        let mut next = vec![json!({"type":"text","text":"next"})];
        apply(
            &mut next,
            "default",
            "fx",
            "default",
            false,
            mode.as_deref(),
            runtime.as_deref(),
        );
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["text"], "next");
        let mut slash = vec![json!({"type":"text","text":" /compact"})];
        assert_eq!(
            apply(&mut slash, "plan", "fx", "default", false, None, None),
            (None, None)
        );
        assert_eq!(slash.len(), 1);
    }
}
