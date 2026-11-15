import { expect, test } from "nsh/test";
import { excerptPatch, excerptRows, fileDiffRows, fileSection, missingPaths } from "./excerptPatch";

const PATCH = [
  "diff --git a/src/race.ts b/src/race.ts", "--- a/src/race.ts", "+++ b/src/race.ts",
  "@@ -1,4 +1,5 @@", " one", "-two", "+two fixed", "+two b", " three", " four",
  "@@ -20,2 +21,2 @@", " twenty", "-old", "+new", "\\ No newline at end of file",
  "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-a", "+b", "",
].join("\n");

test("a file's section and rows are read from a multi-file patch", () => {
  const found = fileSection(PATCH, "src/race.ts")!;
  expect(found.previousPath).toBe("src/race.ts");
  expect(found.section.includes("src/b.ts")).toBe(false);
  const rows = fileDiffRows(found.section);
  expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
    ["context", 1, 1], ["deletion", 2, null], ["addition", null, 2], ["addition", null, 3], ["context", 3, 4], ["context", 4, 5],
    ["context", 20, 21], ["deletion", 21, null], ["addition", null, 22],
  ]);
  expect(rows[rows.length - 1]!.noNewline).toBe(true);
  expect(fileSection(PATCH, "nope.ts")).toBeNull();
});

test("a range on the new side pulls in the deletion it replaced", () => {
  const rows = fileDiffRows(fileSection(PATCH, "src/race.ts")!.section);
  const shown = excerptRows(rows, { side: "new", start: 2, end: 3 });
  expect(shown.map((row) => row.kind)).toEqual(["deletion", "addition", "addition"]);
  const old = excerptRows(rows, { side: "old", start: 2, end: 2 });
  expect(old.map((row) => row.kind)).toEqual(["deletion", "addition", "addition"]);
  expect(excerptRows(rows, { side: "new", start: 90, end: 99 })).toEqual([]);
});

test("the excerpt patch keeps hunk numbering and the no-newline flag", () => {
  const slice = excerptPatch(PATCH, { path: "src/race.ts", side: "new", start: 2, end: 3 })!;
  expect(slice.patch).toBe(["diff --git a/src/race.ts b/src/race.ts", "--- a/src/race.ts", "+++ b/src/race.ts", "@@ -2,1 +2,2 @@", "-two", "+two fixed", "+two b", ""].join("\n"));
  expect(slice.shown).toBe(3);
  expect(slice.total).toBe(9);
  const tail = excerptPatch(PATCH, { path: "src/race.ts", side: "new", start: 22, end: 22 })!;
  expect(tail.patch.includes("\\ No newline at end of file")).toBe(true);
  expect(excerptPatch(PATCH, { path: "src/race.ts", side: "new", start: 500, end: 501 })).toBeNull();
});

test("paths the patch does not hold yet are listed once", () => {
  expect(missingPaths(PATCH, [{ path: "src/race.ts" }, { path: "z.ts" }, { path: "z.ts" }])).toEqual(["z.ts"]);
});

test("an excerpt from one hunk expands against an old side matching it", async () => {
  const { excerptExpansion } = await import("./GuideExcerpt");
  const { expandFilePatch, expandGap, parseFilePatch } = await import("../../diff/diffContext");
  // A hunk at new line 40 whose old side was shifted by 5 lines of other hunks.
  const slice = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -35,2 +40,3 @@\n l40\n+n\n l41\n";
  const found = excerptExpansion(slice)!;
  expect(parseFilePatch(found.patch).hunks[0]!.oldStart).toBe(40);
  const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`);
  const contents = found.adapt({ oldContents: "ignored", newContents: `${[...lines.slice(0, 40), "n", ...lines.slice(40)].join("\n")}\n` });
  const drawn = parseFilePatch(expandFilePatch(found.patch, contents, expandGap({}, 0, "down")));
  expect(drawn.hunks[0]!.lines[0]).toBe(" l1");
  expect(excerptExpansion(`${slice}@@ -50 +51 @@\n-x\n+y\n`)).toBe(null);
});
