import { expect, test } from "nsh/test";
import { canHydrateContext, diffChangeType, expandFilePatch, expandGap, gapSize, hunkIndex, parseFilePatch, separatorButtons, separatorLabel } from "./diffContext";

// A 300-line file, lines "l1".."l300"; line 6 changed and a line added after 150 (a review.getDiffFileContents result).
const oldLines = Array.from({ length: 300 }, (_, i) => `l${i + 1}`);
const newLines = [...oldLines.slice(0, 5), "L6", ...oldLines.slice(6, 150), "added", ...oldLines.slice(150)];
const contents = { oldContents: `${oldLines.join("\n")}\n`, newContents: `${newLines.join("\n")}\n` };
const patch = [
  "diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts",
  "@@ -3,7 +3,7 @@ function one", " l3", " l4", " l5", "-l6", "+L6", " l7", " l8", " l9",
  "@@ -148,6 +148,7 @@ function two", " l148", " l149", " l150", "+added", " l151", " l152", " l153", "",
].join("\n");

test("gap sizes come from the hunk headers; the tail needs the file", () => {
  const { hunks } = parseFilePatch(patch);
  expect(hunks.length).toBe(2);
  expect(gapSize(hunks, 0)).toBe(2);
  expect(gapSize(hunks, 1)).toBe(138);
  expect(gapSize(hunks, 2)).toBe(null);
  expect(gapSize(hunks, 2, contents)).toBe(147);
});

test("separator copy and buttons follow Pierre's createSeparator", () => {
  expect(separatorLabel(1)).toBe("1 unmodified line");
  expect(separatorLabel(138)).toBe("138 unmodified lines");
  expect(separatorLabel(null)).toBe("More unchanged context may be available");
  expect(separatorButtons(2, true, false)).toEqual(["down"]);
  expect(separatorButtons(40, false, false)).toEqual(["both"]);
  expect(separatorButtons(40, false, true)).toEqual(["up"]);
  expect(separatorButtons(138, false, false)).toEqual(["up", "down", "all"]);
  expect(separatorButtons(null, false, true)).toEqual(["up", "all"]);
});

test("revealing 100 lines below a hunk grows it and keeps numbering", () => {
  const expanded = expandFilePatch(patch, contents, expandGap({}, 1, "up"));
  const { hunks } = parseFilePatch(expanded);
  expect(hunks.length).toBe(2);
  expect([hunks[0]!.oldStart, hunks[0]!.oldLines, hunks[0]!.newStart, hunks[0]!.newLines]).toEqual([3, 107, 3, 107]);
  expect(hunks[0]!.lines[hunks[0]!.lines.length - 1]).toBe(" l109");
  expect(gapSize(hunks, 1)).toBe(38);
});

test("revealing a whole gap merges the two hunks; the first gap and the tail expand too", () => {
  let expansion = expandGap({}, 1, "all");
  expansion = expandGap(expansion, 0, "down");
  expansion = expandGap(expansion, 2, "up");
  const { hunks } = parseFilePatch(expandFilePatch(patch, contents, expansion));
  expect(hunks.length).toBe(1);
  expect([hunks[0]!.oldStart, hunks[0]!.oldLines, hunks[0]!.newStart, hunks[0]!.newLines]).toEqual([1, 253, 1, 254]);
  expect(hunks[0]!.header).toBe("function one");
  expect(hunks[0]!.lines[0]).toBe(" l1");
  expect(hunks[0]!.lines[hunks[0]!.lines.length - 1]).toBe(" l253");
});

test("only changed files hydrate; global hunk numbers map to files", () => {
  expect(diffChangeType({ path: "a.ts", previousPath: null }, patch)).toBe("change");
  expect(diffChangeType({ path: "b.ts", previousPath: "a.ts" }, "diff --git a/a.ts b/b.ts\nsimilarity index 100%\n")).toBe("rename-pure");
  expect(diffChangeType({ path: "n.ts", previousPath: null }, "diff --git a/n.ts b/n.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\n")).toBe("new");
  expect(canHydrateContext("change", patch)).toBe(true);
  expect(canHydrateContext("new", patch)).toBe(false);
  const two = `${patch}diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n`;
  expect(hunkIndex(two)).toEqual([{ file: 0, hunk: 0, hunks: 2 }, { file: 0, hunk: 1, hunks: 2 }, { file: 1, hunk: 0, hunks: 1 }]);
});
