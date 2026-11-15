// Office documents as text and tables (files/OfficeViewer.tsx and extendedDocumentPreview.ts in the web app). docx, xlsx and
// pptx are read from their Open XML parts, odt, ods and odp from content.xml, epub from its spine. The web app lays docx, xlsx and
// pptx out on pages with a WebAssembly engine; this reads the same documents into headings, paragraphs, lists, tables, sheets of
// cell values and slides of text, the way it already shows odt, odp and epub (its own notice: "Text and images. Layout and embedded
// objects may differ from the original."). Images, charts and page layout are not drawn. Pure, so it is tested without an engine.
import { openZip, type OpenArchive } from "./archiveReader";
import { childrenNamed, findAll, firstChild, parseXml, textOf, type XmlNode } from "./xml";

export const OFFICE_MAX_BYTES = 50 * 1024 * 1024;
export const SHEET_MAX_ROWS = 250_000;
export const SHEET_MAX_COLUMNS = 1024;
export const ODS_MAX_ROWS = 500;
export const ODS_MAX_COLUMNS = 50;
const CELL_MAX = 32_767;
const PAGES_MAX = 500;

export type OfficeFormat = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "rtf" | "epub";

export function officeFormat(name: string): OfficeFormat | null {
  const match = /\.(docx|xlsx|pptx|odt|ods|odp|rtf|epub)$/i.exec(name);
  return match ? (match[1]!.toLowerCase() as OfficeFormat) : null;
}

export interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean }
export type DocBlock =
  | { kind: "heading"; level: number; runs: Run[] }
  | { kind: "paragraph"; runs: Run[]; quote?: boolean }
  | { kind: "item"; runs: Run[]; depth: number; marker: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "rule" };
export interface DocPage { title: string; blocks: DocBlock[] }

export interface SheetData { name: string; rows: string[][]; rowCount: number; columns: number; truncated: boolean }

export type OfficeResult =
  | { type: "document"; navigation: "page" | "slide" | "chapter"; pages: DocPage[] }
  | { type: "sheets"; names: string[]; load(index: number): SheetData; limited: string };

const plain = (text: string, extra: Partial<Run> = {}): Run => ({ text, ...extra });
const runsText = (runs: readonly Run[]) => runs.map((run) => run.text).join("");

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.underline === run.underline && last.strike === run.strike && last.code === run.code) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

const partSets = new WeakMap<OpenArchive, Set<string>>();
function hasPart(zip: OpenArchive, path: string): boolean {
  let set = partSets.get(zip);
  if (!set) { set = new Set(zip.entries.map((entry) => entry.path)); partSets.set(zip, set); }
  return set.has(path);
}
function required(zip: OpenArchive, path: string): string {
  if (!hasPart(zip, path)) throw new Error("This document is missing a required part.");
  return new TextDecoder().decode(zip.read(path));
}
const optional = (zip: OpenArchive, path: string): string | null => (hasPart(zip, path) ? new TextDecoder().decode(zip.read(path)) : null);

const UNSUPPORTED_XML = "This document contains invalid or unsupported XML.";
/** extendedDocumentPreview's parseXml for OpenDocument and EPUB parts: an external DTD is dropped unresolved; a part over
 * 8 MB, one declaring a DTD or entities, or invalid XML is refused; deeper than 100 levels or over 100,000 nodes is too much. */
export function parseOpenDocumentXml(source: string): XmlNode {
  const text = source.replace(/<!DOCTYPE\s+[^<>[\]]*>/giu, "");
  if (text.length > 8 * 1024 * 1024 || /<!\s*(DOCTYPE|ENTITY)/iu.test(text)) throw new Error(UNSUPPORTED_XML);
  let root: XmlNode;
  try { root = parseXml(text, { strict: true }); } catch (cause) {
    if (cause instanceof Error && cause.message === "This document contains invalid XML.") throw new Error(UNSUPPORTED_XML);
    throw cause;
  }
  let count = 0;
  const walk = (node: XmlNode, depth: number) => {
    if (depth > 100) throw new Error("This document is nested too deeply to preview.");
    for (const child of node.children) {
      if (++count > 100_000) throw new Error("This document has too much content to preview.");
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return root;
}

/** Resolves a relationship target against the part that holds it ("../x" and absolute "/x" included). */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function relationships(zip: OpenArchive, part: string): Map<string, string> {
  const folder = part.slice(0, part.lastIndexOf("/") + 1);
  const source = optional(zip, `${folder}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`);
  const map = new Map<string, string>();
  if (!source) return map;
  for (const rel of findAll(parseXml(source), "Relationship")) if (rel.attrs.Id && rel.attrs.Target) map.set(rel.attrs.Id, resolvePart(part, rel.attrs.Target));
  return map;
}

// --- docx ---------------------------------------------------------------------------------------

function flag(node: XmlNode | undefined): boolean {
  if (!node) return false;
  const value = node.attrs["w:val"];
  return value === undefined || !(value === "0" || value === "false" || value === "none");
}

function wordRuns(paragraph: XmlNode): { runs: Run[]; pageBreak: boolean } {
  const runs: Run[] = [];
  let pageBreak = false;
  const walk = (node: XmlNode, base: Partial<Run>) => {
    for (const child of node.children) {
      if (child.name === "w:r") {
        const props = firstChild(child, "w:rPr");
        const style: Partial<Run> = {
          ...base,
          ...(flag(props && firstChild(props, "w:b")) ? { bold: true } : {}),
          ...(flag(props && firstChild(props, "w:i")) ? { italic: true } : {}),
          ...(flag(props && firstChild(props, "w:u")) ? { underline: true } : {}),
          ...(flag(props && firstChild(props, "w:strike")) ? { strike: true } : {}),
        };
        for (const part of child.children) {
          if (part.name === "w:t") runs.push(plain(textOf(part), style));
          else if (part.name === "w:tab") runs.push(plain("\t", style));
          else if (part.name === "w:noBreakHyphen") runs.push(plain("-", style));
          else if (part.name === "w:br" || part.name === "w:cr") {
            if (part.attrs["w:type"] === "page") pageBreak = true;
            else runs.push(plain("\n", style));
          }
        }
      } else if (child.name === "w:hyperlink" || child.name === "w:ins" || child.name === "w:smartTag" || child.name === "w:sdt" || child.name === "w:sdtContent" || child.name === "w:fldSimple") walk(child, base);
    }
  };
  walk(paragraph, {});
  return { runs: mergeRuns(runs), pageBreak };
}

function openDocx(zip: OpenArchive): OfficeResult {
  const root = parseXml(required(zip, "word/document.xml"));
  const body = findAll(root, "w:body")[0];
  if (!body) throw new Error("This document has no readable content.");
  // numbering.xml: which list levels count (decimal, letters, roman) and which bullet.
  const formats = new Map<string, string>();
  const numbering = optional(zip, "word/numbering.xml");
  if (numbering) {
    const doc = parseXml(numbering);
    const abstracts = new Map<string, Map<string, string>>();
    for (const abstract of findAll(doc, "w:abstractNum")) {
      const levels = new Map<string, string>();
      for (const level of childrenNamed(abstract, "w:lvl")) levels.set(level.attrs["w:ilvl"] ?? "0", firstChild(level, "w:numFmt")?.attrs["w:val"] ?? "bullet");
      abstracts.set(abstract.attrs["w:abstractNumId"] ?? "", levels);
    }
    for (const num of findAll(doc, "w:num")) {
      const levels = abstracts.get(firstChild(num, "w:abstractNumId")?.attrs["w:val"] ?? "");
      if (levels) for (const [level, format] of levels) formats.set(`${num.attrs["w:numId"] ?? ""}:${level}`, format);
    }
  }
  const counters = new Map<string, number>();
  const pages: DocPage[] = [];
  let blocks: DocBlock[] = [];
  const endPage = () => { pages.push({ title: `Page ${pages.length + 1}`, blocks }); blocks = []; };
  const visit = (parent: XmlNode) => {
    for (const node of parent.children) {
      if (node.name === "w:p") {
        const props = firstChild(node, "w:pPr");
        const style = firstChild(props ?? node, "w:pStyle")?.attrs["w:val"] ?? "";
        const { runs, pageBreak } = wordRuns(node);
        const heading = /^heading\s*([1-9])$/i.exec(style)?.[1];
        const numbering = props ? firstChild(props, "w:numPr") : undefined;
        if (heading) blocks.push({ kind: "heading", level: Number(heading), runs });
        else if (/^title$/i.test(style)) blocks.push({ kind: "heading", level: 1, runs });
        else if (/^subtitle$/i.test(style)) blocks.push({ kind: "heading", level: 2, runs });
        else if (numbering && runs.length > 0) {
          const level = firstChild(numbering, "w:ilvl")?.attrs["w:val"] ?? "0";
          const id = firstChild(numbering, "w:numId")?.attrs["w:val"] ?? "";
          const format = formats.get(`${id}:${level}`) ?? "bullet";
          const key = `${id}:${level}`;
          const count = (counters.get(key) ?? 0) + 1;
          counters.set(key, count);
          for (const other of [...counters.keys()]) if (other.startsWith(`${id}:`) && Number(other.split(":")[1]) > Number(level)) counters.delete(other);
          blocks.push({ kind: "item", runs, depth: Number(level) || 0, marker: format === "bullet" || format === "none" ? "•" : `${format === "lowerLetter" ? String.fromCharCode(96 + ((count - 1) % 26) + 1) : format === "upperLetter" ? String.fromCharCode(64 + ((count - 1) % 26) + 1) : count}.` });
        } else if (runs.length > 0) blocks.push({ kind: "paragraph", runs });
        else blocks.push({ kind: "paragraph", runs: [plain("")] });
        if (pageBreak) endPage();
      } else if (node.name === "w:tbl") {
        const rows = childrenNamed(node, "w:tr").map((row) => childrenNamed(row, "w:tc").map((cell) => findAll(cell, "w:p").map((paragraph) => runsText(wordRuns(paragraph).runs)).join("\n")));
        blocks.push({ kind: "table", rows });
      } else if (node.name === "w:sdt") {
        const content = firstChild(node, "w:sdtContent");
        if (content) visit(content);
      }
    }
  };
  visit(body);
  if (blocks.length > 0 || pages.length === 0) endPage();
  if (pages.length > PAGES_MAX) throw new Error("This document has no pages or too many pages to preview.");
  return { type: "document", navigation: "page", pages };
}

// --- pptx ---------------------------------------------------------------------------------------

function slideParagraph(paragraph: XmlNode): Run[] {
  const runs: Run[] = [];
  for (const child of paragraph.children) {
    if (child.name === "a:r") {
      const props = firstChild(child, "a:rPr");
      runs.push(plain(textOf(firstChild(child, "a:t") ?? child), { ...(props?.attrs.b === "1" ? { bold: true } : {}), ...(props?.attrs.i === "1" ? { italic: true } : {}), ...(props?.attrs.u && props.attrs.u !== "none" ? { underline: true } : {}) }));
    } else if (child.name === "a:br") runs.push(plain("\n"));
    else if (child.name === "a:fld") runs.push(plain(textOf(firstChild(child, "a:t") ?? child)));
  }
  return mergeRuns(runs);
}

function openPptx(zip: OpenArchive): OfficeResult {
  const presentation = parseXml(required(zip, "ppt/presentation.xml"));
  const rels = relationships(zip, "ppt/presentation.xml");
  const slides = findAll(presentation, "p:sldId").map((slide) => rels.get(slide.attrs["r:id"] ?? "")).filter((path): path is string => Boolean(path));
  if (slides.length === 0 || slides.length > PAGES_MAX) throw new Error("This presentation has no slides or too many slides to preview.");
  const pages = slides.map((path, index): DocPage => {
    const tree = findAll(parseXml(required(zip, path)), "p:spTree")[0];
    const blocks: DocBlock[] = [];
    let title = "";
    const shapes = (parent: XmlNode) => {
      for (const node of parent.children) {
        if (node.name === "p:sp") {
          const placeholder = findAll(node, "p:ph")[0];
          const isTitle = placeholder !== undefined && /^(?:title|ctrTitle)$/.test(placeholder.attrs.type ?? "");
          const body = firstChild(node, "p:txBody");
          if (!body) continue;
          for (const paragraph of childrenNamed(body, "a:p")) {
            const runs = slideParagraph(paragraph);
            if (runs.length === 0) continue;
            if (isTitle) { title = title || runsText(runs); blocks.push({ kind: "heading", level: 2, runs }); }
            else if (placeholder) {
              const level = Number(firstChild(paragraph, "a:pPr")?.attrs.lvl ?? 0) || 0;
              blocks.push(firstChild(firstChild(paragraph, "a:pPr") ?? paragraph, "a:buNone") ? { kind: "paragraph", runs } : { kind: "item", runs, depth: level, marker: "•" });
            } else blocks.push({ kind: "paragraph", runs });
          }
        } else if (node.name === "p:graphicFrame") {
          const table = findAll(node, "a:tbl")[0];
          if (table) blocks.push({ kind: "table", rows: childrenNamed(table, "a:tr").map((row) => childrenNamed(row, "a:tc").map((cell) => findAll(cell, "a:p").map((paragraph) => runsText(slideParagraph(paragraph))).join("\n"))) });
        } else if (node.name === "p:grpSp") shapes(node);
      }
    };
    if (tree) shapes(tree);
    return { title: title || `Slide ${index + 1}`, blocks };
  });
  return { type: "document", navigation: "slide", pages };
}

// --- xlsx ---------------------------------------------------------------------------------------

/** "B3" -> column index 1. */
export function columnIndex(reference: string): number {
  let value = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    value = value * 26 + (code - 64);
  }
  return value - 1;
}

function openXlsx(zip: OpenArchive): OfficeResult {
  const workbook = parseXml(required(zip, "xl/workbook.xml"));
  const rels = relationships(zip, "xl/workbook.xml");
  const sheets = findAll(workbook, "sheet").map((sheet) => ({ name: sheet.attrs.name ?? "", path: rels.get(sheet.attrs["r:id"] ?? "") ?? "" })).filter((sheet) => sheet.path !== "");
  if (sheets.length === 0 || sheets.length > 100) throw new Error("This workbook has no sheets or too many sheets to preview.");
  let strings: string[] | null = null;
  const sharedStrings = () => {
    if (strings) return strings;
    const source = optional(zip, "xl/sharedStrings.xml");
    strings = source ? findAll(parseXml(source), "si").map((item) => textOf(item, "rPh")) : [];
    return strings;
  };
  return {
    type: "sheets",
    names: sheets.map((sheet, index) => sheet.name || `Sheet ${index + 1}`),
    limited: " Preview limited to 250,000 rows, 1,024 columns, and bounded cell text.",
    load(index) {
      const sheet = sheets[index];
      if (!sheet) throw new Error("This sheet is unavailable.");
      const root = parseXml(required(zip, sheet.path));
      const data = findAll(root, "sheetData")[0];
      const rows: string[][] = [];
      let truncated = false;
      let nextRow = 0;
      for (const row of data ? childrenNamed(data, "row") : []) {
        const at = row.attrs.r ? Number(row.attrs.r) - 1 : nextRow;
        nextRow = at + 1;
        if (at >= SHEET_MAX_ROWS) { truncated = true; break; }
        while (rows.length < at) rows.push([]);
        const cells: string[] = [];
        let nextColumn = 0;
        for (const cell of childrenNamed(row, "c")) {
          const column = cell.attrs.r ? columnIndex(cell.attrs.r) : nextColumn;
          nextColumn = column + 1;
          if (column >= SHEET_MAX_COLUMNS) { truncated = true; continue; }
          const kind = cell.attrs.t ?? "n";
          const value = firstChild(cell, "v");
          let text = "";
          if (kind === "inlineStr") text = textOf(firstChild(cell, "is") ?? cell, "rPh");
          else if (value) {
            const raw = textOf(value);
            text = kind === "s" ? (sharedStrings()[Number(raw)] ?? "") : kind === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
          }
          if (text.length > CELL_MAX) { text = text.slice(0, CELL_MAX); truncated = true; }
          while (cells.length < column) cells.push("");
          cells[column] = text;
        }
        while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
        rows[at] = cells;
      }
      return { name: sheet.name || `Sheet ${index + 1}`, rows, rowCount: rows.length, columns: rows.reduce((most, row) => Math.max(most, row.length), 1), truncated };
    },
  };
}

// --- OpenDocument ----------------------------------------------------------------------------------

function odfStyles(root: XmlNode): Map<string, Partial<Run>> {
  const styles = new Map<string, Partial<Run>>();
  for (const style of findAll(root, "style:style")) {
    const props = firstChild(style, "style:text-properties");
    if (!props || !style.attrs["style:name"]) continue;
    styles.set(style.attrs["style:name"], {
      ...(props.attrs["fo:font-weight"] === "bold" ? { bold: true } : {}),
      ...(props.attrs["fo:font-style"] === "italic" ? { italic: true } : {}),
      ...(props.attrs["style:text-underline-style"] && props.attrs["style:text-underline-style"] !== "none" ? { underline: true } : {}),
      ...(props.attrs["style:text-line-through-style"] && props.attrs["style:text-line-through-style"] !== "none" ? { strike: true } : {}),
    });
  }
  return styles;
}

function odfRuns(paragraph: XmlNode, styles: Map<string, Partial<Run>>): Run[] {
  const runs: Run[] = [];
  const walk = (node: XmlNode, base: Partial<Run>) => {
    for (const child of node.children) {
      if (child.name === "#text") runs.push(plain(child.text, base));
      else if (child.name === "text:span" || child.name === "text:a") walk(child, { ...base, ...(styles.get(child.attrs["text:style-name"] ?? "") ?? {}) });
      else if (child.name === "text:s") runs.push(plain(" ".repeat(Math.min(Number(child.attrs["text:c"] ?? 1) || 1, 200)), base));
      else if (child.name === "text:tab") runs.push(plain("\t", base));
      else if (child.name === "text:line-break") runs.push(plain("\n", base));
    }
  };
  walk(paragraph, { ...(styles.get(paragraph.attrs["text:style-name"] ?? "") ?? {}) });
  return mergeRuns(runs);
}

/** The names of the list styles whose first level counts (text:list-level-style-number) rather than bullets. */
const numberedLists = new WeakMap<XmlNode, Set<string>>();
function numberedListStyles(root: XmlNode): Set<string> {
  let names = numberedLists.get(root);
  if (!names) {
    names = new Set();
    for (const style of findAll(root, "text:list-style")) if (firstChild(style, "text:list-level-style-number")) names.add(style.attrs["style:name"] ?? "");
    numberedLists.set(root, names);
  }
  return names;
}

function odfBlocks(container: XmlNode, styles: Map<string, Partial<Run>>, blocks: DocBlock[], depth = 0, marker = "•", numbered = false, root: XmlNode = container) {
  let count = 0;
  for (const node of container.children) {
    if (node.name === "text:h") blocks.push({ kind: "heading", level: Math.min(6, Number(node.attrs["text:outline-level"] ?? 1) || 1), runs: odfRuns(node, styles) });
    else if (node.name === "text:p") {
      const runs = odfRuns(node, styles);
      if (depth > 0) { count += 1; blocks.push({ kind: "item", runs, depth: depth - 1, marker: numbered ? `${count}.` : marker }); }
      else blocks.push({ kind: "paragraph", runs: runs.length > 0 ? runs : [plain("")] });
    } else if (node.name === "text:list") {
      const style = node.attrs["text:style-name"] ?? "";
      odfBlocks(node, styles, blocks, depth + 1, "•", numberedListStyles(root).has(style) || (numbered && style === ""), root);
    } else if (node.name === "text:list-item" || node.name === "text:list-header" || node.name === "text:section" || node.name === "text:soft-page-break") odfBlocks(node, styles, blocks, depth, marker, numbered, root);
    else if (node.name === "table:table") blocks.push({ kind: "table", rows: findAll(node, "table:table-row").map((row) => row.children.filter((cell) => cell.name === "table:table-cell" || cell.name === "table:covered-table-cell").map((cell) => findAll(cell, "text:p").map((paragraph) => textOf(paragraph)).join("\n"))) });
  }
}

function repeated(value: string | undefined, max: number): number {
  const count = Number(value ?? 1);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("This spreadsheet contains invalid repeated cells.");
  return Math.min(count, max);
}

function openOdf(zip: OpenArchive, format: "odt" | "ods" | "odp"): OfficeResult {
  const content = optional(zip, "content.xml");
  if (!content) throw new Error("This OpenDocument file has no readable content.");
  const root = parseOpenDocumentXml(content);
  const styles = odfStyles(root);
  if (format === "ods") {
    const tables = findAll(root, "table:table");
    if (tables.length === 0 || tables.length > 100) throw new Error("This workbook has no sheets or too many sheets to preview.");
    return {
      type: "sheets",
      names: tables.map((table, index) => table.attrs["table:name"] || `Sheet ${index + 1}`),
      limited: ` Limited to ${ODS_MAX_ROWS} rows and ${ODS_MAX_COLUMNS} columns.`,
      load(index) {
        const table = tables[index];
        if (!table) throw new Error("This sheet is unavailable.");
        const rows: string[][] = [];
        let truncated = false;
        let pendingEmpty = 0;
        let cellBytes = 0;
        for (const row of findAll(table, "table:table-row")) {
          const cells: string[] = [];
          for (const cell of row.children.filter((child) => child.name === "table:table-cell" || child.name === "table:covered-table-cell")) {
            const value = findAll(cell, "text:p", "office:annotation").map((paragraph) => textOf(paragraph, "office:annotation")).join("\n") || cell.attrs["office:value"] || cell.attrs["office:date-value"] || cell.attrs["office:boolean-value"] || cell.attrs["office:string-value"] || "";
            const count = repeated(cell.attrs["table:number-columns-repeated"], ODS_MAX_COLUMNS + 1);
            if (value && cells.length + count > ODS_MAX_COLUMNS) truncated = true;
            for (let i = 0; i < count && cells.length < ODS_MAX_COLUMNS; i++) {
              if (value.length > 10_000) throw new Error("A spreadsheet cell is too large to preview.");
              cells.push(value);
            }
          }
          while (cells[cells.length - 1] === "") cells.pop();
          const count = repeated(row.attrs["table:number-rows-repeated"], ODS_MAX_ROWS + 1);
          if (cells.length === 0) { pendingEmpty = Math.min(ODS_MAX_ROWS + 1, pendingEmpty + count); continue; }
          while (pendingEmpty > 0 && rows.length < ODS_MAX_ROWS) { rows.push([]); pendingEmpty--; }
          pendingEmpty = 0;
          if (rows.length + count > ODS_MAX_ROWS) truncated = true;
          if (rows.length >= ODS_MAX_ROWS) break;
          for (let i = 0; i < count && rows.length < ODS_MAX_ROWS; i++) {
            cellBytes += cells.reduce((size, cell) => size + cell.length, 0);
            if (cellBytes > 8 * 1024 * 1024) throw new Error("This spreadsheet has too much text to preview.");
            rows.push(cells);
          }
        }
        return { name: table.attrs["table:name"] || `Sheet ${index + 1}`, rows, rowCount: rows.length, columns: rows.reduce((most, row) => Math.max(most, row.length), 1), truncated };
      },
    };
  }
  if (format === "odp") {
    const pages = findAll(root, "draw:page");
    if (pages.length === 0 || pages.length > PAGES_MAX) throw new Error("This document has no pages or too many pages to preview.");
    return {
      type: "document",
      navigation: "slide",
      pages: pages.map((page, index) => {
        const blocks: DocBlock[] = [];
        for (const frame of findAll(page, "draw:frame")) {
          const isTitle = frame.attrs["presentation:class"] === "title";
          const start = blocks.length;
          odfBlocks(frame, styles, blocks, 0, "\u2022", false, root);
          if (isTitle) for (let at = start; at < blocks.length; at++) { const block = blocks[at]!; if (block.kind === "paragraph") blocks[at] = { kind: "heading", level: 2, runs: block.runs }; }
        }
        return { title: page.attrs["draw:name"] || `Page ${index + 1}`, blocks };
      }),
    };
  }
  const body = findAll(root, "office:text")[0];
  if (!body) throw new Error("This document has no pages or too many pages to preview.");
  const blocks: DocBlock[] = [];
  odfBlocks(body, styles, blocks, 0, "\u2022", false, root);
  return { type: "document", navigation: "page", pages: [{ title: "Page 1", blocks }] };
}

// --- epub ---------------------------------------------------------------------------------------

function htmlRuns(node: XmlNode): Run[] {
  const runs: Run[] = [];
  const walk = (current: XmlNode, base: Partial<Run>) => {
    for (const child of current.children) {
      if (child.name === "#text") runs.push(plain(child.text.replace(/\s+/g, " "), base));
      else if (child.name === "br") runs.push(plain("\n", base));
      else if (child.name === "script" || child.name === "style") continue;
      else {
        const name = child.name.toLowerCase();
        walk(child, { ...base, ...(name === "strong" || name === "b" ? { bold: true } : {}), ...(name === "em" || name === "i" ? { italic: true } : {}), ...(name === "u" ? { underline: true } : {}), ...(name === "s" || name === "del" || name === "strike" ? { strike: true } : {}), ...(name === "code" || name === "kbd" || name === "tt" ? { code: true } : {}) });
      }
    }
  };
  walk(node, {});
  const merged = mergeRuns(runs);
  if (merged.length > 0) merged[0]!.text = merged[0]!.text.replace(/^\s+/, "");
  if (merged.length > 0) merged[merged.length - 1]!.text = merged[merged.length - 1]!.text.replace(/\s+$/, "");
  return merged.filter((run) => run.text !== "");
}

const BLOCK_TAGS = /^(?:p|div|section|article|aside|header|footer|nav|main|figure|figcaption|h[1-6]|ul|ol|li|blockquote|pre|table|hr|dl|dt|dd)$/i;

function htmlBlocks(container: XmlNode, blocks: DocBlock[], depth = 0, numbered = false, quote = false) {
  let inline: XmlNode[] = [];
  const flush = () => {
    if (inline.length === 0) return;
    const runs = htmlRuns({ name: "span", attrs: {}, children: inline, text: "" });
    inline = [];
    if (runs.length > 0) blocks.push({ kind: "paragraph", runs, ...(quote ? { quote: true } : {}) });
  };
  let count = 0;
  for (const node of container.children) {
    const name = node.name.toLowerCase();
    if (node.name === "#text" || !BLOCK_TAGS.test(name)) {
      if (name !== "script" && name !== "style" && name !== "head") inline.push(node);
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(name)) { const runs = htmlRuns(node); if (runs.length > 0) blocks.push({ kind: "heading", level: Number(name[1]), runs }); }
    else if (name === "p" || name === "dt" || name === "dd" || name === "figcaption") { const runs = htmlRuns(node); if (runs.length > 0) blocks.push({ kind: "paragraph", runs, ...(quote ? { quote: true } : {}) }); }
    else if (name === "hr") blocks.push({ kind: "rule" });
    else if (name === "pre") blocks.push({ kind: "code", text: textOf(node).replace(/\n$/, "") });
    else if (name === "blockquote") htmlBlocks(node, blocks, depth, numbered, true);
    else if (name === "ul" || name === "ol") htmlBlocks(node, blocks, depth + 1, name === "ol", quote);
    else if (name === "li") {
      count += 1;
      const nested = node.children.filter((child) => child.name === "ul" || child.name === "ol");
      const own: XmlNode = { ...node, children: node.children.filter((child) => child.name !== "ul" && child.name !== "ol") };
      const runs = htmlRuns(own);
      if (runs.length > 0) blocks.push({ kind: "item", runs, depth: Math.max(0, depth - 1), marker: numbered ? `${count}.` : "•" });
      for (const list of nested) htmlBlocks({ ...node, children: [list] }, blocks, depth, false, quote);
    } else if (name === "table") blocks.push({ kind: "table", rows: findAll(node, "tr").map((row) => row.children.filter((cell) => cell.name === "td" || cell.name === "th").map((cell) => textOf(cell).replace(/\s+/g, " ").trim())) });
    else htmlBlocks(node, blocks, depth, numbered, quote);
  }
  flush();
}

function openEpub(zip: OpenArchive): OfficeResult {
  const container = parseOpenDocumentXml(optional(zip, "META-INF/container.xml") ?? "");
  const rootfile = findAll(container, "rootfile")[0]?.attrs["full-path"];
  if (!rootfile || !hasPart(zip, rootfile)) throw new Error("This EPUB has no readable package.");
  const pack = parseOpenDocumentXml(required(zip, rootfile));
  const manifest = new Map(findAll(pack, "item").map((item) => [item.attrs.id ?? "", item]));
  const spine = findAll(pack, "itemref");
  if (spine.length === 0 || spine.length > PAGES_MAX) throw new Error("This EPUB has no chapters or too many chapters to preview.");
  const pages: DocPage[] = [];
  for (const itemref of spine) {
    const item = manifest.get(itemref.attrs.idref ?? "");
    if (!item || item.attrs["media-type"] !== "application/xhtml+xml") continue;
    const path = resolvePart(rootfile, decodeURIComponent((item.attrs.href ?? "").split("#")[0] ?? ""));
    if (!hasPart(zip, path)) continue;
    const chapter = parseOpenDocumentXml(new TextDecoder().decode(zip.read(path)));
    const body = findAll(chapter, "body")[0] ?? chapter;
    const blocks: DocBlock[] = [];
    htmlBlocks(body, blocks);
    const title = textOf(findAll(chapter, "title")[0] ?? findAll(chapter, "h1")[0] ?? { name: "#text", attrs: {}, children: [], text: "" }).trim().slice(0, 120);
    pages.push({ title: title || `Chapter ${pages.length + 1}`, blocks });
  }
  if (pages.length === 0) throw new Error("This EPUB has no readable XHTML chapters.");
  return { type: "document", navigation: "chapter", pages };
}


const RTF_FONT_CHARSETS: Record<number, string> = { 77: "macintosh", 128: "shift_jis", 129: "euc-kr", 134: "gbk", 136: "big5", 161: "windows-1253", 162: "windows-1254", 163: "windows-1258", 177: "windows-1255", 178: "windows-1256", 186: "windows-1257", 204: "windows-1251", 222: "windows-874", 238: "windows-1250", 255: "ibm866" };
const RTF_CODE_PAGES: Record<number, string> = { 65001: "utf-8", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 874: "windows-874" };
const RTF_SKIPPED = new Set(["colortbl", "stylesheet", "info", "pict", "object", "fldinst", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "filetbl", "datastore", "themedata"]);
const RTF_TEXT_MAX = 8 * 1024 * 1024;

/** extendedDocumentPreview's openRtf: the same reader and limits, building paragraphs of runs where the web app builds HTML
 * (each \par, \line or \row is a line break there, a new paragraph here; \page starts a new page). */
export function openRtf(bytes: Uint8Array): OfficeResult {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Rich text preview limited to files under 8 MB.");
  let source = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) source += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  if (!source.startsWith("{\\rtf")) throw new Error("This is not a valid rich text document.");
  let state = { skip: false, bold: false, italic: false, underline: false, uc: 1, font: 0, fontTable: false, decoder: new TextDecoder("windows-1252") };
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  const stack: (typeof state)[] = [];
  const pages: DocPage[] = [];
  let blocks: DocBlock[] = [];
  let line: Run[] = [];
  let lineHasBreak = false;
  let total = 0;
  let run = "";
  let fallback = 0;
  const encoded = new Uint8Array(bytes.byteLength);
  let encodedLength = 0;
  const budget = (extra: number) => { if (total + extra > RTF_TEXT_MAX) throw new Error("This rich text document has too much content to preview."); };
  const endLine = () => { blocks.push({ kind: "paragraph", runs: mergeRuns(line) }); line = []; lineHasBreak = true; };
  const finishPage = () => {
    if (pages.length >= 500) throw new Error("Rich text preview limited to 500 pages.");
    if (line.length || !lineHasBreak) blocks.push({ kind: "paragraph", runs: mergeRuns(line) });
    pages.push({ title: `Page ${pages.length + 1}`, blocks: blocks.filter((block, index) => index < blocks.length - 1 || block.kind !== "paragraph" || block.runs.length > 0) });
    blocks = []; line = []; lineHasBreak = false;
  };
  const flush = () => {
    if (encodedLength) { run += (fonts.get(state.font) ?? state.decoder).decode(encoded.subarray(0, encodedLength)); encodedLength = 0; }
    budget(run.length);
    if (!run) return;
    total += run.length;
    line.push({ text: run, ...(state.bold ? { bold: true } : {}), ...(state.italic ? { italic: true } : {}), ...(state.underline ? { underline: true } : {}) });
    run = "";
  };
  const emit = (value: string) => {
    if (fallback > 0) { fallback--; return; }
    if (state.skip) return;
    run += value;
    budget(run.length);
  };
  const emitByte = (value: number) => {
    if (fallback > 0) fallback--;
    else if (!state.skip) encoded[encodedLength++] = value;
  };
  for (let i = 0; i < source.length;) {
    const char = source[i++];
    if (char === "{") {
      flush(); fallback = 0;
      if (stack.length > 100) throw new Error("This rich text document is nested too deeply.");
      stack.push({ ...state });
    } else if (char === "}") {
      flush(); fallback = 0;
      const parent = stack.pop();
      if (!parent) throw new Error("This rich text document is damaged.");
      state = parent;
    } else if (char === "\\") {
      const next = source[i];
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("Invalid rich text byte escape.");
        i += 3;
        emitByte(Number.parseInt(hex, 16));
        continue;
      }
      flush();
      if (next === "\\" || next === "{" || next === "}") { i++; emit(next); continue; }
      if (next === "*") { state.skip = true; i++; continue; }
      const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(i, i + 64));
      if (!match) {
        if (next === "~") emit(" ");
        // A backslash before a line break is \par; TextEdit ends paragraphs this way.
        else if ((next === "\n" || next === "\r") && !state.skip) endLine();
        i++;
        continue;
      }
      i += match[0].length;
      const word = match[1]!;
      const arg = match[2] === undefined ? 1 : Number(match[2]);
      if (word === "fonttbl") { state.fontTable = true; state.skip = true; }
      else if (word === "deff") state.font = defaultFont = arg;
      else if (word === "f") state.font = arg;
      else if (word === "fcharset" && state.fontTable) {
        const label = arg === 0 || arg === 1 ? state.decoder.encoding : RTF_FONT_CHARSETS[arg];
        if (label) fonts.set(state.font, new TextDecoder(label));
      } else if (RTF_SKIPPED.has(word)) state.skip = true;
      else if (word === "bin") {
        if (!Number.isSafeInteger(arg) || arg < 0 || arg > source.length - i) throw new Error("Invalid rich text binary data.");
        i += arg;
      } else if (word === "ansicpg") {
        const label = RTF_CODE_PAGES[arg] ?? `windows-${arg}`;
        try { state.decoder = new TextDecoder(label); } catch { throw new Error("This rich text code page is not supported."); }
      } else if (word === "b") state.bold = arg !== 0;
      else if (word === "i") state.italic = arg !== 0;
      else if (word === "ul") state.underline = arg !== 0;
      else if (word === "ulnone") state.underline = false;
      else if (word === "plain") state = { ...state, bold: false, italic: false, underline: false, font: defaultFont };
      else if (word === "uc") state.uc = Math.max(0, Math.min(10, arg));
      else if (word === "u") { fallback = 0; emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); fallback = state.uc; }
      else if (!state.skip && word === "page") finishPage();
      else if (!state.skip && (word === "par" || word === "line" || word === "row")) endLine();
      else if (word === "tab" || word === "cell") emit("\t");
      else if (word === "endash") emit("–");
      else if (word === "emdash") emit("—");
      else if (word === "bullet") emit("•");
      else if (word === "lquote") emit("‘");
      else if (word === "rquote") emit("’");
      else if (word === "ldblquote") emit("“");
      else if (word === "rdblquote") emit("”");
    } else if (char !== "\r" && char !== "\n" && char) emitByte(char.charCodeAt(0));
  }
  if (stack.length) throw new Error("This rich text document is damaged.");
  flush();
  if (line.length || blocks.length || !pages.length) finishPage();
  return { type: "document", navigation: "page", pages };
}

/** Opens an Office or OpenDocument file's bytes for the viewer. */
export function openOfficeDocument(name: string, bytes: Uint8Array): OfficeResult {
  const format = officeFormat(name);
  if (!format) throw new Error("This document can't be previewed here.");
  if (bytes.length > OFFICE_MAX_BYTES) throw new Error("Preview limited to files under 50 MB.");
  if (format === "rtf") return openRtf(bytes);
  const zip = openZip(bytes, 20_000);
  if (format === "docx") return openDocx(zip);
  if (format === "xlsx") return openXlsx(zip);
  if (format === "pptx") return openPptx(zip);
  if (format === "epub") return openEpub(zip);
  return openOdf(zip, format);
}
