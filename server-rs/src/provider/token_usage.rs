//! Turn-level usage derived from Codex's thread-wide cumulative counters.
use serde_json::{json, Value};

#[derive(Clone, Copy, Default)]
struct Counters {
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    cache_write: Option<u64>,
}
impl Counters {
    fn parse(v: &Value) -> Option<Self> {
        Some(Self {
            input: v["inputTokens"].as_u64()?,
            cached: v["cachedInputTokens"].as_u64()?,
            output: v["outputTokens"].as_u64()?,
            reasoning: v["reasoningOutputTokens"].as_u64()?,
            cache_write: v["cacheWriteInputTokens"].as_u64(),
        })
    }
    fn delta(self, previous: Option<Self>, last: Self) -> Self {
        let Some(p) = previous else { return last };
        if self.input < p.input
            || self.cached < p.cached
            || self.output < p.output
            || self.reasoning < p.reasoning
        {
            return last;
        }
        Self {
            input: self.input - p.input,
            cached: self.cached - p.cached,
            output: self.output - p.output,
            reasoning: self.reasoning - p.reasoning,
            cache_write: self
                .cache_write
                .zip(p.cache_write)
                .and_then(|(a, b)| a.checked_sub(b)),
        }
    }
}
#[derive(Default)]
pub struct TurnUsage {
    baseline: Option<Counters>,
    sum: Counters,
    observed: bool,
    initialized: bool,
    has_subagents: bool,
}
impl TurnUsage {
    pub fn begin_turn(&mut self) {
        self.sum = Counters::default();
        self.observed = false;
        self.initialized = false;
        self.has_subagents = false;
    }
    pub fn observe_baseline(&mut self, usage: &Value) -> bool {
        let Some(total) = Counters::parse(&usage["total"]) else {
            return false;
        };
        self.baseline = Some(total);
        true
    }
    pub fn mark_subagent(&mut self) {
        self.has_subagents = true;
    }
    /// Returns false for a malformed notification, leaving state untouched.
    pub fn update(&mut self, usage: &Value) -> bool {
        let (Some(total), Some(last)) = (
            Counters::parse(&usage["total"]),
            Counters::parse(&usage["last"]),
        ) else {
            return false;
        };
        let delta = total.delta(self.baseline, last);
        self.baseline = Some(total);
        self.observed |=
            delta.input > 0 || delta.cached > 0 || delta.output > 0 || delta.reasoning > 0;
        self.sum.input = self.sum.input.saturating_add(delta.input);
        self.sum.cached = self.sum.cached.saturating_add(delta.cached);
        self.sum.output = self.sum.output.saturating_add(delta.output);
        self.sum.reasoning = self.sum.reasoning.saturating_add(delta.reasoning);
        self.sum.cache_write = if !self.initialized {
            delta.cache_write
        } else {
            self.sum
                .cache_write
                .zip(delta.cache_write)
                .map(|(a, b)| a.saturating_add(b))
        };
        self.initialized = true;
        true
    }
    pub fn finish(&self, completed: bool) -> Value {
        if !self.observed {
            return json!({"usageStatus":"unavailable","usageScope":"main_agent","hasSubagents":self.has_subagents});
        }
        let mut value = json!({"usageStatus": if completed {"complete"} else {"partial"}, "usageScope":"main_agent", "inputTokens":self.sum.input, "cachedInputTokens":self.sum.cached.min(self.sum.input), "outputTokens":self.sum.output, "reasoningTokens":self.sum.reasoning.min(self.sum.output), "hasSubagents":self.has_subagents});
        if let Some(n) = self.sum.cache_write {
            value["cacheCreationTokens"] = json!(n.min(self.sum.input));
        }
        value
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn c(i: u64, o: u64) -> Value {
        json!({"inputTokens":i,"cachedInputTokens":i/2,"outputTokens":o,"reasoningOutputTokens":o/2,"cacheWriteInputTokens":1})
    }
    #[test]
    fn preserves_baseline_across_turns_and_marks_subagents() {
        let mut s = TurnUsage::default();
        assert!(s.update(&json!({"total":c(100,20),"last":c(10,4)})));
        s.begin_turn();
        assert!(s.observe_baseline(&json!({"total":c(120,30)})));
        assert!(s.update(&json!({"total":c(127,34),"last":c(99,99)})));
        s.mark_subagent();
        let result = s.finish(true);
        assert_eq!(result["inputTokens"], 7);
        assert_eq!(result["outputTokens"], 4);
        assert_eq!(result["hasSubagents"], true);
        s.begin_turn();
        assert_eq!(s.finish(true)["hasSubagents"], false);
    }
    #[test]
    fn accumulates_deltas_and_handles_resets() {
        let mut s = TurnUsage::default();
        assert!(s.update(&json!({"total":c(100,20),"last":c(10,4)})));
        assert!(s.update(&json!({"total":c(120,30),"last":c(20,10)})));
        assert!(s.update(&json!({"total":c(2,2),"last":c(2,2)})));
        assert_eq!(s.finish(false)["inputTokens"], 32);
        assert_eq!(s.finish(false)["outputTokens"], 16);
        assert_eq!(s.finish(false)["usageStatus"], "partial");
        assert!(!s.update(&json!({"total":{},"last":{}})));
    }
}
