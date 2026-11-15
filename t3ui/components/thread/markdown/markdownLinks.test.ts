import { expect, test } from "nsh/test";
import { classifyMarkdownLink, parseThreadHref, splitFilePosition } from "./markdownLinks";

test("thread links in every written form", () => {
  expect(parseThreadHref("t3-thread://v1/thread-1")).toEqual({ threadId: "thread-1", environmentId: null });
  expect(parseThreadHref("t3-thread://v2/env-a/thread-1")).toEqual({ threadId: "thread-1", environmentId: "env-a" });
  expect(parseThreadHref("https://app.t3.codes/threads/env-a/thread-1")).toEqual({ threadId: "thread-1", environmentId: "env-a" });
  expect(parseThreadHref("t3-thread://v2/env-a")).toBe(null);
  expect(parseThreadHref("https://example.com/x")).toBe(null);
});

test("file positions come from a suffix or a #L hash", () => {
  expect(splitFilePosition("/a/b.ts:12:3")).toEqual({ path: "/a/b.ts", line: 12, column: 3 });
  expect(splitFilePosition("/a/b.ts", "#L7C2")).toEqual({ path: "/a/b.ts", line: 7, column: 2 });
  expect(splitFilePosition("/a/b.ts")).toEqual({ path: "/a/b.ts" });
});

test("classifyMarkdownLink separates files, threads, anchors and web links", () => {
  expect(classifyMarkdownLink("https://example.com")).toEqual({ kind: "external", url: "https://example.com" });
  expect(classifyMarkdownLink("#section")).toEqual({ kind: "anchor", id: "section" });
  expect(classifyMarkdownLink("t3-thread://v1/abc").kind).toBe("thread");
  expect(classifyMarkdownLink("/work/app/src/a.ts:4", "/work/app")).toEqual({ kind: "file", path: "/work/app/src/a.ts", line: 4, relativePath: "src/a.ts" });
  expect(classifyMarkdownLink("src/a.ts#L9", "/work/app")).toEqual({ kind: "file", path: "src/a.ts", line: 9, relativePath: "src/a.ts" });
  expect(classifyMarkdownLink("file:///etc/hosts", "/work/app")).toEqual({ kind: "file", path: "/etc/hosts", relativePath: null });
  expect(classifyMarkdownLink("README.md", "/work/app")).toMatchObject({ kind: "file", relativePath: "README.md" });
});
