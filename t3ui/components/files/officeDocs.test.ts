import { expect, test } from "nsh/test";
import { base64Bytes } from "./binaryFixtures";
import { columnIndex, officeFormat, openOfficeDocument, parseOpenDocumentXml, resolvePart, type DocBlock, type OfficeResult } from "./officeDocs";
import { DOCX_BASE64, EPUB_BASE64, ODS_BASE64, ODT_BASE64, PPTX_BASE64, XLSX_BASE64 } from "./officeFixtures";
import { decodeEntities, findAll, parseXml, textOf } from "./xml";

const summary = (block: DocBlock): string => {
  if (block.kind === "heading") return `h${block.level}:${block.runs.map((run) => run.text).join("")}`;
  if (block.kind === "paragraph") return `p:${block.runs.map((run) => `${run.bold ? "*" : ""}${run.italic ? "_" : ""}${run.code ? "`" : ""}${run.text}`).join("|")}`;
  if (block.kind === "item") return `item${block.depth}${block.marker}:${block.runs.map((run) => run.text).join("")}`;
  if (block.kind === "table") return `table:${block.rows.map((row) => row.join(",")).join(";")}`;
  if (block.kind === "code") return `code:${block.text}`;
  return "rule";
};
const documentOf = (result: OfficeResult) => { if (result.type !== "document") throw new Error("expected a document"); return result; };

test("the xml reader keeps prefixed names, text, entities, CDATA and ignores comments and doctypes", () => {
  const root = parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a:r id="1" t=\'q&amp;\'><!-- note --><b>one &amp; two &#65;&#x42; &nbsp;|</b><![CDATA[<raw>]]><c/><d>x</d></a:r>');
  const node = root.children[0]!;
  expect(node.name).toBe("a:r");
  expect(node.attrs).toEqual({ id: "1", t: "q&" });
  expect(textOf(node)).toBe("one & two AB  |<raw>x");
  expect(findAll(root, "d").length).toBe(1);
  expect(decodeEntities("&lt;&unknown;&#0;")).toBe("<&unknown;");
  expect(() => parseXml("<a><!-- open")).toThrow("invalid XML");
});

test("office files are told apart by extension and parts resolve against their holder", () => {
  expect(officeFormat("x.DOCX")).toBe("docx");
  expect(officeFormat("x.epub")).toBe("epub");
  expect(officeFormat("x.txt")).toBe(null);
  expect(resolvePart("xl/workbook.xml", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
  expect(resolvePart("xl/workbook.xml", "/xl/worksheets/sheet2.xml")).toBe("xl/worksheets/sheet2.xml");
  expect(resolvePart("OEBPS/content.opf", "../images/a.png")).toBe("images/a.png");
  expect(columnIndex("A1")).toBe(0);
  expect(columnIndex("AA10")).toBe(26);
});

test("a docx gives headings, styled paragraphs, lists and a table", () => {
  const result = documentOf(openOfficeDocument("t.docx", base64Bytes(DOCX_BASE64)));
  expect(result.navigation).toBe("page");
  const lines = result.pages[0]!.blocks.map(summary);
  expect(lines).toContain("h1:Overview");
  expect(lines).toContain("p:A paragraph with |*bold|, |_italic| and code text.");
  expect(lines).toContain("item0•:first bullet");
  expect(lines).toContain("item01.:step one");
  expect(lines).toContain("item02.:step two");
  expect(lines).toContain("table:Name,Qty;Apples,3;Pears,12");
  expect(lines).toContain("h2:Details");
  expect(lines.some((line) => line.includes("Final paragraph."))).toBe(true);
});

test("an odt gives the same content", () => {
  const result = documentOf(openOfficeDocument("t.odt", base64Bytes(ODT_BASE64)));
  const lines = result.pages[0]!.blocks.map(summary);
  expect(lines.some((line) => line.startsWith("h1:Overview"))).toBe(true);
  expect(lines.some((line) => line.includes("*bold"))).toBe(true);
  expect(lines).toContain("item0\u2022:first bullet");
  expect(lines).toContain("item01.:step one");
  expect(lines).toContain("table:Name,Qty;Apples,3;Pears,12");
});

test("an epub gives its chapters from the spine", () => {
  const result = documentOf(openOfficeDocument("t.epub", base64Bytes(EPUB_BASE64)));
  expect(result.navigation).toBe("chapter");
  expect(result.pages.length).toBeGreaterThan(0);
  const lines = result.pages.flatMap((page) => page.blocks.map(summary));
  expect(lines).toContain("h1:Overview");
  expect(lines.some((line) => line.startsWith("p:A paragraph with"))).toBe(true);
  expect(lines).toContain("item0•:first bullet");
  expect(lines).toContain("table:Name,Qty;Apples,3;Pears,12");
  expect(lines).toContain("p:A quoted line.");
});

test("a pptx gives one page per slide with its title", () => {
  const result = documentOf(openOfficeDocument("t.pptx", base64Bytes(PPTX_BASE64)));
  expect(result.navigation).toBe("slide");
  expect(result.pages.map((page) => page.title)).toEqual(["Deck title", "First slide", "Second slide"]);
  expect(result.pages[1]!.blocks.map(summary)).toEqual(["h2:First slide", "item0•:point one", "item0•:point two"]);
  expect(result.pages[2]!.blocks.map(summary)).toContain("p:Body text here.");
});

test("an xlsx gives sheets of cell values, with shared and inline strings, gaps, booleans and errors", () => {
  const result = openOfficeDocument("t.xlsx", base64Bytes(XLSX_BASE64));
  if (result.type !== "sheets") throw new Error("expected sheets");
  expect(result.names).toEqual(["Budget & Plan", "Empty"]);
  const sheet = result.load(0);
  expect(sheet.rows).toEqual([["Item", "Rich text", "", "inline"], [], ["Total", "42.5", "TRUE", "", "#DIV/0!"]]);
  expect(sheet.rowCount).toBe(3);
  expect(sheet.columns).toBe(5);
  expect(sheet.truncated).toBe(false);
  expect(result.load(1).rows).toEqual([]);
  expect(() => result.load(5)).toThrow("This sheet is unavailable.");
});

test("an ods repeats cells, drops trailing empties and keeps a gap before later rows", () => {
  const result = openOfficeDocument("t.ods", base64Bytes(ODS_BASE64));
  if (result.type !== "sheets") throw new Error("expected sheets");
  expect(result.names).toEqual(["Sheet One"]);
  const sheet = result.load(0);
  expect(sheet.rows).toEqual([["Name", "7", "same", "same"], [], [], [], ["after gap"]]);
});

test("a file that is not a document says so", () => {
  expect(() => openOfficeDocument("x.docx", new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow("This is not a readable ZIP archive.");
  expect(() => openOfficeDocument("x.txt", new Uint8Array(4))).toThrow("can't be previewed");
  expect(() => openOfficeDocument("x.docx", base64Bytes(XLSX_BASE64))).toThrow("This document is missing a required part.");
});

test("OpenDocument and EPUB parts follow extendedDocumentPreview's XML limits and copy", () => {
  // An external DTD is dropped without being resolved; an internal subset or an entity is refused.
  expect(findAll(parseOpenDocumentXml('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>x</p></body></html>'), "p").length).toBe(1);
  expect(() => parseOpenDocumentXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow("This document contains invalid or unsupported XML.");
  expect(() => parseOpenDocumentXml(`${"<a>".repeat(102)}${"</a>".repeat(102)}`)).toThrow("This document is nested too deeply to preview.");
  expect(() => parseOpenDocumentXml(`<r>${"<i/>".repeat(100_001)}</r>`)).toThrow("This document has too much content to preview.");
});

test("rtf reads like extendedDocumentPreview's openRtf: runs, paragraphs, pages, escapes and limits", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const result = documentOf(openOfficeDocument("note.rtf", encode("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;\\red0;}Hello {\\b bold} \\i it\\i0 \\'e9\\par Second\\u8212? line\\page Next}")));
  expect(result.navigation).toBe("page");
  expect(result.pages.map((page) => page.title)).toEqual(["Page 1", "Page 2"]);
  expect(result.pages[0]!.blocks.map(summary)).toEqual(["p:Hello |*bold| |_it|é", "p:Second— line"]);
  expect(result.pages[1]!.blocks.map(summary)).toEqual(["p:Next"]);
  expect(() => openOfficeDocument("x.rtf", encode("plain text"))).toThrow("This is not a valid rich text document.");
  expect(() => openOfficeDocument("x.rtf", encode("{\\rtf1 open"))).toThrow("This rich text document is damaged.");
  expect(() => openOfficeDocument("x.rtf", encode("{\\rtf1 \\'zz}"))).toThrow("Invalid rich text byte escape.");
  expect(officeFormat("a.RTF")).toBe("rtf");
});

test("OpenDocument XML is refused when tags do not match, as XMLValidator refuses it", () => {
  expect(() => parseOpenDocumentXml("<a><b></a></b>")).toThrow("This document contains invalid or unsupported XML.");
  expect(() => parseOpenDocumentXml("<a><b>")).toThrow("This document contains invalid or unsupported XML.");
  expect(() => parseOpenDocumentXml("<a></b>")).toThrow("This document contains invalid or unsupported XML.");
  expect(parseOpenDocumentXml("<a><br/><b>x</b></a>").children[0]!.name).toBe("a");
  // The lenient reader used for Open XML parts still closes the nearest match.
  expect(textOf(parseXml("<a><b>x</a>"))).toBe("x");
});
