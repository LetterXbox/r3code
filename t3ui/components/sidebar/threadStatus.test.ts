import { expect, test } from "nsh/test";
import type { Thread } from "../../store";
import { threadMetaFromShell } from "./threadMeta";
import type { ThreadSidebarMeta } from "./threadMeta";
import {
  adjacentThreadId,
  threadActivityAt,
  threadSettledAt,
  canSnooze,
  hasQueuedTurnStart,
  hasUnseenCompletion,
  isSnoozed,
  isWoke,
  threadWokeAt,
  resolveFolderDot,
  resolveSection,
  resolveThreadStatus,
  resolveThreadStatusPill,
  resolveTopStatus,
  shouldRecede,
  snoozeWakeLabel,
} from "./threadStatus";

const baseMeta: ThreadSidebarMeta = {
  runStatus: "idle", activityRunStatus: null, pendingRequestKind: null, pendingGuestMessageCount: 0,
  blockedOnThreadWait: false, lastErrorClass: null, lastVisitedAt: null, latestRunCompletedAt: null,
  latestRunStartedAt: null, snoozedUntil: null, settled: false, hasActionableProposedPlan: false,
  branch: null, titleRegenerating: false,
};
const thread = (meta: Partial<ThreadSidebarMeta> = {}, extra: Partial<Thread> = {}): Thread => ({
  id: "t", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0, meta: { ...baseMeta, ...meta }, ...extra,
});

test("shell fields become sidebar meta", async () => {
  const meta = threadMetaFromShell({
    status: "running", pendingRuntimeRequest: { kind: "user_input" }, lastVisitedAt: "2026-01-01T00:00:00.000Z",
    settledOverride: "settled", branch: "main", snoozedUntil: "2026-01-02T00:00:00.000Z", pendingGuestMessageCount: 2,
  });
  await expect(meta.runStatus).toBe("running");
  await expect(meta.pendingRequestKind).toBe("user_input");
  await expect(meta.lastVisitedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  await expect(meta.settled).toBe(true);
  await expect(meta.branch).toBe("main");
  await expect(meta.pendingGuestMessageCount).toBe(2);
  await expect(threadMetaFromShell({}).runStatus).toBe("idle");
});

test("status follows resolveSidebarThreadStatus", async () => {
  await expect(resolveThreadStatus(thread({ pendingRequestKind: "command_approval" }))).toBe("approval");
  await expect(resolveThreadStatus(thread({ pendingRequestKind: "user_input" }))).toBe("input");
  await expect(resolveThreadStatus(thread({ pendingGuestMessageCount: 1 }))).toBe("request");
  await expect(resolveThreadStatus(thread({ runStatus: "running", blockedOnThreadWait: true }))).toBe("waiting");
  await expect(resolveThreadStatus(thread({ runStatus: "preparing" }))).toBe("preparing");
  await expect(resolveThreadStatus(thread({ runStatus: "starting" }))).toBe("working");
  await expect(resolveThreadStatus(thread({ runStatus: "failed" }))).toBe("failed");
  await expect(resolveThreadStatus(thread({ runStatus: "failed", lastErrorClass: "usage_limit" }))).toBe("limited");
  await expect(resolveThreadStatus(thread({ runStatus: "completed" }))).toBe("ready");
  await expect(resolveThreadStatus({ ...thread(), meta: undefined, status: "awaiting" })).toBe("approval");
  await expect(resolveThreadStatus({ ...thread(), meta: undefined, status: "running" })).toBe("working");
});

test("the trailing status uses the web's labels", async () => {
  await expect(resolveTopStatus(thread({ runStatus: "preparing" }))?.label).toBe("Setting up");
  await expect(resolveTopStatus(thread({ runStatus: "running" }))?.label).toBe("Working");
  await expect(resolveTopStatus(thread({ runStatus: "running", blockedOnThreadWait: true }))?.label).toBe("Waiting");
  await expect(resolveTopStatus(thread({ pendingRequestKind: "approval" }))?.label).toBe("Approval");
  await expect(resolveTopStatus(thread({ pendingRequestKind: "user_input" }))?.label).toBe("Input");
  await expect(resolveTopStatus(thread({ pendingGuestMessageCount: 1 }))?.label).toBe("Request");
  await expect(resolveTopStatus(thread({ runStatus: "failed", lastErrorClass: "usage_limit" }))?.label).toBe("Limited");
  await expect(resolveTopStatus(thread({ runStatus: "failed" }))?.label).toBe("Failed");
  await expect(resolveTopStatus(thread({ runStatus: "completed" }))).toBeNull();
});

test("Done shows only when the run finished after the last visit", async () => {
  const unread = thread({ runStatus: "completed", latestRunCompletedAt: 200, lastVisitedAt: 100 });
  const read = thread({ runStatus: "completed", latestRunCompletedAt: 200, lastVisitedAt: 300 });
  const never = thread({ runStatus: "completed", latestRunCompletedAt: 200, lastVisitedAt: null });
  await expect(hasUnseenCompletion(unread)).toBe(true);
  await expect(hasUnseenCompletion(read)).toBe(false);
  await expect(hasUnseenCompletion(never)).toBe(false);
  await expect(resolveTopStatus(unread)?.label).toBe("Done");
});

test("quiet rows recede, rows that need you do not", async () => {
  await expect(shouldRecede({ thread: thread({ runStatus: "running" }), active: false })).toBe(true);
  await expect(shouldRecede({ thread: thread({ runStatus: "running" }), active: true })).toBe(false);
  await expect(shouldRecede({ thread: thread({ pendingRequestKind: "user_input" }), active: false })).toBe(false);
  await expect(shouldRecede({ thread: thread(), active: false })).toBe(true);
  await expect(shouldRecede({ thread: thread({ runStatus: "completed", latestRunCompletedAt: 2, lastVisitedAt: 1 }), active: false })).toBe(false);
  await expect(shouldRecede({ thread: thread({ runStatus: "failed" }), active: false })).toBe(false);
});

test("a closed folder dot is the most urgent hidden state", async () => {
  await expect(resolveFolderDot([thread({ runStatus: "running" }), thread({ pendingRequestKind: "approval" })])).toBe("attention");
  await expect(resolveFolderDot([thread({ runStatus: "running" }), thread({ runStatus: "failed" })])).toBe("failed");
  await expect(resolveFolderDot([thread({ runStatus: "completed", latestRunCompletedAt: 2, lastVisitedAt: 1 })])).toBe("unread");
  await expect(resolveFolderDot([thread({ runStatus: "running" })])).toBe("working");
  await expect(resolveFolderDot([thread()])).toBeNull();
  // A usage limit is attention, not Failed; a failed run never reads as unread.
  await expect(resolveFolderDot([thread({ runStatus: "failed", lastErrorClass: "usage_limit" })])).toBe("attention");
  await expect(resolveFolderDot([thread({ runStatus: "failed", latestRunCompletedAt: 2, lastVisitedAt: 1 })])).toBe("failed");
});

test("sections: snoozed beats settled beats pinned", async () => {
  const now = 1_000;
  await expect(resolveSection(thread({ snoozedUntil: 2_000, settled: true }, { pinned: true }), now)).toBe("snoozed");
  await expect(resolveSection(thread({ snoozedUntil: 500, settled: true }, { pinned: true }), now)).toBe("settled");
  await expect(resolveSection(thread({}, { pinned: true }), now)).toBe("pinned");
  await expect(resolveSection(thread(), now)).toBe("active");
  await expect(isSnoozed(thread({ snoozedUntil: 500 }), now)).toBe(false);
});

test("snooze wake label rounds up like snoozeWakeLabel", async () => {
  await expect(snoozeWakeLabel(0, 1)).toBe("now");
  await expect(snoozeWakeLabel(61_000, 0)).toBe("2m");
  await expect(snoozeWakeLabel(3_600_001, 0)).toBe("2h");
  await expect(snoozeWakeLabel(86_400_001, 0)).toBe("2d");
});

test("thread.previous and thread.next stop at the ends", async () => {
  const ids = ["a", "b", "c"];
  await expect(adjacentThreadId(ids, "b", "next")).toBe("c");
  await expect(adjacentThreadId(ids, "b", "previous")).toBe("a");
  await expect(adjacentThreadId(ids, "c", "next")).toBeNull();
  await expect(adjacentThreadId(ids, "a", "previous")).toBeNull();
  await expect(adjacentThreadId(ids, null, "next")).toBe("a");
  await expect(adjacentThreadId(ids, null, "previous")).toBe("c");
  await expect(adjacentThreadId(ids, "zzz", "next")).toBeNull();
  await expect(adjacentThreadId([], null, "next")).toBeNull();
});

test("Woke shows once a snooze ran out, until the thread is visited or settled", async () => {
  const now = 1_000;
  const woke = thread({ snoozedUntil: 500, lastVisitedAt: 100 });
  await expect(threadWokeAt(woke, now)).toBe(500);
  await expect(isWoke(woke, now)).toBe(true);
  await expect(resolveTopStatus(woke, now)?.label).toBe("Woke");
  await expect(resolveTopStatus(woke, now)?.icon).toBe("woke");
  await expect(shouldRecede({ thread: woke, active: false, now })).toBe(false);
  await expect(isWoke(thread({ snoozedUntil: 500, lastVisitedAt: 600 }), now)).toBe(false);
  await expect(isWoke(thread({ snoozedUntil: 500, lastVisitedAt: null }), now)).toBe(true);
  await expect(isWoke(thread({ snoozedUntil: 500, settled: true }), now)).toBe(false);
  await expect(isWoke(thread({ snoozedUntil: 2_000 }), now)).toBe(false);
  await expect(isWoke(thread(), now)).toBe(false);
  await expect(resolveTopStatus(thread({ snoozedUntil: 500, runStatus: "failed" }), now)?.label).toBe("Failed");
});

test("until the server config is loaded a thread is never Snoozed or Settled", async () => {
  const now = 1_000;
  await expect(resolveSection(thread({ settled: true }), now, false)).toBe("active");
  await expect(resolveSection(thread({ snoozedUntil: 2_000 }), now, false)).toBe("active");
  await expect(resolveSection(thread({ settled: true }, { pinned: true }), now, false)).toBe("pinned");
  await expect(resolveSection(thread({ settled: true }), now, true)).toBe("settled");
});

test("a snoozed thread wakes early for an approval, a new question, a guest message or a fresh failure", async () => {
  const snoozed = { snoozedUntil: 10_000, snoozedAt: 1_000 };
  const now = 2_000;
  await expect(isSnoozed(thread(snoozed), now)).toBe(true);
  await expect(isSnoozed(thread({ ...snoozed, pendingRequestKind: "approval" }), now)).toBe(false);
  await expect(isSnoozed(thread({ ...snoozed, pendingGuestMessageCount: 1 }), now)).toBe(false);
  // A question already open at snooze time means ask me later; a newer one wakes the thread.
  await expect(isSnoozed(thread({ ...snoozed, pendingRequestKind: "user_input", pendingRequestAt: 500 }), now)).toBe(true);
  await expect(isSnoozed(thread({ ...snoozed, pendingRequestKind: "user_input", pendingRequestAt: 1_500 }), now)).toBe(false);
  // A failure before the snooze stays hidden, one after it wakes.
  await expect(isSnoozed(thread({ ...snoozed, runStatus: "failed", activityRunStatus: null, latestRunCompletedAt: 500 }), now)).toBe(true);
  await expect(isSnoozed(thread({ ...snoozed, runStatus: "failed", activityRunStatus: null, latestRunCompletedAt: 1_500 }), now)).toBe(false);
});

test("an early wake reads Woke from the moment the request arrived, until the thread is visited", async () => {
  const woken = thread({ snoozedUntil: 10_000, snoozedAt: 1_000, pendingRequestKind: "user_input", pendingRequestAt: 1_500, lastVisitedAt: 1_200 });
  await expect(threadWokeAt(woken, 2_000)).toBe(1_500);
  await expect(isWoke(woken, 2_000)).toBe(true);
  await expect(isWoke(thread({ snoozedUntil: 10_000, snoozedAt: 1_000, pendingRequestKind: "user_input", pendingRequestAt: 1_500, lastVisitedAt: 1_800 }), 2_000)).toBe(false);
  await expect(threadWokeAt(thread({ snoozedUntil: 10_000, snoozedAt: 1_000 }), 2_000)).toBeNull();
});

test("snooze is withheld while a turn is about to start", async () => {
  const now = 100_000;
  await expect(canSnooze(thread(), now)).toBe(true);
  await expect(canSnooze(thread({ pendingGuestMessageCount: 2 }), now)).toBe(false);
  await expect(canSnooze(thread({ pendingRequestKind: "approval" }), now)).toBe(false);
  await expect(canSnooze(thread({ pendingRequestKind: "user_input" }), now)).toBe(true);
  await expect(canSnooze(thread({ runtimeStatus: "starting" }), now)).toBe(false);
  // A message just sent that no run has picked up yet holds the gate; once the grace passes it opens.
  const sent = thread({ latestRunId: null }, { latestUserMessageAt: now - 30_000 });
  await expect(hasQueuedTurnStart(sent, now)).toBe(true);
  await expect(canSnooze(sent, now)).toBe(false);
  await expect(canSnooze(sent, now + 200_000)).toBe(true);
  const adopted = thread({ latestRunId: "r1", latestRunRequestedAt: now - 20_000 }, { latestUserMessageAt: now - 30_000 });
  await expect(hasQueuedTurnStart(adopted, now)).toBe(false);
});

test("a row's time counts from the latest message or run, and a settled row from when it settled", async () => {
  const base = thread({ latestRunRequestedAt: 4_000, latestRunStartedAt: 5_000, latestRunCompletedAt: 6_000 }, { updatedAt: 9_000, latestUserMessageAt: 3_000 });
  await expect(threadActivityAt(base)).toBe(6_000);
  await expect(threadActivityAt(thread({}, { updatedAt: 9_000 }))).toBe(9_000);
  await expect(threadSettledAt(base)).toBe(6_000);
  await expect(threadSettledAt(thread({ settledAt: 8_000, latestRunCompletedAt: 6_000 }, { updatedAt: 9_000 }))).toBe(8_000);
});

test("the palette's leading status pulses for Working and Connecting only (ThreadStatusIndicators.tsx:633-657)", () => {
  const working = resolveThreadStatusPill(thread({ runStatus: "running" }));
  expect([working?.label, working?.pulse]).toEqual(["Working", true]);
  const connecting = resolveThreadStatusPill(thread({ runStatus: "preparing" }));
  expect([connecting?.label, connecting?.pulse]).toEqual(["Connecting", true]);
  const approval = resolveThreadStatusPill(thread({ pendingRequestKind: "approval" }));
  expect([approval?.label, approval?.pulse]).toEqual(["Pending Approval", false]);
  expect(resolveThreadStatusPill(thread({ runStatus: "idle" }))).toBeNull();
});
