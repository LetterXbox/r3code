// The Usage page's answer cache: one in-memory+persisted entry per environment and window (or, for limits,
// per environment), shared by the page, the background prewarm and a period switch so they never race each
// other into duplicate scans. client-runtime state/server.ts usageSummary: an answer stays good for
// USAGE_STALE_MS (reopening the page or coming back to a period does not rescan), and one whose sources are
// still refreshing is shown at once and then asked again with awaitRefresh.
import { Storage } from "nsh";
import { parseUsage, parseUsageLimits, type UsageLimitAccount, type UsageResult } from "../../pages/utility-data";
import { requestUsageEnvironment } from "./usageEnvironments";

export const USAGE_STALE_MS = 60_000;

export interface UsageWindowInput {
  sinceDay: string;
  untilDay: string;
  resolution: "day" | "hour";
  timeZone?: string;
  sinceTime?: string;
  untilTime?: string;
}

export interface UsageCacheEntry {
  value: UsageResult;
  at: number;
}

export interface UsageLimitsCacheEntry {
  value: UsageLimitAccount[];
  at: number;
}

type Listener<T> = (entry: T) => void;

const summaryKey = (environmentId: string, window: UsageWindowInput) => `${environmentId}|${window.sinceDay}|${window.untilDay}|${window.resolution}`;
const limitsKey = (environmentId: string) => `limits|${environmentId}`;

const summaryCache = new Map<string, UsageCacheEntry>();
const summaryInflight = new Map<string, Promise<UsageResult>>();
const summaryListeners = new Map<string, Set<Listener<UsageCacheEntry>>>();

const limitsCache = new Map<string, UsageLimitsCacheEntry>();
const limitsListeners = new Map<string, Set<Listener<UsageLimitsCacheEntry>>>();

function subscribe<T>(listeners: Map<string, Set<Listener<T>>>, key: string, listener: Listener<T>): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(key); };
}

function notify<T>(listeners: Map<string, Set<Listener<T>>>, key: string, entry: T) {
  for (const listener of listeners.get(key) ?? []) listener(entry);
}

/** The cached answer for an environment and window, if any, stale or not: paints the page instantly on open. */
export function peekUsageSummary(environmentId: string, window: UsageWindowInput): UsageCacheEntry | undefined {
  return summaryCache.get(summaryKey(environmentId, window));
}

/** Called every time a fresh (or still-refreshing) answer for this environment and window is stored. */
export function subscribeUsageSummary(environmentId: string, window: UsageWindowInput, listener: Listener<UsageCacheEntry>): () => void {
  return subscribe(summaryListeners, summaryKey(environmentId, window), listener);
}

/** The cached last-known limits for an environment, if any. */
export function peekUsageLimits(environmentId: string): UsageLimitsCacheEntry | undefined {
  return limitsCache.get(limitsKey(environmentId));
}

export function subscribeUsageLimits(environmentId: string, listener: Listener<UsageLimitsCacheEntry>): () => void {
  return subscribe(limitsListeners, limitsKey(environmentId), listener);
}

function storeSummary(key: string, environmentId: string, window: UsageWindowInput, raw: unknown, value: UsageResult) {
  const entry: UsageCacheEntry = { value, at: Date.now() };
  summaryCache.set(key, entry);
  notify(summaryListeners, key, entry);
  void persistEntry("summary", key, environmentId, raw, entry.at);
}

/** Records a limits answer the page already has (from its own `refreshLimitsOnce` call) into the shared cache. */
export function rememberUsageLimits(environmentId: string, raw: unknown, value: UsageLimitAccount[]) {
  const key = limitsKey(environmentId);
  const entry: UsageLimitsCacheEntry = { value, at: Date.now() };
  limitsCache.set(key, entry);
  notify(limitsListeners, key, entry);
  void persistEntry("limits", key, environmentId, raw, entry.at);
}

/**
 * The one way to ask an environment for its usage summary. Concurrent calls for the same environment and
 * window (the page opening, a prewarm already in flight, a period switch landing back on a period) share one
 * in-flight request. A fresh (< USAGE_STALE_MS, not `refreshing`) cached answer resolves at once with no
 * network call at all, so switching Cost/Tokens (the same payload) never refetches. `force` always asks the
 * server directly (bypassing both the cache and the de-duplication) with `awaitRefresh` from the first call.
 */
export async function loadUsageSummary(environmentId: string, window: UsageWindowInput, options: { force?: boolean } = {}): Promise<UsageResult> {
  const key = summaryKey(environmentId, window);
  const force = options.force === true;
  if (!force) {
    const cached = summaryCache.get(key);
    if (cached && Date.now() - cached.at < USAGE_STALE_MS && !cached.value.refreshing) return cached.value;
    const existing = summaryInflight.get(key);
    if (existing) return existing;
  }
  const run = (async (): Promise<UsageResult> => {
    const rawFirst = await requestUsageEnvironment(environmentId, "server.getUsageSummary", { ...window, ...(force ? { awaitRefresh: true } : {}) }, { timeoutMs: 180000 });
    let value = parseUsage(rawFirst);
    storeSummary(key, environmentId, window, rawFirst, value);
    if (value.refreshing && !force) {
      try {
        const rawSecond = await requestUsageEnvironment(environmentId, "server.getUsageSummary", { ...window, awaitRefresh: true }, { timeoutMs: 180000 });
        value = parseUsage(rawSecond);
        storeSummary(key, environmentId, window, rawSecond, value);
      } catch { /* the cached answer stays, as the reference keeps it when the slow refresh fails */ }
    }
    return value;
  })();
  if (!force) summaryInflight.set(key, run);
  try {
    return await run;
  } finally {
    if (!force && summaryInflight.get(key) === run) summaryInflight.delete(key);
  }
}

/** Test hook: forget every cached usage answer (in memory only; does not touch persisted storage). */
export function clearUsageSummaryCacheForTest() {
  summaryCache.clear();
  summaryInflight.clear();
  summaryListeners.clear();
  limitsCache.clear();
  limitsListeners.clear();
}

// --- Persistence: one compact entry per environment+period (or environment, for limits), bounded. ---

type PersistedKind = "summary" | "limits";
interface PersistedEntry {
  kind: PersistedKind;
  environmentId: string;
  raw: unknown;
  at: number;
}

const PERSIST_STORAGE_KEY = "usageSummaryPersisted";
/** A saved answer older than this is dropped rather than painted on startup: it would mislead more than help. */
const PERSIST_MAX_AGE_MS = 7 * 86_400_000;
/** The 4 standard periods (1/7/30/90 days) kept per environment for the summary kind; limits only ever has 1. */
const PERSIST_MAX_PER_GROUP = 4;
/** A generous compact cap so one environment's history never grows the store unbounded. */
const PERSIST_MAX_BYTES = 96 * 1024;

let persistOverride: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> } | null = null;
/** Tests swap in an in-memory store so persistence round-trips without touching the real device storage. */
export function setUsagePersistenceForTest(store: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> } | null) {
  persistOverride = store;
}
function storageBackend() { return persistOverride ?? Storage; }

function pruneEntries(entries: Record<string, PersistedEntry>): Record<string, PersistedEntry> {
  const now = Date.now();
  const fresh = Object.entries(entries).filter(([, entry]) => now - entry.at < PERSIST_MAX_AGE_MS);
  const byGroup = new Map<string, [string, PersistedEntry][]>();
  for (const pair of fresh) {
    const group = `${pair[1].kind}:${pair[1].environmentId}`;
    const list = byGroup.get(group) ?? [];
    list.push(pair);
    byGroup.set(group, list);
  }
  let kept: [string, PersistedEntry][] = [];
  for (const list of byGroup.values()) {
    list.sort((a, b) => b[1].at - a[1].at);
    kept.push(...list.slice(0, PERSIST_MAX_PER_GROUP));
  }
  kept.sort((a, b) => b[1].at - a[1].at);
  while (kept.length > 0 && JSON.stringify(Object.fromEntries(kept)).length > PERSIST_MAX_BYTES) kept.pop();
  return Object.fromEntries(kept);
}

async function readPersistedMap(): Promise<Record<string, PersistedEntry>> {
  try {
    const raw = await storageBackend().getItem(PERSIST_STORAGE_KEY);
    if (typeof raw !== "string") return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, PersistedEntry>;
  } catch {
    return {};
  }
}

async function persistEntry(kind: PersistedKind, key: string, environmentId: string, raw: unknown, at: number): Promise<void> {
  try {
    const stored = await readPersistedMap();
    stored[key] = { kind, environmentId, raw, at };
    const pruned = pruneEntries(stored);
    await storageBackend().setItem(PERSIST_STORAGE_KEY, JSON.stringify(pruned));
  } catch { /* storage is a convenience, not a requirement: the page still works without it */ }
}

let restored = false;
/** Test hook: let a later test call `restoreUsageCacheFromStorage` again as if freshly launched. */
export function resetUsageCacheRestoreForTest() { restored = false; }

/**
 * Loads every persisted answer into the in-memory cache, so opening Usage right after launch paints the last
 * known numbers instantly (before any network read). Each entry is validated on read with `parseUsage` /
 * `parseUsageLimits`: a corrupted or outdated-shape entry is dropped rather than shown. Safe to call more than
 * once; only the first call does anything.
 */
export async function restoreUsageCacheFromStorage(): Promise<void> {
  if (restored) return;
  restored = true;
  const stored = await readPersistedMap();
  for (const [key, entry] of Object.entries(stored)) {
    try {
      if (entry.kind === "summary") {
        const value = parseUsage(entry.raw);
        summaryCache.set(key, { value, at: entry.at });
      } else if (entry.kind === "limits") {
        const value = parseUsageLimits(entry.raw, true);
        limitsCache.set(key, { value, at: entry.at });
      }
    } catch { /* a corrupt or stale-shaped entry is simply skipped */ }
  }
}
