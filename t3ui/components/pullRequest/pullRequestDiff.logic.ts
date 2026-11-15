// The Code tab's pure pieces: the HTTP diff client (the diff is only served over
// POST /api/pull-requests/diff with a bearer token), the file list read from a unified
// patch, and the viewed-files overlay (pullRequestFilesViewed.logic.ts).
// Fold helpers are ported from pullRequestDiff.logic.ts.

import { isTestChangedFile } from "../diff/changedFileKind";

export interface DiffPage {
  patch: string;
  truncated: boolean;
  nextCursor: string | null;
  omitted: { path: string; additions: number; deletions: number }[];
}

export interface PullRequestRefInput { projectId: string; host?: string; repository: string; number: number }

export interface DiffFetchDeps {
  endpoint: () => string;
  bearer: () => string | null;
  fetch: typeof fetch;
  /** Resolve a scoped project to the environment that owns its HTTP endpoint and credential. */
  resolve?: (ref: PullRequestRefInput) => Promise<{ endpoint: string; bearer: string | null; ref: PullRequestRefInput }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ws://host:port/ becomes http://host:port (the page's HTTP origin). */
export function httpOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function parseDiffPage(value: unknown): DiffPage {
  if (!record(value) || typeof value.patch !== "string") throw new Error("The server returned an invalid diff.");
  return {
    patch: value.patch,
    truncated: value.truncated === true,
    nextCursor: typeof value.nextCursor === "string" && value.nextCursor ? value.nextCursor : null,
    omitted: Array.isArray(value.omittedFileStats)
      ? value.omittedFileStats.flatMap((entry) => record(entry) && typeof entry.path === "string"
        ? [{ path: entry.path, additions: Number(entry.additions) || 0, deletions: Number(entry.deletions) || 0 }]
        : [])
      : [],
  };
}

export async function fetchPullRequestDiff(
  deps: DiffFetchDeps, ref: PullRequestRefInput, options: { cursor?: string; commit?: string } = {},
): Promise<DiffPage> {
  const destination = deps.resolve ? await deps.resolve(ref) : { endpoint: deps.endpoint(), bearer: deps.bearer(), ref };
  const bearer = destination.bearer;
  if (!bearer) throw new Error("This environment is not authorized to read diffs. Reconnect it in Settings.");
  const response = await deps.fetch(`${httpOrigin(destination.endpoint)}/api/pull-requests/diff`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ ...destination.ref, ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.commit ? { commit: options.commit } : {}) }),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (record(body)) detail = String(body.detail ?? body.message ?? body.reason ?? detail);
    } catch { /* the status line is the message */ }
    throw new Error(detail);
  }
  return parseDiffPage(await response.json());
}

/** describePullRequestDiffError */
export function describeDiffError(error: string, providerName: string, term: string): { title: string; description: string } {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/iu.test(error)) {
    return {
      title: `${providerName} rate limit reached`,
      description: `${providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again after the limit resets, or view the changes on ${providerName}.`,
    };
  }
  return {
    title: "Couldn't load the changes",
    description: `The environment couldn't load this ${term}'s diff. Try again, or view the changes on ${providerName}.`,
  };
}

// ---- Files in a patch ----

export interface PatchFile { path: string; oldPath: string | null; additions: number; deletions: number; binary: boolean; status: "added" | "deleted" | "renamed" | "modified" }

/** One entry per `diff --git` block, with its counted added and removed lines. */
export function patchFiles(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (header) {
      current = { path: header[2]!, oldPath: header[1] === header[2] ? null : header[1]!, additions: 0, deletions: 0, binary: false, status: header[1] === header[2] ? "modified" : "renamed" };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) current.status = "added";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
    }
    if (/^Binary files /u.test(line) || line === "GIT binary patch") { current.binary = true; continue; }
    if (/^@@ /u.test(line)) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  return files;
}

/** Pages append; a file split across a page boundary is not expected, so they simply concatenate. */
export function joinPatches(pages: readonly DiffPage[]): string {
  return pages.map((page) => (page.patch.endsWith("\n") ? page.patch : `${page.patch}\n`)).join("");
}

// ---- Viewed files ----

export type ViewedState = "unviewed" | "viewed" | "dismissed";

export function viewedStates(value: unknown): Map<string, ViewedState> | null {
  if (!record(value) || !Array.isArray(value.files)) return null;
  const map = new Map<string, ViewedState>();
  for (const file of value.files) {
    if (record(file) && typeof file.path === "string" && (file.state === "viewed" || file.state === "dismissed" || file.state === "unviewed")) {
      map.set(file.path, file.state);
    }
  }
  return map;
}

/** A press the server has not answered yet wins over what it last reported. */
export function isFileViewed(path: string, states: ReadonlyMap<string, ViewedState> | null, overlay: ReadonlyMap<string, boolean>): boolean {
  return overlay.get(path) ?? states?.get(path) === "viewed";
}

export function isStaleViewed(path: string, states: ReadonlyMap<string, ViewedState> | null, overlay: ReadonlyMap<string, boolean>): boolean {
  return !overlay.has(path) && states?.get(path) === "dismissed";
}

export function viewedCount(paths: readonly string[], states: ReadonlyMap<string, ViewedState> | null, overlay: ReadonlyMap<string, boolean>): number {
  return paths.filter((path) => isFileViewed(path, states, overlay)).length;
}

/** The files a shift-click range covers, inclusive, in list order. */
export function viewedRange(paths: readonly string[], path: string, anchor: string | null): string[] {
  const index = paths.indexOf(path);
  if (index === -1) return [];
  const anchorIndex = anchor === null ? -1 : paths.indexOf(anchor);
  if (anchorIndex === -1) return [path];
  return paths.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}

/** isTestChangedFile (packages/shared changedFileKind): tests and their mocks and fixtures. */
export function isTestFile(path: string): boolean {
  return isTestChangedFile(path);
}

/** The patch without the `diff --git` blocks `keep` rejects. */
export function filterPatch(patch: string, keep: (path: string) => boolean): string {
  const blocks = patch.split(/^(?=diff --git )/mu);
  return blocks.filter((block) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(block);
    return header ? keep(header[2]!) : true;
  }).join("");
}

// ---- Hide whitespace changes ----

const squash = (line: string) => line.replace(/\s+/gu, "");

/**
 * "Hide whitespace changes": a removed line and the added line that replaces it, which differ only in
 * whitespace, show once as unchanged context (the counts of each hunk stay as they were).
 */
export function ignoreWhitespacePatch(patch: string): string {
  const out: string[] = [];
  let inHunk = false;
  let minus: string[] = [];
  let plus: string[] = [];
  const flush = () => {
    const pairs = Math.min(minus.length, plus.length);
    const keptMinus: string[] = [];
    const keptPlus: string[] = [];
    for (let index = 0; index < minus.length; index++) {
      const same = index < pairs && squash(minus[index]!.slice(1)) === squash(plus[index]!.slice(1));
      if (same) {
        out.push(...keptMinus, ...keptPlus, ` ${plus[index]!.slice(1)}`);
        keptMinus.length = 0;
        keptPlus.length = 0;
      } else {
        keptMinus.push(minus[index]!);
        if (index < pairs) keptPlus.push(plus[index]!);
      }
    }
    for (let index = minus.length; index < plus.length; index++) keptPlus.push(plus[index]!);
    out.push(...keptMinus, ...keptPlus);
    minus = [];
    plus = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); inHunk = false; out.push(line); continue; }
    if (/^@@ /u.test(line)) { flush(); inHunk = true; out.push(line); continue; }
    if (!inHunk) { out.push(line); continue; }
    if (line.startsWith("-")) { if (plus.length > 0) flush(); minus.push(line); continue; }
    if (line.startsWith("+")) { plus.push(line); continue; }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

// ---- Folding files (isFileDiffCollapsed, toggleFileDiffFoldForViewed) ----

export type DiffFoldOverride = "expanded" | "folded" | null;

/** Fold choices are kept relative to the toolbar's, so files of later pages inherit "Collapse all files". */
export function isFileDiffCollapsed(path: string, foldOverride: DiffFoldOverride, toggled: ReadonlySet<string>): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggled.has(path) ? !foldedByDefault : foldedByDefault;
}

/** A file marked viewed folds away, one marked unviewed opens. */
export function toggleFileDiffFoldForViewed(path: string, viewed: boolean, foldOverride: DiffFoldOverride, toggled: ReadonlySet<string>): ReadonlySet<string> {
  if (isFileDiffCollapsed(path, foldOverride, toggled) === viewed) return toggled;
  const next = new Set(toggled);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
