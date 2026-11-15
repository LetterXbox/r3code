// The floating preview's store (previewMiniPlayerStore.ts) and when the card shows (shouldRenderPreviewMiniPlayer).
import { expect, test } from "nsh/test";
import { closeMini, moveMini, openMini, pruneMini, resizeMini, shouldRenderMiniPlayer, type MiniPlayerStore } from "./miniPlayerState";

const empty: MiniPlayerStore = {};

test("opening floats a tab with no place or width yet, last interaction drag", () => {
  const store = openMini(empty, "t1", "browser:1");
  expect(store.t1).toEqual({ tabId: "browser:1", position: null, width: null, lastInteraction: "drag" });
  // Opening the tab that already floats changes nothing.
  expect(openMini(store, "t1", "browser:1")).toBe(store);
});

test("another tab of the same thread takes over the place and size", () => {
  let store = openMini(empty, "t1", "browser:1");
  store = resizeMini(store, "t1", "browser:1", 400, { x: 20, y: 30 });
  store = openMini(store, "t1", "browser:2");
  expect(store.t1).toEqual({ tabId: "browser:2", position: { x: 20, y: 30 }, width: 400, lastInteraction: "resize" });
});

test("each thread has its own floating tab", () => {
  let store = openMini(empty, "t1", "browser:1");
  store = openMini(store, "t2", "browser:1");
  store = moveMini(store, "t2", "browser:1", { x: 5, y: 6 });
  expect(store.t1?.position).toBe(null);
  expect(store.t2?.position).toEqual({ x: 5, y: 6 });
  store = closeMini(store, "t1");
  expect(Object.keys(store)).toEqual(["t2"]);
  expect(closeMini(store, "t1")).toBe(store);
});

test("a move or resize for a tab that no longer floats is dropped", () => {
  const store = openMini(empty, "t1", "browser:2");
  expect(moveMini(store, "t1", "browser:1", { x: 1, y: 1 })).toBe(store);
  expect(resizeMini(store, "t1", "browser:1", 300)).toBe(store);
  expect(moveMini(empty, "t1", "browser:1", { x: 1, y: 1 })).toBe(empty);
});

test("a move records a drag, a resize records a resize and may move", () => {
  let store = openMini(empty, "t1", "browser:1");
  store = moveMini(store, "t1", "browser:1", { x: 10, y: 20 });
  expect(store.t1).toEqual({ tabId: "browser:1", position: { x: 10, y: 20 }, width: null, lastInteraction: "drag" });
  expect(moveMini(store, "t1", "browser:1", { x: 10, y: 20 })).toBe(store);
  store = resizeMini(store, "t1", "browser:1", 360);
  expect(store.t1).toEqual({ tabId: "browser:1", position: { x: 10, y: 20 }, width: 360, lastInteraction: "resize" });
  expect(resizeMini(store, "t1", "browser:1", 360)).toBe(store);
  store = resizeMini(store, "t1", "browser:1", 360, { x: 4, y: 20 });
  expect(store.t1?.position).toEqual({ x: 4, y: 20 });
  // A move after a resize is a drag again.
  expect(moveMini(store, "t1", "browser:1", { x: 4, y: 20 }).t1?.lastInteraction).toBe("drag");
});

test("a closed tab stops floating", () => {
  const store = openMini(empty, "t1", "browser:1");
  expect(pruneMini(store, "t1", ["browser:1", "browser:2"])).toBe(store);
  expect(pruneMini(store, "t1", ["browser:2"])).toEqual({});
  expect(pruneMini(store, "t2", [])).toBe(store);
});

test("the card shows unless the open panel shows that very tab", () => {
  expect(shouldRenderMiniPlayer(null, null)).toBe(false);
  // Panel closed.
  expect(shouldRenderMiniPlayer("browser:1", null)).toBe(true);
  // Panel open on the floating tab: it is in the panel, not floating.
  expect(shouldRenderMiniPlayer("browser:1", "browser:1")).toBe(false);
  // Panel open on another tab: the card floats beside the panel.
  expect(shouldRenderMiniPlayer("browser:1", "files")).toBe(true);
  expect(shouldRenderMiniPlayer("browser:1", "browser:2")).toBe(true);
});
