//! Cloud speech request decoding and provider transport.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use unicode_normalization::UnicodeNormalization;

const MAX_PCM: usize = 16_000 * 4 * 300;
pub const MAX_BODY: usize = MAX_PCM + 128_000 + 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Options {
    speech_language: String,
    speech_translate_to_english: bool,
    speech_custom_words: Vec<Word>,
    speech_remove_filler_words: bool,
    #[serde(default)]
    speech_correction_word: Option<String>,
    #[serde(default = "yes")]
    speech_silence_filtering: bool,
}
#[derive(Deserialize)]
struct Word {
    term: String,
    aliases: Vec<String>,
}
fn yes() -> bool {
    true
}

pub(super) fn decode(body: &[u8]) -> Result<(Options, Vec<u8>), ()> {
    if body.len() < 5 || body.len() > MAX_BODY {
        return Err(());
    }
    let n = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    if n > 128_000 || 4 + n >= body.len() {
        return Err(());
    }
    let options: Options = serde_json::from_slice(&body[4..4 + n]).map_err(|_| ())?;
    let _ = options.speech_translate_to_english;
    if !(2..=16).contains(&options.speech_language.chars().count())
        || options.speech_custom_words.len() > 100
        || options
            .speech_correction_word
            .as_ref()
            .is_some_and(|s| s.chars().count() > 50)
    {
        return Err(());
    }
    let mut seen = HashSet::new();
    for word in &options.speech_custom_words {
        if word.aliases.len() > 8 {
            return Err(());
        }
        for s in std::iter::once(&word.term).chain(&word.aliases) {
            let key: String = s.trim().nfc().collect::<String>().to_lowercase();
            if s.chars().count() > 50 || key.is_empty() || !seen.insert(key) {
                return Err(());
            }
        }
    }
    let pcm = &body[4 + n..];
    if pcm.is_empty() || pcm.len() > MAX_PCM || !pcm.len().is_multiple_of(4) {
        return Err(());
    }
    let mut wav = Vec::with_capacity(44 + pcm.len() / 2);
    let data_len = (pcm.len() / 2) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for chunk in pcm.chunks_exact(4) {
        let sample = f32::from_le_bytes(chunk.try_into().unwrap());
        if !sample.is_finite() || !(-1.0..=1.0).contains(&sample) {
            return Err(());
        }
        // JavaScript Math.round rounds ties toward positive infinity.
        let scaled = sample as f64 * if sample < 0.0 { 32768.0 } else { 32767.0 };
        wav.extend_from_slice(&((scaled + 0.5).floor() as i16).to_le_bytes());
    }
    Ok((options, wav))
}

pub(super) fn native_options(options: &Options) -> Value {
    let mut result = json!({"timestamps":"none"});
    if options.speech_language != "auto" {
        result["language"] = json!(options.speech_language);
    }
    if options.speech_translate_to_english && options.speech_language != "en" {
        result["task"] = json!("translate");
        result["targetLanguage"] = json!("en");
    } else if !options.speech_custom_words.is_empty() {
        result["vocabulary"] = json!(options
            .speech_custom_words
            .iter()
            .map(|w| &w.term)
            .collect::<Vec<_>>());
    }
    result
}
fn language(options: &Options) -> &str {
    let supported = " ar bg ca cs da de el en es fa fi fr hi hr hu id it ja ko mk ms nl pl pt ro ru sk sv th tr uk ur vi zh ";
    if supported.contains(&format!(" {} ", options.speech_language)) {
        &options.speech_language
    } else {
        "auto"
    }
}
fn field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}
fn multipart(provider: &str, options: &Options, wav: &[u8], boundary: &str) -> Vec<u8> {
    let mut body = Vec::new();
    field(
        &mut body,
        boundary,
        "model",
        if provider == "openai" {
            "gpt-transcribe"
        } else {
            "grok-voice-transcribe-2.0"
        },
    );
    let lang = language(options);
    if lang != "auto" {
        field(
            &mut body,
            boundary,
            if provider == "openai" {
                "languages[]"
            } else {
                "language"
            },
            lang,
        );
    }
    for word in &options.speech_custom_words {
        if provider == "openai" && word.term.contains(['<', '>', '\r', '\n']) {
            continue;
        }
        field(
            &mut body,
            boundary,
            if provider == "openai" {
                "keywords[]"
            } else {
                "keyterm"
            },
            &word.term,
        );
    }
    if provider == "xai" {
        if lang != "auto" {
            field(&mut body, boundary, "format", "true");
        }
        field(
            &mut body,
            boundary,
            "filler_words",
            if !options.speech_remove_filler_words
                || options
                    .speech_correction_word
                    .as_ref()
                    .is_some_and(|s| !s.is_empty())
            {
                "true"
            } else {
                "false"
            },
        );
        if !options.speech_silence_filtering {
            field(&mut body, boundary, "vad_threshold", "0");
        }
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

pub async fn transcribe(
    settings: &crate::settings::Settings,
    provider: &str,
    body: &[u8],
    url: &str,
    model: Option<&str>,
    catalog: &super::Catalog,
) -> Result<String, &'static str> {
    if !matches!(provider, "openai" | "xai" | "openrouter") {
        return Err("model-unavailable");
    }
    let mut snapshot = settings.private_snapshot();
    crate::settings::materialize_secrets(settings.path(), &mut snapshot)
        .map_err(|_| "unreadable-key")?;
    let source = snapshot["cloudSpeechCredentials"][provider].clone();
    if source.is_null() || source.as_str() == Some("") {
        return Err("missing-key");
    }
    if provider == "openrouter" && !model.is_some_and(super::valid_model_id) {
        return Err("model-unavailable");
    }
    let (options, wav) = decode(body).map_err(|_| "invalid_audio")?;
    if provider == "openrouter" {
        let models = catalog.models().await.map_err(|_| "unavailable")?;
        if !models["models"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["id"].as_str() == model))
        {
            return Err("model-unavailable");
        }
    }
    let key = if let Some(key) = source.as_str() {
        Some(key.to_owned())
    } else {
        crate::mcp_secret::resolve_reference(&snapshot, &source).await
    };
    let key = key
        .filter(|key| super::valid_key(&json!(key)))
        .ok_or("unreadable-key")?;
    let mut current = settings.private_snapshot();
    crate::settings::materialize_secrets(settings.path(), &mut current)
        .map_err(|_| "unreadable-key")?;
    let current_source = &current["cloudSpeechCredentials"][provider];
    if *current_source != source {
        return Err(
            if current_source.is_null() || current_source.as_str() == Some("") {
                "missing-key"
            } else {
                "key-changed"
            },
        );
    }
    if source.is_object()
        && current["secretProviders"][source["provider"].as_str().unwrap_or("")]
            != snapshot["secretProviders"][source["provider"].as_str().unwrap_or("")]
    {
        return Err("key-changed");
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "unavailable")?;
    let request = client.post(url).bearer_auth(key);
    let request = if provider == "openrouter" {
        let mut body = json!({"model": model.unwrap(), "input_audio": {"data": STANDARD.encode(&wav), "format": "wav"}, "provider": {"zdr": true}});
        if language(&options) != "auto" {
            body["language"] = json!(language(&options));
        }
        request
            .header("content-type", "application/json")
            .body(body.to_string())
    } else {
        let boundary = format!("t3-{}", uuid::Uuid::new_v4());
        request
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart(provider, &options, &wav, &boundary))
    };
    let mut response = request.send().await.map_err(|_| "unavailable")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            429 => "rate-limit",
            401..=403 => "rejected-key",
            404 if provider == "openrouter" => "model-unavailable",
            _ => "unavailable",
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "unavailable")? {
        if bytes.len() + chunk.len() > 1_000_000 {
            return Err("unavailable");
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| "unavailable")?;
    let text = result["text"].as_str().ok_or("unavailable")?;
    Ok(postprocess(text, &options))
}
pub(super) fn postprocess(text: &str, options: &Options) -> String {
    let mut text = text.to_owned();
    // Dictionary boundaries include Unicode marks and connector punctuation, as in
    // the upstream JavaScript Unicode property expression.
    let dictionary_word = regex::Regex::new(r"^[\p{L}\p{M}\p{N}\p{Pc}]$").unwrap();
    let filler_word = regex::Regex::new(r"^[\p{L}\p{N}_]$").unwrap();
    let mut spellings: Vec<_> = options
        .speech_custom_words
        .iter()
        .flat_map(|w| {
            std::iter::once(&w.term)
                .chain(&w.aliases)
                .map(move |s| (s, &w.term))
        })
        .collect();
    spellings.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
    if !spellings.is_empty() {
        let pattern = spellings
            .iter()
            .map(|(s, _)| regex::escape(s))
            .collect::<Vec<_>>()
            .join("|");
        let re = regex::Regex::new(&format!(r"(?i)({pattern})")).unwrap();
        let original = text.clone();
        let mut out = String::new();
        let mut pos = 0;
        for m in re.find_iter(&original) {
            let left = original[..m.start()].chars().next_back();
            let right = original[m.end()..].chars().next();
            if left.is_some_and(|c| dictionary_word.is_match(&c.to_string()))
                || right.is_some_and(|c| dictionary_word.is_match(&c.to_string()))
            {
                continue;
            }
            out.push_str(&original[pos..m.start()]);
            out.push_str(
                spellings
                    .iter()
                    .find(|(s, _)| s.to_lowercase() == m.as_str().to_lowercase())
                    .map(|(_, term)| term.as_str())
                    .unwrap_or(m.as_str()),
            );
            pos = m.end();
        }
        out.push_str(&original[pos..]);
        text = out;
    }
    if options.speech_remove_filler_words {
        let mut words = vec![
            "uh", "uhm", "umm", "uhh", "uhhh", "ehh", "ehm", "ahm", "hmm", "hm", "mmm", "хм", "ммм",
        ];
        match language(options) {
            "en" => words.extend(["um", "ah", "eh"]),
            "de" => words.extend(["äh", "ähm"]),
            "fr" => words.push("euh"),
            _ => {}
        }
        words.sort_by_key(|word| std::cmp::Reverse(word.len()));
        let cue = options
            .speech_correction_word
            .as_deref()
            .unwrap_or("")
            .trim();
        let cue_pattern = cue
            .split_whitespace()
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(r"\s+");
        let pattern = if cue_pattern.is_empty() {
            format!(r"(?i)({})[,.]?", words.join("|"))
        } else {
            format!(r"(?i)(?:({cue_pattern})|({})[,.]?)", words.join("|"))
        };
        let re = regex::Regex::new(&pattern).unwrap();
        let filler_re = regex::Regex::new(&format!(r"(?i)^(?:{})[,.]?", words.join("|"))).unwrap();
        let original = text.clone();
        let mut out = String::new();
        let mut pos = 0;
        for captures in re.captures_iter(&original) {
            let m = captures.get(0).unwrap();
            let start = m.start();
            let mut end = m.end();
            let left = original[..start].chars().next_back();
            // Filler punctuation is consumed only after checking the word boundary.
            let boundary_end = if (cue_pattern.is_empty() || captures.get(1).is_none())
                && m.as_str().ends_with([',', '.'])
            {
                end - 1
            } else {
                end
            };
            let mut right = original[boundary_end..].chars().next();
            let mut is_cue = !cue_pattern.is_empty() && captures.get(1).is_some();
            if is_cue && right.is_some_and(|c| filler_word.is_match(&c.to_string())) {
                if let Some(filler) = filler_re.find(&original[start..]) {
                    end = start + filler.end();
                    let boundary_end = if filler.as_str().ends_with([',', '.']) {
                        end - 1
                    } else {
                        end
                    };
                    right = original[boundary_end..].chars().next();
                    is_cue = false;
                }
            }
            if left.is_some_and(|c| filler_word.is_match(&c.to_string()))
                || right.is_some_and(|c| filler_word.is_match(&c.to_string()))
                || is_cue
            {
                continue;
            }
            out.push_str(&original[pos..start]);
            pos = end;
        }
        out.push_str(&original[pos..]);
        text = regex::Regex::new(r"[^\S\r\n]{2,}")
            .unwrap()
            .replace_all(&out, " ")
            .into_owned();
        text = regex::Regex::new(r"[^\S\r\n]*([\r\n])[^\S\r\n]*")
            .unwrap()
            .replace_all(&text, "$1")
            .into_owned();
    }
    text.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        response::IntoResponse,
        routing::post,
        Router,
    };
    use std::sync::{Arc, Mutex};
    fn payload(sample: f32) -> Vec<u8> {
        let options = json!({"speechLanguage":"en","speechTranslateToEnglish":false,"speechCustomWords":[{"term":"Codex","aliases":["code x"]}],"speechRemoveFillerWords":true,"speechCorrectionWord":"sorry","speechSilenceFiltering":false}).to_string();
        let mut body = (options.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(options.as_bytes());
        body.extend_from_slice(&sample.to_le_bytes());
        body
    }
    #[tokio::test]
    async fn mock_provider_upload_and_errors() {
        let captured = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let capture = captured.clone();
        let app = Router::new()
            .route("/rate", post(|| async { StatusCode::TOO_MANY_REQUESTS }))
            .route("/reject", post(|| async { StatusCode::UNAUTHORIZED }))
            .route(
                "/",
                post(move |req: Request<Body>| {
                    let capture = capture.clone();
                    async move {
                        let auth = req.headers()["authorization"].to_str().unwrap().to_owned();
                        let data = to_bytes(req.into_body(), MAX_BODY).await.unwrap().to_vec();
                        capture.lock().unwrap().push((auth, data));
                        (
                            StatusCode::OK,
                            axum::Json(json!({"text":" uh, hello code x "})),
                        )
                            .into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = std::env::temp_dir().join(format!("voice-transcribe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = crate::settings::Settings::new(root.join("settings.json"));
        let url = format!("http://{addr}/");
        let catalog = super::super::Catalog::new(url.clone());
        assert_eq!(
            transcribe(&settings, "unknown", &payload(0.5), &url, None, &catalog).await,
            Err("model-unavailable")
        );
        assert_eq!(
            transcribe(&settings, "openai", &payload(0.5), &url, None, &catalog).await,
            Err("missing-key")
        );
        settings
            .update(&json!({"cloudSpeechCredentials":{"openai":"mock-openai","xai":"mock-xai"}}))
            .unwrap();
        assert_eq!(
            transcribe(
                &settings,
                "openai",
                &payload(f32::NAN),
                &url,
                None,
                &catalog
            )
            .await,
            Err("invalid_audio")
        );
        for provider in ["openai", "xai"] {
            assert_eq!(
                transcribe(&settings, provider, &payload(0.5), &url, None, &catalog)
                    .await
                    .unwrap(),
                "hello Codex"
            );
        }
        assert_eq!(
            transcribe(
                &settings,
                "openai",
                &payload(0.5),
                &format!("{url}rate"),
                None,
                &catalog
            )
            .await,
            Err("rate-limit")
        );
        assert_eq!(
            transcribe(
                &settings,
                "xai",
                &payload(0.5),
                &format!("{url}reject"),
                None,
                &catalog
            )
            .await,
            Err("rejected-key")
        );
        let entries = captured.lock().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "Bearer mock-openai");
        assert_eq!(entries[1].0, "Bearer mock-xai");
        for (idx, (_, body)) in entries.iter().enumerate() {
            let text = String::from_utf8_lossy(body);
            assert!(text.contains("RIFF"));
            assert!(text.contains("WAVEfmt "));
            assert!(text.contains(if idx == 0 {
                "gpt-transcribe"
            } else {
                "grok-voice-transcribe-2.0"
            }));
            assert!(text.contains(if idx == 0 { "keywords[]" } else { "keyterm" }));
            if idx == 1 {
                assert!(text.contains("vad_threshold"));
                assert!(text.find("vad_threshold") < text.find("filename="));
            }
        }
        drop(entries);
        task.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn openrouter_requires_catalog_model_and_uploads_zdr_wav() {
        let uploads = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = uploads.clone();
        let app = Router::new()
            .route(
                "/catalog",
                axum::routing::get(|| async {
                    axum::Json(json!({"data": [{"id":"acme/transcribe-1", "name":"Acme"}]}))
                }),
            )
            .route(
                "/upload",
                post(move |req: Request<Body>| {
                    let captured = captured.clone();
                    async move {
                        assert_eq!(req.headers()["authorization"], "Bearer mock-router");
                        let bytes = to_bytes(req.into_body(), MAX_BODY).await.unwrap();
                        captured
                            .lock()
                            .unwrap()
                            .push(serde_json::from_slice(&bytes).unwrap());
                        axum::Json(json!({"text":"uh, hello code x"}))
                    }
                }),
            )
            .route("/missing", post(|| async { StatusCode::NOT_FOUND }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = std::env::temp_dir().join(format!("voice-router-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = crate::settings::Settings::new(root.join("settings.json"));
        settings
            .update(&json!({"cloudSpeechCredentials":{"openrouter":"mock-router"}}))
            .unwrap();
        let catalog = super::super::Catalog::new(format!("http://{addr}/catalog"));
        let url = format!("http://{addr}/upload");
        for model in [None, Some("openrouter/auto"), Some("acme/other")] {
            assert_eq!(
                transcribe(
                    &settings,
                    "openrouter",
                    &payload(0.5),
                    &url,
                    model,
                    &catalog
                )
                .await,
                Err("model-unavailable")
            );
        }
        assert_eq!(
            transcribe(
                &settings,
                "openrouter",
                &payload(0.5),
                &url,
                Some("acme/transcribe-1"),
                &catalog
            )
            .await
            .unwrap(),
            "hello Codex"
        );
        assert_eq!(
            transcribe(
                &settings,
                "openrouter",
                &payload(0.5),
                &format!("http://{addr}/missing"),
                Some("acme/transcribe-1"),
                &catalog
            )
            .await,
            Err("model-unavailable")
        );
        let entries = uploads.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let request = &entries[0];
        assert_eq!(request["model"], "acme/transcribe-1");
        assert_eq!(request["provider"]["zdr"], true);
        assert_eq!(request["language"], "en");
        assert_eq!(request["input_audio"]["format"], "wav");
        let wav = STANDARD
            .decode(request["input_audio"]["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        drop(entries);
        task.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn validates_envelope_and_pcm() {
        assert!(decode(&payload(1.0)).is_ok());
        assert!(decode(&payload(-1.1)).is_err());
        assert!(decode(&payload(f32::INFINITY)).is_err());
        assert!(decode(&[0, 0, 0]).is_err());
    }
    #[test]
    fn unicode_dictionary_boundaries_and_punctuated_fillers() {
        let (mut options, _) = decode(&payload(0.0)).unwrap();
        options.speech_custom_words = vec![Word {
            term: "Codex".into(),
            aliases: vec!["code".into()],
        }];
        options.speech_remove_filler_words = false;
        assert_eq!(
            postprocess("code code\u{0301} code\u{203f} code!", &options),
            "Codex code\u{0301} code\u{203f} Codex!"
        );
        options.speech_custom_words.clear();
        options.speech_remove_filler_words = true;
        options.speech_correction_word = None;
        assert_eq!(
            postprocess("uh,hello um.world uhx", &options),
            "hello world uhx"
        );
    }
    #[test]
    fn upstream_cleanup_cases_and_provider_guard() {
        let (mut options, _) = decode(&payload(0.0)).unwrap();
        options.speech_custom_words = vec![
            Word {
                term: "Bob".into(),
                aliases: vec!["Robert".into()],
            },
            Word {
                term: "Roberts".into(),
                aliases: vec![],
            },
            Word {
                term: "O'Reilly".into(),
                aliases: vec!["\"the publisher\"".into()],
            },
        ];
        options.speech_remove_filler_words = false;
        assert_eq!(
            postprocess(
                "Robert, Roberts. \"the publisher\" and the publisher.",
                &options
            ),
            "Bob, Roberts. O'Reilly and the publisher."
        );
        options.speech_custom_words.clear();
        options.speech_remove_filler_words = true;
        for (cue, input, expected) in [
            (None, "First um\n\nuh Second.", "First\n\nSecond."),
            (
                Some("um"),
                "Uh, Make it red, um, blue.",
                "Make it red, um, blue.",
            ),
            (
                Some("uh no"),
                "Uh, Make it red, UH  NO, blue. Uh nope.",
                "Make it red, UH NO, blue. nope.",
            ),
        ] {
            options.speech_correction_word = cue.map(str::to_owned);
            assert_eq!(postprocess(input, &options), expected);
        }
    }
}
