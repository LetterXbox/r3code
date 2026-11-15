import { expect, test } from "nsh/test";
import { lastInvokedScriptId, rememberInvokedScript } from "./lastInvokedScript";
import { queueTerminalLaunch, takeTerminalLaunch } from "../terminal/pendingInput";

test("the last script run in a project is remembered per project", () => {
  rememberInvokedScript("p1", "dev");
  rememberInvokedScript("p2", "test");
  expect(lastInvokedScriptId("p1")).toBe("dev");
  expect(lastInvokedScriptId("p2")).toBe("test");
  expect(lastInvokedScriptId(null)).toBe(null);
});

test("a script's launch options wait for its terminal's first attach, once", () => {
  queueTerminalLaunch("t", "term-2", { stopOnSettle: true });
  expect(takeTerminalLaunch("t", "term-2")).toEqual({ stopOnSettle: true });
  expect(takeTerminalLaunch("t", "term-2")).toEqual({});
});

test("a script reuses an idle drawer terminal, the active one first (findReusableProjectScriptTerminal)", async () => {
  const { findReusableProjectScriptTerminal } = await import("./projectScriptRun");
  expect(findReusableProjectScriptTerminal({ drawerTerminalIds: ["a", "b"], activeTerminalId: "b", runningTerminalIds: [] })).toBe("b");
  expect(findReusableProjectScriptTerminal({ drawerTerminalIds: ["a", "b"], activeTerminalId: "b", runningTerminalIds: ["b"] })).toBe("a");
  expect(findReusableProjectScriptTerminal({ drawerTerminalIds: ["a"], activeTerminalId: "a", runningTerminalIds: ["a"] })).toBe(null);
});
