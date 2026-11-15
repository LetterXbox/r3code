import { expect, test } from "nsh/test";
import { readDiffPreview } from "./data";

test("parses changed files including renames and incomplete previews", () => {
  const result = readDiffPreview({ incomplete: true, sources: [
    { kind: "working-tree", title: "Uncommitted", baseRef: "HEAD", headRef: null, diff: "", truncated: false, files: [
      { path: "src/new name.ts", previousPath: "src/old name.ts", additions: 3, deletions: 1 },
    ] },
  ] }, "working-tree");
  expect(result.incomplete).toBe(true);
  expect(result.source?.files).toEqual([{ path: "src/new name.ts", previousPath: "src/old name.ts", additions: 3, deletions: 1 }]);
});

test("distinguishes an absent repository from incomplete metadata", () => {
  expect(readDiffPreview({ sources: [] }, "branch-range").source).toBe(null);
  expect(readDiffPreview({ sources: [{ kind: "branch-range", title: "Changes", diff: "partial patch", truncated: true }] }, "branch-range").source?.files).toBe(null);
});

test("rejects malformed changed-file lists and a missing requested scope", () => {
  expect(() => readDiffPreview({ sources: [{ kind: "branch-range", title: "Changes", diff: "", files: [{ path: "file", previousPath: null, additions: "many", deletions: 0 }] }] }, "branch-range")).toThrow("invalid changed file");
  expect(() => readDiffPreview({ sources: [{ kind: "working-tree", title: "Uncommitted", diff: "", files: [] }] }, "branch-range")).toThrow("scope is not available");
});
