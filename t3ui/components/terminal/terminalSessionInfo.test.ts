import { expect, test } from "nsh/test";
import { terminalThemeMessage, TERMINAL_PALETTES } from "./terminalTheme";
import { createExitWatcher, forgetTerminalSession, getTerminalLabel, noteTerminalSession, resolveTerminalSessionLabel, runningTerminalIds, terminalSessionGrid, terminalSessionLabel } from "./terminalSessionInfo";

test("a tab is titled by the shell, else by its number", () => {
  expect(getTerminalLabel("term-3")).toBe("Terminal 3");
  expect(getTerminalLabel("terminal-12")).toBe("Terminal 12");
  expect(getTerminalLabel("term-2-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")).toBe("Terminal 2");
  expect(getTerminalLabel("build")).toBe("build");
  expect(resolveTerminalSessionLabel("term-1", "  zsh  ")).toBe("zsh");
  expect(resolveTerminalSessionLabel("term-1", "   ")).toBe("Terminal 1");
  expect(resolveTerminalSessionLabel("term-1", undefined)).toBe("Terminal 1");
});

test("the snapshot and activity events keep a terminal's title, running state and grid", () => {
  expect(terminalSessionLabel("thread-a", "term-1")).toBe("Terminal 1");
  noteTerminalSession("thread-a", "term-1", { label: "vim notes.md", hasRunningSubprocess: true, cols: 100, rows: 30 });
  expect(terminalSessionLabel("thread-a", "term-1")).toBe("vim notes.md");
  expect(runningTerminalIds("thread-a")).toEqual(["term-1"]);
  expect(terminalSessionGrid("thread-a", "term-1")).toEqual({ cols: 100, rows: 30 });
  // An event that omits a field keeps its last value; another thread's terminals are separate.
  noteTerminalSession("thread-a", "term-1", { hasRunningSubprocess: false });
  expect(terminalSessionLabel("thread-a", "term-1")).toBe("vim notes.md");
  expect(runningTerminalIds("thread-a")).toEqual([]);
  expect(terminalSessionGrid("thread-a", "term-1")).toEqual({ cols: 100, rows: 30 });
  expect(terminalSessionLabel("thread-b", "term-1")).toBe("Terminal 1");
  // A grid side that is not a positive number is ignored.
  noteTerminalSession("thread-a", "term-1", { cols: 0, rows: "x" });
  expect(terminalSessionGrid("thread-a", "term-1")).toEqual({ cols: 100, rows: 30 });
  forgetTerminalSession("thread-a", "term-1");
  expect(terminalSessionLabel("thread-a", "term-1")).toBe("Terminal 1");
  expect(terminalSessionGrid("thread-a", "term-1")).toBeNull();
});

test("the theme message carries the 16 colours of the scheme's palette and the selection colour", () => {
  const tokens = { background: "#17212b", foreground: "#fffaff", cursor: "#70b9ee", selection: "#36566f" };
  const dark = terminalThemeMessage(tokens, "dark");
  expect(dark).toMatchObject({ type: "theme", background: "#17212b", selection: "#36566f" });
  expect(dark.palette.length).toBe(16);
  expect(dark.palette[2]).toBe("#0dbc79");
  expect(terminalThemeMessage(tokens, "light").palette[2]).toBe("#107c10");
  expect(TERMINAL_PALETTES.light.length).toBe(16);
  expect(terminalThemeMessage({ background: "#000000", foreground: "#ffffff", cursor: "#ffffff" }, "dark").selection).toBe("");
});

test("a session that ends is noticed once, also when it had already ended at attach, and a restart arms the next end", () => {
  const ended: string[] = [];
  const watcher = createExitWatcher((status) => ended.push(status));
  watcher.sync("running");
  watcher.sync("exited");
  watcher.sync("exited");
  expect(ended).toEqual(["exited"]);
  watcher.sync("running");
  watcher.sync("closed");
  expect(ended).toEqual(["exited", "closed"]);
  // Attached to a session that had already exited: its first status differs from the initial "closed".
  const late = createExitWatcher((status) => ended.push(`late:${status}`));
  late.sync("exited");
  expect(ended[2]).toBe("late:exited");
  // A closed terminal that was never running is not an end; a starting one is not either.
  const fresh = createExitWatcher((status) => ended.push(`fresh:${status}`));
  fresh.sync("closed");
  fresh.sync("starting");
  expect(ended.length).toBe(3);
});
