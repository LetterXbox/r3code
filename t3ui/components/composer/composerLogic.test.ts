import { expect, test } from "nsh/test";
import { applyReplacement, detectComposerTrigger, pastedPathQueryLength } from "./composerTrigger";
import { BUILT_IN_SLASH_COMMANDS, parseSearchEntries, pathItem, searchSlashCommands } from "./commandItems";
import { buildPromptHistoryEntries, stepPromptHistory } from "./promptHistory";

test("slash and at triggers are detected at the caret, and a second slash makes a path", () => {
  expect(detectComposerTrigger("/mo", 3)).toEqual({ kind: "slash-command", query: "mo", rangeStart: 0, rangeEnd: 3 });
  expect(detectComposerTrigger("look at @src/ma", 15)).toEqual({ kind: "path", query: "src/ma", rangeStart: 8, rangeEnd: 15 });
  expect(detectComposerTrigger("/usr/bin", 4)).toBeNull();
  expect(detectComposerTrigger("hello", 5)).toBeNull();
  expect(detectComposerTrigger("a @b c", 6)).toBeNull();
});

test("replacing a trigger puts the caret after the replacement", () => {
  const trigger = detectComposerTrigger("see @sr", 7)!;
  expect(applyReplacement("see @sr", trigger, "@src/app.ts ")).toEqual({ text: "see @src/app.ts ", cursor: 16 });
});

test("slash search ranks name before description and lists everything for an empty query", () => {
  expect(searchSlashCommands(BUILT_IN_SLASH_COMMANDS, "").map((item) => item.label)).toEqual(["/model"]);
  expect(searchSlashCommands(BUILT_IN_SLASH_COMMANDS, "mod").length).toBe(1);
  expect(searchSlashCommands(BUILT_IN_SLASH_COMMANDS, "switch").length).toBe(1);
  expect(searchSlashCommands(BUILT_IN_SLASH_COMMANDS, "zzz")).toEqual([]);
});

test("workspace entries become mention rows with their folder as the description", () => {
  expect(pathItem({ path: "src/app/main.ts", kind: "file" })).toMatchObject({ label: "main.ts", description: "src/app", type: "path" });
  expect(parseSearchEntries({ entries: [{ path: "a/b", kind: "directory" }, { path: 3, kind: "file" }] }).length).toBe(1);
});

test("prompt history walks back through user messages and forward to empty", () => {
  const entries = buildPromptHistoryEntries([
    { id: "1", role: "user", body: "first" },
    { id: "2", role: "assistant", body: "reply" },
    { id: "3", role: "user", body: "second" },
    { id: "4", role: "user", body: "second" },
  ]);
  expect(entries.map((entry) => entry.prompt)).toEqual(["first", "second"]);
  const back = stepPromptHistory({ direction: "backward", entries, position: null, currentPrompt: "" })!;
  expect(back.prompt).toBe("second");
  const older = stepPromptHistory({ direction: "backward", entries, position: back.position, currentPrompt: "second" })!;
  expect(older.prompt).toBe("first");
  expect(stepPromptHistory({ direction: "backward", entries, position: older.position, currentPrompt: "first" })).toBeNull();
  const forward = stepPromptHistory({ direction: "forward", entries, position: older.position, currentPrompt: "first" })!;
  expect(forward.prompt).toBe("second");
  expect(stepPromptHistory({ direction: "forward", entries, position: forward.position, currentPrompt: "second" })).toEqual({ position: null, prompt: "" });
  expect(stepPromptHistory({ direction: "backward", entries, position: null, currentPrompt: "typed" })).toBeNull();
});

test("dollar opens the skills menu and hash the pull request menu; amounts and bare words do not", () => {
  expect(detectComposerTrigger("use $rev", 8)).toEqual({ kind: "skill", query: "rev", rangeStart: 4, rangeEnd: 8 });
  expect(detectComposerTrigger("fix #12", 7)).toEqual({ kind: "pull-request", query: "12", rangeStart: 4, rangeEnd: 7 });
  expect(detectComposerTrigger("it costs $10k", 13)).toBeNull();
  expect(detectComposerTrigger("# heading", 1)).toEqual({ kind: "pull-request", query: "", rangeStart: 0, rangeEnd: 1 });
});

test("a replacement ending in a space swallows one space already after the range", () => {
  const trigger = detectComposerTrigger("see $re x", 7)!;
  expect(applyReplacement("see $re x", trigger, "$review ")).toEqual({ text: "see $review x", cursor: 12 });
});

test("pastedPathQueryLength: the first word of a paste extends an active @ query", () => {
  expect(pastedPathQueryLength("see @src/", "app.ts and more")).toBe(6);
  expect(pastedPathQueryLength("see @src/", "  spaced")).toBe(0);
  expect(pastedPathQueryLength("see src/", "app.ts")).toBe(0);
  expect(pastedPathQueryLength("see @src/", "app.ts", false)).toBe(0);
});
