import { expect, test } from "nsh/test";
import { dragTargetIndex, initialPanelState, moveSurface, openFileSurface, openSurface, panelSheetWidth, usesPanelSheet } from "./panelLogic";
import { resizedSize } from "./liveResize";

const three = openFileSurface(openSurface(openSurface(initialPanelState, "diff"), "files"), "a.ts");

test("moveSurface reorders tabs like rightPanelStore.moveSurface", () => {
  expect(moveSurface(three, "diff", 2).surfaces.map((s) => s.id)).toEqual(["files", "file:a.ts", "diff"]);
  expect(moveSurface(three, "file:a.ts", 0).surfaces.map((s) => s.id)).toEqual(["file:a.ts", "diff", "files"]);
  expect(moveSurface(three, "diff", 0)).toBe(three);
  expect(moveSurface(three, "missing", 1)).toBe(three);
  expect(moveSurface(three, "diff", 9)).toBe(three);
});

test("a dragged tab lands on the tab whose centre is nearest", () => {
  const slots = [{ id: "diff", x: 0, width: 50 }, { id: "files", x: 54, width: 60 }, { id: "file:a.ts", x: 118, width: 70 }];
  expect(dragTargetIndex(slots, "diff", 10)).toBeNull();
  expect(dragTargetIndex(slots, "diff", 60)).toBe(1);
  expect(dragTargetIndex(slots, "diff", 200)).toBe(2);
  expect(dragTargetIndex(slots, "file:a.ts", -150)).toBe(0);
  expect(dragTargetIndex(slots, "nope", 20)).toBeNull();
});

test("narrow windows show the panel as a sheet, the maximized panel never", () => {
  expect(usesPanelSheet(980, false)).toBe(true);
  expect(usesPanelSheet(981, false)).toBe(false);
  expect(usesPanelSheet(700, true)).toBe(false);
  expect(panelSheetWidth(900)).toBe(378);
  expect(panelSheetWidth(980)).toBe(412);
  expect(panelSheetWidth(700)).toBe(384);
  expect(panelSheetWidth(400)).toBe(352);
});

test("a drag follows the pointer, signed by direction and clamped", () => {
  const clamp = (n: number) => Math.max(100, Math.min(n, 500));
  expect(resizedSize({ start: 300, startPointer: 800, pointer: 750, direction: -1, clamp })).toBe(350);
  expect(resizedSize({ start: 300, startPointer: 800, pointer: 0, direction: -1, clamp })).toBe(500);
  expect(resizedSize({ start: 300, startPointer: 400, pointer: 450, direction: 1, clamp })).toBe(350);
  expect(resizedSize({ start: 300, startPointer: 400, pointer: 0, direction: 1, clamp })).toBe(100);
});

test("fm13: useResizeDrag's 2 px threshold: a release that travelled 2 px or less commits nothing", async () => {
  const { createLiveResize, resizeMoved } = await import("./liveResize");
  expect(resizeMoved(2)).toBe(false);
  expect(resizeMoved(-3)).toBe(true);
  const commits: number[] = [];
  const resize = createLiveResize({ axis: "x", direction: 1, size: () => 400, clamp: (size) => size, commit: (size) => commits.push(size) });
  resize.handle.onPanStart({ cancelled: false, translation: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
  resize.handle.onPanEnd({ cancelled: false, translation: { x: 2, y: 0 }, velocity: { x: 0, y: 0 } });
  expect(commits).toEqual([]);
  resize.handle.onPanStart({ cancelled: false, translation: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
  resize.handle.onPanEnd({ cancelled: false, translation: { x: 30, y: 0 }, velocity: { x: 0, y: 0 } });
  expect(commits).toEqual([430]);
});
