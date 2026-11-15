//! Usage aggregation: model aliases, model filtering, deduplication, and bucketing.

use crate::usage_pricing::{
    cache_savings_usd, price_usage, PricedRecord, RateTable, UsageCategoryCost, UsageCostSource,
    UsageSpeed, UsageTokenTotals,
};
use chrono::{DateTime, FixedOffset, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<UsageModelSelector>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<UsageModelSelector>>,
}

#[derive(Debug, Clone)]
pub struct UsageRecord {
    pub provider: String,
    pub timestamp_ms: i64,
    pub model: String,
    pub rate_model: Option<String>,
    pub session_id: String,
    pub totals: UsageTokenTotals,
    pub cache_creation_1h_tokens: Option<u64>,
    pub reported_cost_usd: Option<f64>,
    pub speed: UsageSpeed,
    pub dedupe_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsageResolution {
    #[default]
    Day,
    Hour,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub day: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hour_start: Option<String>,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub totals: UsageTokenTotals,
    pub cost_usd: f64,
    pub cache_savings_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_cost_usd: Option<UsageCategoryCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ultrafast_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_premium_usd: Option<f64>,
    pub cost_source: UsageCostSource,
    pub records: u64,
    pub unpriced_records: u64,
    pub unpriced_tokens: u64,
    pub sessions: u64,
}

#[derive(Debug, Clone)]
pub struct AggregateOptions<'a> {
    pub time_zone: &'a str,
    pub since_day: &'a str,
    pub until_day: &'a str,
    pub rates: &'a RateTable,
    pub price_overrides: Option<&'a RateTable>,
    pub model_aliases: Option<&'a HashMap<String, String>>,
    pub model_filter: Option<&'a UsageModelFilter>,
    pub resolution: UsageResolution,
    pub since_time_ms: Option<i64>,
    pub until_time_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct AggregateResult {
    pub buckets: Vec<UsageBucket>,
    pub duplicates_dropped: u64,
    pub out_of_window: u64,
}

/// Resolve chained model aliases, dropping cycles just like TypeScript `resolveModelAliases`.
pub fn resolve_model_aliases(aliases: &Value) -> HashMap<String, String> {
    let mut resolved = HashMap::new();
    let Some(map) = aliases.as_object() else {
        return resolved;
    };
    let string_map: HashMap<&str, &str> = map
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
        .collect();

    for &model in string_map.keys() {
        let mut seen = HashSet::new();
        seen.insert(model);
        let mut target = string_map[model];
        while let Some(&next) = string_map.get(target) {
            if !seen.insert(target) {
                break;
            }
            target = next;
        }
        if !string_map.contains_key(target) {
            resolved.insert(model.to_owned(), target.to_owned());
        }
    }
    resolved
}

fn keeps_usage_record(filter: Option<&UsageModelFilter>, record: &UsageRecord) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    let model = record.model.trim();
    let matches = |selector: &UsageModelSelector| -> bool {
        selector.model == model
            && selector
                .provider
                .as_deref()
                .is_none_or(|p| p == record.provider)
    };
    let included = filter
        .include
        .as_ref()
        .is_none_or(|inc| inc.iter().any(matches));
    let excluded = filter
        .exclude
        .as_ref()
        .is_some_and(|exc| exc.iter().any(matches));
    included && !excluded
}

fn selector_key(selector: &UsageModelSelector) -> String {
    serde_json::to_string(&(&selector.provider, &selector.model)).unwrap_or_default()
}

fn canonical_selectors(selectors: &[UsageModelSelector]) -> Vec<UsageModelSelector> {
    let mut map = BTreeMap::new();
    for selector in selectors {
        map.insert(selector_key(selector), selector.clone());
    }
    map.into_values().collect()
}

pub fn canonical_model_filter(filter: Option<&UsageModelFilter>) -> Option<UsageModelFilter> {
    let filter = filter?;
    let exclude = filter
        .exclude
        .as_ref()
        .filter(|e| !e.is_empty())
        .map(|e| canonical_selectors(e));
    if filter.include.is_none() && exclude.is_none() {
        return None;
    }
    Some(UsageModelFilter {
        include: filter.include.as_ref().map(|inc| canonical_selectors(inc)),
        exclude,
    })
}

pub fn merge_usage_copies(held: UsageRecord, copy: UsageRecord) -> UsageRecord {
    let a = held.totals;
    let b = copy.totals;
    let reported_cost_usd = match (held.reported_cost_usd, copy.reported_cost_usd) {
        (None, other) | (other, None) => other,
        (Some(x), Some(y)) => Some(x.max(y)),
    };
    if b.uncached_input_tokens <= a.uncached_input_tokens
        && b.cached_input_tokens <= a.cached_input_tokens
        && b.cache_creation_tokens <= a.cache_creation_tokens
        && b.output_tokens <= a.output_tokens
        && b.reasoning_tokens <= a.reasoning_tokens
        && copy.cache_creation_1h_tokens.unwrap_or(0) <= held.cache_creation_1h_tokens.unwrap_or(0)
        && reported_cost_usd == held.reported_cost_usd
    {
        return held;
    }
    let cache_creation_1h = held
        .cache_creation_1h_tokens
        .unwrap_or(0)
        .max(copy.cache_creation_1h_tokens.unwrap_or(0));
    UsageRecord {
        cache_creation_1h_tokens: (cache_creation_1h > 0).then_some(cache_creation_1h),
        totals: UsageTokenTotals {
            uncached_input_tokens: a.uncached_input_tokens.max(b.uncached_input_tokens),
            cached_input_tokens: a.cached_input_tokens.max(b.cached_input_tokens),
            cache_creation_tokens: a.cache_creation_tokens.max(b.cache_creation_tokens),
            output_tokens: a.output_tokens.max(b.output_tokens),
            reasoning_tokens: a.reasoning_tokens.max(b.reasoning_tokens),
        },
        reported_cost_usd,
        ..held
    }
}

enum DayFormatter {
    Utc,
    Fixed(FixedOffset),
    Local,
}

impl DayFormatter {
    fn new(time_zone: &str) -> Self {
        let trimmed = time_zone.trim();
        if trimmed.eq_ignore_ascii_case("UTC") || trimmed.eq_ignore_ascii_case("Etc/UTC") {
            return Self::Utc;
        }
        if let Some(offset) = parse_fixed_offset(trimmed) {
            return Self::Fixed(offset);
        }
        if iana_time_zone::get_timezone()
            .ok()
            .is_some_and(|local_tz| local_tz == trimmed)
        {
            return Self::Local;
        }
        Self::Utc
    }

    fn format_day(&self, timestamp_ms: i64) -> String {
        let Some(utc_dt) = DateTime::from_timestamp_millis(timestamp_ms) else {
            return "1970-01-01".to_owned();
        };
        match self {
            Self::Utc => utc_dt.format("%Y-%m-%d").to_string(),
            Self::Fixed(offset) => offset.from_utc_datetime(&utc_dt.naive_utc()).format("%Y-%m-%d").to_string(),
            Self::Local => utc_dt.with_timezone(&Local).format("%Y-%m-%d").to_string(),
        }
    }
}

fn parse_fixed_offset(tz: &str) -> Option<FixedOffset> {
    let raw = tz
        .strip_prefix("UTC")
        .or_else(|| tz.strip_prefix("GMT"))
        .unwrap_or(tz);
    let sign = if let Some(rest) = raw.strip_prefix('+') {
        (1, rest)
    } else if let Some(rest) = raw.strip_prefix('-') {
        (-1, rest)
    } else {
        return None;
    };
    let (hours, mins) = if let Some((h, m)) = sign.1.split_once(':') {
        (h.parse::<i32>().ok()?, m.parse::<i32>().ok()?)
    } else if sign.1.len() == 2 {
        (sign.1.parse::<i32>().ok()?, 0)
    } else {
        return None;
    };
    if hours > 23 || mins > 59 {
        return None;
    }
    FixedOffset::east_opt(sign.0 * (hours * 3600 + mins * 60))
}

#[derive(Default)]
struct MutableBucket {
    totals: UsageTokenTotals,
    cost_usd: f64,
    cache_savings_usd: f64,
    category_cost_usd: Option<UsageCategoryCost>,
    fast_cost_usd: f64,
    ultrafast_cost_usd: f64,
    speed_premium_usd: f64,
    records: u64,
    unpriced_records: u64,
    unpriced_tokens: u64,
    provider_reported_records: u64,
    sessions: HashSet<String>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct BucketKey {
    day: String,
    hour_start: String,
    provider: String,
    model: String,
    source_path: String,
}

struct Contribution {
    record: UsageRecord,
    bucket_key: Option<BucketKey>,
}

pub struct UsageAggregator<'a> {
    options: AggregateOptions<'a>,
    day_formatter: DayFormatter,
    hourly_window: Option<(i64, i64)>,
    buckets: HashMap<BucketKey, MutableBucket>,
    seen: HashMap<String, Contribution>,
    duplicates_dropped: u64,
    out_of_window: u64,
}

impl<'a> UsageAggregator<'a> {
    pub fn new(options: AggregateOptions<'a>) -> Result<Self, &'static str> {
        let hourly_window = if options.resolution == UsageResolution::Hour {
            match (options.since_time_ms, options.until_time_ms) {
                (Some(s), Some(u)) => Some((s, u)),
                _ => return Err("Hourly usage aggregation requires exact time bounds"),
            }
        } else {
            None
        };
        let day_formatter = DayFormatter::new(options.time_zone);
        Ok(Self {
            options,
            day_formatter,
            hourly_window,
            buckets: HashMap::new(),
            seen: HashMap::new(),
            duplicates_dropped: 0,
            out_of_window: 0,
        })
    }

    pub fn add(&mut self, input: UsageRecord, source_path: Option<&str>) -> bool {
        if !keeps_usage_record(self.options.model_filter, &input) {
            return false;
        }
        let record = self.map_model(input);
        if let Some(dedupe_key) = record.dedupe_key.clone() {
            if let Some(held) = self.seen.get_mut(&dedupe_key) {
                self.duplicates_dropped += 1;
                if held.bucket_key.is_some() {
                    let prev = std::mem::replace(
                        &mut held.record,
                        UsageRecord {
                            provider: String::new(),
                            timestamp_ms: 0,
                            model: String::new(),
                            rate_model: None,
                            session_id: String::new(),
                            totals: UsageTokenTotals::default(),
                            cache_creation_1h_tokens: None,
                            reported_cost_usd: None,
                            speed: UsageSpeed::Standard,
                            dedupe_key: None,
                        },
                    );
                    held.record = merge_usage_copies(prev, record);
                }
                return false;
            }
            let bucket_key = self.place_in_window(&record, source_path.unwrap_or(""));
            let in_window = bucket_key.is_some();
            if let Some(ref key) = bucket_key {
                if !record.session_id.is_empty() {
                    self.buckets
                        .entry(key.clone())
                        .or_default()
                        .sessions
                        .insert(record.session_id.clone());
                }
            } else {
                self.out_of_window += 1;
            }
            self.seen.insert(
                dedupe_key,
                Contribution {
                    record,
                    bucket_key,
                },
            );
            return in_window;
        }

        let Some(key) = self.place_in_window(&record, source_path.unwrap_or("")) else {
            self.out_of_window += 1;
            return false;
        };
        if !record.session_id.is_empty() {
            self.buckets
                .entry(key.clone())
                .or_default()
                .sessions
                .insert(record.session_id.clone());
        }
        self.accumulate(&key, &record);
        true
    }

    fn map_model(&self, mut record: UsageRecord) -> UsageRecord {
        if let Some(aliases) = self.options.model_aliases {
            if let Some(target) = aliases.get(&record.model) {
                record.model = target.clone();
                record.rate_model = None;
            }
        }
        record
    }

    fn place_in_window(&mut self, record: &UsageRecord, source: &str) -> Option<BucketKey> {
        if let Some((since_ms, until_ms)) = self.hourly_window {
            if record.timestamp_ms < since_ms || record.timestamp_ms >= until_ms {
                return None;
            }
        }
        let day = self.day_formatter.format_day(record.timestamp_ms);
        if self.hourly_window.is_none()
            && (day.as_str() < self.options.since_day || day.as_str() > self.options.until_day)
        {
            return None;
        }
        let hour_start = match self.hourly_window {
            None => String::new(),
            Some((since_ms, _)) => {
                let hour_index = (record.timestamp_ms - since_ms).div_euclid(HOUR_MS);
                DateTime::from_timestamp_millis(since_ms + hour_index * HOUR_MS)
                    .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }
        };
        let key = BucketKey {
            day,
            hour_start,
            provider: record.provider.clone(),
            model: record.model.clone(),
            source_path: source.to_owned(),
        };
        self.buckets.entry(key.clone()).or_default();
        Some(key)
    }

    fn accumulate(&mut self, key: &BucketKey, record: &UsageRecord) {
        let priced_rec = PricedRecord {
            model: &record.model,
            rate_model: record.rate_model.as_deref(),
            totals: record.totals,
            cache_creation_1h_tokens: record.cache_creation_1h_tokens,
            speed: record.speed,
            reported_cost_usd: record.reported_cost_usd,
        };
        let priced = price_usage(self.options.rates, &priced_rec, self.options.price_overrides);
        let savings = cache_savings_usd(
            self.options.rates,
            &priced_rec,
            self.options.price_overrides,
        );

        let bucket = self.buckets.entry(key.clone()).or_default();
        bucket.totals.uncached_input_tokens += record.totals.uncached_input_tokens;
        bucket.totals.cached_input_tokens += record.totals.cached_input_tokens;
        bucket.totals.cache_creation_tokens += record.totals.cache_creation_tokens;
        bucket.totals.output_tokens += record.totals.output_tokens;
        bucket.totals.reasoning_tokens += record.totals.reasoning_tokens;
        bucket.cost_usd += priced.cost_usd;
        if let Some(add) = priced.category_cost_usd {
            bucket.category_cost_usd = Some(match bucket.category_cost_usd {
                None => add,
                Some(sum) => UsageCategoryCost {
                    input: sum.input + add.input,
                    cache_read: sum.cache_read + add.cache_read,
                    cache_write: sum.cache_write + add.cache_write,
                    output: sum.output + add.output,
                },
            });
        }
        match record.speed {
            UsageSpeed::Fast => bucket.fast_cost_usd += priced.cost_usd,
            UsageSpeed::Ultrafast => bucket.ultrafast_cost_usd += priced.cost_usd,
            UsageSpeed::Standard => {}
        }
        bucket.speed_premium_usd += priced.speed_premium_usd;
        bucket.cache_savings_usd += savings;
        bucket.records += 1;
        if priced.cost_source == UsageCostSource::Unpriced {
            bucket.unpriced_records += 1;
            bucket.unpriced_tokens += record.totals.uncached_input_tokens
                + record.totals.cached_input_tokens
                + record.totals.cache_creation_tokens
                + record.totals.output_tokens;
        }
        if priced.cost_source == UsageCostSource::ProviderReported {
            bucket.provider_reported_records += 1;
        }
    }

    pub fn finish(mut self) -> AggregateResult {
        let seen = std::mem::take(&mut self.seen);
        for contribution in seen.into_values() {
            if let Some(key) = contribution.bucket_key {
                self.accumulate(&key, &contribution.record);
            }
        }
        let mut buckets: Vec<UsageBucket> = self
            .buckets
            .into_iter()
            .filter(|(_, bucket)| bucket.records > 0)
            .map(|(key, bucket)| {
                let category_cost_usd = bucket.category_cost_usd.map(|c| UsageCategoryCost {
                    input: round_usd(c.input),
                    cache_read: round_usd(c.cache_read),
                    cache_write: round_usd(c.cache_write),
                    output: round_usd(c.output),
                });
                let fast_cost_usd = round_usd(bucket.fast_cost_usd);
                let ultrafast_cost_usd = round_usd(bucket.ultrafast_cost_usd);
                let speed_premium_usd = round_usd(bucket.speed_premium_usd);
                let cost_source = if bucket.unpriced_records == bucket.records {
                    UsageCostSource::Unpriced
                } else if bucket.provider_reported_records == bucket.records {
                    UsageCostSource::ProviderReported
                } else {
                    UsageCostSource::ModelPriced
                };
                UsageBucket {
                    day: key.day,
                    hour_start: (!key.hour_start.is_empty()).then_some(key.hour_start),
                    provider: key.provider,
                    model: key.model,
                    source_path: (!key.source_path.is_empty()).then_some(key.source_path),
                    totals: bucket.totals,
                    cost_usd: bucket.cost_usd,
                    cache_savings_usd: bucket.cache_savings_usd,
                    category_cost_usd,
                    fast_cost_usd: (fast_cost_usd != 0.0).then_some(fast_cost_usd),
                    ultrafast_cost_usd: (ultrafast_cost_usd != 0.0).then_some(ultrafast_cost_usd),
                    speed_premium_usd: (speed_premium_usd != 0.0).then_some(speed_premium_usd),
                    cost_source,
                    records: bucket.records,
                    unpriced_records: bucket.unpriced_records,
                    unpriced_tokens: bucket.unpriced_tokens,
                    sessions: bucket.sessions.len() as u64,
                }
            })
            .collect();
        buckets.sort_by(|a, b| {
            a.day
                .cmp(&b.day)
                .then_with(|| a.hour_start.as_deref().unwrap_or("").cmp(b.hour_start.as_deref().unwrap_or("")))
                .then_with(|| a.provider.cmp(&b.provider))
                .then_with(|| a.model.cmp(&b.model))
        });
        AggregateResult {
            buckets,
            duplicates_dropped: self.duplicates_dropped,
            out_of_window: self.out_of_window,
        }
    }
}

fn round_usd(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_pricing::create_override_rate_table;
    use serde_json::json;

    #[test]
    fn resolve_model_aliases_resolves_chains_and_drops_cycles() {
        let resolved = resolve_model_aliases(&json!({
            "a": "b",
            "b": "c",
            "cycle1": "cycle2",
            "cycle2": "cycle1"
        }));
        assert_eq!(resolved.get("a").map(String::as_str), Some("c"));
        assert_eq!(resolved.get("b").map(String::as_str), Some("c"));
        assert!(!resolved.contains_key("cycle1"));
        assert!(!resolved.contains_key("cycle2"));
    }

    #[test]
    fn aggregator_applies_model_aliases_and_price_overrides() {
        let aliases = resolve_model_aliases(&json!({ "example-preview": "claude-fable-5" }));
        let overrides = create_override_rate_table(&json!({
            "claude-fable-5": {
                "inputCostPerMillionTokens": 10.0,
                "outputCostPerMillionTokens": 30.0
            }
        }));
        let rates = RateTable::new();
        let mut aggregator = UsageAggregator::new(AggregateOptions {
            time_zone: "UTC",
            since_day: "2026-01-01",
            until_day: "2026-01-31",
            rates: &rates,
            price_overrides: Some(&overrides),
            model_aliases: Some(&aliases),
            model_filter: None,
            resolution: UsageResolution::Day,
            since_time_ms: None,
            until_time_ms: None,
        })
        .unwrap();

        aggregator.add(
            UsageRecord {
                provider: "claude".into(),
                timestamp_ms: 1_767_225_600_000, // 2026-01-01T00:00:00Z
                model: "example-preview".into(),
                rate_model: Some("ignored-provider-rate".into()),
                session_id: "s1".into(),
                totals: UsageTokenTotals {
                    uncached_input_tokens: 1_000_000,
                    cached_input_tokens: 0,
                    cache_creation_tokens: 0,
                    output_tokens: 500_000,
                    reasoning_tokens: 0,
                },
                cache_creation_1h_tokens: None,
                reported_cost_usd: None,
                speed: UsageSpeed::Standard,
                dedupe_key: None,
            },
            None,
        );

        let result = aggregator.finish();
        assert_eq!(result.buckets.len(), 1);
        assert_eq!(result.buckets[0].model, "claude-fable-5");
        assert!((result.buckets[0].cost_usd - 25.0).abs() < 1e-9);
        assert_eq!(result.buckets[0].cost_source, UsageCostSource::ModelPriced);
    }

    #[test]
    fn model_filter_matches_original_model_before_alias() {
        let aliases = resolve_model_aliases(&json!({ "excluded-raw": "kept-alias" }));
        let rates = RateTable::new();
        let filter = UsageModelFilter {
            include: Some(vec![UsageModelSelector {
                provider: None,
                model: "kept-alias".into(),
            }]),
            exclude: None,
        };
        let mut aggregator = UsageAggregator::new(AggregateOptions {
            time_zone: "UTC",
            since_day: "2026-01-01",
            until_day: "2026-01-31",
            rates: &rates,
            price_overrides: None,
            model_aliases: Some(&aliases),
            model_filter: Some(&filter),
            resolution: UsageResolution::Day,
            since_time_ms: None,
            until_time_ms: None,
        })
        .unwrap();

        let kept = aggregator.add(
            UsageRecord {
                provider: "claude".into(),
                timestamp_ms: 1_767_225_600_000,
                model: "excluded-raw".into(),
                rate_model: None,
                session_id: "s1".into(),
                totals: UsageTokenTotals::default(),
                cache_creation_1h_tokens: None,
                reported_cost_usd: None,
                speed: UsageSpeed::Standard,
                dedupe_key: None,
            },
            None,
        );
        assert!(!kept);
        assert!(aggregator.finish().buckets.is_empty());
    }
}
