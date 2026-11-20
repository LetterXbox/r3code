//! Usage service: transcript scanning, LiteLLM rate caching/refresh, and summary aggregation.

use crate::usage_aggregation::{
    canonical_model_filter, resolve_model_aliases, AggregateOptions, UsageAggregator,
    UsageModelFilter, UsageRecord, UsageResolution,
};
use crate::usage_pricing::{
    create_override_rate_table, parse_rate_table, RateTable, UsageSpeed, UsageTokenTotals,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tokio::sync::Mutex;

pub const USAGE_CONTRACT_VERSION: u64 = 6;
const LITELLM_RATES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL: &str =
    "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";
const RATES_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MTIME_SLACK_MS: i64 = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
struct RatesState {
    table: RateTable,
    status: String,
    source: String,
    fetched_at_ms: Option<i64>,
}

impl Default for RatesState {
    fn default() -> Self {
        Self {
            table: RateTable::new(),
            status: "unavailable".to_owned(),
            source: "litellm".to_owned(),
            fetched_at_ms: None,
        }
    }
}

#[derive(Clone)]
pub struct UsageService {
    rates_cache_path: PathBuf,
    rates: Arc<Mutex<RatesState>>,
    http: reqwest::Client,
    host_id: String,
}

impl UsageService {
    pub fn new(cache_dir: PathBuf) -> Self {
        let host_id = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_else(|_| "localhost".to_owned());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("t3code-server")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            rates_cache_path: cache_dir.join("usage-rates.json"),
            rates: Arc::new(Mutex::new(RatesState::default())),
            http,
            host_id,
        }
    }

    async fn load_cached_rates(&self) {
        let mut guard = self.rates.lock().await;
        if guard.fetched_at_ms.is_some() {
            return;
        }
        if let Ok(raw) = tokio::fs::read_to_string(&self.rates_cache_path).await {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let (Some(fetched_at_ms), Some(document)) = (
                    parsed.get("fetchedAtMs").and_then(Value::as_i64),
                    parsed.get("document"),
                ) {
                    let table = parse_rate_table(document);
                    let now_ms = Utc::now().timestamp_millis();
                    let fresh = now_ms - fetched_at_ms < RATES_TTL_MS;
                    *guard = RatesState {
                        table,
                        status: if fresh { "fresh" } else { "cached" }.to_owned(),
                        source: "litellm".to_owned(),
                        fetched_at_ms: Some(fetched_at_ms),
                    };
                }
            }
        }
    }

    fn pricing_json(state: &RatesState) -> Value {
        let fetched_at = state.fetched_at_ms.and_then(|ms| {
            DateTime::from_timestamp_millis(ms)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        });
        json!({
            "status": state.status,
            "source": state.source,
            "fetchedAt": fetched_at,
            "knownModels": state.table.len(),
        })
    }

    pub async fn refresh_rates(&self) -> Value {
        self.load_cached_rates().await;
        let fetched = self.fetch_rates_document().await;
        let mut guard = self.rates.lock().await;
        if let Some(document) = fetched {
            let now_ms = Utc::now().timestamp_millis();
            let table = parse_rate_table(&document);
            *guard = RatesState {
                table,
                status: "fresh".to_owned(),
                source: "litellm".to_owned(),
                fetched_at_ms: Some(now_ms),
            };
            if let Some(parent) = self.rates_cache_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let payload = json!({
                "fetchedAtMs": now_ms,
                "document": document,
            });
            let _ = tokio::fs::write(&self.rates_cache_path, payload.to_string()).await;
        }
        Self::pricing_json(&guard)
    }

    async fn fetch_rates_document(&self) -> Option<Value> {
        if let Ok(resp) = self.http.get(LITELLM_RATES_URL).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Ok(doc) = serde_json::from_str::<Value>(&text) {
                        if doc.is_object() {
                            return Some(doc);
                        }
                    }
                }
            }
        }
        if let Ok(resp) = self
            .http
            .get(LITELLM_RATES_API_URL)
            .header("Accept", "application/vnd.github.raw+json")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Ok(doc) = serde_json::from_str::<Value>(&text) {
                        if doc.is_object() {
                            return Some(doc);
                        }
                    }
                }
            }
        }
        None
    }

    pub async fn read_summary(&self, input: &Value, settings: &Value) -> Result<Value, Value> {
        let started = Instant::now();
        let since_day = input
            .get("sinceDay")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| is_valid_day(s))
            .ok_or_else(|| usage_error("invalidWindow", "sinceDay must be a YYYY-MM-DD date"))?;
        let until_day = input
            .get("untilDay")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| is_valid_day(s))
            .ok_or_else(|| usage_error("invalidWindow", "untilDay must be a YYYY-MM-DD date"))?;
        if since_day > until_day {
            return Err(usage_error(
                "invalidWindow",
                "sinceDay must not be after untilDay",
            ));
        }
        let time_zone = input
            .get("timeZone")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| usage_error("invalidWindow", "timeZone must be a non-empty string"))?;

        let resolution = match input.get("resolution").and_then(Value::as_str) {
            None | Some("day") => UsageResolution::Day,
            Some("hour") => UsageResolution::Hour,
            Some(other) => {
                return Err(usage_error(
                    "invalidWindow",
                    &format!("Unsupported usage resolution '{other}'"),
                ))
            }
        };

        let (since_time_ms, until_time_ms) = if resolution == UsageResolution::Hour {
            let since_str = input
                .get("sinceTime")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    usage_error("invalidWindow", "Hourly usage requires sinceTime and untilTime")
                })?;
            let until_str = input
                .get("untilTime")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    usage_error("invalidWindow", "Hourly usage requires sinceTime and untilTime")
                })?;
            let s = parse_timestamp_ms_str(since_str).ok_or_else(|| {
                usage_error("invalidWindow", "sinceTime must be a valid ISO timestamp")
            })?;
            let u = parse_timestamp_ms_str(until_str).ok_or_else(|| {
                usage_error("invalidWindow", "untilTime must be a valid ISO timestamp")
            })?;
            if u <= s || u - s > MAX_HOURLY_WINDOW_MS {
                return Err(usage_error(
                    "invalidWindow",
                    "Hourly usage window must be positive and at most 24 hours",
                ));
            }
            (Some(s), Some(u))
        } else {
            (None, None)
        };

        let requested_filter: Option<UsageModelFilter> = input
            .get("modelFilter")
            .filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .map_err(|_| usage_error("invalidWindow", "Invalid modelFilter"))?;
        let model_filter = canonical_model_filter(requested_filter.as_ref());

        self.load_cached_rates().await;
        let (rates_table, pricing_json) = {
            let guard = self.rates.lock().await;
            (guard.table.clone(), Self::pricing_json(&guard))
        };

        let window_start_ms = since_time_ms.unwrap_or_else(|| {
            NaiveDate::parse_from_str(since_day, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|dt| dt.and_utc().timestamp_millis())
                .unwrap_or(0)
        }) - MTIME_SLACK_MS;

        let price_overrides = create_override_rate_table(&settings["usagePriceOverrides"]);
        let model_aliases = resolve_model_aliases(&settings["usageModelAliases"]);

        let dirs = resolve_transcript_dirs(settings);
        let mut aggregator = UsageAggregator::new(AggregateOptions {
            time_zone,
            since_day,
            until_day,
            rates: &rates_table,
            price_overrides: (!price_overrides.is_empty()).then_some(&price_overrides),
            model_aliases: (!model_aliases.is_empty()).then_some(&model_aliases),
            model_filter: model_filter.as_ref(),
            resolution,
            since_time_ms,
            until_time_ms,
        })
        .map_err(|detail| usage_error("invalidWindow", detail))?;

        let mut sources = Vec::new();
        for dir in dirs {
            let source = scan_transcript_dir(&self.host_id, &dir, window_start_ms, &mut aggregator);
            sources.push(source);
        }

        let aggregated = aggregator.finish();
        let read_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let scan_duration_ms = started.elapsed().as_millis() as u64;

        let mut summary = json!({
            "contractVersion": USAGE_CONTRACT_VERSION,
            "readAt": read_at,
            "timeZone": time_zone,
            "sinceDay": since_day,
            "untilDay": until_day,
            "buckets": aggregated.buckets,
            "sources": sources,
            "pricing": pricing_json,
            "scanDurationMs": scan_duration_ms,
        });
        if let Some(filter) = model_filter {
            summary["modelFilter"] = serde_json::to_value(filter).unwrap_or(Value::Null);
        }
        Ok(summary)
    }
}

fn usage_error(reason: &str, detail: &str) -> Value {
    json!({
        "_tag": "UsageReadError",
        "reason": reason,
        "detail": detail,
        "message": format!("Usage read failed ({reason}): {detail}"),
    })
}

fn is_valid_day(day: &str) -> bool {
    day.len() == 10 && NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok()
}

fn parse_timestamp_ms_str(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn parse_timestamp_ms_val(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(s) = v.as_str() {
        return parse_timestamp_ms_str(s);
    }
    if let Some(n) = v.as_f64() {
        if n.is_finite() {
            return Some(if n < 1e12 { (n * 1000.0) as i64 } else { n as i64 });
        }
    }
    None
}

#[derive(Clone)]
struct TranscriptDirSpec {
    provider: &'static str,
    dir: PathBuf,
}

fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}

fn resolve_transcript_dirs(settings: &Value) -> Vec<TranscriptDirSpec> {
    let mut specs = Vec::new();
    let mut seen = HashSet::new();
    let mut push_dir = |provider: &'static str, dir: PathBuf| {
        if seen.insert((provider, dir.clone())) {
            specs.push(TranscriptDirSpec { provider, dir });
        }
    };

    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(env_claude) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        push_dir("claude", PathBuf::from(env_claude).join("projects"));
    } else if let Some(ref h) = home {
        push_dir("claude", h.join(".claude").join("projects"));
    }

    if let Some(env_codex) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        let base = PathBuf::from(env_codex);
        push_dir("codex", base.join("sessions"));
        push_dir("codex", base.join("archived_sessions"));
    } else if let Some(ref h) = home {
        push_dir("codex", h.join(".codex").join("sessions"));
        push_dir("codex", h.join(".codex").join("archived_sessions"));
    }

    if let Some(instances) = settings.get("providerInstances").and_then(Value::as_object) {
        for instance in instances.values() {
            let driver = instance.get("driver").and_then(Value::as_str);
            let config = instance.get("config");
            let env = config.and_then(|c| c.get("env"));
            match driver {
                Some("claudeAgent") => {
                    if let Some(dir) = env
                        .and_then(|e| e.get("CLAUDE_CONFIG_DIR"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                    {
                        push_dir("claude", expand_home(dir.trim()).join("projects"));
                    }
                }
                Some("codex") => {
                    if let Some(dir) = config
                        .and_then(|c| c.get("codexHome"))
                        .or_else(|| env.and_then(|e| e.get("CODEX_HOME")))
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                    {
                        let base = expand_home(dir.trim());
                        push_dir("codex", base.join("sessions"));
                        push_dir("codex", base.join("archived_sessions"));
                    }
                }
                _ => {}
            }
        }
    }

    specs
}

fn directory_volume_id(dir: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(meta) = std::fs::metadata(dir) {
            return format!("{}:{}", meta.dev(), meta.ino());
        }
    }
    String::new()
}

fn scan_transcript_dir(
    host_id: &str,
    spec: &TranscriptDirSpec,
    window_start_ms: i64,
    aggregator: &mut UsageAggregator<'_>,
) -> Value {
    let resolved_path = spec.dir.to_string_lossy().into_owned();
    let volume_id = directory_volume_id(&spec.dir);
    if !spec.dir.exists() {
        return json!({
            "fingerprint": {
                "hostId": host_id,
                "provider": spec.provider,
                "resolvedHomePath": resolved_path,
                "volumeId": volume_id,
            },
            "status": "missing",
            "scannedFiles": 0,
            "skippedFiles": 0,
            "malformedRecords": 0,
            "distinctSessions": 0,
            "message": Value::Null,
        });
    }

    let mut files = Vec::new();
    collect_jsonl_files(&spec.dir, &mut files);
    let mut scanned_files: u64 = 0;
    let mut skipped_files: u64 = 0;
    let mut malformed_records: u64 = 0;
    let mut sessions = HashSet::new();

    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            skipped_files += 1;
            continue;
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(i64::MAX);
        if mtime_ms < window_start_ms {
            skipped_files += 1;
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            skipped_files += 1;
            continue;
        };
        scanned_files += 1;
        let (records, malformed) = match spec.provider {
            "claude" => parse_claude_transcript(&content),
            "codex" => parse_codex_transcript(&content),
            _ => (Vec::new(), 0),
        };
        malformed_records += malformed;
        for record in records {
            if !record.session_id.is_empty() {
                sessions.insert(record.session_id.clone());
            }
            aggregator.add(record, None);
        }
    }

    let status = if skipped_files > 0 && scanned_files == 0 {
        "partial"
    } else {
        "ok"
    };
    json!({
        "fingerprint": {
            "hostId": host_id,
            "provider": spec.provider,
            "resolvedHomePath": resolved_path,
            "volumeId": volume_id,
        },
        "status": status,
        "scannedFiles": scanned_files,
        "skippedFiles": skipped_files,
        "malformedRecords": malformed_records,
        "distinctSessions": sessions.len(),
        "message": Value::Null,
    })
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn token_count(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).unwrap_or(0)
}

fn parse_claude_transcript(content: &str) -> (Vec<UsageRecord>, u64) {
    let mut records = Vec::new();
    let mut malformed = 0u64;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            malformed += 1;
            continue;
        };
        if parsed.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = parsed.get("message").and_then(Value::as_object) else {
            continue;
        };
        let Some(usage) = message.get("usage").and_then(Value::as_object) else {
            continue;
        };
        let Some(timestamp_ms) = parse_timestamp_ms_val(parsed.get("timestamp")) else {
            continue;
        };
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("");
        if model.is_empty() || model == "<synthetic>" {
            continue;
        }
        let message_id = message.get("id").and_then(Value::as_str);
        let request_id = parsed.get("requestId").and_then(Value::as_str);
        let dedupe_key = if message_id.is_none() && request_id.is_none() {
            None
        } else {
            Some(format!(
                "{}:{}",
                message_id.unwrap_or(""),
                request_id.unwrap_or("")
            ))
        };
        let session_id = parsed
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let reported_cost_usd = parsed
            .get("costUSD")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite());
        let speed = if usage.get("speed").and_then(Value::as_str) == Some("fast") {
            UsageSpeed::Fast
        } else {
            UsageSpeed::Standard
        };
        let cache_1h = usage
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(Value::as_u64)
            .filter(|&n| n > 0);
        records.push(UsageRecord {
            provider: "claude".into(),
            timestamp_ms,
            model: model.to_owned(),
            rate_model: None,
            session_id: session_id.clone(),
            totals: UsageTokenTotals {
                uncached_input_tokens: token_count(usage.get("input_tokens")),
                cached_input_tokens: token_count(usage.get("cache_read_input_tokens")),
                cache_creation_tokens: token_count(usage.get("cache_creation_input_tokens")),
                output_tokens: token_count(usage.get("output_tokens")),
                reasoning_tokens: 0,
            },
            cache_creation_1h_tokens: cache_1h,
            reported_cost_usd,
            speed,
            dedupe_key: dedupe_key.clone(),
        });
        if let Some(iterations) = usage.get("iterations").and_then(Value::as_array) {
            for (idx, iter) in iterations.iter().enumerate() {
                if iter.get("type").and_then(Value::as_str) != Some("advisor_message") {
                    continue;
                }
                let advisor_model = iter.get("model").and_then(Value::as_str).unwrap_or("");
                if advisor_model.is_empty() || advisor_model == "<synthetic>" {
                    continue;
                }
                let advisor_1h = iter
                    .get("cache_creation")
                    .and_then(|c| c.get("ephemeral_1h_input_tokens"))
                    .and_then(Value::as_u64)
                    .filter(|&n| n > 0);
                records.push(UsageRecord {
                    provider: "claude".into(),
                    timestamp_ms,
                    model: advisor_model.to_owned(),
                    rate_model: None,
                    session_id: session_id.clone(),
                    totals: UsageTokenTotals {
                        uncached_input_tokens: token_count(iter.get("input_tokens")),
                        cached_input_tokens: token_count(iter.get("cache_read_input_tokens")),
                        cache_creation_tokens: token_count(
                            iter.get("cache_creation_input_tokens"),
                        ),
                        output_tokens: token_count(iter.get("output_tokens")),
                        reasoning_tokens: 0,
                    },
                    cache_creation_1h_tokens: advisor_1h,
                    reported_cost_usd: None,
                    speed,
                    dedupe_key: dedupe_key
                        .as_ref()
                        .map(|k| format!("{k}:advisor:{idx}")),
                });
            }
        }
    }
    (records, malformed)
}

fn parse_codex_transcript(content: &str) -> (Vec<UsageRecord>, u64) {
    let mut records = Vec::new();
    let mut malformed = 0u64;
    let mut current_model = String::new();
    let mut current_session_id = String::new();
    let mut current_speed = UsageSpeed::Standard;
    let mut prev_cumulative: Option<(u64, u64, u64, u64, u64)> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            malformed += 1;
            continue;
        };
        let entry_type = parsed.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = parsed.get("payload").unwrap_or(&Value::Null);
        match entry_type {
            "session_meta" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    current_session_id = id.to_owned();
                }
            }
            "turn_context" => {
                if let Some(m) = payload.get("model").and_then(Value::as_str) {
                    if !m.trim().is_empty() {
                        current_model = m.trim().to_owned();
                    }
                }
            }
            "thread_settings_applied" => {
                current_speed = match payload.get("service_tier").and_then(Value::as_str) {
                    Some("fast") => UsageSpeed::Fast,
                    Some("ultrafast") => UsageSpeed::Ultrafast,
                    _ => UsageSpeed::Standard,
                };
            }
            "event_msg" => {
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(timestamp_ms) = parse_timestamp_ms_val(parsed.get("timestamp")) else {
                    continue;
                };
                if current_model.is_empty() {
                    continue;
                }
                let info = payload.get("info").unwrap_or(&Value::Null);
                let total_usage = info.get("total_token_usage");
                let last_usage = info.get("last_token_usage");
                let delta = if let Some(total) = total_usage.and_then(Value::as_object) {
                    let inp = token_count(total.get("input_tokens"));
                    let cached = token_count(total.get("cached_input_tokens"));
                    let write = token_count(total.get("cache_write_input_tokens"));
                    let out = token_count(total.get("output_tokens"));
                    let reas = token_count(total.get("reasoning_output_tokens"));
                    let d = if let Some((pi, pc, pw, po, pr)) = prev_cumulative {
                        if inp >= pi && cached >= pc && write >= pw && out >= po && reas >= pr {
                            (inp - pi, cached - pc, write - pw, out - po, reas - pr)
                        } else {
                            (inp, cached, write, out, reas)
                        }
                    } else if let Some(last) = last_usage.and_then(Value::as_object) {
                        (
                            token_count(last.get("input_tokens")),
                            token_count(last.get("cached_input_tokens")),
                            token_count(last.get("cache_write_input_tokens")),
                            token_count(last.get("output_tokens")),
                            token_count(last.get("reasoning_output_tokens")),
                        )
                    } else {
                        (inp, cached, write, out, reas)
                    };
                    prev_cumulative = Some((inp, cached, write, out, reas));
                    d
                } else if let Some(last) = last_usage.and_then(Value::as_object) {
                    (
                        token_count(last.get("input_tokens")),
                        token_count(last.get("cached_input_tokens")),
                        token_count(last.get("cache_write_input_tokens")),
                        token_count(last.get("output_tokens")),
                        token_count(last.get("reasoning_output_tokens")),
                    )
                } else {
                    continue;
                };
                let uncached = delta.0.saturating_sub(delta.1 + delta.2);
                if uncached + delta.1 + delta.2 + delta.3 == 0 {
                    continue;
                }
                records.push(UsageRecord {
                    provider: "codex".into(),
                    timestamp_ms,
                    model: current_model.clone(),
                    rate_model: None,
                    session_id: current_session_id.clone(),
                    totals: UsageTokenTotals {
                        uncached_input_tokens: uncached,
                        cached_input_tokens: delta.1,
                        cache_creation_tokens: delta.2,
                        output_tokens: delta.3,
                        reasoning_tokens: delta.4,
                    },
                    cache_creation_1h_tokens: None,
                    reported_cost_usd: None,
                    speed: current_speed,
                    dedupe_key: None,
                });
            }
            _ => {}
        }
    }
    (records, malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "t3code-usage-test-{name}-{}-{}",
            std::process::id(),
            NEXT_DIR_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn read_summary_applies_usage_model_aliases_and_price_overrides() {
        const FIXTURE_ROOT: &str = "T3_TEST_USAGE_FIXTURE_ROOT";
        let Some(root) = std::env::var_os(FIXTURE_ROOT).map(PathBuf::from) else {
            let root = temp_dir("aliases-overrides");
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "usage_service::tests::read_summary_applies_usage_model_aliases_and_price_overrides",
                ])
                .env(FIXTURE_ROOT, &root)
                .env("CLAUDE_CONFIG_DIR", root.join("empty-claude"))
                .env("CODEX_HOME", root.join("empty-codex"))
                .output()
                .unwrap();
            let _ = std::fs::remove_dir_all(&root);
            let output = String::from_utf8_lossy(&result.stdout);
            assert!(result.status.success() && output.contains("1 passed"), "{output}");
            return;
        };
        let claude_dir = root.join("projects");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let transcript = claude_dir.join("session.jsonl");
        std::fs::write(
            &transcript,
            format!(
                "{}\n",
                json!({
                    "type": "assistant",
                    "timestamp": "2026-01-15T12:00:00Z",
                    "sessionId": "s-1",
                    "requestId": "req-1",
                    "message": {
                        "id": "msg-1",
                        "model": "raw-preview-model",
                        "usage": {
                            "input_tokens": 1_000_000,
                            "cache_read_input_tokens": 0,
                            "cache_creation_input_tokens": 0,
                            "output_tokens": 500_000
                        }
                    }
                })
            ),
        )
        .unwrap();

        let service = UsageService::new(root.join("cache"));
        let settings = json!({
            "providerInstances": {
                "claude-custom": {
                    "driver": "claudeAgent",
                    "config": {
                        "env": {
                            "CLAUDE_CONFIG_DIR": root.to_string_lossy()
                        }
                    }
                }
            },
            "usageModelAliases": {
                "raw-preview-model": "aliased-billing-model"
            },
            "usagePriceOverrides": {
                "aliased-billing-model": {
                    "inputCostPerMillionTokens": 4.0,
                    "outputCostPerMillionTokens": 12.0
                }
            }
        });
        let summary = service
            .read_summary(
                &json!({
                    "sinceDay": "2026-01-01",
                    "untilDay": "2026-01-31",
                    "timeZone": "UTC"
                }),
                &settings,
            )
            .await
            .unwrap();

        assert_eq!(summary["contractVersion"], USAGE_CONTRACT_VERSION);
        let buckets = summary["buckets"].as_array().unwrap();
        let aliased = buckets
            .iter()
            .find(|b| b["model"] == "aliased-billing-model")
            .expect("expected aliased bucket");
        // 1M * $4/M + 0.5M * $12/M = $10.0
        assert!((aliased["costUsd"].as_f64().unwrap() - 10.0).abs() < 1e-6);
        assert_eq!(aliased["costSource"], "modelPriced");
    }
}
