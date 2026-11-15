import { expect, test } from "nsh/test";
import { breadcrumbChildren, breadcrumbMenuRows, breadcrumbParent, fileBreadcrumbs } from "./breadcrumbs";
import { columnWidths, delimiterOf, parseDelimited } from "./delimited";
import { absoluteFilePath, draftWithMention, fileMenuItems, launchInput, readMenuCapabilities } from "./fileActions";
import { audioPreviewHtml, folderFileUrl, fontPreviewHtml, filePreviewKind, hostedInWebView, readsAsText, showsRawText, unsupportedMessage } from "./filePreviewKind";
import { readDirectoryListing } from "./filesLogic";
import { parseNotebook } from "./notebook";

test("files pick their viewer by extension", () => {
  expect(filePreviewKind("a/b.PDF")).toBe("pdf");
  expect(filePreviewKind("x.mp3")).toBe("audio");
  expect(filePreviewKind("data.tsv")).toBe("table");
  expect(filePreviewKind("n.ipynb")).toBe("notebook");
  expect(filePreviewKind("f.woff2")).toBe("font");
  expect(filePreviewKind("r.docx")).toBe("office");
  expect(filePreviewKind("a.zip")).toBe("archive");
  expect(filePreviewKind("README.md")).toBe("markdown");
  expect(filePreviewKind("logo.svg")).toBe("image");
  expect(filePreviewKind("main.ts")).toBe("text");
  expect(readsAsText("table")).toBe(true);
  expect(readsAsText("pdf")).toBe(false);
  expect(hostedInWebView("font")).toBe(true);
  expect(hostedInWebView("table")).toBe(false);
  expect(showsRawText("text", false)).toBe(true);
  expect(showsRawText("markdown", true)).toBe(false);
  expect(showsRawText("table", true)).toBe(false);
  expect(unsupportedMessage("office")).toContain("Open it in an editor");
  expect(unsupportedMessage("text")).toBe("The file is binary and cannot be displayed as text.");
});

test("webview pages name the file relative to its folder", () => {
  expect(folderFileUrl("/work/app/", "docs/a b/c.mp3")).toBe("file:///work/app/docs/a%20b/");
  expect(folderFileUrl("/work/app", "c.ttf")).toBe("file:///work/app/");
  expect(audioPreviewHtml("a b.mp3")).toContain('src="a%20b.mp3"');
  expect(fontPreviewHtml("x.ttf")).toContain('url("x.ttf")');
});

test("csv and tsv parse quotes, escaped quotes, embedded newlines and CRLF", () => {
  const table = parseDelimited('a,b,c\r\n"x, y","say ""hi""","l1\nl2"\r\n1,,3', ",");
  expect(table.rows).toEqual([["a", "b", "c"], ["x, y", 'say "hi"', "l1\nl2"], ["1", "", "3"]]);
  expect(table.omitted).toBe(0);
  expect(parseDelimited("a\tb\n1\t2\n", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
  expect(delimiterOf("x.TSV")).toBe("\t");
  const long = parseDelimited("a\nb\nc\nd", ",", 2);
  expect(long.rows.length).toBe(2);
  expect(long.omitted).toBe(2);
  expect(columnWidths([["abc", "x".repeat(100)], ["abcdef", "y"]])).toEqual([6, 40]);
});

test("a notebook reads markdown, code, outputs and errors", () => {
  const notebook = parseNotebook(JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { language: "python" } },
    cells: [
      { cell_type: "markdown", id: "m", source: ["# Title\n", "text"] },
      { cell_type: "code", execution_count: 2, source: "print(1)", outputs: [
        { output_type: "stream", name: "stdout", text: ["1\n"] },
        { output_type: "execute_result", data: { "text/plain": "3" } },
        { output_type: "display_data", data: { "image/png": "AAAA\n" } },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mValueError\u001b[0m: bad"] },
      ] },
    ],
  }));
  expect(notebook.language).toBe("python");
  expect(notebook.cells[0]).toMatchObject({ type: "markdown", source: "# Title\ntext", id: "m" });
  expect(notebook.cells[1]!.executionCount).toBe(2);
  expect(notebook.cells[1]!.outputs).toEqual([
    { kind: "text", text: "1\n", stream: "stdout" },
    { kind: "text", text: "3" },
    { kind: "image", src: "data:image/png;base64,AAAA" },
    { kind: "error", text: "ValueError: bad" },
  ]);
  expect(() => parseNotebook("nope")).toThrow("not valid JSON");
  // extendedDocumentPreview's openNotebook copy and limits.
  expect(() => parseNotebook("{}")).toThrow("Preview supports version 4 notebooks with up to 500 cells.");
  expect(() => parseNotebook(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 501 }, () => ({ cell_type: "raw", source: "" })) }))).toThrow("Preview supports version 4 notebooks with up to 500 cells.");
  expect(() => parseNotebook(JSON.stringify({ nbformat: 4, cells: [{ cell_type: "code", source: "", outputs: Array.from({ length: 101 }, () => ({ output_type: "stream", text: "x" })) }] }))).toThrow("A notebook cell has too many outputs to preview.");
  expect(() => parseNotebook(JSON.stringify({ nbformat: 4, cells: [{ cell_type: "raw", source: "x".repeat(256_001) }] }))).toThrow("A notebook cell is too large to preview.");
});

test("the files context menu follows the reference's order and the launch contract", () => {
  const capabilities = readMenuCapabilities({ availableEditors: ["cursor", "vscode", "file-manager"], shellRevealInFileManager: true }, "macos");
  const items = fileMenuItems(capabilities);
  expect(items.map((item) => item.label)).toEqual(["Open", "Reveal in Finder", "Open with", "Copy mention", "Add to chat"]);
  expect(items[2]!.children!.map((item) => item.label)).toEqual(["Cursor", "VS Code"]);
  expect(fileMenuItems(readMenuCapabilities({}, "macos")).map((item) => item.label)).toEqual(["Copy mention", "Add to chat"]);
  const path = absoluteFilePath("/work/app/", "src/a.ts");
  expect(path).toBe("/work/app/src/a.ts");
  expect(launchInput({ id: "reveal" }, path)).toEqual({ cwd: path, editor: "file-manager", reveal: true });
  expect(launchInput({ id: "editor", editor: "zed" }, path)).toEqual({ cwd: path, editor: "zed" });
  expect(launchInput({ id: "add-to-chat" }, path)).toBeNull();
  expect(draftWithMention("", "[a](a)")).toBe("[a](a) ");
  expect(draftWithMention("look at", "[a](a)")).toBe("look at [a](a) ");
  expect(draftWithMention("look at ", "[a](a)")).toBe("look at [a](a) ");
});

test("breadcrumbs list sibling folders, go back, and word the empty and loading states", () => {
  expect(fileBreadcrumbs("demo", "src/lib/util.ts").map((crumb) => crumb.path)).toEqual(["", "src", "src/lib", "src/lib/util.ts"]);
  expect(breadcrumbParent("src/lib")).toBe("src");
  expect(breadcrumbParent("src")).toBe("");
  expect(breadcrumbParent("")).toBeNull();
  const listing = readDirectoryListing({ entries: [{ path: "src/lib", kind: "directory" }, { path: "src/main.ts", kind: "file" }, { path: "src/lib/util.ts", kind: "file" }, { path: "src/a.ts", kind: "file" }], truncated: false });
  expect(breadcrumbChildren(listing.entries, "src").map((entry) => entry.name)).toEqual(["lib", "a.ts", "main.ts"]);
  const rows = breadcrumbMenuRows({ directoryPath: "src", rootPath: "src", projectName: "demo", currentFilePath: "src/main.ts", entries: listing.entries, truncated: false, failed: false });
  expect(rows.map((row) => row.label)).toEqual(["lib", "a.ts", "main.ts"]);
  expect(rows[2]!.current).toBe(true);
  const deeper = breadcrumbMenuRows({ directoryPath: "src/lib", rootPath: "src", projectName: "demo", currentFilePath: "", entries: listing.entries, truncated: true, failed: false });
  expect(deeper[0]).toMatchObject({ kind: "back", label: "Back to src", path: "src" });
  expect(deeper[deeper.length - 1]!.label).toBe("Some workspace entries are not shown.");
  expect(breadcrumbMenuRows({ directoryPath: "src", rootPath: "src", projectName: "demo", currentFilePath: "", entries: null, truncated: false, failed: false })[0]!.label).toBe("Loading folder…");
  expect(breadcrumbMenuRows({ directoryPath: "src", rootPath: "src", projectName: "demo", currentFilePath: "", entries: null, truncated: false, failed: true })[0]).toMatchObject({ label: "Retry loading folder", disabled: false });
  expect(breadcrumbMenuRows({ directoryPath: "x", rootPath: "x", projectName: "demo", currentFilePath: "", entries: [], truncated: false, failed: false })[0]!.label).toBe("This folder is empty.");
});

test("fm13: HEIF and TIFF previews keep imageDecode.worker's 32 MP / 16,384 px bounds; rtf opens as an office document", async () => {
  const { decodedImageFits, decodedImageKind } = await import("./ImagePreview");
  expect(decodedImageKind("a.HEIC")).toBe(true);
  expect(decodedImageKind("a.tif")).toBe(true);
  expect(decodedImageKind("a.png")).toBe(false);
  expect(decodedImageFits(4000, 3000)).toBe(true);
  expect(decodedImageFits(16385, 10)).toBe(false);
  expect(decodedImageFits(8000, 8000)).toBe(false);
  expect(decodedImageFits(0, 10)).toBe(false);
  expect(filePreviewKind("notes.rtf")).toBe("office");
});
