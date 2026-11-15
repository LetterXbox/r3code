import { expect, test } from "nsh/test";
import { baseName, isImagePath, isMarkdownPath, workspaceFileUrl, flattenTree, formatByteLength, pathSegments, previewLines, readDirectoryListing, readFileContents, readFileFailureMessage, readSearchEntries, searchRows } from "./filesLogic";

test("listings sort folders first, then natural names, and skip invalid entries", () => {
  const listing = readDirectoryListing({
    entries: [
      { path: "b.ts", kind: "file" }, { path: "src", kind: "directory" }, { path: "a10.ts", kind: "file" }, { path: "a2.ts", kind: "file", ignored: true },
      { path: "", kind: "file" }, { path: "x", kind: "socket" },
    ],
    truncated: true,
  });
  expect(listing.entries.map((entry) => entry.path)).toEqual(["src", "a2.ts", "a10.ts", "b.ts"]);
  expect(listing.entries[1]?.ignored).toBe(true);
  expect(listing.truncated).toBe(true);
  expect(() => readDirectoryListing({})).toThrow();
});

test("the tree flattens expanded folders depth first", () => {
  const root = readDirectoryListing({ entries: [{ path: "src", kind: "directory" }, { path: "readme.md", kind: "file" }], truncated: false });
  const src = readDirectoryListing({ entries: [{ path: "src/lib", kind: "directory" }, { path: "src/main.ts", kind: "file" }], truncated: false });
  const collapsed = flattenTree({ listings: { "": root, src }, expanded: new Set(), loading: new Set() });
  expect(collapsed.map((row) => row.path)).toEqual(["src", "readme.md"]);
  const open = flattenTree({ listings: { "": root, src }, expanded: new Set(["src"]), loading: new Set(["src/lib"]) });
  expect(open.map((row) => [row.path, row.depth, row.expanded, row.loading])).toEqual([
    ["src", 0, true, false], ["src/lib", 1, false, true], ["src/main.ts", 1, false, false], ["readme.md", 0, false, false],
  ]);
});

test("file contents, lines and sizes", () => {
  expect(readFileContents({ relativePath: "a.ts", contents: "x", byteLength: 1, truncated: false }).byteLength).toBe(1);
  expect(() => readFileContents({ contents: 3 })).toThrow();
  expect(previewLines("a\nb\n")).toEqual(["a", "b"]);
  expect(previewLines("a\r\nb")).toEqual(["a", "b"]);
  expect(previewLines("")).toEqual([]);
  expect(formatByteLength(512)).toBe("512 B");
  expect(formatByteLength(2048)).toBe("2.0 KB");
  expect(formatByteLength(5 * 1024 * 1024)).toBe("5.0 MB");
  expect(readFileFailureMessage("Cannot read binary_file")).toBe("The file is binary and cannot be displayed as text.");
  expect(readFileFailureMessage("operation_failed realpath-workspace-root")).toBe("The workspace folder could not be accessed.");
  expect(readFileFailureMessage("operation_failed read")).toBe("The file could not be accessed or read. It may be missing or inaccessible.");
  expect(baseName("a/b/c.ts")).toBe("c.ts");
  expect(pathSegments("a/b/c.ts")).toEqual([{ label: "a", path: "a" }, { label: "b", path: "a/b" }, { label: "c.ts", path: "a/b/c.ts" }]);
});

test("a search shows its matches under the folders that hold them, every folder open", () => {
  const { entries } = readSearchEntries({ entries: [{ path: "src/deep/util.ts", kind: "file" }, { path: "src/util.test.ts", kind: "file" }], truncated: false });
  const rows = searchRows("util", entries, { "": readDirectoryListing({ entries: [{ path: "util.md", kind: "file" }, { path: "readme.md", kind: "file" }] }) });
  expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual(["0:src", "1:src/deep", "2:src/deep/util.ts", "1:src/util.test.ts", "0:util.md"]);
  expect(rows[0]?.expanded).toBe(true);
  expect(searchRows("  ", entries, {})).toEqual([]);
  expect(() => readSearchEntries(null)).toThrow();
});

test("markdown and image paths are told apart, and a workspace file has a file URL", () => {
  expect(isMarkdownPath("docs/a.MD")).toBe(true);
  expect(isMarkdownPath("a.mdx.bak")).toBe(false);
  expect(isImagePath("img/logo.PNG")).toBe(true);
  expect(isImagePath("a.ts")).toBe(false);
  expect(workspaceFileUrl("/p/", "a b/c.png")).toBe("file:///p/a%20b/c.png");
});
