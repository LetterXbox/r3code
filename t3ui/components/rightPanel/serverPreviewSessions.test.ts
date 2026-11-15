import { expect, test } from "nsh/test";
import { applyEvent, EMPTY_THREAD_PREVIEW, freshlyRevealed, panelServerTabs, reconcileList, reconcileServerSurfaces, serverSurfaceId } from "./serverPreviewSessions";

// Contract-shaped (packages/contracts/src/preview.ts PreviewSessionSnapshot / PreviewListResult / PreviewEvent).
const snap = (tabId: string, over: Record<string, unknown> = {}) => ({
  threadId: "t1", tabId, navStatus: { _tag: "Success", url: "https://example.com/", title: "Example Domain" },
  canGoBack: false, canGoForward: false, runtime: "server", headless: true, reveal: true, updatedAt: "2026-11-12T10:00:00.000Z", ...over,
});
const list = (sessions: unknown[], revision = 1) => ({ sessions, serverEpoch: "E1", revision });

test("the first list is the baseline: nothing is freshly revealed by it, a later opened event is", () => {
  const first = reconcileList(EMPTY_THREAD_PREVIEW, list([snap("a")]));
  expect(first.listLoaded).toBe(true);
  expect(freshlyRevealed(EMPTY_THREAD_PREVIEW, first)).toEqual([]);
  const next = applyEvent(first, { type: "opened", threadId: "t1", tabId: "b", createdAt: "x", serverEpoch: "E1", revision: 2, snapshot: snap("b") });
  if (next === "relist") throw new Error("unexpected relist");
  expect(freshlyRevealed(first, next).map((s) => s.tabId)).toEqual(["b"]);
  // A reveal request with a new id reveals an existing tab again; a desktop tab never does.
  const again = applyEvent(next, { type: "navigated", threadId: "t1", tabId: "a", createdAt: "x", serverEpoch: "E1", revision: 3, snapshot: snap("a", { revealRequest: { id: "r1", force: true } }) });
  if (again === "relist") throw new Error("unexpected relist");
  expect(freshlyRevealed(next, again).map((s) => s.tabId)).toEqual(["a"]);
  expect(applyEvent(again, { type: "closed", threadId: "t1", tabId: "x", createdAt: "x", serverEpoch: "E2", revision: 1 })).toBe("relist");
});

test("closed and failed events, and stale revisions", () => {
  const base = reconcileList(EMPTY_THREAD_PREVIEW, list([snap("a"), snap("b")], 5));
  expect(reconcileList(base, list([], 4))).toBe(base);
  const failed = applyEvent(base, { type: "failed", threadId: "t1", tabId: "a", createdAt: "y", serverEpoch: "E1", revision: 6, url: "https://x/", title: "", code: -105, description: "NAME_NOT_RESOLVED" });
  if (failed === "relist") throw new Error();
  expect(failed.sessions.a!.navStatus._tag).toBe("LoadFailed");
  const closed = applyEvent(failed, { type: "closed", threadId: "t1", tabId: "b", createdAt: "y", serverEpoch: "E1", revision: 7 });
  if (closed === "relist") throw new Error();
  expect(Object.keys(closed.sessions)).toEqual(["a"]);
});

test("server tabs become panel tabs (reveal:false ones do not); ended ones go and a last one closes the panel", () => {
  const state = reconcileList(EMPTY_THREAD_PREVIEW, list([snap("a"), snap("h", { reveal: false }), snap("d", { runtime: "desktop" })]));
  const panel = { open: true, activeId: "browser:1", surfaces: [{ id: "browser:1", kind: "preview" }] };
  const withTab = reconcileServerSurfaces(panel, panelServerTabs(state));
  expect(withTab.surfaces.map((s) => s.id)).toEqual(["browser:1", serverSurfaceId("a")]);
  expect(withTab.surfaces[1]).toEqual({ id: "server-preview:a", kind: "preview", serverTabId: "a", previewUrl: "https://example.com/" });
  expect(withTab.activeId).toBe("browser:1");
  const onlyServer = { open: true, activeId: "server-preview:a", surfaces: [withTab.surfaces[1]!] };
  const ended = reconcileServerSurfaces(onlyServer, []);
  expect(ended.surfaces).toEqual([]);
  expect(ended.open).toBe(false);
});
