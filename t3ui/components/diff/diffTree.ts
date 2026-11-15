// The changed-files tree of the diff panel (diffFileTree.logic.ts): files grouped
// by folder, folders that only hold one folder merged into one row ("src/lib"),
// everything kept in the order the server listed it.
import { fileKeyOf, type ChangedFile } from "./data";

export type DiffFileStatus = "modified" | "renamed";

export interface DiffTreeRow {
  /** The folder path with a trailing slash, or the file path. */
  id: string;
  kind: "directory" | "file";
  label: string;
  depth: number;
  expanded: boolean;
  file?: ChangedFile;
  status?: DiffFileStatus;
  stat?: { additions: number; deletions: number };
}

interface Node {
  name: string;
  path: string;
  children: Node[];
  file?: ChangedFile;
}

export function fileStatus(file: ChangedFile): DiffFileStatus {
  return file.previousPath !== null && file.previousPath !== file.path ? "renamed" : "modified";
}

/** The letter drawn after a file's name, as the file tree's git status mark. */
export function statusMark(status: DiffFileStatus): string {
  return status === "renamed" ? "R" : "M";
}

export function buildDiffTree(files: readonly ChangedFile[], normalizePaths = false): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const file of files) {
    // TurnDiffTree normalizes separators and skips empty path segments. The diff
    // panel keeps host paths as received because they are its selection keys.
    const parts = normalizePaths ? file.path.replaceAll("\\", "/").split("/").filter(Boolean) : file.path.split("/");
    if (parts.length === 0) continue;
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = `${parts.slice(0, index + 1).join("/")}/`;
      let next = parent.children.find((child) => child.path === path);
      if (!next) { next = { name: parts[index]!, path, children: [] }; parent.children.push(next); }
      parent = next;
    }
    parent.children.push({ name: parts[parts.length - 1]!, path: file.path, children: [], file });
  }
  return root.children;
}

/** Visible rows; `collapsed` holds the folder ids the user closed. */
export function diffTreeRows(files: readonly ChangedFile[], collapsed: ReadonlySet<string>, options?: { directoriesFirst?: boolean }): DiffTreeRow[] {
  const rows: DiffTreeRow[] = [];
  // The NSH runtime does not provide Intl.Collator. Compare numeric parts naturally,
  // matching the reference's numeric, case-insensitive ordering for file names.
  const compareName = (a: string, b: string): number => {
    const left = a.toLowerCase().match(/\d+|\D+/g) ?? [];
    const right = b.toLowerCase().match(/\d+|\D+/g) ?? [];
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const x = left[index]!; const y = right[index]!;
      const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
      const result = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
      if (result) return result;
    }
    return left.length - right.length;
  };
  const statOf = (node: Node): { additions: number; deletions: number } => node.file
    ? { additions: node.file.additions, deletions: node.file.deletions }
    : node.children.reduce((sum, child) => { const stat = statOf(child); return { additions: sum.additions + stat.additions, deletions: sum.deletions + stat.deletions }; }, { additions: 0, deletions: 0 });
  const walk = (nodes: Node[], depth: number) => {
    const ordered = options?.directoriesFirst ? [...nodes].sort((a, b) => Number(!!a.file) - Number(!!b.file) || compareName(a.name, b.name)) : nodes;
    for (const original of ordered) {
      if (original.file) {
        rows.push({ id: fileKeyOf(original.file), kind: "file", label: original.name, depth, expanded: false, file: original.file, status: fileStatus(original.file) });
        continue;
      }
      let node = original;
      let label = node.name;
      while (node.children.length === 1 && !node.children[0]!.file) {
        node = node.children[0]!;
        label += `/${node.name}`;
      }
      const expanded = !collapsed.has(node.path);
      rows.push({ id: node.path, kind: "directory", label, depth, expanded, stat: statOf(node) });
      if (expanded) walk(node.children, depth + 1);
    }
  };
  walk(buildDiffTree(files, options?.directoriesFirst === true), 0);
  return rows;
}

export function directoryIds(files: readonly ChangedFile[]): string[] {
  return diffTreeRows(files, new Set()).filter((row) => row.kind === "directory").map((row) => row.id);
}

export function totalStat(files: readonly ChangedFile[]): { additions: number; deletions: number } {
  return files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
}

/** formatCompactDiffCount in DiffStatLabel.tsx: 1.2k, 12k, 1.5m. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
}
