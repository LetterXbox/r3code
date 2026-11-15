//! Codex error evidence and bounded, redacted provider failures.
use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    ProviderError,
    UsageLimit,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub class: FailureClass,
    pub message: String,
    pub code: Option<String>,
    pub retryable: Option<bool>,
    /// Sharing caps cannot use the ordinary Codex allowance reset time.
    pub managed_usage_limit: bool,
}
#[derive(Debug, Clone)]
pub(super) struct PreviousFailure {
    pub native_message: String,
    pub native_code: Option<String>,
    pub failure: ProviderFailure,
}
fn regex(slot: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("static redaction regex"))
}
fn redact_url(text: &str) -> String {
    let trimmed = text.trim_end_matches([')', ',', '.', ';', '!', '?']);
    let trailing = &text[trimmed.len()..];
    match url::Url::parse(trimmed) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            format!("{url}{trailing}")
        }
        Err(_) => "[REDACTED_URL]".into(),
    }
}
fn bounded_text(value: &str, max: usize) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    static FIELD: OnceLock<Regex> = OnceLock::new();
    static API_KEY: OnceLock<Regex> = OnceLock::new();
    let clean: String = value
        .chars()
        .map(|c| {
            if matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 127) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = regex(&URL, r#"(?i)\bhttps?://[^\s<>"']+"#)
        .replace_all(&clean, |caps: &Captures<'_>| redact_url(&caps[0]));
    let clean =
        regex(&AUTH, r"(?i)\b(Bearer|Basic)\s+[^\s,;]+").replace_all(&clean, "$1 [REDACTED]");
    let clean = regex(&QUOTED, r#"(?i)(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])"#).replace_all(&clean, "${1}[REDACTED]${2}");
    // Preserve the preceding delimiter: Rust regex has no look-behind.
    let clean = regex(&FIELD, r#"(?i)(^|[^\w-])([\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)"#).replace_all(&clean, "${1}${2}[REDACTED]");
    let clean = regex(&API_KEY, r"\bsk-[A-Za-z0-9_-]{16,}\b").replace_all(&clean, "[REDACTED]");
    let clean = clean.trim();
    if clean.encode_utf16().count() <= max {
        return clean.to_owned();
    }
    let mut result = String::new();
    let mut units = 0;
    for c in clean.chars() {
        if units + c.len_utf16() > max - 1 {
            break;
        }
        units += c.len_utf16();
        result.push(c);
    }
    result.push('…');
    result
}
fn code(info: Option<&Value>) -> Option<String> {
    match info? {
        Value::String(s) => Some(s.clone()),
        Value::Object(o) => o.keys().next().cloned(),
        _ => None,
    }
}
fn exhaustion(info: Option<&Value>) -> Option<f64> {
    info?
        .get("responseTooManyFailedAttempts")?
        .get("httpStatusCode")?
        .as_f64()
}
fn usage_limit(code: Option<&str>, info: Option<&Value>) -> bool {
    matches!(code, Some("usageLimitExceeded" | "rateLimitExceeded"))
        || exhaustion(info) == Some(429.0)
}
fn unwrap(value: &Value) -> Value {
    let value = value
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| value.clone());
    value.get("error").cloned().unwrap_or(value)
}
fn known_code(code: &str) -> Option<&'static str> {
    Some(match code {
        "subscription_sharing_v2_user_not_eligible" | "subscription_sharing_user_not_eligible" => "ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.",
        "subscription_sharing_usage_limit_exceeded" => "Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.",
        "subscription_sharing_workplace_individual_usage_limit_exceeded" => "You reached your workspace's limit for using ChatGPT in other apps. Ask your workspace admin to increase it.",
        "subscription_sharing_usage_unavailable" => "ChatGPT usage is temporarily unavailable. Try again shortly.",
        "subscription_sharing_unsupported_capability" => "Codex used a feature that ChatGPT sharing does not support. Use another provider for this request.",
        "subscription_sharing_v2_client_not_enabled" => "This app is not enabled for this ChatGPT connection. Use your existing CLI or another provider.",
        "subscription_sharing_v2_route_not_supported" | "subscription_sharing_route_not_supported" => "ChatGPT does not support this request route.",
        "subscription_sharing_v2_invalid_user" | "subscription_sharing_invalid_user" => "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
        "subscription_sharing_v2_user_unavailable" | "subscription_sharing_user_unavailable" => "ChatGPT is temporarily unavailable. Try again shortly.",
        "chatpass_v2_scope_not_authorized" => "This ChatGPT grant does not authorize the request. Check the connection's sharing permissions.",
        "chatpass_v2_invalid_authorization_context" => "ChatGPT could not authorize this connection. Check the client and sharing permissions.",
        _ => return None,
    })
}
fn sharing_code(value: &Value) -> Option<String> {
    let v = unwrap(value);
    let s = v
        .as_str()
        .or_else(|| v.get("code").and_then(Value::as_str))?;
    known_code(s).map(|_| s.to_owned())
}
fn managed(value: &Value) -> Option<(String, String, bool)> {
    let v = unwrap(value);
    let messages: Vec<&str> = if let Some(s) = v.as_str() {
        vec![s]
    } else {
        [v.get("message"), v.get("additionalDetails")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    };
    let code = sharing_code(&v)
        .or_else(|| {
            messages
                .iter()
                .find_map(|m| sharing_code(&Value::String((*m).to_owned())))
        })
        .or_else(|| {
            messages
                .iter()
                .any(|m| m.contains("has reached their Subscription Sharing usage limit"))
                .then(|| "subscription_sharing_usage_limit_exceeded".to_owned())
        })?;
    let text = messages.join(" ");
    let mut message = known_code(&code)?;
    if code == "subscription_sharing_unsupported_capability" {
        if text.contains("tool 'namespace'") {
            message = "Codex sent a tool namespace that ChatGPT sharing does not support. Use another provider for this request.";
        } else if text.contains("additional_tools") {
            message = "Codex sent an input item that ChatGPT sharing does not support. Use another provider for this request.";
        }
    }
    let limit = matches!(
        code.as_str(),
        "subscription_sharing_usage_limit_exceeded"
            | "subscription_sharing_workplace_individual_usage_limit_exceeded"
    );
    Some((code, message.to_owned(), limit))
}
fn make(
    message: Option<&str>,
    native_code: Option<String>,
    info: Option<&Value>,
    native_error: &Value,
) -> ProviderFailure {
    let raw_message = bounded_text(message.unwrap_or("Provider turn failed."), 4096);
    let class = if usage_limit(native_code.as_deref(), info) {
        FailureClass::UsageLimit
    } else {
        FailureClass::ProviderError
    };
    let mut result = ProviderFailure {
        class,
        message: if raw_message.is_empty() {
            "Provider turn failed.".into()
        } else {
            raw_message
        },
        code: native_code
            .map(|s| bounded_text(&s, 128))
            .filter(|s| !s.is_empty()),
        retryable: None,
        managed_usage_limit: false,
    };
    if let Some((code, message, limit)) = managed(native_error) {
        result.code = Some(code);
        result.message = message;
        result.managed_usage_limit = limit;
        if limit {
            result.class = FailureClass::UsageLimit;
        }
    }
    result
}
pub(super) fn from_notification(error: &Value) -> Option<PreviousFailure> {
    let native_message = error.get("message")?.as_str()?.to_owned();
    let info = error.get("codexErrorInfo").filter(|v| !v.is_null());
    let native_code = code(info);
    let details = error
        .get("additionalDetails")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Some(PreviousFailure {
        failure: make(
            details.or(Some(&native_message)),
            native_code.clone(),
            info,
            error,
        ),
        native_code,
        native_message,
    })
}
pub(super) fn from_completion(
    error: Option<&Value>,
    previous: Option<&PreviousFailure>,
) -> ProviderFailure {
    let message = error.and_then(|e| e.get("message")).and_then(Value::as_str);
    let info = error
        .and_then(|e| e.get("codexErrorInfo"))
        .filter(|v| !v.is_null());
    let native_code = code(info);
    let class = if usage_limit(native_code.as_deref(), info) {
        FailureClass::UsageLimit
    } else {
        FailureClass::ProviderError
    };
    if let Some(prev) = previous {
        if message.is_none_or(|m| m == prev.native_message)
            && native_code
                .as_ref()
                .is_none_or(|c| Some(c) == prev.native_code.as_ref())
            && exhaustion(info).is_none_or(|_| prev.failure.class == class)
        {
            return prev.failure.clone();
        }
    }
    let value = message
        .map(|s| Value::String(s.to_owned()))
        .unwrap_or(Value::Null);
    make(message, native_code, info, &value)
}
pub(super) fn failure_code(info: Option<&Value>) -> Option<String> {
    code(info)
}
