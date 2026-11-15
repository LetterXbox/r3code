import { expect, test } from "nsh/test";
import { initialDrawerState, newTerminal, splitTerminal } from "./terminalLogic";
import { allocationFor, canLaunchTerminal } from "./terminalAllocation";
import { overrideSessionScope } from "../../backend/sessionScopes";

test("new terminal ids skip the server's known sessions and the drawer's own", () => {
  const state = initialDrawerState();
  const next = newTerminal(state, { used: ["term-2", "terminal-3-0f8fad5b-d9cb-469f-a165-70867728950e"] });
  expect(next.activeTerminalId).toBe("term-4");
  expect(splitTerminal(next, "horizontal", { used: ["term-5"] }).activeTerminalId).toBe("term-6");
  expect(newTerminal(state, { suffix: "u" }).activeTerminalId).toBe("term-2-u");
  // A non-UUID tail is not a terminal number (terminalLabels.ts terminalNumber).
  expect(newTerminal(state, { used: ["term-2-abc"] }).activeTerminalId).toBe("term-2");
});

test("without terminal:read ids get a random suffix; terminal:operate gates launching", () => {
  overrideSessionScope("terminal:read", "denied");
  expect(allocationFor("t", () => "rand").suffix).toBe("rand");
  overrideSessionScope("terminal:read", "granted");
  expect(allocationFor("t", () => "rand", () => true).suffix).toBe(undefined);
  // A new server session whose terminal list has not arrived yet: unseen sessions may exist, so suffix.
  expect(allocationFor("t", () => "rand", () => false).suffix).toBe("rand");
  overrideSessionScope("terminal:operate", "denied");
  expect(canLaunchTerminal()).toBe(false);
  overrideSessionScope("terminal:operate", "granted");
  expect(canLaunchTerminal()).toBe(true);
  overrideSessionScope("terminal:read", null);
  overrideSessionScope("terminal:operate", null);
});
