// The full text of a file `projects.readFile` cut short (files/LargeTextViewer.tsx and largeText.worker.ts in the web app): the
// file's bytes are indexed once into record starts, and a row decodes only when it is drawn, so a file of millions of lines costs
// one pass and one number per line. A delimited file's records follow its quoting (a quoted field may hold line breaks), a plain
// file's records are its lines. Pure (bytes in), so it is tested without an engine.
import { parseDelimited } from "./delimited";

export interface LargeText {
  /** Lines of a plain file, records of a delimited one (the header is record 0). */
  count: number;
  /** The widest of the first records, in columns (a plain file has one). */
  columns: number;
  sizeBytes: number;
  /** One record's text. */
  record(index: number): string;
  /** One record's cells (a plain file's only cell is the line). */
  cells(index: number): string[];
  /** The whole file, for Copy contents. */
  text(): string;
}

const NEWLINE = 10;
const RETURN = 13;
const QUOTE = 34;
const COLUMN_SAMPLE = 1000;

function indexLfText(bytes: Uint8Array, decoder: TextDecoder, bom: number): LargeText {
  let starts = new Uint32Array(1024);
  let count = 0;
  let from = bom;
  while (from < bytes.length) {
    if (count === starts.length) {
      const next = new Uint32Array(starts.length * 2);
      next.set(starts);
      starts = next;
    }
    starts[count++] = from;
    const newline = bytes.indexOf(NEWLINE, from);
    if (newline < 0) break;
    from = newline + 1;
  }
  const end = bytes.length - (bytes[bytes.length - 1] === NEWLINE ? 1 : 0);
  const record = (index: number): string => {
    if (index < 0 || index >= count) return "";
    const to = index + 1 < count ? starts[index + 1]! - 1 : end;
    return decoder.decode(bytes.subarray(starts[index]!, to));
  };
  return { count, columns: 1, sizeBytes: bytes.length, record, cells: (index) => [record(index)], text: () => decoder.decode(bytes.subarray(bom)) };
}

export function indexLargeText(bytes: Uint8Array, delimiter: "," | "\t" | null): LargeText {
  if (bytes.includes(0)) throw new Error("This file contains binary data and cannot be shown as text.");
  const decoder = new TextDecoder("utf-8");
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (delimiter === null && !bytes.includes(RETURN)) return indexLfText(bytes, decoder, bom);
  // Pass one counts records so the starts fit one typed array.
  let records = 0;
  let quoted = false;
  let atStart = true;
  for (let index = bom; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (delimiter !== null && byte === QUOTE) quoted = !quoted;
    if (!quoted && (byte === NEWLINE || byte === RETURN)) {
      if (byte === RETURN && bytes[index + 1] === NEWLINE) index++;
      records++;
      atStart = true;
    } else atStart = false;
  }
  if (!atStart) records++;
  const starts = new Uint32Array(records + 1);
  const ends = new Uint32Array(records + 1);
  let record = 0;
  let from = bom;
  quoted = false;
  for (let index = bom; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (delimiter !== null && byte === QUOTE) quoted = !quoted;
    if (!quoted && (byte === NEWLINE || byte === RETURN)) {
      starts[record] = from;
      ends[record] = index;
      record++;
      if (byte === RETURN && bytes[index + 1] === NEWLINE) index++;
      from = index + 1;
    }
  }
  if (from < bytes.length) { starts[record] = from; ends[record] = bytes.length; record++; }
  const count = record;
  const text = (index: number) => (index < 0 || index >= count ? "" : decoder.decode(bytes.subarray(starts[index]!, ends[index]!)));
  const cells = (index: number): string[] => {
    const line = text(index);
    return delimiter === null ? [line] : (parseDelimited(line, delimiter, 1).rows[0] ?? [""]);
  };
  let columns = 1;
  if (delimiter !== null) for (let index = 0; index < Math.min(count, COLUMN_SAMPLE); index++) columns = Math.max(columns, cells(index).length);
  return { count, columns, sizeBytes: bytes.length, record: text, cells, text: () => decoder.decode(bytes.subarray(bom)) };
}

/** The line a link or palette asked for, as a row of the full file (one-based line, clamped); null when there is nothing to reveal. */
export function largeRevealIndex(line: number | null | undefined, count: number): number | null {
  if (line === null || line === undefined || !Number.isFinite(line) || count <= 0) return null;
  return Math.min(count, Math.max(1, Math.floor(line))) - 1;
}

/** The status row's copy: `1,204 lines · 3.2 MB` or `20 rows · 4 columns · 1.1 KB` (the header row is not counted). */
export function largeTextSummary(text: Pick<LargeText, "count" | "columns" | "sizeBytes">, delimiter: "," | "\t" | null, formatSize: (bytes: number) => string): string {
  const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rows = Math.max(0, text.count - (delimiter !== null && text.count > 0 ? 1 : 0));
  const size = text.sizeBytes === 0 ? "0 bytes" : formatSize(text.sizeBytes);
  return delimiter !== null ? `${group(rows)} rows · ${group(text.count > 0 ? text.columns : 0)} columns · ${size}` : `${group(rows)} lines · ${size}`;
}
