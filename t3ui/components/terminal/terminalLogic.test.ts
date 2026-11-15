import { expect, test } from "nsh/test";
import {
  MAX_TERMINALS_PER_GROUP, activateTerminal, allTerminalIds, clampTerminalHeight, closeTerminal, emptyDrawerState, hasReachedSplitLimit,
  initialDrawerState, newTerminal, readDrawerState, splitTerminal, terminalActionLabels, terminalFontMessage, terminalLabel, terminalRendererFont,
} from "./terminalLogic";

test("the drawer starts with the terminal earlier builds used", () => {
  const state = initialDrawerState();
  expect(allTerminalIds(state)).toEqual(["term-1"]);
  expect(state.activeTerminalId).toBe("term-1");
  expect(terminalLabel("term-3")).toBe("Terminal 3");
  expect(terminalLabel("default")).toBe("default");
});

test("new terminals get their own group; splits join the active group up to four", () => {
  let state = newTerminal(initialDrawerState());
  expect(state.groups.length).toBe(2);
  expect(state.activeTerminalId).toBe("term-2");
  state = splitTerminal(state, "vertical");
  expect(state.groups[1]?.terminalIds).toEqual(["term-2", "term-3"]);
  expect(state.groups[1]?.splitDirection).toBe("vertical");
  expect(state.activeTerminalId).toBe("term-3");
  state = splitTerminal(splitTerminal(state, "horizontal"), "horizontal");
  expect(state.groups[1]?.terminalIds.length).toBe(MAX_TERMINALS_PER_GROUP);
  expect(hasReachedSplitLimit(state)).toBe(true);
  expect(splitTerminal(state, "horizontal")).toBe(state);
  expect(terminalActionLabels(state).split).toBe("Split Terminal Horizontally (max 4 per group)");
  expect(terminalActionLabels(initialDrawerState(), { create: "⌘N", close: "⌘W" }).create).toBe("New Terminal (⌘N)");
  expect(terminalActionLabels(initialDrawerState(), { split: "⌘D" }).split).toBe("Split Terminal Horizontally (⌘D)");
});

test("closing activates a neighbour and the last close leaves an empty drawer", () => {
  let state = splitTerminal(newTerminal(initialDrawerState()), "horizontal");
  state = closeTerminal(state, "term-3");
  expect(state.activeTerminalId).toBe("term-2");
  state = closeTerminal(state, "term-2");
  expect(state.groups.length).toBe(1);
  expect(state.activeTerminalId).toBe("term-1");
  state = closeTerminal(state, "term-1");
  expect(state.groups).toEqual([]);
  expect(state.activeTerminalId).toBe(null);
  expect(newTerminal(state).activeTerminalId).toBe("term-4");
  expect(activateTerminal(initialDrawerState(), "nope").activeTerminalId).toBe("term-1");
});

test("height is clamped and stored state is read defensively", () => {
  // The web floors the drawer at 180 px (MIN_DRAWER_HEIGHT); the old 160 was not its value.
  expect(clampTerminalHeight(50, 800)).toBe(180);
  expect(clampTerminalHeight(900, 800)).toBe(600);
  expect(clampTerminalHeight(Number.NaN, 800)).toBe(280);
  expect(readDrawerState(null).activeTerminalId).toBe("term-1");
  expect(readDrawerState({ groups: [] }).groups).toEqual([]);
  const read = readDrawerState({ groups: [{ id: "g", terminalIds: ["term-4", "bad", "term-5"], splitDirection: "vertical" }], activeTerminalId: "term-5", height: 300 });
  expect(read.groups[0]?.terminalIds).toEqual(["term-4", "term-5"]);
  expect(read.activeTerminalId).toBe("term-5");
  expect(read.counter).toBe(6);
  expect(read.height).toBe(300);
  expect(emptyDrawerState().groups).toEqual([]);
});

test("the font message carries the Terminal font preference, with defaults for unset values", () => {
  expect(terminalFontMessage(" JetBrains Mono ", 14)).toEqual({ type: "font", family: "JetBrains Mono", size: 14 });
  expect(terminalFontMessage("", undefined)).toEqual({ type: "font", family: "", size: 12 });
  expect(terminalFontMessage(3, -2).size).toBe(12);
});

test("the renderer takes its size from the typography style and its family only when one was chosen", () => {
  expect(terminalRendererFont({ fontSize: 15 }, null)).toEqual({ type: "font", family: "", size: 15 });
  expect(terminalRendererFont({ fontSize: 11 }, '"Fira Code"')).toEqual({ type: "font", family: '"Fira Code"', size: 11 });
});

test("the composer's room comes off the drawer's budget, which can cap it below the minimum", async () => {
  const { drawerHeightBudget } = await import("./terminalLayoutBudget");
  expect(drawerHeightBudget(0, 100)).toBeUndefined();
  expect(drawerHeightBudget(700, 150)).toBe(550);
  expect(drawerHeightBudget(100, 150)).toBe(0);
  expect(clampTerminalHeight(400, 800, 550)).toBe(400);
  expect(clampTerminalHeight(500, 800, 300)).toBe(300);
  expect(clampTerminalHeight(500, 800, 100)).toBe(100);
  expect(clampTerminalHeight(50, 800, 550)).toBe(180);
  expect(clampTerminalHeight(900, 800, 700)).toBe(600);
});
