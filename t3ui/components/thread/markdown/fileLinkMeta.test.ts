import { expect, test } from "nsh/test";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  markdownFileCopyMenuItems,
  parseMarkdownFileLink,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  workspaceRelativeFilePath,
} from "./fileLinkMeta";

const CWD = "/Users/dev/app";

test("a markdown destination is a file only when it is shaped like one", () => {
  expect(parseMarkdownFileLink("src/a.ts")).toEqual({ path: "src/a.ts" });
  expect(parseMarkdownFileLink("/Users/dev/app/src/a.ts#L12C3")).toEqual({ path: "/Users/dev/app/src/a.ts", line: 12, column: 3 });
  expect(parseMarkdownFileLink("<./notes.md:7>")).toEqual({ path: "./notes.md", line: 7 });
  expect(parseMarkdownFileLink("file:///etc/hosts")).toEqual({ path: "/etc/hosts" });
  expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
  expect(parseMarkdownFileLink("https://example.com/a.ts")).toBe(null);
  expect(parseMarkdownFileLink("mailto:me@example.com")).toBe(null);
  expect(parseMarkdownFileLink("#section")).toBe(null);
  expect(parseMarkdownFileLink("hello")).toBe(null);
  expect(parseMarkdownFileLink("//evil/share/a.txt")).toBe(null);
});

test("inline code becomes a file chip only for a path with a file-shaped end", () => {
  expect(inlineCodeFilePathCandidate("src/a.ts")).toBe("src/a.ts");
  expect(inlineCodeFilePathCandidate("a.ts:12")).toBe("a.ts:12");
  expect(inlineCodeFilePathCandidate("/Users/dev/app/a")).toBe("/Users/dev/app/a");
  expect(inlineCodeFilePathCandidate("const x")).toBe(null);
  expect(inlineCodeFilePathCandidate("README.md")).toBe(null); // no separator and no position: plain code
  expect(inlineCodeFilePathCandidate("example.com/docs")).toBe(null);
  expect(inlineCodeFilePathCandidate("localhost:3000")).toBe(null);
  expect(inlineCodeFilePathCandidate("src/.../a.ts")).toBe(null);
  expect(inlineCodeFilePathCandidate("patches/")).toBe(null);
  expect(inlineCodeFilePathCandidate("pkg/v1.2.3")).toBe(null);
});

test("a file link resolves against the workspace and keeps its line and column", () => {
  expect(resolveMarkdownFileLinkMeta("src/a.ts#L9", CWD)).toEqual({
    filePath: "/Users/dev/app/src/a.ts", targetPath: "/Users/dev/app/src/a.ts:9", workspaceRelativePath: "src/a.ts", basename: "a.ts", workspaceLookupPath: "src/a.ts", line: 9,
  });
  expect(resolveMarkdownFileLinkMeta("/etc/hosts", CWD)).toMatchObject({ workspaceRelativePath: null, basename: "hosts" });
  expect(resolveMarkdownFileLinkMeta("src/a.ts", undefined)).toBe(null);
  expect(resolveInlineCodeFileLinkMeta("pkg/lib/b.ts:4:2", CWD)).toMatchObject({ targetPath: "/Users/dev/app/pkg/lib/b.ts:4:2", workspaceRelativePath: "pkg/lib/b.ts", line: 4, column: 2 });
  expect(workspaceRelativeFilePath("/Users/dev/app/../x", CWD)).toBe(null);
  expect(workspaceRelativeFilePath(CWD, CWD)).toBe(".");
});

test("files that share a name show their folders, and the line joins the label", () => {
  const suffixes = buildFileLinkParentSuffixByPath(["/r/a/index.ts", "/r/b/index.ts", "/r/a/other.ts"]);
  expect(suffixes.get("/r/a/index.ts")).toBe("r/a");
  expect(suffixes.get("/r/b/index.ts")).toBe("r/b");
  expect(suffixes.has("/r/a/other.ts")).toBe(false);
  expect(fileLinkLabel({ path: "/r/a/index.ts", line: 3, column: 2 }, suffixes)).toBe("index.ts · r/a · L3:C2");
  expect(fileLinkLabel({ path: "/r/a/other.ts" }, suffixes)).toBe("other.ts");
});

test("a link whose text only repeats the file stands as a bare chip", () => {
  expect(isMarkdownFileLinkLabel("a.ts", "/Users/dev/app/src/a.ts")).toBe(true);
  expect(isMarkdownFileLinkLabel("src/a.ts:12", "/Users/dev/app/src/a.ts#L12")).toBe(true);
  expect(isMarkdownFileLinkLabel("the entry point", "/Users/dev/app/src/a.ts")).toBe(false);
  expect(isMarkdownFileLinkLabel("a.ts:13", "/Users/dev/app/src/a.ts#L12")).toBe(false);
});

test("the copy menu offers the relative path first when the file is inside the workspace", () => {
  const inside = resolveMarkdownFileLinkMeta("src/a.ts#L9", CWD)!;
  expect(markdownFileCopyMenuItems(inside).map((item) => [item.label, item.value])).toEqual([
    ["Copy relative path", "src/a.ts:9"],
    ["Copy full path", "/Users/dev/app/src/a.ts:9"],
  ]);
  const outside = resolveMarkdownFileLinkMeta("/etc/hosts", CWD)!;
  expect(markdownFileCopyMenuItems(outside).map((item) => item.label)).toEqual(["Copy full path"]);
});
