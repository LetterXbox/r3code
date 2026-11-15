// File-path and URL links in terminal output: the pieces of ThreadTerminalDrawer's link handling the app runs for the page
// (the page finds the links with terminal-links.ts and asks the app to check and open them). Path rules are
// packages/shared/src/fileLinks.ts (splitFilePathPosition, resolvePathLinkTarget) and hooks/useFileMetadata.ts.

const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/;

export interface FilePathPosition { path: string; line?: number; column?: number }

/** `src/a.ts:12:3` becomes the path with its line and column. */
export function splitFilePathPosition(path: string): FilePathPosition {
  const match = path.match(POSITION_SUFFIX);
  if (!match?.[1]) return { path };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return { path: path.slice(0, -match[0].length), ...(line > 0 ? { line } : {}), ...(column !== undefined && column > 0 ? { column } : {}) };
}

export function formatFilePathPosition(position: FilePathPosition): string {
  if (!position.line) return position.path;
  return `${position.path}:${position.line}${position.column ? `:${position.column}` : ""}`;
}

const isWindowsDrivePath = (value: string) => /^[a-zA-Z]:([/\\]|$)/.test(value);
const isUncPath = (value: string) => value.startsWith("\\\\");
const isWindowsAbsolutePath = (value: string) => isUncPath(value) || isWindowsDrivePath(value);
const isAbsolutePath = (value: string) => value.startsWith("/") || isWindowsAbsolutePath(value);
const isWindowsPathStyle = (value: string) => isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  return separator === "\\" ? `${cleanBase}\\${next.replaceAll("/", "\\")}` : `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  return cwd.match(/^\/Users\/([^/]+)/)?.[0] ?? cwd.match(/^\/home\/([^/]+)/)?.[0] ?? cwd.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i)?.[1];
}

/** A link's path anchored to the terminal's directory (`~/` against the home its cwd implies); the position suffix is kept. */
export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const position = splitFilePathPosition(rawPath);
  const { path } = position;
  let resolved = path;
  if (path.startsWith("~/") || (isWindowsPathStyle(cwd) && path.startsWith("~\\"))) {
    const home = inferHomeFromCwd(cwd);
    if (home) resolved = joinPath(home, path.slice(2), isWindowsPathStyle(home) ? "\\" : "/");
  } else if (!isAbsolutePath(path)) {
    resolved = joinPath(cwd, path, isWindowsPathStyle(cwd) ? "\\" : "/");
  }
  return formatFilePathPosition({ ...position, path: resolved });
}

export const isTerminalUrl = (value: string) => /^https?:\/\//iu.test(value);

/** normalizeProjectPathForDispatch: no trailing separators, except on a root. */
function trimTrailingSeparators(value: string): string {
  if (value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value)) return value;
  const trimmed = value.startsWith("/") ? value.replace(/\/+$/g, "") : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) return value;
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/**
 * The absolute host path a link's metadata is asked for (getFileMetadataQueryAtom), or null when the server must not be asked:
 * a network path would sign the user in to its host, and an overlong path is refused.
 */
export function linkMetadataPath(text: string, cwd: string): string | null {
  const hostPath = splitFilePathPosition(text).path;
  const target = hostPath.startsWith("~/") ? hostPath : splitFilePathPosition(resolvePathLinkTarget(hostPath, cwd)).path;
  const trimmed = trimTrailingSeparators(target.trim());
  const normalized = isWindowsDrivePath(trimmed) || isUncPath(trimmed) ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
  const absolute = isAbsolutePath(normalized) || normalized.startsWith("~/");
  if (!absolute || /^[\\/]{2}/.test(normalized) || normalized.length > 512) return null;
  return normalized;
}

/** A `filesystem.getMetadata` entry says the link is something the editor can open. */
export function isOpenableMetadata(entry: unknown): boolean {
  const kind = typeof entry === "object" && entry !== null ? (entry as { kind?: unknown }).kind : null;
  return kind === "file" || kind === "directory";
}

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

/** True when the server finds a file or directory at the link (filesystem.getMetadata); a failed lookup is not a link. */
export async function validatePathLink(text: string, cwd: string, rpc: Rpc): Promise<boolean> {
  const path = linkMetadataPath(text, cwd);
  if (path === null) return false;
  try {
    const result = await rpc("filesystem.getMetadata", { paths: [path] });
    const entries = typeof result === "object" && result !== null ? (result as { entries?: unknown }).entries : null;
    return Array.isArray(entries) && isOpenableMetadata(entries[0]);
  } catch {
    return false;
  }
}

/** Where a web link opens: the preview browser (browserLinkTarget "app", no Cmd/Ctrl held) or the system browser (resolveLinkTarget). */
export function terminalLinkTarget(preference: unknown, forceBrowser: boolean, canOpenInApp: boolean): "app" | "system" {
  return !forceBrowser && preference === "app" && canOpenInApp ? "app" : "system";
}
