import { expect, test } from "nsh/test";
import { fileActionFailureTitle, fileMenuItems, readMenuCapabilities, revealLabel } from "./fileActions";

test("the reveal label follows the server's file-manager kind before the OS (WSL reveals in File Explorer)", () => {
  const wsl = readMenuCapabilities({ availableEditors: ["file-manager"], shellRevealInFileManager: true, shellRevealInFileManagerKind: "file-explorer" }, "linux");
  expect(revealLabel(wsl)).toBe("Reveal in File Explorer");
  expect(fileMenuItems(wsl).map((item) => item.label)).toEqual(["Open", "Reveal in File Explorer", "Copy mention", "Add to chat"]);
});

test("the diff's file menu leaves out the mention items", () => {
  const caps = readMenuCapabilities({ availableEditors: ["vscode", "file-manager"], shellRevealInFileManager: true }, "macos");
  expect(fileMenuItems(caps, { mentions: false }).map((item) => item.label)).toEqual(["Open", "Reveal in Finder", "Open with"]);
});

test("failure titles are the reference's", () => {
  expect(fileActionFailureTitle({ id: "open" }, "macos")).toBe("Could not open file");
  expect(fileActionFailureTitle({ id: "reveal" }, "macos")).toBe("Unable to reveal file");
  expect(fileActionFailureTitle({ id: "editor", editor: "vscode" }, "macos")).toBe("Could not open in VS Code");
  expect(fileActionFailureTitle({ id: "copy-mention" }, "macos")).toBe("Failed to copy mention");
  expect(fileActionFailureTitle({ id: "add-to-chat" }, "macos")).toBe("Unable to add to chat");
});

test("an image fits its viewport without growing past its size, and zoom stays between 5% and 800%", async () => {
  const { fitScale, zoomedScale } = await import("./ImagePreview");
  expect(fitScale({ width: 1000, height: 500 }, { width: 532, height: 900 })).toBe(0.5);
  expect(fitScale({ width: 100, height: 100 }, { width: 900, height: 900 })).toBe(1);
  expect(zoomedScale(7, 1.25)).toBe(8);
  expect(zoomedScale(0.05, 0.8)).toBe(0.05);
});

test("a font sample carries the font itself, and fonts are bounded at 10 MB", async () => {
  const { fontSampleHtml, MAX_FONT_BYTES } = await import("./RenderedViews");
  expect(MAX_FONT_BYTES).toBe(10 * 1024 * 1024);
  expect(fontSampleHtml("QUJD", "font/ttf").includes('src:url("data:font/ttf;base64,QUJD")')).toBe(true);
});

test("a breadcrumb menu whose re-read failed keeps its listing and offers Refresh failed. Retry", async () => {
  const { breadcrumbMenuRows } = await import("./breadcrumbs");
  const rows = breadcrumbMenuRows({ directoryPath: "", rootPath: "", projectName: "demo", currentFilePath: "a.ts", entries: [{ path: "a.ts", kind: "file", name: "a.ts" }] as never, truncated: false, failed: false, refreshFailed: true });
  expect(rows.map((row) => row.label)).toEqual(["a.ts", "Refresh failed. Retry"]);
});

test("a renamed folder leaves the tree with what was under it; a file beside it stays", async () => {
  const { dropRemovedTreePaths, removedTreePaths } = await import("./filesLogic");
  const removed = removedTreePaths(
    [{ path: "src", kind: "directory" }, { path: "src/lib", kind: "directory" }, { path: "a.ts", kind: "file" }, { path: "old", kind: "directory" }],
    [{ path: "src" }, { path: "a.ts" }, { path: "new" }],
  );
  expect(removed).toEqual(["old", "src/lib"]);
  const pruned = dropRemovedTreePaths({ "": 1, old: 2, "old/x": 3, src: 4 }, new Set(["old", "old/x", "src"]), removed);
  expect(Object.keys(pruned.listings)).toEqual(["", "src"]);
  expect([...pruned.expanded]).toEqual(["src"]);
});

test("a file comment becomes a File comment record with its lines and the file's fence language", async () => {
  const { fileReviewCommentRecord, inferFenceLanguage } = await import("./fileComments");
  const record = fileReviewCommentRecord({ id: "c1", startLine: 3, endLine: 2, text: " look " }, "src/a.ts", "one\ntwo\nthree\nfour");
  expect([record.sectionTitle, record.rangeLabel, record.startIndex, record.endIndex, record.text, record.diff, record.fenceLanguage, record.label]).toEqual(["File comment", "L2 to L3", 1, 2, "look", "two\nthree", "ts", "a.ts L2 to L3"]);
  expect(inferFenceLanguage(".env")).toBe("env");
  expect(inferFenceLanguage("Makefile")).toBe("text");
});
