// Formatting and aggregation for the Usage page, ported from
// packages/shared usageFormat.ts / usageLimits.ts and usage/usageProviders.ts + usageBreakdown.ts.
import type { UsageBucket, UsageLimitWindow } from "../../pages/utility-data";

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (!year || !month || !dayOfMonth) return day;
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return days;
  for (let at = start; at <= end; at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

// ---- Providers ----

export interface ProviderPresentation { key: string; label: string; color: string; driver: string }

export const PROVIDERS: ProviderPresentation[] = [
  { key: "codex", label: "Codex", color: "#d4d4d4", driver: "codex" },
  { key: "claude", label: "Claude Code", color: "#d97757", driver: "claudeAgent" },
  { key: "grok", label: "Grok Build", color: "#a3a3a3", driver: "grok" },
  { key: "cursor", label: "Cursor", color: "#8b8b8b", driver: "cursor" },
  { key: "opencode", label: "OpenCode", color: "#5b9bbd", driver: "opencode" },
  { key: "antigravity", label: "Antigravity", color: "#8c7bd1", driver: "antigravity" },
  { key: "pi", label: "Pi", color: "#4d9f8a", driver: "pi" },
  { key: "muse", label: "Muse Code", color: "#0866ff", driver: "muse" },
];

export function providerPresentation(key: string): ProviderPresentation {
  return PROVIDERS.find((provider) => provider.key === key) ?? { key, label: key, color: "#a3a3a3", driver: key };
}

export function providerForDriver(driver: string): ProviderPresentation | undefined {
  return PROVIDERS.find((provider) => provider.driver === driver);
}

// ---- Aggregation ----

export interface TokenTotals { uncached: number; cached: number; cacheWrite: number; output: number; total: number }
export interface ProviderTotals extends TokenTotals { provider: string; costUsd: number; sessions: number; costShare: number; tokenShare: number }
export interface ModelTotals extends TokenTotals { provider: string; model: string; costUsd: number; costShare: number; tokenShare: number }

function tokensOf(bucket: UsageBucket): number {
  return bucket.uncachedInputTokens + bucket.cachedInputTokens + bucket.cacheCreationTokens + bucket.outputTokens;
}

export function sumTotals(buckets: UsageBucket[]) {
  const totals = { uncached: 0, cached: 0, cacheWrite: 0, output: 0, total: 0, costUsd: 0, cacheSavingsUsd: 0 };
  for (const bucket of buckets) {
    totals.uncached += bucket.uncachedInputTokens;
    totals.cached += bucket.cachedInputTokens;
    totals.cacheWrite += bucket.cacheCreationTokens;
    totals.output += bucket.outputTokens;
    totals.total += tokensOf(bucket);
    totals.costUsd += bucket.costUsd;
    totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
  }
  return totals;
}

export function providerTotals(buckets: UsageBucket[], sessionsByProvider: Record<string, number>): ProviderTotals[] {
  const byProvider = new Map<string, UsageBucket[]>();
  for (const bucket of buckets) byProvider.set(bucket.provider, [...(byProvider.get(bucket.provider) ?? []), bucket]);
  const all = sumTotals(buckets);
  return PROVIDERS.flatMap((presentation) => {
    const mine = byProvider.get(presentation.key);
    if (!mine) return [];
    const sum = sumTotals(mine);
    return [{
      provider: presentation.key, uncached: sum.uncached, cached: sum.cached, cacheWrite: sum.cacheWrite, output: sum.output, total: sum.total,
      costUsd: sum.costUsd, sessions: sessionsByProvider[presentation.key] ?? mine.reduce((n, b) => n + b.sessions, 0),
      costShare: all.costUsd > 0 ? sum.costUsd / all.costUsd : 0, tokenShare: all.total > 0 ? sum.total / all.total : 0,
    }];
  });
}

export function rankProviders(totals: ProviderTotals[], metric: "cost" | "tokens"): ProviderTotals[] {
  return [...totals].sort((a, b) => metric === "cost" ? b.costUsd - a.costUsd : b.total - a.total);
}

export function modelTotals(buckets: UsageBucket[], metric: "cost" | "tokens"): ModelTotals[] {
  const map = new Map<string, ModelTotals>();
  for (const bucket of buckets) {
    const key = `${bucket.provider}:${bucket.model}`;
    const row = map.get(key) ?? { provider: bucket.provider, model: bucket.model, uncached: 0, cached: 0, cacheWrite: 0, output: 0, total: 0, costUsd: 0, costShare: 0, tokenShare: 0 };
    row.uncached += bucket.uncachedInputTokens;
    row.cached += bucket.cachedInputTokens;
    row.cacheWrite += bucket.cacheCreationTokens;
    row.output += bucket.outputTokens;
    row.total += tokensOf(bucket);
    row.costUsd += bucket.costUsd;
    map.set(key, row);
  }
  const all = sumTotals(buckets);
  const rows = [...map.values()].map((row) => ({
    ...row, costShare: all.costUsd > 0 ? row.costUsd / all.costUsd : 0, tokenShare: all.total > 0 ? row.total / all.total : 0,
  }));
  return rows.sort((a, b) => metric === "tokens" ? b.total - a.total || b.costUsd - a.costUsd : b.costUsd - a.costUsd || b.total - a.total);
}

export interface PeriodTotals { key: string; costUsd: number; total: number; byProvider: Record<string, { costUsd: number; total: number }> }

/** One entry per day (or hour, when `hourly`) that has buckets, oldest first. */
export function periodTotals(buckets: UsageBucket[], hourly: boolean): PeriodTotals[] {
  const map = new Map<string, PeriodTotals>();
  for (const bucket of buckets) {
    const key = hourly && bucket.hourStart ? bucket.hourStart : bucket.day;
    const row = map.get(key) ?? { key, costUsd: 0, total: 0, byProvider: {} };
    const tokens = tokensOf(bucket);
    row.costUsd += bucket.costUsd;
    row.total += tokens;
    const mine = row.byProvider[bucket.provider] ?? { costUsd: 0, total: 0 };
    mine.costUsd += bucket.costUsd;
    mine.total += tokens;
    row.byProvider[bucket.provider] = mine;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Zero-filled series across the whole window so the chart has one column per day or hour. */
export function chartSeries(buckets: UsageBucket[], sinceDay: string, untilDay: string, hourly: boolean, now = new Date()): PeriodTotals[] {
  const existing = new Map(periodTotals(buckets, hourly).map((row) => [row.key, row]));
  let keys: string[];
  if (hourly) {
    const end = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    keys = Array.from({ length: 24 }, (_, i) => new Date(end - (23 - i) * 3_600_000).toISOString().slice(0, 13) + ":00:00.000Z");
    const have = [...existing.keys()];
    // Server hour keys may be formatted differently; fall back to what it sent.
    if (have.length > 0 && !keys.some((key) => existing.has(key))) keys = have.sort();
  } else {
    keys = enumerateDays(sinceDay, untilDay);
  }
  return keys.map((key) => existing.get(key) ?? { key, costUsd: 0, total: 0, byProvider: {} });
}

export interface ShareSegment { label: string; value: number; color: string }

const TYPE_COLORS = { input: "#a3a3a3", cacheRead: "#6b6b6b", cacheWrite: "#c4c4c4", output: "#f5f5f5" };

export function tokenTypeSegments(totals: TokenTotals): ShareSegment[] {
  return [
    { label: "Input", value: totals.uncached, color: TYPE_COLORS.input },
    { label: "Cache read", value: totals.cached, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: totals.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: totals.output, color: TYPE_COLORS.output },
  ];
}

export interface SpeedCost { standard: number; fast: number; ultrafast: number; premium: number }

/** usageMerge's speedCost: standard is what is left of the cost after fast and ultrafast. */
export function speedCostOf(buckets: UsageBucket[]): SpeedCost {
  let cost = 0;
  const speed = { fast: 0, ultrafast: 0, premium: 0 };
  for (const bucket of buckets) {
    cost += bucket.costUsd;
    speed.fast += bucket.fastCostUsd ?? 0;
    speed.ultrafast += bucket.ultrafastCostUsd ?? 0;
    speed.premium += bucket.speedPremiumUsd ?? 0;
  }
  return { ...speed, standard: Math.max(0, cost - speed.fast - speed.ultrafast) };
}

/** speedCostSegments (usageBreakdown.ts), in the same ink steps as the type bar. */
export function speedCostSegments(cost: SpeedCost): ShareSegment[] {
  return [
    { label: "Standard", value: cost.standard, color: "#7c7c85" },
    { label: "Fast", value: cost.fast, color: "#a9a9b2" },
    { label: "Ultrafast", value: cost.ultrafast, color: "#e4e4e7" },
  ];
}

export function costTypeSegments(buckets: UsageBucket[]): ShareSegment[] {
  const cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let split = 0;
  let all = 0;
  for (const bucket of buckets) {
    all += bucket.costUsd;
    if (!bucket.categoryCost) continue;
    cost.input += bucket.categoryCost.input;
    cost.cacheRead += bucket.categoryCost.cacheRead;
    cost.cacheWrite += bucket.categoryCost.cacheWrite;
    cost.output += bucket.categoryCost.output;
  }
  split = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
  const unsplit = all - split;
  return [
    { label: "Input", value: cost.input, color: TYPE_COLORS.input },
    { label: "Cache read", value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: cost.output, color: TYPE_COLORS.output },
    { label: "Other", value: unsplit >= 0.005 ? unsplit : 0, color: "#858585" },
  ];
}

// ---- Limits ----

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function remainingPercent(window: Pick<UsageLimitWindow, "usedPercent">): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: Pick<UsageLimitWindow, "resetsAt">): number | null {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: UsageLimitWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === null) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

/** Bars show quota remaining, so even pace tracks time remaining. */
export function paceRemainingPercent(window: UsageLimitWindow, now: number): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: UsageLimitWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
}

/** PaceIcon's label and tooltip (UsageLimits.tsx PACE). */
export const PACE_DESCRIPTION: Record<LimitPace, { label: string; icon: string }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: "trending-up" },
  on: { label: "On pace with the window", icon: "gauge" },
  under: { label: "Under pace: headroom left for the rest of the window", icon: "trending-down" },
};

export const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(window: Pick<UsageLimitWindow, "resetsAt">, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}
