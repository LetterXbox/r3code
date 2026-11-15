import { expect, test } from "nsh/test";
import { clampExplorerWidth, explorerMaxWidth, isHostPath, shouldShowFileExplorer } from "./explorerState";
import { retainedBreadcrumbTrail, trailChildOf } from "./folderTrail";
import { indexLargeText, largeRevealIndex, largeTextSummary } from "./largeText";

const bytes = (text: string) => new TextEncoder().encode(text);

test("a large file is indexed into lines that decode on demand", () => {
  const text = indexLargeText(bytes("one\r\ntwo\n\nfour\r"), null);
  expect(text.count).toBe(4);
  expect([0, 1, 2, 3].map((index) => text.record(index))).toEqual(["one", "two", "", "four"]);
  expect(indexLargeText(bytes("a\nb\n"), null).count).toBe(2);
  expect(indexLargeText(bytes(""), null).count).toBe(0);
  expect(() => indexLargeText(new Uint8Array([97, 0, 98]), null)).toThrow("binary data");
});

test("a million lines index in one pass and read any row", () => {
  const text = indexLargeText(bytes("row\n".repeat(1_000_000)), null);
  expect(text.count).toBe(1_000_000);
  expect(text.record(999_999)).toBe("row");
});

test("a delimited file's records follow its quoting", () => {
  const text = indexLargeText(bytes('name,note\n"a, b","line1\nline2"\nz,y\n'), ",");
  expect(text.count).toBe(3);
  expect(text.cells(0)).toEqual(["name", "note"]);
  expect(text.cells(1)).toEqual(["a, b", "line1\nline2"]);
  expect(text.columns).toBe(2);
  expect(largeTextSummary(text, ",", (size) => `${size} B`)).toBe("2 rows · 2 columns · 35 B");
  expect(largeTextSummary(indexLargeText(bytes("a\nb\n"), null), null, () => "4 B")).toBe("2 lines · 4 B");
});

test("a requested line becomes a clamped row", () => {
  expect(largeRevealIndex(5, 3)).toBe(2);
  expect(largeRevealIndex(0, 3)).toBe(0);
  expect(largeRevealIndex(null, 3)).toBe(null);
});

test("the explorer pane is 160 to 560 wide and leaves the file 256", () => {
  expect(explorerMaxWidth(1000)).toBe(560);
  expect(explorerMaxWidth(540)).toBe(284);
  expect(explorerMaxWidth(300)).toBe(160);
  expect(clampExplorerWidth(100, 400)).toBe(160);
  expect(clampExplorerWidth(900, 400)).toBe(400);
  expect(shouldShowFileExplorer({ relativePath: "a.ts", explorerOpen: false, attachmentOpen: false })).toBe(false);
  expect(shouldShowFileExplorer({ relativePath: null, explorerOpen: false, attachmentOpen: false })).toBe(true);
  expect(shouldShowFileExplorer({ relativePath: "/etc/hosts", explorerOpen: true, attachmentOpen: false })).toBe(false);
  expect(shouldShowFileExplorer({ relativePath: "a.ts", explorerOpen: true, attachmentOpen: true })).toBe(false);
  expect(isHostPath("~/x")).toBe(true);
  expect(isHostPath("src/x")).toBe(false);
});

test("the folder trail is kept while it passes through the folder and reset otherwise", () => {
  expect(retainedBreadcrumbTrail("src/lib/deep", "src")).toBe("src/lib/deep");
  expect(retainedBreadcrumbTrail("src/lib/deep", "other")).toBe("other");
  expect(retainedBreadcrumbTrail(undefined, "src")).toBe("src");
  expect(trailChildOf("src", "src/lib/deep")).toBe("lib");
  expect(trailChildOf("", "src/lib")).toBe("src");
  expect(trailChildOf("nope", "src/lib")).toBe(null);
});
