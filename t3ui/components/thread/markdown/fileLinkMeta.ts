// What a markdown file link or an inline-code path names: ported from packages/shared (path.ts, fileLinks.ts,
// markdownLinks.ts) and apps/web markdown-links.ts, so the chip rules match the reference exactly. Pure.

// ---- path.ts ----

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}
export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}
/** Any two leading separators name a UNC or device path; agent-authored paths must not reach one. */
export function isNetworkPath(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}
export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}
/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}
export function fileBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function workspaceRelativeFilePath(path: string, workspaceRoot: string | null | undefined): string | null {
  if (!workspaceRoot) return null;
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot)) || (isNetworkPath(workspaceRoot) && isUncPath(path));
  const normalizedPath = caseInsensitive ? stripSlashPrefixedWindowsDrive(path.replaceAll("\\", "/")) : path;
  const normalizedRoot = (caseInsensitive ? stripSlashPrefixedWindowsDrive(workspaceRoot.replaceAll("\\", "/")) : workspaceRoot).replace(/\/+$/, "");
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (pathForCompare.replace(/\/+$/, "") === rootForCompare) return ".";
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  // `/repo/../x` starts with the root but escapes it; the server rejects that as a workspace path.
  let depth = 0;
  for (const segment of relativePath.split("/")) {
    if (segment === "..") depth -= 1;
    else if (segment.length > 0 && segment !== ".") depth += 1;
    if (depth < 0) return null;
  }
  return relativePath;
}

// ---- fileLinks.ts ----

const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/;
const POSITION_HASH_PATTERN = /^#L(\d+)(?:C(\d+))?$/i;

export interface FilePathPosition { path: string; line?: number; column?: number }

/** Keeps paths percent-encoded to avoid double decoding; non-localhost authorities become UNC shares. */
export function parseFileUrlHref(href: string): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;
    const uncHostname = parsed.hostname.toLowerCase() === "localhost" ? "" : parsed.hostname;
    const path = uncHostname ? `\\\\${uncHostname}${parsed.pathname.replaceAll("/", "\\")}` : parsed.pathname;
    if (path.length === 0) return null;
    return { path: stripSlashPrefixedWindowsDrive(path), hash: parsed.hash };
  } catch {
    return null;
  }
}

export function splitFilePathPosition(path: string, hash = ""): FilePathPosition {
  const suffixMatch = path.match(POSITION_SUFFIX_CAPTURE_PATTERN);
  const match = suffixMatch ?? hash.match(POSITION_HASH_PATTERN);
  if (!match?.[1]) return { path };
  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: suffixMatch ? path.slice(0, -suffixMatch[0].length) : path,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

export function formatFilePathPosition(position: FilePathPosition): string {
  if (!position.line) return position.path;
  return `${position.path}:${position.line}${position.column ? `:${position.column}` : ""}`;
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

export function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) return `/Users/${posixUser[1]}`;
  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) return `/home/${posixHome[1]}`;
  const windowsUser = cwd.match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i);
  return windowsUser?.[1];
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const position = splitFilePathPosition(rawPath);
  const { path } = position;
  let resolvedPath = path;
  if (path.startsWith("~/") || (isWindowsPathStyle(cwd) && path.startsWith("~\\"))) {
    const home = inferHomeFromCwd(cwd);
    if (home) resolvedPath = joinPath(home, path.slice(2), isWindowsPathStyle(home) ? "\\" : "/");
  } else if (!isAbsolutePath(path)) {
    resolvedPath = joinPath(cwd, path, isWindowsPathStyle(cwd) ? "\\" : "/");
  }
  return formatFilePathPosition({ ...position, path: resolvedPath });
}

function pathParentSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).slice(0, -1);
}

/** Files that share a basename get their parent folders in the label, as many as keep them apart (at least two). */
export function buildFileLinkParentSuffixByPath(filePaths: readonly string[]): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }
  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;
    const parentSegmentsByPath = new Map(uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)] as const));
    const minUniqueDepthByPath = new Map<string, number>();
    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => otherPath !== filePath && (parentSegmentsByPath.get(otherPath) ?? []).slice(-depth).join("/") === candidate);
        if (!collision) { resolvedDepth = depth; break; }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }
    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepthByPath.get(filePath) ?? 1, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }
  return suffixByPath;
}

/** `name · parent/folders · L12:C3`. */
export function fileLinkLabel(file: FilePathPosition, parentSuffixByPath: ReadonlyMap<string, string>): string {
  const suffix = parentSuffixByPath.get(file.path.replaceAll("\\", "/"));
  return [fileBasename(file.path), suffix, file.line ? `L${file.line}${file.column ? `:C${file.column}` : ""}` : undefined].filter(Boolean).join(" · ");
}

// ---- markdownLinks.ts ----

const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+){0,2})?$/u;
// No `@` here: `me@example.com` is an address, not a file.
const RELATIVE_FILE_NAME_PATTERN = /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2}$/u;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
// Agents shorten long paths with a `...` or `…` segment, which no file chip can open.
const ELIDED_PATH_SEGMENT_PATTERN = /(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;

const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/", "/home/", "/tmp/", "/var/", "/etc/", "/opt/", "/mnt/", "/Volumes/", "/private/", "/root/", "/usr/", "/bin/", "/sbin/",
  "/lib/", "/lib64/", "/srv/", "/dev/", "/proc/", "/sys/", "/run/", "/boot/", "/media/", "/workspace/", "/workspaces/",
] as const;

const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile", "Justfile", "justfile", "Rakefile", "Gemfile", "Procfile", "Brewfile",
  "Caddyfile", "Vagrantfile", "Jenkinsfile", "Podfile", "Fastfile", "BUILD", "WORKSPACE", "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS",
  "CONTRIBUTORS", "CHANGELOG", "README", "CODEOWNERS",
]);

const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
const GENERIC_HOSTNAME_TLDS = new Set(["com", "net", "org", "io", "dev", "app", "ai", "co", "edu", "gov", "mil", "info", "biz", "xyz", "me", "tv", "gg", "chat", "cloud", "site", "online", "tech", "store", "link"]);
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk", "de", "fr", "nl", "se", "no", "fi", "dk", "pl", "ch", "at", "be", "es", "it", "pt", "eu", "us", "ca", "au", "nz", "jp", "kr", "cn", "br", "ru",
  "mx", "ie", "cz", "tr", "sg", "hk",
  // C++ sources end in `.cc`, so `allocator.cc:217` names a file, not a host and port.
  "cc",
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/** The path an inline-code span names, or null when the span is code and not a file. */
export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;
  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;
  if (ELIDED_PATH_SEGMENT_PATTERN.test(candidate.replace(POSITION_SUFFIX_PATTERN, ""))) return null;
  const hasExplicitPathShape = RELATIVE_PATH_PREFIX_PATTERN.test(candidate) || candidate.startsWith("/") || isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    // Markdown destinations accept `patches/`. Inline code still needs a file-shaped final segment.
    if (withoutPosition.endsWith("/")) return null;
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename = withoutPosition.replace(/[/\\]+$/, "").split(/[\\/]/).at(-1) ?? "";
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basename)) return null;
  }
  return candidate;
}

export function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

export function splitMarkdownLinkSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  return { path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch, hash };
}

export function isRelativeFilePath(path: string): boolean {
  return RELATIVE_PATH_PREFIX_PATTERN.test(path) || (!path.startsWith("/") && !isWindowsAbsolutePath(path));
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return EXTENSIONLESS_FILE_NAMES.has(basename) || FILE_EXTENSION_PATTERN.test(basename);
}

function looksLikeFilePath(path: string, authoredPath: string): boolean {
  if (isWindowsAbsolutePath(path) || RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(authoredPath);
  if (EXTENSIONLESS_FILE_NAMES.has(path)) return true;
  return RELATIVE_FILE_PATH_PATTERN.test(authoredPath) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function hasExternalScheme(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return false;
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

/** The file a markdown destination names (with its line and column), or null when it is not a file reference. */
export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith("#") || normalized.startsWith("//")) return null;
  const source = (normalized.toLowerCase().startsWith("file:") ? parseFileUrlHref(normalized) : null) ?? splitMarkdownLinkSearchAndHash(normalized);
  const path = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;
  const position = splitFilePathPosition(path, hash);
  return looksLikeFilePath(position.path, path) ? position : null;
}

/** Whether a link's written text only repeats its file destination (`src/a.ts:12` for `/repo/src/a.ts:12`): the chip stands alone then. */
export function isMarkdownFileLinkLabel(label: string, href: string): boolean {
  const destination = parseMarkdownFileLink(href);
  if (!destination) return false;
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const labelPosition = splitFilePathPosition(label.trim());
  if ((labelPosition.line !== undefined && labelPosition.line !== destination.line) || (labelPosition.column !== undefined && labelPosition.column !== destination.column)) return false;
  let labelPath = normalize(labelPosition.path);
  let destinationPath = normalize(destination.path);
  if (labelPath.length === 0) return true;
  if (isWindowsAbsolutePath(destination.path)) {
    labelPath = labelPath.toLowerCase();
    destinationPath = destinationPath.toLowerCase();
  }
  return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
}

export function resolveMarkdownFileLinkTarget(href: string | undefined, cwd?: string | null, baseDir: string | null | undefined = cwd): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;
  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) {
    // Opening a network path makes Windows sign in to its host, so only the project's own share becomes a file link.
    return isNetworkPath(target.path) && workspaceRelativeFilePath(target.path, cwd) === null ? null : pathWithPosition;
  }
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

// ---- markdown-links.ts ----

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  /** The path as written when it is relative and the link's base is the workspace root: the search can find a file it names loosely. */
  workspaceLookupPath?: string | null;
  line?: number;
  column?: number;
}

export function resolveMarkdownFileLinkMeta(href: string | undefined, cwd?: string | null, baseDir: string | null | undefined = cwd): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    workspaceLookupPath: (() => {
      const source = href ? parseMarkdownFileLink(href) : null;
      return source !== null && !isAbsolutePath(source.path) && !!baseDir && workspaceRelativeFilePath(baseDir, cwd) === "." ? source.path : null;
    })(),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

export function resolveInlineCodeFileLinkMeta(codeText: string, cwd?: string | null, baseDir: string | null | undefined = cwd): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;
  const fromRoot = !!cwd && !!baseDir && isRelativeFilePath(candidate) && !/^(?:~|\.{1,2})\//.test(candidate) && splitFilePathPosition(candidate).path.includes("/") && workspaceRelativeFilePath(baseDir, cwd) !== null;
  return resolveMarkdownFileLinkMeta(candidate, cwd, fromRoot ? cwd : baseDir);
}

/** The Copy items of a file link's menu: relative path first when the file lies in the workspace. */
export function markdownFileCopyMenuItems(meta: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath">): { id: "copy-relative" | "copy-full"; label: string; value: string; title: string }[] {
  const items: { id: "copy-relative" | "copy-full"; label: string; value: string; title: string }[] = [
    { id: "copy-full", label: "Copy full path", value: meta.targetPath, title: "Full path" },
  ];
  if (meta.workspaceRelativePath !== null) {
    const position = meta.targetPath.slice(splitFilePathPosition(meta.targetPath).path.length);
    items.unshift({ id: "copy-relative", label: "Copy relative path", value: `${meta.workspaceRelativePath}${position}`, title: "Relative path" });
  }
  return items;
}

/** MarkdownFileLink.logic.ts: a PDF opens in the browser by default. */
export function opensInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}
