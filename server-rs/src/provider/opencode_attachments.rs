//! OpenCode attachment-path prompt and native file selection.
use super::opencode_http::OpenCodeVersion;
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn build(
    message: &Value,
    directory: &Path,
    version: OpenCodeVersion,
    external: bool,
) -> Result<(String, Vec<Value>), String> {
    let mut text = super::executor::with_message_sender_note(
        message,
        &crate::composer_context::project(
            message["text"].as_str().unwrap_or(""),
            message.get("context"),
        ),
    );
    let mut files = Vec::new();
    let entries = message["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for raw in entries {
        let attachment: crate::attachment_store::Attachment =
            serde_json::from_value(raw.clone()).map_err(|_| "Invalid OpenCode attachment")?;
        crate::attachment_paths::parse_id(&attachment.id)
            .ok_or("Invalid OpenCode attachment id")?;
        let ext = match attachment.kind.as_str() {
            "image" => crate::attachment_paths::image_extension(
                &attachment.mime_type,
                Some(&attachment.name),
            ),
            "file" => crate::attachment_paths::file_extension(&attachment.name),
            _ => return Err("Invalid OpenCode attachment type".into()),
        };
        let path = directory.join(format!("{}{ext}", attachment.id));
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|_| "OpenCode attachment path unavailable")?
                .join(path)
        };
        let extracted = crate::document_text::ensure(&path)
            .map(|sidecar| format!(" (text extracted to: {})", sidecar.display()))
            .unwrap_or_default();
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&format!(
            "[Attached {} \"{}\" is saved at: {}{}]",
            attachment.kind,
            attachment.name,
            path.display(),
            extracted
        ));
        let mime = attachment.mime_type.trim().to_ascii_lowercase();
        let image = attachment.kind == "image"
            && matches!(
                mime.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            );
        let native = match version {
            OpenCodeVersion::V1 => {
                attachment.size_bytes <= 20 * 1024 * 1024
                    && (image || matches!(mime.as_str(), "text/plain" | "application/pdf"))
                    && raw["source"]["_tag"] != "pasted-text"
            }
            OpenCodeVersion::V2 => !external && image && path.is_file(),
        };
        if native {
            let uri = url::Url::from_file_path(&path)
                .map_err(|_| "Invalid OpenCode attachment path")?
                .to_string();
            files.push(match version {OpenCodeVersion::V1=>json!({"type":"file","mime":attachment.mime_type,"filename":attachment.name,"url":uri}),OpenCodeVersion::V2=>json!({"uri":uri,"name":attachment.name})});
        }
    }
    Ok((text.trim().to_owned(), files))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composer_context_is_included_in_provider_text() {
        let message = json!({"text":"See [file](t3-context://v1/mention/a).","attachments":[],"context":{"version":1,"records":[{"version":1,"kind":"mention","contextId":"a","label":"file","path":"src/app.rs"}]}});
        let (text, files) = build(&message, Path::new("/tmp"), OpenCodeVersion::V1, false).unwrap();
        assert!(text.contains("[Mention: file; ref=a]"));
        assert!(text.contains("<context kind=\"mention\" id=\"a\">\npath: src/app.rs\n</context>"));
        assert!(files.is_empty());
    }
    #[test]
    fn native_files_follow_version_and_external_server_rules() {
        let root = std::env::temp_dir().join(format!("t3-open-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = crate::attachment_paths::attachment_id("thread", None).unwrap();
        std::fs::write(root.join(format!("{id}.png")), b"image").unwrap();
        let message = json!({"text":"hello","attachments":[{"type":"image","id":id,"name":"image.png","mimeType":"image/png","sizeBytes":5}]});
        let (text, files) = build(&message, &root, OpenCodeVersion::V2, false).unwrap();
        assert!(text.contains("[Attached image"));
        assert_eq!(files.len(), 1);
        assert!(files[0]["uri"].as_str().unwrap().starts_with("file:///"));
        assert!(build(&message, &root, OpenCodeVersion::V2, true)
            .unwrap()
            .1
            .is_empty());
        let (_, legacy) = build(&message, &root, OpenCodeVersion::V1, true).unwrap();
        assert_eq!(legacy[0]["type"], "file");
        assert_eq!(legacy[0]["mime"], "image/png");
        let invalid = json!({"attachments":[{"type":"image","id":"../bad","name":"bad.png","mimeType":"image/png","sizeBytes":1}]});
        assert!(build(&invalid, &root, OpenCodeVersion::V1, false).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
