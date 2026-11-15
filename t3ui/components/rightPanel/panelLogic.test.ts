import { expect, test } from "nsh/test";
import {
  PANEL_DEFAULT_WIDTH, mintTerminalId, fileSurfaceId, openFileSurface, surfaceTitle, PANEL_MIN_WIDTH, activateSurface, clampPanelWidth, closeAllSurfaces, closeOtherSurfaces,
  closeSurface, closeSurfacesToRight, initialPanelState, openSurface, panelMaxWidth, readPanelState,
  toggleMaximized, toggleRightPanel, toggleSurface, pullRequestPanelWidth,
} from "./panelLogic";

test("opening a surface adds the tab, activates it and shows the panel", () => {
  const diff = openSurface(initialPanelState, "diff");
  expect(diff.open).toBe(true);
  expect(diff.activeId).toBe("diff");
  const files = openSurface(diff, "files");
  expect(files.surfaces.map((surface) => surface.id)).toEqual(["diff", "files"]);
  expect(files.activeId).toBe("files");
  expect(openSurface(files, "diff").surfaces.length).toBe(2);
});

test("diff.toggle closes the showing diff, otherwise opens it", () => {
  const open = toggleSurface(initialPanelState, "diff");
  expect(open.open && open.activeId === "diff").toBe(true);
  const closed = toggleSurface(open, "diff");
  expect(closed.surfaces).toEqual([]);
  expect(closed.open).toBe(true);
  const other = toggleSurface(openSurface(open, "files"), "diff");
  expect(other.activeId).toBe("diff");
  const hidden = toggleSurface(toggleRightPanel(open), "diff");
  expect(hidden.open).toBe(true);
});

test("closing the active tab activates its neighbour", () => {
  const state = openSurface(openSurface(initialPanelState, "diff"), "files");
  const closedActive = closeSurface(state, "files");
  expect(closedActive.activeId).toBe("diff");
  const closedOther = closeSurface(state, "diff");
  expect(closedOther.activeId).toBe("files");
  expect(closeSurface(closedOther, "files").activeId).toBe(null);
  expect(closeSurface(closedOther, "files").open).toBe(true);
});

test("close others, to the right and all", () => {
  const state = openSurface(openSurface(initialPanelState, "diff"), "files");
  expect(closeOtherSurfaces(state, "diff").surfaces.map((surface) => surface.id)).toEqual(["diff"]);
  expect(closeOtherSurfaces(state, "diff").activeId).toBe("diff");
  expect(closeSurfacesToRight(state, "diff").surfaces.map((surface) => surface.id)).toEqual(["diff"]);
  expect(closeAllSurfaces(state).surfaces).toEqual([]);
  expect(activateSurface(state, "diff").activeId).toBe("diff");
});

test("maximize needs an open panel with a tab and clears when it hides", () => {
  expect(toggleMaximized(initialPanelState).maximized).toBe(false);
  const state = toggleMaximized(openSurface(initialPanelState, "diff"));
  expect(state.maximized).toBe(true);
  expect(toggleRightPanel(state).maximized).toBe(false);
});

test("panel width stays between 360 and 70% of the window", () => {
  expect(panelMaxWidth(1000)).toBe(700);
  expect(panelMaxWidth(1000, 800)).toBe(440);
  expect(panelMaxWidth(1000, 600)).toBe(PANEL_MIN_WIDTH);
  expect(panelMaxWidth(2000, 1500)).toBe(1140);
  expect(clampPanelWidth(100, 700)).toBe(PANEL_MIN_WIDTH);
  expect(clampPanelWidth(900, 700)).toBe(700);
  expect(clampPanelWidth(Number.NaN, 700)).toBe(PANEL_DEFAULT_WIDTH);
});

test("PR details default to half the window while retaining room for the list", () => {
  expect(pullRequestPanelWidth(800, 1600, 1300)).toBe(800);
  expect(pullRequestPanelWidth(800, 1600, 1000)).toBe(640);
  expect(pullRequestPanelWidth(500, 1000, 300)).toBe(300);
});

test("stored state is read defensively", () => {
  expect(readPanelState(null)).toEqual(initialPanelState);
  const read = readPanelState({ open: true, surfaces: [{ kind: "files" }, { kind: "bogus" }, { kind: "files" }], activeId: "diff", width: 600, maximized: true, terminalOpen: true });
  expect(read.surfaces).toEqual([{ id: "files", kind: "files" }]);
  expect(read.activeId).toBe("files");
  expect(read.width).toBe(600);
  expect(read.maximized).toBe(true);
  expect(read.terminalOpen).toBe(true);
  expect(read.detailsOpen).toBe(false);
});

test("a file opens as its own tab titled by its file name", () => {
  const files = openSurface(initialPanelState, "files");
  const file = openFileSurface(files, "src/app/main.ts");
  expect(file.surfaces.map((surface) => surface.id)).toEqual(["files", "file:src/app/main.ts"]);
  expect(file.activeId).toBe(fileSurfaceId("src/app/main.ts"));
  expect(surfaceTitle(file.surfaces[1]!)).toBe("main.ts");
  expect(openFileSurface(file, "src/app/main.ts").surfaces.length).toBe(2);
  expect(closeSurface(file, "file:src/app/main.ts").activeId).toBe("files");
  const read = readPanelState({ surfaces: [{ kind: "file", relativePath: "a/b.txt" }, { kind: "file" }], activeId: "file:a/b.txt" });
  expect(read.surfaces).toEqual([{ id: "file:a/b.txt", kind: "file", relativePath: "a/b.txt" }]);
  expect(read.activeId).toBe("file:a/b.txt");
});

import { CHAT_COLUMN_MIN_WIDTH, chatColumnWidth } from "./panelLogic";

test("at a 1280pt window the chat column keeps the reference minimum for any panel width", () => {
  for (const sidebar of [208, 256, 400, 560]) {
    const row = 1280 - sidebar;
    const max = panelMaxWidth(1280, row);
    for (const stored of [PANEL_DEFAULT_WIDTH, 700, 1000, 4000, Infinity, Number.NaN]) {
      const width = clampPanelWidth(stored, max);
      expect(chatColumnWidth(row, width)).toBeGreaterThanOrEqual(CHAT_COLUMN_MIN_WIDTH);
    }
  }
  expect(PANEL_DEFAULT_WIDTH).toBe(540);
  expect(PANEL_MIN_WIDTH).toBe(360);
});

test("a persisted width that violates the clamps is corrected on load", () => {
  const max = panelMaxWidth(1280 - 256);
  expect(readPanelState({ width: 4000 }, max).width).toBe(max);
  expect(readPanelState({ width: 10 }, max).width).toBe(PANEL_MIN_WIDTH);
  expect(readPanelState({ width: "wide" }, max).width).toBe(PANEL_DEFAULT_WIDTH);
  expect(max).toBeLessThanOrEqual(Math.floor(1024 * 0.7));
});

test("a file opened at a line remembers it, and reopening without a line clears it", () => {
  const at = openFileSurface(initialPanelState, "src/a.ts", 42);
  expect(at.surfaces[0]!.line).toBe(42);
  const moved = openFileSurface(at, "src/a.ts", 7);
  expect(moved.surfaces.length).toBe(1);
  expect(moved.surfaces[0]!.line).toBe(7);
  expect(openFileSurface(moved, "src/a.ts").surfaces[0]!.line).toBeUndefined();
  expect(openFileSurface(initialPanelState, "src/a.ts", -3).surfaces[0]!.line).toBeUndefined();
});

test("panel terminal ids skip numbers the drawer, panel and server already use, and carry a suffix when asked", () => {
  const state = { ...readPanelState({ surfaces: [{ kind: "terminal", terminalIds: ["term-1"] }] }) };
  expect(mintTerminalId(state, ["term-2-0f8fad5b-d9cb-469f-a165-70867728950e", "term-3"])).toBe("term-4");
  // nextTerminalId only reads a UUID tail as a suffix; "term-2-abc" is not terminal 2.
  expect(mintTerminalId(state, ["term-2-abc"])).toBe("term-2");
  expect(mintTerminalId(state, [], "x1")).toBe("term-2-x1");
  expect(readPanelState({ surfaces: [{ kind: "terminal", terminalIds: ["term-5-ab12"] }] }).surfaces[0]!.terminalIds).toEqual(["term-5-ab12"]);
});
