// Pure rules of the Add project flow, ported from packages/client-runtime (operations/projects.ts,
// state/projects.ts, state/filesystem.ts, sourceControlClients.ts) and CommandPalette.logic.ts.
// No signals and no RPC: the state module feeds in plain data.

import { scoreQueryMatch } from "../../composer/searchRanking";

// ---- Source control hosts (the built-in definitions the picker lists) ----

export interface SourceHost {
  kind: string;
  label: string;
  pickerLabel: string;
  repositoryPathHint: string;
  publicHost: string | null;
  defaultCloneTransport: "https" | "ssh";
  /** newRepositoryOwner(account): null means the host cannot take a new repository from here. */
  owner: "account" | "account-required" | "none";
  /** File stem of the host's mark under palette/icons. */
  icon: string;
}

/** builtInSourceControlDefinitions, in registry order (GitHub first). */
export const SOURCE_HOSTS: readonly SourceHost[] = [
  { kind: "github", label: "GitHub", pickerLabel: "GitHub", repositoryPathHint: "owner/repo", publicHost: "github.com", defaultCloneTransport: "https", owner: "account", icon: "source-github" },
  { kind: "cursor-origin", label: "Cursor Origin", pickerLabel: "Cursor Origin", repositoryPathHint: "owner/repo", publicHost: "origin.cursor.com", defaultCloneTransport: "https", owner: "account", icon: "source-cursor-origin" },
  { kind: "gitlab", label: "GitLab", pickerLabel: "GitLab", repositoryPathHint: "group/project", publicHost: "gitlab.com", defaultCloneTransport: "ssh", owner: "account", icon: "source-gitlab" },
  { kind: "gitcafe", label: "GitCafe", pickerLabel: "GitCafe", repositoryPathHint: "owner/repo", publicHost: "git.cafe", defaultCloneTransport: "ssh", owner: "account-required", icon: "source-gitcafe" },
  { kind: "forgejo", label: "Forgejo", pickerLabel: "Forgejo / Gitea", repositoryPathHint: "owner/repo", publicHost: "codeberg.org", defaultCloneTransport: "https", owner: "account-required", icon: "source-forgejo" },
  { kind: "bitbucket", label: "Bitbucket", pickerLabel: "Bitbucket", repositoryPathHint: "workspace/repository", publicHost: "bitbucket.org", defaultCloneTransport: "ssh", owner: "none", icon: "source-bitbucket" },
  { kind: "azure-devops", label: "Azure DevOps", pickerLabel: "Azure DevOps", repositoryPathHint: "project/repository", publicHost: null, defaultCloneTransport: "ssh", owner: "none", icon: "source-azure-devops" },
];

export function sourceHost(kind: string | null | undefined): SourceHost {
  return SOURCE_HOSTS.find((host) => host.kind === kind) ?? SOURCE_HOSTS[0]!;
}

export type RemoteSource = string;
export const URL_SOURCE = "url";

export function sourceLabel(source: RemoteSource): string {
  return source === URL_SOURCE ? "Git URL" : sourceHost(source).pickerLabel;
}

export function sourcePathHint(source: RemoteSource): string {
  return source === URL_SOURCE ? "URL" : sourceHost(source).repositoryPathHint;
}

/** The provider a source clones through, or null for a plain Git URL. */
export function sourceProvider(source: RemoteSource): string | null {
  return source === URL_SOURCE ? null : source;
}

// ---- Provider discovery -> readiness ("Setup Required") ----

export interface DiscoveredProvider {
  kind: string;
  label: string;
  status: string;
  installHint: string;
  auth: { status: string; account: string | null; detail: string | null } | null;
}

export interface SourceReadiness { ready: boolean; hint: string | null }
export type ReadinessOf = (source: RemoteSource) => SourceReadiness;

const READY: SourceReadiness = { ready: true, hint: null };
const UNAVAILABLE: SourceReadiness = { ready: false, hint: "Provider status unavailable. Open Source Control settings and rescan." };

/** buildAddProjectRemoteSourceReadiness plus the palette's wording of the settings hint. */
export function buildReadiness(providers: readonly DiscoveredProvider[] | null): ReadinessOf {
  const byKind = new Map((providers ?? []).map((provider) => [provider.kind, provider]));
  return (source) => {
    if (source === URL_SOURCE) return READY;
    const provider = byKind.get(source);
    if (!provider) return UNAVAILABLE;
    if (provider.status !== "available") return { ready: false, hint: provider.installHint };
    if (provider.auth?.status === "unauthenticated") {
      return { ready: false, hint: provider.auth.detail ?? `${provider.label} is not authenticated. Open Source Control settings for setup guidance.` };
    }
    return READY;
  };
}

/** buildPaletteRemoteSourceReadiness: the hint names the palette's own settings path. */
export function buildPaletteReadiness(providers: readonly DiscoveredProvider[] | null): ReadinessOf {
  const readiness = buildReadiness(providers);
  return (source) => {
    const entry = readiness(source);
    return entry.hint === null ? entry : { ...entry, hint: entry.hint.replace("Open source control settings", "Open Settings -> Source control") };
  };
}

/** Ready hosts first, then by picker label. */
export function sortProviderSources(readiness: ReadinessOf): string[] {
  return SOURCE_HOSTS.map((host) => host.kind).sort((left, right) => {
    const ready = Number(readiness(right).ready) - Number(readiness(left).ready);
    if (ready !== 0) return ready;
    return sourceLabel(left) < sourceLabel(right) ? -1 : sourceLabel(left) > sourceLabel(right) ? 1 : 0;
  });
}

export interface SourceRow {
  value: string;
  source: RemoteSource | "new" | "local";
  title: string;
  description: string;
  icon: string;
  searchTerms: string[];
  /** Not ready: the row cannot run and carries the Setup Required badge. */
  setupRequired?: { hint: string };
}

/** The Sources group of the Add project view: New project (only with a projects root), Local folder, Git URL, then hosts. */
export function buildSourceRows(input: { readiness: ReadinessOf; newProjectsRoot: string | null }): SourceRow[] {
  const rows: SourceRow[] = [];
  if (input.newProjectsRoot !== null) {
    rows.push({
      value: "add-project:new", source: "new", title: "New project", description: "Start a new Git repository from a name",
      icon: "folder-git-2", searchTerms: ["new project", "create", "empty", "repository", "git init"],
    });
  }
  rows.push({
    value: "add-project:local", source: "local", title: "Local folder", description: "Browse a folder on disk",
    icon: "folder-plus", searchTerms: ["local", "folder", "directory", "browse"],
  });
  for (const source of [URL_SOURCE, ...sortProviderSources(input.readiness)]) {
    const label = sourceLabel(source);
    const readiness = input.readiness(source);
    rows.push({
      value: readiness.ready ? `add-project:${source}` : `add-project:${source}:not-ready`,
      source,
      title: source === URL_SOURCE ? "Git URL" : `${label} repository`,
      description: source === URL_SOURCE ? "Clone from a remote URL" : `Clone ${label} ${sourcePathHint(source)}`,
      icon: source === URL_SOURCE ? "link" : sourceHost(source).icon,
      searchTerms: readiness.ready ? ["clone", "remote", "repository", "repo", "git", label] : ["clone", "remote", "repository", "repo", "git", label, "setup required"],
      ...(readiness.ready ? {} : { setupRequired: { hint: readiness.hint ?? "Open Settings -> Source control to configure this provider." } }),
    });
  }
  return rows;
}

// ---- Paths (state/projects.ts) ----

export const isWindowsPlatform = (platform: string): boolean => /^win(dows)?/i.test(platform);

const isWindowsDrivePath = (value: string): boolean => /^[a-zA-Z]:([/\\]|$)/.test(value);
const isUncPath = (value: string): boolean => value.startsWith("\\\\");
const isWindowsAbsolutePath = (value: string): boolean => isUncPath(value) || isWindowsDrivePath(value);

export function isExplicitRelativeProjectPath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

function absolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) return "windows";
  return value.startsWith("/") ? "unix" : null;
}

function preferredSeparator(value: string): "/" | "\\" {
  const kind = absolutePathKind(value);
  if (kind === "windows") return "\\";
  if (kind === "unix") return "/";
  return value.includes("\\") ? "\\" : "/";
}

export function hasTrailingPathSeparator(value: string): boolean {
  return (absolutePathKind(value) === "unix" ? /\/$/ : /[\\/]$/).test(value);
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value);
}

export function normalizeProjectPathForDispatch(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0 || isRootPath(trimmedValue)) return trimmedValue;
  const trimmed = trimmedValue.startsWith("/") ? trimmedValue.replace(/\/+$/g, "") : trimmedValue.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) return trimmedValue;
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  return isWindowsDrivePath(normalized) || isUncPath(normalized) ? normalized.replaceAll("/", "\\").toLowerCase() : normalized;
}

function splitSegments(value: string, separator: "/" | "\\"): string[] {
  return value.split(separator === "/" ? /\/+/ : /[\\/]+/).filter(Boolean);
}

function lastSeparatorIndex(value: string): number {
  return absolutePathKind(value) === "unix" ? value.lastIndexOf("/") : Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function splitAbsolutePath(value: string): { root: string; separator: "/" | "\\"; segments: string[] } | null {
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    return { root, separator: "\\", segments: splitSegments(value.slice(root.length), "\\") };
  }
  if (isUncPath(value)) {
    const [server, share, ...rest] = splitSegments(value, "\\");
    if (!server || !share) return null;
    return { root: `\\\\${server}\\${share}\\`, separator: "\\", segments: rest };
  }
  if (value.startsWith("/")) return { root: "/", separator: "/", segments: splitSegments(value.slice(1), "/") };
  return null;
}

export function isFilesystemBrowseQuery(value: string, platform = ""): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\") ||
    value.startsWith("/") || value.startsWith("~/") || (isWindowsPlatform(platform) && isWindowsAbsolutePath(value));
}

export function isUnsupportedWindowsProjectPath(value: string, platform: string): boolean {
  return isWindowsAbsolutePath(value) && !isWindowsPlatform(platform);
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativeProjectPath(trimmedValue) || !cwd) return normalizeProjectPathForDispatch(trimmedValue);
  const base = splitAbsolutePath(normalizeProjectPathForDispatch(cwd));
  if (!base) return normalizeProjectPathForDispatch(trimmedValue);
  const next = [...base.segments];
  for (const segment of trimmedValue.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") { next.pop(); continue; }
    next.push(segment);
  }
  const joined = next.join(base.separator);
  return normalizeProjectPathForDispatch(joined.length === 0 ? base.root : `${base.root}${joined}`);
}

export function findProjectByPath<T extends { path?: string }>(projects: readonly T[], candidatePath: string): T | undefined {
  const candidate = normalizeProjectPathForComparison(candidatePath);
  if (candidate.length === 0) return undefined;
  return projects.find((project) => (project.path ? normalizeProjectPathForComparison(project.path) === candidate : false));
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  const absolute = splitAbsolutePath(normalized);
  if (absolute) return absolute.segments.findLast(Boolean) ?? normalized;
  return normalized.split(/[/\\]/).findLast(Boolean) ?? normalized;
}

export function getBrowseLeafPathSegment(path: string): string {
  return path.slice(lastSeparatorIndex(path) + 1);
}

export function getBrowseDirectoryPath(path: string): string {
  if (hasTrailingPathSeparator(path)) return path;
  const index = lastSeparatorIndex(path);
  return index < 0 ? path : path.slice(0, index + 1);
}

export function appendBrowsePathSegment(path: string, segment: string): string {
  return `${getBrowseDirectoryPath(path)}${segment}${preferredSeparator(path)}`;
}

export function ensureBrowseDirectoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0 || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}${preferredSeparator(trimmed)}`;
}

export function getBrowseParentPath(path: string): string | null {
  const trimmed = normalizeProjectPathForDispatch(path);
  const absolute = splitAbsolutePath(trimmed);
  if (absolute) {
    if (absolute.segments.length === 0) return null;
    if (absolute.segments.length === 1) return absolute.root;
    return `${absolute.root}${absolute.segments.slice(0, -1).join(absolute.separator)}${absolute.separator}`;
  }
  const separator = preferredSeparator(path);
  const index = lastSeparatorIndex(trimmed);
  if (index < 0) return null;
  if (index === 2 && /^[a-zA-Z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}${separator}`;
  return trimmed.slice(0, index + 1);
}

export function canNavigateUp(path: string): boolean {
  return hasTrailingPathSeparator(path) && getBrowseParentPath(path) !== null;
}

export interface BrowseEntry { name: string; fullPath: string }

export function getFilesystemBrowsePath(query: string, platform = "", enabled = true) {
  const isBrowsing = enabled && isFilesystemBrowseQuery(query, platform);
  const directoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const filterQuery = isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;
  return { isBrowsing, directoryPath, filterQuery, parentPath, canBrowseUp: isBrowsing && canNavigateUp(directoryPath) };
}

export function filterBrowseEntries(entries: readonly BrowseEntry[], query: string) {
  const showHidden = query.startsWith(".");
  const candidates = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  if (query === "") return { visibleEntries: candidates, exactEntry: null };
  const normalized = query.normalize("NFC");
  const options = {
    exactBase: 0,
    prefixBase: 1000,
    boundaryBase: 2000,
    includesBase: 3000,
    fuzzyBase: 4000,
    boundaryMarkers: [" ", "-", "_", "."],
  };
  const visibleEntries = candidates.flatMap((entry) => {
    const raw = scoreQueryMatch({ ...options, value: entry.name.toLowerCase(), query: query.toLowerCase() });
    const canonical = scoreQueryMatch({ ...options, value: entry.name.normalize("NFC").toLowerCase(), query: normalized.toLowerCase() });
    const score = Math.min(raw ?? Infinity, canonical ?? Infinity);
    return Number.isFinite(score) ? [{ entry, score }] : [];
  }).sort((left, right) => left.score - right.score).map(({ entry }) => entry);
  const canonicalMatches = visibleEntries.filter((entry) => entry.name.normalize("NFC") === normalized);
  const exactEntry = visibleEntries.find((entry) => entry.name === query)
    ?? (canonicalMatches.length === 1 ? canonicalMatches[0] : null);
  return { visibleEntries, exactEntry };
}

export function filterPinnedBrowseEntries(input: { entries: readonly BrowseEntry[]; filterQuery: string; pinnedDirectoryName: string; caseSensitive: boolean }) {
  const same = (left: string, right: string) => (input.caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase());
  const visibleQuery = same(input.filterQuery, input.pinnedDirectoryName) ? "" : input.filterQuery;
  const { visibleEntries } = filterBrowseEntries(input.entries, visibleQuery);
  const exactEntry = input.filterQuery.length > 0 ? (input.entries.find((entry) => same(entry.name, input.filterQuery)) ?? null) : null;
  return { visibleEntries, exactEntry };
}

/** Shell-style Tab: a single match enters the directory, several extend to their common prefix. */
export function getBrowseTabCompletion(visible: readonly BrowseEntry[], filterQuery: string): { name: string; isComplete: boolean } | null {
  const [first, ...rest] = visible;
  if (first === undefined) return null;
  if (rest.length === 0) return { name: first.name, isComplete: true };
  let prefix = Array.from(first.name);
  for (const entry of rest) {
    const characters = Array.from(entry.name);
    let length = 0;
    while (length < prefix.length && prefix[length]?.toLowerCase() === characters[length]?.toLowerCase()) length += 1;
    prefix = prefix.slice(0, length);
  }
  const name = prefix.join("");
  return name.toLowerCase().length > filterQuery.toLowerCase().length && visible.every((entry) => entry.name.toLowerCase().startsWith(name.toLowerCase()))
    ? { name, isComplete: false }
    : null;
}

/** getEnvironmentBrowsePlatform: the server's os in the platform names the path rules know. */
export function browsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "MacIntel";
}

// ---- Clone (operations/projects.ts, shared/cloneUrl.ts) ----

const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/** The clone URL of `owner/name` on the public host of the default host (GitHub). */
export function defaultHostCloneUrl(repository: string): string | null {
  const host = sourceHost(undefined);
  if (host.publicHost === null) return null;
  const path = repository.endsWith(".git") ? repository : `${repository}.git`;
  return host.defaultCloneTransport === "https" ? `https://${host.publicHost}/${path}` : `git@${host.publicHost}:${path}`;
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  return REPOSITORY_SHORTHAND.test(trimmed) ? (defaultHostCloneUrl(trimmed) ?? trimmed) : trimmed;
}

const INCOMPLETE_OWNER_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/;

/** A GitHub field holding only `owner/` would come back from the host as a generic failure. */
export function githubIncompleteOwnerRepositoryMessage(source: RemoteSource, input: string): string | null {
  if (source !== "github") return null;
  return INCOMPLETE_OWNER_PATH.test(input.trim()) ? "Enter the full owner/repository name." : null;
}

export interface RepositoryInfo { provider: string; nameWithOwner: string; url: string; sshUrl: string }

export function getDefaultCloneUrl(repository: Pick<RepositoryInfo, "provider" | "url" | "sshUrl">): string {
  return sourceHost(repository.provider).defaultCloneTransport === "https" ? repository.url : repository.sshUrl;
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) return "";
  const last = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(last)) return "";
  return last.endsWith(".git") ? last.slice(0, -".git".length) : last;
}

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s[\]]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const UNSAFE_SEGMENT = /^\.{1,2}$|[\\:*?"<>|\p{Cc}]|[ .]$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.| *$)/i;

function parseCloneUrl(url: string): { host: string; path: string } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { host: ssh[1]!, path: ssh[3]! };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { host: https[1]!, path: https[3]! };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { host: scp[1]!, path: scp[2]! };
  return null;
}

/** The `<host>/<owner>/<repo>` folders ghq clones a URL into, or null for local paths and unsafe folders. */
export function cloneUrlRepositoryPath(url: string): string | null {
  if (isWindowsDrivePath(url.trim())) return null;
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  const segments = [parsed.host, ...parsed.path.split(/[?#]/)[0]!.split("/").filter(Boolean)];
  const last = segments.at(-1)!;
  if (last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -".git".length);
  if (segments.length < 2 || segments.some((s) => s === "" || UNSAFE_SEGMENT.test(s) || WINDOWS_DEVICE_NAME.test(s))) return null;
  return segments.join("/");
}

export function getCloneDirectoryPath(remoteUrl: string, ghqCloneLayout: boolean, repository = remoteUrl): string {
  return (ghqCloneLayout ? cloneUrlRepositoryPath(remoteUrl) : null) ?? getCloneDirectoryName(repository);
}

export function getCloneDirectoryLeafName(remoteUrl: string, ghqCloneLayout: boolean, repository = remoteUrl): string {
  return getCloneDirectoryPath(remoteUrl, ghqCloneLayout, repository).split("/").at(-1) ?? "";
}

export function getCloneDestinationPath(directoryPath: string, directoryName: string | null | undefined): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) return directoryPath;
  const base = ensureBrowseDirectoryPath(directoryPath);
  return `${base}${base.endsWith("\\") ? name.replaceAll("/", "\\") : name}`;
}

export function getCloneDestinationBrowsePath(input: { browseDirectoryPath: string; selectedDirectoryName: string; cloneDirectoryName: string; caseSensitive: boolean }): string {
  const selectedPath = appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName);
  const matches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase();
  return matches ? selectedPath : getCloneDestinationPath(selectedPath, input.cloneDirectoryName);
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  if (trimmed.length === 0) return "~/";
  const anchored = trimmed === "~" || trimmed.startsWith("~/") || absolutePathKind(trimmed) !== null || isExplicitRelativeProjectPath(trimmed);
  return ensureBrowseDirectoryPath(anchored ? trimmed : `~/${trimmed}`);
}

// ---- New project (shared/path.ts newProjectFolderName, operations/projects.ts) ----

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function newProjectFolderName(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

export function getNewProjectPathPreview(newProjectsRoot: string, name: string): string {
  return getCloneDestinationPath(newProjectsRoot, newProjectFolderName(name));
}

export interface PublishTarget { host: SourceHost; owner: string | null }

/** Ready hosts that can take a new repository, with the owner it would be created under. */
export function getNewProjectPublishTargets(providers: readonly DiscoveredProvider[] | null): PublishTarget[] {
  const readiness = buildReadiness(providers);
  return SOURCE_HOSTS.flatMap((host) => {
    if (!readiness(host.kind).ready) return [];
    const account = providers?.find((provider) => provider.kind === host.kind)?.auth?.account ?? null;
    if (host.owner === "none") return [];
    if (host.owner === "account-required" && !account) return [];
    return [{ host, owner: account }];
  });
}

export function getNewProjectPublishTarget(targets: readonly PublishTarget[], kind: string | null): PublishTarget | null {
  return targets.find((target) => target.host.kind === kind) ?? targets[0] ?? null;
}

export function getNewProjectRepository(target: Pick<PublishTarget, "owner">, workspaceRoot: string): string {
  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return target.owner ? `${target.owner}/${folderName}` : folderName;
}

// ---- Placeholders and empty-state copy ----

export function remoteInputPlaceholder(source: RemoteSource): string {
  return source === URL_SOURCE ? "Enter Git clone URL" : `Enter ${sourceLabel(source)} repository (${sourcePathHint(source)})`;
}

export function browsePlaceholder(): string {
  return "Enter path (e.g. ~/projects/my-app)";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "An error occurred.";
}
