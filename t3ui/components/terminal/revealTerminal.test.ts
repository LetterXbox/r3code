import { expect, test } from "nsh/test";
import { initialPanelState } from "../rightPanel/panelLogic";
import { emptyDrawerState } from "./terminalLogic";
import { revealTerminal } from "./revealTerminal";

test("revealing a running terminal selects its side-panel tab", () => {
  const panel = { ...initialPanelState, surfaces: [{ id: "terminal:one", kind: "terminal" as const, terminalIds: ["one", "two"], activeTerminalId: "one" }] };
  const result = revealTerminal(panel, emptyDrawerState(), "two");
  expect(result.panel.open).toBe(true);
  expect(result.panel.activeId).toBe("terminal:one");
  expect(result.panel.surfaces[0]?.activeTerminalId).toBe("two");
  expect(result.panel.terminalOpen).toBe(false);
});

test("revealing a terminal missing from the drawer adds and selects it", () => {
  const result = revealTerminal(initialPanelState, emptyDrawerState(), "term-9");
  expect(result.panel.terminalOpen).toBe(true);
  expect(result.drawer.activeTerminalId).toBe("term-9");
  expect(result.drawer.groups[0]?.terminalIds).toEqual(["term-9"]);
});
