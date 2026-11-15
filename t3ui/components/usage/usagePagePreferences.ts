// Port of apps/web/src/components/usage/usagePagePreferences.ts: the Usage page
// remembers its metric and time window (key t3code:usage-page-preferences:v1,
// default limits / 30 days). Hidden providers stay in usageState.ts.

export type UsageMetric = "cost" | "tokens" | "limits";
export type UsagePagePreferences = { metric: UsageMetric; windowDays: 1 | 7 | 30 | 90 };

export const USAGE_PAGE_PREFERENCES_KEY = "t3code:usage-page-preferences:v1";
export const DEFAULT_USAGE_PAGE_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

const METRICS: readonly string[] = ["cost", "tokens", "limits"];
const WINDOWS: readonly number[] = [1, 7, 30, 90];

/** Decodes a stored value; anything that does not match the reference schema falls back to the default. */
export function parseUsagePagePreferences(raw: unknown): UsagePagePreferences {
  if (typeof raw !== "string") return DEFAULT_USAGE_PAGE_PREFERENCES;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && METRICS.includes(value.metric) && WINDOWS.includes(value.windowDays)) {
      return { metric: value.metric, windowDays: value.windowDays };
    }
  } catch { /* corrupt value: use the default */ }
  return DEFAULT_USAGE_PAGE_PREFERENCES;
}

export function serializeUsagePagePreferences(preferences: UsagePagePreferences): string {
  return JSON.stringify({ metric: preferences.metric, windowDays: preferences.windowDays });
}
