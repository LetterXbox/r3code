// CSV / TSV parsing for the table viewer (DelimitedTablePreview.tsx). RFC 4180 quoting; pure.

export interface DelimitedTable {
  delimiter: "," | "\t";
  rows: string[][];
  /** Rows beyond `maxRows` that were left out. */
  omitted: number;
}

export const TABLE_MAX_ROWS = 5000;

export function delimiterOf(path: string): "," | "\t" { return /\.tsv$/i.test(path) ? "\t" : ","; }

export function parseDelimited(text: string, delimiter: "," | "\t", maxRows = TABLE_MAX_ROWS): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    total++;
    if (rows.length < maxRows) rows.push(row);
    row = [];
  };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      endRow();
    } else field += char;
  }
  if (field !== "" || row.length > 0) endRow();
  return { delimiter, rows, omitted: Math.max(0, total - rows.length) };
}

/** Column widths in characters, capped, from the first rows. */
export function columnWidths(rows: readonly (readonly string[])[], cap = 40, sample = 200): number[] {
  const widths: number[] = [];
  for (const row of rows.slice(0, sample)) {
    row.forEach((cell, index) => { widths[index] = Math.min(cap, Math.max(widths[index] ?? 3, cell.length)); });
  }
  return widths;
}
