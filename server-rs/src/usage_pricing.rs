//! Usage pricing: LiteLLM rate-table parsing, custom price overrides, and per-record costing.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UsageSpeed {
    #[default]
    Standard,
    Fast,
    Ultrafast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenTotals {
    pub uncached_input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageCostSource {
    ProviderReported,
    ModelPriced,
    Unpriced,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCategoryCost {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenRates {
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_read_cost_per_token: f64,
    pub cache_creation_cost_per_token: f64,
    pub cache_creation_1h_cost_per_token: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpeedRates {
    pub standard: TokenRates,
    pub fast: Option<TokenRates>,
    pub ultrafast: Option<TokenRates>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextTier {
    pub threshold_tokens: u64,
    pub rate: SpeedRates,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelRate {
    pub speeds: SpeedRates,
    pub context_tiers: Vec<ContextTier>,
}

pub type RateTable = HashMap<String, ModelRate>;

#[derive(Debug, Clone)]
pub struct PricedRecord<'a> {
    pub model: &'a str,
    pub rate_model: Option<&'a str>,
    pub totals: UsageTokenTotals,
    pub cache_creation_1h_tokens: Option<u64>,
    pub speed: UsageSpeed,
    pub reported_cost_usd: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct PricedUsage {
    pub cost_usd: f64,
    pub cost_source: UsageCostSource,
    pub category_cost_usd: Option<UsageCategoryCost>,
    pub speed_premium_usd: f64,
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// Build an override rate table from `settings.usagePriceOverrides`.
pub fn create_override_rate_table(overrides: &Value) -> RateTable {
    let mut table = RateTable::new();
    let Some(map) = overrides.as_object() else {
        return table;
    };
    for (model, prices) in map {
        let Some(prices_obj) = prices.as_object() else {
            continue;
        };
        let Some(input_per_million) = finite_number(prices_obj.get("inputCostPerMillionTokens"))
        else {
            continue;
        };
        let Some(output_per_million) = finite_number(prices_obj.get("outputCostPerMillionTokens"))
        else {
            continue;
        };
        let cache_read_per_million =
            finite_number(prices_obj.get("cacheReadCostPerMillionTokens"))
                .unwrap_or(input_per_million);
        let cache_write_per_million =
            finite_number(prices_obj.get("cacheWriteCostPerMillionTokens"))
                .unwrap_or(input_per_million);
        let cache_creation = cache_write_per_million / 1_000_000.0;
        let standard = TokenRates {
            input_cost_per_token: input_per_million / 1_000_000.0,
            output_cost_per_token: output_per_million / 1_000_000.0,
            cache_read_cost_per_token: cache_read_per_million / 1_000_000.0,
            cache_creation_cost_per_token: cache_creation,
            cache_creation_1h_cost_per_token: cache_creation,
        };
        table.insert(
            model.trim().to_owned(),
            ModelRate {
                speeds: SpeedRates {
                    standard,
                    fast: None,
                    ultrafast: None,
                },
                context_tiers: Vec::new(),
            },
        );
    }
    table
}

fn read_token_rates(
    entry: &serde_json::Map<String, Value>,
    suffix: &str,
    standard: Option<&TokenRates>,
    output_fallback: Option<f64>,
) -> Option<TokenRates> {
    let input = finite_number(entry.get(&format!("input_cost_per_token{suffix}")))?;
    let output =
        finite_number(entry.get(&format!("output_cost_per_token{suffix}"))).or(output_fallback)?;

    let cache_rate = |name: &str, std_val: Option<f64>, fallback: f64| -> f64 {
        if let Some(direct) = finite_number(entry.get(&format!("{name}{suffix}"))) {
            return direct;
        }
        if let (Some(std), Some(s_val)) = (standard, std_val) {
            if std.input_cost_per_token > 0.0 {
                return (s_val / std.input_cost_per_token) * input;
            }
        }
        fallback
    };

    let cache_read = cache_rate(
        "cache_read_input_token_cost",
        standard.map(|s| s.cache_read_cost_per_token),
        input,
    );
    let cache_creation = cache_rate(
        "cache_creation_input_token_cost",
        standard.map(|s| s.cache_creation_cost_per_token),
        input,
    );
    let cache_creation_1h = cache_rate(
        "cache_creation_input_token_cost_above_1hr",
        standard.map(|s| s.cache_creation_1h_cost_per_token),
        cache_creation,
    );

    Some(TokenRates {
        input_cost_per_token: input,
        output_cost_per_token: output,
        cache_read_cost_per_token: cache_read,
        cache_creation_cost_per_token: cache_creation,
        cache_creation_1h_cost_per_token: cache_creation_1h,
    })
}

fn scale_token_rates(rates: &TokenRates, multiple: f64) -> TokenRates {
    TokenRates {
        input_cost_per_token: rates.input_cost_per_token * multiple,
        output_cost_per_token: rates.output_cost_per_token * multiple,
        cache_read_cost_per_token: rates.cache_read_cost_per_token * multiple,
        cache_creation_cost_per_token: rates.cache_creation_cost_per_token * multiple,
        cache_creation_1h_cost_per_token: rates.cache_creation_1h_cost_per_token * multiple,
    }
}

fn fast_multiplier(entry: &serde_json::Map<String, Value>) -> Option<f64> {
    let specific = entry.get("provider_specific_entry")?.as_object()?;
    let fast = finite_number(specific.get("fast"))?;
    (fast > 0.0).then_some(fast)
}

fn read_speed_rates(
    entry: &serde_json::Map<String, Value>,
    standard: TokenRates,
    suffix: &str,
) -> SpeedRates {
    let multiple = fast_multiplier(entry);
    let fast = match multiple {
        None => read_token_rates(entry, &format!("{suffix}_priority"), Some(&standard), None),
        Some(m) => Some(scale_token_rates(&standard, m)),
    };
    let ultrafast = read_token_rates(
        entry,
        &format!("{suffix}_ultrafast"),
        Some(&standard),
        None,
    );
    SpeedRates {
        standard,
        fast,
        ultrafast,
    }
}

fn read_context_tiers(
    entry: &serde_json::Map<String, Value>,
    base: &TokenRates,
) -> Vec<ContextTier> {
    let mut thresholds = HashSet::new();
    for key in entry.keys() {
        if let Some(rest) = key.strip_prefix("input_cost_per_token_above_") {
            let digits_end = rest
                .find("k_tokens")
                .filter(|&idx| {
                    let suffix = &rest[idx + "k_tokens".len()..];
                    suffix.is_empty() || suffix == "_priority" || suffix == "_ultrafast"
                })
                .filter(|&idx| (1..=7).contains(&idx) && rest[..idx].bytes().all(|b| b.is_ascii_digit()));
            if let Some(idx) = digits_end {
                if let Ok(num) = rest[..idx].parse::<u64>() {
                    thresholds.insert(num);
                }
            }
        }
    }
    let mut tiers: Vec<ContextTier> = thresholds
        .into_iter()
        .map(|threshold| {
            let suffix = format!("_above_{threshold}k_tokens");
            let standard =
                read_token_rates(entry, &suffix, Some(base), Some(base.output_cost_per_token))
                    .unwrap_or_else(|| base.clone());
            ContextTier {
                threshold_tokens: threshold * 1_000,
                rate: read_speed_rates(entry, standard, &suffix),
            }
        })
        .collect();
    tiers.sort_by_key(|b| std::cmp::Reverse(b.threshold_tokens));
    tiers
}

fn is_first_party_provider(prefix: &str) -> bool {
    matches!(
        prefix,
        "anthropic" | "deepseek" | "gemini" | "meta" | "mistral" | "openai" | "xai"
    )
}

fn same_token_rates(a: &Option<TokenRates>, b: &Option<TokenRates>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn merge_speed_rates(a: &SpeedRates, b: &SpeedRates) -> Option<SpeedRates> {
    if a.standard != b.standard {
        return None;
    }
    let fast = a.fast.clone().or_else(|| b.fast.clone());
    let ultrafast = a.ultrafast.clone().or_else(|| b.ultrafast.clone());
    if !same_token_rates(&fast, &b.fast.clone().or_else(|| fast.clone()))
        || !same_token_rates(&ultrafast, &b.ultrafast.clone().or_else(|| ultrafast.clone()))
    {
        return None;
    }
    Some(SpeedRates {
        standard: a.standard.clone(),
        fast,
        ultrafast,
    })
}

fn merge_context_tiers(a: &[ContextTier], b: &[ContextTier]) -> Option<Vec<ContextTier>> {
    if a.is_empty() {
        return Some(b.to_vec());
    }
    if b.is_empty() {
        return Some(a.to_vec());
    }
    if a.len() != b.len() {
        return None;
    }
    let mut merged = Vec::with_capacity(a.len());
    for (left, right) in a.iter().zip(b.iter()) {
        if left.threshold_tokens != right.threshold_tokens {
            return None;
        }
        let rate = merge_speed_rates(&left.rate, &right.rate)?;
        merged.push(ContextTier {
            threshold_tokens: left.threshold_tokens,
            rate,
        });
    }
    Some(merged)
}

fn merge_alias_rate(a: &ModelRate, b: &ModelRate) -> Option<ModelRate> {
    let speeds = merge_speed_rates(&a.speeds, &b.speeds)?;
    let context_tiers = merge_context_tiers(&a.context_tiers, &b.context_tiers)?;
    Some(ModelRate {
        speeds,
        context_tiers,
    })
}

fn normalize_rate_key(model: &str) -> String {
    model.trim().to_ascii_lowercase()
}

fn bare_model_name(key: &str) -> &str {
    key.rsplit_once('/').map_or(key, |(_, bare)| bare)
}

fn bedrock_base_model_name(key: &str) -> &str {
    key.strip_prefix("anthropic.").unwrap_or(key)
}

fn strip_variant_suffix(key: &str) -> &str {
    key.split_once('[').map_or(key, |(base, _)| base)
}

fn is_unpriceable_model(bare_name: &str) -> bool {
    matches!(
        bare_name,
        "<synthetic>" | "synthetic" | "opus" | "sonnet" | "haiku" | "fable"
    )
}

/// Parse a LiteLLM model pricing JSON document into a normalized `RateTable`.
pub fn parse_rate_table(document: &Value) -> RateTable {
    let mut table = RateTable::new();
    let Some(map) = document.as_object() else {
        return table;
    };
    for (name, raw) in map {
        let Some(entry) = raw.as_object() else {
            continue;
        };
        let Some(standard) = read_token_rates(entry, "", None, None) else {
            continue;
        };
        let key = normalize_rate_key(name);
        if key.is_empty() {
            continue;
        }
        let context_tiers = read_context_tiers(entry, &standard);
        let speeds = read_speed_rates(entry, standard, "");
        table.insert(
            key,
            ModelRate {
                speeds,
                context_tiers,
            },
        );
    }

    let mut alias_candidates: HashMap<String, (Option<ModelRate>, bool)> = HashMap::new();
    for (key, rate) in &table {
        let slash = key.find('/');
        let alias = match slash {
            None => bedrock_base_model_name(key),
            Some(_) => bare_model_name(key),
        };
        if alias.is_empty() || alias == key || table.contains_key(alias) {
            continue;
        }
        let first_party = slash.is_some_and(|idx| is_first_party_provider(&key[..idx]));
        match alias_candidates.get_mut(alias) {
            None => {
                alias_candidates.insert(alias.to_owned(), (Some(rate.clone()), first_party));
            }
            Some((held_rate, held_first_party)) => {
                if first_party && !*held_first_party {
                    *held_rate = Some(rate.clone());
                    *held_first_party = true;
                } else if first_party == *held_first_party {
                    if let Some(existing) = held_rate.take() {
                        *held_rate = merge_alias_rate(&existing, rate);
                    }
                }
            }
        }
    }
    for (alias, (rate, _)) in alias_candidates {
        if let Some(rate) = rate {
            table.insert(alias, rate);
        }
    }

    table
}

pub fn lookup_rate<'a>(table: &'a RateTable, model: &str) -> Option<&'a ModelRate> {
    let normalized = normalize_rate_key(model);
    let key = strip_variant_suffix(&normalized);
    let bare = bare_model_name(key);
    if bare.is_empty() || is_unpriceable_model(bare) {
        return None;
    }
    table.get(key)
}

fn record_rate<'a>(table: &'a RateTable, record: &PricedRecord<'_>) -> Option<&'a ModelRate> {
    record
        .rate_model
        .and_then(|rm| lookup_rate(table, rm))
        .or_else(|| lookup_rate(table, record.model))
}

fn prompt_tokens(totals: UsageTokenTotals) -> u64 {
    totals
        .uncached_input_tokens
        .saturating_add(totals.cached_input_tokens)
        .saturating_add(totals.cache_creation_tokens)
}

fn rates_at(rate: &ModelRate, speed: UsageSpeed, totals: UsageTokenTotals) -> &TokenRates {
    let prompt = prompt_tokens(totals);
    let tier = rate
        .context_tiers
        .iter()
        .find(|tier| prompt > tier.threshold_tokens)
        .map(|tier| &tier.rate);
    match speed {
        UsageSpeed::Standard => tier.map_or(&rate.speeds.standard, |t| &t.standard),
        UsageSpeed::Fast => tier
            .and_then(|t| t.fast.as_ref())
            .or(rate.speeds.fast.as_ref())
            .or_else(|| tier.map(|t| &t.standard))
            .unwrap_or(&rate.speeds.standard),
        UsageSpeed::Ultrafast => tier
            .and_then(|t| t.ultrafast.as_ref())
            .or(rate.speeds.ultrafast.as_ref())
            .or_else(|| tier.map(|t| &t.standard))
            .unwrap_or(&rate.speeds.standard),
    }
}

fn cost_by_category(record: &PricedRecord<'_>, rates: &TokenRates) -> UsageCategoryCost {
    let totals = record.totals;
    let one_hour = record
        .cache_creation_1h_tokens
        .unwrap_or(0)
        .min(totals.cache_creation_tokens);
    UsageCategoryCost {
        input: totals.uncached_input_tokens as f64 * rates.input_cost_per_token,
        cache_read: totals.cached_input_tokens as f64 * rates.cache_read_cost_per_token,
        cache_write: (totals.cache_creation_tokens - one_hour) as f64
            * rates.cache_creation_cost_per_token
            + one_hour as f64 * rates.cache_creation_1h_cost_per_token,
        output: totals.output_tokens as f64 * rates.output_cost_per_token,
    }
}

fn sum_categories(cost: &UsageCategoryCost) -> f64 {
    cost.input + cost.cache_read + cost.cache_write + cost.output
}

pub fn price_usage(
    table: &RateTable,
    record: &PricedRecord<'_>,
    overrides: Option<&RateTable>,
) -> PricedUsage {
    let override_rate = overrides.and_then(|ov| ov.get(record.model.trim()));
    let reported = if override_rate.is_none() {
        record
            .reported_cost_usd
            .filter(|cost| cost.is_finite())
    } else {
        None
    };

    let Some(rate) = override_rate.or_else(|| record_rate(table, record)) else {
        return match reported {
            None => PricedUsage {
                cost_usd: 0.0,
                cost_source: UsageCostSource::Unpriced,
                category_cost_usd: None,
                speed_premium_usd: 0.0,
            },
            Some(cost) => PricedUsage {
                cost_usd: cost,
                cost_source: UsageCostSource::ProviderReported,
                category_cost_usd: None,
                speed_premium_usd: 0.0,
            },
        };
    };

    let list_cost = cost_by_category(record, rates_at(rate, record.speed, record.totals));
    let list_cost_usd = sum_categories(&list_cost);
    if let Some(rep) = reported {
        if list_cost_usd <= 0.0 {
            return PricedUsage {
                cost_usd: rep,
                cost_source: UsageCostSource::ProviderReported,
                category_cost_usd: None,
                speed_premium_usd: 0.0,
            };
        }
    }
    let premium_usd = if record.speed == UsageSpeed::Standard {
        0.0
    } else {
        list_cost_usd
            - sum_categories(&cost_by_category(
                record,
                rates_at(rate, UsageSpeed::Standard, record.totals),
            ))
    };
    let scale = reported.map_or(1.0, |rep| rep / list_cost_usd);
    PricedUsage {
        cost_usd: reported.unwrap_or(list_cost_usd),
        cost_source: if reported.is_none() {
            UsageCostSource::ModelPriced
        } else {
            UsageCostSource::ProviderReported
        },
        category_cost_usd: Some(UsageCategoryCost {
            input: list_cost.input * scale,
            cache_read: list_cost.cache_read * scale,
            cache_write: list_cost.cache_write * scale,
            output: list_cost.output * scale,
        }),
        speed_premium_usd: premium_usd * scale,
    }
}

pub fn cache_savings_usd(
    table: &RateTable,
    record: &PricedRecord<'_>,
    overrides: Option<&RateTable>,
) -> f64 {
    let Some(rate) = overrides
        .and_then(|ov| ov.get(record.model.trim()))
        .or_else(|| record_rate(table, record))
    else {
        return 0.0;
    };
    let rates = rates_at(rate, record.speed, record.totals);
    record.totals.cached_input_tokens as f64
        * (rates.input_cost_per_token - rates.cache_read_cost_per_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn override_rate_table_prices_models_and_overrides_reported_cost() {
        let overrides = create_override_rate_table(&json!({
            "custom-model": {
                "inputCostPerMillionTokens": 3.0,
                "outputCostPerMillionTokens": 15.0,
                "cacheReadCostPerMillionTokens": 0.3,
                "cacheWriteCostPerMillionTokens": 3.75
            }
        }));
        let empty = RateTable::new();
        let record = PricedRecord {
            model: "custom-model",
            rate_model: None,
            totals: UsageTokenTotals {
                uncached_input_tokens: 1_000_000,
                cached_input_tokens: 2_000_000,
                cache_creation_tokens: 1_000_000,
                output_tokens: 500_000,
                reasoning_tokens: 0,
            },
            cache_creation_1h_tokens: None,
            speed: UsageSpeed::Standard,
            reported_cost_usd: Some(999.0),
        };
        let priced = price_usage(&empty, &record, Some(&overrides));
        assert_eq!(priced.cost_source, UsageCostSource::ModelPriced);
        // 3.0 + 0.6 + 3.75 + 7.5 = 14.85
        assert!((priced.cost_usd - 14.85).abs() < 1e-9);
        let savings = cache_savings_usd(&empty, &record, Some(&overrides));
        // 2_000_000 * (3.0 - 0.3) / 1e6 = 5.4
        assert!((savings - 5.4).abs() < 1e-9);
    }

    #[test]
    fn override_falls_back_to_input_for_cache_rates() {
        let overrides = create_override_rate_table(&json!({
            "simple-model": {
                "inputCostPerMillionTokens": 2.0,
                "outputCostPerMillionTokens": 8.0
            }
        }));
        let rate = overrides.get("simple-model").unwrap();
        assert!((rate.speeds.standard.cache_read_cost_per_token - 2e-6).abs() < 1e-12);
        assert!((rate.speeds.standard.cache_creation_cost_per_token - 2e-6).abs() < 1e-12);
    }

    #[test]
    fn parse_rate_table_handles_bare_aliases_and_variants() {
        let doc = json!({
            "anthropic/claude-sonnet-4-5": {
                "input_cost_per_token": 0.000003,
                "output_cost_per_token": 0.000015,
                "cache_read_input_token_cost": 0.0000003,
                "cache_creation_input_token_cost": 0.00000375
            }
        });
        let table = parse_rate_table(&doc);
        assert!(lookup_rate(&table, "claude-sonnet-4-5").is_some());
        assert!(lookup_rate(&table, "claude-sonnet-4-5[1m]").is_some());
        assert!(lookup_rate(&table, "<synthetic>").is_none());
    }
}
