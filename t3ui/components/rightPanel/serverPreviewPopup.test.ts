import { expect, test } from "nsh/test";
import { panelKeyFor, panelStateFor } from "./panelState";
import { beginServerTabClose, EMPTY_THREAD_PREVIEW, reconcileList, serverSurfaceId } from "./serverPreviewSessions";
import { applyThreadPreview, showPreviewPopup } from "./serverPreviewSync";

// Contract-shaped PreviewSessionSnapshot / PreviewListResult.
const snap = (tabId: string) => ({ ...base(tabId) });
const base = (tabId: string) => ({
  threadId: "t1", tabId, navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
  canGoBack: false, canGoForward: false, runtime: "server", headless: true, reveal: true, updatedAt: "2026-11-12T10:00:00.000Z",
});

test("fm13: a page popup becomes the open panel's front tab once its session is listed", () => {
  applyThreadPreview("t1", reconcileList(EMPTY_THREAD_PREVIEW, { sessions: [snap("a")], serverEpoch: "E1", revision: 1 }), { autoShowFloatingPreview: false });
  showPreviewPopup("t1", "pop");
  expect(panelStateFor(panelKeyFor("t1")).activeId).not.toBe(serverSurfaceId("pop"));
  applyThreadPreview("t1", reconcileList(EMPTY_THREAD_PREVIEW, { sessions: [snap("a"), snap("pop")], serverEpoch: "E1", revision: 2 }), { autoShowFloatingPreview: false });
  const state = panelStateFor(panelKeyFor("t1"));
  expect(state.open).toBe(true);
  expect(state.activeId).toBe(serverSurfaceId("pop"));
});

test("fm13: a server tab this client is closing stays out of the panel against a stale list, until the server drops it", () => {
  const list = (ids: string[], revision: number) => reconcileList(EMPTY_THREAD_PREVIEW, { sessions: ids.map((id) => ({ ...snap(id), threadId: "t2" })), serverEpoch: "E1", revision });
  applyThreadPreview("t2", list(["k", "gone"], 1), { autoShowFloatingPreview: false });
  beginServerTabClose("t2", "gone");
  applyThreadPreview("t2", list(["k", "gone"], 2), { autoShowFloatingPreview: false });
  expect(panelStateFor(panelKeyFor("t2")).surfaces.map((s) => s.id)).toEqual([serverSurfaceId("k")]);
  applyThreadPreview("t2", list(["k"], 3), { autoShowFloatingPreview: false });
  applyThreadPreview("t2", list(["k", "gone"], 4), { autoShowFloatingPreview: false });
  expect(panelStateFor(panelKeyFor("t2")).surfaces.map((s) => s.id)).toEqual([serverSurfaceId("k"), serverSurfaceId("gone")]);
});
