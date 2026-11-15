import { expect, test } from "nsh/test";
import {
  deriveSteerState, formatContextWindowTokens, isCompactionCommand, latestTokenUsage, observeThreadItem, providerState, readActiveRun,
  resetThreadProviderState, shouldOfferResumeCompaction,
} from "./threadProviderState";

const snapshot = {
  kind: "snapshot",
  projection: {
    thread: { activeProviderThreadId: "pt1" },
    providerSessions: [{ id: "s1", status: "running", capabilities: { turns: { supportsActiveSteering: true, supportsSteeringByInterruptRestart: false } } }],
    providerThreads: [{ id: "pt1", appThreadId: "t1", providerSessionId: "s1", updatedAt: "2026-01-01T00:00:00Z" }],
    providerTurns: [{ id: "turn1", providerThreadId: "pt1", runAttemptId: "att1", status: "running", tokenUsage: { usedTokens: 250000, maxTokens: 1000000, updatedAt: "2026-01-01T00:00:00Z" } }],
  },
};

test("a running turn on a provider that takes active steering can be promoted into", () => {
  resetThreadProviderState();
  observeThreadItem(snapshot);
  const run = readActiveRun([{ id: "r1", status: "running", activeAttemptId: "att1", providerThreadId: "pt1" }], "r1");
  expect(deriveSteerState({ data: providerState(), activeRun: run, appThreadId: "t1", activeMessage: undefined }).canPromoteToSteer).toBe(true);
});

test("a provider without steering, or a turn that has not started, cannot be steered", () => {
  resetThreadProviderState();
  observeThreadItem({ ...snapshot, projection: { ...snapshot.projection, providerSessions: [{ id: "s1", status: "running", capabilities: { turns: { supportsActiveSteering: false, supportsSteeringByInterruptRestart: false } } }] } });
  const run = readActiveRun([{ id: "r1", status: "running", activeAttemptId: "att1", providerThreadId: "pt1" }], "r1");
  expect(deriveSteerState({ data: providerState(), activeRun: run, appThreadId: "t1", activeMessage: undefined }).canPromoteToSteer).toBe(false);
  resetThreadProviderState();
  observeThreadItem({ ...snapshot, projection: { ...snapshot.projection, providerTurns: [] } });
  expect(deriveSteerState({ data: providerState(), activeRun: run, appThreadId: "t1", activeMessage: undefined }).canPromoteToSteer).toBe(false);
});

test("steer by interrupt-restart counts, and a running /compact is promoted past rather than steered into", () => {
  resetThreadProviderState();
  observeThreadItem({ ...snapshot, projection: { ...snapshot.projection, providerSessions: [{ id: "s1", status: "running", capabilities: { turns: { supportsActiveSteering: false, supportsSteeringByInterruptRestart: true } } }] } });
  const run = readActiveRun([{ id: "r1", status: "running", activeAttemptId: "att1", providerThreadId: "pt1" }], "r1");
  expect(deriveSteerState({ data: providerState(), activeRun: run, appThreadId: "t1", activeMessage: undefined }).canPromoteToSteer).toBe(true);
  const compacting = deriveSteerState({ data: { sessions: [], threads: [], turns: [], activeProviderThreadId: null }, activeRun: run, appThreadId: "t1", activeMessage: { body: " /Compact " } });
  expect(compacting).toEqual({ canPromoteToSteer: true, promoteSkipsCompaction: true });
  expect(isCompactionCommand({ body: "/compact", attachments: [{}] })).toBe(false);
});

test("provider turn events update the state and the newest token usage wins", () => {
  resetThreadProviderState();
  observeThreadItem(snapshot);
  observeThreadItem({ kind: "event", event: { type: "provider-turn.updated", payload: { id: "turn1", providerThreadId: "pt1", runAttemptId: "att1", status: "completed", tokenUsage: { usedTokens: 300000, updatedAt: "2026-01-01T01:00:00Z" } } } });
  expect(providerState().turns[0]?.status).toBe("completed");
  expect(latestTokenUsage(providerState())?.usedTokens).toBe(300000);
});

test("resume compaction is offered for a stale Claude thread with a large context", () => {
  const usage = { usedTokens: 250000, maxTokens: null, updatedAt: "2026-01-01T00:00:00Z", promptCacheTtlMs: null };
  const t0 = Date.parse(usage.updatedAt);
  expect(shouldOfferResumeCompaction({ provider: "claudeAgent", usage, now: t0 + 71 * 60_000 })).toBe(true);
  expect(shouldOfferResumeCompaction({ provider: "claudeAgent", usage, now: t0 + 5 * 60_000 })).toBe(false);
  expect(shouldOfferResumeCompaction({ provider: "codex", usage, now: t0 + 71 * 60_000 })).toBe(false);
  expect(shouldOfferResumeCompaction({ provider: "claudeAgent", usage: { ...usage, usedTokens: 1000 }, now: t0 + 71 * 60_000 })).toBe(false);
  expect(formatContextWindowTokens(212_345)).toBe("212k");
  expect(formatContextWindowTokens(1_500_000)).toBe("1.5m");
  expect(formatContextWindowTokens(950)).toBe("950");
});
