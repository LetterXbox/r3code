import { expect, test } from "nsh/test";
import { diffSelectionFor, readSavedDiffPanelState, liveToolCallRevision, reconcileTurnSelection, resetDiffPanelStoreForTests, selectCommit, selectGitScope, selectTurn, turnDiffSummaries } from "./diffPanelStore";
import { splitWholePatch, toolCallDiff } from "./wholePatch";

test("selections are per thread, commits keep the branch base, turns count reveal requests", () => {
  resetDiffPanelStoreForTests();
  expect(diffSelectionFor("t1")).toEqual({ kind: "branch", baseRef: null });
  selectCommit("t1", "abc");
  expect(diffSelectionFor("t1")).toEqual({ kind: "commit", sha: "abc", baseRef: null });
  selectGitScope("t1", "unstaged");
  expect(diffSelectionFor("t1")).toEqual({ kind: "unstaged" });
  selectTurn("t2", "run-1", " a.ts ");
  selectTurn("t2", "run-1");
  expect(diffSelectionFor("t2")).toEqual({ kind: "turn", turnId: "run-1", filePath: null, revealRequestId: 2 });
  reconcileTurnSelection("t2", ["run-9", "run-8"]);
  expect(diffSelectionFor("t2")).toEqual({ kind: "turn", turnId: "run-9", filePath: null, revealRequestId: 2 });
});

test("the saved state reads the zustand persist envelope and drops malformed entries", () => {
  const state = readSavedDiffPanelState(JSON.stringify({ state: { byThreadKey: { a: { kind: "unstaged" }, b: { kind: "commit" } }, branchBaseRefByThreadKey: { a: "main" } }, version: 2 }));
  expect(state).toEqual({ byThreadKey: { a: { kind: "unstaged" } }, branchBaseRefByThreadKey: { a: "main" } });
  expect(readSavedDiffPanelState("nope")).toEqual({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
});

test("checkpoints become turns, newest ordinal first, skipping ones without a run", () => {
  const turns = turnDiffSummaries([
    { runId: "r1", appRunOrdinal: 1, capturedAt: "2026-01-01T00:00:00Z" },
    { runId: null, appRunOrdinal: null, capturedAt: "2026-01-01T00:00:00Z" },
    { runId: "r2", appRunOrdinal: 2, capturedAt: "2026-01-02T00:00:00Z" },
  ]);
  expect(turns.map((turn) => turn.runId)).toEqual(["r2", "r1"]);
});

test("a whole patch splits into files with counts, renames and deletions", () => {
  const split = splitWholePatch([
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "-x", "+y", "+z",
    "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@", "-p", "+q",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
  ].join("\n"));
  expect(split.files).toEqual([
    { path: "a.ts", previousPath: null, additions: 2, deletions: 1 },
    { path: "new.ts", previousPath: "old.ts", additions: 1, deletions: 1 },
    { path: "gone.ts", previousPath: null, additions: 0, deletions: 1 },
  ]);
  expect(split.patches["a.ts"]?.patch.startsWith("diff --git a/a.ts b/a.ts")).toBe(true);
});

test("a tool call's bare hunk and an added file's raw content become renderable patches", () => {
  const hunk = toolCallDiff({ fileName: "t.ts", diffStr: "@@ -1 +1 @@\n-a\n+b\n", changes: [{ path: "t.ts", operation: "update" }] });
  expect(hunk.patch?.startsWith('diff --git "a/t.ts" "b/t.ts"\n--- "a/t.ts"\n+++ "b/t.ts"\n@@ -1 +1 @@')).toBe(true);
  expect(splitWholePatch(hunk.patch ?? "").files).toEqual([{ path: "t.ts", previousPath: null, additions: 1, deletions: 1 }]);
  const added = toolCallDiff({ fileName: "n.ts", diffStr: "one\ntwo\n", changes: [{ path: "n.ts", operation: "add" }] });
  expect(splitWholePatch(added.patch ?? "").files).toEqual([{ path: "n.ts", previousPath: null, additions: 2, deletions: 0 }]);
  const none = toolCallDiff({ fileName: "e.ts", newStr: "hello", changes: [{ path: "e.ts", operation: "update" }] });
  expect(none.content).toEqual([{ label: "Recorded content after", text: "hello" }]);
});

test("a change listed twice keeps both, the second under its occurrence key", async () => {
  const { fileKeyOf, withOccurrenceKeys } = await import("./data");
  const files = withOccurrenceKeys([
    { path: "a.ts", previousPath: null, additions: 1, deletions: 0 },
    { path: "a.ts", previousPath: null, additions: 0, deletions: 3 },
    { path: "b.ts", previousPath: "a.ts", additions: 1, deletions: 1 },
  ]);
  expect(files.map(fileKeyOf)).toEqual(["a.ts", '["a.ts","a.ts"]:1', "b.ts"]);
  const split = splitWholePatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-1", "+2", "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5 +5 @@", "-5", "+6"].join("\n"));
  expect(split.files.length).toBe(2);
  expect(Object.keys(split.patches)).toEqual(["x", '["x","x"]:1']);
  expect(split.patches['["x","x"]:1']!.patch.includes("@@ -5 +5 @@")).toBe(true);
});

test("opening the diff resets to branch unless explicit or kept by a link (fm13)", async () => {
  const { applyDiffOpenSelection, noteExplicitDiffOpen } = await import("./diffPanelStore");
  resetDiffPanelStoreForTests();
  selectGitScope("t1", "unstaged");
  applyDiffOpenSelection("t1");
  expect(diffSelectionFor("t1")).toEqual({ kind: "branch", baseRef: null });
  selectTurn("t1", "run-1");
  noteExplicitDiffOpen("t1");
  applyDiffOpenSelection("t1");
  expect(diffSelectionFor("t1").kind).toBe("turn");
  selectCommit("t1", "abc", true);
  applyDiffOpenSelection("t1");
  expect(diffSelectionFor("t1")).toEqual({ kind: "commit", sha: "abc", baseRef: null });
  applyDiffOpenSelection("t1");
  expect(diffSelectionFor("t1")).toEqual({ kind: "branch", baseRef: null });
});

test("collapsed file keys are kept per scope key for the session (fm13)", async () => {
  const { collapsedFileKeysFor, updateCollapsedFileKeys } = await import("./diffPanelStore");
  resetDiffPanelStoreForTests();
  updateCollapsedFileKeys("t1:branch", (current) => new Set([...current, "a.ts"]));
  expect([...collapsedFileKeysFor("t1:branch")]).toEqual(["a.ts"]);
  expect(collapsedFileKeysFor("t1:unstaged").size).toBe(0);
});

test("collapsed-by-default files stay folded when another file is opened", async () => {
  const { collapsedFileKeysFor, updateCollapsedFileKeys } = await import("./diffPanelStore");
  resetDiffPanelStoreForTests();
  const defaults = new Set(["a.ts", "b.ts"]);
  expect([...collapsedFileKeysFor("thread:branch", defaults)]).toEqual(["a.ts", "b.ts"]);
  updateCollapsedFileKeys("thread:branch", (current) => { const next = new Set(current); next.delete("a.ts"); return next; }, defaults);
  expect([...collapsedFileKeysFor("thread:branch", defaults)]).toEqual(["b.ts"]);
});

test("a tool-call diff follows its live item's revision: live while running, then updatedAt", () => {
  const revisionOf = (item: Record<string, unknown>) => (item.status === "running" ? "live" : String(item.updatedAt));
  const target = { threadId: "t", itemId: "i" };
  expect(liveToolCallRevision(target, [{ id: "i", type: "file_change", status: "running" }], revisionOf)).toBe("live");
  expect(liveToolCallRevision(target, [{ id: "i", type: "file_change", status: "completed", updatedAt: "2026-01-01T00:00:00Z" }], revisionOf)).toBe("2026-01-01T00:00:00Z");
  expect(liveToolCallRevision(target, [{ id: "i", threadId: "other", type: "file_change", status: "completed" }], revisionOf)).toBe(null);
  expect(liveToolCallRevision(target, [{ id: "i", type: "command_execution", status: "completed" }], revisionOf)).toBe(null);
});
