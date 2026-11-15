// Port of packages/client-runtime/src/workspaceBasenameLookup.ts: a link that names only a file's name (`ThreadView.tsx`), or
// that repeats the project's own folders (`legion/src/a.ts` in project `legion`), is searched for in the workspace before it opens.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// All callers open one panel; the newest press wins across callers.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate { readonly path: string; readonly kind: "file" | "directory" }

const isWindowsRoot = (path: string) => /^[A-Za-z]:[\\/]/.test(path);
const isAbs = (path: string) => path.startsWith("/") || path.startsWith("\\\\") || isWindowsRoot(path);

function basenameOfPath(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return trimmed !== "." && trimmed !== ".." && trimmed.length > 0 && !trimmed.includes("/") && !trimmed.includes("\\");
}

export function pickWorkspaceBasenameMatch(basename: string, entries: ReadonlyArray<WorkspaceEntryCandidate>): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  const folded = files.filter((entry) => basenameOfPath(entry.path).toLowerCase() === target.toLowerCase());
  return folded.length === 1 ? (folded[0]?.path ?? null) : null;
}

/** Repository-relative paths can repeat the project's suffix in subfolder projects. */
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbs(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsRoot(cwd) ? (segment: string | undefined) => segment?.toLowerCase() : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) return pathSegments.slice(count).join("/") || null;
  }
  return null;
}

export function pickStrippedWorkspaceMatch(strippedPath: string, cwd: string, entries: ReadonlyArray<WorkspaceEntryCandidate>): string | null {
  const key = (path: string) => { const normalized = path.replaceAll("\\", "/"); return isWindowsRoot(cwd) ? normalized.toLowerCase() : normalized; };
  return entries.filter((entry) => entry.kind === "file").find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}
