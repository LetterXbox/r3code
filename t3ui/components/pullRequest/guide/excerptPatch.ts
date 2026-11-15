// A guide stop's excerpt: the rows of its file's diff that fall in the excerpt's line range, as a small
// unified patch the diff view draws. Ported from client-runtime/src/reviewGuideTour.ts (fileDiffRows,
// excerptRows, rowsToPatch) over a unified patch instead of a parsed file.
export interface DiffRow {
  kind: "context" | "addition" | "deletion";
  oldLine: number | null;
  newLine: number | null;
  /** Where the row sits on each side, also for a row that exists on only one. */
  oldAt: number;
  newAt: number;
  /** The line without its newline; `noNewline` marks a final line git flagged. */
  text: string;
  noNewline: boolean;
  hunk: number;
}

export interface Excerpt { path: string; side: string; start: number; end: number }

/** The section of a multi-file patch that belongs to `path` (its new name, or its old one for a deleted file). */
export function fileSection(patch: string, path: string): { section: string; previousPath: string } | null {
  const sections = patch.split(/^(?=diff --git )/mu).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const to = /^\+\+\+ (?:b\/)?(.+)$/mu.exec(section)?.[1]?.trim();
    const from = /^--- (?:a\/)?(.+)$/mu.exec(section)?.[1]?.trim();
    const renamedFrom = /^rename from (.+)$/mu.exec(section)?.[1]?.trim();
    const target = to && to !== "/dev/null" ? to : from;
    if (target === path) return { section, previousPath: from && from !== "/dev/null" ? from : renamedFrom ?? path };
  }
  return null;
}

/** fileDiffRows: every line of every hunk of the file's section, numbered on both sides. */
export function fileDiffRows(section: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let oldAt = 0;
  let newAt = 0;
  for (const line of section.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header) {
      hunk += 1;
      oldAt = Number(header[1]);
      newAt = Number(header[2]);
      continue;
    }
    if (hunk === -1) continue;
    if (line.startsWith("\\")) {
      const last = rows[rows.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const mark = line[0];
    if (mark === " ") {
      rows.push({ kind: "context", oldLine: oldAt, newLine: newAt, oldAt, newAt, text: line.slice(1), noNewline: false, hunk });
      oldAt += 1;
      newAt += 1;
    } else if (mark === "-") {
      rows.push({ kind: "deletion", oldLine: oldAt, newLine: null, oldAt, newAt, text: line.slice(1), noNewline: false, hunk });
      oldAt += 1;
    } else if (mark === "+") {
      rows.push({ kind: "addition", oldLine: null, newLine: newAt, oldAt, newAt, text: line.slice(1), noNewline: false, hunk });
      newAt += 1;
    }
  }
  return rows;
}

/** excerptRows: the rows in the range, widened so a changed line is not cut from its other half. */
export function excerptRows(rows: readonly DiffRow[], excerpt: Pick<Excerpt, "side" | "start" | "end">): DiffRow[] {
  const lineOf = (row: DiffRow) => (excerpt.side === "new" ? row.newLine : row.oldLine);
  const inRange = (row: DiffRow) => {
    const line = lineOf(row);
    return line !== null && line >= excerpt.start && line <= excerpt.end;
  };
  let first = rows.findIndex(inRange);
  if (first === -1) return [];
  let last = rows.length - 1;
  while (last > first && !inRange(rows[last]!)) last -= 1;
  const sameHunk = (a: number, b: number) => rows[a]?.hunk === rows[b]?.hunk;
  if (excerpt.side === "new" && rows[first]?.kind === "addition") {
    while (first > 0 && rows[first - 1]?.kind === "deletion" && sameHunk(first - 1, first)) first -= 1;
  }
  if (excerpt.side === "old" && rows[last]?.kind === "deletion") {
    while (last < rows.length - 1 && rows[last + 1]?.kind === "addition" && sameHunk(last + 1, last)) last += 1;
  }
  return rows.slice(first, last + 1);
}

const PREFIX = { context: " ", addition: "+", deletion: "-" } as const;

/** rowsToPatch: one hunk per run of rows from the same source hunk. */
export function rowsToPatch(path: string, previousPath: string, rows: readonly DiffRow[]): string {
  if (rows.length === 0) return "";
  const lines = [`diff --git a/${previousPath} b/${path}`, `--- a/${previousPath}`, `+++ b/${path}`];
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1]!.hunk === rows[start]!.hunk) end += 1;
    const group = rows.slice(start, end + 1);
    const head = group[0]!;
    const oldCount = group.filter((row) => row.oldLine !== null).length;
    const newCount = group.filter((row) => row.newLine !== null).length;
    // Git names the line before an empty side, so a pure insertion after line 9 is `-9,0`.
    const oldStart = oldCount === 0 ? Math.max(head.oldAt - 1, 0) : head.oldAt;
    const newStart = newCount === 0 ? Math.max(head.newAt - 1, 0) : head.newAt;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of group) {
      lines.push(`${PREFIX[row.kind]}${row.text}`);
      if (row.noNewline) lines.push("\\ No newline at end of file");
    }
    start = end + 1;
  }
  return `${lines.join("\n")}\n`;
}

export interface ExcerptSlice { patch: string; shown: number; total: number }

/** The patch for one excerpt, or null when the diff has no line in its range (the file is not in what was read). */
export function excerptPatch(patch: string, excerpt: Excerpt): ExcerptSlice | null {
  const found = fileSection(patch, excerpt.path);
  if (!found) return null;
  const rows = fileDiffRows(found.section);
  const shown = excerptRows(rows, excerpt);
  if (shown.length === 0) return null;
  return { patch: rowsToPatch(excerpt.path, found.previousPath, shown), shown: shown.length, total: rows.length };
}

/** The paths an excerpt list names that a patch does not cover yet. */
export function missingPaths(patch: string, excerpts: readonly Pick<Excerpt, "path">[]): string[] {
  return [...new Set(excerpts.map((excerpt) => excerpt.path))].filter((path) => fileSection(patch, path) === null);
}
