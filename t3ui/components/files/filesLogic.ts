// The Files browser's data rules: `projects.listEntries` results, the lazily
// loaded directory tree flattened into rows, and `projects.readFile` results.
// Pure, so it is tested without an engine.

export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  ignored: boolean;
}

export interface DirectoryListing {
  entries: FileEntry[];
  truncated: boolean;
}

export interface TreeRow {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
  expanded: boolean;
  ignored: boolean;
  /** A directory whose children are being loaded. */
  loading: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directories first, then names in natural, case-insensitive order. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return naturalCompare(a.name, b.name);
}

/** Case-insensitive compare that orders digit runs by value ("a2" before "a10"). */
export function naturalCompare(a: string, b: string): number {
  const left = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const right = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index]!;
    const y = right[index]!;
    if (x === y) continue;
    const digits = /^\d/.test(x) && /^\d/.test(y);
    if (digits) return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

export function readDirectoryListing(value: unknown): DirectoryListing {
  if (!object(value) || !Array.isArray(value.entries)) throw new Error("The server returned an invalid folder listing.");
  const entries: FileEntry[] = [];
  for (const item of value.entries) {
    if (!object(item) || typeof item.path !== "string" || !item.path || (item.kind !== "file" && item.kind !== "directory")) continue;
    entries.push({ path: item.path, name: baseName(item.path), kind: item.kind, ignored: item.ignored === true });
  }
  entries.sort(compareEntries);
  return { entries, truncated: value.truncated === true };
}

export interface TreeState {
  /** Listings by directory path; "" is the workspace root. */
  listings: Record<string, DirectoryListing>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
}

/** The visible rows, depth first: an expanded directory is followed by its children. */
export function flattenTree(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (directory: string, depth: number) => {
    for (const entry of state.listings[directory]?.entries ?? []) {
      const expanded = entry.kind === "directory" && state.expanded.has(entry.path);
      rows.push({ path: entry.path, name: entry.name, kind: entry.kind, depth, expanded, ignored: entry.ignored, loading: entry.kind === "directory" && state.loading.has(entry.path) });
      if (expanded) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Every directory whose listing has been loaded and that has a subdirectory still collapsed. */
export function expandableDirectories(listings: Record<string, DirectoryListing>): string[] {
  const out: string[] = [];
  for (const listing of Object.values(listings)) for (const entry of listing.entries) if (entry.kind === "directory") out.push(entry.path);
  return out;
}

export interface FileContents {
  relativePath: string;
  contents: string;
  byteLength: number;
  truncated: boolean;
}

export function readFileContents(value: unknown): FileContents {
  if (!object(value) || typeof value.contents !== "string" || typeof value.relativePath !== "string") throw new Error("The server returned an invalid file.");
  return {
    relativePath: value.relativePath,
    contents: value.contents,
    byteLength: typeof value.byteLength === "number" ? value.byteLength : value.contents.length,
    truncated: value.truncated === true,
  };
}

/** The lines a preview draws (a trailing newline does not add an empty last line). */
export function previewLines(contents: string): string[] {
  if (contents === "") return [];
  const lines = contents.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatByteLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The failure copy for `projects.readFile`: ProjectReadFileError.failure values as friendly text. */
export function readFileFailureMessage(message: string): string {
  // filePreviewReadErrorMessage in files/filePreviewMode.ts.
  if (/binary/i.test(message)) return "The file is binary and cannot be displayed as text.";
  if (/path_not_file/i.test(message)) return "The path is a directory or special file, not a regular file.";
  if (/resolved_path_outside_root/i.test(message)) return "The path resolves to a location outside the workspace.";
  if (/workspace_path_outside_root/i.test(message)) return "The requested path is outside the workspace.";
  if (/operation_failed/i.test(message)) {
    return /realpath-workspace-root/i.test(message)
      ? "The workspace folder could not be accessed."
      : "The file could not be accessed or read. It may be missing or inaccessible.";
  }
  return message;
}

/** Breadcrumb segments for a file path: [{label, path}] from the first folder to the file. */
export function pathSegments(relativePath: string): { label: string; path: string }[] {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join("/") }));
}

/** `projects.searchEntries` results, read like a listing's entries. */
export function readSearchEntries(value: unknown): { entries: FileEntry[]; truncated: boolean } {
  if (!object(value) || !Array.isArray(value.entries)) throw new Error("The server returned invalid search results.");
  const listing = readDirectoryListing({ entries: value.entries, truncated: value.truncated });
  return { entries: listing.entries, truncated: listing.truncated };
}

/**
 * The tree while a search is on (FileBrowserPanel's `hide-non-matches` with every
 * directory open): the searched entries plus those already loaded that match the
 * query, with the folders above each, depth first in the tree's own order.
 */
export function searchRows(query: string, searched: readonly FileEntry[], loaded: Record<string, DirectoryListing>): TreeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const entries = new Map<string, FileEntry>();
  for (const listing of Object.values(loaded)) for (const entry of listing.entries) if (entry.path.toLowerCase().includes(needle)) entries.set(entry.path, entry);
  for (const entry of searched) entries.set(entry.path, entry);
  for (const entry of [...entries.values()]) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const path = segments.slice(0, index).join("/");
      if (!entries.has(path)) entries.set(path, { path, name: segments[index - 1]!, kind: "directory", ignored: false });
    }
  }
  const children = new Map<string, FileEntry[]>();
  for (const entry of entries.values()) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const rows: TreeRow[] = [];
  const walk = (directory: string, depth: number) => {
    for (const entry of (children.get(directory) ?? []).sort(compareEntries)) {
      const isDirectory = entry.kind === "directory";
      rows.push({ path: entry.path, name: entry.name, kind: entry.kind, depth, expanded: isDirectory, ignored: entry.ignored, loading: false });
      if (isDirectory) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Markdown files can be shown rendered (filePreviewMode.ts isMarkdownPreviewFile). */
export const isMarkdownPath = (path: string): boolean => /\.(?:md|mdx|markdown|mdown|mkd)$/i.test(path);

/** Images the preview draws instead of reading as text. */
export const isImagePath = (path: string): boolean => /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(path);

/** The `file:` URL of a workspace file in a local environment (a remote one has no path on this machine). */
export function workspaceFileUrl(cwd: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return `file://${encodeURI(relativePath)}`;
  const root = cwd.replace(/\/+$/, "");
  return `file://${encodeURI(`${root}/${relativePath}`)}`;
}

/** buildFileTreePathUpdates' removals: the paths a folder's new listing no longer has, minus those under an already
 * removed folder (the tree drops a removed folder with everything under it). */
export function removedTreePaths(previous: readonly { path: string; kind: string }[], next: readonly { path: string }[]): string[] {
  const kept = new Set(next.map((entry) => entry.path));
  const removedFolders: string[] = [];
  const out: string[] = [];
  const depth = (path: string) => path.split("/").filter(Boolean).length;
  for (const entry of [...previous].filter((item) => !kept.has(item.path)).sort((a, b) => depth(a.path) - depth(b.path))) {
    if (removedFolders.some((folder) => entry.path.startsWith(`${folder}/`))) continue;
    out.push(entry.path);
    if (entry.kind === "directory") removedFolders.push(entry.path);
  }
  return out;
}

/** After a rename or delete: a removed folder's listing and open state go, with everything under it. */
export function dropRemovedTreePaths<T>(listings: Record<string, T>, expanded: ReadonlySet<string>, removed: readonly string[]): { listings: Record<string, T>; expanded: Set<string> } {
  const gone = (path: string) => removed.some((root) => path === root || path.startsWith(`${root}/`));
  return {
    listings: Object.fromEntries(Object.entries(listings).filter(([path]) => !gone(path))),
    expanded: new Set([...expanded].filter((path) => !gone(path))),
  };
}
