// Pure link classification for chat markdown (MarkdownFileLink / MarkdownThreadLink / MarkdownExternalLink).
// A pressed href is one of: a thread link (t3-thread://v1|v2 or a hosted /threads/<env>/<thread> link),
// a file link (absolute path, file:// URL or workspace-relative path, with :line:col or #L12C3),
// an in-document anchor, or an external URL.

export type MarkdownLink =
  | { kind: "thread"; threadId: string; environmentId: string | null }
  | { kind: "file"; path: string; line?: number; column?: number; relativePath: string | null }
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string };

const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/;
const POSITION_HASH = /^#L(\d+)(?:C(\d+))?$/i;
const HOSTED_THREAD = /^https?:\/\/[^/]+\/threads\/([A-Za-z0-9_%-]+)\/([A-Za-z0-9_%-]+)$/;

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function splitFilePosition(path: string, hash = ""): { path: string; line?: number; column?: number } {
  const match = POSITION_SUFFIX.exec(path) ?? POSITION_HASH.exec(hash);
  if (!match?.[1]) return { path };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  const stripped = POSITION_SUFFIX.test(path) ? path.replace(POSITION_SUFFIX, "") : path;
  return {
    path: stripped,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

/** The path relative to `root` when it lies inside it; null otherwise (or when there is no root). */
export function relativeToRoot(path: string, root: string | null | undefined): string | null {
  if (!root) return null;
  const base = root.replace(/\/+$/, "");
  if (path === base) return "";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

export function parseThreadHref(href: string): { threadId: string; environmentId: string | null } | null {
  if (href.startsWith("t3-thread://v1/")) {
    const threadId = href.slice("t3-thread://v1/".length);
    return threadId ? { threadId, environmentId: null } : null;
  }
  if (href.startsWith("t3-thread://v2/")) {
    const rest = href.slice("t3-thread://v2/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) return null;
    return { environmentId: rest.slice(0, slash), threadId: rest.slice(slash + 1) };
  }
  const hosted = HOSTED_THREAD.exec(href);
  return hosted ? { environmentId: decode(hosted[1]), threadId: decode(hosted[2]) } : null;
}

/** Whether `href` looks like a local file reference rather than a web, mail or custom scheme link. */
function fileCandidate(href: string): { path: string; hash: string } | null {
  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      return { path: decode(url.pathname), hash: url.hash };
    } catch { return null; }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  if (href.startsWith("//") || href.startsWith("#")) return null;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  if (!path) return null;
  const looksLikePath = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path) || /[\\/]/.test(path) || /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(path);
  return looksLikePath ? { path: decode(path), hash: hashAt >= 0 ? href.slice(hashAt) : "" } : null;
}

export function classifyMarkdownLink(href: string, workspaceRoot?: string | null): MarkdownLink {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) return { kind: "anchor", id: trimmed.slice(1) };
  const thread = parseThreadHref(trimmed);
  if (thread) return { kind: "thread", ...thread };
  if (/^(?:https?|mailto|tel):/i.test(trimmed)) return { kind: "external", url: trimmed };
  const candidate = fileCandidate(trimmed);
  if (candidate) {
    const position = splitFilePosition(candidate.path, candidate.hash);
    const absolute = position.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(position.path);
    const relative = absolute ? relativeToRoot(position.path, workspaceRoot) : position.path.replace(/^\.\//, "");
    return { kind: "file", ...position, relativePath: relative };
  }
  return { kind: "external", url: trimmed };
}
