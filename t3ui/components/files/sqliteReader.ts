// A read-only SQLite reader for the database preview (files/BinaryViewer.tsx's tables, shown with sql.js in the web app).
// It walks the file's b-trees directly, so no engine or WebAssembly is needed: the schema table lists the user tables, rows are
// read in rowid order a page at a time. WITHOUT ROWID tables and virtual tables are left out (the web preview skips virtual
// ones too); the database must not be mid-write (a -wal file is not read). Pure, so it is tested without an engine.

export const SQLITE_PAGE_SIZE = 50;
export const SQLITE_MAX_COLUMNS = 50;
export const SQLITE_MAX_CELL = 1024;
export const SQLITE_MAX_TABLES = 100;

export interface SqliteTable { name: string; count: number }

export interface OpenSqlite {
  tables: SqliteTable[];
  rows(table: string, page: number): { columns: string[]; rows: string[][] };
}

interface Schema { name: string; root: number; sql: string }

const HEADER = "SQLite format 3\0";

/** The column names of a CREATE TABLE statement, in order, with which one is the rowid alias. */
export function parseCreateTable(sql: string): { columns: string[]; rowidColumn: number } {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return { columns: [], rowidColumn: -1 };
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
  let rowidColumn = -1;
  for (const part of parts) {
    const text = part.trim();
    if (!text || /^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(text)) continue;
    const match = /^(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|(\S+))\s*([\s\S]*)$/.exec(text);
    if (!match) continue;
    const name = (match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    const rest = match[6] ?? "";
    // Generated columns are hidden in table_xinfo, which the web preview leaves out.
    if (/\bgenerated\s+always\b|\bas\s*\(/i.test(rest)) continue;
    if (/^integer\b/i.test(rest) && /\bprimary\s+key\b/i.test(rest) && !/\bdesc\b/i.test(rest)) rowidColumn = columns.length;
    columns.push(name);
  }
  return { columns, rowidColumn };
}

export function openSqlite(bytes: Uint8Array): OpenSqlite {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 100 || String.fromCharCode(...bytes.subarray(0, 16)) !== HEADER) throw new Error("This is not a readable SQLite database.");
  const rawSize = view.getUint16(16, false);
  const pageSize = rawSize === 1 ? 65536 : rawSize;
  const reserved = bytes[20]!;
  const usable = pageSize - reserved;
  const encoding = view.getUint32(56, false);
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error("This SQLite database is damaged.");
  const decoder = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8");
  const pageStart = (page: number) => (page - 1) * pageSize;
  const pageCount = Math.floor(bytes.length / pageSize);
  const checkPage = (page: number) => { if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new Error("This SQLite database is damaged."); };

  const varint = (offset: number): [number, number] => {
    let value = 0;
    for (let index = 0; index < 9; index++) {
      const byte = bytes[offset + index];
      if (byte === undefined) throw new Error("This SQLite database is damaged.");
      if (index === 8) return [value * 256 + byte, 9];
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return [value, index + 1];
    }
    return [value, 9];
  };

  /** The payload of a table b-tree cell, following its overflow pages. */
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
    if (filled < total) throw new Error("This SQLite database is damaged.");
    return out;
  };

  type Cell = string | number | bigint | Uint8Array | null;
  const record = (data: Uint8Array): Cell[] => {
    const inner = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const read = (offset: number): [number, number] => {
      let value = 0;
      for (let index = 0; index < 9; index++) {
        const byte = data[offset + index];
        if (byte === undefined) throw new Error("This SQLite database is damaged.");
        if (index === 8) return [value * 256 + byte, 9];
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) return [value, index + 1];
      }
      return [value, 9];
    };
    const [headerSize, used] = read(0);
    const types: number[] = [];
    for (let cursor = used; cursor < headerSize;) { const [type, size] = read(cursor); types.push(type); cursor += size; }
    const cells: Cell[] = [];
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
        cells.push(type % 2 === 0 ? slice : decoder.decode(slice));
        at += length;
      } else throw new Error("This SQLite database is damaged.");
    }
    return cells;
  };

  /** Visits a table b-tree's leaf pages in rowid order; `leaf` returns false to stop. */
  const walkLeaves = (root: number, leaf: (page: number, header: number, cells: number) => boolean): void => {
    const visit = (page: number, depth: number): boolean => {
      checkPage(page);
      if (depth > 40) throw new Error("This SQLite database is damaged.");
      const base = pageStart(page);
      const header = base + (page === 1 ? 100 : 0);
      const kind = bytes[header]!;
      const cells = view.getUint16(header + 3, false);
      if (kind === 0x0d) return leaf(page, header, cells);
      if (kind !== 0x05) throw new Error("This SQLite database uses an unsupported table layout.");
      for (let index = 0; index < cells; index++) {
        const pointer = view.getUint16(header + 12 + index * 2, false);
        if (!visit(view.getUint32(base + pointer, false), depth + 1)) return false;
      }
      return visit(view.getUint32(header + 8, false), depth + 1);
    };
    visit(root, 0);
  };

  const eachRow = (root: number, handle: (rowid: number, cells: Cell[]) => boolean): void => {
    walkLeaves(root, (page, header, cells) => {
      const base = pageStart(page);
      for (let index = 0; index < cells; index++) {
        const at = base + view.getUint16(header + 8 + index * 2, false);
        const [size, a] = varint(at);
        const [rowid, b] = varint(at + a);
        if (!handle(rowid, record(payload(at + a + b, size)))) return false;
      }
      return true;
    });
  };

  const countRows = (root: number): number => {
    let count = 0;
    walkLeaves(root, (_page, _header, cells) => { count += cells; return true; });
    return count;
  };

  const schemas: Schema[] = [];
  eachRow(1, (_rowid, cells) => {
    const [type, name, , root, sql] = cells;
    if (type === "table" && typeof name === "string" && !name.startsWith("sqlite_") && typeof root === "number" && root > 0 && typeof sql === "string" && !/^CREATE\s+VIRTUAL\s+TABLE/i.test(sql) && !/\bWITHOUT\s+ROWID\b/i.test(sql)) schemas.push({ name, root, sql });
    return true;
  });
  schemas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (schemas.length > SQLITE_MAX_TABLES) throw new Error("Database previews are limited to 100 tables.");

  const cellText = (cell: Cell): string => {
    if (cell === null) return "NULL";
    if (cell instanceof Uint8Array) return `[blob: ${cell.length} bytes]`;
    return String(cell).slice(0, SQLITE_MAX_CELL);
  };

  return {
    tables: schemas.map((schema) => ({ name: schema.name, count: countRows(schema.root) })),
    rows(table, page) {
      const schema = schemas.find((item) => item.name === table);
      if (!schema || !Number.isSafeInteger(page) || page < 0) throw new Error("This table is unavailable.");
      const { columns, rowidColumn } = parseCreateTable(schema.sql);
      const shown = columns.slice(0, SQLITE_MAX_COLUMNS);
      const rows: string[][] = [];
      let skip = page * SQLITE_PAGE_SIZE;
      eachRow(schema.root, (rowid, cells) => {
        if (skip > 0) { skip--; return true; }
        rows.push(shown.map((_name, index) => cellText(index === rowidColumn && cells[index] === null ? rowid : (cells[index] ?? null))));
        return rows.length < SQLITE_PAGE_SIZE;
      });
      return { columns: shown, rows };
    },
  };
}
