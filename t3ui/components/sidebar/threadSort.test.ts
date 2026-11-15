// `sidebarThreadSortOrder` and its two readers: the palette's "latest thread of a project" and the thread that opens after a delete
// (packages/client-runtime threadSort.ts, Sidebar.logic.ts getFallbackThreadIdAfterDelete).
import { expect, test } from "nsh/test";
import { updateSetting } from "../../store";
import type { Thread } from "../../store";
import { fallbackThreadIdAfterDelete, latestThreadOf, sortThreadsBy, threadSortOrder, threadSortTimestamp } from "./threadSort";

const meta = (over: Partial<NonNullable<Thread["meta"]>>): NonNullable<Thread["meta"]> => ({
  runStatus: "idle", activityRunStatus: null, pendingRequestKind: null, pendingGuestMessageCount: 0, blockedOnThreadWait: false, lastErrorClass: null,
  lastVisitedAt: null, latestRunCompletedAt: null, latestRunStartedAt: null, snoozedUntil: null, settled: false, hasActionableProposedPlan: false,
  branch: null, titleRegenerating: false, ...over,
});
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, projectId: "p", title: id, status: "idle", pinned: false, updatedAt: 0, ...over });

test("updated_at orders by the latest user message, created_at by creation", () => {
  const old = thread("old", { createdAt: 10, updatedAt: 500, latestUserMessageAt: 100 });
  const fresh = thread("fresh", { createdAt: 300, updatedAt: 400, latestUserMessageAt: 200 });
  expect(sortThreadsBy([old, fresh], "updated_at").map((item) => item.id)).toEqual(["fresh", "old"]);
  expect(sortThreadsBy([old, fresh], "created_at").map((item) => item.id)).toEqual(["fresh", "old"]);
  const a = thread("a", { createdAt: 900, updatedAt: 50 });
  const b = thread("b", { createdAt: 100, updatedAt: 800 });
  expect(sortThreadsBy([a, b], "updated_at").map((item) => item.id)).toEqual(["b", "a"]);
  expect(sortThreadsBy([a, b], "created_at").map((item) => item.id)).toEqual(["a", "b"]);
  expect(threadSortTimestamp(a, "created_at")).toBe(900);
  expect(threadSortTimestamp(thread("none"), "updated_at")).toBe(Number.NEGATIVE_INFINITY);
});

test("ties break by id, larger first", () => {
  const list = [thread("a", { updatedAt: 5 }), thread("c", { updatedAt: 5 }), thread("b", { updatedAt: 5 })];
  expect(sortThreadsBy(list, "updated_at").map((item) => item.id)).toEqual(["c", "b", "a"]);
  expect(latestThreadOf(list, "updated_at")?.id).toBe("c");
  expect(latestThreadOf([], "updated_at")).toBeNull();
});

test("the saved setting picks the order the readers use; anything else is updated_at", () => {
  expect(threadSortOrder()).toBe("updated_at");
  updateSetting("sidebarThreadSortOrder", "created_at");
  expect(threadSortOrder()).toBe("created_at");
  const recentlyTalked = thread("talked", { createdAt: 10, updatedAt: 900 });
  const recentlyMade = thread("made", { createdAt: 800, updatedAt: 20 });
  expect(latestThreadOf([recentlyTalked, recentlyMade])?.id).toBe("made");
  updateSetting("sidebarThreadSortOrder", "bogus");
  expect(threadSortOrder()).toBe("updated_at");
  expect(latestThreadOf([recentlyTalked, recentlyMade])?.id).toBe("talked");
});

test("the thread after a delete is the project's first listed thread that is not settled, snoozed or deleted too", () => {
  const now = 1_000_000;
  const deleted = thread("gone", { updatedAt: 10 });
  const settled = thread("settled", { updatedAt: 900, meta: meta({ settled: true }) });
  const snoozed = thread("snoozed", { updatedAt: 800, meta: meta({ snoozedUntil: now + 60_000 }) });
  const alsoDeleted = thread("also", { updatedAt: 700 });
  const subagent = thread("child", { updatedAt: 650, relations: { lineage: { relationshipToParent: "subagent" } } as Thread["relations"] });
  const other = thread("other", { projectId: "q", updatedAt: 999 });
  const next = thread("next", { updatedAt: 100 });
  const older = thread("older", { updatedAt: 50 });
  const threads = [deleted, settled, snoozed, alsoDeleted, subagent, other, older, next];
  expect(fallbackThreadIdAfterDelete({ threads, deletedId: "gone", deletedIds: new Set(["also"]), order: "updated_at", now })).toBe("next");
  expect(fallbackThreadIdAfterDelete({ threads, deletedId: "missing", order: "updated_at", now })).toBeNull();
  expect(fallbackThreadIdAfterDelete({ threads: [deleted], deletedId: "gone", order: "updated_at", now })).toBeNull();
});
