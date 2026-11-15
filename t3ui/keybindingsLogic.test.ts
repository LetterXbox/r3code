import { expect, test } from "nsh/test";
import { buildRows, commandLabel, conflictLabels, contractKeyFromNsh, filterRows, formatKey, groupRows, mergeWithDefaults, resetPayload, rulesFromResolved, upsertPayload, whenToExpression } from "./pages/settings/keybindingsLogic";

const defaults = [
  { command: "sidebar.toggle", key: "mod+b", when: "" },
  { command: "terminal.toggle", key: "mod+j", when: "" },
  { command: "chat.new", key: "mod+n", when: "!terminalFocus" },
  { command: "terminal.new", key: "mod+n", when: "terminalFocus" },
];

test("labels, symbols and groups follow the web", () => {
  expect(commandLabel("rightPanel.toggle")).toBe("Right Panel: Toggle");
  expect(commandLabel("composer.dictation")).toBe("Composer: Start or Finish Dictation");
  expect(formatKey("mod+shift+n")).toBe("⌘ ⇧ N");
  expect(formatKey("mod++")).toBe("⌘ +");
  const groups = groupRows(buildRows(defaults, []));
  expect(groups.map((g) => g.title)).toEqual(["Navigation", "Threads", "Terminal"]);
});

test("server rules replace the default for that command and are marked Custom", () => {
  const custom = rulesFromResolved([{ command: "sidebar.toggle", shortcut: { key: "e", modKey: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, whenAst: undefined }]);
  expect(custom).toEqual([{ command: "sidebar.toggle", key: "mod+shift+e", when: "" }]);
  expect(mergeWithDefaults(defaults, custom).filter((r) => r.command === "sidebar.toggle")).toEqual(custom);
  const row = buildRows(defaults, custom).find((r) => r.command === "sidebar.toggle")!;
  expect(row.source).toBe("Custom");
  expect(row.defaultKey).toBe("mod+b");
  expect(resetPayload(row)).toEqual({ command: "sidebar.toggle", key: "mod+b", replace: { command: "sidebar.toggle", key: "mod+shift+e" } });
});

test("a chord that another command uses in an overlapping context conflicts", () => {
  const rows = buildRows(defaults, []);
  const sidebar = rows.find((r) => r.command === "sidebar.toggle")!;
  expect(conflictLabels(rows, sidebar.id, "mod+j", "")).toEqual(["Terminal: Toggle"]);
  expect(conflictLabels(rows, sidebar.id, "mod+n", "")).toEqual(["Chat: New", "Terminal: New"]);
  expect(conflictLabels(rows.filter((r) => r.command !== "terminal.new"), sidebar.id, "mod+n", "terminalFocus")).toEqual([]);
  expect(conflictLabels(rows, sidebar.id, "", "")).toEqual([]);
});

test("search matches label, command, key, when and source", () => {
  const rows = buildRows(defaults, []);
  expect(filterRows(rows, "toggle").map((r) => r.command)).toEqual(["sidebar.toggle", "terminal.toggle"]);
  expect(filterRows(rows, "mod+j").map((r) => r.command)).toEqual(["terminal.toggle"]);
  expect(filterRows(rows, "!terminalFocus").map((r) => r.command)).toEqual(["chat.new"]);
  expect(filterRows(rows, "nothing")).toEqual([]);
});

test("rebinding replaces the old chord, and recorded chords use keybindings.json names", () => {
  const row = buildRows(defaults, []).find((r) => r.command === "chat.new")!;
  expect(upsertPayload(row, " mod+shift+u ")).toEqual({ command: "chat.new", key: "mod+shift+u", when: "!terminalFocus", replace: { command: "chat.new", key: "mod+n", when: "!terminalFocus" } });
  expect(contractKeyFromNsh("mod+shift+up")).toBe("mod+shift+arrowup");
  expect(contractKeyFromNsh("mod+plus")).toBe("mod+=");
  expect(whenToExpression({ type: "and", left: { type: "identifier", name: "a" }, right: { type: "not", node: { type: "identifier", name: "b" } } })).toBe("a && !b");
});

test("when-clause helpers flag unknown conditions and options list every command once", async () => {
  const { commandOptions, knownWhenVariables, newBindingPayload, unknownWhenIdentifiers, upsertPayload: upsert } = await import("./pages/settings/keybindingsLogic");
  const known = knownWhenVariables(defaults);
  expect(known).toContain("terminalFocus");
  expect(known).toContain("isDesktop");
  expect(unknownWhenIdentifiers("!terminalFocus && mysteryFlag || other", known)).toEqual(["mysteryFlag", "other"]);
  expect(unknownWhenIdentifiers("", known)).toEqual([]);
  expect(commandOptions(defaults, [{ command: "sidebar.toggle", key: "x", when: "" }, { command: "zed.go", key: "z", when: "" }])).toEqual(["chat.new", "sidebar.toggle", "terminal.new", "terminal.toggle", "zed.go"]);
  expect(newBindingPayload("chat.new", " mod+9 ", " ")).toEqual({ command: "chat.new", key: "mod+9" });
  expect(newBindingPayload("chat.new", "mod+9", "!terminalFocus")).toEqual({ command: "chat.new", key: "mod+9", when: "!terminalFocus" });
  const row = buildRows(defaults, []).find((item) => item.command === "sidebar.toggle")!;
  expect(upsert(row, "mod+b", "terminalFocus")).toEqual({ command: "sidebar.toggle", key: "mod+b", when: "terminalFocus", replace: { command: "sidebar.toggle", key: "mod+b" } });
});
