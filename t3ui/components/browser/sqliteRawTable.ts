// A minimal, read-only SQLite reader for the browser cookie import (H6): walks a table's b-tree directly from bytes
// already in memory (no sqlite engine, no WASM, no temp-file copy), the same way components/files/sqliteReader.ts does
// for the file preview. Kept separate from sqliteReader.ts (which truncates/stringifies cells for display) because
// cookie import needs the raw BLOB bytes of `encrypted_value` untouched, and needs every row rather than a page.
// Only what cookie import needs: the file header's `user_version` (Firefox's schema version lives there), and a full
// table scan by name returning raw cells in column order (Chromium's `meta`/`cookies`, Firefox's `moz_cookies`).

export type SqliteCell = string | number | bigint | Uint8Array | null;

const HEADER = "SQLite format 3\0";
/** Generous but finite: a cookie database with more rows than this is not something this reader should try to hold in memory. */
const MAX_ROWS_PER_TABLE = 200_000;

export class SqliteFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteFormatError";
  }
}

interface Schema { name: string; root: number; sql: string }

/** The file header's `user_version` (offset 60, big-endian 4 bytes) — Firefox stores its cookie schema version there. */
export function readSqliteUserVersion(bytes: Uint8Array): number {
  if (bytes.length < 100 || !isSqliteHeader(bytes)) throw new SqliteFormatError("This is not a readable SQLite database.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(60, false);
}

export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let index = 0; index < 16; index++) if (bytes[index] !== HEADER.charCodeAt(index)) return false;
  return true;
}

/** The column names of a CREATE TABLE statement, in order (same parser as sqliteReader.ts's parseCreateTable, minus the rowid-alias tracking this caller does not need). */
export function parseTableColumns(sql: string): string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  const body = sql.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0; let quote = ""; let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) { parts.push(body.slice(start, index)); start = index + 1; }
  }
  parts.push(body.slice(start));
  const columns: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text || /^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(text)) continue;
    const match = /^(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|(\S+))\s*([\s\S]*)$/.exec(text);
    if (!match) continue;
    const name = (match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    const rest = match[6] ?? "";
    if (/\bgenerated\s+always\b|\bas\s*\(/i.test(rest)) continue;
    columns.push(name);
  }
  return columns;
}

export interface SqliteTableScan { columns: string[]; rows: SqliteCell[][] }

/** Every row of one table, in rowid order, as raw cells (BLOBs stay Uint8Array, never stringified). */
export function readSqliteTable(bytes: Uint8Array, tableName: string): SqliteTableScan {
  if (bytes.length < 100 || !isSqliteHeader(bytes)) throw new SqliteFormatError("This is not a readable SQLite database.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSize = view.getUint16(16, false);
  const pageSize = rawSize === 1 ? 65536 : rawSize;
  const reserved = bytes[20]!;
  const usable = pageSize - reserved;
  const encoding = view.getUint32(56, false);
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new SqliteFormatError("This SQLite database is damaged.");
  const decoder = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8");
  const pageStart = (page: number) => (page - 1) * pageSize;
  const pageCount = Math.floor(bytes.length / pageSize);
  const checkPage = (page: number) => { if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new SqliteFormatError("This SQLite database is damaged."); };

  const varint = (offset: number): [number, number] => {
    let value = 0;
    for (let index = 0; index < 9; index++) {
      const byte = bytes[offset + index];
      if (byte === undefined) throw new SqliteFormatError("This SQLite database is damaged.");
      if (index === 8) return [value * 256 + byte, 9];
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return [value, index + 1];
    }
    return [value, 9];
  };

  const payload = (offset: number, total: number): Uint8Array => {
    const max = usable - 35;
    if (total <= max) return bytes.subarray(offset, offset + total);
    const min = Math.floor(((usable - 12) * 32) / 255) - 23;
    const local = min + ((total - min) % (usable - 4));
    const keep = local <= max ? local : min;
    const out = new Uint8Array(total);
    out.set(bytes.subarray(offset, offset + keep), 0);
    let filled = keep;
    let next = view.getUint32(offset + keep, false);
    for (let guard = 0; filled < total && next !== 0 && guard < pageCount; guard++) {
      checkPage(next);
      const base = pageStart(next);
      const take = Math.min(usable - 4, total - filled);
      out.set(bytes.subarray(base + 4, base + 4 + take), filled);
      filled += take;
      next = view.getUint32(base, false);
    }
    if (filled < total) throw new SqliteFormatError("This SQLite database is damaged.");
    return out;
  };

  const record = (data: Uint8Array): SqliteCell[] => {
    const inner = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const read = (offset: number): [number, number] => {
      let value = 0;
      for (let index = 0; index < 9; index++) {
        const byte = data[offset + index];
        if (byte === undefined) throw new SqliteFormatError("This SQLite database is damaged.");
        if (index === 8) return [value * 256 + byte, 9];
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) return [value, index + 1];
      }
      return [value, 9];
    };
    const [headerSize, used] = read(0);
    const types: number[] = [];
    for (let cursor = used; cursor < headerSize;) { const [type, size] = read(cursor); types.push(type); cursor += size; }
    const cells: SqliteCell[] = [];
    let at = headerSize;
    for (const type of types) {
      if (type === 0) cells.push(null);
      else if (type >= 1 && type <= 6) {
        const width = [0, 1, 2, 3, 4, 6, 8][type]!;
        let value = 0n;
        for (let index = 0; index < width; index++) value = (value << 8n) | BigInt(data[at + index]!);
        if (data[at]! & 0x80) value -= 1n << BigInt(width * 8);
        cells.push(value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value);
        at += width;
      } else if (type === 7) { cells.push(inner.getFloat64(at, false)); at += 8; }
      else if (type === 8) cells.push(0);
      else if (type === 9) cells.push(1);
      else if (type >= 12) {
        const length = type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2;
        const slice = data.subarray(at, at + length);
        cells.push(type % 2 === 0 ? Uint8Array.from(slice) : decoder.decode(slice));
        at += length;
      } else throw new SqliteFormatError("This SQLite database is damaged.");
    }
    return cells;
  };

  const walkLeaves = (root: number, leaf: (page: number, header: number, cells: number) => void): void => {
    const visit = (page: number, depth: number): void => {
      checkPage(page);
      if (depth > 40) throw new SqliteFormatError("This SQLite database is damaged.");
      const base = pageStart(page);
      const header = base + (page === 1 ? 100 : 0);
      const kind = bytes[header]!;
      const cells = view.getUint16(header + 3, false);
      if (kind === 0x0d) { leaf(page, header, cells); return; }
      if (kind !== 0x05) throw new SqliteFormatError("This SQLite database uses an unsupported table layout.");
      for (let index = 0; index < cells; index++) {
        const pointer = view.getUint16(header + 12 + index * 2, false);
        visit(view.getUint32(base + pointer, false), depth + 1);
      }
      visit(view.getUint32(header + 8, false), depth + 1);
    };
    visit(root, 0);
  };

  const eachRow = (root: number, handle: (rowid: number, cells: SqliteCell[]) => void): void => {
    let seen = 0;
    walkLeaves(root, (page, header, cells) => {
      const base = pageStart(page);
      for (let index = 0; index < cells; index++) {
        if (seen >= MAX_ROWS_PER_TABLE) return;
        const at = base + view.getUint16(header + 8 + index * 2, false);
        const [size, a] = varint(at);
        const [rowid, b] = varint(at + a);
        handle(rowid, record(payload(at + a + b, size)));
        seen++;
      }
    });
  };

  const schemas: Schema[] = [];
  eachRow(1, (_rowid, cells) => {
    const [type, name, , root, sql] = cells;
    if (type === "table" && typeof name === "string" && typeof root === "number" && root > 0 && typeof sql === "string") schemas.push({ name, root, sql });
  });

  const schema = schemas.find((item) => item.name === tableName);
  if (!schema) return { columns: [], rows: [] };
  const columns = parseTableColumns(schema.sql);
  const rows: SqliteCell[][] = [];
  eachRow(schema.root, (rowid, cells) => {
    rows.push(columns.map((_name, index) => (cells[index] === undefined ? null : cells[index] === null && index === -1 ? rowid : cells[index])));
  });
  return { columns, rows };
}

/** One row's cells, by column name (undefined when the column does not exist in this database's schema version). */
export function cellByName(columns: string[], row: SqliteCell[], name: string): SqliteCell | undefined {
  const index = columns.indexOf(name);
  return index === -1 ? undefined : row[index];
}
