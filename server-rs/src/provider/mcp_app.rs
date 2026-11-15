//! Capture untrusted MCP app documents as sandboxed attachment assets.
use base64::{
    alphabet,
    engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig},
    engine::DecodePaddingMode,
    Engine,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{io::Write, path::Path, sync::OnceLock};

const MAX: usize = 5 * 1024 * 1024;

// Node's Buffer.from(value, "base64") accepts URL-safe characters, ignores
// non-alphabet characters and treats malformed UTF-8 as replacement characters.
fn decode_blob(value: &str) -> String {
    let mut encoded: Vec<u8> = value
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    if encoded.len() % 4 == 1 {
        encoded.pop();
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    String::from_utf8_lossy(&decoder.decode(encoded).unwrap_or_default()).into_owned()
}

pub fn resource_uri(item: &Value) -> Option<&str> {
    item.pointer("/mcpAppUi/resourceUri")
        .or_else(|| item.get("mcpAppResourceUri"))
        .or_else(|| item.pointer("/appContext/resourceUri"))?
        .as_str()
        .filter(|s| s.starts_with("ui://"))
}

pub fn snapshot(
    dir: &Path,
    thread: &str,
    server: &str,
    tool: &str,
    uri: &str,
    contents: &Value,
) -> Option<Value> {
    if !uri.starts_with("ui://") {
        return None;
    }
    let mut document = None;
    for content in contents.as_array()? {
        if content.get("uri").is_some_and(|v| v.as_str() != Some(uri))
            || content
                .get("mimeType")
                .and_then(Value::as_str)
                .map(|s| {
                    s.chars()
                        .filter(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_ascii_lowercase()
                })
                .as_deref()
                != Some("text/html;profile=mcp-app")
        {
            continue;
        }
        let html = if let Some(s) = content.get("text").and_then(Value::as_str) {
            if s.len() > MAX {
                return None;
            }
            s.to_owned()
        } else if let Some(s) = content.get("blob").and_then(Value::as_str) {
            if s.len() > MAX.div_ceil(3) * 4 {
                return None;
            }
            decode_blob(s)
        } else {
            continue;
        };
        if html.len() > MAX {
            return None;
        }
        if html.trim().is_empty() {
            continue;
        }
        document = Some((html, content.pointer("/_meta/ui")));
        break;
    }
    let (html, ui) = document?;
    let mut csp = Map::new();
    static DOMAIN: OnceLock<Regex> = OnceLock::new();
    let re = DOMAIN.get_or_init(|| {
        Regex::new(r"(?i)^(?:https?|wss?)://(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$")
            .unwrap()
    });
    for key in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        let domains: Vec<Value> = ui
            .and_then(|u| u.pointer(&format!("/csp/{key}")))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|s| s.len() <= 256 && re.is_match(s))
            .take(32)
            .map(|s| json!(s))
            .collect();
        if !domains.is_empty() {
            csp.insert(key.into(), json!(domains));
        }
    }
    let list = |key: &str, fallback: &str| {
        csp.get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_else(|| fallback.into())
    };
    let res = list("resourceDomains", "");
    let policy = [
        "default-src 'none'".to_string(),
        format!("script-src 'unsafe-inline' {res}"),
        format!("style-src 'unsafe-inline' {res}"),
        format!("img-src data: blob: {res}"),
        format!("font-src data: {res}"),
        format!("media-src data: blob: {res}"),
        format!("connect-src {}", list("connectDomains", "'none'")),
        format!("frame-src {}", list("frameDomains", "'none'")),
        "object-src 'none'".into(),
        format!("base-uri {}", list("baseUriDomains", "'none'")),
        "form-action 'none'".into(),
    ]
    .iter()
    .map(|s| s.trim_end())
    .collect::<Vec<_>>()
    .join("; ");
    let meta = format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">",
        policy
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
    );
    static DOCTYPE: OnceLock<Regex> = OnceLock::new();
    let re = DOCTYPE.get_or_init(|| Regex::new(r"(?i)^\x{feff}?\s*<!doctype[^>]*>").unwrap());
    let rendered = if let Some(m) = re.find(&html) {
        format!("{}{}{}", &html[..m.end()], meta, &html[m.end()..])
    } else {
        format!("<!doctype html>{meta}{html}")
    };
    let id = crate::attachment_paths::attachment_id(thread, Some("html"))?;
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(format!("{id}.html"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    if file.write_all(rendered.as_bytes()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
        return None;
    }
    let mut result = json!({"attachmentId":id,"server":server,"tool":tool,"resourceUri":uri});
    if !csp.is_empty() {
        result["csp"] = Value::Object(csp);
    }
    let mut permissions = Map::new();
    for key in ["camera", "microphone", "geolocation", "clipboardWrite"] {
        if ui
            .and_then(|u| u.pointer(&format!("/permissions/{key}")))
            .is_some_and(Value::is_object)
        {
            permissions.insert(key.into(), json!({}));
        }
    }
    if !permissions.is_empty() {
        result["permissions"] = Value::Object(permissions);
    }
    if let Some(b) = ui
        .and_then(|u| u.get("prefersBorder"))
        .and_then(Value::as_bool)
    {
        result["prefersBorder"] = json!(b);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_document_with_filtered_csp_and_sandbox_id() {
        let dir = std::env::temp_dir().join(format!("mcp-app-{}", uuid::Uuid::new_v4()));
        let result = snapshot(&dir, "thread", "weather", "get", "ui://weather/view", &json!([
            {"mimeType":"text/plain","text":"ignored"},
            {"uri":"ui://weather/view","mimeType":"TEXT/HTML; profile=mcp-app","text":"<!doctype html><p>Hello</p>","_meta":{"ui":{"csp":{"connectDomains":["https://api.weather.test","https://evil.test/path"]},"permissions":{"camera":{}},"prefersBorder":true}}}
        ])).unwrap();
        assert_eq!(
            result["csp"]["connectDomains"],
            json!(["https://api.weather.test"])
        );
        assert_eq!(result["permissions"], json!({"camera":{}}));
        let id = result["attachmentId"].as_str().unwrap();
        assert!(id.ends_with("-html"));
        let html = std::fs::read_to_string(dir.join(format!("{id}.html"))).unwrap();
        assert!(html.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
        assert!(html.contains("connect-src https://api.weather.test"));
        assert!(!html.contains("evil.test"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_bad_and_oversized_documents() {
        let dir = std::env::temp_dir();
        assert!(snapshot(&dir, "thread", "s", "t", "https://bad", &json!([])).is_none());
        assert!(snapshot(
            &dir,
            "thread",
            "s",
            "t",
            "ui://x",
            &json!([{"mimeType":"text/html;profile=mcp-app","text":"x".repeat(MAX+1)}])
        )
        .is_none());
        assert_eq!(
            resource_uri(&json!({"mcpAppUi":{"resourceUri":"ui://x"}})),
            Some("ui://x")
        );
    }

    #[test]
    fn blob_decoding_matches_node_for_permissive_base64_and_utf8() {
        assert_eq!(decode_blob("SGV sbG8"), "Hello");
        assert_eq!(decode_blob("_w==ignored"), "\u{fffd}");
        assert_eq!(decode_blob("YQ=ignored"), "a");
        assert_eq!(decode_blob("a"), "");
        let dir = std::env::temp_dir().join(format!("mcp-blob-{}", uuid::Uuid::new_v4()));
        let result = snapshot(
            &dir,
            "thread",
            "s",
            "t",
            "ui://x",
            &json!([
                {"mimeType":"text/html;profile=mcp-app", "blob":"PHA-_w=="}
            ]),
        )
        .unwrap();
        let id = result["attachmentId"].as_str().unwrap();
        let html = std::fs::read_to_string(dir.join(format!("{id}.html"))).unwrap();
        assert!(html.ends_with("<p>\u{fffd}"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
