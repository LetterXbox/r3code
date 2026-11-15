import { signal } from "nsh";
import { expect, test } from "nsh/test";
import {
  clearUsageSummaryCacheForTest, loadUsageSummary, peekUsageSummary, resetUsageCacheRestoreForTest,
  restoreUsageCacheFromStorage, setUsagePersistenceForTest, subscribeUsageSummary,
} from "./usageCache";
import { resetUsagePrewarmForTest, scheduleUsagePrewarm } from "./usagePrewarm";
import { setUsageRequestForTest } from "./usageEnvironments";

const window = { sinceDay: "2026-11-10", untilDay: "2026-11-11", resolution: "day" as const };

function summaryPayload(costUsd: number, refreshing = false) {
  return {
    buckets: [{ day: "2026-11-10", provider: "claude", model: "m", costUsd, cacheSavingsUsd: 0, sessions: 1, totals: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 5 } }],
    sources: [{ fingerprint: { provider: "claude" }, distinctSessions: 1, status: "ok", refreshing }],
    pricing: { status: "fresh" },
  };
}

function reset() {
  clearUsageSummaryCacheForTest();
  resetUsageCacheRestoreForTest();
  resetUsagePrewarmForTest();
  setUsageRequestForTest(null);
  setUsagePersistenceForTest(null);
}

test("concurrent calls for the same environment and window share one in-flight request", async () => {
  reset();
  let calls = 0;
  setUsageRequestForTest(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return summaryPayload(5); });
  const [a, b, c] = await Promise.all([
    loadUsageSummary("env-1", window),
    loadUsageSummary("env-1", window),
    loadUsageSummary("env-1", window),
  ]);
  expect(calls).toBe(1);
  expect(a.buckets[0]!.costUsd).toBe(5);
  expect(b).toBe(a);
  expect(c).toBe(a);
});

test("a cached answer paints synchronously on open, before any network call resolves", async () => {
  reset();
  setUsageRequestForTest(async () => summaryPayload(7));
  await loadUsageSummary("env-1", window);
  // peekUsageSummary is a plain, synchronous read: no await needed to get the warm answer.
  const peeked = peekUsageSummary("env-1", window);
  expect(peeked?.value.buckets[0]!.costUsd).toBe(7);
});

test("a stale cached answer is returned at once, then the subscriber hears the refreshed one", async () => {
  reset();
  let call = 0;
  setUsageRequestForTest(async () => { call++; return summaryPayload(call); });
  await loadUsageSummary("env-1", window);
  const stale = peekUsageSummary("env-1", window)!;
  // Backdate it past the staleness window so the next load re-fetches instead of returning it untouched.
  (stale as { at: number }).at = Date.now() - 61_000;
  const seen: number[] = [];
  const unsubscribe = subscribeUsageSummary("env-1", window, (entry) => seen.push(entry.value.buckets[0]!.costUsd));
  const fresh = await loadUsageSummary("env-1", window);
  unsubscribe();
  expect(fresh.buckets[0]!.costUsd).toBe(2);
  expect(seen).toEqual([2]);
});

test("a refreshing answer is shown at once and triggers exactly one awaitRefresh follow-up", async () => {
  reset();
  const requests: unknown[] = [];
  setUsageRequestForTest(async (_id, _method, payload) => {
    requests.push(payload);
    const asked = payload as { awaitRefresh?: boolean };
    return asked.awaitRefresh ? summaryPayload(9) : summaryPayload(1, true);
  });
  const seen: number[] = [];
  const unsubscribe = subscribeUsageSummary("env-1", window, (entry) => seen.push(entry.value.buckets[0]!.costUsd));
  const value = await loadUsageSummary("env-1", window);
  unsubscribe();
  expect(seen).toEqual([1, 9]);
  expect(value.buckets[0]!.costUsd).toBe(9);
  expect(requests.length).toBe(2);
  expect((requests[1] as { awaitRefresh?: boolean }).awaitRefresh).toBe(true);
});

test("force bypasses the cache: it asks the server again even with a fresh, non-refreshing answer in hand", async () => {
  reset();
  let calls = 0;
  setUsageRequestForTest(async (_id, _method, payload) => {
    calls++;
    const asked = payload as { awaitRefresh?: boolean };
    return summaryPayload(calls, false);
  });
  await loadUsageSummary("env-1", window);
  expect(calls).toBe(1);
  const forced = await loadUsageSummary("env-1", window, { force: true });
  expect(calls).toBe(2);
  expect(forced.buckets[0]!.costUsd).toBe(2);
});

test("a persisted entry round-trips through restore, and an invalid one is ignored", async () => {
  reset();
  const store = new Map<string, string>();
  setUsagePersistenceForTest({
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => { store.set(key, value); },
  });
  setUsageRequestForTest(async () => summaryPayload(4));
  await loadUsageSummary("env-1", window);
  // A fresh process: forget the in-memory cache, but the persisted store still has the entry.
  clearUsageSummaryCacheForTest();
  resetUsageCacheRestoreForTest();
  await restoreUsageCacheFromStorage();
  expect(peekUsageSummary("env-1", window)?.value.buckets[0]!.costUsd).toBe(4);

  // Corrupt the one persisted entry and confirm it is dropped, not thrown, on the next restore.
  clearUsageSummaryCacheForTest();
  resetUsageCacheRestoreForTest();
  const raw = JSON.parse(store.get("usageSummaryPersisted")!);
  for (const key of Object.keys(raw)) raw[key].raw = { not: "a valid usage summary" };
  store.set("usageSummaryPersisted", JSON.stringify(raw));
  await restoreUsageCacheFromStorage();
  expect(peekUsageSummary("env-1", window)).toBeUndefined();
});

test("the prewarm waits for a connection and idle app, then runs exactly once", async () => {
  reset();
  let calls = 0;
  setUsageRequestForTest(async () => { calls++; return summaryPayload(1); });
  const connected = signal(false);
  const idle = signal(false);
  scheduleUsagePrewarm({
    isConnected: () => connected(),
    isIdle: () => idle(),
    environments: () => [{ id: "env-1", connected: true }],
    defaultPeriodDays: () => 30,
    delayMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(0);
  connected.set(true);
  // Still busy: a connected-but-busy app never arms the timer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(0);
  idle.set(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBeGreaterThan(0);
  const after = calls;
  // Toggling idle off and on again must not re-run the prewarm: once per session.
  idle.set(false);
  idle.set(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(after);
});
