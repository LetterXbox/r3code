import { expect, test } from "nsh/test";
import { commentAnnotations, commentLabel, commentablePath, linesInRange, patchLines, rangeLabelOf, reviewCommentMarker, reviewCommentRecord, type DiffComment } from "./diffComments";
import { clampTreeWidth, defaultTreeWidth, readSavedTreeWidth, treeMaxWidth, treeWidthFor } from "./treeWidth";
import { stackedPatch, type FilePatch } from "./stacked";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@", " one", "-two", "+two!", "+two and a half", " three", " four", "",
].join("\n");

test("patch lines carry the old and new numbers of each line", () => {
  const lines = patchLines(patch);
  expect(lines.map((line) => `${line.marker}${line.oldNumber ?? "_"}:${line.newNumber ?? "_"}`)).toEqual([" 1:1", "-2:_", "+_:2", "+_:3", " 3:4", " 4:5"]);
  expect(linesInRange(lines, "new", 1, 2).map((line) => line.content)).toEqual(["two!", "two and a half"]);
  expect(linesInRange(lines, "old", 1, 1).map((line) => line.content)).toEqual(["two"]);
  expect(rangeLabelOf(linesInRange(lines, "new", 1, 2))).toBe("+2 to +3");
  expect(rangeLabelOf(linesInRange(lines, "old", 0, 1))).toBe("1 to 2");
  expect(commentLabel("src/a.ts", "+2 to +3")).toBe("a.ts L2 to L3");
  expect(commentLabel("src/a.ts", "-2")).toBe("a.ts L2 (before)");
});

test("a comment becomes a review-comment context record with the lines it is about", () => {
  const comment: DiffComment = { id: "c1", path: "src/a.ts", side: "new", start: 1, end: 2, text: "  why?  " };
  const record = reviewCommentRecord(comment, patch, "Changes")!;
  expect(record).toMatchObject({ version: 1, kind: "review-comment", filePath: "src/a.ts", sectionId: "file:src/a.ts", sectionTitle: "Changes", rangeLabel: "+2 to +3", text: "why?", label: "a.ts L2 to L3", fenceLanguage: "diff" });
  expect(record.diff).toBe("@@ -0,0 +2,2 @@\n+two!\n+two and a half");
  expect(reviewCommentMarker(record)).toBe(`[a.ts L2 to L3](t3-context://v1/review-comment/${record.contextId})`);
  expect(reviewCommentRecord({ ...comment, start: 40, end: 41 }, patch, "Changes")).toBeNull();
});

test("annotations sit at the last line of each range, with the draft last", () => {
  const saved: DiffComment = { id: "c1", path: "a", side: "new", start: 4, end: 2, text: "x" };
  expect(commentAnnotations([saved], { side: "old", start: 1, end: 1 })).toEqual([{ id: "c1", side: "new", line: 4 }, { id: "draft", side: "old", line: 1 }]);
  expect(commentAnnotations([], null)).toEqual([]);
  expect(commentablePath(["a.ts"])).toBe("a.ts");
  expect(commentablePath(["a.ts", "b.ts"])).toBeNull();
});

test("the file tree column keeps the reference's limits", () => {
  expect(defaultTreeWidth(1000)).toBe(256);
  expect(defaultTreeWidth(500)).toBe(200);
  expect(defaultTreeWidth(200)).toBe(160);
  expect(treeMaxWidth(1000)).toBe(560);
  expect(treeMaxWidth(600)).toBe(344);
  expect(treeMaxWidth(300)).toBe(160);
  expect(clampTreeWidth(50, 1000)).toBe(160);
  expect(clampTreeWidth(900, 1000)).toBe(560);
  expect(treeWidthFor(null, 1000)).toBe(256);
  expect(treeWidthFor(400, 600)).toBe(344);
  expect(readSavedTreeWidth("300")).toBe(300);
  expect(readSavedTreeWidth("x")).toBeNull();
  expect(readSavedTreeWidth(null)).toBeNull();
});

test("files still loading or failed keep a header in the stack when asked", () => {
  const file = (path: string) => ({ path, previousPath: null, additions: 1, deletions: 0 });
  const ready: FilePatch = { state: "ready", patch: "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n", truncated: false, error: "" };
  const result = stackedPatch([file("a"), file("b"), file("c")], { b: ready, c: { state: "error", patch: "", truncated: false, error: "boom" } }, { headers: true });
  expect(result.text.indexOf("diff --git a/a b/a")).toBeLessThan(result.text.indexOf("diff --git a/b b/b"));
  expect(result.text).toContain("diff --git a/c b/c");
  expect(result.pending).toEqual(["a"]);
  expect(stackedPatch([file("a")], {}).text).toBe("");
});

test("pending review-comment records come back on the diff from their selection (restoreDiffReviewCommentRange)", async () => {
  const { restoreDiffComments, reviewCommentRecord } = await import("./diffComments");
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same";
  const record = reviewCommentRecord({ id: "c1", path: "a.ts", side: "new", start: 1, end: 2, text: "look" }, patch, "Uncommitted");
  expect(record?.selection).toEqual({ start: 1, side: "additions", end: 2, endSide: "additions" });
  const restored = restoreDiffComments([record, { kind: "review-comment", fenceLanguage: "ts", filePath: "a.ts", sectionId: "file:a.ts" }, { kind: "terminal" }], (path) => `file:${path}`);
  expect(restored).toEqual([{ id: record!.contextId, path: "a.ts", side: "new", start: 1, end: 2, text: "look" }]);
  expect(restoreDiffComments([record], () => "other")).toEqual([]);
});
